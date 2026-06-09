import { useRef, useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFireflyParticles } from '../../hooks/useFireflyParticles';
import { useMeteors } from '../../hooks/useMeteors';
import AmbientMusic from '../../components/AmbientMusic/AmbientMusic';
import styles from './WelcomePage.module.css';

/** 梦境背景图列表 — 每种情绪选一张，营造不同梦境氛围 */
const DREAM_BG_IMAGES = [
  { src: '/assets/images/月明风清.png', label: '月明风清' },
  { src: '/assets/images/海上明月.png', label: '海上明月' },
  { src: '/assets/images/孔明灯.png', label: '孔明灯' },
  { src: '/assets/images/梦幻森林.png', label: '梦幻森林' },
  { src: '/assets/images/森林.png', label: '森林' },
  { src: '/assets/images/星云.png', label: '星云' },
];

/** 背景图轮换间隔（毫秒） */
const BG_ROTATE_INTERVAL = 8000;

const FALLBACK_BG_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'>
      <defs>
        <radialGradient id='m' cx='50%' cy='35%' r='60%'>
          <stop offset='0%' stop-color='%235713c1' stop-opacity='0.55'/>
          <stop offset='100%' stop-color='%23051424' stop-opacity='0'/>
        </radialGradient>
      </defs>
      <rect width='1200' height='800' fill='%23051424'/>
      <circle cx='600' cy='280' r='170' fill='url(%23m)'/>
      <circle cx='600' cy='280' r='70' fill='%23f0eedd' opacity='0.85'/>
    </svg>`,
  );

/** 最大等待时间：3 秒后无论资源是否就绪都显示页面 */
const READY_TIMEOUT_MS = 3000;

export default function WelcomePage() {
  const navigate = useNavigate();
  const particleLayerRef = useRef<HTMLDivElement>(null);
  const meteorLayerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ripples, setRipples] = useState<{ x: number; y: number; id: number }[]>([]);

  // 背景轮换
  const [bgIndex, setBgIndex] = useState(0);
  const [bgTransition, setBgTransition] = useState(false);

  const markReady = useCallback(() => {
    setReady((prev) => {
      if (prev) return prev;
      return true;
    });
  }, []);

  // 超时兜底：3 秒后强制显示
  useEffect(() => {
    const timer = setTimeout(markReady, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [markReady]);

  // 等待字体加载完毕后再显示页面，避免图标字体未加载时闪现英文文本
  useEffect(() => {
    document.fonts.ready.then(markReady);
  }, [markReady]);

  // 背景图自动轮换
  useEffect(() => {
    const timer = setInterval(() => {
      setBgTransition(true);
      setTimeout(() => {
        setBgIndex((prev) => (prev + 1) % DREAM_BG_IMAGES.length);
        setBgTransition(false);
      }, 800);
    }, BG_ROTATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 背景图加载完成时触发
  const handleBgLoaded = useCallback(() => {
    markReady();
  }, [markReady]);

  useFireflyParticles(particleLayerRef, { count: 20, className: styles.particle });
  useMeteors(meteorLayerRef, { count: 6 });

  const go = (path: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    // 模拟短暂加载动画后跳转
    setTimeout(() => {
      navigate(path);
    }, 800);
  };

  // 涟漪点击效果
  const handleRipple = (e: React.MouseEvent<HTMLButtonElement>) => {
    const button = e.currentTarget;
    const rect = button.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = Date.now();
    setRipples((prev) => [...prev, { x, y, id }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 700);
  };

  const currentBg = DREAM_BG_IMAGES[bgIndex];

  return (
    <div className={`${styles.page} ${ready ? styles.ready : ''}`}>
      {/* 背景图 + 渐变蒙层 */}
      <div className={styles.bgImage} aria-hidden="true">
        <img
          src={currentBg.src}
          className={`${styles.bgImg} ${bgTransition ? styles.bgFadeOut : ''}`}
          decoding="async"
          loading="eager"
          onLoad={handleBgLoaded}
          onError={(e) => {
            const img = e.currentTarget;
            if (img.src !== FALLBACK_BG_URL) {
              img.src = FALLBACK_BG_URL;
            } else {
              handleBgLoaded();
            }
          }}
          alt=""
        />
      </div>

      {/* 图片标题标签 */}
      <div className={styles.bgLabel} aria-hidden="true">
        <span className={`${styles.bgLabelText} ${bgTransition ? styles.bgLabelFadeOut : ''}`}>
          {currentBg.label}
        </span>
      </div>

      {/* 图片指示器 */}
      <div className={styles.bgIndicators} aria-label="背景图切换">
        {DREAM_BG_IMAGES.map((img, i) => (
          <button
            key={img.src}
            className={`${styles.bgIndicator} ${i === bgIndex ? styles.bgIndicatorActive : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (i === bgIndex) return;
              setBgTransition(true);
              setTimeout(() => {
                setBgIndex(i);
                setBgTransition(false);
              }, 800);
            }}
            title={img.label}
            aria-label={`切换至${img.label}`}
          />
        ))}
      </div>

      {/* 大气星云 */}
      <div className={styles.nebulaLayer} aria-hidden="true">
        <div className={styles.nebula1} />
        <div className={styles.nebula2} />
      </div>

      {/* 粒子层 */}
      <div
        ref={particleLayerRef}
        className={styles.particleLayer}
        aria-hidden="true"
      />

      {/* 流星层 */}
      <div
        ref={meteorLayerRef}
        className={styles.meteorLayer}
        aria-hidden="true"
      />

      {/* 音乐控制 */}
      <AmbientMusic />

      {/* 主体 */}
      <main className={styles.main}>
        {/* 顶部品牌 */}
        <div className={styles.brand}>
          <span
            className={`material-symbols-outlined ${styles.brandIcon}`}
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden="true"
          >
            waves
          </span>
          <span className={styles.brandText}>梦境织者</span>
        </div>

        {/* 标题区 */}
        <div className={styles.hero}>
          <h1 className={styles.title}>巡梦</h1>
          <p className={styles.subtitle}>
            潜入潜意识的深海，记录并探索那些在星空下绽放的隐秘思绪。
          </p>
        </div>

        {/* 行动按钮 */}
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.primaryBtn} ${loading ? styles.primaryBtnLoading : ''}`}
            onClick={(e) => { handleRipple(e); go('/register')(e); }}
            disabled={loading}
            aria-busy={loading}
          >
            <span className={styles.primaryBtnLabel}>
              {loading ? '正在唤醒梦境…' : '开始旅程'}
            </span>
            {loading ? (
              <span className={styles.primaryBtnSpinner} aria-hidden="true">
                <span className={styles.spinnerRing} />
              </span>
            ) : (
              <span
                className={`material-symbols-outlined ${styles.primaryBtnIcon}`}
                style={{ fontVariationSettings: "'FILL' 0" }}
                aria-hidden="true"
              >
                arrow_right_alt
              </span>
            )}
            <span className={styles.primaryBtnProgress} />
            {ripples.map((r) => (
              <span
                key={r.id}
                className={styles.primaryBtnRipple}
                style={{ left: r.x, top: r.y }}
                aria-hidden="true"
              />
            ))}
            <span className={styles.primaryBtnHover} />
          </button>

          <a className={styles.secondaryLink} href="/login" onClick={go('/login')}>
            已有账号？点击登录
          </a>
        </div>

        {/* 底部 */}
        <p className={styles.footer}>探索自我 · 拥抱宁静</p>
      </main>
    </div>
  );
}
