'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MemoryStore = require('../../../src/runtime/thought/memory-store');
const AgentChannel = require('../../../src/runtime/agent/agent-channel');
const WorkflowDAG = require('../../../src/runtime/workflow/workflow-dag');
const CheckpointManager = require('../../../src/runtime/session/checkpoint-manager');
const RetryEngine = require('../../../src/runtime/infrastructure/retry-engine');
const SkillImprover = require('../../../src/runtime/skill/skill-improver');
const ConcurrencyController = require('../../../src/runtime/infrastructure/concurrency-controller');
const AdversarialReview = require('../../../src/runtime/quality/adversarial-review');
const PlatformCoordinator = require('../../../src/runtime/infrastructure/platform-coordinator');
const WorkflowTemplate = require('../../../src/runtime/workflow/workflow-template');
const FrameworkComplianceChecker = require('../../../src/gate/framework-compliance-checker');
const DeviationApproval = require('../../../src/gate/deviation-approval');
const CodeReviewFrameworkCheck = require('../../../src/gate/code-review-framework-check');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
}

describe('MemoryStore', () => {
  it('should add and query knowledge entries', async () => {
    const dir = createTmpDir();
    const store = new MemoryStore(dir);
    await store.ready;
    const entry = store.addKnowledge({ category: 'architecture', content: 'Uses microservices', title: 'Architecture Decision', tags: ['microservices'] });
    assert.ok(entry.id);
    assert.equal(entry.category, 'architecture');
    const results = store.queryKnowledge({ category: 'architecture' });
    assert.equal(results.length, 1);
    const byQuery = store.queryKnowledge({ query: 'microservices' });
    assert.equal(byQuery.length, 1);
    assert.equal(store.getKnowledge(entry.id).content, 'Uses microservices');
    store.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should update and remove knowledge', async () => {
    const dir = createTmpDir();
    const store = new MemoryStore(dir);
    await store.ready;
    const entry = store.addKnowledge({ category: 'test', content: 'original' });
    store.updateKnowledge(entry.id, { content: 'updated' });
    assert.equal(store.getKnowledge(entry.id).content, 'updated');
    store.removeKnowledge(entry.id);
    assert.equal(store.getKnowledge(entry.id), null);
    store.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should save and restore session summaries', async () => {
    const dir = createTmpDir();
    const store = new MemoryStore(dir);
    await store.ready;
    store.saveSessionSummary('sess-1', { phase: 'deployment', completedSkills: ['tdd-implement'], keyDecisions: ['Use Redis'] });
    const summary = store.getSessionSummary('sess-1');
    assert.equal(summary.phase, 'deployment');
    assert.deepEqual(summary.completedSkills, ['tdd-implement']);
    const queried = store.querySummaries({ phase: 'deployment' });
    assert.equal(queried.length, 1);
    store.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return stats', async () => {
    const dir = createTmpDir();
    const store = new MemoryStore(dir);
    await store.ready;
    store.addKnowledge({ category: 'a', content: 'x' });
    store.addKnowledge({ category: 'b', content: 'y' });
    const stats = store.getStats();
    assert.equal(stats.knowledgeCount, 2);
    assert.equal(stats.categories.a, 1);
    store.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should persist and restore knowledge', async () => {
    const dir = createTmpDir();
    const store1 = new MemoryStore(dir);
    await store1.ready;
    store1.addKnowledge({ category: 'persist', content: 'survives restart' });
    store1.flush();
    store1.shutdown();
    const store2 = new MemoryStore(dir);
    await store2.ready;
    const results = store2.queryKnowledge({ category: 'persist' });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'survives restart');
    store2.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('AgentChannel', () => {
  it('should publish and get results', () => {
    const ch = new AgentChannel();
    ch.publishResult('task-worker', 'tdd-implement', { status: 'pass' });
    const result = ch.getResult('task-worker', 'tdd-implement');
    assert.equal(result.result.status, 'pass');
  });

  it('should get upstream results for dependencies', () => {
    const ch = new AgentChannel();
    ch.publishResult('analyst', 'architecture-design', { doc: 'arch.md' });
    const upstream = ch.getUpstreamResults('tdd-implement', ['architecture-design']);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].result.doc, 'arch.md');
  });

  it('should support shared KV store', async () => {
    const ch = new AgentChannel();
    ch.setShared('config', { db: 'redis' }, 'analyst');
    await ch._sharedWriteLock;
    assert.deepEqual(ch.getShared('config'), { db: 'redis' });
    assert.ok(ch.getSharedKeys().includes('config'));
    ch.removeShared('config');
    assert.equal(ch.getShared('config'), null);
  });

  it('should emit events', (t, done) => {
    const ch = new AgentChannel();
    ch.on('result-published', (entry) => {
      assert.equal(entry.agentId, 'worker');
      done();
    });
    ch.publishResult('worker', 'skill1', {});
  });
});

describe('WorkflowDAG', () => {
  it('should add nodes and edges', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', { phase: 'research' });
    dag.addNode('b', { phase: 'build' });
    dag.addNode('c', { phase: 'test' });
    assert.ok(dag.addEdge('a', 'b'));
    assert.ok(dag.addEdge('b', 'c'));
    assert.equal(dag.getAllNodes().length, 3);
  });

  it('should detect cycles', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', {});
    dag.addNode('b', {});
    dag.addNode('c', {});
    dag.addEdge('a', 'b');
    dag.addEdge('b', 'c');
    assert.ok(!dag.addEdge('c', 'a'));
  });

  it('should compute ready nodes', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', {});
    dag.addNode('b', {});
    dag.addEdge('a', 'b');
    const { ready } = dag.getReadyNodes();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'a');
  });

  it('should topological sort', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', {});
    dag.addNode('b', {});
    dag.addNode('c', {});
    dag.addEdge('a', 'b');
    dag.addEdge('b', 'c');
    const sorted = dag.topologicalSort();
    assert.deepEqual(sorted, ['a', 'b', 'c']);
  });

  it('should track node lifecycle', () => {
    const dag = new WorkflowDAG();
    dag.addNode('a', {});
    dag.startNode('a');
    assert.equal(dag.getNode('a').status, 'running');
    dag.completeNode('a', { output: 'done' });
    assert.equal(dag.getNode('a').status, 'completed');
    assert.equal(dag.getNode('a').result.output, 'done');
  });

  it('should build from workflow definition', () => {
    const dag = WorkflowDAG.fromWorkflowDef({
      steps: [
        { id: 'research', phase: 'req', needs: [] },
        { id: 'build', phase: 'dev', needs: ['research'] },
        { id: 'test', phase: 'test', needs: ['build'] },
      ],
    });
    assert.equal(dag.getAllNodes().length, 3);
    assert.equal(dag.getEdges().length, 2);
  });
});

describe('CheckpointManager', () => {
  it('should create and restore checkpoints', () => {
    const dir = createTmpDir();
    const mgr = new CheckpointManager(dir);
    const cp = mgr.create('sess-1', { phase: 'module-development', completedSkills: ['tdd-implement'], tokensUsed: 5000 });
    assert.ok(cp.id);
    assert.equal(cp.phase, 'module-development');
    const restored = mgr.restore(cp.id);
    assert.equal(restored.phase, 'module-development');
    assert.deepEqual(restored.completedSkills, ['tdd-implement']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should list and get latest checkpoints', () => {
    const dir = createTmpDir();
    const mgr = new CheckpointManager(dir);
    mgr.create('sess-1', { phase: 'phase-a' });
    mgr.create('sess-1', { phase: 'phase-b' });
    const list = mgr.list('sess-1');
    assert.equal(list.length, 2);
    const latest = mgr.getLatest('sess-1');
    assert.equal(latest.phase, 'phase-b');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should persist and restore', async () => {
    const dir = createTmpDir();
    const mgr1 = new CheckpointManager(dir);
    mgr1.create('sess-1', { phase: 'testing' });
    await new Promise(resolve => process.nextTick(resolve));
    const mgr2 = new CheckpointManager(dir);
    const list = mgr2.list('sess-1');
    assert.equal(list.length, 1);
    assert.equal(list[0].phase, 'testing');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('RetryEngine', () => {
  it('should succeed on first try', async () => {
    const engine = new RetryEngine();
    const result = await engine.execute({
      id: 'task-1',
      execute: () => 'ok',
    });
    assert.equal(result.success, true);
    assert.equal(result.result, 'ok');
    assert.equal(result.attempts, 1);
  });

  it('should retry on failure then succeed', async () => {
    const engine = new RetryEngine({ maxRetries: 3, backoffBaseMs: 10 });
    let attempt = 0;
    const result = await engine.execute({
      id: 'task-2',
      execute: () => {
        attempt++;
        if (attempt < 3) throw new Error('fail');
        return 'recovered';
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.result, 'recovered');
    assert.equal(result.attempts, 3);
  });

  it('should escalate to replan after retries exhausted', async () => {
    const engine = new RetryEngine({ maxRetries: 2, backoffBaseMs: 10 });
    const result = await engine.execute({
      id: 'task-3',
      execute: () => { throw new Error('always fails'); },
      replan: () => ({
        execute: () => 'replanned success',
      }),
    });
    assert.equal(result.success, true);
    assert.equal(result.escalatedTo, 'replan');
  });

  it('should escalate to decompose after replan fails', async () => {
    const engine = new RetryEngine({ maxRetries: 1, backoffBaseMs: 10 });
    const result = await engine.execute({
      id: 'task-4',
      execute: () => { throw new Error('fail'); },
      replan: () => ({
        execute: () => { throw new Error('replan fail'); },
      }),
      decompose: () => [
        { id: 'sub-1', execute: () => 'sub-ok' },
      ],
    });
    assert.equal(result.success, true);
    assert.equal(result.escalatedTo, 'decompose');
  });

  it('should return failure when all escalation fails', async () => {
    const engine = new RetryEngine({ maxRetries: 1, backoffBaseMs: 10 });
    const result = await engine.execute({
      id: 'task-5',
      execute: () => { throw new Error('fail'); },
    });
    assert.equal(result.success, false);
  });
});

describe('SkillImprover', () => {
  it('should record and query learnings', () => {
    const dir = createTmpDir();
    const improver = new SkillImprover(dir);
    improver.recordLearning({
      skillId: 'tdd-implement',
      whatWorked: ['Write test first'],
      whatFailed: ['Skip RED phase'],
      tips: ['Always run tests before implementing'],
    });
    const learnings = improver.getLearnings('tdd-implement');
    assert.equal(learnings.length, 1);
    assert.deepEqual(learnings[0].whatWorked, ['Write test first']);
    const tips = improver.getTips('tdd-implement');
    assert.ok(tips.includes('Write test first'));
    assert.ok(tips.includes('Always run tests before implementing'));
    const avoidances = improver.getAvoidances('tdd-implement');
    assert.ok(avoidances.includes('Skip RED phase'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should persist learnings', async () => {
    const dir = createTmpDir();
    const imp1 = new SkillImprover(dir);
    await imp1.ready;
    imp1.recordLearning({ skillId: 'test-skill', whatWorked: ['approach-a'] });
    imp1._persist();
    imp1.shutdown();
    const imp2 = new SkillImprover(dir);
    await imp2.ready;
    const learnings = imp2.getLearnings('test-skill');
    assert.equal(learnings.length, 1);
    imp2.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ConcurrencyController', () => {
  it('should acquire and release slots', async () => {
    const ctrl = new ConcurrencyController(2);
    assert.equal(ctrl.availableSlots, 2);
    await ctrl.acquire('task-1');
    assert.equal(ctrl.runningCount, 1);
    ctrl.release('task-1');
    assert.equal(ctrl.runningCount, 0);
  });

  it('should queue when at capacity', async () => {
    const ctrl = new ConcurrencyController(1);
    await ctrl.acquire('task-1');
    const p = ctrl.acquire('task-2');
    assert.equal(ctrl.queuedCount, 1);
    ctrl.release('task-1');
    await p;
    assert.equal(ctrl.runningCount, 1);
    ctrl.release('task-2');
  });

  it('should run with auto acquire/release', async () => {
    const ctrl = new ConcurrencyController(2);
    const result = await ctrl.run('task-1', () => Promise.resolve('done'));
    assert.equal(result, 'done');
    assert.equal(ctrl.runningCount, 0);
  });

  it('should return stats', async () => {
    const ctrl = new ConcurrencyController(4);
    await ctrl.acquire('t1');
    await ctrl.acquire('t2');
    const stats = ctrl.getStats();
    assert.equal(stats.runningCount, 2);
    assert.equal(stats.availableSlots, 2);
    ctrl.release('t1');
    ctrl.release('t2');
  });
});

describe('AdversarialReview', () => {
  it('should reach consensus when both approve', async () => {
    const review = new AdversarialReview();
    const result = await review.review(
      'code snippet',
      () => ({ approved: true, feedback: '' }),
      () => ({ approved: true, feedback: '' }),
    );
    assert.equal(result.consensus, true);
    assert.equal(result.rounds, 1);
  });

  it('should iterate when reviewers disagree', async () => {
    const review = new AdversarialReview({ maxRounds: 3 });
    let round = 0;
    const result = await review.review(
      'code snippet',
      () => ({ approved: true, feedback: '' }),
      () => {
        round++;
        return round >= 2
          ? { approved: true, feedback: '' }
          : { approved: false, feedback: 'Needs improvement' };
      },
    );
    assert.equal(result.consensus, true);
    assert.equal(result.rounds, 2);
  });

  it('should return no consensus when max rounds reached', async () => {
    const review = new AdversarialReview({ maxRounds: 2 });
    const result = await review.review(
      'code snippet',
      () => ({ approved: true, feedback: '' }),
      () => ({ approved: false, feedback: 'Still bad' }),
    );
    assert.equal(result.consensus, false);
    assert.equal(result.rounds, 2);
  });

  it('should handle reviewer errors gracefully', async () => {
    const review = new AdversarialReview({ maxRounds: 1 });
    const result = await review.review(
      'code snippet',
      () => { throw new Error('Reviewer crashed'); },
      () => ({ approved: true, feedback: '' }),
    );
    assert.equal(result.consensus, false);
    assert.ok(result.details[0].reviewerA.error);
  });
});

describe('PlatformCoordinator', () => {
  it('should register and send to platforms', async () => {
    const coord = new PlatformCoordinator();
    const messages = [];
    coord.registerPlatform('cli', async (msg) => { messages.push(msg); });
    const result = await coord.send('cli', 'hello');
    assert.equal(result.success, true);
    assert.deepEqual(messages, ['hello']);
  });

  it('should broadcast to all platforms', async () => {
    const coord = new PlatformCoordinator();
    const a = []; const b = [];
    coord.registerPlatform('a', async (msg) => { a.push(msg); });
    coord.registerPlatform('b', async (msg) => { b.push(msg); });
    await coord.broadcast('test');
    assert.deepEqual(a, ['test']);
    assert.deepEqual(b, ['test']);
  });

  it('should forward messages via routes', async () => {
    const coord = new PlatformCoordinator();
    const received = [];
    coord.registerPlatform('source', async (_msg) => {});
    coord.registerPlatform('target', async (msg) => { received.push(msg); });
    coord.addRoute('source', 'target');
    await coord.send('source', 'forwarded');
    assert.deepEqual(received, ['forwarded']);
  });

  it('should return platform not found for unknown', async () => {
    const coord = new PlatformCoordinator();
    const result = await coord.send('unknown', 'msg');
    assert.equal(result.success, false);
  });
});

describe('WorkflowTemplate', () => {
  it('should create and instantiate templates', () => {
    const dir = createTmpDir();
    const wt = new WorkflowTemplate(dir);
    wt.create('full-stack', {
      description: 'Full stack feature',
      steps: [
        { id: 'research', goal: 'Research {{feature}}', needs: [] },
        { id: 'build', goal: 'Build {{feature}}', needs: ['research'] },
      ],
      variables: ['feature'],
    });
    const instance = wt.instantiate('full-stack', { feature: 'auth' });
    assert.equal(instance.steps[0].goal, 'Research auth');
    assert.equal(instance.steps[1].goal, 'Build auth');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should list and remove templates', () => {
    const dir = createTmpDir();
    const wt = new WorkflowTemplate(dir);
    wt.create('template-a', { steps: [{ id: 'step1' }] });
    wt.create('template-b', { steps: [{ id: 'step2' }] });
    assert.equal(wt.list().length, 2);
    wt.remove('template-a');
    assert.equal(wt.list().length, 1);
    assert.equal(wt.get('template-a'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should persist templates', () => {
    const dir = createTmpDir();
    const wt1 = new WorkflowTemplate(dir);
    wt1.create('persist-test', { steps: [{ id: 's1' }] });
    const wt2 = new WorkflowTemplate(dir);
    assert.ok(wt2.get('persist-test'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('PhaseOrchestrator Rollback', () => {
  const PhaseOrchestrator = require('../../../src/runtime/workflow/phase-orchestrator');
  it('should identify forward and backward transitions', () => {
    const orch = new PhaseOrchestrator();
    assert.ok(orch.isForwardTransition('requirement-analysis', 'architecture-design'));
    assert.ok(!orch.isForwardTransition('architecture-design', 'requirement-analysis'));
    assert.ok(orch.isBackwardTransition('architecture-design', 'requirement-analysis'));
    assert.ok(!orch.isBackwardTransition('requirement-analysis', 'architecture-design'));
  });

  it('should validate rollback with skill invalidation', () => {
    const orch = new PhaseOrchestrator();
    const result = orch.validateRollback('module-development', 'architecture-design', ['tdd-implement', 'architecture-design']);
    assert.ok(result.allowed);
    assert.ok(result.requiresApproval);
    assert.ok(result.phasesToRollback.includes('module-development'));
    assert.ok(result.skillsToInvalidate.includes('tdd-implement'));
  });

  it('should allow forward transitions without approval', () => {
    const orch = new PhaseOrchestrator();
    const result = orch.validateRollback('requirement-analysis', 'architecture-design', []);
    assert.ok(result.allowed);
    assert.ok(!result.requiresApproval);
  });
});

describe('FrameworkComplianceChecker', () => {
  const ROOT = path.resolve(__dirname, '..');

  it('should check project files for compliance', async () => {
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkProject();
    assert.ok(Array.isArray(violations));
  });

  it('should check naming conventions', () => {
    const checker = new FrameworkComplianceChecker(ROOT);
    assert.ok(checker.checkNamingConvention('file', 'my-module.js'));
    assert.ok(!checker.checkNamingConvention('file', 'MyModule.js'));
    assert.ok(checker.checkNamingConvention('class', 'SkillRouter'));
    assert.ok(!checker.checkNamingConvention('class', 'skillRouter'));
    assert.ok(checker.checkNamingConvention('constant', 'MAX_RETRIES'));
    assert.ok(!checker.checkNamingConvention('constant', 'maxRetries'));
    assert.ok(checker.checkNamingConvention('event', 'phase-change'));
    assert.ok(!checker.checkNamingConvention('event', 'PhaseChange'));
    assert.ok(checker.checkNamingConvention('error-code', 'RBAC_DENIED'));
    assert.ok(!checker.checkNamingConvention('error-code', 'rbacDenied'));
  });

  it('should check dependency is built-in', () => {
    const checker = new FrameworkComplianceChecker(ROOT);
    assert.ok(checker.checkDependency('fs'));
    assert.ok(checker.checkDependency('crypto'));
    assert.ok(!checker.checkDependency('express'));
    assert.ok(!checker.checkDependency('lodash'));
  });

  it('should detect use-strict violations', async () => {
    const dir = path.join(ROOT, '.test-tmp-strict');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'no-strict.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkFile(filePath);
    const strictViolation = violations.find(v => v.ruleId === 'use-strict');
    assert.ok(strictViolation);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should detect Math.random() in ID generation', async () => {
    const dir = path.join(ROOT, '.test-tmp-random');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'bad-id.js');
    fs.writeFileSync(filePath, "'use strict';\nfunction _generateId() { return Math.random().toString(36); }\n");
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkFile(filePath);
    const randomViolation = violations.find(v => v.ruleId === 'crypto-safe-random');
    assert.ok(randomViolation);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should detect external dependencies', async () => {
    const dir = path.join(ROOT, '.test-tmp-dep');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'ext-dep.js');
    fs.writeFileSync(filePath, "'use strict';\nconst express = require('express');\n");
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkFile(filePath);
    const depViolation = violations.find(v => v.ruleId === 'no-external-deps');
    assert.ok(depViolation);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should support exemptions', () => {
    const checker = new FrameworkComplianceChecker(ROOT, {
      exemptions: { 'use-strict': ['test-file.js'] },
    });
    assert.ok(checker.getExemptions()['use-strict']);
    checker.addExemption('no-eval', 'legacy.js');
    assert.ok(checker.getExemptions()['no-eval'].includes('legacy.js'));
    checker.removeExemption('no-eval', 'legacy.js');
    assert.equal(checker.getExemptions()['no-eval'].length, 0);
  });

  it('should provide compliance summary', async () => {
    const checker = new FrameworkComplianceChecker(ROOT);
    await checker.checkProject();
    const summary = checker.getSummary();
    assert.ok('total' in summary);
    assert.ok('errors' in summary);
    assert.ok('warnings' in summary);
    assert.ok('compliant' in summary);
  });

  it('should detect files exceeding 500 line limit (Karpathy)', async () => {
    const dir = path.join(ROOT, '.test-tmp-linelimit');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'long-file.js');
    const lines = ["'use strict';"];
    for (let i = 0; i < 510; i++) lines.push(`const x${i} = ${i};`);
    fs.writeFileSync(filePath, lines.join('\n'));
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkFile(filePath);
    const lineLimitViolation = violations.find(v => v.ruleId === 'file-line-limit');
    assert.ok(lineLimitViolation, 'Should detect file exceeding 500 lines');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should pass files within 500 line limit (Karpathy)', async () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, 'short-file.js');
    fs.writeFileSync(filePath, "'use strict';\nconst x = 1;\n");
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkFile(filePath);
    const lineLimitViolation = violations.find(v => v.ruleId === 'file-line-limit');
    assert.ok(!lineLimitViolation, 'Should not flag short files');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should detect excessive speculative code patterns (Karpathy)', async () => {
    const dir = path.join(ROOT, '.test-tmp-speculative');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'speculative.js');
    const lines = ["'use strict';"];
    for (let i = 0; i < 5; i++) lines.push(`// TODO: implement feature ${i}`);
    fs.writeFileSync(filePath, lines.join('\n'));
    const checker = new FrameworkComplianceChecker(ROOT);
    const violations = await checker.checkFile(filePath);
    const speculativeViolation = violations.find(v => v.ruleId === 'no-speculative-code');
    assert.ok(speculativeViolation, 'Should detect excessive TODO patterns');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('DeviationApproval', () => {
  it('should request and approve a deviation', () => {
    const dir = createTmpDir();
    const approval = new DeviationApproval(dir);
    const dev = approval.request({
      ruleId: 'use-strict',
      file: 'legacy-module.js',
      reason: 'Third-party generated code without strict mode',
      severity: 'medium',
      requestedBy: 'team-lead',
    });
    assert.ok(dev.id);
    assert.equal(dev.status, 'pending');
    assert.equal(dev.ruleId, 'use-strict');

    const approved = approval.approve(dev.id, 'domain-analyst', 'Acceptable for generated code');
    assert.equal(approved.status, 'approved');
    assert.ok(approval.isApproved('use-strict', 'legacy-module.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should reject a deviation', () => {
    const dir = createTmpDir();
    const approval = new DeviationApproval(dir);
    const dev = approval.request({
      ruleId: 'no-eval',
      file: 'dangerous.js',
      reason: 'Need eval for dynamic config',
      severity: 'high',
    });
    const rejected = approval.reject(dev.id, 'quality-assurance', 'Security risk not acceptable');
    assert.equal(rejected.status, 'rejected');
    assert.ok(!approval.isApproved('no-eval', 'dangerous.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should revoke an approved deviation', () => {
    const dir = createTmpDir();
    const approval = new DeviationApproval(dir);
    const dev = approval.request({
      ruleId: 'file-kebab-case',
      file: 'BadName.js',
      reason: 'Legacy naming',
    });
    approval.approve(dev.id, 'team-lead', 'Temporary');
    const revoked = approval.revoke(dev.id, 'quality-assurance', 'No longer acceptable');
    assert.equal(revoked.status, 'revoked');
    assert.ok(!approval.isApproved('file-kebab-case', 'BadName.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should get pending and approved deviations', () => {
    const dir = createTmpDir();
    const approval = new DeviationApproval(dir);
    approval.request({ ruleId: 'r1', file: 'f1.js', reason: 'test' });
    approval.request({ ruleId: 'r2', file: 'f2.js', reason: 'test' });
    const dev3 = approval.request({ ruleId: 'r3', file: 'f3.js', reason: 'test' });
    approval.approve(dev3.id, 'reviewer', 'ok');
    assert.equal(approval.getPending().length, 2);
    assert.equal(approval.getApproved().length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return stats', () => {
    const dir = createTmpDir();
    const approval = new DeviationApproval(dir);
    approval.request({ ruleId: 'r1', file: 'f1.js', reason: 'test' });
    const stats = approval.getStats();
    assert.equal(stats.total, 1);
    assert.ok(stats.byStatus.pending >= 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should persist and restore deviations', () => {
    const dir = createTmpDir();
    const approval1 = new DeviationApproval(dir);
    const dev = approval1.request({ ruleId: 'persist-test', file: 'persist.js', reason: 'test persist' });
    approval1.approve(dev.id, 'reviewer', 'ok');
    approval1.flush();
    const approval2 = new DeviationApproval(dir);
    assert.ok(approval2.isApproved('persist-test', 'persist.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('CodeReviewFrameworkCheck', () => {
  it('should create a review', () => {
    const dir = createTmpDir();
    const reviewCheck = new CodeReviewFrameworkCheck(dir);
    const review = reviewCheck.createReview({
      targetFiles: [path.join(dir, 'test-module.js')],
      reviewer: 'domain-analyst',
      author: 'task-worker',
      description: 'Review new module for framework compliance',
    });
    assert.ok(review.id);
    assert.equal(review.status, 'pending');
    assert.ok(review.checklist.length > 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should run checklist and detect violations', () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, 'bad-module.js');
    fs.writeFileSync(filePath, "const x = require('express');\nfunction _generateId() { return Math.random().toString(36); }\n");
    const reviewCheck = new CodeReviewFrameworkCheck(dir);
    const review = reviewCheck.createReview({
      targetFiles: [filePath],
      reviewer: 'quality-assurance',
    });
    const result = reviewCheck.runChecklist(review.id);
    assert.ok(result.findings.length > 0);
    assert.equal(result.verdict, 'fail');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should approve and reject reviews', () => {
    const dir = createTmpDir();
    const reviewCheck = new CodeReviewFrameworkCheck(dir);
    const review = reviewCheck.createReview({
      targetFiles: [path.join(dir, 'module.js')],
    });
    reviewCheck.runChecklist(review.id);
    const approved = reviewCheck.approveReview(review.id, 'team-lead', 'Looks good');
    assert.equal(approved.status, 'approved');

    const review2 = reviewCheck.createReview({
      targetFiles: [path.join(dir, 'module2.js')],
    });
    reviewCheck.runChecklist(review2.id);
    const rejected = reviewCheck.rejectReview(review2.id, 'quality-assurance', 'Not compliant');
    assert.equal(rejected.status, 'rejected');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should request changes', () => {
    const dir = createTmpDir();
    const reviewCheck = new CodeReviewFrameworkCheck(dir);
    const review = reviewCheck.createReview({
      targetFiles: [path.join(dir, 'module.js')],
    });
    reviewCheck.runChecklist(review.id);
    const changes = reviewCheck.requestChanges(review.id, 'domain-analyst', 'Fix naming');
    assert.equal(changes.status, 'needs_changes');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should get reviews by status and author', () => {
    const dir = createTmpDir();
    const reviewCheck = new CodeReviewFrameworkCheck(dir);
    reviewCheck.createReview({ targetFiles: [path.join(dir, 'a.js')], author: 'worker1' });
    reviewCheck.createReview({ targetFiles: [path.join(dir, 'b.js')], author: 'worker1' });
    assert.equal(reviewCheck.getReviewsByAuthor('worker1').length, 2);
    assert.equal(reviewCheck.getReviewsByStatus('pending').length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return stats', () => {
    const dir = createTmpDir();
    const reviewCheck = new CodeReviewFrameworkCheck(dir);
    reviewCheck.createReview({ targetFiles: [path.join(dir, 'a.js')] });
    const stats = reviewCheck.getStats();
    assert.equal(stats.total, 1);
    assert.ok(stats.byStatus.pending >= 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
