'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { AgentError, ERROR_CODES } = require('../../errors');
const { mergeConfig } = require('../../utils/safe-assign');

/**
 * @module runtime/skill/skill-graph
 * 技能图谱默认配置项。
 * @property {number} maxNodes - 节点数量上限，默认200
 * @property {number} maxEdges - 边数量上限，默认1000
 * @property {number} semanticMatchThreshold - 语义匹配阈值（0~1），默认0.5
 */
const DEFAULT_CONFIG = {
  maxNodes: 200,
  maxEdges: 1000,
  semanticMatchThreshold: 0.5,
};

/**
 * 各边类型的默认权重。权重范围 [0, 1]，数值越大表示关系越强。
 * @property {number} dependency - 依赖关系权重，默认1.0
 * @property {number} blocking - 阻塞关系权重，默认0.8
 * @property {number} semantic - 语义关系权重，默认0.5
 * @property {number} causal - 因果关系权重，默认0.9
 */
const EDGE_DEFAULT_WEIGHTS = {
  dependency: 1.0,
  blocking: 0.8,
  semantic: 0.5,
  causal: 0.9,
};

/** 合法的边类型集合，由 EDGE_DEFAULT_WEIGHTS 的键推导而来。 */
const VALID_EDGE_TYPES = new Set(Object.keys(EDGE_DEFAULT_WEIGHTS));

/**
 * 技能图谱——以有向图建模技能间的依赖、阻塞、因果与语义关系。
 *
 * 提供节点/边的增删、从技能数组批量构建图谱、拓扑排序执行顺序、
 * 最小技能集发现、最短路径查询、环检测及统计信息等能力。
 *
 * @classdesc 技能图谱。技能关系建模、依赖可视化、影响范围分析、findMinimalSkillSet最小技能集查询、getExecutionOrder拓扑排序执行。
 * @extends EventEmitter
 * @emits 'node-added' - 新节点添加完成，参数 {skillId: string, node: SkillNode}
 * @emits 'edge-added' - 新边添加完成，参数 {fromId: string, toId: string, edgeType: string, weight: number}
 * @emits 'graph-built' - 从技能数组构建图谱完成，参数 {nodeCount: number, edgeCount: number}
 */
class SkillGraph extends EventEmitter {
  /**
   * 创建 SkillGraph 实例。
   * @param {Object} [config={}] - 可选配置项，将与 DEFAULT_CONFIG 合并
   * @param {number} [config.maxNodes=200] - 节点数量上限
   * @param {number} [config.maxEdges=1000] - 边数量上限
   * @param {number} [config.semanticMatchThreshold=0.5] - 语义匹配阈值（0~1）
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._nodes = new Map();
    this._edges = new Map();
    this._adjacency = new Map();
    this._reverseAdjacency = new Map();
    this._semanticGroups = new Map();
  }

  /**
   * 向图谱中添加一个技能节点。
   * @param {string} skillId - 技能唯一标识，不可为空字符串
   * @param {Object} [metadata={}] - 节点元数据
   * @param {string} [metadata.phase='unknown'] - 技能所属执行阶段
   * @param {number} [metadata.priority=0] - 技能优先级，数值越大越优先
   * @param {string[]} [metadata.agents=[]] - 适用的Agent角色列表
   * @param {string[]} [metadata.depends_on=[]] - 依赖的技能ID列表
   * @param {string[]} [metadata.blocks=[]] - 被该技能阻塞的技能ID列表
   * @param {string|null} [metadata.semantic_group=null] - 语义分组名称
   * @returns {SkillGraph} 当前实例，支持链式调用
   * @throws {AgentError} skillId 为空或非字符串时抛出 INVALID_INPUT
   * @throws {AgentError} 节点数超过 maxNodes 时抛出 CAPACITY_EXCEEDED
   */
  addNode(skillId, metadata) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      throw new AgentError(ERROR_CODES.INVALID_INPUT, 'skillId must be a non-empty string');
    }
    if (this._nodes.size >= this._config.maxNodes && !this._nodes.has(skillId)) {
      throw new AgentError(ERROR_CODES.CAPACITY_EXCEEDED, 'SkillGraph maxNodes limit reached');
    }
    const node = this._createNode(skillId, metadata);
    this._nodes.set(skillId, node);
    this._registerSemanticGroup(node.semantic_group, skillId);
    if (!this._adjacency.has(skillId)) {
      this._adjacency.set(skillId, new Set());
    }
    if (!this._reverseAdjacency.has(skillId)) {
      this._reverseAdjacency.set(skillId, new Set());
    }
    this.emit('node-added', { skillId, node });
    debug('SkillGraph', 'addNode', skillId);
    return this;
  }

  /**
   * 创建技能节点对象。
   * @param {string} skillId - 技能ID
   * @param {Object} [metadata] - 节点元数据
   * @returns {Object} 节点对象，包含 skillId、phase、priority、agents、depends_on、blocks、semantic_group
   */
  _createNode(skillId, metadata) {
    return {
      skillId,
      phase: (metadata && metadata.phase) || 'unknown',
      priority: typeof (metadata && metadata.priority) === 'number' && Number.isFinite(metadata.priority) ? metadata.priority : 0,
      agents: (metadata && metadata.agents) ?? [],
      depends_on: (metadata && metadata.depends_on) ?? [],
      blocks: (metadata && metadata.blocks) ?? [],
      semantic_group: (metadata && metadata.semantic_group) ?? null,
    };
  }

  /**
   * 将技能ID注册到对应的语义分组中。
   * @param {string|null} group - 语义分组名称，为 null 时跳过注册
   * @param {string} skillId - 技能ID
   */
  _registerSemanticGroup(group, skillId) {
    if (!group) return;
    if (!this._semanticGroups.has(group)) {
      this._semanticGroups.set(group, new Set());
    }
    this._semanticGroups.get(group).add(skillId);
  }

  /**
   * 向图谱中添加一条有向边。
   * @param {string} fromId - 起始节点ID，必须已存在于图谱中
   * @param {string} toId - 目标节点ID，必须已存在于图谱中
   * @param {'dependency'|'blocking'|'semantic'|'causal'} edgeType - 边类型
   * @param {number} [weight] - 边权重（0~1），省略时使用 EDGE_DEFAULT_WEIGHTS 中的默认值
   * @returns {SkillGraph} 当前实例，支持链式调用
   * @throws {AgentError} 起始或目标节点不存在时抛出 SKILL_NOT_FOUND
   * @throws {AgentError} edgeType 不合法时抛出 INVALID_INPUT
   * @throws {AgentError} 边数超过 maxEdges 时抛出 CAPACITY_EXCEEDED
   */
  addEdge(fromId, toId, edgeType, weight) {
    this.guardShutdown();
    if (!this._nodes.has(fromId)) {
      throw new AgentError(ERROR_CODES.SKILL_NOT_FOUND, 'Source node not found: ' + fromId);
    }
    if (!this._nodes.has(toId)) {
      throw new AgentError(ERROR_CODES.SKILL_NOT_FOUND, 'Target node not found: ' + toId);
    }
    if (!VALID_EDGE_TYPES.has(edgeType)) {
      throw new AgentError(ERROR_CODES.INVALID_INPUT, 'Invalid edgeType: ' + edgeType);
    }
    if (this._edges.size >= this._config.maxEdges) {
      throw new AgentError(ERROR_CODES.CAPACITY_EXCEEDED, 'SkillGraph maxEdges limit reached');
    }
    const edgeKey = fromId + '\u2192' + toId;
    const resolvedWeight = weight ?? EDGE_DEFAULT_WEIGHTS[edgeType];
    const clampedWeight = Math.max(0, Math.min(1, resolvedWeight));
    this._edges.set(edgeKey, { fromId, toId, edgeType, weight: clampedWeight });
    if (this._adjacency.has(fromId)) {
      const adjSet = this._adjacency.get(fromId);
      if (adjSet) adjSet.add(toId);
    }
    if (this._reverseAdjacency.has(toId)) {
      const revSet = this._reverseAdjacency.get(toId);
      if (revSet) revSet.add(fromId);
    }
    this.emit('edge-added', { fromId, toId, edgeType, weight: clampedWeight });
    debug('SkillGraph', 'addEdge', edgeKey);
    return this;
  }

  /**
   * 从技能定义数组批量构建图谱。依次添加节点、显式边和语义边。
   * @param {Array<Object>} skills - 技能定义数组，每项需包含 skill_id 或 id 字段
   * @returns {SkillGraph} 当前实例，支持链式调用
   * @throws {AgentError} skills 非数组时抛出 INVALID_INPUT
   */
  buildFromSkills(skills) {
    this.guardShutdown();
    if (!Array.isArray(skills)) {
      throw new AgentError(ERROR_CODES.INVALID_INPUT, 'skills must be an array');
    }
    this._addSkillNodes(skills);
    this._addSkillEdges(skills);
    this._buildSemanticEdges();
    this.emit('graph-built', { nodeCount: this._nodes.size, edgeCount: this._edges.size });
    debug('SkillGraph', 'buildFromSkills', this._nodes.size + ' nodes, ' + this._edges.size + ' edges');
    return this;
  }

  /**
   * 批量添加技能节点，跳过已存在的节点。
   * @param {Array<Object>} skills - 技能定义数组
   */
  _addSkillNodes(skills) {
    for (const skill of skills) {
      const skillId = skill.skill_id || skill.id;
      if (!skillId) continue;
      if (!this._nodes.has(skillId)) {
        this.addNode(skillId, {
          phase: skill.phase,
          priority: skill.priority,
          agents: skill.applicable_agents || skill.agents,
          depends_on: skill.depends_on ?? [],
          blocks: skill.blocks ?? [],
          semantic_group: skill.semantic_group ?? null,
        });
      }
    }
  }

  /**
   * 批量添加技能间的依赖、阻塞和因果关系边。
   * @param {Array<Object>} skills - 技能定义数组
   */
  _addSkillEdges(skills) {
    for (const skill of skills) {
      const skillId = skill.skill_id || skill.id;
      if (!skillId) continue;
      this._addDependencyEdges(skillId, skill.depends_on);
      this._addBlockingEdges(skillId, skill.blocks);
      this._addCausalInputEdges(skillId, skill.causal_inputs);
      this._addCausalOutputEdges(skillId, skill.causal_outputs);
    }
  }

  /**
   * 为指定技能添加 dependency 类型的边（从前驱指向当前技能）。
   * @param {string} skillId - 当前技能ID
   * @param {string[]} [dependsOn=[]] - 依赖的前驱技能ID列表
   */
  _addDependencyEdges(skillId, dependsOn) {
    for (const dep of (dependsOn ?? [])) {
      if (this._nodes.has(dep) && !this._hasEdge(dep, skillId)) {
        this.addEdge(dep, skillId, 'dependency');
      }
    }
  }

  /**
   * 为指定技能添加 blocking 类型的边（从当前技能指向被阻塞的技能）。
   * @param {string} skillId - 当前技能ID
   * @param {string[]} [blocks=[]] - 被当前技能阻塞的技能ID列表
   */
  _addBlockingEdges(skillId, blocks) {
    for (const blocked of (blocks ?? [])) {
      if (this._nodes.has(blocked) && !this._hasEdge(skillId, blocked)) {
        this.addEdge(skillId, blocked, 'blocking');
      }
    }
  }

  /**
   * 为指定技能添加 causal 类型的入边（从因果源指向当前技能）。
   * @param {string} skillId - 当前技能ID
   * @param {Array<string|{source: string}>} [causalInputs=[]] - 因果输入列表，元素为源ID字符串或含 source 字段的对象
   */
  _addCausalInputEdges(skillId, causalInputs) {
    for (const input of (causalInputs ?? [])) {
      const sourceId = typeof input === 'string' ? input : input.source;
      if (sourceId && this._nodes.has(sourceId) && !this._hasEdge(sourceId, skillId)) {
        this.addEdge(sourceId, skillId, 'causal');
      }
    }
  }

  /**
   * 为指定技能添加 causal 类型的出边（从当前技能指向因果目标）。
   * @param {string} skillId - 当前技能ID
   * @param {Array<string|{target: string}>} [causalOutputs=[]] - 因果输出列表，元素为目标ID字符串或含 target 字段的对象
   */
  _addCausalOutputEdges(skillId, causalOutputs) {
    for (const output of (causalOutputs ?? [])) {
      const targetId = typeof output === 'string' ? output : output.target;
      if (targetId && this._nodes.has(targetId) && !this._hasEdge(skillId, targetId)) {
        this.addEdge(skillId, targetId, 'causal');
      }
    }
  }

  /**
   * 为同一语义分组内的技能对建立双向 semantic 边。
   * 受 maxEdges 配置限制，超出上限时停止添加。
   */
  _buildSemanticEdges() {
    for (const [, skillIds] of this._semanticGroups) {
      const ids = Array.from(skillIds);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (!this._hasEdge(ids[i], ids[j]) && this._edges.size < this._config.maxEdges) {
            const edgeKey = ids[i] + '\u2192' + ids[j];
            this._edges.set(edgeKey, {
              fromId: ids[i],
              toId: ids[j],
              edgeType: 'semantic',
              weight: EDGE_DEFAULT_WEIGHTS.semantic,
            });
            if (this._adjacency.has(ids[i])) {
              const fwd = this._adjacency.get(ids[i]);
              if (fwd) fwd.add(ids[j]);
            }
            if (this._reverseAdjacency.has(ids[j])) {
              const rev = this._reverseAdjacency.get(ids[j]);
              if (rev) rev.add(ids[i]);
            }
          }
          if (!this._hasEdge(ids[j], ids[i]) && this._edges.size < this._config.maxEdges) {
            const edgeKey = ids[j] + '\u2192' + ids[i];
            this._edges.set(edgeKey, {
              fromId: ids[j],
              toId: ids[i],
              edgeType: 'semantic',
              weight: EDGE_DEFAULT_WEIGHTS.semantic,
            });
            if (this._adjacency.has(ids[j])) {
              const fwd = this._adjacency.get(ids[j]);
              if (fwd) fwd.add(ids[i]);
            }
            if (this._reverseAdjacency.has(ids[i])) {
              const rev = this._reverseAdjacency.get(ids[i]);
              if (rev) rev.add(ids[j]);
            }
          }
        }
      }
    }
  }

  /**
   * 判断两个节点之间是否已存在有向边。
   * @param {string} fromId - 起始节点ID
   * @param {string} toId - 目标节点ID
   * @returns {boolean} 边存在时返回 true
   */
  _hasEdge(fromId, toId) {
    return this._edges.has(fromId + '\u2192' + toId);
  }

  /**
   * 根据任务描述和必需技能，发现最小技能集并返回拓扑排序后的执行顺序。
   *
   * 先以 BFS 遍历 requiredSkills 的传递依赖，若提供了 taskDescription
   * 则进一步通过语义分组过滤，仅保留与任务语义相关的技能及其必要依赖。
   * @param {string} [taskDescription] - 任务描述文本，用于语义分组匹配
   * @param {string[]} requiredSkills - 必需的技能ID列表
   * @returns {string[]} 拓扑排序后的最小技能ID序列
   */
  findMinimalSkillSet(taskDescription, requiredSkills) {
    this.guardShutdown();
    if (!Array.isArray(requiredSkills) || requiredSkills.length === 0) {
      return [];
    }
    const visited = new Set();
    const queue = [...requiredSkills];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      if (!this._nodes.has(current)) continue;
      visited.add(current);
      const deps = this.getDependencies(current);
      for (const dep of deps) {
        if (!visited.has(dep)) {
          queue.push(dep);
        }
      }
    }
    if (taskDescription && typeof taskDescription === 'string') {
      const matchedGroups = this._matchSemanticGroups(taskDescription);
      if (matchedGroups.size > 0) {
        const filtered = new Set();
        for (const skillId of visited) {
          const node = this._nodes.get(skillId);
          if (node && node.semantic_group && matchedGroups.has(node.semantic_group)) {
            filtered.add(skillId);
          } else if (requiredSkills.includes(skillId)) {
            filtered.add(skillId);
          } else {
            const isDepOfRequired = requiredSkills.some(rs => {
              const deps = this.getDependencies(rs);
              return deps.includes(skillId);
            });
            if (isDepOfRequired) {
              filtered.add(skillId);
            }
          }
        }
        return this.getExecutionOrder(Array.from(filtered));
      }
    }
    return this.getExecutionOrder(Array.from(visited));
  }

  /**
   * 根据任务描述文本匹配语义分组。对描述进行关键词匹配，
   * 匹配率超过 semanticMatchThreshold 的分组将被选中。
   * @param {string} description - 任务描述文本
   * @returns {Set<string>} 匹配到的语义分组名称集合
   */
  _matchSemanticGroups(description) {
    const lower = description.toLowerCase();
    const matched = new Set();
    const SEMANTIC_KEYWORDS = {
      tdd: ['测试驱动', '先写测试', 'red-green', 'tdd', 'test-driven'],
      architecture: ['架构', '设计', '模块划分', '接口设计', 'architecture', 'design'],
      deploy: ['部署', '上线', '发布', 'deploy', 'release', 'ship'],
      review: ['审查', '审核', '代码评审', 'code review', 'review'],
      debug: ['调试', '排错', 'bug', 'debug', 'troubleshoot', 'fix'],
      test: ['测试', '单元测试', '集成测试', 'test', 'testing'],
      security: ['安全', '漏洞', '审计', 'security', 'audit'],
      refactor: ['重构', '优化', 'refactor', 'restructure'],
      performance: ['性能', '优化', '加速', 'performance', 'optimize'],
      brainstorm: ['头脑风暴', '需求探索', 'brainstorm', 'explore'],
      requirement: ['需求分析', '需求规格', 'requirement', 'spec'],
      deepening: ['深化', '迭代精炼', 'deepening', 'iterate', 'refine'],
      fusion: ['融合', '多agent协同', 'fusion', 'merge'],
      idea: ['想法验证', '假设验证', 'idea', 'validation'],
      mvp: ['mvp', '最小可行产品', 'prototype'],
      scaling: ['规模化', '扩展', 'scaling', 'scale'],
    };
    for (const [group, keywords] of Object.entries(SEMANTIC_KEYWORDS)) {
      let matchCount = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) matchCount++;
      }
      const score = keywords.length > 0 ? matchCount / keywords.length : 0;
      if (score >= this._config.semanticMatchThreshold) {
        matched.add(group);
      }
    }
    return matched;
  }

  /**
   * 对给定技能集合进行拓扑排序，返回合法执行顺序。
   * 仅考虑 dependency、blocking、causal 三种边类型；同层节点按优先级降序排列。
   * @param {string[]} skillIds - 待排序的技能ID数组
   * @returns {string[]} 拓扑排序后的技能ID序列
   * @throws {AgentError} 检测到循环依赖时抛出 DEPENDENCY_CYCLE
   */
  getExecutionOrder(skillIds) {
    this.guardShutdown();
    if (!Array.isArray(skillIds) || skillIds.length === 0) return [];
    const validIds = skillIds.filter(id => this._nodes.has(id));
    const { inDegree, subAdj } = this._buildSubGraph(validIds);
    const queue = this._collectZeroDegreeNodes(inDegree);
    const result = [];
    while (queue.length > 0) {
      const current = queue.shift();
      result.push(current);
      const neighbors = subAdj.get(current) ?? [];
      const newZeroDegree = [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          newZeroDegree.push(neighbor);
        }
      }
      newZeroDegree.sort((a, b) => this._comparePriority(a, b));
      queue.push(...newZeroDegree);
    }
    if (result.length !== validIds.length) {
      const cycle = this.detectCycles();
      throw new AgentError(ERROR_CODES.DEPENDENCY_CYCLE, 'Circular dependency detected in skill graph', { cycle });
    }
    return result;
  }

  _buildSubGraph(validIds) {
    const inDegree = new Map();
    const subAdj = new Map();
    for (const id of validIds) {
      inDegree.set(id, 0);
      subAdj.set(id, []);
    }
    for (const id of validIds) {
      const neighbors = this._adjacency.get(id);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!subAdj.has(neighbor)) continue;
        const edgeKey = id + '\u2192' + neighbor;
        const edge = this._edges.get(edgeKey);
        if (!edge) continue;
        if (edge.edgeType === 'dependency' || edge.edgeType === 'blocking' || edge.edgeType === 'causal') {
          const adjList = subAdj.get(id);
          if (adjList) adjList.push(neighbor);
          inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) + 1);
        }
      }
    }
    return { inDegree, subAdj };
  }

  _collectZeroDegreeNodes(inDegree) {
    const queue = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }
    queue.sort((a, b) => this._comparePriority(a, b));
    return queue;
  }

  _comparePriority(a, b) {
    const nodeA = this._nodes.get(a);
    const nodeB = this._nodes.get(b);
    const prioA = nodeA ? nodeA.priority : 0;
    const prioB = nodeB ? nodeB.priority : 0;
    return prioB - prioA;
  }

  /**
   * 获取指定技能的所有下游依赖方（即被该技能的 dependency 或 blocking 边指向的节点）。
   * @param {string} skillId - 技能ID
   * @returns {string[]} 下游依赖方技能ID列表
   */
  getDependents(skillId) {
    this.guardShutdown();
    if (!this._nodes.has(skillId)) return [];
    const neighbors = this._adjacency.get(skillId);
    if (!neighbors) return [];
    const dependents = [];
    for (const neighbor of neighbors) {
      const edgeKey = skillId + '\u2192' + neighbor;
      const edge = this._edges.get(edgeKey);
      if (edge && (edge.edgeType === 'dependency' || edge.edgeType === 'blocking')) {
        dependents.push(neighbor);
      }
    }
    return dependents;
  }

  /**
   * 获取指定技能的所有上游依赖（即通过 dependency 或 blocking 边指向该技能的前驱节点）。
   * @param {string} skillId - 技能ID
   * @returns {string[]} 上游依赖技能ID列表
   */
  getDependencies(skillId) {
    this.guardShutdown();
    if (!this._nodes.has(skillId)) return [];
    const predecessors = this._reverseAdjacency.get(skillId);
    if (!predecessors) return [];
    const dependencies = [];
    for (const pred of predecessors) {
      const edgeKey = pred + '\u2192' + skillId;
      const edge = this._edges.get(edgeKey);
      if (edge && (edge.edgeType === 'dependency' || edge.edgeType === 'blocking')) {
        dependencies.push(pred);
      }
    }
    return dependencies;
  }

  /**
   * 使用 BFS 查找两个技能节点之间的最短路径。
   * @param {string} fromId - 起始节点ID
   * @param {string} toId - 目标节点ID
   * @returns {string[]|null} 最短路径节点序列；不可达时返回 null；起点等于终点时返回 [fromId]
   */
  getShortestPath(fromId, toId) {
    this.guardShutdown();
    if (!this._nodes.has(fromId) || !this._nodes.has(toId)) return null;
    if (fromId === toId) return [fromId];
    const visited = new Set([fromId]);
    const queue = [[fromId]];
    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      const neighbors = this._adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (neighbor === toId) {
          return [...path, neighbor];
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }
    return null;
  }

  /**
   * 检测图谱中的所有循环依赖。使用三色 DFS 算法，忽略 semantic 类型边。
   * @returns {Array<string[]>} 循环路径数组，每条路径为构成环的技能ID序列
   */
  detectCycles() {
    this.guardShutdown();
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map();
    const cycles = [];
    for (const id of this._nodes.keys()) {
      color.set(id, WHITE);
    }

    for (const id of this._nodes.keys()) {
      const neighbors = this._adjacency.get(id);
      if (neighbors && neighbors.has(id)) {
        const edgeKey = id + '\u2192' + id;
        const edge = this._edges.get(edgeKey);
        if (edge && edge.edgeType !== 'semantic') {
          cycles.push([id]);
        }
      }
    }

    const self = this;
    function dfs(nodeId, path) {
      color.set(nodeId, GRAY);
      path.push(nodeId);
      const neighbors = self._adjacency.get(nodeId);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (neighbor === nodeId) continue;
          const edgeKey = nodeId + '\u2192' + neighbor;
          const edge = self._edges.get(edgeKey);
          if (!edge || edge.edgeType === 'semantic') continue;
          if (color.get(neighbor) === GRAY) {
            const cycleStart = path.indexOf(neighbor);
            if (cycleStart !== -1) {
              cycles.push(path.slice(cycleStart));
            }
          } else if (color.get(neighbor) === WHITE) {
            dfs(neighbor, path);
          }
        }
      }
      path.pop();
      color.set(nodeId, BLACK);
    }
    for (const id of this._nodes.keys()) {
      if (color.get(id) === WHITE) {
        dfs(id, []);
      }
    }
    return cycles;
  }

  /**
   * 获取图谱统计信息，包括节点数、边数、平均度和连通分量数。
   * @returns {Object} 统计结果
   * @returns {number} return.nodeCount - 节点总数
   * @returns {number} return.edgeCount - 边总数
   * @returns {number} return.avgDegree - 平均出度（保留两位小数）
   * @returns {number} return.componentCount - 连通分量数
   */
  getStats() {
    this.guardShutdown();
    const nodeCount = this._nodes.size;
    const edgeCount = this._edges.size;
    let totalDegree = 0;
    for (const [, neighbors] of this._adjacency) {
      totalDegree += neighbors.size;
    }
    const avgDegree = nodeCount > 0 ? totalDegree / nodeCount : 0;
    const visited = new Set();
    let componentCount = 0;
    for (const id of this._nodes.keys()) {
      if (visited.has(id)) continue;
      componentCount++;
      const queue = [id];
      visited.add(id);
      while (queue.length > 0) {
        const current = queue.shift();
        const outNeighbors = this._adjacency.get(current);
        if (outNeighbors) {
          for (const n of outNeighbors) {
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          }
        }
        const inNeighbors = this._reverseAdjacency.get(current);
        if (inNeighbors) {
          for (const n of inNeighbors) {
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          }
        }
      }
    }
    return {
      nodeCount,
      edgeCount,
      avgDegree: Math.round(avgDegree * 100) / 100,
      componentCount,
    };
  }

  /**
   * 关联 SkillRouter 实例，供后续扩展使用。
   * @param {Object} [router] - SkillRouter 实例
   * @returns {SkillGraph} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    if (!router) return this;
    this._skillRouter = router;
    return this;
  }

  /**
   * 关联 SessionManager 实例，供后续扩展使用。
   * @param {Object} [sessionManager] - SessionManager 实例
   * @returns {SkillGraph} 当前实例，支持链式调用
   */
  attachSessionManager(sessionManager) {
    if (!sessionManager) return this;
    this._sessionManager = sessionManager;
    return this;
  }

  /**
   * 关闭时清理所有内部数据结构。
   */
  _onShutdown() {
    this._nodes.clear();
    this._edges.clear();
    this._adjacency.clear();
    this._reverseAdjacency.clear();
    this._semanticGroups.clear();
    debug('SkillGraph', 'shutdown', 'graph cleared');
    this.removeAllListeners();
  }
}

/** @type {Object} 技能图谱默认配置，同模块级 DEFAULT_CONFIG */
SkillGraph.DEFAULT_CONFIG = DEFAULT_CONFIG;
/** @type {Object} 各边类型默认权重，同模块级 EDGE_DEFAULT_WEIGHTS */
SkillGraph.EDGE_DEFAULT_WEIGHTS = EDGE_DEFAULT_WEIGHTS;
/** @type {Set<string>} 合法边类型集合，同模块级 VALID_EDGE_TYPES */
SkillGraph.VALID_EDGE_TYPES = VALID_EDGE_TYPES;

module.exports = withShutdown(SkillGraph);
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.SkillGraph = SkillGraph;
