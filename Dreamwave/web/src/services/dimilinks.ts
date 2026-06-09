/**
 * AI 服务模块
 * 通过后端代理调用生图和解读 API，后端负责记录调用日志
 * 配置由后台管理系统全局管理，前端不再直接管理 API Key
 */

const API_BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('dreamwave_token');
}

// ===== 配置管理 =====

export interface DimiLinksConfig {
  hasApiKey: boolean;
  imageModel: string;
  imageSize: string;
  imageResolution: string;
  imageFormat: string;
  chatModel: string;
  chatTemperature: string;
}

const DEFAULT_CONFIG: DimiLinksConfig = {
  hasApiKey: false,
  imageModel: 'gpt-image-2',
  imageSize: '16:9',
  imageResolution: '1k',
  imageFormat: 'png',
  chatModel: 'deepseek-v4-flash',
  chatTemperature: '0.7',
};

// 缓存后端配置
let cachedConfig: DimiLinksConfig | null = null;

export async function getConfig(): Promise<DimiLinksConfig> {
  if (cachedConfig) return cachedConfig;
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/ai/config`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      cachedConfig = {
        hasApiKey: data.config?.has_api_key || false,
        imageModel: data.config?.image_model || DEFAULT_CONFIG.imageModel,
        imageSize: data.config?.image_size || DEFAULT_CONFIG.imageSize,
        imageResolution: data.config?.image_resolution || DEFAULT_CONFIG.imageResolution,
        imageFormat: data.config?.image_format || DEFAULT_CONFIG.imageFormat,
        chatModel: data.config?.chat_model || DEFAULT_CONFIG.chatModel,
        chatTemperature: data.config?.chat_temperature || DEFAULT_CONFIG.chatTemperature,
      };
      return cachedConfig!;
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export async function hasApiKey(): Promise<boolean> {
  const config = await getConfig();
  return config.hasApiKey;
}

// ===== 文生图 API =====

export interface ImageGenerationResult {
  taskId: string;
  images: { url: string; fileId?: string }[];
  status: 'submitted' | 'succeeded' | 'failed' | 'in_progress';
  progress: number;
  error?: string;
}

/** 提交异步文生图任务（通过后端代理） */
export async function submitImageGeneration(prompt: string, dreamId?: string): Promise<{ taskId: string; logId: string }> {
  const config = await getConfig();
  if (!config.hasApiKey) throw new Error('请先在后台管理配置 AI API Key');

  const token = getToken();
  const res = await fetch(`${API_BASE}/ai/image-generation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, dream_id: dreamId }),
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`生图请求失败：服务器返回了非预期格式 (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);

  return { taskId: data.task_id, logId: data.log_id };
}

/** 查询图片任务状态（通过后端代理） */
export async function pollImageTask(taskId: string, logId?: string): Promise<ImageGenerationResult> {
  const token = getToken();
  const query = logId ? `?log_id=${logId}` : '';
  const res = await fetch(`${API_BASE}/ai/tasks/${taskId}${query}`, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`查询任务失败：服务器返回了非预期格式 (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error?.message || data.error || `查询失败 (${res.status})`);

  const status = data.status as string;
  const progress = data.progress ?? data.processed_images ?? data.task_progress ?? 0;

  if (status === 'succeeded') {
    const imgArray = data.result?.data || data.images || data.result?.images || [];
    const imgs = imgArray.map((d: any) => {
      let url = d.url || '';
      if (url.startsWith('/')) url = 'https://dimilinks.com' + url;
      return { url, fileId: d.file_id || d.id };
    });
    return { taskId, images: imgs, status: 'succeeded', progress: 100 };
  }

  if (status === 'failed') {
    return {
      taskId,
      images: [],
      status: 'failed',
      progress: 100,
      error: data.error?.message || data.message || data.error || '生成失败',
    };
  }

  return { taskId, images: [], status: 'in_progress', progress };
}

// ===== 梦境解读 API =====

export interface InterpretResult {
  text: string;
}

/** 调用 LLM 解读梦境（通过后端代理） */
export async function interpretDream(content: string, dreamId?: string): Promise<InterpretResult> {
  const config = await getConfig();
  if (!config.hasApiKey) throw new Error('请先在后台管理配置 AI API Key');

  const token = getToken();
  const res = await fetch(`${API_BASE}/ai/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content, dream_id: dreamId }),
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`解读请求失败：服务器返回了非预期格式 (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);

  const text = data.choices?.[0]?.message?.content
    || data.choices?.[0]?.text
    || JSON.stringify(data, null, 2);

  return { text };
}

// ===== 持久化存档 =====

const ARCHIVE_KEY = 'dimilinks_archive';

export interface ImageArchive {
  images: { url: string; fileId?: string }[];
  createdAt: number;
}

export interface InterpretArchive {
  text: string;
  createdAt: number;
}

interface DreamArchive {
  image?: ImageArchive;
  interpret?: InterpretArchive;
}

type ArchiveMap = Record<string, DreamArchive>;

function loadArchive(): ArchiveMap {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function saveArchive(map: ArchiveMap): void {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(map));
}

/** 保存生图结果 */
export function saveImageArchive(dreamId: string, images: { url: string; fileId?: string }[]): void {
  const map = loadArchive();
  if (!map[dreamId]) map[dreamId] = {};
  map[dreamId].image = { images, createdAt: Date.now() };
  saveArchive(map);
}

/** 读取生图结果（仅 localStorage） */
export function loadImageArchive(dreamId: string): ImageArchive | null {
  return loadArchive()[dreamId]?.image || null;
}

/** 保存解读结果 */
export function saveInterpretArchive(dreamId: string, text: string): void {
  const map = loadArchive();
  if (!map[dreamId]) map[dreamId] = {};
  map[dreamId].interpret = { text, createdAt: Date.now() };
  saveArchive(map);
}

/** 读取解读结果（仅 localStorage） */
export function loadInterpretArchive(dreamId: string): InterpretArchive | null {
  return loadArchive()[dreamId]?.interpret || null;
}

// ===== 从后端加载结果（页面刷新后恢复） =====

export interface DreamAIResults {
  image: { url: string; createdAt: string } | null;
  interpretation: { text: string; createdAt: string } | null;
  pendingImageTask: { logId: string; taskId: string } | null;
}

/** 从后端获取某个梦境的 AI 结果（生图+解读+进行中任务） */
export async function loadDreamAIResults(dreamId: string): Promise<DreamAIResults> {
  const token = getToken();
  try {
    const res = await fetch(`${API_BASE}/ai/dream/${dreamId}/results`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      // 同步到 localStorage 缓存
      if (data.image?.url) {
        saveImageArchive(dreamId, [{ url: data.image.url }]);
      }
      if (data.interpretation?.text) {
        saveInterpretArchive(dreamId, data.interpretation.text);
      }
      return data;
    }
  } catch {}
  return { image: null, interpretation: null, pendingImageTask: null };
}

/** 批量从后端获取多个梦境的 AI 结果 */
export async function batchLoadDreamAIResults(dreamIds: string[]): Promise<Record<string, DreamAIResults>> {
  if (dreamIds.length === 0) return {};
  const token = getToken();
  try {
    const res = await fetch(`${API_BASE}/ai/dreams/results`, {
      method: 'POST',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dream_ids: dreamIds }),
    });
    if (res.ok) {
      const data = await res.json();
      const results: Record<string, DreamAIResults> = data.results || {};
      // 同步到 localStorage 缓存
      for (const [id, result] of Object.entries(results)) {
        const r = result as DreamAIResults;
        if (r.image?.url) saveImageArchive(id, [{ url: r.image.url }]);
        if (r.interpretation?.text) saveInterpretArchive(id, r.interpretation.text);
      }
      return results;
    }
  } catch {}
  return {};
}
