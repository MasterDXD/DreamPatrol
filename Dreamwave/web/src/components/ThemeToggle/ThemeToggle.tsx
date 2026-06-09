import { useState, useEffect, useCallback } from 'react';
import styles from './ThemeToggle.module.css';

const THEME_KEY = 'dreamwave_theme';

function getInitialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  // 默认暗色
  return 'dark';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setAnimating(true);
    setTheme(prev => (prev === 'light' ? 'dark' : 'light'));
    setTimeout(() => setAnimating(false), 500);
  }, []);

  const isLight = theme === 'light';

  return (
    <button
      className={`${styles.toggleBtn} ${animating ? styles.animating : ''}`}
      onClick={toggle}
      title={isLight ? '切换暗色模式' : '切换亮色模式'}
      aria-label={isLight ? '切换暗色模式' : '切换亮色模式'}
    >
      <span className={`${styles.icon} ${isLight ? styles.iconSun : styles.iconMoon}`}>
        {isLight ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </span>
      <span className={styles.label}>{isLight ? '亮色' : '暗色'}</span>
    </button>
  );
}
