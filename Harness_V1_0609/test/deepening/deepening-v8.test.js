'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const DeepeningPluginSystem = require('../../src/runtime/deepening/deepening-plugin-system');
const DeepeningSecurityGuard = require('../../src/runtime/deepening/deepening-security-guard');
const DeepeningEventStore = require('../../src/runtime/deepening/deepening-event-store');
const DeepeningVisualizer = require('../../src/runtime/deepening/deepening-visualizer');
const DeepeningDeployment = require('../../src/runtime/deepening/deepening-deployment');

describe('DeepeningPluginSystem', () => {
  let pluginSystem;

  beforeEach(() => {
    pluginSystem = new DeepeningPluginSystem();
  });

  it('should register and unregister plugins', () => {
    const testPlugin = {
      hooks: {
        preDeepen: () => {},
      },
    };

    pluginSystem.registerPlugin('test', testPlugin);
    assert.strictEqual(pluginSystem.getPlugin('test'), testPlugin);
    assert.deepStrictEqual(pluginSystem.getAllPlugins(), ['test']);

    pluginSystem.unregisterPlugin('test');
    assert.strictEqual(pluginSystem.getPlugin('test'), undefined);
    assert.deepStrictEqual(pluginSystem.getAllPlugins(), []);
  });

  it('should execute hooks', async () => {
    let preDeepenCalled = false;
    let postDeepenCalled = false;

    pluginSystem.registerPlugin('test', {
      hooks: {
        preDeepen: () => { preDeepenCalled = true; },
        postDeepen: () => { postDeepenCalled = true; },
      },
    });

    await pluginSystem.executePreDeepen({});
    await pluginSystem.executePostDeepen({});

    assert.strictEqual(preDeepenCalled, true);
    assert.strictEqual(postDeepenCalled, true);
  });

  it('should get plugin stats', () => {
    pluginSystem.registerPlugin('test1', {
      hooks: {
        preDeepen: () => {},
      },
    });

    pluginSystem.registerPlugin('test2', {
      hooks: {
        postDeepen: () => {},
      },
    });

    const stats = pluginSystem.getPluginStats();
    assert.strictEqual(stats.totalPlugins, 2);
    assert.strictEqual(stats.hooks.preDeepen, 1);
    assert.strictEqual(stats.hooks.postDeepen, 1);
  });

  it('should clear all plugins', () => {
    pluginSystem.registerPlugin('test', {
      hooks: {
        preDeepen: () => {},
      },
    });

    assert.strictEqual(pluginSystem.getAllPlugins().length, 1);
    pluginSystem.clear();
    assert.strictEqual(pluginSystem.getAllPlugins().length, 0);
  });
});

describe('DeepeningSecurityGuard', () => {
  let securityGuard;

  beforeEach(() => {
    securityGuard = new DeepeningSecurityGuard();
  });

  it('should validate pipeline config', () => {
    const validConfig = {
      agents: ['analyst', 'worker'],
      maxIterations: 10,
    };

    assert.doesNotThrow(() => {
      securityGuard.validatePipelineConfig(validConfig);
    });

    const invalidConfig = {
      agents: [],
      maxIterations: 10,
    };

    assert.throws(() => {
      securityGuard.validatePipelineConfig(invalidConfig);
    });
  });

  it('should validate agent execution', () => {
    assert.throws(() => {
      securityGuard.validateAgentExecution('analyst', { task: 'test' });
    });

    securityGuard.addAllowedAgent('analyst');
    assert.doesNotThrow(() => {
      securityGuard.validateAgentExecution('analyst', { task: 'test' });
    });

    assert.throws(() => {
      securityGuard.validateAgentExecution('worker', { task: 'test' });
    });
  });

  it('should check execution limits', () => {
    const executionId = 'test-execution';
    securityGuard.startExecution(executionId);

    assert.doesNotThrow(() => {
      securityGuard.updateExecution(executionId);
      securityGuard.recordAgentCall(executionId);
    });

    securityGuard.endExecution(executionId);
    assert.strictEqual(securityGuard.getExecutionStats(executionId), null);
  });

  it('should check forbidden patterns', () => {
    securityGuard.addForbiddenPattern('secret');

    assert.throws(() => {
      securityGuard.checkForbiddenPatterns({ data: 'This contains a secret' });
    });

    assert.doesNotThrow(() => {
      securityGuard.checkForbiddenPatterns({ data: 'This is safe' });
    });
  });
});

describe('DeepeningEventStore (Persistence)', () => {
  let eventStore;
  const testPath = path.join(__dirname, 'test-events');

  beforeEach(() => {
    if (fs.existsSync(testPath)) {
      fs.rmSync(testPath, { recursive: true, force: true });
    }

    eventStore = new DeepeningEventStore({
      persistToDisk: true,
      persistPath: testPath,
    });
  });

  afterEach(() => {
    if (fs.existsSync(testPath)) {
      fs.rmSync(testPath, { recursive: true, force: true });
    }
  });

  it('should persist events to disk', () => {
    const event = eventStore.record('test-event', { data: 'test' });
    assert.strictEqual(event.type, 'test-event');
    eventStore.flush();

    const persistFilePath = path.join(testPath, 'deepening-events.json');
    assert.strictEqual(fs.existsSync(persistFilePath), true);

    const persistedData = JSON.parse(fs.readFileSync(persistFilePath, 'utf8'));
    assert.strictEqual(persistedData.events.length, 1);
    assert.strictEqual(persistedData.events[0].type, 'test-event');
  });

  it('should load events from disk', () => {
    eventStore.record('test-event-1', { data: 'test1' });
    eventStore.record('test-event-2', { data: 'test2' });
    eventStore.flush();

    const newEventStore = new DeepeningEventStore({
      persistToDisk: true,
      persistPath: testPath,
    });

    const events = newEventStore.query({ type: 'test-event-1' });
    assert.strictEqual(events.length, 1);
  });

  it('should clear persisted events', () => {
    eventStore.record('test-event', { data: 'test' });
    eventStore.clear();

    const persistFilePath = path.join(testPath, 'deepening-events.json');
    const persistedData = JSON.parse(fs.readFileSync(persistFilePath, 'utf8'));
    assert.strictEqual(persistedData.events.length, 0);
  });
});

describe('DeepeningVisualizer', () => {
  let eventStore;
  let visualizer;

  beforeEach(() => {
    eventStore = new DeepeningEventStore();
    visualizer = new DeepeningVisualizer(eventStore);
  });

  it('should generate execution graph', () => {
    const executionId = 'test-execution';
    eventStore.recordExecutionStart(executionId, { id: 'test-task' });
    eventStore.recordIterationComplete(executionId, 1, 0.5);
    eventStore.recordExecutionComplete(executionId, { result: 'test' });

    const graph = visualizer.generateExecutionGraph(executionId);
    assert.strictEqual(Array.isArray(graph.nodes), true);
    assert.strictEqual(Array.isArray(graph.edges), true);
    assert.strictEqual(graph.nodes.length > 0, true);
  });

  it('should generate convergence chart', () => {
    const executionId = 'test-execution';
    eventStore.recordIterationComplete(executionId, 1, 0.5);
    eventStore.recordIterationComplete(executionId, 2, 0.7);
    eventStore.recordIterationComplete(executionId, 3, 0.9);

    const chart = visualizer.generateConvergenceChart(executionId);
    assert.strictEqual(chart.type, 'line');
    assert.strictEqual(Array.isArray(chart.data.labels), true);
    assert.strictEqual(Array.isArray(chart.data.datasets), true);
  });

  it('should generate execution timeline', () => {
    const executionId = 'test-execution';
    eventStore.recordExecutionStart(executionId, { id: 'test-task' });
    eventStore.recordIterationComplete(executionId, 1, 0.5);

    const timeline = visualizer.generateExecutionTimeline(executionId);
    assert.strictEqual(Array.isArray(timeline), true);
    assert.strictEqual(timeline.length, 2);
  });

  it('should generate system health dashboard', () => {
    eventStore.record('test-event', { data: 'test' });
    const dashboard = visualizer.generateSystemHealthDashboard();
    assert.strictEqual(typeof dashboard.stats, 'object');
    assert.strictEqual(Array.isArray(dashboard.recentEvents), true);
  });
});

describe('DeepeningDeployment', () => {
  let deployment;
  const testDeployPath = path.join(__dirname, 'test-deploy');

  beforeEach(() => {
    if (fs.existsSync(testDeployPath)) {
      fs.rmSync(testDeployPath, { recursive: true, force: true });
    }

    deployment = new DeepeningDeployment({
      deployPath: testDeployPath,
      backupPath: path.join(testDeployPath, 'backups'),
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDeployPath)) {
      fs.rmSync(testDeployPath, { recursive: true, force: true });
    }
  });

  it('should deploy configuration', async () => {
    const config = {
      agents: ['analyst', 'worker'],
      maxIterations: 10,
    };

    const deployedConfig = await deployment.deploy(config);
    assert.strictEqual(deployedConfig.agents.length, 2);
    assert.strictEqual(deployedConfig.maxIterations, 10);
    assert.strictEqual(typeof deployedConfig.deployedAt, 'string');
    assert.strictEqual(typeof deployedConfig.version, 'string');
  });

  it('should list deployments', () => {
    const config = {
      agents: ['analyst', 'worker'],
      maxIterations: 10,
    };

    deployment.deploy(config);
    const deployments = deployment.listDeployments();
    assert.strictEqual(Array.isArray(deployments), true);
    assert.strictEqual(deployments.length > 0, true);
  });

  it('should get current deployment', () => {
    const config = {
      agents: ['analyst', 'worker'],
      maxIterations: 10,
    };

    deployment.deploy(config);
    const current = deployment.getCurrentDeployment();
    assert.strictEqual(typeof current, 'object');
    assert.strictEqual(current.agents.length, 2);
  });

  it('should validate configuration', () => {
    const validConfig = {
      agents: ['analyst', 'worker'],
      maxIterations: 10,
    };

    assert.doesNotThrow(() => {
      deployment.validateConfig(validConfig);
    });

    const invalidConfig = {
      agents: [],
      maxIterations: 10,
    };

    assert.throws(() => {
      deployment.validateConfig(invalidConfig);
    });
  });

  it('should create deployment template', () => {
    const template = deployment.createDeploymentTemplate();
    assert.strictEqual(Array.isArray(template.agents), true);
    assert.strictEqual(typeof template.maxIterations, 'number');
  });
});
