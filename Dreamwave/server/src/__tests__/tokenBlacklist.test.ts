import { describe, it, expect, beforeEach } from 'vitest';
import { addToBlacklist, isBlacklisted } from '../middleware/tokenBlacklist';

// 注意：tokenBlacklist使用模块级Set，每个测试文件共享同一个模块实例
// 为了测试隔离，我们使用不同的token值

describe('tokenBlacklist', () => {
  // 每个测试使用唯一的token，避免测试间干扰
  const uniquePrefix = `test-${Date.now()}-`;

  // 添加后能查到
  it('添加token到黑名单后应该能查询到', () => {
    const token = `${uniquePrefix}token-to-add`;
    addToBlacklist(token);
    expect(isBlacklisted(token)).toBe(true);
  });

  // 未添加的token返回false
  it('未添加到黑名单的token应该返回false', () => {
    const token = `${uniquePrefix}token-not-added-${Math.random()}`;
    expect(isBlacklisted(token)).toBe(false);
  });
});
