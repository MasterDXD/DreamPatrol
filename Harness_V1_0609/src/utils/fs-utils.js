/**
 * @module fs-utils
 * @description 文件系统工具模块，提供目录创建、JSON文件读写、Markdown文件扫描与解析、
 * SHA-256哈希计算等文件操作功能，包含同步和异步两种版本。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { debug } = require('./debug-logger');
const { safeJsonParse } = require('./safe-parse');
const { UTF8_ENCODING, JSON_EXT, MARKDOWN_EXT, parseFrontmatter, extractMarkdownBody } = require('./constants');

function _em(err) { return err && err.message ? err.message : String(err); }

/**
 * 同步确保目录存在，不存在则递归创建
 * @param {string} dir - 目录路径
 */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 异步确保目录存在，不存在则递归创建
 * @param {string} dir - 目录路径
 * @returns {Promise<void>}
 */
async function ensureDirAsync(dir) {
  try {
    await fs.promises.access(dir);
  } catch (_e) {
    debug('fs-utils', 'ensureDirAsync:access', _e && _e.message ? _e.message : String(_e));
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

/**
 * 获取默认消毒函数（延迟加载debounced-persister的sanitize）
 * @returns {Function|null} 消毒函数
 * @private
 */
function _getDefaultSanitize() {
  return require('./debounced-persister').sanitize;
}

/**
 * 同步加载并解析JSON文件，支持可选消毒处理
 * @param {string} filePath - JSON文件路径
 * @param {Function|undefined} [sanitize] - 可选的消毒函数，传入false跳过消毒
 * @returns {*|null} 解析后的数据，文件不存在或解析失败返回null
 */
function loadJsonSync(filePath, sanitize) {
  try {
    const raw = fs.readFileSync(filePath, UTF8_ENCODING);
    const parsed = safeJsonParse(raw, null, 'fs-utils');
    if (parsed === null) return null;
    const sanitizer = sanitize !== undefined ? sanitize : _getDefaultSanitize();
    return sanitizer ? sanitizer(parsed) : parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    debug('fs-utils', 'loadJsonSync', filePath + ': ' + _em(err));
    return null;
  }
}

/**
 * 异步加载并解析JSON文件，支持可选消毒处理
 * @param {string} filePath - JSON文件路径
 * @param {Function|undefined} [sanitize] - 可选的消毒函数，传入false跳过消毒
 * @returns {Promise<*|null>} 解析后的数据，文件不存在或解析失败返回null
 */
async function loadJsonAsync(filePath, sanitize) {
  try {
    await fs.promises.access(filePath);
  } catch (_e) {
    debug('fs-utils', 'loadJsonAsync:access', _e && _e.message ? _e.message : String(_e));
    return null;
  }
  try {
    const raw = await fs.promises.readFile(filePath, UTF8_ENCODING);
    const parsed = safeJsonParse(raw, null, 'fs-utils');
    if (parsed === null) return null;
    const sanitizer = sanitize !== undefined ? sanitize : _getDefaultSanitize();
    return sanitizer ? sanitizer(parsed) : parsed;
  } catch (err) {
    debug('fs-utils', 'loadJsonAsync', filePath, _em(err));
    return null;
  }
}

/**
 * 计算数据的SHA-256哈希值（十六进制字符串）
 * @param {string|Buffer} data - 待哈希的数据
 * @returns {string} 十六进制格式的哈希值
 */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 计算数据的SHA-256哈希值（Buffer）
 * @param {string|Buffer} data - 待哈希的数据
 * @returns {Buffer} Buffer格式的哈希值
 */
function sha256Buffer(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * 同步扫描目录中的Markdown文件
 * @param {string} dirPath - 目录路径
 * @returns {string[]} Markdown文件名数组
 */
function scanMarkdownDirSync(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).filter(function(f) { return f.endsWith(MARKDOWN_EXT); });
  } catch (err) {
    debug('fs-utils', 'scanMarkdownDirSync', dirPath + ': ' + _em(err));
    return [];
  }
}

/**
 * 异步扫描目录中的Markdown文件
 * @param {string} dirPath - 目录路径
 * @returns {Promise<string[]>} Markdown文件名数组
 */
async function scanMarkdownDirAsync(dirPath) {
  try {
    await fs.promises.access(dirPath);
  } catch (_e) {
    debug('fs-utils', 'scanMarkdownDirAsync:access', _e && _e.message ? _e.message : String(_e));
    return [];
  }
  try {
    const entries = await fs.promises.readdir(dirPath);
    return entries.filter(function(f) { return f.endsWith(MARKDOWN_EXT); });
  } catch (err) {
    debug('fs-utils', 'scanMarkdownDirAsync', dirPath, _em(err));
    return [];
  }
}

/**
 * 同步读取目录中所有JSON文件并解析
 * @param {string} dirPath - 目录路径
 * @param {Object} [options] - 选项
 * @param {Function} [options.filter] - 文件名过滤函数，默认过滤.json后缀
 * @param {string} [options.logLabel] - 调试日志标签
 * @returns {Array<{filename: string, data: *}>} 文件名和解析数据的数组
 */
function readJsonDirSync(dirPath, options) {
  const opts = options ?? {};
  const filter = opts.filter || function(f) { return f.endsWith(JSON_EXT); };
  const logLabel = opts.logLabel ?? 'fs-utils';
  if (!fs.existsSync(dirPath)) return [];
  try {
    const files = fs.readdirSync(dirPath).filter(filter);
    const results = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dirPath, file), UTF8_ENCODING);
        const data = safeJsonParse(raw, null, logLabel);
        if (data === null) continue;
        results.push({ filename: file, data });
      } catch (err) {
        debug(logLabel, 'readJsonDirSync', file + ': ' + _em(err));
      }
    }
    return results;
  } catch (err) {
    debug(logLabel, 'readJsonDirSync', dirPath + ': ' + _em(err));
    return [];
  }
}

/**
 * 异步读取目录中所有JSON文件并解析
 * @param {string} dirPath - 目录路径
 * @param {Object} [options] - 选项
 * @param {Function} [options.filter] - 文件名过滤函数，默认过滤.json后缀
 * @param {string} [options.logLabel] - 调试日志标签
 * @returns {Promise<Array<{filename: string, data: *}>>} 文件名和解析数据的数组
 */
async function readJsonDirAsync(dirPath, options) {
  const opts = options ?? {};
  const filter = opts.filter || function(f) { return f.endsWith(JSON_EXT); };
  const logLabel = opts.logLabel || 'fs-utils';
  try {
    await fs.promises.access(dirPath);
  } catch (_e) {
    debug(logLabel, 'readJsonDirAsync:access', _e && _e.message ? _e.message : String(_e));
    return [];
  }
  try {
    const entries = await fs.promises.readdir(dirPath);
    const files = entries.filter(filter);
    const results = [];
    for (const file of files) {
      try {
        const raw = await fs.promises.readFile(path.join(dirPath, file), UTF8_ENCODING);
        const data = safeJsonParse(raw, null, logLabel);
        if (data === null) continue;
        results.push({ filename: file, data });
      } catch (err) {
        debug(logLabel, 'readJsonDirAsync', file + ': ' + _em(err));
      }
    }
    return results;
  } catch (err) {
    debug(logLabel, 'readJsonDirAsync', dirPath + ': ' + _em(err));
    return [];
  }
}

/**
 * 同步解析Markdown文件，提取frontmatter和正文
 * @param {string} filePath - Markdown文件路径
 * @returns {{content: string, frontmatter: Object, body: string}|null} 文件内容、frontmatter和正文，失败返回null
 */
function parseMarkdownFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, UTF8_ENCODING);
    const frontmatter = parseFrontmatter(content);
    const body = extractMarkdownBody(content);
    return { content, frontmatter, body };
  } catch (err) {
    debug('fs-utils', 'parseMarkdownFile', filePath + ': ' + _em(err));
    return null;
  }
}

/**
 * 异步解析Markdown文件，提取frontmatter和正文
 * @param {string} filePath - Markdown文件路径
 * @returns {Promise<{content: string, frontmatter: Object, body: string}|null>} 文件内容、frontmatter和正文，失败返回null
 */
async function parseMarkdownFileAsync(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, UTF8_ENCODING);
    const frontmatter = parseFrontmatter(content);
    const body = extractMarkdownBody(content);
    return { content, frontmatter, body };
  } catch (err) {
    debug('fs-utils', 'parseMarkdownFileAsync', filePath + ': ' + _em(err));
    return null;
  }
}

module.exports = {
  ensureDirSync, ensureDirAsync, loadJsonSync, loadJsonAsync,
  sha256Hex, sha256Buffer, scanMarkdownDirSync, scanMarkdownDirAsync,
  readJsonDirSync, readJsonDirAsync,
  parseMarkdownFile, parseMarkdownFileAsync,
};
