// 瓦片加载Worker - 用于网络请求和图像解码
// 这样可以避免主线程阻塞影响网络请求的完成事件

// 性能监控
new PerformanceObserver(list => {
  for (const entry of list.getEntriesByType('resource')) {
    if (!/\.webp|tiles|app-raw/.test(entry.name)) continue;

    const timing = {
      queueing: (entry.requestStart - entry.startTime).toFixed(1),
      ttfb: (entry.responseStart - entry.requestStart).toFixed(1),
      download: (entry.responseEnd - entry.responseStart).toFixed(1),
      total: (entry.responseEnd - entry.startTime).toFixed(1),
    };

    console.log('🔍 Worker ResourceTiming:', {
      url: entry.name,
      ...timing
    });

    // 发送性能数据到主线程
    self.postMessage({
      type: 'performance',
      data: {
        url: entry.name,
        timing,
        timestamp: Date.now()
      }
    });
  }
}).observe({ type: 'resource', buffered: true });

// 处理主线程发来的消息
self.onmessage = async ({ data }) => {
  const { type, id, url, options = {}, epoch } = data;

  try {
    switch (type) {
      case 'fetch-test':
        // 验证性能的简单fetch测试
        await handleFetchTest(id, url);
        break;

      case 'load-tile':
        // 完整的瓦片加载：网络 + 解码
        await handleTileLoad(id, url, options, epoch);
        break;

      case 'cancel-task':
        // 取消任务（通过AbortController）
        handleCancelTask(id);
        break;

      default:
        console.warn('Unknown worker message type:', type);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message
    });
  }
};

// 存储进行中的请求，支持取消
const inflightRequests = new Map();

// 处理fetch性能测试
async function handleFetchTest(id, url) {
  const startTime = performance.now();

  try {
    const response = await fetch(url, { cache: 'force-cache' });
    const arrayBuffer = await response.arrayBuffer();
    const endTime = performance.now();

    self.postMessage({
      type: 'fetch-test-result',
      id,
      success: true,
      size: arrayBuffer.byteLength,
      duration: endTime - startTime,
      headers: Object.fromEntries(response.headers.entries())
    });
  } catch (error) {
    self.postMessage({
      type: 'fetch-test-result',
      id,
      success: false,
      error: error.message
    });
  }
}

// 处理完整的瓦片加载
async function handleTileLoad(id, url, options, epoch) {
  const abortController = new AbortController();
  inflightRequests.set(id, abortController);

  const startTime = performance.now();
  let fetchTime = 0;
  let decodeTime = 0;

  try {
    // 网络请求阶段 - 使用更激进的缓存策略
    const fetchStart = performance.now();
    const response = await fetch(url, {
      cache: 'force-cache',
      signal: abortController.signal,
      priority: 'high', // 提升请求优先级
      ...options
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 直接使用arrayBuffer，避免blob转换
    const arrayBuffer = await response.arrayBuffer();
    fetchTime = performance.now() - fetchStart;

    // 解码阶段 - 直接从arrayBuffer创建ImageBitmap
    const decodeStart = performance.now();
    const blob = new Blob([arrayBuffer], { type: 'image/webp' });
    const imageBitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
      resizeQuality: 'pixelated' // 避免不必要的重采样
    });
    decodeTime = performance.now() - decodeStart;

    const totalTime = performance.now() - startTime;

    // 解析服务端性能数据
    const serverTiming = parseServerTiming(response.headers.get('Server-Timing'));
    const pixelInfo = parsePixelInfo(response.headers.get('X-Pixels'));

    // 发送成功结果（转移ImageBitmap所有权）
    self.postMessage({
      type: 'tile-loaded',
      id,
      epoch, // 包含epoch信息
      imageBitmap,
      performance: {
        fetchTime,
        decodeTime,
        totalTime,
        size: arrayBuffer.byteLength,
        serverTiming,
        pixelInfo
      }
    }, [imageBitmap]); // 转移ImageBitmap所有权

  } catch (error) {
    if (error.name === 'AbortError') {
      self.postMessage({
        type: 'tile-cancelled',
        id
      });
    } else {
      self.postMessage({
        type: 'tile-error',
        id,
        error: error.message
      });
    }
  } finally {
    inflightRequests.delete(id);
  }
}

// 取消任务
function handleCancelTask(id) {
  const abortController = inflightRequests.get(id);
  if (abortController) {
    abortController.abort();
    inflightRequests.delete(id);
  }
}

// 解析Server-Timing头
function parseServerTiming(serverTimingHeader) {
  if (!serverTimingHeader) return null;

  const timing = {};
  const entries = serverTimingHeader.split(',');

  for (const entry of entries) {
    const [name, durPart] = entry.trim().split(';');
    if (durPart && durPart.startsWith('dur=')) {
      const duration = parseFloat(durPart.substring(4));
      timing[name.trim()] = duration;
    }
  }

  return timing;
}

// 解析像素信息头
function parsePixelInfo(pixelHeader) {
  if (!pixelHeader) return null;

  const match = pixelHeader.match(/(\d+)x(\d+)/);
  if (match) {
    return {
      width: parseInt(match[1]),
      height: parseInt(match[2])
    };
  }

  return null;
}

console.log('🚀 Tile Loader Worker initialized'); 