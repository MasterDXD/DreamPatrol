'use strict';

/**
 * @module runtime/deepening/deepening-security-guard
 * 深化推理安全守卫。基于Agent白名单、Aho-Corasick自动机的禁止模式检测和每次执行的Agent调用限制，
 * 验证管道配置，在遇到未授权Agent或禁止模式时抛出安全违规异常。
 */

const DeepeningBase = require('./deepening-base');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const { HarnessError, DeepeningError } = require('../../errors');
const { safeCall } = require('../../utils/safe-execute');

/**
 * Aho-Corasick自动机节点。表示Trie树中的一个节点，包含子节点映射、失败指针和匹配输出。
 * @private
 */
class _ACNode {
  constructor() {
    this.children = {};
    this.fail = null;
    this.output = [];
  }
}

/**
 * Aho-Corasick多模式字符串匹配自动机。支持批量添加模式串并构建失败指针，
 * 在单次扫描中高效匹配文本中的所有模式串。
 * @private
 */
class _AhoCorasick {
  /**
   * 创建Aho-Corasick自动机实例。
   */
  constructor() {
    this._root = new _ACNode();
    this._built = false;
    this._patternCount = 0;
  }

  /**
   * 向自动机中添加一个模式串。
   * @param {string} pattern - 要添加的模式串
   */
  addPattern(pattern) {
    if (typeof pattern !== 'string' || pattern.length === 0) return;
    let node = this._root;
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (!node.children[ch]) node.children[ch] = new _ACNode();
      node = node.children[ch];
    }
    node.output.push(pattern);
    this._built = false;
    this._patternCount++;
  }

  /**
   * 构建失败指针。使用BFS遍历Trie树，为每个节点设置失败指针并合并输出。
   * @private
   */
  _build() {
    if (this._built) return;
    const queue = [];
    this._root.fail = this._root;
    for (const ch of Object.keys(this._root.children)) {
      this._root.children[ch].fail = this._root;
      queue.push(this._root.children[ch]);
    }
    while (queue.length > 0) {
      const current = queue.shift();
      for (const ch of Object.keys(current.children)) {
        const child = current.children[ch];
        let fail = current.fail;
        let safetyCounter = 0;
        while (fail !== this._root && !fail.children[ch]) {
          fail = fail.fail;
          if (++safetyCounter > 1000) break;
        }
        child.fail = fail.children[ch] || this._root;
        if (child.fail === child) child.fail = this._root;
        child.output = child.output.concat(child.fail.output);
        queue.push(child);
      }
    }
    this._built = true;
  }

  /**
   * 在文本中搜索所有匹配的模式串。
   * @param {string} text - 要搜索的文本
   * @returns {string[]} 匹配到的模式串列表
   */
  search(text) {
    if (typeof text !== 'string') return [];
    this._build();
    const matches = [];
    let node = this._root;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let safetyCounter = 0;
      while (node !== this._root && !node.children[ch]) {
        node = node.fail;
        if (++safetyCounter > 1000) { node = this._root; break; }
      }
      node = node.children[ch] || this._root;
      for (let j = 0; j < node.output.length; j++) {
        matches.push(node.output[j]);
      }
    }
    return matches;
  }

  get patternCount() { return this._patternCount; }
}

/**
 * 禁止模式最大数量限制
 * @constant {number}
 */
const MAX_FORBIDDEN_PATTERNS = 200;

/**
 * 允许Agent最大数量限制
 * @constant {number}
 */
const MAX_ALLOWED_AGENTS = 500;

/**
 * 深化推理安全守卫。基于Agent白名单、Aho-Corasick自动机的禁止模式检测和每次执行的Agent调用限制，
 * 验证管道配置，在遇到未授权Agent或禁止模式时抛出安全违规异常。
 *
 * @classdesc 深化安全守卫。权限检查、输入消毒、速率限制。
 * @extends DeepeningBase
 */
class DeepeningSecurityGuard extends DeepeningBase {

  /**
   * 创建 DeepeningSecurityGuard 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxExecutions=200] - 最大执行跟踪数量
   * @param {number} [options.maxAgentCallsPerExecution=100] - 每次执行允许的Agent调用次数上限
   */
  constructor(options) {
    super(options);
    this._allowedAgents = new Set();
    this._forbiddenPatterns = [];
    this._ac = new _AhoCorasick();
    this._executions = new BoundedMap((options && options.maxExecutions) ?? 200);
    this._maxAgentCallsPerExecution = (options && options.maxAgentCallsPerExecution) ?? 100;
    this._maxPatternLength = 256;
  }

  /**
   * 验证管道配置。检查配置对象是否包含有效的agents数组。
   * @param {Object} config - 管道配置对象
   * @param {string[]} config.agents - Agent名称数组
   * @returns {boolean} 验证通过返回 true
   * @throws {DeepeningError} 配置无效时抛出异常
   */
  validatePipelineConfig(config) {
    if (!config || !config.agents) throw new DeepeningError('MISSING_PARAMETER', 'agents required');
    if (!Array.isArray(config.agents)) throw new DeepeningError('INVALID_INPUT', 'agents must be an array');
    if (config.agents.length === 0) throw new DeepeningError('INVALID_INPUT', 'agents array must not be empty');
    for (const agent of config.agents) {
      if (typeof agent !== 'string' || agent.length > 128) throw new DeepeningError('INVALID_INPUT', 'agent name must be a string (max 128 chars)');
    }
    return true;
  }

  /**
   * 验证Agent执行权限。检查Agent是否在白名单中，默认拒绝策略。
   * @param {string} agentId - Agent标识
   * @param {Object} [_context] - 执行上下文（保留参数）
   * @returns {boolean} 验证通过返回 true
   * @throws {HarnessError} Agent未授权时抛出安全违规异常
   */
  validateAgentExecution(agentId, _context) {
    if (!agentId || typeof agentId !== 'string') {
      throw new HarnessError('SECURITY_VIOLATION', 'Invalid agent ID');
    }
    if (this._allowedAgents.size === 0) {
      throw new HarnessError('SECURITY_VIOLATION', 'No allowed agents configured — deny by default');
    }
    if (!this._allowedAgents.has(agentId)) {
      throw new HarnessError('SECURITY_VIOLATION', 'Agent not allowed: ' + agentId);
    }
    return true;
  }

  /**
   * 添加允许的Agent到白名单。超出上限时淘汰最早的条目。
   * @param {string} agentId - Agent标识（最长128字符）
   * @returns {boolean} 添加成功返回 true，参数无效返回 false
   */
  addAllowedAgent(agentId) {
    this.guardShutdown();
    if (!agentId || typeof agentId !== 'string') return false;
    if (agentId.length > 128) return false;
    if (this._allowedAgents.size >= MAX_ALLOWED_AGENTS) {
      const oldest = this._allowedAgents.values().next().value;
      this._allowedAgents.delete(oldest);
    }
    this._allowedAgents.add(agentId);
    return true;
  }

  /**
   * 添加禁止模式。超出上限时淘汰最早的模式并重建自动机。
   * @param {string} pattern - 禁止模式字符串（最长256字符）
   * @returns {boolean} 添加成功返回 true，参数无效返回 false
   */
  addForbiddenPattern(pattern) {
    this.guardShutdown();
    if (!pattern || typeof pattern !== 'string') return false;
    if (pattern.length > this._maxPatternLength) return false;
    if (this._forbiddenPatterns.length >= MAX_FORBIDDEN_PATTERNS) {
      this._forbiddenPatterns.shift();
      this._ac = new _AhoCorasick();
      for (const p of this._forbiddenPatterns) {
        this._ac.addPattern(p);
      }
    }
    this._forbiddenPatterns.push(pattern);
    this._ac.addPattern(pattern);
    return true;
  }

  /**
   * 检查数据中是否包含禁止模式。使用Aho-Corasick自动机进行高效多模式匹配。
   * @param {string|Object} data - 要检查的数据，字符串或可序列化对象
   * @returns {boolean} 未检测到禁止模式返回 false
   * @throws {HarnessError} 检测到禁止模式时抛出安全违规异常
   */
  checkForbiddenPatterns(data) {
    let str;
    if (typeof data === 'string') {
      str = data;
    } else if (data && typeof data === 'object' && data !== null) {
      try { str = JSON.stringify(data); } catch (_e) {
        debug('DeepeningSecurityGuard', 'stringify', _e && _e.message ? _e.message : String(_e));
        const parts = [];
        try {
          const keys = Object.keys(data);
          for (let ki = 0; ki < keys.length; ki++) {
            const v = data[keys[ki]];
            if (typeof v === 'string') { parts.push(v); }
            else if (v != null && typeof v === 'object') { try { parts.push(JSON.stringify(v)); } catch (_ee) { parts.push('[unserializable]'); } }
          }
        } catch (_ek) {
          debug('DeepeningSecurityGuard', 'fallbackIterError', _ek && _ek.message ? _ek.message : String(_ek));
        }
        str = parts.join(' ');
      }
    } else {
      str = String(data ?? '');
    }
    if (this._forbiddenPatterns.length === 0) return false;
    const matches = this._ac.search(str);
    if (matches.length > 0) {
      throw new HarnessError('SECURITY_VIOLATION', 'Forbidden pattern detected: ' + matches[0]);
    }
    return false;
  }

  /**
   * 开始执行跟踪。记录执行开始时间和Agent调用计数。
   * @param {string} executionId - 执行标识
   * @returns {boolean} 开始成功返回 true，参数无效返回 false
   */
  startExecution(executionId) {
    this.guardShutdown();
    if (!executionId || typeof executionId !== 'string') return false;
    this._executions.set(executionId, { startTime: Date.now(), agentCalls: 0 });
    return true;
  }

  /**
   * 更新执行跟踪。递增Agent调用计数，超出限制时发出事件。
   * @param {string} executionId - 执行标识
   * @returns {boolean} 更新成功返回 true，超出限制或执行不存在返回 false
   * @emits 'execution-limit-exceeded' 当Agent调用次数超过限制时触发
   */
  updateExecution(executionId) {
    this.guardShutdown();
    const e = this._executions.get(executionId);
    if (!e) return false;
    e.agentCalls++;
    if (e.agentCalls > this._maxAgentCallsPerExecution) {
      this.emit('execution-limit-exceeded', { executionId, agentCalls: e.agentCalls });
      return false;
    }
    return true;
  }

  /**
   * 记录Agent调用。委托给 updateExecution 方法。
   * @param {string} executionId - 执行标识
   * @returns {boolean} 记录成功返回 true，超出限制返回 false
   */
  recordAgentCall(executionId) { return this.updateExecution(executionId); }

  /**
   * 结束执行跟踪。记录结束时间并从跟踪映射中移除。
   * @param {string} executionId - 执行标识
   * @returns {boolean} 始终返回 true
   */
  endExecution(executionId) {
    const e = this._executions.get(executionId);
    if (e) {
      e.endTime = Date.now();
      this._executions.delete(executionId);
    }
    return true;
  }

  /**
   * 获取执行统计信息。
   * @param {string} executionId - 执行标识
   * @returns {Object|undefined} 执行统计对象，包含 startTime、agentCalls 等
   */
  getExecutionStats(executionId) { return this._executions.get(executionId) ?? null; }

  /**
   * 启动周期性安全检查（占位方法）。
   * @returns {boolean} 始终返回 true
   */
  startPeriodicCheck() { return true; }

  /**
   * 停止周期性安全检查（占位方法）。
   * @returns {boolean} 始终返回 true
   */
  stopPeriodicCheck() { return true; }

  /**
   * 获取安全守卫统计信息。
   * @returns {Object} 统计对象，包含 allowedAgents、forbiddenPatterns、activeExecutions 等
   */
  getStats() {
    return { allowedAgents: this._allowedAgents.size, forbiddenPatterns: this._forbiddenPatterns.length, activeExecutions: this._executions.size, ...super.getStats() };
  }

  /**
   * 关闭时清理所有安全守卫状态。
   * @protected
   */
  _onShutdown() {
    this._allowedAgents.clear();
    this._forbiddenPatterns = [];
    this._ac = new _AhoCorasick();
    safeCall(() => this._executions.shutdown(), 'DeepeningSecurityGuard', 'shutdown-executions');
    super._onShutdown();
  }
}

module.exports = DeepeningSecurityGuard;
