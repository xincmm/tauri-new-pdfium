import React, { useCallback, useRef, useEffect, useState } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE 
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { getVisiblePages, getExpandedVisiblePages } from '../../utils/pdfLayout';
import { 
  getTileUrl, 
  getPagePosterUrl, 
  generateTileKey, 
  generatePosterKey 
} from '../../utils/tileUtils';
import { PdfTextLayer } from './PdfTextLayer';

interface PdfContentProps {
  pdfMetadata: PdfMetadata;
  pageLayouts: PageLayout[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewState: ViewState;
  lastScrollY: number;
  isScrolling: boolean;
  devicePixelRatio: number;
  totalHeight: number;
  pdfState: ReturnType<typeof usePdfState>;
}

// 图像缓存接口
interface ImageCache {
  [key: string]: HTMLImageElement;
}

// 单页 Canvas 组件
interface PageCanvasProps {
  pageLayout: PageLayout;
  pdfMetadata: PdfMetadata;
  containerWidth: number;
  viewState: ViewState;
  lastScrollY: number;
  isScrolling: boolean;
  devicePixelRatio: number;
  imageCache: ImageCache;
  setImageCache: React.Dispatch<React.SetStateAction<ImageCache>>;
  pdfState: ReturnType<typeof usePdfState>;
  setNeedsRedraw: React.Dispatch<React.SetStateAction<boolean>>;
}

const PageCanvas: React.FC<PageCanvasProps> = ({
  pageLayout,
  pdfMetadata,
  containerWidth,
  viewState,
  lastScrollY,
  isScrolling,
  devicePixelRatio,
  imageCache,
  setImageCache,
  pdfState,
  setNeedsRedraw,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { 
    getPagePosterState, 
    updatePagePosterState, 
    getTileState, 
    updateTileState 
  } = pdfState;

  const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
  const pageX = Math.max(0, (containerWidth - pageWidth) / 2);

  // 加载图像并缓存
  const loadImage = useCallback((url: string, key: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      // 检查缓存
      if (imageCache[key]) {
        resolve(imageCache[key]);
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      img.onload = () => {
        setImageCache(prev => ({
          ...prev,
          [key]: img
        }));
        resolve(img);
      };
      
      img.onerror = reject;
      img.src = url;
    });
  }, [imageCache, setImageCache]);

  // 绘制单页内容
  const drawPage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置 canvas 尺寸
    const actualWidth = (pageWidth + 4) * devicePixelRatio; // +4 for border
    const actualHeight = (pageHeight + 4) * devicePixelRatio; // +4 for border

    if (canvas.width !== actualWidth || canvas.height !== actualHeight) {
      canvas.width = actualWidth;
      canvas.height = actualHeight;
      canvas.style.width = `${pageWidth + 4}px`;
      canvas.style.height = `${pageHeight + 4}px`;
    }

    // 清除画布
    ctx.clearRect(0, 0, actualWidth, actualHeight);

    // 1. 绘制页面背景和边框
    ctx.save();
    
    // 页面背景
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, actualWidth, actualHeight);
    
    // 页面边框
    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.strokeRect(
      devicePixelRatio,
      devicePixelRatio,
      pageWidth * devicePixelRatio,
      pageHeight * devicePixelRatio
    );
    
    // 阴影效果
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(
      3 * devicePixelRatio,
      (pageHeight + 3) * devicePixelRatio,
      pageWidth * devicePixelRatio,
      devicePixelRatio
    );
    ctx.fillRect(
      (pageWidth + 3) * devicePixelRatio,
      3 * devicePixelRatio,
      devicePixelRatio,
      pageHeight * devicePixelRatio
    );
    
    ctx.restore();

    // 2. 绘制海报图
    const posterKey = generatePosterKey(pdfMetadata.id, pageIndex);
    const posterState = getPagePosterState(posterKey);
    const posterUrl = getPagePosterUrl(pdfMetadata.id, pageIndex, devicePixelRatio);

    if (imageCache[posterKey]) {
      ctx.save();
      ctx.globalAlpha = posterState.loaded ? 1 : 0.3;
      
      ctx.drawImage(
        imageCache[posterKey],
        2 * devicePixelRatio,
        2 * devicePixelRatio,
        pageWidth * devicePixelRatio,
        pageHeight * devicePixelRatio
      );
      ctx.restore();
    } else if (!posterState.loading) {
      updatePagePosterState(posterKey, { loading: true });
      loadImage(posterUrl, posterKey)
        .then(() => {
          updatePagePosterState(posterKey, { loaded: true, loading: false });
          setNeedsRedraw(true);
        })
        .catch(() => {
          console.warn('Failed to load page poster:', pageIndex);
          updatePagePosterState(posterKey, { loading: false });
        });
    }

    // 3. 绘制高分辨率瓦片
    const startTileX = 0;
    const endTileX = Math.ceil(pageWidth / TILE_SIZE);
    const startTileY = 0;
    const endTileY = Math.ceil(pageHeight / TILE_SIZE);

    for (let tx = startTileX; tx < endTileX; tx++) {
      for (let ty = startTileY; ty < endTileY; ty++) {
        const tileInfo: TileInfo = {
          id: pdfMetadata.id,
          page: pageIndex,
          scale: Math.round(viewState.scale * 100) / 100,
          tx,
          ty,
        };

        const tileX = tx * TILE_SIZE;
        const tileY = ty * TILE_SIZE;
        const renderWidth = Math.min(TILE_SIZE, pageWidth - tx * TILE_SIZE);
        const renderHeight = Math.min(TILE_SIZE, pageHeight - ty * TILE_SIZE);

        const key = generateTileKey(tileInfo);
        const tileState = getTileState(key);
        const tileUrl = getTileUrl(tileInfo, devicePixelRatio, true);

        if (imageCache[key] && tileState.loaded) {
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          
          ctx.drawImage(
            imageCache[key],
            (tileX + 2) * devicePixelRatio,
            (tileY + 2) * devicePixelRatio,
            renderWidth * devicePixelRatio,
            renderHeight * devicePixelRatio
          );
          ctx.restore();
        } else if (!tileState.loading && !imageCache[key] && !isScrolling) {
          updateTileState(key, { loading: true });
          loadImage(tileUrl, key)
            .then(() => {
              updateTileState(key, { loaded: true, loading: false });
              setNeedsRedraw(true);
            })
            .catch(() => {
              console.warn('Failed to load high-res tile:', tileInfo);
              updateTileState(key, { loading: false });
            });
        }
      }
    }

    // 4. 绘制页码
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const pageNumX = (pageWidth - 56) * devicePixelRatio;
    const pageNumY = (pageHeight + 8) * devicePixelRatio;
    const pageNumWidth = 52 * devicePixelRatio;
    const pageNumHeight = 20 * devicePixelRatio;
    
    // 页码背景
    const radius = 4 * devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(pageNumX + radius, pageNumY);
    ctx.lineTo(pageNumX + pageNumWidth - radius, pageNumY);
    ctx.quadraticCurveTo(pageNumX + pageNumWidth, pageNumY, pageNumX + pageNumWidth, pageNumY + radius);
    ctx.lineTo(pageNumX + pageNumWidth, pageNumY + pageNumHeight - radius);
    ctx.quadraticCurveTo(pageNumX + pageNumWidth, pageNumY + pageNumHeight, pageNumX + pageNumWidth - radius, pageNumY + pageNumHeight);
    ctx.lineTo(pageNumX + radius, pageNumY + pageNumHeight);
    ctx.quadraticCurveTo(pageNumX, pageNumY + pageNumHeight, pageNumX, pageNumY + pageNumHeight - radius);
    ctx.lineTo(pageNumX, pageNumY + radius);
    ctx.quadraticCurveTo(pageNumX, pageNumY, pageNumX + radius, pageNumY);
    ctx.closePath();
    ctx.fill();
    
    // 页码文字
    ctx.fillStyle = 'white';
    ctx.font = `${12 * devicePixelRatio}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${pageIndex + 1}`,
      pageNumX + pageNumWidth / 2,
      pageNumY + pageNumHeight / 2
    );
    
    ctx.restore();
  }, [
    pageWidth,
    pageHeight,
    pageIndex,
    devicePixelRatio,
    pdfMetadata,
    viewState.scale,
    isScrolling,
    imageCache,
    getPagePosterState,
    updatePagePosterState,
    getTileState,
    updateTileState,
    loadImage
  ]);

  // 当需要重绘时执行
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      drawPage();
    });
    
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [drawPage]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left: `${pageX - 2}px`,
        top: `${pageY - 2}px`,
        pointerEvents: 'none',
      }}
    />
  );
};

export const PdfContent: React.FC<PdfContentProps> = ({
  pdfMetadata,
  pageLayouts,
  containerRef,
  viewState,
  lastScrollY,
  isScrolling,
  devicePixelRatio,
  totalHeight,
  pdfState,
}) => {
  // 图像缓存
  const [imageCache, setImageCache] = useState<ImageCache>({});
  const [needsRedraw, setNeedsRedraw] = useState(false);
  const [selectedText, setSelectedText] = useState<string>('');

  // 获取可见页面
  const visiblePages = React.useMemo(() => {
    if (!containerRef.current) return [];
    
    const containerHeight = containerRef.current.clientHeight;
    return getVisiblePages(pageLayouts, containerHeight, viewState.scrollY);
  }, [pageLayouts, viewState.scrollY, containerRef]);

  // 获取扩展的可见页面（用于预加载）
  const expandedVisiblePages = React.useMemo(() => {
    if (!containerRef.current) return [];
    
    const containerHeight = containerRef.current.clientHeight;
    return getExpandedVisiblePages(
      pageLayouts, 
      containerHeight, 
      viewState.scrollY, 
      lastScrollY, 
      2 // PRELOAD_PAGES_AHEAD
    );
  }, [pageLayouts, viewState.scrollY, lastScrollY, containerRef]);

  return (
    <div
      className="pdf-content"
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        width: '100%',
      }}
    >
      {/* Canvas 渲染层 */}
      {expandedVisiblePages.map(pageLayout => (
        <PageCanvas
          key={pageLayout.pageIndex}
          pageLayout={pageLayout}
          pdfMetadata={pdfMetadata}
          containerWidth={containerRef.current?.clientWidth || 0}
          viewState={viewState}
          lastScrollY={lastScrollY}
          isScrolling={isScrolling}
          devicePixelRatio={devicePixelRatio}
          imageCache={imageCache}
          setImageCache={setImageCache}
          pdfState={pdfState}
          setNeedsRedraw={setNeedsRedraw}
        />
      ))}
      
      {/* 文本选择层 */}
      {visiblePages.map(pageLayout => {
        const pageX = Math.max(0, ((containerRef.current?.clientWidth || 0) - pageLayout.width) / 2);
        const [pageWidthPt, pageHeightPt] = pdfMetadata.page_dims[pageLayout.pageIndex];
        
        return (
          <div
            key={`text-layer-${pageLayout.pageIndex}`}
            style={{
              position: 'absolute',
              left: `${pageX}px`,
              top: `${pageLayout.y}px`,
              width: `${pageLayout.width}px`,
              height: `${pageLayout.height}px`,
              pointerEvents: 'none',
            }}
          >
            <PdfTextLayer
              pdfId={pdfMetadata.id}
              pageIndex={pageLayout.pageIndex}
              pageWidth={pageLayout.width}
              pageHeight={pageLayout.height}
              scale={viewState.scale}
              pageWidthPt={pageWidthPt}
              pageHeightPt={pageHeightPt}
              onTextSelect={(text) => {
                console.log('选中文本:', text);
                setSelectedText(text);
              }}
            />
          </div>
                 );
       })}
       
      {/* 选中文本状态显示 */}
      {selectedText && (
        <div
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            maxWidth: '300px',
            wordBreak: 'break-word',
            zIndex: 1000,
            fontFamily: 'monospace',
          }}
          onClick={() => setSelectedText('')}
        >
          已复制: {selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText}
        </div>
      )}
    </div>
  );
}; 