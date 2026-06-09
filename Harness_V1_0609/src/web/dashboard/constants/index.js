'use strict';

/**
 * @module dashboard/constants
 * @description Dashboard常量定义模块，集中管理端口、超时、MIME类型、速率限制、验证规则等配置常量
 */

const { DEFAULT_TOKEN_BUDGET, MAX_LOCKS, HEALTH_MAX_LOCKS, HEALTH_MAX_CONFIRMATIONS } = require('../../../utils/constants');

/** @constant {number} 默认Dashboard端口 */
const DEFAULT_DASHBOARD_PORT = 3210;
/** @constant {string} 默认Dashboard主机 */
const DEFAULT_DASHBOARD_HOST = 'localhost';
/** @constant {number} 优雅关闭超时时间（毫秒） */
const GRACEFUL_SHUTDOWN_TIMEOUT = 10000;
/** @constant {number} 最大HTTP连接数 */
const MAX_HTTP_CONNECTIONS = 500;

/** @constant {Object<string, string>} MIME类型映射表 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** @constant {Object<string, number>} 缓存TTL配置（毫秒） */
const CACHE_TTL = {
  config: 30000,
  agents: 15000,
  skills: 15000,
  sessions: 10000,
  changelog: 60000,
  overview: 8000,
  workflow: 8000,
  audit: 10000,
  compliance: 300000,
};

/** @constant {string[]} MCP允许的命令白名单 */
const MCP_ALLOWED_COMMANDS = Object.freeze([
  'npx', 'node', 'python3', 'python', 'uvx', 'pip',
]);

/** @constant {RegExp[]} MCP危险参数模式列表 */
const MCP_DANGEROUS_ARG_PATTERNS = Object.freeze([
  /(?:^|-)e$/, /^--eval(?:=|$)/,
  /(?:^|-)c$/, /^--command(?:=|$)/,
  /^--exec(?:=|$)/, /(?:^|-)i$/, /^--interactive(?:=|$)/,
  /^import\s/, /^require\s*\(/, /^exec\(/, /^spawn\(/,
]);

/** @constant {RegExp} MCP危险环境变量键名正则 */
const MCP_DANGEROUS_ENV_KEYS = /^(PATH|HOME|USER|SHELL|LD_|DYLD_|LIB|SYSTEMROOT|COMSPEC|WINDIR|__)/i;

/** @constant {string[]} 知识库允许的字段列表 */
const KNOWLEDGE_ALLOWED_FIELDS = ['id', 'content', 'category', 'tags', 'source', 'metadata', 'confidence', 'created_at', 'updated_at'];

/** @constant {Object<string, {window: number, max: number}>} 敏感路径速率限制配置 */
const SENSITIVE_RATE_LIMITS = {
  '/api/mcp/connect': { window: 60000, max: 10 },
  '/api/mcp/call-tool': { window: 60000, max: 30 },
  '/api/sqlite/knowledge': { window: 60000, max: 60 },
  '/api/goal/create': { window: 60000, max: 20 },
  '/api/goal/pause': { window: 60000, max: 30 },
  '/api/goal/resume': { window: 60000, max: 30 },
  '/api/goal/cancel': { window: 60000, max: 30 },
  '/api/goal/progress': { window: 60000, max: 60 },
  '/api/approval/approve': { window: 60000, max: 30 },
  '/api/approval/reject': { window: 60000, max: 30 },
  '/api/approval/request': { window: 60000, max: 30 },
  '/api/memory/add': { window: 60000, max: 100 },
  '/api/memory/remove': { window: 60000, max: 60 },
  '/api/token/record': { window: 60000, max: 200 },
  '/api/skill-improvement/apply': { window: 60000, max: 10 },
  '/api/skill-creation/create': { window: 60000, max: 10 },
  '/api/auto-version/record': { window: 60000, max: 30 },
  '/api/antipattern/detect': { window: 60000, max: 20 },
  '/api/nudge/evaluate': { window: 60000, max: 20 },
  '/api/doc-freshness/verify': { window: 60000, max: 20 },
  '/api/affinity/record': { window: 60000, max: 60 },
};

/** @constant {number} 全局速率限制窗口（毫秒） */
const RATE_LIMIT_WINDOW = 60000;
/** @constant {number} 全局速率限制最大请求数 */
const RATE_LIMIT_MAX = 2000;
/** @constant {number} 速率限制清理间隔（毫秒） */
const RATE_LIMIT_CLEANUP_INTERVAL = 60000;
/** @constant {number} URL最大长度 */
const MAX_URL_LENGTH = 2048;
/** @constant {number} 最大分页大小 */
const MAX_PAGE_SIZE = 100;
/** @constant {number} 最大缓存条目数 */
const MAX_CACHE_ENTRIES = 50;
/** @constant {number} 最大Frontmatter缓存条目数 */
const MAX_FM_CACHE_ENTRIES = 100;
/** @constant {number} LRU Frontmatter缓存大小 */
const LRU_FM_CACHE_SIZE = 500;
/** @constant {number} LRU文件缓存大小 */
const LRU_FILE_CACHE_SIZE = 200;
/** @constant {number} LRU目录缓存大小 */
const LRU_DIR_CACHE_SIZE = 200;
/** @constant {number} 参数最大长度 */
const MAX_ARGS_LENGTH = 65536;
/** @constant {number} 请求超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 30000;
/** @constant {number} 源码最大长度 */
const MAX_SOURCE_LENGTH = 65536;
/** @constant {Set<string>} 有效设计类型集合 */
const VALID_DESIGN_TYPES = new Set(['css', 'html', 'js']);
/** @constant {Set<string>} 有效设计公司集合 */
const VALID_DESIGN_COMPANIES = new Set(['apple', 'stripe', 'vercel', 'notion', 'github', 'google', 'spotify', 'airbnb', 'linear', 'figma', 'shopify', 'slack']);
/** @constant {Set<string>} 有效设计方差级别集合 */
const VALID_DESIGN_VARIANCES = new Set(['conservative', 'balanced', 'creative', 'bold']);
/** @constant {Set<string>} 有效偏差状态集合 */
const VALID_DEVIATION_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'revoked']);
/** @constant {Set<string>} 有效审查状态集合 */
const VALID_REVIEW_STATUSES = new Set(['pending', 'in_progress', 'approved', 'needs_changes', 'rejected']);
/** @constant {Set<string>} 有效告警级别集合 */
const VALID_ALERT_LEVELS = new Set(['info', 'warning', 'critical']);
/** @constant {Set<string>} 有效日志级别集合 */
const VALID_LOG_LEVELS = new Set(['info', 'warn', 'error', 'debug']);
/** @constant {string} JSON内容类型 */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** @constant {number} 压缩阈值字节数 */
const COMPRESSION_THRESHOLD_BYTES = 512;
/** @constant {number} 变更日志输入最大长度 */
const MAX_CHANGELOG_INPUT_LENGTH = 512 * 1024;
/** @constant {string} 变更日志版本号正则源 */
const RE_CHANGELOG_VERSION_SRC = '## \\[(\\d+\\.\\d+\\.\\d+)\\]\\s*[-–]\\s*(\\d{4}-\\d{2}-\\d{2})?\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## \\[|$)';
/** @constant {string} 变更日志段落正则源 */
const RE_CHANGELOG_SECTION_SRC = '### (新增|变更|修复|移除)\\r?\\n([\\s\\S]*?)(?=###|$)';
/** @constant {string} 迭代元数据正则源 */
const RE_ITERATION_META_SRC = '<!--\\s*(\\w+)\\s*:\\s*(.+?)\\s*-->';
/** @constant {RegExp} 变更日志加粗条目正则 */
const RE_CHANGELOG_ITEM_BOLD = /^- \*\*(.+?)\*\*/;
/** @constant {RegExp} 变更日志模块正则 */
const RE_CHANGELOG_MODULE = /模块：(.+?)\s*\//;
/** @constant {RegExp} 变更日志实现方式正则 */
const RE_CHANGELOG_METHOD = /实现方式：(.+?)\s*\//;
/** @constant {RegExp} 变更日志业务价值正则 */
const RE_CHANGELOG_VALUE = /业务价值：(.+?)\）/;

/** @constant {number} Agent历史记录最大条目数 */
const MAX_AGENT_HISTORY = 500;
/** @constant {number} 敏感速率限制Map最大条目数 */
const MAX_SENSITIVE_RATE_MAP = 5000;
/** @constant {number} 响应时间采样最大数量 */
const MAX_RESPONSE_TIME_SAMPLES = 500;
/** @constant {number} 技能ID最大长度 */
const MAX_SKILL_ID_LENGTH = 128;
/** @constant {number} 字符串最大长度 */
const MAX_STRING_LENGTH = 256;
/** @constant {number} POST参数最大数量 */
const MAX_POST_ARGS_COUNT = 50;
/** @constant {number} POST参数最大长度 */
const MAX_POST_ARG_LENGTH = 1024;
/** @constant {number} POST环境变量最大长度 */
const MAX_POST_ENV_LENGTH = 512;
/** @constant {number} POST URL最大长度 */
const MAX_POST_URL_LENGTH = 2048;
/** @constant {number} POST内容最大长度 */
const MAX_POST_CONTENT_LENGTH = 1048576;
/** @constant {number} MCP stdio缓冲区最大大小 */
const MAX_MCP_STDIO_BUFFER = 1048576;
/** @constant {number} 请求体最大大小 */
const MAX_BODY_SIZE = 1048576;
/** @constant {number} 预期运行时模块总数 */
const EXPECTED_RUNTIME_MODULE_COUNT = 30;
/** @constant {number} HTTP Keep-Alive超时（毫秒） */
const HTTP_KEEP_ALIVE_TIMEOUT = 10000;
/** @constant {number} HTTP头超时（毫秒） */
const HTTP_HEADERS_TIMEOUT = 15000;
/** @constant {number} HTTP请求超时（毫秒） */
const HTTP_REQUEST_TIMEOUT = 30000;
/** @constant {number} Socket超时（毫秒） */
const SOCKET_TIMEOUT = 35000;
/** @constant {number} 审批门超时（毫秒） */
const APPROVAL_GATE_TIMEOUT = 300000;
/** @constant {number} 目标最大长度 */
const MAX_OBJECTIVE_LENGTH = 10000;
/** @constant {number} 上下文最大大小 */
const MAX_CONTEXT_SIZE = 50000;
/** @constant {number} 压缩超时（毫秒） */
const COMPRESS_TIMEOUT_MS = 5000;
/** @constant {number} 慢请求阈值（毫秒） */
const SLOW_REQUEST_THRESHOLD_MS = 3000;
/** @constant {number} RBAC重载冷却时间（毫秒） */
const RBAC_RELOAD_COOLDOWN_MS = 5000;
/** @constant {number} RBAC重载防抖时间（毫秒） */
const RBAC_RELOAD_DEBOUNCE_MS = 60000;

module.exports = {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_HOST,
  GRACEFUL_SHUTDOWN_TIMEOUT,
  MAX_HTTP_CONNECTIONS,
  MIME_TYPES,
  CACHE_TTL,
  MCP_ALLOWED_COMMANDS,
  MCP_DANGEROUS_ARG_PATTERNS,
  MCP_DANGEROUS_ENV_KEYS,
  KNOWLEDGE_ALLOWED_FIELDS,
  SENSITIVE_RATE_LIMITS,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX,
  RATE_LIMIT_CLEANUP_INTERVAL,
  MAX_URL_LENGTH,
  MAX_PAGE_SIZE,
  MAX_CACHE_ENTRIES,
  MAX_FM_CACHE_ENTRIES,
  LRU_FM_CACHE_SIZE,
  LRU_FILE_CACHE_SIZE,
  LRU_DIR_CACHE_SIZE,
  MAX_ARGS_LENGTH,
  REQUEST_TIMEOUT_MS,
  MAX_SOURCE_LENGTH,
  VALID_DESIGN_TYPES,
  VALID_DESIGN_COMPANIES,
  VALID_DESIGN_VARIANCES,
  VALID_DEVIATION_STATUSES,
  VALID_REVIEW_STATUSES,
  VALID_ALERT_LEVELS,
  VALID_LOG_LEVELS,
  JSON_CONTENT_TYPE,
  DEFAULT_TOKEN_BUDGET,
  COMPRESSION_THRESHOLD_BYTES,
  MAX_CHANGELOG_INPUT_LENGTH,
  RE_CHANGELOG_VERSION_SRC,
  RE_CHANGELOG_SECTION_SRC,
  RE_ITERATION_META_SRC,
  RE_CHANGELOG_ITEM_BOLD,
  RE_CHANGELOG_MODULE,
  RE_CHANGELOG_METHOD,
  RE_CHANGELOG_VALUE,
  MAX_LOCKS,
  HEALTH_MAX_LOCKS,
  HEALTH_MAX_CONFIRMATIONS,
  MAX_AGENT_HISTORY,
  MAX_SENSITIVE_RATE_MAP,
  MAX_RESPONSE_TIME_SAMPLES,
  MAX_SKILL_ID_LENGTH,
  MAX_STRING_LENGTH,
  MAX_POST_ARGS_COUNT,
  MAX_POST_ARG_LENGTH,
  MAX_POST_ENV_LENGTH,
  MAX_POST_URL_LENGTH,
  MAX_POST_CONTENT_LENGTH,
  MAX_MCP_STDIO_BUFFER,
  MAX_BODY_SIZE,
  EXPECTED_RUNTIME_MODULE_COUNT,
  HTTP_KEEP_ALIVE_TIMEOUT,
  HTTP_HEADERS_TIMEOUT,
  HTTP_REQUEST_TIMEOUT,
  SOCKET_TIMEOUT,
  APPROVAL_GATE_TIMEOUT,
  MAX_OBJECTIVE_LENGTH,
  MAX_CONTEXT_SIZE,
  COMPRESS_TIMEOUT_MS,
  SLOW_REQUEST_THRESHOLD_MS,
  RBAC_RELOAD_COOLDOWN_MS,
  RBAC_RELOAD_DEBOUNCE_MS,
};
