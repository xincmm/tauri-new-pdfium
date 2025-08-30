import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { PdfMetadata, getPageDimensions, TILE_SIZE } from '../../types/pdf';
import { calculatePageLayouts, getExpandedVisiblePages, getVisiblePages } from '../../utils/pdfLayout';
import { PRELOAD_PAGES_AHEAD, SCROLL_DEBOUNCE_MS } from '../../types/pdf';
import { batchTileLoader } from '../../utils/batchTileLoader';
import { pageCompositor, type TileData } from '../../utils/pageCompositor';
import { useRenderQueue } from './hooks/useRenderQueue';
import { H_PADDING, SLOW_SPEED_THRESHOLD, SLOW_PREFETCH_PAGES, IDLE_ENQUEUE_LIMIT, DPR_MAX } from './config';

interface PageRenderInfo {
  pageIndex: number;
  imageBitmap: ImageBitmap | null;
  isLoading: boolean;
  lastRendered: number;
}

// 计算瓦片计划的纯函数
function calculateTilePlan(
  scale: number,
  pageWidth: number,
  pageHeight: number,
  tileSize: number,
  viewportTop: number,
  viewportHeight: number,
  pageTopAbs: number
) {
  const tilesX = Math.max(1, Math.ceil(pageWidth / tileSize));
  const tilesY = Math.max(1, Math.ceil(pageHeight / tileSize));

  // 简化版：对于单Canvas模式，暂时使用全页加载
  // 后续可以根据需要优化为半页/行级加载
  const tilesToLoad = [] as Array<{ tx: number; ty: number }>;
  for (let tx = 0; tx < tilesX; tx++) {
    for (let ty = 0; ty < tilesY; ty++) {
      tilesToLoad.push({ tx, ty });
    }
  }

  return { tilesToLoad, tilesX, tilesY };
}

export const SingleCanvasViewer: React.FC = () => {
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState({
    scale: 1,
    scrollY: 0,
    scrollX: 0,
  });
  const lastScrollYRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [isScrollIdle, setIsScrollIdle] = useState<boolean>(true);
  const idleTimerRef = useRef<number | null>(null);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);
  const initialCenteredRef = useRef<boolean>(false);
  const targetScrollRef = useRef<{ x: number | null; y: number | null }>({ x: null, y: null });

  // 页面渲染信息管理 - 使用 ref 避免依赖循环
  const pageRenderMapRef = useRef<Map<number, PageRenderInfo>>(new Map());
  const [renderVersion, setRenderVersion] = useState(0); // 用于触发重绘
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, DPR_MAX);

  // 新增：滚动速度/方向（用于动态预加载）
  const lastTsRef = useRef<number | null>(null);
  const velocityEmaRef = useRef<number>(0);
  const [scrollSpeedPxPerMs, setScrollSpeedPxPerMs] = useState<number>(0);
  const [scrollDirection, setScrollDirection] = useState<-1 | 0 | 1>(0);

  // 滚动中前向单页低并发预取保护
  const scrollPrefetchRef = useRef<boolean>(false);

  // 监听容器高度变化
  useEffect(() => {
    const updateHeight = () => {
      const h = containerRef.current?.clientHeight ?? window.innerHeight;
      setContainerHeight(h);
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  // 计算页面布局
  const pageLayouts = useMemo(() => {
    if (!pdfMetadata) return [] as Array<{ pageIndex: number; y: number; width: number; height: number }>;
    return calculatePageLayouts(pdfMetadata, viewState);
  }, [pdfMetadata, viewState.scale]);

  // 最大页宽与内容区域宽度（用于横向滚动）
  const maxPageWidth = useMemo(() => {
    if (!pageLayouts || pageLayouts.length === 0) return 0;
    return Math.max(...pageLayouts.map(l => l.width));
  }, [pageLayouts]);
  const totalWidth = useMemo(() => (maxPageWidth > 0 ? H_PADDING * 2 + maxPageWidth : 0), [maxPageWidth]);

  // 在布局变化或缩放后，如果内容宽于视口且用户未交互，则自动将水平滚动条置于居中位置
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cw = container.clientWidth;
    if (cw <= 0 || maxPageWidth <= 0) return;

    const contentWidth = H_PADDING * 2 + maxPageWidth;

    if (contentWidth > cw && !hasInteracted) {
      const targetLeft = Math.max(0, H_PADDING + (maxPageWidth - cw) / 2);
      // 仅当与现有位置相差较大时才设置，避免抖动
      if (Math.abs(container.scrollLeft - targetLeft) > 1) {
        container.scrollLeft = targetLeft;
        setViewState(prev => ({ ...prev, scrollX: targetLeft }));
      }
      initialCenteredRef.current = true;
    }
  }, [maxPageWidth, viewState.scale]);

  // 根据速度计算动态预加载窗口大小
  const getDynamicPreloadAhead = useCallback((speedPxPerMs: number) => {
    // 经验阈值，可在顶部集中配置
    if (speedPxPerMs < 0.05) return 2;      // 非常慢
    if (speedPxPerMs < 0.15) return 4;      // 慢速
    if (speedPxPerMs < 0.3) return 6;       // 中速
    if (speedPxPerMs < 0.6) return 8;       // 略快
    return 10;                               // 快速/拖动
  }, []);

  // 计算可见页面：初次打开仅渲染首屏；交互后动态扩展预加载窗口
  const visibleLayouts = useMemo(() => {
    if (!pdfMetadata) return [] as Array<{ pageIndex: number; y: number; width: number; height: number }>;
    if (!hasInteracted) {
      const baseVisible = getVisiblePages(
        pageLayouts,
        containerHeight,
        viewState.scrollY
      );
      if (baseVisible.length === 0) return [] as typeof pageLayouts;
      const firstIdx = baseVisible[0].pageIndex;
      const lastIdx = baseVisible[baseVisible.length - 1].pageIndex;
      const endIdx = Math.min(pageLayouts.length - 1, lastIdx + 2);
      return pageLayouts.filter(l => l.pageIndex >= firstIdx && l.pageIndex <= endIdx);
    }

    const dynamicAhead = getDynamicPreloadAhead(scrollSpeedPxPerMs);
    return getExpandedVisiblePages(
      pageLayouts,
      containerHeight,
      viewState.scrollY,
      lastScrollYRef.current,
      dynamicAhead
    );
  }, [pdfMetadata, pageLayouts, containerHeight, viewState.scrollY, hasInteracted, getDynamicPreloadAhead, scrollSpeedPxPerMs]);

  const totalHeight = pageLayouts.length > 0 
    ? pageLayouts[pageLayouts.length - 1].y + pageLayouts[pageLayouts.length - 1].height + 50 
    : 0;

  // 渲染单个页面到 ImageBitmap
  const renderPageToBitmap = useCallback(async (pageIndex: number, pageLayout: any) => {
    const { tilesToLoad, tilesX, tilesY } = calculateTilePlan(
      viewState.scale,
      pageLayout.width,
      pageLayout.height,
      TILE_SIZE,
      viewState.scrollY,
      containerHeight,
      pageLayout.y + 40
    );

    if (tilesToLoad.length === 0) return null;

    try {
      // 1. 获取瓦片数据
      const requests: any[] = [];
      for (const { tx, ty } of tilesToLoad) {
        requests.push({
          pdfId: pdfMetadata!.id,
          pageIndex,
          tx,
          ty,
          scale: viewState.scale,
          dpr: devicePixelRatio,
          pageWidth: pageLayout.width,
          pageHeight: pageLayout.height,
          tileKey: `${pdfMetadata!.id}_${pageIndex}_${viewState.scale}_${tx}_${ty}_dpr${devicePixelRatio}`,
        });
      }

      // 2. 批量获取瓦片数据
      const batchResult = await batchTileLoader.renderTilesBatch(requests);
      
      // 3. 准备 Worker 合成数据
      const tiles: TileData[] = batchResult.tiles.map((tileData, index) => ({
        tileKey: requests[index].tileKey,
        data: tileData.data,
        tx: requests[index].tx,
        ty: requests[index].ty,
      }));

      // 4. 发送给 Worker 进行合成
      const compositionResult = await pageCompositor.composePage({
        tiles,
        pageWidth: pageLayout.width,
        pageHeight: pageLayout.height,
        tileSize: TILE_SIZE,
        tilesX,
        tilesY,
        dpr: devicePixelRatio,
        scale: viewState.scale,
      });

      return compositionResult.imageBitmap;
    } catch (error) {
      return null;
    }
  }, [pdfMetadata, viewState.scale, devicePixelRatio]); // 移除变化频繁的依赖

  // 更新页面渲染状态
  const updatePageRender = useCallback(async (pageIndex: number, pageLayout: any) => {
    const current = pageRenderMapRef.current.get(pageIndex);
    if (current?.isLoading) return; // 避免重复渲染

    pageRenderMapRef.current.set(pageIndex, { 
      pageIndex, 
      imageBitmap: null, 
      isLoading: true, 
      lastRendered: 0 
    });

    const bitmap = await renderPageToBitmap(pageIndex, pageLayout);
    
    // 释放旧的 bitmap
    if (current?.imageBitmap) {
      try {
        (current.imageBitmap as any).close?.();
      } catch (e) {}
    }
    
    pageRenderMapRef.current.set(pageIndex, {
      pageIndex,
      imageBitmap: bitmap,
      isLoading: false,
      lastRendered: Date.now(),
    });

    // 触发重绘
    setRenderVersion(prev => prev + 1);
  }, [renderPageToBitmap]);

  // 渲染队列（单并发、可取消）
  const { enqueue, bumpEpoch, setEnabled } = useRenderQueue(async (idx, layout) => {
    await updatePageRender(idx, layout);
  });

  // 绘制所有可见页面到单个 Canvas
  const drawToCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfMetadata) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = devicePixelRatio;
    const containerWidth = containerRef.current?.clientWidth || window.innerWidth;

    // 设置 Canvas 尺寸 - 物理像素
    canvas.width = Math.max(1, Math.floor(containerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(containerHeight * dpr));
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;

    // 设置变换 - 与SimplePage一致，使用DPR缩放
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false; // 禁用抗锯齿，保持清晰度
    ctx.imageSmoothingQuality = 'high';

    // 清空画布（使用逻辑坐标）
    ctx.clearRect(0, 0, containerWidth, containerHeight);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, containerWidth, containerHeight);

    // 计算视口范围（逻辑像素）
    const viewportTop = viewState.scrollY;
    const viewportBottom = viewState.scrollY + containerHeight;
    // 当内容宽度小于视口时，内容整体居中显示
    // 使页面在视口更自然地居中：以最大页宽为基准进行居中
    const baseOffset = Math.max(0, (containerWidth - maxPageWidth) / 2 - H_PADDING);

    // 绘制所有可见页面
    for (const layout of visibleLayouts) {
      const pageTop = layout.y + 40; // 加上padding
      const pageBottom = pageTop + layout.height;

      // 检查页面是否在垂直视口内
      if (pageBottom < viewportTop || pageTop > viewportBottom) continue;

      // 计算页面在内容区的左侧位置（逻辑像素）
      const pageLeft = baseOffset + H_PADDING + (maxPageWidth - layout.width) / 2;

      // 计算页面在画布上的位置（逻辑像素）
      const canvasX = pageLeft - viewState.scrollX;
      const canvasY = pageTop - viewState.scrollY;

      const pageInfo = pageRenderMapRef.current.get(layout.pageIndex);
      
      if (pageInfo?.imageBitmap) {
        // 有内容：绘制实际页面
        try {
          const bitmap = pageInfo.imageBitmap;
          if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
            ctx.drawImage(
              bitmap,
              canvasX,
              canvasY,
              layout.width,
              layout.height
            );
          }
        } catch (error) {
          // 静默处理错误，绘制空白页
          pageRenderMapRef.current.delete(layout.pageIndex);
        }
      } else {
        // 无内容：绘制空白页占位
        if (pageInfo?.isLoading) {
          // 加载中：纯白背景
          ctx.fillStyle = 'white';
          ctx.fillRect(canvasX, canvasY, layout.width, layout.height);
        } else {
          // 未开始加载：浅灰背景 + 页码
          ctx.fillStyle = '#fafafa';
          ctx.fillRect(canvasX, canvasY, layout.width, layout.height);
          
          // 绘制页码
          ctx.fillStyle = '#ccc';
          ctx.font = `${Math.max(12, 16 / dpr)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            `${layout.pageIndex + 1}`,
            canvasX + layout.width / 2,
            canvasY + layout.height / 2
          );
        }
      }

      // 绘制页面边框
      ctx.strokeStyle = '#d0d0d0';
      ctx.lineWidth = 1 / dpr;
      ctx.strokeRect(canvasX, canvasY, layout.width, layout.height);
    }
  }, [pdfMetadata, visibleLayouts, containerHeight, devicePixelRatio, viewState.scrollY, viewState.scrollX, maxPageWidth]);

  // 管理页面渲染 - 使用稳定的key避免循环
  const visiblePagesKey = useMemo(() => {
    return visibleLayouts.map(l => l.pageIndex).join(',');
  }, [visibleLayouts]);

  useEffect(() => {
    if (!isScrollIdle || !pdfMetadata) return;

    // 停止滚动：允许队列运行
    setEnabled(true);

    // 以视口中心的距离作为优先级，越近优先级越高
    const viewportCenter = viewState.scrollY + containerHeight / 2;
    const candidates = visibleLayouts
      .map(l => ({
        layout: l,
        distance: Math.abs((l.y + 40 + l.height / 2) - viewportCenter),
      }))
      .sort((a, b) => a.distance - b.distance);

    // 限制一次加入的任务数量，避免长队列（来自配置）

    let count = 0;
    for (const { layout } of candidates) {
      if (count >= IDLE_ENQUEUE_LIMIT) break;
      const pageInfo = pageRenderMapRef.current.get(layout.pageIndex);
      if (!pageInfo || (!pageInfo.imageBitmap && !pageInfo.isLoading)) {
        // 距离越近优先级越高（转换为更小的数值）
        const priority = count; // 0,1,2,3
        enqueue({ pageIndex: layout.pageIndex, layout, priority });
        count++;
      }
    }
  }, [visiblePagesKey, isScrollIdle, pdfMetadata, enqueue, setEnabled, viewState.scrollY, containerHeight]);

  // 滚动中：禁用队列并提升epoch（取消旧任务）
  useEffect(() => {
    if (!pdfMetadata) return;
    if (!isScrollIdle) {
      // 滚动时禁用队列并取消旧任务
      setEnabled(false);
      bumpEpoch();
    } else {
      // 停止滚动后，重置epoch，确保新的请求立即开始
      bumpEpoch();
    }
  }, [isScrollIdle, pdfMetadata, bumpEpoch, setEnabled]);

  // 滚动中前向低并发预取：慢速滚动时预取前向最多3页，按优先级排队
  useEffect(() => {
    if (isScrollIdle || !pdfMetadata) return;
    if (scrollSpeedPxPerMs >= SLOW_SPEED_THRESHOLD) return; // 快速滚动：不预取
    if (visibleLayouts.length === 0) return;

    const indices = [...visibleLayouts.map(l => l.pageIndex)].sort((a, b) => a - b);
    const first = indices[0];
    const last = indices[indices.length - 1];

    const start = scrollDirection >= 0 ? last + 1 : first - 1;
    const step = scrollDirection >= 0 ? 1 : -1;

    let priority = 5;
    for (let i = 0; i < SLOW_PREFETCH_PAGES; i++) {
      const idx = start + i * step;
      if (idx < 0 || idx >= pageLayouts.length) continue;
      const info = pageRenderMapRef.current.get(idx);
      if (info && (info.imageBitmap || info.isLoading)) continue;
      const layout = pageLayouts.find(l => l.pageIndex === idx);
      if (!layout) continue;
      enqueue({ pageIndex: idx, layout, priority });
      priority += 1; // 5,6,7
    }
  }, [isScrollIdle, scrollDirection, pdfMetadata, visibleLayouts, pageLayouts, enqueue, scrollSpeedPxPerMs]);

  // 重绘 Canvas - 监听renderVersion变化
  useEffect(() => {
    drawToCanvas();
  }, [drawToCanvas, renderVersion, viewState.scrollY, containerHeight]);

  // 清理资源
  useEffect(() => {
    // 缩放变化时清理所有页面
    pageRenderMapRef.current.forEach(pageInfo => {
      if (pageInfo.imageBitmap) {
        try {
          (pageInfo.imageBitmap as any).close?.();
        } catch (e) {}
      }
    });
    pageRenderMapRef.current.clear();
    pageCompositor.clearCache();
  }, [viewState.scale]); // 移除pageRenderMap依赖避免循环

  // 打开PDF文件
  const handleOpenPdf = async () => {
    try {
      const selected = await open({
        filters: [{
          name: 'PDF',
          extensions: ['pdf']
        }]
      });

      if (selected) {
        const metadata = await invoke<PdfMetadata>('load_pdf', { filePath: selected });
        setPdfMetadata(metadata);
        pageRenderMapRef.current.clear(); // 清理旧的渲染状态
      }
    } catch (error) {
      // PDF loading failed
    }
  };

  // 缩放控制（以视口中心为锚点），并在缩放时清空队列
  const handleZoom = (delta: number) => {
    setHasInteracted(true);

    // 以视口中心为锚：计算缩放前中心在内容坐标中的位置
    const container = containerRef.current;
    const cw = container?.clientWidth || window.innerWidth;
    const ch = container?.clientHeight || window.innerHeight;
    const centerX = viewState.scrollX + cw / 2;
    const centerY = viewState.scrollY + ch / 2;

    setViewState(prev => {
      const newScale = Math.max(0.25, Math.min(4.0, prev.scale + delta));
      const scaleRatio = newScale / prev.scale;

      // 目标：缩放后保持中心锚点不动
      const targetX = Math.max(0, centerX * scaleRatio - cw / 2);
      const targetY = Math.max(0, centerY * scaleRatio - ch / 2);
      targetScrollRef.current = { x: targetX, y: targetY };

      return { ...prev, scale: newScale };
    });

    // 缩放时禁用并清空队列（通过提升epoch）
    setEnabled(false);
    bumpEpoch();
  };

  // 应用缩放后的目标滚动位置
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { x, y } = targetScrollRef.current;
    if (x == null && y == null) return;

    if (x != null) container.scrollLeft = x;
    if (y != null) container.scrollTop = y;

    setViewState(prev => ({
      ...prev,
      scrollX: x != null ? x : prev.scrollX,
      scrollY: y != null ? y : prev.scrollY,
    }));

    // 应用一次后即清空目标
    targetScrollRef.current = { x: null, y: null };
  }, [viewState.scale]);

  // 滚动处理
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target) {
      setHasInteracted(true);
      // 记录上一次滚动位置
      const prevY = viewState.scrollY;
      lastScrollYRef.current = prevY;

      const now = performance.now();
      if (lastTsRef.current != null) {
        const dtMs = Math.max(0.1, now - lastTsRef.current);
        const dy = target.scrollTop - prevY;
        const instV = Math.abs(dy) / dtMs; // px/ms
        const alpha = 0.3; // EMA平滑系数
        const ema = alpha * instV + (1 - alpha) * velocityEmaRef.current;
        velocityEmaRef.current = ema;
        setScrollSpeedPxPerMs(ema);
        setScrollDirection(dy > 0 ? 1 : dy < 0 ? -1 : 0);
      }
      lastTsRef.current = now;

      setViewState(prev => ({
        ...prev,
        scrollY: target.scrollTop,
        scrollX: target.scrollLeft,
      }));
      
      // 滚动时立即重绘，显示空白页占位
      requestAnimationFrame(() => {
        drawToCanvas();
      });
      
      setIsScrollIdle(false);
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        setIsScrollIdle(true);
      }, SCROLL_DEBOUNCE_MS);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 工具栏 */}
      <div
        style={{
          height: '60px',
          background: '#f5f5f5',
          border: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: '12px',
        }}
      >
        <button
          onClick={handleOpenPdf}
          style={{
            padding: '8px 16px',
            background: '#007acc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          打开PDF
        </button>

        {pdfMetadata && (
          <>
            <span style={{ color: '#666' }}>
              {pdfMetadata.total_pages} 页
            </span>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button onClick={() => handleZoom(-0.25)}>-</button>
              <span>{Math.round(viewState.scale * 100)}%</span>
              <button onClick={() => handleZoom(0.20)}>+</button>
            </div>

            <span style={{ color: '#666', fontSize: '14px' }}>
              单Canvas渲染 ({pageRenderMapRef.current.size} 页已渲染)
            </span>
          </>
        )}
      </div>

      {/* PDF内容区 */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#e8e8e8',
          position: 'relative',
        }}
        onScroll={handleScroll}
        ref={containerRef}
      >
        {/* 占位容器用于滚动 */}
        <div style={{ height: totalHeight, width: Math.max(totalWidth, containerRef.current?.clientWidth || 0), position: 'relative', margin: '0 auto' }}>
          {/* 单个 Canvas 覆盖整个可视区域 */}
          <canvas
            ref={canvasRef}
            style={{
              position: 'fixed',
              top: '60px', // 工具栏高度
              left: 0,
              pointerEvents: 'none', // 允许滚动事件穿透
              zIndex: 1,
              imageRendering: 'crisp-edges', // 防止浏览器模糊化处理
            }}
          />
        </div>

        {!pdfMetadata && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              color: '#666',
            }}
          >
            <h3>单Canvas PDF渲染器</h3>
            <p>点击"打开PDF"开始测试高性能渲染</p>
          </div>
        )}
      </div>
    </div>
  );
}; 