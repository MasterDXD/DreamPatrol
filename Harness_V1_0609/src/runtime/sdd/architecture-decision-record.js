'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const { timestampId } = require('../../utils/unique-id');

const ADR_STATUS = {
  PROPOSED: 'proposed',
  ACCEPTED: 'accepted',
  DEPRECATED: 'deprecated',
  SUPERSEDED: 'superseded',
};

const DEFAULT_CONFIG = {
  maxDecisions: 200,
};

/**
 * @module runtime/sdd/architecture-decision-record
 * @classdesc 架构决策记录（ArchitectureDecisionRecord）—— SDD规范驱动子系统的设计决策追踪组件。
 * 管理架构决策记录的完整生命周期，包括提案、采纳、废弃和取代。
 * 提供决策的CRUD操作、状态流转和关键词搜索功能。
 * @extends EventEmitter
 */
class ArchitectureDecisionRecord extends EventEmitter {
  /**
   * @param {Object} [config={}] - 配置选项
   * @param {number} [config.maxDecisions=200] - 最大决策记录数量
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._decisions = new BoundedMap(this._config.maxDecisions);
  }

  /**
   * 提出一个新的架构决策记录，状态初始为 proposed。
   * @param {string} title - 决策标题
   * @param {string} context - 决策背景上下文
   * @param {string} decision - 决策内容
   * @param {string} consequences - 决策后果
   * @returns {{ proposed: boolean, id: string|null, reason?: string }} 提案结果
   */
  proposeDecision(title, context, decision, consequences) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!title || typeof title !== 'string') {
        return { proposed: false, id: null, reason: 'title is required' };
      }
      if (!context || typeof context !== 'string') {
        return { proposed: false, id: null, reason: 'context is required' };
      }
      if (!decision || typeof decision !== 'string') {
        return { proposed: false, id: null, reason: 'decision is required' };
      }
      const id = timestampId('adr-');
      const now = new Date().toISOString();
      const record = {
        id,
        title,
        status: ADR_STATUS.PROPOSED,
        context,
        decision,
        consequences: consequences || '',
        createdAt: now,
        updatedAt: now,
        supersededBy: null,
      };
      this._decisions.set(id, record);
      this.emit('decision-proposed', { id, title, status: record.status });
      return { proposed: true, id };
    }, 'ArchitectureDecisionRecord', 'proposeDecision', { proposed: false, id: null, reason: 'Internal error' });
  }

  /**
   * 采纳一个处于 proposed 状态的架构决策，将其状态变更为 accepted。
   * @param {string} id - 决策记录ID
   * @returns {{ accepted: boolean, id: string|null, previousStatus: string|null, reason?: string }} 采纳结果
   */
  acceptDecision(id) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!id || typeof id !== 'string') {
        return { accepted: false, id: null, previousStatus: null, reason: 'id is required' };
      }
      const record = this._decisions.get(id);
      if (!record) {
        return { accepted: false, id, previousStatus: null, reason: 'Decision not found' };
      }
      if (record.status !== ADR_STATUS.PROPOSED) {
        return { accepted: false, id, previousStatus: record.status, reason: 'Decision is not in proposed status' };
      }
      const previousStatus = record.status;
      record.status = ADR_STATUS.ACCEPTED;
      record.updatedAt = new Date().toISOString();
      this.emit('decision-accepted', { id, previousStatus, newStatus: record.status });
      return { accepted: true, id, previousStatus };
    }, 'ArchitectureDecisionRecord', 'acceptDecision', { accepted: false, id: null, previousStatus: null, reason: 'Internal error' });
  }

  /**
   * 废弃一个架构决策，将其状态变更为 deprecated。
   * 仅 accepted 状态的决策可以被废弃。
   * @param {string} id - 决策记录ID
   * @param {string} [reason] - 废弃原因
   * @returns {{ deprecated: boolean, id: string|null, previousStatus: string|null, reason?: string }} 废弃结果
   */
  deprecateDecision(id, reason) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!id || typeof id !== 'string') {
        return { deprecated: false, id: null, previousStatus: null, reason: 'id is required' };
      }
      const record = this._decisions.get(id);
      if (!record) {
        return { deprecated: false, id, previousStatus: null, reason: 'Decision not found' };
      }
      if (record.status !== ADR_STATUS.ACCEPTED) {
        return { deprecated: false, id, previousStatus: record.status, reason: 'Decision is not in accepted status' };
      }
      const previousStatus = record.status;
      record.status = ADR_STATUS.DEPRECATED;
      record.updatedAt = new Date().toISOString();
      if (reason && typeof reason === 'string') {
        record.deprecationReason = reason;
      }
      this.emit('decision-deprecated', { id, previousStatus, newStatus: record.status });
      return { deprecated: true, id, previousStatus };
    }, 'ArchitectureDecisionRecord', 'deprecateDecision', { deprecated: false, id: null, previousStatus: null, reason: 'Internal error' });
  }

  /**
   * 用新决策取代旧决策，将旧决策状态变更为 superseded 并记录取代关系。
   * 旧决策必须为 accepted 状态，新决策必须为 accepted 状态。
   * @param {string} oldId - 被取代的决策记录ID
   * @param {string} newId - 取代旧决策的新决策记录ID
   * @returns {{ superseded: boolean, oldId: string|null, newId: string|null, reason?: string }} 取代结果
   */
  supersedeDecision(oldId, newId) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!oldId || typeof oldId !== 'string') {
        return { superseded: false, oldId: null, newId: null, reason: 'oldId is required' };
      }
      if (!newId || typeof newId !== 'string') {
        return { superseded: false, oldId: null, newId: null, reason: 'newId is required' };
      }
      if (oldId === newId) {
        return { superseded: false, oldId, newId, reason: 'oldId and newId cannot be the same' };
      }
      const oldRecord = this._decisions.get(oldId);
      if (!oldRecord) {
        return { superseded: false, oldId, newId, reason: 'Old decision not found' };
      }
      if (oldRecord.status !== ADR_STATUS.ACCEPTED) {
        return { superseded: false, oldId, newId, reason: 'Old decision is not in accepted status' };
      }
      const newRecord = this._decisions.get(newId);
      if (!newRecord) {
        return { superseded: false, oldId, newId, reason: 'New decision not found' };
      }
      if (newRecord.status !== ADR_STATUS.ACCEPTED) {
        return { superseded: false, oldId, newId, reason: 'New decision is not in accepted status' };
      }
      oldRecord.status = ADR_STATUS.SUPERSEDED;
      oldRecord.supersededBy = newId;
      oldRecord.updatedAt = new Date().toISOString();
      this.emit('decision-superseded', { oldId, newId });
      return { superseded: true, oldId, newId };
    }, 'ArchitectureDecisionRecord', 'supersedeDecision', { superseded: false, oldId: null, newId: null, reason: 'Internal error' });
  }

  /**
   * 获取指定ID的架构决策记录。
   * @param {string} id - 决策记录ID
   * @returns {Object|null} 决策记录对象，未找到时返回 null
   */
  getDecision(id) {
    this.guardShutdown();
    if (!id || typeof id !== 'string') return null;
    return this._decisions.get(id) ?? null;
  }

  /**
   * 列出架构决策记录，可按状态过滤。
   * @param {string} [status] - 过滤状态（proposed | accepted | deprecated | superseded）
   * @returns {Array<Object>} 决策记录列表
   */
  listDecisions(status) {
    this.guardShutdown();
    return safeExecute(() => {
      const results = [];
      this._decisions.forEach((record) => {
        if (status && record.status !== status) return;
        results.push({
          id: record.id,
          title: record.title,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          supersededBy: record.supersededBy,
        });
      });
      return results;
    }, 'ArchitectureDecisionRecord', 'listDecisions', []);
  }

  /**
   * 按关键词搜索架构决策记录，匹配标题、上下文、决策内容和后果字段。
   * @param {string} keyword - 搜索关键词
   * @returns {Array<Object>} 匹配的决策记录列表
   */
  searchDecisions(keyword) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!keyword || typeof keyword !== 'string') return [];
      const lowerKeyword = keyword.toLowerCase();
      const results = [];
      this._decisions.forEach((record) => {
        const searchableText = [
          record.title,
          record.context,
          record.decision,
          record.consequences,
        ].join(' ').toLowerCase();
        if (searchableText.includes(lowerKeyword)) {
          results.push({
            id: record.id,
            title: record.title,
            status: record.status,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            supersededBy: record.supersededBy,
          });
        }
      });
      return results;
    }, 'ArchitectureDecisionRecord', 'searchDecisions', []);
  }

  /**
   * 获取决策记录的运行统计信息。
   * @returns {{ totalDecisions: number, byStatus: Object }} 统计信息
   */
  getStats() {
    this.guardShutdown();
    const byStatus = {};
    this._decisions.forEach((record) => {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    });
    return {
      totalDecisions: this._decisions.size,
      byStatus,
    };
  }

  _onShutdown() {
    this._decisions.clear();
    this.removeAllListeners();
  }
}

ArchitectureDecisionRecord.ADR_STATUS = ADR_STATUS;

module.exports = withShutdown(ArchitectureDecisionRecord);
