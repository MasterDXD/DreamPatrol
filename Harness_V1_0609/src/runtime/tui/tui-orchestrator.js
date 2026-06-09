/**
 * @module runtime/tui/tui-orchestrator
 * @description 顶层TUI编排器，集成REPLEngine、TUIApp、PersonaManager和QuickCommandRegistry，
 * 统一管理TUI子系统的生命周期、事件转发和运行时集成。
 *
 * 架构角色：TUI子系统的编排层，是所有TUI组件的顶层入口和协调者。
 * 遵循Harness分层分责原则，将输入层（REPLEngine）、视图层（TUIApp）、
 * 角色上下文层（PersonaManager）和命令扩展层（QuickCommandRegistry）组合为完整系统。
 *
 * 组件编排关系：
 * ```
 * TUIOrchestrator
 * ├── REPLEngine       ← 输入层：用户输入、命令路由
 * ├── TUIApp           ← 视图层：横幅、状态栏、消息流
 * ├── PersonaManager   ← 角色层：人格注册与切换
 * └── QuickCommandRegistry ← 扩展层：Shell快捷命令
 * ```
 *
 * 集成点：
 * - 与 {@link module:runtime/session/session-manager|SessionManager} 集成：会话创建/恢复/终止，监听budget-warning/phase-change/session-expired事件
 * - 与 {@link module:runtime/model/token-manager|TokenManager} 集成：Token用量追踪，监听token-warning-80/token-warning-95/token-exhausted事件
 * - 与 {@link module:runtime/workflow/command-router|CommandRouter} 集成：斜杠命令发现与执行
 * - 与 {@link module:runtime/context/context-compression-engine|ContextCompressionEngine} 集成：通过/compress命令触发上下文压缩
 * - 与 {@link module:repl-engine|REPLEngine} 集成：事件转发（message→TUIApp.addMessage、command→技能链执行）
 * - 与 {@link module:persona-manager|PersonaManager} 集成：人格切换同步REPLEngine提示符
 * - 与 {@link module:quick-command-registry|QuickCommandRegistry} 集成：从配置加载快捷命令
 *
 * 生命周期管理：
 * - stop()时自动清理外部管理器上的事件监听器，防止重复start()产生重复监听
 * - _onShutdown()时释放所有子组件引用（TUIApp、REPLEngine设为null）
 *
 * 主题支持：dark（暗色）、light（亮色）、highcontrast（高对比度）
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const REPLEngine = require('./repl-engine');
const TUIApp = require('./tui-app');
const PersonaManager = require('./persona-manager');
const QuickCommandRegistry = require('./quick-command-registry');

const TUI_THEMES = {
  dark: { name: '暗色', id: 'dark' },
  light: { name: '亮色', id: 'light' },
  highcontrast: { name: '高对比度', id: 'highcontrast' },
};

const MAX_COMMAND_LENGTH = 4096;

/**
 * 顶层TUI编排器。统一管理REPLEngine、TUIApp、PersonaManager和QuickCommandRegistry
 * 的生命周期与事件流。负责事件转发（REPLEngine→TUIApp）、会话集成（SessionManager）、
 * Token用量监控（TokenManager）和上下文压缩触发（ContextCompressionEngine）。
 *
 * @classdesc TUI编排器。多面板布局、焦点管理、快捷键绑定
 *
 * @class
 * @extends EventEmitter
 * @fires TUIOrchestrator#started
 * @fires TUIOrchestrator#stopped
 * @fires TUIOrchestrator#message
 * @fires TUIOrchestrator#command
 * @fires TUIOrchestrator#compress
 * @fires TUIOrchestrator#background
 * @fires TUIOrchestrator#interrupt
 *
 * @param {string} projectRoot - 项目根目录路径
 * @param {Object} [options] - 配置选项
 * @param {CommandRouter|null} [options.commandRouter=null] - 斜杠命令路由器
 * @param {TokenManager|null} [options.tokenManager=null] - Token管理器
 * @param {SessionManager|null} [options.sessionManager=null] - 会话管理器
 * @param {ContextCompressionEngine|null} [options.contextCompressionEngine=null] - 上下文压缩引擎
 * @param {string} [options.theme='dark'] - TUI主题：'dark' | 'light' | 'highcontrast'
 * @param {string} [options.model='default'] - 初始模型名称
 * @param {Object|null} [options.quickCommands=null] - 快速命令配置，传递给QuickCommandRegistry.loadFromConfig
 *
 * @example
 * const orchestrator = new TUIOrchestrator(projectRoot, {
 *   commandRouter: router,
 *   tokenManager: tokenMgr,
 *   sessionManager: sessionMgr,
 *   contextCompressionEngine: compressionEngine,
 *   theme: 'dark',
 *   model: 'gpt-4',
 *   quickCommands: { quick_commands: [ ... ] },
 * });
 * orchestrator.on('message', (data) => processUserInput(data.content));
 * orchestrator.on('command', (data) => executeSkillChain(data.skills));
 * await orchestrator.start();
 */
class TUIOrchestrator extends EventEmitter {
  constructor(projectRoot, options) {
    super();
    this._projectRoot = projectRoot;
    this._options = options ?? {};
    this._commandRouter = this._options.commandRouter ?? null;
    this._tokenManager = this._options.tokenManager ?? null;
    this._sessionManager = this._options.sessionManager ?? null;
    this._contextCompressionEngine = this._options.contextCompressionEngine ?? null;

    this._tuiApp = null;
    this._replEngine = null;
    this._personaManager = new PersonaManager();
    this._quickCommandRegistry = new QuickCommandRegistry();
    this._theme = this._options.theme ?? 'dark';
    this._running = false;
    this._startPromise = null;
    this._sessionId = null;
    this._externalListeners = null;
    if (this._options.quickCommands) {
      this._quickCommandRegistry.loadFromConfig(this._options.quickCommands);
    }
  }

  /**
   * 启动TUI编排器。依次创建TUIApp和REPLEngine实例，建立事件转发、
   * 会话集成和Token集成，创建新会话，发现命令，最后启动渲染和输入循环。
   *
   * @fires TUIOrchestrator#started
   * @returns {Promise<void>}
   *
   * @example
   * await orchestrator.start();
   * // TUI界面显示横幅，提示符就绪
   */
  async start() {
    this.guardShutdown();
    if (this._running) return;
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart();
    try {
      await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _doStart() {
    if (this._running) return;

    this._tuiApp = new TUIApp({
      tokenManager: this._tokenManager,
      sessionManager: this._sessionManager,
      commandRouter: this._commandRouter,
      model: this._options.model ?? 'default',
    });

    this._replEngine = new REPLEngine(this._commandRouter, {
      persona: this._personaManager.getCurrentPersona(),
      sessionId: this._sessionId,
    });

    this._setupEventForwarding();
    this._setupSessionIntegration();
    this._setupTokenIntegration();

    await this._initSession();

    if (this._shutDown) {
      this._cleanupStartResources();
      return;
    }

    this._discoverCommands();

    this._tuiApp.start();
    this._replEngine.start();

    this._running = true;
    this.emit('started');
  }

  /**
   * 初始化会话
   * @private
   */
  async _initSession() {
    if (this._sessionId) return;
    try {
      const session = await this._sessionManager.create({ agent: 'tui-user' });
      this._sessionId = session && session.id;
      if (this._sessionId && this._replEngine) {
        this._replEngine.setSessionId(this._sessionId);
      }
    } catch (_e) {
      debug('TUIOrchestrator', 'start', 'session creation skipped: ' + (_e && _e.message ? _e.message : String(_e)));
    }
  }

  /**
   * 发现并注册命令
   * @private
   */
  _discoverCommands() {
    if (!this._commandRouter) return;
    try {
      this._commandRouter.discover();
      const cmdCount = Array.isArray(this._commandRouter.commands) ? this._commandRouter.commands.length : 0;
      this._tuiApp.setCommandCount(cmdCount);
    } catch (_e) {
      debug('TUIOrchestrator', 'start', 'command discovery skipped: ' + (_e && _e.message ? _e.message : String(_e)));
    }
  }

  /**
   * 清理启动期间创建的资源（shutdown竞态时使用）
   * @private
   */
  _cleanupStartResources() {
    if (this._tuiApp && typeof this._tuiApp.stop === 'function') { try { this._tuiApp.stop(); } catch (_e) { debug('TuiOrchestrator', 'stop:app', _e && _e.message ? _e.message : String(_e)); } }
    if (this._replEngine && typeof this._replEngine.stop === 'function') { try { this._replEngine.stop(); } catch (_e) { debug('TuiOrchestrator', 'stop:repl', _e && _e.message ? _e.message : String(_e)); } }
    this._tuiApp = null;
    this._replEngine = null;
  }

  /**
   * 停止TUI编排器。依次停止REPLEngine和TUIApp，终止关联会话。
   *
   * @fires TUIOrchestrator#stopped
   * @returns {void}
   */
  stop() {
    if (!this._running) return;
    this._running = false;

    this._cleanupExternalListeners();

    if (this._replEngine) {
      this._replEngine.stop();
    }
    if (this._tuiApp) {
      this._tuiApp.stop();
    }

    if (this._sessionManager && this._sessionId) {
      try {
        this._sessionManager.terminate(this._sessionId);
      } catch (_e) {
        debug('TUIOrchestrator', 'stop', 'session termination skipped: ' + (_e && _e.message ? _e.message : String(_e)));
      }
    }

    this.emit('stopped');
  }

  /**
   * 建立REPLEngine到TUIApp的事件转发。将所有REPL事件（message、command、
   * command:fuzzy、command:unknown、内置命令、interrupt、error）和
   * PersonaManager的persona-changed事件连接到TUIApp的消息流显示。
   *
   * 事件转发映射：
   * - message → TUIApp.addMessage(user) + 向外emit
   * - command → TUIApp.addMessage(system, tool_call) + 向外emit
   * - command:fuzzy → TUIApp.addMessage(system)
   * - command:unknown → TUIApp.addMessage(system)
   * - command:help → 通过CommandRouter获取帮助文本
   * - command:exit → orchestrator.stop()
   * - command:clear → 清屏 + 重绘横幅
   * - command:history → TUIApp.addMessage(system)
   * - command:persona → PersonaManager.setPersona + TUIApp.addMessage(system)
   * - command:compress → 向外emit('compress')
   * - command:background → TUIApp.addMessage(system) + 向外emit
   * - command:status → TUIApp.addMessage(system)
   * - command:model → TUIApp.setModel + TUIApp.addMessage(system)
   * - command:reasoning → TUIApp.addMessage(system)
   * - interrupt → TUIApp.addMessage(system) + 向外emit
   * - error → TUIApp.addMessage(system)
   * - persona-changed(PersonaManager) → REPLEngine.setPersona
   *
   * @returns {void}
   * @private
   */
  _setupEventForwarding() {
    if (!this._replEngine) return;

    this._externalListeners = this._externalListeners ?? {};
    this._externalListeners.personaChanged = (data) => {
      if (this._replEngine) {
        this._replEngine.setPersona(data.current);
      }
    };

    this._externalListeners.replMessage = (data) => {
      if (this._tuiApp) {
        const content = typeof data.content === 'string' && data.content.length > MAX_COMMAND_LENGTH
          ? data.content.slice(0, MAX_COMMAND_LENGTH) + '...[truncated]'
          : data.content;
        this._tuiApp.addMessage({ role: 'user', content: content });
      }
      this.emit('message', data);
    };
    this._replEngine.on('message', this._externalListeners.replMessage);

    this._externalListeners.replCommand = (data) => {
      if (this._tuiApp) {
        const commandId = typeof data.commandId === 'string'
          ? (data.commandId.length > MAX_COMMAND_LENGTH ? data.commandId.slice(0, MAX_COMMAND_LENGTH) + '...[truncated]' : data.commandId)
          : 'unknown';
        this._tuiApp.addMessage({
          role: 'system',
          content: '执行命令: ' + commandId + ' → ' + (Array.isArray(data.skills) ? data.skills.join(' → ') : ''),
          type: 'tool_call',
          toolName: commandId,
        });
      }
      this.emit('command', data);
    };
    this._replEngine.on('command', this._externalListeners.replCommand);

    this._externalListeners.replCommandFuzzy = (data) => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({
          role: 'system',
          content: '模糊匹配: ' + data.input + ' → ' + data.matched,
        });
      }
    };
    this._replEngine.on('command:fuzzy', this._externalListeners.replCommandFuzzy);

    this._externalListeners.replCommandUnknown = (data) => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({
          role: 'system',
          content: '未知命令: ' + data.input + ' (输入 /help 查看可用命令)',
        });
      }
    };
    this._replEngine.on('command:unknown', this._externalListeners.replCommandUnknown);

    this._externalListeners.replCommandHelp = () => {
      if (this._commandRouter) {
        try {
          const helpText = this._commandRouter.getHelpText(true);
          if (this._tuiApp) {
            this._tuiApp.addMessage({ role: 'system', content: helpText });
          }
        } catch (_e) {
          if (this._tuiApp) {
            this._tuiApp.addMessage({ role: 'system', content: '内置命令: /help /exit /clear /history /persona /compress /background /status /model /reasoning' });
          }
        }
      } else {
        if (this._tuiApp) {
          this._tuiApp.addMessage({ role: 'system', content: '内置命令: /help /exit /clear /history /persona /compress /background /status /model /reasoning' });
        }
      }
    };
    this._replEngine.on('command:help', this._externalListeners.replCommandHelp);

    this._externalListeners.replCommandExit = () => {
      this.stop();
    };
    this._replEngine.on('command:exit', this._externalListeners.replCommandExit);

    this._externalListeners.replCommandClear = () => {
      if (this._tuiApp) {
        if (this._tuiApp._supportsAnsi) {
          process.stdout.write('\x1b[2J\x1b[H');
        }
        this._tuiApp._renderBanner();
      }
    };
    this._replEngine.on('command:clear', this._externalListeners.replCommandClear);

    this._externalListeners.replCommandHistory = (data) => {
      if (this._tuiApp && data.entries) {
        const lines = data.entries.slice(-20).map((e, i) => '  ' + (i + 1) + '. ' + e.input);
        this._tuiApp.addMessage({ role: 'system', content: '历史记录:\n' + lines.join('\n') });
      }
    };
    this._replEngine.on('command:history', this._externalListeners.replCommandHistory);

    this._externalListeners.replCommandPersona = (data) => {
      if (data.action === 'set') {
        if (this._personaManager.setPersona(data.current)) {
          if (this._tuiApp) {
            this._tuiApp.addMessage({ role: 'system', content: '人格切换: ' + data.previous + ' → ' + data.current });
          }
        } else {
          const list = this._personaManager.listPersonas().map(p => '  ' + p.id + ' (' + p.name + ')' + (p.active ? ' *' : '')).join('\n');
          if (this._tuiApp) {
            this._tuiApp.addMessage({ role: 'system', content: '未知人格: ' + data.current + '\n可用人格:\n' + list });
          }
          this._replEngine.setPersona(data.previous);
        }
      } else {
        const list = this._personaManager.listPersonas().map(p => '  ' + p.id + ' (' + p.name + ')' + (p.active ? ' *' : '')).join('\n');
        if (this._tuiApp) {
          this._tuiApp.addMessage({ role: 'system', content: '当前人格: ' + data.current + '\n可用人格:\n' + list });
        }
      }
    };
    this._replEngine.on('command:persona', this._externalListeners.replCommandPersona);

    this._externalListeners.replCommandCompress = () => {
      if (this._contextCompressionEngine) {
        if (this._tuiApp) {
          this._tuiApp.addMessage({ role: 'system', content: '触发上下文压缩...' });
        }
        this.emit('compress');
      } else {
        if (this._tuiApp) {
          this._tuiApp.addMessage({ role: 'system', content: '上下文压缩引擎未配置' });
        }
      }
    };
    this._replEngine.on('command:compress', this._externalListeners.replCommandCompress);

    this._externalListeners.replCommandBackground = (data) => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({ role: 'system', content: '后台任务已启动: ' + data.task });
      }
      this.emit('background', data);
    };
    this._replEngine.on('command:background', this._externalListeners.replCommandBackground);

    this._externalListeners.replCommandStatus = () => {
      const stats = this.getStats();
      const lines = [
        '运行状态: ' + (stats.running ? '运行中' : '已停止'),
        '当前人格: ' + stats.persona,
        '消息数量: ' + stats.messageCount,
        '快速命令: ' + stats.quickCommands,
        '会话ID: ' + (stats.sessionId || '无'),
      ];
      if (this._tuiApp) {
        this._tuiApp.addMessage({ role: 'system', content: lines.join('\n') });
      }
    };
    this._replEngine.on('command:status', this._externalListeners.replCommandStatus);

    this._externalListeners.replCommandModel = (data) => {
      if (data.model) {
        if (this._tuiApp) {
          this._tuiApp.setModel(data.model);
          this._tuiApp.addMessage({ role: 'system', content: '模型切换: ' + data.model });
        }
      } else {
        if (this._tuiApp) {
          this._tuiApp.addMessage({ role: 'system', content: '当前模型: ' + this._tuiApp.getModel() });
        }
      }
    };
    this._replEngine.on('command:model', this._externalListeners.replCommandModel);

    this._externalListeners.replCommandReasoning = (data) => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({ role: 'system', content: '推理强度: ' + data.level });
      }
    };
    this._replEngine.on('command:reasoning', this._externalListeners.replCommandReasoning);

    this._externalListeners.replInterrupt = () => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({ role: 'system', content: '操作已中断' });
      }
      this.emit('interrupt');
    };
    this._replEngine.on('interrupt', this._externalListeners.replInterrupt);

    this._externalListeners.replError = (data) => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({ role: 'system', content: '错误: ' + data.type });
      }
    };
    this._replEngine.on('error', this._externalListeners.replError);

    this._personaManager.on('persona-changed', this._externalListeners.personaChanged);
  }

  /**
   * 清理外部管理器（PersonaManager、SessionManager、TokenManager）上的事件监听器。
   * 在stop()和_onShutdown()中调用，防止重复start()时产生重复监听器。
   *
   * @returns {void}
   * @private
   */
  _cleanupExternalListeners() {
    if (!this._externalListeners) return;
    const el = this._externalListeners;

    if (this._replEngine) {
      const replEvents = [
        ['message', 'replMessage'], ['command', 'replCommand'],
        ['command:fuzzy', 'replCommandFuzzy'], ['command:unknown', 'replCommandUnknown'],
        ['command:help', 'replCommandHelp'], ['command:exit', 'replCommandExit'],
        ['command:clear', 'replCommandClear'], ['command:history', 'replCommandHistory'],
        ['command:persona', 'replCommandPersona'], ['command:compress', 'replCommandCompress'],
        ['command:background', 'replCommandBackground'], ['command:status', 'replCommandStatus'],
        ['command:model', 'replCommandModel'], ['command:reasoning', 'replCommandReasoning'],
        ['interrupt', 'replInterrupt'], ['error', 'replError'],
      ];
      for (const [event, key] of replEvents) {
        if (el[key]) this._replEngine.removeListener(event, el[key]);
      }
    }

    if (this._personaManager && el.personaChanged) {
      this._personaManager.removeListener('persona-changed', el.personaChanged);
    }
    if (this._sessionManager) {
      if (el.budgetWarning) this._sessionManager.removeListener('budget-warning', el.budgetWarning);
      if (el.phaseChange) this._sessionManager.removeListener('phase-change', el.phaseChange);
      if (el.sessionExpired) this._sessionManager.removeListener('session-expired', el.sessionExpired);
    }
    if (this._tokenManager) {
      if (el.tokenWarning80) this._tokenManager.removeListener('token-warning-80', el.tokenWarning80);
      if (el.tokenWarning95) this._tokenManager.removeListener('token-warning-95', el.tokenWarning95);
      if (el.tokenExhausted) this._tokenManager.removeListener('token-exhausted', el.tokenExhausted);
    }

    this._externalListeners = null;
  }

  /**
   * 建立SessionManager事件监听。将预算警告、阶段转换、会话过期事件
   * 转发到TUIApp消息流显示。
   *
   * 监听事件：
   * - budget-warning → TUIApp.addMessage(system) 显示Token预算警告
   * - phase-change → TUIApp.setPhase + TUIApp.addMessage(system) 显示阶段转换
   * - session-expired → TUIApp.addMessage(system) 显示会话过期通知
   *
   * @listens SessionManager#budget-warning
   * @listens SessionManager#phase-change
   * @listens SessionManager#session-expired
   * @returns {void}
   * @private
   */
  _setupSessionIntegration() {
    if (!this._sessionManager) return;

    this._externalListeners = this._externalListeners ?? {};

    this._externalListeners.budgetWarning = (data) => {
      if (this._tuiApp) {
        const ratio = Number.isFinite(data.ratio) ? data.ratio : 0;
        const pct = Math.round(ratio * 100);
        this._tuiApp.addMessage({
          role: 'system',
          content: '⚠ Token 预算警告: ' + pct + '% 已使用' + (pct >= 95 ? ' (建议 /compress 压缩上下文)' : ''),
        });
      }
    };

    this._externalListeners.phaseChange = (data) => {
      if (this._tuiApp && data.newPhase) {
        this._tuiApp.setPhase(data.newPhase);
        this._tuiApp.addMessage({
          role: 'system',
          content: '阶段转换: → ' + data.newPhase,
        });
      }
    };

    this._externalListeners.sessionExpired = (data) => {
      if (this._tuiApp) {
        this._tuiApp.addMessage({
          role: 'system',
          content: '会话已过期: ' + (data.sessionId || 'unknown'),
        });
      }
    };

    this._sessionManager.on('budget-warning', this._externalListeners.budgetWarning);
    this._sessionManager.on('phase-change', this._externalListeners.phaseChange);
    this._sessionManager.on('session-expired', this._externalListeners.sessionExpired);
  }

  /**
   * 建立TokenManager事件监听。在Token用量达到80%、95%和100%时
   * 更新TUIApp状态栏显示并推送警告消息。
   *
   * 监听事件：
   * - token-warning-80 → 更新Token显示 + 黄色警告消息
   * - token-warning-95 → 更新Token显示 + 红色警告消息（建议/compress）
   * - token-exhausted → 更新Token显示 + 紧急停止消息
   *
   * @listens TokenManager#token-warning-80
   * @listens TokenManager#token-warning-95
   * @listens TokenManager#token-exhausted
   * @returns {void}
   * @private
   */
  _setupTokenIntegration() {
    if (!this._tokenManager) return;

    this._externalListeners = this._externalListeners ?? {};

    this._externalListeners.tokenWarning80 = () => {
      if (this._tuiApp) {
        this._updateTokenDisplay();
        this._tuiApp.addMessage({ role: 'system', content: '📊 Token 使用已达 80%' });
      }
    };

    this._externalListeners.tokenWarning95 = () => {
      if (this._tuiApp) {
        this._updateTokenDisplay();
        this._tuiApp.addMessage({ role: 'system', content: '🔴 Token 使用已达 95%，建议 /compress 压缩上下文' });
      }
    };

    this._externalListeners.tokenExhausted = () => {
      if (this._tuiApp) {
        this._updateTokenDisplay();
        this._tuiApp.addMessage({ role: 'system', content: '🛑 Token 预算已耗尽！任务暂停。' });
      }
    };

    this._tokenManager.on('token-warning-80', this._externalListeners.tokenWarning80);
    this._tokenManager.on('token-warning-95', this._externalListeners.tokenWarning95);
    this._tokenManager.on('token-exhausted', this._externalListeners.tokenExhausted);
  }

  /**
   * 从TokenManager获取当前会话的Token用量并更新TUIApp状态栏。
   * 尽力而为，获取失败时静默忽略。
   *
   * @returns {void}
   * @private
   */
  _updateTokenDisplay() {
    if (!this._tokenManager || !this._sessionId || !this._tuiApp) return;
    try {
      const usage = this._tokenManager.getUsage(this._sessionId);
      if (usage) {
        this._tuiApp.updateTokenUsage(usage);
      }
    } catch (_e) { debug('TUIOrchestrator', 'updateTokenUsage', _e); }
  }

  /**
   * 恢复指定会话。更新REPLEngine会话ID和TUIApp阶段显示，刷新Token用量。
   *
   * @param {string} sessionId - 要恢复的会话ID
   * @returns {boolean} 恢复是否成功
   *
   * @example
   * if (orchestrator.resumeSession('sess-abc123')) {
   *   console.log('会话已恢复');
   * }
   */
  resumeSession(sessionId) {
    this.guardShutdown();
    if (!this._sessionManager) return false;
    try {
      const session = this._sessionManager.getSession(sessionId);
      if (!session) return false;
      this._sessionId = sessionId;
      if (this._replEngine) {
        this._replEngine.setSessionId(sessionId);
      }
      if (session.phase && this._tuiApp) {
        this._tuiApp.setPhase(session.phase);
      }
      this._updateTokenDisplay();
      return true;
    } catch (_e) {
      debug('TUIOrchestrator', 'resumeSession', _e && _e.message ? _e.message : String(_e));
      return false;
    }
  }

  /**
   * 恢复最近的活跃会话。从SessionManager获取活跃会话列表，
   * 选择最后一个进行恢复。
   *
   * @returns {boolean} 恢复是否成功
   */
  continueLastSession() {
    this.guardShutdown();
    if (!this._sessionManager) return false;
    try {
      const sessions = this._sessionManager.getActiveSessions ? this._sessionManager.getActiveSessions() : [];
      if (sessions.length === 0) return false;
      const last = sessions[sessions.length - 1];
      return this.resumeSession(last.id);
    } catch (_e) {
      debug('TUIOrchestrator', 'continueLastSession', _e && _e.message ? _e.message : String(_e));
      return false;
    }
  }

  /**
   * 获取PersonaManager实例引用。
   *
   * @returns {PersonaManager} 人格管理器实例
   */
  getPersonaManager() {
    return this._personaManager;
  }

  /**
   * 获取QuickCommandRegistry实例引用。
   *
   * @returns {QuickCommandRegistry} 快速命令注册表实例
   */
  getQuickCommandRegistry() {
    return this._quickCommandRegistry;
  }

  /**
   * 获取TUIApp实例引用。
   *
   * @returns {TUIApp|null} TUI应用实例，未启动时为null
   */
  getTUIApp() {
    return this._tuiApp;
  }

  /**
   * 获取REPLEngine实例引用。
   *
   * @returns {REPLEngine|null} REPL引擎实例，未启动时为null
   */
  getREPLEngine() {
    return this._replEngine;
  }

  /**
   * 检查编排器是否正在运行。
   *
   * @returns {boolean} 运行状态
   */
  isRunning() {
    return this._running;
  }

  /**
   * 优雅关闭回调。停止编排器，关闭PersonaManager和QuickCommandRegistry，
   * 释放所有运行时组件引用。
   * 由withShutdown混入自动调用。
   *
   * @returns {void}
   * @private
   */
  _onShutdown() {
    this.stop();
    this._cleanupExternalListeners();
    if (this._personaManager) this._personaManager.shutdown();
    if (this._quickCommandRegistry) this._quickCommandRegistry.shutdown();
    this._tuiApp = null;
    this._replEngine = null;
    this._commandRouter = null;
    this._tokenManager = null;
    this._sessionManager = null;
    this._contextCompressionEngine = null;
    this.removeAllListeners();
  }

  /**
   * 获取TUI编排器运行统计信息。
   *
   * @returns {Object} 统计快照
   * @returns {boolean} returns.running - 是否正在运行
   * @returns {string|null} returns.sessionId - 当前会话ID
   * @returns {string} returns.persona - 当前人格
   * @returns {number} returns.messageCount - 消息数量
   * @returns {number} returns.quickCommands - 快速命令数量
   * @returns {string} returns.theme - 当前主题
   */
  getStats() {
    return {
      running: this._running,
      sessionId: this._sessionId,
      persona: this._personaManager ? this._personaManager.getCurrentPersona() : 'default',
      messageCount: this._tuiApp ? this._tuiApp.getMessages().length : 0,
      quickCommands: this._quickCommandRegistry ? this._quickCommandRegistry.getStats().totalCommands : 0,
      theme: this._theme,
    };
  }
}

TUIOrchestrator.THEMES = TUI_THEMES;

module.exports = withShutdown(TUIOrchestrator);
