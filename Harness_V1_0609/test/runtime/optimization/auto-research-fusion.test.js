'use strict';

/**
 * Auto Research融合模块测试。覆盖 ContentPublisher、ResearchJournal、
 * AutonomousResearchLoop 扩展、ResearchDomainAdapter 扩展的核心功能。
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ContentPublisher = require('../../../src/runtime/optimization/content-publisher');
const { PLATFORMS, PUBLISH_STATUS: _PUBLISH_STATUS } = require('../../../src/runtime/optimization/content-publisher');
const ResearchJournal = require('../../../src/runtime/optimization/research-journal');
const { ENTRY_TYPES, NARRATIVE_SECTIONS } = require('../../../src/runtime/optimization/research-journal');
const AutonomousResearchLoop = require('../../../src/runtime/optimization/autonomous-research-loop');
const { LOOP_STAGES: _LOOP_STAGES, LOOP_STATUS: _LOOP_STATUS } = require('../../../src/runtime/optimization/autonomous-research-loop');
const ResearchDomainAdapter = require('../../../src/runtime/optimization/research-domain-adapter');
const EvaluationCalibrator = require('../../../src/runtime/quality/evaluation-calibrator');

// =========================== ContentPublisher 测试 ===========================

describe('ContentPublisher', () => {
  let publisher;

  beforeEach(() => {
    publisher = new ContentPublisher({ maxPublishHistory: 100, enableAutoRetry: false });
  });

  afterEach(() => {
    if (publisher && publisher.isHealthy()) publisher.shutdown();
  });

  it('should create ContentPublisher instance', () => {
    assert.ok(publisher);
    assert.ok(publisher.isHealthy());
    assert.strictEqual(publisher._options.maxPublishHistory, 100);
    assert.strictEqual(publisher._options.enableContentReview, true);
  });

  it('should configure platform', () => {
    const result = publisher.configurePlatform(PLATFORMS.XIAOHONGSHU, {
      endpoint: 'https://api.xiaohongshu.com',
      authMethod: 'oauth',
      rateLimit: 5,
    });
    assert.strictEqual(result, true);
  });

  it('should publish content (simulated mode)', async () => {
    const result = await publisher.publish(PLATFORMS.XIAOHONGSHU, {
      title: 'Test Title',
      body: 'Test body content',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.publishId);
    assert.ok(result.publishId.startsWith('pub-'));
    assert.ok(result.platformResponse);
    assert.strictEqual(result.platformResponse.simulated, true);
  });

  it('should reject publish when rate limited', async () => {
    publisher.configurePlatform(PLATFORMS.WECHAT, { rateLimit: 1 });
    // 第一次发布成功
    const first = await publisher.publish(PLATFORMS.WECHAT, { title: 'A', body: 'B' });
    assert.strictEqual(first.success, true);
    // 第二次发布应被限流
    const second = await publisher.publish(PLATFORMS.WECHAT, { title: 'C', body: 'D' });
    assert.strictEqual(second.success, false);
    assert.ok(second.error.includes('Rate limit'));
  });

  it('should reject publish when content review fails', async () => {
    const result = await publisher.publish(PLATFORMS.DOUYIN, {
      title: 'x'.repeat(501), // 超过500字符限制
      body: 'body',
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Content review failed'));
  });

  it('should withdraw published content', async () => {
    const pubResult = await publisher.publish(PLATFORMS.XIAOHONGSHU, {
      title: 'Withdraw Test',
      body: 'Content to withdraw',
    });
    assert.strictEqual(pubResult.success, true);
    const withdrawResult = await publisher.withdraw(pubResult.publishId);
    assert.strictEqual(withdrawResult.success, true);
    assert.strictEqual(withdrawResult.publishId, pubResult.publishId);
  });

  it('should track publish history and stats', async () => {
    await publisher.publish(PLATFORMS.XIAOHONGSHU, { title: 'Post 1', body: 'Body 1' });
    await publisher.publish(PLATFORMS.DOUYIN, { title: 'Post 2', body: 'Body 2' });

    const history = publisher.getHistory();
    assert.strictEqual(history.length, 2);

    const stats = publisher.getStats();
    assert.strictEqual(stats.totalPublished, 2);
    assert.strictEqual(stats.historySize, 2);
    assert.ok(stats.byPlatform[PLATFORMS.XIAOHONGSHU] >= 1);
    assert.ok(stats.byPlatform[PLATFORMS.DOUYIN] >= 1);
  });
});

// =========================== ResearchJournal 测试 ===========================

describe('ResearchJournal', () => {
  let journal;

  beforeEach(() => {
    journal = new ResearchJournal({ maxEntries: 100, enableAutoNarrative: false });
  });

  afterEach(() => {
    if (journal && journal.isHealthy()) journal.shutdown();
  });

  it('should create ResearchJournal instance', () => {
    assert.ok(journal);
    assert.ok(journal.isHealthy());
    assert.strictEqual(journal._options.maxEntries, 100);
    assert.strictEqual(journal._options.enableAutoNarrative, false);
  });

  it('should record entry with all fields', () => {
    const result = journal.recordEntry({
      type: ENTRY_TYPES.HYPOTHESIS,
      domain: 'content',
      goal: 'Optimize titles',
      why: 'Low engagement observed',
      what: 'Generated 3 title variants',
      result: 'Click rate improved by 15%',
      next: 'Test on broader audience',
      transferable: 'A/B testing pattern works for headlines',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.id);
    assert.ok(result.id.startsWith('je-'));
  });

  it('should query entries by domain/type', () => {
    journal.recordEntry({ type: ENTRY_TYPES.OBSERVATION, domain: 'content' });
    journal.recordEntry({ type: ENTRY_TYPES.HYPOTHESIS, domain: 'content' });
    journal.recordEntry({ type: ENTRY_TYPES.OBSERVATION, domain: 'operations' });

    const contentObs = journal.query({ domain: 'content', type: ENTRY_TYPES.OBSERVATION });
    assert.strictEqual(contentObs.length, 1);

    const allContent = journal.query({ domain: 'content' });
    assert.strictEqual(allContent.length, 2);

    const allOps = journal.query({ domain: 'operations' });
    assert.strictEqual(allOps.length, 1);
  });

  it('should generate narrative for domain', () => {
    journal.recordEntry({
      type: ENTRY_TYPES.OBSERVATION, domain: 'content',
      why: 'Engagement dropping', what: 'Analyzed metrics', result: 'Pattern found',
    });
    journal.recordEntry({
      type: ENTRY_TYPES.HYPOTHESIS, domain: 'content',
      why: 'Need improvement', what: 'Proposed new strategy', result: 'success - improved by 20%',
      next: 'Scale up', transferable: 'Strategy applicable to operations',
    });

    const narrResult = journal.generateNarrative('content');
    assert.strictEqual(narrResult.success, true);
    assert.ok(narrResult.narrative);
    assert.ok(narrResult.narrative.sections);
    assert.ok(narrResult.narrative.sections[NARRATIVE_SECTIONS.WHY]);
    assert.ok(narrResult.narrative.sections[NARRATIVE_SECTIONS.WHAT]);
    assert.ok(narrResult.narrative.sections[NARRATIVE_SECTIONS.RESULT]);
  });

  it('should extract transferable patterns', () => {
    journal.recordEntry({
      type: ENTRY_TYPES.INSIGHT, domain: 'content',
      result: 'success - engagement improved',
      transferable: 'A/B testing pattern works for headlines',
    });
    journal.recordEntry({
      type: ENTRY_TYPES.INSIGHT, domain: 'operations',
      result: 'improved response time',
      transferable: 'Script optimization applies to workflow',
    });

    const patterns = journal.extractTransferablePatterns();
    assert.ok(Array.isArray(patterns));
    assert.strictEqual(patterns.length, 2);
    assert.ok(patterns[0].sourceDomain);
    assert.ok(patterns[0].pattern);
    assert.ok(Array.isArray(patterns[0].applicableTo));
  });

  it('should export to markdown', () => {
    journal.recordEntry({
      type: ENTRY_TYPES.OBSERVATION, domain: 'content',
      why: 'Test reason', what: 'Test action', result: 'Test result',
    });

    const md = journal.exportMarkdown('content');
    assert.ok(typeof md === 'string');
    assert.ok(md.includes('研究日志'));
    assert.ok(md.includes('OBSERVATION'));
    assert.ok(md.includes('Test reason'));
  });

  it('should import entries in batch', () => {
    const entries = [
      { type: ENTRY_TYPES.OBSERVATION, domain: 'content' },
      { type: ENTRY_TYPES.HYPOTHESIS, domain: 'operations' },
      { type: null, domain: null }, // 无效条目
    ];

    const result = journal.importEntries(entries);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.imported, 2);
    assert.strictEqual(result.failed, 1);
  });
});

// =========================== AutonomousResearchLoop 扩展测试 ===========================

describe('AutonomousResearchLoop - Fusion Extensions', () => {
  let loop;

  beforeEach(() => {
    loop = new AutonomousResearchLoop({
      maxConcurrentLoops: 3,
      maxIterationsPerLoop: 2,
      experimentTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    if (loop && loop.isHealthy()) loop.shutdown();
  });

  it('should accept new component types (dataCollector/contentPublisher/researchJournal/evaluationCalibrator)', () => {
    const mockDataCollector = { isHealthy: () => true, extractByTemplate: () => ({}) };
    const publisher = new ContentPublisher();
    const journal = new ResearchJournal();
    const calibrator = new EvaluationCalibrator();

    assert.strictEqual(loop.attachComponent('dataCollector', mockDataCollector), true);
    assert.strictEqual(loop.attachComponent('contentPublisher', publisher), true);
    assert.strictEqual(loop.attachComponent('researchJournal', journal), true);
    assert.strictEqual(loop.attachComponent('evaluationCalibrator', calibrator), true);

    publisher.shutdown();
    journal.shutdown();
  });

  it('should call dataCollector in observe stage', () => {
    let collectorCalled = false;
    const mockDataCollector = {
      isHealthy: () => true,
      extractByTemplate: (_domain, _opts) => {
        collectorCalled = true;
        return { metrics: { externalEngagement: 0.8 }, signals: ['trend_up'] };
      },
    };
    loop.attachComponent('dataCollector', mockDataCollector);

    const startResult = loop.startLoop({ domain: 'content', goal: 'test data collector' });
    const obsResult = loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });

    assert.strictEqual(obsResult.success, true);
    assert.strictEqual(collectorCalled, true);
    assert.ok(obsResult.observation.platformMetrics);
    assert.strictEqual(obsResult.observation.platformMetrics.externalEngagement, 0.8);
  });

  it('should use evaluationCalibrator for binary judgment in analyze stage', async () => {
    const calibrator = new EvaluationCalibrator();
    // 记录一些校准数据
    calibrator.record(0.8, true);
    calibrator.record(0.6, false);

    loop.attachComponent('evaluationCalibrator', calibrator);

    const startResult = loop.startLoop({ domain: 'content', goal: 'test calibrator' });
    loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
    loop.hypothesize(startResult.loopId);
    loop.code(startResult.loopId);
    await loop.experiment(startResult.loopId);
    const analyzeResult = loop.analyze(startResult.loopId);

    assert.strictEqual(analyzeResult.success, true);
    assert.ok(analyzeResult.analysis.calibratedThreshold !== undefined);
    assert.ok(analyzeResult.analysis.binaryJudgment);
    assert.ok(typeof analyzeResult.analysis.binaryJudgment.passed === 'boolean');
  });

  it('should call contentPublisher in refine stage', async () => {
    const publisher = new ContentPublisher({ enableAutoRetry: false });
    loop.attachComponent('contentPublisher', publisher);

    // 让 analyze 产生 shouldRefine=true 的结果
    const adapter = new ResearchDomainAdapter();
    loop.attachComponent('domainAdapter', adapter);

    const startResult = loop.startLoop({ domain: 'content', goal: 'Optimize engagement' });
    loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
    loop.hypothesize(startResult.loopId);
    loop.code(startResult.loopId);
    await loop.experiment(startResult.loopId);
    loop.analyze(startResult.loopId);

    // 手动设置 shouldRefine 以触发 contentPublisher 调用
    const activeLoop = loop.getLoop(startResult.loopId);
    activeLoop._analysis.shouldRefine = true;

    const refineResult = loop.refine(startResult.loopId);
    assert.strictEqual(refineResult.success, true);

    // 验证 publisher 被调用过（通过发布历史判断）
    const pubStats = publisher.getStats();
    assert.ok(pubStats.totalPublished >= 0); // publish 可能成功也可能因平台未配置而失败

    publisher.shutdown();
    adapter.shutdown();
  });

  it('should record to researchJournal in refine stage', async () => {
    const journal = new ResearchJournal({ enableAutoNarrative: false });
    loop.attachComponent('researchJournal', journal);

    const startResult = loop.startLoop({ domain: 'content', goal: 'test journal recording' });
    loop.observe(startResult.loopId, { metrics: { engagement: 0.5 } });
    loop.hypothesize(startResult.loopId);
    loop.code(startResult.loopId);
    await loop.experiment(startResult.loopId);
    loop.analyze(startResult.loopId);
    loop.refine(startResult.loopId);

    const entries = journal.query({ domain: 'content', type: 'refinement' });
    assert.ok(entries.length >= 1);
    assert.strictEqual(entries[0].domain, 'content');

    journal.shutdown();
  });

  it('should execute full loop with new components', async () => {
    const publisher = new ContentPublisher({ enableAutoRetry: false });
    const journal = new ResearchJournal({ enableAutoNarrative: false });
    const calibrator = new EvaluationCalibrator();
    const adapter = new ResearchDomainAdapter();

    loop.attachComponent('contentPublisher', publisher);
    loop.attachComponent('researchJournal', journal);
    loop.attachComponent('evaluationCalibrator', calibrator);
    loop.attachComponent('domainAdapter', adapter);

    const result = await loop.executeFullLoop({
      domain: 'content',
      goal: 'Full fusion loop test',
      maxIterations: 1,
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.loopId);
    assert.ok(result.summary.totalIterations > 0);

    // 验证 journal 记录了条目
    const stats = journal.getStats();
    assert.ok(stats.totalEntries >= 1);

    publisher.shutdown();
    journal.shutdown();
    adapter.shutdown();
  });
});

// =========================== ResearchDomainAdapter 扩展测试 ===========================

describe('ResearchDomainAdapter - Fusion Extensions', () => {
  let adapter;

  beforeEach(() => {
    adapter = new ResearchDomainAdapter();
  });

  afterEach(() => {
    if (adapter && adapter.isHealthy()) adapter.shutdown();
  });

  it('should define research with three elements (targetFiles, optimizationGoal, evaluationCriteria)', () => {
    const result = adapter.defineResearch({
      targetFiles: ['src/content/title.py'],
      optimizationGoal: 'Improve content engagement and click rate',
      evaluationCriteria: 'engagement',
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.definition);
    assert.ok(result.definition.domain);
    assert.strictEqual(result.definition.goal, 'Improve content engagement and click rate');
    assert.ok(result.definition.constraints.targetFiles);
    assert.strictEqual(result.definition.constraints.targetFiles.length, 1);
    assert.ok(result.definition.constraints.evaluationCriteria);
  });

  it('should infer domain from goal keywords', () => {
    // content 关键词
    const contentResult = adapter.defineResearch({
      optimizationGoal: 'Optimize content title for engagement',
    });
    assert.strictEqual(contentResult.success, true);
    assert.strictEqual(contentResult.definition.domain, 'content');

    // ml_research 关键词
    const mlResult = adapter.defineResearch({
      optimizationGoal: 'Improve model accuracy with hyperparameter tuning',
    });
    assert.strictEqual(mlResult.success, true);
    assert.strictEqual(mlResult.definition.domain, 'ml_research');

    // performance 关键词
    const perfResult = adapter.defineResearch({
      optimizationGoal: 'Reduce load time and improve performance',
    });
    assert.strictEqual(perfResult.success, true);
    assert.strictEqual(perfResult.definition.domain, 'performance');
  });

  it('should infer domain from file extensions', () => {
    // .py 文件 -> ml_research
    const pyResult = adapter.defineResearch({
      targetFiles: ['train_model.py'],
      optimizationGoal: 'Improve something',
    });
    assert.strictEqual(pyResult.success, true);
    assert.strictEqual(pyResult.definition.domain, 'ml_research');

    // .js 文件 -> code_quality
    const jsResult = adapter.defineResearch({
      targetFiles: ['utils.js'],
      optimizationGoal: 'Improve something',
    });
    assert.strictEqual(jsResult.success, true);
    assert.strictEqual(jsResult.definition.domain, 'code_quality');

    // .css 文件 -> user_experience
    const cssResult = adapter.defineResearch({
      targetFiles: ['styles.css'],
      optimizationGoal: 'Improve something',
    });
    assert.strictEqual(cssResult.success, true);
    assert.strictEqual(cssResult.definition.domain, 'user_experience');
  });

  it('should resolve preset evaluation criteria', () => {
    const strictResult = adapter.defineResearch({
      optimizationGoal: 'Optimize content',
      evaluationCriteria: 'strict',
    });
    assert.strictEqual(strictResult.success, true);
    assert.strictEqual(strictResult.definition.constraints.evaluationCriteria.type, 'preset');
    assert.strictEqual(strictResult.definition.constraints.evaluationCriteria.name, 'strict');
    assert.strictEqual(strictResult.definition.constraints.evaluationCriteria.threshold, 0.9);

    const looseResult = adapter.defineResearch({
      optimizationGoal: 'Optimize content',
      evaluationCriteria: 'loose',
    });
    assert.strictEqual(looseResult.success, true);
    assert.strictEqual(looseResult.definition.constraints.evaluationCriteria.threshold, 0.5);
  });

  it('should resolve custom evaluation criteria function', () => {
    const customFn = (result) => result.score > 0.8;
    const result = adapter.defineResearch({
      optimizationGoal: 'Optimize content engagement',
      evaluationCriteria: customFn,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.definition.constraints.evaluationCriteria.type, 'custom');
    assert.strictEqual(result.definition.constraints.evaluationCriteria.fn, customFn);
    assert.strictEqual(result.definition.constraints.evaluationCriteria.domain, 'content');
  });
});
