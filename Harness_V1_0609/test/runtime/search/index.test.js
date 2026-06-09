'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const { SirchnunkMcpAdapter, SEARCH_MODES } = require(path.join(ROOT, 'src', 'runtime', 'search', 'sirchnunk-mcp-adapter'));
const { KnowledgeClusterStore, CLUSTER_CATEGORIES } = require(path.join(ROOT, 'src', 'runtime', 'search', 'knowledge-cluster-store'));
const { EvolvingSearchEngine, SEARCH_PHASES } = require(path.join(ROOT, 'src', 'runtime', 'search', 'evolving-search-engine'));
const searchIndex = require(path.join(ROOT, 'src', 'runtime', 'search', 'index'));

function createMockMcpClient(responses) {
  const calls = [];
  const resp = responses || {
    result: {
      content: 'test answer',
      clusterId: 'cluster-1',
      confidence: 0.85,
      evidenceUnits: [{ content: 'evidence 1' }, { content: 'evidence 2' }],
      tokensUsed: 100,
    },
  };
  return {
    calls,
    callTool: async (fullName, args) => {
      calls.push({ fullName, args });
      return resp;
    },
  };
}

// ========== SirchnunkMcpAdapter - 构造与基础 ==========

describe('SirchnunkMcpAdapter constructor', () => {
  it('should create instance with default config', () => {
    const adapter = new SirchnunkMcpAdapter();
    assert.equal(adapter._config.mcpServerName, 'sirchnunk');
    assert.equal(adapter._config.defaultMode, SEARCH_MODES.FAST);
    assert.equal(adapter._config.defaultTopK, 20);
  });

  it('should create instance with custom config', () => {
    const adapter = new SirchnunkMcpAdapter({ mcpServerName: 'custom', defaultMode: SEARCH_MODES.DEEP });
    assert.equal(adapter._config.mcpServerName, 'custom');
    assert.equal(adapter._config.defaultMode, SEARCH_MODES.DEEP);
  });

  it('should throw on search without MCPClient', async () => {
    const adapter = new SirchnunkMcpAdapter();
    await assert.rejects(() => adapter.search('test'), { message: /MCPClient not attached/ });
  });

  it('should throw on search with empty query', async () => {
    const adapter = new SirchnunkMcpAdapter();
    await assert.rejects(() => adapter.search(''), { message: /query is required/ });
  });

  it('should throw on search with non-string query', async () => {
    const adapter = new SirchnunkMcpAdapter();
    await assert.rejects(() => adapter.search(123), { message: /query is required/ });
  });

  it('should attach MCPClient via attachMcpClient', () => {
    const adapter = new SirchnunkMcpAdapter();
    const mock = createMockMcpClient();
    adapter.attachMcpClient(mock);
    assert.equal(adapter._mcpClient, mock);
  });
});

// ========== SirchnunkMcpAdapter - 搜索与缓存 ==========

describe('SirchnunkMcpAdapter search and cache', () => {
  it('should execute search via MCPClient', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    const result = await adapter.search('test query');
    assert.equal(result.query, 'test query');
    assert.equal(result.mode, SEARCH_MODES.FAST);
    assert.equal(result.answer, 'test answer');
    assert.equal(result.clusterId, 'cluster-1');
    assert.equal(result.confidence, 0.85);
    assert.equal(result.tokensUsed, 100);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].fullName, 'mcp_sirchnunk_search');
  });

  it('should use correct tool full name with custom server name', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock, mcpServerName: 'my-search' });
    await adapter.search('test');
    assert.equal(mock.calls[0].fullName, 'mcp_my-search_search');
  });

  it('should cache search results', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    const r1 = await adapter.search('cache test');
    const r2 = await adapter.search('cache test');
    assert.equal(mock.calls.length, 1);
    assert.equal(r1.timestamp, r2.timestamp);
  });

  it('should not cache different queries', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await adapter.search('query a');
    await adapter.search('query b');
    assert.equal(mock.calls.length, 2);
  });

  it('should track stats correctly', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await adapter.search('test1');
    await adapter.search('test2');
    await adapter.search('test1');
    const stats = adapter.getStats();
    assert.equal(stats.totalSearches, 2);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.byMode[SEARCH_MODES.FAST], 2);
    assert.equal(stats.totalTokensUsed, 200);
    assert.equal(stats.connected, true);
  });

  it('should track errors in stats', async () => {
    const mock = { callTool: async () => { throw new Error('connection failed'); } };
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await assert.rejects(() => adapter.search('fail'), { message: /connection failed/ });
    assert.equal(adapter.getStats().errors, 1);
  });

  it('should pass search options to MCPClient', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await adapter.search('opts', {
      mode: SEARCH_MODES.DEEP, paths: ['/src'], topK: 5,
      maxDepth: 3, maxLoops: 2, includePatterns: ['*.js'], excludePatterns: ['*.test.js'],
    });
    const args = mock.calls[0].args;
    assert.equal(args.mode, SEARCH_MODES.DEEP);
    assert.deepEqual(args.paths, ['/src']);
    assert.equal(args.top_k_files, 5);
    assert.equal(args.max_depth, 3);
    assert.equal(args.max_loops, 2);
    assert.deepEqual(args.include_patterns, ['*.js']);
    assert.deepEqual(args.exclude_patterns, ['*.test.js']);
  });
});

// ========== SirchnunkMcpAdapter - 事件与生命周期 ==========

describe('SirchnunkMcpAdapter events and lifecycle', () => {
  it('should emit search-complete event', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    let emitted = null;
    adapter.on('search-complete', (r) => { emitted = r; });
    await adapter.search('event test');
    assert.ok(emitted);
    assert.equal(emitted.query, 'event test');
  });

  it('should emit search-error event on failure', async () => {
    const mock = { callTool: async () => { throw new Error('fail'); } };
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    let emitted = null;
    adapter.on('search-error', (r) => { emitted = r; });
    await assert.rejects(() => adapter.search('fail'));
    assert.ok(emitted);
    assert.equal(emitted.query, 'fail');
  });

  it('should return search history', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await adapter.search('history1');
    await adapter.search('history2');
    const history = adapter.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].query, 'history1');
  });

  it('should limit search history', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await adapter.search('h1');
    await adapter.search('h2');
    await adapter.search('h3');
    assert.equal(adapter.getHistory(2).length, 2);
  });

  it('should clear cache', async () => {
    const mock = createMockMcpClient();
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    await adapter.search('clear test');
    adapter.clearCache();
    await adapter.search('clear test');
    assert.equal(mock.calls.length, 2);
  });

  it('should handle shutdown', () => {
    const adapter = new SirchnunkMcpAdapter();
    adapter.shutdown();
    assert.equal(adapter._mcpClient, null);
    assert.deepEqual(adapter.getStats(), {});
    assert.deepEqual(adapter.getHistory(), []);
  });

  it('should throw after shutdown on search', async () => {
    const adapter = new SirchnunkMcpAdapter();
    adapter.shutdown();
    await assert.rejects(() => adapter.search('test'));
  });

  it('should throw after shutdown on attachMcpClient', () => {
    const adapter = new SirchnunkMcpAdapter();
    adapter.shutdown();
    assert.throws(() => adapter.attachMcpClient({}));
  });

  it('should throw after shutdown on clearCache', () => {
    const adapter = new SirchnunkMcpAdapter();
    adapter.shutdown();
    assert.throws(() => adapter.clearCache());
  });

  it('should handle result with nested result field', async () => {
    const mock = {
      calls: [],
      callTool: async () => ({ result: { content: 'nested answer', confidence: 0.9, tokensUsed: 50 } }),
    };
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    const result = await adapter.search('nested');
    assert.equal(result.answer, 'nested answer');
    assert.equal(result.confidence, 0.9);
  });

  it('should handle result without optional fields', async () => {
    const mock = { calls: [], callTool: async () => ({ result: {} }) };
    const adapter = new SirchnunkMcpAdapter({ mcpClient: mock });
    const result = await adapter.search('minimal');
    assert.equal(result.answer, '');
    assert.equal(result.clusterId, null);
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.evidenceUnits, []);
    assert.equal(result.tokensUsed, 0);
  });
});

// ========== KnowledgeClusterStore ==========

describe('KnowledgeClusterStore', () => {
  it('should create instance with default config', () => {
    const store = new KnowledgeClusterStore();
    assert.equal(store._config.maxClusters, 500);
    assert.equal(store._config.similarityThreshold, 0.75);
  });

  it('should create cluster with all fields', () => {
    const store = new KnowledgeClusterStore();
    const cluster = store.createCluster({
      name: 'Test Cluster', category: CLUSTER_CATEGORIES.TOPIC,
      description: 'A test cluster',
      evidence: [{ content: 'ev1', source: 'test', confidence: 0.8, addedAt: Date.now() }],
      keywords: ['test', 'cluster'], confidence: 0.9, sourceQueries: ['test query'],
    });
    assert.ok(cluster.id);
    assert.equal(cluster.name, 'Test Cluster');
    assert.equal(cluster.category, CLUSTER_CATEGORIES.TOPIC);
    assert.equal(cluster.evidence.length, 1);
    assert.equal(cluster.keywords.length, 2);
    assert.equal(cluster.confidence, 0.9);
  });

  it('should create cluster with defaults', () => {
    const cluster = new KnowledgeClusterStore().createCluster({});
    assert.ok(cluster.id);
    assert.equal(cluster.name, 'Unnamed Cluster');
    assert.equal(cluster.category, CLUSTER_CATEGORIES.TOPIC);
  });

  it('should emit cluster-created event', () => {
    const store = new KnowledgeClusterStore();
    let emitted = null;
    store.on('cluster-created', (c) => { emitted = c; });
    store.createCluster({ name: 'Event Test' });
    assert.ok(emitted);
    assert.equal(emitted.name, 'Event Test');
  });

  it('should find matching cluster by keywords', () => {
    const store = new KnowledgeClusterStore();
    store.createCluster({ name: 'JavaScript Testing', keywords: ['javascript', 'testing', 'unit'], confidence: 0.9 });
    const result = store.findMatchingCluster('javascript testing');
    assert.ok(result);
    assert.ok(result.score >= 0.75);
    assert.equal(result.cluster.name, 'JavaScript Testing');
  });

  it('should not find match below threshold', () => {
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.9 });
    store.createCluster({ name: 'Python ML', keywords: ['python', 'machine', 'learning'] });
    assert.equal(store.findMatchingCluster('javascript testing'), null);
  });

  it('should find match by category', () => {
    const store = new KnowledgeClusterStore();
    store.createCluster({ name: 'Decision A', category: CLUSTER_CATEGORIES.DECISION, keywords: ['decision'] });
    store.createCluster({ name: 'Topic A', category: CLUSTER_CATEGORIES.TOPIC, keywords: ['decision'] });
    const result = store.findMatchingCluster('decision', CLUSTER_CATEGORIES.DECISION);
    assert.ok(result);
    assert.equal(result.cluster.category, CLUSTER_CATEGORIES.DECISION);
  });

  it('should increment access count on reuse', () => {
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    const cluster = store.createCluster({ name: 'Reuse Test', keywords: ['reuse'] });
    assert.equal(cluster.accessCount, 0);
    store.findMatchingCluster('reuse');
    assert.equal(cluster.accessCount, 1);
  });

  it('should emit cluster-reused event', () => {
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    store.createCluster({ name: 'Reuse Event', keywords: ['reuse'] });
    let emitted = null;
    store.on('cluster-reused', (r) => { emitted = r; });
    store.findMatchingCluster('reuse');
    assert.ok(emitted);
  });

  it('should add evidence to cluster', () => {
    const store = new KnowledgeClusterStore();
    const cluster = store.createCluster({ name: 'Evidence Test' });
    const updated = store.addEvidence(cluster.id, { content: 'new evidence', source: 'test', confidence: 0.7 });
    assert.ok(updated);
    assert.equal(updated.evidence.length, 1);
    assert.equal(updated.evidence[0].content, 'new evidence');
  });

  it('should return null when adding evidence to non-existent cluster', () => {
    assert.equal(new KnowledgeClusterStore().addEvidence('non-existent', { content: 'test' }), null);
  });

  it('should evict oldest evidence when exceeding max', () => {
    const store = new KnowledgeClusterStore({ maxEvidencePerCluster: 3 });
    const cluster = store.createCluster({ name: 'Evict Test' });
    for (let i = 0; i < 5; i++) store.addEvidence(cluster.id, { content: 'ev-' + i });
    assert.equal(store.getCluster(cluster.id).evidence.length, 3);
    assert.equal(store.getCluster(cluster.id).evidence[0].content, 'ev-2');
  });

  it('should emit evidence-added event', () => {
    const store = new KnowledgeClusterStore();
    const cluster = store.createCluster({ name: 'Ev' });
    let emitted = null;
    store.on('evidence-added', (r) => { emitted = r; });
    store.addEvidence(cluster.id, { content: 'test' });
    assert.ok(emitted);
    assert.equal(emitted.clusterId, cluster.id);
  });

  it('should merge clusters', () => {
    const store = new KnowledgeClusterStore();
    const c1 = store.createCluster({ name: 'Source', keywords: ['a'], evidence: [{ content: 'e1' }], confidence: 0.7 });
    const c2 = store.createCluster({ name: 'Target', keywords: ['b'], evidence: [{ content: 'e2' }], confidence: 0.8 });
    assert.equal(store.mergeClusters(c1.id, c2.id), true);
    const merged = store.getCluster(c2.id);
    assert.equal(merged.keywords.length, 2);
    assert.equal(merged.evidence.length, 2);
    assert.equal(merged.confidence, 0.8);
    assert.equal(store.getCluster(c1.id), null);
  });

  it('should return false when merging non-existent clusters', () => {
    assert.equal(new KnowledgeClusterStore().mergeClusters('a', 'b'), false);
  });

  it('should emit clusters-merged event', () => {
    const store = new KnowledgeClusterStore();
    const c1 = store.createCluster({ name: 'S', keywords: ['a'] });
    const c2 = store.createCluster({ name: 'T', keywords: ['b'] });
    let emitted = null;
    store.on('clusters-merged', (r) => { emitted = r; });
    store.mergeClusters(c1.id, c2.id);
    assert.ok(emitted);
    assert.equal(emitted.sourceId, c1.id);
  });

  it('should get all clusters and by category', () => {
    const store = new KnowledgeClusterStore();
    store.createCluster({ name: 'C1' });
    store.createCluster({ name: 'P', category: CLUSTER_CATEGORIES.PERSON });
    assert.equal(store.getAllClusters().length, 2);
    assert.equal(store.getAllClusters(CLUSTER_CATEGORIES.PERSON).length, 1);
  });

  it('should track stats', () => {
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    store.createCluster({ name: 'S1', keywords: ['test'] });
    store.findMatchingCluster('test');
    const stats = store.getStats();
    assert.equal(stats.totalClusters, 1);
    assert.equal(stats.totalReuses, 1);
  });

  it('should handle shutdown', () => {
    const store = new KnowledgeClusterStore();
    store.createCluster({ name: 'Before Shutdown' });
    store.shutdown();
    assert.deepEqual(store.getStats(), {});
    assert.equal(store.getAllClusters().length, 0);
  });

  it('should throw after shutdown on createCluster', () => {
    const store = new KnowledgeClusterStore();
    store.shutdown();
    assert.throws(() => store.createCluster({}));
  });
});

// ========== EvolvingSearchEngine - 基础搜索 ==========

describe('EvolvingSearchEngine basic search', () => {
  it('should create instance with default config', () => {
    const engine = new EvolvingSearchEngine();
    assert.equal(engine._config.defaultMode, SEARCH_MODES.FAST);
    assert.equal(engine._config.enableClusterReuse, true);
    assert.equal(engine._config.enableIdfRanking, true);
  });

  it('should create with custom config', () => {
    const engine = new EvolvingSearchEngine({ defaultMode: SEARCH_MODES.DEEP, enableReactiveRefine: true });
    assert.equal(engine._config.defaultMode, SEARCH_MODES.DEEP);
    assert.equal(engine._config.enableReactiveRefine, true);
  });

  it('should execute search and return sirchnunk result', async () => {
    const mockAdapter = {
      search: async (query, opts) => ({
        query, mode: opts.mode, answer: 'found answer', clusterId: null,
        confidence: 0.85, evidenceUnits: [{ content: 'ev1' }], tokensUsed: 50, timestamp: Date.now(),
      }),
      getStats: () => ({ totalSearches: 1 }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false });
    const result = await engine.search('test query');
    assert.equal(result.answer, 'found answer');
    assert.equal(result.source, 'sirchnunk');
    assert.equal(result.confidence, 0.85);
  });

  it('should throw when both sirchnunk and cluster fail', async () => {
    const mockAdapter = { search: async () => { throw new Error('fail'); } };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false });
    await assert.rejects(() => engine.search('fail test'), { message: /fail/ });
  });

  it('should apply IDF ranking to evidence units', async () => {
    const mockAdapter = {
      search: async () => ({
        answer: 'ranked', confidence: 0.8,
        evidenceUnits: [{ content: 'javascript testing' }, { content: 'python data' }],
        tokensUsed: 10, timestamp: Date.now(),
      }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, enableIdfRanking: true, minConfidenceForAnswer: 0.7 });
    const result = await engine.search('javascript testing');
    assert.ok(result.evidenceUnits[0].idfScore !== undefined);
  });

  it('should skip IDF ranking when disabled', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'no idf', confidence: 0.8, evidenceUnits: [{ content: 'test' }], tokensUsed: 10, timestamp: Date.now() }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, enableIdfRanking: false, minConfidenceForAnswer: 0.7 });
    const result = await engine.search('no idf');
    assert.equal(result.evidenceUnits[0].idfScore, undefined);
  });
});

// ========== EvolvingSearchEngine - 集群复用与回退 ==========

describe('EvolvingSearchEngine cluster reuse and fallback', () => {
  it('should reuse cluster when confidence is high enough', async () => {
    const mockAdapter = { search: async () => ({ answer: 'from sirchnunk', confidence: 0.5 }) };
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    store.createCluster({
      name: 'test query', keywords: ['test', 'query'], confidence: 0.9,
      evidence: [{ content: 'cached answer', confidence: 0.9, addedAt: Date.now() }],
    });
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, knowledgeClusterStore: store, minConfidenceForAnswer: 0.7 });
    const result = await engine.search('test query');
    assert.equal(result.source, 'cluster_reuse');
    assert.ok(result.confidence >= 0.7);
    assert.ok(result.phases.includes(SEARCH_PHASES.CLUSTER_REUSE));
  });

  it('should fallback to cluster when sirchnunk fails', async () => {
    const mockAdapter = { search: async () => { throw new Error('unavailable'); } };
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.3 });
    store.createCluster({
      name: 'fallback partial', keywords: ['fallback'], confidence: 0.8,
      evidence: [{ content: 'fallback answer', confidence: 0.8, addedAt: Date.now() }],
    });
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, knowledgeClusterStore: store, minConfidenceForAnswer: 0.95 });
    const result = await engine.search('fallback query extra');
    assert.equal(result.source, 'cluster_fallback');
    assert.ok(result.phases.includes('fallback'));
  });

  it('should build cluster from high-confidence result', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'good answer', confidence: 0.9, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
    };
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.99 });
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, knowledgeClusterStore: store, enableClusterReuse: false, minConfidenceForAnswer: 0.7 });
    await engine.search('build cluster test');
    const clusters = store.getAllClusters();
    assert.ok(clusters.length >= 1);
    assert.ok(clusters.some(c => c.name.includes('build cluster')));
  });

  it('should update existing cluster on repeated search', async () => {
    const mockAdapter = {
      search: async (q) => ({ answer: 'answer for ' + q, confidence: 0.9, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
    };
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, knowledgeClusterStore: store, enableClusterReuse: false, minConfidenceForAnswer: 0.7 });
    await engine.search('update test');
    const firstCount = store.getAllClusters().length;
    await engine.search('update test');
    assert.equal(store.getAllClusters().length, firstCount);
  });
});

// ========== EvolvingSearchEngine - 事件与统计 ==========

describe('EvolvingSearchEngine events and stats', () => {
  it('should track phase stats', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'phase', confidence: 0.8, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, minConfidenceForAnswer: 0.7 });
    await engine.search('phase test');
    const stats = engine.getStats();
    assert.ok(stats.totalSearches >= 1);
    assert.ok(stats.phaseStats);
  });

  it('should emit search-phase events', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'event', confidence: 0.8, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: true, minConfidenceForAnswer: 0.7 });
    const phases = [];
    engine.on('search-phase', (p) => { phases.push(p); });
    await engine.search('event test');
    assert.ok(phases.length >= 1);
    assert.ok(phases.some(p => p.phase === SEARCH_PHASES.CLUSTER_REUSE));
  });

  it('should emit search-complete event', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'complete', confidence: 0.8, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, minConfidenceForAnswer: 0.7 });
    let emitted = null;
    engine.on('search-complete', (r) => { emitted = r; });
    await engine.search('complete test');
    assert.ok(emitted);
    assert.equal(emitted.query, 'complete test');
  });

  it('should aggregate stats from sub-components', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'stats', confidence: 0.8, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
      getStats: () => ({ totalSearches: 1 }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false });
    await engine.search('stats test');
    const stats = engine.getStats();
    assert.ok(stats.sirchnunkStats);
    assert.ok(stats.clusterStoreStats);
  });

  it('should handle shutdown', () => {
    const engine = new EvolvingSearchEngine();
    engine.shutdown();
    assert.deepEqual(engine.getStats(), {});
  });

  it('should throw after shutdown on search', async () => {
    const engine = new EvolvingSearchEngine();
    engine.shutdown();
    await assert.rejects(() => engine.search('test'));
  });
});

// ========== Index module ==========

describe('search/index module', () => {
  it('should export all components', () => {
    assert.ok(searchIndex.SirchnunkMcpAdapter);
    assert.ok(searchIndex.SEARCH_MODES);
    assert.ok(searchIndex.KnowledgeClusterStore);
    assert.ok(searchIndex.CLUSTER_CATEGORIES);
    assert.ok(searchIndex.EvolvingSearchEngine);
    assert.ok(searchIndex.SEARCH_PHASES);
  });

  it('should have correct SEARCH_MODES', () => {
    assert.equal(SEARCH_MODES.FILENAME_ONLY, 'FILENAME_ONLY');
    assert.equal(SEARCH_MODES.FAST, 'FAST');
    assert.equal(SEARCH_MODES.DEEP, 'DEEP');
  });

  it('should have correct SEARCH_PHASES', () => {
    assert.equal(SEARCH_PHASES.CLUSTER_REUSE, 'cluster_reuse');
    assert.equal(SEARCH_PHASES.PARALLEL_PROBE, 'parallel_probe');
    assert.equal(SEARCH_PHASES.IDF_RANKING, 'idf_ranking');
    assert.equal(SEARCH_PHASES.CLUSTER_BUILD, 'cluster_build');
    assert.equal(SEARCH_PHASES.REACTIVE_REFINE, 'reactive_refine');
  });

  it('should have correct CLUSTER_CATEGORIES', () => {
    assert.equal(CLUSTER_CATEGORIES.PERSON, 'person');
    assert.equal(CLUSTER_CATEGORIES.PROJECT, 'project');
    assert.equal(CLUSTER_CATEGORIES.MEMORY_TYPE, 'memory_type');
    assert.equal(CLUSTER_CATEGORIES.TOPIC, 'topic');
    assert.equal(CLUSTER_CATEGORIES.DECISION, 'decision');
    assert.equal(CLUSTER_CATEGORIES.ERROR_PATTERN, 'error_pattern');
  });
});

// ========== Boundary conditions ==========

describe('Search boundary conditions', () => {
  it('should handle empty evidenceUnits in IDF ranking', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'empty ev', confidence: 0.8, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, enableIdfRanking: true, minConfidenceForAnswer: 0.7 });
    const result = await engine.search('empty ev');
    assert.deepEqual(result.evidenceUnits, []);
  });

  it('should handle null evidenceUnits in IDF ranking', async () => {
    const mockAdapter = {
      search: async () => ({ answer: 'null ev', confidence: 0.8, evidenceUnits: null, tokensUsed: 10, timestamp: Date.now() }),
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, enableIdfRanking: true, minConfidenceForAnswer: 0.7 });
    const result = await engine.search('null ev');
    assert.equal(result.evidenceUnits, null);
  });

  it('should handle cluster with empty keywords', () => {
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    store.createCluster({ name: 'No Keywords', keywords: [] });
    assert.equal(store.findMatchingCluster('anything'), null);
  });

  it('should handle findMatchingCluster with empty query', () => {
    const store = new KnowledgeClusterStore({ similarityThreshold: 0.5 });
    store.createCluster({ name: 'Test', keywords: ['test'] });
    assert.equal(store.findMatchingCluster(''), null);
  });

  it('should handle mergeClusters with same source and target', () => {
    const store = new KnowledgeClusterStore();
    const c = store.createCluster({ name: 'Same', keywords: ['a'], evidence: [{ content: 'e1' }] });
    const result = store.mergeClusters(c.id, c.id);
    // Same ID merge succeeds but cluster is removed (source deleted)
    assert.equal(result, true);
    assert.equal(store.getCluster(c.id), null);
  });

  it('should handle reactive refine with DEEP mode and low confidence', async () => {
    let callCount = 0;
    const mockAdapter = {
      search: async () => {
        callCount++;
        return { answer: 'refined', confidence: callCount >= 2 ? 0.8 : 0.3, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() };
      },
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, enableReactiveRefine: true, minConfidenceForAnswer: 0.7, maxRefineLoops: 3 });
    const result = await engine.search('refine test', { mode: SEARCH_MODES.DEEP });
    assert.equal(result.source, 'sirchnunk');
    assert.ok(callCount >= 2);
  });

  it('should not refine in FAST mode even with low confidence', async () => {
    let callCount = 0;
    const mockAdapter = {
      search: async () => {
        callCount++;
        return { answer: 'fast', confidence: 0.3, evidenceUnits: [], tokensUsed: 10, timestamp: Date.now() };
      },
    };
    const engine = new EvolvingSearchEngine({ sirchnunkAdapter: mockAdapter, enableClusterReuse: false, enableReactiveRefine: true, minConfidenceForAnswer: 0.7 });
    await engine.search('fast test', { mode: SEARCH_MODES.FAST });
    assert.equal(callCount, 1);
  });

  it('should handle KnowledgeClusterStore with maxEvidencePerCluster=1', () => {
    const store = new KnowledgeClusterStore({ maxEvidencePerCluster: 1 });
    const c = store.createCluster({ name: 'Small' });
    store.addEvidence(c.id, { content: 'first' });
    store.addEvidence(c.id, { content: 'second' });
    assert.equal(store.getCluster(c.id).evidence.length, 1);
    assert.equal(store.getCluster(c.id).evidence[0].content, 'second');
  });
});
