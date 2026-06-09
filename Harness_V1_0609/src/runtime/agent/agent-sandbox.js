'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { DANGEROUS_KEYS, validateAgentId, validateProjectRoot, DEFAULT_SUBAGENT_TIMEOUT_MS, DEFAULT_PIPELINE_TIMEOUT_MS, HARNESS_DIR } = require('../../utils/constants');
const { AgentError } = require('../../errors');
const BoundedArray = require('../../utils/bounded-array');
const safeAssign = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const { validatePath: validatePathSecurity } = require('../../utils/path-utils');

const MAX_SANDBOXES = 50;
const MAX_CUSTOM_POLICIES = 100;
const DEFAULT_SANDBOX_STRICT_TIMEOUT_MS = 30000;

const SANDBOX_LEVELS = {
  STRICT: 'strict',
  MODERATE: 'moderate',
  PERMISSIVE: 'permissive',
};

const SANDBOX_LEVELS_SET = new Set(Object.values(SANDBOX_LEVELS));

const DEFAULT_POLICIES = {
  [SANDBOX_LEVELS.STRICT]: {
    allowFileSystem: false,
    allowNetwork: false,
    allowChildProcess: false,
    allowEnvAccess: false,
    maxMemoryMB: 128,
    maxCpuPercent: 30,
    maxExecutionTimeMs: DEFAULT_SANDBOX_STRICT_TIMEOUT_MS,
    allowedModules: [],
    blockedModules: ['child_process', 'fs', 'net', 'http', 'https', 'dgram', 'cluster', 'os'],
    allowWriteFiles: false,
    allowReadFiles: false,
  },
  [SANDBOX_LEVELS.MODERATE]: {
    allowFileSystem: true,
    allowNetwork: false,
    allowChildProcess: false,
    allowEnvAccess: true,
    maxMemoryMB: 256,
    maxCpuPercent: 50,
    maxExecutionTimeMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    allowedModules: ['path', 'url', 'querystring', 'crypto', 'util', 'events'],
    blockedModules: ['child_process', 'cluster'],
    allowWriteFiles: false,
    allowReadFiles: true,
  },
  [SANDBOX_LEVELS.PERMISSIVE]: {
    allowFileSystem: true,
    allowNetwork: true,
    allowChildProcess: true,
    allowEnvAccess: true,
    maxMemoryMB: 512,
    maxCpuPercent: 80,
    maxExecutionTimeMs: DEFAULT_PIPELINE_TIMEOUT_MS,
    allowedModules: [],
    blockedModules: [],
    allowWriteFiles: true,
    allowReadFiles: true,
  },
};

/**
 * @module runtime/agent/agent-sandbox
 * @classdesc Agent沙箱（AgentSandbox）。资源隔离、权限限制、超时保护，
 * 支持三级隔离策略（strict/moderate/permissive）、路径校验、违规追踪与自动撤销。
 *
 * AgentSandbox — Execution sandbox with policy-based resource isolation and violation tracking
 * Enforces three isolation levels (strict/moderate/permissive) controlling filesystem, network,
 * child process, and module access. Validates file paths against restricted directories,
 * tracks policy violations with auto-revocation at threshold, and supports custom policy overrides.
 * @extends EventEmitter
 * @emits sandbox-prepared | access-denied | sandbox-violation-limit | policy-updated
 */
class AgentSandbox extends EventEmitter {
  /**
   * 创建AgentSandbox实例并初始化沙箱管理器。
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 沙箱配置选项
   * @param {string} [options.defaultLevel='moderate'] - 默认隔离级别
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'AgentSandbox', AgentError);
    this.root = projectRoot;
    this.options = options ?? {};
    this.sandboxes = new Map();
    this._defaultLevel = this.options.defaultLevel ?? SANDBOX_LEVELS.MODERATE;
    this._customPolicies = new Map();
    this._accessLogs = new BoundedArray(5000);
  }

  /**
   * 为指定Agent准备沙箱环境，根据隔离级别创建策略和限制。
   * @param {string} agentId - Agent标识
   * @param {Object} [config] - 沙箱配置
   * @param {string} [config.sandboxLevel] - 隔离级别（strict/moderate/permissive）
   * @param {Object} [config.sandboxPolicy] - 自定义策略覆盖
   * @param {number} [config.maxViolations=10] - 最大违规次数
   * @returns {Object} 创建的沙箱实例
   */
  prepare(agentId, config) {
    this.guardShutdown();
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) {
      throw new AgentError('INVALID_AGENT_ID', idValidation.reason);
    }

    const level = (config && config.sandboxLevel) || this._defaultLevel;
    if (!SANDBOX_LEVELS_SET.has(level)) {
      throw new AgentError('INVALID_SANDBOX_LEVEL', `Invalid sandbox level: ${level}. Must be one of: ${Object.values(SANDBOX_LEVELS).join(', ')}`);
    }
    const policy = this._resolvePolicy(agentId, level, config);

    this._evictIfNeeded(agentId);
    if (this.sandboxes.size >= MAX_SANDBOXES) {
      throw new AgentError('CAPACITY_EXCEEDED', `Maximum sandboxes (${MAX_SANDBOXES}) reached and eviction failed`);
    }

    const sandbox = {
      agentId,
      level,
      policy,
      ready: true,
      createdAt: new Date().toISOString(),
      environment: this._createEnvironment(agentId, policy),
      restrictions: this._buildRestrictions(policy),
      violationCount: 0,
      maxViolations: (config && config.maxViolations != null) ? config.maxViolations : 10,
      _blockedSet: new Set(policy.blockedModules ?? []),
      _allowedSet: new Set(policy.allowedModules ?? []),
    };

    this.sandboxes.set(agentId, sandbox);
    this.emit('sandbox-prepared', { agentId, level, policy });
    return sandbox;
  }

  _evictIfNeeded(excludeId) {
    if (this.sandboxes.size < MAX_SANDBOXES) return;
    const evictKey = this._findEvictionCandidate(excludeId);
    if (evictKey) {
      this.sandboxes.delete(evictKey);
      this.emit('sandbox-evicted', { agentId: evictKey, reason: 'capacity' });
    }
  }

  _findEvictionCandidate(excludeId) {
    for (const [k, s] of this.sandboxes) {
      if (s.ready && s.violationCount > 0 && k !== excludeId) return k;
    }
    for (const [k, s] of this.sandboxes) {
      if (s.ready && k !== excludeId) return k;
    }
    if (this.sandboxes.size === 0) return null;
    const firstKey = this.sandboxes.keys().next().value;
    return (firstKey !== undefined && firstKey !== excludeId) ? firstKey : null;
  }

  /**
   * 清理指定Agent的沙箱环境并释放资源。
   * @param {string} agentId - Agent标识
   * @returns {boolean} 是否成功清理
   */
  cleanup(agentId) {
    this.guardShutdown();
    const sandbox = this.sandboxes.get(agentId);
    if (!sandbox) return false;

    this.sandboxes.delete(agentId);
    this.emit('sandbox-cleaned', { agentId });
    return true;
  }

  /**
   * 检查Agent对指定资源的访问权限，违规时累计计数。
   * @param {string} agentId - Agent标识
   * @param {string} resource - 资源类型（filesystem/network/child_process/env/module）
   * @param {string} action - 操作类型（read/write/模块名等）
   * @returns {Object} 访问结果 {allowed: boolean, reason: string}
   */
  checkAccess(agentId, resource, action) {
    this.guardShutdown();
    const sandbox = this.sandboxes.get(agentId);
    if (!sandbox) return { allowed: false, reason: 'Sandbox not found' };
    if (sandbox.revoked) return { allowed: false, reason: 'Sandbox revoked: violation limit exceeded' };

    const result = this._evaluatePolicy(sandbox, resource, action);
    this._logAccess(agentId, resource, action, result.allowed, result.reason);

    if (!result.allowed) {
      sandbox.violationCount++;
      this.emit('access-denied', { agentId, resource, action, reason: result.reason, violationCount: sandbox.violationCount });

      if (sandbox.violationCount >= sandbox.maxViolations) {
        sandbox.revoked = true;
        this.emit('sandbox-violation-limit', { agentId, violationCount: sandbox.violationCount, maxViolations: sandbox.maxViolations });
      }
    }

    return { allowed: result.allowed, reason: result.reason };
  }

  /**
   * 验证文件路径是否在沙箱允许范围内，阻止对受限路径的访问。
   * @param {string} agentId - Agent标识
   * @param {string} filePath - 待验证的文件路径
   * @returns {Object} 验证结果 {valid: boolean, reason?: string, resolved?: string}
   */
  validatePath(agentId, filePath) {
    this.guardShutdown();
    const sandbox = this.sandboxes.get(agentId);
    if (!sandbox) return { valid: false, reason: 'Sandbox not found' };
    if (filePath == null || typeof filePath !== 'string') return { valid: false, reason: 'Invalid file path' };

    const result = validatePathSecurity(filePath, { rootDir: this.root });
    if (!result.valid) return result;

    const realProjectDir = result.projectDir;
    const realResolved = result.resolvedPath;

    const restrictedPaths = [
      path.join(realProjectDir, HARNESS_DIR, 'config.json'),
      path.join(realProjectDir, '.env'),
      path.join(realProjectDir, HARNESS_DIR, 'sessions'),
      path.join(realProjectDir, HARNESS_DIR, 'workspace'),
      path.join(realProjectDir, HARNESS_DIR, 'checkpoints'),
    ];

    for (const restricted of restrictedPaths) {
      const normRestricted = restricted.replace(/\\/g, '/').toLowerCase();
      const normResolved = realResolved.replace(/\\/g, '/').toLowerCase();
      if (normResolved === normRestricted || normResolved.startsWith(normRestricted + '/')) {
        return { valid: false, reason: 'Access to restricted path' };
      }
    }

    return { valid: true, resolved: realResolved };
  }

  /**
   * 为指定Agent设置自定义策略覆盖，实时更新已存在的沙箱策略。
   * @param {string} agentId - Agent标识
   * @param {Object} policyOverrides - 策略覆盖项
   * @param {boolean} [policyOverrides.allowFileSystem] - 是否允许文件系统访问
   * @param {boolean} [policyOverrides.allowNetwork] - 是否允许网络访问
   * @param {boolean} [policyOverrides.allowChildProcess] - 是否允许子进程
   * @param {boolean} [policyOverrides.allowEnvAccess] - 是否允许环境变量访问
   * @param {number} [policyOverrides.maxMemoryMB] - 最大内存限制（MB）
   * @param {number} [policyOverrides.maxCpuPercent] - 最大CPU占用百分比
   * @param {number} [policyOverrides.maxExecutionTimeMs] - 最大执行时间（毫秒）
   * @param {boolean} [policyOverrides.allowWriteFiles] - 是否允许写文件
   * @param {boolean} [policyOverrides.allowReadFiles] - 是否允许读文件
   * @returns {void}
   */
  setCustomPolicy(agentId, policyOverrides) {
    this.guardShutdown();
    if (!policyOverrides || typeof policyOverrides !== 'object') {
      throw new AgentError('INVALID_POLICY', 'policyOverrides must be an object');
    }
    const filtered = this._validatePolicyOverrides(policyOverrides);
    if (this._customPolicies.size >= MAX_CUSTOM_POLICIES && !this._customPolicies.has(agentId)) {
      const oldest = this._customPolicies.keys().next().value;
      this._customPolicies.delete(oldest);
    }
    this._customPolicies.set(agentId, filtered);
    const sandbox = this.sandboxes.get(agentId);
    if (sandbox) {
      sandbox.policy = safeAssign({}, sandbox.policy, filtered);
      sandbox.restrictions = this._buildRestrictions(sandbox.policy);
      sandbox._blockedSet = new Set(sandbox.policy.blockedModules ?? []);
      sandbox._allowedSet = new Set(sandbox.policy.allowedModules ?? []);
      this.emit('policy-updated', { agentId, policy: sandbox.policy });
    }
  }

  _validatePolicyOverrides(policyOverrides) {
    const VALIDATORS = {
      maxMemoryMB: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 || 'maxMemoryMB must be a non-negative finite number',
      maxCpuPercent: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 || 'maxCpuPercent must be a number between 0 and 100',
      maxExecutionTimeMs: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 || 'maxExecutionTimeMs must be a non-negative finite number',
      allowEnvAccess: (v) => typeof v === 'boolean' || 'allowEnvAccess must be a boolean',
      allowFileSystem: (v) => typeof v === 'boolean' || 'allowFileSystem must be a boolean',
      allowNetwork: (v) => typeof v === 'boolean' || 'allowNetwork must be a boolean',
      allowChildProcess: (v) => typeof v === 'boolean' || 'allowChildProcess must be a boolean',
      allowWriteFiles: (v) => typeof v === 'boolean' || 'allowWriteFiles must be a boolean',
      allowReadFiles: (v) => typeof v === 'boolean' || 'allowReadFiles must be a boolean',
    };
    const filtered = {};
    for (const [key, validator] of Object.entries(VALIDATORS)) {
      if (key in policyOverrides) {
        const result = validator(policyOverrides[key]);
        if (result !== true) throw new AgentError('INVALID_POLICY', result);
        filtered[key] = policyOverrides[key];
      }
    }
    return filtered;
  }

  /**
   * 获取指定Agent的沙箱实例。
   * @param {string} agentId - Agent标识
   * @returns {Object|null} 沙箱实例，不存在时返回null
   */
  getSandbox(agentId) {
    return this.sandboxes.get(agentId) ?? null;
  }

  /**
   * 获取指定Agent的当前沙箱策略。
   * @param {string} agentId - Agent标识
   * @returns {Object|null} 沙箱策略对象，不存在时返回null
   */
  getPolicy(agentId) {
    const sandbox = this.sandboxes.get(agentId);
    return sandbox ? sandbox.policy : null;
  }

  /**
   * 获取访问日志，支持按Agent、资源和拒绝状态过滤。
   * @param {string} [agentId] - 按Agent标识过滤
   * @param {Object} [options] - 过滤选项
   * @param {string} [options.resource] - 按资源类型过滤
   * @param {boolean} [options.deniedOnly] - 仅返回被拒绝的记录
   * @param {number} [options.limit=100] - 返回记录数上限
   * @returns {Object[]} 访问日志数组
   */
  getAccessLog(agentId, options) {
    let logs = this._accessLogs.toArray();
    if (agentId) {
      logs = logs.filter(l => l.agentId === agentId);
    }
    if (options && options.resource) {
      logs = logs.filter(l => l.resource === options.resource);
    }
    if (options && options.deniedOnly) {
      logs = logs.filter(l => !l.allowed);
    }
    const limit = (options && options.limit != null) ? Math.min(Math.max(1, Number.isFinite(parseInt(options.limit, 10)) ? parseInt(options.limit, 10) : 100), 10000) : 100;
    return logs.slice(-limit);
  }

  /**
   * 获取沙箱管理器的统计信息。
   * @returns {Object} 统计数据 {totalSandboxes, levelCounts, totalViolations, totalAccessLogs}
   */
  getStats() {
    const levelCounts = {};
    for (const level of Object.values(SANDBOX_LEVELS)) {
      levelCounts[level] = 0;
    }
    for (const sandbox of this.sandboxes.values()) {
      levelCounts[sandbox.level] = (levelCounts[sandbox.level] ?? 0) + 1;
    }

    let totalViolations = 0;
    for (const s of this.sandboxes.values()) totalViolations += s.violationCount;

    return {
      totalSandboxes: this.sandboxes.size,
      levelCounts,
      totalViolations,
      totalAccessLogs: this._accessLogs.length,
    };
  }

  _resolvePolicy(agentId, level, config) {
    const basePolicy = DEFAULT_POLICIES[level] || DEFAULT_POLICIES[this._defaultLevel];
    const customPolicy = this._customPolicies.get(agentId) ?? {};
    const configPolicy = (config && config.sandboxPolicy) ?? {};
    const result = {};
    for (const src of [basePolicy, customPolicy, configPolicy]) {
      for (const key of Object.keys(src)) {
        if (!DANGEROUS_KEYS.has(key)) result[key] = src[key];
      }
    }
    return result;
  }

  _createEnvironment(agentId, policy) {
    const env = {
      AGENT_ID: agentId,
      SANDBOX_LEVEL: policy.level ?? this._defaultLevel,
      NODE_ENV: 'sandbox',
    };

    if (policy.allowEnvAccess) {
      const safeEnvVars = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'TERM'];
      for (const key of safeEnvVars) {
        if (process.env[key]) {
          env[key] = process.env[key];
        }
      }
    }

    return env;
  }

  _buildRestrictions(policy) {
    const restrictions = [];

    if (!policy.allowFileSystem) {
      restrictions.push({ type: 'filesystem', action: '*', message: 'All filesystem access denied' });
    } else {
      if (!policy.allowReadFiles) {
        restrictions.push({ type: 'filesystem', action: 'read', message: 'File read access denied' });
      }
      if (!policy.allowWriteFiles) {
        restrictions.push({ type: 'filesystem', action: 'write', message: 'File write access denied' });
      }
    }

    if (!policy.allowNetwork) {
      restrictions.push({ type: 'network', action: '*', message: 'All network access denied' });
    }

    if (!policy.allowChildProcess) {
      restrictions.push({ type: 'child_process', action: '*', message: 'Child process creation denied' });
    }

    for (const mod of (Array.isArray(policy.blockedModules) ? policy.blockedModules : [])) {
      restrictions.push({ type: 'module', action: mod, message: `Module ${mod} is blocked` });
    }

    return restrictions;
  }

  _evaluatePolicy(sandbox, resource, action) {
    const policy = sandbox.policy;
    const RESOURCE_CHECKS = {
      filesystem: () => this._checkFilesystemPolicy(policy, action),
      network: () => ({ allowed: policy.allowNetwork, reason: policy.allowNetwork ? '' : 'Network access denied by sandbox policy' }),
      child_process: () => ({ allowed: policy.allowChildProcess, reason: policy.allowChildProcess ? '' : 'Child process access denied by sandbox policy' }),
      env: () => ({ allowed: policy.allowEnvAccess, reason: policy.allowEnvAccess ? '' : 'Environment variable access denied by sandbox policy' }),
      module: () => this._checkModulePolicy(sandbox, action),
    };

    const checker = RESOURCE_CHECKS[resource];
    if (checker) return checker();
    return { allowed: false, reason: `Unknown resource type: ${resource}` };
  }

  _checkFilesystemPolicy(policy, action) {
    const FS_ACTIONS = {
      read: { allowed: policy.allowReadFiles, reason: 'File read access denied by sandbox policy' },
      write: { allowed: policy.allowWriteFiles, reason: 'File write access denied by sandbox policy' },
    };
    const check = FS_ACTIONS[action];
    if (check) return { allowed: check.allowed, reason: check.allowed ? '' : check.reason };
    return { allowed: policy.allowFileSystem, reason: policy.allowFileSystem ? '' : 'File system access denied by sandbox policy' };
  }

  _checkModulePolicy(sandbox, action) {
    const safeAction = action ?? '';
    const moduleBase = safeAction.split('/')[0];
    if (!moduleBase) return { allowed: true, reason: '' };
    if (sandbox._blockedSet && (sandbox._blockedSet.has(action) || sandbox._blockedSet.has(moduleBase))) {
      return { allowed: false, reason: `Module ${action} is blocked by sandbox policy` };
    }
    if (sandbox._allowedSet && sandbox._allowedSet.size > 0 && !sandbox._allowedSet.has(action) && !sandbox._allowedSet.has(moduleBase)) {
      return { allowed: false, reason: `Module ${action} is not in allowed list` };
    }
    return { allowed: true, reason: '' };
  }

  _logAccess(agentId, resource, action, allowed, reason) {
    this._accessLogs.push({
      agentId,
      resource,
      action,
      allowed,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  _onShutdown() {
    this.sandboxes.clear();
    safeCall(() => this._accessLogs.shutdown(), 'AgentSandbox', 'shutdown-accessLogs');
    this._customPolicies.clear();
    this.removeAllListeners();
  }
}

AgentSandbox.LEVELS = SANDBOX_LEVELS;
AgentSandbox.DEFAULT_POLICIES = DEFAULT_POLICIES;

module.exports = withShutdown(AgentSandbox);
