import { LRUCache } from 'lru-cache';

// Bucket caches by quantized scale (e.g., 1.25, 1.5, ...)
function bucketizeScale(scale: number): string {
  const q = Math.round(scale * 4) / 4; // quarter-step quantization
  return `s${q.toFixed(2)}`;
}

function estimateBitmapBytes(bitmap: ImageBitmap): number {
  const w = Math.max(1, (bitmap as any).width || 0);
  const h = Math.max(1, (bitmap as any).height || 0);
  return w * h * 4; // RGBA bytes
}

function getBucketConfig(scale: number) {
  // Heuristic memory budgets per bucket (in bytes). Global cap still enforces <= 500MB overall.
  if (scale > 4) return { maxSize: 128 * 1024 * 1024 }; // 128MB
  if (scale > 2.5) return { maxSize: 192 * 1024 * 1024 }; // 192MB
  return { maxSize: 256 * 1024 * 1024 }; // 256MB
}

// Global cache with 500MB total cap; coordinates eviction with buckets
type GlobalEntry = { bitmap: ImageBitmap; bucketKey: string };
const GLOBAL_MAX_BYTES = 4000 * 1024 * 1024;

const globalCache = new LRUCache<string, GlobalEntry>({
  maxSize: GLOBAL_MAX_BYTES,
  sizeCalculation: (entry) => estimateBitmapBytes(entry.bitmap),
  dispose: (entry, key) => {
    try {
      // Remove from its bucket cache if present
      const bucket = scaleBucketToCache.get(entry.bucketKey);
      if (bucket && bucket.has(key)) {
        bucket.delete(key);
      }
      // Release GPU/decoded resources when evicted
      // @ts-ignore
      if (typeof (entry.bitmap as any).close === 'function') {
        // @ts-ignore
        (entry.bitmap as any).close();
      }
    } catch {}
  },
});

const scaleBucketToCache = new Map<string, LRUCache<string, ImageBitmap>>();

function createBucketCache(scale: number): LRUCache<string, ImageBitmap> {
  const { maxSize } = getBucketConfig(scale);
  return new LRUCache<string, ImageBitmap>({
    maxSize,
    sizeCalculation: (bitmap) => estimateBitmapBytes(bitmap),
    // Do NOT dispose here; global cache will own the resource release to avoid double-closing
  });
}

function getBucketCache(scale: number): { bucketKey: string; cache: LRUCache<string, ImageBitmap> } {
  const bucketKey = bucketizeScale(scale);
  let cache = scaleBucketToCache.get(bucketKey);
  if (!cache) {
    cache = createBucketCache(scale);
    scaleBucketToCache.set(bucketKey, cache);
  }
  return { bucketKey, cache };
}

export function getCachedTile(tileKey: string, scale: number): ImageBitmap | undefined {
  // First try global (also refreshes recency globally)
  const global = globalCache.get(tileKey);
  if (global) {
    // Ensure bucket also gets a recency bump
    const bucket = scaleBucketToCache.get(global.bucketKey);
    if (bucket && bucket.has(tileKey)) {
      const val = bucket.get(tileKey);
      if (val) bucket.set(tileKey, val);
    }
    return global.bitmap;
  }
  // Fallback to bucket (should be rare; sync back to global if hit)
  const { bucketKey, cache } = getBucketCache(scale);
  const bitmap = cache.get(tileKey);
  if (bitmap) {
    globalCache.set(tileKey, { bitmap, bucketKey });
  }
  return bitmap;
}

export function setCachedTile(tileKey: string, bitmap: ImageBitmap, scale: number): void {
  const { bucketKey, cache } = getBucketCache(scale);
  cache.set(tileKey, bitmap);
  globalCache.set(tileKey, { bitmap, bucketKey });
}

export function clearScaleBucket(scale: number): void {
  const { bucketKey, cache } = getBucketCache(scale);
  // Remove all keys from global to release resources
  for (const key of cache.keys()) {
    globalCache.delete(key);
  }
  cache.clear();
  scaleBucketToCache.delete(bucketKey);
}

export function clearAllTileCaches(): void {
  globalCache.clear();
  for (const cache of scaleBucketToCache.values()) {
    cache.clear();
  }
  scaleBucketToCache.clear();
} 