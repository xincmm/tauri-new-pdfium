# PDF Viewer 性能优化记录

本文档记录了 PDF Viewer 组件的性能优化过程，主要针对滚动和缩放时的卡顿问题。

## 问题分析

根据前端专家分析，主要性能瓶颈在于：

1. **主线程图片解码** - 使用 `new Image()` 导致主线程阻塞
2. **React 全局状态重渲染** - `imageCache` 和 `setNeedsRedraw` 触发整棵树重渲染  
3. **全量清空重画** - 每次都清空整页并重新绘制所有内容

## 第一阶段优化 ✅ 已完成

### 1. 图片解码优化

**问题**：使用 `HTMLImageElement` 在主线程解码，造成阻塞
**解决方案**：
- 将 `HTMLImageElement` 替换为 `ImageBitmap`
- 使用 `createImageBitmap()` 在后台线程解码
- 减少主线程阻塞和 GPU 纹理上传开销

```typescript
// 旧方案
const img = new Image();
img.onload = () => setImageCache(prev => ({ ...prev, [key]: img }));

// 新方案
const response = await fetch(url, { cache: 'force-cache' });
const blob = await response.blob();
const bitmap = await createImageBitmap(blob);
bitmapCacheRef.current.set(key, bitmap);
```

### 2. 缓存机制优化

**问题**：React state 的 `imageCache` 每次更新都触发整树重渲染
**解决方案**：
- 将 `imageCache` 从 React state 改为 `useRef(Map)`
- 添加 `inflightRef` 防止重复请求
- 避免每次瓦片加载触发组件重渲染

```typescript
// 旧方案
const [imageCache, setImageCache] = useState<ImageCache>({});

// 新方案
const bitmapCacheRef = useRef<Map<string, ImageBitmap>>(new Map());
const inflightRef = useRef<Set<string>>(new Set());
```

### 3. 绘制策略优化

**问题**：每次都清空整页并重新绘制所有内容
**解决方案**：
- 实现增量脏矩形绘制
- 静态背景（页码）分离到独立 canvas
- 滚动时直接复用缓存，避免重新计算和绘制

```typescript
// 静态背景分离
const staticBackgroundRef = useRef<HTMLCanvasElement | null>(null);
const rebuildStaticBackground = useCallback(() => {
  // 只在缩放变化时重建静态背景
});

// 增量绘制
if (needsFullRender()) {
  cacheCtx.drawImage(getStaticBackgroundCanvas(), 0, 0);
}
// 只绘制新加载的瓦片
```

### 4. 并发控制优化

**问题**：同时加载过多瓦片造成线程池拥塞
**解决方案**：
- 添加瓦片加载队列和并发限制（最大8个并发）
- 使用 `scheduleLoad` 函数管理加载任务

```typescript
const MAX_CONCURRENCY = 8;
const loadQueue: Array<() => Promise<void>> = [];
let runningTasks = 0;

function scheduleLoad(task: () => Promise<void>) {
  loadQueue.push(task);
  pumpQueue();
}
```

### 5. 预加载优化

**问题**：渲染和预加载逻辑混合，影响性能
**解决方案**：
- 只渲染可见页面的 Canvas
- 扩展可见页面仅用于预加载瓦片数据
- 添加瓦片几何信息缓存

```typescript
// 渲染层只使用可见页面
{visiblePages.map(pageLayout => (
  <PageCanvas key={pageLayout.pageIndex} ... />
))}

// 预加载使用扩展可见页面
useEffect(() => {
  expandedVisiblePages.forEach(pageLayout => {
    // 预加载瓦片数据
  });
}, [expandedVisiblePages, isScrolling]);
```

### 6. Canvas 和 DOM 优化

**Canvas 优化**：
- 使用 `alpha: false, desynchronized: true` 参数
- 关闭不必要的 `imageSmoothingEnabled`

**DOM 优化**：
- 添加 `contentVisibility: auto` 和 `contain: strict`
- 优化非可见元素的渲染成本

### 7. 内存管理优化

**ImageBitmap 资源管理**：
- 缩放变化时正确释放 `ImageBitmap` 资源
- 使用 `bitmap.close()` 避免内存泄漏

```typescript
// 清理 ImageBitmap 缓存
for (const bitmap of bitmapCacheRef.current.values()) {
  bitmap.close(); // 释放 ImageBitmap 资源
}
bitmapCacheRef.current.clear();
```

## 第二阶段优化计划 🚧 待完成

### 1. 图像处理细节优化

- [ ] **平滑缩放控制**：调整 `POSTER_SCALE_FACTOR` 到最佳比例
- [ ] **图像质量设置**：只在必要时使用 `imageSmoothingQuality = 'low'`
- [ ] **WebP 参数调优**：优化后端 WebP 质量和压缩参数

### 2. 瓦片网格优化

- [ ] **瓦片几何预计算**：缓存瓦片网格计算结果
- [ ] **瓦片优先级**：优先加载视窗中心的瓦片
- [ ] **瓦片大小自适应**：根据设备性能调整瓦片尺寸

### 3. 请求调度优化

- [ ] **智能预取策略**：基于滚动速度和方向优化预取
- [ ] **请求去重和合并**：避免重复请求相同瓦片
- [ ] **网络状态适应**：根据网络条件调整并发数

## 第三阶段优化计划 🎯 进阶优化

### 1. 渲染引擎升级

- [ ] **OffscreenCanvas**：在 Worker 中进行 Canvas 合成（Chromium/Edge）
- [ ] **WebGL 渲染**：使用 WebGL/Pixi.js 进行硬件加速渲染
- [ ] **分层渲染**：文本层和图像层分离渲染

### 2. 高级缓存策略

- [ ] **LRU 缓存算法**：智能淘汰最少使用的瓦片
- [ ] **持久化缓存**：使用 IndexedDB 缓存瓦片数据
- [ ] **压缩缓存**：对缓存数据进行压缩存储

### 3. 性能监控和调优

- [ ] **性能指标收集**：FPS、内存使用、渲染时间等
- [ ] **自适应渲染**：根据设备性能动态调整渲染质量
- [ ] **A/B 测试框架**：对比不同优化策略的效果

## 优化效果预期

### 第一阶段预期收益
- **滚动流畅度**：减少 60-80% 的掉帧
- **缩放响应**：缩放后迟缓感明显改善
- **内存使用**：避免 React 重渲染带来的内存峰值
- **CPU 占用**：主线程阻塞时间减少 70%+

### 后续阶段预期收益
- **第二阶段**：进一步提升 20-30% 的渲染性能
- **第三阶段**：在高端设备上达到接近原生应用的体验

## 测试和验证

### 性能测试指标
1. **滚动流畅度**：60fps 下的掉帧率
2. **缩放响应时间**：从缩放操作到页面更新的延迟
3. **内存使用峰值**：长时间使用后的内存占用
4. **首屏渲染时间**：PDF 加载到首次可见的时间

### 测试环境
- **高端设备**：MacBook Pro M2, 32GB RAM
- **中端设备**：普通笔记本，8GB RAM
- **移动设备**：iPad, iPhone（如果支持）

---

**更新日期**：2024-12-19  
**当前状态**：第一阶段优化已完成，等待用户验证效果后继续第二阶段 