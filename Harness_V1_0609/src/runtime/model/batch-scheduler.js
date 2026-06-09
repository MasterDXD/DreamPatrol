'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');

const BATCH_PRIORITIES = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

const REQUEST_TYPES = {
  LONG_TEXT: 'long-text',
  SHORT_TEXT: 'short-text',
  CODE: 'code',
  TOOL_CALL: 'tool-call',
};

const DEFAULT_OPTIONS = {
  maxBatchSize: 10,
  maxQueueSize: 200,
  batchIntervalMs: 100,
  maxWaitMs: 500,
  maxConcurrentBatches: 3,
  priorityBoost: {
    'long-text': 0,
    'short-text': 1,
    'code': 0,
    'tool-call': 2,
  },
};

class BatchScheduler {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._queue = new BoundedArray(this._options.maxQueueSize);
    this._activeBatches = new BoundedMap(this._options.maxConcurrentBatches);
    this._completedBatches = new BoundedArray(100);
    this._stats = {
      requestsQueued: 0,
      batchesDispatched: 0,
      batchesCompleted: 0,
      requestsProcessed: 0,
      avgBatchSize: 0,
      avgWaitTimeMs: 0,
      byType: {},
      byPriority: {},
    };
    this._totalWaitTime = 0;
    this._totalBatchSize = 0;
  }

  enqueue(request) {
    this.guardShutdown();
    if (!request) return null;
    this._stats.requestsQueued++;
    const entry = {
      id: 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
      type: request.type ?? REQUEST_TYPES.SHORT_TEXT,
      priority: request.priority ?? BATCH_PRIORITIES.NORMAL,
      payload: request.payload ?? {},
      enqueuedAt: Date.now(),
      callback: request.callback ?? null,
    };
    const boostedPriority = entry.priority + (this._options.priorityBoost[entry.type] ?? 0);
    entry.effectivePriority = boostedPriority;
    this._stats.byType[entry.type] = (this._stats.byType[entry.type] ?? 0) + 1;
    this._stats.byPriority[entry.priority] = (this._stats.byPriority[entry.priority] ?? 0) + 1;
    this._queue.push(entry);
    return entry.id;
  }

  formBatch() {
    if (this._queue.length === 0) return null;
    const sorted = this._queue.slice().sort((a, b) => a.effectivePriority - b.effectivePriority);
    const batch = [];
    const remaining = [];
    const batchTypes = new Set();
    for (const entry of sorted) {
      if (batch.length < this._options.maxBatchSize) {
        const waitTime = Date.now() - entry.enqueuedAt;
        if (waitTime >= this._options.maxWaitMs || batch.length === 0) {
          batch.push(entry);
          batchTypes.add(entry.type);
          continue;
        }
        if (batchTypes.has(entry.type)) {
          batch.push(entry);
          continue;
        }
      }
      remaining.push(entry);
    }
    if (batch.length === 0) return null;
    this._queue = new BoundedArray(this._options.maxQueueSize);
    for (const item of remaining) {
      this._queue.push(item);
    }
    const batchId = 'batch-' + Date.now();
    const batchEntry = {
      id: batchId,
      requests: batch,
      size: batch.length,
      types: [...batchTypes],
      dispatchedAt: Date.now(),
    };
    this._activeBatches.set(batchId, batchEntry);
    this._stats.batchesDispatched++;
    this._totalBatchSize += batch.length;
    this._stats.avgBatchSize = this._totalBatchSize / this._stats.batchesDispatched;
    const totalWait = batch.reduce((sum, r) => sum + (Date.now() - r.enqueuedAt), 0);
    this._totalWaitTime += totalWait;
    this._stats.avgWaitTimeMs = this._totalWaitTime / this._stats.requestsQueued;
    return batchEntry;
  }

  completeBatch(batchId, results) {
    const batch = this._activeBatches.get(batchId);
    if (!batch) return false;
    this._activeBatches.delete(batchId);
    this._stats.batchesCompleted++;
    this._stats.requestsProcessed += batch.size;
    if (results && Array.isArray(results)) {
      for (let i = 0; i < batch.requests.length && i < results.length; i++) {
        const callback = batch.requests[i].callback;
        if (callback && typeof callback === 'function') {
          safeExecute(() => callback(results[i]));
        }
      }
    }
    this._completedBatches.push({
      id: batchId,
      size: batch.size,
      completedAt: Date.now(),
      duration: Date.now() - batch.dispatchedAt,
    });
    return true;
  }

  getQueueLength() {
    return this._queue.length;
  }

  getActiveBatchCount() {
    return this._activeBatches.size;
  }

  getStats() {
    return {
      requestsQueued: this._stats.requestsQueued,
      batchesDispatched: this._stats.batchesDispatched,
      batchesCompleted: this._stats.batchesCompleted,
      requestsProcessed: this._stats.requestsProcessed,
      avgBatchSize: Math.round(this._stats.avgBatchSize * 100) / 100,
      avgWaitTimeMs: Math.round(this._stats.avgWaitTimeMs),
      byType: Object.assign({}, this._stats.byType),
      byPriority: Object.assign({}, this._stats.byPriority),
      queueLength: this._queue.length,
      activeBatches: this._activeBatches.size,
    };
  }

  _onShutdown() {
    this._queue.shutdown();
    this._activeBatches.shutdown();
    this._completedBatches.shutdown();
  }
}

module.exports = withShutdown(BatchScheduler);
module.exports.BATCH_PRIORITIES = BATCH_PRIORITIES;
module.exports.REQUEST_TYPES = REQUEST_TYPES;
