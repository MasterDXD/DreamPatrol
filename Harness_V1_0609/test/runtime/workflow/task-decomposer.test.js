'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TaskDecomposer = require(
  path.join(ROOT, 'src', 'runtime', 'workflow', 'task-decomposer'),
);
const DECOMPOSITION_STRATEGY = TaskDecomposer.DECOMPOSITION_STRATEGY;
const SUBTASK_STATUS = TaskDecomposer.SUBTASK_STATUS;

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('TaskDecomposer', () => {
  afterEach(async () => { await _cleanAll(); });

  it('should construct with default config', () => {
    const td = _track(new TaskDecomposer());
    assert.ok(td);
    assert.strictEqual(td._config.maxSubtasks, 10);
    assert.strictEqual(td._config.maxDecompositionDepth, 3);
    assert.strictEqual(td._config.minSubtaskGranularity, 'step');
    assert.strictEqual(td._config.requireEstimates, true);
    assert.strictEqual(td.isHealthy(), true);
  });

  it('should decompose with sequential keywords (然后/接着)', () => {
    const td = _track(new TaskDecomposer());
    const result = td.decompose('分析数据然后生成报告接着发送邮件');
    assert.ok(result.id);
    assert.strictEqual(result.strategy, DECOMPOSITION_STRATEGY.SEQUENTIAL);
    assert.ok(result.subtasks.length >= 2);
    assert.strictEqual(result.subtasks[0].status, SUBTASK_STATUS.PENDING);
  });

  it('should decompose with parallel keywords (同时/并行)', () => {
    const td = _track(new TaskDecomposer());
    const result = td.decompose('查询数据库同时调用API并行处理结果');
    assert.ok(result.id);
    assert.strictEqual(result.strategy, DECOMPOSITION_STRATEGY.PARALLEL);
    assert.ok(result.subtasks.length >= 2);
  });

  it('should reject empty task', () => {
    const td = _track(new TaskDecomposer());
    assert.throws(() => td.decompose(''), /Task must be a non-empty string/);
    assert.throws(() => td.decompose(null), /Task must be a non-empty string/);
  });

  it('should respect maxSubtasks limit', () => {
    const td = _track(new TaskDecomposer({ maxSubtasks: 2 }));
    const result = td.decompose('第一步分析然后设计接着开发之后测试最后部署');
    assert.ok(result.subtasks.length <= 2);
  });

  it('should _inferStrategy detect sequential', () => {
    const td = _track(new TaskDecomposer());
    const strategy = td._inferStrategy('先分析然后实现');
    assert.strictEqual(strategy, DECOMPOSITION_STRATEGY.SEQUENTIAL);
  });

  it('should _inferStrategy detect parallel', () => {
    const td = _track(new TaskDecomposer());
    const strategy = td._inferStrategy('同时处理多个任务');
    assert.strictEqual(strategy, DECOMPOSITION_STRATEGY.PARALLEL);
  });

  it('should getDecomposition return defensive copy', () => {
    const td = _track(new TaskDecomposer());
    const result = td.decompose('分析数据然后生成报告');
    const copy = td.getDecomposition(result.id);
    assert.ok(copy);
    copy.subtasks[0].description = 'tampered';
    const original = td.getDecomposition(result.id);
    assert.notStrictEqual(original.subtasks[0].description, 'tampered');
  });

  it('should attachLlmClient return this', () => {
    const td = _track(new TaskDecomposer());
    const returned = td.attachLlmClient({ decompose: () => [] });
    assert.strictEqual(returned, td);
  });

  it('should prevent operations after shutdown', () => {
    const td = _track(new TaskDecomposer());
    td.shutdown();
    assert.throws(() => td.decompose('some task'), /shut down/);
  });
});
