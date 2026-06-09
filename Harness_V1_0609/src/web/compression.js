'use strict';

/**
 * @module web/compression
 * HTTP响应压缩工具模块。支持brotli、gzip和deflate压缩。
 * 从DashboardServer提取以实现单一职责和可测试性。
 */

const zlib = require('zlib');
const { debug } = require('../utils/debug-logger');
const { UTF8_ENCODING } = require('../utils/constants');

/** @constant {number} 压缩阈值字节数，低于此值不压缩 */
const COMPRESSION_THRESHOLD_BYTES = 512;
/** @constant {number} 最大可压缩字节数 */
const MAX_COMPRESS_SIZE = 1024 * 1024;

/**
 * 压缩HTTP响应体并通过响应对象发送。根据Accept-Encoding头支持brotli、gzip和deflate。
 * 超时或出错时回退为未压缩响应。
 *
 * @param {import('http').IncomingMessage} req - HTTP请求对象（用于获取accept-encoding）
 * @param {import('http').ServerResponse} res - HTTP响应对象
 * @param {string} body - 响应体字符串
 * @param {Object} headers - 响应头对象（原地修改）
 * @param {number} status - HTTP状态码
 * @param {number} [compressTimeoutMs=3000] - 压缩超时时间（毫秒）
 */
// eslint-disable-next-line complexity
function compressResponse(req, res, body, headers, status, compressTimeoutMs) {
  if (res.headersSent || res.destroyed) return;
  const safeStatus = (typeof status === 'number' && Number.isFinite(status) && status >= 100 && status < 600) ? status : 200;
  if (body == null) { res.writeHead(safeStatus, headers); res.end(); return; }
  const acceptEncoding = (req.headers['accept-encoding'] || '');
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, UTF8_ENCODING);

  if (bodyBuf.length <= COMPRESSION_THRESHOLD_BYTES) {
    headers['Content-Length'] = String(bodyBuf.length);
    res.writeHead(safeStatus, headers);
    res.end(bodyBuf);
    return;
  }

  if (headers['Content-Encoding']) {
    headers['Content-Length'] = String(bodyBuf.length);
    res.writeHead(safeStatus, headers);
    res.end(bodyBuf);
    return;
  }

  const encodings = acceptEncoding.split(',').map(function(s) { return s.trim().split(';')[0].trim(); });
  let compressStream;
  let encoding;
  if (encodings.includes('br') && typeof zlib.createBrotliCompress === 'function') {
    compressStream = zlib.createBrotliCompress();
    encoding = 'br';
  } else if (encodings.includes('gzip')) {
    compressStream = zlib.createGzip();
    encoding = 'gzip';
  } else if (encodings.includes('deflate')) {
    compressStream = zlib.createDeflate();
    encoding = 'deflate';
  } else {
    headers['Content-Length'] = String(bodyBuf.length);
    res.writeHead(safeStatus, headers);
    res.end(bodyBuf);
    return;
  }

  const chunks = [];
  let totalCompressedSize = 0;
  const MAX_COMPRESSED_SIZE = MAX_COMPRESS_SIZE * 2;
  let settled = false;
  const timeout = typeof compressTimeoutMs === 'number' && Number.isFinite(compressTimeoutMs) ? compressTimeoutMs : 3000;

  const timer = setTimeout(function() {
    if (settled) return;
    settled = true;
    compressStream.destroy();
    compressStream.removeAllListeners();
    if (!res.headersSent && !res.destroyed) {
      headers['Content-Length'] = String(bodyBuf.length);
      res.writeHead(safeStatus, headers);
      res.end(bodyBuf);
    }
  }, timeout);
  if (timer && typeof timer.unref === 'function') timer.unref();

  compressStream.on('data', function(chunk) {
    if (!settled) {
      totalCompressedSize += chunk.length;
      if (totalCompressedSize > MAX_COMPRESSED_SIZE) {
        settled = true;
        clearTimeout(timer);
        compressStream.destroy();
        if (!res.headersSent && !res.destroyed) {
          headers['Content-Length'] = String(bodyBuf.length);
          res.writeHead(safeStatus, headers);
          res.end(bodyBuf);
        }
        return;
      }
      chunks.push(chunk);
    }
  });
  compressStream.on('end', function() {
    clearTimeout(timer);
    if (settled || res.headersSent || res.destroyed) return;
    settled = true;
    const compressed = Buffer.concat(chunks);
    headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = String(compressed.length);
    res.writeHead(safeStatus, headers);
    res.end(compressed);
  });
  compressStream.on('error', function(err) {
    debug('Compression', 'compressError', err && err.message ? err.message : String(err));
    clearTimeout(timer);
    if (settled || res.headersSent || res.destroyed) return;
    settled = true;
    compressStream.destroy();
    headers['Content-Length'] = String(bodyBuf.length);
    res.writeHead(safeStatus, headers);
    res.end(bodyBuf);
  });

  if (!settled && !compressStream.destroyed) {
    compressStream.end(bodyBuf);
  }
}

/**
 * 同步压缩响应体缓冲区。压缩无收益或不支持时返回null。
 *
 * @param {Buffer|string} body - 待压缩数据
 * @param {string} acceptEncoding - Accept-Encoding头值
 * @returns {{ data: Buffer, encoding: string }|null} 压缩结果或null
 */
function compressBody(body, acceptEncoding) {
  if (body == null) return null;
  if (typeof body === 'string') body = Buffer.from(body, 'utf-8');
  if (body.length < COMPRESSION_THRESHOLD_BYTES) return null;
  if (body.length > MAX_COMPRESS_SIZE) return null;
  const encodings = acceptEncoding.split(',').map(function(s) { return s.trim().split(';')[0].trim(); });
  try {
    if (encodings.includes('br') && typeof zlib.brotliCompressSync === 'function') {
      return { data: zlib.brotliCompressSync(body), encoding: 'br' };
    }
    if (encodings.includes('gzip')) {
      return { data: zlib.gzipSync(body), encoding: 'gzip' };
    }
    if (encodings.includes('deflate')) {
      return { data: zlib.deflateSync(body), encoding: 'deflate' };
    }
  } catch (err) {
    debug('Dashboard', 'compressBody', err && err.message ? err.message : String(err));
    return { _error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  compressResponse,
  compressBody,
  COMPRESSION_THRESHOLD_BYTES,
};
