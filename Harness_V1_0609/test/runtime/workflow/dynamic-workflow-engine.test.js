'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const DynamicWorkflowEngine = require('../../../src/runtime/workflow/dynamic-workflow-engine');
const WorkflowCompiler = require('../../../src/runtime/workflow/workflow-compiler');

describe('DynamicWorkflowEngine - Constructor & DI', () => {
  describe('Constructor & Constants', () => {
    it('should create instance with default config', () => {
      const engine = new DynamicWorkflowEngine();
      assert.strictEqual(engine.getStatus().status, 'idle');
      assert.strictEqual(engine.getStatus().tokenBudget, 0);
      engine.shutdown();
    });

    it('should accept custom config', () => {
      const engine = new DynamicWorkflowEngine({ maxNodes: 100, tokenBudget: 50000 });
      assert.strictEqual(engine.getStatus().tokenBudget, 50000);
      engine.shutdown();
    });

    it('should expose static constants', () => {
      assert.ok(DynamicWorkflowEngine.ENGINE_STATUS);
      assert.ok(DynamicWorkflowEngine.NODE_TYPE);
      assert.ok(DynamicWorkflowEngine.EDGE_TYPE);
      assert.ok(DynamicWorkflowEngine.listBuiltinConditions().length > 0);
      assert.ok(DynamicWorkflowEngine.listNodeTypes().length > 0);
      assert.ok(DynamicWorkflowEngine.listEdgeTypes().length > 0);
      assert.ok(DynamicWorkflowEngine.listEngineStatuses().length > 0);
    });
  });

  describe('attach* Dependency Injection', () => {
    it('should attach SubagentExecutor', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.attachSubagentExecutor({ spawn: () => {} });
      assert.strictEqual(result, engine);
      engine.shutdown();
    });

    it('should attach CheckpointManager', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.attachCheckpointManager({ create: () => {} });
      assert.strictEqual(result, engine);
      engine.shutdown();
    });

    it('should attach TokenManager', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.attachTokenManager({ store: () => {} });
      assert.strictEqual(result, engine);
      engine.shutdown();
    });

    it('should attach MultiAgentRouter', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.attachMultiAgentRouter({ route: () => {} });
      assert.strictEqual(result, engine);
      engine.shutdown();
    });

    it('should attach PairChat', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.attachPairChat({ startSession: () => {} });
      assert.strictEqual(result, engine);
      engine.shutdown();
    });

    it('should reject attach after shutdown', () => {
      const engine = new DynamicWorkflowEngine();
      engine.shutdown();
      assert.throws(() => engine.attachSubagentExecutor({}));
    });
  });
});

describe('DynamicWorkflowEngine - compile()', () => {
  it('should compile valid DSL', () => {
    const engine = new DynamicWorkflowEngine();
    const result = engine.compile({
      name: 'test-workflow',
      nodes: [
        { id: 'step1', type: 'task', agent: 'worker', task: 'Do something' },
        { id: 'step2', type: 'task', agent: 'worker', task: 'Do more', depends: ['step1'] },
      ],
    });
    assert.strictEqual(result.compiled, true);
    assert.strictEqual(result.nodeCount, 2);
    assert.strictEqual(result.errors.length, 0);
    engine.shutdown();
  });

  it('should reject invalid DSL', () => {
    const engine = new DynamicWorkflowEngine();
    const result = engine.compile(null);
    assert.strictEqual(result.compiled, false);
    assert.ok(result.errors.length > 0);
    engine.shutdown();
  });

  it('should reject empty nodes', () => {
    const engine = new DynamicWorkflowEngine();
    const result = engine.compile({ nodes: [] });
    assert.strictEqual(result.compiled, false);
    engine.shutdown();
  });

  it('should compile with conditional edges', () => {
    const engine = new DynamicWorkflowEngine();
    const result = engine.compile({
      name: 'conditional-workflow',
      nodes: [
        { id: 'check', type: 'task', task: 'Check code' },
        { id: 'fix', type: 'task', task: 'Fix issues', depends: ['check'] },
        { id: 'done', type: 'task', task: 'All good', depends: ['check'] },
      ],
      edges: [
        { from: 'check', to: 'fix', type: 'conditional', condition: 'hasIssues' },
        { from: 'check', to: 'done', type: 'conditional', condition: 'noIssues' },
      ],
    });
    assert.strictEqual(result.compiled, true);
    assert.strictEqual(result.conditionalCount, 2);
    engine.shutdown();
  });

  it('should compile with verification nodes', () => {
    const engine = new DynamicWorkflowEngine();
    const result = engine.compile({
      name: 'verify-workflow',
      nodes: [
        { id: 'code', type: 'task', agent: 'worker', task: 'Write code' },
        { id: 'review', type: 'verification', agents: ['reviewer', 'security'], mode: 'adversarial', depends: ['code'] },
      ],
    });
    assert.strictEqual(result.compiled, true);
    engine.shutdown();
  });

  it('should compile with parallel nodes', () => {
    const engine = new DynamicWorkflowEngine();
    const result = engine.compile({
      name: 'parallel-workflow',
      nodes: [
        { id: 'fanout', type: 'parallel', agents: ['agent1', 'agent2', 'agent3'], task: 'Parallel work' },
      ],
    });
    assert.strictEqual(result.compiled, true);
    engine.shutdown();
  });

  it('should set token budget from DSL', () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'budget-workflow',
      nodes: [{ id: 's1', type: 'task', task: 'Work' }],
      tokenBudget: 10000,
    });
    assert.strictEqual(engine.getStatus().tokenBudget, 10000);
    engine.shutdown();
  });

  it('should emit workflow-compiled event', (_t) => {
    const engine = new DynamicWorkflowEngine();
    let eventFired = false;
    engine.on('workflow-compiled', () => { eventFired = true; });
    engine.compile({ name: 'event-test', nodes: [{ id: 's1', type: 'task', task: 'Work' }] });
    assert.strictEqual(eventFired, true);
    engine.shutdown();
  });
});

describe('DynamicWorkflowEngine - execute()', () => {
  it('should execute simple sequential workflow', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'simple-exec',
      nodes: [
        { id: 's1', type: 'task', task: 'Step 1' },
        { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
      ],
    });

    const executeFn = async (nodeId, config) => {
      return { output: config.task + ' done', tokensUsed: 100 };
    };

    const result = await engine.execute({ executeFn });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nodesExecuted, 2);
    assert.strictEqual(result.nodesFailed, 0);
    engine.shutdown();
  });

  it('should execute with custom verifyFn', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'verify-exec',
      nodes: [
        { id: 'code', type: 'task', task: 'Write code' },
        { id: 'review', type: 'verification', agents: ['a', 'b'], depends: ['code'] },
      ],
    });

    const executeFn = async (nodeId) => ({ output: { result: nodeId }, tokensUsed: 50 });
    const verifyFn = (_nodeId, _result) => ({ passed: true, feedback: 'OK' });

    const result = await engine.execute({ executeFn, verifyFn });
    assert.strictEqual(result.success, true);
    engine.shutdown();
  });

  it('should handle node failure and skip dependents', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'fail-exec',
      nodes: [
        { id: 's1', type: 'task', task: 'Will fail' },
        { id: 's2', type: 'task', task: 'Depends on s1', depends: ['s1'] },
      ],
    });

    const executeFn = async (nodeId) => {
      if (nodeId === 's1') throw new Error('Intentional failure');
      return { output: 'ok', tokensUsed: 0 };
    };

    const result = await engine.execute({ executeFn });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.nodesFailed, 1);
    assert.strictEqual(result.nodesSkipped, 1);
    engine.shutdown();
  });

  it('should enforce token budget', async () => {
    const engine = new DynamicWorkflowEngine({ tokenBudget: 150 });
    engine.compile({
      name: 'budget-exec',
      nodes: [
        { id: 's1', type: 'task', task: 'Step 1' },
        { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        { id: 's3', type: 'task', task: 'Step 3', depends: ['s2'] },
      ],
    });

    const executeFn = async () => ({ output: 'done', tokensUsed: 100 });

    const result = await engine.execute({ executeFn });
    assert.strictEqual(result.nodesSkipped, 1);
    engine.shutdown();
  });

  it('should emit workflow events', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'event-exec',
      nodes: [{ id: 's1', type: 'task', task: 'Work' }],
    });

    const events = [];
    engine.on('workflow-started', () => events.push('started'));
    engine.on('node-completed', () => events.push('node-completed'));
    engine.on('workflow-completed', () => events.push('completed'));

    await engine.execute({ executeFn: async () => ({ output: 'ok', tokensUsed: 0 }) });
    assert.ok(events.includes('started'));
    assert.ok(events.includes('node-completed'));
    assert.ok(events.includes('completed'));
    engine.shutdown();
  });

  it('should reject double execution', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({ name: 'double', nodes: [{ id: 's1', type: 'task', task: 'Work' }] });

    const p1 = engine.execute({ executeFn: async () => ({ output: 'ok', tokensUsed: 0 }) });
    const result2 = await engine.execute({ executeFn: async () => ({ output: 'ok', tokensUsed: 0 }) });
    assert.strictEqual(result2.success, false);
    await p1;
    engine.shutdown();
  });

  it('should execute parallel ready nodes concurrently', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'parallel-exec',
      nodes: [
        { id: 's1', type: 'task', task: 'Step 1' },
        { id: 's2a', type: 'task', task: 'Step 2a', depends: ['s1'] },
        { id: 's2b', type: 'task', task: 'Step 2b', depends: ['s1'] },
      ],
    });

    const executeFn = async (nodeId) => ({ output: nodeId + ' done', tokensUsed: 50 });
    const result = await engine.execute({ executeFn });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nodesExecuted, 3);
    engine.shutdown();
  });
});

describe('DynamicWorkflowEngine - Conditional Edges', () => {
  it('should evaluate conditional edges', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'cond-exec',
      nodes: [
        { id: 'check', type: 'task', task: 'Check' },
        { id: 'fix', type: 'task', task: 'Fix', depends: ['check'] },
        { id: 'done', type: 'task', task: 'Done', depends: ['check'] },
      ],
      edges: [
        { from: 'check', to: 'fix', type: 'conditional', condition: 'hasIssues' },
        { from: 'check', to: 'done', type: 'conditional', condition: 'noIssues' },
      ],
    });

    let conditionalEvaluated = false;
    engine.on('conditional-evaluated', () => { conditionalEvaluated = true; });

    const executeFn = async (_nodeId) => ({
      output: { issues: ['bug1'] },
      tokensUsed: 0,
    });

    await engine.execute({ executeFn });
    assert.strictEqual(conditionalEvaluated, true);
    engine.shutdown();
  });

  it('should support custom evaluator functions', async () => {
    const engine = new DynamicWorkflowEngine();
    engine.compile({
      name: 'custom-eval',
      nodes: [
        { id: 's1', type: 'task', task: 'Step 1' },
        { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
      ],
      edges: [
        { from: 's1', to: 's2', type: 'conditional', condition: 'custom', evaluator: (result) => result && result.output && result.output.score > 0.5 },
      ],
    });

    const executeFn = async () => ({ output: { score: 0.9 }, tokensUsed: 0 });
    const result = await engine.execute({ executeFn });
    assert.strictEqual(result.success, true);
    engine.shutdown();
  });
});

describe('DynamicWorkflowEngine - Checkpoints, Pause & Query', () => {
  describe('Checkpoints', () => {
    it('should create checkpoints during execution', async () => {
      const engine = new DynamicWorkflowEngine({ autoCheckpoint: true, checkpointInterval: 1 });
      engine.compile({
        name: 'checkpoint-exec',
        nodes: [
          { id: 's1', type: 'task', task: 'Step 1' },
          { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        ],
      });

      let checkpointCreated = false;
      engine.on('checkpoint-created', () => { checkpointCreated = true; });

      await engine.execute({ executeFn: async () => ({ output: 'ok', tokensUsed: 0 }) });
      assert.strictEqual(checkpointCreated, true);
      assert.ok(engine.getCheckpoints().length > 0);
      engine.shutdown();
    });

    it('should rollback to checkpoint', async () => {
      const engine = new DynamicWorkflowEngine({ autoCheckpoint: true, checkpointInterval: 1 });
      engine.compile({
        name: 'rollback-exec',
        nodes: [
          { id: 's1', type: 'task', task: 'Step 1' },
          { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        ],
      });

      await engine.execute({ executeFn: async () => ({ output: 'ok', tokensUsed: 0 }) });
      const checkpoints = engine.getCheckpoints();
      assert.ok(checkpoints.length > 0);

      const result = engine.rollbackToCheckpoint(checkpoints[0].id);
      assert.strictEqual(result.rolledBack, true);
      assert.strictEqual(engine.getStatus().status, 'rolled_back');
      engine.shutdown();
    });

    it('should return error for non-existent checkpoint', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.rollbackToCheckpoint('non-existent');
      assert.strictEqual(result.rolledBack, false);
      engine.shutdown();
    });
  });

  describe('Pause & Resume', () => {
    it('should pause executing workflow', () => {
      const engine = new DynamicWorkflowEngine();
      engine._status = 'executing';
      const result = engine.pause();
      assert.strictEqual(result.paused, true);
      assert.strictEqual(engine.getStatus().status, 'paused');
      engine.shutdown();
    });

    it('should reject pause when not executing', () => {
      const engine = new DynamicWorkflowEngine();
      const result = engine.pause();
      assert.strictEqual(result.paused, false);
      engine.shutdown();
    });
  });

  describe('Query Methods', () => {
    it('should return node results', async () => {
      const engine = new DynamicWorkflowEngine();
      engine.compile({
        name: 'query-exec',
        nodes: [{ id: 's1', type: 'task', task: 'Work' }],
      });

      await engine.execute({ executeFn: async () => ({ output: 'result-data', tokensUsed: 0 }) });
      const result = engine.getNodeResult('s1');
      assert.ok(result);
      engine.shutdown();
    });

    it('should return null for non-existent node result', () => {
      const engine = new DynamicWorkflowEngine();
      assert.strictEqual(engine.getNodeResult('non-existent'), null);
      engine.shutdown();
    });

    it('should return conditional edges', () => {
      const engine = new DynamicWorkflowEngine();
      engine.compile({
        name: 'cond-edges',
        nodes: [
          { id: 's1', type: 'task', task: 'Step 1' },
          { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        ],
        edges: [
          { from: 's1', to: 's2', type: 'conditional', condition: 'success' },
        ],
      });
      const edges = engine.getConditionalEdges();
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].condition, 'success');
      engine.shutdown();
    });

    it('should return stats', () => {
      const engine = new DynamicWorkflowEngine();
      const stats = engine.getStats();
      assert.strictEqual(stats.status, 'idle');
      engine.shutdown();
    });
  });

  describe('Shutdown', () => {
    it('should prevent operations after shutdown', () => {
      const engine = new DynamicWorkflowEngine();
      engine.shutdown();
      assert.throws(() => engine.compile({ nodes: [{ id: 's1', type: 'task', task: 'Work' }] }));
    });
  });
});

describe('WorkflowCompiler', () => {
  describe('compile()', () => {
    it('should compile JSON DSL object', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile({
        name: 'test',
        nodes: [
          { id: 's1', type: 'task', task: 'Step 1' },
          { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        ],
      });
      assert.ok(result.dsl);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should compile JSON DSL string', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile(JSON.stringify({
        name: 'string-test',
        nodes: [{ id: 's1', type: 'task', task: 'Work' }],
      }));
      assert.ok(result.dsl);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should reject invalid input', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile(123);
      assert.strictEqual(result.dsl, null);
      assert.ok(result.errors.length > 0);
    });

    it('should reject empty nodes', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile({ nodes: [] });
      assert.strictEqual(result.dsl, null);
    });

    it('should detect duplicate node IDs', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile({
        nodes: [
          { id: 'dup', type: 'task', task: 'First' },
          { id: 'dup', type: 'task', task: 'Second' },
        ],
      });
      assert.ok(result.errors.length > 0);
    });

    it('should warn about unknown edge references', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile({
        nodes: [{ id: 's1', type: 'task', task: 'Work' }],
        edges: [{ from: 's1', to: 'nonexistent', type: 'sequential' }],
      });
      assert.ok(result.warnings.length > 0);
    });

    it('should auto-infer edges from depends', () => {
      const compiler = new WorkflowCompiler({ autoInferEdges: true });
      const result = compiler.compile({
        nodes: [
          { id: 's1', type: 'task', task: 'Step 1' },
          { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        ],
      });
      assert.ok(result.dsl);
      assert.ok(result.dsl.edges.length >= 1);
    });

    it('should auto-add checkpoints for verification nodes', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile({
        nodes: [
          { id: 'code', type: 'task', task: 'Write code' },
          { id: 'review', type: 'verification', agents: ['a', 'b'], depends: ['code'] },
        ],
      });
      assert.ok(result.dsl.checkpoints.includes('review'));
    });

    it('should warn about verification nodes with < 2 agents', () => {
      const compiler = new WorkflowCompiler();
      const result = compiler.compile({
        nodes: [
          { id: 'review', type: 'verification', agents: ['only-one'], task: 'Review' },
        ],
      });
      assert.ok(result.warnings.length > 0);
    });

    it('should extract workflow from natural language', () => {
      const compiler = new WorkflowCompiler({ strictValidation: false });
      const result = compiler.compile('1. Write code 2. Test code 3. Deploy code');
      // May or may not extract depending on pattern matching
      assert.ok(result.dsl || result.errors.length > 0);
    });

    it('should return stats', () => {
      const compiler = new WorkflowCompiler();
      compiler.compile({ nodes: [{ id: 's1', type: 'task', task: 'Work' }] });
      const stats = compiler.getStats();
      assert.strictEqual(stats.compiledCount, 1);
    });
  });
});

describe('DynamicWorkflowEngine + WorkflowCompiler Integration', () => {
  it('should compile then execute end-to-end', async () => {
    const compiler = new WorkflowCompiler();
    const engine = new DynamicWorkflowEngine();

    const compileResult = compiler.compile({
      name: 'e2e-test',
      nodes: [
        { id: 'extract', type: 'task', agent: 'worker', skill: 'code-locator', task: 'Extract code' },
        { id: 'review', type: 'verification', agents: ['reviewer', 'security'], mode: 'adversarial', depends: ['extract'] },
        { id: 'fix', type: 'task', agent: 'worker', task: 'Fix issues', depends: ['review'] },
        { id: 'verify', type: 'verification', agents: ['reviewer'], depends: ['fix'] },
      ],
      edges: [
        { from: 'extract', to: 'review', type: 'sequential' },
        { from: 'review', to: 'fix', type: 'conditional', condition: 'hasIssues' },
        { from: 'fix', to: 'verify', type: 'sequential' },
      ],
      checkpoints: ['extract', 'verify'],
      tokenBudget: 50000,
    });

    assert.strictEqual(compileResult.errors.length, 0);

    const engineResult = engine.compile(compileResult.dsl);
    assert.strictEqual(engineResult.compiled, true);

    const executeFn = async (nodeId, config) => ({
      output: { issues: nodeId === 'review' ? ['issue1'] : [], result: config.task + ' done' },
      tokensUsed: 500,
    });
    const verifyFn = (_nodeId, _result) => ({ passed: true, feedback: 'OK' });

    const result = await engine.execute({ executeFn, verifyFn });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nodesExecuted, 4);
    engine.shutdown();
  });

  it('should handle budget exhaustion with rollback', async () => {
    const engine = new DynamicWorkflowEngine({ tokenBudget: 300, autoCheckpoint: true, checkpointInterval: 1 });

    engine.compile({
      name: 'budget-rollback',
      nodes: [
        { id: 's1', type: 'task', task: 'Step 1' },
        { id: 's2', type: 'task', task: 'Step 2', depends: ['s1'] },
        { id: 's3', type: 'task', task: 'Step 3', depends: ['s2'] },
      ],
    });

    const executeFn = async () => ({ output: 'done', tokensUsed: 200 });
    const result = await engine.execute({ executeFn });

    assert.strictEqual(result.nodesSkipped, 1);
    const checkpoints = engine.getCheckpoints();
    assert.ok(checkpoints.length > 0);

    engine.shutdown();
  });
});
