'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, safeExecute } = require('../../utils/safe-execute');
const { timestampId } = require('../../utils/unique-id');
const DebouncedPersister = require('../../utils/debounced-persister');
const JsonStoreRestorer = require('../../utils/json-store-restorer');
const { MS_PER_DAY } = require('../../utils/constants');

const MAX_ENTRIES = 5000;
const HEALTH_MAX_ENTRIES = 10000;
const AUDIT_SUBDIR = 'skills/.audit';
const AUDIT_FILENAME = 'audit-trail.json';
const VALID_ACTIONS = new Set([
  'created', 'modified', 'deleted', 'classified', 'pinned', 'unpinned',
  'evolved', 'improved', 'promoted', 'rolled_back', 'canary_enabled', 'canary_disabled',
]);
const VALID_ACTORS = new Set(['system', 'user', 'agent', 'evolver', 'improver', 'curator', 'canary']);
const RISK_THRESHOLD_HIGH = 10;
const RISK_THRESHOLD_MEDIUM = 5;
const RISK_WINDOW_MS = 7 * MS_PER_DAY;

/**
 * @module runtime/skill/skill-audit-trail
 * SkillAuditTrail — 技能统一审计轨迹模块
 * 记录技能文件的所有变更操作，提供变更历史查询、影响分析、审计报告生成等能力。
 * 支持防抖持久化到.harness/skills/.audit/audit-trail.json，启动时通过JsonStoreRestorer恢复。
 * @extends EventEmitter
 * @emits SkillAuditTrail#change-recorded
 * @emits SkillAuditTrail#audit-report-generated
 */
class SkillAuditTrail extends EventEmitter {
  /**
   * 创建技能审计轨迹实例
   * @param {Object} options - 配置选项
   * @param {string} options.projectRoot - 项目根目录
   * @param {number} [options.maxEntries=5000] - 最大条目数，超出时FIFO淘汰
   * @param {number} [options.debounceMs] - 防抖持久化延迟毫秒数
   */
  constructor(options) {
    super();
    this._projectRoot = (options && options.projectRoot) || '';
    this._maxEntries = (options && options.maxEntries) ?? MAX_ENTRIES;
    this._entries = [];
    this._graph = null;
    this._router = null;
    this._persister = null;
    if (this._projectRoot) {
      this._initPersister(options && options.debounceMs);
      this._restore();
    }
  }

  /**
   * 初始化防抖持久化器
   * @param {number} [debounceMs] - 防抖延迟毫秒数
   * @private
   */
  _initPersister(debounceMs) {
    this._persister = new DebouncedPersister({
      root: this._projectRoot,
      dir: AUDIT_SUBDIR,
      filename: AUDIT_FILENAME,
      debounceMs: debounceMs,
      serialize: () => this._entries,
      onError: (err) => debug('SkillAuditTrail', 'persist', err),
    });
  }

  /**
   * 从磁盘恢复审计数据
   * @private
   */
  _restore() {
    const result = JsonStoreRestorer.loadSync(this._projectRoot, path.join(AUDIT_SUBDIR, AUDIT_FILENAME), {
      expectedType: 'array',
      logLabel: 'SkillAuditTrail',
    });
    if (result && Array.isArray(result.data)) {
      this._entries = result.data.slice(-this._maxEntries);
    }
  }

  /**
   * 调度防抖持久化
   * @private
   */
  _schedulePersist() {
    if (this._persister) {
      this._persister.schedule();
    }
  }

  /**
   * 记录变更条目
   * @param {Object} entry - 变更条目
   * @param {string} entry.skillId - 技能ID
   * @param {string} entry.action - 变更动作类型
   * @param {string} entry.actor - 操作者类型
   * @param {string} [entry.details] - 变更详情描述
   * @param {*} [entry.before] - 变更前状态
   * @param {*} [entry.after] - 变更后状态
   * @returns {Object} 记录的变更条目（含id和timestamp）
   */
  recordChange(entry) {
    this.guardShutdown();
    if (!entry || typeof entry !== 'object') return null;
    if (!entry.skillId || typeof entry.skillId !== 'string') return null;
    if (!VALID_ACTIONS.has(entry.action)) return null;
    if (!VALID_ACTORS.has(entry.actor)) return null;

    const record = {
      id: timestampId('audit-'),
      skillId: entry.skillId,
      action: entry.action,
      actor: entry.actor,
      details: entry.details || '',
      before: entry.before !== undefined ? entry.before : null,
      after: entry.after !== undefined ? entry.after : null,
      timestamp: Date.now(),
    };

    this._entries.push(record);
    if (this._entries.length > this._maxEntries) {
      this._entries.splice(0, this._entries.length - this._maxEntries);
    }

    this._schedulePersist();
    this.emit('change-recorded', record);
    return record;
  }

  /**
   * 查询技能变更历史，支持多维度过滤
   * @param {string} skillId - 技能ID
   * @param {Object} [options] - 过滤选项
   * @param {number} [options.limit] - 返回条目数上限
   * @param {string} [options.action] - 按动作类型过滤
   * @param {string} [options.actor] - 按操作者过滤
   * @param {number} [options.since] - 起始时间戳（含）
   * @param {number} [options.until] - 截止时间戳（含）
   * @returns {Object[]} 符合条件的变更条目列表（按时间倒序）
   */
  getHistory(skillId, options) {
    if (!skillId || typeof skillId !== 'string') return [];
    const opts = options ?? {};
    let results = this._entries.filter(e => e.skillId === skillId);

    if (opts.action) results = results.filter(e => e.action === opts.action);
    if (opts.actor) results = results.filter(e => e.actor === opts.actor);
    if (opts.since != null) results = results.filter(e => e.timestamp >= opts.since);
    if (opts.until != null) results = results.filter(e => e.timestamp <= opts.until);

    results = results.slice().reverse();
    if (opts.limit && opts.limit > 0) {
      results = results.slice(0, opts.limit);
    }
    return results.map(e => ({ ...e }));
  }

  /**
   * 获取最近的所有变更
   * @param {number} [limit=50] - 返回条目数上限
   * @returns {Object[]} 最近的变更条目列表（按时间倒序）
   */
  getRecentChanges(limit) {
    const count = limit ?? 50;
    return this._entries.slice(-count).reverse().map(e => ({ ...e }));
  }

  /**
   * 按操作者查询变更
   * @param {string} actor - 操作者类型
   * @param {number} [limit=50] - 返回条目数上限
   * @returns {Object[]} 符合条件的变更条目列表（按时间倒序）
   */
  getChangesByActor(actor, limit) {
    if (!actor || !VALID_ACTORS.has(actor)) return [];
    const count = limit ?? 50;
    return this._entries.filter(e => e.actor === actor).slice(-count).reverse();
  }

  /**
   * 按动作类型查询变更
   * @param {string} action - 动作类型
   * @param {number} [limit=50] - 返回条目数上限
   * @returns {Object[]} 符合条件的变更条目列表（按时间倒序）
   */
  getChangesByAction(action, limit) {
    if (!action || !VALID_ACTIONS.has(action)) return [];
    const count = limit ?? 50;
    return this._entries.filter(e => e.action === action).slice(-count).reverse().map(c => ({ ...c }));
  }

  /**
   * 获取变更计数
   * @param {string} [skillId] - 技能ID，省略时返回总计数
   * @returns {number} 变更条目数
   */
  getChangeCount(skillId) {
    if (!skillId) return this._entries.length;
    return this._entries.filter(e => e.skillId === skillId).length;
  }

  /**
   * 分析技能变更的影响范围
   * @param {string} skillId - 技能ID
   * @returns {{skillId: string, changeCount: number, lastChange: Object|null, dependents: string[], riskLevel: string}} 影响分析结果
   */
  getImpactAnalysis(skillId) {
    if (!skillId || typeof skillId !== 'string') {
      return { skillId: skillId || '', changeCount: 0, lastChange: null, dependents: [], riskLevel: 'low' };
    }

    const skillEntries = this._entries.filter(e => e.skillId === skillId);
    const changeCount = skillEntries.length;
    const lastChange = skillEntries.length > 0 ? skillEntries[skillEntries.length - 1] : null;

    const dependents = this._getDependents(skillId);
    const recentChanges = this._countRecentChanges(skillId);
    const isCoreSkill = this._isCoreSkill(skillId);

    let riskLevel = 'low';
    if (recentChanges > RISK_THRESHOLD_HIGH || (isCoreSkill && recentChanges > RISK_THRESHOLD_MEDIUM)) {
      riskLevel = 'high';
    } else if (recentChanges > RISK_THRESHOLD_MEDIUM || (isCoreSkill && recentChanges > 0)) {
      riskLevel = 'medium';
    }

    return { skillId, changeCount, lastChange, dependents, riskLevel };
  }

  /**
   * 获取技能的依赖者列表
   * @param {string} skillId - 技能ID
   * @returns {string[]} 依赖该技能的技能ID列表
   * @private
   */
  _getDependents(skillId) {
    if (!this._graph || typeof this._graph.getDependents !== 'function') return [];
    return safeExecute(() => this._graph.getDependents(skillId), 'SkillAuditTrail', 'getDependents', []);
  }

  /**
   * 统计最近7天的变更次数
   * @param {string} skillId - 技能ID
   * @returns {number} 最近7天的变更次数
   * @private
   */
  _countRecentChanges(skillId) {
    const cutoff = Date.now() - RISK_WINDOW_MS;
    return this._entries.filter(e => e.skillId === skillId && e.timestamp >= cutoff).length;
  }

  /**
   * 判断是否为核心技能
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否为核心技能
   * @private
   */
  _isCoreSkill(skillId) {
    if (!this._router) return false;
    const skills = this._router.skills;
    if (!Array.isArray(skills)) return false;
    const skill = skills.find(s => s.skill_id === skillId);
    if (!skill) return false;
    const phase = skill.phase || skill.frontmatter?.phase;
    if (!phase) return false;
    return phase === 'brainstorming' || phase === 'requirement-analysis' || phase === 'architecture-design';
  }

  /**
   * 生成审计报告
   * @param {Object} [options] - 报告选项
   * @param {number} [options.since] - 起始时间戳（含）
   * @param {number} [options.until] - 截止时间戳（含）
   * @param {boolean} [options.includeImpact=false] - 是否包含影响分析
   * @returns {{period: {since: number|null, until: number|null}, totalChanges: number, byAction: Object, byActor: Object, topChangedSkills: Array, highRiskSkills: Array, impactSummaries: Array}} 审计报告
   */
  generateAuditReport(options) {
    const opts = options ?? {};
    let entries = this._entries;

    if (opts.since) entries = entries.filter(e => e.timestamp >= opts.since);
    if (opts.until) entries = entries.filter(e => e.timestamp <= opts.until);

    const byAction = {};
    const byActor = {};
    const skillChangeCounts = {};

    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byActor[entry.actor] = (byActor[entry.actor] ?? 0) + 1;
      skillChangeCounts[entry.skillId] = (skillChangeCounts[entry.skillId] ?? 0) + 1;
    }

    const topChangedSkills = Object.entries(skillChangeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([skillId, count]) => ({ skillId, changeCount: count }));

    const highRiskSkills = [];
    const impactSummaries = [];

    if (opts.includeImpact) {
      const analyzedSkillIds = new Set(entries.map(e => e.skillId));
      for (const skillId of analyzedSkillIds) {
        const analysis = this.getImpactAnalysis(skillId);
        if (analysis.riskLevel === 'high' || analysis.riskLevel === 'medium') {
          highRiskSkills.push({ skillId, riskLevel: analysis.riskLevel, changeCount: analysis.changeCount });
        }
        impactSummaries.push(analysis);
      }
      highRiskSkills.sort((a, b) => (a.riskLevel === 'high' ? 0 : 1) - (b.riskLevel === 'high' ? 0 : 1));
    }

    const report = {
      period: { since: opts.since ?? null, until: opts.until ?? null },
      totalChanges: entries.length,
      byAction,
      byActor,
      topChangedSkills,
      highRiskSkills,
      impactSummaries,
    };

    this.emit('audit-report-generated', report);
    return report;
  }

  /**
   * 挂载SkillGraph实例，用于影响分析中查询技能依赖关系
   * @param {Object} graph - SkillGraph实例
   * @returns {SkillAuditTrail} 当前实例，支持链式调用
   */
  attachSkillGraph(graph) {
    this._graph = graph;
    return this;
  }

  /**
   * 挂载SkillRouter实例，用于技能信息查询
   * @param {Object} router - SkillRouter实例
   * @returns {SkillAuditTrail} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    this._router = router;
    return this;
  }

  /**
   * 获取审计轨迹统计信息
   * @returns {{totalEntries: number, byAction: Object, byActor: Object, oldestEntry: number|null, newestEntry: number|null}} 统计信息
   */
  getStats() {
    const byAction = {};
    const byActor = {};
    for (const entry of this._entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byActor[entry.actor] = (byActor[entry.actor] ?? 0) + 1;
    }
    return {
      totalEntries: this._entries.length,
      byAction,
      byActor,
      oldestEntry: this._entries.length > 0 ? this._entries[0].timestamp : null,
      newestEntry: this._entries.length > 0 ? this._entries[this._entries.length - 1].timestamp : null,
    };
  }

  /**
   * 检查审计轨迹是否健康（未关闭且条目数未超限）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._entries.length < HEALTH_MAX_ENTRIES;
  }

  /**
   * 关闭时清理资源
   * @private
   */
  _onShutdown() {
    if (this._persister) {
      safeCall(() => this._persister.flush(), 'SkillAuditTrail', 'shutdown:flush');
    }
    this._entries = [];
    this._graph = null;
    this._router = null;
    this._persister = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SkillAuditTrail);
