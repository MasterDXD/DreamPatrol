'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('CapabilityGapAnalyzer - constructor', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should construct with default config', () => {
    const analyzer = new CapabilityGapAnalyzer();
    assert.strictEqual(analyzer._config.maxRecommendations, 20);
    assert.strictEqual(analyzer._config.severityThreshold, 'low');
    assert.strictEqual(analyzer._config.autoPrioritize, true);
    assert.strictEqual(analyzer._config.historySize, 100);
    assert.ok(analyzer.isHealthy());
    analyzer.shutdown();
  });

  it('should construct with custom options', () => {
    const analyzer = new CapabilityGapAnalyzer({
      maxRecommendations: 10,
      severityThreshold: 'medium',
      autoPrioritize: false,
    });
    assert.strictEqual(analyzer._config.maxRecommendations, 10);
    assert.strictEqual(analyzer._config.severityThreshold, 'medium');
    assert.strictEqual(analyzer._config.autoPrioritize, false);
    analyzer.shutdown();
  });

  it('should be healthy after construction', () => {
    const analyzer = new CapabilityGapAnalyzer();
    assert.ok(analyzer.isHealthy());
    analyzer.shutdown();
  });

  it('should not be healthy after shutdown', () => {
    const analyzer = new CapabilityGapAnalyzer();
    analyzer.shutdown();
    assert.strictEqual(analyzer.isHealthy(), false);
  });
});

describe('CapabilityGapAnalyzer - registerCapability', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should register a valid capability', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = analyzer.registerCapability('skills', 'requirement-analysis', { phase: 'analyze' });
    assert.strictEqual(result.success, true);
    assert.ok(analyzer.hasCapability('skills', 'requirement-analysis'));
    analyzer.shutdown();
  });

  it('should reject invalid dimension', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = analyzer.registerCapability('invalid', 'test');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Invalid dimension'));
    analyzer.shutdown();
  });

  it('should reject empty name', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = analyzer.registerCapability('skills', '');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('non-empty string'));
    analyzer.shutdown();
  });

  it('should register capabilities across all six dimensions', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const dimensions = ['skills', 'tools', 'rules', 'cicd', 'docs', 'tests'];
    const results = [];
    for (const dim of dimensions) {
      results.push(analyzer.registerCapability(dim, dim + '-test-cap'));
    }
    assert.ok(results.every(r => r.success));
    for (const dim of dimensions) {
      assert.ok(analyzer.hasCapability(dim, dim + '-test-cap'));
    }
    analyzer.shutdown();
  });
});

describe('CapabilityGapAnalyzer - registerCapabilities', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should batch register capabilities', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = analyzer.registerCapabilities([
      { dimension: 'skills', name: 'tdd-implement' },
      { dimension: 'skills', name: 'code-review' },
      { dimension: 'tools', name: 'git' },
      { dimension: 'rules', name: 'eslint' },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.registered, 4);
    assert.ok(analyzer.hasCapability('skills', 'tdd-implement'));
    assert.ok(analyzer.hasCapability('tools', 'git'));
    assert.ok(analyzer.hasCapability('rules', 'eslint'));
    analyzer.shutdown();
  });

  it('should reject non-array input', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = analyzer.registerCapabilities(null);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.registered, 0);
    analyzer.shutdown();
  });

  it('should return errors for invalid entries', () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = analyzer.registerCapabilities([
      { dimension: 'invalid', name: 'test' },
      { dimension: 'skills', name: '' },
      { dimension: 'skills', name: 'valid-skill' },
    ]);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.registered, 1);
    assert.strictEqual(result.errors.length, 2);
    analyzer.shutdown();
  });
});

describe('CapabilityGapAnalyzer - analyze', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should analyze a fullstack-build task and find skill gaps', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'build a full-stack web application',
      availableSkills: ['requirement-analysis'],
      environment: { hasCI: true, hasLint: true, hasTests: true },
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.gaps);
    assert.ok(result.gaps.skills.length > 0);
    assert.ok(result.recommendations.length > 0);
    assert.ok(result.summary.length > 0);
    analyzer.shutdown();
  });

  it('should analyze a bug-fix task', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'fix a bug in the login component',
      availableSkills: ['systematic-debugging'],
      environment: { hasCI: true, hasLint: true, hasTests: true },
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.gaps);
    const hasBugFixGap = result.gaps.skills.some(g => g.name === 'bug-fix');
    assert.ok(hasBugFixGap);
    analyzer.shutdown();
  });

  it('should detect missing tools', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'create a simple script',
      availableTools: [],
      environment: { hasCI: false, hasLint: false, hasTests: false },
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.gaps.tools.length > 0);
    const hasGitGap = result.gaps.tools.some(g => g.name === 'git');
    assert.ok(hasGitGap);
    analyzer.shutdown();
  });

  it('should detect missing lint rules', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'refactor code',
      lintRules: [],
      environment: { hasLint: true },
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.gaps.rules.length > 0);
    analyzer.shutdown();
  });

  it('should detect no lint config when hasLint is false', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'build anything',
      environment: { hasLint: false },
    });
    assert.strictEqual(result.success, true);
    const hasESLintGap = result.gaps.rules.some(g => g.name === 'eslint-config');
    assert.ok(hasESLintGap);
    analyzer.shutdown();
  });

  it('should detect missing CI pipeline', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'deploy to production',
      ciSteps: [],
      environment: { hasCI: false },
    });
    assert.strictEqual(result.success, true);
    const hasCIGap = result.gaps.cicd.some(g => g.name === 'ci-pipeline');
    assert.ok(hasCIGap);
    analyzer.shutdown();
  });

  it('should detect missing documentation', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'document the API',
      docs: [],
      environment: {},
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.gaps.docs.length > 0);
    analyzer.shutdown();
  });

  it('should detect missing test framework', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'build a feature',
      testTypes: [],
      environment: { hasTests: false },
    });
    assert.strictEqual(result.success, true);
    const hasTestGap = result.gaps.tests.some(g => g.name === 'test-framework');
    assert.ok(hasTestGap);
    analyzer.shutdown();
  });

  it('should skip registered capabilities in gap analysis', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    analyzer.registerCapability('skills', 'architecture-design');
    analyzer.registerCapability('skills', 'tdd-implement');
    const result = await analyzer.analyze({
      task: 'build a full-stack web application',
      availableSkills: ['requirement-analysis'],
      environment: { hasCI: true, hasLint: true, hasTests: true },
    });
    assert.strictEqual(result.success, true);
    const archGap = result.gaps.skills.filter(g => g.name === 'architecture-design');
    const tddGap = result.gaps.skills.filter(g => g.name === 'tdd-implement');
    assert.strictEqual(archGap.length, 0, 'architecture-design should be satisfied by registry');
    assert.strictEqual(tddGap.length, 0, 'tdd-implement should be satisfied by registry');
    analyzer.shutdown();
  });

  it('should reject null context', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze(null);
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    analyzer.shutdown();
  });

  it('should infer task type from task description', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    const result = await analyzer.analyze({
      task: 'fix a critical bug in authentication',
      availableSkills: [],
      environment: { hasCI: true, hasLint: true, hasTests: true },
    });
    assert.strictEqual(result.success, true);
    const hasDebugGap = result.gaps.skills.some(g => g.name === 'systematic-debugging');
    assert.ok(hasDebugGap);
    analyzer.shutdown();
  });
});

describe('CapabilityGapAnalyzer - getRecommendations', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should return recommendations sorted by severity', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    await analyzer.analyze({
      task: 'build a full-stack web application',
      availableSkills: [],
      availableTools: [],
      lintRules: [],
      ciSteps: [],
      docs: [],
      testTypes: [],
      environment: { hasCI: false, hasLint: false, hasTests: false },
    });
    const recs = analyzer.getRecommendations();
    assert.ok(recs.length > 0);
    for (let i = 1; i < recs.length; i++) {
      assert.ok(recs[i - 1].weight >= recs[i].weight, 'Recommendations should be sorted by weight descending');
    }
    analyzer.shutdown();
  });

  it('should filter recommendations by dimension', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    await analyzer.analyze({
      task: 'build a full-stack web application',
      availableSkills: [],
      environment: { hasCI: true, hasLint: true, hasTests: true },
    });
    const skillRecs = analyzer.getRecommendationsByDimension('skills');
    assert.ok(skillRecs.length > 0);
    assert.ok(skillRecs.every(r => r.dimension === 'skills'));
    analyzer.shutdown();
  });
});

describe('CapabilityGapAnalyzer - history and stats', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should track analysis history', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    await analyzer.analyze({ task: 'task 1', environment: {} });
    await analyzer.analyze({ task: 'task 2', environment: {} });
    const history = analyzer.getAnalysisHistory();
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].task, 'task 1');
    assert.strictEqual(history[1].task, 'task 2');
    analyzer.shutdown();
  });

  it('should limit analysis history', async () => {
    const analyzer = new CapabilityGapAnalyzer({ historySize: 3 });
    for (let i = 0; i < 5; i++) {
      await analyzer.analyze({ task: 'task ' + i, environment: {} });
    }
    const history = analyzer.getAnalysisHistory();
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[2].task, 'task 4');
    analyzer.shutdown();
  });

  it('should return stats', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    analyzer.registerCapability('skills', 'test-skill');
    await analyzer.analyze({ task: 'test', environment: { hasCI: true, hasLint: true, hasTests: true } });
    const stats = analyzer.getStats();
    assert.strictEqual(stats.totalAnalyses, 1);
    assert.ok(stats.totalGaps > 0);
    assert.ok(stats.totalRecommendations > 0);
    assert.strictEqual(stats.registeredCapabilities, 1);
    assert.ok(stats.lastAnalysisAt !== null);
    analyzer.shutdown();
  });
});

describe('CapabilityGapAnalyzer - shutdown', () => {
  const CapabilityGapAnalyzer = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'capability-gap-analyzer'));

  it('should throw after shutdown', async () => {
    const analyzer = new CapabilityGapAnalyzer();
    analyzer.shutdown();
    assert.throws(() => analyzer.guardShutdown());
    await assert.rejects(() => analyzer.analyze({ task: 'test', environment: {} }));
  });

  it('should not throw on double shutdown', () => {
    const analyzer = new CapabilityGapAnalyzer();
    analyzer.shutdown();
    assert.doesNotThrow(() => analyzer.shutdown());
  });
});
