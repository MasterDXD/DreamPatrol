'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MAX_TOOLS = 100;
const MAX_CONTEXT_READERS = 20;
const MAX_GUARDRAILS = 20;

/**
 * @module runtime/agent/harness-layer
 * @classdesc Harness层（HarnessLayer）。框架核心集成层，
 * 管理工具注册、上下文读取器、安全护栏和审批门，作为Agent与外部系统交互的统一控制面。
 *
 * HarnessLayer — Harness框架控制层
 * 管理工具注册、上下文读取器、安全护栏和审批门，作为Agent与外部系统交互的统一控制面。
 * 执行动作前依次通过护栏检查和审批门验证，确保所有Agent操作符合安全策略和审批流程。
 *
 * @extends EventEmitter
 * @emits HarnessLayer#tool-registered
 * @emits HarnessLayer#context-reader-added
 * @emits HarnessLayer#guardrail-added
 * @emits HarnessLayer#approval-gate-set
 * @emits HarnessLayer#action-blocked
 * @emits HarnessLayer#action-denied
 * @emits HarnessLayer#action-completed
 * @emits HarnessLayer#action-error
 * @emits HarnessLayer#tool-not-found
 */
class HarnessLayer extends EventEmitter {
  /**
   * @param {Object} [config] - 配置选项
   */
  constructor(config) {
    super();
    this._toolRegistry = new Map();
    this._contextReaders = [];
    this._guardrails = [];
    this._approvalGate = null;
    this._config = config ?? {};
  }

  /**
   * 注册工具到工具注册表。
   * @param {string} name - 工具名称
   * @param {Object} tool - 工具实例，需实现execute(params, context)方法
   * @returns {void}
   * @fires HarnessLayer#tool-registered
   */
  registerTool(name, tool) {
    this.guardShutdown();
    if (this._toolRegistry.size >= MAX_TOOLS && !this._toolRegistry.has(name)) {
      const oldest = this._toolRegistry.keys().next().value;
      if (oldest) this._toolRegistry.delete(oldest);
    }
    this._toolRegistry.set(name, tool);
    this.emit('tool-registered', { name });
  }

  /**
   * 添加上下文读取器。
   * @param {Object} reader - 读取器实例，需实现read()方法
   * @returns {void}
   * @fires HarnessLayer#context-reader-added
   */
  addContextReader(reader) {
    this.guardShutdown();
    if (this._contextReaders.length >= MAX_CONTEXT_READERS) {
      this._contextReaders.shift();
    }
    this._contextReaders.push(reader);
    this.emit('context-reader-added', { count: this._contextReaders.length });
  }

  /**
   * 添加安全护栏。执行动作时按添加顺序依次检查，任一护栏拒绝则阻止执行。
   * @param {Object} guard - 护栏实例，需实现check(action, context)方法，返回{allowed, reason}
   * @returns {void}
   * @fires HarnessLayer#guardrail-added
   */
  addGuardrail(guard) {
    this.guardShutdown();
    if (this._guardrails.length >= MAX_GUARDRAILS) {
      this._guardrails.shift();
    }
    this._guardrails.push(guard);
    this.emit('guardrail-added', { count: this._guardrails.length });
  }

  /**
   * 设置审批门。需要审批的动作将先通过审批门验证。
   * @param {Object} gate - 审批门实例，需实现requiresApproval(action)和requestApproval(action, context)方法
   * @returns {void}
   * @fires HarnessLayer#approval-gate-set
   */
  setApprovalGate(gate) {
    this.guardShutdown();
    this._approvalGate = gate;
    this.emit('approval-gate-set', { hasGate: true });
  }

  /**
   * 执行动作。依次通过护栏检查和审批门验证后，委托已注册的工具执行。
   * @param {Object} action - 动作描述
   * @param {string} action.tool - 目标工具名称
   * @param {Object} action.params - 工具执行参数
   * @param {Object} context - 执行上下文
   * @returns {Promise<{blocked?: boolean, reason?: string, error?: string}|*>}
   *   被护栏/审批阻止时返回{blocked:true, reason}，工具不存在返回{error}，否则返回工具执行结果
   * @fires HarnessLayer#action-blocked
   * @fires HarnessLayer#action-denied
   * @fires HarnessLayer#action-completed
   * @fires HarnessLayer#action-error
   * @fires HarnessLayer#tool-not-found
   */
  async executeAction(action, context) {
    this.guardShutdown();
    const guardResult = this._checkGuardrails(action, context);
    if (guardResult) return guardResult;
    const approvalResult = await this._checkApprovalGate(action, context);
    if (approvalResult) return approvalResult;
    const tool = this._toolRegistry.get(action.tool);
    if (!tool) {
      this.emit('tool-not-found', { tool: action.tool });
      return { error: 'tool not found' };
    }
    try {
      const result = await tool.execute(action.params, context);
      this.emit('action-completed', { tool: action.tool });
      return result;
    } catch (err) {
      this.emit('action-error', { tool: action.tool, error: err && err.message ? err.message : String(err) });
      return { error: err && err.message ? err.message : String(err) };
    }
  }

  _checkGuardrails(action, context) {
    for (const guard of this._guardrails) {
      let result;
      try {
        result = guard.check(action, context);
      } catch (err) {
        debug('HarnessLayer', 'executeAction', 'Guardrail check error: ' + (err && err.message ? err.message : String(err)));
        this.emit('action-blocked', { reason: 'Guardrail check failed: ' + (err && err.message ? err.message : String(err)), tool: action.tool });
        return { blocked: true, reason: 'Guardrail check failed: ' + (err && err.message ? err.message : String(err)) };
      }
      if (!result.allowed) {
        this.emit('action-blocked', { reason: result.reason, tool: action.tool });
        return { blocked: true, reason: result.reason };
      }
    }
    return null;
  }

  async _checkApprovalGate(action, context) {
    if (!this._approvalGate || !this._approvalGate.requiresApproval(action)) return null;
    let approval;
    try {
      approval = await this._approvalGate.requestApproval(action, context);
    } catch (err) {
      debug('HarnessLayer', 'executeAction', 'Approval gate error: ' + (err && err.message ? err.message : String(err)));
      this.emit('action-denied', { reason: err && err.message ? err.message : String(err), tool: action.tool });
      return { blocked: true, reason: err && err.message ? err.message : String(err) };
    }
    if (!approval.granted) {
      this.emit('action-denied', { reason: approval.reason, tool: action.tool });
      return { blocked: true, reason: approval.reason ?? 'approval denied' };
    }
    return null;
  }

  /**
   * 从所有已注册的上下文读取器读取上下文。
   * @returns {Promise<Array>} 各读取器返回的上下文数组
   */
  async readContext() {
    const results = [];
    for (const reader of this._contextReaders) {
      try {
        const ctx = await reader.read();
        results.push(ctx);
      } catch (_e) { debug('HarnessLayer', 'readContext', 'Context reader failed: ' + (_e && _e.message ? _e.message : String(_e))); }
    }
    return results;
  }

  /**
   * 列出所有已注册的工具名称。
   * @returns {string[]} 工具名称数组
   */
  listTools() {
    return Array.from(this._toolRegistry.keys());
  }

  _onShutdown() {
    this._toolRegistry.clear();
    this._contextReaders.length = 0;
    this._guardrails.length = 0;
    this._approvalGate = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(HarnessLayer);
