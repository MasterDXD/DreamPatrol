'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');

const NODE_TYPES = {
  FILE: 'file',
  FUNCTION: 'function',
  CLASS: 'class',
  MODULE: 'module',
  IMPORT: 'import',
  EXPORT: 'export',
  SEMANTIC: 'semantic',
};

const EDGE_TYPES = {
  IMPORTS: 'imports',
  EXPORTS: 'exports',
  CALLS: 'calls',
  CONTAINS: 'contains',
  DEPENDS_ON: 'depends_on',
  REFERENCES: 'references',
};

const DEFAULT_CONFIG = {
  maxNodes: 10000,
  maxEdges: 20000,
  maxCacheSize: 200,
  deduplicateEdges: true,
};

/**
 * @module runtime/graphify/graph-builder
 * @classdesc 图谱构建器。AST+语义合并、跨文件引用解析、边去重
 */
class GraphBuilder extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._nodes = new Map();
    this._edges = new Map();
    this._nodeKeyIndex = new Map();
    this._edgeKeyIndex = new Map();
    this._nodeIdCounter = 0;
    this._edgeIdCounter = 0;
    this._cache = new BoundedMap(this._config.maxCacheSize);
  }

  /**
   * 从解析后的数据构建图谱节点和边，合并AST结构与语义信息
   * @param {Object} parsedData - 解析后的文件数据，包含 filePath、functions、classes、imports、exports、calls、semantics
   * @returns {{ nodesAdded: number, edgesAdded: number }} 本次构建新增的节点和边数量
   */
  buildFromParsedData(parsedData) {
    this.guardShutdown();
    if (!parsedData || typeof parsedData !== 'object') return { nodesAdded: 0, edgesAdded: 0 };

    let nodesAdded = 0;
    let edgesAdded = 0;

    if (parsedData.filePath) {
      const fileNode = this.addNode({
        type: NODE_TYPES.FILE,
        name: path.basename(parsedData.filePath),
        filePath: parsedData.filePath,
        parser: parsedData.parser,
      });
      if (fileNode) nodesAdded++;

      const fnResult = this._addAstNodes(parsedData, fileNode, 'functions', NODE_TYPES.FUNCTION, EDGE_TYPES.CONTAINS, (fn) => ({ name: fn.name, startRow: fn.startRow, endRow: fn.endRow }));
      nodesAdded += fnResult.nodesAdded;
      edgesAdded += fnResult.edgesAdded;

      const clsResult = this._addAstNodes(parsedData, fileNode, 'classes', NODE_TYPES.CLASS, EDGE_TYPES.CONTAINS, (cls) => ({ name: cls.name, startRow: cls.startRow, endRow: cls.endRow }));
      nodesAdded += clsResult.nodesAdded;
      edgesAdded += clsResult.edgesAdded;

      const impResult = this._addAstNodes(parsedData, fileNode, 'imports', NODE_TYPES.IMPORT, EDGE_TYPES.IMPORTS, (imp) => ({ name: imp.source }));
      nodesAdded += impResult.nodesAdded;
      edgesAdded += impResult.edgesAdded;

      const expResult = this._addAstNodes(parsedData, fileNode, 'exports', NODE_TYPES.EXPORT, EDGE_TYPES.EXPORTS, (exp) => ({ name: exp.name }));
      nodesAdded += expResult.nodesAdded;
      edgesAdded += expResult.edgesAdded;

      const callResult = this._addCallEdges(parsedData, fileNode);
      edgesAdded += callResult.edgesAdded;
    }

    if (parsedData.semantics && Array.isArray(parsedData.semantics)) {
      for (let i = 0; i < parsedData.semantics.length; i++) {
        const sem = parsedData.semantics[i];
        const semNode = this.addNode({
          type: NODE_TYPES.SEMANTIC,
          name: sem.text || sem.type,
          category: sem.category,
          semanticType: sem.type,
          filePath: parsedData.filePath,
        });
        if (semNode) nodesAdded++;
      }
    }

    this.emit('data-built', { nodesAdded, edgesAdded });
    return { nodesAdded, edgesAdded };
  }

  _addAstNodes(parsedData, fileNode, field, nodeType, edgeType, extractProps) {
    let nodesAdded = 0;
    let edgesAdded = 0;
    const items = parsedData[field];
    if (!items || !Array.isArray(items)) return { nodesAdded, edgesAdded };
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const nodeData = { type: nodeType, filePath: parsedData.filePath, ...extractProps(item) };
      const node = this.addNode(nodeData);
      if (node) {
        nodesAdded++;
        const edge = this.addEdge({ source: fileNode.id, target: node.id, type: edgeType });
        if (edge) edgesAdded++;
      }
    }
    return { nodesAdded, edgesAdded };
  }

  _addCallEdges(parsedData, fileNode) {
    let edgesAdded = 0;
    const calls = parsedData.calls;
    if (!calls || !Array.isArray(calls)) return { edgesAdded };
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const callEdge = this.addEdge({ source: fileNode.id, target: call.name, type: EDGE_TYPES.CALLS, weight: 1 });
      if (callEdge) edgesAdded++;
    }
    return { edgesAdded };
  }

  /**
   * 添加节点到图谱，若已存在相同键的节点则返回已有节点
   * @param {{ type: string, name?: string, filePath?: string, startRow?: number, endRow?: number, category?: string, semanticType?: string }} nodeData - 节点数据
   * @returns {Object|null} 添加的节点对象；达到节点上限或数据无效时返回 null
   */
  addNode(nodeData) {
    this.guardShutdown();
    if (!nodeData || !nodeData.type) return null;
    if (this._nodes.size >= this._config.maxNodes) return null;

    const key = this._makeNodeKey(nodeData);
    if (this._nodeKeyIndex.has(key)) {
      return this._nodes.get(this._nodeKeyIndex.get(key));
    }

    const id = 'gn_' + (++this._nodeIdCounter);
    const node = {
      ...nodeData,
      type: nodeData.type,
      name: nodeData.name || '',
      filePath: nodeData.filePath || '',
      id,
    };

    this._nodes.set(id, node);
    this._nodeKeyIndex.set(key, id);
    this.emit('node-added', node);
    return node;
  }

  /**
   * 添加边到图谱，开启去重时相同边会增加权重
   * @param {{ source: string, target: string, type?: string, weight?: number }} edgeData - 边数据
   * @returns {Object|null} 添加的边对象；达到边上限或数据无效时返回 null
   */
  addEdge(edgeData) {
    this.guardShutdown();
    if (!edgeData || edgeData.source == null || edgeData.target == null) return null;
    if (this._edges.size >= this._config.maxEdges) return null;

    const key = this._makeEdgeKey(edgeData);
    if (this._config.deduplicateEdges && this._edgeKeyIndex.has(key)) {
      const existingId = this._edgeKeyIndex.get(key);
      const existing = this._edges.get(existingId);
      if (existing) {
        existing.weight = (existing.weight ?? 1) + 1;
      }
      return existing;
    }

    const id = 'ge_' + (++this._edgeIdCounter);
    const edge = {
      id,
      source: edgeData.source,
      target: edgeData.target,
      type: edgeData.type || EDGE_TYPES.REFERENCES,
      weight: edgeData.weight ?? 1,
    };

    this._edges.set(id, edge);
    this._edgeKeyIndex.set(key, id);
    this.emit('edge-added', edge);
    return edge;
  }

  /**
   * 解析跨文件引用，将名称引用替换为实际节点ID
   * @returns {number} 成功解析的引用数量
   */
  resolveReferences() {
    this.guardShutdown();
    let resolved = 0;

    const nameToNodeIds = new Map();
    for (const [, node] of this._nodes) {
      if (!node.name) continue;
      if (!nameToNodeIds.has(node.name)) {
        nameToNodeIds.set(node.name, []);
      }
      nameToNodeIds.get(node.name).push(node.id);
    }

    const edgesToRemove = [];
    const edgesToAdd = [];

    for (const [edgeId, edge] of this._edges) {
      if (edge.type !== EDGE_TYPES.CALLS && edge.type !== EDGE_TYPES.REFERENCES) continue;

      const targetName = typeof edge.target === 'string' && edge.target.indexOf('gn_') !== 0
        ? edge.target
        : null;

      if (!targetName) continue;

      const candidateIds = nameToNodeIds.get(targetName);
      if (candidateIds && candidateIds.length > 0) {
        edgesToRemove.push(edgeId);
        for (let i = 0; i < candidateIds.length; i++) {
          edgesToAdd.push({
            source: edge.source,
            target: candidateIds[i],
            type: edge.type,
            weight: edge.weight,
          });
        }
        resolved++;
      }
    }

    for (let i = 0; i < edgesToRemove.length; i++) {
      const eid = edgesToRemove[i];
      const edge = this._edges.get(eid);
      if (edge) {
        const key = this._makeEdgeKey(edge);
        this._edgeKeyIndex.delete(key);
      }
      this._edges.delete(eid);
    }

    for (let i = 0; i < edgesToAdd.length; i++) {
      this.addEdge(edgesToAdd[i]);
    }

    this.emit('references-resolved', { resolved });
    return resolved;
  }

  /**
   * 获取完整图谱数据
   * @returns {{ nodes: Map<string, Object>, edges: Map<string, Object>, nodeCount: number, edgeCount: number }} 图谱数据
   */
  getGraph() {
    this.guardShutdown();
    return {
      nodes: new Map(this._nodes),
      edges: new Map(this._edges),
      nodeCount: this._nodes.size,
      edgeCount: this._edges.size,
    };
  }

  /**
   * 根据节点ID获取节点信息
   * @param {string} nodeId - 节点ID
   * @returns {Object|null} 节点信息；不存在时返回 null
   */
  getNode(nodeId) {
    this.guardShutdown();
    const node = this._nodes.get(nodeId); return node ? { ...node } : null;
  }

  /**
   * 根据边ID获取边信息
   * @param {string} edgeId - 边ID
   * @returns {Object|null} 边信息；不存在时返回 null
   */
  getEdge(edgeId) {
    this.guardShutdown();
    const edge = this._edges.get(edgeId); return edge ? { ...edge } : null;
  }

  /**
   * 根据类型获取所有节点
   * @param {string} type - 节点类型（file/function/class/module/import/export/semantic）
   * @returns {Array<Object>} 匹配类型的节点列表
   */
  getNodesByType(type) {
    this.guardShutdown();
    const result = [];
    for (const [, node] of this._nodes) {
      if (node.type === type) result.push({ ...node });
    }
    return result;
  }

  /**
   * 根据类型获取所有边
   * @param {string} type - 边类型（imports/exports/calls/contains/depends_on/references）
   * @returns {Array<Object>} 匹配类型的边列表
   */
  getEdgesByType(type) {
    this.guardShutdown();
    const result = [];
    for (const [, edge] of this._edges) {
      if (edge.type === type) result.push({ ...edge });
    }
    return result;
  }

  /**
   * 根据节点ID获取其关联的所有入边和出边
   * @param {string} nodeId - 节点ID
   * @returns {{ incoming: Array<Object>, outgoing: Array<Object> }} 入边和出边列表
   */
  getEdgesForNode(nodeId) {
    this.guardShutdown();
    const incoming = [];
    const outgoing = [];
    for (const [, edge] of this._edges) {
      if (edge.source === nodeId) outgoing.push({ ...edge });
      if (edge.target === nodeId) incoming.push({ ...edge });
    }
    return { incoming, outgoing };
  }

  _makeNodeKey(nodeData) {
    return nodeData.type + ':' + (nodeData.name || '') + ':' + (nodeData.filePath || '') + ':' + (nodeData.startRow ?? '');
  }

  _makeEdgeKey(edgeData) {
    return String(edgeData.source) + '->' + String(edgeData.target) + ':' + (edgeData.type || '');
  }

  _onShutdown() {
    this._nodes.clear();
    this._edges.clear();
    this._nodeKeyIndex.clear();
    this._edgeKeyIndex.clear();
    this._cache.clear();
    this._nodeIdCounter = 0;
    this._edgeIdCounter = 0;
    this.removeAllListeners();
  }
}

GraphBuilder.NODE_TYPES = NODE_TYPES;
GraphBuilder.EDGE_TYPES = EDGE_TYPES;

module.exports = withShutdown(GraphBuilder);
