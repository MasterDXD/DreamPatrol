/**
 * @module runtime/tui/tui-app
 * @description 四区域TUI布局渲染器，提供ANSI彩色终端用户界面。
 * 负责渲染横幅区（Banner）、状态栏区（Status Bar）、消息流区（Message Stream），
 * 并集成TokenManager实时显示Token用量进度条。
 *
 * 架构角色：TUI子系统的视图层组件，负责所有终端可视输出。
 *
 * 四区域布局：
 * 1. 横幅区 — 项目标题、模型/技能/命令/工具统计
 * 2. 状态栏区 — 模型名称、Token进度条、运行时长、当前阶段、成本
 * 3. 消息流区 — 用户/AI/系统/工具消息的格式化输出
 * 4. 提示符区 — 由REPLEngine管理，本模块不负责
 *
 * 集成点：
 * - 与 {@link module:runtime/model/token-manager|TokenManager} 集成，通过 updateTokenUsage 刷新状态栏Token进度条
 * - 与 {@link module:runtime/session/session-manager|SessionManager} 集成，监听阶段转换更新状态栏
 * - 与 {@link module:runtime/workflow/command-router|CommandRouter} 集成，获取命令数量统计
 * - 由 {@link module:tui-orchestrator|TUIOrchestrator} 创建和管理
 *
 * ANSI颜色方案：
 * - GREEN (#34D399) — Token用量 < 50%
 * - YELLOW (#FBBF24) — Token用量 50%-80%
 * - ORANGE (#FB923C) — Token用量 80%-95%
 * - RED (#F87171) — Token用量 >= 95%
 * - PRIMARY (#818CF8) — 标题和强调
 * - MUTED (#94A3B8) — 次要信息
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const BoundedArray = require('../../utils/bounded-array');

const TOKEN_THRESHOLDS = {
  GREEN: 0.5,
  YELLOW: 0.8,
  ORANGE: 0.95,
  RED: 1.0,
};

const STATUS_COLORS = {
  GREEN: '\x1b[38;2;52;211;153m',
  YELLOW: '\x1b[38;2;251;191;36m',
  ORANGE: '\x1b[38;2;251;146;60m',
  RED: '\x1b[38;2;248;113;113m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  MUTED: '\x1b[38;2;148;163;184m',
  PRIMARY: '\x1b[38;2;129;140;248m',
  DIM: '\x1b[2m',
};

const MAX_MESSAGES = 200;
const PROGRESS_BAR_WIDTH = 20;

/**
 * 四区域TUI布局渲染器。基于ANSI转义序列实现终端彩色界面，
 * 包含横幅、状态栏、消息流三个可视区域，支持自动检测终端ANSI能力。
 * 消息存储使用BoundedArray限制最大200条，防止内存泄漏。
 *
 * @classdesc TUI终端应用。终端界面框架、输入处理、渲染循环
 *
 * @class
 * @extends EventEmitter
 * @fires TUIApp#started
 * @fires TUIApp#stopped
 *
 * @param {Object} [options] - 配置选项
 * @param {TokenManager|null} [options.tokenManager=null] - Token管理器实例，用于获取用量数据
 * @param {SessionManager|null} [options.sessionManager=null] - 会话管理器实例
 * @param {CommandRouter|null} [options.commandRouter=null] - 命令路由器实例
 * @param {ModelSelector|null} [options.modelSelector=null] - 模型选择器实例
 * @param {string} [options.model='default'] - 初始模型名称
 * @param {number} [options.renderInterval=1000] - 状态栏刷新间隔（毫秒）
 *
 * @example
 * const tui = new TUIApp({
 *   tokenManager: tokenMgr,
 *   sessionManager: sessionMgr,
 *   model: 'gpt-4',
 *   renderInterval: 2000,
 * });
 * tui.on('started', () => console.log('TUI已启动'));
 * tui.start();
 * tui.addMessage({ role: 'user', content: '你好' });
 * tui.updateTokenUsage({ used: 5000, budget: 100000, ratio: 0.05 });
 */
class TUIApp extends EventEmitter {
  constructor(options) {
    super();
    this._options = options ?? {};
    this._tokenManager = this._options.tokenManager ?? null;
    this._sessionManager = this._options.sessionManager ?? null;
    this._commandRouter = this._options.commandRouter ?? null;
    this._modelSelector = this._options.modelSelector ?? null;
    this._messages = new BoundedArray(MAX_MESSAGES);
    this._running = false;
    this._startTime = null;
    this._currentModel = this._options.model ?? 'default';
    this._currentPhase = '';
    this._skillCount = 0;
    this._commandCount = 0;
    this._toolCount = 0;
    this._cost = 0;
    this._renderTimer = null;
    this._renderInterval = this._options.renderInterval ?? 1000;
    this._supportsAnsi = this._detectAnsiSupport();
    this._tokenUsage = null;
  }

  /**
   * 启动TUI渲染。绘制初始横幅和状态栏，启动定时刷新周期。
   * 若已在运行则忽略重复调用。
   *
   * @fires TUIApp#started
   * @returns {void}
   */
  start() {
    this.guardShutdown();
    if (this._running) return;
    this._running = true;
    this._startTime = Date.now();

    this._renderBanner();
    this._renderStatusBar();

    this._renderTimer = setInterval(() => {
      if (this._running) {
        try { this._renderStatusBar(); } catch (_e) { debug('TuiApp', 'renderTimer', _e && _e.message ? _e.message : String(_e)); }
      }
    }, this._renderInterval);
    if (this._renderTimer && typeof this._renderTimer.unref === 'function') {
      this._renderTimer.unref();
    }

    this.emit('started');
  }

  /**
   * 停止TUI渲染。清除定时刷新器。
   *
   * @fires TUIApp#stopped
   * @returns {void}
   */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._renderTimer) {
      clearInterval(this._renderTimer);
      this._renderTimer = null;
    }
    this.emit('stopped');
  }

  /**
   * 添加一条消息到消息流并立即渲染。消息存储在BoundedArray中（上限200条）。
   *
   * @param {Object} msg - 消息对象
   * @param {string} msg.role - 消息角色：'user' | 'assistant' | 'system' | 'tool'
   * @param {string} [msg.content=''] - 消息内容
   * @param {number} [msg.timestamp=Date.now()] - 消息时间戳
   * @param {string} [msg.type='text'] - 消息类型：'text' | 'tool_call' | 'tool_result'
   * @param {string|null} [msg.toolName=null] - 工具名称（role为'tool'时使用）
   * @returns {void}
   *
   * @example
   * tui.addMessage({ role: 'assistant', content: '分析完成', type: 'text' });
   * tui.addMessage({ role: 'tool', content: '...', type: 'tool_call', toolName: 'grep' });
   */
  addMessage(msg) {
    this.guardShutdown();
    if (!msg || !msg.role) return;
    const content = typeof msg.content === 'string' ? msg.content : (msg.content != null ? String(msg.content) : '');
    this._messages.push({
      role: msg.role,
      content: content,
      timestamp: msg.timestamp ?? Date.now(),
      type: msg.type ?? 'text',
      toolName: msg.toolName ?? null,
    });
    this._renderMessage({ role: msg.role, content: content, type: msg.type ?? 'text', toolName: msg.toolName ?? null });
  }

  /**
   * 更新Token用量显示数据。下次状态栏刷新时将反映新数据。
   *
   * @param {Object} usage - Token用量数据
   * @param {number} [usage.used=0] - 已使用Token数
   * @param {number} [usage.budget=1] - Token预算总量
   * @param {number} [usage.ratio=0] - 使用比率（0-1）
   * @param {number} [usage.cost] - 累计成本（美元）
   * @returns {void}
   *
   * @example
   * tui.updateTokenUsage({ used: 80000, budget: 100000, ratio: 0.8, cost: 0.42 });
   * // 状态栏Token进度条变为黄色
   */
  updateTokenUsage(usage) {
    this.guardShutdown();
    if (!usage) return;
    this._tokenUsage = {
      used: Number.isFinite(usage.used) ? usage.used : 0,
      budget: Number.isFinite(usage.budget) ? usage.budget : 1,
      ratio: Number.isFinite(usage.ratio) ? usage.ratio : 0,
    };
    if (Number.isFinite(usage.cost)) {
      this._cost = usage.cost;
    }
  }

  /**
   * 设置当前模型名称，影响状态栏和横幅显示。
   *
   * @param {string} model - 模型名称
   * @returns {void}
   */
  setModel(model) {
    this.guardShutdown();
    this._currentModel = model || 'default';
  }

  /**
   * 获取当前模型名称。
   *
   * @returns {string} 当前模型名称
   */
  getModel() {
    return this._currentModel;
  }

  /**
   * 设置当前执行阶段名称，影响状态栏显示。
   *
   * @param {string} phase - 阶段名称（如 '需求分析'、'模块开发'）
   * @returns {void}
   */
  setPhase(phase) {
    this.guardShutdown();
    this._currentPhase = phase || '';
  }

  /**
   * 设置已注册技能数量，影响横幅显示。
   *
   * @param {number} count - 技能数量
   * @returns {void}
   */
  setSkillCount(count) {
    this.guardShutdown();
    this._skillCount = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }

  /**
   * 设置已注册命令数量，影响横幅显示。
   *
   * @param {number} count - 命令数量
   * @returns {void}
   */
  setCommandCount(count) {
    this.guardShutdown();
    this._commandCount = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }

  /**
   * 设置已注册工具数量，影响横幅显示。
   *
   * @param {number} count - 工具数量
   * @returns {void}
   */
  setToolCount(count) {
    this.guardShutdown();
    this._toolCount = typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }

  /**
   * 检测当前终端是否支持ANSI转义序列。
   * Unix TTY默认支持；Windows需检测TERM_PROGRAM或WT_SESSION环境变量。
   *
   * @returns {boolean} 是否支持ANSI
   * @private
   */
  _detectAnsiSupport() {
    try {
      if (process.stdout && process.stdout.isTTY) {
        if (process.platform === 'win32') {
          const ver = process.env.TERM_PROGRAM || process.env.WT_SESSION || '';
          return ver.length > 0;
        }
        return true;
      }
      if (process.env.TERM && process.env.TERM !== 'dumb') {
        return true;
      }
      return false;
    } catch (_e) {
      debug('TUIApp', '_detectAnsiSupport', _e && _e.message ? _e.message : String(_e));
      return false;
    }
  }

  /**
   * 获取指定ANSI颜色代码。不支持ANSI时返回空字符串。
   *
   * @param {string} name - STATUS_COLORS中的颜色名称
   * @returns {string} ANSI转义序列或空字符串
   * @private
   */
  _c(name) {
    if (!this._supportsAnsi) return '';
    return STATUS_COLORS[name] || '';
  }

  /**
   * 获取ANSI重置代码。不支持ANSI时返回空字符串。
   *
   * @returns {string} ANSI重置转义序列或空字符串
   * @private
   */
  _reset() {
    return this._supportsAnsi ? STATUS_COLORS.RESET : '';
  }

  /**
   * 渲染横幅区。显示项目标题框和模型/技能/命令/工具统计。
   *
   * @returns {void}
   * @private
   */
  _renderBanner() {
    const c = this._supportsAnsi;
    const bold = c ? STATUS_COLORS.BOLD : '';
    const primary = c ? STATUS_COLORS.PRIMARY : '';
    const muted = c ? STATUS_COLORS.MUTED : '';
    const reset = c ? STATUS_COLORS.RESET : '';

    const lines = [
      '',
      bold + primary + '  ╔═══════════════════════════════════════════════════════════╗' + reset,
      bold + primary + '  ║          Harness Engineering TUI — AI 操作中心           ║' + reset,
      bold + primary + '  ╚═══════════════════════════════════════════════════════════╝' + reset,
      '',
      muted + '  模型: ' + reset + this._currentModel +
        muted + '  |  技能: ' + reset + this._skillCount +
        muted + '  |  命令: ' + reset + this._commandCount +
        muted + '  |  工具: ' + reset + this._toolCount,
      '',
    ];

    this._write(lines.join('\n'));
  }

  /**
   * 渲染状态栏区。显示模型、Token进度条、运行时长、阶段、成本。
   * 由定时器周期性调用，也可手动触发。
   *
   * @returns {void}
   * @private
   */
  _renderStatusBar() {
    if (!this._running) return;

    const tokenInfo = this._getTokenDisplay();
    const elapsed = this._getElapsed();
    const phase = this._currentPhase ? '阶段: ' + this._currentPhase : '';

    const parts = [
      this._c('BOLD') + '模型:' + this._reset() + ' ' + this._currentModel,
      tokenInfo,
      this._c('BOLD') + '时长:' + this._reset() + ' ' + elapsed,
    ];

    if (phase) {
      parts.push(this._c('PRIMARY') + phase + this._reset());
    }

    if (this._cost > 0) {
      parts.push(this._c('BOLD') + '成本:' + this._reset() + ' $' + this._cost.toFixed(4));
    }

    const statusLine = parts.join('  ' + this._c('MUTED') + '|' + this._reset() + '  ');
    this._write('\r' + this._c('DIM') + '─'.repeat(60) + this._reset() + '\n' + statusLine + '\n');
  }

  /**
   * 构建Token用量显示字符串，包含进度条和百分比。
   * 颜色根据使用比率自动变化（绿→黄→橙→红）。
   *
   * @returns {string} 格式化的Token显示字符串
   * @private
   */
  _getTokenDisplay() {
    const usage = this._tokenUsage;
    if (!usage || usage.budget == null) {
      return this._c('BOLD') + 'Token:' + this._reset() + ' --';
    }

    const ratio = usage.ratio;
    const bar = this._renderProgressBar(ratio);
    const color = this._getTokenColor(ratio);

    return this._c('BOLD') + 'Token:' + this._reset() + ' ' + color + bar + this._reset() + ' ' + color + Math.round(ratio * 100) + '%' + this._reset();
  }

  /**
   * 根据Token使用比率返回对应的ANSI颜色代码。
   * <50%绿、50-80%黄、80-95%橙、>=95%红。
   *
   * @param {number} ratio - Token使用比率（0-1）
   * @returns {string} ANSI颜色转义序列
   * @private
   */
  _getTokenColor(ratio) {
    if (!this._supportsAnsi) return '';
    if (ratio < TOKEN_THRESHOLDS.GREEN) return STATUS_COLORS.GREEN;
    if (ratio < TOKEN_THRESHOLDS.YELLOW) return STATUS_COLORS.YELLOW;
    if (ratio < TOKEN_THRESHOLDS.ORANGE) return STATUS_COLORS.ORANGE;
    return STATUS_COLORS.RED;
  }

  /**
   * 渲染Token用量进度条。宽度20字符，█填充+░空白。
   *
   * @param {number} ratio - 填充比率（0-1），自动钳位
   * @returns {string} 进度条字符串，如 [████████░░░░░░░░░░░░]
   * @private
   */
  _renderProgressBar(ratio) {
    const clamped = Math.max(0, Math.min(1, ratio));
    const filled = Math.round(clamped * PROGRESS_BAR_WIDTH);
    const empty = PROGRESS_BAR_WIDTH - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  /**
   * 渲染单条消息到消息流区。根据角色添加不同颜色前缀。
   *
   * @param {Object} msg - 消息对象
   * @param {string} msg.role - 消息角色
   * @param {string} msg.content - 消息内容
   * @param {string} [msg.type] - 消息类型
   * @param {string} [msg.toolName] - 工具名称
   * @returns {void}
   * @private
   */
  _renderMessage(msg) {
    if (!this._running) return;

    const prefix = this._getMessagePrefix(msg);
    const content = this._formatContent(msg);

    this._write(prefix + content + '\n');
  }

  /**
   * 根据消息角色生成带颜色的前缀字符串。
   * user→紫色、assistant→绿色、system→灰色、tool→黄色。
   *
   * @param {Object} msg - 消息对象
   * @returns {string} 带ANSI颜色的前缀
   * @private
   */
  _getMessagePrefix(msg) {
    const c = this._supportsAnsi;
    switch (msg.role) {
      case 'user':
        return (c ? STATUS_COLORS.PRIMARY + STATUS_COLORS.BOLD : '') + '  你 > ' + (c ? STATUS_COLORS.RESET : '');
      case 'assistant':
        return (c ? STATUS_COLORS.GREEN + STATUS_COLORS.BOLD : '') + '  AI > ' + (c ? STATUS_COLORS.RESET : '');
      case 'system':
        return (c ? STATUS_COLORS.MUTED : '') + '  系统 > ' + (c ? STATUS_COLORS.RESET : '');
      case 'tool':
        return (c ? STATUS_COLORS.YELLOW : '') + '  工具[' + (msg.toolName || '?') + '] > ' + (c ? STATUS_COLORS.RESET : '');
      default:
        return '  > ';
    }
  }

  /**
   * 格式化消息内容。tool_call类型显示调用提示，
   * tool_result类型超过5行时截断并显示省略提示。
   *
   * @param {Object} msg - 消息对象
   * @returns {string} 格式化后的内容
   * @private
   */
  _formatContent(msg) {
    const raw = msg.content ?? '';
    const content = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (msg.type === 'tool_call') {
      return '调用 ' + (msg.toolName || 'unknown') + '...';
    }
    if (msg.type === 'tool_result') {
      const lines = (content ?? '').split('\n');
      if (lines.length > 5) {
        return lines.slice(0, 5).join('\n  ') + '\n  ... (' + (lines.length - 5) + ' more lines)';
      }
      return content;
    }
    return content;
  }

  /**
   * 计算自启动以来的运行时长，格式化为人类可读字符串。
   *
   * @returns {string} 格式化时长（如 '5m 30s'、'1h 20m'）
   * @private
   */
  _getElapsed() {
    if (!this._startTime) return '0s';
    const ms = Date.now() - this._startTime;
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
    return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
  }

  /**
   * 安全写入文本到stdout。写入失败时通过debug日志记录。
   *
   * @param {string} text - 要写入的文本
   * @returns {void}
   * @private
   */
  _write(text) {
    try {
      process.stdout.write(text);
    } catch (_e) {
      debug('TUIApp', 'write', 'stdout write failed: ' + (_e && _e.message ? _e.message : String(_e)));
    }
  }

  /**
   * 获取所有已存储的消息数组。
   *
   * @returns {Array<Object>} 消息对象数组
   */
  getMessages() {
    return this._messages.toArray();
  }

  /**
   * 检查TUI是否正在运行。
   *
   * @returns {boolean} 运行状态
   */
  isRunning() {
    return this._running;
  }

  /**
   * 优雅关闭回调。停止渲染、清空消息、释放所有管理器引用。
   * 由withShutdown混入自动调用。
   *
   * @returns {void}
   * @private
   */
  _onShutdown() {
    this.stop();
    safeCall(() => this._messages.shutdown(), 'TUIApp', 'shutdown-messages');
    this._tokenUsage = null;
    this._tokenManager = null;
    this._sessionManager = null;
    this._commandRouter = null;
    this._modelSelector = null;
    this.removeAllListeners();
  }

  /**
   * 获取TUI应用运行统计信息。
   *
   * @returns {Object} 统计快照
   * @returns {boolean} returns.running - 是否正在运行
   * @returns {string} returns.model - 当前模型名称
   * @returns {string} returns.phase - 当前执行阶段
   * @returns {number} returns.messageCount - 消息数量
   * @returns {number} returns.skillCount - 技能数量
   * @returns {number} returns.commandCount - 命令数量
   * @returns {number} returns.toolCount - 工具数量
   * @returns {number} returns.elapsed - 运行时长（毫秒）
   * @returns {number} returns.cost - 累计成本
   * @returns {boolean} returns.ansiSupport - 是否支持ANSI
   */
  getStats() {
    return {
      running: this._running,
      model: this._currentModel,
      phase: this._currentPhase,
      messageCount: this._messages.length,
      skillCount: this._skillCount,
      commandCount: this._commandCount,
      toolCount: this._toolCount,
      elapsed: this._startTime ? Date.now() - this._startTime : 0,
      cost: this._cost,
      ansiSupport: this._supportsAnsi,
    };
  }
}

module.exports = withShutdown(TUIApp);
