'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const CausalMemoryBridge = require('../../../src/runtime/thought/causal-memory-bridge');
const { FEEDBACK_TYPES, CONSOLIDATION_STRATEGIES } = CausalMemoryBridge;

describe('CausalMemoryBridge - Core', () => {
  let bridge;

  beforeEach(() => {
    bridge = new CausalMemoryBridge();
  });

  describe('Static Constants', () => {
    it('should export FEEDBACK_TYPES', () => {
      assert.strictEqual(FEEDBACK_TYPES.DREAM_TO_CAUSAL, 'dream-to-causal');
      assert.strictEqual(FEEDBACK_TYPES.CAUSAL_TO_MEMORY, 'causal-to-memory');
      assert.strictEqual(FEEDBACK_TYPES.MEMORY_TO_PREFETCH, 'memory-to-prefetch');
      assert.strictEqual(FEEDBACK_TYPES.CONSOLIDATION, 'consolidation');
    });

    it('should export CONSOLIDATION_STRATEGIES', () => {
      assert.strictEqual(CONSOLIDATION_STRATEGIES.IMMEDIATE, 'immediate');
      assert.strictEqual(CONSOLIDATION_STRATEGIES.BATCHED, 'batched');
      assert.strictEqual(CONSOLIDATION_STRATEGIES.SCHEDULED, 'scheduled');
    });
  });

  describe('Attach Sources', () => {
    it('should attach dream engine', () => {
      const result = bridge.attachDreamEngine({ startDreaming: async () => null });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.dreamEngine, true);
    });

    it('should attach causal memory', () => {
      const result = bridge.attachCausalMemory({ store: async () => ({}) });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.causalMemory, true);
    });

    it('should attach brain memory', () => {
      const result = bridge.attachBrainMemory({ store: () => null });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.brainMemory, true);
    });

    it('should attach prefetcher', () => {
      const result = bridge.attachPrefetcher({ _prefetched: new Map() });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.prefetcher, true);
    });

    it('should attach causal bus', () => {
      const result = bridge.attachCausalBus({ getCausalChain: () => [] });
      assert.strictEqual(result, bridge);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.causalBus, true);
    });

    it('should ignore invalid attachments', () => {
      bridge.attachDreamEngine(null);
      bridge.attachCausalMemory('invalid');
      bridge.attachBrainMemory(123);
      const stats = bridge.getStats();
      assert.strictEqual(stats.attachedSources.dreamEngine, false);
      assert.strictEqual(stats.attachedSources.causalMemory, false);
      assert.strictEqual(stats.attachedSources.brainMemory, false);
    });
  });

  describe('Dream→Causal Feedback', () => {
    it('should apply dream notes to causal memory', async () => {
      const storedEntries = [];
      const mockCausalMemory = {
        store: async (entry) => {
          storedEntries.push(entry);
          return { id: 'cm-' + storedEntries.length, ...entry };
        },
      };
      bridge.attachCausalMemory(mockCausalMemory);

      const dreamResult = {
        dreamId: 'drm-1',
        notes: [
          { content: 'error: null pointer in auth module causes crash', confidence: 0.8, category: 'error-avoidance', tags: ['error'] },
          { content: 'should: use JWT for authentication', confidence: 0.9, category: 'best-practice', tags: ['best-practice'] },
        ],
      };

      const result = await bridge.onDreamCompleted(dreamResult);
      assert.ok(result.applied >= 1);
      assert.strictEqual(bridge.getStats().dreamToCausalCount, result.applied);
    });

    it('should skip low confidence notes', async () => {
      const mockCausalMemory = {
        store: async () => ({ id: 'cm-1' }),
      };
      bridge.attachCausalMemory(mockCausalMemory);

      const dreamResult = {
        dreamId: 'drm-2',
        notes: [
          { content: 'low confidence note', confidence: 0.1, category: 'general' },
        ],
      };

      const result = await bridge.onDreamCompleted(dreamResult);
      assert.strictEqual(result.skipped, 1);
      assert.strictEqual(result.applied, 0);
    });

    it('should handle empty dream result', async () => {
      const result = await bridge.onDreamCompleted(null);
      assert.strictEqual(result.applied, 0);
      assert.strictEqual(result.skipped, 0);
    });

    it('should handle dream result without notes', async () => {
      const result = await bridge.onDreamCompleted({ dreamId: 'drm-3' });
      assert.strictEqual(result.applied, 0);
    });
  });
});

describe('CausalMemoryBridge - Consolidation', () => {
  let bridge;

  beforeEach(() => {
    bridge = new CausalMemoryBridge();
  });

  describe('Causal→Memory Consolidation', () => {
    it('should consolidate causal entry to brain memory', async () => {
      const storedKeys = [];
      const mockBrainMemory = {
        store: (key, content, metadata) => {
          storedKeys.push(key);
          return { key, content, metadata };
        },
      };
      bridge.attachBrainMemory(mockBrainMemory);

      const result = await bridge.consolidateToMemory({
        id: 'cm-1',
        cause: 'auth failure',
        effect: 'session expired',
        confidence: 0.8,
        category: 'security',
        tags: ['auth'],
      });
      assert.strictEqual(result, true);
      assert.strictEqual(storedKeys.length, 1);
      assert.ok(storedKeys[0].startsWith('causal-'));
      assert.strictEqual(bridge.getStats().causalToMemoryCount, 1);
    });

    it('should return false without brain memory', async () => {
      const result = await bridge.consolidateToMemory({
        id: 'cm-1',
        cause: 'test',
        effect: 'result',
      });
      assert.strictEqual(result, false);
    });

    it('should return false for invalid entry', async () => {
      bridge.attachBrainMemory({ store: () => null });
      const result = await bridge.consolidateToMemory(null);
      assert.strictEqual(result, false);
    });
  });

  describe('Causal-Aware Prefetch', () => {
    it('should prefetch based on causal chain', async () => {
      const mockCausalMemory = {
        searchByCausalSimilarity: async (query, _opts) => {
          if (query.includes('auth')) {
            return [
              { id: 'cm-1', cause: 'auth failure', effect: 'session expired', confidence: 0.8 },
            ];
          }
          return [];
        },
      };
      const mockPrefetcher = { _prefetched: new Map() };
      bridge.attachCausalMemory(mockCausalMemory);
      bridge.attachPrefetcher(mockPrefetcher);

      const results = await bridge.prefetchByCausalChain('auth failure');
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].source, 'causal-chain');
      assert.strictEqual(bridge.getStats().causalPrefetches, results.length);
    });

    it('should return empty without causal memory', async () => {
      const results = await bridge.prefetchByCausalChain('test');
      assert.strictEqual(results.length, 0);
    });

    it('should return empty for invalid context', async () => {
      bridge.attachCausalMemory({ searchByCausalSimilarity: async () => [] });
      const results = await bridge.prefetchByCausalChain('');
      assert.strictEqual(results.length, 0);
    });

    it('should respect maxResults limit', async () => {
      const mockCausalMemory = {
        searchByCausalSimilarity: async () => [
          { id: 'cm-1', cause: 'a', effect: 'b', confidence: 0.8 },
          { id: 'cm-2', cause: 'c', effect: 'd', confidence: 0.7 },
          { id: 'cm-3', cause: 'e', effect: 'f', confidence: 0.6 },
        ],
      };
      bridge.attachCausalMemory(mockCausalMemory);

      const results = await bridge.prefetchByCausalChain('test', { maxResults: 2 });
      assert.ok(results.length <= 2);
    });
  });

  describe('Auto Consolidation', () => {
    it('should start auto consolidation', () => {
      bridge.startAutoConsolidation();
      const stats = bridge.getStats();
      assert.strictEqual(stats.autoConsolidationRunning, true);
    });

    it('should stop auto consolidation', () => {
      bridge.startAutoConsolidation();
      bridge.stopAutoConsolidation();
      const stats = bridge.getStats();
      assert.strictEqual(stats.autoConsolidationRunning, false);
    });

    it('should not start duplicate timers', () => {
      bridge.startAutoConsolidation();
      bridge.startAutoConsolidation();
      const stats = bridge.getStats();
      assert.strictEqual(stats.autoConsolidationRunning, true);
      bridge.stopAutoConsolidation();
    });
  });
});

describe('CausalMemoryBridge - History & Lifecycle', () => {
  let bridge;

  beforeEach(() => {
    bridge = new CausalMemoryBridge();
  });

  describe('Feedback History', () => {
    it('should record feedback history', async () => {
      const mockCausalMemory = {
        store: async () => ({ id: 'cm-1' }),
      };
      bridge.attachCausalMemory(mockCausalMemory);

      await bridge.onDreamCompleted({
        dreamId: 'drm-1',
        notes: [{ content: 'error: test error causes failure', confidence: 0.8, category: 'error-avoidance' }],
      });

      const history = bridge.getFeedbackHistory();
      assert.ok(history.length > 0);
      assert.strictEqual(history[0].type, FEEDBACK_TYPES.DREAM_TO_CAUSAL);
    });

    it('should filter feedback history by type', async () => {
      const mockBrainMemory = { store: () => null };
      bridge.attachBrainMemory(mockBrainMemory);

      await bridge.consolidateToMemory({
        id: 'cm-1', cause: 'test', effect: 'result', confidence: 0.8,
      });

      const history = bridge.getFeedbackHistory(FEEDBACK_TYPES.CAUSAL_TO_MEMORY);
      assert.ok(history.length > 0);
      assert.ok(history.every(h => h.type === FEEDBACK_TYPES.CAUSAL_TO_MEMORY));
    });
  });

  describe('Get Stats', () => {
    it('should return stats with default values', () => {
      const stats = bridge.getStats();
      assert.strictEqual(stats.feedbackApplied, 0);
      assert.strictEqual(stats.consolidationsCompleted, 0);
      assert.strictEqual(stats.causalPrefetches, 0);
      assert.strictEqual(stats.dreamToCausalCount, 0);
      assert.strictEqual(stats.causalToMemoryCount, 0);
      assert.strictEqual(stats.errors, 0);
      assert.strictEqual(stats.consolidationQueueSize, 0);
      assert.strictEqual(stats.autoConsolidationRunning, false);
    });
  });

  describe('Shutdown', () => {
    it('should prevent operations after shutdown', async () => {
      await bridge.shutdown();
      await assert.rejects(async () => {
        await bridge.onDreamCompleted({ notes: [] });
      }, /shut down/i);
    });

    it('should stop auto consolidation on shutdown', async () => {
      bridge.startAutoConsolidation();
      await bridge.shutdown();
      const stats = bridge.getStats();
      assert.strictEqual(stats.autoConsolidationRunning, false);
    });

    it('should clear consolidation queue', async () => {
      bridge._consolidationQueue.push({ id: 'test' });
      await bridge.shutdown();
      const stats = bridge.getStats();
      assert.strictEqual(stats.consolidationQueueSize, 0);
    });
  });
});
