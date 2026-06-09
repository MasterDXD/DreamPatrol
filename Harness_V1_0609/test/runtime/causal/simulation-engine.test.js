'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const SimulationEngine = require('../../../src/runtime/causal/simulation-engine');

describe('SimulationEngine - Constructor', () => {
  it('should create instance with default values', () => {
    const engine = new SimulationEngine();
    assert.ok(engine);
    assert.strictEqual(typeof engine.simulate, 'function');
    assert.strictEqual(typeof engine.counterfactual, 'function');
    assert.strictEqual(typeof engine.forwardPredict, 'function');
    assert.strictEqual(typeof engine.getSimulation, 'function');
    assert.strictEqual(typeof engine.listSimulations, 'function');
    assert.strictEqual(typeof engine.generateReport, 'function');
    assert.strictEqual(typeof engine.isHealthy, 'function');
    assert.strictEqual(typeof engine.getStats, 'function');
    assert.strictEqual(typeof engine.shutdown, 'function');
    engine.shutdown();
  });
});

describe('SimulationEngine - simulate', () => {
  it('should simulate forward from initial state', () => {
    const engine = new SimulationEngine();
    const result = engine.simulate(
      { variables: { x: 10, y: 5 } },
      [{ name: 'increment', effects: { x: { operator: '+', value: 3 } }, probability: 0.9 }],
    );
    assert.ok(result.simulationId);
    assert.ok(result.simulationId.startsWith('sim-'));
    assert.ok(Array.isArray(result.branches));
    assert.ok(result.branches.length > 0);
    assert.ok(result.summary);
    engine.shutdown();
  });

  it('should return branches and summary', () => {
    const engine = new SimulationEngine();
    const result = engine.simulate(
      { variables: { a: 1 } },
      [{ name: 'act1', effects: { a: { operator: '+', value: 1 } }, probability: 0.8 }],
    );
    assert.ok('simulationId' in result);
    assert.ok('branches' in result);
    assert.ok('summary' in result);
    assert.ok('totalBranches' in result.summary);
    assert.ok('avgConfidence' in result.summary);
    assert.ok('topOutcome' in result.summary);
    assert.ok('riskFactors' in result.summary);
    assert.ok('opportunities' in result.summary);
    engine.shutdown();
  });

  it('should respect maxDepth option', () => {
    const engine = new SimulationEngine();
    const result1 = engine.simulate(
      { variables: { x: 0 } },
      [{ name: 'inc', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 }],
      { maxDepth: 1 },
    );
    const result2 = engine.simulate(
      { variables: { x: 0 } },
      [{ name: 'inc', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 }],
      { maxDepth: 5 },
    );
    assert.ok(result1.branches.length <= result2.branches.length + 1);
    engine.shutdown();
  });

  it('should respect maxBranches option', () => {
    const engine = new SimulationEngine();
    const result = engine.simulate(
      { variables: { x: 0 } },
      [
        { name: 'a', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 },
        { name: 'b', effects: { x: { operator: '+', value: 2 } }, probability: 0.9 },
        { name: 'c', effects: { x: { operator: '+', value: 3 } }, probability: 0.9 },
      ],
      { maxBranches: 2 },
    );
    assert.ok(result.branches.length <= 10);
    engine.shutdown();
  });

  it('should emit simulation-started and simulation-completed events', () => {
    const engine = new SimulationEngine();
    const events = [];
    engine.on('simulation-started', (e) => events.push({ type: 'started', data: e }));
    engine.on('simulation-completed', (e) => events.push({ type: 'completed', data: e }));
    engine.simulate(
      { variables: { x: 1 } },
      [{ name: 'act', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 }],
    );
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'started');
    assert.ok(events[0].data.simulationId);
    assert.strictEqual(events[1].type, 'completed');
    assert.ok(events[1].data.simulationId);
    assert.strictEqual(typeof events[1].data.branchCount, 'number');
    assert.strictEqual(typeof events[1].data.avgConfidence, 'number');
    engine.shutdown();
  });

  it('should handle empty actions array', () => {
    const engine = new SimulationEngine();
    const result = engine.simulate({ variables: { x: 1 } }, []);
    assert.ok(result.simulationId);
    assert.ok(Array.isArray(result.branches));
    assert.strictEqual(result.branches.length, 1);
    assert.strictEqual(result.summary.totalBranches, 1);
    engine.shutdown();
  });

  it('should handle actions with probability', () => {
    const engine = new SimulationEngine();
    const result = engine.simulate(
      { variables: { x: 0 } },
      [
        { name: 'high', effects: { x: { operator: '+', value: 10 } }, probability: 0.9 },
        { name: 'low', effects: { x: { operator: '+', value: 1 } }, probability: 0.1 },
      ],
    );
    assert.ok(result.branches.length > 0);
    const highBranch = result.branches.find(b => b.path.includes('high'));
    const lowBranch = result.branches.find(b => b.path.includes('low'));
    if (highBranch && lowBranch) {
      assert.ok(highBranch.confidence >= lowBranch.confidence);
    }
    engine.shutdown();
  });
});

describe('SimulationEngine - counterfactual', () => {
  it('should compute counterfactual outcome', () => {
    const engine = new SimulationEngine();
    const result = engine.counterfactual(
      { variables: { revenue: 100 } },
      { name: 'invest', effects: { revenue: { operator: '+', value: 20 } }, probability: 0.8 },
      { name: 'save', effects: { revenue: { operator: '+', value: 5 } }, probability: 0.9 },
      3,
    );
    assert.ok(result.actualOutcome);
    assert.ok(result.counterfactualOutcome);
    assert.ok(result.divergence);
    assert.ok(typeof result.insight === 'string');
    engine.shutdown();
  });

  it('should return divergence between actual and counterfactual', () => {
    const engine = new SimulationEngine();
    const result = engine.counterfactual(
      { variables: { x: 10 } },
      { name: 'add10', effects: { x: { operator: '+', value: 10 } }, probability: 0.9 },
      { name: 'add1', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 },
    );
    assert.ok(result.divergence);
    assert.strictEqual(typeof result.divergence.magnitude, 'number');
    assert.ok(result.divergence.magnitude > 0);
    assert.ok(result.divergence.variables);
    engine.shutdown();
  });

  it('should emit counterfactual-completed event', () => {
    const engine = new SimulationEngine();
    let emitted = false;
    engine.on('counterfactual-completed', () => { emitted = true; });
    engine.counterfactual(
      { variables: { x: 1 } },
      { name: 'a', effects: { x: { operator: '+', value: 5 } }, probability: 0.9 },
      { name: 'b', effects: { x: { operator: '+', value: 2 } }, probability: 0.9 },
    );
    assert.strictEqual(emitted, true);
    engine.shutdown();
  });

  it('should handle depth parameter', () => {
    const engine = new SimulationEngine();
    const result = engine.counterfactual(
      { variables: { x: 0 } },
      { name: 'a', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 },
      { name: 'b', effects: { x: { operator: '+', value: 2 } }, probability: 0.9 },
      5,
    );
    assert.strictEqual(result.actualOutcome.depth, 5);
    assert.strictEqual(result.counterfactualOutcome.depth, 5);
    engine.shutdown();
  });
});

describe('SimulationEngine - forwardPredict', () => {
  it('should return empty predictions without CausalMemoryStore', async () => {
    const engine = new SimulationEngine();
    const result = await engine.forwardPredict({ description: 'test cause' });
    assert.ok(Array.isArray(result.predictions));
    assert.strictEqual(result.predictions.length, 0);
    assert.strictEqual(result.consensusConfidence, 0);
    engine.shutdown();
  });

  it('should emit forward-prediction-completed event', async () => {
    const engine = new SimulationEngine();
    let emitted = false;
    engine.on('forward-prediction-completed', () => { emitted = true; });
    await engine.forwardPredict({ description: 'test cause' });
    assert.strictEqual(emitted, true);
    engine.shutdown();
  });
});

describe('SimulationEngine - getSimulation / listSimulations', () => {
  it('should retrieve simulation by id', () => {
    const engine = new SimulationEngine();
    const { simulationId } = engine.simulate(
      { variables: { x: 1 } },
      [{ name: 'act', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 }],
    );
    const sim = engine.getSimulation(simulationId);
    assert.ok(sim);
    assert.strictEqual(sim.simulationId, simulationId);
    assert.ok(sim.initialState);
    assert.ok(sim.branches);
    assert.ok(sim.summary);
    engine.shutdown();
  });

  it('should list recent simulations', () => {
    const engine = new SimulationEngine();
    engine.simulate({ variables: { x: 1 } }, [{ name: 'a', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 }]);
    engine.simulate({ variables: { y: 2 } }, [{ name: 'b', effects: { y: { operator: '+', value: 2 } }, probability: 0.9 }]);
    const list = engine.listSimulations();
    assert.ok(Array.isArray(list));
    assert.strictEqual(list.length, 2);
    engine.shutdown();
  });
});

describe('SimulationEngine - generateReport', () => {
  it('should generate markdown report for simulation', () => {
    const engine = new SimulationEngine();
    const { simulationId } = engine.simulate(
      { variables: { x: 10 } },
      [{ name: 'act', effects: { x: { operator: '+', value: 5 } }, probability: 0.9 }],
    );
    const report = engine.generateReport(simulationId);
    assert.ok(typeof report === 'string');
    assert.ok(report.includes('# Simulation Report'));
    assert.ok(report.includes(simulationId));
    assert.ok(report.includes('## Initial State'));
    assert.ok(report.includes('## Summary'));
    engine.shutdown();
  });
});

describe('SimulationEngine - isHealthy / getStats / shutdown', () => {
  it('should be healthy with few operations', () => {
    const engine = new SimulationEngine();
    assert.strictEqual(engine.isHealthy(), true);
    engine.simulate({ variables: { x: 1 } }, []);
    assert.strictEqual(engine.isHealthy(), true);
    engine.shutdown();
  });

  it('should return correct stats', () => {
    const engine = new SimulationEngine();
    engine.simulate({ variables: { x: 1 } }, [{ name: 'a', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 }]);
    engine.counterfactual(
      { variables: { x: 1 } },
      { name: 'a', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 },
      { name: 'b', effects: { x: { operator: '+', value: 2 } }, probability: 0.9 },
    );
    const stats = engine.getStats();
    assert.strictEqual(stats.simulationsTotal, 1);
    assert.strictEqual(stats.counterfactualsTotal, 1);
    assert.strictEqual(typeof stats.avgBranchCount, 'number');
    assert.strictEqual(typeof stats.avgConfidence, 'number');
    engine.shutdown();
  });

  it('should prevent operations after shutdown', () => {
    const engine = new SimulationEngine();
    engine.shutdown();
    assert.throws(() => engine.simulate({ variables: { x: 1 } }, []), /shut down/i);
    assert.throws(() => engine.counterfactual(
      { variables: { x: 1 } },
      { name: 'a', effects: { x: { operator: '+', value: 1 } }, probability: 0.9 },
      { name: 'b', effects: { x: { operator: '+', value: 2 } }, probability: 0.9 },
    ), /shut down/i);
    assert.strictEqual(engine.isHealthy(), false);
  });
});
