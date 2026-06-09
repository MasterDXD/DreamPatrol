'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const DEFAULT_OPTIONS = {
  maxToolDefs: 100,
  maxResolutionHistory: 500,
  coreSkillIds: [],
  l1DescriptionMaxLength: 200,
};

class SkillToolAdapter {
  /**
   * 创建 SkillToolAdapter 实例。
   * @param {Object} [skillRouter] - SkillRouter实例
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxToolDefs=100] - 最大工具定义数
   * @param {number} [options.maxResolutionHistory=500] - 最大解析历史条数
   * @param {string[]} [options.coreSkillIds=[]] - 核心技能ID列表
   * @param {number} [options.l1DescriptionMaxLength=200] - L1描述最大长度
   */
  constructor(skillRouter, options) {
    this._skillRouter = skillRouter ?? null;
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._toolDefs = new BoundedMap(this._options.maxToolDefs);
    this._resolutionHistory = new BoundedArray(this._options.maxResolutionHistory);
    this._stats = { toolDefsGenerated: 0, onDemandLoads: 0, l2Loads: 0, l3Loads: 0 };
  }

  attachSkillRouter(skillRouter) {
    this._skillRouter = skillRouter;
  }

  generateToolDefinitions(skillIds) {
    if (!this._skillRouter || !Array.isArray(skillIds)) return [];
    const defs = [];
    for (const skillId of skillIds) {
      if (this._options.coreSkillIds.includes(skillId)) continue;
      const skill = this._skillRouter.getSkill ? this._skillRouter.getSkill(skillId) : null;
      if (!skill) continue;
      const toolDef = {
        name: 'load_skill_' + skillId.replace(/[^a-zA-Z0-9_]/g, '_'),
        description: (skill.summary ?? skill.name ?? skillId).substring(0, this._options.l1DescriptionMaxLength),
        parameters: {
          type: 'object',
          properties: {
            skill_id: { type: 'string', description: 'Skill identifier', default: skillId },
            load_level: { type: 'string', enum: ['l2', 'l3'], description: 'Load level: l2=instructions, l3=full resources' },
          },
          required: [],
        },
        _skillId: skillId,
        _isSkillTool: true,
      };
      this._toolDefs.set(skillId, toolDef);
      defs.push(toolDef);
      this._stats.toolDefsGenerated++;
    }
    return defs;
  }

  resolveOnDemand(skillId, loadLevel) {
    if (!this._skillRouter) return null;
    const level = loadLevel ?? 'l2';
    this._stats.onDemandLoads++;
    const record = { skillId, loadLevel: level, timestamp: Date.now() };
    let result;
    if (level === 'l3') {
      result = this._skillRouter.loadL3 ? this._skillRouter.loadL3(skillId) : null;
      this._stats.l3Loads++;
    } else {
      result = this._skillRouter.loadL2 ? this._skillRouter.loadL2(skillId) : null;
      this._stats.l2Loads++;
    }
    record.success = result != null;
    this._resolutionHistory.push(record);
    return result;
  }

  isSkillToolCall(toolName) {
    return toolName && toolName.startsWith('load_skill_');
  }

  extractSkillIdFromToolName(toolName) {
    if (!this.isSkillToolCall(toolName)) return null;
    const mapped = toolName.replace('load_skill_', '');
    for (const [skillId, _def] of this._toolDefs) {
      const normalized = skillId.replace(/[^a-zA-Z0-9_]/g, '_');
      if (normalized === mapped) return skillId;
    }
    return null;
  }

  getToolDefinitions() {
    const defs = [];
    for (const [, def] of this._toolDefs) {
      defs.push({ ...def });
    }
    return defs;
  }

  getCoreSkillIds() {
    return this._options.coreSkillIds.slice();
  }

  getStats() {
    return {
      toolDefsGenerated: this._stats.toolDefsGenerated,
      onDemandLoads: this._stats.onDemandLoads,
      l2Loads: this._stats.l2Loads,
      l3Loads: this._stats.l3Loads,
      activeToolDefs: this._toolDefs.size,
    };
  }

  _onShutdown() {
    this._toolDefs.shutdown();
    this._resolutionHistory.shutdown();
  }
}

module.exports = withShutdown(SkillToolAdapter);
