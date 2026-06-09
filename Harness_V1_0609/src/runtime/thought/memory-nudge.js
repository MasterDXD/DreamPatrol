'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { MAX_MERGE_SUMMARY_LENGTH, MAX_MERGE_CONTENT_LENGTH, MAX_MERGE_SINGLE_LENGTH } = require('../../utils/constants');

const SECONDS_PER_DAY = 86400;
const MEMORY_STALE_THRESHOLD_DAYS = 7;
const MEMORY_EXPIRY_THRESHOLD_DAYS = 30;

const NUDGE_RULES = [
  { id: 'complex-task', description: '复杂任务完成', test: (ctx) => (ctx.toolCalls ?? 0) >= 5, priority: 'high' },
  { id: 'error-recovery', description: '遭遇错误并恢复', test: (ctx) => ctx.hadError && ctx.recovered, priority: 'high' },
  { id: 'user-correction', description: '用户纠正了方法', test: (ctx) => ctx.userCorrection === true, priority: 'high' },
  { id: 'novel-approach', description: '发现新方法', test: (ctx) => ctx.novelApproach === true, priority: 'medium' },
  { id: 'convention-discovered', description: '发现项目约定', test: (ctx) => ctx.conventionDiscovered === true, priority: 'medium' },
  { id: 'performance-insight', description: '性能洞察', test: (ctx) => ctx.performanceInsight === true, priority: 'low' },
  { id: 'code-change', description: '代码变更触发记忆验证', test: (ctx) => ctx.codeChange === true, priority: 'medium' },
];

/**
 * @module runtime/thought/memory-nudge
 * @classdesc 记忆推动器（MemoryNudge）—— 主动提醒相关历史决策。
 * 根据内置和自定义推动规则评估任务完成上下文，检索并呈现过时但相关的记忆。
 * 集成EventBus实现技能完成和子Agent事件自动触发。
 * @extends EventEmitter
 * @emits MemoryNudge#nudge-triggered
 * @emits MemoryNudge#memory-saved
 * @emits MemoryNudge#nudge-skipped
 */
class MemoryNudge extends EventEmitter {
  constructor(options) {
    super();
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._eventBus = (options && options.eventBus) ?? null;
    this._stats = { nudgesTriggered: 0, memoriesSaved: 0, nudgesSkipped: 0 };
    this._handlers = [];
    this._customRules = [];
  }

  /**
   * 附加SQLite存储实例，用于持久化记忆提醒数据
   * @param {object} store - SQLite存储实例
   * @returns {MemoryNudge} 返回this以支持链式调用
   */
  attachSqliteStore(store) {
    this._sqliteStore = store;
    return this;
  }

  /**
   * 附加事件总线实例，用于监听技能完成、子代理完成、用户纠正和文件变更事件
   * @param {object} bus - 事件总线实例，需提供on和off方法
   * @returns {MemoryNudge} 返回this以支持链式调用
   */
  attachEventBus(bus) {
    this.guardShutdown();
    this._eventBus = bus;
    return this;
  }

  /**
   * 添加自定义提醒规则
   * @param {object} rule - 规则对象，需包含id(string)和test(function)属性
   * @returns {MemoryNudge} 返回this以支持链式调用
   */
  addRule(rule) {
    if (!rule || !rule.id || typeof rule.test !== 'function') return this;
    if (this._customRules.length >= 50) return this;
    if (this._customRules.some(r => r.id === rule.id)) return this;
    this._customRules.push(rule);
    return this;
  }

  /**
   * 开始监听事件总线上的技能完成、子代理完成、用户纠正和文件变更事件
   * 重复调用不会重复注册处理器
   * @returns {void}
   */
  startListening() {
    if (!this._eventBus) return;
    if (this._handlers && this._handlers.length > 0) return;

    const skillCompleteHandler = (e) => {
      Promise.resolve(this.evaluate({
        type: 'skill-complete',
        skillId: e.skillId,
        toolCalls: e.toolCalls ?? 0,
        hadError: e.hadError ?? false,
        recovered: e.recovered ?? false,
        userCorrection: e.userCorrection ?? false,
        novelApproach: e.novelApproach ?? false,
        conventionDiscovered: e.conventionDiscovered ?? false,
        performanceInsight: e.performanceInsight ?? false,
        summary: e.summary || '',
      })).catch(function(err) { debug('MemoryNudge', 'skillCompleteError', err && err.message ? err.message : String(err)); });
    };

    const subagentHandler = (e) => {
      Promise.resolve(this.evaluate({
        type: 'subagent-completed',
        toolCalls: e.toolCalls || (e.tokensUsed ? Math.ceil(e.tokensUsed / 1000) : 0),
        hadError: e.hadError ?? false,
        recovered: e.recovered ?? false,
        userCorrection: false,
        novelApproach: false,
        conventionDiscovered: false,
        performanceInsight: e.performanceInsight ?? false,
        summary: e.summary || `Subagent ${e.agentId ?? 'unknown'} completed in ${e.duration ?? 0}ms`,
        agentId: e.agentId,
        duration: e.duration ?? 0,
        tokensUsed: e.tokensUsed ?? 0,
      })).catch(function(err) { debug('MemoryNudge', 'subagentError', err && err.message ? err.message : String(err)); });
    };

    const userCorrectionHandler = (e) => {
      if (e && e.correction) {
        Promise.resolve(this.evaluate({
          type: 'user-correction',
          toolCalls: 0,
          hadError: false,
          recovered: false,
          userCorrection: true,
          novelApproach: false,
          conventionDiscovered: false,
          performanceInsight: false,
          summary: e.correction || '',
        })).catch(function(err) { debug('MemoryNudge', 'userCorrectionError', err && err.message ? err.message : String(err)); });
      }
    };

    this._eventBus.on('session:skill-complete', skillCompleteHandler);
    this._eventBus.on('subagent:completed', subagentHandler);
    this._eventBus.on('user:correction', userCorrectionHandler);

    const fileChangeHandler = (e) => {
      if (e && e.filePath) {
        Promise.resolve(this.handleCodeChange(e.filePath, e.changeType || 'modify')).catch(function(err) { debug('MemoryNudge', 'fileChangeError', err && err.message ? err.message : String(err)); });
      }
    };

    this._eventBus.on('file:changed', fileChangeHandler);

    this._handlers = [
      { event: 'session:skill-complete', handler: skillCompleteHandler },
      { event: 'subagent:completed', handler: subagentHandler },
      { event: 'user:correction', handler: userCorrectionHandler },
      { event: 'file:changed', handler: fileChangeHandler },
    ];
  }

  /**
   * 评估当前上下文是否触发提醒规则，若触发则保存记忆并发出nudge-triggered事件
   * @param {object} context - 上下文对象，可包含type、skillId、toolCalls、hadError、recovered、userCorrection、novelApproach、conventionDiscovered、performanceInsight、summary等字段
   * @returns {Promise<object|null>} 触发时返回{rule, content, saved}对象；未触发返回null
   */
  async evaluate(context) {
    this.guardShutdown();
    try {
      const allRules = NUDGE_RULES.concat(this._customRules);
      const triggered = [];
      for (const rule of allRules) {
        safeCall(() => { if (rule.test(context)) triggered.push(rule); }, 'MemoryNudge', 'evaluate');
      }

      if (triggered.length === 0) {
        this._stats.nudgesSkipped++;
        return null;
      }

      const highestPriority = triggered.find(r => r.priority === 'high') || triggered[0];
      this._stats.nudgesTriggered++;

      const content = this._buildMemoryContent(context, highestPriority);
      if (!content) return null;

      const target = context.type === 'user-correction' ? 'user' : 'memory';
      const result = await this._saveMemory(target, content);

      this.emit('nudge-triggered', {
        rule: highestPriority.id,
        description: highestPriority.description,
        context: { type: context.type, skillId: context.skillId },
        saved: result.success,
      });

      return { rule: highestPriority, content, saved: result.success };
    } catch (err) {
      debug('MemoryNudge', 'evaluate', err);
      return null;
    }
  }

  _buildMemoryContent(context, rule) {
    const parts = [];
    if (context.skillId) parts.push(`Skill: ${context.skillId}`);
    if (context.agentId) parts.push(`Agent: ${context.agentId}`);
    parts.push(`触发: ${rule.description || '未知规则'}`);

    if (context.hadError && context.recovered) {
      parts.push('遭遇错误并成功恢复');
    }
    if (context.userCorrection) {
      parts.push('用户纠正了执行方法');
    }
    if (context.novelApproach) {
      parts.push('发现了新的有效方法');
    }
    if (context.conventionDiscovered) {
      parts.push('发现了项目约定');
    }
    if (context.performanceInsight) {
      parts.push('性能洞察');
    }
    if (context.duration) {
      parts.push(`耗时: ${context.duration}ms`);
    }
    if (context.tokensUsed) {
      parts.push(`Token: ${context.tokensUsed}`);
    }
    if (context.summary) {
      parts.push(context.summary.substring(0, MAX_MERGE_SUMMARY_LENGTH));
    }

    return parts.join(' | ');
  }

  async _saveMemory(target, content) {
    if (!this._sqliteStore) return { success: false, error: 'No SqliteStore attached' };

    const usage = await Promise.resolve(this._sqliteStore.getMemoryUsage(target));
    if (usage && usage.percentage >= 90) {
      await this._consolidateMemories(target);
    }

    const result = await Promise.resolve(this._sqliteStore.addMemory(target, content));
    if (result && typeof result === 'object' && result !== null && result.success === false) {
      return result;
    }
    if (result != null && result !== false) {
      this._stats.memoriesSaved++;
    }
    return { success: true, id: result };
  }

  async _consolidateMemories(target) {
    if (!this._sqliteStore) return;
    try {
      const entries = await Promise.resolve(this._sqliteStore.getMemories(target));
      if (!Array.isArray(entries) || entries.length < 3) return;

      const oldEntries = entries.filter(e => {
        const ts = e.created_at ?? e.updated_at ?? 0;
        const age = Date.now() / 1000 - ts;
        return age > SECONDS_PER_DAY * MEMORY_STALE_THRESHOLD_DAYS;
      });

      const merged = [];
      const mergeSourceIds = [];
      for (let i = 0; i < oldEntries.length - 1; i += 2) {
        const c1 = (oldEntries[i].content || '').substring(0, MAX_MERGE_CONTENT_LENGTH);
        const c2 = (oldEntries[i + 1].content || '').substring(0, MAX_MERGE_CONTENT_LENGTH);
        merged.push(`[合并] ${c1}... + ${c2}...`);
        mergeSourceIds.push([oldEntries[i].id, oldEntries[i + 1].id]);
      }
      if (oldEntries.length % 2 === 1) {
        const last = oldEntries[oldEntries.length - 1];
        const cLast = (last.content || '').substring(0, MAX_MERGE_SINGLE_LENGTH);
        merged.push(`[合并] ${cLast}...`);
        mergeSourceIds.push([last.id]);
      }

      const toRemove = [];
      for (let j = 0; j < merged.length; j++) {
        const addResult = await Promise.resolve(this._sqliteStore.addMemory(target, merged[j]));
        if (addResult && addResult.success !== false) {
          toRemove.push(...mergeSourceIds[j]);
        }
      }
      for (const id of toRemove) {
        await Promise.resolve(this._sqliteStore.removeMemory(target, id));
      }

      this.emit('memories-consolidated', { target, removed: toRemove.length, merged: merged.length });
    } catch (err) {
      debug('MemoryNudge', '_consolidateMemories', err);
    }
  }

  /**
   * 处理代码变更事件，使相关记忆失效并触发代码变更评估
   * @param {string} filePath - 变更的文件路径
   * @param {string} [changeType='modify'] - 变更类型
   * @returns {Promise<object>} 返回{invalidated}对象，包含失效的记忆数量
   */
  async handleCodeChange(filePath, changeType) {
    this.guardShutdown();
    if (!this._sqliteStore) return { invalidated: 0 };
    try {
      const pathParts = (filePath ?? '').replace(/\\/g, '/').split('/');
      const fileName = pathParts[pathParts.length - 1] || '';
      const dirPath = pathParts.slice(0, -1).join('/');

      let invalidated = 0;
      if (fileName) {
        invalidated += await Promise.resolve(this._sqliteStore.invalidateMemoriesByPattern(fileName));
      }
      if (dirPath && dirPath.length > 3) {
        invalidated += await Promise.resolve(this._sqliteStore.invalidateMemoriesByPattern(dirPath));
      }

      if (invalidated > 0) {
        this.emit('memories-invalidated-by-code-change', { filePath, changeType, invalidated });
      }

      await this.evaluate({
        type: 'code-change',
        codeChange: true,
        toolCalls: 0,
        hadError: false,
        recovered: false,
        userCorrection: false,
        novelApproach: false,
        conventionDiscovered: false,
        performanceInsight: false,
        summary: `代码变更: ${changeType || '未知类型'} ${filePath || '未知文件'}, ${invalidated}条记忆标记待验证`,
      });

      return { invalidated };
    } catch (err) {
      debug('MemoryNudge', 'handleCodeChange', err);
      return { invalidated: 0 };
    }
  }

  /**
   * 验证陈旧记忆，超过过期阈值的移除，未过期的重新验证
   * @param {string} [target='memory'] - 记忆目标分类
   * @returns {Promise<object>} 返回{verified, removed, total}对象
   */
  async verifyStaleMemories(target) {
    this.guardShutdown();
    if (!this._sqliteStore) return { verified: 0, removed: 0 };
    try {
      const stale = await Promise.resolve(this._sqliteStore.getStaleMemories(target || 'memory'));
      let verified = 0;
      let removed = 0;

      for (const entry of stale) {
        const age = Date.now() / 1000 - (entry.updated_at ?? entry.created_at ?? 0);
        if (age > SECONDS_PER_DAY * MEMORY_EXPIRY_THRESHOLD_DAYS) {
          await Promise.resolve(this._sqliteStore.removeMemory(entry.target, entry.id));
          removed++;
        } else {
          await Promise.resolve(this._sqliteStore.verifyMemoryEntry(entry.id));
          verified++;
        }
      }

      return { verified, removed, total: stale.length };
    } catch (err) {
      debug('MemoryNudge', 'verifyStaleMemories', err);
      return { verified: 0, removed: 0 };
    }
  }

  /**
   * 获取记忆提醒的统计信息
   * @returns {object} 统计对象，包含nudgesTriggered、memoriesSaved、nudgesSkipped、rules字段
   */
  getStats() {
    return { ...this._stats, rules: NUDGE_RULES.length + this._customRules.length };
  }

  /**
   * 检查记忆提醒是否健康，处理器数量低于1000即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._handlers.length < 1000;
  }

  _onShutdown() {
    if (this._eventBus) {
      for (const h of this._handlers) {
        safeCall(() => this._eventBus.off(h.event, h.handler), 'MemoryNudge', 'shutdown');
      }
    }
    this._handlers = [];
    this.removeAllListeners();
  }
}

MemoryNudge.RULES = NUDGE_RULES;

module.exports = withShutdown(MemoryNudge);
