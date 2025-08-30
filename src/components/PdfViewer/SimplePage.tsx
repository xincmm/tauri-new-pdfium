import React, { useRef, useEffect, useCallback, useState } from 'react';
import { PdfMetadata, TILE_SIZE } from '../../types/pdf';
import { batchTileLoader } from '../../utils/batchTileLoader';

interface SimplePageProps {
  pdfMetadata: PdfMetadata;
  pageIndex: number;
  pageLayout: {
    pageIndex: number;
    y: number;
    width: number;
    height: number;
  };
  viewState: {
    scale: number;
  };
  isVisible: boolean;
  shouldRender?: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  preload?: boolean; // 是否作为相邻页预加载
}

export const SimplePage: React.FC<SimplePageProps> = ({
  pdfMetadata,
  pageIndex,
  pageLayout,
  viewState,
  isVisible,
  shouldRender = true,
  containerRef,
  preload = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tiles, setTiles] = useState<Map<string, ImageBitmap>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  const { width: pageWidth, height: pageHeight } = pageLayout;
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const scale = viewState.scale;

  // 获取PDF原始页面尺寸(以点为单位，72点=1英寸)
  const [pdfPageWidthPts, pdfPageHeightPts] = pdfMetadata.page_dims[pageIndex];
  const originalRatio = pdfPageWidthPts / pdfPageHeightPts;
  const currentRatio = pageWidth / pageHeight;

  // 计算瓦片网格
  const tilesX = Math.ceil(pageWidth / TILE_SIZE);
  const tilesY = Math.ceil(pageHeight / TILE_SIZE);

  // 计算当前视口对应的可见瓦片范围（带缓冲）
  const computeVisibleTileRange = useCallback(() => {
    const BUFFER_TILES = 2;

    const pageEl = wrapperRef.current;
    const containerEl = containerRef.current;
    if (!pageEl || !containerEl) {
      console.log(`[#${pageIndex}] computeVisibleTileRange: refs not ready, fallback full page`, { tilesX, tilesY });
      return {
        tx0: 0,
        ty0: 0,
        tx1: tilesX - 1,
        ty1: tilesY - 1,
        isEmpty: tilesX === 0 || tilesY === 0,
      };
    }

    const pageRect = pageEl.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();

    const visibleLeftPx = Math.max(0, containerRect.left - pageRect.left);
    const visibleTopPx = Math.max(0, containerRect.top - pageRect.top);
    const visibleRightPx = Math.min(pageWidth, containerRect.right - pageRect.left);
    const visibleBottomPx = Math.min(pageHeight, containerRect.bottom - pageRect.top);

    // 若无交集
    if (visibleRightPx <= visibleLeftPx || visibleBottomPx <= visibleTopPx) {
      console.log(`[#${pageIndex}] computeVisibleTileRange: no intersection`, {
        pageRect,
        containerRect,
        visibleLeftPx,
        visibleTopPx,
        visibleRightPx,
        visibleBottomPx,
      });
      return {
        tx0: 0,
        ty0: 0,
        tx1: -1,
        ty1: -1,
        isEmpty: true,
      };
    }

    const rawTx0 = Math.floor(visibleLeftPx / TILE_SIZE) - BUFFER_TILES;
    const rawTy0 = Math.floor(visibleTopPx / TILE_SIZE) - BUFFER_TILES;
    const rawTx1 = Math.floor((visibleRightPx - 1) / TILE_SIZE) + BUFFER_TILES;
    const rawTy1 = Math.floor((visibleBottomPx - 1) / TILE_SIZE) + BUFFER_TILES;

    const tx0 = Math.max(0, rawTx0);
    const ty0 = Math.max(0, rawTy0);
    const tx1 = Math.min(tilesX - 1, rawTx1);
    const ty1 = Math.min(tilesY - 1, rawTy1);

    console.log(`[#${pageIndex}] computeVisibleTileRange:`, {
      pageRect,
      containerRect,
      pageWidth,
      pageHeight,
      tilesX,
      tilesY,
      visiblePx: { left: visibleLeftPx, top: visibleTopPx, right: visibleRightPx, bottom: visibleBottomPx },
      rawRange: { rawTx0, rawTy0, rawTx1, rawTy1 },
      clampedRange: { tx0, ty0, tx1, ty1 },
    });

    return { tx0, ty0, tx1, ty1, isEmpty: tx1 < tx0 || ty1 < ty0 };
  }, [containerRef, pageWidth, pageHeight, tilesX, tilesY, pageIndex]);

  // 预加载页的范围（整页 + 缓冲边），不依赖容器可见区域
  const getPreloadTileRange = useCallback(() => {
    const BUFFER_TILES = 2;
    const tx0 = 0;
    const ty0 = 0;
    const tx1 = Math.max(0, tilesX - 1);
    const ty1 = Math.max(0, tilesY - 1);
    // 在整页基础上增加2个缓冲边实际上等价于整页（已被clamp）
    return { tx0, ty0, tx1, ty1, isEmpty: tilesX === 0 || tilesY === 0 };
  }, [tilesX, tilesY]);

  // 渲染所需范围内缺失的瓦片
  const renderNeededTiles = useCallback(async () => {
    if (!shouldRender || isLoading) return;

    const range = isVisible ? computeVisibleTileRange() : (preload ? getPreloadTileRange() : { tx0: 0, ty0: 0, tx1: -1, ty1: -1, isEmpty: true });
    if (range.isEmpty) return;

    // 生成需要的tileKey集合
    const neededKeys: string[] = [];
    for (let tx = range.tx0; tx <= range.tx1; tx++) {
      for (let ty = range.ty0; ty <= range.ty1; ty++) {
        const tileKey = `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
        if (!tiles.has(tileKey)) {
          neededKeys.push(tileKey);
        }
      }
    }

    if (neededKeys.length === 0) {
      console.log(`[#${pageIndex}] no missing tiles in range`, { range, preload, isVisible });
      return;
    }

    console.log(`[#${pageIndex}] ${preload ? 'preload' : 'visible'} request missing tiles: ${neededKeys.length} / totalRange=${(range.tx1 - range.tx0 + 1) * (range.ty1 - range.ty0 + 1)}`);

    setIsLoading(true);
    try {
      // 构建缺失瓦片的请求
      const requests = [] as Array<{
        pdfId: string;
        pageIndex: number;
        tx: number;
        ty: number;
        scale: number;
        dpr: number;
        pageWidth: number;
        pageHeight: number;
        tileKey: string;
      }>;

      for (let tx = range.tx0; tx <= range.tx1; tx++) {
        for (let ty = range.ty0; ty <= range.ty1; ty++) {
          const tileKey = `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
          if (!tiles.has(tileKey)) {
            requests.push({
              pdfId: pdfMetadata.id,
              pageIndex,
              tx,
              ty,
              scale,
              dpr: devicePixelRatio,
              pageWidth,
              pageHeight,
              tileKey,
            });
          }
        }
      }

      if (requests.length === 0) return;

      console.log(`[#${pageIndex}] batchTiles -> ${requests.length} requests (${preload ? 'preload' : 'visible'})`);
      const result = await batchTileLoader.renderTilesBatch(requests);

      // 转换为ImageBitmap并合并到现有Map
      const bitmaps: Array<{ key: string; bitmap: ImageBitmap }> = [];
      for (let i = 0; i < result.tiles.length; i++) {
        const tileData = result.tiles[i];
        const blob = new Blob([new Uint8Array(tileData.data)], { type: 'image/webp' });
        const bitmap = await createImageBitmap(blob);
        bitmaps.push({ key: requests[i].tileKey, bitmap });
      }

      setTiles(prev => {
        const merged = new Map(prev);
        for (const { key, bitmap } of bitmaps) {
          merged.set(key, bitmap);
        }
        return merged;
      });

      console.log(`[#${pageIndex}] received tiles: ${bitmaps.length}, total loaded now=${tiles.size + bitmaps.length}`);
    } catch (error) {
      console.error(`❌ 页面${pageIndex + 1} 渲染缺失瓦片失败:`, error);
    } finally {
      setIsLoading(false);
    }
  }, [computeVisibleTileRange, getPreloadTileRange, isVisible, preload, shouldRender, isLoading, tiles, pdfMetadata.id, pageIndex, scale, devicePixelRatio, pageWidth, pageHeight]);

  // 绘制到canvas
  const drawToCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tiles.size === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 高分屏：将 backing store 放大到 dpr，同时保持 CSS 尺寸为逻辑像素
    const dpr = devicePixelRatio;
    const targetWidth = Math.floor(pageWidth);
    const targetHeight = Math.floor(pageHeight);

    canvas.width = Math.max(1, Math.floor(targetWidth * dpr));
    canvas.height = Math.max(1, Math.floor(targetHeight * dpr));
    canvas.style.width = `${targetWidth}px`;
    canvas.style.height = `${targetHeight}px`;

    // 以逻辑坐标绘制
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 清除画布（逻辑尺寸）
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    
    // 白色背景
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    // 绘制所有已加载的瓦片（按逻辑尺寸）
    for (let tx = 0; tx < tilesX; tx++) {
      for (let ty = 0; ty < tilesY; ty++) {
        const tileKey = `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
        const bitmap = tiles.get(tileKey);
        if (bitmap) {
          const x = tx * TILE_SIZE;
          const y = ty * TILE_SIZE;
          ctx.drawImage(bitmap, x, y, TILE_SIZE, TILE_SIZE);
        }
      }
    }

    console.log(`[#${pageIndex}] drawToCanvas: drawnLoadedTiles=${tiles.size}`);
  }, [tiles, pageWidth, pageHeight, devicePixelRatio, tilesX, tilesY, pdfMetadata.id, pageIndex, scale]);

  // 当页面可见或滚动空闲时检查并渲染缺失瓦片（可见页与预加载页都会在空闲时进行）
  useEffect(() => {
    if (shouldRender && !isLoading) {
      if (isVisible || preload) {
        renderNeededTiles();
      }
    }
  }, [isVisible, preload, shouldRender, renderNeededTiles, isLoading]);

  // 缩放变化时清空旧瓦片
  useEffect(() => {
    setTiles(new Map());
  }, [scale]);

  // 瓦片更新时重绘
  useEffect(() => {
    drawToCanvas();
  }, [tiles, drawToCanvas]);

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        background: isLoading ? '#f8f8f8' : 'white',
        border: '1px solid #d0d0d0',
        borderRadius: '2px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
        }}
      />
      
      {isLoading && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0,0,0,0.7)',
            color: 'white',
            padding: '8px 16px',
            borderRadius: '4px',
            fontSize: '14px',
          }}
        >
          渲染中...
        </div>
      )}

      {/* 调试信息 */}
      <div
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          padding: '4px 8px',
          borderRadius: '3px',
          fontSize: '12px',
        }}
      >
        P{pageIndex + 1} | {tiles.size}/{tilesX * tilesY}{preload ? ' (preload)' : ''}
      </div>
    </div>
  );
}; 