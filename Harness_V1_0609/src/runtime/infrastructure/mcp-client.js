'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const https = require('https');
const path = require('path');
const dns = require('dns');
const { debug } = require('../../utils/debug-logger');
const { emitError, safeCall } = require('../../utils/safe-execute');
const { sanitizeMcpEnv } = require('../../utils/sanitizer');
const { safeJsonParse } = require('../../utils/safe-parse');
const { DeepeningError } = require('../../errors');
const { BLOCKED_HOSTS: MCP_DEFAULT_BLOCKED_HOSTS, BLOCKED_HOSTS_SET: MCP_BLOCKED_HOSTS_SET, isPrivateIp: _isPrivateIp, isBlockedHost: _isBlockedHost } = require('../../utils/network-utils');
const { MAX_JSON_FILE_SIZE, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_FORCE_EXIT_MS } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MCP_CONNECT_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
const MCP_STDIO_MAX_BUFFER = 1024 * 1024;
const MCP_HTTP_MAX_BODY_SIZE = MAX_JSON_FILE_SIZE;
const MCP_HTTP_MAX_RESPONSE_SIZE = MAX_JSON_FILE_SIZE;
const MCP_HTTP_DEFAULT_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_MS;
const MCP_FORCE_KILL_DELAY_MS = DEFAULT_FORCE_EXIT_MS;
const MCP_DANGEROUS_ARGS = new Set(['-e', '--eval', '-c', '--command', '--exec', '--execute', '-i', '--interactive', '--import', '--package', '-p', '--yes', '-y']);
const MCP_STDIO_TRUNCATE_SIZE = 512 * 1024;
const MCP_MAX_PENDING_REQUESTS = 1000;
const MCP_STDERR_TRUNCATE_LENGTH = 8192;
const MCP_INIT_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness-mcp-client', version: '1.0.0' } };
const http = require('http');

function _safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err, address, family);
    if (_isPrivateIp(address)) {
      return cb(new DeepeningError('SSRF_BLOCKED', 'DNS rebinding blocked: ' + hostname + ' resolved to private IP ' + address), address, family);
    }
    cb(null, address, family);
  });
}

const MCP_ALLOWED_COMMANDS = new Set([
  'npx', 'uvx', 'cargo', 'dotnet', 'pnpm', 'yarn', 'npm',
  'python', 'python3',
]);

const MCP_DANGEROUS_ENV_KEYS = /^(PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|PYTHONPATH|PYTHONHOME|RUBYLIB|GEM_HOME|CLASSPATH|JAVA_HOME|GOPATH|CARGO_HOME|RUSTUP_HOME|SHELL|BASH_ENV|ENV|IFS|CDPATH|HISTFILE|HISTFILESIZE|HISTSIZE|MAIL|MAILPATH|TERM|TERMCAP|TMPDIR|TZ|LANG|LC_.+|LOCPATH|MALLOC_CHECK|MALLOC_TRACE|NIS_PATH|NLSPATH|POSIXLY_CORRECT|STEPPATH|TMOUT|VISUAL|DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|SSH_.+|AWS_.+|GOOGLE_.+|AZURE_.+|HARNESS_.+)$/i;

const MCP_INHERIT_ENV_KEYS = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ',
  'NODE_ENV', 'NPM_CONFIG_REGISTRY',
]);

function _extractTools(toolsResult) {
  return (toolsResult && toolsResult.result && toolsResult.result.tools) ?? [];
}

/**
 * @module runtime/infrastructure/mcp-client
 * @classdesc MCP协议客户端。stdio/HTTP双传输、SSRF防护
 * MCP协议客户端，支持stdio和HTTP双传输，进程管理，SSRF防护。
 * 支持OpenCLI集成（80+网站适配器，Chrome Bridge浏览器会话复用）。
 *
 * @class MCPClient
 * @extends EventEmitter
 *
 * @fires MCPClient#server-exit - 当MCP服务器进程退出时触发
 * @fires MCPClient#server-stderr - 当MCP服务器进程输出stderr时触发
 * @fires MCPClient#server-connected - 当MCP服务器成功连接时触发
 * @fires MCPClient#tool-called - 当调用MCP工具时触发
 * @fires MCPClient#error - 当发生错误时触发
 */
class MCPClient extends EventEmitter {
  /**
   * 创建 MCPClient 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.servers] - MCP服务器配置映射，键为服务器名称，值为服务器配置对象
   * @param {string[]} [options.blockedHosts] - 额外的SSRF屏蔽主机名列表
   * @param {number} [options.httpTimeout] - HTTP请求超时时间（毫秒），默认使用 MCP_HTTP_DEFAULT_TIMEOUT
   */
  constructor(options) {
    super();
    this._servers = {};
    this._tools = {};
    this._serverToolIndex = {};
    this._config = (options && options.servers) ?? {};
    this._httpTimeout = (options && typeof options.httpTimeout === 'number' && options.httpTimeout > 0) ? options.httpTimeout : MCP_HTTP_DEFAULT_TIMEOUT;
    this._blockedHosts = Array.isArray(options && options.blockedHosts) ? options.blockedHosts : [];
    this._stats = { serversConnected: 0, toolsDiscovered: 0, toolCalls: 0, errors: 0 };
    this._nextId = 1;
    this._pendingRequests = {};
    this._pendingRequestCount = 0;
    this._maxPendingRequests = MCP_MAX_PENDING_REQUESTS;
    this._stdioBuffers = {};
  }

  /**
   * 添加MCP服务器配置。对配置进行安全校验（命令白名单、参数过滤、SSRF防护）和环境变量消毒。
   * @param {string} name - 服务器名称，必须为非空字符串
   * @param {Object} config - 服务器配置对象，须包含 command（stdio模式）或 url（HTTP模式）
   * @param {string} [config.command] - stdio模式的启动命令
   * @param {string[]} [config.args] - 命令参数数组
   * @param {Object} [config.env] - 环境变量映射
   * @param {string} [config.url] - HTTP模式的服务器URL
   * @param {Object} [config.headers] - HTTP请求头
   * @param {boolean} [config.enabled] - 是否启用，默认为 true
   * @returns {MCPClient} 返回 this 以支持链式调用
   * @throws {DeepeningError} 名称无效、配置无效或安全校验失败时抛出错误
   */
  addServer(name, config) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') throw new DeepeningError('INVALID_INPUT', 'Server name is required and must be a string');
    if (!config || typeof config !== 'object') throw new DeepeningError('INVALID_INPUT', 'Server config is required and must be an object');
    const safeConfig = this._validateServerConfig(config);
    safeConfig.env = this._sanitizeEnv(config.env);
    this._config[name] = safeConfig;
    return this;
  }

  _validateServerConfig(config) {
    const safeConfig = {};
    if (config.command) {
      const cmdBase = path.basename(config.command).replace(/\.exe$/i, '').replace(/\.cmd$/i, '').replace(/\.ps1$/i, '');
      if (!MCP_ALLOWED_COMMANDS.has(cmdBase)) {
        throw new DeepeningError('SECURITY_VIOLATION', 'Command not allowed: ' + cmdBase + '. Allowed: ' + Array.from(MCP_ALLOWED_COMMANDS).join(', '));
      }
      if (path.isAbsolute(config.command)) {
        const resolvedCmd = path.resolve(config.command);
        const winPrefix = process.platform === 'win32' && process.env.SystemRoot ? process.env.SystemRoot + '\\' : null;
        const safePrefixes = ['/usr/bin/', '/usr/local/bin/', '/bin/'];
        if (winPrefix) safePrefixes.push(winPrefix);
        const isSafe = safePrefixes.some(function(p) { return p && resolvedCmd.startsWith(p); });
        if (!isSafe) {
          throw new DeepeningError('SECURITY_VIOLATION', 'Absolute command path not in trusted directories: ' + resolvedCmd);
        }
        safeConfig.command = resolvedCmd;
      } else {
        safeConfig.command = cmdBase;
      }
    }
    if (config.args) safeConfig.args = this._validateArgs(config.args);
    if (config.url) {
      if (typeof config.url !== 'string') throw new DeepeningError('INVALID_INPUT', 'config.url must be a string');
      let urlObj;
      try { urlObj = new URL(config.url); } catch (e) { throw new DeepeningError('INVALID_INPUT', 'Invalid URL: ' + (e && e.message ? e.message : String(e)), { cause: e }); }
      const hostname = urlObj.hostname.toLowerCase();
      this._checkSsrfHostname(hostname, this._getBlockedHostsSet());
      safeConfig.url = config.url;
    }
    if (config.headers) safeConfig.headers = config.headers;
    if (config.enabled !== undefined) safeConfig.enabled = config.enabled;
    return safeConfig;
  }

  _checkSsrfHostname(hostname, blockedHosts) {
    const hosts = blockedHosts ?? MCP_BLOCKED_HOSTS_SET;
    const blocked = hosts.has ? hosts.has(hostname) : hosts.includes(hostname);
    if (blocked || _isBlockedHost(hostname)) {
      throw new DeepeningError('SECURITY_VIOLATION', 'SSRF blocked: hostname ' + hostname + ' is not allowed');
    }
  }

  _validateArgs(args) {
    if (!Array.isArray(args)) throw new DeepeningError('INVALID_INPUT', 'config.args must be an array');
    const safeArgs = [];
    for (const arg of args) {
      if (typeof arg !== 'string') throw new DeepeningError('INVALID_INPUT', 'config.args items must be strings');
      if (MCP_DANGEROUS_ARGS.has(arg)) throw new DeepeningError('SECURITY_VIOLATION', 'Dangerous argument not allowed: ' + arg);
      safeArgs.push(arg);
    }
    return safeArgs;
  }

  _sanitizeEnv(env) {
    return sanitizeMcpEnv(env, MCP_DANGEROUS_ENV_KEYS);
  }

  /**
   * 移除MCP服务器。终止stdio进程、取消该服务器的所有待处理请求并移除其注册的工具。
   * @param {string} name - 要移除的服务器名称
   * @returns {MCPClient} 返回 this 以支持链式调用
   */
  removeServer(name) {
    delete this._config[name];
    const server = this._servers[name];
    if (server && server.type === 'stdio' && server.process) {
      if (server.process.stdin) server.process.stdin.removeAllListeners();
      if (server.process.stdout) server.process.stdout.removeAllListeners();
      if (server.process.stderr) server.process.stderr.removeAllListeners();
      server.process.removeAllListeners();
      if (!server.process.killed) {
        safeCall(() => server.process.kill(), 'MCPClient', 'removeServer:kill');
      }
    }
    for (const [id, entry] of Object.entries(this._pendingRequests)) {
      if (entry && entry.serverName === name) {
        clearTimeout(entry.timer);
        delete this._pendingRequests[id];
        this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
        safeCall(() => entry.reject(new DeepeningError('SERVER_REMOVED', 'Server ' + name + ' removed')), 'MCPClient', 'removeServer:reject');
      }
    }
    delete this._servers[name];
    delete this._stdioBuffers[name];
    this._removeServerTools(name);
    return this;
  }

  /**
   * 连接所有已配置且未禁用的MCP服务器。使用 Promise.allSettled 并行连接，单个失败不影响其他服务器。
   * @returns {Promise<Object<string, {connected: boolean, type?: string, toolCount?: number, error?: string, reason?: string}>>}
   *   各服务器的连接结果映射，键为服务器名称
   */
  async connectAll() {
    this.guardShutdown();
    const results = {};
    const entries = Object.entries(this._config).filter(([, config]) => config.enabled !== false);
    const settled = await Promise.allSettled(entries.map(([name, config]) => this.connectServer(name, config)));
    for (let i = 0; i < entries.length; i++) {
      const [name] = entries[i];
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results[name] = outcome.value;
      } else {
        results[name] = { connected: false, error: outcome.reason && outcome.reason.message ? outcome.reason.message : String(outcome.reason) };
        this._stats.errors++;
      }
    }
    for (const [name, config] of Object.entries(this._config)) {
      if (config.enabled === false) {
        results[name] = { connected: false, reason: 'disabled' };
      }
    }
    return results;
  }

  /**
   * 连接单个MCP服务器。根据配置自动选择stdio或HTTP传输模式，完成初始化握手和工具发现。
   * 若服务器已存在则先移除旧连接。
   * @param {string} name - 服务器名称，必须为非空字符串
   * @param {Object} config - 服务器配置对象
   * @param {string} [config.command] - stdio模式启动命令
   * @param {string} [config.url] - HTTP模式服务器URL
   * @returns {Promise<{connected: boolean, type?: string, toolCount?: number, error?: string}>} 连接结果
   * @throws {DeepeningError} 名称无效、配置既无command也无url、服务器配置验证失败或连接无法建立时抛出错误
   */
  async connectServer(name, config) {
    if (!name || typeof name !== 'string') throw new DeepeningError('INVALID_INPUT', 'Server name must be a non-empty string');
    if (this._servers[name]) this.removeServer(name);
    this._validateServerConfig(config);
    if (config.command) {
      return this._connectStdio(name, config);
    } else if (config.url) {
      return this._connectHttp(name, config);
    }
    throw new DeepeningError('MCP_ERROR', 'Server ' + name + ' has neither command nor url');
  }

  _setupStdioBuffer(name) {
    if (this._stdioBuffers[name]) {
      delete this._stdioBuffers[name];
    }
    this._stdioBuffers[name] = '';
    const server = this._servers[name];
    if (!server || !server.process || !server.process.stdout) return;

    server.process.stdout.removeAllListeners('data');
    server.process.stdout.on('data', (data) => {
      this._stdioBuffers[name] += data.toString();
      if (this._stdioBuffers[name].length > MCP_STDIO_MAX_BUFFER) {
        const truncated = this._stdioBuffers[name].slice(-MCP_STDIO_TRUNCATE_SIZE);
        const firstNewline = truncated.indexOf('\n');
        this._stdioBuffers[name] = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated;
      }
      const lines = this._stdioBuffers[name].split('\n');
      this._stdioBuffers[name] = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this._handleStdioLine(name, trimmed);
      }
    });
  }

  _handleStdioLine(name, trimmed) {
    let parsed = null;
    let id = null;
    try {
      parsed = safeJsonParse(trimmed, null, 'MCPClient');
      if (!parsed || typeof parsed !== 'object') return;
      id = parsed.id;
      if (id && this._pendingRequests[id]) {
        this._resolvePendingRequest(id, parsed);
      }
    } catch (e) {
      debug('MCPClient', '_sendStdioRequest:jsonParse', e);
      const errId = (parsed && parsed.id) || id;
      if (errId && this._pendingRequests[errId]) {
        this._rejectPendingRequest(errId, new DeepeningError('PARSE_ERROR', 'Failed to parse response: ' + (e && e.message ? e.message : String(e))));
      }
    }
  }

  _resolvePendingRequest(id, parsed) {
    const pending = this._pendingRequests[id];
    if (!pending) return;
    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    delete this._pendingRequests[id];
    this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
    if (parsed.error) {
      const errMsg = (typeof parsed.error === 'object' && parsed.error.message)
        ? parsed.error.message
        : String(parsed.error && parsed.error.message ? parsed.error.message : parsed.error);
      reject(new DeepeningError('RPC_ERROR', errMsg));
    } else if ('result' in parsed) {
      resolve(parsed);
    } else {
      reject(new DeepeningError('INVALID_RESPONSE', 'Invalid JSON-RPC response: missing result or error field'));
    }
  }

  _rejectPendingRequest(id, err) {
    const pending = this._pendingRequests[id];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete this._pendingRequests[id];
    this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
    pending.reject(err);
  }

  async _connectStdio(name, config) {
    if (this._servers[name]) this.removeServer(name);
    let proc;
    try {
      const safeEnv = {};
      for (const key of Object.keys(process.env)) {
        if (MCP_INHERIT_ENV_KEYS.has(key)) {
          safeEnv[key] = process.env[key];
        }
      }
      if (config.env) {
        for (const key of Object.keys(config.env)) {
          safeEnv[key] = config.env[key];
        }
      }
      proc = spawn(config.command, config.args ?? [], {
        env: safeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._stats.errors++;
      emitError(this, 'server-error', err, { server: name });
      return { connected: false, error: err && err.message ? err.message : String(err) };
    }

    this._servers[name] = { type: 'stdio', process: proc, config };
    this._setupStdioBuffer(name);

    proc.on('error', (err) => {
      emitError(this, 'server-error', err, { server: name });
    });

    proc.on('exit', (code) => {
      this.emit('server-exit', { server: name, code });
      const server = this._servers[name];
      if (server) server._exited = true;
      if (proc.stdout) proc.stdout.removeAllListeners();
      if (proc.stderr) proc.stderr.removeAllListeners();
      for (const [id, entry] of Object.entries(this._pendingRequests)) {
        if (entry && entry.serverName === name) {
          clearTimeout(entry.timer);
          delete this._pendingRequests[id];
          this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
          safeCall(() => entry.reject(new DeepeningError('SERVER_EXIT', 'Server ' + name + ' exited with code ' + code)), 'MCPClient', 'rejectOnExit');
        }
      }
      delete this._stdioBuffers[name];
    });

    proc.on('close', () => {
      const server = this._servers[name];
      if (server && !server._exited) {
        server._exited = true;
      }
    });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      this.emit('server-stderr', { server: name, data: str.length > MCP_STDERR_TRUNCATE_LENGTH ? str.slice(0, MCP_STDERR_TRUNCATE_LENGTH) + '...[truncated]' : str });
    });

    proc.stdin.on('error', (err) => {
      debug('MCPClient', 'stdin', 'Error for ' + name + ': ' + (err && err.message ? err.message : String(err)));
    });

    try {
      await this._sendStdioRequest(name, {
        jsonrpc: '2.0', id: this._nextId++, method: 'initialize',
        params: MCP_INIT_PARAMS,
      });

      this._sendStdioNotification(name, {
        jsonrpc: '2.0', method: 'notifications/initialized',
      });

      const toolsResult = await this._sendStdioRequest(name, {
        jsonrpc: '2.0', id: this._nextId++, method: 'tools/list', params: {},
      });

      const tools = _extractTools(toolsResult);
      this._registerTools(name, tools, config);
      this._stats.serversConnected++;
      this.emit('server-connected', { server: name, type: 'stdio', toolCount: tools.length });

      return { connected: true, type: 'stdio', toolCount: tools.length };
    } catch (err) {
      emitError(this, 'server-error', err, { server: name });
      safeCall(() => proc.stderr.removeAllListeners(), 'MCPClient', 'connect:stderrCleanup');
      safeCall(() => proc.stdout.removeAllListeners(), 'MCPClient', 'connect:stdoutCleanup');
      if (proc && !proc.killed) {
        if (process.platform === 'win32') {
          safeCall(() => proc.kill(), 'MCPClient', 'connect:killOnError');
        } else {
          safeCall(() => proc.kill('SIGKILL'), 'MCPClient', 'connect:killOnError');
        }
      }
      delete this._servers[name];
      delete this._stdioBuffers[name];
      return { connected: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _connectHttp(name, config) {
    if (config.url) {
      let urlObj;
      try { urlObj = new URL(config.url); } catch (e) {
        return { connected: false, error: 'Invalid URL: ' + (e && e.message ? e.message : String(e)) };
      }
      const hostname = urlObj.hostname.toLowerCase();
      this._checkSsrfHostname(hostname, this._getBlockedHostsSet());
    }
    this._servers[name] = { type: 'http', url: config.url, config };

    try {
      await this._sendHttpRequest(config.url, {
        jsonrpc: '2.0', id: this._nextId++, method: 'initialize',
        params: MCP_INIT_PARAMS,
      }, config.headers);

      const toolsResult = await this._sendHttpRequest(config.url, {
        jsonrpc: '2.0', id: this._nextId++, method: 'tools/list', params: {},
      }, config.headers);

      const tools = _extractTools(toolsResult);
      this._registerTools(name, tools, config);
      this._stats.serversConnected++;
      this.emit('server-connected', { server: name, type: 'http', toolCount: tools.length });

      return { connected: true, type: 'http', toolCount: tools.length };
    } catch (err) {
      delete this._servers[name];
      emitError(this, 'server-error', err, { server: name });
      return { connected: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _registerTools(serverName, tools, config) {
    const include = (config.tools && config.tools.include) ?? null;
    const exclude = (config.tools && config.tools.exclude) ?? [];
    const includeSet = include ? new Set(Array.isArray(include) ? include : [include]) : null;
    const excludeSet = new Set(Array.isArray(exclude) ? exclude : (exclude != null ? [exclude] : []));
    if (!this._serverToolIndex[serverName]) this._serverToolIndex[serverName] = [];

    for (const tool of tools) {
      if (includeSet && !includeSet.has(tool.name)) continue;
      if (excludeSet.has(tool.name)) continue;

      const fullName = `mcp_${serverName}_${tool.name}`;
      this._tools[fullName] = {
        name: fullName,
        originalName: tool.name,
        server: serverName,
        description: tool.description || '',
        inputSchema: tool.inputSchema ?? {},
      };
      this._serverToolIndex[serverName].push(fullName);
      this._stats.toolsDiscovered++;
    }
  }

  _removeServerTools(serverName) {
    const toolKeys = this._serverToolIndex[serverName];
    if (toolKeys) {
      for (const key of toolKeys) delete this._tools[key];
      delete this._serverToolIndex[serverName];
    }
  }

  /**
   * 调用MCP工具。根据工具所属服务器的传输模式（stdio/HTTP）发送JSON-RPC请求。
   * @param {string} fullName - 工具全名（格式：mcp_{serverName}_{toolName}）
   * @param {Object|null} [args] - 工具调用参数，必须为对象或null/undefined
   * @returns {Promise<Object>} JSON-RPC响应结果
   * @throws {DeepeningError} 工具名无效、参数类型错误、工具不存在、服务器未连接或调用失败时抛出错误
   */
  async callTool(fullName, args) {
    this.guardShutdown();
    if (!fullName || typeof fullName !== 'string') throw new DeepeningError('INVALID_INPUT', 'fullName must be a non-empty string');
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new DeepeningError('INVALID_INPUT', 'args must be an object or null/undefined');
    }
    const tool = this._tools[fullName];
    if (!tool) throw new DeepeningError('RESOURCE_NOT_FOUND', 'Tool not found: ' + fullName);

    const server = this._servers[tool.server];
    if (!server) throw new DeepeningError('CONNECTION_FAILED', 'Server not connected: ' + tool.server);

    this._stats.toolCalls++;
    const request = {
      jsonrpc: '2.0', id: this._nextId++, method: 'tools/call',
      params: { name: tool.originalName, arguments: args ?? {} },
    };

    try {
      let result;
      if (server.type === 'stdio') {
        result = await this._sendStdioRequest(tool.server, request);
      } else {
        result = await this._sendHttpRequest(server.url || server.config.url, request, server.config.headers);
      }

      this.emit('tool-called', { tool: fullName, success: true });
      return result;
    } catch (err) {
      this._stats.errors++;
      this.emit('tool-called', { tool: fullName, success: false, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  _sendStdioRequest(serverName, request) {
    return new Promise((resolve, reject) => {
      let settled = false;
      if (this._shutDown) { settled = true; return reject(new DeepeningError('SHUTDOWN', 'Client is shutting down')); }
      if (this._pendingRequestCount >= this._maxPendingRequests) {
        settled = true;
        return reject(new DeepeningError('CAPACITY_EXCEEDED', 'Too many pending requests (' + this._pendingRequestCount + ')'));
      }
      const server = this._servers[serverName];
      if (!server || !server.process || !server.process.stdin || server._exited) {
        settled = true;
        return reject(new DeepeningError('NOT_CONNECTED', `Server ${serverName} not connected`));
      }

      const id = request.id;
      const timer = setTimeout(() => {
        if (this._shutDown) return;
        if (settled) return;
        settled = true;
        delete this._pendingRequests[id];
        this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
        reject(new DeepeningError('TIMEOUT', 'Request timeout'));
      }, MCP_CONNECT_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();

      this._pendingRequests[id] = {
        resolve: (val) => { if (!settled) { settled = true; resolve(val); } },
        reject: (err) => { if (!settled) { settled = true; reject(err); } },
        timer,
        serverName,
      };
      this._pendingRequestCount++;

      const msg = JSON.stringify(request) + '\n';
      try {
        server.process.stdin.write(msg, (err) => {
          if (err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            delete this._pendingRequests[id];
            this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
            reject(new DeepeningError('IO_ERROR', `Failed to write to server ${serverName}: ${err && err.message ? err.message : String(err)}`, { cause: err }));
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          delete this._pendingRequests[id];
          this._pendingRequestCount = Math.max(0, this._pendingRequestCount - 1);
          reject(new DeepeningError('IO_ERROR', `Failed to write to server ${serverName}: ${err && err.message ? err.message : String(err)}`, { cause: err }));
        }
      }
    });
  }

  _sendStdioNotification(serverName, notification) {
    const server = this._servers[serverName];
    if (!server || !server.process || !server.process.stdin || server._exited) return;
    safeCall(() => server.process.stdin.write(JSON.stringify(notification) + '\n'), 'MCPClient', '_sendStdioNotification:write');
  }

  _getBlockedHostsSet() {
    const allBlocked = MCP_DEFAULT_BLOCKED_HOSTS.concat(this._blockedHosts);
    return new Set(allBlocked);
  }

  _sendHttpRequest(url, request, headers) {
    const BLOCKED_HOSTS = this._getBlockedHostsSet();

    return new Promise((resolve, reject) => {
      let settled = false;
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return reject(new DeepeningError('INVALID_URL', 'Invalid URL: ' + (e && e.message ? e.message : String(e)), { cause: e }));
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return reject(new DeepeningError('INVALID_PROTOCOL', 'Unsupported protocol: ' + parsedUrl.protocol));
      }

      try {
        this._checkSsrfHostname(parsedUrl.hostname, BLOCKED_HOSTS);
      } catch (err) {
        return reject(err);
      }

      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > MCP_HTTP_MAX_BODY_SIZE) {
        return reject(new DeepeningError('PAYLOAD_TOO_LARGE', 'Request body exceeds maximum size of ' + MCP_HTTP_MAX_BODY_SIZE + ' bytes'));
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const timeout = this._httpTimeout;

      const safeHeaders = {};
      const forbiddenHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
      if (headers && typeof headers === 'object' && headers !== null) {
        for (const [k, v] of Object.entries(headers)) {
          if (!forbiddenHeaders.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) safeHeaders[k] = v;
        }
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.path,
        method: 'POST',
        lookup: _safeLookup,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...safeHeaders,
        },
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (!settled) { settled = true; reject(new DeepeningError('HTTP_ERROR', 'HTTP ' + res.statusCode + ' response')); }
          res.resume();
          return;
        }
        let data = '';
        let responseSize = 0;
        res.on('data', (chunk) => {
          responseSize += chunk.length;
          if (responseSize > MCP_HTTP_MAX_RESPONSE_SIZE) {
            req.destroy();
            if (!settled) { settled = true; reject(new DeepeningError('PAYLOAD_TOO_LARGE', 'Response exceeds maximum size of ' + MCP_HTTP_MAX_RESPONSE_SIZE + ' bytes')); }
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          try { resolve(safeJsonParse(data, null, 'MCPClient')); }
          catch (e) { debug('MCPClient', '_sendHttpRequest:jsonParse', e && e.message ? e.message : String(e)); reject(new DeepeningError('INVALID_RESPONSE', 'Invalid JSON response: ' + (e && e.message ? e.message : String(e)), { cause: e })); }
        });
        res.on('error', (err) => {
          if (!settled) { settled = true; reject(new DeepeningError('RESPONSE_ERROR', err && err.message ? err.message : String(err), { cause: err })); }
        });
      });

      req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      req.setTimeout(timeout, () => { if (!settled) { settled = true; req.destroy(); reject(new DeepeningError('TIMEOUT', 'Request timeout after ' + timeout + 'ms')); } });
      req.write(body);
      req.end();
    });
  }

  /**
   * 获取所有已发现的MCP工具列表。
   * @returns {Array<{name: string, originalName: string, server: string, description: string, inputSchema: Object}>} 工具信息数组
   */
  getAvailableTools() {
    return Object.values(this._tools);
  }

  /**
   * 获取所有已连接MCP服务器的状态信息。
   * @returns {Object<string, {type: string, connected: boolean, toolCount: number}>} 服务器状态映射，键为服务器名称
   */
  getServerStatus() {
    const status = {};
    for (const [name, server] of Object.entries(this._servers)) {
      status[name] = {
        type: server.type,
        connected: server.type === 'stdio' ? !!(server.process && !server.process.killed && !server._exited) : true,
        toolCount: (this._serverToolIndex[name] ?? []).length,
      };
    }
    return status;
  }

  /**
   * 获取MCP客户端的运行统计数据。
   * @returns {{serversConnected: number, toolsDiscovered: number, toolCalls: number, errors: number, serverCount: number, toolCount: number}} 统计信息对象
   */
  getStats() {
    return { ...this._stats, serverCount: Object.keys(this._servers).length, toolCount: Object.keys(this._tools).length };
  }

  /**
   * 检查MCP客户端是否健康。至少有一个服务器连接且该服务器进程存活时返回true。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    const servers = Object.values(this._servers);
    if (servers.length === 0) return false;
    return servers.some(s => {
      if (s.type === 'stdio') return s.process && !s.process.killed && !s._exited;
      return true;
    });
  }

  _onShutdown() {
    for (const id of Object.keys(this._pendingRequests)) {
      const entry = this._pendingRequests[id];
      if (!entry) continue;
      const { reject, timer } = entry;
      clearTimeout(timer);
      safeCall(() => reject(new DeepeningError('SHUTDOWN', 'Client shutting down')), 'MCPClient', 'shutdown:reject');
    }
    this._pendingRequests = {};

    for (const [, server] of Object.entries(this._servers)) {
      if (server.type === 'stdio' && server.process) {
        safeCall(() => { if (server.process.stdin) { server.process.stdin.removeAllListeners(); server.process.stdin.end(); } }, 'MCPClient', 'shutdown:stdinEnd');
        if (server.process.stdout) server.process.stdout.removeAllListeners();
        if (server.process.stderr) server.process.stderr.removeAllListeners();
        server.process.removeAllListeners();
        if (!server.process.killed) {
          try {
            if (process.platform === 'win32') {
              server.process.kill();
            } else {
              server.process.kill('SIGTERM');
            }
          } catch (killErr) {
            debug('MCPClient', 'shutdown:kill', killErr);
          }
          server._forceKillTimer = setTimeout(function() {
            safeCall(() => server.process.kill('SIGKILL'), 'MCPClient', 'shutdown:forceKill');
          }, MCP_FORCE_KILL_DELAY_MS);
          if (server._forceKillTimer && typeof server._forceKillTimer.unref === 'function') server._forceKillTimer.unref();
          server.process.once('exit', function() {
            if (server._forceKillTimer) {
              clearTimeout(server._forceKillTimer);
              server._forceKillTimer = null;
            }
          });
          if (server._forceKillTimer && typeof server._forceKillTimer.unref === 'function') server._forceKillTimer.unref();
        } else {
          if (server._forceKillTimer) {
            clearTimeout(server._forceKillTimer);
            server._forceKillTimer = null;
          }
        }
      }
    }
    this._servers = {};
    this._tools = {};
    this._stdioBuffers = {};
    this._config = {};
    this.removeAllListeners();
  }
}

module.exports = withShutdown(MCPClient);
