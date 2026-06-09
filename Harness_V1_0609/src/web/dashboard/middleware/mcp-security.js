'use strict';

/**
 * @module dashboard/middleware/mcp-security
 * @description MCP协议安全验证模块，提供命令白名单校验、参数危险模式检测、URL SSRF防护和主机名安全检查
 */

const path = require('path');
const { debug } = require('../../../utils/debug-logger');
const C = require('../constants');
const MCP_ALLOWED_COMMANDS = C.MCP_ALLOWED_COMMANDS;
const MCP_DANGEROUS_ARG_PATTERNS = C.MCP_DANGEROUS_ARG_PATTERNS;
const MCP_DANGEROUS_ENV_KEYS = C.MCP_DANGEROUS_ENV_KEYS;
const MAX_POST_ARGS_COUNT = C.MAX_POST_ARGS_COUNT;
const MAX_POST_ARG_LENGTH = C.MAX_POST_ARG_LENGTH;
const MAX_POST_ENV_LENGTH = C.MAX_POST_ENV_LENGTH;
const MAX_POST_URL_LENGTH = C.MAX_POST_URL_LENGTH;
const { sanitizeMcpEnv } = require('../../../utils/sanitizer');
const { BLOCKED_HOSTS, isPrivateIPv6, isPrivateOrReservedIp, isLocalRequest } = require('../../../utils/network-utils');

/**
 * 验证MCP命令是否在白名单内，并校验参数和环境变量安全性
 * @param {object} body - 请求体，包含command、args和env
 * @returns {{_status: number, _data: object}|null} 错误对象或null（验证通过）
 */
function validateMcpCommand(body) {
  if (!body.command || typeof body.command !== 'string' || body.command.trim() === '') return null;
  const cmdBase = path.basename(body.command);
  if (!MCP_ALLOWED_COMMANDS.includes(cmdBase)) {
    return { _status: 400, _data: { error: 'Command not allowed' } };
  }
  body.command = cmdBase;
  if (body.args) {
    const argsErr = validateMcpArgs(body.args);
    if (argsErr) return argsErr;
  }
  if (body.env && typeof body.env === 'object') {
    body.env = sanitizeMcpEnv(body.env, MCP_DANGEROUS_ENV_KEYS, MAX_POST_ENV_LENGTH);
  }
  return null;
}

/**
 * 验证MCP参数数组，检查类型、长度和危险模式
 * @param {Array} args - 参数数组
 * @returns {{_status: number, _data: object}|null} 错误对象或null（验证通过）
 */
function validateMcpArgs(args) {
  if (!Array.isArray(args)) {
    return { _status: 400, _data: { error: 'args must be an array of strings' } };
  }
  if (args.length > MAX_POST_ARGS_COUNT) {
    return { _status: 400, _data: { error: 'args array exceeds maximum length (' + MAX_POST_ARGS_COUNT + ')' } };
  }
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== 'string') {
      return { _status: 400, _data: { error: 'args[' + i + '] must be a string' } };
    }
    if (args[i].length > MAX_POST_ARG_LENGTH) {
      return { _status: 400, _data: { error: 'args[' + i + '] exceeds maximum length' } };
    }
    for (let j = 0; j < MCP_DANGEROUS_ARG_PATTERNS.length; j++) {
      if (MCP_DANGEROUS_ARG_PATTERNS[j].test(args[i])) {
        return { _status: 400, _data: { error: 'args[' + i + '] contains dangerous pattern' } };
      }
    }
  }
  return null;
}

/**
 * 验证MCP URL是否合法，检查协议、长度和主机名安全性（SSRF防护）
 * @param {object} body - 请求体，包含url字段
 * @returns {{_status: number, _data: object}|null} 错误对象或null（验证通过）
 */
function validateMcpUrl(body) {
  if (!body.url) return null;
  if (typeof body.url !== 'string') {
    return { _status: 400, _data: { error: 'url must be a string' } };
  }
  if (body.url.length > MAX_POST_URL_LENGTH) {
    return { _status: 400, _data: { error: 'url exceeds maximum length' } };
  }
  try {
    const parsed = new URL(body.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { _status: 400, _data: { error: 'Only http/https URLs allowed' } };
    }
    const hostname = parsed.hostname.toLowerCase();
    const hostErr = validateMcpHostname(hostname);
    if (hostErr) return hostErr;
  } catch (_e) {
    debug('McpSecurity', 'validateUrl', _e && _e.message ? _e.message : String(_e));
    return { _status: 400, _data: { error: 'Invalid URL format' } };
  }
  return null;
}

/**
 * 验证主机名是否安全，阻止私有IP、保留IP、八进制和十六进制IP
 * @param {string} hostname - 待验证的主机名
 * @returns {{_status: number, _data: object}|null} 错误对象或null（验证通过）
 */
function validateMcpHostname(hostname) {
  if (BLOCKED_HOSTS.includes(hostname.toLowerCase())) {
    return { _status: 400, _data: { error: 'URL hostname not allowed' } };
  }
  let ipv6 = hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    ipv6 = hostname.slice(1, -1);
  }
  const m = ipv6.match(/^(?:0:0:0:0:0:)?ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i)
    || ipv6.match(/^::ffff:0?:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
  if (m) {
    const octets = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)];
    if (octets.some(function(o) { return !Number.isFinite(o) || o < 0 || o > 255; })) {
      return { _status: 400, _data: { error: 'Invalid IPv4-mapped IPv6 address' } };
    }
    if (isPrivateOrReservedIp(octets[0], octets[1])) {
      return { _status: 400, _data: { error: 'Private/reserved IP addresses not allowed' } };
    }
    return null;
  }
  if (/^[0-9a-f]*:.*:.*:.*$/i.test(hostname) && !hostname.startsWith('[')) {
    if (isPrivateIPv6(hostname)) {
      return { _status: 400, _data: { error: 'URL hostname not allowed' } };
    }
  }
  if (/^[0-9a-f]*:.*:.*:.*$/i.test(ipv6) && isPrivateIPv6(ipv6)) {
    return { _status: 400, _data: { error: 'URL hostname not allowed' } };
  }
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const octets = [parseInt(ipMatch[1], 10), parseInt(ipMatch[2], 10), parseInt(ipMatch[3], 10), parseInt(ipMatch[4], 10)];
    if (octets.some(function(o) { return !Number.isFinite(o) || o < 0 || o > 255; })) {
      return { _status: 400, _data: { error: 'Invalid IP address' } };
    }
    if (octets[0] === 0 || isPrivateOrReservedIp(octets[0], octets[1])) {
      return { _status: 400, _data: { error: 'Private/reserved IP addresses not allowed' } };
    }
  }
  if (/^0[0-7]*\./.test(hostname)) {
    return { _status: 400, _data: { error: 'Octal IP addresses not allowed' } };
  }
  if (/^0x[0-9a-f]+/i.test(hostname)) {
    return { _status: 400, _data: { error: 'Hex IP addresses not allowed' } };
  }
  return null;
}

module.exports = {
  validateMcpCommand,
  validateMcpArgs,
  validateMcpUrl,
  validateMcpHostname,
  isLocalRequest,
};
