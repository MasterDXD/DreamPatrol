'use strict';
const DeepeningBase = require('./deepening-base');
const BoundedMap = require('../../utils/bounded-map');
const { debug } = require('../../utils/debug-logger');
const { safeCall } = require('../../utils/safe-execute');

/**
 * @module runtime/deepening/deepening-cache
 * 深化推理缓存。基于质量感知的结果缓存，以序列化任务描述符为键存储任务结果，
 * 容量满时淘汰条目，覆盖时优先保留高质量评分的条目，并追踪命中/未命中/淘汰统计。
 */

/**
 * @classdesc 深化推理缓存 — 深化管道的质量感知结果缓存。
 * 以序列化任务描述符为键存储任务结果，容量满时淘汰条目，
 * 覆盖时优先保留高质量评分的条目，追踪命中/未命中/淘汰统计用于缓存性能监控。
 *
 * @extends DeepeningBase
 * @emits 'defined' 当缓存条目存储时触发（未使用，保留扩展）
 */
class DeepeningCache extends DeepeningBase {
  /**
   * 创建 DeepeningCache 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxSize=1000] - 缓存最大条目数，超出时自动淘汰
   */
  constructor(options) { super(options); this._entries = new BoundedMap(typeof (this._options.maxSize) === 'number' && Number.isFinite(this._options.maxSize) ? this._options.maxSize : 1000, { onEvict: () => { this._evictions++; } }); this._hits = 0; this._misses = 0; this._evictions = 0; this._keyCache = new WeakMap(); }

  /**
   * 根据任务描述符生成缓存键。使用 WeakMap 缓存已序列化的键以提升性能。
   * @param {Object} task - 任务描述符对象
   * @returns {string} 序列化后的缓存键
   * @private
   */
  _key(task) {
    let cached = this._keyCache.get(task);
    if (cached !== undefined) return cached;
    try { cached = JSON.stringify(task); } catch (_e) { debug('DeepeningCache', 'keyStringify', _e && _e.message ? _e.message : String(_e)); cached = String(task && task.id ? task.id : Date.now()) + ':' + (typeof task === 'object' && task !== null ? Object.keys(task).join(',') : String(task)); }
    try { this._keyCache.set(task, cached); } catch (_e) { debug('DeepeningCache', 'weakMapSetRejected', _e && _e.message ? _e.message : String(_e)); }
    return cached;
  }

  /**
   * 存储任务结果到缓存。若已有相同键且新条目质量评分不高于已有条目，则保留已有条目。
   * @param {Object} task - 任务描述符，用作缓存键
   * @param {*} result - 任务执行结果
   * @param {Object} [metadata] - 结果元数据
   * @param {number} [metadata.qualityScore=0] - 质量评分，用于覆盖决策
   * @param {string} [metadata.agentId] - 产生结果的Agent标识
   * @returns {boolean} 存储是否成功，task 或 result 为 null 时返回 false
   */
  store(task, result, metadata) {
    this.guardShutdown();
    if (task == null || result == null) return false;
    const key = this._key(task);
    const meta = metadata ?? {};
    const existing = this._entries.get(key);
    if (existing && (typeof meta.qualityScore === 'number' && Number.isFinite(meta.qualityScore) ? meta.qualityScore : 0) <= existing.qualityScore) return true;
    this._entries.set(key, { result, qualityScore: typeof meta.qualityScore === 'number' && Number.isFinite(meta.qualityScore) ? meta.qualityScore : 0, metadata: meta, timestamp: Date.now() });
    return true;
  }

  /**
   * 从缓存中检索任务结果。
   * @param {Object} task - 任务描述符，用作缓存键
   * @returns {Object|null} 包含 result 和 qualityScore 的对象，未命中时返回 null
   * @returns {*} return.result - 任务执行结果
   * @returns {number} return.qualityScore - 结果质量评分
   */
  retrieve(task) {
    this.guardShutdown();
    if (!task) { this._misses++; return null; }
    const entry = this._entries.get(this._key(task));
    if (entry) { this._hits++; return { result: entry.result, qualityScore: entry.qualityScore }; }
    this._misses++;
    return null;
  }

  /**
   * 使指定任务的缓存条目失效。
   * @param {Object} task - 任务描述符
   * @returns {boolean} 是否成功删除缓存条目
   */
  invalidate(task) { this.guardShutdown(); return this._entries.delete(this._key(task)); }

  /**
   * 按模式批量使缓存条目失效。当前支持按 agentId 过滤。
   * @param {Object} pattern - 匹配模式
   * @param {string} [pattern.agentId] - 按Agent标识过滤
   * @returns {number} 被删除的缓存条目数
   */
  invalidateByPattern(pattern) {
    this.guardShutdown();
    if (!pattern || typeof pattern !== 'object') return 0;
    let count = 0;
    const keysToDelete = [];
    for (const [key, entry] of this._entries) {
      let match = true;
      if (pattern.agentId && entry.metadata.agentId !== pattern.agentId) match = false;
      if (match) { keysToDelete.push(key); count++; }
    }
    for (const k of keysToDelete) { this._entries.delete(k); }
    return count;
  }

  /**
   * 获取所有缓存条目，按质量评分降序排列。
   * @returns {Object[]} 缓存条目数组，每项包含 result、qualityScore、metadata、timestamp
   */
  getEntries() { return Array.from(this._entries.values()).map(e => ({ ...e })).sort((a, b) => b.qualityScore - a.qualityScore); }

  /**
   * 清空所有缓存条目。
   */
  clear() { this.guardShutdown(); this._entries.clear(); }

  /**
   * 获取缓存运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.hits - 缓存命中次数
   * @returns {number} return.misses - 缓存未命中次数
   * @returns {number} return.hitRate - 缓存命中率（0~1）
   * @returns {number} return.size - 当前缓存条目数
   * @returns {number} return.evictions - 淘汰次数
   */
  getStats() {
    const total = this._hits + this._misses;
    return { hits: this._hits, misses: this._misses, hitRate: total > 0 ? this._hits / total : 0, size: this._entries.size, evictions: this._evictions, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空所有缓存条目。
   * @protected
   */
  _onShutdown() {
    safeCall(() => this._entries.shutdown(), 'DeepeningCache', 'shutdown-entries');
    super._onShutdown();
    this.removeAllListeners();
  }
}
module.exports = DeepeningCache;
