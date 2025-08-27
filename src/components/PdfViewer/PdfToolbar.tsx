import React from 'react';
import { PdfMetadata, ViewState, MIN_SCALE, MAX_SCALE } from '../../types/pdf';
import { usePdfState } from '../../hooks/usePdfState';

interface PdfToolbarProps {
  loading: boolean;
  pdfMetadata: PdfMetadata | null;
  currentVisiblePage: number;
  viewState: ViewState;
  setViewState: React.Dispatch<React.SetStateAction<ViewState>>;
  isScrolling: boolean;
  pdfState: ReturnType<typeof usePdfState>;
  onOpenPdf: () => void;
  onResetView: () => void;
}

export const PdfToolbar: React.FC<PdfToolbarProps> = ({
  loading,
  pdfMetadata,
  currentVisiblePage,
  viewState,
  setViewState,
  pdfState,
  onOpenPdf,
  onResetView,
}) => {
  const { pagePosterStates, tileStates } = pdfState;

  return (
    <div className="toolbar">
      <button onClick={onOpenPdf} disabled={loading}>
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
            <button onClick={onResetView}>Reset View</button>
          </div>
          
          {/* <div className="help-text">
            <small>
              滚轮滚动翻页 | Ctrl/Cmd + 滚轮缩放 | Ctrl/Cmd + 0 重置
            </small>
          </div>
          
          {isScrolling && (
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
  );
}; 