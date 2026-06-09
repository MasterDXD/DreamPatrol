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

      <div className={styles.form}>
        {/* Header */}
        <div className={styles.header}>
          <h1 className={styles.appTitle}>开启巡梦之旅</h1>
          <p className={styles.subtitle}>潜入潜意识的深海，留住那些转瞬即逝的微光。</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className={styles.loginForm}>
          {error && (
            <div className={styles.errorBox}>
              {error}
            </div>
          )}

          {/* Username Input */}
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="username">邮箱 / 账号</label>
            <div className={styles.inputWell}>
              <span className={`material-symbols-outlined ${styles.inputIcon}`}>mail</span>
              <input
                id="username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="输入您的邮箱"
                autoComplete="username"
                className={styles.inputField}
              />
            </div>
          </div>

          {/* Password Input */}
          <div className={styles.fieldGroup}>
            <div className={styles.labelRow}>
              <label className={styles.label} htmlFor="password">密码</label>
              <a className={styles.forgotLink} href="#">忘记密码?</a>
            </div>
            <div className={styles.inputWell}>
              <span className={`material-symbols-outlined ${styles.inputIcon}`}>lock</span>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="输入密码"
                autoComplete="current-password"
                className={styles.inputField}
              />
              <button
                type="button"
                className={styles.togglePassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                <span className="material-symbols-outlined">
                  {showPassword ? 'visibility' : 'visibility_off'}
                </span>
              </button>
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className={styles.submitBtn}
          >
            {isSubmitting ? '登录中...' : '进入梦境'}
            {!isSubmitting && <span className="material-symbols-outlined">arrow_forward</span>}
          </button>
        </form>

        {/* Divider */}
        <div className={styles.divider}>
          <div className={styles.dividerLine} />
          <span className={styles.dividerText}>或</span>
          <div className={styles.dividerLine} />
        </div>

        {/* Social Login */}
        <div className={styles.socialSection}>
          <div className={styles.socialButtons}>
            <button className={styles.socialBtn} type="button" title="微信登录">
              <span className="material-symbols-outlined">chat</span>
            </button>
            <button className={styles.socialBtn} type="button" title="Apple 登录">
              <span className="material-symbols-outlined">apps</span>
            </button>
          </div>
          <p className={styles.footer}>
            还没有记录过梦境？ <Link to="/register" className={styles.link}>新用户注册</Link>
          </p>
        </div>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
