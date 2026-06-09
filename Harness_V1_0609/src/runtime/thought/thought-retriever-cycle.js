'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { MAX_RETRIEVED_THOUGHTS } = require('../../utils/constants');
const { timestampId } = require('../../utils/unique-id');

const CYCLE_STEPS = {
  RETRIEVE: 'retrieve',
  GENERATE: 'generate',
  DISTILL: 'distill',
  DEDUPLICATE: 'deduplicate',
  STORE: 'store',
};

/**
 * @module runtime/thought/thought-retriever-cycle
 * @classdesc 思维检索循环。迭代检索相关记忆
 * ThoughtRetrieverCycle — Iterative retrieve-generate-distill-deduplicate-store pipeline
 * Orchestrates a five-step thought processing cycle with per-step error isolation and
 * graceful degradation. Supports confidence, semantic, and hybrid retrieval modes.
 * @extends EventEmitter
 * @emits ThoughtRetrieverCycle#cycle-complete
 * @emits ThoughtRetrieverCycle#step-error
 */
class ThoughtRetrieverCycle extends EventEmitter {
  constructor(options) {
    super();
    this._thoughtExtractor = (options && options.thoughtExtractor) ?? null;
    this._thoughtDeduplicator = (options && options.thoughtDeduplicator) ?? null;
    this._thoughtMemoryStore = (options && options.thoughtMemoryStore) ?? null;
    this._embeddingService = (options && options.embeddingService) ?? null;
    this._thoughtDiamond = (options && options.thoughtDiamond) ?? null;
    this._retrievalMode = (options && options.retrievalMode) ?? 'hybrid';
    this._semanticWeight = (options && options.semanticWeight) ?? 0.6;
    this._confidenceWeight = (options && options.confidenceWeight) ?? 0.4;
    this._confidenceFilterEnabled = (options && options.confidenceFilterEnabled) !== false;
    this._diamondRefineEnabled = (options && options.diamondRefineEnabled) !== false;
    this._stats = {
      totalCycles: 0,
      thoughtsRetrieved: 0,
      thoughtsDistilled: 0,
      thoughtsDeduplicated: 0,
      thoughtsStored: 0,
      confidenceRetrievals: 0,
      semanticRetrievals: 0,
      hybridRetrievals: 0,
      diamondsRefined: 0,
      confidenceFiltered: 0,
    };
  }

  /**
   * 执行完整的五步思维处理管道：检索→生成→提炼→去重→存储，每步独立错误隔离
   * @param {string} agentOutput - Agent输出文本
   * @param {object} [context] - 执行上下文，可包含taskId、domain、tags、queryText、qualityScore等
   * @returns {object} 管道结果对象，包含retrievedThoughts、generatedOutput、distilledThoughts、deduplicationResult、storedThoughts、cycleComplete、degradedSteps、quality、cycleId、timestamp字段
   */
  execute(agentOutput, context) {
    this.guardShutdown();
    this._stats.totalCycles++;

    const safeContext = context && typeof context === 'object' && context !== null ? context : {};

    let step1, step2, step3, step4, step5;
    const degradedSteps = [];

    try {
      step1 = this._retrieve(safeContext);
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.RETRIEVE });
      degradedSteps.push(CYCLE_STEPS.RETRIEVE);
      step1 = [];
    }

    try {
      step2 = this._generate(agentOutput, safeContext, step1);
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.GENERATE });
      degradedSteps.push(CYCLE_STEPS.GENERATE);
      step2 = { output: agentOutput || '', context: safeContext };
    }

    try {
      step3 = this._distill(step2, safeContext);
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.DISTILL });
      degradedSteps.push(CYCLE_STEPS.DISTILL);
      step3 = [];
    }

    try {
      step4 = this._deduplicate(step3);
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.DEDUPLICATE });
      degradedSteps.push(CYCLE_STEPS.DEDUPLICATE);
      step4 = { accepted: step3, duplicates: [], merged: [] };
    }

    try {
      step5 = this._store(step4);
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.STORE });
      degradedSteps.push(CYCLE_STEPS.STORE);
      step5 = [];
    }

    let step6 = null;
    if (this._diamondRefineEnabled && this._thoughtDiamond) {
      try {
        step6 = this._diamondRefine(step4);
      } catch (err) {
        emitError(this, 'step-error', err, { step: 'diamond-refine' });
        degradedSteps.push('diamond-refine');
      }
    }

    const result = {
      retrievedThoughts: step1,
      generatedOutput: step2.output,
      distilledThoughts: step3,
      deduplicationResult: step4,
      storedThoughts: step5,
      diamondResult: step6,
      cycleComplete: true,
      degradedSteps: degradedSteps,
      quality: degradedSteps.length === 0 ? 'full' : degradedSteps.length <= 2 ? 'degraded' : 'severely-degraded',
      cycleId: (safeContext && safeContext.taskId) || 'cycle-' + this._stats.totalCycles,
      timestamp: new Date().toISOString(),
    };

    this.emit('cycle-complete', result);
    return result;
  }

  /**
   * 单独执行检索步骤，根据配置的检索模式从思维记忆存储中检索相关思维
   * @param {object} [context] - 检索上下文，可包含domain、tags、queryText字段
   * @returns {Array<object>} 检索到的思维数组
   */
  retrieve(context) {
    this.guardShutdown();
    const safeContext = context && typeof context === 'object' && context !== null ? context : {};
    return this._retrieve(safeContext);
  }

  _retrieve(context) {
    if (!this._thoughtMemoryStore) return [];

    const domain = (context && context.domain) || 'general';
    const tags = (context && context.tags) ?? [];
    const queryText = (context && context.queryText) || '';

    if (this._retrievalMode === 'semantic' && this._embeddingService && queryText) {
      this._stats.semanticRetrievals++;
      const thoughts = this._retrieveSemantic(domain, tags, queryText);
      this._stats.thoughtsRetrieved += thoughts.length;
      return thoughts;
    }

    if (this._retrievalMode === 'hybrid' && this._embeddingService && queryText) {
      this._stats.hybridRetrievals++;
      return this._retrieveHybrid(domain, tags, queryText);
    }

    const thoughts = this._retrieveByConfidence(domain, tags);
    this._stats.thoughtsRetrieved += thoughts.length;
    return thoughts;
  }

  _retrieveByConfidence(domain, tags) {
    try {
      const query = {
        domain: domain,
        minConfidence: 0.7,
        sortBy: 'confidence',
        limit: 10,
      };

      if (tags && tags.length > 0) {
        query.tag = tags[0];
      }

      const thoughts = this._thoughtMemoryStore.retrieveThoughts(query);
      this.emit('step-complete', { step: CYCLE_STEPS.RETRIEVE, count: thoughts.length, mode: 'confidence' });
      return thoughts;
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.RETRIEVE, mode: 'confidence' });
      return [];
    }
  }

  _retrieveSemantic(domain, tags, queryText) {
    try {
      const query = {
        domain: domain,
        minConfidence: 0.5,
        sortBy: 'semantic',
        text: queryText,
        limit: 10,
      };

      if (tags && tags.length > 0) {
        query.tag = tags[0];
      }

      const thoughts = this._thoughtMemoryStore.retrieveThoughts(query);
      this.emit('step-complete', { step: CYCLE_STEPS.RETRIEVE, count: thoughts.length, mode: 'semantic' });
      return thoughts;
    } catch (err) {
      emitError(this, 'step-error', err, { step: CYCLE_STEPS.RETRIEVE, mode: 'semantic' });
      return [];
    }
  }

  _retrieveHybrid(domain, tags, queryText) {
    const countBefore = this._stats.thoughtsRetrieved;
    const confidenceResults = this._retrieveByConfidence(domain, tags);
    const semanticResults = this._retrieveSemantic(domain, tags, queryText);

    const seen = new Map();
    for (const t of confidenceResults) {
      seen.set(t.id, { thought: t, score: (t.confidence ?? 0) * this._confidenceWeight });
    }
    for (const t of semanticResults) {
      if (seen.has(t.id)) {
        const entry = seen.get(t.id);
        if (entry) entry.score += this._semanticWeight * (t.confidence ?? 0.5);
      } else {
        seen.set(t.id, { thought: t, score: this._semanticWeight * (t?.confidence ?? 0.5) });
      }
    }

    const merged = Array.from(seen.values());
    merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const result = merged.slice(0, MAX_RETRIEVED_THOUGHTS).map(m => m.thought);

    this._stats.thoughtsRetrieved = countBefore + result.length;
    this.emit('step-complete', { step: CYCLE_STEPS.RETRIEVE, count: result.length, mode: 'hybrid', confidenceCount: confidenceResults.length, semanticCount: semanticResults.length });
    return result;
  }

  _generate(agentOutput, context, retrievedThoughts) {
    const enrichedOutput = agentOutput || '';

    const enrichedContext = { ...context };
    if (retrievedThoughts.length > 0) {
      enrichedContext._retrievedThoughts = retrievedThoughts;
    }

    this.emit('step-complete', { step: CYCLE_STEPS.GENERATE, outputLength: enrichedOutput.length });
    return { output: enrichedOutput, context: enrichedContext };
  }

  _distill(generateResult, context) {
    if (this._thoughtExtractor) {
      const extractionContext = { ...context };
      if (context && context.qualityScore) {
        extractionContext.qualityScore = context.qualityScore;
      }
      const extraction = this._thoughtExtractor.extract(generateResult.output, extractionContext);
      const thoughts = (extraction && extraction.thoughts) ?? [];
      this._stats.thoughtsDistilled += thoughts.length;
      this.emit('step-complete', { step: CYCLE_STEPS.DISTILL, count: thoughts.length });
      return thoughts;
    }

    const output = generateResult.output || '';
    const thoughts = this._builtinExtract(output);
    this._stats.thoughtsDistilled += thoughts.length;
    this.emit('step-complete', { step: CYCLE_STEPS.DISTILL, count: thoughts.length, method: 'builtin' });
    return thoughts;
  }

  _builtinExtract(output) {
    if (!output || typeof output !== 'string') return [];
    const thoughts = [];
    const patterns = [
      /##\s*(.+?)(?:\n|$)/g,
      /\*\*(.+?)\*\*[:：]\s*(.+?)(?:\n|$)/g,
      /(?:结论|总结|发现|insight|conclusion|finding)[:：]\s*(.+?)(?:\n|$)/gi,
      /(?:关键|核心|重要|key|core|important)[:：]\s*(.+?)(?:\n|$)/gi,
    ];
    const seen = new Set();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        const content = (match[1] || match[0]).trim();
        if (content.length > 5 && !seen.has(content.toLowerCase())) {
          seen.add(content.toLowerCase());
          thoughts.push({
            id: 'bt-' + timestampId(),
            content,
            confidence: 0.6,
            source: 'builtin-extractor',
            tags: [],
          });
        }
      }
    }
    return thoughts.slice(0, MAX_RETRIEVED_THOUGHTS);
  }

  _deduplicate(distilledThoughts) {
    if (distilledThoughts.length === 0) {
      return { accepted: distilledThoughts, duplicates: [], merged: [] };
    }

    if (this._thoughtDeduplicator) {
      const result = this._thoughtDeduplicator.deduplicate(distilledThoughts);
      const accepted = (result && result.accepted) ?? [];
      const duplicates = (result && result.duplicates) ?? [];
      const merged = (result && result.merged) ?? [];
      this._stats.thoughtsDeduplicated += duplicates.length + merged.length;
      this.emit('step-complete', { step: CYCLE_STEPS.DEDUPLICATE, accepted: accepted.length, duplicates: duplicates.length });
      return { accepted, duplicates, merged };
    }

    const result = this._builtinDeduplicate(distilledThoughts);
    this._stats.thoughtsDeduplicated += result.duplicates.length;
    this.emit('step-complete', { step: CYCLE_STEPS.DEDUPLICATE, accepted: result.accepted.length, duplicates: result.duplicates.length, method: 'builtin' });
    return result;
  }

  _builtinDeduplicate(thoughts) {
    const accepted = [];
    const duplicates = [];
    const seen = [];
    const seenWordSets = [];
    const DEDUP_THRESHOLD = 0.7;
    const MAX_SEEN_FOR_FULL_COMPARE = 500;
    for (const thought of thoughts) {
      const key = (thought.content || '').toLowerCase().trim();
      if (!key) {
        accepted.push(thought);
        continue;
      }
      const keyWords = new Set(key.split(/\s+/));
      let isDuplicate = false;
      const compareLimit = Math.min(seenWordSets.length, MAX_SEEN_FOR_FULL_COMPARE);
      for (let i = seenWordSets.length - compareLimit; i < seenWordSets.length; i++) {
        const existingWords = seenWordSets[i];
        let intersection = 0;
        for (const w of keyWords) {
          if (existingWords.has(w)) intersection++;
        }
        const union = keyWords.size + existingWords.size - intersection;
        if (union > 0 && intersection / union > DEDUP_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) {
        duplicates.push(thought);
      } else {
        seen.push(key);
        seenWordSets.push(keyWords);
        accepted.push(thought);
      }
    }
    return { accepted, duplicates, merged: [] };
  }

  _store(deduplicationResult) {
    if (!this._thoughtMemoryStore) return [];

    const accepted = (deduplicationResult && deduplicationResult.accepted) ?? [];
    const merged = (deduplicationResult && deduplicationResult.merged) ?? [];
    const allThoughts = accepted.concat(merged.filter(function(m) { return m && typeof m === 'object'; }));
    const filtered = this._confidenceFilterEnabled ? this._confidenceFilter(allThoughts) : allThoughts;
    const rawStored = this._thoughtMemoryStore.storeThoughts(filtered);
    const stored = Array.isArray(rawStored) ? rawStored : [];
    this._stats.thoughtsStored += stored.length;
    this.emit('step-complete', { step: CYCLE_STEPS.STORE, count: stored.length, filtered: allThoughts.length - filtered.length });
    return stored;
  }

  _diamondRefine(deduplicationResult) {
    if (!this._thoughtDiamond) return null;
    const accepted = (deduplicationResult && deduplicationResult.accepted) ?? [];
    if (accepted.length === 0) return { refined: [], tierStats: this._thoughtDiamond.getTierStats() };
    const rootData = (deduplicationResult && deduplicationResult.rootData) ?? null;
    const refinedRaw = this._thoughtDiamond.refine(accepted, rootData);
    const refined = Array.isArray(refinedRaw) ? refinedRaw : accepted;
    this._stats.diamondsRefined += refined.length;
    this.emit('step-complete', { step: 'diamond-refine', count: refined.length });
    return { refined: refined, tierStats: this._thoughtDiamond.getTierStats() };
  }

  _confidenceFilter(thoughts) {
    if (!Array.isArray(thoughts)) return [];
    const filtered = thoughts.filter(function (t) {
      if (!t || typeof t !== 'object') return false;
      const conf = typeof t.confidence === 'number' && Number.isFinite(t.confidence) ? t.confidence : 0.5;
      return conf >= 0.5;
    });
    this._stats.confidenceFiltered += thoughts.length - filtered.length;
    return filtered;
  }

  /**
   * 获取思维检索循环的统计信息
   * @returns {object} 统计对象，包含totalCycles、thoughtsRetrieved、thoughtsDistilled、thoughtsDeduplicated、thoughtsStored、confidenceRetrievals、semanticRetrievals、hybridRetrievals、retrievalMode、hasEmbeddingService字段
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('ThoughtRetrieverCycle', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalCycles: 0, thoughtsRetrieved: 0, thoughtsDistilled: 0, thoughtsDeduplicated: 0, thoughtsStored: 0, confidenceRetrievals: 0, semanticRetrievals: 0, hybridRetrievals: 0, diamondsRefined: 0, confidenceFiltered: 0, retrievalMode: this._retrievalMode, hasEmbeddingService: !!this._embeddingService }; }
    return { ...this._stats, retrievalMode: this._retrievalMode, hasEmbeddingService: !!this._embeddingService };
  }

  _onShutdown() {
    this._thoughtExtractor = null;
    this._thoughtDeduplicator = null;
    this._thoughtMemoryStore = null;
    this._embeddingService = null;
    this._thoughtDiamond = null;
    this._stats = { totalCycles: 0, thoughtsRetrieved: 0, thoughtsDistilled: 0, thoughtsDeduplicated: 0, thoughtsStored: 0, confidenceRetrievals: 0, semanticRetrievals: 0, hybridRetrievals: 0, diamondsRefined: 0, confidenceFiltered: 0 };
    this.removeAllListeners();
  }

  /**
   * 检查思维检索循环是否健康，依赖的子组件均需健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    if (this._thoughtMemoryStore && typeof this._thoughtMemoryStore.isHealthy === 'function') {
      if (!this._thoughtMemoryStore.isHealthy()) return false;
    }
    if (this._embeddingService && typeof this._embeddingService.isHealthy === 'function') {
      if (!this._embeddingService.isHealthy()) return false;
    }
    if (this._thoughtExtractor && typeof this._thoughtExtractor.isHealthy === 'function') {
      if (!this._thoughtExtractor.isHealthy()) return false;
    }
    return true;
  }
}

ThoughtRetrieverCycle.CYCLE_STEPS = CYCLE_STEPS;

module.exports = withShutdown(ThoughtRetrieverCycle);
