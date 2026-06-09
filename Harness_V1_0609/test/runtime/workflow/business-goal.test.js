'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('BusinessGoal', () => {
  const BusinessGoal = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'business-goal'));

  it('should construct with default config', () => {
    const bg = new BusinessGoal();
    assert.strictEqual(bg._businessKpis.size, 0);
    assert.strictEqual(bg._feedbackSources.size, 0);
    bg.shutdown();
  });

  it('should define KPI', () => {
    const bg = new BusinessGoal();
    bg.defineKpi('conversion', '转化率', 0.05, 'ratio');
    assert.strictEqual(bg._businessKpis.size, 1);
    const kpi = bg._businessKpis.get('conversion');
    assert.strictEqual(kpi.name, '转化率');
    assert.strictEqual(kpi.target, 0.05);
    assert.strictEqual(kpi.current, null);
    assert.strictEqual(kpi.unit, 'ratio');
    bg.shutdown();
  });

  it('should update KPI value', () => {
    const bg = new BusinessGoal();
    bg.defineKpi('conversion', '转化率', 0.05, 'ratio');
    bg.updateKpi('conversion', 0.03);
    assert.strictEqual(bg._businessKpis.get('conversion').current, 0.03);
    bg.shutdown();
  });

  it('should emit kpi-updated event', (t, done) => {
    const bg = new BusinessGoal();
    bg.defineKpi('revenue', '收入', 10000, 'CNY');
    bg.on('kpi-updated', (data) => {
      assert.strictEqual(data.kpiId, 'revenue');
      assert.strictEqual(data.current, 5000);
      assert.strictEqual(data.target, 10000);
      bg.shutdown();
      done();
    });
    bg.updateKpi('revenue', 5000);
  });

  it('should measure goal achievement', () => {
    const bg = new BusinessGoal();
    bg.defineKpi('k1', 'KPI 1', 100, 'unit');
    bg.defineKpi('k2', 'KPI 2', 100, 'unit');
    bg.updateKpi('k1', 100);
    bg.updateKpi('k2', 50);
    const achievement = bg.measureGoalAchievement();
    assert.strictEqual(achievement, 0.5);
    bg.shutdown();
  });

  it('should return 0 achievement when no KPIs defined', () => {
    const bg = new BusinessGoal();
    const achievement = bg.measureGoalAchievement();
    assert.strictEqual(achievement, 0);
    bg.shutdown();
  });

  it('should register feedback source', () => {
    const bg = new BusinessGoal();
    bg.registerFeedbackSource('analytics', { type: 'automated', credibility: 0.9 });
    assert.strictEqual(bg._feedbackSources.size, 1);
    bg.shutdown();
  });

  it('should record business feedback', () => {
    const bg = new BusinessGoal();
    bg.registerFeedbackSource('analytics', { type: 'automated', credibility: 0.9 });
    bg.recordFeedback('analytics', { action: 'campaign-A', outcome: 'positive', kpiImpact: { conversion: 0.01 } });
    assert.strictEqual(bg._feedbackHistory.length, 1);
    bg.shutdown();
  });

  it('should get business reflection dimensions', () => {
    const bg = new BusinessGoal();
    const dims = bg.getBusinessDimensions();
    assert.ok(dims.includes('business_impact'));
    assert.ok(dims.includes('customer_satisfaction'));
    assert.ok(dims.includes('cost_efficiency'));
    assert.ok(dims.includes('compliance'));
    assert.ok(dims.includes('feedback_quality'));
    bg.shutdown();
  });

  it('should shutdown cleanly', () => {
    const bg = new BusinessGoal();
    bg.defineKpi('k1', 'K1', 100, 'unit');
    bg.registerFeedbackSource('s1', { type: 'auto' });
    bg.shutdown();
    assert.strictEqual(bg._businessKpis.size, 0);
    assert.strictEqual(bg._feedbackSources.size, 0);
  });
});
