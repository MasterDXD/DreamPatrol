'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { CMAAdapterHub } = require('../../../src/runtime/adapter/cma-adapter');
const { CloudSessionBackup, BACKUP_EVENTS } = require('../../../src/runtime/adapter/cloud-session-backup');
const { VaultSecretProvider } = require('../../../src/runtime/adapter/vault-secret-provider');
const { CMAOutcomesBridge } = require('../../../src/runtime/adapter/cma-outcomes-bridge');
const { CMASessionProxy, PROXY_EVENTS } = require('../../../src/runtime/adapter/cma-session-proxy');

describe('CMAAdapterHub', () => {
  it('should create with default config when disabled', () => {
    const hub = new CMAAdapterHub();
    assert.strictEqual(hub.enabled, false);
    assert.strictEqual(hub.config.enabled, false);
  });

  it('should not initialize when disabled', async () => {
    const hub = new CMAAdapterHub({ enabled: false });
    await hub.initialize();
    assert.strictEqual(hub._initialized, false);
  });

  it('should not initialize without API key', async () => {
    const hub = new CMAAdapterHub({ enabled: true });
    await hub.initialize();
    assert.strictEqual(hub._initialized, false);
  });

  it('should initialize with enabled and API key', async () => {
    const hub = new CMAAdapterHub({ enabled: true, apiKey: 'test-key' });
    await hub.initialize();
    assert.strictEqual(hub._initialized, true);
  });

  it('should attach adapters', () => {
    const hub = new CMAAdapterHub({ enabled: true, apiKey: 'test-key' });
    const mock = { name: 'mock' };
    hub.attachSessionBackup(mock);
    hub.attachVaultSecret(mock);
    hub.attachOutcomesBridge(mock);
    hub.attachSessionProxy(mock);
    assert.strictEqual(hub.getSessionBackup(), mock);
    assert.strictEqual(hub.getVaultSecret(), mock);
    assert.strictEqual(hub.getOutcomesBridge(), mock);
    assert.strictEqual(hub.getSessionProxy(), mock);
  });

  it('should return status', () => {
    const hub = new CMAAdapterHub({ enabled: true, apiKey: 'test-key' });
    const status = hub.getStatus();
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.initialized, false);
    assert.strictEqual(status.sessionBackup, false);
  });

  it('should shutdown cleanly', () => {
    const hub = new CMAAdapterHub({ enabled: true, apiKey: 'test-key' });
    hub.attachSessionBackup({});
    hub.shutdown();
    assert.strictEqual(hub.getSessionBackup(), null);
    assert.strictEqual(hub._initialized, false);
  });
});

describe('CloudSessionBackup', () => {
  it('should create with default config', () => {
    const backup = new CloudSessionBackup();
    assert.strictEqual(backup.stats.backups, 0);
    assert.strictEqual(backup.stats.restores, 0);
  });

  it('should skip backup without API key', async () => {
    const backup = new CloudSessionBackup();
    const result = await backup.backup('sess-1', { phase: 'coding' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no-api-key');
  });

  it('should skip restore without API key', async () => {
    const backup = new CloudSessionBackup();
    const result = await backup.restore('sess-1');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no-api-key');
  });

  it('should initialize without API key', async () => {
    const backup = new CloudSessionBackup();
    const result = await backup.initialize();
    assert.strictEqual(result, false);
  });

  it('should emit backup-failed on API error', async () => {
    const backup = new CloudSessionBackup({ apiKey: 'test-key', agentId: 'agent-1', environmentId: 'env-1' });
    let eventFired = false;
    backup.on(BACKUP_EVENTS.BACKUP_FAILED, () => { eventFired = true; });
    const result = await backup.backup('sess-1', { phase: 'coding' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(eventFired, true);
  });

  it('should start and stop auto backup', () => {
    const backup = new CloudSessionBackup({ apiKey: 'test-key' });
    backup.startAutoBackup('sess-1', () => ({ phase: 'coding' }));
    assert.strictEqual(backup._backupTimers.has('sess-1'), true);
    backup.stopAutoBackup('sess-1');
    assert.strictEqual(backup._backupTimers.has('sess-1'), false);
  });

  it('should shutdown cleanly', () => {
    const backup = new CloudSessionBackup();
    backup.startAutoBackup('sess-1', () => ({}));
    backup._onShutdown();
    assert.strictEqual(backup._backupTimers.size, 0);
  });
});

describe('VaultSecretProvider', () => {
  it('should create with correct name', () => {
    const vault = new VaultSecretProvider();
    assert.strictEqual(vault.getName(), 'vault-secret-provider');
  });

  it('should report correct capabilities', () => {
    const vault = new VaultSecretProvider();
    const caps = vault.getCapabilities();
    assert.strictEqual(caps.recall, true);
    assert.strictEqual(caps.write, true);
    assert.strictEqual(caps.userIsolation, true);
  });

  it('should write to local cache without API key', async () => {
    const vault = new VaultSecretProvider();
    await vault.connect();
    const result = await vault.write({ key: 'test-key', value: 'test-value' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.id, 'test-key');
    assert.strictEqual(vault.stats.writes, 1);
  });

  it('should recall from local cache', async () => {
    const vault = new VaultSecretProvider();
    await vault.connect();
    await vault.write({ key: 'my-key', value: 'my-value' });
    const results = await vault.recall('my-key');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].key, 'my-key');
    assert.strictEqual(results[0].value, 'my-value');
    assert.strictEqual(vault.stats.cacheHits, 1);
  });

  it('should return empty for unknown key', async () => {
    const vault = new VaultSecretProvider();
    await vault.connect();
    const results = await vault.recall('unknown');
    assert.strictEqual(results.length, 0);
  });

  it('should reject write without key', async () => {
    const vault = new VaultSecretProvider();
    const result = await vault.write({ value: 'no-key' });
    assert.strictEqual(result.success, false);
  });

  it('should shutdown cleanly', () => {
    const vault = new VaultSecretProvider();
    vault._onShutdown();
    assert.strictEqual(vault._localCache.size, 0);
  });
});

describe('CMAOutcomesBridge', () => {
  it('should create with default config', () => {
    const bridge = new CMAOutcomesBridge();
    assert.strictEqual(bridge.stats.pushed, 0);
    assert.strictEqual(bridge.stats.pulled, 0);
  });

  it('should push outcome to pending queue', () => {
    const bridge = new CMAOutcomesBridge();
    const result = bridge.pushOutcome({ id: 'out-1', score: 0.9 });
    assert.strictEqual(result, true);
    assert.strictEqual(bridge._pendingOutcomes.length, 1);
  });

  it('should reject outcome without id', () => {
    const bridge = new CMAOutcomesBridge();
    const result = bridge.pushOutcome({ score: 0.9 });
    assert.strictEqual(result, false);
  });

  it('should skip sync without API key', async () => {
    const bridge = new CMAOutcomesBridge();
    bridge.pushOutcome({ id: 'out-1', score: 0.9 });
    const result = await bridge.syncPending();
    assert.strictEqual(result.pushed, 0);
    assert.strictEqual(result.pulled, 0);
  });

  it('should start and stop auto sync', () => {
    const bridge = new CMAOutcomesBridge({ apiKey: 'test-key' });
    bridge.startAutoSync();
    assert.strictEqual(bridge._syncTimer !== null, true);
    bridge.stopAutoSync();
    assert.strictEqual(bridge._syncTimer, null);
  });

  it('should attach dream outcomes and skill improvement loop', () => {
    const bridge = new CMAOutcomesBridge();
    bridge.attachDreamOutcomes({ name: 'dream' });
    bridge.attachSkillImprovementLoop({ name: 'loop' });
    assert.strictEqual(bridge._dreamOutcomes.name, 'dream');
    assert.strictEqual(bridge._skillImprovementLoop.name, 'loop');
  });

  it('should shutdown cleanly', () => {
    const bridge = new CMAOutcomesBridge({ apiKey: 'test-key' });
    bridge.startAutoSync();
    bridge.pushOutcome({ id: 'out-1', score: 0.9 });
    bridge._onShutdown();
    assert.strictEqual(bridge._syncTimer, null);
    assert.strictEqual(bridge._pendingOutcomes.length, 0);
  });
});

describe('CMASessionProxy', () => {
  it('should create with default config', () => {
    const proxy = new CMASessionProxy();
    assert.strictEqual(proxy.activeCount, 0);
    assert.strictEqual(proxy.stats.created, 0);
  });

  it('should reject execute without API key', async () => {
    const proxy = new CMASessionProxy();
    const result = await proxy.execute('test task');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no-api-key');
  });

  it('should initialize without API key', async () => {
    const proxy = new CMASessionProxy();
    const result = await proxy.initialize();
    assert.strictEqual(result, false);
  });

  it('should return null state for unknown session', () => {
    const proxy = new CMASessionProxy();
    assert.strictEqual(proxy.getSessionState('unknown'), null);
  });

  it('should emit session-failed on API error', async () => {
    const proxy = new CMASessionProxy({ apiKey: 'test-key', agentId: 'agent-1', environmentId: 'env-1' });
    let eventFired = false;
    proxy.on(PROXY_EVENTS.SESSION_FAILED, () => { eventFired = true; });
    const result = await proxy.execute('test task');
    assert.strictEqual(result.success, false);
    assert.strictEqual(eventFired, true);
  });

  it('should shutdown cleanly', () => {
    const proxy = new CMASessionProxy();
    proxy._onShutdown();
    assert.strictEqual(proxy._activeSessions.size, 0);
  });
});
