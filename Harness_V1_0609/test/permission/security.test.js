'use strict';
const { describe, it , afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');


const _cleanup = [];
const _sessionFiles = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
function _trackSessionFile(sessionId) {
  _sessionFiles.push(path.join(ROOT, '.harness', 'sessions', sessionId + '.json'));
}
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { const r = obj.destroy(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
  for (const f of _sessionFiles) {
    try { fs.unlinkSync(f); } catch (_) { /* best-effort */ }
  }
  _sessionFiles.length = 0;
}
describe('Security Tests', () => {
  afterEach(async () => { await _cleanAll(); });
  const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
  const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));

  describe('Session ID Injection', () => {
    it('should reject sessionId with path traversal', () => {
      assert.throws(() => {
        const mgr = _track(new SessionManager(ROOT));
        mgr.create('../../etc/malicious');
      }, /Invalid sessionId/);
    });

    it('should reject sessionId with special characters', () => {
      assert.throws(() => {
        const mgr = _track(new SessionManager(ROOT));
        mgr.create('session;rm -rf /');
      }, /Invalid sessionId/);
    });

    it('should accept valid sessionId', () => {
      const mgr = _track(new SessionManager(ROOT));
      delete mgr.sessions['valid-session_123'];
      _trackSessionFile('valid-session_123');
      const session = mgr.create('valid-session_123');
      assert.equal(session.id, 'valid-session_123');
    });

    it('should reject invalid sessionId', () => {
      assert.throws(() => {
        const mgr = _track(new SessionManager(ROOT));
        mgr.create('../etc/passwd');
      }, /Invalid sessionId/);
    });
  });

  describe('Path Traversal Prevention', () => {
    it('should block path traversal with ..', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkFileWrite(path.join(ROOT, '..', '..', 'etc', 'passwd'), 'task-worker');
      assert.ok(!result.allowed);
    });

    it('should block absolute path outside project', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkFileWrite('/etc/passwd', 'task-worker');
      assert.ok(!result.allowed);
    });

    it('should block read outside project', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkFileRead('/etc/shadow', 'task-worker');
      assert.ok(!result.allowed);
    });
  });

  describe('Dangerous Command Detection', () => {
    it('should detect rm -rf with root path', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkCommand('rm -rf /', 'task-worker');
      assert.ok(!result.allowed);
    });

    it('should detect PowerShell Remove-Item', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkCommand('Remove-Item -Recurse -Force C:\\', 'task-worker');
      assert.ok(!result.allowed);
    });

    it('should detect format command', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkCommand('format C:', 'task-worker');
      assert.ok(!result.allowed);
    });

    it('should detect dd command', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkCommand('dd if=/dev/zero of=/dev/sda', 'task-worker');
      assert.ok(!result.allowed);
    });

    it('should allow safe commands with confirmation', () => {
      const guard = new PermissionGuard(ROOT);
      const result = guard.checkCommand('npm install', 'task-worker');
      assert.ok(result.allowed);
      assert.equal(result.requiresConfirmation, true);
    });
  });

  describe('Lock Race Condition Prevention', () => {
    it('should not allow acquiring lock held by another agent', () => {
      const guard = new PermissionGuard(ROOT);
      const filePath = path.join(ROOT, 'src', 'main.py');
      guard.acquireLock(filePath, 'task-worker-1');
      const acquired = guard.acquireLock(filePath, 'task-worker-2');
      assert.equal(acquired, false);
    });

    it('should allow same agent to re-acquire lock', () => {
      const guard = new PermissionGuard(ROOT);
      const filePath = path.join(ROOT, 'src', 'main.py');
      guard.acquireLock(filePath, 'task-worker-1');
      const acquired = guard.acquireLock(filePath, 'task-worker-1');
      assert.equal(acquired, true);
    });
  });
});

describe('Error Path Tests', () => {
  const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
  const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
  const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
  const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

  afterEach(async () => { await _cleanAll(); });

  describe('SkillRouter Error Handling', () => {
    it('should return empty array when skills directory does not exist', () => {
      const router = _track(new SkillRouter(path.join(ROOT, 'nonexistent')));
      const skills = router.discover();
      assert.deepEqual(skills, []);
    });
  });

  describe('SessionManager Input Validation', () => {
    it('should reject negative token usage', () => {
      const mgr = _track(new SessionManager(ROOT));
      delete mgr.sessions['test-validation'];
      mgr.create('test-validation');
      _trackSessionFile('test-validation');
      assert.throws(() => {
        mgr.addTokenUsage('test-validation', -100);
      }, /non-negative/);
    });

    it('should reject non-numeric token usage', () => {
      const mgr = _track(new SessionManager(ROOT));
      delete mgr.sessions['test-validation-2'];
      mgr.create('test-validation-2');
      _trackSessionFile('test-validation-2');
      assert.throws(() => {
        mgr.addTokenUsage('test-validation-2', 'abc');
      }, /non-negative/);
    });

    it('should detect budget exhaustion', () => {
      const mgr = _track(new SessionManager(ROOT));
      delete mgr.sessions['test-budget-exhaust'];
      mgr.create('test-budget-exhaust');
      _trackSessionFile('test-budget-exhaust');
      mgr.addTokenUsage('test-budget-exhaust', 1000000001);
      const budget = mgr.checkBudget('test-budget-exhaust');
      assert.ok(budget.exhausted);
    });
  });

  describe('TDDGate Input Validation', () => {
    it('should handle both files not existing', () => {
      const gate = new TDDGate();
      const result = gate.check({
        implFile: 'src/main.py',
        testFile: 'test/test_main.py',
        testExists: false,
        implExists: false,
      });
      assert.equal(result.phase, 'EMPTY');
      assert.ok(result.passed);
    });

    it('should handle invalid coverage input', () => {
      const gate = new TDDGate();
      const result = gate.checkCoverage({ coverage: undefined, threshold: 80 });
      assert.ok(!result.passed);
    });
  });

  describe('EvidenceVerifier Edge Cases', () => {
    it('should handle evidence with null elements', () => {
      const verifier = _track(new EvidenceVerifier());
      const result = verifier.verify({
        claim: 'Test',
        evidence: [null, { type: 'test_output', content: 'passed' }, undefined],
        requiredTypes: ['test_output'],
      });
      assert.ok(result.verified);
    });

    it('should handle evidence with missing content', () => {
      const verifier = _track(new EvidenceVerifier());
      const result = verifier.verify({
        claim: 'Test',
        evidence: [{ type: 'test_output' }],
        requiredTypes: ['test_output'],
      });
      assert.ok(!result.verified);
      assert.ok(result.missing.includes('test_output'));
    });
  });
});
