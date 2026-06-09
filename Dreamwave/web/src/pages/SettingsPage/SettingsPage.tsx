import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import ThemeToggle from '../../components/ThemeToggle/ThemeToggle';
import { isAmbientMusicVisible, setAmbientMusicVisible } from '../../components/AmbientMusic/AmbientMusic';
import styles from './SettingsPage.module.css';

interface UserInfo {
  id: string;
  username: string;
  created_at?: string;
  dream_count?: number;
  email?: string;
  avatar?: string | null;
}

const AVATAR_PRESETS = [
  'https://ui-avatars.com/api/?name=Dreamer&background=7c3aed&color=fff&size=128',
  'https://ui-avatars.com/api/?name=Dreamer&background=1789fb&color=fff&size=128',
  'https://ui-avatars.com/api/?name=Dreamer&background=ec4899&color=fff&size=128',
  'https://ui-avatars.com/api/?name=Dreamer&background=10b981&color=fff&size=128',
  'https://ui-avatars.com/api/?name=Dreamer&background=f59e0b&color=fff&size=128',
  'https://ui-avatars.com/api/?name=Dreamer&background=8b5cf6&color=fff&size=128',
];

export default function SettingsPage() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [ambientMusic, setAmbientMusic] = useState(isAmbientMusicVisible);

  // 用户信息
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  // 头像选择
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 通知与隐私
  const [notifications, setNotifications] = useState(() => {
    return localStorage.getItem('dreamwave_notifications') !== 'false';
  });
  const [autoGenImage, setAutoGenImage] = useState(() => {
    return localStorage.getItem('dreamwave_auto_image') !== 'false';
  });
  const [privateAccount, setPrivateAccount] = useState(() => {
    return localStorage.getItem('dreamwave_private') === 'true';
  });

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const data = await api.getMe();
        setUserInfo(data);
      } catch (err) {
        console.error('获取用户信息失败', err);
      } finally {
        setLoadingUser(false);
      }
    };
    fetchUser();
  }, []);

  const handleSelectAvatar = async (url: string) => {
    setSavingAvatar(true);
    try {
      await api.updateProfile({ avatar: url });
      setUserInfo(prev => prev ? { ...prev, avatar: url } : prev);
      setShowAvatarPicker(false);
    } catch (err: any) {
      alert(err.message || '更新头像失败');
    } finally {
      setSavingAvatar(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }
    if (file.size > 1024 * 500) {
      alert('图片大小不能超过 500KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      await handleSelectAvatar(dataUrl);
    };
    reader.readAsDataURL(file);
    // 清空以允许选择相同文件
    e.target.value = '';
  };

  const handleAmbientMusicToggle = () => {
    const next = !ambientMusic;
    setAmbientMusic(next);
    setAmbientMusicVisible(next);
    window.dispatchEvent(new Event('ambient-music-visibility-change'));
  };

  const handleNotificationsToggle = () => {
    const next = !notifications;
    setNotifications(next);
    localStorage.setItem('dreamwave_notifications', String(next));
  };

  const handleAutoGenImageToggle = () => {
    const next = !autoGenImage;
    setAutoGenImage(next);
    localStorage.setItem('dreamwave_auto_image', String(next));
  };

  const handlePrivateAccountToggle = () => {
    const next = !privateAccount;
    setPrivateAccount(next);
    localStorage.setItem('dreamwave_private', String(next));
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

  const formatJoinDate = (dateStr?: string) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch {
      return '—';
    }
  };

  const avatarUrl = userInfo?.avatar
    || (userInfo?.username
      ? `https://ui-avatars.com/api/?name=${encodeURIComponent(userInfo.username)}&background=7c3aed&color=fff&size=128`
      : '');

  return (
    <div className={styles.settingsPage}>
      <h1 className={styles.pageTitle}>设置</h1>

      {/* 账号信息 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>账号信息</h2>
        {loadingUser ? (
          <div className={styles.userInfoLoading}>加载中...</div>
        ) : userInfo ? (
          <>
            <div className={styles.userCard}>
              <div className={styles.avatarWrapper}>
                <img
                  src={avatarUrl}
                  alt={userInfo.username}
                  className={styles.userAvatar}
                />
                <button
                  className={styles.avatarEditBtn}
                  onClick={() => setShowAvatarPicker(v => !v)}
                  title="修改头像"
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                </button>
              </div>
              <div className={styles.userDetails}>
                <div className={styles.userName}>{userInfo.username}</div>
                <div className={styles.userId}>ID: {userInfo.id.slice(0, 8)}...</div>
                {userInfo.email && (
                  <div className={styles.userMeta}>📧 {userInfo.email}</div>
                )}
                <div className={styles.userMeta}>📅 加入于 {formatJoinDate(userInfo.created_at)}</div>
              </div>
              {typeof userInfo.dream_count === 'number' && (
                <div className={styles.userStat}>
                  <div className={styles.userStatValue}>{userInfo.dream_count}</div>
                  <div className={styles.userStatLabel}>梦境记录</div>
                </div>
              )}
            </div>

            {showAvatarPicker && (
              <div className={styles.avatarPicker}>
                <div className={styles.avatarPickerTitle}>选择头像</div>
                <div className={styles.avatarPresetGrid}>
                  {AVATAR_PRESETS.map((url, idx) => (
                    <button
                      key={idx}
                      className={`${styles.avatarPresetBtn} ${userInfo.avatar === url ? styles.avatarPresetBtnActive : ''}`}
                      onClick={() => handleSelectAvatar(url)}
                      disabled={savingAvatar}
                      type="button"
                    >
                      <img src={url} alt={`预设${idx + 1}`} />
                    </button>
                  ))}
                </div>
                <div className={styles.avatarPickerActions}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                  />
                  <button
                    className={styles.avatarUploadBtn}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={savingAvatar}
                    type="button"
                  >
                    📤 上传自定义头像（≤500KB）
                  </button>
                  <button
                    className={styles.avatarCancelBtn}
                    onClick={() => setShowAvatarPicker(false)}
                    disabled={savingAvatar}
                    type="button"
                  >
                    取消
                  </button>
                </div>
                {savingAvatar && <div className={styles.avatarSaving}>保存中...</div>}
              </div>
            )}
          </>
        ) : (
          <div className={styles.userInfoLoading}>获取账号信息失败</div>
        )}
      </section>

      {/* 导出功能 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>导出梦境</h2>
        <p className={styles.sectionDesc}>将所有梦境记录导出为文件，方便备份与迁移</p>
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

      {/* 通知与隐私 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>通知与隐私</h2>

        <div className={styles.themeSection}>
          <div className={styles.themeLabelWrap}>
            <span className={styles.themeLabel}>梦境提醒通知</span>
            <span className={styles.themeHint}>开启后会提醒你记录梦境</span>
          </div>
          <button
            className={`${styles.toggleBtn} ${notifications ? styles.toggleBtnActive : ''}`}
            onClick={handleNotificationsToggle}
            role="switch"
            aria-checked={notifications}
          >
            <span className={styles.toggleThumb} />
          </button>
        </div>

        <div className={styles.themeSection}>
          <div className={styles.themeLabelWrap}>
            <span className={styles.themeLabel}>自动生成梦境图像</span>
            <span className={styles.themeHint}>记录梦境时自动生成对应图像</span>
          </div>
          <button
            className={`${styles.toggleBtn} ${autoGenImage ? styles.toggleBtnActive : ''}`}
            onClick={handleAutoGenImageToggle}
            role="switch"
            aria-checked={autoGenImage}
          >
            <span className={styles.toggleThumb} />
          </button>
        </div>

        <div className={styles.themeSection}>
          <div className={styles.themeLabelWrap}>
            <span className={styles.themeLabel}>隐私账户</span>
            <span className={styles.themeHint}>开启后其他用户无法查看你的梦境</span>
          </div>
          <button
            className={`${styles.toggleBtn} ${privateAccount ? styles.toggleBtnActive : ''}`}
            onClick={handlePrivateAccountToggle}
            role="switch"
            aria-checked={privateAccount}
          >
            <span className={styles.toggleThumb} />
          </button>
        </div>
      </section>

      {/* 修改密码 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>修改密码</h2>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="current-password">当前密码</label>
          <input
            id="current-password"
            type="password"
            className={styles.input}
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="new-password">新密码</label>
          <input
            id="new-password"
            type="password"
            className={styles.input}
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="confirm-new-password">确认新密码</label>
          <input
            id="confirm-new-password"
            type="password"
            className={styles.input}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
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
