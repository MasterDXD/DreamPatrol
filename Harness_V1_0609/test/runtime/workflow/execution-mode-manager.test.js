'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('ExecutionModeManager - construction and constants', () => {
  const { ExecutionModeManager, EXECUTION_MODES, MODE_SOURCES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'execution-mode-manager'));

  it('should expose EXECUTION_MODES constants', () => {
    assert.strictEqual(EXECUTION_MODES.AUTONOMOUS, 'autonomous');
    assert.strictEqual(EXECUTION_MODES.SUPERVISED, 'supervised');
    assert.strictEqual(EXECUTION_MODES.DOCUMENT_DRIVEN, 'document-driven');
  });

  it('should expose MODE_SOURCES constants', () => {
    assert.strictEqual(MODE_SOURCES.ENV_VAR, 'env-var');
    assert.strictEqual(MODE_SOURCES.CONFIG, 'config');
    assert.strictEqual(MODE_SOURCES.CLI_ARG, 'cli-arg');
    assert.strictEqual(MODE_SOURCES.API, 'api');
    assert.strictEqual(MODE_SOURCES.DEFAULT, 'default');
  });

  it('should construct with default mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.currentMode, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(emm.modeSource, MODE_SOURCES.DEFAULT);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should construct with custom default mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.SUPERVISED });
    assert.strictEqual(emm.currentMode, EXECUTION_MODES.SUPERVISED);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should detect mode from env var', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    process.env.HARNESS_EXECUTION_MODE = 'supervised';
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.currentMode, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(emm.modeSource, MODE_SOURCES.ENV_VAR);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
    else delete process.env.HARNESS_EXECUTION_MODE;
  });

  it('should detect document-driven from env var alias', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    process.env.HARNESS_EXECUTION_MODE = 'doc';
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.currentMode, EXECUTION_MODES.DOCUMENT_DRIVEN);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
    else delete process.env.HARNESS_EXECUTION_MODE;
  });

  it('should fall back to default on invalid env var', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    process.env.HARNESS_EXECUTION_MODE = 'invalid-mode';
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.currentMode, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(emm.modeSource, MODE_SOURCES.DEFAULT);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
    else delete process.env.HARNESS_EXECUTION_MODE;
  });
});

describe('ExecutionModeManager - mode switching', () => {
  const { ExecutionModeManager, EXECUTION_MODES, MODE_SOURCES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'execution-mode-manager'));

  it('should switch mode and emit mode-changed event', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    let eventData = null;
    emm.on('mode-changed', (d) => { eventData = d; });
    const result = emm.switchMode(EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(result.from, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(result.to, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(emm.currentMode, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(eventData.from, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(eventData.to, EXECUTION_MODES.SUPERVISED);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should switch mode with custom source', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    const result = emm.switchMode(EXECUTION_MODES.DOCUMENT_DRIVEN, MODE_SOURCES.CLI_ARG);
    assert.strictEqual(result.source, MODE_SOURCES.CLI_ARG);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should throw on invalid mode switch', () => {
    const emm = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.AUTONOMOUS });
    delete process.env.HARNESS_EXECUTION_MODE;
    assert.throws(() => emm.switchMode('invalid-mode'), { code: 'INVALID_EXECUTION_MODE' });
    emm.shutdown();
  });

  it('should throw when mode switching is disabled', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({ modeSwitchAllowed: false });
    assert.throws(() => emm.switchMode(EXECUTION_MODES.SUPERVISED, MODE_SOURCES.API), { code: 'MODE_SWITCH_DISABLED' });
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should allow DEFAULT source even when switching is disabled', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({ modeSwitchAllowed: false });
    const result = emm.switchMode(EXECUTION_MODES.SUPERVISED, MODE_SOURCES.DEFAULT);
    assert.strictEqual(result.to, EXECUTION_MODES.SUPERVISED);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should check isAutonomous', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.isAutonomous(), true);
    assert.strictEqual(emm.isSupervised(), false);
    assert.strictEqual(emm.isDocumentDriven(), false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should check isSupervised', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.SUPERVISED });
    assert.strictEqual(emm.isAutonomous(), false);
    assert.strictEqual(emm.isSupervised(), true);
    assert.strictEqual(emm.isDocumentDriven(), false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should check isDocumentDriven', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({ defaultMode: EXECUTION_MODES.DOCUMENT_DRIVEN });
    assert.strictEqual(emm.isAutonomous(), false);
    assert.strictEqual(emm.isSupervised(), false);
    assert.strictEqual(emm.isDocumentDriven(), true);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });
});

describe('ExecutionModeManager - approval', () => {
  const { ExecutionModeManager, EXECUTION_MODES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'execution-mode-manager'));

  it('should not require approval in autonomous mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.requiresApproval('phase-transition'), false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should require approval for configured points in supervised mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['phase-transition', 'goal-start'],
    });
    assert.strictEqual(emm.requiresApproval('phase-transition'), true);
    assert.strictEqual(emm.requiresApproval('goal-start'), true);
    assert.strictEqual(emm.requiresApproval('unknown-point'), false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should require approval in document-driven mode when autoAdvance is false', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.DOCUMENT_DRIVEN,
      documentDrivenAutoAdvance: false,
    });
    assert.strictEqual(emm.requiresApproval('phase-transition'), true);
    assert.strictEqual(emm.requiresApproval('other-point'), false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should not require approval in document-driven mode when autoAdvance is true', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.DOCUMENT_DRIVEN,
      documentDrivenAutoAdvance: true,
    });
    assert.strictEqual(emm.requiresApproval('phase-transition'), false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should auto-approve when point does not require approval', async () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    const result = await emm.requestApproval('any-point');
    assert.strictEqual(result.approved, true);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should call approval callback when registered', async () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['deploy'],
    });
    emm.registerApprovalCallback('deploy', async () => true);
    const result = await emm.requestApproval('deploy', { env: 'prod' });
    assert.strictEqual(result.approved, true);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should return false when callback rejects', async () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['deploy'],
    });
    emm.registerApprovalCallback('deploy', async () => false);
    const result = await emm.requestApproval('deploy');
    assert.strictEqual(result.approved, false);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should emit approval-result event after callback', async () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['deploy'],
    });
    emm.registerApprovalCallback('deploy', async () => true);
    let eventData = null;
    emm.on('approval-result', (d) => { eventData = d; });
    await emm.requestApproval('deploy', { env: 'staging' });
    assert.strictEqual(eventData.approved, true);
    assert.strictEqual(eventData.point, 'deploy');
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should emit approval-required when no callback registered', async () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['deploy'],
    });
    let eventData = null;
    emm.on('approval-required', (d) => { eventData = d; });
    const result = await emm.requestApproval('deploy', { env: 'prod' });
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.reason, 'no-approval-callback-registered');
    assert.strictEqual(eventData.point, 'deploy');
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should handle callback error gracefully', async () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['deploy'],
    });
    emm.registerApprovalCallback('deploy', async () => { throw new Error('callback failed'); });
    const result = await emm.requestApproval('deploy');
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.reason, 'approval-callback-error');
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should throw on invalid callback registration', () => {
    const emm = new ExecutionModeManager();
    assert.throws(() => emm.registerApprovalCallback('point', 'not-a-function'), { code: 'INVALID_CALLBACK' });
    emm.shutdown();
  });
});

describe('ExecutionModeManager - stats and history', () => {
  const { ExecutionModeManager, EXECUTION_MODES, MODE_SOURCES } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'execution-mode-manager'));

  it('should return approval points for supervised mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['phase-transition', 'goal-start'],
    });
    const points = emm.getApprovalPoints();
    assert.deepStrictEqual(points, ['phase-transition', 'goal-start']);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should return empty approval points for autonomous mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    assert.deepStrictEqual(emm.getApprovalPoints(), []);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should return spec path in document-driven mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.DOCUMENT_DRIVEN,
      documentDrivenSpecPath: '/path/to/spec.md',
    });
    assert.strictEqual(emm.getSpecPath(), '/path/to/spec.md');
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should return null spec path in non-document-driven mode', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    assert.strictEqual(emm.getSpecPath(), null);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should return mode history', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    emm.switchMode(EXECUTION_MODES.SUPERVISED);
    emm.switchMode(EXECUTION_MODES.DOCUMENT_DRIVEN);
    const history = emm.getModeHistory();
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].mode, EXECUTION_MODES.AUTONOMOUS);
    assert.strictEqual(history[1].mode, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(history[2].mode, EXECUTION_MODES.DOCUMENT_DRIVEN);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should trim mode history when exceeding 100 entries', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    for (let i = 0; i < 105; i++) {
      emm._modeHistory.push({ mode: EXECUTION_MODES.AUTONOMOUS, source: MODE_SOURCES.API, timestamp: Date.now() });
    }
    emm.switchMode(EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(emm._modeHistory.length, 50);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should return stats', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager({
      defaultMode: EXECUTION_MODES.SUPERVISED,
      supervisedApprovalPoints: ['phase-transition'],
    });
    const stats = emm.getStats();
    assert.strictEqual(stats.currentMode, EXECUTION_MODES.SUPERVISED);
    assert.strictEqual(stats.modeSource, MODE_SOURCES.DEFAULT);
    assert.deepStrictEqual(stats.approvalPoints, ['phase-transition']);
    assert.strictEqual(stats.modeSwitchAllowed, true);
    assert.strictEqual(stats.historyLength, 1);
    emm.shutdown();
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });

  it('should shutdown cleanly', () => {
    const orig = process.env.HARNESS_EXECUTION_MODE;
    delete process.env.HARNESS_EXECUTION_MODE;
    const emm = new ExecutionModeManager();
    emm.registerApprovalCallback('test', async () => true);
    emm.shutdown();
    assert.strictEqual(emm._approvalCallbacks.size, 0);
    assert.strictEqual(emm._modeHistory.length, 0);
    if (orig !== undefined) process.env.HARNESS_EXECUTION_MODE = orig;
  });
});
