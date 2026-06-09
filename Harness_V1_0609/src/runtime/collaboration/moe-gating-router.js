'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

/**
 * MoE统一门控路由器
 *
 * 将项目中分散的门控逻辑统一到MoE（Mixture of Experts）框架下：
 * - 门控网络(Gating Network): 根据输入特征计算专家激活概率
 * - Top-K稀疏激活: 仅激活得分最高的K个专家
 * - 负载均衡: 辅助损失机制防止路由崩塌
 * - 共享专家: 始终激活的通用专家
 *
 * @extends EventEmitter
 * @mixin withShutdown
 */
class MoeGatingRouter extends EventEmitter {

  /**
   * @param {Object} [options] 配置选项
   * @param {number} [options.topK=2] 每次激活的专家数量
   * @param {number} [options.minGateScore=0.1] 最低门控分数阈值
   * @param {number} [options.auxiliaryLossWeight=0.01] 辅助损失权重（负载均衡）
   * @param {number} [options.gateDecayFactor=0.95] 门控分数衰减因子
   * @param {number} [options.maxExperts=100] 最大专家注册数
   * @param {boolean} [options.enableSharedExperts=true] 是否启用共享专家
   * @param {boolean} [options.enableLoadBalancing=true] 是否启用负载均衡
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._topK = (typeof opts.topK === 'number' && Number.isFinite(opts.topK) && opts.topK >= 1) ? Math.min(opts.topK, 10) : 2;
    this._minGateScore = (typeof opts.minGateScore === 'number' && Number.isFinite(opts.minGateScore)) ? opts.minGateScore : 0.1;
    this._auxiliaryLossWeight = (typeof opts.auxiliaryLossWeight === 'number' && Number.isFinite(opts.auxiliaryLossWeight)) ? opts.auxiliaryLossWeight : 0.01;
    this._gateDecayFactor = (typeof opts.gateDecayFactor === 'number' && Number.isFinite(opts.gateDecayFactor) && opts.gateDecayFactor > 0 && opts.gateDecayFactor <= 1) ? opts.gateDecayFactor : 0.95;
    this._enableSharedExperts = opts.enableSharedExperts !== false;
    this._enableLoadBalancing = opts.enableLoadBalancing !== false;

    // 专家注册表: id -> { id, name, category, score, load, activationCount, lastActivated, isShared, metadata }
    const self = this;
    this._experts = new BoundedMap(opts.maxExperts ?? 100, {
      onEvict(key) { self._stats.expertActivations.delete(key); },
    });

    // 门控历史（用于辅助损失计算）
    this._gateHistory = [];
    this._maxGateHistory = 1000;

    // 统计信息
    this._stats = {
      totalRoutings: 0,
      expertActivations: new Map(), // expertId -> count
      loadBalanceVariance: 0,
      auxiliaryLoss: 0,
    };
  }

  /**
   * 注册专家
   * @param {string} id 专家唯一标识
   * @param {Object} [config] 专家配置
   * @param {string} [config.name] 专家名称
   * @param {string} [config.category] 专家类别（agent/skill/model/collaboration）
   * @param {boolean} [config.isShared=false] 是否为共享专家（始终激活）
   * @param {Object} [config.metadata] 额外元数据
   * @returns {MoeGatingRouter} 当前实例，支持链式调用
   * @throws {Error} 当路由器已关闭时抛出异常
   */
  registerExpert(id, config) {
    this.guardShutdown();
    if (!id || typeof id !== 'string') return this;
    const cfg = config ?? {};
    this._experts.set(id, {
      id,
      name: cfg.name || id,
      category: cfg.category || 'general',
      score: 0,
      load: 0,
      activationCount: 0,
      lastActivated: 0,
      isShared: this._enableSharedExperts && cfg.isShared === true,
      metadata: cfg.metadata ?? {},
    });
    this._stats.expertActivations.set(id, 0);
    return this;
  }

  /**
   * 注销专家
   * @param {string} id 专家ID
   * @returns {boolean} 是否成功注销
   */
  unregisterExpert(id) {
    this.guardShutdown();
    const removed = this._experts.delete(id);
    if (removed) {
      this._stats.expertActivations.delete(id);
    }
    return removed;
  }

  /**
   * 门控路由：根据输入特征计算专家激活概率并选择Top-K
   *
   * 核心算法：
   * 1. 对每个专家计算门控分数 = baseScore * (1 / (1 + load)) * decayFactor
   * 2. 过滤低于 minGateScore 的专家
   * 3. 选择 Top-K 得分最高的专家
   * 4. 共享专家始终包含在结果中
   * 5. 计算辅助损失（负载均衡）
   *
   * @param {Object} input 输入特征
   * @param {Object} [input.scores] 专家ID -> 预计算分数的映射
   * @param {string[]} [input.preferredExperts] 偏好专家列表
   * @param {string[]} [input.excludedExperts] 排除专家列表
   * @param {string} [input.category] 限定专家类别
   * @param {number} [input.topK] 覆盖默认Top-K值
   * @returns {{ selected: Object[], gateScores: Object, auxiliaryLoss: number, loadBalance: Object }}
   * @throws {Error} 当路由器已关闭时抛出异常
   */
  route(input) {
    this.guardShutdown();
    const result = safeExecute(() => this._doRoute(input), {
      fallback: { selected: [], gateScores: {}, auxiliaryLoss: 0, loadBalance: { variance: 0, isBalanced: true } },
      label: 'MoeGatingRouter',
      method: 'route',
    });
    return result;
  }

  /** @private */
  _doRoute(input) {
    const inp = input ?? {};
    const topK = (typeof inp.topK === 'number' && Number.isFinite(inp.topK) && inp.topK >= 1) ? Math.min(inp.topK, 10) : this._topK;
    const scores = inp.scores ?? {};
    const preferred = new Set(inp.preferredExperts ?? []);
    const excluded = new Set(inp.excludedExperts ?? []);
    const category = inp.category || null;

    const { gateScores, candidates } = this._computeGateScores(scores, preferred, excluded, category);

    const { sharedExperts, regularCandidates } = this._separateCandidates(candidates);

    const remainingSlots = Math.max(topK - sharedExperts.length, 0);
    regularCandidates.sort((a, b) => b.gateScore - a.gateScore);
    const selectedRegular = regularCandidates.slice(0, remainingSlots);

    const selected = [...sharedExperts, ...selectedRegular];
    selected.sort((a, b) => b.gateScore - a.gateScore);

    const now = Date.now();
    for (const { expert } of selected) {
      expert.activationCount++;
      expert.lastActivated = now;
      this._stats.expertActivations.set(expert.id, (this._stats.expertActivations.get(expert.id) ?? 0) + 1);
    }

    const auxiliaryLoss = this._computeAuxiliaryLoss(gateScores);

    this._recordGateHistory(gateScores, selected.map(s => s.expert.id));

    this._stats.totalRoutings++;
    this._stats.auxiliaryLoss = auxiliaryLoss;

    const loadBalance = this._computeLoadBalance();

    this.emit('routed', {
      selectedExpertIds: selected.map(s => s.expert.id),
      gateScores,
      auxiliaryLoss,
      topK,
    });

    return {
      selected: selected.map(s => ({ id: s.expert.id, name: s.expert.name, category: s.expert.category, gateScore: s.gateScore, isShared: s.expert.isShared, metadata: s.expert.metadata })),
      gateScores,
      auxiliaryLoss,
      loadBalance,
    };
  }

  _computeGateScores(scores, preferred, excluded, category) {
    const gateScores = {};
    const candidates = [];

    for (const [id, expert] of this._experts) {
      if (category && expert.category !== category) continue;
      if (excluded.has(id)) continue;

      let baseScore = typeof scores[id] === 'number' && Number.isFinite(scores[id]) ? scores[id] : expert.score;

      if (preferred.has(id)) {
        baseScore = Math.min(baseScore + 0.3, 1.0);
      }

      const loadFactor = this._enableLoadBalancing ? (1 / (1 + expert.load)) : 1;

      const timeSinceLastActivation = Date.now() - (expert.lastActivated ?? 0);
      const explorationBonus = Math.min(0.1, timeSinceLastActivation / 3600000 * 0.01);

      const gateScore = baseScore * loadFactor + explorationBonus;
      gateScores[id] = gateScore;

      if (gateScore >= this._minGateScore || expert.isShared) {
        candidates.push({ expert, gateScore });
      }
    }

    return { gateScores, candidates };
  }

  _separateCandidates(candidates) {
    const sharedExperts = [];
    const regularCandidates = [];
    for (const c of candidates) {
      if (c.expert.isShared) {
        sharedExperts.push(c);
      } else {
        regularCandidates.push(c);
      }
    }
    return { sharedExperts, regularCandidates };
  }

  /**
   * 更新专家分数（学习型门控）
   * @param {string} expertId 专家ID
   * @param {number} scoreDelta 分数增量（正=奖励，负=惩罚）
   * @returns {boolean} 是否成功更新
   */
  updateExpertScore(expertId, scoreDelta) {
    this.guardShutdown();
    const expert = this._experts.get(expertId);
    if (!expert) return false;
    const delta = typeof scoreDelta === 'number' && Number.isFinite(scoreDelta) ? scoreDelta : 0;
    expert.score = Math.max(0, Math.min(1, expert.score + delta));
    return true;
  }

  /**
   * 更新专家负载
   * @param {string} expertId 专家ID
   * @param {number} load 负载值
   * @returns {boolean} 是否成功更新
   */
  updateExpertLoad(expertId, load) {
    this.guardShutdown();
    const expert = this._experts.get(expertId);
    if (!expert) return false;
    expert.load = Math.max(0, typeof load === 'number' && Number.isFinite(load) ? load : 0);
    return true;
  }

  /**
   * 衰减所有专家分数（定期调用，模拟遗忘）
   */
  decayScores() {
    for (const [, expert] of this._experts) {
      expert.score *= this._gateDecayFactor;
    }
  }

  /**
   * 计算辅助损失（负载均衡指标）
   * 辅助损失 = weight * N * sum(f_i * P_i)
   * 其中 f_i 是专家i的负载因子，P_i 是专家i被选中的概率
   * @param {Object} gateScores 门控分数映射
   * @returns {number} 辅助损失值
   * @private
   */
  _computeAuxiliaryLoss(gateScores) {
    if (!this._enableLoadBalancing) return 0;

    const scores = Object.values(gateScores);
    if (scores.length === 0) return 0;

    // softmax 概率
    const maxScore = Math.max(...scores);
    const expScores = scores.map(s => Math.exp(s - maxScore));
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    const probs = expScores.map(e => e / sumExp);

    // 负载因子
    const loads = [];
    for (const [id] of this._experts) {
      if (id in gateScores) {
        loads.push(this._experts.get(id).load);
      }
    }

    // 辅助损失 = weight * N * sum(f_i * P_i)
    let auxLoss = 0;
    for (let i = 0; i < probs.length; i++) {
      const loadNorm = loads[i] !== undefined ? loads[i] / (1 + loads[i]) : 0;
      auxLoss += loadNorm * probs[i];
    }
    auxLoss *= this._auxiliaryLossWeight * scores.length;

    return auxLoss;
  }

  /**
   * 计算负载均衡指标
   * @returns {{ variance: number, isBalanced: boolean, utilization: Object }}
   * @private
   */
  _computeLoadBalance() {
    const activations = Array.from(this._stats.expertActivations.values());
    if (activations.length === 0) return { variance: 0, isBalanced: true, utilization: {} };

    const mean = activations.reduce((a, b) => a + b, 0) / activations.length;
    const variance = activations.reduce((sum, v) => sum + (v - mean) ** 2, 0) / activations.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0; // 变异系数

    // 利用率统计
    const utilization = {};
    for (const [id, count] of this._stats.expertActivations) {
      utilization[id] = this._stats.totalRoutings > 0 ? count / this._stats.totalRoutings : 0;
    }

    return {
      variance,
      isBalanced: cv < 0.5, // 变异系数<0.5视为均衡
      utilization,
    };
  }

  /**
   * 记录门控历史
   * @private
   */
  _recordGateHistory(gateScores, selectedIds) {
    this._gateHistory.push({
      timestamp: Date.now(),
      gateScores: { ...gateScores },
      selectedIds: [...selectedIds],
    });
    if (this._gateHistory.length > this._maxGateHistory) {
      this._gateHistory.shift();
    }
  }

  /**
   * 获取路由统计
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalRoutings: this._stats.totalRoutings,
      registeredExperts: this._experts.size,
      auxiliaryLoss: this._stats.auxiliaryLoss,
      loadBalance: this._computeLoadBalance(),
      topK: this._topK,
      sharedExpertsEnabled: this._enableSharedExperts,
      loadBalancingEnabled: this._enableLoadBalancing,
    };
  }

  /**
   * 获取专家信息
   * @param {string} expertId 专家ID
   * @returns {Object|null} 专家信息
   */
  getExpert(expertId) {
    const expert = this._experts.get(expertId);
    if (!expert) return null;
    return { ...expert };
  }

  /**
   * 列出所有专家
   * @param {string} [category] 按类别过滤
   * @returns {Object[]} 专家列表
   */
  listExperts(category) {
    const result = [];
    for (const [, expert] of this._experts) {
      if (category && expert.category !== category) continue;
      result.push({ ...expert });
    }
    return result;
  }

  /**
   * 获取门控历史
   * @param {number} [limit=10] 返回最近N条记录
   * @returns {Object[]} 门控历史
   */
  getGateHistory(limit) {
    const n = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 10;
    return this._gateHistory.slice(-n);
  }

  /** 关闭清理回调 @returns {void} @private */
  _onShutdown() {
    this._experts.shutdown();
    this._gateHistory.length = 0;
    this._stats.expertActivations.clear();
    this.removeAllListeners();
  }
}

module.exports = { MoeGatingRouter: withShutdown(MoeGatingRouter) };
