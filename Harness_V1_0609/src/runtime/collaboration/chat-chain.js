'use strict';

const { EventEmitter } = require('events');
const { generateId } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  ACTIVE: 'in_progress',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  BLOCKED: 'blocked',
};

const ATOMIC_TASK_CHAINS = {
  'brainstorming': [
    { taskId: 'explore-requirements', agent: 'team-lead', skill: 'brainstorming', description: '探索需求边界和约束', required: true },
    { taskId: 'validate-feasibility', agent: 'domain-analyst', skill: 'brainstorming', description: '验证技术可行性', required: true },
  ],
  'requirement-analysis': [
    { taskId: 'gather-requirements', agent: 'team-lead', skill: 'requirement-analysis', description: '收集和整理需求', required: true },
    { taskId: 'analyze-constraints', agent: 'domain-analyst', skill: 'requirement-analysis', description: '分析技术约束和依赖', required: true },
    { taskId: 'define-acceptance', agent: 'quality-assurance', skill: 'requirement-analysis', description: '定义验收标准', required: false },
  ],
  'architecture-design': [
    { taskId: 'design-architecture', agent: 'domain-analyst', skill: 'architecture-design', description: '设计系统架构', required: true },
    { taskId: 'review-architecture', agent: 'domain-analyst', skill: 'code-review', description: '审查架构设计', required: true, mode: 'pair-chat' },
    { taskId: 'define-interfaces', agent: 'domain-analyst', skill: 'architecture-design', description: '定义模块接口', required: true },
  ],
  'module-development': [
    { taskId: 'write-test-first', agent: 'task-worker', skill: 'tdd-implement', description: '编写测试用例 (RED)', required: true, tddPhase: 'RED' },
    { taskId: 'implement-feature', agent: 'task-worker', skill: 'tdd-implement', description: '实现功能代码 (GREEN)', required: true, tddPhase: 'GREEN', dependsOn: ['write-test-first'] },
    { taskId: 'pair-review-code', agent: 'domain-analyst', skill: 'code-review', description: '两两对话审查代码', required: true, mode: 'pair-chat', dependsOn: ['implement-feature'] },
    { taskId: 'refactor-if-needed', agent: 'task-worker', skill: 'refactor-code', description: '根据审查反馈重构 (REFACTOR)', required: false, tddPhase: 'REFACTOR', dependsOn: ['pair-review-code'], condition: 'review-feedback' },
    { taskId: 'security-check', agent: 'quality-assurance', skill: 'security-audit', description: '安全审计', required: true, dependsOn: ['implement-feature'] },
    { taskId: 'self-reflect', agent: 'task-worker', skill: 'verification-before-completion', description: '自反思验证', required: true, mode: 'self-reflection', dependsOn: ['security-check'] },
  ],
  'integration-testing': [
    { taskId: 'write-integration-tests', agent: 'quality-assurance', skill: 'integration-testing', description: '编写集成测试', required: true },
    { taskId: 'pair-debug-failures', agents: ['quality-assurance', 'task-worker'], skill: 'systematic-debugging', description: '两两对话协同调试', required: false, mode: 'pair-chat', condition: 'test-failures' },
    { taskId: 'regression-check', agent: 'quality-assurance', skill: 'verification-before-completion', description: '回归验证', required: true, dependsOn: ['write-integration-tests'] },
  ],
  'deployment': [
    { taskId: 'generate-docs', agent: 'technical-writer', skill: 'documentation', description: '生成项目文档', required: true },
    { taskId: 'auto-doc-gen', agent: 'technical-writer', skill: 'auto-doc-generation', description: '自动生成用户手册和依赖说明', required: true, dependsOn: ['generate-docs'] },
    { taskId: 'deploy', agent: 'devops-engineer', skill: 'deployment', description: '部署上线', required: true, dependsOn: ['generate-docs'] },
    { taskId: 'health-check', agent: 'devops-engineer', skill: 'verification-before-completion', description: '部署后健康检查', required: true, dependsOn: ['deploy'] },
  ],
};

/**
 * @module runtime/collaboration/chat-chain
 * @classdesc 链式对话。多Agent顺序处理、上下文传递、产物追踪与版本化
 * ChatChain — 链式对话编排器
 * 编排多Agent按预定义的原子任务链顺序处理，上下文在链中逐级传递和累积。
 * 内置六阶段原子任务链模板（brainstorming→requirement-analysis→architecture-design→
 * module-development→integration-testing→deployment），支持任务依赖解析、条件分支和TDD阶段标记。
 * 融合ChatDev阶段产物追踪：支持产物注册、版本化、跨阶段流转与溯源。
 * @extends EventEmitter
 * @emits ChatChain#chain-created
 * @emits ChatChain#task-completed
 * @emits ChatChain#chain-completed
 * @emits ChatChain#chain-failed
 * @emits ChatChain#artifact-registered
 * @emits ChatChain#artifact-versioned
 */
const MAX_ARTIFACTS_PER_CHAIN = 100;
const MAX_ARTIFACT_INDEX = 100;
const MAX_ANNOTATIONS_PER_CHAIN = 200;

class ChatChain extends EventEmitter {
  /**
   * 创建ChatChain实例
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxChains=100] - 最大链数量，超出时淘汰已完成的链
   */
  constructor(options) {
    super();
    this._options = options ?? {};
    this._chains = new Map();
    this._maxChains = (options && options.maxChains) ?? 100;
    this._stats = { totalChains: 0, completedChains: 0, failedChains: 0, totalTasks: 0, completedTasks: 0 };
    this._annotations = new Map();
  }

  /**
   * 创建链式任务链，基于阶段模板或自定义任务列表初始化任务序列
   * 自动解析任务依赖关系并标记阻塞状态，超出容量时淘汰已完成的链
   * @param {string} phase - 阶段名称，对应 ATOMIC_TASK_CHAINS 中的模板键
   * @param {Array<object>} [customTasks] - 自定义任务模板数组，提供时忽略阶段模板
   * @returns {{ chainId: string|null, phase: string, tasks: Array, nextTasks: Array, error?: string }} 创建结果
   * @example
   * const chain = new ChatChain();
   * const { chainId } = chain.createChain({ name: 'Development Pipeline' });
   * chain.addTask(chainId, { name: 'design', agent: 'analyst' });
   * chain.addTask(chainId, { name: 'implement', agent: 'worker', dependencies: ['design'] });
   * chain.registerArtifact(chainId, { name: 'design-doc', type: 'document', phase: 'design' });
   */
  createChain(phase, customTasks) {
    this.guardShutdown();
    if (!phase) {
      return { chainId: null, error: 'phase is required' };
    }

    const template = Array.isArray(customTasks) && customTasks.length > 0 ? customTasks : ATOMIC_TASK_CHAINS[phase];
    if (!template) {
      return { chainId: null, error: 'No task chain template for phase: ' + phase };
    }

    const chainId = generateId('chain-');
    const tasks = template.map(function(t, idx) {
      return {
        taskId: t.taskId,
        index: idx,
        agent: t.agent || (t.agents && t.agents.length > 0 ? t.agents[0] : null),
        agents: t.agents ?? null,
        skill: t.skill,
        description: t.description,
        required: t.required !== false,
        tddPhase: t.tddPhase ?? null,
        mode: t.mode ?? null,
        dependsOn: t.dependsOn ?? [],
        condition: t.condition ?? null,
        status: TASK_STATUS.PENDING,
        result: null,
        startedAt: null,
        completedAt: null,
      };
    });

    const chain = {
      chainId,
      phase,
      tasks,
      status: TASK_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      completedAt: null,
      artifacts: [],
      _artifactIndex: new Map(),
    };

    this._updateBlockedTasks(chain);

    if (this._chains.size >= this._maxChains) {
      let evictKey = null;
      for (const [k, c] of this._chains) {
        if (c.status === TASK_STATUS.COMPLETED || c.status === TASK_STATUS.FAILED) {
          evictKey = k;
          break;
        }
      }
      if (!evictKey && this._chains.size > 0) {
        evictKey = this._chains.keys().next().value;
      }
      if (evictKey) {
        this._annotations.delete(evictKey);
        this._chains.delete(evictKey);
      }
    }
    this._chains.set(chainId, chain);
    this._stats.totalChains++;
    this._stats.totalTasks += tasks.length;

    this.emit('chain-created', { chainId, phase, taskCount: tasks.length });

    return {
      chainId,
      phase,
      tasks: this._getTaskSummaries(chain),
      nextTasks: this._getNextTasks(chain),
    };
  }

  /**
   * 启动链中指定任务，将任务状态从 pending 转为 in_progress
   * 检查任务依赖是否已满足，被阻塞的任务无法启动
   * @param {string} chainId - 链ID
   * @param {string} taskId - 任务ID
   * @returns {{ taskId: string, status: string, agent: string, skill: string, mode: string|null, tddPhase: string|null, description: string } | { error: string }} 启动结果
   */
  startTask(chainId, taskId) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return { error: 'Chain not found' };

    const task = chain.tasks.find(t => t.taskId === taskId);
    if (!task) return { error: 'Task not found' };
    if (task.status !== TASK_STATUS.PENDING) return { error: 'Task is not pending, current: ' + task.status };

    const blocked = this._isTaskBlocked(chain, task, this._buildTaskIndex(chain));
    if (blocked) return { error: 'Task is blocked by uncompleted dependencies' };

    task.status = TASK_STATUS.IN_PROGRESS;
    task.startedAt = new Date().toISOString();

    this.emit('task-started', { chainId, taskId, agent: task.agent, skill: task.skill });

    return {
      taskId,
      status: task.status,
      agent: task.agent,
      skill: task.skill,
      mode: task.mode,
      tddPhase: task.tddPhase,
      description: task.description,
    };
  }

  /**
   * 完成链中指定任务，记录结果并更新阻塞状态
   * 当所有必需任务完成时自动标记整条链为已完成
   * @param {string} chainId - 链ID
   * @param {string} taskId - 任务ID
   * @param {object} [result] - 任务执行结果
   * @returns {{ taskId: string, status: string, chainStatus: string, nextTasks: Array } | { error: string }} 完成结果
   */
  completeTask(chainId, taskId, result) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return { error: 'Chain not found' };

    const task = chain.tasks.find(t => t.taskId === taskId);
    if (!task) return { error: 'Task not found' };
    if (task.status !== TASK_STATUS.IN_PROGRESS) return { error: 'Task is not in progress' };

    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = new Date().toISOString();
    task.result = result ?? {};

    this._stats.completedTasks++;
    this._updateBlockedTasks(chain);

    const requiredTasks = chain.tasks.filter(t => t.required);
    const chainComplete = requiredTasks.length > 0 && requiredTasks.every(t => t.status === TASK_STATUS.COMPLETED);
    if (chainComplete) {
      chain.status = TASK_STATUS.COMPLETED;
      chain.completedAt = new Date().toISOString();
      this._stats.completedChains++;
      this.emit('chain-completed', { chainId, phase: chain.phase, taskCount: chain.tasks.length });
    }

    this.emit('task-completed', { chainId, taskId, status: task.status });

    return {
      taskId,
      status: task.status,
      chainStatus: chain.status,
      nextTasks: this._getNextTasks(chain),
    };
  }

  /**
   * 标记链中指定任务为失败状态，非必需任务在重试次数内自动重置为待处理
   * 必需任务失败会导致整条链标记为失败
   * @param {string} chainId - 链ID
   * @param {string} taskId - 任务ID
   * @param {string} [error] - 失败原因描述
   * @returns {{ taskId: string, status: string, chainStatus: string } | { error: string }} 失败处理结果
   */
  failTask(chainId, taskId, error) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return { error: 'Chain not found' };

    const task = chain.tasks.find(t => t.taskId === taskId);
    if (!task) return { error: 'Task not found' };

    if (task.status !== TASK_STATUS.IN_PROGRESS && task.status !== TASK_STATUS.PENDING) {
      return { error: 'Task cannot be failed from current state: ' + task.status };
    }

    task.result = { error: error || 'Unknown error' };
    task._retryCount = (task._retryCount ?? 0) + 1;

    const MAX_RETRIES = 3;
    if (task._retryCount < MAX_RETRIES && !task.required) {
      task.status = TASK_STATUS.PENDING;
      this._updateBlockedTasks(chain);
      this.emit('chain-task-retry', { chainId, taskId, retryCount: task._retryCount, maxRetries: MAX_RETRIES });
    } else {
      task.status = TASK_STATUS.FAILED;
      this._updateBlockedTasks(chain);
      const requiredFailed = chain.tasks.some(t => t.required && t.status === TASK_STATUS.FAILED);
      if (requiredFailed) {
        chain.status = TASK_STATUS.FAILED;
        this._stats.failedChains++;
        this.emit('chain-failed', { chainId, phase: chain.phase, failedTask: taskId });
      }
    }

    this.emit('task-failed', { chainId, taskId, error });

    return { taskId, status: task.status, chainStatus: chain.status };
  }

  /**
   * 重试链中已失败的任务，将其状态重置为待处理
   * 最多重试3次，若链因该任务失败且重试后无其他必需任务失败，则恢复链状态
   * @param {string} chainId - 链ID
   * @param {string} taskId - 任务ID
   * @returns {{ taskId: string, status: string, chainStatus: string, retryCount: number } | { error: string }} 重试结果
   */
  retryTask(chainId, taskId) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return { error: 'Chain not found' };

    const task = chain.tasks.find(t => t.taskId === taskId);
    if (!task) return { error: 'Task not found' };
    if (task.status !== TASK_STATUS.FAILED) return { error: 'Task is not in FAILED state' };

    const MAX_RETRIES = 3;
    task._retryCount = (task._retryCount ?? 0) + 1;
    if (task._retryCount >= MAX_RETRIES) {
      return { error: 'Max retries exceeded', retryCount: task._retryCount };
    }

    const taskIndex = this._buildTaskIndex(chain);
    if (this._hasFailedDependency(chain, task, taskIndex)) {
      return { retried: false, taskId, reason: 'Dependency is still in FAILED state' };
    }

    task.status = TASK_STATUS.PENDING;
    task.result = null;
    this._updateBlockedTasks(chain);

    if (chain.status === TASK_STATUS.FAILED) {
      const requiredFailed = chain.tasks.some(t => t.required && t.status === TASK_STATUS.FAILED);
      if (!requiredFailed) {
        chain.status = TASK_STATUS.PENDING;
        this._stats.failedChains = Math.max(0, this._stats.failedChains - 1);
      }
    }

    this.emit('chain-task-retry', { chainId, taskId, retryCount: task._retryCount, maxRetries: MAX_RETRIES });
    return { taskId, status: task.status, chainStatus: chain.status, retryCount: task._retryCount };
  }

  /**
   * 跳过链中非必需任务，必需任务不允许跳过
   * @param {string} chainId - 链ID
   * @param {string} taskId - 任务ID
   * @param {string} [reason] - 跳过原因
   * @returns {{ taskId: string, status: string, nextTasks: Array } | { error: string }} 跳过结果
   */
  skipTask(chainId, taskId, reason) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return { error: 'Chain not found' };

    const task = chain.tasks.find(t => t.taskId === taskId);
    if (!task) return { error: 'Task not found' };
    if (task.required) return { error: 'Cannot skip required task' };

    task.status = TASK_STATUS.SKIPPED;
    task.result = { skipReason: reason || 'Not applicable' };
    this._updateBlockedTasks(chain);

    this.emit('task-skipped', { chainId, taskId, reason });

    return { taskId, status: task.status, nextTasks: this._getNextTasks(chain) };
  }

  /**
   * 在链中注册阶段产物，支持同名产物的自动版本化和父子谱系追踪
   * 融合ChatDev ChatChain工作流的阶段产物流转机制
   * @param {string} chainId - 链ID
   * @param {object} artifact - 产物定义
   * @param {string} artifact.name - 产物名称（同名产物自动递增版本号）
   * @param {string} artifact.type - 产物类型（document/code/specification等）
   * @param {string} [artifact.phase] - 所属阶段，默认为链当前阶段
   * @param {string} [artifact.taskId] - 关联任务ID
   * @param {*} [artifact.content] - 产物内容
   * @param {object} [artifact.metadata={}] - 产物元数据
   * @returns {{ artifactId: string, name: string, type: string, version: number, phase: string, parentArtifactId: string|null } | { error: string }} 注册结果
   */
  registerArtifact(chainId, artifact) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return { error: 'Chain not found' };
    if (!artifact || !artifact.name || !artifact.type) {
      return { error: 'artifact name and type are required' };
    }

    const artifactId = generateId('art-');
    const existingByName = chain._artifactIndex.get(artifact.name);
    const version = existingByName ? existingByName.version + 1 : 1;

    const entry = {
      artifactId,
      name: artifact.name,
      type: artifact.type,
      phase: artifact.phase || chain.phase,
      taskId: artifact.taskId ?? null,
      content: artifact.content ?? null,
      metadata: artifact.metadata ?? {},
      version,
      parentArtifactId: existingByName ? existingByName.artifactId : null,
      registeredAt: new Date().toISOString(),
    };

    if (chain.artifacts.length >= MAX_ARTIFACTS_PER_CHAIN) chain.artifacts.shift();
    chain.artifacts.push(entry);
    if (chain._artifactIndex.size >= MAX_ARTIFACT_INDEX) {
      const oldestKey = chain._artifactIndex.keys().next().value;
      chain._artifactIndex.delete(oldestKey);
    }
    chain._artifactIndex.set(artifact.name, entry);

    this.emit('artifact-registered', {
      chainId,
      artifactId,
      name: artifact.name,
      type: artifact.type,
      phase: entry.phase,
      version,
    });

    if (version > 1) {
      this.emit('artifact-versioned', {
        chainId,
        artifactId,
        name: artifact.name,
        version,
        parentArtifactId: entry.parentArtifactId,
      });
    }

    return {
      artifactId,
      name: artifact.name,
      type: artifact.type,
      version,
      phase: entry.phase,
      parentArtifactId: entry.parentArtifactId,
    };
  }

  /**
   * 获取指定链中指定阶段的产物列表
   * @param {string} chainId - 链ID
   * @param {string} phase - 阶段名称
   * @returns {Array<{artifactId: string, name: string, type: string, taskId: string|null, version: number, metadata: object, registeredAt: string}>|null} 产物列表，链不存在时返回null
   */
  getPhaseArtifacts(chainId, phase) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return null;

    return chain.artifacts
      .filter(function(a) { return a.phase === phase; })
      .map(function(a) {
        return {
          artifactId: a.artifactId,
          name: a.name,
          type: a.type,
          taskId: a.taskId,
          version: a.version,
          metadata: a.metadata,
          registeredAt: a.registeredAt,
        };
      });
  }

  /**
   * 获取指定链的跨阶段产物流转图，按阶段排序并包含版本谱系
   * @param {string} chainId - 链ID
   * @returns {{ chainId: string, totalArtifacts: number, phaseFlow: Array<{phase: string, artifacts: Array, artifactCount: number}>, lineage: Array<{from: string|null, fromPhase: string|null, to: string, toPhase: string, versionDelta: number}> }|null} 流转图，链不存在时返回null
   */
  getArtifactFlow(chainId) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return null;

    const phaseOrder = {};
    const phases = ['brainstorming', 'requirement-analysis', 'architecture-design', 'module-development', 'integration-testing', 'deployment'];
    for (let i = 0; i < phases.length; i++) {
      phaseOrder[phases[i]] = i;
    }

    const phaseArtifacts = {};
    for (const artifact of chain.artifacts) {
      if (!phaseArtifacts[artifact.phase]) {
        phaseArtifacts[artifact.phase] = [];
      }
      phaseArtifacts[artifact.phase].push({
        artifactId: artifact.artifactId,
        name: artifact.name,
        type: artifact.type,
        version: artifact.version,
        parentArtifactId: artifact.parentArtifactId,
      });
    }

    const flow = [];
    const sortedPhases = Object.keys(phaseArtifacts).sort(function(a, b) {
      return (phaseOrder[a] ?? 99) - (phaseOrder[b] ?? 99);
    });
    for (const phase of sortedPhases) {
      flow.push({
        phase,
        artifacts: phaseArtifacts[phase],
        artifactCount: phaseArtifacts[phase].length,
      });
    }

    const lineage = [];
    for (const artifact of chain.artifacts) {
      if (artifact.parentArtifactId) {
        const parent = chain.artifacts.find(function(a) { return a.artifactId === artifact.parentArtifactId; });
        lineage.push({
          from: parent ? parent.name : null,
          fromPhase: parent ? parent.phase : null,
          to: artifact.name,
          toPhase: artifact.phase,
          versionDelta: artifact.version - (parent ? parent.version : 0),
        });
      }
    }

    return {
      chainId,
      totalArtifacts: chain.artifacts.length,
      phaseFlow: flow,
      lineage,
    };
  }

  /**
   * 根据产物ID获取单个产物
   * @param {string} chainId - 链ID
   * @param {string} artifactId - 产物ID
   * @returns {object|null} 产物对象，不存在时返回null
   */
  getArtifact(chainId, artifactId) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return null;
    const artifact = chain.artifacts.find(function(a) { return a.artifactId === artifactId; });
    return artifact ? { ...artifact } : null;
  }

  /**
   * 根据产物名称获取最新版本产物
   * @param {string} chainId - 链ID
   * @param {string} name - 产物名称
   * @returns {object|null} 最新版本产物对象，不存在时返回null
   */
  getLatestArtifactByName(chainId, name) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return null;
    const artifact = chain._artifactIndex.get(name);
    return artifact ? { ...artifact } : null;
  }

  /**
   * 获取指定链的摘要信息，包含链ID、阶段、状态和任务列表
   * @param {string} chainId - 链ID
   * @returns {{ chainId: string, phase: string, status: string, tasks: Array, createdAt: string, completedAt: string|null }|null} 链摘要，不存在时返回null
   */
  getChain(chainId) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return null;
    return {
      chainId: chain.chainId,
      phase: chain.phase,
      status: chain.status,
      tasks: this._getTaskSummaries(chain),
      artifactCount: chain.artifacts.length,
      createdAt: chain.createdAt,
      completedAt: chain.completedAt,
    };
  }

  /**
   * 获取指定链的进度信息，包含总任务数、已完成数、必需任务进度和整体进度百分比
   * @param {string} chainId - 链ID
   * @returns {{ chainId: string, phase: string, status: string, totalTasks: number, completedTasks: number, requiredTasks: number, requiredCompleted: number, progress: number, requiredProgress: number }|null} 进度信息，不存在时返回null
   */
  getChainProgress(chainId) {
    this.guardShutdown();
    const chain = this._chains.get(chainId);
    if (!chain) return null;

    const total = chain.tasks.length;
    const completed = chain.tasks.reduce((c, t) => c + (t.status === TASK_STATUS.COMPLETED || t.status === TASK_STATUS.SKIPPED ? 1 : 0), 0);
    const required = chain.tasks.filter(t => t.required);
    const requiredCompleted = required.reduce((c, t) => c + (t.status === TASK_STATUS.COMPLETED ? 1 : 0), 0);

    return {
      chainId,
      phase: chain.phase,
      status: chain.status,
      totalTasks: total,
      completedTasks: completed,
      requiredTasks: required.length,
      requiredCompleted: requiredCompleted,
      progress: total > 0 ? completed / total : 0,
      requiredProgress: required.length > 0 ? requiredCompleted / required.length : 0,
    };
  }

  /**
   * 获取链式对话编排器的运行统计信息
   * @returns {{ totalChains: number, completedChains: number, failedChains: number, totalTasks: number, completedTasks: number, activeChains: number, taskCompletionRate: string|number, chainCompletionRate: string|number }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('ChatChain', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalChains: 0, completedChains: 0, failedChains: 0, totalTasks: 0, completedTasks: 0, activeChains: 0, taskCompletionRate: 0, chainCompletionRate: 0, totalArtifacts: 0 }; }
    let totalArtifacts = 0;
    for (const chain of this._chains.values()) {
      totalArtifacts += chain.artifacts.length;
    }
    return { ...this._stats,
      activeChains: this._chains.size,
      taskCompletionRate: this._stats.totalTasks > 0
        ? (this._stats.completedTasks / this._stats.totalTasks).toFixed(4)
        : 0,
      chainCompletionRate: this._stats.totalChains > 0
        ? (this._stats.completedChains / this._stats.totalChains).toFixed(4)
        : 0,
      totalArtifacts,
    };
  }

  _buildTaskIndex(chain) {
    const index = new Map();
    for (const t of chain.tasks) index.set(t.taskId, t);
    return index;
  }

  _getNextTasks(chain) {
    const taskIndex = this._buildTaskIndex(chain);
    return chain.tasks.filter(function(t) {
      if (t.status !== TASK_STATUS.PENDING) return false;
      return !t.dependsOn || t.dependsOn.every(function(depId) {
        const dep = taskIndex.get(depId);
        return dep && (dep.status === TASK_STATUS.COMPLETED || dep.status === TASK_STATUS.SKIPPED);
      });
    }).map(function(t) {
      return { taskId: t.taskId, agent: t.agent, skill: t.skill, description: t.description, mode: t.mode };
    });
  }

  _isTaskBlocked(chain, task, taskIndex) {
    if (!task.dependsOn || task.dependsOn.length === 0) return false;
    return task.dependsOn.some(function(depId) {
      const dep = taskIndex.get(depId);
      return !dep || (dep.status !== TASK_STATUS.COMPLETED && dep.status !== TASK_STATUS.SKIPPED);
    });
  }

  _hasFailedDependency(chain, task, taskIndex) {
    if (!task.dependsOn || task.dependsOn.length === 0) return false;
    return task.dependsOn.some(function(depId) {
      const dep = taskIndex.get(depId);
      return dep && dep.status === TASK_STATUS.FAILED;
    });
  }

  _updateBlockedTasks(chain) {
    const taskIndex = this._buildTaskIndex(chain);
    chain.tasks.forEach(function(t) {
      if (t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.BLOCKED) {
        if (this._hasFailedDependency(chain, t, taskIndex)) {
          t.status = TASK_STATUS.FAILED;
          t.result = t.result || { error: 'Dependency failed' };
          this.emit('task-failed', { chainId: chain.chainId, taskId: t.taskId, error: 'Dependency failed', cascaded: true });
        } else if (t.status === TASK_STATUS.PENDING && this._isTaskBlocked(chain, t, taskIndex)) {
          t.status = TASK_STATUS.BLOCKED;
        } else if (t.status === TASK_STATUS.BLOCKED && !this._isTaskBlocked(chain, t, taskIndex)) {
          t.status = TASK_STATUS.PENDING;
        }
      }
    }.bind(this));
  }

  _getTaskSummaries(chain) {
    return chain.tasks.map(function(t) {
      return {
        taskId: t.taskId,
        agent: t.agent,
        skill: t.skill,
        description: t.description,
        required: t.required,
        tddPhase: t.tddPhase,
        mode: t.mode,
        dependsOn: t.dependsOn,
        condition: t.condition,
        status: t.status,
      };
    });
  }

  /**
   * 向指定链添加人工标注，支持对特定任务/行的审查意见、缺陷标注、优化建议等
   * @param {string} chainId - 链ID
   * @param {object} annotation - 标注定义
   * @param {string} [annotation.taskId] - 关联任务ID
   * @param {number} [annotation.line] - 关联行号
   * @param {string} [annotation.file] - 关联文件路径
   * @param {string} annotation.type - 标注类型：review/bug/optimization/question/suggestion
   * @param {string} annotation.message - 标注消息内容
   * @param {string} annotation.author - 标注作者
   * @returns {{ annotation: object } | { error: string }} 标注结果
   */
  addAnnotation(chainId, annotation) {
    this.guardShutdown();
    if (!chainId) return { error: 'chainId is required' };
    if (!annotation || !annotation.type || !annotation.message || !annotation.author) {
      return { error: 'annotation type, message, and author are required' };
    }
    const validTypes = ['review', 'bug', 'optimization', 'question', 'suggestion'];
    if (!validTypes.includes(annotation.type)) {
      return { error: 'Invalid annotation type: ' + annotation.type + '. Must be one of: ' + validTypes.join(', ') };
    }

    if (!this._annotations.has(chainId)) {
      this._annotations.set(chainId, new Map());
    }
    const chainAnnotations = this._annotations.get(chainId);

    const id = generateId('annot-');
    const entry = {
      id,
      chainId,
      taskId: annotation.taskId ?? null,
      line: annotation.line ?? null,
      file: annotation.file ?? null,
      type: annotation.type,
      message: annotation.message,
      author: annotation.author,
      status: 'open',
      response: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };

    if (chainAnnotations.size >= MAX_ANNOTATIONS_PER_CHAIN) {
      const oldestKey = chainAnnotations.keys().next().value;
      chainAnnotations.delete(oldestKey);
    }
    chainAnnotations.set(id, entry);
    this.emit('annotation-added', entry);

    return { annotation: entry };
  }

  /**
   * 查询指定链的标注，支持按任务ID、类型和解决状态过滤
   * @param {string} chainId - 链ID
   * @param {object} [filters] - 过滤条件
   * @param {string} [filters.taskId] - 按任务ID过滤
   * @param {string} [filters.type] - 按标注类型过滤
   * @param {boolean} [filters.unresolved] - 仅返回未解决的标注
   * @returns {Array<object>} 匹配的标注数组
   */
  getAnnotations(chainId, filters) {
    this.guardShutdown();
    const chainAnnotations = this._annotations.get(chainId);
    if (!chainAnnotations) return [];

    const result = [];
    for (const annotation of chainAnnotations.values()) {
      if (filters) {
        if (filters.taskId !== undefined && annotation.taskId !== filters.taskId) continue;
        if (filters.type !== undefined && annotation.type !== filters.type) continue;
        if (filters.unresolved === true && annotation.status === 'resolved') continue;
      }
      result.push({ ...annotation });
    }
    return result;
  }

  /**
   * 将标注标记为已解决
   * @param {string} chainId - 链ID
   * @param {string} annotationId - 标注ID
   * @param {string} [resolution] - 解决说明
   * @returns {{ annotation: object } | { error: string }} 更新结果
   */
  resolveAnnotation(chainId, annotationId, resolution) {
    this.guardShutdown();
    const chainAnnotations = this._annotations.get(chainId);
    if (!chainAnnotations) return { error: 'Chain not found or has no annotations' };

    const annotation = chainAnnotations.get(annotationId);
    if (!annotation) return { error: 'Annotation not found: ' + annotationId };
    if (annotation.status === 'resolved') return { error: 'Annotation is already resolved' };

    annotation.status = 'resolved';
    annotation.resolvedAt = new Date().toISOString();
    annotation.resolution = resolution || '';

    this.emit('annotation-resolved', annotation);

    return { annotation };
  }

  /**
   * AI对标注的回复，将响应内容记录到标注中
   * @param {string} chainId - 链ID
   * @param {string} annotationId - 标注ID
   * @param {string} response - AI响应内容
   * @returns {{ annotation: object } | { error: string }} 更新结果
   */
  respondToAnnotation(chainId, annotationId, response) {
    this.guardShutdown();
    const chainAnnotations = this._annotations.get(chainId);
    if (!chainAnnotations) return { error: 'Chain not found or has no annotations' };

    const annotation = chainAnnotations.get(annotationId);
    if (!annotation) return { error: 'Annotation not found: ' + annotationId };

    annotation.response = response;

    this.emit('annotation-responded', annotation);

    return { annotation };
  }

  /**
   * 获取指定链的标注摘要，包含总数、解决/未解决数、按类型和按任务的分布
   * @param {string} chainId - 链ID
   * @returns {{ total: number, resolved: number, unresolved: number, byType: object, byTask: object }|null} 标注摘要，链不存在时返回null
   */
  getAnnotationSummary(chainId) {
    this.guardShutdown();
    const chainAnnotations = this._annotations.get(chainId);
    if (!chainAnnotations) return null;

    let total = 0;
    let resolved = 0;
    let unresolved = 0;
    const byType = {};
    const byTask = {};

    for (const annotation of chainAnnotations.values()) {
      total++;
      if (annotation.status === 'resolved') resolved++;
      else unresolved++;

      const typeKey = annotation.type;
      byType[typeKey] = (byType[typeKey] ?? 0) + 1;

      const taskKey = annotation.taskId || '(none)';
      byTask[taskKey] = (byTask[taskKey] ?? 0) + 1;
    }

    return { total, resolved, unresolved, byType, byTask };
  }

  _onShutdown() {
    this._chains.clear();
    this._annotations.clear();
    this._stats = { totalChains: 0, completedChains: 0, failedChains: 0, totalTasks: 0, completedTasks: 0 };
    this.removeAllListeners();
  }
}

ChatChain = withShutdown(ChatChain);

ChatChain.TASK_STATUS = TASK_STATUS;
ChatChain.ATOMIC_TASK_CHAINS = ATOMIC_TASK_CHAINS;

module.exports = ChatChain;
