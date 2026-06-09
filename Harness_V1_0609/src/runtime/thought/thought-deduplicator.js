'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const safeAssign = require('../../utils/safe-assign');

const SIMILARITY_THRESHOLD = 0.75;
const MERGE_STRATEGY_HIGHER_CONFIDENCE = 'higher-confidence';
const MERGE_STRATEGY_MERGE = 'merge';
const MAX_EXISTING_THOUGHTS = 5000;
const MAX_COMPARE_LENGTH = 500;

/**
 * @module runtime/thought/thought-deduplicator
 * @classdesc 思维去重器。检测重复思维、合并相似推理
 * ThoughtDeduplicator — Detects and resolves duplicate or similar thoughts
 * Compares incoming thoughts against existing ones using text similarity, supporting
 * higher-confidence replacement and merge strategies with bounded storage.
 * @extends EventEmitter
 * @emits ThoughtDeduplicator#deduplication-complete
 */
class ThoughtDeduplicator extends EventEmitter {
  constructor(options) {
    super();
    this._similarityThreshold = options?.similarityThreshold ?? SIMILARITY_THRESHOLD;
    this._mergeStrategy = options?.mergeStrategy ?? MERGE_STRATEGY_HIGHER_CONFIDENCE;
    this._existingThoughts = [];
    this.removeAllListeners();
    this._stats = {
      totalChecks: 0,
      duplicatesFound: 0,
      mergesPerformed: 0,
      uniquePassed: 0,
    };
  }

  /**
   * 加载已有思维作为去重比较基准
   * @param {Array<object>} thoughts - 已有思维数组
   * @returns {void}
   */
  loadExisting(thoughts) {
    if (!Array.isArray(thoughts)) return;
    this._existingThoughts = thoughts.slice(0, MAX_EXISTING_THOUGHTS);
  }

  /**
   * 对新思维进行去重处理，根据配置的合并策略处理重复项
   * @param {Array<object>} newThoughts - 待去重的新思维数组
   * @returns {object} 去重结果对象，包含accepted(通过)、duplicates(重复)、merged(合并)三个数组
   * @throws {Error} When thoughts array is not iterable
   */
  deduplicate(newThoughts) {
    this.guardShutdown();
    if (!Array.isArray(newThoughts) || newThoughts.length === 0) {
      return { accepted: [], duplicates: [], merged: [] };
    }

    this._stats.totalChecks++;
    const accepted = [];
    const duplicates = [];
    const merged = [];

    for (const thought of newThoughts) {
      const match = this._findDuplicate(thought);
      if (match) {
        this._stats.duplicatesFound++;
        if (this._mergeStrategy === MERGE_STRATEGY_MERGE) {
          const mergedThought = this._mergeThoughts(match.existing, thought);
          if (mergedThought) {
            merged.push({ original: match.existing, incoming: thought, merged: mergedThought });
            this._stats.mergesPerformed++;
            const idx = this._existingThoughts.indexOf(match.existing);
            if (idx >= 0) {
              this._existingThoughts[idx] = mergedThought;
            }
          } else {
            duplicates.push({ incoming: thought, reason: match.reason, similarity: match.similarity });
          }
        } else {
          if ((thought.confidence ?? 0) > (match.existing.confidence ?? 0)) {
            const idx = this._existingThoughts.indexOf(match.existing);
            if (idx >= 0) {
              const mergedThought = safeAssign({}, thought);
              const existingTags = Array.isArray(match.existing.tags) ? match.existing.tags : [];
              const incomingTags = Array.isArray(thought.tags) ? thought.tags : [];
              mergedThought.tags = [...new Set([...existingTags, ...incomingTags])];
              this._existingThoughts[idx] = mergedThought;
              merged.push({ original: match.existing, incoming: thought, merged: thought });
              this._stats.mergesPerformed++;
            }
          } else {
            duplicates.push({ incoming: thought, reason: match.reason, similarity: match.similarity });
          }
        }
      } else {
        accepted.push(thought);
        this._existingThoughts.push(thought);
        this._stats.uniquePassed++;
      }
    }

    const result = { accepted, duplicates, merged };
    this._trimExisting();
    this.emit('deduplication-complete', result);
    return result;
  }

  _trimExisting() {
    if (this._existingThoughts.length > MAX_EXISTING_THOUGHTS) {
      this._existingThoughts.sort(function(a, b) {
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      });
      this._existingThoughts.splice(MAX_EXISTING_THOUGHTS);
      this.emit('thoughts-trimmed', { remaining: this._existingThoughts.length });
    }
  }

  _findDuplicate(thought) {
    let bestMatch = null;
    let bestSimilarity = 0;

    for (const existing of this._existingThoughts) {
      if (thought.type !== existing.type) continue;

      const similarity = this._computeSimilarity(thought.content, existing.content);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = existing;
      }
    }

    if (bestSimilarity >= this._similarityThreshold && bestMatch) {
      return {
        existing: bestMatch,
        similarity: bestSimilarity,
        reason: `content similarity ${bestSimilarity.toFixed(3)} >= threshold ${this._similarityThreshold}`,
      };
    }

    return null;
  }

  _computeSimilarity(a, b) {
    if (!a || !b) return 0;
    const normA = this._normalize(a).slice(0, MAX_COMPARE_LENGTH);
    const normB = this._normalize(b).slice(0, MAX_COMPARE_LENGTH);
    if (normA === normB) return 1.0;

    const wordsA = new Set(normA.split(/\s+/));
    const wordsB = new Set(normB.split(/\s+/));

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard < 0.2) return jaccard * 0.6;

    const editSim = this._editDistanceSimilarity(normA, normB);

    return jaccard * 0.6 + editSim * 0.4;
  }

  _editDistanceSimilarity(a, b) {
    if (a.length === 0 && b.length === 0) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;

    const maxLen = Math.max(a.length, b.length);
    const dist = this._levenshtein(a, b);
    return 1.0 - dist / maxLen;
  }

  _levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost,
        );
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[n];
  }

  _normalize(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _mergeThoughts(existing, incoming) {
    const merged = { ...existing };

    if (incoming.confidence > existing.confidence) {
      merged.confidence = incoming.confidence;
    } else {
      merged.confidence = Math.min(1.0, (existing.confidence ?? 0) + (incoming.confidence ?? 0) * 0.05);
    }

    const mergedTags = new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])]);
    merged.tags = Array.from(mergedTags);

    if (incoming.sourceTrace && existing.sourceTrace) {
      merged.sourceTrace = {
        primary: existing.sourceTrace,
        secondary: incoming.sourceTrace,
        mergedAt: new Date().toISOString(),
      };
    }

    merged.updatedAt = new Date().toISOString();
    merged.mergeCount = (existing.mergeCount ?? 0) + 1;

    return merged;
  }

  /**
   * 获取去重器的统计信息
   * @returns {object} 统计对象，包含totalChecks、duplicatesFound、mergesPerformed、uniquePassed、existingCount字段
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('ThoughtDeduplicator', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalChecks: 0, duplicatesFound: 0, mergesPerformed: 0, uniquePassed: 0, existingCount: 0 }; }
    return { ...this._stats, existingCount: this._existingThoughts.length };
  }

  _onShutdown() {
    this._existingThoughts = [];
    this._stats = { totalChecks: 0, duplicatesFound: 0, mergesPerformed: 0, uniquePassed: 0 };
    this.removeAllListeners();
  }

  /**
   * 检查去重器是否健康，已有思维数量低于10000即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._existingThoughts.length < 10000;
  }
}

ThoughtDeduplicator.SIMILARITY_THRESHOLD = SIMILARITY_THRESHOLD;
ThoughtDeduplicator.MERGE_STRATEGY_HIGHER_CONFIDENCE = MERGE_STRATEGY_HIGHER_CONFIDENCE;
ThoughtDeduplicator.MERGE_STRATEGY_MERGE = MERGE_STRATEGY_MERGE;

module.exports = withShutdown(ThoughtDeduplicator);
