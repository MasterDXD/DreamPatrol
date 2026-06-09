import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase, queryAll, queryOne, run } from '../db/database';
import { authMiddleware, TokenPayload } from '../middleware/auth';

const router = Router();

const createTagSchema = z.object({
  name: z.string().min(1, '标签名不能为空').max(20, '标签名最多20字符'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式无效').optional(),
});

const updateTagSchema = z.object({
  name: z.string().min(1, '标签名不能为空').max(20, '标签名最多20字符').optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式无效').optional(),
});

// GET /api/tags — 获取当前用户所有标签
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const tags = queryAll('SELECT * FROM tags WHERE user_id = ? ORDER BY created_at ASC', [userId]);
    res.json({ tags });
  } catch (err) {
    console.error('[Tags] GET / error:', err);
    res.status(500).json({ error: '获取标签列表失败' });
  }
});

// POST /api/tags — 创建标签
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parse = createTagSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { userId } = (req as any).user as TokenPayload;
    const { name, color } = parse.data;
    await getDatabase();

    // 检查同名标签是否已存在
    const existing = queryOne('SELECT id FROM tags WHERE user_id = ? AND name = ?', [userId, name.trim()]);
    if (existing) {
      res.status(409).json({ error: '标签名已存在' });
      return;
    }

    const id = crypto.randomUUID();
    run(
      'INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)',
      [id, userId, name.trim(), color || '#7EB8DA']
    );

    const tag = queryOne('SELECT * FROM tags WHERE id = ?', [id]);
    res.status(201).json({ tag });
  } catch (err) {
    console.error('[Tags] POST / error:', err);
    res.status(500).json({ error: '创建标签失败' });
  }
});

// PUT /api/tags/:id — 更新标签
router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parse = updateTagSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { userId } = (req as any).user as TokenPayload;
    const { name, color } = parse.data;
    await getDatabase();

    const existing = queryOne('SELECT * FROM tags WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (!existing) {
      res.status(404).json({ error: '标签不存在' });
      return;
    }

    // 如果修改了名称，检查是否重名
    if (name && name.trim() !== (existing as any).name) {
      const dup = queryOne('SELECT id FROM tags WHERE user_id = ? AND name = ? AND id != ?', [userId, name.trim(), req.params.id]);
      if (dup) {
        res.status(409).json({ error: '标签名已存在' });
        return;
      }
    }

    const newName = name ? name.trim() : (existing as any).name;
    const newColor = color || (existing as any).color;

    run('UPDATE tags SET name = ?, color = ? WHERE id = ? AND user_id = ?', [newName, newColor, req.params.id, userId]);

    const tag = queryOne('SELECT * FROM tags WHERE id = ?', [req.params.id]);
    res.json({ tag });
  } catch (err) {
    console.error('[Tags] PUT /:id error:', err);
    res.status(500).json({ error: '更新标签失败' });
  }
});

// DELETE /api/tags/:id — 删除标签（关联的 dream_tags 通过 CASCADE 自动删除）
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).user as TokenPayload;
    await getDatabase();

    const existing = queryOne('SELECT id FROM tags WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (!existing) {
      res.status(404).json({ error: '标签不存在' });
      return;
    }

    run('DELETE FROM tags WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('[Tags] DELETE /:id error:', err);
    res.status(500).json({ error: '删除标签失败' });
  }
});

export default router;
