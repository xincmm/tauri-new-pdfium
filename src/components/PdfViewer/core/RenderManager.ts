export interface PageRenderInfo {
  pageIndex: number;
  imageBitmap: ImageBitmap | null;
  isLoading: boolean;
  lastRendered: number;
  priority: number;
  scale: number; // 记录渲染时的缩放比例
}

export interface RenderTask {
  pageIndex: number;
  layout: any;
  priority: number;
  scale: number;
  epoch: number; // 任务时代，用于取消过期任务
}

export interface RenderQueueConfig {
  maxConcurrency: number;
  idleEnqueueLimit: number;
  slowPrefetchPages: number;
}

/**
 * 渲染管理器 - 管理PDF页面的渲染状态和任务队列
 */
export class RenderManager {
  private pageRenderMap = new Map<number, PageRenderInfo>();
  private renderTasks: RenderTask[] = [];
  private isProcessing = false;
  private enabled = true;
  private currentEpoch = 0;
  private config: RenderQueueConfig;

  // 回调函数
  private onRenderPage?: (pageIndex: number, layout: any) => Promise<void>;
  private onRenderComplete?: () => void;

  constructor(config: Partial<RenderQueueConfig> = {}) {
    this.config = {
      maxConcurrency: 1,
      idleEnqueueLimit: 4,
      slowPrefetchPages: 3,
      ...config,
    };
  }

  /**
   * 设置渲染回调
   */
  setRenderCallback(onRenderPage: (pageIndex: number, layout: any) => Promise<void>) {
    this.onRenderPage = onRenderPage;
  }

  /**
   * 设置完成回调
   */
  setCompleteCallback(onRenderComplete: () => void) {
    this.onRenderComplete = onRenderComplete;
  }

  /**
   * 获取页面渲染信息
   */
  getPageRenderInfo(pageIndex: number): PageRenderInfo | undefined {
    return this.pageRenderMap.get(pageIndex);
  }

  /**
   * 设置页面渲染信息
   */
  setPageRenderInfo(pageIndex: number, info: Partial<PageRenderInfo>) {
    const existing = this.pageRenderMap.get(pageIndex);
    const updated: PageRenderInfo = {
      pageIndex,
      imageBitmap: null,
      isLoading: false,
      lastRendered: 0,
      priority: 0,
      scale: 1,
      ...existing,
      ...info,
    };
    this.pageRenderMap.set(pageIndex, updated);
  }

  /**
   * 删除页面渲染信息
   */
  deletePageRenderInfo(pageIndex: number) {
    const info = this.pageRenderMap.get(pageIndex);
    if (info?.imageBitmap) {
      try {
        (info.imageBitmap as any).close?.();
      } catch (e) {
        // 静默处理释放错误
      }
    }
    this.pageRenderMap.delete(pageIndex);
  }

  /**
   * 获取已渲染的页面数量
   */
  getRenderedPagesCount(): number {
    let count = 0;
    for (const info of this.pageRenderMap.values()) {
      if (info.imageBitmap && !info.isLoading) {
        count++;
      }
    }
    return count;
  }

  /**
   * 添加渲染任务
   */
  enqueueRenderTask(task: Omit<RenderTask, "epoch">) {
    if (!this.enabled) return;

    const fullTask: RenderTask = {
      ...task,
      epoch: this.currentEpoch,
    };

    // 检查是否已存在相同页面的任务
    const existingIndex = this.renderTasks.findIndex((t) => t.pageIndex === task.pageIndex);
    if (existingIndex !== -1) {
      // 更新现有任务的优先级和时代
      this.renderTasks[existingIndex] = fullTask;
    } else {
      this.renderTasks.push(fullTask);
    }

    // 按优先级排序（数字越小优先级越高）
    this.renderTasks.sort((a, b) => a.priority - b.priority);

    // 启动处理
    this.processQueue();
  }

  /**
   * 启用/禁用队列处理
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.processQueue();
    }
  }

  /**
   * 提升时代，取消旧任务
   */
  bumpEpoch() {
    this.currentEpoch++;
  }

  /**
   * 清除所有渲染任务
   */
  clearTasks() {
    this.renderTasks = [];
    this.bumpEpoch();
  }

  /**
   * 清理所有页面渲染信息
   */
  clearAllPages() {
    for (const info of this.pageRenderMap.values()) {
      if (info.imageBitmap) {
        try {
          (info.imageBitmap as any).close?.();
        } catch (e) {
          // 静默处理释放错误
        }
      }
    }
    this.pageRenderMap.clear();
    this.clearTasks();
  }

  /**
   * 清理指定缩放比例之外的页面
   */
  clearPagesExceptScale(currentScale: number, tolerance = 0.01) {
    const pagesToDelete: number[] = [];

    for (const [pageIndex, info] of this.pageRenderMap.entries()) {
      if (Math.abs(info.scale - currentScale) > tolerance) {
        pagesToDelete.push(pageIndex);
      }
    }

    for (const pageIndex of pagesToDelete) {
      this.deletePageRenderInfo(pageIndex);
    }
  }

  /**
   * 批量添加空闲时渲染任务
   */
  enqueueIdleTasks(visibleLayouts: any[], containerHeight: number, scrollY: number, scale: number) {
    if (!this.enabled) return;

    // 按视口中心距离排序
    const viewportCenter = scrollY + containerHeight / 2;
    const candidates = visibleLayouts
      .map((layout) => ({
        layout,
        distance: Math.abs(layout.y + 40 + layout.height / 2 - viewportCenter),
      }))
      .sort((a, b) => a.distance - b.distance);

    let count = 0;
    for (const { layout } of candidates) {
      if (count >= this.config.idleEnqueueLimit) break;

      const pageInfo = this.getPageRenderInfo(layout.pageIndex);
      if (!pageInfo || (!pageInfo.imageBitmap && !pageInfo.isLoading)) {
        this.enqueueRenderTask({
          pageIndex: layout.pageIndex,
          layout,
          priority: count,
          scale,
        });
        count++;
      }
    }
  }

  /**
   * 添加前向预取任务（慢速滚动时）
   */
  enqueuePrefetchTasks(visibleLayouts: any[], scrollDirection: -1 | 0 | 1, allLayouts: any[], scale: number) {
    if (!this.enabled || visibleLayouts.length === 0) return;

    const indices = [...visibleLayouts.map((l) => l.pageIndex)].sort((a, b) => a - b);
    const first = indices[0];
    const last = indices[indices.length - 1];

    const start = scrollDirection >= 0 ? last + 1 : first - 1;
    const step = scrollDirection >= 0 ? 1 : -1;

    let priority = 5; // 预取任务优先级较低
    for (let i = 0; i < this.config.slowPrefetchPages; i++) {
      const idx = start + i * step;
      if (idx < 0 || idx >= allLayouts.length) continue;

      const info = this.getPageRenderInfo(idx);
      if (info && (info.imageBitmap || info.isLoading)) continue;

      const layout = allLayouts.find((l) => l.pageIndex === idx);
      if (!layout) continue;

      this.enqueueRenderTask({
        pageIndex: idx,
        layout,
        priority,
        scale,
      });
      priority++;
    }
  }

  /**
   * 处理渲染队列
   */
  private async processQueue() {
    if (this.isProcessing || !this.enabled || this.renderTasks.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.renderTasks.length > 0 && this.enabled) {
      const task = this.renderTasks.shift()!;

      // 检查任务是否过期
      if (task.epoch < this.currentEpoch) {
        continue;
      }

      // 检查页面是否已经在加载或已加载
      const pageInfo = this.getPageRenderInfo(task.pageIndex);
      if (pageInfo && (pageInfo.isLoading || pageInfo.imageBitmap)) {
        continue;
      }

      try {
        if (this.onRenderPage) {
          await this.onRenderPage(task.pageIndex, task.layout);
        }
      } catch (error) {
        console.error(`Failed to render page ${task.pageIndex}:`, error);
      }

      // 检查是否需要继续处理
      if (!this.enabled) {
        break;
      }
    }

    this.isProcessing = false;

    // 通知渲染完成
    if (this.renderTasks.length === 0 && this.onRenderComplete) {
      this.onRenderComplete();
    }
  }

  /**
   * 获取队列状态信息
   */
  getQueueStatus() {
    return {
      taskCount: this.renderTasks.length,
      isProcessing: this.isProcessing,
      enabled: this.enabled,
      currentEpoch: this.currentEpoch,
      renderedPages: this.getRenderedPagesCount(),
      totalPages: this.pageRenderMap.size,
    };
  }
}

// 全局单例实例
export const renderManager = new RenderManager();
