'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { safeJsonParse } = require('../../utils/safe-parse');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { timestampId } = require('../../utils/unique-id');
const _SqliteStore = require('../infrastructure/sqlite-store');
const { debug } = require('../../utils/debug-logger');
const SddDocumentValidator = require('./sdd-document-validator');

const CONTRACT_STAGES = ['propose', 'spec', 'design', 'tasks'];

const STAGE_REQUIREMENTS = {
  propose: {
    requiredSections: ['problem', 'solution', 'scope', 'stakeholders'],
    qualityGates: ['problemClarity', 'scopeBoundedness', 'stakeholderAlignment'],
  },
  spec: {
    requiredSections: ['functionalRequirements', 'nonFunctionalRequirements', 'constraints', 'acceptanceCriteria'],
    qualityGates: ['requirementCompleteness', 'constraintClarity', 'criteriaMeasurability'],
  },
  design: {
    requiredSections: ['architecture', 'interfaces', 'dataModels', 'errorHandling'],
    qualityGates: ['architectureConsistency', 'interfaceCompleteness', 'errorCoverage'],
  },
  tasks: {
    requiredSections: ['taskBreakdown', 'dependencies', 'estimates', 'riskMitigation'],
    qualityGates: ['taskGranularity', 'dependencyOrdering', 'riskCoverage'],
  },
};

const DEFAULT_CONFIG = {
  maxContracts: 100,
  maxHistoryPerContract: 50,
  strictMode: true,
};

const CONTRACT_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
};

/**
 * @module runtime/sdd/sdd-contract-manager
 * @classdesc SDD合约管理器（SddContractManager）—— SDD规范驱动子系统的合约生命周期管理组件。
 * 管理四文档合约流程（propose→spec→design→tasks），提供阶段推进验证门禁和合约归档功能。
 * 支持合约创建、阶段推进、文档验证、追溯矩阵管理和持久化存储。
 * @extends EventEmitter
 */
class SddContractManager extends EventEmitter {
  /**
   * @param {Object} [config={}] - 配置选项
   * @param {number} [config.maxContracts=100] - 最大合约数量
   * @param {number} [config.maxHistoryPerContract=50] - 每个合约的最大历史记录数
   * @param {boolean} [config.strictMode=true] - 严格模式，阶段推进时强制验证通过
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._contracts = new BoundedMap(this._config.maxContracts);
    this._stageRequirements = STAGE_REQUIREMENTS;
    this._validator = new SddDocumentValidator();
    this._history = new BoundedMap(this._config.maxContracts);
    this._traceItems = new BoundedMap(500);
    this._persistStore = null;
  }

  /**
   * 创建新的SDD合约，初始阶段为 propose，状态为 draft。
   * @param {string} projectRoot - 项目根路径
   * @param {Object} [options] - 合约附加选项
   * @returns {{ contractId: string, status: string, currentStage: string }|null} 合约创建结果，失败时返回 null
   */
  createContract(projectRoot, options) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const contractId = timestampId('sdd-');
      const now = new Date().toISOString();
      const contract = {
        contractId,
        projectRoot: projectRoot || '',
        status: CONTRACT_STATUS.DRAFT,
        currentStage: 'propose',
        completedStages: [],
        documents: {},
        createdAt: now,
        updatedAt: now,
        options: options ?? {},
      };
      this._contracts.set(contractId, contract);
      const historyArr = new BoundedArray(this._config.maxHistoryPerContract);
      this._history.set(contractId, historyArr);
      historyArr.push({
        action: 'created',
        timestamp: now,
        stage: 'propose',
      });
      this.emit('contract-created', { contractId, projectRoot });
      return { contractId, status: contract.status, currentStage: contract.currentStage };
    }, 'SddContractManager', 'createContract', null);
    if (result === null) { this._emitSafeExecuteError('createContract'); }
    return result;
  }

  _emitSafeExecuteError(method, err) {
    try { this.emit('safe-execute-error', { method, error: err && err.message ? err.message : String(err) }); } catch (_e) { debug('SddContractManager', '_emitSafeExecuteError', _e && _e.message ? _e.message : String(_e)); }
  }

  /**
   * 获取指定合约的深拷贝。
   * @param {string} contractId - 合约ID
   * @returns {Object|null} 合约对象的深拷贝，未找到时返回 null
   */
  getContract(contractId) {
    this.guardShutdown();
    if (!contractId || typeof contractId !== 'string') return null;
    const contract = this._contracts.get(contractId);
    if (!contract) return null;
    try { return JSON.parse(JSON.stringify(contract)); } catch (_) { debug('SddContractManager', 'getContract:clone', _ && _.message ? _.message : String(_)); return { ...contract }; }
  }

  /**
   * 推进合约到下一阶段，需通过当前阶段的文档验证门禁。
   * 严格模式下验证失败将阻止推进；所有阶段完成后合约状态变为 completed。
   * @param {string} contractId - 合约ID
   * @param {Object} documentContent - 当前阶段的文档内容
   * @returns {{ advanced: boolean, completed?: boolean, contractId?: string, newStage?: string, reason?: string, validation?: Object }} 推进结果
   */
  advanceStage(contractId, documentContent) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const contract = this._contracts.get(contractId);
      if (!contract) {
        return { advanced: false, reason: 'Contract not found' };
      }
      if (contract.status === CONTRACT_STATUS.ARCHIVED || contract.status === CONTRACT_STATUS.COMPLETED) {
        return { advanced: false, reason: 'Contract is ' + contract.status };
      }
      const currentStage = contract.currentStage;
      const stageIndex = CONTRACT_STAGES.indexOf(currentStage);
      if (stageIndex === -1) {
        return { advanced: false, reason: 'Invalid current stage: ' + currentStage };
      }
      const validation = this._validator.validateDocument(currentStage, documentContent);
      if (!validation.valid && this._config.strictMode) {
        this.emit('stage-advance-blocked', {
          contractId,
          stage: currentStage,
          validation,
        });
        return { advanced: false, reason: 'Validation failed', validation };
      }
      contract.documents[currentStage] = {
        content: documentContent,
        validatedAt: new Date().toISOString(),
        validationScore: validation.score,
        warnings: validation.warnings ?? [],
      };
      contract.completedStages.push(currentStage);
      const nextStageIndex = stageIndex + 1;
      if (nextStageIndex >= CONTRACT_STAGES.length) {
        contract.status = CONTRACT_STATUS.COMPLETED;
        contract.currentStage = currentStage;
        contract.updatedAt = new Date().toISOString();
        this._addHistory(contractId, 'completed', currentStage);
        this.emit('contract-completed', { contractId });
        return { advanced: true, completed: true, contractId };
      }
      const nextStage = CONTRACT_STAGES[nextStageIndex];
      contract.currentStage = nextStage;
      contract.status = CONTRACT_STATUS.ACTIVE;
      contract.updatedAt = new Date().toISOString();
      this._addHistory(contractId, 'advanced', nextStage);
      this.emit('stage-advanced', { contractId, from: currentStage, to: nextStage });
      return { advanced: true, completed: false, contractId, newStage: nextStage };
    }, 'SddContractManager', 'advanceStage', { advanced: false, reason: 'Internal error' });
    if (result && result.advanced === false && result.reason === 'Internal error') { this._emitSafeExecuteError('advanceStage'); }
    return result;
  }

  /**
   * 验证合约所有阶段的文档是否合规。
   * @param {string} contractId - 合约ID
   * @returns {{ valid: boolean, contractId?: string, stageResults?: Object, reason?: string }} 验证结果，包含各阶段验证详情
   */
  validateContract(contractId) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const contract = this._contracts.get(contractId);
      if (!contract) {
        return { valid: false, reason: 'Contract not found' };
      }
      const results = {};
      let allValid = true;
      for (const stage of CONTRACT_STAGES) {
        const doc = contract.documents[stage];
        if (!doc) {
          results[stage] = { valid: false, reason: 'Document missing' };
          allValid = false;
          continue;
        }
        const validation = this._validator.validateDocument(stage, doc.content);
        results[stage] = validation;
        if (!validation.valid) allValid = false;
      }
      return { valid: allValid, contractId, stageResults: results };
    }, 'SddContractManager', 'validateContract', { valid: false, reason: 'Internal error' });
    if (result && result.valid === false && result.reason === 'Internal error') { this._emitSafeExecuteError('validateContract'); }
    return result;
  }

  /**
   * 获取合约的状态摘要信息，包括进度和阶段完成情况。
   * @param {string} contractId - 合约ID
   * @returns {{ contractId: string, status: string, currentStage: string, completedStages: string[], totalStages: number, progress: number, createdAt: string, updatedAt: string }|null} 状态摘要，未找到时返回 null
   */
  getContractStatus(contractId) {
    this.guardShutdown();
    const contract = this._contracts.get(contractId);
    if (!contract) return null;
    return {
      contractId: contract.contractId,
      status: contract.status,
      currentStage: contract.currentStage,
      completedStages: contract.completedStages.slice(),
      totalStages: CONTRACT_STAGES.length,
      progress: contract.completedStages.length / CONTRACT_STAGES.length,
      createdAt: contract.createdAt,
      updatedAt: contract.updatedAt,
    };
  }

  /**
   * 列出所有合约的摘要信息。
   * @returns {Array<{ contractId: string, status: string, currentStage: string, progress: number, updatedAt: string }>} 合约摘要列表
   */
  listContracts() {
    this.guardShutdown();
    const result = [];
    this._contracts.forEach((contract) => {
      result.push({
        contractId: contract.contractId,
        status: contract.status,
        currentStage: contract.currentStage,
        progress: contract.completedStages.length / CONTRACT_STAGES.length,
        updatedAt: contract.updatedAt,
      });
    });
    return result;
  }

  /**
   * 归档合约，将状态设为 archived，已归档的合约不可再推进阶段。
   * @param {string} contractId - 合约ID
   * @returns {{ archived: boolean, contractId?: string, reason?: string }} 归档结果
   */
  archiveContract(contractId) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const contract = this._contracts.get(contractId);
      if (!contract) {
        return { archived: false, reason: 'Contract not found' };
      }
      if (contract.status === CONTRACT_STATUS.ARCHIVED) {
        return { archived: false, reason: 'Already archived' };
      }
      contract.status = CONTRACT_STATUS.ARCHIVED;
      contract.updatedAt = new Date().toISOString();
      this._addHistory(contractId, 'archived', contract.currentStage);
      this.emit('contract-archived', { contractId });
      return { archived: true, contractId };
    }, 'SddContractManager', 'archiveContract', { archived: false, reason: 'Internal error' });
    if (result && result.archived === false && result.reason === 'Internal error') { this._emitSafeExecuteError('archiveContract'); }
    return result;
  }

  /**
   * 获取指定阶段的必需章节和质量门禁要求。
   * @param {string} stage - 阶段名称（propose/spec/design/tasks）
   * @returns {{ requiredSections: string[], qualityGates: string[] }|null} 阶段要求，无效阶段返回 null
   */
  getStageRequirements(stage) {
    this.guardShutdown();
    if (!stage || typeof stage !== 'string') return null;
    return this._stageRequirements[stage] ?? null;
  }

  /**
   * 获取合约流程的所有阶段列表。
   * @returns {string[]} 阶段名称数组（propose/spec/design/tasks）
   */
  getContractStages() {
    this.guardShutdown();
    return CONTRACT_STAGES.slice();
  }

  /**
   * 注册追溯项，将规格说明条目纳入合约的追溯矩阵。
   * @param {string} contractId - 合约ID
   * @param {string} itemId - 追溯项ID
   * @param {Object} [spec] - 规格说明内容
   * @param {Object} [options] - 附加选项
   * @param {string} [options.status] - 初始状态，默认为 'pending'
   * @param {*} [options.implementation] - 实现引用
   * @returns {{ registered: boolean, itemId?: string, reason?: string }} 注册结果
   */
  registerTraceItem(contractId, itemId, spec, options) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const contract = this._contracts.get(contractId);
      if (!contract) return { registered: false, reason: 'Contract not found' };
      if (!itemId || typeof itemId !== 'string') return { registered: false, reason: 'Invalid itemId' };
      const key = contractId + ':' + itemId;
      const entry = {
        contractId,
        itemId,
        spec: spec ?? {},
        status: (options && options.status) ?? 'pending',
        implementation: (options && options.implementation) ?? null,
        evidence: null,
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this._traceItems.set(key, entry);
      this.emit('trace-registered', { contractId, itemId });
      return { registered: true, itemId };
    }, 'SddContractManager', 'registerTraceItem', { registered: false, reason: 'Internal error' });
    if (result && result.registered === false && result.reason === 'Internal error') { this._emitSafeExecuteError('registerTraceItem'); }
    return result;
  }

  /**
   * 更新追溯项的状态和证据。
   * @param {string} contractId - 合约ID
   * @param {string} itemId - 追溯项ID
   * @param {string} status - 新状态
   * @param {*} [evidence] - 验证证据
   * @returns {{ updated: boolean, itemId?: string, previousStatus?: string, newStatus?: string, reason?: string }} 更新结果
   */
  updateTraceStatus(contractId, itemId, status, evidence) {
    this.guardShutdown();
    const result = safeExecute(() => {
      const key = contractId + ':' + itemId;
      const entry = this._traceItems.get(key);
      if (!entry) return { updated: false, reason: 'Trace item not found' };
      const prevStatus = entry.status;
      entry.status = status ?? prevStatus;
      entry.evidence = evidence ?? entry.evidence;
      entry.updatedAt = new Date().toISOString();
      this.emit('trace-status-updated', { contractId, itemId, previousStatus: prevStatus, newStatus: status });
      return { updated: true, itemId, previousStatus: prevStatus, newStatus: status };
    }, 'SddContractManager', 'updateTraceStatus', { updated: false, reason: 'Internal error' });
    if (result && result.updated === false && result.reason === 'Internal error') { this._emitSafeExecuteError('updateTraceStatus'); }
    return result;
  }

  /**
   * 获取指定合约的追溯矩阵，包含所有追溯项及按状态汇总。
   * @param {string} contractId - 合约ID
   * @returns {{ contractId: string, items: Array<{ itemId: string, spec: Object, status: string, implementation: *, evidence: *, updatedAt: string }>, summary: { total: number, byStatus: Object } }} 追溯矩阵
   */
  getTraceMatrix(contractId) {
    this.guardShutdown();
    const items = [];
    const byStatus = {};
    this._traceItems.forEach((entry, _key) => {
      if (entry.contractId !== contractId) return;
      items.push({
        itemId: entry.itemId,
        spec: entry.spec,
        status: entry.status,
        implementation: entry.implementation,
        evidence: entry.evidence,
        updatedAt: entry.updatedAt,
      });
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    });
    return { contractId, items, summary: { total: items.length, byStatus } };
  }

  /**
   * 检查指定合约的规格覆盖率，统计各状态追溯项数量及覆盖率百分比。
   * 覆盖率计算：implemented 计1，partial 计0.5，其余不计。
   * @param {string} contractId - 合约ID
   * @returns {{ contractId: string, totalItems: number, implemented: number, partial: number, pending: number, deviated: number, stale: number, coveragePercent: number }} 规格覆盖率报告
   */
  checkSpecCoverage(contractId) {
    this.guardShutdown();
    const matrix = this.getTraceMatrix(contractId);
    const byStatus = matrix.summary.byStatus;
    const total = matrix.summary.total;
    const implemented = byStatus['implemented'] ?? 0;
    const partial = byStatus['partial'] ?? 0;
    const pending = byStatus['pending'] ?? 0;
    const deviated = byStatus['deviated'] ?? 0;
    const stale = byStatus['stale'] ?? 0;
    const coveragePercent = total > 0 ? Math.round((implemented + partial * 0.5) / total * 100) : 0;
    return { contractId, totalItems: total, implemented, partial, pending, deviated, stale, coveragePercent };
  }

  /**
   * 挂载持久化存储实例，用于合约的持久化和恢复。
   * @param {Object} sqliteStore - SqliteStore 实例，需提供 get/set 方法
   * @returns {{ attached: boolean, reason?: string }} 挂载结果
   */
  attachPersistStore(sqliteStore) {
    this.guardShutdown();
    if (!sqliteStore || typeof sqliteStore.get !== 'function') {
      return { attached: false, reason: 'Invalid SqliteStore' };
    }
    this._persistStore = sqliteStore;
    return { attached: true };
  }

  /**
   * 将合约持久化到已挂载的存储实例中。
   * @param {string} contractId - 合约ID
   * @returns {{ persisted: boolean, contractId?: string, reason?: string }} 持久化结果
   */
  persistContract(contractId) {
    this.guardShutdown();
    const result = safeExecute(() => {
      if (!this._persistStore) return { persisted: false, reason: 'No persist store attached' };
      const contract = this._contracts.get(contractId);
      if (!contract) return { persisted: false, reason: 'Contract not found' };
      const data = JSON.stringify({
        contractId: contract.contractId,
        status: contract.status,
        currentStage: contract.currentStage,
        completedStages: contract.completedStages,
        documents: contract.documents,
        options: contract.options,
        createdAt: contract.createdAt,
        updatedAt: contract.updatedAt,
      });
      this._persistStore.set('sdd-contract:' + contractId, data);
      return { persisted: true, contractId };
    }, 'SddContractManager', 'persistContract', { persisted: false, reason: 'Internal error' });
    if (result && result.persisted === false && result.reason === 'Internal error') { this._emitSafeExecuteError('persistContract'); }
    return result;
  }

  /**
   * 从已挂载的存储实例中恢复合约到内存，不会覆盖已存在的合约。
   * @param {string} contractId - 合约ID
   * @returns {{ restored: boolean, contractId?: string, reason?: string }} 恢复结果
   */
  restoreContract(contractId) {
    this.guardShutdown();
    const result = safeExecute(() => {
      if (!this._persistStore) return { restored: false, reason: 'No persist store attached' };
      const data = this._persistStore.get('sdd-contract:' + contractId);
      if (!data) return { restored: false, reason: 'Contract data not found in store' };
      const parsed = safeJsonParse(data);
      if (!parsed) return { restored: false, reason: 'Contract data corrupted' };
      if (this._contracts.has(parsed.contractId)) {
        return { restored: false, reason: 'Contract already exists in memory' };
      }
      this._contracts.set(parsed.contractId, parsed);
      this._history.set(parsed.contractId, new BoundedArray(this._config.maxHistoryPerContract));
      return { restored: true, contractId: parsed.contractId };
    }, 'SddContractManager', 'restoreContract', { restored: false, reason: 'Internal error' });
    if (result && result.restored === false && result.reason === 'Internal error') { this._emitSafeExecuteError('restoreContract'); }
    return result;
  }

  _addHistory(contractId, action, stage) {
    const history = this._history.get(contractId);
    if (history) {
      history.push({
        action,
        timestamp: new Date().toISOString(),
        stage,
      });
    }
  }

  _onShutdown() {
    if (this._validator && typeof this._validator.shutdown === 'function') {
      this._validator.shutdown();
    }
    // 防御性：先收集需要归档的合同，再清空BoundedMap
    // 避免BoundedMap如果已被shutdown则forEach抛出异常
    try {
      this._contracts.forEach((contract) => {
        contract.status = CONTRACT_STATUS.ARCHIVED;
      });
    } catch (_e) { debug('SddContractManager', '_onShutdown-contracts', _e && _e.message ? _e.message : String(_e)); }
    this._contracts.clear();
    try {
      this._history.forEach((arr) => {
        if (arr && typeof arr.clear === 'function') arr.clear();
      });
    } catch (_e) { debug('SddContractManager', '_onShutdown-history', _e && _e.message ? _e.message : String(_e)); }
    this._history.clear();
    this._traceItems.clear();
    this._persistStore = null;
    this.removeAllListeners();
  }
}

SddContractManager.CONTRACT_STAGES = CONTRACT_STAGES;
SddContractManager.STAGE_REQUIREMENTS = STAGE_REQUIREMENTS;
SddContractManager.CONTRACT_STATUS = CONTRACT_STATUS;

module.exports = withShutdown(SddContractManager);
