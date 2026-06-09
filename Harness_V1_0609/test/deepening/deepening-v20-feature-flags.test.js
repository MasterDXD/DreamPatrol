'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningFeatureFlags = require('../../src/runtime/deepening/deepening-feature-flags');

describe('DeepeningFeatureFlags - Define and Evaluate', function() {
  let ff;

  beforeEach(function() {
    ff = new DeepeningFeatureFlags({ maxHistory: 50 });
  });

  afterEach(function() {
    if (ff) ff.shutdown();
  });

  it('should create with defaults', function() {
    const f = new DeepeningFeatureFlags();
    assert.strictEqual(f.getStats().totalFlags, 0);
    f.shutdown();
  });

  it('should define a flag', function() {
    ff.define('new-ui', { state: 'on', description: 'New UI feature' });
    assert.strictEqual(ff.getStats().totalFlags, 1);
  });

  it('should return error on define without name', function() {
    const result = ff.define('');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Flag name is required'));
  });

  it('should not define duplicate flag', function() {
    ff.define('new-ui', { state: 'on' });
    ff.define('new-ui', { state: 'off' });
    assert.strictEqual(ff.getStats().totalFlags, 1);
  });

  it('should emit defined event', function() {
    let emitted = null;
    ff.on('defined', function(e) { emitted = e; });
    ff.define('new-ui', { state: 'on' });
    assert.strictEqual(emitted.name, 'new-ui');
    assert.strictEqual(emitted.state, 'on');
  });

  it('should remove a flag', function() {
    ff.define('new-ui');
    let emitted = null;
    ff.on('removed', function(e) { emitted = e; });
    const result = ff.remove('new-ui');
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'new-ui');
    assert.strictEqual(ff.getStats().totalFlags, 0);
  });

  it('should return false for removing unknown flag', function() {
    assert.strictEqual(ff.remove('unknown'), false);
  });

  it('should return false for isEnabled of unknown flag', function() {
    assert.strictEqual(ff.isEnabled('unknown'), false);
  });

  it('should evaluate ON flag as true', function() {
    ff.define('new-ui', { state: 'on' });
    assert.strictEqual(ff.isEnabled('new-ui'), true);
  });

  it('should evaluate OFF flag as false', function() {
    ff.define('new-ui', { state: 'off' });
    assert.strictEqual(ff.isEnabled('new-ui'), false);
  });

  it('should evaluate PERCENTAGE flag', function() {
    ff.define('gradual', { state: 'percentage', percentage: 100 });
    assert.strictEqual(ff.isEnabled('gradual', { userId: 'user1' }), true);
  });

  it('should evaluate PERCENTAGE flag with 0 percent', function() {
    ff.define('gradual', { state: 'percentage', percentage: 0 });
    assert.strictEqual(ff.isEnabled('gradual', { userId: 'user1' }), false);
  });

  it('should evaluate VARIANTS flag with matching rule', function() {
    ff.define('variant-flag', {
      state: 'variants',
      variants: {
        groupA: { rules: [{ field: 'region', operator: 'eq', value: 'us' }] },
      },
    });
    assert.strictEqual(ff.isEnabled('variant-flag', { region: 'us' }), true);
    assert.strictEqual(ff.isEnabled('variant-flag', { region: 'eu' }), false);
  });

  it('should evaluate VARIANTS with "in" operator', function() {
    ff.define('multi-region', {
      state: 'variants',
      variants: {
        groupA: { rules: [{ field: 'region', operator: 'in', value: ['us', 'uk'] }] },
      },
    });
    assert.strictEqual(ff.isEnabled('multi-region', { region: 'us' }), true);
    assert.strictEqual(ff.isEnabled('multi-region', { region: 'uk' }), true);
    assert.strictEqual(ff.isEnabled('multi-region', { region: 'jp' }), false);
  });

  it('should evaluate VARIANTS with "gt" and "lt" operators', function() {
    ff.define('age-flag', {
      state: 'variants',
      variants: {
        adult: { rules: [{ field: 'age', operator: 'gt', value: 17 }] },
        child: { rules: [{ field: 'age', operator: 'lt', value: 13 }] },
      },
    });
    assert.strictEqual(ff.isEnabled('age-flag', { age: 20 }), true);
    assert.strictEqual(ff.isEnabled('age-flag', { age: 10 }), true);
    assert.strictEqual(ff.isEnabled('age-flag', { age: 15 }), false);
  });

  it('should return false for VARIANTS without context', function() {
    ff.define('variant-flag', {
      state: 'variants',
      variants: { groupA: { rules: [{ field: 'region', operator: 'eq', value: 'us' }] } },
    });
    assert.strictEqual(ff.isEnabled('variant-flag'), false);
  });

  it('should get variant name', function() {
    ff.define('variant-flag', {
      state: 'variants',
      variants: {
        groupA: { rules: [{ field: 'region', operator: 'eq', value: 'us' }] },
      },
      defaultVariant: 'groupB',
    });
    assert.strictEqual(ff.getVariant('variant-flag', { region: 'us' }), 'groupA');
    assert.strictEqual(ff.getVariant('variant-flag', { region: 'eu' }), 'groupB');
    assert.strictEqual(ff.getVariant('variant-flag'), 'groupB');
  });

  it('should return null for getVariant of unknown flag', function() {
    assert.strictEqual(ff.getVariant('unknown'), null);
  });

  it('should return defaultVariant for non-variants flag', function() {
    ff.define('simple', { state: 'on', defaultVariant: 'default' });
    assert.strictEqual(ff.getVariant('simple'), 'default');
  });
});

describe('DeepeningFeatureFlags - Modify and Stats', function() {
  let ff;

  beforeEach(function() {
    ff = new DeepeningFeatureFlags({ maxHistory: 50 });
  });

  afterEach(function() {
    if (ff) ff.shutdown();
  });

  it('should turn on a flag', function() {
    ff.define('test', { state: 'off' });
    let emitted = null;
    ff.on('changed', function(e) { emitted = e; });
    ff.turnOn('test');
    assert.strictEqual(ff.isEnabled('test'), true);
    assert.strictEqual(emitted.from, 'off');
    assert.strictEqual(emitted.to, 'on');
  });

  it('should turn off a flag', function() {
    ff.define('test', { state: 'on' });
    ff.turnOff('test');
    assert.strictEqual(ff.isEnabled('test'), false);
  });

  it('should return error on turnOn unknown flag', function() {
    const result = ff.turnOn('unknown');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Flag not found'));
  });

  it('should return error on turnOff unknown flag', function() {
    const result = ff.turnOff('unknown');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Flag not found'));
  });

  it('should set percentage', function() {
    ff.define('gradual', { state: 'off' });
    let emitted = null;
    ff.on('changed', function(e) { emitted = e; });
    ff.setPercentage('gradual', 50);
    assert.strictEqual(emitted.to, 'percentage');
    assert.strictEqual(emitted.percentage, 50);
  });

  it('should clamp percentage to 0-100', function() {
    ff.define('gradual');
    ff.setPercentage('gradual', 150);
    const flag = ff.getFlag('gradual');
    assert.strictEqual(flag.percentage, 100);
    ff.setPercentage('gradual', -10);
    const flag2 = ff.getFlag('gradual');
    assert.strictEqual(flag2.percentage, 0);
  });

  it('should return error on setPercentage unknown flag', function() {
    const result = ff.setPercentage('unknown', 50);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Flag not found'));
  });

  it('should set variants', function() {
    ff.define('test', { state: 'off' });
    const variants = { groupA: { rules: [{ field: 'x', operator: 'eq', value: 1 }] } };
    ff.setVariants('test', variants, 'groupA');
    const flag = ff.getFlag('test');
    assert.strictEqual(flag.state, 'variants');
  });

  it('should return error on setVariants unknown flag', function() {
    const result = ff.setVariants('unknown', {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Flag not found'));
  });

  it('should get flag details', function() {
    ff.define('test', { state: 'on', description: 'A test flag', owner: 'team-a', tags: ['beta'] });
    const flag = ff.getFlag('test');
    assert.strictEqual(flag.name, 'test');
    assert.strictEqual(flag.state, 'on');
    assert.strictEqual(flag.description, 'A test flag');
    assert.strictEqual(flag.owner, 'team-a');
    assert.deepStrictEqual(flag.tags, ['beta']);
    assert.strictEqual(flag.evaluationCount, 0);
  });

  it('should return null for getFlag unknown', function() {
    assert.strictEqual(ff.getFlag('unknown'), null);
  });

  it('should get flag names', function() {
    ff.define('a');
    ff.define('b');
    ff.define('c');
    assert.deepStrictEqual(ff.getFlagNames(), ['a', 'b', 'c']);
  });

  it('should get flags by tag', function() {
    ff.define('a', { tags: ['beta'] });
    ff.define('b', { tags: ['stable'] });
    ff.define('c', { tags: ['beta'] });
    const beta = ff.getByTag('beta');
    assert.strictEqual(beta.length, 2);
  });

  it('should track evaluation counts', function() {
    ff.define('test', { state: 'on' });
    ff.isEnabled('test');
    ff.isEnabled('test');
    ff.isEnabled('test');
    const flag = ff.getFlag('test');
    assert.strictEqual(flag.evaluationCount, 3);
    assert.strictEqual(flag.onCount, 3);
  });

  it('should track global stats', function() {
    ff.define('a', { state: 'on' });
    ff.define('b', { state: 'off' });
    ff.isEnabled('a');
    ff.isEnabled('b');
    const stats = ff.getStats();
    assert.strictEqual(stats.totalFlags, 2);
    assert.strictEqual(stats.totalEvaluations, 2);
    assert.strictEqual(stats.totalOn, 1);
    assert.strictEqual(stats.totalOff, 1);
  });

  it('should record history on changes', function() {
    ff.define('test', { state: 'off' });
    ff.turnOn('test');
    ff.turnOff('test');
    const history = ff.getHistory();
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].from, 'off');
    assert.strictEqual(history[0].to, 'on');
    assert.strictEqual(history[1].from, 'on');
    assert.strictEqual(history[1].to, 'off');
  });

  it('should limit history size', function() {
    ff.define('test', { state: 'off' });
    for (let i = 0; i < 60; i++) {
      ff.turnOn('test');
      ff.turnOff('test');
    }
    const history = ff.getHistory();
    assert.ok(history.length <= 50);
  });

  it('should get history with limit', function() {
    ff.define('test', { state: 'off' });
    for (let i = 0; i < 10; i++) {
      ff.turnOn('test');
      ff.turnOff('test');
    }
    const history = ff.getHistory(5);
    assert.strictEqual(history.length, 5);
  });

  it('should expose FLAG_STATES', function() {
    assert.strictEqual(DeepeningFeatureFlags.FLAG_STATES.ON, 'on');
    assert.strictEqual(DeepeningFeatureFlags.FLAG_STATES.OFF, 'off');
    assert.strictEqual(DeepeningFeatureFlags.FLAG_STATES.PERCENTAGE, 'percentage');
    assert.strictEqual(DeepeningFeatureFlags.FLAG_STATES.VARIANTS, 'variants');
  });

  it('should shutdown cleanly', function() {
    ff.define('test');
    let emitted = false;
    ff.on('shutdown', function() { emitted = true; });
    ff.shutdown();
    assert.strictEqual(emitted, true);
    assert.strictEqual(ff.getStats().totalFlags, 0);
  });

  it('should be healthy', function() {
    assert.strictEqual(ff.isHealthy(), true);
  });
});
