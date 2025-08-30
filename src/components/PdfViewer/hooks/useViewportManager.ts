import { H_PADDING } from "@/PdfViewer/config";
import type { PdfMetadata } from "@/PdfViewer/types/pdf";
import { calculatePageLayouts, getExpandedVisiblePages, getVisiblePages } from "@/PdfViewer/utils/pdfLayout";
import { useCallback, useEffect, useMemo, useState } from "react";

interface ViewportState {
  containerHeight: number;
  containerWidth: number;
  maxPageWidth: number;
  totalWidth: number;
  totalHeight: number;
}

interface UseViewportManagerOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  pdfMetadata: PdfMetadata | null;
  scale: number;
  scrollY: number;
  hasInteracted: boolean;
  getDynamicPreloadAhead: (speed: number) => number;
  scrollSpeedPxPerMs: number;
  lastScrollY: number;
}

export const useViewportManager = (options: UseViewportManagerOptions) => {
  const [viewportState, setViewportState] = useState<ViewportState>({
    containerHeight: 0,
    containerWidth: 0,
    maxPageWidth: 0,
    totalWidth: 0,
    totalHeight: 0,
  });

  // 监听容器尺寸变化
  useEffect(() => {
    const updateDimensions = () => {
      const container = options.containerRef.current;
      if (!container) return;

      const height = container.clientHeight || window.innerHeight;
      const width = container.clientWidth || window.innerWidth;

      setViewportState((prev) => ({
        ...prev,
        containerHeight: height,
        containerWidth: width,
      }));
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, [options.containerRef]);

  // 计算页面布局
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const pageLayouts = useMemo(() => {
    if (!options.pdfMetadata) return [];
    return calculatePageLayouts(options.pdfMetadata, { scale: options.scale, scrollY: options.scrollY });
  }, [options.pdfMetadata, options.scale]);

  // 计算最大页宽与总尺寸
  const layoutMetrics = useMemo(() => {
    if (!pageLayouts || pageLayouts.length === 0) {
      return { maxPageWidth: 0, totalWidth: 0, totalHeight: 0 };
    }

    const maxPageWidth = Math.max(...pageLayouts.map((l) => l.width));
    const totalWidth = maxPageWidth > 0 ? H_PADDING * 2 + maxPageWidth : 0;
    const totalHeight =
      pageLayouts.length > 0
        ? pageLayouts[pageLayouts.length - 1].y + pageLayouts[pageLayouts.length - 1].height + 50
        : 0;

    return { maxPageWidth, totalWidth, totalHeight };
  }, [pageLayouts]);

  // 更新视口状态
  useEffect(() => {
    setViewportState((prev) => ({
      ...prev,
      maxPageWidth: layoutMetrics.maxPageWidth,
      totalWidth: layoutMetrics.totalWidth,
      totalHeight: layoutMetrics.totalHeight,
    }));
  }, [layoutMetrics]);

  // 计算可见页面
  const visibleLayouts = useMemo(() => {
    if (!options.pdfMetadata) return [];

    if (!options.hasInteracted) {
      // 初次打开仅渲染首屏
      const baseVisible = getVisiblePages(pageLayouts, viewportState.containerHeight, options.scrollY);
      if (baseVisible.length === 0) return [];

      const firstIdx = baseVisible[0].pageIndex;
      const lastIdx = baseVisible[baseVisible.length - 1].pageIndex;
      const endIdx = Math.min(pageLayouts.length - 1, lastIdx + 2);
      return pageLayouts.filter((l) => l.pageIndex >= firstIdx && l.pageIndex <= endIdx);
    }

    // 交互后动态扩展预加载窗口
    const dynamicAhead = options.getDynamicPreloadAhead(options.scrollSpeedPxPerMs);
    return getExpandedVisiblePages(
      pageLayouts,
      viewportState.containerHeight,
      options.scrollY,
      options.lastScrollY,
      dynamicAhead,
    );
  }, [
    options.pdfMetadata,
    pageLayouts,
    viewportState.containerHeight,
    options.scrollY,
    options.hasInteracted,
    options.getDynamicPreloadAhead,
    options.scrollSpeedPxPerMs,
    options.lastScrollY,
  ]);

  // 自动居中横向滚动
  const autoCenter = useCallback(
    (hasInteracted: boolean, onScrollUpdate: (x: number, y: number) => void) => {
      const container = options.containerRef.current;
      if (!container || hasInteracted) return;

      const cw = container.clientWidth;
      if (cw <= 0 || viewportState.maxPageWidth <= 0) return;

      const contentWidth = H_PADDING * 2 + viewportState.maxPageWidth;

      if (contentWidth > cw) {
        const targetLeft = Math.max(0, H_PADDING + (viewportState.maxPageWidth - cw) / 2);
        // 仅当与现有位置相差较大时才设置，避免抖动
        if (Math.abs(container.scrollLeft - targetLeft) > 1) {
          container.scrollLeft = targetLeft;
          onScrollUpdate(targetLeft, container.scrollTop);
        }
      }
    },
    [options.containerRef, viewportState.maxPageWidth],
  );

  // 计算页面在画布上的绘制位置
  const getPageDrawPosition = useCallback(
    (pageLayout: (typeof pageLayouts)[0], scrollX: number, scrollY: number) => {
      const containerWidth = viewportState.containerWidth;

      // 当内容宽度小于视口时，内容整体居中显示
      const baseOffset = Math.max(0, (containerWidth - viewportState.maxPageWidth) / 2 - H_PADDING);

      // 计算页面在内容区的左侧位置
      const pageLeft = baseOffset + H_PADDING + (viewportState.maxPageWidth - pageLayout.width) / 2;
      const pageTop = pageLayout.y + 40; // 加上padding

      // 计算页面在画布上的位置
      const canvasX = pageLeft - scrollX;
      const canvasY = pageTop - scrollY;

      return { canvasX, canvasY, pageLeft, pageTop };
    },
    [viewportState.containerWidth, viewportState.maxPageWidth],
  );

  return {
    viewportState,
    pageLayouts,
    visibleLayouts,
    autoCenter,
    getPageDrawPosition,
  };
};
