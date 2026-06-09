'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function createTempDir(prefix) {
  const dir = path.join(os.tmpdir(), prefix + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
}

function ensureHarnessDir(dir) {
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
}


describe('ProgrammableHookExecutor', function () {
  const BENCHMARK_THRESHOLDS = {
    sessionCreateMs: 100,
    skillDiscoveryMs: 500,
    hookExecutionMs: 200,
    subagentSpawnMs: 200,
  };
  it('hook execution should be under ' + BENCHMARK_THRESHOLDS.hookExecutionMs + 'ms', async function () {
    const tempRoot = createTempDir('harness-bench');
    ensureHarnessDir(tempRoot);

    try {
      const ProgrammableHookExecutor = require('../../../src/runtime/workflow/programmable-hook-executor');
      const hookExecutor = new ProgrammableHookExecutor(tempRoot);

      hookExecutor.register('before-test', {
        type: 'function',
        name: 'benchmark-hook',
        handler: function () {
          let sum = 0;
          for (let i = 0; i < 100; i++) sum += i;
          return { passed: true, message: 'ok', value: sum };
        },
      });

      const start = Date.now();
      const results = await hookExecutor.execute('before-test', { test: true });
      const elapsed = Date.now() - start;

      assert.ok(Array.isArray(results));
      assert.ok(results.length > 0);
      assert.ok(elapsed < BENCHMARK_THRESHOLDS.hookExecutionMs,
        'Hook execution took ' + elapsed + 'ms, threshold: ' + BENCHMARK_THRESHOLDS.hookExecutionMs + 'ms');

      hookExecutor.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  it('getHookMonitorData should return valid data', function () {
    const tempRoot = createTempDir('harness-bench-mon');
    ensureHarnessDir(tempRoot);

    try {
      const ProgrammableHookExecutor = require('../../../src/runtime/workflow/programmable-hook-executor');
      const hookExecutor = new ProgrammableHookExecutor(tempRoot);

      const data = hookExecutor.getHookMonitorData();
      assert.ok(data.global);
      assert.ok(typeof data.global.calls === 'number');
      assert.ok(typeof data.global.successRate === 'number');
      assert.ok(Array.isArray(data.perHook));
      assert.ok(Array.isArray(data.recentExecutions));
      assert.ok(Array.isArray(data.slowHooks));
      assert.ok(data.slowHookCount >= 0);

      hookExecutor.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  it('resetMonitorData should clear all data', function () {
    const tempRoot = createTempDir('harness-bench-reset');
    ensureHarnessDir(tempRoot);

    try {
      const ProgrammableHookExecutor = require('../../../src/runtime/workflow/programmable-hook-executor');
      const hookExecutor = new ProgrammableHookExecutor(tempRoot);

      hookExecutor.resetMonitorData();
      const data = hookExecutor.getHookMonitorData();
      assert.strictEqual(data.global.calls, 0);
      assert.strictEqual(data.global.passes, 0);
      assert.strictEqual(data.global.failures, 0);
      assert.strictEqual(data.global.errors, 0);
      assert.strictEqual(data.recentExecutions.length, 0);
      assert.strictEqual(data.slowHooks.length, 0);
      assert.strictEqual(data.slowHookCount, 0);

      hookExecutor.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  it('slow hook detection should emit event when hook exceeds threshold', async function () {
    const tempRoot = createTempDir('harness-bench-slow');
    ensureHarnessDir(tempRoot);

    try {
      const ProgrammableHookExecutor = require('../../../src/runtime/workflow/programmable-hook-executor');
      const hookExecutor = new ProgrammableHookExecutor(tempRoot);

      let slowDetected = false;
      hookExecutor.on('slow-hook-detected', function () { slowDetected = true; });

      hookExecutor.register('slow-test', {
        type: 'function',
        name: 'slow-hook',
        handler: function () {
          const start = Date.now();
          while (Date.now() - start < 510) { /* intentional busy-wait for slow hook benchmark */ }
          return { passed: true, message: 'slow' };
        },
      });

      await hookExecutor.execute('slow-test', {});

      assert.ok(slowDetected, 'Should have detected slow hook');
      const data = hookExecutor.getHookMonitorData();
      assert.ok(data.slowHookCount > 0);

      hookExecutor.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });
});

describe('AgentPackManager', function () {
  it('discover should find packs and install/uninstall cycle works', function () {
    const tempRoot = createTempDir('harness-pack-bench');
    ensureHarnessDir(tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.harness', 'agent-packs'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.harness', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.harness', 'skills'), { recursive: true });

    const testPackDir = path.join(tempRoot, '.harness', 'agent-packs', 'test-pack');
    fs.mkdirSync(testPackDir, { recursive: true });
    fs.writeFileSync(path.join(testPackDir, 'pack.json'), JSON.stringify({
      id: 'test-pack', name: 'Test Pack', version: '1.0.0',
      description: 'A test pack', author: 'Test',
      category: 'test', tags: ['test'], dependencies: [],
    }));
    fs.writeFileSync(path.join(testPackDir, 'agent.md'), '---\nagent_id: test-pack-agent\nrole: Test\nlevel: 1\n---\n# Test Agent');
    fs.writeFileSync(path.join(testPackDir, 'command.md'), '---\ncommand_id: test-pack-cmd\n---\n# Test Command');

    try {
      const AgentPackManager = require('../../../src/runtime/agent/agent-pack-manager');
      const packManager = new AgentPackManager(tempRoot);
      packManager.discover();

      const packs = packManager.list();
      assert.ok(packs.length > 0);
      assert.strictEqual(packs[0].id, 'test-pack');

      const installResult = packManager.install('test-pack');
      assert.ok(installResult.success);

      const installed = packManager.listInstalled();
      assert.ok(installed.length > 0);
      assert.strictEqual(installed[0].id, 'test-pack');

      const info = packManager.getPackInfo('test-pack');
      assert.ok(info);
      assert.ok(info.installed);

      const validation = packManager.validatePack('test-pack');
      assert.ok(validation.valid);

      const stats = packManager.getStats();
      assert.ok(stats.totalPacks > 0);
      assert.ok(stats.installedPacks > 0);

      const uninstallResult = packManager.uninstall('test-pack');
      assert.ok(uninstallResult.success);
      assert.strictEqual(packManager.listInstalled().length, 0);

      packManager.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });
});

describe('SessionManager Benchmark', function () {
  const BENCHMARK_THRESHOLDS = {
    sessionCreateMs: 200,
    skillDiscoveryMs: 500,
    hookExecutionMs: 50,
    subagentSpawnMs: 200,
  };
  it('create session should complete under ' + BENCHMARK_THRESHOLDS.sessionCreateMs + 'ms', function () {
    const tempRoot = createTempDir('harness-session-bench');
    ensureHarnessDir(tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.harness', 'sessions'), { recursive: true });

    try {
      const SessionManager = require('../../../src/runtime/session/session-manager');
      const sessionManager = new SessionManager(tempRoot);

      const sessionId = 'bench-session-' + Date.now();
      const start = Date.now();
      const session = sessionManager.create(sessionId);
      const elapsed = Date.now() - start;

      assert.ok(session);
      assert.ok(session.id);
      assert.ok(elapsed < BENCHMARK_THRESHOLDS.sessionCreateMs,
        'Session creation took ' + elapsed + 'ms, threshold: ' + BENCHMARK_THRESHOLDS.sessionCreateMs + 'ms');

      sessionManager.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  it('getPreviousSessionContext should return null or valid context', async function () {
    const tempRoot = createTempDir('harness-session-prev');
    ensureHarnessDir(tempRoot);
    fs.mkdirSync(path.join(tempRoot, '.harness', 'sessions'), { recursive: true });

    try {
      const SessionManager = require('../../../src/runtime/session/session-manager');
      const sessionManager = new SessionManager(tempRoot);

      const ctx = await sessionManager.getPreviousSessionContext();
      if (ctx) {
        assert.ok(ctx.sessionId);
        assert.ok(typeof ctx.lastPhase === 'string');
        assert.ok(Array.isArray(ctx.completedSkills));
      }

      sessionManager.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });
});

describe('SkillRouter Benchmark', function () {
  const BENCHMARK_THRESHOLDS = {
    sessionCreateMs: 100,
    skillDiscoveryMs: 500,
    hookExecutionMs: 50,
    subagentSpawnMs: 200,
  };
  it('discover should complete under ' + BENCHMARK_THRESHOLDS.skillDiscoveryMs + 'ms', function () {
    const SkillRouter = require('../../../src/runtime/skill/skill-router');
    const router = new SkillRouter(ROOT);

    const start = Date.now();
    router.discover();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < BENCHMARK_THRESHOLDS.skillDiscoveryMs,
      'Skill discovery took ' + elapsed + 'ms, threshold: ' + BENCHMARK_THRESHOLDS.skillDiscoveryMs + 'ms');
  });
});

describe('SubagentExecutor Benchmark', function () {
  const BENCHMARK_THRESHOLDS = {
    sessionCreateMs: 100,
    skillDiscoveryMs: 500,
    hookExecutionMs: 50,
    subagentSpawnMs: 200,
  };
  it('spawn should complete under ' + BENCHMARK_THRESHOLDS.subagentSpawnMs + 'ms', async function () {
    const tempRoot = createTempDir('harness-subagent-bench');
    try {
      const SubagentExecutor = require('../../../src/runtime/agent/subagent-executor');
      const executor = new SubagentExecutor(tempRoot);

      const start = Date.now();
      const handle = await executor.spawn({ description: 'benchmark task', sessionId: 'bench-session' });
      const elapsed = Date.now() - start;

      assert.ok(handle);
      assert.ok(handle.handleId);
      assert.ok(elapsed < BENCHMARK_THRESHOLDS.subagentSpawnMs,
        'Subagent spawn took ' + elapsed + 'ms, threshold: ' + BENCHMARK_THRESHOLDS.subagentSpawnMs + 'ms');

      executor.cancel(handle.handleId);
      executor.shutdown();
    } finally {
      cleanupTempDir(tempRoot);
    }
  });
});
