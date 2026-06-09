'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const AppRegistry = require('../../../src/runtime/infrastructure/app-registry');

describe('AppRegistry - 构造函数', () => {
  it('默认配置初始化', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    assert.ok(registry);
    assert.strictEqual(registry._config.maxApps, 200);
    assert.strictEqual(registry._config.maxConnections, 50);
    assert.strictEqual(registry._config.autoDiscover, false);
    registry.shutdown();
  });

  it('自定义选项覆盖默认配置', () => {
    const registry = new AppRegistry({ maxApps: 300, maxConnections: 100, autoDiscover: false });
    assert.strictEqual(registry._config.maxApps, 300);
    assert.strictEqual(registry._config.maxConnections, 100);
    registry.shutdown();
  });

  it('静态常量正确暴露', () => {
    assert.ok(AppRegistry.APP_CATEGORIES);
    assert.ok(AppRegistry.CONNECTOR_TYPES);
    assert.ok(AppRegistry.BUILTIN_APPS);
    assert.ok(AppRegistry.DEFAULT_CONFIG);
    assert.strictEqual(AppRegistry.APP_CATEGORIES.PRODUCTIVITY, 'productivity');
    assert.strictEqual(AppRegistry.CONNECTOR_TYPES.MCP, 'mcp');
    assert.strictEqual(AppRegistry.DEFAULT_CONFIG.maxApps, 200);
    assert.strictEqual(AppRegistry.DEFAULT_CONFIG.maxConnections, 50);
  });
});

describe('AppRegistry - registerApp', () => {
  it('注册有效应用', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    const app = registry.registerApp('my-app', {
      name: 'My App',
      category: 'development',
      connectorType: 'http',
      description: '测试应用',
    });
    assert.strictEqual(app.id, 'my-app');
    assert.strictEqual(app.name, 'My App');
    assert.strictEqual(app.category, 'development');
    assert.strictEqual(app.connectorType, 'http');
    assert.strictEqual(app.description, '测试应用');
    registry.shutdown();
  });

  it('无效分类抛出TypeError', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    assert.throws(() => {
      registry.registerApp('bad-cat', {
        name: 'Bad',
        category: 'invalid-category',
        connectorType: 'http',
        description: '无效分类',
      });
    }, TypeError);
    registry.shutdown();
  });

  it('重复注册同一appId覆盖原应用', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('dup-app', {
      name: 'First',
      category: 'development',
      connectorType: 'http',
      description: '第一次',
    });
    registry.registerApp('dup-app', {
      name: 'Second',
      category: 'ai',
      connectorType: 'mcp',
      description: '第二次',
    });
    const app = registry.getApp('dup-app');
    assert.strictEqual(app.name, 'Second');
    assert.strictEqual(app.category, 'ai');
    registry.shutdown();
  });
});

describe('AppRegistry - getApp/listApps', () => {
  it('getApp返回已注册应用', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('test-app', {
      name: 'Test',
      category: 'development',
      connectorType: 'http',
      description: '测试',
    });
    const app = registry.getApp('test-app');
    assert.ok(app);
    assert.strictEqual(app.id, 'test-app');
    registry.shutdown();
  });

  it('listApps返回所有应用', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('app-a', {
      name: 'A', category: 'development', connectorType: 'http', description: 'A',
    });
    registry.registerApp('app-b', {
      name: 'B', category: 'ai', connectorType: 'mcp', description: 'B',
    });
    const all = registry.listApps();
    assert.strictEqual(all.length, 2);
    registry.shutdown();
  });

  it('listApps按分类过滤', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('app-a', {
      name: 'A', category: 'development', connectorType: 'http', description: 'A',
    });
    registry.registerApp('app-b', {
      name: 'B', category: 'ai', connectorType: 'mcp', description: 'B',
    });
    const devApps = registry.listApps({ category: 'development' });
    assert.strictEqual(devApps.length, 1);
    assert.strictEqual(devApps[0].category, 'development');
    registry.shutdown();
  });
});

describe('AppRegistry - connect', () => {
  it('连接MCP类型应用', async () => {
    const registry = new AppRegistry({ autoDiscover: false });
    const mockMcp = {
      connect: async () => ({ tools: ['tool1'] }),
    };
    registry.attachMCPClient(mockMcp);
    registry.registerApp('mcp-app', {
      name: 'MCP App',
      category: 'development',
      connectorType: 'mcp',
      description: 'MCP应用',
    });
    const conn = await registry.connect('mcp-app');
    assert.strictEqual(conn.appId, 'mcp-app');
    assert.strictEqual(conn.connectorType, 'mcp');
    assert.strictEqual(conn.status, 'connected');
    registry.shutdown();
  });

  it('连接Browser类型应用', async () => {
    const registry = new AppRegistry({ autoDiscover: false });
    const mockBrowser = {
      navigate: async () => {},
    };
    registry.attachBrowserAdapter(mockBrowser);
    registry.registerApp('browser-app', {
      name: 'Browser App',
      category: 'social',
      connectorType: 'browser',
      description: '浏览器应用',
    });
    const conn = await registry.connect('browser-app');
    assert.strictEqual(conn.appId, 'browser-app');
    assert.strictEqual(conn.connectorType, 'browser');
    assert.strictEqual(conn.status, 'connected');
    registry.shutdown();
  });

  it('连接未知应用抛出Error', async () => {
    const registry = new AppRegistry({ autoDiscover: false });
    await assert.rejects(() => registry.connect('nonexistent'), /App not found/);
    registry.shutdown();
  });
});

describe('AppRegistry - disconnect', () => {
  it('断开活跃连接', async () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('http-app', {
      name: 'HTTP App',
      category: 'development',
      connectorType: 'http',
      description: 'HTTP应用',
    });
    const conn = await registry.connect('http-app');
    const result = await registry.disconnect(conn.id);
    assert.strictEqual(result, true);
    assert.strictEqual(conn.status, 'disconnected');
    registry.shutdown();
  });

  it('断开连接触发app-disconnected事件', async () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('http-app', {
      name: 'HTTP App',
      category: 'development',
      connectorType: 'http',
      description: 'HTTP应用',
    });
    const conn = await registry.connect('http-app');
    let eventFired = false;
    let eventData = null;
    registry.on('app-disconnected', (data) => {
      eventFired = true;
      eventData = data;
    });
    await registry.disconnect(conn.id);
    assert.strictEqual(eventFired, true);
    assert.strictEqual(eventData.connectionId, conn.id);
    registry.shutdown();
  });
});

describe('AppRegistry - getCategories', () => {
  it('返回分类列表及计数', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('app-a', {
      name: 'A', category: 'development', connectorType: 'http', description: 'A',
    });
    registry.registerApp('app-b', {
      name: 'B', category: 'development', connectorType: 'mcp', description: 'B',
    });
    registry.registerApp('app-c', {
      name: 'C', category: 'ai', connectorType: 'http', description: 'C',
    });
    const categories = registry.getCategories();
    assert.ok(Array.isArray(categories));
    const devCat = categories.find(c => c.category === 'development');
    const aiCat = categories.find(c => c.category === 'ai');
    assert.strictEqual(devCat.count, 2);
    assert.strictEqual(aiCat.count, 1);
    registry.shutdown();
  });
});

describe('AppRegistry - getStats', () => {
  it('返回统计数据', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('app-a', {
      name: 'A', category: 'development', connectorType: 'http', description: 'A',
    });
    const stats = registry.getStats();
    assert.strictEqual(stats.appsRegistered, 1);
    assert.strictEqual(stats.connectionsCreated, 0);
    assert.strictEqual(stats.totalApps, 1);
    assert.strictEqual(stats.activeConnections, 0);
    assert.strictEqual(stats.attached.mcpClient, false);
    assert.strictEqual(stats.attached.browserAdapter, false);
    registry.shutdown();
  });
});

describe('AppRegistry - shutdown', () => {
  it('关闭后标记为已关闭', () => {
    const registry = new AppRegistry({ autoDiscover: false });
    registry.registerApp('app-a', {
      name: 'A', category: 'development', connectorType: 'http', description: 'A',
    });
    registry.shutdown();
    assert.strictEqual(registry._shutDown, true);
    assert.strictEqual(registry.isHealthy(), false);
  });
});
