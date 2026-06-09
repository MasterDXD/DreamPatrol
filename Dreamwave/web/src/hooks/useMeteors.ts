import { useEffect } from 'react';

interface MeteorOptions {
  /** 同时存在的最大流星数（默认 6） */
  count?: number;
  /** 流星容器 CSS 类名 */
  className?: string;
}

/**
 * 在指定容器内生成「流星雨」动画。
 * - 流星从右上方斜向左下方划过，带有渐变拖尾
 * - 每颗流星随机大小、速度、起始位置、间隔
 * - 监听 prefers-reduced-motion，自动跳过
 * - 组件卸载时清理所有 DOM 与动画
 */
export function useMeteors(
  containerRef: React.RefObject<HTMLElement | null>,
  options: MeteorOptions = {},
) {
  const { count = 6, className } = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (prefersReducedMotion) return;

    const created: HTMLDivElement[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];

    function spawnMeteor() {
      const meteor = document.createElement('div');
      if (className) meteor.className = className;

      // 随机参数
      const length = Math.random() * 80 + 60; // 拖尾长度 60~140px
      const thickness = Math.random() * 1.5 + 0.5; // 粗细 0.5~2px
      const duration = Math.random() * 800 + 600; // 飞行时长 600~1400ms
      const startX = Math.random() * 80 + 20; // 起始 x：20~100vw
      const startY = Math.random() * 30; // 起始 y：0~30vh
      const travelX = -(Math.random() * 200 + 150); // 向左飞 150~350px
      const travelY = Math.random() * 200 + 150; // 向下飞 150~350px

      meteor.style.cssText = `
        position: absolute;
        left: ${startX}vw;
        top: ${startY}vh;
        width: ${length}px;
        height: ${thickness}px;
        border-radius: 9999px;
        background: linear-gradient(
          90deg,
          rgba(255, 255, 255, 0) 0%,
          rgba(200, 220, 255, 0.6) 40%,
          rgba(255, 255, 255, 0.95) 100%
        );
        transform: rotate(${Math.atan2(travelY, travelX) * (180 / Math.PI)}deg);
        transform-origin: right center;
        pointer-events: none;
        will-change: transform, opacity;
        opacity: 0;
      `;

      const animation = meteor.animate(
        [
          { opacity: 0, transform: meteor.style.transform + ' translateX(0)' },
          {
            opacity: 1,
            transform: meteor.style.transform + ` translateX(${travelX * 0.3}px)`,
            offset: 0.1,
          },
          {
            opacity: 0.8,
            transform: meteor.style.transform + ` translateX(${travelX * 0.8}px)`,
            offset: 0.7,
          },
          {
            opacity: 0,
            transform: meteor.style.transform + ` translateX(${travelX}px)`,
          },
        ],
        {
          duration,
          easing: 'linear',
          fill: 'forwards',
        },
      );

      container?.appendChild(meteor);
      created.push(meteor);

      animation.onfinish = () => {
        meteor.remove();
        const idx = created.indexOf(meteor);
        if (idx !== -1) created.splice(idx, 1);
      };
      void animation;
    }

    // 初始错开生成
    for (let i = 0; i < count; i++) {
      const delay = Math.random() * 3000;
      const timer = setTimeout(spawnMeteor, delay);
      timers.push(timer);
    }

    // 持续循环生成
    function scheduleNext() {
      const interval = Math.random() * 2500 + 800; // 0.8~3.3s 一颗
      const timer = setTimeout(() => {
        spawnMeteor();
        scheduleNext();
      }, interval);
      timers.push(timer);
    }
    // 每条轨道独立调度
    for (let i = 0; i < count; i++) {
      scheduleNext();
    }

    return () => {
      for (const t of timers) clearTimeout(t);
      for (const node of created) {
        node.getAnimations().forEach((a) => a.cancel());
        node.remove();
      }
    };
  }, [containerRef, count, className]);
}
