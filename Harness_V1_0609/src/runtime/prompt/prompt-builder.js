'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedMap = require('../../utils/bounded-map');
const { safeExecute } = require('../../utils/safe-execute');
const { HARNESS_DIR, UTF8_ENCODING } = require('../../utils/constants');
const _SkillToolAdapter = require('../skill/skill-tool-adapter');

const STATIC_SECTIONS = ['identity', 'coding_standards', 'tool_guidelines', 'safety_rules'];
const DYNAMIC_SECTIONS = ['task_context', 'environment', 'session_state', 'recent_actions'];

/**
 * 首因效应强调指令：放在系统提示词最前面，利用首因效应强化AI对核心规则的认知。
 * 来源：提示词工程最佳实践——重要规则开头结尾强调。
 */
const PRIMACY_EMPHASIS = [
  '## Core Directives (MUST follow)',
  '',
  '- Before acting, restate the user\'s request in your own words to confirm understanding. If unclear, ask for clarification.',
  '- If you are uncertain about something, say "I don\'t know" instead of guessing. Only make claims you are confident about.',
  '- Always state your conclusion first, then provide the explanation or reasoning.',
  '',
].join('\n');

/**
 * 近因效应强调指令：放在系统提示词最后面，利用近因效应强化AI对核心规则的认知。
 * 来源：提示词工程最佳实践——重要规则开头结尾强调。
 */
const RECENCY_EMPHASIS = [
  '## Reminder (MUST follow)',
  '',
  '- Restate the request before acting to ensure correct understanding.',
  '- If uncertain, say "I don\'t know" — never fabricate information.',
  '- Lead with conclusions, then explain.',
  '',
].join('\n');

const DEFAULT_CONFIG = {
  maxStaticTokens: 8000,
  maxDynamicTokens: 4000,
  cacheStaticPrefix: true,
  includeRules: true,
  includePersona: true,
  includeSkills: true,
  rulesDir: 'rules',
  agentsDir: 'agents',
  skillsDir: 'skills',
  conventionLineLimit: 200,
};

/**
 * 规则优先级层级, 融合自Claude Code的优先级级联概念。
 * 更具体的层级覆盖更通用的层级, 冲突时高优先级规则胜出。
 * 4-USER > 3-PROJECT > 2-PLUGIN > 1-SUBDIR
 */
const RULE_PRIORITY_LAYERS = {
  LAYER_SUBDIR: 1,
  LAYER_PLUGIN: 2,
  LAYER_PROJECT: 3,
  LAYER_USER: 4,
};

const RULE_PRIORITY_NAMES = {
  1: 'subdir',
  2: 'plugin',
  3: 'project',
  4: 'user',
};

/**
 * @module runtime/prompt/prompt-builder
 * @classdesc 提示词构建器（PromptBuilder）。静态前缀+动态后缀分离，
 * agent persona+rules+skills构建，SHA-256哈希缓存失效，
 * attachPatternExtractor()模式提取器注入，支持PromptPatternExtractor学习性注入。
 *
 * @fires PromptBuilder#static-prefix-rebuilt
 * @fires PromptBuilder#prompt-built
 */
class PromptBuilder extends EventEmitter {
  /**
   * @param {string} projectRoot - Absolute path to the project root directory
   * @param {Object} [options] - Configuration options
   * @param {number} [options.maxStaticTokens=8000] - Maximum token budget for static prefix
   * @param {number} [options.maxDynamicTokens=4000] - Maximum token budget for dynamic suffix
   * @param {boolean} [options.cacheStaticPrefix=true] - Whether to enable static prefix caching
   * @param {boolean} [options.includeRules=true] - Whether to include .harness/rules/ content
   * @param {boolean} [options.includePersona=true] - Whether to include agent persona
   * @param {boolean} [options.includeSkills=true] - Whether to include skill instructions
   */
  constructor(projectRoot, options) {
    super();
    this._projectRoot = projectRoot;
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._staticPrefixCache = new BoundedMap(50);
    this._staticPrefixHashes = new BoundedMap(50);
    this._invalidatedAgents = new Set();
    this._patternExtractor = null;
    this._skillToolAdapter = null;
    this._skillRouter = null;
    this._rulesContent = null;
    this._rulesLoadedAt = 0;
  }

  /**
   * Build the full system prompt by combining static prefix and dynamic suffix.
   * @param {string} agentId - Agent identifier
   * @param {Object} [context] - Dynamic context for the suffix
   * @param {string} [context.taskContext] - Current task description
   * @param {Object} [context.environment] - Environment variables and state
   * @param {Object} [context.sessionState] - Current session state
   * @param {string[]} [context.recentActions] - Recent action descriptions
   * @param {string[]} [context.skillIds] - Skill IDs to include instructions for
   * @returns {{ systemPrompt: string, staticPrefix: string, dynamicSuffix: string, staticTokenCount: number, dynamicTokenCount: number, prefixHash: string }}
   */
  buildSystemPrompt(agentId, context) {
    this.guardShutdown();
    const staticPrefix = this.buildStaticPrefix(agentId);
    const dynamicSuffix = this.buildDynamicSuffix(context ?? {});
    const systemPrompt = staticPrefix + '\n\n---\n\n' + dynamicSuffix;
    const prefixHash = this.getStaticPrefixHash(agentId);
    const result = {
      systemPrompt: systemPrompt,
      staticPrefix: staticPrefix,
      dynamicSuffix: dynamicSuffix,
      staticTokenCount: this._estimateTokens(staticPrefix),
      dynamicTokenCount: this._estimateTokens(dynamicSuffix),
      prefixHash: prefixHash,
    };
    this.emit('prompt-built', { agentId: agentId, staticTokenCount: result.staticTokenCount, dynamicTokenCount: result.dynamicTokenCount });
    return result;
  }

  /**
   * Build the cacheable static prefix from agent persona + rules + core skill instructions.
   * @param {string} agentId - Agent identifier
   * @returns {string} The static prefix string
   */
  buildStaticPrefix(agentId) {
    this.guardShutdown();
    if (!this._invalidatedAgents.has(agentId) && this._staticPrefixCache.has(agentId)) {
      return this._staticPrefixCache.get(agentId);
    }
    const sections = [];
    // 首因效应：核心指令放在最前面（提示词工程最佳实践——重要规则开头结尾强调）
    sections.push(PRIMACY_EMPHASIS);
    if (this._config.includePersona) {
      const persona = this._loadAgentPersona(agentId);
      if (persona) sections.push(persona);
    }
    if (this._config.includeRules) {
      const rules = this._loadRules();
      if (rules) sections.push(rules);
    }
    // 近因效应：核心指令重复放在最后面（提示词工程最佳实践——重要规则开头结尾强调）
    sections.push(RECENCY_EMPHASIS);
    let prefix = sections.join('\n\n');
    prefix = this._truncateToBudget(prefix, this._config.maxStaticTokens);
    this._staticPrefixCache.set(agentId, prefix);
    this._invalidatedAgents.delete(agentId);
    const hash = this._computeHash(prefix);
    this._staticPrefixHashes.set(agentId, hash);
    this.emit('static-prefix-rebuilt', { agentId: agentId, hash: hash, tokenCount: this._estimateTokens(prefix) });
    return prefix;
  }

  /**
   * Build the non-cacheable dynamic suffix from current task context + environment + session state.
   * @param {Object} context - Dynamic context
   * @param {string} [context.taskContext] - Current task description
   * @param {Object} [context.environment] - Environment variables and state
   * @param {Object} [context.sessionState] - Current session state
   * @param {string[]} [context.recentActions] - Recent action descriptions
   * @param {string[]} [context.skillIds] - Skill IDs to include instructions for
   * @returns {string} The dynamic suffix string
   */
  buildDynamicSuffix(context) {
    this.guardShutdown();
    const sections = [];
    if (context.taskContext) {
      sections.push('## Task Context\n\n' + context.taskContext);
    }
    if (context.environment && Object.keys(context.environment).length > 0) {
      const envLines = Object.entries(context.environment)
        .map(function(entry) { return '- ' + entry[0] + ': ' + String(entry[1]); })
        .join('\n');
      sections.push('## Environment\n\n' + envLines);
    }
    if (context.sessionState && Object.keys(context.sessionState).length > 0) {
      try {
        sections.push('## Session State\n\n' + JSON.stringify(context.sessionState, null, 2));
      } catch (_e) {
        sections.push('## Session State\n\n[Session state contains non-serializable data]');
      }
    }
    if (context.recentActions && context.recentActions.length > 0) {
      sections.push('## Recent Actions\n\n' + context.recentActions.map(function(a, i) { return (i + 1) + '. ' + a; }).join('\n'));
    }
    if (this._config.includeSkills && context.skillIds && context.skillIds.length > 0) {
      const skillInstructions = this._loadSkillInstructions(context.skillIds);
      if (skillInstructions) sections.push(skillInstructions);
    }
    if (this._patternExtractor) {
      const taskType = context.taskType || context.taskContext || 'general';
      const injectionResult = safeExecute(
        function() { return this._patternExtractor.getRecommendedInjections(taskType); }.bind(this),
        'PromptBuilder', 'getRecommendedInjections', null,
      );
      if (injectionResult && injectionResult.injections && injectionResult.injections.length > 0) {
        const patternLines = injectionResult.injections.map(function(inj) {
          return '- [' + inj.category + '] ' + inj.recommendation + ' (confidence: ' + inj.confidence.toFixed(2) + ')';
        });
        sections.push('## Learned Prompt Patterns\n\n' + patternLines.join('\n'));
      }
    }
    let suffix = sections.join('\n\n');
    suffix = this._truncateToBudget(suffix, this._config.maxDynamicTokens);
    return suffix;
  }

  /**
   * Returns a content hash of the static prefix for cache invalidation.
   * @param {string} agentId - Agent identifier
   * @returns {string} SHA-256 hash of the static prefix
   */
  getStaticPrefixHash(agentId) {
    this.guardShutdown();
    const cached = this._staticPrefixHashes.get(agentId);
    if (cached) return cached;
    const prefix = this._staticPrefixCache.get(agentId);
    if (!prefix) return '';
    const hash = this._computeHash(prefix);
    this._staticPrefixHashes.set(agentId, hash);
    return hash;
  }

  /**
   * Marks the static prefix as needing rebuild for the given agent.
   * @param {string} agentId - Agent identifier
   */
  invalidateStaticPrefix(agentId) {
    this.guardShutdown();
    if (!agentId || typeof agentId !== 'string') return;
    this._invalidatedAgents.add(agentId);
    this._staticPrefixCache.delete(agentId);
    this._staticPrefixHashes.delete(agentId);
  }

  /**
   * 挂载PromptPatternExtractor实例，用于在动态后缀中注入学习到的提示词模式
   * @param {Object} extractor - PromptPatternExtractor实例
   * @returns {PromptBuilder} 当前实例，支持链式调用
   */
  attachPatternExtractor(extractor) {
    this.guardShutdown();
    this._patternExtractor = extractor;
    return this;
  }

  /**
   * 挂载技能工具适配器实例。
   * @param {Object} adapter - SkillToolAdapter 实例
   * @returns {void}
   */
  attachSkillToolAdapter(adapter) {
    this.guardShutdown();
    this._skillToolAdapter = adapter;
    return this;
  }

  /**
   * 挂载技能路由器实例。
   * @param {Object} skillRouter - SkillRouter 实例
   * @returns {void}
   */
  attachSkillRouter(skillRouter) {
    this.guardShutdown();
    this._skillRouter = skillRouter;
    return this;
  }

  /**
   * Reads agent MD file and extracts persona section.
   * @param {string} agentId - Agent identifier
   * @returns {string|null} Persona content or null if not found
   * @private
   */
  _loadAgentPersona(agentId) {
    return safeExecute(function() {
      const agentsDir = path.join(this._projectRoot, HARNESS_DIR, this._config.agentsDir);
      const filePath = path.join(agentsDir, agentId + '.md');
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, UTF8_ENCODING);
      return '## Agent Identity\n\n' + content.trim();
    }.bind(this), 'PromptBuilder', '_loadAgentPersona', null);
  }

  /**
   * Reads all rule files from .harness/rules/ and caches the result.
   * @returns {string|null} Combined rules content or null if not found
   * @private
   */
  _loadRules() {
    const now = Date.now();
    if (this._rulesContent && (now - this._rulesLoadedAt) < 60000) {
      return this._rulesContent;
    }
    const result = safeExecute(function() {
      const lineLimit = this._config.conventionLineLimit || 200;
      const ruleLayers = this._collectRuleLayers(lineLimit);
      if (ruleLayers.length === 0) return null;
      ruleLayers.sort(function(a, b) { return b.priority - a.priority; });
      const seenTopics = new Map();
      const mergedParts = [];
      for (const layer of ruleLayers) {
        for (const rule of layer.rules) {
          const topic = rule.topic;
          if (seenTopics.has(topic)) {
            const prevPriority = seenTopics.get(topic);
            if (layer.priority > prevPriority) {
              const prevIdx = mergedParts.findIndex(function(p) { return p.topic === topic; });
              if (prevIdx >= 0) mergedParts.splice(prevIdx, 1);
              mergedParts.push(rule);
              seenTopics.set(topic, layer.priority);
            }
          } else {
            mergedParts.push(rule);
            seenTopics.set(topic, layer.priority);
          }
        }
      }
      if (mergedParts.length === 0) return null;
      const parts = mergedParts.map(function(r) {
        const priorityLabel = RULE_PRIORITY_NAMES[r.priority] || 'unknown';
        return '### ' + r.topic + ' [' + priorityLabel + ']\n\n' + r.content;
      });
      return '## Rules (priority: user > project > plugin > subdir)\n\n' + parts.join('\n\n');
    }.bind(this), 'PromptBuilder', '_loadRules', null);
    if (result) {
      this._rulesContent = result;
      this._rulesLoadedAt = now;
    }
    return result;
  }

  /**
   * 收集所有优先级层级的规则文件。融合自Claude Code的优先级级联概念。
   * 同时支持单文件约定模式（CONVENTION.md），融合自Claude Code的CLAUDE.md单文件约定概念。
   * @param {number} lineLimit - 每个规则文件的行数限制
   * @returns {Array<{priority: number, rules: Array<{topic: string, content: string, priority: number}>}>}
   * @private
   */
  _collectRuleLayers(lineLimit) {
    const layers = [];
    // 单文件约定模式：加载 .harness/CONVENTION.md（项目级）和 ~/.harness/CONVENTION.md（用户级）
    // 融合自Claude Code的CLAUDE.md概念——单文件存储项目约定，每个会话自动加载
    const projectConvention = this._readConventionFile(
      path.join(this._projectRoot, HARNESS_DIR, 'CONVENTION.md'),
      RULE_PRIORITY_LAYERS.LAYER_PROJECT, lineLimit,
    );
    const projectRules = this._readRulesFromDir(path.join(this._projectRoot, HARNESS_DIR, this._config.rulesDir), RULE_PRIORITY_LAYERS.LAYER_PROJECT, lineLimit);
    const combinedProject = [].concat(projectConvention, projectRules);
    if (combinedProject.length > 0) layers.push({ priority: RULE_PRIORITY_LAYERS.LAYER_PROJECT, rules: combinedProject });

    const userHome = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH;
    if (userHome) {
      const userConvention = this._readConventionFile(
        path.join(userHome, '.harness', 'CONVENTION.md'),
        RULE_PRIORITY_LAYERS.LAYER_USER, lineLimit,
      );
      const userRules = this._readRulesFromDir(path.join(userHome, '.harness', 'rules'), RULE_PRIORITY_LAYERS.LAYER_USER, lineLimit);
      const combinedUser = [].concat(userConvention, userRules);
      if (combinedUser.length > 0) layers.push({ priority: RULE_PRIORITY_LAYERS.LAYER_USER, rules: combinedUser });
    }
    const pluginsDir = path.join(this._projectRoot, HARNESS_DIR, 'plugins');
    if (fs.existsSync(pluginsDir)) {
      try {
        const pluginDirs = fs.readdirSync(pluginsDir).filter(function(d) {
          return fs.statSync(path.join(pluginsDir, d)).isDirectory();
        });
        for (const pd of pluginDirs) {
          const pluginRules = this._readRulesFromDir(path.join(pluginsDir, pd, 'rules'), RULE_PRIORITY_LAYERS.LAYER_PLUGIN, lineLimit);
          if (pluginRules.length > 0) layers.push({ priority: RULE_PRIORITY_LAYERS.LAYER_PLUGIN, rules: pluginRules });
        }
      } catch (_) { debug('PromptBuilder', 'readPluginDirs', _ && _.message ? _.message : String(_)); }
    }
    return layers;
  }

  /**
   * 读取单文件约定（CONVENTION.md），融合自Claude Code的CLAUDE.md概念。
   * 单文件约定将项目核心约定集中在一个文件中，每个会话自动加载。
   * 文件内容按二级标题分割为多个topic，每个topic独立参与优先级级联。
   * 超过行数限制的内容会被截断。
   * @param {string} filePath - 约定文件路径
   * @param {number} priority - 优先级层级
   * @param {number} lineLimit - 行数限制
   * @returns {Array<{topic: string, content: string, priority: number}>}
   * @private
   */
  _readConventionFile(filePath, priority, lineLimit) {
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, UTF8_ENCODING).trim();
      if (!raw) return [];
      const lines = raw.split('\n');
      const truncated = lines.length > lineLimit;
      const content = truncated
        ? lines.slice(0, lineLimit).join('\n') + '\n... (truncated at ' + lineLimit + ' lines)'
        : raw;
      // 按二级标题分割为多个topic，每个topic独立参与优先级级联
      const sections = content.split(/\n(?=## )/);
      if (sections.length <= 1) {
        return [{ topic: 'CONVENTION', content: content, priority: priority }];
      }
      return sections.filter(function(s) { return s.trim().length > 0; }).map(function(s) {
        const headerMatch = s.match(/^##\s+(.+)/);
        const topic = headerMatch ? headerMatch[1].replace(/[^a-zA-Z0-9_-]/g, '_') : 'CONVENTION';
        return { topic: 'CONVENTION.' + topic, content: s.trim(), priority: priority };
      });
    } catch (_) { debug('PromptBuilder', 'readConventionRules', _ && _.message ? _.message : String(_)); return []; }
  }

  /**
   * 从指定目录读取规则文件，每个文件截断到行数限制。
   * @param {string} dirPath - 规则目录路径
   * @param {number} priority - 优先级层级
   * @param {number} lineLimit - 行数限制
   * @returns {Array<{topic: string, content: string, priority: number}>}
   * @private
   */
  _readRulesFromDir(dirPath, priority, lineLimit) {
    if (!fs.existsSync(dirPath)) return [];
    try {
      const entries = fs.readdirSync(dirPath).filter(function(f) { return f.endsWith('.md'); });
      return entries.sort().map(function(f) {
        const raw = fs.readFileSync(path.join(dirPath, f), UTF8_ENCODING).trim();
        const lines = raw.split('\n');
        const content = lines.length > lineLimit
          ? lines.slice(0, lineLimit).join('\n') + '\n... (truncated at ' + lineLimit + ' lines)'
          : raw;
        return { topic: f.replace(/\.md$/, ''), content: content, priority: priority };
      });
    } catch (_) { debug('PromptBuilder', 'readRulesFromDir', _ && _.message ? _.message : String(_)); return []; }
  }

  /**
   * Reads skill instructions for given skill IDs.
   * @param {string[]} skillIds - Array of skill identifiers
   * @returns {string|null} Combined skill instructions or null
   * @private
   */
  _loadSkillInstructions(skillIds) {
    return safeExecute(function() {
      const skillsDir = path.join(this._projectRoot, HARNESS_DIR, this._config.skillsDir);
      if (!fs.existsSync(skillsDir)) return null;
      const parts = [];
      for (const sid of skillIds) {
        if (this._skillToolAdapter && sid) {
          const coreIds = this._skillToolAdapter.getCoreSkillIds();
          if (!coreIds.includes(sid)) {
            const l1 = this._skillRouter ? this._skillRouter.getSkill(sid) : null;
            if (l1) {
              parts.push('[Skill: ' + (l1.name ?? sid) + '] ' + (l1.summary ?? '') + ' (Use load_skill_' + sid.replace(/[^a-zA-Z0-9_]/g, '_') + ' to load full instructions)');
              continue;
            }
          }
        }
        const filePath = path.join(skillsDir, sid + '.md');
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, UTF8_ENCODING).trim();
          parts.push('### Skill: ' + sid + '\n\n' + content);
        }
      }
      if (parts.length === 0) return null;
      return '## Skill Instructions\n\n' + parts.join('\n\n');
    }.bind(this), 'PromptBuilder', '_loadSkillInstructions', null);
  }

  /**
   * Estimates token count for text (chars / 4).
   * @param {string} text - Text to estimate tokens for
   * @returns {number} Estimated token count
   * @private
   */
  _estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncates text to fit within token budget.
   * @param {string} text - Text to truncate
   * @param {number} budget - Maximum token budget
   * @returns {string} Truncated text
   * @private
   */
  _truncateToBudget(text, budget) {
    if (!text || typeof text !== 'string') return '';
    const maxChars = budget * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 3) + '...';
  }

  /**
   * Computes SHA-256 hash of text content.
   * @param {string} text - Text to hash
   * @returns {string} Hex-encoded hash
   * @private
   */
  _computeHash(text) {
    return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
  }

  _onShutdown() {
    this._staticPrefixCache.shutdown();
    this._staticPrefixHashes.shutdown();
    this._invalidatedAgents.clear();
    this._patternExtractor = null;
    this._skillToolAdapter = null;
    this._skillRouter = null;
    this._rulesContent = null;
    this.removeAllListeners();
  }
}

PromptBuilder.STATIC_SECTIONS = STATIC_SECTIONS;
PromptBuilder.DYNAMIC_SECTIONS = DYNAMIC_SECTIONS;
PromptBuilder.DEFAULT_CONFIG = DEFAULT_CONFIG;
PromptBuilder.RULE_PRIORITY_LAYERS = RULE_PRIORITY_LAYERS;
PromptBuilder.RULE_PRIORITY_NAMES = RULE_PRIORITY_NAMES;

module.exports = withShutdown(PromptBuilder);
