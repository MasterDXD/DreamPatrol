'use strict';

/**
 * @module dashboard/middleware/security
 * @description Dashboard安全中间件模块，提供IP提取、速率限制、CSP头设置、Bearer认证和响应时间记录等安全功能
 */

const crypto = require('crypto');
const { debug } = require('../../../utils/debug-logger');
const { HarnessError } = require('../../../errors');
const { t } = require('../../../utils/i18n');
const { JSON_CONTENT_TYPE, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX, MAX_SENSITIVE_RATE_MAP, SENSITIVE_RATE_LIMITS, MAX_RESPONSE_TIME_SAMPLES } = require('../constants');
const { UTF8_ENCODING } = require('../../../utils/constants');
const { _getPathname } = require('../utils');
const { isLocalRequest: _isLocalRequest } = require('../../../utils/network-utils');
const { secureId } = require('../../../utils/unique-id');

/** @constant {RegExp} 合法IP地址正则（IPv4/IPv6） */
const VALID_IP_RE = /^[a-fA-F0-9.:]+$/;

let _serverBoundToLocalhost = true;

function setServerBindingLocalhost(isLocal) {
  _serverBoundToLocalhost = !!isLocal;
}

/**
 * 获取客户端真实IP地址，支持代理头解析和信任级别控制
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {object} [serverConfig] - 服务器配置，含trustProxy和proxyWhitelist
 * @returns {string} 客户端IP地址
 */
function getClientIp(req, serverConfig) {
  if (serverConfig && serverConfig.trustProxy && serverConfig.proxyWhitelist && serverConfig.proxyWhitelist.size > 0) {
    const proxyIp = req.socket.remoteAddress;
    const normalizedProxy = (proxyIp || '').replace(/^::ffff:/, '');
    if (!serverConfig.proxyWhitelist.has(normalizedProxy) && !serverConfig.proxyWhitelist.has(proxyIp)) {
      return proxyIp || 'unknown';
    }
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const trimmed = forwarded.length > 1024 ? forwarded.slice(0, 1024) : forwarded;
      const ips = trimmed.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length <= 45 && VALID_IP_RE.test(s); }).slice(0, 20);
      const trustLevel = typeof serverConfig.trustProxy === 'number' ? serverConfig.trustProxy : 1;
      const trustedIndex = Math.max(0, ips.length - trustLevel);
      if (ips[trustedIndex]) return ips[trustedIndex];
      if (ips.length > 0) return ips[0];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * 判断请求是否来自本地地址
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @returns {boolean} 是否本地请求
 */
function isLocalRequest(req) {
  return _isLocalRequest(req);
}

/** @constant {number} 速率限制Map最大条目数 */
const MAX_RATE_LIMIT_MAP = 50000;

/**
 * 从Map中淘汰最旧的10%条目
 * @param {Map} map - 待淘汰的Map
 * @param {number} maxSize - Map最大容量
 */
function evictOldestFromMap(map, maxSize) {
  if (map.size < maxSize) return;
  const keysToDelete = [];
  let count = 0;
  for (const key of map.keys()) {
    keysToDelete.push(key);
    count++;
    if (count >= Math.max(1, Math.floor(maxSize * 0.1))) break;
  }
  for (const key of keysToDelete) map.delete(key);
}

/**
 * 检查请求是否超过速率限制，支持敏感路径独立限流和本地请求放宽
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {Map} rateLimitMap - 全局速率限制记录Map
 * @param {Map} sensitiveRateMap - 敏感路径速率限制记录Map
 * @param {object} [serverConfig] - 服务器配置
 * @returns {{allowed: boolean, ip?: string, status?: number, headers?: object, body?: string}} 速率限制检查结果
 */
function checkRateLimit(req, rateLimitMap, sensitiveRateMap, serverConfig) {
  const ip = getClientIp(req, serverConfig);
  const now = Date.now();
  const pathname = _getPathname(req);
  const isUnknownIp = (ip === 'unknown');
  const isLocal = _isLocalRequest(req);
  const effectiveMax = isLocal ? RATE_LIMIT_MAX * 5 : (isUnknownIp ? Math.floor(RATE_LIMIT_MAX / 10) : RATE_LIMIT_MAX);
  const sensitiveLimit = SENSITIVE_RATE_LIMITS[pathname];

  if (rateLimitMap.size >= MAX_RATE_LIMIT_MAP) {
    evictOldestFromMap(rateLimitMap, Math.floor(MAX_RATE_LIMIT_MAP * 0.8));
  }

  if (sensitiveLimit) {
    const key = ip + ':' + pathname;
    if (sensitiveRateMap.size >= MAX_SENSITIVE_RATE_MAP) {
      evictOldestFromMap(sensitiveRateMap, Math.floor(MAX_SENSITIVE_RATE_MAP * 0.8));
    }
    let sRecord = sensitiveRateMap.get(key);
    if (!sRecord || now - sRecord.windowStart > sensitiveLimit.window) {
      sRecord = { windowStart: now, count: 1 };
      sensitiveRateMap.set(key, sRecord);
    } else {
      sRecord.count++;
      if (sRecord.count > (isLocal ? sensitiveLimit.max * 5 : sensitiveLimit.max)) {
        const retryAfter = Math.max(1, Math.ceil((sensitiveLimit.window - (now - sRecord.windowStart)) / 1000));
        return { allowed: false, status: 429, headers: { 'Content-Type': JSON_CONTENT_TYPE, 'Retry-After': String(retryAfter) }, body: JSON.stringify({ error: t('server.error.rate_limited') }) };
      }
    }
  }

  let record = rateLimitMap.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    if (rateLimitMap.size >= MAX_RATE_LIMIT_MAP) {
      evictOldestFromMap(rateLimitMap, Math.floor(MAX_RATE_LIMIT_MAP * 0.8));
    }
    record = { windowStart: now, count: 1 };
    rateLimitMap.set(ip, record);
    return { allowed: true, ip: ip };
  }

  record.count++;
  if (record.count > effectiveMax) {
    const retryAfter = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW - (now - record.windowStart)) / 1000));
    return { allowed: false, status: 429, headers: { 'Content-Type': JSON_CONTENT_TYPE, 'Retry-After': String(retryAfter) }, body: JSON.stringify({ error: t('server.error.rate_limited') }) };
  }

  return { allowed: true, ip: ip };
}

/**
 * 生成CSP nonce随机值，失败时抛出安全违规错误
 * @returns {string} 16字节随机nonce字符串
 * @throws {HarnessError} 安全随机数生成失败时抛出
 */
function generateNonce() {
  try {
    return secureId('', 16);
  } catch (_e) {
    debug('DashboardServer', 'security', 'crypto.randomBytes unavailable - CSP nonce generation failed');
    throw new HarnessError('SECURITY_VIOLATION', 'Secure nonce generation failed - cannot serve request safely', { cause: _e });
  }
}

/**
 * 设置HTTP安全响应头，包括CSP、CORS、HSTS等
 * @param {http.ServerResponse} res - HTTP响应对象
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {string} host - 服务器主机名
 * @param {number} port - 服务器端口
 * @param {object} [serverConfig] - 服务器配置
 * @param {string} [nonce] - CSP nonce值
 */
function setSecurityHeaders(res, req, host, port, serverConfig, nonce) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), fullscreen=(), payment=(), sync-xhr=(), usb=()');
  const VALID_HOST_RE = /^[a-zA-Z0-9._-]+$/;
  const wsHost = (host && VALID_HOST_RE.test(host)) ? host : 'localhost';
  const wsProto = (port === 443 || (serverConfig && serverConfig.forceHttps)) ? 'wss' : 'ws';
  const wsConnectSrc = wsProto + '://' + wsHost + ':' + port;
  const nonceDirective = nonce ? ' \'nonce-' + nonce + '\'' : '';
  let csp = 'default-src \'self\'; script-src \'self\'' + nonceDirective + '; style-src \'self\'' + nonceDirective + '; img-src \'self\' data:; connect-src \'self\' ' + wsConnectSrc + '; font-src \'self\'; object-src \'none\'; manifest-src \'self\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\'';
  if (port === 443 || (serverConfig && serverConfig.forceHttps)) {
    csp += '; upgrade-insecure-requests';
  }
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (port === 443 || (serverConfig && serverConfig.forceHttps) || (req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
}

/**
 * 获取CORS允许的来源，仅在白名单内时返回
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {Set<string>} allowedOriginsSet - 允许的来源集合
 * @returns {string|null} 允许的来源或null
 */
function getCorsOrigin(req, allowedOriginsSet) {
  const origin = req.headers.origin;
  if (origin && allowedOriginsSet.has(origin)) return origin;
  return null;
}

/**
 * 通用Bearer Token认证验证，使用时序安全比较防止时序攻击
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {string} apiTokenHash - API Token的SHA256哈希值
 * @param {boolean} allowDevBypass - 是否允许开发模式绕过
 * @param {boolean} trustProxyActive - 是否启用了代理信任
 * @param {string} method - 请求方法标识（用于日志）
 * @param {boolean} devMode - 是否开发模式
 * @returns {boolean} 认证是否通过
 * @private
 */
function _verifyAuthCommon(req, apiTokenHash, allowDevBypass, trustProxyActive, method, devMode) {
  if (!apiTokenHash || typeof apiTokenHash !== 'string' || apiTokenHash.length === 0) {
    const canBypass = (devMode || allowDevBypass) && _serverBoundToLocalhost;
    if (canBypass && isLocalRequest(req) && !trustProxyActive) return true;
    debug('Dashboard', method + 'AuthNoToken', { error: 'HARNESS_API_TOKEN not set - ' + method + ' endpoints are BLOCKED' });
    return false;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token || token.length > 1024) return false;
  const tokenHash = crypto.createHash('sha256').update(token, UTF8_ENCODING).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(tokenHash, 'hex'), Buffer.from(apiTokenHash, 'hex'));
  } catch (_e) {
    debug('Security', 'timingSafeEqual', 'Comparison error: ' + (_e && _e.message ? _e.message : String(_e)));
    return false;
  }
}

/**
 * 验证POST请求的Bearer Token认证
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {string} apiToken - API Token哈希值
 * @param {boolean} devMode - 是否开发模式
 * @param {boolean} allowDevBypass - 是否允许开发模式绕过
 * @param {boolean} trustProxyActive - 是否启用了代理信任
 * @returns {boolean} 认证是否通过
 */
function verifyPostAuth(req, apiToken, devMode, allowDevBypass, trustProxyActive) {
  return _verifyAuthCommon(req, apiToken, allowDevBypass, trustProxyActive, 'post', devMode);
}

/**
 * 验证GET请求的Bearer Token认证
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {string} apiToken - API Token哈希值
 * @param {boolean} devMode - 是否开发模式
 * @param {boolean} allowDevBypass - 是否允许开发模式绕过
 * @param {boolean} trustProxyActive - 是否启用了代理信任
 * @returns {boolean} 认证是否通过
 */
function verifyGetAuth(req, apiToken, devMode, allowDevBypass, trustProxyActive) {
  return _verifyAuthCommon(req, apiToken, allowDevBypass, trustProxyActive, 'get', devMode);
}

/**
 * 提取调用者标识，优先使用Token认证标识，否则使用IP标识
 * @param {http.IncomingMessage} req - HTTP请求对象
 * @param {object} [serverConfig] - 服务器配置
 * @returns {string} 调用者标识（格式：token:ip 或 ip:ip）
 */
function extractCallerId(req, serverConfig) {
  const ip = getClientIp(req, serverConfig);
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return 'token:' + ip;
  return 'ip:' + ip;
}

/**
 * 记录响应时间到环形缓冲区，慢请求超过3秒时输出调试日志
 * @param {Array} responseTimes - 响应时间环形缓冲区
 * @param {number} rtIdx - 当前写入索引
 * @param {number} responseCount - 总响应计数
 * @param {number} startTime - 请求开始时间戳
 * @param {number} status - HTTP状态码
 * @returns {{rtIdx: number, responseCount: number}} 更新后的索引和计数
 */
function recordResponseTime(responseTimes, rtIdx, responseCount, startTime, status) {
  const elapsed = Date.now() - startTime;
  const entry = { ms: elapsed, status: status };
  if (responseTimes.length < MAX_RESPONSE_TIME_SAMPLES) {
    responseTimes.push(entry);
  } else {
    responseTimes[rtIdx] = entry;
  }
  if (elapsed > 3000) {
    debug('Dashboard', 'slowResponse', elapsed + 'ms', 'status=' + status);
  }
  return { rtIdx: (rtIdx + 1) % MAX_RESPONSE_TIME_SAMPLES, responseCount: responseCount + 1 };
}

module.exports = {
  getClientIp,
  isLocalRequest,
  evictOldestFromMap,
  checkRateLimit,
  generateNonce,
  setSecurityHeaders,
  getCorsOrigin,
  verifyPostAuth,
  verifyGetAuth,
  extractCallerId,
  recordResponseTime,
  setServerBindingLocalhost,
};
