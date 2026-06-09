import { useState, useEffect } from 'react';
import { interpretDream, hasApiKey, loadInterpretArchive, saveInterpretArchive, loadDreamAIResults, getDailyUsage } from '../../services/dimilinks';
import type { DailyUsage } from '../../services/dimilinks';
import { renderMarkdown } from '../../utils/renderMarkdown';
import styles from './DreamInterpretModal.module.css';

interface Props {
  dreamId: string;
  content: string;
  onClose: () => void;
}

export default function DreamInterpretModal({ dreamId, content, onClose }: Props) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'succeeded' | 'failed'>('idle');
  const [resultHtml, setResultHtml] = useState('');
  const [error, setError] = useState('');
  const [archivedAt, setArchivedAt] = useState<number | null>(null);
  const [usage, setUsage] = useState<DailyUsage | null>(null);

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
      // 加载今日用量
      const u = await getDailyUsage();
      if (!cancelled) setUsage(u);

      // 先用 localStorage 缓存快速展示
      const archive = loadInterpretArchive(dreamId);
      if (archive) {
        setResultHtml(renderMarkdown(archive.text));
        setArchivedAt(archive.createdAt);
        setStatus('succeeded');
      }

      // 再从后端加载最新结果
      try {
        const results = await loadDreamAIResults(dreamId);
        if (cancelled) return;

        if (results.interpretation?.text) {
          setResultHtml(renderMarkdown(results.interpretation.text));
          setArchivedAt(new Date(results.interpretation.createdAt).getTime());
          setStatus('succeeded');
        }
      } catch {}
    };

    load();
    return () => { cancelled = true; };
  }, [dreamId]);

  const handleInterpret = async () => {
    const hasKey = await hasApiKey();
    if (!hasKey) {
      setError('请先在后台管理配置 AI API Key');
      setStatus('failed');
      return;
    }

    // 检查配额
    const u = await getDailyUsage();
    setUsage(u);
    if (u.chat.remaining <= 0) {
      setError(`今日解读次数已达上限（${u.chat.limit}次/天）`);
      setStatus('failed');
      return;
    }

    setStatus('loading');
    setError('');
    setArchivedAt(null);

    try {
      const result = await interpretDream(content, dreamId);
      setResultHtml(renderMarkdown(result.text));
      setStatus('succeeded');
      // 存档
      saveInterpretArchive(dreamId, result.text);
      setArchivedAt(Date.now());
      // 刷新用量
      getDailyUsage().then(u2 => setUsage(u2));
    } catch (err: any) {
      setError(err.message || '解读失败');
      setStatus('failed');
      // 刷新用量（可能是429错误）
      getDailyUsage().then(u2 => setUsage(u2));
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3>梦境解读</h3>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <div className={styles.body}>
          {status === 'idle' && (
            <div className={styles.intro}>
              <p>基于梦境内容，从心理学角度解读象征、情绪与潜意识含义。</p>
              {usage && (
                <p className={styles.quotaHint}>
                  今日剩余解读次数：{usage.chat.remaining} / {usage.chat.limit}
                </p>
              )}
              <button className={styles.interpretBtn} onClick={handleInterpret} disabled={usage !== null && usage.chat.remaining <= 0}>
                {usage && usage.chat.remaining <= 0 ? '今日次数已用完' : '开始解读'}
              </button>
            </div>
          )}

          {status === 'loading' && (
            <div className={styles.loadingBlock}>
              <div className={styles.spinner} />
              <span>正在解读梦境...</span>
            </div>
          )}

          {status === 'failed' && (
            <div className={styles.errorBlock}>
              <p>{error}</p>
              <button className={styles.retryBtn} onClick={handleInterpret}>重试</button>
            </div>
          )}

          {status === 'succeeded' && (
            <div>
              {archivedAt && (
                <div className={styles.archiveHint}>
                  已存档于 {new Date(archivedAt).toLocaleString('zh-CN')}
                </div>
              )}
              <div
                className={styles.result}
                dangerouslySetInnerHTML={{ __html: resultHtml }}
              />
              <button className={styles.reinterpretBtn} onClick={handleInterpret}>
                重新解读
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
