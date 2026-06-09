import { useEffect, useRef } from 'react';

interface StarTrailOptions {
  /** 拖尾粒子数量上限 */
  maxParticles?: number;
  /** 粒子存活时长 ms */
  lifetime?: number;
  /** 生成间隔 ms */
  interval?: number;
}

/**
 * 星光鼠标拖尾效果：鼠标移动时在光标位置生成闪烁星光粒子，
 * 粒子逐渐缩小、上浮并淡出。
 * - 自动检测 prefers-reduced-motion，禁用时跳过
 * - 组件卸载时清理所有 DOM 和定时器
 */
export function useStarTrail(options: StarTrailOptions = {}) {
  const { maxParticles = 50, lifetime = 800, interval = 40 } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const particlesRef = useRef<HTMLDivElement[]>([]);
  const lastTimeRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (prefersReducedMotion) return;

    // 创建全局容器
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '9999',
      overflow: 'hidden',
    } as CSSStyleDeclaration);
    document.body.appendChild(container);
    containerRef.current = container;

    const colors = [
      'rgba(76, 215, 246, 0.95)',   // 主题青色 --color-accent
      'rgba(76, 215, 246, 0.7)',    // 青色半透明
      'rgba(87, 27, 193, 0.85)',    // 主题紫色 --shadow-glow
      'rgba(87, 27, 193, 0.6)',     // 紫色半透明
      'rgba(190, 198, 224, 0.9)',   // 银白 --color-primary
      'rgba(208, 112, 224, 0.8)',   // 粉紫
      'rgba(172, 237, 255, 0.85)',  // 浅青 --color-accent-light
      'rgba(255, 255, 255, 0.9)',   // 纯白高光
    ];

    const shapes = ['circle', 'diamond', 'star', 'spark'] as const;

    function createParticle(x: number, y: number) {
      if (particlesRef.current.length >= maxParticles) return;

      const el = document.createElement('div');
      const color = colors[Math.floor(Math.random() * colors.length)];
      const shape = shapes[Math.floor(Math.random() * shapes.length)];
      const size = Math.random() * 10 + 4;
      const offsetX = (Math.random() - 0.5) * 20;
      const offsetY = (Math.random() - 0.5) * 20;
      const driftX = (Math.random() - 0.5) * 40;
      const driftY = -(Math.random() * 50 + 15);
      const rotation = Math.random() * 360;
      const rotationSpeed = (Math.random() - 0.5) * 240;

      Object.assign(el.style, {
        position: 'absolute',
        left: `${x + offsetX}px`,
        top: `${y + offsetY}px`,
        width: `${size}px`,
        height: `${size}px`,
        pointerEvents: 'none',
        willChange: 'transform, opacity',
      } as CSSStyleDeclaration);

      if (shape === 'circle') {
        el.style.borderRadius = '50%';
        el.style.background = `radial-gradient(circle, ${color} 0%, transparent 70%)`;
        el.style.boxShadow = `0 0 ${size * 3}px ${size * 1.5}px ${color}`;
      } else if (shape === 'diamond') {
        el.style.borderRadius = '3px';
        el.style.background = color;
        el.style.boxShadow = `0 0 ${size * 2}px ${size * 0.8}px ${color}`;
        el.style.transform = `rotate(45deg)`;
      } else if (shape === 'star') {
        el.style.borderRadius = '50%';
        el.style.background = 'transparent';
        el.style.boxShadow = `0 0 ${size * 2}px ${size * 0.6}px ${color}, inset 0 0 ${size * 1.5}px ${size * 0.4}px ${color}`;
      } else {
        // spark: 细长十字光芒
        el.style.borderRadius = '50%';
        el.style.background = color;
        el.style.boxShadow = `0 0 ${size * 4}px ${size}px ${color}`;
        el.style.width = `${size * 0.4}px`;
        el.style.height = `${size * 2}px`;
      }

      container.appendChild(el);
      particlesRef.current.push(el);

      const anim = el.animate(
        [
          {
            transform: `translate(0, 0) rotate(${rotation}deg) scale(1)`,
            opacity: 1,
          },
          {
            transform: `translate(${driftX * 0.5}px, ${driftY * 0.5}px) rotate(${rotation + rotationSpeed * 0.5}deg) scale(0.8)`,
            opacity: 0.8,
            offset: 0.4,
          },
          {
            transform: `translate(${driftX}px, ${driftY}px) rotate(${rotation + rotationSpeed}deg) scale(0)`,
            opacity: 0,
          },
        ],
        {
          duration: lifetime,
          easing: 'ease-out',
          fill: 'forwards',
        },
      );

      anim.onfinish = () => {
        el.remove();
        const idx = particlesRef.current.indexOf(el);
        if (idx !== -1) particlesRef.current.splice(idx, 1);
      };
    }

    function onMouseMove(e: MouseEvent) {
      const now = performance.now();
      if (now - lastTimeRef.current < interval) return;
      lastTimeRef.current = now;
      createParticle(e.clientX, e.clientY);
    }

    function onTouchMove(e: TouchEvent) {
      const now = performance.now();
      if (now - lastTimeRef.current < interval) return;
      lastTimeRef.current = now;
      const touch = e.touches[0];
      if (touch) createParticle(touch.clientX, touch.clientY);
    }

    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('touchmove', onTouchMove);
      cancelAnimationFrame(rafRef.current);
      for (const p of particlesRef.current) {
        p.getAnimations().forEach((a) => a.cancel());
        p.remove();
      }
      particlesRef.current = [];
      container.remove();
      containerRef.current = null;
    };
  }, [maxParticles, lifetime, interval]);
}
