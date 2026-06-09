'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { debug } = require('../../utils/debug-logger');
const { MAX_JSON_FILE_SIZE, UTF8_ENCODING } = require('../../utils/constants');
const EmbeddingService = require('../model/embedding-service');
const CausalVectorIndex = require('../causal/causal-vector-index');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');
const { emitError } = require('../../utils/safe-execute');

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 64;
const DEFAULT_TOP_K = 5;
const MAX_DOCUMENT_SIZE = MAX_JSON_FILE_SIZE;
const MAX_DOCUMENTS = 500;
const MAX_CHUNKS = 50000;
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.js', '.ts', '.py', '.go', '.rs', '.java', '.jsx', '.tsx']);

/**
 * @module runtime/workflow/rag-pipeline
 * @classdesc RAG检索增强生成管道（RAGPipeline）。文档检索、上下文增强、生成。
 * RAGPipeline — RAG检索增强生成管道
 * Document ingestion, chunking, embedding, and vector-based retrieval pipeline for context-augmented
 * generation. Supports directory-level batch ingestion with file type filtering, configurable chunk
 * size and overlap, top-K vector search via CausalVectorIndex, and optional GraphRAG integration
 * for merging knowledge graph results with vector search results.
 * @extends EventEmitter
 * @emits document-indexed | document-removed | query-executed | error
 */
class RAGPipeline extends EventEmitter {
  /**
   * Create a RAGPipeline instance.
   * @param {string} projectRoot - Project root directory path
   * @param {Object} [options] - Configuration options
   * @param {number} [options.chunkSize=512] - Text chunk size in characters
   * @param {number} [options.chunkOverlap=64] - Overlap between consecutive chunks
   * @param {number} [options.topK=5] - Default number of results for vector search
   */
  constructor(projectRoot, options) {
    super();
    this._projectRoot = projectRoot;
    this._config = {
      chunkSize: Math.max(1, (options && options.chunkSize) || DEFAULT_CHUNK_SIZE),
      chunkOverlap: Math.max(0, (options && options.chunkOverlap) ?? DEFAULT_CHUNK_OVERLAP),
      topK: Math.max(1, (options && options.topK) || DEFAULT_TOP_K),
    };
    this._embeddingService = new EmbeddingService({ provider: 'local', dimensions: 128, cacheEnabled: true });
    this._vectorIndex = new CausalVectorIndex({ embeddingService: this._embeddingService, maxVectors: 10000 });
    this._documents = new Map();
    this._chunks = new Map();
    this._graphRAG = null;
    this._stats = { documentsIndexed: 0, chunksCreated: 0, queriesExecuted: 0 };
    this._ingestQueue = Promise.resolve();
  }

  /**
   * 附加GraphRAG实例，用于在查询时合并知识图谱结果与向量搜索结果。
   * @param {Object} graphRAG - GraphRAG实例，需实现query方法
   * @returns {RAGPipeline} this（支持链式调用）
   */
  attachGraphRAG(graphRAG) {
    if (graphRAG && typeof graphRAG.query === 'function') {
      this._graphRAG = graphRAG;
    }
    return this;
  }

  /**
   * 摄入单个文档。将文档分块、生成嵌入向量并索引。摄入操作串行排队执行。
   * 已存在的文档会先被移除再重新索引。
   * @param {string} docPath - 文档路径标识
   * @param {string} content - 文档文本内容
   * @param {Object} [metadata] - 文档元数据
   * @returns {Promise<{success: boolean, docId?: string, chunkCount?: number, error?: string}>} 摄入结果
   * @throws {TypeError} If docPath is not a valid non-empty string
   * @fires RAGPipeline#document-indexed
   */
  async ingestDocument(docPath, content, metadata) {
    this.guardShutdown();
    if (!docPath || typeof docPath !== 'string') return { success: false, error: 'docPath is required' };
    if (!content || typeof content !== 'string') return { success: false, error: 'content is required' };
    if (content.length > MAX_DOCUMENT_SIZE) return { success: false, error: 'Document too large' };

    const ingestOp = this._ingestDocumentInner.bind(this, docPath, content, metadata);
    const myPromise = this._ingestQueue.catch(function(err) { const msg = err && err.message ? err.message : String(err); debug('RagPipeline', 'ingestQueue-prev-error', msg); }).then(ingestOp)
      .catch(err => { const msg = err && err.message ? err.message : String(err); debug('RagPipeline', 'ingestQueue', msg); return { success: false, error: msg }; });
    this._ingestQueue = myPromise;
    return myPromise;
  }

  async _ingestDocumentInner(docPath, content, metadata) {
    if (this._shutDown) return { success: false, error: 'RagPipeline is shut down', docPath };
    try {
      const docId = this._generateDocId(docPath);
      if (this._documents.has(docId)) {
        this.removeDocument(docId);
      }
      const chunks = this._chunkText(content, this._config.chunkSize, this._config.chunkOverlap);
      const chunkIds = [];

      if (this._documents.size >= MAX_DOCUMENTS) {
        const oldestKey = this._documents.keys().next().value;
        if (oldestKey) this.removeDocument(oldestKey);
      }

      for (let i = 0; i < chunks.length; i++) {
        if (this._chunks.size >= MAX_CHUNKS) break;
        const chunkId = docId + '_chunk_' + i;
        const chunkMeta = safeAssign({}, metadata, { docPath: docPath, chunkIndex: i, totalChunks: chunks.length });
        const result = await this._vectorIndex.index(chunkId, chunks[i], chunkMeta);
        if (result.success) {
          this._chunks.set(chunkId, { id: chunkId, text: chunks[i], metadata: chunkMeta });
          chunkIds.push(chunkId);
          this._stats.chunksCreated++;
        }
      }

      this._documents.set(docId, {
        id: docId,
        path: docPath,
        chunkCount: chunkIds.length,
        totalChunks: chunks.length,
        chunkIds: chunkIds,
        metadata: metadata ?? {},
        indexedAt: new Date().toISOString(),
      });
      this._stats.documentsIndexed++;
      this.emit('document-indexed', { docId: docId, chunkCount: chunkIds.length });
      return { success: true, docId: docId, chunkCount: chunkIds.length };
    } catch (err) {
      debug('RAGPipeline', 'ingestDocument', err);
      emitError(this, 'error', err);
      return { success: false, error: err && err.message ? err.message : String(err), docPath };
    }
  }

  /**
   * 批量摄入目录下所有支持的文件类型。递归遍历子目录，跳过隐藏目录和node_modules。
   * @param {string} dirPath - 相对于项目根目录的目录路径
   * @param {Object} [options] - 摄入选项
   * @param {number} [options.maxDepth=10] - 最大递归深度
   * @returns {Promise<{success: boolean, results: {ingested: number, failed: number, skipped: number}}>} 批量摄入结果
   */
  async ingestDirectory(dirPath, options) {
    this.guardShutdown();
    const resolvedPath = path.resolve(this._projectRoot, dirPath);
    if (!resolvedPath.startsWith(this._projectRoot + path.sep) && resolvedPath !== this._projectRoot) {
      return { success: false, error: 'Directory path must be within project root' };
    }
    try {
      await fs.promises.access(resolvedPath);
    } catch (_e) {
      return { success: false, error: 'Directory not found: ' + dirPath + ': ' + (_e && _e.message ? _e.message : String(_e)) };
    }

    const maxDepth = (options && options.maxDepth) ?? 10;
    const results = { ingested: 0, failed: 0, skipped: 0 };
    const self = this;
    const promises = [];

    async function walk(dir, depth, visited) {
      if (depth > maxDepth) return;
      let realDir;
      try { realDir = await fs.promises.realpath(dir); } catch (_e) { debug('RagPipeline', 'realpath', _e && _e.message ? _e.message : String(_e)); return; }
      if (visited.has(realDir)) return;
      visited.add(realDir);
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { debug('RAGPipeline', 'walkDir', e); return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          try {
            await walk(fullPath, depth + 1, visited);
          } catch (e) {
            debug('RAGPipeline', 'walkRecurse', e);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!SUPPORTED_EXTENSIONS.has(ext)) { results.skipped++; continue; }
          try {
            const content = await fs.promises.readFile(fullPath, UTF8_ENCODING);
            const relativePath = path.relative(self._projectRoot, fullPath).replace(/\\/g, '/');
            promises.push(
              self.ingestDocument(relativePath, content, { extension: ext, fileName: entry.name })
                .then(function(r) {
                  if (r.success) results.ingested++; else results.failed++;
                })
                .catch(function(err) { results.failed++; debug('RAGPipeline', 'ingestDirectory', 'Ingestion failed: ' + (err && err.message ? err.message : String(err))); }),
            );
          } catch (_e) {
            debug('RAGPipeline', 'ingestSync', _e && _e.message ? _e.message : String(_e));
            results.failed++; }
        }
      }
    }

    try {
      await walk(resolvedPath, 0, new Set());
    } catch (e) {
      debug('RAGPipeline', 'ingestDirectory:walk', e);
    }
    const settled = await Promise.allSettled(promises);
    if (this._shutDown) return { success: false, error: 'shutdown', results };
    for (const r of settled) {
      if (r.status === 'rejected') {
        debug('RAGPipeline', 'ingestDirectory:promises', r.reason);
      }
    }
    return { success: true, results: results };
  }

  /**
   * 执行RAG查询。先进行向量搜索，再合并GraphRAG结果（如已附加）。
   * @param {string} queryText - 查询文本
   * @param {Object} [options] - 查询选项
   * @param {number} [options.topK] - 返回的最大结果数
   * @returns {Promise<{success: boolean, query?: string, results?: Array<{id: string, score: number, text: string, metadata: Object}>, error?: string}>} 查询结果
   * @fires RAGPipeline#query-executed
   */
  async query(queryText, options) {
    this.guardShutdown();
    if (!queryText || typeof queryText !== 'string') return { success: false, error: 'queryText is required' };

    try {
      const topK = (options && options.topK) || this._config.topK;
      this._stats.queriesExecuted++;

      const results = await this._vectorQuery(queryText, topK);

      if (this._shutDown) return { success: false, error: 'shutdown' };

      this.emit('query-executed', { query: queryText, resultCount: results.length });

      await this._mergeGraphRAGResults(queryText, topK, results);

      return { success: true, query: queryText, results: results };
    } catch (err) {
      debug('RAGPipeline', 'query', err);
      emitError(this, 'error', err);
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _vectorQuery(queryText, topK) {
    try {
      const searchResults = await this._vectorIndex.query(queryText, { topK });
      if (!Array.isArray(searchResults)) return [];
      return searchResults.map(function(r) {
        const chunk = r.causalId ? this._chunks.get(r.causalId) : null;
        return {
          id: r.causalId,
          score: r.similarity ?? 0,
          text: chunk ? chunk.text : (r.text || ''),
          metadata: chunk ? chunk.metadata : (r.metadata ?? {}),
        };
      }.bind(this));
    } catch (err) {
      debug('RAGPipeline', '_vectorQuery', err);
      return [];
    }
  }

  async _mergeGraphRAGResults(queryText, topK, results) {
    if (!this._graphRAG) return;
    try {
      const graphResults = await this._graphRAG.query(queryText, { topK: Math.min(topK, 3) });
      if (!graphResults || !graphResults.success || !graphResults.results || graphResults.results.length === 0) return;
      for (const gr of graphResults.results) {
        if (!results.some(r => r.id === gr.entityId)) {
          results.push({
            id: gr.entityId ?? 'graph_' + results.length,
            score: Math.min(Number.isFinite(gr.score) ? gr.score : 0.3, 0.8),
            text: gr.entity ? (gr.entity.name + ': ' + (gr.entity.type || '')) : '',
            metadata: { source: 'graph-rag', documentIds: gr.documentIds ?? [] },
          });
        }
      }
    } catch (graphErr) {
      debug('RagPipeline', 'graphRAGQuery', graphErr);
    }
  }

  /**
   * 获取RAG管道的统计信息，包括文档数、分块数、查询数和子组件统计。
   * @returns {{ documentsIndexed: number, chunksCreated: number, queriesExecuted: number, vectorIndexStats: Object, embeddingStats: Object }}
   */
  getStats() {
    return {
      documentsIndexed: this._stats.documentsIndexed,
      chunksCreated: this._stats.chunksCreated,
      queriesExecuted: this._stats.queriesExecuted,
      vectorIndexStats: this._vectorIndex.getStats(),
      embeddingStats: this._embeddingService.getStats(),
    };
  }

  /**
   * 移除指定文档及其所有分块，从向量索引中删除对应条目。
   * @param {string} docId - 文档ID
   * @returns {boolean} 文档是否存在并被移除
   * @fires RAGPipeline#document-removed
   */
  removeDocument(docId) {
    this.guardShutdown();
    const doc = this._documents.get(docId);
    if (!doc) return false;
    for (const chunkId of doc.chunkIds) {
      this._vectorIndex.remove(chunkId);
      this._chunks.delete(chunkId);
    }
    this._documents.delete(docId);
    this.emit('document-removed', { docId: docId });
    return true;
  }

  _chunkText(text, chunkSize, overlap) {
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) chunkSize = 1000;
    if (!Number.isFinite(overlap) || overlap < 0) overlap = 100;
    if (!text || text.length <= chunkSize) return text ? [text] : [];
    overlap = Math.max(0, Math.min(overlap, chunkSize - 1));
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = start + chunkSize;
      if (end < text.length) {
        const lastNewline = text.lastIndexOf('\n', end);
        if (lastNewline > start + chunkSize * 0.5) end = lastNewline;
      }
      chunks.push(text.substring(start, end));
      const nextStart = end - overlap;
      if (nextStart <= start) break;
      start = nextStart;
    }
    return chunks;
  }

  _generateDocId(docPath) {
    const sanitized = docPath.replace(/[^a-zA-Z0-9_/-]/g, '_').substring(0, 80);
    let hash = 0;
    for (let i = 0; i < docPath.length; i++) {
      hash = ((hash << 5) - hash + docPath.charCodeAt(i)) | 0;
    }
    return 'doc_' + sanitized + '_' + (hash >>> 0).toString(36);
  }

  _onShutdown() {
    this._ingestQueue = Promise.resolve();
    this._documents.clear();
    this._chunks.clear();
    if (this._embeddingService && typeof this._embeddingService.shutdown === 'function' && !this._embeddingService._shutDown) {
      try {
        const result = this._embeddingService.shutdown();
        if (result && typeof result.catch === 'function') result.catch(function(e) { debug('RagPipeline', 'shutdownEmbedding', e); });
      } catch (_) { debug('RagPipeline', 'shutdownEmbedding', _); }
    }
    if (this._vectorIndex && typeof this._vectorIndex.shutdown === 'function' && !this._vectorIndex._shutDown) {
      try {
        const result = this._vectorIndex.shutdown();
        if (result && typeof result.catch === 'function') result.catch(function(e) { debug('RagPipeline', 'shutdownVectorIndex', e); });
      } catch (_) { debug('RagPipeline', 'shutdownVectorIndex', _); }
    }
    this.removeAllListeners();
  }
}

module.exports = withShutdown(RAGPipeline);
