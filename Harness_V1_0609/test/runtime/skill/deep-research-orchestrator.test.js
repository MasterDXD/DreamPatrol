'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const DeepResearchOrchestrator = require('../../../src/runtime/skill/deep-research-orchestrator');

describe('DeepResearchOrchestrator constructor', () => {
  it('should create instance with default config', () => {
    const d = new DeepResearchOrchestrator();
    assert.ok(d);
    assert.equal(d._active, false);
    assert.ok(d.getStats());
    assert.equal(d.getStats().active, false);
  });

  it('should have RESEARCH_PHASES static', () => {
    assert.equal(DeepResearchOrchestrator.RESEARCH_PHASES.PLAN, 'plan');
    assert.equal(DeepResearchOrchestrator.RESEARCH_PHASES.COLLECT, 'collect');
    assert.equal(DeepResearchOrchestrator.RESEARCH_PHASES.ANALYZE, 'analyze');
    assert.equal(DeepResearchOrchestrator.RESEARCH_PHASES.SYNTHESIZE, 'synthesize');
    assert.equal(DeepResearchOrchestrator.RESEARCH_PHASES.REPORT, 'report');
  });

  it('should accept config with search engine', () => {
    const mockEngine = { search: async () => ({ answer: 'test', confidence: 0.8, source: 'mock' }) };
    const d = new DeepResearchOrchestrator({ searchEngine: mockEngine });
    assert.equal(d.getStats().searchEngine, true);
  });
});

describe('DeepResearchOrchestrator research', () => {
  it('should execute full research with no external dependencies', async () => {
    const d = new DeepResearchOrchestrator();
    const result = await d.research('AI agent frameworks', { depth: 'quick' });
    assert.ok(result.researchId.startsWith('research-'));
    assert.equal(result.topic, 'AI agent frameworks');
    assert.equal(result.depth, 'quick');
    assert.ok(result.confidence >= 0);
    assert.ok(result.phases.length === 5);
    assert.ok(result.report);
    assert.ok(result.report.includes('AI agent frameworks'));
  });

  it('should execute standard depth research', async () => {
    const d = new DeepResearchOrchestrator();
    const result = await d.research('React vs Vue comparison', { depth: 'standard' });
    assert.equal(result.depth, 'standard');
    assert.ok(result.report);
  });

  it('should execute deep research', async () => {
    const d = new DeepResearchOrchestrator();
    const result = await d.research('Machine learning trends', { depth: 'deep' });
    assert.equal(result.depth, 'deep');
    assert.ok(result.report);
  });

  it('should generate JSON format report', async () => {
    const d = new DeepResearchOrchestrator();
    const result = await d.research('Test topic', { depth: 'quick', outputFormat: 'json' });
    assert.ok(typeof result.report === 'object');
    assert.ok(result.report.title);
    assert.ok(typeof result.report.confidence === 'number');
  });

  it('should generate compact format report', async () => {
    const d = new DeepResearchOrchestrator();
    const result = await d.research('Test topic', { depth: 'quick', outputFormat: 'compact' });
    assert.ok(typeof result.report === 'string');
    assert.ok(result.report.includes('TOPIC:'));
  });

  it('should throw on empty topic', async () => {
    const d = new DeepResearchOrchestrator();
    await assert.rejects(() => d.research(''), /topic is required/);
  });

  it('should throw on non-string topic', async () => {
    const d = new DeepResearchOrchestrator();
    await assert.rejects(() => d.research(123), /topic is required/);
  });

  it('should throw on invalid depth', async () => {
    const d = new DeepResearchOrchestrator();
    await assert.rejects(() => d.research('test', { depth: 'invalid' }), /Invalid depth/);
  });

  it('should throw on too long topic', async () => {
    const d = new DeepResearchOrchestrator();
    await assert.rejects(() => d.research('x'.repeat(1001)), /exceeds maximum length/);
  });

  it('should accept focusAreas', async () => {
    const d = new DeepResearchOrchestrator();
    const result = await d.research('Python', { depth: 'quick', focusAreas: ['performance', 'security'] });
    assert.ok(result.report);
  });

  it('should emit phase events', async () => {
    const d = new DeepResearchOrchestrator();
    const phases = [];
    d.on('phase', function(e) { phases.push(e.phase); });
    await d.research('Test', { depth: 'quick' });
    assert.ok(phases.length >= 5);
    assert.ok(phases.includes('plan'));
    assert.ok(phases.includes('collect'));
    assert.ok(phases.includes('analyze'));
    assert.ok(phases.includes('synthesize'));
    assert.ok(phases.includes('report'));
  });

  it('should emit research-complete event', async () => {
    const d = new DeepResearchOrchestrator();
    let completed = null;
    d.on('research-complete', function(e) { completed = e; });
    await d.research('Test', { depth: 'quick' });
    assert.ok(completed);
    assert.ok(completed.researchId);
    assert.ok(typeof completed.confidence === 'number');
  });

  it('should work with mock search engine', async () => {
    const mockEngine = {
      search: async function(query) {
        return {
          answer: 'Mock result for ' + query,
          confidence: 0.85,
          source: 'mock-engine',
          evidenceUnits: [{ content: 'Mock evidence for ' + query, confidence: 0.8 }],
        };
      },
    };
    const d = new DeepResearchOrchestrator({ searchEngine: mockEngine });
    const result = await d.research('Test with engine', { depth: 'quick' });
    assert.ok(result.sources > 0);
    assert.ok(result.report);
  });

  it('should get history', async () => {
    const d = new DeepResearchOrchestrator();
    await d.research('Test1', { depth: 'quick' });
    await d.research('Test2', { depth: 'quick' });
    const history = d.getHistory(10);
    assert.ok(history.length >= 2);
  });

  it('should get stats', async () => {
    const d = new DeepResearchOrchestrator();
    await d.research('Test', { depth: 'quick' });
    const stats = d.getStats();
    assert.ok(stats.totalResearches >= 1);
    assert.equal(stats.active, false);
  });

  it('should handle shutdown', async () => {
    const d = new DeepResearchOrchestrator();
    await d.research('Test', { depth: 'quick' });
    d.shutdown();
    assert.throws(() => d.guardShutdown());
  });
});
