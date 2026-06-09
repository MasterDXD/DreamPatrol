import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './AmbientMusic.module.css';

/** 梦境氛围音乐列表 */
const DREAM_MUSIC = [
  { src: '/assets/audio/dream-patrol_white-noise_summer-night.mp3', label: '夏夜虫鸣' },
  { src: '/assets/audio/dream-patrol_white-noise_forest-wind.mp3', label: '林间微风' },
  { src: '/assets/audio/dream-patrol_white-noise_rain.mp3', label: '细雨淅沥' },
];

const VISIBILITY_KEY = 'dreamwave_ambient_music_visible';

export default function AmbientMusic() {
  const [playing, setPlaying] = useState(false);
  const [musicIndex, setMusicIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hasInteracted = useRef(false);

  const currentMusic = DREAM_MUSIC[musicIndex];
  const nextMusic = DREAM_MUSIC[(musicIndex + 1) % DREAM_MUSIC.length];

  // 初始化音频
  useEffect(() => {
    const audio = new Audio(currentMusic.src);
    audio.loop = true;
    audio.volume = 0.3;
    audioRef.current = audio;

    if (playing) {
      audio.play().catch(() => {});
    }

    return () => {
      audio.pause();
      audio.src = '';
    };
  // 仅在 musicIndex 变化时重新创建
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicIndex]);

  // 用户首次交互时尝试播放
  useEffect(() => {
    if (playing) return;
    const tryPlay = () => {
      if (audioRef.current && !playing && !hasInteracted.current) {
        hasInteracted.current = true;
        audioRef.current.play().then(() => {
          setPlaying(true);
        }).catch(() => {});
      }
    };
    document.addEventListener('click', tryPlay, { once: true });
    document.addEventListener('touchstart', tryPlay, { once: true });
    return () => {
      document.removeEventListener('click', tryPlay);
      document.removeEventListener('touchstart', tryPlay);
    };
  }, [playing]);

  const togglePlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().then(() => {
        setPlaying(true);
      }).catch(() => {});
    }
  }, [playing]);

  const switchMusic = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setMusicIndex(prev => (prev + 1) % DREAM_MUSIC.length);
  }, []);

  return (
    <div className={styles.controls} aria-label="氛围音乐控制">
      <button
        className={styles.playBtn}
        onClick={togglePlay}
        title={playing ? '暂停音乐' : '播放音乐'}
      >
        <span className={`material-symbols-outlined ${styles.icon}`} style={{ fontVariationSettings: "'FILL' 1" }}>
          {playing ? 'volume_up' : 'volume_off'}
        </span>
      </button>
      <button
        className={styles.switchBtn}
        onClick={switchMusic}
        title={`切换至：${nextMusic.label}`}
      >
        <span className={`material-symbols-outlined ${styles.icon}`} style={{ fontVariationSettings: "'FILL' 0" }}>
          skip_next
        </span>
        <span className={styles.label}>{currentMusic.label}</span>
      </button>
    </div>
  );
}

/** 读取用户设置：是否显示氛围音乐控件 */
export function isAmbientMusicVisible(): boolean {
  const val = localStorage.getItem(VISIBILITY_KEY);
  return val !== 'false'; // 默认显示
}

/** 设置是否显示氛围音乐控件 */
export function setAmbientMusicVisible(visible: boolean) {
  localStorage.setItem(VISIBILITY_KEY, String(visible));
}
