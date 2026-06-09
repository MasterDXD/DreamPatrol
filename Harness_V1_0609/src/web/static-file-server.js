'use strict';

/**
 * @module web/static-file-server
 * 静态文件服务模块。支持路径遍历防护、条件缓存（ETag/If-Modified-Since）、
 * Range请求和CSP nonce注入。从DashboardServer提取以实现单一职责和可测试性。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { t } = require('../utils/i18n');
const { safeCall } = require('../utils/safe-execute');
const { debug } = require('../utils/debug-logger');
const { compressBody } = require('./compression');
const { UTF8_ENCODING } = require('../utils/constants');

const _REALPATH_CACHE_TTL = 300000;
const _realpathCache = new Map();
const _REALPATH_CACHE_MAX = 100;

function _getCachedRealpath(p) {
  const cached = _realpathCache.get(p);
  if (cached && (Date.now() - cached.ts < _REALPATH_CACHE_TTL)) return cached.value;
  if (cached) _realpathCache.delete(p);
  return null;
}

function _setCachedRealpath(p, value) {
  if (_realpathCache.size >= _REALPATH_CACHE_MAX) {
    const firstKey = _realpathCache.keys().next().value;
    _realpathCache.delete(firstKey);
  }
  _realpathCache.set(p, { value: value, ts: Date.now() });
}

/** @constant {Object<string, string>} MIME类型映射表 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 提供静态文件服务，包含安全检查、条件缓存和Range请求支持。
 * @param {Object} server - DashboardServer实例（用于apiTokenHash等）
 * @param {string} pathname - URL路径名
 * @param {import('http').IncomingMessage} req - HTTP请求对象
 * @param {import('http').ServerResponse} res - HTTP响应对象
 */
function _computeCacheControl(ext, filePath) {
  if (ext === '.html' || filePath === '/sw.js') return 'max-age=0, no-cache';
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (isDev) return 'no-cache, no-store, must-revalidate';
  const isImmutable = ['.woff', '.woff2', '.png', '.svg', '.webp', '.ico'].includes(ext);
  if (isImmutable) return 'public, max-age=31536000, immutable';
  return 'public, max-age=86400, stale-while-revalidate=60';
}

function handleStatic(server, pathname, req, res) {
  const filePath = pathname === '/' ? '/index.html' : pathname;
  if (filePath.includes('\0') || /[\\]/.test(filePath)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Invalid path');
    return;
  }
  const fullPath = path.join(__dirname, 'public', filePath);

  const publicDir = path.resolve(path.join(__dirname, 'public'));
  const resolved = path.resolve(fullPath);
  const relative = path.relative(publicDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(t('server.error.access_denied'));
    return;
  }

  fs.stat(resolved, function(statErr, stats) {
    if (res.headersSent) return;
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(t('server.error.resource_not_found'));
      return;
    }
    try {
      let realPath = _getCachedRealpath(resolved);
      if (!realPath) {
        // Security: deny request when realpathSync fails to prevent symlink-based path traversal.
        // A failed realpathSync may indicate a broken symlink or permission issue that could
        // be exploited to serve files outside the public directory.
        try {
          realPath = fs.realpathSync(resolved);
          _setCachedRealpath(resolved, realPath);
        } catch (_e) {
          debug('StaticFileServer', 'realpathFallback', _e && _e.message ? _e.message : String(_e));
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
      }
      const realRelative = path.relative(publicDir, realPath);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
    } catch (_e) { debug('StaticFileServer', 'pathTraversal', _e && _e.message ? _e.message : String(_e));
      debug('StaticFileServer', 'pathTraversalBlocked', resolved);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl = _computeCacheControl(ext, filePath);

    if (filePath === '/index.html') {
      const nonce = res.locals && res.locals.cspNonce;
      serveIndexHtmlWithNonce(server, fullPath, nonce || '', 'text/html; charset=utf-8', req, res);
      return;
    }
    const etag = '"' + crypto.createHash('sha256').update(String(stats.size) + String(Math.floor(stats.mtimeMs))).digest('hex').slice(0, 16) + '"';

    if (checkConditionalCache(req, res, etag, stats)) return;

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': stats.mtime.toUTCString(),
      'Vary': 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff',
    };

    serveFileWithRange(req, res, resolved, headers, stats);
  });
}

/**
 * 提供index.html服务，注入CSP nonce和可选的token-available元标签。
 * @param {Object} server - DashboardServer实例
 * @param {string} fullPath - index.html的绝对路径
 * @param {string} nonce - CSP nonce值
 * @param {string} contentType - MIME类型
 * @param {import('http').IncomingMessage} req - HTTP请求对象
 * @param {import('http').ServerResponse} res - HTTP响应对象
 */
function serveIndexHtmlWithNonce(server, fullPath, nonce, contentType, req, res) {
  if (!nonce) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Security initialization failed');
    return;
  }
  fs.readFile(fullPath, UTF8_ENCODING, function(readErr, html) {
    if (readErr) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(t('server.error.internal'));
      return;
    }
    let processed = html.replace(/\{\{CSP_NONCE\}\}/g, nonce);
    if (server._apiTokenHash) {
      processed = processed.replace('</head>', '<meta name="harness-token-available" content="true">\n</head>');
    }
    const body = Buffer.from(processed, UTF8_ENCODING);
    const acceptEnc = req.headers['accept-encoding'] || '';
    const compressed = compressBody(body, acceptEnc);
    const outHeaders = {
      'Content-Type': contentType + '; charset=utf-8',
      'Cache-Control': 'max-age=0, no-cache, no-store',
      'Pragma': 'no-cache',
      'Vary': 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff',
    };
    if (compressed) {
      outHeaders['Content-Encoding'] = compressed.encoding;
      outHeaders['Content-Length'] = String(compressed.data.length);
      res.writeHead(200, outHeaders);
      res.end(compressed.data);
    } else {
      outHeaders['Content-Length'] = String(body.length);
      res.writeHead(200, outHeaders);
      res.end(body);
    }
  });
}

/**
 * 检查条件缓存头（If-None-Match、If-Modified-Since）。
 * @param {import('http').IncomingMessage} req - HTTP请求对象
 * @param {import('http').ServerResponse} res - HTTP响应对象
 * @param {string} etag - 计算的ETag值
 * @param {fs.Stats} stats - 文件状态对象
 * @returns {boolean} 已发送304响应（缓存命中）返回true
 */
function checkConditionalCache(req, res, etag, stats) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const etags = ifNoneMatch.split(',').map(function(s) { return s.trim().replace(/^W\//, ''); });
    if (etags.includes(etag) || etags.includes('*')) {
      res.writeHead(304, { 'ETag': etag });
      res.end();
      return true;
    }
  }
  if (req.headers['if-modified-since'] && stats.mtime.toUTCString() === req.headers['if-modified-since']) {
    res.writeHead(304);
    res.end();
    return true;
  }
  return false;
}

/**
 * 提供文件服务，支持可选的Range请求（HTTP 206 Partial Content）。
 * @param {import('http').IncomingMessage} req - HTTP请求对象
 * @param {import('http').ServerResponse} res - HTTP响应对象
 * @param {string} fullPath - 文件绝对路径
 * @param {Object} headers - 响应头对象
 * @param {fs.Stats} stats - 文件状态对象
 */
function serveFileWithRange(req, res, fullPath, headers, stats) {
  const range = req.headers.range;
  if (range) {
    const total = stats.size;
    if (total === 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */0' });
      res.end();
      return;
    }
    const rangeSpec = range.replace(/^bytes=/, '');
    if (rangeSpec.includes(',')) {
      res.writeHead(200, headers);
      const stream = fs.createReadStream(fullPath);
      stream.on('error', function(err) { debug('StaticFileServer', 'readStreamError', { path: fullPath, error: err && err.message ? err.message : String(err) }); stream.destroy(); if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(t('server.error.internal')); } else { res.destroy(); } });
      req.on('close', function() { stream.destroy(); });
      res.on('error', function() { stream.destroy(); });
      stream.pipe(res);
      return;
    }
    const parts = rangeSpec.split('-');
    let start, end;
    if (parts[0] === '' && parts[1]) {
      const suffixLength = parseInt(parts[1], 10);
      if (isNaN(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        res.end();
        return;
      }
      start = Math.max(0, total - suffixLength);
      end = total - 1;
    } else {
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    }
    if (isNaN(start) || isNaN(end) || start < 0 || end < start || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return;
    }
    if (end >= total) end = total - 1;
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
    headers['Content-Length'] = String(end - start + 1);
    headers['Accept-Ranges'] = 'bytes';
    res.writeHead(206, headers);
    const stream = fs.createReadStream(fullPath, { start: start, end: end });
    stream.on('error', function(err) {
      debug('StaticFileServer', 'readStreamError', { path: fullPath, error: err && err.message ? err.message : String(err) });
      stream.destroy();
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(t('server.error.internal'));
      } else {
        res.destroy();
      }
    });
    req.on('close', function() { stream.destroy(); });
    res.on('error', function() { stream.destroy(); });
    stream.pipe(res);
    return;
  }

  headers['Content-Length'] = String(stats.size);
  res.writeHead(200, headers);
  const stream = fs.createReadStream(fullPath);
  stream.on('error', function(err) {
    debug('StaticFileServer', 'readStreamError', { path: fullPath, error: err && err.message ? err.message : String(err) });
    stream.destroy();
    if (!res.writableEnded) {
      safeCall(function() { res.destroy(); }, 'Dashboard', 'resDestroy');
    }
  });
  req.on('close', function() { stream.destroy(); });
  res.on('error', function() { stream.destroy(); });
  stream.pipe(res);
}

module.exports = {
  handleStatic,
  serveIndexHtmlWithNonce,
  checkConditionalCache,
  serveFileWithRange,
  MIME_TYPES,
};
