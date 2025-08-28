import { useCallback, useRef } from 'react';
import { 
  PdfMetadata, 
  ViewState, 
  PageLayout, 
  SCROLL_DEBOUNCE_MS,
  MIN_SCALE,
  MAX_SCALE 
} from '../../../types/pdf';
import {
  calculateScrollVelocity,
  calculateOverscan,
  isLargeJump,
  ScrollVelocity,
  OverscanConfig
} from '../../../utils/scrollOptimization';

interface UseScrollHandlerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollTimeoutRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  pdfMetadata: PdfMetadata | null;
  pageLayouts: PageLayout[];
  viewState: ViewState;
  setViewState: React.Dispatch<React.SetStateAction<ViewState>>;
  setIsScrolling: React.Dispatch<React.SetStateAction<boolean>>;
  setLastScrollY: React.Dispatch<React.SetStateAction<number>>;
  setCurrentVisiblePage: React.Dispatch<React.SetStateAction<number>>;
  currentVisiblePage: number;
}

export interface ScrollMetrics {
  velocity: ScrollVelocity;
  overscan: OverscanConfig;
  isLargeJump: boolean;
  deltaY: number;
  timestamp: number;
}

export const useScrollHandler = ({
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
}: UseScrollHandlerProps) => {
  
  // 滚动度量追踪
  const lastScrollTimeRef = useRef<number>(Date.now());
  const scrollMetricsRef = useRef<ScrollMetrics>({
    velocity: { vx: 0, vy: 0 },
    overscan: { extraCols: 1, extraRows: 1 },
    isLargeJump: false,
    deltaY: 0,
    timestamp: Date.now()
  });
  
  // 处理滚动事件
  const handleWheel = useCallback((e: React.WheelEvent) => {
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

  // 监听容器滚动事件 - 集成三道保险机制
  const handleContainerScroll = useCallback(() => {
    if (!containerRef.current || !pdfMetadata) return;
    
    const currentTime = Date.now();
    const scrollTop = containerRef.current.scrollTop;
    const containerHeight = containerRef.current.clientHeight;
    const lastScrollY = viewState.scrollY;
    
    // 计算滚动度量
    const deltaTime = currentTime - lastScrollTimeRef.current;
    const deltaY = scrollTop - lastScrollY;
    
    // 计算滚动速度
    const velocity = calculateScrollVelocity(scrollTop, lastScrollY, deltaTime);
    
    // 计算自适应 overscan（基于页面瓦片大小的估算）
    const estimatedTileHeight = containerHeight / 4; // 假设每屏4个瓦片高度
    const overscan = calculateOverscan(velocity, 0, estimatedTileHeight);
    
    // 判断是否为大跳转
    const isLargeJumpDetected = isLargeJump(deltaY, containerHeight);
    
    // 更新滚动度量
    scrollMetricsRef.current = {
      velocity,
      overscan,
      isLargeJump: isLargeJumpDetected,
      deltaY,
      timestamp: currentTime
    };
    
    lastScrollTimeRef.current = currentTime;
    
    // 设置滚动状态为 true
    setIsScrolling(true);
    
    // 清除之前的定时器
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    // 设置新的定时器，在滚动停止后恢复渲染
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
      // 重置滚动度量
      scrollMetricsRef.current = {
        velocity: { vx: 0, vy: 0 },
        overscan: { extraCols: 1, extraRows: 1 },
        isLargeJump: false,
        deltaY: 0,
        timestamp: Date.now()
      };
    }, SCROLL_DEBOUNCE_MS);
    
    setViewState(prev => ({
      ...prev,
      scrollY: scrollTop,
    }));

    // 更新滚动位置记录
    setLastScrollY(scrollTop);

    // 更新当前可见页面
    const currentPage = pageLayouts.findIndex(layout => 
      layout.y <= scrollTop + containerHeight / 2 && 
      layout.y + layout.height > scrollTop + containerHeight / 2
    );
    if (currentPage !== -1 && currentPage !== currentVisiblePage) {
      setCurrentVisiblePage(currentPage);
    }
  }, [
    containerRef, 
    pdfMetadata, 
    pageLayouts, 
    scrollTimeoutRef, 
    setIsScrolling, 
    setViewState, 
    setLastScrollY, 
    setCurrentVisiblePage, 
    currentVisiblePage,
    viewState.scrollY
  ]);

  // 获取当前滚动度量
  const getScrollMetrics = useCallback((): ScrollMetrics => {
    return scrollMetricsRef.current;
  }, []);

  return {
    handleWheel,
    handleContainerScroll,
    getScrollMetrics,
  };
}; 