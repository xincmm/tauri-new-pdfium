export const DPR_MAX = 2;
export const H_PADDING = 40; // 左右留白

// 滚动阈值与预取策略
export const SLOW_SPEED_THRESHOLD = 0.15; // px/ms，低于此值视为慢速滚动
export const SLOW_PREFETCH_PAGES = 3;     // 慢速滚动时预取前向页数
export const IDLE_ENQUEUE_LIMIT = 4;      // 停止后一次入队的最大页数 