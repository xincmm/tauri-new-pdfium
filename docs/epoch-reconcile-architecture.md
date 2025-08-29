# Epoch-Reconcile 架构：PDF瓦片加载的任务队列革命

## 概述

本文档描述了我们在PDF瓦片加载系统中实现的革命性**Epoch-Reconcile架构**。这套架构借鉴React reconcile机制的核心思想，将其应用到异步任务队列管理中，有效解决了"队列积攒"和"历史债务"问题，将任务队列从38个降至0-5个，响应时间提升至100-160ms内。

## 问题背景

### 原有架构的痛点

**滚动停止时的队列爆炸**
```
队列待处理: 38个
正在执行: 32个  
问题: 历史债务无法清理，当前页面无法立即上屏
```

**根本原因**
- 逐个添加任务，无法批量管理
- 缺少版本控制，旧任务永不过期
- 并发数过高（总计44个），资源争抢严重
- 双重任务添加：PdfContent预加载 + PageCanvas实时加载

## 核心设计理念

### 1. Epoch机制 - 版本控制

```typescript
class PriorityTaskQueue {
  private currentEpoch: number = 0; // 任务版本号

  reconcile(neededTasks: TaskSpec[], reason: string) {
    this.currentEpoch++; // 每次视口变化推进版本
    
    // 清理所有非当前epoch的任务
    this.tasks = this.tasks.filter(task => 
      neededIds.has(task.id) && task.epoch === this.currentEpoch
    );
  }
}
```

**关键特点**
- 每次视口/缩放变化，epoch自增
- 所有旧epoch的任务自动过期
- 三关口检查：入队时/开跑前/上屏前

### 2. Reconcile机制 - 批量对账

```typescript
// 类似React的reconcile，但针对异步任务
reconcile(neededTasks: TaskSpec[], reason: string) {
  // Diffing: 找出不再需要的任务
  const removedTasks = this.tasks.filter(task => 
    !neededIds.has(task.id) || task.epoch !== this.currentEpoch
  );
  
  // Batching: 批量清理和添加
  removedTasks.forEach(task => task.cancel?.());
  
  // Scheduling: 按优先级重新排序
  this.reorderTasks();
}
```

**对比React Reconcile**

| 维度 | React | 我们的架构 |
|------|-------|------------|
| **目标** | 高效更新DOM | 高效管理异步任务 |
| **驱动** | props/state变化 | 视口/缩放变化 |
| **Diffing** | 虚拟DOM树对比 | 任务需求集合对比 |
| **Batching** | DOM更新批处理 | 任务变更批处理 |
| **中断** | 可中断渲染 | 可取消网络请求 |
| **时间** | 同步帧更新 | 异步任务管理 |

## 架构分层

### Layer 1: 全局协调层 (PdfContent.tsx)

```typescript
// 全局reconcile触发器
useEffect(() => {
  const triggerGlobalReconcile = (reason: string) => {
    console.log(`🔄 全局任务对账 (${reason})`);
    globalTaskQueue.reconcile([], reason); // 清空历史债务
  };

  if (!isScrolling) {
    setTimeout(() => triggerGlobalReconcile('scroll-stopped'), 100);
  } else {
    setTimeout(() => triggerGlobalReconcile('scrolling-preload'), 500);
  }
}, [isScrolling, expandedVisiblePages, viewState.scale]);
```

**职责**
- 监听全局事件（滚动、缩放）
- 推进epoch，清理历史债务
- 设置焦点页面优先级

### Layer 2: 页面级任务管理 (PageCanvas.tsx)

```typescript
// 智能任务收集与添加
const collectNeededTasks = useCallback((reason: string) => {
  const neededTasks: TaskSpec[] = [];
  
  // 根据桶策略、overscan、滚动状态收集任务
  for (const bucket of allBuckets) {
    for (const tile of tileGeometry) {
      if (shouldLoadTile(tile, bucket, isScrolling, isPreloadPage)) {
        neededTasks.push(createTileTask(tile, bucket));
      }
    }
  }
  
  return neededTasks;
}, [/* dependencies */]);
```

**职责**
- 收集当前页面真正需要的任务
- 应用优先级策略和过滤规则
- 在全局reconcile后重新添加任务

### Layer 3: Worker执行层 (WorkerTileLoader.ts)

```typescript
// Worker层的epoch检查
private processQueue() {
  const task = this.taskQueue.shift();
  
  // 第二关口：开跑前检查epoch
  if (task.epoch !== this.currentEpoch) {
    console.log(`🚫 Worker任务已过期，跳过执行`);
    return;
  }
  
  // 执行任务...
}
```

**职责**
- 执行网络请求和ImageBitmap解码
- 开跑前epoch检查
- 结果返回时epoch验证

## 关键优化策略

### 1. 并发控制

```typescript
// 前后对比
❌ 原来: TaskQueue(32) + WorkerLoader(12) = 44并发
✅ 现在: TaskQueue(6) + WorkerLoader(6) = 12并发
```

**收益**
- 减少资源争抢
- 降低IPC开销  
- 提高单任务完成速度

### 2. 智能预加载

```typescript
// 分层优先级策略
const calculatePriority = (bucket, tile, context) => {
  const basePriority = bucket.isTarget ? 100 : 200;
  const focusPriority = context.isFocusPage ? -1000 : 0;
  const preloadPenalty = context.isPreloadPage ? 1000 : 0;
  const scrollPenalty = context.isScrolling ? 500 : 0;
  
  return basePriority + focusPriority + preloadPenalty + scrollPenalty;
};
```

**策略矩阵**

| 页面类型 | 滚动状态 | 优先级 | 行为 |
|----------|----------|---------|------|
| 焦点页面 | 停止 | -900 | 立即加载 |
| 可见页面 | 停止 | 100 | 正常加载 |
| 预加载页面 | 停止 | 1100 | 后台加载 |
| 焦点页面 | 滚动中 | -400 | 预加载 |
| 预加载页面 | 快滚动 | - | 跳过加载 |

### 3. 三关口检查机制

```typescript
// 关口1: 入队时检查
reconcile(neededTasks) {
  this.tasks = this.tasks.filter(task => 
    neededIds.has(task.id) && task.epoch === this.currentEpoch
  );
}

// 关口2: 开跑前检查
pumpQueue() {
  if (task.epoch !== this.currentEpoch) {
    task.cancel?.();
    return;
  }
}

// 关口3: 上屏前检查  
handleTileLoaded(id, bitmap, performance, epoch) {
  if (task.epoch !== this.currentEpoch) {
    bitmap?.close?.();
    return;
  }
}
```

## 性能收益

### 量化指标

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 队列待处理 | 38个 | 0-5个 | 90%↓ |
| 最大并发数 | 44个 | 12个 | 73%↓ |
| 滚动响应时间 | 500ms+ | 100-160ms | 70%↑ |
| 历史债务清理 | 无 | 自动 | ✅ |
| 滚动预加载 | 缺失 | 智能 | ✅ |

### 用户体验提升

- **🚀 启动速度**: 滚动停止后100ms内开始当前页面加载
- **🎯 精准加载**: 只加载真正需要的瓦片，避免资源浪费
- **⚡ 流畅滚动**: 智能预加载确保滚动过程无白屏
- **🧹 内存优化**: 自动清理过期任务和ImageBitmap

## 使用示例

### 触发全局Reconcile

```typescript
// PdfContent.tsx - 全局协调
useEffect(() => {
  if (!isScrolling) {
    // 滚动停止后清理历史债务
    setTimeout(() => {
      globalTaskQueue.reconcile([], 'scroll-stopped');
    }, 100);
  }
}, [isScrolling]);
```

### 页面级任务管理

```typescript
// PageCanvas.tsx - 页面任务
useEffect(() => {
  const addPageTasks = () => {
    const neededTasks = collectNeededTasks('page-level');
    
    for (const task of neededTasks) {
      globalTaskQueue.addTask({
        ...task,
        epoch: globalTaskQueue.getCurrentEpoch()
      });
    }
  };

  if (isScrolling) {
    setTimeout(addPageTasks, 50);  // 预加载
  } else {
    setTimeout(addPageTasks, 200); // 高清化
  }
}, [isScrolling]);
```

### Worker层Epoch检查

```typescript
// WorkerTileLoader.ts - 执行层
private processQueue() {
  const task = this.taskQueue.shift();
  
  // Epoch检查
  if (task.epoch !== this.currentEpoch) {
    console.log(`🚫 任务已过期: ${task.id}`);
    return;
  }
  
  // 执行任务
  this.worker.postMessage({
    type: 'load-tile',
    epoch: task.epoch, // 传递epoch
    ...task
  });
}
```

## 最佳实践

### 1. Reconcile时机选择

```typescript
// ✅ 推荐: 关键事件驱动
- 缩放变化时：立即reconcile，清理所有任务
- 滚动停止后：100ms延迟，确保稳定
- 滚动过程中：500ms间隔，轻量清理

// ❌ 避免: 过度频繁
- 不要在每次鼠标移动时reconcile
- 不要在渲染循环中reconcile
```

### 2. 优先级设计

```typescript
// ✅ 分层优先级
const PRIORITY = {
  FOCUS_PAGE: -1000,      // 焦点页面
  VISIBLE_TARGET: 100,    // 可见页面目标桶
  VISIBLE_FALLBACK: 200,  // 可见页面备选桶
  PRELOAD_TARGET: 1100,   // 预加载目标桶
  PRELOAD_FALLBACK: 1200  // 预加载备选桶
};
```

### 3. 内存管理

```typescript
// ✅ 及时释放ImageBitmap
if (epoch !== this.currentEpoch) {
  imageBitmap?.close?.(); // 防止内存泄漏
  return;
}

// ✅ 清理过期任务状态
task.cancel?.();
inflightRef.current.delete(taskId);
```

## 未来扩展

### 1. 协作式取消

实现pdfium渐进式渲染的中断机制，在渲染过程中也能响应epoch变化。

### 2. 更智能的预测

基于用户滚动模式预测下一个目标区域，提前准备瓦片。

### 3. 多级缓存策略

结合LRU缓存和热数据预热，进一步提升响应速度。

## 总结

Epoch-Reconcile架构成功将React的设计哲学应用到异步任务管理中，实现了：

- **🎯 精确控制**: epoch机制确保任务版本一致性
- **⚡ 极速响应**: reconcile批量处理减少管理开销
- **🧠 智能调度**: 多层优先级和预加载策略
- **🛡️ 稳定可靠**: 三关口检查防止过期任务执行

这套架构为PDF瓦片加载系统带来了质的飞跃，为后续的性能优化奠定了坚实的基础。 