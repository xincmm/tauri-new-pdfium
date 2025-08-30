import { useState, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { PdfMetadata } from '@/PdfViewer/types/pdf';

interface PdfLoaderState {
  pdfMetadata: PdfMetadata | null;
  isLoading: boolean;
  error: string | null;
}

interface UsePdfLoaderOptions {
  onPdfLoaded?: (metadata: PdfMetadata) => void;
  onError?: (error: string) => void;
  onClearRender?: () => void;
}

export const usePdfLoader = (options: UsePdfLoaderOptions = {}) => {
  const [state, setState] = useState<PdfLoaderState>({
    pdfMetadata: null,
    isLoading: false,
    error: null,
  });

  // 打开PDF文件
  const handleOpenPdf = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));

      const selected = await open({
        filters: [{
          name: 'PDF',
          extensions: ['pdf']
        }]
      });

      if (selected) {
        const metadata = await invoke<PdfMetadata>('load_pdf', { filePath: selected });
        
        setState({
          pdfMetadata: metadata,
          isLoading: false,
          error: null,
        });

        // 清理旧的渲染状态
        options.onClearRender?.();
        options.onPdfLoaded?.(metadata);
      } else {
        setState(prev => ({ ...prev, isLoading: false }));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'PDF loading failed';
      setState({
        pdfMetadata: null,
        isLoading: false,
        error: errorMessage,
      });
      options.onError?.(errorMessage);
    }
  }, [options]);

  // 关闭PDF
  const closePdf = useCallback(() => {
    setState({
      pdfMetadata: null,
      isLoading: false,
      error: null,
    });
    options.onClearRender?.();
  }, [options]);

  // 重新加载当前PDF
  const reloadPdf = useCallback(async () => {
    if (state.pdfMetadata) {
      // 这里可以重新调用load_pdf，但需要保存文件路径
      // 暂时简化为清理并重新打开
      handleOpenPdf();
    }
  }, [state.pdfMetadata, handleOpenPdf]);

  return {
    pdfMetadata: state.pdfMetadata,
    isLoading: state.isLoading,
    error: state.error,
    handleOpenPdf,
    closePdf,
    reloadPdf,
  };
}; 