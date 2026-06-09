'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');
const BoundedArray = require('../../utils/bounded-array');
const { generateId } = require('../../utils/id-generator');

/**
 * Code Wiki编译状态
 * @readonly
 * @enum {string}
 */
const WIKI_COMPILE_STATUS = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  PARSING: 'parsing',
  INDEXING: 'indexing',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * 文档类型
 * @readonly
 * @enum {string}
 */
const DOC_TYPES = {
  ARCHITECTURE: 'architecture',
  MODULE: 'module',
  API: 'api',
  CLASS: 'class',
  FUNCTION: 'function',
  README: 'readme',
  PATTERN: 'pattern',
};

/**
 * 查询来源优先级
 * @readonly
 * @enum {number}
 */
const SOURCE_PRIORITY = {
  GRAPH: 10,
  WIKI: 8,
  RAG: 6,
  MEMORY: 4,
};

const MAX_WIKI_ENTRIES = 5000;
const MAX_QUERY_RESULTS = 100;
const MAX_CHAT_HISTORY = 50;
const DEFAULT_TOP_K = 5;

/**
 * @module runtime/skill/code-wiki-orchestrator
 * Code Wiki编排器。融合Google Code Wiki理念，将现有代码理解基础设施
 * （GraphifyCompiler、CodeGraph、KnowledgeBasePipeline、LlmWiki、
 * GraphRAG、RAGPipeline、DocFreshnessGuard）统一编排为6大核心能力：
 *
 * 1. 自动更新实时同步 — 代码变更时自动重新扫描和索引
 * 2. 智能上下文感知 — 跨模块联合查询，深度理解代码库
 * 3. 高度集成可操作 — 文档直接链接到文件/函数/类
 * 4. 自动生成可视化图表 — 架构图、依赖图、类图
 * 5. 内置AI聊天 — 回答代码库具体问题
 * 6. AI编码助手上下文生成 — copilot-instructions风格文件
 *
 * @classdesc 代码Wiki编排器。5阶段编译管线（扫描→解析→索引→生成→导出），GraphifyCompiler+CodeGraph双源融合，Mermaid架构图生成，AI聊天式代码库查询，上下文文件自动生成。
 * @extends EventEmitter
 *
 * @example
 * const wiki = new CodeWikiOrchestrator({ projectRoot: '/path/to/project' });
 * wiki.attachGraphifyCompiler(compiler);
 * wiki.attachCodeGraph(codeGraph);
 * wiki.attachLlmWiki(llmWiki);
 * wiki.attachRagPipeline(ragPipeline);
 * wiki.attachGraphRag(graphRag);
 * wiki.attachDocFreshnessGuard(guard);
 * wiki.attachKnowledgeBasePipeline(kbPipeline);
 * wiki.attachAutoVersionTracker(tracker);
 * await wiki.compile();
 * const result = await wiki.query('How does the session management work?');
 */
class CodeWikiOrchestrator extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.projectRoot - 项目根目录（必须）
   * @param {number} [options.maxWikiEntries=5000] - Wiki条目上限
   * @param {number} [options.maxQueryResults=100] - 查询结果上限
   * @param {number} [options.maxChatHistory=50] - 聊天历史上限
   * @param {boolean} [options.autoRecompile=true] - 代码变更时自动重编译
   * @param {boolean} [options.generateContextFile=true] - 生成AI助手上下文文件
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    if (!opts.projectRoot || typeof opts.projectRoot !== 'string') {
      throw new Error('projectRoot is required and must be a string');
    }
    this._projectRoot = opts.projectRoot;
    this._maxWikiEntries = typeof opts.maxWikiEntries === 'number' && opts.maxWikiEntries > 0
      ? Math.min(opts.maxWikiEntries, MAX_WIKI_ENTRIES) : MAX_WIKI_ENTRIES;
    this._maxQueryResults = typeof opts.maxQueryResults === 'number' && opts.maxQueryResults > 0
      ? Math.min(opts.maxQueryResults, MAX_QUERY_RESULTS) : MAX_QUERY_RESULTS;
    this._maxChatHistory = typeof opts.maxChatHistory === 'number' && opts.maxChatHistory > 0
      ? Math.min(opts.maxChatHistory, MAX_CHAT_HISTORY) : MAX_CHAT_HISTORY;
    this._autoRecompile = opts.autoRecompile !== false;
    this._generateContextFile = opts.generateContextFile !== false;

    // 依赖注入的模块引用
    this._graphifyCompiler = null;
    this._codeGraph = null;
    this._llmWiki = null;
    this._ragPipeline = null;
    this._graphRag = null;
    this._docFreshnessGuard = null;
    this._knowledgeBasePipeline = null;
    this._autoVersionTracker = null;
    this._embeddingService = null;

    // 内部状态
    this._compileStatus = WIKI_COMPILE_STATUS.IDLE;
    this._wikiIndex = new Map();
    this._chatHistory = new BoundedArray(this._maxChatHistory);
    this._lastCompileResult = null;
    this._stats = {
      totalCompiles: 0,
      totalQueries: 0,
      totalChatTurns: 0,
      avgCompileTimeMs: 0,
      avgQueryTimeMs: 0,
      wikiEntryCount: 0,
      linkedDocCount: 0,
    };
    this._compileTimeSum = 0;
    this._queryTimeSum = 0;
  }

  // ─── 依赖注入（10个attach点） ─────────────────────────────

  /**
   * 附加GraphifyCompiler实例（7阶段图谱编译管线）
   * @param {object} compiler - GraphifyCompiler实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachGraphifyCompiler(compiler) {
    if (compiler && typeof compiler.compile === 'function') {
      this._graphifyCompiler = compiler;
    }
    return this;
  }

  /**
   * 附加CodeGraph实例（代码依赖图）
   * @param {object} codeGraph - CodeGraph实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachCodeGraph(codeGraph) {
    if (codeGraph && typeof codeGraph.scanDirectory === 'function') {
      this._codeGraph = codeGraph;
    }
    return this;
  }

  /**
   * 附加LlmWiki实例（结构化知识库）
   * @param {object} wiki - LlmWiki实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachLlmWiki(wiki) {
    if (wiki && typeof wiki.search === 'function') {
      this._llmWiki = wiki;
    }
    return this;
  }

  /**
   * 附加RAGPipeline实例（向量检索管道）
   * @param {object} pipeline - RAGPipeline实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachRagPipeline(pipeline) {
    if (pipeline && typeof pipeline.query === 'function') {
      this._ragPipeline = pipeline;
    }
    return this;
  }

  /**
   * 附加GraphRAG实例（图谱检索引擎）
   * @param {object} graphRag - GraphRAG实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachGraphRag(graphRag) {
    if (graphRag && typeof graphRag.query === 'function') {
      this._graphRag = graphRag;
    }
    return this;
  }

  /**
   * 附加DocFreshnessGuard实例（文档新鲜度守卫）
   * @param {object} guard - DocFreshnessGuard实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachDocFreshnessGuard(guard) {
    if (guard && typeof guard.getStaleDocs === 'function') {
      this._docFreshnessGuard = guard;
    }
    return this;
  }

  /**
   * 附加KnowledgeBasePipeline实例（知识库管道）
   * @param {object} pipeline - KnowledgeBasePipeline实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachKnowledgeBasePipeline(pipeline) {
    if (pipeline && typeof pipeline.query === 'function') {
      this._knowledgeBasePipeline = pipeline;
    }
    return this;
  }

  /**
   * 附加AutoVersionTracker实例（版本追踪器）
   * @param {object} tracker - AutoVersionTracker实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachAutoVersionTracker(tracker) {
    if (tracker && typeof tracker.getRecentRecords === 'function') {
      this._autoVersionTracker = tracker;
    }
    return this;
  }

  /**
   * 附加EmbeddingService实例（嵌入服务）
   * @param {object} service - EmbeddingService实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachEmbeddingService(service) {
    if (service && typeof service.embed === 'function') {
      this._embeddingService = service;
    }
    return this;
  }

  /**
   * 附加事件总线（用于监听代码变更事件）
   * @param {object} eventBus - EventBus实例
   * @returns {CodeWikiOrchestrator} 当前实例
   */
  attachEventBus(eventBus) {
    if (eventBus && typeof eventBus.on === 'function' && this._autoRecompile) {
      this._setupAutoRecompile(eventBus);
    }
    return this;
  }

  // ─── 核心能力1：自动更新实时同步 ───────────────────────────

  /**
   * 执行完整的Code Wiki编译流程。
   * 1. 扫描代码库（CodeGraph + GraphifyCompiler）
   * 2. 解析AST和语义（GraphifyCompiler内部管线）
   * 3. 索引到知识库（LlmWiki + RAGPipeline + GraphRAG）
   * 4. 生成文档和图表
   * 5. 生成AI助手上下文文件
   * @param {object} [options]
   * @param {boolean} [options.force=false] - 强制全量重编译
   * @param {string[]} [options.changedFiles] - 增量编译的变更文件列表
   * @returns {Promise<{success: boolean, entryCount: number, compileTimeMs: number, diagrams: object, contextFile: string|null}>}
   */
  async compile(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const startTime = Date.now();
    this._compileStatus = WIKI_COMPILE_STATUS.SCANNING;
    this.emit('compile-started', { projectRoot: this._projectRoot, force: opts.force });

    try {
      // 阶段1+2：图谱编译和代码依赖图扫描
      this._compileStatus = WIKI_COMPILE_STATUS.PARSING;
      const { graphResult, codeGraphResult } = await this._compileGraphs(opts);

      // 阶段3：索引到知识库
      this._compileStatus = WIKI_COMPILE_STATUS.INDEXING;
      await this._indexToKnowledgeBases(graphResult, codeGraphResult);

      // 阶段4：生成文档和图表
      this._compileStatus = WIKI_COMPILE_STATUS.GENERATING;
      const diagrams = this._generateDiagrams(graphResult, codeGraphResult);

      // 阶段5：生成AI助手上下文文件
      let contextFile = null;
      if (this._generateContextFile) {
        contextFile = this._generateContextFileContent(graphResult, codeGraphResult);
      }

      const compileTimeMs = Date.now() - startTime;
      this._compileStatus = WIKI_COMPILE_STATUS.COMPLETED;
      this._stats.totalCompiles++;
      this._compileTimeSum += compileTimeMs;
      this._stats.avgCompileTimeMs = this._stats.totalCompiles > 0 ? Math.round(this._compileTimeSum / this._stats.totalCompiles) : 0;

      this._lastCompileResult = {
        success: true,
        entryCount: this._wikiIndex.size,
        compileTimeMs,
        diagrams,
        contextFile,
        graphResult: graphResult ? { nodeCount: graphResult.nodeCount, edgeCount: graphResult.edgeCount, clusterCount: graphResult.clusterCount } : null,
        codeGraphResult: codeGraphResult ? { files: codeGraphResult.files ? codeGraphResult.files.length : 0, edges: codeGraphResult.edges ? codeGraphResult.edges.length : 0 } : null,
        compiledAt: new Date().toISOString(),
      };

      this.emit('compile-completed', safeAssign({}, this._lastCompileResult));
      return safeAssign({}, this._lastCompileResult);
    } catch (err) {
      this._compileStatus = WIKI_COMPILE_STATUS.FAILED;
      debug('CodeWikiOrchestrator', 'compile', err && err.message ? err.message : String(err));
      this.emit('compile-failed', { error: err && err.message ? err.message : String(err) });
      return { success: false, entryCount: 0, compileTimeMs: Date.now() - startTime, diagrams: {}, contextFile: null, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 编译图谱和代码依赖图（阶段1+2）
   * @param {Object} opts - 编译选项
   * @returns {Promise<{graphResult: Object|null, codeGraphResult: Object|null}>}
   */
  async _compileGraphs(opts) {
    let graphResult = null;
    if (this._graphifyCompiler) {
      if (opts.force || !this._lastCompileResult) {
        graphResult = await this._graphifyCompiler.compile(this._projectRoot, { force: opts.force });
      } else if (opts.changedFiles && opts.changedFiles.length > 0) {
        graphResult = await this._graphifyCompiler.compileIncremental(this._projectRoot, opts.changedFiles);
      }
    }
    let codeGraphResult = null;
    if (this._codeGraph && (opts.force || !this._lastCompileResult)) {
      codeGraphResult = await this._codeGraph.scanDirectory(this._projectRoot);
    }
    return { graphResult, codeGraphResult };
  }

  /**
   * 处理代码变更，触发增量更新
   * @param {string} filePath - 变更文件路径
   * @param {string} changeType - 变更类型（create/modify/delete）
   * @returns {Promise<{recompiled: boolean, staleDocs: Array}>}
   */
  async handleCodeChange(filePath, changeType) {
    this.guardShutdown();
    const result = { recompiled: false, staleDocs: [] };

    // 检测过时文档
    if (this._docFreshnessGuard) {
      try {
        result.staleDocs = this._docFreshnessGuard.handleCodeChange(filePath, changeType) ?? [];
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'handleCodeChange-freshness', _e && _e.message ? _e.message : String(_e));
      }
    }

    // 自动重编译
    if (this._autoRecompile && this._graphifyCompiler) {
      try {
        await this.compile({ changedFiles: [filePath] });
        result.recompiled = true;
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'handleCodeChange-recompile', _e && _e.message ? _e.message : String(_e));
      }
    }

    this.emit('code-change-handled', { filePath, changeType, recompiled: result.recompiled, staleDocCount: result.staleDocs.length });
    return result;
  }

  // ─── 核心能力2+3：智能上下文感知查询 + 高度集成可操作 ──────

  /**
   * 智能查询代码库。跨Graph/Wiki/RAG/Memory四源联合检索，
   * 结果包含可直接跳转到源码的深度链接。
   * @param {string} queryText - 查询文本
   * @param {object} [options]
   * @param {number} [options.topK=5] - 每源返回结果数
   * @param {string[]} [options.sources] - 限定查询来源（graph/wiki/rag/memory）
   * @param {boolean} [options.includeLinks=true] - 包含深度链接
   * @returns {Promise<{results: Array, sources: object, totalMatches: number, queryTimeMs: number}>}
   */
  async query(queryText, options) {
    this.guardShutdown();
    if (!queryText || typeof queryText !== 'string') {
      return { results: [], sources: {}, totalMatches: 0, queryTimeMs: 0 };
    }
    const startTime = Date.now();
    const opts = options ?? {};
    const topK = typeof opts.topK === 'number' && opts.topK > 0 ? Math.min(opts.topK, this._maxQueryResults) : DEFAULT_TOP_K;
    const includeLinks = opts.includeLinks !== false;
    const requestedSources = opts.sources;

    const allResults = [];
    const sourceStats = {};

    // 源1：GraphifyCompiler图谱查询
    if ((!requestedSources || requestedSources.includes('graph')) && this._graphifyCompiler) {
      const graphResults = await this._queryGraph(queryText, topK, includeLinks);
      allResults.push(...graphResults);
      sourceStats.graph = graphResults.length;
    }

    // 源2：LlmWiki结构化知识查询
    if ((!requestedSources || requestedSources.includes('wiki')) && this._llmWiki) {
      const wikiResults = await this._queryWiki(queryText, topK, includeLinks);
      allResults.push(...wikiResults);
      sourceStats.wiki = wikiResults.length;
    }

    // 源3：RAGPipeline向量检索
    if ((!requestedSources || requestedSources.includes('rag')) && this._ragPipeline) {
      const ragResults = await this._queryRag(queryText, topK, includeLinks);
      allResults.push(...ragResults);
      sourceStats.rag = ragResults.length;
    }

    // 源4：GraphRAG图谱推理
    if ((!requestedSources || requestedSources.includes('memory')) && this._graphRag) {
      const graphRagResults = await this._queryGraphRag(queryText, topK, includeLinks);
      allResults.push(...graphRagResults);
      sourceStats.memory = graphRagResults.length;
    }

    // 按优先级和相关性排序
    allResults.sort(function(a, b) {
      const priorityDiff = (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      return (b.relevance ?? 0) - (a.relevance ?? 0);
    });

    const results = allResults.slice(0, this._maxQueryResults);
    const queryTimeMs = Date.now() - startTime;

    this._stats.totalQueries++;
    this._queryTimeSum += queryTimeMs;
    this._stats.avgQueryTimeMs = this._stats.totalQueries > 0 ? Math.round(this._queryTimeSum / this._stats.totalQueries) : 0;

    this.emit('query-executed', { queryText, resultCount: results.length, queryTimeMs });
    return { results, sources: sourceStats, totalMatches: allResults.length, queryTimeMs };
  }

  // ─── 核心能力4：自动生成可视化图表 ─────────────────────────

  /**
   * 生成架构图数据（Mermaid格式）
   * @param {object} [options]
   * @param {string} [options.format='mermaid'] - 输出格式（mermaid/json/dot）
   * @param {number} [options.maxDepth=2] - 最大展示深度
   * @returns {{format: string, diagram: string, nodeCount: number, edgeCount: number}}
   */
  generateArchitectureDiagram(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const format = opts.format || 'mermaid';
    const maxDepth = typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 2;

    if (!this._graphifyCompiler && !this._codeGraph) {
      return { format, diagram: '', nodeCount: 0, edgeCount: 0, error: 'No graph data available. Run compile() first.' };
    }

    const graphData = this._fetchGraphData();
    if (!graphData) {
      return { format, diagram: '', nodeCount: 0, edgeCount: 0 };
    }

    const diagram = this._renderDiagram(graphData, format, maxDepth);
    return {
      format,
      diagram,
      nodeCount: graphData.stats ? graphData.stats.totalFiles ?? 0 : 0,
      edgeCount: graphData.stats ? graphData.stats.totalDependencies ?? 0 : 0,
    };
  }

  /**
   * 生成依赖图数据
   * @param {string} filePath - 目标文件路径
   * @param {object} [options]
   * @param {number} [options.maxDepth=3] - 最大依赖深度
   * @returns {{nodes: Array, edges: Array, centerNode: string}}
   */
  generateDependencyDiagram(filePath, options) {
    this.guardShutdown();
    if (!filePath || !this._codeGraph) {
      return { nodes: [], edges: [], centerNode: filePath || '' };
    }
    const opts = options ?? {};
    const maxDepth = typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 3;
    try {
      return this._codeGraph.getDependencyGraph(filePath, maxDepth);
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'depDiagram', _e && _e.message ? _e.message : String(_e));
      return { nodes: [], edges: [], centerNode: filePath };
    }
  }

  /**
   * 生成序列图（Mermaid格式）。基于GraphifyCompiler的函数调用链和CodeGraph的依赖关系，
   * 自动推导模块间的交互序列，生成Mermaid sequenceDiagram。
   * 融合自谷歌CodeWiki的"可视化图表生成"能力。
   * @param {object} [options]
   * @param {string[]} [options.participants] - 指定参与方（模块/类名），不指定时自动推断
   * @param {number} [options.maxDepth=4] - 调用链最大深度
   * @param {string} [options.format='mermaid'] - 输出格式：mermaid/json
   * @returns {{diagram: string, participants: string[], interactions: number, format: string}}
   */
  generateSequenceDiagram(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const maxDepth = typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? Math.min(opts.maxDepth, 8) : 4;
    const format = opts.format === 'json' ? 'json' : 'mermaid';

    const interactions = [];
    const participantSet = new Set();

    this._collectGraphifyInteractions(interactions, participantSet);
    this._collectCodeGraphInteractions(interactions, participantSet);

    let participants = Array.from(participantSet);
    if (Array.isArray(opts.participants) && opts.participants.length > 0) {
      const filterSet = new Set(opts.participants.map(function(p) { return p.toLowerCase(); }));
      participants = participants.filter(function(p) { return filterSet.has(p.toLowerCase()); });
      for (let i = interactions.length - 1; i >= 0; i--) {
        if (!filterSet.has(interactions[i].from.toLowerCase()) && !filterSet.has(interactions[i].to.toLowerCase())) {
          interactions.splice(i, 1);
        }
      }
    }

    if (interactions.length > maxDepth * participants.length) {
      interactions.length = maxDepth * participants.length;
    }

    if (format === 'json') {
      return { diagram: JSON.stringify({ participants: participants, interactions: interactions }, null, 2), participants: participants, interactions: interactions.length, format: 'json' };
    }

    const lines = ['sequenceDiagram'];
    for (const p of participants) {
      lines.push('    participant ' + _safeMermaidId(p));
    }
    for (const inter of interactions) {
      lines.push('    ' + _safeMermaidId(inter.from) + '->>' + _safeMermaidId(inter.to) + ': ' + (inter.label || 'call'));
    }
    return { diagram: lines.join('\n'), participants: participants, interactions: interactions.length, format: 'mermaid' };
  }

  /**
   * 从GraphifyCompiler提取调用关系
   * @private
   */
  _collectGraphifyInteractions(interactions, participantSet) {
    if (!this._graphifyCompiler) return;
    try {
      const report = this._graphifyCompiler.getReport();
      if (!report || !report.edges) return;
      for (const edge of report.edges) {
        if (edge.type !== 'calls' && edge.type !== 'depends_on') continue;
        const source = edge.source || edge.from || '';
        const target = edge.target || edge.to || '';
        if (!source || !target) continue;
        const sourceModule = this._extractModulePart(source);
        const targetModule = this._extractModulePart(target);
        if (sourceModule === targetModule) continue;
        participantSet.add(sourceModule);
        participantSet.add(targetModule);
        interactions.push({ from: sourceModule, to: targetModule, label: edge.label || edge.type, source: source, target: target });
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'seqDiagram:graphify', _e && _e.message ? _e.message : String(_e));
    }
  }

  /**
   * 从CodeGraph补充跨模块依赖
   * @private
   */
  _collectCodeGraphInteractions(interactions, participantSet) {
    if (!this._codeGraph) return;
    try {
      const stats = this._codeGraph.getModuleStats();
      if (!stats || !stats.modules) return;
      for (const mod of stats.modules) {
        if (!mod.file || !mod.dependencies) continue;
        const sourceModule = this._extractModulePart(mod.file);
        for (const dep of mod.dependencies) {
          const targetModule = this._extractModulePart(dep);
          if (sourceModule === targetModule) continue;
          participantSet.add(sourceModule);
          participantSet.add(targetModule);
          if (!interactions.some(function(i) { return i.from === sourceModule && i.to === targetModule; })) {
            interactions.push({ from: sourceModule, to: targetModule, label: 'requires', source: mod.file, target: dep });
          }
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'seqDiagram:codeGraph', _e && _e.message ? _e.message : String(_e));
    }
  }

  /**
   * 从节点ID中提取模块部分
   * @private
   */
  _extractModulePart(nodeId) {
    if (!nodeId || typeof nodeId !== 'string') return 'unknown';
    // 尝试从路径提取模块名
    const parts = nodeId.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1] || nodeId;
    return fileName.replace(/\.(js|ts|jsx|tsx|md)$/, '').replace(/\.test$/, '');
  }

  // ─── 核心能力5：内置AI聊天 ──────────────────────────────────

  /**
   * 与代码库对话。基于多源检索结果构建上下文回答。
   * @param {string} question - 用户问题
   * @param {object} [options]
   * @param {number} [options.topK=5] - 检索结果数
   * @returns {Promise<{answer: string, sources: Array, chatId: string}>}
   */
  async chat(question, options) {
    this.guardShutdown();
    if (!question || typeof question !== 'string') {
      return { answer: '', sources: [], chatId: '' };
    }

    const chatId = generateId('wiki-chat-');
    const queryResult = await this.query(question, options);

    // 构建上下文回答
    const contextParts = [];
    for (const r of queryResult.results.slice(0, 10)) {
      if (r.content) {
        contextParts.push('[' + r.source + '] ' + (r.title || r.filePath || '') + ': ' + r.content.slice(0, 500));
      }
    }

    const answer = contextParts.length > 0
      ? 'Based on the codebase analysis:\n\n' + contextParts.join('\n\n')
      : 'No relevant information found in the codebase for: ' + question;

    // 记录聊天历史
    this._chatHistory.push({ chatId, question, answer, sourceCount: queryResult.results.length, timestamp: Date.now() });
    this._stats.totalChatTurns++;

    this.emit('chat-completed', { chatId, question, sourceCount: queryResult.results.length });
    return { answer, sources: queryResult.results.slice(0, DEFAULT_TOP_K), chatId };
  }

  /**
   * 获取聊天历史
   * @param {number} [limit=20] - 返回条数
   * @returns {Array}
   */
  getChatHistory(limit) {
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, this._maxChatHistory) : 20;
    return this._chatHistory.toArray().slice(-lim).map(h => ({ ...h }));
  }

  // ─── 核心能力6：AI编码助手上下文文件生成 ────────────────────

  /**
   * 生成AI编码助手上下文文件内容（copilot-instructions风格）
   * @returns {string} Markdown格式的上下文文件内容
   */
  getContextFile() {
    this.guardShutdown();
    if (this._lastCompileResult && this._lastCompileResult.contextFile) {
      return this._lastCompileResult.contextFile;
    }
    return this._generateContextFileContent(null, null);
  }

  // ─── 核心能力7：项目地图生成（Understand Anything理念） ──────

  /**
   * 生成项目导航地图。融合Understand Anything的设计理念，
   * 生成结构化的项目地图，清晰展示模块职责、调用关系和依赖层次。
   *
   * @param {Object} [options] - 选项
   * @param {string} [options.format='markdown'] - 输出格式（markdown/json/compact）
   * @param {boolean} [options.includeMetrics=true] - 是否包含度量指标
   * @param {boolean} [options.includeCallGraph=true] - 是否包含调用关系
   * @param {number} [options.maxDepth=3] - 最大展示深度
   * @returns {{format: string, map: string|Object, modules: number, totalFiles: number, totalDeps: number}}
   */
  generateProjectMap(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const format = opts.format || 'markdown';
    const includeMetrics = opts.includeMetrics !== false;
    const includeCallGraph = opts.includeCallGraph !== false;
    const maxDepth = typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 3;

    if (!this._graphifyCompiler && !this._codeGraph) {
      return { format, map: '', modules: 0, totalFiles: 0, totalDeps: 0, error: 'No graph data available. Run compile() first.' };
    }

    const graphData = this._fetchGraphData();
    if (!graphData) {
      return { format, map: '', modules: 0, totalFiles: 0, totalDeps: 0 };
    }

    const modules = this._extractModuleStructure(graphData, maxDepth);
    const callRelations = includeCallGraph ? this._extractCallRelations(graphData, maxDepth) : [];
    const metrics = includeMetrics ? this._extractMetrics(graphData) : null;
    const stats = {
      modules: modules.length,
      totalFiles: graphData.stats ? graphData.stats.totalFiles ?? 0 : 0,
      totalDeps: graphData.stats ? graphData.stats.totalDependencies ?? 0 : 0,
    };

    return this._renderProjectMapByFormat(format, modules, callRelations, metrics, stats);
  }

  /**
   * 根据格式渲染项目地图。
   * @param {string} format - 输出格式
   * @param {Array} modules - 模块结构
   * @param {Array} callRelations - 调用关系
   * @param {Object|null} metrics - 度量指标
   * @param {Object} stats - 统计信息
   * @returns {{format: string, map: string|Object, modules: number, totalFiles: number, totalDeps: number}}
   * @private
   */
  _renderProjectMapByFormat(format, modules, callRelations, metrics, stats) {
    if (format === 'json') {
      return {
        format: 'json',
        map: { modules: modules, callRelations: callRelations, metrics: metrics },
        modules: stats.modules,
        totalFiles: stats.totalFiles,
        totalDeps: stats.totalDeps,
      };
    }

    if (format === 'compact') {
      return {
        format: 'compact',
        map: this._renderCompactMap(modules, callRelations, metrics),
        modules: stats.modules,
        totalFiles: stats.totalFiles,
        totalDeps: stats.totalDeps,
      };
    }

    return {
      format: 'markdown',
      map: this._renderMarkdownMap(modules, callRelations, metrics),
      modules: stats.modules,
      totalFiles: stats.totalFiles,
      totalDeps: stats.totalDeps,
    };
  }

  /**
   * 从图数据中提取模块结构。
   *
   * @param {Object} graphData - 图数据
   * @param {number} maxDepth - 最大深度
   * @returns {Array<Object>} 模块结构数组
   * @private
   */
  _extractModuleStructure(graphData, maxDepth) {
    const nodes = graphData.nodes ?? [];
    const edges = graphData.edges ?? [];
    const moduleMap = new Map();

    for (const node of nodes) {
      if (!node || !node.id) continue;
      const parts = node.id.split(/[/\\]/);
      const moduleName = parts.length > 1 ? parts.slice(0, Math.min(parts.length - 1, maxDepth)).join('/') : '(root)';
      if (!moduleMap.has(moduleName)) {
        moduleMap.set(moduleName, {
          name: moduleName,
          files: [],
          exports: [],
          imports: [],
          depth: parts.length - 1,
        });
      }
      const mod = moduleMap.get(moduleName);
      mod.files.push(node.id);
      if (node.exports && Array.isArray(node.exports)) {
        mod.exports.push.apply(mod.exports, node.exports);
      }
    }

    for (const edge of edges) {
      if (!edge || !edge.source || !edge.target) continue;
      const sourceParts = edge.source.split(/[/\\]/);
      const targetParts = edge.target.split(/[/\\]/);
      const sourceModule = sourceParts.length > 1 ? sourceParts.slice(0, Math.min(sourceParts.length - 1, maxDepth)).join('/') : '(root)';
      const targetModule = targetParts.length > 1 ? targetParts.slice(0, Math.min(targetParts.length - 1, maxDepth)).join('/') : '(root)';
      const sourceMod = moduleMap.get(sourceModule);
      if (sourceMod && !sourceMod.imports.includes(targetModule) && sourceModule !== targetModule) {
        sourceMod.imports.push(targetModule);
      }
    }

    return Array.from(moduleMap.values()).sort(function(a, b) { return b.files.length - a.files.length; });
  }

  /**
   * 从图数据中提取调用关系。
   *
   * @param {Object} graphData - 图数据
   * @param {number} maxDepth - 最大深度
   * @returns {Array<Object>} 调用关系数组
   * @private
   */
  _extractCallRelations(graphData, _maxDepth) {
    const edges = graphData.edges ?? [];
    const relations = [];
    const seen = new Set();

    for (const edge of edges) {
      if (!edge || !edge.source || !edge.target) continue;
      const key = edge.source + '->' + edge.target;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({
        source: edge.source,
        target: edge.target,
        type: edge.type || 'depends_on',
      });
      if (relations.length >= 200) break;
    }

    return relations;
  }

  /**
   * 从图数据中提取度量指标。
   *
   * @param {Object} graphData - 图数据
   * @returns {Object} 度量指标
   * @private
   */
  _extractMetrics(graphData) {
    const stats = graphData.stats ?? {};
    return {
      totalFiles: stats.totalFiles ?? 0,
      totalDependencies: stats.totalDependencies ?? 0,
      avgDependencies: stats.avgDependencies ?? 0,
      circularDependencies: stats.circularDependencies ?? 0,
      orphanFiles: stats.orphanFiles ?? 0,
    };
  }

  /**
   * 渲染Markdown格式的项目地图。
   *
   * @param {Array} modules - 模块结构
   * @param {Array} callRelations - 调用关系
   * @param {Object|null} metrics - 度量指标
   * @returns {string} Markdown内容
   * @private
   */
  _renderMarkdownMap(modules, callRelations, metrics) {
    const lines = [];
    lines.push('# Project Map');
    lines.push('');

    if (metrics) {
      lines.push('## Overview');
      lines.push('');
      lines.push('- **Files**: ' + metrics.totalFiles);
      lines.push('- **Dependencies**: ' + metrics.totalDependencies);
      lines.push('- **Avg Dependencies/File**: ' + metrics.avgDependencies.toFixed(1));
      lines.push('- **Circular Dependencies**: ' + metrics.circularDependencies);
      lines.push('- **Orphan Files**: ' + metrics.orphanFiles);
      lines.push('');
    }

    lines.push('## Modules');
    lines.push('');
    for (const mod of modules) {
      const indent = '  '.repeat(Math.min(mod.depth, 3));
      lines.push(indent + '- **' + mod.name + '** (' + mod.files.length + ' files)');
      if (mod.imports.length > 0) {
        lines.push(indent + '  - Depends on: ' + mod.imports.join(', '));
      }
    }

    if (callRelations.length > 0) {
      lines.push('');
      lines.push('## Call Relations');
      lines.push('');
      for (const rel of callRelations.slice(0, 50)) {
        lines.push('- `' + rel.source + '` → `' + rel.target + '` (' + rel.type + ')');
      }
      if (callRelations.length > 50) {
        lines.push('- ... and ' + (callRelations.length - 50) + ' more');
      }
    }

    return lines.join('\n');
  }

  /**
   * 渲染紧凑格式的项目地图。
   *
   * @param {Array} modules - 模块结构
   * @param {Array} callRelations - 调用关系
   * @param {Object|null} metrics - 度量指标
   * @returns {string} 紧凑文本
   * @private
   */
  _renderCompactMap(modules, callRelations, metrics) {
    const lines = [];
    if (metrics) {
      lines.push('FILES=' + metrics.totalFiles + ' DEPS=' + metrics.totalDependencies + ' CIRC=' + metrics.circularDependencies);
    }
    for (const mod of modules) {
      lines.push(mod.name + ' [' + mod.files.length + 'f]' + (mod.imports.length > 0 ? ' <- ' + mod.imports.join(',') : ''));
    }
    return lines.join('\n');
  }

  // ─── 文档新鲜度 ────────────────────────────────────────────

  /**
   * 获取过时文档列表
   * @returns {Array} 过时文档列表
   */
  getStaleDocs() {
    this.guardShutdown();
    if (!this._docFreshnessGuard) return [];
    try { return this._docFreshnessGuard.getStaleDocs(); } catch (_e) { debug('CodeWikiOrchestrator', 'getStaleDocuments', _e && _e.message ? _e.message : String(_e)); return []; }
  }

  /**
   * 验证文档新鲜度
   * @returns {{valid: boolean, newlyStale: number, totalStale: number}}
   */
  validateFreshness() {
    this.guardShutdown();
    if (!this._docFreshnessGuard) return { valid: true, newlyStale: 0, totalStale: 0 };
    try { return this._docFreshnessGuard.validateFreshness(); } catch (_e) { debug('CodeWikiOrchestrator', 'validateFreshness', _e && _e.message ? _e.message : String(_e)); return { valid: true, newlyStale: 0, totalStale: 0 }; }
  }

  // ─── 统计与状态 ─────────────────────────────────────────────

  /**
   * 获取Code Wiki统计信息
   * @returns {object}
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalCompiles: 0, totalQueries: 0, totalChatTurns: 0, wikiEntryCount: 0, compileStatus: 'shutdown' };
    }
    return {
      totalCompiles: this._stats.totalCompiles,
      totalQueries: this._stats.totalQueries,
      totalChatTurns: this._stats.totalChatTurns,
      avgCompileTimeMs: this._stats.avgCompileTimeMs,
      avgQueryTimeMs: this._stats.avgQueryTimeMs,
      wikiEntryCount: this._wikiIndex.size,
      linkedDocCount: this._stats.linkedDocCount,
      compileStatus: this._compileStatus,
      attachedModules: {
        graphifyCompiler: !!this._graphifyCompiler,
        codeGraph: !!this._codeGraph,
        llmWiki: !!this._llmWiki,
        ragPipeline: !!this._ragPipeline,
        graphRag: !!this._graphRag,
        docFreshnessGuard: !!this._docFreshnessGuard,
        knowledgeBasePipeline: !!this._knowledgeBasePipeline,
        autoVersionTracker: !!this._autoVersionTracker,
        embeddingService: !!this._embeddingService,
      },
      lastCompileAt: this._lastCompileResult ? this._lastCompileResult.compiledAt : null,
    };
  }

  /**
   * 检查实例是否健康
   * @returns {boolean}
   */
  isHealthy() {
    if (this._shutDown) return false;
    return this._wikiIndex.size < this._maxWikiEntries;
  }

  /**
   * 获取编译状态
   * @returns {string}
   */
  getCompileStatus() {
    this.guardShutdown();
    return this._compileStatus;
  }

  // ─── 内部方法 ───────────────────────────────────────────────

  _fetchGraphData() {
    let graphData = null;
    if (this._graphifyCompiler) {
      try {
        const overview = this._graphifyCompiler.query ? this._graphifyCompiler.query({ strategy: 'classified-index', limit: 200 }) : null;
        if (overview && overview.results) {
          graphData = overview;
        }
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'archDiagram-query', _e && _e.message ? _e.message : String(_e));
      }
    }
    if (!graphData && this._codeGraph) {
      try {
        const stats = this._codeGraph.getModuleStats();
        graphData = { stats };
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'archDiagram-stats', _e && _e.message ? _e.message : String(_e));
      }
    }
    return graphData;
  }

  async _indexToKnowledgeBases(graphResult, codeGraphResult) {
    if (!graphResult && !codeGraphResult) return;
    this._indexGraphResult(graphResult);
    this._indexCodeGraphResult(codeGraphResult);
    this._stats.wikiEntryCount = this._wikiIndex.size;
  }

  _indexGraphResult(graphResult) {
    if (!graphResult || !this._graphifyCompiler) return;
    try {
      const overview = this._graphifyCompiler.query ? this._graphifyCompiler.query({ strategy: 'classified-index', limit: 500 }) : null;
      if (overview && overview.results) {
        for (const node of overview.results) {
          if (node && node.nodeId) {
            this._addWikiEntry({
              id: node.nodeId,
              type: node.type || 'unknown',
              name: node.name || node.nodeId,
              filePath: node.filePath || null,
              source: 'graph',
              relevance: 1.0,
            });
          }
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'indexGraph', _e && _e.message ? _e.message : String(_e));
    }
  }

  _indexCodeGraphResult(codeGraphResult) {
    if (!codeGraphResult || !this._codeGraph) return;
    try {
      const stats = this._codeGraph.getModuleStats();
      if (stats && stats.largestModules) {
        for (const mod of stats.largestModules.slice(0, 50)) {
          this._addWikiEntry({
            id: 'dep-' + (mod.filePath || mod.name || ''),
            type: DOC_TYPES.MODULE,
            name: mod.name || mod.filePath || '',
            filePath: mod.filePath || null,
            source: 'codegraph',
            relevance: 0.8,
          });
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'indexCodeGraph', _e && _e.message ? _e.message : String(_e));
    }
  }

  _addWikiEntry(entry) {
    if (this._wikiIndex.size >= this._maxWikiEntries) {
      const oldestKey = this._wikiIndex.keys().next().value;
      this._wikiIndex.delete(oldestKey);
    }
    this._wikiIndex.set(entry.id, entry);
  }

  async _queryGraph(queryText, topK, includeLinks) {
    const results = [];
    if (!this._graphifyCompiler) return results;
    try {
      const graphResult = this._graphifyCompiler.query({ name: queryText.toLowerCase(), strategy: 'classified-index', limit: topK });
      if (graphResult && graphResult.results) {
        for (const r of graphResult.results) {
          results.push({
            source: 'graph',
            type: r.type || 'unknown',
            title: r.name || r.nodeId || '',
            filePath: r.filePath || null,
            content: r.name ? 'Node: ' + r.name + ' (Type: ' + (r.type || 'unknown') + ')' : '',
            relevance: 1.0,
            link: includeLinks && r.filePath ? { type: 'file', path: r.filePath, nodeId: r.nodeId } : null,
          });
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'queryGraph', _e && _e.message ? _e.message : String(_e));
    }
    return results;
  }

  async _queryWiki(queryText, topK, includeLinks) {
    const results = [];
    if (!this._llmWiki) return results;
    try {
      const wikiResults = this._llmWiki.search(queryText, { fullText: true });
      if (Array.isArray(wikiResults)) {
        for (const r of wikiResults.slice(0, topK)) {
          results.push({
            source: 'wiki',
            type: DOC_TYPES.PATTERN,
            title: r.title || r.slug || '',
            filePath: r.filePath || null,
            content: r.content ? r.content.slice(0, 500) : '',
            relevance: 0.8,
            link: includeLinks && r.filePath ? { type: 'wiki', path: r.filePath, category: r.category, slug: r.slug } : null,
          });
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'queryWiki', _e && _e.message ? _e.message : String(_e));
    }
    return results;
  }

  async _queryRag(queryText, topK, includeLinks) {
    const results = [];
    if (!this._ragPipeline) return results;
    try {
      const ragResult = await this._ragPipeline.query(queryText, { topK: topK });
      if (ragResult && ragResult.results) {
        for (const r of ragResult.results) {
          results.push({
            source: 'rag',
            type: DOC_TYPES.MODULE,
            title: r.docPath || r.chunkId || '',
            filePath: r.docPath || null,
            content: r.text ? r.text.slice(0, 500) : '',
            relevance: r.score ?? 0.6,
            link: includeLinks && r.docPath ? { type: 'file', path: r.docPath, chunkId: r.chunkId } : null,
          });
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'queryRag', _e && _e.message ? _e.message : String(_e));
    }
    return results;
  }

  async _queryGraphRag(queryText, topK, includeLinks) {
    const results = [];
    if (!this._graphRag) return results;
    try {
      const graphRagResult = await this._graphRag.query(queryText, { topK: topK });
      if (graphRagResult && graphRagResult.results) {
        for (const r of graphRagResult.results) {
          results.push({
            source: 'memory',
            type: DOC_TYPES.PATTERN,
            title: r.entity || r.name || '',
            filePath: null,
            content: r.text ? r.text.slice(0, 500) : (r.reasoning || ''),
            relevance: r.score ?? 0.5,
            link: includeLinks && r.entityId ? { type: 'entity', entityId: r.entityId } : null,
          });
        }
      }
    } catch (_e) {
      debug('CodeWikiOrchestrator', 'queryGraphRag', _e && _e.message ? _e.message : String(_e));
    }
    return results;
  }

  _generateDiagrams(_graphResult, _codeGraphResult) {
    const diagrams = {};

    // 架构图
    if (this._graphifyCompiler) {
      try {
        const overview = this._graphifyCompiler.query ? this._graphifyCompiler.query({ strategy: 'classified-index', limit: 100 }) : null;
        if (overview && overview.results) {
          diagrams.architecture = this._renderMermaidArchDiagram(overview.results);
        }
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'genDiagrams-arch', _e && _e.message ? _e.message : String(_e));
      }
    }

    // 依赖图
    if (this._codeGraph) {
      try {
        const stats = this._codeGraph.getModuleStats();
        if (stats && stats.largestModules) {
          diagrams.dependencies = this._renderMermaidDepDiagram(stats.largestModules.slice(0, 20));
        }
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'genDiagrams-dep', _e && _e.message ? _e.message : String(_e));
      }
    }

    return diagrams;
  }

  _renderMermaidArchDiagram(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return '';
    const lines = ['graph TD'];
    const typeGroups = {};
    for (const node of nodes) {
      const type = node.type || 'unknown';
      if (!typeGroups[type]) typeGroups[type] = [];
      typeGroups[type].push(node);
    }
    for (const [type, group] of Object.entries(typeGroups)) {
      lines.push('  subgraph ' + type);
      for (const node of group.slice(0, 10)) {
        const safeId = (node.nodeId || '').replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push('    ' + safeId + '["' + (node.name || node.nodeId || '').replace(/"/g, "'") + '"]');
      }
      lines.push('  end');
    }
    return lines.join('\n');
  }

  _renderMermaidDepDiagram(modules) {
    if (!Array.isArray(modules) || modules.length === 0) return '';
    const lines = ['graph LR'];
    for (const mod of modules) {
      const safeName = (mod.name || mod.filePath || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
      const deps = mod.dependencies ?? [];
      for (const dep of deps.slice(0, 5)) {
        const safeDep = (dep.name || dep.filePath || dep || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
        lines.push('  ' + safeName + ' --> ' + safeDep);
      }
    }
    return lines.join('\n');
  }

  _renderDiagram(graphData, format, _maxDepth) {
    if (format === 'json') {
      try { return JSON.stringify(graphData, null, 2); } catch (_e) { debug('CodeWikiOrchestrator', 'chartToJson', _e && _e.message ? _e.message : String(_e)); return '{}'; }
    }
    // 默认Mermaid
    if (graphData.stats) {
      return this._renderMermaidDepDiagram(graphData.stats.largestModules ?? []);
    }
    if (graphData.results) {
      return this._renderMermaidArchDiagram(graphData.results);
    }
    return '';
  }

  _generateContextFileContent(graphResult, codeGraphResult) {
    const lines = [];
    lines.push('# Code Wiki Context');
    lines.push('');
    lines.push('> Auto-generated by Harness Code Wiki Orchestrator');
    lines.push('> Generated at: ' + new Date().toISOString());
    lines.push('');

    this._appendProjectOverview(lines, graphResult, codeGraphResult);
    this._appendArchitectureModules(lines);
    this._appendKeyDependencies(lines);
    this._appendCodingConventions(lines);

    return lines.join('\n');
  }

  _appendProjectOverview(lines, graphResult, codeGraphResult) {
    lines.push('## Project Overview');
    lines.push('');
    lines.push('- Project Root: ' + this._projectRoot);
    if (graphResult) {
      lines.push('- Code Nodes: ' + (graphResult.nodeCount ?? 0));
      lines.push('- Code Edges: ' + (graphResult.edgeCount ?? 0));
      lines.push('- Clusters: ' + (graphResult.clusterCount ?? 0));
    }
    if (codeGraphResult) {
      lines.push('- Source Files: ' + (codeGraphResult.files ? codeGraphResult.files.length : 0));
      lines.push('- Dependencies: ' + (codeGraphResult.edges ? codeGraphResult.edges.length : 0));
    }
    lines.push('');
  }

  _appendArchitectureModules(lines) {
    lines.push('## Architecture Modules');
    lines.push('');
    if (this._graphifyCompiler) {
      try {
        const overview = this._graphifyCompiler.query ? this._graphifyCompiler.query({ strategy: 'classified-index', limit: 50 }) : null;
        if (overview && overview.results) {
          const byType = {};
          for (const r of overview.results) {
            const t = r.type || 'unknown';
            if (!byType[t]) byType[t] = [];
            byType[t].push(r.name || r.nodeId || '');
          }
          for (const [type, names] of Object.entries(byType)) {
            lines.push('### ' + type + ' (' + names.length + ')');
            for (const name of names.slice(0, 20)) {
              lines.push('- ' + name);
            }
            lines.push('');
          }
        }
      } catch (_e) {
        lines.push('_Graph data unavailable_');
        lines.push('');
      }
    } else {
      lines.push('_GraphifyCompiler not attached_');
      lines.push('');
    }
  }

  _appendKeyDependencies(lines) {
    lines.push('## Key Dependencies');
    lines.push('');
    if (this._codeGraph) {
      try {
        const stats = this._codeGraph.getModuleStats();
        if (stats && stats.largestModules) {
          for (const mod of stats.largestModules.slice(0, 10)) {
            lines.push('- **' + (mod.name || mod.filePath || 'unknown') + '**: ' + (mod.dependencyCount ?? 0) + ' dependencies');
          }
        }
      } catch (_e) {
        lines.push('_Dependency data unavailable_');
      }
    } else {
      lines.push('_CodeGraph not attached_');
    }
    lines.push('');
  }

  _appendCodingConventions(lines) {
    lines.push('## Coding Conventions');
    lines.push('');
    lines.push('- Runtime: Node.js (CommonJS modules)');
    lines.push('- Backend: Native http module (no Express/Koa)');
    lines.push('- Frontend: Vanilla HTML5 + CSS3 + JavaScript');
    lines.push('- Data Storage: better-sqlite3');
    lines.push('- Testing: Node.js built-in test runner + c8 coverage');
    lines.push('- Lint: ESLint (0 errors, 0 warnings required)');
    lines.push('');
  }

  _setupAutoRecompile(eventBus) {
    if (this._eventBusListeners) return;
    this._eventBusListeners = [];
    const relevantEvents = ['file-modified', 'file-created', 'file-deleted'];
    for (const eventName of relevantEvents) {
      try {
        const handler = function(data) {
          if (data && data.filePath) {
            this.handleCodeChange(data.filePath, eventName.replace('file-', '')).catch(function(_e) {
              debug('CodeWikiOrchestrator', 'autoRecompile', _e && _e.message ? _e.message : String(_e));
            });
          }
        }.bind(this);
        eventBus.on(eventName, handler);
        this._eventBusListeners.push({ eventBus, eventName, handler });
      } catch (_e) {
        debug('CodeWikiOrchestrator', 'setupAutoRecompile', _e && _e.message ? _e.message : String(_e));
      }
    }
  }

  _onShutdown() {
    this.removeAllListeners();
    if (this._eventBusListeners) {
      for (const { eventBus, eventName, handler } of this._eventBusListeners) {
        try { eventBus.off(eventName, handler); } catch (_e) { debug('CodeWikiOrchestrator', 'shutdown:off', _e && _e.message ? _e.message : String(_e)); }
      }
      this._eventBusListeners = null;
    }
    this._wikiIndex.clear();
    this._chatHistory.clear();
    this._graphifyCompiler = null;
    this._codeGraph = null;
    this._llmWiki = null;
    this._ragPipeline = null;
    this._graphRag = null;
    this._docFreshnessGuard = null;
    this._knowledgeBasePipeline = null;
    this._autoVersionTracker = null;
    this._embeddingService = null;
    this._compileStatus = WIKI_COMPILE_STATUS.IDLE;
    this._lastCompileResult = null;
    this._stats = { totalCompiles: 0, totalQueries: 0, totalChatTurns: 0, avgCompileTimeMs: 0, avgQueryTimeMs: 0, wikiEntryCount: 0, linkedDocCount: 0 };
  }
}

module.exports = withShutdown(CodeWikiOrchestrator);
module.exports.CodeWikiOrchestrator = CodeWikiOrchestrator;
module.exports.WIKI_COMPILE_STATUS = WIKI_COMPILE_STATUS;
module.exports.DOC_TYPES = DOC_TYPES;
module.exports.SOURCE_PRIORITY = SOURCE_PRIORITY;

/**
 * 将字符串转为安全的Mermaid标识符（去除特殊字符）
 * @private
 */
function _safeMermaidId(str) {
  return str.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}
