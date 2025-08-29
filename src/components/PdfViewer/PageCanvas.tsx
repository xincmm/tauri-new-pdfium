import React, { useCallback, useRef, useEffect, useState } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE,
  RenderBucket,
  PageRenderState
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { 
  getTileUrl 
} from '../../utils/tileUtils';
import {
  generateRenderBuckets,
  selectBestAvailableBucket,
  shouldLoadTargetBucket,
  shouldSwitchToTargetBucket,
  generateBucketTileKey
} from '../../utils/bucketUtils';
import {
  scrollBlit,
  isTileInOverscanArea
} from '../../utils/scrollOptimization';
import { ScrollMetrics } from './hooks/useScrollHandler';
import { LoadTask, PriorityTaskQueue } from '../../utils/taskQueue';
import { performanceMonitor } from '../../utils/performanceMonitor';

// 瓦片几何信息缓存接口
interface TileGeometry {
  tx: number;
  ty: number;
  tileX: number;
  tileY: number;
  renderWidth: number;
  renderHeight: number;
}

// 瓦片加载并发控制（保留原有的简单队列作为备用）
const MAX_CONCURRENCY = 32;
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
  getScrollMetrics?: () => ScrollMetrics;
  isFocusPage?: boolean; // 是否为焦点页面
  globalTaskQueue?: PriorityTaskQueue; // 全局任务队列
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
  getScrollMetrics,
  isFocusPage = false,
  globalTaskQueue,
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

  // 页面级别的渲染状态管理 - 使用新的桶策略
  const [pageRenderState, setPageRenderState] = useState<PageRenderState>(() => {
    const buckets = generateRenderBuckets(viewState.scale);
    return {
      targetBucket: buckets.find(b => b.isTarget)!,
      activeBucket: null,
      availableBuckets: [],
      lastStillTime: Date.now(),
      needsFadeTransition: false,
    };
  });

  // 缩放变化时重置渲染状态
  useEffect(() => {
    lastRenderStateRef.current = null;
    lastTileScaleRef.current = -1;
    // 重置页面渲染状态 - 使用新的桶策略
    const buckets = generateRenderBuckets(viewState.scale);
    setPageRenderState({
      targetBucket: buckets.find(b => b.isTarget)!,
      activeBucket: null,
      availableBuckets: [],
      lastStillTime: Date.now(),
      needsFadeTransition: false,
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
      const fetchStart = performance.now();
      const response = await fetch(url, { cache: 'force-cache' });
      const fetchEnd = performance.now();
      
      const blobStart = performance.now();
      const blob = await response.blob();
      const blobEnd = performance.now();
      
      const bitmapStart = performance.now();
      const bitmap = await createImageBitmap(blob);
      const bitmapEnd = performance.now();
      
      // 记录详细的性能统计
      const networkTime = fetchEnd - fetchStart;
      const blobTime = blobEnd - blobStart;
      const bitmapTime = bitmapEnd - bitmapStart;
      const totalFrontendTime = bitmapEnd - fetchStart;
      
      // 解析并显示详细的服务端时间
      const serverTimingHeader = response.headers.get('Server-Timing');
      const pixelHeader = response.headers.get('X-Pixels');
      const serverTiming = performanceMonitor.parseServerTiming(serverTimingHeader);
      const pixelInfo = performanceMonitor.parsePixelInfo(pixelHeader);
      
      let detailedServerStats = '';
      if (serverTiming) {
        detailedServerStats = `
        🔧 服务端详情: 队列=${serverTiming.queue.toFixed(1)}ms | 设置=${serverTiming.setup.toFixed(1)}ms | 光栅=${serverTiming.raster.toFixed(1)}ms | 打包=${serverTiming.pack.toFixed(1)}ms | 编码=${serverTiming.encode.toFixed(1)}ms | 总计=${serverTiming.total.toFixed(1)}ms`;
        if (pixelInfo) {
          const megapixels = (pixelInfo.width * pixelInfo.height) / 1_000_000;
          detailedServerStats += ` | 像素=${pixelInfo.width}x${pixelInfo.height}(${megapixels.toFixed(2)}MP)`;
        }
      }
      
      console.log(`🎯 瓦片加载性能 [${key}]: 
        网络请求: ${networkTime.toFixed(1)}ms 
        | Blob转换: ${blobTime.toFixed(1)}ms 
        | ImageBitmap: ${bitmapTime.toFixed(1)}ms 
        | 总计前端: ${totalFrontendTime.toFixed(1)}ms${detailedServerStats}`);
      
      // 记录到性能监控器
      performanceMonitor.recordTileLoad({
        tileKey: key,
        networkTime,
        blobTime,
        bitmapTime,
        totalFrontendTime,
        serverTiming: serverTiming,
        pixelInfo: pixelInfo,
        timestamp: Date.now(),
        isPreload: false
      });
      
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
    const baseDpi = 96.0;
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

  // 检查指定桶的整页瓦片完整性
  const checkBucketTilesReady = useCallback((bucket: RenderBucket) => {
    const tileGeometry = computeTileGeometry();
    let allTilesReady = true;
    
    for (const tile of tileGeometry) {
      const { tx, ty } = tile;
      const tileKey = generateBucketTileKey(bucket, {
        id: pdfMetadata.id,
        page: pageIndex,
        tx,
        ty,
      });
      
      const tileState = getTileState(tileKey);
      const bitmap = bitmapCacheRef.current.get(tileKey);
      
      if (!bitmap || !tileState.loaded) {
        allTilesReady = false;
        break;
      }
    }
    
    return allTilesReady;
  }, [pdfMetadata.id, pageIndex, computeTileGeometry, getTileState, bitmapCacheRef]);

  // 获取所有可用的桶
  const getAvailableBuckets = useCallback(() => {
    const allBuckets = generateRenderBuckets(viewState.scale);
    return allBuckets.filter(bucket => checkBucketTilesReady(bucket));
  }, [viewState.scale, checkBucketTilesReady]);

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

    // 第一道保险：画面复用（滚动时立刻有画面）
    if (isScrolling && getScrollMetrics) {
      const metrics = getScrollMetrics();
      const deltaY = metrics.deltaY;
      
      // 只有在小范围滚动时才执行blit，大跳转时跳过
      if (!metrics.isLargeJump && Math.abs(deltaY) > 0 && Math.abs(deltaY) < actualHeight * 0.8) {
        const pixelDeltaY = deltaY * devicePixelRatio;
        const blitResult = scrollBlit(ctx, 0, -pixelDeltaY);
        
        if (blitResult.blitPerformed) {
          // 如果成功执行了blit，可以早退，只需要补充脏带
          // 这里暂时继续完整渲染，后续可以优化为只渲染脏带
          console.log(`Page ${pageIndex + 1} performed scroll blit, dirty rects:`, blitResult.dirtyRects.length);
        }
      }
    }

    const cacheCanvas = getCacheCanvas();
    
    // 滚动中直接使用缓存，早退（特别是已有高清版本的页面）
    if (isScrolling && cacheCanvas.width > 0 && !needsFullRender()) {
      // 如果当前页面已经有可用的桶，滚动时直接使用缓存
      if (pageRenderState.activeBucket) {
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

    // 使用新的桶策略
    const currentScale = viewState.scale;
    const currentTime = Date.now();
    const allBuckets = generateRenderBuckets(currentScale);
    const availableBuckets = getAvailableBuckets();
    
    // 更新静止时间
    const isCurrentlyStill = !isScrolling;
    const newStillTime = isCurrentlyStill ? pageRenderState.lastStillTime : currentTime;
    const stillDuration = isCurrentlyStill ? currentTime - pageRenderState.lastStillTime : 0;
    
    // 选择最佳可用桶作为占位图
    const bestAvailableBucket = selectBestAvailableBucket(availableBuckets, currentScale);
    const targetBucket = allBuckets.find(b => b.isTarget)!;
    const targetBucketReady = availableBuckets.some(b => b.isTarget);
    
    // 决定是否需要切换到目标桶
    const shouldSwitchToTarget = shouldSwitchToTargetBucket(
      pageRenderState.activeBucket,
      targetBucket,
      isCurrentlyStill,
      stillDuration,
      targetBucketReady
    );
    
    // 确定当前应该显示的桶
    let activeBucket: RenderBucket | null = null;
    if (shouldSwitchToTarget) {
      activeBucket = targetBucket;
    } else if (bestAvailableBucket) {
      activeBucket = bestAvailableBucket;
    } else {
      activeBucket = pageRenderState.activeBucket; // 保持当前桶
    }
    
    // 更新页面渲染状态
    if (pageRenderState.activeBucket !== activeBucket || !isCurrentlyStill) {
      setPageRenderState(prev => ({
        ...prev,
        activeBucket,
        availableBuckets,
        lastStillTime: newStillTime,
        needsFadeTransition: shouldSwitchToTarget,
      }));
    }
    
    // 如果没有可用的桶，保持当前缓存内容
    if (!activeBucket) {
      if (cacheCanvas.width > 0 && cacheCanvas.height > 0) {
        ctx.drawImage(cacheCanvas, 0, 0);
      }
      return;
    }
    
    // 调试信息
    if (isFocusPage) {
      console.log(`焦点页面 ${pageIndex + 1} 桶策略: 活动桶=${activeBucket.key}(${activeBucket.scale.toFixed(2)}), 可用桶=${availableBuckets.length}, 静止=${isCurrentlyStill}`);
    }

    // 整页替换时清除缓存，重新绘制静态背景
    cacheCtx.drawImage(getStaticBackgroundCanvas(), 0, 0);

    // 绘制当前活动桶的瓦片
    for (const tile of tileGeometry) {
      const { tx, ty, tileX, tileY, renderWidth, renderHeight } = tile;
      
      // 生成当前活动桶的瓦片键
      const activeTileKey = generateBucketTileKey(activeBucket, {
        id: pdfMetadata.id,
        page: pageIndex,
        tx,
        ty,
      });
      
      const activeBitmap = bitmapCacheRef.current.get(activeTileKey);
      const activeTileState = getTileState(activeTileKey);
      
      // 绘制当前活动桶的瓦片
      if (activeBitmap && activeTileState.loaded) {
        // 根据桶的缩放因子决定是否使用平滑缩放
        const needsSmoothing = activeBucket.scale < currentScale;
        cacheCtx.imageSmoothingEnabled = needsSmoothing;
        paintTile(cacheCtx, activeBitmap, tileX, tileY, renderWidth, renderHeight);
        cacheCtx.imageSmoothingEnabled = false;
      }
    }
    
    // 第二道保险：基于overscan的优化加载策略
    const scrollMetrics = getScrollMetrics?.();
    const overscanConfig = scrollMetrics?.overscan || { extraCols: 1, extraRows: 1 };
    
    // 后台加载策略：为所有桶加载瓦片（带overscan优化）
    for (const bucket of allBuckets) {
      // 决定是否应该加载这个桶的瓦片
      const shouldLoadBucket = shouldLoadTargetBucket(activeBucket, bucket, currentScale) ||
        bucket === activeBucket; // 总是确保活动桶的瓦片完整
      
      if (!shouldLoadBucket) continue;
      
      // 按优先级排序瓦片（近→远优先）
      const sortedTiles = [...tileGeometry].sort((a, b) => {
        const aCenter = a.tileY + (a.renderHeight / 2);
        const bCenter = b.tileY + (b.renderHeight / 2);
        const viewportCenter = pageHeight / 2; // 简化的视口中心
        
        const aDist = Math.abs(aCenter - viewportCenter);
        const bDist = Math.abs(bCenter - viewportCenter);
        
        return aDist - bDist; // 距离近的优先
      });
      
      for (const tile of sortedTiles) {
        const { tx, ty, tileX, tileY, renderWidth, renderHeight } = tile;
        
        // 第二道保险：检查瓦片是否在overscan区域内
        const isInOverscan = isTileInOverscanArea(
          tileX, tileY, renderWidth, renderHeight,
          0, 0, pageWidth, pageHeight, // 简化的视口区域
          overscanConfig
        );
        
        // 如果正在快速滚动且瓦片在overscan区域外，跳过加载（除非是焦点页面）
        if (isScrolling && !isInOverscan && scrollMetrics && 
            (Math.abs(scrollMetrics.velocity.vy) > 1) && !isFocusPage) { // 焦点页面优先加载
          continue;
        }
        
        const tileKey = generateBucketTileKey(bucket, {
          id: pdfMetadata.id,
          page: pageIndex,
          tx,
          ty,
        });
        
        const tileState = getTileState(tileKey);
        const bitmap = bitmapCacheRef.current.get(tileKey);
        
        // 如果瓦片尚未加载且不在加载中，启动加载
        if (!bitmap && !tileState.loading) {
          const tileInfo: TileInfo = {
            id: pdfMetadata.id,
            page: pageIndex,
            scale: Math.round(bucket.scale * 100) / 100,
            tx,
            ty,
          };
          
          const tileUrl = getTileUrl(tileInfo, devicePixelRatio, bucket.isTarget);
          
          updateTileState(tileKey, { loading: true });
          
          // 使用全局优先级队列（如果可用）或回退到简单队列
          if (globalTaskQueue) {
            const basePriority = bucket.isTarget ? 100 : 200;
            const distancePriority = Math.floor(Math.abs((tileY + renderHeight/2) - pageHeight/2) / 10); // 距离权重
            const finalPriority = basePriority + distancePriority + (isFocusPage ? -1000 : 0); // 焦点页面大幅提升优先级
            
            const task: LoadTask = {
              id: tileKey,
              priority: finalPriority,
              pageIndex,
              execute: async () => {
                try {
                  await loadBitmap(tileUrl, tileKey);
                  updateTileState(tileKey, { loaded: true, loading: false });
                  
                  // 检查是否该桶的整页瓦片都已完成
                  setTimeout(() => {
                    if (checkBucketTilesReady(bucket)) {
                      requestRedraw();
                    }
                  }, 0);
                } catch (error) {
                  console.warn(`Failed to load ${bucket.key} tile:`, tileInfo);
                  updateTileState(tileKey, { loading: false });
                }
              },
              cancel: () => {
                updateTileState(tileKey, { loading: false });
                inflightRef.current.delete(tileKey);
              }
            };
            
            globalTaskQueue.addTask(task);
          } else {
            // 回退到简单队列
            scheduleLoad(async () => {
              try {
                await loadBitmap(tileUrl, tileKey);
                updateTileState(tileKey, { loaded: true, loading: false });
                
                // 检查是否该桶的整页瓦片都已完成
                setTimeout(() => {
                  if (checkBucketTilesReady(bucket)) {
                    requestRedraw();
                  }
                }, 0);
              } catch (error) {
                console.warn(`Failed to load ${bucket.key} tile:`, tileInfo);
                updateTileState(tileKey, { loading: false });
              }
            });
          }
        }
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
    checkBucketTilesReady,
    getAvailableBuckets,
    pageRenderState,
    isFocusPage,
    globalTaskQueue
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
        // 焦点页面提升渲染优先级
        ...(isFocusPage && {
          zIndex: 1,
          opacity: 1,
        }),
      }}
    />
  );
}; 