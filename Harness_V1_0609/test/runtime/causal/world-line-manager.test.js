'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const WorldLineManager = require('../../../src/runtime/causal/world-line-manager');

describe('WorldLineManager - Constructor', () => {
  it('should create instance with default values', () => {
    const mgr = new WorldLineManager();
    assert.ok(mgr);
    assert.strictEqual(typeof mgr.createWorldLine, 'function');
    assert.strictEqual(typeof mgr.getWorldLine, 'function');
    assert.strictEqual(typeof mgr.listWorldLines, 'function');
    assert.strictEqual(typeof mgr.removeWorldLine, 'function');
    assert.strictEqual(typeof mgr.branchFrom, 'function');
    assert.strictEqual(typeof mgr.mergeWorldLines, 'function');
    assert.strictEqual(typeof mgr.getBranchTree, 'function');
    assert.strictEqual(typeof mgr.advanceStep, 'function');
    assert.strictEqual(typeof mgr.rollbackToStep, 'function');
    assert.strictEqual(typeof mgr.getStateAtStep, 'function');
    assert.strictEqual(typeof mgr.computeProbability, 'function');
    assert.strictEqual(typeof mgr.compareWorldLines, 'function');
    assert.strictEqual(typeof mgr.generateTimeline, 'function');
    assert.strictEqual(typeof mgr.isHealthy, 'function');
    assert.strictEqual(typeof mgr.getStats, 'function');
    assert.strictEqual(typeof mgr.shutdown, 'function');
    mgr.shutdown();
  });
});

describe('WorldLineManager - createWorldLine / getWorldLine / listWorldLines / removeWorldLine', () => {
  it('should create and retrieve a world line', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('alpha', { x: 1, y: 2 });
    assert.ok(wl.worldLineId);
    assert.ok(wl.worldLineId.startsWith('wl-'));
    assert.strictEqual(wl.name, 'alpha');
    assert.deepStrictEqual(wl.initialState, { x: 1, y: 2 });
    assert.strictEqual(wl.parentLineId, null);
    assert.strictEqual(wl.status, 'active');
    const retrieved = mgr.getWorldLine(wl.worldLineId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.worldLineId, wl.worldLineId);
    assert.strictEqual(retrieved.name, 'alpha');
    mgr.shutdown();
  });

  it('should emit world-line-created event', () => {
    const mgr = new WorldLineManager();
    let emitted = false;
    mgr.on('world-line-created', (e) => {
      emitted = true;
      assert.ok(e.worldLineId);
      assert.strictEqual(e.name, 'test');
    });
    mgr.createWorldLine('test', { a: 1 });
    assert.strictEqual(emitted, true);
    mgr.shutdown();
  });

  it('should list world lines filtered by status', () => {
    const mgr = new WorldLineManager();
    const _wl1 = mgr.createWorldLine('active1', { x: 1 });
    const _wl2 = mgr.createWorldLine('active2', { y: 2 });
    const active = mgr.listWorldLines('active');
    assert.strictEqual(active.length, 2);
    const merged = mgr.listWorldLines('merged');
    assert.strictEqual(merged.length, 0);
    mgr.shutdown();
  });

  it('should remove a world line', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('to-remove', { x: 1 });
    assert.ok(mgr.getWorldLine(wl.worldLineId));
    const removed = mgr.removeWorldLine(wl.worldLineId);
    assert.strictEqual(removed, true);
    assert.strictEqual(mgr.getWorldLine(wl.worldLineId), null);
    mgr.shutdown();
  });
});

describe('WorldLineManager - branchFrom', () => {
  it('should create branch from parent world line', () => {
    const mgr = new WorldLineManager();
    const parent = mgr.createWorldLine('main', { x: 10, y: 20 });
    const branch = mgr.branchFrom(parent.worldLineId, 'branch-a', { step: 0, action: 'decide', reason: 'alternative' });
    assert.ok(branch.worldLineId);
    assert.strictEqual(branch.name, 'branch-a');
    assert.strictEqual(branch.parentLineId, parent.worldLineId);
    assert.strictEqual(branch.depth, 1);
    const parentWl = mgr.getWorldLine(parent.worldLineId);
    assert.ok(parentWl.childrenIds.includes(branch.worldLineId));
    mgr.shutdown();
  });

  it('should inherit parent state at divergence point', () => {
    const mgr = new WorldLineManager();
    const parent = mgr.createWorldLine('main', { x: 10 });
    mgr.advanceStep(parent.worldLineId, { name: 'step1', effects: { x: 5 }, probability: 1 }, { success: true, actualEffects: { x: 15 }, confidence: 0.9 });
    const branch = mgr.branchFrom(parent.worldLineId, 'branch-b', { step: 0, action: 'step1', reason: 'alt' });
    assert.strictEqual(branch.currentState.x, 15);
    mgr.shutdown();
  });

  it('should emit world-line-branch-created event', () => {
    const mgr = new WorldLineManager();
    let emitted = false;
    mgr.on('world-line-branch-created', (e) => {
      emitted = true;
      assert.ok(e.sourceId);
      assert.ok(e.branchId);
      assert.strictEqual(e.branchName, 'alt-branch');
    });
    const parent = mgr.createWorldLine('main', { x: 1 });
    mgr.branchFrom(parent.worldLineId, 'alt-branch', { step: 0, action: 'a', reason: 'r' });
    assert.strictEqual(emitted, true);
    mgr.shutdown();
  });
});

describe('WorldLineManager - mergeWorldLines', () => {
  it('should merge world lines with union strategy', () => {
    const mgr = new WorldLineManager();
    const wl1 = mgr.createWorldLine('line1', { a: 1, b: 2 });
    const wl2 = mgr.createWorldLine('line2', { b: 3, c: 4 });
    const merged = mgr.mergeWorldLines(wl1.worldLineId, wl2.worldLineId, 'union');
    assert.strictEqual(merged.b, 3);
    assert.strictEqual(merged.c, 4);
    assert.strictEqual(merged.a, 1);
    mgr.shutdown();
  });

  it('should merge with latest-wins strategy', () => {
    const mgr = new WorldLineManager();
    const wl1 = mgr.createWorldLine('line1', { x: 10, shared: 'from1' });
    const wl2 = mgr.createWorldLine('line2', { y: 20, shared: 'from2' });
    const merged = mgr.mergeWorldLines(wl1.worldLineId, wl2.worldLineId, 'latest-wins');
    assert.strictEqual(merged.shared, 'from2');
    assert.strictEqual(merged.x, 10);
    assert.strictEqual(merged.y, 20);
    mgr.shutdown();
  });

  it('should emit world-lines-merged event', () => {
    const mgr = new WorldLineManager();
    let emitted = false;
    mgr.on('world-lines-merged', (e) => {
      emitted = true;
      assert.ok(e.sourceId);
      assert.ok(e.targetId);
      assert.strictEqual(e.strategy, 'union');
    });
    const wl1 = mgr.createWorldLine('s', { a: 1 });
    const wl2 = mgr.createWorldLine('t', { b: 2 });
    mgr.mergeWorldLines(wl1.worldLineId, wl2.worldLineId, 'union');
    assert.strictEqual(emitted, true);
    mgr.shutdown();
  });
});

describe('WorldLineManager - getBranchTree', () => {
  it('should return tree structure with root and children', () => {
    const mgr = new WorldLineManager();
    const root = mgr.createWorldLine('root', { x: 1 });
    const _child1 = mgr.branchFrom(root.worldLineId, 'child1', { step: 0, action: 'a', reason: 'r' });
    const _child2 = mgr.branchFrom(root.worldLineId, 'child2', { step: 0, action: 'b', reason: 'r' });
    const tree = mgr.getBranchTree(root.worldLineId);
    assert.ok(tree.root);
    assert.strictEqual(tree.root.worldLineId, root.worldLineId);
    assert.ok(Array.isArray(tree.children));
    assert.strictEqual(tree.children.length, 2);
    assert.strictEqual(tree.children[0].root.name, 'child1');
    assert.strictEqual(tree.children[1].root.name, 'child2');
    mgr.shutdown();
  });
});

describe('WorldLineManager - advanceStep / rollbackToStep / getStateAtStep', () => {
  it('should advance step and update state', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('test', { x: 10 });
    const state = mgr.advanceStep(wl.worldLineId, { name: 'add', effects: { x: 5 }, probability: 0.9 }, { success: true, actualEffects: { x: 15 }, confidence: 0.95 });
    assert.strictEqual(state.x, 15);
    const retrieved = mgr.getWorldLine(wl.worldLineId);
    assert.strictEqual(retrieved.currentState.x, 15);
    mgr.shutdown();
  });

  it('should emit step-advanced event', () => {
    const mgr = new WorldLineManager();
    let emitted = false;
    mgr.on('step-advanced', (e) => {
      emitted = true;
      assert.ok(e.worldLineId);
      assert.strictEqual(e.step, 0);
      assert.strictEqual(e.actionName, 'act');
    });
    const wl = mgr.createWorldLine('test', { x: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'act', effects: {}, probability: 1 }, { success: true, actualEffects: {}, confidence: 1 });
    assert.strictEqual(emitted, true);
    mgr.shutdown();
  });

  it('should rollback to previous step', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('test', { x: 10 });
    mgr.advanceStep(wl.worldLineId, { name: 'step0', effects: {}, probability: 1 }, { success: true, actualEffects: { x: 20 }, confidence: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'step1', effects: {}, probability: 1 }, { success: true, actualEffects: { x: 30 }, confidence: 1 });
    const state = mgr.rollbackToStep(wl.worldLineId, 0);
    assert.strictEqual(state.x, 20);
    const retrieved = mgr.getWorldLine(wl.worldLineId);
    assert.strictEqual(retrieved.currentState.x, 20);
    mgr.shutdown();
  });

  it('should get state at specific step', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('test', { x: 10 });
    mgr.advanceStep(wl.worldLineId, { name: 'step0', effects: {}, probability: 1 }, { success: true, actualEffects: { x: 20 }, confidence: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'step1', effects: {}, probability: 1 }, { success: true, actualEffects: { x: 30 }, confidence: 1 });
    const state0 = mgr.getStateAtStep(wl.worldLineId, 0);
    assert.strictEqual(state0.x, 20);
    const state1 = mgr.getStateAtStep(wl.worldLineId, 1);
    assert.strictEqual(state1.x, 30);
    mgr.shutdown();
  });
});

describe('WorldLineManager - computeProbability / compareWorldLines', () => {
  it('should compute probability as product of step probabilities', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('test', { x: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'a', effects: {}, probability: 0.8 }, { success: true, actualEffects: {}, confidence: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'b', effects: {}, probability: 0.9 }, { success: true, actualEffects: {}, confidence: 1 });
    const prob = mgr.computeProbability(wl.worldLineId);
    assert.ok(Math.abs(prob.probability - 0.72) < 1e-10);
    assert.strictEqual(prob.pathLength, 2);
    assert.ok(prob.confidenceInterval);
    assert.ok(prob.confidenceInterval.lower <= prob.probability);
    assert.ok(prob.confidenceInterval.upper >= prob.probability);
    mgr.shutdown();
  });

  it('should compare two world lines', () => {
    const mgr = new WorldLineManager();
    const wl1 = mgr.createWorldLine('line1', { x: 10, y: 5 });
    const wl2 = mgr.createWorldLine('line2', { x: 20, y: 5 });
    mgr.advanceStep(wl1.worldLineId, { name: 'a', effects: {}, probability: 0.9 }, { success: true, actualEffects: {}, confidence: 1 });
    mgr.advanceStep(wl2.worldLineId, { name: 'b', effects: {}, probability: 0.8 }, { success: true, actualEffects: {}, confidence: 1 });
    const comparison = mgr.compareWorldLines(wl1.worldLineId, wl2.worldLineId);
    assert.ok(comparison.variableDifferences);
    assert.ok(comparison.variableDifferences instanceof Map);
    assert.strictEqual(typeof comparison.probabilityRatio, 'number');
    mgr.shutdown();
  });
});

describe('WorldLineManager - generateTimeline', () => {
  it('should generate markdown timeline', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('timeline-test', { x: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'step1', effects: {}, probability: 0.9 }, { success: true, actualEffects: { x: 2 }, confidence: 0.95 });
    const timeline = mgr.generateTimeline(wl.worldLineId);
    assert.ok(typeof timeline === 'string');
    assert.ok(timeline.includes('# World Line Timeline: timeline-test'));
    assert.ok(timeline.includes('## Initial State'));
    assert.ok(timeline.includes('## Current State'));
    assert.ok(timeline.includes('## Steps'));
    assert.ok(timeline.includes('step1'));
    mgr.shutdown();
  });
});

describe('WorldLineManager - isHealthy / getStats / shutdown', () => {
  it('should be healthy with few world lines', () => {
    const mgr = new WorldLineManager();
    assert.strictEqual(mgr.isHealthy(), true);
    mgr.createWorldLine('test', { x: 1 });
    assert.strictEqual(mgr.isHealthy(), true);
    mgr.shutdown();
  });

  it('should return correct stats', () => {
    const mgr = new WorldLineManager();
    const wl = mgr.createWorldLine('test', { x: 1 });
    mgr.advanceStep(wl.worldLineId, { name: 'a', effects: {}, probability: 1 }, { success: true, actualEffects: {}, confidence: 1 });
    const stats = mgr.getStats();
    assert.strictEqual(stats.worldLinesTotal, 1);
    assert.strictEqual(stats.activeLines, 1);
    assert.strictEqual(stats.totalSteps, 1);
    assert.strictEqual(typeof stats.maxDepth, 'number');
    assert.strictEqual(typeof stats.avgBranchFactor, 'number');
    mgr.shutdown();
  });

  it('should prevent operations after shutdown', () => {
    const mgr = new WorldLineManager();
    mgr.shutdown();
    assert.strictEqual(mgr.isHealthy(), false);
    assert.throws(() => mgr.createWorldLine('test', { x: 1 }), /shut down/i);
    assert.throws(() => mgr.advanceStep('x', {}, {}), /shut down/i);
    assert.throws(() => mgr.removeWorldLine('x'), /shut down/i);
  });
});
