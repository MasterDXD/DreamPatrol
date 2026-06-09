'use strict';

/**
 * @module utils/network-utils
 *
 * Network security utilities for SSRF prevention, private IP detection,
 * and local request identification. Consolidated from multiple modules
 * (mcp-security, mcp-client, security, server, shared-infrastructure)
 * to ensure consistent security policy enforcement.
 */

/**
 * Hostnames blocked for outbound connections (SSRF prevention).
 * Includes localhost variants, link-local, cloud metadata endpoints.
 * @type {string[]}
 */
const BLOCKED_HOSTS = Object.freeze([
  'localhost', 'localhost.localdomain', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254', 'metadata.google.internal', 'metadata.azure.com',
  '100.100.100.200', 'fd00:ec2::254', 'ip6-localhost',
]);

/**
 * Regex patterns matching private/reserved IP ranges.
 * @type {RegExp[]}
 */
const BLOCKED_HOST_PATTERNS = Object.freeze([
  /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./,
  /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe[89ab]:/i, /^::ffff:/i,
  /^0\./, /^127\./,
]);

/**
 * IPv4 private/reserved range definitions for efficient lookup.
 * @type {Array<{a: number, bMin?: number, bMax?: number, b?: number}>}
 */
const IPV4_PRIVATE_RANGES = [
  { a: 10, bMin: undefined, bMax: undefined },
  { a: 172, bMin: 16, bMax: 31 },
  { a: 192, b: 168 },
  { a: 169, b: 254 },
  { a: 100, bMin: 64, bMax: 127 },
];

/**
 * Check if an IPv4 octet pair falls within a private or reserved range.
 * @param {number} a - First octet (0-255)
 * @param {number} b - Second octet (0-255)
 * @returns {boolean} True if the address is private or reserved
 */
function isPrivateIPv4(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 || a === 127 || a >= 224) return true;
  for (const range of IPV4_PRIVATE_RANGES) {
    if (a !== range.a) continue;
    if (range.bMin !== undefined && range.bMax !== undefined && (b < range.bMin || b > range.bMax)) continue;
    if (range.b !== undefined && b !== range.b) continue;
    return true;
  }
  return false;
}

/**
 * Check if an IPv6 address is private, loopback, or reserved.
 * Covers loopback, link-local, unique local (fc/fd), documentation (2001:db8).
 * @param {string} addr - IPv6 address string
 * @returns {boolean} True if the address is private or reserved
 */
function isPrivateIPv6(addr) {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  if (/^fc[0-9a-f]{2}:/i.test(lower)) return true;
  if (/^fd[0-9a-f]{2}:/i.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  if (/^0100::/i.test(lower)) return true;
  if (/^2001:db8:/i.test(lower)) return true;
  return false;
}

/**
 * Check if IPv4 octet pair is private or reserved (MCP validation variant).
 * @param {number} a - First octet
 * @param {number} b - Second octet
 * @returns {boolean} True if private or reserved
 */
function isPrivateOrReservedIp(a, b) {
  if (a === 198 && (b === 18 || b === 19)) return true;
  return isPrivateIPv4(a, b);
}

/**
 * Check if an IP address (IPv4 or IPv6) is private or reserved.
 * Handles IPv4-mapped IPv6 (::ffff:x.x.x.x) with recursive unwrapping.
 * @param {string} ip - IP address string
 * @param {number} [depth=0] - Recursion depth guard (max 3)
 * @returns {boolean} True if the IP is private or reserved
 */
function isPrivateIp(ip, depth = 0) {
  if (depth >= 3) return false;
  if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1' || ip === '::') return true;
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.substring(7), depth + 1);
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe[89ab]:/i.test(ip)) return true;
  const normalized = _normalizeIPv4(ip);
  if (normalized) return isPrivateIPv4(normalized[0], normalized[1]);
  return false;
}

function _normalizeIPv4(ip) {
  if (/^\d+$/.test(ip)) {
    const num = parseInt(ip, 10);
    if (num > 0 && num <= 0xFFFFFFFF) {
      return [(num >>> 24) & 0xFF, (num >>> 16) & 0xFF];
    }
    return null;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    let octet;
    if (/^0[0-7]+$/.test(part)) {
      octet = parseInt(part, 8);
    } else if (/^0x[0-9a-f]+$/i.test(part)) {
      octet = parseInt(part, 16);
    } else if (/^\d+$/.test(part)) {
      octet = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(octet) || octet < 0 || octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return [octets[0], octets[1]];
}

/**
 * Determine if an HTTP request originates from a local (loopback) address.
 * Used for dev-mode authentication bypass and CORS policy decisions.
 * @param {import('http').IncomingMessage} req - HTTP request object
 * @returns {boolean} True if the request is from a local address
 */
function isLocalRequest(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip === '0:0:0:0:0:0:0:1' || ip === '[::1]' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('::ffff:127.') || ip.startsWith('127.')) return true;
  return false;
}

/**
 * Check if a hostname is blocked by SSRF prevention policy.
 * Combines exact-match against BLOCKED_HOSTS and pattern-match
 * against BLOCKED_HOST_PATTERNS for comprehensive coverage.
 * @param {string} hostname - Hostname to check
 * @returns {boolean} True if the hostname is blocked
 */
const BLOCKED_HOSTS_SET = new Set(BLOCKED_HOSTS);

function isBlockedHost(hostname) {
  let normalizedHost = hostname.toLowerCase();
  if (normalizedHost.startsWith('[') && normalizedHost.endsWith(']')) {
    normalizedHost = normalizedHost.slice(1, -1);
  }
  if (BLOCKED_HOSTS_SET.has(normalizedHost)) return true;
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(normalizedHost)) return true;
  }
  const normalized = _normalizeIPv4(normalizedHost);
  if (normalized) return isPrivateIPv4(normalized[0], normalized[1]);
  return false;
}

module.exports = {
  BLOCKED_HOSTS,
  BLOCKED_HOSTS_SET,
  BLOCKED_HOST_PATTERNS,
  IPV4_PRIVATE_RANGES,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateOrReservedIp,
  isPrivateIp,
  isLocalRequest,
  isBlockedHost,
};
