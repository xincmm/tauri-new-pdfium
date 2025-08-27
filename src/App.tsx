import React, { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import './App.css';

interface PdfMetadata {
  id: string;
  total_pages: number;
  page_dims: [number, number][];
}

interface TileInfo {
  id: string;
  page: number;
  scale: number;
  tx: number;
  ty: number;
}

interface ViewState {
  scale: number;
  offsetX: number;
  offsetY: number;
  currentPage: number;
}

const TILE_SIZE = 512;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5.0;

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdfMetadata, setPdfMetadata] = useState<PdfMetadata | null>(null);
  const [viewState, setViewState] = useState<ViewState>({
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    currentPage: 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const [tileCache] = useState(new Map<string, HTMLImageElement>());
  const [loading, setLoading] = useState(false);

  // 打开 PDF 文件
  const openPdfFile = async () => {
    try {
      setLoading(true);
      const selected = await open({
        filters: [{
          name: 'PDF Files',
          extensions: ['pdf']
        }]
      });
      
      if (selected) {
        const metadata = await invoke<PdfMetadata>('open_pdf', { path: selected });
        setPdfMetadata(metadata);
        setViewState(prev => ({ ...prev, currentPage: 0 }));
        console.log('PDF loaded:', metadata);
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
      alert('Failed to open PDF file');
    } finally {
      setLoading(false);
    }
  };

  // 获取 tile URL
  const getTileUrl = (tileInfo: TileInfo): string => {
    const { id, page, scale, tx, ty } = tileInfo;
    return `tiles://localhost/${id}/${page}/${scale}/${tx}/${ty}.webp`;
  };

  // 获取 tile 缓存键
  const getTileKey = (tileInfo: TileInfo): string => {
    return `${tileInfo.id}_${tileInfo.page}_${tileInfo.scale}_${tileInfo.tx}_${tileInfo.ty}`;
  };

  // 加载 tile 图片
  const loadTile = useCallback(async (tileInfo: TileInfo): Promise<HTMLImageElement> => {
    const key = getTileKey(tileInfo);
    
    // 检查缓存
    if (tileCache.has(key)) {
      return tileCache.get(key)!;
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      img.onload = () => {
        tileCache.set(key, img);
        resolve(img);
      };
      
      img.onerror = () => {
        console.error('Failed to load tile:', getTileUrl(tileInfo));
        reject(new Error('Failed to load tile'));
      };
      
      img.src = getTileUrl(tileInfo);
    });
  }, [tileCache]);

  // 渲染当前页面
  const renderPage = useCallback(async () => {
    if (!pdfMetadata || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { scale, offsetX, offsetY, currentPage } = viewState;
    const [pageWidth, pageHeight] = pdfMetadata.page_dims[currentPage];
    
    // 计算页面在屏幕上的尺寸
    const baseDpi = 144.0;
    const screenPageWidth = ((pageWidth / 72.0) * baseDpi * scale);
    const screenPageHeight = ((pageHeight / 72.0) * baseDpi * scale);

    // 清空画布
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 计算需要渲染的 tile 范围
    const startTileX = Math.max(0, Math.floor(-offsetX / TILE_SIZE));
    const endTileX = Math.ceil((canvas.width - offsetX) / TILE_SIZE);
    const startTileY = Math.max(0, Math.floor(-offsetY / TILE_SIZE));
    const endTileY = Math.ceil((canvas.height - offsetY) / TILE_SIZE);

    const maxTileX = Math.ceil(screenPageWidth / TILE_SIZE);
    const maxTileY = Math.ceil(screenPageHeight / TILE_SIZE);

    // 加载并渲染 tiles
    const tilePromises: Promise<void>[] = [];

    for (let tx = startTileX; tx < Math.min(endTileX, maxTileX); tx++) {
      for (let ty = startTileY; ty < Math.min(endTileY, maxTileY); ty++) {
        const tileInfo: TileInfo = {
          id: pdfMetadata.id,
          page: currentPage,
          scale: Math.round(scale * 100) / 100, // 保留两位小数
          tx,
          ty,
        };

        const tilePromise = loadTile(tileInfo).then(img => {
          // 计算 tile 在 canvas 上的位置
          const x = offsetX + tx * TILE_SIZE;
          const y = offsetY + ty * TILE_SIZE;
          
          // 计算实际渲染尺寸（处理边缘 tile）
          const renderWidth = Math.min(TILE_SIZE, screenPageWidth - tx * TILE_SIZE);
          const renderHeight = Math.min(TILE_SIZE, screenPageHeight - ty * TILE_SIZE);
          
          ctx.drawImage(img, x, y, renderWidth, renderHeight);
        }).catch(err => {
          console.warn('Failed to load tile:', tileInfo, err);
        });

        tilePromises.push(tilePromise);
      }
    }

    // 等待所有 tiles 加载完成
    await Promise.allSettled(tilePromises);
  }, [pdfMetadata, viewState, loadTile]);

  // 处理鼠标滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, viewState.scale * delta));
    
    if (newScale !== viewState.scale) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      // 以鼠标位置为中心缩放
      const scaleRatio = newScale / viewState.scale;
      const newOffsetX = mouseX - (mouseX - viewState.offsetX) * scaleRatio;
      const newOffsetY = mouseY - (mouseY - viewState.offsetY) * scaleRatio;
      
      setViewState(prev => ({
        ...prev,
        scale: newScale,
        offsetX: newOffsetX,
        offsetY: newOffsetY,
      }));
    }
  }, [viewState]);

  // 处理鼠标拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    setLastMousePos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    
    const deltaX = e.clientX - lastMousePos.x;
    const deltaY = e.clientY - lastMousePos.y;
    
    setViewState(prev => ({
      ...prev,
      offsetX: prev.offsetX + deltaX,
      offsetY: prev.offsetY + deltaY,
    }));
    
    setLastMousePos({ x: e.clientX, y: e.clientY });
  }, [isDragging, lastMousePos]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 页面导航
  const goToPage = (page: number) => {
    if (!pdfMetadata) return;
    const newPage = Math.max(0, Math.min(pdfMetadata.total_pages - 1, page));
    setViewState(prev => ({ ...prev, currentPage: newPage }));
  };

  // 重置视图
  const resetView = () => {
    setViewState(prev => ({
      ...prev,
      scale: 1.0,
      offsetX: 100,
      offsetY: 100,
    }));
  };

  // 画布尺寸调整
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight - 100; // 留出控制栏空间
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!pdfMetadata) return;
      
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          goToPage(viewState.currentPage - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          goToPage(viewState.currentPage + 1);
          break;
        case '+':
        case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setViewState(prev => ({ 
              ...prev, 
              scale: Math.min(MAX_SCALE, prev.scale * 1.25) 
            }));
          }
          break;
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setViewState(prev => ({ 
              ...prev, 
              scale: Math.max(MIN_SCALE, prev.scale * 0.8) 
            }));
          }
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            resetView();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pdfMetadata, viewState.currentPage]);

  // 渲染页面
  useEffect(() => {
    renderPage();
  }, [renderPage]);

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={openPdfFile} disabled={loading}>
          {loading ? 'Loading...' : 'Open PDF'}
        </button>
        
        {pdfMetadata && (
          <>
            <div className="page-controls">
              <button 
                onClick={() => goToPage(viewState.currentPage - 1)}
                disabled={viewState.currentPage === 0}
              >
                Previous
              </button>
              <span>
                Page {viewState.currentPage + 1} of {pdfMetadata.total_pages}
              </span>
              <button 
                onClick={() => goToPage(viewState.currentPage + 1)}
                disabled={viewState.currentPage === pdfMetadata.total_pages - 1}
              >
                Next
              </button>
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
              <button onClick={resetView}>Reset View</button>
            </div>
            
            <div className="help-text">
              <small>
                快捷键: ← → 翻页 | Ctrl/Cmd + +/- 缩放 | Ctrl/Cmd + 0 重置
              </small>
            </div>
          </>
        )}
      </div>

      <canvas
        ref={canvasRef}
        className="pdf-canvas"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      />
    </div>
  );
}

export default App;
