import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ConfigProvider, theme, App as AntApp } from 'antd';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import DreamManage from './pages/DreamManage';
import UserManage from './pages/UserManage';
import AIConfig from './pages/AIConfig';
import AICallLogs from './pages/AICallLogs';
import SystemSettings from './pages/SystemSettings';
import OperationLogs from './pages/OperationLogs';
import NotFound from './pages/NotFound';
import './admin-theme.css';

function AdminGuard({ children, authed }: { children: React.ReactNode; authed: boolean }) {
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
          <Route index element={<Dashboard />} />
          <Route path="dreams" element={<DreamManage />} />
          <Route path="users" element={<UserManage />} />
          <Route path="ai-config" element={<AIConfig />} />
          <Route path="ai-logs" element={<AICallLogs />} />
          <Route path="settings" element={<SystemSettings />} />
          <Route path="logs" element={<OperationLogs />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      </AntApp>
    </ConfigProvider>
  );
}
