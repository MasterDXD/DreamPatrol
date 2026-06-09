import { useNavigate } from 'react-router-dom';
import styles from './NotFoundPage.module.css';

/* 404兜底页面 */
export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className={styles.container}>
      <div className={styles.icon}>🌌</div>
      <h1 className={styles.title}>迷路了</h1>
      <p className={styles.message}>这个梦境不存在…</p>
      <button className={styles.homeBtn} onClick={() => navigate('/')}>回到首页</button>
    </div>
  );
}
