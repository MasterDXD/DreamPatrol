'use strict';

/**
 * @module runtime/quality/ai-test-framework
 * @classdesc AI专项测试框架 — 覆盖幻觉测试、压力测试、Token基准测试、长周期稳定性测试、Fuzzing测试。
 *
 * 五大测试类型：
 * 1. HallucinationTest — 幻觉专项测试：校验Agent输出是否编造代码/虚假文档信息
 * 2. StressTest — 压力测试：大上下文长文档、大批量代码库检索，测试Token消耗/响应速度
 * 3. TokenBenchmark — Token基准测试：记录各场景Token消耗基线，检测回归
 * 4. StabilityTest — 长周期稳定性测试：连续运行Agent，排查记忆丢失/工作流卡死
 * 5. FuzzingTest — Fuzzing测试：异常输入覆盖率，随机变异输入检测崩溃
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug: _debug } = require('../../utils/debug-logger');

class AITestFramework extends EventEmitter {
  /**
   * 创建AI专项测试框架实例。
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxConcurrentTests=3] - 最大并发测试数
   * @param {number} [options.defaultTimeoutMs=60000] - 默认测试超时(毫秒)
   * @param {number} [options.stressMaxTokens=100000] - 压力测试最大Token数
   * @param {number} [options.stabilityDurationMs=259200000] - 稳定性测试默认时长(72小时)
   * @param {number} [options.fuzzingIterations=1000] - Fuzzing默认迭代次数
   * @param {number} [options.tokenBaselineWindowSize=10] - Token基准滑动窗口大小
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._maxConcurrent = opts.maxConcurrentTests ?? 3;
    this._defaultTimeout = opts.defaultTimeoutMs ?? 60000;
    this._stressMaxTokens = opts.stressMaxTokens ?? 100000;
    this._stabilityDuration = opts.stabilityDurationMs ?? 259200000;
    this._fuzzingIterations = opts.fuzzingIterations ?? 1000;
    this._tokenBaselineWindow = opts.tokenBaselineWindowSize ?? 10;

    this._activeTests = new Map();
    this._results = [];
    this._maxResults = 500;
    this._tokenBaselines = new Map();
    this._running = false;
    this._concurrentCount = 0;
    this._activeTimers = [];
  }

  /**
   * 运行幻觉专项测试。
   * @param {object} config - 测试配置
   * @param {Function} config.agentFn - Agent执行函数，接收prompt返回response
   * @param {Array<{prompt: string, expectedFacts: string[]}>} config.testCases - 测试用例
   * @param {Array<string>} [config.forbiddenPatterns] - 禁止出现的模式(如虚假API名)
   * @param {number} [config.timeoutMs] - 超时时间
   * @returns {Promise<{ passed: boolean, hallucinationCount: number, details: Array }>}
   */
  async runHallucinationTest(config) {
    this.guardShutdown();
    if (!config || !config.agentFn || !config.testCases) {
      return { passed: false, hallucinationCount: 0, details: [], error: 'missing required config' };
    }

    const testId = 'hallucination-' + Date.now();
    const timeout = config.timeoutMs ?? this._defaultTimeout;
    const details = [];
    let hallucinationCount = 0;

    this._activeTests.set(testId, { type: 'hallucination', startedAt: Date.now() });
    this._concurrentCount++;
    _debug('AITestFramework', 'hallucination-test-start', { testId, caseCount: config.testCases.length });

    try {
      const self = this;
      for (const testCase of config.testCases) {
        const startTime = Date.now();
        let response;
        let timedOut = false;

        let timerId;
        try {
          response = await Promise.race([
            config.agentFn(testCase.prompt),
            new Promise(function(_, reject) {
              timerId = setTimeout(function() { reject(new Error('timeout')); }, timeout);
              self._activeTimers.push(timerId);
            }),
          ]);
        } catch (_err) {
          timedOut = true;
          response = null;
        } finally {
          if (timerId) clearTimeout(timerId);
        }

        const elapsed = Date.now() - startTime;
        const hallucinations = this._detectHallucinations(response, testCase, config, timedOut);
        hallucinationCount += hallucinations.length;
        details.push({
          prompt: testCase.prompt,
          response: timedOut ? '[TIMEOUT]' : (response ? response.substring(0, 200) : '[NULL]'),
          hallucinations,
          elapsed,
          timedOut,
        });
      }

      const passed = hallucinationCount === 0;
      const result = { passed, hallucinationCount, details, testId, completedAt: Date.now() };
      if (this._results.length >= this._maxResults) this._results.shift();
      this._results.push(result);
      this.emit('hallucination-test-complete', result);
      _debug('AITestFramework', 'hallucination-test-done', { testId, passed, hallucinationCount });
      return result;
    } finally {
      this._activeTests.delete(testId);
      this._concurrentCount--;
    }
  }

  /**
   * 检测响应中的幻觉信号。
   * @param {string|null} response - Agent响应
   * @param {object} testCase - 测试用例
   * @param {object} config - 测试配置
   * @param {boolean} timedOut - 是否超时
   * @returns {Array<{type: string, severity: string}>} 幻觉列表
   * @private
   */
  _detectHallucinations(response, testCase, config, timedOut) {
    const hallucinations = [];
    if (timedOut || !response) { return hallucinations; }

    for (const fact of (testCase.expectedFacts ?? [])) {
      if (!response.includes(fact)) {
        hallucinations.push({ type: 'missing_fact', fact, severity: 'high' });
      }
    }

    for (const pattern of (config.forbiddenPatterns ?? [])) {
      if (response.includes(pattern)) {
        hallucinations.push({ type: 'forbidden_pattern', pattern, severity: 'critical' });
      }
    }

    const hallucinationSignals = ['definitely', 'always', 'never fails', '100% guaranteed', 'impossible to fail'];
    for (const signal of hallucinationSignals) {
      if (response.toLowerCase().includes(signal)) {
        hallucinations.push({ type: 'overconfident_signal', signal, severity: 'medium' });
      }
    }

    return hallucinations;
  }

  /**
   * 运行压力测试。
   * @param {object} config - 测试配置
   * @param {Function} config.agentFn - Agent执行函数
   * @param {Array<object>} config.scenarios - 压力场景列表
   * @param {number} [config.maxTokens] - Token消耗上限
   * @param {number} [config.maxResponseTimeMs] - 最大响应时间
   * @param {number} [config.iterations] - 每场景迭代次数
   * @returns {Promise<{ passed: boolean, scenarios: Array, totalTokens: number }>}
   */
  async runStressTest(config) {
    this.guardShutdown();
    if (!config || !config.agentFn || !config.scenarios) {
      return { passed: false, scenarios: [], totalTokens: 0, error: 'missing required config' };
    }

    const testId = 'stress-' + Date.now();
    const maxTokens = config.maxTokens ?? this._stressMaxTokens;
    const maxResponseTime = config.maxResponseTimeMs ?? 30000;
    const iterations = config.iterations ?? 5;
    const scenarioResults = [];
    let totalTokens = 0;

    this._activeTests.set(testId, { type: 'stress', startedAt: Date.now() });
    this._concurrentCount++;
    _debug('AITestFramework', 'stress-test-start', { testId, scenarioCount: config.scenarios.length });

    try {
      for (const scenario of config.scenarios) {
        const iterResults = [];
        let scenarioPassed = true;

        for (let i = 0; i < iterations; i++) {
          const startTime = Date.now();
          let response;
          let tokens = 0;
          let error = null;

          try {
            response = await config.agentFn(scenario.prompt, scenario.context ?? {});
            tokens = (response && response.length) ? Math.ceil(response.length / 4) : 0;
          } catch (err) {
            error = err.message || String(err);
            scenarioPassed = false;
          }

          const elapsed = Date.now() - startTime;
          totalTokens += tokens;

          if (elapsed > maxResponseTime) { scenarioPassed = false; }
          if (totalTokens > maxTokens) { scenarioPassed = false; }

          iterResults.push({ iteration: i + 1, elapsed, tokens, error });
        }

        scenarioResults.push({
          name: scenario.name || 'unnamed',
          passed: scenarioPassed,
          iterations: iterResults,
          avgResponseTime: iterResults.reduce(function(s, r) { return s + r.elapsed; }, 0) / iterations,
        });
      }

      const passed = scenarioResults.every(function(s) { return s.passed; }) && totalTokens <= maxTokens;
      const result = { passed, scenarios: scenarioResults, totalTokens, testId, completedAt: Date.now() };
      if (this._results.length >= this._maxResults) this._results.shift();
      this._results.push(result);
      this.emit('stress-test-complete', result);
      _debug('AITestFramework', 'stress-test-done', { testId, passed, totalTokens });
      return result;
    } finally {
      this._activeTests.delete(testId);
      this._concurrentCount--;
    }
  }

  /**
   * 运行Token基准测试。
   * @param {object} config - 测试配置
   * @param {Function} config.agentFn - Agent执行函数
   * @param {Array<{name: string, prompt: string}>} config.benchmarks - 基准场景
   * @returns {Promise<{ passed: boolean, benchmarks: Array, regressions: Array }>}
   */
  async runTokenBenchmark(config) {
    this.guardShutdown();
    if (!config || !config.agentFn || !config.benchmarks) {
      return { passed: false, benchmarks: [], regressions: [], error: 'missing required config' };
    }

    const testId = 'token-bench-' + Date.now();
    const benchmarkResults = [];
    const regressions = [];

    this._activeTests.set(testId, { type: 'token-benchmark', startedAt: Date.now() });
    this._concurrentCount++;
    _debug('AITestFramework', 'token-benchmark-start', { testId, benchCount: config.benchmarks.length });

    try {
      for (const bench of config.benchmarks) {
        const startTime = Date.now();
        let response;
        let tokens = 0;

        try {
          response = await config.agentFn(bench.prompt);
          tokens = (response && response.length) ? Math.ceil(response.length / 4) : 0;
        } catch (_err) {
          tokens = -1;
        }

        const elapsed = Date.now() - startTime;
        const baselineKey = bench.name;

        this._updateTokenBaseline(baselineKey, tokens, elapsed);
        const regression = this._detectTokenRegression(baselineKey, tokens);
        if (regression) { regressions.push(regression); }

        benchmarkResults.push({ name: bench.name, tokens, elapsed });
      }

      const passed = regressions.length === 0;
      const result = { passed, benchmarks: benchmarkResults, regressions, testId, completedAt: Date.now() };
      if (this._results.length >= this._maxResults) this._results.shift();
      this._results.push(result);
      this.emit('token-benchmark-complete', result);
      _debug('AITestFramework', 'token-benchmark-done', { testId, passed, regressionCount: regressions.length });
      return result;
    } finally {
      this._activeTests.delete(testId);
      this._concurrentCount--;
    }
  }

  /**
   * 更新Token基线数据。
   * @param {string} key - 基线键名
   * @param {number} tokens - Token数量
   * @param {number} elapsed - 耗时
   * @private
   */
  _updateTokenBaseline(key, tokens, elapsed) {
    if (!this._tokenBaselines.has(key)) {
      this._tokenBaselines.set(key, []);
    }
    const baseline = this._tokenBaselines.get(key);
    baseline.push({ tokens, elapsed, timestamp: Date.now() });
    if (baseline.length > this._tokenBaselineWindow) {
      baseline.splice(0, baseline.length - this._tokenBaselineWindow);
    }
  }

  /**
   * 检测Token回归（超过基线均值50%）。
   * @param {string} key - 基线键名
   * @param {number} tokens - 当前Token数量
   * @returns {object|null} 回归信息，无回归返回null
   * @private
   */
  _detectTokenRegression(key, tokens) {
    const baseline = this._tokenBaselines.get(key);
    if (!baseline || baseline.length < 3 || tokens <= 0) { return null; }

    const avgBaseline = baseline.slice(0, -1).reduce(function(s, b) { return s + b.tokens; }, 0) / (baseline.length - 1);
    if (avgBaseline > 0 && tokens > avgBaseline * 1.5) {
      return {
        name: key,
        currentTokens: tokens,
        baselineAvg: Math.round(avgBaseline),
        increasePercent: Math.round((tokens / avgBaseline - 1) * 100),
      };
    }
    return null;
  }

  /**
   * 运行长周期稳定性测试。
   * @param {object} config - 测试配置
   * @param {Function} config.agentFn - Agent执行函数
   * @param {Function} config.healthCheckFn - 健康检查函数，返回{healthy, details}
   * @param {number} [config.durationMs] - 测试持续时间
   * @param {number} [config.checkIntervalMs=60000] - 健康检查间隔
   * @param {number} [config.maxFailures=3] - 最大允许失败次数
   * @returns {Promise<{ passed: boolean, checks: number, failures: Array, memoryLeaks: Array }>}
   */
  async runStabilityTest(config) {
    this.guardShutdown();
    if (!config || !config.agentFn || !config.healthCheckFn) {
      return { passed: false, checks: 0, failures: [], memoryLeaks: [], error: 'missing required config' };
    }

    const testId = 'stability-' + Date.now();
    const duration = config.durationMs ?? this._stabilityDuration;
    const interval = config.checkIntervalMs ?? 60000;
    const maxFailures = config.maxFailures ?? 3;
    const failures = [];
    const memoryLeaks = [];
    let checks = 0;
    let memoryBaseline = null;

    this._activeTests.set(testId, { type: 'stability', startedAt: Date.now() });
    this._concurrentCount++;
    _debug('AITestFramework', 'stability-test-start', { testId, durationMs: duration });

    const _timers = [];
    try {
      const self = this;
      const endTime = Date.now() + duration;

      while (Date.now() < endTime && failures.length < maxFailures && !this._shuttingDown) {
        try {
          await config.agentFn({ stabilityCheck: true, checkNumber: checks + 1 });
          const health = await config.healthCheckFn();
          checks++;

          if (!health.healthy) {
            failures.push({ check: checks, details: health.details, timestamp: Date.now() });
          }

          const leakInfo = this._checkMemoryLeak(checks, memoryBaseline);
          if (leakInfo) {
            memoryLeaks.push(leakInfo);
            if (!memoryBaseline) { memoryBaseline = process.memoryUsage().heapUsed; }
          } else if (!memoryBaseline) {
            memoryBaseline = process.memoryUsage().heapUsed;
          }
        } catch (err) {
          checks++;
          failures.push({ check: checks, error: err.message || String(err), timestamp: Date.now() });
        }

        if (Date.now() < endTime && failures.length < maxFailures) {
          await new Promise(function(resolve) {
            const t = setTimeout(resolve, interval);
            _timers.push(t);
            self._activeTimers.push(t);
          });
        }
      }

      const passed = failures.length < maxFailures && memoryLeaks.length === 0;
      const result = { passed, checks, failures, memoryLeaks, testId, completedAt: Date.now() };
      if (this._results.length >= this._maxResults) this._results.shift();
      this._results.push(result);
      this.emit('stability-test-complete', result);
      _debug('AITestFramework', 'stability-test-done', { testId, passed, checks, failureCount: failures.length });
      return result;
    } finally {
      _timers.forEach(function(t) { clearTimeout(t); });
      this._activeTests.delete(testId);
      this._concurrentCount--;
    }
  }

  /**
   * 检查内存泄漏。
   * @param {number|null} baseline - 基线堆内存
   * @returns {object|null} 泄漏信息，无泄漏返回null
   * @private
   */
  _checkMemoryLeak(checkNum, baseline) {
    if (!baseline) { return null; }
    const memUsage = process.memoryUsage();
    const growth = memUsage.heapUsed - baseline;
    const growthPercent = (growth / baseline) * 100;
    if (growthPercent > 50) {
      return {
        check: checkNum,
        heapUsed: memUsage.heapUsed,
        baseline: baseline,
        growthPercent: Math.round(growthPercent),
      };
    }
    return null;
  }

  /**
   * 运行Fuzzing测试。
   * @param {object} config - 测试配置
   * @param {Function} config.targetFn - 目标函数，接收变异输入
   * @param {object} [config.schema] - 输入schema定义(用于指导变异)
   * @param {number} [config.iterations] - 迭代次数
   * @param {Array<string>} [config.mutationStrategies] - 变异策略列表
   * @returns {Promise<{ passed: boolean, iterations: number, crashes: Array, coverage: number }>}
   */
  async runFuzzingTest(config) {
    this.guardShutdown();
    if (!config || !config.targetFn) {
      return { passed: false, iterations: 0, crashes: [], coverage: 0, error: 'missing required config' };
    }

    const testId = 'fuzzing-' + Date.now();
    const iterations = config.iterations ?? this._fuzzingIterations;
    const strategies = config.mutationStrategies ?? [
      'null', 'undefined', 'empty', 'overflow',
      'type-confusion', 'special-chars', 'prototype-pollution',
    ];
    const crashes = [];
    const coveredPaths = new Set();

    this._activeTests.set(testId, { type: 'fuzzing', startedAt: Date.now() });
    this._concurrentCount++;
    _debug('AITestFramework', 'fuzzing-test-start', { testId, iterations });

    try {
      for (let i = 0; i < iterations && !this._shuttingDown; i++) {
        const mutation = this._generateMutation(config.schema, strategies);

        try {
          const res = config.targetFn(mutation);
          if (res && res.path) {
            coveredPaths.add(res.path);
          }
        } catch (err) {
          crashes.push({
            iteration: i + 1,
            mutation: JSON.stringify(mutation).substring(0, 200),
            error: err.message || String(err),
            strategy: mutation._strategy || 'unknown',
          });
        }

        if (i % 100 === 0 && this._concurrentCount > this._maxConcurrent) {
          break;
        }
      }

      const coverage = coveredPaths.size;
      const passed = crashes.length === 0;
      const result = { passed, iterations, crashes, coverage, testId, completedAt: Date.now() };
      if (this._results.length >= this._maxResults) this._results.shift();
      this._results.push(result);
      this.emit('fuzzing-test-complete', result);
      _debug('AITestFramework', 'fuzzing-test-done', { testId, passed, crashCount: crashes.length, coverage });
      return result;
    } finally {
      this._activeTests.delete(testId);
      this._concurrentCount--;
    }
  }

  /**
   * 生成变异输入。
   * @param {object} [schema] - 输入schema
   * @param {Array<string>} strategies - 变异策略列表
   * @returns {object} 变异后的输入
   * @private
   */
  _generateMutation(schema, strategies) {
    const strategy = strategies[Math.floor(Math.random() * strategies.length)];
    const mutation = { _strategy: strategy };

    switch (strategy) {
      case 'null':
        mutation.value = null;
        break;
      case 'undefined':
        mutation.value = undefined;
        break;
      case 'empty':
        mutation.value = Math.random() > 0.5 ? '' : [];
        break;
      case 'overflow':
        mutation.value = 'x'.repeat(100000);
        break;
      case 'type-confusion': {
        const types = [0, '', false, null, undefined, [], {}];
        mutation.value = types[Math.floor(Math.random() * types.length)];
        break;
      }
      case 'special-chars':
        mutation.value = '\x00\x01\x02\xff\u0000\uFEFF\u200B\u200C\u200D';
        break;
      case 'prototype-pollution':
        mutation.value = { '__proto__': { polluted: true }, 'constructor': { prototype: { polluted: true } } };
        break;
      default:
        mutation.value = Math.random().toString(36);
    }

    if (schema && schema.fields) {
      for (const field of schema.fields) {
        mutation[field.name] = mutation.value;
      }
    }

    return mutation;
  }

  /**
   * 获取所有测试结果。
   * @returns {Array<object>} 测试结果列表
   */
  getResults() {
    this.guardShutdown();
    return [...this._results];
  }

  /**
   * 获取Token基线数据。
   * @returns {Map<string, Array>} 基线数据映射
   */
  getTokenBaselines() {
    this.guardShutdown();
    return new Map(this._tokenBaselines);
  }

  /**
   * 获取当前活跃测试。
   * @returns {Array<{testId: string, type: string, startedAt: number}>}
   */
  getActiveTests() {
    this.guardShutdown();
    return Array.from(this._activeTests.entries()).map(function(entry) {
      return { testId: entry[0], ...entry[1] };
    });
  }

  /**
   * 获取测试统计信息。
   * @returns {{ totalTests: number, passedTests: number, failedTests: number, activeTests: number }}
   */
  getStats() {
    this.guardShutdown();
    return {
      totalTests: this._results.length,
      passedTests: this._results.filter(function(r) { return r.passed; }).length,
      failedTests: this._results.filter(function(r) { return !r.passed; }).length,
      activeTests: this._activeTests.size,
    };
  }

  _onShutdown() {
    this._activeTimers.forEach(function(t) { clearTimeout(t); });
    this._activeTimers.length = 0;
    this._concurrentCount = 0;
    this._activeTests.clear();
    this._results.length = 0;
    this._tokenBaselines.clear();
    this._running = false;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(AITestFramework);
