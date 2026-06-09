'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { DEFAULT_CONFIDENCE, MS_PER_HOUR } = require('../../utils/constants');
const RingBuffer = require('../../utils/ring-buffer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { clamp01, emitError } = require('../../utils/safe-execute');

const LEARNING_RATE = 0.1;
const DECAY_FACTOR = 0.995;
const MIN_SAMPLES = 3;
const DECAY_INTERVAL_MS = MS_PER_HOUR;
const MAX_RECORD_KEYS = 500;
const MAX_AFFINITY_KEYS = 5000;

/**
 * @module runtime/user/affinity-learner
 * AffinityLearner — User-Agent collaboration pattern adapter with decay
 * Tracks per agent-task affinity scores using incremental learning with configurable
 * decay, persists records to SQLite, and recommends best-fit agents for task types.
 * @classdesc 亲和力学习器。用户-AI协作模式适配
 * @extends EventEmitter
 * @emits AffinityLearner#loaded-from-store
 * @emits AffinityLearner#affinity-updated
 * @emits AffinityLearner#load-error
 */
class AffinityLearner extends EventEmitter {
  constructor(options) {
    super();
    this._learningRate = (options && options.learningRate) ?? LEARNING_RATE;
    let decayFactor = (options && options.decayFactor) ?? DECAY_FACTOR;
    if (typeof decayFactor !== 'number' || !Number.isFinite(decayFactor) || decayFactor <= 0 || decayFactor > 1) {
      decayFactor = DECAY_FACTOR;
    }
    this._decayFactor = decayFactor;
    this._minSamples = (options && options.minSamples) ?? MIN_SAMPLES;
    this._records = new Map();
    this._affinities = new Map();
    this._maxRecords = typeof (options && options.maxRecords) === 'number' && Number.isFinite(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : 1000;
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._dirtyKeys = new Set();
    this._decayTimer = null;
    this._startDecayTimer();
  }

  /**
   * 附加SQLite存储实例，从持久化存储加载已有亲和度记录并重启衰减定时器
   * @param {object} store - SQLite存储实例，需提供getAllAffinityRecords和upsertAffinity方法
   * @returns {AffinityLearner} 返回this以支持链式调用
   */
  attachSqliteStore(store) {
    this.guardShutdown();
    this._sqliteStore = store;
    this._loadFromStore();
    this._startDecayTimer();
    return this;
  }

  _loadFromStore() {
    if (!this._sqliteStore) return;
    try {
      const rows = this._sqliteStore.getAllAffinityRecords();
      for (const row of rows) {
        if (!row.agent_id || !row.task_type) continue;
        const key = row.agent_id + '\0' + row.task_type;
        this._affinities.set(key, {
          score: typeof row.score === 'number' ? clamp01(row.score) : DEFAULT_CONFIDENCE,
          samples: typeof row.samples === 'number' ? row.samples : 0,
          totalScore: typeof row.total_score === 'number' ? row.total_score : 0,
        });
      }
      this.emit('loaded-from-store', { count: rows.length });
    } catch (err) {
      emitError(this, 'load-error', err);
    }
  }

  _persistAffinity(key) {
    if (!this._sqliteStore) return;
    const affinity = this._affinities.get(key);
    if (!affinity) return;
    if (typeof key !== 'string') return;
    const parts = key.split('\0');
    const agentId = parts[0];
    const taskType = parts[1] ?? 'unknown';
    try {
      this._sqliteStore.upsertAffinity(agentId, taskType, {
        score: affinity.score,
        samples: affinity.samples,
        totalScore: affinity.totalScore,
      });
    } catch (err) { debug('AffinityLearner', 'persistError', err && err.message ? err.message : String(err)); }
  }

  _startDecayTimer() {
    if (this._decayTimer) return;
    this._decayTimer = setInterval(() => {
      if (this._shutDown) return;
      try {
        this.decay();
      } catch (err) {
        debug('AffinityLearner', 'decay-timer-error', err && err.message ? err.message : String(err));
      }
    }, DECAY_INTERVAL_MS);
    if (this._decayTimer && typeof this._decayTimer.unref === 'function') { this._decayTimer.unref(); }
  }

  /**
   * 记录一次Agent执行结果，增量更新亲和度分数并持久化
   * @param {string} agentId - Agent标识
   * @param {string} taskType - 任务类型
   * @param {number} qualityScore - 质量评分（0-1）
   * @param {number} [duration] - 执行耗时（毫秒）
   * @returns {void}
   */
  recordExecution(agentId, taskType, qualityScore, duration) {
    this.guardShutdown();
    if (!agentId || !taskType || typeof qualityScore !== 'number' || !Number.isFinite(qualityScore)) {
      return;
    }

    const key = agentId + '\0' + taskType;
    if (!this._records.has(key)) {
      if (this._records.size >= MAX_RECORD_KEYS) {
        const oldestKey = this._records.keys().next().value;
        this._records.delete(oldestKey);
      }
      this._records.set(key, new RingBuffer(this._maxRecords));
    }
    const records = this._records.get(key);
    records.push({
      agentId,
      taskType,
      qualityScore,
      duration: duration ?? 0,
      timestamp: new Date().toISOString(),
    });

    this._updateAffinity(key, qualityScore);
    this._persistAffinity(key);

    this.emit('execution-recorded', { agentId, taskType, qualityScore, key });
  }

  _updateAffinity(key, qualityScore) {
    const current = this._affinities.get(key) ?? { score: DEFAULT_CONFIDENCE, samples: 0, totalScore: 0 };
    current.samples++;
    current.totalScore += qualityScore;

    const targetAffinity = qualityScore;
    current.score = current.score + this._learningRate * (targetAffinity - current.score);
    current.score = clamp01(current.score);

    this._affinities.set(key, current);

    if (this._affinities.size > MAX_AFFINITY_KEYS) {
      const oldestKey = this._affinities.keys().next().value;
      this._affinities.delete(oldestKey);
    }
  }

  /**
   * 获取指定Agent对指定任务类型的亲和度信息
   * @param {string} agentId - Agent标识
   * @param {string} taskType - 任务类型
   * @returns {object} 亲和度对象，包含score、confidence('low'|'medium'|'high')、samples字段
   */
  getAffinity(agentId, taskType) {
    this.guardShutdown();
    if (!agentId || !taskType) return { score: DEFAULT_CONFIDENCE, confidence: 'low', samples: 0 };
    const key = agentId + '\0' + taskType;
    const affinity = this._affinities.get(key);
    if (!affinity || affinity.samples < this._minSamples) {
      return { score: DEFAULT_CONFIDENCE, confidence: 'low', samples: affinity ? affinity.samples : 0 };
    }

    const confidence = affinity.samples >= 10 ? 'high' : affinity.samples >= 5 ? 'medium' : 'low';
    return { score: affinity.score, confidence, samples: affinity.samples };
  }

  /**
   * 获取指定任务类型下所有候选Agent的推荐排序
   * @param {string} taskType - 任务类型
   * @param {Array<string>} agentIds - 候选Agent ID列表
   * @returns {Array<object>} 按亲和度分数降序排列的推荐数组，每项包含agentId、score、confidence、samples
   */
  getRecommendations(taskType, agentIds) {
    this.guardShutdown();
    if (!agentIds || !Array.isArray(agentIds)) return [];
    const recommendations = [];
    for (const agentId of agentIds) {
      const affinity = this.getAffinity(agentId, taskType);
      recommendations.push({
        agentId,
        score: affinity.score,
        confidence: affinity.confidence,
        samples: affinity.samples,
      });
    }

    recommendations.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return recommendations;
  }

  /**
   * 执行亲和度衰减，所有亲和度分数乘以衰减因子（最低0.1），并持久化脏数据
   * @returns {void}
   */
  decay() {
    this.guardShutdown();
    for (const [key, affinity] of this._affinities.entries()) {
      affinity.score *= this._decayFactor;
      affinity.score = Math.max(0.1, Math.min(1.0, affinity.score));
      if (!Number.isFinite(affinity.score)) affinity.score = DEFAULT_CONFIDENCE;
      this._affinities.set(key, affinity);
      this._dirtyKeys.add(key);
    }
    const persisted = [];
    let count = 0;
    for (const key of this._dirtyKeys) {
      if (count >= 100) break;
      this._persistAffinity(key);
      persisted.push(key);
      count++;
    }
    for (const key of persisted) {
      this._dirtyKeys.delete(key);
    }
    this.emit('affinities-decayed');
  }

  /**
   * 获取指定Agent在所有任务类型上的性能表现
   * @param {string} agentId - Agent标识
   * @returns {object} 性能对象，键为任务类型，值为包含score、samples、averageScore的对象
   */
  getAgentPerformance(agentId) {
    this.guardShutdown();
    const performance = {};
    const prefix = agentId + '\0';
    for (const [key, affinity] of this._affinities.entries()) {
      if (key.startsWith(prefix)) {
        const taskType = key.substring(prefix.length);
        performance[taskType] = {
          score: affinity.score,
          samples: affinity.samples,
          averageScore: affinity.samples > 0 ? affinity.totalScore / affinity.samples : 0,
        };
      }
    }
    return performance;
  }

  /**
   * 获取亲和度学习器的统计信息
   * @returns {object} 统计对象，包含totalAffinities、totalRecords、knownAgents、knownTaskTypes、learningRate、decayFactor、hasPersistentStore字段
   */
  getStats() {
    let totalRecords = 0;
    const agentCount = new Set();
    const taskTypeCount = new Set();

    for (const [key, affinity] of this._affinities.entries()) {
      totalRecords += affinity.samples;
      const parts = key.split('\0');
      const agentId = parts[0];
      const taskType = parts[1] ?? 'unknown';
      agentCount.add(agentId);
      taskTypeCount.add(taskType);
    }

    return {
      totalAffinities: this._affinities.size,
      totalRecords,
      knownAgents: agentCount.size,
      knownTaskTypes: taskTypeCount.size,
      learningRate: this._learningRate,
      decayFactor: this._decayFactor,
      hasPersistentStore: !!this._sqliteStore,
    };
  }

  _onShutdown() {
    if (this._decayTimer) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }
    for (const key of this._affinities.keys()) {
      try { this._persistAffinity(key); } catch (_e) { debug('AffinityLearner', '_onShutdown', 'persist failed for', key, _e && _e.message ? _e.message : String(_e)); }
    }
    this._records.clear();
    this._affinities.clear();
    this._dirtyKeys.clear();
    this._sqliteStore = null;
    this.removeAllListeners();
  }

  /**
   * 检查亲和度学习器是否健康，未关闭且亲和度数量低于10000即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._affinities !== null && this._affinities.size < 10000;
  }
}

AffinityLearner.LEARNING_RATE = LEARNING_RATE;
AffinityLearner.DECAY_FACTOR = DECAY_FACTOR;
AffinityLearner.MIN_SAMPLES = MIN_SAMPLES;

module.exports = withShutdown(AffinityLearner);
