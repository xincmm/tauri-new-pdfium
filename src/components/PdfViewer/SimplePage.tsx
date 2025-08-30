import React, { useRef, useEffect, useCallback, useState } from 'react';
import { PdfMetadata, TILE_SIZE } from '../../types/pdf';
import { batchTileLoader } from '../../utils/batchTileLoader';
import { useAdaptiveTilePlan } from './hooks/useAdaptiveTilePlan';

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

  // 自适应瓦片计划（按缩放与视口带宽进行半页/行级加载）
  const { tilesToLoad, tyRange, tilesX, tilesY } = useAdaptiveTilePlan({
    scale,
    pageWidth,
    pageHeight,
    tileSize: TILE_SIZE,
    viewportTop,
    viewportHeight,
    pageTopAbs,
  });

  // console.log(`📄 页面${pageIndex + 1}:`);
  // console.log(`  PDF原始尺寸: ${pdfPageWidthPts.toFixed(1)}x${pdfPageHeightPts.toFixed(1)} 点 (比例: ${originalRatio.toFixed(3)})`);
  // console.log(`  屏幕显示尺寸: ${pageWidth.toFixed(1)}x${pageHeight.toFixed(1)} 像素 (比例: ${currentRatio.toFixed(3)})`);
  // console.log(`  瓦片网格: ${tilesX}x${tilesY}, DPR: ${devicePixelRatio}, 缩放: ${scale}x`);

  // 增量渲染当前计划所需的瓦片
  const renderPlannedTiles = useCallback(async () => {
    if (!isVisible || !shouldRender || isLoading) return;

    // 计算本次需要请求、但未加载的瓦片
    const requests: any[] = [];
    for (const { tx, ty } of tilesToLoad) {
      const tileKey = `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
      if (!tiles.get(tileKey)) {
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

    if (requests.length === 0) return;

    setIsLoading(true);
    try {
      const result = await batchTileLoader.renderTilesBatch(requests);

      // 将新瓦片合并到现有缓存
      const merged = new Map<string, ImageBitmap>(tiles);
      for (let i = 0; i < result.tiles.length; i++) {
        const tileData = result.tiles[i];
        const request = requests[i];
        const blob = new Blob([new Uint8Array(tileData.data)], { type: 'image/webp' });
        const bitmap = await createImageBitmap(blob);
        merged.set(request.tileKey, bitmap);
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

    // 绘制所有瓦片（按逻辑尺寸）
    // 仅绘制已加载的瓦片，缺失瓦片保持空白
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

  // 当页面可见且空闲时，增量加载当前计划所需瓦片
  useEffect(() => {
    if (isVisible && shouldRender && !isLoading) {
      renderPlannedTiles();
    }
  }, [isVisible, shouldRender, isLoading, renderPlannedTiles, tilesToLoad]);

  // 当缩放变化时清空旧瓦片，等待空闲后再渲染
  useEffect(() => {
    setTiles(new Map());
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