'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { DEFAULT_ENFORCEMENT, FRONTMATTER_TRUE, parseArray, validateProjectRoot, estimateTokens, DEFAULT_FALLBACK_INTERVAL_MS, UTF8_ENCODING, extractMarkdownBody, DEFAULT_SUMMARY_MAX_LENGTH, DEDUP_KEY_LENGTH, HARNESS_DIR, DEFAULT_CACHE_MAX, DEFAULT_CACHE_TTL, MAX_CONTENT_PREVIEW_LENGTH, DEFAULT_PERSIST_DEBOUNCE_MS, SKILL_LAYER_CORE, DEFAULT_TOP_K } = require('../../utils/constants');
const { validatePath, validatePathAsync } = require('../../utils/path-utils');
const { debug } = require('../../utils/debug-logger');
const { emitError, safeExecute, safeExecuteAsync, ensureArray } = require('../../utils/safe-execute');
const { parseMarkdownFile } = require('../../utils/fs-utils');
const stableStringify = require('../../utils/stable-stringify');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { scanSkillFilesSync, scanSkillFilesAsync, parseSkillFileSync, parseSkillFileAsync, buildBaseSkillEntry, resolveResourcePath, buildL3Entry } = require('./skill-discover-utils');
const MIN_KEYWORD_LENGTH = 2;
const AUTO_TRIGGER_PROJECT_KEYWORDS = ['项目', '系统', 'project', 'app', 'application', 'platform'];
const AUTO_TRIGGER_MODULE_KEYWORDS = ['新模块', '新抽象', '新依赖', '新接口', 'new module', 'new abstract', 'new dependency', 'new interface', '创建模块', '添加依赖', '引入抽象'];
const AUTO_TRIGGER_PROJECT_KEYWORDS_LOWER = AUTO_TRIGGER_PROJECT_KEYWORDS.map(k => k.toLowerCase());
const AUTO_TRIGGER_MODULE_KEYWORDS_LOWER = AUTO_TRIGGER_MODULE_KEYWORDS.map(k => k.toLowerCase());

const CORE_SKILLS = new Set([
  'tdd-implement', 'module-development', 'code-review', 'verification-before-completion',
  'integration-testing', 'systematic-debugging', 'bug-fix', 'security-audit',
  'performance-optimization', 'refactor-code', 'architecture-design',
  'requirement-analysis', 'brainstorming', 'deployment', 'documentation',
  'iterative-deepening', 'multi-agent-fusion', 'ai-research',
]);

const EXTENSION_SKILLS = new Set([
  'taste-skill', 'better-icons', 'motion-ai-kit',
]);

const NEGATION_PATTERN = /不需要\s*|不要\s*|跳过\s*|不使用\s*|不用\s*|no\s+|don'?t\s+|skip\s+|without\s+|not\s+/i;

const SEMANTIC_GROUPS = {
  'tdd': ['测试驱动', '先写测试', 'red-green', 'tdd', 'test-driven', '测试优先'],
  'architecture': ['架构', '设计', '模块划分', '接口设计', 'architecture', 'design', 'structure'],
  'deploy': ['部署', '上线', '发布', 'deploy', 'release', 'ship', 'publish'],
  'review': ['审查', '审核', '代码评审', 'code review', 'review', 'inspect'],
  'debug': ['调试', '排错', 'bug', 'debug', 'troubleshoot', 'fix'],
  'test': ['测试', '单元测试', '集成测试', 'test', 'testing', 'spec'],
  'security': ['安全', '漏洞', '审计', 'security', 'audit', 'vulnerability'],
  'refactor': ['重构', '优化', 'refactor', 'restructure', 'clean'],
  'performance': ['性能', '优化', '加速', 'performance', 'optimize', 'speed'],
  'brainstorm': ['头脑风暴', '需求探索', 'brainstorm', 'explore', 'ideate'],
  'requirement': ['需求分析', '需求规格', 'requirement', 'spec', 'analysis'],
  'deepening': ['深化', '迭代精炼', '循环深化', '多轮推理', 'deepening', 'iterate', 'refine', 'recurrent'],
  'convergence': ['收敛', '收敛检测', '质量达标', 'convergence', 'converge', 'plateau'],
  'fusion': ['融合', '多Agent协同', '输出融合', '投票', 'fusion', 'merge', 'vote', 'cascade'],
  'specification': ['规格', '规格说明', 'specification', 'spec', '接口规格', 'interface spec', '行为规格', 'behavior spec'],
  'idea': ['想法验证', '假设验证', '竞品分析', 'idea', 'validation', '验证想法', 'PMF', '产品市场匹配', '不确定性'],
  'mvp': ['MVP', '最小可行产品', '快速原型', 'mvp', 'prototype', 'AI原生构建', '非技术创始人'],
  'scaling': ['规模化', '扩展', 'AI原生规模化', 'scaling', 'scale', '非线性增长', '自动化运营', '增长策略'],
  'cli-anything': ['软件操控', 'CLI工具', '专业软件', 'GIMP', 'Blender', 'LibreOffice', 'OBS', '图像编辑', '3D渲染', '文档生成', '音频处理', '视频编辑', 'cli-anything', 'cli-hub', '软件自动化', 'Agent操控软件', '桌面软件'],
  'research': ['调研', '研究', '最佳实践', '技术方案', '怎么实现', '如何实现', 'research', 'investigate', 'best practice', 'how to implement', '技术选型', '方案对比'],
  'data-collect': ['数据采集', '抓取', '爬虫', '采集', '小红书', '公众号', '抖音', '视频号', '数据抓取', '内容采集', '选题', '数据分析', 'scrape', 'crawl', 'collect', 'extract', 'data collection', 'web scraping', 'field extraction', '字段提取'],
  'direction-discovery': ['找方向', '方向发现', '痛点', '抱怨', '差评', '竞品分析', '竞品空隙', '市场空白', '技术红利', 'Product Lens', '用户画像', '痛点扫描', 'Feature Request', '需求发现', '方向决策', '商业机会', '市场机会', '伪需求', '方向验证', 'pain point', 'competitor gap', 'tech dividend', 'market research', 'direction', 'opportunity', 'idea discovery'],
};
const MAX_MESSAGE_LENGTH = 10000;
const MIN_MESSAGE_LENGTH_FOR_WORD_MATCH = 5;
const MIN_WORD_LENGTH_FOR_MATCH = 3;
const UNKNOWN_PHASE_ORDER = 99;

/**
 * 模型分级常量 — Skill蒸馏核心概念：大模型编写Skill，小模型执行Skill
 * 每个技能标记其最低执行模型层级，路由时根据当前模型能力过滤
 */
const MODEL_TIERS = {
  /** 小模型可执行：步骤明确、无需深层理解、按流程执行即可 */
  SMALL: 'small',
  /** 中等模型：需要一定推理能力、条件判断、简单决策 */
  MEDIUM: 'medium',
  /** 大模型专属：需要深层理解、创造性思维、复杂架构设计 */
  LARGE: 'large',
};

/** 模型层级优先级（小→大） */
const TIER_PRIORITY = { [MODEL_TIERS.SMALL]: 0, [MODEL_TIERS.MEDIUM]: 1, [MODEL_TIERS.LARGE]: 2 };

/** 根据技能特征推断默认模型层级 */
function inferModelTier(skillEntry) {
  if (!skillEntry) return MODEL_TIERS.MEDIUM;
  const tags = (entry => {
    if (Array.isArray(entry.tags)) return entry.tags;
    if (typeof entry.tags === 'string') return entry.tags.split(',').map(t => t.trim());
    return [];
  })(skillEntry);
  const phase = entry => (entry && entry.phase) || '';
  const enforcement = entry => (entry && entry.enforcement) || '';
  const tagStr = tags.join(' ').toLowerCase();
  const phaseStr = phase(skillEntry).toLowerCase();
  const enfStr = enforcement(skillEntry).toLowerCase();
  // 大模型专属：架构设计、头脑风暴、需求探索、想法验证、方向发现
  const largeSignals = ['architecture', 'brainstorm', 'idea', 'direction', 'research', 'deepening', 'fusion', 'scaling'];
  if (largeSignals.some(s => tagStr.includes(s) || phaseStr.includes(s))) return MODEL_TIERS.LARGE;
  // 小模型可执行：TDD、测试、部署、代码审查、安全审计（步骤明确）
  const smallSignals = ['tdd', 'test', 'deploy', 'review', 'security', 'debug', 'fix', 'lint'];
  if (smallSignals.some(s => tagStr.includes(s) || phaseStr.includes(s))) return MODEL_TIERS.SMALL;
  // 强制执行的技能更适合小模型
  if (enfStr === 'strict' || enfStr === 'mandatory') return MODEL_TIERS.SMALL;
  return MODEL_TIERS.MEDIUM;
}

/**
 * @module runtime/skill/skill-router
 * @class SkillRouter
 * @extends EventEmitter
 * Skill自动发现、匹配、路由引擎。三层缓存（L1摘要/L2指令/L3资源），
 * 语义匹配，否定模式检测，内容去重，模型分级过滤。
 */
class SkillRouter extends EventEmitter {
  /**
   * 创建SkillRouter实例，初始化缓存、索引和配置选项。
   * @param {string} projectRoot - 项目根目录路径
   * @param {object} [options] - 配置选项
   * @param {number} [options.cacheMax=100] - 最大缓存条目数
   * @param {number} [options.cacheTTL=300000] - 缓存过期时间（毫秒）
   * @param {number} [options.summaryMaxLength=200] - 摘要最大长度
   * @param {number} [options.topK=5] - Top-K技能选择数量
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'SkillRouter');
    this.root = projectRoot;
    this._skillsDir = path.join(projectRoot, HARNESS_DIR, 'skills');
    this.skills = [];
    this.registry = {};
    this._agentSets = {};
    this._routeCache = null;
    this._l2Cache = new Map();
    this._l3Cache = new Map();
    this._cacheMax = (options && options.cacheMax) ?? DEFAULT_CACHE_MAX;
    this._cacheTTL = (options && options.cacheTTL) ?? DEFAULT_CACHE_TTL;
    this._summaryMaxLength = (options && options.summaryMaxLength) ?? DEFAULT_SUMMARY_MAX_LENGTH;
    this._deduplicationIndex = new Map();
    this._skillImprover = null;
    this._skillReducer = null;
    this._topK = (options && options.topK) ?? DEFAULT_TOP_K;
    this._tagIndex = new Map();
    this._stats = {
      l2Hits: 0,
      l2Misses: 0,
      l3Hits: 0,
      l3Misses: 0,
      l2Evictions: 0,
      l3Evictions: 0,
      deduplicationSavings: 0,
      totalTokenSavings: 0,
      specDrivenMatches: 0,
      tagFilterSkips: 0,
    };
    this._semanticIndex = this._buildSemanticIndex();
    this._skillSemanticCache = null;
  }

  _buildSemanticIndex() {
    const index = {};
    for (const [key, terms] of Object.entries(SEMANTIC_GROUPS)) {
      const lowerTerms = terms.map(t => t.toLowerCase());
      index[key] = lowerTerms;
    }
    return index;
  }

  _buildAgentIndex(skills) {
    const index = new Map();
    for (const skill of skills) {
      if (skill.infrastructure) continue;
      const agents = skill.applicable_agents;
      if (agents && agents.length > 0) {
        for (const agent of agents) {
          if (!index.has(agent)) index.set(agent, []);
          index.get(agent).push(skill);
        }
      } else {
        if (!index.has('_any')) index.set('_any', []);
        index.get('_any').push(skill);
      }
    }
    return index;
  }

  _buildTagIndex(skills) {
    const index = new Map();
    for (const skill of skills) {
      const tags = skill.tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        if (!index.has(tag)) index.set(tag, []);
        index.get(tag).push(skill);
      }
    }
    return index;
  }

  _buildSkillSemanticCache() {
    const cache = {};
    const semanticKeys = Object.keys(this._semanticIndex);
    for (const skill of this.skills) {
      const skillId = skill.skill_id ?? '';
      for (const k of semanticKeys) {
        if (skillId.includes(k)) {
          cache[skillId] = k;
          break;
        }
      }
    }
    return cache;
  }

  _getSemanticKey(skillId) {
    if (this._skillSemanticCache && skillId in this._skillSemanticCache) {
      return this._skillSemanticCache[skillId] ?? null;
    }
    const semanticKeys = Object.keys(this._semanticIndex);
    for (const k of semanticKeys) {
      if (skillId.includes(k)) return k;
    }
    return null;
  }

  /**
   * 挂载SkillImprover实例，用于在match时注入学习经验
   * @param {Object} improver - SkillImprover实例
   * @returns {SkillRouter} 当前实例，支持链式调用
   */
  attachSkillImprover(improver) {
    this._skillImprover = improver;
    return this;
  }

  /**
   * 挂载SkillReducer实例，用于联动动态技能管理。
   * @param {SkillReducer} reducer - SkillReducer实例
   * @returns {SkillRouter} this（链式调用）
   */
  attachSkillReducer(reducer) {
    this._skillReducer = reducer;
    return this;
  }

  /**
   * 从匹配结果中选择Top-K个最相关技能，核心技能优先占位。
   * @param {Object} context - 匹配上下文
   * @param {number} [k] - 选择的技能数量上限，默认为构造时的topK配置
   * @returns {SkillDef[]} Top-K匹配结果
   */
  matchTopK(context, k) {
    const topK = k ?? this._topK;
    if (topK <= 0) return [];
    const allMatches = this.match(context);
    if (allMatches.length <= topK) return allMatches;

    const coreTaken = new Set();
    const domainTaken = new Set();
    let coreCount = 0;

    for (const m of allMatches) {
      if (m.category === SKILL_LAYER_CORE && coreCount < topK) {
        coreTaken.add(m.skill_id);
        coreCount++;
      }
    }

    const domainSlots = topK - coreTaken.size;
    let domainCount = 0;
    for (const m of allMatches) {
      if (m.category !== SKILL_LAYER_CORE && m.category !== 'infrastructure' && domainCount < domainSlots) {
        domainTaken.add(m.skill_id);
        domainCount++;
      }
    }

    const taken = new Set([...coreTaken, ...domainTaken]);
    return allMatches.filter(m => taken.has(m.skill_id));
  }

  /**
   * 扫描.harness/skills/目录，解析所有Skill文件的YAML Frontmatter。
   * @returns {SkillDef[]} 非基础设施的Skill列表（不含skill-router和session-start-hook）
   */
  discover() {
    this.guardShutdown();
    const skillsDir = this._skillsDir;
    const files = scanSkillFilesSync(skillsDir, 'SkillRouter', this);
    if (!files) return [];

    const parsed = this._parseSkillFiles(files, skillsDir, parseSkillFileSync, 'discover');
    return this._applyDiscoveredSkills(parsed);
  }

  /**
   * Asynchronously scan .harness/skills/ directory and parse all Skill files.
   * @returns {Promise<SkillDef[]>} Non-infrastructure Skill list (excludes skill-router and session-start-hook)
   */
  async discoverAsync() {
    this.guardShutdown();
    const skillsDir = this._skillsDir;
    const files = await scanSkillFilesAsync(skillsDir, 'SkillRouter', this);
    if (this._shutDown) return [];
    if (!files) return [];

    const parsed = await this._parseSkillFilesAsync(files, skillsDir, 'discoverAsync');
    return this._applyDiscoveredSkills(parsed);
  }

  _parseSkillFiles(files, skillsDir, parseFn, label) {
    const newSkills = [];
    const newRegistry = {};
    const newAgentSets = {};
    const contentMap = {};

    for (const file of files) {
      try {
        const filePath = path.join(skillsDir, file);
        const { content, fm } = parseFn(filePath);
        if (!fm) continue;

        const skill = this._buildSkillFromFrontmatter(file, fm, content, filePath);
        if (newRegistry[skill.skill_id]) {
          debug('SkillRouter', label, 'Duplicate skill_id: ' + skill.skill_id);
        }
        newSkills.push(skill);
        newRegistry[skill.skill_id] = skill;
        newAgentSets[skill.skill_id] = new Set(skill.applicable_agents);
        contentMap[skill.skill_id] = content;
      } catch (err) {
        debug('SkillRouter', label, err);
        emitError(this, 'skill-load-error', err, { file });
      }
    }
    return { newSkills, newRegistry, newAgentSets, contentMap };
  }

  async _parseSkillFilesAsync(files, skillsDir, label) {
    return this._parseSkillFilesWith(parseSkillFileAsync, files, skillsDir, label);
  }

  async _parseSkillFilesWith(parseFn, files, skillsDir, label) {
    const newSkills = [];
    const newRegistry = {};
    const newAgentSets = {};
    const contentMap = {};

    for (const file of files) {
      try {
        const filePath = path.join(skillsDir, file);
        const { content, fm } = await parseFn(filePath);
        if (!fm) continue;

        const skill = this._buildSkillFromFrontmatter(file, fm, content, filePath);
        if (newRegistry[skill.skill_id]) {
          debug('SkillRouter', label, 'Duplicate skill_id: ' + skill.skill_id);
        }
        newSkills.push(skill);
        newRegistry[skill.skill_id] = skill;
        newAgentSets[skill.skill_id] = new Set(skill.applicable_agents);
        contentMap[skill.skill_id] = content;
      } catch (err) {
        debug('SkillRouter', label, err);
        emitError(this, 'skill-load-error', err, { file });
      }
    }
    return { newSkills, newRegistry, newAgentSets, contentMap };
  }

  _applyDiscoveredSkills({ newSkills, newRegistry, newAgentSets, contentMap }) {
    this.skills = newSkills;
    this.registry = newRegistry;
    this._agentSets = newAgentSets;
    this._agentIndex = this._buildAgentIndex(newSkills);
    this._tagIndex = this._buildTagIndex(newSkills);
    this._routeCache = null;
    this._l2Cache.clear();
    this._l3Cache.clear();
    this._skillSemanticCache = this._buildSkillSemanticCache();
    this._buildDeduplicationIndex(contentMap);
    return this.skills.filter(s => !s.infrastructure);
  }

  _parseNumericField(value, parser, fallback) {
    const result = parser(value);
    return typeof result === 'number' && Number.isFinite(result) ? result : fallback;
  }

  _parseCausalField(value) {
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === 'object') return [value];
    if (typeof value === 'string') {
      if (value.startsWith('[') && value.endsWith(']')) {
        return value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
      return value ? [value] : [];
    }
    return [];
  }

  _buildSkillFromFrontmatter(file, fm, content, filePath) {
    const base = buildBaseSkillEntry(file, fm, content, filePath, this._summaryMaxLength);

    return {
      ...base,
      applicable_agents: parseArray(fm.applicable_agents) ?? [],
      trigger: fm.trigger ?? '',
      auto_trigger: fm.auto_trigger === FRONTMATTER_TRUE || fm.auto_trigger === true,
      priority: this._parseNumericField(fm.priority, parseInt, 0),
      trigger_conditions: parseArray(fm.trigger_conditions) ?? [],
      depends_on: parseArray(fm.depends_on) ?? [],
      blocks: parseArray(fm.blocks) ?? [],
      enforcement: fm.enforcement ?? DEFAULT_ENFORCEMENT,
      category: this._classifySkill(base.skill_id),
      verified: fm.verified === FRONTMATTER_TRUE || fm.verified === true,
      stability: fm.stability ?? 'unverified',
      usage_count: this._parseNumericField(fm.usage_count, parseInt, 0),
      success_rate: this._parseNumericField(fm.success_rate, parseFloat, 0),
      causal_inputs: this._parseCausalField(fm.causal_inputs),
      causal_outputs: this._parseCausalField(fm.causal_outputs),
      causal_invariants: this._parseCausalField(fm.causal_invariants),
      invariants: parseArray(fm.invariants) ?? [],
      specification_required: fm.specification_required === true || fm.specification_required === 'true',
      specification_type: fm.specification_type ?? null,
      modelTier: fm.model_tier || fm.modelTier || null,
    };
  }

  _findMatchingSkills(agent, safeMessage, completedSet, filterTags) {
    const matches = [];
    const candidateSkills = this._agentIndex
      ? (this._agentIndex.get(agent) ?? []).concat(this._agentIndex.get('_any') ?? [])
      : this.skills;

    const hasTagFilter = Array.isArray(filterTags) && filterTags.length > 0;
    const tagSet = hasTagFilter ? new Set(filterTags) : null;

    for (const skill of candidateSkills) {
      if (skill.infrastructure) continue;
      if (!this._agentIndex) {
        const agentSet = this._agentSets[skill.skill_id];
        if (agentSet && agentSet.size > 0 && !agentSet.has(agent)) continue;
      }

      if (tagSet && Array.isArray(skill.tags) && skill.tags.length > 0) {
        const hasMatch = skill.tags.some(t => tagSet.has(t));
        if (!hasMatch) {
          this._stats.tagFilterSkips++;
          continue;
        }
      }

      const triggered = this._checkTriggerConditions(skill, safeMessage, completedSet);
      if (!triggered) continue;

      if (!this._checkCausalInputs(skill, completedSet) && !this._hasKeywordTrigger(skill, safeMessage)) continue;

      matches.push(skill);
    }
    return matches;
  }

  _normalizeMatchInput(context) {
    if (!context || typeof context !== 'object') return null;
    const { userMessage = '', agent = '', completedSkills = [], tags } = context;
    const safeMessage = typeof userMessage === 'string' ? userMessage.slice(0, MAX_MESSAGE_LENGTH) : String(userMessage || '').slice(0, MAX_MESSAGE_LENGTH);
    const safeCompleted = ensureArray(completedSkills);
    const safeTags = Array.isArray(tags) ? tags.map(t => String(t).toLowerCase()) : [];
    const specificationState = context.specificationState || { activeSpecs: [], verifiedSpecs: [], staleSpecs: [] };
    return { safeMessage, agent, safeCompleted, safeTags, specificationState };
  }

  _buildRouteCacheKey(agent, safeMessage, safeCompleted, specificationState, safeTags) {
    const specKey = JSON.stringify({
      active: specificationState.activeSpecs ?? [],
      stale: specificationState.staleSpecs ?? [],
    });
    const msgHash = safeMessage.length > 200 ? safeMessage.slice(0, 200) + ':' + safeMessage.length : safeMessage;
    return JSON.stringify([agent, msgHash, safeCompleted, specKey, safeTags]);
  }

  _lookupRouteCache(cacheKey) {
    if (!this._routeCache) return null;
    const cached = this._routeCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt <= this._cacheTTL) return cached.result;
    if (cached) this._routeCache.delete(cacheKey);
    return null;
  }

  _storeRouteCache(cacheKey, result) {
    if (!this._routeCache) {
      this._routeCache = new Map();
    }
    if (this._routeCache.size >= this._cacheMax) {
      const oldest = this._routeCache.keys().next().value;
      this._routeCache.delete(oldest);
    }
    this._routeCache.set(cacheKey, { result, loadedAt: Date.now() });
  }

  /**
   * 根据上下文匹配适用的Skill。
   * @param {MatchContext} context - 匹配上下文
   * @param {string} context.userMessage - 用户消息文本
   * @param {string} context.agent - 当前Agent角色ID（如'task-worker'）
   * @param {string[]} [context.completedSkills=[]] - 已完成的Skill ID列表
   * @returns {SkillDef[]} 匹配的Skill列表，按阶段优先级和priority排序
   * @example
   * const router = new SkillRouter(projectRoot);
   * router.discover();
   * const matches = router.match({
   *   userMessage: '帮我验证代码质量',
   *   agent: 'quality-reviewer'
   * });
   * matches.forEach(m => console.log(m.skill, m.confidence));
   */
  match(context) {
    const input = this._normalizeMatchInput(context);
    if (!input) return [];

    const cacheKey = this._buildRouteCacheKey(input.agent, input.safeMessage, input.safeCompleted, input.specificationState, input.safeTags);
    const cached = this._lookupRouteCache(cacheKey);
    if (cached) return cached;

    const completedSet = new Set(input.safeCompleted);
    let matches;
    try {
      matches = this._findMatchingSkills(input.agent, input.safeMessage, completedSet, input.safeTags);
    } catch (err) {
      debug('SkillRouter', 'match', 'findMatchingSkills error:', err && err.message ? err.message : String(err));
      return [];
    }

    matches = this._applySpecBoost(matches, input.specificationState);

    // 模型分级过滤：根据当前模型能力过滤技能
    if (input.modelTier) {
      const maxTierPriority = TIER_PRIORITY[input.modelTier] ?? TIER_PRIORITY[MODEL_TIERS.MEDIUM];
      matches = matches.filter(skill => {
        const skillTier = skill.modelTier || inferModelTier(skill);
        return (TIER_PRIORITY[skillTier] ?? 1) <= maxTierPriority;
      });
    }

    const result = matches.sort((a, b) => {
      if (a.phase !== b.phase) return this._phaseOrder(a.phase) - this._phaseOrder(b.phase);
      return a.priority - b.priority;
    }).map(skill => {
      try {
        const depResult = this.checkDependencies(skill.skill_id, completedSet);
        const enriched = this._enrichWithLearnings(skill);
        if (!depResult.satisfied) {
          return mergeConfig(enriched, { dependencyBlocked: true, missingDependencies: depResult.missing });
        }
        return enriched;
      } catch (err) {
        debug('SkillRouter', 'match', 'enrichment error for ' + skill.skill_id + ':', err && err.message ? err.message : String(err));
        return skill;
      }
    });

    this._storeRouteCache(cacheKey, result);
    return result;
  }

  /**
   * Enrich a skill definition with learned tips and avoidances from the SkillImprover.
   * @private
   * @param {SkillDef} skill - Skill definition to enrich
   * @returns {SkillDef} Enriched skill with learnedTips and learnedAvoidances, or the original if no learnings
   */
  _enrichWithLearnings(skill) {
    if (!this._skillImprover) return skill;
    const tips = this._skillImprover.getTips(skill.skill_id);
    const avoidances = this._skillImprover.getAvoidances(skill.skill_id);
    if (tips.length === 0 && avoidances.length === 0) return skill;
    return mergeConfig(skill, {
      learnedTips: tips,
      learnedAvoidances: avoidances,
    });
  }

  /**
   * 解决多个匹配Skill之间的冲突，返回优先级最高的一个。
   * @param {SkillDef[]} matches - match()返回的匹配列表
   * @returns {SkillDef|null} 优先级最高的Skill，或null
   */
  resolveConflict(matches) {
    if (!Array.isArray(matches) || matches.length === 0) return null;
    return matches[0];
  }

  /**
   * 检查Skill的依赖是否已满足。
   * @param {string} skillId - 要检查的Skill ID
   * @param {string[]} completedSkills - 已完成的Skill ID列表
   * @returns {{ satisfied: boolean, missing: string[] }}
   */
  checkDependencies(skillId, completedSkills) {
    const skill = this.registry[skillId];
    if (!skill) return { satisfied: false, missing: ['Skill ' + skillId + ' not found'] };
    const completedSet = completedSkills instanceof Set
      ? completedSkills
      : new Set(ensureArray(completedSkills));
    const missing = skill.depends_on.filter(dep => !completedSet.has(dep));
    return {
      satisfied: missing.length === 0,
      missing,
    };
  }

  /**
   * 验证重构前后上下文的行为等价性，检查因果输出定义的技能在重构后是否保持行为一致
   * @param {string} skillId - 技能ID
   * @param {Object} [beforeContext] - 重构前的上下文快照
   * @param {Object} [afterContext] - 重构后的上下文快照
   * @returns {{ valid: boolean, skillId: string, checks: Array, summary: string }} 等价性验证结果
   */
  validateBehaviorEquivalence(skillId, beforeContext, afterContext) {
    const skill = this.registry[skillId];
    if (!skill) return { valid: false, reason: 'skill not found' };
    if (!skill.causal_outputs || skill.causal_outputs.length === 0) {
      return { valid: true, reason: 'no causal outputs defined' };
    }
    const requiredOutputs = skill.causal_outputs.filter(o => {
      const name = typeof o === 'object' && o !== null ? o.name : o;
      return name === 'behavior-equivalence-report' || name === 'refactored-code';
    });
    if (requiredOutputs.length === 0) {
      return { valid: true, reason: 'no behavior equivalence outputs' };
    }
    const checks = [];
    if (beforeContext && afterContext) {
      const beforeKeys = Object.keys(beforeContext);
      for (const key of beforeKeys) {
        if (key === 'timestamp') continue;
        const bv = beforeContext[key];
        const av = afterContext[key];
        let changed;
        if (bv === av) {
          changed = false;
        } else if (typeof bv !== 'object' || bv === null || typeof av !== 'object' || av === null) {
          changed = true;
        } else {
          changed = stableStringify(bv) !== stableStringify(av);
        }
        checks.push({ key, changed });
      }
    }
    const allEquivalent = checks.length > 0 && checks.every(c => !c.changed);
    return {
      valid: allEquivalent,
      skillId,
      checks,
      summary: allEquivalent
        ? 'All behavior checks passed - refactoring preserved behavior'
        : checks.length === 0
          ? 'No context provided for behavior equivalence comparison'
          : checks.filter(c => c.changed).map(c => c.key).join(', ') + ' changed after refactoring',
    };
  }

  /**
   * 验证部署检查清单的完整性，检查部署类技能是否满足所有必需检查项
   * @param {string} skillId - 技能ID
   * @param {Object} [checklistData] - 检查清单数据，键为检查项名称，值为boolean
   * @returns {{ valid: boolean, skillId: string, checkedItems: string[], missingItems: string[], completionRate: number, summary: string }} 验证结果
   */
  validateDeploymentChecklist(skillId, checklistData) {
    const skill = this.registry[skillId];
    if (!skill) return { valid: false, reason: 'skill not found' };
    const hasChecklistOutput = skill.causal_outputs && skill.causal_outputs.some(o => {
      const name = typeof o === 'object' && o !== null ? o.name : o;
      return name === 'deployment-checklist';
    });
    if (!hasChecklistOutput) {
      return { valid: true, reason: 'not a deployment skill' };
    }
    const requiredItems = [
      'all-tests-passed',
      'code-merged-to-shared',
      'environment-config-verified',
      'rollback-plan-ready',
      'health-check-passed',
      'smoke-test-passed',
      'monitoring-configured',
    ];
    if (!checklistData || typeof checklistData !== 'object') {
      return { valid: false, reason: 'checklist data required', checkedItems: [], missingItems: requiredItems };
    }
    const checkedItems = [];
    const missingItems = [];
    for (const item of requiredItems) {
      if (checklistData[item] === true || checklistData[item] === 'true') {
        checkedItems.push(item);
      } else {
        missingItems.push(item);
      }
    }
    return {
      valid: missingItems.length === 0,
      skillId,
      checkedItems,
      missingItems,
      completionRate: requiredItems.length > 0 ? checkedItems.length / requiredItems.length : 1,
      summary: missingItems.length === 0
        ? 'All deployment checklist items verified'
        : 'Missing: ' + missingItems.join(', '),
    };
  }

  /**
   * 获取指定Skill的定义。
   * @param {string} skillId - Skill ID
   * @returns {SkillDef|null}
   */
  getSkill(skillId) {
    return this.registry[skillId] ?? null;
  }

  /** @private */
  _checkCausalInputs(skill, completedSet) {
    if (!skill.causal_inputs || skill.causal_inputs.length === 0) return true;
    const requiredInputs = skill.causal_inputs.filter(function(input) { return input.required === true; });
    if (requiredInputs.length === 0) return true;
    const availableOutputs = new Set();
    for (const id of completedSet) {
      const completed = this.registry[id];
      if (completed && completed.causal_outputs) {
        for (const output of completed.causal_outputs) {
          availableOutputs.add(output.name || output);
        }
      }
    }
    return requiredInputs.every(function(input) { return availableOutputs.has(input.name || input); });
  }

  _hasKeywordTrigger(skill, userMessage) {
    return this._matchKeywordsInConditions(skill.trigger_conditions, userMessage.toLowerCase(), userMessage);
  }

  /** @private */
  _checkTriggerConditions(skill, userMessage, completedSet) {
    const msgLower = userMessage.toLowerCase();

    if (this._isNegated(skill, userMessage)) {
      return false;
    }

    if (this._matchKeywordsInConditions(skill.trigger_conditions, msgLower, userMessage)) {
      return true;
    }

    return (this._semanticMatch(skill.skill_id, userMessage))
      || (skill.depends_on.length > 0 && skill.depends_on.every(d => completedSet.has(d)))
      || (this._checkAutoTrigger(skill, userMessage));
  }

  _matchKeywordsInConditions(conditions, msgLower, userMessage) {
    for (const cond of conditions) {
      const keywords = this._extractKeywords(cond);
      for (const kw of keywords) {
        if (kw.length <= MIN_KEYWORD_LENGTH) continue;
        if (msgLower.includes(kw.toLowerCase()) || userMessage.includes(kw)) {
          return true;
        }
      }

      if (msgLower.length > MIN_MESSAGE_LENGTH_FOR_WORD_MATCH) {
        const condLower = cond.toLowerCase();
        const words = condLower.split(/\s+/);
        for (const word of words) {
          if (word.length > MIN_WORD_LENGTH_FOR_MATCH && msgLower.includes(word)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  _checkAutoTrigger(skill, userMessage) {
    if (!skill.auto_trigger || skill.depends_on.length > 0) return false;
    const phase = skill.phase ?? '';
    const msgLower = userMessage.toLowerCase();
    if (phase === 'brainstorming' || phase === 'requirement-analysis') {
      for (const kwLower of AUTO_TRIGGER_PROJECT_KEYWORDS_LOWER) {
        if (msgLower.includes(kwLower)) return true;
      }
    }
    if (phase === 'module-development') {
      for (const kwLower of AUTO_TRIGGER_MODULE_KEYWORDS_LOWER) {
        if (msgLower.includes(kwLower)) return true;
      }
    }
    return false;
  }

  /** @private */
  _isNegated(skill, userMessage) {
    const skillId = skill.skill_id ?? '';
    const semanticKey = this._getSemanticKey(skillId);
    if (!semanticKey) return false;

    const lowerTerms = this._semanticIndex[semanticKey];
    const match = userMessage.match(NEGATION_PATTERN);
    if (match) {
      const afterNegation = userMessage.slice(match.index + match[0].length).trim().toLowerCase();
      for (const term of lowerTerms) {
        if (afterNegation.includes(term)) {
          return true;
        }
      }
    }
    return false;
  }

  _semanticMatch(skillId, userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const msgLower = userMessage.toLowerCase();
    if (msgLower.length === 0) return false;
    const semanticKey = this._getSemanticKey(skillId);
    if (!semanticKey) return false;

    const lowerTerms = this._semanticIndex[semanticKey];
    for (const term of lowerTerms) {
      if (msgLower.includes(term)) {
        return true;
      }
    }
    return false;
  }

  /** @private */
  _extractKeywords(condition) {
    const quoted = [];
    const regex = /[""\u201c\u201d]([^""\u201c\u201d]+)[""\u201c\u201d]/g;
    let m;
    while ((m = regex.exec(condition)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue; }
      quoted.push(m[1]);
    }

    if (quoted.length > 0) return quoted;

    const orParts = condition.split(/\bor\b/i);
    const keywords = [];
    for (const part of orParts) {
      const trimmed = part.trim();
      if (trimmed.length > 1 && trimmed.length < 50) {
        keywords.push(trimmed);
      }
    }
    return keywords.length > 0 ? keywords : [condition];
  }

  /**
   * Clean up all caches, watchers, and internal state on shutdown.
   * @private
   * @returns {void}
   */
  _onShutdown() {
    this.skills = [];
    this.registry = {};
    this._agentSets = {};
    this._tagIndex = new Map();
    this._routeCache = null;
    this._cleanupExpiredCache();
    this._l2Cache.clear();
    this._l3Cache.clear();
    this._deduplicationIndex.clear();
    this.removeAllListeners();
    if (this._watchDebounceTimer) {
      clearTimeout(this._watchDebounceTimer);
      this._watchDebounceTimer = null;
    }
    if (this._watcher) {
      if (typeof this._watcher.removeAllListeners === 'function') {
        this._watcher.removeAllListeners();
      }
      if (typeof this._watcher.close === 'function') {
        this._watcher.close();
      } else {
        clearInterval(this._watcher);
      }
      this._watcher = null;
    }
  }

  _cleanupExpiredCache() {
    const now = Date.now();
    const expiredL2 = [];
    for (const [key, entry] of this._l2Cache) {
      if (now - entry.loadedAt > this._cacheTTL) expiredL2.push(key);
    }
    for (const key of expiredL2) this._l2Cache.delete(key);
    const expiredL3 = [];
    for (const [key, entry] of this._l3Cache) {
      if (now - entry.loadedAt > this._cacheTTL) expiredL3.push(key);
    }
    for (const key of expiredL3) this._l3Cache.delete(key);
  }

  /**
   * 检查SkillRouter健康状态，至少有一个已发现技能时为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() { return !this._shutDown && this.skills.length > 0; }

  /**
   * Watch the skills directory for changes and auto-reload when files are modified.
   * Falls back to mtime-based or access-based polling if fs.watch fails.
   * @param {number} [interval] - Polling interval in ms for fallback watchers
   * @returns {void}
   */
  watchForChanges(interval) {
    if (this._watcher) return;
    const skillsDir = this._skillsDir;
    try {
      if (!fs.existsSync(skillsDir)) return;
    } catch (err) { debug('SkillRouter', 'watchForChanges', 'existsSync failed', err && err.message ? err.message : String(err)); return; }

    this._watchDebounceTimer = null;
    const self = this;

    const onChange = function(eventType, filename) {
      if (self._shutDown) return;
      if (!filename || !filename.endsWith('.md')) return;
      if (self._watchDebounceTimer) clearTimeout(self._watchDebounceTimer);
      self._watchDebounceTimer = setTimeout(async function() {
        self._watchDebounceTimer = null;
        if (self._shutDown) return;
        try {
          await self.discoverAsync();
          self.emit('skills-reloaded', { skillCount: self.skills.length, trigger: filename });
        } catch (err) { debug('SkillRouter', 'watchForChangesReload', err); }
      }, DEFAULT_PERSIST_DEBOUNCE_MS);
      if (self._watchDebounceTimer && typeof self._watchDebounceTimer.unref === 'function') self._watchDebounceTimer.unref();
    };

    try {
      this._watcher = fs.watch(skillsDir, { persistent: false, recursive: false }, onChange);
      this._watcher.on('error', function(err) {
        debug('SkillRouter', 'watchError', err);
        const oldWatcher = self._watcher;
        self._watcher = null;
        try { if (oldWatcher && typeof oldWatcher.close === 'function') oldWatcher.close(); } catch (closeErr) { debug('SkillRouter', 'watchCloseError', closeErr); }
        try { self._watcher = self._startMtimeFallbackPolling(skillsDir, interval); } catch (fallbackErr) { debug('SkillRouter', 'watchFallbackError', fallbackErr); }
      });
    } catch (err) {
      debug('SkillRouter', 'watchInitError', err);
      this._watcher = this._startAccessFallbackPolling(skillsDir, interval);
    }
  }

  _startMtimeFallbackPolling(skillsDir, interval) {
    const self = this;
    const fallbackInterval = interval ?? DEFAULT_FALLBACK_INTERVAL_MS;
    let pollingInProgress = false;
    const timer = setInterval(async function() {
      if (self._shutDown) return;
      if (pollingInProgress) return;
      pollingInProgress = true;
      try {
        const files = await (async function() {
          try { return fs.promises.readdir(skillsDir); } catch (e) { debug('SkillRouter', 'watchReaddir', e && e.message ? e.message : String(e)); return []; }
        })();
        const mdFiles = files.filter(f => f.endsWith('.md'));
        let maxMtime = 0;
        for (const file of mdFiles) {
          try {
            const stat = await fs.promises.stat(path.join(skillsDir, file));
            if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
          } catch (e) { debug('SkillRouter', 'watchStat', e && e.message ? e.message : String(e)); }
        }
        if (self._lastWatchMtime === undefined) self._lastWatchMtime = 0;
        if (self._lastWatchMtime > 0 && maxMtime > self._lastWatchMtime) {
          await self.discoverAsync();
          self.emit('skills-reloaded', { skillCount: self.skills.length, mtime: maxMtime });
        }
        self._lastWatchMtime = maxMtime;
      } catch (watchErr) { debug('SkillRouter', 'watchFallback', watchErr); }
      finally { pollingInProgress = false; }
    }, fallbackInterval);
    if (timer && typeof timer.unref === 'function') { timer.unref(); }
    return timer;
  }

  _startAccessFallbackPolling(skillsDir, interval) {
    const self = this;
    const fallbackInterval = interval ?? DEFAULT_FALLBACK_INTERVAL_MS;
    let pollingInProgress = false;
    const timer = setInterval(async function() {
      if (self._shutDown) return;
      if (pollingInProgress) return;
      pollingInProgress = true;
      try {
        try { await fs.promises.access(skillsDir); } catch (_err) { debug('SkillRouter', 'watchFallback: access failed', _err && _err.message ? _err.message : String(_err)); return; }
        await self.discoverAsync();
        self.emit('skills-reloaded', { skillCount: self.skills.length });
      } catch (watchErr) { debug('SkillRouter', 'watchFallback', watchErr); }
      finally { pollingInProgress = false; }
    }, fallbackInterval);
    if (timer && typeof timer.unref === 'function') { timer.unref(); }
    return timer;
  }

  _loadL2With(skillId, readFn) {
    const cached = this._getCachedL2(skillId);
    if (cached) {
      this._stats.l2Hits++;
      return cached;
    }

    this._stats.l2Misses++;
    const skill = this.registry[skillId];
    if (!skill || !skill._filePath) return null;

    return safeExecute(() => {
      const rawContent = readFn(skill._filePath, UTF8_ENCODING);
      const instructionBody = extractMarkdownBody(rawContent);
      const l2Entry = {
        skill_id: skillId,
        name: skill.name,
        instruction: instructionBody,
        loadedAt: Date.now(),
        tokenEstimate: estimateTokens(instructionBody),
      };
      this._putL2Cache(skillId, l2Entry);
      this._stats.totalTokenSavings += rawContent.length - instructionBody.length;
      return l2Entry;
    }, 'SkillRouter', 'loadL2', null);
  }

  /**
   * 同步加载指定技能的L2指令层（Markdown正文），优先从缓存读取
   * @param {string} skillId - 技能ID
   * @returns {Object|null} L2条目对象，包含skill_id、name、instruction、loadedAt、tokenEstimate；加载失败返回null
   */
  loadL2(skillId) {
    return this._loadL2With(skillId, (p, enc) => fs.readFileSync(p, enc));
  }

  /**
   * 异步加载指定技能的L2指令层（Markdown正文），优先从缓存读取
   * @param {string} skillId - 技能ID
   * @returns {Promise<Object|null>} L2条目对象的Promise，加载失败返回null
   */
  async loadL2Async(skillId) {
    const cached = this._getCachedL2(skillId);
    if (cached) {
      this._stats.l2Hits++;
      return cached;
    }

    this._stats.l2Misses++;
    const skill = this.registry[skillId];
    if (!skill || !skill._filePath) return null;

    return safeExecuteAsync(async () => {
      const content = await fs.promises.readFile(skill._filePath, UTF8_ENCODING);
      return this._loadL2With(skillId, () => content);
    }, 'SkillRouter', 'loadL2Async', null);
  }

  /**
   * 从L2缓存中卸载指定技能的指令层
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否成功卸载
   */
  unloadL2(skillId) {
    const evicted = this._l2Cache.delete(skillId);
    if (evicted) this._stats.l2Evictions++;
    return evicted;
  }

  _loadL3With(skillId, resourcePath, { validateFn, existsFn, readFn }) {
    const cacheKey = `${skillId}:${resourcePath ?? 'default'}`;
    const cached = this._getCachedL3(cacheKey);
    if (cached) {
      this._stats.l3Hits++;
      return cached;
    }

    this._stats.l3Misses++;
    const skill = this.registry[skillId];
    if (!skill || !skill._filePath) return null;

    return safeExecute(() => {
      const resourceFile = resolveResourcePath(skill._filePath, resourcePath);
      const validation = validateFn(resourceFile, { rootDir: path.dirname(skill._filePath) });
      if (!validation.valid) {
        debug('SkillRouter', 'loadL3', validation.reason + ': ' + resourcePath);
        return null;
      }
      if (!existsFn(resourceFile)) return null;
      const content = readFn(resourceFile, UTF8_ENCODING);
      const l3Entry = buildL3Entry(skillId, resourcePath, content);
      this._putL3Cache(cacheKey, l3Entry);
      return l3Entry;
    }, 'SkillRouter', 'loadL3', null);
  }

  /**
   * 同步加载指定技能的L3资源层（引用文件），优先从缓存读取，内置路径遍历防护
   * @param {string} skillId - 技能ID
   * @param {string} [resourcePath] - 相对于技能目录的资源路径
   * @returns {Object|null} L3条目对象，包含skill_id、resourcePath、content、tokenEstimate；加载失败返回null
   */
  loadL3(skillId, resourcePath) {
    return this._loadL3With(skillId, resourcePath, {
      validateFn: (p, opts) => validatePath(p, opts),
      existsFn: (p) => fs.existsSync(p),
      readFn: (p, enc) => fs.readFileSync(p, enc),
    });
  }

  /**
   * 异步加载指定技能的L3资源层（引用文件），优先从缓存读取，内置路径遍历防护
   * @param {string} skillId - 技能ID
   * @param {string} [resourcePath] - 相对于技能目录的资源路径
   * @returns {Promise<Object|null>} L3条目对象的Promise，加载失败返回null
   */
  async loadL3Async(skillId, resourcePath) {
    const cacheKey = `${skillId}:${resourcePath ?? 'default'}`;
    const cached = this._getCachedL3(cacheKey);
    if (cached) {
      this._stats.l3Hits++;
      return cached;
    }

    this._stats.l3Misses++;
    const skill = this.registry[skillId];
    if (!skill || !skill._filePath) return null;

    return safeExecuteAsync(async () => {
      const resourceFile = resolveResourcePath(skill._filePath, resourcePath);
      const validation = await validatePathAsync(resourceFile, { rootDir: path.dirname(skill._filePath) });
      if (this._shutDown) return null;
      if (!validation.valid) {
        debug('SkillRouter', 'loadL3', validation.reason + ': ' + resourcePath);
        return null;
      }
      try { await fs.promises.access(resourceFile); } catch (_err) { debug('SkillRouter', 'loadL3Async:access', _err && _err.message ? _err.message : String(_err)); return null; }
      const content = await fs.promises.readFile(resourceFile, UTF8_ENCODING);
      if (this._shutDown) return null;
      return this._loadL3With(skillId, resourcePath, {
        validateFn: () => validation,
        existsFn: () => true,
        readFn: () => content,
      });
    }, 'SkillRouter', 'loadL3Async', null);
  }

  /**
   * 批量预加载多个技能的L2指令层到缓存
   * @param {string[]} skillIds - 需要预加载的技能ID数组
   * @returns {string[]} 成功加载的技能ID数组
   */
  preloadL2(skillIds) {
    const loaded = [];
    for (const id of skillIds) {
      const result = this.loadL2(id);
      if (result) loaded.push(id);
    }
    return loaded;
  }

  /**
   * 估算当前三层缓存的总Token占用量，支持按标签过滤
   * @param {string[]} [filterTags] - 可选的标签过滤数组，仅统计包含匹配标签的技能
   * @returns {{ l1Tokens: number, l2Tokens: number, l3Tokens: number, totalTokens: number, tagSavings: Object }} Token估算结果
   */
  getContextEstimate(filterTags) {
    let l1Tokens = 0;
    let l1SkippedTokens = 0;
    let l1SkippedCount = 0;
    const hasTagFilter = Array.isArray(filterTags) && filterTags.length > 0;
    const tagSet = hasTagFilter ? new Set(filterTags.map(t => String(t).toLowerCase())) : null;

    for (const skill of this.skills) {
      const skillTokens = estimateTokens(skill.name + (skill.summary ?? ''));
      if (tagSet && Array.isArray(skill.tags) && skill.tags.length > 0) {
        const hasMatch = skill.tags.some(t => tagSet.has(t));
        if (!hasMatch) {
          l1SkippedTokens += skillTokens;
          l1SkippedCount++;
          continue;
        }
      }
      l1Tokens += skillTokens;
    }

    let l2Tokens = 0;
    for (const [, entry] of this._l2Cache) {
      l2Tokens += entry.tokenEstimate ?? 0;
    }

    let l3Tokens = 0;
    for (const [, entry] of this._l3Cache) {
      l3Tokens += entry.tokenEstimate ?? 0;
    }

    return {
      l1Tokens,
      l2Tokens,
      l3Tokens,
      totalTokens: l1Tokens + l2Tokens + l3Tokens,
      tagSavings: {
        skippedCount: l1SkippedCount,
        skippedTokens: l1SkippedTokens,
        savingsPercent: l1SkippedTokens + l1Tokens > 0
          ? Math.round((l1SkippedTokens / (l1SkippedTokens + l1Tokens)) * 10000) / 100
          : 0,
      },
    };
  }

  /**
   * 获取三层缓存的运行统计信息，包含命中率、淘汰数、Token节省量和上下文估算
   * @returns {Object} 缓存统计对象
   */
  getLayerStats() {
    return {
      l1Count: this.skills.length,
      l2Cached: this._l2Cache.size,
      l3Cached: this._l3Cache.size,
      l2Hits: this._stats.l2Hits,
      l2Misses: this._stats.l2Misses,
      l2HitRate: this._stats.l2Hits + this._stats.l2Misses > 0
        ? this._stats.l2Hits / (this._stats.l2Hits + this._stats.l2Misses) : 0,
      l3Hits: this._stats.l3Hits,
      l3Misses: this._stats.l3Misses,
      l2Evictions: this._stats.l2Evictions,
      l3Evictions: this._stats.l3Evictions,
      deduplicationSavings: this._stats.deduplicationSavings,
      totalTokenSavings: this._stats.totalTokenSavings,
      tagFilterSkips: this._stats.tagFilterSkips,
      contextEstimate: this.getContextEstimate(),
    };
  }

  _classifySkill(skillId) {
    if (CORE_SKILLS.has(skillId)) return 'core';
    if (EXTENSION_SKILLS.has(skillId)) return 'extension';
    return 'unknown';
  }

  /**
   * 获取所有已验证（verified=true）的技能列表
   * @returns {SkillDef[]} 已验证技能数组
   */
  getVerifiedSkills() {
    return this.skills.filter(s => s.verified);
  }

  /**
   * 按稳定度筛选技能列表
   * @param {string} stability - 稳定度标识（如'verified'、'unverified'、'experimental'）
   * @returns {SkillDef[]} 匹配稳定度的技能数组
   */
  getSkillsByStability(stability) {
    return this.skills.filter(s => s.stability === stability);
  }

  /**
   * 按标签筛选技能列表，排除基础设施类技能
   * @param {string} tag - 标签名称（不区分大小写）
   * @returns {SkillDef[]} 匹配标签的技能数组
   */
  getSkillsByTag(tag) {
    if (!tag || typeof tag !== 'string') return [];
    const lower = tag.toLowerCase();
    const tagged = this._tagIndex.get(lower);
    if (tagged) return tagged.filter(s => !s.infrastructure);
    return this.skills.filter(s => !s.infrastructure && Array.isArray(s.tags) && s.tags.includes(lower));
  }

  /**
   * 获取所有标签及其关联技能数量的映射，排除基础设施类技能
   * @returns {Map<string, number>} 标签到技能数量的映射
   */
  getAllTags() {
    const tagMap = new Map();
    for (const skill of this.skills) {
      if (skill.infrastructure) continue;
      if (!Array.isArray(skill.tags)) continue;
      for (const tag of skill.tags) {
        tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
      }
    }
    return tagMap;
  }

  _buildDeduplicationIndex(contentMap) {
    this._deduplicationIndex.clear();
    const contentChunks = new Map();

    for (const skill of this.skills) {
      if (!skill._filePath) continue;
      try {
        let body;
        if (contentMap && contentMap[skill.skill_id]) {
          body = extractMarkdownBody(contentMap[skill.skill_id]);
        } else if (skill.body) {
          body = skill.body;
        } else if (skill._body) {
          body = skill._body;
        } else {
          const parsed = parseMarkdownFile(skill._filePath);
          body = parsed ? parsed.body : '';
        }
        const paragraphs = body.split(/\n\n+/).filter(p => p.trim().length > 30);

        for (const para of paragraphs) {
          const normalized = para.trim().toLowerCase().replace(/\s+/g, ' ');
          const key = normalized.slice(0, DEDUP_KEY_LENGTH);
          if (!contentChunks.has(key)) {
            contentChunks.set(key, []);
          }
          contentChunks.get(key).push(skill.skill_id);
        }
      } catch (err) { debug('SkillRouter', 'getContentChunks', err); }
    }

    for (const [key, skillIds] of contentChunks) {
      if (skillIds.length > 1) {
        if (this._deduplicationIndex.size >= this._cacheMax) {
          const oldest = this._deduplicationIndex.keys().next().value;
          this._deduplicationIndex.delete(oldest);
        }
        this._deduplicationIndex.set(key, skillIds);
        this._stats.deduplicationSavings += key.length * (skillIds.length - 1);
      }
    }
  }

  /**
   * 获取内容去重报告，列出被多个技能共享的重复内容段落
   * @returns {{ duplicateGroups: number, details: Array }} 去重报告，包含重复组数和详细信息
   */
  getDeduplicationReport() {
    const duplicates = [];
    for (const [key, skillIds] of this._deduplicationIndex) {
      if (skillIds.length > 1) {
        duplicates.push({ contentPreview: key.slice(0, MAX_CONTENT_PREVIEW_LENGTH) + '...', sharedBy: skillIds });
      }
    }
    return { duplicateGroups: duplicates.length, details: duplicates.slice(0, 20) };
  }

  _getCachedFrom(cacheMap, key) {
    const entry = cacheMap.get(key);
    if (!entry) return null;
    if (Date.now() - entry.loadedAt > this._cacheTTL) {
      cacheMap.delete(key);
      return null;
    }
    cacheMap.delete(key);
    cacheMap.set(key, entry);
    return entry;
  }

  _putCache(cacheMap, key, entry, evictStatKey) {
    if (cacheMap.size >= this._cacheMax) {
      const oldest = cacheMap.keys().next().value;
      cacheMap.delete(oldest);
      this._stats[evictStatKey]++;
    }
    cacheMap.set(key, entry);
  }

  _getCachedL2(skillId) {
    return this._getCachedFrom(this._l2Cache, skillId);
  }

  _putL2Cache(skillId, entry) {
    this._putCache(this._l2Cache, skillId, entry, 'l2Evictions');
  }

  _getCachedL3(cacheKey) {
    return this._getCachedFrom(this._l3Cache, cacheKey);
  }

  _putL3Cache(cacheKey, entry) {
    this._putCache(this._l3Cache, cacheKey, entry, 'l3Evictions');
  }
}

/**
 * @typedef {Object} SkillDef
 * @property {string} skill_id - Skill唯一标识
 * @property {string} name - Skill名称
 * @property {string[]} applicable_agents - 适用的Agent角色列表
 * @property {string} trigger - 触发描述
 * @property {boolean} auto_trigger - 是否自动触发
 * @property {string} phase - 所属阶段
 * @property {number} priority - 优先级（数字越小越优先）
 * @property {string[]} trigger_conditions - 触发条件列表
 * @property {string[]} depends_on - 依赖的Skill列表
 * @property {string[]} blocks - 阻塞的Skill列表
 * @property {'strict'|'recommended'|'optional'} enforcement - 执行级别
 * @property {boolean} infrastructure - 是否为基础设施组件
 */

/**
 * @typedef {Object} MatchContext
 * @property {string} userMessage - 用户消息文本
 * @property {string} agent - 当前Agent角色ID
 * @property {string[]} [completedSkills] - 已完成的Skill ID列表
 */

SkillRouter.prototype._applySpecBoost = function _applySpecBoost(matches, specificationState) {
  if (!specificationState.activeSpecs || specificationState.activeSpecs.length === 0) return matches;
  const self = this;
  return matches.slice().sort(function(a, b) {
    if (a.phase !== b.phase) return self._phaseOrder(a.phase) - self._phaseOrder(b.phase);
    const aBoost = self._getSpecBoost(a, specificationState);
    const bBoost = self._getSpecBoost(b, specificationState);
    if (aBoost !== bBoost) return bBoost - aBoost;
    return a.priority - b.priority;
  });
};

SkillRouter.prototype._getSpecBoost = function _getSpecBoost(skill, specificationState) {
  if (!specificationState.activeSpecs || specificationState.activeSpecs.length === 0) return 0;
  if (skill.specification_type && specificationState.staleSpecs && specificationState.staleSpecs.indexOf(skill.specification_type) !== -1) {
    return -5;
  }
  if (skill.causal_outputs && Array.isArray(skill.causal_outputs)) {
    for (let i = 0; i < skill.causal_outputs.length; i++) {
      const output = skill.causal_outputs[i];
      const name = (typeof output === 'object' && output !== null && output.name) ? output.name : output;
      if (name === 'specification_verified') return 10;
    }
  }
  if (skill.specification_type && specificationState.activeSpecs.includes(skill.specification_type)) return 5;
  return 0;
};

SkillRouter.prototype._phaseOrder = function _phaseOrder(phase) {
  const phases = ['brainstorming', 'requirement-analysis', 'architecture-design', 'module-development', 'integration-testing', 'deployment'];
  const idx = phases.indexOf(phase);
  return idx === -1 ? UNKNOWN_PHASE_ORDER : idx;
};

module.exports = withShutdown(SkillRouter);
Object.assign(module.exports, { MODEL_TIERS, TIER_PRIORITY, inferModelTier });
