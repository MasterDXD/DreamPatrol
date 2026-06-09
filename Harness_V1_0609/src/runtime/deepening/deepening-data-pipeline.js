'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { requireString_, requireFunction_ } = require('../../utils/param-validator');
const { HarnessError, DeepeningError } = require('../../errors');

/**
 * @module runtime/deepening/deepening-data-pipeline
 * 深化推理数据管道。多阶段数据处理管道，支持命名管道、有序阶段、
 * 可选阶段跳过、每阶段超时、可插拔错误处理器及异步执行。
 */

/**
 * 深化推理数据管道 — 深化子系统的多阶段数据处理管道。
 * 管理命名管道与有序阶段，支持可选阶段（失败时跳过）、
 * 通过 Promise.race 实现的每阶段超时、可插拔错误处理器、
 * 以及带已处理/成功/失败计数的异步阶段执行。
 *
 * @classdesc 深化数据管道。数据采集、转换、加载
 * @extends DeepeningBase
 * @emits 'stepAdded' 当阶段添加时触发，附带 { pipeline, name }
 * @emits 'stage-skipped' 当可选阶段因错误跳过时触发，附带 { pipeline, stage, error }
 * @emits 'stage-error' 当阶段执行失败时触发，附带错误信息
 * @emits 'error-handler-error' 当错误处理器自身抛出异常时触发
 */
class DeepeningDataPipeline extends DeepeningBase {

  /**
   * 创建 DeepeningDataPipeline 实例。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super(options);
    this._pipelines = new Map();
    this._maxPipelines = 50;
    this._defaultPipeline = { stages: [], errorHandlers: [], abortOnError: false };
    this._totalProcessed = 0;
    this._totalSucceeded = 0;
    this._totalFailed = 0;
  }

  /**
   * 获取指定名称的管道，未指定名称时返回默认管道。
   * @param {string} [name] - 管道名称
   * @returns {Object|null} 管道对象 { stages, errorHandlers }，不存在时返回 null
   * @private
   */
  _getPipeline(name) {
    if (!name) return this._defaultPipeline;
    return this._pipelines.get(name) ?? null;
  }

  /**
   * 创建命名管道。若已存在则返回当前实例。
   * @param {string} name - 管道名称
   * @returns {DeepeningDataPipeline} 当前实例（支持链式调用）
   */
  create(name) {
    this.guardShutdown();
    requireString_(name, 'Pipeline name');
    if (this._pipelines.has(name)) return this;
    if (this._pipelines.size >= this._maxPipelines && !this._pipelines.has(name)) {
      const oldest = this._pipelines.keys().next().value;
      this._pipelines.delete(oldest);
    }
    this._pipelines.set(name, { stages: [], errorHandlers: [], abortOnError: false });
    return this;
  }

  /**
   * 移除命名管道。
   * @param {string} name - 管道名称
   * @returns {boolean} 是否成功移除
   */
  remove(name) {
    this.guardShutdown();
    return this._pipelines.delete(name);
  }

  /**
   * 向管道添加处理阶段。
   * @param {string} pipelineName - 管道名称（null/undefined 时使用默认管道）
   * @param {string} stageName - 阶段名称
   * @param {Function} handler - 阶段处理函数，签名 (data) => data
   * @param {Object} [options] - 阶段选项
   * @param {boolean} [options.optional=false] - 是否为可选阶段（失败时跳过而非中断）
   * @param {number} [options.timeout=0] - 阶段超时时间（毫秒），0 表示无超时
   * @returns {boolean} 添加是否成功
   * @throws {DeepeningError} 阶段名称或处理函数缺失时抛出
   * @emits 'stepAdded'
   */
  addStage(pipelineName, stageName, handler, options) {
    this.guardShutdown();
    if (!stageName || typeof stageName !== 'string') throw new DeepeningError('MISSING_PARAMETER', 'Stage name is required');
    requireFunction_(handler, 'Stage handler');
    const pipeline = this._getPipeline(pipelineName);
    if (!pipeline) return false;
    const opts = options ?? {};
    pipeline.stages.push({ name: stageName, handler, optional: opts.optional ?? false, timeout: opts.timeout ?? 0 });
    this.emit('stepAdded', { pipeline: pipelineName, name: stageName });
    return true;
  }

  /**
   * 从管道移除指定阶段。
   * @param {string} pipelineName - 管道名称
   * @param {string} stageName - 阶段名称
   * @returns {boolean} 是否成功移除
   */
  removeStage(pipelineName, stageName) {
    this.guardShutdown();
    const pipeline = this._getPipeline(pipelineName);
    if (!pipeline) return false;
    const idx = pipeline.stages.findIndex(s => s.name === stageName);
    if (idx === -1) return false;
    pipeline.stages.splice(idx, 1);
    return true;
  }

  /**
   * 向管道添加错误处理器。
   * @param {string} pipelineName - 管道名称
   * @param {Function} handler - 错误处理函数，签名 (error, stageName) => void
   * @returns {boolean} 添加是否成功
   */
  addErrorHandler(pipelineName, handler) {
    this.guardShutdown();
    const pipeline = this._getPipeline(pipelineName);
    if (!pipeline) return false;
    pipeline.errorHandlers.push(handler);
    return true;
  }

  /**
   * 设置管道是否在可选阶段出错时中断执行。
   * @param {string} pipelineName - 管道名称
   * @param {boolean} enabled - 是否启用错误中断
   * @returns {boolean} 设置成功返回 true，管道不存在返回 false
   */
  setAbortOnError(pipelineName, enabled) {
    this.guardShutdown();
    const pipeline = this._getPipeline(pipelineName);
    if (!pipeline) return false;
    pipeline.abortOnError = !!enabled;
    return true;
  }

  /**
   * 异步执行管道处理。按阶段顺序依次处理数据，可选阶段失败时跳过，
   * 必选阶段失败时调用错误处理器并抛出异常。
   * @param {string} pipelineName - 管道名称
   * @param {*} data - 输入数据
   * @returns {Promise<*>} 处理后的结果数据
   * @throws {HarnessError} 管道不存在时抛出
   * @throws {DeepeningError} 必选阶段超时时抛出
   * @emits 'stage-skipped' 当可选阶段跳过时
   * @emits 'stage-error' 当必选阶段失败时
   * @emits 'error-handler-error' 当错误处理器异常时
   */
  async process(pipelineName, data) {
    this.guardShutdown();
    const pipeline = this._getPipeline(pipelineName);
    if (!pipeline) throw new HarnessError('DATA_PIPELINE_ERROR', 'Pipeline not found: ' + pipelineName);
    let result = data;
    for (const stage of Array.isArray(pipeline.stages) ? pipeline.stages : []) {
      if (this._shutDown) {
        debug('DeepeningDataPipeline', 'process', 'Pipeline shut down during processing at stage: ' + stage.name);
        throw new Error('Pipeline shut down during processing');
      }
      try {
        if (stage.timeout > 0) {
          let tid;
          const handlerResult = stage.handler(result);
          const handlerPromise = handlerResult && typeof handlerResult.then === 'function' ? handlerResult : Promise.resolve(handlerResult);
          handlerPromise.catch(function(err) { debug('DeepeningDataPipeline', 'handlerFailed', stage.name + ': ' + (err && err.message ? err.message : String(err))); });
          try {
            result = await Promise.race([
              handlerPromise,
              new Promise(function(_, reject) {
                tid = setTimeout(function() { reject(new DeepeningError('TIMEOUT', 'Stage timeout: ' + stage.name)); }, stage.timeout);
                if (tid && typeof tid.unref === 'function') tid.unref();
              }),
            ]);
          } finally {
            if (tid) clearTimeout(tid);
          }
        } else {
          result = await stage.handler(result);
        }
      } catch (e) {
        if (stage.optional && !pipeline.abortOnError) {
          this.emit('stage-skipped', { pipeline: pipelineName, stage: stage.name, error: e && e.message ? e.message : String(e) });
          continue;
        }
        for (const eh of pipeline.errorHandlers) {
          try { eh(e, stage.name); } catch (ehErr) { debug('DeepeningDataPipeline', 'errorHandler:' + stage.name, ehErr); emitError(this, 'error-handler-error', ehErr, { stage: stage.name }); }
        }
        this._totalProcessed++;
        this._totalFailed++;
        emitError(this, 'stage-error', e, { pipeline: pipelineName, stage: stage.name });
        throw e;
      }
    }
    this._totalProcessed++;
    this._totalSucceeded++;
    return result;
  }

  /**
   * 获取管道信息。
   * @param {string} name - 管道名称
   * @returns {Object|null} 管道信息 { name, stages }
   */
  getPipelineInfo(name) {
    const pipeline = this._pipelines.get(name);
    if (!pipeline) return null;
    return { name, stages: pipeline.stages.length };
  }

  /**
   * 获取数据管道运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalPipelines - 管道总数
   * @returns {number} return.totalProcessed - 总处理次数
   * @returns {number} return.totalSucceeded - 总成功次数
   * @returns {number} return.totalFailed - 总失败次数
   */
  getStats() {
    return {
      ...super.getStats(),
      totalPipelines: this._pipelines.size,
      totalProcessed: this._totalProcessed,
      totalSucceeded: this._totalSucceeded,
      totalFailed: this._totalFailed,
    };
  }

  /**
   * 关闭时的清理回调。清空所有管道。
   * @protected
   */
  _onShutdown() { this._pipelines.clear(); super._onShutdown(); }
}

module.exports = DeepeningDataPipeline;
