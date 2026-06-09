import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import type { EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import EmotionPicker from '../../components/EmotionPicker/EmotionPicker';
import VoiceInput from '../../components/VoiceInput/VoiceInput';
import TagPicker from '../../components/TagPicker/TagPicker';
import Toast from '../../components/Toast/Toast';
import { guessEmotion } from '../../constants/emotions';
import { renderMarkdown } from '../../utils/renderMarkdown';
import {
  hasApiKey,
  submitImageGeneration,
  pollImageTask,
  interpretDream,
  saveImageArchive,
  saveInterpretArchive,
} from '../../services/dimilinks';
import styles from './NewDreamPage.module.css';

/** 草稿存储 key */
const DRAFT_KEY = 'dreamwave_draft_new';

/** 草稿数据结构 */
interface DraftData {
  content: string;
  emotion: EmotionType;
  tagIds: string[];
}

export default function NewDreamPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillEmotion = searchParams.get('emotion') as EmotionType | null;
  const [content, setContent] = useState('');
  const [emotion, setEmotion] = useState<EmotionType>(
    prefillEmotion && EMOTION_META[prefillEmotion] ? prefillEmotion : 'calm'
  );
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);

  // 开关
  const [enableImage, setEnableImage] = useState(true);
  const [enableInterpret, setEnableInterpret] = useState(true);

  // 生成结果
  const [imgUrl, setImgUrl] = useState('');
  const [imgStatus, setImgStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [imgProgress, setImgProgress] = useState(0);
  const [imgError, setImgError] = useState('');

  const [interpHtml, setInterpHtml] = useState('');
  const [interpStatus, setInterpStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [interpError, setInterpError] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /** 保存草稿到 localStorage */
  const saveDraft = useCallback(() => {
    const data: DraftData = { content, emotion, tagIds: selectedTagIds };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    setDraftSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  }, [content, emotion, selectedTagIds]);

  /** 清除草稿 */
  const clearDraft = useCallback(() => {
    localStorage.removeItem(DRAFT_KEY);
    setDraftSavedAt(null);
  }, []);

  /** 页面加载时检查草稿 */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft: DraftData = JSON.parse(raw);
        if (draft.content?.trim()) {
          setToast({
            message: '检测到未完成的草稿，已自动恢复',
            type: 'info',
          });
          setContent(draft.content);
          if (draft.emotion) setEmotion(draft.emotion);
          if (draft.tagIds?.length) setSelectedTagIds(draft.tagIds);
        }
      }
    } catch {}
  }, []);

  /** 自动保存：每5秒或内容变化时保存 */
  useEffect(() => {
    if (!content.trim()) return;
    const timer = setInterval(saveDraft, 5000);
    return () => clearInterval(timer);
  }, [content, saveDraft]);

  /** 内容变化时延迟1秒保存（防抖） */
  useEffect(() => {
    if (!content.trim()) return;
    const timer = setTimeout(saveDraft, 1000);
    return () => clearTimeout(timer);
  }, [content, emotion, selectedTagIds, saveDraft]);

  const startImageGeneration = async (dreamId: string, prompt: string) => {
    if (!hasApiKey()) {
      setImgError('请先在设置中配置 API Key');
      setImgStatus('error');
      return;
    }
    setImgStatus('loading');
    setImgProgress(0);
    try {
      const result = await submitImageGeneration(prompt);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const task = await pollImageTask(result.taskId);
          setImgProgress(task.progress);
          if (task.status === 'succeeded') {
            if (pollRef.current) clearInterval(pollRef.current);
            const url = task.images[0]?.url || '';
            setImgUrl(url);
            setImgStatus('done');
            saveImageArchive(dreamId, task.images);
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
  };

  const startInterpretation = async (dreamId: string, text: string) => {
    if (!hasApiKey()) {
      setInterpError('请先在设置中配置 API Key');
      setInterpStatus('error');
      return;
    }
    setInterpStatus('loading');
    try {
      const result = await interpretDream(text);
      setInterpHtml(renderMarkdown(result.text));
      setInterpStatus('done');
      saveInterpretArchive(dreamId, result.text);
    } catch (err: any) {
      setInterpError(err.message || '解读失败');
      setInterpStatus('error');
    }
  };

  const handleSubmit = async () => {
    if (!content.trim()) {
      setToast({ message: '梦还空着呢，写点什么吧', type: 'error' });
      return;
    }
    setIsSubmitting(true);
    try {
      const data = await api.createDream({ content: content.trim(), emotion });
      const dreamId = data.dream.id;

      // 创建梦境后添加标签
      if (selectedTagIds.length > 0) {
        try { await api.addDreamTags(dreamId, selectedTagIds); } catch {}
      }

      // 根据开关自动调用
      if (enableImage) {
        startImageGeneration(dreamId, content.trim());
      }
      if (enableInterpret) {
        startInterpretation(dreamId, content.trim());
      }

      setToast({ message: '梦已安放', type: 'success' });
      clearDraft();

      // 如果没有开启任何自动功能，直接跳转
      if (!enableImage && !enableInterpret) {
        setTimeout(() => navigate('/'), 1000);
      }
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
    const guessed = guessEmotion(text);
    if (guessed) setEmotion(guessed);
  };

  const allDone = (imgStatus === 'done' || !enableImage) && (interpStatus === 'done' || !enableInterpret);

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>记录你的梦</h2>

      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="昨晚，你梦见了什么…"
        autoFocus rows={5} maxLength={5000}
        className={styles.textarea}
      />
      <div className={styles.charCount}>
        {content.length}/5000
        {content.length > 4500 && <span className={styles.nearLimit}> 快要写满了呢</span>}
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

      {/* AI 功能开关 */}
      <div className={styles.aiSwitchSection}>
        <div className={styles.aiSwitchRow}>
          <div className={styles.aiSwitchInfo}>
            <span className={styles.aiSwitchIcon}>🎨</span>
            <div>
              <div className={styles.aiSwitchLabel}>绘梦生影</div>
              <div className={styles.aiSwitchDesc}>AI 生成梦境画面，支持多种风格</div>
            </div>
          </div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={enableImage} onChange={e => setEnableImage(e.target.checked)} />
            <div className={styles.toggleSlider} />
          </label>
        </div>
        <div className={styles.aiSwitchRow}>
          <div className={styles.aiSwitchInfo}>
            <span className={styles.aiSwitchIcon}>🔮</span>
            <div>
              <div className={styles.aiSwitchLabel}>溯梦心语</div>
              <div className={styles.aiSwitchDesc}>心理学视角解读象征与情绪</div>
            </div>
          </div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={enableInterpret} onChange={e => setEnableInterpret(e.target.checked)} />
            <div className={styles.toggleSlider} />
          </label>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={isSubmitting || !content.trim()}
        className={styles.submitBtn}
      >
        {isSubmitting ? '正在安放这个梦...' : '留下这个梦'}
      </button>

      {/* 生成结果展示 */}
      {(imgStatus !== 'idle' || interpStatus !== 'idle') && (
        <div className={styles.resultSection}>
          {/* 生图结果 */}
          {enableImage && imgStatus === 'loading' && (
            <div className={styles.resultCard}>
              <div className={styles.resultCardHeader}>
                <span>🎨 绘梦生影</span>
                <span className={styles.resultLoading}>生成中 {imgProgress}%</span>
              </div>
              <div className={styles.miniProgress}>
                <div className={styles.miniProgressFill} style={{ width: `${imgProgress}%` }} />
              </div>
            </div>
          )}
          {enableImage && imgStatus === 'done' && imgUrl && (
            <div className={styles.resultCard}>
              <div className={styles.resultCardHeader}>
                <span>🎨 绘梦生影</span>
                <span className={styles.resultDone}>完成</span>
              </div>
              <div className={styles.resultImage}>
                <img src={imgUrl} alt="梦境生图" />
              </div>
            </div>
          )}
          {enableImage && imgStatus === 'error' && (
            <div className={styles.resultCard}>
              <div className={styles.resultCardHeader}>
                <span>🎨 绘梦生影</span>
                <span className={styles.resultError}>失败</span>
              </div>
              <p className={styles.resultErrorText}>{imgError}</p>
            </div>
          )}

          {/* 解读结果 */}
          {enableInterpret && interpStatus === 'loading' && (
            <div className={styles.resultCard}>
              <div className={styles.resultCardHeader}>
                <span>🔮 溯梦心语</span>
                <span className={styles.resultLoading}>解读中...</span>
              </div>
            </div>
          )}
          {enableInterpret && interpStatus === 'done' && interpHtml && (
            <div className={styles.resultCard}>
              <div className={styles.resultCardHeader}>
                <span>🔮 溯梦心语</span>
                <span className={styles.resultDone}>完成</span>
              </div>
              <div
                className={styles.resultInterpret}
                dangerouslySetInnerHTML={{ __html: interpHtml }}
              />
            </div>
          )}
          {enableInterpret && interpStatus === 'error' && (
            <div className={styles.resultCard}>
              <div className={styles.resultCardHeader}>
                <span>🔮 溯梦心语</span>
                <span className={styles.resultError}>失败</span>
              </div>
              <p className={styles.resultErrorText}>{interpError}</p>
            </div>
          )}

          {/* 全部完成后显示返回按钮 */}
          {allDone && (
            <button className={styles.backBtn} onClick={() => navigate('/')}>
              返回梦境列表
            </button>
          )}
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
