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
import { TaskSpec, PriorityTaskQueue } from '../../utils/taskQueue';
import { performanceMonitor } from '../../utils/performanceMonitor';
import { WorkerTileLoader, TileLoadResult } from '../../utils/workerTileLoader';

// 瓦片几何信息缓存接口
interface TileGeometry {
  tx: number;
  ty: number;
  tileX: number;
  tileY: number;
  renderWidth: number;
  renderHeight: number;
}

// 全局Worker加载器实例 - 降低并发数
let globalWorkerLoader: WorkerTileLoader | null = null;

function getWorkerLoader(): WorkerTileLoader {
  if (!globalWorkerLoader) {
    globalWorkerLoader = new WorkerTileLoader({
      maxConcurrency: 6, // 降低并发数，配合任务队列的6，总共12个并发
      workerPath: '/workers/tile-loader-worker.js'
    });
    
    // 添加性能测试
    setTimeout(() => {
      globalWorkerLoader?.testFetchPerformance('tiles://test-64kb');
    }, 1000);
  }
  return globalWorkerLoader;
}

// 清理函数
export function cleanupWorkerLoader() {
  if (globalWorkerLoader) {
    globalWorkerLoader.destroy();
    globalWorkerLoader = null;
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
  isPreloadPage?: boolean; // 是否为预加载页面（不在当前视口中）
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
  isPreloadPage = false,
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

  // 延迟添加当前页面需要的任务 - 配合全局reconcile机制 (将在其他变量声明后定义)
  
  const { 
    getTileState, 
    updateTileState 
  } = pdfState;

  const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
  const pageX = containerWidth > pageWidth 
    ? Math.max(20, (containerWidth - pageWidth) / 2)
    : 20;

  // collectNeededTasks将在其他依赖函数之后声明

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

  // 使用Worker加载 ImageBitmap - 避免主线程阻塞
  const loadBitmapWithWorker = useCallback(async (url: string, key: string, priority: number = 100): Promise<ImageBitmap | null> => {
    if (bitmapCacheRef.current.has(key)) {
      return bitmapCacheRef.current.get(key)!;
    }
    
    if (inflightRef.current.has(key)) {
      return null; // 已在加载中
    }
    
    inflightRef.current.add(key);
    
    try {
      const workerLoader = getWorkerLoader();
      const result: TileLoadResult = await workerLoader.loadTile(key, url, priority);
      
      const { imageBitmap, performance: perfData } = result;
      
      // 构建详细的性能日志
      let detailedServerStats = '';
      if (perfData.serverTiming) {
        const st = perfData.serverTiming;
        detailedServerStats = `
        🔧 服务端详情: 队列=${(st.queue || 0).toFixed(1)}ms | 设置=${(st.setup || 0).toFixed(1)}ms | 光栅=${(st.raster || 0).toFixed(1)}ms | 打包=${(st.pack || 0).toFixed(1)}ms | 编码=${(st.encode || 0).toFixed(1)}ms | 写出=${(st.write || 0).toFixed(1)}ms | 总计=${(st.total || 0).toFixed(1)}ms`;
        if (perfData.pixelInfo) {
          const megapixels = (perfData.pixelInfo.width * perfData.pixelInfo.height) / 1_000_000;
          detailedServerStats += ` | 像素=${perfData.pixelInfo.width}x${perfData.pixelInfo.height}(${megapixels.toFixed(2)}MP)`;
        }
      }
      
      console.log(`🚀 Worker瓦片加载 [${key}]: 
        网络请求: ${perfData.fetchTime.toFixed(1)}ms 
        | 解码时间: ${perfData.decodeTime.toFixed(1)}ms 
        | Worker总计: ${perfData.totalTime.toFixed(1)}ms 
        | 数据大小: ${(perfData.size / 1024).toFixed(1)}KB${detailedServerStats}
        ⚡ 主线程阻塞已避免 - 网络和解码在Worker中完成`);
      
      // 记录到性能监控器
      performanceMonitor.recordTileLoad({
        tileKey: key,
        networkTime: perfData.fetchTime,
        blobTime: 0, // Worker中没有单独的blob时间
        bitmapTime: perfData.decodeTime,
        totalFrontendTime: perfData.totalTime,
        serverTiming: perfData.serverTiming,
        pixelInfo: perfData.pixelInfo,
        timestamp: Date.now(),
        isPreload: false
      });
      
      bitmapCacheRef.current.set(key, imageBitmap);
      requestRedraw(); // 触发重绘
      return imageBitmap;
    } catch (error) {
      console.warn('Failed to load bitmap with worker:', key, error);
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

  // 收集当前页面需要的所有瓦片任务
  const collectNeededTasks = useCallback((reason: string) => {
    const neededTasks: TaskSpec[] = [];
    const tileGeometry = computeTileGeometry();
    const allBuckets = generateRenderBuckets(viewState.scale);
    const currentScale = viewState.scale;
    
    // 获取滚动和overscan信息
    const scrollMetrics = getScrollMetrics?.();
    const overscanConfig = scrollMetrics?.overscan || { extraCols: 1, extraRows: 1 };
    
    for (const bucket of allBuckets) {
      // 决定是否应该加载这个桶的瓦片
      const shouldLoadBucket = shouldLoadTargetBucket(null, bucket, currentScale) ||
        bucket.isTarget; // 总是确保目标桶的瓦片
      
      if (!shouldLoadBucket) continue;
      
      for (const tile of tileGeometry) {
        const { tx, ty, tileX, tileY, renderWidth, renderHeight } = tile;
        
        // 检查瓦片是否在overscan区域内
        const isInOverscan = isTileInOverscanArea(
          tileX, tileY, renderWidth, renderHeight,
          0, 0, pageWidth, pageHeight,
          overscanConfig
        );
        
        // 如果正在快速滚动且瓦片在overscan区域外，跳过加载（除非是焦点页面）
        if (isScrolling && !isInOverscan && scrollMetrics && 
            (Math.abs(scrollMetrics.velocity.vy) > 1) && !isFocusPage) {
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
        
        // 如果瓦片尚未加载且不在加载中，加入需求列表
        if (!bitmap && !tileState.loading) {
          const tileInfo: TileInfo = {
            id: pdfMetadata.id,
            page: pageIndex,
            scale: Math.round(bucket.scale * 100) / 100,
            tx,
            ty,
          };
          
          const tileUrl = getTileUrl(tileInfo, devicePixelRatio, bucket.isTarget);
          
          const basePriority = bucket.isTarget ? 100 : 200;
          const distancePriority = Math.floor(Math.abs((tileY + renderHeight/2) - pageHeight/2) / 10);
          const focusPriority = isFocusPage ? -1000 : 0;
          const preloadPenalty = isPreloadPage ? 1000 : 0; // 预加载页面优先级更低
          const finalPriority = basePriority + distancePriority + focusPriority + preloadPenalty;
          
          neededTasks.push({
            id: tileKey,
            priority: finalPriority,
            pageIndex,
            execute: async () => {
              try {
                updateTileState(tileKey, { loading: true });
                await loadBitmapWithWorker(tileUrl, tileKey, finalPriority);
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
          });
        }
      }
    }
    
    console.log(`📋 页面${pageIndex + 1}收集任务 (${reason}): ${neededTasks.length}个瓦片任务`);
    return neededTasks;
  }, [
    computeTileGeometry,
    viewState.scale,
    isScrolling,
    isFocusPage,
    isPreloadPage,
    pageWidth,
    pageHeight,
    pageIndex,
    pdfMetadata.id,
    devicePixelRatio,
    getTileState,
    updateTileState,
    loadBitmapWithWorker,
    checkBucketTilesReady,
    requestRedraw,
    getScrollMetrics,
    bitmapCacheRef,
    inflightRef
  ]);

  // 智能任务添加 - 支持滚动预加载 + epoch机制
  useEffect(() => {
    if (!globalTaskQueue) return;
    
         const addPageTasks = () => {
       const reason = isScrolling ? 'scrolling-preload' : 'scroll-stopped';
       let neededTasks = collectNeededTasks(reason);
       
       // 严格控制滚动中的任务添加 - 防止队列爆炸
       if (isScrolling) {
         // 滚动中只处理当前可见页面，完全跳过预加载页面
         if (isPreloadPage) {
           console.log(`🚫 滚动中跳过预加载页面 ${pageIndex + 1}`);
           return; // 快速滚动时完全跳过所有预加载页面
         }
         
         // 滚动中只为焦点页面加载关键瓦片
         if (!isFocusPage) {
           const scrollMetrics = getScrollMetrics?.();
           const isVerySlowScroll = scrollMetrics && Math.abs(scrollMetrics.velocity.vy) < 0.5;
           if (!isVerySlowScroll) {
             console.log(`🚫 滚动中跳过非焦点页面 ${pageIndex + 1} (速度: ${scrollMetrics?.velocity.vy})`);
             return; // 非极慢滚动时跳过非焦点页面
           }
         }
         
         // 滚动中只加载目标桶，跳过备选桶
         const originalCount = neededTasks.length;
         neededTasks = neededTasks.filter(task => {
           // 只保留目标桶的任务，通过priority判断
           return task.priority < 150; // 目标桶priority通常是100左右
         });
         
         if (originalCount > neededTasks.length) {
           console.log(`🔥 滚动中过滤任务: ${originalCount} → ${neededTasks.length} (页面${pageIndex + 1})`);
         }
         
         // 进一步降低优先级
         neededTasks.forEach(task => {
           task.priority += 800; // 滚动中任务大幅降低优先级
         });
       }
       
       // 如果没有任务需要添加，直接返回
       if (neededTasks.length === 0) {
         return;
       }
       
       for (const task of neededTasks) {
         globalTaskQueue.addTask({
           ...task,
           epoch: globalTaskQueue.getCurrentEpoch()
         });
       }
       
       console.log(`📋 页面${pageIndex + 1}添加任务 (${reason}): ${neededTasks.length}个 ${isPreloadPage ? '[预加载]' : ''}`);
     };

    if (isScrolling) {
      // 滚动中立即添加预加载任务
      const timeoutId = setTimeout(addPageTasks, 50);
      return () => clearTimeout(timeoutId);
    } else {
      // 滚动停止后，延迟添加高优先级任务
      const timeoutId = setTimeout(addPageTasks, 200);
      return () => clearTimeout(timeoutId);
    }
     }, [isScrolling, collectNeededTasks, pageIndex, globalTaskQueue, isFocusPage, isPreloadPage, getScrollMetrics]);

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

  // 绘制瓦片到缓存canvas - 优化的ImageBitmap渲染
  const paintTile = useCallback((
    cacheCtx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    tileX: number,
    tileY: number,
    renderWidth: number,
    renderHeight: number
  ) => {
    // 使用最快的ImageBitmap渲染方式
    cacheCtx.imageSmoothingEnabled = false;
    cacheCtx.globalCompositeOperation = 'source-over';
    
    // 直接绘制ImageBitmap，这是最快的方式
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

    const ctx = canvas.getContext('2d', { 
      alpha: false, 
      desynchronized: true,
      willReadFrequently: false // 优化写入性能
    });
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
        // 立即绘制页面白色背景
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, actualWidth, actualHeight);
        
        // 添加页面边框
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1 * devicePixelRatio;
        ctx.strokeRect(0.5 * devicePixelRatio, 0.5 * devicePixelRatio, actualWidth - devicePixelRatio, actualHeight - devicePixelRatio);
        
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
    
    const cacheCtx = cacheCanvas.getContext('2d', { 
      alpha: false,
      willReadFrequently: false // 优化写入性能
    });
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
    
    // 如果没有可用的桶，绘制白色背景并保持当前缓存内容
    if (!activeBucket) {
      // 立即绘制页面白色背景 - 确保即使没有瓦片也能看到页面轮廓
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, actualWidth, actualHeight);
      
      // 添加页面边框
      ctx.strokeStyle = '#e0e0e0';
      ctx.lineWidth = 1 * devicePixelRatio;
      ctx.strokeRect(0.5 * devicePixelRatio, 0.5 * devicePixelRatio, actualWidth - devicePixelRatio, actualHeight - devicePixelRatio);
      
      if (cacheCanvas.width > 0 && cacheCanvas.height > 0) {
        ctx.drawImage(cacheCanvas, 0, 0);
      }
      return;
    }
    
    // 立即绘制页面白色背景到主canvas - 解决快速滚动时的白屏问题
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, actualWidth, actualHeight);
    
    // 添加页面边框以更清楚地显示页面边界
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1 * devicePixelRatio;
    ctx.strokeRect(0.5 * devicePixelRatio, 0.5 * devicePixelRatio, actualWidth - devicePixelRatio, actualHeight - devicePixelRatio);

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
    
    // 第二道保险：基于overscan的优化加载策略 - 现在由collectNeededTasks处理
    
    // 使用epoch机制的reconcile策略，替代原来的逐个添加任务
    // 在特定条件下触发reconcile，避免过于频繁的调用
    const shouldTriggerReconcile = (
      needsFullRender() || // 首次渲染或状态变化
      (!isScrolling && pageRenderState.lastStillTime !== newStillTime) // 滚动刚停止
    );
    
    if (shouldTriggerReconcile && globalTaskQueue) {
      const reason = needsFullRender() ? 'state-change' : 'scroll-stopped';
      const neededTasks = collectNeededTasks(reason);
      globalTaskQueue.reconcile(neededTasks, reason);
    }

    // Epoch机制已经在reconcile中处理了任务清理，无需手动取消远处任务

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
    globalTaskQueue,
    collectNeededTasks
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
        // 预加载页面优化：减少渲染开销
        ...(isPreloadPage && {
          opacity: 0.98, // 轻微透明度，优化GPU合成
          transform: 'translateZ(0)', // 启用硬件加速
        }),
      }}
    />
  );
}; 