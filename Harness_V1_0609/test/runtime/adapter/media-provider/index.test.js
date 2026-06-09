'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const mediaProviderModule = require(path.join(ROOT, 'src', 'runtime', 'adapter', 'media-provider', 'index'));

const MediaProviderInterface = mediaProviderModule.MediaProviderInterface;
const MediaProviderBase = mediaProviderModule.MediaProviderBase;
const MediaProviderRouter = mediaProviderModule.MediaProviderRouter;
const ROUTING_STRATEGIES = mediaProviderModule.ROUTING_STRATEGIES;

// 测试用Mock Provider
class MockProvider extends MediaProviderBase {
  constructor(config) {
    super(config);
    this._taskCounter = 0;
    this._tasks = new Map();
    this._failGenerate = false;
    this._failConnect = false;
    this._generateDelay = 0;
  }

  get name() { return this._config.name || 'mock-provider'; }

  getCapabilities() {
    return {
      modes: this._config.modes || ['generate', 'imageToVideo'],
      maxDuration: this._config.maxDuration || 60,
      maxResolution: this._config.maxResolution || '1920x1080',
      provider: this.name,
    };
  }

  async _doConnect() {
    if (this._failConnect) throw new Error('Connection failed');
  }

  async _doDisconnect() { /* 空实现 */ }

  async _doGenerate(request) {
    if (this._failGenerate) throw new Error('Generate failed');
    if (this._generateDelay > 0) {
      await new Promise(function(resolve) { setTimeout(resolve, this._generateDelay); }.bind(this));
    }
    const taskId = 'task-' + (++this._taskCounter);
    this._tasks.set(taskId, { status: 'pending', prompt: request.prompt, mode: request.mode });
    return { taskId: taskId, status: 'pending', provider: this.name };
  }

  async _doGetTaskStatus(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return { taskId: taskId, status: 'not_found' };
    return { taskId: taskId, status: task.status, result: { prompt: task.prompt } };
  }

  async _doCancelTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return { cancelled: false };
    task.status = 'cancelled';
    return { cancelled: true };
  }
}

// ==================== MediaProviderInterface 测试 ====================

describe('MediaProviderInterface', () => {
  it('should create instance with default config', () => {
    const iface = new MediaProviderInterface();
    assert.ok(iface);
    assert.deepStrictEqual(iface._config, {});
  });

  it('should return default capabilities', () => {
    const iface = new MediaProviderInterface();
    const caps = iface.getCapabilities();
    assert.deepStrictEqual(caps.modes, ['generate']);
    assert.strictEqual(caps.maxDuration, 0);
    assert.strictEqual(caps.maxResolution, '');
    assert.strictEqual(caps.provider, 'media-provider-interface');
  });

  it('should return name', () => {
    const iface = new MediaProviderInterface();
    assert.strictEqual(iface.name, 'media-provider-interface');
  });

  it('should return disconnected state initially', () => {
    const iface = new MediaProviderInterface();
    assert.strictEqual(iface.isConnected(), false);
  });

  it('should emit events on connect/disconnect', async () => {
    const iface = new MediaProviderInterface();
    let connectedEvent = false;
    let disconnectedEvent = false;
    iface.on('connected', () => { connectedEvent = true; });
    iface.on('disconnected', () => { disconnectedEvent = true; });

    const result = await iface.connect();
    assert.strictEqual(connectedEvent, true);
    assert.strictEqual(iface.isConnected(), true);
    assert.strictEqual(result.connected, true);
    assert.strictEqual(result.provider, 'media-provider-interface');

    await iface.disconnect();
    assert.strictEqual(disconnectedEvent, true);
    assert.strictEqual(iface.isConnected(), false);
  });

  it('should throw on generate() in base class', async () => {
    const iface = new MediaProviderInterface();
    await assert.rejects(
      () => iface.generate({ prompt: 'test' }),
      { message: 'generate() must be implemented' },
    );
  });

  it('should throw on getTaskStatus() in base class', async () => {
    const iface = new MediaProviderInterface();
    await assert.rejects(
      () => iface.getTaskStatus('task-1'),
      { message: 'getTaskStatus() must be implemented' },
    );
  });

  it('should throw on cancelTask() in base class', async () => {
    const iface = new MediaProviderInterface();
    await assert.rejects(
      () => iface.cancelTask('task-1'),
      { message: 'cancelTask() must be implemented' },
    );
  });

  it('should return health check result', async () => {
    const iface = new MediaProviderInterface();
    const health = await iface.healthCheck();
    assert.strictEqual(typeof health.healthy, 'boolean');
    assert.strictEqual(typeof health.latency, 'number');
  });

  it('should shutdown gracefully', () => {
    const iface = new MediaProviderInterface();
    iface.on('test', () => {});
    iface.shutdown();
    assert.strictEqual(iface._shutDown, true);
  });

  it('should have PROVIDER_EVENTS constant', () => {
    assert.ok(MediaProviderInterface.PROVIDER_EVENTS);
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.CONNECTED, 'connected');
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.DISCONNECTED, 'disconnected');
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.HEALTH_CHANGED, 'health-changed');
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.ERROR, 'error');
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.TASK_CREATED, 'task-created');
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.TASK_COMPLETED, 'task-completed');
    assert.strictEqual(MediaProviderInterface.PROVIDER_EVENTS.TASK_FAILED, 'task-failed');
  });
});

// ==================== MediaProviderBase 基础测试 ====================

describe('MediaProviderBase - config and error classification', () => {
  it('should create instance with default config', () => {
    const base = new MediaProviderBase();
    assert.ok(base);
    assert.strictEqual(base._providerConfig.maxRetries, 3);
    assert.strictEqual(base._providerConfig.retryDelayMs, 1000);
    assert.strictEqual(base._providerConfig.requestTimeoutMs, 300000);
    assert.strictEqual(base._providerConfig.maxConcurrentTasks, 5);
    assert.strictEqual(base._providerConfig.taskHistorySize, 100);
  });

  it('should merge custom config', () => {
    const base = new MediaProviderBase({ maxRetries: 5, requestTimeoutMs: 60000 });
    assert.strictEqual(base._providerConfig.maxRetries, 5);
    assert.strictEqual(base._providerConfig.requestTimeoutMs, 60000);
    assert.strictEqual(base._providerConfig.retryDelayMs, 1000);
  });

  it('should classify errors correctly', () => {
    const base = new MediaProviderBase();
    assert.strictEqual(base._classifyError({ code: 'ECONNREFUSED' }), 'network');
    assert.strictEqual(base._classifyError({ code: 'ETIMEDOUT' }), 'network');
    assert.strictEqual(base._classifyError({ statusCode: 401 }), 'auth');
    assert.strictEqual(base._classifyError({ statusCode: 403 }), 'auth');
    assert.strictEqual(base._classifyError({ statusCode: 429 }), 'rate-limit');
    assert.strictEqual(base._classifyError({ statusCode: 500 }), 'server');
    assert.strictEqual(base._classifyError({ message: 'network error' }), 'network');
    assert.strictEqual(base._classifyError({ message: 'auth failed' }), 'auth');
    assert.strictEqual(base._classifyError({ message: 'rate limit' }), 'rate-limit');
    assert.strictEqual(base._classifyError({ message: 'unknown issue' }), 'unknown');
  });

  it('should have ERROR_TYPES and DEFAULT_CONFIG statics', () => {
    assert.ok(MediaProviderBase.ERROR_TYPES);
    assert.strictEqual(MediaProviderBase.ERROR_TYPES.NETWORK, 'network');
    assert.strictEqual(MediaProviderBase.ERROR_TYPES.AUTH, 'auth');
    assert.strictEqual(MediaProviderBase.ERROR_TYPES.RATE_LIMIT, 'rate-limit');
    assert.strictEqual(MediaProviderBase.ERROR_TYPES.SERVER, 'server');
    assert.strictEqual(MediaProviderBase.ERROR_TYPES.TIMEOUT, 'timeout');
    assert.strictEqual(MediaProviderBase.ERROR_TYPES.UNKNOWN, 'unknown');
    assert.ok(MediaProviderBase.DEFAULT_CONFIG);
    assert.strictEqual(MediaProviderBase.DEFAULT_CONFIG.maxRetries, 3);
  });
});

// ==================== MediaProviderBase 重试和超时测试 ====================

describe('MediaProviderBase - retry and timeout', () => {
  it('should retry on transient errors', async () => {
    let attempts = 0;
    const base = new MediaProviderBase({ maxRetries: 2, retryDelayMs: 10 });
    base.name;
    const result = await base._withRetry(function() {
      attempts++;
      if (attempts < 3) throw new Error('server error');
      return 'success';
    }, 'test');
    assert.strictEqual(result, 'success');
    assert.strictEqual(attempts, 3);
    assert.strictEqual(base._stats.totalRetries, 2);
  });

  it('should not retry on auth errors', async () => {
    let attempts = 0;
    const base = new MediaProviderBase({ maxRetries: 3, retryDelayMs: 10 });
    await assert.rejects(
      () => base._withRetry(function() {
        attempts++;
        const err = new Error('unauthorized');
        err.statusCode = 401;
        throw err;
      }, 'test'),
      { message: 'unauthorized' },
    );
    assert.strictEqual(attempts, 1);
  });

  it('should throw after max retries exceeded', async () => {
    const base = new MediaProviderBase({ maxRetries: 1, retryDelayMs: 10 });
    await assert.rejects(
      () => base._withRetry(function() { throw new Error('persistent error'); }, 'test'),
      { message: 'persistent error' },
    );
    assert.strictEqual(base._stats.failedRequests, 1);
  });

  it('should timeout long operations', async () => {
    const base = new MediaProviderBase({ requestTimeoutMs: 50 });
    await assert.rejects(
      () => base._withTimeout(
        new Promise(function() { /* 永不resolve */ }),
        50,
        'test',
      ),
      { message: /timed out/ },
    );
  });
});

// ==================== MediaProviderBase 任务管理测试 ====================

describe('MediaProviderBase - task management', () => {
  it('should record task history', () => {
    const base = new MediaProviderBase();
    base._recordTask('task-1', 'pending');
    assert.strictEqual(base._activeTasks.size, 1);
    assert.strictEqual(base._activeTasks.get('task-1').status, 'pending');

    base._recordTask('task-1', 'completed', { url: 'http://example.com' });
    assert.strictEqual(base._activeTasks.size, 0);
    assert.strictEqual(base._stats.successfulRequests, 1);
  });

  it('should check capacity', () => {
    const base = new MediaProviderBase({ maxConcurrentTasks: 2 });
    assert.strictEqual(base._isAtCapacity(), false);
    base._activeTasks.set('task-1', {});
    base._activeTasks.set('task-2', {});
    assert.strictEqual(base._isAtCapacity(), true);
  });

  it('should reject generate when at capacity', async () => {
    const provider = new MockProvider({ maxConcurrentTasks: 1 });
    await provider.connect();
    await provider.generate({ prompt: 'test1' });
    await assert.rejects(
      () => provider.generate({ prompt: 'test2' }),
      { message: /max concurrent tasks/ },
    );
  });

  it('should connect with retry', async () => {
    const provider = new MockProvider();
    const result = await provider.connect();
    assert.strictEqual(result.connected, true);
    assert.strictEqual(result.provider, 'mock-provider');
    assert.strictEqual(provider.isConnected(), true);
  });

  it('should handle connect failure', async () => {
    const provider = new MockProvider({ maxRetries: 1, retryDelayMs: 10 });
    provider._failConnect = true;
    await assert.rejects(() => provider.connect());
    assert.strictEqual(provider.isConnected(), false);
  });

  it('should disconnect cleanly', async () => {
    const provider = new MockProvider();
    await provider.connect();
    await provider.disconnect();
    assert.strictEqual(provider.isConnected(), false);
  });

  it('should perform health check', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const health = await provider.healthCheck();
    assert.strictEqual(health.healthy, true);
    assert.strictEqual(typeof health.latency, 'number');
    assert.strictEqual(health.error, null);
  });

  it('should generate media content', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const result = await provider.generate({ prompt: 'a sunset video', mode: 'generate' });
    assert.ok(result.taskId);
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.provider, 'mock-provider');
  });

  it('should get task status', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const gen = await provider.generate({ prompt: 'test' });
    const status = await provider.getTaskStatus(gen.taskId);
    assert.strictEqual(status.taskId, gen.taskId);
    assert.strictEqual(status.status, 'pending');
  });

  it('should cancel task', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const gen = await provider.generate({ prompt: 'test' });
    const result = await provider.cancelTask(gen.taskId);
    assert.strictEqual(result.cancelled, true);
  });

  it('should return stats', async () => {
    const provider = new MockProvider();
    await provider.connect();
    await provider.generate({ prompt: 'test' });
    const stats = provider.getStats();
    assert.strictEqual(typeof stats.totalRequests, 'number');
    assert.strictEqual(typeof stats.successfulRequests, 'number');
    assert.strictEqual(typeof stats.failedRequests, 'number');
    assert.strictEqual(typeof stats.totalRetries, 'number');
    assert.strictEqual(typeof stats.activeTasks, 'number');
    assert.strictEqual(stats.connected, true);
    assert.strictEqual(stats.provider, 'mock-provider');
    assert.ok(stats.byErrorType);
  });

  it('should shutdown gracefully', async () => {
    const provider = new MockProvider();
    await provider.connect();
    provider.shutdown();
    assert.strictEqual(provider._shutDown, true);
  });

  it('should guard shutdown on generate', async () => {
    const provider = new MockProvider();
    provider.shutdown();
    await assert.rejects(
      () => provider.generate({ prompt: 'test' }),
      { message: /shut down/ },
    );
  });

  it('should emit task-created event on generate', async () => {
    const provider = new MockProvider();
    await provider.connect();
    let eventFired = false;
    provider.on('task-created', (data) => {
      eventFired = true;
      assert.ok(data.taskId);
      assert.strictEqual(data.provider, 'mock-provider');
    });
    await provider.generate({ prompt: 'test' });
    assert.strictEqual(eventFired, true);
  });
});

// ==================== MediaProviderRouter 基础测试 ====================

describe('MediaProviderRouter - basics', () => {
  it('should create with default strategy', () => {
    const router = new MediaProviderRouter();
    assert.strictEqual(router.strategy, ROUTING_STRATEGIES.COST_OPTIMAL);
    assert.strictEqual(router.isHealthy(), true);
  });

  it('should create with custom strategy', () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.QUALITY_OPTIMAL });
    assert.strictEqual(router.strategy, ROUTING_STRATEGIES.QUALITY_OPTIMAL);
  });

  it('should reject invalid strategy', () => {
    const router = new MediaProviderRouter();
    assert.throws(
      () => { router.strategy = 'invalid'; },
      { message: /Invalid strategy/ },
    );
  });

  it('should register and unregister providers', () => {
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    router.registerProvider(provider);
    assert.strictEqual(router.getProviders().length, 1);
    assert.strictEqual(router.getProvider('test-provider'), provider);

    const result = router.unregisterProvider('test-provider');
    assert.strictEqual(result, true);
    assert.strictEqual(router.getProviders().length, 0);
  });

  it('should reject invalid provider registration', () => {
    const router = new MediaProviderRouter();
    assert.throws(() => router.registerProvider(null), { message: /Invalid provider/ });
    assert.throws(() => router.registerProvider({}), { message: /must have a name/ });
  });

  it('should return null for non-existent provider', () => {
    const router = new MediaProviderRouter();
    assert.strictEqual(router.getProvider('nonexistent'), null);
  });

  it('should return false for unregistering non-existent provider', () => {
    const router = new MediaProviderRouter();
    assert.strictEqual(router.unregisterProvider('nonexistent'), false);
  });

  it('should emit provider-registered event', () => {
    const router = new MediaProviderRouter();
    let eventFired = false;
    router.on('provider-registered', (data) => {
      eventFired = true;
      assert.strictEqual(data.provider, 'test-provider');
    });
    const provider = new MockProvider({ name: 'test-provider' });
    router.registerProvider(provider);
    assert.strictEqual(eventFired, true);
  });

  it('should emit provider-unregistered event', () => {
    const router = new MediaProviderRouter();
    let eventFired = false;
    const provider = new MockProvider({ name: 'test-provider' });
    router.registerProvider(provider);
    router.on('provider-unregistered', (data) => {
      eventFired = true;
      assert.strictEqual(data.provider, 'test-provider');
    });
    router.unregisterProvider('test-provider');
    assert.strictEqual(eventFired, true);
  });
});

// ==================== MediaProviderRouter 路由策略测试 ====================

describe('MediaProviderRouter - routing strategies', () => {
  it('should route with COST_OPTIMAL strategy (last provider)', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.COST_OPTIMAL });
    const provider1 = new MockProvider({ name: 'quality-provider' });
    const provider2 = new MockProvider({ name: 'budget-provider' });
    router.registerProvider(provider1);
    router.registerProvider(provider2);
    const result = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result.provider, 'budget-provider');
  });

  it('should route with QUALITY_OPTIMAL strategy (first provider)', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.QUALITY_OPTIMAL });
    const provider1 = new MockProvider({ name: 'quality-provider' });
    const provider2 = new MockProvider({ name: 'budget-provider' });
    router.registerProvider(provider1);
    router.registerProvider(provider2);
    const result = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result.provider, 'quality-provider');
  });

  it('should route with ROUND_ROBIN strategy', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.ROUND_ROBIN });
    const provider1 = new MockProvider({ name: 'provider-1' });
    const provider2 = new MockProvider({ name: 'provider-2' });
    router.registerProvider(provider1);
    router.registerProvider(provider2);

    const result1 = await router.route({ prompt: 'test1', mode: 'generate' });
    const result2 = await router.route({ prompt: 'test2', mode: 'generate' });
    assert.strictEqual(result1.provider, 'provider-1');
    assert.strictEqual(result2.provider, 'provider-2');
  });

  it('should route with SPEED_OPTIMAL strategy', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.SPEED_OPTIMAL });
    const provider1 = new MockProvider({ name: 'slow-provider' });
    const provider2 = new MockProvider({ name: 'fast-provider' });
    router.registerProvider(provider1);
    router.registerProvider(provider2);
    router._healthStatus.set('slow-provider', { healthy: true, latency: 500, checkedAt: Date.now() });
    router._healthStatus.set('fast-provider', { healthy: true, latency: 50, checkedAt: Date.now() });
    const result = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result.provider, 'fast-provider');
  });

  it('should throw when no available provider', async () => {
    const router = new MediaProviderRouter();
    await assert.rejects(
      () => router.route({ prompt: 'test', mode: 'generate' }),
      { message: /No available provider/ },
    );
  });

  it('should throw when no provider supports requested mode', async () => {
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'limited-provider', modes: ['generate'] });
    router.registerProvider(provider);
    await assert.rejects(
      () => router.route({ prompt: 'test', mode: 'imageToVideo' }),
      { message: /No available provider/ },
    );
  });
});

// ==================== MediaProviderRouter 故障转移和生命周期测试 ====================

describe('MediaProviderRouter - failover and lifecycle', () => {
  it('should fallback on failure (non-FAILFAST)', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.COST_OPTIMAL });
    const okProvider = new MockProvider({ name: 'ok-provider' });
    const failProvider = new MockProvider({ name: 'fail-provider' });
    failProvider._failGenerate = true;
    router.registerProvider(okProvider);
    router.registerProvider(failProvider);
    const result = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result.provider, 'ok-provider');
  });

  it('should not fallback with FAILFAST strategy', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.FAILFAST });
    const failProvider = new MockProvider({ name: 'fail-provider' });
    failProvider._failGenerate = true;
    const okProvider = new MockProvider({ name: 'ok-provider' });
    router.registerProvider(okProvider);
    router.registerProvider(failProvider);
    await assert.rejects(
      () => router.route({ prompt: 'test', mode: 'generate' }),
      { message: 'Generate failed' },
    );
  });

  it('should check all provider health', async () => {
    const router = new MediaProviderRouter();
    const provider1 = new MockProvider({ name: 'provider-1' });
    const provider2 = new MockProvider({ name: 'provider-2' });
    await provider1.connect();
    await provider2.connect();
    router.registerProvider(provider1);
    router.registerProvider(provider2);
    const health = await router.checkAllHealth();
    assert.strictEqual(health['provider-1'].healthy, true);
    assert.strictEqual(health['provider-2'].healthy, true);
  });

  it('should return stats', async () => {
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    router.registerProvider(provider);
    await router.route({ prompt: 'test', mode: 'generate' });
    const stats = router.getStats();
    assert.strictEqual(stats.totalRouted, 1);
    assert.strictEqual(stats.providerCount, 1);
    assert.strictEqual(stats.strategy, ROUTING_STRATEGIES.COST_OPTIMAL);
    assert.strictEqual(stats.byProvider['test-provider'], 1);
    assert.strictEqual(stats.fallbacks, 0);
  });

  it('should emit routed event', async () => {
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    router.registerProvider(provider);
    let eventFired = false;
    router.on('routed', (data) => {
      eventFired = true;
      assert.strictEqual(data.provider, 'test-provider');
    });
    await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(eventFired, true);
  });

  it('should shutdown gracefully', () => {
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    router.registerProvider(provider);
    router.shutdown();
    assert.strictEqual(router.isHealthy(), false);
    assert.strictEqual(router._shutDown, true);
  });

  it('should guard shutdown on route', async () => {
    const router = new MediaProviderRouter();
    router.shutdown();
    await assert.rejects(
      () => router.route({ prompt: 'test', mode: 'generate' }),
      { message: /shut down/ },
    );
  });

  it('should guard shutdown on register', () => {
    const router = new MediaProviderRouter();
    router.shutdown();
    assert.throws(
      () => router.registerProvider(new MockProvider({ name: 'test' })),
      { message: /shut down/ },
    );
  });

  it('should filter out shut down providers', async () => {
    const router = new MediaProviderRouter();
    const provider1 = new MockProvider({ name: 'active-provider' });
    const provider2 = new MockProvider({ name: 'shutdown-provider' });
    router.registerProvider(provider1);
    router.registerProvider(provider2);
    provider2.shutdown();
    const available = router._getAvailableProviders('generate');
    assert.strictEqual(available.length, 1);
    assert.strictEqual(available[0].name, 'active-provider');
  });

  it('should have ROUTING_STRATEGIES constant', () => {
    assert.strictEqual(ROUTING_STRATEGIES.COST_OPTIMAL, 'cost-optimal');
    assert.strictEqual(ROUTING_STRATEGIES.QUALITY_OPTIMAL, 'quality-optimal');
    assert.strictEqual(ROUTING_STRATEGIES.SPEED_OPTIMAL, 'speed-optimal');
    assert.strictEqual(ROUTING_STRATEGIES.ROUND_ROBIN, 'round-robin');
    assert.strictEqual(ROUTING_STRATEGIES.FAILFAST, 'failfast');
  });

  it('should have ROUTING_STRATEGIES on class', () => {
    assert.ok(MediaProviderRouter.ROUTING_STRATEGIES);
    assert.strictEqual(MediaProviderRouter.ROUTING_STRATEGIES.COST_OPTIMAL, 'cost-optimal');
  });
});

// ==================== 边界条件测试 ====================

describe('MediaProvider edge cases', () => {
  it('should handle concurrent task limit edge', async () => {
    const provider = new MockProvider({ maxConcurrentTasks: 2 });
    await provider.connect();
    await provider.generate({ prompt: 'test1' });
    await provider.generate({ prompt: 'test2' });
    await assert.rejects(
      () => provider.generate({ prompt: 'test3' }),
      { message: /max concurrent tasks/ },
    );
  });

  it('should handle empty prompt in generate', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const result = await provider.generate({ prompt: '' });
    assert.ok(result.taskId);
  });

  it('should handle task status for non-existent task', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const status = await provider.getTaskStatus('nonexistent');
    assert.strictEqual(status.status, 'not_found');
  });

  it('should handle cancel for non-existent task', async () => {
    const provider = new MockProvider();
    await provider.connect();
    const result = await provider.cancelTask('nonexistent');
    assert.strictEqual(result.cancelled, false);
  });

  it('should handle router with single provider', async () => {
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'only-provider' });
    router.registerProvider(provider);
    const result = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result.provider, 'only-provider');
  });

  it('should handle router fallback when all providers fail', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.COST_OPTIMAL });
    const fail1 = new MockProvider({ name: 'fail-1' });
    fail1._failGenerate = true;
    const fail2 = new MockProvider({ name: 'fail-2' });
    fail2._failGenerate = true;
    router.registerProvider(fail1);
    router.registerProvider(fail2);
    await assert.rejects(
      () => router.route({ prompt: 'test', mode: 'generate' }),
      { message: 'Generate failed' },
    );
  });

  it('should handle health check for disconnected provider', async () => {
    const provider = new MockProvider();
    // 未连接时_doHealthCheck仍返回healthy:true（基类默认行为）
    // 但_connected为false，所以基类healthCheck返回healthy取决于_doHealthCheck
    const health = await provider.healthCheck();
    // 基类_doHealthCheck默认返回{healthy:true}，所以healthCheck返回healthy:true
    assert.strictEqual(typeof health.healthy, 'boolean');
  });

  it('should handle task history overflow', () => {
    const provider = new MockProvider({ taskHistorySize: 3 });
    provider._recordTask('task-1', 'completed');
    provider._recordTask('task-2', 'completed');
    provider._recordTask('task-3', 'completed');
    provider._recordTask('task-4', 'completed');
    assert.ok(provider._taskHistory.size <= 3);
  });

  it('should handle double shutdown', () => {
    const router = new MediaProviderRouter();
    router.shutdown();
    router.shutdown();
    assert.strictEqual(router._shutDown, true);
  });

  it('should handle unregister after shutdown', () => {
    const router = new MediaProviderRouter();
    router.shutdown();
    assert.throws(
      () => router.unregisterProvider('test'),
      { message: /shut down/ },
    );
  });

  it('should handle strategy change at runtime', async () => {
    const router = new MediaProviderRouter({ strategy: ROUTING_STRATEGIES.COST_OPTIMAL });
    const p1 = new MockProvider({ name: 'p1' });
    const p2 = new MockProvider({ name: 'p2' });
    router.registerProvider(p1);
    router.registerProvider(p2);

    const result1 = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result1.provider, 'p2');

    router.strategy = ROUTING_STRATEGIES.QUALITY_OPTIMAL;
    const result2 = await router.route({ prompt: 'test', mode: 'generate' });
    assert.strictEqual(result2.provider, 'p1');
  });
});

// ==================== API端点测试 ====================

describe('MediaProvider API endpoints', () => {
  const DashboardServer = require(path.join(ROOT, 'src', 'web', 'server'));

  it('should return unavailable status when no router set', () => {
    const server = new DashboardServer(ROOT, 0);
    const status = server._getMediaProvidersStatus();
    assert.strictEqual(status.available, false);
  });

  it('should return status with router set', async () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    await provider.connect();
    router.registerProvider(provider);
    server.setMediaProviderRouter(router);

    const status = server._getMediaProvidersStatus();
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.providerCount, 1);
    assert.strictEqual(status.providers[0].name, 'test-provider');
    assert.strictEqual(status.providers[0].connected, true);
  });

  it('should return provider list', async () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    await provider.connect();
    router.registerProvider(provider);
    server.setMediaProviderRouter(router);

    const list = server._getMediaProvidersList();
    assert.strictEqual(list.available, true);
    assert.strictEqual(list.providers.length, 1);
    assert.strictEqual(list.providers[0].name, 'test-provider');
    assert.deepStrictEqual(list.providers[0].modes, ['generate', 'imageToVideo']);
  });

  it('should return task status via dynamic route', async () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    await provider.connect();
    router.registerProvider(provider);
    server.setMediaProviderRouter(router);

    const gen = await provider.generate({ prompt: 'test' });
    const status = await server._getMediaProviderTaskStatus(gen.taskId);
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.taskId, gen.taskId);
    assert.strictEqual(status.provider, 'test-provider');
  });

  it('should return not found for unknown task', async () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    await provider.connect();
    router.registerProvider(provider);
    server.setMediaProviderRouter(router);

    const status = await server._getMediaProviderTaskStatus('unknown-task');
    assert.strictEqual(status.available, true);
    // MockProvider返回{status:'not_found'}，不是null
    assert.ok(status.status);
  });

  it('should validate generate POST route - missing prompt', () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    server.setMediaProviderRouter(router);

    const routes = server._buildMediaProviderRoutes(server, function() { return null; });
    const result = routes['/api/media-providers/generate']({});
    assert.strictEqual(result._status, 400);
  });

  it('should validate generate POST route - empty prompt', () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    server.setMediaProviderRouter(router);

    const routes = server._buildMediaProviderRoutes(server, function() { return null; });
    const result = routes['/api/media-providers/generate']({ prompt: '  ' });
    assert.strictEqual(result._status, 400);
  });

  it('should validate generate POST route - no router', () => {
    const server = new DashboardServer(ROOT, 0);

    const routes = server._buildMediaProviderRoutes(server, function() { return null; });
    const result = routes['/api/media-providers/generate']({ prompt: 'test' });
    assert.strictEqual(result._status, 503);
  });

  it('should generate via POST route', async () => {
    const server = new DashboardServer(ROOT, 0);
    const router = new MediaProviderRouter();
    const provider = new MockProvider({ name: 'test-provider' });
    await provider.connect();
    router.registerProvider(provider);
    server.setMediaProviderRouter(router);

    const routes = server._buildMediaProviderRoutes(server, function() { return null; });
    const result = await routes['/api/media-providers/generate']({ prompt: 'a sunset', mode: 'generate' });
    assert.ok(result.taskId);
    assert.strictEqual(result.provider, 'test-provider');
  });

  it('should reject invalid taskId format in dynamic route', () => {
    const server = new DashboardServer(ROOT, 0);
    const handler = server._resolveDynamicRoute('/api/media-providers/task/../../etc/passwd', new URL('http://localhost'));
    const result = handler();
    // _resolveDynamicRoute返回一个函数，调用后返回结果对象
    assert.strictEqual(result._status, 400);
  });
});
