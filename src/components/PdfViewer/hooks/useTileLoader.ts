import { useEffect } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout
} from '@/PdfViewer/types/pdf';
import {
  TILE_SIZE,
  HIGH_RES_LOAD_DELAY,
  PRELOAD_PAGES_AHEAD 
} from '@/PdfViewer/config';
import { usePdfState } from '@/hooks/usePdfState';
import { getVisiblePages, getExpandedVisiblePages } from '@/PdfViewer/utils/pdfLayout';
// 生成瓦片缓存键
const generateTileKey = (tileInfo: { id: string; page: number; scale: number; tx: number; ty: number }): string => {
  return `${tileInfo.id}_${tileInfo.page}_${tileInfo.scale}_${tileInfo.tx}_${tileInfo.ty}`;
};

interface UseTileLoaderProps {
  isScrolling: boolean;
  pdfMetadata: PdfMetadata | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewState: ViewState;
  lastScrollY: number;
  pageLayouts: PageLayout[];
  getTileState: ReturnType<typeof usePdfState>['getTileState'];
  updateTileState: ReturnType<typeof usePdfState>['updateTileState'];
}

export const useTileLoader = ({
  isScrolling,
  pdfMetadata,
  containerRef,
  viewState,
  lastScrollY,
  pageLayouts,
  getTileState,
  updateTileState,
}: UseTileLoaderProps) => {

  // 滚动停止后触发新瓦片的加载
  useEffect(() => {
    if (!isScrolling && pdfMetadata && containerRef.current) {
      // 延迟一点时间再开始加载，避免频繁触发
      const timeoutId = setTimeout(() => {
        // 使用扩展的可见页面进行预加载
        const containerHeight = containerRef.current!.clientHeight;
        const expandedVisiblePages = getExpandedVisiblePages(
          pageLayouts,
          containerHeight,
          viewState.scrollY,
          lastScrollY,
          PRELOAD_PAGES_AHEAD
        );
        
        expandedVisiblePages.forEach(pageLayout => {
          const { pageIndex, width: pageWidth, height: pageHeight } = pageLayout;
          
          const startTileX = 0;
          const endTileX = Math.ceil(pageWidth / TILE_SIZE);
          const startTileY = 0;
          const endTileY = Math.ceil(pageHeight / TILE_SIZE);

          for (let tx = startTileX; tx < endTileX; tx++) {
            for (let ty = startTileY; ty < endTileY; ty++) {
              const tileInfo = {
                id: pdfMetadata.id,
                page: pageIndex,
                scale: Math.round(viewState.scale * 100) / 100,
                tx,
                ty,
              };
              const key = generateTileKey(tileInfo);
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
  }, [
    isScrolling, 
    pdfMetadata, 
    containerRef, 
    viewState.scale, 
    viewState.scrollY, 
    lastScrollY, 
    pageLayouts, 
    getTileState, 
    updateTileState
  ]);

  // 滚动时的低优先级预加载
  useEffect(() => {
    if (isScrolling && pdfMetadata && containerRef.current) {
      // 滚动时使用更长的延迟，避免影响滚动性能
      const timeoutId = setTimeout(() => {
        const containerHeight = containerRef.current!.clientHeight;
        const visiblePages = getVisiblePages(pageLayouts, containerHeight, viewState.scrollY);
        
        visiblePages.forEach(pageLayout => {
          const { pageIndex, width: pageWidth, height: pageHeight } = pageLayout;
          
          const startTileX = 0;
          const endTileX = Math.ceil(pageWidth / TILE_SIZE);
          const startTileY = 0;
          const endTileY = Math.ceil(pageHeight / TILE_SIZE);

          for (let tx = startTileX; tx < endTileX; tx++) {
            for (let ty = startTileY; ty < endTileY; ty++) {
              const tileInfo = {
                id: pdfMetadata.id,
                page: pageIndex,
                scale: Math.round(viewState.scale * 100) / 100,
                tx,
                ty,
              };
              const key = generateTileKey(tileInfo);
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
  }, [
    isScrolling, 
    pdfMetadata, 
    containerRef, 
    viewState.scale, 
    viewState.scrollY, 
    pageLayouts, 
    getTileState, 
    updateTileState
  ]);
}; 