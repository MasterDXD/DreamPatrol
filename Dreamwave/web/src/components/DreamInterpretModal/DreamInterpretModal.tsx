import { useState, useEffect } from 'react';
import { interpretDream, hasApiKey, loadInterpretArchive, saveInterpretArchive, loadDreamAIResults } from '../../services/dimilinks';
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
    } catch (err: any) {
      setError(err.message || '解读失败');
      setStatus('failed');
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
              <button className={styles.interpretBtn} onClick={handleInterpret}>
                开始解读
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
