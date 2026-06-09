'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const _BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');

const TRACE_STATUS = {
  PENDING: 'pending',
  IMPLEMENTED: 'implemented',
  PARTIAL: 'partial',
  DEVIATED: 'deviated',
  STALE: 'stale',
};

const SYNC_STATUS = {
  SYNCED: 'synced',
  DOC_AHEAD: 'doc-ahead',
  CODE_AHEAD: 'code-ahead',
  DIVERGED: 'diverged',
  UNKNOWN: 'unknown',
};

const DEFAULT_CONFIG = {
  maxTraceItems: 500,
  maxSyncReports: 100,
  driftThreshold: 0.3,
};

/**
 * @module runtime/sdd/sdd-sync-verifier
 * @classdesc SDD同步验证器（SddSyncVerifier）—— SDD规范驱动子系统的规范-代码同步验证组件。
 * 追踪规范条目与代码实现的对应关系，检测文档与代码之间的漂移（drift），
 * 提供追溯矩阵管理、覆盖率检查和同步报告生成功能。
 * @extends EventEmitter
 */
class SddSyncVerifier extends EventEmitter {
  /**
   * @param {Object} [config={}] - 配置选项
   * @param {number} [config.maxTraceItems=500] - 最大追溯条目数量
   * @param {number} [config.maxSyncReports=100] - 最大同步报告数量
   * @param {number} [config.driftThreshold=0.3] - 漂移检测阈值
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._traceItems = new BoundedMap(this._config.maxTraceItems);
    this._syncReports = new BoundedMap(this._config.maxSyncReports);
    this._contractManager = null;
    this._ironRuleEngine = null;
  }

  /**
   * 附加SDD合约管理器实例，用于后续的合约相关操作
   * @param {Object} manager - SDD合约管理器实例
   * @returns {{ attached: boolean }} 附加结果，attached 为 true 表示成功
   */
  attachSddContractManager(manager) {
    this.guardShutdown();
    this._contractManager = manager;
    return { attached: true };
  }

  /**
   * 附加铁律引擎实例，用于后续的铁律校验相关操作
   * @param {Object} engine - 铁律引擎实例
   * @returns {{ attached: boolean }} 附加结果，attached 为 true 表示成功
   */
  attachIronRuleEngine(engine) {
    this.guardShutdown();
    this._ironRuleEngine = engine;
    return { attached: true };
  }

  /**
   * 注册一个追溯条目，将规范条目与合约关联以便追踪
   * @param {string} contractId - 合约标识
   * @param {string} itemId - 追溯条目标识
   * @param {Object} spec - 规范描述对象
   * @param {string} [spec.description] - 规范描述文本
   * @param {string} [spec.stage] - 所属阶段
   * @param {string} [spec.source] - 规范来源
   * @param {string[]} [spec.requirements] - 需求模式列表
   * @param {Object} [options] - 可选配置
   * @param {Object} [options.implementation] - 初始实现信息
   * @param {string} [options.status] - 初始状态（默认为 pending）
   * @returns {{ registered: boolean, itemId: string|null, reason?: string }} 注册结果
   */
  registerTraceItem(contractId, itemId, spec, options) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!contractId || typeof contractId !== 'string') {
        return { registered: false, itemId: null, reason: 'contractId is required' };
      }
      if (!itemId || typeof itemId !== 'string') {
        return { registered: false, itemId: null, reason: 'itemId is required' };
      }
      if (!spec || typeof spec !== 'object') {
        return { registered: false, itemId: null, reason: 'spec is required' };
      }
      const key = contractId + ':' + itemId;
      if (this._traceItems.has(key)) {
        return { registered: false, itemId, reason: 'Trace item already exists' };
      }
      const opts = options ?? {};
      const now = new Date().toISOString();
      const traceItem = {
        contractId,
        itemId,
        spec: {
          description: spec.description ?? '',
          stage: spec.stage ?? '',
          source: spec.source ?? '',
          requirements: Array.isArray(spec.requirements) ? spec.requirements.slice() : [],
        },
        implementation: opts.implementation ?? null,
        status: opts.status ?? TRACE_STATUS.PENDING,
        evidence: null,
        createdAt: now,
        updatedAt: now,
      };
      this._traceItems.set(key, traceItem);
      this.emit('trace-registered', { contractId, itemId, status: traceItem.status });
      return { registered: true, itemId };
    }, 'SddSyncVerifier', 'registerTraceItem', { registered: false, itemId: null, reason: 'Internal error' });
  }

  /**
   * 更新追溯条目的状态和证据信息
   * @param {string} contractId - 合约标识
   * @param {string} itemId - 追溯条目标识
   * @param {string} status - 新状态（pending | implemented | partial | deviated | stale）
   * @param {Object} [evidence] - 实现证据
   * @param {string} [evidence.file] - 证据文件路径
   * @param {number} [evidence.line] - 证据所在行号
   * @param {string} [evidence.description] - 证据描述
   * @param {string} [evidence.verifiedAt] - 验证时间
   * @returns {{ updated: boolean, itemId: string|null, previousStatus: string|null, newStatus: string|null, reason?: string }} 更新结果
   */
  updateTraceStatus(contractId, itemId, status, evidence) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!contractId || typeof contractId !== 'string') {
        return { updated: false, itemId: null, previousStatus: null, newStatus: null };
      }
      if (!itemId || typeof itemId !== 'string') {
        return { updated: false, itemId: null, previousStatus: null, newStatus: null };
      }
      const validStatuses = Object.values(TRACE_STATUS);
      if (!validStatuses.includes(status)) {
        return { updated: false, itemId, previousStatus: null, newStatus: null, reason: 'Invalid status: ' + status };
      }
      const key = contractId + ':' + itemId;
      const traceItem = this._traceItems.get(key);
      if (!traceItem) {
        return { updated: false, itemId, previousStatus: null, newStatus: null, reason: 'Trace item not found' };
      }
      const previousStatus = traceItem.status;
      traceItem.status = status;
      traceItem.evidence = evidence ? {
        file: evidence.file || null,
        line: evidence.line ?? null,
        description: evidence.description || '',
        verifiedAt: evidence.verifiedAt || new Date().toISOString(),
      } : traceItem.evidence;
      traceItem.updatedAt = new Date().toISOString();
      this.emit('trace-status-updated', { contractId, itemId, previousStatus, newStatus: status });
      return { updated: true, itemId, previousStatus, newStatus: status };
    }, 'SddSyncVerifier', 'updateTraceStatus', { updated: false, itemId: null, previousStatus: null, newStatus: null });
  }

  /**
   * 获取指定合约的追溯矩阵，包含所有追溯条目及按状态汇总
   * @param {string} contractId - 合约标识
   * @returns {{ contractId: string, items: Object[], summary: { total: number, byStatus: Object } }} 追溯矩阵
   */
  getTraceMatrix(contractId) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!contractId || typeof contractId !== 'string') {
        return { contractId, items: [], summary: { total: 0, byStatus: {} } };
      }
      const items = [];
      const byStatus = {};
      this._traceItems.forEach((traceItem) => {
        if (traceItem.contractId !== contractId) return;
        items.push({
          itemId: traceItem.itemId,
          spec: traceItem.spec,
          status: traceItem.status,
          evidence: traceItem.evidence,
          updatedAt: traceItem.updatedAt,
        });
        byStatus[traceItem.status] = (byStatus[traceItem.status] ?? 0) + 1;
      });
      return {
        contractId,
        items,
        summary: { total: items.length, byStatus },
      };
    }, 'SddSyncVerifier', 'getTraceMatrix', { contractId: contractId || '', items: [], summary: { total: 0, byStatus: {} } });
  }

  /**
   * 检查指定合约的规范覆盖率，统计各状态条目数量并计算覆盖率百分比
   * @param {string} contractId - 合约标识
   * @returns {{ contractId: string, totalItems: number, implemented: number, partial: number, pending: number, deviated: number, stale: number, coveragePercent: number }} 覆盖率统计
   */
  checkSpecCoverage(contractId) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!contractId || typeof contractId !== 'string') {
        return { contractId, totalItems: 0, implemented: 0, partial: 0, pending: 0, deviated: 0, stale: 0, coveragePercent: 0 };
      }
      let totalItems = 0;
      let implemented = 0;
      let partial = 0;
      let pending = 0;
      let deviated = 0;
      let stale = 0;
      this._traceItems.forEach((traceItem) => {
        if (traceItem.contractId !== contractId) return;
        totalItems++;
        switch (traceItem.status) {
          case TRACE_STATUS.IMPLEMENTED: implemented++; break;
          case TRACE_STATUS.PARTIAL: partial++; break;
          case TRACE_STATUS.PENDING: pending++; break;
          case TRACE_STATUS.DEVIATED: deviated++; break;
          case TRACE_STATUS.STALE: stale++; break;
          default:
            debug('SddSyncVerifier', 'checkSpecCoverage', 'Unknown trace status: ' + traceItem.status);
            break;
        }
      });
      const coveragePercent = totalItems > 0
        ? Math.round(((implemented + partial * 0.5) / totalItems) * 100) / 100
        : 0;
      return { contractId, totalItems, implemented, partial, pending, deviated, stale, coveragePercent };
    }, 'SddSyncVerifier', 'checkSpecCoverage', { contractId: contractId || '', totalItems: 0, implemented: 0, partial: 0, pending: 0, deviated: 0, stale: 0, coveragePercent: 0 });
  }

  /**
   * 检测规范与代码之间的漂移，通过对比代码快照与追溯条目判断同步状态
   * @param {string} contractId - 合约标识
   * @param {Object} [codeSnapshot] - 代码快照
   * @param {Array<{ path: string, content: string }>} [codeSnapshot.files] - 代码文件列表
   * @returns {{ contractId: string, driftDetected: boolean, drifts: Object[], syncStatus: string }} 漂移检测结果，syncStatus 为 synced | doc-ahead | code-ahead | diverged | unknown
   */
  detectDrift(contractId, codeSnapshot) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!contractId || typeof contractId !== 'string') {
        return { contractId, driftDetected: false, drifts: [], syncStatus: SYNC_STATUS.UNKNOWN };
      }
      const files = (codeSnapshot && Array.isArray(codeSnapshot.files)) ? codeSnapshot.files : [];
      const fileMap = {};
      for (const f of files) {
        if (f && f.path) {
          fileMap[f.path] = f;
        }
      }
      const drifts = [];
      let docAheadCount = 0;
      let codeAheadCount = 0;
      let totalChecked = 0;
      this._traceItems.forEach((traceItem) => {
        if (traceItem.contractId !== contractId) return;
        const result = this._checkTraceItemDrift(traceItem, fileMap, contractId, drifts);
        totalChecked += result.totalChecked;
        docAheadCount += result.docAheadCount;
      });
      const codeResult = this._checkCodeAheadFiles(fileMap, contractId, drifts);
      codeAheadCount = codeResult.codeAheadCount;
      const syncStatus = this._determineSyncStatus(drifts, docAheadCount, codeAheadCount, totalChecked);
      const driftDetected = drifts.length > 0;
      if (driftDetected) {
        this.emit('drift-detected', { contractId, drifts, syncStatus });
      }
      return { contractId, driftDetected, drifts, syncStatus };
    }, 'SddSyncVerifier', 'detectDrift', { contractId: contractId || '', driftDetected: false, drifts: [], syncStatus: SYNC_STATUS.UNKNOWN });
  }

  _checkTraceItemDrift(traceItem, fileMap, contractId, drifts) {
    let totalChecked = 0;
    let docAheadCount = 0;
    const checkStatuses = [TRACE_STATUS.IMPLEMENTED, TRACE_STATUS.PARTIAL];
    if (!checkStatuses.includes(traceItem.status)) {
      if (traceItem.status === TRACE_STATUS.PENDING) {
        totalChecked++;
        docAheadCount++;
        drifts.push({
          itemId: traceItem.itemId,
          type: 'spec-not-implemented',
          description: 'Spec item "' + traceItem.itemId + '" is pending but has no implementation',
        });
      }
      return { totalChecked, docAheadCount };
    }
    totalChecked++;
    const evidence = traceItem.evidence;
    if (!evidence || !evidence.file) {
      drifts.push({
        itemId: traceItem.itemId,
        type: 'file-missing',
        description: 'Trace item "' + traceItem.itemId + '" marked as ' + traceItem.status + ' but no evidence file recorded',
      });
      docAheadCount++;
      return { totalChecked, docAheadCount };
    }
    const fileData = fileMap[evidence.file];
    if (!fileData) {
      drifts.push({
        itemId: traceItem.itemId,
        type: 'file-missing',
        description: 'Evidence file "' + evidence.file + '" for item "' + traceItem.itemId + '" not found in code snapshot',
      });
      docAheadCount++;
      return { totalChecked, docAheadCount };
    }
    const content = fileData.content || '';
    const requirements = traceItem.spec.requirements ?? [];
    let patternMissing = false;
    for (const req of requirements) {
      if (req && typeof req === 'string' && req.length > 0) {
        const pattern = req.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          const regex = new RegExp(pattern, 'i');
          if (!regex.test(content)) {
            patternMissing = true;
            drifts.push({
              itemId: traceItem.itemId,
              type: 'pattern-missing',
              description: 'Requirement pattern "' + req.slice(0, 80) + '" not found in file "' + evidence.file + '"',
            });
          }
        } catch (_e) {
          debug('SddSyncVerifier', 'detectDrift:regex', 'Invalid pattern for item ' + traceItem.itemId);
        }
      }
    }
    if (patternMissing) {
      docAheadCount++;
    }
    return { totalChecked, docAheadCount };
  }

  _checkCodeAheadFiles(fileMap, contractId, drifts) {
    const codeFiles = Object.keys(fileMap);
    const evidenceFiles = new Set();
    this._traceItems.forEach((traceItem) => {
      if (traceItem.contractId === contractId && traceItem.evidence && traceItem.evidence.file) {
        evidenceFiles.add(traceItem.evidence.file);
      }
    });
    let codeAheadCount = 0;
    for (const codePath of codeFiles) {
      if (!evidenceFiles.has(codePath)) {
        codeAheadCount++;
        drifts.push({
          itemId: null,
          type: 'code-exceeds-spec',
          description: 'Code file "' + codePath + '" has no corresponding spec trace item',
        });
      }
    }
    return { codeAheadCount };
  }

  _determineSyncStatus(drifts, docAheadCount, codeAheadCount, totalChecked) {
    if (drifts.length === 0) {
      return totalChecked > 0 ? SYNC_STATUS.SYNCED : SYNC_STATUS.UNKNOWN;
    } else if (docAheadCount > 0 && codeAheadCount > 0) {
      return SYNC_STATUS.DIVERGED;
    } else if (docAheadCount > 0) {
      return SYNC_STATUS.DOC_AHEAD;
    } else if (codeAheadCount > 0) {
      return SYNC_STATUS.CODE_AHEAD;
    }
    return SYNC_STATUS.SYNCED;
  }

  /**
   * 生成指定合约的同步报告，汇总追溯矩阵、覆盖率、漂移检测结果及改进建议
   * @param {string} contractId - 合约标识
   * @returns {{ contractId: string, generatedAt: string|null, traceMatrix: Object|null, coverage: Object|null, drift: Object|null, syncStatus: string, recommendations: string[] }} 同步报告
   */
  generateSyncReport(contractId) {
    this.guardShutdown();
    return safeExecute(() => {
      if (!contractId || typeof contractId !== 'string') {
        return { contractId, generatedAt: null, traceMatrix: null, coverage: null, drift: null, syncStatus: SYNC_STATUS.UNKNOWN, recommendations: [] };
      }
      const traceMatrix = this.getTraceMatrix(contractId);
      const coverage = this.checkSpecCoverage(contractId);
      const drift = this.detectDrift(contractId, { files: [] });
      const recommendations = [];
      if (coverage.coveragePercent < 0.5) {
        recommendations.push('Spec coverage is below 50%. Prioritize implementing pending spec items.');
      }
      if (coverage.deviated > 0) {
        recommendations.push(coverage.deviated + ' spec item(s) have deviated from the spec. Review and align implementation.');
      }
      if (coverage.stale > 0) {
        recommendations.push(coverage.stale + ' spec item(s) are stale. Consider updating or removing them.');
      }
      if (drift.driftDetected) {
        recommendations.push('Drift detected between spec and code. Run detailed drift analysis to identify specific issues.');
      }
      if (coverage.pending > 0) {
        recommendations.push(coverage.pending + ' spec item(s) are pending implementation.');
      }
      const report = {
        contractId,
        generatedAt: new Date().toISOString(),
        traceMatrix,
        coverage,
        drift,
        syncStatus: drift.syncStatus,
        recommendations,
      };
      this._syncReports.set(contractId, report);
      this.emit('sync-report-generated', { contractId, syncStatus: drift.syncStatus });
      return report;
    }, 'SddSyncVerifier', 'generateSyncReport', { contractId: contractId || '', generatedAt: null, traceMatrix: null, coverage: null, drift: null, syncStatus: SYNC_STATUS.UNKNOWN, recommendations: [] });
  }

  /**
   * 获取指定合约之前生成的同步报告
   * @param {string} contractId - 合约标识
   * @returns {Object|null} 同步报告对象，若不存在则返回 null
   */
  getSyncReport(contractId) {
    this.guardShutdown();
    if (!contractId || typeof contractId !== 'string') return null;
    return this._syncReports.get(contractId) ?? null;
  }

  /**
   * 获取验证器的运行统计信息
   * @returns {{ totalTraceItems: number, totalSyncReports: number, contractsTracked: number }} 统计信息
   */
  getStats() {
    this.guardShutdown();
    const contracts = new Set();
    this._traceItems.forEach((traceItem) => {
      contracts.add(traceItem.contractId);
    });
    return {
      totalTraceItems: this._traceItems.size,
      totalSyncReports: this._syncReports.size,
      contractsTracked: contracts.size,
    };
  }

  _onShutdown() {
    this._traceItems.clear();
    this._syncReports.clear();
    this._contractManager = null;
    this._ironRuleEngine = null;
    this.removeAllListeners();
  }
}

SddSyncVerifier.TRACE_STATUS = TRACE_STATUS;
SddSyncVerifier.SYNC_STATUS = SYNC_STATUS;

module.exports = withShutdown(SddSyncVerifier);
