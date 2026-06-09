'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('TUIApp', () => {
  let TUIApp;

  before(() => {
    TUIApp = require(path.join(ROOT, 'src', 'runtime', 'tui', 'tui-app'));
  });

  it('should construct with default options', () => {
    const app = new TUIApp();
    assert.equal(app.isRunning(), false);
    const stats = app.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.model, 'default');
    assert.equal(stats.messageCount, 0);
    app.shutdown();
  });

  it('should construct with custom model', () => {
    const app = new TUIApp({ model: 'gpt-4o' });
    assert.equal(app.getStats().model, 'gpt-4o');
    app.shutdown();
  });

  it('should start and stop', () => {
    const app = new TUIApp();
    let startedFired = false;
    app.on('started', () => { startedFired = true; });
    app.start();
    assert.equal(app.isRunning(), true);
    assert.ok(startedFired);
    app.stop();
    assert.equal(app.isRunning(), false);
    app.shutdown();
  });

  it('should emit stopped event', (t, done) => {
    const app = new TUIApp();
    app.start();
    app.on('stopped', () => {
      app.shutdown();
      done();
    });
    app.stop();
  });

  it('should not double-start', () => {
    const app = new TUIApp();
    app.start();
    app.start();
    assert.equal(app.isRunning(), true);
    app.stop();
    app.shutdown();
  });

  it('should not double-stop', () => {
    const app = new TUIApp();
    app.start();
    app.stop();
    app.stop();
    assert.equal(app.isRunning(), false);
    app.shutdown();
  });

  it('should add messages', () => {
    const app = new TUIApp();
    app.addMessage({ role: 'user', content: 'hello' });
    app.addMessage({ role: 'assistant', content: 'hi there' });
    app.addMessage({ role: 'system', content: 'system msg' });
    const msgs = app.getMessages();
    assert.ok(msgs.length >= 3);
    app.shutdown();
  });

  it('should ignore invalid messages', () => {
    const app = new TUIApp();
    app.addMessage(null);
    app.addMessage({});
    app.addMessage({ content: 'no role' });
    assert.equal(app.getMessages().length, 0);
    app.shutdown();
  });

  it('should handle tool messages', () => {
    const app = new TUIApp();
    app.addMessage({ role: 'tool', content: 'result', toolName: 'readFile', type: 'tool_result' });
    const msgs = app.getMessages();
    assert.ok(msgs.length >= 1);
    assert.equal(msgs[0].toolName, 'readFile');
    app.shutdown();
  });

  it('should update token usage', () => {
    const app = new TUIApp();
    app.updateTokenUsage({ used: 500, budget: 1000, ratio: 0.5 });
    assert.equal(app._tokenUsage.used, 500);
    assert.equal(app._tokenUsage.budget, 1000);
    assert.equal(app._tokenUsage.ratio, 0.5);
    app.shutdown();
  });

  it('should set model', () => {
    const app = new TUIApp();
    app.setModel('gpt-4o-mini');
    assert.equal(app._currentModel, 'gpt-4o-mini');
    app.shutdown();
  });

  it('should set phase', () => {
    const app = new TUIApp();
    app.setPhase('module-development');
    assert.equal(app._currentPhase, 'module-development');
    app.shutdown();
  });

  it('should set skill/command/tool counts', () => {
    const app = new TUIApp();
    app.setSkillCount(38);
    app.setCommandCount(22);
    app.setToolCount(15);
    const stats = app.getStats();
    assert.equal(stats.skillCount, 38);
    assert.equal(stats.commandCount, 22);
    assert.equal(stats.toolCount, 15);
    app.shutdown();
  });

  it('should render progress bar', () => {
    const app = new TUIApp();
    const bar0 = app._renderProgressBar(0);
    assert.ok(bar0.includes('░'));
    const bar1 = app._renderProgressBar(1);
    assert.ok(bar1.includes('█'));
    const barHalf = app._renderProgressBar(0.5);
    assert.ok(barHalf.includes('█'));
    assert.ok(barHalf.includes('░'));
    app.shutdown();
  });

  it('should return correct token color for ratios', () => {
    const app = new TUIApp();
    app._supportsAnsi = true;
    const green = app._getTokenColor(0.3);
    const yellow = app._getTokenColor(0.6);
    const orange = app._getTokenColor(0.9);
    const red = app._getTokenColor(0.99);
    assert.ok(green.includes('52'));
    assert.ok(yellow.includes('251'));
    assert.ok(orange.includes('251'));
    assert.ok(red.includes('248'));
    app.shutdown();
  });

  it('should format elapsed time', () => {
    const app = new TUIApp();
    app._startTime = Date.now() - 30000;
    const elapsed = app._getElapsed();
    assert.ok(elapsed.includes('s'));
    app.shutdown();
  });

  it('should format elapsed time in minutes', () => {
    const app = new TUIApp();
    app._startTime = Date.now() - 120000;
    const elapsed = app._getElapsed();
    assert.ok(elapsed.includes('m'));
    app.shutdown();
  });

  it('should return stats with cost', () => {
    const app = new TUIApp();
    app._cost = 0.05;
    const stats = app.getStats();
    assert.equal(stats.cost, 0.05);
    app.shutdown();
  });

  it('should shutdown cleanly', () => {
    const app = new TUIApp();
    app.start();
    app.shutdown();
    assert.equal(app.isRunning(), false);
  });
});

describe('TUIApp - edge cases', () => {
  let TUIApp;

  before(() => {
    TUIApp = require(path.join(ROOT, 'src', 'runtime', 'tui', 'tui-app'));
  });

  it('should detect ANSI support on Windows with WT_SESSION', () => {
    const app = new TUIApp();
    const originalPlatform = process.platform;
    const originalEnv = process.env.WT_SESSION;
    const originalIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.WT_SESSION = 'test-session';
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const result = app._detectAnsiSupport();
      assert.equal(result, true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalEnv !== undefined) {
        process.env.WT_SESSION = originalEnv;
      } else {
        delete process.env.WT_SESSION;
      }
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    app.shutdown();
  });

  it('should detect no ANSI support on Windows without terminal env', () => {
    const app = new TUIApp();
    const originalPlatform = process.platform;
    const originalWT = process.env.WT_SESSION;
    const originalTP = process.env.TERM_PROGRAM;
    const originalIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      delete process.env.WT_SESSION;
      delete process.env.TERM_PROGRAM;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const result = app._detectAnsiSupport();
      assert.equal(result, false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalWT !== undefined) process.env.WT_SESSION = originalWT;
      else delete process.env.WT_SESSION;
      if (originalTP !== undefined) process.env.TERM_PROGRAM = originalTP;
      else delete process.env.TERM_PROGRAM;
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    app.shutdown();
  });

  it('should clamp progress bar with negative ratio', () => {
    const app = new TUIApp();
    const bar = app._renderProgressBar(-0.5);
    assert.ok(bar.includes('░'));
    assert.ok(!bar.includes('█'));
    const expected = '[' + '░'.repeat(20) + ']';
    assert.equal(bar, expected);
    app.shutdown();
  });

  it('should clamp progress bar with ratio > 1', () => {
    const app = new TUIApp();
    const bar = app._renderProgressBar(1.5);
    assert.ok(bar.includes('█'));
    assert.ok(!bar.includes('░'));
    const expected = '[' + '█'.repeat(20) + ']';
    assert.equal(bar, expected);
    app.shutdown();
  });

  it('should format content for tool_call type', () => {
    const app = new TUIApp();
    const result = app._formatContent({ type: 'tool_call', toolName: 'readFile', content: '' });
    assert.equal(result, '调用 readFile...');
    app.shutdown();
  });

  it('should format content for tool_call type with unknown tool', () => {
    const app = new TUIApp();
    const result = app._formatContent({ type: 'tool_call', toolName: null, content: '' });
    assert.equal(result, '调用 unknown...');
    app.shutdown();
  });

  it('should format content for tool_result with many lines', () => {
    const app = new TUIApp();
    const longContent = Array.from({ length: 10 }, (_, i) => 'line ' + i).join('\n');
    const result = app._formatContent({ type: 'tool_result', content: longContent });
    assert.ok(result.includes('...'));
    assert.ok(result.includes('5 more lines'));
    app.shutdown();
  });

  it('should format content for tool_result with 5 or fewer lines', () => {
    const app = new TUIApp();
    const shortContent = Array.from({ length: 3 }, (_, i) => 'line ' + i).join('\n');
    const result = app._formatContent({ type: 'tool_result', content: shortContent });
    assert.equal(result, shortContent);
    assert.ok(!result.includes('more lines'));
    app.shutdown();
  });

  it('should return elapsed time in hours', () => {
    const app = new TUIApp();
    app._startTime = Date.now() - (2 * 3600000 + 30 * 60000);
    const elapsed = app._getElapsed();
    assert.ok(elapsed.includes('h'));
    assert.ok(elapsed.includes('m'));
    app.shutdown();
  });

  it('should return 0s elapsed when startTime is null', () => {
    const app = new TUIApp();
    app._startTime = null;
    const elapsed = app._getElapsed();
    assert.equal(elapsed, '0s');
    app.shutdown();
  });

  it('should handle updateTokenUsage with null', () => {
    const app = new TUIApp();
    app.updateTokenUsage(null);
    assert.equal(app._tokenUsage, null);
    app.shutdown();
  });

  it('should handle updateTokenUsage with undefined', () => {
    const app = new TUIApp();
    app.updateTokenUsage(undefined);
    assert.equal(app._tokenUsage, null);
    app.shutdown();
  });

  it('should handle updateTokenUsage with partial data', () => {
    const app = new TUIApp();
    app.updateTokenUsage({ used: 100 });
    assert.equal(app._tokenUsage.used, 100);
    assert.equal(app._tokenUsage.budget, 1);
    assert.equal(app._tokenUsage.ratio, 0);
    app.shutdown();
  });

  it('should set model to default when called with null', () => {
    const app = new TUIApp();
    app.setModel('gpt-4o');
    assert.equal(app._currentModel, 'gpt-4o');
    app.setModel(null);
    assert.equal(app._currentModel, 'default');
    app.shutdown();
  });

  it('should set model to default when called with undefined', () => {
    const app = new TUIApp();
    app.setModel('gpt-4o');
    app.setModel(undefined);
    assert.equal(app._currentModel, 'default');
    app.shutdown();
  });

  it('should add message with very long content', () => {
    const app = new TUIApp();
    const longContent = 'x'.repeat(100000);
    app.addMessage({ role: 'user', content: longContent });
    const msgs = app.getMessages();
    assert.ok(msgs.length >= 1);
    assert.equal(msgs[0].content.length, 100000);
    app.shutdown();
  });

  it('should return correct token color for exact threshold boundaries', () => {
    const app = new TUIApp();
    app._supportsAnsi = true;
    const atGreen = app._getTokenColor(0.5);
    assert.ok(atGreen.includes('251'));
    const atYellow = app._getTokenColor(0.8);
    assert.ok(atYellow.includes('251'));
    const atOrange = app._getTokenColor(0.95);
    assert.ok(atOrange.includes('248'));
    app.shutdown();
  });

  it('should return empty string for token color when ANSI not supported', () => {
    const app = new TUIApp();
    app._supportsAnsi = false;
    const color = app._getTokenColor(0.5);
    assert.equal(color, '');
    app.shutdown();
  });

  it('should return model via getModel', () => {
    const app = new TUIApp({ model: 'gpt-4o' });
    assert.equal(app.getModel(), 'gpt-4o');
    app.setModel('claude-3');
    assert.equal(app.getModel(), 'claude-3');
    app.shutdown();
  });

  it('should handle updateTokenUsage with zero values correctly', () => {
    const app = new TUIApp();
    app.updateTokenUsage({ used: 0, budget: 0, ratio: 0 });
    assert.equal(app._tokenUsage.used, 0);
    assert.equal(app._tokenUsage.budget, 0);
    assert.equal(app._tokenUsage.ratio, 0);
    app.shutdown();
  });

  it('should handle updateTokenUsage with explicit zero cost', () => {
    const app = new TUIApp();
    app._cost = 5.0;
    app.updateTokenUsage({ used: 100, budget: 1000, ratio: 0.1, cost: 0 });
    assert.equal(app._cost, 0);
    app.shutdown();
  });
});
