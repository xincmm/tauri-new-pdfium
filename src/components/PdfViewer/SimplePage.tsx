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
  const [isDrawing, setIsDrawing] = useState(false);
  const lastDrawnTilesRef = useRef<Set<string>>(new Set());

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

  // 检查瓦片是否有变化
  const tilesChanged = useCallback(() => {
    const currentTileKeys = new Set(tiles.keys());
    const lastTileKeys = lastDrawnTilesRef.current;
    
    if (currentTileKeys.size !== lastTileKeys.size) return true;
    
    for (const key of currentTileKeys) {
      if (!lastTileKeys.has(key)) return true;
    }
    
    return false;
  }, [tiles]);

  // 使用 requestIdleCallback 进行分帧绘制，避免阻塞主线程
  const drawToCanvasWithIdleCallback = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tiles.size === 0 || isDrawing) return;

    // 如果瓦片没有变化，跳过绘制
    if (!tilesChanged()) {
      return;
    }

    const dpr = devicePixelRatio;
    const targetWidth = Math.floor(pageWidth);
    const targetHeight = Math.floor(pageHeight);

    // 设置 Canvas 尺寸（只在需要时）
    const needsResize = canvas.width !== Math.max(1, Math.floor(targetWidth * dpr)) ||
                       canvas.height !== Math.max(1, Math.floor(targetHeight * dpr));
    
    if (needsResize) {
      canvas.width = Math.max(1, Math.floor(targetWidth * dpr));
      canvas.height = Math.max(1, Math.floor(targetHeight * dpr));
      canvas.style.width = `${targetWidth}px`;
      canvas.style.height = `${targetHeight}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setIsDrawing(true);

    // 设置高分屏绘制参数
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 清空画布并填充白色背景
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    // 分帧绘制瓦片
    let currentTileIndex = 0;
    const tilesToDraw = Array.from(tiles.entries());
    const tilesPerFrame = Math.max(1, Math.floor(tilesX * tilesY / 4)); // 每帧绘制 1/4 的瓦片

    const drawNextBatch = () => {
      const startTime = performance.now();
      
      while (currentTileIndex < tilesToDraw.length) {
        const [tileKey, bitmap] = tilesToDraw[currentTileIndex];
        
        // 解析瓦片坐标
        const parts = tileKey.split('_');
        if (parts.length >= 5) {
          const tx = parseInt(parts[parts.length - 3]);
          const ty = parseInt(parts[parts.length - 2]);
          
          if (!isNaN(tx) && !isNaN(ty) && tx < tilesX && ty < tilesY) {
            const x = tx * TILE_SIZE;
            const y = ty * TILE_SIZE;
            ctx.drawImage(bitmap, x, y, TILE_SIZE, TILE_SIZE);
          }
        }
        
        currentTileIndex++;
        
        // 如果已绘制足够的瓦片或超时，让出控制权
        if (currentTileIndex % tilesPerFrame === 0 || performance.now() - startTime > 8) {
          break;
        }
      }

      if (currentTileIndex < tilesToDraw.length) {
        // 还有瓦片需要绘制，使用 requestIdleCallback 继续
        if (window.requestIdleCallback) {
          window.requestIdleCallback(drawNextBatch, { timeout: 16 });
        } else {
          // 回退到 requestAnimationFrame
          requestAnimationFrame(drawNextBatch);
        }
      } else {
        // 绘制完成
        lastDrawnTilesRef.current = new Set(tiles.keys());
        setIsDrawing(false);
        console.log(`✅ 页面${pageIndex + 1} 分帧绘制完成: ${tiles.size} 瓦片`);
      }
    };

    // 开始分帧绘制
    if (window.requestIdleCallback) {
      window.requestIdleCallback(drawNextBatch, { timeout: 16 });
    } else {
      requestAnimationFrame(drawNextBatch);
    }

  }, [tiles, pageWidth, pageHeight, devicePixelRatio, tilesX, tilesY, pageIndex, isDrawing, tilesChanged]);

  useEffect(() => {
    if (isVisible && shouldRender && !isLoading) {
      renderPlannedTiles();
    }
  }, [isVisible, shouldRender, isLoading, renderPlannedTiles, tilesToLoad]);

  useEffect(() => {
    setTiles(new Map());
    lastDrawnTilesRef.current = new Set(); // 清空已绘制记录
  }, [scale]);

  // 使用 requestAnimationFrame 来避免过度频繁的绘制
  useEffect(() => {
    if (tiles.size > 0 && !isDrawing && tilesChanged()) {
      const rafId = requestAnimationFrame(() => {
        drawToCanvasWithIdleCallback();
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [tiles, drawToCanvasWithIdleCallback, isDrawing, tilesChanged]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        background: isLoading || isDrawing ? '#f8f8f8' : 'white',
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
        P{pageIndex + 1} | {tiles.size}/{tilesX * tilesY} | rows {tyRange[0]}-{tyRange[1]} {isDrawing ? '🖌️' : ''}
      </div>
    </div>
  );
}; 