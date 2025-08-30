import { useState, useRef, useCallback } from 'react';
import { MIN_SCALE, MAX_SCALE } from '@/PdfViewer/config';

interface ZoomState {
  scale: number;
  isZooming: boolean;
}

interface UseZoomControllerOptions {
  onZoomChange?: (scale: number) => void;
  onInteractionDetected?: () => void;
}

export const useZoomController = (options: UseZoomControllerOptions = {}) => {
  const [zoomState, setZoomState] = useState<ZoomState>({
    scale: 1,
    isZooming: false,
  });

  const targetScrollRef = useRef<{ x: number | null; y: number | null }>({ x: null, y: null });

  // 缩放控制（以视口中心为锚点）
  const handleZoom = useCallback((
    delta: number,
    containerRef: React.RefObject<HTMLDivElement | null>,
    currentScrollX: number,
    currentScrollY: number
  ) => {
    options.onInteractionDetected?.();

    // 以视口中心为锚：计算缩放前中心在内容坐标中的位置
    const container = containerRef.current;
    const cw = container?.clientWidth || window.innerWidth;
    const ch = container?.clientHeight || window.innerHeight;
    const centerX = currentScrollX + cw / 2;
    const centerY = currentScrollY + ch / 2;

    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, zoomState.scale + delta));
    
    if (newScale !== zoomState.scale) {
      const scaleRatio = newScale / zoomState.scale;
      
      // 目标：缩放后保持中心锚点不动
      const targetX = Math.max(0, centerX * scaleRatio - cw / 2);
      const targetY = Math.max(0, centerY * scaleRatio - ch / 2);
      targetScrollRef.current = { x: targetX, y: targetY };

      setZoomState({
        scale: newScale,
        isZooming: true,
      });

      options.onZoomChange?.(newScale);
      
      // 标记缩放完成
      setTimeout(() => {
        setZoomState(prev => ({ ...prev, isZooming: false }));
      }, 100);
    }
  }, [zoomState.scale, options]);

  // 设置缩放级别
  const setZoomLevel = useCallback((scale: number) => {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    if (newScale !== zoomState.scale) {
      setZoomState({
        scale: newScale,
        isZooming: true,
      });
      options.onZoomChange?.(newScale);
      
      setTimeout(() => {
        setZoomState(prev => ({ ...prev, isZooming: false }));
      }, 100);
    }
  }, [zoomState.scale, options]);

  // 应用目标滚动位置
  const applyTargetScroll = useCallback((
    containerRef: React.RefObject<HTMLDivElement | null>,
    onScrollUpdate: (x: number, y: number) => void
  ) => {
    const container = containerRef.current;
    if (!container) return;
    
    const { x, y } = targetScrollRef.current;
    if (x == null && y == null) return;

    if (x != null) container.scrollLeft = x;
    if (y != null) container.scrollTop = y;

    onScrollUpdate(
      x != null ? x : container.scrollLeft,
      y != null ? y : container.scrollTop
    );

    // 应用一次后即清空目标
    targetScrollRef.current = { x: null, y: null };
  }, []);

  // 缩放到适合宽度
  const zoomToFitWidth = useCallback((
    containerWidth: number,
    pageWidth: number,
    padding: number = 40
  ) => {
    const availableWidth = containerWidth - padding * 2;
    const targetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, availableWidth / pageWidth));
    setZoomLevel(targetScale);
  }, [setZoomLevel]);

  // 缩放到适合页面
  const zoomToFitPage = useCallback((
    containerWidth: number,
    containerHeight: number,
    pageWidth: number,
    pageHeight: number,
    padding: number = 40
  ) => {
    const availableWidth = containerWidth - padding * 2;
    const availableHeight = containerHeight - padding * 2;
    const scaleX = availableWidth / pageWidth;
    const scaleY = availableHeight / pageHeight;
    const targetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(scaleX, scaleY)));
    setZoomLevel(targetScale);
  }, [setZoomLevel]);

  return {
    zoomState,
    handleZoom,
    setZoomLevel,
    applyTargetScroll,
    zoomToFitWidth,
    zoomToFitPage,
    targetScrollRef,
  };
}; 