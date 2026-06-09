'use strict';
const { describe, it, after , afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');


const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { const r = obj.destroy(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}
describe('EventBus', () => {
  afterEach(async () => { await _cleanAll(); });
  const EventBus = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'event-bus'));

  it('should emit and receive events', () => {
    const bus = _track(new EventBus());
    let received = null;
    bus.on('test-event', (data) => { received = data; });
    bus.emit('test-event', { value: 42 });
    assert.deepEqual(received, { value: 42 });
  });

  it('should record event history', () => {
    const bus = _track(new EventBus());
    bus.emit('event-a', { a: 1 });
    bus.emit('event-b', { b: 2 });
    bus.emit('event-a', { a: 3 });
    const history = bus.getHistory();
    assert.equal(history.length, 3);
    assert.equal(history[0].event, 'event-a');
    assert.equal(history[2].data.a, 3);
  });

  it('should filter history by event name', () => {
    const bus = _track(new EventBus());
    bus.emit('event-a', {});
    bus.emit('event-b', {});
    bus.emit('event-a', {});
    const filtered = bus.getHistory('event-a');
    assert.equal(filtered.length, 2);
  });

  it('should FIFO evict history when maxHistory reached', () => {
    const bus = _track(new EventBus({ maxHistory: 3 }));
    bus.emit('e1', {});
    bus.emit('e2', {});
    bus.emit('e3', {});
    bus.emit('e4', {});
    assert.equal(bus.getHistory().length, 3);
    assert.equal(bus.getHistory()[0].event, 'e2');
  });

  it('should support middleware', () => {
    const bus = _track(new EventBus());
    const calls = [];
    bus.use((event, data) => { calls.push({ event, data }); });
    bus.emit('mw-test', { x: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'mw-test');
  });

  it('should handle middleware errors gracefully', () => {
    const bus = _track(new EventBus());
    bus.use(() => { throw new Error('middleware error'); });
    let received = false;
    bus.on('safe-event', () => { received = true; });
    bus.emit('safe-event', {});
    assert.ok(received);
  });

  it('should support onceAsync', async () => {
    const bus = _track(new EventBus());
    const promise = bus.onceAsync('async-event');
    bus.emit('async-event', { result: 'ok' });
    const result = await promise;
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.data, { result: 'ok' });
  });

  it('should reject onceAsync on timeout', async () => {
    const bus = _track(new EventBus());
    await assert.rejects(
      () => bus.onceAsync('never-emitted', 50),
      { message: /timed out/ },
    );
  });

  it('should clear history', () => {
    const bus = _track(new EventBus());
    bus.emit('e', {});
    bus.clearHistory();
    assert.equal(bus.getHistory().length, 0);
  });

  it('should set maxListeners from options', () => {
    const bus = _track(new EventBus({ maxListeners: 100 }));
    assert.equal(bus.getMaxListeners(), 100);
  });

  it('should use default maxListeners', () => {
    const bus = _track(new EventBus());
    assert.equal(bus.getMaxListeners(), 50);
  });
});

describe('PluginManager', () => {
  const PluginManager = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'plugin-manager'));

  it('should register and list plugins', () => {
    const pm = _track(new PluginManager());
    pm.register({ id: 'test-plugin', init: () => {} });
    assert.deepEqual(pm.listPlugins(), ['test-plugin']);
  });

  it('should throw on plugin without id', () => {
    const pm = _track(new PluginManager());
    assert.throws(() => pm.register({}), /must have an id/);
  });

  it('should throw on duplicate plugin id', () => {
    const pm = _track(new PluginManager());
    pm.register({ id: 'dup', init: () => {} });
    assert.throws(() => pm.register({ id: 'dup', init: () => {} }), /already registered/);
  });

  it('should unregister plugin and remove hooks', () => {
    const pm = _track(new PluginManager());
    pm.register({
      id: 'removable',
      init: (ctx) => { ctx.registerHook('before:skill', () => {}); },
    });
    assert.equal(pm.getHooks('before:skill').length, 1);
    pm.unregister('removable');
    assert.equal(pm.listPlugins().length, 0);
    assert.equal(pm.getHooks('before:skill').length, 0);
  });

  it('should return false for unregistering unknown plugin', () => {
    const pm = _track(new PluginManager());
    assert.equal(pm.unregister('unknown'), false);
  });

  it('should execute hooks in order', () => {
    const pm = _track(new PluginManager());
    pm.register({
      id: 'hook-1',
      init: (ctx) => {
        ctx.registerHook('transform', (data) => data + '-step1');
      },
    });
    pm.register({
      id: 'hook-2',
      init: (ctx) => {
        ctx.registerHook('transform', (data) => data + '-step2');
      },
    });
    const result = pm.executeHook('transform', 'start');
    assert.equal(result, 'start-step1-step2');
  });

  it('should handle hook errors gracefully', () => {
    const pm = _track(new PluginManager());
    pm.register({
      id: 'bad-hook',
      init: (ctx) => {
        ctx.registerHook('transform', () => { throw new Error('hook error'); });
        ctx.registerHook('transform', (data) => data + '-good');
      },
    });
    const result = pm.executeHook('transform', 'start');
    assert.equal(result, 'start-good');
  });

  it('should return undefined for unknown plugin', () => {
    const pm = _track(new PluginManager());
    assert.equal(pm.getPlugin('unknown'), null);
  });

  it('should get all hooks', () => {
    const pm = _track(new PluginManager());
    pm.register({
      id: 'p1',
      init: (ctx) => {
        ctx.registerHook('hook-a', () => {});
        ctx.registerHook('hook-b', () => {});
      },
    });
    const hooks = pm.getHooks();
    assert.ok(hooks['hook-a']);
    assert.ok(hooks['hook-b']);
  });

  it('should call destroy on plugin when unregistering', () => {
    const pm = _track(new PluginManager());
    let destroyed = false;
    pm.register({ id: 'destroyable', init: () => {}, destroy: () => { destroyed = true; } });
    pm.unregister('destroyable');
    assert.ok(destroyed);
  });

  it('should handle destroy errors gracefully', () => {
    const pm = _track(new PluginManager());
    pm.register({ id: 'bad-destroy', init: () => {}, destroy: () => { throw new Error('destroy error'); } });
    pm.unregister('bad-destroy');
    assert.equal(pm.listPlugins().length, 0);
  });

  it('should destroy all plugins', () => {
    const pm = _track(new PluginManager());
    pm.register({ id: 'p1', init: () => {} });
    pm.register({ id: 'p2', init: () => {} });
    pm.destroy();
    assert.equal(pm.listPlugins().length, 0);
  });

  it('should receive eventBus in context', () => {
    const EventBus = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'event-bus'));
    const bus = _track(new EventBus());
    const pm = _track(new PluginManager(bus));
    let receivedCtx = null;
    pm.register({ id: 'ctx-test', init: (ctx) => { receivedCtx = ctx; } });
    assert.ok(receivedCtx.eventBus);
  });
});

describe('HealthChecker', () => {
  const HealthChecker = require(path.join(ROOT, 'src', 'runtime', 'infrastructure', 'health-checker'));

  it('should register and run health check', async () => {
    const hc = _track(new HealthChecker());
    hc.register('test-check', () => ({ healthy: true, message: 'OK' }));
    const result = await hc.check('test-check');
    assert.equal(result.status, 'healthy');
    assert.equal(result.message, 'OK');
  });

  it('should report unhealthy status', async () => {
    const hc = _track(new HealthChecker());
    hc.register('bad-check', () => ({ healthy: false, message: 'Down' }));
    const result = await hc.check('bad-check');
    assert.equal(result.status, 'unhealthy');
  });

  it('should handle check errors', async () => {
    const hc = _track(new HealthChecker());
    hc.register('error-check', () => { throw new Error('check failed'); });
    const result = await hc.check('error-check');
    assert.equal(result.status, 'error');
    assert.ok(result.message.includes('check failed'));
  });

  it('should return unknown for missing check', async () => {
    const hc = _track(new HealthChecker());
    const result = await hc.check('nonexistent');
    assert.equal(result.status, 'unknown');
  });

  it('should check all and return overall status', async () => {
    const hc = _track(new HealthChecker());
    hc.register('ok1', () => ({ healthy: true, message: 'OK' }));
    hc.register('ok2', () => ({ healthy: true, message: 'OK' }));
    const result = await hc.checkAll();
    assert.equal(result.status, 'healthy');
    assert.ok(result.checks.ok1);
    assert.ok(result.checks.ok2);
  });

  it('should report degraded when one check fails', async () => {
    const hc = _track(new HealthChecker());
    hc.register('ok', () => ({ healthy: true, message: 'OK' }));
    hc.register('bad', () => ({ healthy: false, message: 'Down' }));
    const result = await hc.checkAll();
    assert.equal(result.status, 'degraded');
  });

  it('should support async health checks', async () => {
    const hc = _track(new HealthChecker());
    hc.register('async-check', async () => {
      return { healthy: true, message: 'Async OK' };
    });
    const result = await hc.check('async-check');
    assert.equal(result.status, 'healthy');
  });

  it('should unregister check', () => {
    const hc = _track(new HealthChecker());
    hc.register('removable', () => ({ healthy: true }));
    assert.ok(hc.unregister('removable'));
    assert.ok(!hc.unregister('removable'));
  });

  it('should list registered checks', () => {
    const hc = _track(new HealthChecker());
    hc.register('a', () => ({ healthy: true }));
    hc.register('b', () => ({ healthy: true }));
    assert.deepEqual(hc.listChecks(), ['a', 'b']);
  });

  it('should throw on non-function check', () => {
    const hc = _track(new HealthChecker());
    assert.throws(() => hc.register('bad', 'not-a-function'), /must be a function/);
  });
});

describe('StructuredLogger', () => {
  const StructuredLogger = require(path.join(ROOT, 'src', 'utils', 'structured-logger'));

  it('should log at different levels', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    logger.clear();
    logger._level = 0;
    logger.debug('debug msg', { key: 'd' });
    logger.info('info msg', { key: 'i' });
    logger.warn('warn msg', { key: 'w' });
    logger.error('error msg', { key: 'e' });
    assert.equal(logger.getRecent().length, 4);
  });

  it('should respect log level', () => {
    const logger = _track(new StructuredLogger({ level: 'warn' }));
    logger.debug('should not log');
    logger.info('should not log');
    logger.warn('should log');
    logger.error('should log');
    assert.equal(logger.getRecent().length, 2);
  });

  it('should create child logger', () => {
    const parent = _track(new StructuredLogger({ level: 'info', module: 'parent' }));
    const child = parent.child('module-a');
    child.info('child msg');
    const childEntries = child.getRecent();
    assert.ok(childEntries.length > 0);
    assert.ok(childEntries[0].module.includes('parent:module-a'));
  });

  it('should query by level', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    const errors = logger.query({ level: 'error' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].level, 'error');
  });

  it('should query by module', () => {
    const logger = _track(new StructuredLogger({ level: 'debug', module: 'test-mod' }));
    logger.info('msg');
    const results = logger.query({ module: 'test-mod' });
    assert.equal(results.length, 1);
  });

  it('should query with limit', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    for (let i = 0; i < 20; i++) logger.info(`msg-${i}`);
    const results = logger.query({ limit: 5 });
    assert.equal(results.length, 5);
  });

  it('should FIFO evict when maxEntries reached', () => {
    const logger = _track(new StructuredLogger({ level: 'debug', maxEntries: 3 }));
    logger.info('first');
    logger.info('second');
    logger.info('third');
    logger.info('fourth');
    const entries = logger.getRecent();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].message, 'second');
  });

  it('should clear entries', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    logger.info('msg');
    logger.clear();
    assert.equal(logger.getRecent().length, 0);
  });

  it('should export as JSON', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    logger.info('msg');
    const json = logger.export();
    const parsed = JSON.parse(json);
    assert.ok(parsed.length > 0);
  });

  it('should get stats', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    logger.info('msg1');
    logger.warn('msg2');
    logger.error('msg3');
    const stats = logger.getStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.byLevel.info, 1);
    assert.equal(stats.byLevel.warn, 1);
    assert.equal(stats.byLevel.error, 1);
  });

  it('should emit log event', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    let emitted = null;
    logger.on('log', (entry) => { emitted = entry; });
    logger.info('test');
    assert.ok(emitted);
    assert.equal(emitted.message, 'test');
  });

  it('should emit error-log event for errors', () => {
    const logger = _track(new StructuredLogger({ level: 'debug' }));
    let emitted = null;
    logger.on('error-log', (entry) => { emitted = entry; });
    logger.info('not error');
    assert.equal(emitted, null);
    logger.error('is error');
    assert.ok(emitted);
    assert.equal(emitted.level, 'error');
  });

  it('should expose LOG_LEVELS', () => {
    assert.ok(StructuredLogger.LOG_LEVELS);
    assert.equal(StructuredLogger.LOG_LEVELS.debug, 0);
    assert.equal(StructuredLogger.LOG_LEVELS.silent, 4);
  });

  it('should use default level when invalid', () => {
    const logger = _track(new StructuredLogger({ level: 'invalid-level' }));
    logger.debug('should not log');
    logger.info('should log');
    assert.equal(logger.getRecent().length, 1);
  });
});

describe('Factory Function with New Modules', () => {
  const _harnessInstances = [];
  const _sessionFilesToCleanup = [];

  after(async () => {
    for (const h of _harnessInstances) {
      try { await h.destroy(); } catch (_) { void _; }
    }
    _harnessInstances.length = 0;
    const fs = require('fs');
    const sessionsDir = path.join(ROOT, '.harness', 'sessions');
    for (const f of _sessionFilesToCleanup) {
      try { fs.unlinkSync(path.join(sessionsDir, f)); } catch (_) { void _; }
    }
    _sessionFilesToCleanup.length = 0;
  });

  function createHarness() {
    const { create } = require(path.join(ROOT, 'src'));
    const h = create(ROOT);
    _harnessInstances.push(h);
    return h;
  }

  it('should include eventBus, pluginManager, healthChecker, structuredLog', () => {
    const harness = createHarness();
    assert.ok(harness.eventBus);
    assert.ok(harness.pluginManager);
    assert.ok(harness.healthChecker);
    assert.ok(harness.structuredLog);
  });

  it('should bridge session events to eventBus', () => {
    const harness = createHarness();
    delete harness.session.sessions['bus-bridge-test'];
    let received = null;
    harness.eventBus.on('session:created', (e) => { received = e; });
    harness.session.create('bus-bridge-test');
    _sessionFilesToCleanup.push('bus-bridge-test.json');
    assert.ok(received);
    assert.equal(received.sessionId, 'bus-bridge-test');
  });

  it('should bridge phase-change to eventBus', () => {
    const harness = createHarness();
    delete harness.session.sessions['phase-bus-test'];
    harness.session.create('phase-bus-test');
    _sessionFilesToCleanup.push('phase-bus-test.json');
    let received = null;
    harness.eventBus.on('session:phase-change', (e) => { received = e; });
    harness.session.advancePhase('phase-bus-test', 'requirement-analysis');
    assert.ok(received);
    assert.equal(received.to, 'requirement-analysis');
  });

  it('should pass health check', async () => {
    const harness = createHarness();
    const health = await harness.healthChecker.checkAll();
    assert.ok(health.status === 'healthy' || health.status === 'degraded');
  });

  it('should allow plugin registration', () => {
    const harness = createHarness();
    harness.pluginManager.register({
      id: 'test-plugin',
      init: (ctx) => {
        ctx.registerHook('before:skill', (data) => data);
      },
    });
    assert.deepEqual(harness.pluginManager.listPlugins(), ['test-plugin']);
  });
});
