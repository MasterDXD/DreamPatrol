'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { safeCall, safeExecute, safeDateGetTime } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { ensureDirSync, scanMarkdownDirSync, parseMarkdownFile } = require('../../utils/fs-utils');
const { UTF8_ENCODING, MARKDOWN_EXT } = require('../../utils/constants');

const DEFAULT_CONFIG = {
  categories: ['concepts', 'decisions', 'patterns', 'api', 'troubleshooting'],
  maxEntriesPerCategory: 200,
  autoIndex: true,
};

const CATEGORY_README_TEMPLATES = {
  concepts: '# Concepts\n\nCore concepts and terminology definitions.\n',
  decisions: '# Decisions\n\nArchitecture and design decisions with rationale.\n',
  patterns: '# Patterns\n\nRecurring patterns and best practices.\n',
  api: '# API\n\nAPI documentation and interface specifications.\n',
  troubleshooting: '# Troubleshooting\n\nCommon issues and their solutions.\n',
};

const VALID_CATEGORIES = new Set(DEFAULT_CONFIG.categories);
const MAX_BACKLINK_SOURCES = 100;

function _slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128);
}

function _serializeFrontmatter(meta) {
  const lines = ['---'];
  for (const key of Object.keys(meta)) {
    const val = meta[key];
    if (Array.isArray(val)) {
      lines.push(key + ':');
      for (const item of val) {
        lines.push('  - ' + String(item));
      }
    } else if (val != null) {
      lines.push(key + ': ' + String(val));
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function _entryKey(category, slug) {
  return category + '/' + slug;
}

/**
 * @module runtime/thought/llm-wiki
 * @classdesc LLM知识库。结构化知识存储、领域知识检索
 * LLMWiki — Structured knowledge base for domain knowledge storage and retrieval
 * Manages categorized wiki entries with frontmatter metadata, backlink indexing, and
 * optional embedding-based semantic search. Persists entries as Markdown files on disk.
 * @extends EventEmitter
 * @emits LLMWiki#entry-added
 * @emits LLMWiki#entry-updated
 * @emits LLMWiki#entry-removed
 */
class LLMWiki extends EventEmitter {
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._wikiRoot = null;
    this._entries = new Map();
    this._backlinkIndex = new Map();
    this._sqliteStore = null;
    this._embeddingService = null;
    this._initialized = false;
    this.removeAllListeners();
  }

  /**
   * 初始化Wiki，创建目录结构和README模板，自动加载已有条目
   * @param {string} wikiRoot - Wiki根目录的绝对路径
   * @returns {LLMWiki} 返回this以支持链式调用
   */
  initialize(wikiRoot) {
    if (this._initialized) return this;
    this.guardShutdown();
    this._wikiRoot = path.resolve(wikiRoot);
    ensureDirSync(this._wikiRoot);

    for (const category of this._config.categories) {
      const catDir = path.join(this._wikiRoot, category);
      ensureDirSync(catDir);
      const readmePath = path.join(catDir, 'README' + MARKDOWN_EXT);
      if (!fs.existsSync(readmePath)) {
        const template = CATEGORY_README_TEMPLATES[category] || ('# ' + category + '\n');
        safeCall(() => fs.writeFileSync(readmePath, template, UTF8_ENCODING), 'LLMWiki', 'init-readme');
      }
    }

    if (this._config.autoIndex) {
      this._loadAllEntries();
    }

    this._initialized = true;
    this.emit('initialized', { wikiRoot: this._wikiRoot });
    return this;
  }

  _loadAllEntries() {
    this._entries.clear();
    this._backlinkIndex.clear();

    for (const category of this._config.categories) {
      const catDir = path.join(this._wikiRoot, category);
      const files = scanMarkdownDirSync(catDir);
      for (const file of files) {
        if (file.toLowerCase() === 'readme.md') continue;
        const filePath = path.join(catDir, file);
        const parsed = parseMarkdownFile(filePath);
        if (!parsed) continue;

        const slug = file.replace(/\.md$/i, '');
        const fm = parsed.frontmatter ?? {};
        const body = parsed.body || '';
        const key = _entryKey(category, slug);

        this._entries.set(key, {
          category,
          slug,
          title: fm.title || slug,
          content: body,
          frontmatter: fm,
          filePath,
        });

        this._indexBacklinks(category, slug, body);
      }
    }
  }

  _indexBacklinks(category, slug, content) {
    const linkPattern = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = linkPattern.exec(content)) !== null) {
      const target = match[1];
      const parts = target.split('/');
      let targetKey;
      if (parts.length >= 2) {
        targetKey = _entryKey(parts[0], _slugify(parts[1]));
      } else {
        targetKey = _entryKey(category, _slugify(target));
      }
      if (!this._backlinkIndex.has(targetKey)) {
        this._backlinkIndex.set(targetKey, []);
      }
      const sources = this._backlinkIndex.get(targetKey);
      const sourceKey = _entryKey(category, slug);
      if (!sources.includes(sourceKey)) {
        sources.push(sourceKey);
      }
      if (sources.length > MAX_BACKLINK_SOURCES) {
        sources.shift();
      }
    }
  }

  /**
   * 创建新的Wiki条目，写入Markdown文件并更新索引
   * @param {string} category - 条目类别，需为有效类别（concepts/decisions/patterns/api/troubleshooting）
   * @param {string} title - 条目标题
   * @param {string} content - 条目内容（Markdown格式）
   * @param {object} [metadata] - 元数据，可包含tags、confidence、source
   * @returns {object|null} 成功返回条目对象；类别无效、条目已存在或写入失败返回null
   */
  createEntry(category, title, content, metadata) {
    if (!this._initialized) return null;
    this.guardShutdown();
    if (!VALID_CATEGORIES.has(category)) {
      debug('LLMWiki', 'createEntry', 'Invalid category: ' + category);
      return null;
    }

    const catEntries = this._listCategoryEntries(category);
    if (catEntries.length >= this._config.maxEntriesPerCategory) {
      debug('LLMWiki', 'createEntry', 'Category full: ' + category);
      return null;
    }

    const slug = _slugify(title);
    if (!slug) {
      debug('LLMWiki', 'createEntry', 'Empty slug from title: ' + title);
      return null;
    }

    const key = _entryKey(category, slug);
    if (this._entries.has(key)) {
      debug('LLMWiki', 'createEntry', 'Entry already exists: ' + key);
      return null;
    }

    const now = new Date().toISOString();
    const meta = metadata ?? {};
    const frontmatter = {
      title,
      created_at: now,
      updated_at: now,
      tags: meta.tags ?? [],
      confidence: meta.confidence !== undefined ? meta.confidence : 1.0,
      source: meta.source ?? 'manual',
    };

    const fileContent = _serializeFrontmatter(frontmatter) + '\n\n' + content;
    const catDir = path.join(this._wikiRoot, category);
    ensureDirSync(catDir);
    const filePath = path.join(catDir, slug + MARKDOWN_EXT);

    const writeResult = safeExecute(
      () => { fs.writeFileSync(filePath, fileContent, UTF8_ENCODING); return true; },
      'LLMWiki', 'createEntry-write', false,
    );
    if (!writeResult) return null;

    const entry = {
      category,
      slug,
      title,
      content,
      frontmatter,
      filePath,
    };
    this._entries.set(key, entry);
    this._indexBacklinks(category, slug, content);

    this.emit('entry-created', { category, slug, title });
    return entry;
  }

  /**
   * 更新已有Wiki条目，修改frontmatter和内容后写入磁盘并重建反向链接索引
   * @param {string} category - 条目类别
   * @param {string} slug - 条目slug标识
   * @param {object} updates - 更新内容，可包含title、tags、confidence、source、content
   * @returns {object|null} 成功返回更新后的条目对象；未找到或写入失败返回null
   */
  updateEntry(category, slug, updates) {
    if (!this._initialized) return null;
    this.guardShutdown();
    const key = _entryKey(category, slug);
    const existing = this._entries.get(key);
    if (!existing) {
      debug('LLMWiki', 'updateEntry', 'Entry not found: ' + key);
      return null;
    }

    const fm = mergeConfig(existing.frontmatter, {});
    if (updates.title !== undefined) fm.title = updates.title;
    if (updates.tags) fm.tags = updates.tags;
    if (updates.confidence !== undefined) fm.confidence = updates.confidence;
    if (updates.source !== undefined) fm.source = updates.source;
    fm.updated_at = new Date().toISOString();

    const body = updates.content !== undefined ? updates.content : existing.content;

    const fileContent = _serializeFrontmatter(fm) + '\n\n' + body;
    const writeResult = safeExecute(
      () => { fs.writeFileSync(existing.filePath, fileContent, UTF8_ENCODING); return true; },
      'LLMWiki', 'updateEntry-write', false,
    );
    if (!writeResult) return null;

    existing.frontmatter = fm;
    existing.content = body;
    existing.title = fm.title;
    this._entries.set(key, existing);

    this._rebuildBacklinkIndex();

    this.emit('entry-updated', { category, slug, title: fm.title });
    return existing;
  }

  /**
   * 搜索Wiki条目，支持标题、标签和全文匹配，按相关度评分排序
   * @param {string} query - 搜索关键词
   * @param {object} [options] - 搜索选项
   * @param {Array<string>} [options.categories] - 限定搜索的类别列表
   * @param {Array<string>} [options.tags] - 按标签过滤
   * @param {boolean} [options.fullText=true] - 是否启用全文搜索
   * @returns {Array<object>} 按评分降序排列的条目数组
   */
  search(query, options) {
    if (!this._initialized) return [];
    this.guardShutdown();
    if (!query) return [];
    const opts = options ?? {};
    const q = query.toLowerCase();
    const categories = opts.categories || this._config.categories;
    const filterTags = opts.tags ?? [];
    const fullText = opts.fullText !== false;

    const results = [];
    for (const [, entry] of this._entries) {
      if (!this._matchesSearchFilters(entry, categories, filterTags)) continue;
      const score = this._scoreEntry(entry, q, fullText);
      if (score > 0) {
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    this._applySemanticReranking(query, results);
    return results.map(r => r.entry);
  }

  _matchesSearchFilters(entry, categories, filterTags) {
    if (!categories.includes(entry.category)) return false;
    if (filterTags.length > 0) {
      const entryTags = entry.frontmatter.tags ?? [];
      const hasTag = filterTags.some(t => entryTags.includes(t));
      if (!hasTag) return false;
    }
    return true;
  }

  _scoreEntry(entry, q, fullText) {
    let score = 0;
    const titleLower = (entry.title || '').toLowerCase();
    if (titleLower.includes(q)) score += 10;

    const tags = entry.frontmatter.tags ?? [];
    for (const tag of tags) {
      if (tag.toLowerCase().includes(q)) score += 5;
    }

    if (fullText && entry.content) {
      const contentLower = entry.content.toLowerCase();
      let idx = contentLower.indexOf(q);
      while (idx !== -1) {
        score += 1;
        idx = contentLower.indexOf(q, idx + 1);
      }
    }
    return score;
  }

  _applySemanticReranking(query, results) {
    if (!this._embeddingService || typeof this._embeddingService.embed !== 'function' || typeof this._embeddingService.cosineSimilarity !== 'function' || results.length === 0) return;
    try {
      const queryVec = this._embeddingService.embed(query);
      if (!queryVec || queryVec.then) return;
      for (const r of results) {
        const entryVec = this._embeddingService.embed(r.entry.content || '');
        if (entryVec && !entryVec.then) {
          const sim = this._embeddingService.cosineSimilarity(queryVec, entryVec);
          r.score = r.score * 0.5 + sim * 10;
        }
      }
      results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } catch (_e) {
      debug('LLMWiki', 'search_semantic', _e);
    }
  }

  /**
   * 根据类别和slug获取单个Wiki条目
   * @param {string} category - 条目类别
   * @param {string} slug - 条目slug标识
   * @returns {object|null} 找到返回条目对象，未找到返回null
   */
  getEntry(category, slug) {
    if (!this._initialized) return null;
    const e = this._entries.get(_entryKey(category, slug));
    return e ? { ...e, frontmatter: { ...e.frontmatter } } : null;
  }

  /**
   * 删除指定Wiki条目，移除文件并更新索引
   * @param {string} category - 条目类别
   * @param {string} slug - 条目slug标识
   * @returns {boolean} 删除成功返回true，未找到或删除失败返回false
   */
  deleteEntry(category, slug) {
    if (!this._initialized) return false;
    this.guardShutdown();
    const key = _entryKey(category, slug);
    const existing = this._entries.get(key);
    if (!existing) {
      debug('LLMWiki', 'deleteEntry', 'Entry not found: ' + key);
      return false;
    }

    const deleteResult = safeExecute(
      () => { fs.unlinkSync(existing.filePath); return true; },
      'LLMWiki', 'deleteEntry-unlink', false,
    );
    if (!deleteResult) return false;

    this._entries.delete(key);
    this._rebuildBacklinkIndex();

    this.emit('entry-deleted', { category, slug });
    return true;
  }

  /**
   * 列出Wiki条目，可按类别过滤
   * @param {string} [category] - 按类别过滤，不传则返回所有条目
   * @returns {Array<object>} 条目数组
   */
  listEntries(category) {
    if (!this._initialized) return [];
    if (category) {
      return this._listCategoryEntries(category);
    }
    const all = [];
    for (const entry of this._entries.values()) {
      all.push(entry);
    }
    return all;
  }

  _listCategoryEntries(category) {
    const results = [];
    for (const [, entry] of this._entries) {
      if (entry.category === category) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * 获取指向指定条目的反向链接列表
   * @param {string} category - 目标条目类别
   * @param {string} slug - 目标条目slug标识
   * @returns {Array<object>} 引用该条目的源条目数组
   */
  getBacklinks(category, slug) {
    if (!this._initialized) return [];
    const key = _entryKey(category, slug);
    const sourceKeys = this._backlinkIndex.get(key) ?? [];
    const results = [];
    for (const srcKey of sourceKeys) {
      const entry = this._entries.get(srcKey);
      if (entry) results.push(entry);
    }
    return results;
  }

  /**
   * 根据上下文建议需要更新的条目，检查过期、低置信度和标题匹配
   * @param {string} context - 当前上下文文本
   * @returns {Array<object>} 建议数组，每项包含entry和reasons字段
   */
  suggestUpdates(context) {
    if (!this._initialized) return [];
    if (!context) return [];

    const results = this.search(context, { fullText: true });
    const suggestions = [];

    for (const entry of results.slice(0, 10)) {
      const reasons = [];
      const now = new Date();
      const updatedAtMs = safeDateGetTime(entry.frontmatter.updated_at);
      const ageDays = Number.isFinite(updatedAtMs) && Number.isFinite(now.getTime() - updatedAtMs) ? (now.getTime() - updatedAtMs) / (1000 * 60 * 60 * 24) : Infinity;

      if (ageDays > 30) {
        reasons.push('Entry not updated for ' + (Number.isFinite(ageDays) ? Math.floor(ageDays) : 'many') + ' days');
      }

      if (entry.frontmatter.confidence !== undefined && entry.frontmatter.confidence < 0.7) {
        reasons.push('Low confidence score: ' + entry.frontmatter.confidence);
      }

      const contextLower = context.toLowerCase();
      const titleLower = (entry.title || '').toLowerCase();
      if (titleLower.includes(contextLower)) {
        reasons.push('Direct title match with current context');
      }

      if (reasons.length > 0) {
        suggestions.push({ entry, reasons });
      }
    }

    return suggestions;
  }

  /**
   * 获取Wiki的统计信息
   * @returns {object} 统计对象，包含totalEntries、byCategory、backlinkCount、initialized字段
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('LlmWiki', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalEntries: 0, byCategory: {}, backlinkCount: 0, initialized: false }; }
    if (!this._initialized) {
      return { totalEntries: 0, byCategory: {}, backlinkCount: 0, initialized: false };
    }

    const byCategory = {};
    for (const category of this._config.categories) {
      byCategory[category] = 0;
    }
    for (const entry of this._entries.values()) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    }

    let backlinkCount = 0;
    for (const sources of this._backlinkIndex.values()) {
      backlinkCount += sources.length;
    }

    return {
      totalEntries: this._entries.size,
      byCategory,
      backlinkCount,
      initialized: true,
    };
  }

  _rebuildBacklinkIndex() {
    this._backlinkIndex.clear();
    for (const entry of this._entries.values()) {
      this._indexBacklinks(entry.category, entry.slug, entry.content);
    }
  }

  /**
   * 附加SQLite存储实例
   * @param {object} sqliteStore - SQLite存储实例
   * @returns {void}
   */
  attachSqliteStore(sqliteStore) {
    this.guardShutdown();
    this._sqliteStore = sqliteStore;
  }

  /**
   * 附加嵌入服务实例，用于语义搜索
   * @param {object} embeddingService - 嵌入服务实例
   * @returns {void}
   */
  attachEmbeddingService(embeddingService) {
    this.guardShutdown();
    this._embeddingService = embeddingService;
  }

  _onShutdown() {
    this._entries.clear();
    this._backlinkIndex.clear();
    this._sqliteStore = null;
    this._embeddingService = null;
    this._initialized = false;
    this._wikiRoot = null;
    this.removeAllListeners();
  }
}

LLMWiki.DEFAULT_CONFIG = DEFAULT_CONFIG;
LLMWiki.VALID_CATEGORIES = VALID_CATEGORIES;

module.exports = withShutdown(LLMWiki);
