const API_BASE = '/api';

/* 401认证过期专用错误类型 */
export class AuthExpiredError extends Error {
  constructor() {
    super('AUTH_EXPIRED');
    this.name = 'AuthExpiredError';
  }
}

function getToken(): string | null {
  const token = localStorage.getItem('dreamwave_token');
  if (!token) return null;

  // 校验 JWT 是否过期
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem('dreamwave_token');
      return null;
    }
  } catch {
    // token 格式异常，清除
    localStorage.removeItem('dreamwave_token');
    return null;
  }
  return token;
}

/** 检查 localStorage 中的 token 是否有效（未过期） */
export function isTokenValid(): boolean {
  return !!getToken();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const hasBody = options.method === 'POST' || options.method === 'PUT';
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // 仅对需要认证的接口抛出 AuthExpiredError
  // 登录/注册接口返回 401 是正常的业务错误，不应触发全局登出
  if (res.status === 401) {
    const isAuthEndpoint = path.startsWith('/auth/login') || path.startsWith('/auth/register');
    if (!isAuthEndpoint) {
      localStorage.removeItem('dreamwave_token');
      throw new AuthExpiredError();
    }
  }

  const contentType = res.headers.get('content-type');
  const isJson = contentType?.includes('application/json') ?? true;

  let data: any;
  if (isJson) {
    try {
      const text = await res.text();
      if (!text.trim()) {
        if (res.status >= 500) {
          throw new Error(`服务器内部错误 (${res.status})，请稍后重试`);
        }
        throw new Error(`服务器返回了空响应 (${res.status})`);
      }
      data = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`服务器返回了无效的JSON格式 (${res.status})`);
      }
      throw err;
    }
  } else {
    throw new Error(`服务器返回了非JSON格式 (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

import type { AuthResponse, Dream, DreamInput, DreamsResponse, Tag } from '../types/dream';

// 将前端camelCase转为后端snake_case
function toSnakeCase(input: DreamInput): any {
  return {
    content: input.content,
    emotion: input.emotion,
    recorded_date: input.recordedDate || undefined,
  };
}

export const api = {
  // 认证
  register: (username: string, password: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getMe: () => request<{ id: string; username: string; created_at?: string; avatar?: string | null }>('/auth/me'),

  updateProfile: (data: { avatar?: string }) =>
    request<{ message: string }>('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  refreshToken: () =>
    request<{ token: string }>('/auth/refresh', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ message: string }>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // 梦境
  getDreams: (params?: { emotion?: string; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.emotion) query.set('emotion', params.emotion);
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<DreamsResponse>(`/dreams${qs ? '?' + qs : ''}`);
  },

  createDream: (input: DreamInput) =>
    request<{ dream: Dream }>('/dreams', {
      method: 'POST',
      body: JSON.stringify(toSnakeCase(input)),
    }),

  getDream: (id: string) =>
    request<{ dream: Dream }>(`/dreams/${id}`),

  updateDream: (id: string, input: DreamInput) =>
    request<{ dream: Dream }>(`/dreams/${id}`, {
      method: 'PUT',
      body: JSON.stringify(toSnakeCase(input)),
    }),

  deleteDream: (id: string) =>
    request<{ message: string }>(`/dreams/${id}`, { method: 'DELETE' }),

  toggleFavorite: (id: string) =>
    request<{ is_favorite: number }>(`/dreams/${id}/favorite`, { method: 'PUT' }),

  getDreamsByDate: (date: string) =>
    request<{ dreams: Dream[] }>(`/dreams/date/${date}`),

  getRecordedDates: () =>
    request<{ dates: string[] }>('/dreams/dates/list'),

  generateNarrative: (id: string) =>
    request<{ narrative: string }>(`/dreams/${id}/narrative`, { method: 'POST' }),

  // 更新 AI 生图/解读结果到后端
  updateAIResults: (id: string, data: { imageUrl?: string; interpretation?: string }) =>
    request<{ dream: any }>(`/dreams/${id}/ai-results`, { method: 'PUT', body: JSON.stringify(data) }),

  // 导出梦境
  exportDreams: (format: 'markdown' | 'txt' | 'json') => {
    const token = getToken();
    const url = `${API_BASE}/dreams/export?format=${format}`;
    // 导出需要直接下载，不能走request函数
    return fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async res => {
      if (res.status === 401) {
        localStorage.removeItem('dreamwave_token');
        throw new AuthExpiredError();
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '导出失败');
      }
      // 触发浏览器下载
      const blob = await res.blob();
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = `dreams.${format === 'markdown' ? 'md' : format}`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  },

  // 相关梦境
  getRelatedDreams: (id: string) =>
    request<{ dreams: Dream[] }>(`/dreams/${id}/related`),

  // 标签
  getTags: () =>
    request<{ tags: Tag[] }>('/tags'),

  createTag: (data: { name: string; color?: string }) =>
    request<{ tag: Tag }>('/tags', { method: 'POST', body: JSON.stringify(data) }),

  updateTag: (id: string, data: { name?: string; color?: string }) =>
    request<{ tag: Tag }>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deleteTag: (id: string) =>
    request<{ message: string }>(`/tags/${id}`, { method: 'DELETE' }),

  addDreamTags: (dreamId: string, tagIds: string[]) =>
    request<{ message: string }>(`/dreams/${dreamId}/tags`, { method: 'POST', body: JSON.stringify({ tagIds }) }),

  removeDreamTag: (dreamId: string, tagId: string) =>
    request<{ message: string }>(`/dreams/${dreamId}/tags/${tagId}`, { method: 'DELETE' }),

  getDreamTags: (dreamId: string) =>
    request<{ tags: Tag[] }>(`/dreams/${dreamId}/tags`),

  // 搜索
  searchDreams: (params: { keyword?: string; emotion?: string; tag?: string; favorite?: boolean; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params.keyword) query.set('keyword', params.keyword);
    if (params.emotion) query.set('emotion', params.emotion);
    if (params.tag) query.set('tag', params.tag);
    if (params.favorite) query.set('favorite', 'true');
    if (params.page !== undefined) query.set('page', String(params.page));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<DreamsResponse>(`/dreams/search${qs ? '?' + qs : ''}`);
  },

  // 统计
  getDreamStats: () =>
    request<{
      emotionDistribution: { emotion: string; count: number }[];
      recentDailyCounts: { recorded_date: string; count: number }[];
      totalDreams: number;
      totalDays: number;
      topTags: { name: string; color: string; count: number }[];
    }>('/dreams/stats'),
};
