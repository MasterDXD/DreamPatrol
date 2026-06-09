'use strict';

/** @module runtime/infrastructure/knowledge-base-pipeline */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const DEFAULT_ROOT_PATH = '.harness/knowledge-base';
const MAX_RAW_FILES = 1000;
const MAX_WIKI_ENTRIES = 500;
const MAX_OUTPUT_FILES = 200;
const SUPPORTED_FILE_TYPES = ['.md', '.txt', '.json', '.js', '.ts', '.py', '.go', '.rs', '.java'];
const RAW_DIR = 'raw';
const WIKI_DIR = 'wiki';
const OUTPUTS_DIR = 'outputs';
const SCHEMA_FILE = 'SCHEMA.md';

const DEFAULT_SCHEMA_CONTENT = [
  '# Knowledge Base Schema',
  '',
  '## Directory Structure',
  '',
  '- raw/ — Unprocessed source documents',
  '- wiki/ — Curated wiki entries with cross-references',
  '- outputs/ — Generated reports and analyses',
  '',
  '## Wiki Entry Format',
  '',
  'Each wiki entry follows this structure:',
  '',
  '```markdown',
  '---',
  'title: Entry Title',
  'category: category-name',
  'tags: [tag1, tag2]',
  'created: ISO-8601',
  'updated: ISO-8601',
  '---',
  '',
  '# Entry Title',
  '',
  'Content with [[cross-references]] to other entries.',
  '```',
  '',
  '## Cross-Reference Syntax',
  '',
  '- `[[Entry Name]]` — Link to another wiki entry',
  '- `[[Entry Name|Display Text]]` — Link with display text',
  '',
  '## Categories',
  '',
  '- architecture — System architecture documents',
  '- module — Module documentation',
  '- guide — How-to guides and tutorials',
  '- reference — API and configuration reference',
  '- decision — Architecture Decision Records',
  '',
].join('\n');

const URL_FILENAME_RE = /[^a-zA-Z0-9._-]/g;
const PATH_TRAVERSAL_RE = /\.\./;
const HEADING_RE = /^#{1,6}\s+(.+)$/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TAG_LINE_RE = /^tags:\s*\[([^\]]*)\]/;
const CATEGORY_LINE_RE = /^category:\s*(.+)$/;

/**
 * KnowledgeBasePipeline — Karpathy-style AI Knowledge Base pipeline.
 * Orchestrates raw/ → wiki/ → outputs/ document processing by connecting
 * RAGPipeline, LLMWiki, GraphRAG, and BrowserUseAdapter into a unified pipeline.
 *
 * @class KnowledgeBasePipeline
 * @classdesc 知识库管道。三层目录结构管理、跨引用与Schema管理
 * @extends {EventEmitter}
 * @param {Object} [options] - Configuration options
 * @param {string} [options.rootPath='.harness/knowledge-base'] - Root path for the knowledge base
 * @param {Object} [options.ragPipeline] - Reference to existing RAGPipeline instance
 * @param {Object} [options.llmWiki] - Reference to existing LLMWiki instance
 * @param {Object} [options.graphRag] - Reference to existing GraphRAG instance
 * @param {Object} [options.browserAdapter] - Reference to existing BrowserUseAdapter instance
 * @param {Object} [options.memoryStore] - Reference to existing MemoryStore
 * @param {number} [options.maxRawFiles=1000] - Max files in raw/ folder
 * @param {number} [options.maxWikiEntries=500] - Max wiki entries
 * @param {number} [options.maxOutputFiles=200] - Max files in outputs/ folder
 */
class KnowledgeBasePipeline extends EventEmitter {
  constructor(options) {
    super();
    const opts = options ?? {};
    this._rootPath = opts.rootPath || DEFAULT_ROOT_PATH;
    this._ragPipeline = opts.ragPipeline ?? null;
    this._llmWiki = opts.llmWiki ?? null;
    this._graphRag = opts.graphRag ?? null;
    this._browserAdapter = opts.browserAdapter ?? null;
    this._memoryStore = opts.memoryStore ?? null;
    this._maxRawFiles = opts.maxRawFiles ?? MAX_RAW_FILES;
    this._maxWikiEntries = opts.maxWikiEntries ?? MAX_WIKI_ENTRIES;
    this._maxOutputFiles = opts.maxOutputFiles ?? MAX_OUTPUT_FILES;
    this._rawPath = path.join(this._rootPath, RAW_DIR);
    this._wikiPath = path.join(this._rootPath, WIKI_DIR);
    this._outputsPath = path.join(this._rootPath, OUTPUTS_DIR);
    this._schemaPath = path.join(this._rootPath, SCHEMA_FILE);
    this._stats = {
      totalRawFiles: 0,
      totalWikiEntries: 0,
      totalOutputs: 0,
      totalIngestions: 0,
      totalCompilations: 0,
      totalQueries: 0,
      totalWebScrapes: 0,
    };
    this._initialized = false;
    this._initShutdownState();
  }

  /**
   * Attach a RAGPipeline instance.
   * @param {Object} pipeline - RAGPipeline instance
   */
  attachRagPipeline(pipeline) {
    this.guardShutdown();
    this._ragPipeline = pipeline;
  }

  /**
   * Attach an LLMWiki instance.
   * @param {Object} wiki - LLMWiki instance
   */
  attachLlmWiki(wiki) {
    this.guardShutdown();
    this._llmWiki = wiki;
  }

  /**
   * Attach a GraphRAG instance.
   * @param {Object} graphRag - GraphRAG instance
   */
  attachGraphRag(graphRag) {
    this.guardShutdown();
    this._graphRag = graphRag;
  }

  /**
   * Attach a BrowserUseAdapter instance.
   * @param {Object} adapter - BrowserUseAdapter instance
   */
  attachBrowserAdapter(adapter) {
    this.guardShutdown();
    this._browserAdapter = adapter;
  }

  /**
   * Attach a MemoryStore instance.
   * @param {Object} store - MemoryStore instance
   */
  attachMemoryStore(store) {
    this.guardShutdown();
    this._memoryStore = store;
  }

  /**
   * Initialize the knowledge base. Creates directory structure and SCHEMA.md if absent,
   * loads existing file counts, and emits 'initialized'.
   * @returns {Promise<void>}
   */
  async initialize() {
    this.guardShutdown();
    this._ensureDir(this._rawPath);
    this._ensureDir(this._wikiPath);
    this._ensureDir(this._outputsPath);

    if (!fs.existsSync(this._schemaPath)) {
      try { fs.writeFileSync(this._schemaPath, DEFAULT_SCHEMA_CONTENT, 'utf8'); } catch (_) { debug('schema write failed during init:', _ && _.message ? _.message : String(_)); }
    }

    this._stats.totalRawFiles = this._countFiles(this._rawPath);
    this._stats.totalWikiEntries = this._countFiles(this._wikiPath);
    this._stats.totalOutputs = this._countFiles(this._outputsPath);

    this._initialized = true;
    this.emit('initialized', { rootPath: this._rootPath });
  }

  /**
   * Ingest a raw document into the knowledge base.
   * Writes content to raw/, indexes via RAGPipeline and GraphRAG if attached.
   * @param {string} filePath - Relative file path within raw/
   * @param {string} content - Document content
   * @param {Object} [metadata] - Optional metadata
   * @returns {Promise<{filePath: string, size: number, indexed: boolean}>}
   */
  async ingestRaw(filePath, content, metadata) {
    this.guardShutdown();
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('filePath must be a non-empty string');
    }
    if (this._stats.totalRawFiles >= this._maxRawFiles) {
      throw new Error('Raw file limit reached: ' + this._maxRawFiles);
    }
    const sanitized = this._sanitizeFilePath(filePath);
    const fullPath = path.join(this._rawPath, sanitized);
    this._ensureDir(path.dirname(fullPath));

    try { fs.writeFileSync(fullPath, content, 'utf8'); } catch (e) { throw new Error('Failed to write raw file: ' + (e && e.message ? e.message : String(e)), { cause: e }); }
    const size = Buffer.byteLength(content, 'utf8');

    let indexed = false;
    if (this._ragPipeline && typeof this._ragPipeline.ingest === 'function') {
      indexed = await safeExecute(
        () => this._ragPipeline.ingest(fullPath, content, metadata),
        'KnowledgeBasePipeline', 'ingestRaw:rag', false,
      );
    }

    if (this._shutDown) return { filePath, size: 0, indexed: false, error: 'Shut down during ingestion' };

    if (this._graphRag && typeof this._graphRag.extractEntities === 'function') {
      safeCall(
        () => this._graphRag.extractEntities(fullPath, content),
        'KnowledgeBasePipeline', 'ingestRaw:graphRag',
      );
    }

    this._stats.totalRawFiles++;
    this._stats.totalIngestions++;
    this.emit('raw-ingested', { filePath: sanitized, size, indexed });
    return { filePath: sanitized, size, indexed };
  }

  /**
   * Batch ingest all supported files from a directory into raw/.
   * @param {string} dirPath - Absolute or relative directory path
   * @param {Object} [options] - Options
   * @param {boolean} [options.recursive=true] - Walk subdirectories
   * @param {number} [options.maxDepth=5] - Maximum recursion depth
   * @param {string[]} [options.fileTypes] - Supported file extensions
   * @returns {Promise<{totalFiles: number, ingested: number, skipped: number, errors: number}>}
   */
  async ingestRawDirectory(dirPath, options) {
    this.guardShutdown();
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('dirPath must be a non-empty string');
    }
    const absDir = path.resolve(dirPath);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      throw new Error('Directory does not exist: ' + absDir);
    }

    const opts = options ?? {};
    const recursive = opts.recursive !== false;
    const maxDepth = opts.maxDepth ?? 5;
    const fileTypes = opts.fileTypes || SUPPORTED_FILE_TYPES;

    const result = { totalFiles: 0, ingested: 0, skipped: 0, errors: 0 };
    const files = this._walkDirectory(absDir, recursive, maxDepth, fileTypes);
    result.totalFiles = files.length;

    for (const file of files) {
      const relPath = path.relative(absDir, file);
      const content = safeExecute(
        () => fs.readFileSync(file, 'utf8'),
        'KnowledgeBasePipeline', 'ingestRawDirectory:read', null,
      );
      if (content === null || content === undefined) {
        result.errors++;
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      if (fileTypes.indexOf(ext) === -1) {
        result.skipped++;
        continue;
      }
      try {
        await this.ingestRaw(relPath, content, { source: 'directory', originalPath: file });
        result.ingested++;
      } catch (_e) {
        debug('KnowledgeBasePipeline', 'ingestDirectory', _e && _e.message ? _e.message : String(_e));
        result.errors++;
      }
    }

    return result;
  }

  /**
   * Scrape web content into raw/ via BrowserAdapter or HTTP fetch.
   * Converts HTML to Markdown and indexes the result.
   * @param {string} url - URL to scrape
   * @param {Object} [options] - Options
   * @returns {Promise<{url: string, filePath: string, size: number}>}
   */
  async ingestWeb(url, _options) {
    this.guardShutdown();
    if (!url || typeof url !== 'string') {
      throw new Error('url must be a non-empty string');
    }
    this._validateUrl(url);
    await this._isUrlSafe(url);

    let content;
    if (this._browserAdapter && typeof this._browserAdapter.navigate === 'function') {
      const page = await safeExecute(
        () => this._browserAdapter.navigate(url),
        'KnowledgeBasePipeline', 'ingestWeb:navigate', null,
      );
      if (page && typeof page.extractContent === 'function') {
        content = await safeExecute(
          () => page.extractContent(),
          'KnowledgeBasePipeline', 'ingestWeb:extract', null,
        );
      }
    }

    if (this._shutDown) return { url, filePath: null, size: 0, error: 'Shut down during web ingestion' };

    if (!content) {
      content = await safeExecute(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        if (timeout && typeof timeout.unref === 'function') timeout.unref();
        try {
          const resp = await fetch(url, { signal: controller.signal });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const html = await resp.text();
          return this._htmlToMarkdown(html);
        } finally {
          clearTimeout(timeout);
        }
      }, 'KnowledgeBasePipeline', 'ingestWeb:fetch', null);
    }

    if (!content) {
      throw new Error('Failed to fetch content from ' + url);
    }

    const sanitized = url.replace(URL_FILENAME_RE, '_').substring(0, 120);
    const filePath = sanitized + '.md';
    const result = await this.ingestRaw(filePath, content, { source: 'web', url });

    this._stats.totalWebScrapes++;
    this.emit('web-ingested', { url, filePath: result.filePath, size: result.size });
    return { url, filePath: result.filePath, size: result.size };
  }

  /**
   * Compile raw documents into curated wiki entries.
   * Extracts metadata, creates cross-references, and updates INDEX.md.
   * @param {Object} [options] - Options
   * @param {string} [options.category] - Filter by category
   * @param {boolean} [options.forceRecompile=false] - Recompile already-processed files
   * @param {number} [options.maxFiles=50] - Maximum files to compile per call
   * @returns {Promise<{compiled: number, skipped: number, errors: number, totalWikiEntries: number}>}
   */
  async compileWiki(options) {
    this.guardShutdown();
    if (!this._initialized) {
      throw new Error('KnowledgeBasePipeline not initialized');
    }
    if (this._stats.totalWikiEntries >= this._maxWikiEntries) {
      throw new Error('Wiki entry limit reached: ' + this._maxWikiEntries);
    }

    const opts = options ?? {};
    const maxFiles = opts.maxFiles ?? 50;
    const forceRecompile = opts.forceRecompile ?? false;

    const result = { compiled: 0, skipped: 0, errors: 0, totalWikiEntries: this._stats.totalWikiEntries };

    if (!fs.existsSync(this._rawPath)) return result;

    const rawFiles = this._walkDirectory(this._rawPath, true, 10, []);
    let processed = 0;

    for (const rawFile of rawFiles) {
      if (processed >= maxFiles) break;
      processed++;

      const relPath = path.relative(this._rawPath, rawFile);
      const wikiFile = path.join(this._wikiPath, relPath);

      if (!forceRecompile && fs.existsSync(wikiFile)) {
        result.skipped++;
        continue;
      }

      const content = safeExecute(
        () => fs.readFileSync(rawFile, 'utf8'),
        'KnowledgeBasePipeline', 'compileWiki:read', null,
      );
      if (content === null || content === undefined) {
        result.errors++;
        continue;
      }

      const meta = this._extractMetadata(content);
      if (opts.category && meta.category !== opts.category) {
        result.skipped++;
        continue;
      }

      const wikiContent = this._buildWikiEntry(content, meta);
      this._ensureDir(path.dirname(wikiFile));

      const writeOk = safeExecute(
        () => fs.writeFileSync(wikiFile, wikiContent, 'utf8'),
        'KnowledgeBasePipeline', 'compileWiki:write', false,
      );
      if (!writeOk) {
        result.errors++;
        continue;
      }

      if (this._llmWiki && typeof this._llmWiki.createEntry === 'function') {
        safeCall(
          () => this._llmWiki.createEntry({
            title: meta.title,
            category: meta.category,
            tags: meta.tags,
            content: wikiContent,
            filePath: wikiFile,
          }),
          'KnowledgeBasePipeline', 'compileWiki:llmWiki',
        );
      }

      result.compiled++;
      this._stats.totalWikiEntries++;
    }

    if (this._shutDown) return { compiled: 0, skipped: 0, errors: 0, totalWikiEntries: 0, error: 'Shut down during compilation' };
    this._updateWikiIndex();
    this._stats.totalCompilations++;
    this.emit('wiki-compiled', result);
    result.totalWikiEntries = this._stats.totalWikiEntries;
    return result;
  }

  /**
   * Generate a structured output document from wiki knowledge.
   * @param {string} query - Query string
   * @param {Object} [options] - Options
   * @param {string} [options.format='report'] - Output format: 'report', 'summary', or 'analysis'
   * @param {number} [options.maxSources=10] - Maximum number of source entries
   * @returns {Promise<{outputPath: string, sources: string[], format: string}>}
   */
  async generateOutput(query, options) {
    this.guardShutdown();
    if (!this._initialized) {
      throw new Error('KnowledgeBasePipeline not initialized');
    }
    if (!query || typeof query !== 'string') {
      throw new Error('query must be a non-empty string');
    }
    if (this._stats.totalOutputs >= this._maxOutputFiles) {
      throw new Error('Output file limit reached: ' + this._maxOutputFiles);
    }

    const opts = options ?? {};
    const format = opts.format || 'report';
    const maxSources = opts.maxSources ?? 10;

    const { sources, sections } = await this._collectOutputSources(query, maxSources);

    const output = this._formatOutput(query, sections, sources, format);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(this._outputsPath, format + '-' + timestamp + '.md');
    this._ensureDir(this._outputsPath);

    try { fs.writeFileSync(outputPath, output, 'utf8'); } catch (e) { throw new Error('Failed to write output file: ' + (e && e.message ? e.message : String(e)), { cause: e }); }
    this._stats.totalOutputs++;
    this.emit('output-generated', { outputPath, sources, format });
    return { outputPath, sources, format };
  }

  /**
   * Query the knowledge base across all attached subsystems.
   * @param {string} query - Query string
   * @param {Object} [options] - Options
   * @param {number} [options.maxResults=10] - Maximum results per source
   * @param {string[]} [options.sources] - Sources to query: 'wiki', 'rag', 'graph', 'memory'
   * @returns {Promise<{results: Array, sources: Object, totalMatches: number}>}
   */
  async query(query, options) {
    this.guardShutdown();
    if (!this._initialized) {
      throw new Error('KnowledgeBasePipeline not initialized');
    }
    if (!query || typeof query !== 'string') {
      throw new Error('query must be a non-empty string');
    }

    const opts = options ?? {};
    const maxResults = opts.maxResults ?? 10;
    const enabledSources = opts.sources || ['wiki', 'rag', 'graph', 'memory'];

    const results = [];
    const sourceCounts = {};

    const sourceQueries = [
      { key: 'wiki', instance: this._llmWiki, method: 'search', label: 'query:wiki' },
      { key: 'rag', instance: this._ragPipeline, method: 'query', label: 'query:rag' },
      { key: 'graph', instance: this._graphRag, method: 'query', label: 'query:graph' },
      { key: 'memory', instance: this._memoryStore, method: 'query', label: 'query:memory' },
    ];

    for (const sq of sourceQueries) {
      if (enabledSources.indexOf(sq.key) === -1) continue;
      const items = await this._querySource(sq.instance, sq.method, query, maxResults, sq.label);
      if (items.length > 0) {
        sourceCounts[sq.key] = items.length;
        for (const r of items) results.push({ source: sq.key, ...r });
      }
    }

    if (this._shutDown) return { results: [], sources: {}, totalMatches: 0, error: 'Shut down during query' };
    const deduped = this._deduplicateResults(results);
    this._stats.totalQueries++;
    this.emit('query-executed', { query, totalMatches: deduped.length, sources: sourceCounts });
    return { results: deduped, sources: sourceCounts, totalMatches: deduped.length };
  }

  /**
   * Update the SCHEMA.md file.
   * @param {string} schemaContent - New schema content
   * @returns {Promise<void>}
   */
  async updateSchema(schemaContent) {
    this.guardShutdown();
    if (!schemaContent || typeof schemaContent !== 'string') {
      throw new Error('schemaContent must be a non-empty string');
    }
    try { fs.writeFileSync(this._schemaPath, schemaContent, 'utf8'); } catch (e) { throw new Error('Failed to write schema file: ' + (e && e.message ? e.message : String(e)), { cause: e }); }
    this.emit('schema-updated', { path: this._schemaPath });
  }

  /**
   * Get the current status of the knowledge base.
   * @returns {Promise<{initialized: boolean, rawFiles: number, wikiEntries: number, outputs: number, schemaExists: boolean, attachedModules: Object, stats: Object}>}
   */
  async getStatus() {
    this.guardShutdown();
    return {
      initialized: this._initialized,
      rawFiles: this._stats.totalRawFiles,
      wikiEntries: this._stats.totalWikiEntries,
      outputs: this._stats.totalOutputs,
      schemaExists: fs.existsSync(this._schemaPath),
      attachedModules: {
        ragPipeline: this._ragPipeline !== null,
        llmWiki: this._llmWiki !== null,
        graphRag: this._graphRag !== null,
        browserAdapter: this._browserAdapter !== null,
        memoryStore: this._memoryStore !== null,
      },
      stats: { ...this._stats },
    };
  }

  /**
   * Return pipeline statistics.
   * @returns {Object}
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * Check if the pipeline is healthy (not shut down and initialized).
   * @returns {boolean}
   */
  isHealthy() {
    return !this._shutDown && this._initialized;
  }

  async _collectOutputSources(query, maxSources) {
    const sources = [];
    const sections = [];

    if (this._llmWiki && typeof this._llmWiki.search === 'function') {
      const wikiResults = await safeExecute(
        () => this._llmWiki.search(query, { maxResults: maxSources }),
        'KnowledgeBasePipeline', 'generateOutput:wikiSearch', [],
      );
      this._appendResults(wikiResults, sources, sections, maxSources, function(r) { return r.title || r.filePath || 'unknown'; }, function(r) { return r.content || r.summary || ''; });
    }

    if (this._ragPipeline && typeof this._ragPipeline.query === 'function' && sources.length < maxSources) {
      const ragResults = await safeExecute(
        () => this._ragPipeline.query(query, { maxResults: maxSources - sources.length }),
        'KnowledgeBasePipeline', 'generateOutput:ragQuery', [],
      );
      this._appendResults(ragResults, sources, sections, maxSources, function(r) { return r.source || r.filePath || 'rag-result'; }, function(r) { return r.content || r.text || ''; });
    }

    if (sources.length === 0) {
      const scanResults = this._scanWikiFiles(query, maxSources);
      for (const r of scanResults) {
        sources.push(r.filePath);
        sections.push(r.content);
      }
    }

    return { sources, sections };
  }

  _appendResults(rawResults, sources, sections, maxSources, nameFn, contentFn) {
    if (!Array.isArray(rawResults)) return;
    for (const r of rawResults) {
      if (sources.length >= maxSources) break;
      sources.push(nameFn(r));
      sections.push(contentFn(r));
    }
  }

  async _querySource(instance, method, query, maxResults, label) {
    if (!instance || typeof instance[method] !== 'function') return [];
    const results = await safeExecute(
      () => instance[method](query, { maxResults }),
      'KnowledgeBasePipeline', label, [],
    );
    return Array.isArray(results) ? results : [];
  }

  _onShutdown() {
    this._initialized = false;
    this._ragPipeline = null;
    this._llmWiki = null;
    this._graphRag = null;
    this._browserAdapter = null;
    this._memoryStore = null;
    this._stats = {
      totalRawFiles: 0,
      totalWikiEntries: 0,
      totalOutputs: 0,
      totalIngestions: 0,
      totalCompilations: 0,
      totalQueries: 0,
      totalWebScrapes: 0,
    };
    this.removeAllListeners();
  }

  _sanitizeFilePath(filePath) {
    const normalized = path.normalize(filePath).replace(/\\/g, '/');
    if (normalized.match(PATH_TRAVERSAL_RE)) {
      throw new Error('Path traversal detected: ' + filePath);
    }
    return normalized;
  }

  _htmlToMarkdown(html) {
    if (!html || typeof html !== 'string') return '';
    let md = html;
    md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, function(_match, level, content) {
      const n = parseInt(level, 10);
      return '\n' + '#'.repeat(Number.isFinite(n) ? n : 1) + ' ' + content.replace(/<[^>]+>/g, '').trim() + '\n';
    });
    md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```');
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<[^>]+>/g, '');
    md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    md = md.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    md = md.replace(/\n{3,}/g, '\n\n');
    return md.trim();
  }

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  _extractMetadata(content) {
    const meta = { title: '', category: '', tags: [] };
    if (!content || typeof content !== 'string') return meta;

    const fmMatch = content.match(FRONTMATTER_RE);
    if (fmMatch) {
      const fm = fmMatch[1];
      const catMatch = fm.match(CATEGORY_LINE_RE);
      if (catMatch) meta.category = catMatch[1].trim();
      const tagMatch = fm.match(TAG_LINE_RE);
      if (tagMatch) {
        meta.tags = tagMatch[1].split(',').map(function(t) { return t.trim(); }).filter(Boolean);
      }
    }

    const lines = content.split('\n');
    for (const line of lines) {
      const headingMatch = line.match(HEADING_RE);
      if (headingMatch) {
        meta.title = headingMatch[1].trim();
        break;
      }
    }

    if (!meta.title) {
      meta.title = lines[0] ? lines[0].substring(0, 80).trim() : 'Untitled';
    }

    return meta;
  }

  _isUrlSafe(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return Promise.reject(new Error('Invalid URL: ' + (err && err.message ? err.message : String(err))));
    }
    const hostname = parsed.hostname;
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, (err, address) => {
        if (err) {
          reject(new Error('DNS resolution failed for ' + hostname + ': ' + (err && err.message ? err.message : String(err))));
          return;
        }
        const ip = address;
        if (
          ip === '0.0.0.0' ||
          ip.startsWith('127.') ||
          ip.startsWith('10.') ||
          /^(172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
          ip.startsWith('192.168.') ||
          ip.startsWith('169.254.') ||
          ip === '::1' ||
          ip.startsWith('fe80:') ||
          ip.startsWith('fc') ||
          ip.startsWith('fd')
        ) {
          reject(new Error('URL resolves to blocked private/internal IP: ' + ip));
          return;
        }
        resolve();
      });
    });
  }

  _validateUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Unsupported protocol: ' + parsed.protocol);
      }
    } catch (err) {
      throw new Error('Invalid URL: ' + (err && err.message ? err.message : String(err)), { cause: err });
    }
  }

  _countFiles(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (entry.isFile()) count++;
      }
      return count;
    } catch (e) {
      debug('KnowledgeBasePipeline', '_countFiles', e && e.message ? e.message : String(e));
      return 0;
    }
  }

  _walkDirectory(dirPath, recursive, maxDepth, fileTypes, currentDepth) {
    const depth = currentDepth ?? 0;
    const files = [];
    if (depth > maxDepth) return files;
    if (!fs.existsSync(dirPath)) return files;

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_e) {
      return files;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && recursive) {
        const subFiles = this._walkDirectory(fullPath, recursive, maxDepth, fileTypes, depth + 1);
        for (const f of subFiles) files.push(f);
      } else if (entry.isFile()) {
        if (fileTypes.length === 0) {
          files.push(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (fileTypes.indexOf(ext) !== -1) {
            files.push(fullPath);
          }
        }
      }
    }
    return files;
  }

  _buildWikiEntry(content, meta) {
    const lines = [
      '---',
      'title: ' + meta.title,
    ];
    if (meta.category) lines.push('category: ' + meta.category);
    if (meta.tags.length > 0) lines.push('tags: [' + meta.tags.join(', ') + ']');
    lines.push('created: ' + new Date().toISOString());
    lines.push('updated: ' + new Date().toISOString());
    lines.push('---');
    lines.push('');
    lines.push(content);
    return lines.join('\n');
  }

  _updateWikiIndex() {
    const indexPath = path.join(this._wikiPath, 'INDEX.md');
    const entries = [];

    if (!fs.existsSync(this._wikiPath)) return;

    const files = this._walkDirectory(this._wikiPath, true, 10, ['.md']);
    for (const file of files) {
      if (path.basename(file) === 'INDEX.md') continue;
      const relPath = path.relative(this._wikiPath, file);
      const content = safeExecute(
        () => fs.readFileSync(file, 'utf8'),
        'KnowledgeBasePipeline', 'updateWikiIndex:read', null,
      );
      if (content) {
        const meta = this._extractMetadata(content);
        entries.push({ title: meta.title, path: relPath, category: meta.category });
      }
    }

    const lines = ['# Knowledge Base Index', '', '## Entries', ''];
    const byCategory = new Map();
    for (const entry of entries) {
      const cat = entry.category || 'uncategorized';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(entry);
    }

    for (const [cat, catEntries] of byCategory) {
      lines.push('### ' + cat);
      lines.push('');
      for (const e of catEntries) {
        lines.push('- [[' + e.title + ']] — ' + e.path);
      }
      lines.push('');
    }

    safeCall(
      () => fs.writeFileSync(indexPath, lines.join('\n'), 'utf8'),
      'KnowledgeBasePipeline', 'updateWikiIndex:write',
    );
  }

  _scanWikiFiles(query, maxResults) {
    const results = [];
    if (!fs.existsSync(this._wikiPath)) return results;

    const files = this._walkDirectory(this._wikiPath, true, 10, ['.md']);
    const lowerQuery = query.toLowerCase();
    let count = 0;

    for (const file of files) {
      if (count >= maxResults) break;
      if (path.basename(file) === 'INDEX.md') continue;

      const content = safeExecute(
        () => fs.readFileSync(file, 'utf8'),
        'KnowledgeBasePipeline', 'scanWikiFiles:read', null,
      );
      if (content && content.toLowerCase().indexOf(lowerQuery) !== -1) {
        results.push({
          filePath: path.relative(this._wikiPath, file),
          content: content,
        });
        count++;
      }
    }

    return results;
  }

  _formatOutput(query, sections, sources, format) {
    const timestamp = new Date().toISOString();
    const lines = [];

    if (format === 'summary') {
      lines.push('# Summary: ' + query);
      lines.push('');
      lines.push('Generated: ' + timestamp);
      lines.push('Sources: ' + sources.length);
      lines.push('');
      for (let i = 0; i < sections.length; i++) {
        lines.push('## Source ' + (i + 1) + ': ' + sources[i]);
        lines.push('');
        const brief = sections[i].substring(0, 500);
        lines.push(brief + (sections[i].length > 500 ? '...' : ''));
        lines.push('');
      }
    } else if (format === 'analysis') {
      lines.push('# Analysis: ' + query);
      lines.push('');
      lines.push('Generated: ' + timestamp);
      lines.push('Sources analyzed: ' + sources.length);
      lines.push('');
      for (let i = 0; i < sections.length; i++) {
        lines.push('### ' + sources[i]);
        lines.push('');
        lines.push(sections[i]);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
      lines.push('*This analysis was auto-generated from ' + sources.length + ' knowledge base sources.*');
    } else {
      lines.push('# Report: ' + query);
      lines.push('');
      lines.push('Generated: ' + timestamp);
      lines.push('Format: report');
      lines.push('Total sources: ' + sources.length);
      lines.push('');
      for (let i = 0; i < sections.length; i++) {
        lines.push('## ' + (i + 1) + '. ' + sources[i]);
        lines.push('');
        lines.push(sections[i]);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  _deduplicateResults(results) {
    const seen = new Set();
    const deduped = [];
    for (const r of results) {
      const key = (r.title || r.filePath || r.source || '') + ':' + (r.content || r.text || '').substring(0, 100);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }
    return deduped;
  }
}

KnowledgeBasePipeline = withShutdown(KnowledgeBasePipeline);

module.exports = KnowledgeBasePipeline;
Object.assign(module.exports, {
  DEFAULT_ROOT_PATH: DEFAULT_ROOT_PATH,
  MAX_RAW_FILES: MAX_RAW_FILES,
  MAX_WIKI_ENTRIES: MAX_WIKI_ENTRIES,
  MAX_OUTPUT_FILES: MAX_OUTPUT_FILES,
  SUPPORTED_FILE_TYPES: SUPPORTED_FILE_TYPES,
  RAW_DIR: RAW_DIR,
  WIKI_DIR: WIKI_DIR,
  OUTPUTS_DIR: OUTPUTS_DIR,
  SCHEMA_FILE: SCHEMA_FILE,
});
