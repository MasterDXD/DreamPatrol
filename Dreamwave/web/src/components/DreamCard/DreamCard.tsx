import { useNavigate } from 'react-router-dom';
import type { Dream, EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import styles from './DreamCard.module.css';

interface DreamCardProps {
  dream: Dream;
  /** 是否匹配日历单元格高度（紧凑模式） */
  compact?: boolean;
  /** 自定义点击跳转 */
  onClick?: (dream: Dream) => void;
}

function formatDreamTime(createdAt: string): string {
  try {
    const d = new Date(createdAt);
    const h = d.getHours();
    const min = String(d.getMinutes()).padStart(2, '0');
    if (h >= 0 && h < 5) return `凌晨 ${String(h).padStart(2, '0')}:${min}`;
    if (h >= 5 && h < 8) return `清晨 ${String(h).padStart(2, '0')}:${min}`;
    if (h >= 8 && h < 12) return `上午 ${String(h).padStart(2, '0')}:${min}`;
    if (h >= 12 && h < 14) return `中午 ${String(h).padStart(2, '0')}:${min}`;
    if (h >= 14 && h < 18) return `下午 ${String(h).padStart(2, '0')}:${min}`;
    if (h >= 18 && h < 21) return `傍晚 ${String(h).padStart(2, '0')}:${min}`;
    return `夜晚 ${String(h).padStart(2, '0')}:${min}`;
  } catch {
    return '';
  }
}

export default function DreamCard({ dream, compact = false, onClick }: DreamCardProps) {
  const navigate = useNavigate();
  const meta = EMOTION_META[dream.emotion as EmotionType];

  const handleClick = () => {
    if (onClick) {
      onClick(dream);
    } else {
      navigate(`/dream/${dream.id}`);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`${styles.glassPanelLight} ${styles.dreamCard} ${compact ? styles.compact : ''}`}
    >
      <div className={styles.dreamCardTop}>
        <div className={styles.dreamCardLeft}>
          <div
            className={styles.emotionIconCircle}
            style={{
              background: meta ? `${meta.color}20` : 'transparent',
              border: meta ? `1px solid ${meta.color}50` : '1px solid transparent',
            }}
          >
            {meta?.icon}
          </div>
          <span className={styles.dreamCardTime}>{formatDreamTime(dream.created_at)}</span>
        </div>
      </div>
      <h3 className={styles.dreamCardTitle}>{dream.title}</h3>
      <p className={styles.dreamCardPreview}>{dream.content}</p>
      <div className={styles.dreamCardTags}>
        <span className={styles.emotionTag}>{meta?.label}</span>
      </div>
    </div>
  );
}
