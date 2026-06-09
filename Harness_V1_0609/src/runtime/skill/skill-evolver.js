'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { debug } = require('../../utils/debug-logger');
const { safeJsonParse } = require('../../utils/safe-parse');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { UTF8_ENCODING, HARNESS_DIR, MAX_IMPROVEMENT_ITEMS } = require('../../utils/constants');
const { writeAtomicTextAsync } = require('../../utils/debounced-persister');
const { emitError } = require('../../utils/safe-execute');

const SKILL_BACKUP_DIR = HARNESS_DIR + '/skills/.backups';
const MAX_BACKUPS_PER_SKILL = 5;
const EVOLUTION_MARKER = '<!-- evolution-section -->';
const MIN_TOKEN_BUDGET_RATIO = 0.3;
const MAX_EVOLUTIONS = 10000;

/**
 * @module runtime/skill/skill-evolver
 * SkillEvolver — 技能演化器
 * 基于LLM分析会话轨迹，自动提炼技能改进方案。三阶段流水线：
 * summarize（提取成功/失败模式）→ aggregate（识别不变量与修改目标）→ execute（生成精化指令）。
 * 演化结果以补丁形式暂存，经SkillPatchApproval审批或手动审核后写入技能文件。
 * 写入前自动备份（最多5份），通过evolution-section标记区分原始与演化内容。
 * Token预算不足时自动跳过，演化次数上限10000次。
 * @classdesc 技能演化器。技能自动进化、变异生成、适应度评估、attachSkillCreationEngine()桥接newSkills输出到SkillCreationEngine、_processNewSkills()新技能自动注册。
 * @extends EventEmitter
 * @emits SkillEvolver#evolution-completed
 * @emits SkillEvolver#evolution-applied
 * @emits SkillEvolver#patch-pending-approval
 * @emits SkillEvolver#patch-evicted
 * @emits SkillEvolver#skill-backed-up
 * @emits SkillEvolver#evolution-patches-discarded
 */
class SkillEvolver extends EventEmitter {
  /**
   * 创建 SkillEvolver 实例。
   * @param {Object} [options] - 配置选项
   * @param {Object} [options.llmClient=null] - LLM客户端实例
   * @param {Object} [options.tokenManager=null] - Token管理器实例
   * @param {Object} [options.patchApproval=null] - 技能补丁审批器实例
   */
  constructor(options) {
    super();
    this._llmClient = (options && options.llmClient) ?? null;
    this._tokenManager = (options && options.tokenManager) ?? null;
    this._patchApproval = (options && options.patchApproval) ?? null;
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._skillRouter = (options && options.skillRouter) ?? null;
    this._skillCreationEngine = (options && options.skillCreationEngine) ?? null;
    this._projectRoot = (options && options.projectRoot) ?? '';
    this._pendingEvolvedPatches = Object.create(null);
    this._stats = { evolutions: 0, pendingPatches: 0, appliedPatches: 0, errors: 0, newSkillsCreated: 0 };
  }

  /**
   * 挂载LLM客户端实例，用于调用LLM分析会话轨迹
   * @param {Object} client - LLM客户端实例，需提供chat方法
   * @returns {SkillEvolver} 当前实例，支持链式调用
   */
  attachLlmClient(client) {
    this._llmClient = client;
    return this;
  }

  /**
   * 挂载Token管理器实例，用于检查Token预算
   * @param {Object} tm - TokenManager实例
   * @returns {SkillEvolver} 当前实例，支持链式调用
   */
  attachTokenManager(tm) {
    this._tokenManager = tm;
    return this;
  }

  /**
   * 挂载技能补丁审批器实例，用于管理演化补丁的审批流程
   * @param {Object} pa - SkillPatchApproval实例
   * @returns {SkillEvolver} 当前实例，支持链式调用
   */
  attachPatchApproval(pa) {
    this._patchApproval = pa;
    return this;
  }

  /**
   * 挂载SQLite存储实例
   * @param {Object} store - SQLite存储实例
   * @returns {SkillEvolver} 当前实例，支持链式调用
   */
  attachSqliteStore(store) {
    this._sqliteStore = store;
    return this;
  }

  /**
   * 挂载SkillRouter实例，用于查找技能文件路径和重新发现
   * @param {Object} router - SkillRouter实例
   * @returns {SkillEvolver} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    this._skillRouter = router;
    return this;
  }

  /**
   * 挂载SkillCreationEngine实例，用于将演化产生的新技能自动注入创建引擎
   * @param {Object} engine - SkillCreationEngine实例
   * @returns {SkillEvolver} 当前实例，支持链式调用
   */
  attachSkillCreationEngine(engine) {
    this._skillCreationEngine = engine;
    return this;
  }

  /**
   * 对指定技能执行三阶段演化流水线（summarize→aggregate→execute），生成改进补丁
   * @param {string} skillId - 技能ID
   * @param {Array} sessionTraces - 会话轨迹数组
   * @returns {Promise<{success: boolean, skillId?: string, summary?: Object, aggregation?: Object, execution?: Object, error?: string, skipped?: boolean}>} 演化结果
   */
  async evolve(skillId, sessionTraces) {
    const validation = this._validateEvolvePrerequisites(sessionTraces);
    if (!validation.valid) {
      return { success: false, error: validation.error, skipped: validation.skipped };
    }
    try {
      const summary = await this._summarize(skillId, sessionTraces);
      const aggregation = await this._aggregate(skillId, summary);
      const execution = await this._execute(skillId, aggregation);

      this._stats.evolutions++;
      this._storeEvolvedPatch(skillId, execution, aggregation, summary);

      this.emit('evolution-completed', {
        skillId: skillId,
        hasRefinedBody: !!(execution && execution.refinedBody),
      });

      return { success: true, skillId: skillId, summary: summary, aggregation: aggregation, execution: execution };
    } catch (err) {
      this._stats.errors++;
      emitError(this, 'evolution-error', err, { skillId });
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _validateEvolvePrerequisites(sessionTraces) {
    if (!this.isHealthy()) return { valid: false, error: 'SkillEvolver is shut down' };
    if (sessionTraces == null) return { valid: false, error: 'sessionTraces is required' };
    if (!this._llmClient) return { valid: false, error: 'LLM client not attached' };
    if (!this._skillRouter) return { valid: false, error: 'skillRouter not attached' };
    if (!this._isEvolutionHealthy()) return { valid: false, error: 'Evolution limit reached' };
    if (this._tokenManager) {
      const budget = this._tokenManager.getBudgetStatus();
      if (budget.total > 0 && budget.remaining / budget.total < MIN_TOKEN_BUDGET_RATIO) {
        return { valid: false, skipped: true, error: 'Token budget insufficient' };
      }
    }
    return { valid: true };
  }

  _storeEvolvedPatch(skillId, execution, aggregation, summary) {
    if (!execution || !execution.refinedBody) return;
    const patchData = {
      refinedBody: execution.refinedBody,
      newSkills: execution.newSkills ?? [],
      invariants: aggregation.invariants ?? [],
      modificationTargets: aggregation.modificationTargets ?? [],
      summary: summary,
      evolvedAt: Date.now(),
    };

    if (this._patchApproval) {
      this._patchApproval.submit(skillId, patchData);
    } else {
      const pendingKeys = Object.keys(this._pendingEvolvedPatches);
      if (pendingKeys.length >= 100 && !this._pendingEvolvedPatches[skillId]) {
        delete this._pendingEvolvedPatches[pendingKeys[0]];
        this.emit('patch-evicted', { skillId: pendingKeys[0], reason: 'capacity_exceeded' });
      }
      this._pendingEvolvedPatches[skillId] = patchData;
      this._stats.pendingPatches = Object.keys(this._pendingEvolvedPatches).length;
      this.emit('patch-pending-approval', { skillId, patchData, reason: 'No patchApproval configured - manual review required before applyEvolvedPatch()' });
    }
  }

  async _summarize(skillId, traces) {
    const prompt = [
      'Analyze the following session traces for skill "' + skillId + '" and extract success/failure patterns.',
      'Traces:',
      (function() { try { return JSON.stringify(traces, null, 2); } catch (_e) { debug('SkillEvolver', 'stringify', _e && _e.message ? _e.message : String(_e)); return String(traces); } })(),
      '',
      'Return a JSON object with: { "patterns": [...], "failures": [...] }',
    ].join('\n');

    const response = await this._llmClient.chat(prompt);
    if (!response || typeof response.content !== 'string') { return { patterns: [], failures: [], raw: String(response) }; }
    try {
      return safeJsonParse(response.content, { patterns: [], failures: [], raw: response.content });
    } catch (_err) {
      debug('SkillEvolver', '_extract:jsonParse', _err && _err.message ? _err.message : String(_err));
      return { raw: response.content, patterns: [], failures: [] };
    }
  }

  async _aggregate(skillId, summary) {
    const prompt = [
      'Based on the following summary for skill "' + skillId + '", identify what must be preserved (invariants) and what needs changing (modification targets).',
      'Summary:',
      (function() { try { return JSON.stringify(summary, null, 2); } catch (_e) { debug('SkillEvolver', 'stringify', _e && _e.message ? _e.message : String(_e)); return String(summary); } })(),
      '',
      'Return a JSON object with: { "invariants": [...], "modificationTargets": [...] }',
    ].join('\n');

    const response = await this._llmClient.chat(prompt);
    if (!response || typeof response.content !== 'string') { return { invariants: [], modificationTargets: [], raw: String(response) }; }
    try {
      return safeJsonParse(response.content, { invariants: [], modificationTargets: [], raw: response.content });
    } catch (_err) {
      debug('SkillEvolver', '_aggregate:jsonParse', _err && _err.message ? _err.message : String(_err));
      return { invariants: [], modificationTargets: [], raw: response.content };
    }
  }

  async _execute(skillId, aggregation) {
    const prompt = [
      'Based on the following aggregation for skill "' + skillId + '", generate improved skill instructions.',
      'Aggregation:',
      (function() { try { return JSON.stringify(aggregation, null, 2); } catch (_e) { debug('SkillEvolver', 'stringify', _e && _e.message ? _e.message : String(_e)); return String(aggregation); } })(),
      '',
      'Return a JSON object with: { "refinedBody": "...", "newSkills": [...] }',
    ].join('\n');

    const response = await this._llmClient.chat(prompt);
    if (!response || typeof response.content !== 'string') { return { refinedBody: null, newSkills: [], raw: String(response) }; }
    try {
      return safeJsonParse(response.content, { refinedBody: null, newSkills: [], raw: response.content });
    } catch (_err) {
      debug('SkillEvolver', '_execute:jsonParse', _err && _err.message ? _err.message : String(_err));
      return { refinedBody: response.content, newSkills: [] };
    }
  }

  _splitFrontmatter(content) {
    if (!content.startsWith('---')) {
      return { frontmatter: '', body: content };
    }
    const pos1 = content.indexOf('\r\n---', 3);
    const pos2 = content.indexOf('\n---', 3);
    let secondSep = -1;
    if (pos1 !== -1 && pos2 !== -1) secondSep = Math.min(pos1, pos2);
    else if (pos1 !== -1) secondSep = pos1;
    else secondSep = pos2;
    if (secondSep === -1) {
      return { frontmatter: '', body: content };
    }
    const sepEnd = content[secondSep] === '\r' ? secondSep + 5 : secondSep + 4;
    const frontmatter = content.substring(0, sepEnd);
    const body = content.substring(sepEnd).trim();
    return { frontmatter, body };
  }

  _resolvePatch(skillId) {
    if (this._patchApproval) {
      const approvedPatch = this._patchApproval.getApprovedPatchForSkill(skillId);
      if (!approvedPatch) return { patch: null, error: 'No approved patch for ' + skillId };
      return { patch: approvedPatch, error: null };
    }
    const patch = this._pendingEvolvedPatches[skillId];
    if (!patch) return { patch: null, error: 'No pending patch for ' + skillId };
    return { patch, error: null };
  }

  _resolveSkillPath(skillId) {
    if (!this._skillRouter || !this._skillRouter.registry) {
      return { skillPath: null, error: 'SkillRouter or registry not initialized' };
    }
    const skill = this._skillRouter.registry[skillId];
    if (!skill) return { skillPath: null, error: 'Skill not found: ' + skillId };
    if (!skill._filePath) return { skillPath: null, error: 'Skill file path not found' };
    return { skillPath: skill._filePath, error: null };
  }

  /**
   * 将已审批的演化补丁应用到技能文件，写入前自动备份
   * @param {string} skillId - 技能ID
   * @param {Object} [options] - 选项
   * @param {boolean} [options.skipApproval=false] - 跳过审批检查（需手动审核后使用）
   * @returns {Promise<{success: boolean, skillId?: string, error?: string}>} 应用结果
   */
  async applyEvolvedPatch(skillId, options) {
    if (!this.isHealthy()) {
      return { success: false, error: 'SkillEvolver is shut down' };
    }

    if (!this._patchApproval && !(options && options.skipApproval)) {
      return { success: false, error: 'Cannot apply patch without approval: configure patchApproval or pass { skipApproval: true } after manual review' };
    }

    const patchResult = this._resolvePatch(skillId);
    if (patchResult.error) return { success: false, error: patchResult.error };
    const patch = patchResult.patch;

    const pathResult = this._resolveSkillPath(skillId);
    if (pathResult.error) return { success: false, error: pathResult.error };
    const skillPath = pathResult.skillPath;

    try {
      await fsp.access(skillPath);
    } catch (err) {
      return { success: false, error: 'Skill file not found: ' + (err && err.message ? err.message : String(err)) };
    }

    try {
      await this._backupSkill(skillId, skillPath);
    } catch (backupErr) {
      debug('SkillEvolver', 'backupFailed', backupErr && backupErr.message);
      return { success: false, error: 'Failed to backup skill: ' + (backupErr && backupErr.message) };
    }

    let content;
    try {
      content = await fsp.readFile(skillPath, UTF8_ENCODING);
    } catch (readErr) {
      return { success: false, error: 'Failed to read skill file: ' + (readErr && readErr.message) };
    }

    const newContent = this._buildEvolvedContent(content, patch);
    try {
      await writeAtomicTextAsync(skillPath, newContent, UTF8_ENCODING);
    } catch (writeErr) {
      return { success: false, error: 'Failed to write skill file: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)) };
    }

    if (this._skillRouter && typeof this._skillRouter.discoverAsync === 'function') {
      await this._skillRouter.discoverAsync();
    }

    this._finalizeAppliedPatch(skillId, patch);

    this._stats.appliedPatches++;

    await this._processNewSkills(patch);

    this.emit('evolution-applied', { skillId: skillId });
    return { success: true, skillId: skillId };
  }

  _buildEvolvedContent(content, patch) {
    const splitResult = this._splitFrontmatter(content);
    const frontmatter = splitResult.frontmatter;
    const body = splitResult.body;
    const markerIndex = body.indexOf(EVOLUTION_MARKER);
    let newBody;
    const evolutionSection = this._buildEvolutionSection(patch);

    if (markerIndex !== -1) {
      const beforeMarker = body.substring(0, markerIndex).trim();
      newBody = beforeMarker + '\n\n' + EVOLUTION_MARKER + '\n' + evolutionSection + '\n';
    } else {
      newBody = body + '\n\n' + EVOLUTION_MARKER + '\n' + evolutionSection + '\n';
    }

    return frontmatter + (frontmatter ? '\n' : '') + newBody;
  }

  async _processNewSkills(patch) {
    if (!Array.isArray(patch.newSkills) || patch.newSkills.length === 0) return;

    if (!this._skillCreationEngine) {
      this.emit('new-skills-warning', {
        count: patch.newSkills.length,
        reason: 'SkillCreationEngine not attached — new skills from evolution will not be auto-created',
      });
      return;
    }

    const createdIds = [];
    for (const newSkill of patch.newSkills) {
      const evaluation = {
        shouldCreate: true,
        skillName: newSkill.name || newSkill.skillName || null,
        complexity: newSkill.complexity ?? 5,
        triggers: {
          isComplex: true,
          hasRecovery: false,
          hasCorrection: false,
        },
        steps: newSkill.steps ?? [],
      };

      if (!evaluation.skillName) continue;

      const content = {
        pitfalls: newSkill.pitfalls ?? [],
        verification: newSkill.verification ?? null,
      };

      try {
        const result = await this._skillCreationEngine.createSkill(evaluation, content);
        if (result && result.success) {
          createdIds.push(result.skillName);
          this._stats.newSkillsCreated++;
        }
      } catch (err) {
        emitError(this, 'new-skill-creation-error', err, { skillName: evaluation.skillName });
      }
    }

    if (createdIds.length > 0) {
      this.emit('new-skills-created', { count: createdIds.length, skillIds: createdIds });
    }
  }

  _finalizeAppliedPatch(skillId, patch) {
    if (this._patchApproval) {
      if (patch.patchId) {
        this._patchApproval.markApplied(patch.patchId);
      }
    } else {
      delete this._pendingEvolvedPatches[skillId];
      this._stats.pendingPatches = Object.keys(this._pendingEvolvedPatches).length;
    }
  }

  _buildEvolutionSection(patch) {
    let section = '> Evolved based on LLM analysis (' + new Date().toISOString().split('T')[0] + ')\n\n';
    if (patch.refinedBody) {
      section += patch.refinedBody + '\n';
    }
    if (Array.isArray(patch.invariants) && patch.invariants.length > 0) {
      section += '\n### Invariants\n';
      for (const inv of patch.invariants.slice(0, MAX_IMPROVEMENT_ITEMS)) {
        section += '- ' + inv + '\n';
      }
    }
    if (Array.isArray(patch.modificationTargets) && patch.modificationTargets.length > 0) {
      section += '\n### Modification Targets\n';
      for (const mt of patch.modificationTargets.slice(0, MAX_IMPROVEMENT_ITEMS)) {
        section += '- ' + mt + '\n';
      }
    }
    return section;
  }

  async _backupSkill(skillId, skillPath) {
    const backupDir = path.join(this._projectRoot, SKILL_BACKUP_DIR);
    await fsp.mkdir(backupDir, { recursive: true });

    try {
      const backupFiles = (await fsp.readdir(backupDir))
        .filter(function(f) { return f.startsWith(skillId + '.') && f.endsWith('.md'); })
        .sort(function(a, b) { const ta = parseInt(a.slice(a.lastIndexOf('.') + 1, -3), 10) || 0; const tb = parseInt(b.slice(b.lastIndexOf('.') + 1, -3), 10) || 0; return ta - tb; });
      while (backupFiles.length >= MAX_BACKUPS_PER_SKILL) {
        const toDelete = backupFiles.shift();
        await fsp.unlink(path.join(backupDir, toDelete)).catch(function(err) { debug('SkillEvolver', 'backupDelete', err && err.message ? err.message : String(err)); });
      }
    } catch (err) {
      debug('SkillEvolver', 'backupCleanup', err);
    }

    const ts = Date.now();
    const backupPath = path.join(backupDir, skillId + '.' + ts + '.md');
    try {
      await fsp.copyFile(skillPath, backupPath);
    } catch (copyErr) {
      debug('SkillEvolver', 'backupCopyFailed', copyErr && copyErr.message);
      throw copyErr;
    }
    this.emit('skill-backed-up', { skillId, backupPath });
  }

  /**
   * 获取所有待审批的演化补丁
   * @returns {Object.<string, Object>} 技能ID到补丁数据的映射
   */
  getPendingEvolvedPatches() {
    const result = {};
    for (const [key, val] of Object.entries(this._pendingEvolvedPatches)) {
      result[key] = {
        refinedBody: val.refinedBody,
        newSkills: Array.isArray(val.newSkills) ? val.newSkills.map(s => ({ ...s })) : [],
        invariants: Array.isArray(val.invariants) ? [...val.invariants] : [],
        modificationTargets: Array.isArray(val.modificationTargets) ? [...val.modificationTargets] : [],
        summary: val.summary ? { ...val.summary } : null,
        evolvedAt: val.evolvedAt,
      };
    }
    return result;
  }

  /**
   * 获取演化器统计信息
   * @returns {{ evolutions: number, pendingPatches: number, appliedPatches: number, errors: number }} 统计数据
   */
  getStats() {
    return {
      evolutions: this._stats.evolutions,
      pendingPatches: Object.keys(this._pendingEvolvedPatches).length,
      appliedPatches: this._stats.appliedPatches,
      errors: this._stats.errors,
      newSkillsCreated: this._stats.newSkillsCreated,
    };
  }

  _isEvolutionHealthy() {
    return this._stats.evolutions < MAX_EVOLUTIONS;
  }

  _onShutdown() {
    const count = Object.keys(this._pendingEvolvedPatches).length;
    if (count > 0) {
      this.emit('evolution-patches-discarded', { count });
    }
    this._pendingEvolvedPatches = Object.create(null);
    this.removeAllListeners();
  }
}

const SkillEvolverWithShutdown = withShutdown(SkillEvolver);

/**
 * 检查演化器是否健康（未关闭且演化次数未达上限）
 * @returns {boolean} 是否健康
 */
SkillEvolverWithShutdown.prototype.isHealthy = function() {
  if (typeof this._initShutdownState === 'function') this._initShutdownState();
  if (this._shutDown) return false;
  return this._isEvolutionHealthy();
};

module.exports = SkillEvolverWithShutdown;
