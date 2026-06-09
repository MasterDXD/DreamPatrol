import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import crypto from 'crypto';
import { getDatabase, queryOne, run } from '../db/database';
import { generateToken, authMiddleware, TokenPayload } from '../middleware/auth';
import { addToBlacklist } from '../middleware/tokenBlacklist';

const router = Router();

const registerSchema = z.object({
  username: z.string().min(2, '用户名至少2个字符').max(20, '用户名最多20个字符'),
  password: z.string().min(6, '密码至少6个字符').max(50, '密码最多50个字符'),
});

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '当前密码不能为空'),
  newPassword: z.string().min(6, '新密码至少6个字符').max(50, '新密码最多50个字符'),
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const parse = registerSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { username, password } = parse.data;
    await getDatabase();

    const existing = queryOne('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      res.status(400).json({ error: '用户名已存在' });
      return;
    }

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);
    run('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)', [id, username, passwordHash]);

    const token = generateToken({ userId: id, username, role: 'user' });
    res.status(201).json({ user: { id, username }, token });
  } catch (err) {
    console.error('[Auth] POST /register error:', err);
    res.status(500).json({ error: '注册失败，请稍后再试' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const parse = loginSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { username, password } = parse.data;
    await getDatabase();

    const user = queryOne('SELECT id, username, password_hash, role, is_active FROM users WHERE username = ?', [username]) as any;
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: '账户已被禁用' });
      return;
    }

    const token = generateToken({ userId: user.id, username: user.username, role: user.role });
    res.json({ user: { id: user.id, username: user.username, role: user.role }, token });
  } catch (err) {
    console.error('[Auth] POST /login error:', err);
    res.status(500).json({ error: '登录失败，请稍后再试' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (_req: Request, res: Response) => {
  const { userId, username } = (_req as any).user as TokenPayload;
  const row = queryOne(
    'SELECT id, username, created_at, avatar FROM users WHERE id = ?',
    [userId]
  ) as { id: string; username: string; created_at: string; avatar: string | null } | undefined;
  if (!row) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json({
    id: row.id,
    username: row.username,
    created_at: row.created_at,
    avatar: row.avatar,
  });
});

// PUT /api/auth/me — 更新当前用户信息（目前只支持 avatar）
const updateProfileSchema = z.object({
  avatar: z.string().min(1).max(500000).optional(),
});
router.put('/me', authMiddleware, (req: Request, res: Response) => {
  const parse = updateProfileSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues[0].message });
    return;
  }
  const { userId } = (req as any).user as TokenPayload;
  const updates: string[] = [];
  const params: any[] = [];
  if (parse.data.avatar !== undefined) {
    updates.push('avatar = ?');
    params.push(parse.data.avatar);
  }
  if (updates.length === 0) {
    res.status(400).json({ error: '没有要更新的字段' });
    return;
  }
  updates.push('updated_at = datetime("now")');
  params.push(userId);
  run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: '更新成功' });
});

// POST /api/auth/logout — 登出（将token加入黑名单）
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    addToBlacklist(token);
  }
  res.json({ message: '登出成功' });
});

// POST /api/auth/refresh — 刷新Token（签发新token）
router.post('/refresh', authMiddleware, (req: Request, res: Response) => {
  const { userId, username, role } = (req as any).user as TokenPayload;
  // 将旧token加入黑名单
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const oldToken = authHeader.substring(7);
    addToBlacklist(oldToken);
  }
  const newToken = generateToken({ userId, username, role });
  res.json({ token: newToken });
});

// PUT /api/auth/password — 修改密码
router.put('/password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parse = changePasswordSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }

    const { userId } = (req as any).user as TokenPayload;
    const { currentPassword, newPassword } = parse.data;
    await getDatabase();

    const user = queryOne('SELECT password_hash FROM users WHERE id = ?', [userId]) as any;
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      res.status(400).json({ error: '当前密码错误' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    run('UPDATE users SET password_hash = ?, token_invalidated_before = datetime("now"), updated_at = datetime("now") WHERE id = ?', [newHash, userId]);

    // 将当前token加入黑名单，强制重新登录
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      addToBlacklist(authHeader.substring(7));
    }

    res.json({ message: '密码修改成功，请重新登录' });
  } catch (err) {
    console.error('[Auth] PUT /password error:', err);
    res.status(500).json({ error: '修改密码失败' });
  }
});

export default router;
