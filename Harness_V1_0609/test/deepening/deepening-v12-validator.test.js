'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const DeepeningValidator = require('../../src/runtime/deepening/deepening-validator');

describe('DeepeningValidator - Schema and Validation', function() {
  let validator;

  beforeEach(function() {
    validator = new DeepeningValidator();
  });

  it('should create validator with default level', function() {
    assert.strictEqual(validator.getStats().level, 'moderate');
  });

  it('should register schemas', function() {
    validator.registerSchema('user', { required: ['name'] });
    assert.strictEqual(validator.getStats().schemasRegistered, 1);
  });

  it('should throw on invalid registerSchema args', function() {
    assert.throws(function() { validator.registerSchema('', {}); }, /Name and schema are required/);
    assert.throws(function() { validator.registerSchema('test', null); }, /Name and schema are required/);
  });

  it('should unregister schemas', function() {
    validator.registerSchema('user', { required: ['name'] });
    validator.unregisterSchema('user');
    assert.strictEqual(validator.getStats().schemasRegistered, 0);
  });

  it('should validate required fields', function() {
    validator.registerSchema('user', { required: ['name', 'email'] });
    const result = validator.validate({ name: 'test' }, 'user');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function(e) { return e.path === 'email'; }));
  });

  it('should pass valid data', function() {
    validator.registerSchema('user', { required: ['name'] });
    const result = validator.validate({ name: 'test' }, 'user');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should validate types', function() {
    validator.registerSchema('item', {
      properties: {
        count: { type: 'number' },
        label: { type: 'string' },
      },
    });
    const result = validator.validate({ count: 'not a number', label: 123 }, 'item');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function(e) { return e.path === 'count'; }));
    assert.ok(result.errors.some(function(e) { return e.path === 'label'; }));
  });

  it('should validate enum values', function() {
    validator.registerSchema('status', {
      properties: {
        state: { enum: ['active', 'inactive', 'pending'] },
      },
    });
    const result = validator.validate({ state: 'unknown' }, 'status');
    assert.strictEqual(result.valid, false);
  });

  it('should validate string minLength', function() {
    validator.registerSchema('name', {
      properties: {
        value: { type: 'string', minLength: 3 },
      },
    });
    const result = validator.validate({ value: 'ab' }, 'name');
    assert.strictEqual(result.valid, false);
  });

  it('should validate string maxLength', function() {
    validator.registerSchema('name', {
      properties: {
        value: { type: 'string', maxLength: 5 },
      },
    });
    const result = validator.validate({ value: 'abcdef' }, 'name');
    assert.strictEqual(result.valid, false);
  });

  it('should validate number minimum in strict mode', function() {
    const v = new DeepeningValidator({ level: 'strict' });
    v.registerSchema('age', {
      properties: { value: { type: 'number', minimum: 0 } },
    });
    const result = v.validate({ value: -1 }, 'age');
    assert.strictEqual(result.valid, false);
  });

  it('should warn on number minimum in moderate mode', function() {
    validator.registerSchema('age', {
      properties: { value: { type: 'number', minimum: 0 } },
    });
    const result = validator.validate({ value: -1 }, 'age');
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.length > 0);
  });

  it('should validate number maximum in strict mode', function() {
    const v = new DeepeningValidator({ level: 'strict' });
    v.registerSchema('score', {
      properties: { value: { type: 'number', maximum: 100 } },
    });
    const result = v.validate({ value: 150 }, 'score');
    assert.strictEqual(result.valid, false);
  });

  it('should validate pattern', function() {
    validator.registerSchema('email', {
      properties: {
        address: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' },
      },
    });
    const bad = validator.validate({ address: 'not-email' }, 'email');
    assert.strictEqual(bad.valid, false);
    const good = validator.validate({ address: 'test@example.com' }, 'email');
    assert.strictEqual(good.valid, true);
  });

  it('should validate custom function', function() {
    validator.registerSchema('custom', {
      properties: {
        value: {
          custom: function(v) { return v > 10 ? true : 'Must be greater than 10'; },
        },
      },
    });
    const bad = validator.validate({ value: 5 }, 'custom');
    assert.strictEqual(bad.valid, false);
    const good = validator.validate({ value: 15 }, 'custom');
    assert.strictEqual(good.valid, true);
  });

  it('should handle custom function that throws', function() {
    validator.registerSchema('throwing', {
      properties: {
        value: { custom: function() { throw new Error('boom'); } },
      },
    });
    const result = validator.validate({ value: 1 }, 'throwing');
    assert.strictEqual(result.valid, false);
  });

  it('should reject additional properties in strict mode', function() {
    const v = new DeepeningValidator({ level: 'strict' });
    v.registerSchema('strict', {
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    const result = v.validate({ name: 'test', extra: 'field' }, 'strict');
    assert.strictEqual(result.valid, false);
  });

  it('should warn on additional properties in moderate mode', function() {
    validator.registerSchema('moderate', {
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    const result = validator.validate({ name: 'test', extra: 'field' }, 'moderate');
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.some(function(w) { return w.path === 'extra'; }));
  });

  it('should return error for unknown schema', function() {
    const result = validator.validate({}, 'unknown');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors[0].message.indexOf('Schema not found') >= 0);
  });

  it('should validate with inline schema', function() {
    const result = validator.validateWithSchema(
      { name: 'test' },
      { required: ['name'] },
    );
    assert.strictEqual(result.valid, true);
  });
});

describe('DeepeningValidator - History and Stats', function() {
  let validator;

  beforeEach(function() {
    validator = new DeepeningValidator();
  });

  it('should record validation history', function() {
    validator.registerSchema('test', { required: ['name'] });
    validator.validate({ name: 'ok' }, 'test');
    validator.validate({}, 'test');
    assert.strictEqual(validator.getHistory().length, 2);
  });

  it('should limit history size', function() {
    const v = new DeepeningValidator({ historySize: 3 });
    v.registerSchema('test', { required: ['name'] });
    for (let i = 0; i < 5; i++) {
      v.validate({ name: 'ok' }, 'test');
    }
    assert.strictEqual(v.getHistory().length, 3);
  });

  it('should get history with limit', function() {
    validator.registerSchema('test', { required: ['name'] });
    for (let i = 0; i < 5; i++) {
      validator.validate({ name: 'ok' }, 'test');
    }
    assert.strictEqual(validator.getHistory(2).length, 2);
  });

  it('should emit validation event', function() {
    validator.registerSchema('test', { required: ['name'] });
    let eventFired = false;
    let eventObj = null;
    validator.on('validation', function(e) {
      eventFired = true;
      eventObj = e;
    });
    validator.validate({ name: 'ok' }, 'test');
    assert.ok(eventFired);
    assert.strictEqual(eventObj.schema, 'test');
    assert.strictEqual(eventObj.valid, true);
  });

  it('should get schema by name', function() {
    const schema = { required: ['name'] };
    validator.registerSchema('user', schema);
    assert.deepStrictEqual(validator.getSchema('user'), schema);
  });

  it('should return null for unknown schema', function() {
    assert.strictEqual(validator.getSchema('unknown'), null);
  });

  it('should get schema names', function() {
    validator.registerSchema('a', {});
    validator.registerSchema('b', {});
    assert.ok(validator.getSchemas().indexOf('a') >= 0);
    assert.ok(validator.getSchemas().indexOf('b') >= 0);
  });

  it('should set validation level', function() {
    validator.setLevel('strict');
    assert.strictEqual(validator.getStats().level, 'strict');
  });

  it('should throw on invalid level', function() {
    assert.throws(function() { validator.setLevel('invalid'); }, /Invalid level/);
  });

  it('should compute stats correctly', function() {
    validator.registerSchema('test', { required: ['name'] });
    validator.validate({ name: 'ok' }, 'test');
    validator.validate({}, 'test');
    const stats = validator.getStats();
    assert.strictEqual(stats.totalValidations, 2);
    assert.strictEqual(stats.validCount, 1);
    assert.strictEqual(stats.invalidCount, 1);
  });

  it('should shutdown cleanly', function() {
    validator.shutdown();
    assert.strictEqual(validator.isHealthy(), false);
  });

  it('should expose VALIDATION_LEVELS', function() {
    assert.ok(DeepeningValidator.VALIDATION_LEVELS.STRICT);
    assert.ok(DeepeningValidator.VALIDATION_LEVELS.MODERATE);
    assert.ok(DeepeningValidator.VALIDATION_LEVELS.PERMISSIVE);
  });
});

describe('DeepeningValidator - ReDoS protection regression', function() {
  let validator;

  beforeEach(function() {
    validator = new DeepeningValidator();
  });

  it('should reject patterns longer than 200 characters', function() {
    const longPattern = 'a'.repeat(201);
    validator.registerSchema('long', {
      properties: {
        value: { type: 'string', pattern: longPattern },
      },
    });
    const result = validator.validate({ value: 'test' }, 'long');
    assert.strictEqual(result.valid, true);
  });

  it('should reject patterns with dangerous quantifier nesting (a+)+', function() {
    validator.registerSchema('redos1', {
      properties: {
        value: { type: 'string', pattern: '(a+)+' },
      },
    });
    const result = validator.validate({ value: 'bbbb' }, 'redos1');
    assert.strictEqual(result.valid, true);
  });

  it('should reject patterns with dangerous quantifier nesting (a*)+', function() {
    validator.registerSchema('redos2', {
      properties: {
        value: { type: 'string', pattern: '(a*)+' },
      },
    });
    const result = validator.validate({ value: 'bbbb' }, 'redos2');
    assert.strictEqual(result.valid, true);
  });

  it('should reject patterns with dangerous quantifier nesting (a+)*', function() {
    validator.registerSchema('redos3', {
      properties: {
        value: { type: 'string', pattern: '(a+)*' },
      },
    });
    const result = validator.validate({ value: 'bbbb' }, 'redos3');
    assert.strictEqual(result.valid, true);
  });

  it('should still allow valid patterns after ReDoS protection', function() {
    validator.registerSchema('valid', {
      properties: {
        email: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' },
      },
    });
    const bad = validator.validate({ email: 'not-email' }, 'valid');
    assert.strictEqual(bad.valid, false);
    const good = validator.validate({ email: 'test@example.com' }, 'valid');
    assert.strictEqual(good.valid, true);
  });

  it('should allow simple quantifier patterns that are not dangerous', function() {
    validator.registerSchema('simple', {
      properties: {
        value: { type: 'string', pattern: '^a+b$' },
      },
    });
    const bad = validator.validate({ value: 'b' }, 'simple');
    assert.strictEqual(bad.valid, false);
    const good = validator.validate({ value: 'aaab' }, 'simple');
    assert.strictEqual(good.valid, true);
  });

  it('should reject pattern at exactly 201 characters', function() {
    const pattern201 = 'a'.repeat(201);
    validator.registerSchema('exact201', {
      properties: {
        value: { type: 'string', pattern: pattern201 },
      },
    });
    const result = validator.validate({ value: 'test' }, 'exact201');
    assert.strictEqual(result.valid, true);
  });

  it('should allow pattern at exactly 200 characters', function() {
    const pattern200 = '^test' + 'a'.repeat(195);
    assert.strictEqual(pattern200.length, 200);
    validator.registerSchema('exact200', {
      properties: {
        value: { type: 'string', pattern: pattern200 },
      },
    });
    const result = validator.validate({ value: 'test' + 'a'.repeat(195) }, 'exact200');
    assert.strictEqual(result.valid, true);
  });
});
