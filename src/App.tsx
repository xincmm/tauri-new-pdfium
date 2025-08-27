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

interface PagePosterState {
  loaded: boolean;
  loading: boolean;
}

interface TileState {
  loaded: boolean;
  loading: boolean;
}

const TILE_SIZE = 512;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5.0;
const PAGE_MARGIN = 20; // 页面间距
const SCROLL_DEBOUNCE_MS = 150; // 滚动停止后的延迟时间
const POSTER_SCALE_FACTOR = 0.4; // 海报图的缩放因子（提升分辨率以改善视觉效果）
const HIGH_RES_LOAD_DELAY = 300; // 高分辨率瓦片加载延迟
const PRELOAD_PAGES_AHEAD = 4; // 预加载下面几页

function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const highResTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState<ViewState>({
    scale: 1.0,
    scrollY: 0,
  });
  const [loading, setLoading] = useState(false);
  const [currentVisiblePage, setCurrentVisiblePage] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false); // 新增：滚动状态
  const [lastScrollY, setLastScrollY] = useState(0); // 记录上次滚动位置，用于判断滚动方向
  const [pagePosterStates, setPagePosterStates] = useState<Map<string, PagePosterState>>(new Map()); // 页面海报图状态管理
  const [tileStates, setTileStates] = useState<Map<string, TileState>>(new Map()); // 瓦片状态管理
  // 获取设备像素比，用于高DPI屏幕支持
  const [devicePixelRatio] = useState(() => window.devicePixelRatio || 1);

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

  // 获取扩展的可见页面（包括预加载区域）
  const getExpandedVisiblePages = useCallback((): PageLayout[] => {
    if (!containerRef.current) return [];
    
    const layouts = calculatePageLayouts();
    const containerHeight = containerRef.current.clientHeight;
    const viewportTop = viewState.scrollY;
    const viewportBottom = viewState.scrollY + containerHeight;
    
    // 首先获取当前可见的页面
    const currentVisiblePages = layouts.filter(layout => 
      layout.y < viewportBottom && layout.y + layout.height > viewportTop
    );
    
    if (currentVisiblePages.length === 0) return [];
    
    // 根据滚动方向和 PRELOAD_PAGES_AHEAD 确定预加载范围
    const scrollingDown = viewState.scrollY > lastScrollY;
    const firstVisiblePageIndex = currentVisiblePages[0].pageIndex;
    const lastVisiblePageIndex = currentVisiblePages[currentVisiblePages.length - 1].pageIndex;
    
    let startPageIndex = firstVisiblePageIndex;
    let endPageIndex = lastVisiblePageIndex;
    
    if (scrollingDown) {
      // 向下滚动时，预加载后面的页面
      endPageIndex = Math.min(layouts.length - 1, lastVisiblePageIndex + PRELOAD_PAGES_AHEAD);
    } else {
      // 向上滚动时，预加载前面的页面，但也保持一些后面的页面
      startPageIndex = Math.max(0, firstVisiblePageIndex - Math.floor(PRELOAD_PAGES_AHEAD / 2));
      endPageIndex = Math.min(layouts.length - 1, lastVisiblePageIndex + Math.ceil(PRELOAD_PAGES_AHEAD / 2));
    }
    
    // 返回扩展范围内的所有页面
    return layouts.filter(layout => 
      layout.pageIndex >= startPageIndex && layout.pageIndex <= endPageIndex
    );
  }, [calculatePageLayouts, viewState.scrollY, lastScrollY]);

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
        // 清理旧的瓦片状态
        setPagePosterStates(new Map());
        setTileStates(new Map());
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
  const getTileUrl = (tileInfo: TileInfo, isHighRes: boolean = true): string => {
    const { id, page, scale, tx, ty } = tileInfo;
    // 根据设备像素比调整请求的缩放级别，确保高DPI屏幕的清晰度
    const baseScale = isHighRes ? scale * devicePixelRatio : scale * devicePixelRatio * POSTER_SCALE_FACTOR;
    const adjustedScale = Math.max(0.1, baseScale); // 确保最小缩放不为0
    return `tiles://localhost/${id}/${page}/${adjustedScale}/${tx}/${ty}.webp`;
  };

  // 获取页面海报图状态
  const getPagePosterState = (key: string): PagePosterState => {
    return pagePosterStates.get(key) || { loaded: false, loading: false };
  };

  // 更新页面海报图状态
  const updatePagePosterState = (key: string, updates: Partial<PagePosterState>) => {
    setPagePosterStates(prev => {
      const newMap = new Map(prev);
      const currentState = getPagePosterState(key);
      newMap.set(key, { ...currentState, ...updates });
      return newMap;
    });
  };

  // 获取瓦片状态
  const getTileState = (key: string): TileState => {
    return tileStates.get(key) || { loaded: false, loading: false };
  };

  // 更新瓦片状态
  const updateTileState = (key: string, updates: Partial<TileState>) => {
    setTileStates(prev => {
      const newMap = new Map(prev);
      const currentState = getTileState(key);
      newMap.set(key, { ...currentState, ...updates });
      return newMap;
    });
  };

  // 获取页面海报图URL（整页低分辨率图像）
  const getPagePosterUrl = (pageIndex: number): string => {
    if (!pdfMetadata) return '';
    const scale = POSTER_SCALE_FACTOR * devicePixelRatio;
    // 使用特殊坐标 (-1, -1) 来请求整页图像
    // 在URL中，-1会被解析为 4294967295 (u32::MAX)
    return `tiles://localhost/${pdfMetadata.id}/${pageIndex}/${scale}/4294967295/4294967295.webp`;
  };

  // 渲染页面海报图（整页低清预览）
  const renderPagePosters = useCallback(() => {
    if (!pdfMetadata || !containerRef.current) return [];
    
    const layouts = calculatePageLayouts();
    const containerWidth = containerRef.current.clientWidth;
    const posters: React.ReactElement[] = [];

    layouts.forEach(pageLayout => {
      const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
      const pageX = Math.max(0, (containerWidth - pageWidth) / 2);
      const posterKey = `poster_${pdfMetadata.id}_${pageIndex}`;
      const posterState = getPagePosterState(posterKey);

      posters.push(
        <img
          key={posterKey}
          src={getPagePosterUrl(pageIndex)}
          alt={`Page ${pageIndex + 1} Poster`}
          style={{
            position: 'absolute',
            left: `${pageX}px`,
            top: `${pageY}px`,
            width: `${pageWidth}px`,
            height: `${pageHeight}px`,
            imageRendering: 'auto',
            pointerEvents: 'none',
            opacity: posterState.loaded ? 1 : 0.3,
            transition: 'opacity 0.5s ease',
            zIndex: 0, // 最底层
          }}
          onLoad={() => {
            updatePagePosterState(posterKey, { loaded: true, loading: false });
          }}
          onLoadStart={() => {
            updatePagePosterState(posterKey, { loading: true });
          }}
          onError={() => {
            console.warn('Failed to load page poster:', pageIndex);
            updatePagePosterState(posterKey, { loading: false });
          }}
        />
      );
    });

    return posters;
  }, [pdfMetadata, viewState.scale, calculatePageLayouts, devicePixelRatio, pagePosterStates]);

  // 渲染所有可见页面的瓦片
  const renderTiles = useCallback(() => {
    if (!pdfMetadata || !containerRef.current) return [];

    // 使用扩展的可见页面，包括预加载区域
    const visiblePages = getExpandedVisiblePages();
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
          const tileState = getTileState(key);

          // 只渲染已经加载或正在加载的高分辨率瓦片
          // 滚动时保持已加载的瓦片，但不开始新的加载
          if (tileState.loaded || tileState.loading) {
            tiles.push(
              <img
                key={key}
                src={getTileUrl(tileInfo, true)}
                alt={`Page ${pageIndex + 1} Tile ${tx},${ty}`}
                style={{
                  position: 'absolute',
                  left: `${tileX}px`,
                  top: `${tileY}px`,
                  width: `${renderWidth}px`,
                  height: `${renderHeight}px`,
                  imageRendering: 'pixelated',
                  pointerEvents: 'none',
                  opacity: tileState.loaded ? 1 : 0,
                  transition: 'opacity 0.3s ease',
                  zIndex: 10, // 最上层
                }}
                onLoad={() => {
                  updateTileState(key, { loaded: true, loading: false });
                }}
                onLoadStart={() => {
                  updateTileState(key, { loading: true });
                }}
                onError={() => {
                  console.warn('Failed to load high-res tile:', tileInfo);
                  updateTileState(key, { loading: false });
                }}
              />
            );
          }
        }
      }
    });

    return tiles;
  }, [pdfMetadata, viewState, devicePixelRatio, getExpandedVisiblePages, isScrolling, tileStates]);

  // 滚动停止后触发新瓦片的加载
  useEffect(() => {
    if (!isScrolling && pdfMetadata && containerRef.current) {
      // 延迟一点时间再开始加载，避免频繁触发
      const timeoutId = setTimeout(() => {
        // 使用扩展的可见页面进行预加载
        const visiblePages = getExpandedVisiblePages();
        
        visiblePages.forEach(pageLayout => {
          const { pageIndex, width: pageWidth, height: pageHeight } = pageLayout;
          
          const startTileX = 0;
          const endTileX = Math.ceil(pageWidth / TILE_SIZE);
          const startTileY = 0;
          const endTileY = Math.ceil(pageHeight / TILE_SIZE);

          for (let tx = startTileX; tx < endTileX; tx++) {
            for (let ty = startTileY; ty < endTileY; ty++) {
              const key = `${pdfMetadata.id}_${pageIndex}_${Math.round(viewState.scale * 100) / 100}_${tx}_${ty}`;
              const tileState = getTileState(key);
              
              // 只对未加载且未在加载的瓦片开始加载
              if (!tileState.loaded && !tileState.loading) {
                updateTileState(key, { loading: true });
              }
            }
          }
        });
      }, HIGH_RES_LOAD_DELAY);

      return () => clearTimeout(timeoutId);
    }
  }, [isScrolling, pdfMetadata, viewState.scale, getExpandedVisiblePages, getTileState, updateTileState]);

  // 滚动时的低优先级预加载
  useEffect(() => {
    if (isScrolling && pdfMetadata && containerRef.current) {
      // 滚动时使用更长的延迟，避免影响滚动性能
      const timeoutId = setTimeout(() => {
        const visiblePages = getVisiblePages(); // 只预加载当前可见区域
        
        visiblePages.forEach(pageLayout => {
          const { pageIndex, width: pageWidth, height: pageHeight } = pageLayout;
          
          const startTileX = 0;
          const endTileX = Math.ceil(pageWidth / TILE_SIZE);
          const startTileY = 0;
          const endTileY = Math.ceil(pageHeight / TILE_SIZE);

          for (let tx = startTileX; tx < endTileX; tx++) {
            for (let ty = startTileY; ty < endTileY; ty++) {
              const key = `${pdfMetadata.id}_${pageIndex}_${Math.round(viewState.scale * 100) / 100}_${tx}_${ty}`;
              const tileState = getTileState(key);
              
              // 只对未加载且未在加载的瓦片开始加载
              if (!tileState.loaded && !tileState.loading) {
                updateTileState(key, { loading: true });
              }
            }
          }
        });
      }, HIGH_RES_LOAD_DELAY * 2); // 滚动时延迟更长

      return () => clearTimeout(timeoutId);
    }
  }, [isScrolling, pdfMetadata, viewState.scale, getVisiblePages, getTileState, updateTileState]);

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
    
    // 设置滚动状态为 true
    setIsScrolling(true);
    
    // 清除之前的定时器
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    if (highResTimeoutRef.current) {
      clearTimeout(highResTimeoutRef.current);
    }
    
    // 设置新的定时器，在滚动停止后恢复渲染
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, SCROLL_DEBOUNCE_MS);
    
    setViewState(prev => ({
      ...prev,
      scrollY: scrollTop,
    }));

    // 更新滚动位置记录
    setLastScrollY(scrollTop);

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

  // 清理定时器
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (highResTimeoutRef.current) {
        clearTimeout(highResTimeoutRef.current);
      }
    };
  }, []);

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
            
            {/* <div className="help-text">
              <small>
                滚轮滚动翻页 | Ctrl/Cmd + 滚轮缩放 | Ctrl/Cmd + 0 重置
              </small>
            </div> */}
            
            {/* {isScrolling && (
              <div className="scroll-indicator">
                <small style={{ color: '#666' }}>滚动中... (显示低分辨率预览)</small>
              </div>
            )} */}
            
            <div className="tile-stats">
              <small style={{ color: '#888' }}>
                海报图: {Array.from(pagePosterStates.values()).filter(s => s.loaded).length} / {pagePosterStates.size} | 
                高清瓦片: {Array.from(tileStates.values()).filter(s => s.loaded).length} 个
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
            {renderPagePosters()}
            {renderTiles()}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
