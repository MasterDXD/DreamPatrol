export type EmotionType = 'joy' | 'calm' | 'sadness' | 'fear' | 'wonder' | 'nostalgia';

interface EmotionTemplate {
  openings: string[];
  transitions: string[];
  closings: string[];
}

const NARRATIVE_TEMPLATES: Record<EmotionType, EmotionTemplate> = {
  joy: {
    openings: ['在那个充满光芒的梦里，', '阳光洒落的梦境中，'],
    transitions: ['然后，', '接着，', '忽然间，'],
    closings: ['这个梦让我醒来时嘴角还带着笑。', '温暖的感觉一直留到了醒来。'],
  },
  calm: {
    openings: ['在一个安静的梦里，', '月光下的梦境里，'],
    transitions: ['慢慢地，', '静静地，', '不知不觉间，'],
    closings: ['醒来时，内心格外平静。', '那份安宁一直留在了心里。'],
  },
  sadness: {
    openings: ['在那个带着雨意的梦里，', '灰色的梦境中，'],
    transitions: ['可是，', '然而，', '不知为何，'],
    closings: ['醒来时，枕边有些湿润。', '那份惆怅久久不散。'],
  },
  fear: {
    openings: ['在那个令人窒息的梦里，', '黑暗笼罩的梦境中，'],
    transitions: ['突然，', '就在这时，', '身后传来——'],
    closings: ['猛然惊醒，心跳还未平复。', '庆幸那只是一个梦。'],
  },
  wonder: {
    openings: ['在那个不可思议的梦里，', '星空之下的梦境中，'],
    transitions: ['奇妙的是，', '不可思议地，', '就在那一瞬间，'],
    closings: ['这个梦太奇妙了，舍不得醒来。', '那种不可思议的感觉，久久难忘。'],
  },
  nostalgia: {
    openings: ['在那个似曾相识的梦里，', '时光倒流的梦境中，'],
    transitions: ['恍惚间，', '记忆里，', '好像很久以前，'],
    closings: ['醒来时，有些想念那些时光。', '那个梦，像是和过去的一次重逢。'],
  },
};

const EMOTION_KEYWORDS: Record<EmotionType, string[]> = {
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

export function generateNarrative(content: string, emotion: EmotionType): string {
  const template = NARRATIVE_TEMPLATES[emotion];
  const sentences = content.split(/[。！？\n]+/).filter(s => s.trim());

  if (sentences.length === 0) return content;

  const opening = template.openings[Math.floor(Math.random() * template.openings.length)];
  const closing = template.closings[Math.floor(Math.random() * template.closings.length)];

  const body = sentences.map((s, i) => {
    if (i === 0) return s.trim();
    const transition = template.transitions[i % template.transitions.length];
    return transition + s.trim();
  }).join('。');

  return `${opening}${body}。${closing}`;
}
