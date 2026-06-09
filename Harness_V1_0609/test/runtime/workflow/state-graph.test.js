'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('StateGraph - construction and basic operations', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should construct with default options', () => {
    const graph = new StateGraph();
    assert.ok(graph);
    assert.deepStrictEqual(graph.getNodes(), []);
    assert.deepStrictEqual(graph.getEdges(), []);
    assert.deepStrictEqual(graph.getConditionalEdges(), []);
    assert.deepStrictEqual(graph.getCheckpoints(), []);
  });

  it('should construct with custom options', () => {
    const graph = new StateGraph({
      initialState: { phase: 'test' },
      maxIterations: 10,
      autoCheckpoint: false,
    });
    assert.ok(graph);
  });

  it('should add a node', () => {
    const graph = new StateGraph();
    graph.addNode('start', (state) => state);
    assert.deepStrictEqual(graph.getNodes(), ['start']);
  });

  it('should throw when adding node without name or handler', () => {
    const graph = new StateGraph();
    assert.throws(() => graph.addNode('', () => {}), /name and handler are required/);
    assert.throws(() => graph.addNode('test', null), /name and handler are required/);
  });

  it('should add a node with metadata', () => {
    const graph = new StateGraph();
    const meta = { complexity: 'high', requiredSkills: ['test-skill'] };
    graph.addNode('start', (state) => state, meta);
    assert.deepStrictEqual(graph.getNodeMeta('start'), meta);
  });

  it('should set entry point automatically on first node', () => {
    const graph = new StateGraph();
    graph.addNode('first', (state) => state);
    graph.addNode('second', (state) => state);
    // Entry point should be 'first'
    const compiled = graph.compile();
    assert.ok(typeof compiled === 'function');
  });

  it('should set entry point explicitly', () => {
    const graph = new StateGraph();
    graph.addNode('first', (state) => state);
    graph.addNode('second', (state) => state);
    graph.setEntryPoint('second');
    // Should compile without error
    graph.compile();
  });

  it('should throw when setting entry point to non-existent node', () => {
    const graph = new StateGraph();
    assert.throws(() => graph.setEntryPoint('nonexistent'), /not found/);
  });
});

describe('StateGraph - edges', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should add a normal edge', () => {
    const graph = new StateGraph();
    graph.addNode('a', (s) => s);
    graph.addNode('b', (s) => s);
    graph.addEdge('a', 'b');
    const edges = graph.getEdges();
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].from, 'a');
    assert.strictEqual(edges[0].to, 'b');
    assert.strictEqual(edges[0].type, 'normal');
  });

  it('should throw when adding edge without from/to', () => {
    const graph = new StateGraph();
    assert.throws(() => graph.addEdge('', 'b'), /from and to are required/);
    assert.throws(() => graph.addEdge('a', ''), /from and to are required/);
  });

  it('should add a conditional edge', () => {
    const graph = new StateGraph();
    graph.addNode('a', (s) => s);
    graph.addNode('b', (s) => s);
    graph.addConditionalEdges('a', (state) => state.goToB ? 'b' : null);
    const condEdges = graph.getConditionalEdges();
    assert.strictEqual(condEdges.length, 1);
    assert.strictEqual(condEdges[0].from, 'a');
  });

  it('should throw when adding conditional edge without function', () => {
    const graph = new StateGraph();
    assert.throws(() => graph.addConditionalEdges('a', 'not-a-function'), /condition function are required/);
  });
});

describe('StateGraph - parallel nodes', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should add a parallel node', () => {
    const graph = new StateGraph();
    graph.addParallelNode('parallel', [
      (_state) => ({ a: 1 }),
      (_state) => ({ b: 2 }),
    ]);
    assert.ok(graph.getNodes().includes('parallel'));
  });

  it('should throw with empty handlers array', () => {
    const graph = new StateGraph();
    assert.throws(() => graph.addParallelNode('p', []), /non-empty handlers array/);
  });

  it('should execute parallel handlers and merge results (shallow)', async () => {
    const graph = new StateGraph();
    graph.addParallelNode('parallel', [
      (_state) => ({ a: 1 }),
      (_state) => ({ b: 2 }),
      (_state) => ({ a: 3 }),
    ]);
    const result = await graph.invoke({});
    assert.strictEqual(result.a, 1); // shallow: first wins
    assert.strictEqual(result.b, 2);
  });

  it('should execute parallel handlers with deep merge', async () => {
    const graph = new StateGraph();
    graph.addParallelNode('parallel', [
      (_state) => ({ a: 1 }),
      (_state) => ({ b: 2 }),
    ], { mergeStrategy: 'deep' });
    const result = await graph.invoke({});
    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, 2);
  });

  it('should execute parallel handlers with last-wins', async () => {
    const graph = new StateGraph();
    graph.addParallelNode('parallel', [
      (_state) => ({ a: 1 }),
      (_state) => ({ a: 3, b: 2 }),
    ], { mergeStrategy: 'last-wins' });
    const result = await graph.invoke({});
    assert.strictEqual(result.a, 3); // last wins
    assert.strictEqual(result.b, 2);
  });

  it('should support metadata on parallel node', () => {
    const graph = new StateGraph();
    graph.addParallelNode('parallel', [
      (_state) => ({ a: 1 }),
    ], { meta: { complexity: 'high' } });
    assert.strictEqual(graph.getNodeMeta('parallel').complexity, 'high');
  });
});

describe('StateGraph - graph execution', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should execute a simple linear graph', async () => {
    const graph = new StateGraph({ initialState: { value: 0 } });
    graph.addNode('a', (state) => ({ value: state.value + 1, phase: 'b' }));
    graph.addNode('b', (state) => ({ value: state.value + 2, phase: null }));
    graph.addEdge('a', 'b');

    const result = await graph.invoke();
    assert.strictEqual(result.value, 3);
  });

  it('should execute with conditional edges', async () => {
    const graph = new StateGraph({ initialState: { value: 0 } });
    graph.addNode('a', (state) => ({ value: state.value + 1 }));
    graph.addNode('b', (state) => ({ value: state.value + 10 }));
    graph.addNode('c', (state) => ({ value: state.value + 100 }));
    graph.addEdge('a', 'b');
    graph.addConditionalEdges('a', (state) => state.phase === 'c' ? 'c' : null);

    const result = await graph.invoke({ phase: 'c' });
    assert.strictEqual(result.value, 101);
  });

  it('should respect maxIterations', async () => {
    const graph = new StateGraph({ maxIterations: 3 });
    graph.addNode('a', (_state) => ({ phase: 'a' }));
    graph.addEdge('a', 'a');

    await assert.rejects(
      () => graph.invoke({ phase: 'a' }),
      /max iterations/,
    );
  });

  it('should handle async node handlers', async () => {
    const graph = new StateGraph();
    graph.addNode('a', async (_state) => {
      return { value: 42 };
    });

    const result = await graph.invoke();
    assert.strictEqual(result.value, 42);
  });

  it('should handle subgraph nodes', async () => {
    const subGraph = new StateGraph();
    subGraph.addNode('inner', (_state) => ({ innerValue: 10 }));

    const mainGraph = new StateGraph();
    mainGraph.addNode('main', subGraph);

    const result = await mainGraph.invoke({});
    assert.strictEqual(result.innerValue, 10);
  });

  it('should propagate errors from node handlers', async () => {
    const graph = new StateGraph();
    graph.addNode('a', () => { throw new Error('node error'); });

    await assert.rejects(
      () => graph.invoke(),
      /node error/,
    );
  });

  it('should terminate when no more edges', async () => {
    const graph = new StateGraph({ initialState: { counter: 0 } });
    graph.addNode('a', (state) => ({ counter: state.counter + 1 }));
    // No edges from 'a', so graph terminates after one iteration

    const result = await graph.invoke();
    assert.strictEqual(result.counter, 1);
  });
});

describe('StateGraph - hooks', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should call beforeNode hook', async () => {
    const calls = [];
    const graph = new StateGraph({
      hooks: {
        beforeNode: (node, _state, _ctx) => { calls.push(`before:${node}`); },
      },
    });
    graph.addNode('a', (_state) => ({ phase: 'b' }));
    graph.addNode('b', (_state) => ({ counter: 1 }));
    graph.addEdge('a', 'b');

    await graph.invoke();
    assert.deepStrictEqual(calls, ['before:a', 'before:b']);
  });

  it('should call afterNode hook', async () => {
    const calls = [];
    const graph = new StateGraph({
      hooks: {
        afterNode: (node, _state, _ctx) => { calls.push(`after:${node}`); },
      },
    });
    graph.addNode('a', (_state) => ({ phase: 'b' }));
    graph.addNode('b', (_state) => ({ counter: 1 }));
    graph.addEdge('a', 'b');

    await graph.invoke();
    assert.deepStrictEqual(calls, ['after:a', 'after:b']);
  });

  it('should call onError hook on node failure', async () => {
    const errors = [];
    const graph = new StateGraph({
      hooks: {
        onError: (node, err, _state, _ctx) => { errors.push({ node, msg: err.message }); },
      },
    });
    graph.addNode('a', () => { throw new Error('test error'); });

    await assert.rejects(() => graph.invoke(), /test error/);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].node, 'a');
  });

  it('should not block execution when hook throws', async () => {
    const graph = new StateGraph({
      hooks: {
        beforeNode: () => { throw new Error('hook error'); },
      },
    });
    graph.addNode('a', (_state) => ({ value: 1 }));
    const result = await graph.invoke();
    assert.strictEqual(result.value, 1);
  });
});

describe('StateGraph - checkpoints', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should save checkpoints in memory', async () => {
    const graph = new StateGraph({
      autoCheckpoint: true,
      checkpointStore: {
        save: async () => {},
        load: async () => null,
        list: async () => [],
      },
    });
    graph.addNode('a', (_state) => ({ phase: 'b' }));
    graph.addNode('b', (_state) => ({ counter: 1 }));
    graph.addEdge('a', 'b');

    await graph.invoke();
    const checkpoints = graph.getCheckpoints();
    assert.ok(checkpoints.length >= 2, `Expected at least 2 checkpoints, got ${checkpoints.length}`);
    assert.strictEqual(checkpoints[0].node, 'a');
  });

  it('should resume from memory checkpoints', async () => {
    const graph = new StateGraph({
      autoCheckpoint: true,
      checkpointStore: {
        save: async () => {},
        load: async () => null,
        list: async () => [],
      },
    });
    graph.addNode('a', (_state) => ({ phase: 'b' }));
    graph.addNode('b', (_state) => ({ counter: 1 }));
    graph.addEdge('a', 'b');

    await graph.invoke();
    const cp = await graph.resume();
    assert.ok(cp);
    assert.ok(cp.state);
  });

  it('should return null when no checkpoints', async () => {
    const graph = new StateGraph();
    const cp = await graph.resume();
    assert.strictEqual(cp, null);
  });

  it('should not save checkpoints when autoCheckpoint is false', async () => {
    const graph = new StateGraph({
      autoCheckpoint: false,
      checkpointStore: {
        save: async () => {},
        load: async () => null,
        list: async () => [],
      },
    });
    graph.addNode('a', (_state) => ({ value: 1 }));
    await graph.invoke();
    assert.strictEqual(graph.getCheckpoints().length, 0);
  });
});

describe('StateGraph - node metadata', () => {
  const { StateGraph } = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'state-graph'));

  it('should set and get node metadata', () => {
    const graph = new StateGraph();
    graph.addNode('a', (s) => s);
    graph.setNodeMeta('a', { complexity: 'low', requiredSkills: ['skill1'] });
    const meta = graph.getNodeMeta('a');
    assert.strictEqual(meta.complexity, 'low');
    assert.deepStrictEqual(meta.requiredSkills, ['skill1']);
  });

  it('should throw when setting meta for non-existent node', () => {
    const graph = new StateGraph();
    assert.throws(() => graph.setNodeMeta('nope', {}), /not found/);
  });

  it('should return undefined for non-existent node meta', () => {
    const graph = new StateGraph();
    graph.addNode('a', (s) => s);
    assert.strictEqual(graph.getNodeMeta('b'), undefined);
  });
});
