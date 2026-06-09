'use strict';

const { EventEmitter } = require('events');
const { generateId } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const BoundedArray = require('../../utils/bounded-array');

const METRIC_TYPES = {
  TIME: 'time',
  COST: 'cost',
  FILE_COUNT: 'file_count',
  HALLUCINATION_CORRECTIONS: 'hallucination_corrections',
  ARTIFACT_COUNT: 'artifact_count',
  AGENT_COUNT: 'agent_count',
};

const DEFAULT_COST_PER_TOKEN = 0.000002;
const DEFAULT_TOKENS_PER_CHAR = 0.25;

/**
 * @module runtime/collaboration/dev-metrics-collector
 * @classdesc 开发指标采集器。项目级全生命周期指标采集、阶段级分解统计、CJK感知Token估算
 * DevMetricsCollector — 开发指标采集器
 * 采集项目级全生命周期指标（时间/成本/文件数/幻觉纠正/Token用量），支持阶段级分解统计。
 * 融合ChatDev效率与成本度量方法论，提供项目报告生成、全局统计和CJK感知Token估算。
 * @extends EventEmitter
 * @emits DevMetricsCollector#project-started
 * @emits DevMetricsCollector#project-completed
 * @emits DevMetricsCollector#phase-started
 * @emits DevMetricsCollector#phase-completed
 * @emits DevMetricsCollector#hallucination-corrected
 */
class DevMetricsCollector extends EventEmitter {
  /**
   * 创建DevMetricsCollector实例
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxProjects=100] - 最大项目数量
   * @param {number} [options.maxHistory=500] - 历史记录最大容量
   * @param {number} [options.costPerToken=0.000002] - 每Token成本（美元）
   * @param {number} [options.tokensPerChar=0.25] - 每字符Token比率
   */
  constructor(options) {
    super();
    this._maxProjects = (options ?? {}).maxProjects ?? 100;
    this._costPerToken = (options ?? {}).costPerToken ?? DEFAULT_COST_PER_TOKEN;
    this._tokensPerChar = (options ?? {}).tokensPerChar ?? DEFAULT_TOKENS_PER_CHAR;
    this._projects = new Map();
    this._globalStats = {
      totalProjects: 0,
      completedProjects: 0,
      totalDurationMs: 0,
      totalCost: 0,
      totalFiles: 0,
      totalHallucinationCorrections: 0,
    };
    this._history = new BoundedArray((options ?? {}).maxHistory ?? 500);
  }

  /**
   * 启动项目指标采集，创建项目追踪上下文
   * @param {object} config - 项目配置
   * @param {string} config.projectName - 项目名称（必填）
   * @param {string} [config.description=''] - 项目描述
   * @param {number} [config.agentCount=0] - 参与Agent数量
   * @returns {{ projectId: string|null, status: string, error?: string }} 项目创建结果
   */
  startProject(config) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'startProject:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { projectId: null, error: 'Collector is shut down' }; }
    if (!config || !config.projectName) {
      return { projectId: null, error: 'projectName is required' };
    }

    const projectId = generateId('proj-');
    const project = {
      projectId,
      projectName: config.projectName,
      description: config.description || '',
      agentCount: config.agentCount ?? 0,
      startedAt: Date.now(),
      completedAt: null,
      status: 'in_progress',
      phases: {},
      fileCount: 0,
      hallucinationCorrections: 0,
      artifactCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
      _phaseTimers: {},
    };

    if (this._projects.size >= this._maxProjects) {
      let evictKey = null;
      const completedEntries = [];
      for (const [k, p] of this._projects) {
        if (p.status === 'completed') {
          completedEntries.push([k, p.completedAt ?? 0]);
        }
      }
      if (completedEntries.length > 0) {
        completedEntries.sort((a, b) => a[1] - b[1]);
        evictKey = completedEntries[0][0];
      } else if (this._projects.size > 0) {
        evictKey = this._projects.keys().next().value;
        const evictedProject = this._projects.get(evictKey);
        if (evictedProject && evictedProject.status === 'in_progress') {
          this.emit('project-evicted', { projectId: evictKey, projectName: evictedProject.projectName, status: 'in_progress' });
        }
      }
      if (evictKey) this._projects.delete(evictKey);
    }

    this._projects.set(projectId, project);
    this._globalStats.totalProjects++;

    this.emit('project-started', { projectId, projectName: config.projectName });

    return { projectId, status: project.status };
  }

  /**
   * 启动阶段计时，同一阶段不可重复启动
   * @param {string} projectId - 项目ID
   * @param {string} phase - 阶段名称
   * @returns {{ projectId: string, phase: string, startedAt: number } | { error: string }} 启动结果
   */
  startPhase(projectId, phase) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'startPhase:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { error: 'Collector is shut down' }; }
    const project = this._projects.get(projectId);
    if (!project) return { error: 'Project not found' };
    if (project._phaseTimers[phase]) return { error: 'Phase already started' };

    project._phaseTimers[phase] = { startedAt: Date.now(), completedAt: null };
    if (!project.phases[phase]) {
      project.phases[phase] = {
        durationMs: 0,
        fileCount: 0,
        hallucinationCorrections: 0,
        artifactCount: 0,
        tokenUsage: { input: 0, output: 0, total: 0 },
      };
    }

    this.emit('phase-started', { projectId, phase });

    return { projectId, phase, startedAt: project._phaseTimers[phase].startedAt };
  }

  /**
   * 完成阶段计时并更新阶段指标，自动同步阶段增量到项目总量
   * @param {string} projectId - 项目ID
   * @param {string} phase - 阶段名称
   * @param {object} [result] - 阶段结果
   * @param {number} [result.fileCount] - 产出文件数
   * @param {number} [result.hallucinationCorrections] - 幻觉纠正数
   * @param {number} [result.artifactCount] - 产物数
   * @param {object} [result.tokenUsage] - Token用量{input,output,total}
   * @returns {{ projectId: string, phase: string, durationMs: number } | { error: string }} 完成结果
   */
  completePhase(projectId, phase, result) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'completePhase:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { error: 'Collector is shut down' }; }
    const project = this._projects.get(projectId);
    if (!project) return { error: 'Project not found' };

    const timer = project._phaseTimers[phase];
    if (!timer || timer.completedAt) return { error: 'Phase not started or already completed' };

    timer.completedAt = Date.now();
    const durationMs = timer.completedAt - timer.startedAt;

    const phaseData = project.phases[phase] ?? {};
    this._updatePhaseMetrics(phaseData, result, durationMs);

    project.phases[phase] = phaseData;
    this._updateProjectTotals(project, phaseData);

    this.emit('phase-completed', { projectId, phase, durationMs });

    return { projectId, phase, durationMs };
  }

  _updatePhaseMetrics(phaseData, result, durationMs) {
    phaseData.durationMs = durationMs;
    phaseData.fileCount = (result ?? {}).fileCount ?? phaseData.fileCount ?? 0;
    phaseData.hallucinationCorrections = (result ?? {}).hallucinationCorrections ?? phaseData.hallucinationCorrections ?? 0;
    phaseData.artifactCount = (result ?? {}).artifactCount ?? phaseData.artifactCount ?? 0;

    if ((result ?? {}).tokenUsage) {
      this._mergePhaseTokenUsage(phaseData, result.tokenUsage);
    }
  }

  _mergePhaseTokenUsage(phaseData, tokenUsage) {
    const prevSynced = phaseData._syncedTokenUsage ?? { input: 0, output: 0, total: 0 };
    phaseData.tokenUsage = {
      input: (phaseData.tokenUsage?.input ?? 0) - prevSynced.input + (tokenUsage.input ?? 0),
      output: (phaseData.tokenUsage?.output ?? 0) - prevSynced.output + (tokenUsage.output ?? 0),
      total: (phaseData.tokenUsage?.total ?? 0) - prevSynced.total + (tokenUsage.total ?? 0),
    };
    phaseData._syncedTokenUsage = {
      input: tokenUsage.input ?? 0,
      output: tokenUsage.output ?? 0,
      total: tokenUsage.total ?? 0,
    };
  }

  _updateProjectTotals(project, phaseData) {
    const prevFileCount = phaseData._syncedFileCount ?? 0;
    const prevHallucination = phaseData._syncedHallucinationCorrections ?? 0;
    const prevArtifact = phaseData._syncedArtifactCount ?? 0;
    const deltaFiles = phaseData.fileCount - prevFileCount;
    const deltaHallucination = phaseData.hallucinationCorrections - prevHallucination;
    const deltaArtifact = phaseData.artifactCount - prevArtifact;
    project.fileCount += deltaFiles;
    project.hallucinationCorrections += deltaHallucination;
    project.artifactCount += deltaArtifact;
    phaseData._syncedFileCount = phaseData.fileCount;
    phaseData._syncedHallucinationCorrections = phaseData.hallucinationCorrections;
    phaseData._syncedArtifactCount = phaseData.artifactCount;

    const prevTokenInput = phaseData._syncedProjectTokenInput ?? 0;
    const prevTokenOutput = phaseData._syncedProjectTokenOutput ?? 0;
    const prevTokenTotal = phaseData._syncedProjectTokenTotal ?? 0;
    project.tokenUsage.input += (phaseData.tokenUsage.input ?? 0) - prevTokenInput;
    project.tokenUsage.output += (phaseData.tokenUsage.output ?? 0) - prevTokenOutput;
    project.tokenUsage.total += (phaseData.tokenUsage.total ?? 0) - prevTokenTotal;
    phaseData._syncedProjectTokenInput = phaseData.tokenUsage.input ?? 0;
    phaseData._syncedProjectTokenOutput = phaseData.tokenUsage.output ?? 0;
    phaseData._syncedProjectTokenTotal = phaseData.tokenUsage.total ?? 0;
  }

  /**
   * 记录Token用量，同时更新项目和阶段级别的Token统计
   * @param {string} projectId - 项目ID
   * @param {string} phase - 阶段名称
   * @param {object} tokenUsage - Token用量
   * @param {number} [tokenUsage.input=0] - 输入Token数
   * @param {number} [tokenUsage.output=0] - 输出Token数
   * @param {number} [tokenUsage.total] - 总Token数（默认input+output）
   * @returns {{ projectId: string, phase: string, totalTokens: number } | { error: string }} 记录结果
   */
  recordTokenUsage(projectId, phase, tokenUsage) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'recordTokenUsage:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { error: 'Collector is shut down' }; }
    const project = this._projects.get(projectId);
    if (!project) return { error: 'Project not found' };
    if (!tokenUsage || typeof tokenUsage !== 'object') return { error: 'tokenUsage object is required' };

    const inputTokens = tokenUsage.input ?? 0;
    const outputTokens = tokenUsage.output ?? 0;
    const totalTokens = tokenUsage.total ?? (inputTokens + outputTokens);

    project.tokenUsage.input += inputTokens;
    project.tokenUsage.output += outputTokens;
    project.tokenUsage.total += totalTokens;

    if (project.phases[phase]) {
      project.phases[phase].tokenUsage.input += inputTokens;
      project.phases[phase].tokenUsage.output += outputTokens;
      project.phases[phase].tokenUsage.total += totalTokens;
      project.phases[phase]._syncedProjectTokenInput = (project.phases[phase]._syncedProjectTokenInput ?? 0) + inputTokens;
      project.phases[phase]._syncedProjectTokenOutput = (project.phases[phase]._syncedProjectTokenOutput ?? 0) + outputTokens;
      project.phases[phase]._syncedProjectTokenTotal = (project.phases[phase]._syncedProjectTokenTotal ?? 0) + totalTokens;
    }

    return { projectId, phase, totalTokens };
  }

  /**
   * 记录幻觉纠正次数，同时更新项目和阶段级别统计
   * @param {string} projectId - 项目ID
   * @param {string} phase - 阶段名称
   * @param {number} [count=1] - 纠正次数
   * @returns {{ projectId: string, phase: string, totalCorrections: number } | { error: string }} 记录结果
   */
  recordHallucinationCorrection(projectId, phase, count) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'recordHallucinationCorrection:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { error: 'Collector is shut down' }; }
    const project = this._projects.get(projectId);
    if (!project) return { error: 'Project not found' };

    const n = count ?? 1;
    project.hallucinationCorrections += n;
    if (project.phases[phase]) {
      project.phases[phase].hallucinationCorrections += n;
      project.phases[phase]._syncedHallucinationCorrections = (project.phases[phase]._syncedHallucinationCorrections ?? 0) + n;
    }

    this.emit('hallucination-corrected', { projectId, phase, count: n });

    return { projectId, phase, totalCorrections: project.hallucinationCorrections };
  }

  /**
   * 记录文件产出数量，同时更新项目和阶段级别统计
   * @param {string} projectId - 项目ID
   * @param {string} phase - 阶段名称
   * @param {number} [count=0] - 文件数量
   * @returns {{ projectId: string, phase: string, totalFiles: number } | { error: string }} 记录结果
   */
  recordFileCount(projectId, phase, count) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'recordFileCount:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { error: 'Collector is shut down' }; }
    const project = this._projects.get(projectId);
    if (!project) return { error: 'Project not found' };

    const n = Number.isFinite(count) ? count : 0;
    project.fileCount += n;
    if (project.phases[phase]) {
      project.phases[phase].fileCount += n;
      project.phases[phase]._syncedFileCount = (project.phases[phase]._syncedFileCount ?? 0) + n;
    }

    return { projectId, phase, totalFiles: project.fileCount };
  }

  /**
   * 完成项目指标采集，生成最终报告并写入历史记录
   * 重复调用已完成的项目将返回错误
   * @param {string} projectId - 项目ID
   * @returns {object|{ error: string }} 项目报告或错误
   */
  completeProject(projectId) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'completeProject:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { error: 'Collector is shut down' }; }
    const project = this._projects.get(projectId);
    if (!project) return { error: 'Project not found' };
    if (project.status === 'completed') return { error: 'Project already completed' };

    project.completedAt = Date.now();
    project.status = 'completed';

    const durationMs = project.completedAt - project.startedAt;
    const estimatedCost = project.tokenUsage.total * this._costPerToken;

    this._globalStats.completedProjects++;
    this._globalStats.totalDurationMs += durationMs;
    this._globalStats.totalCost += estimatedCost;
    this._globalStats.totalFiles += project.fileCount;
    this._globalStats.totalHallucinationCorrections += project.hallucinationCorrections;

    const report = this.generateReport(projectId);

    this._history.push({
      projectId,
      projectName: project.projectName,
      durationMs,
      estimatedCost,
      fileCount: project.fileCount,
      hallucinationCorrections: project.hallucinationCorrections,
      timestamp: Date.now(),
    });

    this.emit('project-completed', { projectId, durationMs, estimatedCost, fileCount: project.fileCount });

    return report;
  }

  /**
   * 生成项目指标报告，包含阶段分解、成本估算和Token用量
   * 支持进行中和已完成项目的报告生成
   * @param {string} projectId - 项目ID
   * @returns {object|null} 项目报告，不存在时返回null
   */
  generateReport(projectId) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'generateReport:guardShutdown', _e && _e.message ? _e.message : String(_e)); return null; }
    const project = this._projects.get(projectId);
    if (!project) return null;

    const durationMs = project.completedAt
      ? project.completedAt - project.startedAt
      : Date.now() - project.startedAt;
    const estimatedCost = project.tokenUsage.total * this._costPerToken;

    const phaseBreakdown = {};
    for (const [phase, data] of Object.entries(project.phases)) {
      phaseBreakdown[phase] = {
        durationMs: data.durationMs,
        durationSeconds: Number((data.durationMs / 1000).toFixed(2)),
        fileCount: data.fileCount,
        hallucinationCorrections: data.hallucinationCorrections,
        artifactCount: data.artifactCount,
        tokenUsage: { ...data.tokenUsage },
        estimatedCost: Number((data.tokenUsage.total * this._costPerToken).toFixed(4)),
      };
    }

    return {
      projectId,
      projectName: project.projectName,
      description: project.description,
      status: project.status,
      agentCount: project.agentCount,
      totalDurationMs: durationMs,
      totalDurationSeconds: Number((durationMs / 1000).toFixed(2)),
      estimatedCost: Number(estimatedCost.toFixed(4)),
      totalFiles: project.fileCount,
      totalHallucinationCorrections: project.hallucinationCorrections,
      totalArtifacts: project.artifactCount,
      tokenUsage: { ...project.tokenUsage },
      phaseBreakdown,
      startedAt: (function() { try { const d = new Date(project.startedAt); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); } catch (_e) { debug('DevMetricsCollector', 'parseDate', _e && _e.message ? _e.message : String(_e)); return new Date().toISOString(); } })(),
      completedAt: project.completedAt ? (function() { try { const d = new Date(project.completedAt); return isNaN(d.getTime()) ? null : d.toISOString(); } catch (_e) { debug('DevMetricsCollector', 'parseDate', _e && _e.message ? _e.message : String(_e)); return null; } })() : null,
    };
  }

  /**
   * 获取项目原始数据对象
   * @param {string} projectId - 项目ID
   * @returns {object|null} 项目对象，不存在时返回null
   */
  getProject(projectId) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'getProject:guardShutdown', _e && _e.message ? _e.message : String(_e)); return null; }
    const project = this._projects.get(projectId);
    return project ? (function() { try { return JSON.parse(JSON.stringify(project)); } catch (_e) { debug('DevMetricsCollector', 'deepCopy', _e && _e.message ? _e.message : String(_e)); return project; } })() : null;
  }

  /**
   * 获取全局统计信息，包含跨项目平均时长/成本/文件数/幻觉纠正数
   * @returns {{ totalProjects: number, completedProjects: number, avgDurationSeconds: number, avgCost: number, avgFiles: number, avgHallucinationCorrections: number, totalHallucinationCorrections: number }} 全局统计
   */
  getGlobalStats() {
    try { this.guardShutdown(); } catch (_e) {
      debug('DevMetricsCollector', 'getGlobalStats:guardShutdown', _e && _e.message ? _e.message : String(_e));
      return { totalProjects: 0, completedProjects: 0, avgDurationSeconds: 0, avgCost: 0, avgFiles: 0, avgHallucinationCorrections: 0, totalHallucinationCorrections: 0 };
    }
    const completed = this._globalStats.completedProjects;
    return {
      totalProjects: this._globalStats.totalProjects,
      completedProjects: completed,
      avgDurationSeconds: completed > 0 ? Number(((this._globalStats.totalDurationMs / completed) / 1000).toFixed(2)) : 0,
      avgCost: completed > 0 ? Number((this._globalStats.totalCost / completed).toFixed(4)) : 0,
      avgFiles: completed > 0 ? Number((this._globalStats.totalFiles / completed).toFixed(1)) : 0,
      avgHallucinationCorrections: completed > 0 ? Number((this._globalStats.totalHallucinationCorrections / completed).toFixed(2)) : 0,
      totalHallucinationCorrections: this._globalStats.totalHallucinationCorrections,
    };
  }

  /**
   * 获取已完成项目的历史记录
   * @param {number} [limit=10] - 返回记录数量上限
   * @returns {Array} 历史记录数组
   */
  getHistory(limit) {
    try { this.guardShutdown(); } catch (_e) { debug('DevMetricsCollector', 'getHistory:guardShutdown', _e && _e.message ? _e.message : String(_e)); return []; }
    const n = limit ?? 10; return n > 0 ? this._history.slice(-n) : [];
  }

  /**
   * 估算文本的Token数量，CJK字符按2字符/Token、其他按4字符/Token计算
   * @param {string} text - 待估算文本
   * @returns {number} 估算Token数量
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(cjkCount / 2 + otherCount / 4);
  }

  _onShutdown() {
    this._projects.clear();
    safeCall(() => this._history.shutdown(), 'DevMetricsCollector', 'shutdown-history');
    this._globalStats = {
      totalProjects: 0,
      completedProjects: 0,
      totalDurationMs: 0,
      totalCost: 0,
      totalFiles: 0,
      totalHallucinationCorrections: 0,
    };
    this.removeAllListeners();
  }
}

DevMetricsCollector = withShutdown(DevMetricsCollector);

DevMetricsCollector.METRIC_TYPES = METRIC_TYPES;

module.exports = DevMetricsCollector;
