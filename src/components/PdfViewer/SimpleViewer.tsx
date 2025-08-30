import React, { useState, useMemo, useRef, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { SimplePage } from './SimplePage';
import { PdfMetadata } from '../../types/pdf';
import { calculatePageLayouts, getExpandedVisiblePages, getVisiblePages } from '../../utils/pdfLayout';
import { PRELOAD_PAGES_AHEAD, SCROLL_DEBOUNCE_MS } from '../../types/pdf';

export const SimpleViewer: React.FC = () => {
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState({
    scale: 1.4,
    scrollY: 0,
  });
  const lastScrollYRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [isScrollIdle, setIsScrollIdle] = useState<boolean>(true);
  const idleTimerRef = useRef<number | null>(null);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);
  const [canPreload, setCanPreload] = useState<boolean>(false);
  const preloadTimerRef = useRef<number | null>(null);

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
      // 首开：首屏可见页 + 额外预加载接下来的 2 页
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

  const visiblePageSet = useMemo(() => new Set(visibleLayouts.map(l => l.pageIndex)), [visibleLayouts]);

  const totalHeight = pageLayouts.length > 0 
    ? pageLayouts[pageLayouts.length - 1].y + pageLayouts[pageLayouts.length - 1].height + 50 
    : 0;

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
      // 记录上一次滚动位置
      lastScrollYRef.current = viewState.scrollY;
      setViewState(prev => ({
        ...prev,
        scrollY: target.scrollTop,
      }));
      // 标记为滚动中，并启动/重启防抖定时器
      setIsScrollIdle(false);
      setCanPreload(false);
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
      }
      if (preloadTimerRef.current) {
        window.clearTimeout(preloadTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        setIsScrollIdle(true);
        // 视口稳定后，稍后再开放预加载，避免与高优先级竞争
        preloadTimerRef.current = window.setTimeout(() => setCanPreload(true), 120);
      }, SCROLL_DEBOUNCE_MS);
    }
  };

  // 计算预加载页（上下各1页）
  const preloadPageSet = useMemo(() => {
    const indices = new Set<number>();
    if (visibleLayouts.length === 0) return indices;
    const firstIdx = visibleLayouts[0].pageIndex;
    const lastIdx = visibleLayouts[visibleLayouts.length - 1].pageIndex;
    const prev = firstIdx - 1;
    const next = lastIdx + 1;
    if (prev >= 0) indices.add(prev);
    if (pdfMetadata && next < pdfMetadata.total_pages) indices.add(next);
    // 不与可见页重复
    for (const v of visiblePageSet) indices.delete(v);
    return indices;
  }, [visibleLayouts, visiblePageSet, pdfMetadata]);

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
              简化并发渲染测试
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
          display: 'flex',
          justifyContent: 'center',
        }}
        onScroll={handleScroll}
        ref={containerRef}
      >
        {pdfMetadata && pageLayouts.length > 0 && (
          <div
            style={{
              position: 'relative',
              width: Math.max(...pageLayouts.map(l => l.width)), // 使用最大页面宽度
              minHeight: totalHeight,
              padding: '40px 20px',
            }}
          >
            {pageLayouts.map((layout) => {
              const isVisible = visiblePageSet.has(layout.pageIndex);
              const shouldMount = isVisible || (canPreload && preloadPageSet.has(layout.pageIndex));
              const isPreload = !isVisible && canPreload && preloadPageSet.has(layout.pageIndex);
              if (!shouldMount) return (
                <div key={layout.pageIndex} style={{ position: 'absolute', top: layout.y + 40, left: 0, width: '100%', display: 'flex', justifyContent: 'center' }} />
              );
              return (
                <div
                  key={layout.pageIndex}
                  style={{
                    position: 'absolute',
                    top: layout.y + 40,
                    left: 0,
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <SimplePage
                    pdfMetadata={pdfMetadata}
                    pageIndex={layout.pageIndex}
                    pageLayout={layout}
                    viewState={viewState}
                    isVisible={isVisible}
                    shouldRender={isScrollIdle}
                    containerRef={containerRef}
                    preload={isPreload}
                  />
                </div>
              );
            })}
          </div>
        )}

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
            <h3>简化并发渲染测试</h3>
            <p>点击"打开PDF"开始测试</p>
          </div>
        )}
      </div>
    </div>
  );
}; 