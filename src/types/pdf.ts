// PDF 相关的类型定义和常量

export interface PdfMetadata {
  id: string;
  total_pages: number;
  page_dims: [number, number][];
}

export interface CharBoxPt {
  idx: number;
  ch: string;
  left: number; 
  top: number; 
  right: number; 
  bottom: number; // pt 坐标
}

export interface PageTextLayout {
  width_pt: number;
  height_pt: number;
  chars: CharBoxPt[];
}

export interface TileInfo {
  id: string;
  page: number;
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewState {
  scale: number;
  scrollY: number;
}

export interface PageLayout {
  pageIndex: number;
  y: number;
  width: number;
  height: number;
}

export interface PagePosterState {
  loaded: boolean;
  loading: boolean;
}

export interface TileState {
  loaded: boolean;
  loading: boolean;
}

// 渲染桶策略类型
export interface RenderBucket {
  scale: number;
  key: string;
  isTarget: boolean;  // 是否为目标桶（1:1像素对齐）
}

export interface PageRenderState {
  targetBucket: RenderBucket;
  activeBucket: RenderBucket | null;  // 当前显示的桶
  availableBuckets: RenderBucket[];   // 可用的桶
  lastStillTime: number;              // 最后静止时间
  needsFadeTransition: boolean;       // 是否需要淡入切换
}

// 常量定义
export const TILE_SIZE = 512;
export const BASE_DPI = 96; // 与后端一致
export const DEFAULT_SCALE = 1; // 默认缩放比例
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5.0;
export const PAGE_MARGIN = 20; // 页面间距
export const SCROLL_DEBOUNCE_MS = 96; // 滚动停止后的延迟时间

// 新的渲染桶策略常量
export const BUCKET_STRATEGY = {
  TARGET_FACTOR: 1.0,        // 目标桶倍数（1:1像素对齐）
  HIGHER_FACTOR: 1.2,        // 更清一档倍数（占位用）
  LOWER_FACTOR: 0.8,         // 备用低清倍数
  FADE_DELAY_MS: 140,        // 静止后淡入延迟时间
  FADE_DURATION_MS: 200,     // 淡入动画时长
} as const;

// 兼容性：保留原有常量但标记为deprecated
/** @deprecated 使用新的BUCKET_STRATEGY替代 */
export const POSTER_SCALE_FACTOR = 0.6;
/** @deprecated 使用BUCKET_STRATEGY.FADE_DELAY_MS替代 */
export const HIGH_RES_LOAD_DELAY = 300;
export const PRELOAD_PAGES_AHEAD = 2; // 预加载下面几页 