'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { validateProjectRoot, generateId, DEFAULT_DEBOUNCE_MS , HARNESS_DIR} = require('../../utils/constants');
const { writeAtomic } = require('../../utils/debounced-persister');
const { loadJsonSync, loadJsonAsync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall, safeCallAsync } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');

const MAX_KNOWLEDGE_ENTRIES = 500;
const MAX_SESSION_SUMMARIES = 100;
const MAX_CATEGORY_LENGTH = 256;
const MAX_TITLE_LENGTH = 256;
const MAX_CONTENT_LENGTH = 1048576;
const MAX_TAGS_COUNT = 100;
const KNOWLEDGE_DIR = 'knowledge';

/**
 * @module runtime/thought/memory-store
 * @classdesc 记忆存储。长期记忆管理、遗忘曲线
 * MemoryStore — Long-term knowledge and session summary persistence with forgetting curve
 * Manages categorized knowledge entries and session summaries with atomic JSON persistence,
 * specification asset indexing, and capacity-bounded trimming that preserves spec entries.
 * @extends EventEmitter
 * @emits MemoryStore#knowledge-added
 * @emits MemoryStore#knowledge-removed
 * @emits MemoryStore#summary-added
 */
class MemoryStore extends EventEmitter {
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'MemoryStore');
    this.root = projectRoot;
    this._knowledgeDir = path.join(projectRoot, HARNESS_DIR, KNOWLEDGE_DIR);
    this._knowledgeFile = path.join(this._knowledgeDir, 'knowledge.json');
    this._summariesFile = path.join(this._knowledgeDir, 'summaries.json');
    this._knowledge = [];
    this._summaries = [];
    this._persistTimer = null;
    this._persistDirty = false;
    this._specAssetIndex = new Map();
    this._embeddingService = null;
    this._ready = false;
    this._readyPromise = this._restoreAsync().catch(err => { debug('MemoryStore', 'initError', err); });
  }

  /**
   * 获取数据恢复就绪的Promise，异步恢复完成后resolve
   * @returns {Promise<void>} 数据恢复完成的Promise
   */
  get ready() {
    return this._readyPromise;
  }

  _validateEntry(entry) {
    if (!entry || !entry.category || !entry.content) return false;
    if (typeof entry.category !== 'string' || entry.category.length > MAX_CATEGORY_LENGTH) return false;
    if (entry.title && (typeof entry.title !== 'string' || entry.title.length > MAX_TITLE_LENGTH)) return false;
    if (typeof entry.content !== 'string' || entry.content.length > MAX_CONTENT_LENGTH) return false;
    if (entry.tags && !Array.isArray(entry.tags)) return false;
    if (Array.isArray(entry.tags) && entry.tags.length > MAX_TAGS_COUNT) return false;
    return true;
  }

  _trimKnowledge() {
    while (this._knowledge.length > MAX_KNOWLEDGE_ENTRIES) {
      const idx = this._knowledge.findIndex(e => !e.specificationType);
      if (idx >= 0) { this._knowledge.splice(idx, 1); continue; }
      const orphanIdx = this._knowledge.findIndex(e => e.livenessStatus === 'orphaned');
      if (orphanIdx >= 0) { this._knowledge.splice(orphanIdx, 1); continue; }
      break;
    }
  }

  /**
   * 添加知识条目，验证后构建记录、更新规格资产索引、裁剪超限条目并调度持久化
   * @param {object} entry - 知识条目对象，需包含category(string)和content(string)，可选title、tags、source、specificationType、relatedCodePaths
   * @returns {object|null|false} 成功返回构建的记录对象；验证失败返回null；未就绪返回false
   */
  addKnowledge(entry) {
    this.guardShutdown();
    if (!this._ready) return false;
    if (!this._validateEntry(entry)) return null;
    const record = this._buildKnowledgeRecord(entry);
    this._knowledge.push(record);
    this._updateSpecAssetIndex(record);
    this._trimKnowledge();
    this._schedulePersist();
    this.emit('knowledge-added', record);
    return record;
  }

  _buildKnowledgeRecord(entry) {
    return {
      id: generateId('mem-'),
      category: entry.category,
      title: entry.title || '',
      content: entry.content,
      tags: entry.tags ?? [],
      source: entry.source ?? 'unknown',
      specificationType: entry.specificationType ?? null,
      livenessStatus: entry.specificationType ? 'alive' : null,
      relatedCodePaths: entry.relatedCodePaths ?? [],
      lastVerifiedAgainstCode: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  _updateSpecAssetIndex(record) {
    if (!record.specificationType) return;
    if (!this._specAssetIndex.has(record.specificationType)) this._specAssetIndex.set(record.specificationType, []);
    const ids = this._specAssetIndex.get(record.specificationType);
    if (ids.indexOf(record.id) === -1) ids.push(record.id);
  }

  /**
   * 按条件查询知识条目，支持category、tag、query、source、specificationType、livenessStatus、relatedCodePath过滤
   * @param {object} [filter] - 过滤条件对象，所有条件为AND关系
   * @param {string} [filter.category] - 按类别过滤
   * @param {string} [filter.tag] - 按标签过滤
   * @param {string} [filter.query] - 按关键词搜索（匹配content、title、tags）
   * @param {string} [filter.source] - 按来源过滤
   * @param {string} [filter.specificationType] - 按规格类型过滤
   * @param {string} [filter.livenessStatus] - 按存活状态过滤
   * @param {string} [filter.relatedCodePath] - 按关联代码路径过滤
   * @returns {Array<object>} 匹配的知识条目数组
   */
  queryKnowledge(filter) {
    if (!filter || typeof filter !== 'object') return this._knowledge.slice();
    let results = this._knowledge;
    if (filter.category) {
      results = results.filter(e => e.category === filter.category);
    }
    if (filter.tag) {
      results = results.filter(e => (e.tags ?? []).includes(filter.tag));
    }
    if (filter.query) {
      const q = filter.query.toLowerCase();
      results = results.filter(e =>
        (e.content || '').toLowerCase().includes(q) ||
        (e.title || '').toLowerCase().includes(q) ||
        (e.tags ?? []).some(t => t.toLowerCase().includes(q)),
      );
    }
    if (filter.source) {
      results = results.filter(e => e.source === filter.source);
    }
    if (filter.specificationType) {
      results = results.filter(function(e) { return e.specificationType === filter.specificationType; });
    }
    if (filter.livenessStatus) {
      results = results.filter(function(e) { return e.livenessStatus === filter.livenessStatus; });
    }
    if (filter.relatedCodePath) {
      results = results.filter(function(e) { return (e.relatedCodePaths ?? []).includes(filter.relatedCodePath); });
    }
    if (filter.query) {
      const semantic = this._applySemanticQuery(filter.query, results);
      if (semantic !== results) return semantic;
    }
    return results.map(entry => ({ ...entry, tags: [...(entry.tags ?? [])], relatedCodePaths: [...(entry.relatedCodePaths ?? [])] }));
  }

  _applySemanticQuery(query, results) {
    if (!this._embeddingService || typeof this._embeddingService.embed !== 'function' || typeof this._embeddingService.cosineSimilarity !== 'function') return results;
    try {
      const queryVec = this._embeddingService.embed(query);
      if (!queryVec || queryVec.then) return results;
      const scored = [];
      for (const entry of results) {
        const entryVec = this._embeddingService.embed(entry.content);
        if (entryVec && !entryVec.then) {
          const sim = this._embeddingService.cosineSimilarity(queryVec, entryVec);
          if (sim > 0.3) {
            scored.push({ entry, score: sim });
          }
        }
      }
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return scored.map(s => s.entry);
    } catch (_e) {
      debug('MemoryStore', 'queryKnowledge_semantic', _e);
    }
    return results;
  }

  /**
   * 根据ID获取单个知识条目
   * @param {string} id - 知识条目ID
   * @returns {object|null} 找到返回条目对象，未就绪或未找到返回null
   */
  getKnowledge(id) {
    if (!this._ready) return null;
    const entry = this._knowledge.find(e => e.id === id);
    return entry ? { ...entry, tags: [...entry.tags], relatedCodePaths: [...entry.relatedCodePaths] } : null;
  }

  /**
   * 更新指定ID的知识条目，支持修改content、title、tags字段
   * @param {string} id - 知识条目ID
   * @param {object} updates - 更新内容对象，可包含content(string)、title(string)、tags(Array)
   * @returns {object|null} 成功返回更新后的条目对象；未找到或验证失败返回null
   */
  updateKnowledge(id, updates) {
    this.guardShutdown();
    const idx = this._knowledge.findIndex(e => e.id === id);
    if (idx < 0) return null;
    const entry = this._knowledge[idx];
    if (updates.content !== undefined) {
      if (typeof updates.content !== 'string' || updates.content.length > MAX_CONTENT_LENGTH) return null;
    }
    if (updates.title !== undefined) {
      if (typeof updates.title !== 'string' || updates.title.length > MAX_TITLE_LENGTH) return null;
    }
    if (updates.tags) {
      if (!Array.isArray(updates.tags) || updates.tags.length > MAX_TAGS_COUNT) return null;
    }
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.title !== undefined) entry.title = updates.title;
    if (updates.tags) entry.tags = updates.tags;
    entry.updatedAt = new Date().toISOString();
    this._knowledge[idx] = entry;
    this._schedulePersist();
    this.emit('knowledge-updated', entry);
    return entry;
  }

  /**
   * 删除指定ID的知识条目，同时清理规格资产索引
   * @param {string} id - 知识条目ID
   * @returns {boolean} 删除成功返回true，未找到返回false
   */
  removeKnowledge(id) {
    this.guardShutdown();
    const idx = this._knowledge.findIndex(e => e.id === id);
    if (idx < 0) return false;
    const entry = this._knowledge[idx];
    if (entry.specificationType) {
      const ids = this._specAssetIndex.get(entry.specificationType);
      if (ids) {
        const pos = ids.indexOf(id);
        if (pos !== -1) ids.splice(pos, 1);
        if (ids.length === 0) this._specAssetIndex.delete(entry.specificationType);
      }
    }
    this._knowledge.splice(idx, 1);
    this._schedulePersist();
    this.emit('knowledge-removed', { id });
    return true;
  }

  /**
   * 附加嵌入服务实例，用于在知识查询时进行语义相似度排序
   * @param {Object} embeddingService - EmbeddingService实例，需提供embed和cosineSimilarity方法
   */
  attachEmbeddingService(embeddingService) {
    this._embeddingService = embeddingService ?? null;
  }

  /**
   * 保存或更新会话摘要，若已存在相同sessionId则覆盖
   * @param {string} sessionId - 会话ID
   * @param {object} summary - 摘要对象，可包含phase、completedSkills、keyDecisions、lessonsLearned、artifacts、tokensUsed
   * @returns {object|null} 成功返回摘要记录对象，参数无效返回null
   */
  saveSessionSummary(sessionId, summary) {
    this.guardShutdown();
    if (!sessionId || !summary) return null;

    const existing = this._summaries.findIndex(s => s.sessionId === sessionId);
    const record = {
      sessionId,
      phase: summary.phase || '',
      completedSkills: summary.completedSkills ?? [],
      keyDecisions: summary.keyDecisions ?? [],
      lessonsLearned: summary.lessonsLearned ?? [],
      artifacts: summary.artifacts ?? [],
      tokensUsed: summary.tokensUsed ?? 0,
      summarizedAt: new Date().toISOString(),
    };

    if (existing >= 0) {
      this._summaries[existing] = record;
    } else {
      this._summaries.push(record);
      if (this._summaries.length > MAX_SESSION_SUMMARIES) {
        this._summaries = this._summaries.slice(-MAX_SESSION_SUMMARIES);
      }
    }
    this._schedulePersist();
    this.emit('summary-saved', record);
    return record;
  }

  /**
   * 根据会话ID获取会话摘要
   * @param {string} sessionId - 会话ID
   * @returns {object|null} 找到返回摘要对象，未找到返回null
   */
  getSessionSummary(sessionId) {
    return this._summaries.find(s => s.sessionId === sessionId) ?? null;
  }

  /**
   * 按条件查询会话摘要，支持phase、skill、query过滤
   * @param {object} [filter] - 过滤条件对象
   * @param {string} [filter.phase] - 按执行阶段过滤
   * @param {string} [filter.skill] - 按已完成的技能过滤
   * @param {string} [filter.query] - 按关键词搜索（匹配keyDecisions和lessonsLearned）
   * @returns {Array<object>} 匹配的会话摘要数组
   */
  querySummaries(filter) {
    if (!filter || typeof filter !== 'object') return this._summaries.slice();
    let results = this._summaries;
    if (filter.phase) {
      results = results.filter(s => s.phase === filter.phase);
    }
    if (filter.skill) {
      results = results.filter(s => {
        const skills = s.completedSkills;
        return Array.isArray(skills) && skills.includes(filter.skill);
      });
    }
    if (filter.query) {
      const q = filter.query.toLowerCase();
      results = results.filter(s =>
        (s.keyDecisions ?? []).some(d => d.toLowerCase().includes(q)) ||
        (s.lessonsLearned ?? []).some(l => l.toLowerCase().includes(q)),
      );
    }
    return results.map(entry => ({ ...entry, tags: [...(entry.tags ?? [])], relatedCodePaths: [...(entry.relatedCodePaths ?? [])] }));
  }

  /**
   * 获取记忆存储的统计信息
   * @returns {object} 统计对象，包含knowledgeCount、summaryCount、categories字段
   */
  getStats() {
    const categories = {};
    for (const e of this._knowledge) {
      categories[e.category] = (categories[e.category] ?? 0) + 1;
    }
    return {
      knowledgeCount: this._knowledge.length,
      summaryCount: this._summaries.length,
      categories,
    };
  }

  async _restoreKnowledgeWith(loader) {
    await safeCallAsync(async () => {
      const data = await loader(this._knowledgeFile);
      if (Array.isArray(data)) {
        const restored = data.slice(-MAX_KNOWLEDGE_ENTRIES);
        if (this._knowledge.length > 0) {
          const existingIds = new Set(restored.map(e => e.id));
          for (const entry of this._knowledge) {
            if (!existingIds.has(entry.id)) {
              restored.push(entry);
            }
          }
          if (restored.length > MAX_KNOWLEDGE_ENTRIES) {
            restored.splice(0, restored.length - MAX_KNOWLEDGE_ENTRIES);
          }
        }
        this._knowledge = restored;
      }
    }, 'MemoryStore', '_restoreKnowledge');
  }

  async _restoreSummariesWith(loader) {
    await safeCallAsync(async () => {
      const data = await loader(this._summariesFile);
      if (Array.isArray(data)) {
        this._summaries = data.slice(-MAX_SESSION_SUMMARIES);
      }
    }, 'MemoryStore', '_restoreSummaries');
  }

  async _restoreWith(loader) {
    await this._restoreKnowledgeWith(loader);
    await this._restoreSummariesWith(loader);
    this._rebuildSpecAssetIndex();
  }

  _restore() {
    this._restoreWith(loadJsonSync);
  }

  async _restoreAsync() {
    await this._restoreWith(loadJsonAsync);
    this._ready = true;
  }

  _schedulePersist() {
    this._persistDirty = true;
    if (!this._persistTimer) {
      this._persistTimer = setTimeout(async () => {
        this._persistTimer = null;
        try {
          if (this._persistDirty) {
            if (this._readyPromise) {
              try { await this._readyPromise; } catch (_e) { debug('MemoryStore', 'persistIfDirty', _e && _e.message ? _e.message : String(_e)); return; }
            }
            if (this._shutDown) return;
            this._persistKnowledge();
            this._persistSummaries();
            this._persistDirty = false;
          }
        } catch (err) {
          debug('MemoryStore', 'persistTimer', err && err.message ? err.message : String(err));
        }
      }, DEFAULT_DEBOUNCE_MS);
      if (this._persistTimer && typeof this._persistTimer.unref === 'function') this._persistTimer.unref();
    }
  }

  /**
   * 立即将脏数据刷写到磁盘，取消待执行的防抖定时器
   * @returns {void}
   */
  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (this._persistDirty) {
      this._persistKnowledge();
      this._persistSummaries();
      this._persistDirty = false;
    }
  }

  _persistKnowledge() {
    safeCall(() => writeAtomic(this._knowledgeFile, this._knowledge), 'MemoryStore', '_persistKnowledge');
  }

  _persistSummaries() {
    safeCall(() => writeAtomic(this._summariesFile, this._summaries), 'MemoryStore', '_persistSummaries');
  }

  _onShutdown() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this.flush();
    this._knowledge = [];
    this._summaries = [];
    this._specAssetIndex.clear();
    this._embeddingService = null;
    this.removeAllListeners();
  }
}

/**
 * 更新规格资产的存活状态，标记为指定状态并记录验证路径
 * @param {string} id - 知识条目ID
 * @param {string} status - 新的存活状态（如'alive'、'orphaned'等）
 * @param {Array<string>} [verifiedPaths] - 验证过的代码路径列表
 * @returns {object|null} 成功返回更新后的条目对象，非规格条目或未找到返回null
 */
MemoryStore.prototype.updateSpecLiveness = function updateSpecLiveness(id, status, verifiedPaths) {
  const entry = this.getKnowledge(id);
  if (!entry || !entry.specificationType) return null;
  entry.livenessStatus = status;
  if (Array.isArray(verifiedPaths) && verifiedPaths.length > 0) entry.relatedCodePaths = verifiedPaths;
  entry.lastVerifiedAgainstCode = Date.now();
  this._schedulePersist();
  this.emit('spec-liveness-updated', { id: id, status: status });
  return entry;
};

/**
 * 根据规格类型获取该类型下的所有规格资产条目
 * @param {string} specType - 规格类型标识
 * @returns {Array<object>} 该规格类型下的知识条目数组
 */
MemoryStore.prototype.getSpecAssetsByType = function getSpecAssetsByType(specType) {
  const ids = this._specAssetIndex.get(specType) ?? [];
  const self = this;
  return ids.map(function(id) { return self.getKnowledge(id); }).filter(Boolean);
};

MemoryStore.prototype._rebuildSpecAssetIndex = function _rebuildSpecAssetIndex() {
  this._specAssetIndex.clear();
  for (let i = 0; i < this._knowledge.length; i++) {
    const entry = this._knowledge[i];
    if (entry.specificationType) {
      if (!this._specAssetIndex.has(entry.specificationType)) this._specAssetIndex.set(entry.specificationType, []);
      const specArr = this._specAssetIndex.get(entry.specificationType);
      if (specArr) specArr.push(entry.id);
    }
  }
};

MemoryStore.MAX_KNOWLEDGE_ENTRIES = MAX_KNOWLEDGE_ENTRIES;
MemoryStore.MAX_SESSION_SUMMARIES = MAX_SESSION_SUMMARIES;

module.exports = withShutdown(MemoryStore);
