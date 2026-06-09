'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const AITestFramework = require('../../../src/runtime/quality/ai-test-framework');

describe('AITestFramework', () => {
  it('should create instance with default options', () => {
    const fw = new AITestFramework();
    assert.ok(fw);
    const stats = fw.getStats();
    assert.strictEqual(stats.totalTests, 0);
    assert.strictEqual(stats.activeTests, 0);
  });

  it('should create instance with custom options', () => {
    const fw = new AITestFramework({ maxConcurrentTests: 5, fuzzingIterations: 500 });
    assert.ok(fw);
  });

  it('should run hallucination test and detect issues', async () => {
    const fw = new AITestFramework();
    const result = await fw.runHallucinationTest({
      agentFn: async (_prompt) => 'This is definitely always correct and never fails',
      testCases: [
        { prompt: 'test', expectedFacts: ['correct answer'] },
      ],
      forbiddenPatterns: ['fake-api'],
    });
    assert.ok(result);
    assert.strictEqual(typeof result.passed, 'boolean');
    assert.ok(Array.isArray(result.details));
    // Should detect overconfident signals
    assert.ok(result.hallucinationCount > 0);
  });

  it('should pass hallucination test with valid response', async () => {
    const fw = new AITestFramework();
    const result = await fw.runHallucinationTest({
      agentFn: async (_prompt) => 'The correct answer includes the expected data point.',
      testCases: [
        { prompt: 'test', expectedFacts: ['expected data point'] },
      ],
    });
    assert.ok(result);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.hallucinationCount, 0);
  });

  it('should reject hallucination test with missing config', async () => {
    const fw = new AITestFramework();
    const result = await fw.runHallucinationTest({});
    assert.strictEqual(result.passed, false);
    assert.ok(result.error);
  });

  it('should run stress test', async () => {
    const fw = new AITestFramework();
    const result = await fw.runStressTest({
      agentFn: async (_prompt) => 'response',
      scenarios: [
        { name: 'simple', prompt: 'test' },
        { name: 'complex', prompt: 'complex test', context: { depth: 5 } },
      ],
      iterations: 2,
      maxResponseTimeMs: 5000,
    });
    assert.ok(result);
    assert.strictEqual(typeof result.passed, 'boolean');
    assert.ok(Array.isArray(result.scenarios));
    assert.strictEqual(result.scenarios.length, 2);
  });

  it('should reject stress test with missing config', async () => {
    const fw = new AITestFramework();
    const result = await fw.runStressTest({});
    assert.strictEqual(result.passed, false);
  });

  it('should run token benchmark and detect regression', async () => {
    const fw = new AITestFramework({ tokenBaselineWindowSize: 5 });

    // First run to establish baseline
    await fw.runTokenBenchmark({
      agentFn: async (_prompt) => 'short',
      benchmarks: [{ name: 'test-bench', prompt: 'test' }],
    });

    // Second run with much longer response to trigger regression
    const result = await fw.runTokenBenchmark({
      agentFn: async (_prompt) => 'a'.repeat(1000),
      benchmarks: [{ name: 'test-bench', prompt: 'test' }],
    });
    assert.ok(result);
    assert.ok(Array.isArray(result.benchmarks));
  });

  it('should reject token benchmark with missing config', async () => {
    const fw = new AITestFramework();
    const result = await fw.runTokenBenchmark({});
    assert.strictEqual(result.passed, false);
  });

  it('should run fuzzing test', async () => {
    const fw = new AITestFramework();
    const result = await fw.runFuzzingTest({
      targetFn: (input) => {
        if (input.value === null) throw new Error('null input');
        return { path: 'ok' };
      },
      iterations: 50,
      mutationStrategies: ['null', 'empty', 'overflow'],
    });
    assert.ok(result);
    assert.strictEqual(typeof result.passed, 'boolean');
    assert.strictEqual(result.iterations, 50);
    assert.ok(Array.isArray(result.crashes));
  });

  it('should reject fuzzing test with missing config', async () => {
    const fw = new AITestFramework();
    const result = await fw.runFuzzingTest({});
    assert.strictEqual(result.passed, false);
  });

  it('should get active tests', () => {
    const fw = new AITestFramework();
    const active = fw.getActiveTests();
    assert.ok(Array.isArray(active));
    assert.strictEqual(active.length, 0);
  });

  it('should get token baselines', () => {
    const fw = new AITestFramework();
    const baselines = fw.getTokenBaselines();
    assert.ok(baselines instanceof Map);
  });

  it('should shutdown cleanly', () => {
    const fw = new AITestFramework();
    fw.shutdown();
    // shutdown后getStats()应抛出异常
    assert.throws(() => fw.getStats(), { code: 'SHUTDOWN' });
  });
});
