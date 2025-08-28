import { useState, useCallback } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PagePosterState, 
  TileState,
  DEFAULT_SCALE
} from '../types/pdf';

export interface CrossPageSelection {
  startPage: number;
  endPage: number;
  startCharIndex: number;
  endCharIndex: number;
  isSelecting: boolean;
}

export const usePdfState = () => {
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState<ViewState>({
    scale: DEFAULT_SCALE,
    scrollY: 0,
  });
  const [loading, setLoading] = useState(false);
  const [currentVisiblePage, setCurrentVisiblePage] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [pagePosterStates, setPagePosterStates] = useState<Map<string, PagePosterState>>(new Map());
  const [tileStates, setTileStates] = useState<Map<string, TileState>>(new Map());
  // 跨页选区状态
  const [crossPageSelection, setCrossPageSelection] = useState<CrossPageSelection | null>(null);

  // 获取页面海报图状态
  const getPagePosterState = useCallback((key: string): PagePosterState => {
    return pagePosterStates.get(key) || { loaded: false, loading: false };
  }, [pagePosterStates]);

  // 更新页面海报图状态
  const updatePagePosterState = useCallback((key: string, updates: Partial<PagePosterState>) => {
    setPagePosterStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(key) || { loaded: false, loading: false };
      newMap.set(key, { ...currentState, ...updates });
      return newMap;
    });
  }, []);

  // 获取瓦片状态
  const getTileState = useCallback((key: string): TileState => {
    return tileStates.get(key) || { loaded: false, loading: false };
  }, [tileStates]);

  // 更新瓦片状态
  const updateTileState = useCallback((key: string, updates: Partial<TileState>) => {
    setTileStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(key) || { loaded: false, loading: false };
      newMap.set(key, { ...currentState, ...updates });
      return newMap;
    });
  }, []);

  // 清理状态
  const clearStates = useCallback(() => {
    setPagePosterStates(new Map());
    setTileStates(new Map());
    setViewState({ scale: DEFAULT_SCALE, scrollY: 0 });
    setCurrentVisiblePage(0);
    setLastScrollY(0);
    setCrossPageSelection(null);
  }, []);

  return {
    // 状态
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
    pagePosterStates,
    tileStates,
    
    // 跨页选区
    crossPageSelection,
    setCrossPageSelection,
    
    // 方法
    getPagePosterState,
    updatePagePosterState,
    getTileState,
    updateTileState,
    clearStates,
  };
}; 