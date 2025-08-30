// Canvas 合成 Worker - 使用 OffscreenCanvas 进行瓦片合成
// 避免主线程进行大量 drawImage 操作

let offscreenCanvas = null;
let offscreenCtx = null;
let currentCompositionId = null;

// 处理主线程发来的消息
self.onmessage = async ({ data }) => {
  const { type, id, canvasWidth, canvasHeight, dpr, tiles, tilesX, tilesY, tileSize, pageInfo } = data;

  try {
    switch (type) {
      case 'init-canvas':
        await handleInitCanvas(id, canvasWidth, canvasHeight, dpr);
        break;

      case 'composite-tiles':
        await handleCompositeTiles(id, tiles, tilesX, tilesY, tileSize, pageInfo);
        break;

      case 'clear-canvas':
        await handleClearCanvas(id);
        break;

      default:
        console.warn('Unknown canvas worker message type:', type);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message,
      timestamp: Date.now()
    });
  }
};

async function handleInitCanvas(id, width, height, dpr) {
  try {
    // 创建 OffscreenCanvas
    const physicalWidth = Math.max(1, Math.floor(width * dpr));
    const physicalHeight = Math.max(1, Math.floor(height * dpr));

    offscreenCanvas = new OffscreenCanvas(physicalWidth, physicalHeight);
    offscreenCtx = offscreenCanvas.getContext('2d');

    if (!offscreenCtx) {
      throw new Error('Failed to get OffscreenCanvas 2D context');
    }

    // 设置高分屏绘制参数
    offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offscreenCtx.imageSmoothingEnabled = true;
    offscreenCtx.imageSmoothingQuality = 'high';

    console.log(`🎨 OffscreenCanvas initialized: ${physicalWidth}x${physicalHeight} (DPR: ${dpr})`);

    self.postMessage({
      type: 'canvas-ready',
      id,
      width: physicalWidth,
      height: physicalHeight,
      timestamp: Date.now()
    });
  } catch (error) {
    throw new Error(`Canvas init failed: ${error.message}`);
  }
}

async function handleCompositeTiles(id, tilesData, tilesX, tilesY, tileSize, pageInfo) {
  if (!offscreenCanvas || !offscreenCtx) {
    throw new Error('OffscreenCanvas not initialized');
  }

  // 取消之前的合成任务
  currentCompositionId = id;

  const startTime = performance.now();

  try {
    // 清空画布并填充白色背景
    const logicalWidth = Math.floor(offscreenCanvas.width / (pageInfo.dpr || 1));
    const logicalHeight = Math.floor(offscreenCanvas.height / (pageInfo.dpr || 1));

    offscreenCtx.clearRect(0, 0, logicalWidth, logicalHeight);
    offscreenCtx.fillStyle = 'white';
    offscreenCtx.fillRect(0, 0, logicalWidth, logicalHeight);

    let drawnTiles = 0;

    // 按行优先顺序绘制瓦片
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        // 检查是否需要取消当前合成
        if (currentCompositionId !== id) {
          console.log(`🚫 Canvas composition cancelled: ${id}`);
          return;
        }

        const tileKey = `${pageInfo.pdfId}_${pageInfo.pageIndex}_${pageInfo.scale}_${tx}_${ty}_dpr${pageInfo.dpr}`;
        const tileImageBitmap = tilesData[tileKey];

        if (tileImageBitmap) {
          const x = tx * tileSize;
          const y = ty * tileSize;
          offscreenCtx.drawImage(tileImageBitmap, x, y, tileSize, tileSize);
          drawnTiles++;
        }

        // 每绘制一行后让出控制权
        if (tx === tilesX - 1) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }

    const compositionTime = performance.now() - startTime;

    // 将 OffscreenCanvas 转移到主线程
    const transferableCanvas = offscreenCanvas.transferControlToOffscreen
      ? offscreenCanvas
      : null;

    if (transferableCanvas) {
      // 如果支持 transferControlToOffscreen，直接转移控制权
      self.postMessage({
        type: 'composition-complete',
        id,
        canvas: transferableCanvas,
        drawnTiles,
        compositionTime: compositionTime.toFixed(2),
        timestamp: Date.now()
      }, [transferableCanvas]);
    } else {
      // 回退方案：转为 ImageBitmap
      const bitmap = offscreenCanvas.transferToImageBitmap();
      self.postMessage({
        type: 'composition-complete',
        id,
        bitmap,
        drawnTiles,
        compositionTime: compositionTime.toFixed(2),
        timestamp: Date.now()
      }, [bitmap]);
    }

    console.log(`✅ Canvas composition complete: ${drawnTiles} tiles in ${compositionTime.toFixed(2)}ms`);

  } catch (error) {
    throw new Error(`Tile composition failed: ${error.message}`);
  }
}

async function handleClearCanvas(id) {
  if (!offscreenCanvas || !offscreenCtx) {
    return;
  }

  const logicalWidth = Math.floor(offscreenCanvas.width / 2); // 假设 DPR = 2
  const logicalHeight = Math.floor(offscreenCanvas.height / 2);

  offscreenCtx.clearRect(0, 0, logicalWidth, logicalHeight);

  self.postMessage({
    type: 'canvas-cleared',
    id,
    timestamp: Date.now()
  });
}

// 错误处理
self.onerror = (error) => {
  console.error('Canvas Worker Error:', error);
  self.postMessage({
    type: 'worker-error',
    error: error.message,
    timestamp: Date.now()
  });
};

console.log('🎨 Canvas Compositor Worker initialized'); 