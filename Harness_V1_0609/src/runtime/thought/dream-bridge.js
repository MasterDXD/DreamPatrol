'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');

const MODULE_NAMES = {
  dreamEngine: 'DreamEngine',
  dreamOutcomes: 'DreamOutcomes',
  qualityScorer: 'QualityScorer',
  selfReflection: 'SelfReflection',
  skillImprovementLoop: 'SkillImprovementLoop',
  llmWiki: 'LlmWiki',
  brainMemory: 'BrainMemory',
  errorPreventionGuard: 'ErrorPreventionGuard',
  ironRuleEngine: 'IronRuleEngine',
};

const WIKI_HIGH_CONFIDENCE_THRESHOLD = 0.8;

const MAX_BRIDGE_STAT_KEYS = 20;

/**
 * @module runtime/thought/dream-bridge
 * @classdesc 做梦模块桥接器。8条自动桥接规则、事件驱动
 * DreamBridge — Dreaming模块间桥接器
 * 将当前相互隔离的Dreaming相关模块桥接起来，形成闭环。
 * 监听各模块事件，自动在QualityScorer、SelfReflection、DreamOutcomes、
 * DreamEngine、SkillImprovementLoop、LlmWiki、ErrorPreventionGuard、IronRuleEngine之间传递数据。
 * 包含8条自动桥接规则，其中规则#8为Grader代理评估闭环。
 * @extends EventEmitter
 * @emits DreamBridge#bridge-activated
 * @emits DreamBridge#bridge-deactivated
 * @emits DreamBridge#bridge-executed
 * @emits DreamBridge#bridge-failed
 */
class DreamBridge extends EventEmitter {
  constructor() {
    super();
    this._modules = {};
    this._active = false;
    this._listeners = [];
    this._bridgeStats = { activated: {}, failed: {} };
  }

  /**
   * 挂载DreamEngine实例
   * @param {object} engine - DreamEngine实例
   * @returns {void}
   */
  attachDreamEngine(engine) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.dreamEngine] = engine ?? null;
  }

  /**
   * 挂载DreamOutcomes实例
   * @param {object} outcomes - DreamOutcomes实例
   * @returns {void}
   */
  attachDreamOutcomes(outcomes) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.dreamOutcomes] = outcomes ?? null;
  }

  /**
   * 挂载QualityScorer实例
   * @param {object} scorer - QualityScorer实例
   * @returns {void}
   */
  attachQualityScorer(scorer) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.qualityScorer] = scorer ?? null;
  }

  /**
   * 挂载SelfReflection实例
   * @param {object} reflection - SelfReflection实例
   * @returns {void}
   */
  attachSelfReflection(reflection) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.selfReflection] = reflection ?? null;
  }

  /**
   * 挂载SkillImprovementLoop实例
   * @param {object} loop - SkillImprovementLoop实例
   * @returns {void}
   */
  attachSkillImprovementLoop(loop) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.skillImprovementLoop] = loop ?? null;
  }

  /**
   * 挂载LlmWiki实例
   * @param {object} wiki - LlmWiki实例
   * @returns {void}
   */
  attachLlmWiki(wiki) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.llmWiki] = wiki ?? null;
  }

  /**
   * 挂载BrainMemory实例
   * @param {object} brainMemory - BrainMemory实例
   * @returns {void}
   */
  attachBrainMemory(brainMemory) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.brainMemory] = brainMemory ?? null;
  }

  attachErrorPreventionGuard(guard) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.errorPreventionGuard] = guard ?? null;
  }

  attachIronRuleEngine(engine) {
    this.guardShutdown();
    this._modules[MODULE_NAMES.ironRuleEngine] = engine ?? null;
  }

  /**
   * 激活所有桥接，注册事件监听器
   * @returns {void}
   */
  activate() {
    this.guardShutdown();
    if (this._active) return;
    this._active = true;

    this._registerQualityScorerBridge();
    this._registerSelfReflectionBridge();
    this._registerDreamOutcomesBridge();
    this._registerDreamEngineBridge();
    this._registerSelfReflectionToErrorPreventionBridge();
    this._registerErrorPreventionToIronRuleBridge();
    this._registerGraderEvaluatedBridge();

    debug('activate', 'Bridges registered: ' + Object.keys(this._bridgeStats.activated).join(', '));
    this.emit('bridge-activated', { bridges: Object.keys(this._bridgeStats.activated) });
  }

  /**
   * 停用所有桥接，移除事件监听器
   * @returns {void}
   */
  deactivate() {
    if (!this._active) return;
    this._active = false;

    for (const entry of this._listeners) {
      safeExecute(
        function() { entry.emitter.removeListener(entry.event, entry.handler); },
        'DreamBridge', 'deactivate-removeListener',
      );
    }
    this._listeners = [];

    debug('deactivate', 'All bridge listeners removed');
    this.emit('bridge-deactivated', {});
  }

  /**
   * 查询桥接激活状态
   * @returns {boolean} 是否处于激活状态
   */
  isActive() {
    return this._active;
  }

  /**
   * 获取桥接统计信息
   * @returns {{active: boolean, bridgesActivated: Object<string, number>, bridgesFailed: Object<string, number>}} 桥接统计
   */
  getBridgeStats() {
    return {
      active: this._active,
      bridgesActivated: { ...this._bridgeStats.activated },
      bridgesFailed: { ...this._bridgeStats.failed },
    };
  }

  /**
   * 检查桥接器是否健康（未关闭）
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 获取统计信息，同getBridgeStats
   * @returns {{active: boolean, bridgesActivated: Object<string, number>, bridgesFailed: Object<string, number>}} 桥接统计
   */
  getStats() {
    return this.getBridgeStats();
  }

  _addListener(emitter, event, handler, bridgeName) {
    emitter.on(event, handler);
    this._listeners.push({ emitter: emitter, event: event, handler: handler });
    this._incrementStat(bridgeName, 'activated');
  }

  _incrementStat(bridgeName, type) {
    if (!this._bridgeStats[type]) this._bridgeStats[type] = {};
    if (!this._bridgeStats[type][bridgeName]) {
      if (Object.keys(this._bridgeStats[type]).length >= MAX_BRIDGE_STAT_KEYS) return;
      this._bridgeStats[type][bridgeName] = 0;
    }
    this._bridgeStats[type][bridgeName]++;
  }

  _registerQualityScorerBridge() {
    const scorer = this._modules[MODULE_NAMES.qualityScorer];
    const outcomes = this._modules[MODULE_NAMES.dreamOutcomes];
    if (!scorer || !outcomes) return;

    const handler = function(scoreData) {
      safeExecute(
        function() {
          const evaluation = scoreData && scoreData.total !== undefined
            ? { achieved: scoreData.total >= 0.6, score: scoreData.total, grade: scoreData.grade }
            : { achieved: false, score: 0, grade: 'unknown' };
          if (typeof outcomes.evaluateOutcome === 'function') {
            outcomes.evaluateOutcome('quality-score', evaluation);
          }
        },
        'DreamBridge', 'QualityScorer->DreamOutcomes',
      );
      this._incrementStat('QualityScorer->DreamOutcomes', 'activated');
      this.emit('bridge-executed', { bridge: 'QualityScorer->DreamOutcomes' });
    }.bind(this);

    this._addListener(scorer, 'score-computed', handler, 'QualityScorer->DreamOutcomes');
  }

  _registerSelfReflectionBridge() {
    const reflection = this._modules[MODULE_NAMES.selfReflection];
    const engine = this._modules[MODULE_NAMES.dreamEngine];
    if (!reflection || !engine) return;

    const handler = function(reflectionData) {
      safeExecute(
        function() {
          const input = {
            source: 'self-reflection',
            improvements: [],
            suggestions: [],
          };
          if (reflectionData && Array.isArray(reflectionData.improvements)) {
            input.improvements = reflectionData.improvements;
          }
          if (reflectionData && Array.isArray(reflectionData.suggestions)) {
            input.suggestions = reflectionData.suggestions;
          }
          if (reflectionData && reflectionData.qualityTrend) {
            input.qualityTrend = reflectionData.qualityTrend;
          }
          if (reflectionData && reflectionData.recommendedAction) {
            input.recommendedAction = reflectionData.recommendedAction;
          }
          if (typeof engine.consumeReflectionInput === 'function') {
            const result = engine.consumeReflectionInput(input);
            if (result && typeof result.then === 'function') {
              result.catch(function(err) { debug('DreamBridge', 'SelfReflection->DreamEngine:async', err); });
            }
          }
        },
        'DreamBridge', 'SelfReflection->DreamEngine',
      );
      this._incrementStat('SelfReflection->DreamEngine', 'activated');
      this.emit('bridge-executed', { bridge: 'SelfReflection->DreamEngine' });
    }.bind(this);

    this._addListener(reflection, 'reflection-completed', handler, 'SelfReflection->DreamEngine');
  }

  _registerDreamOutcomesBridge() {
    const outcomes = this._modules[MODULE_NAMES.dreamOutcomes];
    const engine = this._modules[MODULE_NAMES.dreamEngine];
    const loop = this._modules[MODULE_NAMES.skillImprovementLoop];

    if (outcomes && engine) {
      const handler = async function() {
        await safeExecute(
          async function() {
            if (typeof outcomes.syncToDreamEngine === 'function') {
              await outcomes.syncToDreamEngine();
            }
          },
          'DreamBridge', 'DreamOutcomes->DreamEngine',
        );
        this._incrementStat('DreamOutcomes->DreamEngine', 'activated');
        this.emit('bridge-executed', { bridge: 'DreamOutcomes->DreamEngine' });
      }.bind(this);

      this._addListener(outcomes, 'outcome-evaluated', handler, 'DreamOutcomes->DreamEngine');
    }

    if (outcomes && loop) {
      const handler = function() {
        safeExecute(
          function() {
            if (typeof outcomes.syncToSkillImprovementLoop === 'function') {
              outcomes.syncToSkillImprovementLoop();
            }
          },
          'DreamBridge', 'DreamOutcomes->SkillImprovementLoop',
        );
        this._incrementStat('DreamOutcomes->SkillImprovementLoop', 'activated');
        this.emit('bridge-executed', { bridge: 'DreamOutcomes->SkillImprovementLoop' });
      }.bind(this);

      this._addListener(outcomes, 'outcome-evaluated', handler, 'DreamOutcomes->SkillImprovementLoop');
    }
  }

  _registerDreamEngineBridge() {
    const engine = this._modules[MODULE_NAMES.dreamEngine];
    const wiki = this._modules[MODULE_NAMES.llmWiki];
    if (!engine || !wiki) return;

    const handler = function(noteData) {
      safeExecute(
        function() {
          if (!noteData) return;
          const notes = Array.isArray(noteData.notes) ? noteData.notes
            : (noteData.id ? [noteData] : []);
          for (const note of notes) {
            if (!note || note.confidence == null || note.confidence < WIKI_HIGH_CONFIDENCE_THRESHOLD) continue;
            const category = note.category === 'error-avoidance' ? 'troubleshooting' : 'patterns';
            const title = (note.content || '').slice(0, 80).replace(/[^\w\s\u4e00-\u9fff]/g, ' ').trim();
            if (!title) continue;
            if (typeof wiki.createEntry === 'function') {
              wiki.createEntry(category, title, note.content ?? '', {
                tags: ['dream-engine', note.category || 'unknown'],
                confidence: note.confidence,
                source: 'dream-bridge',
              });
            }
          }
        },
        'DreamBridge', 'DreamEngine->LlmWiki',
      );
      this._incrementStat('DreamEngine->LlmWiki', 'activated');
      this.emit('bridge-executed', { bridge: 'DreamEngine->LlmWiki' });
    }.bind(this);

    this._addListener(engine, 'dream-complete', handler, 'DreamEngine->LlmWiki');
    this._addListener(engine, 'dream-error', handler, 'DreamEngine->LlmWiki');
  }

  _registerSelfReflectionToErrorPreventionBridge() {
    const reflection = this._modules[MODULE_NAMES.selfReflection];
    const guard = this._modules[MODULE_NAMES.errorPreventionGuard];
    if (!reflection || !guard) return;

    const handler = function(reflectionData) {
      safeExecute(
        function() {
          if (!reflectionData) return;
          if (typeof guard.autoRegisterFromReflection === 'function') {
            guard.autoRegisterFromReflection(reflectionData);
          }
        },
        'DreamBridge', 'SelfReflection->ErrorPreventionGuard',
      );
      this._incrementStat('SelfReflection->ErrorPreventionGuard', 'activated');
      this.emit('bridge-executed', { bridge: 'SelfReflection->ErrorPreventionGuard' });
    }.bind(this);

    this._addListener(reflection, 'reflection-completed', handler, 'SelfReflection->ErrorPreventionGuard');
  }

  _registerErrorPreventionToIronRuleBridge() {
    const guard = this._modules[MODULE_NAMES.errorPreventionGuard];
    const engine = this._modules[MODULE_NAMES.ironRuleEngine];
    if (!guard || !engine) return;

    const handler = function(patternData) {
      safeExecute(
        function() {
          if (!patternData) return;
          const pattern = patternData.pattern || '';
          const description = patternData.description || '';
          const solution = patternData.solution || '';
          if (pattern && typeof engine.addPatternRule === 'function') {
            const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            engine.addPatternRule(escapedPattern, description, solution);
          }
        },
        'DreamBridge', 'ErrorPreventionGuard->IronRuleEngine',
      );
      this._incrementStat('ErrorPreventionGuard->IronRuleEngine', 'activated');
      this.emit('bridge-executed', { bridge: 'ErrorPreventionGuard->IronRuleEngine' });
    }.bind(this);

    this._addListener(guard, 'auto-registered-from-reflection', handler, 'ErrorPreventionGuard->IronRuleEngine');
  }

  /**
   * 桥接规则 #8：Grader评估结果 → DreamEngine同步
   * 当独立Grader代理完成评估后，将评估结果同步到DreamEngine，
   * 使DreamEngine能够从Grader的独立评估中学习，形成更精准的经验提炼。
   * 融合自 "AI Agent Dreaming" 的 Outcomes 核心概念：grader代理独立评估闭环。
   */
  _registerGraderEvaluatedBridge() {
    const outcomes = this._modules[MODULE_NAMES.dreamOutcomes];
    const engine = this._modules[MODULE_NAMES.dreamEngine];
    if (!outcomes || !engine) return;

    const handler = function(graderResult) {
      safeExecute(
        function() {
          if (!graderResult) return;
          const input = {
            source: 'grader-evaluation',
            graderConsensus: graderResult.consensusReached,
            graderScore: graderResult.consensusScore,
            graderDivergence: graderResult.divergence,
            graderCount: graderResult.graderScores ? graderResult.graderScores.length : 0,
            improvements: [],
            suggestions: [],
          };
          if (Array.isArray(graderResult.graderScores)) {
            for (const gs of graderResult.graderScores) {
              if (gs.failed) {
                input.improvements.push('Grader ' + gs.graderId + ' evaluation failed');
              } else if (gs.score < 0.6) {
                input.improvements.push('Grader ' + gs.graderId + ' low score: ' + gs.score);
                if (gs.reasoning) {
                  input.suggestions.push(gs.reasoning);
                }
              }
            }
          }
          if (typeof engine.consumeReflectionInput === 'function') {
            const result = engine.consumeReflectionInput(input);
            if (result && typeof result.then === 'function') {
              result.catch(function(err) { debug('DreamBridge', 'GraderEvaluated->DreamEngine:async', err); });
            }
          }
        },
        'DreamBridge', 'GraderEvaluated->DreamEngine',
      );
      this._incrementStat('GraderEvaluated->DreamEngine', 'activated');
      this.emit('bridge-executed', { bridge: 'GraderEvaluated->DreamEngine' });
    }.bind(this);

    this._addListener(outcomes, 'grader-evaluated', handler, 'GraderEvaluated->DreamEngine');
  }

  _onShutdown() {
    this.deactivate();
    this._modules = {};
    this._active = false;
    this._bridgeStats = { activated: {}, failed: {} };
    this.removeAllListeners();
  }
}

DreamBridge.MODULE_NAMES = MODULE_NAMES;

module.exports = withShutdown(DreamBridge);
