'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeExecute } = require('../../utils/safe-execute');
const { HarnessError } = require('../../errors');
const { DANGEROUS_KEYS } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MAX_PLUGINS = 100;
const MAX_HOOKS_PER_NAME = 50;

/**
 * @module runtime/infrastructure/plugin-manager
 * PluginManager — 插件管理器
 * 管理插件的生命周期（注册、初始化、销毁）和钩子（hook）执行。
 * 插件通过init函数接收上下文并注册钩子处理器，钩子按注册顺序链式执行。
 * 支持危险键过滤、初始化失败回滚和插件查询。
 * @classdesc 插件管理器。插件发现、加载、生命周期管理
 */
class PluginManager extends EventEmitter {
  /**
   * 创建 PluginManager 实例。
   * @param {EventBus} [eventBus] - 事件总线实例，将传递给插件的初始化上下文
   */
  constructor(eventBus) {
    super();
    this._plugins = new Map();
    this._eventBus = eventBus ?? null;
    this._hooks = {};
  }

  /**
   * 注册插件。插件通过 init 函数接收上下文并注册钩子处理器，初始化失败时自动回滚已注册的钩子。
   * @param {Object} plugin - 插件对象
   * @param {string} plugin.id - 插件唯一标识符
   * @param {Function} [plugin.init] - 初始化函数，签名为 (ctx: Object) => void
   * @param {Function} [plugin.destroy] - 销毁函数，签名为 (ctx: Object) => void
   * @returns {PluginManager} 返回 this 以支持链式调用
   * @throws {HarnessError} 插件缺少id、id重复或初始化失败时抛出错误
   */
  register(plugin) {
    this.guardShutdown();
    if (!plugin || !plugin.id) {
      throw new HarnessError('INVALID_PLUGIN', 'Plugin must have an id');
    }
    if (this._plugins.has(plugin.id)) {
      throw new HarnessError('DUPLICATE_PLUGIN', `Plugin '${plugin.id}' is already registered`);
    }
    if (this._plugins.size >= MAX_PLUGINS) {
      throw new HarnessError('CAPACITY_EXCEEDED', 'Maximum plugin count reached: ' + MAX_PLUGINS);
    }

    const ctx = {
      eventBus: this._eventBus,
      hooks: this._hooks,
      registerHook: (hookName, fn) => {
        if (!hookName || typeof hookName !== 'string') return;
        if (DANGEROUS_KEYS.has(hookName)) return;
        if (!this._hooks[hookName]) {
          this._hooks[hookName] = [];
        }
        if (this._hooks[hookName].length >= MAX_HOOKS_PER_NAME) return;
        this._hooks[hookName].push({ pluginId: plugin.id, fn });
      },
    };

    if (typeof plugin.init === 'function') {
      try {
        const initResult = plugin.init(ctx);
        if (initResult && typeof initResult.catch === 'function') {
          const self = this;
          const captureErr = function(err) {
            for (const hookName of Object.keys(self._hooks)) {
              self._hooks[hookName] = self._hooks[hookName].filter(h => h.pluginId !== plugin.id);
            }
            self._plugins.delete(plugin.id);
            debug('PluginManager', 'initAsyncReject', { pluginId: plugin.id, error: err && err.message ? err.message : String(err) });
          };
          initResult.then(function() {
            self._plugins.set(plugin.id, { plugin, ctx });
          }).catch(captureErr);
        } else {
          this._plugins.set(plugin.id, { plugin, ctx });
        }
      } catch (err) {
        for (const hookName of Object.keys(this._hooks)) {
          this._hooks[hookName] = this._hooks[hookName].filter(h => h.pluginId !== plugin.id);
        }
        throw new HarnessError('PLUGIN_INIT_FAILED', `Plugin '${plugin.id}' init failed: ${err && err.message ? err.message : String(err)}`, { cause: err });
      }
    } else {
      this._plugins.set(plugin.id, { plugin, ctx });
    }
    return this;
  }

  /**
   * 注销插件。调用插件的 destroy 方法并移除其注册的所有钩子处理器。
   * @param {string} pluginId - 要注销的插件标识符
   * @returns {boolean} 注销成功返回 true，插件不存在时返回 false
   */
  unregister(pluginId) {
    this.guardShutdown();
    const entry = this._plugins.get(pluginId);
    if (!entry) return false;

    if (typeof entry.plugin.destroy === 'function') {
      safeExecute(() => entry.plugin.destroy(entry.ctx), 'PluginManager', 'destroy');
    }

    for (const hookName of Object.keys(this._hooks)) {
      this._hooks[hookName] = this._hooks[hookName].filter(h => h.pluginId !== pluginId);
    }

    this._plugins.delete(pluginId);
    return true;
  }

  /**
   * 执行指定钩子，按注册顺序链式调用所有处理器。处理器返回值不为 undefined 时覆盖传入数据。
   * @param {string} hookName - 钩子名称
   * @param {*} data - 钩子数据，将依次传递给每个处理器
   * @returns {*} 经过所有处理器处理后的最终数据
   */
  executeHook(hookName, data) {
    try { this.guardShutdown(); } catch (_e) { debug('PluginManager', 'executeHook:guardShutdown', _e && _e.message ? _e.message : String(_e)); return data; }
    const handlers = this._hooks[hookName];
    if (!handlers || handlers.length === 0) return data;

    let result = data;
    for (const handler of handlers) {
      try {
        const returned = handler.fn(result);
        if (returned !== undefined) {
          result = returned;
        }
      } catch (err) {
        debug('PluginManager', 'hook:' + hookName, err);
      }
    }
    return result;
  }

  /**
   * 根据标识符获取插件对象。
   * @param {string} pluginId - 插件标识符
   * @returns {Object|null} 插件对象，不存在时返回 null
   */
  getPlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    return entry ? entry.plugin : null;
  }

  /**
   * 获取所有已注册插件的标识符列表。
   * @returns {string[]} 插件标识符数组
   */
  listPlugins() {
    return Array.from(this._plugins.keys());
  }

  /**
   * 获取钩子注册信息。不指定名称时返回所有钩子的插件ID映射，指定名称时返回该钩子的插件ID数组。
   * @param {string} [hookName] - 钩子名称，省略时返回所有钩子信息
   * @returns {Object<string, string[]>|string[]} 钩子注册信息
   */
  getHooks(hookName) {
    if (!hookName) {
      const result = {};
      for (const name of Object.keys(this._hooks)) {
        result[name] = this._hooks[name].map(h => h.pluginId);
      }
      return result;
    }
    return (this._hooks[hookName] ?? []).map(h => h.pluginId);
  }

  /**
   * 销毁所有已注册插件。依次调用每个插件的 destroy 方法并清空钩子注册表。
   * @returns {void}
   */
  destroy() {
    for (const [id] of this._plugins) {
      this.unregister(id);
    }
    this._hooks = {};
  }

  _onShutdown() {
    for (const [, entry] of this._plugins) {
      if (typeof entry.plugin.destroy === 'function') {
        safeExecute(() => entry.plugin.destroy(entry.ctx), 'PluginManager', 'destroy');
      }
    }
    this._plugins.clear();
    this._hooks = {};
    this.removeAllListeners();
  }

  /**
   * 检查插件管理器是否健康。有插件注册或有钩子处理器时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() { return this._plugins.size > 0 || Object.keys(this._hooks).length > 0; }
}

PluginManager = withShutdown(PluginManager);

module.exports = PluginManager;
