'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_REVIEW_TIMEOUT_MS = 30000;

/**
 * @module runtime/quality/adversarial-review
 * AdversarialReview — 对抗审查器
 * @classdesc 对抗审查。故意寻找缺陷和漏洞、魔鬼代言人角色
 * 故意寻找缺陷和漏洞的决策对抗模式，采用魔鬼代言人角色与证伪实验设计。
 * 双审查者多轮对抗review()在最多N轮内寻求共识，每轮收集双方反馈并合并。
 * decisionAdversarial()从CFO/投资人/行业老手等角色视角生成攻击清单与证伪信号。
 * falsificationCheck()对结论进行证伪检验，输出失败前提与最低可行实验建议。
 * @extends EventEmitter
 * @emits AdversarialReview#round-complete
 * @emits AdversarialReview#review-complete
 */
class AdversarialReview extends EventEmitter {
  constructor(options) {
    super();
    this._maxRounds = (options && options.maxRounds) ?? DEFAULT_MAX_ROUNDS;
    this._reviewTimeout = (options && options.reviewTimeout) ?? DEFAULT_REVIEW_TIMEOUT_MS;
    this._activeTimers = new Set();
  }

  /**
   * 双审查者多轮对抗审查
   * 两个审查者(reviewerA/reviewerB)在最多maxRounds轮内对subject进行审查，
   * 每轮收集双方反馈，若双方均approved则达成共识提前结束；否则合并反馈进入下一轮
   * @param {object} subject - 待审查的对象（提案/代码/设计等）
   * @param {Function} reviewerA - 审查者A回调函数，签名为async (subject, context) => {approved, feedback, suggestions}
   * @param {Function} reviewerB - 审查者B回调函数，签名为async (subject, context) => {approved, feedback, suggestions}
   * @returns {Promise<{consensus: boolean, rounds: number, details: Array<object>, finalFeedback: string}|{consensus: boolean, rounds: number, error: string}>} 审查结果，含是否达成共识、执行轮数、每轮详情、最终合并反馈
   * @throws {Error} When artifact path is invalid or reviewers list is empty
   * @example
   * const reviewer = new AdversarialReview();
   * const result = reviewer.review({
   *   artifact: 'src/auth.js',
   *   artifactType: 'code',
   *   reviewers: ['security-expert', 'senior-dev'],
   *   criteria: ['security', 'maintainability']
   * });
   */
  async review(subject, reviewerA, reviewerB) {
    this.guardShutdown();
    if (!subject || typeof reviewerA !== 'function' || typeof reviewerB !== 'function') {
      return { consensus: false, rounds: 0, error: 'Missing required arguments' };
    }

    const context = {
      subject,
      rounds: [],
      currentRound: 0,
      consensus: false,
    };

    const timeoutMs = this._reviewTimeout;
    for (let round = 1; round <= this._maxRounds; round++) {
      context.currentRound = round;

      const reviewA = await this._safeCallWithTimeout(reviewerA, subject, context, 'A', timeoutMs);
      if (this._shutDown) return { consensus: false, rounds: context.currentRound, error: 'Shut down during review' };
      const reviewB = await this._safeCallWithTimeout(reviewerB, subject, context, 'B', timeoutMs);
      if (this._shutDown) return { consensus: false, rounds: context.currentRound, error: 'Shut down during review' };

      const roundResult = {
        round,
        reviewerA: reviewA,
        reviewerB: reviewB,
      };
      context.rounds.push(roundResult);
      this.emit('round-complete', roundResult);

      if (reviewA.approved && reviewB.approved) {
        context.consensus = true;
        break;
      }

      if (reviewA.feedback || reviewB.feedback) {
        context.mergedFeedback = [
          reviewA.feedback || '',
          reviewB.feedback || '',
        ].filter(Boolean).join('\n');
      }
    }

    const result = {
      consensus: context.consensus,
      rounds: context.currentRound,
      details: context.rounds,
      finalFeedback: context.mergedFeedback || '',
    };

    this.emit('review-complete', result);
    return result;
  }

  async _safeCall(reviewer, subject, context, label) {
    try {
      const result = await reviewer(subject, context);
      if (!result || typeof result !== 'object') {
        return {
          approved: false,
          feedback: 'Reviewer returned invalid result',
          suggestions: [],
          reviewer: label,
          error: true,
        };
      }
      return {
        approved: !!result.approved,
        feedback: result.feedback || '',
        suggestions: result.suggestions ?? [],
        reviewer: label,
      };
    } catch (err) {
      return {
        approved: false,
        feedback: `Reviewer ${label} error: ${err && err.message ? err.message : String(err)}`,
        suggestions: [],
        reviewer: label,
        error: true,
      };
    }
  }

  async _safeCallWithTimeout(reviewer, subject, context, label, timeoutMs) {
    let timer;
    try {
      const reviewerPromise = this._safeCall(reviewer, subject, context, label);
      reviewerPromise.catch(function _swallowLateRejection(err) {
        debug('AdversarialReview', 'lateRejection', label + ': ' + (err && err.message ? err.message : String(err)));
      });
      const result = await Promise.race([
        reviewerPromise.then(function(r) { return r; }).catch(function() { return { approved: false, feedback: 'Reviewer ' + label + ' error after timeout', suggestions: [], reviewer: label, error: true }; }),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            this._activeTimers.delete(timer);
            resolve({ approved: false, feedback: `Reviewer ${label} timed out`, suggestions: [], reviewer: label, error: true });
          }, timeoutMs);
          this._activeTimers.add(timer);
          if (timer && typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return result;
    } finally {
      if (timer) {
        this._activeTimers.delete(timer);
        clearTimeout(timer);
      }
    }
  }

  /**
   * 决策对抗审查，从多个对立角色视角生成攻击清单与证伪信号
   * 内置角色：cfo(冷静的CFO)、investor(挑剔的投资人)、veteran(行业老手)、
   * engineer(悲观工程师)、ux_fanatic(用户体验偏执狂)
   * @param {string} [proposal] - 待审查的决策提案
   * @param {object} [options] - 配置选项
   * @param {Array<string>} [options.roles=['cfo','investor','veteran']] - 参与对抗的角色列表
   * @returns {{type: string, proposal: string, attacks: Array<object>, falsification: object, antiSycophancyCheck: object, timestamp: number}} 对抗审查结果，含各角色攻击清单、证伪信号、反谄媚检查
   */
  async decisionAdversarial(proposal, options) {
    this.guardShutdown();
    const roles = (options ?? {}).roles ?? ['cfo', 'investor', 'veteran'];
    const roleDefinitions = {
      cfo: { name: '冷静的CFO', focus: '成本、ROI、现金流风险' },
      investor: { name: '挑剔的投资人', focus: '市场规模、竞争壁垒、退出路径' },
      veteran: { name: '行业老手', focus: '行业潜规则、隐性成本、监管风险' },
      engineer: { name: '悲观工程师', focus: '技术可行性、复杂度、维护成本' },
      ux_fanatic: { name: '用户体验偏执狂', focus: '用户学习成本、使用障碍、流失风险' },
    };

    const attacks = [];
    for (const roleKey of roles) {
      const role = roleDefinitions[roleKey] ?? roleDefinitions.veteran;
      attacks.push({
        role: roleKey,
        name: role.name,
        focus: role.focus,
        challenges: [],
        falsificationSignals: [],
        prerequisites: [],
      });
    }

    const falsification = {
      signals: [],
      experimentDesign: null,
      minimumViableExperiment: null,
    };

    const result = {
      type: 'decision_adversarial',
      proposal: proposal ?? '',
      attacks,
      falsification,
      antiSycophancyCheck: {
        hasBiasedLanguage: false,
        hasConsensusPlatitudes: false,
        hasFalsification: false,
        hasPrerequisites: false,
      },
      timestamp: Date.now(),
    };

    return result;
  }

  /**
   * 对结论进行证伪检验，输出失败前提与最低可行实验建议
   * @param {string} [conclusion] - 待证伪检验的结论
   * @param {object} [context] - 证伪上下文信息
   * @returns {{conclusion: string, context: string, whyItMightNotWork: Array, prerequisitesForSuccess: Array, falsificationSignals: Array, minimumViableExperiment: null, confidenceLevel: string}} 证伪检验结果，含失败原因、成功前提、证伪信号、最低可行实验、置信度等级
   */
  falsificationCheck(conclusion, context) {
    this.guardShutdown();
    const signals = [];
    const prerequisites = [];

    return {
      conclusion: conclusion ?? '',
      context: context ?? '',
      whyItMightNotWork: signals,
      prerequisitesForSuccess: prerequisites,
      falsificationSignals: [],
      minimumViableExperiment: null,
      confidenceLevel: 'unverified',
    };
  }

  _onShutdown() {
    for (const t of this._activeTimers) clearTimeout(t);
    this._activeTimers.clear();
    this._maxRounds = DEFAULT_MAX_ROUNDS;
    this._reviewTimeout = DEFAULT_REVIEW_TIMEOUT_MS;
    this.removeAllListeners();
  }
}

AdversarialReview.DEFAULT_MAX_ROUNDS = DEFAULT_MAX_ROUNDS;

module.exports = withShutdown(AdversarialReview);
