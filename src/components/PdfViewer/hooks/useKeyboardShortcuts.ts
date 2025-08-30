import { useEffect } from "react";
import { PdfMetadata, ViewState, PageLayout } from "@/PdfViewer/types/pdf";
import { MIN_SCALE, MAX_SCALE, PAGE_MARGIN, DEFAULT_SCALE } from "@/PdfViewer/config";

interface UseKeyboardShortcutsProps {
  pdfMetadata: PdfMetadata | null;
  currentVisiblePage: number;
  setViewState: React.Dispatch<React.SetStateAction<ViewState>>;
  setCurrentVisiblePage: React.Dispatch<React.SetStateAction<number>>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  pageLayouts: PageLayout[];
}

export const useKeyboardShortcuts = ({
  pdfMetadata,
  currentVisiblePage,
  setViewState,
  setCurrentVisiblePage,
  containerRef,
  pageLayouts,
}: UseKeyboardShortcutsProps) => {
  // 跳转到指定页面
  const goToPage = (pageIndex: number) => {
    if (!pdfMetadata || !containerRef.current) return;
    const targetLayout = pageLayouts[pageIndex];
    if (targetLayout) {
      const targetScrollY = targetLayout.y - PAGE_MARGIN;
      containerRef.current.scrollTop = targetScrollY;
      setViewState((prev) => ({
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
      scale: DEFAULT_SCALE,
      scrollY: 0,
    });
    setCurrentVisiblePage(0);
  };

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!pdfMetadata) return;

      switch (e.key) {
        case "Home":
          e.preventDefault();
          goToPage(0);
          break;
        case "End":
          e.preventDefault();
          goToPage(pdfMetadata.total_pages - 1);
          break;
        case "PageUp":
          e.preventDefault();
          goToPage(Math.max(0, currentVisiblePage - 1));
          break;
        case "PageDown":
          e.preventDefault();
          goToPage(Math.min(pdfMetadata.total_pages - 1, currentVisiblePage + 1));
          break;
        case "+":
        case "=":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setViewState((prev) => ({
              ...prev,
              scale: Math.min(MAX_SCALE, prev.scale * 1.25),
            }));
          }
          break;
        case "-":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setViewState((prev) => ({
              ...prev,
              scale: Math.max(MIN_SCALE, prev.scale * 0.8),
            }));
          }
          break;
        case "0":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            resetView();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pdfMetadata, currentVisiblePage, pageLayouts, containerRef, setViewState, setCurrentVisiblePage]);
};
