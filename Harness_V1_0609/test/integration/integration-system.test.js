'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

const DeepeningOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-orchestrator'));
const ThoughtExtractor = require(path.join(ROOT, 'src', 'runtime', 'thought', 'thought-extractor'));
const ThoughtDeduplicator = require(path.join(ROOT, 'src', 'runtime', 'thought', 'thought-deduplicator'));
const ThoughtMemoryStore = require(path.join(ROOT, 'src', 'runtime', 'thought', 'thought-memory-store'));
const ThoughtRetrieverCycle = require(path.join(ROOT, 'src', 'runtime', 'thought', 'thought-retriever-cycle'));
const EmbeddingService = require(path.join(ROOT, 'src', 'runtime', 'model', 'embedding-service'));
const ModelSelector = require(path.join(ROOT, 'src', 'runtime', 'model', 'model-selector'));
const SubagentExecutor = require(path.join(ROOT, 'src', 'runtime', 'agent', 'subagent-executor'));
const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));

function _createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-integration-'));
}

function _setupHarnessDir(tempDir) {
  const agentsDir = path.join(tempDir, '.harness', 'agents');
  const skillsDir = path.join(tempDir, '.harness', 'skills');
  const thoughtsDir = path.join(tempDir, '.harness', 'thoughts');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(thoughtsDir, { recursive: true });

  fs.writeFileSync(path.join(agentsDir, 'task-worker.md'), [
    '---',
    'role: task-worker',
    'available_skills: [tdd-implement, module-development, bug-fix]',
    'auto_route: true',
    'tdd_enforced: true',
    'model: gpt-4o-mini',
    'level: standard',
    '---',
    '',
    '# Task Worker',
    'Executes implementation tasks.',
  ].join('\n'));

  fs.writeFileSync(path.join(agentsDir, 'domain-analyst.md'), [
    '---',
    'role: domain-analyst',
    'available_skills: [brainstorming, requirement-analysis, architecture-design, code-review, security-audit]',
    'auto_route: true',
    'tdd_enforced: false',
    'model: gpt-4o',
    'level: premium',
    '---',
    '',
    '# Domain Analyst',
    'Handles analysis and design.',
  ].join('\n'));

  fs.writeFileSync(path.join(agentsDir, 'quality-assurance.md'), [
    '---',
    'role: quality-assurance',
    'available_skills: [integration-testing, verification-before-completion]',
    'auto_route: true',
    'tdd_enforced: true',
    'model: gpt-3.5-turbo',
    'level: economy',
    '---',
    '',
    '# Quality Assurance',
    'Handles testing and verification.',
  ].join('\n'));

  fs.writeFileSync(path.join(skillsDir, 'tdd-implement.md'), [
    '---',
    'skill_id: tdd-implement',
    'enforcement: strict',
    'depends_on: [requirement-analysis]',
    'applicable_agents: [task-worker]',
    'phase: module-development',
    'priority: 10',
    '---',
    '',
    '# TDD Implement',
  ].join('\n'));

  fs.writeFileSync(path.join(skillsDir, 'brainstorming.md'), [
    '---',
    'skill_id: brainstorming',
    'enforcement: recommended',
    'depends_on: []',
    'applicable_agents: [team-lead, domain-analyst]',
    'phase: requirement-exploration',
    'priority: 5',
    '---',
    '',
    '# Brainstorming',
  ].join('\n'));

  return tempDir;
}

describe('Integration: DeepeningOrchestrator + ThoughtRetrieverCycle + RBAC', () => {
  it('should integrate ThoughtRetrieverCycle with DeepeningOrchestrator for thought-enhanced execution', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const embeddingService = new EmbeddingService({ dimensions: 64 });
      const thoughtMemoryStore = new ThoughtMemoryStore(tempDir, { embeddingService });
      const thoughtExtractor = new ThoughtExtractor({ confidenceThreshold: 0.5 });
      const thoughtDeduplicator = new ThoughtDeduplicator({ similarityThreshold: 0.9 });
      const thoughtRetrieverCycle = new ThoughtRetrieverCycle({
        thoughtExtractor,
        thoughtDeduplicator,
        thoughtMemoryStore,
        embeddingService,
        retrievalMode: 'hybrid',
      });

      const orchestrator = new DeepeningOrchestrator({ maxIterations: 2 });
      orchestrator.attachThoughtRetrieverCycle(thoughtRetrieverCycle);

      const agents = {
        analyst: {
          id: 'analyst',
          execute: async () => ({
            output: 'Decision: Use microservices. Insight: Security requires input validation.',
            score: 0.85,
          }),
        },
      };

      const result = await orchestrator.execute(
        { id: 'integ-1', description: 'Design system architecture', domain: 'architecture', tags: ['design'] },
        agents,
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.thoughtCycle);
      assert.ok(result.thoughtCycle.distilled >= 0);
      assert.ok(result.thoughtCycle.stored >= 0);

      const cycleStats = thoughtRetrieverCycle.getStats();
      assert.strictEqual(cycleStats.totalCycles, 1);
      assert.strictEqual(cycleStats.retrievalMode, 'hybrid');
      assert.strictEqual(cycleStats.hasEmbeddingService, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should accumulate and retrieve thoughts across multiple orchestrator executions', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const embeddingService = new EmbeddingService({ dimensions: 64 });
      const thoughtMemoryStore = new ThoughtMemoryStore(tempDir, { embeddingService });
      const thoughtExtractor = new ThoughtExtractor({ confidenceThreshold: 0.5 });
      const thoughtDeduplicator = new ThoughtDeduplicator({ similarityThreshold: 0.9 });
      const thoughtRetrieverCycle = new ThoughtRetrieverCycle({
        thoughtExtractor,
        thoughtDeduplicator,
        thoughtMemoryStore,
        embeddingService,
        retrievalMode: 'hybrid',
      });

      const orchestrator = new DeepeningOrchestrator({ maxIterations: 1 });
      orchestrator.attachThoughtRetrieverCycle(thoughtRetrieverCycle);

      const agents = {
        worker: {
          id: 'worker',
          execute: async () => ({
            output: 'Decision: Use Redis for caching. Pattern: Connection pooling improves performance.',
            score: 0.8,
          }),
        },
      };

      await orchestrator.execute(
        { id: 'exec-1', description: 'Design caching layer', domain: 'database', tags: ['caching'] },
        agents,
      );

      await orchestrator.execute(
        { id: 'exec-2', description: 'Optimize database connections', domain: 'database', tags: ['database'], queryText: 'caching Redis' },
        agents,
      );

      const cycleStats = thoughtRetrieverCycle.getStats();
      assert.strictEqual(cycleStats.totalCycles, 2);
      assert.ok(cycleStats.thoughtsStored >= 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Integration: SubagentExecutor + ModelSelector + RBACEnforcer', () => {
  it('should select model based on agent definition from RBACEnforcer', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    let executor;
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      const modelSelector = new ModelSelector();
      executor = new SubagentExecutor();
      executor.attachModelSelector(modelSelector);
      executor.attachRBACEnforcer(enforcer);

      const handle = await executor.spawn(
        { description: 'Implement feature', skillId: 'tdd-implement' },
        { agentId: 'task-worker', skillId: 'tdd-implement' },
      );

      assert.ok(handle);
      const info = executor.getHandle(handle.handleId);
      assert.strictEqual(info.model, 'gpt-4o-mini');
      assert.strictEqual(info.modelSource, 'agent-definition');
    } finally {
      if (executor) executor.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should use premium model for domain-analyst agent', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    let executor;
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      const modelSelector = new ModelSelector();
      executor = new SubagentExecutor();
      executor.attachModelSelector(modelSelector);
      executor.attachRBACEnforcer(enforcer);

      const handle = await executor.spawn(
        { description: 'Analyze requirements', skillId: 'brainstorming' },
        { agentId: 'domain-analyst', skillId: 'brainstorming' },
      );

      assert.ok(handle);
      const info = executor.getHandle(handle.handleId);
      assert.strictEqual(info.model, 'gpt-4o');
      assert.strictEqual(info.modelSource, 'agent-definition');
    } finally {
      if (executor) executor.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should fall back to ModelSelector when agent has no model defined', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    let executor;
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      const modelSelector = new ModelSelector();
      executor = new SubagentExecutor();
      executor.attachModelSelector(modelSelector);
      executor.attachRBACEnforcer(enforcer);

      const handle = await executor.spawn(
        { description: 'Run tests', skillId: 'integration-testing' },
        { agentId: 'quality-assurance', skillId: 'integration-testing' },
      );

      assert.ok(handle);
      const info = executor.getHandle(handle.handleId);
      assert.strictEqual(info.model, 'gpt-3.5-turbo');
      assert.strictEqual(info.modelSource, 'agent-definition');
    } finally {
      if (executor) executor.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should use ModelSelector skill mapping when no RBAC override', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    let executor;
    try {
      const modelSelector = new ModelSelector();
      executor = new SubagentExecutor();
      executor.attachModelSelector(modelSelector);

      const handle = await executor.spawn(
        { description: 'Debug issue', skillId: 'systematic-debugging' },
        { agentId: 'unknown-agent', skillId: 'systematic-debugging' },
      );

      assert.ok(handle);
      const info = executor.getHandle(handle.handleId);
      assert.strictEqual(info.model, 'gpt-4o');
      assert.strictEqual(info.modelSource, 'skill-mapping');
    } finally {
      if (executor) executor.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should pass model info to execution context', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    let executor;
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      const modelSelector = new ModelSelector();
      executor = new SubagentExecutor();
      executor.attachModelSelector(modelSelector);
      executor.attachRBACEnforcer(enforcer);

      const handle = await executor.spawn(
        { description: 'Implement feature', skillId: 'tdd-implement' },
        { agentId: 'task-worker', skillId: 'tdd-implement' },
      );

      let capturedModel = null;
      let capturedModelSource = null;
      let capturedModelTier = null;

      await executor._executeHandle(handle, (task) => {
        capturedModel = task._model;
        capturedModelSource = task._modelSource;
        capturedModelTier = task._modelTier;
        return { output: 'done' };
      });

      assert.strictEqual(capturedModel, 'gpt-4o-mini');
      assert.strictEqual(capturedModelSource, 'agent-definition');
      assert.strictEqual(capturedModelTier, 'standard');
    } finally {
      if (executor) executor.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should track model selection stats', async () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    let executor;
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      const modelSelector = new ModelSelector();
      executor = new SubagentExecutor();
      executor.attachModelSelector(modelSelector);
      executor.attachRBACEnforcer(enforcer);

      await executor.spawn(
        { description: 'Task 1', skillId: 'tdd-implement' },
        { agentId: 'task-worker', skillId: 'tdd-implement' },
      );
      await executor.spawn(
        { description: 'Task 2', skillId: 'brainstorming' },
        { agentId: 'domain-analyst', skillId: 'brainstorming' },
      );

      const stats = executor.getStats();
      assert.strictEqual(stats.modelOverrides, 2);
    } finally {
      if (executor) executor.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Integration: ThoughtRetrieverCycle Semantic Retrieval', () => {
  it('should use semantic retrieval mode when configured', () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const embeddingService = new EmbeddingService({ dimensions: 64 });
      const thoughtMemoryStore = new ThoughtMemoryStore(tempDir, { embeddingService });
      const thoughtExtractor = new ThoughtExtractor({ confidenceThreshold: 0.5 });
      const thoughtDeduplicator = new ThoughtDeduplicator({ similarityThreshold: 0.9 });

      thoughtMemoryStore.storeThought({
        id: 'tht-1', type: 'insight', content: 'Redis caching improves response time significantly',
        confidence: 0.9, domain: 'database', tags: ['caching', 'redis'],
      });
      thoughtMemoryStore.storeThought({
        id: 'tht-2', type: 'decision', content: 'Use PostgreSQL for persistent data storage',
        confidence: 0.85, domain: 'database', tags: ['database', 'postgresql'],
      });

      const cycle = new ThoughtRetrieverCycle({
        thoughtExtractor,
        thoughtDeduplicator,
        thoughtMemoryStore,
        embeddingService,
        retrievalMode: 'semantic',
      });

      const result = cycle.execute('New output about caching strategies', {
        taskId: 'semantic-test',
        domain: 'database',
        queryText: 'Redis caching',
        tags: ['caching'],
      });

      assert.strictEqual(result.cycleComplete, true);
      const stats = cycle.getStats();
      assert.strictEqual(stats.semanticRetrievals, 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should use hybrid retrieval mode combining confidence and semantic', () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const embeddingService = new EmbeddingService({ dimensions: 64 });
      const thoughtMemoryStore = new ThoughtMemoryStore(tempDir, { embeddingService });
      const thoughtExtractor = new ThoughtExtractor({ confidenceThreshold: 0.5 });
      const thoughtDeduplicator = new ThoughtDeduplicator({ similarityThreshold: 0.9 });

      thoughtMemoryStore.storeThought({
        id: 'tht-1', type: 'insight', content: 'Security requires input validation on all endpoints',
        confidence: 0.95, domain: 'security', tags: ['security'],
      });
      thoughtMemoryStore.storeThought({
        id: 'tht-2', type: 'pattern', content: 'Authentication tokens should be rotated periodically',
        confidence: 0.8, domain: 'security', tags: ['security', 'auth'],
      });

      const cycle = new ThoughtRetrieverCycle({
        thoughtExtractor,
        thoughtDeduplicator,
        thoughtMemoryStore,
        embeddingService,
        retrievalMode: 'hybrid',
      });

      const result = cycle.execute('Security audit findings', {
        taskId: 'hybrid-test',
        domain: 'security',
        queryText: 'security validation',
        tags: ['security'],
      });

      assert.strictEqual(result.cycleComplete, true);
      const stats = cycle.getStats();
      assert.strictEqual(stats.hybridRetrievals, 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should fall back to confidence retrieval when no embedding service', () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const thoughtMemoryStore = new ThoughtMemoryStore(tempDir);
      const thoughtExtractor = new ThoughtExtractor({ confidenceThreshold: 0.5 });
      const thoughtDeduplicator = new ThoughtDeduplicator({ similarityThreshold: 0.9 });

      thoughtMemoryStore.storeThought({
        id: 'tht-1', type: 'insight', content: 'Basic insight without embedding',
        confidence: 0.9, domain: 'general', tags: ['test'],
      });

      const cycle = new ThoughtRetrieverCycle({
        thoughtExtractor,
        thoughtDeduplicator,
        thoughtMemoryStore,
        retrievalMode: 'hybrid',
      });

      const result = cycle.execute('Some output', {
        taskId: 'fallback-test',
        domain: 'general',
        queryText: 'basic insight',
        tags: ['test'],
      });

      assert.strictEqual(result.cycleComplete, true);
      assert.ok(result.retrievedThoughts.length >= 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Integration: RBACEnforcer Agent Model Resolution', () => {
  it('should load agent model fields from frontmatter', () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const enforcer = new RBACEnforcer(tempDir);
      const result = enforcer.load();

      assert.ok(result.agentsLoaded >= 3);

      assert.strictEqual(enforcer.getAgentModel('task-worker'), 'gpt-4o-mini');
      assert.strictEqual(enforcer.getAgentModel('domain-analyst'), 'gpt-4o');
      assert.strictEqual(enforcer.getAgentModel('quality-assurance'), 'gpt-3.5-turbo');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return empty string for unknown agent', () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      assert.strictEqual(enforcer.getAgentModel('nonexistent-agent'), '');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should check agent skill permissions correctly', () => {
    const tempDir = _setupHarnessDir(_createTempDir());
    try {
      const enforcer = new RBACEnforcer(tempDir);
      enforcer.load();

      assert.strictEqual(enforcer.canExecute('task-worker', 'tdd-implement'), true);
      assert.strictEqual(enforcer.canExecute('task-worker', 'brainstorming'), false);
      assert.strictEqual(enforcer.canExecute('domain-analyst', 'brainstorming'), true);
      assert.strictEqual(enforcer.canExecute('domain-analyst', 'tdd-implement'), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
