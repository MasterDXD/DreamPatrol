/**
 * @module runtime/tui/quick-command-registry
 * @description 快速命令注册表，提供Shell命令的注册、解析与危险模式检测。
 * 支持命令别名、确认要求、自动补全，以及从配置文件批量加载。
 *
 * 架构角色：TUI子系统的命令扩展层，为REPLEngine提供非斜杠命令的快捷入口。
 *
 * 11个危险模式检测：
 * | #  | 模式                        | 检测目标                          |
 * |----|----------------------------|-----------------------------------|
 * | 1  | `rm -rf /`                 | 递归强制删除根目录                |
 * | 2  | `del /S C:\`               | Windows递归删除                   |
 * | 3  | `format C:`                | Windows格式化磁盘                 |
 * | 4  | `> /dev/`                  | 重定向到设备文件                  |
 * | 5  | `\| sh`                    | 管道注入Shell                     |
 * | 6  | `\| bash`                  | 管道注入Bash                     |
 * | 7  | `curl ... \| sh`           | 远程代码执行（curl管道）          |
 * | 8  | `wget ... \| sh`           | 远程代码执行（wget管道）          |
 * | 9  | `mkfs`                     | 文件系统格式化                    |
 * | 10 | `dd if=`                   | 磁盘镜像写入                      |
 * | 11 | `:(){ :|:& }`              | Fork炸弹                          |
 *
 * 集成点：
 * - 由 {@link module:tui-orchestrator|TUIOrchestrator} 创建和管理
 * - 通过 loadFromConfig 从 .harness/config.json 的 quick_commands 字段加载
 * - 命令ID不得以 / 开头（与斜杠命令命名空间隔离）
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

const MAX_COMMANDS = 50;
const SAFE_COMMAND_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.\- ]*$/;
const DANGEROUS_PATTERNS = Object.freeze([
  /rm\s+-rf\s+\//,
  /del\s+\/[sS]\s+[cC]:\\/i,
  /format\s+[cC]:/i,
  />\s*\/dev\//,
  /\|\s*sh\b/,
  /\|\s*bash\b/,
  /curl\s+.*\|\s*sh/,
  /wget\s+.*\|\s*sh/,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\{\s*:\|:\&\s*\}/,
]);

/**
 * 快速命令注册表。管理Shell快捷命令的注册、别名映射、危险模式检测和自动补全。
 * 命令存储在BoundedMap中（上限50条），ID必须匹配安全正则且不以/开头。
 * 注册时自动检测11种危险Shell模式，匹配则拒绝并触发command:rejected事件。
 *
 * @classdesc 快速命令注册表。斜杠命令快捷注册、别名管理、模糊匹配
 *
 * @class
 * @extends EventEmitter
 * @fires QuickCommandRegistry#command:registered
 * @fires QuickCommandRegistry#command:unregistered
 * @fires QuickCommandRegistry#command:rejected
 *
 * @param {Object} [options] - 配置选项（当前未使用，保留扩展）
 *
 * @example
 * const registry = new QuickCommandRegistry();
 * registry.on('command:rejected', (data) => {
 *   console.warn(`命令 ${data.id} 被拒绝: ${data.reason}`);
 * });
 * registry.register('build', 'npm run build', { description: '构建项目' });
 * registry.register('test', 'npm test', { alias: 't', confirmRequired: true });
 * const cmd = registry.resolve('t');
 * // cmd.alias === 't', cmd.command === 'npm test'
 */
class QuickCommandRegistry extends EventEmitter {
  constructor(options) {
    super();
    this._options = options ?? {};
    this._commands = new BoundedMap(MAX_COMMANDS, {
      onEvict: (key) => {
        // BoundedMap淘汰命令时，同步清理别名索引
        for (const [alias, cmdId] of this._aliasIndex) {
          if (cmdId === key) this._aliasIndex.delete(alias);
        }
      },
    });
    this._aliasIndex = new Map();
  }

  /**
   * 注册快速命令。执行ID安全校验和命令危险模式检测。
   * ID必须匹配SAFE_COMMAND_RE且不以/开头，命令不得匹配DANGEROUS_PATTERNS。
   *
   * @param {string} id - 命令标识（匹配 /^[a-zA-Z0-9_][a-zA-Z0-9_.\- ]*$/，长度≤64，不以/开头）
   * @param {string} command - 要执行的Shell命令
   * @param {Object} [options] - 注册选项
   * @param {string} [options.description=''] - 命令描述
   * @param {string|null} [options.alias=null] - 命令别名
   * @param {boolean} [options.confirmRequired=false] - 是否需要执行前确认
   * @fires QuickCommandRegistry#command:registered
   * @fires QuickCommandRegistry#command:rejected
   * @returns {boolean} 注册是否成功
   *
   * @example
   * registry.register('deploy', 'npm run deploy', {
   *   description: '部署到生产环境',
   *   alias: 'd',
   *   confirmRequired: true,
   * });
   *
   * registry.register('danger', 'rm -rf /');
   * // 返回 false，触发 command:rejected 事件
   */
  register(id, command, options) {
    this.guardShutdown();
    if (!id || typeof id !== 'string') return false;
    if (!command || typeof command !== 'string') return false;
    if (id.length > 64) return false;
    if (!SAFE_COMMAND_RE.test(id)) return false;
    if (id.startsWith('/')) return false;
    if (this._commands.size >= MAX_COMMANDS && !this._commands.has(id)) {
      this.emit('command:rejected', { id, reason: 'capacity_exceeded' });
      return false;
    }

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        this.emit('command:rejected', { id, reason: 'dangerous_pattern' });
        return false;
      }
    }

    const entry = {
      id,
      command,
      description: (options && options.description) ?? '',
      alias: (options && options.alias) ?? null,
      confirmRequired: (options && options.confirmRequired) ?? false,
      registeredAt: Date.now(),
    };

    this._commands.set(id, entry);
    if (entry.alias) {
      this._aliasIndex.set(entry.alias, id);
    }
    this.emit('command:registered', { id, command });
    return true;
  }

  /**
   * 注销快速命令。
   *
   * @param {string} id - 命令标识
   * @fires QuickCommandRegistry#command:unregistered
   * @returns {boolean} 注销是否成功
   */
  unregister(id) {
    this.guardShutdown();
    if (!this._commands.has(id)) return false;
    const entry = this._commands.get(id);
    if (entry && entry.alias) {
      this._aliasIndex.delete(entry.alias);
    }
    this._commands.delete(id);
    this.emit('command:unregistered', { id });
    return true;
  }

  /**
   * 解析输入为已注册的命令。先按ID精确匹配，再按别名匹配。
   *
   * @param {string} input - 用户输入的命令名或别名
   * @returns {Object|null} 命令条目对象，未找到返回null
   *
   * @example
   * const cmd = registry.resolve('build');
   * // { id: 'build', command: 'npm run build', description: '...', ... }
   * const aliasCmd = registry.resolve('t');
   * // 通过别名 't' 解析到 test 命令
   */
  resolve(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();

    if (this._commands.has(trimmed)) {
      return this._commands.get(trimmed);
    }

    const aliasTarget = this._aliasIndex.get(trimmed);
    if (aliasTarget && this._commands.has(aliasTarget)) {
      return this._commands.get(aliasTarget);
    }

    return null;
  }

  /**
   * 检查输入是否为已注册的快速命令。
   *
   * @param {string} input - 用户输入
   * @returns {boolean} 是否为快速命令
   */
  isQuickCommand(input) {
    return this.resolve(input) !== null;
  }

  /**
   * 列出所有已注册的快速命令。
   *
   * @returns {Array<{id: string, command: string, description: string, alias: string|null, confirmRequired: boolean}>} 命令列表
   */
  listCommands() {
    const result = [];
    for (const [, cmd] of this._commands.entries()) {
      result.push({
        id: cmd.id,
        command: cmd.command,
        description: cmd.description,
        alias: cmd.alias,
        confirmRequired: cmd.confirmRequired,
      });
    }
    return result;
  }

  /**
   * 从配置对象批量加载快速命令。支持 quick_commands 和 quickCommands 两种键名。
   *
   * @param {Object} config - 配置对象
   * @param {Array<Object>} [config.quick_commands] - 命令数组（snake_case键名）
   * @param {Array<Object>} [config.quickCommands] - 命令数组（camelCase键名）
   * @returns {number} 成功加载的命令数量
   *
   * @example
   * const loaded = registry.loadFromConfig({
   *   quick_commands: [
   *     { id: 'build', command: 'npm run build', description: '构建' },
   *     { id: 'test', command: 'npm test', alias: 't' },
   *   ]
   * });
   * console.log(`加载了 ${loaded} 个命令`);
   */
  loadFromConfig(config) {
    this.guardShutdown();
    if (!config || typeof config !== 'object') return 0;
    const quickCommands = config.quick_commands ?? config.quickCommands;
    if (!Array.isArray(quickCommands)) return 0;

    let loaded = 0;
    for (const entry of quickCommands) {
      if (entry && entry.id && entry.command) {
        if (this.register(entry.id, entry.command, {
          description: entry.description,
          alias: entry.alias,
          confirmRequired: entry.confirmRequired,
        })) {
          loaded++;
        }
      }
    }
    return loaded;
  }

  /**
   * 基于部分输入自动补全命令。同时匹配ID和别名的前缀。
   *
   * @param {string} partial - 部分命令字符串
   * @returns {Array<{id: string, command: string, description: string, alias?: string}>} 匹配的命令列表
   *
   * @example
   * registry.complete('bu');
   * // [{ id: 'build', command: 'npm run build', description: '构建项目' }]
   */
  complete(partial) {
    if (!partial || typeof partial !== 'string') return [];
    const prefix = partial.toLowerCase();
    const matches = [];
    const seen = new Set();
    for (const [id, cmd] of this._commands.entries()) {
      if (id.toLowerCase().startsWith(prefix)) {
        matches.push({ id: cmd.id, command: cmd.command, description: cmd.description });
        seen.add(id);
      }
      if (cmd.alias && cmd.alias.toLowerCase().startsWith(prefix) && !seen.has(id)) {
        matches.push({ id: cmd.id, command: cmd.command, alias: cmd.alias, description: cmd.description });
        seen.add(id);
      }
    }
    return matches;
  }

  /**
   * 优雅关闭回调。清空所有已注册命令。
   * 由withShutdown混入自动调用。
   *
   * @returns {void}
   * @private
   */
  _onShutdown() {
    safeCall(() => this._commands.shutdown(), 'QuickCommandRegistry', 'shutdown-commands');
    this._aliasIndex.clear();
    this.removeAllListeners();
  }

  /**
   * 获取快速命令注册表统计信息。
   *
   * @returns {Object} 统计快照
   * @returns {number} returns.totalCommands - 已注册命令数
   * @returns {number} returns.maxCommands - 最大命令容量
   */
  getStats() {
    return {
      totalCommands: this._commands.size,
      maxCommands: MAX_COMMANDS,
    };
  }
}

QuickCommandRegistry.DANGEROUS_PATTERNS = DANGEROUS_PATTERNS;

module.exports = withShutdown(QuickCommandRegistry);
