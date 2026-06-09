import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import ThemeToggle from '../../components/ThemeToggle/ThemeToggle';
import { isAmbientMusicVisible, setAmbientMusicVisible } from '../../components/AmbientMusic/AmbientMusic';
import styles from './SettingsPage.module.css';

export default function SettingsPage() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [ambientMusic, setAmbientMusic] = useState(isAmbientMusicVisible);

  const handleAmbientMusicToggle = () => {
    const next = !ambientMusic;
    setAmbientMusic(next);
    setAmbientMusicVisible(next);
    window.dispatchEvent(new Event('ambient-music-visibility-change'));
  };

  const handleExport = async (format: 'markdown' | 'txt' | 'json') => {
    setExporting(format);
    try {
      await api.exportDreams(format);
    } catch (err: any) {
      alert(err.message || '导出失败');
    } finally {
      setExporting(null);
    }
  };

  const handleChangePassword = async () => {
    setPasswordMsg(null);
    if (!currentPassword || !newPassword) {
      setPasswordMsg({ text: '请填写所有字段', type: 'error' });
      return;
    }
    if (newPassword.length < 6) {
      setPasswordMsg({ text: '新密码至少6个字符', type: 'error' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ text: '两次输入的新密码不一致', type: 'error' });
      return;
    }

    setChangingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setPasswordMsg({ text: '密码修改成功，请重新登录', type: 'success' });
      // 密码修改后token被加入黑名单，需要重新登录
      setTimeout(() => {
        localStorage.removeItem('dreamwave_token');
        navigate('/login', { replace: true });
      }, 1500);
    } catch (err: any) {
      setPasswordMsg({ text: err.message || '修改密码失败', type: 'error' });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className={styles.settingsPage}>
      <h1 className={styles.pageTitle}>设置</h1>

      {/* 导出功能 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>导出梦境</h2>
        <div className={styles.exportBtns}>
          <button
            className={styles.exportBtn}
            onClick={() => handleExport('markdown')}
            disabled={exporting === 'markdown'}
          >
            {exporting === 'markdown' ? '导出中...' : '导出 Markdown'}
          </button>
          <button
            className={styles.exportBtn}
            onClick={() => handleExport('txt')}
            disabled={exporting === 'txt'}
          >
            {exporting === 'txt' ? '导出中...' : '导出 TXT'}
          </button>
          <button
            className={styles.exportBtn}
            onClick={() => handleExport('json')}
            disabled={exporting === 'json'}
          >
            {exporting === 'json' ? '导出中...' : '导出 JSON'}
          </button>
        </div>
      </section>

      {/* 主题切换 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>主题</h2>
        <div className={styles.themeSection}>
          <span className={styles.themeLabel}>切换外观模式</span>
          <ThemeToggle />
        </div>
      </section>

      {/* 氛围音乐 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>氛围音乐</h2>
        <div className={styles.themeSection}>
          <span className={styles.themeLabel}>显示全局氛围音乐控件</span>
          <button
            className={`${styles.toggleBtn} ${ambientMusic ? styles.toggleBtnActive : ''}`}
            onClick={handleAmbientMusicToggle}
            role="switch"
            aria-checked={ambientMusic}
          >
            <span className={styles.toggleThumb} />
          </button>
        </div>
      </section>

      {/* 修改密码 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>修改密码</h2>
        <div className={styles.formGroup}>
          <label className={styles.label}>当前密码</label>
          <input
            type="password"
            className={styles.input}
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>新密码</label>
          <input
            type="password"
            className={styles.input}
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>确认新密码</label>
          <input
            type="password"
            className={styles.input}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
          />
        </div>
        <button
          className={styles.submitBtn}
          onClick={handleChangePassword}
          disabled={changingPassword}
        >
          {changingPassword ? '修改中...' : '修改密码'}
        </button>
        {passwordMsg && (
          <div className={`${styles.message} ${passwordMsg.type === 'success' ? styles.messageSuccess : styles.messageError}`}>
            {passwordMsg.text}
          </div>
        )}
      </section>
    </div>
  );
}
