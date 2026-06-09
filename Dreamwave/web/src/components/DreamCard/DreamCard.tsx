import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import type { Dream } from '../../types/dream';
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
} from '../../services/dimilinks';
import styles from './DreamCard.module.css';

interface DreamCardProps {
  dream: Dream;
  onFavoriteToggle?: () => void;
}

function DreamCard({ dream, onFavoriteToggle }: DreamCardProps) {
  const navigate = useNavigate();
  const meta = EMOTION_META[dream.emotion];

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

  // 解读提取的梦境标题
  const [dreamTitle, setDreamTitle] = useState<string | null>(null);

  // 展开状态
  const [showImage, setShowImage] = useState(false);
  const [showInterpret, setShowInterpret] = useState(false);

  // 全屏查看图片
  const [showFullImage, setShowFullImage] = useState(false);

  // 缩略图URL（从存档加载，用于卡片右侧小图）
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  // 打开时从后端加载结果，恢复进行中任务
  useEffect(() => {
    let cancelled = false;

    const loadResults = async () => {
      // 先用 localStorage 缓存快速展示
      const imgArchive = loadImageArchive(dream.id);
      if (imgArchive && imgArchive.images.length > 0) {
        setImgUrl(imgArchive.images[0].url);
        setThumbUrl(imgArchive.images[0].url);
        setImgStatus('done');
      }
      const interpArchive = loadInterpretArchive(dream.id);
      if (interpArchive) {
        setInterpHtml(renderMarkdown(interpArchive.text));
        const extracted = extractDreamTitle(interpArchive.text);
        if (extracted) setDreamTitle(extracted);
        setInterpStatus('done');
      }

      // 再从后端加载最新结果
      try {
        const results = await loadDreamAIResults(dream.id);
        if (cancelled) return;

        // 恢复生图结果
        if (results.image?.url) {
          setImgUrl(results.image.url);
          setThumbUrl(results.image.url);
          setImgStatus('done');
        }

        // 恢复解读结果
        if (results.interpretation?.text) {
          setInterpHtml(renderMarkdown(results.interpretation.text));
          const extracted = extractDreamTitle(results.interpretation.text);
          if (extracted) setDreamTitle(extracted);
          setInterpStatus('done');
        }

        // 恢复进行中的生图任务
        if (results.pendingImageTask?.taskId) {
          setImgStatus('loading');
          setImgProgress(0);
          setShowImage(true);
          resumeImagePolling(results.pendingImageTask.taskId, results.pendingImageTask.logId);
        }
      } catch {}
    };

    loadResults();
    return () => { cancelled = true; };
  }, [dream.id]);

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
          setThumbUrl(url);
          setImgStatus('done');
          saveImageArchive(dream.id, task.images);
          // 同步到后端
          api.updateAIResults(dream.id, { imageUrl: url }).catch(() => {});
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
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.toggleFavorite(dream.id);
      onFavoriteToggle?.();
    } catch {}
  };

  // 生图
  const handleGenerateImage = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();

    // 如果已有结果，切换展开/收起
    if (imgStatus === 'done') {
      setShowImage(prev => !prev);
      return;
    }

    if (!(await hasApiKey())) {
      setImgError('请先在后台管理配置 AI API Key');
      setImgStatus('error');
      return;
    }

    setImgStatus('loading');
    setImgProgress(0);
    setImgError('');
    setShowImage(true);

    try {
      const result = await submitImageGeneration(dream.content, dream.id);
      // 开始轮询
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const task = await pollImageTask(result.taskId, result.logId);
          setImgProgress(task.progress);
          if (task.status === 'succeeded') {
            if (pollRef.current) clearInterval(pollRef.current);
            const url = task.images[0]?.url || '';
            setImgUrl(url);
            setThumbUrl(url);
            setImgStatus('done');
            saveImageArchive(dream.id, task.images);
          // 同步到后端
          api.updateAIResults(dream.id, { imageUrl: url }).catch(() => {});
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
  }, [dream.id, dream.content, imgStatus]);

  // 解读
  const handleInterpret = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();

    // 如果已有结果，切换展开/收起
    if (interpStatus === 'done') {
      setShowInterpret(prev => !prev);
      return;
    }

    if (!(await hasApiKey())) {
      setInterpError('请先在后台管理配置 AI API Key');
      setInterpStatus('error');
      return;
    }

    setInterpStatus('loading');
    setInterpError('');
    setShowInterpret(true);

    try {
      const result = await interpretDream(dream.content, dream.id);
      setInterpHtml(renderMarkdown(result.text));
      const extracted = extractDreamTitle(result.text);
      if (extracted) setDreamTitle(extracted);
      setInterpStatus('done');
      saveInterpretArchive(dream.id, result.text);
      // 同步到后端
      api.updateAIResults(dream.id, { interpretation: result.text }).catch(() => {});
    } catch (err: any) {
      setInterpError(err.message || '解读失败');
      setInterpStatus('error');
    }
  }, [dream.id, dream.content, interpStatus]);

  const imgBtnLabel = imgStatus === 'loading'
    ? `绘梦中 ${imgProgress}%`
    : imgStatus === 'done'
      ? (showImage ? '收起' : '绘梦生影')
      : '绘梦生影';

  const interpBtnLabel = interpStatus === 'loading'
    ? '溯梦中...'
    : interpStatus === 'done'
      ? (showInterpret ? '收起' : '溯梦心语')
      : '溯梦心语';

  // Emotion color CSS custom properties for glow effects
  const emotionStyle = {
    '--emotion-glow': `${meta.color}66`,
    '--emotion-color': meta.color,
    '--emotion-color-alpha': `${meta.color}40`,
  } as React.CSSProperties;

  return (
    <div
      className={`${styles.card} card-hover`}
      style={emotionStyle}
      onClick={() => navigate(`/dream/${dream.id}`)}
    >
      <div className={styles.emotionBar} style={{ backgroundColor: meta.color }} />
      <div className={styles.content}>
        <div className={styles.titleRow}>
          <h3 className={styles.title}>{dreamTitle || dream.title}</h3>
          <button className={styles.favoriteBtn} onClick={handleFavorite} title={dream.is_favorite ? '取消收藏' : '收藏'}>
            {dream.is_favorite ? (
              <svg viewBox="0 0 24 24" fill="#F0A050" stroke="#F0A050" strokeWidth="1">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            )}
          </button>
        </div>
        <div className={styles.contentRow}>
          <div className={styles.contentMain}>
            <p className={styles.preview}>
              {dream.content.slice(0, 100)}{dream.content.length > 100 ? '...' : ''}
            </p>
            <div className={styles.meta}>
              <span className={styles.date}>{dream.recorded_date}</span>
              <span className={styles.emotionTag} style={{ '--emotion-color': meta.color, '--emotion-color-alpha': `${meta.color}40` } as React.CSSProperties}>
                {meta.icon} {meta.label}
              </span>
            </div>
            <div className={styles.aiActions}>
              <button
                className={`${styles.aiBtn} ${styles.aiBtnImage} ${imgStatus === 'loading' ? styles.aiBtnLoading : ''} ${imgStatus === 'done' ? styles.aiBtnDone : ''}`}
                onClick={handleGenerateImage}
                title="绘梦生影"
              >
                {imgBtnLabel}
              </button>
              <button
                className={`${styles.aiBtn} ${styles.aiBtnInterpret} ${interpStatus === 'loading' ? styles.aiBtnLoading : ''} ${interpStatus === 'done' ? styles.aiBtnDone : ''}`}
                onClick={handleInterpret}
                title="溯梦心语"
              >
                {interpBtnLabel}
              </button>
            </div>
          </div>

          {/* 缩略图 */}
          {thumbUrl && (
            <div
              className={styles.thumbnail}
              onClick={(e) => { e.stopPropagation(); setShowFullImage(true); }}
              title="查看大图"
            >
              <img src={thumbUrl} alt="梦境生图" />
            </div>
          )}
        </div>

        {/* 内联图片展示 */}
        {showImage && imgStatus === 'done' && imgUrl && (
          <div className={styles.inlineImage} onClick={e => e.stopPropagation()}>
            <img src={imgUrl} alt="梦境生图" />
          </div>
        )}
        {imgStatus === 'loading' && showImage && (
          <div className={styles.inlineLoading} onClick={e => e.stopPropagation()}>
            <div className={styles.miniSpinner} />
            <span>生成中 {imgProgress}%</span>
            <div className={styles.miniProgress}>
              <div className={styles.miniProgressFill} style={{ width: `${imgProgress}%` }} />
            </div>
          </div>
        )}
        {imgStatus === 'error' && imgError && (
          <div className={styles.inlineError} onClick={e => e.stopPropagation()}>
            {imgError}
          </div>
        )}

        {/* 内联解读展示 */}
        {showInterpret && interpStatus === 'done' && interpHtml && (
          <div
            className={styles.inlineInterpret}
            onClick={e => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: interpHtml }}
          />
        )}
        {interpStatus === 'loading' && showInterpret && (
          <div className={styles.inlineLoading} onClick={e => e.stopPropagation()}>
            <div className={styles.miniSpinner} />
            <span>正在解读...</span>
          </div>
        )}
        {interpStatus === 'error' && interpError && (
          <div className={styles.inlineError} onClick={e => e.stopPropagation()}>
            {interpError}
          </div>
        )}
      </div>

      {/* 全屏查看图片 */}
      {showFullImage && imgUrl && (
        <div
          className={styles.fullImageOverlay}
          onClick={(e) => { e.stopPropagation(); setShowFullImage(false); }}
        >
          <img src={imgUrl} alt="梦境生图" />
        </div>
      )}
    </div>
  );
}

export default React.memo(DreamCard);
