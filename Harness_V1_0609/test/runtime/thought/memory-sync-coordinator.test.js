'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const MemorySyncCoordinatorModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'memory-sync-coordinator'));
const MemorySyncCoordinator = MemorySyncCoordinatorModule.MemorySyncCoordinator || MemorySyncCoordinatorModule;

describe('MemorySyncCoordinator - Constructor', () => {
  it('should create instance with default config', () => {
    const coord = new MemorySyncCoordinator();
    assert.ok(coord);
    assert.strictEqual(coord._config.maxSyncQueueSize, 100);
    assert.strictEqual(coord._config.syncIntervalMs, 300000);
    assert.strictEqual(coord._config.batchSize, 10);
    assert.strictEqual(coord._config.conflictStrategy, 'confidence-merge');
    assert.strictEqual(coord._config.enableAutoSync, true);
  });

  it('should merge custom options with defaults', () => {
    const coord = new MemorySyncCoordinator({ maxSyncQueueSize: 50, syncIntervalMs: 60000 });
    assert.strictEqual(coord._config.maxSyncQueueSize, 50);
    assert.strictEqual(coord._config.syncIntervalMs, 60000);
    assert.strictEqual(coord._config.batchSize, 10);
  });

  it('should initialize empty stores and stats', () => {
    const coord = new MemorySyncCoordinator();
    assert.strictEqual(coord._stores.size, 0);
    assert.strictEqual(coord._syncQueue.length, 0);
    assert.strictEqual(coord._stats.totalSyncs, 0);
    assert.strictEqual(coord._stats.conflictsResolved, 0);
    assert.strictEqual(coord._stats.itemsSynced, 0);
    assert.strictEqual(coord._stats.errors, 0);
    assert.deepStrictEqual(coord._stats.byStore, {});
  });

  it('should expose SYNC_POLICIES, CONFLICT_STRATEGIES, DEFAULT_SYNC_CONFIG', () => {
    assert.ok(MemorySyncCoordinator.SYNC_POLICIES);
    assert.ok(MemorySyncCoordinator.CONFLICT_STRATEGIES);
    assert.ok(MemorySyncCoordinator.DEFAULT_SYNC_CONFIG);
    assert.strictEqual(MemorySyncCoordinator.SYNC_POLICIES.ON_EVENT, 'on-event');
    assert.strictEqual(MemorySyncCoordinator.SYNC_POLICIES.PERIODIC, 'periodic');
    assert.strictEqual(MemorySyncCoordinator.SYNC_POLICIES.MANUAL, 'manual');
    assert.strictEqual(MemorySyncCoordinator.CONFLICT_STRATEGIES.LATEST_WINS, 'latest-wins');
    assert.strictEqual(MemorySyncCoordinator.CONFLICT_STRATEGIES.CONFIDENCE_MERGE, 'confidence-merge');
    assert.strictEqual(MemorySyncCoordinator.CONFLICT_STRATEGIES.SOURCE_PRIORITY, 'source-priority');
    assert.strictEqual(MemorySyncCoordinator.DEFAULT_SYNC_CONFIG.maxSyncQueueSize, 100);
  });
});

describe('MemorySyncCoordinator - registerStore', () => {
  it('should register a store with default functions', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = {
      queryKnowledge: () => [{ id: '1', content: 'test' }],
      addKnowledge: (entry) => ({ id: 'new', ...entry }),
    };
    coord.registerStore('store1', mockStore);
    assert.strictEqual(coord._stores.size, 1);
    assert.ok(coord._stores.has('store1'));
    assert.strictEqual(coord._stores.get('store1').instance, mockStore);
    assert.strictEqual(coord._stores.get('store1').priority, 1);
    assert.strictEqual(coord._stores.get('store1').enabled, true);
  });

  it('should register a store with custom sync/write functions', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const customSync = () => [];
    const customWrite = () => null;
    coord.registerStore('store1', {}, { syncFn: customSync, writeFn: customWrite });
    assert.strictEqual(coord._stores.get('store1').syncFn, customSync);
    assert.strictEqual(coord._stores.get('store1').writeFn, customWrite);
  });

  it('should register a store with custom priority', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('store1', {}, { priority: 5 });
    assert.strictEqual(coord._stores.get('store1').priority, 5);
  });

  it('should return this for chaining', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const result = coord.registerStore('store1', {});
    assert.strictEqual(result, coord);
  });

  it('should ignore invalid store name', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('', {});
    coord.registerStore(null, {});
    coord.registerStore(123, {});
    assert.strictEqual(coord._stores.size, 0);
  });

  it('should ignore invalid store instance', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('store1', null);
    coord.registerStore('store2', 'string');
    coord.registerStore('store3', 42);
    assert.strictEqual(coord._stores.size, 0);
  });

  it('should auto-detect queryKnowledge method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { queryKnowledge: (_f) => [{ id: '1' }] };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').syncFn({});
    assert.deepStrictEqual(result, [{ id: '1' }]);
  });

  it('should auto-detect search method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { search: (_f) => [{ id: '2' }] };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').syncFn({});
    assert.deepStrictEqual(result, [{ id: '2' }]);
  });

  it('should auto-detect getNotes method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { getNotes: () => [{ id: '3' }] };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').syncFn({});
    assert.deepStrictEqual(result, [{ id: '3' }]);
  });

  it('should auto-detect retrieve method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { retrieve: (_f) => [{ id: '4' }] };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').syncFn({});
    assert.deepStrictEqual(result, [{ id: '4' }]);
  });

  it('should auto-detect addKnowledge write method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { addKnowledge: (e) => ({ id: 'a', ...e }) };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').writeFn({ content: 'x' });
    assert.strictEqual(result.id, 'a');
    assert.strictEqual(result.content, 'x');
  });

  it('should auto-detect store write method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { store: (key, content, metadata) => ({ key, content, metadata }) };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').writeFn({ key: 'k', content: 'c', metadata: {} });
    assert.strictEqual(result.key, 'k');
    assert.strictEqual(result.content, 'c');
  });

  it('should auto-detect createEntry write method', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const mockStore = { createEntry: (cat, title, content, meta) => ({ cat, title, content, meta }) };
    coord.registerStore('s1', mockStore);
    const result = coord._stores.get('s1').writeFn({ category: 'cat', title: 't', content: 'c', metadata: {} });
    assert.strictEqual(result.cat, 'cat');
    assert.strictEqual(result.title, 't');
  });
});

describe('MemorySyncCoordinator - unregisterStore', () => {
  it('should remove a registered store', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('store1', {});
    assert.strictEqual(coord._stores.size, 1);
    coord.unregisterStore('store1');
    assert.strictEqual(coord._stores.size, 0);
    assert.ok(!coord._stores.has('store1'));
  });
});

describe('MemorySyncCoordinator - enqueueSync', () => {
  it('should add item to sync queue', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', {
      queryKnowledge: () => [],
      addKnowledge: () => null,
    });
    coord.enqueueSync({ source: 's1', data: { content: 'test' } });
    assert.strictEqual(coord._syncQueue.length, 1);
  });

  it('should emit sync-enqueued event', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    let emitted = false;
    let eventData = null;
    coord.on('sync-enqueued', (data) => {
      emitted = true;
      eventData = data;
    });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    coord.enqueueSync({ source: 's1', data: { content: 'test' } });
    assert.strictEqual(emitted, true);
    assert.strictEqual(eventData.source, 's1');
    assert.strictEqual(eventData.queueSize, 1);
  });

  it('should throw when enqueue after shut down', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    coord.shutdown();
    assert.throws(() => coord.enqueueSync({ source: 's1', data: { content: 'test' } }), { code: 'SHUTDOWN' });
  });
});

describe('MemorySyncCoordinator - syncAll', () => {
  it('should sync data between stores', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const written = [];
    coord.registerStore('s1', {
      queryKnowledge: () => [{ id: '1', content: 'hello' }],
      addKnowledge: () => null,
    });
    coord.registerStore('s2', {
      queryKnowledge: () => [],
      addKnowledge: (entry) => { written.push(entry); return { id: 'w', ...entry }; },
    });
    const result = await coord.syncAll();
    assert.strictEqual(result.synced, 1);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].content, 'hello');
  });

  it('should throw when shut down', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    coord.shutdown();
    await assert.rejects(() => coord.syncAll(), { code: 'SHUTDOWN' });
  });

  it('should skip disabled stores', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', {
      queryKnowledge: () => [{ id: '1' }],
      addKnowledge: () => null,
    });
    coord.registerStore('s2', {
      queryKnowledge: () => [],
      addKnowledge: () => null,
    });
    coord._stores.get('s2').enabled = false;
    const result = await coord.syncAll();
    assert.strictEqual(result.synced, 0);
  });

  it('should handle read errors gracefully', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', {
      queryKnowledge: () => { throw new Error('read fail'); },
      addKnowledge: () => null,
    });
    coord.registerStore('s2', {
      queryKnowledge: () => [],
      addKnowledge: () => null,
    });
    const result = await coord.syncAll();
    assert.strictEqual(result.errors, 1);
  });

  it('should handle write errors gracefully', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', {
      queryKnowledge: () => [{ id: '1', content: 'data' }],
      addKnowledge: () => null,
    });
    coord.registerStore('s2', {
      queryKnowledge: () => [],
      addKnowledge: () => { throw new Error('write fail'); },
    });
    const result = await coord.syncAll();
    assert.strictEqual(result.errors, 1);
  });

  it('should emit sync-completed event', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', {
      queryKnowledge: () => [],
      addKnowledge: () => null,
    });
    let emitted = false;
    let eventData = null;
    coord.on('sync-completed', (data) => {
      emitted = true;
      eventData = data;
    });
    await coord.syncAll();
    assert.strictEqual(emitted, true);
    assert.ok(eventData);
    assert.strictEqual(eventData.synced, 0);
  });
});

describe('MemorySyncCoordinator - syncFromSource', () => {
  it('should sync data from specific source to other stores', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const written = [];
    coord.registerStore('s1', {
      queryKnowledge: () => [],
      addKnowledge: () => null,
    });
    coord.registerStore('s2', {
      queryKnowledge: () => [],
      addKnowledge: (entry) => { written.push(entry); return { id: 'w', ...entry }; },
    });
    const result = await coord.syncFromSource('s1', { id: '1', content: 'hello' });
    assert.strictEqual(result.synced, 1);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].content, 'hello');
  });

  it('should return empty result for invalid input', async () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    const r1 = await coord.syncFromSource(null, { id: '1' });
    assert.deepStrictEqual(r1, { synced: 0, conflicts: 0, errors: 0 });
    const r2 = await coord.syncFromSource('s1', null);
    assert.deepStrictEqual(r2, { synced: 0, conflicts: 0, errors: 0 });
  });
});

describe('MemorySyncCoordinator - _resolveConflict', () => {
  it('should resolve with latest-wins strategy', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const existing = { timestamp: 1000, content: 'old' };
    const newData = { timestamp: 2000, content: 'new' };
    const result = coord._resolveConflict(existing, newData, 'latest-wins');
    assert.strictEqual(result.content, 'new');
  });

  it('should resolve with latest-wins keeping existing when newer', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const existing = { timestamp: 3000, content: 'old' };
    const newData = { timestamp: 2000, content: 'new' };
    const result = coord._resolveConflict(existing, newData, 'latest-wins');
    assert.strictEqual(result.content, 'old');
  });

  it('should resolve with confidence-merge strategy', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const existing = { confidence: 0.5, content: 'old', tags: ['a'] };
    const newData = { confidence: 0.9, content: 'new', tags: ['b'] };
    const result = coord._resolveConflict(existing, newData, 'confidence-merge');
    assert.strictEqual(result.confidence, 0.9);
    assert.deepStrictEqual(result.tags, ['a', 'b']);
  });

  it('should resolve with source-priority strategy', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('high', {}, { priority: 10 });
    coord.registerStore('low', {}, { priority: 1 });
    const existing = { source: 'low', content: 'old' };
    const newData = { source: 'high', content: 'new' };
    const result = coord._resolveConflict(existing, newData, 'source-priority');
    assert.strictEqual(result.content, 'new');
  });

  it('should resolve with source-priority keeping existing when higher', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('high', {}, { priority: 10 });
    coord.registerStore('low', {}, { priority: 1 });
    const existing = { source: 'high', content: 'old' };
    const newData = { source: 'low', content: 'new' };
    const result = coord._resolveConflict(existing, newData, 'source-priority');
    assert.strictEqual(result.content, 'old');
  });

  it('should return newData when no existingData', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const newData = { content: 'new' };
    const result = coord._resolveConflict(null, newData, 'latest-wins');
    assert.strictEqual(result.content, 'new');
  });

  it('should return existingData when no newData', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    const existing = { content: 'old' };
    const result = coord._resolveConflict(existing, null, 'latest-wins');
    assert.strictEqual(result.content, 'old');
  });
});

describe('MemorySyncCoordinator - startPeriodicSync/stopPeriodicSync', () => {
  it('should start periodic sync timer', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false, syncIntervalMs: 60000 });
    coord.startPeriodicSync();
    assert.ok(coord._syncTimer !== null);
    coord.stopPeriodicSync();
  });

  it('should stop periodic sync timer', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false, syncIntervalMs: 60000 });
    coord.startPeriodicSync();
    assert.ok(coord._syncTimer !== null);
    coord.stopPeriodicSync();
    assert.strictEqual(coord._syncTimer, null);
  });

  it('should not start duplicate timer', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false, syncIntervalMs: 60000 });
    coord.startPeriodicSync();
    const firstTimer = coord._syncTimer;
    coord.startPeriodicSync();
    assert.strictEqual(coord._syncTimer, firstTimer);
    coord.stopPeriodicSync();
  });

  it('should emit periodic-sync-started/stopped events', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false, syncIntervalMs: 60000 });
    let startedEmitted = false;
    let stoppedEmitted = false;
    coord.on('periodic-sync-started', () => { startedEmitted = true; });
    coord.on('periodic-sync-stopped', () => { stoppedEmitted = true; });
    coord.startPeriodicSync();
    assert.strictEqual(startedEmitted, true);
    coord.stopPeriodicSync();
    assert.strictEqual(stoppedEmitted, true);
  });
});

describe('MemorySyncCoordinator - getStats', () => {
  it('should return stats with expected fields', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    const stats = coord.getStats();
    assert.ok(stats);
    assert.strictEqual(typeof stats.totalSyncs, 'number');
    assert.strictEqual(typeof stats.conflictsResolved, 'number');
    assert.strictEqual(typeof stats.itemsSynced, 'number');
    assert.strictEqual(typeof stats.errors, 'number');
    assert.ok(stats.byStore);
    assert.strictEqual(typeof stats.queueSize, 'number');
    assert.ok(stats.byStore.s1);
    assert.strictEqual(stats.byStore.s1.syncs, 0);
    assert.strictEqual(stats.byStore.s1.items, 0);
    assert.strictEqual(stats.byStore.s1.errors, 0);
  });
});

describe('MemorySyncCoordinator - isHealthy', () => {
  it('should return true when stores registered', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    assert.strictEqual(coord.isHealthy(), true);
  });

  it('should return false when no stores', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    assert.strictEqual(coord.isHealthy(), false);
  });

  it('should return false when shut down', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    coord.shutdown();
    assert.strictEqual(coord.isHealthy(), false);
  });
});

describe('MemorySyncCoordinator - Shutdown', () => {
  it('should stop periodic sync on shutdown', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false, syncIntervalMs: 60000 });
    coord.startPeriodicSync();
    assert.ok(coord._syncTimer !== null);
    coord.shutdown();
    assert.strictEqual(coord._syncTimer, null);
  });

  it('should clear stores and queue on shutdown', () => {
    const coord = new MemorySyncCoordinator({ enableAutoSync: false });
    coord.registerStore('s1', { queryKnowledge: () => [], addKnowledge: () => null });
    coord.enqueueSync({ source: 's1', data: { content: 'test' } });
    assert.strictEqual(coord._stores.size, 1);
    assert.strictEqual(coord._syncQueue.length, 1);
    coord.shutdown();
    assert.strictEqual(coord._stores.size, 0);
    assert.strictEqual(coord._syncQueue.length, 0);
  });
});
