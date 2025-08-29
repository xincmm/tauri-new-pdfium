import React, { useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { usePdfState } from '../../hooks/usePdfState';
import { calculatePageLayouts, getTotalDocumentHeight } from '../../utils/pdfLayout';
import { PdfMetadata, DEFAULT_SCALE } from '../../types/pdf';
import { PdfContent } from './PdfContent';
import { PdfToolbar } from './PdfToolbar';
import { ScrollPerformanceMonitor } from './ScrollPerformanceMonitor';

import { cleanupWorkerLoader } from './PageCanvas';
import { useScrollHandler } from './hooks/useScrollHandler';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTileLoader } from './hooks/useTileLoader';
import './PdfViewer.css';

export const PdfViewer: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [devicePixelRatio] = React.useState(() => window.devicePixelRatio || 1);
  // const [showDebugger, setShowDebugger] = React.useState(false);

  const pdfState = usePdfState();
  const {
    pdfMetadata,
    setPdfMetadata,
    viewState,
    setViewState,
    loading,
    setLoading,
    currentVisiblePage,
    setCurrentVisiblePage,
    isScrolling,
    setIsScrolling,
    lastScrollY,
    setLastScrollY,
    clearStates,
  } = pdfState;

  // 计算页面布局
  const pageLayouts = React.useMemo(() => 
    calculatePageLayouts(pdfMetadata, viewState), 
    [pdfMetadata, viewState]
  );

  // 使用自定义hooks
  const { handleContainerScroll, handleWheel, getScrollMetrics } = useScrollHandler({
    containerRef,
    scrollTimeoutRef,
    pdfMetadata,
    pageLayouts,
    viewState,
    setViewState,
    setIsScrolling,
    setLastScrollY,
    setCurrentVisiblePage,
    currentVisiblePage,
  });

  useKeyboardShortcuts({
    pdfMetadata,
    currentVisiblePage,
    setViewState,
    setCurrentVisiblePage,
    containerRef,
    pageLayouts,
  });

  useTileLoader({
    isScrolling,
    pdfMetadata,
    containerRef,
    viewState,
    lastScrollY,
    pageLayouts,
    getTileState: pdfState.getTileState,
    updateTileState: pdfState.updateTileState,
  });

  // 组件卸载时清理Worker
  useEffect(() => {
    return () => {
      cleanupWorkerLoader();
    };
  }, []);

  // 打开 PDF 文件
  const openPdfFile = async () => {
    try {
      setLoading(true);
      const selected = await open({
        filters: [{
          name: 'PDF Files',
          extensions: ['pdf']
        }]
      });
      
      if (selected) {
        const metadata = await invoke<PdfMetadata>('open_pdf', { path: selected });
        setPdfMetadata(metadata);
        clearStates();
        console.log('PDF loaded:', metadata);
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
      alert('Failed to open PDF file');
    } finally {
      setLoading(false);
    }
  };

  // 清理定时器
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="pdf-viewer">
      <PdfToolbar
        loading={loading}
        pdfMetadata={pdfMetadata}
        currentVisiblePage={currentVisiblePage}
        viewState={viewState}
        setViewState={setViewState}
        isScrolling={isScrolling}
        pdfState={pdfState}
        onOpenPdf={openPdfFile}
        onResetView={() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = 0;
          }
          setViewState({ scale: DEFAULT_SCALE, scrollY: 0 });
          setCurrentVisiblePage(0);
        }}
      />

      <div
        ref={containerRef}
        className="pdf-container"
        onWheel={handleWheel}
        onScroll={handleContainerScroll}
      >
        {pdfMetadata && (
          <PdfContent
            pdfMetadata={pdfMetadata}
            pageLayouts={pageLayouts}
            containerRef={containerRef}
            viewState={viewState}
            lastScrollY={lastScrollY}
            isScrolling={isScrolling}
            devicePixelRatio={devicePixelRatio}
            totalHeight={getTotalDocumentHeight(pageLayouts)}
            pdfState={pdfState}
            getScrollMetrics={getScrollMetrics}
          />
        )}
      </div>
      
      {/* 滚动性能监控 */}
      {pdfMetadata && (
        <ScrollPerformanceMonitor
          getScrollMetrics={getScrollMetrics}
          isScrolling={isScrolling}
        />
      )}
      
      {/* 性能调试器 */}
      {/* <PerformanceDebugger 
        isVisible={showDebugger}
        onToggle={() => setShowDebugger(!showDebugger)}
      /> */}
    </div>
  );
}; 