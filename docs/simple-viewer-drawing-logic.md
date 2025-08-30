### SimpleViewer/SimplePage 当前绘制逻辑（瓦片、DPR/PPI、触发时机）

本文档总结当前基于 `src/components/PdfViewer/SimpleViewer.tsx` 与 `src/components/PdfViewer/SimplePage.tsx` 的 PDF 绘制实现，覆盖页面布局、可见窗口与预加载策略、瓦片计算、devicePixelRatio 处理以及渲染触发时机。

---

### 组件职责与数据流概览

- `SimpleViewer.tsx`
  - 加载 PDF 元数据：`invoke('load_pdf')` 返回 `PdfMetadata`。
  - 视口状态管理：`viewState = { scale, scrollY }`（缩放范围 [0.25, 4.0]，步进 0.25）。
  - 容器高度监听：`containerHeight` 来自滚动容器或 `window.innerHeight`。
  - 页面布局计算：`calculatePageLayouts(pdfMetadata, viewState)` 根据 `scale` 计算每页在屏幕上的逻辑像素尺寸与位置 `{ y, width, height }`。
  - 可见窗口与预加载：
    - 首开（未交互）：使用 `getVisiblePages` 获取首屏可见页，并向后预加载 2 页。
    - 交互后：使用 `getExpandedVisiblePages(pageLayouts, containerHeight, scrollY, lastScrollY, PRELOAD_PAGES_AHEAD)`，结合滚动方向扩展窗口。
  - 滚动空闲检测：`isScrollIdle` 通过 `SCROLL_DEBOUNCE_MS` 防抖判定。空闲时允许页面渲染。
  - 将 `isVisible` 与 `shouldRender={isScrollIdle}` 传给 `SimplePage` 控制页内渲染。

- `SimplePage.tsx`
  - 接收单页布局尺寸与可见性、缩放信息。
  - 计算瓦片网格（基于逻辑像素尺寸和 `TILE_SIZE`）。
  - 基于 `scale` 与 `devicePixelRatio`（DPR）批量请求所有瓦片，合成为整页图像。
  - Canvas 以逻辑尺寸显示，backing store 按 DPR 放大并使用 `setTransform` 做高分屏绘制。

---

### 页面布局与容器尺寸

- 页面布局由 `calculatePageLayouts` 给出：
  - 输入：`PdfMetadata`、`{ scale, scrollY }`（scrollY 不直接影响布局计算）。
  - 输出：每页的逻辑像素尺寸与位置 `{ pageIndex, y, width, height }`。
- 容器总高度：基于最后一页的 `y + height + 50` 计算，作为绝对定位的承载高度。
- 渲染区域：所有页以绝对定位布局在一个相对定位的容器内；实际只为“可见窗口中的页”挂载 `SimplePage`。

---

### 可见窗口与预加载策略

- 首开（`hasInteracted === false`）：
  - 获取首屏可见区页面集合 `baseVisible = getVisiblePages(...)`。
  - 预加载窗口：在 `baseVisible` 的基础上，向后扩展 2 页。
- 交互后（滚动/缩放发生后）：
  - 使用 `getExpandedVisiblePages(...)` 根据滚动方向（`scrollY` 与 `lastScrollYRef`）与 `PRELOAD_PAGES_AHEAD` 做窗口扩展。
  - 使用 `visiblePageSet` 常量时间判断某页是否需要渲染（可见或预加载窗口内）。

---

### 渲染空闲检测与触发条件

- 滚动事件：
  - 实时更新 `scrollY`，并将 `isScrollIdle=false`。
  - 通过 `SCROLL_DEBOUNCE_MS` 防抖，在滚动停止后将 `isScrollIdle=true`。
- 传递给页面组件：
  - `isVisible`：该页是否在可见/预加载窗口内。
  - `shouldRender`：由 `isScrollIdle` 决定，仅在空闲时允许渲染，避免滚动中请求与重绘抖动。
- 页面触发渲染条件（页内）：`isVisible && shouldRender && tiles.size === 0 && !isLoading`。

---

### DPR/PPI 处理策略

- PDF 原始尺寸来自 `pdfMetadata.page_dims[pageIndex]`，单位为“点（pt）”，72 点 = 1 英寸。
- 显示尺寸由布局算法直接给出为“屏幕逻辑像素”，当前未做“点到像素”的物理 DPI 映射。
- 前端 DPR 计算：`devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)`。
  - 将超高 DPR 设备裁剪到 2，平衡清晰度与性能、内存占用。
- 清晰度保障的两层手段：
  1) Canvas backing store 按 DPR 放大，同时使用 `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` 在逻辑坐标下绘制，避免 1 逻辑像素对多物理像素的模糊。
  2) 瓦片请求带上 `dpr`，由底层（Rust/PDFium）生成更高分辨率的瓦片纹理，避免放大上采样造成细节损失。

---

### 瓦片网格与批量渲染

- 网格计算（逻辑像素维度）：
  - `tilesX = ceil(pageWidth / TILE_SIZE)`
  - `tilesY = ceil(pageHeight / TILE_SIZE)`
- 请求构建：为每个 `(tx, ty)` 生成请求，包含：
  - `pdfId`, `pageIndex`, `tx`, `ty`, `scale`, `dpr`, `pageWidth`, `pageHeight`
  - `tileKey = ${pdfId}_${pageIndex}_${scale}_${tx}_${ty}_dpr${dpr}`（包含缩放与 DPR，确保缓存键唯一）
- 并发批量：通过 `batchTileLoader.renderTilesBatch(requests)` 一次性请求整页瓦片，减少 IPC/调用开销。
- 瓦片解码：服务端返回 `Uint8Array`（`image/webp`），前端转 `Blob` 后 `createImageBitmap`，存入 `Map<string, ImageBitmap>`，键为 `tileKey`。

---

### Canvas 合成绘制（高分屏友好）

- 逻辑尺寸与物理尺寸设置：
  - 逻辑尺寸：`canvas.style.width = pageWidth`、`canvas.style.height = pageHeight`。
  - 物理尺寸：`canvas.width = pageWidth * dpr`、`canvas.height = pageHeight * dpr`。
- 上下文设置：
  - `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`，并开启抗锯齿高质量：`imageSmoothingEnabled = true`、`imageSmoothingQuality = 'high'`。
- 绘制流程（逻辑坐标系）：
  1) `clearRect(0, 0, targetWidth, targetHeight)` 清空逻辑画布。
  2) 白底填充。
  3) 按网格遍历：每块绘制到 `(tx * TILE_SIZE, ty * TILE_SIZE)`，尺寸为 `TILE_SIZE x TILE_SIZE`（逻辑尺寸）。
- 由于 `setTransform` 与高分辨率瓦片配合，高分屏显示更清晰，避免模糊。

---

### 重绘与缓存失效策略

- `scale` 改变：清空 `tiles`（`setTiles(new Map())`），等待空闲时重新批量渲染。
- `tiles` 更新：触发 `drawToCanvas()`，将当前已解码的瓦片一次性绘制至画布。
- `tileKey` 包含 `scale` 与 `dpr`，避免不同缩放/DPR 场景的错误复用。

---

### 关键常量/参数

- `TILE_SIZE`：瓦片边长，来自 `src/types/pdf`。
- `PRELOAD_PAGES_AHEAD`：可见窗口向前/向后扩展的页数基准。
- `SCROLL_DEBOUNCE_MS`：滚动结束防抖时间窗口，决定“空闲”的判定时机。

---

### 已知限制与潜在改进

- DPR 上限固定为 2，超高分设备存在清晰度上限，可按设备/性能动态上调或自适应。
- 首开仅向后预加载 2 页，可根据文档规模、页高分布与滚动速率自适应调整。
- 缩放会触发整页重新渲染，可引入渐进式策略：先用旧瓦片缩放占位，空闲后替换高分瓦片。
- 当前布局尺寸直接以“逻辑像素”表达，未做“点到像素”的物理 DPI 映射；若需要物理尺寸一致性，需定义 PPI/缩放一致性策略并贯穿布局与渲染链路。

---

### 参考路径

- 视图与布局/窗口：`src/components/PdfViewer/SimpleViewer.tsx`
- 页内瓦片与绘制：`src/components/PdfViewer/SimplePage.tsx`
- 布局与可见窗口算法：`src/utils/pdfLayout.ts`
- 批量瓦片渲染：`src/utils/batchTileLoader.ts`
- PDF 类型定义与常量：`src/types/pdf.ts` 