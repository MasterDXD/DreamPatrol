import type { EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import styles from './EmotionPicker.module.css';

interface EmotionPickerProps {
  value: EmotionType;
  onChange: (emotion: EmotionType) => void;
}

export default function EmotionPicker({ value, onChange }: EmotionPickerProps) {
  return (
    <div className={styles.picker}>
      {Object.values(EMOTION_META).map(meta => (
        <button
          key={meta.value}
          className={`${styles.option} ${value === meta.value ? styles.selected : ''}`}
          onClick={() => onChange(meta.value)}
          style={{ '--emotion-color': meta.color, borderColor: value === meta.value ? meta.color : 'transparent' } as React.CSSProperties}
        >
          <span className={styles.icon}>{meta.icon}</span>
          <span className={styles.label}>{meta.label}</span>
        </button>
      ))}
    </div>
  );
}
