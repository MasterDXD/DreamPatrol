'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');

/** @constant {Object<string, string>} SDD_PHASE_MAP - SDD阶段到执行阶段的映射 */
const SDD_PHASE_MAP = {
  propose: 'brainstorming',
  spec: 'requirement-analysis',
  design: 'architecture-design',
  tasks: 'module-development',
};

/** @constant {Object<string, string>} PHASE_SDD_MAP - 执行阶段到SDD阶段的反向映射 */
const PHASE_SDD_MAP = {};
for (const [sddStage, phase] of Object.entries(SDD_PHASE_MAP)) {
  PHASE_SDD_MAP[phase] = sddStage;
}

/** @constant {Object} DEFAULT_CONFIG - 默认配置 */
const DEFAULT_CONFIG = {
  maxEnforcedContracts: 100,
};

/**
 * @module runtime/sdd/sdd-phase-bridge
 * @classdesc SDD阶段桥接器（SddPhaseBridge）—— SDD规范驱动子系统的阶段映射与门禁执行组件。
 * 将SDD（Spec-Driven Development）阶段与六阶段执行流程桥接，
 * 实现合约门禁强制执行、阶段双向映射和自动门禁检查。
 * @extends EventEmitter
 * @emits attached | detached | contract-gate-enforced | contract-gate-blocked
 */
class SddPhaseBridge extends EventEmitter {
  /**
   * 创建SddPhaseBridge实例。
   * @param {Object} [config] - 配置选项
   * @param {number} [config.maxEnforcedContracts=100] - 最大强制合约记录数
   * @param {boolean} [config.autoEnforce=false] - 是否在阶段转换时自动执行门禁
   * @param {boolean} [config.blockOnGateFailure=false] - 门禁失败时是否阻塞阶段转换
   */
  constructor(config) {
    super();
    this._phaseOrchestrator = null;
    this._contractManager = null;
    this._attached = false;
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._enforcedContracts = new BoundedMap(this._config.maxEnforcedContracts);
  }

  /**
   * 附加到PhaseOrchestrator实例，监听阶段转换事件。
   * @param {Object} phaseOrchestrator - PhaseOrchestrator实例
   * @returns {{ attached: boolean, reason?: string }} 附加结果
   * @emits SddPhaseBridge#attached
   */
  attachToPhaseOrchestrator(phaseOrchestrator) {
    this.guardShutdown();
    if (this._attached) return { attached: false, reason: 'Already attached' };
    if (!phaseOrchestrator || typeof phaseOrchestrator !== 'object') {
      return { attached: false, reason: 'Invalid PhaseOrchestrator' };
    }
    this._phaseOrchestrator = phaseOrchestrator;
    this._attached = true;
    if (this._config.autoEnforce && typeof phaseOrchestrator.on === 'function') {
      this._phaseTransitionHandler = (data) => {
        if (!data || !data.phase) return;
        const activeContracts = this._getActiveContractIds();
        for (const contractId of activeContracts) {
          try {
            const result = this.enforceContractGate(contractId, data.phase);
            if (result.enforced && !result.passed && this._config.blockOnGateFailure) {
              if (typeof this._phaseOrchestrator.pausePhase === 'function') {
                this._phaseOrchestrator.pausePhase(data.phase);
              }
            }
          } catch (_e) { debug('SddPhaseBridge', 'autoEnforce', _e && _e.message ? _e.message : String(_e)); }
        }
      };
      phaseOrchestrator.on('phase-changed', this._phaseTransitionHandler);
    }
    this.emit('attached', { hasPhaseOrchestrator: true, autoEnforce: this._config.autoEnforce });
    return { attached: true };
  }

  /**
   * 附加SddContractManager实例，用于查询合约状态。
   * @param {Object} contractManager - SddContractManager实例
   * @returns {{ attached: boolean }} 附加结果
   */
  attachSddContractManager(contractManager) {
    this.guardShutdown();
    this._contractManager = contractManager;
    return { attached: true };
  }

  /**
   * 将SDD阶段名称映射到执行阶段名称。
   * @param {string} sddStage - SDD阶段名称（propose/spec/design/tasks）
   * @returns {string|null} 执行阶段名称，未映射时返回null
   */
  mapStageToPhase(sddStage) {
    this.guardShutdown();
    if (!sddStage || typeof sddStage !== 'string') return null;
    return SDD_PHASE_MAP[sddStage] ?? null;
  }

  /**
   * 将执行阶段名称映射到SDD阶段名称。
   * @param {string} phase - 执行阶段名称
   * @returns {string|null} SDD阶段名称，未映射时返回null
   */
  mapPhaseToStage(phase) {
    this.guardShutdown();
    if (!phase || typeof phase !== 'string') return null;
    return PHASE_SDD_MAP[phase] ?? null;
  }

  /**
   * 强制执行合约门禁检查。验证指定合约在当前阶段是否满足SDD文档完整性要求。
   * @param {string} contractId - 合约ID
   * @param {string} phase - 当前执行阶段
   * @returns {{ enforced: boolean, passed?: boolean, contractId?: string, sddStage?: string, reason?: string }} 门禁执行结果
   * @emits SddPhaseBridge#contract-gate-enforced | SddPhaseBridge#contract-gate-blocked
   */
  enforceContractGate(contractId, phase) {
    this.guardShutdown();
    const result = safeExecute(() => {
      if (!this._contractManager) {
        return { enforced: false, reason: 'No SddContractManager attached' };
      }
      const contract = this._contractManager.getContract(contractId);
      if (!contract) {
        return { enforced: false, reason: 'Contract not found' };
      }
      const sddStage = this.mapPhaseToStage(phase);
      if (!sddStage) {
        return { enforced: false, reason: 'Phase not mapped to SDD stage: ' + phase };
      }
      const stageIndex = contract.completedStages.indexOf(sddStage);
      const isCurrentStage = contract.currentStage === sddStage;
      if (stageIndex >= 0) {
        this._enforcedContracts.set(contractId, { phase, sddStage, enforced: true, timestamp: new Date().toISOString() });
        this.emit('contract-gate-enforced', { contractId, phase, sddStage, passed: true });
        return { enforced: true, passed: true, contractId, sddStage };
      }
      if (isCurrentStage) {
        const doc = contract.documents[sddStage];
        if (doc) {
          this._enforcedContracts.set(contractId, { phase, sddStage, enforced: true, timestamp: new Date().toISOString() });
          this.emit('contract-gate-enforced', { contractId, phase, sddStage, passed: true });
          return { enforced: true, passed: true, contractId, sddStage };
        }
      }
      if (!contract.completedStages.includes(sddStage)) {
        this.emit('contract-gate-blocked', { contractId, phase, sddStage, completedStages: contract.completedStages });
        return { enforced: true, passed: false, contractId, sddStage, reason: 'SDD stage not yet completed: ' + sddStage };
      }
      this._enforcedContracts.set(contractId, { phase, sddStage, enforced: true, timestamp: new Date().toISOString() });
      return { enforced: true, passed: true, contractId, sddStage };
    }, 'SddPhaseBridge', 'enforceContractGate', { enforced: false, reason: 'Internal error' });
    if (result && result.enforced === false && result.reason === 'Internal error') {
      try { this.emit('safe-execute-error', { method: 'enforceContractGate', error: 'Internal error during gate enforcement' }); } catch (_e) { debug('SddPhaseBridge', 'enforceContractGate-emit', _e && _e.message ? _e.message : String(_e)); }
    }
    return result;
  }

  /**
   * 获取桥接器当前状态。
   * @returns {{ attached: boolean, hasPhaseOrchestrator: boolean, hasContractManager: boolean, enforcedContractsCount: number, stagePhaseMap: Object }} 状态信息
   */
  getBridgeStatus() {
    this.guardShutdown();
    return {
      attached: this._attached,
      hasPhaseOrchestrator: this._phaseOrchestrator !== null,
      hasContractManager: this._contractManager !== null,
      enforcedContractsCount: this._enforcedContracts.size,
      stagePhaseMap: { ...SDD_PHASE_MAP },
    };
  }

  /**
   * 获取所有已执行门禁的合约列表。
   * @returns {Array<{ contractId: string, phase: string, sddStage: string, enforced: boolean, timestamp: string }>} 已执行门禁的合约列表
   */
  getEnforcedContracts() {
    this.guardShutdown();
    const result = [];
    this._enforcedContracts.forEach((val, key) => {
      result.push({ contractId: key, ...val });
    });
    return result;
  }

  /**
   * 获取当前活跃的合约ID列表。
   * @private
   * @returns {string[]} 活跃合约ID列表
   */
  _getActiveContractIds() {
    if (!this._contractManager || typeof this._contractManager.listContracts !== 'function') return [];
    try {
      const contracts = this._contractManager.listContracts();
      return contracts.filter(c => c.status === 'active' || c.status === 'draft').map(c => c.contractId);
    } catch (_e) {
      debug('SddPhaseBridge', 'getActiveContracts', _e && _e.message ? _e.message : String(_e));
      return [];
    }
  }

  /**
   * 从PhaseOrchestrator分离，移除事件监听。
   * @returns {{ detached: boolean }} 分离结果
   * @emits SddPhaseBridge#detached
   */
  detach() {
    this.guardShutdown();
    if (this._phaseOrchestrator && this._phaseTransitionHandler && typeof this._phaseOrchestrator.off === 'function') {
      this._phaseOrchestrator.off('phase-changed', this._phaseTransitionHandler);
    }
    this._phaseTransitionHandler = null;
    this._phaseOrchestrator = null;
    this._contractManager = null;
    this._attached = false;
    this._enforcedContracts.clear();
    this.emit('detached');
    return { detached: true };
  }

  /** @private */
  _onShutdown() {
    if (this._phaseOrchestrator && this._phaseTransitionHandler && typeof this._phaseOrchestrator.off === 'function') {
      this._phaseOrchestrator.off('phase-changed', this._phaseTransitionHandler);
    }
    this._phaseTransitionHandler = null;
    this._phaseOrchestrator = null;
    this._contractManager = null;
    this._attached = false;
    this._enforcedContracts.clear();
    this.removeAllListeners();
  }
}

SddPhaseBridge.SDD_PHASE_MAP = SDD_PHASE_MAP;
SddPhaseBridge.PHASE_SDD_MAP = PHASE_SDD_MAP;

module.exports = withShutdown(SddPhaseBridge);
Object.assign(module.exports, { SddPhaseBridge, SDD_PHASE_MAP, PHASE_SDD_MAP });
