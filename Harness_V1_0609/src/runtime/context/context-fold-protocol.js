'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const FOLD_STRATEGIES = {
  CONCLUSION_ONLY: 'conclusion-only',
  STRUCTURED_SUMMARY: 'structured-summary',
  KEY_DECISIONS: 'key-decisions',
};

const DEFAULT_OPTIONS = {
  maxArchiveSize: 500,
  maxFoldHistorySize: 1000,
  defaultStrategy: FOLD_STRATEGIES.STRUCTURED_SUMMARY,
  conclusionMaxLength: 500,
  summaryMaxSteps: 10,
  keyDecisionsMaxCount: 5,
};

/**
 * 上下文折叠协议模块 - 在主Agent向SubAgent传递上下文时，按"最近相关+核心规则"筛选并压缩，
 * 避免长文本导致中间遗忘，从而提升多Agent协作的推理质量与token利用效率。
 *
 * 概念来源: 融合自Meridian AI Worker编排系统的"上下文瘦身策略"概念。
 *
 * 核心洞察: SkillOS的"输入层指令模板+上下文瘦身"原则 - 主Agent给SubAgent传上下文时，
 * 按"最近相关+核心规则"筛选，避免长文本导致中间遗忘。
 *
 * 融合映射:
 * - Meridian的"瘦身策略" -> 本模块的fold方法，按策略压缩子任务结果
 * - SkillOS的"输入层指令模板" -> 三种折叠策略(conclusion-only / structured-summary / key-decisions)
 * - Meridian的"归档恢复" -> unfold方法，从归档中恢复原始数据
 * - SkillOS的"核心规则保留" -> key-decisions策略，仅保留关键决策与理由
 *
 * 模块职责:
 * - 提供多种折叠策略，将子任务结果压缩为精简形式
 * - 归档原始数据，支持按需展开恢复
 * - 跟踪折叠统计信息，包括节省的token数和各策略使用频次
 * - 通过BoundedMap和BoundedArray限制归档与历史记录的内存占用
 *
 * @module runtime/context/context-fold-protocol
 * @classdesc 上下文折叠协议 - 核心原则: (1) 按策略压缩，保留最近相关与核心规则;
 * (2) 归档原始数据，支持按需展开; (3) 有界存储，防止内存泄漏;
 * (4) 统计追踪，量化折叠效果
 */
class ContextFoldProtocol {
  /**
   * 创建上下文折叠协议实例
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxArchiveSize=500] - 归档映射的最大条目数，超出后自动淘汰最旧条目
   * @param {number} [options.maxFoldHistorySize=1000] - 折叠历史记录的最大条目数，超出后自动淘汰最旧记录
   * @param {string} [options.defaultStrategy='structured-summary'] - 默认折叠策略，可选值: 'conclusion-only', 'structured-summary', 'key-decisions'
   * @param {number} [options.conclusionMaxLength=500] - conclusion-only策略下结论文本的最大字符数
   * @param {number} [options.summaryMaxSteps=10] - structured-summary策略下保留的最大步骤数
   * @param {number} [options.keyDecisionsMaxCount=5] - key-decisions策略下保留的最大决策数
   */
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._archive = new BoundedMap(this._options.maxArchiveSize);
    this._foldHistory = new BoundedArray(this._options.maxFoldHistorySize);
    this._stats = { totalFolds: 0, tokensSaved: 0, byStrategy: {} };
  }

  /**
   * 折叠子任务结果，按指定策略压缩上下文并归档原始数据
   * @param {Object|string} subtaskResult - 子任务执行结果
   * @param {string} [strategy] - 折叠策略（'conclusion-only'|'structured-summary'|'key-decisions'），默认使用配置中的默认策略
   * @returns {{folded: *, strategy: string, tokensSaved: number, archiveId: string|null}} 折叠结果
   */
  fold(subtaskResult, strategy) {
    const effectiveStrategy = strategy ?? this._options.defaultStrategy;
    if (!Object.values(FOLD_STRATEGIES).includes(effectiveStrategy)) {
      return { folded: subtaskResult, strategy: effectiveStrategy, tokensSaved: 0, archiveId: null };
    }
    const originalSize = this._estimateTokenCount(subtaskResult);
    const archiveId = this._generateArchiveId();
    this._archive.set(archiveId, subtaskResult);
    let folded;
    switch (effectiveStrategy) {
      case FOLD_STRATEGIES.CONCLUSION_ONLY:
        folded = this._foldConclusionOnly(subtaskResult);
        break;
      case FOLD_STRATEGIES.STRUCTURED_SUMMARY:
        folded = this._foldStructuredSummary(subtaskResult);
        break;
      case FOLD_STRATEGIES.KEY_DECISIONS:
        folded = this._foldKeyDecisions(subtaskResult);
        break;
      default:
        folded = subtaskResult;
    }
    const foldedSize = this._estimateTokenCount(folded);
    const tokensSaved = Math.max(0, originalSize - foldedSize);
    const record = { archiveId, strategy: effectiveStrategy, originalSize, foldedSize, tokensSaved, timestamp: Date.now() };
    this._foldHistory.push(record);
    this._stats.totalFolds++;
    this._stats.tokensSaved += tokensSaved;
    this._stats.byStrategy[effectiveStrategy] = (this._stats.byStrategy[effectiveStrategy] ?? 0) + 1;
    return { folded, strategy: effectiveStrategy, tokensSaved, archiveId };
  }

  /**
   * 展开已折叠的子任务结果，从归档中恢复原始数据
   * @param {string} archiveId - 归档ID，由fold方法返回
   * @returns {Object|string|null} 原始子任务结果，归档ID不存在时返回null
   */
  unfold(archiveId) {
    return this._archive.get(archiveId) ?? null;
  }

  _foldConclusionOnly(result) {
    if (typeof result === 'string') {
      return result.length > this._options.conclusionMaxLength
        ? result.substring(0, this._options.conclusionMaxLength) + '...'
        : result;
    }
    if (result && typeof result === 'object') {
      const conclusion = result.conclusion ?? result.summary ?? result.output ?? result.result;
      if (conclusion != null) {
        const str = String(conclusion);
        return str.length > this._options.conclusionMaxLength
          ? str.substring(0, this._options.conclusionMaxLength) + '...'
          : str;
      }
      const keys = Object.keys(result);
      if (keys.length <= 3) return result;
      const folded = {};
      for (const key of ['conclusion', 'summary', 'output', 'result', 'answer', 'decision']) {
        if (result[key] != null) folded[key] = result[key];
      }
      if (Object.keys(folded).length === 0) {
        let serialized;
        try { serialized = JSON.stringify(result); } catch (_e) { debug('ContextFoldProtocol', 'foldConclusionOnly:serialize', _e && _e.message ? _e.message : String(_e)); serialized = String(result); }
        folded.summary = serialized.substring(0, this._options.conclusionMaxLength);
      }
      return folded;
    }
    return result;
  }

  _foldStructuredSummary(result) {
    if (typeof result === 'string') {
      return { summary: result.substring(0, this._options.conclusionMaxLength), type: 'text' };
    }
    if (result && typeof result === 'object') {
      const folded = { type: 'structured-summary' };
      if (result.conclusion != null) folded.conclusion = result.conclusion;
      else if (result.summary != null) folded.conclusion = result.summary;
      else if (result.output != null) folded.conclusion = String(result.output).substring(0, this._options.conclusionMaxLength);
      if (result.steps && Array.isArray(result.steps)) {
        folded.steps = result.steps.slice(0, this._options.summaryMaxSteps).map(function(step) {
          if (typeof step === 'string') return step;
          return step.summary ?? step.description ?? step.name ?? String(step);
        });
      }
      if (result.decisions && Array.isArray(result.decisions)) {
        folded.decisions = result.decisions.slice(0, this._options.keyDecisionsMaxCount);
      }
      if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
        folded.errors = result.errors.slice(0, 3).map(function(e) { return e.message ?? String(e); });
      }
      if (result.metrics && typeof result.metrics === 'object') {
        folded.metrics = result.metrics;
      }
      return folded;
    }
    return result;
  }

  _foldKeyDecisions(result) {
    if (typeof result === 'string') {
      return { decisions: [result.substring(0, this._options.conclusionMaxLength)], type: 'key-decisions' };
    }
    if (result && typeof result === 'object') {
      const folded = { type: 'key-decisions' };
      if (result.decisions && Array.isArray(result.decisions)) {
        folded.decisions = result.decisions.slice(0, this._options.keyDecisionsMaxCount);
      } else {
        const decisions = [];
        if (result.conclusion != null) decisions.push(result.conclusion);
        if (result.choice != null) decisions.push(result.choice);
        if (result.action != null) decisions.push(result.action);
        folded.decisions = decisions.slice(0, this._options.keyDecisionsMaxCount);
      }
      if (result.rationale != null) folded.rationale = result.rationale;
      if (result.alternatives != null) folded.alternatives = result.alternatives;
      return folded;
    }
    return result;
  }

  _estimateTokenCount(data) {
    let text;
    try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch (_e) { debug('ContextFoldProtocol', 'estimateTokenCount', _e && _e.message ? _e.message : String(_e)); text = String(data); }
    return Math.ceil(text.length / 4);
  }

  _generateArchiveId() {
    return 'fold-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  }

  /**
   * 获取折叠协议的统计信息
   * @returns {{totalFolds: number, tokensSaved: number, byStrategy: Object, archiveSize: number, foldHistorySize: number}} 统计信息
   */
  getStats() {
    return {
      totalFolds: this._stats.totalFolds,
      tokensSaved: this._stats.tokensSaved,
      byStrategy: Object.assign({}, this._stats.byStrategy),
      archiveSize: this._archive.size,
      foldHistorySize: this._foldHistory.length,
    };
  }

  _onShutdown() {
    this._archive.shutdown();
    this._foldHistory.shutdown();
  }
}

module.exports = withShutdown(ContextFoldProtocol);
module.exports.FOLD_STRATEGIES = FOLD_STRATEGIES;
