export type EmotionType = 'joy' | 'calm' | 'sadness' | 'fear' | 'wonder' | 'nostalgia';

export interface Dream {
  id: string;
  user_id: string;
  title: string;
  content: string;
  emotion: EmotionType;
  narrative: string | null;
  image_url: string | null;
  recorded_date: string;
  created_at: string;
  updated_at: string;
  is_favorite: number;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface DreamInput {
  content: string;
  emotion: EmotionType;
  recordedDate?: string;
}

export interface EmotionMeta {
  value: EmotionType;
  label: string;
  icon: string;
  color: string;
  bgGradient: string;
}

export type EmotionMetaMap = Record<EmotionType, EmotionMeta>;

export interface User {
  id: string;
  username: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface DreamsResponse {
  dreams: Dream[];
  total: number;
  page: number;
  limit: number;
}
