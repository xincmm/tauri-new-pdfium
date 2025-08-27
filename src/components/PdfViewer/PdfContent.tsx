import React, { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE,
  PageTextLayout
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
  isScrolling,
  devicePixelRatio,
  imageCache,
  setImageCache,
  pdfState,
  setNeedsRedraw,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheCanvasRef = useRef<HTMLCanvasElement | null>(null); // 缓存canvas
  const lastRenderStateRef = useRef<{
    scale: number;
    devicePixelRatio: number;
    width: number;
    height: number;
  } | null>(null);
  
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

  // 创建或获取缓存canvas
  const getCacheCanvas = useCallback(() => {
    if (!cacheCanvasRef.current) {
      cacheCanvasRef.current = document.createElement('canvas');
    }
    return cacheCanvasRef.current;
  }, []);

  // 检查是否需要重新渲染（而不是使用缓存）
  const needsFullRender = useCallback(() => {
    const currentState = {
      scale: viewState.scale,
      devicePixelRatio,
      width: pageWidth,
      height: pageHeight,
    };

    if (!lastRenderStateRef.current) {
      lastRenderStateRef.current = currentState;
      return true;
    }

    const lastState = lastRenderStateRef.current;
    const stateChanged = (
      lastState.scale !== currentState.scale ||
      lastState.devicePixelRatio !== currentState.devicePixelRatio ||
      lastState.width !== currentState.width ||
      lastState.height !== currentState.height
    );

    if (stateChanged) {
      lastRenderStateRef.current = currentState;
      return true;
    }

    return false;
  }, [viewState.scale, devicePixelRatio, pageWidth, pageHeight]);

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

    // 如果在滚动且有缓存，直接使用缓存
    const cacheCanvas = getCacheCanvas();
    if (isScrolling && cacheCanvas.width > 0 && !needsFullRender()) {
      ctx.clearRect(0, 0, actualWidth, actualHeight);
      ctx.drawImage(cacheCanvas, 0, 0);
      return;
    }

    // 设置缓存canvas尺寸
    if (cacheCanvas.width !== actualWidth || cacheCanvas.height !== actualHeight) {
      cacheCanvas.width = actualWidth;
      cacheCanvas.height = actualHeight;
    }
    
    const cacheCtx = cacheCanvas.getContext('2d');
    if (!cacheCtx) return;

    // 清除画布
    ctx.clearRect(0, 0, actualWidth, actualHeight);
    cacheCtx.clearRect(0, 0, actualWidth, actualHeight);

    // 1. 绘制页面背景和边框
    cacheCtx.save();
    
    // 页面背景
    cacheCtx.fillStyle = 'white';
    cacheCtx.fillRect(0, 0, actualWidth, actualHeight);
    
    // 页面边框
    cacheCtx.strokeStyle = 'transparent';
    cacheCtx.lineWidth = 2 * devicePixelRatio;
    cacheCtx.strokeRect(
      devicePixelRatio,
      devicePixelRatio,
      pageWidth * devicePixelRatio,
      pageHeight * devicePixelRatio
    );
    
    // 阴影效果
    cacheCtx.fillStyle = '';
    cacheCtx.fillRect(
      3 * devicePixelRatio,
      (pageHeight + 3) * devicePixelRatio,
      pageWidth * devicePixelRatio,
      devicePixelRatio
    );
    cacheCtx.fillRect(
      (pageWidth + 3) * devicePixelRatio,
      3 * devicePixelRatio,
      devicePixelRatio,
      pageHeight * devicePixelRatio
    );
    
    cacheCtx.restore();

    // 2. 绘制海报图
    const posterKey = generatePosterKey(pdfMetadata.id, pageIndex);
    const posterState = getPagePosterState(posterKey);
    const posterUrl = getPagePosterUrl(pdfMetadata.id, pageIndex, devicePixelRatio);

    if (imageCache[posterKey]) {
      cacheCtx.save();
      cacheCtx.globalAlpha = posterState.loaded ? 1 : 0.3;
      
      cacheCtx.drawImage(
        imageCache[posterKey],
        2 * devicePixelRatio,
        2 * devicePixelRatio,
        pageWidth * devicePixelRatio,
        pageHeight * devicePixelRatio
      );
      cacheCtx.restore();
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
          cacheCtx.save();
          cacheCtx.imageSmoothingEnabled = false;
          
          cacheCtx.drawImage(
            imageCache[key],
            (tileX + 2) * devicePixelRatio,
            (tileY + 2) * devicePixelRatio,
            renderWidth * devicePixelRatio,
            renderHeight * devicePixelRatio
          );
          cacheCtx.restore();
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
    cacheCtx.save();
    cacheCtx.fillStyle = 'rgba(0,0,0,0.7)';
    const pageNumX = (pageWidth - 56) * devicePixelRatio;
    const pageNumY = (pageHeight + 8) * devicePixelRatio;
    const pageNumWidth = 52 * devicePixelRatio;
    const pageNumHeight = 20 * devicePixelRatio;
    
    // 页码背景
    const radius = 4 * devicePixelRatio;
    cacheCtx.beginPath();
    cacheCtx.moveTo(pageNumX + radius, pageNumY);
    cacheCtx.lineTo(pageNumX + pageNumWidth - radius, pageNumY);
    cacheCtx.quadraticCurveTo(pageNumX + pageNumWidth, pageNumY, pageNumX + pageNumWidth, pageNumY + radius);
    cacheCtx.lineTo(pageNumX + pageNumWidth, pageNumY + pageNumHeight - radius);
    cacheCtx.quadraticCurveTo(pageNumX + pageNumWidth, pageNumY + pageNumHeight, pageNumX + pageNumWidth - radius, pageNumY + pageNumHeight);
    cacheCtx.lineTo(pageNumX + radius, pageNumY + pageNumHeight);
    cacheCtx.quadraticCurveTo(pageNumX, pageNumY + pageNumHeight, pageNumX, pageNumY + pageNumHeight - radius);
    cacheCtx.lineTo(pageNumX, pageNumY + radius);
    cacheCtx.quadraticCurveTo(pageNumX, pageNumY, pageNumX + radius, pageNumY);
    cacheCtx.closePath();
    cacheCtx.fill();
    
    // 页码文字
    cacheCtx.fillStyle = 'white';
    cacheCtx.font = `${12 * devicePixelRatio}px Arial`;
    cacheCtx.textAlign = 'center';
    cacheCtx.textBaseline = 'middle';
    cacheCtx.fillText(
      `${pageIndex + 1}`,
      pageNumX + pageNumWidth / 2,
      pageNumY + pageNumHeight / 2
    );
    
    cacheCtx.restore();

    // 将缓存内容复制到主canvas
    ctx.drawImage(cacheCanvas, 0, 0);
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
    loadImage,
    getCacheCanvas,
    needsFullRender
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
  const [_, setNeedsRedraw] = useState(false);
  const [selectedText, setSelectedText] = useState<string>('');
  
  const { crossPageSelection, setCrossPageSelection } = pdfState;

  // 跨页选区处理函数
  const handleGlobalMouseDown = useCallback(() => {
    // 先不创建跨页选区，等到鼠标移动时再创建
    // 这样可以避免单纯点击时显示选区
  }, []);

  const handleGlobalMouseMove = useCallback((pageIndex: number, charIndex: number, startPageIndex?: number, startCharIndex?: number) => {
    if (crossPageSelection?.isSelecting) {
      setCrossPageSelection({
        ...crossPageSelection,
        endPage: pageIndex,
        endCharIndex: charIndex
      });
    } else if (startPageIndex !== undefined && startCharIndex !== undefined) {
      // 第一次移动，创建跨页选区
      setCrossPageSelection({
        startPage: startPageIndex,
        endPage: pageIndex,
        startCharIndex: startCharIndex,
        endCharIndex: charIndex,
        isSelecting: true
      });
    }
  }, [crossPageSelection, setCrossPageSelection]);

  const handleGlobalMouseUp = useCallback(async () => {
    if (!crossPageSelection?.isSelecting) return;

    // 提取跨页选中的文本
    try {
      const selectedText = await extractCrossPageText(
        pdfMetadata.id,
        crossPageSelection.startPage,
        crossPageSelection.endPage,
        crossPageSelection.startCharIndex,
        crossPageSelection.endCharIndex
      );

      if (selectedText.trim()) {
        try {
          await writeText(selectedText);
          console.log('跨页文本已复制到剪贴板:', selectedText);
          setSelectedText(selectedText);
        } catch (error) {
          console.error('复制到剪贴板失败:', error);
          setSelectedText(selectedText);
        }
      }
    } catch (error) {
      console.error('提取跨页文本失败:', error);
    }

    // 结束选择状态，但保持选区高亮
    setCrossPageSelection({
      ...crossPageSelection,
      isSelecting: false
    });
  }, [crossPageSelection, setCrossPageSelection, pdfMetadata.id]);

  // 提取跨页文本的辅助函数
  const extractCrossPageText = async (
    pdfId: string,
    startPage: number,
    endPage: number,
    startCharIndex: number,
    endCharIndex: number
  ): Promise<string> => {
    const textParts: string[] = [];

    for (let page = startPage; page <= endPage; page++) {
      try {
        const pageTextLayout = await invoke<PageTextLayout>('get_page_text_layout', {
          id: pdfId,
          page
        });

        let pageStart = 0;
        let pageEnd = pageTextLayout.chars.length - 1;

        if (page === startPage) {
          pageStart = Math.max(0, startCharIndex);
        }
        if (page === endPage) {
          pageEnd = Math.min(pageTextLayout.chars.length - 1, endCharIndex);
        }

        const pageText = pageTextLayout.chars
          .slice(pageStart, pageEnd + 1)
          .map(c => c.ch)
          .join('');

        if (pageText.trim()) {
          textParts.push(pageText);
        }
      } catch (error) {
        console.error(`获取页面 ${page} 文本布局失败:`, error);
      }
    }

    return textParts.join('\n');
  };

  // 全局鼠标事件监听 - 用于跨页选区
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!crossPageSelection?.isSelecting) return;

      // 找到鼠标当前所在的页面
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const textLayerCanvas = elements.find(el => el.classList.contains('pdf-text-layer')) as HTMLCanvasElement;
      
      if (textLayerCanvas) {
        // 从canvas的data属性或其他方式获取页面索引
        const pageContainer = textLayerCanvas.closest('[data-page-index]') as HTMLElement;
        if (pageContainer) {
          const pageIndex = parseInt(pageContainer.getAttribute('data-page-index') || '0');
          
          // 计算相对于canvas的坐标
          const rect = textLayerCanvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          
          // 触发该页面的字符命中测试
          const event = new CustomEvent('crossPageMouseMove', {
            detail: { pageIndex, x, y }
          });
          textLayerCanvas.dispatchEvent(event);
        }
      }
    };

    const handleDocumentMouseUp = () => {
      if (crossPageSelection?.isSelecting) {
        handleGlobalMouseUp();
      }
    };

    if (crossPageSelection?.isSelecting) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
    };
  }, [crossPageSelection, handleGlobalMouseUp]);

  // 键盘事件：Escape 清除跨页选区
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCrossPageSelection(null);
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setCrossPageSelection]);

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
            data-page-index={pageLayout.pageIndex}
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
              crossPageSelection={crossPageSelection}
              onCrossPageSelectionChange={setCrossPageSelection}
              onGlobalMouseDown={handleGlobalMouseDown}
              onGlobalMouseMove={handleGlobalMouseMove}
              onGlobalMouseUp={handleGlobalMouseUp}
            />
          </div>
                 );
       })}
       
      {/* 选中文本状态显示 */}
      {(selectedText || crossPageSelection) && (
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
          onClick={() => {
            setSelectedText('');
            setCrossPageSelection(null);
          }}
        >
          {crossPageSelection?.isSelecting
            ? `选择中... (页面 ${crossPageSelection.startPage + 1} - ${crossPageSelection.endPage + 1})`
            : selectedText
            ? `已复制: ${selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText}`
            : crossPageSelection
            ? `已选择跨页文本 (页面 ${crossPageSelection.startPage + 1} - ${crossPageSelection.endPage + 1})`
            : ''
          }
        </div>
      )}
    </div>
  );
}; 