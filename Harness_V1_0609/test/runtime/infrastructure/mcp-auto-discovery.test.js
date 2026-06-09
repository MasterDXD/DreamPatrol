'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { McpAutoDiscovery, DISCOVERY_SOURCES, SERVER_STATUS } = require(
  path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-auto-discovery'),
);

/**
 * 创建临时目录结构用于测试文件系统扫描
 * @param {string} base - 基础临时目录
 * @param {Object} structure - 目录结构描述
 * @returns {string} 临时目录路径
 */
function createTempStructure(base, structure) {
  fs.mkdirSync(base, { recursive: true });
  for (const [name, content] of Object.entries(structure)) {
    const fullPath = path.join(base, name);
    if (typeof content === 'string') {
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content);
    } else if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
      // 以 .json 结尾的键名视为文件内容，否则视为子目录结构
      if (name.endsWith('.json')) {
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, JSON.stringify(content, null, 2));
      } else {
        createTempStructure(fullPath, content);
      }
    } else {
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, String(content));
    }
  }
  return base;
}

/**
 * 递归删除目录
 * @param {string} dirPath - 目录路径
 */
function removeTempDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_e) { /* ignore cleanup errors */ }
}

describe('McpAutoDiscovery - 导出常量', () => {
  it('DISCOVERY_SOURCES 包含所有发现源', () => {
    assert.strictEqual(DISCOVERY_SOURCES.NODE_MODULES, 'node_modules');
    assert.strictEqual(DISCOVERY_SOURCES.GLOBAL_NPM, 'global_npm');
    assert.strictEqual(DISCOVERY_SOURCES.CONFIG_DIR, 'config_dir');
    assert.strictEqual(DISCOVERY_SOURCES.MANIFEST, 'manifest');
  });

  it('SERVER_STATUS 包含所有服务器状态', () => {
    assert.strictEqual(SERVER_STATUS.DISCOVERED, 'discovered');
    assert.strictEqual(SERVER_STATUS.AVAILABLE, 'available');
    assert.strictEqual(SERVER_STATUS.UNAVAILABLE, 'unavailable');
    assert.strictEqual(SERVER_STATUS.ERROR, 'error');
  });
});

describe('McpAutoDiscovery - 构造函数', () => {
  let instance;

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
  });

  it('默认配置初始化', () => {
    instance = new McpAutoDiscovery();
    assert.ok(instance);
    assert.strictEqual(instance._config.scanNodeModules, true);
    assert.strictEqual(instance._config.scanGlobalNpm, false);
    assert.strictEqual(instance._config.scanConfigDir, true);
    assert.strictEqual(instance._config.maxDiscovered, 100);
    assert.strictEqual(instance._config.discoveryTimeoutMs, 5000);
  });

  it('自定义选项覆盖默认配置', () => {
    instance = new McpAutoDiscovery({
      scanNodeModules: false,
      scanGlobalNpm: true,
      maxDiscovered: 50,
    });
    assert.strictEqual(instance._config.scanNodeModules, false);
    assert.strictEqual(instance._config.scanGlobalNpm, true);
    assert.strictEqual(instance._config.maxDiscovered, 50);
    // 未覆盖的保持默认
    assert.strictEqual(instance._config.scanConfigDir, true);
  });

  it('初始统计数据正确', () => {
    instance = new McpAutoDiscovery();
    const stats = instance.getStats();
    assert.strictEqual(stats.totalScans, 0);
    assert.strictEqual(stats.totalDiscovered, 0);
    assert.strictEqual(stats.discoveredCount, 0);
    assert.strictEqual(stats.lastScanAt, null);
  });

  it('初始 bySource 统计均为零', () => {
    instance = new McpAutoDiscovery();
    const stats = instance.getStats();
    for (const source of Object.values(DISCOVERY_SOURCES)) {
      assert.strictEqual(stats.bySource[source], 0);
    }
  });
});

describe('McpAutoDiscovery - discover (node_modules)', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('发现 node_modules 中的 mcp-server-* 包', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-foo': {
          'package.json': { name: 'mcp-server-foo', version: '1.0.0', description: 'Foo server' },
        },
        'mcp-server-bar': {
          'package.json': { name: 'mcp-server-bar', version: '2.0.0' },
        },
        'other-package': {
          'package.json': { name: 'other-package' },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    const names = results.map(r => r.name);
    assert.ok(names.includes('mcp-server-foo'));
    assert.ok(names.includes('mcp-server-bar'));
    assert.ok(!names.includes('other-package'));
  });

  it('发现 node_modules 中的 mcp-* 工具包', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-tool-baz': {
          'package.json': { name: 'mcp-tool-baz', version: '3.0.0' },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    const names = results.map(r => r.name);
    assert.ok(names.includes('mcp-tool-baz'));
  });

  it('发现 scoped 包 (@scope/mcp-server-*)', () => {
    createTempStructure(tempDir, {
      node_modules: {
        '@myorg': {
          'mcp-server-scoped': {
            'package.json': { name: '@myorg/mcp-server-scoped', version: '1.0.0' },
          },
          'other-pkg': {
            'package.json': { name: '@myorg/other-pkg' },
          },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    const names = results.map(r => r.name);
    assert.ok(names.includes('@myorg/mcp-server-scoped'));
    assert.ok(!names.includes('@myorg/other-pkg'));
  });

  it('node_modules 不存在时不报错', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });

  it('读取 package.json 元数据', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-meta': {
          'package.json': {
            name: 'mcp-server-meta',
            version: '4.5.6',
            description: 'A meta server',
            bin: { 'mcp-server-meta': './bin.js' },
          },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const server = instance.getDiscoveredServer('mcp-server-meta');
    assert.strictEqual(server.version, '4.5.6');
    assert.strictEqual(server.description, 'A meta server');
    assert.ok(server.bin);
    assert.strictEqual(server.bin['mcp-server-meta'], './bin.js');
  });
});

describe('McpAutoDiscovery - discover (config_dir)', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('从 .harness/config.json 中发现 MCP 服务器', () => {
    createTempStructure(tempDir, {
      '.harness': {
        'config.json': JSON.stringify({
          mcp_servers: {
            'my-custom-server': {
              command: 'node',
              args: ['server.js'],
              enabled: true,
            },
          },
        }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    const names = results.map(r => r.name);
    assert.ok(names.includes('my-custom-server'));
  });

  it('config 中发现的服务器携带配置信息', () => {
    createTempStructure(tempDir, {
      '.harness': {
        'config.json': JSON.stringify({
          mcp_servers: {
            'configured-srv': {
              command: 'npx',
              args: ['-y', 'configured-srv'],
              enabled: true,
            },
          },
        }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    instance.discover();
    const server = instance.getDiscoveredServer('configured-srv');
    assert.ok(server.config);
    assert.strictEqual(server.config.command, 'npx');
    assert.strictEqual(server.config.enabled, true);
    assert.strictEqual(server.installPath, null);
  });

  it('.harness/config.json 不存在时不报错', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });

  it('config.json 中无 mcp_servers 字段时不报错', () => {
    createTempStructure(tempDir, {
      '.harness': {
        'config.json': JSON.stringify({ other_setting: true }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    const results = instance.discover();
    assert.strictEqual(results.length, 0);
  });
});

describe('McpAutoDiscovery - discover (重复扫描与并发)', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('重复调用 discover 不重复注册已发现的服务器', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-dup': {
          'package.json': { name: 'mcp-server-dup', version: '1.0.0' },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    instance.discover();
    const servers = instance.getDiscoveredServers();
    const dupCount = servers.filter(s => s.name === 'mcp-server-dup').length;
    assert.strictEqual(dupCount, 1);
  });

  it('扫描中再次调用 discover 返回当前结果', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    // 模拟正在扫描
    instance._scanning = true;
    const results = instance.discover();
    assert.ok(Array.isArray(results));
    instance._scanning = false;
  });
});

describe('McpAutoDiscovery - getDiscoveredServer', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('返回指定名称的服务器信息', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-target': {
          'package.json': { name: 'mcp-server-target', version: '1.0.0' },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const server = instance.getDiscoveredServer('mcp-server-target');
    assert.ok(server);
    assert.strictEqual(server.name, 'mcp-server-target');
    assert.strictEqual(server.status, SERVER_STATUS.DISCOVERED);
    assert.strictEqual(server.source, DISCOVERY_SOURCES.NODE_MODULES);
  });

  it('不存在时返回 null', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const server = instance.getDiscoveredServer('nonexistent');
    assert.strictEqual(server, null);
  });

  it('关闭后返回 null', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-shutdown': {
          'package.json': { name: 'mcp-server-shutdown' },
        },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    instance.shutdown();
    const server = instance.getDiscoveredServer('mcp-server-shutdown');
    assert.strictEqual(server, null);
  });
});

describe('McpAutoDiscovery - getDiscoveredServers', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('返回所有已发现服务器列表', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-a': { 'package.json': { name: 'mcp-server-a' } },
        'mcp-server-b': { 'package.json': { name: 'mcp-server-b' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const servers = instance.getDiscoveredServers();
    assert.strictEqual(servers.length, 2);
    const names = servers.map(s => s.name);
    assert.ok(names.includes('mcp-server-a'));
    assert.ok(names.includes('mcp-server-b'));
  });

  it('未扫描时返回空数组', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const servers = instance.getDiscoveredServers();
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 0);
  });

  it('关闭后返回空数组', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    const servers = instance.getDiscoveredServers();
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 0);
  });
});

describe('McpAutoDiscovery - getServersBySource', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('按来源过滤服务器', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-nm': { 'package.json': { name: 'mcp-server-nm' } },
      },
      '.harness': {
        'config.json': JSON.stringify({
          mcp_servers: {
            'config-srv': { command: 'node', args: ['srv.js'] },
          },
        }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    instance.discover();

    const nmServers = instance.getServersBySource(DISCOVERY_SOURCES.NODE_MODULES);
    assert.strictEqual(nmServers.length, 1);
    assert.strictEqual(nmServers[0].name, 'mcp-server-nm');

    const configServers = instance.getServersBySource(DISCOVERY_SOURCES.CONFIG_DIR);
    assert.strictEqual(configServers.length, 1);
    assert.strictEqual(configServers[0].name, 'config-srv');
  });

  it('无匹配来源时返回空数组', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const servers = instance.getServersBySource(DISCOVERY_SOURCES.GLOBAL_NPM);
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 0);
  });

  it('关闭后返回空数组', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    const servers = instance.getServersBySource(DISCOVERY_SOURCES.NODE_MODULES);
    assert.strictEqual(servers.length, 0);
  });
});

describe('McpAutoDiscovery - generateConfigEntries', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('为已发现的服务器生成配置条目', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-gen': { 'package.json': { name: 'mcp-server-gen' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const entries = instance.generateConfigEntries();
    assert.ok(entries['mcp-server-gen']);
    assert.strictEqual(entries['mcp-server-gen'].command, 'npx');
    assert.ok(entries['mcp-server-gen'].args.includes('mcp-server-gen'));
    assert.strictEqual(entries['mcp-server-gen'].enabled, false);
  });

  it('保留 config_dir 来源的原始配置', () => {
    createTempStructure(tempDir, {
      '.harness': {
        'config.json': JSON.stringify({
          mcp_servers: {
            'custom-srv': {
              command: 'custom-runner',
              args: ['--port', '3000'],
              enabled: true,
            },
          },
        }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    instance.discover();
    const entries = instance.generateConfigEntries();
    assert.ok(entries['custom-srv']);
    assert.strictEqual(entries['custom-srv'].command, 'custom-runner');
    assert.strictEqual(entries['custom-srv'].enabled, true);
  });

  it('关闭后返回空对象', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    const entries = instance.generateConfigEntries();
    assert.ok(typeof entries === 'object');
    assert.strictEqual(Object.keys(entries).length, 0);
  });
});

describe('McpAutoDiscovery - getStats', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('扫描后统计数据更新', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-stat1': { 'package.json': { name: 'mcp-server-stat1' } },
        'mcp-server-stat2': { 'package.json': { name: 'mcp-server-stat2' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const stats = instance.getStats();
    assert.strictEqual(stats.totalScans, 1);
    assert.strictEqual(stats.totalDiscovered, 2);
    assert.strictEqual(stats.discoveredCount, 2);
    assert.ok(stats.lastScanAt);
    assert.strictEqual(stats.bySource[DISCOVERY_SOURCES.NODE_MODULES], 2);
  });

  it('关闭后 getStats 返回零值', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    const stats = instance.getStats();
    assert.strictEqual(stats.totalScans, 0);
    assert.strictEqual(stats.totalDiscovered, 0);
  });
});

describe('McpAutoDiscovery - shutdown', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance && !instance._shutDown) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('关闭后实例标记为已关闭', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    assert.strictEqual(instance._shutDown, true);
    assert.strictEqual(instance.isHealthy(), false);
  });

  it('关闭后 discover 抛出错误', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    assert.throws(() => instance.discover(), /shut down/i);
  });

  it('关闭后清除已发现的服务器', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-cleanup': { 'package.json': { name: 'mcp-server-cleanup' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    assert.strictEqual(instance.getDiscoveredServers().length, 1);
    instance.shutdown();
    assert.strictEqual(instance.getDiscoveredServers().length, 0);
  });

  it('关闭后移除所有事件监听器', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.on('test-event', () => {});
    instance.shutdown();
    assert.strictEqual(instance.listenerCount('test-event'), 0);
  });

  it('重复关闭不报错', () => {
    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.shutdown();
    instance.shutdown(); // 第二次关闭
    assert.strictEqual(instance._shutDown, true);
  });
});

describe('McpAutoDiscovery - maxDiscovered 限制', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('遵守 maxDiscovered 上限', () => {
    const nmStructure = {};
    for (let i = 0; i < 10; i++) {
      nmStructure['mcp-server-limit' + i] = {
        'package.json': { name: 'mcp-server-limit' + i },
      };
    }
    createTempStructure(tempDir, { node_modules: nmStructure });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
      maxDiscovered: 3,
    });

    instance.discover();
    const servers = instance.getDiscoveredServers();
    assert.ok(servers.length <= 3, '发现数量不应超过 maxDiscovered');
  });
});

describe('McpAutoDiscovery - 自定义模式匹配', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('使用自定义 mcpServerPattern', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'custom-mcp-xyz': { 'package.json': { name: 'custom-mcp-xyz' } },
        'mcp-server-abc': { 'package.json': { name: 'mcp-server-abc' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
      mcpServerPattern: /^custom-mcp-[\w-]+$/,
      mcpToolPattern: /^$/,
    });

    instance.discover();
    const servers = instance.getDiscoveredServers();
    const names = servers.map(s => s.name);
    assert.ok(names.includes('custom-mcp-xyz'));
    assert.ok(!names.includes('mcp-server-abc'));
  });
});

describe('McpAutoDiscovery - 事件发射', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('发现服务器时发射 server-discovered 事件', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-event': { 'package.json': { name: 'mcp-server-event' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const discoveredEvents = [];
    instance.on('server-discovered', (data) => {
      discoveredEvents.push(data);
    });

    instance.discover();
    assert.strictEqual(discoveredEvents.length, 1);
    assert.strictEqual(discoveredEvents[0].name, 'mcp-server-event');
    assert.strictEqual(discoveredEvents[0].source, DISCOVERY_SOURCES.NODE_MODULES);
    assert.strictEqual(discoveredEvents[0].status, SERVER_STATUS.DISCOVERED);
  });

  it('扫描完成时发射 discovery-complete 事件', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-done': { 'package.json': { name: 'mcp-server-done' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    let completeEvent = null;
    instance.on('discovery-complete', (data) => {
      completeEvent = data;
    });

    instance.discover();
    assert.ok(completeEvent);
    assert.strictEqual(completeEvent.totalDiscovered, 1);
    assert.strictEqual(completeEvent.scanCount, 1);
  });

  it('config_dir 发现也发射 server-discovered 事件', () => {
    createTempStructure(tempDir, {
      '.harness': {
        'config.json': JSON.stringify({
          mcp_servers: {
            'config-event-srv': { command: 'node' },
          },
        }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: false,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    const discoveredEvents = [];
    instance.on('server-discovered', (data) => {
      discoveredEvents.push(data);
    });

    instance.discover();
    assert.strictEqual(discoveredEvents.length, 1);
    assert.strictEqual(discoveredEvents[0].name, 'config-event-srv');
    assert.strictEqual(discoveredEvents[0].source, DISCOVERY_SOURCES.CONFIG_DIR);
  });

  it('多个服务器发现时发射多个 server-discovered 事件', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-ev1': { 'package.json': { name: 'mcp-server-ev1' } },
        'mcp-server-ev2': { 'package.json': { name: 'mcp-server-ev2' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    const discoveredEvents = [];
    instance.on('server-discovered', (data) => {
      discoveredEvents.push(data);
    });

    instance.discover();
    assert.strictEqual(discoveredEvents.length, 2);
  });
});

describe('McpAutoDiscovery - 发现信息结构', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('发现信息包含必要字段', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-info': { 'package.json': { name: 'mcp-server-info', version: '1.2.3' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const server = instance.getDiscoveredServer('mcp-server-info');
    assert.strictEqual(server.name, 'mcp-server-info');
    assert.ok(server.installPath);
    assert.strictEqual(server.source, DISCOVERY_SOURCES.NODE_MODULES);
    assert.strictEqual(server.status, SERVER_STATUS.DISCOVERED);
    assert.ok(server.discoveredAt);
    assert.strictEqual(server.version, '1.2.3');
  });

  it('getDiscoveredServer 返回副本而非引用', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-copy': { 'package.json': { name: 'mcp-server-copy' } },
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: false,
      scanGlobalNpm: false,
    });

    instance.discover();
    const server1 = instance.getDiscoveredServer('mcp-server-copy');
    const server2 = instance.getDiscoveredServer('mcp-server-copy');
    server1.name = 'modified';
    assert.strictEqual(server2.name, 'mcp-server-copy');
  });
});

describe('McpAutoDiscovery - 多来源混合发现', () => {
  let instance;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    if (instance) instance.shutdown();
    instance = null;
    removeTempDir(tempDir);
  });

  it('同时从 node_modules 和 config_dir 发现服务器', () => {
    createTempStructure(tempDir, {
      node_modules: {
        'mcp-server-mixed-nm': { 'package.json': { name: 'mcp-server-mixed-nm' } },
      },
      '.harness': {
        'config.json': JSON.stringify({
          mcp_servers: {
            'mcp-server-mixed-cfg': { command: 'node', args: ['cfg.js'] },
          },
        }),
      },
    });

    instance = new McpAutoDiscovery({
      projectRoot: tempDir,
      scanNodeModules: true,
      scanConfigDir: true,
      scanGlobalNpm: false,
    });

    instance.discover();
    const servers = instance.getDiscoveredServers();
    assert.strictEqual(servers.length, 2);

    const stats = instance.getStats();
    assert.strictEqual(stats.bySource[DISCOVERY_SOURCES.NODE_MODULES], 1);
    assert.strictEqual(stats.bySource[DISCOVERY_SOURCES.CONFIG_DIR], 1);
  });
});
