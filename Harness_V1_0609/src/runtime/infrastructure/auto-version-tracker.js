'use strict';

const { debug } = require('../../utils/debug-logger');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { DEFAULT_MIN_HEARTBEAT_MS, UTF8_ENCODING } = require('../../utils/constants');
const { safeCall } = require('../../utils/safe-execute');

const EVENT_CATEGORY_MAP = {
  'session:skill-complete': { category: '变更', label: '技能完成' },
  'session:phase-change': { category: '变更', label: '阶段转换' },
  'subagent:completed': { category: '变更', label: '子智能体完成' },
  'pair-chat:consensus-reached': { category: '变更', label: 'PairChat共识达成' },
  'chat-chain:chain-completed': { category: '变更', label: 'ChatChain链完成' },
  'generator-verifier:verification-complete': { category: '变更', label: '验证完成' },
  'deepening:converged': { category: '变更', label: '深化收敛' },
  'deepening:pipeline-complete': { category: '变更', label: '深化管道完成' },
  'deepening:scored': { category: '变更', label: '质量评分' },
  'agent:state-change': { category: '变更', label: 'Agent状态变更' },
  'agent:deployed': { category: '新增', label: 'Agent部署' },
  'skill-reducer:discovered': { category: '新增', label: '技能发现' },
  'session:created': { category: '新增', label: '会话创建' },
  'subagent:failed': { category: '修复', label: '子智能体失败' },
  'pair-chat:consensus-failed': { category: '修复', label: 'PairChat共识失败' },
  'chat-chain:chain-failed': { category: '修复', label: 'ChatChain链失败' },
  'deepening:error-occurred': { category: '修复', label: '深化错误' },
  'ai:code-modified': { category: '变更', label: 'AI代码修改' },
  'ai:bug-fixed': { category: '修复', label: 'AI缺陷修复' },
  'ai:feature-added': { category: '新增', label: 'AI功能新增' },
  'ai:refactored': { category: '变更', label: 'AI代码重构' },
  'ai:security-fixed': { category: '修复', label: 'AI安全修复' },
  'ai:performance-optimized': { category: '变更', label: 'AI性能优化' },
  'ai:config-changed': { category: '变更', label: 'AI配置修改' },
  'ai:test-added': { category: '新增', label: 'AI测试新增' },
  'ai:test-fixed': { category: '修复', label: 'AI测试修复' },
  'ai:doc-updated': { category: '变更', label: 'AI文档更新' },
  'ai:dependency-updated': { category: '变更', label: 'AI依赖更新' },
  'ai:api-added': { category: '新增', label: 'AI接口新增' },
  'ai:api-modified': { category: '变更', label: 'AI接口修改' },
  'ai:removed': { category: '移除', label: 'AI代码移除' },
  'goal:completed': { category: '变更', label: '目标完成' },
  'goal:failed': { category: '修复', label: '目标失败' },
  'goal:decomposed': { category: '变更', label: '目标分解' },
  'skill:created': { category: '新增', label: '技能创建' },
  'skill:deleted': { category: '移除', label: '技能删除' },
  'file:changed': { category: '变更', label: '文件变更' },
};

const VALID_CATEGORIES = new Set(['新增', '变更', '修复', '移除']);

/**
 * @module runtime/infrastructure/auto-version-tracker
 * AutoVersionTracker — 自动版本追踪器
 * 监听事件总线上的框架事件，自动递增版本号并记录变更条目。
 * 支持AI修改记录（含模块/实现方式/业务价值元数据）、缓冲批量写入、
 * CHANGELOG.md自动生成、因果ID提取和版本前缀配置。
 * @classdesc 自动版本追踪器。文件变更检测、版本号自动递增
 * @extends EventEmitter
 */
class AutoVersionTracker extends EventEmitter {
  /**
   * 创建 AutoVersionTracker 实例。
   * @param {Object} options - 配置选项
   * @param {Object} options.archive - 变更日志归档实例，用于记录版本条目
   * @param {EventBus} options.eventBus - 事件总线实例，用于监听框架事件
   * @param {string} options.projectRoot - 项目根目录路径
   * @param {Object} [options.config] - 额外配置
   * @param {boolean} [options.config.enabled=true] - 是否启用版本追踪
   * @param {number} [options.config.flushInterval] - 缓冲刷盘间隔（毫秒）
   * @param {number} [options.config.maxBufferSize=10] - 缓冲区最大容量
   * @param {string} [options.config.versionPrefix='0.0.'] - 版本号前缀
   * @param {Object} [options.causalDataBus] - 因果数据总线实例，用于提取因果ID
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this.archive = opts.archive ?? null;
    this.eventBus = opts.eventBus ?? null;
    this.config = opts.config ?? {};
    this.projectRoot = opts.projectRoot ?? null;
    this._causalDataBus = opts.causalDataBus ?? null;
    this._versionCounter = 0;
    this._pendingBuffer = [];
    this._flushTimer = null;
    this._flushInterval = this.config.flushInterval ?? DEFAULT_MIN_HEARTBEAT_MS;
    this._maxBufferSize = this.config.maxBufferSize ?? 10;
    this._enabled = this.config.enabled !== false;
    this._lastRecordedVersion = null;
    this._stats = { recorded: 0, skipped: 0, errors: 0 };
    this._versionPrefix = this.config.versionPrefix ?? '0.0.';
    this._pendingWritePromise = Promise.resolve();
    this._loadLastVersion();
    if (this._enabled) this._attachListeners();
  }

  _loadLastVersion() {
    try {
      if (!this.archive) return;
      const index = this.archive._readIndex ? this.archive._readIndex() : null;
      if (index && index.versions && index.versions.length > 0) {
        const last = index.versions[index.versions.length - 1];
        this._lastRecordedVersion = last.version;
        const match = last.version.match(/\.(\d+)$/);
        if (match) {
          const parsed = parseInt(match[1], 10);
          this._versionCounter = Number.isFinite(parsed) ? parsed : 0;
        }
      }
    } catch (_err) {
      debug('AutoVersionTracker', '_loadIndex:parse', _err && _err.message ? _err.message : String(_err));
      this._versionCounter = 0;
    }
  }

  _nextVersion() {
    this._versionCounter++;
    if (this._versionCounter > Number.MAX_SAFE_INTEGER) {
      this._versionCounter = 1;
    }
    return this._versionPrefix + this._versionCounter;
  }

  _attachListeners() {
    if (!this.eventBus) return;
    if (this._eventHandlers && this._eventHandlers.length > 0) return; // Guard against duplicate attachment
    const self = this;
    const events = Object.keys(EVENT_CATEGORY_MAP);
    this._eventHandlers = [];
    events.forEach(function(eventName) {
      function handler(data) {
        self._onEvent(eventName, data);
      }
      self.eventBus.on(eventName, handler);
      self._eventHandlers.push({ event: eventName, handler: handler });
    });
  }

  _onEvent(eventName, data) {
    if (!this._enabled || !this.archive) return;
    const mapping = EVENT_CATEGORY_MAP[eventName];
    if (!mapping) return;

    const entry = this._buildEntry(eventName, data, mapping);
    this._pendingBuffer.push(entry);

    if (this._pendingBuffer.length >= this._maxBufferSize) {
      this._flush();
    } else if (!this._flushTimer) {
      this._scheduleFlush();
    }
  }

  _buildEntry(eventName, data, mapping) {
    const sessionId = (data && data.sessionId) || '';
    const agentId = (data && data.agentId) || (data && data.agent) || '';
    const skillId = (data && data.skillId) || '';
    const phase = (data && data.to) || (data && data.phase) || '';

    const summary = this._buildSummary(mapping.label, skillId, agentId, sessionId);
    const changes = this._buildChanges(mapping.category, summary, data);

    return {
      version: this._nextVersion(),
      summary,
      category: mapping.category,
      agent: agentId || 'system',
      phase,
      changes,
      files: (data && data.files) ?? [],
      sourceEvent: eventName,
      causalId: this._causalDataBus ? this._extractCausalId(data) : null,
      parentVersion: this._lastRecordedVersion,
    };
  }

  _validateModification(modification) {
    if (!modification || typeof modification !== 'object') return { error: 'invalid modification object' };
    const category = modification.category || '变更';
    if (!VALID_CATEGORIES.has(category)) return { error: 'invalid category: ' + category };
    return {
      category,
      summary: modification.summary || 'AI修改',
      files: Array.isArray(modification.files) ? modification.files : [],
      agent: modification.agent || 'AI',
      module: modification.module || '',
      method: modification.method || '',
      value: modification.value || '',
      details: modification.details || '',
      subItems: Array.isArray(modification.subItems) ? modification.subItems : [],
      phase: modification.phase || '',
      sourceEvent: modification.sourceEvent || 'ai:code-modified',
    };
  }

  _buildChangeDetail(summary, module, method, value) {
    return summary +
      (module ? '（模块：' + module + ')' : '') +
      (method ? '（实现方式：' + method + ')' : '') +
      (value ? '（业务价值：' + value + '）' : '');
  }

  /**
   * 记录AI修改条目。验证修改对象后生成版本条目，写入缓冲区和CHANGELOG.md。
   * @param {Object} modification - AI修改描述对象
   * @param {string} [modification.category='变更'] - 修改类别，必须为'新增'、'变更'、'修复'或'移除'之一
   * @param {string} [modification.summary='AI修改'] - 修改摘要
   * @param {string[]} [modification.files=[]] - 涉及的文件列表
   * @param {string} [modification.agent='AI'] - 执行修改的Agent标识
   * @param {string} [modification.module=''] - 涉及的模块名称
   * @param {string} [modification.method=''] - 实现方式
   * @param {string} [modification.value=''] - 业务价值描述
   * @param {string} [modification.details=''] - 详细说明
   * @param {string[]} [modification.subItems=[]] - 子条目列表
   * @param {string} [modification.phase=''] - 执行阶段
   * @param {string} [modification.sourceEvent='ai:code-modified'] - 源事件名称
   * @returns {{success: boolean, version?: string, summary?: string, error?: string}} 记录结果
   */
  recordAIModification(modification) {
    if (!this._enabled || !this.archive) return { success: false, error: 'tracker not enabled' };
    const validated = this._validateModification(modification);
    if (validated.error) return { success: false, error: validated.error };

    const changes = {};
    changes[validated.category] = [this._buildChangeDetail(validated.summary, validated.module, validated.method, validated.value)];

    const entry = {
      version: this._nextVersion(),
      summary: validated.summary,
      category: validated.category,
      agent: validated.agent,
      phase: validated.phase,
      changes,
      files: validated.files,
      sourceEvent: validated.sourceEvent,
      causalId: null,
      parentVersion: this._lastRecordedVersion,
      aiModification: true,
      module: validated.module,
      method: validated.method,
      value: validated.value,
      details: validated.details,
      subItems: validated.subItems,
    };

    this._pendingBuffer.push(entry);

    if (this._pendingBuffer.length >= this._maxBufferSize) {
      this._flush();
    } else if (!this._flushTimer) {
      this._scheduleFlush();
    }

    this._writeToChangelogMd(entry);

    return { success: true, version: entry.version, summary: entry.summary };
  }

  _buildSummary(label, skillId, agentId, sessionId) {
    let summary = label;
    if (skillId) summary += ': ' + skillId;
    else if (agentId) summary += ': ' + agentId;
    else if (sessionId) summary += ': ' + sessionId.substring(0, 8);
    return summary;
  }

  _buildChanges(category, summary, data) {
    const changes = {};
    let changeDetail = summary;
    if (data && data.result !== undefined) changeDetail += ' (result: ' + String(data.result) + ')';
    if (data && data.score !== undefined) changeDetail += ' (score: ' + String(data.score) + ')';
    changes[category] = [changeDetail];
    return changes;
  }

  _extractCausalId(data) {
    if (!data) return null;
    return data.causalId ?? data._causalId ?? null;
  }

  _scheduleFlush() {
    const self = this;
    this._flushTimer = setTimeout(function() {
      if (self._shutDown) return;
      self._flush();
    }, this._flushInterval);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pendingBuffer.length === 0) return;

    const batch = this._pendingBuffer.splice(0, this._pendingBuffer.length);
    const self = this;
    const failed = [];
    batch.forEach(function(entry) {
      try {
        const result = self.archive.record(entry);
        if (result.success) {
          self._lastRecordedVersion = entry.version;
          self._stats.recorded++;
          debug('AutoVersionTracker', 'recorded', entry.version, entry.summary);
          if (!entry.aiModification) {
            self._writeToChangelogMd(entry);
          }
          self.emit('version-recorded', { version: entry.version, summary: entry.summary, category: entry.category, agent: entry.agent });
        } else {
          self._stats.skipped++;
          failed.push(entry);
        }
      } catch (err) {
        self._stats.errors++;
        debug('AutoVersionTracker', 'error', err && err.message ? err.message : String(err));
        failed.push(entry);
      }
    });
    if (failed.length > 0) {
      this._pendingBuffer.unshift(...failed);
    }
  }

  /**
   * 获取版本追踪器的运行统计数据。
   * @returns {{enabled: boolean, recorded: number, skipped: number, errors: number, lastRecordedVersion: string|null, pendingCount: number, versionCounter: number, trackedEvents: string[]}} 统计信息对象
   */
  getStats() {
    return {
      enabled: this._enabled,
      recorded: this._stats.recorded,
      skipped: this._stats.skipped,
      errors: this._stats.errors,
      lastRecordedVersion: this._lastRecordedVersion,
      pendingCount: this._pendingBuffer.length,
      versionCounter: this._versionCounter,
      trackedEvents: Object.keys(EVENT_CATEGORY_MAP),
    };
  }

  async _writeToChangelogMdAsync(entry) {
    if (!this.projectRoot) return;
    try {
      const changelogPath = path.join(this.projectRoot, 'CHANGELOG.md');
      let content = '';
      try {
        content = await fs.promises.readFile(changelogPath, UTF8_ENCODING);
      } catch (_e) {
        content = '# 更新日志\n\n本文件系统记录多Agent框架的完整迭代信息。\n\n格式基于 [保持更新日志](https://keepachangelog.com/zh-CN/1.1.0/)，并扩展了迭代元数据。\n\n---\n\n';
      }

      const now = new Date();
      const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const timeStr = dateStr + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

      const sectionMap = { '新增': '### 新增', '变更': '### 变更', '修复': '### 修复', '移除': '### 移除' };
      const sectionHeader = sectionMap[entry.category] || '### 变更';

      let itemLine = '- **' + entry.summary + '**';
      if (entry.module) itemLine += '（模块：' + entry.module + ' / ';
      if (entry.method) itemLine += '实现方式：' + entry.method + ' / ';
      if (entry.value) itemLine += '业务价值：' + entry.value;
      if (entry.module || entry.method || entry.value) itemLine += '）';

      if (entry.subItems && entry.subItems.length > 0) {
        for (const sub of entry.subItems) {
          itemLine += '\n  - ' + sub;
        }
      }
      if (entry.files && entry.files.length > 0) {
        itemLine += '\n  - 修改文件：' + entry.files.join('、');
      }

      const versionTag = '## [' + entry.version + '] - ' + dateStr;
      const metaComments = '<!-- agent: ' + entry.agent + ' -->\n<!-- timestamp: ' + timeStr + ' -->\n<!-- source: ' + entry.sourceEvent + ' -->';

      const newBlock = versionTag + '\n\n' + metaComments + '\n\n' + sectionHeader + '\n\n' + itemLine + '\n\n';

      const separatorIdx = content.indexOf('\n---\n');
      if (separatorIdx >= 0) {
        content = content.substring(0, separatorIdx + 5) + '\n' + newBlock + content.substring(separatorIdx + 5);
      } else {
        content += '\n' + newBlock;
      }

      await fs.promises.writeFile(changelogPath, content, UTF8_ENCODING);
      debug('AutoVersionTracker', 'changelogMdWritten', entry.version, entry.summary);
    } catch (err) {
      debug('AutoVersionTracker', 'changelogMdWriteError', err && err.message ? err.message : String(err));
    }
  }

  _writeToChangelogMd(entry) {
    this._pendingWritePromise = this._writeToChangelogMdAsync(entry).catch(function(err) {
      debug('AutoVersionTracker', 'changelogMdWriteError', err && err.message ? err.message : String(err));
    });
  }

  /**
   * 等待所有待处理的CHANGELOG.md异步写入完成。
   * @returns {Promise<void>} 所有写入完成后的 Promise
   */
  waitForPendingWrites() {
    return this._pendingWritePromise;
  }

  /**
   * 获取最近的版本记录列表。从归档索引中按时间倒序返回指定数量的条目。
   * @param {number} [limit=10] - 返回的最大记录数
   * @returns {Array<Object>} 版本记录数组，每条包含 version、summary、category 等字段
   */
  getRecentRecords(limit) {
    if (!this.archive) return [];
    try {
      const index = this.archive._readIndex ? this.archive._readIndex() : null;
      if (!index || !index.versions) return [];
      const n = limit ?? 10; return n > 0 ? index.versions.slice(-n).reverse() : [];
    } catch (_err) {
      debug('AutoVersionTracker', 'archiveIndexRead', _err && _err.message ? _err.message : String(_err));
      return [];
    }
  }

  async _onShutdown() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush();
    this._enabled = false;
    await this.waitForPendingWrites();
    if (this._eventHandlers && this.eventBus) {
      for (const h of this._eventHandlers) {
        safeCall(() => this.eventBus.off(h.event, h.handler), 'AutoVersionTracker', 'shutdown');
      }
      this._eventHandlers = [];
    }
    this.removeAllListeners();
  }

  /**
   * 检查版本追踪器是否健康。启用且未关闭时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return this._enabled && !this._shutDown;
  }
}

AutoVersionTracker = withShutdown(AutoVersionTracker);

AutoVersionTracker.EVENT_CATEGORY_MAP = EVENT_CATEGORY_MAP;

module.exports = AutoVersionTracker;
