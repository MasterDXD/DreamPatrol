'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { uuid, shortId, timestampId, counterId, secureId, generateId, resetCounter } = require('../../src/utils/unique-id');

describe('UniqueId', () => {
  beforeEach(() => {
    resetCounter();
  });

  describe('uuid()', () => {
    it('should generate a valid UUID without prefix', () => {
      const id = uuid();
      assert.strictEqual(typeof id, 'string');
      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
    });

    it('should generate UUID with prefix', () => {
      const id = uuid('sess-');
      assert.ok(id.startsWith('sess-'));
      assert.ok(id.length > 'sess-'.length);
    });

    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(uuid());
      assert.strictEqual(ids.size, 100);
    });
  });

  describe('shortId()', () => {
    it('should generate short ID with default length', () => {
      const id = shortId();
      assert.strictEqual(typeof id, 'string');
      assert.strictEqual(id.length, 12);
    });

    it('should generate short ID with custom length', () => {
      const id = shortId('', 8);
      assert.strictEqual(id.length, 8);
    });

    it('should generate short ID with prefix', () => {
      const id = shortId('snap-', 12);
      assert.ok(id.startsWith('snap-'));
    });

    it('should generate unique short IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(shortId());
      assert.strictEqual(ids.size, 100);
    });
  });

  describe('timestampId()', () => {
    it('should generate timestamp-based ID without prefix', () => {
      const id = timestampId();
      assert.strictEqual(typeof id, 'string');
      assert.ok(id.includes('_'));
    });

    it('should generate timestamp-based ID with prefix', () => {
      const id = timestampId('prop-');
      assert.ok(id.startsWith('prop-'));
    });

    it('should contain base36 timestamp', () => {
      const before = Date.now();
      const id = timestampId();
      const after = Date.now();
      const tsPart = id.split('_')[0];
      const ts = parseInt(tsPart, 36);
      assert.ok(ts >= before && ts <= after);
    });

    it('should generate unique IDs even in rapid succession', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(timestampId());
      assert.strictEqual(ids.size, 100);
    });
  });

  describe('counterId()', () => {
    it('should generate sequential IDs with prefix', () => {
      const id1 = counterId('tq-');
      const id2 = counterId('tq-');
      assert.strictEqual(id1, 'tq-1');
      assert.strictEqual(id2, 'tq-2');
    });

    it('should maintain separate counters per scope', () => {
      const a1 = counterId('a-');
      const b1 = counterId('b-');
      const a2 = counterId('a-');
      assert.strictEqual(a1, 'a-1');
      assert.strictEqual(b1, 'b-1');
      assert.strictEqual(a2, 'a-2');
    });

    it('should generate ID without prefix', () => {
      const id = counterId();
      assert.strictEqual(id, '1');
    });

    it('should use scope parameter for counter isolation', () => {
      const id1 = counterId('', 'myscope');
      const id2 = counterId('', 'myscope');
      const id3 = counterId('', 'otherscope');
      assert.strictEqual(id1, '1');
      assert.strictEqual(id2, '2');
      assert.strictEqual(id3, '1');
    });
  });

  describe('secureId()', () => {
    it('should generate hex string with default bytes', () => {
      const id = secureId();
      assert.strictEqual(typeof id, 'string');
      assert.strictEqual(id.length, 16);
      assert.ok(/^[0-9a-f]+$/.test(id));
    });

    it('should generate hex string with custom bytes', () => {
      const id = secureId('', 4);
      assert.strictEqual(id.length, 8);
    });

    it('should generate ID with prefix', () => {
      const id = secureId('approval-', 12);
      assert.ok(id.startsWith('approval-'));
    });

    it('should generate unique secure IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(secureId());
      assert.strictEqual(ids.size, 100);
    });
  });

  describe('generateId()', () => {
    it('should maintain backward compatibility with prefix', () => {
      const id = generateId('goal-');
      assert.ok(id.startsWith('goal-'));
    });

    it('should maintain backward compatibility without prefix', () => {
      const id = generateId();
      assert.strictEqual(typeof id, 'string');
      assert.ok(id.includes('_'));
    });
  });

  describe('resetCounter()', () => {
    it('should reset specific scope counter', () => {
      counterId('test-');
      counterId('test-');
      resetCounter('test-');
      const id = counterId('test-');
      assert.strictEqual(id, 'test-1');
    });

    it('should reset all counters when no scope provided', () => {
      counterId('a-');
      counterId('b-');
      resetCounter();
      assert.strictEqual(counterId('a-'), 'a-1');
      assert.strictEqual(counterId('b-'), 'b-1');
    });
  });
});
