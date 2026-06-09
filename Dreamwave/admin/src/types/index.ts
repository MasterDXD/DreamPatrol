export interface User {
  id: string;
  username: string;
  role: string;
  is_active: number;
  created_at: string;
  dream_count?: number;
}

export interface Dream {
  id: string;
  user_id: string;
  username?: string;
  title: string;
  content: string;
  emotion: EmotionType;
  narrative?: string;
  image_url?: string;
  interpretation?: string;
  recorded_date: string;
  created_at: string;
  updated_at: string;
}

export type EmotionType = 'joy' | 'calm' | 'sadness' | 'fear' | 'wonder' | 'nostalgia';

export interface Stats {
  totalDreams: number;
  totalUsers: number;
  activeUsers: number;
  todayDreams: number;
  emotionDistribution: { emotion: EmotionType; count: number }[];
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}
