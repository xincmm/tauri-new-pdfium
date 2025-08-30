import { useRef, useCallback, useState, useEffect } from "react";
import { PdfMetadata } from "@/PdfViewer/types/pdf";
import { batchTileLoader } from "@/PdfViewer/utils/batchTileLoader";
import { pageCompositor, type TileData } from "@/PdfViewer/utils/pageCompositor";
import { DPR_MAX, TILE_SIZE } from "@/PdfViewer/config";

interface PageRenderInfo {
  pageIndex: number;
  imageBitmap: ImageBitmap | null;
  isLoading: boolean;
  lastRendered: number;
}

interface UseCanvasRendererOptions {
  pdfMetadata: PdfMetadata | null;
  scale: number;
  containerHeight: number;
  scrollY: number;
  scrollX: number;
  maxPageWidth: number;
  getPageDrawPosition: (
    pageLayout: any,
    scrollX: number,
    scrollY: number,
  ) => {
    canvasX: number;
    canvasY: number;
    pageLeft: number;
    pageTop: number;
  };
}

export const useCanvasRenderer = (options: UseCanvasRendererOptions) => {
  const pageRenderMapRef = useRef<Map<number, PageRenderInfo>>(new Map());
  const [renderVersion, setRenderVersion] = useState(0);
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, DPR_MAX);

  // 计算瓦片计划的纯函数
  const calculateTilePlan = useCallback(
    (
      _scale: number,
      pageWidth: number,
      pageHeight: number,
      tileSize: number,
      _viewportTop: number,
      _viewportHeight: number,
      _pageTopAbs: number,
    ) => {
      const tilesX = Math.max(1, Math.ceil(pageWidth / tileSize));
      const tilesY = Math.max(1, Math.ceil(pageHeight / tileSize));

      // 简化版：对于单Canvas模式，暂时使用全页加载
      const tilesToLoad = [];
      for (let tx = 0; tx < tilesX; tx++) {
        for (let ty = 0; ty < tilesY; ty++) {
          tilesToLoad.push({ tx, ty });
        }
      }

      return { tilesToLoad, tilesX, tilesY };
    },
    [],
  );

  // 渲染单个页面到 ImageBitmap
  const renderPageToBitmap = useCallback(
    async (pageIndex: number, pageLayout: any) => {
      if (!options.pdfMetadata) return null;

      const { tilesToLoad, tilesX, tilesY } = calculateTilePlan(
        options.scale,
        pageLayout.width,
        pageLayout.height,
        TILE_SIZE,
        options.scrollY,
        options.containerHeight,
        pageLayout.y + 40,
      );

      if (tilesToLoad.length === 0) return null;

      try {
        // 1. 获取瓦片数据
        const requests: any[] = [];
        for (const { tx, ty } of tilesToLoad) {
          requests.push({
            pdfId: options.pdfMetadata.id,
            pageIndex,
            tx,
            ty,
            scale: options.scale,
            dpr: devicePixelRatio,
            pageWidth: pageLayout.width,
            pageHeight: pageLayout.height,
            tileKey: `${options.pdfMetadata.id}_${pageIndex}_${options.scale}_${tx}_${ty}_dpr${devicePixelRatio}`,
          });
        }

        // 2. 批量获取瓦片数据
        const batchResult = await batchTileLoader.renderTilesBatch(requests);

        // 3. 准备 Worker 合成数据
        const tiles: TileData[] = batchResult.tiles.map((tileData, index) => ({
          tileKey: requests[index].tileKey,
          data: tileData.data,
          tx: requests[index].tx,
          ty: requests[index].ty,
        }));

        // 4. 发送给 Worker 进行合成
        const compositionResult = await pageCompositor.composePage({
          tiles,
          pageWidth: pageLayout.width,
          pageHeight: pageLayout.height,
          tileSize: TILE_SIZE,
          tilesX,
          tilesY,
          dpr: devicePixelRatio,
          scale: options.scale,
        });

        return compositionResult.imageBitmap;
      } catch (error) {
        return null;
      }
    },
    [options.pdfMetadata, options.scale, devicePixelRatio, calculateTilePlan, options.scrollY, options.containerHeight],
  );

  // 更新页面渲染状态
  const updatePageRender = useCallback(
    async (pageIndex: number, pageLayout: any) => {
      const current = pageRenderMapRef.current.get(pageIndex);
      if (current?.isLoading) return; // 避免重复渲染

      pageRenderMapRef.current.set(pageIndex, {
        pageIndex,
        imageBitmap: null,
        isLoading: true,
        lastRendered: 0,
      });

      const bitmap = await renderPageToBitmap(pageIndex, pageLayout);

      // 释放旧的 bitmap
      if (current?.imageBitmap) {
        try {
          (current.imageBitmap as any).close?.();
        } catch (e) {}
      }

      pageRenderMapRef.current.set(pageIndex, {
        pageIndex,
        imageBitmap: bitmap,
        isLoading: false,
        lastRendered: Date.now(),
      });

      // 触发重绘
      setRenderVersion((prev) => prev + 1);
    },
    [renderPageToBitmap],
  );

  // 绘制所有可见页面到单个 Canvas
  const drawToCanvas = useCallback(
    (canvasRef: React.RefObject<HTMLCanvasElement | null>, visibleLayouts: any[], containerWidth: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !options.pdfMetadata) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = devicePixelRatio;

      // 设置 Canvas 尺寸 - 物理像素
      canvas.width = Math.max(1, Math.floor(containerWidth * dpr));
      canvas.height = Math.max(1, Math.floor(options.containerHeight * dpr));
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${options.containerHeight}px`;

      // 设置变换 - 使用DPR缩放
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false; // 禁用抗锯齿，保持清晰度
      ctx.imageSmoothingQuality = "high";

      // 清空画布（使用逻辑坐标）
      ctx.clearRect(0, 0, containerWidth, options.containerHeight);
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(0, 0, containerWidth, options.containerHeight);

      // 计算视口范围（逻辑像素）
      const viewportTop = options.scrollY;
      const viewportBottom = options.scrollY + options.containerHeight;

      // 绘制所有可见页面
      for (const layout of visibleLayouts) {
        const pageTop = layout.y + 40; // 加上padding
        const pageBottom = pageTop + layout.height;

        // 检查页面是否在垂直视口内
        if (pageBottom < viewportTop || pageTop > viewportBottom) continue;

        // 获取页面绘制位置
        const { canvasX, canvasY } = options.getPageDrawPosition(layout, options.scrollX, options.scrollY);

        const pageInfo = pageRenderMapRef.current.get(layout.pageIndex);

        if (pageInfo?.imageBitmap) {
          // 有内容：绘制实际页面
          try {
            const bitmap = pageInfo.imageBitmap;
            if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
              ctx.drawImage(bitmap, canvasX, canvasY, layout.width, layout.height);
            }
          } catch (error) {
            // 静默处理错误，绘制空白页
            pageRenderMapRef.current.delete(layout.pageIndex);
          }
        } else {
          // 无内容：绘制空白页占位
          if (pageInfo?.isLoading) {
            // 加载中：纯白背景
            ctx.fillStyle = "white";
            ctx.fillRect(canvasX, canvasY, layout.width, layout.height);
          } else {
            // 未开始加载：浅灰背景 + 页码
            ctx.fillStyle = "#fafafa";
            ctx.fillRect(canvasX, canvasY, layout.width, layout.height);

            // 绘制页码
            ctx.fillStyle = "#ccc";
            ctx.font = `${Math.max(12, 16 / dpr)}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            // ctx.fillText(
            //   `${layout.pageIndex + 1}`,
            //   canvasX + layout.width / 2,
            //   canvasY + layout.height / 2
            // );
          }
        }

        // 绘制页面边框
        ctx.strokeStyle = "#d0d0d0";
        ctx.lineWidth = 1 / dpr;
        ctx.strokeRect(canvasX, canvasY, layout.width, layout.height);
      }
    },
    [options, devicePixelRatio],
  );

  // 清理资源
  const clearCache = useCallback(() => {
    pageRenderMapRef.current.forEach((pageInfo) => {
      if (pageInfo.imageBitmap) {
        try {
          (pageInfo.imageBitmap as any).close?.();
        } catch (e) {}
      }
    });
    pageRenderMapRef.current.clear();
    pageCompositor.clearCache();
    setRenderVersion((prev) => prev + 1);
  }, []);

  // 缩放变化时清理所有页面
  useEffect(() => {
    clearCache();
  }, [options.scale, clearCache]);

  return {
    pageRenderMapRef,
    renderVersion,
    updatePageRender,
    drawToCanvas,
    clearCache,
  };
};
