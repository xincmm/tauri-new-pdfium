import React, { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE,
  PageTextLayout
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { getVisiblePages, getExpandedVisiblePages } from '../../utils/pdfLayout';
import { 
  getTileUrl
} from '../../utils/tileUtils';
import {
  generateRenderBuckets,
  generateBucketTileKey
} from '../../utils/bucketUtils';
import { PdfTextLayer } from './PdfTextLayer';
import { PageCanvas } from './PageCanvas';
import { ScrollMetrics } from './hooks/useScrollHandler';

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

// 瓦片加载并发控制（本地应用可以使用更高并发）
const MAX_CONCURRENCY = 16;
const loadQueue: Array<() => Promise<void>> = [];
let runningTasks = 0;

function scheduleLoad(task: () => Promise<void>) {
  loadQueue.push(task);
  pumpQueue();
}

function pumpQueue() {
  while (runningTasks < MAX_CONCURRENCY && loadQueue.length > 0) {
    const task = loadQueue.shift()!;
    runningTasks++;
    task().finally(() => {
      runningTasks--;
      pumpQueue();
    });
  }
}

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

  // 获取扩展的可见页面（用于预加载）
  const expandedVisiblePages = React.useMemo(() => {
    if (!containerRef.current) return [];
    
    const containerHeight = containerRef.current.clientHeight;
    return getExpandedVisiblePages(
      pageLayouts, 
      containerHeight, 
      viewState.scrollY, 
      lastScrollY, 
      2 // PRELOAD_PAGES_AHEAD
    );
  }, [pageLayouts, viewState.scrollY, lastScrollY, containerRef]);

  // 预加载扩展可见页面的瓦片
  useEffect(() => {
    if (isScrolling) return; // 滚动时不进行预加载

    const preloadTiles = () => {
      expandedVisiblePages.forEach(pageLayout => {
        const { pageIndex } = pageLayout;
        const [pageWidthPt, pageHeightPt] = pdfMetadata.page_dims[pageIndex];
        const baseDpi = 150.0;
        const scale = viewState.scale;
        const effectiveDpi = baseDpi * scale;
        
        const wPx = Math.ceil((pageWidthPt / 72.0) * effectiveDpi);
        const hPx = Math.ceil((pageHeightPt / 72.0) * effectiveDpi);
        
        const dpiScale = effectiveDpi / baseDpi;
        const backendTileSize = Math.round(TILE_SIZE * dpiScale);
        
        const endTileX = Math.ceil(wPx / backendTileSize);
        const endTileY = Math.ceil(hPx / backendTileSize);

        // 使用新的桶策略进行预加载
        const buckets = generateRenderBuckets(viewState.scale);
        
        for (let tx = 0; tx < endTileX; tx++) {
          for (let ty = 0; ty < endTileY; ty++) {
            // 为所有桶预加载瓦片，优先加载低清桶
            for (const bucket of buckets.reverse()) { // reverse让低清桶优先
              const tileKey = generateBucketTileKey(bucket, {
                id: pdfMetadata.id,
                page: pageIndex,
                tx,
                ty,
              });
              
              const tileState = pdfState.getTileState(tileKey);
              
              if (!tileState.loading && !bitmapCacheRef.current.has(tileKey)) {
                const tileInfo: TileInfo = {
                  id: pdfMetadata.id,
                  page: pageIndex,
                  scale: Math.round(bucket.scale * 100) / 100,
                  tx,
                  ty,
                };
                
                const tileUrl = getTileUrl(tileInfo, devicePixelRatio, bucket.isTarget);
                
                pdfState.updateTileState(tileKey, { loading: true });
                scheduleLoad(async () => {
                  try {
                    const response = await fetch(tileUrl, { cache: 'force-cache' });
                    const blob = await response.blob();
                    const bitmap = await createImageBitmap(blob);
                    bitmapCacheRef.current.set(tileKey, bitmap);
                    pdfState.updateTileState(tileKey, { loaded: true, loading: false });
                  } catch (error) {
                    console.warn(`Failed to preload ${bucket.key} tile:`, tileInfo);
                    pdfState.updateTileState(tileKey, { loading: false });
                  }
                });
              }
            }
          }
        }
      });
    };

    // 使用 setTimeout 进行预加载，避免阻塞主线程
    const timeoutId = setTimeout(preloadTiles, 100);
    return () => clearTimeout(timeoutId);
  }, [expandedVisiblePages, viewState.scale, pdfMetadata, devicePixelRatio, isScrolling, bitmapCacheRef, pdfState]);

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
      {/* Canvas 渲染层 - 只渲染可见页面 */}
      {visiblePages.map(pageLayout => (
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
        />
      ))}
      
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
            bottom: '20px',
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
    </div>
  );
}; 