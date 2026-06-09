'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 情感状态路由器 — 基于 Mnemosyne Affective Router 的 Node.js 原生实现
 *
 * 核心原理：状态依赖记忆（amygdala filter）——大脑在当前情感状态与过去情感状态匹配时，
 * 更容易检索到相关记忆。紧急约束（"生产环境挂了"）应比随意的评论获得更高的检索权重。
 *
 * 三维认知状态向量：
 * - Valence（效价）：-1.0（消极）到 +1.0（积极）
 * - Arousal（唤醒）：0.0（平静）到 1.0（紧急/激动）
 * - Complexity（复杂度）：0.0（简单）到 1.0（复杂）
 *
 * 检索公式：score = semantic_similarity × 0.7 + affective_match × 0.3
 */
class AffectiveRouter {
  /**
   * @param {object} options - 配置选项
   * @param {number} [options.semanticWeight=0.7] - 语义相似度权重
   * @param {number} [options.affectiveWeight=0.3] - 情感匹配权重
   */
  constructor(options) {
    const opts = options ?? {};
    this._semanticWeight = opts.semanticWeight ?? 0.7;
    this._affectiveWeight = opts.affectiveWeight ?? 0.3;
    this._currentState = { valence: 0, arousal: 0, complexity: 0 };
    this._stateHistory = []; // 最近N条认知状态
    this._maxHistory = 100;
  }

  /**
   * 分类输入的认知状态
   * @param {string} content - 输入内容
   * @returns {{valence: number, arousal: number, complexity: number}}
   */
  classifyState(content) {
    if (!content || typeof content !== 'string') {
      return { valence: 0, arousal: 0, complexity: 0 };
    }

    const lower = content.toLowerCase();

    // 效价分类
    const positiveWords = ['good', 'great', 'excellent', 'perfect', 'love', 'awesome', '好', '棒', '优秀', '完美', '成功'];
    const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'broken', 'fail', '坏', '糟', '失败', '崩溃', '错误', 'bug'];
    let valence = 0;
    for (const w of positiveWords) { if (lower.includes(w)) valence += 0.3; }
    for (const w of negativeWords) { if (lower.includes(w)) valence -= 0.3; }
    valence = Math.max(-1, Math.min(1, valence));

    // 唤醒分类
    const urgentWords = ['urgent', 'critical', 'asap', 'emergency', 'down', 'prod', '紧急', '关键', '立即', '生产', '挂了', '崩溃'];
    const calmWords = ['maybe', 'consider', 'whenever', 'optional', '可能', '考虑', '可选', '随意'];
    let arousal = 0.3; // 基线
    for (const w of urgentWords) { if (lower.includes(w)) arousal += 0.3; }
    for (const w of calmWords) { if (lower.includes(w)) arousal -= 0.2; }
    arousal = Math.max(0, Math.min(1, arousal));

    // 复杂度分类
    const complexWords = ['architecture', 'refactor', 'redesign', 'migrate', 'integrate', '架构', '重构', '迁移', '集成', '系统'];
    const simpleWords = ['fix', 'typo', 'rename', 'simple', 'quick', '修复', '重命名', '简单', '快速'];
    let complexity = 0.3; // 基线
    for (const w of complexWords) { if (lower.includes(w)) complexity += 0.25; }
    for (const w of simpleWords) { if (lower.includes(w)) complexity -= 0.2; }
    complexity = Math.max(0, Math.min(1, complexity));

    const state = { valence, arousal, complexity };
    this._currentState = state;
    this._stateHistory.push({ ...state, timestamp: Date.now() });
    if (this._stateHistory.length > this._maxHistory) this._stateHistory.shift();

    return state;
  }

  /**
   * 计算两个认知状态之间的匹配度
   * @param {object} stateA - 认知状态A
   * @param {object} stateB - 认知状态B
   * @returns {number} 匹配度 0-1
   */
  computeAffectiveMatch(stateA, stateB) {
    if (!stateA || !stateB) return 0;
    const dv = (stateA.valence ?? 0) - (stateB.valence ?? 0);
    const da = (stateA.arousal ?? 0) - (stateB.arousal ?? 0);
    const dc = (stateA.complexity ?? 0) - (stateB.complexity ?? 0);
    const distance = Math.sqrt(dv * dv + da * da + dc * dc);
    const maxDistance = Math.sqrt(4 + 1 + 1); // valence范围2, arousal范围1, complexity范围1
    return Math.max(0, 1 - distance / maxDistance);
  }

  /**
   * 对检索结果进行情感重排序
   * @param {Array<{content: string, score: number, cognitiveState?: object}>} results - 检索结果
   * @param {object} [queryState] - 查询的认知状态（如未提供，使用当前状态）
   * @returns {Array<{content: string, score: number, affectiveScore: number}>}
   */
  rerank(results, queryState) {
    if (!results || results.length === 0) return [];

    const state = queryState || this._currentState;

    return results.map(r => {
      const semanticScore = Math.max(0, Math.min(1, r.score ?? 0));
      const affectiveMatch = this.computeAffectiveMatch(state, r.cognitiveState || { valence: 0, arousal: 0, complexity: 0 });
      const blendedScore = semanticScore * this._semanticWeight + affectiveMatch * this._affectiveWeight;

      return {
        ...r,
        affectiveScore: Math.round(blendedScore * 1000) / 1000,
      };
    }).sort((a, b) => b.affectiveScore - a.affectiveScore);
  }

  /**
   * 获取当前认知状态
   * @returns {{valence: number, arousal: number, complexity: number}}
   */
  getCurrentState() {
    return { ...this._currentState };
  }

  /**
   * 获取统计信息
   * @returns {{currentState: {valence: number, arousal: number, complexity: number}, historySize: number, semanticWeight: number, affectiveWeight: number}} 统计信息对象
   */
  getStats() {
    return {
      currentState: this._currentState,
      historySize: this._stateHistory.length,
      semanticWeight: this._semanticWeight,
      affectiveWeight: this._affectiveWeight,
    };
  }

  _onShutdown() {
    this._stateHistory = [];
  }
}

module.exports = { AffectiveRouter, AffectiveRouterEnhanced: withShutdown(AffectiveRouter) };
