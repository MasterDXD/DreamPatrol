'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeExecute, safeDateGetTime } = require('../../utils/safe-execute');
const { HarnessError, AgentError } = require('../../errors');
const { counterId } = require('../../utils/unique-id');
const { DEFAULT_REQUEST_TIMEOUT_MS } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MAX_RESULTS = 500;
const MAX_SHARED = 200;
const MAX_MAILBOX = 100;
const MAX_PROPOSALS = 100;
const MAX_PENDING_REQUESTS = 1000;
const DEFAULT_REQUEST_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_MS;
const DEFAULT_CONTEXT_MAX_AGE_MS = 60000;
const MESSAGE_PRIORITIES = { HIGH: 'high', NORMAL: 'normal', LOW: 'low' };
const HIGH_PRIORITY_TYPES = new Set(['context', 'request', 'response']);

/**
 * @module runtime/agent/agent-channel
 * @classdesc Agent通信通道（AgentChannel）。消息路由、优先级队列、背压控制，
 * 支持结果发布、请求-响应通信、共享状态管理、通信ACL访问控制和提案-投票协商机制。
 *
 * AgentChannel — Agent通信通道
 * 提供Agent间的消息路由、结果发布、请求-响应通信和共享状态管理。
 * 支持优先级消息队列（high/normal/low）、通信ACL访问控制、提案-投票协商机制，
 * 以及带超时的请求-响应模式。维护有界的结果缓存、邮箱和提案存储。
 * @extends EventEmitter
 * @emits AgentChannel#result-published
 * @emits AgentChannel#message-sent
 * @emits AgentChannel#request-timeout
 * @emits AgentChannel#proposal-created
 */
class AgentChannel extends EventEmitter {
  /**
   * Create an AgentChannel instance.
   * @param {Object} [options] - Channel configuration options
   * @param {number} [options.maxResults] - Maximum number of result entries
   * @param {number} [options.maxShared] - Maximum number of shared state entries
   */
  constructor(options) {
    super();
    this._maxResults = (options && options.maxResults) ?? MAX_RESULTS;
    this._maxShared = (options && options.maxShared) ?? MAX_SHARED;
    this._results = new Map();
    this._shared = new Map();
    this._mailboxes = {};
    this._messageHandlers = {};
    this._pendingRequests = Object.create(null);
    /** @type {Array<string>} 待处理请求键的插入顺序（用于FIFO淘汰） */
    this._pendingRequestOrder = [];
    this._proposals = new Map();
    this._sharedVersions = {};
    this._communicationACL = new Map();
    this._maxACLEntries = 200;
    this._maxMailboxKeys = 200;
    this._maxHandlerKeys = 200;
    this._pendingRequestCount = 0;
  }

  /**
   * 发布Agent执行结果到通道。维护有界结果缓存，超出容量时淘汰最早条目。
   * @param {string} agentId - Agent标识
   * @param {string} skillId - 技能标识
   * @param {*} result - 执行结果
   * @returns {Object} 包含agentId、skillId、result、timestamp的条目对象
   */
  publishResult(agentId, skillId, result) {
    this.guardShutdown();
    const key = `${agentId}:${skillId}`;
    const entry = {
      agentId,
      skillId,
      result,
      timestamp: new Date().toISOString(),
    };
    if (this._results.size >= this._maxResults) {
      const firstKey = this._results.keys().next().value;
      if (firstKey !== undefined) this._results.delete(firstKey);
    }
    this._results.delete(key);
    this._results.set(key, entry);
    this.emit('result-published', entry);
    return entry;
  }

  /**
   * 获取指定Agent和技能的执行结果。
   * @param {string} agentId - Agent标识
   * @param {string} skillId - 技能标识
   * @returns {Object|null} 结果条目对象，未找到时返回null
   */
  getResult(agentId, skillId) {
    const _key = `${agentId}:${skillId}`;
    return this._results.get(_key) ?? null;
  }

  /**
   * 按技能标识获取所有Agent的执行结果列表。
   * @param {string} skillId - 技能标识
   * @returns {Object[]} 匹配该技能的结果条目数组
   */
  getResultsBySkill(skillId) {
    const results = [];
    for (const r of this._results.values()) {
      if (r.skillId === skillId) results.push(r);
    }
    return results;
  }

  /**
   * 按Agent标识获取该Agent的所有执行结果列表。
   * @param {string} agentId - Agent标识
   * @returns {Object[]} 匹配该Agent的结果条目数组
   */
  getResultsByAgent(agentId) {
    const results = [];
    for (const r of this._results.values()) {
      if (r.agentId === agentId) results.push(r);
    }
    return results;
  }

  /**
   * 获取上游依赖技能的最新执行结果列表。
   * @param {string} skillId - 当前技能标识
   * @param {string[]} dependsOn - 上游依赖技能标识数组
   * @returns {Object[]} 上游依赖技能的最新结果条目数组
   */
  getUpstreamResults(skillId, dependsOn) {
    const results = [];
    for (const dep of dependsOn) {
      const entries = this.getResultsBySkill(dep);
      if (entries.length > 0) {
        results.push(entries[entries.length - 1]);
      }
    }
    return results;
  }

  /**
   * 设置共享状态键值对。通过写锁串行化写入，超出容量时淘汰最早条目。
   * @param {string} key - 共享状态键
   * @param {*} value - 共享状态值
   * @param {string} agentId - 写入者Agent标识
   * @returns {void}
   * @throws {Error} If the write lock encounters an unrecoverable error
   */
  setShared(key, value, agentId) {
    this.guardShutdown();
    const writeOp = () => {
      if (this._shared.size >= this._maxShared && !this._shared.has(key)) {
        const firstKey = this._shared.keys().next().value;
        if (firstKey !== undefined) {
          delete this._sharedVersions[firstKey];
          this._shared.delete(firstKey);
        }
      }
      const current = this._shared.get(key);
      const version = current ? (current.version ?? 0) + 1 : 1;
      this._shared.set(key, {
        value,
        writtenBy: agentId,
        updatedAt: new Date().toISOString(),
        version,
      });
      this._sharedVersions[key] = version;
      this.emit('shared-updated', { key, value, agentId, version });
    };

    if (!this._sharedWriteLock) this._sharedWriteLock = Promise.resolve();
    this._sharedWriteLock = this._sharedWriteLock.catch((e) => {
      this.emit('write-error', e);
    }).then(() => writeOp()).catch((err) => {
      debug('AgentChannel', 'sharedWriteLock', err && err.message ? err.message : String(err));
      this.emit('write-error', err);
    });
  }

  /**
   * 设置Agent的通信ACL，限制其可发送消息的目标Agent集合。
   * @param {string} agentId - Agent标识
   * @param {string[]} allowedTargets - 允许通信的目标Agent标识数组，支持通配符'*'
   * @returns {boolean} 设置成功返回true，参数无效返回false
   */
  setCommunicationACL(agentId, allowedTargets) {
    this.guardShutdown();
    if (!agentId || !Array.isArray(allowedTargets)) return false;
    if (!this._communicationACL.has(agentId) && this._communicationACL.size >= this._maxACLEntries) {
      const oldest = this._communicationACL.keys().next().value;
      this._communicationACL.delete(oldest);
    }
    this._communicationACL.set(agentId, new Set(allowedTargets));
    return true;
  }

  /**
   * 移除Agent的通信ACL规则。
   * @param {string} agentId - Agent标识
   * @returns {boolean} 成功移除返回true，规则不存在返回false
   */
  removeCommunicationACL(agentId) {
    this.guardShutdown();
    return this._communicationACL.delete(agentId);
  }

  _isCommunicationAllowed(fromAgentId, toAgentId) {
    if (this._communicationACL.size === 0) return true;
    const allowed = this._communicationACL.get(fromAgentId);
    if (!allowed) return true;
    return allowed.has(toAgentId) || allowed.has('*');
  }

  /**
   * 获取共享状态中指定键的值。
   * @param {string} key - 共享状态键
   * @returns {*|undefined} 键对应的值，不存在时返回undefined
   */
  getShared(key) {
    const entry = this._shared.get(key);
    return entry ? entry.value : null;
  }

  /**
   * 获取所有共享状态的键名数组。
   * @returns {string[]} 共享状态键名数组
   */
  getSharedKeys() {
    return Array.from(this._shared.keys());
  }

  /**
   * 移除指定键的共享状态条目。
   * @param {string} key - 共享状态键
   * @returns {boolean} 键存在并已移除返回true，键不存在返回false
   */
  removeShared(key) {
    const existed = this._shared.has(key);
    this._shared.delete(key);
    delete this._sharedVersions[key];
    return existed;
  }

  /**
   * 向所有Agent广播消息。
   * @param {string} agentId - 发送方Agent标识
   * @param {*} message - 广播消息内容
   * @returns {void}
   */
  broadcast(agentId, message) {
    this.guardShutdown();
    this.emit('broadcast', { from: agentId, message, timestamp: new Date().toISOString() });
  }

  /**
   * 向指定目标Agent发送消息。受通信ACL约束，邮箱溢出时淘汰低优先级消息。
   * @param {string} fromAgentId - 发送方Agent标识
   * @param {string} toAgentId - 接收方Agent标识
   * @param {*} message - 消息内容
   * @param {Object} [options] - 发送选项
   * @param {string} [options.priority] - 消息优先级（high/normal/low）
   * @returns {boolean} 发送成功返回true，参数无效或被ACL阻止返回false
   */
  send(fromAgentId, toAgentId, message, options) {
    this.guardShutdown();
    if (!toAgentId || !fromAgentId) return false;
    if (!this._isCommunicationAllowed(fromAgentId, toAgentId)) {
      this.emit('communication-blocked', { from: fromAgentId, to: toAgentId });
      return false;
    }
    if (!this._mailboxes[toAgentId]) {
      const mailboxKeys = Object.keys(this._mailboxes);
      if (mailboxKeys.length >= this._maxMailboxKeys) {
        for (const k of mailboxKeys) {
          if (!this._mailboxes[k] || this._mailboxes[k].length === 0) {
            delete this._mailboxes[k];
            if (this._messageHandlers[k] && this._messageHandlers[k].length === 0) {
              delete this._messageHandlers[k];
            }
            break;
          }
        }
      }
      this._mailboxes[toAgentId] = [];
    }
    const msgType = (message && message.type) || '';
    const priority = (options && options.priority) ??
      (HIGH_PRIORITY_TYPES.has(msgType) ? MESSAGE_PRIORITIES.HIGH : MESSAGE_PRIORITIES.NORMAL);
    const msg = {
      from: fromAgentId,
      to: toAgentId,
      message,
      priority,
      timestamp: new Date().toISOString(),
      id: counterId(fromAgentId + '-'),
    };
    this._mailboxes[toAgentId].push(msg);
    if (this._mailboxes[toAgentId].length > MAX_MAILBOX) {
      const evicted = this._evictLowPriority(this._mailboxes[toAgentId]);
      if (evicted) {
        this.emit('mailbox-overflow', { agentId: toAgentId, evictedMessage: evicted, mailboxSize: this._mailboxes[toAgentId].length });
      }
    }
    this.emit('message-sent', msg);
    if (this._messageHandlers[toAgentId]) {
      for (const handler of this._messageHandlers[toAgentId]) {
        safeExecute(() => handler(msg), 'AgentChannel', 'messageHandler');
      }
    }
    return true;
  }

  _evictLowPriority(mailbox) {
    for (let i = 0; i < mailbox.length; i++) {
      if (mailbox[i].priority !== MESSAGE_PRIORITIES.HIGH) {
        return mailbox.splice(i, 1)[0];
      }
    }
    // 所有消息都是HIGH优先级时，驱逐最早的一条（FIFO）
    if (mailbox.length > 0) {
      return mailbox.shift();
    }
    return null;
  }

  /**
   * 为指定Agent注册消息处理器，收到消息时自动调用。
   * @param {string} agentId - Agent标识
   * @param {Function} handler - 消息处理函数，接收消息对象作为参数
   * @returns {boolean} 注册成功返回true，参数无效或达到上限返回false
   */
  onMessage(agentId, handler) {
    if (!agentId || typeof handler !== 'function') return false;
    if (!this._messageHandlers[agentId]) {
      const handlerKeys = Object.keys(this._messageHandlers);
      if (handlerKeys.length >= this._maxHandlerKeys) {
        for (const k of handlerKeys) {
          if (this._messageHandlers[k].length === 0) {
            delete this._messageHandlers[k];
            break;
          }
        }
      }
      this._messageHandlers[agentId] = [];
    }
    if (this._messageHandlers[agentId].length >= MAX_MAILBOX) {
      debug('AgentChannel', 'onMessage', 'Max handlers reached for agent: ' + agentId);
      return false;
    }
    this._messageHandlers[agentId].push(handler);
    return true;
  }

  /**
   * 移除指定Agent的消息处理器。
   * @param {string} agentId - Agent标识
   * @param {Function} handler - 要移除的消息处理函数引用
   * @returns {boolean} 移除成功返回true，处理器未找到返回false
   */
  removeMessageHandler(agentId, handler) {
    if (!this._messageHandlers[agentId]) return false;
    const idx = this._messageHandlers[agentId].indexOf(handler);
    if (idx === -1) return false;
    this._messageHandlers[agentId].splice(idx, 1);
    if (this._messageHandlers[agentId].length === 0) {
      delete this._messageHandlers[agentId];
    }
    return true;
  }

  /**
   * 获取指定Agent邮箱中的消息列表，按时间倒序返回最近N条。
   * @param {string} agentId - Agent标识
   * @param {number} [limit] - 返回消息数量上限，默认返回全部
   * @returns {Object[]} 消息对象数组
   */
  getMessages(agentId, limit) {
    const mailbox = this._mailboxes[agentId] ?? [];
    const n = limit ?? mailbox.length;
    return mailbox.slice(-n);
  }

  /**
   * 清空指定Agent的邮箱消息。
   * @param {string} agentId - Agent标识
   * @returns {void}
   */
  clearMessages(agentId) {
    this.guardShutdown();
    if (this._mailboxes[agentId]) {
      this._mailboxes[agentId] = [];
    }
  }

  /**
   * 向目标Agent发送请求并等待响应。支持超时机制，超时后Promise以AgentError拒绝。
   * @param {string} fromAgentId - 请求方Agent标识
   * @param {string} toAgentId - 响应方Agent标识
   * @param {*} message - 请求消息内容
   * @param {number} [timeout] - 超时时间（毫秒），默认使用DEFAULT_REQUEST_TIMEOUT
   * @returns {Promise<Object>} 响应结果对象，包含from、requestId、response、timestamp
   */
  request(fromAgentId, toAgentId, message, timeout) {
    this.guardShutdown();
    const requestId = counterId('req-' + fromAgentId + '-');
    const timeoutMs = timeout ?? DEFAULT_REQUEST_TIMEOUT;

    return new Promise((resolve, reject) => {
      let settled = false;
      if (this._pendingRequestCount >= MAX_PENDING_REQUESTS) {
        // 按插入顺序淘汰最旧的请求
        while (this._pendingRequestOrder.length > 0) {
          const oldestKey = this._pendingRequestOrder.shift();
          const oldest = this._pendingRequests[oldestKey];
          if (!oldest) continue; // 已被超时/响应删除，跳过
          clearTimeout(oldest.timer);
          delete this._pendingRequests[oldestKey];
          this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
          try { oldest.reject(new AgentError('AGENT_CAPACITY_EXCEEDED', 'Evicted: pending request limit reached')); } catch (_e) { debug('AgentChannel', 'request', 'Evict reject error: ' + (_e && _e.message ? _e.message : String(_e))); }
          break;
        }
      }
      const timer = setTimeout(() => {
        if (this._shutDown) return;
        if (settled) return;
        settled = true;
        delete this._pendingRequests[requestId];
        this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
        reject(new AgentError('AGENT_TIMEOUT', `Request timeout: ${fromAgentId} -> ${toAgentId}`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();

      this._pendingRequests[requestId] = {
        resolve: (val) => { if (!settled) { settled = true; resolve(val); } },
        reject: (err) => { if (!settled) { settled = true; reject(err); } },
        timer,
      };
      this._pendingRequestOrder.push(requestId);
      this._pendingRequestCount++;

      const sent = this.send(fromAgentId, toAgentId, {
        type: 'request',
        requestId,
        payload: message,
      });
      if (!sent) {
        settled = true;
        clearTimeout(timer);
        delete this._pendingRequests[requestId];
        this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
        reject(new Error('Failed to send request message'));
      }
    });
  }

  /**
   * 响应之前的请求，将结果回传给请求方并清除挂起记录。
   * @param {string} requestId - 待响应的请求标识
   * @param {string} fromAgentId - 响应方Agent标识
   * @param {*} response - 响应内容
   * @returns {boolean} 响应成功返回true，请求不存在返回false
   */
  respond(requestId, fromAgentId, response) {
    this.guardShutdown();
    const pending = this._pendingRequests[requestId];
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.resolve({
      from: fromAgentId,
      requestId,
      response,
      timestamp: new Date().toISOString(),
    });
    delete this._pendingRequests[requestId];
    this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
    return true;
  }

  /**
   * 创建提案供Agent投票协商。超出容量时淘汰最早的提案。
   * @param {string} agentId - 提案发起者Agent标识
   * @param {string} topic - 提案主题
   * @param {Array} [options] - 投票选项列表
   * @returns {string} 提案标识
   */
  propose(agentId, topic, options) {
    this.guardShutdown();
    const proposalId = counterId('prop-' + agentId + '-');
    const proposal = {
      proposalId,
      proposer: agentId,
      topic,
      options: options ?? [],
      votes: {},
      createdAt: Date.now(),
      status: 'open',
    };

    if (this._proposals.size >= MAX_PROPOSALS) {
      const firstKey = this._proposals.keys().next().value;
      if (firstKey !== undefined) this._proposals.delete(firstKey);
    }

    this._proposals.set(proposalId, proposal);
    this.emit('proposal-created', { proposalId, proposer: agentId, topic });
    return proposalId;
  }

  /**
   * 对指定提案进行投票。仅开放状态的提案接受投票。
   * @param {string} proposalId - 提案标识
   * @param {string} agentId - 投票Agent标识
   * @param {string} choice - 投票选择
   * @returns {boolean} 投票成功返回true，提案不存在或已关闭返回false
   */
  vote(proposalId, agentId, choice) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal || proposal.status !== 'open') return false;
    proposal.votes[agentId] = {
      choice,
      timestamp: Date.now(),
    };
    this.emit('vote-cast', { proposalId, agentId, choice });
    return true;
  }

  /**
   * 获取指定提案的详情。
   * @param {string} proposalId - 提案标识
   * @returns {Object|null} 提案对象，未找到时返回null
   */
  getProposal(_proposalId) {
    return this._proposals.get(_proposalId) ?? null;
  }

  /**
   * 关闭提案并统计投票结果，返回得票最多的选项为胜出者。
   * @param {string} proposalId - 提案标识
   * @returns {Object|null} 结果对象包含proposalId、topic、tally、winner、totalVotes，提案不存在返回null
   */
  closeProposal(proposalId) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) return null;
    proposal.status = 'closed';
    const tally = {};
    for (const [, vote] of Object.entries(proposal.votes)) {
      tally[vote.choice] = (tally[vote.choice] ?? 0) + 1;
    }
    const winningChoice = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    const result = {
      proposalId,
      topic: proposal.topic,
      tally,
      winner: winningChoice ? winningChoice[0] : null,
      totalVotes: Object.keys(proposal.votes).length,
    };
    this.emit('proposal-closed', result);
    this._proposals.delete(proposalId);
    return result;
  }

  /**
   * 带版本号设置共享状态，实现乐观并发控制。版本冲突时写入失败。
   * @param {string} key - 共享状态键
   * @param {*} value - 共享状态值
   * @param {string} agentId - 写入者Agent标识
   * @returns {Promise<Object>} 成功时{success:true,version}，冲突时{success:false,reason:'version_conflict',currentVersion}
   */
  setSharedWithVersion(key, value, agentId) {
    this.guardShutdown();
    const writeOp = () => {
      const current = this._shared.get(key);
      const currentVersion = (current && current.version) ?? 0;
      if (current && current.version !== this._sharedVersions[key]) {
        return { success: false, reason: 'version_conflict', currentVersion };
      }
      const newVersion = currentVersion + 1;
      this._sharedVersions[key] = newVersion;
      if (this._shared.size >= this._maxShared && !this._shared.has(key)) {
        const firstKey = this._shared.keys().next().value;
        if (firstKey !== undefined) {
          delete this._sharedVersions[firstKey];
          this._shared.delete(firstKey);
        }
      }
      this._shared.delete(key);
      this._shared.set(key, {
        value,
        writtenBy: agentId,
        updatedAt: new Date().toISOString(),
        version: newVersion,
      });
      this.emit('shared-updated', { key, value, agentId, version: newVersion });
      return { success: true, version: newVersion };
    };

    if (!this._sharedWriteLock) this._sharedWriteLock = Promise.resolve();
    let resolveResult;
    const resultPromise = new Promise(r => { resolveResult = r; });
    this._sharedWriteLock = this._sharedWriteLock.then(() => {
      const result = writeOp();
      resolveResult(result);
      return result;
    }).catch((e) => {
      this.emit('write-error', e);
      try {
        const result = writeOp();
        resolveResult(result);
        return result;
      } catch (retryErr) {
        this.emit('write-error', retryErr);
        const result = { success: false, error: retryErr && retryErr.message ? retryErr.message : String(retryErr) };
        resolveResult(result);
        return result;
      }
    }).catch((err) => {
      debug('AgentChannel', 'sharedWriteLock', err && err.message ? err.message : String(err));
      this.emit('write-error', err);
      const result = { success: false, error: err && err.message ? err.message : String(err) };
      resolveResult(result);
      return result;
    });
    return resultPromise;
  }

  /**
   * 获取共享状态的值和版本号。
   * @param {string} key - 共享状态键
   * @returns {Object} 包含value和version的对象，键不存在时value为undefined、version为0
   */
  getSharedVersion(key) {
    const entry = this._shared.get(key);
    if (!entry) return { value: undefined, version: 0 };
    return { value: entry.value, version: entry.version ?? 0 };
  }

  /**
   * 获取通道的统计信息。
   * @returns {Object} 包含resultCount和sharedKeyCount的统计对象
   */
  getStats() {
    return {
      resultCount: this._results.size,
      sharedKeyCount: this._shared.size,
    };
  }

  /**
   * 清空所有通道状态，包括结果缓存、共享状态、邮箱、处理器、挂起请求、提案和ACL。
   * @returns {void}
   */
  clear() {
    this.guardShutdown();
    this._results.clear();
    this._shared.clear();
    this._mailboxes = {};
    this._messageHandlers = {};
    for (const [, pending] of Object.entries(this._pendingRequests)) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.reject) {
        try { pending.reject(new Error('Channel cleared')); } catch (_) { debug('AgentChannel', 'clear', 'Reject error during clear: ' + (_ && _.message ? _.message : String(_))); }
      }
    }
    this._pendingRequests = Object.create(null);
    this._pendingRequestOrder = [];
    this._pendingRequestCount = 0;
    this._proposals.clear();
    this._sharedVersions = {};
    this._communicationACL.clear();
  }

  _onShutdown() {
    for (const [, pending] of Object.entries(this._pendingRequests)) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.reject) {
        try { pending.reject(new HarnessError('SHUTDOWN_IN_PROGRESS', 'Channel shutdown')); } catch (e) { debug('AgentChannel', 'shutdown', 'Reject failed: ' + (e && e.message ? e.message : String(e))); }
      }
    }
    this._results.clear();
    this._shared.clear();
    this._mailboxes = {};
    this._messageHandlers = {};
    this._pendingRequests = Object.create(null);
    this._pendingRequestOrder = [];
    this._pendingRequestCount = 0;
    this._proposals.clear();
    this._sharedVersions = {};
    this._communicationACL.clear();
    this.removeAllListeners();
  }


  /**
   * 向目标Agent发送上下文包，包含意图、证据、会话和阶段信息。
   * @param {string} fromAgentId - 发送方Agent标识
   * @param {string} toAgentId - 接收方Agent标识
   * @param {Object} contextPacket - 上下文数据包
   * @param {Object} [contextPacket.context] - 上下文内容
   * @param {string} [contextPacket.intent] - 意图描述
   * @param {Array} [contextPacket.evidence] - 证据列表
   * @param {string} [contextPacket.sessionId] - 会话标识
   * @param {string} [contextPacket.phase] - 执行阶段
   * @param {number} [contextPacket.version] - 上下文版本号
   * @returns {Object|null} 构建的上下文包对象，参数无效时返回null
   */
  sendContext(fromAgentId, toAgentId, contextPacket) {
    this.guardShutdown();
    if (!fromAgentId || !toAgentId) return null;
    if (!contextPacket || typeof contextPacket !== 'object') return null;
    const packet = {
      sender: fromAgentId,
      recipient: toAgentId,
      context: contextPacket.context ?? {},
      intent: contextPacket.intent || '',
      evidence: contextPacket.evidence ?? [],
      sessionId: contextPacket.sessionId || '',
      phase: contextPacket.phase || '',
      version: contextPacket.version ?? 1,
      timestamp: new Date().toISOString(),
      id: counterId('ctx-' + fromAgentId + '-'),
    };
    this.send(fromAgentId, toAgentId, { type: 'context', packet });
    this.emit('context-sent', packet);
    return packet;
  }

  /**
   * 获取指定Agent的上下文类型消息列表。
   * @param {string} agentId - Agent标识
   * @param {number} [limit=50] - 返回消息数量上限
   * @returns {Object[]} 上下文包对象数组
   */
  getContextMessages(agentId, limit) {
    const messages = this.getMessages(agentId, limit ?? 50);
    return messages.filter(m => m.message && m.message.type === 'context')
      .map(m => m.message.packet);
  }

  /**
   * 创建指定Agent的上下文快照，包含共享键和执行结果。
   * @param {string} agentId - Agent标识
   * @param {string[]} [fields] - 需要包含的字段名数组，未指定时返回全部字段
   * @returns {Object} 上下文快照对象，包含agentId、sharedKeys、results、timestamp或按fields过滤后的子集
   */
  createContextSnapshot(agentId, fields) {
    const snapshot = {
      agentId,
      sharedKeys: this.getSharedKeys(),
      results: this.getResultsByAgent(agentId),
      timestamp: new Date().toISOString(),
    };
    if (fields && Array.isArray(fields)) {
      const filtered = {};
      for (const field of fields) {
        if (snapshot[field] !== undefined) filtered[field] = snapshot[field];
      }
      return filtered;
    }
    return snapshot;
  }

  /**
   * 验证上下文包的新鲜度，检查其时间戳是否在允许的年龄阈值内。
   * @param {Object} contextPacket - 上下文数据包
   * @param {string} contextPacket.timestamp - 上下文创建时间戳
   * @param {number} [maxAgeMs] - 最大允许年龄（毫秒），默认60000ms
   * @returns {Object} 包含fresh、age、threshold、reason的验证结果对象
   */
  validateContextFreshness(contextPacket, maxAgeMs) {
    if (!contextPacket || !contextPacket.timestamp) return { fresh: false, reason: 'no_timestamp' };
    const ts = safeDateGetTime(contextPacket.timestamp);
    if (!Number.isFinite(ts)) return { fresh: false, age: NaN, reason: 'invalid_timestamp' };
    const age = Date.now() - ts;
    const threshold = maxAgeMs ?? DEFAULT_CONTEXT_MAX_AGE_MS;
    return {
      fresh: age < threshold,
      age,
      threshold,
      reason: age >= threshold ? 'context_expired' : 'ok',
    };
  }
}

module.exports = withShutdown(AgentChannel);
module.exports.MESSAGE_PRIORITIES = MESSAGE_PRIORITIES;
