'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentRuntime = require('../../../src/runtime/agent/agent-runtime');
const AgentLifecycleController = require('../../../src/runtime/agent/agent-lifecycle-controller');
const AgentSandbox = require('../../../src/runtime/agent/agent-sandbox');
const AgentMonitor = require('../../../src/runtime/agent/agent-monitor');
const AgentDeployment = require('../../../src/runtime/agent/agent-deployment');
const AgentStateManager = require('../../../src/runtime/agent/agent-state-manager');
const AgentWorkflowIntegration = require('../../../src/runtime/agent/agent-workflow-integration');
const { AgentError } = require('../../../src/errors');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-test-'));
}

describe('AgentRuntime', () => {
  let tmpDir;
  let runtime;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    runtime = new AgentRuntime(tmpDir);
  });

  after(() => {
    try { runtime.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should register an agent', () => {
    const agent = runtime.register('test-agent', { version: '1.0.0' });
    assert.equal(agent.id, 'test-agent');
    assert.equal(agent.state, AgentRuntime.STATES.CREATED);
    assert.equal(agent.version, '1.0.0');
  });

  it('should throw on duplicate registration', () => {
    assert.throws(() => runtime.register('test-agent', {}), (err) => {
      return err instanceof AgentError && err.code === 'AGENT_EXISTS';
    });
  });

  it('should get an agent', () => {
    const agent = runtime.get('test-agent');
    assert.ok(agent);
    assert.equal(agent.id, 'test-agent');
  });

  it('should return null for non-existent agent', () => {
    assert.equal(runtime.get('non-existent'), null);
  });

  it('should transition state', () => {
    runtime.register('transition-agent', {});
    runtime.transition('transition-agent', AgentRuntime.STATES.INITIALIZING);
    const agent = runtime.transition('transition-agent', AgentRuntime.STATES.RUNNING);
    assert.equal(agent.state, AgentRuntime.STATES.RUNNING);
    assert.ok(agent.startedAt);
  });

  it('should throw on invalid transition', () => {
    runtime.register('invalid-trans', {});
    assert.throws(() => runtime.transition('invalid-trans', AgentRuntime.STATES.RUNNING), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_TRANSITION';
    });
  });

  it('should allocate resources', () => {
    runtime.register('resource-agent', {});
    runtime.allocateResources('resource-agent', { memoryMB: 256, cpuPercent: 30 });
    const agent = runtime.get('resource-agent');
    assert.equal(agent.allocatedResources.memoryMB, 256);
    assert.equal(agent.allocatedResources.cpuPercent, 30);
  });

  it('should throw on resource exhaustion', () => {
    const smallRuntime = new AgentRuntime(tmpDir, { totalMemoryMB: 100 });
    smallRuntime.register('small-agent', {});
    assert.throws(() => smallRuntime.allocateResources('small-agent', { memoryMB: 200 }), (err) => {
      return err instanceof AgentError && err.code === 'RESOURCE_EXHAUSTED';
    });
    smallRuntime.shutdown();
  });

  it('should release resources', () => {
    runtime.register('release-agent', {});
    runtime.allocateResources('release-agent', { memoryMB: 128, cpuPercent: 20 });
    runtime.releaseResources('release-agent');
    const agent = runtime.get('release-agent');
    assert.deepEqual(agent.allocatedResources, {});
  });

  it('should check dependencies', () => {
    runtime.register('dep-parent', {});
    runtime.register('dep-child', { dependencies: ['dep-parent', 'dep-missing'] });
    runtime.transition('dep-parent', AgentRuntime.STATES.INITIALIZING);
    runtime.transition('dep-parent', AgentRuntime.STATES.RUNNING);

    const result = runtime.checkDependencies('dep-child');
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.missing, ['dep-missing']);
  });

  it('should set version', () => {
    runtime.register('version-agent', { version: '1.0.0' });
    const agent = runtime.setVersion('version-agent', '2.0.0');
    assert.equal(agent.version, '2.0.0');
  });

  it('should increment task count', () => {
    runtime.register('task-agent', {});
    const count = runtime.incrementTaskCount('task-agent');
    assert.equal(count, 1);
    assert.equal(runtime.incrementTaskCount('task-agent'), 2);
  });

  it('should set error info', () => {
    runtime.register('error-agent', {});
    runtime.setError('error-agent', { message: 'test error', code: 'TEST_ERR' });
    const agent = runtime.get('error-agent');
    assert.equal(agent.errorInfo.message, 'test error');
    assert.equal(agent.errorInfo.code, 'TEST_ERR');
  });

  it('should list agents with filter', () => {
    const running = runtime.listAgents({ state: AgentRuntime.STATES.RUNNING });
    assert.ok(running.length > 0);
    assert.ok(running.every(a => a.state === AgentRuntime.STATES.RUNNING));
  });

  it('should return stats', () => {
    const stats = runtime.getStats();
    assert.ok(stats.totalAgents > 0);
    assert.ok(stats.stateCounts);
    assert.ok(stats.resourcePool);
  });

  it('should unregister agent', async () => {
    runtime.register('unreg-agent', {});
    const result = runtime.unregister('unreg-agent');
    assert.equal(result, true);
    assert.equal(runtime.get('unreg-agent'), null);
  });

  it('should throw on unregister running agent', async () => {
    runtime.register('running-unreg', {});
    runtime.transition('running-unreg', AgentRuntime.STATES.INITIALIZING);
    runtime.transition('running-unreg', AgentRuntime.STATES.RUNNING);
    assert.throws(() => runtime.unregister('running-unreg'), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_STATE';
    });
  });

  it('should get resource pool', () => {
    const pool = runtime.getResourcePool();
    assert.ok(pool.totalMemoryMB > 0);
    assert.ok(typeof pool.usedMemoryMB === 'number');
  });

  it('should reject agentId with path traversal characters', () => {
    assert.throws(() => runtime.register('../etc', {}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
    assert.throws(() => runtime.register('agent/../../etc', {}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
    assert.throws(() => runtime.register('agent\\..\\etc', {}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
    assert.throws(() => runtime.register('agent with spaces', {}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
  });

  it('should accept valid agentId characters', () => {
    const agent = runtime.register('valid_agent-123', {});
    assert.equal(agent.id, 'valid_agent-123');
  });

  it('should throw RESOURCE_EXHAUSTED when max agents reached and none evictable', () => {
    const smallRuntime = new AgentRuntime(tmpDir, { totalMemoryMB: 4096 });
    for (let i = 0; i < AgentRuntime.MAX_AGENTS; i++) {
      smallRuntime.register('max-agent-' + i, {});
      smallRuntime.transition('max-agent-' + i, AgentRuntime.STATES.INITIALIZING);
      smallRuntime.transition('max-agent-' + i, AgentRuntime.STATES.RUNNING);
    }
    assert.throws(() => smallRuntime.register('overflow-agent', {}), (err) => {
      return err instanceof AgentError && err.code === 'RESOURCE_EXHAUSTED';
    });
    smallRuntime.shutdown();
  });
});

describe('AgentLifecycleController', () => {
  let tmpDir;
  let runtime;
  let stateManager;
  let sandbox;
  let lifecycle;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    runtime = new AgentRuntime(tmpDir);
    stateManager = new AgentStateManager(tmpDir);
    sandbox = new AgentSandbox(tmpDir);
    lifecycle = new AgentLifecycleController(runtime, stateManager, sandbox);
  });

  after(() => {
    try { lifecycle.shutdown(); } catch (_e) { /* best effort */ }
    try { runtime.shutdown(); } catch (_e) { /* best effort */ }
    try { stateManager.shutdown(); } catch (_e) { /* best effort */ }
    try { sandbox.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should create an agent', () => {
    const agent = lifecycle.create('lc-agent', { version: '1.0.0' });
    assert.equal(agent.id, 'lc-agent');
    assert.equal(agent.state, AgentRuntime.STATES.CREATED);
  });

  it('should start an agent', () => {
    const agent = lifecycle.start('lc-agent');
    assert.equal(agent.state, AgentRuntime.STATES.RUNNING);
    assert.ok(agent.startedAt);
  });

  it('should pause an agent', () => {
    const agent = lifecycle.pause('lc-agent');
    assert.equal(agent.state, AgentRuntime.STATES.PAUSED);
  });

  it('should resume an agent', () => {
    const agent = lifecycle.resume('lc-agent');
    assert.equal(agent.state, AgentRuntime.STATES.RUNNING);
  });

  it('should stop an agent', () => {
    const agent = lifecycle.stop('lc-agent');
    assert.equal(agent.state, AgentRuntime.STATES.STOPPED);
  });

  it('should restart an agent', () => {
    lifecycle.start('lc-agent');
    const agent = lifecycle.restart('lc-agent');
    assert.equal(agent.state, AgentRuntime.STATES.RUNNING);
  });

  it('should destroy an agent', () => {
    lifecycle.stop('lc-agent');
    const result = lifecycle.destroy('lc-agent');
    assert.equal(result, true);
    assert.equal(runtime.get('lc-agent'), null);
  });

  it('should get status', () => {
    lifecycle.create('status-agent', {});
    const status = lifecycle.getStatus('status-agent');
    assert.ok(status);
    assert.equal(status.id, 'status-agent');
  });

  it('should record operation history', () => {
    lifecycle.create('history-agent', {});
    lifecycle.start('history-agent');
    const history = lifecycle.getOperationHistory('history-agent');
    assert.ok(history.length >= 2);
    assert.equal(history[0].operation, 'create');
    assert.equal(history[1].operation, 'start');
  });

  it('should throw on operation in progress', () => {
    lifecycle.create('lock-agent', {});
    lifecycle._acquireLock('lock-agent', 'test');
    assert.throws(() => lifecycle.start('lock-agent'), (err) => {
      return err instanceof AgentError && err.code === 'OPERATION_IN_PROGRESS';
    });
    lifecycle._releaseLock('lock-agent');
  });
});

describe('AgentSandbox', () => {
  let tmpDir;
  let sandbox;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    sandbox = new AgentSandbox(tmpDir);
  });

  after(() => {
    try { sandbox.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should prepare sandbox with default level', () => {
    const result = sandbox.prepare('sb-agent', {});
    assert.equal(result.ready, true);
    assert.equal(result.level, AgentSandbox.LEVELS.MODERATE);
  });

  it('should prepare sandbox with strict level', () => {
    const result = sandbox.prepare('strict-agent', { sandboxLevel: 'strict' });
    assert.equal(result.ready, true);
    assert.equal(result.level, AgentSandbox.LEVELS.STRICT);
  });

  it('should check filesystem access', () => {
    sandbox.prepare('fs-agent', { sandboxLevel: 'strict' });
    const readResult = sandbox.checkAccess('fs-agent', 'filesystem', 'read');
    assert.equal(readResult.allowed, false);
    const writeResult = sandbox.checkAccess('fs-agent', 'filesystem', 'write');
    assert.equal(writeResult.allowed, false);
  });

  it('should check network access', () => {
    sandbox.prepare('net-agent', { sandboxLevel: 'moderate' });
    const result = sandbox.checkAccess('net-agent', 'network', 'connect');
    assert.equal(result.allowed, false);
  });

  it('should check module access', () => {
    sandbox.prepare('mod-agent', { sandboxLevel: 'strict' });
    const blocked = sandbox.checkAccess('mod-agent', 'module', 'child_process');
    assert.equal(blocked.allowed, false);
  });

  it('should validate paths', () => {
    sandbox.prepare('path-agent', {});
    const valid = sandbox.validatePath('path-agent', path.join(tmpDir, 'src', 'file.js'));
    assert.equal(valid.valid, true);

    const invalid = sandbox.validatePath('path-agent', '/etc/passwd');
    assert.equal(invalid.valid, false);
  });

  it('should set custom policy with whitelisted keys only', () => {
    sandbox.prepare('custom-agent', { sandboxLevel: 'moderate' });
    const originalPolicy = Object.assign({}, sandbox.getPolicy('custom-agent'));
    sandbox.setCustomPolicy('custom-agent', { maxMemoryMB: 1024, allowFileSystem: true });
    const policy = sandbox.getPolicy('custom-agent');
    assert.equal(policy.maxMemoryMB, 1024);
    assert.equal(policy.allowFileSystem, originalPolicy.allowFileSystem);
  });

  it('should reject invalid policy overrides', () => {
    sandbox.prepare('policy-validation-agent', {});
    assert.throws(() => sandbox.setCustomPolicy('policy-validation-agent', null), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_POLICY';
    });
    assert.throws(() => sandbox.setCustomPolicy('policy-validation-agent', 'invalid'), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_POLICY';
    });
  });

  it('should cleanup sandbox', () => {
    sandbox.prepare('cleanup-agent', {});
    const result = sandbox.cleanup('cleanup-agent');
    assert.equal(result, true);
    assert.equal(sandbox.getSandbox('cleanup-agent'), null);
  });

  it('should track access logs', () => {
    sandbox.prepare('log-agent', { sandboxLevel: 'strict' });
    sandbox.checkAccess('log-agent', 'filesystem', 'read');
    sandbox.checkAccess('log-agent', 'network', 'connect');
    const logs = sandbox.getAccessLog('log-agent');
    assert.ok(logs.length >= 2);
  });

  it('should return stats', () => {
    const stats = sandbox.getStats();
    assert.ok(typeof stats.totalSandboxes === 'number');
    assert.ok(typeof stats.totalViolations === 'number');
  });

  it('should reject invalid agentId', () => {
    assert.throws(() => sandbox.prepare('', {}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
    assert.throws(() => sandbox.prepare(null, {}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
  });

  it('should reject invalid sandbox level', () => {
    assert.throws(() => sandbox.prepare('invalid-level-agent', { sandboxLevel: 'invalid' }), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_SANDBOX_LEVEL';
    });
  });
});

describe('AgentMonitor', () => {
  let tmpDir;
  let monitor;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    monitor = new AgentMonitor(tmpDir);
  });

  after(() => {
    try { monitor.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should register agent for monitoring', () => {
    const result = monitor.registerAgent('mon-agent');
    assert.ok(result);
    assert.equal(result.agentId, 'mon-agent');
  });

  it('should throw on duplicate monitoring registration', () => {
    assert.throws(() => monitor.registerAgent('mon-agent'), (err) => {
      return err instanceof AgentError && err.code === 'AGENT_ALREADY_MONITORED';
    });
  });

  it('should record metrics', () => {
    monitor.recordMetric('mon-agent', AgentMonitor.METRIC_TYPES.CPU, 45.5);
    monitor.recordMetric('mon-agent', AgentMonitor.METRIC_TYPES.MEMORY, 256);
    const metrics = monitor.getMetrics('mon-agent');
    assert.equal(metrics.currentMetrics.cpuPercent, 45.5);
    assert.equal(metrics.currentMetrics.memoryMB, 256);
  });

  it('should record multiple metrics at once', () => {
    monitor.registerAgent('batch-agent');
    monitor.recordMetrics('batch-agent', {
      cpu: 30,
      memory: 128,
      task_count: 5,
    });
    const metrics = monitor.getMetrics('batch-agent');
    assert.equal(metrics.currentMetrics.cpuPercent, 30);
    assert.equal(metrics.currentMetrics.memoryMB, 128);
    assert.equal(metrics.currentMetrics.taskCount, 5);
  });

  it('should log events', () => {
    monitor.logEvent('mon-agent', 'info', 'Test log message');
    monitor.logEvent('mon-agent', 'error', 'Test error message');
    const logs = monitor.getLogs('mon-agent');
    assert.ok(logs.length >= 2);
    const errorLogs = monitor.getLogs('mon-agent', { level: 'error' });
    assert.ok(errorLogs.length >= 1);
    assert.equal(errorLogs[0].level, 'error');
  });

  it('should generate alerts on threshold breach', () => {
    monitor.registerAgent('alert-agent');
    monitor.recordMetric('alert-agent', AgentMonitor.METRIC_TYPES.CPU, 95);
    const alerts = monitor.getAlerts({ agentId: 'alert-agent' });
    assert.ok(alerts.length > 0);
    assert.equal(alerts[0].level, AgentMonitor.ALERT_LEVELS.CRITICAL);
  });

  it('should return dashboard data', () => {
    const data = monitor.getDashboardData();
    assert.ok(data.agents);
    assert.ok(data.recentAlerts);
    assert.ok(data.thresholds);
  });

  it('should return stats', () => {
    const stats = monitor.getStats();
    assert.ok(stats.monitoredAgents > 0);
    assert.ok(typeof stats.totalAlerts === 'number');
  });

  it('should unregister agent', () => {
    monitor.registerAgent('unreg-mon');
    monitor.unregisterAgent('unreg-mon');
    assert.equal(monitor.getMetrics('unreg-mon'), null);
  });

  it('should set and get thresholds', () => {
    monitor.setThreshold('customMetric', 50, 80);
    const thresholds = monitor.getThresholds();
    assert.equal(thresholds.customMetric.warning, 50);
    assert.equal(thresholds.customMetric.critical, 80);
  });

  it('should reject invalid agentId', () => {
    assert.throws(() => monitor.registerAgent(''), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
    assert.throws(() => monitor.registerAgent(null), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_AGENT_ID';
    });
  });
});

describe('AgentDeployment', () => {
  let tmpDir;
  let deployment;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    deployment = new AgentDeployment(tmpDir);
  });

  after(() => {
    try { deployment.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should deploy to development environment', async () => {
    const result = deployment.deploy('deploy-agent', AgentDeployment.ENVIRONMENTS.DEVELOPMENT);
    assert.ok(result.id);
    assert.equal(result.agentId, 'deploy-agent');
    assert.equal(result.targetEnv, AgentDeployment.ENVIRONMENTS.DEVELOPMENT);
    await new Promise(resolve => process.nextTick(resolve));
    assert.equal(result.state, AgentDeployment.STATES.COMPLETED);
  });

  it('should deploy with canary strategy', () => {
    const result = deployment.deploy('canary-agent', AgentDeployment.ENVIRONMENTS.PRODUCTION, {
      strategy: AgentDeployment.STRATEGIES.CANARY,
      canaryPercent: 20,
    });
    assert.equal(result.strategy, AgentDeployment.STRATEGIES.CANARY);
    assert.equal(result.canaryPercent, 20);
  });

  it('should throw on invalid environment', () => {
    assert.throws(() => deployment.deploy('test', 'invalid-env'), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_ENVIRONMENT';
    });
  });

  it('should get deployment', () => {
    const dep = deployment.deploy('get-agent', AgentDeployment.ENVIRONMENTS.TESTING);
    const found = deployment.getDeployment(dep.id);
    assert.ok(found);
    assert.equal(found.id, dep.id);
  });

  it('should list deployments', () => {
    const list = deployment.listDeployments();
    assert.ok(list.length > 0);
  });

  it('should list deployments with filter', () => {
    const list = deployment.listDeployments({ targetEnv: AgentDeployment.ENVIRONMENTS.DEVELOPMENT });
    assert.ok(list.every(d => d.targetEnv === AgentDeployment.ENVIRONMENTS.DEVELOPMENT));
  });

  it('should lock and unlock environment', () => {
    deployment.lockEnvironment(AgentDeployment.ENVIRONMENTS.STAGING);
    const state = deployment.getEnvironmentState(AgentDeployment.ENVIRONMENTS.STAGING);
    assert.equal(state.locked, true);

    deployment.unlockEnvironment(AgentDeployment.ENVIRONMENTS.STAGING);
    const unlockedState = deployment.getEnvironmentState(AgentDeployment.ENVIRONMENTS.STAGING);
    assert.equal(unlockedState.locked, false);
  });

  it('should throw when deploying to locked environment', () => {
    deployment.lockEnvironment(AgentDeployment.ENVIRONMENTS.STAGING);
    assert.throws(() => deployment.deploy('locked-agent', AgentDeployment.ENVIRONMENTS.STAGING), (err) => {
      return err instanceof AgentError && err.code === 'ENVIRONMENT_LOCKED';
    });
    deployment.unlockEnvironment(AgentDeployment.ENVIRONMENTS.STAGING);
  });

  it('should register and get version history', () => {
    deployment.registerVersion('ver-agent', '1.0.0', { notes: 'Initial' });
    deployment.registerVersion('ver-agent', '1.1.0', { notes: 'Update' });
    const history = deployment.getVersionHistory('ver-agent');
    assert.equal(history.length, 2);
  });

  it('should get environment state', () => {
    const state = deployment.getEnvironmentState(AgentDeployment.ENVIRONMENTS.DEVELOPMENT);
    assert.ok(state);
    assert.equal(state.environment, AgentDeployment.ENVIRONMENTS.DEVELOPMENT);
  });

  it('should return stats', () => {
    const stats = deployment.getStats();
    assert.ok(stats.totalDeployments > 0);
    assert.ok(stats.stateCounts);
  });
});

describe('AgentStateManager', () => {
  let tmpDir;
  let stateManager;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    stateManager = new AgentStateManager(tmpDir);
  });

  after(() => {
    try { stateManager.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should save and load state', () => {
    stateManager.saveState('state-agent', { phase: 'running', data: 'test' }, { immediate: true });
    const loaded = stateManager.loadState('state-agent');
    assert.ok(loaded);
    assert.equal(loaded.phase, 'running');
    assert.equal(loaded.data, 'test');
  });

  it('should update existing state', () => {
    stateManager.saveState('update-agent', { count: 1 }, { immediate: true });
    stateManager.saveState('update-agent', { count: 2, extra: 'added' }, { immediate: true });
    const loaded = stateManager.loadState('update-agent');
    assert.equal(loaded.count, 2);
    assert.equal(loaded.extra, 'added');
  });

  it('should check state existence', () => {
    stateManager.saveState('exists-agent', { test: true }, { immediate: true });
    assert.equal(stateManager.hasState('exists-agent'), true);
    assert.equal(stateManager.hasState('no-such-agent'), false);
  });

  it('should delete state', () => {
    stateManager.saveState('delete-agent', { test: true }, { immediate: true });
    const result = stateManager.deleteState('delete-agent');
    assert.equal(result, true);
    assert.equal(stateManager.hasState('delete-agent'), false);
  });

  it('should create and list snapshots', () => {
    stateManager.saveState('snap-agent', { value: 1 }, { immediate: true });
    const snap = stateManager.createSnapshot('snap-agent', 'First snapshot');
    assert.ok(snap.id);
    assert.equal(snap.label, 'First snapshot');

    const snapshots = stateManager.listSnapshots('snap-agent');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, snap.id);
  });

  it('should restore snapshot', () => {
    stateManager.saveState('restore-agent', { value: 1 }, { immediate: true });
    stateManager.createSnapshot('restore-agent', 'Before change');
    stateManager.saveState('restore-agent', { value: 2 }, { immediate: true });

    const snapshots = stateManager.listSnapshots('restore-agent');
    const restored = stateManager.restoreSnapshot('restore-agent', snapshots[0].id);
    assert.equal(restored.value, 1);
  });

  it('should delete snapshot', () => {
    stateManager.saveState('del-snap-agent', { test: true }, { immediate: true });
    const snap = stateManager.createSnapshot('del-snap-agent', 'To delete');
    const result = stateManager.deleteSnapshot('del-snap-agent', snap.id);
    assert.equal(result, true);
    assert.equal(stateManager.listSnapshots('del-snap-agent').length, 0);
  });

  it('should sync state', () => {
    stateManager.saveState('sync-agent', { local: true, version: 1 }, { immediate: true });
    const result = stateManager.syncState('sync-agent', { remote: true, updatedAt: new Date(Date.now() + 10000).toISOString() });
    assert.ok(result.data.remote);
    assert.ok(result.data.local);
  });

  it('should list agents with state', () => {
    stateManager.saveState('list-agent', { test: true }, { immediate: true });
    const agents = stateManager.listAgents();
    assert.ok(agents.includes('list-agent'));
  });

  it('should get state info', () => {
    stateManager.saveState('info-agent', { test: true }, { immediate: true });
    const info = stateManager.getStateInfo('info-agent');
    assert.ok(info);
    assert.equal(info.agentId, 'info-agent');
    assert.ok(info.checksum);
  });

  it('should return stats', () => {
    const stats = stateManager.getStats();
    assert.ok(stats.totalAgents > 0);
    assert.ok(typeof stats.totalDataSize === 'number');
  });

  it('should throw on state too large', () => {
    const largeData = { data: 'x'.repeat(1024 * 1024 + 1) };
    assert.throws(() => stateManager.saveState('large-agent', largeData), (err) => {
      return err instanceof AgentError && err.code === 'STATE_TOO_LARGE';
    });
  });
});

describe('AgentWorkflowIntegration', () => {
  let tmpDir;
  let workflow;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    workflow = new AgentWorkflowIntegration(tmpDir);
  });

  after(() => {
    try { workflow.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should register adapter', () => {
    const adapter = workflow.registerAdapter('wf-agent', {
      onTask: (_task) => ({ success: true, data: 'result' }),
      capabilities: ['task-execution'],
    });
    assert.equal(adapter.agentId, 'wf-agent');
    assert.deepEqual(adapter.capabilities, ['task-execution']);
  });

  it('should overwrite duplicate adapter', () => {
    const adapter = workflow.registerAdapter('wf-agent', { capabilities: ['updated'] });
    assert.deepEqual(adapter.capabilities, ['updated']);
  });

  it('should submit and execute task', () => {
    const task = workflow.submitTask({
      agentId: 'wf-agent',
      type: 'test-task',
      payload: { key: 'value' },
    });
    assert.ok(task.id);
    assert.equal(task.agentId, 'wf-agent');
  });

  it('should throw on task without agentId', () => {
    assert.throws(() => workflow.submitTask({}), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_TASK';
    });
  });

  it('should throw on task with unregistered adapter', () => {
    assert.throws(() => workflow.submitTask({ agentId: 'unknown-agent' }), (err) => {
      return err instanceof AgentError && err.code === 'ADAPTER_NOT_FOUND';
    });
  });

  it('should get task', () => {
    const task = workflow.submitTask({ agentId: 'wf-agent', type: 'get-test' });
    const found = workflow.getTask(task.id);
    assert.ok(found);
    assert.equal(found.id, task.id);
  });

  it('should list tasks', () => {
    const tasks = workflow.listTasks();
    assert.ok(tasks.length > 0);
  });

  it('should list tasks with filter', () => {
    const tasks = workflow.listTasks({ agentId: 'wf-agent' });
    assert.ok(tasks.every(t => t.agentId === 'wf-agent'));
  });

  it('should subscribe and emit events', () => {
    let received = null;
    workflow.registerAdapter('event-agent', {
      onEvent: (event) => { received = event; },
    });
    workflow.subscribeEvent('event-agent', 'test.event');
    workflow.emitEvent('test.event', { message: 'hello' });
    assert.ok(received);
    assert.equal(received.type, 'test.event');
    assert.equal(received.data.message, 'hello');
  });

  it('should add and remove schedule', () => {
    const schedule = workflow.addSchedule('wf-agent', {
      intervalMs: 60000,
      taskType: 'periodic',
    });
    assert.ok(schedule.id);
    assert.equal(schedule.agentId, 'wf-agent');

    const removed = workflow.removeSchedule(schedule.id);
    assert.equal(removed, true);
  });

  it('should submit feedback', () => {
    workflow.registerAdapter('fb-agent', {
      onTask: () => ({ success: true, data: 'ok' }),
    });
    const task = workflow.submitTask({ agentId: 'fb-agent', type: 'fb-test' });
    const feedback = workflow.submitFeedback(task.id, {
      type: AgentWorkflowIntegration.FEEDBACK_TYPES.SUCCESS,
      result: { output: 'done' },
      message: 'Task completed successfully',
    });
    assert.equal(feedback.type, AgentWorkflowIntegration.FEEDBACK_TYPES.SUCCESS);
  });

  it('should get feedback history', () => {
    const history = workflow.getFeedbackHistory();
    assert.ok(Array.isArray(history));
  });

  it('should cancel task', () => {
    let resolveTask;
    workflow.registerAdapter('cancel-agent', {
      onTask: () => new Promise((resolve) => { resolveTask = resolve; }),
    });
    const task = workflow.submitTask({ agentId: 'cancel-agent', type: 'cancel-test', trigger: AgentWorkflowIntegration.TRIGGER_TYPES.MANUAL });
    const cancelled = workflow.cancelTask(task.id);
    assert.equal(cancelled.state, AgentWorkflowIntegration.TASK_STATES.CANCELLED);
    if (resolveTask) resolveTask({ success: true });
  });

  it('should get adapter', () => {
    const adapter = workflow.getAdapter('wf-agent');
    assert.ok(adapter);
    assert.equal(adapter.agentId, 'wf-agent');
  });

  it('should unregister adapter', () => {
    workflow.registerAdapter('unreg-agent', {});
    const result = workflow.unregisterAdapter('unreg-agent');
    assert.equal(result, true);
    assert.equal(workflow.getAdapter('unreg-agent'), null);
  });

  it('should return stats', () => {
    const stats = workflow.getStats();
    assert.ok(stats.totalAdapters > 0);
    assert.ok(stats.totalTasks > 0);
  });
});

describe('AgentError', () => {
  it('should be instance of HarnessError', () => {
    const { HarnessError } = require('../../../src/errors');
    const err = new AgentError('TEST', 'test message');
    assert.ok(err instanceof HarnessError);
    assert.equal(err.code, 'TEST');
    assert.equal(err.message, 'test message');
    assert.equal(err.name, 'AgentError');
  });
});

describe('Agent Lifecycle Integration', () => {
  let tmpDir;
  let runtime;
  let lifecycle;
  let stateManager;
  let sandbox;
  let monitor;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    runtime = new AgentRuntime(tmpDir);
    stateManager = new AgentStateManager(tmpDir);
    sandbox = new AgentSandbox(tmpDir);
    monitor = new AgentMonitor(tmpDir);
    lifecycle = new AgentLifecycleController(runtime, stateManager, sandbox);
  });

  after(() => {
    try { lifecycle.shutdown(); } catch (_e) { /* best effort */ }
    try { runtime.shutdown(); } catch (_e) { /* best effort */ }
    try { stateManager.shutdown(); } catch (_e) { /* best effort */ }
    try { sandbox.shutdown(); } catch (_e) { /* best effort */ }
    try { monitor.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should complete full lifecycle: create -> start -> pause -> resume -> stop -> destroy', () => {
    lifecycle.create('full-lc-agent', { version: '1.0.0', resourceLimits: { maxMemoryMB: 256, maxCpuPercent: 50 } });

    const started = lifecycle.start('full-lc-agent');
    assert.equal(started.state, AgentRuntime.STATES.RUNNING);

    const paused = lifecycle.pause('full-lc-agent');
    assert.equal(paused.state, AgentRuntime.STATES.PAUSED);

    const resumed = lifecycle.resume('full-lc-agent');
    assert.equal(resumed.state, AgentRuntime.STATES.RUNNING);

    const stopped = lifecycle.stop('full-lc-agent');
    assert.equal(stopped.state, AgentRuntime.STATES.STOPPED);

    const destroyed = lifecycle.destroy('full-lc-agent');
    assert.equal(destroyed, true);
    assert.equal(runtime.get('full-lc-agent'), null);
  });

  it('should persist and recover state across lifecycle', () => {
    lifecycle.create('persist-agent', { version: '2.0.0' });
    lifecycle.start('persist-agent');

    const state = stateManager.loadState('persist-agent');
    assert.ok(state);
    assert.equal(state.state, AgentRuntime.STATES.RUNNING);

    lifecycle.stop('persist-agent');
    lifecycle.destroy('persist-agent');
  });

  it('should enforce sandbox during lifecycle', () => {
    lifecycle.create('sandbox-lc-agent', { sandboxLevel: 'strict' });
    lifecycle.start('sandbox-lc-agent');

    const access = sandbox.checkAccess('sandbox-lc-agent', 'filesystem', 'write');
    assert.equal(access.allowed, false);

    lifecycle.stop('sandbox-lc-agent');
    lifecycle.destroy('sandbox-lc-agent');
  });

  it('should monitor agent during lifecycle', () => {
    monitor.registerAgent('mon-lc-agent');
    lifecycle.create('mon-lc-agent', {});
    lifecycle.start('mon-lc-agent');

    monitor.recordMetric('mon-lc-agent', AgentMonitor.METRIC_TYPES.CPU, 50);
    monitor.recordMetric('mon-lc-agent', AgentMonitor.METRIC_TYPES.MEMORY, 256);

    const metrics = monitor.getMetrics('mon-lc-agent');
    assert.equal(metrics.currentMetrics.cpuPercent, 50);
    assert.equal(metrics.currentMetrics.memoryMB, 256);

    lifecycle.stop('mon-lc-agent');
    lifecycle.destroy('mon-lc-agent');
    monitor.unregisterAgent('mon-lc-agent');
  });
});

describe('AgentRuntime - allocateResources validation', () => {
  let tmpDir;
  let runtime;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    runtime = new AgentRuntime(tmpDir);
  });

  after(() => {
    try { runtime.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should handle non-number memoryMB gracefully', () => {
    runtime.register('type-test-1', {});
    runtime.allocateResources('type-test-1', { memoryMB: 'abc', cpuPercent: 30 });
    const pool = runtime.getResourcePool();
    assert.ok(isFinite(pool.usedMemoryMB));
  });

  it('should handle negative cpuPercent gracefully', () => {
    runtime.register('type-test-2', {});
    runtime.allocateResources('type-test-2', { memoryMB: 128, cpuPercent: -10 });
    const pool = runtime.getResourcePool();
    assert.ok(pool.usedCpuPercent >= 0);
  });

  it('should handle NaN values gracefully', () => {
    runtime.register('type-test-3', {});
    runtime.allocateResources('type-test-3', { memoryMB: NaN, cpuPercent: NaN });
    const pool = runtime.getResourcePool();
    assert.ok(isFinite(pool.usedMemoryMB));
    assert.ok(isFinite(pool.usedCpuPercent));
  });
});

describe('AgentMonitor - setThreshold validation', () => {
  let tmpDir;
  let monitor;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    monitor = new AgentMonitor(tmpDir);
  });

  after(() => {
    try { monitor.shutdown(); } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should reject non-number threshold values', () => {
    assert.throws(() => monitor.setThreshold('test', 'abc', 80), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_THRESHOLD';
    });
  });

  it('should reject negative threshold values', () => {
    assert.throws(() => monitor.setThreshold('test', -10, 80), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_THRESHOLD';
    });
  });

  it('should reject warning >= critical', () => {
    assert.throws(() => monitor.setThreshold('test', 90, 80), (err) => {
      return err instanceof AgentError && err.code === 'INVALID_THRESHOLD';
    });
  });

  it('should accept valid threshold values', () => {
    monitor.setThreshold('valid', 50, 90);
    const thresholds = monitor.getThresholds();
    assert.equal(thresholds.valid.warning, 50);
    assert.equal(thresholds.valid.critical, 90);
  });
});

describe('AgentDeployment - shutdown and isHealthy', () => {
  let tmpDir;
  let deployment;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    deployment = new AgentDeployment(tmpDir);
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should have isHealthy return true before shutdown', () => {
    assert.equal(deployment.isHealthy(), true);
  });

  it('should shutdown cleanly', () => {
    deployment.shutdown();
    assert.equal(deployment.isHealthy(), false);
  });
});

describe('AgentWorkflowIntegration - shutdown and isHealthy', () => {
  let tmpDir;
  let workflow;

  before(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
    workflow = new AgentWorkflowIntegration(tmpDir);
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });

  it('should have isHealthy return true before shutdown', () => {
    assert.equal(workflow.isHealthy(), true);
  });

  it('should shutdown cleanly', () => {
    workflow.shutdown();
    assert.equal(workflow.isHealthy(), false);
  });
});

describe('EventBus - onceAsync', () => {
  const EventBus = require('../../../src/runtime/infrastructure/event-bus');

  it('should reject on timeout', async () => {
    const bus = new EventBus();
    await assert.rejects(
      () => bus.onceAsync('never-emitted', 50),
      { message: /timed out/ },
    );
  });

  it('should return timedOut:false when event fires', async () => {
    const bus = new EventBus();
    const promise = bus.onceAsync('test-event', 1000);
    setTimeout(() => bus.emit('test-event', { value: 42 }), 10);
    const result = await promise;
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.data, { value: 42 });
  });
});
