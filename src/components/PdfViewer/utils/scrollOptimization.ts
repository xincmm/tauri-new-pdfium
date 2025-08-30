// 滚动优化工具函数 - 实现专家建议的三道保险机制

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScrollBlitResult {
  dirtyRects: DirtyRect[];
  blitPerformed: boolean;
}

export interface OverscanConfig {
  extraCols: number;
  extraRows: number;
}

export interface ScrollVelocity {
  vx: number; // 水平速度 px/ms
  vy: number; // 垂直速度 px/ms
}

/**
 * 第一道保险：画面复用（立刻有画面）
 * 将上一帧的像素整体平移，马上填满屏幕，只在新露出的边缘留下"待补"的细条带
 */
export function scrollBlit(ctx: CanvasRenderingContext2D, dx: number, dy: number): ScrollBlitResult {
  const canvas = ctx.canvas;
  const w = canvas.width;
  const h = canvas.height;

  // 计算源区域和目标区域
  const sx = dx < 0 ? -dx : 0;
  const sy = dy < 0 ? -dy : 0;
  const sw = w - Math.abs(dx);
  const sh = h - Math.abs(dy);

  const dirtyRects: DirtyRect[] = [];
  let blitPerformed = false;

  // 只有在有效区域时才进行 blit
  if (sw > 0 && sh > 0) {
    // 使用临时canvas避免自引用问题
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = sw;
    tempCanvas.height = sh;
    const tempCtx = tempCanvas.getContext("2d")!;

    // 先将需要保留的部分复制到临时canvas
    tempCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    // 清空主canvas
    ctx.clearRect(0, 0, w, h);

    // 将保留的部分绘制到新位置
    ctx.drawImage(tempCanvas, 0, 0, sw, sh, sx + dx, sy + dy, sw, sh);

    blitPerformed = true;

    // 计算需要补充的脏带区域
    if (dx !== 0) {
      dirtyRects.push({
        x: dx > 0 ? 0 : w + dx,
        y: 0,
        w: Math.abs(dx),
        h: h,
      });
    }

    if (dy !== 0) {
      dirtyRects.push({
        x: 0,
        y: dy > 0 ? 0 : h + dy,
        w: w,
        h: Math.abs(dy),
      });
    }
  } else {
    // 如果位移太大，整个屏幕都是脏区域
    dirtyRects.push({ x: 0, y: 0, w: w, h: h });
  }

  return { dirtyRects, blitPerformed };
}

/**
 * 第二道保险：可视区外预铺（大概率不需要补）
 * 根据滚动速度自适应计算 overscan 区域
 */
export function calculateOverscan(
  velocity: ScrollVelocity,
  tileWidth: number,
  tileHeight: number,
  predictionTimeMs: number = 95, // 95ms 预测时间
): OverscanConfig {
  // 防止除零错误
  const safeTileWidth = Math.max(1, tileWidth || 1);
  const safeTileHeight = Math.max(1, tileHeight || 1);

  // 根据速度计算需要预铺的瓦片数量
  const projectedDx = Math.abs(velocity.vx || 0) * predictionTimeMs;
  const projectedDy = Math.abs(velocity.vy || 0) * predictionTimeMs;

  const cols = Math.min(4, Math.ceil(projectedDx / safeTileWidth) + 1);
  const rows = Math.min(4, Math.ceil(projectedDy / safeTileHeight) + 1);

  return {
    extraCols: Math.max(1, isNaN(cols) ? 1 : cols),
    extraRows: Math.max(1, isNaN(rows) ? 1 : rows),
  };
}

/**
 * 计算滚动速度
 */
export function calculateScrollVelocity(
  currentScrollY: number,
  lastScrollY: number,
  deltaTime: number,
): ScrollVelocity {
  if (deltaTime <= 0 || isNaN(deltaTime)) {
    return { vx: 0, vy: 0 };
  }

  const deltaY = (currentScrollY || 0) - (lastScrollY || 0);
  const velocity = deltaY / deltaTime;

  return {
    vx: 0, // PDF查看器主要是垂直滚动
    vy: isNaN(velocity) ? 0 : velocity,
  };
}

/**
 * 第三道保险：占位整页兜底
 * 判断是否可以显示某个清晰度的图片（只缩不放原则）
 */
export function canShowWithoutUpscaling(
  srcWidth: number,
  srcHeight: number,
  needWidth: number,
  needHeight: number,
): boolean {
  return srcWidth >= needWidth && srcHeight >= needHeight;
}

/**
 * 判断是否为大跳转（需要整页占位兜底）
 */
export function isLargeJump(
  deltaY: number,
  viewportHeight: number,
  threshold: number = 1.0, // 超过一屏的比例
): boolean {
  return Math.abs(deltaY) > viewportHeight * threshold;
}

/**
 * 计算瓦片优先级（近→远优先）
 */
export function calculateTilePriority(
  tileY: number,
  tileHeight: number,
  viewportTop: number,
  viewportHeight: number,
): number {
  const tileCenter = tileY + tileHeight / 2;
  const viewportCenter = viewportTop + viewportHeight / 2;
  const distance = Math.abs(tileCenter - viewportCenter);

  // 距离越近，优先级越高（数值越小）
  return distance;
}

/**
 * 生成取消信号用于中断远距离瓦片加载
 */
export function createAbortController(): AbortController {
  return new AbortController();
}

/**
 * 检查瓦片是否在overscan区域内
 */
export function isTileInOverscanArea(
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
  viewportLeft: number,
  viewportTop: number,
  viewportWidth: number,
  viewportHeight: number,
  overscan: OverscanConfig,
): boolean {
  const expandedLeft = viewportLeft - overscan.extraCols * tileWidth;
  const expandedTop = viewportTop - overscan.extraRows * tileHeight;
  const expandedRight = viewportLeft + viewportWidth + overscan.extraCols * tileWidth;
  const expandedBottom = viewportTop + viewportHeight + overscan.extraRows * tileHeight;

  const tileRight = tileX + tileWidth;
  const tileBottom = tileY + tileHeight;

  return tileX < expandedRight && tileRight > expandedLeft && tileY < expandedBottom && tileBottom > expandedTop;
}

/**
 * 性能统计：计算未就绪面积比例
 */
export function calculateUnreadyAreaRatio(
  viewportWidth: number,
  viewportHeight: number,
  unreadyRects: DirtyRect[],
): number {
  const totalViewportArea = viewportWidth * viewportHeight;
  if (totalViewportArea === 0) return 0;

  const unreadyArea = unreadyRects.reduce((sum, rect) => {
    return sum + rect.w * rect.h;
  }, 0);

  return unreadyArea / totalViewportArea;
}
