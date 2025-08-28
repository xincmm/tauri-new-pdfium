# PDF 渲染架构文档

## 概述

本文档详细描述了 PDF 查看器的渲染架构，重点介绍整页替换渲染策略和组件拆分后的架构设计。

## 架构概览

### 组件层次结构
```
PdfViewer (主组件)
├── PdfToolbar (工具栏)
└── PdfContent (内容管理)
    ├── PageCanvas (页面渲染) - 独立组件
    └── PdfTextLayer (文本选择层)
```

### 核心设计原则
1. **整页替换渲染**: 避免瓦片逐块加载的视觉干扰
2. **高清优先策略**: 已有高清瓦片时始终优先使用
3. **智能缓存管理**: 多层缓存避免重复渲染
4. **关注点分离**: 渲染逻辑与页面管理分离

## 详细渲染逻辑

### 1. 整页替换渲染策略

#### 核心思想
- **传统问题**: 瓦片逐块加载产生"拼图效果"，用户体验差
- **解决方案**: 等待整页所有瓦片准备完成后，一次性渲染整页内容

#### 实现机制
```typescript
// 检查整页瓦片完整性
const checkPageTilesReady = (isHighRes: boolean = true) => {
  const tileGeometry = computeTileGeometry();
  let allTilesReady = true;
  
  for (const tile of tileGeometry) {
    const tileKey = generateTileKey(tileInfo);
    const tileState = getTileState(tileKey);
    const bitmap = bitmapCacheRef.current.get(tileKey);
    
    if (!bitmap || !tileState.loaded) {
      allTilesReady = false;
      break;
    }
  }
  
  return allTilesReady;
};
```

#### 渲染决策流程
1. **检查高清瓦片完整性**: 所有高清瓦片是否已加载
2. **检查低清瓦片完整性**: 所有低清瓦片是否已加载
3. **决定渲染策略**: 
   - 高清完整 → 渲染高清版本
   - 高清未完整但低清完整 → 渲染低清版本
   - 都未完整 → 保持当前缓存内容

### 2. 高清瓦片优先策略

#### 滚动时的特殊处理
```typescript
// 决定渲染策略：优先使用已有的高清瓦片
let shouldRenderHighRes = highResReady; // 如果高清瓦片准备好，始终优先使用
let shouldRenderLowRes = !highResReady && lowResReady; // 只有高清未准备好时才使用低清

// 滚动时的特殊处理：如果已经有高清瓦片，继续使用高清
if (isScrolling && pageRenderState.highResReady && pageRenderState.lastRenderedScale === currentScale) {
  shouldRenderHighRes = true;
  shouldRenderLowRes = false;
}
```

#### 加载优先级策略
- **非滚动时**: 优先加载高清瓦片
- **滚动时**: 如果页面还没有高清版本，继续加载高清瓦片
- **已有高清时**: 滚动时不降级到低清，保持高清显示

### 3. 三层 Canvas 架构

#### 静态背景 Canvas
```typescript
const staticBackgroundRef = useRef<HTMLCanvasElement | null>(null);
```
- **用途**: 绘制页面背景、边框、页码等静态元素
- **更新时机**: 只在页面尺寸变化时重建
- **性能优势**: 避免重复绘制静态内容

#### 缓存 Canvas
```typescript
const cacheCanvasRef = useRef<HTMLCanvasElement | null>(null);
```
- **用途**: 合成静态背景 + 瓦片内容
- **更新时机**: 整页瓦片状态变化时
- **滚动优化**: 滚动时直接复用，避免重绘

#### 主 Canvas
```typescript
const canvasRef = useRef<HTMLCanvasElement>(null);
```
- **用途**: 最终显示给用户的 canvas
- **内容来源**: 从缓存 canvas 复制内容
- **渲染频率**: 最高，但大部分时间只是复制操作

### 4. 页面级别渲染状态管理

#### 状态结构
```typescript
const [pageRenderState, setPageRenderState] = useState<{
  highResReady: boolean;      // 高清瓦片是否准备完成
  lowResReady: boolean;       // 低清瓦片是否准备完成
  lastRenderedScale: number;  // 上次渲染的缩放级别
  lastCheckTime: number;      // 最后检查时间
}>({
  highResReady: false,
  lowResReady: false,
  lastRenderedScale: -1,
  lastCheckTime: 0
});
```

#### 状态更新时机
- **缩放变化**: 重置所有状态
- **瓦片加载完成**: 触发完整性检查
- **渲染完成**: 更新状态记录

### 5. 瓦片加载并发控制

#### 并发限制机制
```typescript
const MAX_CONCURRENCY = 8;
const loadQueue: Array<() => Promise<void>> = [];
let runningTasks = 0;

function scheduleLoad(task: () => Promise<void>) {
  loadQueue.push(task);
  pumpQueue();
}
```

#### 加载完成回调
```typescript
// 检查是否整页瓦片都已完成，如果是则触发重绘
setTimeout(() => {
  if (checkPageTilesReady(true)) {
    requestRedraw();
  }
}, 0);
```

## 性能优化策略

### 1. 视口裁剪 (Viewport Culling)
- **可见页面计算**: 只渲染屏幕内可见的页面
- **扩展预加载**: 根据滚动方向智能预加载
- **内存控制**: 有效控制内存使用

### 2. 缓存复用策略
- **滚动优化**: 滚动时优先使用已有缓存
- **缩放缓存**: 缩放变化时清理过期缓存
- **ImageBitmap 管理**: 及时释放不需要的位图资源

### 3. 渲染频率控制
```typescript
const requestRedraw = useCallback(() => {
  if (redrawFlag.current) return;
  redrawFlag.current = true;
  requestAnimationFrame(() => {
    redrawFlag.current = false;
    // 触发重绘
  });
}, []);
```

### 4. 异步加载策略
- **非阻塞加载**: 瓦片加载不阻塞主线程
- **渐进式显示**: 低清先显示，高清后替换
- **预加载机制**: 提前加载即将可见的内容

## 组件拆分架构

### PageCanvas 组件职责
- 单页瓦片渲染逻辑
- 三层 Canvas 管理
- 瓦片加载状态管理
- 整页替换渲染决策

### PdfContent 组件职责
- 多页面管理
- 可见页面计算
- 跨页文本选择
- 布局和容器管理

### 拆分优势
1. **代码可维护性**: 每个组件职责清晰
2. **测试友好**: 独立组件更容易测试
3. **性能优化**: 可以针对性优化不同层次
4. **代码复用**: PageCanvas 可被其他场景复用

## 用户体验改进

### 整页替换带来的改进
1. **视觉统一性**: 整页内容同时出现，符合用户预期
2. **消除闪烁**: 避免瓦片逐块替换的闪烁效果
3. **流畅滚动**: 高清页面滚动时保持高质量显示
4. **加载体验**: 低清占位 → 高清整页替换，体验更佳

### 性能与体验平衡
- **初次加载**: 低清瓦片快速占位
- **高清升级**: 整页高清瓦片准备完成后统一替换
- **滚动保持**: 已有高清页面滚动时保持高清显示
- **内存管理**: 及时清理不需要的缓存

## 技术指标

### 渲染性能
- **瓦片大小**: 动态根据 DPI 调整
- **并发控制**: 最多 8 个瓦片并发加载
- **缓存命中**: 多层缓存提高复用率
- **内存使用**: 只保留可见和预加载页面的瓦片

### 代码质量
- **原始代码**: 1000+ 行单一组件
- **重构后**: PageCanvas ~500 行，PdfContent ~400 行
- **职责分离**: 渲染逻辑与页面管理分离
- **可测试性**: 独立组件便于单元测试

## 未来优化方向

### 1. 进一步组件化
- 提取瓦片加载逻辑到独立 Hook
- 创建通用的 Canvas 管理工具
- 抽象渲染状态管理

### 2. 性能优化
- Web Worker 瓦片预处理
- 更智能的预加载策略
- GPU 加速渲染

### 3. 用户体验
- 加载进度指示器
- 更平滑的缩放动画
- 自适应质量调节

---

*文档版本: v1.0*  
*最后更新: 2024年* 