'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const HarnessMigrationEngine = require('../../../src/runtime/model/harness-migration-engine');

describe('HarnessMigrationEngine', () => {
  it('should initialize with default registry', () => {
    const engine = new HarnessMigrationEngine();
    const report = engine.getMigrationReport();
    assert.ok(report.totalComponents > 0);
    assert.equal(report.currentTier, 'standard');
  });

  it('should reject invalid tier', () => {
    const engine = new HarnessMigrationEngine();
    const result = engine.updateTier('invalid');
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should update tier and track migration', () => {
    const engine = new HarnessMigrationEngine();
    const result = engine.updateTier('strong');
    assert.equal(result.success, true);
    assert.equal(result.migration.from, 'standard');
    assert.equal(result.migration.to, 'strong');
    const report = engine.getMigrationReport();
    assert.equal(report.currentTier, 'strong');
    assert.equal(report.migrationCount, 1);
  });

  it('should activate more components for stronger tier', () => {
    const engine = new HarnessMigrationEngine();
    engine.updateTier('weak');
    const weakActive = engine.getActiveComponents().length;
    engine.updateTier('frontier');
    const frontierActive = engine.getActiveComponents().length;
    assert.ok(frontierActive >= weakActive);
  });

  it('should attach calibration data', () => {
    const engine = new HarnessMigrationEngine();
    const result = engine.attachCalibrationData({ bias: 'overestimate' });
    assert.equal(result, engine); // returns this
  });

  it('should add safety components when overestimate detected', () => {
    const engine = new HarnessMigrationEngine();
    engine.updateTier('frontier');
    const beforeCount = engine.getActiveComponents().length;
    engine.attachCalibrationData({ bias: 'overestimate' });
    engine.updateTier('frontier');
    const afterCount = engine.getActiveComponents().length;
    assert.ok(afterCount >= beforeCount);
  });

  it('should track migration history', () => {
    const engine = new HarnessMigrationEngine();
    engine.updateTier('strong');
    engine.updateTier('weak');
    const report = engine.getMigrationReport();
    assert.equal(report.migrationCount, 2);
    assert.ok(report.lastMigration);
  });

  it('should shutdown cleanly', () => {
    const engine = new HarnessMigrationEngine();
    engine.updateTier('strong');
    engine.shutdown();
    assert.equal(engine.isHealthy(), false);
  });
});
