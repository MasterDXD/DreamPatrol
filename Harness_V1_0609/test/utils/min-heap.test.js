'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MinHeap = require('../../src/utils/min-heap');

describe('MinHeap', () => {
  it('should push and pop items in priority order', () => {
    const heap = new MinHeap((a, b) => a.priority - b.priority);
    heap.push({ id: 'c', priority: 3 });
    heap.push({ id: 'a', priority: 1 });
    heap.push({ id: 'b', priority: 2 });

    assert.strictEqual(heap.size, 3);
    assert.strictEqual(heap.pop().id, 'a');
    assert.strictEqual(heap.pop().id, 'b');
    assert.strictEqual(heap.pop().id, 'c');
    assert.strictEqual(heap.size, 0);
  });

  it('should return undefined when popping from empty heap', () => {
    const heap = new MinHeap();
    assert.strictEqual(heap.pop(), undefined);
  });

  it('should peek at the minimum without removing it', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(5);
    heap.push(2);
    heap.push(8);

    assert.strictEqual(heap.peek(), 2);
    assert.strictEqual(heap.size, 3);
  });

  it('should return undefined when peeking at empty heap', () => {
    const heap = new MinHeap();
    assert.strictEqual(heap.peek(), undefined);
  });

  it('should handle single element', () => {
    const heap = new MinHeap();
    heap.push(42);
    assert.strictEqual(heap.peek(), 42);
    assert.strictEqual(heap.pop(), 42);
    assert.strictEqual(heap.size, 0);
  });

  it('should clear all elements', () => {
    const heap = new MinHeap();
    heap.push(1);
    heap.push(2);
    heap.push(3);
    heap.clear();
    assert.strictEqual(heap.size, 0);
    assert.strictEqual(heap.pop(), undefined);
  });

  it('should return a copy via toArray', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(3);
    heap.push(1);
    heap.push(2);
    const arr = heap.toArray();
    assert.strictEqual(arr.length, 3);
    assert.strictEqual(heap.size, 3);
  });

  it('should handle equal priorities', () => {
    const heap = new MinHeap((a, b) => a.p - b.p);
    heap.push({ id: 1, p: 1 });
    heap.push({ id: 2, p: 1 });
    heap.push({ id: 3, p: 1 });
    const first = heap.pop();
    assert.strictEqual(first.p, 1);
    assert.strictEqual(heap.size, 2);
  });

  it('should handle many elements efficiently', () => {
    const heap = new MinHeap((a, b) => a - b);
    const count = 1000;
    for (let i = count; i > 0; i--) {
      heap.push(i);
    }
    assert.strictEqual(heap.size, count);
    for (let i = 1; i <= count; i++) {
      assert.strictEqual(heap.pop(), i);
    }
    assert.strictEqual(heap.size, 0);
  });

  it('should use default numeric comparator when none provided', () => {
    const heap = new MinHeap();
    heap.push(10);
    heap.push(5);
    heap.push(20);
    assert.strictEqual(heap.pop(), 5);
    assert.strictEqual(heap.pop(), 10);
    assert.strictEqual(heap.pop(), 20);
  });
});
