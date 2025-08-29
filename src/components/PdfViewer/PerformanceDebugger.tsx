import React, { useState, useEffect } from 'react';

interface WorkerStats {
  activeTasks: number;
  queuedTasks: number;
  pendingTasks: number;
  maxConcurrency: number;
}

interface PerformanceDebuggerProps {
  isVisible: boolean;
  onToggle: () => void;
}

export const PerformanceDebugger: React.FC<PerformanceDebuggerProps> = ({
  isVisible,
  onToggle,
}) => {
  const [workerStats, setWorkerStats] = useState<WorkerStats | null>(null);
  const [resourceTimings, setResourceTimings] = useState<PerformanceResourceTiming[]>([]);

  useEffect(() => {
    if (!isVisible) return;

    // 监听Resource Timing API
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntriesByType('resource') as PerformanceResourceTiming[];
      const tileEntries = entries.filter(entry => 
        entry.name.includes('tiles://') || entry.name.includes('.webp')
      );
      
      if (tileEntries.length > 0) {
        setResourceTimings(prev => [...prev.slice(-10), ...tileEntries].slice(-20));
      }
    });

    observer.observe({ type: 'resource', buffered: true });

    // 定期更新Worker状态（如果可用）
    const updateInterval = setInterval(() => {
      try {
        // 这里需要访问全局的WorkerLoader实例
        // 由于我们的实现是在PageCanvas中，这里只是示例
        // 实际实现中可能需要通过props传递或context提供
        setWorkerStats({
          activeTasks: Math.floor(Math.random() * 6), // 模拟数据
          queuedTasks: Math.floor(Math.random() * 10),
          pendingTasks: Math.floor(Math.random() * 15),
          maxConcurrency: 6
        });
      } catch (error) {
        console.warn('Failed to get worker stats:', error);
      }
    }, 1000);

    return () => {
      observer.disconnect();
      clearInterval(updateInterval);
    };
  }, [isVisible]);

  const clearTimings = () => {
    setResourceTimings([]);
  };

  if (!isVisible) {
    return (
      <button
        onClick={onToggle}
        className="fixed bottom-4 right-4 px-3 py-2 bg-neutral-700 text-white rounded-full text-sm hover:bg-neutral-800 z-50"
      >
        📊 性能调试
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 w-96 max-h-96 bg-white rounded-lg shadow-lg border overflow-hidden z-50">
      <div className="flex justify-between items-center p-3 bg-neutral-100 border-b">
        <h3 className="font-semibold text-neutral-800">性能调试器</h3>
        <button
          onClick={onToggle}
          className="px-2 py-1 text-neutral-600 hover:text-neutral-800"
        >
          ✕
        </button>
      </div>

      <div className="p-3 space-y-4 overflow-y-auto max-h-80">
        {/* Worker状态 */}
        {workerStats && (
          <div className="bg-neutral-50 rounded p-2">
            <h4 className="text-sm font-medium text-neutral-700 mb-2">Worker加载器状态</h4>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>活跃任务: <span className="font-mono text-green-600">{workerStats.activeTasks}</span></div>
              <div>队列任务: <span className="font-mono text-blue-600">{workerStats.queuedTasks}</span></div>
              <div>等待任务: <span className="font-mono text-orange-600">{workerStats.pendingTasks}</span></div>
              <div>最大并发: <span className="font-mono text-neutral-600">{workerStats.maxConcurrency}</span></div>
            </div>
            
            <div className="mt-2">
              <div className="text-xs text-neutral-600">并发使用率</div>
              <div className="w-full bg-neutral-200 rounded-full h-2">
                <div 
                  className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                  style={{ 
                    width: `${Math.min(100, (workerStats.activeTasks / workerStats.maxConcurrency) * 100)}%` 
                  }}
                />
              </div>
              <div className="text-xs text-neutral-500 mt-1">
                {workerStats.activeTasks}/{workerStats.maxConcurrency} ({Math.round((workerStats.activeTasks / workerStats.maxConcurrency) * 100)}%)
              </div>
            </div>
          </div>
        )}

        {/* Resource Timing */}
        <div className="bg-neutral-50 rounded p-2">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-sm font-medium text-neutral-700">最近的网络请求</h4>
            <button
              onClick={clearTimings}
              className="text-xs text-neutral-500 hover:text-neutral-700"
            >
              清除
            </button>
          </div>
          
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {resourceTimings.slice(-10).reverse().map((entry, index) => {
              const queueing = (entry.requestStart - entry.startTime);
              const ttfb = (entry.responseStart - entry.requestStart);
              const download = (entry.responseEnd - entry.responseStart);
              const total = (entry.responseEnd - entry.startTime);
              
              return (
                <div key={index} className="text-xs bg-white rounded p-2 border">
                  <div className="font-mono text-neutral-600 truncate mb-1">
                    {entry.name.split('/').pop() || entry.name}
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-neutral-700">
                    <div>Q: {queueing.toFixed(0)}ms</div>
                    <div>T: {ttfb.toFixed(0)}ms</div>
                    <div className={`${download > 100 ? 'text-red-600 font-bold' : download > 50 ? 'text-orange-600' : 'text-green-600'}`}>
                      D: {download.toFixed(0)}ms
                    </div>
                    <div>Tot: {total.toFixed(0)}ms</div>
                  </div>
                </div>
              );
            })}
            
            {resourceTimings.length === 0 && (
              <div className="text-xs text-neutral-500 text-center py-2">
                暂无网络请求记录
              </div>
            )}
          </div>
        </div>

        {/* 性能提示 */}
        <div className="bg-blue-50 rounded p-2">
          <h4 className="text-sm font-medium text-blue-700 mb-1">性能提示</h4>
          <div className="text-xs text-blue-600 space-y-1">
            <div>• 关注Download时间，应该 &lt; 50ms</div>
            <div>• Worker并发使用率建议保持在80%以下</div>
            <div>• TTFB应该接近0（缓存命中）</div>
            <div>• 红色Download表示可能的主线程阻塞</div>
          </div>
        </div>
      </div>
    </div>
  );
}; 