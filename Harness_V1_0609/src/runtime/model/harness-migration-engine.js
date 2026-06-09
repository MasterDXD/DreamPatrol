'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @classdesc Harness迁移引擎，处理框架版本升级时的数据结构迁移和兼容性适配
 * @description Harness迁移性引擎——融合自Anthropic Harness设计理念中的"动态承重调整"。
 * 根据模型能力动态调整Harness组件的"承重"与"可删"，实现Harness随模型迭代而迁移。
 *
 * 核心机制：
 * - 定义模型能力等级（capability_tier）与Harness组件的依赖关系
 * - 当模型能力升级时，自动卸载不必要的组件（如Opus 4.6后Sprint结构可简化）
 * - 当模型能力降级时，自动增加防护组件（如小模型需要更多验证门禁）
 * - 提供迁移建议报告，供Team Lead决策
 *
 * 组件承重等级：
 * - critical: 任何模型都必须保留的核心组件
 * - recommended: 推荐但非必需，强模型可考虑卸载
 * - optional: 可选组件，中等以上模型可卸载
 * - deprecated: 仅弱模型需要，强模型应卸载
 */
class HarnessMigrationEngine {
  /**
   * @param {object} [options]
   * @param {object} [options.componentRegistry] - 组件注册表
   */
  constructor(options) {
    const opts = options ?? {};
    this._componentRegistry = opts.componentRegistry ?? this._getDefaultRegistry();
    this._currentTier = 'standard';
    this._migrationHistory = [];
    this._maxMigrationHistory = 100;
    this._activeComponents = new Set();
    this._inactiveComponents = new Set();
    this._calibrationData = null;

    // 初始化：根据默认tier激活组件
    this._applyTier(this._currentTier);
  }

  /**
   * 注入评估校准数据。
   * @param {object} report - EvaluationCalibrator的校准报告
   * @returns {HarnessMigrationEngine} 当前实例，支持链式调用
   */
  attachCalibrationData(report) { this._calibrationData = report; return this; }

  /**
   * 根据模型能力更新当前tier。
   * @param {string} tier - 'weak' | 'standard' | 'strong' | 'frontier'
   * @returns {{ success: boolean, migration?: Object }} 迁移结果
   */
  updateTier(tier) {
    this.guardShutdown();
    const validTiers = ['weak', 'standard', 'strong', 'frontier'];
    if (!validTiers.includes(tier)) {
      return { success: false, error: 'Invalid tier: ' + tier };
    }

    const previousTier = this._currentTier;
    const previouslyActive = new Set(this._activeComponents);

    this._currentTier = tier;
    this._applyTier(tier);

    // 如果有校准数据，根据偏差微调
    if (this._calibrationData && this._calibrationData.bias === 'overestimate') {
      this._addSafetyComponents();
    }

    const activated = [...this._activeComponents].filter(function(c) { return !previouslyActive.has(c); });
    const deactivated = [...previouslyActive].filter(function(c) { return !this._activeComponents.has(c); }.bind(this));

    const migration = {
      from: previousTier,
      to: tier,
      activated,
      deactivated,
      timestamp: Date.now(),
    };
    this._migrationHistory.push(migration);
    if (this._migrationHistory.length > this._maxMigrationHistory) {
      this._migrationHistory.shift();
    }

    return { success: true, migration };
  }

  /**
   * 获取当前活跃组件列表。
   * @returns {string[]}
   */
  getActiveComponents() {
    return [...this._activeComponents];
  }

  /**
   * 获取迁移建议报告。
   * @returns {{ currentTier: string, activeComponents: string[], migrationCount: number, recentMigrations: Object[] }} 迁移报告
   */
  getMigrationReport() {
    this.guardShutdown();
    const allComponents = Object.keys(this._componentRegistry);
    const active = [...this._activeComponents];
    const inactive = [...this._inactiveComponents];

    return {
      currentTier: this._currentTier,
      totalComponents: allComponents.length,
      activeCount: active.length,
      inactiveCount: inactive.length,
      active,
      inactive,
      migrationCount: this._migrationHistory.length,
      lastMigration: this._migrationHistory[this._migrationHistory.length - 1] ?? null,
      calibrationBias: this._calibrationData?.bias ?? 'unknown',
    };
  }

  /** 应用指定tier，激活对应组件集合并停用不在新tier中的组件。@param {string} tier - 目标tier @private */
  _applyTier(tier) {
    this._activeComponents.clear();
    this._inactiveComponents.clear();

    for (const [component, config] of Object.entries(this._componentRegistry)) {
      const requiredTier = config.requiredTier ?? 'weak';
      const tierOrder = { weak: 0, standard: 1, strong: 2, frontier: 3 };
      const currentLevel = tierOrder[tier] ?? 1;
      const requiredLevel = tierOrder[requiredTier] ?? 0;

      if (currentLevel >= requiredLevel) {
        this._activeComponents.add(component);
      } else {
        this._inactiveComponents.add(component);
      }
    }
  }

  /** 向当前活跃组件集合添加安全相关组件。@private */
  _addSafetyComponents() {
    // 高估偏差时，将recommended级别组件也激活
    for (const [component, config] of Object.entries(this._componentRegistry)) {
      if (config.weight === 'recommended' && !this._activeComponents.has(component)) {
        this._activeComponents.add(component);
        this._inactiveComponents.delete(component);
      }
    }
  }

  /** 获取默认组件注册表，定义各tier对应的组件集合。@returns {Object} 默认组件注册表 @private */
  _getDefaultRegistry() {
    return {
      // 核心组件 — 任何模型都必须保留
      'tdd-gate': { weight: 'critical', requiredTier: 'weak', description: 'TDD强制门禁' },
      'evidence-verifier': { weight: 'critical', requiredTier: 'weak', description: '证据验证器' },
      'iron-rule-engine': { weight: 'critical', requiredTier: 'weak', description: '铁律引擎' },
      'error-prevention-guard': { weight: 'critical', requiredTier: 'weak', description: '错误预防守卫' },

      // 推荐组件 — 强模型可考虑卸载
      'adversarial-review': { weight: 'recommended', requiredTier: 'weak', description: '对抗审查' },
      'pair-chat': { weight: 'recommended', requiredTier: 'weak', description: '交叉验证' },
      'quality-scorer': { weight: 'recommended', requiredTier: 'weak', description: '质量评分器' },
      'evaluation-calibrator': { weight: 'recommended', requiredTier: 'standard', description: '评估校准器' },
      'context-drift-monitor': { weight: 'recommended', requiredTier: 'weak', description: '上下文漂移监控' },
      'comprehension-debt-tracker': { weight: 'recommended', requiredTier: 'weak', description: '理解债务追踪' },

      // 可选组件 — 中等以上模型可卸载
      'sprint-cycle': { weight: 'optional', requiredTier: 'weak', description: '冲刺周期' },
      'self-evolution-governor': { weight: 'optional', requiredTier: 'standard', description: '自演化治理器' },
      'output-conciseness-guard': { weight: 'optional', requiredTier: 'weak', description: '输出精简度守卫' },
      'delivery-efficiency-meter': { weight: 'optional', requiredTier: 'standard', description: '交付效率度量' },

      // 弱模型专用 — 强模型应卸载
      'layer-boundary-guard': { weight: 'deprecated', requiredTier: 'weak', description: '层级边界守卫（强模型可自主遵守）' },
      'architecture-boundary-enforcer': { weight: 'deprecated', requiredTier: 'weak', description: '架构边界执行器（强模型可自主遵守）' },
      'code-drift-detector': { weight: 'deprecated', requiredTier: 'weak', description: '代码漂移检测器（强模型可自主控制）' },
    };
  }

  /** 关闭清理回调。重置所有内部状态。@returns {void} @private */
  _onShutdown() {
    this._activeComponents.clear();
    this._inactiveComponents.clear();
    this._migrationHistory = [];
  }
}

module.exports = withShutdown(HarnessMigrationEngine);
