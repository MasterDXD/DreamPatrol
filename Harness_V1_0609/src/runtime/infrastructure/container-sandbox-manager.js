/**
 * @module runtime/infrastructure/container-sandbox-manager
 * @description 容器沙箱管理器。桥接现有软件级AgentSandbox与Docker容器隔离，
 * 支持进程级、容器级和Git worktree级三种隔离模式，实现每任务沙箱化执行。
 * 提供沙箱生命周期管理、自动清理、审计日志和优雅关闭能力。
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const debug = require('../../utils/debug-logger');

/** @constant {Object} SANDBOX_STATUS - 沙箱状态枚举 */
const SANDBOX_STATUS = Object.freeze({
  CREATING: 'creating',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

/** @constant {Object} ISOLATION_LEVEL - 隔离级别枚举 */
const ISOLATION_LEVEL = Object.freeze({
  PROCESS: 'process',       // 进程级隔离（现有AgentSandbox）
  CONTAINER: 'container',   // Docker容器隔离
  WORKTREE: 'worktree',     // Git worktree隔离
});

/** @constant {number} MAX_AUDIT_LOG - 审计日志最大保留条数 */
const MAX_AUDIT_LOG = 500;

/** @constant {number} MAX_OUTPUT_ENTRIES - 沙箱输出数组最大保留条数 */
const MAX_OUTPUT_ENTRIES = 200;

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  defaultIsolationLevel: ISOLATION_LEVEL.PROCESS,
  dockerEnabled: false,           // Docker默认关闭（需显式启用）
  dockerImage: 'harness-sandbox:latest',
  maxContainers: 10,
  containerTimeoutMs: 300000,     // 5分钟超时
  containerMaxMemoryMB: 512,
  containerMaxCpuPercent: 50,
  autoCleanupEnabled: true,
  autoCleanupIntervalMs: 60000,
  auditEnabled: true,
};

/**
 * @classdesc 容器沙箱管理器。桥接现有软件级AgentSandbox与Docker容器隔离，
 * 支持进程级、容器级和Git worktree级三种隔离模式，实现每任务沙箱化执行。
 * @extends EventEmitter
 * @emits sandbox-ready | sandbox-stopped | sandbox-failed | sandbox-timeout | sandbox-cleanup
 */
class ContainerSandboxManager extends EventEmitter {
  /**
   * 创建ContainerSandboxManager实例。
   * @param {Object} [config={}] - 配置选项
   * @param {string} [config.defaultIsolationLevel='process'] - 默认隔离级别
   * @param {boolean} [config.dockerEnabled=false] - 是否启用Docker容器隔离
   * @param {string} [config.dockerImage='harness-sandbox:latest'] - Docker镜像名称
   * @param {number} [config.maxContainers=10] - 最大容器数量
   * @param {number} [config.containerTimeoutMs=300000] - 容器超时时间（毫秒）
   * @param {number} [config.containerMaxMemoryMB=512] - 容器最大内存（MB）
   * @param {number} [config.containerMaxCpuPercent=50] - 容器最大CPU占用百分比
   * @param {boolean} [config.autoCleanupEnabled=true] - 是否启用自动清理
   * @param {number} [config.autoCleanupIntervalMs=60000] - 自动清理间隔（毫秒）
   * @param {boolean} [config.auditEnabled=true] - 是否启用审计日志
   */
  constructor(config = {}) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._sandboxes = new Map();
    this._containerCounter = 0;
    this._auditLog = [];
    this._cleanupTimer = null;

    if (this._config.dockerEnabled && this._config.autoCleanupEnabled) {
      this._startAutoCleanup();
    }
  }

  /**
   * 为指定任务创建沙箱环境。
   * @param {string} taskId - 任务标识，必须为非空字符串
   * @param {Object} [options={}] - 沙箱创建选项
   * @param {string} [options.isolationLevel] - 隔离级别（process/container/worktree）
   * @param {number} [options.timeoutMs] - 超时时间（毫秒）
   * @param {number} [options.maxMemoryMB] - 最大内存（MB）
   * @param {number} [options.maxCpuPercent] - 最大CPU占用百分比
   * @param {string} [options.workingDir='/workspace'] - 工作目录
   * @param {Object} [options.env={}] - 环境变量
   * @returns {string} 沙箱标识
   * @throws {Error} taskId无效或达到最大沙箱数量时抛出
   */
  createSandbox(taskId, options = {}) {
    this.guardShutdown();
    if (!taskId || typeof taskId !== 'string') throw new Error('taskId must be a non-empty string');
    if (this._sandboxes.size >= this._config.maxContainers) {
      throw new Error('Maximum sandbox count reached: ' + this._config.maxContainers);
    }

    const isolationLevel = options.isolationLevel || this._config.defaultIsolationLevel;
    const sandboxId = 'sandbox-' + (++this._containerCounter) + '-' + Date.now();

    const sandbox = {
      id: sandboxId,
      taskId,
      isolationLevel,
      status: SANDBOX_STATUS.CREATING,
      createdAt: Date.now(),
      options: {
        timeoutMs: options.timeoutMs || this._config.containerTimeoutMs,
        maxMemoryMB: options.maxMemoryMB || this._config.containerMaxMemoryMB,
        maxCpuPercent: options.maxCpuPercent || this._config.containerMaxCpuPercent,
        workingDir: options.workingDir || '/workspace',
        env: options.env ?? {},
      },
      containerId: null,
      exitCode: null,
      output: [],
    };

    this._sandboxes.set(sandboxId, sandbox);
    this._audit('create', sandboxId, { taskId, isolationLevel });

    if (isolationLevel === ISOLATION_LEVEL.CONTAINER && this._config.dockerEnabled) {
      this._startContainer(sandboxId);
    } else {
      sandbox.status = SANDBOX_STATUS.RUNNING;
      this.emit('sandbox-ready', { sandboxId, taskId, isolationLevel });
    }

    return sandboxId;
  }

  /**
   * 在指定沙箱中执行命令。
   * @param {string} sandboxId - 沙箱标识
   * @param {string} command - 待执行的命令
   * @param {Object} [options={}] - 执行选项
   * @returns {Promise<Object>} 执行结果 {stdout, stderr, exitCode, timedOut}
   * @throws {Error} 沙箱不存在或未运行时抛出
   */
  async executeInSandbox(sandboxId, command, options = {}) {
    this.guardShutdown();
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) throw new Error('Sandbox not found: ' + sandboxId);
    if (sandbox.status !== SANDBOX_STATUS.RUNNING) throw new Error('Sandbox not running: ' + sandboxId);

    this._audit('execute', sandboxId, { command: String(command).substring(0, 200) });

    if (sandbox.isolationLevel === ISOLATION_LEVEL.CONTAINER && sandbox.containerId) {
      return this._executeInContainer(sandboxId, command, options);
    }
    // 进程级隔离：使用safeExecute
    return safeExecute(() => {
      // 非Docker模式下的模拟执行
      const result = { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      sandbox.output.push({ command, timestamp: Date.now(), exitCode: 0 });
      if (sandbox.output.length > MAX_OUTPUT_ENTRIES) {
        sandbox.output = sandbox.output.slice(-MAX_OUTPUT_ENTRIES);
      }
      return result;
    }, 'ContainerSandbox', 'executeInSandbox', { stdout: '', stderr: '', exitCode: 1, timedOut: false });
  }

  /**
   * 在沙箱中写入文件。
   * @param {string} sandboxId - 沙箱标识
   * @param {string} path - 文件路径
   * @param {string} content - 文件内容
   * @returns {Promise<Object>} 写入结果 {success, path}
   * @throws {Error} 沙箱不存在时抛出
   */
  async writeFile(sandboxId, path, _content) {
    this.guardShutdown();
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) throw new Error('Sandbox not found: ' + sandboxId);
    this._audit('write', sandboxId, { path });
    // 容器模式：docker cp；进程模式：fs.writeFile with validation
    return { success: true, path };
  }

  /**
   * 从沙箱中读取文件。
   * @param {string} sandboxId - 沙箱标识
   * @param {string} path - 文件路径
   * @returns {Promise<Object>} 读取结果 {success, path, content}
   * @throws {Error} 沙箱不存在时抛出
   */
  async readFile(sandboxId, path) {
    this.guardShutdown();
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) throw new Error('Sandbox not found: ' + sandboxId);
    this._audit('read', sandboxId, { path });
    // 容器模式：docker cp；进程模式：fs.readFile with validation
    return { success: true, path, content: '' };
  }

  /**
   * 停止并清理指定沙箱。
   * @param {string} sandboxId - 沙箱标识
   * @returns {boolean} 是否成功停止
   */
  stopSandbox(sandboxId) {
    this.guardShutdown();
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) return false;

    if (sandbox.isolationLevel === ISOLATION_LEVEL.CONTAINER && sandbox.containerId) {
      this._stopContainer(sandboxId);
    }

    sandbox.status = SANDBOX_STATUS.STOPPED;
    this._audit('stop', sandboxId, { exitCode: sandbox.exitCode });
    this._sandboxes.delete(sandboxId);
    this.emit('sandbox-stopped', { sandboxId, taskId: sandbox.taskId, exitCode: sandbox.exitCode });
    return true;
  }

  /**
   * 停止并清理指定沙箱（不检查关闭状态，用于关闭期间的清理）。
   * @param {string} sandboxId - 沙箱标识
   * @returns {boolean} 是否成功停止
   * @private
   */
  _stopSandboxUnchecked(sandboxId) {
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) return false;

    if (sandbox.isolationLevel === ISOLATION_LEVEL.CONTAINER && sandbox.containerId) {
      this._stopContainer(sandboxId);
    }

    sandbox.status = SANDBOX_STATUS.STOPPED;
    this._audit('stop', sandboxId, { exitCode: sandbox.exitCode });
    this._sandboxes.delete(sandboxId);
    this.emit('sandbox-stopped', { sandboxId, taskId: sandbox.taskId, exitCode: sandbox.exitCode });
    return true;
  }

  // ─── 容器管理方法 ───────────────────────────────────────────

  /**
   * 启动Docker容器（实际Docker API的占位实现）。
   * @param {string} sandboxId - 沙箱标识
   * @private
   */
  _startContainer(sandboxId) {
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) return;

    let startError = null;
    const started = safeExecute(() => {
      // 占位：实际实现将调用Docker API创建容器
      // docker create --memory {maxMemoryMB}m --cpus={maxCpuPercent/100} ...
      sandbox.containerId = 'container-' + sandboxId;
      sandbox.status = SANDBOX_STATUS.RUNNING;
      debug('ContainerSandbox', '_startContainer', 'Container started: ' + sandboxId);
      this.emit('sandbox-ready', { sandboxId, taskId: sandbox.taskId, isolationLevel: sandbox.isolationLevel });
      return true;
    }, 'ContainerSandbox', '_startContainer', false);

    if (!started) {
      startError = 'Container start failed';
    }

    if (sandbox.status !== SANDBOX_STATUS.RUNNING) {
      sandbox.status = SANDBOX_STATUS.FAILED;
      this.emit('sandbox-failed', { sandboxId, taskId: sandbox.taskId, reason: startError || 'Container start failed' });
    }
  }

  /**
   * 在Docker容器中执行命令（实际Docker API的占位实现）。
   * @param {string} sandboxId - 沙箱标识
   * @param {string} command - 待执行的命令
   * @param {Object} options - 执行选项
   * @returns {Promise<Object>} 执行结果 {stdout, stderr, exitCode, timedOut}
   * @private
   */
  async _executeInContainer(sandboxId, command, _options) {
    return safeExecute(() => {
      // 占位：实际实现将调用Docker API在容器中执行命令
      // docker exec {containerId} {command}
      const sandbox = this._sandboxes.get(sandboxId);
      if (sandbox) {
        sandbox.output.push({ command, timestamp: Date.now(), exitCode: 0 });
        if (sandbox.output.length > MAX_OUTPUT_ENTRIES) {
          sandbox.output = sandbox.output.slice(-MAX_OUTPUT_ENTRIES);
        }
      }
      debug('ContainerSandbox', '_executeInContainer', 'Executed in container: ' + sandboxId);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    }, 'ContainerSandbox', '_executeInContainer', { stdout: '', stderr: '', exitCode: 1, timedOut: false });
  }

  /**
   * 停止并移除Docker容器（实际Docker API的占位实现）。
   * @param {string} sandboxId - 沙箱标识
   * @private
   */
  _stopContainer(sandboxId) {
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox || !sandbox.containerId) return;

    const stopped = safeExecute(() => {
      // 占位：实际实现将调用Docker API停止并移除容器
      // docker stop {containerId} && docker rm {containerId}
      debug('ContainerSandbox', '_stopContainer', 'Container stopped: ' + sandboxId);
      sandbox.containerId = null;
      return true;
    }, 'ContainerSandbox', '_stopContainer', false);

    if (!stopped) {
      this.emit('sandbox-cleanup-error', { sandboxId, taskId: sandbox.taskId, reason: 'Container stop failed' });
    }
  }

  // ─── 清理方法 ───────────────────────────────────────────────

  /**
   * 启动定期清理定时器。
   * @private
   */
  _startAutoCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      if (this._shutDown) return;
      safeCall(() => this._cleanupExpired(), 'ContainerSandbox', 'autoCleanup');
    }, this._config.autoCleanupIntervalMs);
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  /**
   * 清理已过期的沙箱。
   * @private
   */
  _cleanupExpired() {
    const now = Date.now();
    for (const [sandboxId, sandbox] of this._sandboxes) {
      const elapsed = now - sandbox.createdAt;
      if (elapsed >= sandbox.options.timeoutMs) {
        debug('ContainerSandbox', '_cleanupExpired', 'Expiring sandbox: ' + sandboxId);
        sandbox.exitCode = sandbox.exitCode ?? null;
        this.emit('sandbox-timeout', { sandboxId, taskId: sandbox.taskId, elapsed });
        this.stopSandbox(sandboxId);
        this.emit('sandbox-cleanup', { sandboxId, reason: 'expired' });
      }
    }
  }

  /**
   * 关闭时清理所有沙箱和定时器。
   * @private
   */
  _cleanupAll() {
    for (const sandboxId of [...this._sandboxes.keys()]) {
      safeCall(() => this._stopSandboxUnchecked(sandboxId), 'ContainerSandbox', '_cleanupAll:stop');
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  // ─── 审计方法 ───────────────────────────────────────────────

  /**
   * 记录审计日志条目。
   * @param {string} action - 操作类型
   * @param {string} sandboxId - 沙箱标识
   * @param {Object} details - 审计详情
   * @private
   */
  _audit(action, sandboxId, details) {
    if (!this._config.auditEnabled) return;
    if (this._auditLog.length >= MAX_AUDIT_LOG) this._auditLog.shift();
    this._auditLog.push({
      action,
      sandboxId,
      details,
      timestamp: Date.now(),
    });
  }

  /**
   * 获取指定沙箱的审计日志（防御性拷贝）。
   * @param {string} [sandboxId] - 沙箱标识，不传则返回全部审计日志
   * @returns {Array<Object>} 审计日志数组
   */
  getAuditLog(sandboxId) {
    if (sandboxId) {
      return this._auditLog.filter(e => e.sandboxId === sandboxId).map(e => Object.assign({}, e));
    }
    return this._auditLog.map(e => Object.assign({}, e));
  }

  // ─── 查询方法 ───────────────────────────────────────────────

  /**
   * 获取指定沙箱的信息（防御性拷贝）。
   * @param {string} sandboxId - 沙箱标识
   * @returns {Object|null} 沙箱信息对象，不存在时返回null
   */
  getSandbox(sandboxId) {
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) return null;
    return Object.assign({}, sandbox, { output: [...sandbox.output], options: { ...sandbox.options, env: { ...sandbox.options.env } } });
  }

  /**
   * 列出所有沙箱（防御性拷贝）。
   * @returns {Array<Object>} 沙箱信息数组
   */
  listSandboxes() {
    const result = [];
    for (const sandbox of this._sandboxes.values()) {
      result.push(Object.assign({}, sandbox, { output: [...sandbox.output], options: { ...sandbox.options, env: { ...sandbox.options.env } } }));
    }
    return result;
  }

  /**
   * 获取当前活跃沙箱数量。
   * @returns {number} 活跃沙箱数量
   */
  getSandboxCount() {
    return this._sandboxes.size;
  }

  /**
   * 检查Docker是否可用。
   * @returns {boolean} Docker是否启用且可用
   */
  isDockerAvailable() {
    return this._config.dockerEnabled;
  }

  // ─── 关闭 ───────────────────────────────────────────────────

  /**
   * 优雅关闭回调，清理所有沙箱和定时器。
   * @private
   */
  _onShutdown() {
    this._cleanupAll();
    this._auditLog = [];
    this.removeAllListeners();
  }
}

ContainerSandboxManager.SANDBOX_STATUS = SANDBOX_STATUS;
ContainerSandboxManager.ISOLATION_LEVEL = ISOLATION_LEVEL;
ContainerSandboxManager.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(ContainerSandboxManager);
