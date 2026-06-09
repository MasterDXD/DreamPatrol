'use strict';

const { EventEmitter } = require('events');
const http = require('http');
const crypto = require('crypto');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall, emitError } = require('../../utils/safe-execute');
const { safeJsonParse } = require('../../utils/safe-parse');
const debug = require('../../utils/debug-logger')('CDPClient');
const { DeepeningError, ERROR_CODES } = require('../../errors');

const CDP_DEFAULT_PORT = 9222;
const CDP_DEFAULT_HOST = '127.0.0.1';
const CDP_CONNECT_TIMEOUT = 5000;
const CDP_COMMAND_TIMEOUT = 30000;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
const RING_BUFFER_SIZE = 1000;
const MAX_PENDING_REQUESTS = 1000;
const MAX_EVENT_HANDLERS = 500;

function _makeWsKey() {
  return crypto.randomBytes(16).toString('base64');
}

function _maskFrame(payload) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return { mask, masked };
}

function _encodeWsFrame(opcode, payload) {
  const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const maskBit = 0x80;
  const { mask, masked } = _maskFrame(payloadBuf);
  let header;
  if (payloadBuf.length < 126) {
    header = Buffer.alloc(6);
    header[0] = opcode | maskBit;
    header[1] = payloadBuf.length | 0x80;
    mask.copy(header, 2);
  } else if (payloadBuf.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = opcode | maskBit;
    header[1] = 126 | 0x80;
    header.writeUInt16BE(payloadBuf.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = opcode | maskBit;
    header[1] = 127 | 0x80;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payloadBuf.length, 6);
    mask.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

function _parseWsFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 2 > buf.length) break;
    const firstByte = buf[offset];
    const secondByte = buf[offset + 1];
    const opcode = firstByte & 0x0f;
    const isFin = (firstByte & 0x80) !== 0;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      const hi = buf.readUInt32BE(offset + 2);
      const lo = buf.readUInt32BE(offset + 6);
      if (hi > 0) {
        const err = new Error('CDP frame too large: hi=' + hi);
        debug('CDPClient', 'frame-too-large', err.message);
        break;
      }
      payloadLen = lo;
      headerLen = 10;
    }
    let maskOffset = offset + headerLen;
    let mask = null;
    if (isMasked) {
      if (maskOffset + 4 > buf.length) break;
      mask = buf.slice(maskOffset, maskOffset + 4);
      maskOffset += 4;
    }
    if (maskOffset + payloadLen > buf.length) break;
    const payload = buf.slice(maskOffset, maskOffset + payloadLen);
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i] ^ mask[i % 4];
      }
    }
    frames.push({ opcode, isFin, payload });
    offset = maskOffset + payloadLen;
  }
  return { frames, remaining: offset < buf.length ? buf.slice(offset) : Buffer.alloc(0) };
}

/**
 * @classdesc 环形缓冲区，实现固定大小的循环缓冲区，用于CDP消息的缓存管理
 */
class RingBuffer {
  /**
   * @param {number} size - 缓冲区大小
   */
  constructor(size) {
    this._size = size;
    this._items = [];
  }
  /**
   * @param {*} item - 要添加的元素
   */
  push(item) {
    if (this._items.length >= this._size) this._items.shift();
    this._items.push(item);
  }
  /**
   * @returns {Array} 缓冲区内容的数组副本
   */
  toArray() {
    return this._items.slice();
  }
  /** 清空缓冲区 */
  clear() {
    this._items = [];
  }
  get length() {
    return this._items.length;
  }
}

/**
 * @module runtime/infrastructure/cdp-client
 * CDPClient — Chrome DevTools Protocol轻量级客户端
 * 通过原始WebSocket连接控制Chrome浏览器，支持页面导航、DOM操作、截图、输入模拟等。
 * 基于Node.js原生http模块实现WebSocket握手和帧处理，无外部依赖。
 * @classdesc CDP客户端。Chrome DevTools Protocol客户端，WebSocket直连CDP端点
 * @extends EventEmitter
 */
class CDPClient extends EventEmitter {
  /**
   * 创建 CDPClient 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.host] - Chrome CDP主机地址
   * @param {number} [options.port] - Chrome CDP端口号
   * @param {number} [options.connectTimeout] - 连接超时时间（毫秒）
   * @param {number} [options.commandTimeout] - 命令超时时间（毫秒）
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._host = opts.host ?? CDP_DEFAULT_HOST;
    this._port = opts.port ?? CDP_DEFAULT_PORT;
    this._connectTimeout = opts.connectTimeout ?? CDP_CONNECT_TIMEOUT;
    this._commandTimeout = opts.commandTimeout ?? CDP_COMMAND_TIMEOUT;
    this._maxEventListeners = opts.maxEventListeners ?? 100;
    this.setMaxListeners(this._maxEventListeners);
    this._ws = null;
    this._msgId = 1;
    this._pending = new Map();
    this._eventHandlers = new Map();
    this._connected = false;
    this._targetInfo = null;
    this._buffer = new RingBuffer(RING_BUFFER_SIZE);
    this._recvBuf = Buffer.alloc(0);
    this._maxPendingRequests = MAX_PENDING_REQUESTS;
    this._maxEventHandlers = MAX_EVENT_HANDLERS;
  }

  /**
   * 连接到Chrome DevTools Protocol端点。自动发现第一个可用页面目标并建立WebSocket连接。
   * @returns {Promise<void>}
   * @throws {DeepeningError} 连接超时或WebSocket握手失败时抛出
   */
  async connect() {
    this.guardShutdown();
    if (this._connected) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _doConnect() {
    const targetInfo = await this._discoverTarget();
    if (this._shutDown) throw new DeepeningError(ERROR_CODES.SHUTDOWN, 'CDPClient shutting down during connect');
    this._targetInfo = targetInfo;
    await this._handshake(targetInfo.webSocketDebuggerUrl);
    if (this._shutDown) throw new DeepeningError(ERROR_CODES.SHUTDOWN, 'CDPClient shutting down during connect');
    this._connected = true;
    this.emit('connected', { targetInfo });
  }

  _discoverTarget() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = http.get({
        hostname: this._host,
        port: this._port,
        path: '/json/version',
        timeout: this._connectTimeout,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = safeJsonParse(data);
            if (!parsed || !parsed.webSocketDebuggerUrl) {
              if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'No webSocketDebuggerUrl in /json/version response')); }
              return;
            }
            if (!settled) { settled = true; resolve(parsed); }
          } catch (e) {
            if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'Invalid JSON from /json/version: ' + (e && e.message ? e.message : String(e)))); }
          }
        });
      });
      req.on('error', (err) => {
        req.destroy();
        if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'CDP discovery failed: ' + (err && err.message ? err.message : String(err)))); }
      });
      req.on('timeout', () => {
        req.destroy();
        if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.TIMEOUT, 'CDP discovery timeout after ' + this._connectTimeout + 'ms')); }
      });
    });
  }

  _handshake(wsUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let parsed;
      try {
        parsed = new URL(wsUrl);
      } catch (e) {
        settled = true;
        return reject(new DeepeningError(ERROR_CODES.INVALID_INPUT, 'Invalid WebSocket URL: ' + (e && e.message ? e.message : String(e))));
      }
      const wsKey = _makeWsKey();
      const acceptKey = crypto.createHash('sha1').update(wsKey + WS_MAGIC).digest('base64');
      const req = http.request({
        hostname: parsed.hostname || this._host,
        port: parsed.port || this._port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': wsKey,
          'Sec-WebSocket-Version': '13',
        },
      });
      req.setTimeout(this._connectTimeout, () => {
        req.destroy();
        if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.TIMEOUT, 'WebSocket handshake timeout after ' + this._connectTimeout + 'ms')); }
      });
      req.on('upgrade', (res, socket) => {
        const serverKey = res.headers['sec-websocket-accept'];
        if (serverKey !== acceptKey) {
          socket.destroy();
          if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.SECURITY_VIOLATION, 'WebSocket accept key mismatch')); }
          return;
        }
        this._ws = socket;
        this._setupSocket();
        if (!settled) { settled = true; resolve(); }
      });
      req.on('error', (err) => {
        req.destroy();
        if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'WebSocket handshake failed: ' + (err && err.message ? err.message : String(err)))); }
      });
      req.on('response', function(res) {
        res.resume();
        req.destroy();
        if (!settled) { settled = true; reject(new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'CDP_HANDSHAKE_FAILED: Server returned HTTP ' + res.statusCode + ' instead of upgrade')); }
      });
      req.end();
    });
  }

  _setupSocket() {
    this._ws.on('data', (chunk) => {
      this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
      if (this._recvBuf.length > MAX_BUFFER_SIZE) {
        this._recvBuf = this._recvBuf.slice(this._recvBuf.length - MAX_BUFFER_SIZE);
      }
      const { frames, remaining } = _parseWsFrames(this._recvBuf);
      this._recvBuf = remaining;
      for (const frame of frames) {
        this._handleFrame(frame);
      }
    });
    this._ws.on('close', () => {
      this._handleDisconnect();
    });
    this._ws.on('error', (err) => {
      debug('ws-error', err);
      emitError(this, 'error', err);
    });
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case 0x1: {
        safeExecute(() => {
          const msg = frame.payload.toString('utf8');
          const parsed = safeJsonParse(msg);
          if (parsed) this._handleMessage(parsed);
        }, 'CDPClient', 'handleTextFrame');
        break;
      }
      case 0x8: {
        this._handleDisconnect();
        break;
      }
      case 0x9: {
        this._sendPong(frame.payload);
        break;
      }
      case 0xA:
        break;
      default:
        break;
    }
  }

  _handleMessage(msg) {
    if (msg.id != null) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        if (msg.error) {
          const errMsg = (typeof msg.error === 'object' && msg.error.message)
            ? msg.error.message
            : String(msg.error && msg.error.message ? msg.error.message : msg.error);
          pending.reject(new DeepeningError(ERROR_CODES.CDP_ERROR || 'CDP_ERROR', errMsg));
        } else {
          pending.resolve(msg.result ?? {});
        }
      }
    } else if (msg.method) {
      this._buffer.push({ method: msg.method, params: msg.params });
      this.emit('event', { method: msg.method, params: msg.params });
      const handlers = this._eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          safeCall(() => handler(msg.params), 'CDPClient', 'eventHandler:' + msg.method);
        }
      }
    }
  }

  _handleDisconnect() {
    if (!this._connected && !this._ws) return;
    this._connected = false;
    const oldWs = this._ws;
    this._ws = null;
    if (oldWs && !oldWs.destroyed) {
      oldWs.removeAllListeners();
      oldWs.destroy();
    }
    this._recvBuf = Buffer.alloc(0);
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      safeCall(() => pending.reject(new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'WebSocket closed')), 'CDPClient', 'rejectOnDisconnect');
    }
    this._pending.clear();
    this.emit('disconnected');
  }

  _sendPong(payload) {
    if (!this._ws || this._ws.destroyed) return;
    safeCall(() => {
      const frame = _encodeWsFrame(0xA, payload);
      this._ws.write(frame);
    }, 'CDPClient', 'sendPong');
  }

  _sendRaw(data) {
    if (!this._ws || this._ws.destroyed) {
      throw new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'WebSocket not connected');
    }
    const frame = _encodeWsFrame(0x1, data);
    this._ws.write(frame);
  }

  /**
   * 发送CDP命令并等待响应。
   * @param {string} method - CDP方法名（如'Page.navigate'）
   * @param {Object} [params] - 命令参数
   * @returns {Promise<Object>} CDP响应结果对象
   * @throws {DeepeningError} 命令超时或连接断开时抛出
   */
  async send(method, params) {
    this.guardShutdown();
    if (!this._connected) {
      throw new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'Not connected to CDP');
    }
    if (this._pending.size >= this._maxPendingRequests) {
      const oldestKey = this._pending.keys().next().value;
      const oldest = this._pending.get(oldestKey);
      if (oldest) {
        clearTimeout(oldest.timer);
        safeCall(() => oldest.reject(new DeepeningError(ERROR_CODES.CAPACITY_EXCEEDED, 'Evicted: pending requests limit reached')), 'CDPClient', 'send:evict');
      }
      this._pending.delete(oldestKey);
    }
    const id = this._msgId++;
    const msg = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._shutDown) return;
        this._pending.delete(id);
        this.emit('command-timeout', { id, method });
        reject(new DeepeningError(ERROR_CODES.TIMEOUT, 'CDP command timeout: ' + method + ' (' + this._commandTimeout + 'ms)'));
      }, this._commandTimeout);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._sendRaw(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * 注册CDP事件处理器。当处理器数量超过上限时自动淘汰最早的处理器。
   * @param {string} eventName - CDP事件名称（如'Page.loadEventFired'）
   * @param {Function} handler - 事件回调函数
   * @returns {CDPClient} this（支持链式调用）
   * @throws {DeepeningError} eventName或handler无效时抛出
   */
  onEvent(eventName, handler) {
    this.guardShutdown();
    if (!eventName || typeof eventName !== 'string') {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'eventName must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'handler must be a function');
    }
    let handlers = this._eventHandlers.get(eventName);
    if (!handlers) {
      handlers = new Set();
      this._eventHandlers.set(eventName, handlers);
    }
    if (handlers.size >= this._maxEventHandlers) {
      const first = handlers.values().next().value;
      handlers.delete(first);
    }
    handlers.add(handler);
    return this;
  }

  /**
   * 移除已注册的CDP事件处理器，防止监听器累积导致内存泄漏。
   * @param {string} eventName - CDP事件名称（如'Page.loadEventFired'）
   * @param {Function} handler - 之前通过onEvent注册的回调函数
   * @returns {boolean} 是否成功移除（处理器存在时返回true）
   */
  offEvent(eventName, handler) {
    if (!eventName || typeof eventName !== 'string') return false;
    if (!handler || typeof handler !== 'function') return false;
    const handlers = this._eventHandlers.get(eventName);
    if (!handlers) return false;
    return handlers.delete(handler);
  }

  /**
   * 导航到指定URL。
   * @param {string} url - 目标URL
   * @returns {Promise<Object>} Page.navigate响应
   */
  async navigate(url) {
    this.guardShutdown();
    return this.send('Page.navigate', { url });
  }

  /**
   * 在页面中执行JavaScript表达式。通过CDP Runtime.evaluate命令执行，
   * 结果以值形式返回。
   * @param {string} expression - 要执行的JavaScript表达式
   * @returns {Promise<Object>} CDP Runtime.evaluate响应结果
   */
  async evaluate(expression) {
    this.guardShutdown();
    return this.send('Runtime.evaluate', { expression, returnByValue: true });
  }

  /**
   * 截取当前页面截图。
   * @returns {Promise<string>} Base64编码的PNG截图数据
   */
  async screenshot() {
    this.guardShutdown();
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!result || !result.data) {
      throw new Error('CDPClient: screenshot failed - no data returned (page may not be loaded)');
    }
    return result.data;
  }

  /**
   * 点击指定坐标。通过CDP Input.dispatchMouseEvent依次发送鼠标按下和释放事件。
   * @param {number} x - 点击的X坐标
   * @param {number} y - 点击的Y坐标
   * @returns {Promise<Object>} 鼠标释放事件的CDP响应
   */
  async click(x, y) {
    this.guardShutdown();
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    return this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * 输入文本。通过CDP Input.insertText命令向当前焦点元素插入文本。
   * @param {string} text - 要输入的文本内容
   * @returns {Promise<Object>} CDP Input.insertText响应结果
   */
  async type(text) {
    this.guardShutdown();
    return this.send('Input.insertText', { text });
  }

  /**
   * 获取页面DOM。通过CDP DOM.getDocument获取完整文档结构，
   * 并对根节点调用DOM.describeNode获取详细信息。
   * @returns {Promise<{document: Object, node?: Object}>} 包含文档结构和节点详情的对象
   */
  async getDOM() {
    this.guardShutdown();
    const doc = await this.send('DOM.getDocument', { depth: -1 });
    if (doc.root && doc.root.nodeId) {
      const node = await this.send('DOM.describeNode', { nodeId: doc.root.nodeId, depth: -1 });
      return { document: doc, node };
    }
    return { document: doc };
  }

  isConnected() {
    return this._connected;
  }

  isHealthy() {
    return !this._shutDown && this._connected;
  }

  _onShutdown() {
    if (this._ws && !this._ws.destroyed) {
      safeCall(() => this._ws.removeAllListeners(), 'CDPClient', 'shutdown:removeListeners');
      safeCall(() => {
        const closeFrame = _encodeWsFrame(0x8, Buffer.alloc(0));
        this._ws.write(closeFrame);
      }, 'CDPClient', 'shutdown:sendClose');
      safeCall(() => this._ws.destroy(), 'CDPClient', 'shutdown:destroy');
    }
    this._ws = null;
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      safeCall(() => pending.reject(new DeepeningError(ERROR_CODES.SHUTDOWN, 'CDPClient shutting down')), 'CDPClient', 'shutdown:reject');
    }
    this._pending.clear();
    this._eventHandlers.clear();
    this._buffer.clear();
    this._connected = false;
    this._targetInfo = null;
    this._recvBuf = Buffer.alloc(0);
    this.removeAllListeners();
  }
}

module.exports = withShutdown(CDPClient);
Object.assign(module.exports, {
  CDP_DEFAULT_PORT,
  CDP_DEFAULT_HOST,
  CDP_CONNECT_TIMEOUT,
  CDP_COMMAND_TIMEOUT,
});
