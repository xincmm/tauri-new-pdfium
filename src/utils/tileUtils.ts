import { TileInfo, POSTER_SCALE_FACTOR } from '../types/pdf';

// 获取瓦片URL
export const getTileUrl = (
  tileInfo: TileInfo,
  devicePixelRatio: number,
  isHighRes: boolean = true
): string => {
  const { id, page, scale, tx, ty } = tileInfo;
  // 根据设备像素比调整请求的缩放级别，确保高DPI屏幕的清晰度
  const baseScale = isHighRes ? scale * devicePixelRatio : scale * devicePixelRatio * POSTER_SCALE_FACTOR;
  const adjustedScale = Math.max(0.1, baseScale); // 确保最小缩放不为0
  return `tiles://localhost/${id}/${page}/${adjustedScale}/${tx}/${ty}.webp`;
};

// 获取页面海报图URL（整页低分辨率图像）
export const getPagePosterUrl = (
  pdfId: string,
  pageIndex: number,
  devicePixelRatio: number
): string => {
  const scale = POSTER_SCALE_FACTOR * devicePixelRatio;
  // 使用特殊坐标 (-1, -1) 来请求整页图像
  // 在URL中，-1会被解析为 4294967295 (u32::MAX)
  return `tiles://localhost/${pdfId}/${pageIndex}/${scale}/4294967295/4294967295.webp`;
};

// 生成瓦片缓存键
export const generateTileKey = (tileInfo: TileInfo): string => {
  return `${tileInfo.id}_${tileInfo.page}_${tileInfo.scale}_${tileInfo.tx}_${tileInfo.ty}`;
};

// 生成海报图缓存键
export const generatePosterKey = (pdfId: string, pageIndex: number): string => {
  return `poster_${pdfId}_${pageIndex}`;
}; 