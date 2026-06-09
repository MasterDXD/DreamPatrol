'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { DEFAULT_TTL_CACHE_MS } = require('../../utils/constants');
const { safeExecute } = require('../../utils/safe-execute');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_ATTENTION_DECAY = 0.7;
const DEFAULT_CAUSAL_DISTANCE_MAX = 5;
const MAX_ATTENTION_CACHE_SIZE = 100;
const VALID_STRATEGIES = new Set(['full', 'summary', 'discard']);

/**
 * @module causal-buffer-manager
 * @description 因果缓冲管理器，基于因果链和注意力衰减计算上下文压缩策略。
 * 通过CausalDataBus获取技能间因果依赖，结合SkillRouter的技能元数据，
 * 为每个技能计算注意力权重并决定压缩策略（full/summary/discard）。
 */

/**
 * 因果缓冲区管理器，管理因果链数据的内存缓冲和批量写入策略
 * @classdesc 因果缓冲区管理器，管理因果链数据的内存缓冲和批量写入策略
 * @extends EventEmitter
 */
class CausalBufferManager extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.attentionDecay=0.7] - 注意力衰减系数（0-1）
   * @param {number} [options.maxCausalDistance=5] - 最大因果距离（1-10）
   */
  constructor(options) {
    super();
    this._causalDataBus = null;
    this._skillRouter = null;
    const opts = options !== null && typeof options === 'object' ? options : {};
    const decay = opts.attentionDecay;
    this._attentionDecay = (Number.isFinite(decay) && decay > 0 && decay <= 1) ? decay : DEFAULT_ATTENTION_DECAY;
    const maxDist = opts.maxCausalDistance;
    this._maxCausalDistance = (Number.isFinite(maxDist) && maxDist >= 1 && maxDist <= 10) ? maxDist : DEFAULT_CAUSAL_DISTANCE_MAX;
    this._attentionCache = new Map();
    this._attentionCacheTTL = DEFAULT_TTL_CACHE_MS;
    this._buffer = [];
    this._maxBufferSize = (opts.maxBufferSize && typeof opts.maxBufferSize === 'number' && opts.maxBufferSize > 0) ? opts.maxBufferSize : 1000;
    this._storage = null;
    this._consecutiveFlushFailures = 0;
  }

  /**
   * 附加CausalDataBus实例，用于获取技能间因果依赖关系。
   * @param {CausalDataBus} causalDataBus - 因果数据总线实例
   * @returns {CausalBufferManager} this（链式调用）
   */
  attachCausalDataBus(causalDataBus) {
    this.guardShutdown();
    if (causalDataBus && typeof causalDataBus === 'object' && causalDataBus !== null && typeof causalDataBus.getCausalChain === 'function') {
      this._causalDataBus = causalDataBus;
      this.invalidateAttentionCache();
    }
    return this;
  }

  /**
   * 附加SkillRouter实例，用于获取技能元数据和依赖关系。
   * @param {SkillRouter} skillRouter - 技能路由器实例
   * @returns {CausalBufferManager} this（链式调用）
   */
  attachSkillRouter(skillRouter) {
    this.guardShutdown();
    if (skillRouter && typeof skillRouter === 'object' && skillRouter !== null && skillRouter.registry) {
      this._skillRouter = skillRouter;
      this.invalidateAttentionCache();
    }
    return this;
  }

  /**
   * 附加持久化存储实例，缓冲区满时自动刷写到存储。
   * @param {object} storage - 存储实例，须实现 write 方法
   * @returns {CausalBufferManager} this（链式调用）
   */
  attachStorage(storage) {
    this.guardShutdown();
    if (storage && typeof storage === 'object' && typeof storage.write === 'function') {
      this._storage = storage;
    }
    return this;
  }

  /**
   * 向缓冲区写入一条条目，缓冲区满时自动刷写到存储。
   * @param {object} entry - 待写入的条目对象
   * @returns {boolean} 写入是否成功
   */
  write(entry) {
    this.guardShutdown();
    if (!entry || typeof entry !== 'object') return false;
    if (this._buffer.length >= this._maxBufferSize) {
      if (!this._flushBuffer()) return false;
    }
    this._buffer.push(entry);
    return true;
  }

  _flushBuffer() {
    if (!this.isHealthy()) return false;
    return this._flushBufferUnsafe();
  }

  /**
   * Flush buffer without isHealthy() check. Used during shutdown when
   * _shutDown is already true but buffer data must still be persisted.
   * @returns {boolean} flush succeeded
   */
  _flushBufferUnsafe() {
    if (this._buffer.length === 0) return true;
    if (!this._storage) return true;
    if (this._consecutiveFlushFailures >= 5) {
      this.emit('flush-failed', { bufferSize: this._buffer.length });
      return false;
    }

    const toFlush = this._buffer.splice(0);
    let writeSucceeded = true;
    for (let i = 0; i < toFlush.length; i++) {
      try {
        const result = this._storage.write(toFlush[i]);
        if (result === false) {
          writeSucceeded = false;
          this._consecutiveFlushFailures++;
          this._buffer.unshift(...toFlush.slice(i));
          this.emit('flush-partial-failure', { preserved: toFlush.length - i });
          break;
        }
      } catch (err) {
        writeSucceeded = false;
        this._consecutiveFlushFailures++;
        this._buffer.unshift(...toFlush.slice(i));
        debug('CausalBufferManager', '_flushBufferUnsafe', 'Write failed, preserving buffer: ' + (err && err.message ? err.message : String(err)));
        this.emit('flush-error', { error: err, preserved: toFlush.length - i });
        break;
      }
    }
    if (writeSucceeded) {
      this._consecutiveFlushFailures = 0;
    }
    return writeSucceeded;
  }

  /**
   * 计算指定技能的注意力权重映射。基于因果链距离和注意力衰减系数，
   * 为当前技能的所有因果上游技能分配权重。结果带TTL缓存。
   * @param {string} currentSkillId - 当前技能ID
   * @returns {Map<string, number>} 技能ID到注意力权重的映射
   */
  computeAttentionWeights(currentSkillId) {
    this.guardShutdown();
    if (!currentSkillId || typeof currentSkillId !== 'string') return new Map();
    if (!this._causalDataBus || !this._skillRouter) return new Map();

    const cached = this._attentionCache.get(currentSkillId);
    if (cached && Date.now() - cached._cachedAt < this._attentionCacheTTL) {
      this._attentionCache.delete(currentSkillId);
      this._attentionCache.set(currentSkillId, cached);
      return new Map(cached.weights);
    }

    const weights = this._buildAttentionWeights(currentSkillId);
    this._cacheWeights(currentSkillId, weights);
    return weights;
  }

  _buildAttentionWeights(currentSkillId) {
    const weights = new Map();
    const registry = this._safeGetRegistry();
    const causalChain = this._safeGetCausalChain();
    if (!registry || !causalChain || causalChain.length === 0) return weights;

    const currentSkill = registry[currentSkillId];
    if (!currentSkill) return weights;

    try {
      const directDependencies = this._extractDirectDependencies(currentSkill);
      for (const input of directDependencies) {
        weights.set(input, 1.0);
      }
      this._propagateWeights(weights, directDependencies, registry);
      this._assignBackgroundWeights(weights, causalChain);
    } catch (e) {
      debug('CausalBufferManager', 'buildWeightsError', e);
      return weights;
    }
    return weights;
  }

  _safeGetRegistry() {
    const result = safeExecute(() => this._skillRouter.registry, 'CausalBufferManager', 'getRegistry', null);
    if (result === null) this.emit('dependency-access-failed', { component: 'skillRouter' });
    return result;
  }

  _safeGetCausalChain() {
    const result = safeExecute(() => this._causalDataBus.getCausalChain(), 'CausalBufferManager', 'getCausalChain', null);
    if (result === null) this.emit('dependency-access-failed', { component: 'causalDataBus' });
    return result;
  }

  _assignBackgroundWeights(weights, causalChain) {
    for (const entry of causalChain) {
      if (entry && entry.skillId && !weights.has(entry.skillId)) {
        weights.set(entry.skillId, 0.1);
      }
    }
  }

  _cacheWeights(currentSkillId, weights) {
    if (this._attentionCache.size >= MAX_ATTENTION_CACHE_SIZE) {
      const firstKey = this._attentionCache.keys().next().value;
      this._attentionCache.delete(firstKey);
    }
    this._attentionCache.set(currentSkillId, { weights: weights, _cachedAt: Date.now() });
  }

  _extractDirectDependencies(skill) {
    const causalInputs = skill.causal_inputs;
    if (!Array.isArray(causalInputs)) return new Set();
    const directDependencies = new Set();
    for (const input of causalInputs) {
      if (input && input.source && typeof input.source === 'string') {
        directDependencies.add(input.source);
      }
    }
    return directDependencies;
  }

  _propagateWeights(weights, directDependencies, registry) {
    const visited = new Set(directDependencies);
    const queue = [];
    for (const dep of directDependencies) {
      queue.push({ skillId: dep, distance: 1 });
    }

    while (queue.length > 0) {
      const item = queue.shift();
      if (item.distance >= this._maxCausalDistance) continue;

      const skill = registry[item.skillId];
      if (!skill || !Array.isArray(skill.causal_inputs)) continue;

      for (const input of skill.causal_inputs) {
        if (input && input.source && typeof input.source === 'string' && !visited.has(input.source)) {
          visited.add(input.source);
          const weight = Math.pow(this._attentionDecay, item.distance);
          weights.set(input.source, weight);
          queue.push({ skillId: input.source, distance: item.distance + 1 });
        }
      }
    }
  }

  /**
   * 根据注意力权重确定指定技能的压缩策略。
   * 权重>=0.7返回'full'，>=0.3返回'summary'，否则返回'discard'。
   * @param {string} skillId - 目标技能ID
   * @param {string} currentSkillId - 当前活跃技能ID
   * @returns {'full'|'summary'|'discard'} 压缩策略
   */
  getCompressionStrategy(skillId, currentSkillId) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return 'discard';
    if (!currentSkillId || typeof currentSkillId !== 'string') return 'discard';
    const weights = this.computeAttentionWeights(currentSkillId);
    const weight = weights.get(skillId);

    if (weight === undefined || weight < 1e-10) return 'discard';
    if (weight >= 0.7) return 'full';
    if (weight >= 0.3) return 'summary';
    return 'discard';
  }

  /**
   * 获取缓冲管理器统计信息，包括注意力缓存大小、依赖组件状态和健康检查。
   * @returns {{ attentionCacheSize: number, hasCausalDataBus: boolean, hasSkillRouter: boolean, isHealthy: boolean, causalDataBusStats?: Object|null }}
   */
  getBufferStats() {
    this.guardShutdown();
    const stats = {
      attentionCacheSize: this._attentionCache.size,
      hasCausalDataBus: !!this._causalDataBus,
      hasSkillRouter: !!this._skillRouter,
      isHealthy: this.isHealthy(),
    };
    if (this._causalDataBus && typeof this._causalDataBus.getStats === 'function') {
      try {
        stats.causalDataBusStats = this._causalDataBus.getStats();
      } catch (e) {
        debug('CausalBufferManager', 'getStats', 'CausalDataBus stats failed: ' + (e && e.message ? e.message : String(e)));
        stats.causalDataBusStats = null;
      }
    }
    return stats;
  }

  /**
   * 使注意力权重缓存失效，下次计算时重新构建。
   */
  invalidateAttentionCache() {
    this.guardShutdown();
    this._attentionCache.clear();
  }

  _onShutdown() {
    if (this._buffer.length > 0 && this._storage) {
      this._flushBufferUnsafe();
    }
    this._buffer = [];
    this._storage = null;
    this._attentionCache.clear();
    this._causalDataBus = null;
    this._skillRouter = null;
    this.removeAllListeners();
  }
}

CausalBufferManager.VALID_STRATEGIES = VALID_STRATEGIES;

module.exports = withShutdown(CausalBufferManager);
