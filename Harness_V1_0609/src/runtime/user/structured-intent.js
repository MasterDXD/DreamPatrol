'use strict';

const { EventEmitter } = require('events');
const safeAssign = require('../../utils/safe-assign');
const { DANGEROUS_KEYS } = require('../../utils/constants');
const RingBuffer = require('../../utils/ring-buffer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const INTENT_SCHEMAS = {
  'tdd-implement': {
    requiredParams: [
      { name: 'target_module', type: 'string', description: '目标模块名称' },
      { name: 'success_criteria', type: 'string', description: '成功标准（如覆盖率阈值）' },
    ],
    optionalParams: [
      { name: 'constraints', type: 'string[]', description: '边界约束' },
      { name: 'test_framework', type: 'string', description: '测试框架' },
    ],
  },
  'module-development': {
    requiredParams: [
      { name: 'module_name', type: 'string', description: '模块名称' },
      { name: 'requirements', type: 'string[]', description: '功能需求列表' },
    ],
    optionalParams: [
      { name: 'dependencies', type: 'string[]', description: '依赖模块' },
      { name: 'architecture_pattern', type: 'string', description: '架构模式' },
    ],
  },
  'code-review': {
    requiredParams: [
      { name: 'target_files', type: 'string[]', description: '审查目标文件' },
      { name: 'review_focus', type: 'string', description: '审查重点' },
    ],
    optionalParams: [
      { name: 'severity_threshold', type: 'string', description: '严重级别阈值' },
    ],
  },
  'architecture-design': {
    requiredParams: [
      { name: 'system_name', type: 'string', description: '系统名称' },
      { name: 'core_requirements', type: 'string[]', description: '核心需求' },
    ],
    optionalParams: [
      { name: 'constraints', type: 'string[]', description: '架构约束' },
      { name: 'existing_modules', type: 'string[]', description: '已有模块' },
    ],
  },
  'bug-fix': {
    requiredParams: [
      { name: 'bug_description', type: 'string', description: '缺陷描述' },
      { name: 'expected_behavior', type: 'string', description: '期望行为' },
    ],
    optionalParams: [
      { name: 'reproduction_steps', type: 'string[]', description: '复现步骤' },
      { name: 'affected_versions', type: 'string[]', description: '受影响版本' },
    ],
  },
  'security-audit': {
    requiredParams: [
      { name: 'audit_scope', type: 'string', description: '审计范围' },
    ],
    optionalParams: [
      { name: 'severity_focus', type: 'string[]', description: '关注的安全级别' },
      { name: 'compliance_standards', type: 'string[]', description: '合规标准' },
    ],
  },
  'deployment': {
    requiredParams: [
      { name: 'environment', type: 'string', description: '部署环境' },
      { name: 'version', type: 'string', description: '部署版本' },
    ],
    optionalParams: [
      { name: 'rollback_plan', type: 'string', description: '回滚方案' },
      { name: 'health_check_url', type: 'string', description: '健康检查URL' },
    ],
  },
  'integration-testing': {
    requiredParams: [
      { name: 'test_scope', type: 'string', description: '测试范围' },
    ],
    optionalParams: [
      { name: 'test_environments', type: 'string[]', description: '测试环境' },
      { name: 'critical_paths', type: 'string[]', description: '关键路径' },
    ],
  },
};

const MAX_PARAM_NAME_PARTS = 8;

/**
 * @module runtime/user/structured-intent
 * StructuredIntent — Natural language intent parser and task parameter mapper
 * Parses user messages into structured skill intents with parameter extraction, completeness
 * scoring, and clarification prompt generation. Supports session-scoped parameter accumulation.
 * @classdesc 结构化意图。自然语言意图解析、任务映射
 * @extends EventEmitter
 * @emits StructuredIntent#intent-parsed
 * @emits StructuredIntent#clarification-needed
 */
class StructuredIntent extends EventEmitter {
  constructor(options) {
    super();
    this._schemas = safeAssign({}, INTENT_SCHEMAS, (options && options.customSchemas) ?? {});
    this._maxHistory = typeof (options && options.maxHistory) === 'number' && Number.isFinite(options.maxHistory) ? options.maxHistory : 200;
    this._history = new RingBuffer(this._maxHistory);
    this._completenessThreshold = typeof (options && options.completenessThreshold) === 'number' && Number.isFinite(options.completenessThreshold) ? options.completenessThreshold : 0.6;
    this._sessionParams = new Map();
    this._maxSessions = typeof (options && options.maxSessions) === 'number' && Number.isFinite(options.maxSessions) ? options.maxSessions : 50;
    this._maxSchemas = typeof (options && options.maxSchemas) === 'number' && Number.isFinite(options.maxSchemas) ? options.maxSchemas : 100;
  }

  /**
   * 解析用户消息为结构化意图，提取参数并评估完整性，支持会话级参数累积
   * @param {string} userMessage - 用户消息文本
   * @param {string} skillId - 目标技能ID
   * @param {object} [options] - 解析选项
   * @param {string} [options.sessionId] - 会话ID，启用参数累积
   * @returns {object} 解析结果对象，包含skillId、params、completeness、missingParams、clarificationNeeded、clarificationPrompt、rawMessage、paramsAccumulated字段
   */
  parseIntent(userMessage, skillId, options) {
    this.guardShutdown();
    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
      return {
        skillId: skillId || 'unknown',
        params: {},
        completeness: 0,
        missingParams: [],
        clarificationNeeded: true,
        clarificationPrompt: '请提供更详细的任务描述',
      };
    }

    const sessionId = options && options.sessionId;
    const schema = this._schemas[skillId];
    const newParams = this._extractParams(userMessage, schema);

    let mergedParams = newParams;
    if (sessionId && schema) {
      const sessionKey = sessionId + ':' + skillId;
      const previousParams = this._sessionParams.get(sessionKey) ?? {};
      mergedParams = safeAssign({}, previousParams, newParams);
      this._sessionParams.set(sessionKey, mergedParams);
      if (this._sessionParams.size > this._maxSessions) {
        const firstKey = this._sessionParams.keys().next().value;
        this._sessionParams.delete(firstKey);
      }
    }

    if (!schema) {
      return {
        skillId: skillId || 'unknown',
        params: mergedParams,
        completeness: 1.0,
        missingParams: [],
        clarificationNeeded: false,
        clarificationPrompt: null,
        rawMessage: userMessage,
        paramsAccumulated: Object.keys(newParams).length < Object.keys(mergedParams).length,
      };
    }

    const missingParams = [];
    let providedCount = 0;
    const totalRequired = schema.requiredParams.length;

    for (const reqParam of schema.requiredParams) {
      if (mergedParams[reqParam.name] != null && mergedParams[reqParam.name] !== '') {
        providedCount++;
      } else {
        missingParams.push({
          name: reqParam.name,
          type: reqParam.type,
          description: reqParam.description,
        });
      }
    }

    const completeness = totalRequired > 0 ? providedCount / totalRequired : 1.0;
    const clarificationNeeded = completeness < this._completenessThreshold;

    const result = {
      skillId,
      params: mergedParams,
      completeness,
      missingParams,
      clarificationNeeded,
      clarificationPrompt: clarificationNeeded ? this._buildClarificationPrompt(skillId, missingParams) : null,
      rawMessage: userMessage,
      paramsAccumulated: Object.keys(newParams).length < Object.keys(mergedParams).length,
    };

    this._history.push({
      skillId,
      completeness,
      missingCount: missingParams.length,
      clarificationNeeded,
      timestamp: Date.now(),
    });

    this.emit('intent-parsed', result);
    return result;
  }

  /**
   * 获取指定技能的参数Schema定义
   * @param {string} skillId - 技能ID
   * @returns {object|null} Schema对象，包含requiredParams和optionalParams；未找到返回null
   */
  getSchema(skillId) {
    return this._schemas[skillId] ?? null;
  }

  _validateParamList(params) {
    if (!Array.isArray(params)) return false;
    if (params.length > 20) return false;
    for (const p of params) {
      if (!p || typeof p.name !== 'string' || DANGEROUS_KEYS.has(p.name)) return false;
      if (p.name.length > 64) return false;
    }
    return true;
  }

  /**
   * 注册新的技能参数Schema，不允许覆盖已有Schema
   * @param {string} skillId - 技能ID，长度不超过128
   * @param {object} schema - Schema对象，需包含requiredParams数组，可选optionalParams数组
   * @returns {boolean} 注册成功返回true，参数无效或已存在返回false
   */
  registerSchema(skillId, schema) {
    this.guardShutdown();
    if (!skillId || typeof skillId !== 'string' || skillId.length > 128) return false;
    if (skillId === '__proto__' || skillId === 'constructor' || skillId === 'prototype') return false;
    if (!schema || typeof schema !== 'object') return false;
    if (this._schemas[skillId]) return false;
    // 容量保护：超过上限时淘汰最早注册的Schema
    const schemaKeys = Object.keys(this._schemas);
    if (schemaKeys.length >= this._maxSchemas) {
      const oldestKey = schemaKeys[0];
      delete this._schemas[oldestKey];
    }
    if (!this._validateParamList(schema.requiredParams)) return false;
    if (schema.optionalParams && !this._validateParamList(schema.optionalParams)) return false;
    this._schemas[skillId] = schema;
    this.emit('schema-registered', { skillId });
    return true;
  }

  /**
   * 验证意图对象的完整性和类型正确性
   * @param {object} intent - 意图对象，需包含skillId和params
   * @returns {object} 验证结果，包含valid(boolean)、errors(Array)、warnings(Array)字段
   */
  validateIntent(intent) {
    if (!intent || !intent.skillId) {
      return { valid: false, errors: ['Missing skillId'] };
    }

    const schema = this._schemas[intent.skillId];
    if (!schema) {
      return { valid: true, errors: [], warnings: ['No schema defined for this skill'] };
    }

    const errors = [];
    const warnings = [];

    for (const reqParam of schema.requiredParams) {
      const value = intent.params && intent.params[reqParam.name];
      if (value == null || value === '') {
        errors.push(`Missing required parameter: ${reqParam.name} (${reqParam.description})`);
      } else if (reqParam.type === 'string[]' && !Array.isArray(value)) {
        warnings.push(`Parameter ${reqParam.name} should be an array but got ${typeof value}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 评估用户消息的先验信息丰富度，分析场景细节、身份定位、约束、深度期望和技术特异性
   * @param {string} userMessage - 用户消息文本
   * @returns {object} 评估结果，包含score(0-6)、level('low-entropy'|'medium-entropy'|'high-entropy')、signals数组
   */
  assessPriorRichness(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { score: 0, level: 'high-entropy', signals: [] };
    }

    let score = 0;
    const signals = [];

    const scenarioPatterns = [
      /在.{2,20}(场景|环境|项目|系统|模块)中/,
      /使用.{2,20}(框架|库|工具|版本)/,
      /\d+\.\d+(\.\d+)?/,
      /(?:当|如果|假设).{2,30}(时|的话|情况下)/,
    ];
    for (const p of scenarioPatterns) {
      if (p.test(userMessage)) { score += 1; signals.push('scenario-detail'); break; }
    }

    if (/(?:作为|我是|我负责|我的角色).{2,20}(开发|架构|运维|测试|产品|工程师)/.test(userMessage)) {
      score += 1; signals.push('role-identity');
    }

    if (/(?:必须|不能|限制|约束|要求|禁止|不要|不可).{2,30}/.test(userMessage)) {
      score += 1; signals.push('explicit-constraint');
    }

    if (/(?:原理|为什么|深入|底层|源码|实现细节|对比|权衡)/.test(userMessage)) {
      score += 1; signals.push('depth-expectation');
    }

    const techTerms = userMessage.match(/[A-Z][a-zA-Z]+(?:\.js|\.ts)?|\b(?:API|SDK|HTTP|REST|SQL|ORM|DI|IoC|SOLID|DRY|KISS|JWT|CORS|gRPC|CRUD)\b/g);
    if (techTerms && techTerms.length >= 3) {
      score += 1; signals.push('technical-specificity');
    }

    if (userMessage.length >= 50) score += 0.5;
    if (userMessage.length >= 100) score += 0.5;

    const level = score >= 4 ? 'low-entropy' : score >= 2 ? 'medium-entropy' : 'high-entropy';

    return { score: Math.min(score, 6), level, signals };
  }

  /**
   * 生成用户消息的质量报告，综合先验丰富度和意图完整性分析，提供改进建议
   * @param {string} userMessage - 用户消息文本
   * @param {string} skillId - 技能ID
   * @param {string} [_sessionId] - 会话ID（保留参数）
   * @returns {object} 质量报告对象，包含priorRichness、intent、firstMessageVibe、convergenceSpeed、suggestions字段
   */
  generateQualityReport(userMessage, skillId, _sessionId) {
    this.guardShutdown();
    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
      return {
        priorRichness: { score: 0, level: 'high-entropy', signals: [] },
        intent: { skillId: skillId || 'unknown', completeness: 0, missingParams: [] },
        firstMessageVibe: 'high-entropy',
        convergenceSpeed: null,
        suggestions: ['请提供更详细的任务描述'],
      };
    }
    const richness = this.assessPriorRichness(userMessage);
    const intent = this.parseIntent(userMessage || '', skillId);
    const suggestions = [];

    if (!richness.signals.includes('scenario-detail')) {
      suggestions.push('首问缺少场景细节，建议补充"在XX场景/环境中"');
    }
    if (!richness.signals.includes('role-identity')) {
      suggestions.push('首问缺少身份定位，建议补充"作为XX角色"');
    }
    if (!richness.signals.includes('explicit-constraint')) {
      suggestions.push('首问缺少具体约束，建议添加技术栈版本或性能要求');
    }
    if (!richness.signals.includes('depth-expectation') && richness.level !== 'low-entropy') {
      suggestions.push('首问缺少深度期望，建议指定"深入分析原理"或"对比XX权衡"');
    }
    if (!richness.signals.includes('technical-specificity') && richness.level !== 'low-entropy') {
      suggestions.push('首问缺少技术术语，建议使用具体的技术名词而非泛泛描述');
    }

    if (richness.level === 'low-entropy') {
      suggestions.length = 0;
    }

    return {
      priorRichness: { score: richness.score, level: richness.level, signals: richness.signals.slice() },
      intent: { skillId: intent.skillId, completeness: intent.completeness, missingParams: (intent.missingParams ?? []).map(p => p.name) },
      firstMessageVibe: richness.level,
      convergenceSpeed: null,
      suggestions,
    };
  }

  /**
   * 增强用户提示词，附加结构化意图补充信息和缺失参数提示
   * @param {string} userMessage - 原始用户消息
   * @param {string} skillId - 技能ID
   * @returns {string} 增强后的提示词文本
   */
  enhancePrompt(userMessage, skillId) {
    this.guardShutdown();
    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) return userMessage || '';
    const intent = this.parseIntent(userMessage, skillId);
    const richness = this.assessPriorRichness(userMessage);
    let enhanced = userMessage;

    if (richness.level === 'high-entropy') {
      enhanced += '\n[系统提示：当前问题先验信息不足（高熵），建议补充场景细节、身份定位或具体约束以获得更精准的回答]';
    }

    if (!intent.clarificationNeeded) return enhanced;

    const lines = [enhanced, ''];
    lines.push('--- 结构化意图补充 ---');
    lines.push(`已识别参数 (${Object.keys(intent.params ?? {}).length}个):`);
    for (const [key, value] of Object.entries(intent.params ?? {})) {
      lines.push(`  - ${key}: ${value == null ? '—' : (value !== null && typeof value === 'object' ? JSON.stringify(value) : value)}`);
    }

    if (intent.missingParams.length > 0) {
      lines.push('');
      lines.push('待补充参数:');
      for (const mp of intent.missingParams) {
        lines.push(`  - ${mp.name || '未命名'} (${mp.type || '未知'}): ${mp.description || '无描述'}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取结构化意图解析器的统计信息
   * @returns {object} 统计对象，包含totalParsed、clarificationRate、averageCompleteness、registeredSchemas、bySkill字段
   */
  getStats() {
    this.guardShutdown();
    const total = this._history.size;
    const clarified = this._history.reduce((c, h) => c + (h.clarificationNeeded ? 1 : 0), 0);
    const bySkill = {};
    for (const h of this._history) {
      if (!bySkill[h.skillId]) bySkill[h.skillId] = { count: 0, avgCompleteness: 0, totalCompleteness: 0 };
      bySkill[h.skillId].count++;
      bySkill[h.skillId].totalCompleteness += h.completeness;
    }
    for (const data of Object.values(bySkill)) {
      data.avgCompleteness = data.count > 0 ? data.totalCompleteness / data.count : 0;
      delete data.totalCompleteness;
    }

    return {
      totalParsed: total,
      clarificationRate: total > 0 ? clarified / total : 0,
      averageCompleteness: total > 0 ? this._history.reduce((s, h) => s + h.completeness, 0) / total : 0,
      registeredSchemas: Object.keys(this._schemas).length,
      bySkill,
    };
  }

  _extractParams(userMessage, schema) {
    const params = {};

    if (!schema) {
      params.description = userMessage;
      return params;
    }

    const allParams = [...(schema.requiredParams ?? []), ...(schema.optionalParams ?? [])];
    for (const param of allParams) {
      const patterns = this._buildExtractionPatterns(param);
      for (const pattern of patterns) {
        const match = userMessage.match(pattern);
        if (match) {
          params[param.name] = this._castValue(match[1] || match[0], param.type);
          break;
        }
      }
    }

    if (Object.keys(params).length === 0) {
      params.description = userMessage;
    }

    return params;
  }

  _buildExtractionPatterns(param) {
    const name = param.name;
    const nameParts = name.split('_').slice(0, MAX_PARAM_NAME_PARTS);
    const displayName = nameParts.map(function(p) { return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('[\\s_]');
    const patterns = [];

    try {
      patterns.push(new RegExp(`${displayName}[：:]\\s*([^，,\\n]{1,500})`, 'i'));
      patterns.push(new RegExp(`${displayName}\\s+(?:is|are|为|是)\\s+([^，,\\n]{1,500})`, 'i'));

      if (param.type === 'string[]') {
        patterns.push(new RegExp(`${displayName}[：:]\\s*([^\\n]{1,2000})`, 'i'));
      }
    } catch (_e) {
      debug('StructuredIntent', 'buildExtractionPatterns-error', _e && _e.message ? _e.message : String(_e));
    }

    return patterns;
  }

  _castValue(value, type) {
    if (value == null) return value;
    const trimmed = value.trim();

    if (type === 'string[]') {
      return trimmed.split(/[,，、;；]/).map(s => s.trim()).filter(s => s.length > 0);
    }

    return trimmed;
  }

  _buildClarificationPrompt(skillId, missingParams) {
    const lines = ['## 意图不完整 — 需要补充信息', ''];
    lines.push(`当前任务: ${skillId}`);
    lines.push('');
    lines.push('请提供以下必要信息：');
    for (const mp of missingParams) {
      lines.push(`- **${mp.name || '未命名'}** (${mp.type || '未知'}): ${mp.description || '无描述'}`);
    }
    lines.push('');
    lines.push('示例格式：');
    for (const mp of missingParams) {
      lines.push(`  ${mp.name}: <你的输入>`);
    }
    return lines.join('\n');
  }

  /**
   * 清除指定会话的所有累积参数
   * @param {string} sessionId - 会话ID
   * @returns {void}
   */
  clearSession(sessionId) {
    this.guardShutdown();
    if (!sessionId) return;
    const toDelete = [];
    for (const key of this._sessionParams.keys()) {
      if (key.startsWith(sessionId + ':')) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this._sessionParams.delete(key);
    }
  }

  /**
   * 获取指定会话和技能的累积参数
   * @param {string} sessionId - 会话ID
   * @param {string} skillId - 技能ID
   * @returns {object|null} 累积参数对象，未找到返回null
   */
  getSessionParams(sessionId, skillId) {
    const sessionKey = sessionId + ':' + skillId;
    return this._sessionParams.get(sessionKey) ?? null;
  }

  _onShutdown() {
    this._history.clear();
    this._sessionParams.clear();
    this.removeAllListeners();
  }
}

StructuredIntent.INTENT_SCHEMAS = INTENT_SCHEMAS;

module.exports = withShutdown(StructuredIntent);
