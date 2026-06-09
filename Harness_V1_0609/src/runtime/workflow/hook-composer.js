/**
 * @module hook-composer
 * @description Hook组合器 — 融合Claude Code扩展功能的Hook组合机制。
 * 支持将多个Hook组合为可复用的Meta-Hook单元，解决Hook无法组合复用的空白。
 * 提供顺序执行、并行执行和条件分支三种组合策略。
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');

const COMPOSITION_STRATEGIES = {
  SEQUENTIAL: 'sequential',     // 顺序执行，任一失败则中止
  PARALLEL: 'parallel',         // 并行执行，收集所有结果
  CONDITIONAL: 'conditional',   // 条件分支，根据条件选择执行路径
};

const DEFAULT_CONFIG = {
  maxCompositions: 50,
  maxHooksPerComposition: 10,
  compositionTimeoutMs: 30000,
};

class HookComposer extends EventEmitter {
  constructor(hookExecutor, config) {
    super();
    this._hookExecutor = hookExecutor;
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._compositions = new Map();  // compositionId -> composition definition
    this._stats = {
      compositionsCreated: 0,
      compositionsExecuted: 0,
      compositionsFailed: 0,
      totalHooksComposed: 0,
    };
  }

  // Create a new hook composition
  createComposition(compositionId, options) {
    this.guardShutdown();
    if (!compositionId || typeof compositionId !== 'string') throw new Error('compositionId must be a non-empty string');
    if (this._compositions.has(compositionId)) throw new Error('Composition already exists: ' + compositionId);
    if (this._compositions.size >= this._config.maxCompositions) throw new Error('Maximum compositions reached');

    const strategy = options.strategy || COMPOSITION_STRATEGIES.SEQUENTIAL;
    if (!Object.values(COMPOSITION_STRATEGIES).includes(strategy)) {
      throw new Error('Invalid strategy: ' + strategy);
    }

    const hooks = options.hooks ?? [];
    if (hooks.length > this._config.maxHooksPerComposition) {
      throw new Error('Exceeded max hooks per composition: ' + this._config.maxHooksPerComposition);
    }

    const composition = {
      id: compositionId,
      name: options.name || compositionId,
      description: options.description || '',
      strategy,
      hooks: hooks.map(function(h, idx) {
        return {
          event: h.event,
          action: h.action,
          order: idx,
          condition: h.condition ?? null,
          timeout: h.timeout ?? null,
        };
      }),
      onFailure: options.onFailure || 'stop',  // stop | continue | fallback
      fallbackHook: options.fallbackHook ?? null,
      createdAt: new Date().toISOString(),
    };

    this._compositions.set(compositionId, composition);
    this._stats.compositionsCreated++;
    this._stats.totalHooksComposed += hooks.length;
    this.emit('composition-created', { compositionId, strategy, hookCount: hooks.length });
    return composition;
  }

  /**
   * 执行指定组合。根据组合策略（顺序、并行、条件分支）执行所有Hook，
   * 失败时根据 onFailure 策略决定是否中止、继续或执行回退Hook。
   * @param {string} compositionId - 组合标识符
   * @param {Object} context - 执行上下文
   * @returns {Promise<Object>} 执行结果，包含 passed、results 等字段
   * @throws {Error} 组合不存在或HookExecutor未注入时抛出
   */
  async executeComposition(compositionId, context) {
    this.guardShutdown();
    const composition = this._compositions.get(compositionId);
    if (!composition) throw new Error('Composition not found: ' + compositionId);
    if (!this._hookExecutor) throw new Error('HookExecutor not attached');

    this._stats.compositionsExecuted++;
    this.emit('composition-started', { compositionId, strategy: composition.strategy });

    const startTime = Date.now();
    let result;

    try {
      switch (composition.strategy) {
        case COMPOSITION_STRATEGIES.SEQUENTIAL:
          result = await this._executeSequential(composition, context);
          break;
        case COMPOSITION_STRATEGIES.PARALLEL:
          result = await this._executeParallel(composition, context);
          break;
        case COMPOSITION_STRATEGIES.CONDITIONAL:
          result = await this._executeConditional(composition, context);
          break;
        default:
          result = await this._executeSequential(composition, context);
      }
    } catch (err) {
      this._stats.compositionsFailed++;
      this.emit('composition-failed', { compositionId, error: err && err.message ? err.message : String(err) });
      if (composition.onFailure === 'continue') {
        result = { passed: false, reason: err && err.message ? err.message : String(err), continued: true };
      } else if (composition.onFailure === 'fallback' && composition.fallbackHook) {
        result = await this._executeSingleHook(composition.fallbackHook, context);
      } else {
        throw err;
      }
    }

    if (this._shutDown) return { passed: false, reason: 'Shut down during execution', duration: Date.now() - startTime };

    const duration = Date.now() - startTime;
    this.emit('composition-completed', { compositionId, passed: result.passed, duration });
    return result;
  }

  async _executeSequential(composition, context) {
    const results = [];
    for (const hook of composition.hooks) {
      if (this._shutDown) break;
      const hookResult = await this._executeSingleHook(hook, context);
      results.push(hookResult);
      if (!hookResult.passed && composition.onFailure === 'stop') {
        return { passed: false, reason: 'Hook failed: ' + hook.action, results, failedAt: hook.action };
      }
    }
    return { passed: results.length > 0 && results.every(function(r) { return r.passed; }), results };
  }

  async _executeParallel(composition, context) {
    if (this._shutDown) return { passed: false, reason: 'Shut down during parallel execution' };
    const promises = composition.hooks.map(hook => {
      return this._executeSingleHook(hook, context).catch(function(err) {
        return { passed: false, reason: err && err.message ? err.message : String(err), action: hook.action };
      });
    });
    const settled = await Promise.all(promises);
    if (this._shutDown) return { passed: false, reason: 'Shut down during parallel execution', partial: true };
    return { passed: settled.length > 0 && settled.every(function(r) { return r.passed; }), results: settled };
  }

  async _executeConditional(composition, context) {
    let executedCount = 0;
    for (const hook of composition.hooks) {
      if (this._shutDown) break;
      if (hook.condition && typeof hook.condition === 'function') {
        const shouldExecute = hook.condition(context);
        if (!shouldExecute) continue;
      } else if (hook.condition && typeof hook.condition === 'string') {
        const contextValue = context[hook.condition];
        if (contextValue === undefined || contextValue === null) continue;
      }
      const hookResult = await this._executeSingleHook(hook, context);
      executedCount++;
      if (!hookResult.passed && composition.onFailure === 'stop') {
        return { passed: false, reason: 'Conditional hook failed: ' + hook.action, failedAt: hook.action };
      }
    }
    return { passed: true, results: [], executedCount };
  }

  async _executeSingleHook(hook, context) {
    if (!this._hookExecutor) return { passed: false, reason: 'No hook executor' };
    try {
      const result = await this._hookExecutor.execute(hook.event, context);
      return result || { passed: true };
    } catch (err) {
      return { passed: false, reason: err && err.message ? err.message : String(err), action: hook.action };
    }
  }

  // Get a composition
  getComposition(compositionId) {
    if (this._shutDown) return null;
    const comp = this._compositions.get(compositionId); return comp ? { ...comp, hooks: comp.hooks ? [...comp.hooks] : [] } : null;
  }

  // List all compositions
  listCompositions() {
    if (this._shutDown) return [];
    const result = [];
    this._compositions.forEach(function(comp, id) {
      result.push({ id, name: comp.name, strategy: comp.strategy, hookCount: comp.hooks.length });
    });
    return result;
  }

  // Remove a composition
  removeComposition(compositionId) {
    this.guardShutdown();
    const existed = this._compositions.delete(compositionId);
    if (existed) this.emit('composition-removed', { compositionId });
    return existed;
  }

  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { compositionsCreated: 0, compositionsExecuted: 0, compositionsFailed: 0, totalHooksComposed: 0 };
    }
    return Object.assign({}, this._stats, { totalCompositions: this._compositions.size });
  }

  _onShutdown() {
    this._compositions.clear();
    this.removeAllListeners();
  }
}

module.exports = { HookComposer: withShutdown(HookComposer), COMPOSITION_STRATEGIES };
