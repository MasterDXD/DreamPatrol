'use strict';

/**
 * @module runtime/infrastructure/browser-use-adapter
 * @classdesc 浏览器使用适配器（BrowserUseAdapter）—— CDP直连+MCP双模式浏览器自动化。
 * 支持导航、截图、数据提取、模板化字段提取（小红书/抖音/公众号/Reddit等6+平台），
 * 自愈工作流（重试/降级/恢复），集成CDPClient实现Chrome DevTools Protocol直连。
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const CDPClient = require('./cdp-client');
const debug = require('../../utils/debug-logger')('BrowserUseAdapter');
const { safeCall } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');
const { DeepeningError, ERROR_CODES } = require('../../errors');

const BROWSER_USE_MODES = { DIRECT: 'direct', MCP: 'mcp' };

const SELF_HEALING_STRATEGIES = {
  CLICK_COORDINATE: 'click_coordinate',
  CLICK_JS: 'click_js',
  TYPE_CLEAR_AND_TYPE: 'type_clear_and_type',
  TYPE_JS_SET_VALUE: 'type_js_set_value',
  NAVIGATE_RELOAD: 'navigate_reload',
  NAVIGATE_NEW_TAB: 'navigate_new_tab',
  GET_DOM_EVALUATE: 'get_dom_evaluate',
};

const DEFAULT_CDP_OPTIONS = { host: '127.0.0.1', port: 9222 };

const MAX_SELF_HEALING_LOG = 50;
const MAX_SCREENSHOTS_DEFAULT = 10;
const MAX_NAVIGATION_HISTORY_DEFAULT = 100;

const DATA_COLLECT_TEMPLATES = {
  'xiaohongshu-note': {
    name: '小红书笔记',
    fields: [
      { key: 'coverUrl', selector: '.note-image img, .cover img', attr: 'src', type: 'string' },
      { key: 'title', selector: '.note-title, .title', attr: 'textContent', type: 'string' },
      { key: 'authorId', selector: '.author .user-name, .author-name', attr: 'textContent', type: 'string' },
      { key: 'likes', selector: '.like-count, .like-wrapper .count', attr: 'textContent', type: 'number' },
      { key: 'collects', selector: '.collect-count, .collect-wrapper .count', attr: 'textContent', type: 'number' },
      { key: 'comments', selector: '.comment-count, .chat-wrapper .count', attr: 'textContent', type: 'number' },
      { key: 'publishTime', selector: '.date, .publish-time', attr: 'textContent', type: 'string' },
      { key: 'noteType', selector: '.note-type', attr: 'textContent', type: 'string' },
      { key: 'topics', selector: '.tag, .topic', attr: 'textContent', type: 'array' },
    ],
    itemSelector: '.note-item, .feeds-container .note',
  },
  'douyin-video': {
    name: '抖音视频',
    fields: [
      { key: 'coverUrl', selector: '.video-cover img, .poster img', attr: 'src', type: 'string' },
      { key: 'title', selector: '.video-title, .desc', attr: 'textContent', type: 'string' },
      { key: 'authorId', selector: '.author-name, .user-name', attr: 'textContent', type: 'string' },
      { key: 'likes', selector: '.like-count, .digg .count', attr: 'textContent', type: 'number' },
      { key: 'collects', selector: '.collect-count, .collect .count', attr: 'textContent', type: 'number' },
      { key: 'comments', selector: '.comment-count, .comment .count', attr: 'textContent', type: 'number' },
      { key: 'publishTime', selector: '.time, .publish-time', attr: 'textContent', type: 'string' },
      { key: 'topics', selector: '.tag, .topic', attr: 'textContent', type: 'array' },
    ],
    itemSelector: '.video-item, .feed-card',
  },
  'wechat-article': {
    name: '微信公众号文章',
    fields: [
      { key: 'coverUrl', selector: '.rich_media_meta_primary .img, .cover img', attr: 'src', type: 'string' },
      { key: 'title', selector: '.rich_media_title, #activity-name', attr: 'textContent', type: 'string' },
      { key: 'authorId', selector: '.rich_media_meta_nickname, .profile_nickname', attr: 'textContent', type: 'string' },
      { key: 'likes', selector: '.like_num, #like_old', attr: 'textContent', type: 'number' },
      { key: 'publishTime', selector: '.rich_media_meta_primary .rich_media_meta_text, #publish_time', attr: 'textContent', type: 'string' },
      { key: 'topics', selector: '.article-tag__item, .tag', attr: 'textContent', type: 'array' },
    ],
    itemSelector: '.rich_media_area_primary, body',
  },
  'generic': {
    name: '通用网页',
    fields: [
      { key: 'title', selector: 'h1, .title, [class*="title"]', attr: 'textContent', type: 'string' },
      { key: 'author', selector: '.author, [class*="author"], [class*="user"]', attr: 'textContent', type: 'string' },
      { key: 'publishTime', selector: '.date, .time, [class*="date"], [class*="time"]', attr: 'textContent', type: 'string' },
      { key: 'content', selector: '.content, .article, [class*="content"]', attr: 'textContent', type: 'string' },
    ],
    itemSelector: 'body',
  },
  'reddit-post': {
    name: 'Reddit帖子',
    fields: [
      { key: 'title', selector: 'h3, [slot="title"]', attr: 'textContent', type: 'string' },
      { key: 'author', selector: '[slot="author-name"], .author', attr: 'textContent', type: 'string' },
      { key: 'upvotes', selector: '[score], .vote-arrow-up + span, button[aria-label="upvote"] + span', attr: 'textContent', type: 'number' },
      { key: 'commentCount', selector: '[slot="num-comments"], .icon-comment + span', attr: 'textContent', type: 'number' },
      { key: 'publishTime', selector: 'time, [datetime]', attr: 'textContent', type: 'string' },
      { key: 'subreddit', selector: '[slot="subreddit"], a[href*="/r/"]', attr: 'textContent', type: 'string' },
      { key: 'content', selector: '[slot="text-body"], .md', attr: 'textContent', type: 'string' },
    ],
    itemSelector: '[role="listitem"], .Post, article',
  },
  'hackernews-story': {
    name: 'Hacker News故事',
    fields: [
      { key: 'title', selector: '.titleline > a, .title a', attr: 'textContent', type: 'string' },
      { key: 'url', selector: '.titleline > a, .title a', attr: 'href', type: 'string' },
      { key: 'points', selector: '.score', attr: 'textContent', type: 'number' },
      { key: 'author', selector: '.hnuser, .byline a', attr: 'textContent', type: 'string' },
      { key: 'commentCount', selector: 'a[href*="item"]:last-child', attr: 'textContent', type: 'number' },
      { key: 'publishTime', selector: '.age', attr: 'textContent', type: 'string' },
    ],
    itemSelector: '.athing, tr.item',
  },
  'producthunt-post': {
    name: 'ProductHunt产品',
    fields: [
      { key: 'name', selector: '[data-test="post-name"], h3', attr: 'textContent', type: 'string' },
      { key: 'tagline', selector: '[data-test="post-tagline"], .tagline', attr: 'textContent', type: 'string' },
      { key: 'upvotes', selector: '[data-test="post-vote-count"], .vote-count', attr: 'textContent', type: 'number' },
      { key: 'commentCount', selector: '[data-test="post-comment-count"], .comment-count', attr: 'textContent', type: 'number' },
      { key: 'topics', selector: '[data-test="post-topic"], .topic-tag', attr: 'textContent', type: 'array' },
    ],
    itemSelector: '[data-test="post-item"], .product-item',
  },
};

const SUPPORTED_ACTIONS = new Set([
  'click', 'type', 'screenshot', 'evaluate', 'getDOM',
  'scroll', 'press_key', 'upload_file', 'wait_for_load',
]);

/**
 * 浏览器使用适配器。CDP直连+MCP双模式浏览器自动化，支持导航、截图、
 * 数据提取、模板化字段采集和自愈工作流。
 *
 * @classdesc 浏览器使用适配器。CDP直连+MCP双模式，navigate/executeAction/screenshot/
 * extractByTemplate(DATA_COLLECT_TEMPLATES多平台采集模板)/selfHeal自愈工作流。
 * 与CDPClient和MCPClient集成，支持小红书/抖音/公众号/Reddit等6种采集模板。
 *
 * @extends EventEmitter
 */
class BrowserUseAdapter extends EventEmitter {
  /**
   * 创建 BrowserUseAdapter 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.mode='direct'] - 浏览器使用模式（'direct'或'mcp'）
   * @param {Object} [options.cdpOptions={}] - CDP连接选项
   * @param {Object} [options.mcpClient=null] - MCP协议客户端实例
   * @param {string} [options.mcpServerName='browser-use'] - MCP服务器名称
   */
  constructor(options) {
    super();
    this._mode = (options && options.mode) ?? BROWSER_USE_MODES.DIRECT;
    if (this._mode !== BROWSER_USE_MODES.DIRECT && this._mode !== BROWSER_USE_MODES.MCP) {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'Invalid mode: ' + this._mode + '. Must be "direct" or "mcp"');
    }
    this._cdpOptions = options?.cdpOptions ?? {};
    this._mcpClient = options?.mcpClient ?? null;
    this._mcpServerName = (options && options.mcpServerName) ?? 'browser-use';
    this._maxScreenshots = (options && options.maxScreenshots) ?? MAX_SCREENSHOTS_DEFAULT;
    this._maxNavigationHistory = (options && options.maxNavigationHistory) ?? MAX_NAVIGATION_HISTORY_DEFAULT;
    this._cdp = null;
    this._currentUrl = null;
    this._navigationHistory = [];
    this._screenshotCache = new Map();
    this._selfHealingLog = [];
    this._stats = {
      totalCommands: 0,
      successfulCommands: 0,
      failedCommands: 0,
      selfHealingCount: 0,
    };
  }

  /**
   * 初始化浏览器适配器。根据模式（direct/mcp）建立CDP连接或验证MCP服务器状态，
   * 支持并发初始化去重。
   * @returns {Promise<void>}
   * @throws {DeepeningError} MCP模式下客户端缺失或服务器未连接时抛出
   */
  async init() {
    this.guardShutdown();
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInit() {
    if (this._mode === BROWSER_USE_MODES.DIRECT) {
      const cdpOpts = safeAssign({}, DEFAULT_CDP_OPTIONS, this._cdpOptions);
      this._cdp = new CDPClient(cdpOpts);
      await this._cdp.connect();
    } else {
      if (!this._mcpClient || typeof this._mcpClient.callTool !== 'function') {
        throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'mcpClient is required for MCP mode and must have a callTool method');
      }
      const status = this._mcpClient.getServerStatus();
      if (!status[this._mcpServerName] || !status[this._mcpServerName].connected) {
        throw new DeepeningError(ERROR_CODES.CONNECTION_FAILED, 'BrowserUse MCP server "' + this._mcpServerName + '" is not connected');
      }
    }
    this._initialized = true;
    this.emit('initialized', { mode: this._mode });
  }

  /**
   * 导航到指定URL。通过CDP或MCP模式执行页面导航，并记录导航历史。
   * @param {string} url - 目标URL
   * @returns {Promise<void>}
   * @throws {DeepeningError} url无效时抛出
   */
  async navigate(url) {
    this.guardShutdown();
    if (!url || typeof url !== 'string') {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'url must be a non-empty string');
    }
    try {
      if (this._mode === BROWSER_USE_MODES.DIRECT) {
        await this._cdp.navigate(url);
      } else {
        await this._mcpClient.callTool('mcp_' + this._mcpServerName + '_browser_navigate', { url });
      }
      if (this._shutDown) return { success: false, error: 'Shut down during navigation' };
      this._currentUrl = url;
      this._navigationHistory.push({ url, timestamp: Date.now() });
      if (this._navigationHistory.length > this._maxNavigationHistory) {
        this._navigationHistory.shift();
      }
      this.emit('navigated', { url });
    } catch (err) {
      debug('navigate', err);
      throw err;
    }
  }

  /**
   * 执行浏览器操作。支持click、type、screenshot、evaluate、getDOM、scroll、
   * press_key、upload_file、wait_for_load等操作，通过CDP或MCP模式执行。
   * @param {string} action - 操作名称
   * @param {Object} [params] - 操作参数
   * @returns {Promise<*>} 操作执行结果
   * @throws {DeepeningError} 操作名无效或不支持时抛出
   */
  async executeAction(action, params) {
    this.guardShutdown();
    if (!action || typeof action !== 'string') {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'action must be a non-empty string');
    }
    if (!SUPPORTED_ACTIONS.has(action)) {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'Unsupported action: ' + action + '. Supported: ' + Array.from(SUPPORTED_ACTIONS).join(', '));
    }
    this._stats.totalCommands++;
    try {
      let result;
      if (this._mode === BROWSER_USE_MODES.DIRECT) {
        result = await this._executeDirectAction(action, params);
      } else {
        result = await this._mcpClient.callTool('mcp_' + this._mcpServerName + '_' + action, params ?? {});
      }
      if (this._shutDown) return { success: false, error: 'Shut down during action' };
      this._stats.successfulCommands++;
      this.emit('action-executed', { action, params, success: true });
      return result;
    } catch (err) {
      this._stats.failedCommands++;
      this.emit('action-executed', { action, params, success: false, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  async _executeDirectAction(action, params) {
    switch (action) {
      case 'click':
        return this._cdp.click(params.x, params.y);
      case 'type':
        return this._cdp.type(params.text);
      case 'screenshot':
        return this._cdp.screenshot();
      case 'evaluate':
        return this._cdp.evaluate(params.expression);
      case 'getDOM':
        return this._cdp.getDOM();
      case 'scroll': {
        const scrollX = (typeof params.x === 'number' && Number.isFinite(params.x)) ? params.x : 0;
        const scrollY = (typeof params.y === 'number' && Number.isFinite(params.y)) ? params.y : 0;
        return this._cdp.evaluate('window.scrollBy(' + scrollX + ',' + scrollY + ')');
      }
      case 'press_key':
        return this._cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: params.key,
          code: params.code || params.key,
          windowsVirtualKeyCode: params.keyCode,
        });
      case 'upload_file':
        return this._cdp.send('DOM.setFileInputFiles', {
          nodeId: params.nodeId,
          files: params.files,
        });
      case 'wait_for_load':
        return this._cdp.send('Page.waitForLoadEvent', { waitUntil: params.waitUntil || 'load' });
      default:
        throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'Unhandled direct action: ' + action);
    }
  }

  /**
   * 自愈修复失败操作。根据失败的操作类型选择对应的修复策略依次尝试，
   * 包括坐标点击、JS点击、清空重输、JS设值、页面刷新、新标签页导航等策略。
   * @param {string} failedAction - 失败的操作名称
   * @param {Error} error - 失败时的错误对象
   * @param {Object} [context] - 修复上下文，提供备选参数（如selector、x/y坐标、text等）
   * @returns {Promise<*>} 修复策略执行成功的结果
   * @throws {DeepeningError} 所有修复策略均失败时抛出
   */
  async selfHeal(failedAction, error, context) {
    this.guardShutdown();
    this._selfHealingLog.push({
      action: failedAction,
      error: error && error.message ? error.message : String(error),
      context: context ?? null,
      timestamp: Date.now(),
    });
    if (this._selfHealingLog.length > MAX_SELF_HEALING_LOG) {
      this._selfHealingLog.shift();
    }
    this.emit('self-healing-started', { action: failedAction, error: error && error.message ? error.message : String(error) });

    const strategies = this._getHealingStrategies(failedAction, context);
    for (const strategy of strategies) {
      try {
        const result = await strategy.execute();
        if (this._shutDown) return { success: false, error: 'Shut down during healing' };
        this._stats.selfHealingCount++;
        this.emit('self-healing-succeeded', {
          action: failedAction,
          strategy: strategy.name,
          result,
        });
        return result;
      } catch (healErr) {
        debug('selfHeal:' + strategy.name, healErr);
      }
    }
    this.emit('self-healing-failed', {
      action: failedAction,
      error: error && error.message ? error.message : String(error),
    });
    throw new DeepeningError(ERROR_CODES.RETRY_EXHAUSTED, 'Self-healing failed for action: ' + failedAction + ': ' + (error && error.message ? error.message : String(error)));
  }

  _getHealingStrategies(failedAction, context) {
    const strategies = [];
    if (failedAction === 'click') {
      strategies.push({
        name: SELF_HEALING_STRATEGIES.CLICK_COORDINATE,
        execute: () => {
          if (context && context.x != null && context.y != null) {
            return this._executeDirectAction('click', { x: context.x, y: context.y });
          }
          throw new DeepeningError(ERROR_CODES.MISSING_PARAMETER, 'No coordinates for coordinate-based click');
        },
      });
      strategies.push({
        name: SELF_HEALING_STRATEGIES.CLICK_JS,
        execute: () => {
          const selector = context && context.selector;
          if (!selector) throw new DeepeningError(ERROR_CODES.MISSING_PARAMETER, 'No selector for JS click');
          this._validateSelector(selector);
          return this._executeDirectAction('evaluate', {
            expression: 'document.querySelector(' + JSON.stringify(selector) + ').click()',
          });
        },
      });
    } else if (failedAction === 'type') {
      strategies.push({
        name: SELF_HEALING_STRATEGIES.TYPE_CLEAR_AND_TYPE,
        execute: () => {
          const selector = context && context.selector;
          const text = context && context.text;
          if (!selector || text == null) throw new DeepeningError(ERROR_CODES.MISSING_PARAMETER, 'No selector/text for clear+type');
          this._validateSelector(selector);
          return this._executeDirectAction('evaluate', {
            expression: '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(el){el.value=\'\';el.focus();}return true;})()',
          }).then(() => this._executeDirectAction('type', { text })).catch(err => {
            debug('BrowserUseAdapter', 'selfHeal-clearAndType-error', err && err.message ? err.message : String(err));
            throw err;
          });
        },
      });
      strategies.push({
        name: SELF_HEALING_STRATEGIES.TYPE_JS_SET_VALUE,
        execute: () => {
          const selector = context && context.selector;
          const text = context && context.text;
          if (!selector || text == null) throw new DeepeningError(ERROR_CODES.MISSING_PARAMETER, 'No selector/text for JS setValue');
          this._validateSelector(selector);
          return this._executeDirectAction('evaluate', {
            expression: '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(el){el.value=' + JSON.stringify(String(text)) + ';el.dispatchEvent(new Event(\'input\',{bubbles:true}));el.dispatchEvent(new Event(\'change\',{bubbles:true}));}return true;})()',
          });
        },
      });
    } else if (failedAction === 'navigate') {
      strategies.push({
        name: SELF_HEALING_STRATEGIES.NAVIGATE_RELOAD,
        execute: () => {
          return this._executeDirectAction('evaluate', { expression: 'location.reload()' });
        },
      });
      strategies.push({
        name: SELF_HEALING_STRATEGIES.NAVIGATE_NEW_TAB,
        execute: () => {
          const url = context && context.url;
          if (!url) throw new DeepeningError(ERROR_CODES.MISSING_PARAMETER, 'No URL for new tab navigation');
          return this._cdp.send('Target.createTarget', { url });
        },
      });
    } else if (failedAction === 'getDOM') {
      strategies.push({
        name: SELF_HEALING_STRATEGIES.GET_DOM_EVALUATE,
        execute: () => {
          return this._executeDirectAction('evaluate', {
            expression: 'document.documentElement.outerHTML',
          });
        },
      });
    }
    return strategies;
  }

  _validateSelector(selector) {
    if (!/^[a-zA-Z0-9_\-#. >+~:\[\]="']+$/.test(selector)) {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'Selector contains disallowed characters: ' + selector);
    }
  }

  /**
   * 通过选择器提取数据。在页面中查找匹配选择器的所有元素，
   * 提取其文本内容、链接和标签信息。
   * @param {string} selector - CSS选择器
   * @returns {Promise<Array<{text: string, href: string, tag: string}>>} 提取的数据数组
   * @throws {DeepeningError} selector无效时抛出
   */
  async extractData(selector) {
    this.guardShutdown();
    if (!selector || typeof selector !== 'string') {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'selector must be a non-empty string');
    }
    if (this._mode === BROWSER_USE_MODES.DIRECT) {
      const escapedSelector = selector.replace(/'/g, "\\'");
      const expression = [
        'JSON.stringify(Array.from(document.querySelectorAll(\'',
        escapedSelector,
        '\')).map(function(el){return {text:el.textContent,href:el.href||\'\',tag:el.tagName,}}))',
      ].join('');
      const result = await this._cdp.evaluate(expression);
      if (this._shutDown) return { data: null, error: 'Shut down during extraction' };
      const jsonStr = result && result.result && result.result.value ? result.result.value : '[]';
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        debug('extractData:parse', e);
        return [];
      }
    } else {
      const mcpResult = await this._mcpClient.callTool('mcp_' + this._mcpServerName + '_browser_extract_data', { selector });
      if (this._shutDown) return { data: null, error: 'Shut down during extraction' };
      const content = mcpResult && mcpResult.result && mcpResult.result.content;
      if (Array.isArray(content)) return content;
      if (typeof content === 'string') {
        try { return JSON.parse(content); } catch (e) { debug('extractData:mcpParse', e); return []; }
      }
      return [];
    }
  }

  /**
   * 通过模板提取数据。使用预定义的平台采集模板（小红书/抖音/公众号/Reddit等）
   * 或自定义字段批量提取结构化数据，并自动进行类型转换。
   * @param {string} templateId - 模板ID，对应 DATA_COLLECT_TEMPLATES 中的键
   * @param {Array<Object>} [customFields] - 自定义字段定义数组，为空时使用模板默认字段
   * @returns {Promise<Array<Object>>} 提取的结构化数据数组
   * @throws {DeepeningError} 模板ID不存在时抛出
   */
  async extractByTemplate(templateId, customFields) {
    this.guardShutdown();
    const template = DATA_COLLECT_TEMPLATES[templateId];
    if (!template) {
      throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'Unknown template: ' + templateId + '. Available: ' + Object.keys(DATA_COLLECT_TEMPLATES).join(', '));
    }
    const fields = customFields && customFields.length > 0 ? customFields : template.fields;
    const itemSelector = template.itemSelector;
    if (this._mode === BROWSER_USE_MODES.DIRECT) {
      const fieldMappings = fields.map(function(f) {
        return '"' + f.key + '": (function(){ try { var el = el.querySelector(\'' + f.selector.replace(/'/g, "\\'") + '\'); if (!el) return null; if (\'' + f.attr + '\' === \'textContent\') return el.textContent.trim(); if (\'' + f.attr + '\' === \'src\' || \'' + f.attr + '\' === \'href\') return el.' + f.attr + '; return el.getAttribute(\'' + f.attr + '\'); } catch(e) { return null; } })()';
      }).join(', ');
      const expression = 'JSON.stringify(Array.from(document.querySelectorAll(\'' + itemSelector.replace(/'/g, "\\'") + '\')).map(function(el){ return {' + fieldMappings + '}; }))';
      const result = await this._cdp.evaluate(expression);
      const jsonStr = result && result.result && result.result.value ? result.result.value : '[]';
      try {
        const items = JSON.parse(jsonStr);
        return this._coerceTemplateTypes(items, fields);
      } catch (e) {
        debug('extractByTemplate:parse', e);
        return [];
      }
    } else {
      const mcpResult = await this._mcpClient.callTool('mcp_' + this._mcpServerName + '_browser_extract_data', { selector: itemSelector });
      const content = mcpResult && mcpResult.result && mcpResult.result.content;
      let rawItems;
      if (Array.isArray(content)) {
        rawItems = content;
      } else if (typeof content === 'string') {
        try {
          rawItems = JSON.parse(content);
        } catch (e) {
          debug('extractByTemplate:mcpParse', e);
          rawItems = [];
        }
      } else {
        rawItems = [];
      }
      return this._coerceTemplateTypes(rawItems, fields);
    }
  }

  _coerceTemplateTypes(items, fields) {
    const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const numberFields = {};
    const arrayFields = {};
    fields.forEach(function(f) {
      if (f.type === 'number') numberFields[f.key] = true;
      if (f.type === 'array') arrayFields[f.key] = true;
    });
    return items.map(function(item) {
      if (!item || typeof item !== 'object') return null;
      const result = {};
      Object.keys(item).forEach(function(key) {
        if (DANGEROUS_KEYS.has(key)) return;
        const val = item[key];
        if (numberFields[key] && typeof val === 'string') {
          const num = parseInt(val.replace(/[^\d.-]/g, ''), 10);
          result[key] = Number.isFinite(num) ? num : 0;
        } else if (arrayFields[key] && typeof val === 'string') {
          result[key] = val.split(/[,，\s]+/).filter(Boolean);
        } else {
          result[key] = val;
        }
      });
      return result;
    });
  }

  getCollectTemplates() {
    const result = {};
    Object.keys(DATA_COLLECT_TEMPLATES).forEach(function(id) {
      result[id] = { name: DATA_COLLECT_TEMPLATES[id].name, fields: DATA_COLLECT_TEMPLATES[id].fields.map(function(f) { return f.key; }), itemSelector: DATA_COLLECT_TEMPLATES[id].itemSelector };
    });
    return result;
  }

  /**
   * 截取屏幕截图。通过CDP或MCP模式获取当前页面截图，并缓存到截图缓存中。
   * @param {string} [label] - 截图标签，用于缓存标识，默认为自动生成的时间戳标签
   * @returns {Promise<string|null>} Base64编码的截图数据，关闭期间返回null
   */
  async takeScreenshot(label) {
    this.guardShutdown();
    const screenshotLabel = label || ('screenshot_' + Date.now());
    let data;
    if (this._mode === BROWSER_USE_MODES.DIRECT) {
      data = await this._cdp.screenshot();
    } else {
      const mcpResult = await this._mcpClient.callTool('mcp_' + this._mcpServerName + '_browser_screenshot', {});
      data = mcpResult && mcpResult.result && mcpResult.result.content ? mcpResult.result.content : null;
    }
    if (this._shutDown) return { screenshot: null, error: 'Shut down during screenshot' };
    this._screenshotCache.set(screenshotLabel, { data, timestamp: Date.now() });
    if (this._screenshotCache.size > this._maxScreenshots) {
      const firstKey = this._screenshotCache.keys().next().value;
      this._screenshotCache.delete(firstKey);
    }
    return data;
  }

  getCurrentState() {
    return {
      url: this._currentUrl,
      navigationHistoryLength: this._navigationHistory.length,
      screenshotCacheSize: this._screenshotCache.size,
      stats: safeAssign({}, this._stats),
      mode: this._mode,
      connected: this._isConnected(),
    };
  }

  isHealthy() {
    if (this._shutDown) return false;
    return this._isConnected();
  }

  _isConnected() {
    if (this._mode === BROWSER_USE_MODES.DIRECT) {
      return this._cdp != null && this._cdp.isConnected();
    }
    if (!this._mcpClient) return false;
    const status = this._mcpClient.getServerStatus();
    return !!(status[this._mcpServerName] && status[this._mcpServerName].connected);
  }

  _onShutdown() {
    if (this._mode === BROWSER_USE_MODES.DIRECT && this._cdp) {
      safeCall(() => this._cdp.shutdown(), 'BrowserUseAdapter', 'shutdown:cdp');
    }
    this._navigationHistory = [];
    this._screenshotCache.clear();
    this._selfHealingLog = [];
    this._stats = { totalCommands: 0, successfulCommands: 0, failedCommands: 0, selfHealingCount: 0 };
    this._currentUrl = null;
    this._cdp = null;
    this._mcpClient = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(BrowserUseAdapter);
Object.assign(module.exports, {
  BROWSER_USE_MODES,
  SELF_HEALING_STRATEGIES,
  DEFAULT_CDP_OPTIONS,
  DATA_COLLECT_TEMPLATES,
});
