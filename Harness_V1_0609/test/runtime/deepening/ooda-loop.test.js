'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const OodaLoop = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'ooda-loop'));

describe('OodaLoop - Constructor', () => {
  it('should create instance with default config', () => {
    const loop = new OodaLoop();
    assert.ok(loop);
    assert.strictEqual(loop._config.maxHistorySize, 200);
    assert.strictEqual(loop._config.autoLoop, false);
    assert.strictEqual(loop._config.threatThreshold, 0.7);
    assert.strictEqual(loop._config.opportunityThreshold, 0.6);
    assert.strictEqual(loop._config.observationWindow, 5);
  });

  it('should merge custom options with defaults', () => {
    const loop = new OodaLoop({ threatThreshold: 0.9, autoLoop: true });
    assert.strictEqual(loop._config.threatThreshold, 0.9);
    assert.strictEqual(loop._config.autoLoop, true);
    assert.strictEqual(loop._config.maxHistorySize, 200);
  });

  it('should initialize decision history and cycle count', () => {
    const loop = new OodaLoop();
    assert.strictEqual(loop._decisionHistory.size, 0);
    assert.strictEqual(loop._cycleCount, 0);
  });

  it('should expose DECISION_MODES static property', () => {
    assert.strictEqual(OodaLoop.DECISION_MODES.REACTIVE, 'reactive');
    assert.strictEqual(OodaLoop.DECISION_MODES.DELIBERATE, 'deliberate');
    assert.strictEqual(OodaLoop.DECISION_MODES.CREATIVE, 'creative');
  });
});

describe('OodaLoop - observe', () => {
  it('should observe with task context', () => {
    const loop = new OodaLoop();
    const obs = loop.observe({ task: 'test' }, null, null);
    assert.ok(obs);
    assert.strictEqual(obs.signals.length, 1);
    assert.strictEqual(obs.signals[0].source, 'task');
    assert.strictEqual(obs.signals[0].weight, 0.4);
    assert.strictEqual(obs.confidence, 0.4);
  });

  it('should observe with agent state', () => {
    const loop = new OodaLoop();
    const obs = loop.observe(null, { status: 'running' }, null);
    assert.strictEqual(obs.signals.length, 1);
    assert.strictEqual(obs.signals[0].source, 'agent');
  });

  it('should observe with environment signals array', () => {
    const loop = new OodaLoop();
    const envSignals = [
      { type: 'alert', data: { risk: true }, weight: 0.5 },
      { type: 'info', data: 'ok', weight: 0.2 },
    ];
    const obs = loop.observe(null, null, envSignals);
    assert.strictEqual(obs.signals.length, 2);
    assert.strictEqual(obs.signals[0].source, 'environment');
  });

  it('should observe with environment signals object', () => {
    const loop = new OodaLoop();
    const obs = loop.observe(null, null, { type: 'signal', data: 'env' });
    assert.strictEqual(obs.signals.length, 1);
    assert.strictEqual(obs.signals[0].source, 'environment');
  });

  it('should handle all null inputs', () => {
    const loop = new OodaLoop();
    const obs = loop.observe(null, null, null);
    assert.strictEqual(obs.signals.length, 0);
    assert.strictEqual(obs.confidence, 0);
  });

  it('should emit ooda-observed event', () => {
    const loop = new OodaLoop();
    let emitted = false;
    loop.on('ooda-observed', () => { emitted = true; });
    loop.observe({ task: 'test' }, null, null);
    assert.strictEqual(emitted, true);
  });
});

describe('OodaLoop - orient', () => {
  it('should orient with threat signals', () => {
    const loop = new OodaLoop();
    const obs = loop.observe(null, null, [{ type: 'alert', data: { error: true, threatLevel: 0.9 }, weight: 0.8 }]);
    const orientation = loop.orient(obs);
    assert.ok(orientation.threatLevel > 0);
    assert.strictEqual(orientation.recommendedFocus, 'threat-mitigation');
  });

  it('should orient with opportunity signals', () => {
    const loop = new OodaLoop({ threatThreshold: 0.99 });
    const obs = loop.observe(null, null, [{ type: 'info', data: { success: true, opportunityLevel: 0.9 }, weight: 0.8 }]);
    const orientation = loop.orient(obs);
    assert.ok(orientation.opportunityLevel > 0);
    assert.strictEqual(orientation.recommendedFocus, 'opportunity-exploitation');
  });

  it('should return gather-more-data for empty observation', () => {
    const loop = new OodaLoop();
    const orientation = loop.orient(null);
    assert.strictEqual(orientation.threatLevel, 0);
    assert.strictEqual(orientation.opportunityLevel, 0);
    assert.strictEqual(orientation.recommendedFocus, 'gather-more-data');
  });

  it('should return gather-more-data for observation with empty signals', () => {
    const loop = new OodaLoop();
    const orientation = loop.orient({ signals: [] });
    assert.strictEqual(orientation.recommendedFocus, 'gather-more-data');
  });

  it('should detect bias after repeated same-mode decisions', () => {
    const loop = new OodaLoop({ observationWindow: 3 });
    for (let i = 0; i < 5; i++) {
      const obs = loop.observe(null, null, [{ type: 'info', data: { success: true }, weight: 0.5 }]);
      const orientation = loop.orient(obs);
      const decision = loop.decide(orientation);
      loop.act(decision, { cycleId: 'cycle-' + i });
    }
    const obs = loop.observe(null, null, [{ type: 'info', data: { success: true }, weight: 0.5 }]);
    const orientation = loop.orient(obs);
    assert.strictEqual(orientation.biasDetected, true);
  });
});

describe('OodaLoop - decide', () => {
  it('should decide reactive for high threat', () => {
    const loop = new OodaLoop();
    const decision = loop.decide({ threatLevel: 0.9, opportunityLevel: 0.1, biasDetected: false });
    assert.strictEqual(decision.mode, 'reactive');
    assert.strictEqual(decision.action, 'respond-immediately');
  });

  it('should decide creative for high opportunity', () => {
    const loop = new OodaLoop();
    const decision = loop.decide({ threatLevel: 0.1, opportunityLevel: 0.8, biasDetected: false });
    assert.strictEqual(decision.mode, 'creative');
    assert.strictEqual(decision.action, 'explore-opportunity');
  });

  it('should decide deliberate for balanced situation', () => {
    const loop = new OodaLoop();
    const decision = loop.decide({ threatLevel: 0.3, opportunityLevel: 0.3, biasDetected: false });
    assert.strictEqual(decision.mode, 'deliberate');
    assert.strictEqual(decision.action, 'analyze-further');
  });

  it('should switch to deliberate when bias detected', () => {
    const loop = new OodaLoop();
    const decision = loop.decide({ threatLevel: 0.9, opportunityLevel: 0.1, biasDetected: true });
    assert.strictEqual(decision.mode, 'deliberate');
    assert.strictEqual(decision.action, 'review-bias');
  });

  it('should handle null orientation', () => {
    const loop = new OodaLoop();
    const decision = loop.decide(null);
    assert.strictEqual(decision.mode, 'deliberate');
    assert.strictEqual(decision.confidence, 0);
  });
});

describe('OodaLoop - act', () => {
  it('should act on a valid decision', () => {
    const loop = new OodaLoop();
    const result = loop.act({ mode: 'deliberate', action: 'analyze', confidence: 0.5 }, { cycleId: 'test-1' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.feedback.actionTaken, 'analyze');
    assert.strictEqual(result.cycleId, 'test-1');
  });

  it('should return failure for null decision', () => {
    const loop = new OodaLoop();
    const result = loop.act(null);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no-decision');
  });

  it('should auto-generate cycleId if not provided', () => {
    const loop = new OodaLoop();
    const result = loop.act({ mode: 'deliberate', action: 'analyze', confidence: 0.5 });
    assert.ok(result.cycleId);
  });

  it('should record decision in history', () => {
    const loop = new OodaLoop();
    loop.act({ mode: 'reactive', action: 'respond', confidence: 0.8 }, { cycleId: 'hist-1' });
    assert.strictEqual(loop._decisionHistory.has('hist-1'), true);
    assert.strictEqual(loop._decisionHistory.get('hist-1').length, 1);
  });

  it('should evict oldest history entry when maxHistorySize exceeded', () => {
    const loop = new OodaLoop({ maxHistorySize: 2 });
    loop.act({ mode: 'deliberate', action: 'a', confidence: 0.5 }, { cycleId: 'c1' });
    loop.act({ mode: 'deliberate', action: 'b', confidence: 0.5 }, { cycleId: 'c2' });
    loop.act({ mode: 'deliberate', action: 'c', confidence: 0.5 }, { cycleId: 'c3' });
    assert.strictEqual(loop._decisionHistory.size, 2);
    assert.strictEqual(loop._decisionHistory.has('c1'), false);
  });
});

describe('OodaLoop - execute', () => {
  it('should run full OODA cycle', () => {
    const loop = new OodaLoop();
    const cycle = loop.execute({
      taskContext: { task: 'deploy' },
      agentState: { status: 'ready' },
      environmentSignals: [],
    });
    assert.ok(cycle.cycleId);
    assert.ok(cycle.observation);
    assert.ok(cycle.orientation);
    assert.ok(cycle.decision);
    assert.ok(cycle.actResult);
    assert.strictEqual(cycle.actResult.success, true);
  });

  it('should increment cycle count', () => {
    const loop = new OodaLoop();
    loop.execute({});
    loop.execute({});
    assert.strictEqual(loop._cycleCount, 2);
  });

  it('should emit ooda-cycle-completed event', () => {
    const loop = new OodaLoop();
    let emitted = false;
    loop.on('ooda-cycle-completed', () => { emitted = true; });
    loop.execute({});
    assert.strictEqual(emitted, true);
  });

  it('should emit auto-loop event when autoLoop is true and threat is high', () => {
    const loop = new OodaLoop({ autoLoop: true, threatThreshold: 0.3 });
    let autoLoopTriggered = false;
    loop.on('ooda-auto-loop-triggered', () => { autoLoopTriggered = true; });
    loop.execute({ taskContext: { threat: true, threatLevel: 0.9 } });
    assert.strictEqual(autoLoopTriggered, true);
  });
});

describe('OodaLoop - getStats', () => {
  it('should return stats with cycle count and history size', () => {
    const loop = new OodaLoop();
    loop.execute({});
    const stats = loop.getStats();
    assert.strictEqual(stats.cycleCount, 1);
    assert.strictEqual(stats.historySize, 1);
    assert.ok(stats.config);
  });

  it('should return zero stats after shutdown', () => {
    const loop = new OodaLoop();
    loop.execute({});
    loop.shutdown();
    const stats = loop.getStats();
    assert.strictEqual(stats.cycleCount, 0);
    assert.strictEqual(stats.historySize, 0);
  });
});

describe('OodaLoop - reset', () => {
  it('should clear history and reset cycle count', () => {
    const loop = new OodaLoop();
    loop.execute({});
    loop.execute({});
    const result = loop.reset();
    assert.strictEqual(result, true);
    assert.strictEqual(loop._decisionHistory.size, 0);
    assert.strictEqual(loop._cycleCount, 0);
  });

  it('should emit ooda-reset event', () => {
    const loop = new OodaLoop();
    let emitted = false;
    loop.on('ooda-reset', () => { emitted = true; });
    loop.reset();
    assert.strictEqual(emitted, true);
  });
});

describe('OodaLoop - shutdown', () => {
  it('should clear state on shutdown', () => {
    const loop = new OodaLoop();
    loop.execute({});
    loop.shutdown();
    assert.strictEqual(loop._shutDown, true);
    assert.strictEqual(loop._decisionHistory.size, 0);
    assert.strictEqual(loop._cycleCount, 0);
  });

  it('should prevent operations after shutdown', () => {
    const loop = new OodaLoop();
    loop.shutdown();
    assert.throws(() => loop.observe({}, null, null), /shut down/i);
  });
});
