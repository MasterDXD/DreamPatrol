import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import type { Dream, EmotionType } from '../../types/dream';
import EmotionPicker from '../../components/EmotionPicker/EmotionPicker';
import VoiceInput from '../../components/VoiceInput/VoiceInput';
import TagPicker from '../../components/TagPicker/TagPicker';
import EmptyState from '../../components/EmptyState/EmptyState';
import Toast from '../../components/Toast/Toast';
import styles from './EditDreamPage.module.css';

/** 草稿数据结构 */
interface DraftData {
  content: string;
  emotion: EmotionType;
  tagIds: string[];
}

export default function EditDreamPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dream, setDream] = useState<Dream | null>(null);
  const [content, setContent] = useState('');
  const [emotion, setEmotion] = useState<EmotionType>('calm');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);

  /** 草稿 key，依赖 dreamId */
  const draftKey = id ? `dreamwave_draft_edit_${id}` : '';

  /** 保存草稿到 localStorage */
  const saveDraft = useCallback(() => {
    if (!draftKey) return;
    const data: DraftData = { content, emotion, tagIds: selectedTagIds };
    localStorage.setItem(draftKey, JSON.stringify(data));
    setDraftSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  }, [draftKey, content, emotion, selectedTagIds]);

  /** 清除草稿 */
  const clearDraft = useCallback(() => {
    if (!draftKey) return;
    localStorage.removeItem(draftKey);
    setDraftSavedAt(null);
  }, [draftKey]);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getDream(id),
      api.getDreamTags(id),
    ])
      .then(([dreamData, tagData]) => {
        setDream(dreamData.dream);
        const serverContent = dreamData.dream.content;
        const serverEmotion = dreamData.dream.emotion;
        const serverTagIds = tagData.tags.map((t: any) => t.id);

        // 检查是否有草稿
        try {
          const draftKey = `dreamwave_draft_edit_${id}`;
          const raw = localStorage.getItem(draftKey);
          if (raw) {
            const draft: DraftData = JSON.parse(raw);
            if (draft.content?.trim() && draft.content !== serverContent) {
              setToast({
                message: '检测到未保存的草稿，已自动恢复',
                type: 'info',
              });
              setContent(draft.content);
              if (draft.emotion) setEmotion(draft.emotion);
              if (draft.tagIds?.length) setSelectedTagIds(draft.tagIds);
              return;
            }
          }
        } catch {}

        setContent(serverContent);
        setEmotion(serverEmotion);
        setSelectedTagIds(serverTagIds);
      })
      .catch(() => {
        setDream(null);
        setToast({ message: '加载梦境失败', type: 'error' });
      })
      .finally(() => setLoading(false));
  }, [id]);

  /** 自动保存：每5秒 */
  useEffect(() => {
    if (!content.trim() || !draftKey) return;
    const timer = setInterval(saveDraft, 5000);
    return () => clearInterval(timer);
  }, [content, draftKey, saveDraft]);

  /** 内容变化时延迟1秒保存（防抖） */
  useEffect(() => {
    if (!content.trim() || !draftKey) return;
    const timer = setTimeout(saveDraft, 1000);
    return () => clearTimeout(timer);
  }, [content, emotion, selectedTagIds, draftKey, saveDraft]);

  if (loading) return <div className={styles.loading}>加载中...</div>;
  if (!dream) return <EmptyState message="找不到这个梦" actionLabel="返回首页" onAction={() => navigate('/')} />;

  const handleSubmit = async () => {
    if (!content.trim()) return;
    setIsSubmitting(true);
    try {
      await api.updateDream(dream!.id, { content: content.trim(), emotion });
      clearDraft();
      // 更新标签：先获取当前标签，再同步
      try {
        const currentTags = await api.getDreamTags(dream!.id);
        const currentIds = currentTags.tags.map((t: any) => t.id);
        // 移除不再选中的
        for (const oldId of currentIds) {
          if (!selectedTagIds.includes(oldId)) {
            await api.removeDreamTag(dream!.id, oldId);
          }
        }
        // 添加新选中的
        const newIds = selectedTagIds.filter(id => !currentIds.includes(id));
        if (newIds.length > 0) {
          await api.addDreamTags(dream!.id, newIds);
        }
      } catch {}
      navigate(`/dream/${dream!.id}`);
    } catch (err: any) {
      setToast({ message: err.message || '保存失败', type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVoiceTranscript = (text: string) => {
    setContent(prev => {
      const separator = prev.trim() ? ' ' : '';
      return prev + separator + text;
    });
  };

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>编辑梦境</h2>

      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={8} maxLength={5000}
        className={styles.textarea}
      />
      <div className={styles.charCount}>
        {content.length}/5000
        {draftSavedAt && <span className={styles.draftSaved}> · 已自动保存 {draftSavedAt}</span>}
      </div>

      <div className={styles.voiceInputWrap}>
        <VoiceInput onTranscript={handleVoiceTranscript} />
      </div>

      <div className={styles.emotionSection}>
        <label className={styles.emotionLabel}>这个梦的情绪是…</label>
        <EmotionPicker value={emotion} onChange={setEmotion} />
      </div>

      <TagPicker selectedTagIds={selectedTagIds} onChange={setSelectedTagIds} />

      <button
        onClick={handleSubmit}
        disabled={isSubmitting || !content.trim()}
        className={styles.submitBtn}
      >
        {isSubmitting ? '保存中...' : '保存修改'}
      </button>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
