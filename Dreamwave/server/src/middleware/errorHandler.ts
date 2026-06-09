import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  console.error(`[Error] ${req.method} ${req.path}:`, err.message);

  // Zod 校验错误
  if (err instanceof ZodError) {
    res.status(400).json({
      error: err.issues[0]?.message || '请求参数错误',
      code: 'VALIDATION_ERROR',
      details: err.issues,
    });
    return;
  }

  // JWT 错误
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({
      error: err.name === 'TokenExpiredError' ? 'Token已过期' : 'Token无效',
      code: 'AUTH_ERROR',
    });
    return;
  }

  // CORS 错误
  if (err.message === 'CORS not allowed') {
    res.status(403).json({ error: '跨域请求被拒绝', code: 'CORS_ERROR' });
    return;
  }

  // 默认服务器错误
  res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
}
