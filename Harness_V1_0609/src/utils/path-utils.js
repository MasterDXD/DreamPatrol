'use strict';

/**
 * @module utils/path-utils
 *
 * Path security utilities for traversal prevention, containment validation,
 * and path normalization. Used across gate, permission, and web modules.
 */

const path = require('path');
const fs = require('fs');
const { debug } = require('./debug-logger');

function _decodePathSegment(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  try {
    let decoded = filePath;
    let prev;
    let rounds = 0;
    while (prev !== decoded && rounds < 3) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
      rounds++;
    }
    return decoded;
  } catch (e) {
    debug('path-utils', '_decodePathSegment', 'decode failed:', e && e.message ? e.message : String(e));
    return filePath;
  }
}

/**
 * Validate a file path is contained within a project root directory.
 * Detects path traversal attacks including null byte injection and
 * symlink-based escapes (via realpath resolution).
 * @param {string} filePath - File path to validate (relative or absolute)
 * @param {Object} [options] - Validation options
 * @param {string} [options.rootDir=process.cwd()] - Root directory for containment check
 * @param {boolean} [options.allowExact=true] - Allow the path to be exactly the root directory
 * @returns {{ valid: boolean, reason?: string, resolvedPath?: string, projectDir?: string }}
 */
function validatePath(filePath, options) {
  const opts = options ?? {};
  const rootDir = opts.rootDir ?? process.cwd();
  const allowExact = opts.allowExact !== false;

  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, reason: 'Path must be a non-empty string' };
  }

  const decodedPath = _decodePathSegment(filePath);

  if (decodedPath.includes('\0')) {
    return { valid: false, reason: 'Path contains null byte' };
  }

  const resolved = path.resolve(rootDir, decodedPath);
  const projectDir = path.resolve(rootDir);

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch (e) { debug('path-utils', 'realpathSync resolved failed:', e && e.message ? e.message : String(e)); }

  let realProjectDir = projectDir;
  try {
    realProjectDir = fs.realpathSync(projectDir);
  } catch (e) { debug('path-utils', 'realpathSync projectDir failed:', e && e.message ? e.message : String(e)); }

  const normResolved = realResolved.replace(/\\/g, '/').toLowerCase();
  const normProjectDir = realProjectDir.replace(/\\/g, '/').toLowerCase();

  const startsWithDir = normResolved.startsWith(normProjectDir + '/');
  const isExactDir = normResolved === normProjectDir;

  if (!startsWithDir && !(allowExact && isExactDir)) {
    return { valid: false, reason: 'Path traversal detected: access outside project root' };
  }

  return { valid: true, resolvedPath: realResolved, projectDir: realProjectDir };
}

/**
 * 异步验证文件路径是否在项目根目录内。
 * 检测路径遍历攻击（包括空字节注入和符号链接逃逸），使用异步 realpath 解析。
 * @param {string} filePath - 待验证的文件路径（相对或绝对）
 * @param {Object} [options] - 验证选项
 * @param {string} [options.rootDir=process.cwd()] - 包含检查的根目录
 * @param {boolean} [options.allowExact=true] - 是否允许路径恰好为根目录
 * @returns {Promise<{valid: boolean, reason?: string, resolvedPath?: string, projectDir?: string}>}
 */
async function validatePathAsync(filePath, options) {
  const opts = options ?? {};
  const rootDir = opts.rootDir ?? process.cwd();
  const allowExact = opts.allowExact !== false;

  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, reason: 'Path must be a non-empty string' };
  }

  const decodedPath = _decodePathSegment(filePath);

  if (decodedPath.includes('\0')) {
    return { valid: false, reason: 'Path contains null byte' };
  }

  const resolved = path.resolve(rootDir, decodedPath);
  const projectDir = path.resolve(rootDir);

  let realResolved = resolved;
  try {
    await fs.promises.access(resolved);
    realResolved = await fs.promises.realpath(resolved);
  } catch (e) { debug('path-utils', 'realpath resolved failed:', e && e.message ? e.message : String(e)); }

  let realProjectDir = projectDir;
  try {
    realProjectDir = await fs.promises.realpath(projectDir);
  } catch (e) { debug('path-utils', 'realpath projectDir failed:', e && e.message ? e.message : String(e)); }

  const normResolved = realResolved.replace(/\\/g, '/').toLowerCase();
  const normProjectDir = realProjectDir.replace(/\\/g, '/').toLowerCase();

  const startsWithDir = normResolved.startsWith(normProjectDir + '/');
  const isExactDir = normResolved === normProjectDir;

  if (!startsWithDir && !(allowExact && isExactDir)) {
    return { valid: false, reason: 'Path traversal detected: access outside project root' };
  }

  return { valid: true, resolvedPath: realResolved, projectDir: realProjectDir };
}

/**
 * Check if a file path is contained within a directory (quick check).
 * Does not resolve symlinks — use validatePath() for thorough checks.
 * @param {string} filePath - File path to check
 * @param {string} dirPath - Containing directory path
 * @returns {boolean} True if filePath is within dirPath
 */
function isPathWithinDir(filePath, dirPath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const decodedPath = _decodePathSegment(filePath);
  if (decodedPath.includes('\0')) return false;

  const resolved = path.resolve(dirPath, decodedPath);
  const resolvedDir = path.resolve(dirPath);

  const normResolved = resolved.replace(/\\/g, '/').toLowerCase();
  const normDir = resolvedDir.replace(/\\/g, '/').toLowerCase();

  return normResolved.startsWith(normDir + '/') || normResolved === normDir;
}

/**
 * Sanitize a file path by removing null bytes and normalizing.
 * @param {string} filePath - File path to sanitize
 * @returns {string} Sanitized and normalized path, or empty string if invalid
 */
function sanitizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  let sanitized = _decodePathSegment(filePath);
  sanitized = sanitized.replace(/\0/g, '');
  sanitized = path.normalize(sanitized);
  return sanitized;
}

module.exports = { validatePath, validatePathAsync, isPathWithinDir, sanitizePath };
