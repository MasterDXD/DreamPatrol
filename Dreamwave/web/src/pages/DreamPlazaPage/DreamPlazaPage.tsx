import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import type { Dream, EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import { loadImageArchive } from '../../services/dimilinks';
import styles from './DreamPlazaPage.module.css';

/** 筛选标签定义 */
interface FilterTag {
  key: string;
  label: string;
  emotion?: EmotionType;
}

const FILTER_TAGS: FilterTag[] = [
  { key: 'all', label: '推荐' },
  { key: 'latest', label: '最新' },
  { key: 'joy', label: '喜悦', emotion: 'joy' },
  { key: 'wonder', label: '奇妙', emotion: 'wonder' },
  { key: 'nostalgia', label: '怀念', emotion: 'nostalgia' },
  { key: 'calm', label: '平静', emotion: 'calm' },
  { key: 'sadness', label: '悲伤', emotion: 'sadness' },
  { key: 'fear', label: '恐惧', emotion: 'fear' },
];

/** 梦境卡片类型：有图 / 纯文本 */
type CardVariant = 'image' | 'text';

function getCardVariant(dream: Dream, index: number): CardVariant {
  // 有 image_url 的用图片卡片
  if (dream.image_url) return 'image';
  // 检查本地缓存
  const archive = loadImageArchive(dream.id);
  if (archive?.images?.length) return 'image';
  // 交替分配，让布局更丰富
  return index % 3 === 0 ? 'image' : 'text';
}

function getThumbUrl(dream: Dream): string | null {
  if (dream.image_url) return dream.image_url;
  const archive = loadImageArchive(dream.id);
  return archive?.images?.[0]?.url ?? null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export default function DreamPlazaPage() {
  const navigate = useNavigate();
  const [dreams, setDreams] = useState<Dream[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [likedIds, setLikedIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('dreamwave_plaza_likes');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  // 保存点赞状态到 localStorage
  useEffect(() => {
    localStorage.setItem('dreamwave_plaza_likes', JSON.stringify([...likedIds]));
  }, [likedIds]);

  // 加载梦境
  const loadDreams = useCallback(async () => {
    setLoading(true);
    try {
      const emotion = FILTER_TAGS.find(t => t.key === activeFilter)?.emotion;
      if (searchText.trim()) {
        const data = await api.searchDreams({
          keyword: searchText.trim(),
          emotion: emotion,
          limit: 30,
        });
        setDreams(data.dreams);
      } else if (activeFilter === 'latest') {
        const data = await api.getDreams({ limit: 30 });
        // 按创建时间倒序（默认已是）
        setDreams(data.dreams);
      } else if (emotion) {
        const data = await api.getDreams({ emotion, limit: 30 });
        setDreams(data.dreams);
      } else {
        // 推荐：获取全部（后续可按算法排序）
        const data = await api.getDreams({ limit: 30 });
        setDreams(data.dreams);
      }
    } catch {
      setDreams([]);
    } finally {
      setLoading(false);
    }
  }, [activeFilter, searchText]);

  useEffect(() => {
    loadDreams();
  }, [loadDreams]);

  // 搜索防抖
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    if (debouncedSearch !== searchText) return;
    // debouncedSearch 变化时触发搜索
  }, [debouncedSearch, searchText]);

  const toggleLike = useCallback((dreamId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLikedIds(prev => {
      const next = new Set(prev);
      if (next.has(dreamId)) next.delete(dreamId);
      else next.add(dreamId);
      return next;
    });
  }, []);

  const handleCardClick = useCallback((dreamId: string) => {
    navigate(`/dream/${dreamId}/roaming`);
  }, [navigate]);

  // 模拟点赞数（基于 dream.id 的 hash，保证稳定）
  const getLikeCount = useMemo(() => {
    const cache = new Map<string, number>();
    return (id: string) => {
      if (cache.has(id)) return cache.get(id)!;
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
      }
      const count = Math.abs(hash) % 500 + 10;
      cache.set(id, count);
      return count;
    };
  }, []);

  if (loading && dreams.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.skeleton}>
          {[1, 2, 3].map(i => (
            <div key={i} className={styles.skeletonCard}>
              {i !== 2 && <div className={styles.skeletonImage} />}
              <div className={styles.skeletonBody}>
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLine} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* 页面标题区 */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>梦境广场</h1>
          <span className={styles.subtitle}>共鸣</span>
        </div>
        <div className={styles.searchBar}>
          <span className={`material-symbols-outlined ${styles.searchIcon}`}>search</span>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="搜索梦境片段、标签..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
        </div>
      </div>

      {/* 筛选标签栏 */}
      <div className={styles.filterBar}>
        {FILTER_TAGS.map(tag => (
          <button
            key={tag.key}
            className={`${styles.filterBtn} ${activeFilter === tag.key ? styles.filterBtnActive : ''}`}
            onClick={() => setActiveFilter(tag.key)}
          >
            {tag.label}
          </button>
        ))}
        <div className={styles.filterDivider} />
        <button className={styles.filterBtn}>
          <span className={`${styles.filterBtnWithIcon} ${styles.filterBtnIcon}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>tune</span>
            筛选
          </span>
        </button>
      </div>

      {/* 瀑布流内容 */}
      {dreams.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🌙</div>
          <div className={styles.emptyText}>还没有梦境被分享</div>
          <div className={styles.emptyHint}>记录你的第一个梦，让它在广场上闪耀</div>
        </div>
      ) : (
        <div className={styles.masonryGrid}>
          {dreams.map((dream, index) => {
            const meta = EMOTION_META[dream.emotion as EmotionType];
            const variant = getCardVariant(dream, index);
            const thumbUrl = getThumbUrl(dream);
            const isLiked = likedIds.has(dream.id);
            const likeCount = getLikeCount(dream.id) + (isLiked ? 1 : 0);
            const isLargeImage = index % 4 === 0;

            if (variant === 'image' && thumbUrl) {
              return (
                <article
                  key={dream.id}
                  className={styles.card}
                  onClick={() => handleCardClick(dream.id)}
                >
                  <div className={`${styles.cardImageWrap} ${isLargeImage ? styles.cardImageWrapLg : styles.cardImageWrapMd}`}>
                    <img
                      src={thumbUrl}
                      alt={dream.title}
                      className={styles.cardImage}
                      loading="lazy"
                    />
                    <div className={styles.cardImageOverlay} />
                    <div className={styles.cardImageTags}>
                      <span className={styles.cardImageTag}>{meta?.icon} {meta?.label}</span>
                    </div>
                  </div>
                  <div className={styles.cardBody}>
                    <h3 className={styles.cardTitle}>{dream.title}</h3>
                    <p className={styles.cardText}>{dream.content}</p>
                    <div className={styles.cardFooter}>
                      <div className={styles.cardAuthor}>
                        <div className={styles.cardAvatarFallback}>
                          {(dream.title || '梦')[0]}
                        </div>
                        <span className={styles.cardAuthorName}>织梦者</span>
                      </div>
                      <div className={styles.cardActions}>
                        <button
                          className={`${styles.cardAction} ${isLiked ? styles.cardActionLiked : ''}`}
                          onClick={e => toggleLike(dream.id, e)}
                        >
                          <span className={`material-symbols-outlined ${styles.cardActionIcon}`} style={isLiked ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                            favorite
                          </span>
                          <span>{likeCount}</span>
                        </button>
                        <button className={styles.cardAction} onClick={e => { e.stopPropagation(); handleCardClick(dream.id); }}>
                          <span className={`material-symbols-outlined ${styles.cardActionIcon}`}>chat_bubble</span>
                          <span>{Math.abs(dream.id.charCodeAt(0)) % 30}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            }

            // 纯文本卡片
            return (
              <article
                key={dream.id}
                className={`${styles.card} ${styles.cardTextOnly}`}
                onClick={() => handleCardClick(dream.id)}
              >
                <div className={styles.cardBody}>
                  <div className={styles.cardTextOnlyTags}>
                    <span className={styles.cardTextOnlyTag}>{meta?.icon} {meta?.label}</span>
                  </div>
                  <h3 className={styles.cardTitle}>{dream.title}</h3>
                  <p className={styles.cardText}>{truncate(dream.content, 120)}</p>
                  <div className={styles.cardFooter}>
                    <div className={styles.cardAuthor}>
                      <div className={styles.cardAvatarFallback}>
                        {(dream.title || '梦')[0]}
                      </div>
                      <span className={styles.cardAuthorName}>织梦者</span>
                    </div>
                    <div className={styles.cardActions}>
                      <button
                        className={`${styles.cardAction} ${isLiked ? styles.cardActionLiked : ''}`}
                        onClick={e => toggleLike(dream.id, e)}
                      >
                        <span className={`material-symbols-outlined ${styles.cardActionIcon}`} style={isLiked ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                          favorite
                        </span>
                        <span>{likeCount}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 加载更多 */}
      {dreams.length > 0 && (
        <div className={styles.loadMore}>
          <button className={styles.loadMoreBtn} onClick={loadDreams}>
            <span className={`material-symbols-outlined ${styles.loadMoreIcon}`}>sync</span>
            探索更深层
          </button>
        </div>
      )}
    </div>
  );
}
