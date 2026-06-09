import { Request, Response, NextFunction } from 'express';
import { getDatabase, run } from '../db/database';

// 敏感字段列表，审计日志中脱敏
const SENSITIVE_FIELDS = new Set(['password', 'currentPassword', 'newPassword', 'confirmPassword', 'api_key', 'apiKey']);

function sanitizeBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const sanitized = { ...body };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.has(key)) {
      sanitized[key] = '***';
    }
  }
  return sanitized;
}

// 审计日志中间件，记录管理员操作
export function auditLog(action: string, targetType?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // 拦截响应完成事件，记录操作
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // 只在成功时记录
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const user = (req as any).user;
        if (user) {
          const id = crypto.randomUUID();
          const targetId = req.params.id || req.params.dreamId || req.params.userId || null;
          const detail = JSON.stringify({
            method: req.method,
            path: req.path,
            body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined,
          });
          const ip = req.ip || req.socket.remoteAddress || null;

          getDatabase().then(() => {
            try {
              run(
                'INSERT INTO operation_logs (id, user_id, action, target_type, target_id, detail, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [id, user.userId, action, targetType || null, targetId, detail, ip]
              );
            } catch (err) {
              console.error('[AuditLog] 记录操作日志失败:', err);
            }
          }).catch((err) => {
            console.error('[AuditLog] 数据库获取失败:', err);
          });
        }
      }
      return originalJson(body);
    };
    next();
  };
}
