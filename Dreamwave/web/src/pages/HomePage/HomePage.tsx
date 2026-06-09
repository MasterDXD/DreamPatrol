import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import type { Dream, EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import DreamCard from '../../components/DreamCard/DreamCard';
import DreamCardSkeleton from '../../components/Skeleton/Skeleton';
import EmptyState from '../../components/EmptyState/EmptyState';
import SearchBar from '../../components/SearchBar/SearchBar';
import Toast from '../../components/Toast/Toast';
import styles from './HomePage.module.css';

/** 快速输入区展示的4种情绪 */
const QUICK_EMOTIONS: EmotionType[] = ['joy', 'calm', 'sadness', 'wonder'];

/** 根据当前时间返回问候语 */
function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return '早上好';
  if (hour >= 12 && hour < 18) return '下午好';
  return '晚上好';
}

/** 时间分组类型 */
type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

const GROUP_LABELS: Record<TimeGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  earlier: '更早',
};

const GROUP_ORDER: TimeGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier'];

/** 判断梦境属于哪个时间分组 */
function getTimeGroup(dateStr: string): TimeGroup {
  const dreamDate = new Date(dateStr);
  const now = new Date();

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekStart = new Date(today.getTime() - today.getDay() * 86400000);

  const dreamDay = new Date(dreamDate.getFullYear(), dreamDate.getMonth(), dreamDate.getDate());

  if (dreamDay.getTime() === today.getTime()) return 'today';
  if (dreamDay.getTime() === yesterday.getTime()) return 'yesterday';
  if (dreamDay >= weekStart) return 'thisWeek';
  return 'earlier';
}

/** 按时间分组梦境 */
function groupDreamsByTime(dreams: Dream[]): Record<TimeGroup, Dream[]> {
  const groups: Record<TimeGroup, Dream[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const dream of dreams) {
    const group = getTimeGroup(dream.recorded_date || dream.created_at);
    groups[group].push(dream);
  }
  return groups;
}

export default function HomePage() {
  const navigate = useNavigate();
  const isDreamsPage = window.location.pathname === '/dreams';
  const [dreams, setDreams] = useState<Dream[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [emotionFilter, setEmotionFilter] = useState<string>('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [quickEmotion, setQuickEmotion] = useState<EmotionType | ''>('');
  const [quickText, setQuickText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  /** 初始化 Web Speech API */
  const getSpeechRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    return new SpeechRecognition();
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const recognition = getSpeechRecognition();
    if (!recognition) {
      setToast({ message: '当前浏览器不支持语音识别', type: 'error' });
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }
      if (finalTranscript) {
        setQuickText(prev => prev + finalTranscript);
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening, getSpeechRecognition]);

  const loadDreams = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDreams({ limit: 50, emotion: emotionFilter || undefined });
      setDreams(data.dreams);
    } catch (err: any) {
      setToast({ message: err.message || '加载梦境失败', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [emotionFilter]);

  const handleSearch = useCallback(async (params: { keyword?: string; emotion?: string; tag?: string; favorite?: boolean }) => {
    const hasSearch = params.keyword || params.emotion || params.tag || params.favorite;
    setIsSearchMode(!!hasSearch);

    if (!hasSearch) {
      loadDreams();
      return;
    }

    setLoading(true);
    try {
      const data = await api.searchDreams({
        ...params,
        limit: 50,
      });
      setDreams(data.dreams);
    } catch (err: any) {
      setToast({ message: err.message || '搜索失败', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [loadDreams]);

  useEffect(() => {
    if (!isSearchMode) {
      loadDreams();
    }
  }, [loadDreams, isSearchMode]);

  useEffect(() => {
    const onFocus = () => {
      if (!isSearchMode) loadDreams();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadDreams, isSearchMode]);

  const toggleEmotionFilter = (emotion: string) => {
    setEmotionFilter(prev => prev === emotion ? '' : emotion);
    setIsSearchMode(false);
  };

  useEffect(() => {
    if (!isSearchMode) {
      loadDreams();
    }
  }, [emotionFilter]);

  /** 快速提交：跳转到 /new 页面并预填情绪 */
  const handleQuickSubmit = () => {
    const params = new URLSearchParams();
    if (quickEmotion) params.set('emotion', quickEmotion);
    navigate(`/new?${params.toString()}`);
  };

  /** 时间分组后的梦境 */
  const groupedDreams = useMemo(() => groupDreamsByTime(dreams), [dreams]);

  const greeting = useMemo(getGreeting, []);

  if (loading && dreams.length === 0) {
    return <div className={styles.container}><DreamCardSkeleton count={3} /></div>;
  }

  if (dreams.length === 0 && !isSearchMode && !emotionFilter) {
    return (
      <>
        <EmptyState
          message="还没有梦被留下"
          actionLabel="记录你的第一个梦"
          onAction={() => navigate('/new')}
        />
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </>
    );
  }

  return (
    <div className={styles.container}>
      {/* 装饰模糊圆 */}
      <div className={styles.blurCircle1} />
      <div className={styles.blurCircle2} />
      <div className={styles.blurCircle3} />

      {/* 我的梦境页面标题 */}
      {isDreamsPage && (
        <div className={styles.welcomeSection}>
          <h1 className={styles.greeting}>我的梦境</h1>
          <p className={styles.welcomeSub}>浏览和管理你的所有梦境记录</p>
        </div>
      )}

      {/* 欢迎区 - 仅首页显示 */}
      {!isDreamsPage && (
        <div className={styles.welcomeSection}>
          <h1 className={styles.greeting}>{greeting}，星语者</h1>
          <p className={styles.welcomeSub}>每一场梦，都值得被温柔记录</p>
        </div>
      )}

      {/* Bento 快速输入区 - 仅首页显示 */}
      {!isDreamsPage && (
        <div className={styles.bentoPanel}>
          <div className={styles.bentoGrid}>
            {/* 左侧：情绪快选 */}
            <div className={styles.emotionQuickSelect}>
              <span className={styles.bentoLabel}>此刻的心情</span>
              <div className={styles.emotionGrid}>
                {QUICK_EMOTIONS.map(key => {
                  const meta = EMOTION_META[key];
                  const isSelected = quickEmotion === key;
                  return (
                    <button
                      key={key}
                      className={`${styles.emotionQuickBtn} ${isSelected ? styles.emotionQuickBtnActive : ''}`}
                      onClick={() => setQuickEmotion(prev => prev === key ? '' : key)}
                      style={{ '--eq-color': meta.color } as React.CSSProperties}
                    >
                      <span className={styles.emotionQuickIcon}>{meta.icon}</span>
                      <span className={styles.emotionQuickLabel}>{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 右侧：快速文本输入 */}
            <div className={styles.quickInputArea}>
              <span className={styles.bentoLabel}>快速记梦</span>
              <div className={styles.quickInputWrap}>
                <div className={styles.quickInputRow}>
                  <input
                    type="text"
                    className={styles.quickInput}
                    placeholder="梦见了什么…"
                    value={quickText}
                    onChange={e => setQuickText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleQuickSubmit(); }}
                  />
                  <button
                    className={`${styles.voiceToggleBtn} ${isListening ? styles.voiceToggleBtnActive : ''}`}
                    onClick={toggleListening}
                    title={isListening ? '停止语音输入' : '语音输入'}
                  >
                    {isListening ? '⏹' : '🎤'}
                  </button>
                </div>
                <button className={styles.quickSubmitBtn} onClick={handleQuickSubmit}>
                  记录
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 头部信息栏 */}
      <div className={styles.header}>
        <span className={styles.count}>
          {isSearchMode ? `搜索结果：${dreams.length} 个梦` : `共 ${dreams.length} 个梦`}
        </span>
        <button onClick={() => { setIsSearchMode(false); setEmotionFilter(''); loadDreams(); }} className={styles.refreshBtn}>刷新</button>
      </div>

      <SearchBar onSearch={handleSearch} />

      <div className={styles.emotionFilter}>
        {Object.values(EMOTION_META).map(meta => (
          <button
            key={meta.value}
            className={`${styles.emotionTag} ${emotionFilter === meta.value ? styles.emotionTagActive : ''}`}
            onClick={() => toggleEmotionFilter(meta.value)}
            style={{ '--tag-color': meta.color } as React.CSSProperties}
          >
            {meta.icon} {meta.label}
          </button>
        ))}
      </div>

      {/* 梦境列表 - 时间分组 */}
      {dreams.length === 0 ? (
        <div className={styles.noResults}>没有找到匹配的梦境</div>
      ) : isSearchMode ? (
        dreams.map(dream => (
          <DreamCard key={dream.id} dream={dream} onFavoriteToggle={loadDreams} />
        ))
      ) : (
        GROUP_ORDER.map(group => {
          const groupDreams = groupedDreams[group];
          if (groupDreams.length === 0) return null;
          return (
            <div key={group} className={styles.timeGroup}>
              <h2 className={styles.groupHeader}>{GROUP_LABELS[group]}</h2>
              <div className={styles.groupList}>
                {groupDreams.map(dream => (
                  <DreamCard key={dream.id} dream={dream} onFavoriteToggle={loadDreams} />
                ))}
              </div>
            </div>
          );
        })
      )}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
