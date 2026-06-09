import { useNavigate } from 'react-router-dom';
import type { Dream, EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import styles from './DreamCard.module.css';

interface DreamCardProps {
  dream: Dream;
  compact?: boolean;
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
  } catch (_e) {
    return '';
  }
}

function formatDreamDate(createdAt: string): string {
  try {
    const d = new Date(createdAt);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch (_e) {
    return '';
  }
}

function truncateTitle(title: string | undefined, maxLength: number = 15): string {
  if (!title) return '';
  if (title.length <= maxLength) return title;
  return title.substring(0, maxLength) + '......';
}

export default function DreamCard({ dream, compact = false, onClick }: DreamCardProps) {
  const navigate = useNavigate();
  const meta = EMOTION_META[dream.emotion as EmotionType];
  const hasImage = !!dream.image_url;

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
      {hasImage && (
        <div className={styles.dreamCardImageContainer}>
          <img
            src={dream.image_url ?? undefined}
            alt={dream.title}
            className={styles.dreamCardImage}
            loading="lazy"
          />
          <div className={styles.dreamCardDateBadge}>{formatDreamDate(dream.created_at)}</div>
        </div>
      )}
      <div className={styles.dreamCardContent}>
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
        {truncateTitle(dream.title) && (
          <h3 className={styles.dreamCardTitle}>{truncateTitle(dream.title)}</h3>
        )}
        {dream.content && (
          <p className={styles.dreamCardPreview}>{dream.content}</p>
        )}
        
        {compact && (
          <>
            {(dream.image_url || !dream.image_url) && (
              <div className={styles.dreamCardMedia}>
                {dream.image_url ? (
                  <img
                    src={dream.image_url}
                    alt="梦境图像"
                    className={styles.dreamCardMediaImage}
                    loading="lazy"
                  />
                ) : (
                  <div className={styles.dreamCardMediaPlaceholder}>
                    <i className="fa-solid fa-image" style={{ fontSize: 24, opacity: 0.4 }}></i>
                    <span>暂无梦境图像</span>
                  </div>
                )}
              </div>
            )}
            
            {(dream.narrative || !dream.narrative) && (
              <div className={styles.dreamCardAnalysis}>
                <div className={styles.dreamCardAnalysisHeader}>
                  <i className="fa-solid fa-magnifying-glass"></i>
                  <span>梦境解析</span>
                </div>
                {dream.narrative ? (
                  <p className={styles.dreamCardAnalysisContent}>{dream.narrative}</p>
                ) : (
                  <div className={styles.dreamCardAnalysisPlaceholder}>
                    <span>暂无解析内容</span>
                    <p className={styles.dreamCardAnalysisHint}>点击卡片查看完整梦境</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        
        <div className={styles.dreamCardTags}>
          <span className={styles.emotionTag}>{meta?.label}</span>
        </div>
      </div>
    </div>
  );
}