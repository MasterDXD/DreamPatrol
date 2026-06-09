'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { safeExecuteAsync } = require('../../utils/safe-execute');
const { isPathWithinDir } = require('../../utils/path-utils');
const { UTF8_ENCODING, HARNESS_DIR } = require('../../utils/constants');

const RETIREMENT_REASONS = {
  LOW_SUCCESS_RATE: 'low_success_rate',
  OBSOLESCENCE: 'obsolescence',
  REDUNDANCY: 'redundancy',
  MANUAL: 'manual',
};

const DEFAULT_CONFIG = {
  evaluationWindowMs: 604800000,
  minExecutionsForEvaluation: 20,
  lowSuccessThreshold: 0.5,
  obsolescenceDays: 90,
  retirementArchiveDir: 'archive/retired-skills',
};

/**
 * @module runtime/skill/skill-retirement-manager
 * SkillRetirementManager — 技能退役管理器
 * 管理技能生命周期终止阶段：评估技能健康度、退役低效技能、归档技能文件、
 * 支持从归档中重新激活。退役原因包括低成功率、过时、冗余和手动退役。
 * @classdesc 技能退休管理器。技能生命周期管理（active/retired/archived），退休条件评估（低效能/低频使用/被替代），reactivation重新激活，退休审计追踪。
 * @extends EventEmitter
 * @emits SkillRetirementManager#skill-retired
 * @emits SkillRetirementManager#skill-reactivated
 * @emits SkillRetirementManager#retirement-candidate-detected
 */
class SkillRetirementManager extends EventEmitter {
  /**
   * @param {Object} [options] - 配置选项
   * @param {number} [options.evaluationWindowMs=604800000] - 评估窗口（毫秒）
   * @param {number} [options.minExecutionsForEvaluation=20] - 评估所需最小执行次数
   * @param {number} [options.lowSuccessThreshold=0.5] - 低成功率阈值
   * @param {number} [options.obsolescenceDays=90] - 过时天数阈值
   * @param {string} [options.retirementArchiveDir='archive/retired-skills'] - 归档目录
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._projectRoot = (options && options.projectRoot) || null;
    this._skillRouter = (options && options.skillRouter) ?? null;
    this._retiredSkills = new BoundedMap(500);
    this._retirementHistory = new BoundedArray(1000);
    this._stats = { evaluated: 0, retired: 0, reactivated: 0, candidatesDetected: 0 };
  }

  /**
   * 挂载项目根路径
   * @param {string} projectRoot - 项目根路径
   * @returns {SkillRetirementManager} 当前实例，支持链式调用
   */
  attachProjectRoot(projectRoot) {
    this._projectRoot = projectRoot;
    return this;
  }

  /**
   * 挂载SkillRouter实例，用于查找技能文件和重新发现
   * @param {Object} router - SkillRouter实例
   * @returns {SkillRetirementManager} 当前实例，支持链式调用
   */
  attachSkillRouter(router) {
    this._skillRouter = router;
    return this;
  }

  /**
   * 评估技能是否应被退役
   * @param {string} skillId - 技能ID
   * @param {Object} metrics - 技能指标
   * @param {number} [metrics.success_rate=0] - 成功率 (0-1)
   * @param {number} [metrics.execution_count=0] - 执行次数
   * @param {number} [metrics.last_used=0] - 最后使用时间戳
   * @param {number[]} [metrics.quality_scores=[]] - 质量评分列表
   * @returns {{ shouldRetire: boolean, reasons: string[], score: number }} 评估结果
   */
  evaluateSkill(skillId, metrics) {
    this.guardShutdown();
    this._stats.evaluated++;

    const m = metrics ?? {};
    const reasons = [];
    let score = 0;

    if (this._checkLowSuccessRate(m)) {
      reasons.push(RETIREMENT_REASONS.LOW_SUCCESS_RATE);
      score += 0.4;
    }

    if (this._checkObsolescence(m)) {
      reasons.push(RETIREMENT_REASONS.OBSOLESCENCE);
      score += 0.3;
    }

    const shouldRetire = reasons.length > 0 && m.execution_count >= this._config.minExecutionsForEvaluation;

    if (shouldRetire) {
      this._stats.candidatesDetected++;
      this.emit('retirement-candidate-detected', { skillId: skillId, reasons: reasons, score: score });
    }

    return { shouldRetire: shouldRetire, reasons: reasons, score: score };
  }

  /**
   * 退役技能：归档技能文件、标记为已退役、发出事件
   * @param {string} skillId - 技能ID
   * @param {string} [reason='manual'] - 退役原因
   * @returns {Promise<{success: boolean, skillId?: string, archivePath?: string, error?: string}>} 退役结果
   */
  async retireSkill(skillId, reason) {
    this.guardShutdown();
    if (!skillId) return { success: false, error: 'skillId is required' };
    if (!this._projectRoot) return { success: false, error: 'projectRoot not set' };

    const retireReason = reason || RETIREMENT_REASONS.MANUAL;

    if (this._retiredSkills.has(skillId)) {
      return { success: false, error: 'Skill already retired: ' + skillId };
    }

    const archiveResult = await safeExecuteAsync(
      function() { return this._archiveSkillFile(skillId); }.bind(this),
      'SkillRetirementManager', '_archiveSkillFile', null,
    );

    if (!archiveResult) {
      return { success: false, error: 'Failed to archive skill file for: ' + skillId };
    }

    this._retiredSkills.set(skillId, {
      reason: retireReason,
      retiredAt: Date.now(),
      archivePath: archiveResult.archivePath,
    });

    this._retirementHistory.push({
      skillId: skillId,
      reason: retireReason,
      timestamp: Date.now(),
      action: 'retired',
    });

    this._stats.retired++;

    if (this._skillRouter && typeof this._skillRouter.discoverAsync === 'function') {
      await safeExecuteAsync(
        function() { return this._skillRouter.discoverAsync(); }.bind(this),
        'SkillRetirementManager', 'discoverAsync',
      );
    }

    this.emit('skill-retired', { skillId: skillId, reason: retireReason, archivePath: archiveResult.archivePath });

    return { success: true, skillId: skillId, archivePath: archiveResult.archivePath };
  }

  /**
   * 从归档中重新激活已退役技能
   * @param {string} skillId - 技能ID
   * @returns {Promise<{success: boolean, skillId?: string, error?: string}>} 重新激活结果
   */
  async reactivateSkill(skillId) {
    this.guardShutdown();
    if (!skillId) return { success: false, error: 'skillId is required' };
    if (!this._projectRoot) return { success: false, error: 'projectRoot not set' };

    const retiredInfo = this._retiredSkills.get(skillId);
    if (!retiredInfo) {
      return { success: false, error: 'Skill not found in retired registry: ' + skillId };
    }

    const archivePath = retiredInfo.archivePath;
    if (!archivePath) {
      return { success: false, error: 'Archive path not found for: ' + skillId };
    }

    const skillsDir = path.join(this._projectRoot || process.cwd(), HARNESS_DIR, 'skills');
    const targetPath = path.join(skillsDir, skillId + '.md');

    if (!isPathWithinDir(targetPath, skillsDir)) {
      return { success: false, error: 'Invalid skill path: path traversal detected' };
    }

    const copyResult = await safeExecuteAsync(
      async function() {
        await fsp.access(archivePath);
        await fsp.mkdir(skillsDir, { recursive: true });
        const content = await fsp.readFile(archivePath, UTF8_ENCODING);
        await fsp.writeFile(targetPath, content, UTF8_ENCODING);
        await fsp.unlink(archivePath);
        return true;
      },
      'SkillRetirementManager', 'reactivate-copy', null,
    );

    if (!copyResult) {
      return { success: false, error: 'Failed to restore skill file from archive' };
    }

    this._retiredSkills.delete(skillId);

    this._retirementHistory.push({
      skillId: skillId,
      reason: 'reactivation',
      timestamp: Date.now(),
      action: 'reactivated',
    });

    this._stats.reactivated++;

    if (this._skillRouter && typeof this._skillRouter.discoverAsync === 'function') {
      await safeExecuteAsync(
        function() { return this._skillRouter.discoverAsync(); }.bind(this),
        'SkillRetirementManager', 'discoverAsync',
      );
    }

    this.emit('skill-reactivated', { skillId: skillId });

    return { success: true, skillId: skillId };
  }

  /**
   * 获取退役候选技能列表
   * @returns {Array<{skillId: string, reasons: string[], score: number}>} 候选列表
   */
  getRetirementCandidates() {
    this.guardShutdown();
    const candidates = [];

    if (this._skillRouter && this._skillRouter.registry) {
      const registry = this._skillRouter.registry;
      for (const skillId of Object.keys(registry)) {
        if (this._retiredSkills.has(skillId)) continue;
        const skill = registry[skillId];
        if (!skill) continue;

        const metrics = {
          success_rate: skill.successRate ?? 0,
          execution_count: skill.executionCount ?? 0,
          last_used: skill.lastUsed ?? 0,
          quality_scores: skill.qualityScores ?? [],
        };

        const evaluation = this.evaluateSkill(skillId, metrics);
        if (evaluation.shouldRetire) {
          candidates.push({ skillId: skillId, reasons: evaluation.reasons, score: evaluation.score });
        }
      }
    }

    return candidates;
  }

  /**
   * 获取已退役技能列表
   * @returns {Array<{skillId: string, reason: string, retiredAt: number, archivePath: string}>} 已退役技能列表
   */
  getRetiredSkills() {
    this.guardShutdown();
    const result = [];
    this._retiredSkills.forEach(function(info, skillId) {
      result.push({
        skillId: skillId,
        reason: info.reason,
        retiredAt: info.retiredAt,
        archivePath: info.archivePath,
      });
    });
    return result;
  }

  /**
   * 获取退役管理器统计信息
   * @returns {{ evaluated: number, retired: number, reactivated: number, candidatesDetected: number, currentlyRetired: number }} 统计数据
   */
  getStats() {
    return {
      evaluated: this._stats.evaluated,
      retired: this._stats.retired,
      reactivated: this._stats.reactivated,
      candidatesDetected: this._stats.candidatesDetected,
      currentlyRetired: this._retiredSkills.size,
    };
  }

  async _archiveSkillFile(skillId) {
    if (!this._skillRouter || !this._skillRouter.registry) {
      return null;
    }

    const skill = this._skillRouter.registry[skillId];
    if (!skill || !skill._filePath) return null;

    const skillPath = skill._filePath;
    const archiveDir = path.join(this._projectRoot || process.cwd(), this._config.retirementArchiveDir);
    const archivePath = path.join(archiveDir, skillId + '.md');

    if (!isPathWithinDir(archivePath, archiveDir)) return null;

    await fsp.mkdir(archiveDir, { recursive: true });

    const content = await fsp.readFile(skillPath, UTF8_ENCODING);
    await fsp.writeFile(archivePath, content, UTF8_ENCODING);
    await fsp.unlink(skillPath);

    return { archivePath: archivePath };
  }

  _checkLowSuccessRate(metrics) {
    const successRate = typeof metrics.success_rate === 'number' && Number.isFinite(metrics.success_rate)
      ? metrics.success_rate
      : 0;
    return successRate < this._config.lowSuccessThreshold && metrics.execution_count >= this._config.minExecutionsForEvaluation;
  }

  _checkObsolescence(metrics) {
    const lastUsed = typeof metrics.last_used === 'number' && Number.isFinite(metrics.last_used)
      ? metrics.last_used
      : 0;
    if (lastUsed === 0) return false;
    const daysSinceLastUse = (Date.now() - lastUsed) / 86400000;
    return daysSinceLastUse > this._config.obsolescenceDays;
  }

  _onShutdown() {
    this._retiredSkills.shutdown();
    this._retirementHistory.shutdown();
    this._stats = { evaluated: 0, retired: 0, reactivated: 0, candidatesDetected: 0 };
    this._skillRouter = null;
    this.removeAllListeners();
  }
}

SkillRetirementManager.RETIREMENT_REASONS = RETIREMENT_REASONS;
SkillRetirementManager.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(SkillRetirementManager);
