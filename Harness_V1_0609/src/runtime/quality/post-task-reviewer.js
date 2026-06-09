'use strict';
/**
 * @module runtime/quality/post-task-reviewer
 * @classdesc 任务后自动审查钩子（PostTaskReviewer）—— 任务完成后自动触发审查流水线。
 * 依次执行：SelfReflection自反思→AutoReinLearningLoop规则生成→MemoryPipeline记忆存储→DreamBridge梦境桥接。
 * 当发现显著结果（规则生成数+错误数≥阈值）时自动触发DreamBridge，实现"反思→学习→记忆→梦境"闭环。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeExecuteAsync, safeCall } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');
const { timestampId } = require('../../utils/unique-id');

const DEFAULT_CONFIG = {
  maxQueueSize: 200,
  significantFindingsThreshold: 2,
  autoStoreMemory: true,
};

class PostTaskReviewer extends EventEmitter {
  /**
   * 创建PostTaskReviewer实例。
   * @param {Object} [config] - 配置选项
   * @param {number} [config.maxQueueSize=200] - 审查队列最大条目数
   * @param {number} [config.significantFindingsThreshold=2] - 触发DreamBridge的显著发现阈值
   * @param {boolean} [config.autoStoreMemory=true] - 是否自动将审查结果存储到MemoryPipeline
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._autoReinLoop = null;
    this._selfReflection = null;
    this._memoryPipeline = null;
    this._dreamBridge = null;
    this._reviewQueue = new BoundedArray(this._config.maxQueueSize);
    this._stats = { reviewsTriggered: 0, rulesGenerated: 0, memoriesStored: 0, reflectionsGenerated: 0 };
  }

  /**
   * 注入AutoReinLearningLoop实例，用于自动规则生成。
   * @param {Object|null} loop - AutoReinLearningLoop实例
   * @returns {PostTaskReviewer} this（支持链式调用）
   */
  attachAutoReinLoop(loop) {
    this._autoReinLoop = loop ?? null;
    return this;
  }

  /**
   * 注入SelfReflection实例，用于任务结果自反思。
   * @param {Object|null} reflection - SelfReflection实例
   * @returns {PostTaskReviewer} this（支持链式调用）
   */
  attachSelfReflection(reflection) {
    this._selfReflection = reflection ?? null;
    return this;
  }

  /**
   * 注入MemoryPipeline实例，用于审查结果持久化存储。
   * @param {Object|null} pipeline - MemoryPipeline实例
   * @returns {PostTaskReviewer} this（支持链式调用）
   */
  attachMemoryPipeline(pipeline) {
    this._memoryPipeline = pipeline ?? null;
    return this;
  }

  /**
   * 注入DreamBridge实例，用于显著发现时触发梦境桥接。
   * @param {Object|null} bridge - DreamBridge实例
   * @returns {PostTaskReviewer} this（支持链式调用）
   */
  attachDreamBridge(bridge) {
    this._dreamBridge = bridge ?? null;
    return this;
  }

  /**
   * 任务完成后执行审查流水线：自反思→规则生成→记忆存储→梦境桥接。
   * @param {Object} taskResult - 任务执行结果
   * @param {string} [taskResult.taskId] - 任务ID
   * @param {string} [taskResult.agentId] - Agent ID
   * @param {string} [taskResult.skillId] - 技能ID
   * @param {Array} [taskResult.errors] - 错误列表
   * @returns {Promise<{reviewId: string, reflected: boolean, rulesGenerated: number, memoriesStored: number, dreamBridgeTriggered: boolean}>} 审查结果
   */
  // eslint-disable-next-line complexity
  async reviewAfterTask(taskResult) {
    this.guardShutdown();
    if (!taskResult || typeof taskResult !== 'object') {
      return { reviewed: false, reason: 'Invalid task result' };
    }

    const reviewId = timestampId('ptr-');
    const reviewResult = {
      reviewId: reviewId,
      reflected: false,
      rulesGenerated: 0,
      memoriesStored: 0,
      dreamBridgeTriggered: false,
    };

    this._stats.reviewsTriggered++;

    let reflectionResult = null;
    if (this._selfReflection && taskResult.agentId && taskResult.skillId) {
      reflectionResult = safeExecute(() => {
        return this._selfReflection.reflect({
          agentId: taskResult.agentId,
          skillId: taskResult.skillId,
          artifactType: taskResult.artifactType || 'code',
          previousQuality: taskResult.previousQuality,
          currentQuality: taskResult.currentQuality,
          result: taskResult.result,
          dimensionScores: taskResult.dimensionScores,
        });
      }, 'PostTaskReviewer', 'reflect', null);
      if (reflectionResult === null) {
        try { this.emit('safe-execute-error', { method: 'reflect', error: 'SelfReflection.reflect returned null — possible internal error' }); } catch (_e) { debug('PostTaskReviewer', 'reflect-emit', _e && _e.message ? _e.message : String(_e)); }
      }

      if (reflectionResult) {
        reviewResult.reflected = true;
        this._stats.reflectionsGenerated++;
        taskResult.reflection = reflectionResult;
      }
    }

    if (this._autoReinLoop) {
      const reinResult = await safeExecuteAsync(async () => {
        return this._autoReinLoop.processTaskResult(taskResult);
      }, 'PostTaskReviewer', 'processTaskResult', { processed: false, rulesGenerated: 0 });
      if (reinResult && reinResult.processed === false && reinResult.rulesGenerated === 0) {
        try { this.emit('safe-execute-error', { method: 'processTaskResult', error: 'AutoReinLoop.processTaskResult may have failed internally' }); } catch (_e) { debug('PostTaskReviewer', 'processTaskResult-emit', _e && _e.message ? _e.message : String(_e)); }
      }

      if (reinResult) {
        reviewResult.rulesGenerated = reinResult.rulesGenerated ?? 0;
        this._stats.rulesGenerated += reinResult.rulesGenerated ?? 0;
      }
    }

    if (this._memoryPipeline && this._config.autoStoreMemory) {
      const memoryResult = safeExecute(() => {
        if (typeof this._memoryPipeline.recall === 'function' && typeof this._memoryPipeline.write === 'function') {
          this._memoryPipeline.write('post-task-review', {
            reviewId: reviewId,
            taskId: taskResult.taskId ?? taskResult.id,
            agentId: taskResult.agentId,
            skillId: taskResult.skillId,
            rulesGenerated: reviewResult.rulesGenerated,
            timestamp: Date.now(),
          });
          return true;
        }
        return false;
      }, 'PostTaskReviewer', 'storeMemory', false);
      if (memoryResult === false) {
        try { this.emit('safe-execute-error', { method: 'storeMemory', error: 'Memory pipeline write may have failed' }); } catch (_e) { debug('PostTaskReviewer', 'storeMemory-emit', _e && _e.message ? _e.message : String(_e)); }
      }

      if (memoryResult) {
        reviewResult.memoriesStored = 1;
        this._stats.memoriesStored++;
      }
    }

    const significantFindings = reviewResult.rulesGenerated + (taskResult.errors ? taskResult.errors.length : 0);
    if (this._dreamBridge && significantFindings >= this._config.significantFindingsThreshold) {
      safeExecute(() => {
        if (typeof this._dreamBridge.emit === 'function') {
          this._dreamBridge.emit('significant-findings', {
            reviewId: reviewId,
            findings: significantFindings,
            rulesGenerated: reviewResult.rulesGenerated,
            source: 'post-task-reviewer',
          });
        }
      }, 'PostTaskReviewer', 'triggerDreamBridge', null);
      reviewResult.dreamBridgeTriggered = true;
    }

    this._reviewQueue.push({
      reviewId: reviewId,
      taskId: taskResult.taskId ?? taskResult.id,
      result: reviewResult,
      timestamp: Date.now(),
    });

    this.emit('review-complete', reviewResult);

    return reviewResult;
  }

  /**
   * 获取统计信息。
   * @returns {{reviewsTriggered: number, rulesGenerated: number, memoriesStored: number, reflectionsGenerated: number}} 统计数据
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 获取审查队列（最近审查的任务结果）。
   * @returns {Array<Object>} 审查队列数组
   */
  getReviewQueue() {
    return this._reviewQueue.toArray();
  }

  _onShutdown() {
    this._autoReinLoop = null;
    this._selfReflection = null;
    this._memoryPipeline = null;
    this._dreamBridge = null;
    safeCall(() => this._reviewQueue.shutdown(), 'PostTaskReviewer', 'shutdown-reviewQueue');
    this._stats = { reviewsTriggered: 0, rulesGenerated: 0, memoriesStored: 0, reflectionsGenerated: 0 };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(PostTaskReviewer);
