import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PageTextLayout, CharBoxPt, BASE_DPI } from '../../types/pdf';

interface PdfTextLayerProps {
  pdfId: string;
  pageIndex: number;
  pageWidth: number; // px
  pageHeight: number; // px
  scale: number;
  pageWidthPt: number;
  pageHeightPt: number;
  onTextSelect?: (text: string) => void;
}

// === 工具：pt <-> px（含 y 翻转） ===
const scaleFactor = (scale: number) => (BASE_DPI * scale) / 72.0;
const ptXToPx = (xPt: number, scale: number) => xPt * scaleFactor(scale);
const ptYToPx = (yPt: number, pageHpt: number, scale: number) => {
  const f = scaleFactor(scale);
  const H = Math.ceil(pageHpt * f); // 画布像素高
  return H - yPt * f; // y 翻转
};

function clamp(v: number, a: number, b: number) { 
  return Math.max(a, Math.min(b, v)); 
}

// 命中工具
function inRect(x: number, y: number, r: {x0: number, y0: number, x1: number, y1: number}) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function distRectSq(x: number, y: number, r: {x0: number, y0: number, x1: number, y1: number}) {
  const dx = x < r.x0 ? r.x0 - x : (x > r.x1 ? x - r.x1 : 0);
  const dy = y < r.y0 ? r.y0 - y : (y > r.y1 ? y - r.y1 : 0);
  return dx * dx + dy * dy;
}

export const PdfTextLayer: React.FC<PdfTextLayerProps> = ({
  pdfId,
  pageIndex,
  pageWidth,
  pageHeight,
  scale,
  pageWidthPt,
  pageHeightPt,
  onTextSelect
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<PageTextLayout | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  // 加载页面文本布局
  const loadLayout = useCallback(async () => {
    if (!pdfId) return;
    
    try {
      const textLayout = await invoke<PageTextLayout>('get_page_text_layout', {
        id: pdfId,
        page: pageIndex
      });
      setLayout(textLayout);
      console.log(`页面 ${pageIndex} 文本布局加载完成，字符数: ${textLayout.chars.length}`);
    } catch (error) {
      console.error('加载文本布局失败:', error);
      setLayout(null);
    }
  }, [pdfId, pageIndex]);

  useEffect(() => {
    loadLayout();
  }, [loadLayout]);

  // 设置画布尺寸
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.width = pageWidth;
    canvas.height = pageHeight;
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;
  }, [pageWidth, pageHeight]);

  // 字符命中测试
  const hitCharIndex = useCallback((x: number, y: number): number | null => {
    if (!layout) return null;
    
    let bestIdx: number | null = null;
    let best = Number.POSITIVE_INFINITY;
    
    for (const ch of layout.chars) {
      const x0 = ptXToPx(ch.left, scale);
      const x1 = ptXToPx(ch.right, scale);
      const y0 = ptYToPx(ch.top, pageHeightPt, scale);
      const y1 = ptYToPx(ch.bottom, pageHeightPt, scale);
      const r = { x0, y0, x1, y1 };
      
      if (inRect(x, y, r)) return ch.idx;
      
      const d = distRectSq(x, y, r);
      if (d < best) {
        best = d;
        bestIdx = ch.idx;
      }
    }
    
    return bestIdx;
  }, [layout, scale, pageHeightPt]);

  // 计算高亮矩形
  const highlightRects = useMemo(() => {
    if (!layout || anchor === null || focus === null) return [];

    const start = Math.max(0, Math.min(anchor, focus));
    const end   = Math.min(layout.chars.length - 1, Math.max(anchor, focus));

    // —— 工具：字符包围盒转像素矩形 + 行聚类 + X方向合并 ——
    // 计算一次就好：与缩放相关的像素级 padding
    const padPx = Math.max(1, Math.round(scaleFactor(scale) * 0.3));
    const gapEps = Math.max(6, Math.round(scaleFactor(scale) * 8)); // X方向合并阈值，足够跨越单词间空格

    type PxBox = {
      x0: number; x1: number; y0: number; y1: number;
      h: number; cy: number; idx: number;
    };

    function charToPxBox(ch: CharBoxPt, pageHpt: number, scale: number): PxBox {
      // 统一取整策略：left/top向下取整，right/bottom向上取整
      let x0 = Math.floor(ptXToPx(ch.left, scale));
      let x1 = Math.ceil(ptXToPx(ch.right, scale));
      let yTop = Math.floor(ptYToPx(ch.top, pageHpt, scale));
      let yBot = Math.ceil(ptYToPx(ch.bottom, pageHpt, scale));
      if (yTop > yBot) [yTop, yBot] = [yBot, yTop];
      const h = yBot - yTop;
      return { x0, x1, y0: yTop, y1: yBot, h, cy: yTop + h / 2, idx: ch.idx };
    }

    // 两个盒子的垂直重叠比例（相对较小高度）
    function vOverlapRatio(a: PxBox, b: PxBox): number {
      const top = Math.max(a.y0, b.y0);
      const bot = Math.min(a.y1, b.y1);
      const overlap = Math.max(0, bot - top);
      return overlap / Math.max(1, Math.min(a.h, b.h));
    }

    // 把若干字符盒子聚成"行"
    function groupIntoRows(boxes: PxBox[], thr = 0.6) {
      const rows: { y0: number; y1: number; cy: number; items: PxBox[] }[] = [];
      // 先按垂直中心排序，便于贪心归并
      boxes.sort((a, b) => a.cy - b.cy);
      for (const b of boxes) {
        let target = rows.find(r => vOverlapRatio(
          { x0: 0, x1: 0, y0: r.y0, y1: r.y1, h: r.y1 - r.y0, cy: r.cy, idx: -1 } as PxBox, b
        ) >= thr);
        if (!target) {
          target = { y0: b.y0, y1: b.y1, cy: b.cy, items: [b] };
          rows.push(target);
        } else {
          target.items.push(b);
          target.y0 = Math.min(target.y0, b.y0);
          target.y1 = Math.max(target.y1, b.y1);
          target.cy = (target.y0 + target.y1) / 2;
        }
      }
      // 每行按 x 排序
      rows.forEach(r => r.items.sort((a, b) => a.x0 - b.x0));
      return rows;
    }

    // X方向区间合并：将同一行内相邻或有小间隙的字符框合并成连续条带
    function mergeLineSegments(boxes: PxBox[], gapThreshold: number): { x0: number; x1: number; y0: number; y1: number }[] {
      if (boxes.length === 0) return [];
      
      const segments: { x0: number; x1: number; y0: number; y1: number }[] = [];
      let current = {
        x0: boxes[0].x0,
        x1: boxes[0].x1,
        y0: boxes[0].y0,
        y1: boxes[0].y1
      };

      for (let i = 1; i < boxes.length; i++) {
        const box = boxes[i];
        const gap = box.x0 - current.x1;
        
        if (gap <= gapThreshold) {
          // 合并到当前段：扩展X范围，Y取最大包围
          current.x1 = Math.max(current.x1, box.x1);
          current.y0 = Math.min(current.y0, box.y0);
          current.y1 = Math.max(current.y1, box.y1);
        } else {
          // 间隙太大，结束当前段，开始新段
          segments.push(current);
          current = {
            x0: box.x0,
            x1: box.x1,
            y0: box.y0,
            y1: box.y1
          };
        }
      }
      segments.push(current);
      
      return segments;
    }

    // 仅取被选中的字符 -> 像素盒
    const selected: PxBox[] = [];
    for (let i = start; i <= end; i++) {
      selected.push(charToPxBox(layout.chars[i], pageHeightPt, scale));
    }

    // 按垂直重叠聚成"行"
    const rows = groupIntoRows(selected, 0.6);

    // 每行内做X方向合并，生成连续条带
    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const row of rows) {
      const segments = mergeLineSegments(row.items, gapEps);
      for (const seg of segments) {
        rects.push({
          x0: seg.x0 - padPx,
          y0: seg.y0 - Math.ceil(padPx * 0.2),
          x1: seg.x1 + padPx,
          y1: seg.y1 + Math.ceil(padPx * 0.2)
        });
      }
    }

    // 跨行时，按 y 再排序一下，渲染会更自然
    rects.sort((a, b) => a.y0 - b.y0);
    return rects;
  }, [layout, anchor, focus, scale, pageHeightPt]);

  // 绘制选区高亮 - 使用一次性填充避免透明叠加
  const paintSelection = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!highlightRects.length) return;
    
    // 一次性填充所有矩形，避免透明叠加
    ctx.save();
    ctx.fillStyle = 'rgba(0, 120, 215, 0.30)'; // 选区蓝
    ctx.beginPath();
    for (const r of highlightRects) {
      ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    }
    ctx.fill(); // 只填充一次
    ctx.restore();
  }, [highlightRects]);

  useEffect(() => {
    paintSelection();
  }, [paintSelection]);

  // 获取画布坐标
  const getCanvasXY = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    return {
      x: clamp(x, 0, canvas.width),
      y: clamp(y, 0, canvas.height)
    };
  }, []);

  // 鼠标事件处理
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!layout) return;
    
    const { x, y } = getCanvasXY(e);
    const idx = hitCharIndex(x, y);
    
    if (idx !== null) {
      setAnchor(idx);
      setFocus(idx);
      setIsSelecting(true);
    }
    
    e.preventDefault();
  }, [layout, getCanvasXY, hitCharIndex]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || anchor === null) return;
    
    const { x, y } = getCanvasXY(e);
    const idx = hitCharIndex(x, y);
    
    if (idx !== null) {
      setFocus(idx);
    }
    
    e.preventDefault();
  }, [isSelecting, anchor, getCanvasXY, hitCharIndex]);

  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    if (!isSelecting || anchor === null || focus === null || !layout) {
      setAnchor(null);
      setFocus(null);
      setIsSelecting(false);
      return;
    }
    
    const start = Math.max(0, Math.min(anchor, focus));
    const end = Math.min(layout.chars.length - 1, Math.max(anchor, focus));
    
    // 提取选中的文本
    const text = layout.chars.slice(start, end + 1).map(c => c.ch).join('');
    
    if (text.trim()) {
      try {
        await navigator.clipboard.writeText(text);
        console.log('文本已复制到剪贴板:', text);
        onTextSelect?.(text);
      } catch (error) {
        console.error('复制到剪贴板失败:', error);
        onTextSelect?.(text);
      }
    }
    
    setIsSelecting(false);
    // 保留选区高亮，如果想清除选区，取消注释下面两行
    // setAnchor(null);
    // setFocus(null);
    
    e.preventDefault();
  }, [isSelecting, anchor, focus, layout, onTextSelect]);

  // 清除选区
  const clearSelection = useCallback(() => {
    setAnchor(null);
    setFocus(null);
    setIsSelecting(false);
  }, []);

  // 键盘事件：Escape 清除选区
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [clearSelection]);

  return (
    <canvas
      ref={canvasRef}
      className="pdf-text-layer"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: pageWidth,
        height: pageHeight,
        pointerEvents: 'auto',
        cursor: isSelecting ? 'text' : 'default',
      }}
    />
  );
}; 