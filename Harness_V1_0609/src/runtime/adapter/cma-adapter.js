'use strict';

/**
 * @module runtime/adapter/cma-adapter
 * CMA Adapter Hub — Central entry point for Claude Managed Agents integration
 *
 * Provides optional cloud-backed capabilities (session backup, secret management,
 * outcomes sync, remote execution) through adapter modules. All features are
 * disabled by default and must be explicitly enabled via config.
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */

const { debug } = require('../../utils/debug-logger');
const safeAssign = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_CMA_CONFIG = {
  enabled: false,
  apiKey: '',
  betaHeader: 'managed-agents-2026-04-01',
  baseUrl: 'https://api.anthropic.com/v1',
  sessionBackup: { enabled: false, autoBackupIntervalMs: 300000 },
  vaultSecret: { enabled: false },
  outcomesBridge: { enabled: false },
  sessionProxy: { enabled: false, defaultModel: 'claude-sonnet-4-6' },
};

/**
 * CMA适配器中心，提供CMA模型服务的统一接入点，管理会话代理、结果桥接和密钥提供
 *
 * @classdesc CMA适配器中心，提供CMA模型服务的统一接入点，管理会话代理、结果桥接和密钥提供
 */
class CMAAdapterHub {
  /**
   * @param {Object} config - 适配器配置
   */
  constructor(config) {
    this._config = safeAssign.mergeConfig(DEFAULT_CMA_CONFIG, config ?? {});
    this._backups = null;
    this._vault = null;
    this._outcomes = null;
    this._proxy = null;
    this._initialized = false;
    this._log = debug('CMAAdapterHub');
  }

  get enabled() { return this._config.enabled; }
  get config() { return { ...this._config }; }

  /**
   * 初始化 CMA 适配器中心，检查是否启用及 API Key 配置
   * @returns {void}
   */
  initialize() {
    if (!this._config.enabled) {
      this._log('initialize', 'CMA integration disabled');
      return;
    }
    if (!this._config.apiKey) {
      this._log('initialize', 'No API key configured, CMA integration disabled');
      return;
    }
    this._initialized = true;
    this._log('initialize', 'CMA adapters initialized');
  }

  /**
   * 获取已绑定的会话备份适配器实例
   * @returns {CloudSessionBackup|null} 会话备份实例，未绑定时返回 null
   */
  getSessionBackup() { return this._backups; }
  /**
   * 获取已绑定的 Vault 密钥提供者实例
   * @returns {VaultSecretProvider|null} 密钥提供者实例，未绑定时返回 null
   */
  getVaultSecret() { return this._vault; }
  /**
   * 获取已绑定的成果桥接适配器实例
   * @returns {CMAOutcomesBridge|null} 成果桥接实例，未绑定时返回 null
   */
  getOutcomesBridge() { return this._outcomes; }
  /**
   * 获取已绑定的会话代理实例
   * @returns {CMASessionProxy|null} 会话代理实例，未绑定时返回 null
   */
  getSessionProxy() { return this._proxy; }

  /**
   * 绑定会话备份适配器
   * @param {CloudSessionBackup} backup - 会话备份适配器实例
   * @returns {CMAAdapterHub} 当前实例（支持链式调用）
   */
  attachSessionBackup(backup) {
    this.guardShutdown();
    this._backups = backup;
    this._log('attachSessionBackup', 'attached');
    return this;
  }

  /**
   * 绑定 Vault 密钥提供者
   * @param {VaultSecretProvider} vault - 密钥提供者实例
   * @returns {CMAAdapterHub} 当前实例（支持链式调用）
   */
  attachVaultSecret(vault) {
    this.guardShutdown();
    this._vault = vault;
    this._log('attachVaultSecret', 'attached');
    return this;
  }

  /**
   * 绑定成果桥接适配器
   * @param {CMAOutcomesBridge} bridge - 成果桥接实例
   * @returns {CMAAdapterHub} 当前实例（支持链式调用）
   */
  attachOutcomesBridge(bridge) {
    this.guardShutdown();
    this._outcomes = bridge;
    this._log('attachOutcomesBridge', 'attached');
    return this;
  }

  /**
   * 绑定会话代理
   * @param {CMASessionProxy} proxy - 会话代理实例
   * @returns {CMAAdapterHub} 当前实例（支持链式调用）
   */
  attachSessionProxy(proxy) {
    this.guardShutdown();
    this._proxy = proxy;
    this._log('attachSessionProxy', 'attached');
    return this;
  }

  /**
   * 获取 CMA 适配器中心的运行状态
   * @returns {{enabled: boolean, initialized: boolean, sessionBackup: boolean, vaultSecret: boolean, outcomesBridge: boolean, sessionProxy: boolean}} 各模块的启用与绑定状态
   */
  getStatus() {
    return {
      enabled: this._config.enabled,
      initialized: this._initialized,
      sessionBackup: !!this._backups,
      vaultSecret: !!this._vault,
      outcomesBridge: !!this._outcomes,
      sessionProxy: !!this._proxy,
    };
  }

  /**
   * 关闭 CMA 适配器中心，释放所有绑定的适配器引用
   */
  _onShutdown() {
    if (this._backups && typeof this._backups.shutdown === 'function') this._backups.shutdown();
    if (this._vault && typeof this._vault.shutdown === 'function') this._vault.shutdown();
    if (this._outcomes && typeof this._outcomes.shutdown === 'function') this._outcomes.shutdown();
    if (this._proxy && typeof this._proxy.shutdown === 'function') this._proxy.shutdown();
    this._backups = null;
    this._vault = null;
    this._outcomes = null;
    this._proxy = null;
    this._initialized = false;
    this._log('shutdown', 'CMA adapters shut down');
    if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
  }
}

CMAAdapterHub.DEFAULT_CONFIG = DEFAULT_CMA_CONFIG;

module.exports = { CMAAdapterHub: withShutdown(CMAAdapterHub), DEFAULT_CMA_CONFIG };
