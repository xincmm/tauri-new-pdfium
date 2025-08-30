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
  maxConcurrency: number; // 最大并发数，建议6-8，默认6
  workerPath: string;
}

export class WorkerTileLoader {
  private worker: Worker | null = null;
  private pendingTasks = new Map<
    string,
    {
      resolve: (result: TileLoadResult) => void;
      reject: (error: Error) => void;
      epoch?: number;
    }
  >();
  private activeTasks = new Set<string>();
  private taskQueue: Array<{
    id: string;
    url: string;
    priority: number;
    epoch: number;
    options?: RequestInit;
  }> = [];

  private config: WorkerTileLoaderConfig;
  private isDestroyed = false;
  private currentEpoch = 0;

  constructor(config: WorkerTileLoaderConfig) {
    this.config = config;
    this.initWorker();
  }

  private initWorker() {
    try {
      this.worker = new Worker(this.config.workerPath);
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);

      console.log("🚀 WorkerTileLoader initialized with max concurrency:", this.config.maxConcurrency);
    } catch (error) {
      console.error("Failed to create worker:", error);
      throw error;
    }
  }

  /**
   * Reconcile方法：以集合对账的方式管理Worker任务
   */
  reconcile(
    neededTasks: Array<{
      id: string;
      url: string;
      priority: number;
      options?: RequestInit;
    }>,
    reason: string = "viewport-change",
  ) {
    // 推进epoch
    this.currentEpoch++;

    console.log(`🔄 Worker任务对账 Epoch ${this.currentEpoch} (${reason}): 需要${neededTasks.length}个任务`);

    // 第一关口：清理队列中不在本次需求中的任务
    const neededIds = new Set(neededTasks.map((t) => t.id));
    const removedTasks: string[] = [];

    this.taskQueue = this.taskQueue.filter((task) => {
      if (!neededIds.has(task.id) || task.epoch !== this.currentEpoch) {
        removedTasks.push(task.id);
        return false;
      }
      return true;
    });

    // 取消不需要的pending任务
    for (const [id, task] of this.pendingTasks) {
      if (!neededIds.has(id) || (task.epoch && task.epoch !== this.currentEpoch)) {
        this.cancelTask(id);
        removedTasks.push(id);
      }
    }

    if (removedTasks.length > 0) {
      console.log(`🗑️ Worker清理任务: ${removedTasks.length}个`);
    }

    // 添加新需要的任务
    for (const taskSpec of neededTasks) {
      // 检查是否已在队列中
      const existingIndex = this.taskQueue.findIndex((t) => t.id === taskSpec.id);

      const task = {
        ...taskSpec,
        epoch: this.currentEpoch,
      };

      if (existingIndex >= 0) {
        // 更新现有任务
        this.taskQueue[existingIndex] = task;
      } else {
        // 添加新任务
        this.taskQueue.push(task);
      }
    }

    // 立即处理队列
    this.processQueue();

    console.log(
      `✅ Worker对账完成: 队列${this.taskQueue.length}个, 活动${this.activeTasks.size}个/${this.config.maxConcurrency}`,
    );
  }

  // 获取当前epoch
  getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { type, id, imageBitmap, performance, error, epoch } = event.data;

    switch (type) {
      case "tile-loaded":
        this.handleTileLoaded(id, imageBitmap, performance, epoch);
        break;

      case "tile-error":
        this.handleTileError(id, error);
        break;

      case "tile-cancelled":
        this.handleTileCancelled(id);
        break;

      case "performance":
        // Worker中的性能数据，可以用于调试
        console.log("📊 Worker Performance:", event.data.data);
        break;

      case "fetch-test-result":
        this.handleFetchTestResult(event.data);
        break;

      default:
        console.warn("Unknown worker message type:", type);
    }
  }

  private handleWorkerError(error: ErrorEvent) {
    console.error("Worker error:", error);
    // 清理所有待处理的任务
    this.pendingTasks.forEach(({ reject }) => {
      reject(new Error("Worker error: " + error.message));
    });
    this.pendingTasks.clear();
    this.activeTasks.clear();
  }

  private handleTileLoaded(id: string, imageBitmap: ImageBitmap, performance: any, epoch?: number) {
    const task = this.pendingTasks.get(id);
    if (task) {
      // 第三关口：上屏前检查epoch有效性
      if (task.epoch && epoch && task.epoch !== epoch) {
        console.log(`🚫 Worker结果已过期，丢弃: ${id} (结果Epoch ${epoch} vs 任务Epoch ${task.epoch})`);
        imageBitmap?.close?.(); // 释放ImageBitmap
        task.reject(new Error("Result epoch mismatch"));
      } else if (task.epoch && task.epoch !== this.currentEpoch) {
        console.log(`🚫 Worker结果已过期，丢弃: ${id} (任务Epoch ${task.epoch} vs 当前Epoch ${this.currentEpoch})`);
        imageBitmap?.close?.(); // 释放ImageBitmap
        task.reject(new Error("Result epoch obsolete"));
      } else {
        task.resolve({ imageBitmap, performance });
      }
      this.pendingTasks.delete(id);
    } else {
      // 如果没有对应的pending任务，可能已经被取消，直接释放bitmap
      console.log(`🚫 Worker结果无对应任务，丢弃: ${id}`);
      imageBitmap?.close?.();
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
      task.reject(new Error("Task cancelled"));
      this.pendingTasks.delete(id);
    }

    this.activeTasks.delete(id);
    this.processQueue();
  }

  private handleFetchTestResult(data: any) {
    console.log("🔍 Fetch Test Result:", data);
  }

  private processQueue() {
    // 处理队列中的任务，按优先级排序
    if (this.activeTasks.size >= this.config.maxConcurrency || this.taskQueue.length === 0) {
      return;
    }

    // 按优先级排序（数值越小优先级越高）
    this.taskQueue.sort((a, b) => {
      // Epoch检查优先
      if (a.epoch !== b.epoch) {
        return b.epoch - a.epoch; // 新epoch优先
      }
      return a.priority - b.priority;
    });

    const task = this.taskQueue.shift();
    if (!task) return;

    // 第二关口：开跑前检查epoch有效性
    if (task.epoch !== this.currentEpoch) {
      console.log(`🚫 Worker任务已过期，跳过执行: ${task.id} (Epoch ${task.epoch} vs ${this.currentEpoch})`);
      // 继续处理队列
      setTimeout(() => this.processQueue(), 0);
      return;
    }

    this.activeTasks.add(task.id);

    if (this.worker) {
      this.worker.postMessage({
        type: "load-tile",
        id: task.id,
        url: task.url,
        epoch: task.epoch, // 传递epoch给worker
        options: task.options || {},
      });
    }

    // 继续处理队列
    setTimeout(() => this.processQueue(), 0);
  }

  /**
   * 加载瓦片 - 保持兼容性，建议使用reconcile
   */
  loadTile(
    id: string,
    url: string,
    priority: number = 100,
    options?: RequestInit,
    epoch?: number,
  ): Promise<TileLoadResult> {
    if (this.isDestroyed) {
      return Promise.reject(new Error("WorkerTileLoader is destroyed"));
    }

    // 使用传入的epoch或当前epoch
    const taskEpoch = epoch ?? this.currentEpoch;

    // 如果已经在处理中，返回现有的Promise
    if (this.pendingTasks.has(id)) {
      const existing = this.pendingTasks.get(id)!;
      // 更新epoch
      existing.epoch = taskEpoch;

      return new Promise((resolve, reject) => {
        this.pendingTasks.set(id, {
          resolve: (result) => {
            existing.resolve(result);
            resolve(result);
          },
          reject: (error) => {
            existing.reject(error);
            reject(error);
          },
          epoch: taskEpoch,
        });
      });
    }

    return new Promise((resolve, reject) => {
      this.pendingTasks.set(id, { resolve, reject, epoch: taskEpoch });

      // 添加到队列
      this.taskQueue.push({ id, url, priority, epoch: taskEpoch, options });

      // 立即尝试处理队列
      this.processQueue();
    });
  }

  /**
   * 取消任务
   */
  cancelTask(id: string) {
    // 从队列中移除
    this.taskQueue = this.taskQueue.filter((task) => task.id !== id);

    // 如果正在执行，通知Worker取消
    if (this.activeTasks.has(id)) {
      this.worker?.postMessage({
        type: "cancel-task",
        id,
      });
    }

    // 清理pending任务
    const task = this.pendingTasks.get(id);
    if (task) {
      task.reject(new Error("Task cancelled"));
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
    toCancel.forEach((id) => this.cancelTask(id));

    console.log(`🗑️ Cancelled ${toCancel.length} distant tasks`);
  }

  /**
   * 性能测试：对比Worker和主线程的fetch性能
   */
  async testFetchPerformance(url: string): Promise<void> {
    if (!this.worker) return;

    const testId = "fetch-test-" + Date.now();
    this.worker.postMessage({
      type: "fetch-test",
      id: testId,
      url,
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
    };
  }

  /**
   * 销毁Worker和清理资源
   */
  destroy() {
    this.isDestroyed = true;

    // 取消所有待处理的任务
    this.pendingTasks.forEach(({ reject }) => {
      reject(new Error("WorkerTileLoader destroyed"));
    });
    this.pendingTasks.clear();
    this.activeTasks.clear();
    this.taskQueue = [];

    // 终止Worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    console.log("🗑️ WorkerTileLoader destroyed");
  }
}
