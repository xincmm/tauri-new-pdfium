import React, { useState, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { SimplePage } from './SimplePage';
import { PdfMetadata } from '../../types/pdf';
import { calculatePageLayouts } from '../../utils/pdfLayout';

export const SimpleViewer: React.FC = () => {
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState({
    scale: 1.0,
    scrollY: 0,
  });

  // 计算页面布局
  const pageLayouts = useMemo(() => {
    if (!pdfMetadata) return [];
    return calculatePageLayouts(pdfMetadata, viewState);
  }, [pdfMetadata, viewState]);

  const totalHeight = pageLayouts.length > 0 
    ? pageLayouts[pageLayouts.length - 1].y + pageLayouts[pageLayouts.length - 1].height + 50 
    : 0;

  // 打开PDF文件
  const handleOpenPdf = async () => {
    try {
      const selected = await open({
        filters: [{
          name: 'PDF',
          extensions: ['pdf']
        }]
      });

      if (selected) {
        console.log(`🔍 正在加载PDF: ${selected}`);
        const metadata = await invoke<PdfMetadata>('load_pdf', { filePath: selected });
        console.log('📄 PDF元数据:', metadata);
        setPdfMetadata(metadata);
      }
    } catch (error) {
      console.error('❌ PDF加载失败:', error);
    }
  };

  // 缩放控制
  const handleZoom = (delta: number) => {
    setViewState(prev => ({
      ...prev,
      scale: Math.max(0.25, Math.min(4.0, prev.scale + delta)),
    }));
  };

  // 滚动处理
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target) {
      setViewState(prev => ({
        ...prev,
        scrollY: target.scrollTop,
      }));
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 工具栏 */}
      <div
        style={{
          height: '60px',
          background: '#f5f5f5',
          border: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: '12px',
        }}
      >
        <button
          onClick={handleOpenPdf}
          style={{
            padding: '8px 16px',
            background: '#007acc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          打开PDF
        </button>

        {pdfMetadata && (
          <>
            <span style={{ color: '#666' }}>
              {pdfMetadata.total_pages} 页
            </span>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button onClick={() => handleZoom(-0.25)}>-</button>
              <span>{Math.round(viewState.scale * 100)}%</span>
              <button onClick={() => handleZoom(0.25)}>+</button>
            </div>

            <span style={{ color: '#666', fontSize: '14px' }}>
              简化并发渲染测试
            </span>
          </>
        )}
      </div>

      {/* PDF内容区 */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#e8e8e8',
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
        }}
        onScroll={handleScroll}
      >
        {pdfMetadata && pageLayouts.length > 0 && (
          <div
            style={{
              position: 'relative',
              width: Math.max(...pageLayouts.map(l => l.width)), // 使用最大页面宽度
              minHeight: totalHeight,
              padding: '40px 20px',
            }}
          >
            {pageLayouts.map((layout) => (
              <div
                key={layout.pageIndex}
                style={{
                  position: 'absolute',
                  top: layout.y + 40,
                  left: 0,
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'center',
                }}
              >
                <SimplePage
                  pdfMetadata={pdfMetadata}
                  pageIndex={layout.pageIndex}
                  pageLayout={layout}
                  viewState={viewState}
                  isVisible={true} // 简单起见，先让所有页面都可见
                />
              </div>
            ))}
          </div>
        )}

        {!pdfMetadata && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              color: '#666',
            }}
          >
            <h3>简化并发渲染测试</h3>
            <p>点击"打开PDF"开始测试</p>
          </div>
        )}
      </div>
    </div>
  );
}; 