import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase, queryAll, queryOne, run } from '../db/database';
import { authMiddleware, TokenPayload } from '../middleware/auth';
import { generateNarrative } from '../utils/emotions';

const router = Router();

const EmotionType = z.enum(['joy', 'calm', 'sadness', 'fear', 'wonder', 'nostalgia']);

const createDreamSchema = z.object({
  content: z.string().min(1, '梦境内容不能为空').max(5000, '内容最多5000字符'),
  emotion: EmotionType,
  recordedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为YYYY-MM-DD').optional(),
});

// GET /api/dreams — 列表（支持分页和情绪筛选）
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { emotion, page = '1', limit = '20' } = req.query;
    await getDatabase();

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let countSql = 'SELECT COUNT(*) as total FROM dreams WHERE user_id = ?';
    let listSql = 'SELECT * FROM dreams WHERE user_id = ?';
    const params: any[] = [userId];

    if (emotion && EmotionType.safeParse(emotion).success) {
      countSql += ' AND emotion = ?';
      listSql += ' AND emotion = ?';
      params.push(emotion);
    }

    listSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const totalRow = queryOne(countSql, params) as any;
    const dreams = queryAll(listSql, [...params, limitNum, offset]);

    res.json({ dreams, total: totalRow?.total || 0, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[Dreams] GET / error:', err);
    res.status(500).json({ error: '获取梦境列表失败' });
  }
});

// GET /api/dreams/export — 导出梦境（必须在 /:id 之前）
router.get('/export', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const format = (req.query.format as string) || 'json';
    await getDatabase();

    const dreams = queryAll(
      'SELECT * FROM dreams WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    ) as any[];

    if (format === 'markdown') {
      const lines = dreams.map(d =>
        `# ${d.title}\n日期: ${d.recorded_date}\n情绪: ${d.emotion}\n\n${d.content}\n\n---\n`
      );
      const content = lines.join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=dreams.md');
      res.send(content);
    } else if (format === 'txt') {
      const lines = dreams.map(d =>
        `【${d.title}】\n日期: ${d.recorded_date}  情绪: ${d.emotion}\n${d.content}\n${'─'.repeat(40)}`
      );
      const content = lines.join('\n\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=dreams.txt');
      res.send(content);
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=dreams.json');
      res.json(dreams);
    }
  } catch (err) {
    console.error('[Dreams] GET /export error:', err);
    res.status(500).json({ error: '导出梦境失败' });
  }
});

// GET /api/dreams/stats — 个人梦境统计（必须在 /:id 之前）
router.get('/stats', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    // 情绪分布
    const emotionDist = queryAll(
      'SELECT emotion, COUNT(*) as count FROM dreams WHERE user_id = ? GROUP BY emotion',
      [userId]
    );

    // 近7天梦境数量
    const recentDaily = queryAll(
      "SELECT recorded_date, COUNT(*) as count FROM dreams WHERE user_id = ? AND recorded_date >= date('now', '-7 days') GROUP BY recorded_date ORDER BY recorded_date ASC",
      [userId]
    );

    // 总梦境数
    const totalRow = queryOne('SELECT COUNT(*) as count FROM dreams WHERE user_id = ?', [userId]) as any;
    // 总记录天数
    const daysRow = queryOne('SELECT COUNT(DISTINCT recorded_date) as count FROM dreams WHERE user_id = ?', [userId]) as any;

    // 最常用标签
    const topTags = queryAll(
      'SELECT t.name, t.color, COUNT(dt.dream_id) as count FROM tags t JOIN dream_tags dt ON t.id = dt.tag_id WHERE t.user_id = ? GROUP BY t.id ORDER BY count DESC LIMIT 5',
      [userId]
    );

    res.json({
      emotionDistribution: emotionDist,
      recentDailyCounts: recentDaily,
      totalDreams: totalRow?.count || 0,
      totalDays: daysRow?.count || 0,
      topTags,
    });
  } catch (err) {
    console.error('[Dreams] GET /stats error:', err);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

// GET /api/dreams/search — 搜索梦境（支持关键字、情绪、标签、收藏筛选，必须在 /:id 之前）
router.get('/search', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { keyword, emotion, tag, favorite, page = '1', limit = '20' } = req.query;
    await getDatabase();

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // 构建查询
    let selectSql = 'SELECT DISTINCT d.* FROM dreams d';
    let countSelectSql = 'SELECT COUNT(DISTINCT d.id) as total FROM dreams d';
    let whereSql = ' WHERE d.user_id = ?';
    const params: any[] = [userId];

    // 标签筛选需要 JOIN
    if (tag && typeof tag === 'string' && tag.trim()) {
      selectSql += ' INNER JOIN dream_tags dt ON d.id = dt.dream_id';
      countSelectSql += ' INNER JOIN dream_tags dt ON d.id = dt.dream_id';
      whereSql += ' AND dt.tag_id = ?';
      params.push(tag.trim());
    }

    // 关键字搜索
    if (keyword && typeof keyword === 'string' && keyword.trim()) {
      whereSql += ' AND (d.title LIKE ? OR d.content LIKE ?)';
      const pattern = `%${keyword.trim()}%`;
      params.push(pattern, pattern);
    }

    // 情绪筛选
    if (emotion && EmotionType.safeParse(emotion).success) {
      whereSql += ' AND d.emotion = ?';
      params.push(emotion);
    }

    // 收藏筛选
    if (favorite === 'true') {
      whereSql += ' AND d.is_favorite = 1';
    }

    const countSql = countSelectSql + whereSql;
    const listSql = selectSql + whereSql + ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';

    const totalRow = queryOne(countSql, params) as any;
    const dreams = queryAll(listSql, [...params, limitNum, offset]);

    res.json({ dreams, total: totalRow?.total || 0, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[Dreams] GET /search error:', err);
    res.status(500).json({ error: '搜索梦境失败' });
  }
});

// GET /api/dreams/dates/list — 获取有记录的日期列表（必须在 /:id 之前）
router.get('/dates/list', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const rows = queryAll(
      'SELECT DISTINCT recorded_date FROM dreams WHERE user_id = ? ORDER BY recorded_date DESC',
      [userId]
    ) as any[];

    res.json({ dates: rows.map(r => r.recorded_date) });
  } catch (err) {
    console.error('[Dreams] GET /dates/list error:', err);
    res.status(500).json({ error: '获取日期列表失败' });
  }
});

// GET /api/dreams/date/:date — 按日期查询（必须在 /:id 之前）
router.get('/date/:date', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { date } = req.params;

    // 校验日期格式
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: '日期格式应为YYYY-MM-DD' });
      return;
    }

    await getDatabase();
    const dreams = queryAll(
      'SELECT * FROM dreams WHERE user_id = ? AND recorded_date = ? ORDER BY created_at DESC',
      [userId, date]
    );
    res.json({ dreams });
  } catch (err) {
    console.error('[Dreams] GET /date/:date error:', err);
    res.status(500).json({ error: '按日期查询失败' });
  }
});

// POST /api/dreams — 创建梦境
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parse = createDreamSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { userId } = (req as any).user as TokenPayload;
    const { content, emotion, recordedDate } = parse.data;
    await getDatabase();

    const id = crypto.randomUUID();
    const title = content.trim().slice(0, 30) || '无题';
    const now = new Date().toISOString();
    const date = recordedDate || now.slice(0, 10);

    run(
      'INSERT INTO dreams (id, user_id, title, content, emotion, recorded_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, title, content.trim(), emotion, date, now, now]
    );

    const dream = queryOne('SELECT * FROM dreams WHERE id = ?', [id]);
    res.status(201).json({ dream });
  } catch (err) {
    console.error('[Dreams] POST / error:', err);
    res.status(500).json({ error: '创建梦境失败' });
  }
});

// GET /api/dreams/:id/related — 获取相关梦境（必须在 /:id 之前）
router.get('/:id/related', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { id } = req.params;
    await getDatabase();

    // 获取当前梦境
    const dream = queryOne('SELECT * FROM dreams WHERE id = ? AND user_id = ?', [id, userId]) as any;
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    // 基于相同情绪 + 相同标签的梦境推荐，排除自身，最多5条
    const related = queryAll(
      `SELECT d.* FROM dreams d
       LEFT JOIN dream_tags dt ON d.id = dt.dream_id
       WHERE d.user_id = ? AND d.id != ? AND (d.emotion = ? OR dt.tag_id IN (SELECT tag_id FROM dream_tags WHERE dream_id = ?))
       GROUP BY d.id ORDER BY COUNT(dt.tag_id) DESC, d.created_at DESC LIMIT 5`,
      [userId, id, dream.emotion, id]
    );

    res.json({ dreams: related });
  } catch (err) {
    console.error('[Dreams] GET /:id/related error:', err);
    res.status(500).json({ error: '获取相关梦境失败' });
  }
});

// GET /api/dreams/:id — 获取单个梦境
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const dream = queryOne('SELECT * FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }
    res.json({ dream });
  } catch (err) {
    console.error('[Dreams] GET /:id error:', err);
    res.status(500).json({ error: '获取梦境失败' });
  }
});

// PUT /api/dreams/:id — 更新梦境
router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parse = createDreamSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { userId } = (req as any).user as TokenPayload;
    const { content, emotion, recordedDate } = parse.data;
    await getDatabase();

    const existing = queryOne('SELECT * FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (!existing) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    const title = content.trim().slice(0, 30) || '无题';
    const now = new Date().toISOString();

    run(
      'UPDATE dreams SET title = ?, content = ?, emotion = ?, recorded_date = ?, narrative = NULL, updated_at = ? WHERE id = ? AND user_id = ?',
      [title, content.trim(), emotion, recordedDate || (existing as any).recorded_date, now, req.params.id, userId]
    );

    const dream = queryOne('SELECT * FROM dreams WHERE id = ?', [req.params.id]);
    res.json({ dream });
  } catch (err) {
    console.error('[Dreams] PUT /:id error:', err);
    res.status(500).json({ error: '更新梦境失败' });
  }
});

// PUT /api/dreams/:id/favorite — 切换收藏状态
// PUT /api/dreams/:id/ai-results — 更新 AI 生图/解读结果
router.put('/:id/ai-results', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { imageUrl, interpretation } = req.body;
    await getDatabase();

    const existing = queryOne('SELECT id FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (!existing) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (imageUrl !== undefined) {
      updates.push('image_url = ?');
      params.push(imageUrl);
    }
    if (interpretation !== undefined) {
      updates.push('interpretation = ?');
      params.push(interpretation);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: '没有需要更新的字段' });
      return;
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(req.params.id, userId);

    run(`UPDATE dreams SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);

    const dream = queryOne('SELECT * FROM dreams WHERE id = ?', [req.params.id]);
    res.json({ dream });
  } catch (err) {
    console.error('[Dreams] PUT /:id/ai-results error:', err);
    res.status(500).json({ error: '更新AI结果失败' });
  }
});

router.put('/:id/favorite', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const dream = queryOne('SELECT is_favorite FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]) as any;
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    const newFavorite = dream.is_favorite ? 0 : 1;
    run('UPDATE dreams SET is_favorite = ?, updated_at = ? WHERE id = ? AND user_id = ?', [newFavorite, new Date().toISOString(), req.params.id, userId]);

    res.json({ is_favorite: newFavorite });
  } catch (err) {
    console.error('[Dreams] PUT /:id/favorite error:', err);
    res.status(500).json({ error: '切换收藏状态失败' });
  }
});

// DELETE /api/dreams/:id — 删除梦境
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const existing = queryOne('SELECT id FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (!existing) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    run('DELETE FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('[Dreams] DELETE /:id error:', err);
    res.status(500).json({ error: '删除梦境失败' });
  }
});

// POST /api/dreams/:dreamId/tags — 给梦境添加标签
router.post('/:dreamId/tags', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { dreamId } = req.params;
    const { tagIds } = req.body as { tagIds?: string[] };
    await getDatabase();

    if (!Array.isArray(tagIds) || tagIds.length === 0) {
      res.status(400).json({ error: 'tagIds 不能为空' });
      return;
    }

    // 验证梦境属于当前用户
    const dream = queryOne('SELECT id FROM dreams WHERE id = ? AND user_id = ?', [dreamId, userId]);
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    // 验证所有标签属于当前用户
    for (const tagId of tagIds) {
      const tag = queryOne('SELECT id FROM tags WHERE id = ? AND user_id = ?', [tagId, userId]);
      if (!tag) {
        res.status(404).json({ error: `标签 ${tagId} 不存在` });
        return;
      }
    }

    // 插入关联（忽略已存在的）
    for (const tagId of tagIds) {
      try { run('INSERT OR IGNORE INTO dream_tags (dream_id, tag_id) VALUES (?, ?)', [dreamId, tagId]); } catch {}
    }

    res.json({ message: '添加成功' });
  } catch (err) {
    console.error('[Dreams] POST /:dreamId/tags error:', err);
    res.status(500).json({ error: '添加标签失败' });
  }
});

// DELETE /api/dreams/:dreamId/tags/:tagId — 移除梦境的某个标签
router.delete('/:dreamId/tags/:tagId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { dreamId, tagId } = req.params;
    await getDatabase();

    // 验证梦境属于当前用户
    const dream = queryOne('SELECT id FROM dreams WHERE id = ? AND user_id = ?', [dreamId, userId]);
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    run('DELETE FROM dream_tags WHERE dream_id = ? AND tag_id = ?', [dreamId, tagId]);
    res.json({ message: '移除成功' });
  } catch (err) {
    console.error('[Dreams] DELETE /:dreamId/tags/:tagId error:', err);
    res.status(500).json({ error: '移除标签失败' });
  }
});

// GET /api/dreams/:dreamId/tags — 获取梦境的标签列表
router.get('/:dreamId/tags', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    const { dreamId } = req.params;
    await getDatabase();

    // 验证梦境属于当前用户
    const dream = queryOne('SELECT id FROM dreams WHERE id = ? AND user_id = ?', [dreamId, userId]);
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    const tags = queryAll(
      'SELECT t.* FROM tags t INNER JOIN dream_tags dt ON t.id = dt.tag_id WHERE dt.dream_id = ? ORDER BY t.created_at ASC',
      [dreamId]
    );
    res.json({ tags });
  } catch (err) {
    console.error('[Dreams] GET /:dreamId/tags error:', err);
    res.status(500).json({ error: '获取标签失败' });
  }
});

// POST /api/dreams/:id/narrative — 生成叙事
router.post('/:id/narrative', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const dream = queryOne('SELECT * FROM dreams WHERE id = ? AND user_id = ?', [req.params.id, userId]) as any;
    if (!dream) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }

    const narrative = generateNarrative(dream.content, dream.emotion);
    const now = new Date().toISOString();

    run('UPDATE dreams SET narrative = ?, updated_at = ? WHERE id = ?', [narrative, now, dream.id]);
    res.json({ narrative });
  } catch (err) {
    console.error('[Dreams] POST /:id/narrative error:', err);
    res.status(500).json({ error: '生成叙事失败' });
  }
});

export default router;
