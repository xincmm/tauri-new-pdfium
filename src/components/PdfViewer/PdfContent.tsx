import React, { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE,
  PageTextLayout,
  POSTER_SCALE_FACTOR
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { getVisiblePages, getExpandedVisiblePages } from '../../utils/pdfLayout';
import { 
  getTileUrl, 
  generateTileKey, 
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

// 瓦片加载并发控制
const MAX_CONCURRENCY = 8;
const loadQueue: Array<() => Promise<void>> = [];
let runningTasks = 0;

function scheduleLoad(task: () => Promise<void>) {
  loadQueue.push(task);
  pumpQueue();
}

function pumpQueue() {
  while (runningTasks < MAX_CONCURRENCY && loadQueue.length > 0) {
    const task = loadQueue.shift()!;
    runningTasks++;
    task().finally(() => {
      runningTasks--;
      pumpQueue();
    });
  }
}

// 瓦片几何信息缓存接口
interface TileGeometry {
  tx: number;
  ty: number;
  tileX: number;
  tileY: number;
  renderWidth: number;
  renderHeight: number;
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
  bitmapCacheRef: React.MutableRefObject<Map<string, ImageBitmap>>;
  inflightRef: React.MutableRefObject<Set<string>>;
  pdfState: ReturnType<typeof usePdfState>;
}

const PageCanvas: React.FC<PageCanvasProps> = ({
  pageLayout,
  pdfMetadata,
  containerWidth,
  viewState,
  isScrolling,
  devicePixelRatio,
  bitmapCacheRef,
  inflightRef,
  pdfState,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticBackgroundRef = useRef<HTMLCanvasElement | null>(null);
  const lastRenderStateRef = useRef<{
    scale: number;
    devicePixelRatio: number;
    width: number;
    height: number;
  } | null>(null);
  
  // 瓦片几何信息缓存
  const tileGeometryRef = useRef<TileGeometry[]>([]);
  const lastTileScaleRef = useRef<number>(-1);
  
  // 重绘标志
  const redrawFlag = useRef(false);

  // 缩放变化时重置渲染状态
  useEffect(() => {
    lastRenderStateRef.current = null;
    lastTileScaleRef.current = -1;
  }, [viewState.scale]);
  
  const { 
    getTileState, 
    updateTileState 
  } = pdfState;

  const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
  const pageX = containerWidth > pageWidth 
    ? Math.max(20, (containerWidth - pageWidth) / 2)
    : 20;

  // 请求重绘（只影响当前页面）
  const requestRedraw = useCallback(() => {
    if (redrawFlag.current) return;
    redrawFlag.current = true;
    requestAnimationFrame(() => {
      redrawFlag.current = false;
      drawPage();
    });
  }, []);

  // 加载 ImageBitmap
  const loadBitmap = useCallback(async (url: string, key: string): Promise<ImageBitmap | null> => {
    if (bitmapCacheRef.current.has(key)) {
      return bitmapCacheRef.current.get(key)!;
    }
    
    if (inflightRef.current.has(key)) {
      return null; // 已在加载中
    }
    
    inflightRef.current.add(key);
    
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      
      bitmapCacheRef.current.set(key, bitmap);
      requestRedraw(); // 触发重绘
      return bitmap;
    } catch (error) {
      console.warn('Failed to load bitmap:', key, error);
      return null;
    } finally {
      inflightRef.current.delete(key);
    }
  }, [bitmapCacheRef, inflightRef, requestRedraw]);

  // 创建或获取缓存canvas
  const getCacheCanvas = useCallback(() => {
    if (!cacheCanvasRef.current) {
      cacheCanvasRef.current = document.createElement('canvas');
    }
    return cacheCanvasRef.current;
  }, []);

  // 创建或获取静态背景canvas
  const getStaticBackgroundCanvas = useCallback(() => {
    if (!staticBackgroundRef.current) {
      staticBackgroundRef.current = document.createElement('canvas');
    }
    return staticBackgroundRef.current;
  }, []);

  // 预计算瓦片几何信息
  const computeTileGeometry = useCallback(() => {
    if (lastTileScaleRef.current === viewState.scale && tileGeometryRef.current.length > 0) {
      return tileGeometryRef.current;
    }

    const [pageWidthPt, pageHeightPt] = pdfMetadata.page_dims[pageIndex];
    const baseDpi = 150.0;
    const scale = viewState.scale;
    const effectiveDpi = baseDpi * scale;
    
    const wPx = Math.ceil((pageWidthPt / 72.0) * effectiveDpi);
    const hPx = Math.ceil((pageHeightPt / 72.0) * effectiveDpi);
    
    const dpiScale = effectiveDpi / baseDpi;
    const backendTileSize = Math.round(TILE_SIZE * dpiScale);
    
    const endTileX = Math.ceil(wPx / backendTileSize);
    const endTileY = Math.ceil(hPx / backendTileSize);

    const geometry: TileGeometry[] = [];
    
    for (let tx = 0; tx < endTileX; tx++) {
      for (let ty = 0; ty < endTileY; ty++) {
        const tileX = (tx * backendTileSize) * (pageWidth / wPx);
        const tileY = (ty * backendTileSize) * (pageHeight / hPx);
        const renderWidth = Math.min(backendTileSize * (pageWidth / wPx), pageWidth - tileX);
        const renderHeight = Math.min(backendTileSize * (pageHeight / hPx), pageHeight - tileY);
        
        geometry.push({
          tx,
          ty,
          tileX,
          tileY,
          renderWidth,
          renderHeight,
        });
      }
    }
    
    tileGeometryRef.current = geometry;
    lastTileScaleRef.current = viewState.scale;
    return geometry;
  }, [viewState.scale, pageWidth, pageHeight, pageIndex, pdfMetadata]);

  // 检查是否需要重新渲染
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

  // 重建静态背景
  const rebuildStaticBackground = useCallback(() => {
    const staticCanvas = getStaticBackgroundCanvas();
    const actualWidth = (pageWidth + 4) * devicePixelRatio;
    const actualHeight = (pageHeight + 4) * devicePixelRatio;

    if (staticCanvas.width !== actualWidth || staticCanvas.height !== actualHeight) {
      staticCanvas.width = actualWidth;
      staticCanvas.height = actualHeight;
    }

    const ctx = staticCanvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    ctx.save();
    ctx.clearRect(0, 0, actualWidth, actualHeight);
    
    // 页面背景
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, actualWidth, actualHeight);
    
    // 不绘制边框和阴影，保持简洁的白色背景
    
    // 页码
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const pageNumX = (pageWidth - 56) * devicePixelRatio;
    const pageNumY = (pageHeight + 8) * devicePixelRatio;
    const pageNumWidth = 52 * devicePixelRatio;
    const pageNumHeight = 20 * devicePixelRatio;
    
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
  }, [pageWidth, pageHeight, pageIndex, devicePixelRatio, getStaticBackgroundCanvas]);

  // 绘制瓦片到缓存canvas
  const paintTile = useCallback((
    cacheCtx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    tileX: number,
    tileY: number,
    renderWidth: number,
    renderHeight: number
  ) => {
    cacheCtx.imageSmoothingEnabled = false;
    cacheCtx.drawImage(
      bitmap,
      (tileX + 2) * devicePixelRatio,
      (tileY + 2) * devicePixelRatio,
      renderWidth * devicePixelRatio,
      renderHeight * devicePixelRatio
    );
  }, [devicePixelRatio]);

  // 绘制单页内容
  const drawPage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    const actualWidth = (pageWidth + 4) * devicePixelRatio;
    const actualHeight = (pageHeight + 4) * devicePixelRatio;

    if (canvas.width !== actualWidth || canvas.height !== actualHeight) {
      canvas.width = actualWidth;
      canvas.height = actualHeight;
      canvas.style.width = `${pageWidth + 4}px`;
      canvas.style.height = `${pageHeight + 4}px`;
    }

    const cacheCanvas = getCacheCanvas();
    
    // 滚动中直接使用缓存，早退
    if (isScrolling && cacheCanvas.width > 0 && !needsFullRender()) {
      ctx.clearRect(0, 0, actualWidth, actualHeight);
      ctx.drawImage(cacheCanvas, 0, 0);
      return;
    }

    // 设置缓存canvas尺寸
    if (cacheCanvas.width !== actualWidth || cacheCanvas.height !== actualHeight) {
      cacheCanvas.width = actualWidth;
      cacheCanvas.height = actualHeight;
      rebuildStaticBackground(); // 重建静态背景
    }
    
    const cacheCtx = cacheCanvas.getContext('2d', { alpha: false });
    if (!cacheCtx) return;

    // 确保静态背景存在并复制到缓存canvas
    const staticCanvas = getStaticBackgroundCanvas();
    if (staticCanvas.width === 0 || needsFullRender()) {
      rebuildStaticBackground();
    }
    // 总是复制静态背景到缓存canvas
    cacheCtx.drawImage(getStaticBackgroundCanvas(), 0, 0);

    // 获取瓦片几何信息
    const tileGeometry = computeTileGeometry();

    // 绘制瓦片（增量更新）
    for (const tile of tileGeometry) {
      const { tx, ty, tileX, tileY, renderWidth, renderHeight } = tile;
      
      // 高清瓦片信息
      const highResTileInfo: TileInfo = {
        id: pdfMetadata.id,
        page: pageIndex,
        scale: Math.round(viewState.scale * 100) / 100,
        tx,
        ty,
      };
      
      // 低清瓦片信息
      const lowResTileInfo: TileInfo = {
        id: pdfMetadata.id,
        page: pageIndex,
        scale: Math.round(viewState.scale * POSTER_SCALE_FACTOR * 100) / 100,
        tx,
        ty,
      };

      const highResKey = `highres_${generateTileKey(highResTileInfo)}`;
      const lowResKey = `lowres_${generateTileKey(lowResTileInfo)}`;
      const highResTileState = getTileState(highResKey);
      const lowResTileState = getTileState(lowResKey);
      
      const highResUrl = getTileUrl(highResTileInfo, devicePixelRatio, true);
      const lowResUrl = getTileUrl(lowResTileInfo, devicePixelRatio, false);

      // 优先绘制高清瓦片
      const highResBitmap = bitmapCacheRef.current.get(highResKey);
      const lowResBitmap = bitmapCacheRef.current.get(lowResKey);

      if (highResBitmap && highResTileState.loaded) {
        paintTile(cacheCtx, highResBitmap, tileX, tileY, renderWidth, renderHeight);
      } else if (lowResBitmap && lowResTileState.loaded) {
        cacheCtx.imageSmoothingEnabled = true; // 低清瓦片使用平滑缩放
        paintTile(cacheCtx, lowResBitmap, tileX, tileY, renderWidth, renderHeight);
        cacheCtx.imageSmoothingEnabled = false;
      }

      // 加载高清瓦片（非滚动时）
      if (!highResTileState.loading && !highResBitmap && !isScrolling) {
        updateTileState(highResKey, { loading: true });
        scheduleLoad(async () => {
          try {
            await loadBitmap(highResUrl, highResKey);
            updateTileState(highResKey, { loaded: true, loading: false });
          } catch (error) {
            console.warn('Failed to load high-res tile:', highResTileInfo);
            updateTileState(highResKey, { loading: false });
          }
        });
      }

      // 加载低清瓦片
      if (!highResBitmap && !lowResTileState.loading && !lowResBitmap) {
        updateTileState(lowResKey, { loading: true });
        scheduleLoad(async () => {
          try {
            await loadBitmap(lowResUrl, lowResKey);
            updateTileState(lowResKey, { loaded: true, loading: false });
          } catch (error) {
            console.warn('Failed to load low-res tile:', lowResTileInfo);
            updateTileState(lowResKey, { loading: false });
          }
        });
      }
    }

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
    bitmapCacheRef,
    getTileState,
    updateTileState,
    loadBitmap,
    getCacheCanvas,
    getStaticBackgroundCanvas,
    needsFullRender,
    rebuildStaticBackground,
    computeTileGeometry,
    paintTile
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
        contentVisibility: 'auto',
        contain: 'strict',
        willChange: 'transform',
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
  // 使用 ref 缓存 ImageBitmap，避免触发 React 重渲染
  const bitmapCacheRef = useRef<Map<string, ImageBitmap>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  const [selectedText, setSelectedText] = useState<string>('');
  const lastScaleRef = useRef<number>(viewState.scale);
  
  const { crossPageSelection, setCrossPageSelection } = pdfState;

  // 缩放变化时清理缓存
  useEffect(() => {
    if (lastScaleRef.current !== viewState.scale) {
      console.log(`缩放变化: ${lastScaleRef.current} -> ${viewState.scale}, 清理缓存`);
      
      // 清理 ImageBitmap 缓存
      for (const bitmap of bitmapCacheRef.current.values()) {
        bitmap.close(); // 释放 ImageBitmap 资源
      }
      bitmapCacheRef.current.clear();
      inflightRef.current.clear();
      
      lastScaleRef.current = viewState.scale;
    }
  }, [viewState.scale]);

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

  // 预加载扩展可见页面的瓦片
  useEffect(() => {
    if (isScrolling) return; // 滚动时不进行预加载

    const preloadTiles = () => {
      expandedVisiblePages.forEach(pageLayout => {
        const { pageIndex } = pageLayout;
        const [pageWidthPt, pageHeightPt] = pdfMetadata.page_dims[pageIndex];
        const baseDpi = 150.0;
        const scale = viewState.scale;
        const effectiveDpi = baseDpi * scale;
        
        const wPx = Math.ceil((pageWidthPt / 72.0) * effectiveDpi);
        const hPx = Math.ceil((pageHeightPt / 72.0) * effectiveDpi);
        
        const dpiScale = effectiveDpi / baseDpi;
        const backendTileSize = Math.round(TILE_SIZE * dpiScale);
        
        const endTileX = Math.ceil(wPx / backendTileSize);
        const endTileY = Math.ceil(hPx / backendTileSize);

        for (let tx = 0; tx < endTileX; tx++) {
          for (let ty = 0; ty < endTileY; ty++) {
            // 低清瓦片预加载
            const lowResTileInfo: TileInfo = {
              id: pdfMetadata.id,
              page: pageIndex,
              scale: Math.round(viewState.scale * POSTER_SCALE_FACTOR * 100) / 100,
              tx,
              ty,
            };

            const lowResKey = `lowres_${generateTileKey(lowResTileInfo)}`;
            const lowResTileState = pdfState.getTileState(lowResKey);
            const lowResUrl = getTileUrl(lowResTileInfo, devicePixelRatio, false);

            if (!lowResTileState.loading && !bitmapCacheRef.current.has(lowResKey)) {
              pdfState.updateTileState(lowResKey, { loading: true });
              scheduleLoad(async () => {
                try {
                  const response = await fetch(lowResUrl, { cache: 'force-cache' });
                  const blob = await response.blob();
                  const bitmap = await createImageBitmap(blob);
                  bitmapCacheRef.current.set(lowResKey, bitmap);
                  pdfState.updateTileState(lowResKey, { loaded: true, loading: false });
                } catch (error) {
                  console.warn('Failed to preload low-res tile:', lowResTileInfo);
                  pdfState.updateTileState(lowResKey, { loading: false });
                }
              });
            }
          }
        }
      });
    };

    // 使用 setTimeout 进行预加载，避免阻塞主线程
    const timeoutId = setTimeout(preloadTiles, 100);
    return () => clearTimeout(timeoutId);
  }, [expandedVisiblePages, viewState.scale, pdfMetadata, devicePixelRatio, isScrolling, bitmapCacheRef, pdfState]);

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

  // 计算最大页面宽度，用于确定内容容器宽度
  const maxPageWidth = React.useMemo(() => {
    if (pageLayouts.length === 0) return 0;
    return Math.max(...pageLayouts.map(layout => layout.width));
  }, [pageLayouts]);

  // 监听容器大小变化
  const [containerWidth, setContainerWidth] = React.useState(0);
  
  React.useEffect(() => {
    const updateContainerWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    
    updateContainerWidth();
    
    const resizeObserver = new ResizeObserver(updateContainerWidth);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef]);

  // 计算内容容器的实际宽度
  const contentWidth = React.useMemo(() => {
    const paddingHorizontal = 40; // 左右各20px的边距
    // 如果页面宽度超出容器，则使用页面宽度+边距
    // 否则使用容器宽度，让页面居中
    const needsHorizontalScroll = maxPageWidth + paddingHorizontal > containerWidth;
    const calculatedWidth = needsHorizontalScroll 
      ? maxPageWidth + paddingHorizontal 
      : containerWidth;
    
    // 横向滚动调试信息（可选择性保留）
    // console.log('Content width calculation:', {
    //   containerWidth,
    //   maxPageWidth,
    //   paddingHorizontal,
    //   needsHorizontalScroll,
    //   calculatedWidth
    // });
    
    return calculatedWidth;
  }, [maxPageWidth, containerWidth]);

  return (
    <div
      className="pdf-content"
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        width: `${contentWidth}px`,
        minWidth: `${Math.max(containerWidth, contentWidth)}px`,
        boxSizing: 'border-box',
      }}
    >
      {/* Canvas 渲染层 - 只渲染可见页面 */}
      {visiblePages.map(pageLayout => (
        <PageCanvas
          key={pageLayout.pageIndex}
          pageLayout={pageLayout}
          pdfMetadata={pdfMetadata}
          containerWidth={contentWidth}
          viewState={viewState}
          lastScrollY={lastScrollY}
          isScrolling={isScrolling}
          devicePixelRatio={devicePixelRatio}
          bitmapCacheRef={bitmapCacheRef}
          inflightRef={inflightRef}
          pdfState={pdfState}
        />
      ))}
      
      {/* 文本选择层 */}
      {visiblePages.map(pageLayout => {
        // 如果内容宽度大于容器宽度，页面靠左对齐，否则居中
        const pageX = containerWidth > pageLayout.width
          ? Math.max(20, (containerWidth - pageLayout.width) / 2)  // 居中
          : 20;  // 靠左对齐，保持20px边距
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
              contentVisibility: 'auto',
              contain: 'strict',
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