const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));
const AuditLogger = require(path.join(ROOT, 'src', 'permission', 'audit-logger'));
const TDDGate = require(path.join(ROOT, 'src', 'gate', 'tdd-gate'));
const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

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

describe('End-to-End Flow: New Project', () => {
  after(() => { _cleanupSessionFiles(); });

  it('should execute full six-phase flow with permission checks', () => {
    const router = new SkillRouter(ROOT);
    const session = new SessionManager(ROOT);
    _sessionMgrsToCleanup.push(session);
    const orchestrator = new PhaseOrchestrator();
    const enforcer = new RBACEnforcer(ROOT);
    const guard = new PermissionGuard(ROOT);
    const logger = new AuditLogger();
    const tddGate = new TDDGate();
    const verifier = new EvidenceVerifier();

    router.discover();
    enforcer.load();

    const sid = 'e2e-test';

    delete session.sessions[sid];
    session.create(sid);
    _sessionFilesToCleanup.push(path.join(ROOT, '.harness', 'sessions', sid + '.json'));
    assert.equal(session.get(sid).currentPhase, 'brainstorming');

    const matches = router.match({
      userMessage: '我想做一个博客系统',
      agent: 'team-lead',
      completedSkills: [],
    });
    assert.ok(matches.length > 0);
    const brainstorm = matches.find(s => s.skill_id === 'brainstorming');
    assert.ok(brainstorm);

    const canExec = enforcer.canExecute('team-lead', 'brainstorming');
    assert.ok(canExec);
    logger.log({ agent: 'team-lead', action: 'skill_execute', target: 'brainstorming', result: 'allowed' });

    session.completeSkill(sid, 'brainstorming');
    session.advancePhase(sid, 'requirement-analysis');
    session.completeSkill(sid, 'requirement-analysis');

    const phaseComplete = orchestrator.isPhaseComplete('requirement-analysis', ['brainstorming', 'requirement-analysis']);
    assert.ok(phaseComplete);

    session.advancePhase(sid, 'architecture-design');
    session.completeSkill(sid, 'architecture-design');

    session.advancePhase(sid, 'module-development');

    const tddMatch = router.match({
      userMessage: 'TDD实现用户模块',
      agent: 'task-worker',
      completedSkills: ['architecture-design'],
    });
    assert.ok(tddMatch.some(s => s.skill_id === 'tdd-implement'));

    const tddCheck = enforcer.canExecute('task-worker', 'tdd-implement');
    assert.ok(tddCheck);

    const tddResult = tddGate.check({
      implFile: 'src/user.py',
      testFile: 'test/test_user.py',
      testExists: true,
      implExists: false,
      testResult: 'fail',
    });
    assert.equal(tddResult.phase, 'RED');

    const greenResult = tddGate.check({
      implFile: 'src/user.py',
      testFile: 'test/test_user.py',
      testExists: true,
      implExists: true,
      testResult: 'pass',
    });
    assert.equal(greenResult.phase, 'GREEN');

    const coverageResult = tddGate.checkCoverage({ coverage: 85, threshold: 80 });
    assert.ok(coverageResult.passed);

    const fileWriteResult = guard.checkFileWrite(path.join(ROOT, 'src', 'user.py'), 'task-worker');
    assert.ok(fileWriteResult.allowed);

    const sysFileResult = guard.checkFileWrite(path.join(ROOT, '.harness', 'config.json'), 'task-worker');
    assert.ok(!sysFileResult.allowed);

    session.completeSkill(sid, 'tdd-implement');
    session.completeSkill(sid, 'module-development');
    session.completeSkill(sid, 'code-review');

    const evidence = verifier.verify({
      claim: 'User module implemented',
      evidence: [
        { type: 'test_output', content: 'All 12 tests passed' },
        { type: 'coverage_report', content: 'Coverage: 85%' },
      ],
      requiredTypes: verifier.getRequiredEvidenceTypes('tdd-implement'),
    });
    assert.ok(evidence.verified);

    session.completeSkill(sid, 'verification-before-completion');

    session.advancePhase(sid, 'integration-testing');
    session.completeSkill(sid, 'integration-testing');

    session.advancePhase(sid, 'deployment');
    session.completeSkill(sid, 'deployment');

    const stats = logger.getStats();
    assert.ok(stats.total > 0);
    assert.ok(stats.allowed > 0);

    const budget = session.checkBudget(sid);
    assert.ok(!budget.exhausted);
  });

  it('should enforce RBAC: block unauthorized skill execution', () => {
    const enforcer = new RBACEnforcer(ROOT);
    const logger = new AuditLogger();
    enforcer.load();

    const canExec = enforcer.canExecute('technical-writer', 'tdd-implement');
    assert.ok(!canExec);

    logger.log({
      agent: 'technical-writer',
      action: 'skill_execute',
      target: 'tdd-implement',
      result: 'denied',
      reason: 'not in applicable_agents',
    });

    const denied = logger.query({ result: 'denied' });
    assert.equal(denied.length, 1);
    assert.equal(denied[0].agent, 'technical-writer');
  });

  it('should enforce TDD gate: block implementation without test', () => {
    const tddGate = new TDDGate();

    const result = tddGate.check({
      implFile: 'src/main.py',
      testFile: 'test/test_main.py',
      testExists: false,
      implExists: true,
    });
    assert.ok(!result.passed);
    assert.ok(result.reason.includes('test first'));
  });

  it('should enforce evidence verification: reject claims without evidence', () => {
    const verifier = new EvidenceVerifier();

    const result = verifier.verify({
      claim: 'Feature complete',
      evidence: [],
      requiredTypes: ['test_output', 'coverage_report'],
    });
    assert.ok(!result.verified);
    assert.ok(result.missing.includes('test_output'));
    assert.ok(result.missing.includes('coverage_report'));
  });

  it('should enforce permission guard: block concurrent writes', () => {
    const guard = new PermissionGuard(ROOT);
    const filePath = path.join(ROOT, 'src', 'main.py');

    guard.acquireLock(filePath, 'task-worker-1');
    const result = guard.checkFileWrite(filePath, 'task-worker-2');
    assert.ok(!result.allowed);

    guard.releaseLock(filePath, 'task-worker-1');
    const result2 = guard.checkFileWrite(filePath, 'task-worker-2');
    assert.ok(result2.allowed);
  });
});
