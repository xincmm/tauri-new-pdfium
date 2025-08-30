import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
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
  // 新增：用于计算视口在本页内的可见范围
  pageTop: number; // 该页在滚动容器内容坐标系中的全局 top（SimpleViewer 中为 layout.y + 40）
  viewportTop: number; // 容器 scrollTop（内容坐标系）
  viewportBottom: number; // 容器 scrollTop + containerHeight（内容坐标系）
}

export const SimplePage: React.FC<SimplePageProps> = ({
  pdfMetadata,
  pageIndex,
  pageLayout,
  viewState,
  isVisible,
  shouldRender = true,
  pageTop,
  viewportTop,
  viewportBottom,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tiles, setTiles] = useState<Map<string, ImageBitmap>>(new Map());
  const [isLoadingPrimary, setIsLoadingPrimary] = useState(false);
  const [isLoadingPrefetch, setIsLoadingPrefetch] = useState(false);
  const inFlightKeysRef = useRef<Set<string>>(new Set());

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

  // 视口在本页内的可见范围（逻辑像素）
  const visibleYStart = Math.max(0, viewportTop - pageTop);
  const visibleYEnd = Math.min(pageHeight, viewportBottom - pageTop);

  // 行列索引（包含边界）
  const visibleStartRow = Math.max(0, Math.floor(visibleYStart / TILE_SIZE));
  const visibleEndRow = Math.max(0, Math.floor(Math.max(0, visibleYEnd - 1) / TILE_SIZE));

  // 由于容器不水平滚动，默认整页宽度可见
  const visibleStartCol = 0;
  const visibleEndCol = Math.max(0, tilesX - 1);

  // 缓冲与预加载参数
  const BUFFER_TILES = 2; // 视口四周的即时缓冲
  const PREFETCH_ROWS = 2; // 视口上下各两行

  // 主要渲染范围（带缓冲）
  const primaryRowStart = Math.max(0, visibleStartRow - BUFFER_TILES);
  const primaryRowEnd = Math.min(tilesY - 1, visibleEndRow + BUFFER_TILES);
  const primaryColStart = Math.max(0, visibleStartCol - BUFFER_TILES);
  const primaryColEnd = Math.min(tilesX - 1, visibleEndCol + BUFFER_TILES);

  // 预加载范围：在主要范围之外，再上下各两行
  const prefetchTopStart = Math.max(0, primaryRowStart - PREFETCH_ROWS);
  const prefetchTopEnd = Math.max(0, Math.min(tilesY - 1, primaryRowStart - 1));
  const prefetchBottomStart = Math.min(tilesY - 1, primaryRowEnd + 1);
  const prefetchBottomEnd = Math.min(tilesY - 1, primaryRowEnd + PREFETCH_ROWS);

  const buildTileKey = useCallback((tx: number, ty: number) => {
    return `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
  }, [pdfMetadata.id, pageIndex, scale, devicePixelRatio]);

  const computeRequestsForRange = useCallback((rowStart: number, rowEnd: number, colStart: number, colEnd: number) => {
    const requests: Array<{
      pdfId: string;
      pageIndex: number;
      tx: number;
      ty: number;
      scale: number;
      dpr: number;
      pageWidth: number;
      pageHeight: number;
      tileKey: string;
    }> = [];

    for (let ty = rowStart; ty <= rowEnd; ty++) {
      for (let tx = colStart; tx <= colEnd; tx++) {
        const tileKey = buildTileKey(tx, ty);
        if (!tiles.has(tileKey) && !inFlightKeysRef.current.has(tileKey)) {
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

    return requests;
  }, [buildTileKey, tiles, pdfMetadata.id, pageIndex, scale, devicePixelRatio, pageWidth, pageHeight]);

  const applyBatchResult = useCallback(async (requests: any[], result: { tiles: Array<{ data: ArrayBufferLike }> }) => {
    const newTiles = new Map<string, ImageBitmap>();

    for (let i = 0; i < result.tiles.length; i++) {
      const tileData = result.tiles[i];
      const request = requests[i];
      const blob = new Blob([new Uint8Array(tileData.data)], { type: 'image/webp' });
      const bitmap = await createImageBitmap(blob);
      newTiles.set(request.tileKey, bitmap);
    }

    // 合并到现有 tiles
    setTiles((prev) => {
      const merged = new Map(prev);
      for (const [k, v] of newTiles.entries()) {
        merged.set(k, v);
      }
      return merged;
    });

    // 移除 in-flight 标记
    for (const req of requests) {
      inFlightKeysRef.current.delete(req.tileKey);
    }
  }, []);

  const renderPrimaryTiles = useCallback(async () => {
    if (!isVisible || !shouldRender || isLoadingPrimary) return;

    const requests = computeRequestsForRange(primaryRowStart, primaryRowEnd, primaryColStart, primaryColEnd);
    if (requests.length === 0) return;

    setIsLoadingPrimary(true);
    requests.forEach((r) => inFlightKeysRef.current.add(r.tileKey));

    try {
      const result = await batchTileLoader.renderTilesBatch(requests);
      await applyBatchResult(requests, result);
    } catch (error) {
      console.error(`❌ 页面${pageIndex + 1} 主要瓦片渲染失败:`, error);
    } finally {
      setIsLoadingPrimary(false);
    }
  }, [isVisible, shouldRender, isLoadingPrimary, computeRequestsForRange, primaryRowStart, primaryRowEnd, primaryColStart, primaryColEnd, pageIndex, applyBatchResult]);

  const prefetchAdjacentRows = useCallback(async () => {
    if (!isVisible || !shouldRender || isLoadingPrefetch) return;

    const topRequests = prefetchTopStart <= prefetchTopEnd
      ? computeRequestsForRange(prefetchTopStart, prefetchTopEnd, primaryColStart, primaryColEnd)
      : [];

    const bottomRequests = prefetchBottomStart <= prefetchBottomEnd
      ? computeRequestsForRange(prefetchBottomStart, prefetchBottomEnd, primaryColStart, primaryColEnd)
      : [];

    const requests = [...topRequests, ...bottomRequests];
    if (requests.length === 0) return;

    setIsLoadingPrefetch(true);
    requests.forEach((r) => inFlightKeysRef.current.add(r.tileKey));

    try {
      const result = await batchTileLoader.renderTilesBatch(requests);
      await applyBatchResult(requests, result);
    } catch (error) {
      console.error(`❌ 页面${pageIndex + 1} 预加载瓦片失败:`, error);
    } finally {
      setIsLoadingPrefetch(false);
    }
  }, [isVisible, shouldRender, isLoadingPrefetch, computeRequestsForRange, prefetchTopStart, prefetchTopEnd, prefetchBottomStart, prefetchBottomEnd, primaryColStart, primaryColEnd, pageIndex, applyBatchResult]);

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

    // 绘制瓦片（按逻辑尺寸）
    for (let tx = 0; tx < tilesX; tx++) {
      for (let ty = 0; ty < tilesY; ty++) {
        const tileKey = buildTileKey(tx, ty);
        const bitmap = tiles.get(tileKey);
        if (bitmap) {
          const x = tx * TILE_SIZE;
          const y = ty * TILE_SIZE;
          const w = Math.min(TILE_SIZE, targetWidth - x);
          const h = Math.min(TILE_SIZE, targetHeight - y);
          if (w > 0 && h > 0) {
            ctx.drawImage(bitmap, x, y, Math.max(0, w), Math.max(0, h));
          }
        }
      }
    }
  }, [tiles, pageWidth, pageHeight, devicePixelRatio, tilesX, tilesY, buildTileKey]);

  // 当页面可见且空闲时，优先渲染主要范围；完成后预加载上下两行
  useEffect(() => {
    if (isVisible && shouldRender) {
      renderPrimaryTiles()
        .then(() => {
          // 在主要瓦片渲染完成后，开始预加载上下各两行
          return prefetchAdjacentRows();
        })
        .catch(() => void 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, shouldRender, primaryRowStart, primaryRowEnd, primaryColStart, primaryColEnd]);

  // 当缩放变化时清空旧瓦片与 in-flight 标记
  useEffect(() => {
    setTiles(new Map());
    inFlightKeysRef.current.clear();
  }, [scale]);

  // 当瓦片更新时重新绘制
  useEffect(() => {
    drawToCanvas();
  }, [tiles, drawToCanvas]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        background: isLoadingPrimary || isLoadingPrefetch ? '#f8f8f8' : 'white',
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
      
      {(isLoadingPrimary || isLoadingPrefetch) && (
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
          渲染中... {tilesX}x{tilesY} 瓦片
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
        P{pageIndex + 1} | {tiles.size}/{tilesX * tilesY}
      </div>
    </div>
  );
}; 