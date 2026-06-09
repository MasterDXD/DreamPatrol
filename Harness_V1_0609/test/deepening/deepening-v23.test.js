'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const DeepeningEventBus = require('../../src/runtime/deepening/deepening-event-bus');

describe('DeepeningEventBus', function() {
  let eb;

  beforeEach(function() {
    eb = new DeepeningEventBus({ maxDeadLetters: 50 });
  });

  afterEach(function() {
    if (eb) eb.shutdown();
  });

  it('should create with defaults', function() {
    const e = new DeepeningEventBus();
    assert.strictEqual(e.getStats().totalTopics, 0);
    e.shutdown();
  });

  it('should subscribe to a topic', function() {
    const subId = eb.subscribe('user.created', function() {});
    assert.strictEqual(typeof subId, 'string');
    assert.strictEqual(eb.getSubscriberCount('user.created'), 1);
  });

  it('should throw on subscribe without topic', function() {
    assert.throws(function() { eb.subscribe('', function() {}); }, /Topic is required/);
  });

  it('should throw on subscribe without handler', function() {
    assert.throws(function() { eb.subscribe('test', 'not-fn'); }, /Handler must be a function/);
  });

  it('should emit subscribed event', function() {
    let emitted = null;
    eb.on('subscribed', function(e) { emitted = e; });
    eb.subscribe('test', function() {});
    assert.strictEqual(emitted.topic, 'test');
  });

  it('should subscribe with wildcard', function() {
    eb.subscribe('*', function() {});
    assert.strictEqual(eb.getStats().wildcardSubs, 1);
  });

  it('should unsubscribe', function() {
    const subId = eb.subscribe('test', function() {});
    const result = eb.unsubscribe(subId);
    assert.strictEqual(result, true);
    assert.strictEqual(eb.getSubscriberCount('test'), 0);
  });

  it('should return false for unknown unsubscribe', function() {
    assert.strictEqual(eb.unsubscribe('unknown'), false);
  });

  it('should subscribe once', async function() {
    let count = 0;
    eb.subscribeOnce('test', function() { count++; });
    await eb.publish('test', {});
    await eb.publish('test', {});
    assert.strictEqual(count, 1);
  });

  it('should publish and deliver', async function() {
    let received = null;
    eb.subscribe('test', function(e) { received = e; });
    const delivered = await eb.publish('test', { name: 'hello' });
    assert.strictEqual(delivered, 1);
    assert.strictEqual(received.data.name, 'hello');
    assert.strictEqual(received.topic, 'test');
  });

  it('should emit published event', async function() {
    let emitted = null;
    eb.on('published', function(e) { emitted = e; });
    eb.subscribe('test', function() {});
    await eb.publish('test', {});
    assert.strictEqual(emitted.topic, 'test');
    assert.strictEqual(emitted.delivered, 1);
  });

  it('should deliver to multiple subscribers', async function() {
    let count = 0;
    eb.subscribe('test', function() { count++; });
    eb.subscribe('test', function() { count++; });
    const delivered = await eb.publish('test', {});
    assert.strictEqual(delivered, 2);
    assert.strictEqual(count, 2);
  });

  it('should deliver to wildcard subscribers', async function() {
    let received = null;
    eb.subscribe('*', function(e) { received = e; });
    await eb.publish('any.topic', { x: 1 });
    assert.strictEqual(received.data.x, 1);
  });

  it('should support pattern matching', async function() {
    let received = null;
    eb.subscribe('user.*', function(e) { received = e; });
    await eb.publish('user.created', { id: 1 });
    assert.strictEqual(received.data.id, 1);
  });

  it('should not match non-matching pattern', async function() {
    let received = null;
    eb.subscribe('order.*', function(e) { received = e; });
    await eb.publish('user.created', {});
    assert.strictEqual(received, null);
  });

  it('should respect priority', async function() {
    const order = [];
    eb.subscribe('test', function() { order.push('low'); }, { priority: 10 });
    eb.subscribe('test', function() { order.push('high'); }, { priority: 1 });
    await eb.publish('test', {});
    assert.strictEqual(order[0], 'high');
    assert.strictEqual(order[1], 'low');
  });

  it('should support filter', async function() {
    let received = null;
    eb.subscribe('test', function(e) { received = e; }, {
      filter: function(e) { return e.data && e.data.type === 'important'; },
    });
    await eb.publish('test', { type: 'normal' });
    assert.strictEqual(received, null);
    await eb.publish('test', { type: 'important' });
    assert.strictEqual(received.data.type, 'important');
  });

  it('should send to dead letter on handler error', async function() {
    eb.subscribe('test', function() { throw new Error('boom'); });
    await eb.publish('test', {});
    const dead = eb.getDeadLetters();
    assert.strictEqual(dead.length, 1);
    assert.strictEqual(dead[0].error, 'boom');
  });

  it('should limit dead letters', async function() {
    const small = new DeepeningEventBus({ maxDeadLetters: 3 });
    small.subscribe('test', function() { throw new Error('err'); });
    for (let i = 0; i < 5; i++) await small.publish('test', {});
    assert.strictEqual(small.getDeadLetters().length, 3);
    small.shutdown();
  });

  it('should clear dead letters', async function() {
    eb.subscribe('test', function() { throw new Error('err'); });
    await eb.publish('test', {});
    const count = eb.clearDeadLetters();
    assert.strictEqual(count, 1);
    assert.strictEqual(eb.getDeadLetters().length, 0);
  });

  it('should support interceptors', async function() {
    eb.addInterceptor(function(e) { return e.data && e.data.allowed; });
    let received = null;
    eb.subscribe('test', function(e) { received = e; });
    await eb.publish('test', { allowed: false });
    assert.strictEqual(received, null);
    await eb.publish('test', { allowed: true });
    assert.strictEqual(received.data.allowed, true);
  });

  it('should remove interceptor', function() {
    const fn = function() {};
    eb.addInterceptor(fn);
    assert.strictEqual(eb.getStats().interceptorCount, 1);
    eb.removeInterceptor(fn);
    assert.strictEqual(eb.getStats().interceptorCount, 0);
  });

  it('should throw on add interceptor without function', function() {
    assert.throws(function() { eb.addInterceptor('not-fn'); }, /Interceptor must be a function/);
  });

  it('should track stats', async function() {
    eb.subscribe('test', function() {});
    await eb.publish('test', {});
    const stats = eb.getStats();
    assert.strictEqual(stats.totalPublished, 1);
    assert.strictEqual(stats.totalDelivered, 1);
    assert.strictEqual(stats.totalTopics, 1);
  });

  it('should get topic names', function() {
    eb.subscribe('a', function() {});
    eb.subscribe('b', function() {});
    assert.deepStrictEqual(eb.getTopicNames(), ['a', 'b']);
  });

  it('should get subscriber count', function() {
    eb.subscribe('test', function() {});
    eb.subscribe('test', function() {});
    assert.strictEqual(eb.getSubscriberCount('test'), 2);
    assert.strictEqual(eb.getSubscriberCount(), 2);
  });

  it('should throw on publish without topic', async function() {
    await assert.rejects(function() { return eb.publish('', {}); }, /Topic is required/);
  });

  it('should shutdown cleanly', function() {
    let emitted = false;
    eb.on('shutdown', function() { emitted = true; });
    eb.shutdown();
    assert.strictEqual(emitted, true);
  });

  it('should be healthy', function() {
    assert.strictEqual(eb.isHealthy(), true);
  });
});
