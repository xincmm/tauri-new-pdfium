import React, { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import './App.css';

interface PdfMetadata {
  id: string;
  total_pages: number;
  page_dims: [number, number][];
}

interface TileInfo {
  id: string;
  page: number;
  scale: number;
  tx: number;
  ty: number;
}

interface ViewState {
  scale: number;
  scrollY: number;
}

interface PageLayout {
  pageIndex: number;
  y: number;
  width: number;
  height: number;
}

const TILE_SIZE = 512;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5.0;
const PAGE_MARGIN = 20; // 页面间距

function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState<ViewState>({
    scale: 1.0,
    scrollY: 0,
  });
  const [loading, setLoading] = useState(false);
  const [currentVisiblePage, setCurrentVisiblePage] = useState(0);
  // 获取设备像素比，用于高DPI屏幕支持
  const [devicePixelRatio] = useState(() => window.devicePixelRatio || 1);
  // 性能监控状态
  const [ , setPerformanceStats] = useState({ 
    loadingTiles: 0, 
    totalTiles: 0,
    avgLoadTime: 0 
  });

  // 计算页面布局
  const calculatePageLayouts = useCallback((): PageLayout[] => {
    if (!pdfMetadata) return [];
    
    const baseDpi = 144.0;
    const layouts: PageLayout[] = [];
    let currentY = PAGE_MARGIN;
    
    for (let i = 0; i < pdfMetadata.total_pages; i++) {
      const [pageWidth, pageHeight] = pdfMetadata.page_dims[i];
      const screenPageWidth = ((pageWidth / 72.0) * baseDpi * viewState.scale);
      const screenPageHeight = ((pageHeight / 72.0) * baseDpi * viewState.scale);
      
      layouts.push({
        pageIndex: i,
        y: currentY,
        width: screenPageWidth,
        height: screenPageHeight,
      });
      
      currentY += screenPageHeight + PAGE_MARGIN;
    }
    
    return layouts;
  }, [pdfMetadata, viewState.scale]);

  // 计算总文档高度
  const getTotalDocumentHeight = useCallback((): number => {
    const layouts = calculatePageLayouts();
    if (layouts.length === 0) return 0;
    const lastLayout = layouts[layouts.length - 1];
    return lastLayout.y + lastLayout.height + PAGE_MARGIN;
  }, [calculatePageLayouts]);

  // 获取当前可见的页面
  const getVisiblePages = useCallback((): PageLayout[] => {
    if (!containerRef.current) return [];
    
    const layouts = calculatePageLayouts();
    const containerHeight = containerRef.current.clientHeight;
    const viewportTop = viewState.scrollY;
    const viewportBottom = viewState.scrollY + containerHeight;
    
    return layouts.filter(layout => 
      layout.y < viewportBottom && layout.y + layout.height > viewportTop
    );
  }, [calculatePageLayouts, viewState.scrollY]);

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
        setViewState({ scale: 1.0, scrollY: 0 });
        setCurrentVisiblePage(0);
        console.log('PDF loaded:', metadata);
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
      alert('Failed to open PDF file');
    } finally {
      setLoading(false);
    }
  };

  // 获取 tile URL，考虑设备像素比
  const getTileUrl = (tileInfo: TileInfo): string => {
    const { id, page, scale, tx, ty } = tileInfo;
    // 根据设备像素比调整请求的缩放级别，确保高DPI屏幕的清晰度
    const adjustedScale = scale * devicePixelRatio;
    return `tiles://localhost/${id}/${page}/${adjustedScale}/${tx}/${ty}.webp`;
  };

  // 渲染所有可见页面的瓦片
  const renderTiles = useCallback(() => {
    if (!pdfMetadata || !containerRef.current) return [];

    const visiblePages = getVisiblePages();
    const containerWidth = containerRef.current.clientWidth;
    const tiles: React.ReactElement[] = [];

    visiblePages.forEach(pageLayout => {
      const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
      
      // 计算页面居中位置
      const pageX = Math.max(0, (containerWidth - pageWidth) / 2);
      
      // 计算需要渲染的 tile 范围
      const startTileX = 0;
      const endTileX = Math.ceil(pageWidth / TILE_SIZE);
      const startTileY = 0;
      const endTileY = Math.ceil(pageHeight / TILE_SIZE);

      for (let tx = startTileX; tx < endTileX; tx++) {
        for (let ty = startTileY; ty < endTileY; ty++) {
          const tileInfo: TileInfo = {
            id: pdfMetadata.id,
            page: pageIndex,
            scale: Math.round(viewState.scale * 100) / 100,
            tx,
            ty,
          };

          // 计算 tile 的绝对位置
          const tileX = pageX + tx * TILE_SIZE;
          const tileY = pageY + ty * TILE_SIZE;
          
          // 计算实际渲染尺寸（处理边缘 tile）
          const renderWidth = Math.min(TILE_SIZE, pageWidth - tx * TILE_SIZE);
          const renderHeight = Math.min(TILE_SIZE, pageHeight - ty * TILE_SIZE);

          const key = `${tileInfo.id}_${tileInfo.page}_${tileInfo.scale}_${tileInfo.tx}_${tileInfo.ty}`;

          tiles.push(
            <img
              key={key}
              src={getTileUrl(tileInfo)}
              alt={`Page ${pageIndex + 1} Tile ${tx},${ty}`}
              style={{
                position: 'absolute',
                left: `${tileX}px`,
                top: `${tileY}px`,
                width: `${renderWidth}px`,
                height: `${renderHeight}px`,
                imageRendering: 'pixelated',
                pointerEvents: 'none',
              }}
              onLoad={() => {
                setPerformanceStats(prev => ({
                  ...prev,
                  loadingTiles: Math.max(0, prev.loadingTiles - 1)
                }));
              }}
              onLoadStart={() => {
                setPerformanceStats(prev => ({
                  ...prev,
                  loadingTiles: prev.loadingTiles + 1,
                  totalTiles: prev.totalTiles + 1
                }));
              }}
              onError={(e) => {
                console.warn('Failed to load tile:', tileInfo);
                e.currentTarget.style.display = 'none';
                setPerformanceStats(prev => ({
                  ...prev,
                  loadingTiles: Math.max(0, prev.loadingTiles - 1)
                }));
              }}
            />
          );
        }
      }
    });

    return tiles;
  }, [pdfMetadata, viewState, devicePixelRatio, getVisiblePages]);

  // 渲染页面边框和页码
  const renderPageBorders = useCallback(() => {
    if (!pdfMetadata || !containerRef.current) return [];
    
    const visiblePages = getVisiblePages();
    const containerWidth = containerRef.current.clientWidth;
    const borders: React.ReactElement[] = [];

    visiblePages.forEach(pageLayout => {
      const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
      const pageX = Math.max(0, (containerWidth - pageWidth) / 2);
      
      borders.push(
        <div
          key={`border-${pageIndex}`}
          style={{
            position: 'absolute',
            left: `${pageX - 2}px`,
            top: `${pageY - 2}px`,
            width: `${pageWidth + 4}px`,
            height: `${pageHeight + 4}px`,
            border: '2px solid #e5e5e5',
            backgroundColor: 'white',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            pointerEvents: 'none',
            zIndex: -1,
          }}
        />,
        <div
          key={`page-number-${pageIndex}`}
          style={{
            position: 'absolute',
            left: `${pageX + pageWidth - 60}px`,
            top: `${pageY + pageHeight + 8}px`,
            padding: '4px 8px',
            backgroundColor: 'rgba(0,0,0,0.7)',
            color: 'white',
            fontSize: '12px',
            borderRadius: '4px',
            pointerEvents: 'none',
          }}
        >
          {pageIndex + 1}
        </div>
      );
    });

    return borders;
  }, [pdfMetadata, viewState.scrollY, getVisiblePages]);

  // 处理滚动事件
  const handleScroll = useCallback((e: React.WheelEvent) => {
    if (!pdfMetadata) return;
    
    // 如果按住 Ctrl/Cmd，执行缩放
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, viewState.scale * delta));
      
      if (newScale !== viewState.scale) {
        setViewState(prev => ({
          ...prev,
          scale: newScale,
        }));
      }
      return;
    }

    // 让浏览器处理原生滚动，我们监听滚动事件
  }, [pdfMetadata, viewState]);

  // 监听容器滚动事件
  const handleContainerScroll = useCallback(() => {
    if (!containerRef.current || !pdfMetadata) return;
    
    const scrollTop = containerRef.current.scrollTop;
    const containerHeight = containerRef.current.clientHeight;
    
    setViewState(prev => ({
      ...prev,
      scrollY: scrollTop,
    }));

    // 更新当前可见页面
    const layouts = calculatePageLayouts();
    const currentPage = layouts.findIndex(layout => 
      layout.y <= scrollTop + containerHeight / 2 && 
      layout.y + layout.height > scrollTop + containerHeight / 2
    );
    if (currentPage !== -1 && currentPage !== currentVisiblePage) {
      setCurrentVisiblePage(currentPage);
    }
  }, [pdfMetadata, calculatePageLayouts, currentVisiblePage]);

  // 跳转到指定页面
  const goToPage = (pageIndex: number) => {
    if (!pdfMetadata || !containerRef.current) return;
    const layouts = calculatePageLayouts();
    const targetLayout = layouts[pageIndex];
    if (targetLayout) {
      const targetScrollY = targetLayout.y - PAGE_MARGIN;
      containerRef.current.scrollTop = targetScrollY;
      setViewState(prev => ({
        ...prev,
        scrollY: targetScrollY,
      }));
      setCurrentVisiblePage(pageIndex);
    }
  };

  // 重置视图
  const resetView = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    setViewState({
      scale: 1.0,
      scrollY: 0,
    });
    setCurrentVisiblePage(0);
  };



  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!pdfMetadata) return;
      
      switch (e.key) {
        case 'Home':
          e.preventDefault();
          goToPage(0);
          break;
        case 'End':
          e.preventDefault();
          goToPage(pdfMetadata.total_pages - 1);
          break;
        case 'PageUp':
          e.preventDefault();
          goToPage(Math.max(0, currentVisiblePage - 1));
          break;
        case 'PageDown':
          e.preventDefault();
          goToPage(Math.min(pdfMetadata.total_pages - 1, currentVisiblePage + 1));
          break;
        case '+':
        case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setViewState(prev => ({ 
              ...prev, 
              scale: Math.min(MAX_SCALE, prev.scale * 1.25) 
            }));
          }
          break;
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setViewState(prev => ({ 
              ...prev, 
              scale: Math.max(MIN_SCALE, prev.scale * 0.8) 
            }));
          }
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            resetView();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pdfMetadata, currentVisiblePage]);

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={openPdfFile} disabled={loading}>
          {loading ? 'Loading...' : 'Open PDF'}
        </button>
        
        {pdfMetadata && (
          <>
            <div className="page-controls">
              <span>
                Page {currentVisiblePage + 1} of {pdfMetadata.total_pages}
              </span>
            </div>
            
            <div className="zoom-controls">
              <button onClick={() => setViewState(prev => ({ 
                ...prev, 
                scale: Math.max(MIN_SCALE, prev.scale * 0.8) 
              }))}>
                Zoom Out
              </button>
              <span>{Math.round(viewState.scale * 100)}%</span>
              <button onClick={() => setViewState(prev => ({ 
                ...prev, 
                scale: Math.min(MAX_SCALE, prev.scale * 1.25) 
              }))}>
                Zoom In
              </button>
              <button onClick={resetView}>Reset View</button>
            </div>
            
            <div className="help-text">
              <small>
                滚轮滚动翻页 | Ctrl/Cmd + 滚轮缩放 | Ctrl/Cmd + 0 重置
              </small>
            </div>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        className="pdf-container"
        onWheel={handleScroll}
        onScroll={handleContainerScroll}
        style={{ 
          cursor: 'default',
        }}
      >
        {pdfMetadata && (
          <div
            className="pdf-content"
            style={{
              position: 'relative',
              height: `${getTotalDocumentHeight()}px`,
              width: '100%',
            }}
          >
            {renderPageBorders()}
            {renderTiles()}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
