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
}

export const SimplePage: React.FC<SimplePageProps> = ({
  pdfMetadata,
  pageIndex,
  pageLayout,
  viewState,
  isVisible,
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

  // 计算瓦片网格
  const tilesX = Math.ceil(pageWidth / TILE_SIZE);
  const tilesY = Math.ceil(pageHeight / TILE_SIZE);

  console.log(`📄 页面${pageIndex + 1}:`);
  console.log(`  PDF原始尺寸: ${pdfPageWidthPts.toFixed(1)}x${pdfPageHeightPts.toFixed(1)} 点 (比例: ${originalRatio.toFixed(3)})`);
  console.log(`  屏幕显示尺寸: ${pageWidth.toFixed(1)}x${pageHeight.toFixed(1)} 像素 (比例: ${currentRatio.toFixed(3)})`);
  console.log(`  瓦片网格: ${tilesX}x${tilesY}, DPR: ${devicePixelRatio}, 缩放: ${scale}x`);

  // 渲染所有瓦片
  const renderAllTiles = useCallback(async () => {
    if (!isVisible || isLoading) return;
    
    console.log(`🚀 开始渲染页面${pageIndex + 1}的所有瓦片...`);
    setIsLoading(true);

    try {
      // 构建所有瓦片请求
      const requests = [];
      for (let tx = 0; tx < tilesX; tx++) {
        for (let ty = 0; ty < tilesY; ty++) {
          const tileKey = `${pdfMetadata.id}_${pageIndex}_${scale}_${tx}_${ty}_dpr${devicePixelRatio}`;
          requests.push({
            pdfId: pdfMetadata.id,
            pageIndex,
            tx,
            ty,
            scale,
            dpr: devicePixelRatio, // 使用设备像素比获得高分辨率瓦片
            pageWidth,
            pageHeight,
            tileKey,
          });
        }
      }

      console.log(`📦 页面${pageIndex + 1} 批量请求: ${requests.length} 个瓦片`);

      // 批量渲染
      const result = await batchTileLoader.renderTilesBatch(requests);
      
      // 转换为ImageBitmap
      const newTiles = new Map<string, ImageBitmap>();
      for (let i = 0; i < result.tiles.length; i++) {
        const tileData = result.tiles[i];
        const request = requests[i];
        
        // 将Uint8Array转换为Blob，再创建ImageBitmap
        const blob = new Blob([new Uint8Array(tileData.data)], { type: 'image/webp' });
        const bitmap = await createImageBitmap(blob);
        newTiles.set(request.tileKey, bitmap);
      }

      setTiles(newTiles);
      console.log(`✅ 页面${pageIndex + 1} 渲染完成: ${newTiles.size} 个瓦片`);
      
    } catch (error) {
      console.error(`❌ 页面${pageIndex + 1} 渲染失败:`, error);
    } finally {
      setIsLoading(false);
    }
  }, [pdfMetadata.id, pageIndex, scale, devicePixelRatio, tilesX, tilesY, pageWidth, pageHeight, isVisible, isLoading]);

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
    // 高分辨率瓦片直接绘制到标准尺寸画布，浏览器自动处理高分屏显示
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

    console.log(`🖼️ 页面${pageIndex + 1} 绘制完成: ${tiles.size}/${tilesX * tilesY} 瓦片`);
  }, [tiles, pageWidth, pageHeight, devicePixelRatio, tilesX, tilesY, pdfMetadata.id, pageIndex, scale]);

  // 当页面可见时开始渲染
  useEffect(() => {
    if (isVisible && tiles.size === 0 && !isLoading) {
      renderAllTiles();
    }
  }, [isVisible, tiles.size, isLoading, renderAllTiles]);

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