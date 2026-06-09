'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const CrossGraphBridge = require('../../../src/runtime/thought/cross-graph-bridge');
const { QUERY_DIMENSIONS, SEARCH_STRATEGIES } = CrossGraphBridge;

describe('CrossGraphBridge - Core', () => {
  let bridge;

  beforeEach(() => {
    bridge = new CrossGraphBridge();
  });

  describe('Static Constants', () => {
    it('should export QUERY_DIMENSIONS', () => {
      assert.strictEqual(QUERY_DIMENSIONS.SEMANTIC, 'semantic');
      assert.strictEqual(QUERY_DIMENSIONS.TEMPORAL, 'temporal');
      assert.strictEqual(QUERY_DIMENSIONS.CAUSAL, 'causal');
      assert.strictEqual(QUERY_DIMENSIONS.ENTITY, 'entity');
    });

    it('should export SEARCH_STRATEGIES', () => {
      assert.strictEqual(SEARCH_STRATEGIES.BEAM, 'beam');
      assert.strictEqual(SEARCH_STRATEGIES.BREADTH_FIRST, 'breadth-first');
      assert.strictEqual(SEARCH_STRATEGIES.DEPTH_FIRST, 'depth-first');
      assert.strictEqual(SEARCH_STRATEGIES.BEST_FIRST, 'best-first');
    });
  });

  describe('Attach Sources', () => {
    it('should attach knowledge graph', () => {
      const result = bridge.attachKnowledgeGraph({ findEntitiesByName: () => [] });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.knowledgeGraph, true);
    });

    it('should attach causal bus', () => {
      const result = bridge.attachCausalBus({ getCausalChain: () => [] });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.causalBus, true);
    });

    it('should attach causal memory', () => {
      const result = bridge.attachCausalMemory({ searchByCausalSimilarity: async () => [] });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.causalMemory, true);
    });

    it('should ignore invalid attachments', () => {
      bridge.attachKnowledgeGraph(null);
      bridge.attachCausalBus('invalid');
      bridge.attachCausalMemory(123);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.knowledgeGraph, false);
      assert.strictEqual(stats.attachedSources.causalBus, false);
      assert.strictEqual(stats.attachedSources.causalMemory, false);
    });
  });

  describe('Joint Query', () => {
    it('should return empty results for invalid query', async () => {
      const result = await bridge.jointQuery('');
      assert.strictEqual(result.results.length, 0);
      assert.strictEqual(result.queryId, null);
    });

    it('should return empty results for null query', async () => {
      const result = await bridge.jointQuery(null);
      assert.strictEqual(result.results.length, 0);
    });

    it('should query semantic dimension with knowledge graph', async () => {
      const mockKG = {
        findEntitiesByName: () => [
          { id: 'ent-1', name: 'Authentication', type: 'concept', attributes: {}, createdAt: Date.now() },
        ],
        exportAsTriples: () => [],
      };
      bridge.attachKnowledgeGraph(mockKG);

      const result = await bridge.jointQuery('Authentication', {
        dimensions: ['semantic'],
      });
      assert.ok(result.results.length > 0);
      assert.strictEqual(result.results[0].dimension, 'semantic');
      assert.strictEqual(result.results[0].type, 'entity');
      assert.strictEqual(result.results[0].content, 'Authentication');
    });

    it('should query causal dimension with causal memory', async () => {
      const mockCausalMemory = {
        searchByCausalSimilarity: async () => [
          { id: 'cm-1', cause: 'auth failure', effect: 'session expired', confidence: 0.8, context: '', category: 'security', tags: [], createdAt: Date.now() / 1000 },
        ],
      };
      bridge.attachCausalMemory(mockCausalMemory);

      const result = await bridge.jointQuery('auth failure', {
        dimensions: ['causal'],
      });
      assert.ok(result.results.length > 0);
      assert.strictEqual(result.results[0].dimension, 'causal');
      assert.strictEqual(result.results[0].type, 'causal-memory');
    });

    it('should query temporal dimension with causal bus', async () => {
      const mockBus = {
        getCausalChain: () => [
          { skillId: 'auth', sequence: 1, timestamp: Date.now(), output: { key: 'auth-result', value: 'success' } },
        ],
      };
      bridge.attachCausalBus(mockBus);

      const result = await bridge.jointQuery('auth', {
        dimensions: ['temporal'],
      });
      assert.ok(result.dimensionStats.temporal.queried);
    });

    it('should query entity dimension with knowledge graph neighbors', async () => {
      const mockKG = {
        findEntitiesByName: () => [
          { id: 'ent-1', name: 'JWT', type: 'technology', attributes: {}, createdAt: Date.now() },
        ],
        getNeighbors: () => new Set(['ent-2']),
        getEntity: (id) => id === 'ent-2' ? { id: 'ent-2', name: 'Token', type: 'concept', createdAt: Date.now() } : null,
      };
      bridge.attachKnowledgeGraph(mockKG);

      const result = await bridge.jointQuery('JWT', {
        dimensions: ['entity'],
        maxDepth: 2,
      });
      assert.ok(result.results.length > 0);
      assert.strictEqual(result.results[0].dimension, 'entity');
    });

    it('should merge and dedup results across dimensions', async () => {
      const mockKG = {
        findEntitiesByName: () => [
          { id: 'ent-1', name: 'Auth', type: 'concept', attributes: {}, createdAt: Date.now() },
        ],
        exportAsTriples: () => [],
      };
      const mockCausalMemory = {
        searchByCausalSimilarity: async () => [
          { id: 'cm-1', cause: 'auth error', effect: 'login failed', confidence: 0.9, context: '', category: 'security', tags: [], createdAt: Date.now() / 1000 },
        ],
      };
      bridge.attachKnowledgeGraph(mockKG);
      bridge.attachCausalMemory(mockCausalMemory);

      const result = await bridge.jointQuery('auth', {
        dimensions: ['semantic', 'causal'],
      });
      assert.ok(result.results.length >= 2);
      assert.ok(result.dimensionsQueried.includes('semantic'));
      assert.ok(result.dimensionsQueried.includes('causal'));
    });

    it('should use cache for repeated queries', async () => {
      const mockKG = {
        findEntitiesByName: () => [{ id: 'ent-1', name: 'Test', type: 'concept', attributes: {}, createdAt: Date.now() }],
        exportAsTriples: () => [],
      };
      bridge.attachKnowledgeGraph(mockKG);

      const result1 = await bridge.jointQuery('Test', { dimensions: ['semantic'] });
      const result2 = await bridge.jointQuery('Test', { dimensions: ['semantic'] });
      assert.strictEqual(result1.queryId, result2.queryId);
      const stats = bridge.getStats();
      assert.strictEqual(stats.cacheHits, 1);
    });

    it('should skip unknown dimensions', async () => {
      const result = await bridge.jointQuery('test', {
        dimensions: ['unknown-dim'],
      });
      assert.strictEqual(result.results.length, 0);
    });
  });
});

describe('CrossGraphBridge - Routing & Lifecycle', () => {
  let bridge;

  beforeEach(() => {
    bridge = new CrossGraphBridge();
  });

  describe('Intent-Aware Routing', () => {
    it('should route causal queries correctly', () => {
      const route = bridge.routeByIntent('why did the authentication fail');
      assert.strictEqual(route.primaryDimension, 'causal');
      assert.ok(route.confidence > 0);
    });

    it('should route semantic queries correctly', () => {
      const route = bridge.routeByIntent('what is JWT authentication');
      assert.strictEqual(route.primaryDimension, 'semantic');
    });

    it('should route temporal queries correctly', () => {
      const route = bridge.routeByIntent('when was the last deployment');
      assert.strictEqual(route.primaryDimension, 'temporal');
    });

    it('should route entity queries correctly', () => {
      const route = bridge.routeByIntent('who is responsible for this module');
      assert.strictEqual(route.primaryDimension, 'entity');
    });

    it('should return default for empty query', () => {
      const route = bridge.routeByIntent('');
      assert.strictEqual(route.primaryDimension, null);
      assert.strictEqual(route.confidence, 0);
    });

    it('should return signals breakdown', () => {
      const route = bridge.routeByIntent('why did the error occur');
      assert.ok(route.signals);
      assert.ok(typeof route.signals.causal === 'number');
      assert.ok(typeof route.signals.semantic === 'number');
    });
  });

  describe('Get Stats', () => {
    it('should return stats with default values', () => {
      const stats = bridge.getStats();
      assert.strictEqual(stats.totalQueries, 0);
      assert.strictEqual(stats.cacheHits, 0);
      assert.strictEqual(stats.attachedSources.knowledgeGraph, false);
      assert.strictEqual(stats.attachedSources.causalBus, false);
      assert.strictEqual(stats.attachedSources.causalMemory, false);
    });
  });

  describe('Shutdown', () => {
    it('should prevent queries after shutdown', async () => {
      await bridge.shutdown();
      await assert.rejects(async () => {
        await bridge.jointQuery('test');
      }, /shut down/i);
    });

    it('should prevent routing after shutdown', () => {
      bridge.shutdown();
      const route = bridge.routeByIntent('test');
      assert.strictEqual(route.primaryDimension, null);
    });
  });
});
