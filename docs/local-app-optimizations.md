# 本地应用特定优化方案

## 本地应用 vs Web 应用的优势

### 性能优势
1. **无网络延迟**: 瓦片数据通过 Tauri 本地协议加载，延迟极低
2. **更高并发**: 不受浏览器网络连接限制，可以使用更高的并发数
3. **系统资源**: 可以更充分利用系统 CPU 和内存资源
4. **文件访问**: 直接访问本地文件系统，无需网络传输

### 配置调整

#### 并发数优化
```typescript
// 原配置（适用于 Web 应用）
const MAX_CONCURRENCY = 8;

// 本地应用优化配置
const MAX_CONCURRENCY = 16; // 可以根据系统配置动态调整

// 动态并发配置
const getOptimalConcurrency = (): number => {
  const cpuCores = navigator.hardwareConcurrency || 4;
  // 本地应用可以使用更激进的并发策略
  return Math.min(cpuCores * 4, 32); // 最多32个并发
};
```

#### 内存配置优化
```typescript
// 本地应用可以使用更大的缓存
const LOCAL_APP_CONFIG = {
  // 瓦片缓存大小（本地应用可以更大）
  TILE_CACHE_SIZE: 200 * 1024 * 1024, // 200MB（Web应用通常50-100MB）
  
  // 预加载页面数（本地应用可以更激进）
  PRELOAD_PAGES_AHEAD: 4, // Web应用通常2页
  
  // ImageBitmap 缓存数量
  MAX_BITMAP_CACHE: 1000, // Web应用通常200-500
  
  // 并发瓦片加载数
  MAX_CONCURRENCY: 16, // Web应用通常6-8
};
```

## 本地应用特定优化策略

### 1. 系统资源感知配置

```typescript
// hooks/useSystemAwareConfig.ts
export const useSystemAwareConfig = () => {
  const [config, setConfig] = useState<LocalAppConfig | null>(null);

  useEffect(() => {
    const detectSystemCapabilities = async () => {
      const cpuCores = navigator.hardwareConcurrency || 4;
      const memoryGB = (navigator as any).deviceMemory || 4; // 实验性 API
      
      // 根据系统配置动态调整
      const optimizedConfig: LocalAppConfig = {
        maxConcurrency: Math.min(cpuCores * 4, 32),
        tileCacheSize: Math.min(memoryGB * 50 * 1024 * 1024, 500 * 1024 * 1024),
        preloadPagesAhead: cpuCores >= 8 ? 6 : 4,
        maxBitmapCache: cpuCores >= 8 ? 1500 : 1000,
      };
      
      setConfig(optimizedConfig);
    };

    detectSystemCapabilities();
  }, []);

  return config;
};
```

### 2. 本地文件系统优化

```typescript
// utils/localFileOptimizer.ts
export class LocalFileOptimizer {
  private fileCache = new Map<string, ArrayBuffer>();
  
  // 预读取文件到内存（本地应用优势）
  async preloadTileData(tileUrls: string[]): Promise<void> {
    const loadPromises = tileUrls.map(async (url) => {
      if (this.fileCache.has(url)) return;
      
      try {
        // 通过 Tauri 直接读取本地文件
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        this.fileCache.set(url, buffer);
      } catch (error) {
        console.warn(`Failed to preload tile: ${url}`, error);
      }
    });

    await Promise.all(loadPromises);
  }

  // 从内存缓存创建 ImageBitmap
  async createBitmapFromCache(url: string): Promise<ImageBitmap | null> {
    const buffer = this.fileCache.get(url);
    if (!buffer) return null;

    const blob = new Blob([buffer]);
    return createImageBitmap(blob);
  }

  // 智能缓存清理
  clearCache(keepRecentCount: number = 100): void {
    if (this.fileCache.size <= keepRecentCount) return;

    // 保留最近使用的文件
    const entries = Array.from(this.fileCache.entries());
    const toKeep = entries.slice(-keepRecentCount);
    
    this.fileCache.clear();
    toKeep.forEach(([url, buffer]) => {
      this.fileCache.set(url, buffer);
    });
  }
}
```

### 3. 多线程渲染优化（本地应用）

```typescript
// 本地应用可以使用更多 Worker
const LOCAL_WORKER_CONFIG = {
  // 根据 CPU 核心数创建 Worker
  workerCount: Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
  
  // 每个 Worker 的任务队列大小
  maxQueueSize: 10,
  
  // Worker 负载均衡策略
  loadBalanceStrategy: 'least-loaded' as const, // 'round-robin' | 'least-loaded'
};

class LocalAppWorkerPool {
  private workers: OffscreenWorkerManager[] = [];
  private roundRobinIndex = 0;

  constructor() {
    this.initializeWorkers();
  }

  private initializeWorkers(): void {
    const workerCount = LOCAL_WORKER_CONFIG.workerCount;
    
    for (let i = 0; i < workerCount; i++) {
      const worker = new OffscreenWorkerManager(i);
      this.workers.push(worker);
    }
  }

  async renderPage(request: PageRenderRequest): Promise<ImageBitmap> {
    const worker = this.selectOptimalWorker();
    return worker.renderPage(request);
  }

  private selectOptimalWorker(): OffscreenWorkerManager {
    switch (LOCAL_WORKER_CONFIG.loadBalanceStrategy) {
      case 'round-robin':
        const worker = this.workers[this.roundRobinIndex];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % this.workers.length;
        return worker;
        
      case 'least-loaded':
        return this.workers.reduce((optimal, current) => 
          current.getLoadScore() < optimal.getLoadScore() ? current : optimal
        );
        
      default:
        return this.workers[0];
    }
  }
}
```

### 4. 本地存储优化

```typescript
// 利用本地应用的持久化存储
export class LocalAppPersistence {
  private storageKey = 'pdf-viewer-cache';

  // 持久化瓦片缓存到本地存储
  async persistTileCache(cache: Map<string, ImageBitmap>): Promise<void> {
    const serializable = Array.from(cache.entries()).map(async ([key, bitmap]) => {
      // 将 ImageBitmap 转换为可存储的格式
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(bitmap, 0, 0);
      
      const blob = await canvas.convertToBlob();
      const buffer = await blob.arrayBuffer();
      
      return [key, {
        width: bitmap.width,
        height: bitmap.height,
        data: Array.from(new Uint8Array(buffer))
      }];
    });

    const data = await Promise.all(serializable);
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  // 从本地存储恢复瓦片缓存
  async restoreTileCache(): Promise<Map<string, ImageBitmap>> {
    const cache = new Map<string, ImageBitmap>();
    
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) return cache;

      const data = JSON.parse(stored);
      
      for (const [key, tileData] of data) {
        const buffer = new Uint8Array(tileData.data).buffer;
        const blob = new Blob([buffer]);
        const bitmap = await createImageBitmap(blob);
        cache.set(key, bitmap);
      }
    } catch (error) {
      console.warn('Failed to restore tile cache:', error);
    }

    return cache;
  }
}
```

### 5. 性能监控增强

```typescript
// 本地应用特定的性能监控
export class LocalAppPerformanceMonitor {
  private metrics = {
    systemResources: {
      cpuUsage: [] as number[],
      memoryUsage: [] as number[],
      diskIO: [] as number[]
    },
    renderingPerformance: {
      tileLoadTime: new Map<string, number>(),
      renderTime: [] as number[],
      concurrencyEfficiency: [] as number[]
    }
  };

  startMonitoring(): void {
    // 监控系统资源使用
    setInterval(() => {
      this.collectSystemMetrics();
    }, 1000);

    // 监控渲染性能
    this.setupRenderingMetrics();
  }

  private collectSystemMetrics(): void {
    // 使用 Performance Observer API
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      this.metrics.systemResources.memoryUsage.push(memory.usedJSHeapSize);
    }
  }

  generateLocalAppReport(): LocalAppPerformanceReport {
    return {
      systemResourceUtilization: this.calculateResourceUtilization(),
      concurrencyEfficiency: this.calculateConcurrencyEfficiency(),
      localFileAccessPerformance: this.calculateFileAccessPerformance(),
      recommendations: this.generateOptimizationRecommendations()
    };
  }

  private generateOptimizationRecommendations(): string[] {
    const recommendations: string[] = [];
    
    const avgMemoryUsage = this.getAverageMemoryUsage();
    if (avgMemoryUsage < 0.5) {
      recommendations.push('可以增加缓存大小以提升性能');
    }

    const concurrencyEfficiency = this.calculateConcurrencyEfficiency();
    if (concurrencyEfficiency < 0.8) {
      recommendations.push('考虑调整并发数配置');
    }

    return recommendations;
  }
}
```

## 配置建议总结

### 推荐配置（本地应用）
```typescript
export const LOCAL_APP_OPTIMIZED_CONFIG = {
  // 瓦片加载
  MAX_CONCURRENCY: 16, // 已更新
  TILE_CACHE_SIZE: 200 * 1024 * 1024, // 200MB
  
  // 预加载
  PRELOAD_PAGES_AHEAD: 4,
  PRELOAD_TILES_COUNT: 100,
  
  // Worker 配置
  WORKER_COUNT: Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
  MAX_WORKER_QUEUE_SIZE: 10,
  
  // 内存管理
  MAX_BITMAP_CACHE: 1000,
  MEMORY_PRESSURE_THRESHOLD: 0.8,
  
  // 本地文件优化
  FILE_PRELOAD_ENABLED: true,
  FILE_CACHE_SIZE: 50 * 1024 * 1024, // 50MB
};
```

### 动态配置调整
```typescript
// 根据文档大小和系统性能动态调整
export const getAdaptiveConfig = (
  documentSize: number,
  systemSpecs: SystemSpecs
): LocalAppConfig => {
  const baseConfig = LOCAL_APP_OPTIMIZED_CONFIG;
  
  // 大文档使用更高并发
  if (documentSize > 100 * 1024 * 1024) { // >100MB
    return {
      ...baseConfig,
      MAX_CONCURRENCY: Math.min(32, systemSpecs.cpuCores * 6),
      TILE_CACHE_SIZE: Math.min(500 * 1024 * 1024, systemSpecs.memoryGB * 100 * 1024 * 1024),
    };
  }
  
  return baseConfig;
};
```

## 实施优先级

### 高优先级（立即实施）
1. ✅ **并发数调整**: 8 → 16（已完成）
2. **缓存大小优化**: 提升到 200MB
3. **预加载页面数**: 增加到 4 页

### 中优先级（短期实施）
1. **系统资源感知配置**: 动态调整参数
2. **本地文件预加载**: 利用本地文件系统优势
3. **多 Worker 优化**: 根据 CPU 核心数创建 Worker

### 低优先级（长期规划）
1. **持久化缓存**: 本地存储瓦片缓存
2. **高级性能监控**: 系统资源监控
3. **自适应配置**: 根据文档特性动态调整

---

*本地应用优化方案版本: v1.0*  
*更新日期: 2024年* 