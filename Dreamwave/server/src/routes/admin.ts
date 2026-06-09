import { Router, Request, Response } from 'express';
import { getDatabase, queryAll, queryOne, run } from '../db/database';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { auditLog } from '../middleware/auditLog';

const router = Router();

// GET /api/admin/stats/trends — 趋势数据
router.get('/stats/trends', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    await getDatabase();

    // 近7天梦境数量
    const recentDreams = queryAll(
      "SELECT recorded_date as date, COUNT(*) as count FROM dreams WHERE recorded_date >= date('now', '-7 days') GROUP BY recorded_date ORDER BY recorded_date ASC"
    );

    // 近7天新用户数量
    const recentUsers = queryAll(
      "SELECT date(created_at) as date, COUNT(*) as count FROM users WHERE role = 'user' AND created_at >= datetime('now', '-7 days') GROUP BY date(created_at) ORDER BY date ASC"
    );

    // 情绪分布
    const emotionDistribution = queryAll(
      'SELECT emotion, COUNT(*) as count FROM dreams GROUP BY emotion ORDER BY count DESC'
    );

    res.json({ recentDreams, recentUsers, emotionDistribution });
  } catch (err) {
    console.error('[Admin] GET /stats/trends error:', err);
    res.status(500).json({ error: '获取趋势数据失败' });
  }
});

// GET /api/admin/stats
router.get('/stats', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    await getDatabase();
    const totalDreams = (queryOne('SELECT COUNT(*) as count FROM dreams') as any)?.count || 0;
    const totalUsers = (queryOne('SELECT COUNT(*) as count FROM users WHERE role = ?', ['user']) as any)?.count || 0;
    const activeUsers = (queryOne('SELECT COUNT(*) as count FROM users WHERE role = ? AND is_active = 1', ['user']) as any)?.count || 0;
    const emotionDistribution = queryAll('SELECT emotion, COUNT(*) as count FROM dreams GROUP BY emotion ORDER BY count DESC');
    const today = new Date().toISOString().slice(0, 10);
    const todayDreams = (queryOne('SELECT COUNT(*) as count FROM dreams WHERE recorded_date = ?', [today]) as any)?.count || 0;
    res.json({ totalDreams, totalUsers, activeUsers, todayDreams, emotionDistribution });
  } catch (err) {
    console.error('[Admin] GET /stats error:', err);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

// GET /api/admin/dreams
router.get('/dreams', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', search = '' } = req.query;
    await getDatabase();

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let sql = 'SELECT d.*, u.username FROM dreams d JOIN users u ON d.user_id = u.id';
    let countSql = 'SELECT COUNT(*) as total FROM dreams d';
    const params: any[] = [];

    if (search) {
      const escapedSearch = String(search).replace(/[%_]/g, '\\$&');
      sql += ' WHERE d.title LIKE ? OR d.content LIKE ?';
      countSql += ' WHERE d.title LIKE ? OR d.content LIKE ?';
      params.push(`%${escapedSearch}%`, `%${escapedSearch}%`);
    }

    const total = (queryOne(countSql, params) as any)?.total || 0;
    const dreams = queryAll(`${sql} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`, [...params, limitNum, offset]);
    res.json({ dreams, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[Admin] GET /dreams error:', err);
    res.status(500).json({ error: '获取梦境列表失败' });
  }
});

// GET /api/admin/users
router.get('/users', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    await getDatabase();
    const users = queryAll(
      `SELECT u.id, u.username, u.role, u.is_active, u.created_at,
              (SELECT COUNT(*) FROM dreams WHERE user_id = u.id) as dream_count
       FROM users u WHERE u.role = 'user' ORDER BY u.created_at DESC`
    );
    res.json({ users });
  } catch (err) {
    console.error('[Admin] GET /users error:', err);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// PUT /api/admin/users/:id/status
router.put('/users/:id/status', authMiddleware, adminMiddleware, auditLog('更新用户状态', 'user'), async (req: Request, res: Response) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive 必须为布尔值' });
      return;
    }
    await getDatabase();
    const existing = queryOne('SELECT id FROM users WHERE id = ? AND role = ?', [req.params.id, 'user']);
    if (!existing) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    run('UPDATE users SET is_active = ?, updated_at = datetime("now") WHERE id = ? AND role = ?',
      [isActive ? 1 : 0, req.params.id, 'user']);
    res.json({ message: '状态更新成功' });
  } catch (err) {
    console.error('[Admin] PUT /users/:id/status error:', err);
    res.status(500).json({ error: '更新用户状态失败' });
  }
});

// DELETE /api/admin/dreams/:id
router.delete('/dreams/:id', authMiddleware, adminMiddleware, auditLog('删除梦境', 'dream'), async (req: Request, res: Response) => {
  try {
    await getDatabase();
    const existing = queryOne('SELECT id FROM dreams WHERE id = ?', [req.params.id]);
    if (!existing) {
      res.status(404).json({ error: '梦境不存在' });
      return;
    }
    run('DELETE FROM dreams WHERE id = ?', [req.params.id]);
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('[Admin] DELETE /dreams/:id error:', err);
    res.status(500).json({ error: '删除梦境失败' });
  }
});

// GET /api/admin/logs — 获取操作日志
router.get('/logs', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', action } = req.query;
    await getDatabase();

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let countSql = 'SELECT COUNT(*) as total FROM operation_logs';
    let listSql = 'SELECT ol.*, u.username FROM operation_logs ol LEFT JOIN users u ON ol.user_id = u.id';
    const params: any[] = [];

    if (action && typeof action === 'string' && action.trim()) {
      countSql += ' WHERE ol.action LIKE ?';
      listSql += ' WHERE ol.action LIKE ?';
      params.push(`%${action.trim()}%`);
    }

    const total = (queryOne(countSql, params) as any)?.total || 0;
    const logs = queryAll(
      `${listSql} ORDER BY ol.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ logs, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[Admin] GET /logs error:', err);
    res.status(500).json({ error: '获取操作日志失败' });
  }
});

// GET /api/admin/ai-config — 获取 AI 全局配置
router.get('/ai-config', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    await getDatabase();
    const rows = queryAll('SELECT key, value FROM ai_config');
    const config: Record<string, string> = {};
    for (const row of rows) {
      config[(row as any).key] = (row as any).value;
    }
    res.json({ config });
  } catch (err) {
    console.error('[Admin] GET /ai-config error:', err);
    res.status(500).json({ error: '获取AI配置失败' });
  }
});

// PUT /api/admin/ai-config — 更新 AI 全局配置
router.put('/ai-config', authMiddleware, adminMiddleware, auditLog('更新AI配置', 'ai_config'), async (req: Request, res: Response) => {
  try {
    await getDatabase();
    const updates = req.body as Record<string, string>;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: '无效的配置数据' });
      return;
    }
    const allowedKeys = ['api_key', 'image_model', 'image_size', 'image_resolution', 'image_format', 'chat_model', 'chat_temperature', 'system_prompt'];
    for (const [key, value] of Object.entries(updates)) {
      if (allowedKeys.includes(key)) {
        run(
          'INSERT INTO ai_config (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime("now")',
          [key, String(value), String(value)]
        );
      }
    }
    res.json({ message: '配置更新成功' });
  } catch (err) {
    console.error('[Admin] PUT /ai-config error:', err);
    res.status(500).json({ error: '更新AI配置失败' });
  }
});

// GET /api/admin/ai-call-logs — 获取 AI 调用记录列表
router.get('/ai-call-logs', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', call_type, status } = req.query;
    await getDatabase();

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const params: any[] = [];

    if (call_type && typeof call_type === 'string' && call_type.trim()) {
      conditions.push('acl.call_type = ?');
      params.push(call_type.trim());
    }
    if (status && typeof status === 'string' && status.trim()) {
      conditions.push('acl.status = ?');
      params.push(status.trim());
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const total = (queryOne(`SELECT COUNT(*) as total FROM ai_call_logs acl ${whereClause}`, params) as any)?.total || 0;
    const logs = queryAll(
      `SELECT acl.*, u.username FROM ai_call_logs acl LEFT JOIN users u ON acl.user_id = u.id ${whereClause} ORDER BY acl.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ logs, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[Admin] GET /ai-call-logs error:', err);
    res.status(500).json({ error: '获取AI调用记录失败' });
  }
});

// GET /api/admin/ai-call-logs/:id — 获取 AI 调用记录详情
router.get('/ai-call-logs/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    await getDatabase();
    const log = queryOne(
      'SELECT acl.*, u.username FROM ai_call_logs acl LEFT JOIN users u ON acl.user_id = u.id WHERE acl.id = ?',
      [req.params.id]
    );
    if (!log) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    res.json({ log });
  } catch (err) {
    console.error('[Admin] GET /ai-call-logs/:id error:', err);
    res.status(500).json({ error: '获取AI调用记录详情失败' });
  }
});

export default router;
