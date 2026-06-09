/**
 * SDD（规范驱动开发）运行时模块。
 * 提供合约管理、铁律引擎、文档验证、阶段桥接和同步验证功能。
 * 与 PhaseOrchestrator 集成，实现 propose→spec→design→tasks 四阶段规范驱动流程。
 *
 * @module runtime/sdd
 * @example
 * const { SddContractManager, IronRuleEngine, SddDocumentValidator, SddPhaseBridge, SddSyncVerifier } = require('./sdd');
 */
'use strict';

const SddContractManager = require('./sdd-contract-manager');
const IronRuleEngine = require('./iron-rule-engine');
const SddDocumentValidator = require('./sdd-document-validator');
const SddPhaseBridge = require('./sdd-phase-bridge');
const SddSyncVerifier = require('./sdd-sync-verifier');

module.exports = {
  SddContractManager,
  IronRuleEngine,
  SddDocumentValidator,
  SddPhaseBridge,
  SddSyncVerifier,
};
