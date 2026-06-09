import { useEffect } from 'react';
import type { EmotionType } from '../types/dream';
import { EMOTION_META } from '../constants/emotions';

/**
 * 情绪主题Hook
 * 接收emotion参数，在容器元素上设置CSS变量 --emotion-color 和 --emotion-bg
 */
export function useEmotionTheme(emotion: EmotionType | null, containerRef?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!emotion) return;

    const meta = EMOTION_META[emotion];
    const target = containerRef?.current || document.documentElement;

    target.style.setProperty('--emotion-color', meta.color);
    target.style.setProperty('--emotion-bg', meta.bgGradient);

    // 如果没有指定容器，在documentElement上设置，组件卸载时清除
    if (!containerRef?.current) {
      return () => {
        target.style.removeProperty('--emotion-color');
        target.style.removeProperty('--emotion-bg');
      };
    }
  }, [emotion, containerRef]);
}
