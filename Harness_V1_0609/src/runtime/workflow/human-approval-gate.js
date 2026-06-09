'use strict';

const { EventEmitter } = require('events');
const { HarnessError } = require('../../errors');
const RingBuffer = require('../../utils/ring-buffer');
const { secureId, ID_PREFIXES } = require('../../utils/unique-id');
const { DEFAULT_PIPELINE_TIMEOUT_MS } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_TIMEOUT_MS = DEFAULT_PIPELINE_TIMEOUT_MS;
const DEFAULT_MAX_PENDING = 200;

/**
 * @module runtime/workflow/human-approval-gate
 * @classdesc 人工审批门（HumanApprovalGate）。关键决策点人工确认。
 * HumanApprovalGate — Human-in-the-loop approval gate with timeout and lifecycle tracking
 * Manages approval requests with configurable timeout, approve/reject/timeout lifecycle,
 * bounded pending queue with overflow protection, ring-buffer history, and graceful shutdown
 * that resolves all pending requests as rejected.
 * @extends EventEmitter
 * @emits approval-requested | approval-approved | approval-rejected | approval-timeout
 */
class HumanApprovalGate extends EventEmitter {
  /**
   * Create a HumanApprovalGate instance.
   * @param {Object} [options] - Configuration options
   * @param {number} [options.timeout] - Approval request timeout in milliseconds
   * @param {number} [options.maxPending=200] - Maximum number of pending approval requests
   */
  constructor(options) {
    super();
    this._timeout = Math.max(1, (options && options.timeout) || DEFAULT_TIMEOUT_MS);
    this._maxPending = (options && options.maxPending) ?? DEFAULT_MAX_PENDING;
    this._pending = new Map();
    this._maxHistory = 500;
    this._history = new RingBuffer(this._maxHistory);
  }

  /**
   * 请求人工审批。创建审批条目并等待审批结果，超时自动拒绝。
   * @param {Object} params - 审批请求参数
   * @param {string} params.agentId - 请求审批的Agent ID
   * @param {string} params.operation - 待审批的操作名称
   * @param {string} [params.target=''] - 操作目标
   * @param {string} [params.reason=''] - 审批原因
   * @param {Object} [params.metadata={}] - 附加元数据
   * @returns {Promise<{approved: boolean, requestId?: string, timedOut?: boolean, comment?: string}>} 审批结果
   * @fires HumanApprovalGate#approval-requested
   * @fires HumanApprovalGate#approval-approved
   * @fires HumanApprovalGate#approval-rejected
   * @fires HumanApprovalGate#approval-timeout
   */
  requestApproval(params) {
    this.guardShutdown();
    if (!params || !params.agentId || !params.operation) {
      return Promise.reject(new HarnessError('MISSING_FIELDS', 'agentId and operation are required'));
    }
    if (this._pending.size >= this._maxPending) {
      return Promise.reject(new HarnessError('CAPACITY_EXCEEDED', 'Maximum pending approvals reached'));
    }
    const requestId = secureId(ID_PREFIXES.APPROVAL, 12);
    const entry = {
      requestId,
      agentId: params.agentId,
      operation: params.operation,
      target: params.target || '',
      reason: params.reason || '',
      metadata: params.metadata ?? {},
      createdAt: Date.now(),
      status: 'pending',
    };
    this._pending.set(requestId, entry);
    this.emit('approval-requested', entry);

    return new Promise((resolve) => {
      let settled = false;
      const approvalTimer = setTimeout(() => {
        if (this._shutDown) return;
        if (settled) return;
        settled = true;
        entry.status = 'timeout';
        entry.resolvedAt = Date.now();
        entry._timer = null;
        this._pending.delete(requestId);
        this._addToHistory(entry);
        this.emit('approval-timeout', { requestId, agentId: entry.agentId });
        resolve({ approved: false, timedOut: true, requestId });
      }, this._timeout);
      if (approvalTimer && typeof approvalTimer.unref === 'function') approvalTimer.unref();

      entry._timer = approvalTimer;

      entry._resolve = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(approvalTimer);
        entry._timer = null;
        entry.status = result.approved ? 'approved' : 'rejected';
        entry.resolvedAt = Date.now();
        entry.resolver = result.resolver || 'unknown';
        entry.comment = result.comment || '';
        this._pending.delete(requestId);
        this._addToHistory(entry);
        if (result.approved) {
          this.emit('approval-approved', { requestId, agentId: entry.agentId, resolver: entry.resolver });
          resolve({ approved: true, requestId, comment: entry.comment });
        } else {
          this.emit('approval-rejected', { requestId, agentId: entry.agentId, resolver: entry.resolver });
          resolve({ approved: false, requestId, comment: entry.comment });
        }
      };
    });
  }

  /**
   * 解析审批请求。根据result.approved触发批准或拒绝流程。
   * @param {string} requestId - 审批请求ID
   * @param {Object} result - 审批结果
   * @param {boolean} result.approved - 是否批准
   * @param {string} [result.resolver] - 审批人标识
   * @param {string} [result.comment] - 审批备注
   * @returns {boolean} 解析是否成功，请求不存在时返回false
   */
  resolveApproval(requestId, result) {
    this.guardShutdown();
    if (!result || typeof result !== 'object') return false;
    const entry = this._pending.get(requestId);
    if (!entry) return false;
    if (entry._resolve) {
      entry._resolve(result);
    }
    return true;
  }

  /**
   * 批准审批请求。
   * @param {string} requestId - 审批请求ID
   * @param {string} [resolver='human'] - 审批人标识
   * @param {string} [comment=''] - 审批备注
   * @returns {boolean} 批准是否成功
   */
  approve(requestId, resolver, comment) {
    this.guardShutdown();
    return this.resolveApproval(requestId, { approved: true, resolver: resolver || 'human', comment: comment || '' });
  }

  /**
   * 拒绝审批请求。
   * @param {string} requestId - 审批请求ID
   * @param {string} [resolver='human'] - 审批人标识
   * @param {string} [comment=''] - 拒绝备注
   * @returns {boolean} 拒绝是否成功
   */
  reject(requestId, resolver, comment) {
    this.guardShutdown();
    return this.resolveApproval(requestId, { approved: false, resolver: resolver || 'human', comment: comment || '' });
  }

  /**
   * 获取所有待审批请求的摘要列表，包含等待时长。
   * @returns {Array<{requestId: string, agentId: string, operation: string, target: string, reason: string, createdAt: number, waitingMs: number}>}
   */
  getPending() {
    const result = [];
    for (const [, entry] of this._pending) {
      result.push({
        requestId: entry.requestId,
        agentId: entry.agentId,
        operation: entry.operation,
        target: entry.target,
        reason: entry.reason,
        createdAt: entry.createdAt,
        waitingMs: Date.now() - entry.createdAt,
      });
    }
    return result;
  }

  /**
   * 获取当前待审批请求数量。
   * @returns {number} 待审批数量
   */
  getPendingCount() {
    return this._pending.size;
  }

  /**
   * 获取审批历史记录，按时间倒序返回指定条数。
   * @param {number} [limit=50] - 返回的最大条数（1-500）
   * @returns {Array<Object>} 审批历史记录数组
   */
  getHistory(limit) {
    const safeLimit = Math.min(Math.max(1, typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : (Number.isFinite(parseInt(limit, 10)) ? parseInt(limit, 10) : 50)), 500);
    return this._history.toArray().slice(-safeLimit);
  }

  /**
   * 判断指定Agent和操作是否需要人工审批。默认所有操作均需审批。
   * @param {string} _agentId - Agent ID
   * @param {string} _operation - 操作名称
   * @returns {boolean} 是否需要审批
   */
  requiresApproval(_agentId, _operation) {
    return true;
  }

  /**
   * 获取审批门统计信息，包括待审批数、已批准/拒绝/超时数。
   * @returns {{ pending: number, totalResolved: number, approved: number, rejected: number, timedOut: number }}
   */
  getStats() {
    const total = this._history.size;
    let approved = 0;
    let rejected = 0;
    let timedOut = 0;
    for (const h of this._history) {
      if (h.status === 'approved') approved++;
      else if (h.status === 'rejected') rejected++;
      else if (h.status === 'timeout') timedOut++;
    }
    return {
      pending: this._pending.size,
      totalResolved: total,
      approved,
      rejected,
      timedOut,
    };
  }

  /**
   * 检查审批门是否健康。待审批数未达到上限时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    if (this._shutDown) return false;
    return this._pending.size < this._maxPending;
  }

  _onShutdown() {
    this._pending.forEach((entry) => {
      if (entry._timer) clearTimeout(entry._timer);
      if (entry._resolve) {
        entry._resolve({ approved: false, resolver: 'system', comment: 'shutdown' });
      }
    });
    this._pending.clear();
    if (this._history && typeof this._history.clear === 'function') this._history.clear();
    this.removeAllListeners();
  }

  _addToHistory(entry) {
    const record = { ...entry, metadata: { ...entry.metadata } };
    delete record._resolve;
    delete record._timer;
    this._history.push(record);
  }
}

module.exports = withShutdown(HumanApprovalGate);
