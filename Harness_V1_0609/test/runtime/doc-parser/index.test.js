'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const docParserModule = require(path.join(ROOT, 'src', 'runtime', 'doc-parser'));
const { DocumentParser } = docParserModule.DocumentParser;
const ExtractionAgent = docParserModule.ExtractionAgent;
const DatabaseAdapter = docParserModule.DatabaseAdapter;

// ─── 辅助工具 ──────────────────────────────────────────

/**
 * 创建临时测试文件
 * @param {string} ext - 文件扩展名（含点号）
 * @param {string} content - 文件内容
 * @returns {string} 文件绝对路径
 */
function _createTempFile(ext, content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-parser-test-'));
  const filePath = path.join(tmpDir, 'test-file' + ext);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * 递归删除临时目录
 * @param {string} dirPath - 目录路径
 */
function cleanupDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * 从文件路径提取所在目录
 * @param {string} filePath - 文件路径
 * @returns {string} 目录路径
 */
function _parentDir(filePath) {
  return path.dirname(filePath);
}

// ─── DocumentParser 测试 ───────────────────────────────

describe('DocumentParser', () => {
  let parser;
  let _tmpFilePath;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-test-'));
    parser = new DocumentParser({ projectRoot: tmpDir });
  });

  afterEach(async () => {
    if (parser && parser.isHealthy()) {
      await parser.shutdown();
    }
    cleanupDir(tmpDir);
  });

  it('should construct with default options', () => {
    assert.ok(parser);
    assert.equal(parser._projectRoot, tmpDir);
    assert.equal(parser._ocrEnabled, true);
    assert.equal(parser._tableExtractionEnabled, true);
  });

  it('should throw if projectRoot is missing', () => {
    assert.throws(() => new DocumentParser(), /projectRoot必须为非空字符串/);
  });

  it('should throw if projectRoot is empty string', () => {
    assert.throws(() => new DocumentParser({ projectRoot: '' }), /projectRoot必须为非空字符串/);
  });

  it('should throw if maxFileSize is invalid', () => {
    assert.throws(() => new DocumentParser({ projectRoot: tmpDir, maxFileSize: -1 }), /maxFileSize必须为正有限数/);
  });

  it('should listSupportedTypes() return expected types', () => {
    const types = parser.listSupportedTypes();
    assert.ok(Array.isArray(types));
    assert.ok(types.length > 0);
    const extensions = types.map(t => t.extension);
    assert.ok(extensions.includes('.pdf'));
    assert.ok(extensions.includes('.docx'));
    assert.ok(extensions.includes('.xlsx'));
    assert.ok(extensions.includes('.png'));
    for (const t of types) {
      assert.ok(t.extension);
      assert.ok(t.type);
    }
  });

  it('should getStats() return initial stats', () => {
    const stats = parser.getStats();
    assert.equal(stats.totalParsed, 0);
    assert.equal(stats.totalErrors, 0);
    assert.equal(stats.totalTablesExtracted, 0);
    assert.deepStrictEqual(stats.byType, {});
  });

  it('should parse() reject unsupported file types', () => {
    const unsupportedFile = path.join(tmpDir, 'test.xyz');
    fs.writeFileSync(unsupportedFile, 'data', 'utf8');
    assert.throws(() => parser.parse('test.xyz'), /不支持的文件类型/);
  });

  it('should parse() reject non-existent files', () => {
    assert.throws(() => parser.parse('nonexistent.pdf'), /文件不存在/);
  });

  it('should getDocument() return null for unknown docId', () => {
    const result = parser.getDocument('unknown-id');
    assert.equal(result, null);
  });

  it('should emit document-parsed on successful parse', () => {
    const pdfFile = path.join(tmpDir, 'sample.pdf');
    fs.writeFileSync(pdfFile, 'fake-pdf-content', 'utf8');

    let emitted = null;
    parser.on('document-parsed', (evt) => { emitted = evt; });

    const result = parser.parse('sample.pdf');
    assert.ok(emitted);
    assert.equal(emitted.docId, result.docId);
    assert.equal(emitted.fileName, 'sample.pdf');
    assert.equal(emitted.fileType, 'pdf');
    assert.ok(typeof emitted.parseTime === 'number');
  });

  it('should return parsed document via getDocument()', () => {
    const pdfFile = path.join(tmpDir, 'sample.pdf');
    fs.writeFileSync(pdfFile, 'fake-pdf-content', 'utf8');

    const result = parser.parse('sample.pdf');
    const doc = parser.getDocument(result.docId);
    assert.ok(doc);
    assert.equal(doc.docId, result.docId);
    assert.equal(doc.fileName, 'sample.pdf');
    assert.equal(doc.fileType, 'pdf');
    assert.ok(Array.isArray(doc.pages));
    assert.ok(Array.isArray(doc.textContent));
    assert.ok(Array.isArray(doc.tables));
  });

  it('should update stats after parse', () => {
    const pdfFile = path.join(tmpDir, 'sample.pdf');
    fs.writeFileSync(pdfFile, 'fake-pdf-content', 'utf8');

    parser.parse('sample.pdf');
    const stats = parser.getStats();
    assert.equal(stats.totalParsed, 1);
    assert.ok(stats.byType.pdf);
    assert.equal(stats.byType.pdf.count, 1);
  });

  it('should increment error stats on failed parse', () => {
    try { parser.parse('nonexistent.pdf'); } catch (_e) { /* expected */ }
    const stats = parser.getStats();
    assert.equal(stats.totalErrors, 1);
  });

  it('should shutdown correctly', async () => {
    await parser.shutdown();
    assert.ok(!parser.isHealthy());
  });
});

// ─── ExtractionAgent 测试 ──────────────────────────────

describe('ExtractionAgent', () => {
  let agent;

  beforeEach(() => {
    agent = new ExtractionAgent();
  });

  afterEach(async () => {
    if (agent && agent.isHealthy()) {
      await agent.shutdown();
    }
  });

  it('should construct with default options', () => {
    assert.ok(agent);
    assert.equal(agent._maxRetries, 3);
    assert.equal(agent._confidenceThreshold, 0.7);
  });

  it('should throw TypeError for invalid confidenceThreshold', () => {
    assert.throws(() => new ExtractionAgent({ confidenceThreshold: 2 }), /confidenceThreshold must be a number between 0 and 1/);
    assert.throws(() => new ExtractionAgent({ confidenceThreshold: -0.5 }), /confidenceThreshold must be a number between 0 and 1/);
    assert.throws(() => new ExtractionAgent({ confidenceThreshold: 'high' }), /confidenceThreshold must be a number between 0 and 1/);
  });

  it('should registerSchema() validate schema structure', () => {
    const result = agent.registerSchema('invoice', {
      name: 'invoice',
      version: '1.0.0',
      fields: [
        { name: 'invoiceNumber', type: 'string', description: '发票编号', required: true },
        { name: 'totalAmount', type: 'number', description: '总金额' },
      ],
    });
    assert.equal(result, true);
  });

  it('should registerSchema() throw on invalid schemaName', () => {
    assert.throws(() => agent.registerSchema('', { name: 'x', fields: [{ name: 'a', type: 'string' }] }), /schemaName must be a non-empty string/);
    assert.throws(() => agent.registerSchema(123, { name: 'x', fields: [{ name: 'a', type: 'string' }] }), /schemaName must be a non-empty string/);
  });

  it('should registerSchema() throw on missing schema fields', () => {
    assert.throws(() => agent.registerSchema('test', { name: 'test' }), /schema.fields must be a non-empty array/);
    assert.throws(() => agent.registerSchema('test', { name: 'test', fields: [] }), /schema.fields must be a non-empty array/);
  });

  it('should registerSchema() reject invalid field types', () => {
    assert.throws(
      () => agent.registerSchema('bad', {
        name: 'bad',
        fields: [{ name: 'f1', type: 'invalid_type' }],
      }),
      /schema\.fields\[0\]\.type must be one of/,
    );
  });

  it('should extract() with registered schema', () => {
    agent.registerSchema('person', {
      name: 'person',
      fields: [
        { name: 'name', type: 'string', description: '姓名', required: true },
        { name: 'age', type: 'number', description: '年龄' },
      ],
    });

    const result = agent.extract('doc-1', { name: 'Alice', age: 30 }, 'person');
    assert.ok(result);
    assert.equal(result.docId, 'doc-1');
    assert.equal(result.schemaName, 'person');
    assert.ok(Array.isArray(result.fields));
    assert.ok(result.fields.length > 0);
    assert.ok(typeof result.overallConfidence === 'number');
    assert.ok(result.overallConfidence >= 0 && result.overallConfidence <= 1);
  });

  it('should extract() return fields with confidence scores', () => {
    agent.registerSchema('person', {
      name: 'person',
      fields: [
        { name: 'name', type: 'string', description: '姓名', required: true },
      ],
    });

    const result = agent.extract('doc-2', { name: 'Bob' }, 'person');
    for (const field of result.fields) {
      assert.ok(typeof field.confidence === 'number');
      assert.ok(field.confidence >= 0 && field.confidence <= 1);
      assert.ok(typeof field.name === 'string');
    }
  });

  it('should extract() throw on unregistered schema', () => {
    assert.throws(
      () => agent.extract('doc-3', {}, 'nonexistent'),
      /Schema not found/,
    );
  });

  it('should extract() throw on invalid docId', () => {
    agent.registerSchema('test', { name: 'test', fields: [{ name: 'f', type: 'string' }] });
    assert.throws(() => agent.extract('', {}, 'test'), /docId must be a non-empty string/);
  });

  it('should verifyExtraction() update confidence', () => {
    agent.registerSchema('person', {
      name: 'person',
      fields: [
        { name: 'name', type: 'string', description: '姓名', required: true },
      ],
    });

    const extracted = agent.extract('doc-4', { name: 'Charlie' }, 'person');
    const verified = agent.verifyExtraction(extracted.extractionId);
    assert.ok(verified);
    assert.equal(verified.extractionId, extracted.extractionId);
    assert.ok(typeof verified.overallConfidence === 'number');
  });

  it('should verifyExtraction() return null for unknown extractionId', () => {
    assert.equal(agent.verifyExtraction('unknown'), null);
  });

  it('should verifyExtraction() return null for invalid extractionId', () => {
    assert.equal(agent.verifyExtraction(''), null);
    assert.equal(agent.verifyExtraction(123), null);
  });

  it('should getExtraction() return defensive copy', () => {
    agent.registerSchema('person', {
      name: 'person',
      fields: [{ name: 'name', type: 'string', description: '姓名' }],
    });

    const extracted = agent.extract('doc-5', { name: 'Dave' }, 'person');
    const copy1 = agent.getExtraction(extracted.extractionId);
    const copy2 = agent.getExtraction(extracted.extractionId);
    assert.deepStrictEqual(copy1, copy2);
    copy1.fields = [];
    const copy3 = agent.getExtraction(extracted.extractionId);
    assert.notEqual(copy3.fields.length, 0);
  });

  it('should getExtraction() return null for unknown id', () => {
    assert.equal(agent.getExtraction('unknown'), null);
  });

  it('should getStats() return stats', () => {
    const stats = agent.getStats();
    assert.equal(stats.totalExtractions, 0);
    assert.equal(stats.successfulExtractions, 0);
    assert.equal(stats.failedExtractions, 0);
    assert.equal(stats.registeredSchemas, 0);
    assert.equal(stats.cachedExtractions, 0);
  });

  it('should update stats after extraction', () => {
    agent.registerSchema('person', {
      name: 'person',
      fields: [{ name: 'name', type: 'string', description: '姓名' }],
    });

    agent.extract('doc-6', { name: 'Eve' }, 'person');
    const stats = agent.getStats();
    assert.equal(stats.totalExtractions, 1);
    assert.equal(stats.successfulExtractions, 1);
    assert.equal(stats.registeredSchemas, 1);
    assert.equal(stats.cachedExtractions, 1);
  });

  it('should emit extraction-completed event', () => {
    agent.registerSchema('person', {
      name: 'person',
      fields: [{ name: 'name', type: 'string', description: '姓名' }],
    });

    let emitted = null;
    agent.on('extraction-completed', (evt) => { emitted = evt; });

    const result = agent.extract('doc-7', { name: 'Frank' }, 'person');
    assert.ok(emitted);
    assert.equal(emitted.extractionId, result.extractionId);
    assert.equal(emitted.docId, 'doc-7');
    assert.equal(emitted.schemaName, 'person');
    assert.ok(typeof emitted.overallConfidence === 'number');
  });

  it('should emit schema-registered event', () => {
    let emitted = null;
    agent.on('schema-registered', (evt) => { emitted = evt; });

    agent.registerSchema('test', {
      name: 'test',
      version: '2.0.0',
      fields: [{ name: 'f1', type: 'string' }],
    });

    assert.ok(emitted);
    assert.equal(emitted.schemaName, 'test');
    assert.equal(emitted.version, '2.0.0');
  });

  it('should shutdown correctly', async () => {
    await agent.shutdown();
    assert.ok(!agent.isHealthy());
  });
});

// ─── DatabaseAdapter 测试 ──────────────────────────────

describe('DatabaseAdapter', () => {
  let adapter;
  let tmpDbPath;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), 'doc-parser-test-' + Date.now() + '.db');
    adapter = new DatabaseAdapter();
  });

  afterEach(async () => {
    if (adapter && adapter.isHealthy()) {
      await adapter.shutdown();
    }
    if (fs.existsSync(tmpDbPath)) {
      try { fs.unlinkSync(tmpDbPath); } catch (_e) { /* ignore */ }
    }
  });

  it('should construct with default options', () => {
    assert.ok(adapter);
    assert.equal(adapter._defaultType, 'sqlite');
    assert.equal(adapter._connections.size, 0);
  });

  it('should addConnection() with sqlite config', () => {
    const result = adapter.addConnection('main', {
      type: 'sqlite',
      filePath: tmpDbPath,
    });
    assert.ok(result.connected);
    assert.equal(result.name, 'main');
  });

  it('should addConnection() with in-memory sqlite', () => {
    const result = adapter.addConnection('mem', {
      type: 'sqlite',
      filePath: ':memory:',
    });
    assert.ok(result.connected);
    assert.equal(result.name, 'mem');
  });

  it('should addConnection() validate config', () => {
    assert.throws(() => adapter.addConnection('', { type: 'sqlite' }), /Connection name must be a non-empty string/);
    assert.throws(() => adapter.addConnection('x', null), /Connection config must be a non-null object/);
    assert.throws(() => adapter.addConnection('x', { type: 'oracle' }), /Unsupported database type/);
  });

  it('should addConnection() reject mysql (no driver)', () => {
    assert.throws(
      () => adapter.addConnection('mysql', { type: 'mysql', host: 'localhost' }),
      /MySQL driver not available/,
    );
  });

  it('should addConnection() reject postgresql (no driver)', () => {
    assert.throws(
      () => adapter.addConnection('pg', { type: 'postgresql', host: 'localhost' }),
      /PostgreSQL driver not available/,
    );
  });

  it('should createTableFromSchema() create table', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

    const schema = {
      fields: {
        name: { type: 'string' },
        amount: { type: 'number' },
        active: { type: 'boolean' },
      },
    };

    const result = adapter.createTableFromSchema('invoices', schema, 'main');
    assert.equal(result, true);

    const stats = adapter.getStats();
    assert.ok(stats.tablesCreated >= 1);
  });

  it('should createTableFromSchema() return false without connection', () => {
    const result = adapter.createTableFromSchema('test', { fields: { name: { type: 'string' } } });
    assert.equal(result, false);
  });

  it('should createTableFromSchema() return false for invalid schema', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    assert.equal(adapter.createTableFromSchema('test', null, 'main'), false);
    assert.equal(adapter.createTableFromSchema('test', {}, 'main'), false);
  });

  it('should insert() insert data', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

    const result = adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
    assert.equal(result.inserted, 1);
    assert.equal(result.tableName, 'people');
  });

  it('should insert() return 0 without connection', () => {
    const result = adapter.insert('people', { name: 'Alice' });
    assert.equal(result.inserted, 0);
  });

  it('should insert() handle empty data array', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    const result = adapter.insert('people', [], 'main');
    assert.equal(result.inserted, 0);
  });

  it('should query() retrieve data', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
    adapter.insert('people', { name: 'Bob', age: 25 }, 'main');

    const result = adapter.query('people', {}, 'main');
    assert.ok(result.rows.length >= 2);
    assert.ok(result.total >= 2);
  });

  it('should query() with where conditions', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
    adapter.insert('people', { name: 'Bob', age: 25 }, 'main');

    const result = adapter.query('people', { where: { name: 'Alice' } }, 'main');
    assert.ok(result.rows.length >= 1);
    assert.equal(result.rows[0].name, 'Alice');
  });

  it('should query() with limit', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    adapter.insert('people', { name: 'Alice', age: 30 }, 'main');
    adapter.insert('people', { name: 'Bob', age: 25 }, 'main');

    const result = adapter.query('people', { limit: 1 }, 'main');
    assert.ok(result.rows.length <= 1);
  });

  it('should query() return empty without connection', () => {
    const result = adapter.query('people');
    assert.equal(result.rows.length, 0);
    assert.equal(result.total, 0);
  });

  it('should batchInsert() with transaction', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

    const records = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ];

    const result = adapter.batchInsert('people', records, 'main');
    assert.equal(result.inserted, 3);
    assert.equal(result.errors, 0);

    const queryResult = adapter.query('people', {}, 'main');
    assert.equal(queryResult.rows.length, 3);
  });

  it('should batchInsert() handle empty records', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    const result = adapter.batchInsert('people', [], 'main');
    assert.equal(result.inserted, 0);
    assert.equal(result.errors, 0);
  });

  it('should batchInsert() return errors without connection', () => {
    const result = adapter.batchInsert('people', [{ name: 'A' }]);
    assert.equal(result.inserted, 0);
  });

  it('should getConnections() return defensive copy', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });

    const conns1 = adapter.getConnections();
    const conns2 = adapter.getConnections();
    assert.notStrictEqual(conns1, conns2);
    assert.ok(conns1.has('main'));
    assert.ok(conns1.get('main').config);
    assert.ok(conns1.get('main').type);
    assert.ok(typeof conns1.get('main').connected === 'boolean');
  });

  it('should getStats() return stats', () => {
    const stats = adapter.getStats();
    assert.equal(stats.inserts, 0);
    assert.equal(stats.queries, 0);
    assert.equal(stats.tablesCreated, 0);
    assert.equal(stats.errors, 0);
    assert.equal(stats.connectionCount, 0);
  });

  it('should update stats after operations', () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    adapter.insert('people', { name: 'Alice' }, 'main');
    adapter.query('people', {}, 'main');

    const stats = adapter.getStats();
    assert.ok(stats.inserts >= 1);
    assert.ok(stats.queries >= 1);
    assert.equal(stats.connectionCount, 1);
  });

  it('should emit connection-added event', () => {
    let emitted = null;
    adapter.on('connection-added', (evt) => { emitted = evt; });

    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    assert.ok(emitted);
    assert.equal(emitted.name, 'main');
    assert.equal(emitted.type, 'sqlite');
    assert.equal(emitted.connected, true);
  });

  it('should shutdown correctly', async () => {
    adapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
    await adapter.shutdown();
    assert.ok(!adapter.isHealthy());
  });
});

// ─── 集成测试：完整管道 parse → extract → insert ──────

describe('Integration: parse → extract → insert pipeline', () => {
  let parser;
  let agent;
  let dbAdapter;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
    parser = new DocumentParser({ projectRoot: tmpDir });
    agent = new ExtractionAgent();
    dbAdapter = new DatabaseAdapter();
    dbAdapter.addConnection('main', { type: 'sqlite', filePath: ':memory:' });
  });

  afterEach(async () => {
    if (parser && parser.isHealthy()) await parser.shutdown();
    if (agent && agent.isHealthy()) await agent.shutdown();
    if (dbAdapter && dbAdapter.isHealthy()) await dbAdapter.shutdown();
    cleanupDir(tmpDir);
  });

  it('should complete full pipeline: parse PDF → extract fields → insert to DB', () => {
    // 1. 创建测试PDF文件
    const pdfPath = path.join(tmpDir, 'invoice.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf-data', 'utf8');

    // 2. 解析文档
    const parsed = parser.parse('invoice.pdf');
    assert.ok(parsed.docId);
    assert.equal(parsed.fileType, 'pdf');
    assert.ok(Array.isArray(parsed.pages));
    assert.ok(Array.isArray(parsed.textContent));

    // 3. 注册提取模式
    agent.registerSchema('invoice', {
      name: 'invoice',
      version: '1.0.0',
      fields: [
        { name: 'invoiceNumber', type: 'string', description: '发票编号', required: true },
        { name: 'totalAmount', type: 'number', description: '总金额' },
        { name: 'date', type: 'date', description: '日期' },
      ],
    });

    // 4. 提取字段
    const extracted = agent.extract(parsed.docId, parsed, 'invoice');
    assert.ok(extracted.extractionId);
    assert.equal(extracted.docId, parsed.docId);
    assert.equal(extracted.schemaName, 'invoice');
    assert.ok(Array.isArray(extracted.fields));
    assert.ok(typeof extracted.overallConfidence === 'number');

    // 5. 创建数据库表
    const schema = {
      fields: {
        invoiceNumber: { type: 'string' },
        totalAmount: { type: 'number' },
        date: { type: 'date' },
      },
    };
    const tableCreated = dbAdapter.createTableFromSchema('invoices', schema, 'main');
    assert.equal(tableCreated, true);

    // 6. 插入提取结果到数据库
    const record = {
      invoiceNumber: extracted.fields.find(f => f.name === 'invoiceNumber')?.value || null,
      totalAmount: extracted.fields.find(f => f.name === 'totalAmount')?.value || null,
      date: extracted.fields.find(f => f.name === 'date')?.value || null,
      _doc_id: parsed.docId,
      _extraction_id: extracted.extractionId,
      _created_at: new Date().toISOString(),
      _confidence: extracted.overallConfidence,
    };

    const insertResult = dbAdapter.insert('invoices', record, 'main');
    assert.equal(insertResult.inserted, 1);

    // 7. 查询验证
    const queryResult = dbAdapter.query('invoices', {}, 'main');
    assert.ok(queryResult.rows.length >= 1);
    assert.equal(queryResult.rows[0]._doc_id, parsed.docId);
  });

  it('should complete full pipeline with DOCX file', () => {
    // 1. 创建测试DOCX文件
    const docxPath = path.join(tmpDir, 'report.docx');
    fs.writeFileSync(docxPath, 'fake-docx-data', 'utf8');

    // 2. 解析文档
    const parsed = parser.parse('report.docx');
    assert.ok(parsed.docId);
    assert.equal(parsed.fileType, 'word');

    // 3. 注册提取模式并提取
    agent.registerSchema('report', {
      name: 'report',
      fields: [
        { name: 'title', type: 'string', description: '标题', required: true },
        { name: 'author', type: 'string', description: '作者' },
      ],
    });

    const extracted = agent.extract(parsed.docId, parsed, 'report');
    assert.ok(extracted.extractionId);

    // 4. 插入到数据库
    const record = {
      title: extracted.fields.find(f => f.name === 'title')?.value || null,
      author: extracted.fields.find(f => f.name === 'author')?.value || null,
      _doc_id: parsed.docId,
      _extraction_id: extracted.extractionId,
      _created_at: new Date().toISOString(),
      _confidence: extracted.overallConfidence,
    };

    dbAdapter.createTableFromSchema('reports', {
      fields: { title: { type: 'string' }, author: { type: 'string' } },
    }, 'main');

    const insertResult = dbAdapter.insert('reports', record, 'main');
    assert.equal(insertResult.inserted, 1);

    const queryResult = dbAdapter.query('reports', {}, 'main');
    assert.ok(queryResult.rows.length >= 1);
  });

  it('should complete full pipeline with batch insert', () => {
    // 1. 创建多个测试文件
    const files = ['doc1.pdf', 'doc2.pdf', 'doc3.pdf'];
    const parsedDocs = [];

    for (const f of files) {
      fs.writeFileSync(path.join(tmpDir, f), 'fake-pdf-data', 'utf8');
      parsedDocs.push(parser.parse(f));
    }

    // 2. 注册提取模式
    agent.registerSchema('simple', {
      name: 'simple',
      fields: [{ name: 'fileName', type: 'string', description: '文件名' }],
    });

    // 3. 提取并收集结果
    const records = [];
    for (const doc of parsedDocs) {
      const extracted = agent.extract(doc.docId, doc, 'simple');
      records.push({
        fileName: doc.fileName,
        _doc_id: doc.docId,
        _extraction_id: extracted.extractionId,
        _created_at: new Date().toISOString(),
        _confidence: extracted.overallConfidence,
      });
    }

    // 4. 创建表并批量插入
    dbAdapter.createTableFromSchema('documents', {
      fields: { fileName: { type: 'string' } },
    }, 'main');

    const batchResult = dbAdapter.batchInsert('documents', records, 'main');
    assert.equal(batchResult.inserted, 3);

    // 5. 验证
    const queryResult = dbAdapter.query('documents', {}, 'main');
    assert.equal(queryResult.rows.length, 3);
  });
});
