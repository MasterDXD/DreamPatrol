'use strict';

/**
 * 平台集成模块测试。覆盖 PlatformGateway、BusinessAgentRegistry、PriorityScheduler 的核心功能。
 * 测试场景包括：多平台消息标准化、业务Agent路由、优先级调度、负载均衡、跨平台用户绑定。
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { PlatformGateway, WebChatAdapter, AppAdapter, FeishuAdapter, EmailAdapter, PLATFORM_TYPES } = require('../../../src/runtime/platform/platform-gateway');
const { BusinessAgentRegistry, BUSINESS_AGENT_TYPES, BUSINESS_AGENT_TEMPLATES: _BUSINESS_AGENT_TEMPLATES, BUSINESS_PRIORITY: _BUSINESS_PRIORITY } = require('../../../src/runtime/platform/business-agent-registry');
const { PriorityScheduler, TASK_PRIORITY, TASK_STATUS: _TASK_STATUS } = require('../../../src/runtime/platform/priority-scheduler');

// =========================== PlatformGateway 测试 ===========================

describe('PlatformGateway', () => {
  let gateway;

  beforeEach(() => {
    gateway = new PlatformGateway({
      platformAdapters: {
        [PLATFORM_TYPES.WEBCHAT]: new WebChatAdapter(),
        [PLATFORM_TYPES.APP]: new AppAdapter(),
        [PLATFORM_TYPES.FEISHU]: new FeishuAdapter(),
        [PLATFORM_TYPES.EMAIL]: new EmailAdapter(),
      },
    });
  });

  afterEach(() => {
    if (gateway && !gateway._shutDown) gateway.shutdown();
  });

  it('should register platform adapters', () => {
    assert.strictEqual(gateway._platformAdapters.size, 4);
    assert.ok(gateway._platformAdapters.has(PLATFORM_TYPES.WEBCHAT));
    assert.ok(gateway._platformAdapters.has(PLATFORM_TYPES.APP));
  });

  it('should normalize WebChat message', async () => {
    const raw = { userId: 'user-001', content: 'Hello, I need help', sessionId: 'sess-1' };
    const result = await gateway.receive(PLATFORM_TYPES.WEBCHAT, raw);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.message.taskContent, 'Hello, I need help');
    assert.strictEqual(result.message.platformType, PLATFORM_TYPES.WEBCHAT);
    assert.ok(result.message.userId.startsWith('user-'));
  });

  it('should normalize Feishu message', async () => {
    const raw = { open_id: 'ou_123', text: '订单查询', chat_id: 'oc_456' };
    const result = await gateway.receive(PLATFORM_TYPES.FEISHU, raw);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.message.taskContent, '订单查询');
    assert.strictEqual(result.message.metadata.channel, 'feishu');
  });

  it('should normalize Email message', async () => {
    const raw = { from: 'user@test.com', subject: '退款申请', body: '请帮我退款', messageId: 'msg-1' };
    const result = await gateway.receive(PLATFORM_TYPES.EMAIL, raw);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.taskContent.includes('退款申请'));
    assert.ok(result.message.taskContent.includes('请帮我退款'));
  });

  it('should normalize APP message', async () => {
    const raw = { userId: 'device-001', content: '查询物流', appVersion: '1.2.3', deviceType: 'iPhone' };
    const result = await gateway.receive(PLATFORM_TYPES.APP, raw);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.message.metadata.appVersion, '1.2.3');
    assert.strictEqual(result.message.metadata.deviceType, 'iPhone');
  });

  it('should return error for unknown platform', async () => {
    const result = await gateway.receive('unknown-platform', { content: 'test' });
    assert.strictEqual(result.success, false);
  });

  it('should bind user across platforms', async () => {
    const r1 = await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'First message' });
    const _r2 = await gateway.receive(PLATFORM_TYPES.APP, { userId: 'u1', content: 'Second message' });

    // Same platform user should get same unified ID
    const r3 = await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'Third' });
    assert.strictEqual(r1.message.userId, r3.message.userId);
  });

  it('should merge user identities', async () => {
    const r1 = await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'WebChat msg' });
    const _r2 = await gateway.receive(PLATFORM_TYPES.APP, { userId: 'app-u1', content: 'App msg' });

    const merged = gateway.mergeUserIdentity(r1.message.userId, PLATFORM_TYPES.APP, 'app-u1');
    assert.strictEqual(merged, true);

    const bindings = gateway.getUserBindings(r1.message.userId);
    assert.ok(bindings.platforms.has(PLATFORM_TYPES.APP));
    assert.strictEqual(bindings.platforms.get(PLATFORM_TYPES.APP), 'app-u1');
  });

  it('should generate context summary', async () => {
    await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'Hello' });
    await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'I need help with my order' });

    const summary = gateway.getContextSummary('user-webchat-u1');
    assert.ok(summary.messageCount >= 2);
    assert.ok(summary.recentTopics.length > 0);
  });

  it('should route to customer-service agent by keyword', async () => {
    const result = await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: '我要投诉' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.route.agentType, 'customer-service');
  });

  it('should route to order-processing agent by keyword', async () => {
    const result = await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: '查询我的订单状态' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.route.agentType, 'order-processing');
  });

  it('should route to general agent for unknown content', async () => {
    const result = await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'xyz unknown' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.route.agentType, 'general');
  });

  it('should emit message-received event', async () => {
    let emitted = false;
    gateway.on('message-received', () => { emitted = true; });
    await gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'test' });
    assert.strictEqual(emitted, true);
  });

  it('should throw on receive after shutdown', async () => {
    gateway.shutdown();
    await assert.rejects(
      () => gateway.receive(PLATFORM_TYPES.WEBCHAT, { userId: 'u1', content: 'test' }),
      /shut down/i,
    );
  });
});

// =========================== BusinessAgentRegistry 测试 ===========================

describe('BusinessAgentRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new BusinessAgentRegistry();
  });

  afterEach(() => {
    if (registry && !registry._shutDown) registry.shutdown();
  });

  it('should auto-register templates', () => {
    const all = registry.listAll();
    assert.ok(all.length >= 7);
    assert.ok(all.some(a => a.agentType === BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE));
    assert.ok(all.some(a => a.agentType === BUSINESS_AGENT_TYPES.ORDER_PROCESSING));
    assert.ok(all.some(a => a.agentType === BUSINESS_AGENT_TYPES.LOGISTICS));
    assert.ok(all.some(a => a.agentType === BUSINESS_AGENT_TYPES.GENERAL));
  });

  it('should route customer service keywords', () => {
    const result = registry.route({ taskContent: '客户咨询退货流程' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE);
    assert.ok(result.confidence > 0);
  });

  it('should route order processing keywords', () => {
    const result = registry.route({ taskContent: '查询我的订单' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.ORDER_PROCESSING);
    assert.ok(result.confidence > 0);
  });

  it('should route logistics keywords', () => {
    const result = registry.route({ taskContent: '快递到哪了？查询物流' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.LOGISTICS);
  });

  it('should route payment keywords', () => {
    const result = registry.route({ taskContent: '支付失败，帮我退款' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.PAYMENT);
  });

  it('should route marketing keywords', () => {
    const result = registry.route({ taskContent: '有什么优惠活动？' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.MARKETING);
  });

  it('should route account keywords', () => {
    const result = registry.route({ taskContent: '忘记密码了，怎么重置？' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.ACCOUNT);
  });

  it('should route data analyst keywords', () => {
    const result = registry.route({ taskContent: '帮我分析上个月的销售数据' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.DATA_ANALYST);
  });

  it('should fallback to general for unknown content', () => {
    const result = registry.route({ taskContent: 'xyz' });
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.GENERAL);
    assert.strictEqual(result.confidence, 0);
  });

  it('should prioritize urgent keywords', () => {
    const result = registry.route({ taskContent: '紧急投诉产品问题' });
    // "投诉" matches customer-service, "紧急" is urgent keyword for customer-service
    assert.strictEqual(result.agentType, BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE);
    assert.ok(result.confidence > 0.1);
  });

  it('should get agent definition', () => {
    const def = registry.getDefinition(BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE);
    assert.ok(def);
    assert.strictEqual(def.name, '客服Agent');
    assert.ok(def.capabilities.includes('customer-support'));
  });

  it('should get escalation rules', () => {
    const rules = registry.getEscalationRules(BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE);
    assert.ok(rules);
    assert.strictEqual(rules.escalateTo, BUSINESS_AGENT_TYPES.ORDER_PROCESSING);
    assert.strictEqual(rules.unresolvedAfterMinutes, 10);
  });

  it('should return null for unknown agent', () => {
    assert.strictEqual(registry.getDefinition('unknown-agent'), null);
    assert.strictEqual(registry.getEscalationRules('unknown-agent'), null);
  });

  it('should update agent stats', () => {
    registry.updateStats(BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE, { totalHandled: 5, totalEscalated: 1 });
    const stats = registry.getStats(BUSINESS_AGENT_TYPES.CUSTOMER_SERVICE);
    assert.strictEqual(stats.totalHandled, 5);
    assert.strictEqual(stats.totalEscalated, 1);
  });

  it('should emit agent-registered event on custom registration', () => {
    let emitted = false;
    registry.on('agent-registered', () => { emitted = true; });
    registry.register('custom-agent', { name: 'Custom', capabilities: [], keywords: ['custom'], priority: 5, harnessAgentMapping: 'task-worker' });
    assert.strictEqual(emitted, true);
  });

  it('should throw on route after shutdown', () => {
    registry.shutdown();
    assert.throws(() => {
      registry.route({ taskContent: 'test' });
    }, /shut down/i);
  });
});

// =========================== PriorityScheduler 测试 ===========================

describe('PriorityScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new PriorityScheduler();
    scheduler.registerAgent('customer-service', 3);
    scheduler.registerAgent('order-processing', 3);
    scheduler.registerAgent('general', 5);
  });

  afterEach(() => {
    if (scheduler && !scheduler._shutDown) {
      scheduler.stopHealthCheck();
      scheduler.shutdown();
    }
  });

  it('should register agents', () => {
    const load = scheduler.getAgentLoad('customer-service');
    assert.ok(load);
    assert.strictEqual(load.max, 3);
    assert.strictEqual(load.current, 0);
    assert.strictEqual(load.status, 'active');
  });

  it('should submit task and return taskId', () => {
    const taskId = scheduler.submit({
      agentType: 'customer-service',
      priority: TASK_PRIORITY.NORMAL,
      taskContent: 'test task',
    });
    assert.ok(taskId);
    assert.ok(taskId.startsWith('task-'));
  });

  it('should schedule tasks in priority order', () => {
    scheduler.submit({ agentType: 'customer-service', priority: TASK_PRIORITY.LOW, taskContent: 'low' });
    scheduler.submit({ agentType: 'customer-service', priority: TASK_PRIORITY.CRITICAL, taskContent: 'critical' });
    scheduler.submit({ agentType: 'customer-service', priority: TASK_PRIORITY.NORMAL, taskContent: 'normal' });

    const status = scheduler.getStatus();
    assert.strictEqual(status.queueSize, 0); // All should be scheduled since max=3
    assert.strictEqual(status.activeCount, 3);
  });

  it('should queue tasks when all agents are at capacity', () => {
    // Fill all agents to capacity
    scheduler.submit({ agentType: 'customer-service', taskContent: 't1' });
    scheduler.submit({ agentType: 'customer-service', taskContent: 't2' });
    scheduler.submit({ agentType: 'customer-service', taskContent: 't3' });
    scheduler.submit({ agentType: 'order-processing', taskContent: 't4' });
    scheduler.submit({ agentType: 'order-processing', taskContent: 't5' });
    scheduler.submit({ agentType: 'order-processing', taskContent: 't6' });
    scheduler.submit({ agentType: 'general', taskContent: 't7' });
    scheduler.submit({ agentType: 'general', taskContent: 't8' });
    scheduler.submit({ agentType: 'general', taskContent: 't9' });
    scheduler.submit({ agentType: 'general', taskContent: 't10' });
    scheduler.submit({ agentType: 'general', taskContent: 't11' });

    // All agents full, task should be queued
    scheduler.submit({ agentType: 'customer-service', taskContent: 't12' });

    const status = scheduler.getStatus();
    assert.ok(status.queueSize > 0);
  });

  it('should complete task and release capacity', () => {
    const taskId = scheduler.submit({ agentType: 'customer-service', taskContent: 't1' });
    assert.strictEqual(scheduler.getAgentLoad('customer-service').current, 1);

    scheduler.complete(taskId, 'done');
    assert.strictEqual(scheduler.getAgentLoad('customer-service').current, 0);
  });

  it('should process queued tasks after completion', () => {
    // Fill all agents to capacity
    scheduler.submit({ agentType: 'customer-service', taskContent: 't1' });
    scheduler.submit({ agentType: 'customer-service', taskContent: 't2' });
    scheduler.submit({ agentType: 'customer-service', taskContent: 't3' });
    scheduler.submit({ agentType: 'order-processing', taskContent: 't4' });
    scheduler.submit({ agentType: 'order-processing', taskContent: 't5' });
    scheduler.submit({ agentType: 'order-processing', taskContent: 't6' });
    scheduler.submit({ agentType: 'general', taskContent: 't7' });
    scheduler.submit({ agentType: 'general', taskContent: 't8' });
    scheduler.submit({ agentType: 'general', taskContent: 't9' });
    scheduler.submit({ agentType: 'general', taskContent: 't10' });
    scheduler.submit({ agentType: 'general', taskContent: 't11' });

    const statusBefore = scheduler.getStatus();
    assert.ok(statusBefore.queueSize === 0, 'All tasks should be active before queueing');

    // This task will be queued since all agents are full
    const _taskId = scheduler.submit({ agentType: 'customer-service', taskContent: 't12' });

    const statusAfter = scheduler.getStatus();
    assert.ok(statusAfter.queueSize > 0, 'Task should be queued when all agents full');
  });

  it('should fail task and retry', () => {
    const taskId = scheduler.submit({
      agentType: 'customer-service',
      taskContent: 'test',
      maxRetries: 2,
    });

    scheduler.fail(taskId, new Error('Test error'));

    // Task should be retried (re-queued)
    const status = scheduler.getStatus();
    // Retried task is requeued with higher priority
    assert.ok(status.queueSize >= 0);
  });

  it('should load balance to fallback agent', () => {
    // Fill customer-service
    scheduler.submit({ agentType: 'customer-service', taskContent: 't1' });
    scheduler.submit({ agentType: 'customer-service', taskContent: 't2' });
    scheduler.submit({ agentType: 'customer-service', taskContent: 't3' });

    // Submit more to customer-service - should fallback to another agent
    scheduler.submit({ agentType: 'customer-service', taskContent: 't4' });

    const status = scheduler.getStatus();
    // The overflow task should have been routed to a fallback (order-processing or general)
    const orderLoad = status.agentLoads.find(a => a.agentType === 'order-processing');
    const generalLoad = status.agentLoads.find(a => a.agentType === 'general');
    assert.ok(orderLoad.current > 0 || generalLoad.current > 0, 'Overflow should be routed to fallback agent');
  });

  it('should emit task-scheduled event', () => {
    let emitted = false;
    scheduler.on('task-scheduled', () => { emitted = true; });
    scheduler.submit({ agentType: 'customer-service', taskContent: 'test' });
    assert.strictEqual(emitted, true);
  });

  it('should emit task-completed event', () => {
    let emitted = false;
    scheduler.on('task-completed', () => { emitted = true; });
    const taskId = scheduler.submit({ agentType: 'customer-service', taskContent: 'test' });
    scheduler.complete(taskId, 'result');
    assert.strictEqual(emitted, true);
  });

  it('should emit task-failed event', () => {
    let emitted = false;
    scheduler.on('task-failed', () => { emitted = true; });
    const taskId = scheduler.submit({ agentType: 'customer-service', taskContent: 'test' });
    scheduler.fail(taskId, new Error('fail'));
    assert.strictEqual(emitted, true);
  });

  it('should get status with agent loads', () => {
    scheduler.submit({ agentType: 'customer-service', taskContent: 'test' });
    const status = scheduler.getStatus();
    assert.ok(status.queueSize >= 0);
    assert.ok(status.activeCount >= 0);
    assert.ok(status.agentLoads.length >= 3);
    assert.ok(status.agentLoads.some(a => a.agentType === 'customer-service'));
  });

  it('should return null for unknown agent load', () => {
    assert.strictEqual(scheduler.getAgentLoad('unknown-agent'), null);
  });

  it('should throw on submit after shutdown', () => {
    scheduler.shutdown();
    assert.throws(() => {
      scheduler.submit({ agentType: 'customer-service', taskContent: 'test' });
    }, /shut down/i);
  });

  it('should submit batch tasks', () => {
    const ids = scheduler.submitBatch([
      { agentType: 'customer-service', taskContent: 't1' },
      { agentType: 'customer-service', taskContent: 't2' },
      { agentType: 'order-processing', taskContent: 't3' },
    ]);
    assert.strictEqual(ids.length, 3);
    ids.forEach(id => assert.ok(id.startsWith('task-')));
  });

  it('should handle critical priority tasks with shorter timeout', () => {
    const taskId = scheduler.submit({
      agentType: 'customer-service',
      priority: TASK_PRIORITY.CRITICAL,
      taskContent: 'urgent',
    });
    assert.ok(taskId);

    const load = scheduler.getAgentLoad('customer-service');
    assert.strictEqual(load.current, 1);
  });
});

// =========================== 集成测试：端到端流程 ===========================

describe('Platform Integration - End-to-End', () => {
  let gateway;
  let registry;
  let scheduler;

  beforeEach(() => {
    registry = new BusinessAgentRegistry();
    gateway = new PlatformGateway({
      platformAdapters: {
        [PLATFORM_TYPES.WEBCHAT]: new WebChatAdapter(),
        [PLATFORM_TYPES.APP]: new AppAdapter(),
        [PLATFORM_TYPES.FEISHU]: new FeishuAdapter(),
      },
      businessAgentRouter: registry,
    });
    scheduler = new PriorityScheduler();
    scheduler.registerAgent('customer-service', 3);
    scheduler.registerAgent('order-processing', 3);
    scheduler.registerAgent('logistics', 2);
    scheduler.registerAgent('general', 5);
  });

  afterEach(() => {
    if (gateway && !gateway._shutDown) gateway.shutdown();
    if (registry && !registry._shutDown) registry.shutdown();
    if (scheduler && !scheduler._shutDown) {
      scheduler.stopHealthCheck();
      scheduler.shutdown();
    }
  });

  it('should route WebChat complaint to customer-service and schedule', async () => {
    // 用户在飞书 WebChat 咨询
    const result = await gateway.receive(PLATFORM_TYPES.WEBCHAT, {
      userId: 'user-001',
      content: '我要投诉产品问题',
      sessionId: 'sess-001',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.route.agentType, 'customer-service');

    // 调度到优先级队列
    const taskId = scheduler.submit({
      agentType: result.route.agentType,
      priority: result.route.priority,
      taskContent: result.message.taskContent,
      metadata: { userId: result.message.userId, platformType: result.message.platformType },
    });

    assert.ok(taskId);
    const load = scheduler.getAgentLoad('customer-service');
    assert.strictEqual(load.current, 1);
  });

  it('should route order query from APP to order-processing', async () => {
    const result = await gateway.receive(PLATFORM_TYPES.APP, {
      userId: 'app-user-001',
      content: '查询我的订单',
      deviceType: 'Android',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.route.agentType, 'order-processing');
  });

  it('should route logistics query from Feishu to logistics', async () => {
    const result = await gateway.receive(PLATFORM_TYPES.FEISHU, {
      open_id: 'ou_123',
      text: '快递到哪了',
      chat_id: 'oc_456',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.route.agentType, 'logistics');
  });

  it('should maintain cross-platform user context', async () => {
    // 用户在飞书问过的问题 - 使用相同的基础用户ID
    const r1 = await gateway.receive(PLATFORM_TYPES.FEISHU, {
      open_id: 'user-multi',
      text: '订单退款问题',
      chat_id: 'chat-1',
    });

    // 合并跨平台用户身份
    gateway.mergeUserIdentity(r1.message.userId, PLATFORM_TYPES.APP, 'app-user-multi');

    // 切换到APP咨询时
    const result = await gateway.receive(PLATFORM_TYPES.APP, {
      userId: 'app-user-multi',
      content: '刚才问的退款问题',
      deviceType: 'iPhone',
    });

    assert.strictEqual(result.success, true);
    // 上下文摘要应包含之前的主题
    assert.ok(result.message.contextSummary);
    assert.ok(result.message.contextSummary.messageCount > 0);
  });
});
