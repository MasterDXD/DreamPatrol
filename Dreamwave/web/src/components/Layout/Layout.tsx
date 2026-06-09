import { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import ThemeToggle from '../ThemeToggle/ThemeToggle';
import WhiteNoise from '../WhiteNoise/WhiteNoise';
import AmbientMusic, { isAmbientMusicVisible } from '../AmbientMusic/AmbientMusic';
import styles from './Layout.module.css';

interface LayoutProps {
  onLogout: () => void;
}

const NAV_ITEMS = [
  { path: '/', icon: 'fa-solid fa-house', label: '首页' },
  { path: '/dreams', icon: 'fa-solid fa-cloud-moon', label: '我的梦境' },
  { path: '/stats', icon: 'fa-solid fa-star', label: '情绪星图' },
  { path: '/calendar', icon: 'fa-regular fa-calendar', label: '梦境日历' },
  { path: '/settings', icon: 'fa-solid fa-gear', label: '设置' },
];

const MOBILE_NAV = [
  { path: '/', icon: 'fa-solid fa-house', label: '首页' },
  { path: '/dreams', icon: 'fa-solid fa-cloud-moon', label: '梦境' },
  { path: '/calendar', icon: 'fa-regular fa-calendar', label: '日历' },
  { path: '/settings', icon: 'fa-solid fa-user', label: '我的' },
];

const COLLAPSE_KEY = 'dreamwave_sidebar_collapsed';

export default function Layout({ onLogout }: LayoutProps) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  });
  const [showMusic, setShowMusic] = useState(isAmbientMusicVisible);

  // 监听设置变更事件
  useEffect(() => {
    const handler = () => setShowMusic(isAmbientMusicVisible());
    window.addEventListener('ambient-music-visibility-change', handler);
    return () => window.removeEventListener('ambient-music-visibility-change', handler);
  }, []);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  const handleLogout = () => {
    localStorage.removeItem('dreamwave_token');
    onLogout();
  };

  const toggleCollapse = () => setCollapsed(prev => !prev);

  const isActive = (path: string) => {
    if (path === '/' || path === '/dreams') return location.pathname === '/' || location.pathname === '/dreams';
    return location.pathname.startsWith(path);
  };

  return (
    <div className={styles.layout}>
      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
        <div className={styles.sidebarTop}>
          {/* Logo */}
          <div className={styles.logoSection}>
            <h1 className={styles.logoTitle}>巡梦</h1>
            {!collapsed && <p className={styles.logoSub}>Dream Rover</p>}
          </div>

          {/* Navigation */}
          <nav className={styles.nav}>
            {NAV_ITEMS.map(item => (
              <Link
                key={item.path}
                to={item.path}
                className={`${styles.navItem} ${isActive(item.path) ? styles.navItemActive : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <i className={`${item.icon} ${styles.navIcon}`}></i>
                <span className={styles.navLabel}>{item.label}</span>
              </Link>
            ))}
          </nav>
        </div>

        {/* Bottom: User Profile + Theme + Logout */}
        <div className={styles.sidebarBottom}>
          <div className={styles.userProfile}>
            <img
              className={styles.userAvatar}
              src="/assets/images/avatar-default.png"
              alt="用户头像"
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.src.includes('ui-avatars')) {
                  img.src = 'https://ui-avatars.com/api/?name=Dreamer&background=7c3aed&color=fff&size=80';
                }
              }}
            />
            <div className={styles.userInfo}>
              <div className={styles.userGreeting}>
                <span>晚安</span>
                <i className="fa-solid fa-moon"></i>
              </div>
              <span className={styles.userDreamCount}>梦境探索者</span>
            </div>
          </div>
          <div className={styles.themeRow}>
            <ThemeToggle />
          </div>
          <button className={styles.logoutBtn} onClick={handleLogout} title="退出登录">
            <i className="fa-solid fa-right-from-bracket"></i>
            <span className={styles.navLabel}>退出</span>
          </button>
        </div>

        {/* 折叠按钮：固定在侧边栏右边中间 */}
        <button
          className={styles.collapseBtn}
          onClick={toggleCollapse}
          title={collapsed ? '展开菜单' : '收起菜单'}
        >
          <i className={`fa-solid ${collapsed ? 'fa-angles-right' : 'fa-angles-left'} ${styles.collapseIcon}`}></i>
          <span className={styles.collapseLabel}>收起菜单</span>
        </button>
      </aside>

      {/* Main Content */}
      <main className={styles.main}>
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      <nav className={styles.mobileNav}>
        {MOBILE_NAV.slice(0, 2).map(item => (
          <Link
            key={item.path}
            to={item.path}
            className={`${styles.mobileNavItem} ${isActive(item.path) ? styles.mobileNavItemActive : ''}`}
          >
            <i className={item.icon}></i>
            <span>{item.label}</span>
          </Link>
        ))}

        {/* Center FAB */}
        <Link to="/new" className={styles.mobileFab}>
          <i className="fa-solid fa-plus"></i>
        </Link>

        {MOBILE_NAV.slice(2).map(item => (
          <Link
            key={item.path}
            to={item.path}
            className={`${styles.mobileNavItem} ${isActive(item.path) ? styles.mobileNavItemActive : ''}`}
          >
            <i className={item.icon}></i>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* 白噪音控制面板 */}
      <WhiteNoise />

      {/* 氛围音乐 */}
      {showMusic && <AmbientMusic />}
    </div>
  );
}
