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
  maxConcurrency: number; // 最大并发数，建议4-6
  workerPath: string;
}

// 任务信息接口
interface TaskInfo {
  id: string;
  url: string;
  priority: number;
  epoch: number; // 新增：任务时代
  options?: RequestInit;
}

export class WorkerTileLoader {
  private worker: Worker | null = null;
  private pendingTasks = new Map<string, {
    resolve: (result: TileLoadResult) => void;
    reject: (error: Error) => void;
    epoch: number; // 任务时代
  }>();
  private activeTasks = new Set<string>();
  private taskQueue: TaskInfo[] = [];
  private currentEpoch = 0; // 当前时代
  
  private config: WorkerTileLoaderConfig;
  private isDestroyed = false;

  constructor(config: WorkerTileLoaderConfig) {
    this.config = config;
    this.initWorker();
  }

  // 推进时代
  advanceEpoch(): number {
    this.currentEpoch++;
    console.log(`🔄 WorkerTileLoader 推进到 Epoch ${this.currentEpoch}`);
    
    // 清理过时的任务
    this.cleanupStaleEpochTasks();
    return this.currentEpoch;
  }

  // 获取当前时代
  getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  // 清理过时的任务
  private cleanupStaleEpochTasks() {
    let cleanedCount = 0;
    
    // 清理队列中的过时任务
    const originalQueueLength = this.taskQueue.length;
    this.taskQueue = this.taskQueue.filter(task => task.epoch >= this.currentEpoch);
    cleanedCount += originalQueueLength - this.taskQueue.length;
    
    // 清理pending任务中的过时任务
    const pendingToCancel: string[] = [];
    this.pendingTasks.forEach((task, id) => {
      if (task.epoch < this.currentEpoch) {
        pendingToCancel.push(id);
      }
    });
    
    // 取消过时的pending任务
    pendingToCancel.forEach(id => {
      const task = this.pendingTasks.get(id);
      if (task) {
        task.reject(new Error(`Task cancelled due to epoch change (${task.epoch} < ${this.currentEpoch})`));
        this.pendingTasks.delete(id);
        cleanedCount++;
      }
      
      // 如果任务正在执行，通知Worker取消
      if (this.activeTasks.has(id)) {
        this.worker?.postMessage({
          type: 'cancel-task',
          id
        });
        this.activeTasks.delete(id);
      }
    });
    
    if (cleanedCount > 0) {
      console.log(`🗑️ WorkerTileLoader 清理了 ${cleanedCount} 个过时任务`);
    }
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
      // 检查任务是否已过时
      if (task.epoch < this.currentEpoch) {
        console.log(`⏰ 丢弃过时结果 (Epoch ${task.epoch} < ${this.currentEpoch}): ${id}`);
        // 释放ImageBitmap资源
        imageBitmap.close();
        this.pendingTasks.delete(id);
      } else {
        task.resolve({ imageBitmap, performance });
        this.pendingTasks.delete(id);
      }
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
    // 处理队列中的任务，按优先级和时代排序
    if (this.activeTasks.size >= this.config.maxConcurrency || this.taskQueue.length === 0) {
      return;
    }

    // 按时代和优先级排序（新时代优先，然后是优先级）
    this.taskQueue.sort((a, b) => {
      if (a.epoch !== b.epoch) {
        return b.epoch - a.epoch; // 新时代优先
      }
      return a.priority - b.priority; // 数值越小优先级越高
    });
    
    const task = this.taskQueue.shift();
    if (!task) return;

    // 再次检查任务是否过时
    if (task.epoch < this.currentEpoch) {
      console.log(`⏰ 队列中发现过时任务，跳过: ${task.id} (Epoch ${task.epoch} < ${this.currentEpoch})`);
      this.processQueue(); // 继续处理下一个任务
      return;
    }

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
    epoch: number = this.currentEpoch, // 新增epoch参数
    options?: RequestInit
  ): Promise<TileLoadResult> {
    if (this.isDestroyed) {
      return Promise.reject(new Error('WorkerTileLoader is destroyed'));
    }

    // 完全禁用Epoch检查 - 让所有瓦片都能加载
    // Epoch机制导致瓦片被取消后无法重新加载，暂时完全禁用
    
    // 调试：记录Worker任务 - 减少频率
    if (Math.random() < 0.1) { // 只打印10%的任务
      console.log(`🔄 Worker加载任务 (Epoch ${epoch}, current=${this.currentEpoch}): ${id}`);
    }

    // 如果已经在处理中，检查epoch
    if (this.pendingTasks.has(id)) {
      const existing = this.pendingTasks.get(id)!;
      if (existing.epoch >= epoch) {
        // 现有任务的epoch更新或相同，返回现有Promise
        return new Promise((resolve, reject) => {
          const originalResolve = existing.resolve;
          const originalReject = existing.reject;
          this.pendingTasks.set(id, {
            resolve: (result) => {
              originalResolve(result);
              resolve(result);
            },
            reject: (error) => {
              originalReject(error);
              reject(error);
            },
            epoch: existing.epoch
          });
        });
      } else {
        // 新任务epoch更新，取消旧任务
        existing.reject(new Error('Replaced by newer epoch task'));
      }
    }

    return new Promise((resolve, reject) => {
      this.pendingTasks.set(id, { resolve, reject, epoch });
      
      // 添加到队列（带去重检查）
      const existingTaskIndex = this.taskQueue.findIndex(task => task.id === id);
      if (existingTaskIndex >= 0) {
        // 替换现有任务
        this.taskQueue[existingTaskIndex] = { id, url, priority, epoch, options };
      } else {
        // 添加新任务
        this.taskQueue.push({ id, url, priority, epoch, options });
      }
      
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
    
    if (toCancel.length > 0) {
      console.log(`🗑️ Cancelled ${toCancel.length} distant tasks`);
    }
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
      maxConcurrency: this.config.maxConcurrency,
      currentEpoch: this.currentEpoch
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