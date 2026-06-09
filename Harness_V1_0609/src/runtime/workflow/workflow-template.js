'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { DANGEROUS_KEYS, HARNESS_DIR, validateProjectRoot } = require('../../utils/constants');
const { writeAtomic } = require('../../utils/debounced-persister');
const JsonStoreRestorer = require('../../utils/json-store-restorer');
const { withShutdown } = require('../../utils/shutdown-mixin');
const deepClone = require('../../utils/deep-clone');

const TEMPLATES_DIR = 'workflow-templates';

/**
 * @module runtime/workflow/workflow-template
 * @classdesc 工作流模板管理器（WorkflowTemplate）。预定义工作流、参数化、复用。
 * WorkflowTemplate — 工作流模板管理器
 * Creates, stores, and instantiates parameterized workflow templates with variable interpolation.
 * Templates contain ordered steps with goal and context fields that support {{variable}} placeholders.
 * Sanitizes interpolated values to prevent injection, persists templates to disk with atomic writes,
 * and restores them on startup.
 */
class WorkflowTemplate extends EventEmitter {
  /**
   * Create a WorkflowTemplate instance.
   * @param {string} projectRoot - Project root directory path
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'WorkflowTemplate');
    this.root = projectRoot;
    this._templates = new Map();
    this._maxTemplates = 200;
    this._restore();
  }

  /**
   * 创建工作流模板并持久化到磁盘。
   * @param {string} name - 模板名称（唯一标识）
   * @param {Object} definition - 模板定义
   * @param {string} [definition.description] - 模板描述
   * @param {string} [definition.version] - 模板版本
   * @param {Array<Object>} definition.steps - 模板步骤列表，每步含goal和context字段
   * @param {Array<Object>} [definition.variables] - 模板变量定义列表
   * @returns {Object|null} 创建的模板对象，参数无效时返回null
   */
  create(name, definition) {
    this.guardShutdown();
    if (!name || !definition || !Array.isArray(definition.steps)) {
      return null;
    }
    if (this._templates.size >= this._maxTemplates && !this._templates.has(name)) {
      return null;
    }

    const template = {
      name,
      description: definition.description || '',
      version: definition.version || '1.0.0',
      steps: deepClone(definition.steps),
      variables: definition.variables ? deepClone(definition.variables) : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._templates.set(name, template);
    this._persist();
    return template;
  }

  /**
   * 获取指定名称的模板。
   * @param {string} name - 模板名称
   * @returns {Object|null} 模板对象，不存在时返回null
   */
  get(name) {
    return this._templates.get(name) ?? null;
  }

  /**
   * 列出所有模板的深拷贝列表。
   * @returns {Object[]} 模板对象数组
   */
  list() {
    return Array.from(this._templates.values()).map(t => ({ ...t, steps: t.steps ? deepClone(t.steps) : [], variables: t.variables ? deepClone(t.variables) : [] }));
  }

  /**
   * 实例化模板，将步骤中的{{variable}}占位符替换为传入的变量值。
   * 插入值会经过消毒处理以防止注入。
   * @param {string} name - 模板名称
   * @param {Object} [variables] - 变量键值对，用于替换步骤中的占位符
   * @returns {Object|null} 实例化结果，含templateName、steps和instantiatedAt，模板不存在时返回null
   */
  instantiate(name, variables) {
    this.guardShutdown();
    const template = this._templates.get(name);
    if (!template) return null;

    const resolvedSteps = template.steps.map(step => {
      const resolved = deepClone(step);
      if (step.goal && variables) {
        resolved.goal = _interpolate(step.goal, variables);
      }
      if (step.context && variables) {
        resolved.context = _interpolate(step.context, variables);
      }
      return resolved;
    });

    return {
      templateName: name,
      steps: resolvedSteps,
      instantiatedAt: new Date().toISOString(),
    };
  }

  /**
   * 删除指定名称的模板。
   * @param {string} name - 模板名称
   * @returns {boolean} 模板是否存在并被删除
   */
  remove(name) {
    this.guardShutdown();
    const existed = this._templates.delete(name);
    if (existed) this._persist();
    return existed;
  }

  _restore() {
    try {
      const result = JsonStoreRestorer.loadSync(this.root, TEMPLATES_DIR + '/templates.json', {
        expectedType: 'array',
        logLabel: 'WorkflowTemplate',
      });
      if (!result) return;
      for (const t of result.data ?? []) {
        if (t.name) this._templates.set(t.name, t);
      }
    } catch (err) {
      debug('WorkflowTemplate', '_restore', err);
      this._restoreError = err && err.message ? err.message : String(err);
    }
  }

  _persist() {
    try {
      const data = Array.from(this._templates.values());
      const filePath = path.join(this.root, HARNESS_DIR, TEMPLATES_DIR, 'templates.json');
      writeAtomic(filePath, data);
    } catch (err) {
      debug('WorkflowTemplate', '_persist', err);
      this._persistError = err && err.message ? err.message : String(err);
      this.emit('persist-error', { error: err && err.message ? err.message : String(err) });
    }
  }

  _onShutdown() {
    this._persist();
    this._templates.clear();
    this.removeAllListeners();
  }
}

function _sanitizeValue(val) {
  const str = String(val);
  return str.replace(/[;{}\\]/g, '');
}

function _interpolate(template, variables) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (DANGEROUS_KEYS.has(key)) return match;
    return variables[key] !== undefined ? _sanitizeValue(variables[key]) : match;
  });
}

module.exports = withShutdown(WorkflowTemplate);
