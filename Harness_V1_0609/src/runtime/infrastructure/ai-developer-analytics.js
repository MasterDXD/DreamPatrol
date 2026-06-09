'use strict';

/** @module runtime/infrastructure/ai-developer-analytics */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const _debug = require('../../utils/debug-logger')('AiDeveloperAnalytics');
const BoundedMap = require('../../utils/bounded-map');

/**
 * AiDeveloperAnalytics — AI开发者分析管道
 * 解决10+指标模块独立收集数据的"数据孤岛"问题，提供跨子系统关联、持久化和趋势分析。
 * 统一收集来自SkillObservability、AgentMonitor、DevMetricsCollector、DeliveryEfficiencyMeter、
 * DeepeningMetricsCollector、TokenManager、CodeGraph、GraphifyCompiler等子系统的指标数据，
 * 支持异常检测、趋势分析、实验对比、依赖扫描和瓶颈发现。
 * @classdesc AI开发者分析
 * @extends EventEmitter
 */
class AiDeveloperAnalytics extends EventEmitter {
  /**
   * 创建AI开发者分析管道实例
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.sqliteStore] - SQLiteStore实例引用（可选，用于持久化）
   * @param {Object} [options.codeGraph] - CodeGraph实例引用（可选）
   * @param {Object} [options.graphifyCompiler] - GraphifyCompiler实例引用（可选）
   * @param {Object} [options.skillObservability] - SkillObservability实例引用（可选）
   * @param {Object} [options.agentMonitor] - AgentMonitor实例引用（可选）
   * @param {Object} [options.devMetricsCollector] - DevMetricsCollector实例引用（可选）
   * @param {Object} [options.deliveryEfficiencyMeter] - DeliveryEfficiencyMeter实例引用（可选）
   * @param {Object} [options.deepeningMetricsCollector] - DeepeningMetricsCollector实例引用（可选）
   * @param {Object} [options.tokenManager] - TokenManager实例引用（可选）
   * @param {Object} [options.mcpClient] - MCPClient实例引用（可选）
   * @param {number} [options.maxMetricsPerSource=1000] - 每个来源最大指标数
   * @param {number} [options.anomalyThreshold=2.0] - 异常检测标准差倍数
   * @param {number} [options.trendWindowSize=20] - 趋势计算窗口大小
   */
  constructor(options) {
    super();
    options = options ?? {};

    this._sqliteStore = options.sqliteStore ?? null;
    this._codeGraph = options.codeGraph ?? null;
    this._graphifyCompiler = options.graphifyCompiler ?? null;
    this._skillObservability = options.skillObservability ?? null;
    this._agentMonitor = options.agentMonitor ?? null;
    this._devMetricsCollector = options.devMetricsCollector ?? null;
    this._deliveryEfficiencyMeter = options.deliveryEfficiencyMeter ?? null;
    this._deepeningMetricsCollector = options.deepeningMetricsCollector ?? null;
    this._tokenManager = options.tokenManager ?? null;
    this._mcpClient = options.mcpClient ?? null;

    this._maxMetricsPerSource = options.maxMetricsPerSource ?? 1000;
    this._maxMetricKeys = options.maxMetricKeys ?? 500;
    this._anomalyThreshold = options.anomalyThreshold ?? 2.0;
    this._trendWindowSize = options.trendWindowSize ?? 20;

    this._metricsStore = new BoundedMap(5000);
    this._experimentLog = new BoundedMap(200);
    this._dependencyCache = new BoundedMap(100);
    this._anomalies = new BoundedMap(100);

    this._stats = {
      totalMetricsCollected: 0,
      totalExperiments: 0,
      totalAnomaliesDetected: 0,
      totalDependencyScans: 0,
      totalBottlenecksFound: 0,
      avgCollectionTimeMs: 0,
    };

    this._initialized = false;
  }

  /**
   * 附加SQLiteStore实例
   * @param {Object} store - SQLiteStore实例
   */
  attachSqliteStore(store) {
    this.guardShutdown();
    this._sqliteStore = store;
  }

  /**
   * 附加CodeGraph实例
   * @param {Object} codeGraph - CodeGraph实例
   */
  attachCodeGraph(codeGraph) {
    this.guardShutdown();
    this._codeGraph = codeGraph;
  }

  /**
   * 附加GraphifyCompiler实例
   * @param {Object} compiler - GraphifyCompiler实例
   */
  attachGraphifyCompiler(compiler) {
    this.guardShutdown();
    this._graphifyCompiler = compiler;
  }

  /**
   * 附加SkillObservability实例
   * @param {Object} observability - SkillObservability实例
   */
  attachSkillObservability(observability) {
    this.guardShutdown();
    this._skillObservability = observability;
  }

  /**
   * 附加AgentMonitor实例
   * @param {Object} monitor - AgentMonitor实例
   */
  attachAgentMonitor(monitor) {
    this.guardShutdown();
    this._agentMonitor = monitor;
  }

  /**
   * 附加DevMetricsCollector实例
   * @param {Object} collector - DevMetricsCollector实例
   */
  attachDevMetricsCollector(collector) {
    this.guardShutdown();
    this._devMetricsCollector = collector;
  }

  /**
   * 附加DeliveryEfficiencyMeter实例
   * @param {Object} meter - DeliveryEfficiencyMeter实例
   */
  attachDeliveryEfficiencyMeter(meter) {
    this.guardShutdown();
    this._deliveryEfficiencyMeter = meter;
  }

  /**
   * 附加DeepeningMetricsCollector实例
   * @param {Object} collector - DeepeningMetricsCollector实例
   */
  attachDeepeningMetricsCollector(collector) {
    this.guardShutdown();
    this._deepeningMetricsCollector = collector;
  }

  /**
   * 附加TokenManager实例
   * @param {Object} manager - TokenManager实例
   */
  attachTokenManager(manager) {
    this.guardShutdown();
    this._tokenManager = manager;
  }

  /**
   * 附加MCPClient实例
   * @param {Object} client - MCPClient实例
   */
  attachMcpClient(client) {
    this.guardShutdown();
    this._mcpClient = client;
  }

  /**
   * 初始化分析管道
   * @returns {void}
   */
  initialize() {
    this.guardShutdown();
    this._initialized = true;
    this.emit('initialized');
  }

  /**
   * 从所有已附加的来源收集指标
   * 统一规范化为 { source, metric, value, timestamp, tags } 模式，
   * 存入_metricsStore，运行异常检测，持久化到SQLite，更新统计。
   * @returns {{ sourcesCollected: number, metricsCount: number, anomaliesDetected: number, collectionTimeMs: number }}
   */
  collectFromAllSources() {
    this.guardShutdown();
    const startTime = Date.now();
    let sourcesCollected = 0;
    let metricsCount = 0;
    const newAnomalies = [];

    const timestamp = Date.now();

    const sourceConfigs = [
      { ref: this._skillObservability, name: 'skill-observability', statsMethod: 'getStats' },
      { ref: this._agentMonitor, name: 'agent-monitor', statsMethod: 'getStats' },
      { ref: this._devMetricsCollector, name: 'dev-metrics', statsMethod: 'getStats' },
      { ref: this._deliveryEfficiencyMeter, name: 'delivery-efficiency', statsMethod: 'getStats' },
      { ref: this._deepeningMetricsCollector, name: 'deepening-metrics', statsMethod: 'getStats' },
      { ref: this._tokenManager, name: 'token-manager', statsMethod: 'getStats' },
      { ref: this._codeGraph, name: 'code-graph', statsMethod: 'getStats' },
      { ref: this._graphifyCompiler, name: 'graphify-compiler', statsMethod: 'getStats' },
    ];

    for (const cfg of sourceConfigs) {
      if (!cfg.ref) continue;
      const stats = safeExecute(
        () => cfg.ref[cfg.statsMethod](),
        'AiDeveloperAnalytics',
        'collectFrom-' + cfg.name,
        null,
      );
      if (!stats || typeof stats !== 'object') continue;
      sourcesCollected++;
      const flatMetrics = this._flattenStats(cfg.name, stats, timestamp);
      for (const m of flatMetrics) {
        try { this._storeMetric(m); } catch (_e) { _debug('skip-metric-on-store-failure', _e && _e.message ? _e.message : String(_e)); }
        metricsCount++;
      }
    }

    const anomalyResult = this.detectAnomalies();
    if (anomalyResult.newAnomalies > 0) {
      newAnomalies.push(anomalyResult.newAnomalies);
    }

    this._persistMetrics();

    const collectionTimeMs = Date.now() - startTime;
    this._stats.totalMetricsCollected += metricsCount;
    this._updateAvgCollectionTime(collectionTimeMs);

    const totalAnomalies = newAnomalies.reduce(function (s, n) { return s + n; }, 0);
    this.emit('metrics-collected', {
      sourcesCollected,
      metricsCount,
      anomaliesDetected: totalAnomalies,
      collectionTimeMs,
    });

    return {
      sourcesCollected,
      metricsCount,
      anomaliesDetected: totalAnomalies,
      collectionTimeMs,
    };
  }

  /**
   * 记录实验（模型运行、提示词测试等）
   * @param {Object} experiment - 实验对象
   * @param {string} experiment.name - 实验名称
   * @param {string} experiment.model - 使用的模型
   * @param {string} [experiment.prompt] - 提示词
   * @param {number} [experiment.startedAt] - 开始时间
   * @param {number} [experiment.completedAt] - 完成时间
   * @param {Object} [experiment.tokenUsage] - Token使用量
   * @param {number} [experiment.latency] - 延迟
   * @param {number} [experiment.successRate] - 成功率
   * @param {Object} [experiment.tags] - 标签
   * @param {*} [experiment.result] - 结果
   * @returns {{ experimentId: string, recorded: boolean }}
   */
  recordExperiment(experiment) {
    this.guardShutdown();
    if (!experiment || typeof experiment !== 'object') {
      throw new Error('experiment must be a non-null object');
    }
    if (!experiment.name || typeof experiment.name !== 'string') {
      throw new Error('experiment.name is required and must be a string');
    }
    if (!experiment.model || typeof experiment.model !== 'string') {
      throw new Error('experiment.model is required and must be a string');
    }

    const experimentId = 'exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const record = {
      name: experiment.name,
      model: experiment.model,
      prompt: experiment.prompt || '',
      startedAt: experiment.startedAt ?? Date.now(),
      completedAt: experiment.completedAt ?? null,
      tokenUsage: experiment.tokenUsage ?? null,
      latency: experiment.latency ?? null,
      successRate: experiment.successRate ?? null,
      tags: experiment.tags ?? {},
      result: experiment.result ?? null,
    };

    this._experimentLog.set(experimentId, record);
    this._stats.totalExperiments++;

    this._persistExperiment(experimentId, record);

    this.emit('experiment-recorded', { experimentId, record });

    return { experimentId, recorded: true };
  }

  /**
   * 比较多个实验
   * @param {string[]} experimentIds - 实验ID数组
   * @returns {{ experiments: Object[], comparison: Object, bestPerMetric: Object, recommendation: string }}
   */
  compareExperiments(experimentIds) {
    this.guardShutdown();
    if (!Array.isArray(experimentIds) || experimentIds.length === 0) {
      throw new Error('experimentIds must be a non-empty array');
    }

    const experiments = [];
    for (const id of experimentIds) {
      const record = this._experimentLog.get(id);
      if (record) {
        experiments.push({ experimentId: id, ...record });
      }
    }

    if (experiments.length === 0) {
      return { experiments: [], comparison: {}, bestPerMetric: {}, recommendation: 'No valid experiments found' };
    }

    const metrics = ['tokenUsage', 'latency', 'successRate'];
    const comparison = {};
    const bestPerMetric = {};

    for (const metric of metrics) {
      comparison[metric] = {};
      const values = [];
      for (const exp of experiments) {
        const val = this._extractMetricValue(exp, metric);
        comparison[metric][exp.experimentId] = val;
        if (val != null) values.push({ experimentId: exp.experimentId, value: val });
      }

      if (values.length >= 2) {
        const baseline = values[0].value;
        for (const entry of values) {
          if (baseline !== 0 && entry.value != null) {
            entry.improvement = ((entry.value - baseline) / Math.abs(baseline)) * 100;
          } else {
            entry.improvement = 0;
          }
        }
        comparison[metric].improvements = values;

        if (metric === 'successRate') {
          values.sort(function (a, b) { return (b.value ?? 0) - (a.value ?? 0); });
        } else {
          values.sort(function (a, b) { return (a.value ?? Infinity) - (b.value ?? Infinity); });
        }
        bestPerMetric[metric] = values[0].experimentId;
      } else if (values.length === 1) {
        bestPerMetric[metric] = values[0].experimentId;
      }
    }

    const recommendation = this._buildRecommendation(experiments, bestPerMetric, metrics);

    return { experiments, comparison, bestPerMetric, recommendation };
  }

  /**
   * 扫描项目依赖图
   * @param {string} projectPath - 项目路径
   * @returns {Promise<{ nodes: number, edges: number, orphans: number, cycles: number, couplingMetrics: Object, fileCount: number }>}
   */
  _scanWithCodeGraph(projectPath) {
    if (!this._codeGraph) return null;
    const scanResult = safeExecute(
      function () { return this._codeGraph.scanDirectory(projectPath); }.bind(this),
      'AiDeveloperAnalytics', 'scanProjectDependencies-codeGraph', null,
    );
    if (!scanResult || typeof scanResult !== 'object') return null;
    const stats = safeExecute(
      function () { return this._codeGraph.getStats(); }.bind(this),
      'AiDeveloperAnalytics', 'scanProjectDependencies-codeGraph-stats', null,
    );
    return {
      fileCount: scanResult.files ?? 0,
      edges: scanResult.edges ?? 0,
      nodes: (stats && typeof stats === 'object') ? (stats.nodeCount ?? stats.nodes ?? 0) : 0,
      orphans: (stats && typeof stats === 'object') ? (stats.orphans ?? 0) : 0,
      cycles: (stats && typeof stats === 'object') ? (stats.cycles ?? 0) : 0,
    };
  }

  _scanWithGraphify(projectPath) {
    if (!this._graphifyCompiler) return null;
    const graphifyResult = safeExecute(
      function () { return this._graphifyCompiler.compile(projectPath); }.bind(this),
      'AiDeveloperAnalytics', 'scanProjectDependencies-graphify', null,
    );
    if (!graphifyResult || typeof graphifyResult !== 'object') return null;
    const graph = graphifyResult.graph || graphifyResult;
    return {
      nodes: graph.nodes ? (Array.isArray(graph.nodes) ? graph.nodes.length : (graph.nodeCount ?? 0)) : 0,
      edges: graph.edges ? (Array.isArray(graph.edges) ? graph.edges.length : (graph.edgeCount ?? 0)) : 0,
      orphans: graph.orphans ? (Array.isArray(graph.orphans) ? graph.orphans.length : graph.orphans) : 0,
      cycles: graph.cycles ? (Array.isArray(graph.cycles) ? graph.cycles.length : graph.cycles) : 0,
    };
  }

  /**
   * 扫描项目依赖。通过CodeGraph和GraphifyCompiler两种引擎扫描项目依赖图，
   * 计算耦合指标并缓存结果。
   * @param {string} projectPath - 项目路径
   * @returns {Promise<{nodes: number, edges: number, orphans: number, cycles: number, couplingMetrics: Object, fileCount: number}>} 依赖扫描结果
   * @throws {Error} projectPath无效时抛出
   */
  async scanProjectDependencies(projectPath) {
    this.guardShutdown();
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error('projectPath is required and must be a string');
    }

    let nodes = 0;
    let edges = 0;
    let orphans = 0;
    let cycles = 0;
    let fileCount = 0;

    const codeGraphResult = this._scanWithCodeGraph(projectPath);
    if (codeGraphResult) {
      fileCount = codeGraphResult.fileCount;
      edges = codeGraphResult.edges;
      nodes = codeGraphResult.nodes;
      orphans = codeGraphResult.orphans;
      cycles = codeGraphResult.cycles;
    }

    const graphifyResult = this._scanWithGraphify(projectPath);
    if (graphifyResult) {
      nodes = Math.max(nodes, graphifyResult.nodes ?? 0);
      edges = Math.max(edges, graphifyResult.edges ?? 0);
      orphans = graphifyResult.orphans ?? orphans;
      cycles = graphifyResult.cycles ?? cycles;
    }

    const couplingMetrics = this._calculateCouplingMetrics(nodes, edges);

    const result = {
      nodes: nodes,
      edges: edges,
      orphans: orphans,
      cycles: cycles,
      couplingMetrics: couplingMetrics,
      fileCount: fileCount,
    };

    this._dependencyCache.set(projectPath, {
      ...result,
      lastScanned: Date.now(),
    });

    this._stats.totalDependencyScans++;

    this.emit('dependencies-scanned', { projectPath, result });

    return result;
  }

  /**
   * 检测跨子系统性能瓶颈
   * @returns {{ bottlenecks: Object[], recommendations: string[], crossCorrelations: Object[] }}
   */
  detectBottlenecks() {
    this.guardShutdown();
    const bottlenecks = [];
    const recommendations = [];
    const crossCorrelations = [];

    this._detectDeliveryBottlenecks(bottlenecks, recommendations);
    this._detectAgentBottlenecks(bottlenecks, recommendations);
    this._detectSkillBottlenecks(bottlenecks, recommendations);
    this._detectTokenBottlenecks(bottlenecks, recommendations);
    this._detectCrossCorrelations(crossCorrelations, recommendations);

    this._stats.totalBottlenecksFound += bottlenecks.length;

    this.emit('bottlenecks-detected', { bottlenecks, recommendations, crossCorrelations });

    return { bottlenecks, recommendations, crossCorrelations };
  }

  /**
   * 检测指标时间序列中的异常
   * @returns {{ anomalies: Object[], totalChecked: number, newAnomalies: number }}
   */
  detectAnomalies() {
    this.guardShutdown();
    const anomalies = [];
    let totalChecked = 0;
    let newAnomalies = 0;

    const keys = this._metricsStore.keys();
    for (const key of keys) {
      const entry = this._metricsStore.get(key);
      if (!entry || !entry.values || entry.values.length < this._trendWindowSize) continue;
      totalChecked++;

      const recentValues = entry.values.slice(-this._trendWindowSize);
      const numericValues = recentValues
        .map(function (v) { return v.value; })
        .filter(function (v) { return typeof v === 'number' && Number.isFinite(v); });

      if (numericValues.length < this._trendWindowSize) continue;

      const mean = numericValues.reduce(function (s, v) { return s + v; }, 0) / numericValues.length;
      const variance = numericValues.reduce(function (s, v) { return s + Math.pow(v - mean, 2); }, 0) / numericValues.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev === 0) continue;

      const latestValue = numericValues[numericValues.length - 1];
      const deviation = Math.abs(latestValue - mean) / stdDev;

      if (deviation > this._anomalyThreshold) {
        const anomalyId = key + '-' + Date.now();
        const severity = deviation > this._anomalyThreshold * 2 ? 'critical' : deviation > this._anomalyThreshold * 1.5 ? 'high' : 'medium';

        const anomaly = {
          source: entry.source,
          metric: entry.metric,
          value: latestValue,
          expected: mean,
          deviation: deviation,
          detectedAt: Date.now(),
          severity: severity,
        };

        this._anomalies.set(anomalyId, anomaly);
        anomalies.push({ anomalyId, ...anomaly });
        newAnomalies++;
      }
    }

    this._stats.totalAnomaliesDetected += newAnomalies;

    this.emit('anomalies-detected', { anomalies, totalChecked, newAnomalies });

    return { anomalies, totalChecked, newAnomalies };
  }

  /**
   * 获取特定指标的趋势
   * @param {string} source - 指标来源
   * @param {string} metric - 指标名称
   * @param {number} [windowSize] - 窗口大小
   * @returns {{ source: string, metric: string, values: Array, direction: string, rateOfChange: number, projected: number|null }}
   */
  getMetricsTrend(source, metric, windowSize) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') {
      throw new Error('source is required and must be a string');
    }
    if (!metric || typeof metric !== 'string') {
      throw new Error('metric is required and must be a string');
    }

    const key = source + ':' + metric;
    const entry = this._metricsStore.get(key);

    if (!entry || !entry.values || entry.values.length === 0) {
      return { source: source, metric: metric, values: [], direction: 'stable', rateOfChange: 0, projected: null };
    }

    const ws = windowSize ?? this._trendWindowSize;
    const values = entry.values.slice(-ws);
    const numericValues = values
      .map(function (v) { return v.value; })
      .filter(function (v) { return typeof v === 'number' && Number.isFinite(v); });

    if (numericValues.length < 2) {
      return { source: source, metric: metric, values: values, direction: 'stable', rateOfChange: 0, projected: null };
    }

    const trendCalc = this._calculateLinearTrend(numericValues);

    return {
      source: source,
      metric: metric,
      values: values,
      direction: trendCalc.direction,
      rateOfChange: trendCalc.rateOfChange,
      projected: trendCalc.projected,
    };
  }

  /**
   * 获取综合分析仪表盘数据
   * @returns {{ summary: Object, topAnomalies: Object[], recentExperiments: Object[], dependencySummary: Object, trendingMetrics: Object[] }}
   */
  getAnalyticsDashboard() {
    this.guardShutdown();

    const summary = {
      totalMetricsCollected: this._stats.totalMetricsCollected,
      totalExperiments: this._stats.totalExperiments,
      totalAnomaliesDetected: this._stats.totalAnomaliesDetected,
      totalDependencyScans: this._stats.totalDependencyScans,
      totalBottlenecksFound: this._stats.totalBottlenecksFound,
      avgCollectionTimeMs: this._stats.avgCollectionTimeMs,
      metricsStoreSize: this._metricsStore.size,
      experimentLogSize: this._experimentLog.size,
      anomalyCount: this._anomalies.size,
      dependencyCacheSize: this._dependencyCache.size,
    };

    const topAnomaliesSlice = this._getTopAnomalies();
    const recentExperimentsSlice = this._getRecentExperiments();
    const dependencySummary = this._getDependencySummary();
    const trendingMetricsSlice = this._getTrendingMetrics();

    return {
      summary: summary,
      topAnomalies: topAnomaliesSlice,
      recentExperiments: recentExperimentsSlice,
      dependencySummary: dependencySummary,
      trendingMetrics: trendingMetricsSlice,
    };
  }

  /**
   * 获取分析统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    this.guardShutdown();
    return {
      totalMetricsCollected: this._stats.totalMetricsCollected,
      totalExperiments: this._stats.totalExperiments,
      totalAnomaliesDetected: this._stats.totalAnomaliesDetected,
      totalDependencyScans: this._stats.totalDependencyScans,
      totalBottlenecksFound: this._stats.totalBottlenecksFound,
      avgCollectionTimeMs: this._stats.avgCollectionTimeMs,
      metricsStoreSize: this._metricsStore.size,
      experimentLogSize: this._experimentLog.size,
      anomalyCount: this._anomalies.size,
      dependencyCacheSize: this._dependencyCache.size,
      initialized: this._initialized,
    };
  }

  /**
   * 检查实例是否健康（未关闭且已初始化）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._initialized;
  }

  /**
   * 检查实例是否就绪（未关闭且已初始化）
   * @returns {boolean} 是否就绪
   */
  isReady() {
    return !this._shutDown && this._initialized;
  }

  /**
   * 关闭清理：释放所有引用和映射
   * @private
   */
  _onShutdown() {
    this._sqliteStore = null;
    this._codeGraph = null;
    this._graphifyCompiler = null;
    this._skillObservability = null;
    this._agentMonitor = null;
    this._devMetricsCollector = null;
    this._deliveryEfficiencyMeter = null;
    this._deepeningMetricsCollector = null;
    this._tokenManager = null;
    this._mcpClient = null;

    safeCall(function () { this._metricsStore.shutdown(); }.bind(this), 'AiDeveloperAnalytics', 'shutdown-metricsStore');
    safeCall(function () { this._experimentLog.shutdown(); }.bind(this), 'AiDeveloperAnalytics', 'shutdown-experimentLog');
    safeCall(function () { this._dependencyCache.shutdown(); }.bind(this), 'AiDeveloperAnalytics', 'shutdown-dependencyCache');
    safeCall(function () { this._anomalies.shutdown(); }.bind(this), 'AiDeveloperAnalytics', 'shutdown-anomalies');

    this._initialized = false;
    this._stats = { totalMetricsCollected: 0, totalExperiments: 0, totalAnomaliesDetected: 0, totalDependencyScans: 0, totalBottlenecksFound: 0, avgCollectionTimeMs: 0 };
    this.removeAllListeners();
  }

  // ---- Private helpers ----

  /**
   * 将stats对象扁平化为统一指标数组
   * @param {string} source - 来源名称
   * @param {Object} stats - 统计对象
   * @param {number} timestamp - 时间戳
   * @returns {Array<{source: string, metric: string, value: number, timestamp: number, tags: Object}>}
   * @private
   */
  _flattenStats(source, stats, timestamp) {
    if (!stats || typeof stats !== 'object') return [];
    const metrics = [];
    const tags = { source: source };

    for (const key of Object.keys(stats)) {
      const value = stats[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        metrics.push({ source: source, metric: key, value: value, timestamp: timestamp, tags: tags });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const nestedTags = Object.assign({}, tags, { parent: key });
        for (const nestedKey of Object.keys(value)) {
          const nestedValue = value[nestedKey];
          if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) {
            metrics.push({ source: source, metric: key + '.' + nestedKey, value: nestedValue, timestamp: timestamp, tags: nestedTags });
          }
        }
      }
    }

    return metrics;
  }

  /**
   * 存储单个指标到_metricsStore
   * @param {Object} metric - 指标对象 { source, metric, value, timestamp, tags }
   * @private
   */
  _storeMetric(metric) {
    const key = metric.source + ':' + metric.metric;
    let entry = this._metricsStore.get(key);

    if (!entry) {
      if (this._metricsStore.size >= this._maxMetricKeys) {
        const oldestKey = this._metricsStore.keys().next().value;
        if (oldestKey) this._metricsStore.delete(oldestKey);
      }
      entry = {
        source: metric.source,
        metric: metric.metric,
        values: [],
        stats: { min: Infinity, max: -Infinity, avg: 0, p95: 0, count: 0 },
      };
    }

    entry.values.push({ timestamp: metric.timestamp, value: metric.value, tags: metric.tags });

    if (entry.values.length > this._maxMetricsPerSource) {
      entry.values = entry.values.slice(-this._maxMetricsPerSource);
    }

    const numericValue = metric.value;
    if (typeof numericValue === 'number' && Number.isFinite(numericValue)) {
      entry.stats.count++;
      entry.stats.sum += numericValue;
      if (numericValue < entry.stats.min) entry.stats.min = numericValue;
      if (numericValue > entry.stats.max) entry.stats.max = numericValue;
    }

    this._updateEntryStats(entry);
    this._metricsStore.set(key, entry);
  }

  /**
   * 更新条目的统计信息
   * @param {Object} entry - 指标条目
   * @private
   */
  _updateEntryStats(entry) {
    const values = entry.values
      .map(function (v) { return v.value; })
      .filter(function (v) { return typeof v === 'number' && Number.isFinite(v); });

    if (values.length === 0) return;

    const count = entry.stats.count || values.length;
    const sum = entry.stats.sum ?? values.reduce(function (s, v) { return s + v; }, 0);

    entry.stats.avg = sum / count;

    // Only sort for p95 computation; min/max are tracked incrementally
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    entry.stats.p95 = sorted[p95Index];
    entry.stats.count = count;
  }

  /**
   * 持久化指标到SQLite
   * @private
   */
  _persistMetrics() {
    if (!this._sqliteStore) return;
    safeCall(
      function () {
        const keys = this._metricsStore.keys();
        for (const key of keys) {
          const entry = this._metricsStore.get(key);
          if (!entry || entry.values.length === 0) continue;
          const latest = entry.values[entry.values.length - 1];
          this._sqliteStore.put(
            'analytics:metric:' + key,
            JSON.stringify({ source: entry.source, metric: entry.metric, latestValue: latest.value, stats: entry.stats, updatedAt: Date.now() }),
          );
        }
      }.bind(this),
      'AiDeveloperAnalytics',
      'persistMetrics',
    );
  }

  /**
   * 持久化实验记录到SQLite
   * @param {string} experimentId - 实验ID
   * @param {Object} record - 实验记录
   * @private
   */
  _persistExperiment(experimentId, record) {
    if (!this._sqliteStore) return;
    safeCall(
      function () {
        this._sqliteStore.put(
          'analytics:experiment:' + experimentId,
          JSON.stringify(record),
        );
      }.bind(this),
      'AiDeveloperAnalytics',
      'persistExperiment',
    );
  }

  /**
   * 计算耦合指标
   * @param {number} nodes - 节点数
   * @param {number} edges - 边数
   * @returns {Object} 耦合指标
   * @private
   */
  _calculateCouplingMetrics(nodes, edges) {
    if (nodes === 0) {
      return { avgFanIn: 0, avgFanOut: 0, instability: 0, couplingDensity: 0 };
    }
    const avgFanIn = edges / nodes;
    const avgFanOut = edges / nodes;
    const instability = avgFanOut > 0 ? avgFanOut / (avgFanIn + avgFanOut) : 0;
    const couplingDensity = nodes > 1 ? edges / (nodes * (nodes - 1)) : 0;
    return { avgFanIn: avgFanIn, avgFanOut: avgFanOut, instability: instability, couplingDensity: couplingDensity };
  }

  /**
   * 从实验记录中提取指标值
   * @param {Object} exp - 实验记录
   * @param {string} metric - 指标名称
   * @returns {number|null} 指标值
   * @private
   */
  _extractMetricValue(exp, metric) {
    if (metric === 'tokenUsage') {
      if (exp.tokenUsage == null) return null;
      if (typeof exp.tokenUsage === 'number') return exp.tokenUsage;
      if (typeof exp.tokenUsage === 'object') return exp.tokenUsage.total ?? exp.tokenUsage.input ?? null;
      return null;
    }
    if (metric === 'latency') {
      return typeof exp.latency === 'number' ? exp.latency : null;
    }
    if (metric === 'successRate') {
      return typeof exp.successRate === 'number' ? exp.successRate : null;
    }
    return null;
  }

  /**
   * 更新平均收集时间
   * @param {number} timeMs - 本次收集时间
   * @private
   */
  _updateAvgCollectionTime(timeMs) {
    const totalCollections = this._stats.totalMetricsCollected > 0 ? Math.ceil(this._stats.totalMetricsCollected / 10) : 1;
    this._stats.avgCollectionTimeMs = (this._stats.avgCollectionTimeMs * (totalCollections - 1) + timeMs) / totalCollections;
  }

  /**
   * 检测交付效率瓶颈
   * @param {Array} bottlenecks - 瓶颈数组
   * @param {Array} recommendations - 建议数组
   * @private
   */
  _detectDeliveryBottlenecks(bottlenecks, recommendations) {
    if (!this._deliveryEfficiencyMeter) return;
    const meterStats = safeExecute(
      function () { return this._deliveryEfficiencyMeter.getStats(); }.bind(this),
      'AiDeveloperAnalytics',
      'detectBottlenecks-delivery',
      null,
    );
    if (meterStats && meterStats.pipelineBottleneck) {
      bottlenecks.push({
        source: 'delivery-efficiency',
        type: 'pipeline-bottleneck',
        details: meterStats.pipelineBottleneck,
        severity: 'high',
      });
      recommendations.push('Address pipeline bottleneck in ' + meterStats.pipelineBottleneck.phase + ' phase');
    }
    if (meterStats && meterStats.reviewThroughputImbalance && meterStats.reviewThroughputImbalance > 1.5) {
      bottlenecks.push({
        source: 'delivery-efficiency',
        type: 'review-throughput-imbalance',
        details: { ratio: meterStats.reviewThroughputImbalance },
        severity: 'medium',
      });
      recommendations.push('Review throughput imbalance detected — consider parallelizing review process');
    }
  }

  /**
   * 检测Agent瓶颈
   * @param {Array} bottlenecks - 瓶颈数组
   * @param {Array} recommendations - 建议数组
   * @private
   */
  _detectAgentBottlenecks(bottlenecks, recommendations) {
    if (!this._agentMonitor) return;
    const monitorStats = safeExecute(
      function () { return this._agentMonitor.getStats(); }.bind(this),
      'AiDeveloperAnalytics',
      'detectBottlenecks-agent',
      null,
    );
    if (monitorStats && monitorStats.antiPatterns && monitorStats.antiPatterns.length > 0) {
      bottlenecks.push({
        source: 'agent-monitor',
        type: 'anti-patterns',
        details: monitorStats.antiPatterns,
        severity: 'medium',
      });
      recommendations.push('Agent anti-patterns detected — review agent delegation patterns');
    }
    if (monitorStats && monitorStats.deferRate && monitorStats.deferRate > 0.3) {
      bottlenecks.push({
        source: 'agent-monitor',
        type: 'high-defer-rate',
        details: { deferRate: monitorStats.deferRate },
        severity: 'high',
      });
      recommendations.push('High agent defer rate (' + (monitorStats.deferRate * 100).toFixed(1) + '%) — agents may be avoiding responsibility');
    }
  }

  /**
   * 检测技能执行瓶颈
   * @param {Array} bottlenecks - 瓶颈数组
   * @param {Array} recommendations - 建议数组
   * @private
   */
  _detectSkillBottlenecks(bottlenecks, recommendations) {
    if (!this._skillObservability) return;
    const skillStats = safeExecute(
      function () { return this._skillObservability.getStats(); }.bind(this),
      'AiDeveloperAnalytics',
      'detectBottlenecks-skill',
      null,
    );
    if (skillStats && skillStats.slowSkills && skillStats.slowSkills.length > 0) {
      bottlenecks.push({
        source: 'skill-observability',
        type: 'slow-skills',
        details: skillStats.slowSkills,
        severity: 'low',
      });
      recommendations.push('Slow skill executions detected — consider optimizing: ' + skillStats.slowSkills.slice(0, 3).join(', '));
    }
  }

  /**
   * 检测Token预算瓶颈
   * @param {Array} bottlenecks - 瓶颈数组
   * @param {Array} recommendations - 建议数组
   * @private
   */
  _detectTokenBottlenecks(bottlenecks, recommendations) {
    if (!this._tokenManager) return;
    const tokenStats = safeExecute(
      function () { return this._tokenManager.getStats(); }.bind(this),
      'AiDeveloperAnalytics',
      'detectBottlenecks-token',
      null,
    );
    if (tokenStats && tokenStats.budgetUsage && tokenStats.budgetUsage > 0.8) {
      bottlenecks.push({
        source: 'token-manager',
        type: 'budget-overrun-risk',
        details: { budgetUsage: tokenStats.budgetUsage },
        severity: 'high',
      });
      recommendations.push('Token budget usage at ' + (tokenStats.budgetUsage * 100).toFixed(1) + '% — consider switching to lower-cost model');
    }
  }

  /**
   * 检测跨子系统关联
   * @param {Array} crossCorrelations - 关联数组
   * @param {Array} recommendations - 建议数组
   * @private
   */
  _detectCrossCorrelations(crossCorrelations, recommendations) {
    if (!this._tokenManager || !this._skillObservability) return;
    const tokenStats = safeExecute(
      function () { return this._tokenManager.getStats(); }.bind(this),
      'AiDeveloperAnalytics',
      'crossCorrelate-token-skill',
      null,
    );
    const skillStats = safeExecute(
      function () { return this._skillObservability.getStats(); }.bind(this),
      'AiDeveloperAnalytics',
      'crossCorrelate-skill',
      null,
    );
    const highTokenUsage = tokenStats && tokenStats.budgetUsage && tokenStats.budgetUsage > 0.6;
    const lowQuality = skillStats && skillStats.avgSuccessRate != null && skillStats.avgSuccessRate < 0.7;
    if (highTokenUsage && lowQuality) {
      crossCorrelations.push({
        sources: ['token-manager', 'skill-observability'],
        finding: 'prompt-inefficiency',
        details: { budgetUsage: tokenStats.budgetUsage, avgSuccessRate: skillStats.avgSuccessRate },
        severity: 'high',
      });
      recommendations.push('High token usage + low quality score suggests prompt inefficiency — optimize prompts');
    }
  }

  /**
   * 构建实验推荐
   * @param {Array} experiments - 实验数组
   * @param {Object} bestPerMetric - 每个指标的最佳实验
   * @param {string[]} metrics - 指标列表
   * @returns {string} 推荐文本
   * @private
   */
  _buildRecommendation(experiments, bestPerMetric, metrics) {
    const bestCounts = {};
    for (const metric of metrics) {
      const best = bestPerMetric[metric];
      if (best) {
        bestCounts[best] = (bestCounts[best] ?? 0) + 1;
      }
    }
    const bestOverall = Object.entries(bestCounts).sort(function (a, b) { return b[1] - a[1]; })[0];
    if (bestOverall) {
      const bestExp = experiments.find(function (e) { return e.experimentId === bestOverall[0]; });
      return bestExp
        ? 'Recommend ' + bestExp.name + ' (' + bestOverall[0] + ') — best in ' + bestOverall[1] + ' metric(s)'
        : 'No clear recommendation';
    }
    return 'Insufficient data for recommendation';
  }

  /**
   * 计算线性趋势
   * @param {number[]} numericValues - 数值数组
   * @returns {{ direction: string, rateOfChange: number, projected: number }}
   * @private
   */
  _calculateLinearTrend(numericValues) {
    const n = numericValues.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += numericValues[i];
      sumXY += i * numericValues[i];
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    const slope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
    const avgValue = n > 0 ? sumY / n : 0;
    const rateOfChange = avgValue !== 0 ? (slope / Math.abs(avgValue)) * 100 : 0;

    let direction = 'stable';
    if (Math.abs(rateOfChange) > 5) {
      direction = rateOfChange > 0 ? 'up' : 'down';
    }

    const projected = slope * n + (n > 0 ? (sumY - slope * sumX) / n : 0);

    return { direction: direction, rateOfChange: rateOfChange, projected: projected };
  }

  /**
   * 获取按严重度排序的Top异常
   * @returns {Object[]} Top异常列表
   * @private
   */
  _getTopAnomalies() {
    const topAnomalies = [];
    const anomalyKeys = this._anomalies.keys();
    for (const key of anomalyKeys) {
      const anomaly = this._anomalies.get(key);
      if (anomaly) topAnomalies.push({ anomalyId: key, ...anomaly });
    }
    topAnomalies.sort(function (a, b) {
      const severityOrder = { critical: 3, high: 2, medium: 1, low: 0 };
      return (severityOrder[b.severity] ?? 0) - (severityOrder[a.severity] ?? 0);
    });
    return topAnomalies.slice(0, 10);
  }

  /**
   * 获取最近的实验记录
   * @returns {Object[]} 最近实验列表
   * @private
   */
  _getRecentExperiments() {
    const recentExperiments = [];
    const expKeys = this._experimentLog.keys();
    for (const key of expKeys) {
      const exp = this._experimentLog.get(key);
      if (exp) recentExperiments.push({ experimentId: key, ...exp });
    }
    recentExperiments.sort(function (a, b) { return (b.startedAt ?? 0) - (a.startedAt ?? 0); });
    return recentExperiments.slice(0, 10);
  }

  /**
   * 获取依赖图摘要
   * @returns {Object} 依赖图摘要
   * @private
   */
  _getDependencySummary() {
    const dependencySummary = { cachedProjects: this._dependencyCache.size };
    const depKeys = this._dependencyCache.keys();
    for (const key of depKeys) {
      const dep = this._dependencyCache.get(key);
      if (dep) {
        dependencySummary[key] = { nodes: dep.nodes, edges: dep.edges, orphans: dep.orphans, cycles: dep.cycles, lastScanned: dep.lastScanned };
      }
    }
    return dependencySummary;
  }

  /**
   * 获取趋势指标
   * @returns {Object[]} 趋势指标列表
   * @private
   */
  _getTrendingMetrics() {
    const trendingMetrics = [];
    const metricKeys = this._metricsStore.keys();
    for (const key of metricKeys) {
      const entry = this._metricsStore.get(key);
      if (!entry || !entry.values || entry.values.length < 3) continue;
      const trend = this.getMetricsTrend(entry.source, entry.metric);
      if (trend.direction !== 'stable') {
        trendingMetrics.push({
          source: entry.source,
          metric: entry.metric,
          direction: trend.direction,
          rateOfChange: trend.rateOfChange,
        });
      }
    }
    trendingMetrics.sort(function (a, b) { return Math.abs(b.rateOfChange) - Math.abs(a.rateOfChange); });
    return trendingMetrics.slice(0, 5);
  }
}

module.exports = withShutdown(AiDeveloperAnalytics);

Object.assign(module.exports, {
  MAX_METRICS_PER_SOURCE: 1000,
  MAX_METRIC_KEYS: 500,
  MAX_METRICS_STORE: 5000,
  MAX_EXPERIMENT_LOG: 200,
  MAX_DEPENDENCY_CACHE: 100,
  MAX_ANOMALIES: 100,
  ANOMALY_THRESHOLD: 2.0,
  TREND_WINDOW_SIZE: 20,
  SUPPORTED_SOURCES: ['skill-observability', 'agent-monitor', 'dev-metrics', 'delivery-efficiency', 'deepening-metrics', 'token-manager', 'code-graph', 'graphify-compiler'],
  METRIC_SCHEMA: { source: 'string', metric: 'string', value: 'number', timestamp: 'number', tags: 'object' },
});
