'use strict';

/**
 * @module runtime/deepening/deepening-audit-trail
 * 深化推理子系统审计追踪模块。在环形缓冲区中记录带有执行者、资源、分类和严重级别元数据的操作，
 * 维护多维度索引以支持快速查询，支持可插拔过滤器、驱逐时索引维护及合规报告生成。
 */

const DeepeningBase = require('./deepening-base');
const { DeepeningError } = require('../../errors');
const RingBuffer = require('../../utils/ring-buffer');
const { debug } = require('../../utils/debug-logger');
const { requireFunction_ } = require('../../utils/param-validator');
const { counterId, ID_PREFIXES } = require('../../utils/unique-id');
const { DEFAULT_MAX_ENTRIES } = require('../../utils/constants');
const { emitError } = require('../../utils/safe-execute');

/** @constant {number} MAX_FILTERS - 最大过滤器数量 */
const MAX_FILTERS = 50;

/**
 * 深化推理审计追踪器。在环形缓冲区中记录操作审计条目，维护多维度索引（按结果/操作/执行者/分类/严重级别），
 * 支持可插拔过滤器、驱逐时索引维护和合规报告生成。
 * @classdesc 深化审计轨迹。操作记录、变更追踪、合规审计
 * @extends DeepeningBase
 * @emits DeepeningAuditTrail#filtered - 条目被过滤器过滤时触发
 * @emits DeepeningAuditTrail#filter-error - 过滤器执行出错时触发
 * @emits DeepeningAuditTrail#recorded - 条目被记录时触发
 * @emits DeepeningAuditTrail#audit-recorded - 条目被记录时触发（与recorded同义，用于事件总线桥接）
 * @emits DeepeningAuditTrail#filter-added - 过滤器被添加时触发
 * @emits DeepeningAuditTrail#cleared - 审计记录被清空时触发
 */
class DeepeningAuditTrail extends DeepeningBase {

  /**
   * 创建DeepeningAuditTrail实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxEntries] - 环形缓冲区最大条目数
   */
  constructor(options) {
    super(options);
    this._maxEntries = (options && options.maxEntries) ?? DEFAULT_MAX_ENTRIES;
    this._entries = new RingBuffer(this._maxEntries);
    this._entryById = new Map();
    this._filters = [];
    this._totalFiltered = 0;
    this._totalRecorded = 0;
    this._securityViolationCount = 0;
    this._byResult = {};
    this._byAction = {};
    this._byActor = {};
    this._byCategory = {};
    this._bySeverity = {};
    this._failureCount = 0;
  }

  /**
   * 对条目依次应用所有过滤器，任一过滤器返回false则拒绝记录。
   * @param {Object} entry - 待过滤的审计条目
   * @returns {boolean} 通过所有过滤器返回true，否则返回false
   * @emits DeepeningAuditTrail#filtered
   * @emits DeepeningAuditTrail#filter-error
   */
  _applyFilters(entry) {
    for (const filterFn of this._filters) {
      try {
        if (!filterFn(entry)) {
          this._totalFiltered++;
          this.emit('filtered', entry);
          return false;
        }
      } catch (fErr) { debug('DeepeningAuditTrail', 'record', 'filter error', fErr && fErr.message ? fErr.message : String(fErr)); emitError(this, 'filter-error', fErr); }
    }
    return true;
  }

  /**
   * 更新多维度索引计数（按结果/操作/执行者/分类/严重级别）。
   * @param {Object} entry - 审计条目
   */
  _updateIndices(entry) {
    const action = entry.action;
    if (entry.result) this._byResult[entry.result] = (this._byResult[entry.result] ?? 0) + 1;
    this._byAction[action] = (this._byAction[action] ?? 0) + 1;
    if (entry.actor) this._byActor[entry.actor] = (this._byActor[entry.actor] ?? 0) + 1;
    if (entry.category) this._byCategory[entry.category] = (this._byCategory[entry.category] ?? 0) + 1;
    this._bySeverity[entry.severity] = (this._bySeverity[entry.severity] ?? 0) + 1;
    if (entry.result === 'failure' || entry.severity === 'error') this._failureCount++;
    if (action && (action.includes('security') || action.includes('violation'))) this._securityViolationCount++;
  }

  /**
   * 驱逐条目时递减多维度索引计数。
   * @param {Object} entry - 被驱逐的审计条目
   */
  _decrementIndices(entry) {
    if (entry.result) {
      this._byResult[entry.result] = Math.max(0, (this._byResult[entry.result] ?? 0) - 1);
      if (this._byResult[entry.result] <= 0) delete this._byResult[entry.result];
    }
    this._byAction[entry.action] = Math.max(0, (this._byAction[entry.action] ?? 0) - 1);
    if (this._byAction[entry.action] <= 0) delete this._byAction[entry.action];
    if (entry.actor) {
      this._byActor[entry.actor] = Math.max(0, (this._byActor[entry.actor] ?? 0) - 1);
      if (this._byActor[entry.actor] <= 0) delete this._byActor[entry.actor];
    }
    if (entry.category) {
      this._byCategory[entry.category] = Math.max(0, (this._byCategory[entry.category] ?? 0) - 1);
      if (this._byCategory[entry.category] <= 0) delete this._byCategory[entry.category];
    }
    this._bySeverity[entry.severity] = Math.max(0, (this._bySeverity[entry.severity] ?? 0) - 1);
    if (this._bySeverity[entry.severity] <= 0) delete this._bySeverity[entry.severity];
    if (entry.result === 'failure' || entry.severity === 'error') this._failureCount = Math.max(0, this._failureCount - 1);
    if (entry.action && (entry.action.includes('security') || entry.action.includes('violation'))) this._securityViolationCount = Math.max(0, this._securityViolationCount - 1);
  }

  /**
   * 记录一条审计条目。通过过滤器后写入环形缓冲区，更新索引，缓冲区满时驱逐最旧条目。
   * @param {string} action - 操作名称，必须为非空字符串
   * @param {Object} [options] - 条目选项
   * @param {string} [options.actor] - 执行者标识
   * @param {string} [options.resource] - 操作资源
   * @param {string} [options.executionId] - 关联的执行ID
   * @param {string} [options.details] - 操作详情
   * @param {string} [options.result] - 操作结果
   * @param {string} [options.category] - 操作分类
   * @param {string} [options.severity='info'] - 严重级别
   * @param {Object} [options.metadata] - 附加元数据
   * @returns {Object|null} 记录的条目对象，被过滤时返回null
   * @throws {DeepeningError} action为空或非字符串时抛出
   * @emits DeepeningAuditTrail#recorded
   * @emits DeepeningAuditTrail#audit-recorded
   */
  record(action, options) {
    this.guardShutdown();
    if (!action || typeof action !== 'string') throw new DeepeningError('INVALID_INPUT', 'Action must be a non-empty string');
    const opts = options ?? {};
    const entry = { id: counterId(ID_PREFIXES.AUDIT), action, actor: opts.actor, resource: opts.resource, executionId: opts.executionId, details: opts.details, result: opts.result, category: opts.category, severity: opts.severity ?? 'info', metadata: opts.metadata, timestamp: Date.now() };
    if (!this._applyFilters(entry)) return null;
    const prevSize = this._entries.size;
    const willEvict = prevSize >= this._maxEntries;
    const evictedEntry = willEvict ? this._entries.peek() : null;
    this._entries.push(entry);
    this._entryById.set(entry.id, entry);
    if (willEvict && evictedEntry && evictedEntry.id) {
      this._entryById.delete(evictedEntry.id);
      this._decrementIndices(evictedEntry);
    }
    this._totalRecorded++;
    this._updateIndices(entry);
    this.emit('recorded', entry);
    this.emit('audit-recorded', entry);
    return entry;
  }

  /**
   * 根据ID获取审计条目。
   * @param {string} id - 条目ID
   * @returns {Object|null} 匹配的条目对象，未找到返回null
   */
  getEntry(id) { return this._entryById.get(id) ?? null; }

  /**
   * 获取审计条目列表，支持按操作和执行者过滤及分页。
   * @param {Object} [filters] - 过滤条件
   * @param {string} [filters.action] - 按操作名称过滤
   * @param {string} [filters.actor] - 按执行者过滤
   * @param {number} [filters.offset=0] - 分页偏移量
   * @param {number} [filters.limit] - 每页条目数
   * @returns {Object[]} 过滤后的条目数组
   */
  getEntries(filters) {
    if (!filters) return this._entries.toArray().map(e => ({ ...e }));
    const result = this._entries.filter(e => {
      if (filters.action && e.action !== filters.action) return false;
      if (filters.actor && e.actor !== filters.actor) return false;
      return true;
    });
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  /**
   * 多维度查询审计条目，支持按操作/执行者/执行ID/分类/严重级别过滤。
   * @param {Object} [filter] - 查询过滤条件
   * @param {string} [filter.action] - 按操作名称过滤
   * @param {string} [filter.actor] - 按执行者过滤
   * @param {string} [filter.executionId] - 按执行ID过滤
   * @param {string} [filter.category] - 按分类过滤
   * @param {string} [filter.severity] - 按严重级别过滤
   * @returns {Object[]} 匹配的条目数组
   */
  query(filter) {
    if (!filter) return this._entries.toArray().map(e => ({ ...e }));
    return this._entries.filter(e => {
      if (filter.action && e.action !== filter.action) return false;
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.executionId && e.executionId !== filter.executionId) return false;
      if (filter.category && e.category !== filter.category) return false;
      if (filter.severity && e.severity !== filter.severity) return false;
      return true;
    }).map(e => ({ ...e }));
  }

  /**
   * 获取指定执行ID的时间线（按记录顺序排列的条目列表）。
   * @param {string} executionId - 执行ID
   * @returns {Object[]} 该执行的时间线条目数组
   */
  getExecutionTimeline(executionId) {
    return this._entries.filter(e => e.executionId === executionId);
  }

  /**
   * 生成合规报告，包含安全违规计数和合规状态。
   * @returns {Object} 合规报告对象，包含totalEntries、securityViolations、complianceStatus、generatedAt
   */
  generateComplianceReport() {
    const securityViolations = this._securityViolationCount;
    return {
      totalEntries: this._entries.size,
      securityViolations,
      complianceStatus: securityViolations > 0 ? 'violations-detected' : 'compliant',
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 按指定字段值过滤条目的通用方法。
   * @param {string} field - 字段名
   * @param {*} value - 字段值
   * @returns {Object[]} 匹配的条目数组
   * @private
   */
  _getByField(field, value) { return this._entries.filter(e => e[field] === value).map(e => ({ ...e })); }
  /**
   * 按操作名称获取条目。
   * @param {string} action - 操作名称
   * @returns {Object[]} 匹配的条目数组
   */
  getByAction(action) { return this._getByField('action', action); }
  /**
   * 按执行者获取条目。
   * @param {string} actor - 执行者标识
   * @returns {Object[]} 匹配的条目数组
   */
  getByActor(actor) { return this._getByField('actor', actor); }
  /**
   * 按资源获取条目。
   * @param {string} resource - 资源标识
   * @returns {Object[]} 匹配的条目数组
   */
  getByResource(resource) { return this._getByField('resource', resource); }
  /**
   * 按分类获取条目。
   * @param {string} category - 分类名称
   * @returns {Object[]} 匹配的条目数组
   */
  getByCategory(category) { return this._getByField('category', category); }
  /**
   * 按严重级别获取条目。
   * @param {string} severity - 严重级别
   * @returns {Object[]} 匹配的条目数组
   */
  getBySeverity(severity) { return this._getByField('severity', severity); }
  /**
   * 获取所有失败条目（结果为failure或严重级别为error）。
   * @returns {Object[]} 失败条目数组
   */
  getFailures() { return this._entries.filter(e => e.result === 'failure' || e.severity === 'error'); }

  /**
   * 添加过滤器函数。新记录将依次通过所有过滤器，任一返回false则拒绝记录。
   * @param {Function} fn - 过滤器函数，接收entry参数，返回boolean
   * @returns {boolean} 始终返回true
   * @emits DeepeningAuditTrail#filter-added
   */
  addFilter(fn) {
    this.guardShutdown();
    requireFunction_(fn, 'Filter');
    if (this._filters.length >= MAX_FILTERS) {
      throw new Error('Maximum filter count reached: ' + MAX_FILTERS);
    }
    this._filters.push(fn);
    this.emit('filter-added', {});
    return true;
  }

  /**
   * 移除指定的过滤器函数。
   * @param {Function} fn - 要移除的过滤器函数
   * @returns {boolean} 始终返回true
   */
  removeFilter(fn) { const i = this._filters.indexOf(fn); if (i >= 0) this._filters.splice(i, 1); return true; }

  /**
   * 获取按操作名称的计数统计。
   * @returns {Object<string, number>} 操作名称到计数的映射
   */
  getActionCounts() { return { ...this._byAction }; }
  /**
   * 获取按执行者的计数统计。
   * @returns {Object<string, number>} 执行者到计数的映射
   */
  getActorCounts() { return { ...this._byActor }; }
  /**
   * 获取按严重级别的计数统计。
   * @returns {Object<string, number>} 严重级别到计数的映射
   */
  getSeverityCounts() { return { ...this._bySeverity }; }

  /**
   * 清空所有审计记录和索引。
   * @returns {number} 清空前的条目数
   * @emits DeepeningAuditTrail#cleared
   */
  clear() { this.guardShutdown(); const count = this._entries.size; this._entries = new RingBuffer(this._maxEntries); this._entryById.clear(); this._byResult = {}; this._byAction = {}; this._byActor = {}; this._byCategory = {}; this._bySeverity = {}; this._failureCount = 0; this.emit('cleared'); return count; }

  /**
   * 关闭时清理所有内部数据结构。
   * @private
   */
  _onShutdown() {
    this._entries = new RingBuffer(this._maxEntries);
    this._entryById.clear();
    this._filters = [];
    this._byResult = {};
    this._byAction = {};
    this._byActor = {};
    this._byCategory = {};
    this._bySeverity = {};
    super._onShutdown();
  }

  /**
   * 获取审计追踪统计信息。
   * @returns {Object} 统计对象，包含totalEntries、maxEntries、totalRecorded、totalFiltered、byResult等
   */
  getStats() {
    return { totalEntries: this._entries.size, maxEntries: this._maxEntries, totalRecorded: this._totalRecorded, totalFiltered: this._totalFiltered, byResult: { ...this._byResult }, ...super.getStats() };
  }
}

module.exports = DeepeningAuditTrail;
