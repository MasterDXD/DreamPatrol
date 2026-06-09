import { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  DashboardOutlined,
  FileTextOutlined,
  UserOutlined,
  SettingOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  RobotOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import styles from './Layout.module.css';

interface LayoutProps {
  onLogout: () => void;
}

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '数据概览', path: '/' },
  { key: '/dreams', icon: <FileTextOutlined />, label: '梦境管理', path: '/dreams' },
  { key: '/users', icon: <UserOutlined />, label: '用户管理', path: '/users' },
  { key: '/ai-config', icon: <RobotOutlined />, label: 'AI配置', path: '/ai-config' },
  { key: '/ai-logs', icon: <HistoryOutlined />, label: 'AI调用记录', path: '/ai-logs' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置', path: '/settings' },
  { key: '/logs', icon: <FileSearchOutlined />, label: '操作日志', path: '/logs' },
];

const COLLAPSE_KEY = 'dreamwave_admin_sidebar_collapsed';

export default function Layout({ onLogout }: LayoutProps) {
  const location = useLocation();
  const selectedKey = location.pathname === '/' ? '/' : location.pathname;

  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  });

  const [isTransitioning, setIsTransitioning] = useState(false);
  const [previousPath, setPreviousPath] = useState(location.pathname);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    if (location.pathname !== previousPath) {
      setIsTransitioning(true);
      const timer = setTimeout(() => {
        setIsTransitioning(false);
        setPreviousPath(location.pathname);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [location.pathname, previousPath]);

  const toggleCollapse = () => setCollapsed(prev => !prev);

  return (
    <div className={styles.layout}>
      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
        <div className={styles.sidebarTop}>
          {/* Logo */}
          <div className={styles.logoSection}>
            <img
              src="/assets/logo.jpg"
              alt="巡梦 XUNMENG"
              className={styles.logoImg}
            />
          </div>

          {/* Navigation */}
          <nav className={styles.nav}>
            {menuItems.map((item) => {
              const isActive = selectedKey === item.key;
              return (
                <Link
                  key={item.key}
                  to={item.path}
                  className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
                  title={collapsed ? item.label : undefined}
                >
                  <span className={`${styles.navIcon} ${isActive ? styles.navIconActive : ''}`}>
                    {item.icon}
                  </span>
                  <span className={styles.navLabel}>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom: Collapse + Logout */}
        <div className={styles.sidebarBottom}>
          <button className={styles.collapseBtn} onClick={toggleCollapse} title={collapsed ? '展开菜单' : '收起菜单'}>
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            {!collapsed && <span className={styles.navLabel}>收起菜单</span>}
          </button>
          <button
            className={styles.logoutBtn}
            onClick={() => { localStorage.removeItem('dreamwave_admin_token'); onLogout(); }}
          >
            <LogoutOutlined />
            <span className={styles.navLabel}>退出登录</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className={styles.main}>
        <div className={`${styles.mainInner} ${isTransitioning ? styles.contentTransitioning : ''}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
