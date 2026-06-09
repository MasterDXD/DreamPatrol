import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect, ReactNode, useCallback, Suspense, lazy } from 'react';
import { api, AuthExpiredError, isTokenValid } from './services/api';
import { useStarTrail } from './hooks/useStarTrail';
import Layout from './components/Layout/Layout';

// 路由懒加载
const WelcomePage = lazy(() => import('./pages/WelcomePage/WelcomePage'));
const HomePage = lazy(() => import('./pages/HomePage/HomePage'));
const NewDreamPage = lazy(() => import('./pages/NewDreamPage/NewDreamPage'));
const DreamDetailPage = lazy(() => import('./pages/DreamDetailPage/DreamDetailPage'));
const CalendarPage = lazy(() => import('./pages/CalendarPage/CalendarPage'));
const StatsPage = lazy(() => import('./pages/StatsPage/StatsPage'));
const EditDreamPage = lazy(() => import('./pages/EditDreamPage/EditDreamPage'));
const DreamPlazaPage = lazy(() => import('./pages/DreamPlazaPage/DreamPlazaPage'));
const DreamRoamingPage = lazy(() => import('./pages/DreamRoamingPage/DreamRoamingPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage/SettingsPage'));
const LoginPage = lazy(() => import('./pages/LoginPage/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage/RegisterPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage/NotFoundPage'));

function AuthGuard({ children, authed }: { children: ReactNode; authed: boolean }) {
  if (!authed) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function GuestGuard({ children, authed }: { children: ReactNode; authed: boolean }) {
  if (authed) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/* 全局401错误处理：捕获AuthExpiredError后用React Router导航到/login */
function AuthErrorBoundary({ children, onAuthExpired }: { children: ReactNode; onAuthExpired: () => void }) {
  useEffect(() => {
    const handler = (event: ErrorEvent) => {
      if (event.error instanceof AuthExpiredError) {
        event.preventDefault();
        onAuthExpired();
      }
    };
    window.addEventListener('error', handler);
    return () => window.removeEventListener('error', handler);
  }, [onAuthExpired]);

  // 拦截未捕获的Promise rejection（仅处理AuthExpiredError，其他错误正常传播）
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof AuthExpiredError) {
        event.preventDefault();
        onAuthExpired();
      }
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, [onAuthExpired]);

  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();
  const [authed, setAuthed] = useState(isTokenValid);
  useStarTrail({ maxParticles: 50, lifetime: 800, interval: 40 });

  const handleAuthExpired = useCallback(() => {
    setAuthed(false);
    navigate('/login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (authed) {
      api.getMe().catch((err) => {
        if (err instanceof AuthExpiredError) {
          handleAuthExpired();
        }
        // 其他错误（网络错误等）不强制登出
      });
    }
  }, [authed, handleAuthExpired]);

  return (
    <AuthErrorBoundary onAuthExpired={handleAuthExpired}>
      <Suspense fallback={
        <div className="page-loading">
          <div className="page-loading-content">
            <div className="page-loading-spinner"></div>
            <span className="page-loading-text">进入梦境中...</span>
          </div>
        </div>
      }>
        <Routes>
          <Route path="/welcome" element={<GuestGuard authed={authed}><div className="page-enter"><WelcomePage /></div></GuestGuard>} />
          <Route path="/login" element={<GuestGuard authed={authed}><div className="page-enter"><LoginPage onLogin={() => setAuthed(true)} /></div></GuestGuard>} />
          <Route path="/register" element={<GuestGuard authed={authed}><div className="page-enter"><RegisterPage onRegister={() => setAuthed(true)} /></div></GuestGuard>} />
          <Route path="/" element={<AuthGuard authed={authed}><Layout onLogout={() => setAuthed(false)} /></AuthGuard>}>
            <Route index element={<div className="page-enter"><HomePage /></div>} />
            <Route path="dreams" element={<div className="page-enter"><HomePage /></div>} />
            <Route path="new" element={<div className="page-enter"><NewDreamPage /></div>} />
            <Route path="dream/:id" element={<div className="page-enter"><DreamDetailPage /></div>} />
            <Route path="dream/:id/edit" element={<div className="page-enter"><EditDreamPage /></div>} />
            <Route path="dream/:id/roaming" element={<DreamRoamingPage />} />
            <Route path="plaza" element={<div className="page-enter"><DreamPlazaPage /></div>} />
            <Route path="calendar" element={<div className="page-enter"><CalendarPage /></div>} />
            <Route path="stats" element={<div className="page-enter"><StatsPage /></div>} />
            <Route path="settings" element={<div className="page-enter"><SettingsPage /></div>} />
          </Route>
          <Route path="*" element={<div className="page-enter"><NotFoundPage /></div>} />
        </Routes>
      </Suspense>
    </AuthErrorBoundary>
  );
}
