/**
 * @module runtime/tui/repl-engine
 * @description 交互式REPL命令循环引擎，提供终端用户输入的读取-求值-输出循环。
 * 作为TUI子系统的用户输入层，负责接收终端输入、路由斜杠命令至CommandRouter、
 * 管理命令历史记录、以及维护当前人格上下文。
 *
 * 架构角色：TUI子系统的输入层组件，位于用户与系统之间。
 *
 * 集成点：
 * - 与 {@link module:runtime/workflow/command-router|CommandRouter} 集成，通过 resolve/executeCommand/fuzzyMatch/complete 方法实现斜杠命令解析与执行
 * - 与 {@link module:persona-manager|PersonaManager} 协作，通过 setPersona 切换当前人格并更新提示符
 * - 由 {@link module:tui-orchestrator|TUIOrchestrator} 创建和管理，事件通过编排器转发
 *
 * 内置命令：/help, /exit, /quit, /clear, /history, /persona, /compress, /background, /status, /model, /reasoning
 */

'use strict';

const { EventEmitter } = require('events');
const readline = require('readline');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const RingBuffer = require('../../utils/ring-buffer');

const MAX_HISTORY = 500;
const MAX_INPUT_LENGTH = 4096;
const PROMPT_SUFFIX = '> ';
const SLASH_PREFIX = '/';

/**
 * 交互式REPL命令循环引擎。
 * 基于Node.js readline模块构建，提供命令历史、人格切换、斜杠命令路由等功能。
 * 通过EventEmitter将用户输入和命令事件向上层TUIOrchestrator传播。
 *
 * @classdesc REPL引擎。交互式命令解析、历史记录、自动补全
 *
 * @class
 * @extends EventEmitter
 * @fires REPLEngine#started
 * @fires REPLEngine#stopped
 * @fires REPLEngine#close
 * @fires REPLEngine#interrupt
 * @fires REPLEngine#message
 * @fires REPLEngine#command
 * @fires REPLEngine#command:fuzzy
 * @fires REPLEngine#command:unknown
 * @fires REPLEngine#command:help
 * @fires REPLEngine#command:exit
 * @fires REPLEngine#command:clear
 * @fires REPLEngine#command:history
 * @fires REPLEngine#command:persona
 * @fires REPLEngine#command:compress
 * @fires REPLEngine#command:background
 * @fires REPLEngine#command:status
 * @fires REPLEngine#command:model
 * @fires REPLEngine#command:reasoning
 * @fires REPLEngine#error
 * @fires REPLEngine#persona-changed
 *
 * @param {CommandRouter|null} commandRouter - 斜杠命令路由器实例，用于解析和执行斜杠命令
 * @param {Object} [options] - 配置选项
 * @param {string} [options.persona='default'] - 初始人格标识
 * @param {string|null} [options.sessionId=null] - 关联的会话ID
 *
 * @example
 * const router = new CommandRouter(projectRoot);
 * router.discover();
 * const repl = new REPLEngine(router, { persona: 'analyst', sessionId: 'sess-001' });
 * repl.on('message', (data) => handleUserInput(data.content));
 * repl.on('command', (data) => executeSkillChain(data.skills));
 * repl.start();
 */
class REPLEngine extends EventEmitter {
  constructor(commandRouter, options) {
    super();
    // 防止无监听器时 error 事件导致进程崩溃
    this.on('error', function(_err) {
      // 仅记录，不传播 — 外部可通过 on('error') 覆盖此行为
    });
    this._commandRouter = commandRouter ?? null;
    this._options = options ?? {};
    this._rl = null;
    this._history = new RingBuffer(MAX_HISTORY);
    this._running = false;
    this._persona = this._options.persona ?? 'default';
    this._sessionId = this._options.sessionId ?? null;
    this._builtinCommands = null;
  }

  /**
   * 启动REPL循环。创建readline接口并绑定行输入、关闭、中断事件。
   * 若已在运行则忽略重复调用。
   *
   * @fires REPLEngine#started
   * @returns {void}
   *
   * @example
   * repl.start();
   * // 提示符显示: [analyst] >
   */
  start() {
    this.guardShutdown();
    if (this._running) return;
    this._running = true;

    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this._getPrompt(),
      historySize: 100,
      removeHistoryDuplicates: true,
      crlfDelay: Infinity,
    });

    this._rl.on('line', (line) => {
      try { this._handleLine(line); }
      catch (e) { this.emit('error', e); }
    });

    this._rl.on('close', () => {
      this._running = false;
      this.emit('close');
    });

    this._rl.on('SIGINT', () => {
      this.emit('interrupt');
    });

    if (this._commandRouter) {
      this._rl.on('SIGCONT', () => {
        this._rl.prompt();
      });
    }

    this._rl.prompt();
    this.emit('started');
  }

  /**
   * 停止REPL循环。关闭readline接口并清理资源。
   *
   * @fires REPLEngine#stopped
   * @returns {void}
   */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._rl) {
      if (typeof this._rl.removeAllListeners === 'function') {
        this._rl.removeAllListeners();
      }
      this._rl.close();
      this._rl = null;
    }
    this.emit('stopped');
  }

  /**
   * 根据当前人格生成提示符字符串。
   * 非默认人格时在提示符前添加 [persona] 前缀。
   *
   * @returns {string} 格式化的提示符字符串
   * @private
   */
  _getPrompt() {
    const persona = this._persona !== 'default' ? '[' + this._persona + '] ' : '';
    return persona + PROMPT_SUFFIX;
  }

  /**
   * 处理用户输入的一行文本。根据输入内容路由到命令处理或消息事件。
   * 空行忽略，超长输入触发error事件，斜杠前缀走命令路径，其余走消息路径。
   *
   * @param {string} line - 用户输入的原始行
   * @fires REPLEngine#error
   * @fires REPLEngine#message
   * @private
   */
  _handleLine(line) {
    const trimmed = (line ?? '').trim();

    if (trimmed.length === 0) {
      if (this._rl) this._rl.prompt();
      return;
    }

    if (trimmed.length > MAX_INPUT_LENGTH) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', { type: 'input_too_long', length: trimmed.length, max: MAX_INPUT_LENGTH });
      } else {
        this.emit('safe-error', { type: 'input_too_long', length: trimmed.length, max: MAX_INPUT_LENGTH });
      }
      if (this._rl) this._rl.prompt();
      return;
    }

    this._history.push({ input: trimmed, timestamp: Date.now() });

    if (trimmed.startsWith(SLASH_PREFIX)) {
      this._handleCommand(trimmed);
    } else {
      this.emit('message', { content: trimmed, sessionId: this._sessionId });
    }

    if (this._running && this._rl) {
      this._rl.prompt();
    }
  }

  /**
   * 处理斜杠命令。先检查内置命令，再通过CommandRouter解析，
   * 最后尝试模糊匹配，均失败则触发command:unknown事件。
   *
   * @param {string} input - 完整的斜杠命令输入（含参数）
   * @fires REPLEngine#command
   * @fires REPLEngine#command:fuzzy
   * @fires REPLEngine#command:unknown
   * @private
   */
  _handleCommand(input) {
    const parts = input.split(/\s+/);
    const commandPart = parts[0];
    const args = parts.slice(1);

    const builtins = this._getBuiltinCommands();
    if (builtins[commandPart]) {
      builtins[commandPart](args);
      return;
    }

    if (this._commandRouter) {
      try {
        const resolved = this._commandRouter.resolve(commandPart);
        if (resolved) {
          const plan = this._commandRouter.executeCommand(commandPart, { args: args });
          this.emit('command', {
            commandId: resolved.command_id,
            name: resolved.name,
            skills: resolved.skills,
            args: args,
            plan: plan,
          });
          return;
        }

        const fuzzy = this._commandRouter.fuzzyMatch(commandPart);
        if (fuzzy) {
          this.emit('command:fuzzy', {
            input: commandPart,
            matched: fuzzy.command_id,
            name: fuzzy.name,
          });
          return;
        }
      } catch (_err) {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { source: 'commandRouter', message: _err && _err.message ? _err.message : String(_err), input: commandPart });
        } else {
          this.emit('safe-error', { source: 'commandRouter', message: _err && _err.message ? _err.message : String(_err), input: commandPart });
        }
        return;
      }
    }

    this.emit('command:unknown', { input: commandPart, args: args });
  }

  /**
   * 返回内置命令映射表。每个命令为接收args数组的函数，
   * 执行后触发对应的command:*事件。
   *
   * 内置命令列表：
   * - /help — 显示帮助信息
   * - /exit, /quit — 退出REPL
   * - /clear — 清屏
   * - /history — 显示命令历史
   * - /persona [id] — 查看/切换人格
   * - /compress — 触发上下文压缩
   * - /background <task> — 后台任务
   * - /status — 显示状态
   * - /model [name] — 查看/切换模型
   * - /reasoning [level] — 设置推理强度
   *
   * @returns {Object<string, Function>} 内置命令名到处理函数的映射
   * @private
   */
  _getBuiltinCommands() {
    if (this._builtinCommands) return this._builtinCommands;
    this._builtinCommands = {
      '/help': () => {
        this.emit('command:help', {});
      },
      '/exit': () => {
        this.emit('command:exit', {});
        this.stop();
      },
      '/quit': () => {
        this.emit('command:exit', {});
        this.stop();
      },
      '/clear': () => {
        this.emit('command:clear', {});
      },
      '/history': () => {
        const entries = this._history.toArray();
        this.emit('command:history', { entries: entries });
      },
      '/persona': (args) => {
        if (args.length === 0) {
          this.emit('command:persona', { action: 'list', current: this._persona });
        } else {
          const prev = this._persona;
          this._persona = args[0];
          if (this._rl) {
            this._rl.setPrompt(this._getPrompt());
          }
          this.emit('command:persona', { action: 'set', previous: prev, current: this._persona });
        }
      },
      '/compress': () => {
        this.emit('command:compress', {});
      },
      '/background': (args) => {
        this.emit('command:background', { task: args.join(' ') });
      },
      '/status': () => {
        this.emit('command:status', {});
      },
      '/model': (args) => {
        this.emit('command:model', { model: args[0] ?? null });
      },
      '/reasoning': (args) => {
        this.emit('command:reasoning', { level: args[0] || 'medium' });
      },
    };
    return this._builtinCommands;
  }

  /**
   * 基于部分输入补全斜杠命令。委托给CommandRouter的complete方法。
   *
   * @param {string} partial - 部分命令字符串
   * @returns {Array<Object>} 匹配的命令列表
   *
   * @example
   * const matches = repl.completeCommand('/co');
   * // 可能返回: [{ command_id: '/code-review', name: '代码审查', ... }]
   */
  completeCommand(partial) {
    if (!this._commandRouter || !partial) return [];
    return this._commandRouter.complete(partial);
  }

  /**
   * 切换当前人格并更新提示符。
   *
   * @param {string} persona - 目标人格标识
   * @fires REPLEngine#persona-changed
   * @returns {void}
   *
   * @example
   * repl.setPersona('analyst');
   * // 提示符从 "> " 变为 "[analyst] > "
   */
  setPersona(persona) {
    this.guardShutdown();
    const prev = this._persona;
    this._persona = persona || 'default';
    if (this._rl) {
      this._rl.setPrompt(this._getPrompt());
    }
    this.emit('persona-changed', { previous: prev, current: this._persona });
  }

  /**
   * 获取当前人格标识。
   *
   * @returns {string} 当前人格ID
   */
  getPersona() {
    return this._persona;
  }

  /**
   * 设置关联的会话ID。
   *
   * @param {string} sessionId - 会话标识
   * @returns {void}
   */
  setSessionId(sessionId) {
    this.guardShutdown();
    this._sessionId = sessionId;
  }

  /**
   * 获取关联的会话ID。
   *
   * @returns {string|null} 当前会话ID
   */
  getSessionId() {
    return this._sessionId;
  }

  /**
   * 向终端输出一行文本。在readline接口活跃时使用rl.write写入。
   *
   * @param {string} text - 要输出的文本
   * @returns {void}
   */
  writeOutput(text) {
    this.guardShutdown();
    if (this._rl) {
      this._rl.write(text + '\n');
    }
  }

  /**
   * 检查REPL是否正在运行。
   *
   * @returns {boolean} 运行状态
   */
  isRunning() {
    return this._running;
  }

  /**
   * 获取命令历史记录。
   *
   * @returns {Array<{input: string, timestamp: number}>} 历史条目数组
   */
  getHistory() {
    return this._history.toArray().map(entry => ({ input: entry.input, timestamp: entry.timestamp }));
  }

  /**
   * 优雅关闭回调。停止REPL循环、清空历史、释放CommandRouter引用。
   * 由withShutdown混入自动调用。
   *
   * @returns {void}
   * @private
   */
  _onShutdown() {
    this.stop();
    safeCall(() => this._history.shutdown(), 'REPLEngine', 'shutdown-history');
    this._commandRouter = null;
    this.removeAllListeners();
  }

  /**
   * 获取REPL引擎运行统计信息。
   *
   * @returns {Object} 统计快照
   * @returns {boolean} returns.running - 是否正在运行
   * @returns {string} returns.persona - 当前人格
   * @returns {string|null} returns.sessionId - 关联会话ID
   * @returns {number} returns.historySize - 历史记录条数
   * @returns {boolean} returns.hasCommandRouter - 是否配置了CommandRouter
   */
  getStats() {
    return {
      running: this._running,
      persona: this._persona,
      sessionId: this._sessionId,
      historySize: this._history.size,
      hasCommandRouter: !!this._commandRouter,
    };
  }
}

module.exports = withShutdown(REPLEngine);
