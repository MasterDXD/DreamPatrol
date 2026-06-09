'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecuteAsync, emitError } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');

const FileTypeDetector = require('./file-type-detector');
const AstParser = require('./ast-parser');
const SemanticExtractor = require('./semantic-extractor');
const LouvainClusterer = require('./louvain-clusterer');
const GraphBuilder = require('./graph-builder');
const GraphQueryEngine = require('./graph-query-engine');

const PIPELINE_STAGES = ['detect', 'ingest', 'build', 'cluster', 'analyze', 'report', 'export'];

const MAX_FILE_HASHES = 10000;

const DEFAULT_CONFIG = {
  maxFileIndexSize: 5000,
  maxClusterIndexSize: 500,
  maxReportHistorySize: 50,
  maxConcurrency: 4,
  maxFileSize: 1024 * 1024,
  ignorePatterns: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.cache', 'vendor'],
  fileExtensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.md', '.json', '.yaml', '.yml'],
  enableSemanticExtraction: true,
  enableClustering: true,
  enableReport: true,
  reportOutputDir: null,
};

/**
 * @module runtime/graphify/graphify-compiler
 * @classdesc 图谱编译器。7阶段管线（detect→ingest→build→cluster→analyze→report→export）、增量编译
 */
class GraphifyCompiler extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._stages = new Map();
    this._fileIndex = new BoundedMap(this._config.maxFileIndexSize);
    this._clusterIndex = new BoundedMap(this._config.maxClusterIndexSize);
    this._reportHistory = new BoundedArray(this._config.maxReportHistorySize);
    this._pipelineState = 'idle';
    this._costTracker = { totalTokens: 0, totalCalls: 0, stages: {} };
    for (let i = 0; i < PIPELINE_STAGES.length; i++) {
      this._costTracker.stages[PIPELINE_STAGES[i]] = { tokens: 0, calls: 0 };
    }
    this._manifest = { version: 1, createdAt: null, updatedAt: null, fileHashes: {} };
    this._fileHashOrder = [];
    this._lastReport = null;
    this._graphBuilder = new GraphBuilder({
      maxNodes: this._config.maxFileIndexSize * 10,
      maxEdges: this._config.maxFileIndexSize * 20,
    });
    this._queryEngine = new GraphQueryEngine();
    this._fileDetector = new FileTypeDetector();
    this._astParser = new AstParser();
    this._semanticExtractor = new SemanticExtractor({ llmClient: this._config.llmClient });
    this._clusterer = new LouvainClusterer();
    this._compilePromise = null;
    this._initStages();
  }

  _initStages() {
    for (let i = 0; i < PIPELINE_STAGES.length; i++) {
      this._stages.set(PIPELINE_STAGES[i], { status: 'pending', result: null, duration: 0 });
    }
  }

  /**
   * 执行完整的7阶段编译管线（detect→ingest→build→cluster→analyze→report→export）
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 编译选项
   * @param {Array<string>} [options.fileExtensions] - 允许的文件扩展名列表
   * @returns {{ success: boolean, nodeCount?: number, edgeCount?: number, clusterCount?: number, report?: string, manifest?: Object, error?: string }} 编译结果
   */
  async compile(projectRoot, options) {
    this.guardShutdown();
    if (this._compilePromise) return this._compilePromise;
    if (!projectRoot || typeof projectRoot !== 'string') {
      return { success: false, error: 'projectRoot is required' };
    }

    this._compilePromise = (async () => {
      this._pipelineState = 'running';
      this._resetStages();

      try {
        const detectResult = await this._runStage('detect', () => this._detect(projectRoot, options));
        if (!detectResult.success) return this._failCompile('detect', detectResult.error);

        const ingestResult = await this._runStage('ingest', () => this._ingest(detectResult.files));
        if (!ingestResult.success) return this._failCompile('ingest', ingestResult.error);

        const buildResult = await this._runStage('build', () => this._build(ingestResult.parsedFiles));
        if (!buildResult.success) return this._failCompile('build', buildResult.error);

        let clusterResult = { success: true, clusterCount: 0 };
        if (this._config.enableClustering) {
          clusterResult = await this._runStage('cluster', () => this._cluster());
          if (!clusterResult.success) return this._failCompile('cluster', clusterResult.error);
        } else {
          this._stages.set('cluster', { status: 'skipped', result: null, duration: 0 });
        }

        const analyzeResult = await this._runStage('analyze', () => this._analyze());
        if (!analyzeResult.success) return this._failCompile('analyze', analyzeResult.error);

        let reportResult = { success: true, report: null };
        if (this._config.enableReport) {
          reportResult = await this._runStage('report', () => this._report(analyzeResult));
          if (!reportResult.success) return this._failCompile('report', reportResult.error);
        } else {
          this._stages.set('report', { status: 'skipped', result: null, duration: 0 });
        }

        const exportResult = await this._runStage('export', () => this._export());
        if (!exportResult.success) return this._failCompile('export', exportResult.error);

        this._pipelineState = 'completed';
        this._manifest.updatedAt = new Date().toISOString();

        this.emit('compile-completed', {
          nodeCount: this._graphBuilder.getGraph().nodeCount,
          edgeCount: this._graphBuilder.getGraph().edgeCount,
          clusterCount: clusterResult.clusterCount ?? 0,
        });

        return {
          success: true,
          nodeCount: this._graphBuilder.getGraph().nodeCount,
          edgeCount: this._graphBuilder.getGraph().edgeCount,
          clusterCount: clusterResult.clusterCount ?? 0,
          report: reportResult.report,
          manifest: this._manifest,
        };
      } catch (err) {
        this._pipelineState = 'failed';
        debug('GraphifyCompiler', 'compile', err);
        emitError(this, 'error', err);
        return { success: false, error: err && err.message ? err.message : String(err) };
      } finally {
        this._compilePromise = null;
      }
    })();

    return this._compilePromise;
  }

  /**
   * 增量编译，仅重新处理发生变更的文件
   * @param {string} projectRoot - 项目根目录路径
   * @param {Array<string>} changedFiles - 变更文件路径列表
   * @returns {{ success: boolean, reprocessedFiles?: number, nodeCount?: number, edgeCount?: number, error?: string }} 增量编译结果
   */
  async compileIncremental(projectRoot, changedFiles) {
    this.guardShutdown();
    if (this._compilePromise) return this._compilePromise;
    if (!projectRoot || typeof projectRoot !== 'string') {
      return { success: false, error: 'projectRoot is required' };
    }
    if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
      return { success: true, nodeCount: this._graphBuilder.getGraph().nodeCount, edgeCount: this._graphBuilder.getGraph().edgeCount, message: 'No changes to process' };
    }

    this._compilePromise = (async () => {
      this._pipelineState = 'incremental';

      try {
        const files = [];
        for (let i = 0; i < changedFiles.length; i++) {
          const filePath = changedFiles[i];
          const detection = this._fileDetector.detect(filePath);
          if (detection.type === 'unknown') continue;

          const content = await safeExecuteAsync(
            () => fs.promises.readFile(filePath, 'utf-8'),
            'GraphifyCompiler', 'readFile-incremental',
            null,
          );

          if (content === null) {
            // 文件读取失败不中断增量编译，仅发出事件通知上层追踪
            this.emit('file-read-error', { filePath });
            continue;
          }
          if (!content) continue;

          const hash = this._computeHash(content);
          const oldHash = this._manifest.fileHashes[filePath];
          if (oldHash === hash) continue;

          if (oldHash === undefined) {
            this._fileHashOrder.push(filePath);
          }
          this._manifest.fileHashes[filePath] = hash;
          if (this._fileHashOrder.length > MAX_FILE_HASHES) {
            const oldestKey = this._fileHashOrder.shift();
            delete this._manifest.fileHashes[oldestKey];
          }
          files.push({ filePath, content, type: detection.type, category: detection.category });
        }

        if (files.length === 0) {
          this._pipelineState = 'idle';
          return { success: true, nodeCount: this._graphBuilder.getGraph().nodeCount, edgeCount: this._graphBuilder.getGraph().edgeCount, message: 'No changed files need reprocessing' };
        }

        const parsedFiles = await this._parseFiles(files);

        for (let i = 0; i < parsedFiles.length; i++) {
          this._graphBuilder.buildFromParsedData(parsedFiles[i]);
        }

        this._graphBuilder.resolveReferences();

        if (this._config.enableClustering) {
          this._cluster();
        }

        this._manifest.updatedAt = new Date().toISOString();
        this._pipelineState = 'idle';

        return {
          success: true,
          reprocessedFiles: files.length,
          nodeCount: this._graphBuilder.getGraph().nodeCount,
          edgeCount: this._graphBuilder.getGraph().edgeCount,
        };
      } catch (err) {
        this._pipelineState = 'failed';
        debug('GraphifyCompiler', 'compileIncremental', err);
        emitError(this, 'error', err);
        return { success: false, error: err && err.message ? err.message : String(err) };
      } finally {
        this._compilePromise = null;
      }
    })();

    return this._compilePromise;
  }

  /**
   * 查询图谱，委托给内部查询引擎执行
   * @param {Object} querySpec - 查询规格，支持 nodeId、type、name、clusterId 等条件
   * @returns {{ results: Array<Object>, strategy: string }} 查询结果
   */
  async query(querySpec) {
    this.guardShutdown();
    return this._queryEngine.query(querySpec);
  }

  /**
   * 根据节点ID获取节点信息
   * @param {string} nodeId - 节点ID
   * @returns {Object|null} 节点信息；不存在时返回 null
   */
  getNode(nodeId) {
    this.guardShutdown();
    return this._graphBuilder.getNode(nodeId);
  }

  /**
   * 根据节点ID获取其关联的所有边
   * @param {string} nodeId - 节点ID
   * @returns {{ incoming: Array<Object>, outgoing: Array<Object> }} 入边和出边列表
   */
  getEdges(nodeId) {
    this.guardShutdown();
    return this._graphBuilder.getEdgesForNode(nodeId);
  }

  /**
   * 根据聚类ID获取聚类信息
   * @param {string} clusterId - 聚类ID
   * @returns {Object|null} 聚类信息；不存在时返回 null
   */
  getCluster(clusterId) {
    this.guardShutdown();
    return this._clusterIndex.get(clusterId) ?? null;
  }

  /**
   * 获取最近一次编译的报告
   * @returns {string|null} Markdown格式的编译报告；未编译时返回 null
   */
  getReport() {
    this.guardShutdown();
    return this._lastReport;
  }

  /**
   * 获取编译管线的统计信息
   * @returns {{ pipelineState: string, nodeCount: number, edgeCount: number, fileCount: number, clusterCount: number, stages: Object }} 统计信息
   */
  getStats() {
    this.guardShutdown();
    const graph = this._graphBuilder.getGraph();
    const stageStats = {};
    for (const [name, stage] of this._stages) {
      stageStats[name] = { status: stage.status, duration: stage.duration };
    }

    return {
      pipelineState: this._pipelineState,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      fileCount: this._fileIndex.size,
      clusterCount: this._clusterIndex.size,
      stages: stageStats,
    };
  }

  /**
   * 获取Token消耗成本报告，包含语义提取和管线各阶段的成本
   * @returns {{ totalTokens: number, totalCalls: number, stages: Object }} 成本报告
   */
  getCostReport() {
    this.guardShutdown();
    const semanticCost = this._semanticExtractor.getCostReport();
    return {
      totalTokens: this._costTracker.totalTokens + semanticCost.totalTokens,
      totalCalls: this._costTracker.totalCalls + semanticCost.totalCalls,
      stages: { ...this._costTracker.stages, semantic: semanticCost },
    };
  }

  /**
   * 获取编译清单，包含版本号、时间戳和文件哈希
   * @returns {{ version: number, createdAt: string|null, updatedAt: string|null, fileHashes: Object }} 编译清单副本
   */
  getManifest() {
    this.guardShutdown();
    return { ...this._manifest, fileHashes: { ...this._manifest.fileHashes } };
  }

  async _runStage(stageName, fn) {
    const start = Date.now();
    this._stages.set(stageName, { status: 'running', result: null, duration: 0 });
    this.emit('stage-started', { stage: stageName });

    try {
      const result = await safeExecuteAsync(fn, 'GraphifyCompiler', 'stage-' + stageName, null);

      const duration = Date.now() - start;
      this._stages.set(stageName, { status: 'completed', result, duration });
      this.emit('stage-completed', { stage: stageName, duration });

      if (!result) {
        return { success: false, error: 'Stage ' + stageName + ' returned no result' };
      }

      return result;
    } catch (err) {
      const duration = Date.now() - start;
      this._stages.set(stageName, { status: 'failed', result: null, duration });
      this.emit('stage-failed', { stage: stageName, error: err && err.message ? err.message : String(err) });
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _detect(projectRoot, options) {
    const opts = options ?? {};
    const files = [];

    const scanDir = async (dir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (_e) {
        debug('GraphifyCompiler', 'scanDirFailed', _e && _e.message ? _e.message : String(_e));
        return;
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (this._shouldIgnoreDir(entry.name)) continue;
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          const detection = this._fileDetector.detect(fullPath);
          if (detection.type === 'unknown') continue;

          const extensions = opts.fileExtensions ?? this._config.fileExtensions;
          const ext = path.extname(fullPath).toLowerCase();
          if (extensions && Array.isArray(extensions) && extensions.length > 0 && extensions.indexOf(ext) < 0) continue;

          this._fileIndex.set(fullPath, { type: detection.type, category: detection.category, extension: detection.extension });
          files.push({ filePath: fullPath, type: detection.type, category: detection.category });
        }
      }
    };

    await scanDir(projectRoot);

    return { success: true, files, fileCount: files.length };
  }

  _shouldIgnoreDir(dirName) {
    const ignore = this._config.ignorePatterns;
    for (let i = 0; i < ignore.length; i++) {
      if (dirName === ignore[i] || dirName.startsWith(ignore[i])) return true;
    }
    return dirName.startsWith('.');
  }

  async _ingest(files) {
    const parsedFiles = [];

    for (let i = 0; i < files.length; i++) {
      const fileInfo = files[i];
      const content = await safeExecuteAsync(
        () => fs.promises.readFile(fileInfo.filePath, 'utf-8'),
        'GraphifyCompiler', 'readFile',
        null,
      );

      if (content === null) {
        // 文件读取失败不中断管线，仅发出事件通知上层追踪
        this.emit('file-read-error', { filePath: fileInfo.filePath });
        continue;
      }
      if (!content) continue;
      if (content.length > this._config.maxFileSize) continue;

      const hash = this._computeHash(content);
      if (this._manifest.fileHashes[fileInfo.filePath] === undefined) {
        this._fileHashOrder.push(fileInfo.filePath);
      }
      this._manifest.fileHashes[fileInfo.filePath] = hash;
      if (this._fileHashOrder.length > MAX_FILE_HASHES) {
        const oldestKey = this._fileHashOrder.shift();
        delete this._manifest.fileHashes[oldestKey];
      }

      parsedFiles.push({ filePath: fileInfo.filePath, content, type: fileInfo.type, category: fileInfo.category });
    }

    if (!this._manifest.createdAt) {
      this._manifest.createdAt = new Date().toISOString();
    }

    return { success: true, parsedFiles, fileCount: parsedFiles.length };
  }

  async _build(parsedFiles) {
    const results = await this._parseFiles(parsedFiles);

    let totalNodes = 0;
    let totalEdges = 0;

    for (let i = 0; i < results.length; i++) {
      const buildResult = this._graphBuilder.buildFromParsedData(results[i]);
      totalNodes += buildResult.nodesAdded;
      totalEdges += buildResult.edgesAdded;
    }

    const resolvedCount = this._graphBuilder.resolveReferences();

    return { success: true, totalNodes, totalEdges, resolvedReferences: resolvedCount };
  }

  async _parseFiles(files) {
    const results = [];
    const astFiles = [];
    const textFiles = [];
    const multimodalFiles = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.category === 'ast') astFiles.push(f);
      else if (f.category === 'multimodal') multimodalFiles.push(f);
      else textFiles.push(f);
    }

    if (astFiles.length > 0) {
      const astResults = await this._astParser.parseBatch(
        astFiles.map(f => ({ filePath: f.filePath, content: f.content })),
      );
      for (const [, parsed] of astResults) {
        results.push(parsed);
      }
    }

    for (let i = 0; i < textFiles.length; i++) {
      const f = textFiles[i];
      if (this._config.enableSemanticExtraction) {
        const semanticResult = await this._semanticExtractor.extractSemantic(f.filePath, f.content, f.type);
        results.push(semanticResult);
      } else {
        results.push({ filePath: f.filePath, semantics: [], parser: 'text-skip' });
      }
    }

    for (let i = 0; i < multimodalFiles.length; i++) {
      const f = multimodalFiles[i];
      const semanticResult = await this._semanticExtractor.extractSemantic(f.filePath, f.content, f.type);
      results.push(semanticResult);
    }

    return results;
  }

  _cluster() {
    const graph = this._graphBuilder.getGraph();
    const result = this._clusterer.cluster(graph);

    if (result && result.clusters) {
      for (const [clusterId, cluster] of result.clusters) {
        this._clusterIndex.set(clusterId, cluster);
      }
    }

    this._queryEngine.attachGraph(graph, result ? result.clusters : new Map());

    return { success: true, clusterCount: result ? result.clusters.size : 0, modularity: result ? result.modularity : 0 };
  }

  _analyze() {
    const _graph = this._graphBuilder.getGraph();
    const overview = this._queryEngine.getArchitectureOverview();

    const analysis = {
      totalNodes: overview.totalNodes,
      totalEdges: overview.totalEdges,
      totalClusters: overview.totalClusters,
      nodeTypes: overview.nodeTypes,
      edgeTypes: overview.edgeTypes,
      clusterSizes: overview.clusters.map(c => c.size),
      avgClusterSize: overview.clusters.length > 0
        ? overview.clusters.reduce((sum, c) => sum + c.size, 0) / overview.clusters.length
        : 0,
    };

    return { success: true, analysis };
  }

  _report(analyzeResult) {
    const analysis = analyzeResult.analysis;
    const lines = [];

    lines.push('# Graphify Compilation Report');
    lines.push('');
    lines.push('## Overview');
    lines.push('- Total Nodes: ' + (analysis.totalNodes ?? 0));
    lines.push('- Total Edges: ' + (analysis.totalEdges ?? 0));
    lines.push('- Total Clusters: ' + (analysis.totalClusters ?? 0));
    lines.push('- Avg Cluster Size: ' + (analysis.avgClusterSize ?? 0).toFixed(2));
    lines.push('');

    lines.push('## Node Types');
    const nodeTypes = analysis.nodeTypes ?? {};
    const ntKeys = Object.keys(nodeTypes);
    for (let i = 0; i < ntKeys.length; i++) {
      lines.push('- ' + ntKeys[i] + ': ' + nodeTypes[ntKeys[i]]);
    }
    lines.push('');

    lines.push('## Edge Types');
    const edgeTypes = analysis.edgeTypes ?? {};
    const etKeys = Object.keys(edgeTypes);
    for (let i = 0; i < etKeys.length; i++) {
      lines.push('- ' + etKeys[i] + ': ' + edgeTypes[etKeys[i]]);
    }
    lines.push('');

    lines.push('## Clusters');
    const clusters = analysis.clusterSizes ?? [];
    for (let i = 0; i < clusters.length; i++) {
      lines.push('- Cluster ' + i + ': ' + clusters[i] + ' nodes');
    }

    const report = lines.join('\n');
    this._lastReport = report;
    this._reportHistory.push({ report, generatedAt: new Date().toISOString() });

    return { success: true, report };
  }

  _export() {
    const graph = this._graphBuilder.getGraph();
    const nodes = [];
    const edges = [];

    for (const [, node] of graph.nodes) {
      nodes.push(node);
    }
    for (const [, edge] of graph.edges) {
      edges.push(edge);
    }

    const clusters = [];
    for (const [clusterId, cluster] of this._clusterIndex) {
      clusters.push({ id: clusterId, size: cluster.size, nodeIds: cluster.nodeIds });
    }

    return {
      success: true,
      graph: { nodes, edges },
      clusters,
      manifest: { ...this._manifest },
    };
  }

  /**
   * 将编译后的图谱导出为Mermaid流程图格式。
   * 生成架构图可视化，用于"先画架构图再让AI写代码"的文档先行门禁。
   * @param {Object} [options] - 导出选项
   * @param {boolean} [options.showClusters=true] - 是否显示聚类分组
   * @param {boolean} [options.showEdgeLabels=false] - 是否显示边标签
   * @param {number} [options.maxNodes=50] - 最大显示节点数
   * @returns {{ success: boolean, mermaid: string, nodeCount: number, edgeCount: number }}
   */
  exportMermaid(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const showClusters = opts.showClusters !== false;
    const showEdgeLabels = opts.showEdgeLabels === true;
    const maxNodes = opts.maxNodes ?? 50;

    const graph = this._graphBuilder.getGraph();
    if (!graph || !graph.nodes || graph.nodes.size === 0) {
      return { success: false, mermaid: '', nodeCount: 0, edgeCount: 0 };
    }

    const lines = ['graph TD'];
    const nodeIdMap = new Map();

    const edgeCountMap = this._buildEdgeCountMap(graph);
    const sortedNodes = [...graph.nodes.entries()]
      .sort(function(a, b) { return (edgeCountMap.get(b[0]) ?? 0) - (edgeCountMap.get(a[0]) ?? 0); })
      .slice(0, maxNodes);

    this._renderNodes(sortedNodes, nodeIdMap, lines);

    if (showClusters && this._clusterIndex.size > 0) {
      this._renderClusters(nodeIdMap, lines);
    }

    const edgeCount = this._renderEdges(graph, nodeIdMap, showEdgeLabels, lines);

    const mermaid = lines.join('\n');
    return {
      success: true,
      mermaid: mermaid,
      nodeCount: sortedNodes.length,
      edgeCount: edgeCount,
    };
  }

  /**
   * 构建边计数映射
   * @param {Object} graph - 图谱对象
   * @returns {Map<string, number>} 节点ID到边数的映射
   * @private
   */
  _buildEdgeCountMap(graph) {
    const edgeCountMap = new Map();
    for (const [, edge] of graph.edges) {
      edgeCountMap.set(edge.source, (edgeCountMap.get(edge.source) ?? 0) + 1);
      edgeCountMap.set(edge.target, (edgeCountMap.get(edge.target) ?? 0) + 1);
    }
    return edgeCountMap;
  }

  /**
   * 渲染节点到Mermaid行
   * @param {Array} sortedNodes - 排序后的节点列表
   * @param {Map} nodeIdMap - 节点ID映射
   * @param {string[]} lines - Mermaid行数组
   * @private
   */
  _renderNodes(sortedNodes, nodeIdMap, lines) {
    let idx = 0;
    for (const [nodeId, node] of sortedNodes) {
      const safeId = 'N' + idx++;
      nodeIdMap.set(nodeId, safeId);
      const label = (node.name || node.filePath || nodeId).replace(/^.*[\\/]/, '').replace(/\.(js|ts|mjs|cjs)$/, '');
      lines.push('  ' + safeId + '["' + label + '"]');
    }
  }

  /**
   * 渲染聚类到Mermaid行
   * @param {Map} nodeIdMap - 节点ID映射
   * @param {string[]} lines - Mermaid行数组
   * @private
   */
  _renderClusters(nodeIdMap, lines) {
    for (const [clusterId, cluster] of this._clusterIndex) {
      const memberIds = (cluster.nodeIds ?? [])
        .map(function(nId) { return nodeIdMap.get(nId); })
        .filter(Boolean);
      if (memberIds.length > 0) {
        lines.push('  subgraph ' + clusterId + '["Cluster: ' + clusterId + '"]');
        memberIds.forEach(function(mId) { lines.push('    ' + mId); });
        lines.push('  end');
      }
    }
  }

  /**
   * 渲染边到Mermaid行
   * @param {Object} graph - 图谱对象
   * @param {Map} nodeIdMap - 节点ID映射
   * @param {boolean} showEdgeLabels - 是否显示边标签
   * @param {string[]} lines - Mermaid行数组
   * @returns {number} 渲染的边数
   * @private
   */
  _renderEdges(graph, nodeIdMap, showEdgeLabels, lines) {
    let edgeCount = 0;
    for (const [, edge] of graph.edges) {
      const fromId = nodeIdMap.get(edge.source);
      const toId = nodeIdMap.get(edge.target);
      if (fromId && toId) {
        const label = showEdgeLabels && edge.type ? '|"' + edge.type + '"|' : '';
        lines.push('  ' + fromId + ' -->' + label + ' ' + toId);
        edgeCount++;
      }
    }
    return edgeCount;
  }

  _failCompile(stageName, error) {
    this._pipelineState = 'failed';
    return { success: false, error: error || 'Failed at stage: ' + stageName, failedStage: stageName };
  }

  _resetStages() {
    for (let i = 0; i < PIPELINE_STAGES.length; i++) {
      this._stages.set(PIPELINE_STAGES[i], { status: 'pending', result: null, duration: 0 });
    }
  }

  /**
   * @description 使用SHA-256计算内容指纹（v2.11.0从MD5升级）
   * @param {string} content - 待计算哈希的内容
   * @returns {string} SHA-256十六进制摘要
   */
  _computeHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  _onShutdown() {
    this._fileIndex.clear();
    this._clusterIndex.clear();
    this._reportHistory.clear();
    this._stages.clear();
    this._costTracker = { totalTokens: 0, totalCalls: 0, stages: {} };
    this._manifest = { version: 1, createdAt: null, updatedAt: null, fileHashes: {} };
    this._fileHashOrder = [];
    this._lastReport = null;
    this._pipelineState = 'shutdown';

    if (this._graphBuilder && typeof this._graphBuilder.shutdown === 'function') {
      this._graphBuilder.shutdown();
    }
    if (this._queryEngine && typeof this._queryEngine.shutdown === 'function') {
      this._queryEngine.shutdown();
    }
    if (this._fileDetector && typeof this._fileDetector.shutdown === 'function') {
      this._fileDetector.shutdown();
    }
    if (this._astParser && typeof this._astParser.shutdown === 'function') {
      this._astParser.shutdown();
    }
    if (this._semanticExtractor && typeof this._semanticExtractor.shutdown === 'function') {
      this._semanticExtractor.shutdown();
    }
    if (this._clusterer && typeof this._clusterer.shutdown === 'function') {
      this._clusterer.shutdown();
    }
    this.removeAllListeners();
  }
}

GraphifyCompiler.PIPELINE_STAGES = PIPELINE_STAGES;

module.exports = withShutdown(GraphifyCompiler);
