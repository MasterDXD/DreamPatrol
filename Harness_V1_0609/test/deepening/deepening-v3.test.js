'use strict';
const { describe, it , afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');


const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { const r = obj.destroy(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}
describe('ConvergenceDetector', () => {
  afterEach(async () => { await _cleanAll(); });
  const ConvergenceDetector = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'convergence-detector'));

  it('should export signal types and default config', () => {
    assert.ok(ConvergenceDetector.SIGNAL_TYPES.QUALITY_SCORE);
    assert.ok(ConvergenceDetector.SIGNAL_TYPES.IMPROVEMENT_RATE);
    assert.ok(ConvergenceDetector.SIGNAL_TYPES.STABILITY);
    assert.ok(ConvergenceDetector.DEFAULT_CONFIG);
  });

  it('should construct with default config', () => {
    const detector = _track(new ConvergenceDetector());
    assert.ok(detector.isHealthy());
    const stats = detector.getStats();
    assert.equal(stats.activeExecutions, 0);
    assert.ok(stats.config.qualityThreshold > 0);
  });

  it('should construct with custom config', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.95, maxIterations: 5 }));
    const stats = detector.getStats();
    assert.equal(stats.config.qualityThreshold, 0.95);
    assert.equal(stats.config.maxIterations, 5);
  });

  it('should detect convergence when quality threshold is met', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.85 }));
    const result = detector.check('exec-1', { iteration: 1, qualityScore: 0.9, dimensions: { a: 0.9, b: 0.88 } });
    assert.equal(result.converged, true);
    assert.equal(result.reason, 'quality-threshold-met');
    assert.ok(result.signals.qualityScore.passed);
  });

  it('should detect plateau when improvement stops', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.99, minImprovementRate: 0.02, stabilityVariance: 0.01, stabilityWindow: 3 }));
    detector.check('exec-2', { iteration: 1, qualityScore: 0.75 });
    detector.check('exec-2', { iteration: 2, qualityScore: 0.76 });
    const result = detector.check('exec-2', { iteration: 3, qualityScore: 0.761 });
    assert.equal(result.converged, true);
    assert.equal(result.reason, 'plateau-detected');
  });

  it('should detect quality degradation', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.99 }));
    detector.check('exec-3', { iteration: 1, qualityScore: 0.7 });
    const result = detector.check('exec-3', { iteration: 2, qualityScore: 0.5 });
    assert.equal(result.converged, true);
    assert.equal(result.reason, 'quality-degrading');
  });

  it('should not converge when quality is improving', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.95 }));
    detector.check('exec-4', { iteration: 1, qualityScore: 0.5 });
    const result = detector.check('exec-4', { iteration: 2, qualityScore: 0.7 });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'not-converged');
  });

  it('should return missing-data for invalid inputs', () => {
    const detector = _track(new ConvergenceDetector());
    const result = detector.check(null, null);
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'missing-data');
  });

  it('should detect stable-and-sufficient convergence', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.95, stabilityVariance: 0.01, coverageThreshold: 0.7 }));
    detector.check('exec-5', { iteration: 1, qualityScore: 0.75, dimensions: { a: 0.85, b: 0.82 } });
    detector.check('exec-5', { iteration: 2, qualityScore: 0.76, dimensions: { a: 0.86, b: 0.83 } });
    const result = detector.check('exec-5', { iteration: 3, qualityScore: 0.755, dimensions: { a: 0.85, b: 0.82 } });
    assert.equal(result.converged, true);
    assert.ok(result.reason === 'stable-and-sufficient' || result.reason === 'plateau-detected');
  });

  it('should converge at max iterations', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.99, maxIterations: 3 }));
    detector.check('exec-6', { iteration: 1, qualityScore: 0.5 });
    detector.check('exec-6', { iteration: 2, qualityScore: 0.6 });
    const result = detector.check('exec-6', { iteration: 3, qualityScore: 0.7 });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'max-iterations-reached');
  });

  it('should provide recommendations', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.99 }));
    const result = detector.check('exec-7', { iteration: 1, qualityScore: 0.3 });
    assert.ok(result.recommendation);
    assert.ok(result.recommendation.includes('increase-depth'));
  });

  it('should check dimension balance', () => {
    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.99, dimensionBalanceThreshold: 0.1 }));
    const result = detector.check('exec-8', { iteration: 1, qualityScore: 0.7, dimensions: { a: 0.9, b: 0.2 } });
    assert.ok(result.signals.dimensionBalance);
    assert.equal(result.signals.dimensionBalance.passed, false);
  });

  it('should emit convergence-checked event', () => {
    const detector = _track(new ConvergenceDetector());
    const events = [];
    detector.on('convergence-checked', (e) => events.push(e));
    detector.check('exec-9', { iteration: 1, qualityScore: 0.9 });
    assert.equal(events.length, 1);
    assert.ok(events[0].signals);
  });

  it('should reset execution history', () => {
    const detector = _track(new ConvergenceDetector());
    detector.check('exec-10', { iteration: 1, qualityScore: 0.5 });
    const result = detector.reset('exec-10');
    assert.equal(result, true);
    assert.equal(detector.getStats().activeExecutions, 0);
  });

  it('should shutdown cleanly', () => {
    const detector = _track(new ConvergenceDetector());
    detector.shutdown();
    assert.equal(detector.getStats().activeExecutions, 0);
  });
});

describe('Integration: Third-wave modules with framework', () => {
  it('should create framework with convergence detector', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    assert.ok(instance.convergenceDetector);
    assert.ok(instance.convergenceDetector.isHealthy());
    await instance.destroy();
  });

  it('should register health check for convergence detector', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    const result = await instance.healthChecker.checkAll();
    const checks = Object.values(result.checks);
    const convergenceCheck = checks.find(c => c.name === 'convergence-detector');
    assert.ok(convergenceCheck);
    assert.equal(convergenceCheck.status, 'healthy');
    await instance.destroy();
  });

  it('should export ConvergenceDetector from package', () => {
    const pkg = require(path.join(ROOT, 'src', 'index'));
    assert.ok(pkg.ConvergenceDetector);
  });

  it('should integrate convergence detector with quality scorer', () => {
    const ConvergenceDetector = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'convergence-detector'));
    const QualityScorer = require(path.join(ROOT, 'src', 'runtime', 'quality', 'quality-scorer'));

    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.8 }));
    const scorer = _track(new QualityScorer());

    const execId = 'integration-test';
    const task = { requirements: ['auth', 'security'] };

    for (let i = 0; i < 5; i++) {
      const result = { success: true, valid: true, auth: 'done', security: 'checked', description: 'output' };
      const score = scorer.score(result, task);
      const convergence = detector.check(execId, {
        iteration: i + 1,
        qualityScore: score.total,
        dimensions: score.dimensions,
      });
      if (convergence.converged) break;
    }
  });

  it('should integrate convergence detector with recurrent deepening', async () => {
    const ConvergenceDetector = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'convergence-detector'));
    const RecurrentDeepeningScheduler = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'recurrent-deepening-scheduler'));

    const detector = _track(new ConvergenceDetector({ qualityThreshold: 0.85 }));
    const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 5, convergenceThreshold: 0.99, minImprovement: 0.001 }));

    const execId = 'rds-integration';
    let callCount = 0;
    const agent = {
      execute: async (_task) => {
        callCount++;
        return { output: `result-${callCount}`, success: true };
      },
    };

    const evaluator = async (_result, _task) => {
      const score = 0.5 + callCount * 0.1;
      const convergence = detector.check(execId, { iteration: callCount, qualityScore: score });
      return convergence.converged ? 0.95 : score;
    };

    const result = await scheduler.execute(agent, { description: 'test' }, evaluator);
    assert.equal(result.success, true);
  });

  it('should load deepening config from config.json', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    const stats = instance.recurrentDeepening.getStats();
    assert.ok(stats.maxIterations > 0);
    assert.ok(stats.convergenceThreshold > 0);
    await instance.destroy();
  });

  it('should have deepening semantic groups in SkillRouter', async () => {
    const { create } = require(path.join(ROOT, 'src', 'index'));
    const instance = create(ROOT);
    const matches = instance.router.match({ userMessage: '深化迭代推理', agent: 'task-worker' });
    assert.ok(Array.isArray(matches));
    await instance.destroy();
  });
});
