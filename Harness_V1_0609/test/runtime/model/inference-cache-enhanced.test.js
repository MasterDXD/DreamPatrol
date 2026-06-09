'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { InferenceCache } = require(path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'model', 'inference-cache'));

describe('InferenceCache Enhanced - 缓存键标准化', () => {
  it('应将不同空白格式的Prompt标准化为同一缓存键', () => {
    const cache = new InferenceCache();
    cache.set('hello   world', 'result1');
    const hit = cache.get('hello world');
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应将不同引号风格的Prompt标准化为同一缓存键', () => {
    const cache = new InferenceCache();
    cache.set("say 'hello'", 'result1');
    const hit = cache.get('say "hello"');
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应将不同引号变体（中文引号、反引号）标准化为同一缓存键', () => {
    const cache = new InferenceCache();
    cache.set('say \u2018hello\u2019', 'result1');
    const hit = cache.get('say "hello"');
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应将中文双引号标准化为同一缓存键', () => {
    const cache = new InferenceCache();
    cache.set('say \u201Chello\u201D', 'result1');
    const hit = cache.get('say "hello"');
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应将反引号标准化为同一缓存键', () => {
    const cache = new InferenceCache();
    cache.set('say `hello`', 'result1');
    const hit = cache.get('say "hello"');
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应将键序不同的对象Prompt标准化为同一缓存键', () => {
    const cache = new InferenceCache();
    cache.set({ b: 2, a: 1 }, 'result1');
    const hit = cache.get({ a: 1, b: 2 });
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应忽略上下文中的易变字段（timestamp/requestId等）', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', { model: 'gpt-4', timestamp: 1000, requestId: 'abc' });
    const hit = cache.get('prompt1', { model: 'gpt-4', timestamp: 2000, requestId: 'xyz' });
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应忽略上下文中的updatedAt和createdAt字段', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', { model: 'gpt-4', updatedAt: 'old' });
    const hit = cache.get('prompt1', { model: 'gpt-4', updatedAt: 'new' });
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应保留上下文中的非易变字段用于区分缓存', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', { model: 'gpt-4' });
    const hit = cache.get('prompt1', { model: 'gpt-3.5' });
    assert.equal(hit, null);
  });

  it('应处理null和undefined上下文', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', null);
    const hit = cache.get('prompt1', undefined);
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应对嵌套对象进行键排序标准化', () => {
    const cache = new InferenceCache();
    cache.set({ outer: { b: 2, a: 1 } }, 'result1');
    const hit = cache.get({ outer: { a: 1, b: 2 } });
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应对长Prompt使用哈希键且仍能标准化命中', () => {
    const cache = new InferenceCache();
    const longPrompt1 = 'a '.repeat(200) + 'end';
    const longPrompt2 = 'a '.repeat(200) + 'end';
    cache.set(longPrompt1, 'result1');
    const hit = cache.get(longPrompt2);
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });
});

describe('InferenceCache Enhanced - 分层TTL策略', () => {
  it('冷数据（hitCount < 2）应在0.5倍TTL后过期', () => {
    const cache = new InferenceCache({ ttlMs: 100 });
    cache.set('cold-key', 'cold-result', null, 10);
    // 冷数据TTL = 100 * 0.5 = 50ms
    return new Promise(resolve => {
      setTimeout(() => {
        assert.equal(cache.get('cold-key'), null);
        resolve();
      }, 80);
    });
  });

  it('热数据（hitCount >= 5）应在2倍TTL后仍存活', () => {
    const cache = new InferenceCache({ ttlMs: 100 });
    cache.set('hot-key', 'hot-result', null, 10);
    // 连续命中5次使其变为热数据
    for (let i = 0; i < 5; i++) {
      cache.get('hot-key');
    }
    // 热数据TTL = 100 * 2 = 200ms，在120ms时仍应存活
    return new Promise(resolve => {
      setTimeout(() => {
        const hit = cache.get('hot-key');
        assert.ok(hit);
        assert.equal(hit.result, 'hot-result');
        resolve();
      }, 120);
    });
  });

  it('温数据（hitCount >= 2）应在默认TTL后过期', () => {
    const cache = new InferenceCache({ ttlMs: 100 });
    cache.set('warm-key', 'warm-result', null, 10);
    // 命中2次使其变为温数据
    cache.get('warm-key');
    cache.get('warm-key');
    // 温数据TTL = 100 * 1 = 100ms
    return new Promise(resolve => {
      setTimeout(() => {
        assert.equal(cache.get('warm-key'), null);
        resolve();
      }, 150);
    });
  });

  it('分层应在命中时动态升级', () => {
    const cache = new InferenceCache({ ttlMs: 100 });
    cache.set('upgrade-key', 'result', null, 10);
    // 初始为冷数据
    assert.equal(cache.get('upgrade-key').hitCount, 1);
    // 命中后hitCount=2，升级为温数据
    assert.equal(cache.get('upgrade-key').hitCount, 2);
    // 继续命中至热数据
    cache.get('upgrade-key');
    cache.get('upgrade-key');
    cache.get('upgrade-key');
    assert.equal(cache.get('upgrade-key').hitCount, 6);
  });

  it('_getTier应正确分类分层', () => {
    const cache = new InferenceCache();
    assert.equal(cache._getTier(0), 'cold');
    assert.equal(cache._getTier(1), 'cold');
    assert.equal(cache._getTier(2), 'warm');
    assert.equal(cache._getTier(4), 'warm');
    assert.equal(cache._getTier(5), 'hot');
    assert.equal(cache._getTier(100), 'hot');
  });

  it('_getEffectiveTtl应返回正确的分层TTL', () => {
    const cache = new InferenceCache({ ttlMs: 30000 });
    assert.equal(cache._getEffectiveTtl('hot'), 60000);
    assert.equal(cache._getEffectiveTtl('warm'), 30000);
    assert.equal(cache._getEffectiveTtl('cold'), 15000);
  });
});

describe('InferenceCache Enhanced - 缓存-成本闭环', () => {
  it('attachTokenManager应关联TokenManager', () => {
    const cache = new InferenceCache();
    const mockTm = { store: () => {} };
    assert.doesNotThrow(() => cache.attachTokenManager(mockTm));
  });

  it('缓存命中时应通过TokenManager记录节省的Token', () => {
    const cache = new InferenceCache();
    const recorded = [];
    const mockTm = {
      store: (sessionId, amount) => {
        recorded.push({ sessionId, amount });
      },
    };
    cache.attachTokenManager(mockTm);
    cache.set('prompt1', 'result1', null, 50);
    cache.get('prompt1');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].sessionId, '__inference_cache_savings');
    assert.equal(recorded[0].amount, 50);
  });

  it('多次命中应多次记录节省的Token', () => {
    const cache = new InferenceCache();
    const recorded = [];
    const mockTm = {
      store: (sessionId, amount) => {
        recorded.push({ sessionId, amount });
      },
    };
    cache.attachTokenManager(mockTm);
    cache.set('prompt1', 'result1', null, 30);
    cache.get('prompt1');
    cache.get('prompt1');
    cache.get('prompt1');
    assert.equal(recorded.length, 3);
    assert.equal(recorded[0].amount, 30);
    assert.equal(recorded[1].amount, 30);
    assert.equal(recorded[2].amount, 30);
  });

  it('未关联TokenManager时缓存命中应正常工作不报错', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', null, 50);
    const hit = cache.get('prompt1');
    assert.ok(hit);
    assert.equal(hit.tokensSaved, 50);
  });

  it('TokenManager抛出异常时不应影响缓存正常工作', () => {
    const cache = new InferenceCache();
    const mockTm = {
      store: () => { throw new Error('budget exceeded'); },
    };
    cache.attachTokenManager(mockTm);
    cache.set('prompt1', 'result1', null, 50);
    const hit = cache.get('prompt1');
    assert.ok(hit);
    assert.equal(hit.tokensSaved, 50);
  });
});

describe('InferenceCache Enhanced - 增强统计', () => {
  it('getStats应包含tokensSavedTotal字段', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', null, 100);
    cache.get('prompt1');
    cache.get('prompt1');
    const stats = cache.getStats();
    assert.ok('tokensSavedTotal' in stats);
    assert.equal(stats.tokensSavedTotal, 200);
  });

  it('getStats应包含costSavedEstimate字段', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', null, 1000);
    cache.get('prompt1');
    const stats = cache.getStats();
    assert.ok('costSavedEstimate' in stats);
    // 1000 tokens * $0.01 / 1000 = $0.01
    assert.equal(stats.costSavedEstimate, 0.01);
  });

  it('getStats应包含hitRateByTier字段', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', null, 10);
    cache.get('prompt1');
    cache.get('prompt1');
    const stats = cache.getStats();
    assert.ok('hitRateByTier' in stats);
    assert.ok('hot' in stats.hitRateByTier);
    assert.ok('warm' in stats.hitRateByTier);
    assert.ok('cold' in stats.hitRateByTier);
  });

  it('getStats应包含keyNormalizationHits字段', () => {
    const cache = new InferenceCache();
    const stats = cache.getStats();
    assert.ok('keyNormalizationHits' in stats);
    assert.equal(stats.keyNormalizationHits, 0);
  });

  it('tokensSavedTotal应累计已淘汰条目的节省量', () => {
    const cache = new InferenceCache({ maxSize: 1 });
    cache.set('prompt1', 'result1', null, 100);
    cache.get('prompt1');
    // 写入新条目会淘汰旧条目
    cache.set('prompt2', 'result2', null, 50);
    const stats = cache.getStats();
    // tokensSavedTotal包含已淘汰条目的节省量
    assert.equal(stats.tokensSavedTotal, 100);
  });

  it('costSavedEstimate应为0当无缓存命中时', () => {
    const cache = new InferenceCache();
    const stats = cache.getStats();
    assert.equal(stats.costSavedEstimate, 0);
  });

  it('hitRateByTier各分层初始应为0', () => {
    const cache = new InferenceCache();
    const stats = cache.getStats();
    assert.equal(stats.hitRateByTier.hot, 0);
    assert.equal(stats.hitRateByTier.warm, 0);
    assert.equal(stats.hitRateByTier.cold, 0);
  });

  it('关机后getStats应返回安全的默认值', () => {
    const cache = new InferenceCache();
    cache.shutdown();
    const stats = cache.getStats();
    assert.equal(stats.size, 0);
    assert.equal(stats.tokensSavedTotal, 0);
    assert.equal(stats.costSavedEstimate, 0);
    assert.equal(stats.keyNormalizationHits, 0);
    assert.deepEqual(stats.hitRateByTier, { hot: 0, warm: 0, cold: 0 });
  });
});

describe('InferenceCache Enhanced - 边界条件', () => {
  it('应处理空字符串Prompt', () => {
    const cache = new InferenceCache();
    cache.set('', 'empty-result');
    const hit = cache.get('');
    assert.ok(hit);
    assert.equal(hit.result, 'empty-result');
  });

  it('应处理null Prompt', () => {
    const cache = new InferenceCache();
    cache.set(null, 'null-result');
    const hit = cache.get(null);
    assert.ok(hit);
    assert.equal(hit.result, 'null-result');
  });

  it('应处理空对象上下文', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', {});
    const hit = cache.get('prompt1', {});
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应处理仅含易变字段的上下文', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', 'result1', { timestamp: 1000 });
    const hit = cache.get('prompt1', { timestamp: 2000 });
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应处理数组Prompt的标准化', () => {
    const cache = new InferenceCache();
    cache.set(['a', 'b'], 'result1');
    const hit = cache.get(['a', 'b']);
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应处理不可序列化的Prompt回退到String转换', () => {
    const cache = new InferenceCache();
    const obj = { toString() { return 'custom-prompt'; } };
    cache.set(obj, 'result1');
    const hit = cache.get(obj);
    assert.ok(hit);
    assert.equal(hit.result, 'result1');
  });

  it('应处理tokenEstimate为0的条目', () => {
    const cache = new InferenceCache();
    cache.set('zero-tokens', 'result', null, 0);
    const hit = cache.get('zero-tokens');
    assert.ok(hit);
    assert.equal(hit.tokensSaved, 0);
    const stats = cache.getStats();
    assert.equal(stats.tokensSavedTotal, 0);
    assert.equal(stats.costSavedEstimate, 0);
  });

  it('应处理大量缓存条目的分层统计', () => {
    const cache = new InferenceCache({ maxSize: 100 });
    for (let i = 0; i < 50; i++) {
      cache.set('prompt-' + i, 'result-' + i, null, 10);
    }
    // 对前10个条目命中5次以上使其变为热数据
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 10; i++) {
        cache.get('prompt-' + i);
      }
    }
    const stats = cache.getStats();
    assert.ok(stats.hitRateByTier.hot > 0);
    assert.equal(stats.size, 50);
  });

  it('标准化方法不应修改原始输入', () => {
    const cache = new InferenceCache();
    const originalPrompt = '  hello   world  ';
    const originalContext = { b: 2, a: 1, timestamp: 999 };
    cache.set(originalPrompt, 'result1', originalContext);
    // 验证原始值未被修改
    assert.equal(originalPrompt, '  hello   world  ');
    assert.deepEqual(originalContext, { b: 2, a: 1, timestamp: 999 });
  });
});

describe('InferenceCache Enhanced - 向后兼容', () => {
  it('应保持原有get/set/invalidate/clear/getStats方法签名', () => {
    const cache = new InferenceCache();
    cache.set('p1', 'r1');
    const hit = cache.get('p1');
    assert.ok(hit);
    assert.equal(hit.result, 'r1');
    assert.equal(typeof hit.tokensSaved, 'number');
    assert.equal(typeof hit.hitCount, 'number');

    const invalidated = cache.invalidate('p1');
    assert.equal(invalidated, true);
    assert.equal(cache.get('p1'), null);

    cache.set('p2', 'r2');
    cache.clear();
    assert.equal(cache.getStats().size, 0);
  });

  it('原有测试用例应继续通过', () => {
    const cache = new InferenceCache();
    cache.set('prompt1', { answer: 'yes' });
    const result = cache.get('prompt1');
    assert.ok(result);
    assert.deepEqual(result.result, { answer: 'yes' });
  });

  it('原有TTL过期行为应保持兼容', () => {
    const cache = new InferenceCache({ ttlMs: 1 });
    cache.set('prompt1', 'result1');
    return new Promise(resolve => {
      setTimeout(() => {
        assert.equal(cache.get('prompt1'), null);
        resolve();
      }, 50);
    });
  });

  it('原有LRU淘汰行为应保持兼容', () => {
    const cache = new InferenceCache({ maxSize: 2 });
    cache.set('first', 'r1');
    cache.set('second', 'r2');
    cache.set('third', 'r3');
    assert.equal(cache.get('first'), null);
    assert.ok(cache.get('third'));
  });
});
