'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const DigitalTwinEngine = require('../../../src/runtime/user/digital-twin-engine');

describe('DigitalTwinEngine - 构造函数', () => {
  it('默认配置初始化', () => {
    const engine = new DigitalTwinEngine();
    assert.ok(engine);
    assert.strictEqual(engine._config.maxBehaviorRecords, 1000);
    assert.strictEqual(engine._config.maxPatterns, 200);
    assert.strictEqual(engine._config.maxPredictions, 100);
    assert.strictEqual(engine._config.enableAutoLearning, true);
    engine.shutdown();
  });

  it('自定义选项覆盖默认配置', () => {
    const engine = new DigitalTwinEngine({
      maxBehaviorRecords: 500,
      maxPatterns: 50,
      enableAutoLearning: false,
    });
    assert.strictEqual(engine._config.maxBehaviorRecords, 500);
    assert.strictEqual(engine._config.maxPatterns, 50);
    assert.strictEqual(engine._config.enableAutoLearning, false);
    engine.shutdown();
  });

  it('静态常量正确暴露', () => {
    assert.ok(DigitalTwinEngine.BEHAVIOR_TYPES);
    assert.ok(DigitalTwinEngine.DECISION_PATTERNS);
    assert.ok(DigitalTwinEngine.DEFAULT_CONFIG);
    assert.strictEqual(DigitalTwinEngine.BEHAVIOR_TYPES.CODING, 'coding');
    assert.strictEqual(DigitalTwinEngine.BEHAVIOR_TYPES.DECISION, 'decision');
    assert.strictEqual(DigitalTwinEngine.DECISION_PATTERNS.CONSERVATIVE, 'conservative');
    assert.strictEqual(DigitalTwinEngine.DECISION_PATTERNS.BALANCED, 'balanced');
    assert.strictEqual(DigitalTwinEngine.DEFAULT_CONFIG.maxBehaviorRecords, 1000);
  });
});

describe('DigitalTwinEngine - attach方法', () => {
  it('attachUserModelManager注入有效实例', () => {
    const engine = new DigitalTwinEngine();
    const mockUmm = { getPreference: () => null };
    const result = engine.attachUserModelManager(mockUmm);
    assert.strictEqual(result, engine);
    assert.strictEqual(engine._attached.userModelManager, true);
    engine.shutdown();
  });

  it('attachKnowledgeGraph注入有效实例', () => {
    const engine = new DigitalTwinEngine();
    const mockKg = { query: () => null };
    const result = engine.attachKnowledgeGraph(mockKg);
    assert.strictEqual(result, engine);
    assert.strictEqual(engine._attached.knowledgeGraph, true);
    engine.shutdown();
  });
});

describe('DigitalTwinEngine - recordBehavior', () => {
  it('记录编码行为', () => {
    const engine = new DigitalTwinEngine();
    const record = engine.recordBehavior({
      type: 'coding',
      action: 'wrote-unit-test',
      context: { language: 'javascript' },
    });
    assert.ok(record);
    assert.strictEqual(record.type, 'coding');
    assert.strictEqual(record.action, 'wrote-unit-test');
    assert.strictEqual(record.context.language, 'javascript');
    engine.shutdown();
  });

  it('记录决策行为', () => {
    const engine = new DigitalTwinEngine();
    const record = engine.recordBehavior({
      type: 'decision',
      action: 'chose-stable-library',
      context: { reason: 'stable and proven' },
    });
    assert.ok(record);
    assert.strictEqual(record.type, 'decision');
    assert.strictEqual(record.action, 'chose-stable-library');
    engine.shutdown();
  });

  it('记录行为触发behavior-recorded事件', () => {
    const engine = new DigitalTwinEngine();
    let eventFired = false;
    let eventData = null;
    engine.on('behavior-recorded', (data) => {
      eventFired = true;
      eventData = data;
    });
    engine.recordBehavior({
      type: 'coding',
      action: 'refactored-module',
      context: {},
    });
    assert.strictEqual(eventFired, true);
    assert.strictEqual(eventData.type, 'coding');
    assert.ok(eventData.behaviorId);
    engine.shutdown();
  });
});

describe('DigitalTwinEngine - getDecisionStyle', () => {
  it('无数据时返回balanced', () => {
    const engine = new DigitalTwinEngine();
    const style = engine.getDecisionStyle();
    assert.strictEqual(style, 'balanced');
    engine.shutdown();
  });

  it('记录决策后返回对应风格', () => {
    const engine = new DigitalTwinEngine();
    engine.recordBehavior({
      type: 'decision',
      action: 'chose-stable',
      context: { reason: 'stable and proven approach' },
    });
    engine.recordBehavior({
      type: 'decision',
      action: 'chose-safe',
      context: { reason: 'safe and conservative choice' },
    });
    const style = engine.getDecisionStyle();
    assert.strictEqual(style, 'conservative');
    engine.shutdown();
  });
});

describe('DigitalTwinEngine - predictNextAction', () => {
  it('返回预测结果', () => {
    const engine = new DigitalTwinEngine();
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-unit-test',
      context: { language: 'javascript' },
    });
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-unit-test',
      context: { language: 'javascript' },
    });
    const prediction = engine.predictNextAction({ language: 'javascript' });
    assert.ok(prediction);
    assert.ok(prediction.id);
    assert.strictEqual(prediction.predictedAction, 'wrote-unit-test');
    engine.shutdown();
  });

  it('预测结果包含置信度', () => {
    const engine = new DigitalTwinEngine();
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-unit-test',
      context: { language: 'javascript' },
    });
    const prediction = engine.predictNextAction({ language: 'javascript' });
    assert.ok(typeof prediction.confidence === 'number');
    assert.ok(prediction.confidence >= 0);
    assert.ok(prediction.confidence <= 1);
    engine.shutdown();
  });
});

describe('DigitalTwinEngine - getTwinProfile', () => {
  it('返回完整画像', () => {
    const engine = new DigitalTwinEngine();
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-code',
      context: { language: 'javascript' },
    });
    const profile = engine.getTwinProfile();
    assert.ok(profile);
    assert.ok('decisionStyle' in profile);
    assert.ok('techPreferences' in profile);
    assert.ok('workPatterns' in profile);
    assert.ok('learningCurve' in profile);
    assert.ok('behaviorCounts' in profile);
    assert.ok('patternCount' in profile);
    assert.ok('lastUpdated' in profile);
    assert.strictEqual(typeof profile.behaviorCounts.coding, 'number');
    engine.shutdown();
  });
});

describe('DigitalTwinEngine - 自动学习', () => {
  it('startAutoLearning/stopAutoLearning正常工作', () => {
    const engine = new DigitalTwinEngine({ learningInterval: 100 });
    engine.startAutoLearning();
    assert.ok(engine._learningTimer !== null);
    engine.stopAutoLearning();
    assert.strictEqual(engine._learningTimer, null);
    engine.shutdown();
  });

  it('自动学习定时器触发分析', (t, done) => {
    const engine = new DigitalTwinEngine({ learningInterval: 50 });
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-test',
      context: { language: 'javascript' },
    });
    let analyzed = false;
    engine.on('patterns-analyzed', () => { analyzed = true; });
    engine.startAutoLearning();
    setTimeout(() => {
      engine.stopAutoLearning();
      assert.strictEqual(analyzed, true);
      engine.shutdown();
      done();
    }, 120);
  });
});

describe('DigitalTwinEngine - getStats', () => {
  it('返回统计数据', () => {
    const engine = new DigitalTwinEngine();
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-code',
      context: {},
    });
    const stats = engine.getStats();
    assert.strictEqual(stats.behaviorsRecorded, 1);
    assert.strictEqual(stats.patternsRecognized, 0);
    assert.strictEqual(stats.predictionsMade, 0);
    assert.strictEqual(stats.autoLearnings, 0);
    assert.strictEqual(stats.hasUserModelManager, false);
    assert.strictEqual(stats.hasKnowledgeGraph, false);
    engine.shutdown();
  });
});

describe('DigitalTwinEngine - shutdown', () => {
  it('关闭后清空状态并停止自动学习', () => {
    const engine = new DigitalTwinEngine();
    engine.recordBehavior({
      type: 'coding',
      action: 'wrote-code',
      context: {},
    });
    engine.startAutoLearning();
    engine.shutdown();
    assert.strictEqual(engine._learningTimer, null);
    assert.strictEqual(engine._behaviors.size, 0);
    assert.strictEqual(engine._patterns.size, 0);
    assert.strictEqual(engine._stats.behaviorsRecorded, 0);
    assert.strictEqual(engine._attached.userModelManager, false);
    assert.strictEqual(engine._attached.knowledgeGraph, false);
  });
});
