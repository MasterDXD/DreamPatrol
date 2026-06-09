'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { safeExecute } = require('../../utils/safe-execute');
const { secureId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

/**
 * @module runtime/optimization/research-journal
 * 研究日志聚合器 — 实现Auto Research闭环中的"研究日志"环节。
 *
 * 核心理念：AI的每一次改动都记录在日志中，随着模型迭代，
 * 这些日志成为持续进化的核心资产。
 *
 * 核心能力：
 * - 统一研究叙事（将分散日志聚合为"为什么做→做了什么→结果如何→下一步"结构）
 * - 多源日志聚合（OptimizationLoop的MD日志、SkillVersionLineage的版本谱系、
 *   SkillAuditTrail的审计轨迹、ContentPublisher的发布记录）
 * - 研究经验索引（按领域、目标、结果索引，支持跨场景检索）
 * - 研究叙事导出（Markdown/JSON格式）
 * - 跨场景迁移支持（从场景A的研究历史提取可迁移模式）
 */

/** @constant {Object} ENTRY_TYPES - 日志条目类型 */
const ENTRY_TYPES = {
  OBSERVATION: 'observation',    // 观察记录
  HYPOTHESIS: 'hypothesis',      // 假设记录
  EXPERIMENT: 'experiment',      // 实验记录
  ANALYSIS: 'analysis',          // 分析记录
  REFINEMENT: 'refinement',      // 精炼/优化记录
  PUBLICATION: 'publication',    // 内容发布记录
  MILESTONE: 'milestone',        // 里程碑
  INSIGHT: 'insight',            // 洞察发现
};

/** @constant {Object} NARRATIVE_SECTIONS - 叙事结构章节 */
const NARRATIVE_SECTIONS = {
  WHY: 'why',           // 为什么做
  WHAT: 'what',         // 做了什么
  RESULT: 'result',     // 结果如何
  NEXT: 'next',         // 下一步计划
  TRANSFERABLE: 'transferable', // 可迁移经验
};

/** @constant {Object} DEFAULT_OPTIONS - 默认配置 */
const DEFAULT_OPTIONS = {
  maxEntries: 2000,
  maxNarratives: 100,
  enableAutoNarrative: true,
  narrativeInterval: 5,  // 每5条entry自动生成一次叙事
  exportFormat: 'markdown',
};

/**
 * @classdesc 研究日志聚合器。将分散的研究记录聚合为统一的结构化研究叙事，
 * 支持多源日志聚合、研究经验索引、叙事导出和跨场景迁移。
 *
 * @extends EventEmitter
 * @emits 'entry-recorded' 当日志条目被记录时触发
 * @emits 'narrative-generated' 当研究叙事被生成时触发
 * @emits 'shutdown' 当关闭时触发
 */
class ResearchJournal extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._entries = [];           // 日志条目
    this._narratives = [];        // 研究叙事
    this._domainIndex = new Map(); // 按领域索引
    this._goalIndex = new Map();   // 按目标索引
    this._resultIndex = new Map(); // 按结果索引(成功/失败)
    this._transferablePatterns = []; // 可迁移模式
    this._stats = {
      totalEntries: 0,
      totalNarratives: 0,
      byType: {},
      byDomain: {},
    };
    this._shutDown = false;
  }

  /**
   * 记录日志条目。
   * @param {Object} entry - 日志条目
   * @param {string} entry.type - 条目类型（ENTRY_TYPES中的值）
   * @param {string} entry.domain - 研究领域
   * @param {string} [entry.goal] - 研究目标
   * @param {string|null} [entry.loopId] - 关联的循环ID
   * @param {number} [entry.timestamp] - 时间戳
   * @param {Object} [entry.data] - 附加数据
   * @param {string} [entry.why] - 为什么做
   * @param {string} [entry.what] - 做了什么
   * @param {string} [entry.result] - 结果如何
   * @param {string} [entry.next] - 下一步
   * @param {string} [entry.transferable] - 可迁移经验
   * @returns {{success: boolean, id?: string, error?: string}} 记录结果
   * @emits 'entry-recorded'
   */
  recordEntry(entry) {
    this.guardShutdown();
    if (!entry || !entry.type || !entry.domain) {
      return { success: false, error: 'Entry type and domain are required' };
    }

    const record = {
      id: secureId('je-'),
      type: entry.type,
      domain: entry.domain,
      goal: entry.goal ?? '',
      loopId: entry.loopId ?? null,
      timestamp: entry.timestamp ?? Date.now(),
      data: entry.data ?? {},
      // 结构化叙事字段
      why: entry.why ?? '',       // 为什么做
      what: entry.what ?? '',     // 做了什么
      result: entry.result ?? '', // 结果如何
      next: entry.next ?? '',     // 下一步
      transferable: entry.transferable ?? '', // 可迁移经验
    };

    this._entries.push(record);
    this._updateIndices(record);
    this._stats.totalEntries++;
    this._stats.byType[record.type] = (this._stats.byType[record.type] ?? 0) + 1;
    this._stats.byDomain[record.domain] = (this._stats.byDomain[record.domain] ?? 0) + 1;

    // 自动生成叙事
    if (this._options.enableAutoNarrative && this._entries.length % this._options.narrativeInterval === 0) {
      this._autoGenerateNarrative(record.domain);
    }

    // 维护大小限制
    if (this._entries.length > this._options.maxEntries) {
      const removed = this._entries.shift();
      this._removeFromIndices(removed);
    }

    this.emit('entry-recorded', { id: record.id, type: record.type, domain: record.domain });
    debug('ResearchJournal', 'recordEntry', 'id=' + record.id + ' type=' + record.type);
    return { success: true, id: record.id };
  }

  /**
   * 批量导入外部日志。
   * @param {Array<Object>} entries - 日志条目数组
   * @returns {{success: boolean, imported: number, failed: number, error?: string}} 导入结果
   */
  importEntries(entries) {
    this.guardShutdown();
    if (!Array.isArray(entries)) return { success: false, error: 'Entries must be an array' };
    const results = [];
    for (const entry of entries) {
      results.push(this.recordEntry(entry));
    }
    return { success: true, imported: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length };
  }

  /**
   * 生成研究叙事。将指定领域的日志条目聚合为"为什么做→做了什么→结果如何→下一步"结构。
   * @param {string} domain - 研究领域
   * @param {Object} [options] - 生成选项
   * @param {number} [options.limit=50] - 参与叙事的最近条目数
   * @returns {{success: boolean, narrative?: Object, error?: string}} 叙事生成结果
   * @emits 'narrative-generated'
   */
  generateNarrative(domain, options) {
    this.guardShutdown();
    const domainEntries = this._domainIndex.get(domain) ?? [];
    if (domainEntries.length === 0) {
      return { success: false, error: 'No entries found for domain: ' + domain };
    }

    const limit = options?.limit ?? 50;
    const recentEntries = domainEntries.slice(-limit);

    const narrative = {
      id: secureId('narr-'),
      domain,
      generatedAt: Date.now(),
      entryCount: recentEntries.length,
      sections: {
        [NARRATIVE_SECTIONS.WHY]: this._buildWhySection(recentEntries),
        [NARRATIVE_SECTIONS.WHAT]: this._buildWhatSection(recentEntries),
        [NARRATIVE_SECTIONS.RESULT]: this._buildResultSection(recentEntries),
        [NARRATIVE_SECTIONS.NEXT]: this._buildNextSection(recentEntries),
        [NARRATIVE_SECTIONS.TRANSFERABLE]: this._buildTransferableSection(recentEntries),
      },
      summary: '',
    };

    narrative.summary = this._buildSummary(narrative.sections);

    this._narratives.push(narrative);
    this._stats.totalNarratives++;
    if (this._narratives.length > this._options.maxNarratives) {
      this._narratives.shift();
    }

    this.emit('narrative-generated', { id: narrative.id, domain });
    debug('ResearchJournal', 'generateNarrative', 'id=' + narrative.id + ' domain=' + domain);
    return { success: true, narrative };
  }

  /**
   * 查询日志条目。
   * @param {Object} [filters] - 过滤条件
   * @param {string} [filters.type] - 按条目类型过滤
   * @param {string} [filters.domain] - 按领域过滤
   * @param {string} [filters.goal] - 按目标过滤
   * @param {string} [filters.loopId] - 按循环ID过滤
   * @param {number} [filters.from] - 起始时间戳
   * @param {number} [filters.to] - 结束时间戳
   * @param {number} [filters.limit] - 返回数量限制
   * @returns {Array<Object>} 匹配的日志条目列表
   */
  query(filters) {
    let results = [...this._entries];
    if (filters?.type) results = results.filter(e => e.type === filters.type);
    if (filters?.domain) results = results.filter(e => e.domain === filters.domain);
    if (filters?.goal) results = results.filter(e => e.goal === filters.goal);
    if (filters?.loopId) results = results.filter(e => e.loopId === filters.loopId);
    if (filters?.from) results = results.filter(e => e.timestamp >= filters.from);
    if (filters?.to) results = results.filter(e => e.timestamp <= filters.to);
    if (filters?.limit) results = results.slice(-filters.limit);
    return results;
  }

  /**
   * 提取可迁移模式。从成功的研究记录中提取可迁移到其他领域的经验。
   * @param {string} [sourceDomain] - 源领域（不指定则从所有领域提取）
   * @returns {Array<Object>} 可迁移模式列表
   */
  extractTransferablePatterns(sourceDomain) {
    this.guardShutdown();
    const entries = sourceDomain
      ? (this._domainIndex.get(sourceDomain) ?? [])
      : this._entries;

    const patterns = [];
    const successEntries = entries.filter(e => e.result && (e.result.includes('success') || e.result.includes('improved')));

    for (const entry of successEntries) {
      if (entry.transferable) {
        patterns.push({
          sourceDomain: entry.domain,
          pattern: entry.transferable,
          originalGoal: entry.goal,
          applicableTo: this._inferApplicableDomains(entry.domain),
        });
      }
    }

    this._transferablePatterns = patterns;
    return patterns;
  }

  /**
   * 导出为Markdown格式。
   * @param {string} [domain] - 指定领域（不指定则导出全部）
   * @returns {string} Markdown格式的研究日志
   */
  exportMarkdown(domain) {
    const entries = domain ? (this._domainIndex.get(domain) ?? []) : this._entries;
    let md = '# 研究日志\n\n';
    md += '> 生成时间: ' + new Date().toISOString() + '\n';
    md += '> 条目数: ' + entries.length + '\n\n';

    for (const entry of entries) {
      md += '## [' + entry.type.toUpperCase() + '] ' + (entry.what || entry.goal) + '\n';
      md += '- **时间**: ' + new Date(entry.timestamp).toISOString() + '\n';
      md += '- **领域**: ' + entry.domain + '\n';
      if (entry.why) md += '- **原因**: ' + entry.why + '\n';
      if (entry.result) md += '- **结果**: ' + entry.result + '\n';
      if (entry.next) md += '- **下一步**: ' + entry.next + '\n';
      if (entry.transferable) md += '- **可迁移**: ' + entry.transferable + '\n';
      md += '\n';
    }

    return md;
  }

  /**
   * 导出为JSON格式。
   * @param {string} [domain] - 指定领域（不指定则导出全部）
   * @returns {string} JSON格式的研究日志
   */
  exportJSON(domain) {
    const entries = domain ? (this._domainIndex.get(domain) ?? []) : this._entries;
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      totalEntries: entries.length,
      entries,
    }, null, 2);
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return { ...this._stats, entriesSize: this._entries.length, narrativesSize: this._narratives.length };
  }

  /**
   * 更新索引。
   * @param {Object} entry - 日志条目
   * @private
   */
  _updateIndices(entry) {
    // 领域索引
    if (!this._domainIndex.has(entry.domain)) this._domainIndex.set(entry.domain, []);
    this._domainIndex.get(entry.domain).push(entry);
    // 目标索引
    if (entry.goal) {
      if (!this._goalIndex.has(entry.goal)) this._goalIndex.set(entry.goal, []);
      this._goalIndex.get(entry.goal).push(entry);
    }
    // 结果索引
    const resultKey = entry.result && (entry.result.includes('success') || entry.result.includes('improved')) ? 'success' : 'other';
    if (!this._resultIndex.has(resultKey)) this._resultIndex.set(resultKey, []);
    this._resultIndex.get(resultKey).push(entry);
  }

  /**
   * 从索引中移除条目。
   * @param {Object} entry - 日志条目
   * @private
   */
  _removeFromIndices(entry) {
    const domainEntries = this._domainIndex.get(entry.domain);
    if (domainEntries) {
      const idx = domainEntries.indexOf(entry);
      if (idx >= 0) domainEntries.splice(idx, 1);
    }
  }

  /**
   * 自动生成叙事。
   * @param {string} domain - 研究领域
   * @private
   */
  _autoGenerateNarrative(domain) {
    safeExecute(() => this.generateNarrative(domain), 'ResearchJournal', '_autoGenerateNarrative');
  }

  /**
   * 构建"为什么做"章节。
   * @param {Array<Object>} entries - 日志条目列表
   * @returns {string} 章节内容
   * @private
   */
  _buildWhySection(entries) {
    const whyEntries = entries.filter(e => e.why);
    if (whyEntries.length === 0) return '暂无原因记录';
    return whyEntries.map(e => '- ' + e.why).join('\n');
  }

  /**
   * 构建"做了什么"章节。
   * @param {Array<Object>} entries - 日志条目列表
   * @returns {string} 章节内容
   * @private
   */
  _buildWhatSection(entries) {
    const whatEntries = entries.filter(e => e.what);
    if (whatEntries.length === 0) return '暂无操作记录';
    return whatEntries.map(e => '- ' + e.what).join('\n');
  }

  /**
   * 构建"结果如何"章节。
   * @param {Array<Object>} entries - 日志条目列表
   * @returns {string} 章节内容
   * @private
   */
  _buildResultSection(entries) {
    const resultEntries = entries.filter(e => e.result);
    if (resultEntries.length === 0) return '暂无结果记录';
    return resultEntries.map(e => '- ' + e.result).join('\n');
  }

  /**
   * 构建"下一步计划"章节。
   * @param {Array<Object>} entries - 日志条目列表
   * @returns {string} 章节内容
   * @private
   */
  _buildNextSection(entries) {
    const nextEntries = entries.filter(e => e.next);
    if (nextEntries.length === 0) return '暂无下一步计划';
    return nextEntries.map(e => '- ' + e.next).join('\n');
  }

  /**
   * 构建"可迁移经验"章节。
   * @param {Array<Object>} entries - 日志条目列表
   * @returns {string} 章节内容
   * @private
   */
  _buildTransferableSection(entries) {
    const transferable = entries.filter(e => e.transferable);
    if (transferable.length === 0) return '暂无可迁移经验';
    return transferable.map(e => '- [' + e.domain + '] ' + e.transferable).join('\n');
  }

  /**
   * 构建叙事摘要。
   * @param {Object} sections - 叙事章节
   * @returns {string} 摘要文本
   * @private
   */
  _buildSummary(sections) {
    return '研究目标: ' + (sections.why || 'N/A').substring(0, 100)
      + ' | 执行: ' + (sections.what || 'N/A').split('\n').length + '项操作'
      + ' | 结果: ' + (sections.result || 'N/A').substring(0, 100);
  }

  /**
   * 推断可适用领域。
   * @param {string} sourceDomain - 源领域
   * @returns {Array<string>} 可适用领域列表
   * @private
   */
  _inferApplicableDomains(sourceDomain) {
    // 简单的领域关联推断
    const domainGroups = {
      content: ['operations', 'user_experience'],
      operations: ['content', 'workflow'],
      ml_research: ['code_quality', 'performance'],
      workflow: ['operations', 'performance'],
      code_quality: ['ml_research', 'security'],
      user_experience: ['content', 'operations'],
      performance: ['ml_research', 'workflow'],
      security: ['code_quality', 'performance'],
    };
    return domainGroups[sourceDomain] ?? [];
  }

  /**
   * 关闭时清理所有数据。
   * @protected
   */
  _onShutdown() {
    this._entries = [];
    this._narratives = [];
    this._domainIndex.clear();
    this._goalIndex.clear();
    this._resultIndex.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(ResearchJournal);
module.exports.ENTRY_TYPES = ENTRY_TYPES;
module.exports.NARRATIVE_SECTIONS = NARRATIVE_SECTIONS;
