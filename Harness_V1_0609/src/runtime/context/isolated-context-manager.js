'use strict';

const { EventEmitter } = require('events');
const { generateId, DEFAULT_CONFIDENCE, estimateTokens } = require('../../utils/constants');
const { mergeConfig } = require('../../utils/safe-assign');
const deepClone = require('../../utils/deep-clone');
const RingBuffer = require('../../utils/ring-buffer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const ContextFoldProtocol = require('./context-fold-protocol');

const DEFAULT_MAX_CONTEXTS = 20;
const DEFAULT_MAX_CONTEXT_SIZE = 50000;
const DEFAULT_TOOL_SETS = {
  'task-worker': ['read', 'write', 'search', 'run'],
  'domain-analyst': ['read', 'write', 'search', 'web'],
  'quality-assurance': ['read', 'search', 'run', 'web'],
  'devops-engineer': ['read', 'write', 'search', 'run'],
  'technical-writer': ['read', 'write', 'search'],
};

/**
 * @module runtime/context/isolated-context-manager
 * @classdesc 隔离上下文管理器。Agent间上下文隔离、共享边界控制
 * IsolatedContextManager — 隔离上下文管理器
 * 为每个Agent任务创建隔离的执行上下文，控制Agent间的上下文共享边界。
 * 按Agent角色分配工具集（task-worker/domain-analyst/quality-assurance等），
 * 管理上下文大小限制、访问控制策略和上下文生命周期，防止跨任务上下文泄漏。
 * @extends EventEmitter
 * @emits IsolatedContextManager#context-created
 * @emits IsolatedContextManager#context-accessed
 * @emits IsolatedContextManager#context-destroyed
 */
class IsolatedContextManager extends EventEmitter {
  constructor(options) {
    super();
    this._maxContexts = (options && options.maxContexts) ?? DEFAULT_MAX_CONTEXTS;
    this._maxContextSize = (options && options.maxContextSize) ?? DEFAULT_MAX_CONTEXT_SIZE;
    this._contexts = new Map();
    this._toolSets = mergeConfig(DEFAULT_TOOL_SETS, (options && options.customToolSets) ?? {});
    this._maxHistory = (options && options.maxHistory) ?? 200;
    this._history = new RingBuffer(this._maxHistory);
    this._accessControl = new Map();
    this._foldProtocol = new ContextFoldProtocol(options?.foldProtocol);
  }

  /**
   * 创建隔离的执行上下文。为Agent任务分配独立的上下文空间，包含工具集、
   * 系统提示、约束条件等。当上下文数量达到上限时自动驱逐最旧上下文。
   * @param {Object} config - 上下文配置
   * @param {string} config.taskDescription - 任务描述（必填）
   * @param {string} [config.agentId='task-worker'] - Agent角色ID
   * @param {string} [config.parentSessionId] - 父会话ID
   * @param {Array<string>} [config.toolSet] - 工具集，未指定时按agentId分配默认工具集
   * @param {string} [config.systemPrompt] - 系统提示，未指定时自动生成
   * @param {string} [config.injectedContext=''] - 注入的上下文内容
   * @param {Array<string>} [config.constraints=[]] - 约束条件列表
   * @param {Array<string>} [config.successCriteria=[]] - 成功标准列表
   * @param {string} [config.outputFormat='structured'] - 输出格式
   * @returns {Object|null} 创建的上下文对象，参数无效时返回null
   * @example
   * const icm = new IsolatedContextManager({ maxContexts: 10 });
   * const ctx = icm.createIsolatedContext({
   *   taskDescription: 'Implement authentication module',
   *   agentId: 'task-worker',
   *   constraints: ['Follow TDD workflow', 'No direct DB access'],
   *   successCriteria: ['All tests pass', 'Code review approved']
   * });
   * console.log(ctx.contextId, ctx.agentId);
   */
  createIsolatedContext(config) {
    this.guardShutdown();
    if (!config || !config.taskDescription) {
      return null;
    }

    if (typeof config.injectedContext === 'string' && config.injectedContext.length > this._maxContextSize) {
      config = mergeConfig(config, {
        injectedContext: config.injectedContext.slice(0, this._maxContextSize),
      });
    }

    if (this._contexts.size >= this._maxContexts) {
      this._evictOldest();
    }

    const contextId = generateId('ictx-');
    const agentId = config.agentId ?? 'task-worker';
    const toolSet = config.toolSet ?? this._toolSets[agentId] ?? ['read', 'search'];

    const context = {
      contextId,
      parentSessionId: config.parentSessionId ?? null,
      agentId,
      taskDescription: config.taskDescription,
      toolSet: Array.isArray(toolSet) ? toolSet.slice() : [toolSet],
      systemPrompt: config.systemPrompt ?? this._buildSystemPrompt(agentId, config.taskDescription),
      injectedContext: config.injectedContext ?? '',
      constraints: config.constraints ?? [],
      successCriteria: config.successCriteria ?? [],
      outputFormat: config.outputFormat ?? 'structured',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      status: 'active',
      result: null,
      tokenEstimate: this._estimateTokens(config),
    };

    this._contexts.set(contextId, context);
    this._accessControl.set(contextId, {
      owner: agentId,
      allowedAgents: new Set([agentId]),
    });
    this._recordCreation(context);
    this.emit('context-created', { contextId, agentId, taskDescription: config.taskDescription });
    return context;
  }

  /**
   * 授予指定Agent对某上下文的访问权限。
   * @param {string} contextId - 上下文ID
   * @param {string} agentId - 被授权的Agent ID
   * @returns {boolean} 授权是否成功，上下文不存在时返回false
   */
  grantContextAccess(contextId, agentId) {
    this.guardShutdown();
    const acl = this._accessControl.get(contextId);
    if (!acl) return false;
    if (acl.allowedAgents.size >= 20) return false;
    acl.allowedAgents.add(agentId);
    return true;
  }

  /**
   * 撤销指定Agent对某上下文的访问权限。不允许撤销所有者自身的权限。
   * @param {string} contextId - 上下文ID
   * @param {string} agentId - 被撤销权限的Agent ID
   * @returns {boolean} 撤销是否成功，上下文不存在或Agent为所有者时返回false
   */
  revokeContextAccess(contextId, agentId) {
    this.guardShutdown();
    const acl = this._accessControl.get(contextId);
    if (!acl) return false;
    if (agentId === acl.owner) return false;
    acl.allowedAgents.delete(agentId);
    return true;
  }

  /**
   * 获取指定上下文的副本。需通过访问控制检查，无权限时返回null并触发access-denied事件。
   * 返回的是深拷贝，修改不影响内部状态。
   * @param {string} contextId - 上下文ID
   * @param {string} [requestingAgentId] - 请求访问的Agent ID，不传则跳过访问控制检查
   * @returns {Object|null} 上下文对象副本，不存在或无权限时返回null
   */
  getContext(contextId, requestingAgentId) {
    this.guardShutdown();
    const ctx = this._contexts.get(contextId);
    if (!ctx) return null;
    if (requestingAgentId) {
      const acl = this._accessControl.get(contextId);
      if (acl && !acl.allowedAgents.has(requestingAgentId)) {
        this.emit('access-denied', { contextId, agentId: requestingAgentId });
        return null;
      }
    }
    ctx.lastAccessedAt = Date.now();
    return {
      contextId: ctx.contextId,
      parentSessionId: ctx.parentSessionId,
      agentId: ctx.agentId,
      taskDescription: ctx.taskDescription,
      toolSet: ctx.toolSet,
      systemPrompt: ctx.systemPrompt,
      injectedContext: ctx.injectedContext,
      constraints: ctx.constraints.slice(),
      successCriteria: ctx.successCriteria.slice(),
      outputFormat: ctx.outputFormat,
      status: ctx.status,
      result: ctx.result ? { output: ctx.result.output, summary: ctx.result.summary, confidence: ctx.result.confidence, evidence: ctx.result.evidence ? deepClone(ctx.result.evidence) : [], completedAt: ctx.result.completedAt } : null,
      tokenEstimate: ctx.tokenEstimate,
    };
  }

  /**
   * 向指定上下文提交执行结果。提交后上下文状态变为completed。
   * 结果包含输出、摘要、置信度和证据，未提供摘要时自动生成。
   * @param {string} contextId - 上下文ID
   * @param {Object} result - 执行结果
   * @param {*} result.output - 输出内容
   * @param {string} [result.summary] - 结果摘要
   * @param {number} [result.confidence] - 置信度（0-1）
   * @param {Array} [result.evidence=[]] - 证据列表
   * @returns {boolean} 提交是否成功，上下文不存在或结果无效时返回false
   */
  submitResult(contextId, result) {
    this.guardShutdown();
    const ctx = this._contexts.get(contextId);
    if (!ctx) return false;
    if (ctx.status === 'completed') {
      return false;
    }
    if (!result || typeof result !== 'object') return false;

    ctx.result = {
      output: result.output,
      summary: result.summary || this._summarizeOutput(result.output),
      confidence: (typeof result.confidence === 'number' && Number.isFinite(result.confidence)) ? result.confidence : DEFAULT_CONFIDENCE,
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
      completedAt: Date.now(),
    };

    if (this._foldProtocol && result) {
      const foldResult = this._foldProtocol.fold(result);
      ctx.result.summary = typeof foldResult.folded === 'string' ? foldResult.folded : JSON.stringify(foldResult.folded).substring(0, 200);
      ctx.result._archiveId = foldResult.archiveId;
    }

    ctx.status = 'completed';
    ctx.lastAccessedAt = Date.now();

    this._recordCompletion(ctx);
    this.emit('result-submitted', { contextId, agentId: ctx.agentId, confidence: ctx.result.confidence });
    return true;
  }

  /**
   * 释放指定上下文，将其从管理器中移除并触发context-released事件。
   * @param {string} contextId - 上下文ID
   * @returns {boolean} 释放是否成功，上下文不存在时返回false
   */
  releaseContext(contextId) {
    this.guardShutdown();
    const ctx = this._contexts.get(contextId);
    if (!ctx) return false;

    ctx.status = 'released';
    this._contexts.delete(contextId);
    this._accessControl.delete(contextId);
    this.emit('context-released', { contextId, agentId: ctx.agentId });
    return true;
  }

  /**
   * 展开已折叠的上下文结果，从折叠协议的归档中恢复原始数据
   * @param {string} archiveId - 归档ID，由submitResult时折叠协议生成
   * @returns {Object|string|null} 原始结果数据，折叠协议未初始化或归档ID不存在时返回null
   */
  unfoldResult(archiveId) {
    return this._foldProtocol ? this._foldProtocol.unfold(archiveId) : null;
  }

  /**
   * 获取所有活跃状态的上下文摘要列表。每个条目包含contextId、agentId、
   * 任务描述前100字符、创建时间和Token估算。
   * @returns {Array<{contextId: string, agentId: string, taskDescription: string, createdAt: number, tokenEstimate: number}>} 活跃上下文列表
   */
  getActiveContexts() {
    const active = [];
    for (const [, ctx] of this._contexts) {
      if (ctx.status === 'active') {
        active.push({
          contextId: ctx.contextId,
          agentId: ctx.agentId,
          taskDescription: ctx.taskDescription.slice(0, 100),
          createdAt: ctx.createdAt,
          tokenEstimate: ctx.tokenEstimate,
        });
      }
    }
    return active;
  }

  /**
   * 按父会话ID查询关联的上下文列表。指定requestingAgentId时仅返回该Agent有权限访问的完整上下文。
   * @param {string} sessionId - 父会话ID
   * @param {string} [requestingAgentId] - 请求访问的Agent ID
   * @returns {Array<Object>} 匹配的上下文列表
   */
  getContextsBySession(sessionId, requestingAgentId) {
    const results = [];
    for (const [, ctx] of this._contexts) {
      if (ctx.parentSessionId === sessionId) {
        if (requestingAgentId) {
          const full = this.getContext(ctx.contextId, requestingAgentId);
          if (full) results.push(full);
        } else {
          results.push({
            contextId: ctx.contextId,
            status: ctx.status,
            parentSessionId: ctx.parentSessionId,
            createdAt: ctx.createdAt,
            lastAccessedAt: ctx.lastAccessedAt,
          });
        }
      }
    }
    return results;
  }

  /**
   * 计算所有上下文的Token估算总和。
   * @returns {number} 总Token估算值
   */
  getTotalTokenEstimate() {
    let total = 0;
    for (const [, ctx] of this._contexts) {
      total += ctx.tokenEstimate;
    }
    return total;
  }

  /**
   * 获取管理器的统计信息，包括上下文数量、活跃数、完成数、Token估算等。
   * @returns {{ totalContexts: number, activeContexts: number, completedContexts: number, maxContexts: number, totalTokenEstimate: number, historyCount: number, toolSets: Array<string> }} 统计信息
   */
  getStats() {
    let active = 0;
    let completed = 0;
    for (const [, ctx] of this._contexts) {
      if (ctx.status === 'active') active++;
      else if (ctx.status === 'completed') completed++;
    }
    return {
      totalContexts: this._contexts.size,
      activeContexts: active,
      completedContexts: completed,
      maxContexts: this._maxContexts,
      totalTokenEstimate: this.getTotalTokenEstimate(),
      historyCount: this._history.size,
      toolSets: Object.keys(this._toolSets),
    };
  }

  _buildSystemPrompt(agentId, taskDescription) {
    const agentPrompts = {
      'task-worker': `你是任务执行者。专注于: ${taskDescription}\n可用工具: 读写文件、搜索代码、运行命令\n约束: 遵循TDD流程，先写测试后写实现`,
      'domain-analyst': `你是领域分析师。专注于: ${taskDescription}\n可用工具: 读写文件、搜索代码、网络搜索\n约束: 确保设计决策的一致性和合理性`,
      'quality-assurance': `你是质量保证。专注于: ${taskDescription}\n可用工具: 读取文件、搜索代码、运行测试、网络搜索\n约束: 独立验证，不受生成者影响`,
      'devops-engineer': `你是运维工程师。专注于: ${taskDescription}\n可用工具: 读写文件、搜索代码、运行命令\n约束: 确保部署稳定性和可回滚性`,
      'technical-writer': `你是技术文档工程师。专注于: ${taskDescription}\n可用工具: 读写文件、搜索代码\n约束: 文档清晰、结构化、对新手友好`,
    };
    return agentPrompts[agentId] || `你是${agentId || '未知角色'}。专注于: ${taskDescription || '当前任务'}`;
  }

  _estimateTokens(config) {
    let estimate = 0;
    estimate += estimateTokens(config.taskDescription || '');
    estimate += estimateTokens(config.systemPrompt || '');
    estimate += estimateTokens(config.injectedContext || '');
    estimate += (config.constraints ?? []).length * 20;
    estimate += (config.successCriteria ?? []).length * 15;
    return estimate;
  }

  _summarizeOutput(output) {
    if (!output) return '';
    if (typeof output === 'string') return output.length <= 200 ? output : output.slice(0, 197) + '...';
    try {
      const str = JSON.stringify(output);
      return str.length <= 200 ? str : str.slice(0, 197) + '...';
    } catch (_e) {
      return String(output).slice(0, 197) + '...';
    }
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, ctx] of this._contexts) {
      if (ctx.status === 'completed' && ctx.lastAccessedAt < oldestTime) {
        oldestTime = ctx.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._contexts.delete(oldestKey);
      this._accessControl.delete(oldestKey);
      this.emit('context-evicted', { contextId: oldestKey });
      return;
    }
    let staleKey = null;
    for (const [key, ctx] of this._contexts) {
      if (ctx.status === 'released' || ctx.status === 'failed') {
        staleKey = key;
        break;
      }
    }
    if (staleKey) {
      this._contexts.delete(staleKey);
      this._accessControl.delete(staleKey);
      this.emit('context-evicted', { contextId: staleKey });
      return;
    }
    let lruKey = null;
    let lruTime = Infinity;
    for (const [key, ctx] of this._contexts) {
      if (ctx.lastAccessedAt < lruTime) {
        lruTime = ctx.lastAccessedAt;
        lruKey = key;
      }
    }
    if (lruKey) {
      const evictedCtx = this._contexts.get(lruKey);
      if (evictedCtx && evictedCtx.status === 'active') {
        this.emit('active-context-evicted', { contextId: lruKey, sessionId: evictedCtx.parentSessionId });
      }
      this._contexts.delete(lruKey);
      this._accessControl.delete(lruKey);
      this.emit('context-evicted', { contextId: lruKey });
    }
  }

  _recordCreation(context) {
    this._history.push({
      type: 'created',
      contextId: context.contextId,
      agentId: context.agentId,
      timestamp: context.createdAt,
    });
  }

  _recordCompletion(context) {
    this._history.push({
      type: 'completed',
      contextId: context.contextId,
      agentId: context.agentId,
      confidence: context.result.confidence,
      timestamp: Date.now(),
    });
  }

  _onShutdown() {
    this._contexts.clear();
    this._accessControl.clear();
    this._history.clear();
    this.removeAllListeners();
  }

  _mergeShared(target, source, visited) {
    if (!target || typeof target !== 'object') return target;
    if (!source || typeof source !== 'object') return target;
    if (!visited) visited = new Set();
    if (visited.has(source)) return target;
    visited.add(source);

    const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    for (const key of Object.keys(source)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      const srcVal = source[key];
      if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
        if (visited.has(srcVal)) continue;
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
          target[key] = {};
        }
        this._mergeShared(target[key], srcVal, visited);
      } else if (Array.isArray(srcVal)) {
        target[key] = srcVal.slice();
      } else {
        target[key] = srcVal;
      }
    }
    return target;
  }

  /**
   * 检查管理器是否健康。当上下文数量未达到上限时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    if (this._shutDown) return false;
    return this._contexts.size < this._maxContexts;
  }
}

IsolatedContextManager.DEFAULT_MAX_CONTEXTS = DEFAULT_MAX_CONTEXTS;
IsolatedContextManager.DEFAULT_MAX_CONTEXT_SIZE = DEFAULT_MAX_CONTEXT_SIZE;
IsolatedContextManager.DEFAULT_TOOL_SETS = DEFAULT_TOOL_SETS;

module.exports = withShutdown(IsolatedContextManager);
