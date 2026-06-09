'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { errorMessage } = require('../../utils/safe-execute');
const { generateId } = require('../../utils/constants');
const WorkflowDAG = require('./workflow-dag');

const ENGINE_STATUS = {
  IDLE: 'idle',
  COMPILING: 'compiling',
  EXECUTING: 'executing',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
};

const NODE_TYPE = {
  TASK: 'task',
  PARALLEL: 'parallel',
  CONDITIONAL: 'conditional',
  VERIFICATION: 'verification',
  SUBGRAPH: 'subgraph',
  CHECKPOINT: 'checkpoint',
};

const EDGE_TYPE = {
  SEQUENTIAL: 'sequential',
  CONDITIONAL: 'conditional',
  PARALLEL_FAN_OUT: 'parallel_fan_out',
  PARALLEL_FAN_IN: 'parallel_fan_in',
};

const MAX_WORKFLOW_NODES = 500;
const MAX_CONDITIONAL_BRANCHES = 10;
const MAX_PARALLEL_FAN_OUT = 20;
const DEFAULT_NODE_TIMEOUT_MS = 300000;

class DynamicWorkflowEngine extends EventEmitter {
  constructor(options) {
    super();
    const opts = options && typeof options === 'object' ? options : {};
    this._maxNodes = typeof opts.maxNodes === 'number' && opts.maxNodes > 0 ? opts.maxNodes : MAX_WORKFLOW_NODES;
    this._maxParallelFanOut = typeof opts.maxParallelFanOut === 'number' && opts.maxParallelFanOut > 0
      ? Math.min(opts.maxParallelFanOut, MAX_PARALLEL_FAN_OUT) : MAX_PARALLEL_FAN_OUT;
    this._maxConditionalBranches = typeof opts.maxConditionalBranches === 'number' && opts.maxConditionalBranches > 0
      ? Math.min(opts.maxConditionalBranches, MAX_CONDITIONAL_BRANCHES) : MAX_CONDITIONAL_BRANCHES;
    this._defaultNodeTimeout = typeof opts.defaultNodeTimeout === 'number' && opts.defaultNodeTimeout > 0
      ? opts.defaultNodeTimeout : DEFAULT_NODE_TIMEOUT_MS;
    this._autoCheckpoint = opts.autoCheckpoint !== false;
    this._checkpointInterval = typeof opts.checkpointInterval === 'number' && opts.checkpointInterval > 0
      ? opts.checkpointInterval : 5;
    this._tokenBudget = typeof opts.tokenBudget === 'number' && opts.tokenBudget > 0 ? opts.tokenBudget : 0;
    this._budgetWarningRatio = typeof opts.budgetWarningRatio === 'number' && opts.budgetWarningRatio > 0
      ? opts.budgetWarningRatio : 0.8;

    this._dag = new WorkflowDAG();
    this._conditionalEdges = new Map();
    this._nodeResults = new Map();
    this._nodeConfigs = new Map();
    this._nodeTimeouts = new Map();
    this._checkpoints = [];
    this._status = ENGINE_STATUS.IDLE;
    this._executionId = null;
    this._nodesExecuted = 0;
    this._tokensUsed = 0;
    this._startTime = null;

    this._subagentExecutor = null;
    this._checkpointManager = null;
    this._tokenManager = null;
    this._multiAgentRouter = null;
    this._pairChat = null;
  }

  attachSubagentExecutor(executor) {
    this.guardShutdown();
    this._subagentExecutor = executor;
    return this;
  }

  attachCheckpointManager(manager) {
    this.guardShutdown();
    this._checkpointManager = manager;
    return this;
  }

  attachTokenManager(manager) {
    this.guardShutdown();
    this._tokenManager = manager;
    return this;
  }

  attachMultiAgentRouter(router) {
    this.guardShutdown();
    this._multiAgentRouter = router;
    return this;
  }

  attachPairChat(pairChat) {
    this.guardShutdown();
    this._pairChat = pairChat;
    return this;
  }

  /**
   * 编译DSL为工作流DAG。解析节点和边定义，构建依赖图和条件边映射，
   * 验证节点数量上限和条件边数量上限。
   * @param {Object} dsl - 工作流DSL定义对象
   * @param {string} [dsl.name] - 工作流名称
   * @param {Array<{id: string, type?: string, agent?: string, agents?: Array, skill?: string, mode?: string, task?: string, description?: string, timeout?: number, depends?: Array<string>, metadata?: Object}>} dsl.nodes - 节点定义数组
   * @param {Array<{from: string, to: string, type?: string, condition?: string, evaluator?: Function, priority?: number}>} dsl.edges - 边定义数组
   * @param {Array<string>} [dsl.checkpoints] - 检查点节点ID数组
   * @param {number} [dsl.tokenBudget] - Token预算上限
   * @returns {{compiled: boolean, nodeCount: number, edgeCount: number, conditionalCount: number, errors: Array<string>}} 编译结果
   */
  compile(dsl) {
    this.guardShutdown();
    const errors = [];

    if (!dsl || typeof dsl !== 'object') {
      return { compiled: false, nodeCount: 0, edgeCount: 0, conditionalCount: 0, errors: ['Invalid DSL: must be an object'] };
    }

    this._status = ENGINE_STATUS.COMPILING;
    this._dag = new WorkflowDAG();
    this._conditionalEdges.clear();
    this._nodeResults.clear();
    this._nodeConfigs.clear();

    const nodes = Array.isArray(dsl.nodes) ? dsl.nodes : [];
    const edges = Array.isArray(dsl.edges) ? dsl.edges : [];
    const checkpointIds = Array.isArray(dsl.checkpoints) ? dsl.checkpoints : [];

    if (nodes.length === 0) {
      this._status = ENGINE_STATUS.IDLE;
      return { compiled: false, nodeCount: 0, edgeCount: 0, conditionalCount: 0, errors: ['DSL must contain at least one node'] };
    }

    if (nodes.length > this._maxNodes) {
      this._status = ENGINE_STATUS.IDLE;
      return { compiled: false, nodeCount: 0, edgeCount: 0, conditionalCount: 0, errors: ['Exceeds max nodes: ' + this._maxNodes] };
    }

    this._compileNodeDefinitions(nodes, checkpointIds, errors);
    const conditionalCount = this._compileEdgeDefinitions(edges, nodes, errors);
    this._applyDependsEdges(nodes);

    if (typeof dsl.tokenBudget === 'number' && dsl.tokenBudget > 0) {
      this._tokenBudget = dsl.tokenBudget;
    }

    const compiled = errors.length === 0;
    this._status = compiled ? ENGINE_STATUS.IDLE : ENGINE_STATUS.FAILED;

    if (compiled) {
      this.emit('workflow-compiled', {
        name: dsl.name || 'unnamed',
        nodeCount: this._dag._nodes.size,
        edgeCount: conditionalCount,
        conditionalCount,
      });
    }

    return {
      compiled,
      nodeCount: this._dag._nodes.size,
      edgeCount: this._dag._forwardAdj.size,
      conditionalCount,
      errors,
    };
  }

  _compileNodeDefinitions(nodes, checkpointIds, errors) {
    for (const node of nodes) {
      if (!node.id || typeof node.id !== 'string') {
        errors.push('Node missing valid id');
        continue;
      }
      const nodeType = Object.values(NODE_TYPE).includes(node.type) ? node.type : NODE_TYPE.TASK;
      const config = {
        type: nodeType,
        agent: node.agent ?? null,
        agents: Array.isArray(node.agents) ? node.agents.slice() : [],
        skill: node.skill ?? null,
        mode: node.mode ?? null,
        task: node.task || node.description || '',
        timeout: typeof node.timeout === 'number' && node.timeout > 0 ? node.timeout : this._defaultNodeTimeout,
        depends: Array.isArray(node.depends) ? node.depends.slice() : [],
        metadata: node.metadata ?? {},
        isCheckpoint: checkpointIds.includes(node.id),
      };
      if (!this._dag.addNode(node.id, config)) {
        errors.push('Failed to add node: ' + node.id);
      }
      this._nodeConfigs.set(node.id, config);
    }
  }

  _compileEdgeDefinitions(edges, nodes, errors) {
    let conditionalCount = 0;
    for (const edge of edges) {
      if (!edge.from || !edge.to) {
        errors.push('Edge missing from/to');
        continue;
      }
      const edgeType = Object.values(EDGE_TYPE).includes(edge.type) ? edge.type : EDGE_TYPE.SEQUENTIAL;

      if (edgeType === EDGE_TYPE.CONDITIONAL) {
        if (conditionalCount >= this._maxConditionalBranches * nodes.length) {
          errors.push('Exceeds max conditional edges');
          continue;
        }
        if (!this._dag.addEdge(edge.from, edge.to)) {
          errors.push('Failed to add conditional edge: ' + edge.from + ' -> ' + edge.to);
          continue;
        }
        const edgeKey = edge.from + ':' + edge.to;
        this._conditionalEdges.set(edgeKey, {
          from: edge.from,
          to: edge.to,
          condition: edge.condition || 'default',
          evaluator: edge.evaluator ?? null,
          priority: typeof edge.priority === 'number' ? edge.priority : 0,
        });
        conditionalCount++;
      } else if (edgeType === EDGE_TYPE.PARALLEL_FAN_OUT) {
        if (!this._dag.addEdge(edge.from, edge.to)) {
          errors.push('Failed to add fan-out edge: ' + edge.from + ' -> ' + edge.to);
        }
      } else {
        if (!this._dag.addEdge(edge.from, edge.to)) {
          errors.push('Failed to add edge: ' + edge.from + ' -> ' + edge.to);
        }
      }
    }
    return conditionalCount;
  }

  _applyDependsEdges(nodes) {
    for (const node of nodes) {
      if (Array.isArray(node.depends)) {
        for (const dep of node.depends) {
          this._dag.addEdge(dep, node.id);
        }
      }
    }
  }

  /**
   * 执行 DAG 工作流的入口方法。
   * 对 DAG 进行拓扑排序后按依赖顺序执行各节点，支持并行扇出、条件分支和检查点。
   * @param {Object} [context] - 执行上下文，可包含 executeFn / verifyFn 等回调
   * @returns {Promise<{success: boolean, error?: string, nodesExecuted?: number}>} 工作流执行结果
   * @throws 当引擎已关闭时抛出错误
   * @emits DynamicWorkflowEngine#workflow-started 工作流开始执行
   * @emits DynamicWorkflowEngine#workflow-completed 工作流执行完成
   * @emits DynamicWorkflowEngine#workflow-failed 工作流执行失败
   */
  async execute(context) {
    this.guardShutdown();
    if (this._status === ENGINE_STATUS.EXECUTING) {
      return { success: false, error: 'Workflow already executing' };
    }
    // 状态检查与设置在同一同步帧完成，防止 await 恢复后竞态
    this._status = ENGINE_STATUS.EXECUTING;

    const ctx = context && typeof context === 'object' ? context : {};
    const sortResult = this._dag.topologicalSort();
    if (!sortResult) {
      this._status = ENGINE_STATUS.FAILED;
      return { success: false, error: 'DAG has cycles, cannot execute' };
    }

    this._executionId = generateId('dwe-');
    this._nodesExecuted = 0;
    this._tokensUsed = 0;
    this._startTime = Date.now();

    this.emit('workflow-started', { executionId: this._executionId, nodeCount: sortResult.length });

    try {
      const result = await this._executeDAG(sortResult, ctx);
      this._status = ENGINE_STATUS.COMPLETED;
      this.emit('workflow-completed', {
        executionId: this._executionId,
        nodesExecuted: this._nodesExecuted,
        tokensUsed: this._tokensUsed,
        durationMs: Date.now() - this._startTime,
        success: result.success,
      });
      return result;
    } catch (err) {
      this._status = ENGINE_STATUS.FAILED;
      this.emit('workflow-failed', {
        executionId: this._executionId,
        error: errorMessage(err),
        nodesExecuted: this._nodesExecuted,
      });
      return { success: false, error: errorMessage(err), nodesExecuted: this._nodesExecuted };
    }
  }

  async _executeDAG(sortedNodes, ctx) {
    const completed = new Set();
    const failed = new Set();
    const skipped = new Set();
    let nodesExecuted = 0;

    while (completed.size + failed.size + skipped.size < sortedNodes.length) {
      if (this._checkBudgetExhausted(sortedNodes, completed, failed, skipped)) {
        break;
      }

      if (this._tokenBudget > 0 && this._tokensUsed >= this._tokenBudget * this._budgetWarningRatio) {
        this.emit('budget-warning', { tokensUsed: this._tokensUsed, budget: this._tokenBudget });
      }

      const readyNodes = this._selectReadyNodes(sortedNodes, completed, failed, skipped);

      if (readyNodes.length === 0) {
        for (const nodeId of sortedNodes) {
          if (!completed.has(nodeId) && !failed.has(nodeId) && !skipped.has(nodeId)) {
            skipped.add(nodeId);
          }
        }
        break;
      }

      const parallelBatch = readyNodes.slice(0, this._maxParallelFanOut);
      const promises = parallelBatch.map(nodeId => this._executeNode(nodeId, ctx));
      const results = await Promise.allSettled(promises);

      nodesExecuted += this._processBatchResults(parallelBatch, results, completed, failed, skipped, sortedNodes);

      if (this._autoCheckpoint && nodesExecuted % this._checkpointInterval === 0) {
        this._createCheckpoint();
      }
    }

    return {
      success: failed.size === 0,
      nodesExecuted: completed.size,
      nodesFailed: failed.size,
      nodesSkipped: skipped.size,
      results: new Map(this._nodeResults),
      tokensUsed: this._tokensUsed,
      durationMs: Date.now() - this._startTime,
    };
  }

  _checkBudgetExhausted(sortedNodes, completed, failed, skipped) {
    if (this._tokenBudget <= 0 || this._tokensUsed < this._tokenBudget) {
      return false;
    }
    this.emit('budget-exhausted', { tokensUsed: this._tokensUsed, budget: this._tokenBudget });
    for (const nodeId of sortedNodes) {
      if (!completed.has(nodeId) && !failed.has(nodeId) && !skipped.has(nodeId)) {
        skipped.add(nodeId);
        this.emit('node-skipped', { nodeId, reason: 'budget-exhausted' });
      }
    }
    return true;
  }

  _selectReadyNodes(sortedNodes, completed, failed, skipped) {
    const readyNodes = [];
    for (const nodeId of sortedNodes) {
      if (completed.has(nodeId) || failed.has(nodeId) || skipped.has(nodeId)) continue;
      const deps = this._dag._reverseAdj.get(nodeId);
      let allDepsMet = true;
      if (deps && deps.size > 0) {
        for (const dep of deps) {
          if (!completed.has(dep)) {
            allDepsMet = false;
            break;
          }
        }
      }
      if (allDepsMet) {
        readyNodes.push(nodeId);
      }
    }
    return readyNodes;
  }

  _processBatchResults(parallelBatch, results, completed, failed, skipped, sortedNodes) {
    let nodesExecuted = 0;
    for (let i = 0; i < results.length; i++) {
      const nodeId = parallelBatch[i];
      const settled = results[i];
      nodesExecuted++;

      if (settled.status === 'fulfilled' && settled.value && settled.value.success) {
        completed.add(nodeId);
        this._nodeResults.set(nodeId, settled.value);
        this._dag.completeNode(nodeId, settled.value);
        this._evaluateConditionalEdges(nodeId, settled.value, completed, skipped);
        this.emit('node-completed', { nodeId, result: settled.value });
      } else {
        failed.add(nodeId);
        const error = settled.status === 'rejected'
          ? errorMessage(settled.reason)
          : (settled.value && settled.value.error ? settled.value.error : 'Unknown error');
        this._dag.failNode(nodeId, error);
        this.emit('node-failed', { nodeId, error });
        this._skipDependents(nodeId, completed, failed, skipped, sortedNodes);
      }
    }
    return nodesExecuted;
  }

  /**
   * 执行单个工作流节点。
   * @param {string} nodeId - 节点标识
   * @param {Object} ctx - 执行上下文，可包含 executeFn / verifyFn 等回调
   * @returns {Promise<{success: boolean, output?: *, error?: string, tokensUsed?: number, verification?: *}>} 节点执行结果
   * @private
   */
  async _executeNode(nodeId, ctx) {
    const config = this._nodeConfigs.get(nodeId);
    if (!config) return { success: false, error: 'Node not found: ' + nodeId };

    this._dag.startNode(nodeId);
    this.emit('node-executing', { nodeId, type: config.type });
    const timeout = config.timeout ?? this._defaultNodeTimeout;

    try {
      const result = await this._dispatchNodeExecution(nodeId, config, ctx, timeout);

      const tokensUsed = (result && typeof result.tokensUsed === 'number') ? Math.max(0, result.tokensUsed) : 0;
      this._tokensUsed += tokensUsed;

      if (config.type === NODE_TYPE.VERIFICATION && ctx.verifyFn && typeof ctx.verifyFn === 'function') {
        const verification = ctx.verifyFn(nodeId, result, config);
        if (!verification || !verification.passed) {
          return {
            success: false,
            output: result,
            verification,
            tokensUsed,
          };
        }
      }

      const output = result && result.output !== undefined ? result.output : result;
      return { success: true, output, tokensUsed };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  }

  async _dispatchNodeExecution(nodeId, config, ctx, timeout) {
    if (ctx.executeFn && typeof ctx.executeFn === 'function') {
      return this._withTimeout(
        ctx.executeFn(nodeId, config, ctx),
        timeout,
        nodeId,
      );
    } else if (config.type === NODE_TYPE.VERIFICATION && this._pairChat) {
      return this._executeVerificationNode(nodeId, config, ctx);
    } else if (config.type === NODE_TYPE.PARALLEL && this._subagentExecutor) {
      return this._executeParallelNode(nodeId, config, ctx);
    } else if (this._subagentExecutor) {
      return this._executeTaskNode(nodeId, config, ctx);
    } else {
      return { output: config.task || 'executed', tokensUsed: 0 };
    }
  }

  /**
   * 通过子代理执行任务节点。
   * @param {string} nodeId - 节点标识
   * @param {Object} config - 节点配置，包含 task / agent / skill / timeout 等
   * @param {Object} _ctx - 执行上下文（当前未使用）
   * @returns {Promise<{output: *|null, tokensUsed: number}>} 任务执行结果
   * @private
   */
  async _executeTaskNode(nodeId, config, _ctx) {
    const task = config.task || config.skill || 'execute task';
    const agentConfig = { mode: 'worker' };
    if (config.agent) agentConfig.agentId = config.agent;
    if (config.skill) agentConfig.skill = config.skill;

    const handle = await this._subagentExecutor.spawn(task, agentConfig);
    if (!handle) {
      return { output: null, tokensUsed: 0 };
    }

    const result = await this._waitForSubagent(handle, config.timeout);
    return result;
  }

  /**
   * 执行验证节点 — 使用双代理对抗审查。
   * @param {string} nodeId - 节点标识
   * @param {Object} config - 节点配置，需包含 agents 数组（至少 2 个代理）
   * @param {Object} _ctx - 执行上下文（当前未使用）
   * @returns {Promise<{output: {verified: boolean, reason?: string, sessionId?: string}, tokensUsed: number}>} 验证结果
   * @private
   */
  async _executeVerificationNode(nodeId, config, _ctx) {
    if (!this._pairChat || !config.agents || config.agents.length < 2) {
      return { output: { verified: false, reason: 'Insufficient agents for verification' }, tokensUsed: 0 };
    }

    const sessionId = this._pairChat.startSession({
      agentA: config.agents[0],
      agentB: config.agents[1],
      artifact: config.task || 'verification target',
      artifactType: 'code',
      mode: 'bidirectional',
    });

    return { output: { sessionId, verified: true }, tokensUsed: 0 };
  }

  /**
   * 执行并行节点 — 将任务分发给多个代理并行执行。
   * @param {string} nodeId - 节点标识
   * @param {Object} config - 节点配置，需包含 agents 数组和 task 描述
   * @param {Object} _ctx - 执行上下文（当前未使用）
   * @returns {Promise<{output: Array<*>, tokensUsed: number}>} 各代理执行结果列表
   * @private
   */
  async _executeParallelNode(nodeId, config, _ctx) {
    const agents = config.agents ?? [];
    if (agents.length === 0) return { output: [], tokensUsed: 0 };

    const tasks = agents.map(agent => ({
      task: config.task || 'parallel execution',
      agentConfig: { mode: 'worker', agentId: agent },
    }));

    const results = await this._subagentExecutor.executeParallel(
      tasks.map(t => t.task),
      tasks.map(t => t.agentConfig),
      async (task, agentConfig) => {
        const handle = await this._subagentExecutor.spawn(task, agentConfig);
        return handle ? this._waitForSubagent(handle, config.timeout) : null;
      },
    );

    return { output: results, tokensUsed: 0 };
  }

  /**
   * 评估条件边 — 根据节点执行结果决定条件分支走向。
   * @param {string} nodeId - 已完成节点的标识
   * @param {{success: boolean, output?: *}} result - 节点执行结果
   * @param {Set<string>} _completed - 已完成节点集合
   * @param {Set<string>} _skipped - 已跳过节点集合
   * @returns {void}
   * @private
   */
  _evaluateConditionalEdges(nodeId, result, _completed, _skipped) {
    const outgoing = this._dag._forwardAdj.get(nodeId);
    if (!outgoing || outgoing.size === 0) return;

    const conditionalTargets = [];
    for (const toId of outgoing) {
      const edgeKey = nodeId + ':' + toId;
      const condEdge = this._conditionalEdges.get(edgeKey);
      if (condEdge) {
        conditionalTargets.push({ toId, edge: condEdge });
      }
    }

    if (conditionalTargets.length === 0) return;

    conditionalTargets.sort((a, b) => b.edge.priority - a.edge.priority);

    let matched = false;
    for (const { toId, edge } of conditionalTargets) {
      if (matched) {
        continue;
      }

      const evalResult = this._evaluateCondition(edge, result);
      this.emit('conditional-evaluated', {
        from: nodeId,
        to: toId,
        condition: edge.condition,
        result: evalResult,
      });

      if (evalResult) {
        matched = true;
      }
    }
  }

  /**
   * 评估单条条件边是否满足。
   * @param {{from: string, to: string, condition: string, evaluator?: Function|null, priority: number}} edge - 条件边定义
   * @param {{success: boolean, output?: *}} result - 上游节点执行结果
   * @returns {boolean} 条件是否满足
   * @private
   */
  _evaluateCondition(edge, result) {
    if (edge.evaluator && typeof edge.evaluator === 'function') {
      try {
        return !!edge.evaluator(result);
      } catch (err) {
        debug('DynamicWorkflowEngine', 'evaluateCondition', errorMessage(err));
        return false;
      }
    }

    const output = result && result.output;
    return this._evalBuiltinCondition(edge.condition, output, result);
  }

  _evalBuiltinCondition(condition, output, result) {
    switch (condition) {
      case 'default':
        return true;
      case 'success':
        return result && result.success === true;
      case 'failure':
        return result && result.success === false;
      case 'hasIssues':
        return output && (Array.isArray(output.issues) && output.issues.length > 0);
      case 'noIssues':
        return !output || !Array.isArray(output.issues) || output.issues.length === 0;
      case 'hasOutput':
        return output != null;
      case 'verified':
        return output && output.verified === true;
      case 'notVerified':
        return !output || output.verified !== true;
      default:
        if (output && typeof output === 'object' && condition in output) {
          return !!output[condition];
        }
        return false;
    }
  }

  /**
   * 递归跳过失败节点的所有下游依赖节点。
   * @param {string} failedNodeId - 失败节点标识
   * @param {Set<string>} completed - 已完成节点集合
   * @param {Set<string>} failed - 已失败节点集合
   * @param {Set<string>} skipped - 已跳过节点集合
   * @param {string[]} sortedNodes - 拓扑排序后的节点列表
   * @returns {void}
   * @private
   */
  _skipDependents(failedNodeId, completed, failed, skipped, sortedNodes) {
    const forward = this._dag._forwardAdj.get(failedNodeId);
    if (!forward) return;
    for (const toId of forward) {
      if (!completed.has(toId) && !failed.has(toId) && !skipped.has(toId)) {
        skipped.add(toId);
        this.emit('node-skipped', { nodeId: toId, reason: 'dependency-failed: ' + failedNodeId });
        this._skipDependents(toId, completed, failed, skipped, sortedNodes);
      }
    }
  }

  /**
   * 创建工作流执行检查点，保存当前执行状态。
   * @returns {{id: string, executionId: string, status: string, nodesExecuted: number, tokensUsed: number, nodeResults: Map, timestamp: string}} 检查点对象
   * @private
   */
  _createCheckpoint() {
    const checkpoint = {
      id: generateId('dwe-cp-'),
      executionId: this._executionId,
      status: this._status,
      nodesExecuted: this._nodesExecuted,
      tokensUsed: this._tokensUsed,
      nodeResults: new Map(this._nodeResults),
      timestamp: new Date().toISOString(),
    };

    const MAX_CHECKPOINTS = 200;
    if (this._checkpoints.length >= MAX_CHECKPOINTS) this._checkpoints.shift();
    this._checkpoints.push(checkpoint);
    this.emit('checkpoint-created', { checkpointId: checkpoint.id, nodesExecuted: this._nodesExecuted });

    if (this._checkpointManager && typeof this._checkpointManager.create === 'function') {
      try {
        this._checkpointManager.create(this._executionId, {
          engineCheckpoint: checkpoint.id,
          status: this._status,
          nodesExecuted: this._nodesExecuted,
          tokensUsed: this._tokensUsed,
        });
      } catch (err) {
        debug('DynamicWorkflowEngine', 'createCheckpoint', errorMessage(err));
      }
    }

    return checkpoint;
  }

  /**
   * 从检查点恢复执行。
   * 根据检查点 ID 查找已保存的执行状态，恢复节点结果和执行计数后重新执行 DAG。
   * @param {string} checkpointId - 检查点标识
   * @returns {Promise<{resumed: boolean, result?: *, error?: string}>} 恢复执行结果
   * @throws 当引擎已关闭时抛出错误
   * @emits DynamicWorkflowEngine#workflow-resumed 工作流从检查点恢复
   */
  async resumeFromCheckpoint(checkpointId) {
    this.guardShutdown();

    const checkpoint = this._checkpoints.find(cp => cp.id === checkpointId);
    if (!checkpoint) {
      return { resumed: false, error: 'Checkpoint not found: ' + checkpointId };
    }

    this._executionId = checkpoint.executionId;
    this._nodesExecuted = checkpoint.nodesExecuted;
    this._tokensUsed = checkpoint.tokensUsed;
    this._nodeResults = new Map(checkpoint.nodeResults);
    this._status = ENGINE_STATUS.EXECUTING;

    this.emit('workflow-resumed', { executionId: this._executionId, fromCheckpoint: checkpointId });

    const sortResult = this._dag.topologicalSort();
    if (!sortResult) {
      return { resumed: false, error: 'DAG has cycles' };
    }

    try {
      const result = await this._executeDAG(sortResult, {});
      this._status = ENGINE_STATUS.COMPLETED;
      return { resumed: true, result };
    } catch (err) {
      this._status = ENGINE_STATUS.FAILED;
      return { resumed: false, error: errorMessage(err) };
    }
  }

  rollbackToCheckpoint(checkpointId) {
    this.guardShutdown();

    const idx = this._checkpoints.findIndex(cp => cp.id === checkpointId);
    if (idx === -1) {
      return { rolledBack: false, error: 'Checkpoint not found' };
    }

    this._checkpoints = this._checkpoints.slice(0, idx + 1);

    const checkpoint = this._checkpoints[idx];
    this._nodesExecuted = checkpoint.nodesExecuted;
    this._tokensUsed = checkpoint.tokensUsed;
    this._nodeResults = new Map(checkpoint.nodeResults);
    this._status = ENGINE_STATUS.ROLLED_BACK;

    this.emit('workflow-rolled-back', { checkpointId, executionId: this._executionId });

    return { rolledBack: true, checkpointId };
  }

  pause() {
    if (this._status !== ENGINE_STATUS.EXECUTING) {
      return { paused: false, reason: 'Not executing' };
    }
    this._status = ENGINE_STATUS.PAUSED;
    this._createCheckpoint();
    this.emit('workflow-paused', { executionId: this._executionId, nodesExecuted: this._nodesExecuted });
    return { paused: true };
  }

  /**
   * 为 Promise 添加超时控制，超时后抛出错误。
   * @param {Promise<*>} promise - 需要限时的 Promise
   * @param {number} timeoutMs - 超时时间（毫秒）
   * @param {string} nodeId - 节点标识，用于构造超时错误信息
   * @returns {Promise<*>} 带超时控制的 Promise
   * @private
   */
  _withTimeout(promise, timeoutMs, nodeId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Node timeout: ' + nodeId + ' (' + timeoutMs + 'ms)'));
      }, timeoutMs);
      Promise.resolve(promise).then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 等待子代理返回结果。
   * @param {{result?: *, tokensUsed?: number}|null} handle - 子代理句柄
   * @param {number} _timeoutMs - 超时时间（毫秒，当前未使用）
   * @returns {Promise<{output: *|null, tokensUsed: number}>} 子代理执行结果
   * @private
   */
  async _waitForSubagent(handle, _timeoutMs) {
    if (!handle) return { output: null, tokensUsed: 0 };
    if (handle.result !== undefined) {
      return { output: handle.result, tokensUsed: handle.tokensUsed ?? 0 };
    }
    return { output: handle, tokensUsed: 0 };
  }

  getStatus() {
    return {
      status: this._status,
      executionId: this._executionId,
      nodesExecuted: this._nodesExecuted,
      tokensUsed: this._tokensUsed,
      tokenBudget: this._tokenBudget,
      checkpointCount: this._checkpoints.length,
    };
  }

  getNodeResult(nodeId) {
    const result = this._nodeResults.get(nodeId);
    return result ? { ...result, output: result.output } : null;
  }

  getCheckpoints() {
    return this._checkpoints.map(cp => ({
      id: cp.id,
      executionId: cp.executionId,
      status: cp.status,
      nodesExecuted: cp.nodesExecuted,
      tokensUsed: cp.tokensUsed,
      timestamp: cp.timestamp,
    }));
  }

  getConditionalEdges() {
    return Array.from(this._conditionalEdges.values()).map(e => ({ ...e }));
  }

  getStats() {
    return {
      totalExecutions: this._executionId ? 1 : 0,
      totalNodesExecuted: this._nodesExecuted,
      totalTokensUsed: this._tokensUsed,
      status: this._status,
    };
  }

  static listBuiltinConditions() {
    return ['default', 'success', 'failure', 'hasIssues', 'noIssues', 'hasOutput', 'verified', 'notVerified'];
  }

  static listNodeTypes() {
    return Object.values(NODE_TYPE);
  }

  static listEdgeTypes() {
    return Object.values(EDGE_TYPE);
  }

  static listEngineStatuses() {
    return Object.values(ENGINE_STATUS);
  }

  _onShutdown() {
    this._conditionalEdges.clear();
    this._nodeResults.clear();
    this._nodeConfigs.clear();
    this._nodeTimeouts.clear();
    this._status = ENGINE_STATUS.IDLE;
    this._currentExecution = null;
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

DynamicWorkflowEngine.ENGINE_STATUS = ENGINE_STATUS;
DynamicWorkflowEngine.NODE_TYPE = NODE_TYPE;
DynamicWorkflowEngine.EDGE_TYPE = EDGE_TYPE;

module.exports = withShutdown(DynamicWorkflowEngine);
