'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), 'harness-hook-test-' + Date.now());

describe('ProgrammableHookExecutor - Core', () => {
  let ProgrammableHookExecutor;
  const _cleanup = [];

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness'), { recursive: true });
    ProgrammableHookExecutor = require('../../src/runtime/workflow/programmable-hook-executor');
  });

  afterEach(() => {
    for (const obj of _cleanup) {
      try { obj.shutdown(); } catch (_) { /* ignore */ }
    }
    _cleanup.length = 0;
  });

  after(() => {
    for (const obj of _cleanup) {
      try { obj.shutdown(); } catch (_) { /* ignore */ }
    }
    _cleanup.length = 0;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('register() and execute()', () => {
    it('should register and execute builtin hook actions', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('pre_file_write', {
        type: 'builtin',
        name: 'path_validation',
      });

      const results = await executor.execute('pre_file_write', {
        file_path: '/etc/passwd',
        project_root: TEST_DIR,
      });

      assert.ok(Array.isArray(results));
      assert.ok(results.length >= 1);
    });

    it('should register and execute function hook actions', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      let called = false;

      executor.register('pre_file_write', {
        type: 'function',
        handler: (_context) => {
          called = true;
          return { passed: true, message: 'Custom check passed' };
        },
      });

      const results = await executor.execute('pre_file_write', { file_path: 'test.js' });
      assert.ok(called);
      assert.ok(results.length >= 1);
      assert.ok(results[0].passed);
    });

    it('should execute multiple hooks in order', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      const order = [];

      executor.register('pre_file_write', {
        type: 'function',
        handler: () => { order.push(1); return { passed: true }; },
      });
      executor.register('pre_file_write', {
        type: 'function',
        handler: () => { order.push(2); return { passed: true }; },
      });
      executor.register('pre_file_write', {
        type: 'function',
        handler: () => { order.push(3); return { passed: true }; },
      });

      await executor.execute('pre_file_write', {});
      assert.deepEqual(order, [1, 2, 3]);
    });

    it('should stop execution when a hook blocks', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      const order = [];

      executor.register('pre_file_write', {
        type: 'function',
        handler: () => { order.push(1); return { passed: true }; },
      });
      executor.register('pre_file_write', {
        type: 'function',
        handler: () => { order.push(2); return { passed: false, reason: 'Blocked' }; },
      });
      executor.register('pre_file_write', {
        type: 'function',
        handler: () => { order.push(3); return { passed: true }; },
      });

      const results = await executor.execute('pre_file_write', {});
      assert.deepEqual(order, [1, 2]);
      assert.ok(results.some(r => !r.passed));
    });
  });

  describe('builtin path_validation', () => {
    it('should block paths outside project root', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('pre_file_write', { type: 'builtin', name: 'path_validation' });

      const results = await executor.execute('pre_file_write', {
        file_path: '/etc/passwd',
        project_root: TEST_DIR,
      });

      assert.ok(results.some(r => !r.passed));
    });

    it('should allow paths inside project root', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('pre_file_write', { type: 'builtin', name: 'path_validation' });

      const results = await executor.execute('pre_file_write', {
        file_path: path.join(TEST_DIR, 'src', 'index.js'),
        project_root: TEST_DIR,
      });

      assert.ok(results.every(r => r.passed));
    });
  });

  describe('builtin content_safety', () => {
    it('should block content with secrets', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('pre_file_write', { type: 'builtin', name: 'content_safety' });

      const results = await executor.execute('pre_file_write', {
        content: 'const API_KEY = "sk-1234567890abcdef";',
      });

      assert.ok(results.some(r => !r.passed));
    });

    it('should allow safe content', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('pre_file_write', { type: 'builtin', name: 'content_safety' });

      const results = await executor.execute('pre_file_write', {
        content: 'const greeting = "Hello, World!";',
      });

      assert.ok(results.every(r => r.passed));
    });
  });

  describe('unregister()', () => {
    it('should unregister a hook action', async () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      let called = false;

      executor.register('pre_file_write', {
        id: 'test-hook',
        type: 'function',
        handler: () => { called = true; return { passed: true }; },
      });

      executor.unregister('pre_file_write', 'test-hook');
      await executor.execute('pre_file_write', {});
      assert.equal(called, false);
    });
  });

  describe('getRegisteredHooks()', () => {
    it('should list registered hooks for an event', () => {
      const executor = new ProgrammableHookExecutor(TEST_DIR);
      _cleanup.push(executor);
      executor.register('pre_file_write', { id: 'h1', type: 'function', handler: () => ({ passed: true }) });
      executor.register('pre_file_write', { id: 'h2', type: 'function', handler: () => ({ passed: true }) });

      const hooks = executor.getRegisteredHooks('pre_file_write');
      assert.equal(hooks.length, 2);
    });
  });
});
