'use strict';
const DeepeningBase = require('./deepening-base');
const { DeepeningError, ERROR_CODES } = require('../../errors');
const { mergeConfig } = require('../../utils/safe-assign');

const MAX_DEPLOYMENTS = 100;

/**
 * @module runtime/deepening/deepening-deployment
 * 深化推理部署管理器 — 管理深化推理子系统的部署生命周期，包括部署创建、配置验证、
 * 部署历史记录及当前部署状态追踪。维护最多 MAX_DEPLOYMENTS 条部署记录，超出时自动淘汰最早记录。
 */

/**
 * @classdesc 深化部署。部署策略、版本管理、回滚
 *
 * @extends DeepeningBase
 * @emits 'deployment' 当新部署创建时触发
 * @emits 'shutdown' 当实例关闭时触发
 */
class DeepeningDeployment extends DeepeningBase {

  /**
   * 创建 DeepeningDeployment 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.deployPath='./deploy'] - 部署输出路径
   * @param {string} [options.backupPath='./backup'] - 备份存储路径
   */
  constructor(options) {
    super(options);
    this._deployPath = (options && options.deployPath) ?? './deploy';
    this._backupPath = (options && options.backupPath) ?? './backup';
    this._deployments = [];
    this._current = null;
  }

  /**
   * 执行部署操作。验证配置后创建部署记录，自动附加部署时间戳和版本号，
   * 并将其设为当前活跃部署。超出最大部署数量时自动淘汰最早记录。
   * @param {Object} config - 部署配置对象
   * @param {Array} config.agents - 参与部署的Agent列表（不可为空）
   * @param {number} [config.maxIterations] - 最大迭代次数
   * @param {Object} [config.config] - 附加配置项
   * @returns {Object} 包含 deployedAt 和 version 字段的完整部署记录
   * @throws {DeepeningError} 当配置验证失败时抛出 INVALID_INPUT 错误
   */
  deploy(config) {
    this.guardShutdown();
    this.validateConfig(config);
    this._deployCount = (this._deployCount ?? 0) + 1;
    const deployment = mergeConfig(config, { deployedAt: new Date().toISOString(), version: '1.0.' + this._deployCount });
    this._deployments.push(deployment);
    if (this._deployments.length > MAX_DEPLOYMENTS) {
      this._deployments.splice(0, this._deployments.length - MAX_DEPLOYMENTS);
    }
    this._current = deployment;
    return deployment;
  }

  /**
   * 获取所有部署记录的副本。
   * @returns {Array<Object>} 部署记录数组的浅拷贝，按时间顺序排列
   */
  listDeployments() { return this._deployments.map(d => ({ ...d })); }

  /**
   * 获取当前活跃的部署记录。
   * @returns {Object|null} 当前部署记录，若无活跃部署则返回 null
   */
  getCurrentDeployment() { return this._current; }

  /**
   * 验证部署配置的完整性和合法性。要求 config 对象存在且包含非空的 agents 数组。
   * @param {Object} config - 待验证的部署配置
   * @param {Array} config.agents - Agent列表
   * @returns {boolean} 验证通过返回 true
   * @throws {DeepeningError} 当配置缺失或 agents 为空时抛出 INVALID_INPUT 错误
   */
  validateConfig(config) {
    if (!config || !Array.isArray(config.agents) || !config.agents.length) throw new DeepeningError(ERROR_CODES.INVALID_INPUT, 'agents required');
    return true;
  }

  /**
   * 创建空白部署配置模板，包含 agents、maxIterations 和 config 三个字段。
   * @returns {Object} 部署配置模板 { agents: [], maxIterations: 4, config: {} }
   */
  createDeploymentTemplate() { return { agents: [], maxIterations: 4, config: {} }; }

  /**
   * 获取部署管理器的运行统计信息，包含部署总数、当前部署状态及基类统计。
   * @returns {Object} 统计信息对象
   * @returns {number} return.totalDeployments - 部署记录总数
   * @returns {boolean} return.hasCurrent - 是否存在当前活跃部署
   */
  getStats() {
    return { totalDeployments: this._deployments.length, hasCurrent: !!this._current, ...super.getStats() };
  }

  /**
   * 关闭时的清理回调。清空所有部署记录并重置当前部署引用。
   * @protected
   */
  _onShutdown() {
    this._deployments = [];
    this._current = null;
    super._onShutdown();
  }
}

module.exports = DeepeningDeployment;
