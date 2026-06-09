import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { isBlacklisted } from './tokenBlacklist';
import { queryOne } from '../db/database';

const JWT_SECRET: string = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  console.error('[Auth] FATAL: JWT_SECRET environment variable is not set. Server cannot start securely.');
  process.exit(1);
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export interface TokenPayload {
  userId: string;
  username: string;
  role: string;
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as unknown as TokenPayload;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供认证Token' });
    return;
  }

  try {
    const token = authHeader.substring(7);
    // 检查token是否在黑名单中
    if (isBlacklisted(token)) {
      res.status(401).json({ error: 'Token已失效' });
      return;
    }
    const payload = verifyToken(token);

    // 检查用户是否在密码修改后使旧 session 失效
    const user = queryOne('SELECT token_invalidated_before FROM users WHERE id = ?', [payload.userId]) as any;
    if (user?.token_invalidated_before) {
      const invalidatedAt = new Date(user.token_invalidated_before).getTime() / 1000;
      const tokenIssuedAt = (jwt.decode(token) as any)?.iat ?? 0;
      if (tokenIssuedAt < invalidatedAt) {
        res.status(401).json({ error: '密码已修改，请重新登录' });
        return;
      }
    }

    (req as any).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token无效或已过期' });
  }
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as TokenPayload | undefined;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}
