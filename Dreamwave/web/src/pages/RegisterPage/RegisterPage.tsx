import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../../services/api';
import Toast from '../../components/Toast/Toast';
import { useFireflyParticles } from '../../hooks/useFireflyParticles';
import styles from './RegisterPage.module.css';

interface RegisterPageProps {
  onRegister: () => void;
}

export default function RegisterPage({ onRegister }: RegisterPageProps) {
  const navigate = useNavigate();
  const particleRef = useRef<HTMLDivElement>(null);
  useFireflyParticles(particleRef, { count: 25 });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // 前端校验
    if (username.trim().length < 2) {
      setError('用户名至少2个字符');
      return;
    }
    if (password.length < 6) {
      setError('密码至少6个字符');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await api.register(username.trim(), password);
      localStorage.setItem('dreamwave_token', data.token);
      onRegister();
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err.message || '注册失败，请稍后再试');
      setToast({ message: err.message || '注册失败，请稍后再试', type: 'error' });
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
          <p className={styles.subtitle}>创建你的梦境空间</p>
        </div>

        {error && (
          <div className={styles.errorBox}>
            {error}
          </div>
        )}

        <div className={styles.inputGroup}>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="用户名（2-20字符）"
            autoComplete="username"
            className={styles.inputField}
          />
        </div>
        <div className={styles.inputGroup}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="密码（至少6字符）"
            autoComplete="new-password"
            className={styles.inputField}
          />
        </div>
        <div className={styles.inputGroupLast}>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="确认密码"
            autoComplete="new-password"
            className={styles.inputField}
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className={styles.submitBtn}
        >
          {isSubmitting ? '注册中...' : '注册'}
        </button>

        <p className={styles.footer}>
          已有账户？<Link to="/login" className={styles.link}>登录</Link>
        </p>
      </form>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
