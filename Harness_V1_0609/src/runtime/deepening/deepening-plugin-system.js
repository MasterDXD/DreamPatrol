'use strict';
const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');

/**
 * @module runtime/deepening/deepening-plugin-system
 * 深化推理插件系统 — 管理深化推理流程的插件注册、注销与钩子执行。
 * 支持 preDeepen（深化前）和 postDeepen（深化后）两种钩子类型，
 * 插件执行时自动捕获异常并通过 emitError 发出 'plugin-error' 事件。
 *
 * @classdesc 深化插件系统。插件发现、加载、生命周期管理。
 * @extends DeepeningBase
 * @emits 'plugin-error' 当插件钩子执行抛出异常时触发，附带 hook、plugin 和错误信息
 * @deprecated 请使用 runtime/infrastructure/plugin-manager 中的 PluginManager 替代
 */
class DeepeningPluginSystem extends DeepeningBase {

  /**
   * 创建 DeepeningPluginSystem 实例。构造时自动发出弃用警告。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPlugins=50] - 最大插件数
   */
  constructor() {
    super();
    DeepeningPluginSystem._warnDeprecated('DeepeningPluginSystem', 'PluginManager from runtime/infrastructure/plugin-manager', 'deepening-plugin-system');
    this._plugins = new Map();
    this._maxPlugins = 50;
  }

  /**
   * 注册插件。将插件对象以指定名称存入内部 Map，同名插件将被覆盖。
   * @param {string} name - 插件唯一标识名称
   * @param {Object} plugin - 插件对象
   * @param {Object} [plugin.hooks] - 插件钩子定义
   * @param {Function} [plugin.hooks.preDeepen] - 深化前钩子，接收 context 参数
   * @param {Function} [plugin.hooks.postDeepen] - 深化后钩子，接收 context 参数
   * @returns {boolean} 注册成功始终返回 true
   */
  registerPlugin(name, plugin) {
    this.guardShutdown();
    if (this._plugins.size >= this._maxPlugins && !this._plugins.has(name)) {
      const oldest = this._plugins.keys().next().value;
      this._plugins.delete(oldest);
    }
    this._plugins.set(name, plugin);
    return true;
  }

  /**
   * 注销插件。从内部 Map 中移除指定名称的插件。
   * @param {string} name - 要注销的插件名称
   * @returns {boolean} 若插件存在且已移除返回 true，否则返回 false
   */
  unregisterPlugin(name) { this.guardShutdown(); return this._plugins.delete(name); }

  /**
   * 获取指定名称的插件对象。
   * @param {string} name - 插件名称
   * @returns {Object|undefined} 插件对象，若不存在则返回 undefined
   */
  getPlugin(name) { return this._plugins.get(name); }

  /**
   * 获取所有已注册插件的名称列表。
   * @returns {Array<string>} 插件名称数组
   */
  getAllPlugins() { return Array.from(this._plugins.keys()); }

  /**
   * 依次执行所有已注册插件的 preDeepen 钩子。按注册顺序遍历，
   * 单个插件异常不会中断后续插件执行，异常通过 emitError 发出 'plugin-error' 事件。
   * @param {Object} [context={}] - 传递给钩子的上下文对象
   * @returns {Promise<Object>} 经过所有插件处理后的上下文对象
   */
  async executePreDeepen(context) {
    const ctx = context ?? {};
    for (const [name, plugin] of this._plugins) {
      if (plugin && plugin.hooks && plugin.hooks.preDeepen) {
        try { await plugin.hooks.preDeepen(ctx); } catch (pErr) { debug('DeepeningPluginSystem', 'preDeepen:' + name, pErr); emitError(this, 'plugin-error', pErr, { hook: 'preDeepen', plugin: name }); }
      }
    }
    return ctx;
  }

  /**
   * 依次执行所有已注册插件的 postDeepen 钩子。按注册顺序遍历，
   * 单个插件异常不会中断后续插件执行，异常通过 emitError 发出 'plugin-error' 事件。
   * @param {Object} [context={}] - 传递给钩子的上下文对象
   * @returns {Promise<Object>} 经过所有插件处理后的上下文对象
   */
  async executePostDeepen(context) {
    const ctx = context ?? {};
    for (const [name, plugin] of this._plugins) {
      if (plugin && plugin.hooks && plugin.hooks.postDeepen) {
        try { await plugin.hooks.postDeepen(ctx); } catch (pErr) { debug('DeepeningPluginSystem', 'postDeepen:' + name, pErr); emitError(this, 'plugin-error', pErr, { hook: 'postDeepen', plugin: name }); }
      }
    }
    return ctx;
  }

  /**
   * 获取插件钩子统计信息，统计各类型钩子的注册数量。
   * @returns {Object} 钩子统计对象
   * @returns {number} return.totalPlugins - 已注册插件总数
   * @returns {Object} return.hooks - 钩子统计
   * @returns {number} return.hooks.preDeepen - 注册了 preDeepen 钩子的插件数
   * @returns {number} return.hooks.postDeepen - 注册了 postDeepen 钩子的插件数
   */
  getPluginStats() {
    let preDeepen = 0; let postDeepen = 0;
    for (const [, p] of this._plugins) {
      if (p && p.hooks && p.hooks.preDeepen) preDeepen++;
      if (p && p.hooks && p.hooks.postDeepen) postDeepen++;
    }
    return { totalPlugins: this._plugins.size, hooks: { preDeepen, postDeepen } };
  }

  /**
   * 清除所有已注册的插件。
   * @returns {boolean} 清除成功始终返回 true
   */
  clear() { this.guardShutdown(); this._plugins.clear(); return true; }

  /**
   * 获取插件系统的运行统计信息，包含插件总数及基类统计。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalPlugins - 已注册插件总数
   */
  getStats() {
    return { totalPlugins: this._plugins.size, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空所有已注册的插件。
   * @protected
   */
  _onShutdown() {
    this._plugins.clear();
    super._onShutdown();
  }
}

module.exports = DeepeningPluginSystem;
