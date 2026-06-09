'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('AgentMonitor Antipattern Detection', () => {
  const AgentMonitor = require(path.join(ROOT, 'src', 'runtime', 'agent', 'agent-monitor'));

  it('should detect over-implementation antipattern', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      newFileCount: 5,
      addedLines: 400,
      newAbstractions: 4,
    });
    assert.ok(detected.length > 0);
    assert.ok(detected.some(d => d.id === 'over-implementation'));
    assert.equal(detected[0].severity, 'warning');
    monitor.shutdown();
  });

  it('should detect repeated-search antipattern', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      searchCount: 5,
      uniqueSearchTargets: 1,
    });
    assert.ok(detected.length > 0);
    assert.ok(detected.some(d => d.id === 'repeated-search'));
    monitor.shutdown();
  });

  it('should detect skip-verification antipattern', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      claimedComplete: true,
      verificationRan: false,
    });
    assert.ok(detected.length > 0);
    assert.ok(detected.some(d => d.id === 'skip-verification'));
    assert.equal(detected.find(d => d.id === 'skip-verification').severity, 'critical');
    monitor.shutdown();
  });

  it('should detect excessive-retries antipattern', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      retryCount: 5,
    });
    assert.ok(detected.length > 0);
    assert.ok(detected.some(d => d.id === 'excessive-retries'));
    monitor.shutdown();
  });

  it('should detect scope-creep antipattern', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      filesModified: 8,
      taskRelatedFiles: 2,
    });
    assert.ok(detected.length > 0);
    assert.ok(detected.some(d => d.id === 'scope-creep'));
    monitor.shutdown();
  });

  it('should return empty array when no antipatterns detected', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      newFileCount: 1,
      addedLines: 50,
      newAbstractions: 1,
      searchCount: 1,
      uniqueSearchTargets: 1,
      claimedComplete: true,
      verificationRan: true,
      retryCount: 1,
      filesModified: 2,
      taskRelatedFiles: 2,
    });
    assert.equal(detected.length, 0);
    monitor.shutdown();
  });

  it('should return empty array for invalid context', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    assert.deepEqual(monitor.detectAntipatterns('test-worker', null), []);
    assert.deepEqual(monitor.detectAntipatterns('test-worker', undefined), []);
    assert.deepEqual(monitor.detectAntipatterns('test-worker', 'invalid'), []);
    monitor.shutdown();
  });

  it('should emit antipattern-detected event', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    let eventFired = false;
    monitor.on('antipattern-detected', function(data) {
      eventFired = true;
      assert.equal(data.agentId, 'test-worker');
      assert.ok(data.patterns.length > 0);
    });
    monitor.detectAntipatterns('test-worker', {
      claimedComplete: true,
      verificationRan: false,
    });
    assert.ok(eventFired);
    monitor.shutdown();
  });

  it('should create alerts for detected antipatterns', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    monitor.detectAntipatterns('test-worker', {
      claimedComplete: true,
      verificationRan: false,
    });
    const alerts = monitor.getAlerts({ agentId: 'test-worker' });
    const antipatternAlerts = alerts.filter(a => a.metricName && a.metricName.startsWith('antipattern:'));
    assert.ok(antipatternAlerts.length > 0);
    assert.equal(antipatternAlerts[0].level, 'critical');
    monitor.shutdown();
  });

  it('should list antipattern rules', () => {
    const monitor = new AgentMonitor(ROOT);
    const rules = monitor.getAntipatternRules();
    assert.ok(rules.length >= 5);
    assert.ok(rules.some(r => r.id === 'over-implementation'));
    assert.ok(rules.some(r => r.id === 'repeated-search'));
    assert.ok(rules.some(r => r.id === 'skip-verification'));
    assert.ok(rules.some(r => r.id === 'excessive-retries'));
    assert.ok(rules.some(r => r.id === 'scope-creep'));
    monitor.shutdown();
  });

  it('should handle rule detection errors gracefully', () => {
    const monitor = new AgentMonitor(ROOT);
    monitor.registerAgent('test-worker');
    const detected = monitor.detectAntipatterns('test-worker', {
      get newFileCount() { throw new Error('test error'); },
    });
    assert.ok(Array.isArray(detected));
    monitor.shutdown();
  });
});

describe('PermissionGuard Confirmation Expiry', () => {
  const PermissionGuard = require(path.join(ROOT, 'src', 'permission', 'permission-guard'));

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
    const harnessDir = path.join(dir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    return dir;
  }

  it('should record and validate confirmations', () => {
    const dir = createTempDir();
    const guard = new PermissionGuard(dir);
    guard.recordConfirmation('agent-1', 'file_delete', '/some/file.js');
    assert.ok(guard.isConfirmationValid('agent-1', 'file_delete', '/some/file.js'));
    assert.ok(!guard.isConfirmationValid('agent-2', 'file_delete', '/some/file.js'));
    assert.ok(!guard.isConfirmationValid('agent-1', 'file_write', '/some/file.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should expire confirmations after timeout', async () => {
    const dir = createTempDir();
    const guard = new PermissionGuard(dir);
    guard.setConfirmationExpiry(50);
    guard.recordConfirmation('agent-1', 'file_delete', '/some/file.js');
    assert.ok(guard.isConfirmationValid('agent-1', 'file_delete', '/some/file.js'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!guard.isConfirmationValid('agent-1', 'file_delete', '/some/file.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should set custom confirmation expiry', () => {
    const dir = createTempDir();
    const guard = new PermissionGuard(dir);
    const result = guard.setConfirmationExpiry(10000);
    assert.equal(result, guard);
    guard.setConfirmationExpiry(-1);
    guard.setConfirmationExpiry('invalid');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should emit confirmation-recorded event', () => {
    const dir = createTempDir();
    const guard = new PermissionGuard(dir);
    let eventFired = false;
    guard.on('confirmation-recorded', function(data) {
      eventFired = true;
      assert.equal(data.agentId, 'agent-1');
      assert.equal(data.action, 'file_delete');
    });
    guard.recordConfirmation('agent-1', 'file_delete', '/some/file.js');
    assert.ok(eventFired);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should allow file delete with valid confirmation', () => {
    const dir = createTempDir();
    const testFile = path.join(dir, 'test-file.js');
    fs.writeFileSync(testFile, 'test');
    const guard = new PermissionGuard(dir);
    guard.recordConfirmation('agent-1', 'file_delete', testFile);
    const result = guard.checkFileDelete(testFile, 'agent-1');
    assert.ok(result.allowed);
    assert.ok(!result.requiresConfirmation);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should require confirmation for file delete without prior confirmation', () => {
    const dir = createTempDir();
    const testFile = path.join(dir, 'test-file.js');
    fs.writeFileSync(testFile, 'test');
    const guard = new PermissionGuard(dir);
    const result = guard.checkFileDelete(testFile, 'agent-1');
    assert.ok(result.allowed);
    assert.ok(result.requiresConfirmation);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('EvidenceVerifier Memory-Code Consistency', () => {
  const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

  it('should detect stale file path references in evidence', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature implemented',
      evidence: [
        { type: 'test_output', content: 'Tests passed in /src/nonexistent-module.js' },
      ],
      qualityCriteria: {
        dimensions: { memory_code_consistency: { weight: 0.5 } },
        knownPaths: ['src/existing-module.js'],
      },
    });
    assert.ok(result.qualityIssues.length > 0);
    assert.ok(result.qualityIssues.some(qi => qi.dimension === 'memory_code_consistency'));
  });

  it('should pass when file paths are known', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature implemented',
      evidence: [
        { type: 'test_output', content: 'Tests passed in /existing-module.js' },
      ],
      qualityCriteria: {
        dimensions: { memory_code_consistency: { weight: 0.5 } },
        knownPaths: ['existing-module.js'],
      },
    });
    assert.ok(!result.qualityIssues.some(qi => qi.dimension === 'memory_code_consistency'));
  });

  it('should include memory_code_consistency in default dimensions', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature implemented',
      evidence: [
        { type: 'test_output', content: 'All tests passed' },
      ],
      qualityCriteria: {},
    });
    assert.ok(result.score >= 0);
  });

  it('should generate reflection prompt for low scores', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Task done',
      evidence: [],
      skillId: 'tdd-implement',
      agentId: 'task-worker',
    });
    assert.ok(!result.verified);
    assert.ok(result.shouldReflect);
    assert.ok(result.reflectionPrompt);
    assert.ok(result.reflectionPrompt.includes('task-worker'));
  });

  it('should verify with all required evidence types', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'TDD implementation complete',
      evidence: [
        { type: 'test_output', content: 'All 15 tests passed successfully with 92% coverage' },
        { type: 'coverage_report', content: 'Coverage: 92% statements, 88% branches, 95% functions' },
      ],
      requiredTypes: verifier.getRequiredEvidenceTypes('tdd-implement'),
    });
    assert.ok(result.verified);
    assert.ok(result.score >= 0.8);
  });
});

describe('Hook Handlers: YAGNI and Output Format', () => {
  const { BUILTIN_HANDLERS } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'hook-handlers'));

  it('yagni_pre_check should warn on many new files', () => {
    const result = BUILTIN_HANDLERS.yagni_pre_check({
      diff: '+new file mode 1\n+new file mode 2\n+new file mode 3\n+new file mode 4',
      new_files: ['a.js', 'b.js'],
    });
    assert.ok(result.passed);
    assert.ok(result.details.warnings.length > 0);
  });

  it('yagni_pre_check should warn on excessive abstractions', () => {
    const result = BUILTIN_HANDLERS.yagni_pre_check({
      diff: 'class UserFactory {} class OrderFactory {} class ProductBuilder {} class PaymentStrategy {} class ShippingAdapter {}',
    });
    assert.ok(result.passed);
    assert.ok(result.details.warnings.some(w => w.includes('abstractions')));
  });

  it('yagni_pre_check should warn on excessive added lines', () => {
    const diff = Array(350).fill('+some code line').join('\n');
    const result = BUILTIN_HANDLERS.yagni_pre_check({ diff });
    assert.ok(result.passed);
    assert.ok(result.details.warnings.some(w => w.includes('lines')));
  });

  it('yagni_pre_check should warn on interface without implementation', () => {
    const result = BUILTIN_HANDLERS.yagni_pre_check({
      diff: 'interface IUserService { getUser(): User; }',
    });
    assert.ok(result.passed);
    assert.ok(result.details.warnings.some(w => w.includes('interface')));
  });

  it('yagni_pre_check should pass for minimal changes', () => {
    const result = BUILTIN_HANDLERS.yagni_pre_check({
      diff: '+function hello() { return "world"; }',
    });
    assert.ok(result.passed);
    assert.ok(!result.details);
  });

  it('yagni_pre_check should pass for empty context', () => {
    const result = BUILTIN_HANDLERS.yagni_pre_check({});
    assert.ok(result.passed);
  });

  it('output_format_check should reject emoji characters', () => {
    const result = BUILTIN_HANDLERS.output_format_check({
      output: 'Hello 🎉 World 🚀',
    });
    assert.ok(!result.passed);
    assert.ok(result.reason.includes('emoji'));
  });

  it('output_format_check should reject excessive headers', () => {
    const output = ['# H1', '## H2', '### H3', '# H1b', '## H2b', '### H3b', '# H1c', '## H2c', '### H3c'].join('\n');
    const result = BUILTIN_HANDLERS.output_format_check({ output });
    assert.ok(!result.passed);
    assert.ok(result.reason.includes('headers'));
  });

  it('output_format_check should pass for clean output', () => {
    const result = BUILTIN_HANDLERS.output_format_check({
      output: 'Implementation complete. All tests passed.',
    });
    assert.ok(result.passed);
  });

  it('output_format_check should pass for non-string output', () => {
    assert.ok(BUILTIN_HANDLERS.output_format_check({ output: null }).passed);
    assert.ok(BUILTIN_HANDLERS.output_format_check({ output: 123 }).passed);
    assert.ok(BUILTIN_HANDLERS.output_format_check({}).passed);
  });
});

describe('Hook Handlers: Phase Error Retry with Root Cause', () => {
  const { BUILTIN_HANDLERS } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'hook-handlers'));

  it('should require root cause on first retry', () => {
    const result = BUILTIN_HANDLERS.phase_error_retry({
      error: { attempt: 0, message: 'Test failure' },
      phase: 'module-development',
    });
    assert.ok(result.passed);
    assert.ok(result.retry);
    assert.ok(result.requireRootCause);
    assert.ok(result.message.includes('Root cause analysis'));
  });

  it('should proceed with retry when root cause provided', () => {
    const result = BUILTIN_HANDLERS.phase_error_retry({
      error: { attempt: 1, message: 'Test failure', rootCauseHypothesis: 'Missing dependency' },
      phase: 'module-development',
    });
    assert.ok(result.passed);
    assert.ok(result.retry);
    assert.ok(result.details.rootCauseHypothesis === 'Missing dependency');
  });

  it('should escalate after max retries', () => {
    const result = BUILTIN_HANDLERS.phase_error_retry({
      error: { attempt: 3, message: 'Persistent failure' },
      phase: 'module-development',
    });
    assert.ok(!result.passed);
    assert.ok(result.escalate);
    assert.ok(result.reason.includes('escalating'));
  });

  it('should calculate exponential backoff', () => {
    const result = BUILTIN_HANDLERS.phase_error_retry({
      error: { attempt: 2, message: 'Test failure', rootCauseHypothesis: 'Race condition' },
      phase: 'module-development',
    });
    assert.ok(result.details.backoffMs > 0);
    assert.ok(result.details.backoffMs <= 30000);
  });
});
