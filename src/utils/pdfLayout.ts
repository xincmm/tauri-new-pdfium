import { PdfMetadata, ViewState, PageLayout, PAGE_MARGIN } from '../types/pdf';

// 计算页面布局
export const calculatePageLayouts = (
  pdfMetadata: PdfMetadata | null,
  viewState: ViewState
): PageLayout[] => {
  if (!pdfMetadata) return [];
  
  const baseDpi = 96.0;
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
};

// 计算总文档高度
export const getTotalDocumentHeight = (layouts: PageLayout[]): number => {
  if (layouts.length === 0) return 0;
  const lastLayout = layouts[layouts.length - 1];
  return lastLayout.y + lastLayout.height + PAGE_MARGIN;
};

// 获取当前可见的页面
export const getVisiblePages = (
  layouts: PageLayout[],
  containerHeight: number,
  scrollY: number
): PageLayout[] => {
  const viewportTop = scrollY;
  const viewportBottom = scrollY + containerHeight;
  
  return layouts.filter(layout => 
    layout.y < viewportBottom && layout.y + layout.height > viewportTop
  );
};

// 获取扩展的可见页面（包括预加载区域）
export const getExpandedVisiblePages = (
  layouts: PageLayout[],
  containerHeight: number,
  scrollY: number,
  lastScrollY: number,
  preloadPagesAhead: number
): PageLayout[] => {
  // 首先获取当前可见的页面
  const currentVisiblePages = getVisiblePages(layouts, containerHeight, scrollY);
  
  if (currentVisiblePages.length === 0) return [];
  
  // 根据滚动方向和预加载页数确定预加载范围
  const scrollingDown = scrollY > lastScrollY;
  const firstVisiblePageIndex = currentVisiblePages[0].pageIndex;
  const lastVisiblePageIndex = currentVisiblePages[currentVisiblePages.length - 1].pageIndex;
  
  let startPageIndex = firstVisiblePageIndex;
  let endPageIndex = lastVisiblePageIndex;
  
  if (scrollingDown) {
    // 向下滚动时，预加载后面的页面
    endPageIndex = Math.min(layouts.length - 1, lastVisiblePageIndex + preloadPagesAhead);
  } else {
    // 向上滚动时，预加载前面的页面，但也保持一些后面的页面
    startPageIndex = Math.max(0, firstVisiblePageIndex - Math.floor(preloadPagesAhead / 2));
    endPageIndex = Math.min(layouts.length - 1, lastVisiblePageIndex + Math.ceil(preloadPagesAhead / 2));
  }
  
  // 返回扩展范围内的所有页面
  return layouts.filter(layout => 
    layout.pageIndex >= startPageIndex && layout.pageIndex <= endPageIndex
  );
}; 