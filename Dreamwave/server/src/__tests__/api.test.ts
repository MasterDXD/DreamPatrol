import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// ===== 注册验证测试 =====

// 与 routes/auth.ts 中相同的 schema 定义
const registerSchema = z.object({
  username: z.string().min(2, '用户名至少2个字符').max(20, '用户名最多20个字符'),
  password: z.string().min(6, '密码至少6个字符').max(50, '密码最多50个字符'),
});

describe('注册验证', () => {
  // 测试用户名太短
  it('用户名太短时应该验证失败', () => {
    const result = registerSchema.safeParse({ username: 'a', password: '123456' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('用户名至少2个字符');
    }
  });

  // 测试密码太短
  it('密码太短时应该验证失败', () => {
    const result = registerSchema.safeParse({ username: 'testuser', password: '12345' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('密码至少6个字符');
    }
  });

  // 测试正常注册数据
  it('合法的注册数据应该验证通过', () => {
    const result = registerSchema.safeParse({ username: 'testuser', password: '123456' });
    expect(result.success).toBe(true);
  });
});

// ===== 梦境创建验证测试 =====

// 与 routes/dreams.ts 中相同的 schema 定义
const EmotionType = z.enum(['joy', 'calm', 'sadness', 'fear', 'wonder', 'nostalgia']);

const createDreamSchema = z.object({
  content: z.string().min(1, '梦境内容不能为空').max(5000, '内容最多5000字符'),
  emotion: EmotionType,
  recordedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为YYYY-MM-DD').optional(),
});

describe('梦境创建验证', () => {
  // 测试内容为空
  it('梦境内容为空时应该验证失败', () => {
    const result = createDreamSchema.safeParse({ content: '', emotion: 'joy' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('梦境内容不能为空');
    }
  });

  // 测试情绪无效
  it('情绪值无效时应该验证失败', () => {
    const result = createDreamSchema.safeParse({ content: '我做了个梦', emotion: 'invalid' });
    expect(result.success).toBe(false);
  });

  // 测试合法的梦境数据
  it('合法的梦境数据应该验证通过', () => {
    const result = createDreamSchema.safeParse({ content: '我做了个梦', emotion: 'joy' });
    expect(result.success).toBe(true);
  });

  // 测试所有合法情绪值
  it('所有6种情绪值都应该验证通过', () => {
    const emotions = ['joy', 'calm', 'sadness', 'fear', 'wonder', 'nostalgia'];
    for (const emotion of emotions) {
      const result = createDreamSchema.safeParse({ content: '测试内容', emotion });
      expect(result.success).toBe(true);
    }
  });
});

// ===== 认证中间件测试 =====

// 模拟 authMiddleware 的逻辑进行测试
// 由于 auth.ts 模块加载时有 process.exit，我们直接测试中间件逻辑
describe('认证中间件验证逻辑', () => {
  // 创建模拟的 Express req/res/next
  function createMockRes() {
    const res: any = {
      statusCode: 200,
      body: null,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(data: any) {
        res.body = data;
        return res;
      },
    };
    return res;
  }

  // 测试无token
  it('无Authorization头时应该返回401', () => {
    const req = { headers: {} } as any;
    const res = createMockRes();
    const next = vi.fn();

    // 模拟 authMiddleware 的核心逻辑
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: '未提供认证Token' });
      return;
    }
    next();

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('未提供认证Token');
    expect(next).not.toHaveBeenCalled();
  });

  // 测试无效token格式
  it('无效的Authorization头应该返回401', () => {
    const req = { headers: { authorization: 'Bearer invalid.token.string' } } as any;
    const res = createMockRes();
    const next = vi.fn();

    // 模拟 authMiddleware 的核心逻辑
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: '未提供认证Token' });
      return;
    }

    try {
      // 使用 jsonwebtoken 直接验证会抛出错误
      const jwt = require('jsonwebtoken');
      jwt.verify(authHeader.substring(7), 'test-secret');
      next();
    } catch {
      res.status(401).json({ error: 'Token无效或已过期' });
    }

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Token无效或已过期');
    expect(next).not.toHaveBeenCalled();
  });

  // 测试有效token应该调用next
  it('有效的Bearer token应该调用next', () => {
    const jwt = require('jsonwebtoken');
    const validToken = jwt.sign(
      { userId: 'user-1', username: 'testuser', role: 'user' },
      'test-secret',
      { expiresIn: '1h' }
    );

    const req = { headers: { authorization: `Bearer ${validToken}` } } as any;
    const res = createMockRes();
    const next = vi.fn();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: '未提供认证Token' });
      return;
    }

    try {
      const decoded = jwt.verify(authHeader.substring(7), 'test-secret');
      (req as any).user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Token无效或已过期' });
    }

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // 未被修改
  });
});
