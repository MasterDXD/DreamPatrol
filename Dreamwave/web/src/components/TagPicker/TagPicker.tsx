import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import type { Tag } from '../../types/dream';
import styles from './TagPicker.module.css';

interface TagPickerProps {
  /** 当前选中的标签ID列表 */
  selectedTagIds: string[];
  /** 选中变化回调 */
  onChange: (tagIds: string[]) => void;
}

const PRESET_COLORS = [
  '#7EB8DA', '#F0A050', '#7B6FDE', '#D070E0',
  '#F09070', '#5CB85C', '#FF6B6B', '#4ECDC4',
];

export default function TagPicker({ selectedTagIds, onChange }: TagPickerProps) {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#7EB8DA');
  const [creating, setCreating] = useState(false);

  const loadTags = useCallback(async () => {
    try {
      const data = await api.getTags();
      setAllTags(data.tags);
    } catch {
      // 静默失败
    }
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const toggleTag = (tagId: string) => {
    if (selectedTagIds.includes(tagId)) {
      onChange(selectedTagIds.filter(id => id !== tagId));
    } else {
      onChange([...selectedTagIds, tagId]);
    }
  };

  const handleCreate = async () => {
    if (!newTagName.trim() || creating) return;
    setCreating(true);
    try {
      const data = await api.createTag({ name: newTagName.trim(), color: newTagColor });
      setAllTags(prev => [...prev, data.tag]);
      onChange([...selectedTagIds, data.tag.id]);
      setNewTagName('');
      setShowCreate(false);
    } catch {
      // 创建失败静默处理
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.container}>
      <label className={styles.label}>标签</label>
      <div className={styles.tags}>
        {allTags.map(tag => (
          <button
            key={tag.id}
            className={`${styles.tag} ${selectedTagIds.includes(tag.id) ? styles.selected : ''}`}
            onClick={() => toggleTag(tag.id)}
          >
            <span className={styles.dot} style={{ backgroundColor: tag.color }} />
            <span className={styles.name}>{tag.name}</span>
          </button>
        ))}
        <button
          className={styles.addBtn}
          onClick={() => setShowCreate(!showCreate)}
        >
          + 新标签
        </button>
      </div>

      {showCreate && (
        <div className={styles.createForm}>
          <input
            className={styles.input}
            value={newTagName}
            onChange={e => setNewTagName(e.target.value)}
            placeholder="标签名称"
            maxLength={20}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <div className={styles.colors}>
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                className={`${styles.colorBtn} ${newTagColor === c ? styles.colorActive : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setNewTagColor(c)}
              />
            ))}
          </div>
          <button
            className={styles.confirmBtn}
            onClick={handleCreate}
            disabled={!newTagName.trim() || creating}
          >
            {creating ? '创建中...' : '创建'}
          </button>
        </div>
      )}
    </div>
  );
}
