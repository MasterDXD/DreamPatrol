/**
 * @module runtime/skill/skill-semantic-searcher
 * @description 向量嵌入驱动的语义技能搜索引擎。基于余弦相似度在技能空间中进行语义检索，
 * 支持相似技能发现、技能对比和关键词回退匹配，弥补SkillRouter仅依赖关键词匹配的不足。
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

const DEFAULT_SEMANTIC_SEARCH_CONFIG = {
  embeddingDimension: 384,
  similarityThreshold: 0.6,
  maxResults: 10,
  indexUpdateIntervalMs: 60000,
};

const SIMILARITY_METRICS = {
  COSINE: 'cosine',
  EUCLIDEAN: 'euclidean',
  DOT_PRODUCT: 'dot_product',
};

/**
 * @classdesc 向量嵌入驱动的语义技能搜索引擎，支持余弦相似度检索与关键词回退。
 * @extends EventEmitter
 * @emits 'index-built' 当语义索引构建完成时触发，载荷为 { skillCount: number }
 */
class SkillSemanticSearcher extends EventEmitter {
  /**
   * 创建SkillSemanticSearcher实例。
   * @param {Object} [config] - 配置选项
   * @param {number} [config.embeddingDimension=384] - 嵌入向量维度
   * @param {number} [config.similarityThreshold=0.6] - 最小余弦相似度阈值
   * @param {number} [config.maxResults=10] - 最大返回结果数
   * @param {number} [config.indexUpdateIntervalMs=60000] - 索引重建间隔（毫秒）
   */
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_SEMANTIC_SEARCH_CONFIG, config);
    this._embeddingService = null;
    this._skillRouter = null;
    this._skillEmbeddings = new BoundedMap(this._config.maxResults * 50);
    this._updateTimer = null;
    this._stats = {
      totalSearches: 0,
      cacheHits: 0,
      totalSimilarity: 0,
      similarityCount: 0,
    };
  }

  /**
   * 挂载外部嵌入服务（必须具有embed(text)方法）。
   * @param {Object} embeddingService - 嵌入服务实例
   * @returns {SkillSemanticSearcher} 当前实例，支持链式调用
   */
  attachEmbeddingService(embeddingService) {
    this.guardShutdown();
    if (embeddingService && typeof embeddingService.embed === 'function') {
      this._embeddingService = embeddingService;
    }
    return this;
  }

  /**
   * 挂载SkillRouter实例，用于获取技能元数据。
   * @param {Object} skillRouter - SkillRouter实例
   * @returns {SkillSemanticSearcher} 当前实例，支持链式调用
   */
  attachSkillRouter(skillRouter) {
    this.guardShutdown();
    if (skillRouter && typeof skillRouter.getSkill === 'function') {
      this._skillRouter = skillRouter;
    }
    return this;
  }

  /**
   * 从SkillRouter中所有技能构建语义索引。为每个技能生成嵌入向量并存入BoundedMap。
   * 构建完成后发射'index-built'事件，并启动定时重建计时器。
   * @returns {Promise<void>}
   */
  async buildIndex() {
    this.guardShutdown();
    if (!this._skillRouter || !this._embeddingService) return;

    const skills = this._skillRouter.skills ?? [];
    this._skillEmbeddings.clear();

    for (const skill of skills) {
      if (skill.infrastructure) continue;
      const text = this._generateSkillText(skill);
      const embedding = await Promise.resolve(this._embeddingService.embed(text));
      if (embedding && embedding.length > 0) {
        this._skillEmbeddings.set(skill.skill_id, {
          skillId: skill.skill_id,
          embedding,
          skill,
        });
      }
    }

    this.emit('index-built', { skillCount: this._skillEmbeddings.size });

    if (this._updateTimer) {
      clearInterval(this._updateTimer);
    }
    this._updateTimer = setInterval(() => {
      if (this._shutDown) return;
      safeCall(() => this.buildIndex(), 'SkillSemanticSearcher', 'auto-rebuild');
    }, this._config.indexUpdateIntervalMs);
    if (this._updateTimer && typeof this._updateTimer.unref === 'function') {
      this._updateTimer.unref();
    }
  }

  /**
   * 语义搜索：根据查询文本检索最相似的技能。
   * 无嵌入服务时回退至SkillRouter的关键词匹配。
   * @param {string} query - 查询文本
   * @param {Object} [options] - 搜索选项
   * @param {number} [options.maxResults] - 最大返回结果数
   * @param {number} [options.similarityThreshold] - 最小相似度阈值
   * @returns {Promise<Array<{skillId: string, similarity: number, skill: Object}>>}
   */
  async search(query, options) {
    this.guardShutdown();
    this._stats.totalSearches++;

    const maxResults = (options && options.maxResults) ?? this._config.maxResults;
    const threshold = (options && options.similarityThreshold) ?? this._config.similarityThreshold;

    if (!this._embeddingService || this._skillEmbeddings.size === 0) {
      return this._fallbackKeywordSearch(query, maxResults);
    }

    const queryEmbedding = await Promise.resolve(this._embeddingService.embed(query));
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return this._fallbackKeywordSearch(query, maxResults);
    }

    const results = [];
    const entries = this._skillEmbeddings.entries();
    for (const [, entry] of entries) {
      const similarity = this._cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= threshold) {
        results.push({
          skillId: entry.skillId,
          similarity,
          skill: entry.skill,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    this._updateSimilarityStats(results);

    return results.slice(0, maxResults);
  }

  /**
   * 查找与指定技能相似的其他技能。
   * @param {string} skillId - 源技能ID
   * @param {Object} [options] - 搜索选项
   * @param {number} [options.maxResults] - 最大返回结果数
   * @param {number} [options.similarityThreshold] - 最小相似度阈值
   * @returns {Promise<Array<{skillId: string, similarity: number, skill: Object}>>}
   */
  async findSimilar(skillId, options) {
    this.guardShutdown();

    const maxResults = (options && options.maxResults) ?? this._config.maxResults;
    const threshold = (options && options.similarityThreshold) ?? this._config.similarityThreshold;

    const sourceEntry = this._skillEmbeddings.get(skillId);
    if (!sourceEntry) return [];

    const results = [];
    const entries = this._skillEmbeddings.entries();
    for (const [id, entry] of entries) {
      if (id === skillId) continue;
      const similarity = this._cosineSimilarity(sourceEntry.embedding, entry.embedding);
      if (similarity >= threshold) {
        results.push({
          skillId: entry.skillId,
          similarity,
          skill: entry.skill,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, maxResults);
  }

  /**
   * 对比多个技能之间的两两相似度，返回对比矩阵。
   * @param {string[]} skillIds - 待对比的技能ID数组
   * @returns {Promise<Array<{skillA: string, skillB: string, similarity: number}>>}
   */
  async compareSkills(skillIds) {
    this.guardShutdown();
    if (!Array.isArray(skillIds) || skillIds.length < 2) return [];

    const entries = [];
    for (const id of skillIds) {
      const entry = this._skillEmbeddings.get(id);
      if (entry) entries.push(entry);
    }

    if (entries.length < 2) return [];

    const comparisons = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const similarity = this._cosineSimilarity(entries[i].embedding, entries[j].embedding);
        comparisons.push({
          skillA: entries[i].skillId,
          skillB: entries[j].skillId,
          similarity,
        });
      }
    }

    return comparisons;
  }

  /**
   * 获取搜索统计信息。
   * @returns {{ totalSearches: number, cacheHits: number, avgSimilarity: number, indexSize: number }}
   */
  getStats() {
    try {
      this.guardShutdown();
    } catch (_e) {
      return { totalSearches: 0, cacheHits: 0, avgSimilarity: 0, indexSize: 0 };
    }
    return {
      totalSearches: this._stats.totalSearches,
      cacheHits: this._stats.cacheHits,
      avgSimilarity: this._stats.similarityCount > 0
        ? this._stats.totalSimilarity / this._stats.similarityCount
        : 0,
      indexSize: this._skillEmbeddings.size,
    };
  }

  /**
   * 计算两个向量的余弦相似度。处理零向量与维度不匹配的边界情况。
   * @param {number[]} a - 向量A
   * @param {number[]} b - 向量B
   * @returns {number} 余弦相似度，范围 [-1, 1]；无效输入返回0
   */
  _cosineSimilarity(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (!Number.isFinite(denominator) || denominator === 0) return 0;
    return dotProduct / denominator;
  }

  /**
   * 从技能对象生成可搜索的文本，拼接名称、描述、标签、触发条件和适用Agent。
   * @param {Object} skill - 技能对象
   * @returns {string} 拼接后的可搜索文本
   */
  _generateSkillText(skill) {
    const parts = [];
    if (skill.name) parts.push(skill.name);
    if (skill.description) parts.push(skill.description);
    if (skill.summary) parts.push(skill.summary);
    if (Array.isArray(skill.tags)) parts.push(skill.tags.join(' '));
    if (Array.isArray(skill.trigger_conditions)) parts.push(skill.trigger_conditions.join(' '));
    if (Array.isArray(skill.applicable_agents)) parts.push(skill.applicable_agents.join(' '));
    return parts.join(' ');
  }

  /**
   * 关键词回退搜索，使用SkillRouter的现有匹配能力。
   * @param {string} query - 查询文本
   * @param {number} maxResults - 最大返回结果数
   * @returns {Promise<Array<{skillId: string, similarity: number, skill: Object}>>}
   * @private
   */
  _fallbackKeywordSearch(query, maxResults) {
    this._stats.cacheHits++;
    if (!this._skillRouter || typeof this._skillRouter.match !== 'function') return [];

    const matches = this._skillRouter.match({ userMessage: query });
    return matches.slice(0, maxResults).map((skill) => ({
      skillId: skill.skill_id,
      similarity: 0.5,
      skill,
    }));
  }

  /**
   * 更新相似度统计信息。
   * @param {Array<{similarity: number}>} results - 搜索结果
   * @private
   */
  _updateSimilarityStats(results) {
    for (const r of results) {
      this._stats.totalSimilarity += r.similarity;
      this._stats.similarityCount++;
    }
  }

  /**
   * 优雅关闭回调，清空嵌入索引、停止定时器并关闭BoundedMap。
   * @private
   */
  _onShutdown() {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
    if (this._skillEmbeddings) {
      this._skillEmbeddings.clear();
      if (typeof this._skillEmbeddings.shutdown === 'function') {
        this._skillEmbeddings.shutdown();
      }
    }
    this._embeddingService = null;
    this._skillRouter = null;
    this._stats = {
      totalSearches: 0,
      cacheHits: 0,
      totalSimilarity: 0,
      similarityCount: 0,
    };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SkillSemanticSearcher);
Object.assign(module.exports, { DEFAULT_SEMANTIC_SEARCH_CONFIG, SIMILARITY_METRICS });
