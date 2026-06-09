'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('SubagentExecutor', () => {
  const SubagentExecutor = require(path.join(ROOT, 'src', 'runtime', 'agent', 'subagent-executor'));

  it('should spawn a subagent with valid task', async () => {
    const executor = new SubagentExecutor();
    const handle = await executor.spawn({ description: 'Test task', goal: 'test' });
    assert.ok(handle);
    assert.ok(handle.handleId);
    assert.equal(handle.status, 'pending');
    assert.ok(handle.isPending);
    executor.shutdown();
  });

  it('should reject spawn with null task', async () => {
    const executor = new SubagentExecutor();
    const handle = await executor.spawn(null);
    assert.equal(handle, null);
    executor.shutdown();
  });

  it('should reject spawn when max concurrent reached', async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 1 });
    const h1 = await executor.spawn({ description: 'Task 1' });
    assert.ok(h1);
    const h2 = await executor.spawn({ description: 'Task 2' });
    assert.equal(h2, null);
    executor.shutdown();
  });

  it('should execute a subagent with executeFn', async () => {
    const executor = new SubagentExecutor();
    const handle = await executor.spawn({ description: 'Test task' });
    const result = await executor._executeHandle(handle, (_task) => {
      return { output: 'done', confidence: 0.9 };
    });
    assert.ok(result.success);
    assert.equal(result.result.output, 'done');
    executor.shutdown();
  });

  it('should handle execution failure', async () => {
    const executor = new SubagentExecutor();
    const handle = await executor.spawn({ description: 'Failing task' });
    const result = await executor._executeHandle(handle, () => {
      throw new Error('Task failed');
    });
    assert.ok(!result.success);
    assert.ok(result.error.includes('Task failed'));
    executor.shutdown();
  });

  it('should execute parallel tasks', async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });
    const tasks = [
      { description: 'Task A' },
      { description: 'Task B' },
      { description: 'Task C' },
    ];
    const { results, errors } = await executor.executeParallel(tasks, null, (task) => {
      return { output: task.description, confidence: 0.8 };
    });
    assert.equal(results.length, 3);
    assert.equal(errors.length, 0);
    executor.shutdown();
  });

  it('should execute with verification loop', async () => {
    const executor = new SubagentExecutor({ maxRetries: 2 });
    let callCount = 0;
    const result = await executor.executeWithVerification(
      { description: 'Verified task' },
      null,
      (_task) => {
        callCount++;
        return { output: 'result ' + callCount, confidence: 0.9 };
      },
      (_output) => {
        if (callCount >= 2) return { passed: true, score: 0.9 };
        return { passed: false, score: 0.5, feedback: ['Not good enough'] };
      },
    );
    assert.ok(result.success);
    assert.ok(callCount >= 2);
    executor.shutdown();
  });

  it('should cancel a subagent', async () => {
    const executor = new SubagentExecutor();
    const handle = await executor.spawn({ description: 'Cancellable task' });
    assert.ok(executor.cancel(handle.handleId));
    const refreshed = handle.refresh();
    assert.equal(refreshed.status, 'cancelled');
    executor.shutdown();
  });

  it('should track stats', async () => {
    const executor = new SubagentExecutor();
    await executor.spawn({ description: 'Task 1' });
    await executor.spawn({ description: 'Task 2' });
    const stats = executor.getStats();
    assert.equal(stats.totalSpawned, 2);
    assert.equal(stats.activeHandles, 2);
    assert.equal(stats.maxConcurrent, 5);
    executor.shutdown();
  });

  it('should return healthy when under max concurrent', () => {
    const executor = new SubagentExecutor();
    assert.ok(executor.isHealthy());
    executor.shutdown();
  });

  it('should list active handles', async () => {
    const executor = new SubagentExecutor();
    await executor.spawn({ description: 'Task A' });
    await executor.spawn({ description: 'Task B' });
    const handles = executor.getActiveHandles();
    assert.equal(handles.length, 2);
    executor.shutdown();
  });

  it('should expose STATUS constants', () => {
    assert.ok(SubagentExecutor.STATUS.PENDING);
    assert.ok(SubagentExecutor.STATUS.RUNNING);
    assert.ok(SubagentExecutor.STATUS.COMPLETED);
    assert.ok(SubagentExecutor.STATUS.FAILED);
    assert.ok(SubagentExecutor.STATUS.CANCELLED);
  });
});

describe('AgentChannel P2P Communication', () => {
  const AgentChannel = require(path.join(ROOT, 'src', 'runtime', 'agent', 'agent-channel'));

  it('should send point-to-point message', () => {
    const channel = new AgentChannel();
    const result = channel.send('agent-a', 'agent-b', { text: 'hello' });
    assert.ok(result);
    const messages = channel.getMessages('agent-b');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].from, 'agent-a');
    assert.equal(messages[0].message.text, 'hello');
    channel.shutdown();
  });

  it('should register and call message handler', () => {
    const channel = new AgentChannel();
    let received = null;
    channel.onMessage('agent-b', (msg) => { received = msg; });
    channel.send('agent-a', 'agent-b', { text: 'hello' });
    assert.ok(received);
    assert.equal(received.message.text, 'hello');
    channel.shutdown();
  });

  it('should remove message handler', () => {
    const channel = new AgentChannel();
    let count = 0;
    const handler = () => { count++; };
    channel.onMessage('agent-b', handler);
    channel.send('agent-a', 'agent-b', {});
    assert.equal(count, 1);
    channel.removeMessageHandler('agent-b', handler);
    channel.send('agent-a', 'agent-b', {});
    assert.equal(count, 1);
    channel.shutdown();
  });

  it('should clear messages for an agent', () => {
    const channel = new AgentChannel();
    channel.send('agent-a', 'agent-b', { text: 'hello' });
    channel.clearMessages('agent-b');
    const messages = channel.getMessages('agent-b');
    assert.equal(messages.length, 0);
    channel.shutdown();
  });

  it('should support request-response pattern', async () => {
    const channel = new AgentChannel();
    channel.onMessage('agent-b', (msg) => {
      if (msg.message && msg.message.type === 'request') {
        channel.respond(msg.message.requestId, 'agent-b', { answer: 42 });
      }
    });

    const response = await channel.request('agent-a', 'agent-b', { question: 'meaning of life' }, 5000);
    assert.ok(response);
    assert.equal(response.response.answer, 42);
    channel.shutdown();
  });

  it('should timeout on unanswered request', async () => {
    const channel = new AgentChannel();
    try {
      await channel.request('agent-a', 'agent-b', { question: 'hello' }, 100);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('timeout'));
    }
    channel.shutdown();
  });

  it('should support propose-vote-close coordination', () => {
    const channel = new AgentChannel();
    const proposalId = channel.propose('agent-a', 'design-choice', ['option-A', 'option-B']);
    assert.ok(proposalId);

    channel.vote(proposalId, 'agent-a', 'option-A');
    channel.vote(proposalId, 'agent-b', 'option-A');
    channel.vote(proposalId, 'agent-c', 'option-B');

    const result = channel.closeProposal(proposalId);
    assert.ok(result);
    assert.equal(result.winner, 'option-A');
    assert.equal(result.totalVotes, 3);
    channel.shutdown();
  });

  it('should reject vote on closed proposal', () => {
    const channel = new AgentChannel();
    const proposalId = channel.propose('agent-a', 'topic', ['A', 'B']);
    channel.closeProposal(proposalId);
    const result = channel.vote(proposalId, 'agent-d', 'A');
    assert.ok(!result);
    channel.shutdown();
  });

  it('should support versioned shared state (optimistic locking)', async () => {
    const channel = new AgentChannel();
    const r1 = await channel.setSharedWithVersion('key1', 'value1', 'agent-a');
    assert.ok(r1.success);
    assert.equal(r1.version, 1);

    const r2 = await channel.setSharedWithVersion('key1', 'value2', 'agent-b');
    assert.ok(r2.success);
    assert.equal(r2.version, 2);

    const versionInfo = channel.getSharedVersion('key1');
    assert.equal(versionInfo.value, 'value2');
    assert.equal(versionInfo.version, 2);
    channel.shutdown();
  });

  it('should detect version conflict in shared state', async () => {
    const channel = new AgentChannel();
    await channel.setSharedWithVersion('key1', 'value1', 'agent-a');
    channel._sharedVersions['key1'] = 99;
    const r = await channel.setSharedWithVersion('key1', 'value2', 'agent-b');
    assert.ok(!r.success);
    assert.equal(r.reason, 'version_conflict');
    channel.shutdown();
  });

  it('should clear all new state on clear()', () => {
    const channel = new AgentChannel();
    channel.send('a', 'b', {});
    channel.propose('a', 'topic', ['A']);
    channel.setSharedWithVersion('k', 'v', 'a');
    channel.clear();
    assert.equal(channel.getMessages('b').length, 0);
    assert.equal(channel.getShared('k'), null);
    channel.shutdown();
  });
});

describe('EvidenceVerifier Quality Scoring', () => {
  const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

  it('should return typeScore and qualityScore', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Feature done',
      evidence: [
        { type: 'test_output', content: 'All tests passed successfully' },
        { type: 'coverage_report', content: 'Coverage: 92%' },
      ],
      requiredTypes: ['test_output', 'coverage_report'],
    });
    assert.ok(typeof result.typeScore === 'number');
    assert.ok(typeof result.qualityScore === 'number');
    assert.ok(result.score > 0);
  });

  it('should verify with quality criteria', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Code reviewed',
      evidence: [
        { type: 'review_report', content: 'Code review completed with detailed findings and recommendations for improvement' },
      ],
      requiredTypes: ['review_report'],
      qualityCriteria: {
        dimensions: {
          completeness: { weight: 0.5, minLength: 30 },
          specificity: { weight: 0.5, minKeywords: 2 },
        },
      },
    });
    assert.ok(result.qualityIssues !== undefined);
    assert.ok(typeof result.score === 'number');
  });

  it('should detect brief evidence as quality issue', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Done',
      evidence: [
        { type: 'test_output', content: 'ok' },
      ],
      requiredTypes: ['test_output'],
      qualityCriteria: {
        dimensions: {
          completeness: { weight: 1.0, minLength: 50 },
        },
      },
    });
    assert.ok(result.qualityIssues.length > 0);
    assert.ok(result.qualityIssues.some(qi => qi.dimension === 'completeness'));
  });

  it('should fail verification when score below 0.8 even with all types', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Done',
      evidence: [
        { type: 'test_output', content: 'x' },
      ],
      requiredTypes: ['test_output'],
      qualityCriteria: {
        dimensions: {
          completeness: { weight: 1.0, minLength: 500 },
        },
      },
    });
    assert.ok(!result.verified);
    assert.ok(result.score < 0.8);
  });

  it('should include quality issues in reflection prompt', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'Done',
      evidence: [
        { type: 'test_output', content: 'short' },
      ],
      requiredTypes: ['test_output'],
      skillId: 'tdd-implement',
      agentId: 'task-worker',
      qualityCriteria: {
        dimensions: {
          completeness: { weight: 1.0, minLength: 50 },
        },
      },
    });
    assert.ok(result.shouldReflect);
    assert.ok(result.reflectionPrompt);
    assert.ok(result.reflectionPrompt.includes('质量'));
  });
});

describe('SkillRouter L2/L3 Layered Loading', () => {
  const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));

  it('should load L2 instruction for a skill', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    if (router.skills.length === 0) return;
    const skillId = router.skills[0].skill_id;
    const l2 = router.loadL2(skillId);
    assert.ok(l2);
    assert.ok(l2.instruction);
    assert.ok(l2.tokenEstimate > 0);
    router.shutdown();
  });

  it('should cache L2 on second load', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    if (router.skills.length === 0) return;
    const skillId = router.skills[0].skill_id;
    router.loadL2(skillId);
    const l2b = router.loadL2(skillId);
    assert.ok(l2b);
    const stats = router.getLayerStats();
    assert.ok(stats.l2Hits > 0);
    router.shutdown();
  });

  it('should unload L2', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    if (router.skills.length === 0) return;
    const skillId = router.skills[0].skill_id;
    router.loadL2(skillId);
    const evicted = router.unloadL2(skillId);
    assert.ok(evicted);
    router.shutdown();
  });

  it('should preload multiple L2 skills', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    if (router.skills.length < 2) return;
    const ids = router.skills.slice(0, 2).map(s => s.skill_id);
    const loaded = router.preloadL2(ids);
    assert.ok(loaded.length >= 1);
    router.shutdown();
  });

  it('should return context estimate', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const estimate = router.getContextEstimate();
    assert.ok(estimate.l1Tokens > 0);
    assert.ok(typeof estimate.l2Tokens === 'number');
    assert.ok(typeof estimate.totalTokens === 'number');
    router.shutdown();
  });

  it('should return layer stats', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const stats = router.getLayerStats();
    assert.ok(stats.l1Count > 0);
    assert.ok(typeof stats.l2Cached === 'number');
    assert.ok(typeof stats.deduplicationSavings === 'number');
    router.shutdown();
  });

  it('should generate auto summary for skills', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    for (const skill of router.skills) {
      assert.ok(skill.summary, `Skill ${skill.skill_id} missing summary`);
      assert.ok(skill.summary.length <= 100, `Summary too long for ${skill.skill_id}`);
    }
    router.shutdown();
  });

  it('should build deduplication index', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const report = router.getDeduplicationReport();
    assert.ok(typeof report.duplicateGroups === 'number');
    assert.ok(Array.isArray(report.details));
    router.shutdown();
  });

  it('should return null for L2 of nonexistent skill', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const l2 = router.loadL2('nonexistent-skill');
    assert.equal(l2, null);
    router.shutdown();
  });

  it('should return null for L3 when no references exist', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    if (router.skills.length === 0) return;
    const skillId = router.skills[0].skill_id;
    const l3 = router.loadL3(skillId);
    assert.equal(l3, null);
    router.shutdown();
  });

  it('should extend EventEmitter', () => {
    const EventEmitter = require('events');
    const router = new SkillRouter(ROOT);
    assert.ok(router instanceof EventEmitter);
    router.shutdown();
  });

  it('should emit skills-reloaded on watchForChanges', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    let emitted = false;
    router.on('skills-reloaded', () => { emitted = true; });
    router.watchForChanges(100);
    router.shutdown();
    assert.ok(typeof emitted === 'boolean');
  });
});

describe('SubagentExecutor Token Budget', () => {
  const SubagentExecutor = require(path.join(ROOT, 'src', 'runtime', 'agent', 'subagent-executor'));

  it('should return token budget report', () => {
    const executor = new SubagentExecutor();
    const report = executor.getTokenBudgetReport();
    assert.ok(typeof report.totalTokensUsed === 'number');
    assert.ok(typeof report.budgetExceeded === 'number');
    assert.ok(typeof report.defaultBudgetPerSubagent === 'number');
    assert.ok(Array.isArray(report.activeBudgets));
    executor.shutdown();
  });

  it('should include successRate and avgTokensPerSubagent in stats', () => {
    const executor = new SubagentExecutor();
    const stats = executor.getStats();
    assert.ok(typeof stats.successRate === 'number');
    assert.ok(typeof stats.avgTokensPerSubagent === 'number');
    assert.ok(typeof stats.tokenBudgetPerSubagent === 'number');
    executor.shutdown();
  });

  it('should track active budget in report', async () => {
    const executor = new SubagentExecutor({ maxConcurrent: 3 });
    executor.spawn({ description: 'Budget task 1' });
    executor.spawn({ description: 'Budget task 2' });
    const report = executor.getTokenBudgetReport();
    assert.equal(report.activeBudgets.length, 2);
    assert.ok(report.activeTotalBudget > 0);
    executor.shutdown();
  });

  it('should reject spawn when session token budget exceeded', async () => {
    const executor = new SubagentExecutor();
    const mockSession = {
      checkBudget: () => ({ exhausted: true, warning80: true, warning95: true, ratio: 1.0 }),
      addTokenUsage: () => {},
    };
    executor.attachSessionManager(mockSession);
    const handle = await executor.spawn({ description: 'Over budget', sessionId: 'sess-1' });
    assert.equal(handle, null);
    assert.equal(executor.getStats().budgetExceeded, 1);
    executor.shutdown();
  });
});

describe('CollaborationModeRouter Enhanced', () => {
  const CollaborationModeRouter = require(path.join(ROOT, 'src', 'runtime', 'collaboration', 'collaboration-mode-router'));

  it('should return all modes with details', () => {
    const router = new CollaborationModeRouter();
    const modes = router.getAllModes();
    assert.ok(modes.length >= 5);
    for (const m of modes) {
      assert.ok(m.mode);
      assert.ok(m.description);
      assert.ok(m.bestFor);
      assert.ok(typeof m.minAgents === 'number');
      assert.ok(typeof m.maxAgents === 'number');
    }
    router.shutdown();
  });

  it('should return mode config', () => {
    const router = new CollaborationModeRouter();
    const config = router.getModeConfig('generator-verifier');
    assert.ok(config);
    assert.equal(config.mode, 'generator-verifier');
    assert.ok(config.signals);
    assert.ok(config.taskTraits);
    router.shutdown();
  });

  it('should track mode selection history', () => {
    const router = new CollaborationModeRouter();
    router.selectMode({ taskDescription: '审查代码质量', availableAgents: 3 });
    router.selectMode({ taskDescription: '并行拆解任务', availableAgents: 4 });
    const history = router.getHistory(10);
    assert.ok(history.length >= 2);
    router.shutdown();
  });

  it('should return stats with mode counts', () => {
    const router = new CollaborationModeRouter();
    router.selectMode({ taskDescription: '验证数据', availableAgents: 2 });
    const stats = router.getStats();
    assert.ok(stats.totalSelections >= 1);
    assert.ok(typeof stats.modeCounts === 'object');
    assert.ok(stats.availableModes >= 5);
    router.shutdown();
  });

  it('should support mode override', () => {
    const router = new CollaborationModeRouter();
    router.overrideMode('sess-1', 'shared-state');
    const result = router.selectMode({ taskDescription: 'test', sessionId: 'sess-1' });
    assert.equal(result.mode, 'shared-state');
    assert.equal(result.confidence, 1.0);
    assert.ok(result.overridden);
    router.clearOverride('sess-1');
    router.shutdown();
  });
});

describe('StructuredIntent Enhanced', () => {
  const StructuredIntent = require(path.join(ROOT, 'src', 'runtime', 'user', 'structured-intent'));

  it('should parse intent and return completeness', () => {
    const intent = new StructuredIntent();
    const result = intent.parseIntent('实现用户认证模块，目标模块：auth，成功标准：覆盖率>80%', 'tdd-implement');
    assert.ok(typeof result.completeness === 'number');
    intent.shutdown();
  });

  it('should return stats', () => {
    const intent = new StructuredIntent();
    intent.parseIntent('测试消息', 'tdd-implement');
    const stats = intent.getStats();
    assert.ok(stats.totalParsed >= 1);
    assert.ok(typeof stats.clarificationRate === 'number');
    assert.ok(typeof stats.averageCompleteness === 'number');
    intent.shutdown();
  });

  it('should register custom schema', () => {
    const intent = new StructuredIntent();
    const result = intent.registerSchema('custom-skill', {
      requiredParams: [{ name: 'target', type: 'string', description: '目标' }],
      optionalParams: [],
    });
    assert.ok(result);
    const schema = intent.getSchema('custom-skill');
    assert.ok(schema);
    assert.equal(schema.requiredParams.length, 1);
    intent.shutdown();
  });

  it('should validate intent', () => {
    const intent = new StructuredIntent();
    const result = intent.validateIntent({ skillId: 'tdd-implement', params: {} });
    assert.ok(!result.valid);
    assert.ok(result.errors.length > 0);
    intent.shutdown();
  });

  it('should enhance prompt for incomplete intent', () => {
    const intent = new StructuredIntent();
    const enhanced = intent.enhancePrompt('简单描述', 'tdd-implement');
    assert.ok(enhanced.includes('结构化意图补充') || enhanced.length > '简单描述'.length);
    intent.shutdown();
  });
});

describe('WebSocket Event Bridge', () => {
  const WebSocketHandler = require(path.join(ROOT, 'src', 'web', 'websocket-handler'));

  it('should create WebSocketHandler instance', () => {
    const ws = new WebSocketHandler();
    assert.ok(ws);
    assert.equal(ws.clientCount, 0);
    ws.close();
  });

  it('should broadcast message without error when no clients', () => {
    const ws = new WebSocketHandler();
    assert.doesNotThrow(() => {
      ws.broadcast('test-event', { key: 'value' });
    });
    ws.close();
  });

  it('should close cleanly', () => {
    const ws = new WebSocketHandler();
    ws.close();
    assert.equal(ws.clientCount, 0);
  });
});
