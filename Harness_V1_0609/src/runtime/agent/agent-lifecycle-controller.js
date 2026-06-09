'use strict';

const { EventEmitter } = require('events');
const { AgentError } = require('../../errors');
const AgentRuntime = require('./agent-runtime');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');
const { DEFAULT_LOCK_TIMEOUT_MS } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const deepClone = require('../../utils/deep-clone');

const LIFECYCLE_OPERATIONS = {
  CREATE: 'create',
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'stop',
  DESTROY: 'destroy',
  RESTART: 'restart',
};

/**
 * @module runtime/agent/agent-lifecycle-controller
 * @classdesc Agent生命周期控制器（AgentLifecycleController）。创建→初始化→运行→暂停→恢复→终止，
 * 通过操作锁防止并发生命周期冲突，记录操作历史用于审计追踪。
 *
 * AgentLifecycleController — Agent生命周期控制器
 * 编排Agent的完整生命周期操作（创建→启动→暂停→恢复→停止→销毁→重启），
 * 通过操作锁防止并发生命周期冲突，记录操作历史用于审计追踪。
 * 与AgentRuntime、AgentStateManager和AgentSandbox协作，确保状态转换的原子性和一致性。
 * @extends EventEmitter
 * @emits AgentLifecycleController#agent-created
 * @emits AgentLifecycleController#agent-started
 * @emits AgentLifecycleController#agent-paused
 * @emits AgentLifecycleController#agent-resumed
 * @emits AgentLifecycleController#agent-stopped
 * @emits AgentLifecycleController#agent-destroyed
 * @emits AgentLifecycleController#agent-restarted
 */
class AgentLifecycleController extends EventEmitter {
  /**
   * @param {AgentRuntime} runtime - Agent运行时实例
   * @param {Object} stateManager - 状态管理器，用于持久化Agent状态
   * @param {Object} sandbox - Agent沙箱，用于资源隔离和清理
   */
  constructor(runtime, stateManager, sandbox) {
    super();
    this.runtime = runtime || new AgentRuntime(process.cwd());
    this.stateManager = stateManager ?? null;
    this.sandbox = sandbox ?? null;
    this._operationHistory = new BoundedArray(1000);
    this._operationLocks = new Map();
  }

  /**
   * 创建Agent实例并注册到运行时，持久化初始状态。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} config - Agent配置
   * @param {string} config.role - Agent角色
   * @returns {Object} 创建的Agent实例
   */
  create(agentId, config) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.CREATE);

    try {
      const agent = this.runtime.register(agentId, config);

      if (this.stateManager) {
        this.stateManager.saveState(agentId, {
          state: agent.state,
          config: agent.config,
          version: agent.version,
          createdAt: agent.createdAt,
        });
      }

      this._recordOperation(agentId, LIFECYCLE_OPERATIONS.CREATE, { config });
      this.emit('agent-created', { agentId, agent });
      return agent;
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.CREATE);
    }
  }

  /**
   * 启动Agent，检查依赖和沙箱就绪状态，分配资源并转换到RUNNING状态。
   * @param {string} agentId - Agent唯一标识
   * @returns {Object} 启动后的Agent实例
   */
  start(agentId) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.START);

    try {
      const agent = this.runtime.get(agentId);
      if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

      const depCheck = this.runtime.checkDependencies(agentId);
      if (!depCheck.satisfied) {
        throw new AgentError('DEPENDENCY_UNSATISFIED', `Dependencies not satisfied: missing=${depCheck.missing.join(',')}, unavailable=${depCheck.unavailable.map(u => u.id + ':' + u.state).join(',')}`);
      }

      if (this.sandbox) {
        const sandboxResult = this.sandbox.prepare(agentId, agent.config);
        if (!sandboxResult.ready) {
          throw new AgentError('SANDBOX_NOT_READY', `Sandbox not ready: ${sandboxResult.reason}`);
        }
      }

      this.runtime.transition(agentId, AgentRuntime.STATES.INITIALIZING);

      const resourceLimits = agent.config.resourceLimits ?? {};
      this.runtime.allocateResources(agentId, {
        memoryMB: resourceLimits.maxMemoryMB ?? 128,
        cpuPercent: resourceLimits.maxCpuPercent ?? 20,
      });

      this.runtime.transition(agentId, AgentRuntime.STATES.RUNNING);

      if (this.stateManager) {
        this.stateManager.saveState(agentId, {
          state: AgentRuntime.STATES.RUNNING,
          startedAt: agent.startedAt,
        });
      }

      this._recordOperation(agentId, LIFECYCLE_OPERATIONS.START, {});
      this.emit('agent-started', { agentId });
      return this.runtime.get(agentId);
    } catch (err) {
      const agent = this.runtime.get(agentId);
      if (agent && agent.state === AgentRuntime.STATES.INITIALIZING) {
        try {
          this.runtime.setError(agentId, { message: this._errMsg(err), code: err && err.code ? err.code : 'UNKNOWN' });
          this.runtime.transition(agentId, AgentRuntime.STATES.ERROR);
        } catch (transitionErr) {
          try { agent.state = AgentRuntime.STATES.CREATED; } catch (_e) { debug('AgentLifecycle', 'forceReset', _e); }
          debug('AgentLifecycle', 'transition', transitionErr);
        }
      }
      throw err;
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.START);
    }
  }

  /**
   * 暂停Agent，将状态转换为PAUSED并持久化。
   * @param {string} agentId - Agent唯一标识
   * @returns {Object} 暂停后的Agent实例
   */
  pause(agentId) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.PAUSE);

    try {
      const agent = this.runtime.get(agentId);
      if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

      this.runtime.transition(agentId, AgentRuntime.STATES.PAUSED);

      if (this.stateManager) {
        this.stateManager.saveState(agentId, {
          state: AgentRuntime.STATES.PAUSED,
          pausedAt: new Date().toISOString(),
        });
      }

      this._recordOperation(agentId, LIFECYCLE_OPERATIONS.PAUSE, {});
      this.emit('agent-paused', { agentId });
      return this.runtime.get(agentId);
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.PAUSE);
    }
  }

  /**
   * 恢复已暂停的Agent，将状态转换回RUNNING并持久化。
   * @param {string} agentId - Agent唯一标识
   * @returns {Object} 恢复后的Agent实例
   */
  resume(agentId) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.RESUME);

    try {
      const agent = this.runtime.get(agentId);
      if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

      this.runtime.transition(agentId, AgentRuntime.STATES.RUNNING);

      if (this.stateManager) {
        this.stateManager.saveState(agentId, {
          state: AgentRuntime.STATES.RUNNING,
          resumedAt: new Date().toISOString(),
        });
      }

      this._recordOperation(agentId, LIFECYCLE_OPERATIONS.RESUME, {});
      this.emit('agent-resumed', { agentId });
      return this.runtime.get(agentId);
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.RESUME);
    }
  }

  /**
   * 停止Agent，释放资源并清理沙箱，转换到STOPPED状态。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} [options] - 停止选项
   * @param {boolean} [options.force=false] - 是否强制停止（跳过状态持久化）
   * @returns {Object} 停止后的Agent实例
   */
  stop(agentId, options) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.STOP);

    try {
      const agent = this.runtime.get(agentId);
      if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

      const force = options && options.force;

      this.runtime.transition(agentId, AgentRuntime.STATES.STOPPING);

      if (!force && this.stateManager) {
        this.stateManager.saveState(agentId, {
          state: AgentRuntime.STATES.STOPPING,
          pendingTasks: agent.taskCount,
        });
      }

      this.runtime.releaseResources(agentId);
      this.runtime.transition(agentId, AgentRuntime.STATES.STOPPED);

      if (this.sandbox) {
        this.sandbox.cleanup(agentId);
      }

      if (this.stateManager) {
        this.stateManager.saveState(agentId, {
          state: AgentRuntime.STATES.STOPPED,
          stoppedAt: new Date().toISOString(),
        });
      }

      this._recordOperation(agentId, LIFECYCLE_OPERATIONS.STOP, { force });
      this.emit('agent-stopped', { agentId, force });
      return this.runtime.get(agentId);
    } catch (err) {
      // 尝试将卡在STOPPING状态的Agent恢复到ERROR
      try {
        const currentAgent = this.runtime.get(agentId);
        if (currentAgent && currentAgent.state === AgentRuntime.STATES.STOPPING) {
          this.runtime.transition(agentId, AgentRuntime.STATES.ERROR);
          this.runtime.setError(agentId, { message: this._errMsg(err), code: err && err.code ? err.code : 'UNKNOWN' });
        }
      } catch (recoveryErr) {
        debug('AgentLifecycle', 'stopRecovery', recoveryErr && recoveryErr.message ? recoveryErr.message : String(recoveryErr));
      }
      if (!options || !options.force) throw err;
      throw err;
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.STOP);
    }
  }

  /**
   * 销毁Agent，先停止运行中的Agent再从运行时注销，删除持久化状态。
   * @param {string} agentId - Agent唯一标识
   * @returns {boolean} 是否销毁成功
   */
  destroy(agentId) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.DESTROY);

    try {
      const agent = this.runtime.get(agentId);
      if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

      if (agent.state === AgentRuntime.STATES.RUNNING || agent.state === AgentRuntime.STATES.PAUSED) {
        try {
          this.runtime.transition(agentId, AgentRuntime.STATES.STOPPING);
          this.runtime.releaseResources(agentId);
          this.runtime.transition(agentId, AgentRuntime.STATES.STOPPED);
          if (this.sandbox) {
            this.sandbox.cleanup(agentId);
          }
          if (this.stateManager) {
            this.stateManager.saveState(agentId, {
              state: AgentRuntime.STATES.STOPPED,
              stoppedAt: new Date().toISOString(),
            });
          }
          this._recordOperation(agentId, LIFECYCLE_OPERATIONS.STOP, { force: true });
          this.emit('agent-stopped', { agentId, force: true });
        } catch (stopErr) {
          debug('AgentLifecycle', 'forceStop', stopErr);
        }
      }

      const currentAgent = this.runtime.get(agentId);
      if (currentAgent && currentAgent.state !== AgentRuntime.STATES.STOPPED && currentAgent.state !== AgentRuntime.STATES.ERROR && currentAgent.state !== AgentRuntime.STATES.CREATED) {
        try {
          if (currentAgent.state === AgentRuntime.STATES.RUNNING || currentAgent.state === AgentRuntime.STATES.PAUSED) {
            this.runtime.transition(agentId, AgentRuntime.STATES.STOPPING);
            this.runtime.transition(agentId, AgentRuntime.STATES.STOPPED);
          }
          this.runtime.transition(agentId, AgentRuntime.STATES.DESTROYED);
        } catch (transitionErr) {
          debug('AgentLifecycle', 'forceDestroy', transitionErr);
        }
      }

      if (this.stateManager) {
        this.stateManager.deleteState(agentId);
      }

      this.runtime.unregister(agentId);

      this._recordOperation(agentId, LIFECYCLE_OPERATIONS.DESTROY, {});
      this.emit('agent-destroyed', { agentId });
      return true;
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.DESTROY);
    }
  }

  /**
   * 重启Agent，先停止再重新启动，失败时自动回滚到之前状态。
   * @param {string} agentId - Agent唯一标识
   * @returns {Object} 重启后的Agent实例
   */
  restart(agentId) {
    this.guardShutdown();
    this._acquireLock(agentId, LIFECYCLE_OPERATIONS.RESTART);
    try {
      const agent = this.runtime.get(agentId);
      if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

      const previousState = agent.state;
      const previousConfig = deepClone(agent.config);

      if (this._isRunningOrPaused(previousState)) {
        this._stopForRestart(agentId);
      }

      try {
        this._startAfterRestart(agentId);
        this._recordOperation(agentId, LIFECYCLE_OPERATIONS.RESTART, {});
        this.emit('agent-restarted', { agentId });
        return this.runtime.get(agentId);
      } catch (startErr) {
        if (this._isRunningOrPaused(previousState)) {
          this._rollbackRestart(agentId, previousConfig, startErr);
        }
        throw startErr;
      }
    } finally {
      this._releaseLock(agentId, LIFECYCLE_OPERATIONS.RESTART);
    }
  }

  _isRunningOrPaused(state) {
    return state === AgentRuntime.STATES.RUNNING || state === AgentRuntime.STATES.PAUSED;
  }

  _stopForRestart(agentId) {
    this.runtime.transition(agentId, AgentRuntime.STATES.STOPPING);
    this.runtime.releaseResources(agentId);
    this.runtime.transition(agentId, AgentRuntime.STATES.STOPPED);
    if (this.sandbox) this.sandbox.cleanup(agentId);
    if (this.stateManager) this.stateManager.saveState(agentId, { state: AgentRuntime.STATES.STOPPED, stoppedAt: new Date().toISOString() });
    this._recordOperation(agentId, LIFECYCLE_OPERATIONS.STOP, {});
    this.emit('agent-stopped', { agentId });
  }

  _startAfterRestart(agentId) {
    const depCheck = this.runtime.checkDependencies(agentId);
    if (!depCheck.satisfied) {
      throw new AgentError('DEPENDENCY_UNSATISFIED', `Dependencies not satisfied: missing=${depCheck.missing.join(',')}`);
    }
    this.runtime.transition(agentId, AgentRuntime.STATES.INITIALIZING);
    const resourceLimits = (this.runtime.get(agentId) ?? {}).config?.resourceLimits ?? {};
    this.runtime.allocateResources(agentId, {
      memoryMB: resourceLimits.maxMemoryMB ?? 128,
      cpuPercent: resourceLimits.maxCpuPercent ?? 20,
    });
    this.runtime.transition(agentId, AgentRuntime.STATES.RUNNING);
    if (this.stateManager) this.stateManager.saveState(agentId, { state: AgentRuntime.STATES.RUNNING, startedAt: new Date().toISOString() });
  }

  _errMsg(err) {
    return err && err.message ? err.message : String(err);
  }

  _rollbackRestart(agentId, previousConfig, startErr) {
    try {
      this.runtime.transition(agentId, AgentRuntime.STATES.INITIALIZING);
      const resourceLimits = previousConfig?.resourceLimits ?? {};
      this.runtime.allocateResources(agentId, {
        memoryMB: resourceLimits.maxMemoryMB ?? 128,
        cpuPercent: resourceLimits.maxCpuPercent ?? 20,
      });
      this.runtime.transition(agentId, AgentRuntime.STATES.RUNNING);
      if (this.sandbox) this.sandbox.prepare(agentId, previousConfig);
      if (this.stateManager) this.stateManager.saveState(agentId, { state: AgentRuntime.STATES.RUNNING, startedAt: new Date().toISOString() });
      this.emit('agent-restart-rollback', { agentId, reason: this._errMsg(startErr) });
    } catch (rollbackErr) {
      try { this.runtime.setError(agentId, { message: 'Restart failed and rollback failed: ' + this._errMsg(rollbackErr), code: 'RESTART_ROLLBACK_FAILED' }); } catch (err) { debug('AgentLifecycleController', 'rollback', 'setError failed: ' + this._errMsg(err)); }
      try { this.runtime.transition(agentId, AgentRuntime.STATES.ERROR); } catch (err) { debug('AgentLifecycleController', 'rollback', 'transition to ERROR failed: ' + this._errMsg(err)); }
      this.emit('agent-restart-failed', { agentId, startError: this._errMsg(startErr), rollbackError: this._errMsg(rollbackErr) });
    }
  }

  /**
   * 获取Agent当前状态摘要。
   * @param {string} agentId - Agent唯一标识
   * @returns {Object|null} Agent状态信息，不存在时返回null
   */
  getStatus(agentId) {
    const agent = this.runtime.get(agentId);
    if (!agent) return null;

    return {
      id: agent.id,
      state: agent.state,
      version: agent.version,
      startedAt: agent.startedAt,
      stoppedAt: agent.stoppedAt,
      taskCount: agent.taskCount,
      errorInfo: agent.errorInfo,
      lastActivityAt: agent.lastActivityAt,
    };
  }

  /**
   * 获取生命周期操作历史记录。
   * @param {string} [agentId] - 按Agent ID过滤，不传则返回全部
   * @param {number} [limit] - 返回最近N条记录
   * @returns {Array<Object>} 操作历史列表
   */
  getOperationHistory(agentId, limit) {
    const allOps = this._operationHistory.toArray();
    if (agentId) {
      const filtered = allOps.filter(op => op.agentId === agentId);
      return limit ? filtered.slice(-limit) : filtered;
    }
    return limit ? allOps.slice(-limit) : allOps;
  }

  _acquireLock(agentId, operation) {
    const existing = this._operationLocks.get(agentId);
    if (existing) {
      if (Date.now() - existing.timestamp > DEFAULT_LOCK_TIMEOUT_MS) {
        debug('AgentLifecycle', 'lockTimeout', 'Lock for ' + agentId + ' timed out after ' + DEFAULT_LOCK_TIMEOUT_MS + 'ms (operation: ' + existing.operation + ')');
        this._operationLocks.delete(agentId);
      } else {
        throw new AgentError('OPERATION_IN_PROGRESS', `Agent ${agentId} has an operation in progress`);
      }
    }
    this._operationLocks.set(agentId, { operation, timestamp: Date.now() });
  }

  _releaseLock(agentId, operation) {
    const existing = this._operationLocks.get(agentId);
    if (existing && existing.operation === operation) {
      this._operationLocks.delete(agentId);
    }
  }

  _recordOperation(agentId, operation, details) {
    this._operationHistory.push({
      agentId,
      operation,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  _onShutdown() {
    this._operationLocks.clear();
    safeCall(() => this._operationHistory.shutdown(), 'AgentLifecycleController', 'shutdown-operationHistory');
    this.removeAllListeners();
  }
}

AgentLifecycleController.OPERATIONS = LIFECYCLE_OPERATIONS;

module.exports = withShutdown(AgentLifecycleController);
