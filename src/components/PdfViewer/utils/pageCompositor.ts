// Page Compositor - Worker wrapper for OffscreenCanvas tile composition

export interface TileData {
  tileKey: string;
  data: Uint8Array;
  tx: number;
  ty: number;
}

export interface CompositionRequest {
  id: string;
  tiles: TileData[];
  pageWidth: number;
  pageHeight: number;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  dpr: number;
  scale: number;
}

export interface CompositionResult {
  imageBitmap: ImageBitmap;
  performance: {
    totalTime: number;
    cacheHits: number;
    cacheMisses: number;
    cacheStats: {
      size: number;
      memoryUsage: number;
      maxMemory: number;
    };
  };
}

export class PageCompositor {
  private worker: Worker | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: CompositionResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private requestCounter = 0;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    try {
      this.worker = new Worker("/workers/page-compositor-worker.js");
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);
      console.log("🎨 PageCompositor initialized");
    } catch (error) {
      console.error("Failed to create page compositor worker:", error);
      throw error;
    }
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { type, id, imageBitmap, performance, error, stats } = event.data;

    switch (type) {
      case "page-composed":
        this.handlePageComposed(id, imageBitmap, performance);
        break;
      case "composition-error":
        this.handleCompositionError(id, error);
        break;
      case "cache-cleared":
        console.log("🗑️ Worker tile cache cleared");
        break;
      case "cache-stats":
        console.log("📊 Worker cache stats:", stats);
        break;
      default:
        console.warn("Unknown worker message type:", type);
    }
  }

  private handleWorkerError(error: ErrorEvent) {
    console.error("Page compositor worker error:", error);
    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error(`Worker error: ${error.message}`));
    });
    this.pendingRequests.clear();
  }

  private handlePageComposed(id: string, imageBitmap: ImageBitmap, performance: any) {
    const request = this.pendingRequests.get(id);
    if (request) {
      request.resolve({ imageBitmap, performance });
      this.pendingRequests.delete(id);
    } else {
      console.warn("No pending request for composed page:", id);
      // Close orphaned bitmap
      try {
        if (imageBitmap.close) imageBitmap.close();
      } catch (e) {}
    }
  }

  private handleCompositionError(id: string, errorMessage: string) {
    const request = this.pendingRequests.get(id);
    if (request) {
      request.reject(new Error(errorMessage));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Compose a page from tiles using OffscreenCanvas in worker
   */
  composePage(request: Omit<CompositionRequest, "id">): Promise<CompositionResult> {
    if (!this.worker) {
      return Promise.reject(new Error("Worker not initialized"));
    }

    const id = `compose_${++this.requestCounter}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // Send composition request to worker
      this.worker!.postMessage({
        type: "compose-page",
        id,
        ...request,
      });
    });
  }

  /**
   * Clear the worker's tile cache
   */
  clearCache(): void {
    if (this.worker) {
      this.worker.postMessage({ type: "clear-cache", id: `clear_${Date.now()}` });
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): void {
    if (this.worker) {
      this.worker.postMessage({ type: "get-cache-stats", id: `stats_${Date.now()}` });
    }
  }

  /**
   * Destroy the worker and clean up
   */
  destroy(): void {
    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error("PageCompositor destroyed"));
    });
    this.pendingRequests.clear();

    // Terminate worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    console.log("🗑️ PageCompositor destroyed");
  }
}

// Global instance
export const pageCompositor = new PageCompositor();
