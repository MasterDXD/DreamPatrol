'use strict';

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const path = require('path');
const { validateProjectRoot, DEFAULT_HOOK_TIMEOUT_MS: CENTRAL_HOOK_TIMEOUT_MS, DANGEROUS_SHELL_PATTERNS } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { BUILTIN_HANDLERS, SLOW_HOOK_THRESHOLD_MS, MONITOR_HISTORY_MAX, MONITOR_CLEANUP_INTERVAL } = require('./hook-handlers');
const RingBuffer = require('../../utils/ring-buffer');
const { counterId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { roundTo, emitError } = require('../../utils/safe-execute');
const { HookError } = require('../../errors');

const SHELL_MAX_BUFFER = 1024 * 1024;
const SHELL_OUTPUT_TRUNCATE = 500;
const HEALTH_MIN_SUCCESS_RATE = 0.7;
const MAX_HOOKS_PER_EVENT = 50;
const MAX_TOTAL_HOOKS = 500;
const DEFAULT_HOOK_TIMEOUT_MS = 2 * CENTRAL_HOOK_TIMEOUT_MS;

const ALLOWED_COMMANDS = new Set([
  'git', 'echo', 'cat', 'ls', 'mkdir',
  'cp', 'mv', 'test', 'true', 'false', 'date', 'wc', 'head',
  'tail', 'sort', 'uniq', 'diff', 'which', 'pwd', 'env',
]);

const RESERVED_RESULT_KEYS = new Set(['passed', 'reason', 'message']);

/**
 * Hook推理分类，融合自Claude Code的"no-thinking vs needs-reasoning"概念。
 *
 * REASONING_NONE('none'): 无需推理的自动化钩子（如自动格式化、ESLint检查），
 *   执行时跳过LLM上下文注入，走快速路径，延迟更低。
 * REASONING_REQUIRED('required'): 需要推理的工作流钩子（如代码审查、质量评估），
 *   执行时注入LLM上下文，走推理路径，可能触发模型调用。
 *
 * 场景化建议（融合自Claude Code实战指南）：
 * - 若希望某操作自动发生（如提交前跑测试）→ REASONING_NONE
 * - 若钩子需要AI判断（如代码审查清单）→ REASONING_REQUIRED
 */
const HOOK_REASONING = {
  NONE: 'none',
  REQUIRED: 'required',
};

/**
 * @module runtime/workflow/programmable-hook-executor
 * @classdesc 可编程钩子执行器（ProgrammableHookExecutor）。10+内置处理器，顺序执行+阻塞中断。
 * ProgrammableHookExecutor — 可编程钩子执行器
 * Registers and executes hooks (builtin, function, or shell) at lifecycle events with sequential
 * execution and blocking-on-failure semantics. Shell hooks are sandboxed with command whitelisting,
 * dangerous pattern detection, and context variable substitution. Includes a monitoring subsystem
 * that tracks execution latency, success rates, slow hook detection, and per-hook statistics.
 * @extends EventEmitter
 * @emits hook-registered | hook-unregistered | hook-executed | hook-rejected | hook-error | hook-late-rejection | slow-hook-detected
 */
class ProgrammableHookExecutor extends EventEmitter {
  /**
   * Create a ProgrammableHookExecutor instance.
   * @param {string} projectRoot - Project root directory path
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'ProgrammableHookExecutor');
    this.root = projectRoot;
    this._hooks = {};
    this._totalHookCount = 0;
    this._monitor = {
      executions: new RingBuffer(MONITOR_HISTORY_MAX),
      slowHooks: new RingBuffer(MONITOR_HISTORY_MAX),
      totals: {},
      perHook: {},
      globalCalls: 0,
      globalPasses: 0,
      globalFailures: 0,
      globalErrors: 0,
      startTime: Date.now(),
    };
    this._monitorCleanupTimer = null;
    this._startMonitorCleanup();
  }

  _startMonitorCleanup() {
    if (this._monitorCleanupTimer) return;
    const self = this;
    this._monitorCleanupTimer = setInterval(function() {
      self._cleanupMonitorHistory();
    }, MONITOR_CLEANUP_INTERVAL);
    if (this._monitorCleanupTimer && typeof this._monitorCleanupTimer.unref === 'function') {
      this._monitorCleanupTimer.unref();
    }
  }

  _cleanupMonitorHistory() {
    if (this._shutDown) return;
    const m = this._monitor;
    if (m.executions.size > MONITOR_HISTORY_MAX) {
      while (m.executions.size > MONITOR_HISTORY_MAX) m.executions.shift();
    }
    if (m.slowHooks.size > MONITOR_HISTORY_MAX) {
      while (m.slowHooks.size > MONITOR_HISTORY_MAX) m.slowHooks.shift();
    }
    const totalKeys = Object.keys(m.totals);
    if (totalKeys.length > MONITOR_HISTORY_MAX) {
      const toDelete = totalKeys.slice(0, totalKeys.length - MONITOR_HISTORY_MAX);
      for (let i = 0; i < toDelete.length; i++) {
        delete m.totals[toDelete[i]];
      }
    }
  }

  /**
   * 注册钩子到指定事件。
   * @param {string} event - 事件名称
   * @param {Object} action - 钩子配置，包含 type、name、handler、command 等
   * @returns {ProgrammableHookExecutor} this（支持链式调用）
   */
  register(event, action) {
    if (!event || !action) return this;
    if (!this.isHealthy()) return this;

    if (!this._hooks[event]) {
      this._hooks[event] = [];
    }

    if (this._hooks[event].length >= MAX_HOOKS_PER_EVENT) {
      debug('ProgrammableHookExecutor', 'register', `Max hooks per event reached: ${event}`);
      this.emit('hook-rejected', { event, reason: 'max_hooks_per_event' });
      return this;
    }

    const totalHooks = this._totalHookCount;
    if (totalHooks >= MAX_TOTAL_HOOKS) {
      debug('ProgrammableHookExecutor', 'register', 'Max total hooks reached');
      this.emit('hook-rejected', { event, reason: 'max_total_hooks' });
      return this;
    }

    const id = action.id || counterId('hook-' + event + '-');
    if (this._hooks[event].some(h => h.id === id)) {
      debug('ProgrammableHookExecutor', 'register', `Duplicate hook id: ${id} for event: ${event}`);
      return this;
    }
    const entry = {
      id,
      type: action.type ?? 'function',
      name: action.name || '',
      handler: null,
      enabled: action.enabled !== false,
      reasoning: action.reasoning === HOOK_REASONING.REQUIRED ? HOOK_REASONING.REQUIRED : HOOK_REASONING.NONE,
    };

    if (action.type === 'builtin') {
      const builtinHandler = BUILTIN_HANDLERS[action.name];
      if (builtinHandler) {
        entry.handler = builtinHandler;
        entry.name = action.name;
      } else {
        debug('ProgrammableHookExecutor', 'register', `Unknown builtin: ${action.name}`);
        return this;
      }
    } else if (action.type === 'function' || !action.type) {
      if (typeof action.handler === 'function') {
        entry.handler = action.handler;
      } else {
        debug('ProgrammableHookExecutor', 'register', 'Function hook requires handler');
        return this;
      }
    } else if (action.type === 'shell') {
      entry.command = action.command || '';
      entry.timeout = action.timeout !== undefined ? action.timeout : CENTRAL_HOOK_TIMEOUT_MS;
      entry.handler = (context) => this._executeShellHook(entry, context);
    } else {
      debug('ProgrammableHookExecutor', 'register', `Unknown hook type: ${action.type}. Must be 'builtin', 'function', or 'shell'`);
      return this;
    }

    this._hooks[event].push(entry);
    this._totalHookCount++;
    this.emit('hook-registered', { event, id, type: entry.type });
    return this;
  }

  /**
   * 从指定事件中注销钩子。
   * @param {string} event - 事件名称
   * @param {string} id - 钩子标识符
   * @returns {ProgrammableHookExecutor} this（支持链式调用）
   */
  unregister(event, id) {
    this.guardShutdown();
    if (!this._hooks[event]) return this;
    const before = this._hooks[event].length;
    this._hooks[event] = this._hooks[event].filter(h => h.id !== id);
    if (this._hooks[event].length < before) this._totalHookCount--;
    if (this._hooks[event].length === 0) {
      delete this._hooks[event];
    }
    this.emit('hook-unregistered', { event, id });
    return this;
  }

  _buildHookResult(hook, result, elapsedMs) {
    const passed = result !== null && typeof result === 'object' ? result.passed !== false : true;
    const hookResult = {
      id: hook.id,
      type: hook.type,
      name: hook.name,
      passed,
      reason: result ? result.reason || '' : '',
      message: result ? result.message || '' : '',
      elapsedMs,
    };
    if (result !== null && typeof result === 'object') {
      for (const [key, value] of Object.entries(result)) {
        if (!RESERVED_RESULT_KEYS.has(key)) {
          hookResult[key] = value;
        }
      }
    }
    return hookResult;
  }

  async _executeSingleHook(hook, ctx) {
    if (typeof hook.handler === 'function') {
      const self = this;
      const ret = hook.handler(ctx);
      if (ret && typeof ret.then === 'function') {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new HookError('HOOK_EXECUTION_ERROR', 'Hook timeout after ' + DEFAULT_HOOK_TIMEOUT_MS + 'ms')), DEFAULT_HOOK_TIMEOUT_MS);
          if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
        });
        ret.catch(function _swallowLateRejection(err) {
          debug('HookExecutor', 'lateRejection', err && err.message ? err.message : String(err));
          self.emit('hook-late-rejection', { hookId: hook.id, error: err && err.message ? err.message : String(err) });
        });
        try {
          const result = await Promise.race([ret, timeoutPromise]);
          return result;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
      return ret;
    }
    return { passed: true, message: 'No handler' };
  }

  _executeShellHook(entry, context) {
    return new Promise((resolve, _reject) => {
      if (!entry.command) {
        return resolve({ passed: true, message: 'Shell hook: no command specified', type: 'shell' });
      }

      let command = entry.command;
      command = this._substituteContext(command, context);

      const blocked = this._checkDangerousPattern(command);
      if (blocked) return resolve(blocked);

      if (context.project_root) {
        const normalizedCwd = path.resolve(context.project_root || this.root);
        const normalizedRoot = path.resolve(this.root);
        const normCwd = normalizedCwd.replace(/\\/g, '/').toLowerCase();
        const normRoot = normalizedRoot.replace(/\\/g, '/').toLowerCase();
        if (!normCwd.startsWith(normRoot + '/') && normCwd !== normRoot) {
          return resolve({ passed: false, reason: 'Shell command blocked: working directory outside project root', type: 'shell' });
        }
      }

      const parsed = this._parseShellCommand(entry, command, context);
      if (parsed.blocked) return resolve(parsed.blocked);
      const { cmd, args } = parsed;

      if (!ALLOWED_COMMANDS.has(cmd)) {
        return resolve({ passed: false, reason: 'Shell command blocked: \'' + (cmd ?? 'unknown') + '\' is not in allowed commands list', type: 'shell' });
      }

      const execOptions = {
        cwd: context.project_root || this.root,
        timeout: entry.timeout ?? DEFAULT_HOOK_TIMEOUT_MS,
        maxBuffer: SHELL_MAX_BUFFER,
        shell: false,
      };

      execFile(cmd, args, execOptions, (err, stdout, stderr) => {
        if (err) {
          return resolve({
            passed: false,
            reason: 'Shell hook failed: ' + (err && err.message ? err.message : String(err)),
            message: stderr ? stderr.slice(0, SHELL_OUTPUT_TRUNCATE) : (err && err.message ? err.message : String(err)),
            type: 'shell',
            exitCode: err.code ?? 1,
          });
        }

        resolve({
          passed: true,
          message: stdout ? stdout.slice(0, SHELL_OUTPUT_TRUNCATE).trim() : 'Shell hook executed successfully',
          type: 'shell',
          exitCode: 0,
        });
      });
    }).catch(function(err) {
      return { passed: false, reason: 'Shell hook error: ' + (err && err.message ? err.message : String(err)), type: 'shell', exitCode: 1 };
    });
  }

  _substituteContext(command, context) {
    if (!context || typeof context !== 'object') return command;
    let result = command;
    for (const [key, value] of Object.entries(context)) {
      if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
      const placeholder = `{{${key}}}`;
      if (result.includes(placeholder)) {
        const sanitized = String(value || '').replace(/[;&|`$(){}[\]!#~<>*?\\\n\r\t\0\f\v\u2028\u2029^%]/g, '_');
        result = result.split(placeholder).join(sanitized);
      }
    }
    return result;
  }

  _checkDangerousPattern(input) {
    for (const pattern of DANGEROUS_SHELL_PATTERNS) {
      if (pattern.test(input)) {
        return { passed: false, reason: 'Shell command blocked: potentially dangerous pattern detected', type: 'shell' };
      }
    }
    return null;
  }

  _parseShellCommand(entry, command, context) {
    let cmd, args;
    if (Array.isArray(entry.command)) {
      cmd = entry.command.length > 0 ? entry.command[0] : undefined;
      args = entry.command.slice(1).map((a) => {
        if (typeof a !== 'string') return String(a);
        return this._substituteContext(a, context);
      });
      for (const a of args) {
        const blocked = this._checkDangerousPattern(a);
        if (blocked) return { blocked };
      }
    } else {
      const parts = this._splitShellCommand(command);
      cmd = parts.length > 0 ? parts[0] : undefined;
      args = parts.slice(1);
      for (const a of args) {
        const blocked = this._checkDangerousPattern(a);
        if (blocked) return { blocked };
      }
    }
    return { cmd, args };
  }

  _splitShellCommand(command) {
    const parts = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        if (inSingle) {
          current += ch;
        } else {
          escaped = true;
        }
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (/\s/.test(ch) && !inSingle && !inDouble) {
        if (current.length > 0) {
          parts.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (current.length > 0) parts.push(current);
    return parts;
  }

  /**
   * 执行指定事件的所有已注册钩子，顺序执行，遇失败阻塞中断。
   * 融合自Claude Code的"no-thinking vs needs-reasoning"执行路径区分：
   * - reasoning=none的钩子走快速路径（无LLM上下文注入，延迟更低）
   * - reasoning=required的钩子走推理路径（注入LLM上下文，可能触发模型调用）
   * @param {string} event - 事件名称
   * @param {Object} context - 钩子执行上下文
   * @param {boolean} [context._skipReasoning=false] - 是否跳过推理路径钩子（内部使用）
   * @returns {Promise<Array<Object>>} 钩子执行结果列表
   */
  async execute(event, context) {
    this.guardShutdown();
    const hooks = this._hooks[event];
    if (!hooks || hooks.length === 0) return [];

    const snapshot = hooks.slice();
    const results = [];
    const skipReasoning = context && context._skipReasoning === true;
    const ctx = mergeConfig(context, { project_root: context.project_root || this.root });

    for (const hook of snapshot) {
      if (!this.isHealthy()) break;
      if (!hook.enabled) continue;

      // 条件分支：推理路径钩子在跳过推理模式下被跳过
      // 融合自Claude Code的"no-thinking vs needs-reasoning"概念
      if (skipReasoning && hook.reasoning === HOOK_REASONING.REQUIRED) {
        results.push({
          id: hook.id,
          type: hook.type,
          name: hook.name,
          passed: true,
          reason: 'Skipped: reasoning required but _skipReasoning=true',
          message: 'Hook skipped in fast-path mode',
          elapsedMs: 0,
          reasoning: hook.reasoning,
        });
        continue;
      }

      const startTime = Date.now();

      try {
        const result = await this._executeSingleHook(hook, ctx);
        const elapsedMs = Date.now() - startTime;
        const hookResult = this._buildHookResult(hook, result, elapsedMs);
        hookResult.reasoning = hook.reasoning;

        results.push(hookResult);
        this._recordMonitorData(event, hook, hookResult, elapsedMs, hookResult.passed);
        this.emit('hook-executed', { event, hookId: hook.id, passed: hookResult.passed, elapsedMs, reasoning: hook.reasoning });

        if (!hookResult.passed) {
          break;
        }
      } catch (err) {
        const elapsedMs = Date.now() - startTime;
        const hookResult = {
          id: hook.id,
          type: hook.type,
          name: hook.name,
          passed: false,
          reason: err && err.message ? err.message : String(err),
          message: 'Hook execution error',
          elapsedMs,
          reasoning: hook.reasoning,
        };
        results.push(hookResult);
        this._recordMonitorData(event, hook, hookResult, elapsedMs, false, err && err.message ? err.message : String(err));
        emitError(this, 'hook-error', err, { event, hookId: hook.id, elapsedMs });
        break;
      }
    }

    return results;
  }

  /**
   * 仅执行快速路径钩子（reasoning=none），跳过推理路径钩子。
   * 融合自Claude Code的"no-thinking"快速路径概念。
   * @param {string} event - 事件名称
   * @param {Object} context - 钩子执行上下文
   * @returns {Promise<Array<Object>>} 快速路径钩子执行结果列表
   */
  async executeFastPath(event, context) {
    return this.execute(event, mergeConfig(context ?? {}, { _skipReasoning: true }));
  }

  /**
   * 仅执行推理路径钩子（reasoning=required），跳过快速路径钩子。
   * 融合自Claude Code的"needs-reasoning"推理路径概念。
   * @param {string} event - 事件名称
   * @param {Object} context - 钩子执行上下文
   * @returns {Promise<Array<Object>>} 推理路径钩子执行结果列表
   */
  async executeReasoningPath(event, context) {
    this.guardShutdown();
    const hooks = this._hooks[event];
    if (!hooks || hooks.length === 0) return [];

    const snapshot = hooks.filter(function(h) {
      return h.reasoning === HOOK_REASONING.REQUIRED && h.enabled;
    });
    if (snapshot.length === 0) return [];

    const ctx = mergeConfig(context, { project_root: context.project_root || this.root });
    const results = [];

    for (const hook of snapshot) {
      if (!this.isHealthy()) break;

      const startTime = Date.now();
      try {
        const result = await this._executeSingleHook(hook, ctx);
        const elapsedMs = Date.now() - startTime;
        const hookResult = this._buildHookResult(hook, result, elapsedMs);
        hookResult.reasoning = hook.reasoning;

        results.push(hookResult);
        this._recordMonitorData(event, hook, hookResult, elapsedMs, hookResult.passed);
        this.emit('hook-executed', { event, hookId: hook.id, passed: hookResult.passed, elapsedMs, reasoning: hook.reasoning });

        if (!hookResult.passed) break;
      } catch (err) {
        const elapsedMs = Date.now() - startTime;
        const hookResult = {
          id: hook.id, type: hook.type, name: hook.name,
          passed: false, reason: err && err.message ? err.message : String(err),
          message: 'Hook execution error', elapsedMs, reasoning: hook.reasoning,
        };
        results.push(hookResult);
        this._recordMonitorData(event, hook, hookResult, elapsedMs, false, err && err.message ? err.message : String(err));
        emitError(this, 'hook-error', err, { event, hookId: hook.id, elapsedMs });
        break;
      }
    }

    return results;
  }

  _recordMonitorData(event, hook, hookResult, elapsedMs, passed, errorMsg) {
    const m = this._monitor;
    m.globalCalls++;
    if (passed) { m.globalPasses++; } else { m.globalFailures++; }
    if (errorMsg) { m.globalErrors++; }

    const hookKey = `${event}:${hook.id}`;
    if (m.totals[hookKey]) {
      m.totals[hookKey].calls++;
    } else {
      m.totals[hookKey] = { calls: 1, passes: 0, failures: 0, errors: 0, totalMs: 0, maxMs: 0, minMs: Infinity };
    }

    const total = m.totals[hookKey];
    total.passes += passed ? 1 : 0;
    total.failures += passed ? 0 : 1;
    total.errors += errorMsg ? 1 : 0;
    total.totalMs += elapsedMs;
    total.maxMs = Math.max(total.maxMs, elapsedMs);
    total.minMs = Math.min(total.minMs, elapsedMs);

    if (m.executions.size >= MONITOR_HISTORY_MAX) {
      m.executions.shift();
    }
    m.executions.push({
      event, hookId: hook.id, name: hook.name, type: hook.type,
      passed, elapsedMs, timestamp: Date.now(), error: errorMsg ?? null,
    });

    if (elapsedMs >= SLOW_HOOK_THRESHOLD_MS) {
      const slowEntry = {
        event, hookId: hook.id, name: hook.name, type: hook.type,
        elapsedMs, timestamp: Date.now(),
        threshold: SLOW_HOOK_THRESHOLD_MS,
        passed,
      };
      if (m.slowHooks.size >= MONITOR_HISTORY_MAX) {
        m.slowHooks.shift();
      }
      m.slowHooks.push(slowEntry);
      this.emit('slow-hook-detected', slowEntry);
    }

    const totalKeys = Object.keys(m.totals);
    if (totalKeys.length > MONITOR_HISTORY_MAX) {
      const toDelete = totalKeys.slice(0, totalKeys.length - MONITOR_HISTORY_MAX);
      for (let i = 0; i < toDelete.length; i++) {
        delete m.totals[toDelete[i]];
      }
    }
    const perHookKeys = Object.keys(m.perHook);
    if (perHookKeys.length > MONITOR_HISTORY_MAX) {
      const toDelete = perHookKeys.slice(0, perHookKeys.length - MONITOR_HISTORY_MAX);
      for (let i = 0; i < toDelete.length; i++) {
        delete m.perHook[toDelete[i]];
      }
    }
  }

  /**
   * 获取指定事件的已注册钩子列表。
   * @param {string} event - 事件名称
   * @returns {Array<Object>} 钩子摘要列表
   */
  getRegisteredHooks(event) {
    if (!event) return [];
    if (!this._hooks[event]) return [];
    return this._hooks[event].map(h => ({ id: h.id, type: h.type, name: h.name, enabled: h.enabled }));
  }

  /**
   * 从配置对象批量加载钩子定义。
   * @param {Object} config - 钩子配置对象，包含 hooks 字段
   * @returns {ProgrammableHookExecutor} this（支持链式调用）
   */
  loadFromConfig(config) {
    this.guardShutdown();
    if (!config || !config.hooks) return this;

    for (const [event, hookConfig] of Object.entries(config.hooks)) {
      if (!hookConfig || !hookConfig.enabled) continue;

      const checks = hookConfig.checks || (hookConfig.actions ?? []);
      for (const check of checks) {
        if (typeof check === 'string') {
          this.register(event, { type: 'builtin', name: check });
        } else if (typeof check === 'object' && check !== null) {
          this.register(event, check);
        }
      }
    }

    return this;
  }

  _onShutdown() {
    if (this._monitorCleanupTimer) {
      clearInterval(this._monitorCleanupTimer);
      this._monitorCleanupTimer = null;
    }
    this._hooks = {};
    this._totalHookCount = 0;
    this._monitor.executions.clear();
    this._monitor.slowHooks.clear();
    this._monitor.totals = {};
    this._monitor.perHook = {};
    this._monitor.globalCalls = 0;
    this._monitor.globalPasses = 0;
    this._monitor.globalFailures = 0;
    this._monitor.globalErrors = 0;
    this._monitor.startTime = Date.now();
    this.removeAllListeners();
  }

  /**
   * 检查钩子执行器健康状态，基于全局成功率判断。
   * @returns {boolean} 是否健康（成功率 >= 70%）
   */
  isHealthy() {
    if (this._shutDown) return false;
    const m = this._monitor;
    if (m.globalCalls > 0) {
      if (m.globalCalls < 5) return true;
      const successRate = m.globalPasses / m.globalCalls;
      return successRate >= HEALTH_MIN_SUCCESS_RATE;
    }
    return true;
  }

  /**
   * 获取钩子执行器的统计信息。
   * @returns {Object} 统计数据，包含钩子总数、按事件分组等
   */
  getStats() {
    let totalHooks = 0;
    const byEvent = {};
    for (const [event, hooks] of Object.entries(this._hooks)) {
      byEvent[event] = hooks.length;
      totalHooks += hooks.length;
    }
    return { totalHooks, hooksByEvent: byEvent, builtinCount: Object.keys(BUILTIN_HANDLERS).length };
  }

  /**
   * 获取钩子监控数据，包含全局指标、逐钩统计、慢钩子记录等。
   * @returns {Object} 监控数据
   */
  getHookMonitorData() {
    const m = this._monitor;
    const successRate = m.globalCalls > 0 ? (m.globalPasses / m.globalCalls) : 1;
    const avgLatencyMs = m.globalCalls > 0
      ? Object.values(m.totals).reduce((s, t) => s + t.totalMs, 0) / m.globalCalls : 0;

    return {
      global: {
        calls: m.globalCalls,
        passes: m.globalPasses,
        failures: m.globalFailures,
        errors: m.globalErrors,
        successRate: roundTo(successRate * 100, 2),
        avgLatencyMs: roundTo(avgLatencyMs, 2),
        uptimeMs: Date.now() - m.startTime,
      },
      perHook: Object.entries(m.totals).map(function(entry) {
        const [key, data] = entry;
        const total = data.totalMs;
        const avgMs = data.calls > 0 ? total / data.calls : 0;
        return {
          hookKey: key,
          calls: data.calls,
          passes: data.passes,
          failures: data.failures,
          errors: data.errors,
          avgMs: roundTo(avgMs, 2),
          maxMs: data.maxMs,
          minMs: data.minMs === Infinity ? 0 : data.minMs,
          successRate: data.calls > 0 ? Math.round((data.passes / data.calls) * 10000) / 100 : 100,
        };
      }),
      recentExecutions: m.executions.slice(-50),
      slowHooks: m.slowHooks.slice(-30),
      slowHookCount: m.slowHooks.size,
      thresholdMs: SLOW_HOOK_THRESHOLD_MS,
    };
  }

  /**
   * 获取慢钩子记录。
   * @param {number} [limit=50] - 返回记录的最大数量
   * @returns {Array<Object>} 慢钩子记录列表
   */
  getSlowHooks(limit) {
    const max = limit ?? 50;
    return this._monitor.slowHooks.slice(-max);
  }

  /**
   * 获取各钩子的成功率统计。
   * @returns {Object} 钩子成功率映射，键为 event:hookId
   */
  getHookSuccessRates() {
    const result = {};
    for (const [key, data] of Object.entries(this._monitor.totals)) {
      result[key] = {
        calls: data.calls,
        successRate: data.calls > 0 ? Math.round((data.passes / data.calls) * 10000) / 100 : 100,
        avgMs: data.calls > 0 ? Math.round((data.totalMs / data.calls) * 100) / 100 : 0,
      };
    }
    return result;
  }

  /**
   * 重置所有监控数据。
   * @returns {void}
   */
  resetMonitorData() {
    this.guardShutdown();
    const m = this._monitor;
    m.executions.clear();
    m.slowHooks.clear();
    m.totals = {};
    m.globalCalls = 0;
    m.globalPasses = 0;
    m.globalFailures = 0;
    m.globalErrors = 0;
    m.startTime = Date.now();
  }

  /**
   * 按推理分类获取钩子列表。融合自Claude Code的"no-thinking vs needs-reasoning"概念。
   * @param {string} reasoning - 推理类型 ('none' 或 'required')
   * @returns {Array<Object>} 匹配的钩子列表
   */
  getHooksByReasoning(reasoning) {
    const result = [];
    for (const event of Object.keys(this._hooks)) {
      for (const hook of this._hooks[event]) {
        if (hook.reasoning === reasoning) {
          result.push({ event: event, id: hook.id, name: hook.name, type: hook.type, reasoning: hook.reasoning });
        }
      }
    }
    return result;
  }
}

ProgrammableHookExecutor.BUILTIN_HANDLERS = BUILTIN_HANDLERS;
ProgrammableHookExecutor.HOOK_REASONING = HOOK_REASONING;

module.exports = withShutdown(ProgrammableHookExecutor);
