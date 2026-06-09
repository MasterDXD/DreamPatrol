'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ContainerSandboxManager = require(
  path.join(ROOT, 'src', 'runtime', 'infrastructure', 'container-sandbox-manager'),
);
const SANDBOX_STATUS = ContainerSandboxManager.SANDBOX_STATUS;
const ISOLATION_LEVEL = ContainerSandboxManager.ISOLATION_LEVEL;

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('ContainerSandboxManager', () => {
  afterEach(async () => { await _cleanAll(); });

  it('should construct with default config', () => {
    const mgr = _track(new ContainerSandboxManager());
    assert.ok(mgr);
    assert.strictEqual(mgr._config.defaultIsolationLevel, ISOLATION_LEVEL.PROCESS);
    assert.strictEqual(mgr._config.dockerEnabled, false);
    assert.strictEqual(mgr._config.maxContainers, 10);
    assert.strictEqual(mgr._config.auditEnabled, true);
    assert.strictEqual(mgr.isHealthy(), true);
  });

  it('should createSandbox with PROCESS isolation level', () => {
    const mgr = _track(new ContainerSandboxManager());
    const sandboxId = mgr.createSandbox('task-1', { isolationLevel: ISOLATION_LEVEL.PROCESS });
    assert.ok(sandboxId);
    assert.ok(sandboxId.startsWith('sandbox-'));
    const info = mgr.getSandbox(sandboxId);
    assert.strictEqual(info.taskId, 'task-1');
    assert.strictEqual(info.isolationLevel, ISOLATION_LEVEL.PROCESS);
    assert.strictEqual(info.status, SANDBOX_STATUS.RUNNING);
  });

  it('should reject empty taskId', () => {
    const mgr = _track(new ContainerSandboxManager());
    assert.throws(() => mgr.createSandbox(''), /taskId must be a non-empty string/);
    assert.throws(() => mgr.createSandbox(null), /taskId must be a non-empty string/);
  });

  it('should reject when max sandboxes reached', () => {
    const mgr = _track(new ContainerSandboxManager({ maxContainers: 2 }));
    mgr.createSandbox('task-1');
    mgr.createSandbox('task-2');
    assert.throws(() => mgr.createSandbox('task-3'), /Maximum sandbox count reached/);
  });

  it('should executeInSandbox on running sandbox', async () => {
    const mgr = _track(new ContainerSandboxManager());
    const sandboxId = mgr.createSandbox('task-exec');
    const result = await mgr.executeInSandbox(sandboxId, 'echo hello');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
  });

  it('should reject executeInSandbox for unknown sandbox', async () => {
    const mgr = _track(new ContainerSandboxManager());
    await assert.rejects(
      () => mgr.executeInSandbox('nonexistent', 'echo hello'),
      /Sandbox not found/,
    );
  });

  it('should writeFile and readFile', async () => {
    const mgr = _track(new ContainerSandboxManager());
    const sandboxId = mgr.createSandbox('task-io');
    const writeResult = await mgr.writeFile(sandboxId, '/tmp/test.txt', 'hello');
    assert.strictEqual(writeResult.success, true);
    assert.strictEqual(writeResult.path, '/tmp/test.txt');
    const readResult = await mgr.readFile(sandboxId, '/tmp/test.txt');
    assert.strictEqual(readResult.success, true);
    assert.strictEqual(readResult.path, '/tmp/test.txt');
  });

  it('should stopSandbox', () => {
    const mgr = _track(new ContainerSandboxManager());
    const sandboxId = mgr.createSandbox('task-stop');
    const stopped = mgr.stopSandbox(sandboxId);
    assert.strictEqual(stopped, true);
    assert.strictEqual(mgr.getSandbox(sandboxId), null);
    assert.strictEqual(mgr.stopSandbox(sandboxId), false);
  });

  it('should getAuditLog returning defensive copy', () => {
    const mgr = _track(new ContainerSandboxManager());
    mgr.createSandbox('task-audit');
    const log1 = mgr.getAuditLog();
    assert.ok(Array.isArray(log1));
    assert.ok(log1.length > 0);
    log1[0].action = 'tampered';
    const log2 = mgr.getAuditLog();
    assert.strictEqual(log2[0].action, 'create');
  });

  it('should prevent operations after shutdown', () => {
    const mgr = _track(new ContainerSandboxManager());
    mgr.shutdown();
    assert.throws(() => mgr.createSandbox('task-after-shutdown'), /shut down/);
  });
});
