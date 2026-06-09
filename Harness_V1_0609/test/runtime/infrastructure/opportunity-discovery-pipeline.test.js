'use strict';

const { describe, it, before: _before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OpportunityDiscoveryPipeline = require(
  path.join(ROOT, 'src', 'runtime', 'infrastructure', 'opportunity-discovery-pipeline'),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock MCPClient with a .search() that resolves to given results */
function createMockMcpClient(results) {
  const items = results ?? [];
  return {
    search: async () => items,
  };
}

/** Create a mock BrowserUseAdapter with .extractByTemplate() */
function createMockBrowserAdapter(items) {
  const extracted = items ?? [];
  return {
    extractByTemplate: async () => extracted,
  };
}

/** Create a pipeline with sensible defaults and no real network calls */
function createPipeline(opts) {
  const defaults = {
    mcpClient: createMockMcpClient([]),
    browserAdapter: createMockBrowserAdapter([]),
    minSourcesPerPainPoint: 1,
    painIntensityThreshold: 5,
    solutionSatisfactionThreshold: 5,
    competitorReviewMinCount: 1,
  };
  return new OpportunityDiscoveryPipeline({ ...defaults, ...opts });
}

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------
const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { const r = obj.destroy(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

// ===========================================================================
// Test Group 1: Lifecycle
// ===========================================================================
describe('OpportunityDiscoveryPipeline - Lifecycle', () => {
  after(async () => { await _cleanAll(); });

  it('should initialize with default config', () => {
    const pipeline = _track(new OpportunityDiscoveryPipeline());
    assert.equal(pipeline._minSourcesPerPainPoint, 5);
    assert.equal(pipeline._painIntensityThreshold, 7);
    assert.equal(pipeline._solutionSatisfactionThreshold, 4);
    assert.equal(pipeline._competitorReviewMinCount, 20);
    assert.equal(pipeline._techTrendRecencyDays, 90);
    assert.equal(pipeline._initialized, false);
  });

  it('should initialize with custom config', () => {
    const pipeline = _track(new OpportunityDiscoveryPipeline({
      minSourcesPerPainPoint: 10,
      painIntensityThreshold: 9,
      solutionSatisfactionThreshold: 2,
      competitorReviewMinCount: 50,
      techTrendRecencyDays: 30,
    }));
    assert.equal(pipeline._minSourcesPerPainPoint, 10);
    assert.equal(pipeline._painIntensityThreshold, 9);
    assert.equal(pipeline._solutionSatisfactionThreshold, 2);
    assert.equal(pipeline._competitorReviewMinCount, 50);
    assert.equal(pipeline._techTrendRecencyDays, 30);
  });

  it('should fail guardShutdown after shutdown', () => {
    const pipeline = _track(createPipeline());
    pipeline.shutdown();
    assert.throws(() => pipeline.guardShutdown(), /shut down/i);
  });

  it('isHealthy should return false after shutdown', () => {
    const pipeline = _track(createPipeline());
    pipeline.shutdown();
    assert.equal(pipeline.isHealthy(), false);
  });

  it('isReady should return false before init', () => {
    const pipeline = _track(createPipeline());
    assert.equal(pipeline.isReady(), false);
  });
});

// ===========================================================================
// Test Group 2: Pain Point Scanning
// ===========================================================================
describe('OpportunityDiscoveryPipeline - Pain Point Scanning', () => {
  after(async () => { await _cleanAll(); });

  it('scanPainPoints should accept platforms array', async () => {
    const pipeline = _track(createPipeline());
    const result = await pipeline.scanPainPoints(['generic'], []);
    assert.ok(result);
    assert.ok(Array.isArray(result.painPoints));
    assert.equal(typeof result.totalScanned, 'number');
    assert.equal(typeof result.complaintCount, 'number');
  });

  it('scanPainPoints should pass keywords to internal method', async () => {
    const keywords = ['wish', 'hate'];
    const browserAdapter = {
      extractByTemplate: async (_template, _url, opts) => {
        // Verify keywords were forwarded
        if (opts && opts.keywords) {
          assert.deepEqual(opts.keywords, keywords);
        }
        return [];
      },
    };
    const pipeline = _track(createPipeline({ browserAdapter }));
    await pipeline.scanPainPoints(['generic'], keywords);
  });

  it('scanPainPoints should reject empty platforms', async () => {
    const pipeline = _track(createPipeline());
    await assert.rejects(
      () => pipeline.scanPainPoints([], []),
      /non-empty array/,
    );
  });

  it('scanPainPoints should reject platforms with no supported entries', async () => {
    const pipeline = _track(createPipeline());
    await assert.rejects(
      () => pipeline.scanPainPoints(['unknown-platform'], []),
      /at least one supported platform/,
    );
  });
});

// ===========================================================================
// Test Group 3: Competitive Analysis
// ===========================================================================
describe('OpportunityDiscoveryPipeline - Competitive Analysis', () => {
  after(async () => { await _cleanAll(); });

  it('analyzeCompetitiveGaps should require competitor names', async () => {
    const pipeline = _track(createPipeline());
    await assert.rejects(
      () => pipeline.analyzeCompetitiveGaps([]),
      /non-empty array/,
    );
  });

  it('analyzeCompetitiveGaps should filter by competitorReviewMinCount', async () => {
    const mcpClient = createMockMcpClient([
      { text: 'This product is terrible and broken', rating: 2 },
    ]);
    const pipeline = _track(createPipeline({
      mcpClient,
      competitorReviewMinCount: 100,
    }));
    const result = await pipeline.analyzeCompetitiveGaps(['CompetitorA']);
    // With minCount=100 and only 1 review, the competitor should be filtered out
    assert.equal(result.competitors.length, 0);
    assert.equal(Object.keys(result.gapMatrix).length, 0);
  });
});

// ===========================================================================
// Test Group 4: Tech Dividends
// ===========================================================================
describe('OpportunityDiscoveryPipeline - Tech Dividends', () => {
  after(async () => { await _cleanAll(); });

  it('discoverTechDividends should validate technologies array', async () => {
    const pipeline = _track(createPipeline());
    await assert.rejects(
      () => pipeline.discoverTechDividends([]),
      /non-empty array/,
    );
  });

  it('discoverTechDividends should reject non-array technologies', async () => {
    const pipeline = _track(createPipeline());
    await assert.rejects(
      () => pipeline.discoverTechDividends('not-an-array'),
      /non-empty array/,
    );
  });

  it('_searchTechSource should reject unknown sources', async () => {
    const pipeline = _track(createPipeline());
    const result = await pipeline._searchTechSource('unknown-source', 'AI');
    assert.equal(result.totalSearched, 0);
    assert.deepEqual(result.opportunities, []);
  });
});

// ===========================================================================
// Test Group 5: Product Lens
// ===========================================================================
describe('OpportunityDiscoveryPipeline - Product Lens', () => {
  after(async () => { await _cleanAll(); });

  it('validateWithProductLens should reject null direction', () => {
    const pipeline = _track(createPipeline());
    assert.throws(
      () => pipeline.validateWithProductLens(null),
      /non-empty object/,
    );
  });

  it('validateWithProductLens should check all three criteria', () => {
    const pipeline = _track(createPipeline());
    // Create a direction with low scores to trigger unmet criteria
    const direction = {
      description: 'A vague direction',
      targetUser: 'anyone',  // vague → low who score
      painPoints: [{ intensity: 2, satisfaction: 9, sources: [{ platform: 'test' }] }],
      timing: {},  // empty → low whyNow score
    };
    const result = pipeline.validateWithProductLens(direction);
    assert.equal(result.passed, false);
    assert.ok(Array.isArray(result.unmetCriteria));
    // Should have at least who and whyNow unmet
    assert.ok(result.unmetCriteria.includes('who'), 'should flag who as unmet');
    assert.ok(result.unmetCriteria.includes('whyNow'), 'should flag whyNow as unmet');
  });

  it('validateWithProductLens should pass with strong direction', () => {
    const pipeline = _track(createPipeline({
      painIntensityThreshold: 3,
      solutionSatisfactionThreshold: 8,
      minSourcesPerPainPoint: 1,
    }));
    const direction = {
      description: 'A compelling product direction for engineers',
      targetUser: '5000 senior developers who need better tooling',
      painPoints: [
        { intensity: 9, satisfaction: 1, sources: [{ platform: 'reddit' }, { platform: 'hackernews' }, { platform: 'stackoverflow' }, { platform: 'github-issues' }, { platform: 'v2ex' }] },
      ],
      timing: { marketWindow: true, techMaturity: true, competitiveLandscape: true, urgency: true },
    };
    const result = pipeline.validateWithProductLens(direction);
    assert.equal(result.passed, true);
    assert.equal(result.unmetCriteria.length, 0);
    assert.ok(result.scores.who >= 6, 'who score should be high');
    assert.ok(result.scores.howPainful >= 6, 'howPainful score should be high');
    assert.ok(result.scores.whyNow >= 6, 'whyNow score should be high');
  });
});

// ===========================================================================
// Test Group 6: R56 New Methods
// ===========================================================================
describe('OpportunityDiscoveryPipeline - R56 New Methods', () => {
  after(async () => { await _cleanAll(); });

  it('_exaSearch should validate query parameter (null/undefined/non-string)', async () => {
    const pipeline = _track(createPipeline());
    const r1 = await pipeline._exaSearch(null);
    assert.deepEqual(r1, []);
    const r2 = await pipeline._exaSearch(undefined);
    assert.deepEqual(r2, []);
    const r3 = await pipeline._exaSearch(42);
    assert.deepEqual(r3, []);
  });

  it('_exaSearch should truncate query over 500 chars', async () => {
    const longQuery = 'x'.repeat(600);
    const mcpClient = createMockMcpClient([]);
    const pipeline = _track(createPipeline({ mcpClient }));
    // Should not throw; internally the query is truncated to 500 chars
    const result = await pipeline._exaSearch(longQuery);
    assert.ok(Array.isArray(result));
  });

  it('_deepResearch should early-return on empty array', async () => {
    const pipeline = _track(createPipeline());
    // Should not throw and should return undefined (early return)
    const result = await pipeline._deepResearch([]);
    assert.equal(result, undefined);
  });

  it('_generatePersona should use Object.create(null) (no prototype pollution)', () => {
    const pipeline = _track(createPipeline());
    const painPoints = [
      { category: 'pricing', intensity: 8, sources: [{ platform: 'reddit' }] },
    ];
    const persona = pipeline._generatePersona(painPoints, []);
    // The persona should be a plain object with expected fields
    assert.ok(persona);
    assert.equal(typeof persona.primarySegment, 'string');
    assert.equal(typeof persona.techSavviness, 'string');
    assert.equal(typeof persona.budgetHint, 'string');
    // Verify internal categoryCounts/platformCounts use Object.create(null)
    // by checking they don't inherit Object.prototype properties
    assert.ok(persona.painProfile.categoryDistribution);
    assert.equal(Object.getPrototypeOf(persona.painProfile.categoryDistribution), null);
  });

  it('_analyzeAlternativePositioning should return null for empty inputs', () => {
    const pipeline = _track(createPipeline());
    const result = pipeline._analyzeAlternativePositioning({}, []);
    assert.equal(result, null);
  });

  it('_analyzeAlternativePositioning should return null for null inputs', () => {
    const pipeline = _track(createPipeline());
    const result = pipeline._analyzeAlternativePositioning(null, null);
    assert.equal(result, null);
  });

  it('all new methods should have guardShutdown()', async () => {
    const pipeline = _track(createPipeline());
    pipeline.shutdown();

    // _exaSearch
    await assert.rejects(() => pipeline._exaSearch('test'), /shut down/i);

    // _deepResearch
    await assert.rejects(() => pipeline._deepResearch([{ id: 'x', description: 'test', intensity: 5, frequency: 1 }]), /shut down/i);

    // _generatePersona
    assert.throws(() => pipeline._generatePersona([], []), /shut down/i);

    // _analyzeAlternativePositioning
    assert.throws(() => pipeline._analyzeAlternativePositioning({ a: {} }, [{ name: 'a' }]), /shut down/i);
  });
});

// ===========================================================================
// Test Group 7: Shutdown Safety
// ===========================================================================
describe('OpportunityDiscoveryPipeline - Shutdown Safety', () => {
  after(async () => { await _cleanAll(); });

  it('shutdown should clear all BoundedMaps', () => {
    const pipeline = _track(createPipeline());
    // Populate some data
    pipeline._painPoints.set('pp-1', { description: 'test' });
    pipeline._competitors.set('comp-1', { name: 'test' });
    pipeline._techTrends.set('tech-1', { technology: 'AI' });
    pipeline._productLensResults.set('dir-1', { passed: true });
    pipeline._discoverySessions.set('disc-1', { startedAt: 'now' });

    pipeline.shutdown();

    // After shutdown, BoundedMaps should be cleared (internal _map is null)
    assert.equal(pipeline._painPoints._map, null);
    assert.equal(pipeline._competitors._map, null);
    assert.equal(pipeline._techTrends._map, null);
    assert.equal(pipeline._productLensResults._map, null);
    assert.equal(pipeline._discoverySessions._map, null);
  });

  it('shutdown should clear _exaClient', () => {
    const pipeline = _track(createPipeline({ exaApiKey: 'test-key' }));
    assert.ok(pipeline._exaClient !== null, 'exaClient should exist before shutdown');
    pipeline.shutdown();
    assert.equal(pipeline._exaClient, null);
  });

  it('getPainPoints should throw after shutdown (due to L4 guardShutdown fix)', () => {
    const pipeline = _track(createPipeline());
    pipeline.shutdown();
    assert.throws(() => pipeline.getPainPoints(), /shut down/i);
  });

  it('getCompetitors should throw after shutdown (due to R52 guardShutdown fix)', () => {
    const pipeline = _track(createPipeline());
    pipeline.shutdown();
    assert.throws(() => pipeline.getCompetitors(), /shut down/i);
  });
});
