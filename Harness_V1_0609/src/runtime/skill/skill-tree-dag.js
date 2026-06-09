'use strict';

const EventEmitter = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');

/**
 * @module runtime/skill/skill-tree-dag
 * SkillTreeDAG — 技能树有向无环图
 * 管理技能间的依赖关系，支持拓扑排序执行、循环依赖检测、种子技能自生长。
 * 节点代表技能，边代表依赖方向（skillId→dependsOnId），层级自动传播。
 * 提供根节点/叶节点/子树查询，以及从种子技能演化新技能的能力。
 * @extends EventEmitter
 * @emits SkillTreeDAG#node-added
 * @emits SkillTreeDAG#cycle-detected
 */
class SkillTreeDAG extends EventEmitter {
  /**
   * 创建 SkillTreeDAG 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxDepth=10] - 最大依赖深度
   */
  constructor(options) {
    super();
    this._nodes = new Map();
    this._edges = new Map();
    this._maxDepth = (options ?? {}).maxDepth ?? 10;
    this._maxChildren = (options ?? {}).maxChildren ?? 20;
    this._maxNodes = (options ?? {}).maxNodes ?? 200;
    this._maxEdges = (options ?? {}).maxEdges ?? 1000;
  }

  /**
   * 添加技能节点，已存在则更新元数据
   * @param {string} skillId - 技能ID
   * @param {Object} [metadata] - 节点元数据
   * @param {string} [metadata.category='general'] - 分类
   * @param {number} [metadata.level=0] - 层级
   * @param {string} [metadata.status='active'] - 状态
   * @param {boolean} [metadata.seed=false] - 是否为种子技能
   * @returns {Object|boolean} 新建返回节点对象，已存在返回更新后的节点，节点数达上限返回false
   */
  addNode(skillId, metadata) {
    this.guardShutdown();
    if (this._nodes.has(skillId)) {
      const existing = this._nodes.get(skillId);
      safeAssign(existing, metadata ?? {}, { updatedAt: Date.now() });
      return existing;
    }
    if (this._nodes.size >= this._maxNodes) {
      debug('SkillTreeDAG', 'addNode', 'Max nodes limit reached: ' + this._maxNodes);
      return false;
    }
    const node = {
      id: skillId,
      category: (metadata ?? {}).category ?? 'general',
      level: (metadata ?? {}).level ?? 0,
      status: (metadata ?? {}).status ?? 'active',
      seed: (metadata ?? {}).seed ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._nodes.set(skillId, node);
    if (!this._edges.has(skillId)) this._edges.set(skillId, []);
    this.emit('node-added', { skillId });
    return node;
  }

  /**
   * 添加依赖关系（skillId依赖于dependsOnId），自动检测循环依赖
   * @param {string} skillId - 依赖方技能ID
   * @param {string} dependsOnId - 被依赖方技能ID
   * @returns {boolean} 是否添加成功
   */
  addDependency(skillId, dependsOnId) {
    this.guardShutdown();
    if (!this._nodes.has(skillId) || !this._nodes.has(dependsOnId)) return false;
    if (this._wouldCreateCycle(skillId, dependsOnId)) {
      debug('SkillTreeDAG', 'addDependency', 'Cycle detected: ' + skillId + ' -> ' + dependsOnId);
      this.emit('cycle-detected', { skillId, dependsOnId });
      return false;
    }

    const deps = this._edges.get(skillId) ?? [];
    if (deps.length >= this._maxChildren) {
      debug('SkillTreeDAG', 'addDependency', 'Max children limit reached for: ' + skillId);
      return false;
    }
    if (!deps.includes(dependsOnId)) {
      deps.push(dependsOnId);
      this._edges.set(skillId, deps);
    }

    const node = this._nodes.get(skillId);
    const depNode = this._nodes.get(dependsOnId);
    node.level = Math.max(typeof node.level === 'number' && Number.isFinite(node.level) ? node.level : 0, depNode ? (typeof depNode.level === 'number' && Number.isFinite(depNode.level) ? depNode.level : 0) + 1 : 1);
    this._propagateLevel(skillId);

    return true;
  }

  _propagateLevel(skillId) {
    const sourceNode = this._nodes.get(skillId);
    if (!sourceNode) return;
    const newLevel = sourceNode.level;
    for (const [id, deps] of this._edges) {
      if (deps.includes(skillId)) {
        const dependent = this._nodes.get(id);
        if (!dependent) continue;
        const newDepLevel = Math.max(typeof dependent.level === 'number' && Number.isFinite(dependent.level) ? dependent.level : 0, (typeof newLevel === 'number' && Number.isFinite(newLevel) ? newLevel : 0) + 1);
        if (newDepLevel > (typeof dependent.level === 'number' && Number.isFinite(dependent.level) ? dependent.level : 0)) {
          dependent.level = newDepLevel;
          this._propagateLevel(id);
        }
      }
    }
  }

  _wouldCreateCycle(skillId, dependsOnId) {
    if (skillId === dependsOnId) return true;
    const visited = new Set();
    const stack = [dependsOnId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === skillId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = this._edges.get(current) ?? [];
      for (const dep of deps) stack.push(dep);
    }
    return false;
  }

  /**
   * 获取指定技能的直接依赖列表
   * @param {string} skillId - 技能ID
   * @returns {string[]} 依赖的技能ID列表
   */
  getDependencies(skillId) {
    const deps = this._edges.get(skillId);
    return deps ? deps.slice() : [];
  }

  /**
   * 获取依赖于指定技能的所有技能ID列表
   * @param {string} skillId - 被依赖的技能ID
   * @returns {string[]} 依赖方技能ID列表
   */
  getDependents(skillId) {
    const dependents = [];
    for (const [id, deps] of this._edges) {
      if (deps.includes(skillId)) dependents.push(id);
    }
    return dependents;
  }

  /**
   * 获取拓扑排序的执行顺序（依赖在前，被依赖在后）
   * @returns {string[]} 拓扑排序后的技能ID列表
   */
  getExecutionOrder() {
    const visited = new Set();
    const order = [];
    const visiting = new Set();
    const cyclicNodes = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        debug('SkillTreeDAG', 'getExecutionOrder', 'Cycle detected at: ' + id);
        this.emit('cycle-detected', { skillId: id, context: 'execution-order' });
        cyclicNodes.push(id);
        return;
      }
      visiting.add(id);
      for (const dep of this.getDependencies(id)) visit(dep);
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };

    for (const id of this._nodes.keys()) visit(id);

    if (cyclicNodes.length > 0) {
      this.emit('execution-order-incomplete', { order, cyclicNodes });
    }
    return { order, cyclicNodes, hasCycle: cyclicNodes.length > 0 };
  }

  /**
   * 获取所有根节点（无依赖的节点）
   * @returns {string[]} 根节点技能ID列表
   */
  getRoots() {
    return [...this._nodes.keys()].filter(id => (this._edges.get(id) ?? []).length === 0);
  }

  /**
   * 获取所有叶节点（没有被其他节点依赖的节点）
   * @returns {string[]} 叶节点技能ID列表
   */
  getLeaves() {
    const hasDependents = new Set();
    for (const deps of this._edges.values()) {
      for (const dep of deps) hasDependents.add(dep);
    }
    return [...this._nodes.keys()].filter(id => !hasDependents.has(id));
  }

  /**
   * 获取指定技能的子树（包含自身及所有直接/间接依赖于它的技能）
   * @param {string} skillId - 起始技能ID
   * @returns {string[]} 子树中的技能ID列表
   */
  getSubtree(skillId) {
    const result = [];
    const visited = new Set();
    const stack = [skillId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current) || !this._nodes.has(current)) continue;
      visited.add(current);
      result.push(current);
      for (const dep of this.getDependents(current)) stack.push(dep);
    }
    return result;
  }

  computeLearningPath(targetSkillId, masteredSkillIds) {
    const mastered = new Set(Array.isArray(masteredSkillIds) ? masteredSkillIds : []);
    if (!this._nodes.has(targetSkillId)) return { path: [], missingPrerequisites: [] };
    const prerequisites = this._collectPrerequisites(targetSkillId, mastered);
    const sorted = this._topologicalSortPrerequisites(prerequisites);
    sorted.push(targetSkillId);
    return { path: sorted, missingPrerequisites: [...prerequisites] };
  }

  _collectPrerequisites(targetId, mastered) {
    const prerequisites = new Set();
    const stack = [targetId];
    const visited = new Set();
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      if (!mastered.has(current) && current !== targetId) {
        prerequisites.add(current);
      }
      for (const dep of this.getDependencies(current)) stack.push(dep);
    }
    return prerequisites;
  }

  _topologicalSortPrerequisites(prerequisites) {
    const subGraph = new Map();
    for (const pid of prerequisites) {
      const deps = this.getDependencies(pid).filter(d => prerequisites.has(d));
      subGraph.set(pid, deps.filter(d => prerequisites.has(d)));
    }
    const inDegree = new Map();
    for (const _pid of prerequisites) inDegree.set(_pid, 0);
    for (const [pid, deps] of subGraph) {
      inDegree.set(pid, (inDegree.get(pid) ?? 0) + deps.length);
    }
    const queue = [];
    for (const [_id, deg] of inDegree) {
      if (deg === 0) queue.push(_id);
    }
    queue.sort((a, b) => {
      const na = this._nodes.get(a);
      const nb = this._nodes.get(b);
      return ((na && na.level) ?? 0) - ((nb && nb.level) ?? 0);
    });
    const sorted = [];
    while (queue.length > 0) {
      const id = queue.shift();
      sorted.push(id);
      for (const [nid, deps] of subGraph) {
        if (deps.includes(id)) {
          inDegree.set(nid, (inDegree.get(nid) ?? 0) - 1);
          if (inDegree.get(nid) === 0) queue.push(nid);
        }
      }
    }
    return sorted;
  }

  /**
   * 获取所有种子技能节点
   * @returns {Object[]} 种子技能节点列表
   */
  getSeedSkills() {
    return [...this._nodes.values()].filter(n => n.seed);
  }

  /**
   * 从种子技能演化出新技能节点，自动建立依赖关系
   * @param {string} seedId - 种子技能ID
   * @param {string} newSkillId - 新技能ID
   * @param {Object} [metadata] - 新节点元数据
   * @returns {Object|boolean|null} 新节点对象，种子不存在或非种子返回null
   */
  evolveFromSeed(seedId, newSkillId, metadata) {
    this.guardShutdown();
    const seed = this._nodes.get(seedId);
    if (!seed || !seed.seed) return null;

    const newNode = this.addNode(newSkillId, safeAssign({ level: (seed.level ?? 0) + 1, seed: false }, metadata));
    this.addDependency(newSkillId, seedId);
    return newNode;
  }

  /**
   * 获取指定技能节点数据
   * @param {string} skillId - 技能ID
   * @returns {Object|null} 节点数据，不存在返回null
   */
  getNode(skillId) { return this._nodes.get(skillId) ?? null; }
  /**
   * 获取节点总数
   * @returns {number} 节点数量
   */
  getNodeCount() { return this._nodes.size; }
  /**
   * 获取边总数
   * @returns {number} 依赖关系数量
   */
  getEdgeCount() { let c = 0; for (const deps of this._edges.values()) c += deps.length; return c; }
  /**
   * 获取DAG的最大深度
   * @returns {number} 最大层级深度
   */
  getDepth() { let d = 0; for (const n of this._nodes.values()) d = Math.max(d, n.level ?? 0); return d; }

  /**
   * 移除指定技能节点及其所有关联边
   * @param {string} skillId - 技能ID
   * @returns {void}
   */
  removeNode(skillId) {
    this.guardShutdown();
    this._nodes.delete(skillId);
    this._edges.delete(skillId);
    for (const [id, deps] of this._edges) {
      this._edges.set(id, deps.filter(d => d !== skillId));
    }
  }

  _onShutdown() {
    this._nodes.clear();
    this._edges.clear();
    this.removeAllListeners();
  }
}

module.exports = { SkillTreeDAG: withShutdown(SkillTreeDAG) };
