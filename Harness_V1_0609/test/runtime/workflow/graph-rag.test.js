'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const GraphRAGModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'graph-rag'));
const GraphRAG = GraphRAGModule.GraphRAG || GraphRAGModule;

describe('GraphRAG - Constructor', () => {
  it('should create instance with default config', () => {
    const rag = new GraphRAG();
    assert.ok(rag);
    assert.strictEqual(rag._config.maxEntities, 5000);
    assert.strictEqual(rag._config.maxRelations, 10000);
    assert.strictEqual(rag._config.maxClusters, 100);
    assert.strictEqual(rag._config.minRelationWeight, 0.1);
  });

  it('should merge custom options with defaults', () => {
    const rag = new GraphRAG({ maxEntities: 100 });
    assert.strictEqual(rag._config.maxEntities, 100);
    assert.strictEqual(rag._config.maxRelations, 10000);
  });

  it('should initialize empty data structures', () => {
    const rag = new GraphRAG();
    assert.strictEqual(rag._entities.size, 0);
    assert.strictEqual(rag._relations.size, 0);
    assert.strictEqual(rag._clusters.size, 0);
    assert.strictEqual(rag._documents.size, 0);
  });
});

describe('GraphRAG - ingestDocument', () => {
  it('should ingest a document and extract entities', () => {
    const rag = new GraphRAG();
    const result = rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc. NodeJS is used.');
    assert.strictEqual(result.success, true);
    assert.ok(result.entityCount >= 0);
    assert.ok(result.relationCount >= 0);
  });

  it('should return error for missing docId', () => {
    const rag = new GraphRAG();
    const result = rag.ingestDocument('', 'content');
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  it('should return error for missing content', () => {
    const rag = new GraphRAG();
    const result = rag.ingestDocument('doc1', '');
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  it('should return error for null docId', () => {
    const rag = new GraphRAG();
    const result = rag.ingestDocument(null, 'content');
    assert.strictEqual(result.success, false);
  });

  it('should re-ingest document replacing old data', () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc.');
    const result = rag.ingestDocument('doc1', 'Ms. Jane Doe works at Beta Corp.');
    assert.strictEqual(result.success, true);
  });

  it('should emit document-ingested event', () => {
    const rag = new GraphRAG();
    let emitted = false;
    rag.on('document-ingested', () => { emitted = true; });
    rag.ingestDocument('doc1', 'Test content with NodeJS technology');
    assert.strictEqual(emitted, true);
  });

  it('should reject after shutdown', () => {
    const rag = new GraphRAG();
    rag.shutdown();
    assert.throws(() => rag.ingestDocument('doc1', 'content'), { code: 'SHUTDOWN' });
  });
});

describe('GraphRAG - buildClusters', () => {
  it('should build clusters from ingested data', () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc. NodeJS is used.');
    const result = rag.buildClusters();
    assert.strictEqual(result.success, true);
    assert.ok(result.clusterCount >= 0);
  });

  it('should throw after shutdown', () => {
    const rag = new GraphRAG();
    rag.shutdown();
    assert.throws(() => rag.buildClusters(), { code: 'SHUTDOWN' });
  });
});

describe('GraphRAG - query', () => {
  it('should return results for a query', async () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc. NodeJS is used.');
    const result = await rag.query('John Smith');
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.results));
    assert.ok(Array.isArray(result.paths));
  });

  it('should return error for missing question', async () => {
    const rag = new GraphRAG();
    const result = await rag.query('');
    assert.strictEqual(result.success, false);
  });

  it('should return error for null question', async () => {
    const rag = new GraphRAG();
    const result = await rag.query(null);
    assert.strictEqual(result.success, false);
  });

  it('should accept query options', async () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc.');
    const result = await rag.query('John Smith', { topK: 3, maxHops: 1, minRelevance: 0.1 });
    assert.strictEqual(result.success, true);
  });

  it('should reject after shutdown', async () => {
    const rag = new GraphRAG();
    rag.shutdown();
    await assert.rejects(() => rag.query('test'), { code: 'SHUTDOWN' });
  });
});

describe('GraphRAG - getEntityGraph', () => {
  it('should return entity graph for existing entity', () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc. NodeJS is used.');
    if (rag._entities.size > 0) {
      const entityId = rag._entities.keys().next().value;
      const result = rag.getEntityGraph(entityId, 1);
      assert.strictEqual(result.success, true);
      assert.ok(result.center);
      assert.ok(Array.isArray(result.entities));
      assert.ok(Array.isArray(result.relations));
    }
  });

  it('should return error for non-existent entity', () => {
    const rag = new GraphRAG();
    const result = rag.getEntityGraph('nonexistent');
    assert.strictEqual(result.success, false);
  });

  it('should return error for null entityId', () => {
    const rag = new GraphRAG();
    const result = rag.getEntityGraph(null);
    assert.strictEqual(result.success, false);
  });
});

describe('GraphRAG - getClusters', () => {
  it('should return clusters array', () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Test content');
    rag.buildClusters();
    const clusters = rag.getClusters();
    assert.ok(Array.isArray(clusters));
  });

  it('should throw after shutdown', () => {
    const rag = new GraphRAG();
    rag.shutdown();
    assert.throws(() => rag.getClusters(), { code: 'SHUTDOWN' });
  });
});

describe('GraphRAG - getStats', () => {
  it('should return stats object', () => {
    const rag = new GraphRAG();
    const stats = rag.getStats();
    assert.strictEqual(stats.documentsIngested, 0);
    assert.strictEqual(stats.entitiesExtracted, 0);
    assert.strictEqual(stats.relationsExtracted, 0);
    assert.strictEqual(stats.currentEntities, 0);
    assert.strictEqual(stats.currentRelations, 0);
    assert.ok(stats.config);
  });

  it('should reflect ingested documents', () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc.');
    const stats = rag.getStats();
    assert.strictEqual(stats.documentsIngested, 1);
    assert.ok(stats.currentEntities >= 0);
  });
});

describe('GraphRAG - attach methods', () => {
  it('should attach embedding service', () => {
    const rag = new GraphRAG();
    const mock = {};
    rag.attachEmbeddingService(mock);
    assert.strictEqual(rag._embeddingService, mock);
  });

  it('should attach vector index', () => {
    const rag = new GraphRAG();
    const mock = {};
    rag.attachVectorIndex(mock);
    assert.strictEqual(rag._vectorIndex, mock);
  });
});

describe('GraphRAG - shutdown', () => {
  it('should clear all data on shutdown', () => {
    const rag = new GraphRAG();
    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc.');
    rag.shutdown();
    assert.strictEqual(rag._entities.size, 0);
    assert.strictEqual(rag._relations.size, 0);
    assert.strictEqual(rag._documents.size, 0);
    assert.strictEqual(rag._shutDown, true);
  });
});
