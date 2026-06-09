'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repl-test-'));
  fs.mkdirSync(path.join(dir, '.harness', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'agents'), { recursive: true });
  const config = { project_name: 'test', version: '1.0.0', agents: {}, skills: {}, commands: {}, hooks: {} };
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(config));
  return dir;
}

describe('REPLEngine - construction', () => {
  let REPLEngine;

  before(() => {
    REPLEngine = require(path.join(ROOT, 'src', 'runtime', 'tui', 'repl-engine'));
  });

  it('should construct with default options', () => {
    const repl = new REPLEngine(null);
    assert.equal(repl.getPersona(), 'default');
    assert.equal(repl.getSessionId(), null);
    assert.equal(repl.isRunning(), false);
    repl.shutdown();
  });

  it('should construct with custom options', () => {
    const repl = new REPLEngine(null, { persona: 'analyst', sessionId: 'test-123' });
    assert.equal(repl.getPersona(), 'analyst');
    assert.equal(repl.getSessionId(), 'test-123');
    repl.shutdown();
  });

  it('should set and get persona', () => {
    const repl = new REPLEngine(null);
    repl.setPersona('worker');
    assert.equal(repl.getPersona(), 'worker');
    repl.setPersona('default');
    assert.equal(repl.getPersona(), 'default');
    repl.shutdown();
  });

  it('should set and get session id', () => {
    const repl = new REPLEngine(null);
    repl.setSessionId('sess-abc');
    assert.equal(repl.getSessionId(), 'sess-abc');
    repl.shutdown();
  });

  it('should return stats', () => {
    const repl = new REPLEngine(null, { persona: 'qa', sessionId: 's1' });
    const stats = repl.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.persona, 'qa');
    assert.equal(stats.sessionId, 's1');
    assert.equal(stats.hasCommandRouter, false);
    repl.shutdown();
  });

  it('should shutdown cleanly', () => {
    const repl = new REPLEngine(null);
    repl.shutdown();
    assert.equal(repl.isRunning(), false);
  });
});

describe('REPLEngine - builtin commands', () => {
  let REPLEngine;

  before(() => {
    REPLEngine = require(path.join(ROOT, 'src', 'runtime', 'tui', 'repl-engine'));
  });

  it('should emit message event for non-command input', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('message', (data) => {
      assert.equal(data.content, 'hello world');
      repl.shutdown();
      done();
    });
    repl._handleLine('hello world');
  });

  it('should emit command:help for /help', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:help', () => {
      repl.shutdown();
      done();
    });
    repl._handleLine('/help');
  });

  it('should emit command:exit for /exit', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:exit', () => {
      repl.shutdown();
      done();
    });
    repl._handleLine('/exit');
  });

  it('should emit command:exit for /quit', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:exit', () => {
      repl.shutdown();
      done();
    });
    repl._handleLine('/quit');
  });

  it('should emit command:clear for /clear', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:clear', () => {
      repl.shutdown();
      done();
    });
    repl._handleLine('/clear');
  });

  it('should emit command:history for /history', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:history', (data) => {
      assert.ok(Array.isArray(data.entries));
      repl.shutdown();
      done();
    });
    repl._handleLine('/history');
  });

  it('should emit command:compress for /compress', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:compress', () => {
      repl.shutdown();
      done();
    });
    repl._handleLine('/compress');
  });

  it('should emit command:background for /background', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:background', (data) => {
      assert.equal(data.task, 'analyze logs');
      repl.shutdown();
      done();
    });
    repl._handleLine('/background analyze logs');
  });

  it('should emit command:status for /status', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:status', () => {
      repl.shutdown();
      done();
    });
    repl._handleLine('/status');
  });

  it('should emit command:model for /model', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:model', (data) => {
      assert.equal(data.model, 'gpt-4');
      repl.shutdown();
      done();
    });
    repl._handleLine('/model gpt-4');
  });

  it('should emit command:reasoning for /reasoning', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:reasoning', (data) => {
      assert.equal(data.level, 'high');
      repl.shutdown();
      done();
    });
    repl._handleLine('/reasoning high');
  });

  it('should emit command:unknown for unrecognized slash command', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:unknown', (data) => {
      assert.equal(data.input, '/unknown');
      repl.shutdown();
      done();
    });
    repl._handleLine('/unknown');
  });
});

describe('REPLEngine - persona and history', () => {
  let REPLEngine;

  before(() => {
    REPLEngine = require(path.join(ROOT, 'src', 'runtime', 'tui', 'repl-engine'));
  });

  it('should handle /persona list', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:persona', (data) => {
      assert.equal(data.action, 'list');
      assert.equal(data.current, 'default');
      repl.shutdown();
      done();
    });
    repl._handleLine('/persona');
  });

  it('should handle /persona set', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:persona', (data) => {
      assert.equal(data.action, 'set');
      assert.equal(data.current, 'analyst');
      assert.equal(data.previous, 'default');
      assert.equal(repl.getPersona(), 'analyst');
      repl.shutdown();
      done();
    });
    repl._handleLine('/persona analyst');
  });

  it('should emit persona-changed event', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('persona-changed', (data) => {
      assert.equal(data.previous, 'default');
      assert.equal(data.current, 'worker');
      repl.shutdown();
      done();
    });
    repl.setPersona('worker');
  });

  it('should ignore empty input', () => {
    const repl = new REPLEngine(null);
    repl._handleLine('');
    repl._handleLine('   ');
    assert.equal(repl.getHistory().length, 0);
    repl.shutdown();
  });

  it('should record history for valid input', () => {
    const repl = new REPLEngine(null);
    repl.on('message', function() {});
    repl._handleLine('test input');
    const history = repl.getHistory();
    assert.ok(history.length >= 1);
    assert.equal(history[0].input, 'test input');
    repl.shutdown();
  });

  it('should emit error for input exceeding max length', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('error', (data) => {
      assert.equal(data.type, 'input_too_long');
      repl.shutdown();
      done();
    });
    const longInput = 'a'.repeat(5000);
    repl._handleLine(longInput);
  });
});

describe('REPLEngine - command router integration', () => {
  let REPLEngine;
  let tmpDir;

  before(() => {
    REPLEngine = require(path.join(ROOT, 'src', 'runtime', 'tui', 'repl-engine'));
    tmpDir = createTempDir();
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* cleanup */ }
  });

  it('should complete commands with command router', () => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    const cr = new CommandRouter(tmpDir);
    cr.discover();
    const repl = new REPLEngine(cr);
    const completions = repl.completeCommand('/pl');
    assert.ok(Array.isArray(completions));
    repl.shutdown();
  });

  it('should return empty completions without command router', () => {
    const repl = new REPLEngine(null);
    const completions = repl.completeCommand('/pl');
    assert.ok(Array.isArray(completions));
    assert.equal(completions.length, 0);
    repl.shutdown();
  });
});

describe('REPLEngine - edge cases', () => {
  let REPLEngine;

  before(() => {
    REPLEngine = require(path.join(ROOT, 'src', 'runtime', 'tui', 'repl-engine'));
  });

  it('should handle _handleLine with null input', () => {
    const repl = new REPLEngine(null);
    repl._handleLine(null);
    assert.equal(repl.getHistory().length, 0);
    repl.shutdown();
  });

  it('should handle _handleLine with undefined input', () => {
    const repl = new REPLEngine(null);
    repl._handleLine(undefined);
    assert.equal(repl.getHistory().length, 0);
    repl.shutdown();
  });

  it('should handle _handleCommand with command that has no args', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('command:status', (data) => {
      assert.ok(data);
      repl.shutdown();
      done();
    });
    repl._handleLine('/status');
  });

  it('should handle multiple rapid persona switches', () => {
    const repl = new REPLEngine(null);
    const changes = [];
    repl.on('persona-changed', (data) => {
      changes.push(data);
    });
    repl.setPersona('analyst');
    repl.setPersona('worker');
    repl.setPersona('qa');
    repl.setPersona('default');
    assert.equal(changes.length, 4);
    assert.equal(changes[0].previous, 'default');
    assert.equal(changes[0].current, 'analyst');
    assert.equal(changes[1].previous, 'analyst');
    assert.equal(changes[1].current, 'worker');
    assert.equal(changes[2].previous, 'worker');
    assert.equal(changes[2].current, 'qa');
    assert.equal(changes[3].previous, 'qa');
    assert.equal(changes[3].current, 'default');
    assert.equal(repl.getPersona(), 'default');
    repl.shutdown();
  });

  it('should handle history overflow beyond MAX_HISTORY=500', () => {
    const repl = new REPLEngine(null);
    repl.on('message', function() {});
    for (let i = 0; i < 600; i++) {
      repl._handleLine('input-' + i);
    }
    const history = repl.getHistory();
    assert.ok(history.length <= 500);
    assert.ok(history.length > 0);
    const firstKept = history[0].input;
    assert.ok(!firstKept.startsWith('input-0'));
    assert.ok(firstKept.startsWith('input-'));
    repl.shutdown();
  });

  it('should default setPersona to default when called with null', () => {
    const repl = new REPLEngine(null);
    repl.setPersona('analyst');
    assert.equal(repl.getPersona(), 'analyst');
    repl.setPersona(null);
    assert.equal(repl.getPersona(), 'default');
    repl.shutdown();
  });

  it('should default setPersona to default when called with undefined', () => {
    const repl = new REPLEngine(null);
    repl.setPersona('worker');
    assert.equal(repl.getPersona(), 'worker');
    repl.setPersona(undefined);
    assert.equal(repl.getPersona(), 'default');
    repl.shutdown();
  });

  it('should not throw when writeOutput is called while not running', () => {
    const repl = new REPLEngine(null);
    assert.equal(repl.isRunning(), false);
    assert.doesNotThrow(() => {
      repl.writeOutput('test output');
    });
    repl.shutdown();
  });

  it('should handle _handleLine with whitespace-only input', () => {
    const repl = new REPLEngine(null);
    repl._handleLine('   \t  ');
    assert.equal(repl.getHistory().length, 0);
    repl.shutdown();
  });

  it('should emit persona-changed event with correct previous and current on setPersona', (t, done) => {
    const repl = new REPLEngine(null);
    repl.on('persona-changed', (data) => {
      assert.equal(data.previous, 'default');
      assert.equal(data.current, 'lead');
      repl.shutdown();
      done();
    });
    repl.setPersona('lead');
  });
});
