'use strict';

/** @module runtime/thought/thought-diamond
 * @classdesc 思维钻石
 */

const { EventEmitter } = require('events');
const { validateProjectRoot, generateId } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');

const DIAMOND_TIERS = {
  RAW: { name: 'raw', minConfidence: 0, maxConfidence: 0.5, color: '#94a3b8', label: '原始' },
  CUT: { name: 'cut', minConfidence: 0.5, maxConfidence: 0.75, color: '#60a5fa', label: '切割' },
  POLISHED: { name: 'polished', minConfidence: 0.75, maxConfidence: 0.9, color: '#a78bfa', label: '抛光' },
  DIAMOND: { name: 'diamond', minConfidence: 0.9, maxConfidence: 1.01, color: '#fbbf24', label: '钻石' },
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_DEDUPLICATION_THRESHOLD = 0.75;
const DEFAULT_MAX_DIAMONDS = 500;

class ThoughtDiamond extends EventEmitter {
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'ThoughtDiamond');
    this.root = projectRoot;
    this._confidenceThreshold = (options && options.confidenceThreshold) ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this._dedupThreshold = (options && options.deduplicationThreshold) ?? DEFAULT_DEDUPLICATION_THRESHOLD;
    this._maxDiamonds = (options && options.maxDiamonds) ?? DEFAULT_MAX_DIAMONDS;
    this._embeddingService = (options && options.embeddingService) ?? null;
    this._thoughtMemoryStore = (options && options.thoughtMemoryStore) ?? null;
    this._diamonds = new Map();
    this._tierIndex = { raw: [], cut: [], polished: [], diamond: [] };
    this._stats = {
      totalRefined: 0,
      diamondsCreated: 0,
      diamondsUpgraded: 0,
      diamondsDowngraded: 0,
      duplicatesMerged: 0,
      confidenceFiltered: 0,
      rootDataMappings: 0,
    };
  }

  refine(thoughts, rootData) {
    this.guardShutdown();
    if (!Array.isArray(thoughts)) return [];
    const results = [];
    for (const thought of thoughts) {
      if (!thought || typeof thought !== 'object') continue;
      const refined = this._refineSingle(thought, rootData);
      if (refined) results.push(refined);
    }
    this._enforceCapacity();
    return results;
  }

  _refineSingle(thought, rootData) {
    this._stats.totalRefined++;
    const confidence = typeof thought.confidence === 'number' && Number.isFinite(thought.confidence)
      ? Math.min(1, Math.max(0, thought.confidence)) : 0.5;
    if (confidence < this._confidenceThreshold) {
      this._stats.confidenceFiltered++;
      return null;
    }
    const tier = this._classifyTier(confidence);
    const existing = this._findDuplicate(thought);
    if (existing) {
      this._stats.duplicatesMerged++;
      return this._mergeWithExisting(existing, thought, tier, rootData);
    }
    const diamond = this._createDiamond(thought, tier, rootData);
    this._addDiamond(diamond);
    this._stats.diamondsCreated++;
    this.emit('diamond-created', diamond);
    return diamond;
  }

  _classifyTier(confidence) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0) return DIAMOND_TIERS.RAW;
    for (const key of Object.keys(DIAMOND_TIERS)) {
      const tier = DIAMOND_TIERS[key];
      if (confidence >= tier.minConfidence && confidence < tier.maxConfidence) return tier;
    }
    return DIAMOND_TIERS.DIAMOND;
  }

  _findDuplicate(thought) {
    const text = String(thought.content || thought.text || '').toLowerCase().trim();
    if (!text) return null;
    const thoughtType = thought.type || 'insight';
    for (const [, existing] of this._diamonds) {
      const existingText = String(existing.content || '').toLowerCase().trim();
      if (!existingText) continue;
      if (existing.type === thoughtType && this._computeSimilarity(text, existingText) >= this._dedupThreshold) {
        return existing;
      }
    }
    return null;
  }

  _computeSimilarity(a, b) {
    const strA = typeof a === 'string' ? a : '';
    const strB = typeof b === 'string' ? b : '';
    const setA = new Set(strA.split(/\s+/));
    const setB = new Set(strB.split(/\s+/));
    const intersection = [...setA].filter(function (w) { return setB.has(w); }).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  _mergeWithExisting(existing, incoming, newTier, rootData) {
    const oldTierName = existing.tier ? existing.tier.name : 'raw';
    if (incoming.confidence > existing.confidence) {
      existing.confidence = incoming.confidence;
      existing.content = incoming.content !== undefined ? String(incoming.content) : (incoming.text !== undefined ? String(incoming.text) : existing.content);
      existing.tier = newTier;
      if (newTier.name !== oldTierName) {
        this._updateTierIndex(existing.id, oldTierName, newTier.name);
        this._stats.diamondsUpgraded++;
        this.emit('diamond-upgraded', { id: existing.id, from: oldTierName, to: newTier.name });
      }
    }
    if (incoming.tags && Array.isArray(incoming.tags)) {
      const merged = new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])]);
      existing.tags = [...merged];
    }
    if (rootData) {
      this._attachRootData(existing, rootData);
    }
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  _createDiamond(thought, tier, rootData) {
    const id = thought.id || generateId('diamond');
    const diamond = {
      id: id,
      content: thought.content || thought.text || '',
      type: thought.type || 'insight',
      tier: tier,
      confidence: thought.confidence ?? 0.5,
      tags: Array.isArray(thought.tags) ? [...thought.tags] : [],
      sourceTaskId: thought.sourceTaskId ?? null,
      createdAt: thought.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessCount: 0,
      rootRefs: [],
    };
    if (rootData) this._attachRootData(diamond, rootData);
    return diamond;
  }

  _attachRootData(diamond, rootData) {
    if (!rootData || typeof rootData !== 'object') return;
    const refs = Array.isArray(rootData) ? rootData : [rootData];
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue;
      const refId = ref.id || ref.chunkId || ref.key || String(ref);
      if (refId && !diamond.rootRefs.includes(refId)) {
        diamond.rootRefs.push(refId);
        this._stats.rootDataMappings++;
      }
    }
  }

  _addDiamond(diamond) {
    this._diamonds.set(diamond.id, diamond);
    const tierName = diamond.tier ? diamond.tier.name : 'raw';
    if (this._tierIndex[tierName]) {
      this._tierIndex[tierName].push(diamond.id);
    }
  }

  _updateTierIndex(id, fromTier, toTier) {
    if (this._tierIndex[fromTier]) {
      const idx = this._tierIndex[fromTier].indexOf(id);
      if (idx !== -1) this._tierIndex[fromTier].splice(idx, 1);
    }
    if (this._tierIndex[toTier]) {
      this._tierIndex[toTier].push(id);
    }
  }

  _enforceCapacity() {
    if (this._diamonds.size <= this._maxDiamonds) return;
    const sorted = [...this._diamonds.values()].sort(function (a, b) {
      return (a.confidence ?? 0) - (b.confidence ?? 0);
    });
    const excess = this._diamonds.size - this._maxDiamonds;
    for (let i = 0; i < excess && i < sorted.length; i++) {
      this.removeDiamond(sorted[i].id);
    }
  }

  retrieveDiamonds(query) {
    this.guardShutdown();
    const safeQuery = query && typeof query === 'object' ? query : {};
    const tier = safeQuery.tier ?? null;
    const type = safeQuery.type ?? null;
    const minConfidence = typeof safeQuery.minConfidence === 'number' ? safeQuery.minConfidence : 0;
    const tags = Array.isArray(safeQuery.tags) ? safeQuery.tags : [];
    const limit = typeof safeQuery.limit === 'number' && safeQuery.limit > 0 ? safeQuery.limit : 20;

    let candidates = [...this._diamonds.values()];

    if (tier) {
      candidates = candidates.filter(function (d) { return d.tier && d.tier.name === tier; });
    }
    if (type) {
      candidates = candidates.filter(function (d) { return d.type === type; });
    }
    if (minConfidence > 0) {
      candidates = candidates.filter(function (d) { return (d.confidence ?? 0) >= minConfidence; });
    }
    if (tags.length > 0) {
      candidates = candidates.filter(function (d) {
        return tags.some(function (t) { return (d.tags ?? []).includes(t); });
      });
    }

    candidates.sort(function (a, b) { return (b.confidence ?? 0) - (a.confidence ?? 0); });
    candidates = candidates.slice(0, limit);

    for (const d of candidates) {
      d.accessCount = (d.accessCount ?? 0) + 1;
      d.updatedAt = new Date().toISOString();
    }

    return candidates;
  }

  getDiamond(id) {
    this.guardShutdown();
    const diamond = this._diamonds.get(id);
    if (diamond) {
      diamond.accessCount = (diamond.accessCount ?? 0) + 1;
      diamond.updatedAt = new Date().toISOString();
    }
    return diamond ?? null;
  }

  removeDiamond(id) {
    this.guardShutdown();
    const diamond = this._diamonds.get(id);
    if (!diamond) return false;
    const tierName = diamond.tier ? diamond.tier.name : 'raw';
    if (this._tierIndex[tierName]) {
      const idx = this._tierIndex[tierName].indexOf(id);
      if (idx !== -1) this._tierIndex[tierName].splice(idx, 1);
    }
    this._diamonds.delete(id);
    this.emit('diamond-removed', { id: id });
    return true;
  }

  traceRootData(diamondId) {
    const diamond = this._diamonds.get(diamondId);
    if (!diamond || !diamond.rootRefs || diamond.rootRefs.length === 0) return { diamondId: diamondId, rootRefs: [] };
    return { diamondId: diamondId, rootRefs: [...diamond.rootRefs] };
  }

  getTierStats() {
    const stats = {};
    for (const key of Object.keys(DIAMOND_TIERS)) {
      stats[key] = {
        name: DIAMOND_TIERS[key].name,
        label: DIAMOND_TIERS[key].label,
        color: DIAMOND_TIERS[key].color,
        count: this._tierIndex[key] ? this._tierIndex[key].length : 0,
      };
    }
    return stats;
  }

  getStats() {
    return safeAssign({}, this._stats, {
      totalDiamonds: this._diamonds.size,
      tierDistribution: this.getTierStats(),
    });
  }

  toJSON() {
    return {
      diamonds: [...this._diamonds.values()],
      stats: this.getStats(),
    };
  }

  _onShutdown() {
    this._diamonds.clear();
    for (const key of Object.keys(this._tierIndex)) {
      this._tierIndex[key] = [];
    }
    this._stats = {
      totalRefined: 0, diamondsCreated: 0, diamondsUpgraded: 0, diamondsDowngraded: 0,
      duplicatesMerged: 0, confidenceFiltered: 0, rootDataMappings: 0,
    };
    this._embeddingService = null;
    this._thoughtMemoryStore = null;
    this.removeAllListeners();
  }
}

ThoughtDiamond.DIAMOND_TIERS = DIAMOND_TIERS;
ThoughtDiamond.DEFAULT_CONFIDENCE_THRESHOLD = DEFAULT_CONFIDENCE_THRESHOLD;
ThoughtDiamond.DEFAULT_DEDUPLICATION_THRESHOLD = DEFAULT_DEDUPLICATION_THRESHOLD;

module.exports = withShutdown(ThoughtDiamond);
