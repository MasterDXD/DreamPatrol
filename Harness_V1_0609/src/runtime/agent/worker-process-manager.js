'use strict';

/**
 * @module runtime/agent/worker-process-manager
 * Worker进程管理器，融合自Meridian AI Worker编排系统的进程管理概念。
 *
 * Meridian核心洞察：AI Worker大规模运行时的工程化痛点：
 * - 识别系统启动的Worker进程与外部进程
 * - 清理未正常退出的残留进程
 * - 监控进程泄漏、日志爆炸、Token消耗异常
 * - 强制终止失控的Worker任务
 *
 * 本模块提供进程级Worker管理能力，补充AgentSandbox的逻辑沙箱隔离。
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');
const EventEmitter = require('events');

/**
 * Worker进程状态
 */
const PROCESS_STATUS = {
  SPAWNING: 'spawning',
  RUNNING: 'running',
  IDLE: 'idle',
  STUCK: 'stuck',
  ZOMBIE: 'zombie',
  TERMINATED: 'terminated',
  FAILED: 'failed',
};

/**
 * 进程异常类型
 */
const ANOMALY_TYPE = {
  ZOMBIE: 'zombie',
  STUCK: 'stuck',
  LOG_EXPLOSION: 'log-explosion',
  TOKEN_OVERFLOW: 'token-overflow',
  MEMORY_LEAK: 'memory-leak',
  TIMEOUT: 'timeout',
};

const DEFAULT_OPTIONS = {
  maxProcesses: 50,
  maxAnomalyHistory: 500,
  stuckThresholdMs: 300000,
  zombieCheckIntervalMs: 60000,
  maxLogSizeBytes: 10485760,
  maxTokenUsage: 500000,
  autoCleanup: true,
};

/**
 * Worker进程管理器，融合自Meridian的"进程管理"概念。
 *
 * 专门处理AI Worker大规模运行时的工程化痛点：
 * - 进程生命周期管理（spawn/monitor/terminate）
 * - 僵尸进程检测与清理
 * - 进程异常监控（卡死、日志爆炸、Token消耗异常）
 * - 强制终止失控的Worker任务
 *
 * @classdesc Worker进程管理器。进程监控、僵尸检测、异常告警。
 * @extends EventEmitter
 */
class WorkerProcessManager extends EventEmitter {

  /**
   * 创建WorkerProcessManager实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxProcesses=50] - 最大进程数
   * @param {number} [options.maxAnomalyHistory=500] - 最大异常历史数
   * @param {number} [options.stuckThresholdMs=300000] - 卡死判定阈值（毫秒）
   * @param {number} [options.zombieCheckIntervalMs=60000] - 僵尸检查间隔（毫秒）
   * @param {number} [options.maxLogSizeBytes=10485760] - 最大日志大小（字节）
   * @param {number} [options.maxTokenUsage=500000] - 最大Token使用量
   * @param {boolean} [options.autoCleanup=true] - 是否自动清理
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._processes = new Map();
    this._anomalyHistory = new BoundedArray(this._options.maxAnomalyHistory);
    this._stats = { spawned: 0, terminated: 0, anomalies: 0, zombiesCleaned: 0, stuckRecovered: 0 };
    this._zombieCheckTimer = null;

    if (this._options.autoCleanup) {
      this._startZombieCheck();
    }
  }

  /**
   * 注册Worker进程，融合自Meridian的"识别系统启动的Worker进程"概念。
   * @param {string} processId - 进程标识
   * @param {Object} [meta={}] - 进程元数据
   * @param {string} [meta.agentId] - 关联的Agent ID
   * @param {string} [meta.taskId] - 关联的任务ID
   * @param {number} [meta.pid] - 操作系统进程ID
   * @param {string} [meta.workDir] - 工作目录
   * @param {Object} [meta.resourceLimits] - 资源限制
   * @returns {Object} 注册结果
   */
  registerProcess(processId, meta) {
    this.guardShutdown();
    if (!processId) return { processId: null, error: 'processId is required' };

    if (this._processes.size >= this._options.maxProcesses) {
      let evicted = false;
      for (const [id, p] of this._processes) {
        if (p.status === PROCESS_STATUS.TERMINATED || p.status === PROCESS_STATUS.FAILED) {
          this._processes.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) return { processId: null, error: 'Max processes reached' };
    }

    const entry = {
      processId,
      agentId: (meta && meta.agentId) || null,
      taskId: (meta && meta.taskId) || null,
      pid: (meta && meta.pid) || null,
      workDir: (meta && meta.workDir) || null,
      resourceLimits: (meta && meta.resourceLimits) ?? {},
      status: PROCESS_STATUS.SPAWNING,
      logSizeBytes: 0,
      tokenUsage: 0,
      spawnedAt: Date.now(),
      lastActivityAt: Date.now(),
      terminatedAt: null,
      anomalyCount: 0,
    };
    this._processes.set(processId, entry);
    this._stats.spawned++;
    this.emit('process-registered', { processId, agentId: entry.agentId, taskId: entry.taskId });
    return { processId, status: entry.status };
  }

  /**
   * 更新进程状态。
   * @param {string} processId - 进程标识
   * @param {string} status - 新状态
   * @returns {{ ok: boolean, processId: string, status: string }} 更新结果
   */
  updateStatus(processId, status) {
    this.guardShutdown();
    const entry = this._processes.get(processId);
    if (!entry) return { ok: false, processId, status: null };

    if (!Object.values(PROCESS_STATUS).includes(status)) {
      return { ok: false, processId, status: entry.status };
    }

    const prevStatus = entry.status;
    entry.status = status;
    entry.lastActivityAt = Date.now();

    if (status === PROCESS_STATUS.TERMINATED || status === PROCESS_STATUS.FAILED) {
      entry.terminatedAt = Date.now();
      this._stats.terminated++;
    }

    this.emit('status-changed', { processId, from: prevStatus, to: status });
    return { ok: true, processId, status };
  }

  /**
   * 更新进程资源使用量，融合自Meridian的"监控进程泄漏、日志爆炸、Token消耗异常"概念。
   * @param {string} processId - 进程标识
   * @param {Object} usage - 资源使用量
   * @param {number} [usage.logSizeBytes] - 日志大小
   * @param {number} [usage.tokenUsage] - Token使用量
   * @returns {{ ok: boolean, anomalies: string[] }} 更新结果及检测到的异常
   */
  updateUsage(processId, usage) {
    this.guardShutdown();
    const entry = this._processes.get(processId);
    if (!entry) return { ok: false, anomalies: [] };

    const anomalies = [];

    if (usage && typeof usage.logSizeBytes === 'number') {
      entry.logSizeBytes = usage.logSizeBytes;
      if (usage.logSizeBytes > this._options.maxLogSizeBytes) {
        anomalies.push(ANOMALY_TYPE.LOG_EXPLOSION);
        this._recordAnomaly(processId, ANOMALY_TYPE.LOG_EXPLOSION, 'Log size ' + usage.logSizeBytes + ' exceeds limit ' + this._options.maxLogSizeBytes);
      }
    }

    if (usage && typeof usage.tokenUsage === 'number') {
      entry.tokenUsage = usage.tokenUsage;
      if (usage.tokenUsage > this._options.maxTokenUsage) {
        anomalies.push(ANOMALY_TYPE.TOKEN_OVERFLOW);
        this._recordAnomaly(processId, ANOMALY_TYPE.TOKEN_OVERFLOW, 'Token usage ' + usage.tokenUsage + ' exceeds limit ' + this._options.maxTokenUsage);
      }
    }

    entry.lastActivityAt = Date.now();
    return { ok: true, anomalies: anomalies };
  }

  /**
   * 报告进程活动（心跳），用于卡死检测。
   * @param {string} processId - 进程标识
   * @returns {{ ok: boolean }} 报告结果
   */
  heartbeat(processId) {
    this.guardShutdown();
    const entry = this._processes.get(processId);
    if (!entry) return { ok: false };
    entry.lastActivityAt = Date.now();
    if (entry.status === PROCESS_STATUS.STUCK) {
      entry.status = PROCESS_STATUS.RUNNING;
    }
    return { ok: true };
  }

  /**
   * 强制终止Worker进程，融合自Meridian的"强制终止失控的Worker任务"概念。
   * @param {string} processId - 进程标识
   * @param {string} [reason='manual'] - 终止原因
   * @returns {{ ok: boolean, processId: string, previousStatus: string }} 终止结果
   */
  forceTerminate(processId, reason) {
    this.guardShutdown();
    const entry = this._processes.get(processId);
    if (!entry) return { ok: false, processId, previousStatus: null };

    const prevStatus = entry.status;
    entry.status = PROCESS_STATUS.TERMINATED;
    entry.terminatedAt = Date.now();
    this._stats.terminated++;

    this.emit('force-terminated', { processId, previousStatus: prevStatus, reason: reason || 'manual' });
    return { ok: true, processId, previousStatus: prevStatus };
  }

  /**
   * 检测僵尸进程，融合自Meridian的"清理未正常退出的残留进程"概念。
   * 僵尸进程：状态为RUNNING但长时间无心跳的进程。
   * @returns {Array<{processId: string, agentId: string|null, idleMs: number}>} 僵尸进程列表
   */
  detectZombies() {
    this.guardShutdown();
    const now = Date.now();
    const zombies = [];

    for (const [processId, entry] of this._processes) {
      if (entry.status === PROCESS_STATUS.RUNNING || entry.status === PROCESS_STATUS.IDLE) {
        const idleMs = now - entry.lastActivityAt;
        if (idleMs > this._options.stuckThresholdMs) {
          entry.status = PROCESS_STATUS.ZOMBIE;
          entry.anomalyCount++;
          zombies.push({ processId, agentId: entry.agentId, idleMs: idleMs });
          this._recordAnomaly(processId, ANOMALY_TYPE.ZOMBIE, 'No activity for ' + Math.round(idleMs / 1000) + 's');
          this.emit('zombie-detected', { processId, agentId: entry.agentId, idleMs: idleMs });
        }
      }
    }

    if (zombies.length > 0) {
      this._stats.zombiesCleaned += zombies.length;
    }
    return zombies;
  }

  /**
   * 检测卡死进程。
   * @returns {Array<{processId: string, agentId: string|null, idleMs: number}>} 卡死进程列表
   */
  detectStuck() {
    this.guardShutdown();
    const now = Date.now();
    const stuck = [];

    for (const [processId, entry] of this._processes) {
      if (entry.status === PROCESS_STATUS.RUNNING) {
        const idleMs = now - entry.lastActivityAt;
        if (idleMs > this._options.stuckThresholdMs / 2 && idleMs <= this._options.stuckThresholdMs) {
          entry.status = PROCESS_STATUS.STUCK;
          stuck.push({ processId, agentId: entry.agentId, idleMs: idleMs });
          this._recordAnomaly(processId, ANOMALY_TYPE.STUCK, 'Process stuck for ' + Math.round(idleMs / 1000) + 's');
          this.emit('stuck-detected', { processId, agentId: entry.agentId, idleMs: idleMs });
        }
      }
    }

    return stuck;
  }

  /**
   * 清理已终止的进程记录。
   * @returns {number} 清理数量
   */
  cleanup() {
    this.guardShutdown();
    let cleaned = 0;
    for (const [processId, entry] of this._processes) {
      if (entry.status === PROCESS_STATUS.TERMINATED || entry.status === PROCESS_STATUS.FAILED || entry.status === PROCESS_STATUS.ZOMBIE) {
        this._processes.delete(processId);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 获取进程信息。
   * @param {string} processId - 进程标识
   * @returns {Object|null} 进程信息
   */
  getProcess(processId) {
    const entry = this._processes.get(processId);
    if (!entry) return null;
    return {
      processId: entry.processId,
      agentId: entry.agentId,
      taskId: entry.taskId,
      pid: entry.pid,
      status: entry.status,
      logSizeBytes: entry.logSizeBytes,
      tokenUsage: entry.tokenUsage,
      anomalyCount: entry.anomalyCount,
      spawnedAt: entry.spawnedAt,
      lastActivityAt: entry.lastActivityAt,
      terminatedAt: entry.terminatedAt,
      idleMs: Date.now() - entry.lastActivityAt,
    };
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    let running = 0;
    let idle = 0;
    let stuck = 0;
    let zombie = 0;
    for (const [, entry] of this._processes) {
      if (entry.status === PROCESS_STATUS.RUNNING) running++;
      else if (entry.status === PROCESS_STATUS.IDLE) idle++;
      else if (entry.status === PROCESS_STATUS.STUCK) stuck++;
      else if (entry.status === PROCESS_STATUS.ZOMBIE) zombie++;
    }
    return {
      spawned: this._stats.spawned,
      terminated: this._stats.terminated,
      anomalies: this._stats.anomalies,
      zombiesCleaned: this._stats.zombiesCleaned,
      stuckRecovered: this._stats.stuckRecovered,
      active: { running: running, idle: idle, stuck: stuck, zombie: zombie },
      totalRegistered: this._processes.size,
    };
  }

  /**
   * 记录异常。
   * @param {string} processId - 进程标识
   * @param {string} type - 异常类型
   * @param {string} message - 异常消息
   * @private
   */
  _recordAnomaly(processId, type, message) {
    this._anomalyHistory.push({ processId, type, message, timestamp: Date.now() });
    this._stats.anomalies++;
    this.emit('anomaly', { processId, type, message });
  }

  /**
   * 启动僵尸检查定时器。
   * @private
   */
  _startZombieCheck() {
    if (this._zombieCheckTimer) return;
    const self = this;
    this._zombieCheckTimer = setInterval(function() {
      if (self._shutDown) return;
      try {
        self.detectStuck();
        self.detectZombies();
      } catch (_e) { debug('WorkerProcessManager', 'zombieCheck', _e && _e.message ? _e.message : String(_e)); }
    }, this._options.zombieCheckIntervalMs);
    if (this._zombieCheckTimer && typeof this._zombieCheckTimer.unref === 'function') {
      this._zombieCheckTimer.unref();
    }
  }

  _onShutdown() {
    if (this._zombieCheckTimer) {
      clearInterval(this._zombieCheckTimer);
      this._zombieCheckTimer = null;
    }
    safeCall(() => this._anomalyHistory.shutdown(), 'WorkerProcessManager', 'shutdown-anomalyHistory');
    this._processes.clear();
    this.removeAllListeners();
  }
}

WorkerProcessManager.PROCESS_STATUS = PROCESS_STATUS;
WorkerProcessManager.ANOMALY_TYPE = ANOMALY_TYPE;

module.exports = withShutdown(WorkerProcessManager);
