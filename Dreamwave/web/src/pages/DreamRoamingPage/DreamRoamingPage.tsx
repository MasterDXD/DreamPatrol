import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { EMOTION_META } from '../../constants/emotions';
import { renderMarkdown, extractDreamTitle } from '../../utils/renderMarkdown';
import {
  hasApiKey,
  submitImageGeneration,
  pollImageTask,
  interpretDream,
  loadImageArchive,
  saveImageArchive,
  loadInterpretArchive,
  saveInterpretArchive,
  loadDreamAIResults,
  getDailyUsage,
} from '../../services/dimilinks';
import type { Dream } from '../../types/dream';
import styles from './DreamRoamingPage.module.css';

export default function DreamRoamingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dream, setDream] = useState<Dream | null>(null);
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState(true);

  // 生图状态
  const [imgStatus, setImgStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [imgProgress, setImgProgress] = useState(0);
  const [imgUrl, setImgUrl] = useState('');
  const [imgError, setImgError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 解读状态
  const [interpStatus, setInterpStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [interpHtml, setInterpHtml] = useState('');
  const [interpError, setInterpError] = useState('');
  const [dreamTitle, setDreamTitle] = useState<string | null>(null);

  // 音乐
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(0.3);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 加载梦境数据
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.getDream(id).then(data => {
      setDream(data.dream);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, [id]);

  // 入场动画
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), 600);
    return () => clearTimeout(timer);
  }, []);

  // 加载 AI 结果
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const loadResults = async () => {
      const imgArchive = loadImageArchive(id);
      if (imgArchive && imgArchive.images.length > 0) {
        setImgUrl(imgArchive.images[0].url);
        setImgStatus('done');
      }
      const interpArchive = loadInterpretArchive(id);
      if (interpArchive) {
        setInterpHtml(renderMarkdown(interpArchive.text));
        const extracted = extractDreamTitle(interpArchive.text);
        if (extracted) setDreamTitle(extracted);
        setInterpStatus('done');
      }

      try {
        const results = await loadDreamAIResults(id);
        if (cancelled) return;
        if (results.image?.url) {
          setImgUrl(results.image.url);
          setImgStatus('done');
        }
        if (results.interpretation?.text) {
          setInterpHtml(renderMarkdown(results.interpretation.text));
          const extracted = extractDreamTitle(results.interpretation.text);
          if (extracted) setDreamTitle(extracted);
          setInterpStatus('done');
        }
        if (results.pendingImageTask?.taskId) {
          setImgStatus('loading');
          setImgProgress(0);
          resumeImagePolling(results.pendingImageTask.taskId, results.pendingImageTask.logId);
        }
      } catch {}
    };

    loadResults();
    return () => { cancelled = true; };
  }, [id]);

  // 音乐初始化
  useEffect(() => {
    const musicSrc = '/assets/audio/dream-patrol_white-noise_summer-night.mp3';
    const audio = new Audio(musicSrc);
    audio.loop = true;
    audio.volume = musicVolume;
    audioRef.current = audio;

    // 首次交互后播放
    const tryPlay = () => {
      audio.play().then(() => setMusicPlaying(true)).catch(() => {});
      document.removeEventListener('click', tryPlay);
      document.removeEventListener('touchstart', tryPlay);
    };
    document.addEventListener('click', tryPlay, { once: true });
    document.addEventListener('touchstart', tryPlay, { once: true });

    return () => {
      audio.pause();
      audio.src = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMusic = useCallback(() => {
    if (!audioRef.current) return;
    if (musicPlaying) {
      audioRef.current.pause();
      setMusicPlaying(false);
    } else {
      audioRef.current.play().then(() => setMusicPlaying(true)).catch(() => {});
    }
  }, [musicPlaying]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setMusicVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  /** 恢复进行中生图任务的轮询 */
  const resumeImagePolling = (taskId: string, logId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const task = await pollImageTask(taskId, logId);
        setImgProgress(task.progress);
        if (task.status === 'succeeded') {
          if (pollRef.current) clearInterval(pollRef.current);
          const url = task.images[0]?.url || '';
          setImgUrl(url);
          setImgStatus('done');
          saveImageArchive(id!, task.images);
        } else if (task.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setImgError(task.error || '生成失败');
          setImgStatus('error');
        }
      } catch {
        if (pollRef.current) clearInterval(pollRef.current);
        setImgStatus('idle');
      }
    }, 5000);
  };

  // 清理轮询
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // 生图
  const handleGenerateImage = useCallback(async () => {
    if (!dream) return;
    if (imgStatus === 'done') return; // 已有结果

    if (!(await hasApiKey())) {
      setImgError('请先在后台管理配置 AI API Key');
      setImgStatus('error');
      return;
    }

    // 检查配额
    const imgUsage = await getDailyUsage();
    if (imgUsage.image.remaining <= 0) {
      setImgError(`今日生图次数已达上限（${imgUsage.image.limit}次/天）`);
      setImgStatus('error');
      return;
    }

    setImgStatus('loading');
    setImgProgress(0);
    setImgError('');

    try {
      const result = await submitImageGeneration(dream.content, dream.id);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const task = await pollImageTask(result.taskId, result.logId);
          setImgProgress(task.progress);
          if (task.status === 'succeeded') {
            if (pollRef.current) clearInterval(pollRef.current);
            const url = task.images[0]?.url || '';
            setImgUrl(url);
            setImgStatus('done');
            saveImageArchive(dream.id, task.images);
          } else if (task.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setImgError(task.error || '生成失败');
            setImgStatus('error');
          }
        } catch (err: any) {
          if (pollRef.current) clearInterval(pollRef.current);
          setImgError(err.message || '轮询异常');
          setImgStatus('error');
        }
      }, 3000);
    } catch (err: any) {
      setImgError(err.message || '提交失败');
      setImgStatus('error');
    }
  }, [dream, imgStatus]);

  // 解读
  const handleInterpret = useCallback(async () => {
    if (!dream) return;
    if (interpStatus === 'done') return;

    if (!(await hasApiKey())) {
      setInterpError('请先在后台管理配置 AI API Key');
      setInterpStatus('error');
      return;
    }

    // 检查配额
    const chatUsage = await getDailyUsage();
    if (chatUsage.chat.remaining <= 0) {
      setInterpError(`今日解读次数已达上限（${chatUsage.chat.limit}次/天）`);
      setInterpStatus('error');
      return;
    }

    setInterpStatus('loading');
    setInterpError('');

    try {
      const result = await interpretDream(dream.content, dream.id);
      setInterpHtml(renderMarkdown(result.text));
      const extracted = extractDreamTitle(result.text);
      if (extracted) setDreamTitle(extracted);
      setInterpStatus('done');
      saveInterpretArchive(dream.id, result.text);
    } catch (err: any) {
      setInterpError(err.message || '解读失败');
      setInterpStatus('error');
    }
  }, [dream, interpStatus]);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
          <span>潜入梦境...</span>
        </div>
      </div>
    );
  }

  if (!dream) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingWrap}>
          <span>梦境未找到</span>
          <button className={styles.backBtn} onClick={() => navigate(-1)}>返回</button>
        </div>
      </div>
    );
  }

  const meta = EMOTION_META[dream.emotion];

  return (
    <div className={`${styles.page} ${entering ? styles.entering : ''}`}>
      {/* 沉浸式背景 */}
      <div className={styles.bgLayer}>
        {imgUrl ? (
          <img src={imgUrl} alt="" className={styles.bgImg} />
        ) : (
          <div className={styles.bgGradient} style={{ background: meta.bgGradient }} />
        )}
        <div className={styles.bgOverlay} />
      </div>

      {/* 大气星云 */}
      <div className={styles.nebula1} />
      <div className={styles.nebula2} />

      {/* 顶部导航栏 */}
      <header className={styles.header}>
        <button className={styles.headerBackBtn} onClick={() => navigate(-1)} title="返回">
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 0" }}>arrow_back</span>
        </button>
        <h1 className={styles.headerTitle}>{dreamTitle || dream.title}</h1>
        <div className={styles.headerSpacer} />
      </header>

      {/* 主内容 */}
      <main className={styles.main}>
        {/* 日期与元信息 */}
        <div className={styles.metaRow}>
          <div className={styles.metaLeft}>
            <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 0", fontSize: 16, color: '#4cd7f6' }}>calendar_today</span>
            <span className={styles.metaDate}>{dream.recorded_date}</span>
          </div>
          <div className={styles.emotionPill}>
            <span className={styles.emotionDot} style={{ backgroundColor: meta.color }} />
            <span className={styles.emotionLabel}>{meta.icon} {meta.label}</span>
          </div>
        </div>

        {/* 情绪标签 */}
        <div className={styles.moodTags}>
          <div className={styles.moodTag} style={{ borderColor: `${meta.color}40` }}>
            <span className={styles.moodDot} style={{ backgroundColor: meta.color }} />
            <span className={styles.moodLabel} style={{ color: meta.color }}>{meta.icon} {meta.label} 85%</span>
          </div>
          <div className={styles.moodTag} style={{ borderColor: '#d0bcff40' }}>
            <span className={styles.moodDot} style={{ backgroundColor: '#d0bcff' }} />
            <span className={styles.moodLabel} style={{ color: '#d0bcff' }}>自由 70%</span>
          </div>
        </div>

        {/* 梦境叙事卡片 */}
        <section className={styles.narrativeCard}>
          <div className={styles.narrativeGlow} style={{ background: `${meta.color}20` }} />
          <h2 className={styles.narrativeTitle}>{dreamTitle || dream.title}</h2>
          <p className={styles.narrativeText}>{dream.content}</p>
          {dream.narrative && (
            <div className={styles.narrativeSection}>
              <div className={styles.narrativeDivider} />
              <p className={styles.narrativeExtra}>{dream.narrative}</p>
            </div>
          )}
        </section>

        {/* 潜意识解读 */}
        <section className={styles.interpretCard}>
          <div className={styles.interpretHeader}>
            <div className={styles.interpretIcon}>
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1", fontSize: 20, color: '#4cd7f6' }}>psychology</span>
            </div>
            <h3 className={styles.interpretTitle}>潜意识解读</h3>
            {interpStatus === 'idle' && (
              <button className={styles.interpretTrigger} onClick={handleInterpret}>
                开始解读
              </button>
            )}
          </div>

          {interpStatus === 'loading' && (
            <div className={styles.loadingBox}>
              <div className={styles.miniSpinner} />
              <span>正在解读梦境...</span>
            </div>
          )}
          {interpStatus === 'done' && interpHtml && (
            <div className={styles.interpretContent} dangerouslySetInnerHTML={{ __html: interpHtml }} />
          )}
          {interpStatus === 'error' && interpError && (
            <div className={styles.errorBox}>{interpError}</div>
          )}
        </section>

        {/* 梦境画廊 */}
        <section className={styles.galleryCard}>
          <div className={styles.galleryHeader}>
            <div className={styles.interpretIcon}>
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1", fontSize: 20, color: '#d0bcff' }}>image</span>
            </div>
            <h3 className={styles.interpretTitle}>梦境画廊</h3>
            {imgStatus === 'idle' && (
              <button className={styles.interpretTrigger} onClick={handleGenerateImage}>
                生成梦境图
              </button>
            )}
          </div>

          {imgStatus === 'loading' && (
            <div className={styles.loadingBox}>
              <div className={styles.miniSpinner} />
              <span>绘梦中 {imgProgress}%</span>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${imgProgress}%` }} />
              </div>
            </div>
          )}
          {imgStatus === 'done' && imgUrl && (
            <div className={styles.galleryImage}>
              <img src={imgUrl} alt="梦境生图" loading="lazy" />
            </div>
          )}
          {imgStatus === 'error' && imgError && (
            <div className={styles.errorBox}>{imgError}</div>
          )}
        </section>
      </main>

      {/* 音乐控制 */}
      <div className={styles.musicBar}>
        <button className={styles.musicToggle} onClick={toggleMusic} title={musicPlaying ? '暂停音乐' : '播放音乐'}>
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1", fontSize: 20 }}>
            {musicPlaying ? 'volume_up' : 'volume_off'}
          </span>
        </button>
        <div className={styles.volumeControl}>
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 0", fontSize: 14, color: '#909097' }}>volume_down</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={musicVolume}
            onChange={handleVolumeChange}
            className={styles.volumeSlider}
          />
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 0", fontSize: 14, color: '#909097' }}>volume_up</span>
        </div>
      </div>
    </div>
  );
}
