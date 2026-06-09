'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// DDD Core
const Entity = require('../../../src/domain/entity');
const ValueObject = require('../../../src/domain/value-object');
const AggregateRoot = require('../../../src/domain/aggregate-root');
const { DomainEvent, DomainEventBus } = require('../../../src/domain/domain-event');
const { Repository: _Repository, InMemoryRepository } = require('../../../src/domain/repository');
const DomainService = require('../../../src/domain/domain-service');
const { Specification, AndSpecification: _AndSpecification, OrSpecification: _OrSpecification, NotSpecification: _NotSpecification } = require('../../../src/domain/specification');
const ContextMapper = require('../../../src/domain/context-mapper');

// TDD Cycle Tracker
const TddCycleTracker = require('../../../src/gate/tdd-cycle-tracker');

// ============================================================
// Entity
// ============================================================
describe('DDD - Entity', () => {
  it('should create entity with generated id', () => {
    const entity = new Entity();
    assert.ok(entity.id);
    assert.strictEqual(typeof entity.id, 'string');
  });

  it('should create entity with provided id', () => {
    const entity = new Entity('custom-id');
    assert.strictEqual(entity.id, 'custom-id');
  });

  it('should compare entities by identity', () => {
    const e1 = new Entity('id-1');
    const e2 = new Entity('id-1');
    const e3 = new Entity('id-2');
    assert.strictEqual(e1.equals(e2), true);
    assert.strictEqual(e1.equals(e3), false);
  });

  it('should not equal non-Entity objects', () => {
    const entity = new Entity('id-1');
    assert.strictEqual(entity.equals({ id: 'id-1' }), false);
    assert.strictEqual(entity.equals(null), false);
  });

  it('should manage domain events', () => {
    const entity = new Entity('id-1');
    const event = new DomainEvent('TestEvent', entity.id);
    entity.addDomainEvent(event);
    const events = entity.pullDomainEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(entity.pullDomainEvents().length, 0);
  });
});

// ============================================================
// ValueObject
// ============================================================
describe('DDD - ValueObject', () => {
  class Money extends ValueObject {
    constructor(amount, currency) {
      super();
      this.amount = amount;
      this.currency = currency;
    }
    getEqualityComponents() { return [this.amount, this.currency]; }
  }

  class Address extends ValueObject {
    constructor(street, city) {
      super();
      this.street = street;
      this.city = city;
    }
    getEqualityComponents() { return [this.street, this.city]; }
  }

  it('should throw if getEqualityComponents not implemented', () => {
    const vo = new ValueObject();
    assert.throws(() => vo.equals(new ValueObject()), /implement/);
  });

  it('should compare by value equality', () => {
    const m1 = new Money(100, 'USD');
    const m2 = new Money(100, 'USD');
    const m3 = new Money(200, 'USD');
    assert.strictEqual(m1.equals(m2), true);
    assert.strictEqual(m1.equals(m3), false);
  });

  it('should not equal different types', () => {
    const money = new Money(100, 'USD');
    const address = new Address('100', 'USD');
    assert.strictEqual(money.equals(address), false);
  });

  it('should generate consistent hash', () => {
    const m1 = new Money(100, 'USD');
    const m2 = new Money(100, 'USD');
    const m3 = new Money(200, 'USD');
    assert.strictEqual(m1.hashCode(), m2.hashCode());
    assert.notStrictEqual(m1.hashCode(), m3.hashCode());
  });

  it('should serialize to JSON', () => {
    const money = new Money(100, 'USD');
    const json = money.toJSON();
    assert.strictEqual(json.amount, 100);
    assert.strictEqual(json.currency, 'USD');
  });
});

// ============================================================
// AggregateRoot
// ============================================================
describe('DDD - AggregateRoot', () => {
  it('should extend Entity', () => {
    const root = new AggregateRoot('agg-1');
    assert.ok(root instanceof Entity);
  });

  it('should track version', () => {
    const root = new AggregateRoot('agg-1');
    assert.strictEqual(root.version, 0);
    const v = root._incrementVersion();
    assert.strictEqual(v, 1);
    assert.strictEqual(root.version, 1);
  });

  it('should track timestamps', () => {
    const before = Date.now();
    const root = new AggregateRoot('agg-1');
    assert.ok(root.createdAt >= before);
    assert.ok(root.updatedAt >= before);
  });

  it('should update timestamp on version increment', () => {
    const root = new AggregateRoot('agg-1');
    const original = root.updatedAt;
    root._incrementVersion();
    assert.ok(root.updatedAt >= original);
  });

  it('should serialize full state', () => {
    const root = new AggregateRoot('agg-1');
    root._incrementVersion();
    const json = root.toJSON();
    assert.strictEqual(json.id, 'agg-1');
    assert.strictEqual(json.version, 1);
    assert.ok(typeof json.createdAt === 'number');
  });
});

// ============================================================
// DomainEvent & DomainEventBus
// ============================================================
describe('DDD - DomainEvent & DomainEventBus', () => {
  it('should create domain event', () => {
    const event = new DomainEvent('OrderCreated', 'order-1', { amount: 100 });
    assert.strictEqual(event.eventName, 'OrderCreated');
    assert.strictEqual(event.aggregateId, 'order-1');
    assert.strictEqual(event.payload.amount, 100);
    assert.ok(event.eventId);
    assert.ok(event.occurredAt);
  });

  it('should serialize domain event', () => {
    const event = new DomainEvent('OrderCreated', 'order-1', { amount: 100 });
    const json = event.toJSON();
    assert.strictEqual(json.eventName, 'OrderCreated');
    assert.strictEqual(json.aggregateId, 'order-1');
    assert.strictEqual(json.payload.amount, 100);
  });

  describe('DomainEventBus', () => {
    let bus;
    beforeEach(() => { bus = new DomainEventBus(); });
    afterEach(() => { bus.shutdown(); });

    it('should subscribe and publish events', async () => {
      const received = [];
      bus.subscribe('TestEvent', (event) => received.push(event));
      await bus.publish(new DomainEvent('TestEvent', 'agg-1'));
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].aggregateId, 'agg-1');
    });

    it('should support wildcard subscriptions', async () => {
      const received = [];
      bus.subscribe('*', (event) => received.push(event));
      await bus.publish(new DomainEvent('EventA', 'agg-1'));
      await bus.publish(new DomainEvent('EventB', 'agg-2'));
      assert.strictEqual(received.length, 2);
    });

    it('should return unsubscribe function', async () => {
      const received = [];
      const unsubscribe = bus.subscribe('TestEvent', (event) => received.push(event));
      unsubscribe();
      await bus.publish(new DomainEvent('TestEvent', 'agg-1'));
      assert.strictEqual(received.length, 0);
    });

    it('should support async handlers', async () => {
      const results = [];
      bus.subscribe('AsyncEvent', async (_event) => {
        results.push('started');
        await new Promise(r => setTimeout(r, 10));
        results.push('completed');
      }, { async: true });
      await bus.publish(new DomainEvent('AsyncEvent', 'agg-1'));
      assert.strictEqual(results.length, 2);
    });

    it('should track event history', async () => {
      await bus.publish(new DomainEvent('EventA', 'agg-1'));
      await bus.publish(new DomainEvent('EventB', 'agg-2'));
      const history = bus.getHistory();
      assert.strictEqual(history.length, 2);
    });

    it('should get stats', async () => {
      bus.subscribe('EventA', () => {});
      bus.subscribe('EventB', () => {});
      await bus.publish(new DomainEvent('EventA', 'agg-1'));
      const stats = bus.getStats();
      assert.strictEqual(stats.totalSubscriptions, 2);
      assert.strictEqual(stats.eventTypes, 2);
      assert.strictEqual(stats.historySize, 1);
    });

    it('should throw on non-DomainEvent publish', async () => {
      await assert.rejects(() => bus.publish({ eventName: 'X' }), /DomainEvent/);
    });

    it('should publish all events', async () => {
      const received = [];
      bus.subscribe('*', (e) => received.push(e.eventName));
      await bus.publishAll([
        new DomainEvent('A', 'agg-1'),
        new DomainEvent('B', 'agg-2'),
      ]);
      assert.strictEqual(received.length, 2);
    });
  });
});

// ============================================================
// Repository
// ============================================================
describe('DDD - Repository', () => {
  class TestRepo extends InMemoryRepository {}

  let repo;
  beforeEach(() => { repo = new TestRepo(); });

  it('should save and find by id', async () => {
    const entity = new Entity('e-1');
    await repo.save(entity);
    const found = await repo.findById('e-1');
    assert.ok(found);
    assert.strictEqual(found.id, 'e-1');
  });

  it('should return null for missing id', async () => {
    const found = await repo.findById('nonexistent');
    assert.strictEqual(found, null);
  });

  it('should delete entity', async () => {
    const entity = new Entity('e-1');
    await repo.save(entity);
    await repo.delete('e-1');
    assert.strictEqual(await repo.findById('e-1'), null);
  });

  it('should find all', async () => {
    await repo.save(new Entity('e-1'));
    await repo.save(new Entity('e-2'));
    const all = await repo.findAll();
    assert.strictEqual(all.length, 2);
  });

  it('should find by criteria', async () => {
    const e1 = new Entity('e-1');
    e1.status = 'active';
    const e2 = new Entity('e-2');
    e2.status = 'inactive';
    await repo.save(e1);
    await repo.save(e2);
    const found = await repo.findBy({ status: 'active' });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].id, 'e-1');
  });

  it('should count', async () => {
    await repo.save(new Entity('e-1'));
    await repo.save(new Entity('e-2'));
    assert.strictEqual(await repo.count(), 2);
  });

  it('should clear store', async () => {
    await repo.save(new Entity('e-1'));
    repo.clear();
    assert.strictEqual(await repo.count(), 0);
  });
});

// ============================================================
// DomainService
// ============================================================
describe('DDD - DomainService', () => {
  it('should return service name', () => {
    class TransferService extends DomainService {}
    const svc = new TransferService();
    assert.strictEqual(svc.getServiceName(), 'TransferService');
  });

  it('should canExecute by default', () => {
    const svc = new DomainService();
    assert.strictEqual(svc.canExecute(), true);
  });
});

// ============================================================
// Specification
// ============================================================
describe('DDD - Specification', () => {
  class GreaterThanSpec extends Specification {
    constructor(threshold) { super(); this._threshold = threshold; }
    isSatisfiedBy(candidate) { return candidate > this._threshold; }
  }

  class LessThanSpec extends Specification {
    constructor(threshold) { super(); this._threshold = threshold; }
    isSatisfiedBy(candidate) { return candidate < this._threshold; }
  }

  it('should throw if not implemented', () => {
    const spec = new Specification();
    assert.throws(() => spec.isSatisfiedBy(5), /implement/);
  });

  it('should AND combine specifications', () => {
    const spec = new GreaterThanSpec(5).and(new LessThanSpec(15));
    assert.strictEqual(spec.isSatisfiedBy(10), true);
    assert.strictEqual(spec.isSatisfiedBy(3), false);
    assert.strictEqual(spec.isSatisfiedBy(20), false);
  });

  it('should OR combine specifications', () => {
    const spec = new GreaterThanSpec(15).or(new LessThanSpec(5));
    assert.strictEqual(spec.isSatisfiedBy(20), true);
    assert.strictEqual(spec.isSatisfiedBy(3), true);
    assert.strictEqual(spec.isSatisfiedBy(10), false);
  });

  it('should NOT negate specification', () => {
    const spec = new GreaterThanSpec(5).not();
    assert.strictEqual(spec.isSatisfiedBy(10), false);
    assert.strictEqual(spec.isSatisfiedBy(3), true);
  });

  it('should chain multiple operations', () => {
    // (x > 5 AND x < 15) OR x > 100
    const range = new GreaterThanSpec(5).and(new LessThanSpec(15));
    const spec = range.or(new GreaterThanSpec(100));
    assert.strictEqual(spec.isSatisfiedBy(10), true);
    assert.strictEqual(spec.isSatisfiedBy(3), false);
    assert.strictEqual(spec.isSatisfiedBy(200), true);
    assert.strictEqual(spec.isSatisfiedBy(50), false);
  });
});

// ============================================================
// ContextMapper
// ============================================================
describe('DDD - ContextMapper', () => {
  let mapper;
  beforeEach(() => { mapper = new ContextMapper(); });

  it('should register context', () => {
    const result = mapper.registerContext('orders', {
      modules: ['order', 'payment'],
      description: 'Order management',
    });
    assert.ok(result.id);
    assert.strictEqual(result.name, 'orders');
  });

  it('should get context', () => {
    mapper.registerContext('orders', { modules: ['order'] });
    const ctx = mapper.getContext('orders');
    assert.ok(ctx);
    assert.strictEqual(ctx.name, 'orders');
  });

  it('should return null for unknown context', () => {
    assert.strictEqual(mapper.getContext('unknown'), null);
  });

  it('should get all contexts', () => {
    mapper.registerContext('ctx1', { modules: ['m1'] });
    mapper.registerContext('ctx2', { modules: ['m2'] });
    assert.strictEqual(mapper.getAllContexts().length, 2);
  });

  it('should define relationship', () => {
    mapper.registerContext('orders', { modules: ['order'] });
    mapper.registerContext('shipping', { modules: ['logistics'] });
    const rel = mapper.defineRelationship('orders', 'shipping', 'customer-supplier', { upstream: 'orders' });
    assert.strictEqual(rel.type, 'customer-supplier');
    assert.strictEqual(rel.source, 'orders');
    assert.strictEqual(rel.target, 'shipping');
  });

  it('should throw on unknown context relationship', () => {
    assert.throws(() => mapper.defineRelationship('unknown', 'shipping', 'shared-kernel'), /not registered/);
  });

  it('should get relationship', () => {
    mapper.registerContext('a', { modules: [] });
    mapper.registerContext('b', { modules: [] });
    mapper.defineRelationship('a', 'b', 'shared-kernel');
    const rel = mapper.getRelationship('a', 'b');
    assert.ok(rel);
    assert.strictEqual(rel.type, 'shared-kernel');
  });

  it('should get context relationships', () => {
    mapper.registerContext('a', { modules: [] });
    mapper.registerContext('b', { modules: [] });
    mapper.registerContext('c', { modules: [] });
    mapper.defineRelationship('a', 'b', 'shared-kernel');
    mapper.defineRelationship('a', 'c', 'customer-supplier');
    const rels = mapper.getContextRelationships('a');
    assert.strictEqual(rels.length, 2);
  });

  it('should register and get ubiquitous language', () => {
    mapper.registerContext('orders', { modules: [] });
    mapper.registerTerm('orders', 'Order', 'A purchase request from a customer');
    mapper.registerTerm('orders', 'LineItem', 'A single product entry within an order');
    const lang = mapper.getUbiquitousLanguage('orders');
    assert.strictEqual(Object.keys(lang).length, 2);
    assert.strictEqual(lang['Order'], 'A purchase request from a customer');
  });

  it('should import from config', () => {
    const config = {
      'platform-integration': {
        modules: ['platform/gateway'],
        description: 'Platform integration',
        core_concepts: ['Gateway', 'Registry'],
      },
      'quality-assurance': {
        modules: ['quality/scorer'],
        description: 'Quality assurance',
        core_concepts: ['Scorer', 'Gate'],
      },
    };
    mapper.importFromConfig(config);
    assert.strictEqual(mapper.getAllContexts().length, 2);
    const ctx = mapper.getContext('platform-integration');
    assert.strictEqual(ctx.coreConcepts.length, 2);
  });

  it('should get stats', () => {
    mapper.registerContext('ctx1', { modules: ['m1'] });
    mapper.registerContext('ctx2', { modules: ['m2'] });
    mapper.registerContext('ctx3', { modules: ['m3'] });
    mapper.defineRelationship('ctx1', 'ctx2', 'shared-kernel');
    mapper.registerTerm('ctx1', 'Term1', 'Definition 1');
    const stats = mapper.getStats();
    assert.strictEqual(stats.totalContexts, 3);
    assert.strictEqual(stats.totalRelationships, 1);
    assert.strictEqual(stats.totalTerms, 1);
  });
});

// ============================================================
// TDD Cycle Tracker
// ============================================================
describe('TddCycleTracker', () => {
  let tracker;
  beforeEach(() => { tracker = new TddCycleTracker(); });
  afterEach(() => { tracker.shutdown(); });

  it('should start a cycle', () => {
    const result = tracker.startCycle('login-feature');
    assert.ok(result.cycleId);
    assert.strictEqual(result.phase, 'RED');
    assert.ok(result.startedAt);
  });

  it('should transition RED → GREEN', () => {
    tracker.startCycle('test-feature');
    const result = tracker.transition('GREEN');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.from, 'RED');
    assert.strictEqual(result.to, 'GREEN');
  });

  it('should transition GREEN → REFACTOR', () => {
    tracker.startCycle('test-feature');
    tracker.transition('GREEN');
    const result = tracker.transition('REFACTOR');
    assert.strictEqual(result.from, 'GREEN');
    assert.strictEqual(result.to, 'REFACTOR');
  });

  it('should reject invalid transitions', () => {
    tracker.startCycle('test-feature');
    assert.throws(() => tracker.transition('REFACTOR'), /Invalid TDD transition/);
  });

  it('should reject RED → RED (self-transition)', () => {
    tracker.startCycle('test-feature');
    assert.throws(() => tracker.transition('RED'), /Invalid/);
  });

  it('should complete cycle', () => {
    tracker.startCycle('test-feature');
    tracker.transition('GREEN', { testCount: 5, coverage: 85 });
    tracker.transition('REFACTOR');
    const result = tracker.completeCycle({ finalCoverage: 90 });
    assert.strictEqual(result.success, true);
    assert.ok(result.summary.totalDuration >= 0);
  });

  it('should track cycle history', () => {
    tracker.startCycle('feat-1');
    tracker.transition('GREEN');
    tracker.completeCycle();
    tracker.startCycle('feat-2');
    tracker.transition('GREEN');
    tracker.completeCycle();
    const history = tracker.getHistory();
    assert.strictEqual(history.length, 2);
  });

  it('should abort cycle', () => {
    tracker.startCycle('test-feature');
    assert.strictEqual(tracker.abortCycle('test abort'), true);
    const cycle = tracker.getCurrentCycle();
    assert.strictEqual(cycle, null);
  });

  it('should get current cycle', () => {
    tracker.startCycle('test-feature');
    const current = tracker.getCurrentCycle();
    assert.strictEqual(current.featureName, 'test-feature');
    assert.strictEqual(current.phase, 'RED');
  });

  it('should throw transition without active cycle', () => {
    assert.throws(() => tracker.transition('GREEN'), /No active/);
  });

  it('should get stats', () => {
    tracker.startCycle('feat-1');
    tracker.transition('GREEN');
    tracker.completeCycle();
    tracker.startCycle('feat-2');
    tracker.transition('GREEN');
    tracker.transition('REFACTOR');
    tracker.completeCycle();
    const stats = tracker.getStats();
    assert.strictEqual(stats.totalCycles, 2);
    assert.strictEqual(stats.successfulCycles, 2);
    assert.strictEqual(stats.hasActiveCycle, false);
  });

  it('should emit events', () => {
    const events = [];
    tracker.on('cycleStarted', (data) => events.push({ type: 'started', ...data }));
    tracker.on('cycleCompleted', (data) => events.push({ type: 'completed', ...data }));
    tracker.startCycle('event-test');
    tracker.transition('GREEN');
    tracker.completeCycle();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'started');
    assert.strictEqual(events[1].type, 'completed');
  });

  it('should auto-complete cycle on shutdown', () => {
    tracker.startCycle('shutdown-test');
    tracker.shutdown();
    const stats = tracker.getStats();
    assert.strictEqual(stats.totalCycles, 1);
    assert.strictEqual(stats.failedCycles, 1);
  });

  it('should track phase durations', () => {
    tracker.startCycle('duration-test');
    tracker.transition('GREEN');
    tracker.transition('REFACTOR');
    const result = tracker.completeCycle();
    assert.ok(result.summary.phaseDurations.RED >= 0);
    assert.ok(result.summary.phaseDurations.GREEN >= 0);
    assert.ok(result.summary.phaseDurations.REFACTOR >= 0);
  });
});
