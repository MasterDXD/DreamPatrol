/**
 * @module mcp-auto-discovery
 * @description MCP服务器自动发现器 — 融合Claude Code扩展功能的MCP自动发现机制。
 * 自动扫描常见位置（node_modules、全局安装、配置目录）以发现可用的MCP服务器，
 * 填补Harness框架在MCP服务器自动发现方面的空白。
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const debug = require('../../utils/debug-logger')('McpAutoDiscovery');
const path = require('path');
const fs = require('fs');

const DISCOVERY_SOURCES = {
  NODE_MODULES: 'node_modules',
  GLOBAL_NPM: 'global_npm',
  CONFIG_DIR: 'config_dir',
  MANIFEST: 'manifest',
};

const SERVER_STATUS = {
  DISCOVERED: 'discovered',
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
};

const DEFAULT_CONFIG = {
  projectRoot: process.cwd(),
  scanNodeModules: true,
  scanGlobalNpm: false,
  scanConfigDir: true,
  maxDiscovered: 100,
  discoveryTimeoutMs: 5000,
  mcpServerPattern: /^(@[\w-]+\/)?mcp-server-[\w-]+$/,
  mcpToolPattern: /^(@[\w-]+\/)?mcp-[\w-]+$/,
};

class McpAutoDiscovery extends EventEmitter {
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._discovered = new Map();  // serverName -> discovery info
    this._scanning = false;
    this._lastScanAt = null;
    this._stats = {
      totalScans: 0,
      totalDiscovered: 0,
      bySource: {},
    };
    for (const source of Object.values(DISCOVERY_SOURCES)) {
      this._stats.bySource[source] = 0;
    }
  }

  // Run full discovery scan
  discover() {
    this.guardShutdown();
    if (this._scanning) return this._getDiscoveredList();
    this._scanning = true;
    this._stats.totalScans++;
    const results = [];

    if (this._config.scanNodeModules) {
      safeCall(() => {
        const found = this._scanNodeModules();
        results.push(...found);
      }, 'McpAutoDiscovery', 'scan-node-modules');
    }

    if (this._config.scanConfigDir) {
      safeCall(() => {
        const found = this._scanConfigDir();
        results.push(...found);
      }, 'McpAutoDiscovery', 'scan-config-dir');
    }

    if (this._config.scanGlobalNpm) {
      safeCall(() => {
        const found = this._scanGlobalNpm();
        results.push(...found);
      }, 'McpAutoDiscovery', 'scan-global-npm');
    }

    this._lastScanAt = new Date().toISOString();
    this._scanning = false;
    this.emit('discovery-complete', { totalDiscovered: this._discovered.size, scanCount: results.length });
    return this._getDiscoveredList();
  }

  _scanNodeModules() {
    const nmPath = path.join(this._config.projectRoot, 'node_modules');
    const found = [];
    if (!fs.existsSync(nmPath)) return found;
    const entries = fs.readdirSync(nmPath, { withFileTypes: true });
    for (const entry of entries) {
      if (this._discovered.size >= this._config.maxDiscovered) break;
      const name = entry.name;
      const pkgPath = path.join(nmPath, name);
      // Handle scoped packages
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        try {
          const scoped = fs.readdirSync(pkgPath, { withFileTypes: true });
          for (const se of scoped) {
            if (this._discovered.size >= this._config.maxDiscovered) break;
            const scopedName = name + '/' + se.name;
            if (this._mcpPatternMatch(scopedName)) {
              this._registerDiscovery(scopedName, path.join(pkgPath, se.name), DISCOVERY_SOURCES.NODE_MODULES);
              found.push(scopedName);
            }
          }
        } catch (_e) { debug('skip-unreadable-scoped-dirs', _e && _e.message ? _e.message : String(_e)); }
        continue;
      }
      if (this._mcpPatternMatch(name)) {
        this._registerDiscovery(name, pkgPath, DISCOVERY_SOURCES.NODE_MODULES);
        found.push(name);
      }
    }
    return found;
  }

  _scanConfigDir() {
    const configPath = path.join(this._config.projectRoot, '.harness', 'config.json');
    const found = [];
    safeCall(() => {
      if (!fs.existsSync(configPath)) return;
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content);
      if (config.mcp_servers && typeof config.mcp_servers === 'object') {
        for (const [serverName, serverConfig] of Object.entries(config.mcp_servers)) {
          if (this._discovered.size >= this._config.maxDiscovered) break;
          this._registerDiscovery(serverName, null, DISCOVERY_SOURCES.CONFIG_DIR, serverConfig);
          found.push(serverName);
        }
      }
    }, 'McpAutoDiscovery', 'scan-config-dir');
    return found;
  }

  _scanGlobalNpm() {
    const found = [];
    safeCall(() => {
      const globalPath = this._getGlobalNpmPath();
      if (!globalPath || !fs.existsSync(globalPath)) return;
      const entries = fs.readdirSync(globalPath, { withFileTypes: true });
      for (const entry of entries) {
        if (this._discovered.size >= this._config.maxDiscovered) break;
        const name = entry.name;
        if (this._mcpPatternMatch(name)) {
          this._registerDiscovery(name, path.join(globalPath, name), DISCOVERY_SOURCES.GLOBAL_NPM);
          found.push(name);
        }
      }
    }, 'McpAutoDiscovery', 'scan-global-npm');
    return found;
  }

  _mcpPatternMatch(name) {
    return this._config.mcpServerPattern.test(name) || this._config.mcpToolPattern.test(name);
  }

  _registerDiscovery(name, installPath, source, existingConfig) {
    if (this._discovered.has(name)) return;
    const info = {
      name,
      installPath,
      source,
      status: SERVER_STATUS.DISCOVERED,
      discoveredAt: new Date().toISOString(),
      config: existingConfig ?? null,
    };
    // Try to read package.json for metadata
    if (installPath) {
      try {
        const pkgJsonPath = path.join(installPath, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          info.version = pkg.version || null;
          info.description = pkg.description || null;
          info.bin = pkg.bin ?? null;
        }
      } catch (err) {
        debug('McpAutoDiscovery', 'read-package-json-' + name, err && err.message ? err.message : String(err));
        info.version = null;
        info.description = null;
        info.bin = null;
        this.emit('discovery-warning', { name, source, warning: 'package.json read failed', error: err && err.message ? err.message : String(err) });
      }
    }
    this._discovered.set(name, info);
    this._stats.totalDiscovered++;
    this._stats.bySource[source] = (this._stats.bySource[source] ?? 0) + 1;
    this.emit('server-discovered', { name, source, status: info.status });
  }

  _getGlobalNpmPath() {
    // Try common global npm paths
    const candidates = [
      path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (_e) { debug('skip-global-npm-path', _e && _e.message ? _e.message : String(_e)); }
    }
    return null;
  }

  _getDiscoveredList() {
    const result = [];
    this._discovered.forEach(function(info, _name) {
      result.push(Object.assign({}, info));
    });
    return result;
  }

  // Get a specific discovered server
  getDiscoveredServer(name) {
    if (this._shutDown) return null;
    const info = this._discovered.get(name);
    return info ? Object.assign({}, info) : null;
  }

  // Get all discovered servers
  getDiscoveredServers() {
    if (this._shutDown) return [];
    return this._getDiscoveredList();
  }

  // Get servers by source
  getServersBySource(source) {
    if (this._shutDown) return [];
    const result = [];
    this._discovered.forEach(function(info) {
      if (info.source === source) result.push(Object.assign({}, info));
    });
    return result;
  }

  // Generate config entries for discovered servers
  generateConfigEntries() {
    if (this._shutDown) return {};
    const entries = {};
    this._discovered.forEach(function(info, _name) {
      if (info.status === SERVER_STATUS.DISCOVERED || info.status === SERVER_STATUS.AVAILABLE) {
        entries[_name] = info.config || {
          command: 'npx',
          args: ['-y', _name],
          enabled: false,
        };
      }
    });
    return entries;
  }

  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalScans: 0, totalDiscovered: 0, bySource: {} };
    }
    return Object.assign({}, this._stats, {
      lastScanAt: this._lastScanAt,
      discoveredCount: this._discovered.size,
    });
  }

  _onShutdown() {
    this._discovered.clear();
    this._scanning = false;
    this.removeAllListeners();
  }
}

withShutdown(McpAutoDiscovery);

module.exports = { McpAutoDiscovery, DISCOVERY_SOURCES, SERVER_STATUS };
