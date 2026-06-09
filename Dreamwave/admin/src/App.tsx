import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import { ConfigProvider, theme, App as AntApp, Spin } from 'antd';
import Layout from './components/Layout';
import Login from './pages/Login';
import './admin-theme.css';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const DreamManage = lazy(() => import('./pages/DreamManage'));
const UserManage = lazy(() => import('./pages/UserManage'));
const AIConfig = lazy(() => import('./pages/AIConfig'));
const AICallLogs = lazy(() => import('./pages/AICallLogs'));
const SystemSettings = lazy(() => import('./pages/SystemSettings'));
const OperationLogs = lazy(() => import('./pages/OperationLogs'));
const NotFound = lazy(() => import('./pages/NotFound'));

function AdminGuard({ children, authed }: { children: React.ReactNode; authed: boolean }) {
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PageLoading() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '200px',
    }}>
      <Spin size="large" tip="加载中..." style={{ color: '#a78bfa' }} />
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('dreamwave_admin_token'));
  const navigate = useNavigate();

  useEffect(() => {
    const handleUnauthorized = () => {
      localStorage.removeItem('dreamwave_admin_token');
      setAuthed(false);
      navigate('/login');
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [navigate]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#a78bfa',
          colorBgContainer: 'rgba(25, 30, 60, 0.6)',
          colorBgElevated: 'rgba(25, 30, 60, 0.95)',
          colorBorder: 'rgba(255,255,255,0.1)',
          colorText: '#d4e4fa',
          colorTextSecondary: '#c6c6cd',
          colorTextPlaceholder: '#909097',
          borderRadius: 12,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        },
      }}
    >
      <AntApp>
      <Routes>
        <Route path="/login" element={<Login onLogin={() => setAuthed(true)} />} />
        <Route path="/" element={<AdminGuard authed={authed}><Layout onLogout={() => setAuthed(false)} /></AdminGuard>}>
          <Route index element={<Suspense fallback={<PageLoading />}><Dashboard /></Suspense>} />
          <Route path="dreams" element={<Suspense fallback={<PageLoading />}><DreamManage /></Suspense>} />
          <Route path="users" element={<Suspense fallback={<PageLoading />}><UserManage /></Suspense>} />
          <Route path="ai-config" element={<Suspense fallback={<PageLoading />}><AIConfig /></Suspense>} />
          <Route path="ai-logs" element={<Suspense fallback={<PageLoading />}><AICallLogs /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<PageLoading />}><SystemSettings /></Suspense>} />
          <Route path="logs" element={<Suspense fallback={<PageLoading />}><OperationLogs /></Suspense>} />
          <Route path="*" element={<Suspense fallback={<PageLoading />}><NotFound /></Suspense>} />
        </Route>
        <Route path="*" element={<Suspense fallback={<PageLoading />}><NotFound /></Suspense>} />
      </Routes>
      </AntApp>
    </ConfigProvider>
  );
}
