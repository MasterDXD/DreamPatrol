'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const DeepeningHealthMonitor = require('../../src/runtime/deepening/deepening-health-monitor');
const DeepeningDependencyResolver = require('../../src/runtime/deepening/deepening-dependency-resolver');


describe('DeepeningHealthMonitor', function() {
  let monitor;

  beforeEach(function() {
    monitor = new DeepeningHealthMonitor({ interval: 1000, timeout: 500 });
  });

  it('should create monitor with default options', function() {
    const m = new DeepeningHealthMonitor();
    assert.strictEqual(m.getStats().checksRegistered, 0);
    assert.strictEqual(m.getStats().running, false);
  });

  it('should register health checks', function() {
    monitor.registerCheck('test', function() { return { status: 'healthy' }; });
    assert.strictEqual(monitor.getStats().checksRegistered, 1);
  });

  it('should throw on invalid registerCheck args', function() {
    assert.throws(function() { monitor.registerCheck('', function() {}); }, /Name and checkFn are required/);
    assert.throws(function() { monitor.registerCheck('test', null); }, /Name and checkFn are required/);
  });

  it('should unregister health checks', function() {
    monitor.registerCheck('test', function() { return { status: 'healthy' }; });
    monitor.unregisterCheck('test');
    assert.strictEqual(monitor.getStats().checksRegistered, 0);
  });

  it('should run a single check', async function() {
    monitor.registerCheck('db', function() {
      return { status: 'healthy', message: 'DB is up' };
    });
    const result = await monitor.runCheck('db');
    assert.strictEqual(result.name, 'db');
    assert.strictEqual(result.status, 'healthy');
    assert.strictEqual(result.message, 'DB is up');
  });

  it('should handle check timeout', async function() {
    monitor.registerCheck('slow', function() {
      return new Promise(function(resolve) { setTimeout(resolve, 300); });
    }, { timeout: 50 });
    const result = await monitor.runCheck('slow');
    assert.strictEqual(result.status, 'unhealthy');
    assert.ok(result.message.indexOf('timeout') >= 0);
  });

  it('should handle check error', async function() {
    monitor.registerCheck('failing', function() { throw new Error('Connection refused'); });
    const result = await monitor.runCheck('failing');
    assert.strictEqual(result.status, 'unhealthy');
    assert.ok(result.message.indexOf('Connection refused') >= 0);
  });

  it('should throw on unknown check', async function() {
    await assert.rejects(function() { return monitor.runCheck('unknown'); }, /Check not found/);
  });

  it('should run all checks and compute overall status', async function() {
    monitor.registerCheck('healthy1', function() { return { status: 'healthy' }; });
    monitor.registerCheck('healthy2', function() { return { status: 'healthy' }; });
    const report = await monitor.runAllChecks();
    assert.strictEqual(report.status, 'healthy');
    assert.strictEqual(report.score, 100);
    assert.strictEqual(report.results.length, 2);
  });

  it('should detect degraded status', async function() {
    monitor.registerCheck('ok', function() { return { status: 'healthy' }; });
    monitor.registerCheck('degraded', function() { return { status: 'degraded' }; });
    const report = await monitor.runAllChecks();
    assert.strictEqual(report.status, 'degraded');
    assert.ok(report.score < 100);
  });

  it('should detect critical status', async function() {
    monitor.registerCheck('critical', function() { return { status: 'unhealthy' }; }, { critical: true });
    const report = await monitor.runAllChecks();
    assert.strictEqual(report.status, 'critical');
  });

  it('should detect unhealthy status when majority fail', async function() {
    monitor.registerCheck('fail1', function() { return { status: 'unhealthy' }; });
    monitor.registerCheck('fail2', function() { return { status: 'unhealthy' }; });
    monitor.registerCheck('ok', function() { return { status: 'healthy' }; });
    const report = await monitor.runAllChecks();
    assert.strictEqual(report.status, 'unhealthy');
  });

  it('should store results and history', async function() {
    monitor.registerCheck('test', function() { return { status: 'healthy' }; });
    await monitor.runAllChecks();
    assert.ok(monitor.getResult('test'));
    assert.strictEqual(monitor.getHistory().length, 1);
  });

  it('should limit history size', async function() {
    const m = new DeepeningHealthMonitor({ historySize: 3 });
    m.registerCheck('test', function() { return { status: 'healthy' }; });
    for (let i = 0; i < 5; i++) {
      await m.runAllChecks();
    }
    assert.strictEqual(m.getHistory().length, 3);
  });

  it('should get history with limit', async function() {
    monitor.registerCheck('test', function() { return { status: 'healthy' }; });
    for (let i = 0; i < 5; i++) {
      await monitor.runAllChecks();
    }
    assert.strictEqual(monitor.getHistory(2).length, 2);
  });

  it('should emit check and report events', async function() {
    let checkEmitted = false;
    let reportEmitted = false;
    monitor.on('check', function() { checkEmitted = true; });
    monitor.on('report', function() { reportEmitted = true; });
    monitor.registerCheck('test', function() { return { status: 'healthy' }; });
    await monitor.runAllChecks();
    assert.strictEqual(checkEmitted, true);
    assert.strictEqual(reportEmitted, true);
  });

  it('should start and stop monitoring', function() {
    return new Promise(function(resolve) {
      monitor.registerCheck('test', function() { return { status: 'healthy' }; });
      monitor.start();
      assert.strictEqual(monitor.getStats().running, true);
      setTimeout(function() {
        monitor.stop();
        assert.strictEqual(monitor.getStats().running, false);
        resolve();
      }, 200);
    });
  });

  it('should return null for unknown result', function() {
    assert.strictEqual(monitor.getResult('unknown'), null);
  });

  it('should shutdown cleanly', function() {
    monitor.registerCheck('test', function() { return { status: 'healthy' }; });
    monitor.start();
    monitor.shutdown();
    assert.strictEqual(monitor.getStats().running, false);
  });

  it('should be healthy', function() {
    assert.strictEqual(monitor.isHealthy(), true);
  });
});

describe('DeepeningDependencyResolver', function() {
  let resolver;

  beforeEach(function() {
    resolver = new DeepeningDependencyResolver();
  });

  it('should add nodes', function() {
    resolver.addNode('a', { name: 'Node A' });
    const stats = resolver.getStats();
    assert.strictEqual(stats.nodes, 1);
    assert.strictEqual(stats.edges, 0);
  });

  it('should throw on addNode without id', function() {
    assert.throws(function() { resolver.addNode(''); }, /Node id is required/);
  });

  it('should remove nodes', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addDependency('a', 'b');
    resolver.removeNode('a');
    assert.strictEqual(resolver.getStats().nodes, 1);
    const b = resolver.getNode('b');
    assert.strictEqual(b.dependents.length, 0);
  });

  it('should add dependencies', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addDependency('a', 'b');
    assert.strictEqual(resolver.getDependencies('a').length, 1);
    assert.strictEqual(resolver.getDependencies('a')[0], 'b');
    assert.strictEqual(resolver.getDependents('b').length, 1);
    assert.strictEqual(resolver.getDependents('b')[0], 'a');
  });

  it('should throw on addDependency with unknown nodes', function() {
    assert.throws(function() { resolver.addDependency('a', 'b'); }, /Source node not found/);
    resolver.addNode('a');
    assert.throws(function() { resolver.addDependency('a', 'b'); }, /Target node not found/);
  });

  it('should not add duplicate dependencies', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addDependency('a', 'b');
    resolver.addDependency('a', 'b');
    assert.strictEqual(resolver.getDependencies('a').length, 1);
  });

  it('should remove dependencies', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addDependency('a', 'b');
    resolver.removeDependency('a', 'b');
    assert.strictEqual(resolver.getDependencies('a').length, 0);
    assert.strictEqual(resolver.getDependents('b').length, 0);
  });

  it('should detect cycles', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addNode('c');
    resolver.addDependency('a', 'b');
    resolver.addDependency('b', 'c');
    resolver.addDependency('c', 'a');
    const cycles = resolver.detectCycles();
    assert.ok(cycles.length > 0);
  });

  it('should detect no cycles in acyclic graph', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addNode('c');
    resolver.addDependency('a', 'b');
    resolver.addDependency('b', 'c');
    const cycles = resolver.detectCycles();
    assert.strictEqual(cycles.length, 0);
  });

  it('should perform topological sort', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addNode('c');
    resolver.addDependency('c', 'a');
    resolver.addDependency('c', 'b');
    const sorted = resolver.topologicalSort();
    assert.strictEqual(sorted.length, 3);
    assert.ok(sorted.indexOf('a') < sorted.indexOf('c'));
    assert.ok(sorted.indexOf('b') < sorted.indexOf('c'));
  });

  it('should throw on topological sort with cycles', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addDependency('a', 'b');
    resolver.addDependency('b', 'a');
    assert.throws(function() { resolver.topologicalSort(); }, /cycle detected/);
  });

  it('should get execution order', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addNode('c');
    resolver.addDependency('b', 'a');
    resolver.addDependency('c', 'b');
    const order = resolver.getExecutionOrder();
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  });

  it('should get transitive dependencies', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addNode('c');
    resolver.addDependency('c', 'b');
    resolver.addDependency('b', 'a');
    const deps = resolver.getTransitiveDependencies('c');
    assert.ok(deps.indexOf('a') >= 0);
    assert.ok(deps.indexOf('b') >= 0);
  });

  it('should limit transitive dependency depth', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addNode('c');
    resolver.addDependency('c', 'b');
    resolver.addDependency('b', 'a');
    const deps = resolver.getTransitiveDependencies('c', 0);
    assert.strictEqual(deps.length, 1);
    assert.strictEqual(deps[0], 'b');
  });

  it('should get node info', function() {
    resolver.addNode('a', { name: 'Alpha' });
    const node = resolver.getNode('a');
    assert.strictEqual(node.id, 'a');
    assert.deepStrictEqual(node.data, { name: 'Alpha' });
  });

  it('should return null for unknown node', function() {
    assert.strictEqual(resolver.getNode('unknown'), null);
  });

  it('should return empty arrays for unknown dependencies', function() {
    assert.deepStrictEqual(resolver.getDependencies('unknown'), []);
    assert.deepStrictEqual(resolver.getDependents('unknown'), []);
  });

  it('should emit dependency event', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    let eventFired = false;
    let eventObj = null;
    resolver.on('dependency', function(e) {
      eventFired = true;
      eventObj = e;
    });
    resolver.addDependency('a', 'b');
    assert.ok(eventFired);
    assert.strictEqual(eventObj.from, 'a');
    assert.strictEqual(eventObj.to, 'b');
  });

  it('should get stats', function() {
    resolver.addNode('a');
    resolver.addNode('b');
    resolver.addDependency('a', 'b');
    const stats = resolver.getStats();
    assert.strictEqual(stats.nodes, 2);
    assert.strictEqual(stats.edges, 1);
    assert.strictEqual(stats.cycles, 0);
  });

  it('should shutdown cleanly', function() {
    resolver.addNode('a');
    resolver.shutdown();
    assert.strictEqual(resolver.isHealthy(), false);
  });

  it('should handle removeNode for non-existent node', function() {
    resolver.removeNode('nonexistent');
    assert.strictEqual(resolver.getStats().nodes, 0);
  });

  it('should handle removeDependency for non-existent source', function() {
    resolver.removeDependency('nonexistent', 'target');
    assert.strictEqual(resolver.getStats().edges, 0);
  });
});
