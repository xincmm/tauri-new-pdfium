import { PdfMetadata, ViewState, PageLayout, getPageDimensions } from "@/PdfViewer/types/pdf";

export function calculatePageLayouts(pdfMetadata: PdfMetadata, viewState: ViewState): PageLayout[] {
  const { scale } = viewState;
  const layouts: PageLayout[] = [];

  let currentY = 0;
  const pageMargin = 20;

  for (let i = 0; i < pdfMetadata.total_pages; i++) {
    // 使用优化的页面尺寸获取
    const [pdfWidthPt, pdfHeightPt] = getPageDimensions(pdfMetadata, i);

    // 将 PDF 点转换为屏幕像素（72 点 = 96 像素，在 100% 缩放下）
    const screenWidth = ((pdfWidthPt * 96) / 72) * scale;
    const screenHeight = ((pdfHeightPt * 96) / 72) * scale;

    layouts.push({
      pageIndex: i,
      y: currentY,
      width: screenWidth,
      height: screenHeight,
    });

    currentY += screenHeight + pageMargin;
  }

  return layouts;
}

export function getVisiblePages(pageLayouts: PageLayout[], containerHeight: number, scrollY: number): PageLayout[] {
  const viewportTop = scrollY;
  const viewportBottom = scrollY + containerHeight;

  return pageLayouts.filter((layout) => {
    const pageTop = layout.y;
    const pageBottom = layout.y + layout.height;

    // 页面与视口有交集
    return pageBottom > viewportTop && pageTop < viewportBottom;
  });
}

export function getExpandedVisiblePages(
  pageLayouts: PageLayout[],
  containerHeight: number,
  scrollY: number,
  lastScrollY: number,
  preloadAhead: number,
): PageLayout[] {
  // 基础可见页面
  const visiblePages = getVisiblePages(pageLayouts, containerHeight, scrollY);

  if (visiblePages.length === 0) return [];

  // 判断滚动方向
  const scrollDirection = scrollY > lastScrollY ? 1 : scrollY < lastScrollY ? -1 : 0;

  const firstVisibleIndex = visiblePages[0].pageIndex;
  const lastVisibleIndex = visiblePages[visiblePages.length - 1].pageIndex;

  // 扩展范围
  let startIndex = firstVisibleIndex;
  let endIndex = lastVisibleIndex;

  if (scrollDirection > 0) {
    // 向下滚动，预加载下方页面
    endIndex = Math.min(pageLayouts.length - 1, lastVisibleIndex + preloadAhead);
  } else if (scrollDirection < 0) {
    // 向上滚动，预加载上方页面
    startIndex = Math.max(0, firstVisibleIndex - preloadAhead);
  } else {
    // 静止或初始状态，双向预加载
    startIndex = Math.max(0, firstVisibleIndex - Math.floor(preloadAhead / 2));
    endIndex = Math.min(pageLayouts.length - 1, lastVisibleIndex + Math.ceil(preloadAhead / 2));
  }

  return pageLayouts.slice(startIndex, endIndex + 1);
}
