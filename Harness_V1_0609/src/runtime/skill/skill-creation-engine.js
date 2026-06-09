'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { debug } = require('../../utils/debug-logger');
const { isPathWithinDir } = require('../../utils/path-utils');
const { writeAtomicTextAsync } = require('../../utils/debounced-persister');
const { UTF8_ENCODING, HARNESS_DIR } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');

const COMPLEXITY_THRESHOLD = 5;
const AUTO_SKILL_DIR = HARNESS_DIR + '/skills/auto-created';
const MAX_AUTO_CREATED_SKILLS = 10000;
const fsp = fs.promises;

/**
 * @module runtime/skill/skill-creation-engine
 * SkillCreationEngine — 技能创建引擎
 * 从需求自动生成新Skill定义。监听AgentRuntime的task:completed/task:failed事件，
 * 评估任务复杂度（≥5步工具调用）、错误恢复、用户纠正等触发条件，
 * 自动生成Markdown格式的技能文件到.harness/skills/auto-created/目录。
 * 内置路径遍历防护、技能名合法性校验、重复检测，创建后自动触发SkillRouter重新发现。
 * @extends EventEmitter
 * @emits SkillCreationEngine#auto-skill-evaluation
 * @emits SkillCreationEngine#skill-created
 * @emits SkillCreationEngine#skill-deleted
 */
class SkillCreationEngine extends EventEmitter {
  /**
   * 创建 SkillCreationEngine 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.projectRoot=''] - 项目根目录路径
   * @param {Object} [options.skillRouter=null] - SkillRouter实例
   * @param {Object} [options.sqliteStore=null] - SQLite存储实例
   */
  constructor(options) {
    super();
    this._projectRoot = (options && options.projectRoot) || '';
    this._skillRouter = (options && options.skillRouter) ?? null;
    this._sqliteStore = (options && options.sqliteStore) ?? null;
    this._stats = { evaluated: 0, created: 0, rejected: 0 };
    this._boundOnTaskCompleted = this._onTaskCompleted.bind(this);
    this._boundOnTaskFailed = this._onTaskFailed.bind(this);
  }

  /**
   * 挂载SkillRouter实例，用于检查技能是否已存在
   * @param {Object} router - SkillRouter实例
   * @returns {SkillCreationEngine} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    this._skillRouter = router;
    return this;
  }

  /**
   * 挂载SQLite存储实例
   * @param {Object} store - SQLite存储实例
   * @returns {SkillCreationEngine} 当前实例，支持链式调用
   */
  attachSqliteStore(store) {
    this._sqliteStore = store;
    return this;
  }

  /**
   * 挂载AgentRuntime实例，监听task:completed和task:failed事件以自动评估任务
   * @param {Object} runtime - AgentRuntime实例，需支持on方法
   * @returns {SkillCreationEngine} 当前实例，支持链式调用
   */
  attachToAgentRuntime(runtime) {
    if (this._agentRuntime === runtime) return this;
    if (this._agentRuntime) {
      this.detachFromAgentRuntime();
    }
    this._agentRuntime = runtime;
    runtime.on('task:completed', this._boundOnTaskCompleted);
    runtime.on('task:failed', this._boundOnTaskFailed);
    return this;
  }

  _onTaskCompleted(trace) {
    try {
      this._handleTaskTrace(trace, false);
    } catch (_err) {
      debug('SkillCreationEngine', '_onTaskCompleted', _err && _err.message ? _err.message : String(_err));
    }
  }

  _onTaskFailed(trace) {
    try {
      this._handleTaskTrace(trace, true);
    } catch (_err) {
      debug('SkillCreationEngine', '_onTaskFailed', _err && _err.message ? _err.message : String(_err));
    }
  }

  _handleTaskTrace(trace, hadError) {
    const executionTrace = {
      toolCalls: trace.toolCalls ?? 0,
      hadError: hadError,
      recovered: trace.recovered ?? false,
      userCorrection: trace.userCorrection ?? false,
      steps: trace.steps ?? [],
      description: trace.description || trace.taskDescription || '',
    };
    const result = this.evaluateTask(executionTrace);
    if (result.shouldCreate) {
      this.emit('auto-skill-evaluation', result);
    }
  }

  _onShutdown() {
    this.detachFromAgentRuntime();
    this._stats = { evaluated: 0, created: 0, rejected: 0 };
    this._projectRoot = '';
    this._skillRouter = null;
    this._sqliteStore = null;
    this.removeAllListeners();
  }

  /**
   * 从AgentRuntime取消事件监听，断开关联
   * @returns {void}
   */
  detachFromAgentRuntime() {
    if (this._agentRuntime) {
      this._agentRuntime.removeListener('task:completed', this._boundOnTaskCompleted);
      this._agentRuntime.removeListener('task:failed', this._boundOnTaskFailed);
      this._agentRuntime = null;
    }
  }

  /**
   * 评估任务执行轨迹是否满足自动创建技能的条件（复杂度≥5步、错误恢复、用户纠正）
   * @param {Object} executionTrace - 任务执行轨迹
   * @param {number} [executionTrace.toolCalls=0] - 工具调用次数
   * @param {boolean} [executionTrace.hadError=false] - 是否发生错误
   * @param {boolean} [executionTrace.recovered=false] - 是否成功恢复
   * @param {boolean} [executionTrace.userCorrection=false] - 是否有用户纠正
   * @param {Array} [executionTrace.steps=[]] - 执行步骤列表
   * @param {string} [executionTrace.description=''] - 任务描述
   * @returns {{ shouldCreate: boolean, reason?: string, skillName?: string, complexity?: number, triggers?: Object, steps?: Array }} 评估结果
   */
  evaluateTask(executionTrace) {
    this._stats.evaluated++;
    const trace = executionTrace ?? {};
    const toolCalls = typeof trace.toolCalls === 'number' && Number.isFinite(trace.toolCalls) ? trace.toolCalls : 0;
    const hadError = trace.hadError ?? false;
    const recovered = trace.recovered ?? false;
    const userCorrection = trace.userCorrection ?? false;
    const steps = trace.steps ?? [];

    const isComplex = toolCalls >= COMPLEXITY_THRESHOLD;
    const hasRecovery = hadError && recovered;
    const hasCorrection = userCorrection === true;

    if (!isComplex && !hasRecovery && !hasCorrection) {
      this._stats.rejected++;
      return { shouldCreate: false, reason: 'Task not complex enough' };
    }

    const skillName = this._generateSkillName(trace);
    if (!skillName) {
      this._stats.rejected++;
      return { shouldCreate: false, reason: 'Could not determine skill name' };
    }

    if (this._skillRouter) {
      const registry = this._skillRouter.registry;
      const byId = registry ? registry[skillName] : null;
      const byName = byId ? null : (Array.isArray(this._skillRouter.skills) ? this._skillRouter.skills.find(s => s.name === skillName) : null);
      const existing = byId || byName;
      if (existing) {
        this._stats.rejected++;
        return { shouldCreate: false, reason: 'Skill already exists: ' + skillName, existingSkillId: existing.skill_id };
      }
    }

    return {
      shouldCreate: true,
      skillName,
      complexity: toolCalls,
      triggers: { isComplex, hasRecovery, hasCorrection },
      steps,
    };
  }

  /**
   * 根据评估结果创建技能文件，写入.harness/skills/auto-created/目录并触发SkillRouter重新发现
   * @param {Object} evaluation - evaluateTask返回的评估结果，需包含shouldCreate=true和skillName
   * @param {Object} [content] - 可选的用户补充内容，含pitfalls和verification字段
   * @param {string[]} [content.pitfalls] - 避坑指南条目
   * @param {string} [content.verification] - 验证方法描述
   * @returns {Promise<{success: boolean, skillName?: string, skillPath?: string, error?: string}>} 创建结果
   */
  /** 验证创建技能的前置条件，返回错误信息或null */
  _validateCreatePrerequisites(evaluation) {
    if (!evaluation || !evaluation.shouldCreate) {
      return 'Evaluation does not recommend skill creation';
    }
    if (!this._projectRoot) {
      return 'projectRoot not set';
    }
    return null;
  }

  /** 验证技能名称和路径，返回错误信息或null */
  _validateSkillName(skillName, skillPath, skillDir) {
    if (!isPathWithinDir(skillPath, skillDir)) {
      return 'Invalid skill name: path traversal detected';
    }
    if (!/^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(skillName)) {
      return 'Invalid skill name: contains disallowed characters';
    }
    return null;
  }

  async createSkill(evaluation, content) {
    this._initShutdownState();
    if (!this.isHealthy()) {
      return { success: false, error: 'Engine is shut down' };
    }

    const prereqError = this._validateCreatePrerequisites(evaluation);
    if (prereqError) return { success: false, error: prereqError };

    const skillDir = path.join(this._projectRoot, AUTO_SKILL_DIR);

    const skillName = evaluation.skillName;
    const skillPath = path.join(skillDir, `${skillName}.md`);

    const nameError = this._validateSkillName(skillName, skillPath, skillDir);
    if (nameError) return { success: false, error: nameError };

    let exists = false;
    if (this._creatingSkills && this._creatingSkills.has(skillName)) {
      return { success: false, error: 'Skill is already being created: ' + skillName };
    }
    try { await fsp.access(skillPath); exists = true; } catch (_e) { exists = false; }
    if (this._shutDown) return { success: false, error: 'Shut down during creation' };
    if (exists) {
      return { success: false, error: 'Skill file already exists: ' + skillName };
    }

    if (!this._creatingSkills) this._creatingSkills = new Set();
    this._creatingSkills.add(skillName);
    const skillContent = this._buildSkillMarkdown(skillName, evaluation, content);
    try {
      await writeAtomicTextAsync(skillPath, skillContent, UTF8_ENCODING);
    } catch (writeErr) {
      this._creatingSkills.delete(skillName);
      debug('SkillCreationEngine', 'create', 'Failed to write skill file: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)));
      return { success: false, error: 'Failed to write skill file: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)) };
    }
    this._creatingSkills.delete(skillName);
    if (this._shutDown) return { success: false, error: 'Shut down during creation' };

    if (this._skillRouter && typeof this._skillRouter.discoverAsync === 'function') {
      try { await this._skillRouter.discoverAsync(); } catch (e) { debug('SkillCreationEngine', 'discoverAsync', e); }
    }
    if (this._shutDown) return { success: false, error: 'Shut down during creation' };

    this._stats.created++;
    this.emit('skill-created', { skillName, skillPath, evaluation });

    return { success: true, skillName, skillPath };
  }

  _generateSkillName(trace) {
    const desc = trace.description || trace.taskDescription || '';
    if (!desc) return null;

    let name = desc.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 40);

    if (!name || name.length < 2) return null;

    if (!name.startsWith('auto-')) name = 'auto-' + name;

    return name;
  }

  _buildSkillMarkdown(skillName, evaluation, userContent) {
    const lines = [];
    lines.push('---');
    lines.push(`skill_id: "${skillName.replace(/"/g, '\\"')}"`);
    lines.push(`name: 自动创建-${skillName.replace('auto-', '')}`);
    lines.push('applicable_agents: [task-worker, domain-analyst]');
    lines.push(`trigger: ${evaluation.triggers.isComplex ? '复杂任务' : '错误恢复'}后自动提炼的方法论`);
    lines.push('auto_trigger: false');
    lines.push('phase: module-development');
    lines.push('priority: 5');
    lines.push('enforcement: optional');
    lines.push('auto_created: true');
    lines.push(`created_at: ${new Date().toISOString().split('T')[0]}`);
    lines.push(`complexity: ${evaluation.complexity}`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${skillName}`);
    lines.push('');
    lines.push('## 适用场景');
    if (evaluation.triggers.isComplex) lines.push('- 复杂任务（≥5步工具调用）后提炼的方法论');
    if (evaluation.triggers.hasRecovery) lines.push('- 遭遇错误并成功恢复的经验');
    if (evaluation.triggers.hasCorrection) lines.push('- 用户纠正后的改进方法');
    lines.push('');

    lines.push('## 操作步骤');
    const steps = evaluation.steps ?? [];
    if (steps.length > 0) {
      for (let i = 0; i < steps.length; i++) {
        lines.push(`${i + 1}. ${steps[i]}`);
      }
    } else {
      lines.push('1. 根据具体任务执行');
    }
    lines.push('');

    if (userContent && userContent.pitfalls && userContent.pitfalls.length > 0) {
      lines.push('## 避坑指南');
      for (const p of userContent.pitfalls) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }

    if (userContent && userContent.verification) {
      lines.push('## 验证方法');
      lines.push(userContent.verification);
      lines.push('');
    } else {
      lines.push('## 验证方法');
      lines.push('- 确认任务按预期完成');
      lines.push('- 检查无回归错误');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 列出所有自动创建的技能名称
   * @returns {string[]} 技能名称列表（不含.md后缀）
   */
  async listAutoCreatedSkills() {
    try {
      const dir = path.join(this._projectRoot, AUTO_SKILL_DIR);
      const files = await fsp.readdir(dir);
      return files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
    } catch (_e) {
      if (_e && _e.code !== 'ENOENT') debug('SkillCreationEngine', 'listAutoCreatedSkills', _e && _e.message ? _e.message : String(_e));
      return [];
    }
  }

  /**
   * 删除指定的自动创建技能文件，并触发SkillRouter重新发现
   * @param {string} skillName - 要删除的技能名称
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteAutoCreatedSkill(skillName) {
    this._initShutdownState();
    if (!this.isHealthy()) return false;

    if (!this._projectRoot) return false;
    if (!/^[a-zA-Z0-9\u4e00-\u9fff_-]+$/.test(skillName)) return false;
    const skillDir = path.join(this._projectRoot, AUTO_SKILL_DIR);
    const skillPath = path.join(skillDir, `${skillName}.md`);
    if (!isPathWithinDir(skillPath, skillDir)) return false;
    if (!fs.existsSync(skillPath)) return false;
    try {
      await fsp.unlink(skillPath);
    } catch (unlinkErr) {
      debug('SkillCreationEngine', 'deleteAutoCreatedSkill', 'unlink failed: ' + (unlinkErr && unlinkErr.message ? unlinkErr.message : String(unlinkErr)));
      return false;
    }
    if (this._shutDown) return false;
    if (this._skillRouter && typeof this._skillRouter.discoverAsync === 'function') {
      try { await this._skillRouter.discoverAsync(); } catch (discErr) { debug('SkillCreationEngine', 'deleteAutoCreatedSkill', 'discover failed: ' + (discErr && discErr.message ? discErr.message : String(discErr))); }
    }
    if (this._shutDown) return false;
    this.emit('skill-deleted', { skillName });
    return true;
  }

  /**
   * 获取引擎统计信息
   * @returns {{ evaluated: number, created: number, rejected: number, autoCreatedSkills: number, complexityThreshold: number }} 统计数据
   */
  async getStats() {
    return { ...this._stats, autoCreatedSkills: (await this.listAutoCreatedSkills()).length, complexityThreshold: COMPLEXITY_THRESHOLD };
  }

  /**
   * 检查引擎是否健康（自动创建技能数未达上限）
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    return !this._shutDown && this._stats.created < MAX_AUTO_CREATED_SKILLS;
  }
}

module.exports = withShutdown(SkillCreationEngine);
