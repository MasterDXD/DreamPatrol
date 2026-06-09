'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const DeepeningPriorityQueue = require('../../src/runtime/deepening/deepening-priority-queue');
const DeepeningMetricsAggregator = require('../../src/runtime/deepening/deepening-metrics-aggregator');


describe('DeepeningPriorityQueue', function() {
  let pq;

  beforeEach(function() {
    pq = new DeepeningPriorityQueue({ maxSize: 100, concurrency: 1 });
  });

  it('should create queue with default options', function() {
    const q = new DeepeningPriorityQueue();
    assert.strictEqual(q.getStats().maxSize, 10000);
    assert.strictEqual(q.getStats().concurrency, 1);
  });

  it('should enqueue a task', function() {
    const id = pq.enqueue({ name: 'task1' });
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(pq.getSize(), 1);
  });

  it('should enqueue with priority', function() {
    pq.enqueue({ name: 'low' }, { priority: DeepeningPriorityQueue.PRIORITY_LEVELS.LOW });
    pq.enqueue({ name: 'critical' }, { priority: DeepeningPriorityQueue.PRIORITY_LEVELS.CRITICAL });
    pq.enqueue({ name: 'normal' }, { priority: DeepeningPriorityQueue.PRIORITY_LEVELS.NORMAL });
    const peeked = pq.peek();
    assert.strictEqual(peeked.name, 'critical');
  });

  it('should dequeue highest priority first', function() {
    pq.enqueue({ name: 'low' }, { priority: 3 });
    pq.enqueue({ name: 'critical' }, { priority: 0 });
    pq.enqueue({ name: 'high' }, { priority: 1 });
    const first = pq.dequeue();
    assert.strictEqual(first.name, 'critical');
    const second = pq.dequeue();
    assert.strictEqual(second.name, 'high');
  });

  it('should throw on invalid task', function() {
    assert.throws(function() { pq.enqueue(null); }, /Task object is required/);
    assert.throws(function() { pq.enqueue({}); }, /Task must have a name or id/);
  });

  it('should cancel a pending task', function() {
    const id = pq.enqueue({ name: 'task1' });
    assert.strictEqual(pq.cancel(id), true);
    assert.strictEqual(pq.getSize(), 0);
  });

  it('should return false for cancelling unknown task', function() {
    assert.strictEqual(pq.cancel(9999), false);
  });

  it('should get task by id', function() {
    const id = pq.enqueue({ name: 'task1' });
    const task = pq.getTask(id);
    assert.strictEqual(task.name, 'task1');
  });

  it('should return null for unknown task', function() {
    assert.strictEqual(pq.getTask(9999), null);
  });

  it('should peek without removing', function() {
    pq.enqueue({ name: 'task1' });
    pq.peek();
    assert.strictEqual(pq.getSize(), 1);
  });

  it('should emit enqueued event', function() {
    let emitted = null;
    pq.on('enqueued', function(e) { emitted = e; });
    pq.enqueue({ name: 'task1' });
    assert.strictEqual(emitted.name, 'task1');
  });

  it('should emit cancelled event', function() {
    let emitted = null;
    pq.on('cancelled', function(e) { emitted = e; });
    const id = pq.enqueue({ name: 'task1' });
    pq.cancel(id);
    assert.strictEqual(emitted.id, id);
  });

  it('should pause and resume', function() {
    pq.pause();
    assert.strictEqual(pq.isPaused(), true);
    pq.resume();
    assert.strictEqual(pq.isPaused(), false);
  });

  it('should emit paused and resumed events', function() {
    let pausedEmitted = false;
    let resumedEmitted = false;
    pq.on('paused', function() { pausedEmitted = true; });
    pq.on('resumed', function() { resumedEmitted = true; });
    pq.pause();
    pq.resume();
    assert.strictEqual(pausedEmitted, true);
    assert.strictEqual(resumedEmitted, true);
  });

  it('should get pending count', function() {
    pq.enqueue({ name: 't1' });
    pq.enqueue({ name: 't2' });
    assert.strictEqual(pq.getPendingCount(), 2);
  });

  it('should get by priority', function() {
    pq.enqueue({ name: 'critical' }, { priority: 0 });
    pq.enqueue({ name: 'normal' }, { priority: 2 });
    const critical = pq.getByPriority(0);
    assert.strictEqual(critical.length, 1);
    assert.strictEqual(critical[0].name, 'critical');
  });

  it('should clear the queue', function() {
    pq.enqueue({ name: 't1' });
    pq.enqueue({ name: 't2' });
    let clearedEmitted = false;
    pq.on('cleared', function() { clearedEmitted = true; });
    pq.clear();
    assert.strictEqual(pq.getSize(), 0);
    assert.strictEqual(clearedEmitted, true);
  });

  it('should handle overflow', function() {
    const small = new DeepeningPriorityQueue({ maxSize: 2 });
    let overflowEmitted = false;
    small.on('overflow', function() { overflowEmitted = true; });
    small.enqueue({ name: 't1' });
    small.enqueue({ name: 't2' });
    small.enqueue({ name: 't3' });
    assert.strictEqual(overflowEmitted, true);
  });

  it('should handle delayed tasks', function() {
    pq.enqueue({ name: 'delayed' }, { delay: 10000 });
    const peeked = pq.peek();
    assert.strictEqual(peeked, null);
  });

  it('should get stats', function() {
    pq.enqueue({ name: 't1' }, { priority: 0 });
    pq.enqueue({ name: 't2' }, { priority: 2 });
    const stats = pq.getStats();
    assert.strictEqual(stats.pending, 2);
    assert.strictEqual(stats.running, 0);
    assert.strictEqual(stats.concurrency, 1);
    assert.strictEqual(stats.paused, false);
    assert.strictEqual(stats.pendingByPriority[0], 1);
    assert.strictEqual(stats.pendingByPriority[2], 1);
  });

  it('should expose PRIORITY_LEVELS', function() {
    assert.strictEqual(DeepeningPriorityQueue.PRIORITY_LEVELS.CRITICAL, 0);
    assert.strictEqual(DeepeningPriorityQueue.PRIORITY_LEVELS.HIGH, 1);
    assert.strictEqual(DeepeningPriorityQueue.PRIORITY_LEVELS.NORMAL, 2);
    assert.strictEqual(DeepeningPriorityQueue.PRIORITY_LEVELS.LOW, 3);
    assert.strictEqual(DeepeningPriorityQueue.PRIORITY_LEVELS.IDLE, 4);
  });

  it('should shutdown cleanly', function() {
    pq.enqueue({ name: 't1' });
    let shutdownEmitted = false;
    pq.on('shutdown', function() { shutdownEmitted = true; });
    pq.shutdown();
    assert.strictEqual(shutdownEmitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(pq.isHealthy(), true);
  });
});

describe('DeepeningMetricsAggregator', function() {
  let ma;

  beforeEach(function() {
    ma = new DeepeningMetricsAggregator({ maxSeriesLength: 100, flushInterval: 60000 });
  });

  it('should create aggregator with default options', function() {
    const a = new DeepeningMetricsAggregator();
    assert.strictEqual(a.getStats().maxSeriesLength, 1000);
    assert.strictEqual(a.getStats().flushInterval, 60000);
  });

  it('should register a metric', function() {
    ma.register('cpu.usage', { type: 'avg', unit: '%' });
    assert.strictEqual(ma.getNames().length, 1);
    assert.strictEqual(ma.getNames()[0], 'cpu.usage');
  });

  it('should throw on register without name', function() {
    assert.throws(function() { ma.register(''); }, /Metric name is required/);
  });

  it('should not duplicate registration', function() {
    ma.register('cpu.usage');
    ma.register('cpu.usage');
    assert.strictEqual(ma.getNames().length, 1);
  });

  it('should emit registered event', function() {
    let emitted = null;
    ma.on('registered', function(e) { emitted = e; });
    ma.register('cpu.usage', { type: 'avg' });
    assert.strictEqual(emitted.name, 'cpu.usage');
    assert.strictEqual(emitted.type, 'avg');
  });

  it('should record a value', function() {
    ma.register('cpu.usage');
    ma.record('cpu.usage', 75.5);
    const metric = ma.getMetric('cpu.usage');
    assert.strictEqual(metric.value, 75.5);
    assert.strictEqual(metric.count, 1);
  });

  it('should throw on record for unregistered metric', function() {
    assert.throws(function() { ma.record('unknown', 1); }, /Metric not registered/);
  });

  it('should throw on non-numeric value', function() {
    ma.register('test');
    assert.throws(function() { ma.record('test', 'abc'); }, /Value must be a number/);
  });

  it('should emit recorded event', function() {
    let emitted = null;
    ma.register('test');
    ma.on('recorded', function(e) { emitted = e; });
    ma.record('test', 42);
    assert.strictEqual(emitted.name, 'test');
    assert.strictEqual(emitted.value, 42);
  });

  it('should compute min/max/sum/avg', function() {
    ma.register('latency');
    ma.record('latency', 10);
    ma.record('latency', 20);
    ma.record('latency', 30);
    const metric = ma.getMetric('latency');
    assert.strictEqual(metric.min, 10);
    assert.strictEqual(metric.max, 30);
    assert.strictEqual(metric.sum, 60);
    assert.strictEqual(metric.avg, 20);
  });

  it('should compute p95 and p99', function() {
    ma.register('latency');
    for (let i = 1; i <= 100; i++) {
      ma.record('latency', i);
    }
    const metric = ma.getMetric('latency');
    assert.ok(metric.p95 >= 95);
    assert.ok(metric.p99 >= 99);
  });

  it('should record batch', function() {
    ma.register('a');
    ma.register('b');
    ma.recordBatch([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
    ]);
    assert.strictEqual(ma.getMetric('a').value, 1);
    assert.strictEqual(ma.getMetric('b').value, 2);
  });

  it('should get series with filters', function() {
    ma.register('test');
    ma.record('test', 1);
    ma.record('test', 2);
    ma.record('test', 3);
    const series = ma.getSeries('test', { limit: 2 });
    assert.strictEqual(series.length, 2);
  });

  it('should get series with time range', function() {
    ma.register('test');
    const before = Date.now() - 1000;
    ma.record('test', 1);
    const after = Date.now() + 100000;
    const series = ma.getSeries('test', { since: before, until: after });
    assert.ok(series.length >= 1);
  });

  it('should return empty array for unknown series', function() {
    assert.deepStrictEqual(ma.getSeries('unknown'), []);
  });

  it('should unregister a metric', function() {
    ma.register('test');
    let emitted = null;
    ma.on('unregistered', function(e) { emitted = e; });
    const result = ma.unregister('test');
    assert.strictEqual(result, true);
    assert.strictEqual(emitted.name, 'test');
    assert.strictEqual(ma.getNames().length, 0);
  });

  it('should return false for unregistering unknown metric', function() {
    assert.strictEqual(ma.unregister('unknown'), false);
  });

  it('should flush a single metric', function() {
    ma.register('test');
    ma.record('test', 42);
    let flushed = null;
    ma.on('flushed', function(e) { flushed = e; });
    const snapshot = ma.flush('test');
    assert.strictEqual(snapshot.value, 42);
    assert.strictEqual(flushed.name, 'test');
    const metric = ma.getMetric('test');
    assert.strictEqual(metric.count, 0);
  });

  it('should flush all metrics', function() {
    ma.register('a');
    ma.register('b');
    ma.record('a', 1);
    ma.record('b', 2);
    const snapshots = ma.flush();
    assert.strictEqual(Object.keys(snapshots).length, 2);
  });

  it('should start and stop auto flush', function() {
    ma.startAutoFlush();
    assert.strictEqual(ma.getStats().autoFlushRunning, true);
    ma.stopAutoFlush();
    assert.strictEqual(ma.getStats().autoFlushRunning, false);
  });

  it('should get dashboard', function() {
    ma.register('cpu');
    ma.record('cpu', 80);
    const dashboard = ma.getDashboard();
    assert.strictEqual(dashboard.totalMetrics, 1);
    assert.strictEqual(dashboard.totalRecorded, 1);
    assert.ok(dashboard.metrics.cpu);
    assert.strictEqual(dashboard.metrics.cpu.value, 80);
  });

  it('should get stats', function() {
    ma.register('test');
    ma.record('test', 1);
    const stats = ma.getStats();
    assert.strictEqual(stats.registeredMetrics, 1);
    assert.strictEqual(stats.totalRecorded, 1);
    assert.strictEqual(stats.totalFlushed, 0);
  });

  it('should limit series length', function() {
    const small = new DeepeningMetricsAggregator({ maxSeriesLength: 5 });
    small.register('test');
    for (let i = 0; i < 10; i++) {
      small.record('test', i);
    }
    const series = small.getSeries('test');
    assert.strictEqual(series.length, 5);
  });

  it('should shutdown cleanly', function() {
    ma.register('test');
    ma.startAutoFlush();
    let shutdownEmitted = false;
    ma.on('shutdown', function() { shutdownEmitted = true; });
    ma.shutdown();
    assert.strictEqual(shutdownEmitted, true);
    assert.strictEqual(ma.getStats().autoFlushRunning, false);
  });

  it('should be healthy', function() {
    assert.strictEqual(ma.isHealthy(), true);
  });

  it('should expose AGGREGATION_TYPES', function() {
    assert.strictEqual(DeepeningMetricsAggregator.AGGREGATION_TYPES.SUM, 'sum');
    assert.strictEqual(DeepeningMetricsAggregator.AGGREGATION_TYPES.AVG, 'avg');
    assert.strictEqual(DeepeningMetricsAggregator.AGGREGATION_TYPES.P95, 'p95');
    assert.strictEqual(DeepeningMetricsAggregator.AGGREGATION_TYPES.P99, 'p99');
  });

  it('should return null for unknown metric', function() {
    assert.strictEqual(ma.getMetric('unknown'), null);
  });

  it('should throw on invalid batch entries', function() {
    assert.throws(function() { ma.recordBatch('not array'); }, /Entries must be an array/);
  });

  it('should handle labels in record', function() {
    ma.register('test');
    ma.record('test', 42, { host: 'server1' });
    const series = ma.getSeries('test');
    assert.strictEqual(series[0].labels.host, 'server1');
  });
});
