'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CostAwareRouter = require('../../../src/runtime/model/cost-aware-router');

describe('CostAwareRouter', () => {
  let router;

  it('should create instance with default options', () => {
    router = new CostAwareRouter();
    assert.ok(router instanceof CostAwareRouter);
  });

  it('should be healthy after creation', () => {
    router = new CostAwareRouter();
    assert.equal(router.isHealthy(), true);
  });

  it('should analyze complexity of simple message', () => {
    router = new CostAwareRouter();
    const result = router.analyzeComplexity({ message: 'Hello' });
    assert.ok(typeof result === 'object');
    assert.ok(typeof result.complexityScore === 'number');
    assert.ok(result.complexityScore >= 0 && result.complexityScore <= 1);
  });

  it('should analyze complexity of complex message', () => {
    router = new CostAwareRouter();
    const result = router.analyzeComplexity({
      message: 'Architecture design with distributed systems microservices CQRS event sourcing saga patterns',
    });
    assert.ok(result.complexityScore >= 0);
  });

  it('should analyze complexity of message with code blocks', () => {
    router = new CostAwareRouter();
    const result = router.analyzeComplexity({
      message: '```\nfunction foo() {}\n```\n```\nclass Bar {}\n```\n```\nconst x = 1\n```\n```\n// comment\n```',
    });
    assert.ok(result.complexityScore >= 0);
  });

  it('should record usage and track costs', () => {
    router = new CostAwareRouter();
    const record = router.recordUsage('tdd-implement', {
      tokensUsed: 1500,
      modelTier: 'medium',
    });
    assert.ok(record !== null);
    assert.ok(typeof record === 'object');
  });

  it('should return null for invalid usage', () => {
    router = new CostAwareRouter();
    const record = router.recordUsage(null, null);
    assert.equal(record, null);
  });

  it('should get skill costs', () => {
    router = new CostAwareRouter();
    router.recordUsage('tdd-implement', { tokensUsed: 1000, modelTier: 'medium' });
    const costs = router.getSkillCosts('tdd-implement');
    assert.ok(typeof costs === 'object');
  });

  it('should get cost summary', () => {
    router = new CostAwareRouter();
    router.recordUsage('skill-a', { tokensUsed: 500, modelTier: 'small' });
    router.recordUsage('skill-b', { tokensUsed: 2000, modelTier: 'large' });
    const summary = router.getCostSummary();
    assert.ok(typeof summary === 'object');
  });

  it('should get stats', () => {
    router = new CostAwareRouter();
    const stats = router.getStats();
    assert.ok(typeof stats === 'object');
    assert.ok(stats.totalCalls !== undefined);
    assert.ok(stats.cacheHits !== undefined);
  });

  it('should reset session cost', () => {
    router = new CostAwareRouter();
    router.recordUsage('skill-a', { tokensUsed: 500, modelTier: 'small' });
    router.resetSessionCost();
    const summary = router.getCostSummary();
    assert.ok(typeof summary === 'object');
  });

  it('should check if skill is cacheable', () => {
    router = new CostAwareRouter();
    const result = router.isCacheable('documentation');
    assert.ok(typeof result === 'boolean');
  });

  it('should record cache hit', () => {
    router = new CostAwareRouter();
    router.recordCacheHit('documentation', 500);
    // recordCacheHit returns void, verify it doesn't throw
    assert.ok(true);
  });

  it('should shutdown gracefully', async () => {
    router = new CostAwareRouter();
    await router.shutdown();
    assert.equal(router.isHealthy(), false);
  });

  it('should handle guardShutdown after shutdown', async () => {
    router = new CostAwareRouter();
    await router.shutdown();
    assert.throws(() => router.guardShutdown());
  });

  it('should handle analyzeComplexity with empty request', () => {
    router = new CostAwareRouter();
    const result = router.analyzeComplexity({});
    assert.ok(typeof result === 'object');
  });
});
