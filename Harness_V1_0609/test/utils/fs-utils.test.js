'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  ensureDirSync, loadJsonSync,
  sha256Hex, sha256Buffer, scanMarkdownDirSync, scanMarkdownDirAsync,
  readJsonDirSync, readJsonDirAsync,
} = require('../../src/utils/fs-utils');

const TMP_DIR = path.join(__dirname, '__fs_utils_test_tmp__');

describe('sha256Hex', () => {
  it('should return hex string for string input', () => {
    const result = sha256Hex('hello');
    assert.strictEqual(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should return hex string for buffer input', () => {
    const result = sha256Hex(Buffer.from('hello', 'utf8'));
    assert.strictEqual(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should produce consistent results', () => {
    const a = sha256Hex('test data');
    const b = sha256Hex('test data');
    assert.strictEqual(a, b);
  });

  it('should produce different results for different inputs', () => {
    const a = sha256Hex('input1');
    const b = sha256Hex('input2');
    assert.notStrictEqual(a, b);
  });

  it('should return 64 character hex string', () => {
    const result = sha256Hex('any input');
    assert.strictEqual(result.length, 64);
    assert.match(result, /^[0-9a-f]+$/);
  });
});

describe('sha256Buffer', () => {
  it('should return buffer for string input', () => {
    const result = sha256Buffer('hello');
    assert.ok(Buffer.isBuffer(result));
    assert.strictEqual(result.length, 32);
  });

  it('should match sha256Hex digest', () => {
    const hexResult = sha256Hex('hello');
    const bufResult = sha256Buffer('hello');
    assert.strictEqual(bufResult.toString('hex'), hexResult);
  });
});

describe('scanMarkdownDirSync', () => {
  beforeEach(() => {
    ensureDirSync(TMP_DIR);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('should return empty array for non-existent directory', () => {
    const result = scanMarkdownDirSync(path.join(TMP_DIR, 'nonexistent'));
    assert.deepStrictEqual(result, []);
  });

  it('should return only .md files', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'a.md'), 'test');
    fs.writeFileSync(path.join(TMP_DIR, 'b.md'), 'test');
    fs.writeFileSync(path.join(TMP_DIR, 'c.js'), 'test');
    fs.writeFileSync(path.join(TMP_DIR, 'd.txt'), 'test');
    const result = scanMarkdownDirSync(TMP_DIR);
    assert.deepStrictEqual(result, ['a.md', 'b.md']);
  });

  it('should return empty array for empty directory', () => {
    const emptyDir = path.join(TMP_DIR, 'empty');
    ensureDirSync(emptyDir);
    const result = scanMarkdownDirSync(emptyDir);
    assert.deepStrictEqual(result, []);
  });

  it('should handle directory with only non-md files', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'readme.txt'), 'test');
    fs.writeFileSync(path.join(TMP_DIR, 'script.js'), 'test');
    const result = scanMarkdownDirSync(TMP_DIR);
    assert.deepStrictEqual(result, []);
  });
});

describe('scanMarkdownDirAsync', () => {
  beforeEach(() => {
    ensureDirSync(TMP_DIR);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('should return empty array for non-existent directory', async () => {
    const result = await scanMarkdownDirAsync(path.join(TMP_DIR, 'nonexistent'));
    assert.deepStrictEqual(result, []);
  });

  it('should return only .md files', async () => {
    fs.writeFileSync(path.join(TMP_DIR, 'x.md'), 'test');
    fs.writeFileSync(path.join(TMP_DIR, 'y.md'), 'test');
    fs.writeFileSync(path.join(TMP_DIR, 'z.json'), 'test');
    const result = await scanMarkdownDirAsync(TMP_DIR);
    assert.deepStrictEqual(result, ['x.md', 'y.md']);
  });
});

describe('ensureDirSync', () => {
  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('should create directory if not exists', () => {
    const dir = path.join(TMP_DIR, 'new_dir');
    ensureDirSync(dir);
    assert.ok(fs.existsSync(dir));
  });

  it('should not throw if directory already exists', () => {
    const dir = path.join(TMP_DIR, 'existing_dir');
    fs.mkdirSync(dir, { recursive: true });
    assert.doesNotThrow(() => ensureDirSync(dir));
  });
});

describe('loadJsonSync', () => {
  beforeEach(() => {
    ensureDirSync(TMP_DIR);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('should return null for non-existent file', () => {
    const result = loadJsonSync(path.join(TMP_DIR, 'nope.json'));
    assert.strictEqual(result, null);
  });

  it('should parse valid JSON', () => {
    const filePath = path.join(TMP_DIR, 'test.json');
    fs.writeFileSync(filePath, '{"key":"value"}');
    const result = loadJsonSync(filePath);
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('should apply sanitize function', () => {
    const filePath = path.join(TMP_DIR, 'test.json');
    fs.writeFileSync(filePath, '{"key":"value","danger":"bad"}');
    const result = loadJsonSync(filePath, (obj) => {
      delete obj.danger;
      return obj;
    });
    assert.strictEqual(result.key, 'value');
    assert.strictEqual(result.danger, undefined);
  });

  it('should return null for invalid JSON', () => {
    const filePath = path.join(TMP_DIR, 'bad.json');
    fs.writeFileSync(filePath, 'not json');
    const result = loadJsonSync(filePath);
    assert.strictEqual(result, null);
  });
});

describe('readJsonDirSync - prototype pollution regression', () => {
  beforeEach(() => {
    ensureDirSync(TMP_DIR);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('should strip __proto__ key from parsed JSON', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'proto.json'), '{"__proto__":{"admin":true},"name":"test"}');
    const results = readJsonDirSync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(Object.keys(data).includes('__proto__'), false);
  });

  it('should strip constructor key from parsed JSON', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'ctor.json'), '{"constructor":{"hack":true},"name":"test"}');
    const results = readJsonDirSync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(Object.keys(data).includes('constructor'), false);
  });

  it('should strip prototype key from parsed JSON', () => {
    fs.writeFileSync(path.join(TMP_DIR, 'pt.json'), '{"prototype":{"evil":true},"name":"test"}');
    const results = readJsonDirSync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(Object.keys(data).includes('prototype'), false);
  });

  it('should strip all dangerous keys in a single file', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'all.json'),
      '{"__proto__":{"admin":true},"constructor":{"hack":true},"prototype":{"evil":true},"safe":"value"}',
    );
    const results = readJsonDirSync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.safe, 'value');
    assert.strictEqual(Object.keys(data).includes('__proto__'), false);
    assert.strictEqual(Object.keys(data).includes('constructor'), false);
    assert.strictEqual(Object.keys(data).includes('prototype'), false);
  });

  it('should strip nested dangerous keys from parsed JSON', () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'nested.json'),
      '{"outer":{"__proto__":{"admin":true},"constructor":{"hack":true},"safe":"yes"},"name":"test"}',
    );
    const results = readJsonDirSync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(data.outer.safe, 'yes');
    assert.strictEqual(Object.keys(data.outer).includes('__proto__'), false);
    assert.strictEqual(Object.keys(data.outer).includes('constructor'), false);
  });
});

describe('readJsonDirAsync - prototype pollution regression', () => {
  beforeEach(() => {
    ensureDirSync(TMP_DIR);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('should strip __proto__ key from parsed JSON', async () => {
    fs.writeFileSync(path.join(TMP_DIR, 'proto.json'), '{"__proto__":{"admin":true},"name":"test"}');
    const results = await readJsonDirAsync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(Object.keys(data).includes('__proto__'), false);
  });

  it('should strip constructor key from parsed JSON', async () => {
    fs.writeFileSync(path.join(TMP_DIR, 'ctor.json'), '{"constructor":{"hack":true},"name":"test"}');
    const results = await readJsonDirAsync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(Object.keys(data).includes('constructor'), false);
  });

  it('should strip prototype key from parsed JSON', async () => {
    fs.writeFileSync(path.join(TMP_DIR, 'pt.json'), '{"prototype":{"evil":true},"name":"test"}');
    const results = await readJsonDirAsync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(Object.keys(data).includes('prototype'), false);
  });

  it('should strip all dangerous keys in a single file', async () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'all.json'),
      '{"__proto__":{"admin":true},"constructor":{"hack":true},"prototype":{"evil":true},"safe":"value"}',
    );
    const results = await readJsonDirAsync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.safe, 'value');
    assert.strictEqual(Object.keys(data).includes('__proto__'), false);
    assert.strictEqual(Object.keys(data).includes('constructor'), false);
    assert.strictEqual(Object.keys(data).includes('prototype'), false);
  });

  it('should strip nested dangerous keys from parsed JSON', async () => {
    fs.writeFileSync(
      path.join(TMP_DIR, 'nested.json'),
      '{"outer":{"__proto__":{"admin":true},"constructor":{"hack":true},"safe":"yes"},"name":"test"}',
    );
    const results = await readJsonDirAsync(TMP_DIR);
    assert.strictEqual(results.length, 1);
    const data = results[0].data;
    assert.strictEqual(data.name, 'test');
    assert.strictEqual(data.outer.safe, 'yes');
    assert.strictEqual(Object.keys(data.outer).includes('__proto__'), false);
    assert.strictEqual(Object.keys(data.outer).includes('constructor'), false);
  });
});
