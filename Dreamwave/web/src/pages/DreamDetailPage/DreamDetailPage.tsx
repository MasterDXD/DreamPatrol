import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../../services/api';
import type { Dream } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import EmptyState from '../../components/EmptyState/EmptyState';
import Toast from '../../components/Toast/Toast';
import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog';
import { useEmotionTheme } from '../../hooks/useEmotionTheme';
import { loadImageArchive, loadInterpretArchive, loadDreamAIResults } from '../../services/dimilinks';
import { renderMarkdown } from '../../utils/renderMarkdown';
import styles from './DreamDetailPage.module.css';

export default function DreamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dream, setDream] = useState<Dream | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [relatedDreams, setRelatedDreams] = useState<Dream[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [interpretHtml, setInterpretHtml] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 设置情绪主题CSS变量
  useEmotionTheme(dream?.emotion ?? null, containerRef);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.getDream(id)
      .then(data => setDream(data.dream))
      .catch(() => {
        setDream(null);
        setToast({ message: '加载梦境失败', type: 'error' });
      })
      .finally(() => setLoading(false));
  }, [id]);

  // 加载相关梦境
  useEffect(() => {
    if (!id) return;
    api.getRelatedDreams(id)
      .then(data => setRelatedDreams(data.dreams))
      .catch(() => { /* 静默失败 */ });
  }, [id]);

  // 加载AI生图和解读结果
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const loadAIResults = async () => {
      // 先用 localStorage 缓存快速展示
      const imgArchive = loadImageArchive(id);
      if (imgArchive && imgArchive.images.length > 0) {
        setImageUrl(imgArchive.images[0].url);
      }
      const interpArchive = loadInterpretArchive(id);
      if (interpArchive) {
        setInterpretHtml(renderMarkdown(interpArchive.text));
      }

      // 再从后端加载最新结果
      try {
        const results = await loadDreamAIResults(id);
        if (cancelled) return;

        if (results.image?.url) {
          setImageUrl(results.image.url);
        }
        if (results.interpretation?.text) {
          setInterpretHtml(renderMarkdown(results.interpretation.text));
        }
      } catch {}
    };

    loadAIResults();
    return () => { cancelled = true; };
  }, [id]);

  const handleToggleFavorite = async () => {
    if (!dream) return;
    try {
      const data = await api.toggleFavorite(dream.id);
      setDream({ ...dream, is_favorite: data.is_favorite });
    } catch (err: any) {
      setToast({ message: err.message || '操作失败', type: 'error' });
    }
  };

  if (loading) return <div className={styles.loading}>加载中...</div>;
  if (!dream) return <EmptyState message="找不到这个梦" actionLabel="返回首页" onAction={() => navigate('/')} />;

  const meta = EMOTION_META[dream.emotion];

  const handleDelete = async () => {
    if (!dream) return;
    try {
      await api.deleteDream(dream.id);
      navigate('/');
    } catch (err: any) {
      setToast({ message: err.message || '删除失败', type: 'error' });
      setShowDeleteConfirm(false);
    }
  };

  const handleGenerateNarrative = async () => {
    if (!dream || isGenerating) return;
    setIsGenerating(true);
    try {
      const data = await api.generateNarrative(dream.id);
      setNarrative(data.narrative);
    } catch (err: any) {
      setToast({ message: err.message || '生成叙事失败', type: 'error' });
    } finally {
      setIsGenerating(false);
    }
  };

  const narrativeDisabled = isGenerating || !!dream.narrative || !!narrative;

  return (
    <div ref={containerRef} className={styles.container}>
      <div className={styles.inner}>
        {/* Back button */}
        <button onClick={() => navigate(-1)} className={styles.backBtn}>
          ←
        </button>

        {/* Metadata row */}
        <div className={styles.metadataRow}>
          <div className={styles.metadataLeft}>
            <span className={styles.metadataIcon}>📅</span>
            <span className={styles.metadataDate}>{dream.recorded_date}</span>
          </div>
          <div className={styles.metadataBadge}>
            <span>{meta.icon}</span>
            <span>{meta.label}</span>
          </div>
        </div>

        {/* Main narrative card */}
        <section className={styles.narrativeCard}>
          <h2 className={styles.dreamTitle}>{dream.title}</h2>

          {/* Dream AI image */}
          {imageUrl && (
            <img
              src={imageUrl}
              alt="梦境生图"
              className={styles.dreamImage}
            />
          )}

          <div className={styles.content}>
            {dream.content}
          </div>

          {/* Narrative block */}
          {(narrative || dream.narrative) && (
            <div className={styles.narrativeBlock}>
              <div className={styles.narrativeLabel}>梦境叙事</div>
              <div className={styles.narrativeContent}>
                {narrative || dream.narrative}
              </div>
            </div>
          )}

          {/* Emotion tags */}
          <div className={styles.tagsSeparator}>
            <div className={styles.tagsArea}>
              <div className={styles.emotionTag}>
                <span className={styles.pulsingDot} />
                <span>{meta.icon} {meta.label}</span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className={styles.tagsSeparator}>
            <div className={styles.actionBar}>
              <div className={styles.actionBtnWithLabel}>
                <button
                  onClick={handleToggleFavorite}
                  className={`${styles.actionBtn} ${dream.is_favorite ? styles.favoriteBtnActive : ''}`}
                  title={dream.is_favorite ? '取消收藏' : '收藏'}
                >
                  {dream.is_favorite ? '❤️' : '🤍'}
                </button>
                <span className={styles.actionBtnLabel}>收藏</span>
              </div>
              <div className={styles.actionBtnWithLabel}>
                <button
                  onClick={() => navigate(`/dream/${dream.id}/edit`)}
                  className={styles.actionBtn}
                  title="编辑"
                >
                  ✏️
                </button>
                <span className={styles.actionBtnLabel}>编辑</span>
              </div>
              <div className={styles.actionBtnWithLabel}>
                <button
                  onClick={handleGenerateNarrative}
                  disabled={narrativeDisabled}
                  className={`${styles.actionBtn} ${styles.narrativeBtn}`}
                  title={isGenerating ? '生成中' : (narrative || dream.narrative) ? '已生成叙事' : '生成叙事'}
                >
                  {isGenerating ? '⏳' : '✨'}
                </button>
                <span className={styles.actionBtnLabel}>叙事</span>
              </div>
              <div className={styles.actionBtnWithLabel}>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className={`${styles.actionBtn} ${styles.deleteBtn}`}
                  title="删除"
                >
                  🗑️
                </button>
                <span className={styles.actionBtnLabel}>删除</span>
              </div>
            </div>
          </div>
        </section>

        {/* AI Interpretation card */}
        {interpretHtml && (
          <section className={styles.interpretCard}>
            <div className={styles.interpretHeader}>
              <div className={styles.interpretIconContainer}>
                🧠
              </div>
              <h3 className={styles.interpretTitle}>潜意识解读</h3>
            </div>
            <div
              className={styles.interpretContent}
              dangerouslySetInnerHTML={{ __html: interpretHtml }}
            />
          </section>
        )}

        {/* 相关梦境 */}
        {relatedDreams.length > 0 && (
          <div className={styles.relatedSection}>
            <h3 className={styles.relatedTitle}>相关梦境</h3>
            <div className={styles.relatedList}>
              {relatedDreams.map(rd => {
                const rdMeta = EMOTION_META[rd.emotion];
                return (
                  <Link key={rd.id} to={`/dream/${rd.id}`} className={styles.relatedCard}>
                    <span className={styles.relatedEmotion}>{rdMeta.icon}</span>
                    <div className={styles.relatedInfo}>
                      <div className={styles.relatedCardTitle}>{rd.title}</div>
                      <div className={styles.relatedDate}>{rd.recorded_date}</div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="删除梦境"
          message="删除后，这个梦就真的消失了"
          confirmLabel="确认删除"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
