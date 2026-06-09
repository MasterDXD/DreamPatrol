'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { validateProjectRoot, estimateTokens, UTF8_ENCODING, DEFAULT_SUMMARY_MAX_LENGTH, DEFAULT_CACHE_MAX, DEFAULT_CACHE_TTL, SKILL_LAYER_CORE, SKILL_LAYER_DOMAIN, SKILL_LAYER_INFRASTRUCTURE, DEFAULT_TOP_K, DEFAULT_OVERLOAD_THRESHOLD, DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH, DEFAULT_AUTO_UNLOAD_DELAY_MS, SKILL_REDUCER_CORE_SKILL_IDS } = require('../../utils/constants');
const { isPathWithinDir } = require('../../utils/path-utils');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { safeJsonParse } = require('../../utils/safe-parse');
const LRUCache = require('../../utils/lru-cache');
const { parseMarkdownFile, parseMarkdownFileAsync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { scanSkillFilesSync, scanSkillFilesAsync, parseSkillFileSync, parseSkillFileAsync, buildBaseSkillEntry, getSkillsDir, resolveResourcePath, buildL3Entry } = require('./skill-discover-utils');

const LAYER_METADATA = 1;
const LAYER_INSTRUCTION = 2;
const LAYER_RESOURCES = 3;
const MAX_ACTIVE_TASKS = 100;

const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'not', 'no', 'nor', 'so', 'if',
  'then', 'than', 'too', 'very', 'just', 'about', 'above', 'after',
  'before', 'between', 'into', 'through', 'during', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
]);

/**
 * @module runtime/skill/skill-reducer
 * 技能精简器——动态技能管理系统，实现"按需加载，用完即藏"范式。
 *
 * 核心能力：
 * 1. 三层缓存（L1摘要/L2指令/L3资源）的技能发现与加载
 * 2. 动态技能分层（核心/领域/基础设施），核心技能常驻L2
 * 3. Top-K技能选择，避免决策瘫痪
 * 4. 任务驱动的激活与自动卸载
 * 5. 技能过载检测与注意力压缩
 *
 * @classdesc 技能精简器（动态技能管理系统）。合并相似技能、去除冗余；动态技能分层（核心/领域/基础设施）；Top-K技能选择避免决策瘫痪；任务驱动激活与自动卸载；技能过载检测与注意力压缩。
 * @extends EventEmitter
 * @emits discovered  当技能发现完成时触发，载荷 {l1Count: number}
 * @emits skill-load-error  当技能文件加载失败时触发，载荷 Error 及 {file: string}
 * @emits l2-hit  当L2缓存命中时触发，载荷 {skillId: string}
 * @emits l2-loaded  当L2指令层加载完成时触发，载荷 {skillId: string, tokenEstimate: number}
 * @emits l2-unloaded  当L2缓存条目卸载时触发，载荷 {skillId: string}
 * @emits l2-all-unloaded  当所有L2缓存清空时触发，载荷 {count: number}
 * @emits l3-loaded  当L3资源层加载完成时触发，载荷 {skillId: string, resourcePath: string}
 * @emits l3-unloaded  当L3缓存条目卸载时触发，载荷 {skillId: string, resourcePath: string}
 * @emits overload-detected  当技能过载检测触发时，载荷 {level: string, l2Cached: number, l1Count: number, contextTokens: number}
 * @emits skills-activated  当任务驱动激活完成时，载荷 {taskSignature: string, skillIds: string[]}
 * @emits skills-deactivated  当任务驱动卸载完成时，载荷 {taskSignature: string, unloadedIds: string[]}
 */
class SkillReducer extends EventEmitter {
  /**
   * 创建 SkillReducer 实例。
   * @param {string} projectRoot - 项目根目录路径
   * @param {Object} [options] - 配置选项
   */
  constructor(projectRoot, options) {
    super();
    validateProjectRoot(projectRoot, 'SkillReducer');
    this.root = projectRoot;
    this._skillsDir = getSkillsDir(projectRoot);
    this._summaryMaxLength = (options && options.summaryMaxLength) ?? DEFAULT_SUMMARY_MAX_LENGTH;
    this._cacheMax = (options && options.cacheMax) ?? DEFAULT_CACHE_MAX;
    this._cacheTTL = (options && options.cacheTTL) ?? DEFAULT_CACHE_TTL;
    this._topK = (options && options.topK) ?? DEFAULT_TOP_K;
    this._overloadThreshold = (options && options.overloadThreshold) ?? DEFAULT_OVERLOAD_THRESHOLD;
    this._compressedSummaryMaxLength = (options && options.compressedSummaryMaxLength) ?? DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH;
    this._autoUnloadDelay = (options && options.autoUnloadDelay) ?? DEFAULT_AUTO_UNLOAD_DELAY_MS;
    this._l1Registry = new Map();
    this._agentSets = {};
    this._l2Cache = new LRUCache(this._cacheMax);
    this._l3Cache = new LRUCache(this._cacheMax);
    this._layerIndex = new Map();
    this._activeTaskSkills = new Map();
    this._autoUnloadTimers = new Map();
    this._loadingPromises = new Map();
    this._eventSource = null;
    this._stats = {
      l1Count: 0,
      l2Hits: 0,
      l2Misses: 0,
      l3Hits: 0,
      l3Misses: 0,
      l2Evictions: 0,
      l3Evictions: 0,
      totalTokenSavings: 0,
      topKTruncations: 0,
      overloadDetections: 0,
      autoUnloads: 0,
      taskActivations: 0,
      taskDeactivations: 0,
      compressedSummariesGenerated: 0,
    };
  }

  /**
   * 同步扫描技能目录并解析所有技能文件，构建L1注册表和索引。
   * @returns {number} 发现的技能数量
   */
  discover() {
    this.guardShutdown();
    const skillsDir = this._skillsDir;
    const files = scanSkillFilesSync(skillsDir, 'SkillReducer', this);
    if (!files) return [];

    this._l1Registry.clear();
    this._l2Cache.clear();
    this._l3Cache.clear();
    this._clearActiveTasks();

    for (const file of files) {
      try {
        const filePath = path.join(skillsDir, file);
        const { content, fm } = parseSkillFileSync(filePath);
        if (!fm) continue;

        this._registerSkillEntry(file, fm, content, filePath);
      } catch (err) {
        debug('SkillReducer', 'discover', err);
        emitError(this, 'skill-load-error', err, { file });
      }
    }

    return this._finalizeDiscover();
  }

  /**
   * 异步扫描技能目录并解析所有技能文件，构建L1注册表和索引。
   * @returns {Promise<number>} 发现的技能数量
   */
  async discoverAsync() {
    this.guardShutdown();
    const skillsDir = this._skillsDir;
    const files = await scanSkillFilesAsync(skillsDir, 'SkillReducer', this);
    if (this._shutDown) return [];
    if (!files) return [];

    this._l1Registry.clear();
    this._l2Cache.clear();
    this._l3Cache.clear();
    this._clearActiveTasks();

    for (const file of files) {
      try {
        const filePath = path.join(skillsDir, file);
        const { content, fm } = await parseSkillFileAsync(filePath);
        if (!fm) continue;

        this._registerSkillEntry(file, fm, content, filePath);
      } catch (err) {
        debug('SkillReducer', 'discoverAsync', err);
        emitError(this, 'skill-load-error', err, { file });
      }
    }

    return this._finalizeDiscover();
  }

  _registerSkillEntry(file, fm, content, filePath) {
    const l1Entry = buildBaseSkillEntry(file, fm, content, filePath, this._summaryMaxLength);
    l1Entry.trigger_keywords = this._extractTriggerKeywords(fm);
    l1Entry.applicable_agents = this._parseArray(fm.applicable_agents);
    l1Entry.skill_layer = this._classifySkillLayer(l1Entry);
    this._l1Registry.set(l1Entry.skill_id, l1Entry);
  }

  _finalizeDiscover() {
    this._buildAgentSets();
    this._buildLayerIndex();
    this._stats.l1Count = this._l1Registry.size;
    this._preloadCoreSkills();
    this.emit('discovered', { l1Count: this._stats.l1Count });
    return this.getL1Entries();
  }

  _classifySkillLayer(entry) {
    if (entry.infrastructure) return SKILL_LAYER_INFRASTRUCTURE;
    if (SKILL_REDUCER_CORE_SKILL_IDS.has(entry.skill_id)) return SKILL_LAYER_CORE;
    return SKILL_LAYER_DOMAIN;
  }

  _buildLayerIndex() {
    this._layerIndex.clear();
    for (const [skillId, entry] of this._l1Registry) {
      const layer = entry.skill_layer || this._classifySkillLayer(entry);
      if (!this._layerIndex.has(layer)) this._layerIndex.set(layer, []);
      const layerList = this._layerIndex.get(layer);
      if (layerList) layerList.push(skillId);
    }
  }

  _preloadCoreSkills() {
    const coreIds = this._layerIndex.get(SKILL_LAYER_CORE);
    if (!coreIds || coreIds.length === 0) return;
    for (const id of coreIds) {
      this._loadL2Silent(id);
    }
  }

  /**
   * 查询指定技能的层级分类。
   * @param {string} skillId - 技能ID
   * @returns {string|null} 层级标识（'core'|'domain'|'infrastructure'），不存在返回null
   */
  classifySkillLayer(skillId) {
    const entry = this._l1Registry.get(skillId);
    if (!entry) return null;
    return entry.skill_layer || this._classifySkillLayer(entry);
  }

  /**
   * 按层级获取技能ID列表。
   * @param {string} layer - 层级标识（'core'|'domain'|'infrastructure'）
   * @returns {string[]} 该层级下的技能ID数组
   */
  getSkillsByLayer(layer) {
    const arr = this._layerIndex.get(layer);
    return arr ? arr.slice() : [];
  }

  /**
   * 获取各层级技能数量分布。
   * @returns {Object<string, number>} 层级到数量的映射，如 { core: 15, domain: 28, infrastructure: 2 }
   */
  getLayerDistribution() {
    const distribution = {};
    for (const [layer, ids] of this._layerIndex) {
      distribution[layer] = ids.length;
    }
    return distribution;
  }

  /**
   * 获取所有L1元数据条目。返回浅拷贝，不含内部字段（_filePath等）。
   * @returns {Object[]} L1条目数组，每项含 skill_id/name/summary/trigger_keywords/phase/priority/enforcement/applicable_agents/infrastructure/skill_layer
   */
  getL1Entries() {
    const entries = [];
    for (const [, entry] of this._l1Registry) {
      entries.push({
        skill_id: entry.skill_id,
        name: entry.name,
        summary: entry.summary,
        trigger_keywords: entry.trigger_keywords,
        phase: entry.phase,
        priority: entry.priority,
        enforcement: entry.enforcement,
        applicable_agents: entry.applicable_agents,
        infrastructure: entry.infrastructure,
        skill_layer: entry.skill_layer,
      });
    }
    return entries;
  }

  /**
   * 获取指定技能的L1元数据条目。返回浅拷贝，不含内部字段。
   * @param {string} skillId - 技能ID
   * @returns {Object|null} L1条目，不存在返回null
   */
  getL1Entry(skillId) {
    const entry = this._l1Registry.get(skillId);
    if (!entry) return null;
    return {
      skill_id: entry.skill_id,
      name: entry.name,
      summary: entry.summary,
      trigger_keywords: entry.trigger_keywords,
      phase: entry.phase,
      priority: entry.priority,
      enforcement: entry.enforcement,
      applicable_agents: entry.applicable_agents,
      infrastructure: entry.infrastructure,
      skill_layer: entry.skill_layer,
    };
  }

  _loadL2(skillId) {
    const cached = this._getCachedL2(skillId);
    if (cached) {
      this._stats.l2Hits++;
      this.emit('l2-hit', { skillId });
      return cached;
    }

    this._stats.l2Misses++;
    const l1Entry = this._l1Registry.get(skillId);
    if (!l1Entry || !l1Entry._filePath) return null;

    try {
      const parsed = parseMarkdownFile(l1Entry._filePath);
      if (!parsed) return null;
      const { frontmatter: fm, body: instructionBody } = parsed;

      const l2Entry = {
        skill_id: skillId,
        name: l1Entry.name,
        frontmatter: fm,
        instruction: instructionBody,
        loadedAt: Date.now(),
        tokenEstimate: estimateTokens(instructionBody),
      };

      this._putL2Cache(skillId, l2Entry);
      this._stats.totalTokenSavings += Math.max(0, l1Entry._fullContentLength - instructionBody.length);
      this.emit('l2-loaded', { skillId, tokenEstimate: l2Entry.tokenEstimate });
      return l2Entry;
    } catch (err) {
      debug('SkillReducer', 'loadL2', err);
      return { _error: err.message || String(err) };
    }
  }

  /**
   * 同步加载L2指令层。命中缓存时递增l2Hits，未命中时递增l2Misses。
   * @param {string} skillId - 技能ID
   * @returns {Object|null} L2条目（含skill_id/name/frontmatter/instruction/loadedAt/tokenEstimate），失败返回null
   */
  loadL2(skillId) {
    this.guardShutdown();
    return this._loadL2(skillId);
  }

  /**
   * 静默加载L2指令层，不递增l2Hits/l2Misses统计计数器。
   * 用于内部预加载（如核心技能常驻），避免干扰用户操作的命中率统计。
   * @param {string} skillId - 技能ID
   * @returns {Object|null} L2条目，失败返回null
   * @private
   */
  _loadL2Silent(skillId) {
    if (this._shutDown) return null;
    const cached = this._getCachedL2(skillId);
    if (cached) return cached;

    const l1Entry = this._l1Registry.get(skillId);
    if (!l1Entry || !l1Entry._filePath) return null;

    try {
      const parsed = parseMarkdownFile(l1Entry._filePath);
      if (!parsed) return null;
      const { frontmatter: fm, body: instructionBody } = parsed;

      const l2Entry = {
        skill_id: skillId,
        name: l1Entry.name,
        frontmatter: fm,
        instruction: instructionBody,
        loadedAt: Date.now(),
        tokenEstimate: estimateTokens(instructionBody),
      };

      this._putL2Cache(skillId, l2Entry);
      this._stats.totalTokenSavings += Math.max(0, l1Entry._fullContentLength - instructionBody.length);
      this.emit('l2-loaded', { skillId, tokenEstimate: l2Entry.tokenEstimate });
      return l2Entry;
    } catch (err) {
      debug('SkillReducer', 'loadL2Silent', err);
      return { _error: err.message || String(err) };
    }
  }

  /**
   * 异步加载L2指令层。命中缓存时递增l2Hits，未命中时递增l2Misses。
   * @param {string} skillId - 技能ID
   * @returns {Promise<Object|null>} L2条目，失败返回null
   */
  async loadL2Async(skillId) {
    this.guardShutdown();
    const cached = this._getCachedL2(skillId);
    if (cached) {
      this._stats.l2Hits++;
      this.emit('l2-hit', { skillId });
      return cached;
    }

    const inFlight = this._loadingPromises.get(skillId);
    if (inFlight) return inFlight;

    const loadPromise = this._doLoadL2Async(skillId);
    this._loadingPromises.set(skillId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this._loadingPromises.delete(skillId);
    }
  }

  async _doLoadL2Async(skillId) {
    this._stats.l2Misses++;
    const l1Entry = this._l1Registry.get(skillId);
    if (!l1Entry || !l1Entry._filePath) return null;

    try {
      const parsed = await parseMarkdownFileAsync(l1Entry._filePath);
      if (!parsed) return null;
      const { frontmatter: fm, body: instructionBody } = parsed;

      const l2Entry = {
        skill_id: skillId,
        name: l1Entry.name,
        frontmatter: fm,
        instruction: instructionBody,
        loadedAt: Date.now(),
        tokenEstimate: estimateTokens(instructionBody),
      };

      this._putL2Cache(skillId, l2Entry);
      this._stats.totalTokenSavings += Math.max(0, l1Entry._fullContentLength - instructionBody.length);
      this.emit('l2-loaded', { skillId, tokenEstimate: l2Entry.tokenEstimate });
      return l2Entry;
    } catch (err) {
      debug('SkillReducer', 'loadL2Async', err);
      return null;
    }
  }

  /**
   * 卸载L2缓存条目。核心技能不可卸载，始终返回false。
   * @param {string} skillId - 技能ID
   * @returns {boolean} 是否成功卸载
   * @emits l2-unloaded 当成功卸载时触发
   */
  unloadL2(skillId) {
    const layer = this.classifySkillLayer(skillId);
    if (layer === SKILL_LAYER_CORE) return false;
    const evicted = this._l2Cache.delete(skillId);
    if (evicted) {
      this._stats.l2Evictions++;
      this.emit('l2-unloaded', { skillId });
    }
    return evicted;
  }

  _loadL3With(skillId, resourcePath, { existsFn, readFn }) {
    const cacheKey = `${skillId}:${resourcePath || 'default'}`;
    const cached = this._getCachedL3(cacheKey);
    if (cached) {
      this._stats.l3Hits++;
      return cached;
    }

    this._stats.l3Misses++;
    const l1Entry = this._l1Registry.get(skillId);
    if (!l1Entry || !l1Entry._filePath) return null;

    try {
      const resourceFile = resolveResourcePath(l1Entry._filePath, resourcePath);
      if (resourcePath && !isPathWithinDir(resourceFile, path.dirname(l1Entry._filePath))) {
        debug('SkillReducer', 'loadL3', 'Path traversal detected: ' + resourcePath);
        return null;
      }

      if (!existsFn(resourceFile)) return null;

      const content = readFn(resourceFile, UTF8_ENCODING);
      const l3Entry = buildL3Entry(skillId, resourcePath, content);

      this._putL3Cache(cacheKey, l3Entry);
      this.emit('l3-loaded', { skillId, resourcePath: resourcePath || 'references/index.md' });
      return l3Entry;
    } catch (err) {
      debug('SkillReducer', 'loadL3', err);
      return null;
    }
  }

  /**
   * 同步加载L3资源层。含路径遍历防护。
   * @param {string} skillId - 技能ID
   * @param {string} [resourcePath] - 资源相对路径，默认为references/index.md
   * @returns {Object|null} L3条目，失败返回null
   * @emits l3-loaded 当加载完成时触发
   */
  loadL3(skillId, resourcePath) {
    this.guardShutdown();
    return this._loadL3With(skillId, resourcePath, {
      existsFn: (p) => fs.existsSync(p),
      readFn: (p, enc) => fs.readFileSync(p, enc),
    });
  }

  /**
   * 异步加载指定技能的L3资源层（引用文件），含路径遍历防护。
   * @param {string} skillId - 技能标识符
   * @param {string} resourcePath - 资源文件相对路径
   * @returns {Promise<string|null>} 资源文件内容，不存在或安全检查失败时返回null
   */
  async loadL3Async(skillId, resourcePath) {
    this.guardShutdown();
    const l1Entry = this._l1Registry.get(skillId);
    if (!l1Entry || !l1Entry._filePath) return null;

    try {
      const resourceFile = resolveResourcePath(l1Entry._filePath, resourcePath);
      if (resourcePath && !isPathWithinDir(resourceFile, path.dirname(l1Entry._filePath))) {
        debug('SkillReducer', 'loadL3', 'Path traversal detected: ' + resourcePath);
        return null;
      }

      try { await fs.promises.access(resourceFile); } catch (_err) { debug('SkillReducer', 'loadL3Async:access', _err && _err.message ? _err.message : String(_err)); return null; }

      const content = await fs.promises.readFile(resourceFile, UTF8_ENCODING);
      return this._loadL3With(skillId, resourcePath, {
        existsFn: () => true,
        readFn: () => content,
      });
    } catch (err) {
      debug('SkillReducer', 'loadL3Async', err);
      return null;
    }
  }

  /**
   * 卸载L3缓存条目。
   * @param {string} skillId - 技能ID
   * @param {string} [resourcePath] - 资源相对路径
   * @returns {boolean} 是否成功卸载
   * @emits l3-unloaded 当成功卸载时触发
   */
  unloadL3(skillId, resourcePath) {
    const cacheKey = `${skillId}:${resourcePath || 'default'}`;
    const evicted = this._l3Cache.delete(cacheKey);
    if (evicted) {
      this._stats.l3Evictions++;
      this.emit('l3-unloaded', { skillId, resourcePath });
    }
    return evicted;
  }

  /**
   * 基于关键词的L1层匹配。按Agent过滤 + 触发关键词匹配，结果按phase+priority排序。
   * 基础设施技能不参与匹配。
   * @param {Object} context - 匹配上下文 { userMessage: string, agent: string }
   * @returns {Object[]} 匹配的L1条目数组
   */
  matchL1(context) {
    this.guardShutdown();
    if (!context || typeof context !== 'object') return [];
    const { userMessage = '', agent = '' } = context;
    const msgLower = userMessage.toLowerCase();
    const matches = [];

    for (const [, entry] of this._l1Registry) {
      if (entry.infrastructure) continue;
      const agentSet = this._agentSets[entry.skill_id];
      if (agentSet && !agentSet.has(agent)) continue;

      let matched = false;
      for (const kw of entry.trigger_keywords ?? []) {
        if (kw.length < 2) continue;
        if (msgLower.includes(kw.toLowerCase()) || userMessage.includes(kw)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        matches.push({
          skill_id: entry.skill_id,
          name: entry.name,
          summary: entry.summary,
          phase: entry.phase,
          priority: entry.priority,
          enforcement: entry.enforcement,
          skill_layer: entry.skill_layer,
        });
      }
    }

    return matches.sort((a, b) => {
      if (a.phase !== b.phase) return this._phaseOrder(a.phase) - this._phaseOrder(b.phase);
      return a.priority - b.priority;
    });
  }

  /**
   * 从L1匹配结果中选择Top-K个最相关技能。核心技能优先占位，剩余槽位分配给领域技能。
   * 当匹配结果数 <= K 时直接返回全部结果。
   * @param {Object} context - 匹配上下文，同 matchL1()
   * @param {number} [k] - 选择的技能数量上限，默认为构造时的topK配置
   * @returns {Object[]} Top-K匹配结果，每项含 skill_id/name/summary/phase/priority/enforcement/skill_layer
   */
  matchTopK(context, k) {
    const topK = k ?? this._topK;
    if (topK <= 0) return [];
    const allMatches = this.matchL1(context);
    if (allMatches.length <= topK) return allMatches;

    const coreTaken = new Set();
    const domainTaken = new Set();
    let coreCount = 0;

    for (const m of allMatches) {
      if (m.skill_layer === SKILL_LAYER_CORE && coreCount < topK) {
        coreTaken.add(m.skill_id);
        coreCount++;
      }
    }

    const domainSlots = topK - coreTaken.size;
    let domainCount = 0;
    for (const m of allMatches) {
      if (m.skill_layer === SKILL_LAYER_DOMAIN && domainCount < domainSlots) {
        domainTaken.add(m.skill_id);
        domainCount++;
      }
    }

    const taken = new Set([...coreTaken, ...domainTaken]);
    const result = allMatches.filter(m => taken.has(m.skill_id));

    if (allMatches.length > topK) {
      this._stats.topKTruncations++;
    }

    return result;
  }

  /**
   * 压缩技能摘要。去除停用词和标点，提取核心关键词。
   * 自动检测中英文：中文按字符级提取，英文按词级提取并过滤停用词。
   * @param {string} summary - 原始摘要文本
   * @returns {string} 压缩后的摘要，超长截断并加'...'
   */
  compressSkillSummary(summary) {
    this.guardShutdown();
    return this._compressSummaryInternal(summary, true);
  }

  /**
   * 摘要压缩的内部实现。去除停用词和标点，提取核心关键词。
   * 自动检测中英文：中文按字符级提取，英文按词级提取并过滤停用词。
   * @param {string} summary - 原始摘要文本
   * @param {boolean} trackStats - 是否递增compressedSummariesGenerated统计计数器
   * @returns {string} 压缩后的摘要，超长截断并加'...'
   * @private
   */
  _compressSummaryInternal(summary, trackStats) {
    if (!summary || typeof summary !== 'string') return '';
    const sentences = summary.split(/[。.!?！？;；\n]+/).filter(s => s.trim().length > 0);
    if (sentences.length === 0) return '';

    const keywords = [];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(trimmed);
      if (hasCJK) {
        const cleaned = trimmed.replace(/[，,、：:（）()"'"'《》<>【】\[\]{}]/g, '');
        const chars = cleaned.replace(/\s+/g, '');
        if (chars.length >= 2) keywords.push(chars);
      } else {
        const words = trimmed.split(/\s+/);
        for (const word of words) {
          const cleaned = word.replace(/[，,、：:（）()"'"'《》<>【】\[\]{}]/g, '');
          if (cleaned.length < 2) continue;
          if (FILLER_WORDS.has(cleaned.toLowerCase())) continue;
          keywords.push(cleaned);
        }
      }
    }

    let compressed = keywords.join(' ');
    if (compressed.length > this._compressedSummaryMaxLength) {
      compressed = compressed.slice(0, this._compressedSummaryMaxLength - 3) + '...';
    }

    if (trackStats) this._stats.compressedSummariesGenerated++;
    return compressed;
  }

  /**
   * 获取所有技能的压缩版L1条目。使用注意力压缩后的摘要替代原始摘要，
   * 大幅减少上下文占用，适用于Agent决策时的轻量级技能浏览。
   * @returns {Object[]} 压缩版L1条目数组，每项含 skill_id/name/compressed_summary/phase/priority/skill_layer
   */
  getCompressedL1Entries() {
    this.guardShutdown();
    const entries = [];
    for (const [, entry] of this._l1Registry) {
      entries.push({
        skill_id: entry.skill_id,
        name: entry.name,
        compressed_summary: this._compressSummaryInternal(entry.summary, false),
        phase: entry.phase,
        priority: entry.priority,
        skill_layer: entry.skill_layer,
      });
    }
    return entries;
  }

  /**
   * 检测技能系统是否过载。综合评估L2缓存占用率和Token预算消耗率。
   * 当有效比率 >= overloadThreshold 时触发 warning，>= 0.95 时触发 critical。
   * @param {number} [tokenBudget] - Token预算上限，用于计算Token消耗率；为0或未提供时仅使用L2缓存率
   * @returns {Object} 过载检测结果 { level: string, l2Cached: number, l1Count: number, contextTokens: number, l2Ratio: number, tokenRatio: number|undefined }
   * @emits overload-detected 当检测到过载时触发
   */
  detectOverload(tokenBudget) {
    this.guardShutdown();
    const ctx = this.getContextEstimate();
    const l2Ratio = this._l2Cache.size / Math.max(this._cacheMax, 1);
    const tokenRatio = (tokenBudget && tokenBudget > 0) ? ctx.totalTokens / tokenBudget : l2Ratio;
    const effectiveRatio = Math.max(l2Ratio, tokenRatio);

    let level = 'none';
    if (effectiveRatio >= 0.95) {
      level = 'critical';
    } else if (effectiveRatio >= this._overloadThreshold) {
      level = 'warning';
    }

    if (level !== 'none') {
      this._stats.overloadDetections++;
      this.emit('overload-detected', {
        level,
        l2Cached: this._l2Cache.size,
        l1Count: this._l1Registry.size,
        contextTokens: ctx.totalTokens,
        l2Ratio: Math.round(l2Ratio * 10000) / 100,
        tokenRatio: (tokenBudget && tokenBudget > 0) ? Math.round(tokenRatio * 10000) / 100 : undefined,
      });
    }

    return {
      level,
      l2Cached: this._l2Cache.size,
      l1Count: this._l1Registry.size,
      contextTokens: ctx.totalTokens,
      l2Ratio,
      tokenRatio: (tokenBudget && tokenBudget > 0) ? tokenRatio : undefined,
    };
  }

  /**
   * 为指定任务激活相关技能。自动匹配Top-K技能并加载L2指令层。
   * 核心技能常驻，领域技能按需加载。任务完成后通过 deactivateAfterTask() 卸载。
   * @param {string} taskSignature - 任务唯一标识，用于后续 deactivateAfterTask() 匹配
   * @param {Object} context - 匹配上下文，同 matchL1()
   * @returns {string[]} 激活的技能ID列表
   * @emits skills-activated 当激活完成时触发
   */
  activateForTask(taskSignature, context) {
    if (!taskSignature || typeof taskSignature !== 'string') return [];
    if (this._activeTaskSkills.size >= MAX_ACTIVE_TASKS) {
      throw new Error('Active task limit reached: ' + MAX_ACTIVE_TASKS);
    }
    this._cancelAutoUnload(taskSignature);
    this._activeTaskSkills.delete(taskSignature);
    const topMatches = this.matchTopK(context);
    const skillIds = topMatches.map(m => m.skill_id);

    for (const id of skillIds) {
      this._loadL2(id);
    }

    this._activeTaskSkills.set(taskSignature, {
      skillIds,
      activatedAt: Date.now(),
      context: context ?? {},
    });

    this._stats.taskActivations++;
    this.emit('skills-activated', { taskSignature, skillIds });
    return skillIds;
  }

  /**
   * 任务完成后卸载相关领域技能（"用完即藏"）。核心技能不会被卸载。
   * immediate=true 时立即卸载并返回已卸载的技能ID列表；
   * immediate=false 时延迟卸载（默认5秒），立即返回空数组，卸载完成后触发 skills-deactivated 事件。
   * @param {string} taskSignature - 任务唯一标识，对应 activateForTask() 的签名
   * @param {boolean} [immediate=false] - 是否立即卸载。任务失败时建议 true，成功时建议 false
   * @returns {string[]} 立即模式下返回已卸载的技能ID列表，延迟模式下返回空数组
   * @emits skills-deactivated 当卸载完成时触发
   */
  deactivateAfterTask(taskSignature, immediate) {
    if (!taskSignature || typeof taskSignature !== 'string') return [];
    const taskInfo = this._activeTaskSkills.get(taskSignature);
    if (!taskInfo) return [];

    if (immediate) {
      const unloadedIds = [];
      for (const id of taskInfo.skillIds) {
        if (this.classifySkillLayer(id) !== SKILL_LAYER_CORE) {
          if (this.unloadL2(id)) unloadedIds.push(id);
        }
      }
      this._activeTaskSkills.delete(taskSignature);
      this._stats.taskDeactivations++;
      this.emit('skills-deactivated', { taskSignature, unloadedIds });
      return unloadedIds;
    }

    const existingTimer = this._autoUnloadTimers.get(taskSignature);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this._autoUnloadTimers.delete(taskSignature);
    }
    const self = this;
    const sig = taskSignature;
    const timer = setTimeout(() => {
      if (self._shutDown) return;
      try {
        self._autoUnloadTimers.delete(sig);
        const info = self._activeTaskSkills.get(sig);
        if (!info) return;
        const unloaded = [];
        for (const id of info.skillIds) {
          if (self.classifySkillLayer(id) !== SKILL_LAYER_CORE) {
            if (self.unloadL2(id)) unloaded.push(id);
          }
        }
        self._activeTaskSkills.delete(sig);
        self._stats.autoUnloads++;
        self._stats.taskDeactivations++;
        self.emit('skills-deactivated', { taskSignature: sig, unloadedIds: unloaded });
      } catch (err) {
        self.emit('error', err);
      }
    }, this._autoUnloadDelay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._autoUnloadTimers.set(taskSignature, timer);
    return [];
  }

  _cancelAutoUnload(taskSignature) {
    const timer = this._autoUnloadTimers.get(taskSignature);
    if (timer) {
      clearTimeout(timer);
      this._autoUnloadTimers.delete(taskSignature);
    }
  }

  _clearActiveTasks() {
    for (const [, timer] of this._autoUnloadTimers) {
      clearTimeout(timer);
    }
    this._autoUnloadTimers.clear();
    this._activeTaskSkills.clear();
  }

  /**
   * 挂载事件源以实现自动任务生命周期管理。
   * 监听 task:completed 事件触发延迟卸载，task:failed 事件触发立即卸载。
   * 重复调用会自动移除前一个事件源的监听。
   * @param {EventEmitter|null} emitter - 事件发射器，传null时解除绑定
   */
  attachEventSource(emitter) {
    if (this._eventSource) {
      this._eventSource.removeListener('task:completed', this._boundOnTaskCompleted);
      this._eventSource.removeListener('task:failed', this._boundOnTaskFailed);
    }
    this._eventSource = emitter;
    if (!emitter) return;

    this._boundOnTaskCompleted = (data) => {
      if (data && data.taskSignature) {
        this.deactivateAfterTask(data.taskSignature, false);
      }
    };
    this._boundOnTaskFailed = (data) => {
      if (data && data.taskSignature) {
        this.deactivateAfterTask(data.taskSignature, true);
      }
    };

    emitter.on('task:completed', this._boundOnTaskCompleted);
    emitter.on('task:failed', this._boundOnTaskFailed);
  }

  /**
   * 获取当前活跃的任务技能列表。
   * @returns {Object[]} 活跃任务列表，每项含 taskSignature/skillIds/activatedAt/context
   */
  getActiveTaskSkills() {
    const result = [];
    for (const [sig, info] of this._activeTaskSkills) {
      result.push({ taskSignature: sig, ...info });
    }
    return result;
  }

  /**
   * 估算当前三层缓存的Token占用量。
   * @returns {Object} { l1Tokens: number, l2Tokens: number, l3Tokens: number, totalTokens: number }
   */
  getContextEstimate() {
    this.guardShutdown();
    let l1Tokens = 0;
    for (const [, entry] of this._l1Registry) {
      l1Tokens += estimateTokens(entry.name + entry.summary + (entry.trigger_keywords ?? []).join(' '));
    }

    let l2Tokens = 0;
    for (const [, entry] of this._l2Cache.entries()) {
      l2Tokens += entry.tokenEstimate ?? 0;
    }

    let l3Tokens = 0;
    for (const [, entry] of this._l3Cache.entries()) {
      l3Tokens += entry.tokenEstimate ?? 0;
    }

    return { l1Tokens, l2Tokens, l3Tokens, totalTokens: l1Tokens + l2Tokens + l3Tokens };
  }

  /**
   * 估算注意力压缩后的Token占用量及节省量。
   * L1层使用压缩摘要替代原始摘要，L2/L3层不变。
   * @returns {Object} { l1Tokens: number, l2Tokens: number, l3Tokens: number, totalTokens: number, compressionSavings: number }
   */
  getCompressedContextEstimate() {
    const fullEstimate = this.getContextEstimate();
    let compressedL1Tokens = 0;
    for (const [, entry] of this._l1Registry) {
      const compressed = this._compressSummaryInternal(entry.summary, false);
      compressedL1Tokens += estimateTokens(entry.name + compressed);
    }

    const savings = Math.max(0, fullEstimate.l1Tokens - compressedL1Tokens);

    return {
      l1Tokens: compressedL1Tokens,
      l2Tokens: fullEstimate.l2Tokens,
      l3Tokens: fullEstimate.l3Tokens,
      totalTokens: compressedL1Tokens + fullEstimate.l2Tokens + fullEstimate.l3Tokens,
      compressionSavings: savings,
    };
  }

  /**
   * 获取SkillReducer的运行统计信息。
   * @returns {Object} 统计信息对象，包含缓存命中率、淘汰数、Token节省、Top-K截断、过载检测、任务激活/卸载、层级分布、上下文估算等
   */
  getStats() {
    return {
      l1Count: this._stats.l1Count,
      l2Cached: this._l2Cache.size,
      l3Cached: this._l3Cache.size,
      l2Hits: this._stats.l2Hits,
      l2Misses: this._stats.l2Misses,
      l2HitRate: this._stats.l2Hits + this._stats.l2Misses > 0
        ? this._stats.l2Hits / (this._stats.l2Hits + this._stats.l2Misses)
        : 0,
      l3Hits: this._stats.l3Hits,
      l3Misses: this._stats.l3Misses,
      l2Evictions: this._stats.l2Evictions,
      l3Evictions: this._stats.l3Evictions,
      totalTokenSavings: this._stats.totalTokenSavings,
      topKTruncations: this._stats.topKTruncations,
      overloadDetections: this._stats.overloadDetections,
      autoUnloads: this._stats.autoUnloads,
      taskActivations: this._stats.taskActivations,
      taskDeactivations: this._stats.taskDeactivations,
      compressedSummariesGenerated: this._stats.compressedSummariesGenerated,
      activeTaskCount: this._activeTaskSkills.size,
      layerDistribution: this.getLayerDistribution(),
      contextEstimate: this.getContextEstimate(),
      compressedContextEstimate: this.getCompressedContextEstimate(),
    };
  }

  /**
   * 批量预加载L2指令层。
   * @param {string[]} skillIds - 技能ID数组
   * @returns {string[]} 成功加载的技能ID列表
   */
  preloadL2(skillIds) {
    const loaded = [];
    for (const id of skillIds ?? []) {
      const result = this.loadL2(id);
      if (result) loaded.push(id);
    }
    return loaded;
  }

  /**
   * 清空所有L2缓存并重新预加载核心技能。领域技能需要重新按需加载。
   * @returns {number} 清空前L2缓存中的条目数
   * @emits l2-all-unloaded 当清空完成时触发
   */
  unloadAllL2() {
    const count = this._l2Cache.size;
    this._l2Cache.clear();
    this._stats.l2Evictions += count;
    this.emit('l2-all-unloaded', { count });
    this._preloadCoreSkills();
    return count;
  }

  _extractTriggerKeywords(fm) {
    const keywords = [];
    const seen = new Set();
    if (fm.trigger_conditions) {
      const conditions = this._parseArray(fm.trigger_conditions);
      for (const cond of conditions) {
        const quoted = cond.match(/["'\u201c\u201d]([^"'\u201c\u201d\s]+)["'\u201c\u201d]?/g);
        if (quoted) {
          for (const q of quoted) {
            const cleaned = q.replace(/["'\u201c\u201d]/g, '');
            if (cleaned.length >= 2) { keywords.push(cleaned); seen.add(cleaned); }
          }
        }
        const orParts = cond.split(/\bor\b/i);
        for (const part of orParts) {
          const words = part.trim().split(/\s+/);
          for (const w of words) {
            const cleaned = w.replace(/["'\u201c\u201d]/g, '');
            if (cleaned.length >= 3 && !seen.has(cleaned)) { keywords.push(cleaned); seen.add(cleaned); }
          }
        }
      }
    }
    if (fm.trigger) {
      const triggerWords = fm.trigger.split(/[,，\s]+/);
      for (const w of triggerWords) {
        if (w.length > 2 && !seen.has(w)) { keywords.push(w); seen.add(w); }
      }
    }
    return keywords.slice(0, 15);
  }

  _parseArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      if (value.startsWith('[')) {
        try { return safeJsonParse(value, undefined, 'SkillReducer'); } catch (err) { debug('SkillReducer', 'parseArray', err); }
      }
      return value.split(/[,，]/).map(s => s.trim()).filter(s => s.length > 0);
    }
    return [];
  }

  _getCachedL2(skillId) {
    const entry = this._l2Cache.get(skillId);
    if (!entry) return null;
    if (Date.now() - entry.loadedAt > this._cacheTTL) {
      this._l2Cache.delete(skillId);
      this._stats.l2Evictions++;
      return null;
    }
    return entry;
  }

  _putL2Cache(skillId, entry) {
    const isNewKey = !this._l2Cache.has(skillId);
    const prevSize = this._l2Cache.size;
    this._l2Cache.set(skillId, entry);
    if (isNewKey && this._l2Cache.size === prevSize && prevSize >= this._cacheMax) {
      this._stats.l2Evictions++;
    }
  }

  _getCachedL3(cacheKey) {
    const entry = this._l3Cache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.loadedAt > this._cacheTTL) {
      this._l3Cache.delete(cacheKey);
      this._stats.l3Evictions++;
      return null;
    }
    return entry;
  }

  _putL3Cache(cacheKey, entry) {
    const isNewKey = !this._l3Cache.has(cacheKey);
    const prevSize = this._l3Cache.size;
    this._l3Cache.set(cacheKey, entry);
    if (isNewKey && this._l3Cache.size === prevSize && prevSize >= this._cacheMax) {
      this._stats.l3Evictions++;
    }
  }

  _phaseOrder(phase) {
    const order = { brainstorming: 0, 'requirement-analysis': 1, 'architecture-design': 2, 'module-development': 3, 'integration-testing': 4, deployment: 5 };
    return order[phase] !== undefined ? order[phase] : 99;
  }

  _buildAgentSets() {
    this._agentSets = {};
    for (const [skillId, entry] of this._l1Registry) {
      if (entry.applicable_agents && entry.applicable_agents.length > 0) {
        this._agentSets[skillId] = new Set(entry.applicable_agents);
      }
    }
  }

  _onShutdown() {
    this.removeAllListeners();
    for (const [, timer] of this._autoUnloadTimers) {
      clearTimeout(timer);
    }
    this._autoUnloadTimers.clear();
    if (this._eventSource) {
      if (this._boundOnTaskCompleted) this._eventSource.removeListener('task:completed', this._boundOnTaskCompleted);
      if (this._boundOnTaskFailed) this._eventSource.removeListener('task:failed', this._boundOnTaskFailed);
      this._eventSource = null;
    }
    this._l1Registry.clear();
    this._l2Cache.clear();
    this._l3Cache.clear();
    this._agentSets = {};
    this._layerIndex.clear();
    this._activeTaskSkills.clear();
    this._loadingPromises.clear();
  }

  /**
   * 健康检查。未关闭且L1注册表非空时为健康。
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._l1Registry.size > 0;
  }
}

SkillReducer.LAYER_METADATA = LAYER_METADATA;
SkillReducer.LAYER_INSTRUCTION = LAYER_INSTRUCTION;
SkillReducer.LAYER_RESOURCES = LAYER_RESOURCES;
SkillReducer.DEFAULT_SUMMARY_MAX_LENGTH = DEFAULT_SUMMARY_MAX_LENGTH;
SkillReducer.DEFAULT_CACHE_MAX = DEFAULT_CACHE_MAX;
SkillReducer.DEFAULT_CACHE_TTL = DEFAULT_CACHE_TTL;
SkillReducer.SKILL_LAYER_CORE = SKILL_LAYER_CORE;
SkillReducer.SKILL_LAYER_DOMAIN = SKILL_LAYER_DOMAIN;
SkillReducer.SKILL_LAYER_INFRASTRUCTURE = SKILL_LAYER_INFRASTRUCTURE;
SkillReducer.DEFAULT_TOP_K = DEFAULT_TOP_K;
SkillReducer.DEFAULT_OVERLOAD_THRESHOLD = DEFAULT_OVERLOAD_THRESHOLD;
SkillReducer.DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH = DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH;
SkillReducer.DEFAULT_AUTO_UNLOAD_DELAY_MS = DEFAULT_AUTO_UNLOAD_DELAY_MS;

module.exports = { SkillReducer: withShutdown(SkillReducer) };
