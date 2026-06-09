'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const SkillSemanticSearcher = require('../../../src/runtime/skill/skill-semantic-searcher');
const { DEFAULT_SEMANTIC_SEARCH_CONFIG, SIMILARITY_METRICS } = SkillSemanticSearcher;

// --- Mock helpers ---

/**
 * Deterministic embedding based on text hash.
 * Returns a fixed-dimension vector where each component is derived from
 * a simple hash of the input text, ensuring same text => same vector.
 */
function createMockEmbeddingService(dimension = 384) {
  return {
    embed(text) {
      if (!text) return [];
      const vec = new Array(dimension);
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < dimension; i++) {
        // Produce values in [-1, 1] based on hash + offset
        vec[i] = Math.sin(hash + i) * 0.5;
      }
      return vec;
    },
  };
}

function createTestSkills() {
  return [
    {
      skill_id: 'skill-code-review',
      name: 'Code Review',
      description: 'Review code for quality and best practices',
      tags: ['review', 'code'],
      trigger_conditions: ['review code'],
      applicable_agents: ['code-reviewer'],
    },
    {
      skill_id: 'skill-debug',
      name: 'Debug',
      description: 'Systematic debugging of code issues',
      tags: ['debug', 'troubleshoot'],
      trigger_conditions: ['debug issue'],
      applicable_agents: ['debug-agent'],
    },
    {
      skill_id: 'skill-deploy',
      name: 'Deploy',
      description: 'Deploy applications to production',
      tags: ['deploy', 'release'],
      trigger_conditions: ['deploy app'],
      applicable_agents: ['devops-engineer'],
    },
    {
      skill_id: 'skill-infra',
      name: 'Infrastructure',
      description: 'Infrastructure skill',
      infrastructure: true,
    },
  ];
}

function createMockSkillRouter(skills) {
  return {
    skills,
    getSkill(id) {
      return skills.find((s) => s.skill_id === id) || null;
    },
    match({ userMessage }) {
      const msg = (userMessage || '').toLowerCase();
      return skills.filter((s) => {
        const text = [s.name, s.description, ...(s.tags || [])].join(' ').toLowerCase();
        return text.includes(msg) || msg.split(' ').some((w) => w.length > 2 && text.includes(w));
      });
    },
  };
}

// --- Tests ---

describe('SkillSemanticSearcher', () => {
  it('constructor uses default config when no config provided', () => {
    const searcher = new SkillSemanticSearcher();
    assert.strictEqual(searcher._config.embeddingDimension, DEFAULT_SEMANTIC_SEARCH_CONFIG.embeddingDimension);
    assert.strictEqual(searcher._config.similarityThreshold, DEFAULT_SEMANTIC_SEARCH_CONFIG.similarityThreshold);
    assert.strictEqual(searcher._config.maxResults, DEFAULT_SEMANTIC_SEARCH_CONFIG.maxResults);
    assert.strictEqual(searcher._config.indexUpdateIntervalMs, DEFAULT_SEMANTIC_SEARCH_CONFIG.indexUpdateIntervalMs);
    searcher.shutdown();
  });

  it('constructor merges custom config with defaults', () => {
    const searcher = new SkillSemanticSearcher({
      similarityThreshold: 0.8,
      maxResults: 5,
    });
    assert.strictEqual(searcher._config.similarityThreshold, 0.8);
    assert.strictEqual(searcher._config.maxResults, 5);
    assert.strictEqual(searcher._config.embeddingDimension, DEFAULT_SEMANTIC_SEARCH_CONFIG.embeddingDimension);
    searcher.shutdown();
  });

  it('attachEmbeddingService and attachSkillRouter work and return this', () => {
    const searcher = new SkillSemanticSearcher();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(createTestSkills());

    const result1 = searcher.attachEmbeddingService(embedding);
    assert.strictEqual(result1, searcher);
    assert.strictEqual(searcher._embeddingService, embedding);

    const result2 = searcher.attachSkillRouter(router);
    assert.strictEqual(result2, searcher);
    assert.strictEqual(searcher._skillRouter, router);

    searcher.shutdown();
  });

  it('attach methods throw after shutdown', () => {
    const searcher = new SkillSemanticSearcher();
    searcher.shutdown();

    assert.throws(() => searcher.attachEmbeddingService(createMockEmbeddingService()));
    assert.throws(() => searcher.attachSkillRouter(createMockSkillRouter([])));
  });

  it('buildIndex builds embeddings for skills and emits index-built', async () => {
    const searcher = new SkillSemanticSearcher({ indexUpdateIntervalMs: 600000 });
    const skills = createTestSkills();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(skills);

    searcher.attachEmbeddingService(embedding);
    searcher.attachSkillRouter(router);

    let eventFired = false;
    let eventData = null;
    searcher.on('index-built', (data) => {
      eventFired = true;
      eventData = data;
    });

    await searcher.buildIndex();

    assert.strictEqual(eventFired, true);
    assert.strictEqual(eventData.skillCount, 3); // skill-infra is skipped (infrastructure: true)
    assert.strictEqual(searcher._skillEmbeddings.size, 3);

    searcher.shutdown();
  });

  it('search returns results sorted by similarity', async () => {
    const searcher = new SkillSemanticSearcher({
      similarityThreshold: -1,
      indexUpdateIntervalMs: 600000,
    });
    const skills = createTestSkills();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(skills);

    searcher.attachEmbeddingService(embedding);
    searcher.attachSkillRouter(router);
    await searcher.buildIndex();

    const results = await searcher.search('Review code for quality');
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);

    // Results should be sorted by similarity descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].similarity >= results[i].similarity);
    }

    // Each result should have required fields
    for (const r of results) {
      assert.ok('skillId' in r);
      assert.ok('similarity' in r);
      assert.ok('skill' in r);
    }

    searcher.shutdown();
  });

  it('search falls back to keyword matching when no embedding service', async () => {
    const skills = createTestSkills();
    const router = createMockSkillRouter(skills);
    const searcher = new SkillSemanticSearcher();

    searcher.attachSkillRouter(router);
    // No embedding service attached

    const results = await searcher.search('debug');
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].similarity, 0.5);

    searcher.shutdown();
  });

  it('findSimilar returns similar skills', async () => {
    const searcher = new SkillSemanticSearcher({ indexUpdateIntervalMs: 600000 });
    const skills = createTestSkills();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(skills);

    searcher.attachEmbeddingService(embedding);
    searcher.attachSkillRouter(router);
    await searcher.buildIndex();

    const similar = await searcher.findSimilar('skill-code-review');
    assert.ok(Array.isArray(similar));
    // Should not include the source skill itself
    for (const s of similar) {
      assert.notStrictEqual(s.skillId, 'skill-code-review');
    }

    searcher.shutdown();
  });

  it('compareSkills returns pairwise similarity matrix', async () => {
    const searcher = new SkillSemanticSearcher({ indexUpdateIntervalMs: 600000 });
    const skills = createTestSkills();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(skills);

    searcher.attachEmbeddingService(embedding);
    searcher.attachSkillRouter(router);
    await searcher.buildIndex();

    const comparisons = await searcher.compareSkills([
      'skill-code-review',
      'skill-debug',
      'skill-deploy',
    ]);
    assert.ok(Array.isArray(comparisons));
    assert.strictEqual(comparisons.length, 3); // C(3,2) = 3 pairs

    for (const c of comparisons) {
      assert.ok('skillA' in c);
      assert.ok('skillB' in c);
      assert.ok('similarity' in c);
      assert.ok(typeof c.similarity === 'number');
    }

    searcher.shutdown();
  });

  it('getStats returns statistics', async () => {
    const searcher = new SkillSemanticSearcher({ indexUpdateIntervalMs: 600000 });
    const skills = createTestSkills();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(skills);

    searcher.attachEmbeddingService(embedding);
    searcher.attachSkillRouter(router);
    await searcher.buildIndex();

    await searcher.search('test query');

    const stats = searcher.getStats();
    assert.ok('totalSearches' in stats);
    assert.ok('cacheHits' in stats);
    assert.ok('avgSimilarity' in stats);
    assert.ok('indexSize' in stats);
    assert.strictEqual(stats.totalSearches, 1);
    assert.strictEqual(stats.indexSize, 3);

    searcher.shutdown();
  });

  it('shutdown cleans up resources', async () => {
    const searcher = new SkillSemanticSearcher({ indexUpdateIntervalMs: 600000 });
    const skills = createTestSkills();
    const embedding = createMockEmbeddingService();
    const router = createMockSkillRouter(skills);

    searcher.attachEmbeddingService(embedding);
    searcher.attachSkillRouter(router);
    await searcher.buildIndex();

    searcher.shutdown();

    assert.strictEqual(searcher._embeddingService, null);
    assert.strictEqual(searcher._skillRouter, null);
    assert.strictEqual(searcher._updateTimer, null);
    assert.strictEqual(searcher._stats.totalSearches, 0);

    // Operations after shutdown should throw/reject
    await assert.rejects(() => searcher.buildIndex());
    await assert.rejects(() => searcher.search('test'));
  });

  it('DEFAULT_SEMANTIC_SEARCH_CONFIG and SIMILARITY_METRICS are exported', () => {
    assert.ok(DEFAULT_SEMANTIC_SEARCH_CONFIG);
    assert.strictEqual(typeof DEFAULT_SEMANTIC_SEARCH_CONFIG.embeddingDimension, 'number');
    assert.strictEqual(typeof DEFAULT_SEMANTIC_SEARCH_CONFIG.similarityThreshold, 'number');
    assert.strictEqual(typeof DEFAULT_SEMANTIC_SEARCH_CONFIG.maxResults, 'number');
    assert.strictEqual(typeof DEFAULT_SEMANTIC_SEARCH_CONFIG.indexUpdateIntervalMs, 'number');

    assert.ok(SIMILARITY_METRICS);
    assert.strictEqual(SIMILARITY_METRICS.COSINE, 'cosine');
    assert.strictEqual(SIMILARITY_METRICS.EUCLIDEAN, 'euclidean');
    assert.strictEqual(SIMILARITY_METRICS.DOT_PRODUCT, 'dot_product');
  });
});
