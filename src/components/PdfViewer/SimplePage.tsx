import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { PdfMetadata, TILE_SIZE } from '../../types/pdf';
import { batchTileLoader } from '../../utils/batchTileLoader';
import { useAdaptiveTilePlan } from './hooks/useAdaptiveTilePlan';
import { pageCompositor, type TileData } from '../../utils/pageCompositor';

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
  const [pageImage, setPageImage] = useState<ImageBitmap | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [renderStats, setRenderStats] = useState<any>(null);
  const lastTilesRef = useRef<string>('');

  const { width: pageWidth, height: pageHeight } = pageLayout;
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const scale = viewState.scale;

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

  // 稳定化 tilesToLoad 以避免无限循环
  const stableTilesToLoad = useMemo(() => {
    return tilesToLoad.map(t => `${t.tx}_${t.ty}`).join(',');
  }, [tilesToLoad]);

  // 使用 Worker OffscreenCanvas 合成页面
  const renderPageWithCompositor = useCallback(async () => {
    if (!isVisible || !shouldRender || isLoading) return;
    
    // 检查瓦片是否有变化
    if (stableTilesToLoad === lastTilesRef.current) return;
    lastTilesRef.current = stableTilesToLoad;

    setIsLoading(true);
    try {
      // 1. 获取需要的瓦片数据（仍使用 Tauri 调用）
      const requests: any[] = [];
      for (const { tx, ty } of tilesToLoad) {
        requests.push({
          pdfId: pdfMetadata.id,
          pageIndex,
          tx,
          ty,
          scale,
          dpr: devicePixelRatio,
          pageWidth,
          pageHeight,
          tileKey: `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`,
        });
      }

      if (requests.length === 0) return;

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
        pageWidth,
        pageHeight,
        tileSize: TILE_SIZE,
        tilesX,
        tilesY,
        dpr: devicePixelRatio,
        scale,
      });

      // 5. 更新页面图像
      setPageImage(compositionResult.imageBitmap);
      setRenderStats(compositionResult.performance);

    } catch (error) {
      console.error(`❌ 页面${pageIndex + 1} Worker合成失败:`, error);
    } finally {
      setIsLoading(false);
    }
  }, [isVisible, shouldRender, isLoading, stableTilesToLoad, pdfMetadata.id, pageIndex, scale, devicePixelRatio, pageWidth, pageHeight, tilesX, tilesY, tilesToLoad]);

  // 绘制合成后的页面图像到 Canvas
  const drawPageImage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageImage) return;

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

    // 单次绘制合成后的页面图像
    ctx.drawImage(pageImage, 0, 0, targetWidth, targetHeight);
  }, [pageImage, pageWidth, pageHeight, devicePixelRatio]);

  // 当页面可见且空闲时，使用 Worker 合成页面
  useEffect(() => {
    renderPageWithCompositor();
  }, [renderPageWithCompositor]);

  // 当缩放变化时清空旧页面图像
  useEffect(() => {
    if (pageImage) {
      try {
        if ((pageImage as any).close) (pageImage as any).close();
      } catch (e) {}
    }
    setPageImage(null);
    lastTilesRef.current = ''; // 重置瓦片状态
    // 清理 Worker 缓存中对应缩放的瓦片
    pageCompositor.clearCache();
  }, [scale]);

  // 当页面图像更新时重新绘制
  useEffect(() => {
    drawPageImage();
  }, [pageImage, drawPageImage]);

  // 清理资源
  useEffect(() => {
    return () => {
      if (pageImage) {
        try {
          if ((pageImage as any).close) (pageImage as any).close();
        } catch (e) {}
      }
    };
  }, [pageImage]);

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
        P{pageIndex + 1} | rows {tyRange[0]}-{tyRange[1]}
        {renderStats && (
          <div style={{ fontSize: '10px', marginTop: '2px' }}>
            🎯 {renderStats.cacheHits}h/{renderStats.cacheMisses}m ({renderStats.totalTime.toFixed(1)}ms)
          </div>
        )}
      </div>
    </div>
  );
}; 