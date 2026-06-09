import { useEffect } from 'react';

interface FireflyOptions {
  count?: number;
  className?: string;
  /** 是否在容器元素不可见时暂停创建（默认 false：保持简单） */
  pauseWhenHidden?: boolean;
}

/**
 * 在指定容器内生成「萤火虫」粒子动画。
 * - 监听 prefers-reduced-motion，自动跳过生成
 * - 组件卸载 / 路由切换时会清理已生成的 DOM 节点
 * - 容器为空时静默 return，不抛错
 */
export function useFireflyParticles(
  containerRef: React.RefObject<HTMLElement | null>,
  options: FireflyOptions = {},
) {
  const { count = 20, className } = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (prefersReducedMotion) return;

    const created: HTMLDivElement[] = [];
    for (let i = 0; i < count; i++) {
      const particle = document.createElement('div');
      if (className) particle.className = className;

      const size = Math.random() * 3 + 1;
      const duration = Math.random() * 10 + 10;
      const delay = Math.random() * 5;
      const opacity = Math.random() * 0.5 + 0.2;

      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.left = `${Math.random() * 100}vw`;
      particle.style.top = `${Math.random() * 100}vh`;
      particle.style.boxShadow = `0 0 ${size * 2}px ${size}px rgba(76, 215, 246, 0.6)`;
      particle.style.willChange = 'transform, opacity';

      const animation = particle.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 0 },
          {
            transform: `translate(${(Math.random() - 0.5) * 100}px, ${
              (Math.random() - 0.5) * 100
            }px) scale(1.5)`,
            opacity,
            offset: 0.5,
          },
          {
            transform: `translate(${(Math.random() - 0.5) * 200}px, ${
              (Math.random() - 0.5) * 200
            }px) scale(1)`,
            opacity: 0,
          },
        ],
        {
          duration: duration * 1000,
          delay: delay * 1000,
          iterations: Infinity,
          easing: 'ease-in-out',
        },
      );

      container.appendChild(particle);
      created.push(particle);
      // 防止动画对象在某些严格 GC 策略下被回收
      void animation;
    }

    return () => {
      for (const node of created) {
        node.getAnimations().forEach((a) => a.cancel());
        node.remove();
      }
    };
  }, [containerRef, count, className]);
}
