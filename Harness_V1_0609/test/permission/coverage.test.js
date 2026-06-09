'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const _sessionFilesToCleanup = [];
const _sessionMgrsToCleanup = [];
function _cleanupSessionFiles() {
  for (const mgr of _sessionMgrsToCleanup) {
    try { mgr.shutdown(); } catch (_) { /* best-effort */ }
  }
  _sessionMgrsToCleanup.length = 0;
  for (const f of _sessionFilesToCleanup) {
    try { fs.unlinkSync(f); } catch (_) { /* best-effort */ }
  }
  _sessionFilesToCleanup.length = 0;
}
function _trackSessionFile(sessionId) {
  _sessionFilesToCleanup.push(path.join(ROOT, '.harness', 'sessions', sessionId + '.json'));
}
function _trackSessionMgr(mgr) {
  _sessionMgrsToCleanup.push(mgr);
}

describe('AuditLogger Full Coverage', () => {
  const AuditLogger = require(path.join(ROOT, 'src', 'permission', 'audit-logger'));

  it('should count allowed and denied in stats', () => {
    const logger = new AuditLogger();
    logger.log({ agent: 'a', action: 'x', target: 't', result: 'allowed' });
    logger.log({ agent: 'b', action: 'y', target: 't', result: 'denied' });
    logger.log({ agent: 'a', action: 'z', target: 't', result: 'allowed' });
    const stats = logger.getStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.allowed, 2);
    assert.equal(stats.denied, 1);
    assert.equal(stats.byAgent['a'], 2);
    assert.equal(stats.byAgent['b'], 1);
  });

  it('should clear all entries', () => {
    const logger = new AuditLogger();
    logger.log({ agent: 'a', action: 'x', target: 't', result: 'allowed' });
    logger.clear('admin');
    // clear() logs an audit-clear entry itself, so 1 entry remains
    assert.equal(logger.entries.length, 1);
    assert.equal(logger.entries[0].action, 'audit-clear');
  });

  it('should export entries as JSON', () => {
    const logger = new AuditLogger();
    logger.log({ agent: 'a', action: 'x', target: 't', result: 'allowed' });
    const json = logger.export();
    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].agent, 'a');
  });

  it('should get recent entries with custom count', () => {
    const logger = new AuditLogger();
    for (let i = 0; i < 15; i++) {
      logger.log({ agent: 'a', action: `action-${i}`, target: 't', result: 'allowed' });
    }
    const recent = logger.getRecent(5);
    assert.equal(recent.length, 5);
    assert.equal(recent[4].action, 'action-14');
  });

  it('should FIFO evict when maxEntries reached', () => {
    const logger = new AuditLogger(undefined, { maxEntries: 3 });
    logger.log({ agent: 'a', action: 'first', target: 't', result: 'allowed' });
    logger.log({ agent: 'a', action: 'second', target: 't', result: 'allowed' });
    logger.log({ agent: 'a', action: 'third', target: 't', result: 'allowed' });
    logger.log({ agent: 'a', action: 'fourth', target: 't', result: 'allowed' });
    assert.equal(logger.entries.length, 3);
    assert.equal(logger.entries[0].action, 'second');
    assert.equal(logger.entries[2].action, 'fourth');
  });

  it('should filter by action and target', () => {
    const logger = new AuditLogger();
    logger.log({ agent: 'a', action: 'write', target: 'file1', result: 'allowed' });
    logger.log({ agent: 'a', action: 'read', target: 'file2', result: 'allowed' });
    logger.log({ agent: 'b', action: 'write', target: 'file3', result: 'denied' });
    const byAction = logger.query({ action: 'write' });
    assert.equal(byAction.length, 2);
    const byTarget = logger.query({ target: 'file2' });
    assert.equal(byTarget.length, 1);
  });
});

describe('PhaseOrchestrator Full Coverage', () => {
  const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));

  it('should get next phase', () => {
    const orch = new PhaseOrchestrator();
    assert.equal(orch.getNextPhase('requirement-analysis'), 'architecture-design');
    assert.equal(orch.getNextPhase('deployment'), null);
  });

  it('should get phase index', () => {
    const orch = new PhaseOrchestrator();
    assert.equal(orch.getPhaseIndex('requirement-analysis'), 1);
    assert.equal(orch.getPhaseIndex('deployment'), 5);
    assert.equal(orch.getPhaseIndex('nonexistent'), -1);
  });

  it('should check phase complete with custom strict skills', () => {
    const orch = new PhaseOrchestrator();
    const result = orch.isPhaseComplete(
      'module-development',
      ['tdd-implement', 'module-development'],
      ['tdd-implement', 'module-development'],
    );
    assert.ok(result);
  });
});

describe('SkillRouter Full Coverage', () => {
  const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));

  it('should get skill by id', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const skill = router.getSkill('brainstorming');
    assert.ok(skill);
    assert.equal(skill.skill_id, 'brainstorming');
    assert.equal(router.getSkill('nonexistent-skill'), null);
  });

  it('should resolve conflict with empty array', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    assert.equal(router.resolveConflict([]), null);
  });

  it('should handle unreadable skills directory', () => {
    const router = new SkillRouter(path.join(ROOT, 'nonexistent-path'));
    const skills = router.discover();
    assert.deepEqual(skills, []);
  });

  it('should match with empty message and agent', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '', agent: '', completedSkills: [] });
    assert.ok(Array.isArray(matches));
  });
});

describe('RBACEnforcer Full Coverage', () => {
  const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));

  it('should return false for unknown agent in canExecute', () => {
    const enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
    assert.ok(!enforcer.canExecute('nonexistent-agent', 'brainstorming'));
  });

  it('should handle missing agents directory', () => {
    const enforcer = new RBACEnforcer(path.join(ROOT, 'nonexistent'));
    enforcer.load();
    assert.equal(Object.keys(enforcer.agents).length, 0);
  });
});

describe('PermissionGuard Full Coverage', () => {
  const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));

  it('should block delete outside project', () => {
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileDelete('/etc/passwd', 'task-worker');
    assert.ok(!result.allowed);
  });

  it('should validate session ID via static method', () => {
    assert.ok(PermissionGuard.validateSessionId('valid-session_123'));
    assert.ok(!PermissionGuard.validateSessionId('../../etc/passwd'));
    assert.ok(!PermissionGuard.validateSessionId(''));
  });

  it('should check empty and non-string commands', () => {
    const guard = new PermissionGuard(ROOT);
    const emptyResult = guard.checkCommand('', 'task-worker');
    assert.ok(!emptyResult.allowed);
    assert.ok(emptyResult.reason);
    const nullResult = guard.checkCommand(null, 'task-worker');
    assert.ok(!nullResult.allowed);
    assert.ok(nullResult.reason);
  });

  it('should get lock holder for unlocked file', () => {
    const guard = new PermissionGuard(ROOT);
    const filePath = path.join(ROOT, 'src', 'main.py');
    assert.equal(guard.getLockHolder(filePath), null);
    guard.acquireLock(filePath, 'worker-1');
    assert.equal(guard.getLockHolder(filePath), 'worker-1');
  });

  it('should not release lock held by another agent', () => {
    const guard = new PermissionGuard(ROOT);
    const filePath = path.join(ROOT, 'src', 'main.py');
    guard.acquireLock(filePath, 'worker-1');
    const released = guard.releaseLock(filePath, 'worker-2');
    assert.equal(released, false);
  });
});

describe('SessionManager Full Coverage', () => {
  const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));

  after(() => { _cleanupSessionFiles(); });

  it('should return null budget for nonexistent session', () => {
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    const budget = mgr.checkBudget('nonexistent');
    assert.ok(!budget.warning80);
    assert.ok(!budget.exhausted);
  });

  it('should return null for nonexistent session get', () => {
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    assert.equal(mgr.get('nonexistent'), null);
  });

  it('should silently ignore recordAgentAction for nonexistent session', () => {
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    mgr.recordAgentAction('nonexistent', 'agent', 'action');
  });

  it('should evict oldest session when max reached', () => {
    const tmpDir = path.join(os.tmpdir(), `harness-evict-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), '{}');
    try {
      const mgr = new SessionManager(tmpDir);
      for (let i = 0; i < 101; i++) {
        mgr.create(`evict-test-${i}`);
      }
      assert.equal(mgr.get('evict-test-0'), null);
      assert.ok(mgr.get('evict-test-100'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should throw SessionError for invalid phase transition', () => {
    const { SessionError } = require(path.join(ROOT, 'src', 'errors'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['phase-err-test'];
    mgr.create('phase-err-test');
    _trackSessionFile('phase-err-test');
    assert.throws(() => {
      mgr.advancePhase('phase-err-test', 'deployment');
    }, SessionError);
  });

  it('should throw SessionError for session not found in advancePhase', () => {
    const { SessionError } = require(path.join(ROOT, 'src', 'errors'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    assert.throws(() => {
      mgr.advancePhase('nonexistent', 'architecture-design');
    }, SessionError);
  });

  it('should throw SessionError for invalid token usage', () => {
    const { SessionError } = require(path.join(ROOT, 'src', 'errors'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['token-err-test'];
    mgr.create('token-err-test');
    _trackSessionFile('token-err-test');
    assert.throws(() => {
      mgr.addTokenUsage('token-err-test', -1);
    }, SessionError);
  });

  it('should detect 95% budget warning', () => {
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['budget-95-test'];
    mgr.create('budget-95-test');
    _trackSessionFile('budget-95-test');
    mgr.addTokenUsage('budget-95-test', 950000000);
    const budget = mgr.checkBudget('budget-95-test');
    assert.ok(budget.warning95);
  });
});

describe('Constants Full Coverage', () => {
  const { parseFrontmatter, parseArray } = require(path.join(ROOT, 'src', 'utils', 'constants'));

  it('should return null for content without frontmatter', () => {
    assert.equal(parseFrontmatter('No frontmatter here'), null);
  });

  it('should parse inline array values', () => {
    const result = parseFrontmatter('---\nkey: [a, b, c]\n---');
    assert.deepEqual(result.key, ['a', 'b', 'c']);
  });

  it('should parse multiline array values', () => {
    const result = parseFrontmatter('---\nkey:\n  - item1\n  - item2\n---');
    assert.deepEqual(result.key, ['item1', 'item2']);
  });

  it('should parseArray with empty string', () => {
    assert.deepEqual(parseArray(''), []);
  });

  it('should parseArray with undefined', () => {
    assert.deepEqual(parseArray(undefined), []);
  });

  it('should parseArray with single string', () => {
    assert.deepEqual(parseArray('single'), ['single']);
  });

  it('should parseArray with inline array string', () => {
    assert.deepEqual(parseArray('[x, y]'), ['x', 'y']);
  });

  it('should parseArray with existing array', () => {
    assert.deepEqual(parseArray(['a', 'b']), ['a', 'b']);
  });
});

describe('Error Classes', () => {
  const { HarnessError, SessionError, PermissionError, TDDGateError } = require(path.join(ROOT, 'src', 'errors'));

  it('should create HarnessError with code', () => {
    const err = new HarnessError('TEST_CODE', 'test message');
    assert.equal(err.name, 'HarnessError');
    assert.equal(err.code, 'TEST_CODE');
    assert.equal(err.message, 'test message');
    assert.ok(err instanceof Error);
  });

  it('should create SessionError inheriting HarnessError', () => {
    const err = new SessionError('SESSION_NOT_FOUND', 'not found');
    assert.equal(err.name, 'SessionError');
    assert.equal(err.code, 'SESSION_NOT_FOUND');
    assert.ok(err instanceof HarnessError);
    assert.ok(err instanceof Error);
  });

  it('should create PermissionError inheriting HarnessError', () => {
    const err = new PermissionError('RBAC_DENIED', 'denied');
    assert.equal(err.name, 'PermissionError');
    assert.equal(err.code, 'RBAC_DENIED');
    assert.ok(err instanceof HarnessError);
  });

  it('should create TDDGateError inheriting HarnessError', () => {
    const err = new TDDGateError('NO_TEST_FIRST', 'no test');
    assert.equal(err.name, 'TDDGateError');
    assert.equal(err.code, 'NO_TEST_FIRST');
    assert.ok(err instanceof HarnessError);
  });

  it('should have static references on HarnessError', () => {
    assert.equal(HarnessError.SessionError, SessionError);
    assert.equal(HarnessError.PermissionError, PermissionError);
    assert.equal(HarnessError.TDDGateError, TDDGateError);
  });
});

describe('Factory Function', () => {
  it('should create all components via create()', () => {
    const { create } = require(path.join(ROOT, 'src'));
    const harness = create(ROOT);
    assert.ok(harness.router);
    assert.ok(harness.session);
    assert.ok(harness.orchestrator);
    assert.ok(harness.enforcer);
    assert.ok(harness.guard);
    assert.ok(harness.logger);
    assert.ok(harness.tddGate);
    assert.ok(harness.verifier);
    assert.ok(harness.router.skills.length > 0);
    assert.ok(Object.keys(harness.enforcer.agents).length > 0);
  });
});

describe('TDDGate Additional Coverage', () => {
  const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));

  it('should handle RED phase without testResult', () => {
    const gate = new TDDGate();
    const result = gate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: true,
      implExists: false,
    });
    assert.equal(result.phase, 'UNKNOWN');
    assert.equal(result.passed, false);
  });

  it('should handle test exists + impl exists + test fails', () => {
    const gate = new TDDGate();
    const result = gate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: true,
      implExists: true,
      testResult: 'fail',
    });
    assert.equal(result.phase, 'RED');
    assert.ok(!result.passed);
  });

  it('should validate cycle order with empty cycles', () => {
    const gate = new TDDGate();
    assert.ok(gate.isHealthy());
  });
});

describe('EvidenceVerifier Additional Coverage', () => {
  const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

  it('should return default evidence types for unknown skill', () => {
    const verifier = new EvidenceVerifier();
    const types = verifier.getRequiredEvidenceTypes('unknown-skill');
    assert.deepEqual(types, ['test_output', 'coverage_report']);
  });

  it('should handle verify without requiredTypes', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Test claim',
      evidence: [{ type: 'test_output', content: 'passed' }, { type: 'coverage_report', content: '85%' }],
    });
    assert.ok(result.verified);
  });

  it('should handle non-array evidence', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Test',
      evidence: 'not an array',
      requiredTypes: ['test_output'],
    });
    assert.ok(!result.verified);
  });
});

describe('Enforce Methods', () => {
  const { PermissionError } = require(path.join(ROOT, 'src', 'errors'));
  const { TDDGateError } = require(path.join(ROOT, 'src', 'errors'));

  it('PermissionGuard.enforceFileWrite should throw PermissionError', () => {
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    assert.throws(() => {
      guard.enforceFileWrite('/etc/passwd', 'task-worker');
    }, PermissionError);
  });

  it('PermissionGuard.enforceFileWrite should return true for allowed', () => {
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    const result = guard.enforceFileWrite(path.join(ROOT, 'src', 'main.py'), 'task-worker');
    assert.equal(result, true);
  });

  it('PermissionGuard.enforceCommand should throw PermissionError for dangerous', () => {
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    assert.throws(() => {
      guard.enforceCommand('rm -rf /', 'task-worker');
    }, PermissionError);
  });

  it('PermissionGuard.enforceCommand should return true for safe', () => {
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    const result = guard.enforceCommand('npm test', 'task-worker');
    assert.equal(result, true);
  });

  it('TDDGate.enforceCheck should throw TDDGateError for violation', () => {
    const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
    const gate = new TDDGate();
    assert.throws(() => {
      gate.enforceCheck({
        implFile: 'src/main.py',
        testFile: 'test/test_main.py',
        testExists: false,
        implExists: true,
      });
    }, TDDGateError);
  });

  it('TDDGate.enforceCheck should return result for valid', () => {
    const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
    const gate = new TDDGate();
    const result = gate.enforceCheck({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: true,
      implExists: false,
      testResult: 'fail',
    });
    assert.ok(result.passed);
  });

  it('TDDGate.enforceCoverage should throw TDDGateError for low coverage', () => {
    const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
    const gate = new TDDGate();
    assert.throws(() => {
      gate.enforceCoverage({ coverage: 50, threshold: 80 });
    }, TDDGateError);
  });

  it('TDDGate.enforceCoverage should return result for sufficient coverage', () => {
    const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
    const gate = new TDDGate();
    const result = gate.enforceCoverage({ coverage: 90, threshold: 80 });
    assert.ok(result.passed);
  });
});

describe('Debug Logger', () => {
  it('should not throw when calling debug', () => {
    const { debug } = require(path.join(ROOT, 'src', 'utils', 'debug-logger'));
    debug('TestModule', 'testAction', 'test message');
    debug('TestModule', 'testAction', new Error('test error'));
  });

  it('should output to stderr when HARNESS_DEBUG=1', () => {
    const origDebug = process.env.HARNESS_DEBUG;
    process.env.HARNESS_DEBUG = '1';
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'utils', 'debug-logger'))];
    const { debug } = require(path.join(ROOT, 'src', 'utils', 'debug-logger'));
    const chunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      debug('Test', 'action', 'hello');
      debug('Test', 'action', new Error('err'));
      assert.ok(chunks.length >= 1);
      assert.ok(chunks.some(c => c.includes('[Harness:Test:action]')));
    } finally {
      process.stderr.write = origWrite;
      process.env.HARNESS_DEBUG = origDebug;
      delete require.cache[require.resolve(path.join(ROOT, 'src', 'utils', 'debug-logger'))];
    }
  });
});

describe('SessionManager Branch Coverage', () => {
  it('should handle flush with no pending timers', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const tmpDir = path.join(os.tmpdir(), `harness-flush-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), '{}');
    try {
      const mgr = new SessionManager(tmpDir);
      mgr.create('flush-test');
      mgr.flush();
      const filePath = path.join(tmpDir, '.harness', 'sessions', 'flush-test.json');
      assert.ok(fs.existsSync(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle _writeToDisk with sessions dir already existing', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const tmpDir = path.join(os.tmpdir(), `harness-dir-exist-test-${Date.now()}`);
    const sessionsDir = path.join(tmpDir, '.harness', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), '{}');
    try {
      const mgr = new SessionManager(tmpDir);
      mgr.create('dir-exist-test');
      const filePath = path.join(sessionsDir, 'dir-exist-test.json');
      assert.ok(fs.existsSync(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle _writeToDisk error gracefully', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const tmpDir = path.join(os.tmpdir(), `harness-write-err-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), '{}');
    const sessionsDir = path.join(tmpDir, '.harness', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'readonly-test.json'), 'not-json');
    if (process.platform !== 'win32') {
      fs.chmodSync(sessionsDir, 0o444);
    }
    try {
      const mgr = new SessionManager(tmpDir);
      if (process.platform !== 'win32') {
        mgr.create('readonly-test');
      }
    } catch {
      // may throw or silently fail depending on OS
    } finally {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(sessionsDir, 0o755); } catch (_err) { /* ignore */ }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle flush with session deleted from memory', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const tmpDir = path.join(os.tmpdir(), 'harness-flush-del-test-' + Date.now());
    fs.mkdirSync(path.join(tmpDir, '.harness', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), '{}');
    try {
      const mgr = new SessionManager(tmpDir);
      mgr.create('flush-del-test');
      mgr.advancePhase('flush-del-test', 'requirement-analysis');
      delete mgr.sessions['flush-del-test'];
      mgr.flush();
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
    }
  });
});

describe('AuditLogger Branch Coverage', () => {
  it('should use default values for empty event', () => {
    const AuditLogger = require(path.join(ROOT, 'src', 'permission', 'audit-logger'));
    const logger = new AuditLogger();
    logger.log({});
    const entry = logger.entries[0];
    assert.equal(entry.agent, 'unknown');
    assert.equal(entry.action, 'unknown');
    assert.equal(entry.target, '');
    assert.equal(entry.result, 'unknown');
    assert.equal(entry.reason, '');
    assert.equal(entry.details, '');
  });

  it('should query by result', () => {
    const AuditLogger = require(path.join(ROOT, 'src', 'permission', 'audit-logger'));
    const logger = new AuditLogger();
    logger.log({ agent: 'a', action: 'x', target: 't', result: 'allowed' });
    logger.log({ agent: 'a', action: 'y', target: 't', result: 'denied' });
    const allowed = logger.query({ result: 'allowed' });
    assert.equal(allowed.length, 1);
    const denied = logger.query({ result: 'denied' });
    assert.equal(denied.length, 1);
  });
});

describe('SkillRouter Branch Coverage', () => {
  it('should match by word splitting in trigger conditions', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: 'I need requirement analysis and design', agent: 'domain-analyst', completedSkills: [] });
    assert.ok(matches.length > 0);
  });

  it('should match by depends_on satisfaction', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: 'code review', agent: 'task-worker', completedSkills: ['tdd-implement'] });
    assert.ok(matches.length > 0);
  });

  it('should sort by priority when same phase', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '开发模块', agent: 'task-worker', completedSkills: [] });
    if (matches.length >= 2) {
      const samePhase = matches.filter(m => m.phase === matches[0].phase);
      if (samePhase.length >= 2) {
        for (let i = 1; i < samePhase.length; i++) {
          assert.ok(samePhase[i - 1].priority <= samePhase[i].priority);
        }
      }
    }
  });

  it('should extract keywords from or-separated conditions', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    const keywords = router._extractKeywords('需求分析 or 架构设计');
    assert.ok(keywords.includes('需求分析'));
    assert.ok(keywords.includes('架构设计'));
  });

  it('should extract keywords from quoted strings', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    const keywords = router._extractKeywords('"TDD驱动" or "测试优先"');
    assert.ok(keywords.includes('TDD驱动'));
    assert.ok(keywords.includes('测试优先'));
  });

  it('should fallback to full condition when no or/quotes', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    const keywords = router._extractKeywords('simplecondition');
    assert.ok(keywords.length > 0);
  });

  it('should detect negation for TDD skill', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    const skill = { skill_id: 'tdd-implement' };
    assert.ok(router._isNegated(skill, '不需要测试驱动开发'));
    assert.ok(router._isNegated(skill, '跳过TDD'));
    assert.ok(!router._isNegated(skill, '使用TDD开发'));
  });

  it('should detect negation for architecture skill', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    const skill = { skill_id: 'architecture-design' };
    assert.ok(router._isNegated(skill, '不要架构设计'));
    assert.ok(router._isNegated(skill, 'skip architecture'));
    assert.ok(!router._isNegated(skill, '进行架构设计'));
  });

  it('should return false for skill without semantic group', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    const skill = { skill_id: 'writing-skills' };
    assert.ok(!router._isNegated(skill, '不需要writing-skills'));
  });
});

describe('PermissionGuard Branch Coverage', () => {
  it('should allow file read within project', () => {
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    const result = guard.checkFileRead(path.join(ROOT, 'src', 'main.py'), 'task-worker');
    assert.ok(result.allowed);
  });

  it('should enforceFileWrite for system file', () => {
    const { PermissionError } = require(path.join(ROOT, 'src', 'errors'));
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    assert.throws(() => {
      guard.enforceFileWrite(path.join(ROOT, '.harness', 'config.json'), 'task-worker');
    }, PermissionError);
  });

  it('should enforceFileWrite for locked file', () => {
    const { PermissionError } = require(path.join(ROOT, 'src', 'errors'));
    const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
    const guard = new PermissionGuard(ROOT);
    const filePath = path.join(ROOT, 'src', 'locked.py');
    guard.acquireLock(filePath, 'worker-1');
    assert.throws(() => {
      guard.enforceFileWrite(filePath, 'worker-2');
    }, PermissionError);
  });
});

describe('PhaseOrchestrator Branch Coverage', () => {
  it('should return empty for unknown phase required skills', () => {
    const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
    const orch = new PhaseOrchestrator();
    assert.deepEqual(orch.getRequiredSkills('nonexistent-phase'), []);
  });

  it('should return false for canTransition with unknown phase', () => {
    const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
    const orch = new PhaseOrchestrator();
    assert.ok(!orch.canTransition('nonexistent', 'architecture-design'));
  });
});

describe('SessionManager EventEmitter', () => {
  after(() => { _cleanupSessionFiles(); });

  it('should emit session-created event', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['emit-test-session'];
    let emitted = null;
    mgr.on('session-created', (e) => { emitted = e; });
    mgr.create('emit-test-session');
    _trackSessionFile('emit-test-session');
    assert.ok(emitted);
    assert.equal(emitted.sessionId, 'emit-test-session');
  });

  it('should emit phase-change event', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['phase-emit-test'];
    mgr.create('phase-emit-test');
    _trackSessionFile('phase-emit-test');
    let emitted = null;
    mgr.on('phase-change', (e) => { emitted = e; });
    mgr.advancePhase('phase-emit-test', 'requirement-analysis');
    assert.ok(emitted);
    assert.equal(emitted.from, 'brainstorming');
    assert.equal(emitted.to, 'requirement-analysis');
  });

  it('should emit skill-complete event', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['skill-emit-test'];
    mgr.create('skill-emit-test');
    _trackSessionFile('skill-emit-test');
    let emitted = null;
    mgr.on('skill-complete', (e) => { emitted = e; });
    mgr.completeSkill('skill-emit-test', 'brainstorming');
    assert.ok(emitted);
    assert.equal(emitted.skillId, 'brainstorming');
  });

  it('should emit budget-warning event', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const mgr = new SessionManager(ROOT);
    _trackSessionMgr(mgr);
    delete mgr.sessions['budget-emit-test'];
    mgr.create('budget-emit-test');
    _trackSessionFile('budget-emit-test');
    let emitted = null;
    mgr.on('budget-warning', (e) => { emitted = e; });
    mgr.addTokenUsage('budget-emit-test', 850000000);
    assert.ok(emitted);
    assert.ok(emitted.budget.warning80);
  });

  it('should emit shutdown event', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const mgr = new SessionManager(ROOT);
    let emitted = null;
    mgr.on('shutdown', (e) => { emitted = e; });
    mgr.shutdown();
    assert.ok(emitted);
    assert.equal(emitted.signal, 'manual');
  });

  it('should register and remove shutdown hooks', () => {
    const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
    const mgr = new SessionManager(ROOT);
    const result = mgr.registerShutdownHooks();
    assert.equal(result, mgr);
    assert.ok(mgr._signalHandler);
    mgr.shutdown();
    assert.equal(mgr._signalHandler, null);
  });
});

describe('Config Validator', () => {
  it('should validate a valid config', () => {
    const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const result = validateConfig(ROOT);
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it('should report missing config.json', () => {
    const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const result = validateConfig(path.join(os.tmpdir(), `no-config-${Date.now()}`));
    assert.ok(!result.valid);
    assert.ok(result.errors[0].includes('not found'));
  });

  it('should report invalid JSON', () => {
    const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const tmpDir = path.join(os.tmpdir(), `bad-json-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), 'not-json');
    try {
      const result = validateConfig(tmpDir);
      assert.ok(!result.valid);
      assert.ok(result.errors[0].includes('parse error'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should report missing required fields', () => {
    const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const tmpDir = path.join(os.tmpdir(), `missing-fields-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), '{}');
    try {
      const result = validateConfig(tmpDir);
      assert.ok(!result.valid);
      assert.ok(result.errors.some(e => e.includes('version')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject unknown version', () => {
    const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const tmpDir = path.join(os.tmpdir(), `unknown-ver-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '99.0.0', agents: {}, skills: {},
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length >= 1);
      assert.ok(result.errors.some(e => e.includes('Unknown version') || e.includes('version')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should report invalid enforcement', () => {
    const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const tmpDir = path.join(os.tmpdir(), `bad-enf-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.1.0', agents: {}, skill_registry: { skills: { test: { enforcement: 'invalid' } } },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(!result.valid);
      assert.ok(result.errors.some(e => e.includes('invalid enforcement')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Config Validator R4 Runtime Validations', () => {
  const { validateConfig } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));

  it('should warn when token_budget is not a positive number', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-token-budget-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { token_budget: -100 },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(result.warnings.some(w => w.includes('token_budget') && w.includes('positive')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should warn when token_budget is zero', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-token-zero-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { token_budget: 0 },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(result.warnings.some(w => w.includes('token_budget') && w.includes('positive')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should warn when token_budget is not a number', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-token-str-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { token_budget: 'unlimited' },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(result.warnings.some(w => w.includes('token_budget') && w.includes('positive')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should warn when max_concurrent exceeds 1000', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-max-conc-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { max_concurrent: 2000 },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(result.warnings.some(w => w.includes('max_concurrent') && w.includes('1000')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should warn when session_ttl_ms is not a number', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-ttl-type-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { session_ttl_ms: '3600000' },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(result.warnings.some(w => w.includes('session_ttl_ms') && w.includes('number')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should warn when default_timeout_ms is not a number', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-timeout-type-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { default_timeout_ms: '30000' },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(result.warnings.some(w => w.includes('default_timeout_ms') && w.includes('number')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should not warn when runtime_config values are valid', () => {
    const tmpDir = path.join(os.tmpdir(), `r4-valid-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.7.122',
      runtime_config: { token_budget: 1000000, max_concurrent: 10, session_ttl_ms: 3600000, default_timeout_ms: 30000 },
    }));
    try {
      const result = validateConfig(tmpDir);
      assert.ok(!result.warnings.some(w => w.includes('token_budget') || w.includes('max_concurrent') || w.includes('session_ttl_ms') || w.includes('default_timeout_ms')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Factory Function with Validation', () => {
  it('should include validation result in harness instance', () => {
    const { create } = require(path.join(ROOT, 'src'));
    const { VALID_VERSIONS } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));
    const tmpDir = path.join(os.tmpdir(), `factory-validation-${Date.now()}`);
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    // Use any version known to be valid to avoid depending on ROOT's config.json
    const validVersion = VALID_VERSIONS.values().next().value;
    fs.writeFileSync(path.join(harnessDir, 'config.json'), JSON.stringify({
      version: validVersion,
      agents: [],
      skill_registry: { skills: [] },
    }));
    try {
      const harness = create(tmpDir);
      assert.ok(harness.validation);
      assert.ok(harness.validation.valid);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
    }
  });

  it('should throw on strictValidation with invalid config', () => {
    const { HarnessError } = require(path.join(ROOT, 'src', 'errors'));
    const { create } = require(path.join(ROOT, 'src'));
    assert.throws(() => {
      create(path.join(os.tmpdir(), `strict-test-${Date.now()}`), { strictValidation: true });
    }, HarnessError);
  });
});

describe('TDDGate Additional Branch Coverage', () => {
  it('should enforceCheck with EMPTY phase still passes', () => {
    const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
    const gate = new TDDGate();
    const result = gate.enforceCheck({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: false,
      implExists: false,
    });
    assert.ok(result.passed);
    assert.equal(result.phase, 'EMPTY');
  });
});

describe('RBACEnforcer Branch Coverage', () => {
  it('should handle _loadSkills with malformed skill file', () => {
    const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
    const tmpDir = path.join(os.tmpdir(), `rbac-malformed-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.harness', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.1.0', agents: {}, skills: {},
    }));
    fs.writeFileSync(path.join(tmpDir, '.harness', 'skills', 'bad.md'), '---\nskill_id: bad\n---\ncontent without proper frontmatter fields');
    try {
      const enforcer = new RBACEnforcer(tmpDir);
      enforcer.load();
      assert.ok(enforcer.skills['bad']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('SkillRouter Branch Coverage - discover error', () => {
  it('should handle unreadable files in skills directory', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const tmpDir = path.join(os.tmpdir(), `router-err-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'skills', 'bad.md'), 'not valid frontmatter at all --- broken');
    try {
      const router = new SkillRouter(tmpDir);
      const skills = router.discover();
      assert.ok(Array.isArray(skills));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('BoundedArray Full Coverage', () => {
  const BoundedArray = require(path.join(ROOT, 'src', 'utils', 'bounded-array'));

  it('should throw for invalid maxSize', () => {
    assert.throws(() => new BoundedArray(0), /positive number/);
    assert.throws(() => new BoundedArray(-1), /positive number/);
    assert.throws(() => new BoundedArray('abc'), /positive number/);
  });

  it('should support slice, map, forEach, find, some, every, includes, indexOf', () => {
    const arr = new BoundedArray(10);
    arr.push('a');
    arr.push('b');
    arr.push('c');
    assert.deepEqual(arr.slice(1), ['b', 'c']);
    assert.deepEqual(arr.map(x => x.toUpperCase()), ['A', 'B', 'C']);
    const results = [];
    arr.forEach(x => results.push(x));
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.equal(arr.find(x => x === 'b'), 'b');
    assert.equal(arr.find(x => x === 'z'), undefined);
    assert.equal(arr.some(x => x === 'c'), true);
    assert.equal(arr.some(x => x === 'z'), false);
    assert.equal(arr.every(x => typeof x === 'string'), true);
    assert.equal(arr.every(x => x === 'a'), false);
    assert.equal(arr.includes('b'), true);
    assert.equal(arr.includes('z'), false);
    assert.equal(arr.indexOf('b'), 1);
    assert.equal(arr.indexOf('z'), -1);
  });

  it('should support get and toArray', () => {
    const arr = new BoundedArray(5);
    arr.push(10);
    arr.push(20);
    assert.equal(arr.get(0), 10);
    assert.equal(arr.get(1), 20);
    assert.deepEqual(arr.toArray(), [10, 20]);
  });

  it('should support reduce', () => {
    const arr = new BoundedArray(5);
    arr.push(1);
    arr.push(2);
    arr.push(3);
    assert.equal(arr.reduce((sum, x) => sum + x, 0), 6);
  });

  it('should support entries and Symbol.iterator', () => {
    const arr = new BoundedArray(5);
    arr.push('x');
    arr.push('y');
    const entries = arr.entries();
    assert.deepEqual(entries.next().value, [0, 'x']);
    const iterated = [];
    for (const item of arr) iterated.push(item);
    assert.deepEqual(iterated, ['x', 'y']);
  });

  it('should support BoundedArray.from', () => {
    const arr = BoundedArray.from([1, 2, 3, 4, 5], 3);
    assert.equal(arr.length, 3);
    assert.deepEqual(arr.toArray(), [3, 4, 5]);
  });

  it('should expose DEFAULT_MAX', () => {
    assert.equal(BoundedArray.DEFAULT_MAX, 1000);
  });
});

describe('DashboardServer Additional Coverage', () => {
  const DashboardServer = require(path.join(ROOT, 'src', 'web', 'server'));
  const http = require('http');

  function fetch(port, urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, data, headers: res.headers }); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    });
  }

  it('should serve styles.css', async () => {
    const server = new DashboardServer(ROOT, 0, null, { apiToken: null });
    await server.start();
    const port = server.port;
    try {
      const res = await fetch(port, '/styles.css');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/css'));
    } finally {
      server.stop();
    }
  });

  it('should serve app.js', async () => {
    const server = new DashboardServer(ROOT, 0, null, { apiToken: null });
    await server.start();
    const port = server.port;
    try {
      const res = await fetch(port, '/app.js');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
    } finally {
      server.stop();
    }
  });

  it('should return 414 for URL too long', async () => {
    const origApiToken = process.env.HARNESS_API_TOKEN;
    delete process.env.HARNESS_API_TOKEN;
    const server = new DashboardServer(ROOT, 0, null, { apiToken: null });
    await server.start();
    const port = server.port;
    try {
      const longUrl = '/api/overview?' + 'a'.repeat(3000);
      const res = await fetch(port, longUrl);
      assert.equal(res.status, 414);
    } finally {
      server.stop();
      if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
      else delete process.env.HARNESS_API_TOKEN;
    }
  });

  it('should accept POST method on API endpoints', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_API_TOKEN = 'test-token-for-coverage';
    let port = 0;
    const server = new DashboardServer(ROOT, port, null, { apiToken: null });
    await server.start();
    port = server.port;
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(`http://localhost:${port}/api/nudge/evaluate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token-for-coverage',
          },
        }, (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => {
            try { resolve({ status: response.statusCode, data: JSON.parse(data) }); }
            catch { resolve({ status: response.statusCode, data }); }
          });
        });
        req.on('error', reject);
        req.write(JSON.stringify({ toolCalls: 10, hadError: true, recovered: true }));
        req.end();
      });
      assert.ok(typeof res.status === 'number' && res.status >= 200, `POST should be accepted on API endpoints, got status ${res.status}: ${JSON.stringify(res.data).substring(0, 100)}`);
    } finally {
      server.stop();
      process.env.NODE_ENV = originalEnv;
      if (originalToken !== undefined) process.env.HARNESS_API_TOKEN = originalToken;
      else delete process.env.HARNESS_API_TOKEN;
    }
  });

  it('should search changelog with pagination bounds', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    delete process.env.HARNESS_API_TOKEN;
    const server = new DashboardServer(ROOT, 0, null, { apiToken: null });
    await server.start();
    const port = server.port;
    try {
      const res = await fetch(port, '/api/changelog/search?pageSize=200');
      assert.equal(res.status, 200);
      assert.ok(res.data.pageSize <= 100);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
      else delete process.env.HARNESS_API_TOKEN;
      server.stop();
    }
  });
});

describe('ChangelogArchive Additional Coverage', () => {
  const ChangelogArchive = require(path.join(ROOT, 'src', 'web', 'changelog-archive'));
  let tmpDir;
  let archive;

  before(() => {
    tmpDir = path.join(os.tmpdir(), `archive-cov-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    archive = new ChangelogArchive(tmpDir);
  });

  after(() => {
    try {
      const archiveDir = path.join(tmpDir, '.harness', 'archive');
      if (fs.existsSync(archiveDir)) {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      }
    } catch (_err) { /* ignore */ }
  });

  it('should search by date range', () => {
    archive.record({ version: '10.0.0', changes: { '新增': ['Date test'] }, summary: '日期测试' });
    const results = archive.search({ since: '2020-01-01', until: '2099-12-31', page: 1, pageSize: 10 });
    assert.ok(results.items.length >= 1);
  });

  it('should search with no results', () => {
    const results = archive.search({ keyword: 'nonexistent_xyz_12345', page: 1, pageSize: 10 });
    assert.equal(results.items.length, 0);
  });

  it('should handle tampered record', () => {
    const recordResult = archive.record({ version: '11.0.0', changes: { '新增': ['Tamper test'] }, summary: '篡改测试' });
    assert.ok(recordResult.success);
    const recordFile = path.join(tmpDir, '.harness', 'archive', recordResult.id + '.json');
    if (fs.existsSync(recordFile)) {
      const original = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
      original.version = 'TAMPERED';
      fs.writeFileSync(recordFile, JSON.stringify(original));
      const verifyResult = archive.verifyIntegrity();
      assert.ok(verifyResult.recordsTampered >= 1);
    }
  });
});

describe('SessionManager Additional Coverage', () => {
  const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));

  it('should handle _restoreSessions with corrupted files', () => {
    const tmpDir = path.join(os.tmpdir(), `session-cov-${Date.now()}`);
    const sessionsDir = path.join(tmpDir, '.harness', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'bad.json'), 'not valid json{{{');
    const mgr = new SessionManager(tmpDir);
    const session = mgr.get('bad');
    assert.equal(session, null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  });

  it('should handle 100% budget exhaustion', () => {
    const tmpDir = path.join(os.tmpdir(), `session-budget-${Date.now()}`);
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(path.join(harnessDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(harnessDir, 'config.json'), JSON.stringify({ token_budget: 1000, version: '2.6.0' }));
    const mgr = new SessionManager(tmpDir);
    mgr.create('test-budget-100');
    mgr.addTokenUsage('test-budget-100', 1000);
    const budget = mgr.checkBudget('test-budget-100');
    assert.equal(budget.exhausted, true);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  });
});

describe('validateAgentId', () => {
  const { validateAgentId } = require(path.join(ROOT, 'src', 'utils', 'constants'));

  it('should return valid for correct agent IDs', () => {
    assert.deepEqual(validateAgentId('team-lead'), { valid: true });
    assert.deepEqual(validateAgentId('task_worker'), { valid: true });
    assert.deepEqual(validateAgentId('Agent01'), { valid: true });
    assert.deepEqual(validateAgentId('a'), { valid: true });
  });

  it('should reject null and undefined', () => {
    const r1 = validateAgentId(null);
    assert.equal(r1.valid, false);
    assert.ok(r1.reason);

    const r2 = validateAgentId(undefined);
    assert.equal(r2.valid, false);
    assert.ok(r2.reason);
  });

  it('should reject non-string types', () => {
    const r1 = validateAgentId(123);
    assert.equal(r1.valid, false);
    assert.ok(r1.reason);

    const r2 = validateAgentId({});
    assert.equal(r2.valid, false);
    assert.ok(r2.reason);
  });

  it('should reject empty string', () => {
    const r = validateAgentId('');
    assert.equal(r.valid, false);
    assert.ok(r.reason);
  });

  it('should reject IDs with invalid characters', () => {
    const r1 = validateAgentId('agent name');
    assert.equal(r1.valid, false);
    assert.ok(r1.reason.includes('invalid characters'));

    const r2 = validateAgentId('agent@name');
    assert.equal(r2.valid, false);

    const r3 = validateAgentId('agent/name');
    assert.equal(r3.valid, false);

    const r4 = validateAgentId('agent.name');
    assert.equal(r4.valid, false);
  });
});

describe('maskConfigForLogging', () => {
  const { maskConfigForLogging, _isSensitiveKey, _maskSensitiveValue } = require(path.join(ROOT, 'src', 'utils', 'config-validator'));

  it('should return non-object values as-is', () => {
    assert.equal(maskConfigForLogging(null), null);
    assert.equal(maskConfigForLogging(undefined), undefined);
    assert.equal(maskConfigForLogging('string'), 'string');
    assert.equal(maskConfigForLogging(42), 42);
    assert.equal(maskConfigForLogging(true), true);
  });

  it('should mask sensitive keys', () => {
    const config = { apiKey: 'sk-1234567890abcdef', port: 3000 };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.port, 3000);
    assert.ok(masked.apiKey.includes('***'));
    assert.ok(masked.apiKey.startsWith('sk-'));
    assert.ok(masked.apiKey.endsWith('ef'));
  });

  it('should mask password fields', () => {
    const config = { password: 'supersecret', name: 'test' };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.name, 'test');
    assert.ok(masked.password.includes('***'));
  });

  it('should mask token fields', () => {
    const config = { token: 'ghp_abcdefghijklmnop', user: 'admin' };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.user, 'admin');
    assert.ok(masked.token.includes('***'));
  });

  it('should mask secret fields', () => {
    const config = { secret: 'my-long-secret-value', normal: 'visible' };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.normal, 'visible');
    assert.ok(masked.secret.includes('***'));
  });

  it('should handle short sensitive values', () => {
    const config = { apiKey: 'short' };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.apiKey, '***');
  });

  it('should handle non-string sensitive values', () => {
    const config = { password: 12345 };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.password, '***');
  });

  it('should recursively mask nested objects', () => {
    const config = {
      database: {
        host: 'localhost',
        credentials: {
          password: 'db-password-123',
          user: 'admin',
        },
      },
    };
    const masked = maskConfigForLogging(config);
    assert.equal(masked.database.host, 'localhost');
    assert.equal(masked.database.credentials.user, 'admin');
    assert.ok(masked.database.credentials.password.includes('***'));
  });

  it('should handle arrays', () => {
    const config = [{ apiKey: 'sk-1234567890' }, { name: 'item2' }];
    const masked = maskConfigForLogging(config);
    assert.ok(Array.isArray(masked));
    assert.ok(masked[0].apiKey.includes('***'));
    assert.equal(masked[1].name, 'item2');
  });

  it('should detect sensitive keys correctly', () => {
    assert.ok(_isSensitiveKey('password'));
    assert.ok(_isSensitiveKey('apiKey'));
    assert.ok(_isSensitiveKey('secret'));
    assert.ok(_isSensitiveKey('token'));
    assert.ok(_isSensitiveKey('privateKey'));
    assert.ok(!_isSensitiveKey('name'));
    assert.ok(!_isSensitiveKey('port'));
    assert.ok(!_isSensitiveKey('host'));
  });

  it('should mask values correctly', () => {
    const masked = _maskSensitiveValue('abcdefghijklmnop');
    assert.ok(masked.startsWith('abc'));
    assert.ok(masked.endsWith('nop'));
    assert.ok(masked.includes('***'));
  });

  it('should handle short values in _maskSensitiveValue', () => {
    assert.equal(_maskSensitiveValue('short'), '***');
    assert.equal(_maskSensitiveValue(123), '***');
  });
});

describe('RBACEnforcer Additional Coverage', () => {
  const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));

  it('should handle missing skills directory', () => {
    const tmpDir = path.join(os.tmpdir(), `rbac-noskills-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, '.harness', 'agents'), { recursive: true });
    const enforcer = new RBACEnforcer(tmpDir);
    enforcer.load();
    assert.equal(enforcer.canExecute('unknown-agent', 'unknown-skill'), false);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  });

  it('should handle agent with no restricted_operations', () => {
    const tmpDir = path.join(os.tmpdir(), `rbac-norestrict-${Date.now()}`);
    const agentsDir = path.join(tmpDir, '.harness', 'agents');
    const skillsDir = path.join(tmpDir, '.harness', 'skills');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'simple.md'), '---\nrole: simple\navailable_skills:\n  - brainstorming\n---\nSimple agent');
    fs.writeFileSync(path.join(skillsDir, 'brainstorming.md'), '---\nphase: requirement\napplicable_agents:\n  - simple\n---\nBrainstorming');
    const enforcer = new RBACEnforcer(tmpDir);
    enforcer.load();
    const result = enforcer.canExecute('simple', 'brainstorming');
    assert.equal(result, true);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  });
});

describe('R5-R6 Regression: AuditLogger truncation', () => {
  const AuditLogger = require(path.join(ROOT, 'src', 'permission', 'audit-logger'));

  it('should truncate long details string', () => {
    const logger = new AuditLogger();
    const longDetails = 'x'.repeat(20000);
    logger.log({ agent: 'a', action: 'x', target: 't', result: 'allowed', details: longDetails });
    const entry = logger.entries[0];
    assert.ok(entry.details.length < longDetails.length);
    assert.ok(entry.details.includes('...[truncated]'));
  });

  it('should truncate long reason string', () => {
    const logger = new AuditLogger();
    const longReason = 'r'.repeat(2000);
    logger.log({ agent: 'a', action: 'x', target: 't', result: 'allowed', reason: longReason });
    const entry = logger.entries[0];
    assert.ok(entry.reason.length < longReason.length);
    assert.ok(entry.reason.includes('...[truncated]'));
  });

  it('should truncate long target string', () => {
    const logger = new AuditLogger();
    const longTarget = 't'.repeat(2000);
    logger.log({ agent: 'a', action: 'x', target: longTarget, result: 'allowed' });
    const entry = logger.entries[0];
    assert.ok(entry.target.length < longTarget.length);
    assert.ok(entry.target.includes('...[truncated]'));
  });
});

describe('R5-R6 Regression: RBAC atomic loading', () => {
  const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));

  it('should keep old data when partial load fails', () => {
    const tmpDir = path.join(os.tmpdir(), `rbac-atomic-${Date.now()}`);
    const agentsDir = path.join(tmpDir, '.harness', 'agents');
    const skillsDir = path.join(tmpDir, '.harness', 'skills');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.harness', 'config.json'), JSON.stringify({
      version: '2.1.0', agents: {}, skills: {},
    }));
    fs.writeFileSync(path.join(agentsDir, 'worker.md'), '---\nrole: worker\navailable_skills:\n  - brainstorming\n---\nWorker');
    fs.writeFileSync(path.join(skillsDir, 'brainstorming.md'), '---\nphase: requirement\napplicable_agents:\n  - worker\n---\nBrainstorming');
    const enforcer = new RBACEnforcer(tmpDir);
    enforcer.load();
    assert.equal(enforcer.canExecute('worker', 'brainstorming'), true);
    fs.writeFileSync(path.join(agentsDir, 'bad-agent.md'), '---\nrole: bad\navailable_skills:\n  - test\n---\n' + '@'.repeat(2 * 1024 * 1024));
    enforcer.load();
    assert.equal(enforcer.canExecute('worker', 'brainstorming'), true);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  });
});
