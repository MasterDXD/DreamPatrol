'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { AgentError } = require('../../errors');
const { validateAgentId, validateProjectRoot , HARNESS_DIR} = require('../../utils/constants');
const { sanitize: sanitizeData, writeAtomic } = require('../../utils/debounced-persister');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { readJsonDirSync } = require('../../utils/fs-utils');
const { shortId } = require('../../utils/unique-id');
const { mergeConfig } = require('../../utils/safe-assign');
const deepClone = require('../../utils/deep-clone');
const { withShutdown } = require('../../utils/shutdown-mixin');

const ENVIRONMENTS = {
  DEVELOPMENT: 'development',
  TESTING: 'testing',
  STAGING: 'staging',
  PRODUCTION: 'production',
};

const ENVIRONMENTS_SET = new Set(Object.values(ENVIRONMENTS));

const DEPLOYMENT_STRATEGIES = {
  ROLLING: 'rolling',
  BLUE_GREEN: 'blue-green',
  CANARY: 'canary',
  RECREATE: 'recreate',
};

const DEPLOYMENT_STRATEGIES_SET = new Set(Object.values(DEPLOYMENT_STRATEGIES));

const _ROLLBACK_SAFETY_TIMEOUT_MS = 30000;

const DEPLOYMENT_STATES = {
  PENDING: 'pending',
  PREPARING: 'preparing',
  DEPLOYING: 'deploying',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
};

/**
 * @module runtime/agent/agent-deployment
 * @classdesc Agent部署器（AgentDeployment）。版本管理、灰度发布、回滚机制，
 * 支持多环境部署（development/testing/staging/production）、滚动更新、蓝绿部署、金丝雀发布和重建策略。
 *
 * AgentDeployment — Agent部署管理器
 * 管理Agent的多环境部署（development/testing/staging/production），支持滚动更新、蓝绿部署、金丝雀发布和重建策略。
 * 维护版本注册表和环境状态，提供部署验证和自动回滚机制，持久化部署记录到.harness/deployments/。
 * @extends EventEmitter
 * @emits AgentDeployment#agent-deployed
 * @emits AgentDeployment#deployment-rolled-back
 * @emits AgentDeployment#environment-locked
 */
class AgentDeployment extends EventEmitter {
  /**
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 部署器配置
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'AgentDeployment', AgentError);
    this.root = projectRoot;
    this.options = options ?? {};
    this._deployDir = path.join(this.root, HARNESS_DIR, 'deployments');
    this._deployments = new Map();
    this._rollbackTimers = new Map();
    this._versionRegistry = new Map();
    this._environmentStates = {};
    Object.values(ENVIRONMENTS).forEach(env => {
      this._environmentStates[env] = { agents: new Map(), locked: false };
    });
    this._maxDeployments = 500;
    this._maxVersionRegistry = 1000;
    this._maxVersionsPerAgent = 100;
    this._restoreDeployments();
  }

  /**
   * 部署Agent到目标环境，支持滚动更新、蓝绿部署、金丝雀发布和重建策略。
   * @param {string} agentId - Agent唯一标识
   * @param {string} targetEnv - 目标环境（development/testing/staging/production）
   * @param {Object} [options] - 部署选项
   * @param {string} [options.strategy] - 部署策略（rolling/blue-green/canary/recreate）
   * @param {string} [options.version] - 部署版本号，不传则自动递增
   * @param {number} [options.canaryPercent] - 金丝雀发布流量百分比（0-100）
   * @param {boolean} [options.rollbackOnFailure=true] - 失败时是否自动回滚
   * @param {Object} [options.metadata] - 部署元数据
   * @returns {Object} 部署记录
   */
  deploy(agentId, targetEnv, options) {
    this.guardShutdown();
    this._validateDeployParams(agentId, targetEnv, options);

    const strategy = (options && options.strategy) || DEPLOYMENT_STRATEGIES.ROLLING;
    const version = (options && options.version) || this._getNextVersion(agentId);
    const canaryPercent = this._validateCanaryPercent(options && options.canaryPercent);
    const rollbackOnFailure = (options && options.rollbackOnFailure) !== false;

    const deploymentId = 'deploy-' + shortId('', 12);
    const deployment = this._createDeploymentRecord(deploymentId, agentId, version, targetEnv, strategy, canaryPercent, rollbackOnFailure, options);

    const envState = this._environmentStates[targetEnv];
    const currentDeployment = envState.agents.get(agentId);
    if (currentDeployment) {
      deployment.previousVersion = currentDeployment.version;
    }

    this._deployments.set(deploymentId, deployment);
    if (this._deployments.size > this._maxDeployments) {
      let evictKey = null;
      for (const [k, d] of this._deployments) {
        if (d.state === DEPLOYMENT_STATES.COMPLETED || d.state === DEPLOYMENT_STATES.FAILED || d.state === DEPLOYMENT_STATES.ROLLED_BACK) {
          evictKey = k;
          break;
        }
      }
      if (!evictKey) {
        evictKey = this._deployments.keys().next().value;
      }
      if (evictKey) this._deployments.delete(evictKey);
    }
    process.nextTick(() => {
      try {
        this._executeDeployment(deploymentId);
      } catch (err) {
        const dep = this._deployments.get(deploymentId);
        if (dep) {
          dep.state = DEPLOYMENT_STATES.FAILED;
          dep.error = err && err.message ? err.message : String(err);
        }
        this.emit('deployment-error', { deploymentId, error: err });
      }
    });

    return deployment;
  }

  _validateDeployParams(agentId, targetEnv, options) {
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) throw new AgentError('INVALID_AGENT_ID', idValidation.reason);
    if (!ENVIRONMENTS_SET.has(targetEnv)) throw new AgentError('INVALID_ENVIRONMENT', `Invalid environment: ${targetEnv}`);

    const envState = this._environmentStates[targetEnv];
    if (envState.locked) throw new AgentError('ENVIRONMENT_LOCKED', `Environment ${targetEnv} is currently locked for deployment`);

    const strategy = (options && options.strategy) || DEPLOYMENT_STRATEGIES.ROLLING;
    if (!DEPLOYMENT_STRATEGIES_SET.has(strategy)) {
      throw new AgentError('INVALID_STRATEGY', `Invalid deployment strategy: ${strategy}. Must be one of: ${Object.values(DEPLOYMENT_STRATEGIES).join(', ')}`);
    }
  }

  _validateCanaryPercent(canaryPercent) {
    if (typeof canaryPercent !== 'number' || !Number.isFinite(canaryPercent) || canaryPercent < 0 || canaryPercent > 100) return 0;
    return canaryPercent;
  }

  _createDeploymentRecord(deploymentId, agentId, version, targetEnv, strategy, canaryPercent, rollbackOnFailure, options) {
    return {
      id: deploymentId,
      agentId,
      version,
      targetEnv,
      strategy,
      canaryPercent,
      rollbackOnFailure,
      state: DEPLOYMENT_STATES.PENDING,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      previousVersion: null,
      errorInfo: null,
      metadata: (options && options.metadata) ?? {},
      _rollbackDepth: (options && options._rollbackDepth) ?? 0,
    };
  }

  /**
   * 回滚指定部署到上一版本，使用重建策略重新部署。
   * @param {string} deploymentId - 要回滚的部署ID
   * @param {Object} [options] - 回滚选项
   * @param {string} [options.reason] - 回滚原因
   * @returns {Object} 回滚部署记录
   */
  rollback(deploymentId, options) {
    this.guardShutdown();
    const deployment = this._deployments.get(deploymentId);
    if (!deployment) throw new AgentError('DEPLOYMENT_NOT_FOUND', `Deployment ${deploymentId} not found`);

    if (!deployment.previousVersion) {
      throw new AgentError('NO_PREVIOUS_VERSION', `No previous version to rollback to for deployment ${deploymentId}`);
    }

    const rollbackDeployment = this.deploy(deployment.agentId, deployment.targetEnv, {
      version: deployment.previousVersion,
      strategy: DEPLOYMENT_STRATEGIES.RECREATE,
      rollbackOnFailure: false,
      _rollbackDepth: (deployment._rollbackDepth ?? 0) + 1,
      metadata: { rollbackOf: deploymentId, reason: (options && options.reason) ?? 'Manual rollback' },
    });

    const rollbackDep = this._deployments.get(rollbackDeployment.id);
    if (rollbackDep) {
      const timers = { interval: null, safetyTimeout: null };
      this._rollbackTimers.set(deploymentId, timers);
      timers.interval = setInterval(() => {
        if (this._shutDown) { clearInterval(timers.interval); return; }
        if (rollbackDep.state === DEPLOYMENT_STATES.COMPLETED) {
          clearInterval(timers.interval);
          clearTimeout(timers.safetyTimeout);
          this._rollbackTimers.delete(deploymentId);
          deployment.state = DEPLOYMENT_STATES.ROLLED_BACK;
          deployment.completedAt = new Date().toISOString();
          this.emit('deployment-rolled-back', { deploymentId, rolledBackTo: deployment.previousVersion });
        } else if (rollbackDep.state === DEPLOYMENT_STATES.FAILED) {
          clearInterval(timers.interval);
          clearTimeout(timers.safetyTimeout);
          this._rollbackTimers.delete(deploymentId);
          deployment.state = DEPLOYMENT_STATES.FAILED;
          deployment.completedAt = new Date().toISOString();
          this.emit('deployment-rollback-failed', { deploymentId, reason: 'Rollback deployment failed' });
        }
      }, 10);
      if (timers.interval && typeof timers.interval.unref === 'function') timers.interval.unref();
      timers.safetyTimeout = setTimeout(() => { if (this._shutDown) return; clearInterval(timers.interval); this._rollbackTimers.delete(deploymentId); }, _ROLLBACK_SAFETY_TIMEOUT_MS);
      if (timers.safetyTimeout && typeof timers.safetyTimeout.unref === 'function') timers.safetyTimeout.unref();
    }

    return rollbackDeployment;
  }

  /**
   * 获取指定部署记录的深拷贝。
   * @param {string} deploymentId - 部署ID
   * @returns {Object|null} 部署记录，不存在时返回null
   */
  getDeployment(deploymentId) {
    const deployment = this._deployments.get(deploymentId);
    if (!deployment) return null;
    return deepClone(deployment);
  }

  /**
   * 列出部署记录，支持多维度过滤，按创建时间倒序排列。
   * @param {Object} [filter] - 过滤条件
   * @param {string} [filter.agentId] - 按Agent ID过滤
   * @param {string} [filter.targetEnv] - 按目标环境过滤
   * @param {string} [filter.state] - 按部署状态过滤
   * @param {string} [filter.strategy] - 按部署策略过滤
   * @returns {Array<Object>} 部署记录列表
   */
  listDeployments(filter) {
    let deployments = Array.from(this._deployments.values());
    if (filter) {
      if (filter.agentId) deployments = deployments.filter(d => d.agentId === filter.agentId);
      if (filter.targetEnv) deployments = deployments.filter(d => d.targetEnv === filter.targetEnv);
      if (filter.state) deployments = deployments.filter(d => d.state === filter.state);
      if (filter.strategy) deployments = deployments.filter(d => d.strategy === filter.strategy);
    }
    return deployments.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  }

  /**
   * 获取指定环境的当前状态，包含锁定状态和已部署Agent信息。
   * @param {string} env - 环境名称
   * @returns {Object|null} 环境状态，环境无效时返回null
   */
  getEnvironmentState(env) {
    if (!ENVIRONMENTS_SET.has(env)) return null;
    const state = this._environmentStates[env];
    if (!state) return null;
    const agents = {};
    (state.agents ?? new Map()).forEach((info, agentId) => {
      agents[agentId] = mergeConfig(info);
    });
    return {
      environment: env,
      locked: state.locked,
      agents,
    };
  }

  /**
   * 锁定指定环境，阻止新的部署操作。
   * @param {string} env - 环境名称
   */
  lockEnvironment(env) {
    this.guardShutdown();
    if (!ENVIRONMENTS_SET.has(env)) {
      throw new AgentError('INVALID_ENVIRONMENT', `Invalid environment: ${env}`);
    }
    this._environmentStates[env].locked = true;
    this.emit('environment-locked', { environment: env });
  }

  /**
   * 解锁指定环境，允许新的部署操作。
   * @param {string} env - 环境名称
   */
  unlockEnvironment(env) {
    this.guardShutdown();
    if (!ENVIRONMENTS_SET.has(env)) {
      throw new AgentError('INVALID_ENVIRONMENT', `Invalid environment: ${env}`);
    }
    this._environmentStates[env].locked = false;
    this.emit('environment-unlocked', { environment: env });
  }

  /**
   * 注册Agent版本到版本注册表，超出上限时自动淘汰最旧记录。
   * @param {string} agentId - Agent唯一标识
   * @param {string} version - 版本号
   * @param {Object} [info] - 版本附加信息
   */
  registerVersion(agentId, version, info) {
    this.guardShutdown();
    if (!this._versionRegistry.has(agentId)) {
      if (this._versionRegistry.size >= this._maxVersionRegistry) {
        const oldestKey = this._versionRegistry.keys().next().value;
        if (oldestKey) this._versionRegistry.delete(oldestKey);
      }
      this._versionRegistry.set(agentId, []);
    }
    const versions = this._versionRegistry.get(agentId);
    versions.push({
      version,
      info: info ?? {},
      registeredAt: new Date().toISOString(),
    });
    if (versions.length > this._maxVersionsPerAgent) {
      versions.splice(0, versions.length - this._maxVersionsPerAgent);
    }
    this.emit('version-registered', { agentId, version });
  }

  /**
   * 获取Agent的版本注册历史。
   * @param {string} agentId - Agent唯一标识
   * @returns {Array<Object>} 版本历史列表
   */
  getVersionHistory(agentId) {
    return this._versionRegistry.get(agentId) ?? [];
  }

  _executeDeployment(deploymentId) {
    const deployment = this._deployments.get(deploymentId);
    if (!deployment) return;

    let savedEnvSnapshot = null;
    try {
      deployment.state = DEPLOYMENT_STATES.PREPARING;
      deployment.startedAt = new Date().toISOString();
      this.emit('deployment-state-change', { deploymentId, state: DEPLOYMENT_STATES.PREPARING });

      this._prepareDeployment(deployment);

      deployment.state = DEPLOYMENT_STATES.DEPLOYING;
      this.emit('deployment-state-change', { deploymentId, state: DEPLOYMENT_STATES.DEPLOYING });

      const envState = this._environmentStates[deployment.targetEnv];
      if (!envState) {
        throw new Error('Target environment not found: ' + deployment.targetEnv);
      }
      const currentInfo = envState.agents.get(deployment.agentId);
      if (currentInfo) {
        savedEnvSnapshot = { agentId: deployment.agentId, info: mergeConfig(currentInfo) };
      }

      this._applyDeployment(deployment);

      deployment.state = DEPLOYMENT_STATES.VERIFYING;
      this.emit('deployment-state-change', { deploymentId, state: DEPLOYMENT_STATES.VERIFYING });

      this._verifyDeployment(deployment);

      deployment.state = DEPLOYMENT_STATES.COMPLETED;
      deployment.completedAt = new Date().toISOString();

      envState.agents.set(deployment.agentId, {
        version: deployment.version,
        deployedAt: deployment.completedAt,
        deploymentId: deployment.id,
      });

      this._registerDeploymentVersion(deployment);
      this._persistDeployment(deployment);
      this.emit('deployment-completed', { deploymentId, agentId: deployment.agentId, version: deployment.version, targetEnv: deployment.targetEnv });
    } catch (err) {
      deployment.state = DEPLOYMENT_STATES.FAILED;
      deployment.errorInfo = {
        message: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : 'DEPLOY_FAILED',
        timestamp: new Date().toISOString(),
      };
      deployment.completedAt = new Date().toISOString();

      if (savedEnvSnapshot) {
        const envState = this._environmentStates[deployment.targetEnv];
        if (envState) envState.agents.set(savedEnvSnapshot.agentId, savedEnvSnapshot.info);
      } else {
        const envState = this._environmentStates[deployment.targetEnv];
        if (envState) envState.agents.delete(deployment.agentId);
      }

      this._persistDeployment(deployment);
      emitError(this, 'deployment-failed', err, { deploymentId });

      if (deployment.rollbackOnFailure && deployment.previousVersion) {
        if ((deployment._rollbackDepth ?? 0) >= 2) {
          debug('AgentDeployment', 'rollbackDepthLimit', 'Skipping auto-rollback: depth=' + (deployment._rollbackDepth ?? 0));
        } else {
          try {
            this.rollback(deploymentId, { reason: `Auto-rollback: ${err && err.message ? err.message : String(err)}` });
          } catch (rollbackErr) {
            debug('AgentDeployment', 'rollback', rollbackErr);
          }
        }
      }
    }
  }

  _prepareDeployment(deployment) {
    if (!this._versionRegistry.has(deployment.agentId)) {
      this.registerVersion(deployment.agentId, deployment.version, { strategy: deployment.strategy });
    }
  }

  _applyDeployment(deployment) {
    const envState = this._environmentStates[deployment.targetEnv];
    const currentInfo = envState.agents.get(deployment.agentId);

    const baseInfo = {
      version: deployment.version,
      deployedAt: new Date().toISOString(),
      strategy: deployment.strategy,
      previousVersion: currentInfo ? currentInfo.version : null,
    };

    const strategyHandlers = {
      [DEPLOYMENT_STRATEGIES.RECREATE]: () => {
        if (currentInfo) envState.agents.delete(deployment.agentId);
        const info = mergeConfig(baseInfo);
        delete info.previousVersion;
        envState.agents.set(deployment.agentId, info);
      },
      [DEPLOYMENT_STRATEGIES.ROLLING]: () => {
        envState.agents.set(deployment.agentId, baseInfo);
      },
      [DEPLOYMENT_STRATEGIES.BLUE_GREEN]: () => {
        envState.agents.set(deployment.agentId, mergeConfig(baseInfo, { active: true }));
      },
      [DEPLOYMENT_STRATEGIES.CANARY]: () => {
        if (deployment.canaryPercent <= 0 || deployment.canaryPercent > 100) {
          deployment.canaryPercent = 10;
        }
        envState.agents.set(deployment.agentId, mergeConfig(baseInfo, { canaryPercent: deployment.canaryPercent }));
      },
    };

    const handler = strategyHandlers[deployment.strategy];
    if (handler) handler();
  }

  _verifyDeployment(deployment) {
    const envState = this._environmentStates[deployment.targetEnv];
    const agentInfo = envState.agents.get(deployment.agentId);
    if (!agentInfo) {
      throw new AgentError('DEPLOYMENT_FAILED', `Agent ${deployment.agentId} not found in environment ${deployment.targetEnv} after deployment`);
    }
    if (agentInfo.version !== deployment.version) {
      throw new AgentError('DEPLOYMENT_FAILED', `Agent ${deployment.agentId} version mismatch: expected ${deployment.version}, got ${agentInfo.version}`);
    }
  }

  _registerDeploymentVersion(deployment) {
    this.registerVersion(deployment.agentId, deployment.version, {
      environment: deployment.targetEnv,
      strategy: deployment.strategy,
      deploymentId: deployment.id,
    });
  }

  _getNextVersion(agentId) {
    const versions = this._versionRegistry.get(agentId) ?? [];
    if (versions.length === 0) return '1.0.0';
    if (this._versionRegistry.size > this._maxVersionRegistry) {
      const oldestKey = this._versionRegistry.keys().next().value;
      if (oldestKey && oldestKey !== agentId) this._versionRegistry.delete(oldestKey);
    }
    const lastVersion = versions[versions.length - 1]?.version || 'unknown';
    const parts = lastVersion.split('.').map(p => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    while (parts.length < 3) parts.push(0);
    parts[2] = parts[2] + 1;
    if (parts[2] > Number.MAX_SAFE_INTEGER) { parts[2] = 0; parts[1] = parts[1] + 1; }
    if (parts[1] > Number.MAX_SAFE_INTEGER) { parts[1] = 0; parts[0] = parts[0] + 1; }
    return parts.slice(0, 3).join('.');
  }

  _restoreDeployments() {
    const deployDir = this._deployDir;
    const entries = readJsonDirSync(deployDir, { logLabel: 'AgentDeployment' });
    entries.forEach(({ data: deployment }) => {
      const sanitized = sanitizeData(deployment);
      if (sanitized.id) {
        this._deployments.set(sanitized.id, sanitized);
      }
    });
  }

  _persistDeployment(deployment) {
    try {
      const filePath = path.join(this._deployDir, `${deployment.id}.json`);
      writeAtomic(filePath, deployment);
    } catch (err) {
      debug('AgentDeployment', '_persistDeployment', err);
      emitError(this, 'persist-error', err, { deploymentId: deployment.id });
    }
  }

  /**
   * 将所有部署记录持久化到磁盘。
   */
  flush() {
    this.guardShutdown();
    this._deployments.forEach(deployment => {
      try { this._persistDeployment(deployment); } catch (_e) { debug('AgentDeployment', 'persist-error', _e?.message || _e); }
    });
  }

  /**
   * 获取部署管理器统计摘要。
   * @returns {Object} 统计数据（totalDeployments/stateCounts/environmentCounts）
   */
  getStats() {
    const stateCounts = {};
    Object.values(DEPLOYMENT_STATES).forEach(state => {
      stateCounts[state] = 0;
    });
    this._deployments.forEach(deployment => {
      stateCounts[deployment.state] = (stateCounts[deployment.state] ?? 0) + 1;
    });

    return {
      totalDeployments: this._deployments.size,
      stateCounts,
      environmentCounts: Object.fromEntries(
        Object.entries(this._environmentStates).map(([env, state]) => [env, state.agents.size]),
      ),
    };
  }

  _onShutdown() {
    this._rollbackTimers.forEach(({ interval, safetyTimeout }) => {
      clearInterval(interval);
      clearTimeout(safetyTimeout);
    });
    this._rollbackTimers.clear();
    this._deployments.forEach(deployment => {
      try { this._persistDeployment(deployment); } catch (_e) { debug('AgentDeployment', '_onShutdown:persist', _e && _e.message ? _e.message : String(_e)); }
    });
    this._deployments.clear();
    this._versionRegistry.clear();
    for (const env of Object.keys(this._environmentStates)) {
      this._environmentStates[env].agents.clear();
    }
    this.removeAllListeners();
  }
}

AgentDeployment.ENVIRONMENTS = ENVIRONMENTS;
AgentDeployment.STRATEGIES = DEPLOYMENT_STRATEGIES;
AgentDeployment.STATES = DEPLOYMENT_STATES;

module.exports = withShutdown(AgentDeployment);
