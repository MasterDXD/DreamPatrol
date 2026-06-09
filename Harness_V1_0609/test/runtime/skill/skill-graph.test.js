'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SkillGraphModule = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-graph'));
const SkillGraph = SkillGraphModule.SkillGraph || SkillGraphModule;

describe('SkillGraph - Constructor', () => {
  it('should create instance with default config', () => {
    const graph = new SkillGraph();
    assert.ok(graph);
    assert.strictEqual(graph._config.maxNodes, 200);
    assert.strictEqual(graph._config.maxEdges, 1000);
    assert.strictEqual(graph._config.semanticMatchThreshold, 0.5);
  });

  it('should merge custom config with defaults', () => {
    const graph = new SkillGraph({ maxNodes: 50 });
    assert.strictEqual(graph._config.maxNodes, 50);
    assert.strictEqual(graph._config.maxEdges, 1000);
  });

  it('should initialize empty data structures', () => {
    const graph = new SkillGraph();
    assert.strictEqual(graph._nodes.size, 0);
    assert.strictEqual(graph._edges.size, 0);
    assert.strictEqual(graph._adjacency.size, 0);
    assert.strictEqual(graph._reverseAdjacency.size, 0);
    assert.strictEqual(graph._semanticGroups.size, 0);
  });

  it('should expose DEFAULT_CONFIG and EDGE_DEFAULT_WEIGHTS', () => {
    assert.ok(SkillGraphModule.DEFAULT_CONFIG);
    assert.ok(SkillGraphModule.EDGE_DEFAULT_WEIGHTS);
    assert.strictEqual(SkillGraphModule.EDGE_DEFAULT_WEIGHTS.dependency, 1.0);
    assert.strictEqual(SkillGraphModule.EDGE_DEFAULT_WEIGHTS.semantic, 0.5);
  });
});

describe('SkillGraph - addNode', () => {
  it('should add a node with metadata', () => {
    const graph = new SkillGraph();
    graph.addNode('skill-a', { phase: 'dev', priority: 5 });
    assert.strictEqual(graph._nodes.size, 1);
    const node = graph._nodes.get('skill-a');
    assert.strictEqual(node.skillId, 'skill-a');
    assert.strictEqual(node.phase, 'dev');
    assert.strictEqual(node.priority, 5);
  });

  it('should return this for chaining', () => {
    const graph = new SkillGraph();
    const result = graph.addNode('skill-a', {});
    assert.strictEqual(result, graph);
  });

  it('should throw for empty skillId', () => {
    const graph = new SkillGraph();
    assert.throws(() => graph.addNode('', {}), /non-empty string/);
  });

  it('should throw for non-string skillId', () => {
    const graph = new SkillGraph();
    assert.throws(() => graph.addNode(123, {}), /non-empty string/);
  });

  it('should throw when maxNodes limit reached', () => {
    const graph = new SkillGraph({ maxNodes: 1 });
    graph.addNode('skill-a', {});
    assert.throws(() => graph.addNode('skill-b', {}), /maxNodes/);
  });

  it('should register semantic group', () => {
    const graph = new SkillGraph();
    graph.addNode('skill-a', { semantic_group: 'tdd' });
    assert.strictEqual(graph._semanticGroups.has('tdd'), true);
    assert.strictEqual(graph._semanticGroups.get('tdd').has('skill-a'), true);
  });

  it('should emit node-added event', () => {
    const graph = new SkillGraph();
    let emitted = false;
    graph.on('node-added', () => { emitted = true; });
    graph.addNode('skill-a', {});
    assert.strictEqual(emitted, true);
  });
});

describe('SkillGraph - addEdge', () => {
  it('should add an edge between existing nodes', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    assert.strictEqual(graph._edges.size, 1);
    const edge = graph._edges.get('a→b');
    assert.strictEqual(edge.edgeType, 'dependency');
    assert.strictEqual(edge.weight, 1.0);
  });

  it('should clamp weight between 0 and 1', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency', 2.0);
    assert.strictEqual(graph._edges.get('a→b').weight, 1);
  });

  it('should throw for non-existent source node', () => {
    const graph = new SkillGraph();
    graph.addNode('b', {});
    assert.throws(() => graph.addEdge('a', 'b', 'dependency'), /Source node not found/);
  });

  it('should throw for invalid edge type', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    assert.throws(() => graph.addEdge('a', 'b', 'invalid'), /Invalid edgeType/);
  });

  it('should throw when maxEdges limit reached', () => {
    const graph = new SkillGraph({ maxEdges: 1 });
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addNode('c', {});
    graph.addEdge('a', 'b', 'dependency');
    assert.throws(() => graph.addEdge('b', 'c', 'dependency'), /maxEdges/);
  });
});

describe('SkillGraph - buildFromSkills', () => {
  it('should build graph from skill array', () => {
    const graph = new SkillGraph();
    const skills = [
      { skill_id: 'brainstorming', phase: 'req', priority: 5, depends_on: [], blocks: ['requirement-analysis'] },
      { skill_id: 'requirement-analysis', phase: 'req', priority: 4, depends_on: ['brainstorming'], blocks: [] },
    ];
    graph.buildFromSkills(skills);
    assert.strictEqual(graph._nodes.size, 2);
    assert.ok(graph._edges.size >= 1);
  });

  it('should throw for non-array input', () => {
    const graph = new SkillGraph();
    assert.throws(() => graph.buildFromSkills('not-array'), /array/);
  });

  it('should build semantic edges for same group', () => {
    const graph = new SkillGraph();
    const skills = [
      { skill_id: 'tdd-1', semantic_group: 'tdd' },
      { skill_id: 'tdd-2', semantic_group: 'tdd' },
    ];
    graph.buildFromSkills(skills);
    assert.ok(graph._edges.has('tdd-1→tdd-2'));
    assert.ok(graph._edges.has('tdd-2→tdd-1'));
  });
});

describe('SkillGraph - getDependencies / getDependents', () => {
  it('should return dependencies for a node', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    const deps = graph.getDependencies('b');
    assert.deepStrictEqual(deps, ['a']);
  });

  it('should return empty array for unknown node', () => {
    const graph = new SkillGraph();
    assert.deepStrictEqual(graph.getDependencies('unknown'), []);
  });

  it('should return dependents for a node', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    const dependents = graph.getDependents('a');
    assert.deepStrictEqual(dependents, ['b']);
  });
});

describe('SkillGraph - getExecutionOrder', () => {
  it('should return topologically sorted order', () => {
    const graph = new SkillGraph();
    graph.addNode('a', { priority: 1 });
    graph.addNode('b', { priority: 1 });
    graph.addNode('c', { priority: 1 });
    graph.addEdge('a', 'b', 'dependency');
    graph.addEdge('b', 'c', 'dependency');
    const order = graph.getExecutionOrder(['a', 'b', 'c']);
    assert.strictEqual(order[0], 'a');
    assert.ok(order.indexOf('b') < order.indexOf('c'));
  });

  it('should return empty array for empty input', () => {
    const graph = new SkillGraph();
    assert.deepStrictEqual(graph.getExecutionOrder([]), []);
  });
});

describe('SkillGraph - getShortestPath', () => {
  it('should find shortest path between nodes', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addNode('c', {});
    graph.addEdge('a', 'b', 'dependency');
    graph.addEdge('b', 'c', 'dependency');
    const pathResult = graph.getShortestPath('a', 'c');
    assert.deepStrictEqual(pathResult, ['a', 'b', 'c']);
  });

  it('should return null for unreachable nodes', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    const pathResult = graph.getShortestPath('a', 'b');
    assert.strictEqual(pathResult, null);
  });

  it('should return single element for same node', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    assert.deepStrictEqual(graph.getShortestPath('a', 'a'), ['a']);
  });
});

describe('SkillGraph - detectCycles', () => {
  it('should detect no cycles in acyclic graph', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    assert.deepStrictEqual(graph.detectCycles(), []);
  });

  it('should detect a cycle', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addNode('c', {});
    graph.addEdge('a', 'b', 'dependency');
    graph.addEdge('b', 'c', 'dependency');
    graph.addEdge('c', 'a', 'dependency');
    const cycles = graph.detectCycles();
    assert.ok(cycles.length > 0);
  });
});

describe('SkillGraph - findMinimalSkillSet', () => {
  it('should return empty for empty required skills', () => {
    const graph = new SkillGraph();
    assert.deepStrictEqual(graph.findMinimalSkillSet('test', []), []);
  });

  it('should include dependencies of required skills', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    const result = graph.findMinimalSkillSet('', ['b']);
    assert.ok(result.includes('a'));
    assert.ok(result.includes('b'));
  });
});

describe('SkillGraph - getStats', () => {
  it('should return graph statistics', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    const stats = graph.getStats();
    assert.strictEqual(stats.nodeCount, 2);
    assert.strictEqual(stats.edgeCount, 1);
    assert.strictEqual(stats.componentCount, 1);
  });

  it('should return zero stats for empty graph', () => {
    const graph = new SkillGraph();
    const stats = graph.getStats();
    assert.strictEqual(stats.nodeCount, 0);
    assert.strictEqual(stats.edgeCount, 0);
    assert.strictEqual(stats.avgDegree, 0);
  });
});

describe('SkillGraph - shutdown', () => {
  it('should clear all data on shutdown', () => {
    const graph = new SkillGraph();
    graph.addNode('a', {});
    graph.addNode('b', {});
    graph.addEdge('a', 'b', 'dependency');
    graph.shutdown();
    assert.strictEqual(graph._nodes.size, 0);
    assert.strictEqual(graph._edges.size, 0);
  });

  it('should prevent operations after shutdown', () => {
    const graph = new SkillGraph();
    graph.shutdown();
    assert.throws(() => graph.addNode('a', {}), /shut down/i);
  });
});
