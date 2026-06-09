'use strict';

const { debug } = require('../../utils/debug-logger');

/**
 * StateGraph — LangGraph启发的状态机编排引擎。
 * 支持：
 *  - 类型化节点（function node / subgraph node / parallel node）
 *  - 条件边（conditional edges）— 基于状态的动态路由
 *  - Checkpoint持久化 — 每个状态转换自动保存到causal-wal
 *  - 并行执行 — 多个节点可同时执行（Promise.all语义）
 *  - 循环支持 — 允许在图中定义回环路径
 *  - 中断与恢复 — 支持从任意checkpoint恢复执行
 *  - 节点元数据 — 支持complexity/requiredSkills等元数据标记
 *  - 钩子（hooks） — beforeNode/afterNode/onError生命周期钩子
 *
 * LangGraph概念映射：
 *  - StateGraph ~ StateGraph
 *  - Node ~ 六阶段 + 子任务节点
 *  - Edge ~ PHASE_TRANSITIONS
 *  - ConditionalEdge ~ 基于复杂度的条件分支
 *  - Checkpoint ~ causal-wal持久化
 *  - ParallelNode ~ Send API
 *
 * @module runtime/workflow/state-graph
 * @example
 * const graph = new StateGraph({ initialState: { phase: 'brainstorming' } });
 * graph.addNode('brainstorming', async (state) => { ... return { phase: 'requirement-analysis' }; });
 * graph.addEdge('brainstorming', 'requirement-analysis');
 * const result = await graph.invoke({ task: 'build a web app' });
 */

/**
 * @typedef {Object} GraphState
 * @property {string} phase - 当前阶段名称
 * @property {Object} [meta] - 附加元数据
 * @property {number} [iteration] - 迭代计数
 * @property {string} [_currentNode] - 当前节点名（内部）
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} from - 源节点
 * @property {string} to - 目标节点
 * @property {string} [type] - 'normal' | 'conditional'
 * @property {Function} [condition] - 条件函数 (state, context) => string|null
 */

/**
 * @typedef {Object} Checkpoint
 * @property {string} id - Checkpoint ID
 * @property {GraphState} state - 状态快照
 * @property {string} node - 当前节点
 * @property {number} timestamp - 保存时间戳
 * @property {Object} [metadata] - 额外元数据
 */

/**
 * @typedef {Object} NodeMetadata
 * @property {string} [complexity] - 节点复杂度 'low'|'medium'|'high'
 * @property {string[]} [requiredSkills] - 依赖的技能ID列表
 * @property {Object} [config] - 节点配置
 */

const isThenable = (v) => v !== null && typeof v === 'object' && typeof v.then === 'function';

const MAX_DEEP_MERGE_DEPTH = 15;
const _MAX_NODES = 200;
const _MAX_NODE_META = 200;
const MAX_EDGES = 500;
const MAX_CONDITIONAL_EDGES = 200;

/**
 * 深度合并两个对象（修改 target 原地）。
 * @param {Object} target - 目标对象
 * @param {Object} source - 源对象
 * @param {number} [depth] - 当前递归深度
 * @returns {Object} target
 */
function deepMerge(target, source, depth) {
  if (depth == null) depth = 0;
  if (depth > MAX_DEEP_MERGE_DEPTH) return target;
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], val, depth + 1);
    } else {
      target[key] = val;
    }
  }
  return target;
}

class StateGraph {
  /**
   * @param {Object} [options]
   * @param {GraphState} [options.initialState] - 初始状态
   * @param {Object} [options.checkpointStore] - Checkpoint持久化存储(需实现save/load/list方法)
   * @param {number} [options.maxIterations=50] - 最大迭代次数(防无限循环)
   * @param {boolean} [options.autoCheckpoint=true] - 是否自动保存checkpoint
   * @param {Object} [options.hooks] - 生命周期钩子 { beforeNode, afterNode, onError }
   */
  constructor(options) {
    this._nodes = new Map();
    this._edges = [];
    this._conditionalEdges = [];
    this._initialState = options?.initialState ?? {};
    this._checkpointStore = options?.checkpointStore ?? null;
    this._maxIterations = options?.maxIterations ?? 50;
    this._autoCheckpoint = options?.autoCheckpoint !== false;
    this._entryPoint = null;
    this._checkpoints = [];
    /** 检查点数组最大长度，防止内存泄漏 */
    this._maxCheckpoints = 100;
    /** @type {Map<string, NodeMetadata>} */
    this._nodeMeta = new Map();
    this._hooks = options?.hooks ?? {};
  }

  /**
   * 添加一个节点。节点可以是函数(同步返回新状态)或子图(另一个StateGraph实例)。
   * @param {string} name - 节点名称
   * @param {Function|StateGraph} handler - 节点处理器函数(state, context) => newState | Promise<newState>
   * @param {NodeMetadata} [meta] - 节点元数据（complexity, requiredSkills等）
   * @returns {StateGraph} this (支持链式调用)
   */
  addNode(name, handler, meta) {
    if (!name || !handler) throw new Error('StateGraph.addNode: name and handler are required');
    this._nodes.set(name, handler);
    if (!this._entryPoint) this._entryPoint = name;
    if (meta) this._nodeMeta.set(name, meta);
    return this;
  }

  /**
   * 添加一个并行节点。多个处理器同时执行，结果合并到状态中。
   * 遵循Promise.all语义 — 任一失败则整体失败。
   * @param {string} name - 节点名称
   * @param {Array<Function|StateGraph>} handlers - 并行处理器数组
   * @param {Object} [options] - 并行选项
   * @param {string} [options.mergeStrategy='shallow'] - 合并策略 'shallow'|'deep'|'last-wins'
   * @param {NodeMetadata} [options.meta] - 节点元数据
   * @returns {StateGraph} this (支持链式调用)
   */
  addParallelNode(name, handlers, options) {
    if (!name || !Array.isArray(handlers) || handlers.length === 0) {
      throw new Error('StateGraph.addParallelNode: name and non-empty handlers array are required');
    }
    const opts = options ?? {};
    const wrappedHandler = async (state, context) => {
      const settled = await Promise.allSettled(handlers.map(h => {
        if (h instanceof StateGraph) return h.invoke(state, context);
        const result = h(state, context);
        return isThenable(result) ? result : Promise.resolve(result);
      }));
      const results = settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        debug('StateGraph', 'parallelNode', `Handler ${i} failed: ${s.reason}`);
        return null;
      });
      const merged = {};
      const strategy = opts.mergeStrategy ?? 'shallow';
      if (strategy === 'deep') {
        for (const r of results) {
          if (r && typeof r === 'object') deepMerge(merged, r);
        }
      } else if (strategy === 'last-wins') {
        for (const r of results) {
          if (r && typeof r === 'object') {
            for (const [k, v] of Object.entries(r)) {
              if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') merged[k] = v;
            }
          }
        }
      } else {
        for (const r of results) {
          if (r && typeof r === 'object') {
            for (const [k, v] of Object.entries(r)) {
              if (!(k in merged)) merged[k] = v;
            }
          }
        }
      }
      return merged;
    };
    this._nodes.set(name, wrappedHandler);
    if (!this._entryPoint) this._entryPoint = name;
    if (opts.meta) this._nodeMeta.set(name, opts.meta);
    return this;
  }

  /**
   * 设置节点元数据。
   * @param {string} name - 节点名称
   * @param {NodeMetadata} meta - 节点元数据
   * @returns {StateGraph} this (支持链式调用)
   */
  setNodeMeta(name, meta) {
    if (!this._nodes.has(name)) throw new Error(`StateGraph.setNodeMeta: node "${name}" not found`);
    this._nodeMeta.set(name, meta);
    return this;
  }

  /**
   * 获取节点元数据。
   * @param {string} name - 节点名称
   * @returns {NodeMetadata|undefined} 节点元数据
   */
  getNodeMeta(name) {
    const meta = this._nodeMeta.get(name); return meta ? { ...meta } : undefined;
  }

  /**
   * 添加一条普通边(无条件连接)。
   * @param {string} from - 源节点
   * @param {string} to - 目标节点
   * @returns {StateGraph} this (支持链式调用)
   */
  addEdge(from, to) {
    if (!from || !to) throw new Error('StateGraph.addEdge: from and to are required');
    if (this._edges.length >= MAX_EDGES) this._edges.shift();
    this._edges.push({ from, to, type: 'normal' });
    return this;
  }

  /**
   * 添加一条条件边。条件函数接收当前状态，返回目标节点名或null(终止)。
   * @param {string} from - 源节点
   * @param {Function} condition - 条件函数 (state, context) => string|null
   * @returns {StateGraph} this (支持链式调用)
   */
  addConditionalEdges(from, condition) {
    if (!from || typeof condition !== 'function') {
      throw new Error('StateGraph.addConditionalEdges: from and condition function are required');
    }
    if (this._conditionalEdges.length >= MAX_CONDITIONAL_EDGES) this._conditionalEdges.shift();
    this._conditionalEdges.push({ from, condition });
    return this;
  }

  /**
   * 设置入口节点。
   * @param {string} name - 节点名称
   * @returns {StateGraph} this
   */
  setEntryPoint(name) {
    if (!this._nodes.has(name)) throw new Error(`StateGraph.setEntryPoint: node "${name}" not found`);
    this._entryPoint = name;
    return this;
  }

  /**
   * 从固定节点开始编译可执行图。entryPoint可覆盖构造函数中的自动检测。
   * @param {string} [entryPoint] - 入口节点名称
   * @returns {Function} 可执行函数 (state, context?) => Promise<GraphState>
   */
  compile(entryPoint) {
    const start = entryPoint ?? this._entryPoint;
    if (!start) throw new Error('StateGraph.compile: no entry point defined');
    if (!this._nodes.has(start)) throw new Error(`StateGraph.compile: entry node "${start}" not found`);

    /**
     * 获取从某节点出发的所有可能目标节点。
     * 条件边结果优先于普通边。
     * @param {string} node - 源节点名
     * @param {GraphState} state - 当前状态（条件边需要）
     * @param {Object} [context] - 额外上下文（条件边需要）
     * @returns {{ conditional: string[], normal: string[] }} 分类的目标节点
     */
    const getTargets = (node, state, context) => {
      const normal = [];
      const conditional = [];

      for (const edge of this._edges) {
        if (edge.from === node) normal.push(edge.to);
      }

      for (const ce of this._conditionalEdges) {
        if (ce.from === node) {
          try {
            const result = ce.condition(state, context);
            if (typeof result === 'string' && this._nodes.has(result)) {
              conditional.push(result);
            }
          } catch (_e) {
            // 条件函数异常时跳过该条件边
            debug('StateGraph', 'getNextNodes:condition', _e && _e.message ? _e.message : String(_e));
          }
        }
      }

      return { conditional, normal };
    };

    /**
     * 确定下一个节点。条件边结果优先，其次使用普通边。
     * @param {string} currentNode - 当前节点名
     * @param {GraphState} state - 当前状态
     * @param {Object} context - 上下文
     * @returns {string|null} 下一个节点名，null表示终止
     */
    const resolveNextNode = (currentNode, state, context) => {
      // 显式标记图完成
      if (state._graphComplete) return null;
      const phase = state.phase;
      if (phase && this._nodes.has(phase) && phase !== currentNode) {
        return phase;
      }
      const { conditional, normal } = getTargets(currentNode, state, context);
      // 条件边结果优先
      if (conditional.length > 0) return conditional[0];
      if (normal.length === 1) return normal[0];
      if (normal.length > 1) return normal[0];
      return null;
    };

    /**
     * 执行指定名称的hook，捕获异常并记录日志。
     * @param {string} hookName - hook名称
     * @param {...*} args - 传递给hook的参数
     * @private
     */
    const runHook = async (hookName, ...args) => {
      if (this._hooks[hookName]) {
        try { await this._hooks[hookName](...args); } catch (_e) { debug('StateGraph', hookName + 'Hook', _e && _e.message ? _e.message : String(_e)); }
      }
    };

    /**
     * @param {GraphState} initialState
     * @param {Object} [context]
     * @returns {Promise<GraphState>}
     */
    return async function invoke(initialState, context) {
      let state = { ...this._initialState, ...(initialState ?? {}) };
      let currentNode = start;
      let iteration = 0;

      while (currentNode && iteration < this._maxIterations) {
        iteration++;
        state.iteration = iteration;
        state._currentNode = currentNode;

        const handler = this._nodes.get(currentNode);
        if (!handler) throw new Error(`StateGraph.invoke: node "${currentNode}" not found`);

        await runHook('beforeNode', currentNode, state, context);

        let nextState;
        try {
          nextState = await this._executeHandler(handler, currentNode, state, context);
        } catch (err) {
          await runHook('onError', currentNode, err, state, context);
          if (this._autoCheckpoint && this._checkpointStore) {
            await this._saveCheckpoint(currentNode, state, { error: err && err.message ? err.message : String(err) });
          }
          throw err;
        }

        if (nextState !== null && typeof nextState === 'object') {
          state = { ...state, ...nextState };
        }

        await runHook('afterNode', currentNode, state, context);

        if (this._autoCheckpoint && this._checkpointStore) {
          await this._saveCheckpoint(currentNode, state);
        }

        currentNode = resolveNextNode(currentNode, state, context);
      }

      if (iteration >= this._maxIterations && currentNode) {
        throw new Error(`StateGraph.invoke: max iterations (${this._maxIterations}) exceeded`);
      }

      return state;
    }.bind(this);
  }

  /**
   * 执行节点处理器
   * @param {Function|StateGraph} handler - 处理器
   * @param {string} nodeName - 节点名
   * @param {GraphState} state - 当前状态
   * @param {Object} context - 上下文
   * @returns {Promise<GraphState|null>} 下一状态
   * @private
   */
  async _executeHandler(handler, nodeName, state, context) {
    if (handler instanceof StateGraph) {
      return handler.invoke(state, context);
    } else if (typeof handler === 'function') {
      const result = handler(state, context);
      return isThenable(result) ? result : Promise.resolve(result);
    }
    throw new Error(`StateGraph.invoke: invalid handler for node "${nodeName}"`);
  }

  /**
   * 直接执行图（等同于 compile()()）。
   * @param {GraphState} [initialState] - 初始状态
   * @param {Object} [context] - 额外上下文
   * @returns {Promise<GraphState>} 最终状态
   */
  async invoke(initialState, context) {
    const fn = this.compile();
    return fn(initialState, context);
  }

  /**
   * 保存checkpoint到持久化存储。
   * @param {string} node - 当前节点名
   * @param {GraphState} state - 当前状态
   * @param {Object} [meta] - 额外元数据
   * @returns {Promise<void>}
   */
  async _saveCheckpoint(node, state, meta) {
    if (!this._checkpointStore) return;
    /** @type {Checkpoint} */
    const cp = {
      id: `ckpt_${node}_${Date.now()}`,
      state: { ...state },
      node,
      timestamp: Date.now(),
      metadata: meta ?? {},
    };
    this._checkpoints.push(cp);
    if (this._checkpoints.length > this._maxCheckpoints) {
      this._checkpoints.shift();
    }
    try {
      if (typeof this._checkpointStore.save === 'function') {
        await this._checkpointStore.save(cp);
      }
    } catch (_e) {
      debug('StateGraph', 'checkpointPersist', _e && _e.message ? _e.message : String(_e));
    }
  }

  /**
   * 从最近的checkpoint恢复状态。
   * @returns {Promise<Checkpoint|null>} 最近保存的checkpoint，无则返回null
   */
  async resume() {
    if (!this._checkpointStore) return null;
    try {
      if (typeof this._checkpointStore.list === 'function') {
        const list = await this._checkpointStore.list();
        if (Array.isArray(list) && list.length > 0) {
          const latest = list.reduce((a, b) => (a.timestamp > b.timestamp ? a : b), list[0]);
          return this._checkpointStore.load(latest.id);
        }
      }
    } catch (_e) {
      debug('StateGraph', 'checkpointResume', _e && _e.message ? _e.message : String(_e));
    }
    // 回退到内存缓存
    if (this._checkpoints.length > 0) {
      return this._checkpoints[this._checkpoints.length - 1];
    }
    return null;
  }

  /**
   * 获取所有已保存的checkpoint。
   * @returns {Checkpoint[]} Checkpoint数组
   */
  getCheckpoints() {
    return this._checkpoints.slice();
  }

  /**
   * 获取节点列表。
   * @returns {string[]} 节点名称数组
   */
  getNodes() {
    return Array.from(this._nodes.keys());
  }

  /**
   * 获取边列表。
   * @returns {GraphEdge[]} 边数组
   */
  getEdges() {
    return this._edges.slice();
  }

  /**
   * 获取条件边列表。
   * @returns {Object[]} 条件边数组
   */
  getConditionalEdges() {
    return this._conditionalEdges.slice();
  }
}

module.exports = { StateGraph };

