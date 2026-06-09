/**
 * @module runtime/infrastructure/service-fs
 * @description 服务虚拟文件系统模块。提供类文件系统的挂载机制，将不同服务的适配器统一挂载到虚拟路径下，
 * 通过标准化的文件操作接口（list/read/write/remove/exists）访问各服务资源。
 * 支持路径解析、目录树生成、操作统计和优雅关闭等功能。
 */
'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { HarnessError } = require('../../errors');
const { mergeConfig } = require('../../utils/safe-assign');

/**
 * @constant {Object} DEFAULT_CONFIG
 * @description ServiceFS 默认配置项。
 * @property {string} mountPrefix - 挂载路径前缀，所有服务路径必须以此开头
 * @property {number} maxMounts - 最大挂载数量限制
 * @property {number} pathMaxLength - 路径最大长度限制
 */
const DEFAULT_CONFIG = {
  mountPrefix: '/services/',
  maxMounts: 20,
  pathMaxLength: 512,
};

/**
 * @constant {string[]} VALID_ADAPTER_METHODS
 * @description 适配器必须实现的接口方法名称列表。每个适配器对象必须包含 list、read、write、remove、exists 五个方法。
 */
const VALID_ADAPTER_METHODS = ['list', 'read', 'write', 'remove', 'exists'];

/**
 * 基于内存的适配器实现。使用 Map 存储键值对数据，提供类文件系统的 CRUD 操作。
 * 适用于测试场景或临时数据存储，数据仅在进程生命周期内有效。
 * @classdesc 内存文件系统适配器，提供基于内存的虚拟文件系统操作接口
 */
class MemoryAdapter {
  /**
   * 创建 MemoryAdapter 实例，初始化内部 Map 存储。
   */
  constructor() {
    this._store = new Map();
  }

  /**
   * 列出指定路径下的条目。支持目录层级浏览，返回文件和目录的元数据。
   * @param {string} [path=''] - 要列出的目录路径，为空时列出根级条目
   * @returns {Array<{name: string, type: 'file'|'dir', size?: number, modified?: number}>} 条目数组，文件条目包含 size 和 modified 字段
   */
  list(path) {
    const prefix = path ? path + '/' : '';
    const entries = new Map();
    for (const key of this._store.keys()) {
      if (prefix && !key.startsWith(prefix)) continue;
      if (!prefix && key.includes('/')) continue;
      const remaining = prefix ? key.slice(prefix.length) : key;
      if (remaining.length === 0) continue;
      const slashIdx = remaining.indexOf('/');
      if (slashIdx === -1) {
        const content = this._store.get(key);
        entries.set(remaining, { name: remaining, type: 'file', size: content ? content.length : 0, modified: Date.now() });
      } else {
        const dirName = remaining.slice(0, slashIdx);
        if (!entries.has(dirName)) {
          entries.set(dirName, { name: dirName, type: 'dir' });
        }
      }
    }
    return Array.from(entries.values());
  }

  /**
   * 读取指定路径的文件内容。
   * @param {string} path - 文件路径
   * @returns {string} 文件内容字符串
   * @throws {HarnessError} 当路径不存在时抛出 RESOURCE_NOT_FOUND 错误
   */
  read(path) {
    if (!this._store.has(path)) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Not found: ' + path);
    }
    return this._store.get(path);
  }

  /**
   * 写入内容到指定路径。内容会被强制转换为字符串。
   * @param {string} path - 文件路径
   * @param {*} content - 要写入的内容，将调用 String() 转换
   * @returns {boolean} 始终返回 true
   */
  write(path, content) {
    this._store.set(path, String(content));
    return true;
  }

  /**
   * 删除指定路径及其子路径下的所有条目。
   * @param {string} path - 要删除的文件或目录路径
   * @returns {boolean} 如果有任何条目被删除则返回 true，否则返回 false
   */
  remove(path) {
    const prefix = path + '/';
    let removed = false;
    if (this._store.has(path)) {
      this._store.delete(path);
      removed = true;
    }
    const keysToDelete = [];
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this._store.delete(key);
      removed = true;
    }
    return removed;
  }

  /**
   * 检查指定路径是否存在。同时检查文件本身和以其为前缀的子路径。
   * @param {string} path - 要检查的路径
   * @returns {boolean} 路径存在返回 true，否则返回 false
   */
  exists(path) {
    if (this._store.has(path)) return true;
    const prefix = path + '/';
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
}

/**
 * @classdesc 服务虚拟文件系统。多服务适配器统一挂载到虚拟路径
 * 服务虚拟文件系统。将不同服务的适配器统一挂载到虚拟路径下，提供类文件系统的操作接口。
 * 继承 EventEmitter，在挂载、卸载、读写等操作时触发相应事件。
 * 集成 withShutdown 混入，支持优雅关闭时自动清理资源。
 * @extends EventEmitter
 */
class ServiceFS extends EventEmitter {
  /**
   * 创建 ServiceFS 实例。
   * @param {Object} [config={}] - 配置项，将与 DEFAULT_CONFIG 合并
   * @param {string} [config.mountPrefix='/services/'] - 挂载路径前缀
   * @param {number} [config.maxMounts=20] - 最大挂载数量
   * @param {number} [config.pathMaxLength=512] - 路径最大长度
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._mounts = new Map();
    this._tree = {};
    this._stats = { mounts: 0, unmounts: 0, reads: 0, writes: 0, deletes: 0, lists: 0, copies: 0, greps: 0 };
  }

  /**
   * 挂载服务适配器到虚拟文件系统。适配器必须实现 list、read、write、remove、exists 五个方法。
   * @param {string} serviceName - 服务名称，必须为非空字符串且不能与已挂载服务重复
   * @param {Object} adapter - 服务适配器对象，须实现 VALID_ADAPTER_METHODS 中定义的所有方法
   * @param {Function} adapter.list - 列出目录条目方法
   * @param {Function} adapter.read - 读取文件内容方法
   * @param {Function} adapter.write - 写入文件内容方法
   * @param {Function} adapter.remove - 删除文件或目录方法
   * @param {Function} adapter.exists - 检查路径是否存在方法
   * @returns {ServiceFS} 返回 this 以支持链式调用
   * @throws {HarnessError} serviceName 为空或非字符串时抛出 INVALID_INPUT 错误
   * @throws {HarnessError} adapter 缺少必要方法时抛出 INVALID_INPUT 错误
   * @throws {HarnessError} 服务已挂载时抛出 INVALID_STATE 错误
   * @throws {HarnessError} 超过最大挂载数量时抛出 CAPACITY_EXCEEDED 错误
   * @fires ServiceFS#mounted
   */
  mount(serviceName, adapter) {
    this.guardShutdown();
    if (!serviceName || typeof serviceName !== 'string') {
      throw new HarnessError('INVALID_INPUT', 'serviceName must be a non-empty string');
    }
    if (!adapter || typeof adapter !== 'object') {
      throw new HarnessError('INVALID_INPUT', 'adapter must be an object');
    }
    for (const method of VALID_ADAPTER_METHODS) {
      if (typeof adapter[method] !== 'function') {
        throw new HarnessError('INVALID_INPUT', 'adapter missing required method: ' + method);
      }
    }
    if (this._mounts.has(serviceName)) {
      throw new HarnessError('INVALID_STATE', 'Service already mounted: ' + serviceName);
    }
    if (this._mounts.size >= this._config.maxMounts) {
      throw new HarnessError('CAPACITY_EXCEEDED', 'Max mounts reached (' + this._config.maxMounts + ')');
    }
    this._mounts.set(serviceName, adapter);
    this._tree[serviceName] = { type: 'dir', name: serviceName };
    this._stats.mounts++;
    this.emit('mounted', { serviceName });
    debug('ServiceFS', 'mount', serviceName);
    return this;
  }

  /**
   * 从 MCPClient 自动挂载服务。将 MCPClient 发现的工具转换为文件系统适配器并挂载。
   * 每个工具被映射为一个虚拟文件，工具名称为文件名，工具描述为文件内容。
   * @param {string} serviceName - 服务名称，用于虚拟路径挂载
   * @param {Object} mcpClient - MCPClient 实例，用于发现和调用工具
   * @param {Object} [options={}] - 挂载选项
   * @param {string} [options.toolPrefix] - 仅挂载名称以此前缀开头的工具
   * @returns {ServiceFS} 返回 this 以支持链式调用
   * @throws {HarnessError} serviceName 已挂载时抛出 INVALID_STATE 错误
   * @fires ServiceFS#mounted
   */
  mountFromMCP(serviceName, mcpClient, options) {
    this.guardShutdown();
    const opts = Object.assign({}, options);
    for (const key of Object.keys(opts)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') delete opts[key];
    }
    if (this._mounts.has(serviceName)) {
      throw new HarnessError('INVALID_STATE', 'Service already mounted: ' + serviceName);
    }
    const tools = mcpClient.getAvailableTools();
    const filtered = opts.toolPrefix
      ? tools.filter(function(t) { return t.name.startsWith(opts.toolPrefix); })
      : tools;
    const store = new Map();
    for (const tool of filtered) {
      const toolName = opts.toolPrefix ? tool.name.slice(opts.toolPrefix.length) : tool.name;
      store.set(toolName, JSON.stringify({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema ?? {},
      }, null, 2));
    }
    const adapter = this._createMapAdapter(store, mcpClient, serviceName, opts.toolPrefix);
    return this.mount(serviceName, adapter);
  }

  /**
   * 从 Map 存储创建适配器，支持工具调用（write 操作触发 MCP 工具调用）。
   * @param {Map} store - 键值对存储
   * @param {Object} mcpClient - MCPClient 实例
   * @param {string} serviceName - 服务名称
   * @param {string} [toolPrefix] - 工具名称前缀
   * @returns {Object} 适配器对象，实现 list/read/write/remove/exists 五个方法
   * @private
   */
  _createMapAdapter(store, mcpClient, serviceName, toolPrefix) {
    return {
      list: function(path) {
        const prefix = path ? path + '/' : '';
        const entries = new Map();
        for (const key of store.keys()) {
          if (prefix && !key.startsWith(prefix)) continue;
          if (!prefix && key.includes('/')) continue;
          const remaining = prefix ? key.slice(prefix.length) : key;
          if (remaining.length === 0) continue;
          const slashIdx = remaining.indexOf('/');
          if (slashIdx === -1) {
            const content = store.get(key);
            entries.set(remaining, { name: remaining, type: 'file', size: content ? content.length : 0, modified: Date.now() });
          } else {
            const dirName = remaining.slice(0, slashIdx);
            if (!entries.has(dirName)) entries.set(dirName, { name: dirName, type: 'dir' });
          }
        }
        return Array.from(entries.values());
      },
      read: function(path) {
        if (!store.has(path)) throw new HarnessError('RESOURCE_NOT_FOUND', 'Not found: ' + path);
        return store.get(path);
      },
      write: function(path, content) {
        const fullToolName = toolPrefix ? toolPrefix + path : path;
        try {
          const args = typeof content === 'string' ? JSON.parse(content) : content;
          mcpClient.callTool(fullToolName, args).then(function(result) {
            store.set(path, JSON.stringify(result, null, 2));
          }).catch(function(err) { debug('ServiceFS', 'callTool-error', err && err.message ? err.message : String(err)); });
        } catch (_e) {
          store.set(path, String(content));
        }
        return true;
      },
      remove: function(path) {
        return store.delete(path);
      },
      exists: function(path) {
        return store.has(path);
      },
    };
  }

  /**
   * 卸载指定服务。移除该服务的适配器挂载并清理内部目录树。
   * @param {string} serviceName - 要卸载的服务名称
   * @returns {boolean} 卸载成功返回 true，服务不存在时返回 false
   * @fires ServiceFS#unmounted
   */
  unmount(serviceName) {
    this.guardShutdown();
    if (!this._mounts.has(serviceName)) {
      return false;
    }
    this._mounts.delete(serviceName);
    delete this._tree[serviceName];
    this._stats.unmounts++;
    this.emit('unmounted', { serviceName });
    debug('ServiceFS', 'unmount', serviceName);
    return true;
  }

  /**
   * 解析虚拟路径，提取服务名称和适配器内部路径。同时进行路径合法性校验和路径遍历攻击防护。
   * @param {string} path - 要解析的虚拟路径，必须以 mountPrefix 开头
   * @returns {{serviceName: string, adapterPath: string}} 解析结果，serviceName 为服务名称，adapterPath 为适配器内部路径
   * @throws {HarnessError} 路径为空、超长、前缀不匹配或包含路径遍历时抛出 INVALID_INPUT 错误
   */
  resolve(path) {
    if (!path || typeof path !== 'string') {
      throw new HarnessError('INVALID_INPUT', 'path must be a non-empty string');
    }
    if (path.length > this._config.pathMaxLength) {
      throw new HarnessError('INVALID_INPUT', 'Path exceeds max length (' + this._config.pathMaxLength + ')');
    }
    const prefix = this._config.mountPrefix;
    if (!path.startsWith(prefix)) {
      throw new HarnessError('INVALID_INPUT', 'Path must start with ' + prefix);
    }
    const withoutPrefix = path.slice(prefix.length);
    if (!withoutPrefix) {
      throw new HarnessError('INVALID_INPUT', 'Path must include a service name');
    }
    const slashIdx = withoutPrefix.indexOf('/');
    const serviceName = slashIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, slashIdx);
    const adapterPath = slashIdx === -1 ? '' : withoutPrefix.slice(slashIdx + 1);
    if (adapterPath.includes('..')) {
      throw new HarnessError('INVALID_INPUT', 'Path traversal detected');
    }
    return { serviceName, adapterPath };
  }

  /**
   * 列出指定路径下的目录条目。
   * @param {string} path - 虚拟路径，必须以 mountPrefix 开头并包含服务名称
   * @returns {Array<{name: string, type: string}>} 条目数组
   * @throws {HarnessError} 服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   * @fires ServiceFS#listed
   */
  ls(path) {
    this.guardShutdown();
    const { serviceName, adapterPath } = this.resolve(path);
    const adapter = this._mounts.get(serviceName);
    if (!adapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not mounted: ' + serviceName);
    }
    this._stats.lists++;
    const entries = adapter.list(adapterPath);
    this.emit('listed', { serviceName, path: adapterPath, count: entries.length });
    return entries;
  }

  /**
   * 读取指定路径的文件内容。
   * @param {string} path - 文件虚拟路径，必须包含服务名称和文件路径
   * @returns {string} 文件内容
   * @throws {HarnessError} 服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   * @throws {HarnessError} 路径未指定文件时抛出 INVALID_INPUT 错误
   * @fires ServiceFS#read
   */
  cat(path) {
    this.guardShutdown();
    const { serviceName, adapterPath } = this.resolve(path);
    const adapter = this._mounts.get(serviceName);
    if (!adapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not mounted: ' + serviceName);
    }
    if (!adapterPath) {
      throw new HarnessError('INVALID_INPUT', 'cat requires a file path');
    }
    this._stats.reads++;
    const content = adapter.read(adapterPath);
    this.emit('read', { serviceName, path: adapterPath });
    return content;
  }

  /**
   * 写入内容到指定路径的文件。
   * @param {string} path - 文件虚拟路径，必须包含服务名称和文件路径
   * @param {*} content - 要写入的内容
   * @returns {*} 适配器 write 方法的返回值
   * @throws {HarnessError} 服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   * @throws {HarnessError} 路径未指定文件时抛出 INVALID_INPUT 错误
   * @fires ServiceFS#written
   */
  write(path, content) {
    this.guardShutdown();
    const { serviceName, adapterPath } = this.resolve(path);
    const adapter = this._mounts.get(serviceName);
    if (!adapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not mounted: ' + serviceName);
    }
    if (!adapterPath) {
      throw new HarnessError('INVALID_INPUT', 'write requires a file path');
    }
    this._stats.writes++;
    const result = adapter.write(adapterPath, content);
    this.emit('written', { serviceName, path: adapterPath });
    debug('ServiceFS', 'write', serviceName + '/' + adapterPath);
    return result;
  }

  /**
   * 删除指定路径的文件或目录。
   * @param {string} path - 要删除的资源虚拟路径，必须包含服务名称和文件路径
   * @returns {*} 适配器 remove 方法的返回值
   * @throws {HarnessError} 服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   * @throws {HarnessError} 路径未指定文件时抛出 INVALID_INPUT 错误
   * @fires ServiceFS#removed
   */
  rm(path) {
    this.guardShutdown();
    const { serviceName, adapterPath } = this.resolve(path);
    const adapter = this._mounts.get(serviceName);
    if (!adapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not mounted: ' + serviceName);
    }
    if (!adapterPath) {
      throw new HarnessError('INVALID_INPUT', 'rm requires a path');
    }
    this._stats.deletes++;
    const result = adapter.remove(adapterPath);
    this.emit('removed', { serviceName, path: adapterPath });
    debug('ServiceFS', 'rm', serviceName + '/' + adapterPath);
    return result;
  }

  /**
   * 跨服务复制文件。将源路径的文件内容读取后写入目标路径，支持同一服务内复制和跨服务复制。
   * @param {string} srcPath - 源文件虚拟路径
   * @param {string} destPath - 目标文件虚拟路径
   * @returns {boolean} 复制成功返回 true
   * @throws {HarnessError} 源服务或目标服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   * @throws {HarnessError} 源路径或目标路径未指定文件时抛出 INVALID_INPUT 错误
   * @fires ServiceFS#copied
   */
  cp(srcPath, destPath) {
    this.guardShutdown();
    const src = this.resolve(srcPath);
    const dest = this.resolve(destPath);
    const srcAdapter = this._mounts.get(src.serviceName);
    if (!srcAdapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Source service not mounted: ' + src.serviceName);
    }
    const destAdapter = this._mounts.get(dest.serviceName);
    if (!destAdapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Destination service not mounted: ' + dest.serviceName);
    }
    if (!src.adapterPath) {
      throw new HarnessError('INVALID_INPUT', 'cp requires a source file path');
    }
    if (!dest.adapterPath) {
      throw new HarnessError('INVALID_INPUT', 'cp requires a destination file path');
    }
    const content = srcAdapter.read(src.adapterPath);
    destAdapter.write(dest.adapterPath, content);
    this._stats.reads++;
    this._stats.writes++;
    this._stats.copies++;
    this.emit('copied', { srcService: src.serviceName, srcPath: src.adapterPath, destService: dest.serviceName, destPath: dest.adapterPath });
    debug('ServiceFS', 'cp', src.serviceName + '/' + src.adapterPath + ' -> ' + dest.serviceName + '/' + dest.adapterPath);
    return true;
  }

  /**
   * 在指定路径下搜索包含指定模式的文件内容。支持字符串匹配和正则表达式匹配。
   * @param {string|RegExp} pattern - 搜索模式，字符串时进行包含匹配，RegExp时进行正则匹配
   * @param {string} path - 虚拟路径，指定要搜索的服务和目录
   * @param {Object} [options={}] - 搜索选项
   * @param {boolean} [options.recursive=true] - 是否递归搜索子目录
   * @param {number} [options.maxResults=100] - 最大返回结果数
   * @returns {Array<{path: string, line: number, content: string, match: string}>} 匹配结果数组
   * @throws {HarnessError} 服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   * @fires ServiceFS#grepped
   */
  grep(pattern, path, options) {
    this.guardShutdown();
    const opts = Object.assign({ recursive: true, maxResults: 100 }, options);
    const { serviceName, adapterPath } = this.resolve(path);
    const adapter = this._mounts.get(serviceName);
    if (!adapter) {
      throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not mounted: ' + serviceName);
    }
    const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const results = [];
    this._grepRecursive(adapter, adapterPath, regex, opts, serviceName, results);
    this._stats.reads += results.length;
    this._stats.greps++;
    this.emit('grepped', { serviceName, path: adapterPath, pattern: String(pattern), matchCount: results.length });
    return results;
  }

  /**
   * 递归搜索文件内容。遍历目录树，读取每个文件并搜索匹配行。
   * @param {Object} adapter - 服务适配器实例
   * @param {string} adapterPath - 适配器内部路径
   * @param {RegExp} regex - 搜索正则表达式
   * @param {Object} opts - 搜索选项
   * @param {string} serviceName - 服务名称（用于结果路径构建）
   * @param {Array} results - 结果累加数组
   * @param {number} [depth=0] - 当前递归深度
   * @private
   */
  _grepRecursive(adapter, adapterPath, regex, opts, serviceName, results, depth) {
    if (depth == null) depth = 0;
    if (depth > 20 || results.length >= opts.maxResults) return;
    const entries = adapter.list(adapterPath);
    for (const entry of entries) {
      if (results.length >= opts.maxResults) break;
      const entryPath = adapterPath ? adapterPath + '/' + entry.name : entry.name;
      if (entry.type === 'dir') {
        if (opts.recursive) {
          this._grepRecursive(adapter, entryPath, regex, opts, serviceName, results, depth + 1);
        }
      } else {
        try {
          const content = adapter.read(entryPath);
          if (typeof content !== 'string') continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= opts.maxResults) break;
            const match = lines[i].match(regex);
            if (match) {
              results.push({
                path: this._config.mountPrefix + serviceName + '/' + entryPath,
                line: i + 1,
                content: lines[i].slice(0, 500),
                match: match[0],
              });
            }
          }
        } catch (_e) {
          // Skip unreadable files
        }
      }
    }
  }

  /**
   * 检查指定路径是否存在。服务未挂载时返回 false，路径仅指向服务根目录时返回 true。
   * @param {string} path - 要检查的虚拟路径
   * @returns {boolean} 路径存在返回 true，否则返回 false
   */
  exists(path) {
    this.guardShutdown();
    const { serviceName, adapterPath } = this.resolve(path);
    const adapter = this._mounts.get(serviceName);
    if (!adapter) {
      return false;
    }
    if (!adapterPath) {
      return true;
    }
    return adapter.exists(adapterPath);
  }

  /**
   * 生成目录树的可视化字符串表示。支持指定路径的子树或全量目录树。
   * 目录排在前面，文件排在后面，同类型按名称排序。
   * @param {string} [path] - 虚拟路径，指定时仅生成该服务下的子树；省略时生成全量目录树
   * @param {number} [depth=10] - 最大递归深度，默认为 10
   * @returns {string} 树形结构的字符串表示
   * @throws {HarnessError} 指定路径对应的服务未挂载时抛出 RESOURCE_NOT_FOUND 错误
   */
  tree(path, depth) {
    this.guardShutdown();
    const maxDepth = depth != null ? Math.max(0, Math.floor(depth)) : 10;
    if (path) {
      const { serviceName, adapterPath } = this.resolve(path);
      const adapter = this._mounts.get(serviceName);
      if (!adapter) {
        throw new HarnessError('RESOURCE_NOT_FOUND', 'Service not mounted: ' + serviceName);
      }
      return this._buildTree(adapter, adapterPath, serviceName, maxDepth, 0);
    }
    const lines = [];
    lines.push(this._config.mountPrefix);
    const serviceNames = Array.from(this._mounts.keys()).sort();
    for (let i = 0; i < serviceNames.length; i++) {
      const name = serviceNames[i];
      const isLast = i === serviceNames.length - 1;
      const prefix = isLast ? '└── ' : '├── ';
      lines.push(prefix + name + '/');
      const adapter = this._mounts.get(name);
      const subtree = this._buildTree(adapter, '', name, maxDepth, 0);
      const childPrefix = isLast ? '    ' : '│   ';
      const childLines = subtree.split('\n').filter(l => l.length > 0);
      for (const line of childLines) {
        lines.push(childPrefix + line);
      }
    }
    return lines.join('\n');
  }

  /**
   * 递归构建目录树字符串。目录排在前面，文件排在后面，同类型按名称排序。
   * @private
   * @param {Object} adapter - 服务适配器实例
   * @param {string} adapterPath - 适配器内部路径
   * @param {string} serviceName - 服务名称
   * @param {number} maxDepth - 最大递归深度
   * @param {number} currentDepth - 当前递归深度
   * @returns {string} 目录树的字符串表示
   */
  _buildTree(adapter, adapterPath, serviceName, maxDepth, currentDepth) {
    if (currentDepth >= maxDepth) return '';
    const entries = adapter.list(adapterPath);
    if (entries.length === 0) return '';
    const lines = [];
    const sorted = entries.slice().sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === 'dir') return -1;
        if (b.type === 'dir') return 1;
        return a.type.localeCompare(b.type, 'en');
      }
      return a.name.localeCompare(b.name, 'en');
    });
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const prefix = isLast ? '└── ' : '├── ';
      const suffix = entry.type === 'dir' ? '/' : '';
      lines.push(prefix + entry.name + suffix);
      if (entry.type === 'dir' && currentDepth + 1 < maxDepth) {
        const childPath = adapterPath ? adapterPath + '/' + entry.name : entry.name;
        const subtree = this._buildTree(adapter, childPath, serviceName, maxDepth, currentDepth + 1);
        const childPrefix = isLast ? '    ' : '│   ';
        const childLines = subtree.split('\n').filter(l => l.length > 0);
        for (const line of childLines) {
          lines.push(childPrefix + line);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * 获取文件系统的操作统计信息。
   * @returns {{mountCount: number, maxMounts: number, services: string[], operations: {mounts: number, unmounts: number, reads: number, writes: number, deletes: number, lists: number, copies: number, greps: number}}} 统计信息对象
   */
  getStats() {
    return {
      mountCount: this._mounts.size,
      maxMounts: this._config.maxMounts,
      services: Array.from(this._mounts.keys()),
      operations: {
        mounts: this._stats.mounts,
        unmounts: this._stats.unmounts,
        reads: this._stats.reads,
        writes: this._stats.writes,
        deletes: this._stats.deletes,
        lists: this._stats.lists,
        copies: this._stats.copies,
        greps: this._stats.greps,
      },
    };
  }

  /**
   * 优雅关闭回调。清空所有挂载、目录树和统计数据。
   * @private
   */
  _onShutdown() {
    this._mounts.clear();
    this._tree = {};
    this._stats = { mounts: 0, unmounts: 0, reads: 0, writes: 0, deletes: 0, lists: 0, copies: 0, greps: 0 };
    debug('ServiceFS', 'shutdown', 'cleaned up');
    this.removeAllListeners();
  }
}

/**
 * @static
 * @member {Object} DEFAULT_CONFIG - 默认配置项引用
 */
ServiceFS.DEFAULT_CONFIG = DEFAULT_CONFIG;
/**
 * @static
 * @member {typeof MemoryAdapter} MemoryAdapter - MemoryAdapter 类引用，便于外部直接使用
 */
ServiceFS.MemoryAdapter = MemoryAdapter;

module.exports = withShutdown(ServiceFS);
