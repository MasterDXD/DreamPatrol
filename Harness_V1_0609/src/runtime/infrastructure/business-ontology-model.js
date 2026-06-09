'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { debug } = require('../../utils/debug-logger');

/**
 * BusinessOntologyModel - 企业级业务本体模型层
 *
 * Codifies business rules into reusable ontology models with:
 * - Entity type definitions (Order, Customer, Product, etc.)
 * - Business rule declarations (validation, threshold, alert)
 * - Dynamic model updates without code changes
 * - Integration with IronRuleEngine and workflow system
 */
class BusinessOntologyModel extends EventEmitter {
  constructor(options) {
    const opts = options ?? {};
    super();
    this._maxEntityTypes = opts.maxEntityTypes ?? 100;
    this._maxRules = opts.maxRules ?? 500;
    this._maxModels = opts.maxModels ?? 50;

    this._entityTypes = new BoundedMap(this._maxEntityTypes);
    this._businessRules = new BoundedMap(this._maxRules);
    this._models = new BoundedMap(this._maxModels);
    this._ruleEngine = opts.ruleEngine || null;
    this._auditLog = new BoundedArray(1000);
  }

  /**
   * Define an entity type in the business ontology
   * @param {string} typeName - Entity type name (e.g., 'Order', 'Customer')
   * @param {object} schema - Entity schema definition
   * @param {object} schema.properties - Entity properties with types
   * @param {Array} schema.required - Required properties
   * @param {object} schema.indexes - Index definitions for query optimization
   * @param {object} options - {description, parentType, tags}
   * @returns {{typeName: string, created: boolean}}
   */
  defineEntityType(typeName, schema, options = {}) {
    this.guardShutdown();
    if (!typeName || typeof typeName !== 'string') {
      throw new Error('BusinessOntologyModel: typeName must be a non-empty string');
    }
    if (!schema || typeof schema !== 'object') {
      throw new Error('BusinessOntologyModel: schema must be an object');
    }

    const existing = this._entityTypes.get(typeName);
    const definition = {
      typeName,
      schema: {
        properties: schema.properties ?? {},
        required: schema.required ?? [],
        indexes: schema.indexes ?? [],
      },
      description: options.description || '',
      parentType: options.parentType || null,
      tags: options.tags ?? [],
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: (existing?.version ?? 0) + 1,
    };

    this._entityTypes.set(typeName, definition);
    this._audit('entity-type:defined', { typeName, version: definition.version });
    this.emit('ontology:entity-defined', { typeName, version: definition.version });

    return { typeName, created: !existing };
  }

  /**
   * Get an entity type definition
   * @param {string} typeName
   * @returns {object|null}
   */
  getEntityType(typeName) {
    this.guardShutdown();
    return this._entityTypes.get(typeName) ?? null;
  }

  /**
   * List all entity types
   * @returns {Array<{typeName: string, description: string, version: number}>}
   */
  listEntityTypes() {
    this.guardShutdown();
    const result = [];
    for (const [, def] of this._entityTypes) {
      result.push({
        typeName: def.typeName,
        description: def.description,
        version: def.version,
        parentType: def.parentType,
        tags: def.tags,
      });
    }
    return result;
  }

  /**
   * Add a business rule to the ontology
   * @param {string} ruleId - Unique rule identifier
   * @param {object} ruleDef - Rule definition
   * @param {string} ruleDef.entityType - Target entity type
   * @param {string} ruleDef.ruleType - Rule type: 'validation'|'threshold'|'alert'|'derivation'
   * @param {string} ruleDef.condition - Condition expression (evaluated by rule engine)
   * @param {string} ruleDef.action - Action to take when condition is met
   * @param {object} options - {priority, description, enabled}
   * @returns {{ruleId: string, created: boolean}}
   */
  _validateRuleInputs(ruleId, ruleDef) {
    if (!ruleId || typeof ruleId !== 'string') {
      throw new Error('BusinessOntologyModel: ruleId must be a non-empty string');
    }
    if (!ruleDef || typeof ruleDef !== 'object') {
      throw new Error('BusinessOntologyModel: ruleDef must be an object');
    }
    const VALID_RULE_TYPES = ['validation', 'threshold', 'alert', 'derivation'];
    if (!VALID_RULE_TYPES.includes(ruleDef.ruleType)) {
      throw new Error(`BusinessOntologyModel: ruleType must be one of ${VALID_RULE_TYPES.join(', ')}`);
    }
  }

  addBusinessRule(ruleId, ruleDef, options = {}) {
    this.guardShutdown();
    this._validateRuleInputs(ruleId, ruleDef);
    const existing = this._businessRules.get(ruleId);
    const rule = {
      ruleId,
      entityType: ruleDef.entityType || '*',
      ruleType: ruleDef.ruleType,
      condition: ruleDef.condition || '',
      action: ruleDef.action || '',
      priority: options.priority ?? 50,
      description: options.description || '',
      enabled: options.enabled !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: (existing?.version ?? 0) + 1,
    };
    this._businessRules.set(ruleId, rule);
    this._syncRuleToEngine(rule, ruleId);
    this._audit('business-rule:added', { ruleId, ruleType: rule.ruleType, version: rule.version });
    this.emit('ontology:rule-added', { ruleId, ruleType: rule.ruleType, version: rule.version });
    return { ruleId, created: !existing };
  }

  _syncRuleToEngine(rule, ruleId) {
    if (this._ruleEngine && typeof this._ruleEngine.addPatternRule === 'function' && rule.enabled) {
      try {
        this._ruleEngine.addPatternRule(
          rule.condition,
          `${rule.ruleType}: ${rule.description || ruleId}`,
          rule.action,
          { id: ruleId, entityType: rule.entityType, priority: rule.priority },
        );
      } catch (_e) { // non-fatal: rule engine sync failure is acceptable
        debug('BusinessOntologyModel', 'rule-engine-sync-skipped', ruleId);
      }
    }
  }

  /**
   * Get a business rule
   * @param {string} ruleId
   * @returns {object|null}
   */
  getBusinessRule(ruleId) {
    this.guardShutdown();
    return this._businessRules.get(ruleId) ?? null;
  }

  /**
   * List business rules, optionally filtered by entity type or rule type
   * @param {object} filter - {entityType, ruleType, enabledOnly}
   * @returns {Array<object>}
   */
  listBusinessRules(filter = {}) {
    this.guardShutdown();
    const result = [];
    for (const [, rule] of this._businessRules) {
      if (filter.entityType && rule.entityType !== '*' && rule.entityType !== filter.entityType) continue;
      if (filter.ruleType && rule.ruleType !== filter.ruleType) continue;
      if (filter.enabledOnly && !rule.enabled) continue;
      result.push(rule);
    }
    return result.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Toggle a business rule on/off
   * @param {string} ruleId
   * @param {boolean} enabled
   * @returns {boolean}
   */
  toggleBusinessRule(ruleId, enabled) {
    this.guardShutdown();
    const rule = this._businessRules.get(ruleId);
    if (!rule) return false;
    rule.enabled = enabled;
    rule.updatedAt = new Date().toISOString();
    this._audit('business-rule:toggled', { ruleId, enabled });
    this.emit('ontology:rule-toggled', { ruleId, enabled });
    return true;
  }

  /**
   * Create an ontology model that groups entity types and rules
   * @param {string} modelId - Model identifier
   * @param {object} modelDef - Model definition
   * @param {Array<string>} modelDef.entityTypes - Entity types in this model
   * @param {Array<string>} modelDef.rules - Business rules in this model
   * @param {object} options - {description, version}
   * @returns {{modelId: string, created: boolean}}
   */
  createModel(modelId, modelDef, options = {}) {
    this.guardShutdown();
    if (!modelId || typeof modelId !== 'string') {
      throw new Error('BusinessOntologyModel: modelId must be a non-empty string');
    }

    const existing = this._models.get(modelId);
    const model = {
      modelId,
      entityTypes: modelDef.entityTypes ?? [],
      rules: modelDef.rules ?? [],
      description: options.description || '',
      version: options.version || 1,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._models.set(modelId, model);
    this._audit('model:created', { modelId, entityCount: model.entityTypes.length, ruleCount: model.rules.length });
    this.emit('ontology:model-created', { modelId });

    return { modelId, created: !existing };
  }

  /**
   * Get an ontology model
   * @param {string} modelId
   * @returns {object|null}
   */
  getModel(modelId) {
    this.guardShutdown();
    return this._models.get(modelId) ?? null;
  }

  /**
   * List all models
   * @returns {Array<{modelId: string, description: string, entityCount: number, ruleCount: number}>}
   */
  listModels() {
    this.guardShutdown();
    const result = [];
    for (const [, model] of this._models) {
      result.push({
        modelId: model.modelId,
        description: model.description,
        entityCount: model.entityTypes.length,
        ruleCount: model.rules.length,
        version: model.version,
      });
    }
    return result;
  }

  /**
   * Evaluate business rules against an entity instance
   * @param {string} entityType - Entity type name
   * @param {object} entityData - Entity instance data
   * @returns {{passed: Array, failed: Array, skipped: Array}}
   */
  evaluateRules(entityType, entityData) {
    this.guardShutdown();
    if (!entityType || typeof entityType !== 'string') {
      throw new Error('BusinessOntologyModel: entityType must be a non-empty string');
    }

    const passed = [];
    const failed = [];
    const skipped = [];

    for (const [, rule] of this._businessRules) {
      if (!rule.enabled) { skipped.push(rule.ruleId); continue; }
      if (rule.entityType !== '*' && rule.entityType !== entityType) { skipped.push(rule.ruleId); continue; }

      // Simple condition evaluation
      try {
        const result = this._evaluateCondition(rule.condition, entityData);
        if (result) {
          passed.push({ ruleId: rule.ruleId, action: rule.action });
        } else {
          failed.push({ ruleId: rule.ruleId, condition: rule.condition, action: rule.action });
        }
      } catch (_e) {
        skipped.push(rule.ruleId);
      }
    }

    if (this._shutDown) return { passed, failed, skipped };
    this._audit('rules:evaluated', { entityType, passed: passed.length, failed: failed.length, skipped: skipped.length });
    this.emit('ontology:rules-evaluated', { entityType, passed: passed.length, failed: failed.length });

    return { passed, failed, skipped };
  }

  /**
   * Get audit log entries
   * @param {object} filter - {actionType, limit}
   * @returns {Array<object>}
   */
  getAuditLog(filter = {}) {
    this.guardShutdown();
    const entries = [];
    const limit = filter.limit ?? 100;
    for (const entry of this._auditLog) {
      if (filter.actionType && entry.action !== filter.actionType) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries;
  }

  /**
   * Get statistics about the ontology
   * @returns {object}
   */
  getStats() {
    this.guardShutdown();
    return {
      entityTypeCount: this._entityTypes.size,
      businessRuleCount: this._businessRules.size,
      modelCount: this._models.size,
      auditLogSize: this._auditLog.size,
    };
  }

  // --- Private methods ---

  /**
   * Evaluate a condition expression against entity data.
   *
   * Supports:
   * - Simple: "field > value"
   * - Compound: "field1 > 10 AND field2 < 100"
   * - Nested: "(field1 > 10 OR field2 < 5) AND field3 == 'active'"
   * - Time window: "field:within(30d)" — field timestamp within last 30 days
   * - Aggregation: "count(items) > 5", "sum(orders.amount) >= 1000", "avg(scores) >= 80"
   * - Existence: "field:exists", "field:empty"
   * - Contains: "field:contains('keyword')"
   * - Range: "field:between(10, 100)"
   *
   * @private
   */
  _evaluateCondition(condition, data) {
    if (!condition || typeof condition !== 'string') return true;
    const trimmed = condition.trim();
    if (!trimmed) return true;

    // Handle parenthesized groups and AND/OR logic
    return this._evalLogical(trimmed, data);
  }

  /**
   * Parse and evaluate logical expressions with AND/OR and parentheses.
   * @private
   */
  _evalLogical(expr, data) {
    // Split by top-level AND/OR (not inside parentheses)
    const orParts = this._splitLogical(expr, 'OR');
    if (orParts.length > 1) {
      return orParts.some(part => this._evalLogical(part.trim(), data));
    }

    const andParts = this._splitLogical(expr, 'AND');
    if (andParts.length > 1) {
      return andParts.every(part => this._evalLogical(part.trim(), data));
    }

    // Handle NOT
    const notMatch = expr.match(/^NOT\s+(.+)$/i);
    if (notMatch) {
      return !this._evalLogical(notMatch[1].trim(), data);
    }

    // Handle parentheses
    const parenMatch = expr.match(/^\((.+)\)$/);
    if (parenMatch) {
      return this._evalLogical(parenMatch[1].trim(), data);
    }

    // Evaluate atomic condition
    return this._evalAtomic(expr.trim(), data);
  }

  /**
   * Split expression by logical operator at top level (not inside parentheses).
   * @private
   */
  _splitLogical(expr, operator) {
    const parts = [];
    let depth = 0;
    let current = '';
    let i = 0;
    const op = operator;

    while (i < expr.length) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') depth--;

      if (depth === 0 && expr.substring(i, i + op.length + 2).toUpperCase() === ' ' + op + ' ') {
        parts.push(current);
        current = '';
        i += op.length + 2;
        continue;
      }
      current += expr[i];
      i++;
    }
    if (current) parts.push(current);
    return parts;
  }

  /**
   * Evaluate an atomic condition expression.
   * @private
   */
  _isUnsafeField(field) {
    return field === '__proto__' || field === 'constructor' || field === 'prototype';
  }

  _evalAtomic(expr, data) {
    const timeResult = this._evalTimeWindow(expr, data);
    if (timeResult !== null) return timeResult;
    const existsResult = this._evalExistence(expr, data);
    if (existsResult !== null) return existsResult;
    const containsResult = this._evalContains(expr, data);
    if (containsResult !== null) return containsResult;
    const betweenResult = this._evalBetween(expr, data);
    if (betweenResult !== null) return betweenResult;
    const aggResult = this._evalAggregation(expr, data);
    if (aggResult !== null) return aggResult;
    const compResult = this._evalComparison(expr, data);
    if (compResult !== null) return compResult;
    return false;
  }

  _evalTimeWindow(expr, data) {
    const match = expr.match(/^(\w+):within\((\d+)([dhms])\)$/i);
    if (!match) return null;
    const field = match[1];
    if (this._isUnsafeField(field)) return false;
    const num = parseInt(match[2], 10);
    const unit = match[3].toLowerCase();
    const multipliers = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
    const threshold = Date.now() - num * (multipliers[unit] ?? 86400000);
    const fieldValue = data[field];
    const ts = typeof fieldValue === 'number' ? fieldValue : new Date(fieldValue).getTime();
    return !isNaN(ts) && ts >= threshold;
  }

  _evalExistence(expr, data) {
    const match = expr.match(/^(\w+):(exists|empty)$/i);
    if (!match) return null;
    const field = match[1];
    if (this._isUnsafeField(field)) return false;
    const check = match[2].toLowerCase();
    const fieldValue = data[field];
    if (check === 'exists') return fieldValue !== undefined && fieldValue !== null;
    if (check === 'empty') return fieldValue === undefined || fieldValue === null || fieldValue === '' || (Array.isArray(fieldValue) && fieldValue.length === 0);
    return false;
  }

  _evalContains(expr, data) {
    const match = expr.match(/^(\w+):contains\(['"](.+)['"]\)$/i);
    if (!match) return null;
    const field = match[1];
    if (this._isUnsafeField(field)) return false;
    const keyword = match[2];
    const fieldValue = data[field];
    if (typeof fieldValue === 'string') return fieldValue.includes(keyword);
    if (Array.isArray(fieldValue)) return fieldValue.some(function(v) { return String(v).includes(keyword); });
    return false;
  }

  _evalBetween(expr, data) {
    const match = expr.match(/^(\w+):between\(([^,]+),\s*([^)]+)\)$/i);
    if (!match) return null;
    const field = match[1];
    if (this._isUnsafeField(field)) return false;
    const low = this._parseValue(match[2].trim());
    const high = this._parseValue(match[3].trim());
    const fieldValue = data[field];
    return typeof fieldValue === 'number' && fieldValue >= low && fieldValue <= high;
  }

  _evalAggregation(expr, data) {
    const match = expr.match(/^(count|sum|avg|min|max)\((\w+(?:\.\w+)?)\)\s*(>=|<=|==|!=|>|<)\s*(.+)$/i);
    if (!match) return null;
    const aggFn = match[1].toLowerCase();
    const fieldPath = match[2];
    const operator = match[3];
    const threshold = this._parseValue(match[4].trim());
    const aggResult = this._computeAggregation(aggFn, fieldPath, data);
    if (aggResult === null) return false;
    return this._compareValues(aggResult, operator, threshold);
  }

  _evalComparison(expr, data) {
    const match = expr.match(/^(\w+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
    if (!match) return null;
    const field = match[1];
    if (this._isUnsafeField(field)) return false;
    const operator = match[2];
    const value = this._parseValue(match[3].trim());
    const fieldValue = data[field];
    return this._compareValues(fieldValue, operator, value);
  }

  /**
   * Parse a value string to its typed equivalent.
   * @private
   */
  _parseValue(valueStr) {
    if (typeof valueStr !== 'string') return valueStr;
    const trimmed = valueStr.trim();
    // Quoted string
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }
    // Boolean
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    // Number
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed !== '') return num;
    return trimmed;
  }

  /**
   * Compare two values with the given operator.
   * @private
   */
  _compareValues(fieldValue, operator, value) {
    switch (operator) {
      case '>': return fieldValue > value;
      case '<': return fieldValue < value;
      case '>=': return fieldValue >= value;
      case '<=': return fieldValue <= value;
      case '==': return String(fieldValue) === String(value);
      case '!=': return String(fieldValue) !== String(value);
      default: return true;
    }
  }

  /**
   * Compute an aggregation function on a field path.
   * @private
   */
  _computeAggregation(aggFn, fieldPath, data) {
    const parts = fieldPath.split('.');
    const arrayField = parts[0];
    if (arrayField === '__proto__' || arrayField === 'constructor' || arrayField === 'prototype') return null;
    const subField = parts.length > 1 ? parts[1] : null;
    const arr = data[arrayField];

    if (!Array.isArray(arr)) return null;
    if (arr.length === 0 && aggFn !== 'count') return null;

    const values = subField
      ? arr.map(function(item) { return item && item[subField] !== undefined ? item[subField] : 0; })
      : arr;

    const nums = values.filter(function(v) { return typeof v === 'number'; });
    if (nums.length === 0 && aggFn !== 'count') return null;

    switch (aggFn) {
      case 'count': return arr.length;
      case 'sum': return nums.reduce(function(a, b) { return a + b; }, 0);
      case 'avg': return nums.length > 0 ? nums.reduce(function(a, b) { return a + b; }, 0) / nums.length : null;
      case 'min': return nums.length > 0 ? Math.min.apply(null, nums) : null;
      case 'max': return nums.length > 0 ? Math.max.apply(null, nums) : null;
      default: return null;
    }
  }

  _audit(action, details) {
    this._auditLog.push({
      action,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  _onShutdown() {
    this.removeAllListeners();
    try { this._entityTypes.shutdown(); } catch (_e) { debug('BusinessOntologyModel', '_onShutdown:entityTypes', _e && _e.message ? _e.message : String(_e)); }
    try { this._businessRules.shutdown(); } catch (_e) { debug('BusinessOntologyModel', '_onShutdown:businessRules', _e && _e.message ? _e.message : String(_e)); }
    try { this._models.shutdown(); } catch (_e) { debug('BusinessOntologyModel', '_onShutdown:models', _e && _e.message ? _e.message : String(_e)); }
    try { this._auditLog.shutdown(); } catch (_e) { debug('BusinessOntologyModel', '_onShutdown:auditLog', _e && _e.message ? _e.message : String(_e)); }
    this._entityTypes = null;
    this._businessRules = null;
    this._models = null;
    this._auditLog = null;
    this._ruleEngine = null;
  }
}

module.exports = withShutdown(BusinessOntologyModel);
