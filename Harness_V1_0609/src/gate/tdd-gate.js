'use strict';

/**
 * TDD强制门禁。检测RED-GREEN-REFACTOR循环，验证测试覆盖率，强制测试优先原则。
 * 核心规则：实现文件必须先有对应的测试文件，否则视为违规。
 *
 * @module gate/tdd-gate
 * @example
 * const gate = new TDDGate();
 * const result = gate.check({ implFile: 'foo.js', testFile: 'foo.test.js', testExists: true, implExists: false, testResult: 'fail' });
 * // { passed: true, phase: 'RED', reason: 'Test fails as expected (RED phase)' }
 */

const { EventEmitter } = require('events');
const { TDDGateError } = require('../errors');
const { sanitizeFilePath } = require('../utils/sanitizer');
const { DEFAULT_COVERAGE_THRESHOLD } = require('../utils/constants');
const { withShutdown } = require('../utils/shutdown-mixin');

/**
 * @classdesc TDD强制门禁。RED-GREEN-REFACTOR检测、覆盖率验证
 * TDD门禁执行器。检查测试-实现的RED-GREEN-REFACTOR循环合规性。
 */
class TDDGate extends EventEmitter {
  /**
   * 创建TDDGate实例。
   */
  constructor() {
    super();
  }

  /**
   * 标准化测试结果为统一格式。
   * @param {string|object|null|undefined} testResult - 原始测试结果，可以是'fail'/'pass'字符串、包含failed/passed计数的对象、或null/undefined。注意：testResult.failed 和 testResult.passed 可能为 NaN，此时视为0
   * @returns {'fail'|'pass'|'unknown'|null} 标准化后的测试结果
   */
  _normalizeTestResult(testResult) {
    if (testResult === 'fail' || testResult === 'pass') return testResult;
    if (testResult == null) return null;
    if (typeof testResult === 'object' && testResult !== null) {
      const failed = testResult.failed ?? 0;
      const passed = testResult.passed ?? 0;
      if (failed > 0) return 'fail';
      if (passed > 0 && failed === 0) return 'pass';
    }
    return 'unknown';
  }

  /**
   * 解析仅测试文件存在时的TDD阶段。
   * @param {'fail'|'pass'|'unknown'|null} normalized - 标准化后的测试结果
   * @returns {{passed: boolean, phase: string, reason: string}} TDD检查结果
   */
  _resolveTestOnlyPhase(normalized) {
    if (normalized === 'fail') return { passed: true, phase: 'RED', reason: 'Test fails as expected (RED phase)' };
    if (normalized === 'pass') return { passed: true, phase: 'RED', reason: 'Test written, awaiting implementation (test already passes)' };
    if (normalized === null) return { passed: false, phase: 'UNKNOWN', reason: 'Test exists but has not been run', suggestion: '请先运行测试以确定当前TDD阶段。' };
    return { passed: true, phase: 'RED', reason: 'Test written, awaiting implementation' };
  }

  /**
   * 解析测试和实现文件同时存在时的TDD阶段。
   * @param {'fail'|'pass'|'unknown'|null} normalized - 标准化后的测试结果
   * @returns {{passed: boolean, phase: string, reason: string}} TDD检查结果
   */
  _resolveBothExistPhase(normalized) {
    if (normalized === 'pass') return { passed: true, phase: 'GREEN', reason: 'Test passes (GREEN phase)' };
    if (normalized === 'fail') return { passed: false, phase: 'RED', reason: 'Implementation exists but test still fails', suggestion: '测试失败是RED阶段的正常状态。请编写最小实现使测试通过。' };
    if (normalized === null) return { passed: false, phase: 'UNKNOWN', reason: 'Implementation and test exist but test result is unknown — run tests first', suggestion: '请先运行测试以确定当前TDD阶段。' };
    return { passed: false, phase: 'ERROR', reason: 'Unexpected test result' };
  }

  /**
   * 检查TDD合规性。根据测试文件和实现文件的存在状态及测试结果，判断当前处于RED-GREEN-REFACTOR的哪个阶段。
   * @param {object} context - 检查上下文
   * @param {string} context.implFile - 实现文件路径
   * @param {string} context.testFile - 测试文件路径
   * @param {boolean} context.testExists - 测试文件是否存在
   * @param {boolean} context.implExists - 实现文件是否存在
   * @param {string|object} [context.testResult] - 测试执行结果
   * @param {boolean} [context.codeChanged=false] - 代码是否已变更（REFACTOR阶段检测）
   * @returns {{passed: boolean, phase: string, reason: string}} TDD检查结果，包含是否通过、当前阶段和原因说明
   * @throws {Error} When implFile or testFile paths are invalid
   */
  check(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return { passed: false, reason: 'TDD check: invalid context', phase: 'ERROR' };
    }
    const { implFile, testFile, testExists, implExists, testResult } = context;
    const safeImplFile = sanitizeFilePath(implFile);
    const safeTestFile = sanitizeFilePath(testFile);

    if (!testExists && implExists) {
      return {
        passed: false,
        reason: `TDD violation: implementation ${safeImplFile} exists without test ${safeTestFile}. Write test first.`,
        phase: 'VIOLATION',
        suggestion: '请先创建测试文件，再编写实现代码。TDD要求测试先行。',
      };
    }

    if (testExists && !implExists) {
      return this._resolveTestOnlyPhase(this._normalizeTestResult(testResult));
    }

    if (testExists && implExists) {
      const normalized = this._normalizeTestResult(testResult);
      if (normalized === 'pass') {
        if (context.codeChanged === true) {
          return { phase: 'REFACTOR', passed: true, reason: 'Tests passing after refactoring' };
        }
        return { phase: 'GREEN', passed: true, reason: 'Tests passing, implementation complete' };
      }
      return this._resolveBothExistPhase(normalized);
    }

    return { passed: true, phase: 'EMPTY', reason: 'No files exist yet' };
  }

  /**
   * 检查测试覆盖率是否达到阈值。
   * @param {object} context - 覆盖率检查上下文
   * @param {number} context.coverage - 当前覆盖率（0-100）
   * @param {number} [context.threshold] - 覆盖率阈值（0-100），默认使用DEFAULT_COVERAGE_THRESHOLD
   * @returns {{passed: boolean, reason: string, coverage: number|null, threshold: number}} 覆盖率检查结果
   */
  checkCoverage(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') {
      return { passed: false, reason: 'Invalid context', coverage: 0, threshold: DEFAULT_COVERAGE_THRESHOLD };
    }
    const coverage = typeof context.coverage === 'number' ? context.coverage : null;
    const rawThreshold = typeof context.threshold === 'number' ? context.threshold : DEFAULT_COVERAGE_THRESHOLD;
    const threshold = (rawThreshold > 0 && rawThreshold <= 1) ? Math.round(rawThreshold * 100) : rawThreshold;

    if (coverage == null || !Number.isFinite(coverage) || !Number.isFinite(threshold)) {
      return { passed: false, reason: 'Invalid coverage or threshold value', coverage: null, threshold, suggestion: '覆盖率数据无效。请确保测试运行成功并生成了覆盖率报告。' };
    }

    if (coverage < 0 || coverage > 100) {
      return { passed: false, reason: 'Coverage out of range (0-100)', coverage, threshold };
    }

    if (threshold < 0 || threshold > 100) {
      return { passed: false, reason: 'Threshold out of range (0-100)', coverage, threshold };
    }

    if (coverage < threshold) {
      return {
        passed: false,
        reason: `Coverage ${coverage}% is below threshold ${threshold}%`,
        coverage,
        threshold,
        suggestion: '覆盖率不足。请为未覆盖的代码添加测试用例。',
      };
    }
    return { passed: true, coverage, threshold };
  }

  /**
   * 强制执行TDD检查，不通过时抛出TDDGateError异常。
   * @param {object} context - 检查上下文，同check方法
   * @returns {{passed: boolean, phase: string, reason: string}} TDD检查结果
   * @throws {TDDGateError} 当TDD检查不通过时抛出，包含错误码和原因
   */
  enforceCheck(context) {
    this.guardShutdown();
    const result = this.check(context);
    if (!result.passed) {
      const code = result.phase === 'VIOLATION'
        ? 'NO_TEST_FIRST'
        : result.phase === 'EMPTY'
          ? 'NO_FILES_EXIST'
          : 'INVALID_CYCLE_ORDER';
      throw new TDDGateError(code, result.reason);
    }
    return result;
  }

  /**
   * 强制执行覆盖率检查，不通过时抛出TDDGateError异常。
   * @param {object} context - 覆盖率检查上下文，同checkCoverage方法
   * @returns {{passed: boolean, coverage: number, threshold: number}} 覆盖率检查结果
   * @throws {TDDGateError} 当覆盖率低于阈值时抛出COVERAGE_BELOW_THRESHOLD错误
   */
  enforceCoverage(context) {
    this.guardShutdown();
    const result = this.checkCoverage(context);
    if (!result.passed) {
      let code;
      if (result.coverage == null) {
        code = 'INVALID_COVERAGE_VALUE';
      } else if (result.coverage < 0 || result.coverage > 100) {
        code = 'COVERAGE_OUT_OF_RANGE';
      } else {
        code = 'COVERAGE_BELOW_THRESHOLD';
      }
      throw new TDDGateError(code, result.reason);
    }
    return result;
  }

  /**
   * 关闭时清理资源。
   */
  _onShutdown() {
    this.removeAllListeners();
  }
}

module.exports = withShutdown(TDDGate);
