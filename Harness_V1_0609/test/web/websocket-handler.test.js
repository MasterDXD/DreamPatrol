'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const WebSocketHandler = require('../../src/web/websocket-handler');

function createMockSocket() {
  const written = [];
  const events = {};
  const socket = {
    written,
    write(data) { written.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; },
    end() { socket._ended = true; return socket; },
    destroy() { socket._destroyed = true; return socket; },
    removeAllListeners() { socket._listenersRemoved = true; },
    on(event, handler) { events[event] = handler; return socket; },
    emit(event, ...args) { if (events[event]) events[event](...args); },
    _events: events,
    _ended: false,
    _destroyed: false,
    _listenersRemoved: false,
    remoteAddress: '127.0.0.1',
  };
  return socket;
}

function createLocalReq(headers) {
  return {
    headers: headers ?? {},
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function createRemoteReq(headers) {
  return {
    headers: headers ?? {},
    url: '/',
    socket: { remoteAddress: '203.0.113.1' },
  };
}

function createMaskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ maskKey[i % 4];
  }
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
    maskKey.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    maskKey.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

function createCloseFrame(code) {
  const maskKey = crypto.randomBytes(4);
  const header = Buffer.alloc(8);
  header[0] = 0x88;
  header[1] = 0x82;
  maskKey.copy(header, 2);
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code ?? 1000, 0);
  const masked = Buffer.alloc(2);
  for (let i = 0; i < 2; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header.slice(0, 6), masked]);
}

function createPingFrame() {
  const maskKey = crypto.randomBytes(4);
  const header = Buffer.alloc(6);
  header[0] = 0x89;
  header[1] = 0x80;
  maskKey.copy(header, 2);
  return header;
}

function createPongFrame() {
  const maskKey = crypto.randomBytes(4);
  const header = Buffer.alloc(6);
  header[0] = 0x8A;
  header[1] = 0x80;
  maskKey.copy(header, 2);
  return header;
}

function getWrittenString(socket) {
  return Buffer.concat(socket.written).toString();
}

describe('WebSocketHandler - constructor', () => {
  it('should initialize with default values', () => {
    const handler = new WebSocketHandler();
    assert.strictEqual(handler.clientCount, 0);
    assert.strictEqual(handler._closed, false);
    assert.strictEqual(handler._authTokenHash, null);
    assert.strictEqual(handler._allowedOrigins, null);
    handler.shutdown();
  });

  it('should accept allowedOrigins option', () => {
    const handler = new WebSocketHandler({ allowedOrigins: ['http://localhost:3000'] });
    assert.ok(handler._allowedOrigins);
    assert.ok(handler._allowedOrigins.has('http://localhost:3000'));
    handler.shutdown();
  });

  it('should accept authToken option', () => {
    const handler = new WebSocketHandler({ authToken: 'secret-token' });
    assert.ok(handler._authTokenHash instanceof Buffer);
    handler.shutdown();
  });
});

describe('WebSocketHandler - handleUpgrade', () => {
  it('should reject upgrade when handler is closed', () => {
    const handler = new WebSocketHandler();
    handler.close();
    const socket = createMockSocket();
    const req = createLocalReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(socket._destroyed, true);
    handler.shutdown();
  });

  it('should destroy socket when sec-websocket-key is missing', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({});
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(socket._destroyed, true);
    handler.shutdown();
  });

  it('should destroy socket when sec-websocket-key has wrong length', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({ 'sec-websocket-key': 'short', 'host': 'localhost' });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(socket._destroyed, true);
    handler.shutdown();
  });

  it('should destroy socket when sec-websocket-key is not valid base64 of 16 bytes', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({ 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAAAA', 'host': 'localhost' });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(socket._destroyed, true);
    handler.shutdown();
  });

  it('should complete upgrade with valid key from local request', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    let connected = null;
    handler.on('connection', (client) => { connected = client; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.ok(connected);
    assert.strictEqual(handler.clientCount, 1);
    assert.strictEqual(connected.isAlive, true);
    const response = getWrittenString(socket);
    assert.ok(response.includes('101 Switching Protocols'));
    assert.ok(response.includes('Sec-WebSocket-Accept'));
    handler.shutdown();
  });

  it('should reject non-local request without auth token', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'example.com',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const response = getWrittenString(socket);
    assert.ok(response.includes('401'));
    handler.shutdown();
  });

  it('should reject when max clients reached', () => {
    const handler = new WebSocketHandler();
    for (let i = 0; i < WebSocketHandler.MAX_CLIENTS; i++) {
      const s = createMockSocket();
      const r = createLocalReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'host': 'localhost' });
      handler.handleUpgrade(r, s, Buffer.alloc(0));
    }
    const extraSocket = createMockSocket();
    const extraReq = createLocalReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'host': 'localhost' });
    handler.handleUpgrade(extraReq, extraSocket, Buffer.alloc(0));
    const response = getWrittenString(extraSocket);
    assert.ok(response.includes('429'));
    handler.shutdown();
  });

  it('should reject non-allowed origin', () => {
    const handler = new WebSocketHandler({ allowedOrigins: ['http://allowed.com'] });
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'origin': 'http://evil.com',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const response = getWrittenString(socket);
    assert.ok(response.includes('403'));
    handler.shutdown();
  });

  it('should accept allowed origin', () => {
    const handler = new WebSocketHandler({ allowedOrigins: ['http://allowed.com'] });
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'origin': 'http://allowed.com',
    });
    let connected = false;
    handler.on('connection', () => { connected = true; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(connected, true);
    handler.shutdown();
  });

  it('should reject mismatched origin/host when no allowedOrigins', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'origin': 'http://evil.com',
      'host': 'localhost:3000',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const response = getWrittenString(socket);
    assert.ok(response.includes('403'));
    handler.shutdown();
  });
});

describe('WebSocketHandler - authentication', () => {
  it('should reject upgrade with wrong auth token via Bearer header', () => {
    const handler = new WebSocketHandler({ authToken: 'correct-token' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'authorization': 'Bearer wrong-token',
      'host': 'example.com',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const response = getWrittenString(socket);
    assert.ok(response.includes('401'));
    handler.shutdown();
  });

  it('should accept upgrade with correct auth token via Bearer header', () => {
    const handler = new WebSocketHandler({ authToken: 'correct-token' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'authorization': 'Bearer correct-token',
      'host': 'example.com',
    });
    let connected = false;
    handler.on('connection', () => { connected = true; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(connected, true);
    handler.shutdown();
  });

  it('should reject upgrade with no auth token when required', () => {
    const handler = new WebSocketHandler({ authToken: 'required-token' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'example.com',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const response = getWrittenString(socket);
    assert.ok(response.includes('401'));
    handler.shutdown();
  });

  it('should accept auth token via sec-websocket-protocol', () => {
    const handler = new WebSocketHandler({ authToken: 'my-token' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-protocol': 'bearer-my-token',
      'host': 'example.com',
    });
    let connected = false;
    handler.on('connection', () => { connected = true; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(connected, true);
    handler.shutdown();
  });
});

describe('WebSocketHandler - message handling', () => {
  it('should parse text frame and emit message event', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    let receivedMsg = null;
    handler.on('message', (_client, msg) => { receivedMsg = msg; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const textFrame = createMaskedTextFrame(JSON.stringify({ type: 'test', data: 'hello' }));
    socket.emit('data', textFrame);
    assert.ok(receivedMsg);
    assert.strictEqual(receivedMsg.type, 'test');
    assert.strictEqual(receivedMsg.data, 'hello');
    handler.shutdown();
  });

  it('should handle close frame', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(handler.clientCount, 1);
    const closeFrame = createCloseFrame(1000);
    socket.emit('data', closeFrame);
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });

  it('should respond to ping with pong', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const initialWrites = socket.written.length;
    const pingFrame = createPingFrame();
    socket.emit('data', pingFrame);
    assert.ok(socket.written.length > initialWrites);
    handler.shutdown();
  });

  it('should mark client alive on pong', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    let client = null;
    handler.on('connection', (c) => { client = c; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.ok(client);
    client.isAlive = false;
    const pongFrame = createPongFrame();
    socket.emit('data', pongFrame);
    assert.strictEqual(client.isAlive, true);
    handler.shutdown();
  });

  it('should close client on unmasked frame', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const unmaskedFrame = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6C, 0x6C, 0x6F]);
    socket.emit('data', unmaskedFrame);
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });

  it('should close client on RSV bits set', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const rsvFrame = Buffer.from([0xF1, 0x80, 0x00, 0x00, 0x00, 0x00]);
    socket.emit('data', rsvFrame);
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });

  it('should close client on unsupported opcode', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const maskKey = crypto.randomBytes(4);
    const binaryFrame = Buffer.alloc(6);
    binaryFrame[0] = 0x82;
    binaryFrame[1] = 0x80;
    maskKey.copy(binaryFrame, 2);
    socket.emit('data', binaryFrame);
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });
});

describe('WebSocketHandler - broadcast', () => {
  it('should broadcast message to all alive clients', () => {
    const handler = new WebSocketHandler();
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const socket = createMockSocket();
      const req = createLocalReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'host': 'localhost' });
      handler.handleUpgrade(req, socket, Buffer.alloc(0));
      clients.push(socket);
    }
    handler.broadcast('test-event', { msg: 'hello' });
    for (const socket of clients) {
      assert.ok(socket.written.length >= 2);
    }
    handler.shutdown();
  });

  it('should skip dead clients during broadcast', () => {
    const handler = new WebSocketHandler();
    const aliveSocket = createMockSocket();
    const deadSocket = createMockSocket();
    handler.handleUpgrade(
      createLocalReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'host': 'localhost' }),
      aliveSocket, Buffer.alloc(0),
    );
    handler.handleUpgrade(
      createLocalReq({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'host': 'localhost' }),
      deadSocket, Buffer.alloc(0),
    );
    const clients = Array.from(handler._clients);
    const deadClient = clients.find((c) => c.socket === deadSocket);
    assert.ok(deadClient);
    deadClient.isAlive = false;
    const aliveBefore = aliveSocket.written.length;
    const deadBefore = deadSocket.written.length;
    handler.broadcast('test', {});
    assert.ok(aliveSocket.written.length > aliveBefore);
    assert.strictEqual(deadSocket.written.length, deadBefore);
    handler.shutdown();
  });

  it('should ignore broadcast with invalid event', () => {
    const handler = new WebSocketHandler();
    handler.broadcast('', {});
    handler.broadcast(null, {});
    handler.broadcast(123, {});
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });
});

describe('WebSocketHandler - frame creation', () => {
  it('should create small frame for payload < 126 bytes', () => {
    const handler = new WebSocketHandler();
    const frame = handler._createFrame(0x01, 'hello');
    assert.ok(frame);
    assert.strictEqual(frame[0] & 0x0f, 0x01);
    assert.strictEqual(frame[1] & 0x7f, 5);
    handler.shutdown();
  });

  it('should create medium frame for payload 126-65535 bytes', () => {
    const handler = new WebSocketHandler();
    const payload = 'a'.repeat(200);
    const frame = handler._createFrame(0x01, payload);
    assert.ok(frame);
    assert.strictEqual(frame[0] & 0x0f, 0x01);
    assert.strictEqual(frame[1] & 0x7f, 126);
    handler.shutdown();
  });

  it('should create large frame for payload >= 65536 bytes', () => {
    const handler = new WebSocketHandler();
    const payload = 'b'.repeat(70000);
    const frame = handler._createFrame(0x01, payload);
    assert.ok(frame);
    assert.strictEqual(frame[0] & 0x0f, 0x01);
    assert.strictEqual(frame[1] & 0x7f, 127);
    handler.shutdown();
  });
});

describe('WebSocketHandler - rate limiting', () => {
  it('should allow messages within rate limit', () => {
    const handler = new WebSocketHandler();
    const client = { _msgTimestamps: [] };
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(handler._checkMessageRate(client), true);
    }
    handler.shutdown();
  });

  it('should block messages exceeding rate limit', () => {
    const handler = new WebSocketHandler();
    const client = { _msgTimestamps: [] };
    for (let i = 0; i < 50; i++) {
      handler._checkMessageRate(client);
    }
    assert.strictEqual(handler._checkMessageRate(client), false);
    handler.shutdown();
  });
});

describe('WebSocketHandler - close and shutdown', () => {
  it('close should stop heartbeat and clear clients', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(handler.clientCount, 1);
    handler.close();
    assert.strictEqual(handler.clientCount, 0);
    assert.strictEqual(handler._closed, true);
    assert.strictEqual(handler._heartbeatTimer, null);
  });

  it('shutdown should clear clients and remove listeners', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    handler.shutdown();
    assert.strictEqual(handler.clientCount, 0);
  });

  it('isHealthy should return true when below max clients', () => {
    const handler = new WebSocketHandler();
    assert.strictEqual(handler.isHealthy(), true);
    handler.shutdown();
  });
});

describe('WebSocketHandler - socket events', () => {
  it('should remove client on socket close', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(handler.clientCount, 1);
    socket.emit('close');
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });

  it('should remove client on socket error', () => {
    const handler = new WebSocketHandler();
    const socket = createMockSocket();
    const req = createLocalReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'localhost',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.strictEqual(handler.clientCount, 1);
    socket.emit('error', new Error('test'));
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });
});

describe('WebSocketHandler - computeFrameLength', () => {
  it('should return -1 for data less than 2 bytes', () => {
    const handler = new WebSocketHandler();
    assert.strictEqual(handler._computeFrameLength(Buffer.alloc(1)), -1);
    handler.shutdown();
  });

  it('should compute small masked frame length', () => {
    const handler = new WebSocketHandler();
    const data = Buffer.alloc(11);
    data[0] = 0x81;
    data[1] = 0x85;
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(data, 2);
    const payload = Buffer.alloc(5);
    payload.copy(data, 6);
    const result = handler._computeFrameLength(data);
    assert.strictEqual(result, 11);
    handler.shutdown();
  });

  it('should compute medium frame length (126 payload)', () => {
    const handler = new WebSocketHandler();
    const data = Buffer.alloc(200);
    data[0] = 0x81;
    data[1] = 0xFE;
    data.writeUInt16BE(130, 2);
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(data, 4);
    const result = handler._computeFrameLength(data);
    assert.strictEqual(result, 138);
    handler.shutdown();
  });
});

describe('WebSocketHandler - message auth', () => {
  it('should set authenticated=true for Bearer-authenticated upgrade', () => {
    const handler = new WebSocketHandler({ authToken: 'msg-token' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'authorization': 'Bearer msg-token',
      'host': 'example.com',
    });
    let client = null;
    handler.on('connection', (c) => { client = c; });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    assert.ok(client);
    assert.strictEqual(client.authenticated, true);
    handler.shutdown();
  });

  it('should keep Bearer-authenticated client connected with wrong message auth token', () => {
    const handler = new WebSocketHandler({ authToken: 'correct' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'authorization': 'Bearer correct',
      'host': 'example.com',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const authFrame = createMaskedTextFrame(JSON.stringify({ type: 'auth', token: 'wrong' }));
    socket.emit('data', authFrame);
    assert.strictEqual(handler.clientCount, 1);
    handler.shutdown();
  });

  it('should close unauthenticated client sending non-auth message', () => {
    const handler = new WebSocketHandler({ authToken: 'required' });
    const socket = createMockSocket();
    const req = createRemoteReq({
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'host': 'example.com',
    });
    handler.handleUpgrade(req, socket, Buffer.alloc(0));
    const msgFrame = createMaskedTextFrame(JSON.stringify({ type: 'chat', data: 'hello' }));
    socket.emit('data', msgFrame);
    assert.strictEqual(handler.clientCount, 0);
    handler.shutdown();
  });
});

describe('WebSocketHandler - static constants', () => {
  it('should expose WS_MAGIC_STRING', () => {
    assert.strictEqual(WebSocketHandler.WS_MAGIC_STRING, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  });

  it('should expose MAX_PAYLOAD_SIZE', () => {
    assert.strictEqual(WebSocketHandler.MAX_PAYLOAD_SIZE, 1024 * 1024);
  });

  it('should expose MAX_CLIENTS', () => {
    assert.strictEqual(WebSocketHandler.MAX_CLIENTS, 50);
  });

  it('should expose HEARTBEAT_INTERVAL', () => {
    assert.ok(WebSocketHandler.HEARTBEAT_INTERVAL > 0);
  });
});
