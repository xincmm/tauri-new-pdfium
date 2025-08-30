import { RenderBucket } from '@/PdfViewer/types/pdf';
import { BUCKET_STRATEGY } from '@/PdfViewer/config';

/**
 * 生成渲染桶配置
 * @param targetScale 目标缩放比例
 * @returns 渲染桶数组，按优先级排序
 */
export function generateRenderBuckets(targetScale: number): RenderBucket[] {
  const buckets: RenderBucket[] = [
    {
      scale: targetScale * BUCKET_STRATEGY.TARGET_FACTOR,
      key: 'target',
      isTarget: true,
    },
    {
      scale: targetScale * BUCKET_STRATEGY.HIGHER_FACTOR,
      key: 'higher',
      isTarget: false,
    },
    {
      scale: targetScale * BUCKET_STRATEGY.LOWER_FACTOR,
      key: 'lower',
      isTarget: false,
    },
  ];

  // 按scale降序排列，优先使用更清晰的桶
  return buckets.sort((a, b) => b.scale - a.scale);
}

/**
 * 选择最佳可用桶作为占位图
 * @param buckets 可用桶列表
 * @param targetScale 目标缩放比例
 * @returns 最佳桶，优先选择 >= 目标清晰度的桶
 */
export function selectBestAvailableBucket(
  buckets: RenderBucket[],
  targetScale: number
): RenderBucket | null {
  if (buckets.length === 0) return null;

  // 首先查找 >= 目标清晰度的桶
  const suitableBuckets = buckets.filter(bucket => bucket.scale >= targetScale);
  
  if (suitableBuckets.length > 0) {
    // 选择最接近目标清晰度的桶（避免过度清晰造成资源浪费）
    return suitableBuckets.reduce((best, current) => 
      Math.abs(current.scale - targetScale) < Math.abs(best.scale - targetScale) 
        ? current : best
    );
  }

  // 如果没有 >= 目标清晰度的桶，选择最清晰的可用桶
  return buckets[0]; // 已按scale降序排列
}

/**
 * 判断是否需要加载目标桶
 * @param activeBucket 当前活动桶
 * @param targetBucket 目标桶
 * @param targetScale 目标缩放比例
 * @returns 是否需要加载目标桶
 */
export function shouldLoadTargetBucket(
  activeBucket: RenderBucket | null,
  targetBucket: RenderBucket,
  targetScale: number
): boolean {
  if (!activeBucket) return true;

  // 如果当前桶已经是目标桶，不需要加载
  if (activeBucket.isTarget && activeBucket.scale === targetBucket.scale) {
    return false;
  }

  // 如果当前桶的清晰度 >= 目标清晰度，且不是过度清晰，则不需要加载目标桶
  if (activeBucket.scale >= targetScale) {
    // 但如果过度清晰（超过目标20%），仍然需要加载目标桶以节省资源
    const overSharpThreshold = targetScale * 1.2;
    return activeBucket.scale > overSharpThreshold;
  }

  // 当前桶清晰度不足，需要加载目标桶
  return true;
}

/**
 * 判断是否应该切换到目标桶
 * @param activeBucket 当前活动桶
 * @param targetBucket 目标桶
 * @param isStill 是否静止状态
 * @param stillDuration 静止持续时间
 * @param targetBucketReady 目标桶是否准备好
 * @returns 是否应该切换
 */
export function shouldSwitchToTargetBucket(
  activeBucket: RenderBucket | null,
  targetBucket: RenderBucket,
  isStill: boolean,
  stillDuration: number,
  targetBucketReady: boolean
): boolean {
  if (!activeBucket || !targetBucketReady || !isStill) {
    return false;
  }

  // 如果已经是目标桶，不需要切换
  if (activeBucket.isTarget && activeBucket.scale === targetBucket.scale) {
    return false;
  }

  // 静止时间足够长，且目标桶准备好，切换到目标桶获得最佳像素对齐
  return stillDuration >= BUCKET_STRATEGY.FADE_DELAY_MS;
}

/**
 * 生成桶的缓存键
 * @param bucket 渲染桶
 * @param tileInfo 基础瓦片信息
 * @returns 缓存键
 */
export function generateBucketTileKey(
  bucket: RenderBucket,
  tileInfo: { id: string; page: number; tx: number; ty: number }
): string {
  return `${bucket.key}_${tileInfo.id}_p${tileInfo.page}_s${Math.round(bucket.scale * 100)}_${tileInfo.tx}_${tileInfo.ty}`;
} 