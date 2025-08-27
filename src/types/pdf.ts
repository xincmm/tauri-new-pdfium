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

// 常量定义
export const TILE_SIZE = 768;
export const BASE_DPI = 150; // 与后端一致
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5.0;
export const PAGE_MARGIN = 20; // 页面间距
export const SCROLL_DEBOUNCE_MS = 150; // 滚动停止后的延迟时间
export const POSTER_SCALE_FACTOR = 0.4; // 海报图的缩放因子（提升分辨率以改善视觉效果）
export const HIGH_RES_LOAD_DELAY = 300; // 高分辨率瓦片加载延迟
export const PRELOAD_PAGES_AHEAD = 2; // 预加载下面几页 