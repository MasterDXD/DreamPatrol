'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { generateId, validateProjectRoot , HARNESS_DIR} = require('../../utils/constants');
const { writeAtomic } = require('../../utils/debounced-persister');
const JsonStoreRestorer = require('../../utils/json-store-restorer');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MAX_LEARNINGS = 200;
const PERSIST_DEBOUNCE_MS = 500;
const LEARNINGS_DIR = 'skills-learned';

/**
 * @module runtime/skill/skill-improver
 * SkillImprover — 技能改进器
 * 基于使用反馈持续迭代优化技能。记录每次技能执行的学习条目（whatWorked/whatFailed/tips），
 * 按技能ID聚合查询改进建议与避坑指南。防抖持久化到.harness/skills-learned/learnings.json，
 * 启动时通过JsonStoreRestorer自动恢复历史数据。最多保留200条学习记录。
 * @extends EventEmitter
 * @emits SkillImprover#learning-recorded
 */
class SkillImprover extends EventEmitter {
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'SkillImprover');
    this.root = projectRoot;
    this._learnings = [];
    this._persistTimer = null;
    this._ready = false;
    this._readyPromise = this._restoreAsync().then(function() { this._ready = true; }.bind(this)).catch(err => { debug('SkillImprover', 'initError', err); this._ready = true; });
  }

  _onShutdown() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persist();
    this._learnings = [];
    this.removeAllListeners();
  }

  /**
   * 获取就绪Promise，异步恢复完成后resolve
   * @returns {Promise<void>} 就绪Promise
   */
  get ready() {
    return this._readyPromise;
  }

  /**
   * 记录一条学习条目，防抖持久化到磁盘
   * @param {Object} entry - 学习条目
   * @param {string} entry.skillId - 技能ID
   * @param {string} [entry.phase] - 执行阶段
   * @param {string} [entry.approach] - 采用的方法
   * @param {string[]} [entry.whatWorked] - 有效的做法
   * @param {string[]} [entry.whatFailed] - 失败的做法
   * @param {string[]} [entry.tips] - 改进建议
   * @param {string} [entry.context] - 上下文描述
   * @param {string} [entry.agentId] - Agent ID
   * @returns {Object|null} 记录的学习条目（含id和createdAt），无效输入返回null
   */
  recordLearning(entry) {
    this.guardShutdown();
    if (!entry || !entry.skillId) return null;

    const record = {
      id: generateId(),
      skillId: entry.skillId,
      phase: entry.phase || '',
      approach: entry.approach || '',
      whatWorked: Array.isArray(entry.whatWorked) ? entry.whatWorked : [],
      whatFailed: Array.isArray(entry.whatFailed) ? entry.whatFailed : [],
      tips: Array.isArray(entry.tips) ? entry.tips : [],
      context: entry.context || '',
      agentId: entry.agentId ?? 'unknown',
      createdAt: new Date().toISOString(),
    };

    this._learnings.push(record);
    if (this._learnings.length > MAX_LEARNINGS) {
      this._learnings = this._learnings.slice(-MAX_LEARNINGS);
    }
    this._schedulePersist();
    this.emit('learning-recorded', record);
    return record;
  }

  /**
   * 获取指定技能或全部的学习记录
   * @param {string} [skillId] - 技能ID，不传则返回全部
   * @returns {Object[]} 学习记录列表
   */
  getLearnings(skillId) {
    this.guardShutdown();
    const learnings = this._learnings ?? [];
    if (skillId) {
      return learnings.filter(l => l.skillId === skillId);
    }
    return learnings.slice();
  }

  /**
   * 获取指定技能的改进建议（whatWorked + tips去重合并）
   * @param {string} skillId - 技能ID
   * @returns {string[]} 去重后的改进建议列表
   */
  getTips(skillId) {
    this.guardShutdown();
    const learnings = this.getLearnings(skillId);
    const tips = [];
    for (const l of learnings) {
      if (l.whatWorked) tips.push(...l.whatWorked);
      if (l.tips) tips.push(...l.tips);
    }
    return [...new Set(tips)];
  }

  /**
   * 获取指定技能的避坑指南（whatFailed去重合并）
   * @param {string} skillId - 技能ID
   * @returns {string[]} 去重后的避坑条目列表
   */
  getAvoidances(skillId) {
    this.guardShutdown();
    const learnings = this.getLearnings(skillId);
    const avoidances = [];
    for (const l of learnings) {
      if (l.whatFailed) avoidances.push(...l.whatFailed);
    }
    return [...new Set(avoidances)];
  }

  /**
   * 获取学习记录统计信息
   * @returns {{ total: number, bySkill: Object.<string, number> }} 统计数据
   */
  getStats() {
    this.guardShutdown();
    const learnings = this._learnings ?? [];
    const bySkill = {};
    for (const l of learnings) {
      bySkill[l.skillId] = (bySkill[l.skillId] ?? 0) + 1;
    }
    return {
      total: learnings.length,
      bySkill,
    };
  }

  async _restoreWith(loader) {
    try {
      const result = await loader();
      if (result) {
        const restored = result.data.slice(-MAX_LEARNINGS);
        const existing = this._learnings;
        this._learnings = restored;
        for (const entry of existing) {
          if (!this._learnings.some(function(l) { return l.id === entry.id; })) {
            this._learnings.push(entry);
          }
        }
        if (this._learnings.length > MAX_LEARNINGS) {
          this._learnings = this._learnings.slice(-MAX_LEARNINGS);
        }
      }
    } catch (err) {
      debug('SkillImprover', '_restore', err);
    }
  }

  _restore() {
    return this._restoreWith(() => JsonStoreRestorer.loadSync(this.root, LEARNINGS_DIR + '/learnings.json', {
      expectedType: 'array',
      logLabel: 'SkillImprover',
    }));
  }

  async _restoreAsync() {
    return this._restoreWith(() => JsonStoreRestorer.loadAsync(this.root, LEARNINGS_DIR + '/learnings.json', {
      expectedType: 'array',
      logLabel: 'SkillImprover',
    }));
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      if (this._shutDown) return;
      this._persistTimer = null;
      try { this._persist(); } catch (err) { debug('SkillImprover', 'persistTimer', err && err.message ? err.message : String(err)); }
    }, PERSIST_DEBOUNCE_MS);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') { this._persistTimer.unref(); }
  }

  _persist() {
    try {
      const filePath = path.join(this.root, HARNESS_DIR, LEARNINGS_DIR, 'learnings.json');
      writeAtomic(filePath, this._learnings);
    } catch (err) {
      debug('SkillImprover', '_persist', err);
    }
  }

}

SkillImprover = withShutdown(SkillImprover);

SkillImprover.MAX_LEARNINGS = MAX_LEARNINGS;

module.exports = SkillImprover;
