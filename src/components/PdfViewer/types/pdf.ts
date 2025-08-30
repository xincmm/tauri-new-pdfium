// PDF 相关的类型定义和常量

export interface PdfMetadata {
  id: string;
  total_pages: number;
  // 去重的页面尺寸模板
  page_dimension_templates: [number, number][];
  // 每页对应的模板索引
  page_template_indices: number[];
}

// 获取指定页面的尺寸
export function getPageDimensions(metadata: PdfMetadata, pageIndex: number): [number, number] {
  if (pageIndex < 0 || pageIndex >= metadata.total_pages) {
    throw new Error(`Page index ${pageIndex} out of range [0, ${metadata.total_pages - 1}]`);
  }

  const templateIndex = metadata.page_template_indices[pageIndex];
  if (templateIndex >= metadata.page_dimension_templates.length) {
    throw new Error(`Invalid template index ${templateIndex} for page ${pageIndex}`);
  }

  return metadata.page_dimension_templates[templateIndex];
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

// 新的瓦片请求结构，对应后端的TileRequest
export interface TileRequest {
  page_index: number;
  rect_x: number;
  rect_y: number;
  rect_width: number;
  rect_height: number;
  scale_factor: number;
  dpr: number;
}

// 批量瓦片渲染结果
export interface BatchTileResult {
  tiles: TileData[];
  totalBytes: number;
  tileCount: number;
}

// 单个瓦片数据
export interface TileData {
  data: Uint8Array;
  width: number;
  height: number;
  key: string; // 瓦片缓存键
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
  isTarget: boolean; // 是否为目标桶（1:1像素对齐）
}

export interface PageRenderState {
  targetBucket: RenderBucket;
  activeBucket: RenderBucket | null; // 当前显示的桶
  availableBuckets: RenderBucket[]; // 可用的桶
  lastStillTime: number; // 最后静止时间
  needsFadeTransition: boolean; // 是否需要淡入切换
}

// 常量定义已移至 src/components/PdfViewer/config.ts
