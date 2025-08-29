// 瓦片加载任务接口
export interface LoadTask {
  id: string;
  priority: number; // 数字越小优先级越高
  pageIndex: number;
  epoch: number; // 新增：任务epoch
  execute: () => Promise<void>;
  cancel?: () => void;
}

// 任务集合接口 - 用于reconcile
export interface TaskSpec {
  id: string;
  priority: number;
  pageIndex: number;
  execute: () => Promise<void>;
  cancel?: () => void;
}

// 优先级任务队列
export class PriorityTaskQueue {
  private tasks: LoadTask[] = [];
  private runningTasks = 0;
  private readonly maxConcurrency: number;
  private focusPageIndex: number | null = null;
  private currentEpoch: number = 0; // 当前epoch
  
  constructor(maxConcurrency: number = 6) { // 降低默认并发数到6
    this.maxConcurrency = maxConcurrency;
  }
  
  // 获取当前epoch
  getCurrentEpoch(): number {
    return this.currentEpoch;
  }
  
  // 设置焦点页面，会重新排序任务优先级
  setFocusPage(pageIndex: number | null) {
    if (this.focusPageIndex === pageIndex) return;
    
    this.focusPageIndex = pageIndex;
    this.reorderTasks();
    this.pumpQueue();
  }
  
  /**
   * Reconcile方法：以集合对账的方式管理任务
   * 这是epoch机制的核心：只保留当前需要的任务，丢弃所有历史债务
   */
  reconcile(neededTasks: TaskSpec[], reason: string = 'viewport-change') {
    // 每次reconcile都推进epoch
    this.currentEpoch++;
    
    console.log(`📋 任务对账 Epoch ${this.currentEpoch} (${reason}): 需要${neededTasks.length}个任务`);
    
    // 第一关口：清理队列中不在本次需求中的任务
    const neededIds = new Set(neededTasks.map(t => t.id));
    const removedTasks: string[] = [];
    
    this.tasks = this.tasks.filter(task => {
      if (!neededIds.has(task.id) || task.epoch !== this.currentEpoch) {
        task.cancel?.();
        removedTasks.push(task.id);
        return false;
      }
      return true;
    });
    
    if (removedTasks.length > 0) {
      console.log(`🗑️ 清理队列任务: ${removedTasks.length}个 (${removedTasks.slice(0, 3).join(', ')}...)`);
    }
    
    // 将新任务添加到队列（去重：新任务覆盖旧排队项）
    for (const taskSpec of neededTasks) {
      // 检查是否已在队列中
      const existingIndex = this.tasks.findIndex(t => t.id === taskSpec.id);
      
      const task: LoadTask = {
        ...taskSpec,
        epoch: this.currentEpoch
      };
      
      // 焦点页面优先级提升
      if (this.focusPageIndex !== null && task.pageIndex === this.focusPageIndex) {
        task.priority = Math.max(0, task.priority - 1000);
      }
      
      if (existingIndex >= 0) {
        // 更新现有任务
        this.tasks[existingIndex] = task;
      } else {
        // 添加新任务
        this.tasks.push(task);
      }
    }
    
    this.reorderTasks();
    this.pumpQueue();
    
    console.log(`✅ 对账完成: 队列${this.tasks.length}个, 运行中${this.runningTasks}个/${this.maxConcurrency}`);
  }
  
  // 添加任务 - 保留兼容性，但建议使用reconcile
  addTask(task: LoadTask) {
    // 确保任务有epoch
    if (task.epoch === undefined) {
      task.epoch = this.currentEpoch;
    }
    
    // 如果是焦点页面的任务，提高优先级
    if (this.focusPageIndex !== null && task.pageIndex === this.focusPageIndex) {
      task.priority = Math.max(0, task.priority - 1000);
    }
    
    this.tasks.push(task);
    this.reorderTasks();
    this.pumpQueue();
  }
  
  // 取消非当前epoch的任务
  cancelObsoleteTasks() {
    const toCancel: LoadTask[] = [];
    
    this.tasks = this.tasks.filter(task => {
      if (task.epoch !== this.currentEpoch) {
        toCancel.push(task);
        return false;
      }
      return true;
    });
    
    // 执行取消
    toCancel.forEach(task => task.cancel?.());
    
    if (toCancel.length > 0) {
      console.log(`🗑️ 取消过期任务: ${toCancel.length}个 (Epoch ${this.currentEpoch})`);
    }
  }
  
  // 取消非焦点页面的任务
  cancelNonFocusTasks() {
    if (this.focusPageIndex === null) return;
    
    // 取消队列中非焦点页面的任务
    this.tasks = this.tasks.filter(task => {
      if (task.pageIndex !== this.focusPageIndex) {
        task.cancel?.();
        return false;
      }
      return true;
    });
  }
  
  // 重新排序任务
  private reorderTasks() {
    this.tasks.sort((a, b) => {
      // Epoch检查
      if (a.epoch !== b.epoch) {
        return b.epoch - a.epoch; // 新epoch优先
      }
      
      // 焦点页面优先
      if (this.focusPageIndex !== null) {
        if (a.pageIndex === this.focusPageIndex && b.pageIndex !== this.focusPageIndex) return -1;
        if (b.pageIndex === this.focusPageIndex && a.pageIndex !== this.focusPageIndex) return 1;
      }
      
      // 按优先级排序
      return a.priority - b.priority;
    });
  }
  
  // 执行任务队列
  private pumpQueue() {
    while (this.runningTasks < this.maxConcurrency && this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      
      // 第二关口：开跑前检查epoch有效性
      if (task.epoch !== this.currentEpoch) {
        console.log(`🚫 任务已过期，跳过执行: ${task.id} (Epoch ${task.epoch} vs ${this.currentEpoch})`);
        task.cancel?.();
        continue;
      }
      
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
      pending: this.tasks.length,
      running: this.runningTasks,
      focusPage: this.focusPageIndex,
      epoch: this.currentEpoch,
      maxConcurrency: this.maxConcurrency
    };
  }
} 