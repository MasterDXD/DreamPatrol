import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './WhiteNoise.module.css';

/** 白噪音配置 */
const NOISE_LIST = [
  {
    id: 'rain',
    name: '雨声',
    icon: '🌧️',
    src: '/assets/audio/dream-patrol_white-noise_rain.mp3',
  },
  {
    id: 'forest-wind',
    name: '林间风声',
    icon: '🍃',
    src: '/assets/audio/dream-patrol_white-noise_forest-wind.mp3',
  },
  {
    id: 'summer-night',
    name: '夏夜虫鸣',
    icon: '🦗',
    src: '/assets/audio/dream-patrol_white-noise_summer-night.mp3',
  },
];

export default function WhiteNoise() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** 播放/暂停切换 */
  const togglePlay = useCallback((noiseId: string) => {
    const noise = NOISE_LIST.find(n => n.id === noiseId);
    if (!noise) return;

    // 如果点击的是当前正在播放的，则暂停
    if (activeId === noiseId && playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }

    // 切换到新音频
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = noise.src;
      audioRef.current.volume = volume;
      audioRef.current.loop = true;
      audioRef.current.play().catch(() => {});
    } else {
      const audio = new Audio(noise.src);
      audio.volume = volume;
      audio.loop = true;
      audio.play().catch(() => {});
      audioRef.current = audio;
    }

    setActiveId(noiseId);
    setPlaying(true);
  }, [activeId, playing, volume]);

  /** 暂停当前播放 */
  const pauseAll = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  /** 音量变化 */
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) {
      audioRef.current.volume = v;
    }
  }, []);

  /** 关闭面板时暂停 */
  const handleClose = useCallback(() => {
    pauseAll();
    setOpen(false);
  }, [pauseAll]);

  /** 组件卸载时清理音频 */
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  const hasActive = activeId !== null && playing;

  return (
    <>
      {/* 浮动按钮 */}
      <button
        className={`${styles.fab} ${hasActive ? styles.fabPlaying : ''}`}
        onClick={() => setOpen(prev => !prev)}
        title="白噪音"
      >
        <i className={hasActive ? 'fa-solid fa-music' : 'fa-solid fa-headphones'} />
      </button>

      {/* 展开面板 */}
      {open && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>白噪音</span>
            <button className={styles.closeBtn} onClick={handleClose}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>

          <div className={styles.noiseList}>
            {NOISE_LIST.map(noise => {
              const isActive = activeId === noise.id && playing;
              return (
                <div
                  key={noise.id}
                  className={`${styles.noiseItem} ${isActive ? styles.noiseItemActive : ''}`}
                  onClick={() => togglePlay(noise.id)}
                >
                  <span className={styles.noiseIcon}>{noise.icon}</span>
                  <div className={styles.noiseInfo}>
                    <div className={styles.noiseName}>{noise.name}</div>
                    <div className={styles.noiseStatus}>
                      {isActive ? '播放中' : '点击播放'}
                    </div>
                  </div>
                  <button
                    className={styles.noisePlayBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePlay(noise.id);
                    }}
                  >
                    <i className={isActive ? 'fa-solid fa-pause' : 'fa-solid fa-play'} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* 音量控制 */}
          <div className={styles.volumeSection}>
            <div className={styles.volumeLabel}>
              <span>音量</span>
              <span>{Math.round(volume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={handleVolumeChange}
              className={styles.volumeSlider}
            />
          </div>
        </div>
      )}
    </>
  );
}
