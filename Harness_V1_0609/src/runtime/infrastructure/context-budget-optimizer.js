/**
 * @module context-budget-optimizer
 * @description 上下文预算优化器 — 融合Claude Code扩展功能的上下文成本分层模型。
 * 实现CLAUDE.md > Skills > MCP > Subagents > Hooks的上下文加载成本优先级，
 * 根据可用上下文窗口动态分配各层加载配额，优化上下文利用率。
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');

// Feature layer priority (higher = loaded first, costs more context)
const FEATURE_LAYERS = {
  PROJECT_MEMORY: 'project_memory',   // CLAUDE.md equivalent - highest cost
  SKILLS: 'skills',                   // Skill packs - high cost
  MCP: 'mcp',                         // External connections - medium cost
  SUBAGENTS: 'subagents',             // Parallel processing - low cost
  HOOKS: 'hooks',                     // Event automation - lowest cost
};

const LAYER_PRIORITY = {
  [FEATURE_LAYERS.PROJECT_MEMORY]: 5,
  [FEATURE_LAYERS.SKILLS]: 4,
  [FEATURE_LAYERS.MCP]: 3,
  [FEATURE_LAYERS.SUBAGENTS]: 2,
  [FEATURE_LAYERS.HOOKS]: 1,
};

const LAYER_DEFAULT_BUDGET_RATIO = {
  [FEATURE_LAYERS.PROJECT_MEMORY]: 0.35,  // 35% for project memory
  [FEATURE_LAYERS.SKILLS]: 0.25,          // 25% for skills
  [FEATURE_LAYERS.MCP]: 0.20,             // 20% for MCP
  [FEATURE_LAYERS.SUBAGENTS]: 0.12,       // 12% for subagents
  [FEATURE_LAYERS.HOOKS]: 0.08,           // 8% for hooks
};

const DEFAULT_CONFIG = {
  maxContextTokens: 200000,
  warningThreshold: 0.8,
  dangerThreshold: 0.95,
  maxHistorySize: 200,
};

class ContextBudgetOptimizer extends EventEmitter {
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._layerUsage = new BoundedMap(this._config.maxHistorySize);  // layer -> current token usage
    this._layerBudgets = {};    // layer -> allocated token budget
    this._layerLoaded = {};     // layer -> Set of loaded item IDs
    this._totalUsed = 0;
    this._stats = {
      totalAllocations: 0,
      totalRejections: 0,
      totalReclaims: 0,
      layerStats: {},
    };
    this._allocateBudgets();
  }

  _allocateBudgets() {
    const total = this._config.maxContextTokens;
    for (const [layer, ratio] of Object.entries(LAYER_DEFAULT_BUDGET_RATIO)) {
      this._layerBudgets[layer] = Math.floor(total * ratio);
      this._layerLoaded[layer] = new Set();
      this._stats.layerStats[layer] = { allocations: 0, rejections: 0, reclaims: 0, peakUsage: 0 };
    }
  }

  // Check if a feature can be loaded within budget
  canLoad(layer, itemId, estimatedTokens) {
    this.guardShutdown();
    if (!LAYER_PRIORITY[layer]) return false;
    const currentUsage = this._layerUsage.get(layer) ?? 0;
    const budget = this._layerBudgets[layer] ?? 0;
    if (currentUsage + estimatedTokens > budget) {
      this._stats.totalRejections++;
      this._stats.layerStats[layer].rejections++;
      this.emit('budget-exceeded', { layer, itemId, estimatedTokens, currentUsage, budget });
      return false;
    }
    return true;
  }

  // Register a loaded feature item
  registerLoad(layer, itemId, tokenCount) {
    this.guardShutdown();
    if (!LAYER_PRIORITY[layer]) return false;
    const currentUsage = this._layerUsage.get(layer) ?? 0;
    const budget = this._layerBudgets[layer] ?? 0;
    if (currentUsage + tokenCount > budget) {
      this._stats.totalRejections++;
      this._stats.layerStats[layer].rejections++;
      this.emit('budget-exceeded', { layer, itemId, tokenCount, currentUsage, budget });
      return false;
    }
    this._layerUsage.set(layer, currentUsage + tokenCount);
    this._layerLoaded[layer].add(itemId);
    this._totalUsed += tokenCount;
    this._stats.totalAllocations++;
    this._stats.layerStats[layer].allocations++;
    this._stats.layerStats[layer].peakUsage = Math.max(
      this._stats.layerStats[layer].peakUsage,
      currentUsage + tokenCount,
    );
    this.emit('item-loaded', { layer, itemId, tokenCount, totalUsed: this._totalUsed });
    this._checkThresholds();
    return true;
  }

  // Unregister a loaded feature item
  unregisterLoad(layer, itemId, tokenCount) {
    this.guardShutdown();
    if (!LAYER_PRIORITY[layer]) return false;
    if (!this._layerLoaded[layer].has(itemId)) return false;
    const currentUsage = this._layerUsage.get(layer) ?? 0;
    this._layerUsage.set(layer, Math.max(0, currentUsage - tokenCount));
    this._layerLoaded[layer].delete(itemId);
    this._totalUsed = Math.max(0, this._totalUsed - tokenCount);
    this.emit('item-unloaded', { layer, itemId, tokenCount, totalUsed: this._totalUsed });
    return true;
  }

  // Reclaim budget from a layer (e.g., unload low-priority items)
  reclaimFromLayer(layer, targetTokens) {
    this.guardShutdown();
    if (!LAYER_PRIORITY[layer]) return 0;
    const currentUsage = this._layerUsage.get(layer) ?? 0;
    const reclaimed = Math.min(currentUsage, targetTokens);
    this._layerUsage.set(layer, currentUsage - reclaimed);
    this._totalUsed = Math.max(0, this._totalUsed - reclaimed);
    this._stats.totalReclaims++;
    this._stats.layerStats[layer].reclaims += reclaimed;
    const loadedSet = this._layerLoaded[layer];
    if (loadedSet && loadedSet.size > 0 && reclaimed > 0) {
      const itemsToRemove = Math.ceil((reclaimed / currentUsage) * loadedSet.size);
      const toRemove = [];
      for (const itemId of loadedSet) {
        if (toRemove.length >= itemsToRemove) break;
        toRemove.push(itemId);
      }
      for (const id of toRemove) {
        loadedSet.delete(id);
      }
    }
    this.emit('budget-reclaimed', { layer, reclaimed, totalUsed: this._totalUsed });
    return reclaimed;
  }

  // Reallocate budgets based on actual usage patterns
  reallocateBudgets(usagePattern) {
    this.guardShutdown();
    // usagePattern: { layer: desiredRatio }
    const total = this._config.maxContextTokens;
    const layers = Object.keys(usagePattern);
    const sumRatio = layers.reduce((sum, l) => sum + (usagePattern[l] ?? 0), 0);
    if (sumRatio <= 0) return;
    for (const layer of layers) {
      const normalizedRatio = (usagePattern[layer] ?? 0) / sumRatio;
      this._layerBudgets[layer] = Math.floor(total * normalizedRatio);
    }
    this.emit('budgets-reallocated', { budgets: Object.assign({}, this._layerBudgets) });
  }

  // Get budget status for all layers
  getBudgetStatus() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalUsed: 0, totalBudget: 0, utilization: 0, layers: {} };
    }
    const layers = {};
    for (const layer of Object.values(FEATURE_LAYERS)) {
      const usage = this._layerUsage.get(layer) ?? 0;
      const budget = this._layerBudgets[layer] ?? 0;
      layers[layer] = {
        usage,
        budget,
        utilization: budget > 0 ? usage / budget : 0,
        loadedItems: (this._layerLoaded[layer] || new Set()).size,
        priority: LAYER_PRIORITY[layer] ?? 0,
      };
    }
    return {
      totalUsed: this._totalUsed,
      totalBudget: this._config.maxContextTokens,
      utilization: this._totalUsed / this._config.maxContextTokens,
      layers,
    };
  }

  // Get optimization recommendations
  getRecommendations() {
    try { this.guardShutdown(); } catch (_e) { debug('ContextBudgetOptimizer', 'guardShutdown', _e && _e.message ? _e.message : String(_e)); return []; }
    const recommendations = [];
    const status = this.getBudgetStatus();
    for (const [layer, info] of Object.entries(status.layers)) {
      if (info.utilization > this._config.dangerThreshold) {
        recommendations.push({
          layer,
          action: 'reduce',
          reason: 'Layer at ' + Math.round(info.utilization * 100) + '% capacity',
          suggestedReclaim: Math.floor(info.usage * 0.3),
        });
      } else if (info.utilization < 0.3 && info.priority >= 3) {
        recommendations.push({
          layer,
          action: 'expand',
          reason: 'High-priority layer underutilized at ' + Math.round(info.utilization * 100) + '%',
          suggestedIncrease: Math.floor(info.budget * 0.2),
        });
      }
    }
    return recommendations;
  }

  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalAllocations: 0, totalRejections: 0, totalReclaims: 0, layerStats: {} };
    }
    return Object.assign({}, this._stats, { totalUsed: this._totalUsed, totalBudget: this._config.maxContextTokens });
  }

  _checkThresholds() {
    const utilization = this._totalUsed / this._config.maxContextTokens;
    if (utilization >= this._config.dangerThreshold) {
      this.emit('budget-danger', { utilization, totalUsed: this._totalUsed, totalBudget: this._config.maxContextTokens });
    } else if (utilization >= this._config.warningThreshold) {
      this.emit('budget-warning', { utilization, totalUsed: this._totalUsed, totalBudget: this._config.maxContextTokens });
    }
  }

  _onShutdown() {
    safeCall(() => { for (const set of Object.values(this._layerLoaded)) set.clear(); }, 'ContextBudgetOptimizer', 'clear-loaded');
    this._layerLoaded = {};
    this._layerUsage.shutdown();
    this._layerBudgets = {};
    this._totalUsed = 0;
    this.removeAllListeners();
  }
}

withShutdown(ContextBudgetOptimizer);

module.exports = { ContextBudgetOptimizer, FEATURE_LAYERS, LAYER_PRIORITY, LAYER_DEFAULT_BUDGET_RATIO };
