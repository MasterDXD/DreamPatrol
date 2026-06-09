import type { EmotionMetaMap, EmotionType } from '../types/dream';

export const EMOTION_META: EmotionMetaMap = {
  joy: {
    value: 'joy',
    label: '喜悦',
    icon: '☀️',
    color: '#F0A050',
    bgGradient: 'linear-gradient(135deg, #FFF5E6 0%, #FFE0B2 50%, #FFCC80 100%)',
  },
  calm: {
    value: 'calm',
    label: '平静',
    icon: '🌙',
    color: '#7EB8DA',
    bgGradient: 'linear-gradient(135deg, #E8F4FD 0%, #BBDEFB 50%, #90CAF9 100%)',
  },
  sadness: {
    value: 'sadness',
    label: '悲伤',
    icon: '🌧️',
    color: '#7B6FDE',
    bgGradient: 'linear-gradient(135deg, #EDE7F6 0%, #D1C4E9 50%, #B39DDB 100%)',
  },
  fear: {
    value: 'fear',
    label: '恐惧',
    icon: '🌫️',
    color: '#7A7A8C',
    bgGradient: 'linear-gradient(135deg, #ECEFF1 0%, #CFD8DC 50%, #B0BEC5 100%)',
  },
  wonder: {
    value: 'wonder',
    label: '奇妙',
    icon: '✨',
    color: '#D070E0',
    bgGradient: 'linear-gradient(135deg, #F3E5F5 0%, #E1BEE7 50%, #CE93D8 100%)',
  },
  nostalgia: {
    value: 'nostalgia',
    label: '怀念',
    icon: '🌅',
    color: '#F09070',
    bgGradient: 'linear-gradient(135deg, #FBE9E7 0%, #FFCCBC 50%, #FFAB91 100%)',
  },
};

export const EMOTION_KEYWORDS: Record<EmotionType, string[]> = {
  joy: ['开心', '快乐', '高兴', '笑', '幸福', '阳光', '温暖', '美好', '甜蜜', '自由'],
  calm: ['安静', '平静', '宁静', '放松', '舒服', '躺', '休息', '海边', '湖水', '月亮'],
  sadness: ['哭', '悲伤', '难过', '伤心', '眼泪', '失去', '分别', '雨', '灰色', '孤独'],
  fear: ['怕', '恐惧', '害怕', '逃', '追', '黑暗', '怪物', '尖叫', '坠落', '被困'],
  wonder: ['飞', '奇怪', '奇妙', '魔法', '星空', '幻', '变', '穿越', '不可思议', '神奇'],
  nostalgia: ['回忆', '小时候', '以前', '老家', '故人', '旧', '过去', '曾经', '想念', '梦里见'],
};

export function guessEmotion(text: string): EmotionType | null {
  const scores: Record<string, number> = {};
  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    scores[emotion] = keywords.reduce((count, kw) => count + (text.includes(kw) ? 1 : 0), 0);
  }
  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return null;
  return (Object.entries(scores).find(([, s]) => s === maxScore)![0]) as EmotionType;
}
