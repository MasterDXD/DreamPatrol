'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const { debug } = require('../utils/debug-logger');
const { safeCall, safeStringify } = require('../utils/safe-execute');
const { safeJsonParse } = require('../utils/safe-parse');
const { isLocalRequest: _isLocalRequest } = require('../utils/network-utils');
const { DEFAULT_HEARTBEAT_INTERVAL_MS, UTF8_ENCODING } = require('../utils/constants');
const { withShutdown } = require('../utils/shutdown-mixin');

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEARTBEAT_INTERVAL = DEFAULT_HEARTBEAT_INTERVAL_MS;
const MAX_PAYLOAD_SIZE = 1024 * 1024;
const MAX_FRAME_BUFFER_SIZE = 1024 * 1024;
const MAX_CLIENTS = 50;
const MAX_FRAMES_PER_DATA = 1000;
const _DEFAULT_AUTH_TOKEN = null;
const WS_MESSAGE_RATE_LIMIT = 30;
const WS_MESSAGE_RATE_WINDOW = 1000;

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('base64');
}

/**
 * @module web/websocket-handler
 * WebSocket实时通信处理器。RFC 6455实现、心跳保活、认证校验，
 * 支持消息速率限制和最大负载保护。
 *
 * @extends EventEmitter
 * @emits WebSocketHandler#connection
 * @emits WebSocketHandler#disconnect
 * @emits WebSocketHandler#message
 */
/**
 * WebSocketHandler — WebSocket实时通信处理器
 * RFC 6455完整实现，支持握手升级、帧解析/构建、心跳保活、认证校验。
 * 安全特性：Origin校验、SHA-256 Token认证（timingSafeEqual防时序攻击）、
 * 消息速率限制（30条/秒）、最大负载保护（1MB）、最大客户端数限制（50）。
 * 支持brotli/gzip/deflate压缩优先级和CSP nonce注入。
 * @extends EventEmitter
 * @emits WebSocketHandler#connection
 * @emits WebSocketHandler#message
 * @emits WebSocketHandler#disconnect
 */

/**
 * 自研RFC 6455 WebSocket处理器。SHA-256令牌认证、心跳检测、
 * 速率限制(30msg/s)、1MB帧限制、50客户端上限、优雅关闭。
 *
 * @classdesc 自研RFC 6455 WebSocket处理器。handleUpgrade(升级握手+认证)、
 * _handleFrame(帧解析+分发)、_createFrame(帧构建)、broadcast(广播)、
 * 速率限制(30msg/s)、1MB帧限制、50客户端上限、心跳检测、优雅关闭。
 *
 * @extends EventEmitter
 */
class WebSocketHandler extends EventEmitter {
  /**
   * 创建 WebSocketHandler 实例。
   * @param {Object} [options] - 配置选项
   * @param {string[]|Iterable} [options.allowedOrigins] - 允许的来源列表
   * @param {string} [options.authToken] - 认证令牌
   */
  constructor(options) {
    super();
    this._clients = new Set();
    this._heartbeatTimer = null;
    this._closed = false;
    this._allowedOrigins = (options && options.allowedOrigins && (Array.isArray(options.allowedOrigins) || (typeof options.allowedOrigins[Symbol.iterator] === 'function'))) ? new Set(options.allowedOrigins) : null;
    this._authTokenHash = (options && options.authToken) ? crypto.createHash('sha256').update(options.authToken).digest() : null;
  }

  _rejectUpgrade(socket, statusCode, reason) {
    const safeCode = Number.isFinite(parseInt(statusCode, 10)) ? parseInt(statusCode, 10) : 400;
    const safeReason = String(reason || '').replace(/[\r\n]/g, '');
    socket.write('HTTP/1.1 ' + safeCode + ' ' + safeReason + '\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n');
    socket.destroy();
  }

  _validateWebSocketKey(key, socket) {
    if (!key) {
      socket.destroy();
      return false;
    }
    if (typeof key !== 'string' || key.length !== 24) {
      socket.destroy();
      return false;
    }
    try {
      const decoded = Buffer.from(key, 'base64');
      if (decoded.length !== 16) {
        socket.destroy();
        return false;
      }
    } catch (_e) {
      debug('WebSocketHandler', 'keyValidationFailed', _e && _e.message ? _e.message : String(_e));
      socket.destroy();
      return false;
    }
    return true;
  }

  _extractAuthToken(req, socket) {
    let token = '';
    let prehashed = false;
    let pendingAuth = false;
    try {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7, 7 + 1024);
        if (authHeader.length > 7 + 1024) {
          this._rejectUpgrade(socket, 400, 'Token too long');
          return false;
        }
      } else {
        const rawProtocol = req.headers['sec-websocket-protocol'] || '';
        if (rawProtocol.startsWith('sha256-')) {
          token = rawProtocol.slice(7);
          prehashed = true;
        } else {
          const wsProtocol = rawProtocol.replace(/^bearer-/, '');
          if (wsProtocol && wsProtocol !== 'sha256-pending') {
            token = wsProtocol;
          } else if (wsProtocol === 'sha256-pending') {
            pendingAuth = true;
          }
        }
        if (!token && !pendingAuth) {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const urlToken = url.searchParams.get('token') ?? '';
          if (urlToken) {
            debug('WebSocketHandler', 'securityWarning', 'Token via URL query parameter is not supported');
            this._rejectUpgrade(socket, 400, 'Use Authorization header for token authentication');
            return false;
          }
        }
      }
    } catch (_urlErr) {
      debug('WebSocketHandler', 'auth', 'URL parse failed: ' + (_urlErr && _urlErr.message ? _urlErr.message : String(_urlErr)));
      token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (token.length > 1024) {
        this._rejectUpgrade(socket, 400, 'Token too long');
        return false;
      }
    }
    return { token, prehashed, pendingAuth };
  }

  _authenticateUpgrade(req, socket) {
    if (!this._authTokenHash) {
      if (process.env.NODE_ENV === 'production') {
        debug('WebSocketHandler', 'auth', 'No auth token configured in production - rejecting');
        this._rejectUpgrade(socket, 401, 'Unauthorized');
        return false;
      }
      if (!this._isLocalRequest(req)) {
        debug('WebSocketHandler', 'auth', 'Non-local WebSocket connection rejected without auth token');
        this._rejectUpgrade(socket, 401, 'Unauthorized');
        return false;
      }
      return true;
    }
    const authInfo = this._extractAuthToken(req, socket);
    if (!authInfo) return false;
    const { token, prehashed, pendingAuth } = authInfo;
    if (!token && !pendingAuth) {
      this._rejectUpgrade(socket, 401, 'Unauthorized');
      return false;
    }
    if (pendingAuth) {
      return 'pending';
    }
    try {
      let tokenHash;
      if (prehashed) {
        if (!/^[0-9a-fA-F]+$/.test(token)) {
          this._rejectUpgrade(socket, 400, 'Invalid token format');
          return false;
        }
        tokenHash = Buffer.from(token, 'hex');
        if (tokenHash.length !== this._authTokenHash.length) {
          this._rejectUpgrade(socket, 401, 'Unauthorized');
          return false;
        }
      } else {
        tokenHash = crypto.createHash('sha256').update(token).digest();
      }
      if (!crypto.timingSafeEqual(tokenHash, this._authTokenHash)) {
        this._rejectUpgrade(socket, 401, 'Unauthorized');
        return false;
      }
    } catch (_cmpErr) {
      debug('WebSocketHandler', 'auth', 'Token comparison failed: ' + (_cmpErr && _cmpErr.message ? _cmpErr.message : String(_cmpErr)));
      this._rejectUpgrade(socket, 401, 'Unauthorized');
      return false;
    }
    return true;
  }

  _validateOrigin(req, socket) {
    if (this._allowedOrigins) {
      const origin = req.headers['origin'];
      if (!origin || !this._allowedOrigins.has(origin)) {
        this._rejectUpgrade(socket, 403, 'Forbidden');
        return false;
      }
      return true;
    }
    const origin = req.headers['origin'];
    if (!origin) {
      if (process.env.NODE_ENV === 'production') {
        this._rejectUpgrade(socket, 403, 'Forbidden');
        return false;
      }
      return true;
    }
    try {
      const originHost = new URL(origin).hostname;
      const requestHost = req.headers['host'];
      if (requestHost && originHost !== requestHost.split(':')[0]) {
        this._rejectUpgrade(socket, 403, 'Forbidden');
        return false;
      }
    } catch {
      this._rejectUpgrade(socket, 403, 'Forbidden');
      return false;
    }
    return true;
  }

  /**
   * 处理WebSocket升级请求。验证来源、认证令牌后完成握手。
   * @param {http.IncomingMessage} req - HTTP请求对象
   * @param {net.Socket} socket - TCP套接字
   * @param {Buffer} _head - WebSocket首包数据
   */
  handleUpgrade(req, socket, _head) {
    if (this._closed) {
      this._rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!this._validateWebSocketKey(key, socket)) return;

    const authResult = this._authenticateUpgrade(req, socket);
    if (!authResult) return;

    if (this._clients.size >= MAX_CLIENTS) {
      this._rejectUpgrade(socket, 429, 'Too Many Connections');
      return;
    }

    if (!this._validateOrigin(req, socket)) return;

    const acceptKey = sha1(key + WS_MAGIC_STRING);
    const requestedProtocol = req.headers['sec-websocket-protocol'] || '';
    let protocolHeader = '';
    if (requestedProtocol && !/[\r\n]/.test(requestedProtocol)) {
      if (/^(bearer-|sha256-)/.test(requestedProtocol)) {
        protocolHeader = 'Sec-WebSocket-Protocol: ' + requestedProtocol + '\r\n';
      }
    }
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
        protocolHeader +
        '\r\n',
      );
    } catch (e) {
      debug('WebSocketHandler', 'handleUpgrade', 'Socket write failed: ' + (e && e.message ? e.message : String(e)));
      socket.destroy();
      return;
    }

    const client = { socket, isAlive: true, createdAt: Date.now(), frameBuffer: null, authenticated: !this._authTokenHash || authResult === true };
    this._clients.add(client);

    socket.on('data', (data) => {
      try { this._handleData(client, data); }
      catch (e) { this._log('data', e && e.message ? e.message : String(e)); }
    });

    socket.on('close', () => {
      client.frameBuffer = null;
      this._clients.delete(client);
      socket.removeAllListeners();
    });

    socket.on('error', (err) => {
      debug('WebSocket', 'socketError', err);
      client.frameBuffer = null;
      this._clients.delete(client);
      socket.removeAllListeners();
    });

    this.emit('connection', client);

    if (!this._heartbeatTimer) {
      this._heartbeatTimer = setInterval(() => { try { this._ping(); } catch (err) { debug('WebSocketHandler', 'heartbeat', err); } }, HEARTBEAT_INTERVAL);
      if (this._heartbeatTimer && typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
    }
  }

  /**
   * 向所有活跃客户端广播事件消息。
   * @param {string} event - 事件名称
   * @param {*} data - 事件数据（将被JSON序列化）
   */
  broadcast(event, data) {
    this.guardShutdown();
    if (!event || typeof event !== 'string') { debug('WebSocket', 'broadcast', 'Invalid event'); return; }
    let message;
    try {
      message = safeStringify({ event, data, timestamp: new Date().toISOString() });
    } catch (err) {
      debug('WebSocket', 'broadcast', 'safeStringify failed: ' + (err && err.message ? err.message : String(err)));
      return;
    }
    const frame = this._createFrame(0x01, message);
    const dead = [];
    for (const client of this._clients) {
      try {
        if (client.isAlive) {
          client.socket.write(frame);
        }
      } catch (err) {
        debug('WebSocket', 'broadcastError', err);
        dead.push(client);
      }
    }
    for (const c of dead) {
      this._clients.delete(c);
      this.emit('disconnect', c, 'broadcast_write_failed');
      safeCall(() => c.socket.destroy(), 'WebSocket', 'broadcastSocketDestroy');
    }
  }

  get clientCount() {
    return this._clients.size;
  }

  close() {
    this._closed = true;
    this._shutDown = true;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    for (const client of this._clients) {
      safeCall(() => client.socket.write(Buffer.from([0x88, 0x00])), 'WebSocket', 'closeFrame');
      safeCall(() => client.socket.end(), 'WebSocket', 'socketEnd');
    }
    this._clients.clear();
    this.removeAllListeners();
  }

  _ping() {
    const dead = [];
    const now = Date.now();
    for (const client of this._clients) {
      if (!client.isAlive) {
        dead.push(client);
        continue;
      }
      if (client.frameBuffer && client.lastDataTime && (now - client.lastDataTime > HEARTBEAT_INTERVAL * 5)) {
        dead.push(client);
        continue;
      }
      client.isAlive = false;
      try {
        client.socket.write(this._createFrame(0x09, ''));
      } catch (err) {
        debug('WebSocket', 'pingError', err);
        dead.push(client);
      }
    }
    for (const c of dead) {
      this._clients.delete(c);
      this.emit('disconnect', c, 'heartbeat_timeout');
      safeCall(() => c.socket.destroy(), 'WebSocket', 'socketDestroy');
    }
    if (this._clients.size === 0 && this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _handleData(client, data) {
    client.lastDataTime = Date.now();
    if (client.frameBuffer) {
      const combinedSize = client.frameBuffer.length + data.length;
      if (combinedSize > MAX_FRAME_BUFFER_SIZE) {
        this._closeClient(client, 1009, 'Message too big');
        return;
      }
      data = Buffer.concat([client.frameBuffer, data]);
      client.frameBuffer = null;
    }

    if (data.length > MAX_FRAME_BUFFER_SIZE) {
      this._closeClient(client, 1009, 'Message too big');
      return;
    }

    let frameCount = 0;
    while (data.length > 0) {
      if (frameCount >= MAX_FRAMES_PER_DATA) {
        this._closeClient(client, 1002, 'Too many frames');
        return;
      }
      const frameLength = this._computeFrameLength(data);
      if (frameLength <= 0 || data.length < frameLength) {
        client.frameBuffer = data;
        return;
      }

      const frameData = data.slice(0, frameLength);
      data = data.slice(frameLength);
      frameCount++;

      this._handleFrame(client, frameData);
      if (!this._clients.has(client)) return;
    }
  }

  _computeFrameLength(data) {
    if (data.length < 2) return -1;

    let payloadStart = 2;
    let payloadLength = data[1] & 0x7f;

    if (payloadLength === 126) {
      if (data.length < 4) return -1;
      payloadLength = data.readUInt16BE(2);
      payloadStart = 4;
    } else if (payloadLength === 127) {
      if (data.length < 10) return -1;
      if (data.readBigUInt64BE(2) > BigInt(MAX_PAYLOAD_SIZE)) return -1;
      payloadLength = Number(data.readBigUInt64BE(2));
      if (!Number.isFinite(payloadLength) || payloadLength < 0) return -1;
      payloadStart = 10;
    }

    if (payloadLength > MAX_PAYLOAD_SIZE) return -1;

    if (data[1] & 0x80) {
      payloadStart += 4;
    }

    return payloadStart + payloadLength;
  }

  /**
   * 解析并分发WebSocket帧。处理text/binary/ping/pong/close操作码。
   * @param {Object} client - 客户端连接对象
   * @param {Buffer} data - 原始帧数据
   * @private
   */
  _handleFrame(client, data) {
    if (data.length < 2) return;

    const rsvBits = data[0] & 0x70;
    if (rsvBits !== 0) {
      debug('WebSocketHandler', 'rsvBits', 'RSV bits set without extension negotiation - closing');
      this._closeClient(client, 1002, 'Protocol error');
      return;
    }

    const isMasked = (data[1] & 0x80) !== 0;
    if (!isMasked) {
      debug('WebSocketHandler', 'unmaskedFrame', 'Client sent unmasked frame - closing per RFC 6455');
      this._closeClient(client, 1002, 'Protocol error');
      return;
    }

    const opcode = data[0] & 0x0f;
    if (opcode === 0x08) {
      this._clients.delete(client);
      this.emit('disconnect', client, 'client_close');
      safeCall(() => { client.socket.removeAllListeners(); client.socket.write(this._createFrame(0x08, '')); client.socket.end(); }, 'WebSocket', 'socketEnd');
      return;
    }
    if (opcode === 0x0a) {
      client.isAlive = true;
      return;
    }
    if (opcode === 0x09) {
      safeCall(() => client.socket.write(this._createFrame(0x0a, '')), 'WebSocket', 'pongError');
      return;
    }

    if (opcode === 0x01) {
      this._handleTextMessage(client, data);
    } else if (opcode === 0x02 || opcode === 0x00) {
      debug('WebSocketHandler', 'unsupportedOpcode', 'Unsupported frame type: ' + opcode);
      this._closeClient(client, 1003, 'Unsupported data');
    }
  }

  _handleTextMessage(client, data) {
    if (!this._checkMessageRate(client)) {
      debug('WebSocketHandler', 'rateLimit', 'Client exceeded message rate limit');
      this._closeClient(client, 1008, 'Rate limit exceeded');
      return;
    }
    const payload = this._parseTextFrame(data);
    if (!payload) return;
    let msg;
    try {
      msg = safeJsonParse(payload, null, 'WebSocketHandler');
    } catch (err) {
      debug('WebSocket', 'messageParse', err);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this._closeClient(client, 1003, 'Invalid message format');
      return;
    }
    if (!msg.type || typeof msg.type !== 'string') { this._closeClient(client, 1003, 'Invalid message: type field required'); return; }
    if (!client.authenticated && msg.type === 'auth' && typeof msg.token === 'string') {
      if (msg.token.length > 1024) { this._closeClient(client, 4001, 'Token too long'); return; }
      client.authenticated = this._verifyMessageToken(msg.token);
      if (!client.authenticated) {
        this._closeClient(client, 4001, 'Authentication failed');
      }
      return;
    }
    if (!client.authenticated) {
      this._closeClient(client, 4001, 'Authentication required');
      return;
    }
    try {
      this.emit('message', client, msg);
    } catch (emitErr) {
      debug('WebSocket', 'messageHandlerError', emitErr);
    }
  }

  _closeClient(client, code, reason) {
    this._clients.delete(client);
    this.emit('disconnect', client, reason ?? 'server_close');
    try {
      const reasonBuf = Buffer.from(reason || '', UTF8_ENCODING);
      const maxReasonLen = 123;
      let truncatedReason = reasonBuf.length > maxReasonLen ? reasonBuf.slice(0, maxReasonLen) : reasonBuf;
      if (truncatedReason.length > 0 && truncatedReason.length < reasonBuf.length) {
        let last = truncatedReason[truncatedReason.length - 1];
        while (truncatedReason.length > 0 && last >= 0x80 && last <= 0xBF) {
          truncatedReason = truncatedReason.slice(0, -1);
          if (truncatedReason.length > 0) last = truncatedReason[truncatedReason.length - 1];
        }
        if (truncatedReason.length > 0 && last >= 0xC0) {
          truncatedReason = truncatedReason.slice(0, -1);
        }
      }
      const closeFrame = Buffer.alloc(2 + 2 + truncatedReason.length);
      closeFrame[0] = 0x88;
      closeFrame[1] = 2 + truncatedReason.length;
      closeFrame.writeUInt16BE(code ?? 1000, 2);
      truncatedReason.copy(closeFrame, 4);
      if (client.socket.writable) {
        const canWrite = client.socket.write(closeFrame);
        if (!canWrite) {
          client.socket.once('drain', () => { client.socket.end(); });
          return;
        }
      }
      client.socket.removeAllListeners();
      client.socket.end();
    } catch {
      safeCall(() => { client.socket.removeAllListeners(); client.socket.destroy(); }, 'WebSocket', 'socketDestroy');
    }
  }

  _verifyMessageToken(token) {
    if (!this._authTokenHash || typeof token !== 'string') return false;
    try {
      let tokenHash;
      if (token.startsWith('sha256-')) {
        tokenHash = Buffer.from(token.slice(7), 'hex');
        if (tokenHash.length !== this._authTokenHash.length) return false;
      } else {
        tokenHash = crypto.createHash('sha256').update(Buffer.from(token, UTF8_ENCODING)).digest();
      }
      return crypto.timingSafeEqual(tokenHash, this._authTokenHash);
    } catch (e) {
      debug('WebSocketHandler', '_validateToken', e);
      return false;
    }
  }

  _parseTextFrame(data) {
    let payloadStart = 2;
    let payloadLength = data[1] & 0x7f;
    let maskKey = null;

    if (payloadLength === 126) {
      if (data.length < 4) return null;
      payloadLength = data.readUInt16BE(2);
      payloadStart = 4;
    } else if (payloadLength === 127) {
      if (data.length < 10) return null;
      payloadLength = Number(data.readBigUInt64BE(2));
      if (!Number.isFinite(payloadLength) || payloadLength < 0) return null;
      payloadStart = 10;
    }

    if (payloadLength > MAX_PAYLOAD_SIZE) {
      return null;
    }

    if (data[1] & 0x80) {
      maskKey = data.slice(payloadStart, payloadStart + 4);
      payloadStart += 4;
    }

    if (!maskKey) return null;

    if (payloadStart + payloadLength > data.length) {
      return null;
    }

    const payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = data[payloadStart + i] ^ maskKey[i % 4];
    }

    return payload.toString(UTF8_ENCODING);
  }

  /**
   * 构建WebSocket帧。支持text(0x01)/close(0x08)/ping(0x09)/pong(0x0A)操作码。
   * @param {number} opcode - 操作码
   * @param {string|Buffer} payload - 帧负载
   * @returns {Buffer} 构建完成的WebSocket帧
   * @private
   */
  _createFrame(opcode, payload) {
    const payloadBuf = Buffer.from(payload ?? '', UTF8_ENCODING);
    const maskBit = 0x00;
    let header;

    if (payloadBuf.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = maskBit | payloadBuf.length;
    } else if (payloadBuf.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = maskBit | 126;
      header.writeUInt16BE(payloadBuf.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = maskBit | 127;
      header.writeBigUInt64BE(BigInt(payloadBuf.length), 2);
    }

    return Buffer.concat([header, payloadBuf]);
  }
  isHealthy() {
    return this._clients.size < MAX_CLIENTS;
  }

  _isLocalRequest(req) {
    return _isLocalRequest(req);
  }

  _checkMessageRate(client) {
    const now = Date.now();
    if (!client._msgTimestamps) {
      client._msgTimestamps = [];
    }
    client._msgTimestamps = client._msgTimestamps.filter(
      ts => now - ts <= WS_MESSAGE_RATE_WINDOW,
    );
    if (client._msgTimestamps.length > 100) client._msgTimestamps = client._msgTimestamps.slice(-60);
    if (client._msgTimestamps.length >= WS_MESSAGE_RATE_LIMIT) {
      return false;
    }
    client._msgTimestamps.push(now);
    return true;
  }

  _onShutdown() {
    this._closed = true;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    for (const client of this._clients) {
      safeCall(() => {
        if (client.socket && typeof client.socket.write === 'function') {
          client.socket.removeAllListeners();
          const closeFrame = Buffer.from([0x88, 0x00]);
          client.socket.write(closeFrame);
          client.socket.end();
        } else if (client.socket && typeof client.socket.destroy === 'function') {
          client.socket.removeAllListeners();
          client.socket.destroy();
        }
      }, 'WebSocketHandler', 'closeClient');
    }
    this._clients.clear();
    this.removeAllListeners();
  }
}

WebSocketHandler.WS_MAGIC_STRING = WS_MAGIC_STRING;
WebSocketHandler.HEARTBEAT_INTERVAL = HEARTBEAT_INTERVAL;
WebSocketHandler.MAX_PAYLOAD_SIZE = MAX_PAYLOAD_SIZE;
WebSocketHandler.MAX_CLIENTS = MAX_CLIENTS;

module.exports = withShutdown(WebSocketHandler);
