// 瓦片加载任务接口
export interface LoadTask {
  id: string;
  priority: number; // 数字越小优先级越高
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
  
  constructor(maxConcurrency: number = 32) {
    this.maxConcurrency = maxConcurrency;
  }
  
  // 设置焦点页面，会重新排序任务优先级
  setFocusPage(pageIndex: number | null) {
    if (this.focusPageIndex === pageIndex) return;
    
    this.focusPageIndex = pageIndex;
    this.reorderTasks();
    this.pumpQueue();
  }
  
  // 添加任务
  addTask(task: LoadTask) {
    // 如果是焦点页面的任务，提高优先级
    if (this.focusPageIndex !== null && task.pageIndex === this.focusPageIndex) {
      task.priority = Math.max(0, task.priority - 1000); // 大幅提升优先级
    }
    
    this.tasks.push(task);
    this.reorderTasks();
    this.pumpQueue();
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
      focusPage: this.focusPageIndex
    };
  }
} 