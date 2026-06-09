import { useState, useEffect, useRef } from 'react';
import { submitImageGeneration, pollImageTask, hasApiKey, loadImageArchive, saveImageArchive, loadDreamAIResults } from '../../services/dimilinks';
import styles from './DreamImageModal.module.css';

interface Props {
  dreamId: string;
  prompt: string;
  onClose: () => void;
}

export default function DreamImageModal({ dreamId, prompt, onClose }: Props) {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'polling' | 'succeeded' | 'failed'>('idle');
  const [progress, setProgress] = useState(0);
  const [images, setImages] = useState<{ url: string; fileId?: string }[]>([]);
  const [error, setError] = useState('');
  const [archivedAt, setArchivedAt] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 打开时从 localStorage 快速加载，再从后端加载最新结果
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // 先用 localStorage 缓存快速展示
      const archive = loadImageArchive(dreamId);
      if (archive) {
        setImages(archive.images);
        setArchivedAt(archive.createdAt);
        setStatus('succeeded');
      }

      // 再从后端加载最新结果
      try {
        const results = await loadDreamAIResults(dreamId);
        if (cancelled) return;

        if (results.image?.url) {
          setImages([{ url: results.image.url }]);
          setArchivedAt(new Date(results.image.createdAt).getTime());
          setStatus('succeeded');
        }

        // 恢复进行中的任务
        if (results.pendingImageTask?.taskId) {
          setStatus('polling');
          setProgress(0);
          startPolling(results.pendingImageTask.taskId, results.pendingImageTask.logId);
        }
      } catch {}
    };

    load();
    return () => { cancelled = true; };
  }, [dreamId]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startGeneration = async () => {
    const hasKey = await hasApiKey();
    if (!hasKey) {
      setError('请先在后台管理配置 AI API Key');
      setStatus('failed');
      return;
    }

    setStatus('submitting');
    setError('');
    setImages([]);
    setProgress(0);
    setArchivedAt(null);

    try {
      const result = await submitImageGeneration(prompt, dreamId);
      setStatus('polling');
      startPolling(result.taskId, result.logId);
    } catch (err: any) {
      setError(err.message || '提交失败');
      setStatus('failed');
    }
  };

  const startPolling = (tid: string, logId?: string) => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const result = await pollImageTask(tid, logId);
        setProgress(result.progress);

        if (result.status === 'succeeded') {
          if (pollRef.current) clearInterval(pollRef.current);
          setImages(result.images);
          setStatus('succeeded');
          // 存档
          saveImageArchive(dreamId, result.images);
          setArchivedAt(Date.now());
        } else if (result.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(result.error || '生成失败');
          setStatus('failed');
        }
      } catch (err: any) {
        if (pollRef.current) clearInterval(pollRef.current);
        setError(err.message || '轮询异常');
        setStatus('failed');
      }
    }, 3000);
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3>梦境生图</h3>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <div className={styles.body}>
          <div className={styles.promptBox}>
            <label>Prompt</label>
            <p className={styles.promptText}>{prompt}</p>
          </div>

          {status === 'idle' && (
            <button className={styles.genBtn} onClick={startGeneration}>
              生成图片
            </button>
          )}

          {(status === 'submitting' || status === 'polling') && (
            <div className={styles.loadingBlock}>
              <div className={styles.spinner} />
              <span>{status === 'submitting' ? '提交中...' : `生成中 ${progress}%`}</span>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {status === 'failed' && (
            <div className={styles.errorBlock}>
              <p>{error}</p>
              <button className={styles.retryBtn} onClick={startGeneration}>重试</button>
            </div>
          )}

          {status === 'succeeded' && images.length > 0 && (
            <div className={styles.imageGrid}>
              {archivedAt && (
                <div className={styles.archiveHint}>
                  已存档于 {new Date(archivedAt).toLocaleString('zh-CN')}
                </div>
              )}
              {images.map((img, i) => (
                <div key={i} className={styles.imageCard}>
                  <img src={img.url} alt={`生成 ${i + 1}`} />
                  <div className={styles.imageMeta}>
                    <a href={img.url} target="_blank" rel="noopener noreferrer">查看原图</a>
                  </div>
                </div>
              ))}
              <button className={styles.regenerateBtn} onClick={startGeneration}>
                重新生成
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
