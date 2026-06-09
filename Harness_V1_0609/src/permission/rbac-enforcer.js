'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseFrontmatter, parseArray, DEFAULT_ENFORCEMENT, FRONTMATTER_TRUE, validateProjectRoot, AGENT_ID_PATTERN, DEFAULT_MIN_HEARTBEAT_MS, UTF8_ENCODING, HARNESS_DIR } = require('../utils/constants');
const { scanMarkdownDirSync } = require('../utils/fs-utils');
const { debug } = require('../utils/debug-logger');
const { withShutdown } = require('../utils/shutdown-mixin');
const { emitError, safeCall, errorMessage } = require('../utils/safe-execute');

/** @constant {number} 最大加载错误数 */
const MAX_LOAD_ERRORS = 200;
/** @constant {number} 最大ID长度 */
const MAX_ID_LENGTH = 128;
/** @constant {number} 最大重载次数 */
const MAX_RELOAD_COUNT = 100;
/** @constant {number} 重载防抖时间（毫秒） */
const RELOAD_DEBOUNCE_MS = 1000;
/** @constant {number} 重载冷却时间（毫秒） */
const COOLDOWN_MS = 30000;

/**
 * 基于角色的访问控制执行器。加载 .harness/agents/ 定义的 * 验证Agent是否有权执行Skill，强制执行strict/recommended/optional分级的 * 验证Skill执行顺序 *
 * @example
 * const enforcer = new RBACEnforcer('/path/to/project');
 * enforcer.load();
 * if (!enforcer.canExecute('team-lead', 'tdd-implement')) {
 *   // permission denied
 * }
 */
/** @constant {Set<string>} 有效的权限键集合 */
const VALID_PERMISSION_KEYS = new Set([
  'can_execute_skills', 'can_write_files', 'can_delete_files',
  'can_execute_commands', 'can_modify_config', 'can_access_sessions',
]);
/** @constant {Set<string>} 有效的执行级别集合 */
const VALID_ENFORCEMENTS = new Set(['strict', 'recommended', 'optional']);
/** @constant {number} 最大文件大小 */
const MAX_FILE_SIZE = 1024 * 1024;
/** @constant {number} 重载冷却时间（毫秒） */
const RELOAD_COOLDOWN_MS = DEFAULT_MIN_HEARTBEAT_MS;

function _parseAgentEntry(agentId, fm, targetAgents, targetSkillSets) {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    debug('RBACEnforcer', '_loadAgents', 'Invalid agent ID format: ' + agentId);
    return null;
  }
  const skills = parseArray(fm.available_skills);
  const permissions = fm.permissions ?? {};
  const safePermissions = {};
  Object.entries(permissions ?? {}).forEach(([k, v]) => {
    if (VALID_PERMISSION_KEYS.has(k)) safePermissions[k] = v;
  });
  targetAgents[agentId] = {
    role: fm.role || agentId,
    skills: skills,
    auto_route: fm.auto_route === FRONTMATTER_TRUE || fm.auto_route === true,
    tdd_enforced: fm.tdd_enforced === FRONTMATTER_TRUE || fm.tdd_enforced === true,
    collaborates_with: parseArray(fm.collaborates_with),
    manages: parseArray(fm.manages),
    model: fm.model || '',
    level: fm.level || '',
    permissions: safePermissions,
  };
  targetSkillSets[agentId] = new Set(skills);
  return agentId;
}

function _parseSkillEntry(skillId, fm, targetSkills) {
  const isInfra = fm.component_id !== undefined;
  targetSkills[skillId] = {
    skill_id: isInfra ? fm.component_id : skillId,
    enforcement: VALID_ENFORCEMENTS.has(fm.enforcement) ? fm.enforcement : DEFAULT_ENFORCEMENT,
    depends_on: parseArray(fm.depends_on),
    applicable_agents: parseArray(fm.applicable_agents),
    phase: fm.phase || '',
    priority: typeof fm.priority === 'number' && Number.isFinite(fm.priority) ? fm.priority : (function() { const p = parseInt(fm.priority, 10); return Number.isFinite(p) ? p : 0; })(),
  };
  return skillId;
}

/**
 * @module permission/rbac-enforcer
 * 基于角色的访问控制。strict/recommended/optional分级，Skill执行顺序验证，
 * 加载.harness/agents/定义验证Agent是否有权执行Skill。
 */

/**
 * @classdesc 基于角色的访问控制执行器。strict/recommended/optional分级
 */
class RBACEnforcer extends EventEmitter {
  /**
   * 创建RBACEnforcer实例。
   * @param {string} projectRoot - 项目根目录路径
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'RBACEnforcer');
    this.root = projectRoot;
    this._agentsDir = path.join(projectRoot, HARNESS_DIR, 'agents');
    this._skillsDir = path.join(projectRoot, HARNESS_DIR, 'skills');
    this.agents = {};
    this.skills = {};
    this._agentSkillSets = {};
    this._loadErrors = [];
    this._maxLoadErrors = MAX_LOAD_ERRORS;
    this._watchers = [];
    this._reloadTimer = null;
    this._reloadCount = 0;
  }

  /**
   * 从 .harness/agents/ 和 .harness/skills/ 加载权限定义   * @returns {{ agentsLoaded: number, skillsLoaded: number, errors: number }} 加载结果统计
   */
  load() {
    this.guardShutdown();
    if (this._loading) return { agentsLoaded: 0, skillsLoaded: 0, errors: 0, busy: true };
    this._loading = true;
    this._loadErrors = [];
    try {
      const newAgents = {};
      const newAgentSkillSets = {};
      const newSkills = {};
      const agentsLoaded = this._loadAgentsInto(newAgents, newAgentSkillSets);
      const skillsLoaded = this._loadSkillsInto(newSkills);
      if (this._loadErrors.length === 0) {
        this.agents = newAgents;
        this._agentSkillSets = newAgentSkillSets;
        this.skills = newSkills;
      } else {
        debug('RBACEnforcer', 'loadFailedKeepOld', { errors: this._loadErrors.length });
      }
      const result = { agentsLoaded, skillsLoaded, errors: this._loadErrors.length, busy: false };
      if (this._loadErrors.length > 0) {
        debug('RBACEnforcer', 'loadWarnings', `${this._loadErrors.length} load error(s):`, this._loadErrors);
        this.emit('load-warnings', this._loadErrors);
      }
      return result;
    } finally {
      this._loading = false;
    }
  }

  /**
   * 记录加载错误，超过最大错误数时丢弃。
   * @param {Object} errorEntry - 错误条目
   * @private
   */
  _addLoadError(errorEntry) {
    if (this._loadErrors.length >= this._maxLoadErrors) return;
    this._loadErrors.push(errorEntry);
  }

  /**
   * 获取指定Agent的模型名称。
   * @param {string} agentId - Agent角色ID
   * @returns {string} 模型名称，未找到返回空字符串
   */
  getAgentModel(agentId) {
    const agent = this.agents[agentId];
    return agent ? agent.model || '' : '';
  }

  /**
   * 检查Agent是否有权执行指定Skill   * @param {string} agentId - Agent角色ID
   * @param {string} skillId - Skill ID
   * @returns {boolean} 是否允许执行
   */
  canExecute(agentId, skillId) {
    if (!agentId || !skillId || typeof agentId !== 'string' || typeof skillId !== 'string') return false;
    if (/[\/\\:\*\?"<>\|]/.test(agentId) || /[\/\\:\*\?"<>\|]/.test(skillId)) return false;
    if (agentId.length > MAX_ID_LENGTH || skillId.length > MAX_ID_LENGTH) return false;
    const skillSet = this._agentSkillSets[agentId];
    if (!skillSet || !skillSet.has(skillId)) return false;
    const skillDef = this.skills[skillId];
    if (!skillDef) return false;
    const applicable = skillDef.applicable_agents;
    if (Array.isArray(applicable) && applicable.length > 0 && !applicable.includes(agentId)) {
      debug('RBACEnforcer', 'canExecute', 'Bidirectional check failed: skill ' + skillId + ' does not declare agent ' + agentId + ' as applicable');
      return false;
    }
    return true;
  }

  /**
   * 从目录加载定义文件（Agent或Skill）。
   * @param {string} dirPath - 目录路径
   * @param {string} phase - 加载阶段标识
   * @param {Function} parseEntry - 条目解析函数
   * @returns {number} 成功加载的条目数
   * @private
   */
  _loadDefinitionsFromDir(dirPath, phase, parseEntry) {
    if (!fs.existsSync(dirPath)) return 0;
    let count = 0;
    try {
      const files = scanMarkdownDirSync(dirPath);
      for (const file of files) {
        try {
          const contentPath = path.join(dirPath, file);
          const content = fs.readFileSync(contentPath, UTF8_ENCODING);
          if (content.length > MAX_FILE_SIZE) {
            this._addLoadError({ phase, file, error: `File too large: ${content.length} bytes` });
            continue;
          }
          const fm = parseFrontmatter(content);
          if (!fm) {
            if (phase === 'agents') this._addLoadError({ phase, file: contentPath, error: 'Failed to parse frontmatter' });
            continue;
          }
          const id = file.replace(/\.md$/, '');
          const result = parseEntry(id, fm);
          if (result) count++;
        } catch (err) {
          this._addLoadError({ phase, file, error: errorMessage(err) });
          debug('RBACEnforcer', '_loadDefinitionsFromDir', err);
        }
      }
    } catch (err) {
      this._addLoadError({ phase: phase + '_dir', file: dirPath, error: errorMessage(err) });
      debug('RBACEnforcer', '_loadDefinitionsFromDir', err);
    }
    return count;
  }

  /**
   * 加载Agent定义到目标对象。
   * @param {Object} targetAgents - 目标Agent映射
   * @param {Object} targetSkillSets - 目标Skill集合映射
   * @returns {number} 成功加载的Agent数
   * @private
   */
  _loadAgentsInto(targetAgents, targetSkillSets) {
    return this._loadDefinitionsFromDir(this._agentsDir, 'agents', (agentId, fm) => _parseAgentEntry(agentId, fm, targetAgents, targetSkillSets));
  }

  /**
   * 加载Skill定义到目标对象。
   * @param {Object} targetSkills - 目标Skill映射
   * @returns {number} 成功加载的Skill数
   * @private
   */
  _loadSkillsInto(targetSkills) {
    return this._loadDefinitionsFromDir(this._skillsDir, 'skills', (skillId, fm) => _parseSkillEntry(skillId, fm, targetSkills));
  }

  /**
   * 启动文件监视器，监控Agent和Skill定义文件变更并自动热重载。
   * @emits RBACEnforcer#watching-started
   * @returns {void}
   */
  startWatching() {
    this.guardShutdown();
    if (!this.isReady() || this._watchers.length > 0) return;
    const dirs = [
      this._agentsDir,
      this._skillsDir,
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      safeCall(() => {
        const watcher = fs.watch(dir, (eventType, filename) => {
          if (this._shutDown) return;
          if (!filename || !filename.endsWith('.md')) return;
          try { this._scheduleReload(eventType, filename); }
          catch (e) { debug('RBACEnforcer', 'watchCallbackError', e); }
        });
        watcher.on('error', (err) => {
          debug('RBACEnforcer', 'watcherError', err);
          const idx = this._watchers.indexOf(watcher);
          if (idx !== -1) this._watchers.splice(idx, 1);
          try { if (typeof watcher.close === 'function') watcher.close(); } catch (closeErr) { debug('RBACEnforcer', 'watcherCloseError', closeErr); }
        });
        this._watchers.push(watcher);
      }, 'RBACEnforcer', 'startWatching');
    }
    if (this._watchers.length > 0) {
      this.emit('watching-started', { directories: dirs.length });
    }
  }

  /**
   * 停止文件监视器和重载定时器。
   * @returns {void}
   */
  stopWatching() {
    this._watchers.forEach(watcher => {
      if (typeof watcher.removeAllListeners === 'function') {
        watcher.removeAllListeners();
      }
      safeCall(() => watcher.close(), 'RBACEnforcer', 'watcher close');
    });
    this._watchers = [];
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    if (this._cooldownTimer) {
      clearTimeout(this._cooldownTimer);
      this._cooldownTimer = null;
    }
  }

  _scheduleReload(eventType, filename) {
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      if (this._shutDown) return;
      this._hotReload(eventType, filename);
    }, RELOAD_DEBOUNCE_MS);
    if (this._reloadTimer && typeof this._reloadTimer.unref === 'function') {
      this._reloadTimer.unref();
    }
  }

  _hotReload(eventType, filename) {
    if (!this.isHealthy()) return;
    const now = Date.now();
    if (this._lastReloadAt && (now - this._lastReloadAt) < RELOAD_COOLDOWN_MS) {
      this._scheduleReload(eventType, filename);
      return;
    }
    this._lastReloadAt = now;
    this._reloadCount = (typeof this._reloadCount === 'number' && Number.isFinite(this._reloadCount) ? this._reloadCount : 0) + 1;
    if (this._reloadCount > MAX_RELOAD_COUNT) {
      debug('RBACEnforcer', 'hotReload', 'Reload count exceeded 100 in this session - pausing watcher for cooldown');
      this._reloadCount = 0;
      this.stopWatching();
      this.emit('reload-stopped', { reason: 'too_many_reloads' });
      this._cooldownTimer = setTimeout(() => {
        if (!this.isHealthy()) return;
        this._cooldownTimer = null;
        this.startWatching();
        this.emit('watcher-resumed', { reason: 'cooldown_expired' });
      }, COOLDOWN_MS);
      if (this._cooldownTimer && typeof this._cooldownTimer.unref === 'function') this._cooldownTimer.unref();
      return;
    }
    try {
      const previousAgentCount = Object.keys(this.agents).length;
      const previousSkillCount = Object.keys(this.skills).length;
      const result = this.load();
      const changed = result.agentsLoaded !== previousAgentCount || result.skillsLoaded !== previousSkillCount;
      if (changed) {
        this.emit('permissions-reloaded', {
          eventType,
          filename,
          agentsLoaded: result.agentsLoaded,
          skillsLoaded: result.skillsLoaded,
          errors: result.errors,
        });
      }
    } catch (err) {
      emitError(this, 'reload-error', err, { filename });
    }
  }

  /**
   * 检查RBAC执行器健康状态。
   * @returns {boolean} 未关闭且已加载Agent或Skill定义时返回true
   */
  isHealthy() {
    return !this._shutDown;
  }

  /**
   * 检查RBAC执行器是否已就绪（未关闭且已加载Agent或Skill定义）。
   * @returns {boolean} 未关闭且已加载数据时返回true
   */
  isReady() {
    return !this._shutDown && (Object.keys(this.agents).length > 0 || Object.keys(this.skills).length > 0);
  }

  /**
   * 关闭时清理所有数据和监视器。
   * @private
   */
  _onShutdown() {
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
    this.stopWatching();
    this.agents = {};
    this.skills = {};
    this._agentSkillSets = {};
    this._loadErrors = [];
    this.removeAllListeners();
  }
}

/**
 * @typedef {Object} AgentPermissions
 * @property {string} role - Agent角色名称
 * @property {string[]} skills - 可用的Skill ID列表
 * @property {boolean} auto_route - 是否启用自动路由
 * @property {boolean} tdd_enforced - 是否强制TDD
 * @property {string[]} collaborates_with - 协作的Agent列表
 * @property {string[]} manages - 管理的Agent列表
 */

/**
 * @typedef {Object} SkillEnforcementDef
 * @property {string} skill_id - Skill ID
 * @property {'strict'|'recommended'|'optional'} enforcement - 执行级别
 * @property {string[]} depends_on - 依赖的Skill列表
 * @property {string[]} applicable_agents - 适用的Agent列表
 * @property {string} phase - 所属阶段 * @property {number} priority - 优先级 */

module.exports = withShutdown(RBACEnforcer);
