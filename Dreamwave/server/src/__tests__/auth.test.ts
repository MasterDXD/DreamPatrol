// 在导入auth模块之前设置JWT_SECRET，避免模块加载时process.exit(1)
process.env.JWT_SECRET = 'test-secret-for-unit-testing';

import { describe, it, expect } from 'vitest';
import { generateToken, verifyToken } from '../middleware/auth';

describe('generateToken', () => {
  // 测试生成token
  it('应该生成一个非空字符串token', () => {
    const payload = { userId: 'user-1', username: 'testuser', role: 'user' };
    const token = generateToken(payload);
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // JWT格式：header.payload.signature
  });
});

describe('verifyToken', () => {
  // 测试验证有效token
  it('应该正确解析有效的token', () => {
    const payload = { userId: 'user-1', username: 'testuser', role: 'user' };
    const token = generateToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe('user-1');
    expect(decoded.username).toBe('testuser');
    expect(decoded.role).toBe('user');
  });

  // 测试无效token抛出错误
  it('无效token应该抛出错误', () => {
    expect(() => verifyToken('invalid.token.string')).toThrow();
  });

  it('空字符串token应该抛出错误', () => {
    expect(() => verifyToken('')).toThrow();
  });
});
