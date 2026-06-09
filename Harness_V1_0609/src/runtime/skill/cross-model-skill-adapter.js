'use strict';

/**
 * @module runtime/skill/cross-model-skill-adapter
 * 跨模型技能适配器，融合自SkillOS自进化Agent框架的跨模型迁移概念。
 *
 * SkillOS核心洞察：只用Qwen3-8B训练Curator，可无缝对接32B/Gemini执行器，
 * 泛化稳定。技能定义应模型无关可移植。
 *
 * 本模块填补Harness的关键差距：技能定义在不同LLM间的自动转换。
 * Harness的技能是Markdown格式（天然模型无关），但不同LLM对指令的
 * 遵循风格有差异（如GPT偏好JSON格式指令，Claude偏好自然语言，
 * Gemini偏好结构化步骤，Qwen偏好中文+代码示例）。
 *
 * 适配策略：不改变技能核心逻辑，只调整指令表达风格。
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

/**
 * 模型家族枚举
 */
const MODEL_FAMILY = {
  GPT: 'gpt',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
  QWEN: 'qwen',
  DEEPSEEK: 'deepseek',
  GENERIC: 'generic',
};

/**
 * 指令风格特征
 */
const INSTRUCTION_STYLE = {
  GPT: {
    preferJsonFormat: true,
    preferStructuredOutput: true,
    systemPromptStyle: 'directive',
    stepFormat: 'numbered-list',
    exampleFormat: 'code-block',
    constraintFormat: 'json-schema',
  },
  CLAUDE: {
    preferJsonFormat: false,
    preferStructuredOutput: true,
    systemPromptStyle: 'conversational',
    stepFormat: 'markdown-sections',
    exampleFormat: 'xml-tags',
    constraintFormat: 'natural-language',
  },
  GEMINI: {
    preferJsonFormat: true,
    preferStructuredOutput: true,
    systemPromptStyle: 'structured',
    stepFormat: 'hierarchical',
    exampleFormat: 'code-block',
    constraintFormat: 'yaml-schema',
  },
  QWEN: {
    preferJsonFormat: true,
    preferStructuredOutput: true,
    systemPromptStyle: 'directive-bilingual',
    stepFormat: 'numbered-list',
    exampleFormat: 'code-block',
    constraintFormat: 'json-schema',
  },
  DEEPSEEK: {
    preferJsonFormat: true,
    preferStructuredOutput: true,
    systemPromptStyle: 'directive',
    stepFormat: 'numbered-list',
    exampleFormat: 'code-block',
    constraintFormat: 'json-schema',
  },
  GENERIC: {
    preferJsonFormat: false,
    preferStructuredOutput: false,
    systemPromptStyle: 'neutral',
    stepFormat: 'numbered-list',
    exampleFormat: 'code-block',
    constraintFormat: 'natural-language',
  },
};

const DEFAULT_OPTIONS = {
  defaultFamily: MODEL_FAMILY.GENERIC,
  cacheAdaptations: true,
  maxCacheSize: 200,
};

/**
 * 跨模型技能适配器，融合自SkillOS的"跨模型迁移"概念。
 *
 * 核心原则（融合自SkillOS实战洞察）：
 * - 技能定义应模型无关可移植
 * - 只用小模型训练Curator，可无缝对接大模型执行器
 * - 不改变技能核心逻辑，只调整指令表达风格
 * - 适配是幂等的：同一技能多次适配结果一致
 *
 * @classdesc 跨模型技能适配器。模型间指令风格自动转换，技能可移植。
 * @extends EventEmitter
 */
class CrossModelSkillAdapter extends EventEmitter {

  /**
   * 创建CrossModelSkillAdapter实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.defaultFamily='generic'] - 默认模型家族
   * @param {boolean} [options.cacheAdaptations=true] - 是否缓存适配结果
   * @param {number} [options.maxCacheSize=200] - 最大缓存数
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._cache = new Map();
    this._customStyles = new Map();
    this._stats = { adaptations: 0, cacheHits: 0, cacheMisses: 0 };
  }

  /**
   * 适配技能指令到目标模型风格，融合自SkillOS的"跨模型迁移"概念。
   * 不改变技能核心逻辑，只调整指令表达风格。
   * @param {Object} skillDef - 技能定义对象
   * @param {string} targetFamily - 目标模型家族
   * @returns {Object} 适配后的技能定义
   */
  adaptSkill(skillDef, targetFamily) {
    this.guardShutdown();
    if (!skillDef || !skillDef.skill_id) return skillDef;

    const family = this._normalizeFamily(targetFamily);
    const cacheKey = skillDef.skill_id + ':' + family;

    // 缓存检查
    if (this._options.cacheAdaptations && this._cache.has(cacheKey)) {
      this._stats.cacheHits++;
      return this._cache.get(cacheKey);
    }
    this._stats.cacheMisses++;

    // 获取目标风格
    const targetStyle = this._getStyle(family);
    const adapted = this._doAdapt(skillDef, targetStyle, family);

    // 缓存结果
    if (this._options.cacheAdaptations) {
      if (this._cache.size >= this._options.maxCacheSize) {
        const firstKey = this._cache.keys().next().value;
        if (firstKey !== undefined) this._cache.delete(firstKey);
      }
      this._cache.set(cacheKey, adapted);
    }

    this._stats.adaptations++;
    this.emit('skill-adapted', { skillId: skillDef.skill_id, targetFamily: family });

    return adapted;
  }

  /**
   * 注册自定义模型风格。
   * @param {string} family - 模型家族标识
   * @param {Object} style - 风格定义
   * @returns {{ family: string, registered: boolean }} 注册结果
   */
  registerStyle(family, style) {
    this.guardShutdown();
    if (!family || !style) return { family: null, registered: false };
    this._customStyles.set(family, style);
    return { family, registered: true };
  }

  /**
   * 根据模型ID推断模型家族。
   * @param {string} modelId - 模型ID
   * @returns {string} 模型家族
   */
  inferFamily(modelId) {
    if (!modelId || typeof modelId !== 'string') return this._options.defaultFamily;
    const lower = modelId.toLowerCase();
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return MODEL_FAMILY.GPT;
    if (lower.includes('claude') || lower.includes('anthropic')) return MODEL_FAMILY.CLAUDE;
    if (lower.includes('gemini') || lower.includes('gemma')) return MODEL_FAMILY.GEMINI;
    if (lower.includes('qwen') || lower.includes('qwq')) return MODEL_FAMILY.QWEN;
    if (lower.includes('deepseek')) return MODEL_FAMILY.DEEPSEEK;
    return this._options.defaultFamily;
  }

  /**
   * 获取所有支持的模型家族。
   * @returns {string[]} 模型家族列表
   */
  getSupportedFamilies() {
    const families = Object.values(MODEL_FAMILY);
    for (const custom of this._customStyles.keys()) {
      if (!families.includes(custom)) families.push(custom);
    }
    return families;
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      adaptations: this._stats.adaptations,
      cacheHits: this._stats.cacheHits,
      cacheMisses: this._stats.cacheMisses,
      cacheSize: this._cache.size,
      customStyles: this._customStyles.size,
    };
  }

  /**
   * 执行适配逻辑。
   * @param {Object} skillDef - 原始技能定义
   * @param {Object} targetStyle - 目标风格
   * @param {string} family - 目标家族
   * @returns {Object} 适配后的技能定义
   * @private
   */
  _doAdapt(skillDef, targetStyle, family) {
    const adapted = Object.assign({}, skillDef);

    // 适配指令格式
    if (adapted.instruction) {
      adapted.instruction = this._adaptInstruction(adapted.instruction, targetStyle);
    }

    // 适配步骤格式
    if (adapted.steps && Array.isArray(adapted.steps)) {
      adapted.steps = this._adaptSteps(adapted.steps, targetStyle);
    }

    // 适配约束格式
    if (adapted.constraints && Array.isArray(adapted.constraints)) {
      adapted.constraints = this._adaptConstraints(adapted.constraints, targetStyle);
    }

    // 添加模型适配标记
    adapted._adaptedFor = family;
    adapted._adaptedAt = Date.now();

    return adapted;
  }

  /**
   * 适配指令文本。
   * @param {string} instruction - 原始指令
   * @param {Object} style - 目标风格
   * @returns {string} 适配后的指令
   * @private
   */
  _adaptInstruction(instruction, style) {
    if (!instruction || typeof instruction !== 'string') return instruction;

    let result = instruction;

    // Claude风格：添加XML标签包裹关键信息
    if (style.systemPromptStyle === 'conversational') {
      // 将纯列表转换为markdown段落
      result = result.replace(/^(\d+)\.\s/gm, '### Step $1\n');
    }

    // Gemini风格：层级化步骤
    if (style.stepFormat === 'hierarchical') {
      result = result.replace(/^###\s/gm, '## ');
    }

    // Qwen风格：双语支持标记
    if (style.systemPromptStyle === 'directive-bilingual') {
      // 不自动翻译，只标记需要双语的部分
    }

    return result;
  }

  /**
   * 适配步骤格式。
   * @param {Array} steps - 原始步骤
   * @param {Object} style - 目标风格
   * @returns {Array} 适配后的步骤
   * @private
   */
  _adaptSteps(steps, style) {
    return steps.map(function(step) {
      if (typeof step === 'string') return step;
      const adapted = Object.assign({}, step);
      if (style.exampleFormat === 'xml-tags' && adapted.example && typeof adapted.example === 'string') {
        adapted.example = '<example>\n' + adapted.example + '\n</example>';
      }
      return adapted;
    });
  }

  /**
   * 适配约束格式。
   * @param {Array} constraints - 原始约束
   * @param {Object} style - 目标风格
   * @returns {Array} 适配后的约束
   * @private
   */
  _adaptConstraints(constraints, style) {
    if (style.constraintFormat === 'json-schema' && constraints.length > 0) {
      return constraints.map(function(c) {
        if (typeof c === 'string') return { rule: c, type: 'constraint' };
        return c;
      });
    }
    if (style.constraintFormat === 'natural-language') {
      return constraints.map(function(c) {
        if (c && typeof c === 'object' && c.rule) return c.rule;
        return c;
      });
    }
    return constraints;
  }

  /**
   * 获取指定家族的指令风格。
   * @param {string} family - 模型家族
   * @returns {Object} 指令风格
   * @private
   */
  _getStyle(family) {
    if (this._customStyles.has(family)) return this._customStyles.get(family);
    const styleKey = family.toUpperCase();
    return INSTRUCTION_STYLE[styleKey] || INSTRUCTION_STYLE.GENERIC;
  }

  /**
   * 规范化模型家族名称。
   * @param {string} family - 原始家族名称
   * @returns {string} 规范化后的家族名称
   * @private
   */
  _normalizeFamily(family) {
    if (!family) return this._options.defaultFamily;
    const lower = family.toLowerCase();
    if (Object.values(MODEL_FAMILY).includes(lower)) return lower;
    if (this._customStyles.has(lower)) return lower;
    return this._options.defaultFamily;
  }

  _onShutdown() {
    this._cache.clear();
    this._customStyles.clear();
    this.removeAllListeners();
  }
}

CrossModelSkillAdapter.MODEL_FAMILY = MODEL_FAMILY;
CrossModelSkillAdapter.INSTRUCTION_STYLE = INSTRUCTION_STYLE;

module.exports = withShutdown(CrossModelSkillAdapter);
