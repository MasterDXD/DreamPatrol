'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { parseArray, validateProjectRoot, HARNESS_DIR, PHASES, PHASE_INDEX } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { DeepeningError } = require('../../errors');
const { scanMarkdownDirSync, scanMarkdownDirAsync, parseMarkdownFile, parseMarkdownFileAsync } = require('../../utils/fs-utils');
const RingBuffer = require('../../utils/ring-buffer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeExecuteAsync } = require('../../utils/safe-execute');

const COMMANDS_DIR = 'commands';
const SLASH_PREFIX = '/';
const MAX_EXECUTION_HISTORY = 100;
const FUZZY_MATCH_ID_CONTAINS_SCORE = 0.9;
const FUZZY_MATCH_NAME_CONTAINS_SCORE = 0.7;
const FUZZY_MATCH_PARTIAL_MULTIPLIER = 0.5;
const FUZZY_MATCH_MIN_THRESHOLD = 0.5;

/**
 * @module runtime/workflow/command-router
 * @classdesc 斜杠命令路由（CommandRouter）。自动发现、别名、中文命令、模糊匹配。
 * CommandRouter — Slash command discovery, resolution, and execution from .harness/commands/
 * Parses markdown command definitions with frontmatter, supports alias resolution, fuzzy matching,
 * tab completion, execution history tracking, causal bus integration for output publishing,
 * and ANSI-colored help text generation.
 * @extends EventEmitter
 * @emits commands-discovered | command-executed
 */
class CommandRouter extends EventEmitter {
  /**
   * Create a CommandRouter instance.
   * @param {string} projectRoot - Project root directory path
   * @param {Object} [options] - Configuration options
   * @param {Object} [options.causalBus] - CausalDataBus instance for output publishing
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'CommandRouter');
    this.root = projectRoot;
    this.commands = [];
    this.registry = {};
    this._aliasMap = {};
    this._commandsDir = path.join(this.root, HARNESS_DIR, COMMANDS_DIR);
    this._causalBus = (options && options.causalBus) ?? null;
    this._executionHistory = new RingBuffer(MAX_EXECUTION_HISTORY);
  }

  /**
   * 设置因果数据总线实例。
   * @param {Object} bus - 因果数据总线，需实现 publishOutput 方法
   * @returns {void}
   */
  setCausalBus(bus) {
    this.guardShutdown();
    if (bus && typeof bus.publishOutput !== 'function') {
      throw new DeepeningError('INVALID_INPUT', 'causalBus must have a publishOutput method');
    }
    this._causalBus = bus;
    if (bus && this.commands.length > 0) {
      this._registerCausalInterfacesSync();
    }
  }

  _registerCausalInterfacesSync() {
    if (!this._causalBus) return;
    for (const cmd of this.commands) {
      try {
        const interfaceId = 'cmd:' + cmd.command_id;
        const existing = this._causalBus.getSkillInterface(interfaceId);
        if (existing) continue;
        const causalInputs = [];
        const prevPhases = this._getPreviousPhases(cmd.phase);
        for (const prevPhase of prevPhases) {
          causalInputs.push({ name: prevPhase + '-completed', source: 'phase:' + prevPhase, required: false });
        }
        const causalOutputs = [
          { name: cmd.phase + '-completed' },
          { name: 'command-executed', source: interfaceId },
        ];
        this._causalBus.defineSkillInterfaceSync(interfaceId, {
          causalInputs: causalInputs,
          causalOutputs: causalOutputs,
          invariants: ['skills-must-complete-in-order'],
          version: 1,
        });
      } catch (err) {
        debug('CommandRouter', 'registerCausalInterface', cmd.command_id, err && err.message ? err.message : String(err));
      }
    }
  }

  _registerCausalInterfaces() {
    this._registerCausalInterfacesSync();
  }
  _getPreviousPhases(phase) {
    const idx = PHASE_INDEX[phase];
    if (idx === undefined || idx <= 0) return [];
    return PHASES.slice(0, idx);
  }

  /**
   * 同步发现并加载 .harness/commands/ 目录下的斜杠命令定义。
   * @returns {Array<Object>} 发现的命令列表
   */
  discover() {
    this.guardShutdown();
    const commandsDir = this._commandsDir;
    this.commands = [];
    this.registry = {};
    this._aliasMap = {};

    if (!fs.existsSync(commandsDir)) {
      return [];
    }

    let files;
    files = safeExecute(() => scanMarkdownDirSync(commandsDir), 'CommandRouter', 'discover', []);
    if (!files) files = [];

    for (const file of files) {
      try {
        const filePath = path.join(commandsDir, file);
        const parsed = parseMarkdownFile(filePath);
        if (!parsed) continue;
        const { frontmatter: fm, body: instructionBody } = parsed;
        if (!fm || !fm.command_id) continue;

        const commandId = fm.command_id;

        const command = {
          command_id: commandId,
          name: fm.name || commandId,
          description: fm.description || '',
          skills: parseArray(fm.skills) ?? [],
          agent: fm.agent || '',
          phase: fm.phase || '',
          aliases: parseArray(fm.aliases) ?? [],
          enforcement: fm.enforcement || 'recommended',
          instruction: instructionBody,
          _filePath: filePath,
        };

        this.commands.push(command);
        this.registry[commandId] = command;

        if (command.aliases.length > 0) {
          command.aliases.forEach(alias => {
            this._aliasMap[alias] = commandId;
          });
        }
      } catch (err) {
        debug('CommandRouter', 'discover', err);
      }
    }

    this.emit('commands-discovered', { count: this.commands.length });
    this._registerCausalInterfaces();
    return this.commands;
  }

  /**
   * 异步发现并加载 .harness/commands/ 目录下的斜杠命令定义。
   * @returns {Promise<Array<Object>>} 发现的命令列表
   */
  async discoverAsync() {
    this.guardShutdown();
    const commandsDir = this._commandsDir;
    this.commands = [];
    this.registry = {};
    this._aliasMap = {};

    let accessOk = false;
    await safeExecuteAsync(async () => { await fs.promises.access(commandsDir); accessOk = true; }, 'CommandRouter', 'discoverAsync:access');
    if (!accessOk) return [];

    let files;
    files = await safeExecuteAsync(() => scanMarkdownDirAsync(commandsDir), 'CommandRouter', 'discoverAsync', []);
    if (this._shutDown) return [];
    if (!files) files = [];

    for (const file of files) {
      try {
        const filePath = path.join(commandsDir, file);
        const parsed = await parseMarkdownFileAsync(filePath);
        if (!parsed) continue;
        const { frontmatter: fm, body: instructionBody } = parsed;
        if (!fm || !fm.command_id) continue;

        const commandId = fm.command_id;

        const command = {
          command_id: commandId,
          name: fm.name || commandId,
          description: fm.description || '',
          skills: parseArray(fm.skills) ?? [],
          agent: fm.agent || '',
          phase: fm.phase || '',
          aliases: parseArray(fm.aliases) ?? [],
          enforcement: fm.enforcement || 'recommended',
          instruction: instructionBody,
          _filePath: filePath,
        };

        this.commands.push(command);
        this.registry[commandId] = command;

        if (command.aliases.length > 0) {
          command.aliases.forEach(alias => {
            this._aliasMap[alias] = commandId;
          });
        }
      } catch (err) {
        debug('CommandRouter', 'discoverAsync', err);
      }
    }

    this.emit('commands-discovered', { count: this.commands.length });
    this._registerCausalInterfaces();
    return this.commands;
  }

  /**
   * 解析输入字符串为命令对象，支持命令ID、别名和斜杠前缀匹配。
   * @param {string} input - 用户输入的命令字符串
   * @returns {Object|null} 匹配的命令对象，未匹配返回 null
   */
  resolve(input) {
    if (!input || typeof input !== 'string') return null;

    const trimmed = input.trim();

    if (this.registry[trimmed]) {
      return this.registry[trimmed];
    }

    if (this._aliasMap[trimmed]) {
      return this.registry[this._aliasMap[trimmed]];
    }

    const slashMatch = trimmed.match(/(\/[\w-]+)/);
    if (slashMatch) {
      const candidate = slashMatch[1];
      if (this.registry[candidate]) {
        return this.registry[candidate];
      }
      if (this._aliasMap[candidate]) {
        return this.registry[this._aliasMap[candidate]];
      }
    }

    return null;
  }

  /**
   * 根据命令ID获取命令对象。
   * @param {string} commandId - 命令标识符
   * @returns {Object|null} 命令对象，未找到返回 null
   */
  getCommand(commandId) {
    return this.registry[commandId] ?? null;
  }

  /**
   * 获取命令的执行计划，包含技能链和配置信息。
   * @param {string} commandId - 命令标识符
   * @returns {Object|null} 执行计划对象，未找到返回 null
   */
  getExecutionPlan(commandId) {
    const cmd = this.resolve(commandId);
    if (!cmd) return null;

    return {
      commandId: cmd.command_id,
      name: cmd.name,
      description: cmd.description,
      skills: cmd.skills.slice(),
      agent: cmd.agent,
      phase: cmd.phase,
      enforcement: cmd.enforcement,
      instruction: cmd.instruction,
    };
  }

  /**
   * 执行指定命令，记录执行历史并通过因果总线发布输出。
   * @param {string} commandId - 命令标识符
   * @param {Object} [context] - 执行上下文
   * @returns {Object|null} 执行计划对象，未找到返回 null
   */
  executeCommand(commandId, context) {
    this.guardShutdown();
    const cmd = this.resolve(commandId);
    if (!cmd) return null;

    const plan = this.getExecutionPlan(commandId);
    const executionRecord = {
      commandId: cmd.command_id,
      name: cmd.name,
      phase: cmd.phase,
      skills: cmd.skills.slice(),
      enforcement: cmd.enforcement,
      timestamp: Date.now(),
      context: context ?? {},
      status: 'dispatched',
    };

    this._executionHistory.push(executionRecord);
    if (this._causalBus) {
      const outputData = {
        commandId: cmd.command_id,
        phase: cmd.phase,
        skills: cmd.skills,
        enforcement: cmd.enforcement,
        timestamp: executionRecord.timestamp,
      };
      this._causalBus.publishOutputSync('cmd:' + cmd.command_id, outputData);
    }

    this.emit('command-executed', executionRecord);
    return plan;
  }

  /**
   * 获取命令执行历史记录。
   * @param {number} [limit] - 返回记录的最大数量
   * @returns {Array<Object>} 执行历史记录列表
   */
  getExecutionHistory(limit) {
    const safeLimit = (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) ? limit : MAX_EXECUTION_HISTORY;
    const count = Math.min(safeLimit, this._executionHistory.size);
    return this._executionHistory.toArray().slice(-count);
  }

  /**
   * 列出所有已发现的命令摘要信息。
   * @returns {Array<Object>} 命令摘要列表
   */
  listCommands() {
    return this.commands.map(c => ({
      command_id: c.command_id,
      name: c.name,
      description: c.description,
      skills: c.skills,
      agent: c.agent,
      phase: c.phase,
      aliases: c.aliases,
    }));
  }

  /**
   * 生成ANSI彩色帮助文本。
   * @param {boolean} [useColor=true] - 是否使用ANSI颜色
   * @returns {string} 格式化的帮助文本
   */
  getHelpText(useColor) {
    const c = useColor !== false && this._supportsColor() ? this._ANSI : this._noColor;
    const lines = [
      `${c.bold}${c.primary}━━━ Harness 斜杠命令 ━━━${c.reset}`,
      '',
    ];
    for (const cmd of this.commands) {
      const aliasStr = cmd.aliases.length > 0 ? ` ${c.muted}(别名: ${cmd.aliases.join(', ')})${c.reset}` : '';
      const enforcementBadge = cmd.enforcement === 'strict'
        ? ` ${c.danger}[强制]${c.reset}`
        : cmd.enforcement === 'optional'
          ? ` ${c.muted}[可选]${c.reset}`
          : '';
      lines.push(`  ${c.bold}${c.primary}${cmd.command_id}${c.reset} — ${cmd.name}${enforcementBadge}${aliasStr}`);
      if (cmd.description) {
        lines.push(`    ${c.muted}${cmd.description}${c.reset}`);
      }
      if (cmd.skills.length > 0) {
        lines.push(`    ${c.success}▸${c.reset} ${cmd.skills.join(` ${c.muted}→${c.reset} `)}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  _supportsColor() {
    try {
      return process.stdout && process.stdout.isTTY;
    } catch (_err) { debug('CommandRouter', '_supportsColor', _err && _err.message ? _err.message : String(_err)); return false; }
  }

  get _ANSI() {
    return {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      primary: '\x1b[38;2;129;140;248m',
      success: '\x1b[38;2;52;211;153m',
      warning: '\x1b[38;2;251;191;36m',
      danger: '\x1b[38;2;248;113;113m',
      muted: '\x1b[38;2;148;163;184m',
    };
  }

  get _noColor() {
    return { reset: '', bold: '', primary: '', success: '', warning: '', danger: '', muted: '' };
  }

  /**
   * 判断输入是否为有效的斜杠命令。
   * @param {string} input - 用户输入
   * @returns {boolean} 是否为有效命令
   */
  isCommand(input) {
    if (!input || typeof input !== 'string') return false;
    const trimmed = input.trim();
    if (trimmed.startsWith(SLASH_PREFIX) && trimmed.length > 1) {
      const candidate = trimmed.split(/\s/)[0];
      return !!this.registry[candidate] || !!this._aliasMap[candidate];
    }
    return false;
  }

  /**
   * 根据部分输入提供命令补全建议。
   * @param {string} partial - 部分命令输入
   * @returns {Array<Object>} 匹配的命令补全列表
   */
  complete(partial) {
    if (!partial || typeof partial !== 'string') return [];
    const trimmed = partial.trim();
    if (!trimmed.startsWith(SLASH_PREFIX)) return [];
    const prefix = trimmed.toLowerCase();
    const matches = [];
    for (const cmd of this.commands) {
      if (cmd.command_id.toLowerCase().startsWith(prefix)) {
        matches.push({ command_id: cmd.command_id, name: cmd.name, description: cmd.description });
      }
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase().startsWith(prefix)) {
          matches.push({ command_id: cmd.command_id, name: cmd.name, alias: alias, description: cmd.description });
        }
      }
    }
    return matches;
  }

  /**
   * 模糊匹配命令，支持命令ID和名称的部分匹配。
   * @param {string} input - 用户输入
   * @returns {Object|null} 最佳匹配的命令对象，无匹配返回 null
   */
  fuzzyMatch(input) {
    if (!input || typeof input !== 'string') return null;
    const exact = this.resolve(input);
    if (exact) return exact;
    const normalized = input.toLowerCase().replace(/[/\s-]/g, '');
    let bestMatch = null;
    let bestScore = 0;
    for (const cmd of this.commands) {
      const cmdNorm = cmd.command_id.toLowerCase().replace(/[/\s-]/g, '');
      const nameNorm = cmd.name.toLowerCase().replace(/[/\s-]/g, '');
      let score = 0;
      if (cmdNorm.includes(normalized)) score = FUZZY_MATCH_ID_CONTAINS_SCORE;
      else if (nameNorm.includes(normalized)) score = FUZZY_MATCH_NAME_CONTAINS_SCORE;
      else {
        const aliases = Array.isArray(cmd.aliases) ? cmd.aliases : [];
        for (const alias of aliases) {
          const aliasNorm = String(alias).toLowerCase().replace(/[/\s-]/g, '');
          if (aliasNorm.includes(normalized)) {
            score = Math.max(score, FUZZY_MATCH_NAME_CONTAINS_SCORE);
            break;
          }
        }
      }
      if (score === 0) {
        let matchCount = 0;
        let idxCmd = 0;
        let idxName = 0;
        for (let i = 0; i < normalized.length; i++) {
          const foundCmd = cmdNorm.indexOf(normalized[i], idxCmd);
          const foundName = nameNorm.indexOf(normalized[i], idxName);
          if (foundCmd >= 0) { matchCount++; idxCmd = foundCmd + 1; }
          else if (foundName >= 0) { matchCount++; idxName = foundName + 1; }
        }
        score = normalized.length > 0 ? matchCount / normalized.length * FUZZY_MATCH_PARTIAL_MULTIPLIER : 0;
      }
      if (score > bestScore && score >= FUZZY_MATCH_MIN_THRESHOLD) {
        bestScore = score;
        bestMatch = cmd;
      }
    }
    return bestMatch;
  }

  _onShutdown() {
    this.commands = [];
    this.registry = {};
    this._aliasMap = {};
    this._executionHistory.clear();
    this._causalBus = null;
    this.removeAllListeners();
  }

  /**
   * 获取命令路由器的统计信息。
   * @returns {Object} 统计数据，包含命令总数、别名数、按阶段分组等
   */
  getStats() {
    return {
      totalCommands: this.commands.length,
      totalAliases: Object.keys(this._aliasMap).length,
      commandsByPhase: this._groupByPhase(),
      executionHistorySize: this._executionHistory.size,
      causalBusConnected: !!this._causalBus,
    };
  }

  _groupByPhase() {
    return this.commands.reduce((groups, cmd) => {
      const phase = cmd.phase || 'unspecified';
      groups[phase] = (groups[phase] ?? 0) + 1;
      return groups;
    }, {});
  }
}

module.exports = withShutdown(CommandRouter);
