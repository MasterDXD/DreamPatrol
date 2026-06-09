'use strict';

/**
 * @module runtime/quality/agent-golden-test
 * @classdesc Agent黄金数据回归测试（AgentGoldenTest）—— 通过注册黄金用例并比对实际输出，
 * 检测Agent行为回归。支持精确匹配、数值容差、字符串相似度（编辑距离）和嵌套递归比较四种比对模式。
 * 当输出与黄金数据不匹配时自动触发regression-detected事件。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug: _debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');

const MAX_CASES = 200;
const MAX_HISTORY = 500;

class AgentGoldenTest extends EventEmitter {
  /**
   * 创建AgentGoldenTest实例。
   * @param {Object} [options] - 配置选项（当前保留，预留扩展）
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._cases = new BoundedMap(MAX_CASES);
    this._history = new BoundedArray(MAX_HISTORY);
    this._stats = {
      casesRegistered: 0,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      regressionsDetected: 0,
    };
  }

  /**
   * 注册黄金测试用例。
   * @param {string} agentId - Agent标识
   * @param {Object} testCase - 测试用例定义
   * @param {string} testCase.id - 用例唯一标识
   * @param {string} [testCase.description] - 用例描述
   * @param {Object} [testCase.input] - 输入数据
   * @param {Object} testCase.expectedOutput - 期望输出（黄金数据）
   * @param {number} [testCase.tolerance=0] - 数值比较容差
   * @param {string} [testCase.category='general'] - 用例分类
   * @returns {Object|null} 注册成功的用例条目，参数无效时返回null
   */
  registerCase(agentId, testCase) {
    this.guardShutdown();
    if (!agentId || !testCase || !testCase.id || typeof testCase.expectedOutput !== 'object') {
      return null;
    }
    const key = agentId + ':' + testCase.id;
    const entry = {
      agentId,
      id: testCase.id,
      description: testCase.description || '',
      input: testCase.input ?? {},
      expectedOutput: testCase.expectedOutput,
      tolerance: testCase.tolerance ?? 0,
      category: testCase.category || 'general',
      registeredAt: Date.now(),
    };
    this._cases.set(key, entry);
    this._stats.casesRegistered++;
    this.emit('case-registered', { agentId, caseId: testCase.id });
    return entry;
  }

  /**
   * 批量注册黄金测试用例。
   * @param {string} agentId - Agent标识
   * @param {Array<Object>} testCases - 测试用例数组
   * @returns {Array<Object>} 成功注册的用例数组
   */
  registerCases(agentId, testCases) {
    if (!Array.isArray(testCases)) return [];
    return testCases.map(tc => this.registerCase(agentId, tc)).filter(Boolean);
  }

  /**
   * 移除黄金测试用例。
   * @param {string} agentId - Agent标识
   * @param {string} caseId - 用例标识
   * @returns {boolean} 是否成功移除
   */
  removeCase(agentId, caseId) {
    this.guardShutdown();
    const key = agentId + ':' + caseId;
    return this._cases.delete(key);
  }

  /**
   * 获取已注册的黄金测试用例，可按Agent过滤
   * @param {string} [agentId] - Agent标识，不传则返回所有用例
   * @returns {Array<{key: string, agentId: string, id: string, description: string, input: Object, expectedOutput: Object, tolerance: number, category: string, registeredAt: number}>} 匹配的测试用例数组
   */
  getCases(agentId) {
    const result = [];
    for (const [key, val] of this._cases) {
      if (!agentId || val.agentId === agentId) {
        result.push({ key, ...val });
      }
    }
    return result;
  }

  /**
   * 运行单个黄金测试用例，比对实际输出与期望输出。
   * @param {string} agentId - Agent标识
   * @param {string} caseId - 用例标识
   * @param {Object} actualOutput - 实际输出数据
   * @returns {{agentId: string, caseId: string, passed: boolean, mismatches: Array, matchRate: number, timestamp: number}} 测试结果
   */
  runTest(agentId, caseId, actualOutput) {
    this.guardShutdown();
    const key = agentId + ':' + caseId;
    const testCase = this._cases.get(key);
    if (!testCase) {
      return { passed: false, error: 'Test case not found', agentId, caseId };
    }
    const comparison = this._compareOutputs(testCase.expectedOutput, actualOutput, testCase.tolerance);
    const result = {
      agentId,
      caseId,
      passed: comparison.passed,
      mismatches: comparison.mismatches,
      matchRate: comparison.matchRate,
      timestamp: Date.now(),
    };
    this._history.push(result);
    this._stats.testsRun++;
    if (result.passed) {
      this._stats.testsPassed++;
    } else {
      this._stats.testsFailed++;
      this._stats.regressionsDetected++;
      this.emit('regression-detected', result);
    }
    this.emit('test-completed', result);
    return result;
  }

  /**
   * 运行指定Agent的所有黄金测试用例。
   * @param {string} agentId - Agent标识
   * @param {Function} outputProvider - 输出提供函数，签名：(agentId, caseId, input) => Object
   * @returns {Array<Object>} 所有测试结果数组
   */
  runAllTests(agentId, outputProvider) {
    this.guardShutdown();
    const cases = this.getCases(agentId);
    const results = [];
    for (const tc of cases) {
      let actualOutput;
      if (typeof outputProvider === 'function') {
        try {
          actualOutput = outputProvider(tc.agentId, tc.id, tc.input);
        } catch (_e) {
          _debug('AgentGoldenTest', 'outputProviderFailed', _e && _e.message ? _e.message : String(_e));
          actualOutput = null;
        }
      }
      const result = this.runTest(tc.agentId, tc.id, actualOutput);
      results.push(result);
    }
    return results;
  }

  _compareOutputs(expected, actual, tolerance) {
    if (!expected || !actual) {
      return { passed: false, mismatches: [{ path: 'root', expected: 'object', actual: typeof actual }], matchRate: 0 };
    }
    const mismatches = [];
    let totalFields = 0;
    let matchedFields = 0;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      totalFields++;
      const expVal = expected[key];
      const actVal = actual[key];
      const cmp = this._compareField(key, expVal, actVal, tolerance);
      if (cmp.matched) {
        matchedFields++;
      } else {
        mismatches.push(...cmp.mismatches);
      }
      if (cmp.extraFields > 0) {
        totalFields += cmp.extraFields;
        matchedFields += cmp.extraMatched;
      }
    }
    const matchRate = totalFields > 0 ? matchedFields / totalFields : 0;
    return {
      passed: mismatches.length === 0 && matchRate >= 0.95,
      mismatches,
      matchRate: Math.round(matchRate * 1000) / 1000,
    };
  }

  _compareField(key, expVal, actVal, tolerance) {
    if (expVal === actVal) {
      return { matched: true, mismatches: [], extraFields: 0, extraMatched: 0 };
    }
    if (typeof expVal === 'number' && Number.isFinite(expVal) && typeof actVal === 'number' && Number.isFinite(actVal)) {
      const diff = Math.abs(expVal - actVal);
      const maxDiff = typeof tolerance === 'number' && Number.isFinite(tolerance) ? tolerance : Math.max(Math.abs(expVal) * 0.05, 1e-10);
      if (diff <= maxDiff) {
        return { matched: true, mismatches: [], extraFields: 0, extraMatched: 0 };
      }
      return { matched: false, mismatches: [{ path: key, expected: expVal, actual: actVal, diff }], extraFields: 0, extraMatched: 0 };
    }
    if (typeof expVal === 'string' && typeof actVal === 'string') {
      const similarity = this._stringSimilarity(expVal, actVal);
      if (similarity >= 0.8) {
        return { matched: true, mismatches: [], extraFields: 0, extraMatched: 0 };
      }
      return { matched: false, mismatches: [{ path: key, expected: expVal, actual: actVal, similarity }], extraFields: 0, extraMatched: 0 };
    }
    if (expVal && typeof expVal === 'object' && actVal && typeof actVal === 'object') {
      if (Array.isArray(expVal) !== Array.isArray(actVal)) {
        return { matched: false, mismatches: [{ path: key, expected: expVal, actual: actVal, reason: 'type_mismatch' }], extraFields: 0, extraMatched: 0 };
      }
      const nested = this._compareOutputs(expVal, actVal, tolerance);
      const keyCount = Object.keys(expVal).length;
      const extraFields = Math.max(0, keyCount - 1);
      const extraMatched = nested.matchRate * keyCount;
      return { matched: nested.passed, mismatches: nested.passed ? [] : nested.mismatches.map(function(m) { return Object.assign({ path: key + '.' + m.path }, m); }), extraFields, extraMatched };
    }
    return { matched: false, mismatches: [{ path: key, expected: expVal, actual: actVal }], extraFields: 0, extraMatched: 0 };
  }

  _stringSimilarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    const editDist = this._editDistance(longer, shorter);
    return (longer.length - editDist) / longer.length;
  }

  _editDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
        }
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * 获取回归检测结果（仅失败的测试）。
   * @param {string} [agentId] - 可选，按Agent过滤
   * @returns {Array<Object>} 回归结果数组
   */
  getRegressions(agentId) {
    const result = [];
    for (const entry of this._history.toArray()) {
      if (!entry.passed && (!agentId || entry.agentId === agentId)) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * 获取测试历史记录。
   * @param {string} [agentId] - 可选，按Agent过滤
   * @param {number} [limit] - 可选，限制返回条目数
   * @returns {Array<Object>} 历史记录数组
   */
  getHistory(agentId, limit) {
    const entries = this._history.toArray();
    const filtered = agentId ? entries.filter(e => e.agentId === agentId) : entries;
    return limit ? filtered.slice(-limit) : filtered;
  }

  /**
   * 获取统计信息。
   * @returns {{casesRegistered: number, testsRun: number, testsPassed: number, testsFailed: number, regressionsDetected: number, totalCases: number, passRate: number}} 统计数据
   */
  getStats() {
    return {
      ...this._stats,
      totalCases: this._cases.size,
      passRate: this._stats.testsRun > 0 ? Math.round(this._stats.testsPassed / this._stats.testsRun * 1000) / 1000 : 0,
    };
  }

  _onShutdown() {
    safeCall(() => this._cases.shutdown(), 'AgentGoldenTest', 'shutdown-cases');
    safeCall(() => this._history.shutdown(), 'AgentGoldenTest', 'shutdown-history');
    this.removeAllListeners();
  }
}

AgentGoldenTest.MAX_CASES = MAX_CASES;
AgentGoldenTest.MAX_HISTORY = MAX_HISTORY;

module.exports = withShutdown(AgentGoldenTest);
