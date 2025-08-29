/**
 * Worker-based Tile Loader
 * 把网络请求和图像解码搬到Worker中，避免主线程阻塞
 */

export interface TileLoadResult {
  imageBitmap: ImageBitmap;
  performance: {
    fetchTime: number;
    decodeTime: number;
    totalTime: number;
    size: number;
    serverTiming?: Record<string, number>;
    pixelInfo?: { width: number; height: number };
  };
}

export interface WorkerTileLoaderConfig {
  maxConcurrency: number; // 最大并发数，建议6-8
  workerPath: string;
}

export class WorkerTileLoader {
  private worker: Worker | null = null;
  private pendingTasks = new Map<string, {
    resolve: (result: TileLoadResult) => void;
    reject: (error: Error) => void;
  }>();
  private activeTasks = new Set<string>();
  private taskQueue: Array<{
    id: string;
    url: string;
    priority: number;
    options?: RequestInit;
  }> = [];
  
  private config: WorkerTileLoaderConfig;
  private isDestroyed = false;

  constructor(config: WorkerTileLoaderConfig) {
    this.config = config;
    this.initWorker();
  }

  private initWorker() {
    try {
      this.worker = new Worker(this.config.workerPath);
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);
      
      console.log('🚀 WorkerTileLoader initialized with max concurrency:', this.config.maxConcurrency);
    } catch (error) {
      console.error('Failed to create worker:', error);
      throw error;
    }
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { type, id, imageBitmap, performance, error } = event.data;
    
    switch (type) {
      case 'tile-loaded':
        this.handleTileLoaded(id, imageBitmap, performance);
        break;
        
      case 'tile-error':
        this.handleTileError(id, error);
        break;
        
      case 'tile-cancelled':
        this.handleTileCancelled(id);
        break;
        
      case 'performance':
        // Worker中的性能数据，可以用于调试
        console.log('📊 Worker Performance:', event.data.data);
        break;
        
      case 'fetch-test-result':
        this.handleFetchTestResult(event.data);
        break;
        
      default:
        console.warn('Unknown worker message type:', type);
    }
  }

  private handleWorkerError(error: ErrorEvent) {
    console.error('Worker error:', error);
    // 清理所有待处理的任务
    this.pendingTasks.forEach(({ reject }) => {
      reject(new Error('Worker error: ' + error.message));
    });
    this.pendingTasks.clear();
    this.activeTasks.clear();
  }

  private handleTileLoaded(id: string, imageBitmap: ImageBitmap, performance: any) {
    const task = this.pendingTasks.get(id);
    if (task) {
      task.resolve({ imageBitmap, performance });
      this.pendingTasks.delete(id);
    }
    
    this.activeTasks.delete(id);
    this.processQueue();
  }

  private handleTileError(id: string, errorMessage: string) {
    const task = this.pendingTasks.get(id);
    if (task) {
      task.reject(new Error(errorMessage));
      this.pendingTasks.delete(id);
    }
    
    this.activeTasks.delete(id);
    this.processQueue();
  }

  private handleTileCancelled(id: string) {
    const task = this.pendingTasks.get(id);
    if (task) {
      task.reject(new Error('Task cancelled'));
      this.pendingTasks.delete(id);
    }
    
    this.activeTasks.delete(id);
    this.processQueue();
  }

  private handleFetchTestResult(data: any) {
    console.log('🔍 Fetch Test Result:', data);
  }

  private processQueue() {
    // 处理队列中的任务，按优先级排序
    if (this.activeTasks.size >= this.config.maxConcurrency || this.taskQueue.length === 0) {
      return;
    }

    // 按优先级排序（数值越小优先级越高）
    this.taskQueue.sort((a, b) => a.priority - b.priority);
    
    const task = this.taskQueue.shift();
    if (!task) return;

    this.activeTasks.add(task.id);
    
    if (this.worker) {
      this.worker.postMessage({
        type: 'load-tile',
        id: task.id,
        url: task.url,
        options: task.options || {}
      });
    }
    
    // 继续处理队列
    setTimeout(() => this.processQueue(), 0);
  }

  /**
   * 加载瓦片
   */
  loadTile(
    id: string, 
    url: string, 
    priority: number = 100,
    options?: RequestInit
  ): Promise<TileLoadResult> {
    if (this.isDestroyed) {
      return Promise.reject(new Error('WorkerTileLoader is destroyed'));
    }

    // 如果已经在处理中，返回现有的Promise
    if (this.pendingTasks.has(id)) {
      return new Promise((resolve, reject) => {
        const existing = this.pendingTasks.get(id)!;
        this.pendingTasks.set(id, {
          resolve: (result) => {
            existing.resolve(result);
            resolve(result);
          },
          reject: (error) => {
            existing.reject(error);
            reject(error);
          }
        });
      });
    }

    return new Promise((resolve, reject) => {
      this.pendingTasks.set(id, { resolve, reject });
      
      // 添加到队列
      this.taskQueue.push({ id, url, priority, options });
      
      // 立即尝试处理队列
      this.processQueue();
    });
  }

  /**
   * 取消任务
   */
  cancelTask(id: string) {
    // 从队列中移除
    this.taskQueue = this.taskQueue.filter(task => task.id !== id);
    
    // 如果正在执行，通知Worker取消
    if (this.activeTasks.has(id)) {
      this.worker?.postMessage({
        type: 'cancel-task',
        id
      });
    }
    
    // 清理pending任务
    const task = this.pendingTasks.get(id);
    if (task) {
      task.reject(new Error('Task cancelled'));
      this.pendingTasks.delete(id);
    }
  }

  /**
   * 取消所有距离视口较远的任务
   */
  cancelDistantTasks(keepIds: Set<string>) {
    const toCancel: string[] = [];
    
    // 收集需要取消的任务ID
    this.pendingTasks.forEach((_, id) => {
      if (!keepIds.has(id)) {
        toCancel.push(id);
      }
    });
    
    // 取消这些任务
    toCancel.forEach(id => this.cancelTask(id));
    
    console.log(`🗑️ Cancelled ${toCancel.length} distant tasks`);
  }

  /**
   * 性能测试：对比Worker和主线程的fetch性能
   */
  async testFetchPerformance(url: string): Promise<void> {
    if (!this.worker) return;
    
    const testId = 'fetch-test-' + Date.now();
    this.worker.postMessage({
      type: 'fetch-test',
      id: testId,
      url
    });
  }

  /**
   * 获取状态信息
   */
  getStatus() {
    return {
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      pendingTasks: this.pendingTasks.size,
      maxConcurrency: this.config.maxConcurrency
    };
  }

  /**
   * 销毁Worker和清理资源
   */
  destroy() {
    this.isDestroyed = true;
    
    // 取消所有待处理的任务
    this.pendingTasks.forEach(({ reject }) => {
      reject(new Error('WorkerTileLoader destroyed'));
    });
    this.pendingTasks.clear();
    this.activeTasks.clear();
    this.taskQueue = [];
    
    // 终止Worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    
    console.log('🗑️ WorkerTileLoader destroyed');
  }
} 