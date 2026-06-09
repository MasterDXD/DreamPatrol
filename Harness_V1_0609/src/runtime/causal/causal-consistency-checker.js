'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @module runtime/causal/causal-consistency-checker
 * 因果一致性检查器。最终一致性验证、冲突检测，
 * 支持运行时与静态配置一致性比对、内存与运行时一致性检查。
 *
 * @classdesc 因果一致性检查器，检测和修复因果链中的不一致状态
 * @extends EventEmitter
 */
class CausalConsistencyChecker extends EventEmitter {
  /**
   * 创建CausalConsistencyChecker实例。
   * @param {Object} [options] - 配置选项
   */
  constructor(options) {
    super();
    this._causalDataBus = (options && options.causalDataBus) ?? null;
    this._causalMemoryStore = (options && options.causalMemoryStore) ?? null;
    this._configCausalValidator = (options && options.configCausalValidator) ?? null;
    this._maxDepth = typeof (options && options.maxDepth) === 'number' && Number.isFinite(options.maxDepth) ? options.maxDepth : 5;
  }

  /**
   * 附加CausalDataBus实例。
   * @param {CausalDataBus} bus - 因果数据总线实例
   */
  attachCausalDataBus(bus) {
    this.guardShutdown();
    if (!bus || typeof bus !== 'object') {
      this.emit('attach-error', { component: 'CausalDataBus', reason: 'invalid_bus' });
      return;
    }
    this._causalDataBus = bus;
  }

  /**
   * 附加CausalMemoryStore实例。
   * @param {CausalMemoryStore} store - 因果内存存储实例
   */
  attachCausalMemoryStore(store) {
    this.guardShutdown();
    if (!store || typeof store !== 'object') {
      this.emit('attach-error', { component: 'CausalMemoryStore', reason: 'invalid_store' });
      return;
    }
    this._causalMemoryStore = store;
  }

  /**
   * 附加ConfigCausalValidator实例。
   * @param {ConfigCausalValidator} validator - 因果配置验证器实例
   */
  attachConfigCausalValidator(validator) {
    this.guardShutdown();
    if (!validator || typeof validator !== 'object') {
      this.emit('attach-error', { component: 'ConfigCausalValidator', reason: 'invalid_validator' });
      return;
    }
    this._configCausalValidator = validator;
  }

  /**
   * 检查运行时接口与静态配置的一致性，检测有静态依赖但无运行时接口的技能。
   * @returns {{ consistent: boolean, issues: Array, reason?: string }} 一致性检查结果
   */
  checkRuntimeVsStatic() {
    this.guardShutdown();
    const issues = [];
    if (!this._causalDataBus || !this._configCausalValidator) {
      return { consistent: true, issues, reason: 'missing_components' };
    }
    const runtimeInterfaces = this._causalDataBus.getDefinedInterfaces();
    const depGraph = this._configCausalValidator.getDependencyGraph() || this._configCausalValidator.buildDependencyGraph();
    if (depGraph && depGraph.skills && typeof depGraph.skills === 'object') {
      for (const skillId of Object.keys(depGraph.skills)) {
        const skill = depGraph.skills[skillId];
        const runtimeIface = runtimeInterfaces.find(i => i.skillId === skill.id);
        if (!runtimeIface && skill.dependsOn && skill.dependsOn.length > 0) {
          issues.push({
            type: 'missing_runtime_interface',
            skillId: skill.id,
            description: `Skill '${skill.id}' has static dependencies but no runtime interface`,
            severity: 'medium',
          });
        }
      }
    }
    this.emit('runtime-vs-static-checked', { consistent: issues.length === 0, issueCount: issues.length });
    return { consistent: issues.length === 0, issues };
  }

  /**
   * 异步检查内存存储与运行时因果链的一致性，检测低置信度的内存条目。
   * @returns {Promise<{consistent: boolean, issues: Array, reason?: string}>} 一致性检查结果
   */
  async checkMemoryVsRuntime() {
    this.guardShutdown();
    const issues = [];
    if (!this._causalDataBus || !this._causalMemoryStore) {
      return { consistent: true, issues, reason: 'missing_components' };
    }
    const chain = this._causalDataBus.getCausalChain();
    if (chain && chain.length > 0) {
      const chainSkillIds = [...new Set(chain.map(e => e.skillId))];
      for (const skillId of chainSkillIds) {
        const iface = this._causalDataBus.getSkillInterface(skillId);
        if (iface && Array.isArray(iface.causalOutputs)) {
          for (const output of iface.causalOutputs) {
            const outputName = typeof output === 'string' ? output : output.name;
            const results = await this._causalMemoryStore.searchByCausalSimilarity(outputName, { limit: 1 });
            if (results && Array.isArray(results) && results.length > 0) {
              const memEntry = results[0];
              if (memEntry && typeof memEntry.confidence === 'number' && memEntry.confidence < 0.3) {
                issues.push({
                  type: 'low_confidence_memory',
                  skillId,
                  outputName,
                  confidence: memEntry.confidence,
                  description: `Output '${outputName}' from skill '${skillId}' has low confidence (${memEntry.confidence}) in memory`,
                  severity: 'low',
                });
              }
            }
          }
        }
      }
    }
    this.emit('memory-vs-runtime-checked', { consistent: issues.length === 0, issueCount: issues.length });
    return { consistent: issues.length === 0, issues };
  }

  /**
   * 执行完整一致性检查，合并运行时-静态和内存-运行时两维度检查结果。
   * @returns {Promise<{consistent: boolean, totalIssues: number, highIssues: number, mediumIssues: number, lowIssues: number, issues: Array, runtimeVsStatic: boolean, memoryVsRuntime: boolean}>} 完整一致性检查结果
   */
  async checkFullConsistency() {
    this.guardShutdown();
    const runtimeVsStatic = this.checkRuntimeVsStatic();
    const memoryVsRuntime = await this.checkMemoryVsRuntime();
    const allIssues = [...(runtimeVsStatic.issues ?? []), ...(memoryVsRuntime.issues ?? [])];
    const highIssues = allIssues.filter(i => i.severity === 'high');
    const mediumIssues = allIssues.filter(i => i.severity === 'medium');
    const lowIssues = allIssues.filter(i => i.severity === 'low');
    const result = {
      consistent: allIssues.length === 0,
      totalIssues: allIssues.length,
      highIssues: highIssues.length,
      mediumIssues: mediumIssues.length,
      lowIssues: lowIssues.length,
      issues: allIssues,
      runtimeVsStatic: runtimeVsStatic.consistent,
      memoryVsRuntime: memoryVsRuntime.consistent,
    };
    this.emit('full-consistency-checked', result);
    return result;
  }

  _onShutdown() {
    this._causalDataBus = null;
    this._causalMemoryStore = null;
    this._configCausalValidator = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(CausalConsistencyChecker);
