'use strict';

const { EventEmitter } = require('events');
const { isNonEmptyString } = require('../../utils/constants');
const { HarnessError } = require('../../errors');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const MAX_DAG_NODES = 500;
const MAX_EDGES_PER_NODE = 50;

/**
 * @module runtime/workflow/workflow-dag
 * @classdesc 工作流DAG（WorkflowDAG）。有向无环图、拓扑排序、依赖解析。
 * WorkflowDAG — Directed acyclic graph for workflow step orchestration
 * Manages workflow nodes with dependency edges, cycle detection on insertion, topological sort,
 * ready-node computation for parallel execution, deepening node injection with successor rewiring,
 * and status tracking (pending/running/completed/failed) per node.
 * @extends EventEmitter
 * @emits node-started | node-completed | node-failed | deepening-node-added
 */
class WorkflowDAG extends EventEmitter {
  /**
   * Create a WorkflowDAG instance with empty node and adjacency maps.
   */
  constructor() {
    super();
    this._nodes = new Map();
    this._forwardAdj = new Map();
    this._reverseAdj = new Map();
  }

  /**
   * 添加工作流节点到DAG。
   * @param {string} id - 节点唯一标识
   * @param {Object} config - 节点配置
   * @param {string} [config.phase] - 执行阶段
   * @param {string} [config.agent] - 执行Agent
   * @param {string} [config.skill] - 执行技能
   * @param {Object} [config.deepening] - 深化推理配置
   * @returns {boolean} 是否添加成功
   * @example
   * const dag = new WorkflowDAG();
   * dag.addNode('design', { agent: 'analyst', timeout: 300000 });
   * dag.addNode('implement', { agent: 'worker', dependencies: ['design'] });
   * dag.addNode('review', { agent: 'reviewer', dependencies: ['implement'] });
   * const sorted = dag.topologicalSort();
   */
  addNode(id, config) {
    this.guardShutdown();
    if (!id || typeof id !== 'string') return false;
    if (!config || typeof config !== 'object') return false;
    if (this._nodes.has(id)) {
      return false;
    }
    if (this._nodes.size >= MAX_DAG_NODES) {
      debug('WorkflowDAG', 'addNode', 'Max nodes reached: ' + MAX_DAG_NODES);
      return false;
    }
    this._nodes.set(id, {
      id,
      phase: (typeof config.phase === 'string') ? config.phase : '',
      agent: (typeof config.agent === 'string') ? config.agent : '',
      skill: (typeof config.skill === 'string') ? config.skill : '',
      status: 'pending',
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      deepening: config.deepening ?? null,
    });
    this._forwardAdj.set(id, new Set());
    this._reverseAdj.set(id, new Set());
    return true;
  }

  /**
   * 添加依赖边，从from指向to，表示to依赖from。
   * @param {string} from - 依赖源节点ID
   * @param {string} to - 依赖目标节点ID
   * @returns {boolean} 是否添加成功
   */
  addEdge(from, to) {
    this.guardShutdown();
    if (!isNonEmptyString(from) || !isNonEmptyString(to)) return false;
    if (!this._nodes.has(from) || !this._nodes.has(to)) return false;
    if (from === to) return false;
    const fwd = this._forwardAdj.get(from);
    if (fwd && fwd.has(to)) return false;
    if (fwd && fwd.size >= MAX_EDGES_PER_NODE) {
      debug('WorkflowDAG', 'addEdge', 'Max edges per node reached for: ' + from);
      return false;
    }
    if (this._hasCycle(from, to)) return false;
    if (fwd) fwd.add(to);
    const rev = this._reverseAdj.get(to);
    if (rev) rev.add(from);
    return true;
  }

  /**
   * 获取就绪节点（所有依赖已完成的pending节点）。
   * @returns {Object[]} 就绪节点数组
   */
  getReadyNodes() {
    const ready = [];
    const depFailed = [];
    for (const [id, node] of this._nodes) {
      if (node.status !== 'pending') continue;
      const deps = this._reverseAdj.get(id);
      if (!deps || deps.size === 0) {
        ready.push(node);
        continue;
      }
      let allDepsComplete = true;
      let hasFailedDep = false;
      for (const depId of deps) {
        const depNode = this._nodes.get(depId);
        if (!depNode || depNode.status !== 'completed') {
          allDepsComplete = false;
          if (depNode && depNode.status === 'failed') {
            hasFailedDep = true;
          }
        }
      }
      if (hasFailedDep) {
        depFailed.push(id);
      } else if (allDepsComplete) {
        ready.push(node);
      }
    }
    return { ready, dependencyFailed: [...new Set(depFailed)] };
  }

  /**
   * Mark pending nodes as failed due to dependency failure.
   * @param {string[]} nodeIds - Array of node IDs to mark as dependency-failed
   * @returns {string[]} Array of node IDs that were actually marked
   */
  markDependencyFailed(nodeIds) {
    this.guardShutdown();
    const marked = [];
    for (const id of nodeIds) {
      const node = this._nodes.get(id);
      if (node && node.status === 'pending') {
        node.status = 'failed';
        node.error = 'Dependency failed';
        node.completedAt = new Date().toISOString();
        this.emit('node-failed', { id, node, error: 'Dependency failed' });
        marked.push(id);
      }
    }
    return marked;
  }

  /**
   * 标记节点为运行中。
   * @param {string} id - 节点ID
   * @returns {boolean} 是否标记成功
   */
  startNode(id) {
    this.guardShutdown();
    const node = this._nodes.get(id);
    if (!node || node.status !== 'pending') return false;
    node.status = 'running';
    node.startedAt = new Date().toISOString();
    this.emit('node-started', { id, node });
    return true;
  }

  /**
   * 标记节点为已完成。
   * @param {string} id - 节点ID
   * @param {*} [result] - 节点执行结果
   * @returns {boolean} 是否标记成功
   */
  completeNode(id, result) {
    this.guardShutdown();
    const node = this._nodes.get(id);
    if (!node || node.status !== 'running') return false;
    node.status = 'completed';
    node.result = result ?? null;
    node.completedAt = new Date().toISOString();
    this.emit('node-completed', { id, node });
    return true;
  }

  /**
   * 标记节点为失败。
   * @param {string} id - 节点ID
   * @param {string} [error] - 错误信息
   * @returns {boolean} 是否标记成功
   */
  failNode(id, error) {
    this.guardShutdown();
    const node = this._nodes.get(id);
    if (!node || node.status !== 'running') return false;
    node.status = 'failed';
    node.error = error || 'Unknown error';
    node.completedAt = new Date().toISOString();
    this.emit('node-failed', { id, node, error });
    return true;
  }

  /**
   * 检查所有节点是否已完成（completed或failed）。
   * @returns {boolean} 所有节点是否已完成
   */
  isComplete() {
    if (this._nodes.size === 0) return false;
    for (const [, node] of this._nodes) {
      if (node.status !== 'completed' && node.status !== 'failed') return false;
    }
    return true;
  }

  /**
   * 检查是否存在失败节点。
   * @returns {boolean} 是否有失败节点
   */
  hasFailures() {
    for (const [, node] of this._nodes) {
      if (node.status === 'failed') return true;
    }
    return false;
  }

  /**
   * 获取所有失败节点。
   * @returns {Object[]} 失败节点数组
   */
  getFailedNodes() {
    const result = [];
    for (const node of this._nodes.values()) { if (node.status === 'failed') result.push(node); }
    return result;
  }

  /**
   * 对DAG进行拓扑排序。
   * @returns {string[]|null} 排序后的节点ID数组，存在环时返回null
   */
  topologicalSort() {
    const inDegree = new Map();
    this._nodes.forEach((_, id) => {
      inDegree.set(id, 0);
    });
    this._forwardAdj.forEach(adj => {
      adj.forEach(to => {
        inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
      });
    });

    const queue = [];
    let queueHead = 0;
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted = [];
    while (queueHead < queue.length) {
      const current = queue[queueHead++];
      sorted.push(current);
      const adj = this._forwardAdj.get(current);
      if (adj) {
        for (const to of adj) {
          inDegree.set(to, (inDegree.get(to) ?? 0) - 1);
          if (inDegree.get(to) === 0) {
            queue.push(to);
          }
        }
      }
    }

    return sorted.length === this._nodes.size ? sorted : null;
  }

  /**
   * 获取指定节点。
   * @param {string} id - 节点ID
   * @returns {Object|null} 节点对象，不存在时返回null
   */
  getNode(id) {
    return this._nodes.get(id) ?? null;
  }

  /**
   * 获取所有节点。
   * @returns {Object[]} 节点数组
   */
  getAllNodes() {
    return Array.from(this._nodes.values());
  }

  /**
   * 获取所有依赖边。
   * @returns {Object[]} 边数组，每项包含from和to属性
   */
  getEdges() {
    const edges = [];
    this._forwardAdj.forEach((adj, from) => {
      adj.forEach(to => {
        edges.push({ from, to });
      });
    });
    return edges;
  }

  /**
   * 获取节点状态统计信息。
   * @returns {Object} 统计对象，包含total、pending、running、completed、failed字段
   */
  getStats() {
    if (this._shutDown) return { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };
    const stats = { total: this._nodes.size, pending: 0, running: 0, completed: 0, failed: 0 };
    this._nodes.forEach(node => {
      if (stats[node.status] !== undefined) stats[node.status]++;
    });
    return stats;
  }

  _hasCycle(newFrom, newTo) {
    const visited = new Set();
    const stack = [newTo];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === newFrom) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const adj = this._forwardAdj.get(current);
      if (adj) {
        for (const to of adj) {
          stack.push(to);
        }
      }
    }
    return false;
  }

  /**
   * Create a WorkflowDAG from a workflow definition object containing ordered steps with dependencies.
   * @param {Object} definition - Workflow definition
   * @param {Array<Object>} definition.steps - Array of step definitions with id, phase, agent, skill, and needs fields
   * @returns {WorkflowDAG} Constructed DAG instance
   * @throws {HarnessError} When a duplicate step ID is encountered
   */
  static fromWorkflowDef(definition) {
    const dag = new WorkflowDAG();
    if (!definition || !Array.isArray(definition.steps)) return dag;

    for (const step of definition.steps) {
      if (!dag.addNode(step.id, {
        phase: step.phase || '',
        agent: step.agent || '',
        skill: step.skill || '',
      })) {
        throw new HarnessError('DUPLICATE_STEP', 'Duplicate step ID: ' + step.id);
      }
    }

    for (const step of definition.steps) {
      if (Array.isArray(step.needs)) {
        for (const dep of step.needs) {
          dag.addEdge(dep, step.id);
        }
      }
    }

    return dag;
  }

  /**
   * 添加深化推理节点，自动重连后继节点。
   * @param {string} parentId - 父节点ID
   * @param {Object} [deepeningConfig] - 深化配置
   * @param {string} [deepeningConfig.agent] - 执行Agent
   * @param {number} [deepeningConfig.iteration] - 迭代序号
   * @param {string} [deepeningConfig.depthLevel] - 深度级别
   * @param {number} [deepeningConfig.qualityScore] - 质量评分
   * @param {number} [deepeningConfig.iterationCount] - 迭代次数
   * @returns {string|null} 新节点ID，添加失败返回null
   */
  addDeepeningNode(parentId, deepeningConfig) {
    this.guardShutdown();
    if (!parentId || !this._nodes.has(parentId)) return null;
    const parentNode = this._nodes.get(parentId);
    const cfg = deepeningConfig ?? {};
    const prevCount = parentNode.deepening ? (typeof parentNode.deepening.iterationCount === 'number' && Number.isFinite(parentNode.deepening.iterationCount) ? parentNode.deepening.iterationCount : 0) : 0;
    if (prevCount >= 10) return null;
    const deepeningId = parentId + '-deepen-' + (prevCount + 1);

    const added = this.addNode(deepeningId, {
      phase: parentNode.phase,
      agent: cfg.agent || parentNode.agent,
      skill: 'iterative-deepening',
      deepening: {
        parentId,
        iteration: cfg.iteration ?? 1,
        depthLevel: cfg.depthLevel ?? 'standard',
        qualityScore: typeof cfg.qualityScore === 'number' && Number.isFinite(cfg.qualityScore) ? cfg.qualityScore : 0,
        iterationCount: typeof cfg.iterationCount === 'number' && Number.isFinite(cfg.iterationCount) ? cfg.iterationCount : 1,
      },
    });

    if (!added) return null;

    this.addEdge(parentId, deepeningId);
    this._rewireSuccessors(parentId, deepeningId);

    this.emit('deepening-node-added', { parentId, deepeningId, iteration: cfg.iteration ?? 1 });
    return deepeningId;
  }

  _rewireSuccessors(parentId, deepeningId) {
    const fwd = this._forwardAdj.get(parentId);
    const successors = fwd ? Array.from(fwd).filter(s => s !== deepeningId) : [];

    const rewirable = [];
    for (const succ of successors) {
      if (!this._hasCycle(deepeningId, succ)) {
        rewirable.push(succ);
      }
    }

    if (rewirable.length > 0 && rewirable.length < successors.length) {
      this.emit('deepening-partial-rewire', { parentId, deepeningId, rewired: rewirable.length, bypassed: successors.length - rewirable.length });
    }

    for (const succ of rewirable) {
      this.removeEdge(parentId, succ);
      if (!this.addEdge(deepeningId, succ)) {
        this.addEdge(parentId, succ);
      }
    }
  }

  /**
   * 移除依赖边。
   * @param {string} from - 边的起始节点ID
   * @param {string} to - 边的目标节点ID
   * @returns {boolean} 是否移除成功
   */
  removeEdge(from, to) {
    this.guardShutdown();
    const fwd = this._forwardAdj.get(from);
    const rev = this._reverseAdj.get(to);
    if (!fwd || !fwd.has(to)) return false;
    fwd.delete(to);
    if (rev) rev.delete(from);
    return true;
  }

  /**
   * 获取深化推理节点，可按父节点ID过滤。
   * @param {string} [parentId] - 父节点ID，不传则返回所有深化节点
   * @returns {Object[]} 深化节点数组
   */
  getDeepeningNodes(parentId) {
    return Array.from(this._nodes.values())
      .filter(node => node.deepening && (!parentId || node.deepening.parentId === parentId));
  }

  /**
   * 获取从指定节点开始的深化推理链。
   * @param {string} parentId - 起始父节点ID
   * @returns {Object[]} 深化链节点数组
   */
  getDeepeningChain(parentId) {
    const chain = [];
    let current = parentId;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const node = this._nodes.get(current);
      if (!node) break;
      chain.push(node);
      const fwd = this._forwardAdj.get(current);
      let next = null;
      if (fwd) {
        for (const to of fwd) {
          const targetNode = this._nodes.get(to);
          if (targetNode && targetNode.deepening) {
            next = to;
            break;
          }
        }
      }
      current = next;
    }
    return chain;
  }

  /**
   * 获取深化推理统计信息。
   * @returns {Object} 统计对象，包含totalDeepeningNodes、totalDeepenedTasks、totalIterations、avgIterationsPerTask字段
   */
  getDeepeningStats() {
    let totalDeepeningNodes = 0;
    let totalIterations = 0;
    const parentIds = new Set();
    this._nodes.forEach(node => {
      if (node.deepening) {
        totalDeepeningNodes++;
        totalIterations += typeof node.deepening.iterationCount === 'number' && Number.isFinite(node.deepening.iterationCount) ? node.deepening.iterationCount : 1;
        parentIds.add(node.deepening.parentId);
      }
    });
    return {
      totalDeepeningNodes,
      totalDeepenedTasks: parentIds.size,
      totalIterations,
      avgIterationsPerTask: parentIds.size > 0 ? Math.round((totalIterations / parentIds.size) * 100) / 100 : 0,
    };
  }

  _onShutdown() {
    this._nodes.clear();
    this._forwardAdj.clear();
    this._reverseAdj.clear();
    this.removeAllListeners();
  }


  /**
   * 健康检查，DAG中是否存在节点。
   * @returns {boolean} 是否健康
   */
  isHealthy() { if (this._shutDown) return false; return this._nodes.size > 0; }
}

module.exports = withShutdown(WorkflowDAG);
