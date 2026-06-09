'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillObservability = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-observability'));

describe('SkillObservability - Constructor', () => {
  it('should create instance with default values', () => {
    const obs = new SkillObservability();
    assert.ok(obs);
    assert.strictEqual(Object.keys(obs._modules).length, 0);
    assert.strictEqual(obs._traces.size, 0);
    assert.strictEqual(obs._completedTraces.length, 0);
    assert.strictEqual(obs._alertRules.size, 0);
    assert.strictEqual(obs._activeAlerts.length, 0);
    assert.strictEqual(obs._lastCollection, null);
  });
});

describe('SkillObservability - attachModule', () => {
  it('should attach a module with getStats', () => {
    const obs = new SkillObservability();
    const mod = { getStats: () => ({ count: 5 }) };
    obs.attachModule('router', mod);
    assert.ok(obs._modules.router);
    assert.strictEqual(obs._modules.router, mod);
  });

  it('should reject invalid module name', () => {
    const obs = new SkillObservability();
    const mod = { getStats: () => ({}) };
    obs.attachModule('invalid-name', mod);
    assert.strictEqual(obs._modules['invalid-name'], undefined);
  });

  it('should reject module without getStats', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { noGetStats: true });
    assert.strictEqual(obs._modules.router, undefined);
  });

  it('should reject null module', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', null);
    assert.strictEqual(obs._modules.router, undefined);
  });

  it('should return this for chaining', () => {
    const obs = new SkillObservability();
    const result = obs.attachModule('router', { getStats: () => ({}) });
    assert.strictEqual(result, obs);
  });
});

describe('SkillObservability - collectMetrics / getAggregatedMetrics', () => {
  it('should collect metrics from attached modules', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => ({ skillCount: 10 }) });
    obs.attachModule('curator', { getStats: () => ({ staleCount: 2 }) });
    const snapshot = obs.collectMetrics();
    assert.strictEqual(snapshot.router.skillCount, 10);
    assert.strictEqual(snapshot.curator.staleCount, 2);
  });

  it('should handle module getStats failure gracefully', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => { throw new Error('fail'); } });
    obs.attachModule('curator', { getStats: () => ({ ok: true }) });
    const snapshot = obs.collectMetrics();
    assert.strictEqual(snapshot.router, null);
    assert.deepStrictEqual(snapshot.curator, { ok: true });
  });

  it('should emit metrics-collected event', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => ({ skillCount: 5 }) });
    let eventData = null;
    obs.on('metrics-collected', (data) => { eventData = data; });
    obs.collectMetrics();
    assert.ok(eventData);
    assert.strictEqual(eventData.moduleCount, 1);
    assert.ok(eventData.snapshot);
    assert.strictEqual(eventData.snapshot.router.skillCount, 5);
  });

  it('should return null from getAggregatedMetrics before collection', () => {
    const obs = new SkillObservability();
    assert.strictEqual(obs.getAggregatedMetrics(), null);
  });

  it('should return last collection from getAggregatedMetrics', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => ({ skillCount: 7 }) });
    obs.collectMetrics();
    const aggregated = obs.getAggregatedMetrics();
    assert.ok(aggregated);
    assert.strictEqual(aggregated.router.skillCount, 7);
  });
});

describe('SkillObservability - Tracing', () => {
  it('should start and end a trace', () => {
    const obs = new SkillObservability();
    const traceId = obs.startTrace('brainstorming');
    assert.ok(traceId);
    assert.ok(traceId.startsWith('trc-'));
    assert.strictEqual(obs._traces.size, 1);
    obs.endTrace(traceId, { success: true });
    assert.strictEqual(obs._traces.size, 0);
    assert.strictEqual(obs._completedTraces.length, 1);
  });

  it('should calculate trace duration', () => {
    const obs = new SkillObservability();
    const traceId = obs.startTrace('tdd-implement');
    const trace = obs._traces.get(traceId);
    trace.startTime = Date.now() - 100;
    obs.endTrace(traceId, { ok: true });
    const completed = obs._completedTraces[0];
    assert.ok(completed.duration >= 100);
    assert.strictEqual(completed.result.ok, true);
  });

  it('should emit trace-started and trace-completed events', () => {
    const obs = new SkillObservability();
    const startedEvents = [];
    const completedEvents = [];
    obs.on('trace-started', (data) => startedEvents.push(data));
    obs.on('trace-completed', (data) => completedEvents.push(data));
    const traceId = obs.startTrace('code-review');
    assert.strictEqual(startedEvents.length, 1);
    assert.strictEqual(startedEvents[0].skillId, 'code-review');
    assert.strictEqual(startedEvents[0].traceId, traceId);
    obs.endTrace(traceId);
    assert.strictEqual(completedEvents.length, 1);
    assert.strictEqual(completedEvents[0].skillId, 'code-review');
    assert.strictEqual(typeof completedEvents[0].duration, 'number');
  });

  it('should return null for unknown trace via getTrace', () => {
    const obs = new SkillObservability();
    assert.strictEqual(obs.getTrace('nonexistent'), null);
  });

  it('should return trace from active traces via getTrace', () => {
    const obs = new SkillObservability();
    const traceId = obs.startTrace('brainstorming');
    const trace = obs.getTrace(traceId);
    assert.ok(trace);
    assert.strictEqual(trace.skillId, 'brainstorming');
  });

  it('should return trace from completed traces via getTrace', () => {
    const obs = new SkillObservability();
    const traceId = obs.startTrace('brainstorming');
    obs.endTrace(traceId);
    const trace = obs.getTrace(traceId);
    assert.ok(trace);
    assert.strictEqual(trace.skillId, 'brainstorming');
    assert.strictEqual(typeof trace.duration, 'number');
  });

  it('should enforce max active traces limit', () => {
    const obs = new SkillObservability();
    const traceIds = [];
    for (let i = 0; i < 205; i++) {
      traceIds.push(obs.startTrace('skill-' + i));
    }
    assert.strictEqual(obs._traces.size, 200);
    assert.ok(obs._completedTraces.length > 0);
  });

  it('should return empty string for invalid skillId in startTrace', () => {
    const obs = new SkillObservability();
    assert.strictEqual(obs.startTrace(''), '');
    assert.strictEqual(obs.startTrace(null), '');
    assert.strictEqual(obs.startTrace(123), '');
  });

  it('should ignore endTrace for unknown traceId', () => {
    const obs = new SkillObservability();
    obs.endTrace('unknown-trace');
    assert.strictEqual(obs._completedTraces.length, 0);
  });

  it('should get active traces', () => {
    const obs = new SkillObservability();
    obs.startTrace('skill-a');
    obs.startTrace('skill-b');
    const active = obs.getActiveTraces();
    assert.strictEqual(active.length, 2);
  });

  it('should get recent completed traces', () => {
    const obs = new SkillObservability();
    const id1 = obs.startTrace('skill-a');
    obs.endTrace(id1);
    const id2 = obs.startTrace('skill-b');
    obs.endTrace(id2);
    const recent = obs.getRecentTraces(1);
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].skillId, 'skill-b');
  });
});

describe('SkillObservability - Health Dashboard', () => {
  it('should return dashboard with module health status', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', {
      getStats: () => ({ skillCount: 10 }),
      isHealthy: () => true,
    });
    obs.attachModule('curator', {
      getStats: () => ({ staleCount: 2 }),
      isHealthy: () => false,
    });
    obs.collectMetrics();
    const dashboard = obs.getHealthDashboard();
    assert.strictEqual(dashboard.healthy, true);
    assert.strictEqual(dashboard.moduleHealth.router, true);
    assert.strictEqual(dashboard.moduleHealth.curator, false);
    assert.strictEqual(typeof dashboard.activeTraces, 'number');
    assert.strictEqual(typeof dashboard.completedTraces, 'number');
  });

  it('should include skill counts from router stats', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', {
      getStats: () => ({ skillCount: 15, l2HitRate: 0.85 }),
    });
    obs.attachModule('curator', {
      getStats: () => ({ staleCount: 3 }),
    });
    obs.collectMetrics();
    const dashboard = obs.getHealthDashboard();
    assert.strictEqual(dashboard.skills.total, 15);
    assert.strictEqual(dashboard.skills.stale, 3);
    assert.strictEqual(dashboard.skills.active, 12);
    assert.strictEqual(dashboard.cacheHitRate, 0.85);
  });

  it('should include recent errors from completed traces', () => {
    const obs = new SkillObservability();
    const traceId = obs.startTrace('failing-skill');
    obs.endTrace(traceId, { error: 'something went wrong' });
    const dashboard = obs.getHealthDashboard();
    assert.strictEqual(dashboard.recentErrors.length, 1);
    assert.strictEqual(dashboard.recentErrors[0].skillId, 'failing-skill');
    assert.strictEqual(dashboard.recentErrors[0].error, 'something went wrong');
  });

  it('should handle module health check failure gracefully', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', {
      getStats: () => ({}),
      isHealthy: () => { throw new Error('health check fail'); },
    });
    const dashboard = obs.getHealthDashboard();
    assert.strictEqual(dashboard.moduleHealth.router, true);
  });
});

describe('SkillObservability - Alert Rules', () => {
  it('should add and remove alert rules', () => {
    const obs = new SkillObservability();
    obs.addAlertRule({
      name: 'high-error-rate',
      condition: (m) => m.router && m.router.errorRate > 0.5,
      severity: 'warning',
    });
    assert.strictEqual(obs._alertRules.size, 1);
    obs.removeAlertRule('high-error-rate');
    assert.strictEqual(obs._alertRules.size, 0);
  });

  it('should evaluate alerts and trigger/clear events', () => {
    const obs = new SkillObservability();
    const triggeredEvents = [];
    const clearedEvents = [];
    obs.on('alert-triggered', (data) => triggeredEvents.push(data));
    obs.on('alert-cleared', (data) => clearedEvents.push(data));

    obs.addAlertRule({
      name: 'stale-skills',
      condition: (m) => m.curator && m.curator.staleCount > 5,
      severity: 'critical',
    });

    obs.attachModule('curator', { getStats: () => ({ staleCount: 10 }) });
    obs.collectMetrics();
    const alerts = obs.evaluateAlerts();
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].name, 'stale-skills');
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(triggeredEvents.length, 1);
    assert.strictEqual(triggeredEvents[0].name, 'stale-skills');

    obs.attachModule('curator', { getStats: () => ({ staleCount: 1 }) });
    obs.collectMetrics();
    const alertsAfter = obs.evaluateAlerts();
    assert.strictEqual(alertsAfter.length, 0);
    assert.strictEqual(clearedEvents.length, 1);
    assert.strictEqual(clearedEvents[0].name, 'stale-skills');
  });

  it('should reject invalid severity', () => {
    const obs = new SkillObservability();
    obs.addAlertRule({
      name: 'bad-severity',
      condition: () => true,
      severity: 'invalid',
    });
    assert.strictEqual(obs._alertRules.size, 0);
  });

  it('should reject rule without name', () => {
    const obs = new SkillObservability();
    obs.addAlertRule({
      condition: () => true,
      severity: 'warning',
    });
    assert.strictEqual(obs._alertRules.size, 0);
  });

  it('should reject rule without condition function', () => {
    const obs = new SkillObservability();
    obs.addAlertRule({
      name: 'no-condition',
      severity: 'warning',
    });
    assert.strictEqual(obs._alertRules.size, 0);
  });

  it('should reject null rule', () => {
    const obs = new SkillObservability();
    obs.addAlertRule(null);
    assert.strictEqual(obs._alertRules.size, 0);
  });

  it('should emit alert-cleared when removing active alert rule', () => {
    const obs = new SkillObservability();
    const clearedEvents = [];
    obs.on('alert-cleared', (data) => clearedEvents.push(data));

    obs.addAlertRule({
      name: 'test-alert',
      condition: () => true,
      severity: 'warning',
    });

    obs.attachModule('router', { getStats: () => ({}) });
    obs.collectMetrics();
    obs.evaluateAlerts();
    assert.strictEqual(obs._activeAlerts.length, 1);

    obs.removeAlertRule('test-alert');
    assert.strictEqual(clearedEvents.length, 1);
    assert.strictEqual(clearedEvents[0].name, 'test-alert');
  });

  it('should get active alerts', () => {
    const obs = new SkillObservability();
    obs.addAlertRule({
      name: 'active-test',
      condition: () => true,
      severity: 'warning',
    });
    obs.attachModule('router', { getStats: () => ({}) });
    obs.collectMetrics();
    obs.evaluateAlerts();
    const active = obs.getActiveAlerts();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].name, 'active-test');
  });

  it('should handle condition function throwing error', () => {
    const obs = new SkillObservability();
    obs.addAlertRule({
      name: 'throwing-condition',
      condition: () => { throw new Error('condition fail'); },
      severity: 'warning',
    });
    obs.attachModule('router', { getStats: () => ({}) });
    obs.collectMetrics();
    const alerts = obs.evaluateAlerts();
    assert.strictEqual(alerts.length, 0);
  });
});

describe('SkillObservability - isHealthy / getStats / shutdown', () => {
  it('should be healthy with few active traces', () => {
    const obs = new SkillObservability();
    obs.startTrace('skill-a');
    assert.strictEqual(obs.isHealthy(), true);
  });

  it('should return correct stats', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => ({}) });
    obs.attachModule('curator', { getStats: () => ({}) });
    obs.startTrace('skill-a');
    obs.addAlertRule({ name: 'test', condition: () => true, severity: 'warning' });
    const stats = obs.getStats();
    assert.strictEqual(stats.modulesAttached, 2);
    assert.strictEqual(stats.activeTraces, 1);
    assert.strictEqual(stats.completedTraces, 0);
    assert.strictEqual(stats.alertRules, 1);
    assert.strictEqual(stats.activeAlerts, 0);
  });

  it('should flush active traces on shutdown', () => {
    const obs = new SkillObservability();
    obs.startTrace('skill-a');
    obs.startTrace('skill-b');
    assert.strictEqual(obs._traces.size, 2);
    obs.shutdown();
    assert.strictEqual(obs._traces.size, 0);
    assert.strictEqual(obs._completedTraces.length, 2);
  });

  it('should clear modules and alerts on shutdown', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => ({}) });
    obs.addAlertRule({ name: 'test', condition: () => true, severity: 'warning' });
    obs.shutdown();
    assert.strictEqual(Object.keys(obs._modules).length, 0);
    assert.strictEqual(obs._alertRules.size, 0);
    assert.strictEqual(obs._activeAlerts.length, 0);
    assert.strictEqual(obs._lastCollection, null);
  });

  it('should prevent collectMetrics after shutdown', () => {
    const obs = new SkillObservability();
    obs.attachModule('router', { getStats: () => ({}) });
    obs.shutdown();
    assert.throws(() => obs.collectMetrics(), /shut down/i);
  });

  it('should prevent startTrace after shutdown', () => {
    const obs = new SkillObservability();
    obs.shutdown();
    assert.throws(() => obs.startTrace('skill-a'), /shut down/i);
  });

  it('should prevent getHealthDashboard after shutdown', () => {
    const obs = new SkillObservability();
    obs.shutdown();
    assert.throws(() => obs.getHealthDashboard(), /shut down/i);
  });

  it('should prevent evaluateAlerts after shutdown', () => {
    const obs = new SkillObservability();
    obs.shutdown();
    assert.throws(() => obs.evaluateAlerts(), /shut down/i);
  });
});
