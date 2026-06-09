'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { UTF8_ENCODING, HARNESS_DIR, MAX_IMPROVEMENT_ITEMS } = require('../../utils/constants');
const { writeAtomicTextAsync } = require('../../utils/debounced-persister');
const { emitError } = require('../../utils/safe-execute');

/** 触发自动改进所需的最少学习记录条数 */
const AUTO_IMPROVE_THRESHOLD = 3;
/** 飞轮第一道门：成功率阈值，学习记录数需达到此值才进入回测阶段 */
const FLYWHEEL_SUCCESS_THRESHOLD = 5;
/** 飞轮第二道门：回测最低通过率，最近学习记录中带成功技巧的比例需达到此阈值 */
const FLYWHEEL_BACKTEST_MIN_RATE = 0.6;
/** 飞轮第三道门：AB测试所需的最少轮次 */
const FLYWHEEL_AB_TEST_ROUNDS = 10;
/** 飞轮第三道门：AB测试最低改进率，改进比例需达到此值才可通过 */
const FLYWHEEL_AB_MIN_IMPROVEMENT = 0.1;
/** 技能备份文件存储目录（相对于项目根目录） */
const SKILL_BACKUP_DIR = HARNESS_DIR + '/skills/.backups';
/** 技能文件中自动改进段落的标记，用于定位和替换改进内容 */
const IMPROVEMENT_MARKER = '<!-- auto-improvement-section -->';
/** 每个技能最多保留的备份数量 */
const MAX_BACKUPS_PER_SKILL = 5;
/** 待审批补丁队列的最大容量 */
const MAX_PENDING_PATCHES = 100;
const MAX_FLYWHEEL_ENTRIES = 200;

/**
 * @module runtime/skill/skill-improvement-loop
 * 技能改进循环——基于执行经验持续迭代优化技能定义。
 *
 * 实现飞轮三道门验证机制：成功率阈值 → 回测 → AB测试，
 * 只有全部通过的技能改进才会被提升（promoted）到正式技能文件中。
 * 支持补丁审批流程（PatchApproval）和因果数据总线（CausalBus）集成。
 *
 * @extends EventEmitter
 * @emits {object} learning-recorded - 学习记录已保存，载荷包含 skillId 和 id
 * @emits {object} improvement-submitted-for-approval - 改进补丁已提交审批，载荷包含 skillId、tipCount、avoidanceCount、learningCount
 * @emits {object} improvement-suggested - 改进补丁已生成（无审批模式），载荷包含 skillId、tipCount、avoidanceCount、learningCount
 * @emits {object} improvement-applied - 改进补丁已应用到技能文件，载荷包含 skillId、tipCount、avoidanceCount
 * @emits {object} improvement-rejected - 改进补丁已被拒绝，载荷包含 skillId
 * @emits {object} flywheel-gate1-passed - 飞轮第一道门通过，载荷包含 skillId、successCount、tipCount
 * @emits {object} flywheel-gate2-passed - 飞轮第二道门通过，载荷包含 skillId、backtestRate、samples
 * @emits {object} flywheel-gate3-passed - 飞轮第三道门通过，载荷包含 skillId、improvementRate、rounds
 * @emits {object} skill-backed-up - 技能文件已备份，载荷包含 skillId、backupPath
 * @emits {object} learning-error - 学习记录写入出错，载荷包含 error 和 skillId
 */
class SkillImprovementLoop extends EventEmitter {
  /**
   * 创建 SkillImprovementLoop 实例。
   * @param {object} [options] - 初始化选项
   * @param {object} [options.sqliteStore] - SQLite存储实例，用于持久化学习记录
   * @param {object} [options.skillRouter] - SkillRouter实例，用于查找和重新加载技能定义
   * @param {string} [options.projectRoot] - 项目根目录路径
   * @param {object} [options.patchApproval] - 补丁审批器实例，用于管理改进补丁的审批流程
   * @param {object} [options.causalBus] - 因果数据总线实例，用于发布学习事件
   */
  constructor(options) {
    super();
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._skillRouter = (options && options.skillRouter) ?? null;
    this._projectRoot = (options && options.projectRoot) || '';
    this._patchApproval = (options && options.patchApproval) ?? null;
    this._causalBus = (options && options.causalBus) ?? null;
    this._pendingPatches = Object.create(null);
    this._pendingPatchOrder = [];
    this._flywheelState = Object.create(null);
    this._flywheelStats = { draftsGenerated: 0, backtestsPassed: 0, abTestsPassed: 0, skillsPromoted: 0 };
  }

  /**
   * 挂载SQLite存储实例，支持链式调用。
   * @param {object} store - SQLite存储实例
   * @returns {SkillImprovementLoop} 当前实例，支持链式调用
   */
  attachSqliteStore(store) {
    this._sqliteStore = store;
    return this;
  }

  /**
   * 挂载SkillRouter实例，支持链式调用。
   * @param {object} router - SkillRouter实例
   * @returns {SkillImprovementLoop} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    this._skillRouter = router;
    return this;
  }

  /**
   * 挂载补丁审批器实例，支持链式调用。
   * @param {object} pa - 补丁审批器实例
   * @returns {SkillImprovementLoop} 当前实例，支持链式调用
   */
  attachPatchApproval(pa) {
    this._patchApproval = pa;
    return this;
  }

  /**
   * 挂载因果数据总线实例，支持链式调用。
   * @param {object} bus - 因果数据总线实例
   * @returns {SkillImprovementLoop} 当前实例，支持链式调用
   */
  attachCausalBus(bus) {
    this._causalBus = bus;
    return this;
  }

  /**
   * 注入SkillDistiller实例，建立蒸馏-eval闭环。
   * 当飞轮三道门全部通过（skill promoted）时，自动触发重新蒸馏，
   * 将改进后的技能经验反馈到蒸馏管道，形成"eval→蒸馏→重写→再eval"的闭环。
   * @param {Object} distiller - SkillDistiller实例
   * @returns {SkillImprovementLoop} this（支持链式调用）
   */
  attachSkillDistiller(distiller) {
    this._skillDistiller = distiller;
    return this;
  }

  /**
   * 记录一条学习经验（成功技巧或失败避坑），并在达到阈值时自动触发改进流程。
   * @param {object} entry - 学习记录条目
   * @param {string} entry.skillId - 关联的技能标识
   * @param {string} [entry.agentId] - 产生此经验的Agent标识
   * @param {string} [entry.whatWorked] - 成功技巧描述
   * @param {string} [entry.whatFailed] - 失败避坑描述
   * @returns {object} 写入结果，包含 id 字段；失败时包含 error 字段
   */
  recordLearning(entry) {
    if (this._shutDown) {
      return { id: 0, error: 'SkillImprovementLoop is shut down' };
    }
    if (!entry || typeof entry !== 'object' || !entry.skillId || typeof entry.skillId !== 'string') {
      return { id: 0, error: 'entry.skillId is required and must be a string' };
    }
    try {
      if (this._sqliteStore) {
        const r = this._sqliteStore.addSkillLearning(entry);
        this._checkAutoImprove(entry.skillId);
        if (r && r.id) {
          this.emit('learning-recorded', { skillId: entry.skillId, id: r.id });
        }
        if (this._causalBus && typeof this._causalBus.publish === 'function') {
          this._causalBus.publish('skill:learning-recorded', {
            skillId: entry.skillId,
            agentId: entry.agentId,
            tips: entry.whatWorked,
            avoidances: entry.whatFailed,
          }).catch(function(err) {
            debug('SkillImprovementLoop', 'causalPublish', err && err.message ? err.message : String(err));
          });
        }
        return r;
      }
      return { id: 0, ...entry };
    } catch (err) {
      emitError(this, 'learning-error', err, { skillId: entry.skillId });
      return { id: 0, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 获取指定技能的全部学习记录。
   * @param {string} skillId - 技能标识
   * @returns {Array<object>} 学习记录数组；无存储时返回空数组
   */
  getLearnings(skillId) {
    if (this._sqliteStore) return this._sqliteStore.getSkillLearnings(skillId);
    return [];
  }

  /**
   * 获取指定技能的成功技巧列表。
   * @param {string} skillId - 技能标识
   * @returns {Array<string>} 成功技巧数组；无存储时返回空数组
   */
  getTips(skillId) {
    if (this._sqliteStore) return this._sqliteStore.getSkillTips(skillId);
    return [];
  }

  /**
   * 获取指定技能的避坑指南列表。
   * @param {string} skillId - 技能标识
   * @returns {Array<string>} 避坑指南数组；无存储时返回空数组
   */
  getAvoidances(skillId) {
    if (this._sqliteStore) return this._sqliteStore.getSkillAvoidances(skillId);
    return [];
  }

  /**
   * 获取指定技能的上下文提示文本，将成功技巧和避坑指南格式化为可注入Prompt的字符串。
   * @param {string} skillId - 技能标识
   * @returns {string} 格式化的上下文文本；无数据时返回空字符串
   */
  getTipsForContext(skillId) {
    const tips = this.getTips(skillId);
    const avoidances = this.getAvoidances(skillId);
    if (tips.length === 0 && avoidances.length === 0) return '';
    let ctx = '';
    if (tips.length > 0) ctx += '成功技巧: ' + tips.slice(0, MAX_IMPROVEMENT_ITEMS).join('; ');
    if (avoidances.length > 0) ctx += (ctx ? '\n' : '') + '避坑指南: ' + avoidances.slice(0, MAX_IMPROVEMENT_ITEMS).join('; ');
    return ctx;
  }

  /**
   * 获取指定技能的共享学习记录（来自其他项目或团队）。
   * @param {string} skillId - 技能标识
   * @returns {Array<object>} 共享学习记录数组；无存储时返回空数组
   */
  getSharedLearnings(skillId) {
    if (this._sqliteStore) return this._sqliteStore.getSharedSkillLearnings(skillId);
    return [];
  }

  /**
   * 获取指定技能的合并上下文提示文本，包含本地和共享的成功技巧与避坑指南。
   * @param {string} skillId - 技能标识
   * @returns {string} 合并格式化的上下文文本；无数据时返回空字符串
   */
  getSharedTipsForContext(skillId) {
    const localTips = this.getTips(skillId);
    const localAvoidances = this.getAvoidances(skillId);
    const sharedLearnings = this.getSharedLearnings(skillId);
    const sharedTips = sharedLearnings.map(l => l.tips).filter(Boolean);
    const sharedAvoidances = sharedLearnings.map(l => l.avoidances).filter(Boolean);
    const allTips = [...localTips, ...sharedTips];
    const allAvoidances = [...localAvoidances, ...sharedAvoidances];
    if (allTips.length === 0 && allAvoidances.length === 0) return '';
    let ctx = '';
    if (allTips.length > 0) ctx += '成功技巧: ' + allTips.slice(0, MAX_IMPROVEMENT_ITEMS).join('; ');
    if (allAvoidances.length > 0) ctx += (ctx ? '\n' : '') + '避坑指南: ' + allAvoidances.slice(0, MAX_IMPROVEMENT_ITEMS).join('; ');
    return ctx;
  }

  /**
   * 检查指定技能的学习记录数是否达到自动改进阈值，若达到则生成改进补丁。
   * 有 patchApproval 时提交审批，否则加入待审批队列。
   * @param {string} skillId - 技能标识
   * @returns {void}
   */
  _checkAutoImprove(skillId) {
    if (this._shutDown) return;
    if (!this._sqliteStore) return;
    const count = this._sqliteStore.getSkillLearningCount(skillId);
    if (count < AUTO_IMPROVE_THRESHOLD) return;

    const tips = this.getTips(skillId);
    const avoidances = this.getAvoidances(skillId);
    if (tips.length === 0 && avoidances.length === 0) return;

    if (this._patchApproval) {
      const existing = this._patchApproval.getApprovedPatchForSkill(skillId);
      if (existing) return;
      const pendingPatches = this._patchApproval.getPendingPatches();
      const alreadyPending = pendingPatches.some(function(p) { return p.skillId === skillId; });
      if (alreadyPending) return;
      this._patchApproval.submit(skillId, { tips: tips, avoidances: avoidances, count: count });
      this.emit('improvement-submitted-for-approval', {
        skillId: skillId,
        tipCount: tips.length,
        avoidanceCount: avoidances.length,
        learningCount: count,
      });
    } else {
      if (this._pendingPatchOrder.length >= MAX_PENDING_PATCHES && !this._pendingPatches[skillId]) {
        const oldestKey = this._pendingPatchOrder.shift();
        delete this._pendingPatches[oldestKey];
      }
      if (!this._pendingPatches[skillId]) {
        this._pendingPatches[skillId] = { tips: tips, avoidances: avoidances, count: count, suggestedAt: Date.now() };
        this._pendingPatchOrder.push(skillId);
        this.emit('improvement-suggested', {
          skillId: skillId,
          tipCount: tips.length,
          avoidanceCount: avoidances.length,
          learningCount: count,
        });
      } else {
        this._pendingPatches[skillId].tips = tips;
        this._pendingPatches[skillId].avoidances = avoidances;
        this._pendingPatches[skillId].count = count;
      }
    }
  }

  /**
   * 获取所有待审批的改进补丁（浅拷贝）。
   * @returns {object} 以 skillId 为键、补丁数据为值的对象副本
   */
  getPendingPatches() {
    const result = {};
    for (const [k, v] of Object.entries(this._pendingPatches)) {
      result[k] = { ...v, tips: v.tips ? v.tips.slice() : [], avoidances: v.avoidances ? v.avoidances.slice() : [] };
    }
    return result;
  }

  /**
   * 查询指定技能的飞轮门禁状态。
   * @param {string} skillId - 技能标识
   * @returns {object} 门禁状态对象，包含 gate（当前门禁阶段）、reason（原因说明）、stats（统计数据）
   */
  checkFlywheelGate(skillId) {
    if (!this._sqliteStore) return { gate: 'none', reason: 'no store' };
    const state = this._flywheelState[skillId];
    if (!state) return { gate: 'none', reason: 'no state' };
    return { gate: state.currentGate, reason: state.reason || '', stats: state.stats ?? {} };
  }

  /**
   * 评估飞轮第一道门：成功率阈值。学习记录数达到 FLYWHEEL_SUCCESS_THRESHOLD 且存在技巧或避坑数据时通过。
   * 通过后将技能状态推进到回测（backtest）阶段。
   * @param {string} skillId - 技能标识
   * @returns {boolean} 是否通过第一道门
   */
  _evaluateFlywheelGate1(skillId) {
    if (!this._sqliteStore) return false;
    const successCount = this._sqliteStore.getSkillLearningCount(skillId);
    if (successCount < FLYWHEEL_SUCCESS_THRESHOLD) return false;

    const tips = this.getTips(skillId);
    const avoidances = this.getAvoidances(skillId);
    if (tips.length === 0 && avoidances.length === 0) return false;

    const keys = Object.keys(this._flywheelState);
    if (keys.length >= MAX_FLYWHEEL_ENTRIES) {
      let evicted = false;
      for (const k of keys) {
        const s = this._flywheelState[k];
        if (s.currentGate === 'promoted' || s.currentGate === 'failed') {
          delete this._flywheelState[k];
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        delete this._flywheelState[keys[0]];
      }
    }

    this._flywheelState[skillId] = {
      currentGate: 'backtest',
      tips: tips,
      avoidances: avoidances,
      successCount: successCount,
      reason: 'Gate 1 passed: ' + successCount + ' successes >= ' + FLYWHEEL_SUCCESS_THRESHOLD,
      stats: { tipCount: tips.length, avoidanceCount: avoidances.length },
      backtestResults: null,
      abTestResults: null,
    };
    this._flywheelStats.draftsGenerated++;
    this.emit('flywheel-gate1-passed', { skillId, successCount, tipCount: tips.length });
    return true;
  }

  /**
   * 评估飞轮第二道门：回测。验证最近学习记录中带成功技巧的比例是否达到 FLYWHEEL_BACKTEST_MIN_RATE。
   * 通过后将技能状态推进到AB测试（ab-test）阶段。
   * @param {string} skillId - 技能标识
   * @returns {boolean} 是否通过第二道门
   */
  _evaluateFlywheelGate2(skillId) {
    const state = this._flywheelState[skillId];
    if (!state || state.currentGate !== 'backtest') return false;

    const learnings = this.getLearnings(skillId);
    if (!Array.isArray(learnings) || learnings.length < 3) {
      state.reason = 'Gate 2 blocked: insufficient learning data for backtest';
      return false;
    }

    const recentLearnings = learnings.slice(-10);
    let successWithTips = 0;
    const totalRecent = recentLearnings.length;
    for (const l of recentLearnings) {
      if (l.whatWorked && l.whatWorked.length > 0) successWithTips++;
    }
    const backtestRate = totalRecent > 0 ? successWithTips / totalRecent : 0;

    if (backtestRate < FLYWHEEL_BACKTEST_MIN_RATE) {
      state.reason = 'Gate 2 blocked: backtest rate ' + backtestRate.toFixed(2) + ' < ' + FLYWHEEL_BACKTEST_MIN_RATE;
      return false;
    }

    state.currentGate = 'ab-test';
    state.backtestResults = { rate: backtestRate, samples: totalRecent };
    state.reason = 'Gate 2 passed: backtest rate ' + backtestRate.toFixed(2) + ' >= ' + FLYWHEEL_BACKTEST_MIN_RATE;
    this._flywheelStats.backtestsPassed++;
    this.emit('flywheel-gate2-passed', { skillId, backtestRate, samples: totalRecent });
    return true;
  }

  /**
   * 评估飞轮第三道门：AB测试。验证AB测试轮次是否达到 FLYWHEEL_AB_TEST_ROUNDS 且改进率不低于 FLYWHEEL_AB_MIN_IMPROVEMENT。
   * 通过后将技能状态标记为 promoted（已提升），未通过则标记为 failed。
   * @param {string} skillId - 技能标识
   * @returns {boolean} 是否通过第三道门
   */
  _evaluateFlywheelGate3(skillId) {
    const state = this._flywheelState[skillId];
    if (!state || state.currentGate !== 'ab-test') return false;

    if (!state.abTestResults) {
      state.abTestResults = { rounds: 0, improvements: 0 };
    }

    if (state.abTestResults.rounds < FLYWHEEL_AB_TEST_ROUNDS) {
      state.reason = 'Gate 3 in progress: ' + state.abTestResults.rounds + '/' + FLYWHEEL_AB_TEST_ROUNDS + ' rounds';
      return false;
    }

    const rounds = state.abTestResults.rounds;
    const improvements = state.abTestResults.improvements;
    if (rounds <= 0 || !Number.isFinite(rounds) || improvements < 0 || !Number.isFinite(improvements) || improvements > rounds) {
      state.reason = 'Gate 3 blocked: invalid AB test data (rounds=' + rounds + ', improvements=' + improvements + ')';
      state.currentGate = 'failed';
      return false;
    }

    const improvementRate = improvements / rounds;
    if (!Number.isFinite(improvementRate)) {
      state.reason = 'Gate 3 blocked: improvement rate is not finite';
      state.currentGate = 'failed';
      return false;
    }

    if (improvementRate < FLYWHEEL_AB_MIN_IMPROVEMENT) {
      state.reason = 'Gate 3 blocked: improvement rate ' + improvementRate.toFixed(2) + ' < ' + FLYWHEEL_AB_MIN_IMPROVEMENT;
      state.currentGate = 'failed';
      return false;
    }

    state.currentGate = 'promoted';
    state.reason = 'Gate 3 passed: improvement rate ' + improvementRate.toFixed(2) + ' >= ' + FLYWHEEL_AB_MIN_IMPROVEMENT;
    this._flywheelStats.abTestsPassed++;
    this._flywheelStats.skillsPromoted++;
    this.emit('flywheel-gate3-passed', { skillId, improvementRate, rounds: state.abTestResults.rounds });

    // 蒸馏-eval闭环：飞轮三道门通过后自动触发重新蒸馏
    this._triggerRedistillation(skillId);

    return true;
  }

  /**
   * 记录一次AB测试结果，并自动评估飞轮第三道门是否通过。
   * @param {string} skillId - 技能标识
   * @param {boolean} improved - 本次AB测试是否产生了改进
   * @returns {boolean} 是否成功记录（技能不在AB测试阶段时返回 false）
   */
  recordABTestResult(skillId, improved) {
    const state = this._flywheelState[skillId];
    if (!state || state.currentGate !== 'ab-test' || !state.abTestResults) return false;
    state.abTestResults.rounds++;
    if (improved) state.abTestResults.improvements++;
    this._evaluateFlywheelGate3(skillId);
    return true;
  }

  /**
   * 蒸馏-eval闭环：飞轮三道门通过后自动触发重新蒸馏。
   * 将改进后的技能经验反馈到蒸馏管道，形成"eval→蒸馏→重写→再eval"的闭环。
   * 如果SkillDistiller未注入或蒸馏失败，静默降级（不影响飞轮主流程）。
   * @param {string} skillId - 已通过飞轮验证的技能标识
   * @private
   */
  _triggerRedistillation(skillId) {
    if (!this._skillDistiller || typeof this._skillDistiller.distillSkill !== 'function') return;
    try {
      this._skillDistiller.distillSkill(skillId, { triggeredBy: 'flywheel-promotion' }).catch(function(err) {
        debug('SkillImprovementLoop', '_triggerRedistillation', skillId, err && err.message ? err.message : String(err));
      });
      debug('SkillImprovementLoop', '_triggerRedistillation', skillId, 'redistillation triggered after flywheel promotion');
    } catch (err) {
      debug('SkillImprovementLoop', '_triggerRedistillation', skillId, 'trigger failed:', err && err.message ? err.message : String(err));
    }
  }

  /**
   * 获取飞轮验证的汇总统计信息（浅拷贝）。
   * @returns {object} 统计对象，包含 draftsGenerated、backtestsPassed、abTestsPassed、skillsPromoted
   */
  getFlywheelStats() {
    return { ...this._flywheelStats };
  }

  /**
   * 将Markdown内容拆分为frontmatter（YAML头）和正文两部分。
   * @param {string} content - 完整的Markdown文件内容
   * @returns {object} 拆分结果，包含 frontmatter（YAML头字符串，含分隔符）和 body（正文内容）
   */
  _splitFrontmatter(content) {
    if (!content.startsWith('---')) {
      return { frontmatter: '', body: content };
    }
    const pos1 = content.indexOf('\r\n---', 3);
    const pos2 = content.indexOf('\n---', 3);
    let secondSep = -1;
    if (pos1 !== -1 && pos2 !== -1) secondSep = Math.min(pos1, pos2);
    else if (pos1 !== -1) secondSep = pos1;
    else secondSep = pos2;
    if (secondSep === -1) {
      return { frontmatter: '', body: content };
    }
    const sepEnd = content[secondSep] === '\r' ? secondSep + 5 : secondSep + 4;
    const frontmatter = content.substring(0, sepEnd);
    const body = content.substring(sepEnd).trim();
    return { frontmatter, body };
  }

  /**
   * 将已审批的改进补丁应用到技能文件。若配置了 patchApproval 则使用审批流程，否则需手动传入 skipApproval。
   * @param {string} skillId - 技能标识
   * @param {object} [options] - 应用选项
   * @param {boolean} [options.skipApproval] - 跳过审批（仅在无 patchApproval 时需设为 true）
   * @returns {Promise<object>} 应用结果，成功时包含 success: true、tipsAdded、avoidancesAdded；失败时包含 success: false 和 error
   */
  async applyPatch(skillId, options) {
    if (this._shutDown) {
      return { success: false, error: 'SkillImprovementLoop is shut down' };
    }
    if (this._patchApproval) {
      const approvedPatch = this._patchApproval.getApprovedPatchForSkill(skillId);
      if (!approvedPatch) {
        return { success: false, error: 'No approved patch for ' + skillId };
      }
      const patch = { tips: approvedPatch.tips, avoidances: approvedPatch.avoidances, count: approvedPatch.learningCount ?? (approvedPatch.count ?? 0) };
      const result = await this._applyPatchToSkill(skillId, patch);
      if (result.success) {
        this._patchApproval.markApplied(approvedPatch.patchId);
      }
      return result;
    }

    const patch = this._pendingPatches[skillId];
    if (!patch) return { success: false, error: 'No pending patch for ' + skillId };
    if (!this._patchApproval && !(options && options.skipApproval)) {
      return { success: false, error: 'Cannot apply improvement without approval: configure patchApproval or pass { skipApproval: true } after manual review' };
    }
    const result = await this._applyPatchToSkill(skillId, patch);
    if (result.success) {
      delete this._pendingPatches[skillId];
      const idx = this._pendingPatchOrder.indexOf(skillId);
      if (idx !== -1) this._pendingPatchOrder.splice(idx, 1);
    }
    return result;
  }

  /**
   * 将改进补丁实际写入技能Markdown文件。先备份原文件，再在正文中插入或替换自动改进段落。
   * @param {string} skillId - 技能标识
   * @param {object} patch - 补丁数据
   * @param {Array<string>} patch.tips - 成功技巧列表
   * @param {Array<string>} patch.avoidances - 避坑指南列表
   * @param {number} patch.count - 学习记录条数
   * @returns {Promise<object>} 应用结果，成功时包含 success: true、tipsAdded、avoidancesAdded；失败时包含 success: false 和 error
   */
  async _applyPatchToSkill(skillId, patch) {
    const precheck = this._precheckPatchPrereqs(skillId);
    if (!precheck.ok) return { success: false, error: precheck.error };

    const accessOk = await this._checkSkillFileAccess(precheck.skillPath);
    if (!accessOk.ok) return { success: false, error: accessOk.error };

    const backupOk = await this._backupSkillSafe(skillId, precheck.skillPath);
    if (!backupOk.ok) return { success: false, error: backupOk.error };
    if (this._shutDown) return { success: false, error: 'Shut down during patch' };

    const readResult = await this._readSkillFile(precheck.skillPath);
    if (!readResult.ok) return { success: false, error: readResult.error };
    if (this._shutDown) return { success: false, error: 'Shut down during patch' };

    const newContent = this._composePatchedContent(readResult.content, patch);
    try {
      await writeAtomicTextAsync(precheck.skillPath, newContent, UTF8_ENCODING);
    } catch (writeErr) {
      return { success: false, error: 'Failed to write skill file: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)) };
    }

    if (this._skillRouter && typeof this._skillRouter.discoverAsync === 'function') {
      try { await this._skillRouter.discoverAsync(); } catch (discErr) { debug('SkillImprovementLoop', 'applyPatch', 'discover failed: ' + (discErr && discErr.message ? discErr.message : String(discErr))); }
    }
    if (this._shutDown) return { success: false, error: 'Shut down during patch' };

    this.emit('improvement-applied', { skillId: skillId, tipCount: patch.tips.length, avoidanceCount: patch.avoidances.length });
    return { success: true, skillId: skillId, tipsAdded: patch.tips.length, avoidancesAdded: patch.avoidances.length };
  }

  _precheckPatchPrereqs(skillId) {
    if (!this._skillRouter || !this._skillRouter.registry || !this._projectRoot) {
      return { ok: false, error: 'SkillRouter or projectRoot not attached' };
    }
    const skill = this._skillRouter.registry[skillId];
    if (!skill) return { ok: false, error: 'Skill not found: ' + skillId };
    const skillPath = skill._filePath;
    if (!skillPath) return { ok: false, error: 'Skill file path not found' };
    return { ok: true, skillPath };
  }

  async _checkSkillFileAccess(skillPath) {
    try {
      await fsp.access(skillPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'Skill file not found: ' + (err?.message ?? String(err)) };
    }
  }

  async _backupSkillSafe(skillId, skillPath) {
    try {
      await this._backupSkill(skillId, skillPath);
      return { ok: true };
    } catch (backupErr) {
      debug('SkillImprovementLoop', 'backupFailed', backupErr && backupErr.message ? backupErr.message : String(backupErr));
      return { ok: false, error: 'Failed to backup skill: ' + (backupErr && backupErr.message ? backupErr.message : String(backupErr)) };
    }
  }

  async _readSkillFile(skillPath) {
    try {
      const content = await fsp.readFile(skillPath, UTF8_ENCODING);
      return { ok: true, content };
    } catch (readErr) {
      return { ok: false, error: 'Failed to read skill file: ' + (readErr?.message ?? String(readErr)) };
    }
  }

  _composePatchedContent(originalContent, patch) {
    const splitResult = this._splitFrontmatter(originalContent);
    const frontmatter = splitResult.frontmatter;
    const body = splitResult.body;
    const markerIndex = body.indexOf(IMPROVEMENT_MARKER);
    const improvement = this._buildImprovementSection(patch);
    let newBody;
    if (markerIndex !== -1) {
      const beforeMarker = body.substring(0, markerIndex).trim();
      newBody = beforeMarker + '\n\n' + IMPROVEMENT_MARKER + '\n' + improvement + '\n';
    } else {
      newBody = body + '\n\n' + IMPROVEMENT_MARKER + '\n' + improvement + '\n';
    }
    return frontmatter + (frontmatter ? '\n' : '') + newBody;
  }

  /**
   * 根据补丁数据构建自动改进段落的Markdown文本，包含成功技巧和避坑指南。
   * @param {object} patch - 补丁数据
   * @param {Array<string>} patch.tips - 成功技巧列表
   * @param {Array<string>} patch.avoidances - 避坑指南列表
   * @param {number} patch.count - 学习记录条数
   * @returns {string} 生成的Markdown改进段落文本
   */
  _buildImprovementSection(patch) {
    let improvement = `> 基于${patch.count}次执行经验自动生成 (${new Date().toISOString().split('T')[0]})\n\n`;
    if (patch.tips.length > 0) {
      improvement += '### 成功技巧\n';
      for (const tip of patch.tips.slice(0, MAX_IMPROVEMENT_ITEMS)) {
        improvement += `- ${tip}\n`;
      }
    }
    if (patch.avoidances.length > 0) {
      improvement += '\n### 避坑指南\n';
      for (const av of patch.avoidances.slice(0, MAX_IMPROVEMENT_ITEMS)) {
        improvement += `- ${av}\n`;
      }
    }
    return improvement;
  }

  /**
   * 拒绝并移除指定技能的待审批改进补丁。
   * @param {string} skillId - 技能标识
   * @returns {boolean} 是否成功拒绝（无待审批补丁时返回 false）
   */
  rejectPatch(skillId) {
    if (this._shutDown) return false;
    if (this._pendingPatches[skillId]) {
      delete this._pendingPatches[skillId];
      const idx = this._pendingPatchOrder.indexOf(skillId);
      if (idx !== -1) this._pendingPatchOrder.splice(idx, 1);
      this.emit('improvement-rejected', { skillId });
      return true;
    }
    return false;
  }

  /**
   * 备份技能文件到备份目录，超出 MAX_BACKUPS_PER_SKILL 时自动删除最旧的备份。
   * @param {string} skillId - 技能标识
   * @param {string} skillPath - 技能文件完整路径
   * @returns {Promise<void>} 备份完成；复制失败时抛出异常
   */
  async _backupSkill(skillId, skillPath) {
    const backupDir = path.join(this._projectRoot, SKILL_BACKUP_DIR);
    await fsp.mkdir(backupDir, { recursive: true });

    try {
      const backupFiles = (await fsp.readdir(backupDir))
        .filter(function(f) { return f.startsWith(skillId + '.') && f.endsWith('.md'); })
        .sort(function(a, b) { const ta = parseInt(a.slice(a.lastIndexOf('.') + 1, -3), 10) || 0; const tb = parseInt(b.slice(b.lastIndexOf('.') + 1, -3), 10) || 0; return ta - tb; });
      while (backupFiles.length >= MAX_BACKUPS_PER_SKILL) {
        const toDelete = backupFiles.shift();
        await fsp.unlink(path.join(backupDir, toDelete)).catch(function(err) { debug('SkillImprovementLoop', 'backupDelete', err && err.message ? err.message : String(err)); });
      }
    } catch (err) {
      debug('SkillImprovementLoop', 'backupCleanup', err);
    }

    const ts = Date.now();
    const backupPath = path.join(backupDir, `${skillId}.${ts}.md`);
    try {
      await fsp.copyFile(skillPath, backupPath);
    } catch (copyErr) {
      debug('SkillImprovementLoop', 'backupCopyFailed', copyErr && copyErr.message);
      throw copyErr;
    }
    this.emit('skill-backed-up', { skillId, backupPath });
  }

  /**
   * 获取改进循环的运行统计信息，包括待审批补丁数、学习记录总数、共享学习数和飞轮统计。
   * @returns {object} 统计对象，包含 pendingPatches、totalLearnings、sharedLearnings、autoImproveThreshold、flywheel
   */
  getStats() {
    const pending = this._pendingPatchOrder.length;
    let totalLearnings = 0;
    let sharedLearnings = 0;
    if (this._sqliteStore) {
      try {
        const stats = this._sqliteStore.getStats();
        totalLearnings = stats.skillLearnings;
        sharedLearnings = stats.sharedLearnings ?? 0;
      } catch (err) {
        debug('SkillImprovementLoop', 'getStats', err);
      }
    }
    return { pendingPatches: pending, totalLearnings, sharedLearnings, autoImproveThreshold: AUTO_IMPROVE_THRESHOLD, flywheel: { ...this._flywheelStats } };
  }

  _onShutdown() {
    this._pendingPatches = Object.create(null);
    this._pendingPatchOrder = [];
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SkillImprovementLoop);
