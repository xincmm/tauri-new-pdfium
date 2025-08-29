// PDF 查看器 V2 - 集成插件系统
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

// 导入新的核心系统
import { documentManager } from '../../core/DocumentManager';
import { pluginManager } from '../../core/PluginSystem';
import { TextSelectionPlugin } from '../../plugins/TextSelectionPlugin';

// 导入现有组件（保持兼容）
import { PdfContent } from './PdfContent';
import { PdfToolbar } from './PdfToolbar';
import { ScrollPerformanceMonitor } from './ScrollPerformanceMonitor';

// 导入现有的hooks和utils
import { usePdfState } from '../../hooks/usePdfState';
import { calculatePageLayouts, getTotalDocumentHeight } from '../../utils/pdfLayout';
import { DEFAULT_SCALE } from '../../types/pdf';
import { useScrollHandler } from './hooks/useScrollHandler';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTileLoader } from './hooks/useTileLoader';
import { cleanupWorkerLoader } from './PageCanvas';

import './PdfViewer.css';

export const PdfViewerV2: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [devicePixelRatio] = React.useState(() => window.devicePixelRatio || 1);
  const [pluginsInitialized, setPluginsInitialized] = useState(false);

  // 使用现有的状态管理（保持兼容性）
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

  // 计算页面布局（使用现有逻辑）
  const pageLayouts = React.useMemo(() => 
    calculatePageLayouts(pdfMetadata, viewState), 
    [pdfMetadata, viewState]
  );

  // 使用现有的hooks（保持兼容性）
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

  // 初始化插件系统
  useEffect(() => {
    const initializePlugins = async () => {
      try {
        // 初始化文档管理器
        await documentManager.initialize();

        // 注册文本选择插件
        const textSelectionPlugin = new TextSelectionPlugin();
        await pluginManager.registerPlugin(textSelectionPlugin);

        setPluginsInitialized(true);
        console.log('Plugin system initialized successfully');
      } catch (error) {
        console.error('Failed to initialize plugin system:', error);
      }
    };

    initializePlugins();

    // 清理函数
    return () => {
      pluginManager.destroy();
      documentManager.destroy();
      cleanupWorkerLoader();
    };
  }, []);

  // 监听插件系统的事件
  useEffect(() => {
    if (!pluginsInitialized) return;

    const eventBus = pluginManager.getEventBus();

    // 监听文本选择事件
    const handleTextSelected = (data: any) => {
      console.log('Text selected via plugin system:', data.selection);
    };

    const handleTextSelectionCleared = () => {
      console.log('Text selection cleared');
    };

    eventBus.on('text:selected', handleTextSelected);
    eventBus.on('text:selectionCleared', handleTextSelectionCleared);

    return () => {
      eventBus.off('text:selected', handleTextSelected);
      eventBus.off('text:selectionCleared', handleTextSelectionCleared);
    };
  }, [pluginsInitialized]);

  // 打开 PDF 文件 - 集成新的文档管理器
  const openPdfFile = useCallback(async () => {
    try {
      setLoading(true);
      const selected = await open({
        filters: [{
          name: 'PDF Files',
          extensions: ['pdf']
        }]
      });
      
      if (selected) {
        // 使用新的文档管理器
        const documentHandle = await documentManager.openFromPath(selected);
        
        // 转换为现有格式，保持兼容性
        const legacyMetadata = documentManager.getLegacyMetadata(documentHandle.id);
        if (legacyMetadata) {
          setPdfMetadata(legacyMetadata);
          clearStates();
          
          // 发射文档打开事件
          if (pluginsInitialized) {
            const eventBus = pluginManager.getEventBus();
            eventBus.emit('document:opened', {
              documentId: documentHandle.id,
              metadata: documentHandle.metadata
            });
          }
          
          console.log('PDF loaded via new document manager:', legacyMetadata);
        }
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
      alert('Failed to open PDF file');
    } finally {
      setLoading(false);
    }
  }, [setPdfMetadata, clearStates, setLoading, pluginsInitialized]);

  // 关闭文档
  const closePdfFile = useCallback(async () => {
    if (!pdfMetadata) return;

    try {
      // 使用新的文档管理器关闭文档
      await documentManager.close(pdfMetadata.id);
      
      // 清理现有状态
      setPdfMetadata(null);
      clearStates();
      
      // 发射文档关闭事件
      if (pluginsInitialized) {
        const eventBus = pluginManager.getEventBus();
        eventBus.emit('document:closed', {
          documentId: pdfMetadata.id
        });
      }
      
      console.log('PDF closed via new document manager');
    } catch (error) {
      console.error('Failed to close PDF:', error);
    }
  }, [pdfMetadata, setPdfMetadata, clearStates, pluginsInitialized]);

  // 将closePdfFile暴露给调试使用
  if (process.env.NODE_ENV === 'development') {
    (window as any).closePdfFile = closePdfFile;
  }

  // 重置视图
  const resetView = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    setViewState({ scale: DEFAULT_SCALE, scrollY: 0 });
    setCurrentVisiblePage(0);
  }, [setViewState, setCurrentVisiblePage]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // 获取插件信息（调试用）
  const getPluginInfo = useCallback(() => {
    if (!pluginsInitialized) return null;
    
    return {
      plugins: pluginManager.getRegisteredPlugins(),
      commands: pluginManager.getPluginContext().getRegisteredCommands(),
      eventListeners: pluginManager.getEventBus().getListenerCount(),
      stateKeys: pluginManager.getStateManager().getStateKeys()
    };
  }, [pluginsInitialized]);

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
        onResetView={resetView}
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

      {/* 插件系统状态指示器 */}
      {pluginsInitialized && (
        <div
          style={{
            position: 'fixed',
            bottom: '20px',
            left: '20px',
            background: 'rgba(0, 100, 0, 0.8)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            zIndex: 1000,
            cursor: 'pointer',
          }}
          onClick={() => {
            const info = getPluginInfo();
            console.log('Plugin System Info:', info);
          }}
          title="点击查看插件系统信息"
        >
          🔌 插件系统已启用 ({pluginManager.getRegisteredPlugins().length} 个插件)
        </div>
      )}

      {/* 额外的调试信息 */}
      {process.env.NODE_ENV === 'development' && pluginsInitialized && (
        <div
          style={{
            position: 'fixed',
            bottom: '60px',
            left: '20px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '11px',
            zIndex: 999,
            fontFamily: 'monospace',
          }}
        >
          <div>文档管理器: {documentManager.getLoadedDocuments().length} 个文档</div>
          <div>事件监听器: {pluginManager.getEventBus().getListenerCount()} 个</div>
          <div>状态键: {pluginManager.getStateManager().getStateKeys().length} 个</div>
        </div>
      )}
    </div>
  );
}; 