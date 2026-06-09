'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SkillTreeDAG } = require(path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'skill', 'skill-tree-dag'));

describe('SkillTreeDAG', () => {
  it('should add nodes and edges', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a', { category: 'core' });
    dag.addNode('b', { category: 'extended' });
    dag.addDependency('b', 'a');
    assert.equal(dag.getNodeCount(), 2);
    assert.equal(dag.getEdgeCount(), 1);
    assert.deepEqual(dag.getDependencies('b'), ['a']);
  });

  it('should prevent cycles', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'b');
    const events = [];
    dag.on('cycle-detected', (e) => events.push(e));
    assert.equal(dag.addDependency('a', 'c'), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].skillId, 'a');
    assert.equal(events[0].dependsOnId, 'c');
  });

  it('should emit cycle-detected event in getExecutionOrder', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag._edges.set('a', ['b']);
    dag._edges.set('b', ['a']);
    const events = [];
    dag.on('cycle-detected', (e) => events.push(e));
    const result = dag.getExecutionOrder();
    assert.ok(events.length >= 1);
    assert.equal(events[0].context, 'execution-order');
    assert.ok(result.hasCycle);
    assert.ok(result.cyclicNodes.length >= 1);
  });

  it('should compute execution order', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'b');
    const result = dag.getExecutionOrder();
    const order = result.order;
    assert.ok(order.indexOf('a') < order.indexOf('b'));
    assert.ok(order.indexOf('b') < order.indexOf('c'));
    assert.equal(result.hasCycle, false);
    assert.deepEqual(result.cyclicNodes, []);
  });

  it('should find roots and leaves', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('root');
    dag.addNode('mid');
    dag.addNode('leaf');
    dag.addDependency('mid', 'root');
    dag.addDependency('leaf', 'mid');
    assert.deepEqual(dag.getRoots(), ['root']);
    assert.deepEqual(dag.getLeaves(), ['leaf']);
  });

  it('should evolve from seed', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('seed-skill', { seed: true, category: 'seed' });
    const evolved = dag.evolveFromSeed('seed-skill', 'evolved-skill', { category: 'derived' });
    assert.ok(evolved);
    assert.equal(evolved.seed, false);
    assert.equal(evolved.level, 1);
    assert.deepEqual(dag.getDependencies('evolved-skill'), ['seed-skill']);
  });

  it('should get subtree', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'b');
    const subtree = dag.getSubtree('a');
    assert.ok(subtree.includes('a'));
    assert.ok(subtree.includes('b'));
    assert.ok(subtree.includes('c'));
  });

  it('should remove nodes and clean edges', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addDependency('b', 'a');
    dag.removeNode('a');
    assert.equal(dag.getNodeCount(), 1);
    assert.equal(dag.getDependencies('b').length, 0);
  });

  it('should compute depth', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'b');
    assert.equal(dag.getDepth(), 2);
  });

  it('should enforce maxNodes limit', () => {
    const dag = new SkillTreeDAG({ maxNodes: 3 });
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    assert.equal(dag.addNode('d'), false);
    assert.equal(dag.getNodeCount(), 3);
  });

  it('should enforce maxChildren limit on dependencies', () => {
    const dag = new SkillTreeDAG({ maxChildren: 2 });
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addNode('d');
    assert.equal(dag.addDependency('a', 'b'), true);
    assert.equal(dag.addDependency('a', 'c'), true);
    assert.equal(dag.addDependency('a', 'd'), false);
  });
});

describe('SkillTreeDAG - Events and Regression', () => {
  it('should emit node-added event', () => {
    const dag = new SkillTreeDAG();
    const events = [];
    dag.on('node-added', (e) => events.push(e));
    dag.addNode('a');
    assert.equal(events.length, 1);
    assert.equal(events[0].skillId, 'a');
  });

  it('regression: getExecutionOrder returns structured result with cyclic nodes', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('x');
    dag.addNode('y');
    dag.addNode('z');
    dag._edges.set('x', ['y']);
    dag._edges.set('y', ['x']);
    const incompleteEvents = [];
    dag.on('execution-order-incomplete', (e) => incompleteEvents.push(e));
    const result = dag.getExecutionOrder();
    assert.equal(typeof result.hasCycle, 'boolean');
    assert.ok(Array.isArray(result.order));
    assert.ok(Array.isArray(result.cyclicNodes));
    assert.equal(result.hasCycle, true);
    assert.ok(result.cyclicNodes.length >= 1);
    assert.ok(incompleteEvents.length >= 1);
    assert.ok(incompleteEvents[0].cyclicNodes.length >= 1);
  });

  it('regression: addDependency propagates level transitively', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a', { level: 0 });
    dag.addNode('b', { level: 0 });
    dag.addNode('c', { level: 0 });
    dag.addDependency('b', 'a');
    assert.equal(dag.getNode('b').level, 1);
    assert.equal(dag.getNode('c').level, 0);
    dag.addDependency('c', 'b');
    assert.equal(dag.getNode('c').level, 2);
    dag.addNode('d', { level: 0 });
    dag.addDependency('d', 'a');
    assert.equal(dag.getNode('d').level, 1);
    dag.addNode('e', { level: 0 });
    dag.addDependency('e', 'd');
    assert.equal(dag.getNode('e').level, 2);
  });
});

describe('SkillTreeDAG - computeLearningPath', () => {
  it('should compute learning path for linear chain', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'b');
    const result = dag.computeLearningPath('c', []);
    assert.deepEqual(result.path, ['a', 'b', 'c']);
    assert.ok(result.missingPrerequisites.includes('a'));
    assert.ok(result.missingPrerequisites.includes('b'));
  });

  it('should skip already mastered skills', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'b');
    const result = dag.computeLearningPath('c', ['a']);
    assert.ok(!result.path.includes('a'));
    assert.ok(result.path.includes('b'));
    assert.ok(result.path.includes('c'));
    assert.ok(!result.missingPrerequisites.includes('a'));
  });

  it('should return empty path for unknown skill', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    const result = dag.computeLearningPath('nonexistent', []);
    assert.deepEqual(result.path, []);
    assert.deepEqual(result.missingPrerequisites, []);
  });

  it('should handle diamond dependency', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    dag.addNode('b');
    dag.addNode('c');
    dag.addNode('d');
    dag.addDependency('b', 'a');
    dag.addDependency('c', 'a');
    dag.addDependency('d', 'b');
    dag.addDependency('d', 'c');
    const result = dag.computeLearningPath('d', []);
    assert.ok(result.path.indexOf('a') < result.path.indexOf('b'));
    assert.ok(result.path.indexOf('a') < result.path.indexOf('c'));
    assert.ok(result.path.indexOf('b') < result.path.indexOf('d'));
    assert.ok(result.path.indexOf('c') < result.path.indexOf('d'));
  });

  it('should return path with only target when no prerequisites', () => {
    const dag = new SkillTreeDAG();
    dag.addNode('a');
    const result = dag.computeLearningPath('a', []);
    assert.deepEqual(result.path, ['a']);
    assert.deepEqual(result.missingPrerequisites, []);
  });
});
