'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const StructuredLogger = require('../../src/utils/structured-logger');

describe('StructuredLogger', () => {
  it('should create instance with default options', () => {
    const logger = new StructuredLogger();
    assert.strictEqual(logger._level, 1);
    logger.shutdown();
  });

  it('should create instance with custom level', () => {
    const logger = new StructuredLogger({ level: 'warn' });
    assert.strictEqual(logger._level, 2);
    logger.shutdown();
  });

  it('should log info messages', () => {
    const logger = new StructuredLogger({ level: 'info', module: 'test' });
    logger.info('test message', { key: 'value' });
    const recent = logger.getRecent(1);
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].message, 'test message');
    assert.strictEqual(recent[0].level, 'info');
    logger.shutdown();
  });

  it('should not log debug when level is info', () => {
    const logger = new StructuredLogger({ level: 'info' });
    logger.debug('should not appear');
    const recent = logger.getRecent(1);
    assert.strictEqual(recent.length, 0);
    logger.shutdown();
  });

  it('should support trace ID', () => {
    const logger = new StructuredLogger();
    logger.setTraceId('trace-123');
    assert.strictEqual(logger.getTraceId(), 'trace-123');
    logger.info('with trace');
    const recent = logger.getRecent(1);
    assert.strictEqual(recent[0].traceId, 'trace-123');
    logger.shutdown();
  });

  it('should create child logger', () => {
    const logger = new StructuredLogger({ module: 'parent' });
    const child = logger.child('sub');
    assert.ok(child);
    assert.strictEqual(child._module, 'parent:sub');
    child.destroy();
    logger.shutdown();
  });

  it('should report health based on error rate', () => {
    const logger = new StructuredLogger({ level: 'info' });
    assert.ok(logger.isHealthy());
    logger.shutdown();
  });

  it('should export LOG_LEVELS', () => {
    assert.ok(StructuredLogger.LOG_LEVELS);
    assert.strictEqual(StructuredLogger.LOG_LEVELS.debug, 0);
    assert.strictEqual(StructuredLogger.LOG_LEVELS.silent, 4);
  });

  it('should query entries by level', () => {
    const logger = new StructuredLogger({ level: 'debug' });
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    const errors = logger.query({ level: 'error' });
    assert.ok(errors.length >= 1);
    assert.strictEqual(errors[errors.length - 1].message, 'error msg');
    logger.shutdown();
  });

  it('should log performance entries', () => {
    const logger = new StructuredLogger({ level: 'info' });
    logger.logPerformance('test-op', 500);
    const recent = logger.getRecent(1);
    assert.strictEqual(recent[0].meta._type, 'performance');
    logger.shutdown();
  });

  it('should get stats', () => {
    const logger = new StructuredLogger({ level: 'info' });
    logger.info('msg1');
    logger.warn('msg2');
    const stats = logger.getStats();
    assert.ok(stats.total >= 2);
    assert.ok(stats.byLevel);
    logger.shutdown();
  });
});
