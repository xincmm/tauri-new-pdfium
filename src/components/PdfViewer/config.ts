// PDF 查看器配置常量

// 显示相关配置
export const DPR_MAX = 2;
export const H_PADDING = 40; // 左右留白
export const TILE_SIZE = 512;
export const BASE_DPI = 96; // 与后端一致
export const PAGE_MARGIN = 20; // 页面间距

// 缩放相关配置
export const DEFAULT_SCALE = 1; // 默认缩放比例
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5.0;

// 滚动与性能配置
export const SCROLL_DEBOUNCE_MS = 96; // 滚动停止后的延迟时间
export const SLOW_SPEED_THRESHOLD = 0.15; // px/ms，低于此值视为慢速滚动
export const SLOW_PREFETCH_PAGES = 3; // 慢速滚动时预取前向页数
export const IDLE_ENQUEUE_LIMIT = 4; // 停止后一次入队的最大页数
export const PRELOAD_PAGES_AHEAD = 3;

// 渲染桶策略配置
export const BUCKET_STRATEGY = {
  TARGET_FACTOR: 1.0, // 目标桶倍数（1:1像素对齐）
  HIGHER_FACTOR: 1.2, // 更清一档倍数（占位用）
  LOWER_FACTOR: 0.8, // 备用低清倍数
  FADE_DELAY_MS: 140, // 静止后淡入延迟时间
  FADE_DURATION_MS: 200, // 淡入动画时长
} as const;

// 渲染优化配置
export const POSTER_SCALE_FACTOR = 0.6;
export const HIGH_RES_LOAD_DELAY = 200;
