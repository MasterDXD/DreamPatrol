import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import type { Tag } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import styles from './SearchBar.module.css';

interface SearchBarProps {
  onSearch: (params: { keyword?: string; emotion?: string; tag?: string; favorite?: boolean }) => void;
}

export default function SearchBar({ onSearch }: SearchBarProps) {
  const [keyword, setKeyword] = useState('');
  const [emotion, setEmotion] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [favorite, setFavorite] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const loadTags = useCallback(async () => {
    try {
      const data = await api.getTags();
      setAllTags(data.tags);
    } catch {
      // 静默
    }
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const handleSearch = () => {
    onSearch({
      keyword: keyword.trim() || undefined,
      emotion: emotion || undefined,
      tag: tag || undefined,
      favorite: favorite || undefined,
    });
  };

  const handleReset = () => {
    setKeyword('');
    setEmotion('');
    setTag('');
    setFavorite(false);
    onSearch({});
  };

  const hasFilters = keyword || emotion || tag || favorite;

  return (
    <div className={styles.container}>
      <div className={styles.searchRow}>
        <input
          className={styles.input}
          type="text"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="搜索梦境..."
        />
        <button className={styles.searchBtn} onClick={handleSearch}>搜索</button>
        <button
          className={`${styles.filterBtn} ${showFilters ? styles.filterActive : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          筛选
        </button>
      </div>

      {showFilters && (
        <div className={styles.filters}>
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>情绪</label>
            <div className={styles.emotionFilters}>
              {Object.values(EMOTION_META).map(meta => (
                <button
                  key={meta.value}
                  className={`${styles.emotionBtn} ${emotion === meta.value ? styles.emotionActive : ''}`}
                  onClick={() => setEmotion(emotion === meta.value ? '' : meta.value)}
                  style={{ '--emotion-color': meta.color } as React.CSSProperties}
                >
                  {meta.icon} {meta.label}
                </button>
              ))}
            </div>
          </div>

          {allTags.length > 0 && (
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>标签</label>
              <select
                className={styles.select}
                value={tag}
                onChange={e => setTag(e.target.value)}
              >
                <option value="">全部标签</option>
                {allTags.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className={styles.filterGroup}>
            <label className={styles.filterLabel}>收藏</label>
            <button
              className={`${styles.favoriteBtn} ${favorite ? styles.favoriteActive : ''}`}
              onClick={() => setFavorite(!favorite)}
            >
              {favorite ? '⭐ 仅收藏' : '☆ 全部'}
            </button>
          </div>

          {hasFilters && (
            <button className={styles.resetBtn} onClick={handleReset}>
              清除筛选
            </button>
          )}
        </div>
      )}
    </div>
  );
}
