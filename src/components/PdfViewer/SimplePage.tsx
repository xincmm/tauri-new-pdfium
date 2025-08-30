import React, { useRef, useEffect, useCallback, useState } from 'react';
import { PdfMetadata, TILE_SIZE } from '../../types/pdf';
import { batchTileLoader } from '../../utils/batchTileLoader';
import { useAdaptiveTilePlan } from './hooks/useAdaptiveTilePlan';
import { getCachedTile, setCachedTile } from '../../utils/tileCache';

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
  viewportTop: number;
  viewportHeight: number;
  pageTopAbs: number;
  viewportVelocityPxPerMs: number;
  scrollDirection: -1 | 0 | 1;
}

export const SimplePage: React.FC<SimplePageProps> = ({
  pdfMetadata,
  pageIndex,
  pageLayout,
  viewState,
  isVisible,
  shouldRender = true,
  viewportTop,
  viewportHeight,
  pageTopAbs,
  viewportVelocityPxPerMs,
  scrollDirection,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tiles, setTiles] = useState<Map<string, ImageBitmap>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  const { width: pageWidth, height: pageHeight } = pageLayout;
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const scale = viewState.scale;

  // 获取PDF原始页面尺寸(以点为单位，72点=1英寸)
  const [pdfPageWidthPts, pdfPageHeightPts] = pdfMetadata.page_dims[pageIndex];
  const originalRatio = pdfPageWidthPts / pdfPageHeightPts;
  const currentRatio = pageWidth / pageHeight;

  // 自适应瓦片计划（按缩放、视口及滚动速度/方向进行半页/行级加载）
  const { tilesToLoad, tyRange, tilesX, tilesY } = useAdaptiveTilePlan({
    scale,
    pageWidth,
    pageHeight,
    tileSize: TILE_SIZE,
    viewportTop,
    viewportHeight,
    pageTopAbs,
    viewportVelocityPxPerMs,
    scrollDirection,
  });

  // 增量渲染当前计划所需的瓦片（含 LRU 缓存读写）
  const renderPlannedTiles = useCallback(async () => {
    if (!isVisible || !shouldRender || isLoading) return;

    const merged = new Map<string, ImageBitmap>(tiles);
    const requests: any[] = [];
    let addedFromCache = false;

    for (const { tx, ty } of tilesToLoad) {
      const tileKey = `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
      if (!merged.get(tileKey)) {
        const cached = getCachedTile(tileKey, scale);
        if (cached) {
          merged.set(tileKey, cached);
          addedFromCache = true;
        } else {
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

    if (addedFromCache) {
      setTiles(merged);
    }

    if (requests.length === 0) return;

    setIsLoading(true);
    try {
      const result = await batchTileLoader.renderTilesBatch(requests);

      for (let i = 0; i < result.tiles.length; i++) {
        const tileData = result.tiles[i];
        const request = requests[i];
        const blob = new Blob([new Uint8Array(tileData.data)], { type: 'image/webp' });
        const bitmap = await createImageBitmap(blob);
        merged.set(request.tileKey, bitmap);
        setCachedTile(request.tileKey, bitmap, scale);
      }

      setTiles(merged);
    } catch (error) {
      console.error(`❌ 页面${pageIndex + 1} 渲染失败:`, error);
    } finally {
      setIsLoading(false);
    }
  }, [isVisible, shouldRender, isLoading, tilesToLoad, tiles, pdfMetadata.id, pageIndex, scale, devicePixelRatio, pageWidth, pageHeight]);

  // 绘制到canvas
  const drawToCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tiles.size === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = devicePixelRatio;
    const targetWidth = Math.floor(pageWidth);
    const targetHeight = Math.floor(pageHeight);

    canvas.width = Math.max(1, Math.floor(targetWidth * dpr));
    canvas.height = Math.max(1, Math.floor(targetHeight * dpr));
    canvas.style.width = `${targetWidth}px`;
    canvas.style.height = `${targetHeight}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.clearRect(0, 0, targetWidth, targetHeight);
    
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

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
  }, [tiles, pageWidth, pageHeight, devicePixelRatio, tilesX, tilesY, pdfMetadata.id, pageIndex, scale]);

  useEffect(() => {
    if (isVisible && shouldRender && !isLoading) {
      renderPlannedTiles();
    }
  }, [isVisible, shouldRender, isLoading, renderPlannedTiles, tilesToLoad]);

  useEffect(() => {
    setTiles(new Map());
  }, [scale]);

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
        P{pageIndex + 1} | {tiles.size}/{tilesX * tilesY} | rows {tyRange[0]}-{tyRange[1]}
      </div>
    </div>
  );
}; 