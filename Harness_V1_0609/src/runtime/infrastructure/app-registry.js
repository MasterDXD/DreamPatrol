'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeCall, safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');
const BoundedMap = require('../../utils/bounded-map');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 应用分类枚举
 * @enum {string}
 */
const APP_CATEGORIES = {
  PRODUCTIVITY: 'productivity',
  DEVELOPMENT: 'development',
  COMMUNICATION: 'communication',
  DATA: 'data',
  DESIGN: 'design',
  STORAGE: 'storage',
  SOCIAL: 'social',
  AI: 'ai',
};

/**
 * 连接器类型枚举
 * @enum {string}
 */
const CONNECTOR_TYPES = {
  MCP: 'mcp',
  BROWSER: 'browser',
  CLI: 'cli',
  HTTP: 'http',
  FILE: 'file',
};

/**
 * 内置应用目录，融合OpenHuman一键连接能力
 * 提供主流应用的预配置连接信息，用户无需手动配置即可快速接入
 */
const BUILTIN_APPS = {
  'notion': { name: 'Notion', category: 'productivity', connectorType: 'mcp', description: '知识库与项目管理', icon: '📝', configKeys: ['apiKey'] },
  'github': { name: 'GitHub', category: 'development', connectorType: 'mcp', description: '代码托管与协作', icon: '🐙', configKeys: ['token'] },
  'slack': { name: 'Slack', category: 'communication', connectorType: 'mcp', description: '团队通讯', icon: '💬', configKeys: ['botToken'] },
  'google-drive': { name: 'Google Drive', category: 'storage', connectorType: 'mcp', description: '云存储与文档', icon: '📁', configKeys: ['credentials'] },
  'figma': { name: 'Figma', category: 'design', connectorType: 'http', description: 'UI设计工具', icon: '🎨', configKeys: ['accessToken'] },
  'jira': { name: 'Jira', category: 'productivity', connectorType: 'http', description: '项目管理', icon: '📋', configKeys: ['host', 'email', 'apiToken'] },
  'xiaoHongShu': { name: '小红书', category: 'social', connectorType: 'browser', description: '社交电商平台', icon: '📕', configKeys: [] },
  'douyin': { name: '抖音', category: 'social', connectorType: 'browser', description: '短视频平台', icon: '🎵', configKeys: [] },
  'wechat-official': { name: '微信公众号', category: 'social', connectorType: 'browser', description: '公众号内容管理', icon: '💚', configKeys: [] },
  'stackoverflow': { name: 'Stack Overflow', category: 'development', connectorType: 'browser', description: '开发者问答社区', icon: '📚', configKeys: [] },
  'hackernews': { name: 'Hacker News', category: 'social', connectorType: 'browser', description: '技术新闻', icon: '🔶', configKeys: [] },
  'producthunt': { name: 'Product Hunt', category: 'social', connectorType: 'browser', description: '产品发现', icon: '🐱', configKeys: [] },
  'openai': { name: 'OpenAI', category: 'ai', connectorType: 'http', description: 'AI模型服务', icon: '🤖', configKeys: ['apiKey'] },
  'anthropic': { name: 'Anthropic', category: 'ai', connectorType: 'http', description: 'Claude AI服务', icon: '🧠', configKeys: ['apiKey'] },
  'local-filesystem': { name: '本地文件系统', category: 'storage', connectorType: 'file', description: '本地文件读写', icon: '💾', configKeys: ['rootPath'] },
};

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  maxApps: 200,
  maxConnections: 50,
  autoDiscover: true,
};

/** @constant {Set<string>} 有效分类集合 */
const _VALID_CATEGORIES = new Set(Object.values(APP_CATEGORIES));

/** @constant {Set<string>} 有效连接器类型集合 */
const _VALID_CONNECTOR_TYPES = new Set(Object.values(CONNECTOR_TYPES));

/**
 * @module runtime/infrastructure/app-registry
 * @classdesc 应用注册表
 * 应用连接目录注册器。融合OpenHuman"一键应用连接目录"能力到Harness框架，
 * 提供预配置应用连接器目录，弥合MCPClient协议级连接与OpenHuman 118个一键应用连接体验之间的差距。
 *
 * @emits app-registered — 应用注册完成时触发，payload: { appId, name }
 * @emits app-connected — 应用连接成功时触发，payload: { connectionId, appId }
 * @emits app-disconnected — 应用断开连接时触发，payload: { connectionId }
 * @emits shutdown — 注册器关闭时触发
 *
 * @example
 * const AppRegistry = require('./app-registry');
 * const registry = new AppRegistry({ maxApps: 300 });
 *
 * // 注入MCP客户端
 * registry.attachMCPClient(mcpClient);
 *
 * // 一键连接GitHub
 * const conn = await registry.connect('github', { token: 'ghp_xxx' });
 *
 * // 按分类浏览应用
 * const devApps = registry.getAppsByCategory('development');
 */
class AppRegistry extends EventEmitter {
  /**
   * 创建AppRegistry实例
   * @param {Object} [options={}] - 配置选项
   * @param {number} [options.maxApps=200] - 最大注册应用数
   * @param {number} [options.maxConnections=50] - 最大活跃连接数
   * @param {boolean} [options.autoDiscover=true] - 是否自动加载内置应用
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._config = mergeConfig(DEFAULT_CONFIG, opts);

    // 已注册应用目录
    this._apps = new BoundedMap(this._config.maxApps);
    // 活跃连接池
    this._connections = new BoundedMap(this._config.maxConnections);
    // 运行统计
    this._stats = {
      appsRegistered: 0,
      connectionsCreated: 0,
      queriesExecuted: 0,
    };
    // 依赖注入状态
    this._attached = {
      mcpClient: false,
      browserAdapter: false,
    };
    this._mcp = null;
    this._browser = null;

    // 自动加载内置应用
    if (this._config.autoDiscover) {
      this._loadBuiltinApps();
    }
  }

  /**
   * 注入MCP客户端依赖
   * @param {Object} client - MCPClient实例，需提供connect方法
   * @returns {AppRegistry} 当前实例，支持链式调用
   * @throws {TypeError} client缺少connect方法时抛出
   */
  attachMCPClient(client) {
    if (!client || typeof client.connect !== 'function') {
      throw new TypeError('MCPClient must have a connect method');
    }
    this._mcp = client;
    this._attached.mcpClient = true;
    debug('AppRegistry', 'MCPClient attached');
    return this;
  }

  /**
   * 注入浏览器适配器依赖
   * @param {Object} adapter - BrowserUseAdapter实例，需提供navigate方法
   * @returns {AppRegistry} 当前实例，支持链式调用
   * @throws {TypeError} adapter缺少navigate方法时抛出
   */
  attachBrowserAdapter(adapter) {
    if (!adapter || typeof adapter.navigate !== 'function') {
      throw new TypeError('BrowserAdapter must have a navigate method');
    }
    this._browser = adapter;
    this._attached.browserAdapter = true;
    debug('AppRegistry', 'BrowserAdapter attached');
    return this;
  }

  /**
   * 注册应用到目录
   * @param {string} appId - 应用唯一标识符
   * @param {Object} appConfig - 应用配置
   * @param {string} appConfig.name - 应用名称
   * @param {string} appConfig.category - 应用分类（APP_CATEGORIES枚举值）
   * @param {string} appConfig.connectorType - 连接器类型（CONNECTOR_TYPES枚举值）
   * @param {string} appConfig.description - 应用描述
   * @param {string} [appConfig.icon] - 应用图标
   * @param {string[]} [appConfig.configKeys] - 连接所需配置键列表
   * @returns {Object} 注册后的应用对象
   * @throws {TypeError} 参数校验失败时抛出
   * @fires app-registered
   */
  registerApp(appId, appConfig) {
    this.guardShutdown();

    // 校验appId
    if (!appId || typeof appId !== 'string') {
      throw new TypeError('appId must be a non-empty string');
    }

    // 校验appConfig必填字段
    if (!appConfig || typeof appConfig !== 'object') {
      throw new TypeError('appConfig must be an object');
    }
    if (!appConfig.name || typeof appConfig.name !== 'string') {
      throw new TypeError('appConfig.name must be a non-empty string');
    }
    if (!appConfig.category || typeof appConfig.category !== 'string') {
      throw new TypeError('appConfig.category must be a non-empty string');
    }
    if (!appConfig.connectorType || typeof appConfig.connectorType !== 'string') {
      throw new TypeError('appConfig.connectorType must be a non-empty string');
    }
    if (!appConfig.description || typeof appConfig.description !== 'string') {
      throw new TypeError('appConfig.description must be a non-empty string');
    }

    // 校验分类合法性
    if (!_VALID_CATEGORIES.has(appConfig.category)) {
      throw new TypeError('appConfig.category must be one of: ' + Object.values(APP_CATEGORIES).join(', '));
    }

    // 校验连接器类型合法性
    if (!_VALID_CONNECTOR_TYPES.has(appConfig.connectorType)) {
      throw new TypeError('appConfig.connectorType must be one of: ' + Object.values(CONNECTOR_TYPES).join(', '));
    }

    // 构建应用对象
    const app = {
      id: appId,
      name: appConfig.name,
      category: appConfig.category,
      connectorType: appConfig.connectorType,
      description: appConfig.description,
      icon: appConfig.icon || '',
      configKeys: Array.isArray(appConfig.configKeys) ? appConfig.configKeys : [],
      registeredAt: Date.now(),
      isBuiltin: !!appConfig.isBuiltin,
    };

    this._apps.set(appId, app);
    this._stats.appsRegistered++;

    debug('AppRegistry', 'app-registered: ' + appId);

    /**
     * 应用注册事件
     * @event app-registered
     * @type {Object}
     * @property {string} appId - 应用标识
     * @property {string} name - 应用名称
     */
    this.emit('app-registered', { appId: appId, name: appConfig.name });

    return app;
  }

  /**
   * 根据ID获取应用
   * @param {string} appId - 应用唯一标识符
   * @returns {Object|undefined} 应用对象，不存在时返回undefined
   */
  getApp(appId) {
    return this._apps.get(appId);
  }

  /**
   * 列出应用，支持按分类、连接器类型和关键词过滤
   * @param {Object} [options={}] - 过滤选项
   * @param {string} [options.category] - 按分类过滤
   * @param {string} [options.connectorType] - 按连接器类型过滤
   * @param {string} [options.search] - 按名称或描述搜索（不区分大小写）
   * @returns {Object[]} 符合条件的应用列表
   */
  listApps(options) {
    this._stats.queriesExecuted++;
    const opts = options ?? {};
    const results = [];

    this._apps.forEach(function(app) {
      // 按分类过滤
      if (opts.category && app.category !== opts.category) {
        return;
      }
      // 按连接器类型过滤
      if (opts.connectorType && app.connectorType !== opts.connectorType) {
        return;
      }
      // 按关键词搜索名称或描述
      if (opts.search) {
        const keyword = opts.search.toLowerCase();
        const nameMatch = app.name.toLowerCase().indexOf(keyword) !== -1;
        const descMatch = app.description.toLowerCase().indexOf(keyword) !== -1;
        if (!nameMatch && !descMatch) {
          return;
        }
      }
      results.push(app);
    });

    return results;
  }

  /**
   * 按分类获取应用列表
   * @param {string} category - 应用分类（APP_CATEGORIES枚举值）
   * @returns {Object[]} 该分类下的应用列表
   */
  getAppsByCategory(category) {
    return this.listApps({ category: category });
  }

  /**
   * 获取所有可用分类及其应用数量
   * @returns {Object[]} 分类信息数组，每项包含 { category, label, count }
   */
  getCategories() {
    this._stats.queriesExecuted++;
    const counts = {};

    // 初始化所有分类计数
    Object.keys(APP_CATEGORIES).forEach(function(key) {
      counts[APP_CATEGORIES[key]] = 0;
    });

    // 统计各分类应用数
    this._apps.forEach(function(app) {
      if (counts[app.category] !== undefined) {
        counts[app.category]++;
      }
    });

    // 构建结果
    const categoryLabels = {
      productivity: '生产力工具',
      development: '开发工具',
      communication: '通讯工具',
      data: '数据平台',
      design: '设计工具',
      storage: '存储服务',
      social: '社交媒体',
      ai: 'AI服务',
    };

    return Object.keys(counts).map(function(cat) {
      return { category: cat, label: categoryLabels[cat] || cat, count: counts[cat] };
    });
  }

  /**
   * 一键连接到指定应用
   * 根据应用的连接器类型，自动选择MCP/Browser/CLI/HTTP/File通道建立连接
   * @param {string} appId - 应用唯一标识符
   * @param {Object} [config={}] - 连接配置（如API密钥、令牌等）
   * @returns {Promise<Object>} 连接对象
   * @throws {Error} 应用不存在或连接器未注入时抛出
   * @fires app-connected
   */
  async connect(appId, config) {
    this.guardShutdown();

    const app = this._apps.get(appId);
    if (!app) {
      throw new Error('App not found: ' + appId);
    }

    const connConfig = config ?? {};
    let connectionData = null;

    switch (app.connectorType) {
      case CONNECTOR_TYPES.MCP:
        // MCP协议连接：通过MCPClient建立
        if (!this._attached.mcpClient) {
          throw new Error('MCPClient not attached, cannot connect MCP app: ' + appId);
        }
        connectionData = await this._connectMCP(appId, app, connConfig);
        break;

      case CONNECTOR_TYPES.BROWSER:
        // 浏览器自动化连接：通过BrowserUseAdapter建立
        if (!this._attached.browserAdapter) {
          throw new Error('BrowserAdapter not attached, cannot connect browser app: ' + appId);
        }
        connectionData = await this._connectBrowser(appId, app, connConfig);
        break;

      case CONNECTOR_TYPES.CLI:
        // CLI工具连接：构建CLI连接配置
        connectionData = this._connectCLI(appId, app, connConfig);
        break;

      case CONNECTOR_TYPES.HTTP:
        // HTTP API连接：构建HTTP连接配置
        connectionData = this._connectHTTP(appId, app, connConfig);
        break;

      case CONNECTOR_TYPES.FILE:
        // 文件系统连接：构建文件系统连接配置
        connectionData = this._connectFile(appId, app, connConfig);
        break;

      default:
        throw new Error('Unsupported connector type: ' + app.connectorType);
    }

    // 创建连接记录
    const connection = {
      id: generateId(),
      appId: appId,
      connectorType: app.connectorType,
      status: 'connected',
      config: connectionData,
      connectedAt: Date.now(),
    };

    this._connections.set(connection.id, connection);
    this._stats.connectionsCreated++;

    debug('AppRegistry', 'app-connected: ' + appId + ' via ' + app.connectorType);

    /**
     * 应用连接事件
     * @event app-connected
     * @type {Object}
     * @property {string} connectionId - 连接标识
     * @property {string} appId - 应用标识
     */
    this.emit('app-connected', { connectionId: connection.id, appId: appId });

    return connection;
  }

  /**
   * 断开指定连接
   * @param {string} connectionId - 连接唯一标识符
   * @returns {Promise<boolean>} 是否成功断开
   * @throws {Error} 连接不存在时抛出
   * @fires app-disconnected
   */
  async disconnect(connectionId) {
    this.guardShutdown();

    const connection = this._connections.get(connectionId);
    if (!connection) {
      throw new Error('Connection not found: ' + connectionId);
    }

    // 标记为已断开
    connection.status = 'disconnected';
    connection.disconnectedAt = Date.now();

    // 从活跃连接池中移除
    this._connections.delete(connectionId);

    debug('AppRegistry', 'app-disconnected: ' + connectionId);

    /**
     * 应用断开连接事件
     * @event app-disconnected
     * @type {Object}
     * @property {string} connectionId - 连接标识
     */
    this.emit('app-disconnected', { connectionId: connectionId });

    return true;
  }

  /**
   * 根据ID获取连接
   * @param {string} connectionId - 连接唯一标识符
   * @returns {Object|undefined} 连接对象，不存在时返回undefined
   */
  getConnection(connectionId) {
    return this._connections.get(connectionId);
  }

  /**
   * 获取所有活跃连接
   * @returns {Object[]} 活跃连接列表
   */
  getActiveConnections() {
    const results = [];
    this._connections.forEach(function(conn) {
      if (conn.status === 'connected') {
        results.push(conn);
      }
    });
    return results;
  }

  /**
   * 获取运行统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    return {
      appsRegistered: this._stats.appsRegistered,
      connectionsCreated: this._stats.connectionsCreated,
      queriesExecuted: this._stats.queriesExecuted,
      activeConnections: this._connections.size,
      totalApps: this._apps.size,
      attached: { ...this._attached },
    };
  }

  // ---- 内部方法 ----

  /**
   * 通过MCPClient建立MCP协议连接
   * @param {string} appId - 应用标识
   * @param {Object} app - 应用配置
   * @param {Object} config - 用户提供的连接配置
   * @returns {Promise<Object>} MCP连接数据
   * @private
   */
  async _connectMCP(appId, app, config) {
    return safeExecute(async () => {
      // 构建MCP服务器配置
      const serverConfig = {
        name: appId,
        config: config,
      };
      // 尝试通过MCPClient连接
      const result = await this._mcp.connect(appId, serverConfig);
      return {
        type: 'mcp',
        serverName: appId,
        tools: result && result.tools ? result.tools : [],
        raw: result,
      };
    }, 'AppRegistry', 'connect-mcp:' + appId, { type: 'mcp', serverName: appId, tools: [] });
  }

  /**
   * 通过BrowserUseAdapter建立浏览器自动化连接
   * @param {string} appId - 应用标识
   * @param {Object} app - 应用配置
   * @param {Object} config - 用户提供的连接配置
   * @returns {Promise<Object>} 浏览器连接数据
   * @private
   */
  async _connectBrowser(appId, app, config) {
    return safeExecute(async () => {
      // 浏览器连接无需额外配置，确认适配器可用即可
      const url = config.url || null;
      if (url) {
        await this._browser.navigate(url);
      }
      return {
        type: 'browser',
        adapter: 'browser-use',
        url: url,
      };
    }, 'AppRegistry', 'connect-browser:' + appId, { type: 'browser', adapter: 'browser-use', url: null });
  }

  /**
   * 构建CLI工具连接配置
   * @param {string} appId - 应用标识
   * @param {Object} app - 应用配置
   * @param {Object} config - 用户提供的连接配置
   * @returns {Object} CLI连接数据
   * @private
   */
  _connectCLI(appId, app, config) {
    return {
      type: 'cli',
      command: config.command || appId,
      args: config.args ?? [],
      env: config.env ?? {},
    };
  }

  /**
   * 构建HTTP API连接配置
   * @param {string} appId - 应用标识
   * @param {Object} app - 应用配置
   * @param {Object} config - 用户提供的连接配置
   * @returns {Object} HTTP连接数据
   * @private
   */
  _connectHTTP(appId, app, config) {
    // 从configKeys中提取必要配置
    const extracted = {};
    if (Array.isArray(app.configKeys)) {
      app.configKeys.forEach(function(key) {
        if (config[key] !== undefined) {
          extracted[key] = config[key];
        }
      });
    }
    return {
      type: 'http',
      baseUrl: config.baseUrl || config.host || '',
      headers: config.headers ?? {},
      auth: extracted,
    };
  }

  /**
   * 构建文件系统连接配置
   * @param {string} appId - 应用标识
   * @param {Object} app - 应用配置
   * @param {Object} config - 用户提供的连接配置
   * @returns {Object} 文件系统连接数据
   * @private
   */
  _connectFile(appId, app, config) {
    return {
      type: 'file',
      rootPath: config.rootPath || process.cwd(),
      encoding: config.encoding || 'utf-8',
    };
  }

  /**
   * 加载内置应用到注册目录
   * 内置应用标记isBuiltin为true，不可被覆盖
   * @returns {number} 加载的应用数量
   * @private
   */
  _loadBuiltinApps() {
    const self = this;
    let count = 0;
    const builtinIds = Object.keys(BUILTIN_APPS);

    for (let i = 0; i < builtinIds.length; i++) {
      const appId = builtinIds[i];
      const appDef = BUILTIN_APPS[appId];

      // 跳过已注册的应用，避免覆盖
      if (self._apps.has(appId)) {
        continue;
      }

      const app = {
        id: appId,
        name: appDef.name,
        category: appDef.category,
        connectorType: appDef.connectorType,
        description: appDef.description,
        icon: appDef.icon || '',
        configKeys: Array.isArray(appDef.configKeys) ? appDef.configKeys : [],
        registeredAt: Date.now(),
        isBuiltin: true,
      };

      self._apps.set(appId, app);
      self._stats.appsRegistered++;
      count++;
    }

    debug('AppRegistry', 'builtin-apps-loaded: ' + count);
    return count;
  }

  /**
   * 关闭注册器，断开所有连接并清理状态
   * @fires shutdown
   */
  _onShutdown() {
    // 断开所有活跃连接
    this._connections.forEach(function(conn) {
      conn.status = 'disconnected';
      conn.disconnectedAt = Date.now();
    });

    // 清理资源
    safeCall(() => this._apps.shutdown(), 'AppRegistry', 'shutdown-apps');
    safeCall(() => this._connections.shutdown(), 'AppRegistry', 'shutdown-connections');

    // 重置依赖引用
    this._mcp = null;
    this._browser = null;
    this._attached = { mcpClient: false, browserAdapter: false };

    debug('AppRegistry', 'shutdown');
    this.removeAllListeners();
  }
}

// 混入ShutdownMixin能力
withShutdown(AppRegistry);

// 静态属性：枚举和常量
AppRegistry.APP_CATEGORIES = APP_CATEGORIES;
AppRegistry.CONNECTOR_TYPES = CONNECTOR_TYPES;
AppRegistry.BUILTIN_APPS = BUILTIN_APPS;
AppRegistry.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = AppRegistry;
