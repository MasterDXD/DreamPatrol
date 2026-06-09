'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ContextBudgetOptimizer,
  FEATURE_LAYERS,
  LAYER_PRIORITY,
  LAYER_DEFAULT_BUDGET_RATIO,
} = require('../../../src/runtime/infrastructure/context-budget-optimizer');

describe('ContextBudgetOptimizer - constants and constructor', () => {
  let optimizer;

  beforeEach(() => {
    optimizer = new ContextBudgetOptimizer();
  });

  afterEach(() => {
    if (optimizer && typeof optimizer.shutdown === 'function') {
      optimizer.shutdown();
    }
    optimizer = null;
  });

  describe('exported constants', () => {
    it('FEATURE_LAYERS should define all five layers', () => {
      assert.equal(FEATURE_LAYERS.PROJECT_MEMORY, 'project_memory');
      assert.equal(FEATURE_LAYERS.SKILLS, 'skills');
      assert.equal(FEATURE_LAYERS.MCP, 'mcp');
      assert.equal(FEATURE_LAYERS.SUBAGENTS, 'subagents');
      assert.equal(FEATURE_LAYERS.HOOKS, 'hooks');
    });

    it('LAYER_PRIORITY should map each layer to a numeric priority', () => {
      assert.equal(LAYER_PRIORITY[FEATURE_LAYERS.PROJECT_MEMORY], 5);
      assert.equal(LAYER_PRIORITY[FEATURE_LAYERS.SKILLS], 4);
      assert.equal(LAYER_PRIORITY[FEATURE_LAYERS.MCP], 3);
      assert.equal(LAYER_PRIORITY[FEATURE_LAYERS.SUBAGENTS], 2);
      assert.equal(LAYER_PRIORITY[FEATURE_LAYERS.HOOKS], 1);
    });

    it('LAYER_DEFAULT_BUDGET_RATIO should sum to 1', () => {
      const sum = Object.values(LAYER_DEFAULT_BUDGET_RATIO)
        .reduce((acc, r) => acc + r, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, 'ratios should sum to 1');
    });

    it('LAYER_DEFAULT_BUDGET_RATIO should have entry for every layer', () => {
      for (const layer of Object.values(FEATURE_LAYERS)) {
        assert.ok(layer in LAYER_DEFAULT_BUDGET_RATIO, `missing ratio for ${layer}`);
      }
    });
  });

  describe('constructor', () => {
    it('should create an instance with default config', () => {
      assert.ok(optimizer instanceof ContextBudgetOptimizer);
      assert.equal(optimizer._config.maxContextTokens, 200000);
      assert.equal(optimizer._config.warningThreshold, 0.8);
      assert.equal(optimizer._config.dangerThreshold, 0.95);
    });

    it('should accept custom config', () => {
      const custom = new ContextBudgetOptimizer({
        maxContextTokens: 100000,
        warningThreshold: 0.7,
      });
      try {
        assert.equal(custom._config.maxContextTokens, 100000);
        assert.equal(custom._config.warningThreshold, 0.7);
        assert.equal(custom._config.dangerThreshold, 0.95);
      } finally {
        custom.shutdown();
      }
    });

    it('should allocate budgets for all layers', () => {
      for (const layer of Object.values(FEATURE_LAYERS)) {
        assert.ok(optimizer._layerBudgets[layer] > 0, `budget for ${layer} should be positive`);
      }
    });

    it('should initialize stats with zeros', () => {
      const stats = optimizer.getStats();
      assert.equal(stats.totalAllocations, 0);
      assert.equal(stats.totalRejections, 0);
      assert.equal(stats.totalReclaims, 0);
    });

    it('should be healthy after construction', () => {
      assert.equal(optimizer.isHealthy(), true);
    });
  });
});

describe('ContextBudgetOptimizer - canLoad and registerLoad', () => {
  let optimizer;

  beforeEach(() => {
    optimizer = new ContextBudgetOptimizer();
  });

  afterEach(() => {
    if (optimizer && typeof optimizer.shutdown === 'function') {
      optimizer.shutdown();
    }
    optimizer = null;
  });

  describe('canLoad', () => {
    it('should return true when budget allows', () => {
      assert.equal(
        optimizer.canLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'item1', 1000),
        true,
      );
    });

    it('should return false for unknown layer', () => {
      assert.equal(
        optimizer.canLoad('unknown_layer', 'item1', 1000),
        false,
      );
    });

    it('should return false when estimated tokens exceed budget', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY];
      assert.equal(
        optimizer.canLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'item1', budget + 1),
        false,
      );
    });

    it('should return false when current usage plus tokens exceeds budget', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.HOOKS];
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'existing', budget - 100);
      assert.equal(
        optimizer.canLoad(FEATURE_LAYERS.HOOKS, 'newItem', 200),
        false,
      );
    });

    it('should emit budget-exceeded event when budget is exceeded', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.MCP];
      let eventData = null;
      optimizer.on('budget-exceeded', (data) => { eventData = data; });
      optimizer.canLoad(FEATURE_LAYERS.MCP, 'bigItem', budget + 1);
      assert.ok(eventData);
      assert.equal(eventData.layer, FEATURE_LAYERS.MCP);
      assert.equal(eventData.itemId, 'bigItem');
    });

    it('should throw after shutdown', () => {
      optimizer.shutdown();
      assert.throws(() => {
        optimizer.canLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'item1', 100);
      });
    });
  });

  describe('registerLoad', () => {
    it('should register a load and return true', () => {
      assert.equal(
        optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 5000),
        true,
      );
    });

    it('should increase layer usage', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 5000);
      assert.equal(optimizer._layerUsage.get(FEATURE_LAYERS.SKILLS), 5000);
    });

    it('should increase totalUsed', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 5000);
      assert.equal(optimizer._totalUsed, 5000);
    });

    it('should track loaded item in layerLoaded set', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 5000);
      assert.ok(optimizer._layerLoaded[FEATURE_LAYERS.SKILLS].has('skill1'));
    });

    it('should update stats', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 5000);
      const stats = optimizer.getStats();
      assert.equal(stats.totalAllocations, 1);
      assert.equal(stats.layerStats[FEATURE_LAYERS.SKILLS].allocations, 1);
    });

    it('should update peakUsage', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 5000);
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill2', 3000);
      assert.equal(
        optimizer._stats.layerStats[FEATURE_LAYERS.SKILLS].peakUsage,
        8000,
      );
    });

    it('should emit item-loaded event', () => {
      let eventData = null;
      optimizer.on('item-loaded', (data) => { eventData = data; });
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 2000);
      assert.ok(eventData);
      assert.equal(eventData.layer, FEATURE_LAYERS.MCP);
      assert.equal(eventData.itemId, 'mcp1');
      assert.equal(eventData.tokenCount, 2000);
      assert.equal(eventData.totalUsed, 2000);
    });

    it('should return false for unknown layer', () => {
      assert.equal(
        optimizer.registerLoad('unknown', 'item1', 100),
        false,
      );
    });

    it('should return false when budget exceeded', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.SUBAGENTS];
      assert.equal(
        optimizer.registerLoad(FEATURE_LAYERS.SUBAGENTS, 'big', budget + 1),
        false,
      );
    });

    it('should increment rejection stats when budget exceeded', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.SUBAGENTS];
      optimizer.registerLoad(FEATURE_LAYERS.SUBAGENTS, 'big', budget + 1);
      const stats = optimizer.getStats();
      assert.equal(stats.totalRejections, 1);
      assert.equal(stats.layerStats[FEATURE_LAYERS.SUBAGENTS].rejections, 1);
    });

    it('should emit budget-exceeded when budget exceeded', () => {
      let eventData = null;
      optimizer.on('budget-exceeded', (data) => { eventData = data; });
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.SUBAGENTS];
      optimizer.registerLoad(FEATURE_LAYERS.SUBAGENTS, 'big', budget + 1);
      assert.ok(eventData);
      assert.equal(eventData.layer, FEATURE_LAYERS.SUBAGENTS);
    });

    it('should throw after shutdown', () => {
      optimizer.shutdown();
      assert.throws(() => {
        optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 100);
      });
    });
  });
});

describe('ContextBudgetOptimizer - unregisterLoad and reclaimFromLayer', () => {
  let optimizer;

  beforeEach(() => {
    optimizer = new ContextBudgetOptimizer();
  });

  afterEach(() => {
    if (optimizer && typeof optimizer.shutdown === 'function') {
      optimizer.shutdown();
    }
    optimizer = null;
  });

  describe('unregisterLoad', () => {
    it('should unregister a load and return true', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.equal(
        optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000),
        true,
      );
    });

    it('should decrease layer usage', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.equal(optimizer._layerUsage.get(FEATURE_LAYERS.HOOKS), 0);
    });

    it('should decrease totalUsed', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.equal(optimizer._totalUsed, 0);
    });

    it('should remove item from layerLoaded set', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.ok(!optimizer._layerLoaded[FEATURE_LAYERS.HOOKS].has('hook1'));
    });

    it('should emit item-unloaded event', () => {
      let eventData = null;
      optimizer.on('item-unloaded', (data) => { eventData = data; });
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.ok(eventData);
      assert.equal(eventData.layer, FEATURE_LAYERS.HOOKS);
      assert.equal(eventData.itemId, 'hook1');
      assert.equal(eventData.tokenCount, 1000);
    });

    it('should return false for unknown layer', () => {
      assert.equal(
        optimizer.unregisterLoad('unknown', 'item1', 100),
        false,
      );
    });

    it('should return false when item not loaded', () => {
      assert.equal(
        optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'nonexistent', 100),
        false,
      );
    });

    it('should not go below zero usage', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 500);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.equal(optimizer._layerUsage.get(FEATURE_LAYERS.HOOKS), 0);
    });

    it('should not go below zero totalUsed', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 500);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.equal(optimizer._totalUsed, 0);
    });

    it('should throw after shutdown', () => {
      optimizer.shutdown();
      assert.throws(() => {
        optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 100);
      });
    });
  });

  describe('reclaimFromLayer', () => {
    it('should reclaim tokens from a layer', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      const reclaimed = optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 3000);
      assert.equal(reclaimed, 3000);
    });

    it('should not reclaim more than current usage', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      const reclaimed = optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 10000);
      assert.equal(reclaimed, 5000);
    });

    it('should return 0 for unknown layer', () => {
      assert.equal(optimizer.reclaimFromLayer('unknown', 1000), 0);
    });

    it('should return 0 when no usage', () => {
      assert.equal(optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 1000), 0);
    });

    it('should decrease layer usage', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 3000);
      assert.equal(optimizer._layerUsage.get(FEATURE_LAYERS.MCP), 2000);
    });

    it('should decrease totalUsed', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 3000);
      assert.equal(optimizer._totalUsed, 2000);
    });

    it('should remove loaded items proportionally when reclaiming', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp2', 3000);
      optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 1000);
      assert.ok(optimizer._layerLoaded[FEATURE_LAYERS.MCP].size < 2);
      assert.ok(optimizer._layerLoaded[FEATURE_LAYERS.MCP].size >= 1);
    });

    it('should update reclaim stats', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 3000);
      const stats = optimizer.getStats();
      assert.equal(stats.totalReclaims, 1);
      assert.equal(stats.layerStats[FEATURE_LAYERS.MCP].reclaims, 3000);
    });

    it('should emit budget-reclaimed event', () => {
      let eventData = null;
      optimizer.on('budget-reclaimed', (data) => { eventData = data; });
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 5000);
      optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 3000);
      assert.ok(eventData);
      assert.equal(eventData.layer, FEATURE_LAYERS.MCP);
      assert.equal(eventData.reclaimed, 3000);
    });

    it('should throw after shutdown', () => {
      optimizer.shutdown();
      assert.throws(() => {
        optimizer.reclaimFromLayer(FEATURE_LAYERS.MCP, 1000);
      });
    });
  });
});

describe('ContextBudgetOptimizer - reallocate, status, recommendations', () => {
  let optimizer;

  beforeEach(() => {
    optimizer = new ContextBudgetOptimizer();
  });

  afterEach(() => {
    if (optimizer && typeof optimizer.shutdown === 'function') {
      optimizer.shutdown();
    }
    optimizer = null;
  });

  describe('reallocateBudgets', () => {
    it('should reallocate budgets based on usage pattern', () => {
      optimizer.reallocateBudgets({
        [FEATURE_LAYERS.PROJECT_MEMORY]: 0.5,
        [FEATURE_LAYERS.SKILLS]: 0.5,
      });
      const total = optimizer._config.maxContextTokens;
      assert.equal(optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY], Math.floor(total * 0.5));
      assert.equal(optimizer._layerBudgets[FEATURE_LAYERS.SKILLS], Math.floor(total * 0.5));
    });

    it('should normalize ratios when they do not sum to 1', () => {
      optimizer.reallocateBudgets({
        [FEATURE_LAYERS.PROJECT_MEMORY]: 2,
        [FEATURE_LAYERS.SKILLS]: 2,
      });
      const total = optimizer._config.maxContextTokens;
      assert.equal(optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY], Math.floor(total * 0.5));
      assert.equal(optimizer._layerBudgets[FEATURE_LAYERS.SKILLS], Math.floor(total * 0.5));
    });

    it('should do nothing when sum of ratios is 0', () => {
      const budgetBefore = optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY];
      optimizer.reallocateBudgets({
        [FEATURE_LAYERS.PROJECT_MEMORY]: 0,
      });
      assert.equal(optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY], budgetBefore);
    });

    it('should emit budgets-reallocated event', () => {
      let eventData = null;
      optimizer.on('budgets-reallocated', (data) => { eventData = data; });
      optimizer.reallocateBudgets({
        [FEATURE_LAYERS.PROJECT_MEMORY]: 0.6,
        [FEATURE_LAYERS.SKILLS]: 0.4,
      });
      assert.ok(eventData);
      assert.ok(eventData.budgets);
      assert.ok(FEATURE_LAYERS.PROJECT_MEMORY in eventData.budgets);
    });

    it('should throw after shutdown', () => {
      optimizer.shutdown();
      assert.throws(() => {
        optimizer.reallocateBudgets({ [FEATURE_LAYERS.MCP]: 1 });
      });
    });
  });

  describe('getBudgetStatus', () => {
    it('should return status with all layers', () => {
      const status = optimizer.getBudgetStatus();
      assert.ok(status.layers);
      for (const layer of Object.values(FEATURE_LAYERS)) {
        assert.ok(layer in status.layers, `missing ${layer} in status`);
      }
    });

    it('should report totalUsed and totalBudget', () => {
      const status = optimizer.getBudgetStatus();
      assert.equal(status.totalUsed, 0);
      assert.equal(status.totalBudget, optimizer._config.maxContextTokens);
    });

    it('should report utilization', () => {
      const status = optimizer.getBudgetStatus();
      assert.equal(status.utilization, 0);
    });

    it('should reflect loaded items count', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 1000);
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill2', 2000);
      const status = optimizer.getBudgetStatus();
      assert.equal(status.layers[FEATURE_LAYERS.SKILLS].loadedItems, 2);
    });

    it('should return safe defaults after shutdown', () => {
      optimizer.shutdown();
      const status = optimizer.getBudgetStatus();
      assert.equal(status.totalUsed, 0);
      assert.equal(status.totalBudget, 0);
      assert.equal(status.utilization, 0);
      assert.deepStrictEqual(status.layers, {});
    });
  });

  describe('getRecommendations', () => {
    it('should return no reduce recommendations when utilization is normal', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 1000);
      const recs = optimizer.getRecommendations();
      const reduceRecs = recs.filter((r) => r.action === 'reduce');
      assert.equal(reduceRecs.length, 0);
    });

    it('should recommend reduce when layer exceeds danger threshold', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.MCP];
      const tokens = Math.floor(budget * 0.96);
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'big1', tokens);
      const recs = optimizer.getRecommendations();
      const reduceRec = recs.find((r) => r.layer === FEATURE_LAYERS.MCP && r.action === 'reduce');
      assert.ok(reduceRec, 'should have a reduce recommendation');
      assert.ok(reduceRec.suggestedReclaim > 0);
    });

    it('should recommend expand for underutilized high-priority layers', () => {
      const custom = new ContextBudgetOptimizer({ maxContextTokens: 100000 });
      try {
        const recs = custom.getRecommendations();
        const expandRec = recs.find((r) => r.action === 'expand');
        assert.ok(expandRec, 'should have an expand recommendation');
        assert.ok(expandRec.suggestedIncrease > 0);
      } finally {
        custom.shutdown();
      }
    });

    it('should return empty array after shutdown', () => {
      optimizer.shutdown();
      const recs = optimizer.getRecommendations();
      assert.deepStrictEqual(recs, []);
    });
  });
});

describe('ContextBudgetOptimizer - stats, thresholds, shutdown, edge cases', () => {
  let optimizer;

  beforeEach(() => {
    optimizer = new ContextBudgetOptimizer();
  });

  afterEach(() => {
    if (optimizer && typeof optimizer.shutdown === 'function') {
      optimizer.shutdown();
    }
    optimizer = null;
  });

  describe('getStats', () => {
    it('should return stats with totalUsed and totalBudget', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 500);
      const stats = optimizer.getStats();
      assert.equal(stats.totalUsed, 500);
      assert.equal(stats.totalBudget, optimizer._config.maxContextTokens);
    });

    it('should track allocations, rejections, and reclaims', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 500);
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.HOOKS];
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook2', budget);
      optimizer.reclaimFromLayer(FEATURE_LAYERS.HOOKS, 100);
      const stats = optimizer.getStats();
      assert.equal(stats.totalAllocations, 1);
      assert.equal(stats.totalRejections, 1);
      assert.equal(stats.totalReclaims, 1);
    });

    it('should return safe defaults after shutdown', () => {
      optimizer.shutdown();
      const stats = optimizer.getStats();
      assert.equal(stats.totalAllocations, 0);
      assert.equal(stats.totalRejections, 0);
      assert.equal(stats.totalReclaims, 0);
      assert.deepStrictEqual(stats.layerStats, {});
    });
  });

  describe('threshold events', () => {
    it('should emit budget-warning when utilization >= warningThreshold', () => {
      let warningData = null;
      optimizer.on('budget-warning', (data) => { warningData = data; });
      const pmBudget = optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY];
      const skBudget = optimizer._layerBudgets[FEATURE_LAYERS.SKILLS];
      const mcpBudget = optimizer._layerBudgets[FEATURE_LAYERS.MCP];
      optimizer.registerLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'pm1', pmBudget);
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'sk1', skBudget);
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', mcpBudget);
      assert.ok(warningData, 'should emit budget-warning');
      assert.ok(warningData.utilization >= optimizer._config.warningThreshold);
    });

    it('should emit budget-danger when utilization >= dangerThreshold', () => {
      let dangerData = null;
      optimizer.on('budget-danger', (data) => { dangerData = data; });
      const pmBudget = optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY];
      const skBudget = optimizer._layerBudgets[FEATURE_LAYERS.SKILLS];
      const mcpBudget = optimizer._layerBudgets[FEATURE_LAYERS.MCP];
      const subBudget = optimizer._layerBudgets[FEATURE_LAYERS.SUBAGENTS];
      const hooksBudget = optimizer._layerBudgets[FEATURE_LAYERS.HOOKS];
      optimizer.registerLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'pm1', pmBudget);
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'sk1', skBudget);
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', mcpBudget);
      optimizer.registerLoad(FEATURE_LAYERS.SUBAGENTS, 'sub1', subBudget);
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', hooksBudget);
      assert.ok(dangerData, 'should emit budget-danger');
      assert.ok(dangerData.utilization >= optimizer._config.dangerThreshold);
    });

    it('should emit budget-danger but not budget-warning at danger level', () => {
      const custom = new ContextBudgetOptimizer({ maxContextTokens: 1000 });
      try {
        custom.reallocateBudgets({ [FEATURE_LAYERS.PROJECT_MEMORY]: 1 });
        let warningFired = false;
        let dangerFired = false;
        custom.on('budget-warning', () => { warningFired = true; });
        custom.on('budget-danger', () => { dangerFired = true; });
        custom.registerLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'pm1', 960);
        assert.ok(dangerFired);
        assert.ok(!warningFired, 'budget-warning should not fire at danger level');
      } finally {
        custom.shutdown();
      }
    });
  });

  describe('shutdown', () => {
    it('should mark instance as not healthy', () => {
      optimizer.shutdown();
      assert.equal(optimizer.isHealthy(), false);
    });

    it('should clear layer loaded sets', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 1000);
      optimizer.shutdown();
      for (const set of Object.values(optimizer._layerLoaded)) {
        assert.equal(set.size, 0);
      }
    });

    it('should reset totalUsed to 0', () => {
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'skill1', 1000);
      optimizer.shutdown();
      assert.equal(optimizer._totalUsed, 0);
    });

    it('should clear layer budgets', () => {
      optimizer.shutdown();
      assert.deepStrictEqual(optimizer._layerBudgets, {});
    });

    it('should remove all listeners', () => {
      optimizer.on('test-event', () => {});
      optimizer.shutdown();
      assert.equal(optimizer.listenerCount('test-event'), 0);
    });

    it('should be idempotent', () => {
      optimizer.shutdown();
      optimizer.shutdown();
      assert.equal(optimizer.isHealthy(), false);
    });

    it('should cause guardShutdown to throw', () => {
      optimizer.shutdown();
      assert.throws(() => {
        optimizer.guardShutdown();
      });
    });
  });

  describe('edge cases', () => {
    it('should handle multiple loads and unloads correctly', () => {
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 1000);
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp2', 2000);
      optimizer.unregisterLoad(FEATURE_LAYERS.MCP, 'mcp1', 1000);
      assert.equal(optimizer._totalUsed, 2000);
      assert.equal(optimizer._layerUsage.get(FEATURE_LAYERS.MCP), 2000);
      assert.ok(!optimizer._layerLoaded[FEATURE_LAYERS.MCP].has('mcp1'));
      assert.ok(optimizer._layerLoaded[FEATURE_LAYERS.MCP].has('mcp2'));
    });

    it('should handle load across multiple layers', () => {
      optimizer.registerLoad(FEATURE_LAYERS.PROJECT_MEMORY, 'pm1', 1000);
      optimizer.registerLoad(FEATURE_LAYERS.SKILLS, 'sk1', 2000);
      optimizer.registerLoad(FEATURE_LAYERS.MCP, 'mcp1', 3000);
      assert.equal(optimizer._totalUsed, 6000);
    });

    it('should handle zero token registration', () => {
      assert.equal(
        optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'zero', 0),
        true,
      );
      assert.ok(optimizer._layerLoaded[FEATURE_LAYERS.HOOKS].has('zero'));
    });

    it('should handle unregister with token count larger than actual', () => {
      optimizer.registerLoad(FEATURE_LAYERS.HOOKS, 'hook1', 500);
      optimizer.unregisterLoad(FEATURE_LAYERS.HOOKS, 'hook1', 1000);
      assert.equal(optimizer._layerUsage.get(FEATURE_LAYERS.HOOKS), 0);
      assert.equal(optimizer._totalUsed, 0);
    });

    it('should handle canLoad with exact budget amount', () => {
      const budget = optimizer._layerBudgets[FEATURE_LAYERS.HOOKS];
      assert.equal(
        optimizer.canLoad(FEATURE_LAYERS.HOOKS, 'exact', budget),
        true,
      );
    });

    it('should handle reclaim on empty layer', () => {
      const reclaimed = optimizer.reclaimFromLayer(FEATURE_LAYERS.HOOKS, 1000);
      assert.equal(reclaimed, 0);
    });

    it('should handle reallocateBudgets with single layer', () => {
      optimizer.reallocateBudgets({
        [FEATURE_LAYERS.PROJECT_MEMORY]: 1,
      });
      const total = optimizer._config.maxContextTokens;
      assert.equal(
        optimizer._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY],
        total,
      );
    });

    it('should handle custom maxContextTokens config', () => {
      const small = new ContextBudgetOptimizer({ maxContextTokens: 10000 });
      try {
        const status = small.getBudgetStatus();
        assert.equal(status.totalBudget, 10000);
        const budget = small._layerBudgets[FEATURE_LAYERS.PROJECT_MEMORY];
        assert.equal(budget, Math.floor(10000 * 0.35));
      } finally {
        small.shutdown();
      }
    });
  });
});
