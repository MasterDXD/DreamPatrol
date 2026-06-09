'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const providerIndex = require(path.join(ROOT, 'src', 'runtime', 'thought', 'provider', 'index'));

const MemoryProviderInterface = providerIndex.MemoryProviderInterface;
const ProviderRegistry = providerIndex.ProviderRegistry;
const ProviderAdapterBase = providerIndex.ProviderAdapterBase;
const Mem0Adapter = providerIndex.Mem0Adapter;
const HonchoAdapter = providerIndex.HonchoAdapter;
const HindsightAdapter = providerIndex.HindsightAdapter;
const ProviderHealthChecker = providerIndex.ProviderHealthChecker;

describe('MemoryProviderInterface', () => {
  it('should create instance with default config', () => {
    const iface = new MemoryProviderInterface();
    assert.ok(iface);
    assert.deepStrictEqual(iface._config, {});
  });

  it('should return default capabilities', () => {
    const iface = new MemoryProviderInterface();
    const caps = iface.getCapabilities();
    assert.strictEqual(caps.recall, true);
    assert.strictEqual(caps.write, true);
    assert.strictEqual(caps.sync, false);
    assert.strictEqual(caps.semanticSearch, false);
    assert.strictEqual(caps.userIsolation, false);
  });

  it('should return name', () => {
    const iface = new MemoryProviderInterface();
    assert.strictEqual(iface.getName(), 'memory-provider-interface');
  });

  it('should return disconnected state initially', () => {
    const iface = new MemoryProviderInterface();
    assert.strictEqual(iface.isConnected(), false);
  });

  it('should emit events on connect/disconnect', async () => {
    const iface = new MemoryProviderInterface();
    let connectedEvent = false;
    let disconnectedEvent = false;
    iface.on('connected', () => { connectedEvent = true; });
    iface.on('disconnected', () => { disconnectedEvent = true; });

    await iface.connect();
    assert.strictEqual(connectedEvent, true);
    assert.strictEqual(iface.isConnected(), true);

    await iface.disconnect();
    assert.strictEqual(disconnectedEvent, true);
    assert.strictEqual(iface.isConnected(), false);
  });

  it('should return empty results from base recall/write/query', async () => {
    const iface = new MemoryProviderInterface();
    const recallResult = await iface.recall('test');
    assert.deepStrictEqual(recallResult, []);
    const writeResult = await iface.write({ content: 'test' });
    assert.deepStrictEqual(writeResult, { success: false, id: null });
    const queryResult = await iface.query({});
    assert.deepStrictEqual(queryResult, []);
    const deleteResult = await iface.delete('id');
    assert.strictEqual(deleteResult, false);
    const syncResult = await iface.sync([], 'push');
    assert.deepStrictEqual(syncResult, { pushed: 0, pulled: 0 });
  });

  it('should shutdown gracefully', () => {
    const iface = new MemoryProviderInterface();
    iface.on('test', () => {});
    iface.shutdown();
    assert.strictEqual(iface._shutDown, true);
  });

  it('should expose PROVIDER_EVENTS', () => {
    assert.ok(MemoryProviderInterface.PROVIDER_EVENTS);
    assert.strictEqual(MemoryProviderInterface.PROVIDER_EVENTS.CONNECTED, 'connected');
    assert.strictEqual(MemoryProviderInterface.PROVIDER_EVENTS.DISCONNECTED, 'disconnected');
    assert.strictEqual(MemoryProviderInterface.PROVIDER_EVENTS.HEALTH_CHANGED, 'health-changed');
    assert.strictEqual(MemoryProviderInterface.PROVIDER_EVENTS.ERROR, 'error');
  });

  it('should return unhealthy health check when not connected', async () => {
    const iface = new MemoryProviderInterface();
    const result = await iface.healthCheck();
    assert.strictEqual(result.healthy, false);
    assert.strictEqual(result.latency, -1);
    assert.strictEqual(result.error, 'not connected');
  });

  it('should return healthy health check when connected', async () => {
    const iface = new MemoryProviderInterface();
    await iface.connect();
    const result = await iface.healthCheck();
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.error, null);
    assert.ok(result.latency >= 0);
  });
});

describe('ProviderRegistry', () => {
  it('should register provider', () => {
    const registry = new ProviderRegistry();
    const provider = new MemoryProviderInterface();
    const result = registry.register('test', provider);
    assert.strictEqual(result, registry);
    assert.strictEqual(registry.get('test'), provider);
  });

  it('should reject invalid register calls', () => {
    const registry = new ProviderRegistry();
    registry.register('', {});
    registry.register(null, {});
    registry.register('test', null);
    registry.register('test', 'not-object');
    assert.strictEqual(registry.get('test'), null);
  });

  it('should unregister provider', async () => {
    const registry = new ProviderRegistry();
    const provider = new MemoryProviderInterface();
    registry.register('test', provider);
    await registry.unregister('test');
    assert.strictEqual(registry.get('test'), null);
  });

  it('should handle unregister of non-existent provider', async () => {
    const registry = new ProviderRegistry();
    const result = await registry.unregister('nonexistent');
    assert.strictEqual(result, registry);
  });

  it('should get provider by name', () => {
    const registry = new ProviderRegistry();
    const provider = new MemoryProviderInterface();
    registry.register('test', provider);
    assert.strictEqual(registry.get('test'), provider);
    assert.strictEqual(registry.get('nonexistent'), null);
    assert.strictEqual(registry.getByName('test'), provider);
  });

  it('should get all providers', () => {
    const registry = new ProviderRegistry();
    const p1 = new MemoryProviderInterface();
    const p2 = new MemoryProviderInterface();
    registry.register('a', p1);
    registry.register('b', p2);
    const all = registry.getAll();
    assert.strictEqual(Object.keys(all).length, 2);
    assert.strictEqual(all.a, p1);
    assert.strictEqual(all.b, p2);
  });

  it('should get healthy providers', async () => {
    const registry = new ProviderRegistry();
    const p1 = new MemoryProviderInterface();
    const p2 = new MemoryProviderInterface();
    registry.register('a', p1);
    registry.register('b', p2);
    await p1.connect();
    const healthy = registry.getHealthy();
    assert.strictEqual(Object.keys(healthy).length, 1);
    assert.strictEqual(healthy.a, p1);
  });

  it('should connect all providers', async () => {
    const registry = new ProviderRegistry();
    const p1 = new MemoryProviderInterface();
    const p2 = new MemoryProviderInterface();
    registry.register('a', p1);
    registry.register('b', p2);
    const results = await registry.connectAll();
    assert.strictEqual(results.a.connected, true);
    assert.strictEqual(results.b.connected, true);
  });

  it('should disconnect all providers', async () => {
    const registry = new ProviderRegistry();
    const p1 = new MemoryProviderInterface();
    registry.register('a', p1);
    await p1.connect();
    const results = await registry.disconnectAll();
    assert.strictEqual(results.a.disconnected, true);
  });

  it('should health check all providers', async () => {
    const registry = new ProviderRegistry();
    const p1 = new MemoryProviderInterface();
    registry.register('a', p1);
    await p1.connect();
    const results = await registry.healthCheckAll();
    assert.strictEqual(results.a.healthy, true);
  });

  it('should health check handle provider without healthCheck method', async () => {
    const registry = new ProviderRegistry();
    registry.register('a', {});
    const results = await registry.healthCheckAll();
    assert.strictEqual(results.a.healthy, false);
    assert.strictEqual(results.a.error, 'no healthCheck method');
  });

  it('should return stats', async () => {
    const registry = new ProviderRegistry();
    const p1 = new MemoryProviderInterface();
    registry.register('a', p1);
    await p1.connect();
    const stats = registry.getStats();
    assert.strictEqual(stats.total, 1);
    assert.strictEqual(stats.healthy, 1);
    assert.strictEqual(stats.unhealthy, 0);
    assert.ok(stats.byName.a);
    assert.strictEqual(stats.byName.a.connected, true);
  });

  it('should emit provider-registered event', () => {
    const registry = new ProviderRegistry();
    let eventData = null;
    registry.on('provider-registered', (data) => { eventData = data; });
    const provider = new MemoryProviderInterface();
    registry.register('test', provider);
    assert.ok(eventData);
    assert.strictEqual(eventData.name, 'test');
    assert.strictEqual(eventData.provider, provider);
  });

  it('should emit provider-unregistered event', async () => {
    const registry = new ProviderRegistry();
    let eventData = null;
    registry.on('provider-unregistered', (data) => { eventData = data; });
    registry.register('test', new MemoryProviderInterface());
    await registry.unregister('test');
    assert.ok(eventData);
    assert.strictEqual(eventData.name, 'test');
  });

  it('should shutdown gracefully', () => {
    const registry = new ProviderRegistry();
    registry.register('a', new MemoryProviderInterface());
    registry.shutdown();
    assert.strictEqual(registry._shutDown, true);
    assert.strictEqual(registry._providers.size, 0);
  });

  it('should expose REGISTRY_EVENTS', () => {
    assert.ok(ProviderRegistry.REGISTRY_EVENTS);
    assert.strictEqual(ProviderRegistry.REGISTRY_EVENTS.PROVIDER_REGISTERED, 'provider-registered');
    assert.strictEqual(ProviderRegistry.REGISTRY_EVENTS.PROVIDER_UNREGISTERED, 'provider-unregistered');
    assert.strictEqual(ProviderRegistry.REGISTRY_EVENTS.PROVIDER_HEALTH_CHANGED, 'provider-health-changed');
  });
});

describe('ProviderAdapterBase', () => {
  it('should create instance with config', () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 1, requestTimeoutMs: 5000 });
    assert.ok(adapter);
    assert.strictEqual(adapter._adapterConfig.maxRetries, 1);
    assert.strictEqual(adapter._adapterConfig.requestTimeoutMs, 5000);
    assert.strictEqual(adapter._adapterConfig.retryBaseDelayMs, 1000);
    assert.strictEqual(adapter._adapterConfig.maxRequestsPerMinute, 100);
    assert.strictEqual(adapter._adapterConfig.fallbackToLocal, true);
  });

  it('should classify errors correctly', () => {
    const adapter = new ProviderAdapterBase();
    assert.strictEqual(adapter._classifyError({ code: 'ECONNREFUSED' }), 'network');
    assert.strictEqual(adapter._classifyError({ code: 'ECONNRESET' }), 'network');
    assert.strictEqual(adapter._classifyError({ code: 'ETIMEDOUT' }), 'network');
    assert.strictEqual(adapter._classifyError({ code: 'ENOTFOUND' }), 'network');
    assert.strictEqual(adapter._classifyError({ statusCode: 401 }), 'auth');
    assert.strictEqual(adapter._classifyError({ statusCode: 403 }), 'auth');
    assert.strictEqual(adapter._classifyError({ statusCode: 429 }), 'rate-limit');
    assert.strictEqual(adapter._classifyError({ statusCode: 500 }), 'server');
    assert.strictEqual(adapter._classifyError({ statusCode: 502 }), 'server');
    assert.strictEqual(adapter._classifyError({ message: 'network error' }), 'network');
    assert.strictEqual(adapter._classifyError({ message: 'timeout exceeded' }), 'network');
    assert.strictEqual(adapter._classifyError({ message: 'auth failed' }), 'auth');
    assert.strictEqual(adapter._classifyError({ message: 'unauthorized access' }), 'auth');
    assert.strictEqual(adapter._classifyError({ message: 'forbidden' }), 'auth');
    assert.strictEqual(adapter._classifyError({ message: 'rate limit' }), 'rate-limit');
    assert.strictEqual(adapter._classifyError({ message: 'too many requests' }), 'rate-limit');
    assert.strictEqual(adapter._classifyError({ message: 'something else' }), 'unknown');
    assert.strictEqual(adapter._classifyError({}), 'unknown');
  });

  it('should rate limit requests', () => {
    const adapter = new ProviderAdapterBase({ maxRequestsPerMinute: 2 });
    assert.strictEqual(adapter._isRateLimited(), false);
    adapter._recordRequest();
    adapter._recordRequest();
    assert.strictEqual(adapter._isRateLimited(), true);
  });

  it('should retry on transient errors', async () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 2, retryBaseDelayMs: 10 });
    let attempts = 0;
    const result = await adapter._withRetry(() => {
      attempts++;
      if (attempts < 3) throw new Error('server error');
      return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3);
  });

  it('should not retry on auth errors', async () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 3, retryBaseDelayMs: 10 });
    let attempts = 0;
    await assert.rejects(async () => {
      await adapter._withRetry(() => {
        attempts++;
        const err = new Error('unauthorized');
        err.statusCode = 401;
        throw err;
      });
    }, /unauthorized/);
    assert.strictEqual(attempts, 1);
  });

  it('should throw on rate limit exceeded', async () => {
    const adapter = new ProviderAdapterBase({ maxRequestsPerMinute: 1, retryBaseDelayMs: 10 });
    adapter._recordRequest();
    await assert.rejects(async () => {
      await adapter._withRetry(() => Promise.resolve('ok'));
    }, /rate limit exceeded/);
  });

  it('should track metrics', async () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 0, retryBaseDelayMs: 10 });
    try {
      await adapter._withRetry(() => {
        const err = new Error('internal');
        err.statusCode = 500;
        throw err;
      });
    } catch (_e) { /* expected */ }
    const metrics = adapter.getMetrics();
    assert.strictEqual(metrics.requestCount, 1);
    assert.strictEqual(metrics.errorCount, 1);
    assert.ok(metrics.byErrorType.server >= 1);
  });

  it('should request with timeout', async () => {
    const adapter = new ProviderAdapterBase({ requestTimeoutMs: 50 });
    const result = await adapter._requestWithTimeout(() => Promise.resolve('fast'), 100);
    assert.strictEqual(result, 'fast');
  });

  it('should timeout on slow request', async () => {
    const adapter = new ProviderAdapterBase({ requestTimeoutMs: 10 });
    await assert.rejects(async () => {
      await adapter._requestWithTimeout(() => new Promise((resolve) => {
        setTimeout(resolve, 200);
      }));
    }, /request timeout/);
  });

  it('should fallback to local on recall failure', async () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 0, retryBaseDelayMs: 10, fallbackToLocal: true });
    adapter._doRecall = () => { throw new Error('fail'); };
    const result = await adapter.recall('test');
    assert.deepStrictEqual(result, []);
  });

  it('should fallback to local on write failure', async () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 0, retryBaseDelayMs: 10, fallbackToLocal: true });
    adapter._doWrite = () => { throw new Error('fail'); };
    const result = await adapter.write({ content: 'test' });
    assert.deepStrictEqual(result, { success: false, id: null });
  });

  it('should throw on recall failure when fallbackToLocal is false', async () => {
    const adapter = new ProviderAdapterBase({ maxRetries: 0, retryBaseDelayMs: 10, fallbackToLocal: false });
    adapter._doRecall = () => { throw new Error('fail'); };
    await assert.rejects(async () => {
      await adapter.recall('test');
    }, /fail/);
  });

  it('should shutdown gracefully', () => {
    const adapter = new ProviderAdapterBase();
    adapter.on('test', () => {});
    adapter.shutdown();
    assert.strictEqual(adapter._shutDown, true);
  });

  it('should expose ERROR_TYPES and DEFAULT_ADAPTER_CONFIG', () => {
    assert.ok(ProviderAdapterBase.ERROR_TYPES);
    assert.strictEqual(ProviderAdapterBase.ERROR_TYPES.NETWORK, 'network');
    assert.strictEqual(ProviderAdapterBase.ERROR_TYPES.AUTH, 'auth');
    assert.strictEqual(ProviderAdapterBase.ERROR_TYPES.RATE_LIMIT, 'rate-limit');
    assert.strictEqual(ProviderAdapterBase.ERROR_TYPES.SERVER, 'server');
    assert.strictEqual(ProviderAdapterBase.ERROR_TYPES.UNKNOWN, 'unknown');
    assert.ok(ProviderAdapterBase.DEFAULT_ADAPTER_CONFIG);
    assert.strictEqual(ProviderAdapterBase.DEFAULT_ADAPTER_CONFIG.maxRetries, 3);
  });
});

describe('Mem0Adapter', () => {
  it('should create instance with config', () => {
    const adapter = new Mem0Adapter({ apiKey: 'test-key', userId: 'user1' });
    assert.ok(adapter);
    assert.strictEqual(adapter._mem0Config.apiKey, 'test-key');
    assert.strictEqual(adapter._mem0Config.userId, 'user1');
    assert.strictEqual(adapter._mem0Config.endpoint, 'https://api.mem0.ai');
  });

  it('should return name mem0', () => {
    const adapter = new Mem0Adapter();
    assert.strictEqual(adapter.getName(), 'mem0');
  });

  it('should return correct capabilities', () => {
    const adapter = new Mem0Adapter();
    const caps = adapter.getCapabilities();
    assert.strictEqual(caps.recall, true);
    assert.strictEqual(caps.write, true);
    assert.strictEqual(caps.sync, true);
    assert.strictEqual(caps.semanticSearch, true);
    assert.strictEqual(caps.userIsolation, true);
  });

  it('should build correct headers', () => {
    const adapter = new Mem0Adapter({ apiKey: 'my-key' });
    const headers = adapter._buildHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], 'Token my-key');
  });

  it('should build headers without api key', () => {
    const adapter = new Mem0Adapter();
    const headers = adapter._buildHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], undefined);
  });

  it('should handle connect failure gracefully', async () => {
    const adapter = new Mem0Adapter({ endpoint: 'http://127.0.0.1:1', apiKey: 'key' });
    await assert.rejects(async () => {
      await adapter.connect();
    });
    assert.strictEqual(adapter.isConnected(), false);
  });

  it('should shutdown gracefully', () => {
    const adapter = new Mem0Adapter();
    adapter.shutdown();
    assert.strictEqual(adapter._shutDown, true);
  });

  it('should expose DEFAULT_MEM0_CONFIG', () => {
    assert.ok(Mem0Adapter.DEFAULT_MEM0_CONFIG);
    assert.strictEqual(Mem0Adapter.DEFAULT_MEM0_CONFIG.endpoint, 'https://api.mem0.ai');
  });
});

describe('HonchoAdapter', () => {
  it('should create instance with config', () => {
    const adapter = new HonchoAdapter({ apiKey: 'test-key', userId: 'user1' });
    assert.ok(adapter);
    assert.strictEqual(adapter._honchoConfig.apiKey, 'test-key');
    assert.strictEqual(adapter._honchoConfig.userId, 'user1');
    assert.strictEqual(adapter._honchoConfig.endpoint, 'https://api.honcho.ai');
  });

  it('should return name honcho', () => {
    const adapter = new HonchoAdapter();
    assert.strictEqual(adapter.getName(), 'honcho');
  });

  it('should return correct capabilities', () => {
    const adapter = new HonchoAdapter();
    const caps = adapter.getCapabilities();
    assert.strictEqual(caps.recall, true);
    assert.strictEqual(caps.write, true);
    assert.strictEqual(caps.sync, false);
    assert.strictEqual(caps.semanticSearch, true);
    assert.strictEqual(caps.userIsolation, true);
  });

  it('should build correct headers', () => {
    const adapter = new HonchoAdapter({ apiKey: 'my-key' });
    const headers = adapter._buildHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], 'Bearer my-key');
  });

  it('should build headers without api key', () => {
    const adapter = new HonchoAdapter();
    const headers = adapter._buildHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], undefined);
  });

  it('should build user path correctly', () => {
    const adapter = new HonchoAdapter({ userId: 'u1' });
    assert.strictEqual(adapter._userPath(), '/users/u1');
  });

  it('should handle connect without userId', async () => {
    const adapter = new HonchoAdapter({ endpoint: 'http://127.0.0.1:1' });
    await adapter.connect();
    assert.strictEqual(adapter.isConnected(), true);
  });

  it('should shutdown gracefully', () => {
    const adapter = new HonchoAdapter();
    adapter.shutdown();
    assert.strictEqual(adapter._shutDown, true);
  });

  it('should expose DEFAULT_HONCHO_CONFIG', () => {
    assert.ok(HonchoAdapter.DEFAULT_HONCHO_CONFIG);
    assert.strictEqual(HonchoAdapter.DEFAULT_HONCHO_CONFIG.endpoint, 'https://api.honcho.ai');
  });
});

describe('HindsightAdapter', () => {
  it('should create instance with config', () => {
    const adapter = new HindsightAdapter({ apiKey: 'test-key', dataDir: '/data' });
    assert.ok(adapter);
    assert.strictEqual(adapter._hindsightConfig.apiKey, 'test-key');
    assert.strictEqual(adapter._hindsightConfig.dataDir, '/data');
    assert.strictEqual(adapter._hindsightConfig.endpoint, 'http://localhost:8100');
  });

  it('should return name hindsight', () => {
    const adapter = new HindsightAdapter();
    assert.strictEqual(adapter.getName(), 'hindsight');
  });

  it('should return correct capabilities', () => {
    const adapter = new HindsightAdapter();
    const caps = adapter.getCapabilities();
    assert.strictEqual(caps.recall, true);
    assert.strictEqual(caps.write, true);
    assert.strictEqual(caps.sync, true);
    assert.strictEqual(caps.semanticSearch, true);
    assert.strictEqual(caps.userIsolation, false);
  });

  it('should build correct headers', () => {
    const adapter = new HindsightAdapter({ apiKey: 'my-key' });
    const headers = adapter._buildHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], 'Bearer my-key');
  });

  it('should build headers without api key', () => {
    const adapter = new HindsightAdapter();
    const headers = adapter._buildHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], undefined);
  });

  it('should handle connect failure gracefully', async () => {
    const adapter = new HindsightAdapter({ endpoint: 'http://127.0.0.1:1' });
    await assert.rejects(async () => {
      await adapter.connect();
    });
    assert.strictEqual(adapter.isConnected(), false);
  });

  it('should shutdown gracefully', () => {
    const adapter = new HindsightAdapter();
    adapter.shutdown();
    assert.strictEqual(adapter._shutDown, true);
  });

  it('should expose DEFAULT_HINDSIGHT_CONFIG', () => {
    assert.ok(HindsightAdapter.DEFAULT_HINDSIGHT_CONFIG);
    assert.strictEqual(HindsightAdapter.DEFAULT_HINDSIGHT_CONFIG.endpoint, 'http://localhost:8100');
  });
});

describe('ProviderHealthChecker', () => {
  it('should create instance with config', () => {
    const registry = new ProviderRegistry();
    const checker = new ProviderHealthChecker(registry, { intervalMs: 5000, failureThreshold: 2 });
    assert.ok(checker);
    assert.strictEqual(checker._config.intervalMs, 5000);
    assert.strictEqual(checker._config.failureThreshold, 2);
    assert.strictEqual(checker._config.recoveryIntervalMs, 300000);
  });

  it('should track health status', async () => {
    const registry = new ProviderRegistry();
    const provider = new MemoryProviderInterface();
    registry.register('test', provider);
    await provider.connect();
    const checker = new ProviderHealthChecker(registry);
    await checker._checkOne('test', provider);
    const status = checker.getStatus('test');
    assert.strictEqual(status.state, 'closed');
    assert.strictEqual(status.consecutiveFailures, 0);
  });

  it('should return default status for unknown provider', () => {
    const registry = new ProviderRegistry();
    const checker = new ProviderHealthChecker(registry);
    const status = checker.getStatus('unknown');
    assert.strictEqual(status.state, 'closed');
    assert.strictEqual(status.consecutiveFailures, 0);
    assert.strictEqual(status.lastCheck, null);
    assert.strictEqual(status.lastError, null);
    assert.strictEqual(status.openedAt, null);
  });

  it('should open circuit after threshold failures', async () => {
    const registry = new ProviderRegistry();
    const provider = {
      healthCheck: () => Promise.resolve({ healthy: false, latency: 100, error: 'down' }),
    };
    registry.register('test', provider);
    const checker = new ProviderHealthChecker(registry, { failureThreshold: 2 });
    await checker._checkOne('test', provider);
    await checker._checkOne('test', provider);
    const status = checker.getStatus('test');
    assert.strictEqual(status.state, 'open');
    assert.strictEqual(status.consecutiveFailures, 2);
  });

  it('should close circuit after recovery', async () => {
    const registry = new ProviderRegistry();
    let healthy = false;
    const provider = {
      healthCheck: () => Promise.resolve(
        healthy
          ? { healthy: true, latency: 10, error: null }
          : { healthy: false, latency: 100, error: 'down' },
      ),
    };
    registry.register('test', provider);
    const checker = new ProviderHealthChecker(registry, { failureThreshold: 2, recoveryIntervalMs: 0 });
    await checker._checkOne('test', provider);
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.getStatus('test').state, 'open');
    healthy = true;
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.getStatus('test').state, 'closed');
    assert.strictEqual(checker.getStatus('test').consecutiveFailures, 0);
  });

  it('should half-open circuit after recovery interval', async () => {
    const registry = new ProviderRegistry();
    let checkCount = 0;
    const provider = {
      healthCheck: () => {
        checkCount++;
        if (checkCount <= 1) return Promise.resolve({ healthy: false, latency: 100, error: 'down' });
        return Promise.resolve({ healthy: true, latency: 10, error: null });
      },
    };
    registry.register('test', provider);
    const checker = new ProviderHealthChecker(registry, { failureThreshold: 1, recoveryIntervalMs: 0 });
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.getStatus('test').state, 'open');
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.getStatus('test').state, 'closed');
  });

  it('should re-open circuit from half-open on failure', async () => {
    const registry = new ProviderRegistry();
    const provider = {
      healthCheck: () => Promise.resolve({ healthy: false, latency: 100, error: 'down' }),
    };
    registry.register('test', provider);
    const checker = new ProviderHealthChecker(registry, { failureThreshold: 1, recoveryIntervalMs: 0 });
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.getStatus('test').state, 'open');
    let eventFired = false;
    checker.on('provider-health-changed', (data) => {
      if (data.state === 'open' && data.name === 'test') eventFired = true;
    });
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.getStatus('test').state, 'open');
    assert.strictEqual(checker.getStatus('test').consecutiveFailures, 2);
    assert.ok(eventFired);
  });

  it('should report availability', async () => {
    const registry = new ProviderRegistry();
    const provider = {
      healthCheck: () => Promise.resolve({ healthy: false, latency: 100, error: 'down' }),
    };
    registry.register('test', provider);
    const checker = new ProviderHealthChecker(registry, { failureThreshold: 1 });
    assert.strictEqual(checker.isAvailable('test'), true);
    assert.strictEqual(checker.isCircuitOpen('test'), false);
    await checker._checkOne('test', provider);
    assert.strictEqual(checker.isAvailable('test'), false);
    assert.strictEqual(checker.isCircuitOpen('test'), true);
  });

  it('should emit provider-health-changed event on circuit open', async () => {
    const registry = new ProviderRegistry();
    const provider = {
      healthCheck: () => Promise.resolve({ healthy: false, latency: 100, error: 'down' }),
    };
    registry.register('test', provider);
    const checker = new ProviderHealthChecker(registry, { failureThreshold: 1 });
    let eventData = null;
    checker.on('provider-health-changed', (data) => { eventData = data; });
    await checker._checkOne('test', provider);
    assert.ok(eventData);
    assert.strictEqual(eventData.name, 'test');
    assert.strictEqual(eventData.state, 'open');
    assert.strictEqual(eventData.healthy, false);
  });

  it('should start and stop periodic checks', () => {
    const registry = new ProviderRegistry();
    const checker = new ProviderHealthChecker(registry, { intervalMs: 10 });
    checker.start();
    assert.ok(checker._timer);
    checker.stop();
    assert.strictEqual(checker._timer, null);
  });

  it('should not start duplicate timers', () => {
    const registry = new ProviderRegistry();
    const checker = new ProviderHealthChecker(registry, { intervalMs: 10 });
    checker.start();
    const firstTimer = checker._timer;
    checker.start();
    assert.strictEqual(checker._timer, firstTimer);
    checker.stop();
  });

  it('should shutdown gracefully', () => {
    const registry = new ProviderRegistry();
    const checker = new ProviderHealthChecker(registry);
    checker.start();
    checker.shutdown();
    assert.strictEqual(checker._shutDown, true);
    assert.strictEqual(checker._timer, null);
    assert.strictEqual(checker._statuses.size, 0);
    assert.strictEqual(checker._registry, null);
  });

  it('should expose CIRCUIT_STATES and DEFAULT_HEALTH_CHECK_CONFIG', () => {
    assert.ok(ProviderHealthChecker.CIRCUIT_STATES);
    assert.strictEqual(ProviderHealthChecker.CIRCUIT_STATES.CLOSED, 'closed');
    assert.strictEqual(ProviderHealthChecker.CIRCUIT_STATES.OPEN, 'open');
    assert.strictEqual(ProviderHealthChecker.CIRCUIT_STATES.HALF_OPEN, 'half-open');
    assert.ok(ProviderHealthChecker.DEFAULT_HEALTH_CHECK_CONFIG);
    assert.strictEqual(ProviderHealthChecker.DEFAULT_HEALTH_CHECK_CONFIG.intervalMs, 60000);
    assert.strictEqual(ProviderHealthChecker.DEFAULT_HEALTH_CHECK_CONFIG.failureThreshold, 3);
    assert.strictEqual(ProviderHealthChecker.DEFAULT_HEALTH_CHECK_CONFIG.recoveryIntervalMs, 300000);
  });
});
