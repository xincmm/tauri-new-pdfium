import React, { useCallback } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  TileInfo,
  TILE_SIZE 
} from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';
import { getVisiblePages, getExpandedVisiblePages } from '../../utils/pdfLayout';
import { 
  getTileUrl, 
  getPagePosterUrl, 
  generateTileKey, 
  generatePosterKey 
} from '../../utils/tileUtils';

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
}) => {
  const { 
    getPagePosterState, 
    updatePagePosterState, 
    getTileState, 
    updateTileState 
  } = pdfState;

  // 渲染页面海报图（整页低清预览）
  const renderPagePosters = useCallback(() => {
    if (!containerRef.current) return [];
    
    const containerWidth = containerRef.current.clientWidth;
    const posters: React.ReactElement[] = [];

    pageLayouts.forEach(pageLayout => {
      const { pageIndex, y: pageY, width: pageWidth, height: pageHeight } = pageLayout;
      const pageX = Math.max(0, (containerWidth - pageWidth) / 2);
      const posterKey = generatePosterKey(pdfMetadata.id, pageIndex);
      const posterState = getPagePosterState(posterKey);

      posters.push(
        <img
          key={posterKey}
          src={getPagePosterUrl(pdfMetadata.id, pageIndex, devicePixelRatio)}
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
  }, [pdfMetadata, pageLayouts, containerRef, devicePixelRatio, getPagePosterState, updatePagePosterState]);

  // 渲染所有可见页面的瓦片
  const renderTiles = useCallback(() => {
    if (!containerRef.current) return [];

    // 使用扩展的可见页面，包括预加载区域
    const containerHeight = containerRef.current.clientHeight;
    const expandedVisiblePages = getExpandedVisiblePages(
      pageLayouts, 
      containerHeight, 
      viewState.scrollY, 
      lastScrollY, 
      2 // PRELOAD_PAGES_AHEAD
    );
    const containerWidth = containerRef.current.clientWidth;
    const tiles: React.ReactElement[] = [];

    expandedVisiblePages.forEach(pageLayout => {
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

          const key = generateTileKey(tileInfo);
          const tileState = getTileState(key);

          // 只渲染已经加载或正在加载的高分辨率瓦片
          // 滚动时保持已加载的瓦片，但不开始新的加载
          if (tileState.loaded || tileState.loading) {
            tiles.push(
              <img
                key={key}
                src={getTileUrl(tileInfo, devicePixelRatio, true)}
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
  }, [
    pdfMetadata, 
    pageLayouts, 
    viewState, 
    lastScrollY, 
    devicePixelRatio, 
    containerRef, 
    getTileState, 
    updateTileState
  ]);

  // 渲染页面边框和页码
  const renderPageBorders = useCallback(() => {
    if (!containerRef.current) return [];
    
    const containerHeight = containerRef.current.clientHeight;
    const visiblePages = getVisiblePages(pageLayouts, containerHeight, viewState.scrollY);
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
  }, [pageLayouts, viewState.scrollY, containerRef]);

  return (
    <div
      className="pdf-content"
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        width: '100%',
      }}
    >
      {renderPageBorders()}
      {renderPagePosters()}
      {renderTiles()}
    </div>
  );
}; 