import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { PdfMetadata, getPageDimensions, TILE_SIZE } from '../../types/pdf';
import { calculatePageLayouts, getExpandedVisiblePages, getVisiblePages } from '../../utils/pdfLayout';
import { PRELOAD_PAGES_AHEAD, SCROLL_DEBOUNCE_MS } from '../../types/pdf';
import { batchTileLoader } from '../../utils/batchTileLoader';
import { pageCompositor, type TileData } from '../../utils/pageCompositor';

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
  const tilesToLoad = [];
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
    scale: 1.2,
    scrollY: 0,
  });
  const lastScrollYRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [isScrollIdle, setIsScrollIdle] = useState<boolean>(true);
  const idleTimerRef = useRef<number | null>(null);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);

  // 页面渲染信息管理 - 使用 ref 避免依赖循环
  const pageRenderMapRef = useRef<Map<number, PageRenderInfo>>(new Map());
  const [renderVersion, setRenderVersion] = useState(0); // 用于触发重绘
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);

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
    if (!pdfMetadata) return [];
    return calculatePageLayouts(pdfMetadata, viewState);
  }, [pdfMetadata, viewState.scale]);

  // 计算可见页面：初次打开仅渲染首屏；交互后再扩展预加载窗口
  const visibleLayouts = useMemo(() => {
    if (!pdfMetadata) return [];
    if (!hasInteracted) {
      const baseVisible = getVisiblePages(
        pageLayouts,
        containerHeight,
        viewState.scrollY
      );
      if (baseVisible.length === 0) return [];
      const firstIdx = baseVisible[0].pageIndex;
      const lastIdx = baseVisible[baseVisible.length - 1].pageIndex;
      const endIdx = Math.min(pageLayouts.length - 1, lastIdx + 2);
      return pageLayouts.filter(l => l.pageIndex >= firstIdx && l.pageIndex <= endIdx);
    }
    return getExpandedVisiblePages(
      pageLayouts,
      containerHeight,
      viewState.scrollY,
      lastScrollYRef.current,
      PRELOAD_PAGES_AHEAD
    );
  }, [pdfMetadata, pageLayouts, containerHeight, viewState.scrollY, hasInteracted]);

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
      console.error(`❌ 页面${pageIndex + 1} 渲染失败:`, error);
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

  // 绘制所有可见页面到单个 Canvas
  const drawToCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfMetadata) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = devicePixelRatio;
    const containerWidth = containerRef.current?.clientWidth || window.innerWidth;

    // 设置 Canvas 尺寸
    canvas.width = Math.max(1, Math.floor(containerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(containerHeight * dpr));
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;

    // 设置变换和抗锯齿
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 清空画布
    ctx.clearRect(0, 0, containerWidth, containerHeight);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, containerWidth, containerHeight);

    // 计算视口范围
    const viewportTop = viewState.scrollY;
    const viewportBottom = viewState.scrollY + containerHeight;

    // 绘制所有可见页面
    for (const layout of visibleLayouts) {
      const pageInfo = pageRenderMapRef.current.get(layout.pageIndex);
      if (!pageInfo?.imageBitmap) continue;

      const pageTop = layout.y + 40; // 加上padding
      const pageBottom = pageTop + layout.height;

      // 检查页面是否在视口内
      if (pageBottom < viewportTop || pageTop > viewportBottom) continue;

      // 计算页面在画布上的位置
      const canvasX = (containerWidth - layout.width) / 2;
      const canvasY = pageTop - viewState.scrollY;

      // 绘制页面 - 添加ImageBitmap有效性检查
      try {
        // 检查ImageBitmap是否有效
        const bitmap = pageInfo.imageBitmap;
        if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
          console.warn(`页面 ${layout.pageIndex + 1} ImageBitmap无效`);
          continue;
        }

        ctx.drawImage(
          bitmap,
          canvasX,
          canvasY,
          layout.width,
          layout.height
        );

        // 绘制页面边框
        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 1;
        ctx.strokeRect(canvasX, canvasY, layout.width, layout.height);
      } catch (error) {
        console.error(`绘制页面 ${layout.pageIndex + 1} 失败:`, error);
        // 如果ImageBitmap无效，从map中移除
        pageRenderMapRef.current.delete(layout.pageIndex);
      }
    }
  }, [pdfMetadata, visibleLayouts, containerHeight, devicePixelRatio, viewState.scrollY]); // 重新添加必要的依赖

  // 管理页面渲染 - 使用稳定的key避免循环
  const visiblePagesKey = useMemo(() => {
    return visibleLayouts.map(l => l.pageIndex).join(',');
  }, [visibleLayouts]);

  useEffect(() => {
    if (!isScrollIdle || !pdfMetadata) return;

    for (const layout of visibleLayouts) {
      const pageInfo = pageRenderMapRef.current.get(layout.pageIndex);
      if (!pageInfo || (!pageInfo.imageBitmap && !pageInfo.isLoading)) {
        updatePageRender(layout.pageIndex, layout);
      }
    }
  }, [visiblePagesKey, isScrollIdle, pdfMetadata, updatePageRender]); // 使用稳定的key

  // 重绘 Canvas - 监听renderVersion变化
  useEffect(() => {
    drawToCanvas();
  }, [drawToCanvas, renderVersion]);

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
        console.log(`🔍 正在加载PDF: ${selected}`);
        const metadata = await invoke<PdfMetadata>('load_pdf', { filePath: selected });
        console.log('📄 PDF元数据:', metadata);
        setPdfMetadata(metadata);
        pageRenderMapRef.current.clear(); // 清理旧的渲染状态
      }
    } catch (error) {
      console.error('❌ PDF加载失败:', error);
    }
  };

  // 缩放控制
  const handleZoom = (delta: number) => {
    setHasInteracted(true);
    setViewState(prev => ({
      ...prev,
      scale: Math.max(0.25, Math.min(4.0, prev.scale + delta)),
    }));
  };

  // 滚动处理
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target) {
      setHasInteracted(true);
      lastScrollYRef.current = viewState.scrollY;
      setViewState(prev => ({
        ...prev,
        scrollY: target.scrollTop,
      }));
      
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
              <button onClick={() => handleZoom(0.25)}>+</button>
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
        <div style={{ height: totalHeight, position: 'relative' }}>
          {/* 单个 Canvas 覆盖整个可视区域 */}
          <canvas
            ref={canvasRef}
            style={{
              position: 'fixed',
              top: '60px', // 工具栏高度
              left: 0,
              pointerEvents: 'none', // 允许滚动事件穿透
              zIndex: 1,
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