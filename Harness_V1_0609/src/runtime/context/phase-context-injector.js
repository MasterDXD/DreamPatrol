'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { PHASE_INDEX, PHASE_SKILLS, UTF8_ENCODING , HARNESS_DIR, MARKDOWN_EXT} = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');

const PHASE_RULES_MAP = {
  'brainstorming': ['context-management', 'cost-control', 'task-execution'],
  'requirement-analysis': ['context-management', 'cost-control', 'task-execution', 'document-standards'],
  'architecture-design': ['context-management', 'cost-control', 'task-execution', 'document-standards', 'best-practices'],
  'module-development': ['context-management', 'cost-control', 'task-execution', 'document-standards', 'best-practices', 'coding-standards', 'karpathy-principles', 'monitoring-fault-tolerance', 'security-permissions'],
  'integration-testing': ['context-management', 'cost-control', 'task-execution', 'best-practices', 'monitoring-fault-tolerance'],
  'deployment': ['context-management', 'cost-control', 'task-execution', 'security-permissions', 'monitoring-fault-tolerance'],
};

const PHASE_AGENTS_MAP = {
  'brainstorming': ['team-lead', 'domain-analyst'],
  'requirement-analysis': ['team-lead', 'domain-analyst'],
  'architecture-design': ['domain-analyst', 'team-lead'],
  'module-development': ['task-worker', 'domain-analyst', 'quality-assurance', 'code-reviewer', 'test-writer'],
  'integration-testing': ['quality-assurance', 'domain-analyst'],
  'deployment': ['devops-engineer', 'team-lead', 'technical-writer'],
};

const CORE_IDENTITY_MAX_LINES = 60;
const CACHE_TTL_MS = 60000;

/**
 * @module runtime/context/phase-context-injector
 * @classdesc 阶段上下文注入器。根据执行阶段自动注入相关上下文
 * PhaseContextInjector — 阶段上下文注入器
 * 根据当前执行阶段自动注入相关规则文件、Agent定义和核心身份文档到上下文中。
 * 每个阶段映射不同的规则集和Agent角色集，避免全量加载导致Token浪费。
 * 支持缓存TTL过期和增量更新，估算注入上下文的Token消耗。
 * @extends EventEmitter
 * @emits PhaseContextInjector#phase-context-injected
 */
class PhaseContextInjector extends EventEmitter {
  /**
   * 创建PhaseContextInjector实例
   * @param {string} projectRoot - 项目根目录路径
   */
  constructor(projectRoot) {
    super();
    this._root = projectRoot;
    this._rulesDir = path.join(projectRoot, HARNESS_DIR, 'rules');
    this._agentsDir = path.join(projectRoot, HARNESS_DIR, 'agents');
    this._claudePath = path.join(projectRoot, 'CLAUDE.md');
    this._cache = new Map();
    this._currentPhase = null;
    this._injectedTokenEstimate = 0;
  }

  /**
   * 同步注入指定阶段的上下文。加载该阶段对应的规则文件、Agent定义和核心身份文档。
   * 结果按阶段缓存，缓存TTL过期后自动清除。无效阶段名降级为brainstorming。
   * @param {string} phase - 执行阶段名称（brainstorming/requirement-analysis/architecture-design/module-development/integration-testing/deployment）
   * @returns {{ phase: string, coreIdentity: {content: string, lines: number}, rules: Array<{name: string, content: string, lines: number}>, agents: Array<{name: string, content: string, lines: number}>, phaseSkills: Array<string>, estimatedTokens: number }} 阶段上下文
   */
  injectForPhase(phase) {
    this.guardShutdown();
    if (!phase || !Object.hasOwn(PHASE_INDEX, phase)) {
      phase = 'brainstorming';
    }
    const now = Date.now();
    const cached = this._cache.get(phase);
    if (cached && (now - cached.timestamp <= CACHE_TTL_MS)) {
      return this._cloneCachedResult(cached.result);
    }
    if (process.env.NODE_ENV === 'production') {
      debug('PhaseContextInjector', 'syncReadWarning', 'Consider using injectForPhaseAsync in production');
    }
    this._currentPhase = phase;
    const result = this._buildPhaseContext(phase);
    this._cache.set(phase, { result, timestamp: Date.now() });
    this._injectedTokenEstimate = result.estimatedTokens;
    this.emit('phase-context-injected', { phase, estimatedTokens: result.estimatedTokens, rulesCount: result.rules.length, agentsCount: result.agents.length });
    return this._cloneCachedResult(result);
  }

  /**
   * 异步注入指定阶段的上下文。功能与injectForPhase相同，但使用异步文件读取。
   * 适用于需要非阻塞IO的场景。
   * @param {string} phase - 执行阶段名称
   * @returns {Promise<{ phase: string, coreIdentity: {content: string, lines: number}, rules: Array<{name: string, content: string, lines: number}>, agents: Array<{name: string, content: string, lines: number}>, phaseSkills: Array<string>, estimatedTokens: number }>} 阶段上下文
   */
  async injectForPhaseAsync(phase) {
    if (!this.isHealthy()) {
      return { phase: phase || 'brainstorming', coreIdentity: { content: '', lines: 0 }, rules: [], agents: [], phaseSkills: [], estimatedTokens: 0 };
    }
    if (!phase || !Object.hasOwn(PHASE_INDEX, phase)) {
      debug('PhaseContextInjector', 'injectForPhaseAsync', 'Invalid phase: ' + phase + ', falling back to brainstorming');
      phase = 'brainstorming';
    }
    const now = Date.now();
    const cached = this._cache.get(phase);
    if (cached && (now - cached.timestamp <= CACHE_TTL_MS)) {
      return this._cloneCachedResult(cached.result);
    }
    try {
      const result = await this._buildPhaseContextAsync(phase);
      if (this._shutDown) return { phase, coreIdentity: { content: '', lines: 0 }, rules: [], agents: [], phaseSkills: [], estimatedTokens: 0 };
      this._currentPhase = phase;
      this._cache.set(phase, { result, timestamp: Date.now() });
      this._injectedTokenEstimate = result.estimatedTokens;
      this.emit('phase-context-injected', { phase, estimatedTokens: result.estimatedTokens, rulesCount: result.rules.length, agentsCount: result.agents.length });
      return this._cloneCachedResult(result);
    } catch (err) {
      debug('PhaseContextInjector', 'injectForPhaseAsync', err && err.message ? err.message : String(err));
      return { phase, coreIdentity: { content: '', lines: 0 }, rules: [], agents: [], phaseSkills: [], estimatedTokens: 0 };
    }
  }

  _buildPhaseContext(phase) {
    const coreIdentity = this._extractCoreIdentity();
    const rules = this._loadRulesForPhase(phase);
    const agents = this._loadAgentsForPhase(phase);
    const phaseSkills = PHASE_SKILLS[phase] ?? [];
    const estimatedTokens = this._estimateTokens(coreIdentity, rules, agents, phaseSkills);
    return {
      phase,
      coreIdentity,
      rules,
      agents,
      phaseSkills,
      estimatedTokens,
    };
  }

  _extractCoreIdentity() {
    try {
      if (!fs.existsSync(this._claudePath)) {
        return { content: '', lines: 0 };
      }
      const full = fs.readFileSync(this._claudePath, UTF8_ENCODING);
      const lines = full.split(/\r?\n/);
      const coreLines = [];
      let inAgentSection = false;
      let inRuleSection = false;
      let inSkillSection = false;
      for (const line of lines) {
        if (line.match(/^##\s+Agent/) || line.match(/^##\s+角色/)) { inAgentSection = true; inRuleSection = false; inSkillSection = false; continue; }
        if (line.match(/^##\s+全局规则/) || line.match(/^##\s+Rules/)) { inRuleSection = true; inAgentSection = false; inSkillSection = false; continue; }
        if (line.match(/^##\s+Skill/) || line.match(/^##\s+技能/)) { inSkillSection = true; inAgentSection = false; inRuleSection = false; continue; }
        if (line.match(/^##\s+/)) { inAgentSection = false; inRuleSection = false; inSkillSection = false; }
        if (inAgentSection || inRuleSection || inSkillSection) continue;
        if (line.startsWith('@include')) continue;
        coreLines.push(line);
        if (coreLines.length >= CORE_IDENTITY_MAX_LINES) break;
      }
      return { content: coreLines.join('\n'), lines: coreLines.length };
    } catch (e) {
      debug('PhaseContextInjector', '_extractCoreIdentity', e && e.message ? e.message : String(e));
      return { content: '', lines: 0 };
    }
  }

  _loadFilesForPhase(dir, names, debugLabel) {
    const results = [];
    for (const name of names) {
      const filePath = path.join(dir, name + MARKDOWN_EXT);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, UTF8_ENCODING);
          results.push({ name, content, lines: content.split(/\r?\n/).length });
        } catch (e) {
          debug('PhaseContextInjector', debugLabel, e && e.message ? e.message : String(e));
        }
      }
    }
    return results;
  }

  _loadRulesForPhase(phase) {
    return this._loadFilesForPhase(this._rulesDir, PHASE_RULES_MAP[phase] ?? [], 'loadRule');
  }

  _loadAgentsForPhase(phase) {
    return this._loadFilesForPhase(this._agentsDir, PHASE_AGENTS_MAP[phase] ?? [], 'loadAgent');
  }

  async _buildPhaseContextAsync(phase) {
    const coreIdentity = await this._extractCoreIdentityAsync();
    const rules = await this._loadRulesForPhaseAsync(phase);
    const agents = await this._loadAgentsForPhaseAsync(phase);
    const phaseSkills = PHASE_SKILLS[phase] ?? [];
    const estimatedTokens = this._estimateTokens(coreIdentity, rules, agents, phaseSkills);
    return {
      phase,
      coreIdentity,
      rules,
      agents,
      phaseSkills,
      estimatedTokens,
    };
  }

  async _extractCoreIdentityAsync() {
    try {
      await fs.promises.access(this._claudePath);
    } catch (err) {
      debug('PhaseContextInjector', '_extractCoreIdentityAsync: access failed', err && err.message ? err.message : String(err));
      return { content: '', lines: 0 };
    }
    try {
      const full = await fs.promises.readFile(this._claudePath, UTF8_ENCODING);
      const lines = full.split(/\r?\n/);
      const coreLines = [];
      let inAgentSection = false;
      let inRuleSection = false;
      let inSkillSection = false;
      for (const line of lines) {
        if (line.match(/^##\s+Agent/) || line.match(/^##\s+角色/)) { inAgentSection = true; inRuleSection = false; inSkillSection = false; continue; }
        if (line.match(/^##\s+全局规则/) || line.match(/^##\s+Rules/)) { inRuleSection = true; inAgentSection = false; inSkillSection = false; continue; }
        if (line.match(/^##\s+Skill/) || line.match(/^##\s+技能/)) { inSkillSection = true; inAgentSection = false; inRuleSection = false; continue; }
        if (line.match(/^##\s+/)) { inAgentSection = false; inRuleSection = false; inSkillSection = false; }
        if (inAgentSection || inRuleSection || inSkillSection) continue;
        if (line.startsWith('@include')) continue;
        coreLines.push(line);
        if (coreLines.length >= CORE_IDENTITY_MAX_LINES) break;
      }
      return { content: coreLines.join('\n'), lines: coreLines.length };
    } catch (e) {
      debug('PhaseContextInjector', 'extractCoreIdentityAsync', e && e.message ? e.message : String(e));
      return { content: '', lines: 0 };
    }
  }

  async _loadFilesForPhaseAsync(dir, names, debugLabel) {
    const results = [];
    for (const name of names) {
      const filePath = path.join(dir, name + MARKDOWN_EXT);
      try {
        await fs.promises.access(filePath);
        const content = await fs.promises.readFile(filePath, UTF8_ENCODING);
        results.push({ name, content, lines: content.split(/\r?\n/).length });
      } catch (e) {
        debug('PhaseContextInjector', debugLabel, e && e.message ? e.message : String(e));
      }
    }
    return results;
  }

  async _loadRulesForPhaseAsync(phase) {
    return this._loadFilesForPhaseAsync(this._rulesDir, PHASE_RULES_MAP[phase] ?? [], 'loadRuleAsync');
  }

  async _loadAgentsForPhaseAsync(phase) {
    return this._loadFilesForPhaseAsync(this._agentsDir, PHASE_AGENTS_MAP[phase] ?? [], 'loadAgentAsync');
  }

  _estimateTokens(coreIdentity, rules, agents, _phaseSkills) {
    const AVG_TOKENS_PER_LINE = 15;
    let totalLines = coreIdentity.lines;
    for (const r of rules) totalLines += r.lines;
    for (const a of agents) totalLines += a.lines;
    return totalLines * AVG_TOKENS_PER_LINE;
  }

  _cloneCachedResult(result) {
    if (!result) return result;
    return {
      phase: result.phase,
      coreIdentity: { content: result.coreIdentity.content, lines: result.coreIdentity.lines },
      rules: result.rules.map(function(r) { return { name: r.name, content: r.content, lines: r.lines }; }),
      agents: result.agents.map(function(a) { return { name: a.name, content: a.content, lines: a.lines }; }),
      phaseSkills: result.phaseSkills.slice(),
      estimatedTokens: result.estimatedTokens,
    };
  }

  /**
   * 获取最近一次注入的Token估算值。
   * @returns {number} Token估算值
   */
  getInjectedTokenEstimate() {
    if (!this.isHealthy()) return 0;
    return this._injectedTokenEstimate;
  }

  /**
   * 获取当前激活的阶段名称。
   * @returns {string|null} 当前阶段名，尚未注入时返回null
   */
  getCurrentPhase() {
    if (!this.isHealthy()) return null;
    return this._currentPhase;
  }

  /**
   * 获取阶段与规则文件的映射表。每个阶段映射到一组需加载的规则文件名。
   * @returns {Object<string, Array<string>>} 阶段→规则文件名列表的映射
   */
  getPhaseRulesMap() {
    this.guardShutdown();
    return PHASE_RULES_MAP;
  }

  /**
   * 获取阶段与Agent角色的映射表。每个阶段映射到一组需加载的Agent定义文件名。
   * @returns {Map} 阶段与Agent角色名列表的映射
   */
  getPhaseAgentsMap() {
    return PHASE_AGENTS_MAP;
  }

  /**
   * 获取注入器的统计信息，包括当前阶段、Token估算、已加载规则/Agent/技能数和缓存大小。
   * @returns {{ currentPhase: string|null, injectedTokenEstimate: number, rulesLoaded: number, agentsLoaded: number, phaseSkillsCount: number, cacheSize: number }} 统计信息
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('PhaseContextInjector', 'guardShutdown', _e && _e.message ? _e.message : String(_e)); return { currentPhase: null, injectedTokenEstimate: 0, rulesLoaded: 0, agentsLoaded: 0, phaseSkillsCount: 0, cacheSize: 0 }; }
    const cached = this._cache.get(this._currentPhase);
    const cachedResult = cached ? cached.result : null;
    return {
      currentPhase: this._currentPhase,
      injectedTokenEstimate: this._injectedTokenEstimate,
      rulesLoaded: cachedResult ? cachedResult.rules.length : 0,
      agentsLoaded: cachedResult ? cachedResult.agents.length : 0,
      phaseSkillsCount: cachedResult ? cachedResult.phaseSkills.length : 0,
      cacheSize: this._cache.size,
    };
  }

  /**
   * 清除所有阶段上下文缓存，触发cache-cleared事件。
   * @returns {void}
   */
  clearCache() {
    this.guardShutdown();
    this._cache.clear();
    this.emit('cache-cleared');
  }

  _onShutdown() {
    this._cache.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(PhaseContextInjector);
