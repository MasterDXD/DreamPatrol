'use strict';
const DeepeningBase = require('./deepening-base');
const RingBuffer = require('../../utils/ring-buffer');
const stableStringify = require('../../utils/stable-stringify');

/**
 * @module runtime/deepening/deepening-feature-flags
 * 深化推理特性标志。特性标志系统，支持四种标志状态（开/关/百分比/变体）、
 * 确定性百分比灰度发布、规则化变体评估、标签分组及变更历史追踪。
 */

/**
 * @classdesc 深化特性标志。特性开关、A/B测试、灰度发布
 *
 * 深化推理特性标志 — 深化管道的特性标志系统。
 * 支持四种标志状态（on/off/percentage/variants），通过上下文哈希实现
 * 确定性百分比灰度发布，支持 eq/in/gt/lt 操作符的规则化变体评估、
 * 基于标签的标志分组，以及通过 RingBuffer 追踪的变更历史。
 *
 * @extends DeepeningBase
 * @emits 'defined' 当特性标志定义时触发，附带 { name, state }
 * @emits 'removed' 当特性标志移除时触发，附带 { name }
 * @emits 'changed' 当特性标志状态变更时触发，附带 { from, to }
 */
class DeepeningFeatureFlags extends DeepeningBase {
  /**
   * 标志状态枚举。
   * @constant
   * @type {Object}
   * @property {string} ON - 开启状态
   * @property {string} OFF - 关闭状态
   * @property {string} PERCENTAGE - 百分比灰度状态
   * @property {string} VARIANTS - 变体状态
   */
  static FLAG_STATES = { ON: 'on', OFF: 'off', PERCENTAGE: 'percentage', VARIANTS: 'variants' };

  /**
   * 创建 DeepeningFeatureFlags 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxHistory=100] - 变更历史最大记录数
   */
  constructor(options) {
    super(options);
    this._flags = new Map();
    this._maxFlags = 200;
    this._maxHistory = (options && options.maxHistory) ?? 100;
    this._history = new RingBuffer(this._maxHistory);
    this._totalEvaluations = 0;
    this._totalOn = 0;
    this._totalOff = 0;
    this._byTag = {};
  }

  /**
   * 定义特性标志。若已存在则返回 true（幂等）。
   * @param {string} name - 标志名称
   * @param {Object} [options] - 标志选项
   * @param {string} [options.state='on'] - 初始状态（'on'|'off'|'percentage'|'variants'）
   * @param {number} [options.percentage=100] - 百分比灰度值（0~100）
   * @param {string} [options.description] - 标志描述
   * @param {string} [options.owner] - 标志负责人
   * @param {string[]} [options.tags=[]] - 标签列表
   * @param {string} [options.defaultVariant] - 默认变体名称
   * @param {Array<Object>} [options.variants=[]] - 变体定义列表
   * @returns {boolean|Object} 成功返回 true，名称为空返回 { ok: false, error }
   * @emits 'defined'
   */
  define(name, options) {
    this.guardShutdown();
    if (!name) return { ok: false, error: 'Flag name is required' };
    if (this._flags.has(name)) return true;
    const opts = options ?? {};
    const validStates = new Set(['on', 'off', 'percentage', 'variants']);
    const state = validStates.has(opts.state) ? opts.state : 'on';
    const percentage = typeof opts.percentage === 'number' ? Math.max(0, Math.min(100, opts.percentage)) : 100;
    if (this._flags.size >= this._maxFlags && !this._flags.has(name)) {
      const oldest = this._flags.keys().next().value;
      this._flags.delete(oldest);
      this.emit('removed', { name: oldest });
    }
    this._flags.set(name, { name, state, description: opts.description, owner: opts.owner, tags: opts.tags ?? [], defaultVariant: opts.defaultVariant, variants: opts.variants ?? [], percentage, evaluationCount: 0, onCount: 0 });
    for (const tag of (opts.tags ?? [])) {
      if (!this._byTag[tag]) this._byTag[tag] = new Set();
      this._byTag[tag].add(name);
    }
    this.emit('defined', { name, state });
    return true;
  }

  /**
   * 移除特性标志。同时清理标签索引。
   * @param {string} name - 标志名称
   * @returns {boolean} 是否成功移除
   * @emits 'removed'
   */
  remove(name) {
    this.guardShutdown();
    if (!this._flags.has(name)) return false;
    const flag = this._flags.get(name);
    for (const tag of (flag.tags ?? [])) {
      const set = this._byTag[tag];
      if (set) { set.delete(name); if (set.size === 0) delete this._byTag[tag]; }
    }
    this._flags.delete(name);
    this.emit('removed', { name });
    return true;
  }

  /**
   * 判断特性标志是否启用。根据标志状态评估：on 直接启用、off 直接禁用、
   * percentage 通过上下文哈希确定性评估、variants 通过规则匹配评估。
   * @param {string} name - 标志名称
   * @param {Object} [context] - 评估上下文，用于百分比哈希和变体规则匹配
   * @returns {boolean} 是否启用
   */
  isEnabled(name, context) {
    this.guardShutdown();
    const flag = this._flags.get(name);
    if (!flag) return false;
    flag.evaluationCount++;
    this._totalEvaluations++;
    if (flag.state === 'off') { this._totalOff++; return false; }
    if (flag.state === 'on') { flag.onCount++; this._totalOn++; return true; }
    if (flag.state === 'percentage') {
      if (flag.percentage === 0) { this._totalOff++; return false; }
      const hash = context ? this._hash(name + stableStringify(context)) : this._hash(name);
      if (hash < flag.percentage) { flag.onCount++; this._totalOn++; return true; }
      this._totalOff++; return false;
    }
    if (flag.state === 'variants') {
      const variant = this._evaluateRules(flag, context);
      if (variant) { flag.onCount++; this._totalOn++; return true; }
      this._totalOff++; return false;
    }
    return false;
  }

  /**
   * 评估变体规则。按顺序匹配变体的规则列表，支持 eq/in/gt/lt 操作符。
   * @param {Object} flag - 标志对象
   * @param {Object} [context] - 评估上下文
   * @returns {string|null} 匹配的变体名称，无匹配时返回默认变体或 null
   * @private
   */
  _evaluateRules(flag, context) {
    if (!context) return flag.defaultVariant ?? null;
    const variants = Array.isArray(flag.variants) ? flag.variants : this._variantsToArray(flag.variants);
    for (const v of variants) {
      if (!v.rules || v.rules.length === 0) continue;
      let matches = true;
      for (const rule of v.rules) {
        const val = context[rule.field];
        switch (rule.operator) {
          case 'eq': if (val !== rule.value) matches = false; break;
          case 'in': if (!rule.value.includes(val)) matches = false; break;
          case 'gt': if (!(val > rule.value)) matches = false; break;
          case 'lt': if (!(val < rule.value)) matches = false; break;
          default: matches = false;
        }
        if (!matches) break;
      }
      if (matches) return v.name;
    }
    return flag.defaultVariant ?? null;
  }

  /**
   * 将对象格式的变体定义转换为数组格式。
   * @param {Object} variants - 对象格式的变体定义
   * @returns {Object[]} 数组格式的变体列表
   * @private
   */
  _variantsToArray(variants) {
    if (!variants || typeof variants !== 'object') return [];
    return Object.entries(variants).map(([name, config]) => ({ name, rules: config.rules ?? [] }));
  }

  /**
   * 获取特性标志的当前变体。仅在 variants 状态下评估规则。
   * @param {string} name - 标志名称
   * @param {Object} [context] - 评估上下文
   * @returns {string|null} 变体名称，无匹配时返回默认变体或 null
   */
  getVariant(name, context) {
    const flag = this._flags.get(name);
    if (!flag) return null;
    if (flag.state === 'variants') return this._evaluateRules(flag, context) ?? flag.defaultVariant ?? null;
    return flag.defaultVariant ?? null;
  }

  /**
   * 添加变更历史记录。
   * @param {string} from - 原状态
   * @param {string} to - 新状态
   * @private
   */
  _addHistory(from, to) { this._history.push({ from, to, timestamp: Date.now() }); }

  /**
   * 将特性标志设为开启状态。
   * @param {string} name - 标志名称
   * @returns {boolean|Object} 成功返回 true，不存在返回 { ok: false, error }
   * @emits 'changed'
   */
  turnOn(name) { this.guardShutdown(); const f = this._flags.get(name); if (!f) return { ok: false, error: 'Flag not found' }; const from = f.state; f.state = 'on'; this._addHistory(from, 'on'); this.emit('changed', { from, to: 'on' }); return true; }

  /**
   * 将特性标志设为关闭状态。
   * @param {string} name - 标志名称
   * @returns {boolean|Object} 成功返回 true，不存在返回 { ok: false, error }
   * @emits 'changed'
   */
  turnOff(name) { this.guardShutdown(); const f = this._flags.get(name); if (!f) return { ok: false, error: 'Flag not found' }; const from = f.state; f.state = 'off'; this._addHistory(from, 'off'); this.emit('changed', { from, to: 'off' }); return true; }

  /**
   * 设置百分比灰度值并将标志切换为百分比状态。
   * @param {string} name - 标志名称
   * @param {number} pct - 百分比值（0~100，自动裁剪）
   * @returns {boolean|Object} 成功返回 true，不存在返回 { ok: false, error }
   * @emits 'changed'
   */
  setPercentage(name, pct) {
    this.guardShutdown();
    const f = this._flags.get(name);
    if (!f) return { ok: false, error: 'Flag not found' };
    const from = f.state;
    f.percentage = Math.max(0, Math.min(100, pct));
    f.state = 'percentage';
    this._addHistory(from, 'percentage');
    this.emit('changed', { to: 'percentage', percentage: f.percentage });
    return true;
  }

  /**
   * 设置变体定义并将标志切换为变体状态。
   * @param {string} name - 标志名称
   * @param {Array<Object>} variants - 变体定义列表
   * @param {string} defaultVariant - 默认变体名称
   * @returns {boolean|Object} 成功返回 true，不存在返回 { ok: false, error }
   * @emits 'changed'
   */
  setVariants(name, variants, defaultVariant) {
    this.guardShutdown();
    const f = this._flags.get(name);
    if (!f) return { ok: false, error: 'Flag not found' };
    const from = f.state;
    f.variants = variants; f.defaultVariant = defaultVariant; f.state = 'variants';
    this._addHistory(from, 'variants');
    this.emit('changed', { from, to: 'variants' });
    return true;
  }

  /**
   * 获取特性标志对象。
   * @param {string} name - 标志名称
   * @returns {Object|null} 标志对象，不存在时返回 null
   */
  getFlag(_name) { const f = this._flags.get(_name); return f ? { ...f } : null; }

  /**
   * 获取所有特性标志名称。
   * @returns {string[]} 标志名称数组
   */
  getFlagNames() { return Array.from(this._flags.keys()); }

  /**
   * 按标签获取特性标志列表。
   * @param {string} tag - 标签名称
   * @returns {Object[]} 匹配标签的标志对象数组
   */
  getByTag(tag) {
    const names = this._byTag[tag];
    if (!names) return [];
    return Array.from(names, n => this._flags.get(n)).filter(Boolean);
  }

  /**
   * 获取变更历史记录。
   * @param {number} [limit] - 返回记录数量上限
   * @returns {Object[]} 变更历史记录数组
   */
  getHistory(limit) { const n = limit ?? this._maxHistory; return n > 0 ? this._history.slice(-n) : []; }

  /**
   * 确定性哈希函数。将字符串映射到 0~99 的整数。
   * @param {string} str - 输入字符串
   * @returns {number} 哈希值（0~99）
   * @private
   */
  _hash(str) { let hash = 0; for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; } return Math.abs(hash) % 100; }

  /**
   * 获取特性标志运行统计信息。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalFlags - 标志总数
   * @returns {number} return.totalEvaluations - 评估总次数
   * @returns {number} return.totalOn - 启用总次数
   * @returns {number} return.totalOff - 禁用总次数
   */
  getStats() { return { totalFlags: this._flags.size, totalEvaluations: this._totalEvaluations, totalOn: this._totalOn, totalOff: this._totalOff, ...super.getStats() }; }

  /**
   * 关闭时的清理回调。清空所有标志。
   * @protected
   */
  _onShutdown() {
    this._flags.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningFeatureFlags;
