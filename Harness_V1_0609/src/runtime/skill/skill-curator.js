'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { DANGEROUS_KEYS, MS_PER_HOUR, HARNESS_DIR, generateId } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { ensureSafeTimeout } = require('../../utils/param-validator');
const deepClone = require('../../utils/deep-clone');

const STALE_THRESHOLD_DAYS = 30;
const CURATOR_INTERVAL = MS_PER_HOUR;
const MAX_USAGE_ENTRIES = 500;
const MAX_CLASSIFICATIONS = 500;
const MAX_PINS = 100;
const VALID_SOURCES = new Set(['builtin', 'user', 'generated', 'evolved']);
const BUILTIN_QUALITY_THRESHOLD = 0.15;
const DEFAULT_QUALITY_THRESHOLD = 0.3;
const MAX_SNAPSHOTS_DEFAULT = 10;
const SNAPSHOTS_DIR = HARNESS_DIR + '/skills/.snapshots';

/**
 * @module runtime/skill/skill-curator
 * SkillCurator — 技能策展人
 * 技能质量评估、冗余检测与生命周期管理。追踪技能使用统计（调用/成功/失败/耗时），
 * 按成功率与活跃度标记低质量或过时技能。支持技能分类（builtin/user/generated/evolved）、
 * 钉选保护、快照创建与回滚。提供定时策展与智能空闲策展两种自动运行模式。
 * @extends EventEmitter
 * @emits SkillCurator#skill-classified
 * @emits SkillCurator#skill-pinned
 * @emits SkillCurator#skill-unpinned
 * @emits SkillCurator#skill-low-quality
 * @emits SkillCurator#skill-stale
 * @emits SkillCurator#snapshot-created
 * @emits SkillCurator#snapshot-rolled-back
 */
class SkillCurator extends EventEmitter {
  /**
   * 创建 SkillCurator 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.projectRoot=''] - 项目根目录路径
   * @param {Object} [options.skillRouter=null] - SkillRouter实例
   * @param {Object} [options.sqliteStore=null] - SQLite存储实例
   */
  constructor(options) {
    super();
    // 防止无监听器时 error 事件导致进程崩溃
    this.on('error', function(_err) {
      // 仅记录，不传播 — 外部可通过 on('error') 覆盖此行为
    });
    this._projectRoot = (options && options.projectRoot) || '';
    this._skillRouter = (options && options.skillRouter) ?? null;
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._usageTracker = new Map();
    this._timer = null;
    this._smartTimer = null;
    this._idleDetector = null;
    this._stats = { curated: 0, archived: 0, reviewed: 0 };
    this._classifications = {};
    this._pins = {};
    this._snapshots = [];
    this._maxSnapshots = (options && options.maxSnapshots) ?? MAX_SNAPSHOTS_DEFAULT;
    this._lastPersistPromise = Promise.resolve();
  }

  /**
   * 挂载SkillRouter实例，用于获取技能列表
   * @param {Object} router - SkillRouter实例
   * @returns {SkillCurator} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    this._skillRouter = router;
    return this;
  }

  /**
   * 挂载SQLite存储实例
   * @param {Object} store - SQLite存储实例
   * @returns {SkillCurator} 当前实例，支持链式调用
   */
  attachSqliteStore(store) {
    this._sqliteStore = store;
    return this;
  }

  /**
   * 挂载空闲检测器实例，用于智能策展模式判断系统是否空闲
   * @param {Object} detector - 空闲检测器实例，需提供isIdle方法
   * @returns {SkillCurator} 当前实例，支持链式调用
   */
  attachIdleDetector(detector) {
    this._idleDetector = detector;
    return this;
  }

  /**
   * 对技能进行分类标记（builtin/user/generated/evolved）
   * @param {string} skillId - 技能ID
   * @param {string} source - 来源类型，必须为builtin/user/generated/evolved之一
   * @returns {void}
   */
  classifySkill(skillId, source) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return;
    if (!VALID_SOURCES.has(source)) {
      throw new Error('Invalid source type: ' + source + '. Must be one of: ' + [...VALID_SOURCES].join(', '));
    }
    const classKeys = Object.keys(this._classifications);
    if (classKeys.length >= MAX_CLASSIFICATIONS && !this._classifications[skillId]) {
      delete this._classifications[classKeys[0]];
    }
    this._classifications[skillId] = source;
    this.emit('skill-classified', { skillId, source });
  }

  /**
   * 获取指定技能的分类来源
   * @param {string} skillId - 技能ID
   * @returns {string} 来源类型，未分类时返回'unknown'
   */
  getClassification(skillId) {
    return this._classifications[skillId] ?? 'unknown';
  }

  /**
   * 列出所有分类，按来源类型分组
   * @returns {Object.<string, string[]>} 按来源类型分组的技能ID映射
   */
  listClassifications() {
    const result = {};
    for (const source of VALID_SOURCES) result[source] = [];
    for (const [skillId, source] of Object.entries(this._classifications)) {
      if (result[source]) result[source].push(skillId);
    }
    return result;
  }

  /**
   * 钉选技能，被钉选的技能在策展时不会被标记为低质量或过时
   * @param {string} skillId - 技能ID
   * @param {string} [reason=''] - 钉选原因
   * @returns {void}
   */
  pinSkill(skillId, reason) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return;
    const pinKeys = Object.keys(this._pins);
    if (pinKeys.length >= MAX_PINS && !this._pins[skillId]) {
      delete this._pins[pinKeys[0]];
    }
    this._pins[skillId] = {
      skillId,
      reason: reason || '',
      pinnedAt: Date.now(),
    };
    this.emit('skill-pinned', { skillId, reason });
  }

  /**
   * 取消钉选技能
   * @param {string} skillId - 技能ID
   * @returns {void}
   */
  unpinSkill(skillId) {
    if (!skillId || typeof skillId !== 'string') return;
    const wasPinned = !!this._pins[skillId];
    delete this._pins[skillId];
    if (wasPinned) this.emit('skill-unpinned', { skillId });
  }

  /**
   * 检查技能是否被钉选
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否被钉选
   */
  isPinned(skillId) {
    return !!this._pins[skillId];
  }

  /**
   * 列出所有被钉选的技能信息
   * @returns {Array<{skillId: string, reason: string, pinnedAt: number}>} 钉选信息列表
   */
  listPinned() {
    return Object.values(this._pins).map(p => ({ ...p }));
  }

  /**
   * 记录技能使用情况（调用次数、成功/失败、耗时）
   * @param {string} skillId - 技能ID
   * @param {Object} [result] - 使用结果
   * @param {boolean} [result.success] - 是否成功
   * @param {number} [result.duration] - 执行耗时（毫秒）
   * @returns {void}
   */
  recordUsage(skillId, result) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return;
    if (DANGEROUS_KEYS.has(skillId)) return;
    if (!this._usageTracker.has(skillId)) {
      if (this._usageTracker.size >= MAX_USAGE_ENTRIES) {
        const oldest = this._usageTracker.keys().next().value;
        this._usageTracker.delete(oldest);
      }
      this._usageTracker.set(skillId, { calls: 0, successes: 0, failures: 0, lastUsed: 0, totalDuration: 0 });
    }
    const tracker = this._usageTracker.get(skillId);
    tracker.calls++;
    tracker.lastUsed = Date.now();
    if (result && result.success === true) tracker.successes++;
    else if (result && result.success === false) tracker.failures++;
    if (result && typeof result.duration === 'number' && Number.isFinite(result.duration)) tracker.totalDuration += result.duration;
  }

  /**
   * 启动定时自动策展
   * @param {number} [interval] - 策展间隔（毫秒），默认1小时
   * @returns {void}
   */
  startAutoCuration(interval) {
    this.guardShutdown();
    if (this._timer) return;
    const ms = ensureSafeTimeout(interval ?? CURATOR_INTERVAL, CURATOR_INTERVAL);
    this._timer = setInterval(() => { if (this._shutDown) return; try { this.runCuration(); } catch (err) { this.emit('error', err); } }, ms);
    if (this._timer && typeof this._timer.unref === 'function') { this._timer.unref(); }
  }

  /**
   * 停止定时自动策展
   * @returns {void}
   */
  stopAutoCuration() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 启动智能空闲策展，仅在系统空闲时执行策展
   * @param {Object} [options] - 配置选项
   * @param {number} [options.interval] - 检查间隔（毫秒），默认1小时
   * @returns {void}
   */
  startSmartCuration(options) {
    this.guardShutdown();
    if (this._smartTimer) return;
    const interval = ensureSafeTimeout((options && options.interval) ?? CURATOR_INTERVAL, CURATOR_INTERVAL);
    this._smartTimer = setInterval(() => { if (this._shutDown) return; try { this._smartCurationCheck(); } catch (err) { this.emit('error', err); } }, interval);
    if (this._smartTimer && typeof this._smartTimer.unref === 'function') { this._smartTimer.unref(); }
  }

  /**
   * 停止智能空闲策展
   * @returns {void}
   */
  stopSmartCuration() {
    if (this._smartTimer) {
      clearInterval(this._smartTimer);
      this._smartTimer = null;
    }
  }

  _smartCurationCheck() {
    if (!this._idleDetector || typeof this._idleDetector.isIdle !== 'function') {
      return null;
    }
    if (!this._idleDetector.isIdle()) {
      return null;
    }
    return this.runCuration();
  }

  _getQualityThreshold(skillId) {
    const source = this._classifications[skillId];
    if (source === 'builtin') return BUILTIN_QUALITY_THRESHOLD;
    return DEFAULT_QUALITY_THRESHOLD;
  }

  /**
   * 执行一轮策展，检查低质量和过时技能并发出事件
   * @returns {{ archived: number, stale: number, reviewed: number }} 策展结果统计
   */
  runCuration() {
    this.guardShutdown();
    if (!this._skillRouter) return { archived: 0, stale: 0, reviewed: 0 };

    const skills = this._skillRouter.skills ?? [];
    const now = Date.now();
    const staleThreshold = STALE_THRESHOLD_DAYS * 86400000;
    let archived = 0;
    let stale = 0;
    let reviewed = 0;

    for (const skill of skills) {
      if (this.isPinned(skill.skill_id)) continue;

      const usage = this._usageTracker.get(skill.skill_id);
      if (!usage || usage.calls === 0) continue;

      reviewed++;

      const threshold = this._getQualityThreshold(skill.skill_id);
      const successRate = usage.calls > 0 ? usage.successes / usage.calls : 0;
      if (successRate < threshold && usage.calls >= 5) {
        archived++;
        this.emit('skill-low-quality', {
          skillId: skill.skill_id,
          successRate,
          calls: usage.calls,
        });
      }

      if (now - usage.lastUsed > staleThreshold) {
        stale++;
        this.emit('skill-stale', { skillId: skill.skill_id, lastUsed: usage.lastUsed });
      }
    }

    this._stats.curated++;
    this._stats.archived += archived;
    this._stats.reviewed += reviewed;

    return { archived, stale, reviewed };
  }

  /**
   * 试运行策展，仅返回将被标记的技能列表而不实际执行
   * @returns {{ wouldFlag: Array<{skillId: string, reason: string, successRate?: number, calls?: number, lastUsed?: number}>, skippedPinned: number, reviewed: number }} 试运行结果
   */
  dryRunCuration() {
    this.guardShutdown();
    if (!this._skillRouter) return { wouldFlag: [], skippedPinned: 0, reviewed: 0 };

    const skills = this._skillRouter.skills ?? [];
    const now = Date.now();
    const staleThreshold = STALE_THRESHOLD_DAYS * 86400000;
    const wouldFlag = [];
    let skippedPinned = 0;
    let reviewed = 0;

    for (const skill of skills) {
      if (this.isPinned(skill.skill_id)) {
        const usage = this._usageTracker.get(skill.skill_id);
        if (usage && usage.calls > 0) skippedPinned++;
        continue;
      }

      const usage = this._usageTracker.get(skill.skill_id);
      if (!usage || usage.calls === 0) continue;

      reviewed++;

      const threshold = this._getQualityThreshold(skill.skill_id);
      const successRate = usage.calls > 0 ? usage.successes / usage.calls : 0;
      if (successRate < threshold && usage.calls >= 5) {
        wouldFlag.push({ skillId: skill.skill_id, reason: 'low-quality', successRate, calls: usage.calls });
      }

      if (now - usage.lastUsed > staleThreshold) {
        wouldFlag.push({ skillId: skill.skill_id, reason: 'stale', lastUsed: usage.lastUsed });
      }
    }

    return { wouldFlag, skippedPinned, reviewed };
  }

  /**
   * 创建当前策展状态的快照，包含使用追踪、分类和钉选数据
   * @returns {{ id: string, timestamp: number, usageEntries: number, pinnedCount: number, classificationCount: number, data: Object }} 快照对象
   */
  createSnapshot() {
    this.guardShutdown();
    const id = generateId('snap');
    const snapshot = {
      id,
      timestamp: Date.now(),
      usageEntries: this._usageTracker.size,
      pinnedCount: Object.keys(this._pins).length,
      classificationCount: Object.keys(this._classifications).length,
      data: {
        usageTracker: deepClone(Object.fromEntries(this._usageTracker)),
        classifications: { ...this._classifications },
        pins: deepClone(this._pins),
      },
    };

    this._snapshots.push(snapshot);
    while (this._snapshots.length > this._maxSnapshots) {
      this._snapshots.shift();
    }

    this._lastPersistPromise = this._persistSnapshot(snapshot).catch(err => {
      this.emit('snapshot-persist-failed', { id, error: err && err.message ? err.message : String(err) });
    });

    this.emit('snapshot-created', { id, timestamp: snapshot.timestamp });
    return snapshot;
  }

  /**
   * 列出所有快照的摘要信息
   * @returns {Array<{id: string, timestamp: number, usageEntries: number, pinnedCount: number, classificationCount: number}>} 快照摘要列表
   */
  listSnapshots() {
    return this._snapshots.map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      usageEntries: s.usageEntries,
      pinnedCount: s.pinnedCount,
      classificationCount: s.classificationCount,
    }));
  }

  /**
   * 回滚到指定快照，恢复使用追踪、分类和钉选数据
   * @param {string} snapshotId - 快照ID
   * @returns {{ success: boolean, snapshotId?: string, error?: string }} 回滚结果
   */
  rollbackToSnapshot(snapshotId) {
    this.guardShutdown();
    const snapshot = this._snapshots.find(s => s.id === snapshotId);
    if (!snapshot) {
      return { success: false, error: 'Snapshot not found: ' + snapshotId };
    }

    const parsed = deepClone(snapshot.data.usageTracker);
    this._usageTracker = new Map(Object.entries(parsed ?? {}));
    this._classifications = { ...snapshot.data.classifications };
    this._pins = deepClone(snapshot.data.pins);

    this.emit('snapshot-rolled-back', { id: snapshotId });
    return { success: true, snapshotId };
  }

  async _persistSnapshot(snapshot) {
    if (!this._projectRoot) return;
    try {
      const snapshotDir = path.join(this._projectRoot, SNAPSHOTS_DIR);
      await fsp.mkdir(snapshotDir, { recursive: true });
      const filePath = path.join(snapshotDir, snapshot.id + '.json');
      await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

      const files = (await fsp.readdir(snapshotDir))
        .filter(f => f.endsWith('.json'));
      // 按文件修改时间排序（旧→新），UUID文件名无时间序
      const settled = await Promise.allSettled(files.map(async function(f) {
        const stat = await fsp.stat(path.join(snapshotDir, f));
        return { name: f, mtime: stat.mtimeMs };
      }));
      const filesWithTime = settled
        .filter(function(r) { return r.status === 'fulfilled'; })
        .map(function(r) { return r.value; });
      filesWithTime.sort(function(a, b) { return a.mtimeMs - b.mtimeMs; });
      const sortedFiles = filesWithTime.map(function(f) { return f.name; });
      while (sortedFiles.length > this._maxSnapshots) {
        const toDelete = sortedFiles.shift();
        await fsp.unlink(path.join(snapshotDir, toDelete)).catch(function(err) { debug('SkillCurator', 'persistSnapshot', 'Failed to delete old snapshot: ' + (err && err.message ? err.message : String(err))); });
      }
    } catch (err) {
      debug('SkillCurator', 'persistSnapshot', err);
    }
  }

  /**
   * 获取指定技能的使用统计
   * @param {string} skillId - 技能ID
   * @returns {{ calls: number, successes: number, failures: number, lastUsed: number, totalDuration: number }|null} 使用统计，不存在时返回null
   */
  getSkillStats(skillId) {
    const stats = this._usageTracker.get(skillId);
    return stats ? { ...stats } : null;
  }

  /**
   * 获取所有技能的汇总统计信息
   * @returns {{ curatorStats: { curated: number, archived: number, reviewed: number }, skillStats: Object, totalTracked: number, staleThresholdDays: number, pinnedCount: number, classificationCount: number }} 汇总统计
   */
  getAllStats() {
    const skillStats = {};
    for (const [id, data] of this._usageTracker) {
      skillStats[id] = {
        ...data,
        successRate: data.calls > 0 ? data.successes / data.calls : 0,
        avgDuration: data.calls > 0 ? data.totalDuration / data.calls : 0,
      };
    }
    return {
      curatorStats: { ...this._stats },
      skillStats,
      totalTracked: this._usageTracker.size,
      staleThresholdDays: STALE_THRESHOLD_DAYS,
      pinnedCount: Object.keys(this._pins).length,
      classificationCount: Object.keys(this._classifications).length,
    };
  }

  /**
   * 检查策展人是否健康（未关闭且追踪条目未超限）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._usageTracker.size < 5000;
  }

  _onShutdown() {
    this.stopAutoCuration();
    this.stopSmartCuration();
    this._lastPersistPromise.catch(function(err) { debug('SkillCurator', 'shutdown:persist', err); });
    this._usageTracker = new Map();
    this._classifications = {};
    this._pins = {};
    this._snapshots = [];
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SkillCurator);
