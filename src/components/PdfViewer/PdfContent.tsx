import React, { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  PageTextLayout,
  PRELOAD_PAGES_AHEAD
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { getVisiblePages } from '../../utils/pdfLayout';
// 移除未使用的import
import { PdfTextLayer } from './PdfTextLayer';
import { PageCanvas } from './PageCanvas';
import { ScrollMetrics } from './hooks/useScrollHandler';
import { PriorityTaskQueue } from '../../utils/taskQueue';
import { performanceMonitor } from '../../utils/performanceMonitor';

interface PdfContentProps {
  pdfMetadata: PdfMetadata;
  pageLayouts: PageLayout[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewState: ViewState;
  lastScrollY: number;
  isScrolling: boolean;
  devicePixelRatio: number;
  totalHeight: number;
  pdfState: ReturnType<typeof usePdfState>;
  getScrollMetrics: () => ScrollMetrics;
}

// 全局优先级任务队列 - 降低并发数
const globalTaskQueue = new PriorityTaskQueue(8);

export const PdfContent: React.FC<PdfContentProps> = ({
  pdfMetadata,
  pageLayouts,
  containerRef,
  viewState,
  lastScrollY,
  isScrolling,
  devicePixelRatio,
  totalHeight,
  pdfState,
  getScrollMetrics,
}) => {
  // 使用 ref 缓存 ImageBitmap，避免触发 React 重渲染
  const bitmapCacheRef = useRef<Map<string, ImageBitmap>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  const [selectedText, setSelectedText] = useState<string>('');
  const lastScaleRef = useRef<number>(viewState.scale);
  
  // 焦点页面状态
  const [focusPageIndex, setFocusPageIndex] = useState<number | null>(null);
  const lastFocusPageRef = useRef<number | null>(null);
  
  // 调试面板展开状态
  const [isDebugPanelExpanded, setIsDebugPanelExpanded] = useState<boolean>(true);
  
  const { crossPageSelection, setCrossPageSelection } = pdfState;

  // 缩放变化时清理缓存
  useEffect(() => {
    if (lastScaleRef.current !== viewState.scale) {
      console.log(`缩放变化: ${lastScaleRef.current} -> ${viewState.scale}, 清理缓存`);
      
      // 清理 ImageBitmap 缓存
      for (const bitmap of bitmapCacheRef.current.values()) {
        bitmap.close(); // 释放 ImageBitmap 资源
      }
      bitmapCacheRef.current.clear();
      inflightRef.current.clear();
      
      lastScaleRef.current = viewState.scale;
    }
  }, [viewState.scale]);

  // 获取可见页面
  const visiblePages = React.useMemo(() => {
    if (!containerRef.current) return [];
    
    const containerHeight = containerRef.current.clientHeight;
    return getVisiblePages(pageLayouts, containerHeight, viewState.scrollY);
  }, [pageLayouts, viewState.scrollY, containerRef]);

  // 智能扩展可见页面：快滚只显示可见页，慢滚+静止时包含相邻预加载页面
  const expandedVisiblePages = React.useMemo(() => {
    if (!containerRef.current) return [];
    
    const scrollMetrics = getScrollMetrics();
    const scrollVelocity = Math.abs(scrollMetrics.velocity.vy);
    const isFastScrolling = scrollVelocity > 6; // 快速滚动阈值：2px/ms
    
    // 快速滚动时只返回可见页面，避免队列爆炸
    if (isScrolling && isFastScrolling) {
      console.log(`⚡ 快速滚动只渲染可见页面: [${visiblePages.map(p => p.pageIndex + 1).join(', ')}] (速度: ${scrollVelocity.toFixed(2)})`);
      return visiblePages;
    }
    
    // 慢速滚动或静止时添加相邻PRELOAD_PAGES_AHEAD页进行预加载
    if (focusPageIndex !== null) {
      const preloadPageIndices = new Set<number>();
      
      // 添加所有可见页面
      visiblePages.forEach(page => preloadPageIndices.add(page.pageIndex));
      
      // 添加焦点页面的相邻PRELOAD_PAGES_AHEAD页
      for (let offset = -PRELOAD_PAGES_AHEAD; offset <= PRELOAD_PAGES_AHEAD; offset++) {
        const targetPageIndex = focusPageIndex + offset;
        if (targetPageIndex >= 0 && targetPageIndex < pageLayouts.length) {
          preloadPageIndices.add(targetPageIndex);
        }
      }
      
      const expandedPages = Array.from(preloadPageIndices)
        .sort((a, b) => a - b)
        .map(pageIndex => pageLayouts[pageIndex]);
      
      const status = isScrolling ? `慢滚(${scrollVelocity.toFixed(2)})` : '静止';
      console.log(`🔮 ${status}时扩展页面: [${expandedPages.map(p => p.pageIndex + 1).join(', ')}] (焦点: ${focusPageIndex + 1})`);
      return expandedPages;
    }
    
    // 回退到基本可见页面
    return visiblePages;
  }, [pageLayouts, visiblePages, isScrolling, focusPageIndex, getScrollMetrics]);

  // 检测焦点页面（视口中心的页面）
  const detectFocusPage = useCallback(() => {
    if (!containerRef.current || pageLayouts.length === 0) return null;
    
    const containerHeight = containerRef.current.clientHeight;
    const viewportCenter = viewState.scrollY + containerHeight / 2;
    
    // 找到视口中心所在的页面
    for (const pageLayout of pageLayouts) {
      const pageTop = pageLayout.y;
      const pageBottom = pageLayout.y + pageLayout.height;
      
      if (viewportCenter >= pageTop && viewportCenter <= pageBottom) {
        return pageLayout.pageIndex;
      }
    }
    
    // 如果没有找到，返回最接近的页面
    const distances = pageLayouts.map(layout => {
      const pageCenter = layout.y + layout.height / 2;
      return {
        pageIndex: layout.pageIndex,
        distance: Math.abs(viewportCenter - pageCenter)
      };
    });
    
    distances.sort((a, b) => a.distance - b.distance);
    return distances[0]?.pageIndex || null;
  }, [containerRef, pageLayouts, viewState.scrollY]);

  // 快速滚动检测和焦点页面管理
  useEffect(() => {
    const scrollMetrics = getScrollMetrics();
    const isRapidScrolling = Math.abs(scrollMetrics.velocity.vy) > 6; // 速度阈值 2px/ms
    
    if (isScrolling) {
      const currentFocusPage = detectFocusPage();
      
      if (isRapidScrolling) {
        // 快速滚动时，更新焦点页面
        if (currentFocusPage !== lastFocusPageRef.current) {
          console.log(`快速滚动检测到焦点页面变化: ${lastFocusPageRef.current} -> ${currentFocusPage}`);
          
          setFocusPageIndex(currentFocusPage);
          lastFocusPageRef.current = currentFocusPage;
          
          // 设置全局任务队列的焦点页面
          globalTaskQueue.setFocusPage(currentFocusPage);
          
          // 取消非焦点页面的加载任务
          globalTaskQueue.cancelNonFocusTasks();
        }
      } else {
        // 慢速滚动时，也更新焦点页面但不取消其他任务
        if (currentFocusPage !== lastFocusPageRef.current) {
          setFocusPageIndex(currentFocusPage);
          lastFocusPageRef.current = currentFocusPage;
          globalTaskQueue.setFocusPage(currentFocusPage);
        }
      }
    } else {
      // 停止滚动时，清除焦点页面限制，恢复正常加载
      if (focusPageIndex !== null) {
        console.log('滚动停止，清除焦点页面限制');
        setFocusPageIndex(null);
        globalTaskQueue.setFocusPage(null);
      }
    }
  }, [isScrolling, getScrollMetrics, detectFocusPage, focusPageIndex]);

  // 全局reconcile机制 - 统一管理所有页面的任务需求
  useEffect(() => {
    // 收集所有扩展可见页面的任务需求并进行全局reconcile
    const triggerGlobalReconcile = (reason: string) => {
      const allNeededTasks: any[] = [];
      
      // 为所有扩展可见页面收集任务（恢复预加载功能）
      // 注意：实际任务收集由各个PageCanvas自己完成
      
      console.log(`🔄 全局任务对账 (${reason}): 管理${expandedVisiblePages.length}个扩展页面`);
      globalTaskQueue.reconcile(allNeededTasks, reason); // 清空所有旧任务，开始新轮次
    };

    // 关键时机触发reconcile - 防止队列积攒
    if (!isScrolling) {
      // 滚动停止后触发完整reconcile
      const timeoutId = setTimeout(() => {
        triggerGlobalReconcile('scroll-stopped');
      }, 100);
      return () => clearTimeout(timeoutId);
    } else {
      // 滚动过程中频繁reconcile - 立即清理积攒的任务
      const timeoutId = setTimeout(() => {
        triggerGlobalReconcile('scrolling-cleanup');
      }, 50); // 滚动中每50ms清理一次，防止队列爆炸
      return () => clearTimeout(timeoutId);
    }
  }, [isScrolling, expandedVisiblePages, viewState.scale]);

  // 缩放变化时立即触发全局reconcile
  useEffect(() => {
    console.log('🔄 缩放变化，触发全局任务对账');
    globalTaskQueue.reconcile([], 'scale-change'); // 清空所有任务，重新开始
  }, [viewState.scale]);

  // 焦点页面变化时重新设置优先级
  useEffect(() => {
    if (focusPageIndex !== null) {
      console.log(`🎯 焦点页面变化: ${focusPageIndex + 1}`);
      globalTaskQueue.setFocusPage(focusPageIndex);
    }
  }, [focusPageIndex]);

  // 静默预加载已通过expandedVisiblePages实现

  // 跨页选区处理函数
  const handleGlobalMouseDown = useCallback(() => {
    // 先不创建跨页选区，等到鼠标移动时再创建
    // 这样可以避免单纯点击时显示选区
  }, []);

  const handleGlobalMouseMove = useCallback((pageIndex: number, charIndex: number, startPageIndex?: number, startCharIndex?: number) => {
    if (crossPageSelection?.isSelecting) {
      setCrossPageSelection({
        ...crossPageSelection,
        endPage: pageIndex,
        endCharIndex: charIndex
      });
    } else if (startPageIndex !== undefined && startCharIndex !== undefined) {
      // 第一次移动，创建跨页选区
      setCrossPageSelection({
        startPage: startPageIndex,
        endPage: pageIndex,
        startCharIndex: startCharIndex,
        endCharIndex: charIndex,
        isSelecting: true
      });
    }
  }, [crossPageSelection, setCrossPageSelection]);

  const handleGlobalMouseUp = useCallback(async () => {
    if (!crossPageSelection?.isSelecting) return;

    // 提取跨页选中的文本
    try {
      const selectedText = await extractCrossPageText(
        pdfMetadata.id,
        crossPageSelection.startPage,
        crossPageSelection.endPage,
        crossPageSelection.startCharIndex,
        crossPageSelection.endCharIndex
      );

      if (selectedText.trim()) {
        try {
          await writeText(selectedText);
          console.log('跨页文本已复制到剪贴板:', selectedText);
          setSelectedText(selectedText);
        } catch (error) {
          console.error('复制到剪贴板失败:', error);
          setSelectedText(selectedText);
        }
      }
    } catch (error) {
      console.error('提取跨页文本失败:', error);
    }

    // 结束选择状态，但保持选区高亮
    setCrossPageSelection({
      ...crossPageSelection,
      isSelecting: false
    });
  }, [crossPageSelection, setCrossPageSelection, pdfMetadata.id]);

  // 提取跨页文本的辅助函数
  const extractCrossPageText = async (
    pdfId: string,
    startPage: number,
    endPage: number,
    startCharIndex: number,
    endCharIndex: number
  ): Promise<string> => {
    const textParts: string[] = [];

    for (let page = startPage; page <= endPage; page++) {
      try {
        const pageTextLayout = await invoke<PageTextLayout>('get_page_text_layout', {
          id: pdfId,
          page
        });

        let pageStart = 0;
        let pageEnd = pageTextLayout.chars.length - 1;

        if (page === startPage) {
          pageStart = Math.max(0, startCharIndex);
        }
        if (page === endPage) {
          pageEnd = Math.min(pageTextLayout.chars.length - 1, endCharIndex);
        }

        const pageText = pageTextLayout.chars
          .slice(pageStart, pageEnd + 1)
          .map(c => c.ch)
          .join('');

        if (pageText.trim()) {
          textParts.push(pageText);
        }
      } catch (error) {
        console.error(`获取页面 ${page} 文本布局失败:`, error);
      }
    }

    return textParts.join('\n');
  };

  // 全局鼠标事件监听 - 用于跨页选区
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!crossPageSelection?.isSelecting) return;

      // 找到鼠标当前所在的页面
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const textLayerCanvas = elements.find(el => el.classList.contains('pdf-text-layer')) as HTMLCanvasElement;
      
      if (textLayerCanvas) {
        // 从canvas的data属性或其他方式获取页面索引
        const pageContainer = textLayerCanvas.closest('[data-page-index]') as HTMLElement;
        if (pageContainer) {
          const pageIndex = parseInt(pageContainer.getAttribute('data-page-index') || '0');
          
          // 计算相对于canvas的坐标
          const rect = textLayerCanvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          
          // 触发该页面的字符命中测试
          const event = new CustomEvent('crossPageMouseMove', {
            detail: { pageIndex, x, y }
          });
          textLayerCanvas.dispatchEvent(event);
        }
      }
    };

    const handleDocumentMouseUp = () => {
      if (crossPageSelection?.isSelecting) {
        handleGlobalMouseUp();
      }
    };

    if (crossPageSelection?.isSelecting) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
    };
  }, [crossPageSelection, handleGlobalMouseUp]);

  // 键盘事件：Escape 清除跨页选区
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCrossPageSelection(null);
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setCrossPageSelection]);

  // 计算最大页面宽度，用于确定内容容器宽度
  const maxPageWidth = React.useMemo(() => {
    if (pageLayouts.length === 0) return 0;
    return Math.max(...pageLayouts.map(layout => layout.width));
  }, [pageLayouts]);

  // 监听容器大小变化
  const [containerWidth, setContainerWidth] = React.useState(0);
  
  React.useEffect(() => {
    const updateContainerWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    
    updateContainerWidth();
    
    const resizeObserver = new ResizeObserver(updateContainerWidth);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef]);

  // 计算内容容器的实际宽度
  const contentWidth = React.useMemo(() => {
    const paddingHorizontal = 40; // 左右各20px的边距
    // 如果页面宽度超出容器，则使用页面宽度+边距
    // 否则使用容器宽度，让页面居中
    const needsHorizontalScroll = maxPageWidth + paddingHorizontal > containerWidth;
    const calculatedWidth = needsHorizontalScroll 
      ? maxPageWidth + paddingHorizontal 
      : containerWidth;
    
    return calculatedWidth;
  }, [maxPageWidth, containerWidth]);

  return (
    <div
      className="pdf-content"
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        width: `${contentWidth}px`,
        minWidth: `${Math.max(containerWidth, contentWidth)}px`,
        boxSizing: 'border-box',
      }}
    >
      {/* Canvas 渲染层 - 渲染扩展可见页面（包含预加载） */}
      {expandedVisiblePages.map(pageLayout => {
        const isActuallyVisible = visiblePages.some(vp => vp.pageIndex === pageLayout.pageIndex);
        const isPreloadPage = !isActuallyVisible;
        
        return (
          <PageCanvas
            key={pageLayout.pageIndex}
            pageLayout={pageLayout}
            pdfMetadata={pdfMetadata}
            containerWidth={contentWidth}
            viewState={viewState}
            lastScrollY={lastScrollY}
            isScrolling={isScrolling}
            devicePixelRatio={devicePixelRatio}
            bitmapCacheRef={bitmapCacheRef}
            inflightRef={inflightRef}
            pdfState={pdfState}
            getScrollMetrics={getScrollMetrics}
            isFocusPage={focusPageIndex === pageLayout.pageIndex}
            globalTaskQueue={globalTaskQueue}
            isPreloadPage={isPreloadPage} // 新增：标识预加载页面
          />
        );
      })}
      
      {/* 文本选择层 */}
      {visiblePages.map(pageLayout => {
        // 如果内容宽度大于容器宽度，页面靠左对齐，否则居中
        const pageX = containerWidth > pageLayout.width
          ? Math.max(20, (containerWidth - pageLayout.width) / 2)  // 居中
          : 20;  // 靠左对齐，保持20px边距
        const [pageWidthPt, pageHeightPt] = pdfMetadata.page_dims[pageLayout.pageIndex];
        
        return (
          <div
            key={`text-layer-${pageLayout.pageIndex}`}
            data-page-index={pageLayout.pageIndex}
            style={{
              position: 'absolute',
              left: `${pageX}px`,
              top: `${pageLayout.y}px`,
              width: `${pageLayout.width}px`,
              height: `${pageLayout.height}px`,
              pointerEvents: 'none',
              contentVisibility: 'auto',
              contain: 'strict',
            }}
          >
            <PdfTextLayer
              pdfId={pdfMetadata.id}
              pageIndex={pageLayout.pageIndex}
              pageWidth={pageLayout.width}
              pageHeight={pageLayout.height}
              scale={viewState.scale}
              pageWidthPt={pageWidthPt}
              pageHeightPt={pageHeightPt}
              onTextSelect={(text) => {
                console.log('选中文本:', text);
                setSelectedText(text);
              }}
              crossPageSelection={crossPageSelection}
              onCrossPageSelectionChange={setCrossPageSelection}
              onGlobalMouseDown={handleGlobalMouseDown}
              onGlobalMouseMove={handleGlobalMouseMove}
              onGlobalMouseUp={handleGlobalMouseUp}
            />
          </div>
        );
      })}
      
      {/* 选中文本状态显示 */}
      {(selectedText || crossPageSelection) && (
        <div
          style={{
            position: 'fixed',
            bottom: '80px',
            right: '20px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            maxWidth: '300px',
            wordBreak: 'break-word',
            zIndex: 1000,
            fontFamily: 'monospace',
          }}
          onClick={() => {
            setSelectedText('');
            setCrossPageSelection(null);
          }}
        >
          {crossPageSelection?.isSelecting
            ? `选择中... (页面 ${crossPageSelection.startPage + 1} - ${crossPageSelection.endPage + 1})`
            : selectedText
            ? `已复制: ${selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText}`
            : crossPageSelection
            ? `已选择跨页文本 (页面 ${crossPageSelection.startPage + 1} - ${crossPageSelection.endPage + 1})`
            : ''
          }
        </div>
      )}
      
      {/* 调试面板 - 显示任务队列状态 */}
      {1 && (
        <div
          style={{
            position: 'fixed',
            top: '20px',
            left: '20px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '12px',
            borderRadius: '6px',
            fontSize: '11px',
            fontFamily: 'monospace',
            zIndex: 2000,
            minWidth: isDebugPanelExpanded ? '280px' : '120px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <div 
            style={{ 
              fontWeight: 'bold', 
              marginBottom: isDebugPanelExpanded ? '8px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              userSelect: 'none',
            }}
            onClick={() => setIsDebugPanelExpanded(!isDebugPanelExpanded)}
          >
            <span>渲染队列状态</span>
            <span style={{ 
              fontSize: '10px', 
              color: '#ccc',
              transform: isDebugPanelExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease'
            }}>
              ▼
            </span>
          </div>
          
          {isDebugPanelExpanded && (() => {
            const queueStatus = globalTaskQueue.getQueueStatus();
            const scrollMetrics = getScrollMetrics();
            const perfAnalysis = performanceMonitor.getBottleneckAnalysis();
            
            return (
              <>
                <div>焦点页面: {focusPageIndex !== null ? `页面 ${focusPageIndex + 1}` : '无'}</div>
                <div>队列待处理: {queueStatus.pending}</div>
                <div>正在执行: {queueStatus.running}</div>
                <div>滚动状态: {isScrolling ? '滚动中' : '静止'}</div>
                <div>滚动速度: {Math.abs(scrollMetrics.velocity.vy).toFixed(1)} px/ms</div>
                <div>可见页面: {visiblePages.map(p => p.pageIndex + 1).join(', ')}</div>
                <div>缓存瓦片: {bitmapCacheRef.current.size}</div>
                <div>加载中瓦片: {inflightRef.current.size}</div>
                
                {/* 性能统计 */}
                <div style={{ marginTop: '8px', borderTop: '1px solid #444', paddingTop: '8px' }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>性能分析 (最近{perfAnalysis.stats.count}次)</div>
                  {perfAnalysis.stats.count > 0 ? (
                    <>
                      <div>平均网络: {perfAnalysis.stats.avgNetworkTime.toFixed(1)}ms</div>
                      <div>平均Bitmap: {perfAnalysis.stats.avgBitmapTime.toFixed(1)}ms</div>
                      <div>平均服务端: {perfAnalysis.stats.avgServerRender.toFixed(1)}ms</div>
                      <div>前端总计: {perfAnalysis.stats.avgTotalFrontend.toFixed(1)}ms</div>
                      
                      {perfAnalysis.bottlenecks.length > 0 && (
                        <div style={{ marginTop: '4px', color: '#ff9999' }}>
                          瓶颈: {perfAnalysis.bottlenecks[0]}
                        </div>
                      )}
                      
                      <div style={{ marginTop: '4px', color: '#99ff99', fontSize: '10px' }}>
                        {perfAnalysis.recommendation}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: '#ccc' }}>等待数据...</div>
                  )}
                </div>
                
                <div style={{ marginTop: '8px', fontSize: '10px', color: '#ccc' }}>
                  详细日志请查看控制台 🎯📦
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}; 