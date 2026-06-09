'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const DeepeningModuleRegistry = require('../../src/runtime/deepening/deepening-module-registry');


describe('constructor', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should initialize with empty instances', () => {
    assert.strictEqual(registry.listLoaded().length, 0);
  });

  it('should list all available modules', () => {
    const available = registry.listAvailable();
    const stats = registry.getStats();
    assert.strictEqual(available.length, stats.totalDefined);
    assert.ok(available.length > 0);
  });

  it('should define module tiers', () => {
    assert.ok(DeepeningModuleRegistry.MODULE_TIERS.CORE);
    assert.ok(DeepeningModuleRegistry.MODULE_TIERS.INFRASTRUCTURE);
    assert.ok(DeepeningModuleRegistry.MODULE_TIERS.ADVANCED);
  });
});

describe('loadCore', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should load only core tier modules', () => {
    const loaded = registry.loadCore();
    assert.ok(loaded.length > 0);
    const stats = registry.getStats();
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.CORE].loaded,
      stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.CORE].total);
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.INFRASTRUCTURE].loaded, 0);
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.ADVANCED].loaded, 0);
  });
});

describe('loadForDepth', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should load core + infrastructure for standard depth', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    const loaded = registry.loadForDepth('standard');
    assert.ok(loaded.length > 0);
    const stats = registry.getStats();
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.CORE].loaded,
      stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.CORE].total);
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.INFRASTRUCTURE].loaded,
      stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.INFRASTRUCTURE].total);
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.ADVANCED].loaded, 0);
  });

  it('should load all tiers for deep depth', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    const loaded = registry.loadForDepth('deep');
    assert.ok(loaded.length > 0);
    const stats = registry.getStats();
    assert.strictEqual(stats.totalLoaded, stats.totalDefined);
  });

  it('should load only core for quick depth', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.loadForDepth('quick');
    const stats = registry.getStats();
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.INFRASTRUCTURE].loaded, 0);
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.ADVANCED].loaded, 0);
  });
});

describe('lazy loading', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should lazy load a module on get', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    const instance = registry.get('deepening-circuit-breaker');
    assert.ok(instance);
    assert.ok(registry.has('deepening-circuit-breaker'));
  });

  it('should return null for unknown module', () => {
    const instance = registry.get('non-existent-module');
    assert.strictEqual(instance, null);
  });

  it('should return cached instance on second get', () => {
    const first = registry.get('deepening-circuit-breaker');
    const second = registry.get('deepening-circuit-breaker');
    assert.strictEqual(first, second);
  });

  it('should track lazy loads in stats', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.get('deepening-circuit-breaker');
    const stats = registry.getStats();
    assert.strictEqual(stats.lazyLoads, 1);
  });
});

describe('getOrLoad', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should return existing instance if loaded', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.loadCore();
    const first = registry.get('quality-scorer');
    const second = registry.getOrLoad('quality-scorer');
    assert.strictEqual(first, second);
  });

  it('should lazy load if not yet loaded', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    const instance = registry.getOrLoad('deepening-rate-limiter');
    assert.ok(instance);
  });
});

describe('unload', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should unload a specific module', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.loadCore();
    assert.ok(registry.has('quality-scorer'));
    const result = registry.unload('quality-scorer');
    assert.strictEqual(result, true);
    assert.ok(!registry.has('quality-scorer'));
  });

  it('should return false for non-loaded module', () => {
    const result = registry.unload('non-existent');
    assert.strictEqual(result, false);
  });
});

describe('unloadTier', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should unload all modules in a tier', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.loadForDepth('deep');
    const unloaded = registry.unloadTier(DeepeningModuleRegistry.MODULE_TIERS.ADVANCED);
    assert.ok(unloaded > 0);
    const stats = registry.getStats();
    assert.strictEqual(stats.loadedByTier[DeepeningModuleRegistry.MODULE_TIERS.ADVANCED].loaded, 0);
  });
});

describe('getStats', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should return comprehensive stats', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.loadCore();
    const stats = registry.getStats();
    assert.ok(typeof stats.totalDefined === 'number');
    assert.ok(typeof stats.totalLoaded === 'number');
    assert.ok(typeof stats.currentDepthLevel === 'string');
    assert.ok(stats.loadedByTier);
  });
});

describe('isHealthy', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should be healthy when modules are loaded', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    registry.loadCore();
    assert.strictEqual(registry.isHealthy(), true);
  });

  it('should be healthy when no modules loaded but not shut down', () => {
    registry.shutdown();
    registry = new DeepeningModuleRegistry({});
    assert.strictEqual(registry.isHealthy(), true);
  });
});

describe('events', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should emit modules-loaded event', (t, done) => {
    const freshRegistry = new DeepeningModuleRegistry({});
    freshRegistry.on('modules-loaded', (data) => {
      assert.ok(data.loaded);
      assert.ok(data.tierLevels);
      freshRegistry.shutdown();
      done();
    });
    freshRegistry.loadCore();
  });

  it('should emit module-unloaded event', (t, done) => {
    const freshRegistry = new DeepeningModuleRegistry({});
    freshRegistry.loadCore();
    const handler = (data) => {
      if (data.moduleName === 'quality-scorer') {
        freshRegistry.removeListener('module-unloaded', handler);
        freshRegistry.shutdown();
        done();
      }
    };
    freshRegistry.on('module-unloaded', handler);
    freshRegistry.unload('quality-scorer');
  });
});

describe('shutdown', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should clear all instances', () => {
    const freshRegistry = new DeepeningModuleRegistry({});
    freshRegistry.loadForDepth('deep');
    freshRegistry.shutdown();
    assert.strictEqual(freshRegistry.listLoaded().length, 0);
  });
});

describe('isDefined', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should return true for defined modules', () => {
    assert.strictEqual(registry.isDefined('quality-scorer'), true);
  });

  it('should return false for unknown modules', () => {
    assert.strictEqual(registry.isDefined('unknown-module'), false);
  });
});

describe('getTier', () => {
  let registry;
  before(() => { registry = new DeepeningModuleRegistry({}); });
  after(() => { if (registry) registry.shutdown(); });
  it('should return correct tier for module', () => {
    assert.strictEqual(registry.getTier('quality-scorer'), DeepeningModuleRegistry.MODULE_TIERS.CORE);
    assert.strictEqual(registry.getTier('deepening-circuit-breaker'), DeepeningModuleRegistry.MODULE_TIERS.INFRASTRUCTURE);
    assert.strictEqual(registry.getTier('deepening-connection-pool'), DeepeningModuleRegistry.MODULE_TIERS.ADVANCED);
  });

  it('should return null for unknown module', () => {
    assert.strictEqual(registry.getTier('unknown'), null);
  });
});
