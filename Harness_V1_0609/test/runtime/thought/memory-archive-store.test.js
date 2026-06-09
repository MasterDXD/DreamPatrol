'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const MemoryArchiveStore = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-archive-store'));

describe('MemoryArchiveStore - 构造函数', () => {
  it('应使用默认配置创建实例', () => {
    const store = new MemoryArchiveStore();
    assert.ok(store);
    assert.strictEqual(store._config.workingTTL, 30 * 60 * 1000);
    assert.strictEqual(store._config.longTermTTL, 30 * 24 * 60 * 60 * 1000);
    assert.strictEqual(store._config.workingCapacity, 500);
    assert.strictEqual(store._config.longTermCapacity, 5000);
    assert.strictEqual(store._config.archiveCapacity, 50000);
    assert.strictEqual(store._config.promotionThreshold, 3);
    assert.strictEqual(store._config.autoPromotionInterval, 5 * 60 * 1000);
    assert.strictEqual(store._config.enableAutoPromotion, true);
    assert.strictEqual(store._config.enableAutoArchive, true);
    store.shutdown();
  });

  it('应合并自定义选项与默认配置', () => {
    const store = new MemoryArchiveStore({
      workingCapacity: 100,
      promotionThreshold: 5,
      enableAutoPromotion: false,
    });
    assert.strictEqual(store._config.workingCapacity, 100);
    assert.strictEqual(store._config.promotionThreshold, 5);
    assert.strictEqual(store._config.enableAutoPromotion, false);
    // 未覆盖的配置保持默认
    assert.strictEqual(store._config.longTermCapacity, 5000);
    assert.strictEqual(store._config.archiveCapacity, 50000);
    store.shutdown();
  });

  it('应暴露静态常量 MEMORY_TIERS、PROMOTION_RULES、DEFAULT_CONFIG', () => {
    assert.ok(MemoryArchiveStore.MEMORY_TIERS);
    assert.strictEqual(MemoryArchiveStore.MEMORY_TIERS.WORKING, 'working');
    assert.strictEqual(MemoryArchiveStore.MEMORY_TIERS.LONG_TERM, 'long_term');
    assert.strictEqual(MemoryArchiveStore.MEMORY_TIERS.ARCHIVE, 'archive');

    assert.ok(MemoryArchiveStore.PROMOTION_RULES);
    assert.strictEqual(MemoryArchiveStore.PROMOTION_RULES.WORKING_TO_LONG_TERM, 'working_to_long_term');
    assert.strictEqual(MemoryArchiveStore.PROMOTION_RULES.LONG_TERM_TO_ARCHIVE, 'long_term_to_archive');

    assert.ok(MemoryArchiveStore.DEFAULT_CONFIG);
    assert.strictEqual(MemoryArchiveStore.DEFAULT_CONFIG.workingCapacity, 500);
    assert.strictEqual(MemoryArchiveStore.DEFAULT_CONFIG.promotionThreshold, 3);
  });
});

describe('MemoryArchiveStore - attach方法', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('attachMemoryStore 应成功附加有效的MemoryStore实例', () => {
    const mockStore = { addKnowledge() {} };
    const result = store.attachMemoryStore(mockStore);
    assert.strictEqual(result, true);
    assert.strictEqual(store._attached.memoryStore, true);
    assert.strictEqual(store._ms, mockStore);
  });

  it('attachMemoryStore 无效参数应抛出TypeError', () => {
    assert.throws(() => store.attachMemoryStore(null), TypeError);
    assert.throws(() => store.attachMemoryStore(undefined), TypeError);
    assert.throws(() => store.attachMemoryStore('string'), TypeError);
  });

  it('attachMemoryStore 缺少addKnowledge方法应返回false', () => {
    const result = store.attachMemoryStore({ wrongMethod() {} });
    assert.strictEqual(result, false);
    assert.strictEqual(store._attached.memoryStore, false);
  });

  it('attachBrainMemory 应成功附加有效的BrainMemory实例', () => {
    const mockBM = { store() {} };
    const result = store.attachBrainMemory(mockBM);
    assert.strictEqual(result, true);
    assert.strictEqual(store._attached.brainMemory, true);
    assert.strictEqual(store._bm, mockBM);
  });

  it('attachBrainMemory 无效参数应抛出TypeError', () => {
    assert.throws(() => store.attachBrainMemory(null), TypeError);
    assert.throws(() => store.attachBrainMemory(undefined), TypeError);
  });

  it('attachBrainMemory 缺少store方法应返回false', () => {
    const result = store.attachBrainMemory({ wrongMethod() {} });
    assert.strictEqual(result, false);
    assert.strictEqual(store._attached.brainMemory, false);
  });
});

describe('MemoryArchiveStore - store', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('应存储条目到working层（默认层级）', () => {
    const entry = store.store('key1', { data: 'value1' });
    assert.ok(entry);
    assert.strictEqual(entry.key, 'key1');
    assert.deepStrictEqual(entry.value, { data: 'value1' });
    assert.strictEqual(entry.tier, 'working');
    assert.strictEqual(entry.accessCount, 0);
    assert.ok(entry.id);
    assert.ok(entry.createdAt > 0);
    assert.ok(entry.lastAccessedAt > 0);
    assert.deepStrictEqual(entry.metadata, {});
  });

  it('应存储条目到指定层级', () => {
    const entry = store.store('key2', 'val2', { tier: 'long_term' });
    assert.ok(entry);
    assert.strictEqual(entry.tier, 'long_term');

    const entryArchive = store.store('key3', 'val3', { tier: 'archive' });
    assert.ok(entryArchive);
    assert.strictEqual(entryArchive.tier, 'archive');
  });

  it('store 应触发 memory-stored 事件', () => {
    let eventData = null;
    store.on('memory-stored', (data) => { eventData = data; });
    const entry = store.store('event-key', 'event-val');
    assert.ok(eventData);
    assert.strictEqual(eventData.entryId, entry.id);
    assert.strictEqual(eventData.key, 'event-key');
    assert.strictEqual(eventData.tier, 'working');
  });

  it('应存储带metadata的条目', () => {
    const entry = store.store('meta-key', 'meta-val', {
      tier: 'working',
      metadata: { source: 'test', priority: 1 },
    });
    assert.ok(entry);
    assert.strictEqual(entry.metadata.source, 'test');
    assert.strictEqual(entry.metadata.priority, 1);
  });

  it('无效key应返回null', () => {
    assert.strictEqual(store.store('', 'val'), null);
    assert.strictEqual(store.store(null, 'val'), null);
    assert.strictEqual(store.store(123, 'val'), null);
  });

  it('无效tier应返回null', () => {
    assert.strictEqual(store.store('key', 'val', { tier: 'invalid' }), null);
  });
});

describe('MemoryArchiveStore - retrieve', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('应从working层检索条目', () => {
    store.store('rkey1', 'rval1');
    const entry = store.retrieve('rkey1');
    assert.ok(entry);
    assert.strictEqual(entry.key, 'rkey1');
    assert.strictEqual(entry.value, 'rval1');
  });

  it('retrieve 应递增accessCount', () => {
    store.store('rkey2', 'rval2');
    const entry1 = store.retrieve('rkey2');
    assert.strictEqual(entry1.accessCount, 1);
    const entry2 = store.retrieve('rkey2');
    assert.strictEqual(entry2.accessCount, 2);
  });

  it('未知key应返回null', () => {
    assert.strictEqual(store.retrieve('nonexistent'), null);
    assert.strictEqual(store.retrieve(''), null);
    assert.strictEqual(store.retrieve(null), null);
  });

  it('应按优先级搜索：working → long_term → archive', () => {
    // 在不同层级存储同名key
    store.store('dup-key', 'working-val', { tier: 'working' });
    store.store('dup-key', 'archive-val', { tier: 'archive' });
    const entry = store.retrieve('dup-key');
    assert.strictEqual(entry.value, 'working-val');
    assert.strictEqual(entry.tier, 'working');
  });
});

describe('MemoryArchiveStore - promote', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('应将working层条目晋升到long_term层', () => {
    const stored = store.store('pkey1', 'pval1');
    const promoted = store.promote(stored.id);
    assert.ok(promoted);
    assert.strictEqual(promoted.tier, 'long_term');
    assert.strictEqual(promoted.promotedFrom, 'working');
    assert.strictEqual(promoted.key, 'pkey1');
    // working层不再有该条目
    assert.strictEqual(store._tiers.working.get('pkey1'), undefined);
    // long_term层有该条目
    assert.ok(store._tiers.long_term.get('pkey1'));
  });

  it('应将long_term层条目晋升到archive层', () => {
    const stored = store.store('pkey2', 'pval2', { tier: 'long_term' });
    const promoted = store.promote(stored.id);
    assert.ok(promoted);
    assert.strictEqual(promoted.tier, 'archive');
    assert.strictEqual(promoted.promotedFrom, 'long_term');
  });

  it('archive层条目无法继续晋升应返回null', () => {
    const stored = store.store('pkey3', 'pval3', { tier: 'archive' });
    const result = store.promote(stored.id);
    assert.strictEqual(result, null);
  });

  it('promote 应触发 memory-promoted 事件', () => {
    let eventData = null;
    store.on('memory-promoted', (data) => { eventData = data; });
    const stored = store.store('evkey', 'evval');
    store.promote(stored.id);
    assert.ok(eventData);
    assert.strictEqual(eventData.fromTier, 'working');
    assert.strictEqual(eventData.toTier, 'long_term');
  });

  it('无效entryId应返回null', () => {
    assert.strictEqual(store.promote(''), null);
    assert.strictEqual(store.promote(null), null);
    assert.strictEqual(store.promote('nonexistent-id'), null);
  });
});

describe('MemoryArchiveStore - archive', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('应将working层条目归档到archive层', () => {
    store.store('akey1', 'aval1');
    const archived = store.archive('akey1');
    assert.ok(archived);
    assert.strictEqual(archived.tier, 'archive');
    assert.strictEqual(archived.promotedFrom, 'working');
    assert.strictEqual(archived.key, 'akey1');
    // working层不再有该条目
    assert.strictEqual(store._tiers.working.get('akey1'), undefined);
    // archive层有该条目
    assert.ok(store._tiers.archive.get('akey1'));
  });

  it('archive 应触发 memory-archived 事件', () => {
    let eventData = null;
    store.on('memory-archived', (data) => { eventData = data; });
    store.store('aevkey', 'aevval');
    store.archive('aevkey');
    assert.ok(eventData);
    assert.strictEqual(eventData.key, 'aevkey');
    assert.ok(eventData.entryId);
  });

  it('应将long_term层条目归档到archive层', () => {
    store.store('akey2', 'aval2', { tier: 'long_term' });
    const archived = store.archive('akey2');
    assert.ok(archived);
    assert.strictEqual(archived.tier, 'archive');
    assert.strictEqual(archived.promotedFrom, 'long_term');
  });

  it('未找到的key应返回null', () => {
    assert.strictEqual(store.archive('nonexistent'), null);
    assert.strictEqual(store.archive(''), null);
  });
});

describe('MemoryArchiveStore - 自动晋升', () => {
  let store;

  afterEach(() => {
    if (store) store.shutdown();
  });

  it('startAutoPromotion/stopAutoPromotion 应正常启停定时器', () => {
    store = new MemoryArchiveStore({ enableAutoPromotion: true, autoPromotionInterval: 100 });
    assert.strictEqual(store._promotionTimer, null);
    store.startAutoPromotion();
    assert.ok(store._promotionTimer !== null);
    store.stopAutoPromotion();
    assert.strictEqual(store._promotionTimer, null);
  });

  it('_checkPromotions 应晋升满足条件的条目', () => {
    store = new MemoryArchiveStore({
      enableAutoPromotion: true,
      enableAutoArchive: false,
      promotionThreshold: 2,
      workingTTL: 60000,
    });
    // 存储条目并访问2次，满足 accessCount >= promotionThreshold
    store.store('auto1', 'val1');
    store.retrieve('auto1');
    store.retrieve('auto1');
    // accessCount 现在为2，满足晋升条件
    assert.strictEqual(store._tiers.working.get('auto1').accessCount, 2);

    store._checkPromotions();

    // working层不再有该条目，已晋升到long_term
    assert.strictEqual(store._tiers.working.get('auto1'), undefined);
    assert.ok(store._tiers.long_term.get('auto1'));
    assert.strictEqual(store._stats.autoPromotions, 1);
  });

  it('_checkPromotions 应自动归档满足条件的long_term条目', () => {
    store = new MemoryArchiveStore({
      enableAutoPromotion: true,
      enableAutoArchive: true,
      longTermTTL: 100,
    });
    // 直接存储到long_term层
    store.store('autoarch1', 'val', { tier: 'long_term' });
    // 模拟条目已存活过半且7天无访问
    const entry = store._tiers.long_term.get('autoarch1');
    entry.createdAt = Date.now() - 200; // 超过 longTermTTL/2
    entry.lastAccessedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8天前访问

    store._checkPromotions();

    // long_term层不再有该条目，已归档
    assert.strictEqual(store._tiers.long_term.get('autoarch1'), undefined);
    assert.ok(store._tiers.archive.get('autoarch1'));
  });

  it('enableAutoPromotion为false时_checkPromotions不应执行', () => {
    store = new MemoryArchiveStore({ enableAutoPromotion: false });
    store.store('nopromo', 'val');
    store.retrieve('nopromo');
    store.retrieve('nopromo');
    store.retrieve('nopromo');
    store._checkPromotions();
    // 条目仍在working层
    assert.ok(store._tiers.working.get('nopromo'));
  });
});

describe('MemoryArchiveStore - getByTier/getTierStats', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('getByTier 应返回指定层级的所有条目', () => {
    store.store('wk1', 'v1');
    store.store('wk2', 'v2');
    store.store('lt1', 'v3', { tier: 'long_term' });

    const working = store.getByTier('working');
    assert.strictEqual(working.length, 2);
    const longTerm = store.getByTier('long_term');
    assert.strictEqual(longTerm.length, 1);
    const archive = store.getByTier('archive');
    assert.strictEqual(archive.length, 0);
  });

  it('getTierStats 应返回层级统计信息', () => {
    store.store('ts1', 'v1');
    store.retrieve('ts1');
    store.retrieve('ts1');

    const stats = store.getTierStats('working');
    assert.ok(stats);
    assert.strictEqual(stats.count, 1);
    assert.strictEqual(stats.avgAccessCount, 2);
    assert.ok(stats.oldestEntry > 0);
    assert.ok(stats.newestEntry > 0);
  });

  it('getByTier 无效层级应返回空数组', () => {
    assert.deepStrictEqual(store.getByTier('invalid'), []);
  });

  it('getTierStats 无效层级应返回null', () => {
    assert.strictEqual(store.getTierStats('invalid'), null);
  });

  it('getTierStats 空层级应返回零值统计', () => {
    const stats = store.getTierStats('working');
    assert.strictEqual(stats.count, 0);
    assert.strictEqual(stats.avgAccessCount, 0);
    assert.strictEqual(stats.oldestEntry, null);
    assert.strictEqual(stats.newestEntry, null);
  });
});

describe('MemoryArchiveStore - search', () => {
  let store;

  beforeEach(() => {
    store = new MemoryArchiveStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('应通过部分匹配key搜索条目', () => {
    store.store('config-port', 3210);
    store.store('config-host', 'localhost');
    store.store('user-name', 'alice');

    const results = store.search('config');
    assert.strictEqual(results.length, 2);
    const keys = results.map((e) => e.key);
    assert.ok(keys.includes('config-port'));
    assert.ok(keys.includes('config-host'));
  });

  it('应支持按tier过滤搜索', () => {
    store.store('config-a', 'va', { tier: 'working' });
    store.store('config-b', 'vb', { tier: 'long_term' });

    const results = store.search('config', { tier: 'working' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].key, 'config-a');
  });

  it('空query应返回空数组', () => {
    store.store('key1', 'val1');
    assert.deepStrictEqual(store.search(''), []);
    assert.deepStrictEqual(store.search(null), []);
  });

  it('应支持limit限制结果数量', () => {
    store.store('item-1', 'v1');
    store.store('item-2', 'v2');
    store.store('item-3', 'v3');

    const results = store.search('item', { limit: 2 });
    assert.strictEqual(results.length, 2);
  });
});

describe('MemoryArchiveStore - getStats', () => {
  it('应返回包含层级计数的统计信息', () => {
    const store = new MemoryArchiveStore();
    store.store('s1', 'v1');
    store.store('s2', 'v2');
    store.store('s3', 'v3', { tier: 'long_term' });
    store.retrieve('s1');

    const stats = store.getStats();
    assert.strictEqual(stats.stored, 3);
    assert.strictEqual(stats.retrieved, 1);
    assert.strictEqual(stats.promoted, 0);
    assert.strictEqual(stats.archived, 0);
    assert.strictEqual(stats.autoPromotions, 0);
    assert.strictEqual(stats.tierCounts.working, 2);
    assert.strictEqual(stats.tierCounts.long_term, 1);
    assert.strictEqual(stats.tierCounts.archive, 0);
    store.shutdown();
  });
});

describe('MemoryArchiveStore - shutdown', () => {
  it('应清空状态并停止自动晋升', () => {
    const store = new MemoryArchiveStore({ autoPromotionInterval: 100 });
    store.store('sk1', 'sv1');
    store.startAutoPromotion();
    assert.ok(store._promotionTimer !== null);

    store.shutdown();

    assert.strictEqual(store._promotionTimer, null);
    // 关闭后各层级应被清空
    assert.strictEqual(store._tiers.working.size, 0);
    assert.strictEqual(store._tiers.long_term.size, 0);
    assert.strictEqual(store._tiers.archive.size, 0);
    assert.strictEqual(store._ms, null);
    assert.strictEqual(store._bm, null);
    assert.strictEqual(store._attached.memoryStore, false);
    assert.strictEqual(store._attached.brainMemory, false);
  });
});
