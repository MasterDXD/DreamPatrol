'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('RBACEnforcer', () => {
  const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));

  it('should check if agent can execute skill', () => {
    const enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
    assert.ok(enforcer.canExecute('task-worker', 'tdd-implement'));
    assert.ok(!enforcer.canExecute('team-lead', 'tdd-implement'));
    assert.ok(enforcer.canExecute('domain-analyst', 'code-review'));
  });

  it('should get agent model', () => {
    const enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
    const model = enforcer.getAgentModel('task-worker');
    assert.ok(typeof model === 'string');
  });
});

describe('PermissionGuard', () => {
  const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));

  it('should block sensitive file operations outside project', () => {
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileWrite('/etc/passwd', 'task-worker');
    assert.ok(!result.allowed);
  });

  it('should allow file writes within project', () => {
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileWrite(path.join(ROOT, 'src', 'main.py'), 'task-worker');
    assert.ok(result.allowed);
  });

  it('should block modifications to .harness system files', () => {
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileWrite(path.join(ROOT, '.harness', 'config.json'), 'task-worker');
    assert.ok(!result.allowed);
  });

  it('should allow modifications to sessions and checkpoints', () => {
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileWrite(path.join(ROOT, '.harness', 'sessions', 'state.json'), 'task-worker');
    assert.ok(result.allowed);
  });

  it('should require user confirmation for file deletion', () => {
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileDelete(path.join(ROOT, 'src', 'old.py'), 'task-worker');
    assert.equal(result.requiresConfirmation, true);
  });

  it('should block concurrent file modifications', () => {
    const guard = new PermissionGuard(ROOT);
    const filePath = path.join(ROOT, 'src', 'main.py');
    guard.acquireLock(filePath, 'task-worker-1');
    const result = guard.checkFileWrite(filePath, 'task-worker-2');
    assert.ok(!result.allowed);
    assert.ok(result.reason.includes('locked'));
  });

  it('should release locks correctly', () => {
    const guard = new PermissionGuard(ROOT);
    const filePath = path.join(ROOT, 'src', 'main.py');
    guard.acquireLock(filePath, 'task-worker-1');
    guard.releaseLock(filePath, 'task-worker-1');
    const result = guard.checkFileWrite(filePath, 'task-worker-2');
    assert.ok(result.allowed);
  });
});

describe('AuditLogger', () => {
  const AuditLogger = require(path.join(ROOT, 'src', 'permission', 'audit-logger'));

  it('should log permission check events', () => {
    const logger = new AuditLogger();
    logger.log({
      agent: 'task-worker',
      action: 'skill_execute',
      target: 'tdd-implement',
      result: 'allowed',
    });
    const entries = logger.query({ agent: 'task-worker' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'skill_execute');
  });

  it('should log denied events', () => {
    const logger = new AuditLogger();
    logger.log({
      agent: 'team-lead',
      action: 'skill_execute',
      target: 'tdd-implement',
      result: 'denied',
      reason: 'not in applicable_agents',
    });
    const entries = logger.query({ result: 'denied' });
    assert.equal(entries.length, 1);
  });

  it('should filter logs by agent', () => {
    const logger = new AuditLogger();
    logger.log({ agent: 'task-worker', action: 'file_write', target: 'a.py', result: 'allowed' });
    logger.log({ agent: 'domain-analyst', action: 'file_write', target: 'b.py', result: 'allowed' });
    const entries = logger.query({ agent: 'task-worker' });
    assert.equal(entries.length, 1);
  });

  it('should include timestamp in log entries', () => {
    const logger = new AuditLogger();
    logger.log({ agent: 'task-worker', action: 'test', target: 'x', result: 'allowed' });
    const entries = logger.query({});
    assert.ok(entries[0].timestamp);
  });
});
