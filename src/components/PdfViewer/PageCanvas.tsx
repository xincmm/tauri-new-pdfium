import React, { useCallback, useRef, useEffect, useState } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE,
  POSTER_SCALE_FACTOR
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { 
  getTileUrl, 
  generateTileKey, 
} from '../../utils/tileUtils';

// 瓦片几何信息缓存接口
interface TileGeometry {
  tx: number;
  ty: number;
  tileX: number;
  tileY: number;
  renderWidth: number;
  renderHeight: number;
}

// 瓦片加载并发控制（本地应用可以使用更高并发）
const MAX_CONCURRENCY = 16;
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

// 单页 Canvas 组件 Props
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

export const PageCanvas: React.FC<PageCanvasProps> = ({
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

  // 页面级别的渲染状态管理
  const [pageRenderState, setPageRenderState] = useState<{
    highResReady: boolean;
    lowResReady: boolean;
    lastRenderedScale: number;
    lastCheckTime: number;
  }>({
    highResReady: false,
    lowResReady: false,
    lastRenderedScale: -1,
    lastCheckTime: 0
  });

  // 缩放变化时重置渲染状态
  useEffect(() => {
    lastRenderStateRef.current = null;
    lastTileScaleRef.current = -1;
    // 重置页面渲染状态
    setPageRenderState({
      highResReady: false,
      lowResReady: false,
      lastRenderedScale: -1,
      lastCheckTime: 0
    });
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
      // 直接调用绘制逻辑，避免循环依赖
      const canvas = canvasRef.current;
      if (canvas) {
        // 触发 useEffect 中的 drawPage 调用
        setPageRenderState(prev => ({ ...prev, lastCheckTime: Date.now() }));
      }
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

  // 检查整页瓦片完整性
  const checkPageTilesReady = useCallback((isHighRes: boolean = true) => {
    const tileGeometry = computeTileGeometry();
    let allTilesReady = true;
    
    for (const tile of tileGeometry) {
      const { tx, ty } = tile;
      const tileInfo: TileInfo = {
        id: pdfMetadata.id,
        page: pageIndex,
        scale: Math.round(viewState.scale * (isHighRes ? 1 : POSTER_SCALE_FACTOR) * 100) / 100,
        tx,
        ty,
      };
      
      const tileKey = `${isHighRes ? 'highres' : 'lowres'}_${generateTileKey(tileInfo)}`;
      const tileState = getTileState(tileKey);
      const bitmap = bitmapCacheRef.current.get(tileKey);
      
      if (!bitmap || !tileState.loaded) {
        allTilesReady = false;
        break;
      }
    }
    
    return allTilesReady;
  }, [pdfMetadata.id, pageIndex, viewState.scale, computeTileGeometry, getTileState, bitmapCacheRef]);

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
    
    // 滚动中直接使用缓存，早退（特别是已有高清版本的页面）
    if (isScrolling && cacheCanvas.width > 0 && !needsFullRender()) {
      // 如果当前页面已经有高清版本，滚动时直接使用缓存
      if (pageRenderState.highResReady && pageRenderState.lastRenderedScale === viewState.scale) {
        ctx.clearRect(0, 0, actualWidth, actualHeight);
        ctx.drawImage(cacheCanvas, 0, 0);
        return;
      }
    }

    // 设置缓存canvas尺寸
    if (cacheCanvas.width !== actualWidth || cacheCanvas.height !== actualHeight) {
      cacheCanvas.width = actualWidth;
      cacheCanvas.height = actualHeight;
      rebuildStaticBackground(); // 重建静态背景
    }
    
    const cacheCtx = cacheCanvas.getContext('2d', { alpha: false });
    if (!cacheCtx) return;

    // 确保静态背景存在
    const staticCanvas = getStaticBackgroundCanvas();
    if (staticCanvas.width === 0 || needsFullRender()) {
      rebuildStaticBackground();
    }

    // 获取瓦片几何信息
    const tileGeometry = computeTileGeometry();

    // 检查整页瓦片完整性
    const highResReady = checkPageTilesReady(true);
    const lowResReady = checkPageTilesReady(false);
    
    // 更新页面渲染状态
    const currentScale = viewState.scale;
    const currentTime = Date.now();
    if (pageRenderState.lastRenderedScale !== currentScale) {
      setPageRenderState({
        highResReady,
        lowResReady,
        lastRenderedScale: currentScale,
        lastCheckTime: currentTime
      });
    }

    // 决定渲染策略：优先使用已有的高清瓦片
    let shouldRenderHighRes = highResReady; // 如果高清瓦片准备好，始终优先使用
    let shouldRenderLowRes = !highResReady && lowResReady; // 只有高清未准备好时才使用低清
    
    // 滚动时的特殊处理：如果已经有高清瓦片，继续使用高清
    if (isScrolling && pageRenderState.highResReady && pageRenderState.lastRenderedScale === currentScale) {
      shouldRenderHighRes = true;
      shouldRenderLowRes = false;
    }
    
    // 调试信息（可选择性启用）
    // const tileCount = tileGeometry.length;
    // console.log(`页面 ${pageIndex + 1} 渲染状态: 高清=${highResReady}(${tileCount}瓦片), 低清=${lowResReady}, 滚动=${isScrolling}, 渲染=${shouldRenderHighRes ? '高清' : shouldRenderLowRes ? '低清' : '跳过'}`);
    
    // 如果都没准备好，保持当前缓存内容
    if (!shouldRenderHighRes && !shouldRenderLowRes) {
      // 只有缓存存在时才绘制，避免空白闪烁
      if (cacheCanvas.width > 0 && cacheCanvas.height > 0) {
        ctx.drawImage(cacheCanvas, 0, 0);
      }
      return;
    }

    // 整页替换时清除缓存，重新绘制静态背景
    cacheCtx.drawImage(getStaticBackgroundCanvas(), 0, 0);

    // 绘制瓦片（整页替换）
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

      // 根据整页准备状态绘制瓦片
      const highResBitmap = bitmapCacheRef.current.get(highResKey);
      const lowResBitmap = bitmapCacheRef.current.get(lowResKey);

      if (shouldRenderHighRes && highResBitmap && highResTileState.loaded) {
        paintTile(cacheCtx, highResBitmap, tileX, tileY, renderWidth, renderHeight);
      } else if (shouldRenderLowRes && lowResBitmap && lowResTileState.loaded) {
        cacheCtx.imageSmoothingEnabled = true; // 低清瓦片使用平滑缩放
        paintTile(cacheCtx, lowResBitmap, tileX, tileY, renderWidth, renderHeight);
        cacheCtx.imageSmoothingEnabled = false;
      }

      // 加载高清瓦片（优先级策略：非滚动时或页面尚未有高清版本时）
      const shouldLoadHighRes = !highResTileState.loading && !highResBitmap && 
        (!isScrolling || !pageRenderState.highResReady);
      if (shouldLoadHighRes) {
        updateTileState(highResKey, { loading: true });
        scheduleLoad(async () => {
          try {
            await loadBitmap(highResUrl, highResKey);
            updateTileState(highResKey, { loaded: true, loading: false });
            // 检查是否整页高清瓦片都已完成，如果是则触发重绘
            setTimeout(() => {
              if (checkPageTilesReady(true)) {
                requestRedraw();
              }
            }, 0);
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
            // 检查是否整页低清瓦片都已完成，如果是则触发重绘
            setTimeout(() => {
              if (checkPageTilesReady(false)) {
                requestRedraw();
              }
            }, 0);
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
    paintTile,
    checkPageTilesReady,
    pageRenderState
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