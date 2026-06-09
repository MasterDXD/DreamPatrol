'use strict';

const { EventEmitter } = require('events');
const { DeepeningError } = require('../../errors');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_CONFIG = {
  maxPredicates: 20,
  minConfidence: 0.5,
  maxBridgeDepth: 3,
};

const PREDICATE_TYPES = {
  SPATIAL: 'spatial',
  ATTRIBUTE: 'attribute',
  RELATIONAL: 'relational',
  TEMPORAL: 'temporal',
  EXISTENTIAL: 'existential',
};

/**
 * @module runtime/agent/skill-wrapper
 * @classdesc 技能包装器（SkillWrapper）。技能执行封装、参数映射、结果转换，
 * 从视觉输入和任务上下文中发明、桥接和验证谓词（空间/属性/关系/时间/存在性），
 * 维护谓词缓存以加速重复输入处理。
 *
 * SkillWrapper — 技能谓词包装器
 * 从视觉输入和任务上下文中发明、桥接和验证谓词（空间/属性/关系/时间/存在性），
 * 为深化推理管道提供结构化谓词提取和推理链生成。维护谓词缓存以加速重复输入处理。
 * @extends EventEmitter
 * @emits SkillWrapper#predicates-invented
 * @emits SkillWrapper#predicates-bridged
 * @emits SkillWrapper#predicates-validated
 */
class SkillWrapper extends EventEmitter {
  /**
   * 创建SkillWrapper实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPredicates=20] - 最大谓词数量
   * @param {number} [options.minConfidence=0.5] - 最低置信度阈值
   * @param {number} [options.maxBridgeDepth=3] - 最大桥接深度
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._inventCount = 0;
    this._bridgeCount = 0;
    this._validationCount = 0;
    this._predicateCache = new Map();
  }

  /**
   * 从视觉输入和任务上下文中发明谓词。提取元素谓词、空间谓词和描述谓词，
   * 生成推理链并缓存结果以加速重复输入处理。
   * @param {Object} visualInput - 视觉输入对象，包含description、elements、spatialRelations
   * @param {Object} [_taskContext] - 任务上下文
   * @returns {{ predicates: Array<{name: string, type: string, arguments: Array, confidence: number}>, reasoning: string }} 谓词列表与推理链
   * @emits SkillWrapper#predicates-invented
   */
  inventPredicate(visualInput, _taskContext) {
    this.guardShutdown();
    if (!visualInput || typeof visualInput !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'visualInput must be an object');
    }

    const description = typeof visualInput.description === 'string' ? visualInput.description : '';
    const elements = Array.isArray(visualInput.elements) ? visualInput.elements : [];
    const spatialRelations = Array.isArray(visualInput.spatialRelations) ? visualInput.spatialRelations : [];

    const predicates = [];
    this._extractElementPredicates(elements, predicates);
    this._extractSpatialPredicates(spatialRelations, predicates);
    this._extractDescriptionPredicates(description, predicates);

    const reasoning = this._generateReasoning(predicates, description);

    this._inventCount++;
    const cacheKey = description.slice(0, 100);
    this._predicateCache.set(cacheKey, predicates);
    if (this._predicateCache.size > 100) {
      const firstKey = this._predicateCache.keys().next().value;
      this._predicateCache.delete(firstKey);
    }

    const result = { predicates, reasoning };
    this.emit('predicates-invented', result);
    return result;
  }

  _extractElementPredicates(elements, predicates) {
    for (const element of elements) {
      if (predicates.length >= this._config.maxPredicates) break;
      const name = typeof element.name === 'string' ? element.name : 'unknown';
      const type = typeof element.type === 'string' && Object.values(PREDICATE_TYPES).includes(element.type)
        ? element.type
        : PREDICATE_TYPES.EXISTENTIAL;
      const args = Array.isArray(element.properties) ? element.properties.slice(0, 5) : [name];
      const confidence = typeof element.confidence === 'number' && Number.isFinite(element.confidence)
        ? Math.max(0, Math.min(1, element.confidence))
        : 0.7;

      if (confidence >= this._config.minConfidence) {
        predicates.push({ name, type, arguments: args, confidence });
      }
    }
  }

  _extractSpatialPredicates(spatialRelations, predicates) {
    for (const relation of spatialRelations) {
      if (predicates.length >= this._config.maxPredicates) break;
      const name = typeof relation.type === 'string' ? relation.type : 'related';
      const args = Array.isArray(relation.entities) ? relation.entities.slice(0, 5) : [];
      const confidence = typeof relation.confidence === 'number' && Number.isFinite(relation.confidence)
        ? Math.max(0, Math.min(1, relation.confidence))
        : 0.6;

      if (confidence >= this._config.minConfidence) {
        predicates.push({ name, type: PREDICATE_TYPES.SPATIAL, arguments: args, confidence });
      }
    }
  }

  _extractDescriptionPredicates(description, predicates) {
    if (typeof description !== 'string') return;
    if (description.length === 0 || predicates.length >= this._config.maxPredicates) return;
    const words = description.split(/\s+/).filter(w => w.length > 2);
    const uniqueWords = [...new Set(words)].slice(0, this._config.maxPredicates - predicates.length);
    for (const word of uniqueWords) {
      predicates.push({
        name: word.toLowerCase(),
        type: PREDICATE_TYPES.ATTRIBUTE,
        arguments: [word],
        confidence: 0.5,
      });
    }
  }

  /**
   * 将谓词桥接到推理链。按类型分组映射谓词（空间/属性/关系/其他），
   * 生成技能输入和推理步骤，支持目标对齐。
   * @param {Array<{name: string, type: string, arguments: Array, confidence: number}>} predicates - 谓词数组
   * @param {string} [taskGoal] - 任务目标描述
   * @returns {{ skillInputs: Object, reasoningChain: Array<Object> }} 技能输入映射与推理链
   * @emits SkillWrapper#predicates-bridged
   */
  bridgeToReasoning(predicates, taskGoal) {
    this.guardShutdown();
    if (!Array.isArray(predicates)) {
      throw new DeepeningError('INVALID_INPUT', 'predicates must be an array');
    }

    const goal = typeof taskGoal === 'string' ? taskGoal : '';

    const skillInputs = {};
    const reasoningChain = [];

    const spatialPredicates = predicates.filter(p => p.type === PREDICATE_TYPES.SPATIAL);
    const attributePredicates = predicates.filter(p => p.type === PREDICATE_TYPES.ATTRIBUTE);
    const relationalPredicates = predicates.filter(p => p.type === PREDICATE_TYPES.RELATIONAL);
    const otherPredicates = predicates.filter(p =>
      p.type !== PREDICATE_TYPES.SPATIAL &&
      p.type !== PREDICATE_TYPES.ATTRIBUTE &&
      p.type !== PREDICATE_TYPES.RELATIONAL,
    );

    this._mapPredicateGroup(spatialPredicates, 'spatial', 'spatialContext', 'spatial-mapping', skillInputs, reasoningChain);
    this._mapPredicateGroup(attributePredicates, 'attribute', 'attributes', 'attribute-extraction', skillInputs, reasoningChain);
    this._mapRelationalPredicates(relationalPredicates, skillInputs, reasoningChain);
    this._mapOtherPredicates(otherPredicates, skillInputs, reasoningChain);

    if (goal.length > 0) {
      skillInputs.taskGoal = goal;
      reasoningChain.push({
        step: reasoningChain.length + 1,
        type: 'goal-alignment',
        input: goal,
        output: 'goal injected into skill inputs',
      });
    }

    if (reasoningChain.length > this._config.maxBridgeDepth) {
      reasoningChain.splice(this._config.maxBridgeDepth);
    }

    this._bridgeCount++;
    const result = { skillInputs, reasoningChain };
    this.emit('bridge-created', result);
    return result;
  }

  _mapPredicateGroup(group, label, inputKey, chainType, skillInputs, reasoningChain) {
    if (group.length === 0) return;
    skillInputs[inputKey] = group.map(p => ({
      name: p.name,
      values: p.arguments,
      confidence: p.confidence,
    }));
    reasoningChain.push({
      step: reasoningChain.length + 1,
      type: chainType,
      input: group.length + ' ' + label + ' predicates',
      output: inputKey + ' mapped',
    });
  }

  _mapRelationalPredicates(group, skillInputs, reasoningChain) {
    if (group.length === 0) return;
    skillInputs.relations = group.map(p => ({
      type: p.name,
      targets: p.arguments,
      confidence: p.confidence,
    }));
    reasoningChain.push({
      step: reasoningChain.length + 1,
      type: 'relation-binding',
      input: group.length + ' relational predicates',
      output: 'relations mapped',
    });
  }

  _mapOtherPredicates(group, skillInputs, reasoningChain) {
    if (group.length === 0) return;
    skillInputs.contextual = group.map(p => ({
      name: p.name,
      type: p.type,
      arguments: p.arguments,
      confidence: p.confidence,
    }));
    reasoningChain.push({
      step: reasoningChain.length + 1,
      type: 'contextual-binding',
      input: group.length + ' contextual predicates',
      output: 'contextual mapped',
    });
  }

  /**
   * 验证谓词到技能输入的桥接覆盖度和置信度。
   * @param {Object} bridge - 包含 predicates 和 skillInputs 的桥接对象
   * @returns {boolean} 桥接是否有效
   */
  validateBridge(predicates, skillInputs) {
    this.guardShutdown();
    if (!Array.isArray(predicates)) {
      throw new DeepeningError('INVALID_INPUT', 'predicates must be an array');
    }
    if (!skillInputs || typeof skillInputs !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'skillInputs must be an object');
    }

    const totalPredicates = predicates.length;
    if (totalPredicates === 0) {
      this._validationCount++;
      const result = { valid: false, coverage: 0, avgConfidence: 0, issues: ['No predicates provided'] };
      this.emit('bridge-validated', result);
      return result;
    }

    const mappedPredicateNames = this._collectMappedNames(skillInputs);
    const coveredCount = predicates.filter(p => mappedPredicateNames.has(p.name)).length;
    const coverage = coveredCount / totalPredicates;
    const avgConfidence = predicates.reduce((sum, p) => sum + (typeof p.confidence === 'number' ? p.confidence : 0), 0) / totalPredicates;

    const issues = this._collectValidationIssues(coverage, avgConfidence, predicates);

    this._validationCount++;
    const result = { valid: issues.length === 0, coverage, avgConfidence, issues };
    this.emit('bridge-validated', result);
    return result;
  }

  _collectMappedNames(skillInputs) {
    const names = new Set();
    for (const value of Object.values(skillInputs)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item != null && typeof item === 'object') {
          if (typeof item.name === 'string') names.add(item.name);
          if (typeof item.relation === 'string') names.add(item.relation);
          if (typeof item.type === 'string') names.add(item.type);
        }
      }
    }
    return names;
  }

  _collectValidationIssues(coverage, avgConfidence, predicates) {
    const issues = [];
    if (coverage < 0.5) {
      issues.push('Low predicate coverage: less than 50% of predicates mapped to skill inputs');
    }
    if (avgConfidence < this._config.minConfidence) {
      issues.push('Low average confidence: below minimum threshold ' + this._config.minConfidence);
    }
    const lowConfCount = predicates.filter(p => typeof p.confidence === 'number' && p.confidence < this._config.minConfidence).length;
    if (lowConfCount > 0) {
      issues.push(lowConfCount + ' predicate(s) below minimum confidence threshold');
    }
    return issues;
  }

  /**
   * 获取技能包装器的统计信息。
   * @returns {Object} 包含 inventCount、bridgeCount、validationCount 等统计数据的对象
   */
  getStats() {
    return {
      inventCount: this._inventCount,
      bridgeCount: this._bridgeCount,
      validationCount: this._validationCount,
      cachedPredicates: this._predicateCache.size,
      config: mergeConfig(this._config),
    };
  }

  _generateReasoning(predicates, description) {
    const steps = [];
    if (description.length > 0) {
      steps.push('Parsed visual description into structured elements');
    }
    const typeCounts = {};
    for (const p of predicates) {
      typeCounts[p.type] = (typeCounts[p.type] ?? 0) + 1;
    }
    for (const [type, count] of Object.entries(typeCounts)) {
      steps.push('Identified ' + count + ' ' + type + ' predicate(s)');
    }
    if (predicates.length > 0) {
      const avgConf = predicates.reduce((s, p) => s + (typeof p.confidence === 'number' && Number.isFinite(p.confidence) ? p.confidence : 0), 0) / predicates.length;
      steps.push('Average predicate confidence: ' + avgConf.toFixed(2));
    }
    return steps;
  }

  _onShutdown() {
    this._inventCount = 0;
    this._bridgeCount = 0;
    this._validationCount = 0;
    this._predicateCache.clear();
    this.removeAllListeners();
    debug('SkillWrapper', '_onShutdown', 'cleaned up');
  }
}

SkillWrapper.DEFAULT_CONFIG = DEFAULT_CONFIG;
SkillWrapper.PREDICATE_TYPES = PREDICATE_TYPES;

module.exports = withShutdown(SkillWrapper);
