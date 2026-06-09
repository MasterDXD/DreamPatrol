'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const ScenarioPredictor = require('../../../src/runtime/causal/scenario-predictor');

describe('ScenarioPredictor - Constructor', () => {
  it('should create instance with default values', () => {
    const predictor = new ScenarioPredictor();
    assert.ok(predictor);
    assert.strictEqual(typeof predictor.defineScenario, 'function');
    assert.strictEqual(typeof predictor.getScenario, 'function');
    assert.strictEqual(typeof predictor.listScenarios, 'function');
    assert.strictEqual(typeof predictor.removeScenario, 'function');
    assert.strictEqual(typeof predictor.runMonteCarlo, 'function');
    assert.strictEqual(typeof predictor.compareScenarios, 'function');
    assert.strictEqual(typeof predictor.sensitivityAnalysis, 'function');
    assert.strictEqual(typeof predictor.generatePredictionReport, 'function');
    assert.strictEqual(typeof predictor.isHealthy, 'function');
    assert.strictEqual(typeof predictor.getStats, 'function');
    assert.strictEqual(typeof predictor.shutdown, 'function');
    predictor.shutdown();
  });
});

describe('ScenarioPredictor - defineScenario / getScenario / listScenarios / removeScenario', () => {
  it('should define and retrieve a scenario', () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'growth',
      'Revenue growth model',
      [{ name: 'revenue', type: 'continuous', range: [100, 500], distribution: 'uniform' }],
    );
    assert.ok(scenario.scenarioId);
    assert.ok(scenario.scenarioId.startsWith('scenario-'));
    assert.strictEqual(scenario.name, 'growth');
    assert.strictEqual(scenario.description, 'Revenue growth model');
    assert.strictEqual(scenario.variables.length, 1);
    assert.strictEqual(scenario.variables[0].name, 'revenue');
    const retrieved = predictor.getScenario(scenario.scenarioId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.scenarioId, scenario.scenarioId);
    predictor.shutdown();
  });

  it('should emit scenario-defined event', () => {
    const predictor = new ScenarioPredictor();
    let emitted = false;
    predictor.on('scenario-defined', (e) => {
      emitted = true;
      assert.ok(e.scenarioId);
      assert.strictEqual(e.name, 'test-scenario');
    });
    predictor.defineScenario('test-scenario', 'desc', [{ name: 'x', type: 'continuous', range: [0, 1], distribution: 'uniform' }]);
    assert.strictEqual(emitted, true);
    predictor.shutdown();
  });

  it('should list scenarios', () => {
    const predictor = new ScenarioPredictor();
    predictor.defineScenario('s1', 'desc1', [{ name: 'a', type: 'continuous', range: [0, 10], distribution: 'uniform' }]);
    predictor.defineScenario('s2', 'desc2', [{ name: 'b', type: 'continuous', range: [0, 10], distribution: 'uniform' }]);
    const list = predictor.listScenarios();
    assert.strictEqual(list.length, 2);
    predictor.shutdown();
  });

  it('should remove a scenario', () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario('to-remove', 'desc', [{ name: 'x', type: 'continuous', range: [0, 1], distribution: 'uniform' }]);
    const removed = predictor.removeScenario(scenario.scenarioId);
    assert.strictEqual(removed, true);
    assert.strictEqual(predictor.getScenario(scenario.scenarioId), null);
    predictor.shutdown();
  });
});

describe('ScenarioPredictor - runMonteCarlo', () => {
  it('should run monte carlo simulation', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'mc-test',
      'MC test scenario',
      [{ name: 'value', type: 'continuous', range: [0, 100], distribution: 'uniform' }],
    );
    const result = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    assert.ok(result.runId);
    assert.ok(result.runId.startsWith('mc-'));
    assert.strictEqual(result.scenarioId, scenario.scenarioId);
    assert.strictEqual(result.iterations, 100);
    predictor.shutdown();
  });

  it('should return results with statistics', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'stats-test',
      'Stats test',
      [{ name: 'val', type: 'continuous', range: [0, 100], distribution: 'uniform' }],
    );
    const result = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    assert.ok(result.results);
    assert.strictEqual(typeof result.results.mean, 'number');
    assert.strictEqual(typeof result.results.median, 'number');
    assert.strictEqual(typeof result.results.stdDev, 'number');
    assert.ok(result.results.percentiles);
    assert.ok(result.results.confidenceInterval);
    assert.strictEqual(typeof result.results.confidenceLevel, 'number');
    predictor.shutdown();
  });

  it('should return risk metrics', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'risk-test',
      'Risk test',
      [{ name: 'val', type: 'continuous', range: [0, 100], distribution: 'uniform' }],
    );
    const result = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    assert.ok(result.riskMetrics);
    assert.strictEqual(typeof result.riskMetrics.var95, 'number');
    assert.strictEqual(typeof result.riskMetrics.var99, 'number');
    assert.strictEqual(typeof result.riskMetrics.expectedShortfall, 'number');
    assert.strictEqual(typeof result.riskMetrics.maxDrawdown, 'number');
    predictor.shutdown();
  });

  it('should emit monte-carlo-started and monte-carlo-completed events', async () => {
    const predictor = new ScenarioPredictor();
    const events = [];
    predictor.on('monte-carlo-started', (e) => events.push({ type: 'started', data: e }));
    predictor.on('monte-carlo-completed', (e) => events.push({ type: 'completed', data: e }));
    const scenario = predictor.defineScenario(
      'event-test',
      'Event test',
      [{ name: 'v', type: 'continuous', range: [0, 10], distribution: 'uniform' }],
    );
    await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'started');
    assert.strictEqual(events[0].data.iterations, 100);
    assert.strictEqual(events[1].type, 'completed');
    assert.ok(events[1].data.runId);
    assert.strictEqual(typeof events[1].data.validCount, 'number');
    predictor.shutdown();
  });

  it('should handle different sampling methods', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'sampling-test',
      'Sampling test',
      [{ name: 'v', type: 'continuous', range: [0, 100], distribution: 'uniform' }],
    );
    const random = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100, samplingMethod: 'random' });
    assert.ok(random.results);
    const lhs = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100, samplingMethod: 'latin-hypercube' });
    assert.ok(lhs.results);
    const sobol = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100, samplingMethod: 'sobol' });
    assert.ok(sobol.results);
    predictor.shutdown();
  });

  it('should return null for unknown scenario', () => {
    const predictor = new ScenarioPredictor();
    assert.strictEqual(predictor.getScenario('nonexistent'), null);
    predictor.shutdown();
  });
});

describe('ScenarioPredictor - compareScenarios', () => {
  it('should compare two scenarios by mean', async () => {
    const predictor = new ScenarioPredictor();
    const s1 = predictor.defineScenario('low', 'Low range', [{ name: 'v', type: 'continuous', range: [0, 10], distribution: 'uniform' }]);
    const s2 = predictor.defineScenario('high', 'High range', [{ name: 'v', type: 'continuous', range: [90, 100], distribution: 'uniform' }]);
    await predictor.runMonteCarlo(s1.scenarioId, { iterations: 100 });
    await predictor.runMonteCarlo(s2.scenarioId, { iterations: 100 });
    const comparison = predictor.compareScenarios(s1.scenarioId, s2.scenarioId, 'mean');
    assert.ok(comparison);
    assert.strictEqual(comparison.scenario1.id, s1.scenarioId);
    assert.strictEqual(comparison.scenario2.id, s2.scenarioId);
    assert.strictEqual(typeof comparison.delta, 'number');
    assert.strictEqual(typeof comparison.relativeDelta, 'number');
    assert.strictEqual(typeof comparison.winner, 'string');
    assert.strictEqual(typeof comparison.confidence, 'number');
    predictor.shutdown();
  });

  it('should determine winner', async () => {
    const predictor = new ScenarioPredictor();
    const s1 = predictor.defineScenario('low', 'Low', [{ name: 'v', type: 'continuous', range: [0, 10], distribution: 'uniform' }]);
    const s2 = predictor.defineScenario('high', 'High', [{ name: 'v', type: 'continuous', range: [90, 100], distribution: 'uniform' }]);
    await predictor.runMonteCarlo(s1.scenarioId, { iterations: 100 });
    await predictor.runMonteCarlo(s2.scenarioId, { iterations: 100 });
    const comparison = predictor.compareScenarios(s1.scenarioId, s2.scenarioId, 'mean');
    assert.ok(comparison.winner === s1.scenarioId || comparison.winner === s2.scenarioId || comparison.winner === 'tie');
    predictor.shutdown();
  });

  it('should emit scenarios-compared event', async () => {
    const predictor = new ScenarioPredictor();
    let emitted = false;
    predictor.on('scenarios-compared', () => { emitted = true; });
    const s1 = predictor.defineScenario('a', 'A', [{ name: 'v', type: 'continuous', range: [0, 10], distribution: 'uniform' }]);
    const s2 = predictor.defineScenario('b', 'B', [{ name: 'v', type: 'continuous', range: [0, 10], distribution: 'uniform' }]);
    await predictor.runMonteCarlo(s1.scenarioId, { iterations: 100 });
    await predictor.runMonteCarlo(s2.scenarioId, { iterations: 100 });
    predictor.compareScenarios(s1.scenarioId, s2.scenarioId, 'mean');
    assert.strictEqual(emitted, true);
    predictor.shutdown();
  });
});

describe('ScenarioPredictor - sensitivityAnalysis', () => {
  it('should compute sensitivity for each input variable', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'sens-test',
      'Sensitivity test',
      [
        { name: 'target', type: 'continuous', range: [0, 100], distribution: 'uniform' },
        { name: 'input1', type: 'continuous', range: [0, 50], distribution: 'uniform' },
        { name: 'input2', type: 'continuous', range: [0, 50], distribution: 'uniform' },
      ],
    );
    await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    const result = predictor.sensitivityAnalysis(scenario.scenarioId, 'target');
    assert.ok(result);
    assert.strictEqual(result.variable, 'target');
    assert.ok(Array.isArray(result.sensitivities));
    assert.strictEqual(result.sensitivities.length, 2);
    for (const s of result.sensitivities) {
      assert.strictEqual(typeof s.inputVariable, 'string');
      assert.strictEqual(typeof s.correlation, 'number');
      assert.strictEqual(typeof s.rankCorrelation, 'number');
      assert.strictEqual(typeof s.contribution, 'number');
    }
    predictor.shutdown();
  });

  it('should emit sensitivity-analysis-completed event', async () => {
    const predictor = new ScenarioPredictor();
    let emitted = false;
    predictor.on('sensitivity-analysis-completed', () => { emitted = true; });
    const scenario = predictor.defineScenario(
      'sens-event',
      'Sens event test',
      [
        { name: 'target', type: 'continuous', range: [0, 100], distribution: 'uniform' },
        { name: 'input1', type: 'continuous', range: [0, 50], distribution: 'uniform' },
      ],
    );
    await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    predictor.sensitivityAnalysis(scenario.scenarioId, 'target');
    assert.strictEqual(emitted, true);
    predictor.shutdown();
  });
});

describe('ScenarioPredictor - generatePredictionReport', () => {
  it('should generate markdown report', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'report-test',
      'Report test scenario',
      [{ name: 'val', type: 'continuous', range: [0, 100], distribution: 'uniform' }],
    );
    const mcResult = await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    const report = predictor.generatePredictionReport(scenario.scenarioId, mcResult.runId);
    assert.ok(typeof report === 'string');
    assert.ok(report.includes('# Prediction Report: report-test'));
    assert.ok(report.includes('## Scenario Description'));
    assert.ok(report.includes('Report test scenario'));
    assert.ok(report.includes('## Variables'));
    assert.ok(report.includes('## Monte Carlo Results'));
    assert.ok(report.includes('## Risk Metrics'));
    predictor.shutdown();
  });
});

describe('ScenarioPredictor - isHealthy / getStats / shutdown', () => {
  it('should be healthy with few scenarios', () => {
    const predictor = new ScenarioPredictor();
    assert.strictEqual(predictor.isHealthy(), true);
    predictor.defineScenario('test', 'desc', [{ name: 'v', type: 'continuous', range: [0, 1], distribution: 'uniform' }]);
    assert.strictEqual(predictor.isHealthy(), true);
    predictor.shutdown();
  });

  it('should return correct stats', async () => {
    const predictor = new ScenarioPredictor();
    const scenario = predictor.defineScenario(
      'stats-test',
      'Stats test',
      [{ name: 'v', type: 'continuous', range: [0, 10], distribution: 'uniform' }],
    );
    await predictor.runMonteCarlo(scenario.scenarioId, { iterations: 100 });
    const stats = predictor.getStats();
    assert.strictEqual(stats.scenariosTotal, 1);
    assert.strictEqual(stats.monteCarloRunsTotal, 1);
    assert.strictEqual(stats.avgIterations, 100);
    assert.strictEqual(typeof stats.avgConfidence, 'number');
    predictor.shutdown();
  });

  it('should prevent operations after shutdown', async () => {
    const predictor = new ScenarioPredictor();
    predictor.shutdown();
    assert.strictEqual(predictor.isHealthy(), false);
    assert.throws(() => predictor.defineScenario('test', 'desc', [{ name: 'v', type: 'continuous', range: [0, 1], distribution: 'uniform' }]), /shut down/i);
    await assert.rejects(() => predictor.runMonteCarlo('x'), /shut down/i);
  });
});
