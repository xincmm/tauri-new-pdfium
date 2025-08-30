// Canvas 合成器 - 管理 OffscreenCanvas Worker 进行瓦片合成

export interface CompositionRequest {
  id: string;
  canvasWidth: number;
  canvasHeight: number;
  dpr: number;
  tiles: Record<string, ImageBitmap>;
  tilesX: number;
  tilesY: number;
  tileSize: number;
  pageInfo: {
    pdfId: string;
    pageIndex: number;
    scale: number;
    dpr: number;
  };
}

export interface CompositionResult {
  id: string;
  canvas?: OffscreenCanvas;
  bitmap?: ImageBitmap;
  drawnTiles: number;
  compositionTime: number;
}

type CompositionCallback = (result: CompositionResult | null, error?: string) => void;

class CanvasCompositor {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, CompositionCallback>();
  private isInitialized = false;
  private currentCanvasSize: { width: number; height: number; dpr: number } | null = null;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    try {
      this.worker = new Worker('/workers/canvas-compositor-worker.js');
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);
      console.log('🎨 CanvasCompositor initialized');
    } catch (error) {
      console.error('Failed to create canvas compositor worker:', error);
    }
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { type, id, error, ...data } = event.data;

    switch (type) {
      case 'canvas-ready':
        this.isInitialized = true;
        const readyCallback = this.pendingRequests.get(id);
        if (readyCallback) {
          readyCallback({ id, drawnTiles: 0, compositionTime: 0 });
          this.pendingRequests.delete(id);
        }
        break;

      case 'composition-complete':
        const callback = this.pendingRequests.get(id);
        if (callback) {
          callback({
            id,
            canvas: data.canvas,
            bitmap: data.bitmap,
            drawnTiles: data.drawnTiles,
            compositionTime: parseFloat(data.compositionTime)
          });
          this.pendingRequests.delete(id);
        }
        break;

      case 'error':
      case 'worker-error':
        const errorCallback = this.pendingRequests.get(id);
        if (errorCallback) {
          errorCallback(null, error);
          this.pendingRequests.delete(id);
        } else {
          console.error('Canvas compositor error:', error);
        }
        break;

      case 'canvas-cleared':
        // Canvas 清理完成，可以进行下一次初始化
        this.isInitialized = false;
        this.currentCanvasSize = null;
        break;

      default:
        console.warn('Unknown canvas compositor message:', type);
    }
  }

  private handleWorkerError(error: ErrorEvent) {
    console.error('Canvas compositor worker error:', error);
    // 通知所有等待的回调
    for (const [id, callback] of this.pendingRequests) {
      callback(null, `Worker error: ${error.message}`);
    }
    this.pendingRequests.clear();
  }

  async initCanvas(width: number, height: number, dpr: number): Promise<void> {
    if (!this.worker) {
      throw new Error('Canvas compositor worker not available');
    }

    // 检查是否需要重新初始化
    const needsInit = !this.isInitialized || 
      !this.currentCanvasSize ||
      this.currentCanvasSize.width !== width ||
      this.currentCanvasSize.height !== height ||
      this.currentCanvasSize.dpr !== dpr;

    if (!needsInit) {
      return Promise.resolve();
    }

    const id = `init-${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, (result, error) => {
        if (error) {
          reject(new Error(error));
        } else {
          this.currentCanvasSize = { width, height, dpr };
          resolve();
        }
      });

      this.worker!.postMessage({
        type: 'init-canvas',
        id,
        canvasWidth: width,
        canvasHeight: height,
        dpr
      });
    });
  }

  async compositeTiles(request: CompositionRequest): Promise<CompositionResult> {
    if (!this.worker) {
      throw new Error('Canvas compositor worker not available');
    }

    if (!this.isInitialized) {
      await this.initCanvas(request.canvasWidth, request.canvasHeight, request.dpr);
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, (result, error) => {
        if (error) {
          reject(new Error(error));
        } else if (result) {
          resolve(result);
        } else {
          reject(new Error('No result received'));
        }
      });

      // 转换 tiles Map 为可传输的对象
      const tilesData: Record<string, ImageBitmap> = {};
      for (const [key, bitmap] of Object.entries(request.tiles)) {
        tilesData[key] = bitmap;
      }

      this.worker!.postMessage({
        type: 'composite-tiles',
        id: request.id,
        tiles: tilesData,
        tilesX: request.tilesX,
        tilesY: request.tilesY,
        tileSize: request.tileSize,
        pageInfo: request.pageInfo
      });
    });
  }

  destroy() {
    if (this.worker) {
      // 通知所有等待的回调
      for (const [id, callback] of this.pendingRequests) {
        callback(null, 'Canvas compositor destroyed');
      }
      this.pendingRequests.clear();

      this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.currentCanvasSize = null;
      console.log('🗑️ CanvasCompositor destroyed');
    }
  }
}

// 全局单例
let globalCompositor: CanvasCompositor | null = null;

export function getCanvasCompositor(): CanvasCompositor {
  if (!globalCompositor) {
    globalCompositor = new CanvasCompositor();
  }
  return globalCompositor;
}

export function destroyCanvasCompositor() {
  if (globalCompositor) {
    globalCompositor.destroy();
    globalCompositor = null;
  }
} 