'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const TriggerDispatcher = require('../../../src/runtime/workflow/trigger-dispatcher');

describe('TriggerDispatcher - Static Constants', () => {
  it('should expose TRIGGER_TYPES', () => {
    assert.ok(TriggerDispatcher.TRIGGER_TYPES);
    assert.equal(TriggerDispatcher.TRIGGER_TYPES.EVENT, 'event');
    assert.equal(TriggerDispatcher.TRIGGER_TYPES.SCHEDULE, 'schedule');
    assert.equal(TriggerDispatcher.TRIGGER_TYPES.WEBHOOK, 'webhook');
    assert.equal(TriggerDispatcher.TRIGGER_TYPES.FIRE_AND_FORGET, 'fire-and-forget');
  });

  it('should expose SCHEDULE_TYPES', () => {
    assert.ok(TriggerDispatcher.SCHEDULE_TYPES);
    assert.equal(TriggerDispatcher.SCHEDULE_TYPES.INTERVAL, 'interval');
    assert.equal(TriggerDispatcher.SCHEDULE_TYPES.CRON, 'cron');
  });

  it('should expose parseCronExpression', () => {
    assert.equal(typeof TriggerDispatcher.parseCronExpression, 'function');
  });
});

describe('parseCronExpression', () => {
  const parse = TriggerDispatcher.parseCronExpression;

  it('should parse wildcard * * * * *', () => {
    const matcher = parse('* * * * *');
    assert.equal(matcher(new Date()), true);
  });

  it('should parse specific minute: 30 * * * *', () => {
    const matcher = parse('30 * * * *');
    const d1 = new Date(2024, 0, 1, 10, 30, 0);
    const d2 = new Date(2024, 0, 1, 10, 15, 0);
    assert.equal(matcher(d1), true);
    assert.equal(matcher(d2), false);
  });

  it('should parse step: */15 * * * *', () => {
    const matcher = parse('*/15 * * * *');
    assert.equal(matcher(new Date(2024, 0, 1, 10, 0, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 15, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 30, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 7, 0)), false);
  });

  it('should parse range: 9-17 * * * *', () => {
    const matcher = parse('0 9-17 * * *');
    assert.equal(matcher(new Date(2024, 0, 1, 9, 0, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 17, 0, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 12, 0, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 8, 0, 0)), false);
    assert.equal(matcher(new Date(2024, 0, 1, 18, 0, 0)), false);
  });

  it('should parse list: 0,15,30,45 * * * *', () => {
    const matcher = parse('0,15,30,45 * * * *');
    assert.equal(matcher(new Date(2024, 0, 1, 10, 0, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 15, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 7, 0)), false);
  });

  it('should parse range with step: 0-30/10 * * * *', () => {
    const matcher = parse('0-30/10 * * * *');
    assert.equal(matcher(new Date(2024, 0, 1, 10, 0, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 10, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 20, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 30, 0)), true);
    assert.equal(matcher(new Date(2024, 0, 1, 10, 40, 0)), false);
  });

  it('should throw on invalid expression', () => {
    assert.throws(() => parse(''), /Invalid cron expression/);
    assert.throws(() => parse(null), /Invalid cron expression/);
    assert.throws(() => parse('* * *'), /must have 5 fields/);
    assert.throws(() => parse('60 * * * *'), /Invalid value/);
  });

  it('should throw on out of range values', () => {
    assert.throws(() => parse('0 25 * * *'), /Invalid value|Range out of bounds/);
    assert.throws(() => parse('0 0 32 * *'), /Invalid value|Range out of bounds/);
  });
});

describe('TriggerDispatcher - Schedule Registration', () => {
  let dispatcher;

  before(() => {
    dispatcher = new TriggerDispatcher();
  });

  after(() => {
    try { dispatcher.shutdown(); } catch (_e) { /* best effort */ }
  });

  it('should register an interval schedule', () => {
    const result = dispatcher.registerSchedule('agent-1', {
      type: 'interval',
      intervalMs: 60000,
    });
    assert.ok(result.scheduleId);
    assert.equal(result.type, 'interval');
    assert.equal(result.agentId, 'agent-1');
  });

  it('should register a cron schedule', () => {
    const result = dispatcher.registerSchedule('agent-2', {
      type: 'cron',
      cron: '*/5 * * * *',
    });
    assert.ok(result.scheduleId);
    assert.equal(result.type, 'cron');
    assert.equal(result.agentId, 'agent-2');
  });

  it('should throw on missing agentId', () => {
    assert.throws(() => {
      dispatcher.registerSchedule('', { type: 'interval', intervalMs: 1000 });
    }, /must be a non-empty string/);
  });

  it('should throw on missing config.type', () => {
    assert.throws(() => {
      dispatcher.registerSchedule('agent-3', {});
    }, /config\.type is required/);
  });

  it('should throw on invalid schedule type', () => {
    assert.throws(() => {
      dispatcher.registerSchedule('agent-3', { type: 'invalid' });
    }, /unknown schedule type/);
  });

  it('should throw on missing intervalMs for interval type', () => {
    assert.throws(() => {
      dispatcher.registerSchedule('agent-3', { type: 'interval' });
    }, /intervalMs must be.*positive/);
  });

  it('should throw on missing cron for cron type', () => {
    assert.throws(() => {
      dispatcher.registerSchedule('agent-3', { type: 'cron' });
    }, /cron expression is required/);
  });

  it('should unregister a schedule', () => {
    const { scheduleId } = dispatcher.registerSchedule('agent-4', {
      type: 'interval',
      intervalMs: 30000,
    });
    const ok = dispatcher.unregisterSchedule(scheduleId);
    assert.equal(ok, true);
  });

  it('should return false for unregistering non-existent schedule', () => {
    const ok = dispatcher.unregisterSchedule('non-existent');
    assert.equal(ok, false);
  });

  it('should list schedules', () => {
    const list = dispatcher.listSchedules();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1); // agent-1 and agent-2 still registered
  });
});

describe('TriggerDispatcher - Webhook Routes', () => {
  let dispatcher;

  before(() => {
    dispatcher = new TriggerDispatcher();
  });

  after(() => {
    try { dispatcher.shutdown(); } catch (_e) { /* best effort */ }
  });

  it('should register a webhook route', () => {
    const result = dispatcher.registerWebhook('/github/push', 'agent-1');
    assert.equal(result.path, '/github/push');
    assert.equal(result.agentId, 'agent-1');
  });

  it('should throw on missing path', () => {
    assert.throws(() => {
      dispatcher.registerWebhook('', 'agent-1');
    }, /must be a non-empty string/);
  });

  it('should throw on missing agentId', () => {
    assert.throws(() => {
      dispatcher.registerWebhook('/test', '');
    }, /must be a non-empty string/);
  });

  it('should unregister a webhook route', () => {
    dispatcher.registerWebhook('/slack/event', 'agent-2');
    const ok = dispatcher.unregisterWebhook('/slack/event');
    assert.equal(ok, true);
    const ok2 = dispatcher.unregisterWebhook('/slack/event');
    assert.equal(ok2, false);
  });

  it('should list webhook routes', () => {
    const routes = dispatcher.listWebhookRoutes();
    assert.ok(Array.isArray(routes));
    assert.ok(routes.length >= 1);
  });
});

describe('TriggerDispatcher - Event Subscriptions', () => {
  let dispatcher;

  before(() => {
    dispatcher = new TriggerDispatcher();
  });

  after(() => {
    try { dispatcher.shutdown(); } catch (_e) { /* best effort */ }
  });

  it('should register an event subscription', () => {
    const result = dispatcher.registerEventSubscription('bug:detected', 'agent-1');
    assert.equal(result.eventType, 'bug:detected');
    assert.equal(result.agentId, 'agent-1');
  });

  it('should throw on missing eventType', () => {
    assert.throws(() => {
      dispatcher.registerEventSubscription('', 'agent-1');
    }, /must be a non-empty string/);
  });

  it('should unregister an event subscription', () => {
    dispatcher.registerEventSubscription('deploy:completed', 'agent-2');
    const ok = dispatcher.unregisterEventSubscription('deploy:completed', 'agent-2');
    assert.equal(ok, true);
    const ok2 = dispatcher.unregisterEventSubscription('deploy:completed', 'agent-2');
    assert.equal(ok2, false);
  });

  it('should allow multiple agents to subscribe to same event', () => {
    dispatcher.registerEventSubscription('test:event', 'agent-a');
    dispatcher.registerEventSubscription('test:event', 'agent-b');
    // Both should be subscribed
    const stats = dispatcher.getStats();
    assert.ok(stats.eventSubscriptionCount >= 2);
  });
});

describe('TriggerDispatcher - Webhook Dispatch', () => {
  let dispatcher;

  before(() => {
    dispatcher = new TriggerDispatcher();
  });

  after(() => {
    try { dispatcher.shutdown(); } catch (_e) { /* best effort */ }
  });

  it('should return no_route for unregistered webhook path', async () => {
    const result = await dispatcher.dispatchWebhook('/unknown', {}, null);
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'no_route');
  });

  it('should return no_host when no ManagedAgentHost attached', async () => {
    dispatcher.registerWebhook('/test/dispatch', 'agent-1');
    const result = await dispatcher.dispatchWebhook('/test/dispatch', { data: 'test' }, null);
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'no_host');
  });

  it('should dispatch to ManagedAgentHost when attached', async () => {
    const mockHost = {
      handleWebhook: async (_path, _payload, _signature) => ({
        status: 'completed',
        agentId: 'agent-1',
      }),
    };
    dispatcher.attachManagedHost(mockHost);
    dispatcher.registerWebhook('/test/with-host', 'agent-1');

    const result = await dispatcher.dispatchWebhook('/test/with-host', { test: true }, null);
    assert.equal(result.dispatched, true);
    assert.equal(result.agentId, 'agent-1');
  });
});

describe('TriggerDispatcher - Fire and Forget', () => {
  let dispatcher;

  before(() => {
    dispatcher = new TriggerDispatcher();
  });

  after(() => {
    try { dispatcher.shutdown(); } catch (_e) { /* best effort */ }
  });

  it('should return no_host when no ManagedAgentHost attached', async () => {
    const result = await dispatcher.dispatchFireAndForget('agent-1', { task: 'test' });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'no_host');
  });

  it('should dispatch fire-and-forget to ManagedAgentHost', async () => {
    const mockHost = {
      triggerExecution: async (agentId, ctx) => ({
        status: 'completed',
        agentId,
        triggerSource: ctx.triggerSource,
      }),
    };
    dispatcher.attachManagedHost(mockHost);

    const result = await dispatcher.dispatchFireAndForget('agent-1', { task: 'test' });
    assert.equal(result.dispatched, true);
    assert.equal(result.agentId, 'agent-1');
  });
});

describe('TriggerDispatcher - Stats', () => {
  it('should return stats', () => {
    const d = new TriggerDispatcher();
    d.registerSchedule('agent-1', { type: 'interval', intervalMs: 10000 });
    d.registerWebhook('/stats/test', 'agent-1');
    d.registerEventSubscription('stats:event', 'agent-1');

    const stats = d.getStats();
    assert.ok(stats.scheduleCount >= 1);
    assert.ok(stats.webhookRouteCount >= 1);
    assert.ok(stats.eventSubscriptionCount >= 1);
    assert.equal(typeof stats.cronTimerRunning, 'boolean');

    try { d.shutdown(); } catch (_e) { /* best effort */ }
  });
});

describe('TriggerDispatcher - Shutdown', () => {
  it('should clean up on shutdown', () => {
    const d = new TriggerDispatcher();
    d.registerSchedule('agent-1', { type: 'interval', intervalMs: 10000 });
    d.registerWebhook('/shutdown/test', 'agent-1');
    d.registerEventSubscription('shutdown:event', 'agent-1');

    d.shutdown();
    assert.equal(d._shutDown, true);
    assert.equal(d._schedules.size, 0);
    assert.equal(d._webhookRoutes.size, 0);
  });

  it('should throw on register after shutdown', () => {
    const d = new TriggerDispatcher();
    d.shutdown();
    assert.throws(() => {
      d.registerSchedule('agent-1', { type: 'interval', intervalMs: 1000 });
    }, /shut down/);
  });
});
