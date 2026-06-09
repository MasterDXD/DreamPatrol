'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { HookComposer, COMPOSITION_STRATEGIES } = require('../../../src/runtime/workflow/hook-composer');

function createMockExecutor(responses) {
  const callLog = [];
  const resp = responses || [];
  let idx = 0;
  return {
    callLog,
    execute(event, context) {
      callLog.push({ event, context });
      const r = resp[idx++] || { passed: true };
      if (r instanceof Error) { return Promise.reject(r); }
      return Promise.resolve(r);
    },
  };
}

describe('HookComposer - constructor and constants', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const c = new HookComposer(executor);
      assert.ok(c instanceof HookComposer);
      assert.ok(c.isHealthy());
      c.shutdown();
    });

    it('should merge custom config with defaults', () => {
      const c = new HookComposer(executor, { maxCompositions: 5 });
      assert.strictEqual(c._config.maxCompositions, 5);
      assert.strictEqual(c._config.maxHooksPerComposition, 10);
      c.shutdown();
    });

    it('should initialize stats to zero', () => {
      const stats = composer.getStats();
      assert.strictEqual(stats.compositionsCreated, 0);
      assert.strictEqual(stats.compositionsExecuted, 0);
      assert.strictEqual(stats.compositionsFailed, 0);
      assert.strictEqual(stats.totalHooksComposed, 0);
    });

    it('should work without hookExecutor', () => {
      const c = new HookComposer(null);
      assert.ok(c instanceof HookComposer);
      c.shutdown();
    });
  });

  describe('COMPOSITION_STRATEGIES', () => {
    it('should export SEQUENTIAL strategy', () => {
      assert.strictEqual(COMPOSITION_STRATEGIES.SEQUENTIAL, 'sequential');
    });

    it('should export PARALLEL strategy', () => {
      assert.strictEqual(COMPOSITION_STRATEGIES.PARALLEL, 'parallel');
    });

    it('should export CONDITIONAL strategy', () => {
      assert.strictEqual(COMPOSITION_STRATEGIES.CONDITIONAL, 'conditional');
    });

    it('should have exactly three strategies', () => {
      const keys = Object.keys(COMPOSITION_STRATEGIES);
      assert.strictEqual(keys.length, 3);
    });
  });
});

describe('HookComposer - createComposition', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  it('should create a composition with default strategy', () => {
    const comp = composer.createComposition('comp-1', {
      hooks: [{ event: 'pre-commit', action: 'lint' }],
    });
    assert.strictEqual(comp.id, 'comp-1');
    assert.strictEqual(comp.strategy, COMPOSITION_STRATEGIES.SEQUENTIAL);
    assert.strictEqual(comp.hooks.length, 1);
    assert.strictEqual(comp.name, 'comp-1');
    assert.strictEqual(comp.description, '');
    assert.strictEqual(comp.onFailure, 'stop');
    assert.strictEqual(comp.fallbackHook, null);
    assert.ok(comp.createdAt);
  });

  it('should create a composition with custom name and description', () => {
    const comp = composer.createComposition('comp-2', {
      name: 'My Composition',
      description: 'A test composition',
      hooks: [],
    });
    assert.strictEqual(comp.name, 'My Composition');
    assert.strictEqual(comp.description, 'A test composition');
  });

  it('should create a composition with parallel strategy', () => {
    const comp = composer.createComposition('comp-3', {
      strategy: COMPOSITION_STRATEGIES.PARALLEL,
      hooks: [],
    });
    assert.strictEqual(comp.strategy, 'parallel');
  });

  it('should create a composition with conditional strategy', () => {
    const comp = composer.createComposition('comp-4', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [],
    });
    assert.strictEqual(comp.strategy, 'conditional');
  });

  it('should assign order to hooks', () => {
    const comp = composer.createComposition('comp-5', {
      hooks: [
        { event: 'e1', action: 'a1' },
        { event: 'e2', action: 'a2' },
      ],
    });
    assert.strictEqual(comp.hooks[0].order, 0);
    assert.strictEqual(comp.hooks[1].order, 1);
  });

  it('should preserve hook condition and timeout', () => {
    const fn = () => true;
    const comp = composer.createComposition('comp-6', {
      hooks: [{ event: 'e1', action: 'a1', condition: fn, timeout: 5000 }],
    });
    assert.strictEqual(comp.hooks[0].condition, fn);
    assert.strictEqual(comp.hooks[0].timeout, 5000);
  });

  it('should set null condition when not provided', () => {
    const comp = composer.createComposition('comp-7', {
      hooks: [{ event: 'e1', action: 'a1' }],
    });
    assert.strictEqual(comp.hooks[0].condition, null);
    assert.strictEqual(comp.hooks[0].timeout, null);
  });

  it('should emit composition-created event', () => {
    let eventData = null;
    composer.on('composition-created', (data) => { eventData = data; });
    composer.createComposition('comp-8', {
      strategy: COMPOSITION_STRATEGIES.PARALLEL,
      hooks: [{ event: 'e1', action: 'a1' }, { event: 'e2', action: 'a2' }],
    });
    assert.strictEqual(eventData.compositionId, 'comp-8');
    assert.strictEqual(eventData.strategy, 'parallel');
    assert.strictEqual(eventData.hookCount, 2);
  });

  it('should update stats.compositionsCreated', () => {
    composer.createComposition('comp-9', { hooks: [] });
    composer.createComposition('comp-10', { hooks: [] });
    assert.strictEqual(composer.getStats().compositionsCreated, 2);
  });

  it('should update stats.totalHooksComposed', () => {
    composer.createComposition('comp-11', {
      hooks: [{ event: 'e1', action: 'a1' }, { event: 'e2', action: 'a2' }],
    });
    assert.strictEqual(composer.getStats().totalHooksComposed, 2);
  });

  it('should throw on empty compositionId', () => {
    assert.throws(() => composer.createComposition('', { hooks: [] }), /compositionId must be a non-empty string/);
  });

  it('should throw on non-string compositionId', () => {
    assert.throws(() => composer.createComposition(123, { hooks: [] }), /compositionId must be a non-empty string/);
  });

  it('should throw on duplicate compositionId', () => {
    composer.createComposition('dup', { hooks: [] });
    assert.throws(() => composer.createComposition('dup', { hooks: [] }), /Composition already exists: dup/);
  });

  it('should throw when maxCompositions is reached', () => {
    const c = new HookComposer(executor, { maxCompositions: 2 });
    c.createComposition('c1', { hooks: [] });
    c.createComposition('c2', { hooks: [] });
    assert.throws(() => c.createComposition('c3', { hooks: [] }), /Maximum compositions reached/);
    c.shutdown();
  });

  it('should throw on invalid strategy', () => {
    assert.throws(() => composer.createComposition('bad-strat', {
      strategy: 'invalid',
      hooks: [],
    }), /Invalid strategy: invalid/);
  });

  it('should throw when exceeding maxHooksPerComposition', () => {
    const c = new HookComposer(executor, { maxHooksPerComposition: 2 });
    assert.throws(() => c.createComposition('too-many', {
      hooks: [
        { event: 'e1', action: 'a1' },
        { event: 'e2', action: 'a2' },
        { event: 'e3', action: 'a3' },
      ],
    }), /Exceeded max hooks per composition: 2/);
    c.shutdown();
  });

  it('should throw when shut down', () => {
    composer.shutdown();
    assert.throws(() => composer.createComposition('after-shutdown', { hooks: [] }));
  });

  it('should accept empty hooks array', () => {
    const comp = composer.createComposition('empty-hooks', { hooks: [] });
    assert.strictEqual(comp.hooks.length, 0);
  });

  it('should accept hooks with no explicit array (defaults to empty)', () => {
    const comp = composer.createComposition('no-hooks', {});
    assert.strictEqual(comp.hooks.length, 0);
  });
});

describe('HookComposer - executeComposition SEQUENTIAL', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  it('should execute hooks sequentially and return passed result', async () => {
    executor = createMockExecutor([
      { passed: true },
      { passed: true },
    ]);
    composer = new HookComposer(executor);
    composer.createComposition('seq-ok', {
      strategy: COMPOSITION_STRATEGIES.SEQUENTIAL,
      hooks: [
        { event: 'hook1', action: 'action1' },
        { event: 'hook2', action: 'action2' },
      ],
    });
    const result = await composer.executeComposition('seq-ok', { data: 'test' });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(executor.callLog.length, 2);
  });

  it('should stop on first failure when onFailure is stop', async () => {
    executor = createMockExecutor([
      { passed: true },
      { passed: false, reason: 'bad' },
      { passed: true },
    ]);
    composer = new HookComposer(executor);
    composer.createComposition('seq-fail', {
      strategy: COMPOSITION_STRATEGIES.SEQUENTIAL,
      hooks: [
        { event: 'hook1', action: 'action1' },
        { event: 'hook2', action: 'action2' },
        { event: 'hook3', action: 'action3' },
      ],
    });
    const result = await composer.executeComposition('seq-fail', {});
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.failedAt, 'action2');
    assert.strictEqual(executor.callLog.length, 2);
  });

  it('should emit composition-started and composition-completed events', async () => {
    const events = [];
    composer.on('composition-started', (d) => events.push(['started', d]));
    composer.on('composition-completed', (d) => events.push(['completed', d]));
    composer.createComposition('seq-events', {
      strategy: COMPOSITION_STRATEGIES.SEQUENTIAL,
      hooks: [{ event: 'e1', action: 'a1' }],
    });
    await composer.executeComposition('seq-events', {});
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0][0], 'started');
    assert.strictEqual(events[0][1].compositionId, 'seq-events');
    assert.strictEqual(events[1][0], 'completed');
    assert.strictEqual(events[1][1].compositionId, 'seq-events');
    assert.strictEqual(typeof events[1][1].duration, 'number');
  });

  it('should increment compositionsExecuted stat', async () => {
    composer.createComposition('seq-stat', {
      strategy: COMPOSITION_STRATEGIES.SEQUENTIAL,
      hooks: [{ event: 'e1', action: 'a1' }],
    });
    await composer.executeComposition('seq-stat', {});
    assert.strictEqual(composer.getStats().compositionsExecuted, 1);
  });
});

describe('HookComposer - executeComposition PARALLEL', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  it('should execute all hooks in parallel and return combined result', async () => {
    executor = createMockExecutor([
      { passed: true },
      { passed: true },
    ]);
    composer = new HookComposer(executor);
    composer.createComposition('par-ok', {
      strategy: COMPOSITION_STRATEGIES.PARALLEL,
      hooks: [
        { event: 'hook1', action: 'action1' },
        { event: 'hook2', action: 'action2' },
      ],
    });
    const result = await composer.executeComposition('par-ok', {});
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.results.length, 2);
  });

  it('should return passed:false when any parallel hook fails', async () => {
    executor = createMockExecutor([
      { passed: true },
      { passed: false, reason: 'failed' },
    ]);
    composer = new HookComposer(executor);
    composer.createComposition('par-fail', {
      strategy: COMPOSITION_STRATEGIES.PARALLEL,
      hooks: [
        { event: 'hook1', action: 'action1' },
        { event: 'hook2', action: 'action2' },
      ],
    });
    const result = await composer.executeComposition('par-fail', {});
    assert.strictEqual(result.passed, false);
  });

  it('should handle rejected hooks gracefully in parallel', async () => {
    executor = createMockExecutor([
      { passed: true },
      new Error('hook crashed'),
    ]);
    composer = new HookComposer(executor);
    composer.createComposition('par-error', {
      strategy: COMPOSITION_STRATEGIES.PARALLEL,
      hooks: [
        { event: 'hook1', action: 'action1' },
        { event: 'hook2', action: 'action2' },
      ],
    });
    const result = await composer.executeComposition('par-error', {});
    assert.strictEqual(result.passed, false);
  });
});

describe('HookComposer - executeComposition CONDITIONAL', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  it('should execute hook when function condition returns true', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-fn-true', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [
        { event: 'e1', action: 'a1', condition: () => true },
      ],
    });
    const result = await composer.executeComposition('cond-fn-true', {});
    assert.strictEqual(result.passed, true);
    assert.strictEqual(executor.callLog.length, 1);
  });

  it('should skip hook when function condition returns false', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-fn-false', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [
        { event: 'e1', action: 'a1', condition: () => false },
      ],
    });
    const result = await composer.executeComposition('cond-fn-false', {});
    assert.strictEqual(result.passed, true);
    assert.strictEqual(executor.callLog.length, 0);
  });

  it('should evaluate string condition against context', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-str', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [
        { event: 'e1', action: 'a1', condition: 'isEnabled' },
      ],
    });
    const result = await composer.executeComposition('cond-str', { isEnabled: true });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(executor.callLog.length, 1);
  });

  it('should execute hook when string condition is false in context (false is a valid value)', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-str-falsy', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [
        { event: 'e1', action: 'a1', condition: 'isEnabled' },
      ],
    });
    const result = await composer.executeComposition('cond-str-falsy', { isEnabled: false });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(executor.callLog.length, 1);
  });

  it('should skip hook when string condition is undefined in context', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-str-undef', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [
        { event: 'e1', action: 'a1', condition: 'isEnabled' },
      ],
    });
    const result = await composer.executeComposition('cond-str-undef', {});
    assert.strictEqual(result.passed, true);
    assert.strictEqual(executor.callLog.length, 0);
  });

  it('should always execute hook when condition is null', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-null', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      hooks: [
        { event: 'e1', action: 'a1' },
      ],
    });
    const result = await composer.executeComposition('cond-null', {});
    assert.strictEqual(result.passed, true);
    assert.strictEqual(executor.callLog.length, 1);
  });

  it('should return passed:false on failure when onFailure is stop', async () => {
    executor = createMockExecutor([{ passed: false, reason: 'nope' }]);
    composer = new HookComposer(executor);
    composer.createComposition('cond-fail-stop', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      onFailure: 'stop',
      hooks: [
        { event: 'e1', action: 'a1', condition: () => true },
      ],
    });
    const result = await composer.executeComposition('cond-fail-stop', {});
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.failedAt, 'a1');
    assert.ok(result.reason.includes('Conditional hook failed'));
  });
});

describe('HookComposer - executeComposition failure handling', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  it('should throw when composition not found', async () => {
    await assert.rejects(
      () => composer.executeComposition('nonexistent', {}),
      /Composition not found: nonexistent/,
    );
  });

  it('should throw when hookExecutor is not attached', async () => {
    const c = new HookComposer(null);
    c.createComposition('no-exec', { hooks: [{ event: 'e1', action: 'a1' }] });
    await assert.rejects(
      () => c.executeComposition('no-exec', {}),
      /HookExecutor not attached/,
    );
    c.shutdown();
  });

  it('should continue on failure when onFailure is continue', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('fail-continue', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      onFailure: 'continue',
      hooks: [{
        event: 'e1',
        action: 'a1',
        condition: () => { throw new Error('condition boom'); },
      }],
    });
    const result = await composer.executeComposition('fail-continue', {});
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.reason, 'condition boom');
    assert.strictEqual(result.continued, true);
  });

  it('should execute fallback hook when onFailure is fallback', async () => {
    executor = createMockExecutor([
      { passed: true, source: 'fallback' },
    ]);
    composer = new HookComposer(executor);
    composer.createComposition('fail-fallback', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      onFailure: 'fallback',
      fallbackHook: { event: 'fallback-event', action: 'fallback-action' },
      hooks: [{
        event: 'e1',
        action: 'a1',
        condition: () => { throw new Error('main failed'); },
      }],
    });
    const result = await composer.executeComposition('fail-fallback', {});
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.source, 'fallback');
  });

  it('should emit composition-failed event on error', async () => {
    let failData = null;
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.on('composition-failed', (d) => { failData = d; });
    composer.createComposition('emit-fail', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      onFailure: 'continue',
      hooks: [{
        event: 'e1',
        action: 'a1',
        condition: () => { throw new Error('boom'); },
      }],
    });
    await composer.executeComposition('emit-fail', {});
    assert.ok(failData);
    assert.strictEqual(failData.compositionId, 'emit-fail');
    assert.strictEqual(failData.error, 'boom');
  });

  it('should increment compositionsFailed stat', async () => {
    executor = createMockExecutor([{ passed: true }]);
    composer = new HookComposer(executor);
    composer.createComposition('stat-fail', {
      strategy: COMPOSITION_STRATEGIES.CONDITIONAL,
      onFailure: 'continue',
      hooks: [{
        event: 'e1',
        action: 'a1',
        condition: () => { throw new Error('err'); },
      }],
    });
    await composer.executeComposition('stat-fail', {});
    assert.strictEqual(composer.getStats().compositionsFailed, 1);
  });

  it('should throw when shut down', async () => {
    composer.createComposition('shut-exec', { hooks: [] });
    composer.shutdown();
    await assert.rejects(
      () => composer.executeComposition('shut-exec', {}),
    );
  });
});

describe('HookComposer - getComposition, listCompositions, removeComposition', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  describe('getComposition', () => {
    it('should return composition by id', () => {
      composer.createComposition('get-me', {
        name: 'Test',
        hooks: [{ event: 'e1', action: 'a1' }],
      });
      const comp = composer.getComposition('get-me');
      assert.ok(comp);
      assert.strictEqual(comp.id, 'get-me');
      assert.strictEqual(comp.name, 'Test');
    });

    it('should return null for unknown id', () => {
      assert.strictEqual(composer.getComposition('unknown'), null);
    });

    it('should return null after shutdown', () => {
      composer.createComposition('before-shut', { hooks: [] });
      composer.shutdown();
      assert.strictEqual(composer.getComposition('before-shut'), null);
    });
  });

  describe('listCompositions', () => {
    it('should return empty array when no compositions', () => {
      const list = composer.listCompositions();
      assert.deepStrictEqual(list, []);
    });

    it('should list all compositions with summary info', () => {
      composer.createComposition('list-1', {
        name: 'First',
        strategy: COMPOSITION_STRATEGIES.SEQUENTIAL,
        hooks: [{ event: 'e1', action: 'a1' }],
      });
      composer.createComposition('list-2', {
        name: 'Second',
        strategy: COMPOSITION_STRATEGIES.PARALLEL,
        hooks: [{ event: 'e2', action: 'a2' }, { event: 'e3', action: 'a3' }],
      });
      const list = composer.listCompositions();
      assert.strictEqual(list.length, 2);
      const first = list.find((c) => c.id === 'list-1');
      assert.strictEqual(first.name, 'First');
      assert.strictEqual(first.strategy, 'sequential');
      assert.strictEqual(first.hookCount, 1);
      const second = list.find((c) => c.id === 'list-2');
      assert.strictEqual(second.hookCount, 2);
    });

    it('should return empty array after shutdown', () => {
      composer.createComposition('shut-list', { hooks: [] });
      composer.shutdown();
      assert.deepStrictEqual(composer.listCompositions(), []);
    });
  });

  describe('removeComposition', () => {
    it('should remove existing composition and return true', () => {
      composer.createComposition('remove-me', { hooks: [] });
      const removed = composer.removeComposition('remove-me');
      assert.strictEqual(removed, true);
      assert.strictEqual(composer.getComposition('remove-me'), null);
    });

    it('should return false for non-existent composition', () => {
      const removed = composer.removeComposition('no-such');
      assert.strictEqual(removed, false);
    });

    it('should emit composition-removed event', () => {
      let eventData = null;
      composer.on('composition-removed', (d) => { eventData = d; });
      composer.createComposition('emit-remove', { hooks: [] });
      composer.removeComposition('emit-remove');
      assert.ok(eventData);
      assert.strictEqual(eventData.compositionId, 'emit-remove');
    });

    it('should not emit composition-removed for non-existent id', () => {
      let emitted = false;
      composer.on('composition-removed', () => { emitted = true; });
      composer.removeComposition('no-such');
      assert.strictEqual(emitted, false);
    });

    it('should throw when shut down', () => {
      composer.shutdown();
      assert.throws(() => composer.removeComposition('any'));
    });
  });
});

describe('HookComposer - getStats and shutdown', () => {
  let composer;
  let executor;

  beforeEach(() => {
    executor = createMockExecutor();
    composer = new HookComposer(executor);
  });

  afterEach(() => {
    if (composer && !composer._shutDown) {
      composer.shutdown();
    }
    composer = null;
    executor = null;
  });

  describe('getStats', () => {
    it('should return stats with totalCompositions', () => {
      composer.createComposition('stat-1', { hooks: [{ event: 'e1', action: 'a1' }] });
      composer.createComposition('stat-2', { hooks: [{ event: 'e2', action: 'a2' }] });
      const stats = composer.getStats();
      assert.strictEqual(stats.compositionsCreated, 2);
      assert.strictEqual(stats.totalHooksComposed, 2);
      assert.strictEqual(stats.totalCompositions, 2);
    });

    it('should return zeroed stats after shutdown', () => {
      composer.createComposition('stat-shut', { hooks: [{ event: 'e1', action: 'a1' }] });
      composer.shutdown();
      const stats = composer.getStats();
      assert.strictEqual(stats.compositionsCreated, 0);
      assert.strictEqual(stats.compositionsExecuted, 0);
      assert.strictEqual(stats.compositionsFailed, 0);
      assert.strictEqual(stats.totalHooksComposed, 0);
    });
  });

  describe('shutdown', () => {
    it('should clear all compositions', () => {
      composer.createComposition('shut-1', { hooks: [] });
      composer.createComposition('shut-2', { hooks: [] });
      composer.shutdown();
      assert.deepStrictEqual(composer.listCompositions(), []);
    });

    it('should remove all listeners', () => {
      composer.on('composition-created', () => {});
      composer.on('composition-removed', () => {});
      assert.strictEqual(composer.listenerCount('composition-created'), 1);
      assert.strictEqual(composer.listenerCount('composition-removed'), 1);
      composer.shutdown();
      assert.strictEqual(composer.listenerCount('composition-created'), 0);
      assert.strictEqual(composer.listenerCount('composition-removed'), 0);
    });

    it('should prevent createComposition after shutdown', () => {
      composer.shutdown();
      assert.throws(() => composer.createComposition('after', { hooks: [] }));
    });

    it('should prevent executeComposition after shutdown', async () => {
      composer.createComposition('before', { hooks: [] });
      composer.shutdown();
      await assert.rejects(() => composer.executeComposition('before', {}));
    });

    it('should be idempotent', () => {
      composer.shutdown();
      composer.shutdown();
      assert.strictEqual(composer._shutDown, true);
    });
  });
});
