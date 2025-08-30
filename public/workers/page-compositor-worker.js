// Page Compositor Worker - OffscreenCanvas rendering with LRU cache
// Handles tile decoding, caching, and page composition to avoid main thread blocking

// Simple LRU Cache implementation for Worker environment
class WorkerLRUCache {
  constructor(maxSizeBytes) {
    this.maxSize = maxSizeBytes;
    this.currentSize = 0;
    this.cache = new Map(); // key -> { bitmap: ImageBitmap, size: number }
  }

  get(key) {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.bitmap;
    }
    return null;
  }

  set(key, bitmap) {
    // Estimate bitmap size (width * height * 4 bytes for RGBA)
    const size = (bitmap.width || 512) * (bitmap.height || 512) * 4;

    // Remove if already exists
    if (this.cache.has(key)) {
      const old = this.cache.get(key);
      this.currentSize -= old.size;
      this.cache.delete(key);
    }

    // Evict oldest entries if needed
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const [oldKey, oldEntry] = this.cache.entries().next().value;
      this.currentSize -= oldEntry.size;
      this.cache.delete(oldKey);
      // Close the evicted bitmap to free GPU memory
      try {
        if (oldEntry.bitmap.close) oldEntry.bitmap.close();
      } catch (e) { }
    }

    // Add new entry
    this.cache.set(key, { bitmap, size });
    this.currentSize += size;
  }

  clear() {
    // Close all bitmaps before clearing
    for (const [, entry] of this.cache) {
      try {
        if (entry.bitmap.close) entry.bitmap.close();
      } catch (e) { }
    }
    this.cache.clear();
    this.currentSize = 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      memoryUsage: this.currentSize,
      maxMemory: this.maxSize
    };
  }
}

// Global tile cache with 4GB limit
const tileCache = new WorkerLRUCache(4 * 1024 * 1024 * 1024);

// Handle messages from main thread
self.onmessage = async ({ data }) => {
  const { type, id } = data;

  try {
    switch (type) {
      case 'compose-page':
        await handlePageComposition(data);
        break;
      case 'clear-cache':
        tileCache.clear();
        self.postMessage({ type: 'cache-cleared', id });
        break;
      case 'get-cache-stats':
        self.postMessage({
          type: 'cache-stats',
          id,
          stats: tileCache.getStats()
        });
        break;
      default:
      // Unknown message type
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message
    });
  }
};

async function handlePageComposition(data) {
  const {
    id,
    tiles, // Array of { tileKey, data: Uint8Array, tx, ty }
    pageWidth,
    pageHeight,
    tileSize,
    tilesX,
    tilesY,
    dpr,
    scale
  } = data;

  const startTime = performance.now();
  let cacheHits = 0;
  let cacheMisses = 0;

  try {
    // Create OffscreenCanvas with proper DPR scaling
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.floor(pageWidth * dpr)),
      Math.max(1, Math.floor(pageHeight * dpr))
    );

    const ctx = canvas.getContext('2d');

    // Set up canvas transform for logical coordinates
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false; // 禁用抗锯齿，保持瓦片边界清晰
    ctx.imageSmoothingQuality = 'high';

    // Clear and fill with white background
    ctx.clearRect(0, 0, pageWidth, pageHeight);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, pageWidth, pageHeight);

    // Process each tile: check cache or decode
    const tileBitmaps = new Map();

    for (const tile of tiles) {
      const { tileKey, data, tx, ty } = tile;

      // Check cache first
      let bitmap = tileCache.get(tileKey);
      if (bitmap) {
        tileBitmaps.set(`${tx}_${ty}`, bitmap);
        cacheHits++;
      } else {
        // Cache miss: decode and cache
        try {
          const blob = new Blob([data], { type: 'image/webp' });
          bitmap = await createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
            resizeQuality: 'pixelated'
          });

          tileCache.set(tileKey, bitmap);
          tileBitmaps.set(`${tx}_${ty}`, bitmap);
          cacheMisses++;
        } catch (error) {
          // Failed to decode tile, continue with others
        }
      }
    }

    // Composite all tiles onto the canvas
    for (let tx = 0; tx < tilesX; tx++) {
      for (let ty = 0; ty < tilesY; ty++) {
        const bitmap = tileBitmaps.get(`${tx}_${ty}`);
        if (bitmap) {
          // 关键修复：确保瓦片按正确的逻辑尺寸绘制
          // Worker上下文已设置DPR transform，所以使用逻辑坐标绘制
          const x = tx * tileSize;
          const y = ty * tileSize;

          // 瓦片的逻辑尺寸（高DPR瓦片的显示尺寸）
          const drawWidth = Math.min(tileSize, bitmap.width / dpr);
          const drawHeight = Math.min(tileSize, bitmap.height / dpr);

          ctx.drawImage(bitmap, x, y, drawWidth, drawHeight);
        }
      }
    }

    // Create final ImageBitmap from composed canvas
    const finalBitmap = canvas.transferToImageBitmap();
    const totalTime = performance.now() - startTime;

    // Send result back to main thread
    self.postMessage({
      type: 'page-composed',
      id,
      imageBitmap: finalBitmap,
      performance: {
        totalTime,
        cacheHits,
        cacheMisses,
        cacheStats: tileCache.getStats()
      }
    }, [finalBitmap]); // Transfer ownership

  } catch (error) {
    self.postMessage({
      type: 'composition-error',
      id,
      error: error.message
    });
  }
}

