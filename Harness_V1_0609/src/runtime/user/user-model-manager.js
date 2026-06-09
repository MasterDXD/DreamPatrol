'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeJsonParse } = require('../../utils/safe-parse');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { ensureArray } = require('../../utils/safe-execute');

const MAX_PET_PEEVES = 50;
const MAX_TECH_STACK = 50;

const USER_SCHEMA = {
  name: { type: 'string', description: '用户名称' },
  role: { type: 'string', description: '角色/职位' },
  timezone: { type: 'string', description: '时区' },
  codingPrefs: { type: 'object', description: '编码偏好' },
  commStyle: { type: 'string', description: '沟通风格偏好' },
  petPeeves: { type: 'array', description: '不喜欢的事物' },
  projectContext: { type: 'string', description: '项目上下文' },
  techStack: { type: 'array', description: '技术栈偏好' },
};

const INJECTION_TEMPLATE = `══════════════════════════════════════════════
用户画像 [USER PROFILE]
══════════════════════════════════════════════`;

/**
 * @module runtime/user/user-model-manager
 * UserModelManager — User preference learning and behavioral modeling
 * Manages user profile storage via SQLite, preference get/set operations, and generates
 * injectable profile context for AI interactions. Tracks interaction history for adaptation.
 * @classdesc 用户模型管理器。偏好学习、行为建模
 * @extends EventEmitter
 * @emits UserModelManager#preference-set
 * @emits UserModelManager#preference-removed
 * @emits UserModelManager#profile-injected
 * @emits UserModelManager#interaction-learned
 */
class UserModelManager extends EventEmitter {
  constructor(options) {
    super();
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._eventBus = (options && options.eventBus) ?? null;
    this._stats = { preferencesSet: 0, preferencesGet: 0, profilesInjected: 0, interactionsLearned: 0 };
  }

  /**
   * 附加SQLite存储实例，用于用户偏好持久化
   * @param {object} store - SQLite存储实例
   * @returns {UserModelManager} 返回this以支持链式调用
   */
  attachSqliteStore(store) {
    this.guardShutdown();
    this._sqliteStore = store;
    return this;
  }

  /**
   * 附加事件总线实例，用于发射用户纠正事件
   * @param {object} bus - 事件总线实例
   * @returns {UserModelManager} 返回this以支持链式调用
   */
  attachEventBus(bus) {
    this.guardShutdown();
    this._eventBus = bus;
    return this;
  }

  /**
   * 设置用户偏好键值对
   * @param {string} key - 偏好键名
   * @param {*} value - 偏好值
   * @returns {boolean} 设置成功返回true，无存储或异常返回false
   */
  setPreference(key, value) {
    this.guardShutdown();
    if (!this._sqliteStore) return false;
    if (!key || typeof key !== 'string' || key.length > 256) return false;
    try {
      this._sqliteStore.setUserPreference(key, value);
      this._stats.preferencesSet++;
      this.emit('preference-set', { key, value });
      return true;
    } catch (err) {
      debug('UserModelManager', 'setPreference', err && err.message ? err.message : String(err));
      return false;
    }
  }

  /**
   * 获取指定键的用户偏好值，自动尝试JSON解析
   * @param {string} key - 偏好键名
   * @returns {*|null} 偏好值，未找到或异常返回null
   */
  getPreference(key) {
    this.guardShutdown();
    if (!this._sqliteStore) return null;
    try {
      this._stats.preferencesGet++;
      const raw = this._sqliteStore.getUserPreference(key);
      if (raw === null) return null;
      try { return safeJsonParse(raw, raw, 'UserModelManager'); } catch (e) { debug('UserModelManager', 'getPreference parse', e); return raw; }
    } catch (err) {
      debug('UserModelManager', 'getPreference', err && err.message ? err.message : String(err));
      return null;
    }
  }

  /**
   * 获取所有用户偏好键值对
   * @returns {object} 偏好对象，键为偏好名，值为解析后的偏好值；无存储或异常返回空对象
   */
  getAllPreferences() {
    this.guardShutdown();
    if (!this._sqliteStore) return {};
    try {
      const rows = this._sqliteStore.getAllUserPreferences();
      const prefs = {};
      for (const r of rows) {
        if (r.key === '__proto__' || r.key === 'constructor' || r.key === 'prototype') continue;
        try { prefs[r.key] = safeJsonParse(r.value, r.value, 'UserModelManager'); } catch (e) { debug('UserModelManager', 'getAllPreferences parse', e); prefs[r.key] = r.value; }
      }
      return prefs;
    } catch (err) {
      debug('UserModelManager', 'getAllPreferences', err && err.message ? err.message : String(err));
      return {};
    }
  }

  /**
   * 删除指定键的用户偏好
   * @param {string} key - 偏好键名
   * @returns {boolean} 删除成功返回true，无存储或异常返回false
   */
  removePreference(key) {
    this.guardShutdown();
    if (!this._sqliteStore) return false;
    try {
      this._sqliteStore.removeUserPreference(key);
      this.emit('preference-removed', { key });
      return true;
    } catch (err) {
      debug('UserModelManager', 'removePreference', err && err.message ? err.message : String(err));
      return false;
    }
  }

  _getArrayPreference(key) {
    const val = this.getPreference(key);
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    try {
      const parsed = typeof val === 'string' ? safeJsonParse(val, val, 'UserModelManager') : val;
      return ensureArray(parsed);
    } catch (e) { debug('UserModelManager', '_getArrayPreference parse', e); return []; }
  }

  /**
   * 从交互中学习用户偏好，自动提取纠正、语言选择、沟通风格、技术栈、编码风格、项目上下文、时区等信息
   * @param {object} interaction - 交互对象，可包含correction、languageChoice、commStyle、techStack、codingStyle、projectContext、timezone字段
   * @returns {boolean} 学习成功返回true，无存储返回false
   */
  learnFromInteraction(interaction) {
    this.guardShutdown();
    if (!this._sqliteStore) return false;
    if (!interaction || typeof interaction !== 'object') return false;
    const i = interaction;

    if (i.correction) {
      const existing = this._getArrayPreference('petPeeves');
      const existingSet = new Set(existing);
      if (!existingSet.has(i.correction)) {
        existing.push(i.correction);
        if (existing.length > MAX_PET_PEEVES) existing.splice(0, existing.length - MAX_PET_PEEVES);
        this.setPreference('petPeeves', existing);
      }
      if (this._eventBus && typeof this._eventBus.emit === 'function') {
        this._eventBus.emit('user:correction', { correction: i.correction });
      }
    }

    if (i.languageChoice) {
      this.setPreference('preferredLanguage', i.languageChoice);
    }

    if (i.commStyle) {
      this.setPreference('commStyle', i.commStyle);
    }

    if (i.techStack && Array.isArray(i.techStack)) {
      const existing = this._getArrayPreference('techStack');
      const existingSet = new Set(existing);
      for (const t of i.techStack) {
        if (!existingSet.has(t)) { existing.push(t); existingSet.add(t); }
      }
      if (existing.length > MAX_TECH_STACK) existing.splice(0, existing.length - MAX_TECH_STACK);
      this.setPreference('techStack', existing);
    }

    if (i.codingStyle) {
      this.setPreference('codingPrefs', i.codingStyle);
    }

    if (i.projectContext) {
      this.setPreference('projectContext', i.projectContext);
    }

    if (i.timezone) {
      this.setPreference('timezone', i.timezone);
    }

    this._stats.interactionsLearned++;
    this.emit('interaction-learned', { type: Object.keys(i).filter(k => i[k]).join(',') });
    return true;
  }

  /**
   * 构建用户画像注入提示词，按Schema定义顺序格式化所有偏好为可注入AI上下文的文本
   * @returns {string} 用户画像提示词文本，无偏好时返回空字符串
   */
  buildInjectionPrompt() {
    this.guardShutdown();
    if (!this._sqliteStore) return '';
    const prefs = this.getAllPreferences();
    if (Object.keys(prefs).length === 0) return '';

    this._stats.profilesInjected++;
    const lines = [INJECTION_TEMPLATE];

    const schemaOrder = Object.keys(USER_SCHEMA);
    const schemaOrderSet = new Set(schemaOrder);
    const orderedKeys = schemaOrder.filter(k => prefs[k] !== undefined);
    const remainingKeys = Object.keys(prefs).filter(k => !schemaOrderSet.has(k));

    const formatValue = (value) => {
      if (value == null) return '—';
      if (Array.isArray(value)) return value.join(', ');
      if (typeof value === 'object' && value !== null) return JSON.stringify(value);
      return String(value);
    };

    for (const key of orderedKeys) {
      const value = prefs[key];
      const val = formatValue(value);
      const desc = USER_SCHEMA[key] ? USER_SCHEMA[key].description : key;
      lines.push(`  ${desc}: ${val}`);
    }
    for (const key of remainingKeys) {
      const value = prefs[key];
      const val = formatValue(value);
      lines.push(`  ${key}: ${val}`);
    }

    lines.push('══════════════════════════════════════════════');

    this.emit('profile-injected', { keyCount: Object.keys(prefs).length });
    return lines.join('\n');
  }

  /**
   * 获取用户模型Schema定义
   * @returns {object} Schema对象的浅拷贝，键为偏好名，值为包含type和description的对象
   */
  getSchema() {
    const copy = {};
    for (const [key, val] of Object.entries(USER_SCHEMA)) {
      copy[key] = { ...val };
    }
    return copy;
  }

  /**
   * 获取用户模型管理器的统计信息
   * @returns {object} 统计对象，包含preferencesSet、preferencesGet、profilesInjected、interactionsLearned、hasStore字段
   */
  getStats() {
    return { ...this._stats, hasStore: !!this._sqliteStore };
  }

  /**
   * 检查用户模型管理器是否健康，未关闭且存储可用即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return this._shutDown !== true && (!this._sqliteStore || (typeof this._sqliteStore.isHealthy === 'function' && this._sqliteStore.isHealthy()));
  }

  _onShutdown() {
    this._sqliteStore = null;
    this._eventBus = null;
    this._stats = { preferencesSet: 0, preferencesGet: 0, profilesInjected: 0, interactionsLearned: 0 };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(UserModelManager);
