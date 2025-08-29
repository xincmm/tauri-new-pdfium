// 瓦片加载任务接口
export interface LoadTask {
  id: string;
  priority: number; // 数字越小优先级越高
  pageIndex: number;
  epoch: number; // 新增：任务的时代标记
  bucketKey: string; // 新增：桶标识，用于去重
  execute: () => Promise<void>;
  cancel?: () => void;
}

// 任务唯一键生成
function generateTaskKey(pageIndex: number, bucketKey: string): string {
  return `${pageIndex}-${bucketKey}`;
}

// 优先级任务队列 - 重构版本
export class PriorityTaskQueue {
  private tasks = new Map<string, LoadTask>(); // 改为Map实现去重
  private runningTasks = 0;
  private readonly maxConcurrency: number;
  private focusPageIndex: number | null = null;
  private currentEpoch = 0; // 当前时代
  
  constructor(maxConcurrency: number = 8) { // 降低并发数
    this.maxConcurrency = maxConcurrency;
  }
  
  // 推进时代 - 只在队列过载时调用
  advanceEpoch(): number {
    this.currentEpoch++;
    console.log(`📅 任务队列推进到 Epoch ${this.currentEpoch}`);
    
    // 清理过时的任务
    this.cleanupStaleEpochTasks();
    return this.currentEpoch;
  }
  
  // 检查是否需要紧急清理（队列过载）
  checkAndEmergencyCleanup(visiblePageIndices: number[] = []): boolean {
    const totalTasks = this.tasks.size + this.runningTasks;
    const EMERGENCY_THRESHOLD = 50; // 超过50个任务时紧急清理
    
    if (totalTasks > EMERGENCY_THRESHOLD) {
      console.log(`🚨 队列过载 (${totalTasks} 任务)，执行紧急清理`);
      this.advanceEpoch(); // 推进Epoch
      this.smartCleanupStaleEpochTasks(visiblePageIndices);
      return true;
    }
    return false;
  }
  
  // 获取当前时代
  getCurrentEpoch(): number {
    return this.currentEpoch;
  }
  
  // 清理过时的任务 - 使用智能清理策略
  private cleanupStaleEpochTasks() {
    // 默认使用智能清理，不传递可见页面信息（由外部调用者决定）
    this.smartCleanupStaleEpochTasks();
  }
  
  // 设置焦点页面，会重新排序任务优先级
  setFocusPage(pageIndex: number | null) {
    if (this.focusPageIndex === pageIndex) return;
    
    this.focusPageIndex = pageIndex;
    this.pumpQueue();
  }
  
  // 添加任务 - 实现去重和时代检查
  addTask(task: LoadTask) {
    // 完全禁用Epoch检查 - 让所有瓦片都能加载
    // Epoch机制导致瓦片被取消后无法重新加载，暂时完全禁用
    
    // 调试：记录任务添加 - 减少频率
    if (Math.random() < 0.1) { // 只打印10%的任务
      console.log(`✅ 添加任务 (Epoch ${task.epoch}, current=${this.currentEpoch}): ${task.id}`);
    }
    
    const taskKey = generateTaskKey(task.pageIndex, task.bucketKey);
    
    // 如果已存在相同的任务，替换为优先级更高的
    if (this.tasks.has(taskKey)) {
      const existingTask = this.tasks.get(taskKey)!;
      if (task.priority >= existingTask.priority && task.epoch <= existingTask.epoch) {
        // 新任务优先级不高且时代不新，忽略
        return;
      }
      // 取消旧任务
      existingTask.cancel?.();
    }
    
    // 如果是焦点页面的任务，提高优先级
    if (this.focusPageIndex !== null && task.pageIndex === this.focusPageIndex) {
      task.priority = Math.max(0, task.priority - 1000); // 大幅提升优先级
    }
    
    this.tasks.set(taskKey, task);
    this.pumpQueue();
  }
  
  // 取消非焦点页面的任务
  cancelNonFocusTasks() {
    if (this.focusPageIndex === null) return;
    
    let cancelledCount = 0;
    const tasksToCancel: string[] = [];
    
    // 收集需要取消的任务
    this.tasks.forEach((task, key) => {
      if (task.pageIndex !== this.focusPageIndex) {
        task.cancel?.();
        tasksToCancel.push(key);
        cancelledCount++;
      }
    });
    
    // 移除取消的任务
    tasksToCancel.forEach(key => this.tasks.delete(key));
    
    if (cancelledCount > 0) {
      console.log(`🗑️ 取消了 ${cancelledCount} 个非焦点页面任务`);
    }
  }
  
  // 批量取消指定页面范围外的任务
  cancelTasksOutsidePageRange(minPage: number, maxPage: number) {
    let cancelledCount = 0;
    const tasksToCancel: string[] = [];
    
    this.tasks.forEach((task, key) => {
      if (task.pageIndex < minPage || task.pageIndex > maxPage) {
        task.cancel?.();
        tasksToCancel.push(key);
        cancelledCount++;
      }
    });
    
    tasksToCancel.forEach(key => this.tasks.delete(key));
    
    if (cancelledCount > 0) {
      console.log(`🗑️ 取消了页面范围 [${minPage}, ${maxPage}] 外的 ${cancelledCount} 个任务`);
    }
  }
  
  // 智能清理：只清理远离当前视口的过时任务
  smartCleanupStaleEpochTasks(visiblePageIndices: number[] = []) {
    let cleanedCount = 0;
    const currentTasks = Array.from(this.tasks.values());
    
    for (const task of currentTasks) {
      if (task.epoch < this.currentEpoch) {
        // 如果是可见页面的任务，保留一段时间
        const isVisiblePageTask = visiblePageIndices.includes(task.pageIndex);
        const epochGap = this.currentEpoch - task.epoch;
        
        // 可见页面任务：允许2个epoch的延迟，非可见页面任务：立即清理
        const shouldCleanup = isVisiblePageTask ? epochGap > 2 : epochGap > 0;
        
        if (shouldCleanup) {
          task.cancel?.();
          this.tasks.delete(generateTaskKey(task.pageIndex, task.bucketKey));
          cleanedCount++;
        }
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 智能清理了 ${cleanedCount} 个过时任务 (保护了可见页面)`);
      this.pumpQueue();
    }
  }
  
  // 获取排序后的任务列表
  private getSortedTasks(): LoadTask[] {
    const taskArray = Array.from(this.tasks.values());
    
    return taskArray.sort((a, b) => {
      // 1. 时代优先（新时代优先）
      if (a.epoch !== b.epoch) {
        return b.epoch - a.epoch;
      }
      
      // 2. 焦点页面优先
      if (this.focusPageIndex !== null) {
        const aIsFocus = a.pageIndex === this.focusPageIndex;
        const bIsFocus = b.pageIndex === this.focusPageIndex;
        if (aIsFocus && !bIsFocus) return -1;
        if (bIsFocus && !aIsFocus) return 1;
      }
      
      // 3. 按优先级排序
      return a.priority - b.priority;
    });
  }
  
  // 执行任务队列
  private pumpQueue() {
    const sortedTasks = this.getSortedTasks();
    
    while (this.runningTasks < this.maxConcurrency && sortedTasks.length > 0) {
      const task = sortedTasks.shift()!;
      
      // 再次检查任务是否过时
      if (task.epoch < this.currentEpoch) {
        const taskKey = generateTaskKey(task.pageIndex, task.bucketKey);
        this.tasks.delete(taskKey);
        continue;
      }
      
      // 从Map中移除任务
      const taskKey = generateTaskKey(task.pageIndex, task.bucketKey);
      this.tasks.delete(taskKey);
      
      this.runningTasks++;
      
      task.execute().finally(() => {
        this.runningTasks--;
        this.pumpQueue();
      });
    }
  }
  
  // 获取队列状态
  getQueueStatus() {
    return {
      pending: this.tasks.size,
      running: this.runningTasks,
      focusPage: this.focusPageIndex,
      currentEpoch: this.currentEpoch,
      maxConcurrency: this.maxConcurrency
    };
  }
  
  // 强制清空所有任务
  clearAllTasks() {
    const cancelledCount = this.tasks.size;
    this.tasks.forEach(task => task.cancel?.());
    this.tasks.clear();
    
    if (cancelledCount > 0) {
      console.log(`🗑️ 强制清空了 ${cancelledCount} 个任务`);
    }
  }
} 