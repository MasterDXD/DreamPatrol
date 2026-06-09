'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { mergeConfig } = require('../../utils/safe-assign');

const FILE_TYPE_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.txt': 'text',
  '.csv': 'csv',
  '.xml': 'xml',
};

const PARSER_CATEGORY = {
  javascript: 'ast',
  typescript: 'ast',
  python: 'ast',
  go: 'ast',
  rust: 'ast',
  java: 'ast',
  ruby: 'ast',
  php: 'ast',
  c: 'ast',
  cpp: 'ast',
  markdown: 'text',
  json: 'text',
  yaml: 'text',
  toml: 'text',
  css: 'text',
  html: 'text',
  text: 'text',
  csv: 'text',
  xml: 'text',
  shell: 'text',
  sql: 'text',
  graphql: 'text',
  protobuf: 'text',
  pdf: 'multimodal',
  image: 'multimodal',
  audio: 'multimodal',
};

const DEFAULT_CONFIG = {
  maxCacheSize: 500,
  customMappings: {},
};

/**
 * @module runtime/graphify/file-type-detector
 * @classdesc 文件类型检测器。40+扩展名映射、批量检测
 */
class FileTypeDetector extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._cache = new Map();
    this._customMappings = new Map();
    this._initCustomMappings();
  }

  _initCustomMappings() {
    const customs = this._config.customMappings;
    if (!customs || typeof customs !== 'object') return;
    const keys = Object.keys(customs);
    for (let i = 0; i < keys.length; i++) {
      const ext = keys[i];
      if (ext && ext.charAt(0) === '.') {
        this._customMappings.set(ext.toLowerCase(), customs[ext]);
      }
    }
  }

  detect(filePath) {
    this.guardShutdown();
    if (!filePath || typeof filePath !== 'string') return { type: 'unknown', category: 'unknown', extension: '' };

    if (this._cache.has(filePath)) return { ...this._cache.get(filePath) };

    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return { type: 'unknown', category: 'unknown', extension: '' };

    if (this._customMappings.has(ext)) {
      const customType = this._customMappings.get(ext);
      const result = { type: customType, category: PARSER_CATEGORY[customType] || 'text', extension: ext };
      this._addToCache(filePath, result);
      return result;
    }

    const fileType = FILE_TYPE_MAP[ext];
    if (!fileType) return { type: 'unknown', category: 'unknown', extension: ext };

    const category = PARSER_CATEGORY[fileType] || 'text';
    const result = { type: fileType, category: category, extension: ext };
    this._addToCache(filePath, result);
    return result;
  }

  detectBatch(filePaths) {
    this.guardShutdown();
    if (!Array.isArray(filePaths)) return [];
    const results = [];
    for (let i = 0; i < filePaths.length; i++) {
      const fp = filePaths[i];
      results.push({ filePath: fp, ...this.detect(fp) });
    }
    return results;
  }

  getSupportedTypes() {
    const types = new Set();
    const keys = Object.keys(FILE_TYPE_MAP);
    for (let i = 0; i < keys.length; i++) {
      types.add(FILE_TYPE_MAP[keys[i]]);
    }
    return Array.from(types).sort();
  }

  getSupportedExtensions() {
    return Object.keys(FILE_TYPE_MAP).sort();
  }

  getCategoryForType(type) {
    return PARSER_CATEGORY[type] || 'text';
  }

  isAstType(type) {
    return PARSER_CATEGORY[type] === 'ast';
  }

  isMultimodalType(type) {
    return PARSER_CATEGORY[type] === 'multimodal';
  }

  _addToCache(filePath, result) {
    if (this._cache.size >= this._config.maxCacheSize) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey) this._cache.delete(oldestKey);
    }
    this._cache.set(filePath, result);
  }

  _onShutdown() {
    this._cache.clear();
    this._customMappings.clear();
    this.removeAllListeners();
  }
}

FileTypeDetector.FILE_TYPE_MAP = FILE_TYPE_MAP;
FileTypeDetector.PARSER_CATEGORY = PARSER_CATEGORY;

module.exports = withShutdown(FileTypeDetector);
