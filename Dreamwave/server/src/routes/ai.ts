import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getDatabase, queryAll, queryOne, run } from '../db/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

const imageGenerationSchema = z.object({
  prompt: z.string().min(1, '缺少 prompt 参数').max(5000, 'prompt 参数过长，最大 5000 字符'),
  dream_id: z.string().optional(),
});

const chatCompletionSchema = z.object({
  content: z.string().min(1, '缺少 content 参数').max(10000, 'content 参数过长，最大 10000 字符'),
  dream_id: z.string().optional(),
});

const DIMILINKS_BASE = 'https://dimilinks.com/v1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiData = any;

// 从数据库读取 AI 配置
async function getAIConfig(): Promise<Record<string, string>> {
  await getDatabase();
  const rows = queryAll('SELECT key, value FROM ai_config');
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[(row as ApiData).key] = (row as ApiData).value;
  }
  return config;
}

// POST /api/ai/image-generation — 代理文生图请求
router.post('/image-generation', authMiddleware, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const user = (req as any).user;
  const parsed = imageGenerationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' });
    return;
  }
  const { prompt, dream_id } = parsed.data;

  let logId = '';
  try {
    const config = await getAIConfig();
    if (!config.api_key) {
      res.status(400).json({ error: '请先在后台管理配置 DimiLinks API Key' });
      return;
    }

    // 创建调用记录
    logId = crypto.randomUUID();
    await getDatabase();
    run(
      'INSERT INTO ai_call_logs (id, user_id, dream_id, call_type, model, prompt, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [logId, user.userId, dream_id || null, 'image', config.image_model || 'gpt-image-2', prompt, 'pending']
    );

    const body: Record<string, unknown> = {
      model: config.image_model || 'gpt-image-2',
      prompt,
      n: 1,
      size: config.image_size || '16:9',
    };
    if (config.image_resolution) body.resolution = config.image_resolution;
    if (config.image_format) body.output_format = config.image_format;

    const dimiRes = await fetch(`${DIMILINKS_BASE}/images/generations?async=true`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: ApiData = await dimiRes.json();

    if (!dimiRes.ok) {
      const errMsg: string = data.error?.message || `请求失败 (${dimiRes.status})`;
      run(
        'UPDATE ai_call_logs SET status = ?, error_message = ?, duration_ms = ?, completed_at = datetime("now") WHERE id = ?',
        ['failed', errMsg, Date.now() - startTime, logId]
      );
      res.status(dimiRes.status).json({ error: errMsg });
      return;
    }

    // 更新调用记录为 submitted，保存 task_id
    run(
      'UPDATE ai_call_logs SET status = ?, task_id = ?, duration_ms = ?, completed_at = datetime("now") WHERE id = ?',
      ['submitted', data.task_id as string, Date.now() - startTime, logId]
    );

    res.json({ task_id: data.task_id as string, log_id: logId });
  } catch (err: any) {
    if (logId) {
      try {
        run(
          'UPDATE ai_call_logs SET status = ?, error_message = ?, duration_ms = ?, completed_at = datetime("now") WHERE id = ?',
          ['failed', err.message || '内部错误', Date.now() - startTime, logId]
        );
      } catch (dbErr) {
        console.error('[AI] Failed to update error log:', dbErr);
      }
    }
    console.error('[AI] POST /image-generation error:', err);
    res.status(500).json({ error: '生图请求失败' });
  }
});

// GET /api/ai/tasks/:taskId — 代理轮询图片任务状态
router.get('/tasks/:taskId', authMiddleware, async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const { log_id } = req.query;

  try {
    const config = await getAIConfig();
    if (!config.api_key) {
      res.status(400).json({ error: '请先在后台管理配置 DimiLinks API Key' });
      return;
    }

    const dimiRes = await fetch(`${DIMILINKS_BASE}/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${config.api_key}` },
    });

    const data: ApiData = await dimiRes.json();
    if (!dimiRes.ok) {
      res.status(dimiRes.status).json({ error: data.error?.message || `查询失败 (${dimiRes.status})` });
      return;
    }

    const status: string = data.status as string;

    // 更新调用记录
    if (log_id && typeof log_id === 'string') {
      await getDatabase();
      if (status === 'succeeded') {
        const imgs: { url: string; fileId?: string }[] = (data.result?.data || []).map((d: ApiData) => {
          let url: string = d.url || '';
          if (url.startsWith('/')) url = DIMILINKS_BASE.replace('/v1', '') + url;
          return { url, fileId: d.file_id };
        });
        const resultUrl: string | null = imgs.length > 0 ? imgs[0].url : null;
        run(
          'UPDATE ai_call_logs SET status = ?, result_url = ?, completed_at = datetime("now") WHERE id = ?',
          ['succeeded', resultUrl, log_id]
        );
      } else if (status === 'failed') {
        const errMsg: string = data.error?.message || '生成失败';
        run(
          'UPDATE ai_call_logs SET status = ?, error_message = ?, completed_at = datetime("now") WHERE id = ?',
          ['failed', errMsg, log_id]
        );
      }
    }

    res.json(data);
  } catch (err: any) {
    console.error('[AI] GET /tasks/:taskId error:', err);
    res.status(500).json({ error: '查询任务状态失败' });
  }
});

// POST /api/ai/chat/completions — 代理梦境解读请求
router.post('/chat/completions', authMiddleware, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const user = (req as any).user;
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' });
    return;
  }
  const { content, dream_id } = parsed.data;

  let logId = '';
  try {
    const config = await getAIConfig();
    if (!config.api_key) {
      res.status(400).json({ error: '请先在后台管理配置 DimiLinks API Key' });
      return;
    }

    // 创建调用记录
    logId = crypto.randomUUID();
    await getDatabase();
    run(
      'INSERT INTO ai_call_logs (id, user_id, dream_id, call_type, model, prompt, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [logId, user.userId, dream_id || null, 'chat', config.chat_model || 'deepseek-v4-flash', content, 'pending']
    );

    const defaultSystemPrompt = `你是一位温和、专业的梦境研究者，熟悉荣格、弗洛伊德及现代积极心理学。
请基于用户提供的「梦境画面描述」，输出一份结构化的中文解读。
要求：
1. 不要做医学诊断，不要暗示现实事件。
2. 关注画面中的象征物、颜色、场景、情绪氛围。
3. 给出可能的潜意识主题、情绪提示、可以自问的小问题。
4. 文字简洁、有温度，便于复制分享。
5. 第一行必须生成一个简短诗意的梦境标题（6-12字），用 # 梦境之名 包裹。
严格使用以下 Markdown 结构（不要使用代码块包裹，直接输出 Markdown）：
# 梦境之名
（6-12字的诗意标题，概括梦境核心意象）
## 画面概览
（1-2 句）
## 关键象征
- 象征1：可能含义
- 象征2：可能含义
- 象征3：可能含义
## 情绪与主题
（2-3 句）
## 自我探索
- 问题1
- 问题2
- 问题3`;

    const systemPrompt = config.system_prompt || defaultSystemPrompt;
    const temperature = parseFloat(config.chat_temperature || '0.7');

    const dimiRes = await fetch(`${DIMILINKS_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.chat_model || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
        temperature,
      }),
    });

    const data: ApiData = await dimiRes.json();

    if (!dimiRes.ok) {
      const errMsg: string = data.error?.message || `请求失败 (${dimiRes.status})`;
      run(
        'UPDATE ai_call_logs SET status = ?, error_message = ?, duration_ms = ?, completed_at = datetime("now") WHERE id = ?',
        ['failed', errMsg, Date.now() - startTime, logId]
      );
      res.status(dimiRes.status).json({ error: errMsg });
      return;
    }

    const text: string = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || JSON.stringify(data, null, 2);
    const tokensUsed: number | null = data.usage?.total_tokens || null;

    // 更新调用记录为成功
    run(
      'UPDATE ai_call_logs SET status = ?, result_text = ?, tokens_used = ?, duration_ms = ?, completed_at = datetime("now") WHERE id = ?',
      ['succeeded', text, tokensUsed, Date.now() - startTime, logId]
    );

    res.json({ ...data as Record<string, unknown>, log_id: logId });
  } catch (err: any) {
    if (logId) {
      try {
        run(
          'UPDATE ai_call_logs SET status = ?, error_message = ?, duration_ms = ?, completed_at = datetime("now") WHERE id = ?',
          ['failed', err.message || '内部错误', Date.now() - startTime, logId]
        );
      } catch (dbErr) {
        console.error('[AI] Failed to update error log:', dbErr);
      }
    }
    console.error('[AI] POST /chat/completions error:', err);
    res.status(500).json({ error: '解读请求失败' });
  }
});

// GET /api/ai/config — 获取当前用户的 AI 配置（不含 api_key）
router.get('/config', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const config = await getAIConfig();
    // 不返回 api_key 给前端用户
    const safeConfig: Record<string, string> = { ...config };
    delete safeConfig.api_key;
    res.json({ config: { ...safeConfig, has_api_key: !!config.api_key } });
  } catch (err) {
    console.error('[AI] GET /config error:', err);
    res.status(500).json({ error: '获取AI配置失败' });
  }
});

// GET /api/ai/dream/:dreamId/results — 获取某个梦境的 AI 结果（生图+解读）
router.get('/dream/:dreamId/results', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { dreamId } = req.params;
    await getDatabase();

    // 获取最新的成功生图记录
    const imageLog = queryOne(
      "SELECT id, result_url, status, created_at FROM ai_call_logs WHERE dream_id = ? AND user_id = ? AND call_type = 'image' ORDER BY created_at DESC LIMIT 1",
      [dreamId, user.userId]
    ) as ApiData | undefined;

    // 获取最新的成功解读记录
    const chatLog = queryOne(
      "SELECT id, result_text, status, created_at FROM ai_call_logs WHERE dream_id = ? AND user_id = ? AND call_type = 'chat' ORDER BY created_at DESC LIMIT 1",
      [dreamId, user.userId]
    ) as ApiData | undefined;

    // 获取进行中的生图任务
    const pendingImage = queryOne(
      "SELECT id, task_id, status FROM ai_call_logs WHERE dream_id = ? AND user_id = ? AND call_type = 'image' AND status IN ('pending', 'submitted') ORDER BY created_at DESC LIMIT 1",
      [dreamId, user.userId]
    ) as ApiData | undefined;

    const result: {
      image: { url: string; createdAt: string } | null;
      interpretation: { text: string; createdAt: string } | null;
      pendingImageTask: { logId: string; taskId: string } | null;
    } = {
      image: null,
      interpretation: null,
      pendingImageTask: null,
    };

    if (imageLog && imageLog.status === 'succeeded' && imageLog.result_url) {
      result.image = { url: imageLog.result_url, createdAt: imageLog.created_at };
    }

    if (chatLog && chatLog.status === 'succeeded' && chatLog.result_text) {
      result.interpretation = { text: chatLog.result_text, createdAt: chatLog.created_at };
    }

    if (pendingImage) {
      result.pendingImageTask = { logId: pendingImage.id, taskId: pendingImage.task_id || '' };
    }

    res.json(result);
  } catch (err) {
    console.error('[AI] GET /dream/:dreamId/results error:', err);
    res.status(500).json({ error: '获取AI结果失败' });
  }
});

// POST /api/ai/dreams/results — 批量获取多个梦境的 AI 结果
router.post('/dreams/results', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { dream_ids } = req.body as { dream_ids?: string[] };

    if (!Array.isArray(dream_ids) || dream_ids.length === 0) {
      res.json({ results: {} });
      return;
    }

    // 限制最多 100 个
    const ids = dream_ids.slice(0, 100);
    await getDatabase();

    const placeholders = ids.map(() => '?').join(',');

    // 批量获取所有生图记录
    const imageLogs = queryAll(
      `SELECT dream_id, result_url, status, created_at FROM ai_call_logs WHERE dream_id IN (${placeholders}) AND user_id = ? AND call_type = 'image' AND status = 'succeeded' AND result_url IS NOT NULL ORDER BY created_at DESC`,
      [...ids, user.userId]
    ) as any[];

    // 批量获取所有解读记录
    const chatLogs = queryAll(
      `SELECT dream_id, result_text, status, created_at FROM ai_call_logs WHERE dream_id IN (${placeholders}) AND user_id = ? AND call_type = 'chat' AND status = 'succeeded' AND result_text IS NOT NULL ORDER BY created_at DESC`,
      [...ids, user.userId]
    ) as any[];

    // 批量获取进行中的生图任务
    const pendingImages = queryAll(
      `SELECT dream_id, id as log_id, task_id FROM ai_call_logs WHERE dream_id IN (${placeholders}) AND user_id = ? AND call_type = 'image' AND status IN ('pending', 'submitted') ORDER BY created_at DESC`,
      [...ids, user.userId]
    ) as any[];

    // 按梦境 ID 组织结果（每类只取最新一条）
    const imageMap = new Map<string, { url: string; createdAt: string }>();
    for (const log of imageLogs) {
      if (!imageMap.has(log.dream_id)) {
        imageMap.set(log.dream_id, { url: log.result_url, createdAt: log.created_at });
      }
    }

    const chatMap = new Map<string, { text: string; createdAt: string }>();
    for (const log of chatLogs) {
      if (!chatMap.has(log.dream_id)) {
        chatMap.set(log.dream_id, { text: log.result_text, createdAt: log.created_at });
      }
    }

    const pendingMap = new Map<string, { logId: string; taskId: string }>();
    for (const log of pendingImages) {
      if (!pendingMap.has(log.dream_id)) {
        pendingMap.set(log.dream_id, { logId: log.log_id, taskId: log.task_id || '' });
      }
    }

    const results: Record<string, any> = {};
    for (const id of ids) {
      results[id] = {
        image: imageMap.get(id) || null,
        interpretation: chatMap.get(id) || null,
        pendingImageTask: pendingMap.get(id) || null,
      };
    }

    res.json({ results });
  } catch (err) {
    console.error('[AI] POST /dreams/results error:', err);
    res.status(500).json({ error: '批量获取AI结果失败' });
  }
});

export default router;
