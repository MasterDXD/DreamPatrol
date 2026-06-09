'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningConfigManager = require('../../src/runtime/deepening/deepening-config-manager');

describe('DeepeningConfigManager - Define and Modify', function() {
  let cm;

  beforeEach(function() {
    cm = new DeepeningConfigManager({ maxHistory: 50 });
  });

  afterEach(function() {
    if (cm) cm.shutdown();
  });

  it('should create with defaults', function() {
    const c = new DeepeningConfigManager();
    assert.strictEqual(c.getStats().totalConfigs, 0);
    c.shutdown();
  });

  it('should define a config', function() {
    cm.define('port', 3000);
    assert.strictEqual(cm.getStats().totalConfigs, 1);
  });

  it('should throw on define without key', function() {
    assert.throws(function() { cm.define(''); }, /Config key is required/);
  });

  it('should not define duplicate config', function() {
    cm.define('port', 3000);
    cm.define('port', 4000);
    assert.strictEqual(cm.get('port'), 3000);
  });

  it('should emit defined event', function() {
    let emitted = null;
    cm.on('defined', function(e) { emitted = e; });
    cm.define('port', 3000);
    assert.strictEqual(emitted.key, 'port');
    assert.strictEqual(emitted.value, 3000);
  });

  it('should get a config value', function() {
    cm.define('port', 3000);
    assert.strictEqual(cm.get('port'), 3000);
  });

  it('should return default for unknown key', function() {
    assert.strictEqual(cm.get('unknown', 42), 42);
  });

  it('should return undefined for unknown key without default', function() {
    assert.strictEqual(cm.get('unknown'), undefined);
  });

  it('should set a config value', function() {
    cm.define('port', 3000);
    cm.set('port', 8080);
    assert.strictEqual(cm.get('port'), 8080);
  });

  it('should auto-define on set unknown config', function() {
    cm.set('unknown', 1);
    assert.strictEqual(cm.get('unknown'), 1);
  });

  it('should throw on set immutable config', function() {
    cm.define('version', '1.0', { mutable: false });
    assert.throws(function() { cm.set('version', '2.0'); }, /immutable/);
  });

  it('should emit changed event', function() {
    let emitted = null;
    cm.define('port', 3000);
    cm.on('changed', function(e) { emitted = e; });
    cm.set('port', 8080);
    assert.strictEqual(emitted.key, 'port');
    assert.strictEqual(emitted.oldValue, 3000);
    assert.strictEqual(emitted.newValue, 8080);
  });

  it('should validate on set', function() {
    cm.define('port', 3000, { validator: function(v) { return v > 0 && v < 65536; } });
    cm.set('port', 8080);
    assert.strictEqual(cm.get('port'), 8080);
    assert.throws(function() { cm.set('port', -1); }, /Validation failed/);
  });

  it('should support string validation message', function() {
    cm.define('name', 'test', { validator: function(v) { return typeof v === 'string' ? true : 'Must be string'; } });
    assert.throws(function() { cm.set('name', 123); }, /Must be string/);
  });

  it('should track validation stats', function() {
    cm.define('port', 3000, { validator: function(v) { return v > 0; } });
    cm.set('port', 8080);
    cm.set('port', 9090);
    assert.throws(function() { cm.set('port', -1); }, /Validation failed/);
    const stats = cm.getStats();
    assert.strictEqual(stats.totalValidations, 3);
    assert.strictEqual(stats.totalValidationFailures, 1);
  });

  it('should reset a config', function() {
    cm.define('port', 3000);
    cm.set('port', 8080);
    const result = cm.reset('port');
    assert.strictEqual(result, true);
    assert.strictEqual(cm.get('port'), 3000);
  });

  it('should reset all configs', function() {
    cm.define('a', 1);
    cm.define('b', 2);
    cm.set('a', 10);
    cm.set('b', 20);
    cm.resetAll();
    assert.strictEqual(cm.get('a'), 1);
    assert.strictEqual(cm.get('b'), 2);
  });

  it('should remove a config', function() {
    cm.define('port', 3000);
    let emitted = null;
    cm.on('removed', function(e) { emitted = e; });
    const result = cm.remove('port');
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.key, 'port');
    assert.strictEqual(cm.has('port'), false);
  });

  it('should return false for removing unknown config', function() {
    assert.strictEqual(cm.remove('unknown'), false);
  });

  it('should check has config', function() {
    cm.define('port', 3000);
    assert.strictEqual(cm.has('port'), true);
    assert.strictEqual(cm.has('unknown'), false);
  });
});

describe('DeepeningConfigManager - Watch and Info', function() {
  let cm;

  beforeEach(function() {
    cm = new DeepeningConfigManager({ maxHistory: 50 });
  });

  afterEach(function() {
    if (cm) cm.shutdown();
  });

  it('should watch config changes', function() {
    cm.define('port', 3000);
    let watched = null;
    cm.watch('port', function(newVal, oldVal) { watched = { newVal: newVal, oldVal: oldVal }; });
    cm.set('port', 8080);
    assert.strictEqual(watched.newVal, 8080);
    assert.strictEqual(watched.oldVal, 3000);
  });

  it('should unwatch with returned function', function() {
    cm.define('port', 3000);
    let count = 0;
    const unwatch = cm.watch('port', function() { count++; });
    cm.set('port', 8080);
    unwatch();
    cm.set('port', 9090);
    assert.strictEqual(count, 1);
  });

  it('should infer type', function() {
    cm.define('num', 42);
    cm.define('str', 'hello');
    cm.define('bool', true);
    cm.define('arr', [1, 2]);
    cm.define('obj', { a: 1 });
    assert.strictEqual(cm.getConfigInfo('num').type, 'number');
    assert.strictEqual(cm.getConfigInfo('str').type, 'string');
    assert.strictEqual(cm.getConfigInfo('bool').type, 'boolean');
    assert.strictEqual(cm.getConfigInfo('arr').type, 'array');
    assert.strictEqual(cm.getConfigInfo('obj').type, 'object');
  });

  it('should get config info', function() {
    cm.define('port', 3000, { description: 'Server port', env: 'PORT' });
    const info = cm.getConfigInfo('port');
    assert.strictEqual(info.key, 'port');
    assert.strictEqual(info.defaultValue, 3000);
    assert.strictEqual(info.description, 'Server port');
    assert.strictEqual(info.env, 'PORT');
    assert.strictEqual(info.mutable, true);
  });

  it('should return null for unknown config info', function() {
    assert.strictEqual(cm.getConfigInfo('unknown'), null);
  });

  it('should get keys', function() {
    cm.define('a', 1);
    cm.define('b', 2);
    assert.deepStrictEqual(cm.getKeys(), ['a', 'b']);
  });

  it('should get by type', function() {
    cm.define('port', 3000);
    cm.define('host', 'localhost');
    const numbers = cm.getByType('number');
    assert.strictEqual(numbers.length, 1);
    assert.strictEqual(numbers[0], 'port');
  });

  it('should get all values', function() {
    cm.define('port', 3000);
    cm.define('host', 'localhost');
    const all = cm.getAll();
    assert.strictEqual(all.port, 3000);
    assert.strictEqual(all.host, 'localhost');
  });

  it('should record history', function() {
    cm.define('port', 3000);
    cm.set('port', 8080);
    cm.set('port', 9090);
    const history = cm.getHistory();
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].oldValue, 3000);
    assert.strictEqual(history[0].newValue, 8080);
  });

  it('should limit history', function() {
    const small = new DeepeningConfigManager({ maxHistory: 3 });
    small.define('port', 3000);
    for (let i = 0; i < 5; i++) small.set('port', 3000 + i);
    assert.strictEqual(small.getHistory().length, 3);
    small.shutdown();
  });

  it('should get stats', function() {
    cm.define('port', 3000);
    cm.set('port', 8080);
    const stats = cm.getStats();
    assert.strictEqual(stats.totalConfigs, 1);
    assert.strictEqual(stats.totalChanges, 1);
  });

  it('should shutdown cleanly', function() {
    cm.define('port', 3000);
    let emitted = false;
    cm.on('shutdown', function() { emitted = true; });
    cm.shutdown();
    assert.strictEqual(emitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(cm.isHealthy(), true);
  });
});
