import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../../services/api';
import Toast from '../../components/Toast/Toast';
import { useFireflyParticles } from '../../hooks/useFireflyParticles';
import styles from './LoginPage.module.css';

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const navigate = useNavigate();
  const particleRef = useRef<HTMLDivElement>(null);
  useFireflyParticles(particleRef, { count: 25 });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim()) {
      setError('请输入用户名');
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await api.login(username.trim(), password);
      localStorage.setItem('dreamwave_token', data.token);
      onLogin();
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err.message || '登录失败');
      setToast({ message: err.message || '登录失败', type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.bgImage}>
        <img src="/assets/官网背景图.png" alt="" />
      </div>
      <div className={styles.overlay} />
      <div className={styles.nebula1} />
      <div className={styles.nebula2} />
      <div className={styles.nebula3} />
      <div ref={particleRef} className={styles.particleLayer} />

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.header}>
          <span className={styles.logo}>🌙</span>
          <h1 className={styles.appTitle}>巡梦</h1>
          <p className={styles.subtitle}>进入你的梦境空间</p>
        </div>

        {error && (
          <div className={styles.errorBox}>
            {error}
          </div>
        )}

        <div className={styles.inputGroup}>
          <label htmlFor="username" className={styles.srOnly}>邮箱 / 账号</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="邮箱 / 账号"
            autoComplete="username"
            className={styles.inputField}
          />
        </div>

        <div className={styles.inputGroup}>
          <label htmlFor="password" className={styles.srOnly}>密码</label>
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete="current-password"
            className={styles.inputField}
          />
        </div>

        <div className={styles.inputGroupLast}>
          <button
            type="button"
            className={styles.forgotLink}
            onClick={() => setToast({ message: '忘记密码功能开发中', type: 'info' })}
          >
            忘记密码?
          </button>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className={styles.submitBtn}
        >
          {isSubmitting ? '登录中...' : '登录'}
        </button>

        <p className={styles.footer}>
          还没有记录过梦境？<Link to="/register" className={styles.link}>新用户注册</Link>
        </p>
      </form>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
