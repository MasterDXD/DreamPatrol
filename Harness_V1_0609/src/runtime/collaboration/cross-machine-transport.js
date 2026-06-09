'use strict';

const { mergeConfig, validateConfigSchema } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const EventEmitter = require('events');
const http = require('http');
const crypto = require('crypto');

const TRANSPORT_ROLES = {
  COORDINATOR: 'coordinator',
  WORKER: 'worker',
  PEER: 'peer',
};

const MESSAGE_TYPES = {
  TASK_ASSIGN: 'task-assign',
  TASK_RESULT: 'task-result',
  HEARTBEAT: 'heartbeat',
  RESOURCE_REPORT: 'resource-report',
  AGENT_REGISTER: 'agent-register',
  AGENT_DEREGISTER: 'agent-deregister',
  STATE_SYNC: 'state-sync',
  BROADCAST: 'broadcast',
  DIRECT: 'direct',
};

const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
};

const DEFAULT_OPTIONS = {
  port: 9876,
  host: '0.0.0.0',
  role: TRANSPORT_ROLES.PEER,
  heartbeatIntervalMs: 5000,
  heartbeatTimeoutMs: 15000,
  reconnectIntervalMs: 3000,
  maxReconnectAttempts: 10,
  maxPeers: 50,
  maxMessageHistory: 200,
  maxPendingMessages: 500,
  coordinatorUrl: null,
  agentId: null,
  secretKey: null,
};

const OPTIONS_SCHEMA = {
  port: { type: 'number', min: 1, max: 65535 },
  host: { type: 'string' },
  role: { type: 'string', enum: ['coordinator', 'worker', 'peer'] },
  heartbeatIntervalMs: { type: 'number', min: 100 },
  heartbeatTimeoutMs: { type: 'number', min: 100 },
  reconnectIntervalMs: { type: 'number', min: 100 },
  maxReconnectAttempts: { type: 'number', min: 0, max: 100 },
  maxPeers: { type: 'number', min: 1, max: 1000 },
  maxMessageHistory: { type: 'number', min: 1, max: 10000 },
  maxPendingMessages: { type: 'number', min: 1, max: 10000 },
};

class CrossMachineTransport extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    const validation = validateConfigSchema(this._options, OPTIONS_SCHEMA, 'CrossMachineTransport');
    this._options = validation.config;
    this._agentId = this._options.agentId ?? 'agent-' + crypto.randomUUID().substring(0, 8);
    this._role = this._options.role;
    this._connectionState = CONNECTION_STATES.DISCONNECTED;
    this._peers = new BoundedMap(this._options.maxPeers);
    this._messageHistory = new BoundedArray(this._options.maxMessageHistory);
    this._pendingMessages = new BoundedMap(this._options.maxPendingMessages);
    this._server = null;
    this._sockets = new Map();
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._coordinatorSocket = null;
    this._stats = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      peersConnected: 0,
      peersDisconnected: 0,
      heartbeatsSent: 0,
      heartbeatsReceived: 0,
      reconnections: 0,
      byMessageType: {},
    };
  }

  get agentId() { return this._agentId; }
  get role() { return this._role; }
  get connectionState() { return this._connectionState; }

  async start() {
    if (this._connectionState !== CONNECTION_STATES.DISCONNECTED) {
      return { success: false, error: 'Transport already started' };
    }
    this._connectionState = CONNECTION_STATES.CONNECTING;
    if (this._role === TRANSPORT_ROLES.COORDINATOR) {
      await this._startServer();
    }
    if (this._options.coordinatorUrl && this._role !== TRANSPORT_ROLES.COORDINATOR) {
      await this._connectToCoordinator();
    }
    this._startHeartbeat();
    this._connectionState = CONNECTION_STATES.CONNECTED;
    this.emit('transport-started', { agentId: this._agentId, role: this._role });
    return { success: true, agentId: this._agentId };
  }

  async _startServer() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentId: this._agentId, role: this._role, status: 'ok' }));
      });
      this._server.on('upgrade', (req, socket, head) => {
        this._handleUpgrade(req, socket, head);
      });
      this._server.on('error', reject);
      this._server.listen(this._options.port, this._options.host, () => {
        resolve();
      });
    });
  }

  _handleUpgrade(req, socket, _head) {
    const agentId = req.headers['x-agent-id'] ?? 'unknown';
    const signature = req.headers['x-signature'] ?? '';
    if (this._options.secretKey && !this._verifySignature(agentId, signature)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this._completeHandshake(socket, agentId);
  }

  _completeHandshake(socket, agentId) {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n\r\n');
    this._registerPeer(agentId, socket);
    socket.on('data', (data) => {
      this._handleIncomingData(agentId, data);
    });
    socket.on('close', () => {
      this._unregisterPeer(agentId);
    });
    socket.on('error', () => {
      this._unregisterPeer(agentId);
    });
  }

  _registerPeer(agentId, socket) {
    // Socket数量限制：超过100时淘汰最旧的连接
    if (this._sockets.size >= 100) {
      const oldestKey = this._sockets.keys().next().value;
      const oldSocket = this._sockets.get(oldestKey);
      try { oldSocket.destroy(); } catch (_) { debug('CrossMachineTransport', '_registerPeer:destroyOldSocket', _ && _.message ? _.message : String(_)); }
      this._sockets.delete(oldestKey);
    }
    this._peers.set(agentId, {
      agentId,
      socket,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      state: CONNECTION_STATES.CONNECTED,
    });
    this._sockets.set(socket, agentId);
    this._stats.peersConnected++;
    this.emit('peer-connected', { agentId });
  }

  _unregisterPeer(agentId) {
    const peer = this._peers.get(agentId);
    if (peer) {
      this._sockets.delete(peer.socket);
      this._peers.delete(agentId);
      this._stats.peersDisconnected++;
      this.emit('peer-disconnected', { agentId });
    }
  }

  async _connectToCoordinator() {
    const url = this._options.coordinatorUrl;
    if (!url) return;
    this._connectionState = CONNECTION_STATES.CONNECTING;
    try {
      const socket = await this._createClientSocket(url);
      this._coordinatorSocket = socket;
      this._connectionState = CONNECTION_STATES.CONNECTED;
      this._reconnectAttempts = 0;
      this.emit('coordinator-connected', { url });
    } catch (_e) {
      this._scheduleReconnect();
    }
  }

  _createClientSocket(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port ?? this._options.port,
        path: parsed.pathname ?? '/',
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'X-Agent-Id': this._agentId,
          'X-Signature': this._signMessage(this._agentId),
        },
      };
      const req = http.request(options);
      req.on('upgrade', (res, socket, _head) => {
        this._registerPeer('coordinator', socket);
        socket.on('data', (data) => {
          this._handleIncomingData('coordinator', data);
        });
        socket.on('close', () => {
          this._unregisterPeer('coordinator');
          this._scheduleReconnect();
        });
        socket.on('error', (err) => {
          debug('CrossMachineTransport', 'socket error', err && err.message ? err.message : String(err));
          this._unregisterPeer('coordinator');
          this._scheduleReconnect();
        });
        resolve(socket);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Connection timeout'));
      });
      req.end();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._options.maxReconnectAttempts) {
      this._connectionState = CONNECTION_STATES.DISCONNECTED;
      this.emit('reconnect-failed', { attempts: this._reconnectAttempts });
      return;
    }
    this._connectionState = CONNECTION_STATES.RECONNECTING;
    this._reconnectAttempts++;
    this._stats.reconnections++;
    this._reconnectTimer = setTimeout(() => {
      if (this._shutDown) return;
      this._connectToCoordinator();
    }, this._options.reconnectIntervalMs);
  }

  send(targetAgentId, messageType, payload) {
    const message = this._createMessage(messageType, payload, targetAgentId);
    if (targetAgentId === '*' || targetAgentId === 'broadcast') {
      return this._broadcast(message);
    }
    const peer = this._peers.get(targetAgentId);
    if (!peer) {
      this._pendingMessages.set(targetAgentId + '-' + Date.now(), message);
      return { success: false, error: 'Peer not found: ' + targetAgentId };
    }
    return this._sendToPeer(peer, message);
  }

  broadcast(messageType, payload) {
    const message = this._createMessage(messageType, payload, '*');
    return this._broadcast(message);
  }

  _broadcast(message) {
    let sent = 0;
    for (const [, peer] of this._peers) {
      const result = this._sendToPeer(peer, message);
      if (result.success) sent++;
    }
    return { success: true, recipients: sent };
  }

  _sendToPeer(peer, message) {
    try {
      const data = this._serialize(message);
      peer.socket.write(data);
      this._stats.messagesSent++;
      this._stats.bytesSent += data.length;
      this._stats.byMessageType[message.type] = (this._stats.byMessageType[message.type] ?? 0) + 1;
      this._messageHistory.push({ direction: 'out', message, timestamp: Date.now() });
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _handleIncomingData(fromAgentId, data) {
    const message = safeExecute(() => this._deserialize(data));
    if (!message) return;
    this._stats.messagesReceived++;
    this._stats.bytesReceived += data.length;
    this._messageHistory.push({ direction: 'in', from: fromAgentId, message, timestamp: Date.now() });
    if (message.type === MESSAGE_TYPES.HEARTBEAT) {
      this._handleHeartbeat(fromAgentId, message);
      return;
    }
    this.emit('message', { from: fromAgentId, message });
    this.emit('message:' + message.type, { from: fromAgentId, message });
  }

  _handleHeartbeat(fromAgentId, message) {
    const peer = this._peers.get(fromAgentId);
    if (peer) {
      peer.lastHeartbeat = Date.now();
      this._stats.heartbeatsReceived++;
    }
    if (message.payload && message.payload.requestReply) {
      const reply = this._createMessage(MESSAGE_TYPES.HEARTBEAT, { requestReply: false });
      const peerEntry = this._peers.get(fromAgentId);
      if (peerEntry) this._sendToPeer(peerEntry, reply);
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this._shutDown) return;
      const heartbeat = this._createMessage(MESSAGE_TYPES.HEARTBEAT, {
        role: this._role,
        requestReply: true,
      });
      this._stats.heartbeatsSent++;
      this._broadcast(heartbeat);
      this._checkPeerLiveness();
    }, this._options.heartbeatIntervalMs);
  }

  _checkPeerLiveness() {
    const now = Date.now();
    for (const [agentId, peer] of this._peers) {
      if (now - peer.lastHeartbeat > this._options.heartbeatTimeoutMs) {
        this._unregisterPeer(agentId);
        this.emit('peer-timeout', { agentId });
      }
    }
  }

  _createMessage(type, payload, target) {
    return {
      id: crypto.randomUUID(),
      source: this._agentId,
      target: target ?? '*',
      type,
      payload: payload ?? {},
      timestamp: Date.now(),
    };
  }

  _serialize(message) {
    return JSON.stringify(message) + '\n';
  }

  _deserialize(data) {
    const str = typeof data === 'string' ? data : data.toString('utf-8');
    const lines = str.split('\n').filter(l => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      return JSON.parse(last);
    } catch (err) {
      debug('CrossMachineTransport', 'deserialize', err && err.message ? err.message : String(err));
      return null;
    }
  }

  _signMessage(data) {
    if (!this._options.secretKey) return '';
    return crypto.createHmac('sha256', this._options.secretKey).update(data).digest('hex');
  }

  _verifySignature(data, signature) {
    const expected = this._signMessage(data);
    if (!signature || signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  getPeers() {
    const result = [];
    for (const [agentId, peer] of this._peers) {
      result.push({
        agentId,
        connectedAt: peer.connectedAt,
        lastHeartbeat: peer.lastHeartbeat,
        state: peer.state,
      });
    }
    return result;
  }

  getStats() {
    return {
      agentId: this._agentId,
      role: this._role,
      connectionState: this._connectionState,
      messagesSent: this._stats.messagesSent,
      messagesReceived: this._stats.messagesReceived,
      bytesSent: this._stats.bytesSent,
      bytesReceived: this._stats.bytesReceived,
      peersConnected: this._stats.peersConnected,
      peersDisconnected: this._stats.peersDisconnected,
      heartbeatsSent: this._stats.heartbeatsSent,
      heartbeatsReceived: this._stats.heartbeatsReceived,
      reconnections: this._stats.reconnections,
      activePeers: this._peers.size,
      byMessageType: Object.assign({}, this._stats.byMessageType),
    };
  }

  _onShutdown() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const [, peer] of this._peers) {
      safeExecute(() => peer.socket.destroy());
    }
    this._peers.shutdown();
    this._messageHistory.shutdown();
    this._pendingMessages.shutdown();
    this._sockets.clear();
    if (this._coordinatorSocket) {
      safeExecute(() => this._coordinatorSocket.destroy());
      this._coordinatorSocket = null;
    }
    if (this._server) {
      this._server.close();
      this._server = null;
    }
    this._connectionState = CONNECTION_STATES.DISCONNECTED;
  }
}

module.exports = withShutdown(CrossMachineTransport);
module.exports.TRANSPORT_ROLES = TRANSPORT_ROLES;
module.exports.MESSAGE_TYPES = MESSAGE_TYPES;
module.exports.CONNECTION_STATES = CONNECTION_STATES;
