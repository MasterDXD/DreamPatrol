'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { HarnessError } = require('../../errors');

const TOOL_TYPES = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  CODEX_CLI: 'codex-cli',
  GEMINI_CLI: 'gemini-cli',
  GENERIC: 'generic',
});

const TOOL_CAPABILITIES = {
  [TOOL_TYPES.CLAUDE_CODE]: { hooks: true, sandbox: false, mcp: true, contextWindow: 1000000, approvalModes: ['suggest', 'auto-edit', 'full-auto'] },
  [TOOL_TYPES.CODEX_CLI]: { hooks: false, sandbox: true, mcp: false, contextWindow: 400000, approvalModes: ['untrusted', 'on-request', 'never'] },
  [TOOL_TYPES.GEMINI_CLI]: { hooks: false, sandbox: false, mcp: false, contextWindow: 1000000, approvalModes: ['auto', 'suggest'] },
  [TOOL_TYPES.GENERIC]: { hooks: false, sandbox: false, mcp: false, contextWindow: 128000, approvalModes: ['auto'] },
};

const ENV_TOOL_MAP = {
  'claude-code': TOOL_TYPES.CLAUDE_CODE,
  'claude': TOOL_TYPES.CLAUDE_CODE,
  'codex-cli': TOOL_TYPES.CODEX_CLI,
  'codex': TOOL_TYPES.CODEX_CLI,
  'gemini-cli': TOOL_TYPES.GEMINI_CLI,
  'gemini': TOOL_TYPES.GEMINI_CLI,
};

const DEFAULT_CONFIG = {
  defaultTool: TOOL_TYPES.GENERIC,
  envVarName: 'HARNESS_TOOL_ADAPTER',
  autoDetect: true,
};

const MAX_TOOL_CONFIGS = 20;

/**
 * @module runtime/workflow/tool-adapter
 * @classdesc 工具适配器（ToolAdapter）。外部工具封装、参数映射、结果转换。
 * ToolAdapter — 工具适配器
 * Adapts Harness behavior to different AI coding tools (Claude Code, Codex CLI, Gemini CLI, generic)
 * by detecting the active tool environment and exposing capability-aware interfaces. Provides
 * tool-specific approval mode mapping, hook and sandbox configuration adaptation, and runtime
 * tool switching with per-tool configuration storage.
 * @extends EventEmitter
 * @emits tool-changed
 */
class ToolAdapter {

  /**
   * @param {Object} [options] - 配置选项
   * @param {string} [options.defaultTool='generic'] - 默认工具类型
   * @param {string} [options.envVarName='HARNESS_TOOL_ADAPTER'] - 工具检测环境变量名
   * @param {boolean} [options.autoDetect=true] - 是否自动检测工具环境
   */
  constructor(options) {
    EventEmitter.call(this);
    const opts = mergeConfig(DEFAULT_CONFIG, options);
    this._config = opts;
    this._currentTool = null;
    this._toolConfigs = new Map();
    this._resolveInitialTool();
  }

  static get TYPES() { return TOOL_TYPES; }

  _resolveInitialTool() {
    if (this._config.autoDetect) {
      const envVal = process.env[this._config.envVarName];
      if (envVal) {
        const tool = ENV_TOOL_MAP[envVal.toLowerCase()];
        if (tool) {
          this._currentTool = tool;
          debug('ToolAdapter', 'resolvedFromEnv', tool);
          return;
        }
      }
      if (process.env.CLAUDE_CODE_SESSION || process.env.CLAUDE_API_KEY) {
        this._currentTool = TOOL_TYPES.CLAUDE_CODE;
        debug('ToolAdapter', 'autoDetect', 'claude-code');
        return;
      }
      if (process.env.OPENAI_API_KEY && !process.env.CODEX_SANDBOX) {
        this._currentTool = TOOL_TYPES.CODEX_CLI;
        debug('ToolAdapter', 'autoDetect', 'codex-cli');
        return;
      }
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        this._currentTool = TOOL_TYPES.GEMINI_CLI;
        debug('ToolAdapter', 'autoDetect', 'gemini-cli');
        return;
      }
    }
    this._currentTool = this._config.defaultTool;
    debug('ToolAdapter', 'defaultTool', this._currentTool);
  }

  get currentTool() { return this._currentTool; }

  /**
   * 获取当前工具的能力配置。
   *
   * @returns {Object} 能力配置对象，包含hooks、sandbox、mcp、contextWindow、approvalModes
   */
  getCapabilities() {
    return TOOL_CAPABILITIES[this._currentTool] || TOOL_CAPABILITIES[TOOL_TYPES.GENERIC];
  }

  /**
   * 检查当前工具是否支持指定能力。
   *
   * @param {string} capability - 能力名称（如hooks、sandbox、mcp）
   * @returns {boolean} 是否支持该能力
   */
  hasCapability(capability) {
    const caps = this.getCapabilities();
    return !!caps[capability];
  }

  /**
   * 根据执行模式获取对应的审批模式。autonomous取最后一级、
   * supervised取第一级、其他取中间级。
   *
   * @param {string} executionMode - 执行模式（autonomous/supervised等）
   * @returns {string} 审批模式标识
   */
  getApprovalMode(executionMode) {
    const caps = this.getCapabilities();
    const modes = caps.approvalModes || ['auto'];
    if (executionMode === 'autonomous') return modes[modes.length - 1] || 'auto';
    if (executionMode === 'supervised') return modes[0] || 'suggest';
    return modes[Math.floor(modes.length / 2)] || 'auto';
  }

  /**
   * 切换当前工具类型。触发tool-changed事件。
   *
   * @param {string} toolType - 目标工具类型（TOOL_TYPES枚举值）
   * @returns {{from: string, to: string}} 切换结果
   * @throws {HarnessError} 工具类型无效时抛出
   */
  switchTool(toolType) {
    this.guardShutdown();
    if (!TOOL_CAPABILITIES[toolType]) {
      throw new HarnessError('INVALID_TOOL_TYPE', 'Unknown tool type: ' + toolType);
    }
    const oldTool = this._currentTool;
    this._currentTool = toolType;
    this.emit('tool-changed', { from: oldTool, to: toolType });
    debug('ToolAdapter', 'switchTool', oldTool + ' -> ' + toolType);
    return { from: oldTool, to: toolType };
  }

  /**
   * 注册指定工具类型的自定义配置。
   *
   * @param {string} toolType - 工具类型
   * @param {Object} config - 工具配置对象
   * @returns {boolean} 注册是否成功
   */
  registerToolConfig(toolType, config) {
    this.guardShutdown();
    if (!toolType || !TOOL_CAPABILITIES[toolType]) return false;
    if (this._toolConfigs.size >= MAX_TOOL_CONFIGS) return false;
    this._toolConfigs.set(toolType, config);
    return true;
  }

  /**
   * 获取指定工具类型的自定义配置。未指定类型时返回当前工具的配置。
   *
   * @param {string} [toolType] - 工具类型，省略则使用当前工具
   * @returns {Object} 工具配置对象
   */
  getToolConfig(toolType) {
    return this._toolConfigs.get(toolType || this._currentTool) ?? {};
  }

  /**
   * 适配Hook配置。当前工具不支持hooks时返回空对象。
   *
   * @param {Object} [hooks] - 原始Hook配置
   * @returns {Object} 适配后的Hook配置
   */
  adaptHookConfig(hooks) {
    if (!this.hasCapability('hooks')) return {};
    return hooks ?? {};
  }

  /**
   * 适配沙箱配置。当前工具不支持sandbox时返回空对象。
   *
   * @param {Object} [sandboxConfig] - 原始沙箱配置
   * @returns {Object} 适配后的沙箱配置
   */
  adaptSandboxConfig(sandboxConfig) {
    if (!this.hasCapability('sandbox')) return {};
    return sandboxConfig ?? {};
  }

  /**
   * 获取工具适配器统计信息。
   *
   * @returns {Object} 统计快照，包含currentTool、capabilities、registeredConfigs
   */
  getStats() {
    return {
      currentTool: this._currentTool,
      capabilities: this.getCapabilities(),
      registeredConfigs: this._toolConfigs.size,
    };
  }

  _onShutdown() {
    this._toolConfigs.clear();
    this._currentTool = null;
    this._config = {};
  }
}

Object.assign(ToolAdapter.prototype, EventEmitter.prototype);
ToolAdapter.prototype.constructor = ToolAdapter;

module.exports = { ToolAdapter: withShutdown(ToolAdapter), TOOL_TYPES, TOOL_CAPABILITIES, ENV_TOOL_MAP };
