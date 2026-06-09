'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const SkillComparisonRecommender = require('../../../src/runtime/skill/skill-comparison-recommender');
const { DEFAULT_COMPARISON_CONFIG, COMPARISON_DIMENSIONS, DIMENSION_WEIGHTS } = SkillComparisonRecommender;

// --- Mock helpers ---

function createMockSkillRouter() {
  const skills = [
    {
      skill_id: 'skill-code-review',
      name: 'Code Review',
      description: 'Review code for quality',
      tags: ['review', 'code', 'quality'],
    },
    {
      skill_id: 'skill-debug',
      name: 'Debug',
      description: 'Debug code issues',
      tags: ['debug', 'troubleshoot'],
    },
    {
      skill_id: 'skill-deploy',
      name: 'Deploy',
      description: 'Deploy to production',
      tags: ['deploy', 'release'],
    },
  ];

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

function createMockQualityIndex() {
  return {
    getQualityScore(_skillId) {
      return {
        compositeScore: 0.8,
        qualityLevel: 'good',
        metrics: {
          successRate: 0.85,
          effectiveness: 0.75,
          healthScore: 0.8,
          usageFrequency: 0.6,
          maintenanceCost: 0.2,
          communityFeedback: 0.7,
        },
      };
    },
  };
}

function createMockEffectivenessOptimizer() {
  return {
    getSkillStats(_skillId) {
      return {
        avgExecutionTime: 500,
        successRate: 0.9,
        usageCount: 42,
      };
    },
  };
}

// --- Tests ---

describe('SkillComparisonRecommender', () => {
  it('constructor uses default config when no config provided', () => {
    const recommender = new SkillComparisonRecommender();
    assert.strictEqual(recommender._config.maxAlternatives, DEFAULT_COMPARISON_CONFIG.maxAlternatives);
    assert.strictEqual(recommender._config.minQualityScore, DEFAULT_COMPARISON_CONFIG.minQualityScore);
    assert.deepStrictEqual(
      recommender._config.comparisonDimensions,
      DEFAULT_COMPARISON_CONFIG.comparisonDimensions,
    );
    recommender.shutdown();
  });

  it('constructor merges custom config with defaults', () => {
    const recommender = new SkillComparisonRecommender({
      maxAlternatives: 5,
      minQualityScore: 0.7,
    });
    assert.strictEqual(recommender._config.maxAlternatives, 5);
    assert.strictEqual(recommender._config.minQualityScore, 0.7);
    assert.deepStrictEqual(
      recommender._config.comparisonDimensions,
      DEFAULT_COMPARISON_CONFIG.comparisonDimensions,
    );
    recommender.shutdown();
  });

  it('attachSkillRouter, attachQualityIndex, attachEffectivenessOptimizer work', () => {
    const recommender = new SkillComparisonRecommender();
    const router = createMockSkillRouter();
    const qualityIndex = createMockQualityIndex();
    const optimizer = createMockEffectivenessOptimizer();

    recommender.attachSkillRouter(router);
    assert.strictEqual(recommender._skillRouter, router);

    recommender.attachQualityIndex(qualityIndex);
    assert.strictEqual(recommender._qualityIndex, qualityIndex);

    recommender.attachEffectivenessOptimizer(optimizer);
    assert.strictEqual(recommender._effectivenessOptimizer, optimizer);

    recommender.shutdown();
  });

  it('attach methods throw after shutdown', () => {
    const recommender = new SkillComparisonRecommender();
    recommender.shutdown();

    assert.throws(() => recommender.attachSkillRouter(createMockSkillRouter()));
    assert.throws(() => recommender.attachQualityIndex(createMockQualityIndex()));
    assert.throws(() => recommender.attachEffectivenessOptimizer(createMockEffectivenessOptimizer()));
  });

  it('recommend returns alternatives with scores', async () => {
    const recommender = new SkillComparisonRecommender();
    const router = createMockSkillRouter();
    const qualityIndex = createMockQualityIndex();

    recommender.attachSkillRouter(router);
    recommender.attachQualityIndex(qualityIndex);

    const result = await recommender.recommend('review code for quality');

    assert.ok('alternatives' in result);
    assert.ok('recommendation' in result);
    assert.ok(Array.isArray(result.alternatives));

    if (result.alternatives.length > 0) {
      const alt = result.alternatives[0];
      assert.ok('skills' in alt);
      assert.ok('scores' in alt);
      assert.ok('compositeScore' in alt);
      assert.ok('pros' in alt);
      assert.ok('cons' in alt);

      // Scores should have the four dimensions
      assert.ok('quality' in alt.scores);
      assert.ok('speed' in alt.scores);
      assert.ok('reliability' in alt.scores);
      assert.ok('coverage' in alt.scores);
    }

    recommender.shutdown();
  });

  it('recommend returns empty for invalid input', async () => {
    const recommender = new SkillComparisonRecommender();
    recommender.attachSkillRouter(createMockSkillRouter());
    recommender.attachQualityIndex(createMockQualityIndex());

    const result1 = await recommender.recommend('');
    assert.deepStrictEqual(result1.alternatives, []);
    assert.strictEqual(result1.recommendation, null);

    const result2 = await recommender.recommend(null);
    assert.deepStrictEqual(result2.alternatives, []);
    assert.strictEqual(result2.recommendation, null);

    recommender.shutdown();
  });

  it('compareSolutions returns comparison results', async () => {
    const recommender = new SkillComparisonRecommender();
    const router = createMockSkillRouter();
    const qualityIndex = createMockQualityIndex();

    recommender.attachSkillRouter(router);
    recommender.attachQualityIndex(qualityIndex);

    const result = await recommender.compareSolutions([
      ['skill-code-review'],
      ['skill-debug', 'skill-deploy'],
    ]);

    assert.ok('comparisons' in result);
    assert.ok(Array.isArray(result.comparisons));
    assert.strictEqual(result.comparisons.length, 2);

    for (const comp of result.comparisons) {
      assert.ok('skills' in comp);
      assert.ok('scores' in comp);
      assert.ok('compositeScore' in comp);
      assert.ok(typeof comp.compositeScore === 'number');
    }

    recommender.shutdown();
  });

  it('compareSolutions returns empty for invalid input', async () => {
    const recommender = new SkillComparisonRecommender();

    const result1 = await recommender.compareSolutions([]);
    assert.deepStrictEqual(result1.comparisons, []);

    const result2 = await recommender.compareSolutions(null);
    assert.deepStrictEqual(result2.comparisons, []);

    recommender.shutdown();
  });

  it('getStats returns statistics', async () => {
    const recommender = new SkillComparisonRecommender();
    const router = createMockSkillRouter();
    const qualityIndex = createMockQualityIndex();

    recommender.attachSkillRouter(router);
    recommender.attachQualityIndex(qualityIndex);

    await recommender.recommend('review code');
    await recommender.compareSolutions([['skill-code-review']]);

    const stats = recommender.getStats();
    assert.ok('recommendationsGenerated' in stats);
    assert.ok('comparisonsPerformed' in stats);
    assert.ok('alternativesGenerated' in stats);
    assert.ok('cacheSize' in stats);
    assert.strictEqual(stats.recommendationsGenerated, 1);
    assert.strictEqual(stats.comparisonsPerformed, 1);

    recommender.shutdown();
  });

  it('shutdown cleans up resources', async () => {
    const recommender = new SkillComparisonRecommender();
    const router = createMockSkillRouter();
    const qualityIndex = createMockQualityIndex();

    recommender.attachSkillRouter(router);
    recommender.attachQualityIndex(qualityIndex);

    recommender.shutdown();

    assert.strictEqual(recommender._skillRouter, null);
    assert.strictEqual(recommender._qualityIndex, null);
    assert.strictEqual(recommender._effectivenessOptimizer, null);

    // Operations after shutdown should throw (async methods reject)
    await assert.rejects(() => recommender.recommend('test'));
    await assert.rejects(() => recommender.compareSolutions([['a']]));
  });

  it('DEFAULT_COMPARISON_CONFIG, COMPARISON_DIMENSIONS, DIMENSION_WEIGHTS are exported', () => {
    assert.ok(DEFAULT_COMPARISON_CONFIG);
    assert.strictEqual(typeof DEFAULT_COMPARISON_CONFIG.maxAlternatives, 'number');
    assert.strictEqual(typeof DEFAULT_COMPARISON_CONFIG.minQualityScore, 'number');
    assert.ok(Array.isArray(DEFAULT_COMPARISON_CONFIG.comparisonDimensions));

    assert.ok(COMPARISON_DIMENSIONS);
    assert.strictEqual(COMPARISON_DIMENSIONS.QUALITY, 'quality');
    assert.strictEqual(COMPARISON_DIMENSIONS.SPEED, 'speed');
    assert.strictEqual(COMPARISON_DIMENSIONS.RELIABILITY, 'reliability');
    assert.strictEqual(COMPARISON_DIMENSIONS.COVERAGE, 'coverage');

    assert.ok(DIMENSION_WEIGHTS);
    assert.strictEqual(typeof DIMENSION_WEIGHTS.quality, 'number');
    assert.strictEqual(typeof DIMENSION_WEIGHTS.speed, 'number');
    assert.strictEqual(typeof DIMENSION_WEIGHTS.reliability, 'number');
    assert.strictEqual(typeof DIMENSION_WEIGHTS.coverage, 'number');

    // Weights should sum to 1
    const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.001);
  });
});
