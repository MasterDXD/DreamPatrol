'use strict';

const { EventEmitter } = require('events');
const { validateProjectRoot, generateId, DEFAULT_DEBOUNCE_MS } = require('../../utils/constants');
const { createPersister } = require('../../utils/debounced-persister');
const { debug } = require('../../utils/debug-logger');
const JsonStoreRestorer = require('../../utils/json-store-restorer');
const RingBuffer = require('../../utils/ring-buffer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { roundTo, safeDateGetTime } = require('../../utils/safe-execute');

const MAX_THOUGHTS = 1000;
const THOUGHTS_DIR = 'thoughts';
const CONFIDENCE_THRESHOLD = 0.7;

/**
 * @module runtime/thought/thought-memory-store
 * @classdesc 思维记忆存储。持久化思维链、快速检索
 * ThoughtMemoryStore — Persistent thought chain storage with fast retrieval
 * Stores extracted thoughts in a RingBuffer with debounced JSON persistence, optional
 * embedding generation for semantic search, and confidence-based filtering.
 * @extends EventEmitter
 * @emits ThoughtMemoryStore#thought-stored
 * @emits ThoughtMemoryStore#thoughts-restored
 */
class ThoughtMemoryStore extends EventEmitter {
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'ThoughtMemoryStore');
    this.root = projectRoot;
    this._confidenceThreshold = (options && options.confidenceThreshold) ?? CONFIDENCE_THRESHOLD;
    this._maxThoughts = (options && options.maxThoughts) ?? MAX_THOUGHTS;
    this._thoughts = new RingBuffer(this._maxThoughts);
    this.removeAllListeners();
    this._embeddingService = (options && options.embeddingService) ?? null;
    this._embeddings = new Map();
    this._persister = createPersister({
      root: projectRoot,
      dir: THOUGHTS_DIR,
      filename: 'thoughts.json',
      debounceMs: DEFAULT_DEBOUNCE_MS,
      serialize: () => this._thoughts.toArray(),
      onError: (err) => { debug('ThoughtMemoryStore', '_persist', err); },
    });
    this._restore();
  }

  /**
   * 存储单条思维记录，低于置信度阈值的将被过滤，容量满时自动淘汰最旧记录
   * @param {object} thought - 思维对象，需包含content和type字段，可选id、confidence、domain、tags、sourceTrace、mergeCount、createdAt
   * @returns {object|null} 成功返回存储的记录对象；无效或被过滤返回null
   */
  storeThought(thought) {
    this.guardShutdown();
    if (!thought || !thought.content || !thought.type) return null;
    if ((thought.confidence ?? 0) < this._confidenceThreshold) {
      debug('ThoughtMemoryStore', 'storeThought', 'filtered by confidence:', thought.confidence);
      return null;
    }

    const record = {
      id: thought.id || generateId('tht-'),
      type: thought.type,
      content: thought.content,
      confidence: thought.confidence,
      domain: thought.domain ?? 'general',
      tags: thought.tags ?? [],
      sourceTrace: thought.sourceTrace ?? {},
      mergeCount: thought.mergeCount ?? 0,
      createdAt: thought.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._evictOldestThoughtIfFull();
    this._thoughts.push(record);
    this._storeEmbedding(record);
    this._schedulePersist();
    this.emit('thought-stored', record);
    return record;
  }

  _evictOldestThoughtIfFull() {
    if (this._thoughts.size >= this._thoughts.capacity) {
      const evicted = this._thoughts.peek();
      if (evicted && evicted.id && this._embeddings.has(evicted.id)) {
        this._embeddings.delete(evicted.id);
      }
    }
  }

  _storeEmbedding(record) {
    if (!this._embeddingService) return;
    record._embeddingPending = true;
    try {
      const vector = this._embeddingService.embed(record.content);
      if (vector && typeof vector.then === 'function') {
        vector.then(function(v) { if (this._shutDown) { record._embeddingPending = false; return; } record._embeddingPending = false; if (!this.getThought(record.id)) { this._embeddings.delete(record.id); return; } this._evictEmbeddingIfFull(); this._embeddings.set(record.id, v); }.bind(this)).catch(function(e) { if (this._shutDown) { record._embeddingPending = false; return; } record._embeddingPending = false; debug('ThoughtMemoryStore', 'store', 'Embedding failed: ' + (e && e.message ? e.message : String(e))); }.bind(this));
      } else if (vector) {
        record._embeddingPending = false;
        this._evictEmbeddingIfFull();
        this._embeddings.set(record.id, vector);
      } else {
        record._embeddingPending = false;
      }
    } catch (e) { record._embeddingPending = false; debug('ThoughtMemoryStore', 'store', 'Embedding failed: ' + (e && e.message ? e.message : String(e))); }
  }

  /**
   * 批量存储思维记录，逐条调用storeThought
   * @param {Array<object>} thoughts - 思维对象数组
   * @returns {Array<object>} 成功存储的记录数组
   */
  storeThoughts(thoughts) {
    this.guardShutdown();
    if (!Array.isArray(thoughts)) return [];
    const stored = [];
    for (const thought of thoughts) {
      const record = this.storeThought(thought);
      if (record) stored.push(record);
    }
    return stored;
  }

  /**
   * 按条件检索思维记录，支持type、domain、tag、minConfidence、text、sourceTaskId过滤和confidence/recent/semantic排序
   * @param {object} [query] - 查询条件对象
   * @param {string} [query.type] - 按思维类型过滤
   * @param {string} [query.domain] - 按领域过滤
   * @param {string} [query.tag] - 按标签过滤
   * @param {number} [query.minConfidence] - 最低置信度阈值
   * @param {string} [query.text] - 按关键词搜索
   * @param {string} [query.sourceTaskId] - 按来源任务ID过滤
   * @param {string} [query.sortBy] - 排序方式，可选'confidence'、'recent'、'semantic'
   * @param {number} [query.limit] - 返回结果数量上限
   * @returns {Array<object>} 匹配的思维记录数组
   */
  retrieveThoughts(query) {
    if (this._shutDown || !this._thoughts) return [];
    if (!query) return this._thoughts.toArray();

    let results = this._thoughts.toArray();

    if (query.type) {
      results = results.filter(t => t.type === query.type);
    }
    if (query.domain) {
      results = results.filter(t => t.domain === query.domain);
    }
    if (query.tag) {
      results = results.filter(t => (t.tags ?? []).includes(query.tag));
    }
    if (query.minConfidence !== undefined) {
      results = results.filter(t => (t.confidence ?? 0) >= query.minConfidence);
    }
    if (query.text) {
      const q = query.text.toLowerCase();
      results = results.filter(t =>
        (t.content || '').toLowerCase().includes(q) ||
        (t.tags ?? []).some(tag => tag.toLowerCase().includes(q)),
      );
    }
    if (query.sourceTaskId) {
      results = results.filter(t =>
        t.sourceTrace && t.sourceTrace.taskId === query.sourceTaskId,
      );
    }

    if (query.sortBy === 'confidence') {
      results.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    } else if (query.sortBy === 'recent') {
      results.sort((a, b) => {
        const da = safeDateGetTime(a.updatedAt);
        const db = safeDateGetTime(b.updatedAt);
        const ta = Number.isFinite(da) ? da : 0;
        const tb = Number.isFinite(db) ? db : 0;
        return tb - ta;
      });
    } else if (query.sortBy === 'semantic' && this._embeddingService && query.text) {
      const queryVec = this._embeddingService.embed(query.text);
      if (queryVec && typeof queryVec.then === 'function') {
        debug('ThoughtMemoryStore', 'retrieveThoughts', 'Async embedding not supported in sync context, falling back to confidence sort');
        results.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      } else if (queryVec) {
        const scored = results.map(t => {
          const vec = this._embeddings.get(t.id);
          const sim = vec ? this._embeddingService.cosineSimilarity(queryVec, vec) : 0;
          return { thought: t, similarity: sim };
        });
        scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        results = scored.map(s => s.thought);
      }
    }

    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * 根据ID获取单条思维记录
   * @param {string} id - 思维记录ID
   * @returns {object|null} 找到返回思维对象，未找到返回null
   */
  getThought(id) {
    if (this._shutDown || !this._thoughts) return null;
    return this._thoughts.toArray().find(t => t.id === id) ?? null;
  }

  /**
   * 更新指定ID的思维记录，支持修改content、confidence、tags、domain字段
   * @param {string} id - 思维记录ID
   * @param {object} updates - 更新内容，可包含content、confidence、tags、domain
   * @returns {object|null} 成功返回更新后的思维对象，未找到返回null
   */
  updateThought(id, updates) {
    this.guardShutdown();
    const arr = this._thoughts.toArray();
    const idx = arr.findIndex(t => t.id === id);
    if (idx < 0) return null;

    const thought = arr[idx];
    if (updates.content !== undefined) {
      thought.content = updates.content;
      this._embeddings.delete(id);
      if (this._embeddingService && typeof this._embeddingService.embed === 'function') {
        this._storeEmbedding(thought);
      }
    }
    if (updates.confidence !== undefined) thought.confidence = updates.confidence;
    if (updates.tags) thought.tags = updates.tags;
    if (updates.domain !== undefined) thought.domain = updates.domain;
    thought.updatedAt = new Date().toISOString();

    const rb = new RingBuffer(this._maxThoughts);
    for (const item of arr) rb.push(item);
    this._thoughts = rb;
    this._schedulePersist();
    this.emit('thought-updated', thought);
    return thought;
  }

  /**
   * 删除指定ID的思维记录
   * @param {string} id - 思维记录ID
   * @returns {boolean} 删除成功返回true，未找到返回false
   */
  removeThought(id) {
    this.guardShutdown();
    const arr = this._thoughts.toArray();
    const idx = arr.findIndex(t => t.id === id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    const rb = new RingBuffer(this._maxThoughts);
    for (const item of arr) rb.push(item);
    this._thoughts = rb;
    if (this._embeddings.has(id)) this._embeddings.delete(id);
    this._schedulePersist();
    this.emit('thought-removed', { id });
    return true;
  }

  /**
   * 追溯思维来源，返回思维详情及其同源相关思维
   * @param {string} id - 思维记录ID
   * @returns {object|null} 追溯结果对象，包含thoughtId、thoughtType、content、confidence、sourceTrace、relatedThoughts；未找到返回null
   */
  traceSource(id) {
    const thought = this.getThought(id);
    if (!thought) return null;

    return {
      thoughtId: thought.id,
      thoughtType: thought.type,
      content: thought.content,
      confidence: thought.confidence,
      sourceTrace: thought.sourceTrace,
      relatedThoughts: this._findRelatedBySource(thought),
    };
  }

  /**
   * 获取思维记忆存储的统计信息
   * @returns {object} 统计对象，包含totalThoughts、avgConfidence、byType、byDomain字段
   */
  getStats() {
    if (this._shutDown || !this._thoughts) {
      return { totalThoughts: 0, avgConfidence: 0, byType: {}, byDomain: {} };
    }
    const byType = {};
    const byDomain = {};
    let totalConfidence = 0;

    for (const t of this._thoughts) {
      byType[t.type] = (byType[t.type] ?? 0) + 1;
      byDomain[t.domain] = (byDomain[t.domain] ?? 0) + 1;
      totalConfidence += t.confidence ?? 0;
    }

    return {
      totalThoughts: this._thoughts.size,
      avgConfidence: this._thoughts.size > 0
        ? roundTo(totalConfidence / this._thoughts.size, 3)
        : 0,
      byType,
      byDomain,
    };
  }

  _evictEmbeddingIfFull() {
    if (this._embeddings.size >= this._maxThoughts) {
      const oldestKey = this._embeddings.keys().next().value;
      if (oldestKey) this._embeddings.delete(oldestKey);
    }
  }

  _findRelatedBySource(thought) {
    if (!thought.sourceTrace) return [];
    const taskId = thought.sourceTrace.taskId;
    if (!taskId) return [];

    return this._thoughts.filter(t =>
      t.id !== thought.id &&
      t.sourceTrace &&
      t.sourceTrace.taskId === taskId,
    );
  }

  _restore() {
    const result = JsonStoreRestorer.loadSync(this.root, THOUGHTS_DIR + '/thoughts.json', {
      expectedType: 'array',
      logLabel: 'ThoughtMemoryStore',
    });
    if (result && Array.isArray(result.data)) {
      const items = result.data.slice(-this._maxThoughts);
      for (let i = 0; i < items.length; i++) {
        this._thoughts.push(items[i]);
      }
    }
  }

  _schedulePersist() {
    this._persister.schedule();
  }

  /**
   * 立即将待持久化的思维数据刷写到磁盘
   * @returns {void}
   */
  flush() {
    this._persister.flush();
  }

  _onShutdown() {
    this.flush();
    this._thoughts = null;
    this._embeddings.clear();
    this._embeddingService = null;
    this._persister = null;
    this.removeAllListeners();
  }
}

ThoughtMemoryStore.MAX_THOUGHTS = MAX_THOUGHTS;
ThoughtMemoryStore.CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;

module.exports = withShutdown(ThoughtMemoryStore);
