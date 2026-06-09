'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { create } = require('../../src/index');

function createTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-integ-'));
  const harnessDir = path.join(dir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'sessions'), { recursive: true });

  fs.writeFileSync(path.join(harnessDir, 'config.json'), JSON.stringify({
    version: '2.6.0',
    max_concurrent_agents: 6,
    token_budget: 1e9,
    runtime_config: { token_budget: 1e9, session_ttl_ms: 86400000 },
    skill_registry: { skills: {} },
  }));

  fs.writeFileSync(path.join(harnessDir, 'skills', 'tdd-implement.md'),
    '---\nskill_id: tdd-implement\nname: TDD驱动开发\napplicable_agents: [task-worker]\ntrigger: coding\nauto_trigger: true\nphase: module-development\npriority: 3\ntrigger_conditions:\n  - user mentions TDD\ndepends_on: [architecture-design]\nblocks: [code-review]\nenforcement: strict\n---\n\n# TDD驱动开发');

  fs.writeFileSync(path.join(harnessDir, 'skills', 'architecture-design.md'),
    '---\nskill_id: architecture-design\nname: 架构设计\napplicable_agents: [domain-analyst]\ntrigger: design\nauto_trigger: true\nphase: architecture-design\npriority: 2\ntrigger_conditions:\n  - user mentions architecture\ndepends_on: []\nblocks: []\nenforcement: recommended\n---\n\n# 架构设计');

  fs.writeFileSync(path.join(harnessDir, 'agents', 'task-worker.md'),
    '---\nagent_id: task-worker\nrole: 任务执行者\nlevel: 3\ntdd_enforced: true\navailable_skills: [tdd-implement]\ncollaborates_with: [domain-analyst]\nmanages: []\n---\n\n# 任务执行者');

  fs.writeFileSync(path.join(harnessDir, 'agents', 'domain-analyst.md'),
    '---\nagent_id: domain-analyst\nrole: 领域分析师\nlevel: 2\ntdd_enforced: false\navailable_skills: [architecture-design]\ncollaborates_with: [task-worker]\nmanages: []\n---\n\n# 领域分析师');

  return dir;
}

async function cleanupHarness(harness, dir) {
  if (harness && harness.destroy) {
    try { await harness.destroy(); } catch (_e) { /* best effort */ }
  }
  await new Promise(r => setTimeout(r, 50));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
}

describe('Integration: create() factory with new modules', () => {
  it('should initialize all new modules', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    assert.ok(harness.memoryStore);
    assert.ok(harness.agentChannel);
    assert.ok(harness.checkpointManager);
    assert.ok(harness.retryEngine);
    assert.ok(harness.skillImprover);
    assert.ok(harness.concurrencyController);
    assert.ok(harness.adversarialReview);
    assert.ok(harness.platformCoordinator);
    assert.ok(harness.workflowTemplate);

    assert.equal(typeof harness.memoryStore.addKnowledge, 'function');
    assert.equal(typeof harness.agentChannel.publishResult, 'function');
    assert.equal(typeof harness.checkpointManager.create, 'function');
    assert.equal(typeof harness.retryEngine.execute, 'function');
    assert.equal(typeof harness.skillImprover.recordLearning, 'function');
    assert.equal(typeof harness.concurrencyController.acquire, 'function');
    assert.equal(typeof harness.adversarialReview.review, 'function');
    assert.equal(typeof harness.platformCoordinator.registerPlatform, 'function');
    assert.equal(typeof harness.workflowTemplate.create, 'function');

    await cleanupHarness(harness, dir);
  });

  it('should create checkpoints on phase change', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    harness.session.create('test-cp-session');
    harness.session.advancePhase('test-cp-session', 'requirement-analysis');
    harness.session.completeSkill('test-cp-session', 'architecture-design');
    harness.session.advancePhase('test-cp-session', 'architecture-design');

    const checkpoints = harness.checkpointManager.list('test-cp-session');
    assert.ok(checkpoints.length > 0);

    await cleanupHarness(harness, dir);
  });

  it('should save session summaries on shutdown', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    harness.session.create('test-summary-session');
    harness.session.advancePhase('test-summary-session', 'requirement-analysis');
    harness.session.completeSkill('test-summary-session', 'architecture-design');

    harness.session.emit('shutdown', {});

    const summary = harness.memoryStore.getSessionSummary('test-summary-session');
    assert.ok(summary);
    assert.equal(summary.phase, 'requirement-analysis');

    await cleanupHarness(harness, dir);
  });

  it('should register health checks for new modules', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    const checks = harness.healthChecker.listChecks();
    assert.ok(checks.includes('memory-store'));
    assert.ok(checks.includes('concurrency-controller'));

    const memResult = await harness.healthChecker.check('memory-store');
    assert.equal(memResult.status, 'healthy');

    const ccResult = await harness.healthChecker.check('concurrency-controller');
    assert.equal(ccResult.status, 'healthy');

    await cleanupHarness(harness, dir);
  });

  it('should use concurrency controller with skill execution', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    const result = await harness.concurrencyController.run('skill-tdd', async () => {
      return { executed: true };
    });
    assert.deepEqual(result, { executed: true });
    assert.equal(harness.concurrencyController.runningCount, 0);

    await cleanupHarness(harness, dir);
  });

  it('should use retry engine with skill execution', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    let attempt = 0;
    const result = await harness.retryEngine.execute({
      id: 'retry-skill',
      execute: () => {
        attempt++;
        if (attempt < 2) throw new Error('transient');
        return { success: true };
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);

    await cleanupHarness(harness, dir);
  });

  it('should use adversarial review for code review', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    const result = await harness.adversarialReview.review(
      { file: 'src/module.js', content: 'module.exports = {};' },
      async (_subject) => ({ approved: true, feedback: 'LGTM' }),
      async (_subject) => ({ approved: true, feedback: 'Looks good' }),
    );
    assert.equal(result.consensus, true);
    assert.equal(result.rounds, 1);

    await cleanupHarness(harness, dir);
  });

  it('should use workflow template with DAG', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    harness.workflowTemplate.create('full-pipeline', {
      description: '完整开发流水线',
      steps: [
        { id: 'design', goal: '设计 {{feature}} 架构', needs: [] },
        { id: 'implement', goal: '实现 {{feature}} 功能', needs: ['design'] },
        { id: 'test', goal: '测试 {{feature}}', needs: ['implement'] },
      ],
      variables: ['feature'],
    });

    const instance = harness.workflowTemplate.instantiate('full-pipeline', { feature: '用户认证' });
    assert.equal(instance.steps[0].goal, '设计 用户认证 架构');
    assert.equal(instance.steps[1].goal, '实现 用户认证 功能');

    const WorkflowDAG = require('../../src/runtime/workflow/workflow-dag');
    const dag = WorkflowDAG.fromWorkflowDef({ steps: instance.steps.map(s => ({ ...s, needs: s.needs ?? [] })) });
    assert.equal(dag.getAllNodes().length, 3);
    const sorted = dag.topologicalSort();
    assert.deepEqual(sorted, ['design', 'implement', 'test']);

    await cleanupHarness(harness, dir);
  });

  it('should use agent channel for inter-agent communication', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    harness.agentChannel.publishResult('domain-analyst', 'architecture-design', { doc: 'arch.md', decisions: ['Use Redis'] });
    const upstream = harness.agentChannel.getUpstreamResults('tdd-implement', ['architecture-design']);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].result.doc, 'arch.md');

    harness.agentChannel.setShared('project-config', { db: 'redis', port: 6379 }, 'domain-analyst');
    await harness.agentChannel._sharedWriteLock;
    const config = harness.agentChannel.getShared('project-config');
    assert.equal(config.db, 'redis');

    await cleanupHarness(harness, dir);
  });

  it('should use skill improver to record and retrieve learnings', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    harness.skillImprover.recordLearning({
      skillId: 'tdd-implement',
      whatWorked: ['先写失败测试', '小步迭代'],
      whatFailed: ['跳过RED阶段'],
      tips: ['每次只写一个测试'],
    });

    const tips = harness.skillImprover.getTips('tdd-implement');
    assert.ok(tips.includes('先写失败测试'));
    assert.ok(tips.includes('每次只写一个测试'));

    const avoidances = harness.skillImprover.getAvoidances('tdd-implement');
    assert.ok(avoidances.includes('跳过RED阶段'));

    await cleanupHarness(harness, dir);
  });

  it('should use memory store for project knowledge', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    await harness.memoryStore.ready;
    harness.memoryStore.addKnowledge({
      category: 'architecture',
      title: '数据库选型',
      content: '项目使用Redis作为缓存，PostgreSQL作为主数据库',
      tags: ['database', 'redis', 'postgresql'],
    });

    const results = harness.memoryStore.queryKnowledge({ category: 'architecture' });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, '数据库选型');

    await cleanupHarness(harness, dir);
  });

  it('should use platform coordinator for cross-platform messaging', async () => {
    const dir = createTmpProject();
    const harness = create(dir);

    const received = [];
    harness.platformCoordinator.registerPlatform('cli', async (msg) => { received.push({ platform: 'cli', msg }); });
    harness.platformCoordinator.registerPlatform('discord', async (msg) => { received.push({ platform: 'discord', msg }); });
    harness.platformCoordinator.addRoute('cli', 'discord');

    await harness.platformCoordinator.send('cli', '部署完成');
    assert.equal(received.length, 2);
    assert.equal(received[0].platform, 'cli');
    assert.equal(received[1].platform, 'discord');

    await cleanupHarness(harness, dir);
  });
});
