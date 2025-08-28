# OffscreenCanvas 优化方案详解

## 概述

OffscreenCanvas 是 Web 平台的一个重要 API，允许在 Web Worker 中进行 Canvas 渲染操作，从而将计算密集型的渲染任务从主线程转移到后台线程，显著提升应用性能和用户体验。

## 技术原理

### 传统 Canvas 渲染的问题

```typescript
// 传统方案：主线程渲染
const drawPage = () => {
  const canvas = canvasRef.current;
  const ctx = canvas.getContext('2d');
  
  // 🚫 主线程阻塞操作
  for (const tile of tiles) {
    ctx.drawImage(tile.bitmap, tile.x, tile.y); // 阻塞主线程
  }
  
  // 🚫 复杂的图像处理也在主线程
  ctx.filter = 'blur(2px)';
  ctx.drawImage(processedImage, 0, 0);
};
```

**问题分析:**
1. **主线程阻塞**: 大量瓦片合成时会阻塞 UI 响应
2. **帧率下降**: 复杂渲染导致掉帧和卡顿
3. **用户体验差**: 滚动、缩放等操作不流畅

### OffscreenCanvas 解决方案

```typescript
// OffscreenCanvas 方案：后台线程渲染
class OffscreenRenderer {
  private worker: Worker;
  private offscreenCanvas: OffscreenCanvas;
  
  constructor() {
    // 创建 Worker 和 OffscreenCanvas
    this.worker = new Worker('/workers/tile-renderer.js');
    this.offscreenCanvas = new OffscreenCanvas(800, 600);
    
    // 将 OffscreenCanvas 转移到 Worker
    this.worker.postMessage({
      type: 'init',
      canvas: this.offscreenCanvas
    }, [this.offscreenCanvas]);
  }
}
```

**优势分析:**
1. **主线程释放**: 渲染任务在 Worker 中执行
2. **并行处理**: 多个 Worker 可以并行渲染不同页面
3. **流畅交互**: UI 操作不受渲染影响

## 详细实现方案

### 1. Worker 端渲染器

```typescript
// workers/tile-renderer.ts
class WorkerTileRenderer {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private tileCache = new Map<string, ImageBitmap>();

  async initialize(canvas: OffscreenCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    if (!this.ctx) {
      throw new Error('Failed to get OffscreenCanvas context');
    }
  }

  async renderPage(request: PageRenderRequest): Promise<ImageBitmap> {
    if (!this.ctx || !this.canvas) {
      throw new Error('Renderer not initialized');
    }

    const { pageIndex, tiles, dimensions, scale } = request;
    
    // 设置 Canvas 尺寸
    this.canvas.width = dimensions.width;
    this.canvas.height = dimensions.height;
    
    // 清除画布
    this.ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    
    // 绘制静态背景
    await this.drawStaticBackground(pageIndex, dimensions);
    
    // 批量渲染瓦片
    await this.renderTilesBatch(tiles);
    
    // 应用后处理效果（如果需要）
    await this.applyPostProcessing(scale);
    
    // 创建 ImageBitmap 返回给主线程
    return this.canvas.transferToImageBitmap();
  }

  private async drawStaticBackground(
    pageIndex: number, 
    dimensions: PageDimensions
  ): Promise<void> {
    if (!this.ctx) return;
    
    // 绘制页面背景
    this.ctx.fillStyle = 'white';
    this.ctx.fillRect(0, 0, dimensions.width, dimensions.height);
    
    // 绘制页码
    this.ctx.fillStyle = 'rgba(0,0,0,0.7)';
    this.ctx.font = '12px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(
      `${pageIndex + 1}`, 
      dimensions.width - 30, 
      dimensions.height - 10
    );
  }

  private async renderTilesBatch(tiles: TileRenderInfo[]): Promise<void> {
    if (!this.ctx) return;

    // 按优先级排序瓦片（中心瓦片优先）
    const sortedTiles = this.sortTilesByPriority(tiles);
    
    for (const tile of sortedTiles) {
      await this.renderSingleTile(tile);
    }
  }

  private async renderSingleTile(tile: TileRenderInfo): Promise<void> {
    if (!this.ctx) return;

    // 从缓存获取或加载瓦片
    let bitmap = this.tileCache.get(tile.key);
    
    if (!bitmap) {
      bitmap = await this.loadTileBitmap(tile.url);
      this.tileCache.set(tile.key, bitmap);
    }
    
    // 渲染瓦片到 Canvas
    this.ctx.imageSmoothingEnabled = tile.isHighRes ? false : true;
    this.ctx.drawImage(
      bitmap,
      tile.destX,
      tile.destY,
      tile.destWidth,
      tile.destHeight
    );
  }

  private async loadTileBitmap(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  private sortTilesByPriority(tiles: TileRenderInfo[]): TileRenderInfo[] {
    // 计算每个瓦片到页面中心的距离，中心瓦片优先
    return tiles.sort((a, b) => {
      const centerX = a.pageWidth / 2;
      const centerY = a.pageHeight / 2;
      
      const distA = Math.sqrt(
        Math.pow(a.destX + a.destWidth / 2 - centerX, 2) +
        Math.pow(a.destY + a.destHeight / 2 - centerY, 2)
      );
      
      const distB = Math.sqrt(
        Math.pow(b.destX + b.destWidth / 2 - centerX, 2) +
        Math.pow(b.destY + b.destHeight / 2 - centerY, 2)
      );
      
      return distA - distB;
    });
  }

  private async applyPostProcessing(scale: number): Promise<void> {
    if (!this.ctx || !this.canvas) return;
    
    // 根据缩放级别应用不同的后处理
    if (scale < 0.5) {
      // 小缩放时应用抗锯齿
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    } else if (scale > 2.0) {
      // 大缩放时保持锐利
      this.ctx.imageSmoothingEnabled = false;
    }
  }
}

// Worker 消息处理
const renderer = new WorkerTileRenderer();

self.onmessage = async (event) => {
  const { type, data, requestId } = event.data;
  
  try {
    switch (type) {
      case 'init':
        await renderer.initialize(data.canvas);
        self.postMessage({ type: 'init-complete', requestId });
        break;
        
      case 'render-page':
        const bitmap = await renderer.renderPage(data);
        self.postMessage({ 
          type: 'render-complete', 
          requestId,
          bitmap 
        }, [bitmap]);
        break;
        
      case 'clear-cache':
        renderer.clearCache();
        self.postMessage({ type: 'cache-cleared', requestId });
        break;
    }
  } catch (error) {
    self.postMessage({ 
      type: 'error', 
      requestId, 
      error: error.message 
    });
  }
};
```

### 2. 主线程管理器

```typescript
// hooks/useOffscreenRenderer.ts
export const useOffscreenRenderer = () => {
  const workersRef = useRef<Map<number, OffscreenWorkerManager>>(new Map());
  const [isInitialized, setIsInitialized] = useState(false);

  const initializeWorkers = useCallback(async (workerCount: number = 2) => {
    // 创建多个 Worker 实例用于并行渲染
    for (let i = 0; i < workerCount; i++) {
      const manager = new OffscreenWorkerManager(i);
      await manager.initialize();
      workersRef.current.set(i, manager);
    }
    
    setIsInitialized(true);
  }, []);

  const renderPageOffscreen = useCallback(async (
    pageIndex: number,
    tiles: TileRenderInfo[],
    dimensions: PageDimensions,
    scale: number
  ): Promise<ImageBitmap> => {
    // 选择负载最轻的 Worker
    const workerId = selectOptimalWorker(workersRef.current);
    const worker = workersRef.current.get(workerId);
    
    if (!worker) {
      throw new Error(`Worker ${workerId} not available`);
    }

    return worker.renderPage({
      pageIndex,
      tiles,
      dimensions,
      scale
    });
  }, []);

  const cleanup = useCallback(() => {
    workersRef.current.forEach(worker => worker.terminate());
    workersRef.current.clear();
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    isInitialized,
    initializeWorkers,
    renderPageOffscreen,
    cleanup
  };
};

class OffscreenWorkerManager {
  private worker: Worker;
  private pendingRequests = new Map<string, PendingRequest>();
  private isReady = false;
  private loadMetrics = {
    activeRequests: 0,
    completedRequests: 0,
    averageRenderTime: 0
  };

  constructor(private workerId: number) {
    this.worker = new Worker('/workers/tile-renderer.js');
    this.setupMessageHandler();
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId();
      
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        startTime: performance.now(),
        type: 'init'
      });

      // 创建 OffscreenCanvas 并转移到 Worker
      const canvas = new OffscreenCanvas(1024, 768);
      this.worker.postMessage({
        type: 'init',
        requestId,
        data: { canvas }
      }, [canvas]);
    });
  }

  async renderPage(request: PageRenderRequest): Promise<ImageBitmap> {
    if (!this.isReady) {
      throw new Error('Worker not ready');
    }

    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId();
      
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        startTime: performance.now(),
        type: 'render-page'
      });

      this.loadMetrics.activeRequests++;
      
      this.worker.postMessage({
        type: 'render-page',
        requestId,
        data: request
      });
    });
  }

  private setupMessageHandler(): void {
    this.worker.onmessage = (event) => {
      const { type, requestId, bitmap, error } = event.data;
      const request = this.pendingRequests.get(requestId);
      
      if (!request) return;

      const duration = performance.now() - request.startTime;
      this.updateMetrics(request.type, duration);

      switch (type) {
        case 'init-complete':
          this.isReady = true;
          request.resolve();
          break;
          
        case 'render-complete':
          this.loadMetrics.activeRequests--;
          request.resolve(bitmap);
          break;
          
        case 'error':
          this.loadMetrics.activeRequests--;
          request.reject(new Error(error));
          break;
      }
      
      this.pendingRequests.delete(requestId);
    };

    this.worker.onerror = (error) => {
      console.error(`Worker ${this.workerId} error:`, error);
      // 重启 Worker 逻辑
      this.restartWorker();
    };
  }

  private updateMetrics(type: string, duration: number): void {
    if (type === 'render-page') {
      this.loadMetrics.completedRequests++;
      this.loadMetrics.averageRenderTime = 
        (this.loadMetrics.averageRenderTime * (this.loadMetrics.completedRequests - 1) + duration) 
        / this.loadMetrics.completedRequests;
    }
  }

  getLoadScore(): number {
    // 计算 Worker 负载分数，用于负载均衡
    return this.loadMetrics.activeRequests * 0.6 + 
           this.loadMetrics.averageRenderTime * 0.4;
  }

  private generateRequestId(): string {
    return `${this.workerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private async restartWorker(): Promise<void> {
    this.worker.terminate();
    this.worker = new Worker('/workers/tile-renderer.js');
    this.setupMessageHandler();
    this.isReady = false;
    await this.initialize();
  }

  terminate(): void {
    this.worker.terminate();
    this.pendingRequests.forEach(request => {
      request.reject(new Error('Worker terminated'));
    });
    this.pendingRequests.clear();
  }
}

// 负载均衡算法
function selectOptimalWorker(workers: Map<number, OffscreenWorkerManager>): number {
  let optimalWorkerId = 0;
  let minLoadScore = Infinity;
  
  workers.forEach((worker, id) => {
    const loadScore = worker.getLoadScore();
    if (loadScore < minLoadScore) {
      minLoadScore = loadScore;
      optimalWorkerId = id;
    }
  });
  
  return optimalWorkerId;
}
```

### 3. 集成到现有 PageCanvas 组件

```typescript
// components/PdfViewer/PageCanvas.tsx (修改版)
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
  const { renderPageOffscreen, isInitialized } = useOffscreenRenderer();
  const [useOffscreen, setUseOffscreen] = useState(false);

  // 检测是否应该使用 OffscreenCanvas
  useEffect(() => {
    const shouldUseOffscreen = 
      isInitialized && 
      'OffscreenCanvas' in window && 
      pageLayout.width * pageLayout.height > 500000; // 大页面使用 OffscreenCanvas
    
    setUseOffscreen(shouldUseOffscreen);
  }, [isInitialized, pageLayout.width, pageLayout.height]);

  const drawPageWithOffscreen = useCallback(async () => {
    if (!useOffscreen) {
      // 回退到传统渲染
      return drawPageTraditional();
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      // 准备瓦片数据
      const tiles = await prepareTileRenderInfo();
      
      // 在 Worker 中渲染
      const bitmap = await renderPageOffscreen(
        pageLayout.pageIndex,
        tiles,
        {
          width: pageLayout.width,
          height: pageLayout.height
        },
        viewState.scale
      );

      // 将结果绘制到主 Canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      
      // 释放 ImageBitmap 资源
      bitmap.close();
      
    } catch (error) {
      console.warn('OffscreenCanvas rendering failed, fallback to traditional:', error);
      // 自动回退到传统渲染
      setUseOffscreen(false);
      drawPageTraditional();
    }
  }, [useOffscreen, renderPageOffscreen, pageLayout, viewState.scale]);

  const prepareTileRenderInfo = useCallback(async (): Promise<TileRenderInfo[]> => {
    const tileGeometry = computeTileGeometry();
    const tiles: TileRenderInfo[] = [];

    for (const tile of tileGeometry) {
      const { tx, ty, tileX, tileY, renderWidth, renderHeight } = tile;
      
      // 高清瓦片信息
      const highResTileInfo: TileInfo = {
        id: pdfMetadata.id,
        page: pageLayout.pageIndex,
        scale: Math.round(viewState.scale * 100) / 100,
        tx,
        ty,
      };

      const highResKey = `highres_${generateTileKey(highResTileInfo)}`;
      const bitmap = bitmapCacheRef.current.get(highResKey);
      
      if (bitmap) {
        tiles.push({
          key: highResKey,
          url: getTileUrl(highResTileInfo, devicePixelRatio, true),
          destX: tileX,
          destY: tileY,
          destWidth: renderWidth,
          destHeight: renderHeight,
          isHighRes: true,
          pageWidth: pageLayout.width,
          pageHeight: pageLayout.height
        });
      }
    }

    return tiles;
  }, [pdfMetadata, pageLayout, viewState.scale, devicePixelRatio, bitmapCacheRef]);

  // 使用 OffscreenCanvas 或传统方法
  const drawPage = useOffscreen ? drawPageWithOffscreen : drawPageTraditional;

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
```

## 性能优化策略

### 1. 智能任务调度

```typescript
class TaskScheduler {
  private highPriorityQueue: RenderTask[] = [];
  private normalPriorityQueue: RenderTask[] = [];
  private workerPool: OffscreenWorkerManager[];

  scheduleRender(task: RenderTask): Promise<ImageBitmap> {
    // 根据任务优先级分配到不同队列
    if (task.isVisible || task.isUserInteracting) {
      this.highPriorityQueue.push(task);
    } else {
      this.normalPriorityQueue.push(task);
    }

    return this.processNextTask();
  }

  private async processNextTask(): Promise<ImageBitmap> {
    // 优先处理高优先级任务
    const task = this.highPriorityQueue.shift() || this.normalPriorityQueue.shift();
    if (!task) return;

    // 选择最优 Worker
    const worker = this.selectOptimalWorker();
    return worker.renderPage(task.request);
  }
}
```

### 2. 内存管理优化

```typescript
class OffscreenMemoryManager {
  private bitmapCache = new Map<string, ImageBitmap>();
  private maxCacheSize = 100 * 1024 * 1024; // 100MB
  private currentCacheSize = 0;

  cacheBitmap(key: string, bitmap: ImageBitmap): void {
    // 估算 ImageBitmap 大小
    const estimatedSize = bitmap.width * bitmap.height * 4; // RGBA
    
    // 如果超出缓存限制，清理 LRU 项目
    while (this.currentCacheSize + estimatedSize > this.maxCacheSize) {
      this.evictLRU();
    }

    this.bitmapCache.set(key, bitmap);
    this.currentCacheSize += estimatedSize;
  }

  private evictLRU(): void {
    // LRU 缓存清理逻辑
    const oldestKey = this.bitmapCache.keys().next().value;
    const bitmap = this.bitmapCache.get(oldestKey);
    
    if (bitmap) {
      bitmap.close(); // 释放 ImageBitmap 资源
      this.bitmapCache.delete(oldestKey);
      this.currentCacheSize -= bitmap.width * bitmap.height * 4;
    }
  }
}
```

## 浏览器兼容性和降级方案

### 兼容性检测

```typescript
const OffscreenCanvasSupport = {
  check(): boolean {
    return (
      'OffscreenCanvas' in window &&
      'transferControlToOffscreen' in HTMLCanvasElement.prototype &&
      typeof Worker !== 'undefined'
    );
  },

  checkWorkerSupport(): boolean {
    try {
      new Worker('data:text/javascript,');
      return true;
    } catch {
      return false;
    }
  },

  getFeatureLevel(): 'full' | 'partial' | 'none' {
    if (this.check() && this.checkWorkerSupport()) {
      return 'full';
    } else if ('OffscreenCanvas' in window) {
      return 'partial';
    } else {
      return 'none';
    }
  }
};
```

### 渐进式增强

```typescript
const useAdaptiveRenderer = () => {
  const [renderingMode, setRenderingMode] = useState<'traditional' | 'offscreen'>('traditional');

  useEffect(() => {
    const featureLevel = OffscreenCanvasSupport.getFeatureLevel();
    
    switch (featureLevel) {
      case 'full':
        setRenderingMode('offscreen');
        break;
      case 'partial':
      case 'none':
        setRenderingMode('traditional');
        break;
    }
  }, []);

  return {
    renderingMode,
    canUseOffscreen: renderingMode === 'offscreen'
  };
};
```

## 性能收益分析

### 理论性能提升

1. **主线程释放**: 50-80% 的渲染时间从主线程转移
2. **并行处理**: 多页面同时渲染，整体渲染时间减少 30-60%
3. **用户体验**: 滚动和交互响应性提升 2-3 倍

### 实际测试指标

```typescript
// 性能测试工具
class PerformanceBenchmark {
  async compareRenderingMethods(testCases: TestCase[]): Promise<BenchmarkResult> {
    const results = {
      traditional: await this.benchmarkTraditional(testCases),
      offscreen: await this.benchmarkOffscreen(testCases)
    };

    return {
      renderTimeImprovement: (results.traditional.avgTime - results.offscreen.avgTime) / results.traditional.avgTime,
      mainThreadBlockingReduction: results.traditional.mainThreadTime / results.offscreen.mainThreadTime,
      memoryUsageComparison: results.offscreen.memoryUsage / results.traditional.memoryUsage
    };
  }
}
```

## 实施建议

### 分阶段实施

1. **阶段 1**: 基础 OffscreenCanvas 支持
2. **阶段 2**: 多 Worker 并行渲染
3. **阶段 3**: 智能任务调度和负载均衡
4. **阶段 4**: 高级优化（内存管理、错误恢复）

### 风险控制

1. **功能开关**: 可以随时关闭 OffscreenCanvas 功能
2. **自动降级**: 遇到错误自动回退到传统方法
3. **性能监控**: 实时监控渲染性能指标
4. **用户反馈**: 收集真实使用场景的性能数据

---

*OffscreenCanvas 优化方案版本: v1.0*  
*文档创建日期: 2024年* 