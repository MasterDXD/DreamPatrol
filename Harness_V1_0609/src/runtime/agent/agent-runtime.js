'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { AgentError } = require('../../errors');
const { validateAgentId, validateProjectRoot, DEFAULT_DEBOUNCE_MS, DEFAULT_PIPELINE_TIMEOUT_MS , HARNESS_DIR} = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const { sanitize: sanitizeData, writeAtomic } = require('../../utils/debounced-persister');
const { debug } = require('../../utils/debug-logger');
const { safeCall, emitError } = require('../../utils/safe-execute');
const { readJsonDirSync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');
const KeyedDebouncer = require('../../utils/keyed-debouncer');
const ModelLayer = require('./model-layer');
const HarnessLayer = require('./harness-layer');

const AGENT_STATES = {
  CREATED: 'created',
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
  DESTROYED: 'destroyed',
};

const VALID_TRANSITIONS = {
  [AGENT_STATES.CREATED]: [AGENT_STATES.INITIALIZING, AGENT_STATES.DESTROYED],
  [AGENT_STATES.INITIALIZING]: [AGENT_STATES.RUNNING, AGENT_STATES.ERROR, AGENT_STATES.DESTROYED],
  [AGENT_STATES.RUNNING]: [AGENT_STATES.PAUSED, AGENT_STATES.STOPPING, AGENT_STATES.ERROR],
  [AGENT_STATES.PAUSED]: [AGENT_STATES.RUNNING, AGENT_STATES.STOPPING, AGENT_STATES.ERROR],
  [AGENT_STATES.STOPPING]: [AGENT_STATES.STOPPED, AGENT_STATES.ERROR],
  [AGENT_STATES.STOPPED]: [AGENT_STATES.INITIALIZING, AGENT_STATES.DESTROYED],
  [AGENT_STATES.ERROR]: [AGENT_STATES.INITIALIZING, AGENT_STATES.DESTROYED],
  [AGENT_STATES.DESTROYED]: [],
};

const VALID_TRANSITIONS_SET = {};
Object.entries(VALID_TRANSITIONS).forEach(([state, targets]) => {
  VALID_TRANSITIONS_SET[state] = new Set(targets);
});

const DEFAULT_RESOURCE_LIMITS = {
  maxMemoryMB: 512,
  maxCpuPercent: 80,
  maxTimeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS,
  maxConcurrentTasks: 10,
};

const MAX_AGENTS = 200;

/**
 * @module runtime/agent/agent-runtime
 * @classdesc Agent运行时核心（AgentRuntime）。生命周期管理、状态转换、能力注册，
 * 支持attachPromptBuilder()提示词构建器注入和buildPrompt()提示词编译。
 *
 * Agent runtime core. Manages agent lifecycle (created→initializing→running→paused→stopping→stopped→error→destroyed),
 * resource allocation (memory/CPU), state transitions, and persistence to .harness/agents-runtime/.
 * Inherits EventEmitter.
 *
 * @fires AgentRuntime#agent-registered
 * @fires AgentRuntime#agent-unregistered
 * @fires AgentRuntime#agent-state-change
 * @fires AgentRuntime#resource-allocated
 * @fires AgentRuntime#version-changed
 *
 * @example
 * const runtime = new AgentRuntime('/path/to/project');
 * const agent = runtime.register('my-agent', { version: '1.0.0' });
 * runtime.transition('my-agent', 'initializing');
 * runtime.allocateResources('my-agent', { memoryMB: 256, cpuPercent: 20 });
 */
class AgentRuntime extends EventEmitter {
  /**
   * 创建 AgentRuntime 实例。
   * @param {string} projectRoot - 项目根目录的绝对路径
   * @param {Object} [options] - 运行时配置选项
   * @param {number} [options.totalMemoryMB=4096] - 资源池总内存预算（MB）
   * @param {Object} [options.model] - 模型层配置
   * @param {Object} [options.harness] - Harness层配置
   * @throws {AgentError} projectRoot无效时抛出
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'AgentRuntime', AgentError);
    this.root = projectRoot;
    this.options = options ?? {};
    this.agents = new Map();
    this._resourcePool = {
      totalMemoryMB: (this.options.totalMemoryMB !== undefined ? this.options.totalMemoryMB : 4096),
      usedMemoryMB: 0,
      totalCpuPercent: 100,
      usedCpuPercent: 0,
    };
    this._modelLayer = new ModelLayer(options && options.model);
    this._harnessLayer = new HarnessLayer(options && options.harness);
    this._persistDebouncer = new KeyedDebouncer({ debounceMs: DEFAULT_DEBOUNCE_MS, label: 'AgentRuntime' });
    this._agentsRuntimeDir = path.join(this.root, HARNESS_DIR, 'agents-runtime');
    this._allocating = false;
    this._transitionLocks = new Map();
    try {
      this._restoreAgents();
    } catch (err) {
      debug('AgentRuntime', 'constructor', '_restoreAgents failed:', err && err.message ? err.message : String(err));
    }
    this.agents.forEach((agent) => {
      if (agent.allocatedResources && typeof agent.allocatedResources === 'object') {
        this._resourcePool.usedMemoryMB += (typeof agent.allocatedResources.memoryMB === 'number' && Number.isFinite(agent.allocatedResources.memoryMB) ? agent.allocatedResources.memoryMB : 0);
        this._resourcePool.usedCpuPercent += (typeof agent.allocatedResources.cpuPercent === 'number' && Number.isFinite(agent.allocatedResources.cpuPercent) ? agent.allocatedResources.cpuPercent : 0);
      }
    });
  }

  /** 获取模型层实例 */
  get modelLayer() { return this._modelLayer; }
  /** 获取Harness层实例 */
  get harnessLayer() { return this._harnessLayer; }

  /**
   * Register a new agent with the runtime.
   * @param {string} agentId - Unique agent identifier
   * @param {Object} config - Agent configuration
   * @param {string} [config.version='1.0.0'] - Agent version
   * @param {string[]} [config.dependencies=[]] - IDs of agents this agent depends on
   * @param {Object} [config.resourceLimits] - Per-agent resource limits
   * @param {Object} [config.metadata={}] - Arbitrary metadata
   * @returns {Object} The newly created agent object
   * @throws {AgentError} agentId is invalid, agent already exists, or resource limit reached
   */
  register(agentId, config) {
    this.guardShutdown();
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) {
      throw new AgentError('INVALID_AGENT_ID', idValidation.reason);
    }
    if (!config || typeof config !== 'object') throw new AgentError('INVALID_INPUT', 'config must be a non-null object');
    if (this.agents.has(agentId)) {
      throw new AgentError('AGENT_EXISTS', `Agent ${agentId} already registered`);
    }
    if (this.agents.size >= MAX_AGENTS) {
      const evicted = this._evictOldest();
      if (!evicted) {
        throw new AgentError('RESOURCE_EXHAUSTED', `Maximum agent limit (${MAX_AGENTS}) reached and no evictable agents available`);
      }
    }

    const resourceLimits = mergeConfig(DEFAULT_RESOURCE_LIMITS, config.resourceLimits ?? {});
    const agent = {
      id: agentId,
      state: AGENT_STATES.CREATED,
      config: mergeConfig(config, { resourceLimits }),
      version: config.version ?? '1.0.0',
      dependencies: config.dependencies ?? [],
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      startedAt: null,
      stoppedAt: null,
      errorInfo: null,
      taskCount: 0,
      metadata: config.metadata ?? {},
    };

    this.agents.set(agentId, agent);
    this._persist(agent, true);
    this.emit('agent-registered', { agentId, agent });
    return agent;
  }

  async _unregisterWith(agentId, deleteFn) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.state !== AGENT_STATES.STOPPED && agent.state !== AGENT_STATES.CREATED && agent.state !== AGENT_STATES.ERROR) {
      throw new AgentError('INVALID_STATE', `Cannot unregister agent in state ${agent.state}. Must be stopped, created, or error.`);
    }
    this._releaseResources(agent);
    this.agents.delete(agentId);
    this._persistDebouncer.delete(agentId);
    let diskDeleted = true;
    try {
      const result = await deleteFn(agentId);
      // deleteFn可能是_deleteFromDiskWith（返回boolean）或其他函数
      if (typeof result === 'boolean') { diskDeleted = result; }
    } catch (err) {
      debug('AgentRuntime', '_unregisterWith', err);
      diskDeleted = false;
    }
    this.emit('agent-unregistered', { agentId, diskDeleted });
    return true;
  }

  /**
   * Unregister an agent synchronously. The agent must be in a stopped, created, or error state.
   * @param {string} agentId - ID of the agent to unregister
   * @returns {boolean} true if the agent was unregistered, false if not found
   * @throws {AgentError} agent is in a state that does not allow unregistration
   */
  unregister(agentId) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.state !== AGENT_STATES.STOPPED && agent.state !== AGENT_STATES.CREATED && agent.state !== AGENT_STATES.ERROR) {
      throw new AgentError('INVALID_STATE', `Cannot unregister agent in state ${agent.state}. Must be stopped, created, or error.`);
    }
    this._releaseResources(agent);
    this.agents.delete(agentId);
    this._persistDebouncer.delete(agentId);
    try {
      const filePath = path.join(this._agentsRuntimeDir, `${agentId}.json`);
      try { fs.unlinkSync(filePath); } catch (_e) { if (_e && _e.code !== 'ENOENT') debug('AgentRuntime', 'unregisterUnlink', _e && _e.message ? _e.message : String(_e)); }
    } catch (err) {
      debug('AgentRuntime', 'unregister', err);
    }
    this.emit('agent-unregistered', { agentId });
    return true;
  }

  /**
   * 异步注销Agent。从内存和磁盘异步删除Agent记录。
   * @param {string} agentId - 待注销的Agent ID
   * @returns {Promise<boolean>} 注销是否成功
   * @throws {AgentError} 当Agent处于INVALID_STATE时抛出异常
   */
  async unregisterAsync(agentId) {
    this.guardShutdown();
    return this._unregisterWith(agentId, (id) => this._deleteFromDiskAsync(id));
  }

  /**
   * Retrieve a shallow copy of an agent's data.
   * @param {string} agentId - ID of the agent to retrieve
   * @returns {Object|null} Agent data object, or null if not found
   */
  get(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return {
      id: agent.id,
      state: agent.state,
      config: mergeConfig(agent.config, { resourceLimits: mergeConfig(agent.config.resourceLimits) }),
      version: agent.version,
      dependencies: agent.dependencies.slice(),
      createdAt: agent.createdAt,
      lastActivityAt: agent.lastActivityAt,
      startedAt: agent.startedAt,
      stoppedAt: agent.stoppedAt,
      errorInfo: agent.errorInfo ? (function() { const ei = mergeConfig(agent.errorInfo); delete ei.stack; return ei; })() : null,
      taskCount: agent.taskCount,
      metadata: mergeConfig(agent.metadata),
      allocatedResources: agent.allocatedResources ? mergeConfig(agent.allocatedResources) : undefined,
    };
  }

  /**
   * Get a lightweight status summary of an agent.
   * @param {string} agentId - ID of the agent to query
   * @returns {Object|null} Status object with id, state, taskCount, allocatedResources, or null if not found
   */
  getStatus(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return {
      id: agent.id,
      state: agent.state,
      taskCount: agent.taskCount,
      allocatedResources: agent.allocatedResources ? mergeConfig(agent.allocatedResources) : undefined,
    };
  }

  /**
   * Transition an agent to a new state. Only valid transitions are allowed per VALID_TRANSITIONS.
   * @param {string} agentId - ID of the agent to transition
   * @param {string} newState - Target state (one of AGENT_STATES values)
   * @param {string} [reason] - Optional reason for the transition
   * @returns {Object} The updated agent object
   * @throws {AgentError} agent not found, transition already in progress, or invalid state transition
   * @example
   * const runtime = new AgentRuntime('/project/root');
   * runtime.register('worker-1', { version: '1.0.0' });
   * runtime.transition('worker-1', 'initializing', 'Starting agent');
   * runtime.transition('worker-1', 'running', 'Agent ready');
   * runtime.transition('worker-1', 'paused', 'Maintenance mode');
   */
  transition(agentId, newState, reason) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

    if (this._transitionLocks.has(agentId)) {
      throw new AgentError('TRANSITION_IN_PROGRESS', `Agent ${agentId} is already transitioning`);
    }

    const allowed = VALID_TRANSITIONS_SET[agent.state];
    if (!allowed || !allowed.has(newState)) {
      throw new AgentError('INVALID_TRANSITION', `Invalid state transition: ${agent.state} → ${newState}`);
    }

    this._transitionLocks.set(agentId, { from: agent.state, to: newState, startedAt: Date.now() });
    try {
      const oldState = agent.state;
      agent.state = newState;
      agent.lastActivityAt = new Date().toISOString();
      agent.lastTransitionReason = reason ?? null;

      if (newState === AGENT_STATES.RUNNING && !agent.startedAt) {
        agent.startedAt = new Date().toISOString();
      }
      if (newState === AGENT_STATES.STOPPED) {
        agent.stoppedAt = new Date().toISOString();
      }
      if (newState === AGENT_STATES.ERROR) {
        agent.errorInfo = agent.errorInfo ?? { message: reason || 'Unknown error', timestamp: new Date().toISOString() };
      }

      this._persist(agent, true);
      this.emit('agent-state-change', { agentId, from: oldState, to: newState, reason: reason ?? null });
      return agent;
    } finally {
      this._transitionLocks.delete(agentId);
    }
  }

  /**
   * Allocate memory and CPU resources to an agent. Adjusts the shared resource pool.
   * @param {string} agentId - ID of the agent to allocate resources for
   * @param {Object} resources - Resource allocation request
   * @param {number} [resources.memoryMB=0] - Memory in MB to allocate
   * @param {number} [resources.cpuPercent=0] - CPU percentage to allocate
   * @returns {Object} The updated agent object
   * @throws {AgentError} agent not found, invalid input, concurrent allocation, or resource limits exceeded
   */
  allocateResources(agentId, resources) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);
    if (!resources || typeof resources !== 'object') throw new AgentError('INVALID_INPUT', 'resources must be a non-null object');

    const memMB = typeof resources.memoryMB === 'number' && Number.isFinite(resources.memoryMB) ? Math.max(0, resources.memoryMB) : 0;
    const cpuPercent = typeof resources.cpuPercent === 'number' && Number.isFinite(resources.cpuPercent) ? Math.max(0, resources.cpuPercent) : 0;

    if (this._allocating) {
      throw new AgentError('RESOURCE_BUSY', 'Resource allocation already in progress');
    }
    this._allocating = true;
    try {
      const prevMem = agent.allocatedResources && agent.allocatedResources.memoryMB ? agent.allocatedResources.memoryMB : 0;
      const prevCpu = agent.allocatedResources && agent.allocatedResources.cpuPercent ? agent.allocatedResources.cpuPercent : 0;
      const deltaMem = memMB - prevMem;
      const deltaCpu = cpuPercent - prevCpu;
      if (this._resourcePool.usedMemoryMB + deltaMem > this._resourcePool.totalMemoryMB) {
        throw new AgentError('RESOURCE_EXHAUSTED', `Memory limit exceeded: requested ${memMB}MB, available ${this._resourcePool.totalMemoryMB - this._resourcePool.usedMemoryMB}MB`);
      }
      if (this._resourcePool.usedCpuPercent + deltaCpu > this._resourcePool.totalCpuPercent) {
        throw new AgentError('RESOURCE_EXHAUSTED', `CPU limit exceeded: requested ${cpuPercent}%, available ${this._resourcePool.totalCpuPercent - this._resourcePool.usedCpuPercent}%`);
      }

      this._resourcePool.usedMemoryMB += deltaMem;
      this._resourcePool.usedCpuPercent += deltaCpu;
      this._resourcePool.usedMemoryMB = Math.max(0, this._resourcePool.usedMemoryMB);
      this._resourcePool.usedCpuPercent = Math.max(0, this._resourcePool.usedCpuPercent);
      agent.allocatedResources = { memoryMB: memMB, cpuPercent: cpuPercent };
    } finally {
      this._allocating = false;
    }
    agent.lastActivityAt = new Date().toISOString();
    this._persist(agent);
    this.emit('resource-allocated', { agentId, resources });
    return agent;
  }

  /**
   * Release all resources allocated to an agent, returning them to the shared pool.
   * @param {string} agentId - ID of the agent whose resources to release
   * @returns {void}
   */
  releaseResources(agentId) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this._releaseResources(agent);
    agent.allocatedResources = {};
    agent.lastActivityAt = new Date().toISOString();
    this._persist(agent);
  }

  /**
   * Return allocated resources to the shared pool for a given agent.
   * @private
   * @param {Object} agent - The internal agent object
   * @returns {void}
   */
  _releaseResources(agent) {
    if (agent.allocatedResources && Object.keys(agent.allocatedResources).length > 0) {
      const mem = agent.allocatedResources.memoryMB;
      const cpu = agent.allocatedResources.cpuPercent;
      this._resourcePool.usedMemoryMB -= (typeof mem === 'number' && Number.isFinite(mem) ? mem : 0);
      this._resourcePool.usedCpuPercent -= (typeof cpu === 'number' && Number.isFinite(cpu) ? cpu : 0);
      this._resourcePool.usedMemoryMB = Math.max(0, this._resourcePool.usedMemoryMB);
      this._resourcePool.usedCpuPercent = Math.max(0, this._resourcePool.usedCpuPercent);
      agent.allocatedResources = {};
    }
  }

  /**
   * 检查指定Agent的依赖是否满足。返回缺失和不可用的依赖列表。
   * @param {string} agentId - 待检查的Agent ID
   * @returns {{ satisfied: boolean, missing: string[], unavailable: Array<{ id: string, state: string }> }}
   * @throws {AgentError} 当Agent不存在时抛出AGENT_NOT_FOUND异常
   */
  checkDependencies(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);

    const missing = agent.dependencies.filter(depId => !this.agents.has(depId));
    const unavailable = agent.dependencies
      .filter(depId => {
        const dep = this.agents.get(depId);
        return dep && dep.state !== AGENT_STATES.RUNNING;
      })
      .map(depId => {
        const dep = this.agents.get(depId);
        return { id: depId, state: dep ? dep.state : 'unknown' };
      });

    return {
      satisfied: missing.length === 0 && unavailable.length === 0,
      missing,
      unavailable,
    };
  }

  /**
   * 设置Agent版本号。更新版本并触发version-changed事件。
   * @param {string} agentId - Agent ID
   * @param {string} version - 新版本号
   * @returns {Object} 更新后的Agent对象
   * @throws {AgentError} 当Agent不存在时抛出AGENT_NOT_FOUND异常
   */
  setVersion(agentId, version) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);
    agent.version = version;
    agent.lastActivityAt = new Date().toISOString();
    this._persist(agent);
    this.emit('version-changed', { agentId, version });
    return agent;
  }

  /**
   * 递增Agent任务计数。每次Agent执行任务时调用。
   * @param {string} agentId - Agent ID
   * @returns {number} 递增后的任务计数
   * @throws {AgentError} 当Agent不存在时抛出AGENT_NOT_FOUND异常
   */
  incrementTaskCount(agentId) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);
    agent.taskCount++;
    agent.lastActivityAt = new Date().toISOString();
    this._persist(agent);
    return agent.taskCount;
  }

  /**
   * 设置Agent错误信息。记录错误详情并更新Agent状态为ERROR。
   * @param {string} agentId - Agent ID
   * @param {Object} errorInfo - 错误信息对象
   * @param {string} [errorInfo.message] - 错误消息
   * @param {string} [errorInfo.code] - 错误代码
   * @param {string} [errorInfo.stack] - 错误堆栈
   * @returns {void}
   * @throws {AgentError} 当Agent不存在时抛出AGENT_NOT_FOUND异常
   */
  setError(agentId, errorInfo) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent ${agentId} not found`);
    const info = errorInfo && typeof errorInfo === 'object' ? errorInfo : { message: String(errorInfo ?? 'Unknown error') };
    agent.errorInfo = {
      message: info.message || 'Unknown error',
      code: info.code || 'UNKNOWN',
      stack: info.stack ?? null,
      timestamp: new Date().toISOString(),
    };
    agent.lastActivityAt = new Date().toISOString();
    this._persist(agent);
  }

  /**
   * Get a snapshot of the shared resource pool.
   * @returns {Object} Resource pool with totalMemoryMB, usedMemoryMB, totalCpuPercent, usedCpuPercent
   */
  getResourcePool() {
    return mergeConfig(this._resourcePool);
  }

  /**
   * List all registered agents, optionally filtered by state or version.
   * @param {Object} [filter] - Filter criteria
   * @param {string} [filter.state] - Filter by agent state
   * @param {string} [filter.version] - Filter by agent version
   * @returns {Object[]} Array of agent data objects
   */
  listAgents(filter) {
    const agents = Array.from(this.agents.values()).map(a => this.get(a.id));
    if (!filter) return agents;
    let result = agents;
    if (filter.state) result = result.filter(a => a.state === filter.state);
    if (filter.version) result = result.filter(a => a.version === filter.version);
    return result;
  }

  /**
   * Get aggregate statistics about agents and resource utilization.
   * @returns {Object} Stats with totalAgents, stateCounts, resourcePool, resourceUtilization
   */
  getStats() {
    const stateCounts = {};
    Object.values(AGENT_STATES).forEach(state => {
      stateCounts[state] = 0;
    });
    for (const agent of this.agents.values()) {
      stateCounts[agent.state] = (stateCounts[agent.state] ?? 0) + 1;
    }
    return {
      totalAgents: this.agents.size,
      stateCounts,
      resourcePool: mergeConfig(this._resourcePool),
      resourceUtilization: {
        memoryPercent: this._resourcePool.totalMemoryMB > 0 ? Math.round((this._resourcePool.usedMemoryMB / this._resourcePool.totalMemoryMB) * 100) : 0,
        cpuPercent: Math.round(this._resourcePool.usedCpuPercent),
      },
    };
  }

  _restoreAgents() {
    const agentsDir = this._agentsRuntimeDir;
    const entries = readJsonDirSync(agentsDir, { logLabel: 'AgentRuntime' });
    entries.forEach(({ data: agent }) => {
      const sanitized = sanitizeData(agent);
      if (sanitized.id) {
        if (sanitized.state === AGENT_STATES.RUNNING || sanitized.state === AGENT_STATES.INITIALIZING) {
          sanitized.state = AGENT_STATES.STOPPED;
          sanitized.stoppedAt = new Date().toISOString();
          sanitized.allocatedResources = {};
        }
        this.agents.set(sanitized.id, sanitized);
      }
    });
  }

  /**
   * Debounced persistence of an agent to disk.
   * @private
   * @param {Object} agent - The agent object to persist
   * @param {boolean} [immediate=false] - Whether to write immediately (bypass debounce)
   * @returns {void}
   */
  _persist(agent, immediate) {
    this._persistDebouncer.schedule(agent.id, () => this._writeToDisk(agent), immediate);
  }

  _writeToDisk(agent) {
    try {
      const filePath = path.join(this._agentsRuntimeDir, `${agent.id}.json`);
      writeAtomic(filePath, agent);
    } catch (err) {
      debug('AgentRuntime', '_writeToDisk', err);
      emitError(this, 'persist-error', err, { agentId: agent.id });
    }
  }

  async _deleteFromDiskWith(agentId, unlinkFn) {
    try {
      const filePath = path.join(this._agentsRuntimeDir, `${agentId}.json`);
      await unlinkFn(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        debug('AgentRuntime', '_deleteFromDisk', err);
        return false;
      }
    }
    return true;
  }

  /**
   * Synchronously delete an agent's persisted file from disk.
   * @private
   * @param {string} agentId - ID of the agent whose file to delete
   * @returns {void}
   */
  _deleteFromDisk(agentId) {
    return this._deleteFromDiskWith(agentId, (fp) => {
      try { fs.unlinkSync(fp); } catch (_e) { if (_e && _e.code !== 'ENOENT') debug('AgentRuntime', 'deleteFromDiskUnlink', _e && _e.message ? _e.message : String(_e)); }
    });
  }

  async _deleteFromDiskAsync(agentId) {
    return this._deleteFromDiskWith(agentId, (fp) => fs.promises.unlink(fp));
  }

  /**
   * Evict the oldest stopped or created agent to free capacity.
   * @private
   * @returns {boolean} true if an agent was evicted, false if no candidates available
   */
  _evictOldest() {
    const candidates = Array.from(this.agents.entries())
      .filter(([, agent]) => agent.state === AGENT_STATES.STOPPED || agent.state === AGENT_STATES.CREATED);
    if (candidates.length === 0) return false;
    const oldest = candidates.reduce((acc, [id, agent]) => {
      const time = new Date(agent.lastActivityAt ?? agent.createdAt).getTime();
      return Number.isFinite(time) && time < acc.time ? { id, time } : acc;
    }, { id: null, time: Infinity });
    if (!oldest.id && candidates.length > 0) {
      oldest.id = candidates[0][0];
    }
    const oldestId = oldest.id;
    if (oldestId) {
      const oldestAgent = this.agents.get(oldestId);
      const savedResources = oldestAgent && oldestAgent.allocatedResources ? { ...oldestAgent.allocatedResources } : null;
      let resourcesReleased = false;
      try {
        if (oldestAgent) {
          if (oldestAgent.allocatedResources && Object.keys(oldestAgent.allocatedResources).length > 0) {
            this._releaseResources(oldestAgent);
            resourcesReleased = true;
          }
          this.agents.delete(oldestId);
        }
        this._deleteFromDisk(oldestId);
      } catch (_e) {
        debug('AgentRuntime', '_evictOldest', 'Eviction failed: ' + (_e && _e.message ? _e.message : String(_e)));
        this.agents.delete(oldestId);
        if (savedResources && !resourcesReleased) {
          this._resourcePool.usedMemoryMB = Math.max(0, this._resourcePool.usedMemoryMB - (typeof savedResources.memoryMB === 'number' && Number.isFinite(savedResources.memoryMB) ? savedResources.memoryMB : 0));
          this._resourcePool.usedCpuPercent = Math.max(0, this._resourcePool.usedCpuPercent - (typeof savedResources.cpuPercent === 'number' && Number.isFinite(savedResources.cpuPercent) ? savedResources.cpuPercent : 0));
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Flush all pending agent persistence writes to disk immediately.
   * @returns {void}
   */
  flush() {
    this._persistDebouncer.flush((id) => {
      const agent = this.agents.get(id);
      return agent ? () => this._writeToDisk(agent) : null;
    });
  }

  /**
   * Attach a PromptBuilder instance for static/dynamic prompt construction.
   * @param {Object} promptBuilder - PromptBuilder instance
   * @returns {void}
   */
  attachPromptBuilder(promptBuilder) {
    this._promptBuilder = promptBuilder;
  }

  /**
   * Build a system prompt for the given agent using PromptBuilder with static/dynamic separation.
   * Falls back to a basic prompt if no PromptBuilder is attached.
   * @param {string} agentId - Agent identifier
   * @param {Object} [context] - Dynamic context for the suffix
   * @returns {{ systemPrompt: string, staticPrefix: string, dynamicSuffix: string, staticTokenCount: number, dynamicTokenCount: number, prefixHash: string }}
   * @throws {Error} 当指定agentId不存在时抛出
   */
  buildPrompt(agentId, context) {
    this.guardShutdown();
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', 'Agent ' + agentId + ' not found');
    if (this._promptBuilder) {
      return this._promptBuilder.buildSystemPrompt(agentId, context ?? {});
    }
    const basicPrompt = 'Agent: ' + agentId + '\nState: ' + agent.state + '\nVersion: ' + agent.version;
    return {
      systemPrompt: basicPrompt,
      staticPrefix: basicPrompt,
      dynamicSuffix: '',
      staticTokenCount: Math.ceil(basicPrompt.length / 4),
      dynamicTokenCount: 0,
      prefixHash: '',
    };
  }

  _onShutdown() {
    safeCall(function() {
      this.agents.forEach(agent => {
        if (agent.state === AGENT_STATES.RUNNING || agent.state === AGENT_STATES.INITIALIZING) {
          agent.state = AGENT_STATES.STOPPED;
          this._releaseResources(agent);
          this._persist(agent, true);
        }
      }, this);
    }.bind(this), 'AgentRuntime', 'shutdownAgents');
    this._resourcePool.usedMemoryMB = 0;
    this._resourcePool.usedCpuPercent = 0;
    safeCall(function() { this._modelLayer.shutdown(); }.bind(this), 'AgentRuntime', 'modelLayerShutdown');
    safeCall(function() { this._harnessLayer.shutdown(); }.bind(this), 'AgentRuntime', 'harnessLayerShutdown');
    safeCall(function() { this.flush(); }.bind(this), 'AgentRuntime', 'flush');
    this._transitionLocks.clear();
    if (this._persistDebouncer && typeof this._persistDebouncer.shutdown === 'function') {
      safeCall(function() { this._persistDebouncer.shutdown(); }.bind(this), 'AgentRuntime', 'persistDebouncerShutdown');
    }
    this.agents.clear();
    this.removeAllListeners();
  }
}

AgentRuntime.STATES = AGENT_STATES;
AgentRuntime.VALID_TRANSITIONS = VALID_TRANSITIONS;
AgentRuntime.DEFAULT_RESOURCE_LIMITS = DEFAULT_RESOURCE_LIMITS;
AgentRuntime.MAX_AGENTS = MAX_AGENTS;

module.exports = withShutdown(AgentRuntime);
