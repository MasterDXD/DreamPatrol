'use strict';

const BoundedMap = require('../../utils/bounded-map');
const EventEmitter = require('events').EventEmitter;
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const path = require('path');
const fs = require('fs');

/**
 * 支持的文档类型映射
 */
const SUPPORTED_TYPES = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.tiff': 'image',
  '.docx': 'word',
  '.xlsx': 'excel',
  '.pptx': 'powerpoint',
};

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  maxFileSize: 50 * 1024 * 1024,
  ocrEnabled: true,
  tableExtractionEnabled: true,
  maxParsedDocs: 500,
};

/**
 * @classdesc 文档解析器，支持多格式文档的解析、结构化提取和元数据抽取
 * 文档解析器 - 核心PDF/文档解析引擎
 *
 * 提供文档解析、表格提取、位置定位等功能，支持PDF、图片、Office文档等多种格式。
 * 使用BoundedMap/BoundedArray进行容量控制，集成withShutdown优雅关闭。
 *
 * @fires DocumentParser#document-parsed
 * @fires DocumentParser#table-extracted
 * @fires DocumentParser#parse-error
 */
class DocumentParser extends EventEmitter {
  /**
   * 创建文档解析器实例
   *
   * @param {Object} options - 配置选项
   * @param {string} options.projectRoot - 项目根目录
   * @param {number} [options.maxFileSize] - 最大文件大小（字节），默认50MB
   * @param {string[]} [options.supportedTypes] - 自定义支持的文件类型列表
   * @param {boolean} [options.ocrEnabled] - 是否启用OCR，默认true
   * @param {boolean} [options.tableExtractionEnabled] - 是否启用表格提取，默认true
   */
  constructor(options = {}) {
    super();
    const {
      projectRoot,
      maxFileSize = DEFAULT_CONFIG.maxFileSize,
      supportedTypes,
      ocrEnabled = DEFAULT_CONFIG.ocrEnabled,
      tableExtractionEnabled = DEFAULT_CONFIG.tableExtractionEnabled,
    } = options;

    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new Error('projectRoot必须为非空字符串');
    }

    if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
      throw new Error('maxFileSize必须为正有限数');
    }

    /** @private */
    this._projectRoot = projectRoot;
    /** @private */
    this._maxFileSize = maxFileSize;
    /** @private */
    this._supportedTypes = supportedTypes || Object.keys(SUPPORTED_TYPES);
    /** @private */
    this._ocrEnabled = ocrEnabled;
    /** @private */
    this._tableExtractionEnabled = tableExtractionEnabled;

    /** @private 已解析文档缓存 */
    this._parsedDocs = new BoundedMap(DEFAULT_CONFIG.maxParsedDocs);

    /** @private 解析队列 */
    this._parseQueue = [];

    /** @private 统计信息 */
    this._stats = {
      totalParsed: 0,
      totalErrors: 0,
      totalTablesExtracted: 0,
      byType: {},
    };

    /** @private 自增文档ID计数器 */
    this._docIdCounter = 0;

    debug('DocumentParser', `初始化完成, projectRoot=${projectRoot}, maxFileSize=${maxFileSize}, ocrEnabled=${ocrEnabled}, tableExtractionEnabled=${tableExtractionEnabled}`);
  }

  /**
   * 生成唯一文档ID
   * @private
   * @returns {string} 文档ID
   */
  _generateDocId() {
    this._docIdCounter++;
    return `doc-${Date.now()}-${this._docIdCounter}`;
  }

  /**
   * 检测文件类型
   * @private
   * @param {string} filePath - 文件路径
   * @returns {string|null} 文件类型标识，不支持时返回null
   */
  _detectFileType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_TYPES[ext] ?? null;
  }

  /**
   * 验证文件是否可解析
   * @private
   * @param {string} filePath - 文件路径
   * @returns {{ valid: boolean, error?: string, fileType?: string, fileSize?: number }}
   */
  _validateFile(filePath) {
    const resolvedPath = path.resolve(this._projectRoot, filePath);

    // 路径遍历防护：确保解析后的路径仍在项目根目录内
    if (!resolvedPath.startsWith(path.resolve(this._projectRoot) + path.sep) && resolvedPath !== path.resolve(this._projectRoot)) {
      return { valid: false, error: 'File path is outside project root' };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { valid: false, error: `文件不存在: ${filePath}` };
    }

    let stat;
    try { stat = fs.statSync(resolvedPath); } catch (_e) { debug('DocumentParser', 'stat', _e && _e.message ? _e.message : String(_e)); return { valid: false, error: '无法获取文件状态: ' + filePath }; }
    if (!stat.isFile()) {
      return { valid: false, error: `路径不是文件: ${filePath}` };
    }

    if (stat.size > this._maxFileSize) {
      return { valid: false, error: `文件大小(${stat.size})超过限制(${this._maxFileSize})` };
    }

    const fileType = this._detectFileType(resolvedPath);
    if (!fileType) {
      const ext = path.extname(resolvedPath);
      return { valid: false, error: `不支持的文件类型: ${ext}` };
    }

    if (!this._supportedTypes.includes(path.extname(resolvedPath).toLowerCase())) {
      return { valid: false, error: `文件类型未在配置的支持列表中: ${path.extname(resolvedPath)}` };
    }

    return { valid: true, fileType, fileSize: stat.size };
  }

  /**
   * 解析PDF文档（占位实现，待集成pdf-parse）
   * @private
   * @param {string} filePath - 文件路径
   * @param {Object} options - 解析选项
   * @returns {Object} 解析结果
   */
  _parsePdf(filePath, _options) {
    const fileName = path.basename(filePath);
    const pageCount = 1;

    debug('DocumentParser', `解析PDF文档: ${fileName}（占位实现）`);

    const pages = [];
    const textContent = [];
    const tables = [];

    for (let i = 1; i <= pageCount; i++) {
      pages.push({
        pageNumber: i,
        width: 595,
        height: 842,
        rotation: 0,
      });

      textContent.push({
        page: i,
        text: `[PDF页面${i}文本内容占位]`,
        position: { x: 0, y: 0, width: 595, height: 842 },
        confidence: 1.0,
      });
    }

    if (this._tableExtractionEnabled) {
      tables.push({
        page: 1,
        rows: 1,
        cols: 1,
        headers: ['列1'],
        cells: [
          [{ value: '占位数据', rowSpan: 1, colSpan: 1, confidence: 0.9 }],
        ],
        confidence: 0.9,
      });
    }

    return { pages, textContent, tables };
  }

  /**
   * 解析图片文档（占位实现，待集成tesseract）
   * @private
   * @param {string} filePath - 文件路径
   * @param {Object} options - 解析选项
   * @returns {Object} 解析结果
   */
  _parseImage(filePath, _options) {
    const fileName = path.basename(filePath);

    debug('DocumentParser', `解析图片文档: ${fileName}（占位实现）`);

    const pages = [{
      pageNumber: 1,
      width: 800,
      height: 600,
      rotation: 0,
    }];

    const textContent = [];

    if (this._ocrEnabled) {
      textContent.push({
        page: 1,
        text: '[OCR识别文本占位]',
        position: { x: 0, y: 0, width: 800, height: 600 },
        confidence: 0.8,
      });
    }

    const tables = [];

    if (this._tableExtractionEnabled) {
      tables.push({
        page: 1,
        rows: 1,
        cols: 1,
        headers: ['列1'],
        cells: [
          [{ value: 'OCR表格占位', rowSpan: 1, colSpan: 1, confidence: 0.7 }],
        ],
        confidence: 0.7,
      });
    }

    return { pages, textContent, tables };
  }

  /**
   * 解析Word文档（占位实现，待集成mammoth）
   * @private
   * @param {string} filePath - 文件路径
   * @param {Object} options - 解析选项
   * @returns {Object} 解析结果
   */
  _parseWord(filePath, _options) {
    const fileName = path.basename(filePath);

    debug('DocumentParser', `解析Word文档: ${fileName}（占位实现）`);

    const pages = [{
      pageNumber: 1,
      width: 794,
      height: 1123,
      rotation: 0,
    }];

    const textContent = [{
      page: 1,
      text: '[Word文档文本内容占位]',
      position: { x: 0, y: 0, width: 794, height: 1123 },
      confidence: 1.0,
    }];

    const tables = [];

    if (this._tableExtractionEnabled) {
      tables.push({
        page: 1,
        rows: 1,
        cols: 1,
        headers: ['列1'],
        cells: [
          [{ value: 'Word表格占位', rowSpan: 1, colSpan: 1, confidence: 0.95 }],
        ],
        confidence: 0.95,
      });
    }

    return { pages, textContent, tables };
  }

  /**
   * 解析Excel文档（占位实现，待集成xlsx）
   * @private
   * @param {string} filePath - 文件路径
   * @param {Object} options - 解析选项
   * @returns {Object} 解析结果
   */
  _parseExcel(filePath, _options) {
    const fileName = path.basename(filePath);

    debug('DocumentParser', `解析Excel文档: ${fileName}（占位实现）`);

    const pages = [{
      pageNumber: 1,
      width: 1024,
      height: 768,
      rotation: 0,
    }];

    const textContent = [];

    const tables = [];

    if (this._tableExtractionEnabled) {
      tables.push({
        page: 1,
        rows: 2,
        cols: 2,
        headers: ['列A', '列B'],
        cells: [
          [{ value: 'A1', rowSpan: 1, colSpan: 1, confidence: 1.0 }, { value: 'B1', rowSpan: 1, colSpan: 1, confidence: 1.0 }],
          [{ value: 'A2', rowSpan: 1, colSpan: 1, confidence: 1.0 }, { value: 'B2', rowSpan: 1, colSpan: 1, confidence: 1.0 }],
        ],
        confidence: 1.0,
      });
    }

    return { pages, textContent, tables };
  }

  /**
   * 解析PowerPoint文档（占位实现）
   * @private
   * @param {string} filePath - 文件路径
   * @param {Object} options - 解析选项
   * @returns {Object} 解析结果
   */
  _parsePowerPoint(filePath, _options) {
    const fileName = path.basename(filePath);

    debug('DocumentParser', `解析PowerPoint文档: ${fileName}（占位实现）`);

    const pages = [{
      pageNumber: 1,
      width: 960,
      height: 540,
      rotation: 0,
    }];

    const textContent = [{
      page: 1,
      text: '[PPT文本内容占位]',
      position: { x: 0, y: 0, width: 960, height: 540 },
      confidence: 1.0,
    }];

    const tables = [];

    return { pages, textContent, tables };
  }

  /**
   * 根据文件类型分发解析
   * @private
   * @param {string} filePath - 文件路径
   * @param {string} fileType - 文件类型标识
   * @param {Object} options - 解析选项
   * @returns {Object} 解析结果
   */
  _dispatchParse(filePath, fileType, options) {
    switch (fileType) {
      case 'pdf':
        return this._parsePdf(filePath, options);
      case 'image':
        return this._parseImage(filePath, options);
      case 'word':
        return this._parseWord(filePath, options);
      case 'excel':
        return this._parseExcel(filePath, options);
      case 'powerpoint':
        return this._parsePowerPoint(filePath, options);
      default:
        throw new Error(`不支持的文件类型: ${fileType}`);
    }
  }

  /**
   * 主解析方法 - 解析指定文件并返回结构化结果
   *
   * @param {string} filePath - 文件路径（相对于projectRoot或绝对路径）
   * @param {Object} [options={}] - 解析选项
   * @param {boolean} [options.extractTables=true] - 是否提取表格
   * @param {boolean} [options.enableOcr=true] - 是否启用OCR
   * @param {number} [options.pageStart] - 起始页码
   * @param {number} [options.pageEnd] - 结束页码
   * @returns {{ docId: string, fileName: string, fileType: string, pages: Array, tables: Array, textContent: Array, metadata: Object, parseTime: number }}
   * @throws {Error} 文件验证失败时抛出
   * @fires DocumentParser#document-parsed
   * @fires DocumentParser#parse-error
   */
  parse(filePath, options = {}) {
    this.guardShutdown();
    const startTime = Date.now();

    try {
      const validation = this._validateFile(filePath);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      const { fileType, fileSize } = validation;
      const resolvedPath = path.resolve(this._projectRoot, filePath);
      const fileName = path.basename(resolvedPath);

      debug('DocumentParser', `开始解析文件: ${fileName}, 类型: ${fileType}, 大小: ${fileSize}`);

      const parseResult = this._dispatchParse(resolvedPath, fileType, options);
      const parseTime = Date.now() - startTime;

      const docId = this._generateDocId();

      const parsedDoc = {
        docId,
        fileName,
        fileType,
        pages: parseResult.pages,
        tables: this._tableExtractionEnabled ? parseResult.tables : [],
        textContent: parseResult.textContent,
        metadata: {
          fileSize,
          parsedAt: new Date().toISOString(),
          ocrEnabled: this._ocrEnabled,
          tableExtractionEnabled: this._tableExtractionEnabled,
        },
        parseTime,
      };

      this._parsedDocs.set(docId, parsedDoc);

      this._stats.totalParsed++;
      if (!this._stats.byType[fileType]) {
        this._stats.byType[fileType] = { count: 0, totalTime: 0 };
      }
      this._stats.byType[fileType].count++;
      this._stats.byType[fileType].totalTime += parseTime;

      if (parsedDoc.tables.length > 0) {
        this._stats.totalTablesExtracted += parsedDoc.tables.length;
        for (const table of parsedDoc.tables) {
          /**
           * 表格提取事件
           * @event DocumentParser#table-extracted
           * @type {Object}
           * @property {string} docId - 文档ID
           * @property {number} page - 页码
           * @property {number} rows - 行数
           * @property {number} cols - 列数
           * @property {number} confidence - 置信度
           */
          this.emit('table-extracted', {
            docId,
            page: table.page,
            rows: table.rows,
            cols: table.cols,
            confidence: table.confidence,
          });
        }
      }

      /**
       * 文档解析完成事件
       * @event DocumentParser#document-parsed
       * @type {Object}
       * @property {string} docId - 文档ID
       * @property {string} fileName - 文件名
       * @property {string} fileType - 文件类型
       * @property {number} parseTime - 解析耗时(ms)
       */
      this.emit('document-parsed', {
        docId,
        fileName,
        fileType,
        parseTime,
      });

      debug('DocumentParser', `文件解析完成: ${fileName}, docId=${docId}, 耗时=${parseTime}ms`);

      return parsedDoc;
    } catch (error) {
      this._stats.totalErrors++;
      /**
       * 解析错误事件
       * @event DocumentParser#parse-error
       * @type {Object}
       * @property {string} filePath - 文件路径
       * @property {string} error - 错误信息
       */
      this.emit('parse-error', { filePath, error: error && error.message ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * 表格专用提取 - 从文档中提取表格数据
   *
   * @param {string} filePath - 文件路径
   * @param {Object} [pageRange={}] - 页码范围
   * @param {number} [pageRange.start] - 起始页码（从1开始）
   * @param {number} [pageRange.end] - 结束页码
   * @returns {Array<{ page: number, rows: number, cols: number, headers: Array, cells: Array<Array<{ value: *, rowSpan: number, colSpan: number, confidence: number }>>, confidence: number }>}
   * @fires DocumentParser#table-extracted
   */
  extractTables(filePath, pageRange = {}) {
    this.guardShutdown();
    try {
      const validation = this._validateFile(filePath);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      if (!this._tableExtractionEnabled) {
        throw new Error('表格提取功能未启用');
      }

      const resolvedPath = path.resolve(this._projectRoot, filePath);
      const fileType = validation.fileType;
      const parseResult = this._dispatchParse(resolvedPath, fileType, { extractTablesOnly: true });

      let tables = parseResult.tables ?? [];

      if (Number.isFinite(pageRange.start) && pageRange.start > 0) {
        tables = tables.filter(t => t.page >= pageRange.start);
      }
      if (Number.isFinite(pageRange.end) && pageRange.end > 0) {
        tables = tables.filter(t => t.page <= pageRange.end);
      }

      this._stats.totalTablesExtracted += tables.length;

      for (const table of tables) {
        this.emit('table-extracted', {
          docId: null,
          page: table.page,
          rows: table.rows,
          cols: table.cols,
          confidence: table.confidence,
        });
      }

      debug('DocumentParser', `表格提取完成: ${path.basename(resolvedPath)}, 表格数=${tables.length}`);

      return tables;
    } catch (error) {
      this._stats.totalErrors++;
      this.emit('parse-error', { filePath, error: error && error.message ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * 在文档中定位搜索词的位置，用于PDF位置追踪和高亮
   *
   * @param {string} docId - 文档ID
   * @param {string} searchTerm - 搜索词
   * @returns {{ docId: string, locations: Array<{ page: number, x: number, y: number, width: number, height: number, text: string, confidence: number }> }}
   * @throws {Error} 文档不存在时抛出
   */
  locateInDocument(docId, searchTerm) {
    this.guardShutdown();
    if (!docId || typeof docId !== 'string') {
      throw new Error('docId必须为非空字符串');
    }
    if (!searchTerm || typeof searchTerm !== 'string') {
      throw new Error('searchTerm必须为非空字符串');
    }

    const doc = this._parsedDocs.get(docId);
    if (!doc) {
      throw new Error(`文档不存在: ${docId}`);
    }

    const locations = [];
    const term = searchTerm.toLowerCase();

    for (const block of doc.textContent) {
      if (block.text && block.text.toLowerCase().includes(term)) {
        locations.push({
          page: block.page,
          x: block.position.x,
          y: block.position.y,
          width: block.position.width,
          height: block.position.height,
          text: block.text,
          confidence: block.confidence,
        });
      }
    }

    debug('DocumentParser', `定位搜索词: "${searchTerm}" in ${docId}, 找到${locations.length}处`);

    return { docId, locations };
  }

  /**
   * 获取已解析文档（防御性拷贝）
   *
   * @param {string} docId - 文档ID
   * @returns {Object|null} 文档对象的深拷贝，不存在时返回null
   */
  getDocument(docId) {
    this.guardShutdown();
    const doc = this._parsedDocs.get(docId);
    if (!doc) {
      return null;
    }

    try {
      return JSON.parse(JSON.stringify(doc));
    } catch (_e) {
      debug('DocumentParser', 'getDocument:deepClone', _e && _e.message ? _e.message : String(_e));
      return { ...doc };
    }
  }

  /**
   * 获取解析统计信息（防御性拷贝）
   *
   * @returns {{ totalParsed: number, totalErrors: number, totalTablesExtracted: number, byType: Object }}
   */
  getStats() {
    this.guardShutdown();
    try {
      return JSON.parse(JSON.stringify(this._stats));
    } catch (_e) {
      debug('DocumentParser', 'getStats:deepClone', _e && _e.message ? _e.message : String(_e));
      return { ...this._stats };
    }
  }

  /**
   * 列出支持的文件类型
   *
   * @returns {Array<{ extension: string, type: string }>}
   */
  listSupportedTypes() {
    return Object.entries(SUPPORTED_TYPES).map(([extension, type]) => ({
      extension,
      type,
    }));
  }

  /**
   * 优雅关闭 - 清理资源
   *
   * @returns {Promise<void>}
   */
  _onShutdown() {
    debug('DocumentParser', '开始关闭DocumentParser');

    this._parseQueue.length = 0;
    this._parsedDocs.shutdown();

    debug('DocumentParser', 'DocumentParser已关闭');
    this.removeAllListeners();
  }
}

module.exports = {
  DocumentParser: withShutdown(DocumentParser),
  SUPPORTED_TYPES,
  DEFAULT_CONFIG,
};
