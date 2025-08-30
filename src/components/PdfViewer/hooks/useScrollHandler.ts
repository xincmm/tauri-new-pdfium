import { SCROLL_DEBOUNCE_MS, SLOW_SPEED_THRESHOLD } from "@/PdfViewer/config";
import { useCallback, useRef, useState } from "react";

interface ScrollState {
  scrollY: number;
  scrollX: number;
  isScrollIdle: boolean;
  scrollSpeedPxPerMs: number;
  scrollDirection: -1 | 0 | 1;
}

interface UseScrollHandlerOptions {
  onScrollChange?: (state: ScrollState) => void;
  onInteractionDetected?: () => void;
}

export const useScrollHandler = (options: UseScrollHandlerOptions = {}) => {
  const [scrollState, setScrollState] = useState<ScrollState>({
    scrollY: 0,
    scrollX: 0,
    isScrollIdle: true,
    scrollSpeedPxPerMs: 0,
    scrollDirection: 0,
  });

  const idleTimerRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const velocityEmaRef = useRef<number>(0);
  const lastScrollYRef = useRef<number>(0);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      if (!target) return;

      options.onInteractionDetected?.();

      // 记录上一次滚动位置
      const prevY = scrollState.scrollY;
      lastScrollYRef.current = prevY;

      // 计算滚动速度和方向
      const now = performance.now();
      let newSpeed = scrollState.scrollSpeedPxPerMs;
      let newDirection = scrollState.scrollDirection;

      if (lastTsRef.current !== null) {
        const dtMs = Math.max(0.1, now - lastTsRef.current);
        const dy = target.scrollTop - prevY;
        const instV = Math.abs(dy) / dtMs; // px/ms
        const alpha = 0.3; // EMA平滑系数
        const ema = alpha * instV + (1 - alpha) * velocityEmaRef.current;
        velocityEmaRef.current = ema;
        newSpeed = ema;
        newDirection = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      }
      lastTsRef.current = now;

      const newState: ScrollState = {
        scrollY: target.scrollTop,
        scrollX: target.scrollLeft,
        isScrollIdle: false,
        scrollSpeedPxPerMs: newSpeed,
        scrollDirection: newDirection,
      };

      setScrollState(newState);
      options.onScrollChange?.(newState);

      // 设置空闲计时器
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        const idleState = { ...newState, isScrollIdle: true };
        setScrollState(idleState);
        options.onScrollChange?.(idleState);
      }, SCROLL_DEBOUNCE_MS);
    },
    [scrollState.scrollY, scrollState.scrollSpeedPxPerMs, scrollState.scrollDirection, options],
  );

  // 根据速度计算动态预加载窗口大小
  const getDynamicPreloadAhead = useCallback((speedPxPerMs: number) => {
    if (speedPxPerMs < 0.05) return 2; // 非常慢
    if (speedPxPerMs < 0.15) return 4; // 慢速
    if (speedPxPerMs < 0.3) return 6; // 中速
    if (speedPxPerMs < 0.6) return 8; // 略快
    return 10; // 快速/拖动
  }, []);

  // 判断是否为慢速滚动
  const isSlowScrolling = useCallback(() => {
    return scrollState.scrollSpeedPxPerMs < SLOW_SPEED_THRESHOLD;
  }, [scrollState.scrollSpeedPxPerMs]);

  return {
    scrollState,
    lastScrollYRef,
    handleScroll,
    getDynamicPreloadAhead,
    isSlowScrolling,
  };
};
