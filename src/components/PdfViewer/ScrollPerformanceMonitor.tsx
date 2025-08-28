import React, { useState, useEffect, useRef } from 'react';
import { ScrollMetrics } from './hooks/useScrollHandler';

interface ScrollPerformanceMonitorProps {
  getScrollMetrics: () => ScrollMetrics;
  isScrolling: boolean;
  className?: string;
}

interface PerformanceStats {
  unreadyAreaRatio: number;
  avgFrameTime: number;
  blitCount: number;
  overscanEfficiency: number;
  lastUpdate: number;
}

export const ScrollPerformanceMonitor: React.FC<ScrollPerformanceMonitorProps> = ({
  getScrollMetrics,
  isScrolling,
  className = 'scroll-performance-monitor'
}) => {
  const [stats, setStats] = useState<PerformanceStats>({
    unreadyAreaRatio: 0,
    avgFrameTime: 0,
    blitCount: 0,
    overscanEfficiency: 0,
    lastUpdate: Date.now()
  });
  
  const [isVisible, setIsVisible] = useState(false);
  const frameTimesRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef<number>(performance.now());
  
  // 监控帧时间
  useEffect(() => {
    let animationId: number;
    
    const measureFrame = () => {
      const now = performance.now();
      const frameTime = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      
      // 只在滚动时记录帧时间
      if (isScrolling) {
        frameTimesRef.current.push(frameTime);
        // 保持最近50帧的记录
        if (frameTimesRef.current.length > 50) {
          frameTimesRef.current.shift();
        }
      }
      
      animationId = requestAnimationFrame(measureFrame);
    };
    
    measureFrame();
    
    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
    };
  }, [isScrolling]);
  
  // 更新性能统计
  useEffect(() => {
    const updateStats = () => {
      const metrics = getScrollMetrics();
      const now = Date.now();
      
      // 计算平均帧时间
      const avgFrameTime = frameTimesRef.current.length > 0
        ? frameTimesRef.current.reduce((sum, time) => sum + time, 0) / frameTimesRef.current.length
        : 0;
      
      // 计算overscan效率（简化版）
      const extraRows = metrics.overscan?.extraRows || 1;
      const extraCols = metrics.overscan?.extraCols || 1;
      const overscanEfficiency = isNaN(extraRows) || isNaN(extraCols) 
        ? 0 
        : Math.round((extraRows + extraCols) / 8 * 100); // 最大为4+4=8
      
      setStats(prev => ({
        unreadyAreaRatio: prev.unreadyAreaRatio, // 这需要从实际渲染中获取
        avgFrameTime: isNaN(avgFrameTime) ? 0 : Math.round(avgFrameTime * 100) / 100,
        blitCount: prev.blitCount + (metrics.deltaY !== 0 && !metrics.isLargeJump ? 1 : 0),
        overscanEfficiency: isNaN(overscanEfficiency) ? 0 : overscanEfficiency,
        lastUpdate: now
      }));
    };
    
    if (isScrolling) {
      const interval = setInterval(updateStats, 100);
      return () => clearInterval(interval);
    }
  }, [isScrolling, getScrollMetrics]);
  
  // 键盘快捷键切换显示
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Shift + P 切换性能监控显示
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setIsVisible(prev => !prev);
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
  
  if (!isVisible) {
    return (
      <div 
        className={`${className}-toggle`}
        style={{
          position: 'fixed',
          top: '10px',
          right: '10px',
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          cursor: 'pointer',
          zIndex: 1000,
        }}
        onClick={() => setIsVisible(true)}
        title="点击显示滚动性能监控 (Ctrl+Shift+P)"
      >
        📊
      </div>
    );
  }
  
  const metrics = getScrollMetrics();
  
  return (
    <div 
      className={className}
      style={{
        position: 'fixed',
        top: '10px',
        right: '10px',
        background: 'rgba(0,0,0,0.9)',
        color: 'white',
        padding: '12px',
        borderRadius: '8px',
        fontSize: '12px',
        fontFamily: 'monospace',
        minWidth: '280px',
        zIndex: 1000,
        border: '1px solid #333',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <strong>滚动性能监控</strong>
        <button 
          onClick={() => setIsVisible(false)}
          style={{ 
            background: 'none', 
            border: 'none', 
            color: 'white', 
            cursor: 'pointer',
            fontSize: '14px'
          }}
        >
          ×
        </button>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <div>
          <div>状态: {isScrolling ? '🔄 滚动中' : '⏸️ 静止'}</div>
          <div>速度: {isNaN(metrics.velocity.vy) ? '0.0' : Math.abs(metrics.velocity.vy).toFixed(1)} px/ms</div>
          <div>大跳转: {metrics.isLargeJump ? '✅' : '❌'}</div>
          <div>帧时间: {isNaN(stats.avgFrameTime) ? '0.0' : stats.avgFrameTime.toFixed(1)}ms</div>
        </div>
        
        <div>
          <div>Overscan: {metrics.overscan?.extraRows || 1}×{metrics.overscan?.extraCols || 1}</div>
          <div>效率: {isNaN(stats.overscanEfficiency) ? '0' : stats.overscanEfficiency}%</div>
          <div>Blit次数: {stats.blitCount}</div>
          <div>未就绪: {isNaN(stats.unreadyAreaRatio) ? '0.0' : (stats.unreadyAreaRatio * 100).toFixed(1)}%</div>
        </div>
      </div>
      
      <div style={{ marginTop: '8px', fontSize: '10px', color: '#ccc' }}>
        三道保险状态:
        <div>1️⃣ 画面复用: {!metrics.isLargeJump && Math.abs(metrics.deltaY) > 0 ? '🟢 活跃' : '⚪ 待机'}</div>
        <div>2️⃣ Overscan: {metrics.overscan.extraRows > 1 ? '🟢 扩展' : '🟡 基础'}</div>
        <div>3️⃣ 占位兜底: {metrics.isLargeJump ? '🟢 启用' : '⚪ 待机'}</div>
      </div>
      
      <div style={{ marginTop: '4px', fontSize: '9px', color: '#999' }}>
        Ctrl+Shift+P 切换显示
      </div>
    </div>
  );
}; 