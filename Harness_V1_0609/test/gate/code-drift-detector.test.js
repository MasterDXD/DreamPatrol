'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CodeDriftDetector } = require('../../src/gate/code-drift-detector');

describe('CodeDriftDetector', () => {
  it('should return no drift with insufficient history', () => {
    const detector = new CodeDriftDetector();
    const result = detector.detectDrift();
    assert.equal(result.drifting, false);
    assert.equal(result.reason, 'insufficient_history');
  });

  it('should detect violation growth', () => {
    const detector = new CodeDriftDetector({ violationGrowthRate: 0.1 });
    detector.snapshot([], {}, {});
    detector.snapshot(
      [{ fromLayer: 'infrastructure', toLayer: 'domain', fromModule: 'utils', file: 'test.js' }],
      { domain: { fileCount: 10 }, infrastructure: { fileCount: 5 } },
      { utils: 5 },
    );
    const result = detector.detectDrift();
    assert.equal(result.drifting, true);
    assert.ok(result.alerts.length > 0);
  });

  it('should compute trend as stable with few snapshots', () => {
    const detector = new CodeDriftDetector();
    detector.snapshot([], {}, {});
    detector.snapshot([], {}, {});
    const result = detector.detectDrift();
    assert.equal(result.trend, 'stable');
  });

  it('should detect increasing trend', () => {
    const detector = new CodeDriftDetector();
    detector.snapshot([], {}, {});
    detector.snapshot([{ fromLayer: 'a' }], {}, {});
    detector.snapshot([{ fromLayer: 'a' }, { fromLayer: 'b' }], {}, {});
    const result = detector.detectDrift();
    assert.equal(result.trend, 'increasing');
  });

  it('should detect decreasing trend', () => {
    const detector = new CodeDriftDetector();
    detector.snapshot([{ fromLayer: 'a' }, { fromLayer: 'b' }], {}, {});
    detector.snapshot([{ fromLayer: 'a' }], {}, {});
    detector.snapshot([], {}, {});
    const result = detector.detectDrift();
    assert.equal(result.trend, 'decreasing');
  });

  it('should manage history size', () => {
    const detector = new CodeDriftDetector({ maxHistory: 3 });
    for (let i = 0; i < 5; i++) detector.snapshot([], {}, {});
    assert.equal(detector.getHistory().length, 3);
  });

  it('should set and get baseline', () => {
    const detector = new CodeDriftDetector();
    assert.equal(detector.getBaseline(), null);
    detector.setBaseline({ violationCount: 0 });
    assert.equal(detector.getBaseline().violationCount, 0);
  });

  it('should return thresholds', () => {
    const detector = new CodeDriftDetector({ violationGrowthRate: 0.2 });
    const thresholds = detector.getThresholds();
    assert.equal(thresholds.violationGrowthRate, 0.2);
  });

  it('should detect high coupling score', () => {
    const detector = new CodeDriftDetector({ moduleCouplingScore: 0.1 });
    detector.snapshot([], {}, { moduleA: 5, moduleB: 5 });
    detector.snapshot(
      [{ fromModule: 'moduleA' }, { fromModule: 'moduleB' }],
      {},
      { moduleA: 5, moduleB: 5 },
    );
    const result = detector.detectDrift();
    assert.equal(result.drifting, true);
  });
});
