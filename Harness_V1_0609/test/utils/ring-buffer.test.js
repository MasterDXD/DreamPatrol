'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const RingBuffer = require('../../src/utils/ring-buffer');

describe('RingBuffer', () => {
  it('should push and shift items in FIFO order', () => {
    const rb = new RingBuffer(5);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    assert.strictEqual(rb.size, 3);
    assert.strictEqual(rb.shift(), 'a');
    assert.strictEqual(rb.shift(), 'b');
    assert.strictEqual(rb.shift(), 'c');
    assert.strictEqual(rb.size, 0);
  });

  it('should evict oldest when capacity exceeded', () => {
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    assert.strictEqual(rb.size, 3);
    assert.strictEqual(rb.shift(), 2);
    assert.strictEqual(rb.shift(), 3);
    assert.strictEqual(rb.shift(), 4);
  });

  it('should return undefined when shifting empty buffer', () => {
    const rb = new RingBuffer(5);
    assert.strictEqual(rb.shift(), undefined);
  });

  it('should peek at first element without removing', () => {
    const rb = new RingBuffer(5);
    rb.push(10);
    rb.push(20);
    assert.strictEqual(rb.peek(), 10);
    assert.strictEqual(rb.size, 2);
  });

  it('should peekLast at last element without removing', () => {
    const rb = new RingBuffer(5);
    rb.push(10);
    rb.push(20);
    assert.strictEqual(rb.peekLast(), 20);
    assert.strictEqual(rb.size, 2);
  });

  it('should clear all elements', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.clear();
    assert.strictEqual(rb.size, 0);
    assert.strictEqual(rb.shift(), undefined);
  });

  it('should convert to array in order', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    assert.deepStrictEqual(rb.toArray(), [1, 2, 3]);
  });

  it('should handle wraparound in toArray', () => {
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    rb.push(5);
    assert.deepStrictEqual(rb.toArray(), [3, 4, 5]);
  });

  it('should iterate with forEach', () => {
    const rb = new RingBuffer(5);
    rb.push(10);
    rb.push(20);
    rb.push(30);
    const items = [];
    rb.forEach(item => items.push(item));
    assert.deepStrictEqual(items, [10, 20, 30]);
  });

  it('should iterate with for-of', () => {
    const rb = new RingBuffer(5);
    rb.push('x');
    rb.push('y');
    const items = [];
    for (const item of rb) items.push(item);
    assert.deepStrictEqual(items, ['x', 'y']);
  });

  it('should filter items', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    const even = rb.filter(x => x % 2 === 0);
    assert.deepStrictEqual(even, [2, 4]);
  });

  it('should map items', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    const doubled = rb.map(x => x * 2);
    assert.deepStrictEqual(doubled, [2, 4, 6]);
  });

  it('should support includes', () => {
    const rb = new RingBuffer(5);
    rb.push(10);
    rb.push(20);
    assert.strictEqual(rb.includes(10), true);
    assert.strictEqual(rb.includes(30), false);
  });

  it('should support get by index', () => {
    const rb = new RingBuffer(5);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    assert.strictEqual(rb.get(0), 'a');
    assert.strictEqual(rb.get(1), 'b');
    assert.strictEqual(rb.get(2), 'c');
    assert.strictEqual(rb.get(3), undefined);
    assert.strictEqual(rb.get(-1), undefined);
  });

  it('should support slice', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    assert.deepStrictEqual(rb.slice(1, 3), [2, 3]);
  });

  it('should support reduce', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    assert.strictEqual(rb.reduce((acc, x) => acc + x, 0), 6);
  });

  it('should support reduce without initial value', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    assert.strictEqual(rb.reduce((acc, x) => acc + x), 6);
  });

  it('should support every', () => {
    const rb = new RingBuffer(5);
    rb.push(2);
    rb.push(4);
    rb.push(6);
    assert.strictEqual(rb.every(x => x % 2 === 0), true);
    assert.strictEqual(rb.every(x => x > 3), false);
  });

  it('should support some', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    assert.strictEqual(rb.some(x => x > 2), true);
    assert.strictEqual(rb.some(x => x > 10), false);
  });

  it('should handle capacity of 1', () => {
    const rb = new RingBuffer(1);
    rb.push('only');
    assert.strictEqual(rb.size, 1);
    assert.strictEqual(rb.peek(), 'only');
    rb.push('new');
    assert.strictEqual(rb.size, 1);
    assert.strictEqual(rb.peek(), 'new');
  });

  it('should handle many push/shift cycles', () => {
    const rb = new RingBuffer(10);
    for (let i = 0; i < 100; i++) {
      rb.push(i);
    }
    assert.strictEqual(rb.size, 10);
    assert.strictEqual(rb.peek(), 90);
    assert.strictEqual(rb.peekLast(), 99);
  });

  it('should throw on invalid capacity', () => {
    assert.throws(() => new RingBuffer(0), /capacity must be >= 1/);
    assert.throws(() => new RingBuffer(-1), /capacity must be >= 1/);
  });
});
