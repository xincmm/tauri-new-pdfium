### 渲染性能优化计划（下一阶段）

> 背景：已完成 Retina 画布修正（前端 backing store 乘 dpr）、后端 points→pixels 换算修正（乘 96/72），实现页级虚拟化与滚动空闲防抖。清晰度已恢复，初开多页渲染已抑制。接下来聚焦“只渲染视口内瓦片 + 精细调度 + 并发与批次控制”。

---

#### 目标
- 只请求并解码当前视口内的瓦片（含少量缓冲）。
- 快速滚动时仅在停下后渲染所在页面，滚动中不堆积任务。
- 将平均帧内开销控制在 8~12ms 范围，避免主线程抖动。
- 网络与解码的并发可控，不超配机器线程。

---

#### A. 瓦片级虚拟化（核心）
- 可见性判定：
  - 由容器尺寸与 `scrollY` 得到视口矩形（屏幕像素）。
  - 映射到每页的本地坐标系（CSS 逻辑像素），计算可见瓦片范围：
    - `tx0..tx1 = floor(viewLeft / TILE_SIZE) .. floor((viewRight-1)/TILE_SIZE)`
    - `ty0..ty1 = floor(viewTop / TILE_SIZE) .. floor((viewBottom-1)/TILE_SIZE)`
  - 额外加入 1~2 个瓦片的“缓冲边”（hysteresis），减少轻微滚动造成的反复请求。
- 缩放变更：清空旧瓦片缓存，等待滚动空闲后再触发当前视口瓦片请求。
- API 不变：仍调用批量接口，但批次仅包含可见瓦片集合。

交付：
- 修改 `SimplePage.tsx`：从当前“渲染整页所有瓦片”改为“仅渲染可见范围（含缓冲边）”。
- 新增小型帮助函数：`getVisibleTileRange(pageLayout, viewport, paddingTiles)`。

---

#### B. rAF 调度 + 配额与去重（请求层）
- 调度器：每帧在 `requestAnimationFrame` 回调内发起有限数量的请求与解码任务。
- 双队列 + 配额：
  - `urgent`（视口内）每帧最多 2 个；`preload`（缓冲边/后续页）每帧最多 1 个。
  - 动态降配：若上一帧超时或在途任务≥阈值，则本帧减少额度。
- 去重与兜底：
  - `wantSet`：记录当前帧“想要”的瓦片键集合。
  - `inFlight`：Map(tileKey → {rid, abort?})，处于请求/解码中的瓦片。
  - `rid`（渲染世代号）：每次视图状态变更递增；结果回到前端时若 `result.rid !== currentRid`，直接丢弃。
  - “仍在 want 的在途收编，不重复发”；“不在 want 的立即 abort/cancel（若不可真正中断，则仅丢弃结果）”。

交付：
- 新增 `TileScheduler`（前端 util）：管理队列、配额、rid 与 inFlight。
- `SimplePage` 与 `SimpleViewer` 仅提交“想要”的瓦片键给调度器。

---

#### C. 批大小与分批策略（网络侧）
- 初始批大小：12（可调），目标单批 ≈ 0.8–1.6MB（结合你截图中的 1.3MB 观测）。
- 分批策略：
  - 同页、同 scale、相邻区域优先合并至一批，减少多次往返；
  - 若上一批 `total_ms` 较长或 `packed_bytes` 超阈值，则缩小下批规模；
  - 快速滚动中仅打包 urgent 范围，不做额外预加载批次。

交付：
- `batchTileLoader.renderTilesBatch` 增加批次切分逻辑 + 简单自适应（移动平均延迟 & 大小）。

---

#### D. createImageBitmap 解码并发（解码侧）
- 解码信号量：并发 2~3，避免一次性喂爆浏览器解码线程。
- 同样纳入调度器：urgent 优先解码，preload 次之。

交付：
- 新增 `ImageBitmapSemaphore`（前端 util）：`acquire/release` 包裹解码流程。
- `batchTileLoader` 解码阶段接入信号量（或在 `SimplePage` 层统一解码）。

---

#### E. 取消与结果丢弃策略
- Tauri `invoke` 本身不可中断时：使用 `rid` 丢弃过期结果。
- 结果合并：只有当 `tileKey` 仍在 `wantSet` 且 `rid` 匹配时，才写入 `tiles` 并触发绘制。

---

#### F. 缓存与内存上限
- 键：`pdfId_page_scale_tx_ty_dpr`。
- 页面内 LRU：上限（如 150~300 瓦片/页），超过则淘汰距视口远的瓦片。
- 全局上限：按内存估算（WebP 解码后约 `TILE_SIZE^2*4` 字节/瓦片），保守限制。

---

#### G. 指标与调试面板
- 运行指标：
  - 队列长度（urgent/preload）、in-flight、decode 并发、平均批大小/耗时、丢弃数。
- 覆盖现有 `PerformanceDebugger`：新增这些统计与阈值开关。

---

#### H. 配置常量（初始建议）
- `TILE_SIZE = 512`（后续可评估 384/256 对 GPU 上传与缓存的权衡）。
- `DPR_CAP = 2`。
- `SCROLL_DEBOUNCE_MS = 96`（已用）。
- `PRELOAD_PAGES_AHEAD = 1`（交互后再启用）。
- `VISIBLE_TILE_PADDING = 1`（每边加 1 个瓦片作为缓冲）。
- `SCHEDULER_QUOTA: urgent=2, preload=1`。
- `DECODE_CONCURRENCY = 2`（高端机可 3）。
- `BATCH_SIZE_DEFAULT = 12`，`BATCH_BYTES_SOFT_MAX = 1.6MB`。

---

#### 实施顺序与交付划分
1) A 瓦片级虚拟化（SimplePage 改造）
2) B 调度器（rAF + 配额 + 去重/abort + rid）
3) D 解码并发信号量
4) C 批次切分与自适应
5) F 缓存上限 + G 指标面板

每步完成后分别验证：
- 滚动到达新区域时的拉取数量与耗时
- rAF 帧时间与交互流畅度
- 网络与 CPU 峰值是否下降

---

#### 后续可选（需要后端配合的增强）
- 逐块回传/流式：tauri `emit` 事件流，后端边编码边发送，前端边解码边绘制；支持中途取消。
- 取消 API：后端提交 `request_id`，提供 `cancel_request(request_id)` 命令。
- 服务端缓存热点瓦片（相同 id/page/scale/dpr/rect）以降低重复成本。

---

#### 验收标准（简要）
- 快速滚动时网络面板不再出现多页大批量；停下 150ms 内首屏清晰完成。
- 常规滚动（1~2 屏/秒）下帧率稳定，无长时间卡顿。
- 解码并发受控（2~3），无解码排队爆发。 