'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DeepeningError, CausalViolationError, PipelineError } = require('../../errors');
const { createPersister, sanitize: sanitizeData } = require('../../utils/debounced-persister');
const { safeJsonParse } = require('../../utils/safe-parse');
const { debug } = require('../../utils/debug-logger');
const { emitError, safeCall, ensureArray, safeStringify } = require('../../utils/safe-execute');
const { ensureDirSync, ensureDirAsync, loadJsonAsync } = require('../../utils/fs-utils');
const { getCapacity } = require('../../utils/capacity-config');
const { DANGEROUS_KEYS, MAX_JSON_FILE_SIZE, DEFAULT_MAX_QUEUE_SIZE, UTF8_ENCODING, HARNESS_DIR, MAX_DEBUG_PREVIEW_LENGTH, DEFAULT_PERSIST_DEBOUNCE_MS } = require('../../utils/constants');
const safeAssign = require('../../utils/safe-assign');
const AR = require('../context/autoregressive-context-schema');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_MAX_HISTORY = 200;
const WAL_RETRY_INTERVAL_MS = 5000;
const DEFAULT_MAX_PENDING_OUTPUTS = 50;
const DEFAULT_MAX_INTERFACES = 100;
const DEFAULT_MAX_CONFLICT_RESOLVERS = 20;
const MAX_VERSIONS_PER_SKILL = 5;
const MERGE_STRATEGIES = {
  LAST_WINS: 'last-wins',
  FIRST_WINS: 'first-wins',
  DEEPEST_WINS: 'deepest-wins',
  UNION: 'union',
};
const WAL_DIR_NAME = 'causal-wal';
const WAL_LOG_FILENAME = 'wal-operations.jsonl';
const WAL_CHECKPOINT_INTERVAL = 50;
const WAL_MAX_LOG_SIZE = MAX_JSON_FILE_SIZE;
const MAX_WAL_PENDING_QUEUE = DEFAULT_MAX_QUEUE_SIZE;
const MAX_STRING_LENGTH = 65536;
const OUTPUT_KEY_INDEX_HIGH_WATERMARK = 1000;
const OUTPUT_KEY_INDEX_LOW_WATERMARK = 800;
const MAX_SANITIZE_ARRAY_LENGTH = 1000;
const MAX_SANITIZE_OBJECT_KEYS = 1000;
const MAX_AR_CONTEXT_SERIALIZED_SIZE = 4096;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;
const _MAX_SUBSCRIBERS_PER_EVENT = 50;

/**
 * @module runtime/causal/causal-data-bus
 * 因果数据总线。事件发布/订阅、因果排序、版本追踪，
 * 支持WAL持久化和自回归上下文模式。
 *
 * @fires CausalDataBus#wal-initialized
 * @fires CausalDataBus#wal-queue-overflow
 * @fires CausalDataBus#wal-backpressure
 * @fires CausalDataBus#wal-drain
 * @fires CausalDataBus#wal-log-rotated
 * @fires CausalDataBus#interface-defined
 * @fires CausalDataBus#invariant-violation
 * @fires CausalDataBus#output-published
 * @fires CausalDataBus#invariant-check-skipped
 * @fires CausalDataBus#parallel-conflicts-detected
 * @fires CausalDataBus#parallel-outputs-merged
 * @fires CausalDataBus#causal-rollback
 * @fires CausalDataBus#causal-chain-evicted
 *
 * @example
 * const bus = new CausalDataBus({ projectRoot: '/path/to/project' });
 * bus.subscribe('my-skill', (output) => { console.log('Received:', output); });
 * bus.defineInterface('my-skill', { causalInputs: ['input1'], causalOutputs: ['output1'], scenarios: [] });
 * bus.publishOutput('my-skill', 'output1', { value: 42 });
 */

/**
 * 因果数据总线。事件发布/订阅、因果排序、版本追踪，
 * 支持WAL持久化和自回归上下文模式。
 *
 * @classdesc 因果数据总线核心。publish(事件发布+因果排序+WAL持久化)/
 * subscribe(事件订阅+版本追踪)/registerSkillInterface(技能接口注册+因果输入输出声明)/
 * getPendingOutputs(待处理输出查询)/WAL写入缓冲+刷盘+溢出处理。
 * @extends EventEmitter
 */
class CausalDataBus extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {string} [options.projectRoot] - 项目根目录（用于WAL持久化）
   * @param {number} [options.maxHistory=1000] - 因果链最大历史长度
   * @param {boolean} [options.enableWal=true] - 是否启用WAL持久化
   */
  constructor(options) {
    super();
    this.setMaxListeners(_MAX_SUBSCRIBERS_PER_EVENT + 10);
    this._walWriteLock = Promise.resolve();
    this._operationLock = Promise.resolve();
    this._causalChain = [];
    this._pendingOutputs = new Map();
    this._skillInterfaces = new Map();
    this._conflictResolvers = new Map();
    this._refCounts = new Map();
    this._outputKeyIndex = new Map();
    this._root = (options && options.projectRoot) ?? null;
    this._walDir = this._root ? path.join(this._root, HARNESS_DIR, WAL_DIR_NAME) : null;
    this._maxHistory = (options && options.maxHistory) ?? DEFAULT_MAX_HISTORY;
    this._maxPendingOutputs = (options && options.maxPendingOutputs) ?? DEFAULT_MAX_PENDING_OUTPUTS;
    this._maxInterfaces = (options && options.maxInterfaces) ?? DEFAULT_MAX_INTERFACES;
    this._maxConflictResolvers = (options && options.maxConflictResolvers) ?? DEFAULT_MAX_CONFLICT_RESOLVERS;
    this._walSequence = 0;
    this._subscriberSeq = 0;
    this._persister = null;
    this._walLogStream = null;
    this._walOpCount = 0;
    this._walRotating = false;
    this._outputVersions = new Map();
    this._subscribers = new Map();
    this._walInitialized = false;
    if (this._root) {
      this._readyPromise = this._initWALAsync().catch(err => {
        debug('CausalDataBus', 'initError', err);
        this._walInitialized = false;
        try { this.emit('error', { source: 'initWAL', error: err }); } catch (_emitErr) { this.emit('safe-error', { source: 'initWAL', error: err }); }
      });
    } else {
      this._readyPromise = Promise.resolve();
    }
  }

  /**
   * WAL初始化就绪Promise，用于等待异步初始化完成。
   * @type {Promise<void>}
   */
  get ready() {
    return this._readyPromise;
  }

  async _ensureWALReady() {
    if (this._readyPromise && !this._walInitialized) {
      await this._readyPromise;
    }
  }

  async _initWALAsync() {
    try {
      const walDir = this._walDir;
      await ensureDirAsync(walDir);
      if (!this.isHealthy()) return;
      await this._restoreFromWALAsync();
      if (!this.isHealthy()) return;
      await this._replayWALLogAsync();
      if (!this.isHealthy()) return;
      this._openWALLog();
      this._persister = createPersister({
        root: this._root,
        dir: WAL_DIR_NAME,
        filename: 'causal-state.json',
        debounceMs: DEFAULT_PERSIST_DEBOUNCE_MS,
        serialize: () => this._serializeState(),
        onError: (err) => {
          debug('CausalDataBus', 'WAL persist error', err);
          emitError(this, 'persist-error', err);
        },
      });
      this._walInitialized = true;
      this.emit('wal-initialized');
    } catch (err) {
      debug('CausalDataBus', '_initWALAsync', err);
      emitError(this, 'wal-init-error', err);
    }
  }

  async _restoreFromWALAsync() {
    const statePath = path.join(this._walDir, 'causal-state.json');
    try {
      const state = await loadJsonAsync(statePath, sanitizeData);
      if (!state) return;
      if (state.causalChain) this._causalChain = state.causalChain;
      if (state.pendingOutputs) this._pendingOutputs = new Map(Array.isArray(state.pendingOutputs) ? state.pendingOutputs : []);
      if (state.skillInterfaces) this._skillInterfaces = new Map(Array.isArray(state.skillInterfaces) ? state.skillInterfaces : []);
      if (state.refCounts) this._refCounts = new Map(Array.isArray(state.refCounts) ? state.refCounts : []);
    } catch (err) {
      debug('CausalDataBus', '_restoreFromWALAsync: no state file', err && err.message ? err.message : String(err));
    }
  }

  async _replayWALLogAsync() {
    const logPath = this._getWALLogPath();
    if (!logPath) return;
    try {
      await fs.promises.access(logPath);
    } catch (err) {
      debug('CausalDataBus', '_replayWALLogAsync: no log file', err && err.message ? err.message : String(err));
      return;
    }
    try {
      const content = await fs.promises.readFile(logPath, UTF8_ENCODING);
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = safeJsonParse(line, null, 'CausalDataBus');
          if (entry && entry.seq <= this._walSequence) continue;
          if (entry) this._applyWALOp(entry);
        } catch (err) {
          debug('CausalDataBus', '_replayWALLogAsync: skip malformed line', { line: line.substring(0, MAX_DEBUG_PREVIEW_LENGTH), error: err && err.message ? err.message : String(err) });
        }
      }
    } catch (err) {
      debug('CausalDataBus', '_replayWALLogAsync', err);
    }
  }

  /**
   * 从项目配置创建CausalDataBus实例，自动读取容量配置。
   * @param {string} projectRoot - 项目根目录路径
   * @returns {CausalDataBus} 新的CausalDataBus实例
   */
  static fromConfig(projectRoot) {
    return new CausalDataBus({
      projectRoot,
      maxHistory: getCapacity('causal_chain_max', projectRoot),
      maxPendingOutputs: getCapacity('pending_outputs_max', projectRoot),
      maxInterfaces: getCapacity('skill_interfaces_max', projectRoot),
      maxConflictResolvers: getCapacity('conflict_resolvers_max', projectRoot),
    });
  }

  /**
   * Safe state serialization with circular reference detection.
   * Replaces circular references with '[Circular]' markers to prevent JSON.stringify errors.
   * @param {Object} state - State object to serialize
   * @returns {Object} Safe-to-serialize state object
   * @private
   */
  _safeSerializeState(state) {
    const seen = new WeakSet();
    try {
      return JSON.parse(JSON.stringify(state, function(key, value) {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      }));
    } catch (_e) {
      debug('CausalDataBus', '_safeSerializeState', _e && _e.message ? _e.message : String(_e));
      return safeAssign({}, state);
    }
  }

  _serializeState() {
    return {
      causalChain: this._causalChain,
      pendingOutputs: Array.from(this._pendingOutputs.entries()),
      skillInterfaces: Array.from(this._skillInterfaces.entries()),
      refCounts: Array.from(this._refCounts.entries()),
      walSequence: this._walSequence,
      savedAt: new Date().toISOString(),
    };
  }

  _scheduleWALPersist() {
    if (this._persister) {
      this._persister.schedule();
    }
  }

  _persistWALImmediate() {
    if (!this.isHealthy()) return;
    if (this._persister) {
      const result = this._persister.persistNow();
      if (result && typeof result.catch === 'function') {
        result.catch(function(err) {
          debug('CausalDataBus', '_persistWALImmediate', err);
        });
      }
    }
  }

  _getWALLogPath() {
    if (!this._root) return null;
    return path.join(this._walDir, WAL_LOG_FILENAME);
  }

  _openWALLog() {
    if (!this.isHealthy()) return;
    if (this._walLogStream) {
      this._walLogStream.removeAllListeners();
      this._walLogStream.destroy();
      this._walLogStream = null;
    }
    const logPath = this._getWALLogPath();
    if (!logPath) return;
    try {
      const logDir = path.dirname(logPath);
      ensureDirSync(logDir);
      this._walLogStream = fs.createWriteStream(logPath, { flags: 'a', encoding: UTF8_ENCODING });
      this._walLogStream.on('error', (err) => {
        debug('CausalDataBus', 'WAL log stream error', err);
        try {
          if (this._walLogStream) {
            this._walLogStream.removeAllListeners();
            this._walLogStream.destroy();
            this._walLogStream = null;
          }
        } catch (destroyErr) {
          debug('CausalDataBus', 'WAL destroy error', destroyErr);
          this._walLogStream = null;
        }
        if (this._walLogPendingQueue && this._walLogPendingQueue.length > 0) {
          debug('CausalDataBus', 'WAL pending queue preserved', this._walLogPendingQueue.length + ' entries awaiting retry');
        }
        if (this._walRetryTimer) clearTimeout(this._walRetryTimer);
        this._walRetryTimer = setTimeout(() => {
          this._walRetryTimer = null;
          if (this._shutDown) return;
          try {
            if (!this._walLogStream) {
              this._openWALLog();
            }
          } catch (_err) {
            debug('CausalDataBus', 'WAL-retry-error', _err && _err.message ? _err.message : String(_err));
          }
        }, WAL_RETRY_INTERVAL_MS);
        if (this._walRetryTimer && typeof this._walRetryTimer.unref === 'function') {
          this._walRetryTimer.unref();
        }
      });
    } catch (err) {
      debug('CausalDataBus', '_openWALLog', err);
      this._walLogStream = null;
    }
  }

  _writeWALEntry(operation, data, seq) {
    if (!this.isHealthy()) return;
    if (seq == null) seq = ++this._walSequence;
    const entry = { operation, data, seq };
    let releaseLock = null;
    const lockTimeout = setTimeout(() => {
      debug('CausalDataBus', 'walWriteLockTimeout', { seq: entry.seq });
      if (releaseLock) releaseLock();
      releaseLock = null;
    }, 30000);
    if (lockTimeout && typeof lockTimeout.unref === 'function') lockTimeout.unref();
    this._walWriteLock = this._walWriteLock.then(() => {
      return new Promise((resolve) => { releaseLock = resolve; });
    }).then(() => {
      this._writeWALEntryInner(entry);
    }).catch(err => {
      debug('CausalDataBus', 'walWriteLock', err && err.message ? err.message : String(err));
    }).finally(() => {
      clearTimeout(lockTimeout);
      if (releaseLock) releaseLock();
    });
  }

  _writeWALEntryInner(entry) {
    if (!this.isHealthy()) return;
    if (!this._walLogStream || this._walRotating) {
      if (!this._walPendingQueue) this._walPendingQueue = [];
      if (this._walPendingQueue.length >= MAX_WAL_PENDING_QUEUE) {
        this.emit('wal-queue-overflow', { queueSize: this._walPendingQueue.length, seq: entry.seq });
        throw new PipelineError('WAL_QUEUE_OVERFLOW', 'WAL queue overflow: entry dropped');
      }
      this._walPendingQueue.push(entry);
      return;
    }
    this._flushWALPending();
    try {
      const line = safeStringify({
        op: entry.operation,
        seq: entry.seq,
        ts: Date.now(),
        data: entry.data ?? {},
      }) + '\n';
      const canWrite = this._walLogStream.write(line);
      if (!canWrite) {
        this.emit('wal-backpressure', { operation: entry.operation, seq: entry.seq });
        if (!this._walDrainHandler) {
          this._walDrainHandler = () => {
            this._walDrainHandler = null;
            this.emit('wal-drain', { seq: entry.seq });
          };
          this._walLogStream.once('drain', this._walDrainHandler);
        }
      }
      this._walOpCount++;
      if (this._walOpCount >= WAL_CHECKPOINT_INTERVAL) {
        this._walOpCount = 0;
        this._persistWALImmediate();
      }
      this._rotateWALLogIfNeeded();
    } catch (err) {
      debug('CausalDataBus', '_writeWALEntryInner', err);
      emitError(this, 'wal-write-error', err);
    }
  }

  _flushWALPending() {
    if (!this.isHealthy()) return;
    if (!this._walPendingQueue || this._walPendingQueue.length === 0) return;
    const pending = this._walPendingQueue;
    this._walPendingQueue = [];
    for (const item of pending) {
      try {
        const entry = safeStringify({
          op: item.operation,
          seq: item.seq,
          ts: Date.now(),
          data: item.data ?? {},
        }) + '\n';
        if (this._walLogStream) {
          this._walLogStream.write(entry);
        }
      } catch (e) {
        debug('CausalDataBus', '_flushWALPending', 'Failed to flush entry: ' + (e && e.message ? e.message : String(e)));
        emitError(this, 'wal-flush-error', e, { seq: item.seq });
      }
    }
  }

  _rotateWALLogIfNeeded() {
    if (!this.isHealthy()) return;
    const logPath = this._getWALLogPath();
    if (!logPath || this._walRotating) return;
    this._walRotating = true;
    this._rotateWALLogIfNeededAsync(logPath).catch(function(err) {
      debug('CausalDataBus', '_rotateWALLogIfNeededAsync', err);
    });
  }

  async _rotateWALLogIfNeededAsync(logPath) {
    try {
      const stat = await fs.promises.stat(logPath);
      if (stat.size >= WAL_MAX_LOG_SIZE) {
        if (this._walLogStream) {
          try {
            this._walLogStream.removeAllListeners();
            this._walLogStream.destroy();
          } catch (endErr) {
            debug('CausalDataBus', 'walRotateEnd', endErr);
          }
          this._walLogStream = null;
        }
        this._persistWALImmediate();
        const archivePath = logPath + '.' + Date.now() + '.archived';
        try {
          await fs.promises.rename(logPath, archivePath);
        } catch (renameErr) {
          debug('CausalDataBus', 'walArchiveRename', renameErr);
          try { await fs.promises.writeFile(logPath, ''); } catch (writeErr) { debug('CausalDataBus', 'walArchiveTruncate', writeErr); }
        }
        this._openWALLog();
        this.emit('wal-log-rotated', { previousSize: stat.size });
        this._walRotating = false;
      } else {
        this._walRotating = false;
      }
    } catch (err) {
      this._walRotating = false;
      debug('CausalDataBus', '_rotateWALLogIfNeededAsync', err);
      emitError(this, 'wal-rotation-error', err);
      try {
        this._openWALLog();
      } catch (reopenErr) {
        debug('CausalDataBus', 'walReopenAfterRotationFailure', reopenErr);
        emitError(this, 'wal-stream-lost', reopenErr);
      }
    }
  }

  /**
   * 检查实例是否健康（未关闭且WAL组件可用）。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    if (this._shutDown) return false;
    if (this._root && this._walInitialized && !this._walLogStream && !this._persister && !this._walRotating) return false;
    return true;
  }

  _applyWALOp(entry) {
    if (!entry || !entry.data) {
      debug('CausalDataBus', '_applyWALOp invalid entry', entry);
      return;
    }
    const handlers = {
      publish: () => this._applyPublishOp(entry),
      define_interface: () => this._applyDefineInterfaceOp(entry),
      rollback: () => this._applyRollbackOp(entry),
    };
    const handler = handlers[entry.op];
    if (handler) handler();
  }

  _applyPublishOp(entry) {
    const data = entry.data ?? {};
    const { skillId, outputData, causalId, walSeq } = data;
    if (walSeq && walSeq > this._walSequence) {
      this._walSequence = walSeq;
    }
    const effectiveSkillId = skillId || 'unknown';
    const chainEntry = {
      skillId: effectiveSkillId,
      timestamp: entry.ts,
      data: outputData ?? {},
      causalId: causalId || (effectiveSkillId + '-' + this._walSequence),
      walSeq: this._walSequence,
    };
    this._causalChain.push(chainEntry);
    if (this._causalChain.length > this._maxHistory) {
      const removed = this._causalChain.splice(0, this._causalChain.length - this._maxHistory);
      for (const r of removed) {
        if (r && r.causalId) this._refCounts.delete(r.causalId);
      }
    }
    this._pendingOutputs.set(skillId, chainEntry);
    if (this._pendingOutputs.size > this._maxPendingOutputs) {
      const oldest = this._pendingOutputs.keys().next().value;
      const oldestEntry = this._pendingOutputs.get(oldest);
      if (oldestEntry && oldestEntry.data && typeof oldestEntry.data === 'object') {
        for (const key of Object.keys(oldestEntry.data)) {
          const skillSet = this._outputKeyIndex.get(key);
          if (skillSet) {
            skillSet.delete(oldest);
            if (skillSet.size === 0) this._outputKeyIndex.delete(key);
          }
        }
      }
      this._pendingOutputs.delete(oldest);
    }
  }

  _applyDefineInterfaceOp(entry) {
    const data = entry.data ?? {};
    const { skillId, iface } = data;
    if (iface && skillId) {
      if (!this._skillInterfaces.has(skillId) && this._skillInterfaces.size >= this._maxInterfaces) {
        const oldest = this._skillInterfaces.keys().next().value;
        if (oldest !== undefined) this._skillInterfaces.delete(oldest);
      }
      this._skillInterfaces.set(skillId, iface);
    }
  }

  _applyRollbackOp(entry) {
    const data = entry.data ?? {};
    const { targetSequence } = data;
    if (typeof targetSequence === 'number' && Number.isFinite(targetSequence)) {
      this._causalChain = this._causalChain.filter(e => e.walSeq <= targetSequence);
      const expiredKeys = [];
      for (const [sid, e] of this._pendingOutputs) {
        if (e.walSeq > targetSequence) expiredKeys.push(sid);
      }
      for (const sid of expiredKeys) {
        this._pendingOutputs.delete(sid);
      }
      this._walSequence = targetSequence;
    }
  }

  /**
   * 附加项目根目录，延迟初始化WAL持久化。仅当实例未设置根目录时生效。
   * @param {string} projectRoot - 项目根目录路径
   * @returns {CausalDataBus} 当前实例，支持链式调用
   */
  attachProjectRoot(projectRoot) {
    this.guardShutdown();
    if (this._root) return this;
    this._root = projectRoot;
    this._readyPromise = this._initWALAsync().catch(err => {
      debug('CausalDataBus', 'initError', err);
      this._walInitialized = false;
      try { this.emit('error', { source: 'attachProjectRoot', error: err }); } catch (_emitErr) { this.emit('safe-error', { source: 'attachProjectRoot', error: err }); }
    });
    return this;
  }

  /**
   * 附加SQLite存储实例，用于将因果条目持久化到数据库。
   * @param {object} sqliteStore - SQLite存储实例，须实现 persistCausalEntry 方法
   * @returns {CausalDataBus} 当前实例，支持链式调用
   */
  attachSqliteStore(sqliteStore) {
    if (sqliteStore !== null && typeof sqliteStore === 'object' && typeof sqliteStore.persistCausalEntry === 'function') {
      this._sqliteStore = sqliteStore;
    }
    return this;
  }

  _persistToSQLite(entry) {
    if (!this._sqliteStore) return;
    try {
      const result = this._sqliteStore.persistCausalEntry({
        executionId: entry.executionId || '',
        skillId: entry.skillId,
        causalId: entry.causalId,
        parentCausalId: entry.parentCausalId || '',
        data: entry.data,
        interfaceVersion: entry.interfaceVersion ?? 0,
        walSeq: entry.walSeq ?? 0,
        timestamp: entry.timestamp,
      });
      if (result && typeof result.catch === 'function') {
        result.catch(function(err) { debug('CausalDataBus', '_persistToSQLite', err && err.message ? err.message : String(err)); });
      }
    } catch (err) {
      debug('CausalDataBus', '_persistToSQLite', err && err.message ? err.message : String(err));
    }
  }

  /**
   * 异步定义技能的因果接口，包含因果输入、因果输出、不变量和场景。
   * 超出接口容量上限时抛出异常。
   * @param {string} skillId - 技能ID
   * @param {object} definition - 接口定义
   * @param {Array} [definition.causalInputs=[]] - 因果输入列表
   * @param {Array} [definition.causalOutputs=[]] - 因果输出列表
   * @param {Array} [definition.invariants=[]] - 不变量约束列表
   * @param {Array} [definition.scenarios=[]] - 场景定义列表
   * @param {number} [definition.version=1] - 接口版本号
   * @returns {Promise<object>} 创建的接口定义对象
   * @throws {DeepeningError} 输入无效或容量超限时抛出
   */
  _withOperationLock(fn) {
    let releaseLock = null;
    this._operationLock = this._operationLock.catch(function(err) { debug('CausalDataBus', 'operationLock:prev', err && err.message ? err.message : String(err)); }).then(() => {
      return new Promise((resolve) => { releaseLock = resolve; resolve(); });
    }).then(() => fn()).catch((err) => {
      debug('CausalDataBus', 'operationLock', err && err.message ? err.message : String(err));
      throw err;
    }).finally(() => {
      if (releaseLock) releaseLock();
    });
    return this._operationLock;
  }

  /**
   * 定义技能接口，声明输入/输出规范。
   * @param {string} skillId - 技能标识符
   * @param {Record<string, unknown>} interfaceSpec - 接口规范（含inputs/outputs描述）
   * @returns {Promise<{ success: boolean, interfaceId?: string, error?: string }>}
   */
  async defineSkillInterface(skillId, definition) {
    this.guardShutdown();
    await this._ensureWALReady();
    return this._withOperationLock(async () => {
      if (this._shutDown) throw new CausalViolationError('SHUTDOWN_DURING_OPERATION', 'CausalDataBus is shut down');
      if (!skillId || typeof skillId !== 'string') {
        throw new DeepeningError('INVALID_INPUT', 'skillId must be a non-empty string');
      }
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        throw new DeepeningError('INVALID_INPUT', 'definition must be a non-null object');
      }
      if (this._skillInterfaces.size >= this._maxInterfaces && !this._skillInterfaces.has(skillId)) {
        throw new DeepeningError('CAPACITY_EXCEEDED', 'Maximum interface count reached: ' + this._maxInterfaces);
      }
      const iface = {
        skillId,
        causalInputs: Array.isArray(definition.causalInputs) ? definition.causalInputs : [],
        causalOutputs: Array.isArray(definition.causalOutputs) ? definition.causalOutputs : [],
        invariants: Array.isArray(definition.invariants) ? definition.invariants : [],
        scenarios: Array.isArray(definition.scenarios) ? definition.scenarios : [],
        version: definition.version ?? 1,
      };
      this._skillInterfaces.set(skillId, iface);
      this._writeWALEntry('define_interface', { skillId, iface });
      this._scheduleWALPersist();
      this.emit('interface-defined', { skillId, inputCount: iface.causalInputs.length, outputCount: iface.causalOutputs.length, scenarioCount: iface.scenarios.length });
      return iface;
    });
  }

  /**
   * 获取指定技能的因果接口定义。
   * @param {string} skillId - 技能ID
   * @returns {object|null} 接口定义对象，不存在时返回null
   */
  getSkillInterface(skillId) {
    this.guardShutdown();
    const iface = this._skillInterfaces.get(skillId);
    if (!iface) return null;
    try { return JSON.parse(JSON.stringify(iface)); } catch (_) { debug('CausalDataBus', 'getSkillInterface', _ && _.message ? _.message : String(_)); return { ...iface }; }
  }

  /**
   * 同步定义技能的因果接口，不写入WAL日志。接口定义与defineSkillInterface相同。
   * @param {string} skillId - 技能ID
   * @param {object} definition - 接口定义
   * @param {Array} [definition.causalInputs=[]] - 因果输入列表
   * @param {Array} [definition.causalOutputs=[]] - 因果输出列表
   * @param {Array} [definition.invariants=[]] - 不变量约束列表
   * @param {Array} [definition.scenarios=[]] - 场景定义列表
   * @param {number} [definition.version=1] - 接口版本号
   * @returns {object} 创建的接口定义对象
   * @throws {DeepeningError} 输入无效或容量超限时抛出
   */
  defineSkillInterfaceSync(skillId, definition) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'skillId must be a non-empty string');
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new DeepeningError('INVALID_INPUT', 'definition must be a non-null object');
    }
    if (this._skillInterfaces.size >= this._maxInterfaces && !this._skillInterfaces.has(skillId)) {
      throw new DeepeningError('CAPACITY_EXCEEDED', 'Maximum interface count reached: ' + this._maxInterfaces);
    }
    const iface = {
      skillId,
      causalInputs: Array.isArray(definition.causalInputs) ? definition.causalInputs : [],
      causalOutputs: Array.isArray(definition.causalOutputs) ? definition.causalOutputs : [],
      invariants: Array.isArray(definition.invariants) ? definition.invariants : [],
      scenarios: Array.isArray(definition.scenarios) ? definition.scenarios : [],
      version: definition.version ?? 1,
    };
    this._skillInterfaces.set(skillId, iface);
    this.emit('interface-defined', { skillId, inputCount: iface.causalInputs.length, outputCount: iface.causalOutputs.length, scenarioCount: iface.scenarios.length });
    return iface;
  }

  /**
   * 同步发布技能输出数据到因果链，不等待WAL就绪。接口验证和不变量检查与异步版本一致。
   * @param {string} skillId - 技能ID
   * @param {object} outputData - 输出数据对象
   * @returns {boolean} 发布是否成功
   */
  publishOutputSync(skillId, outputData) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return false;
    if (this._syncPublishing) return false;
    this._syncPublishing = true;
    try {
      const sanitizedData = this._sanitizeOutputData(outputData);
      const iface = this._skillInterfaces.get(skillId);
      if (!iface) {
        this._emitError('INTERFACE_NOT_FOUND', skillId, 'No interface registered for skill');
        return null;
      }
      const seq = ++this._walSequence;
      const entry = this._buildAndValidateEntry(skillId, outputData, sanitizedData, iface, seq);
      this._causalChain.push(entry);
      this._trimCausalChain();
      const oldEntry = this._pendingOutputs.get(skillId);
      this._removeOutputKeyIndexForSkill(skillId, oldEntry && oldEntry.data);
      this._pendingOutputs.set(skillId, entry);
      this._addOutputKeyIndexForSkill(skillId, entry.data);
      this._trimOutputKeyIndex();
      this._evictOldestPendingOutput();
      this._trackOutputVersion(skillId, entry);
      this._writeWALEntry('publish', {
        skillId,
        outputData: outputData ?? {},
        causalId: entry.causalId,
        walSeq: seq,
      }, seq);
      this._persistToSQLite(entry);
      this._scheduleWALPersist();
      this.emit('output-published', { skillId, causalId: entry.causalId });
      return true;
    } finally {
      this._syncPublishing = false;
    }
  }

  _buildAndValidateEntry(skillId, outputData, sanitizedData, iface, seq) {
    const entry = {
      skillId,
      timestamp: Date.now(),
      data: sanitizedData,
      interfaceVersion: iface ? iface.version : 0,
      causalId: skillId + '-' + seq,
      walSeq: seq,
      arContext: this._sanitizeARContext(sanitizedData),
    };
    if (iface) {
      entry.validatedOutputs = this._validateOutputs(iface, outputData);
      const invariantResult = this._validateInvariants(iface, outputData);
      entry.invariantPassed = invariantResult.passed;
      entry.invariantViolations = invariantResult.violations;
      if (!invariantResult.passed) {
        this.emit('invariant-violation', {
          skillId,
          causalId: entry.causalId,
          violations: invariantResult.violations,
        });
      }
    }
    return entry;
  }

  _trimCausalChain() {
    if (this._causalChain.length > this._maxHistory) {
      const removed = this._causalChain.splice(0, this._causalChain.length - this._maxHistory);
      for (const r of removed) {
        if (r && r.causalId) this._refCounts.delete(r.causalId);
      }
    }
  }

  _removeOutputKeyIndexForSkill(skillId, data) {
    if (data != null && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of Object.keys(data)) {
        const skillSet = this._outputKeyIndex.get(key);
        if (skillSet) {
          skillSet.delete(skillId);
          if (skillSet.size === 0) this._outputKeyIndex.delete(key);
        }
      }
    }
  }

  _addOutputKeyIndexForSkill(skillId, data) {
    if (data != null && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of Object.keys(data)) {
        if (!this._outputKeyIndex.has(key)) {
          this._outputKeyIndex.set(key, new Set());
        }
        this._outputKeyIndex.get(key)?.add(skillId);
      }
    }
  }

  _trimOutputKeyIndex() {
    if (this._outputKeyIndex.size > OUTPUT_KEY_INDEX_HIGH_WATERMARK) {
      const keysToDelete = [];
      let count = 0;
      const excess = this._outputKeyIndex.size - OUTPUT_KEY_INDEX_LOW_WATERMARK;
      for (const [k] of this._outputKeyIndex) {
        if (count >= excess) break;
        keysToDelete.push(k);
        count++;
      }
      for (const k of keysToDelete) this._outputKeyIndex.delete(k);
    }
  }

  _evictOldestPendingOutput() {
    if (this._pendingOutputs.size > this._maxPendingOutputs) {
      const oldest = this._pendingOutputs.keys().next().value;
      const oldestEntry = this._pendingOutputs.get(oldest);
      this._removeOutputKeyIndexForSkill(oldest, oldestEntry && oldestEntry.data);
      this._pendingOutputs.delete(oldest);
    }
  }

  _trackOutputVersion(skillId, entry) {
    const versions = this._outputVersions.get(skillId) ?? [];
    versions.push(entry);
    if (versions.length > MAX_VERSIONS_PER_SKILL) {
      versions.shift();
    }
    this._outputVersions.set(skillId, versions);
    if (this._outputVersions.size > this._maxPendingOutputs) {
      const pendingKeys = new Set(this._pendingOutputs.keys());
      const keysToDelete = [];
      for (const key of this._outputVersions.keys()) {
        if (!pendingKeys.has(key)) keysToDelete.push(key);
      }
      for (const key of keysToDelete) this._outputVersions.delete(key);
    }
  }

  /**
   * 获取所有已定义的技能因果接口列表。
   * @returns {Array<{skillId: string, causalInputs: Array, causalOutputs: Array, invariants: Array, scenarios: Array, version: number}>} 接口定义数组
   */
  getDefinedInterfaces() {
    this.guardShutdown();
    const result = [];
    for (const [skillId, iface] of this._skillInterfaces) {
      result.push({
        skillId,
        causalInputs: iface.causalInputs.slice(),
        causalOutputs: iface.causalOutputs.slice(),
        invariants: iface.invariants.slice(),
        scenarios: iface.scenarios.slice(),
        version: iface.version,
      });
    }
    return result;
  }

  _checkScenarioConditions(conditions, context) {
    const issues = [];
    if (!conditions || typeof conditions !== 'object') return issues;
    for (const [key, expected] of Object.entries(conditions)) {
      const actual = context && context[key];
      if (expected === 'exists' && (actual == null)) {
        issues.push({ field: key, expected: 'exists', actual: 'missing' });
      } else if (expected === 'not_exists' && (actual != null)) {
        issues.push({ field: key, expected: 'not_exists', actual: 'exists' });
      }
    }
    return issues;
  }

  /**
   * 验证指定技能的场景条件是否满足。
   * @param {string} skillId - 技能ID
   * @param {string} scenarioName - 场景名称
   * @param {object} context - 运行时上下文，用于匹配场景的given/then条件
   * @returns {{ valid: boolean, scenarioName: string, issues: Array, reason: string }} 场景验证结果
   */
  validateScenario(skillId, scenarioName, context) {
    this.guardShutdown();
    const iface = this._skillInterfaces.get(skillId);
    if (!iface || !Array.isArray(iface.scenarios) || iface.scenarios.length === 0) {
      return { valid: true, reason: 'no_scenarios_defined' };
    }
    const scenario = iface.scenarios.find(s => s.name === scenarioName);
    if (!scenario) {
      return { valid: false, reason: 'scenario_not_found', scenarioName };
    }
    const issues = this._checkScenarioConditions(scenario.given, context);
    issues.push(...this._checkScenarioConditions(scenario.then, context));
    return {
      valid: issues.length === 0,
      scenarioName,
      issues,
      reason: issues.length === 0 ? 'scenario_validated' : 'scenario_conditions_not_met',
    };
  }

  /**
   * 检查指定技能的场景测试覆盖率。
   * @param {string} skillId - 技能ID
   * @param {string[]} testedScenarios - 已测试的场景名称列表
   * @returns {{ coverage: number, untested: string[], total: number, tested: number }} 覆盖率统计
   */
  checkScenarioCoverage(skillId, testedScenarios) {
    const iface = this._skillInterfaces.get(skillId);
    if (!iface || !Array.isArray(iface.scenarios) || iface.scenarios.length === 0) {
      return { coverage: 100, untested: [], total: 0, tested: 0 };
    }
    const definedNames = iface.scenarios.flatMap(s => (s && s.name) ? [s.name] : []);
    const testedSet = new Set(ensureArray(testedScenarios));
    const untested = definedNames.filter(n => !testedSet.has(n));
    const coverage = definedNames.length > 0 ? ((definedNames.length - untested.length) / definedNames.length * 100) : 100;
    return { coverage, untested, total: definedNames.length, tested: definedNames.length - untested.length };
  }

  /**
   * 验证指定技能的因果输入是否齐全。
   * @param {string} skillId - 技能ID
   * @param {object} context - 提供输入值的上下文对象
   * @returns {{ valid: boolean, missing: string[], reason: string }} 输入验证结果
   */
  validateInputs(skillId, context) {
    this.guardShutdown();
    const iface = this._skillInterfaces.get(skillId);
    if (!iface) return { valid: true, missing: [], reason: 'no_interface_defined' };
    const missing = [];
    for (const input of iface.causalInputs ?? []) {
      const inputName = typeof input === 'string' ? input : input.name;
      const required = typeof input === 'object' && input !== null ? input.required !== false : true;
      if (required && (!context || context[inputName] == null)) {
        missing.push(inputName);
      }
    }
    return { valid: missing.length === 0, missing, reason: missing.length > 0 ? 'missing_required_inputs' : 'all_inputs_present' };
  }

  /**
   * 异步发布技能输出数据到因果链，执行接口验证、不变量检查、WAL持久化和版本追踪。
   * @param {string} skillId - 技能ID
   * @param {object} outputData - 输出数据对象
   * @returns {Promise<boolean>} 发布是否成功
   */
  async publishOutput(skillId, outputData) {
    try {
      await this._ensureWALReady();
    } catch (err) {
      debug('CausalDataBus', 'publishOutput', 'WAL not ready: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return false;
    return this._withOperationLock(() => {
      if (this._shutDown) return false;
      const seq = ++this._walSequence;
      const sanitizedData = this._sanitizeOutputData(outputData);
      const iface = this._skillInterfaces.get(skillId);
      const entry = {
        skillId,
        timestamp: Date.now(),
        data: sanitizedData,
        interfaceVersion: iface ? iface.version : 0,
        causalId: skillId + '-' + seq,
        walSeq: seq,
        arContext: this._sanitizeARContext(sanitizedData),
      };
      if (iface) {
        entry.validatedOutputs = this._validateOutputs(iface, outputData);
        const invariantResult = this._validateInvariants(iface, outputData);
        entry.invariantPassed = invariantResult.passed;
        entry.invariantViolations = invariantResult.violations;
        if (!invariantResult.passed) {
          this.emit('invariant-violation', {
            skillId,
            causalId: entry.causalId,
            violations: invariantResult.violations,
          });
        }
      }
      this._causalChain.push(entry);
      this._trimCausalChain();
      const oldEntry = this._pendingOutputs.get(skillId);
      this._removeOutputKeyIndexForSkill(skillId, oldEntry && oldEntry.data);
      this._pendingOutputs.set(skillId, entry);
      this._addOutputKeyIndexForSkill(skillId, entry.data);
      this._trimOutputKeyIndex();
      this._evictOldestPendingOutput();
      this._trackOutputVersion(skillId, entry);
      this._writeWALEntry('publish', {
        skillId,
        outputData: outputData ?? {},
        causalId: entry.causalId,
        walSeq: seq,
      }, seq);
      if (!entry.invariantPassed) {
        this._persistWALImmediate();
      } else {
        this._scheduleWALPersist();
      }
      this._persistToSQLite(entry);
      this.emit('output-published', { skillId, causalId: entry.causalId });
      return true;
    });
  }

  _sanitizeOutputData(data, depth, visited) {
    if (depth == null) depth = 0;
    if (depth > 10) return {};
    if (!data || typeof data !== 'object') return {};
    if (!visited) visited = new Set();
    if (visited.has(data)) return { _circular: true };
    visited.add(data);
    if (Array.isArray(data)) {
      const result = data.slice(0, MAX_SANITIZE_ARRAY_LENGTH).map(function(item) {
        return (item !== null && typeof item === 'object') ? this._sanitizeOutputData(item, depth + 1, visited) : item;
      }.bind(this));
      visited.delete(data);
      return result;
    }
    const sanitized = Object.create(null);
    const keys = Object.keys(data);
    for (let i = 0; i < keys.length && i < MAX_SANITIZE_OBJECT_KEYS; i++) {
      if (!DANGEROUS_KEYS.has(keys[i])) {
        const val = data[keys[i]];
        if (val !== null && typeof val === 'object') {
          sanitized[keys[i]] = this._sanitizeOutputData(val, depth + 1, visited);
        } else if (typeof val === 'string' && val.length > MAX_STRING_LENGTH) {
          sanitized[keys[i]] = val.slice(0, MAX_STRING_LENGTH);
        } else {
          sanitized[keys[i]] = val;
        }
      }
    }
    visited.delete(data);
    return sanitized;
  }

  /**
   * 强制验证指定技能的因果输入，缺失时抛出CausalViolationError。
   * @param {string} skillId - 技能ID
   * @param {object} context - 提供输入值的上下文对象
   * @returns {{ valid: boolean, missing: string[], reason: string }} 验证结果
   * @throws {CausalViolationError} skillId无效或输入缺失时抛出
   */
  enforceValidateInputs(skillId, context) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      throw new CausalViolationError(
        'CAUSAL_VIOLATION',
        `Invalid skillId for enforceValidateInputs: '${skillId}'`,
        { skillId },
      );
    }
    const result = this.validateInputs(skillId, context);
    if (!result.valid) {
      throw new CausalViolationError(
        'CAUSAL_INPUT_MISSING',
        `Causal input validation failed for skill '${skillId}': missing inputs [${result.missing.join(', ')}]`,
        { skillId, missing: result.missing },
      );
    }
    return result;
  }

  /**
   * 强制发布技能输出，依次验证输入、输出和不变量，任一不满足时抛出CausalViolationError。
   * @param {string} skillId - 技能ID
   * @param {object} outputData - 输出数据对象
   * @param {object} [inputContext] - 输入上下文，未提供时自动从consumeInputs获取
   * @returns {Promise<boolean>} 发布是否成功
   * @throws {CausalViolationError} skillId无效、输入缺失、输出不满足或不变量违反时抛出
   */
  async enforcePublishOutput(skillId, outputData, inputContext) {
    this.guardShutdown();
    await this._ensureWALReady();
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') {
      throw new CausalViolationError(
        'CAUSAL_VIOLATION',
        `Invalid skillId for enforcePublishOutput: '${skillId}'`,
        { skillId },
      );
    }
    const iface = this._skillInterfaces.get(skillId);
    if (iface) {
      const ctx = inputContext ?? this.consumeInputs(skillId);
      const inputResult = this.validateInputs(skillId, ctx);
      if (!inputResult.valid) {
        throw new CausalViolationError(
          'CAUSAL_INPUT_MISSING',
          `Causal inputs not satisfied for skill '${skillId}': missing [${inputResult.missing.join(', ')}]`,
          { skillId, missing: inputResult.missing },
        );
      }
      const outputResult = this._validateOutputs(iface, outputData);
      const missingOutputs = outputResult.flatMap(r => !r.present ? [r.name] : []);
      if (missingOutputs.length > 0) {
        throw new CausalViolationError(
          'CAUSAL_OUTPUT_INVALID',
          `Causal outputs not satisfied for skill '${skillId}': missing [${missingOutputs.join(', ')}]`,
          { skillId, missingOutputs },
        );
      }
      const invariantResult = this._validateInvariants(iface, outputData);
      if (!invariantResult.passed) {
        const violations = Array.isArray(invariantResult.violations) ? invariantResult.violations : [];
        const violationNames = violations.map(v => v.invariant || v.reason);
        throw new CausalViolationError(
          'CAUSAL_INVARIANT_FAILED',
          `Causal invariants violated for skill '${skillId}': [${violationNames.join(', ')}]`,
          { skillId, violations: invariantResult.violations },
        );
      }
    }
    return this.publishOutput(skillId, outputData);
  }

  _validateOutputs(iface, outputData) {
    const results = [];
    for (const output of iface.causalOutputs ?? []) {
      const outputName = typeof output === 'string' ? output : output.name;
      const present = outputData && outputData[outputName] !== undefined;
      results.push({ name: outputName, present });
    }
    return results;
  }

  _validateInvariants(iface, outputData) {
    const violations = [];
    if (!iface.invariants || iface.invariants.length === 0) {
      return { passed: true, violations: [] };
    }
    for (const invariant of iface.invariants) {
      if (typeof invariant === 'string') {
        const result = this._checkStringInvariant(invariant, outputData);
        if (!result.passed) {
          violations.push({ invariant, reason: result.reason });
        }
      } else if (typeof invariant === 'object' && invariant !== null) {
        const result = this._checkObjectInvariant(invariant, outputData);
        if (!result.passed) {
          violations.push({ invariant: invariant.name ?? JSON.stringify(invariant), reason: result.reason });
        }
      }
    }
    return { passed: violations.length === 0, violations };
  }

  _checkStringInvariant(invariant, outputData) {
    if (!outputData || typeof outputData !== 'object') {
      return { passed: false, reason: 'no_output_data' };
    }
    const negated = invariant.startsWith('!');
    const fieldName = negated ? invariant.slice(1) : invariant;
    const value = outputData[fieldName];
    if (negated) {
      if (value != null && value !== false && value !== 0 && value !== '') {
        return { passed: false, reason: `invariant ${invariant} violated: ${fieldName} should be falsy` };
      }
      return { passed: true };
    }
    if (value == null || value === false || value === 0 || value === '') {
      return { passed: false, reason: `invariant ${invariant} violated: ${fieldName} should be truthy` };
    }
    return { passed: true };
  }

  _checkFieldInvariant(invariant, value) {
    if (invariant.required && (value == null)) {
      return { passed: false, reason: `required field ${invariant.field} is missing` };
    }
    if (invariant.type && value != null) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== invariant.type) {
        return { passed: false, reason: `field ${invariant.field} expected type ${invariant.type}, got ${actualType}` };
      }
    }
    if (invariant.min !== undefined && Number.isFinite(value) && value < invariant.min) {
      return { passed: false, reason: `field ${invariant.field} value ${value} below minimum ${invariant.min}` };
    }
    if (invariant.max !== undefined && Number.isFinite(value) && value > invariant.max) {
      return { passed: false, reason: `field ${invariant.field} value ${value} above maximum ${invariant.max}` };
    }
    return null;
  }

  _checkObjectInvariant(invariant, outputData) {
    if (!outputData || typeof outputData !== 'object') {
      return { passed: false, reason: 'no_output_data' };
    }
    if (invariant.field) {
      const value = outputData[invariant.field];
      const fieldResult = this._checkFieldInvariant(invariant, value);
      if (fieldResult) return fieldResult;
    }
    if (typeof invariant.check === 'function') {
      this.emit('invariant-check-skipped', { reason: 'function_check_not_allowed_for_security', field: invariant.field ?? 'unknown' });
      return { passed: false, reason: 'custom check functions are not allowed for security reasons; use declarative invariant fields instead' };
    }
    return { passed: true };
  }

  /**
   * 消费指定技能的因果输入，从因果链或指定来源技能的输出中提取输入值。
   * @param {string} targetSkillId - 目标技能ID
   * @returns {object} 输入键值对映射
   */
  consumeInputs(targetSkillId) {
    try { this.guardShutdown(); } catch (_e) { debug('CausalDataBus', 'consumeInputs:guardShutdown', _e && _e.message ? _e.message : String(_e)); return {}; }
    const iface = this._skillInterfaces.get(targetSkillId);
    if (!iface) return {};
    const inputs = {};
    for (const input of iface.causalInputs ?? []) {
      const inputName = typeof input === 'string' ? input : input.name;
      const sourceSkill = typeof input === 'object' && input !== null ? input.source : null;
      if (sourceSkill) {
        const sourceOutput = this._pendingOutputs.get(sourceSkill);
        if (sourceOutput && sourceOutput.data) {
          if (sourceOutput.data[inputName] !== undefined) {
            inputs[inputName] = sourceOutput.data[inputName];
            this._incrementRefCount(sourceOutput.causalId);
          } else {
            debug('CausalDataBus', 'consumeInputs', 'Missing input: ' + inputName + ' from source: ' + sourceSkill);
          }
        }
      } else {
        for (let i = this._causalChain.length - 1; i >= 0; i--) {
          const entry = this._causalChain[i];
          if (entry.data && entry.data[inputName] !== undefined) {
            inputs[inputName] = entry.data[inputName];
            this._incrementRefCount(entry.causalId);
            break;
          }
        }
      }
    }
    return inputs;
  }

  /**
   * 检测两份输出数据之间的冲突键（同键不同值）。
   * @param {object} outputs1 - 第一份输出数据
   * @param {object} outputs2 - 第二份输出数据
   * @returns {Array<{key: string, value1: *, value2: *}>} 冲突列表
   */
  detectConflicts(outputs1, outputs2) {
    const conflicts = [];
    if (!outputs1 || !outputs2) return conflicts;
    const keys1 = Object.keys(outputs1);
    const keys2Set = new Set(Object.keys(outputs2));
    const commonKeys = keys1.filter(k => keys2Set.has(k));
    const cache1 = new Map();
    const cache2 = new Map();
    for (const key of commonKeys) {
      let val1 = cache1.get(key);
      if (val1 === undefined) { try { val1 = JSON.stringify(outputs1[key]); } catch (_err) { val1 = '[unserializable:' + typeof outputs1[key] + ':' + key + ']'; } cache1.set(key, val1); }
      let val2 = cache2.get(key);
      if (val2 === undefined) { try { val2 = JSON.stringify(outputs2[key]); } catch (_err) { val2 = '[unserializable:' + typeof outputs2[key] + ':' + key + ']'; } cache2.set(key, val2); }
      if (val1 !== val2) {
        conflicts.push({ key, value1: outputs1[key], value2: outputs2[key] });
      }
    }
    return conflicts;
  }

  /**
   * 使用指定策略解决冲突列表，返回解决后的键值映射。
   * @param {Array<{key: string, value1: *, value2: *}>} conflicts - 冲突列表
   * @param {string} strategy - 冲突解决策略名称
   * @returns {object} 解决后的键值映射
   */
  resolveConflicts(conflicts, strategy) {
    this.guardShutdown();
    if (!conflicts || conflicts.length === 0) return {};
    const resolved = {};
    const resolver = this._conflictResolvers.get(strategy) ?? this._defaultResolver;
    for (const conflict of conflicts) {
      resolved[conflict.key] = resolver(conflict);
    }
    return resolved;
  }

  _defaultResolver(conflict) {
    return conflict.value1;
  }

  /**
   * 注册自定义冲突解决器，超出容量上限时拒绝注册。
   * @param {string} name - 解决器名称
   * @param {Function} resolverFn - 解决器函数，接收冲突对象返回解决值
   * @returns {boolean} 注册是否成功
   */
  registerConflictResolver(name, resolverFn) {
    try { this.guardShutdown(); } catch (_e) { debug('CausalDataBus', 'registerConflictResolver:guardShutdown', _e && _e.message ? _e.message : String(_e)); return false; }
    if (!name || typeof name !== 'string') return false;
    if (typeof resolverFn !== 'function') return false;
    if (this._conflictResolvers.size >= this._maxConflictResolvers && !this._conflictResolvers.has(name)) {
      return false;
    }
    this._conflictResolvers.set(name, resolverFn);
    return true;
  }

  /**
   * 订阅指定事件类型，返回订阅ID用于后续取消订阅。
   * @param {string} eventType - 事件类型
   * @param {Function} callback - 事件回调函数
   * @param {string} [subscriberId] - 自定义订阅者ID
   * @returns {string|null} 订阅ID，参数无效或实例不健康时返回null
   */
  subscribe(eventType, callback, subscriberId) {
    this.guardShutdown();
    if (!eventType || typeof eventType !== 'string') return null;
    if (typeof callback !== 'function') return null;
    const eventSubs = this._subscribers.get(eventType);
    if (eventSubs && eventSubs.size >= _MAX_SUBSCRIBERS_PER_EVENT) return null;
    const id = subscriberId || ('sub-' + ++this._subscriberSeq);
    if (!this._subscribers.has(eventType)) {
      this._subscribers.set(eventType, new Map());
    }
    this._subscribers.get(eventType)?.set(id, callback);
    this.on(eventType, callback);
    return id;
  }

  /**
   * 取消指定订阅者的订阅。
   * @param {string} subscriberId - 订阅者ID
   * @returns {boolean} 是否成功取消订阅
   */
  unsubscribe(subscriberId) {
    this.guardShutdown();
    if (!subscriberId || typeof subscriberId !== 'string') return false;
    let eventTypeToDelete = null;
    let found = false;
    for (const [eventType, subscribers] of this._subscribers) {
      if (subscribers.has(subscriberId)) {
        const callback = subscribers.get(subscriberId);
        subscribers.delete(subscriberId);
        if (subscribers.size === 0) {
          eventTypeToDelete = eventType;
        }
        this.removeListener(eventType, callback);
        found = true;
        break;
      }
    }
    if (eventTypeToDelete !== null) this._subscribers.delete(eventTypeToDelete);
    return found;
  }

  _detectIndexConflicts(skillSet) {
    const allConflicts = [];
    const allOverlapping = [];
    const checked = new Set();
    const stringifyCache = new Map();
    for (const [key, skills] of this._outputKeyIndex) {
      const relevantSkills = [...skills].filter(s => skillSet.has(s));
      if (relevantSkills.length < 2) continue;
      allOverlapping.push(key);
      for (let i = 0; i < relevantSkills.length; i++) {
        for (let j = i + 1; j < relevantSkills.length; j++) {
          const pairKey = relevantSkills[i] + ':' + relevantSkills[j];
          if (checked.has(pairKey)) continue;
          checked.add(pairKey);
          const out1 = this._pendingOutputs.get(relevantSkills[i]);
          const out2 = this._pendingOutputs.get(relevantSkills[j]);
          if (out1 && out1.data && out2 && out2.data) {
            const cacheKey1 = relevantSkills[i] + ':' + key;
            const cacheKey2 = relevantSkills[j] + ':' + key;
            let val1 = stringifyCache.get(cacheKey1);
            if (val1 === undefined) { try { val1 = JSON.stringify(out1.data[key]); } catch (_err) { val1 = '[unserializable:' + relevantSkills[i] + ':' + key + ']'; } stringifyCache.set(cacheKey1, val1); }
            let val2 = stringifyCache.get(cacheKey2);
            if (val2 === undefined) { try { val2 = JSON.stringify(out2.data[key]); } catch (_err) { val2 = '[unserializable:' + relevantSkills[j] + ':' + key + ']'; } stringifyCache.set(cacheKey2, val2); }
            if (val1 !== val2) {
              allConflicts.push({
                key,
                sources: [relevantSkills[i], relevantSkills[j]],
                values: [out1.data[key], out2.data[key]],
              });
            }
          }
        }
      }
    }
    return { conflicts: allConflicts, overlapping: allOverlapping };
  }

  _detectPairConflicts(outputs) {
    const allConflicts = [];
    const overlappingSet = new Set();
    for (let i = 0; i < outputs.length; i++) {
      for (let j = i + 1; j < outputs.length; j++) {
        const conflicts = this.detectConflicts(outputs[i].data, outputs[j].data);
        for (const c of conflicts) {
          allConflicts.push({
            key: c.key,
            sources: [outputs[i].skillId, outputs[j].skillId],
            values: [c.value1, c.value2],
          });
          overlappingSet.add(c.key);
        }
      }
    }
    return { conflicts: allConflicts, overlapping: Array.from(overlappingSet) };
  }

  /**
   * 检测多个并行技能输出之间的数据冲突。
   * @param {string[]} skillIds - 待检测的技能ID列表
   * @returns {{ hasConflicts: boolean, conflicts: Array, overlappingKeys: string[] }} 冲突检测结果
   */
  detectParallelConflicts(skillIds) {
    this.guardShutdown();
    if (!Array.isArray(skillIds) || skillIds.length < 2) {
      return { hasConflicts: false, conflicts: [], overlappingKeys: [] };
    }
    const outputs = [];
    const skillSet = new Set(skillIds);
    for (const id of skillIds) {
      const pending = this._pendingOutputs.get(id);
      if (pending && pending.data) {
        outputs.push({ skillId: id, data: pending.data });
      }
    }
    if (outputs.length < 2) {
      return { hasConflicts: false, conflicts: [], overlappingKeys: [] };
    }
    let result;
    if (this._outputKeyIndex.size > 0) {
      result = this._detectIndexConflicts(skillSet);
    } else {
      result = this._detectPairConflicts(outputs);
    }
    if (result.conflicts.length > 0) {
      this.emit('parallel-conflicts-detected', {
        skillIds,
        conflictCount: result.conflicts.length,
        overlappingKeys: result.overlapping,
      });
    }
    return { hasConflicts: result.conflicts.length > 0, conflicts: result.conflicts, overlappingKeys: result.overlapping };
  }

  _collectPendingOutputs(skillIds) {
    const outputs = [];
    for (const id of skillIds) {
      const pending = this._pendingOutputs.get(id);
      if (pending && pending.data) {
        outputs.push({ skillId: id, data: pending.data, timestamp: pending.timestamp });
      }
    }
    return outputs;
  }

  _mergeWithStrategy(outputs, mergeStrategy) {
    const merged = {};
    switch (mergeStrategy) {
      case MERGE_STRATEGIES.FIRST_WINS:
        for (let i = outputs.length - 1; i >= 0; i--) {
          safeAssign(merged, outputs[i].data);
        }
        break;
      case MERGE_STRATEGIES.DEEPEST_WINS:
        outputs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        for (const out of outputs) {
          safeAssign(merged, out.data);
        }
        break;
      case MERGE_STRATEGIES.UNION:
        this._mergeUnion(merged, outputs);
        break;
      case MERGE_STRATEGIES.LAST_WINS:
      default:
        for (const out of outputs) {
          safeAssign(merged, out.data);
        }
        break;
    }
    return merged;
  }

  _mergeUnion(merged, outputs) {
    for (const out of outputs) {
      for (const [key, value] of Object.entries(out.data ?? {})) {
        if (DANGEROUS_KEYS.has(key)) continue;
        if (merged[key] === undefined) {
          merged[key] = value;
        } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
          merged[key] = merged[key].concat(value);
        } else if (typeof merged[key] === 'object' && typeof value === 'object' && merged[key] !== null && value !== null && !Array.isArray(merged[key]) && !Array.isArray(value)) {
          for (const [vk, vv] of Object.entries(value)) {
            if (!DANGEROUS_KEYS.has(vk)) {
              merged[key][vk] = vv;
            }
          }
        }
      }
    }
  }

  /**
   * 合并多个并行技能的输出数据，支持四种合并策略：last-wins、first-wins、deepest-wins、union。
   * @param {string[]} skillIds - 技能ID列表
   * @param {string} [strategy='last-wins'] - 合并策略
   * @returns {{ merged: object, conflicts: Array, strategy: string }} 合并结果
   */
  mergeParallelOutputs(skillIds, strategy) {
    this.guardShutdown();
    const mergeStrategy = strategy ?? MERGE_STRATEGIES.LAST_WINS;
    if (!Array.isArray(skillIds) || skillIds.length === 0) {
      return { merged: {}, conflicts: [], strategy: mergeStrategy };
    }
    const outputs = this._collectPendingOutputs(skillIds);
    if (outputs.length === 0) {
      return { merged: {}, conflicts: [], strategy: mergeStrategy };
    }
    if (outputs.length === 1) {
      return { merged: outputs[0].data, conflicts: [], strategy: mergeStrategy };
    }
    const conflictResult = this.detectParallelConflicts(skillIds);
    const merged = this._mergeWithStrategy(outputs, mergeStrategy);
    this.emit('parallel-outputs-merged', {
      skillIds,
      strategy: mergeStrategy,
      conflictCount: conflictResult.conflicts.length,
      mergedKeys: Object.keys(merged).length,
    });
    return { merged, conflicts: conflictResult.conflicts, strategy: mergeStrategy };
  }

  /**
   * 获取因果链条目，支持从指定索引开始截取。
   * @param {number} [fromIndex=0] - 起始索引
   * @returns {Array<object>} 因果链条目数组
   */
  getCausalChain(fromIndex) {
    this.guardShutdown();
    const start = (typeof fromIndex === 'number' && Number.isInteger(fromIndex) && fromIndex >= 0) ? fromIndex : 0;
    return this._causalChain.slice(start).map(e => ({ ...e }));
  }

  /**
   * 获取指定技能在因果链中的所有条目。
   * @param {string} skillId - 技能ID
   * @returns {Array<object>} 该技能的因果链条目数组
   */
  getCausalChainForSkill(skillId) {
    this.guardShutdown();
    return this._causalChain.filter(e => e.skillId === skillId).map(e => ({ ...e }));
  }

  _sanitizeARContext(data) {
    if (!data || !data._ar) return null;
    try {
      const extracted = AR.extract(data);
      if (!extracted) return null;
      const serialized = safeStringify(extracted);
      if (serialized.length > MAX_AR_CONTEXT_SERIALIZED_SIZE) return null;
      return extracted;
    } catch (e) {
      debug('CausalDataBus', '_sanitizeARContext', e);
      return null;
    }
  }

  /**
   * 获取指定技能的自回归上下文，沿因果依赖链BFS遍历上游技能。
   * @param {string} skillId - 技能ID
   * @param {number} [depth=3] - 最大遍历深度
   * @returns {Array<{skillId: string, arContext: object, causalDistance: number}>} 自回归上下文列表
   */
  getCausalARContext(skillId, depth) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string') return [];
    const maxDepth = (typeof depth === 'number' && Number.isInteger(depth) && depth >= 1) ? depth : 3;
    const result = [];
    const visited = new Set();
    const iface = this._skillInterfaces.get(skillId);
    if (!iface) return result;

    const queue = [{ id: skillId, currentDepth: 0 }];
    visited.add(skillId);

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift();
      if (currentDepth >= maxDepth) continue;

      const skillIface = this._skillInterfaces.get(id);
      if (!skillIface || !skillIface.causalInputs) continue;

      for (const input of skillIface.causalInputs) {
        const sourceId = input.source;
        if (!sourceId || visited.has(sourceId)) continue;
        visited.add(sourceId);

        const chainEntries = this._causalChain.filter(e => e.skillId === sourceId);
        for (const entry of chainEntries) {
          if (entry.arContext) {
            result.push({
              skillId: sourceId,
              arContext: entry.arContext,
              causalDistance: currentDepth + 1,
            });
          }
        }
        queue.push({ id: sourceId, currentDepth: currentDepth + 1 });
      }
    }
    return result;
  }

  /**
   * 获取所有待处理输出的副本。
   * @returns {Map<string, object>} 技能ID到待处理输出的映射副本
   */
  getPendingOutputs() {
    this.guardShutdown();
    return new Map(Array.from(this._pendingOutputs.entries()).map(([k, v]) => [k, { ...v }]));
  }

  /**
   * 获取指定技能的输出版本历史。
   * @param {string} skillId - 技能ID
   * @returns {Array<object>} 版本历史数组（浅拷贝）
   */
  getOutputVersions(skillId) {
    this.guardShutdown();
    if (!this._outputVersions) return [];
    return (this._outputVersions.get(skillId) ?? []).slice();
  }

  /**
   * 获取因果数据总线运行统计信息。
   * @returns {{ definedInterfaces: number, chainLength: number, pendingOutputs: number, validatedOutputs: number, invalidOutputs: number, conflictResolvers: number, invariantViolations: number, totalScenarios: number, walSequence: number, walEnabled: boolean }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('CausalDataBus', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { definedInterfaces: 0, chainLength: 0, pendingOutputs: 0, validatedOutputs: 0, invalidOutputs: 0, conflictResolvers: 0, invariantViolations: 0, totalScenarios: 0, walSequence: 0, walEnabled: false }; }
    const skillCoverage = this._skillInterfaces.size;
    const chainLength = this._causalChain.length;
    const pendingCount = this._pendingOutputs.size;
    let validatedCount = 0;
    let invalidCount = 0;
    let invariantViolations = 0;
    for (const entry of this._causalChain) {
      if (entry.validatedOutputs) {
        for (const v of entry.validatedOutputs) {
          if (v.present) validatedCount++;
          else invalidCount++;
        }
      }
      if (entry.invariantViolations && entry.invariantViolations.length > 0) {
        invariantViolations += entry.invariantViolations.length;
      }
    }
    let totalScenarios = 0;
    for (const iface of this._skillInterfaces.values()) {
      if (Array.isArray(iface.scenarios)) {
        totalScenarios += iface.scenarios.length;
      }
    }
    return {
      definedInterfaces: skillCoverage,
      chainLength,
      pendingOutputs: pendingCount,
      validatedOutputs: validatedCount,
      invalidOutputs: invalidCount,
      conflictResolvers: this._conflictResolvers.size,
      invariantViolations,
      totalScenarios,
      walSequence: this._walSequence,
      walEnabled: !!this._persister,
    };
  }

  /**
   * 将因果链回滚到指定WAL序列号，移除该序列号之后的所有条目和待处理输出。
   * @param {number} targetSequence - 目标WAL序列号
   * @returns {Promise<{success: boolean, targetSequence?: number, removedChainEntries?: number, removedPendingKeys?: string[], reason?: string}>} 回滚结果
   */
  async rollbackToSequence(targetSequence) {
    this.guardShutdown();
    try {
      await this._ensureWALReady();
    } catch (err) {
      debug('CausalDataBus', 'rollbackToSequence', 'WAL not ready: ' + (err && err.message ? err.message : String(err)));
      return { success: false, reason: 'wal_not_ready' };
    }
    if (typeof targetSequence !== 'number' || targetSequence < 0) {
      return { success: false, reason: 'invalid_target_sequence' };
    }
    if (targetSequence >= this._walSequence) {
      return { success: false, reason: 'target_sequence_is_current_or_newer' };
    }
    return this._withOperationLock(() => {
      if (this._shutDown) return { success: false, reason: 'shut_down' };
      const removedChainEntries = [];
      this._causalChain = this._causalChain.filter(entry => {
        if (entry.walSeq > targetSequence) {
          removedChainEntries.push(entry);
          return false;
        }
        return true;
      });
      const removedPendingKeys = [];
      const expiredPendingKeys = [];
      for (const [skillId, entry] of this._pendingOutputs) {
        if (entry.walSeq > targetSequence) expiredPendingKeys.push(skillId);
      }
      for (const skillId of expiredPendingKeys) {
        this._pendingOutputs.delete(skillId);
        removedPendingKeys.push(skillId);
      }
      this._walSequence = targetSequence;
      const emptyIndexKeys = [];
      for (const [key, skillSet] of this._outputKeyIndex) {
        const expiredSkills = [];
        for (const skillId of skillSet) {
          const po = this._pendingOutputs.get(skillId);
          if (!po || po.walSeq > targetSequence) expiredSkills.push(skillId);
        }
        for (const skillId of expiredSkills) skillSet.delete(skillId);
        if (skillSet.size === 0) emptyIndexKeys.push(key);
      }
      for (const key of emptyIndexKeys) this._outputKeyIndex.delete(key);
      const expiredVersionIds = [];
      for (const [skillId, versions] of this._outputVersions) {
        const filtered = versions.filter(v => v.walSeq <= targetSequence);
        if (filtered.length === 0) {
          expiredVersionIds.push(skillId);
        } else {
          this._outputVersions.set(skillId, filtered);
        }
      }
      for (const skillId of expiredVersionIds) this._outputVersions.delete(skillId);
      const validCausalIds = new Set(this._causalChain.map(e => e.causalId));
      for (const pending of this._pendingOutputs.values()) {
        if (pending.causalId) validCausalIds.add(pending.causalId);
      }
      const expiredRefKeys = [];
      for (const [causalId] of this._refCounts) {
        if (!validCausalIds.has(causalId)) expiredRefKeys.push(causalId);
      }
      for (const causalId of expiredRefKeys) this._refCounts.delete(causalId);
      this._writeWALEntry('rollback', { targetSequence });
      this._scheduleWALPersist();
      this.emit('causal-rollback', {
        targetSequence,
        removedChainEntries: removedChainEntries.length,
        removedPendingKeys,
      });
      return {
        success: true,
        targetSequence,
        removedChainEntries: removedChainEntries.length,
        removedPendingKeys,
      };
    });
  }

  /**
   * 将因果链回滚到指定时间戳，自动查找该时间戳对应的最大WAL序列号后执行回滚。
   * @param {number} targetTimestamp - 目标时间戳（毫秒）
   * @returns {Promise<{success: boolean, reason?: string}>} 回滚结果
   */
  async rollbackToTimestamp(targetTimestamp) {
    this.guardShutdown();
    try {
      await this._ensureWALReady();
    } catch (err) {
      debug('CausalDataBus', 'rollbackToTimestamp', 'WAL not ready: ' + (err && err.message ? err.message : String(err)));
      return { success: false, reason: 'wal_not_ready' };
    }
    if (typeof targetTimestamp !== 'number' || !Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
      return { success: false, reason: 'invalid_target_timestamp' };
    }
    let targetSeq = 0;
    for (const entry of this._causalChain) {
      if (entry.timestamp <= targetTimestamp && entry.walSeq > targetSeq) {
        targetSeq = entry.walSeq;
      }
    }
    if (targetSeq === 0 && this._causalChain.length > 0) {
      return { success: false, reason: 'no_chain_entry_before_target_timestamp' };
    }
    return this.rollbackToSequence(targetSeq);
  }

  /**
   * 立即将WAL状态持久化到磁盘。
   * @returns {Promise<void>}
   */
  async flush() {
    this.guardShutdown();
    try {
      await this._ensureWALReady();
      this._persistWALImmediate();
      return { success: true };
    } catch (err) {
      debug('CausalDataBus', 'flush', err && err.message ? err.message : String(err));
      try { this.emit('error', { source: 'flush', error: err }); } catch (_emitErr) { this.emit('safe-error', { source: 'flush', error: err }); }
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _incrementRefCount(causalId) {
    if (!causalId) return;
    const current = this._refCounts.get(causalId) ?? 0;
    this._refCounts.set(causalId, current + 1);
    if (this._refCounts.size > this._maxHistory * 2) {
      this._cleanupStaleRefCounts();
    }
  }

  _cleanupStaleRefCounts() {
    const activeIds = new Set(this._causalChain.map(e => e.causalId));
    const keysToDelete = [];
    for (const key of this._refCounts.keys()) {
      if (!activeIds.has(key)) keysToDelete.push(key);
    }
    for (const key of keysToDelete) this._refCounts.delete(key);
  }

  _evictCausalAware() {
    let evicted = 0;
    const scanLimit = Math.max(50, Math.floor(this._maxHistory / 2));
    while (this._causalChain.length > this._maxHistory && evicted < 10) {
      let bestIdx = -1;
      const limit = Math.min(this._causalChain.length, scanLimit);
      for (let i = 0; i < limit; i++) {
        const entry = this._causalChain[i];
        const refCount = this._refCounts.get(entry.causalId) ?? 0;
        if (refCount === 0) {
          bestIdx = i;
          break;
        }
      }
      if (bestIdx === -1) {
        let minRefCount = Infinity;
        for (let i = 0; i < limit; i++) {
          const entry = this._causalChain[i];
          const refCount = this._refCounts.get(entry.causalId) ?? 0;
          if (refCount < minRefCount) {
            minRefCount = refCount;
            bestIdx = i;
          }
        }
      }
      if (bestIdx >= 0) {
        const removed = this._causalChain.splice(bestIdx, 1)[0];
        this._refCounts.delete(removed.causalId);
        evicted++;
      } else {
        break;
      }
    }
    if (evicted > 0) {
      this.emit('causal-chain-evicted', { evicted, remaining: this._causalChain.length });
    }
  }

  /**
   * 验证因果链完整性，检查缺失的causalId、重复ID、缺失skillId和断裂的因果链接。
   * @returns {{ valid: boolean, issues: Array, chainLength: number, interfaceCount: number }} 完整性验证结果
   */
  validateChainIntegrity() {
    this.guardShutdown();
    const issues = [];
    const seenCausalIds = new Set();
    for (const entry of this._causalChain) {
      if (!entry.causalId) {
        issues.push({ type: 'missing_causal_id', skillId: entry.skillId });
      } else {
        if (seenCausalIds.has(entry.causalId)) {
          issues.push({ type: 'duplicate_causal_id', causalId: entry.causalId });
        }
        seenCausalIds.add(entry.causalId);
      }
      if (!entry.skillId) {
        issues.push({ type: 'missing_skill_id', causalId: entry.causalId });
      }
    }
    const ifaceSkillIds = new Set(this._skillInterfaces.keys());
    for (const skillId of ifaceSkillIds) {
      const iface = this._skillInterfaces.get(skillId);
      if (!iface) continue;
      for (const input of iface.causalInputs ?? []) {
        const sourceSkill = typeof input === 'object' && input !== null ? input.source : null;
        if (sourceSkill && !ifaceSkillIds.has(sourceSkill) && !this._pendingOutputs.has(sourceSkill)) {
          const hasChainEntry = this._causalChain.some(e => e.skillId === sourceSkill);
          if (!hasChainEntry) {
            issues.push({ type: 'broken_causal_link', skillId, missingSource: sourceSkill, inputName: typeof input === 'string' ? input : input.name });
          }
        }
      }
    }
    return { valid: issues.length === 0, issues, chainLength: this._causalChain.length, interfaceCount: this._skillInterfaces.size };
  }

  _shutdownWalStream() {
    if (!this._walLogStream) return;
    safeCall(() => {
      if (this._walPendingQueue && this._walPendingQueue.length > 0) {
        for (const entry of this._walPendingQueue) {
          let line;
          try { line = JSON.stringify(entry); } catch (_e) { line = JSON.stringify({ type: entry && entry.type, ts: entry && entry.ts, error: 'unserializable' }); }
          this._walLogStream.write(line + '\n');
        }
        debug('CausalDataBus', 'shutdown', 'Flushed ' + this._walPendingQueue.length + ' pending WAL entries');
      }
      const stream = this._walLogStream;
      this._walLogStream = null;
      stream.removeAllListeners();
      stream.end();
    }, 'CausalDataBus', 'walStreamShutdown');
    this._walPendingQueue = [];
    this._walDrainHandler = null;
  }

  _emergencyWriteState(suffix, precomputedState) {
    try {
      const state = precomputedState || this._serializeState();
      const statePath = path.join(this._walDir, 'causal-state.json');
      const tmpPath = statePath + '.' + suffix;
      let serialized;
      try {
        serialized = JSON.stringify(state);
      } catch (_stringifyErr) {
        const safeState = this._safeSerializeState(state);
        serialized = JSON.stringify(safeState);
      }
      fs.writeFileSync(tmpPath, serialized, 'utf8');
      try { fs.renameSync(tmpPath, statePath); } catch (_renameErr) {
        try { fs.unlinkSync(tmpPath); } catch (_e) { debug('CausalDataBus', '_onShutdown:unlinkTmp', _e && _e.message ? _e.message : String(_e)); }
      }
    } catch (_syncErr) {
      debug('CausalDataBus', '_onShutdown:syncWrite', _syncErr && _syncErr.message ? _syncErr.message : String(_syncErr));
    }
  }

  _shutdownPersister(stateSnapshot) {
    if (!this._persister) return null;
    try {
      this._emergencyWriteState('shutdown', stateSnapshot);
      const flushResult = this._persister.flush();
      this._persister = null;
      if (flushResult && typeof flushResult.then === 'function') {
        return flushResult.catch(function(err) {
          debug('CausalDataBus', 'persisterFlush', err && err.message ? err.message : String(err));
          this._emergencyWriteState('emergency', stateSnapshot);
          try { this.emit('shutdown-flush-failed', { error: err }); } catch (_emitErr) { debug('CausalDataBus', '_onShutdown:emitFlushFailed', _emitErr && _emitErr.message ? _emitErr.message : String(_emitErr)); }
        }.bind(this));
      }
    } catch (err) {
      debug('CausalDataBus', 'persisterFlush', err && err.message ? err.message : String(err));
      this._persister = null;
    }
    return null;
  }

  _shutdownSubscribers() {
    if (!this._subscribers) return;
    for (const [eventType, callbacks] of this._subscribers) {
      if (callbacks && typeof callbacks.forEach === 'function') {
        callbacks.forEach(function(cb) {
          safeCall(function() { this.removeListener(eventType, cb); }.bind(this), 'CausalDataBus', 'shutdown:removeListener');
        }.bind(this));
      }
    }
    this._subscribers.clear();
  }

  _onShutdown() {
    this._shutdownWalStream();
    const stateSnapshot = this._serializeState();
    const flushPromise = this._shutdownPersister(stateSnapshot);
    this._walOpCount = 0;
    this._walRotating = false;
    if (this._walRetryTimer) {
      clearTimeout(this._walRetryTimer);
      this._walRetryTimer = null;
    }
    const clearDataStructures = () => {
      this._causalChain.length = 0;
      this._pendingOutputs.clear();
      this._skillInterfaces.clear();
      this._conflictResolvers.clear();
      this._refCounts.clear();
      this._outputKeyIndex.clear();
      if (this._outputVersions) this._outputVersions.clear();
    };
    const cleanupAfterFlush = () => {
      this._shutdownSubscribers();
      this._sqliteStore = null;
      clearDataStructures();
      this.removeAllListeners();
    };
    if (flushPromise) {
      return flushPromise.then(cleanupAfterFlush, cleanupAfterFlush);
    }
    cleanupAfterFlush();
  }

  /**
   * 异步关闭实例，先刷写WAL待处理队列，等待日志流结束后再执行同步关闭。
   * @param {number} [timeoutMs=30000] - 关闭超时时间（毫秒）
   * @returns {Promise<void>}
   */
  shutdownAsync(timeoutMs) {
    const deadline = Date.now() + (timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    if (this._walLogStream) {
      if (this._walPendingQueue && this._walPendingQueue.length > 0) {
        safeCall(() => {
          for (const entry of this._walPendingQueue) {
            let line;
            try { line = JSON.stringify(entry); } catch (_e) { line = JSON.stringify({ type: entry && entry.type, ts: entry && entry.ts, error: 'unserializable' }); }
            this._walLogStream.write(line + '\n');
          }
          debug('CausalDataBus', 'shutdownAsync', 'Flushed ' + this._walPendingQueue.length + ' pending WAL entries');
        }, 'CausalDataBus', 'walPendingFlush');
        this._walPendingQueue = [];
      }
      return new Promise((resolve) => {
        const stream = this._walLogStream;
        this._walLogStream = null;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          cleanup();
          this.shutdown();
          resolve();
        };
        const cleanup = function() {
          clearTimeout(timeout);
          stream.removeListener('finish', finish);
          stream.removeListener('close', finish);
          stream.removeListener('error', finish);
        };
        const timeout = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup();
          this.shutdown();
          resolve();
        }, Math.max(0, deadline - Date.now()));
        if (timeout && typeof timeout.unref === 'function') timeout.unref();
        stream.on('finish', finish);
        stream.on('close', finish);
        stream.on('error', finish);
        stream.end();
      });
    }
    if (this._walPendingQueue && this._walPendingQueue.length > 0) {
      debug('CausalDataBus', 'shutdownAsync', 'WAL stream gone, discarding ' + this._walPendingQueue.length + ' pending entries');
      this._walPendingQueue = [];
    }
    this.shutdown();
    return Promise.resolve();
  }
}

CausalDataBus.MERGE_STRATEGIES = MERGE_STRATEGIES;

module.exports = withShutdown(CausalDataBus);
