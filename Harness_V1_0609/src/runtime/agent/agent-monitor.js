'use strict';

const { EventEmitter } = require('events');
const { AgentError } = require('../../errors');
const { validateAgentId, validateProjectRoot, DEFAULT_MIN_HEARTBEAT_MS, DEFAULT_MAX_ENTRIES, MS_PER_SECOND } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { withShutdown } = require('../../utils/shutdown-mixin');

const METRIC_TYPES = {
  CPU: 'cpu',
  MEMORY: 'memory',
  RESPONSE_TIME: 'response_time',
  TASK_COUNT: 'task_count',
  ERROR_RATE: 'error_rate',
  THROUGHPUT: 'throughput',
  CUSTOM: 'custom',
};

const METRIC_TYPES_SET = new Set(Object.values(METRIC_TYPES));
const VALID_LOG_LEVELS = new Set(['info', 'warn', 'error', 'debug']);

const ALERT_LEVELS = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

const DEFAULT_THRESHOLDS = {
  cpuPercent: { warning: 70, critical: 90 },
  memoryMB: { warning: 400, critical: 480 },
  responseTimeMs: { warning: DEFAULT_MIN_HEARTBEAT_MS, critical: 10 * MS_PER_SECOND },
  errorRate: { warning: 0.05, critical: 0.1 },
};

const DEFAULT_COLLECTION_INTERVAL = DEFAULT_MIN_HEARTBEAT_MS;
const MAX_METRICS_PER_AGENT = DEFAULT_MAX_ENTRIES;
const MAX_ALERTS = 1000;
const MAX_MONITORED_AGENTS = 200;

const ANTIPATTERN_RULES = [
  {
    id: 'over-implementation',
    name: '过度实现',
    description: 'Agent实现超出任务要求的功能',
    detect: function(ctx) {
      return ctx.newFileCount > 3 || ctx.addedLines > 300 || ctx.newAbstractions > 3;
    },
    severity: 'warning',
    recommendation: '触发necessity-review检查YAGNI原则',
  },
  {
    id: 'repeated-search',
    name: '重复搜索',
    description: 'Agent对同一目标重复搜索',
    detect: function(ctx) {
      return ctx.searchCount >= 3 && ctx.uniqueSearchTargets < ctx.searchCount * 0.5;
    },
    severity: 'info',
    recommendation: '使用搜索结果缓存，避免重复查询',
  },
  {
    id: 'skip-verification',
    name: '跳过验证',
    description: 'Agent声称完成但未执行验证',
    detect: function(ctx) {
      return ctx.claimedComplete === true && ctx.verificationRan === false;
    },
    severity: 'critical',
    recommendation: '必须执行verification-before-completion',
  },
  {
    id: 'excessive-retries',
    name: '过度重试',
    description: 'Agent在同一任务上重试超过3次',
    detect: function(ctx) {
      return ctx.retryCount > 3;
    },
    severity: 'warning',
    recommendation: '分析根因而非盲目重试，考虑升级到Team Lead',
  },
  {
    id: 'scope-creep',
    name: '范围蔓延',
    description: 'Agent修改了任务范围外的文件',
    detect: function(ctx) {
      return ctx.filesModified > 5 && ctx.taskRelatedFiles < ctx.filesModified * 0.5;
    },
    severity: 'warning',
    recommendation: '检查修改范围是否超出任务要求',
  },
];

/**
 * @module runtime/agent/agent-monitor
 * @classdesc Agent监控器（AgentMonitor）。实时状态追踪、性能指标采集、异常检测、推诿检测，
 * 内置反模式规则引擎（过度实现、重复搜索等），支持自定义指标采集和告警回调。
 *
 * AgentMonitor — Agent实时监控器
 * 采集Agent运行指标（CPU/内存/响应时间/错误率/吞吐量），检测阈值告警和反模式行为。
 * 内置反模式规则引擎（过度实现、重复搜索等），支持自定义指标采集和告警回调，维护有界指标历史。
 * @extends EventEmitter
 * @emits AgentMonitor#alert
 * @emits AgentMonitor#metrics-collected
 * @emits AgentMonitor#antipattern-detected
 */
class AgentMonitor extends EventEmitter {
  /**
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 监控器配置
   * @param {Object} [options.thresholds] - 自定义告警阈值
   * @param {number} [options.collectionIntervalMs] - 指标采集间隔（毫秒）
   * @param {Object} [options.orientCallbacks] - 关键告警定向回调
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'AgentMonitor', AgentError);
    this.root = projectRoot;
    this.options = options ?? {};
    this._metrics = new Map();
    this._alerts = new BoundedArray(MAX_ALERTS);
    this._thresholds = mergeConfig(DEFAULT_THRESHOLDS, this.options.thresholds ?? {});
    this._collectionIntervals = new Map();
    this._collectionIntervalMs = this.options.collectionIntervalMs ?? DEFAULT_COLLECTION_INTERVAL;
    this._agentRuntimes = new Map();
    this._logEntries = new Map();
    this._totalLogEntries = 0;
    this._behaviorContexts = new Map();
    this._orientCallbacks = (options && options.orientCallbacks) ?? {};
    this._metricHandlers = new Map([
      [METRIC_TYPES.CPU, (m, v, _meta, aid) => { m.currentMetrics.cpuPercent = v; this._checkThreshold(aid, 'cpuPercent', v); }],
      [METRIC_TYPES.MEMORY, (m, v, _meta, aid) => { m.currentMetrics.memoryMB = v; this._checkThreshold(aid, 'memoryMB', v); }],
      [METRIC_TYPES.RESPONSE_TIME, (m, v, _meta, aid) => { m.currentMetrics.responseTimeMs = v; this._checkThreshold(aid, 'responseTimeMs', v); }],
      [METRIC_TYPES.TASK_COUNT, (m, v, _meta) => { m.currentMetrics.taskCount = (typeof v === 'number' && Number.isFinite(v)) ? v : 0; }],
      [METRIC_TYPES.ERROR_RATE, (m, v, _meta, aid) => { m.currentMetrics.errorRate = v; const tc = (typeof m.currentMetrics.taskCount === 'number' && Number.isFinite(m.currentMetrics.taskCount)) ? m.currentMetrics.taskCount : 0; m.currentMetrics.errorCount = Math.round(v * tc); this._checkThreshold(aid, 'errorRate', v); }],
      [METRIC_TYPES.THROUGHPUT, (m, v, _meta) => { m.currentMetrics.throughput = v; }],
      [METRIC_TYPES.CUSTOM, (m, v, meta) => { if (meta && meta.name) m.customMetrics[meta.name] = v; }],
    ]);
  }

  /**
   * 注册Agent到监控器，初始化指标存储和行为上下文。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} [options] - 注册选项
   * @param {Object} [options.runtime] - Agent运行时实例，用于自动采集指标
   * @returns {Object} Agent指标存储对象
   */
  registerAgent(agentId, options) {
    this.guardShutdown();
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) {
      throw new AgentError('INVALID_AGENT_ID', idValidation.reason);
    }
    if (this._metrics.has(agentId)) {
      throw new AgentError('AGENT_ALREADY_MONITORED', `Agent ${agentId} is already being monitored`);
    }
    if (this._metrics.size >= MAX_MONITORED_AGENTS) {
      throw new AgentError('CAPACITY_EXCEEDED', `Maximum monitored agents (${MAX_MONITORED_AGENTS}) reached`);
    }

    const agentMetrics = {
      agentId,
      startTime: new Date().toISOString(),
      currentMetrics: {
        cpuPercent: 0,
        memoryMB: 0,
        responseTimeMs: 0,
        taskCount: 0,
        errorCount: 0,
        throughput: 0,
      },
      history: new BoundedArray(MAX_METRICS_PER_AGENT),
      customMetrics: {},
    };

    this._metrics.set(agentId, agentMetrics);
    this._logEntries.set(agentId, new BoundedArray(500));
    this._behaviorContexts.set(agentId, {
      newFileCount: 0,
      addedLines: 0,
      newAbstractions: 0,
      searchCount: 0,
      uniqueSearchTargets: 0,
      claimedComplete: false,
      verificationRan: false,
      retryCount: 0,
      filesModified: 0,
      taskRelatedFiles: 0,
    });

    if (options && options.runtime) {
      this._agentRuntimes.set(agentId, options.runtime);
    }

    this.emit('agent-registered', { agentId });
    return agentMetrics;
  }

  /**
   * 从监控器注销Agent，停止采集并清理相关数据。
   * @param {string} agentId - Agent唯一标识
   */
  unregisterAgent(agentId) {
    this.guardShutdown();
    if (this._metrics.has(agentId)) {
      this._metrics.delete(agentId);
    }
    if (this._logEntries.has(agentId)) {
      this._logEntries.delete(agentId);
    }
    this._behaviorContexts.delete(agentId);
    this._agentRuntimes.delete(agentId);
    this._stopCollection(agentId);
    this.emit('agent-unregistered', { agentId });
  }

  /**
   * 记录单条Agent指标，更新当前指标值并检查阈值告警。
   * @param {string} agentId - Agent唯一标识
   * @param {string} type - 指标类型（cpu/memory/response_time/task_count/error_rate/throughput/custom）
   * @param {number} value - 指标值
   * @param {Object} [metadata] - 指标元数据（custom类型需提供name字段）
   */
  recordMetric(agentId, type, value, metadata) {
    if (!this.isHealthy()) return;
    if (!METRIC_TYPES_SET.has(type)) {
      debug('AgentMonitor', 'recordMetric', 'Invalid metric type: ' + type);
      return;
    }
    const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (safeValue === 0 && value !== 0) {
      debug('AgentMonitor', 'recordMetric', 'Non-finite value coerced to 0 for agent ' + agentId + ' type ' + type);
    }
    const agentMetrics = this._metrics.get(agentId);
    if (!agentMetrics) return;

    const entry = {
      type,
      value: safeValue,
      timestamp: new Date().toISOString(),
      metadata: metadata ?? {},
    };

    agentMetrics.history.push(entry);

    const handler = this._metricHandlers.get(type);
    if (handler) {
      handler(agentMetrics, safeValue, metadata, agentId);
    }

    this.emit('metric-recorded', { agentId, type, value });
  }

  /**
   * 批量记录Agent指标，自动过滤无效类型。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} metrics - 指标键值对，键为指标类型，值为指标值
   */
  recordMetrics(agentId, metrics) {
    if (!metrics || typeof metrics !== 'object') return;
    Object.entries(metrics).forEach(([type, value]) => {
      if (METRIC_TYPES_SET.has(type)) {
        this.recordMetric(agentId, type, value);
      }
    });
  }

  /**
   * 记录Agent日志事件。
   * @param {string} agentId - Agent唯一标识
   * @param {string} level - 日志级别（info/warn/error/debug）
   * @param {string} message - 日志消息
   * @param {Object} [data] - 日志附加数据
   */
  logEvent(agentId, level, message, data) {
    if (!level || !VALID_LOG_LEVELS.has(level)) level = 'info';
    const logs = this._logEntries.get(agentId);
    if (!logs) return;

    logs.push({
      level,
      message,
      data: data ?? {},
      timestamp: new Date().toISOString(),
    });
    this._totalLogEntries++;

    this.emit('log-event', { agentId, level, message });
  }

  /**
   * 获取Agent当前指标数据。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} [options] - 查询选项
   * @param {boolean} [options.includeHistory] - 是否包含指标历史
   * @param {number} [options.historyLimit] - 历史记录条数限制
   * @returns {Object|null} 指标数据，Agent不存在时返回null
   */
  getMetrics(agentId, options) {
    const agentMetrics = this._metrics.get(agentId);
    if (!agentMetrics) return null;

    const result = {
      agentId,
      currentMetrics: mergeConfig(agentMetrics.currentMetrics),
      customMetrics: mergeConfig(agentMetrics.customMetrics),
      startTime: agentMetrics.startTime,
    };

    if (options && options.includeHistory) {
      const history = agentMetrics.history.toArray();
      if (typeof options.historyLimit === 'number' && options.historyLimit >= 0) {
        result.history = history.slice(-options.historyLimit);
      } else {
        result.history = history;
      }
    }

    return result;
  }

  /**
   * 获取Agent日志条目。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} [options] - 查询选项
   * @param {string} [options.level] - 按日志级别过滤
   * @param {number} [options.limit] - 返回最近N条
   * @returns {Array<Object>} 日志条目列表
   */
  getLogs(agentId, options) {
    const logs = this._logEntries.get(agentId);
    if (!logs) return [];

    let entries = logs.toArray();
    if (options && options.level) {
      entries = entries.filter(e => e.level === options.level);
    }
    if (options && options.limit) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  /**
   * 获取告警列表，支持按Agent和级别过滤。
   * @param {Object} [options] - 查询选项
   * @param {string} [options.agentId] - 按Agent ID过滤
   * @param {string} [options.level] - 按告警级别过滤
   * @param {number} [options.limit] - 返回最近N条
   * @returns {Array<Object>} 告警列表
   */
  getAlerts(options) {
    let alerts = this._alerts.toArray();
    if (options && (options.agentId || options.level)) {
      const aid = options.agentId;
      const lvl = options.level;
      alerts = alerts.filter(function(a) {
        if (aid && a.agentId !== aid) return false;
        if (lvl && a.level !== lvl) return false;
        return true;
      });
    }
    if (options && options.limit) {
      alerts = alerts.slice(-options.limit);
    }
    return alerts;
  }

  /**
   * 启动Agent指标的定时自动采集。
   * @param {string} agentId - Agent唯一标识
   */
  startCollection(agentId) {
    this.guardShutdown();
    if (!this._metrics.has(agentId)) return;
    if (this._collectionIntervals.has(agentId)) return;

    const intervalId = setInterval(() => {
      if (this._shutDown) return;
      this._collectAgentMetrics(agentId);
    }, this._collectionIntervalMs);
    if (intervalId && typeof intervalId.unref === 'function') intervalId.unref();

    this._collectionIntervals.set(agentId, intervalId);
    this.emit('collection-started', { agentId });
  }

  /**
   * 停止Agent指标的定时自动采集。
   * @param {string} agentId - Agent唯一标识
   */
  stopCollection(agentId) {
    this._stopCollection(agentId);
    this.emit('collection-stopped', { agentId });
  }

  _stopCollection(agentId) {
    const intervalId = this._collectionIntervals.get(agentId);
    if (intervalId) {
      clearInterval(intervalId);
      this._collectionIntervals.delete(agentId);
    }
  }

  _collectAgentMetrics(agentId) {
    const runtime = this._agentRuntimes.get(agentId);
    if (!runtime) return;
    if (runtime._shutDown) {
      this._stopCollection(agentId);
      return;
    }

    try {
      const status = runtime.getStatus ? runtime.getStatus(agentId) : runtime.get(agentId);
      if (!status) {
        debug('AgentMonitor', '_collectAgentMetrics', 'No status returned for agent ' + agentId);
        return;
      }

      const allocated = status.allocatedResources ?? {};
      this.recordMetric(agentId, METRIC_TYPES.MEMORY, allocated.memoryMB ?? 0);
      this.recordMetric(agentId, METRIC_TYPES.CPU, allocated.cpuPercent ?? 0);
      this.recordMetric(agentId, METRIC_TYPES.TASK_COUNT, status.taskCount ?? 0);
    } catch (err) {
      this.logEvent(agentId, 'error', `Metric collection failed: ${err && err.message ? err.message : String(err)}`);
    }
  }

  _checkThreshold(agentId, metricName, value) {
    const threshold = this._thresholds[metricName];
    if (!threshold) return;

    let level = null;
    if (value >= threshold.critical) {
      level = ALERT_LEVELS.CRITICAL;
    } else if (value >= threshold.warning) {
      level = ALERT_LEVELS.WARNING;
    }

    if (level) {
      const alert = {
        agentId,
        metricName,
        value,
        level,
        threshold: level === ALERT_LEVELS.CRITICAL ? threshold.critical : threshold.warning,
        timestamp: new Date().toISOString(),
      };

      this._alerts.push(alert);
      this.emit('alert', alert);
      if (level === ALERT_LEVELS.CRITICAL) {
        this.emit('critical-alert', alert);
        const orientCallback = this._orientCallbacks[metricName];
        if (orientCallback && typeof orientCallback === 'function') {
          try { orientCallback(alert); } catch (err) { debug('AgentMonitor', 'orientCallback', err); }
        }
      }
    }
  }

  /**
   * 设置指标告警阈值，warning必须小于critical。
   * @param {string} metricName - 指标名称
   * @param {number} warning - 警告阈值
   * @param {number} critical - 严重阈值
   */
  setThreshold(metricName, warning, critical) {
    if (typeof warning !== 'number' || typeof critical !== 'number' || !Number.isFinite(warning) || !Number.isFinite(critical)) {
      throw new AgentError('INVALID_THRESHOLD', 'warning and critical must be finite numbers');
    }
    if (warning < 0 || critical < 0) {
      throw new AgentError('INVALID_THRESHOLD', 'warning and critical must be non-negative');
    }
    if (warning >= critical) {
      throw new AgentError('INVALID_THRESHOLD', 'warning threshold must be less than critical threshold');
    }
    this._thresholds[metricName] = { warning, critical };
  }

  /**
   * 获取当前所有指标的告警阈值配置。
   * @returns {Object} 阈值配置副本
   */
  getThresholds() {
    return mergeConfig(this._thresholds);
  }

  /**
   * 获取监控仪表盘数据，包含所有Agent指标、最近告警和阈值配置。
   * @returns {Object} 仪表盘数据
   */
  getDashboardData() {
    const agents = Array.from(this._metrics.entries()).map(([agentId, metrics]) => ({
      agentId,
      currentMetrics: mergeConfig(metrics.currentMetrics),
      customMetrics: mergeConfig(metrics.customMetrics),
      startTime: metrics.startTime,
    }));

    const recentAlerts = this._alerts.toArray().slice(-20);

    return {
      agents,
      recentAlerts,
      thresholds: mergeConfig(this._thresholds),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 获取监控器统计摘要。
   * @returns {Object} 统计数据（monitoredAgents/totalAlerts/activeCollections/totalLogEntries）
   */
  getStats() {
    return {
      monitoredAgents: this._metrics.size,
      totalAlerts: this._alerts.length,
      activeCollections: this._collectionIntervals.size,
      totalLogEntries: this._totalLogEntries,
    };
  }

  _countDeferrals(interactionLog, deferPatterns) {
    const agentTaskCounts = new Map();
    const agentDeferCounts = new Map();
    for (const entry of interactionLog) {
      const fromAgent = entry.fromAgent || entry.agentId;
      const toAgent = entry.toAgent || entry.targetAgentId;
      if (!fromAgent) continue;
      if (!agentTaskCounts.has(fromAgent)) agentTaskCounts.set(fromAgent, 0);
      agentTaskCounts.set(fromAgent, agentTaskCounts.get(fromAgent) + 1);
      if (toAgent && toAgent !== fromAgent) {
        const message = entry.message || entry.content || '';
        let isDeferral = false;
        for (const dp of deferPatterns) {
          if (dp.test(message)) { isDeferral = true; break; }
        }
        if (isDeferral) {
          if (!agentDeferCounts.has(fromAgent)) agentDeferCounts.set(fromAgent, 0);
          agentDeferCounts.set(fromAgent, agentDeferCounts.get(fromAgent) + 1);
        }
      }
    }
    return { agentTaskCounts, agentDeferCounts };
  }

  _identifyShirkingAgents(agentTaskCounts, agentDeferCounts) {
    const shirkingAgents = [];
    for (const [agentId, taskCount] of agentTaskCounts) {
      const deferCount = agentDeferCounts.get(agentId) ?? 0;
      const deferRate = taskCount > 0 ? deferCount / taskCount : 0;
      if (deferRate > 0.5 && deferCount >= 2) {
        shirkingAgents.push({
          agentId,
          deferRate: Math.round(deferRate * 1000) / 1000,
          deferCount,
          taskCount,
          severity: deferRate > 0.8 ? 'critical' : deferRate > 0.6 ? 'high' : 'moderate',
        });
      }
    }
    return shirkingAgents;
  }

  detectShirking(interactionLog) {
    if (!Array.isArray(interactionLog) || interactionLog.length < 2) {
      return { detected: false, reason: 'insufficient_data' };
    }
    const deferPatterns = [
      /交给|转给|交给.*处理|delegate.?to|pass.?to|forward.?to|不是我的|not.?my.?responsibility/i,
      /需要.*确认|need.*confirm|请.*决定|please.?decide|无法决定|cannot.?decide/i,
    ];
    const { agentTaskCounts, agentDeferCounts } = this._countDeferrals(interactionLog, deferPatterns);
    const shirkingAgents = this._identifyShirkingAgents(agentTaskCounts, agentDeferCounts);
    const circularPatterns = this._detectCircularDeference(interactionLog);
    return {
      detected: shirkingAgents.length > 0 || circularPatterns.length > 0,
      shirkingAgents,
      circularPatterns,
    };
  }

  _detectCircularDeference(interactionLog) {
    const edges = [];
    for (const entry of interactionLog) {
      const from = entry.fromAgent || entry.agentId;
      const to = entry.toAgent || entry.targetAgentId;
      if (from && to && from !== to) {
        edges.push([from, to]);
      }
    }
    const graph = new Map();
    for (const [from, to] of edges) {
      if (!graph.has(from)) graph.set(from, new Set());
      graph.get(from).add(to);
    }
    const cycles = [];
    const visited = new Set();
    const recStack = new Set();
    const path = [];
    const dfs = (node) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);
      const neighbors = graph.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            dfs(neighbor);
          } else if (recStack.has(neighbor)) {
            const cycleStart = path.indexOf(neighbor);
            if (cycleStart >= 0) {
              cycles.push(path.slice(cycleStart).concat([neighbor]));
            }
          }
        }
      }
      path.pop();
      recStack.delete(node);
    };
    for (const node of graph.keys()) {
      if (!visited.has(node)) dfs(node);
    }
    return cycles;
  }

  _onShutdown() {
    this._collectionIntervals.forEach(intervalId => clearInterval(intervalId));
    this._collectionIntervals.clear();
    this._metrics.clear();
    for (const ba of this._logEntries.values()) { safeCall(() => ba.shutdown(), 'AgentMonitor', 'shutdown-logEntry'); }
    this._logEntries.clear();
    this._totalLogEntries = 0;
    this._behaviorContexts.clear();
    this._agentRuntimes.clear();
    safeCall(() => this._alerts.shutdown(), 'AgentMonitor', 'shutdown-alerts');
    this._thresholds = {};
    this.removeAllListeners();
  }

  /**
   * 记录Agent行为数据，更新行为上下文中的字段（数值类型累加，其他类型覆盖）。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} behaviorData - 行为数据键值对
   */
  recordBehavior(agentId, behaviorData) {
    if (!this.isHealthy()) return;
    const ctx = this._behaviorContexts.get(agentId);
    if (!ctx || !behaviorData || typeof behaviorData !== 'object') return;
    const updatedFields = [];
    for (const [key, value] of Object.entries(behaviorData)) {
      if (key in ctx) {
        if (typeof ctx[key] === 'number' && Number.isFinite(ctx[key]) && typeof value === 'number' && Number.isFinite(value)) {
          ctx[key] += value;
        } else {
          ctx[key] = value;
        }
        updatedFields.push(key);
      }
    }
    this.emit('behavior-recorded', { agentId, updatedFields });
  }

  /**
   * 获取Agent行为上下文副本。
   * @param {string} agentId - Agent唯一标识
   * @returns {Object|null} 行为上下文，Agent不存在时返回null
   */
  getBehaviorContext(agentId) {
    const ctx = this._behaviorContexts.get(agentId);
    if (!ctx) return null;
    return mergeConfig(ctx);
  }

  /**
   * 检测Agent行为中的反模式，基于内置规则引擎匹配行为上下文。
   * @param {string} agentId - Agent唯一标识
   * @param {Object} [behaviorContext] - 自定义行为上下文，不传则使用内部记录
   * @returns {Array<Object>} 检测到的反模式列表
   */
  detectAntipatterns(agentId, behaviorContext) {
    this.guardShutdown();
    const ctx = behaviorContext && typeof behaviorContext === 'object' && behaviorContext !== null
      ? behaviorContext
      : this._behaviorContexts.get(agentId);
    if (!ctx) return [];
    const detected = ANTIPATTERN_RULES
      .filter(rule => safeExecute(() => rule.detect(ctx), 'AgentMonitor', 'ruleError', false))
      .map(rule => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        severity: rule.severity,
        recommendation: rule.recommendation,
        agentId,
        timestamp: new Date().toISOString(),
      }));
    if (detected.length > 0) {
      detected.forEach(d => {
        this._alerts.push({
          agentId,
          metricName: 'antipattern:' + d.id,
          value: 1,
          level: d.severity === 'critical' ? ALERT_LEVELS.CRITICAL : d.severity === 'warning' ? ALERT_LEVELS.WARNING : ALERT_LEVELS.INFO,
          threshold: 0,
          timestamp: d.timestamp,
        });
      });
      this.emit('antipattern-detected', { agentId, patterns: detected });
    }
    return detected;
  }

  /**
   * 获取所有内置反模式规则的定义。
   * @returns {Array<Object>} 反模式规则列表（id/name/description/severity）
   */
  getAntipatternRules() {
    return ANTIPATTERN_RULES.map(r => ({ id: r.id, name: r.name, description: r.description, severity: r.severity }));
  }
}

AgentMonitor.METRIC_TYPES = METRIC_TYPES;
AgentMonitor.ALERT_LEVELS = ALERT_LEVELS;
AgentMonitor.DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS;

module.exports = withShutdown(AgentMonitor);
