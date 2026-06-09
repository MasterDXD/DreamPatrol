'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const ChainOfThoughtModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'chain-of-thought'));
const ChainOfThoughtEngine = ChainOfThoughtModule.ChainOfThoughtEngine || ChainOfThoughtModule;

describe('ChainOfThoughtEngine - 构造函数', () => {
  it('默认配置创建实例', () => {
    const engine = new ChainOfThoughtEngine();
    assert.ok(engine);
    assert.strictEqual(engine._config.maxSteps, 20);
    assert.strictEqual(engine._config.maxHistoryChains, 500);
    assert.strictEqual(engine._config.defaultDepth, 'standard');
    assert.strictEqual(engine._config.convergenceThreshold, 0.85);
    assert.strictEqual(engine._config.enableSelfReflection, true);
    assert.strictEqual(engine._config.enableBacktracking, true);
    assert.strictEqual(engine._config.maxBacktrackSteps, 3);
  });

  it('自定义选项与默认配置合并', () => {
    const engine = new ChainOfThoughtEngine({
      maxSteps: 10,
      defaultDepth: 'deep',
      enableBacktracking: false,
    });
    assert.strictEqual(engine._config.maxSteps, 10);
    assert.strictEqual(engine._config.defaultDepth, 'deep');
    assert.strictEqual(engine._config.enableBacktracking, false);
    assert.strictEqual(engine._config.maxHistoryChains, 500);
  });

  it('静态常量正确导出', () => {
    assert.ok(ChainOfThoughtModule.STEP_TYPES);
    assert.strictEqual(ChainOfThoughtModule.STEP_TYPES.OBSERVE, 'observe');
    assert.strictEqual(ChainOfThoughtModule.STEP_TYPES.ANALYZE, 'analyze');
    assert.strictEqual(ChainOfThoughtModule.STEP_TYPES.HYPOTHESIZE, 'hypothesize');
    assert.strictEqual(ChainOfThoughtModule.STEP_TYPES.VERIFY, 'verify');
    assert.strictEqual(ChainOfThoughtModule.STEP_TYPES.CONCLUDE, 'conclude');
    assert.strictEqual(ChainOfThoughtModule.STEP_TYPES.REFLECT, 'reflect');

    assert.ok(ChainOfThoughtModule.DEPTH_LEVELS);
    assert.strictEqual(ChainOfThoughtModule.DEPTH_LEVELS.quick.maxSteps, 3);
    assert.strictEqual(ChainOfThoughtModule.DEPTH_LEVELS.standard.maxSteps, 5);
    assert.strictEqual(ChainOfThoughtModule.DEPTH_LEVELS.deep.maxSteps, 8);
    assert.strictEqual(ChainOfThoughtModule.DEPTH_LEVELS.intensive.maxSteps, 12);

    assert.ok(ChainOfThoughtModule.DEFAULT_CONFIG);
    assert.strictEqual(ChainOfThoughtModule.DEFAULT_CONFIG.maxSteps, 20);
    assert.strictEqual(ChainOfThoughtModule.DEFAULT_CONFIG.defaultDepth, 'standard');
  });
});

describe('ChainOfThoughtEngine - attach方法', () => {
  it('attachQualityScorer附加有效的评分器', () => {
    const engine = new ChainOfThoughtEngine();
    const scorer = { score: () => 0.9 };
    const result = engine.attachQualityScorer(scorer);
    assert.strictEqual(result, engine);
    assert.strictEqual(engine._attached.qualityScorer, true);
    assert.strictEqual(engine._qs, scorer);
  });

  it('attachQualityScorer无效评分器抛出TypeError', () => {
    const engine = new ChainOfThoughtEngine();
    assert.throws(() => engine.attachQualityScorer(null), TypeError);
    assert.throws(() => engine.attachQualityScorer({}), TypeError);
    assert.throws(() => engine.attachQualityScorer({ score: 'not-function' }), TypeError);
  });

  it('attachConvergenceDetector附加有效的检测器', () => {
    const engine = new ChainOfThoughtEngine();
    const detector = { check: () => ({ score: 0.8 }) };
    const result = engine.attachConvergenceDetector(detector);
    assert.strictEqual(result, engine);
    assert.strictEqual(engine._attached.convergenceDetector, true);
    assert.strictEqual(engine._cd, detector);
  });

  it('attachMemoryStore附加有效的存储', () => {
    const engine = new ChainOfThoughtEngine();
    const store = { storeExperience: () => {} };
    const result = engine.attachMemoryStore(store);
    assert.strictEqual(result, engine);
    assert.strictEqual(engine._attached.memoryStore, true);
    assert.strictEqual(engine._ms, store);
  });
});

describe('ChainOfThoughtEngine - startChain', () => {
  it('使用默认深度启动推理链', async () => {
    const engine = new ChainOfThoughtEngine();
    const result = await engine.startChain('分析系统性能');
    assert.ok(result.chainId);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.maxSteps, 5);
  });

  it('使用自定义深度启动推理链', async () => {
    const engine = new ChainOfThoughtEngine();
    const result = await engine.startChain('深度分析', { depth: 'deep' });
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.maxSteps, 8);
  });

  it('启动推理链触发chain-started事件', async () => {
    const engine = new ChainOfThoughtEngine();
    let eventData = null;
    engine.on('chain-started', (data) => { eventData = data; });
    const result = await engine.startChain('测试任务');
    assert.ok(eventData);
    assert.strictEqual(eventData.chainId, result.chainId);
    assert.strictEqual(eventData.task, '测试任务');
    assert.strictEqual(eventData.depth, 'standard');
  });

  it('关闭后启动推理链抛出错误', async () => {
    const engine = new ChainOfThoughtEngine();
    engine.shutdown();
    await assert.rejects(() => engine.startChain('测试任务'));
  });
});

describe('ChainOfThoughtEngine - addStep', () => {
  it('添加observe步骤', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    const step = await engine.addStep(chainId, {
      type: 'observe',
      content: 'CPU使用率95%',
      confidence: 0.9,
    });
    assert.strictEqual(step.type, 'observe');
    assert.strictEqual(step.content, 'CPU使用率95%');
    assert.strictEqual(step.confidence, 0.9);
    assert.strictEqual(step.id, 1);
  });

  it('添加analyze步骤含reasoning和evidence', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    const step = await engine.addStep(chainId, {
      type: 'analyze',
      content: '热点在数据库查询',
      reasoning: '查询耗时过长',
      evidence: ['慢查询日志', 'EXPLAIN结果'],
      confidence: 0.75,
    });
    assert.strictEqual(step.type, 'analyze');
    assert.strictEqual(step.reasoning, '查询耗时过长');
    assert.deepStrictEqual(step.evidence, ['慢查询日志', 'EXPLAIN结果']);
    assert.strictEqual(step.confidence, 0.75);
  });

  it('置信度被裁剪到[0,1]范围', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    const stepHigh = await engine.addStep(chainId, {
      type: 'observe',
      content: '高置信度',
      confidence: 1.5,
    });
    assert.strictEqual(stepHigh.confidence, 1);
    const stepLow = await engine.addStep(chainId, {
      type: 'observe',
      content: '低置信度',
      confidence: -0.3,
    });
    assert.strictEqual(stepLow.confidence, 0);
  });

  it('向无效推理链添加步骤抛出错误', async () => {
    const engine = new ChainOfThoughtEngine();
    await assert.rejects(
      () => engine.addStep('invalid-id', { type: 'observe', content: '测试' }),
      { message: /推理链不存在/ },
    );
  });

  it('添加步骤触发step-added事件', async () => {
    const engine = new ChainOfThoughtEngine();
    let eventData = null;
    engine.on('step-added', (data) => { eventData = data; });
    const { chainId } = await engine.startChain('测试任务');
    const step = await engine.addStep(chainId, {
      type: 'observe',
      content: '观察数据',
      confidence: 0.8,
    });
    assert.ok(eventData);
    assert.strictEqual(eventData.chainId, chainId);
    assert.strictEqual(eventData.step.id, step.id);
    assert.strictEqual(eventData.step.type, 'observe');
  });
});

describe('ChainOfThoughtEngine - backtrack', () => {
  it('回溯移除目标索引之后的步骤', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    await engine.addStep(chainId, { type: 'observe', content: '步骤0' });
    await engine.addStep(chainId, { type: 'analyze', content: '步骤1' });
    await engine.addStep(chainId, { type: 'hypothesize', content: '步骤2' });
    const result = await engine.backtrack(chainId, 0);
    assert.strictEqual(result.backtrackedTo, 0);
    assert.strictEqual(result.removedCount, 2);
    const chain = engine.getChain(chainId);
    assert.strictEqual(chain.steps.length, 1);
    assert.strictEqual(chain.steps[0].content, '步骤0');
  });

  it('回溯触发chain-backtracked事件', async () => {
    const engine = new ChainOfThoughtEngine();
    let eventData = null;
    engine.on('chain-backtracked', (data) => { eventData = data; });
    const { chainId } = await engine.startChain('测试任务');
    await engine.addStep(chainId, { type: 'observe', content: '步骤0' });
    await engine.addStep(chainId, { type: 'analyze', content: '步骤1' });
    await engine.backtrack(chainId, 0);
    assert.ok(eventData);
    assert.strictEqual(eventData.chainId, chainId);
    assert.strictEqual(eventData.toStepIndex, 0);
    assert.strictEqual(eventData.removedCount, 1);
  });

  it('回溯功能禁用时抛出错误', async () => {
    const engine = new ChainOfThoughtEngine({ enableBacktracking: false });
    const { chainId } = await engine.startChain('测试任务');
    await engine.addStep(chainId, { type: 'observe', content: '步骤0' });
    await assert.rejects(
      () => engine.backtrack(chainId, 0),
      { message: /回溯功能已禁用/ },
    );
  });
});

describe('ChainOfThoughtEngine - concludeChain', () => {
  it('结束推理链并返回结论', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    await engine.addStep(chainId, { type: 'observe', content: '观察数据', confidence: 0.9 });
    const result = await engine.concludeChain(chainId, '最终结论');
    assert.strictEqual(result.chainId, chainId);
    assert.strictEqual(result.conclusion, '最终结论');
    assert.strictEqual(typeof result.convergenceScore, 'number');
    assert.ok(result.steps >= 1);
  });

  it('结束推理链触发chain-completed事件', async () => {
    const engine = new ChainOfThoughtEngine();
    let eventData = null;
    engine.on('chain-completed', (data) => { eventData = data; });
    const { chainId } = await engine.startChain('测试任务');
    await engine.addStep(chainId, { type: 'observe', content: '观察', confidence: 0.8 });
    await engine.concludeChain(chainId, '结论');
    assert.ok(eventData);
    assert.strictEqual(eventData.chainId, chainId);
    assert.strictEqual(typeof eventData.convergenceScore, 'number');
    assert.strictEqual(typeof eventData.stepCount, 'number');
  });

  it('结束推理链计算收敛评分', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    await engine.addStep(chainId, { type: 'observe', content: '观察', confidence: 0.9 });
    await engine.addStep(chainId, { type: 'analyze', content: '分析', confidence: 0.8 });
    const result = await engine.concludeChain(chainId, '结论');
    assert.ok(result.convergenceScore >= 0 && result.convergenceScore <= 1);
    const stats = engine.getStats();
    assert.ok(stats.avgConvergenceScore > 0);
  });
});

describe('ChainOfThoughtEngine - formatChainAsMarkdown', () => {
  it('格式化生成包含所有步骤的有效Markdown', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('性能分析');
    await engine.addStep(chainId, { type: 'observe', content: 'CPU使用率高', confidence: 0.9 });
    await engine.addStep(chainId, {
      type: 'analyze',
      content: '数据库查询慢',
      reasoning: '缺少索引',
      evidence: ['慢查询日志'],
      confidence: 0.75,
    });
    await engine.concludeChain(chainId, '添加索引解决');
    const md = engine.formatChainAsMarkdown(chainId);
    assert.ok(md.includes('# 思维链: 性能分析'));
    assert.ok(md.includes('步骤 1: 观察'));
    assert.ok(md.includes('步骤 2: 分析'));
    assert.ok(md.includes('CPU使用率高'));
    assert.ok(md.includes('缺少索引'));
    assert.ok(md.includes('慢查询日志'));
    assert.ok(md.includes('90%'));
    assert.ok(md.includes('75%'));
    assert.ok(md.includes('结论'));
    assert.ok(md.includes('添加索引解决'));
  });

  it('无效链ID返回空字符串', () => {
    const engine = new ChainOfThoughtEngine();
    const result = engine.formatChainAsMarkdown('nonexistent-id');
    assert.strictEqual(result, '');
  });
});

describe('ChainOfThoughtEngine - getStats/getChain', () => {
  it('getStats返回初始统计', () => {
    const engine = new ChainOfThoughtEngine();
    const stats = engine.getStats();
    assert.strictEqual(stats.chainsCreated, 0);
    assert.strictEqual(stats.stepsExecuted, 0);
    assert.strictEqual(stats.backtracksUsed, 0);
    assert.strictEqual(stats.avgConvergenceScore, 0);
    assert.strictEqual(stats.activeChains, 0);
    assert.deepStrictEqual(stats.attached, {
      qualityScorer: false,
      convergenceDetector: false,
      memoryStore: false,
    });
  });

  it('getChain根据ID返回推理链', async () => {
    const engine = new ChainOfThoughtEngine();
    const { chainId } = await engine.startChain('测试任务');
    const chain = engine.getChain(chainId);
    assert.ok(chain);
    assert.strictEqual(chain.id, chainId);
    assert.strictEqual(chain.task, '测试任务');
    assert.strictEqual(chain.status, 'active');
  });

  it('getActiveChain返回当前活跃推理链', async () => {
    const engine = new ChainOfThoughtEngine();
    assert.strictEqual(engine.getActiveChain(), null);
    const { chainId } = await engine.startChain('活跃任务');
    const active = engine.getActiveChain();
    assert.ok(active);
    assert.strictEqual(active.id, chainId);
    assert.strictEqual(active.task, '活跃任务');
  });
});

describe('ChainOfThoughtEngine - shutdown', () => {
  it('关闭后清除所有状态', async () => {
    const engine = new ChainOfThoughtEngine();
    await engine.startChain('测试任务');
    engine.attachQualityScorer({ score: () => 0.5 });
    engine.shutdown();
    assert.strictEqual(engine._activeChain, null);
    assert.strictEqual(engine._stepCounter, 0);
    assert.strictEqual(engine._qs, null);
    assert.strictEqual(engine._cd, null);
    assert.strictEqual(engine._ms, null);
    assert.deepStrictEqual(engine._attached, {
      qualityScorer: false,
      convergenceDetector: false,
      memoryStore: false,
    });
    assert.strictEqual(engine._convergenceSum, 0);
    assert.strictEqual(engine._convergenceCount, 0);
  });
});
