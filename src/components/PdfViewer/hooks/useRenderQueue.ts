import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface PageLayoutLike {
  pageIndex: number;
  y: number;
  width: number;
  height: number;
}

export interface EnqueueTask {
  pageIndex: number;
  layout: PageLayoutLike;
  priority: number; // 数值越小优先级越高
}

interface InternalTask extends EnqueueTask {
  id: string;
  epoch: number;
  addedAt: number;
}

export function useRenderQueue(
  updatePageRender: (pageIndex: number, pageLayout: PageLayoutLike) => Promise<void>
) {
  const queueRef = useRef<InternalTask[]>([]);
  const isRunningRef = useRef<boolean>(false);
  const enabledRef = useRef<boolean>(true);
  const currentEpochRef = useRef<number>(0);

  const processNext = useCallback(() => {
    if (!enabledRef.current) return;
    if (isRunningRef.current) return;

    // 只处理当前 epoch 的任务；按优先级升序、时间升序
    const epoch = currentEpochRef.current;
    const candidates = queueRef.current
      .filter(t => t.epoch === epoch)
      .sort((a, b) => a.priority - b.priority || a.addedAt - b.addedAt);

    if (candidates.length === 0) return;

    const task = candidates[0];
    // 从队列移除该任务
    queueRef.current = queueRef.current.filter(t => t.id !== task.id);
    isRunningRef.current = true;

    Promise.resolve(updatePageRender(task.pageIndex, task.layout))
      .catch(() => {})
      .finally(() => {
        isRunningRef.current = false;
        // 微任务后继续
        setTimeout(processNext, 0);
      });
  }, [updatePageRender]);

  const enqueue = useCallback((items: EnqueueTask | EnqueueTask[]) => {
    const list = Array.isArray(items) ? items : [items];
    const epoch = currentEpochRef.current;

    for (const it of list) {
      // 去重：若已有相同页面的待处理任务，保留优先级更高的那个
      const existingIdx = queueRef.current.findIndex(
        t => t.epoch === epoch && t.pageIndex === it.pageIndex
      );
      if (existingIdx >= 0) {
        const existing = queueRef.current[existingIdx];
        if (it.priority < existing.priority) {
          queueRef.current[existingIdx] = {
            ...existing,
            priority: it.priority,
            layout: it.layout,
          };
        }
        continue;
      }

      queueRef.current.push({
        id: `${epoch}_${it.pageIndex}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        epoch,
        addedAt: performance.now(),
        pageIndex: it.pageIndex,
        layout: it.layout,
        priority: it.priority,
      });
    }

    // 推进处理
    processNext();
  }, [processNext]);

  const bumpEpoch = useCallback(() => {
    currentEpochRef.current += 1;
    // 丢弃所有旧 epoch 的任务
    const epoch = currentEpochRef.current;
    queueRef.current = queueRef.current.filter(t => t.epoch === epoch);
  }, []);

  const clear = useCallback(() => {
    queueRef.current = [];
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    enabledRef.current = enabled;
    if (enabled) processNext();
  }, [processNext]);

  // 组件卸载时清空
  useEffect(() => () => { queueRef.current = []; }, []);

  return useMemo(() => ({ enqueue, bumpEpoch, clear, setEnabled }), [enqueue, bumpEpoch, clear, setEnabled]);
} 