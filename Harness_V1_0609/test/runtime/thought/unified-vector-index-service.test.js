'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const UnifiedVectorIndexModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'unified-vector-index-service'));
const UnifiedVectorIndexService = UnifiedVectorIndexModule.UnifiedVectorIndexService || UnifiedVectorIndexModule;
const { VECTOR_NAMESPACES } = UnifiedVectorIndexModule;

describe('UnifiedVectorIndexService - Core', () => {
  let service;

  beforeEach(() => {
    service = new UnifiedVectorIndexService();
  });

  describe('Static Constants', () => {
    it('should export VECTOR_NAMESPACES', () => {
      assert.strictEqual(VECTOR_NAMESPACES.CAUSAL, 'causal');
      assert.strictEqual(VECTOR_NAMESPACES.SEMANTIC, 'semantic');
      assert.strictEqual(VECTOR_NAMESPACES.ENTITY, 'entity');
      assert.strictEqual(VECTOR_NAMESPACES.MEMORY, 'memory');
      assert.strictEqual(VECTOR_NAMESPACES.THOUGHT, 'thought');
    });
  });

  describe('Attach Embedding Service', () => {
    it('should attach embedding service', () => {
      const result = service.attachEmbeddingService({ embed: async () => [0.1, 0.2] });
      assert.strictEqual(result, service);
      const stats = service.getStats();
      assert.strictEqual(stats.embeddingServiceAvailable, true);
    });

    it('should ignore invalid embedding service', () => {
      service.attachEmbeddingService(null);
      service.attachEmbeddingService({ noEmbed: true });
      const stats = service.getStats();
      assert.strictEqual(stats.embeddingServiceAvailable, false);
    });
  });

  describe('Index', () => {
    it('should index text to a namespace', async () => {
      const result = await service.index('causal', 'id-1', 'authentication failure');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.id, 'id-1');
      assert.strictEqual(result.namespace, 'causal');
    });

    it('should reject invalid namespace', async () => {
      const result = await service.index('', 'id-1', 'text');
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    it('should reject invalid id', async () => {
      const result = await service.index('causal', '', 'text');
      assert.strictEqual(result.success, false);
    });

    it('should reject invalid text', async () => {
      const result = await service.index('causal', 'id-1', '');
      assert.strictEqual(result.success, false);
    });

    it('should index with metadata', async () => {
      const result = await service.index('semantic', 'id-2', 'JWT token', { category: 'auth' });
      assert.strictEqual(result.success, true);
      const entry = service.get('semantic', 'id-2');
      assert.strictEqual(entry.metadata.category, 'auth');
    });

    it('should update existing entry', async () => {
      await service.index('causal', 'id-1', 'old text');
      await service.index('causal', 'id-1', 'new text');
      const entry = service.get('causal', 'id-1');
      assert.strictEqual(entry.text, 'new text');
    });

    it('should evict oldest when capacity exceeded', async () => {
      const small = new UnifiedVectorIndexService({ maxVectorsPerNamespace: 2 });
      await small.index('causal', 'id-1', 'first');
      await small.index('causal', 'id-2', 'second');
      await small.index('causal', 'id-3', 'third');
      const entry1 = small.get('causal', 'id-1');
      assert.strictEqual(entry1, null);
      const entry3 = small.get('causal', 'id-3');
      assert.ok(entry3);
      await small.shutdown();
    });
  });

  describe('Batch Index', () => {
    it('should batch index multiple items', async () => {
      const result = await service.batchIndex('causal', [
        { id: 'b1', text: 'first item' },
        { id: 'b2', text: 'second item' },
        { id: 'b3', text: 'third item' },
      ]);
      assert.strictEqual(result.successCount, 3);
      assert.strictEqual(result.failCount, 0);
    });

    it('should handle partial failures in batch', async () => {
      const result = await service.batchIndex('causal', [
        { id: 'b1', text: 'valid' },
        { id: '', text: 'invalid id' },
      ]);
      assert.strictEqual(result.successCount, 1);
      assert.strictEqual(result.failCount, 1);
    });

    it('should reject non-array items', async () => {
      const result = await service.batchIndex('causal', 'not-array');
      assert.strictEqual(result.successCount, 0);
    });
  });
});

describe('UnifiedVectorIndexService - Search & Lifecycle', () => {
  let service;

  beforeEach(() => {
    service = new UnifiedVectorIndexService();
  });

  describe('Search', () => {
    it('should search within a namespace', async () => {
      await service.index('causal', 'id-1', 'authentication failure causes session loss');
      await service.index('causal', 'id-2', 'database connection timeout');
      await service.index('causal', 'id-3', 'authentication error in login');

      const results = await service.search('authentication', {
        namespaces: ['causal'],
        threshold: 0.01,
      });
      assert.ok(results.length > 0);
    });

    it('should search across namespaces', async () => {
      await service.index('causal', 'c-1', 'auth failure');
      await service.index('semantic', 's-1', 'auth mechanism');

      const results = await service.search('auth', {
        namespaces: ['causal', 'semantic'],
        threshold: 0.01,
      });
      assert.ok(results.length >= 2);
      const namespaces = results.map(r => r.namespace);
      assert.ok(namespaces.includes('causal'));
      assert.ok(namespaces.includes('semantic'));
    });

    it('should return empty for empty query', async () => {
      const results = await service.search('');
      assert.strictEqual(results.length, 0);
    });

    it('should respect topK limit', async () => {
      for (let i = 0; i < 5; i++) {
        await service.index('causal', 'id-' + i, 'test item ' + i);
      }
      const results = await service.search('test', {
        namespaces: ['causal'],
        topK: 2,
        threshold: 0.01,
      });
      assert.ok(results.length <= 2);
    });

    it('should use cache for repeated queries', async () => {
      await service.index('causal', 'id-1', 'cache test');
      await service.search('cache', { namespaces: ['causal'], threshold: 0.01 });
      await service.search('cache', { namespaces: ['causal'], threshold: 0.01 });
      const stats = service.getStats();
      assert.strictEqual(stats.cacheHits, 1);
    });

    it('should search all namespaces when none specified', async () => {
      await service.index('causal', 'c-1', 'test causal');
      await service.index('semantic', 's-1', 'test semantic');

      const results = await service.search('test', { threshold: 0.01 });
      assert.ok(results.length >= 2);
    });
  });

  describe('Remove', () => {
    it('should remove an entry', async () => {
      await service.index('causal', 'id-1', 'to remove');
      const removed = service.remove('causal', 'id-1');
      assert.strictEqual(removed, true);
      const entry = service.get('causal', 'id-1');
      assert.strictEqual(entry, null);
    });

    it('should return false for non-existent entry', () => {
      const removed = service.remove('causal', 'non-existent');
      assert.strictEqual(removed, false);
    });
  });

  describe('Get', () => {
    it('should get an entry', async () => {
      await service.index('causal', 'id-1', 'test', { key: 'value' });
      const entry = service.get('causal', 'id-1');
      assert.strictEqual(entry.id, 'id-1');
      assert.strictEqual(entry.text, 'test');
      assert.strictEqual(entry.metadata.key, 'value');
    });

    it('should return null for non-existent entry', () => {
      const entry = service.get('causal', 'non-existent');
      assert.strictEqual(entry, null);
    });

    it('should return null for non-existent namespace', () => {
      const entry = service.get('nonexistent', 'id-1');
      assert.strictEqual(entry, null);
    });
  });

  describe('Get Stats', () => {
    it('should return stats', async () => {
      await service.index('causal', 'id-1', 'test');
      const stats = service.getStats();
      assert.strictEqual(stats.totalIndexed, 1);
      assert.strictEqual(stats.totalNamespaces, 1);
      assert.strictEqual(stats.embeddingServiceAvailable, false);
      assert.ok(stats.namespaceCounts);
    });
  });

  describe('Shutdown', () => {
    it('should prevent operations after shutdown', async () => {
      await service.shutdown();
      await assert.rejects(async () => {
        await service.index('causal', 'id-1', 'test');
      }, /shut down/i);
    });

    it('should return null for get after shutdown', async () => {
      await service.index('causal', 'id-1', 'test');
      await service.shutdown();
      const entry = service.get('causal', 'id-1');
      assert.strictEqual(entry, null);
    });

    it('should throw for search after shutdown', async () => {
      await service.shutdown();
      await assert.rejects(async () => {
        await service.search('test');
      }, /shut down/i);
    });
  });
});
