'use strict';

/**
 * @module utils/sanitizer
 *
 * Input sanitization utilities for prototype pollution prevention,
 * path traversal mitigation, log injection prevention, and
 * MCP environment variable filtering.
 */

const path = require('path');
const DANGEROUS_KEYS = require('./constants').DANGEROUS_KEYS;

/**
 * Remove prototype-polluting keys (__proto__, constructor, prototype)
 * from an object in-place. Recursively sanitizes nested objects.
 * @param {Object} obj - Object to sanitize (returns new object)
 * @param {number} [depth=0] - Current recursion depth (max 5)
 * @returns {Object} A new sanitized object with null prototype
 */
function sanitizeProto(obj, depth = 0, seen = new WeakSet()) {
  if (depth > 5 || !obj || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  if (obj instanceof Date || obj instanceof RegExp) return obj;
  if (Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) {
    return obj.map(function(item) {
      return (item && typeof item === 'object') ? sanitizeProto(item, depth + 1, seen) : item;
    });
  }
  const safe = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const val = obj[key];
    if (val && typeof val === 'object' && val !== null) {
      safe[key] = sanitizeProto(val, depth + 1, seen);
    } else {
      safe[key] = val;
    }
  }
  return safe;
}

/**
 * Create a sanitized deep copy of an object, removing prototype-polluting keys.
 * Unlike sanitizeProto, this does not modify the original object.
 * @param {Object} obj - Object to sanitize
 * @param {number} [depth=0] - Current recursion depth (max 10)
 * @returns {Object} A new sanitized object with null prototype
 */
function sanitizeObject(obj, depth = 0, seen = new WeakSet()) {
  if (depth >= 10 || !obj || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  if (obj instanceof Date || obj instanceof RegExp) return obj;
  if (Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) {
    return obj.map(function(item) { return sanitizeObject(item, depth + 1, seen); });
  }
  const safe = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const val = obj[key];
    if (val && typeof val === 'object' && val !== null) {
      safe[key] = sanitizeObject(val, depth + 1, seen);
    } else {
      safe[key] = val;
    }
  }
  return safe;
}

/**
 * Sanitize a file path to prevent path traversal attacks.
 * Resolves the path and rejects null bytes and non-normalized paths.
 * Returns an absolute path — use this when you need a safe absolute file path.
 * For preserving relative paths, use path-utils.sanitizePath() instead.
 * For full containment validation, use path-utils.validatePath() or isPathWithinDir().
 * @param {string} filePath - File path to sanitize
 * @returns {string} Sanitized absolute path, or empty string if invalid
 */
function sanitizeFilePath(filePath, baseDir) {
  if (!filePath || typeof filePath !== 'string') return String(filePath || '');
  const resolved = path.resolve(filePath);
  if (resolved.includes('\0')) return '';
  if (resolved !== path.normalize(resolved)) return '';
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      return '';
    }
  }
  return resolved;
}

/**
 * Sanitize a log message by removing newlines and ANSI escape sequences.
 * Prevents log injection and log forging attacks.
 * @param {string} msg - Log message to sanitize
 * @returns {string} Sanitized message (single line, no ANSI codes)
 */
function sanitizeLogMsg(msg) {
  if (typeof msg !== 'string') msg = String(msg);
  return msg.replace(/[\r\n]/g, ' ').replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Default pattern for MCP environment variable keys that should be filtered.
 * Matches common secret/credential key names.
 * @type {RegExp}
 */
const DEFAULT_MCP_DANGEROUS_PATTERN = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|AUTH|CREDENTIAL|CERT|PASSWD|SESSION_SECRET|DATABASE_URL)/i;

/**
 * Filter MCP environment variables, removing sensitive keys and oversized values.
 * @param {Object} env - Environment variable key-value map
 * @param {RegExp} [dangerousKeyPattern] - Pattern matching keys to filter
 * @param {number} [maxEnvLength] - Maximum allowed value length
 * @returns {Object|undefined} Filtered environment object, or undefined if input is invalid
 */
function sanitizeMcpEnv(env, dangerousKeyPattern, maxEnvLength) {
  if (!env || typeof env !== 'object') return undefined;
  const pattern = dangerousKeyPattern ?? DEFAULT_MCP_DANGEROUS_PATTERN;
  const safeEnv = {};
  for (const key of Object.keys(env)) {
    if (pattern.test(key)) continue;
    if (typeof env[key] !== 'string') continue;
    if (maxEnvLength && env[key].length > maxEnvLength) continue;
    safeEnv[key] = env[key];
  }
  return safeEnv;
}

module.exports = {
  sanitizeProto,
  sanitizeObject,
  sanitizeFilePath,
  sanitizeLogMsg,
  sanitizeMcpEnv,
};
