import type { User, Dream, EmotionType } from '../types';

const API_BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('dreamwave_admin_token');
}

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;
  const token = skipAuth ? null : getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers });

  if (res.status === 401) {
    localStorage.removeItem('dreamwave_admin_token');
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    throw new Error('认证已过期，请重新登录');
  }

  if (res.status === 403) {
    throw new Error('需要管理员权限');
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

// 登录响应
interface LoginResponse {
  user: User;
  token: string;
}

// 梦境列表响应
interface DreamListResponse {
  dreams: Dream[];
  total: number;
  page: number;
  limit: number;
}

// 用户列表响应
interface UserListResponse {
  users: User[];
}

// 统计数据响应（后端字段命名）
interface StatsResponse {
  totalDreams: number;
  totalUsers: number;
  activeUsers: number;
  todayDreams: number;
  emotionDistribution: { emotion: EmotionType; count: number }[];
}

// 趋势数据响应
interface TrendsResponse {
  recentDreams: { date: string; count: number }[];
  recentUsers: { date: string; count: number }[];
  emotionDistribution: { emotion: EmotionType; count: number }[];
}

// 操作日志
interface OperationLog {
  id: string;
  user_id: string;
  username?: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip_address: string | null;
  created_at: string;
}

// 操作日志列表响应
interface OperationLogListResponse {
  logs: OperationLog[];
  total: number;
  page: number;
  limit: number;
}

// AI 调用记录
export interface AICallLog {
  id: string;
  user_id: string;
  username?: string;
  dream_id: string | null;
  call_type: string;
  model: string;
  prompt: string | null;
  status: string;
  result_url: string | null;
  result_text: string | null;
  error_message: string | null;
  tokens_used: number | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

// AI 调用记录列表响应
interface AICallLogListResponse {
  logs: AICallLog[];
  total: number;
  page: number;
  limit: number;
}

export const adminApi = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }), skipAuth: true,
    }),

  getStats: () => request<StatsResponse>('/admin/stats'),

  getTrends: () => request<TrendsResponse>('/admin/stats/trends'),

  getDreams: (params?: { page?: number; limit?: number; search?: string }) => {
    const query = new URLSearchParams();
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.search) query.set('search', params.search);
    const qs = query.toString();
    return request<DreamListResponse>(`/admin/dreams${qs ? '?' + qs : ''}`);
  },

  deleteDream: (id: string) =>
    request<{ message: string }>(`/admin/dreams/${id}`, { method: 'DELETE' }),

  getUsers: () => request<UserListResponse>('/admin/users'),

  updateUserStatus: (id: string, isActive: boolean) =>
    request<{ message: string }>(`/admin/users/${id}/status`, {
      method: 'PUT', body: JSON.stringify({ isActive }),
    }),

  getOperationLogs: (params?: { page?: number; limit?: number; action?: string }) => {
    const query = new URLSearchParams();
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.action) query.set('action', params.action);
    const qs = query.toString();
    return request<OperationLogListResponse>(`/admin/logs${qs ? '?' + qs : ''}`);
  },

  // AI 配置
  getAIConfig: () =>
    request<{ config: Record<string, string> }>('/admin/ai-config'),

  updateAIConfig: (config: Record<string, string>) =>
    request<{ message: string }>('/admin/ai-config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  // AI 调用记录
  getAICallLogs: (params?: { page?: number; limit?: number; call_type?: string; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.call_type) query.set('call_type', params.call_type);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    return request<AICallLogListResponse>(`/admin/ai-call-logs${qs ? '?' + qs : ''}`);
  },

  getAICallLogDetail: (id: string) =>
    request<{ log: AICallLog }>(`/admin/ai-call-logs/${id}`),
};
