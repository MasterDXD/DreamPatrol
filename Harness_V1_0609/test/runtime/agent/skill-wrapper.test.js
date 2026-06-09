'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillWrapperModule = require(path.join(ROOT, 'src', 'runtime', 'agent', 'skill-wrapper'));
const SkillWrapper = SkillWrapperModule.SkillWrapper || SkillWrapperModule;

describe('SkillWrapper - Constructor', () => {
  it('should create instance with default config', () => {
    const sw = new SkillWrapper();
    assert.ok(sw);
    assert.strictEqual(sw._config.maxPredicates, 20);
    assert.strictEqual(sw._config.minConfidence, 0.5);
    assert.strictEqual(sw._config.maxBridgeDepth, 3);
  });

  it('should merge custom options with defaults', () => {
    const sw = new SkillWrapper({ maxPredicates: 10 });
    assert.strictEqual(sw._config.maxPredicates, 10);
    assert.strictEqual(sw._config.minConfidence, 0.5);
  });

  it('should initialize counters to zero', () => {
    const sw = new SkillWrapper();
    assert.strictEqual(sw._inventCount, 0);
    assert.strictEqual(sw._bridgeCount, 0);
    assert.strictEqual(sw._validationCount, 0);
  });

  it('should expose DEFAULT_CONFIG and PREDICATE_TYPES', () => {
    assert.ok(SkillWrapperModule.DEFAULT_CONFIG);
    assert.ok(SkillWrapperModule.PREDICATE_TYPES);
    assert.strictEqual(SkillWrapperModule.PREDICATE_TYPES.SPATIAL, 'spatial');
    assert.strictEqual(SkillWrapperModule.PREDICATE_TYPES.ATTRIBUTE, 'attribute');
    assert.strictEqual(SkillWrapperModule.PREDICATE_TYPES.RELATIONAL, 'relational');
    assert.strictEqual(SkillWrapperModule.PREDICATE_TYPES.TEMPORAL, 'temporal');
    assert.strictEqual(SkillWrapperModule.PREDICATE_TYPES.EXISTENTIAL, 'existential');
  });
});

describe('SkillWrapper - inventPredicate', () => {
  it('should invent predicates from visual input', () => {
    const sw = new SkillWrapper();
    const result = sw.inventPredicate({
      description: 'A form with input fields',
      elements: [
        { name: 'form', type: 'existential', properties: ['form'], confidence: 0.9 },
        { name: 'input', type: 'attribute', properties: ['input'], confidence: 0.8 },
      ],
      spatialRelations: [],
    });
    assert.ok(result.predicates);
    assert.ok(result.reasoning);
    assert.ok(result.predicates.length > 0);
  });

  it('should extract spatial predicates', () => {
    const sw = new SkillWrapper();
    const result = sw.inventPredicate({
      description: 'Layout',
      elements: [],
      spatialRelations: [
        { type: 'above', entities: ['header', 'content'], confidence: 0.7 },
      ],
    });
    const spatial = result.predicates.filter(p => p.type === 'spatial');
    assert.strictEqual(spatial.length, 1);
    assert.strictEqual(spatial[0].name, 'above');
  });

  it('should extract description predicates', () => {
    const sw = new SkillWrapper();
    const result = sw.inventPredicate({
      description: 'important component layout',
      elements: [],
      spatialRelations: [],
    });
    const attr = result.predicates.filter(p => p.type === 'attribute');
    assert.ok(attr.length > 0);
  });

  it('should throw for invalid visualInput', () => {
    const sw = new SkillWrapper();
    assert.throws(() => sw.inventPredicate(null), /visualInput/);
    assert.throws(() => sw.inventPredicate('string'), /visualInput/);
  });

  it('should handle empty visual input', () => {
    const sw = new SkillWrapper();
    const result = sw.inventPredicate({ description: '', elements: [], spatialRelations: [] });
    assert.ok(result.predicates);
    assert.ok(result.reasoning);
  });

  it('should filter element predicates below minConfidence', () => {
    const sw = new SkillWrapper({ minConfidence: 0.8 });
    const result = sw.inventPredicate({
      description: '',
      elements: [
        { name: 'low', type: 'existential', properties: ['low'], confidence: 0.3 },
        { name: 'high', type: 'existential', properties: ['high'], confidence: 0.9 },
      ],
      spatialRelations: [],
    });
    const elementPreds = result.predicates.filter(p => p.name === 'low' || p.name === 'high');
    assert.strictEqual(elementPreds.length, 1);
    assert.strictEqual(elementPreds[0].name, 'high');
  });

  it('should respect maxPredicates limit', () => {
    const sw = new SkillWrapper({ maxPredicates: 2 });
    const result = sw.inventPredicate({
      description: 'a b c d e',
      elements: [
        { name: 'e1', type: 'existential', properties: ['e1'], confidence: 0.9 },
        { name: 'e2', type: 'existential', properties: ['e2'], confidence: 0.9 },
        { name: 'e3', type: 'existential', properties: ['e3'], confidence: 0.9 },
      ],
      spatialRelations: [],
    });
    assert.ok(result.predicates.length <= 2);
  });

  it('should emit predicates-invented event', () => {
    const sw = new SkillWrapper();
    let emitted = false;
    sw.on('predicates-invented', () => { emitted = true; });
    sw.inventPredicate({ description: 'test', elements: [], spatialRelations: [] });
    assert.strictEqual(emitted, true);
  });

  it('should cache predicates', () => {
    const sw = new SkillWrapper();
    sw.inventPredicate({ description: 'test cache', elements: [], spatialRelations: [] });
    assert.strictEqual(sw._predicateCache.size, 1);
  });
});

describe('SkillWrapper - bridgeToReasoning', () => {
  it('should bridge predicates to skill inputs', () => {
    const sw = new SkillWrapper();
    const predicates = [
      { name: 'above', type: 'spatial', arguments: ['a', 'b'], confidence: 0.8 },
      { name: 'color', type: 'attribute', arguments: ['red'], confidence: 0.7 },
    ];
    const result = sw.bridgeToReasoning(predicates, 'build the form');
    assert.ok(result.skillInputs);
    assert.ok(result.reasoningChain);
    assert.ok(result.skillInputs.spatialContext);
    assert.ok(result.skillInputs.attributes);
  });

  it('should include taskGoal in skill inputs', () => {
    const sw = new SkillWrapper();
    const result = sw.bridgeToReasoning([], 'my goal');
    assert.strictEqual(result.skillInputs.taskGoal, 'my goal');
  });

  it('should handle relational predicates', () => {
    const sw = new SkillWrapper();
    const predicates = [
      { name: 'depends', type: 'relational', arguments: ['a', 'b'], confidence: 0.8 },
    ];
    const result = sw.bridgeToReasoning(predicates);
    assert.ok(result.skillInputs.relations);
  });

  it('should handle existential/temporal predicates as contextual', () => {
    const sw = new SkillWrapper();
    const predicates = [
      { name: 'exists', type: 'existential', arguments: ['x'], confidence: 0.8 },
      { name: 'before', type: 'temporal', arguments: ['a', 'b'], confidence: 0.7 },
    ];
    const result = sw.bridgeToReasoning(predicates);
    assert.ok(result.skillInputs.contextual);
  });

  it('should throw for non-array predicates', () => {
    const sw = new SkillWrapper();
    assert.throws(() => sw.bridgeToReasoning('not-array'), /array/);
  });

  it('should respect maxBridgeDepth', () => {
    const sw = new SkillWrapper({ maxBridgeDepth: 1 });
    const predicates = [
      { name: 'a', type: 'spatial', arguments: [], confidence: 0.8 },
      { name: 'b', type: 'attribute', arguments: [], confidence: 0.8 },
      { name: 'c', type: 'relational', arguments: [], confidence: 0.8 },
    ];
    const result = sw.bridgeToReasoning(predicates, 'goal');
    assert.ok(result.reasoningChain.length <= 1);
  });

  it('should emit bridge-created event', () => {
    const sw = new SkillWrapper();
    let emitted = false;
    sw.on('bridge-created', () => { emitted = true; });
    sw.bridgeToReasoning([]);
    assert.strictEqual(emitted, true);
  });
});

describe('SkillWrapper - validateBridge', () => {
  it('should validate a correct bridge', () => {
    const sw = new SkillWrapper();
    const predicates = [
      { name: 'above', type: 'spatial', arguments: ['a', 'b'], confidence: 0.8 },
    ];
    const skillInputs = {
      spatialContext: [{ name: 'above', values: ['a', 'b'], confidence: 0.8 }],
    };
    const result = sw.validateBridge(predicates, skillInputs);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.coverage, 1);
  });

  it('should return invalid for empty predicates', () => {
    const sw = new SkillWrapper();
    const result = sw.validateBridge([], {});
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.coverage, 0);
  });

  it('should report low coverage', () => {
    const sw = new SkillWrapper();
    const predicates = [
      { name: 'a', type: 'spatial', arguments: [], confidence: 0.8 },
      { name: 'b', type: 'attribute', arguments: [], confidence: 0.8 },
      { name: 'c', type: 'relational', arguments: [], confidence: 0.8 },
    ];
    const skillInputs = {
      spatialContext: [{ name: 'a', values: [], confidence: 0.8 }],
    };
    const result = sw.validateBridge(predicates, skillInputs);
    assert.ok(result.coverage < 1);
    assert.ok(result.issues.length > 0);
  });

  it('should throw for non-array predicates', () => {
    const sw = new SkillWrapper();
    assert.throws(() => sw.validateBridge('not-array', {}), /array/);
  });

  it('should throw for non-object skillInputs', () => {
    const sw = new SkillWrapper();
    assert.throws(() => sw.validateBridge([], null), /object/);
    assert.throws(() => sw.validateBridge([], 'string'), /object/);
  });

  it('should emit bridge-validated event', () => {
    const sw = new SkillWrapper();
    let emitted = false;
    sw.on('bridge-validated', () => { emitted = true; });
    sw.validateBridge([], {});
    assert.strictEqual(emitted, true);
  });
});

describe('SkillWrapper - getStats', () => {
  it('should return stats object', () => {
    const sw = new SkillWrapper();
    const stats = sw.getStats();
    assert.strictEqual(stats.inventCount, 0);
    assert.strictEqual(stats.bridgeCount, 0);
    assert.strictEqual(stats.validationCount, 0);
    assert.strictEqual(stats.cachedPredicates, 0);
    assert.ok(stats.config);
  });

  it('should reflect activity', () => {
    const sw = new SkillWrapper();
    sw.inventPredicate({ description: 'test', elements: [], spatialRelations: [] });
    sw.bridgeToReasoning([]);
    sw.validateBridge([], {});
    const stats = sw.getStats();
    assert.strictEqual(stats.inventCount, 1);
    assert.strictEqual(stats.bridgeCount, 1);
    assert.strictEqual(stats.validationCount, 1);
  });
});

describe('SkillWrapper - shutdown', () => {
  it('should reset counters on shutdown', () => {
    const sw = new SkillWrapper();
    sw.inventPredicate({ description: 'test', elements: [], spatialRelations: [] });
    sw.shutdown();
    assert.strictEqual(sw._inventCount, 0);
    assert.strictEqual(sw._bridgeCount, 0);
    assert.strictEqual(sw._validationCount, 0);
    assert.strictEqual(sw._predicateCache.size, 0);
    assert.strictEqual(sw._shutDown, true);
  });

  it('should prevent operations after shutdown', () => {
    const sw = new SkillWrapper();
    sw.shutdown();
    assert.throws(() => sw.inventPredicate({ description: 'test', elements: [], spatialRelations: [] }), /shut down/i);
  });
});
