'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { HarnessError } = require('../../errors');

const EXECUTION_MODES = Object.freeze({
  AUTONOMOUS: 'autonomous',
  SUPERVISED: 'supervised',
  DOCUMENT_DRIVEN: 'document-driven',
});

const MODE_SOURCES = Object.freeze({
  ENV_VAR: 'env-var',
  CONFIG: 'config',
  CLI_ARG: 'cli-arg',
  API: 'api',
  DEFAULT: 'default',
});

const ENV_MODE_MAP = {
  autonomous: EXECUTION_MODES.AUTONOMOUS,
  auto: EXECUTION_MODES.AUTONOMOUS,
  supervised: EXECUTION_MODES.SUPERVISED,
  manual: EXECUTION_MODES.SUPERVISED,
  document: EXECUTION_MODES.DOCUMENT_DRIVEN,
  doc: EXECUTION_MODES.DOCUMENT_DRIVEN,
  'document-driven': EXECUTION_MODES.DOCUMENT_DRIVEN,
};

const DEFAULT_CONFIG = {
  defaultMode: EXECUTION_MODES.AUTONOMOUS,
  envVarName: 'HARNESS_EXECUTION_MODE',
  supervisedApprovalPoints: ['phase-transition', 'goal-start', 'pipeline-pre-execution', 'sprint-review'],
  documentDrivenSpecPath: '',
  documentDrivenAutoAdvance: true,
  modeSwitchAllowed: true,
};

const VALID_MODES = new Set(Object.values(EXECUTION_MODES));

/**
 * @module runtime/workflow/execution-mode-manager
 * @classdesc 执行模式管理器（ExecutionModeManager）。模式切换、策略适配。
 * ExecutionModeManager — 执行模式管理器
 * Manages three execution modes (autonomous, supervised, document-driven) with environment variable
 * detection, runtime mode switching, and approval point management. In supervised mode, specific
 * lifecycle points require approval callbacks; in document-driven mode, phase transitions can be
 * gated by spec path configuration. Tracks mode change history for auditing.
 * @extends EventEmitter
 * @emits mode-changed | approval-required | approval-result
 */
const _MAX_APPROVAL_CALLBACKS = 50;

class ExecutionModeManager extends EventEmitter {

  /**
   * 创建执行模式管理器实例
   * @param {Object} [options] - 配置选项
   * @param {string} [options.defaultMode] - 默认执行模式
   * @param {string} [options.envVarName] - 环境变量名称
   * @param {string[]} [options.supervisedApprovalPoints] - 监督模式下需要审批的节点列表
   * @param {string} [options.documentDrivenSpecPath] - 文档驱动模式的规格说明路径
   * @param {boolean} [options.documentDrivenAutoAdvance] - 文档驱动模式是否自动推进阶段
   * @param {boolean} [options.modeSwitchAllowed] - 是否允许运行时切换模式
   */
  constructor(options) {
    super();
    const opts = mergeConfig(DEFAULT_CONFIG, options);
    this._config = opts;
    this._currentMode = null;
    this._modeSource = null;
    this._modeHistory = [];
    this._approvalCallbacks = new Map();
    this._resolveInitialMode();
  }

  _resolveInitialMode() {
    const envVal = process.env[this._config.envVarName];
    if (envVal) {
      const mode = ENV_MODE_MAP[envVal.toLowerCase()];
      if (mode) {
        this._setMode(mode, MODE_SOURCES.ENV_VAR);
        return;
      }
      debug('ExecutionModeManager', 'envVarIgnored', envVal);
    }
    this._setMode(this._config.defaultMode, MODE_SOURCES.DEFAULT);
  }

  _setMode(mode, source) {
    this._currentMode = mode;
    this._modeSource = source;
    this._modeHistory.push({ mode, source, timestamp: Date.now() });
    if (this._modeHistory.length > 100) {
      this._modeHistory = this._modeHistory.slice(-50);
    }
  }

  /**
   * 获取当前执行模式
   * @returns {string} 当前执行模式
   */
  get currentMode() { return this._currentMode; }

  /**
   * 获取当前模式的来源
   * @returns {string} 模式来源（env-var/config/cli-arg/api/default）
   */
  get modeSource() { return this._modeSource; }

  /**
   * 获取所有可用的执行模式常量
   * @returns {Object} 执行模式枚举对象
   */
  static get MODES() { return EXECUTION_MODES; }

  /**
   * 获取所有模式来源常量
   * @returns {Object} 模式来源枚举对象
   */
  static get SOURCES() { return MODE_SOURCES; }

  /**
   * 判断当前是否为自主执行模式
   * @returns {boolean} 当前为自主模式时返回true
   */
  isAutonomous() { return this._currentMode === EXECUTION_MODES.AUTONOMOUS; }

  /**
   * 判断当前是否为监督执行模式
   * @returns {boolean} 当前为监督模式时返回true
   */
  isSupervised() { return this._currentMode === EXECUTION_MODES.SUPERVISED; }

  /**
   * 判断当前是否为文档驱动执行模式
   * @returns {boolean} 当前为文档驱动模式时返回true
   */
  isDocumentDriven() { return this._currentMode === EXECUTION_MODES.DOCUMENT_DRIVEN; }

  /**
   * 切换执行模式
   * @param {string} newMode - 目标执行模式
   * @param {string} [source] - 模式来源
   * @returns {Object} 包含from、to、source的切换结果对象
   * @emits mode-changed 模式切换完成时触发
   */
  switchMode(newMode, source) {
    this.guardShutdown();
    if (!VALID_MODES.has(newMode)) {
      throw new HarnessError('INVALID_EXECUTION_MODE', 'Invalid mode: ' + newMode + '. Valid: ' + Object.values(EXECUTION_MODES).join(', '));
    }
    if (!this._config.modeSwitchAllowed && source !== MODE_SOURCES.DEFAULT) {
      throw new HarnessError('MODE_SWITCH_DISABLED', 'Mode switching is disabled in current configuration');
    }
    const oldMode = this._currentMode;
    this._setMode(newMode, source || MODE_SOURCES.API);
    this.emit('mode-changed', { from: oldMode, to: newMode, source: this._modeSource });
    debug('ExecutionModeManager', 'switchMode', oldMode + ' -> ' + newMode + ' (' + this._modeSource + ')');
    return { from: oldMode, to: newMode, source: this._modeSource };
  }

  /**
   * 判断指定节点是否需要审批
   * @param {string} point - 审批节点标识
   * @returns {boolean} 需要审批时返回true
   */
  requiresApproval(point) {
    if (this.isAutonomous()) return false;
    if (this.isSupervised()) {
      const points = this._config.supervisedApprovalPoints ?? [];
      return points.includes(point);
    }
    if (this.isDocumentDriven()) {
      return point === 'phase-transition' && !this._config.documentDrivenAutoAdvance;
    }
    return false;
  }

  /**
   * 请求指定节点的审批
   * @param {string} point - 审批节点标识
   * @param {Object} [context] - 审批上下文信息
   * @returns {Promise<Object>} 审批结果对象，包含approved、point和可选的reason/error字段
   * @emits approval-result 审批回调执行后触发
   * @emits approval-required 无审批回调注册时触发
   */
  async requestApproval(point, context) {
    this.guardShutdown();
    if (!this.requiresApproval(point)) return { approved: true, point: point };
    const callback = this._approvalCallbacks.get(point);
    if (callback && typeof callback === 'function') {
      try {
        const result = await callback(point, context);
        if (this._shutDown) return { approved: false, point: point, reason: 'shut-down-during-approval' };
        this.emit('approval-result', { point: point, approved: !!result, context: context });
        return { approved: !!result, point: point };
      } catch (err) {
        debug('ExecutionModeManager', 'requestApproval', err);
        return { approved: false, point: point, reason: 'approval-callback-error', error: err && err.message ? err.message : String(err) };
      }
    }
    this.emit('approval-required', { point: point, context: context });
    return { approved: false, point: point, reason: 'no-approval-callback-registered' };
  }

  /**
   * 注册审批回调函数
   * @param {string} point - 审批节点标识
   * @param {Function} callback - 审批回调函数，接收point和context参数
   * @returns {void}
   */
  registerApprovalCallback(point, callback) {
    this.guardShutdown();
    if (typeof callback !== 'function') {
      throw new HarnessError('INVALID_CALLBACK', 'Approval callback must be a function');
    }
    if (this._approvalCallbacks.size >= _MAX_APPROVAL_CALLBACKS && !this._approvalCallbacks.has(point)) {
      const oldestKey = this._approvalCallbacks.keys().next().value;
      this._approvalCallbacks.delete(oldestKey);
    }
    this._approvalCallbacks.set(point, callback);
  }

  /**
   * 获取当前模式下所有需要审批的节点列表
   * @returns {string[]} 审批节点标识数组
   */
  getApprovalPoints() {
    if (this.isAutonomous()) return [];
    if (this.isSupervised()) return [...(this._config.supervisedApprovalPoints ?? [])];
    if (this.isDocumentDriven()) {
      return this._config.documentDrivenAutoAdvance ? [] : ['phase-transition'];
    }
    return [];
  }

  /**
   * 获取文档驱动模式的规格说明路径
   * @returns {string|null} 规格说明路径，非文档驱动模式时返回null
   */
  getSpecPath() {
    if (!this.isDocumentDriven()) return null;
    return this._config.documentDrivenSpecPath ?? process.env.HARNESS_SPEC_PATH ?? '';
  }

  /**
   * 获取模式变更历史记录的副本
   * @returns {Array<Object>} 模式变更历史数组，每项包含mode、source、timestamp
   */
  getModeHistory() {
    return this._modeHistory.slice();
  }

  /**
   * 获取执行模式管理器的状态摘要
   * @returns {Object} 状态对象，包含currentMode、modeSource、approvalPoints、modeSwitchAllowed、historyLength
   */
  getStats() {
    return {
      currentMode: this._currentMode,
      modeSource: this._modeSource,
      approvalPoints: this.getApprovalPoints(),
      modeSwitchAllowed: this._config.modeSwitchAllowed,
      historyLength: this._modeHistory.length,
    };
  }

  _onShutdown() {
    this._approvalCallbacks.clear();
    this._modeHistory.length = 0;
    this.removeAllListeners();
  }
}

module.exports = { ExecutionModeManager: withShutdown(ExecutionModeManager), EXECUTION_MODES, MODE_SOURCES, ENV_MODE_MAP };
