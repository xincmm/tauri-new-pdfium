import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useScrollHandler } from './hooks/useScrollHandler';
import { useZoomController } from './hooks/useZoomController';
import { useViewportManager } from './hooks/useViewportManager';
import { useCanvasRenderer } from './hooks/useCanvasRenderer';
import { usePdfLoader } from './hooks/usePdfLoader';
import { ToolbarPlugin } from './plugins/ToolbarPlugin';
import { ViewportPlugin } from './plugins/ViewportPlugin';
import { renderManager } from './core/RenderManager';

export const SingleCanvasViewer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);

  // 核心状态管理
  const [viewState, setViewState] = useState({
    scale: 1,
    scrollX: 0,
    scrollY: 0,
  });

  // PDF加载管理
  const { pdfMetadata, isLoading, handleOpenPdf } = usePdfLoader({
    onClearRender: () => {
      renderManager.clearAllPages();
    }
  });

    const { handleZoom, applyTargetScroll } = useZoomController({
    onZoomChange: (scale) => {
      setViewState(prev => ({ ...prev, scale }));
      renderManager.clearPagesExceptScale(scale);
      renderManager.setEnabled(false);
      requestAnimationFrame(() => {
        renderManager.setEnabled(true);
        renderManager.bumpEpoch();
      });
    },
    onInteractionDetected: () => setHasInteracted(true)
  });

  // 滚动处理 - 简化回调，避免循环依赖
  const { scrollState, handleScroll, getDynamicPreloadAhead, isSlowScrolling, lastScrollYRef } = useScrollHandler({
    onScrollChange: (state) => {
      setViewState(prev => ({ 
        ...prev, 
        scrollX: state.scrollX, 
        scrollY: state.scrollY 
      }));

      // 滚动时禁用渲染队列
      if (!state.isScrollIdle) {
        renderManager.setEnabled(false);
        renderManager.bumpEpoch();
      } else {
        // 滚动停止时启用队列
        renderManager.setEnabled(true);
        renderManager.bumpEpoch();
      }
    },
    onInteractionDetected: () => setHasInteracted(true)
  });

  // 视口管理
  const viewportManager = useViewportManager({
    containerRef,
    pdfMetadata,
    scale: viewState.scale,
    scrollY: viewState.scrollY,
    hasInteracted,
    getDynamicPreloadAhead,
    scrollSpeedPxPerMs: scrollState.scrollSpeedPxPerMs,
    lastScrollY: lastScrollYRef.current
  });

  // Canvas渲染器
  const canvasRenderer = useCanvasRenderer({
    pdfMetadata,
    scale: viewState.scale,
    containerHeight: viewportManager.viewportState.containerHeight,
    scrollY: viewState.scrollY,
    scrollX: viewState.scrollX,
    maxPageWidth: viewportManager.viewportState.maxPageWidth,
    getPageDrawPosition: viewportManager.getPageDrawPosition
  });

  // 设置渲染管理器的回调
  useEffect(() => {
    renderManager.setRenderCallback(async (pageIndex, layout) => {
      // 在RenderManager中记录开始状态
      renderManager.setPageRenderInfo(pageIndex, { 
        isLoading: true, 
        scale: viewState.scale 
      });
      
      // 实际渲染
      await canvasRenderer.updatePageRender(pageIndex, layout);
      
      // 获取渲染结果并同步到RenderManager
      const canvasInfo = canvasRenderer.pageRenderMapRef.current.get(pageIndex);
      if (canvasInfo) {
        renderManager.setPageRenderInfo(pageIndex, {
          imageBitmap: canvasInfo.imageBitmap,
          isLoading: canvasInfo.isLoading,
          lastRendered: canvasInfo.lastRendered,
          scale: viewState.scale
        });
      }
    });
    
    renderManager.setCompleteCallback(() => {
      // 渲染完成后可以进行额外处理
      console.log('Render queue completed');
    });
  }, [canvasRenderer.updatePageRender, viewState.scale]);

  // 处理滚动时的立即重绘（移到单独的effect中）
  useEffect(() => {
    if (scrollState.isScrollIdle) return;
    
    if (canvasRenderer.drawToCanvas && viewportManager.visibleLayouts) {
      requestAnimationFrame(() => {
        canvasRenderer.drawToCanvas(
          canvasRef,
          viewportManager.visibleLayouts,
          viewportManager.viewportState.containerWidth
        );
      });
    }
  }, [
    scrollState.isScrollIdle,
    canvasRenderer.drawToCanvas,
    viewportManager.visibleLayouts,
    viewportManager.viewportState.containerWidth
  ]);

  // 处理空闲时的渲染队列
  useEffect(() => {
    if (!scrollState.isScrollIdle || !pdfMetadata) return;
    
    // 确保有可见布局且渲染管理器已启用
    if (viewportManager.visibleLayouts && viewportManager.visibleLayouts.length > 0) {
      renderManager.enqueueIdleTasks(
        viewportManager.visibleLayouts,
        viewportManager.viewportState.containerHeight,
        viewState.scrollY,
        viewState.scale
      );
    }
  }, [
    scrollState.isScrollIdle,
    pdfMetadata,
    viewportManager.visibleLayouts,
    viewportManager.viewportState.containerHeight,
    viewState.scrollY,
    viewState.scale
  ]);

  // 处理滚动中的前向预取
  useEffect(() => {
    if (scrollState.isScrollIdle || !pdfMetadata || !isSlowScrolling()) return;

    renderManager.enqueuePrefetchTasks(
      viewportManager.visibleLayouts,
      scrollState.scrollDirection,
      viewportManager.pageLayouts,
      viewState.scale
    );
  }, [
    scrollState.isScrollIdle,
    scrollState.scrollDirection,
    pdfMetadata,
    viewportManager.visibleLayouts,
    viewportManager.pageLayouts,
    viewState.scale,
    isSlowScrolling
  ]);

  // 自动居中处理
  useEffect(() => {
    viewportManager.autoCenter(hasInteracted, (x, y) => {
      setViewState(prev => ({ ...prev, scrollX: x, scrollY: y }));
    });
  }, [viewportManager.viewportState.maxPageWidth, viewState.scale, hasInteracted]);

  // 应用缩放后的滚动位置
  useEffect(() => {
    applyTargetScroll(containerRef, (x, y) => {
      setViewState(prev => ({ ...prev, scrollX: x, scrollY: y }));
    });
  }, [viewState.scale, applyTargetScroll]);

  // Canvas重绘
  useEffect(() => {
    if (canvasRenderer.drawToCanvas && viewportManager.visibleLayouts) {
      canvasRenderer.drawToCanvas(
        canvasRef,
        viewportManager.visibleLayouts,
        viewportManager.viewportState.containerWidth
      );
    }
  }, [
    canvasRenderer.drawToCanvas,
    canvasRenderer.renderVersion,
    viewportManager.visibleLayouts,
    viewportManager.viewportState.containerWidth
  ]);

  const handleZoomIn = useCallback(() => {
    handleZoom(0.20, containerRef, viewState.scrollX, viewState.scrollY);
  }, [handleZoom, viewState.scrollX, viewState.scrollY]);

  const handleZoomOut = useCallback(() => {
    handleZoom(-0.20, containerRef, viewState.scrollX, viewState.scrollY);
  }, [handleZoom, viewState.scrollX, viewState.scrollY]);

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ToolbarPlugin
        pdfMetadata={pdfMetadata}
        isLoading={isLoading}
        scale={viewState.scale}
        renderedPagesCount={renderManager.getRenderedPagesCount()}
        onOpenPdf={handleOpenPdf}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />

      <ViewportPlugin
        pdfMetadata={pdfMetadata}
        totalHeight={viewportManager.viewportState.totalHeight}
        totalWidth={viewportManager.viewportState.totalWidth}
        containerRef={containerRef}
        canvasRef={canvasRef}
        onScroll={handleScroll}
      />
    </div>
  );
}; 