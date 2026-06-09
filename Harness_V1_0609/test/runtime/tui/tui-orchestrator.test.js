'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tui-orch-test-'));
  fs.mkdirSync(path.join(dir, '.harness', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'agents'), { recursive: true });
  const config = { project_name: 'test', version: '1.0.0', agents: {}, skills: {}, commands: {}, hooks: {} };
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(config));
  return dir;
}

class MockSessionManager extends EventEmitter {
  constructor() { super(); this._sessions = {}; }
  create(opts) { const id = 'sess-' + Date.now(); this._sessions[id] = { id, status: 'active', phase: '', agent: opts.agent }; return this._sessions[id]; }
  getSession(id) { return this._sessions[id] || null; }
  terminate(id) { delete this._sessions[id]; }
  getActiveSessions() { return Object.values(this._sessions).filter(s => s.status === 'active'); }
}

class MockTokenManager extends EventEmitter {
  constructor() { super(); this._usage = {}; }
  store(sessionId, amount) { this._usage[sessionId] = (this._usage[sessionId] ?? 0) + amount; }
  getUsage(sessionId) {
    const used = this._usage[sessionId] ?? 0;
    const budget = 1000;
    return { used, budget, ratio: used / budget, remaining: budget - used };
  }
}

describe('TUIOrchestrator - construction', () => {
  let TUIOrchestrator;
  let tmpDir;

  before(() => {
    TUIOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'tui', 'tui-orchestrator'));
    tmpDir = createTempDir();
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* cleanup */ }
  });

  it('should construct with default options', () => {
    const orch = new TUIOrchestrator(tmpDir);
    assert.equal(orch.isRunning(), false);
    const stats = orch.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.persona, 'default');
    orch.shutdown();
  });

  it('should construct with custom options', () => {
    const orch = new TUIOrchestrator(tmpDir, { model: 'gpt-4o', theme: 'dark' });
    const stats = orch.getStats();
    assert.equal(stats.theme, 'dark');
    orch.shutdown();
  });

  it('should expose persona manager', () => {
    const orch = new TUIOrchestrator(tmpDir);
    const pm = orch.getPersonaManager();
    assert.ok(pm);
    assert.equal(pm.getCurrentPersona(), 'default');
    orch.shutdown();
  });

  it('should expose quick command registry', () => {
    const orch = new TUIOrchestrator(tmpDir);
    const qcr = orch.getQuickCommandRegistry();
    assert.ok(qcr);
    assert.equal(qcr.getStats().totalCommands, 0);
    orch.shutdown();
  });

  it('should load quick commands from config', () => {
    const orch = new TUIOrchestrator(tmpDir, {
      quickCommands: {
        quick_commands: [
          { id: 'build', command: 'npm run build', description: 'Build' },
        ],
      },
    });
    const qcr = orch.getQuickCommandRegistry();
    assert.equal(qcr.getStats().totalCommands, 1);
    orch.shutdown();
  });

  it('should expose TUI themes', () => {
    assert.ok(TUIOrchestrator.THEMES);
    assert.ok(TUIOrchestrator.THEMES.dark);
    assert.ok(TUIOrchestrator.THEMES.light);
    assert.ok(TUIOrchestrator.THEMES.highcontrast);
  });

  it('should return null sub-components before start', () => {
    const orch = new TUIOrchestrator(tmpDir);
    assert.equal(orch.getTUIApp(), null);
    assert.equal(orch.getREPLEngine(), null);
    orch.shutdown();
  });

  it('should return stats', () => {
    const orch = new TUIOrchestrator(tmpDir);
    const stats = orch.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.sessionId, null);
    assert.equal(stats.persona, 'default');
    assert.equal(stats.messageCount, 0);
    assert.equal(stats.quickCommands, 0);
    orch.shutdown();
  });

  it('should shutdown cleanly', () => {
    const orch = new TUIOrchestrator(tmpDir);
    orch.shutdown();
    assert.equal(orch.isRunning(), false);
  });
});

describe('TUIOrchestrator - session integration', () => {
  let TUIOrchestrator;
  let tmpDir;

  before(() => {
    TUIOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'tui', 'tui-orchestrator'));
    tmpDir = createTempDir();
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* cleanup */ }
  });

  it('should resume session with session manager', () => {
    const sm = new MockSessionManager();
    const session = sm.create({ agent: 'test' });
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.resumeSession(session.id);
    assert.equal(result, true);
    assert.equal(orch._sessionId, session.id);
    orch.shutdown();
  });

  it('should fail to resume non-existent session', () => {
    const sm = new MockSessionManager();
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.resumeSession('nonexistent');
    assert.equal(result, false);
    orch.shutdown();
  });

  it('should fail resume without session manager', () => {
    const orch = new TUIOrchestrator(tmpDir);
    const result = orch.resumeSession('some-id');
    assert.equal(result, false);
    orch.shutdown();
  });

  it('should continue last session', () => {
    const sm = new MockSessionManager();
    sm.create({ agent: 'test1' });
    sm.create({ agent: 'test2' });
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.continueLastSession();
    assert.equal(result, true);
    const stats = orch.getStats();
    assert.ok(stats.sessionId);
    orch.shutdown();
  });

  it('should fail continue without sessions', () => {
    const sm = new MockSessionManager();
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.continueLastSession();
    assert.equal(result, false);
    orch.shutdown();
  });

  it('should fail continue without session manager', () => {
    const orch = new TUIOrchestrator(tmpDir);
    const result = orch.continueLastSession();
    assert.equal(result, false);
    orch.shutdown();
  });
});

describe('TUIOrchestrator - token integration', () => {
  let TUIOrchestrator;
  let tmpDir;

  before(() => {
    TUIOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'tui', 'tui-orchestrator'));
    tmpDir = createTempDir();
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* cleanup */ }
  });

  it('should update token display with token manager', () => {
    const tm = new MockTokenManager();
    const orch = new TUIOrchestrator(tmpDir, { tokenManager: tm });
    orch._sessionId = 'test-sess';
    tm.store('test-sess', 500);
    orch._updateTokenDisplay();
    const tuiApp = orch.getTUIApp();
    if (tuiApp) {
      assert.ok(tuiApp._tokenUsage);
      assert.equal(tuiApp._tokenUsage.used, 500);
    }
    orch.shutdown();
  });

  it('should handle updateTokenDisplay without session', () => {
    const tm = new MockTokenManager();
    const orch = new TUIOrchestrator(tmpDir, { tokenManager: tm });
    orch._updateTokenDisplay();
    orch.shutdown();
  });

  it('should handle updateTokenDisplay without token manager', () => {
    const orch = new TUIOrchestrator(tmpDir);
    orch._sessionId = 'test-sess';
    orch._updateTokenDisplay();
    orch.shutdown();
  });
});

describe('TUIOrchestrator - edge cases', () => {
  let TUIOrchestrator;
  let tmpDir;

  before(() => {
    TUIOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'tui', 'tui-orchestrator'));
    tmpDir = createTempDir();
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* cleanup */ }
  });

  it('should fail resumeSession after shutdown', () => {
    const sm = new MockSessionManager();
    const session = sm.create({ agent: 'test' });
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    orch.shutdown();
    assert.throws(() => orch.resumeSession(session.id), /shut down/i);
  });

  it('should fail continueLastSession with empty sessions', () => {
    const sm = new MockSessionManager();
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.continueLastSession();
    assert.equal(result, false);
    orch.shutdown();
  });

  it('should handle _updateTokenDisplay with token manager but no tuiApp', () => {
    const tm = new MockTokenManager();
    const orch = new TUIOrchestrator(tmpDir, { tokenManager: tm });
    orch._sessionId = 'test-sess';
    tm.store('test-sess', 200);
    assert.equal(orch.getTUIApp(), null);
    assert.doesNotThrow(() => {
      orch._updateTokenDisplay();
    });
    orch.shutdown();
  });

  it('should return stats after shutdown', () => {
    const orch = new TUIOrchestrator(tmpDir);
    orch.shutdown();
    const stats = orch.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.persona, 'default');
    assert.equal(stats.messageCount, 0);
    assert.equal(stats.quickCommands, 0);
  });

  it('should return null sub-components after shutdown', () => {
    const orch = new TUIOrchestrator(tmpDir);
    orch.shutdown();
    assert.equal(orch.getTUIApp(), null);
    assert.equal(orch.getREPLEngine(), null);
  });

  it('should handle resumeSession with session that has a phase', () => {
    const sm = new MockSessionManager();
    const session = sm.create({ agent: 'test' });
    session.phase = 'module-development';
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.resumeSession(session.id);
    assert.equal(result, true);
    assert.equal(orch._sessionId, session.id);
    orch.shutdown();
  });

  it('should handle continueLastSession with multiple sessions', () => {
    const sm = new MockSessionManager();
    const _s1 = sm.create({ agent: 'test1' });
    const s2 = sm.create({ agent: 'test2' });
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm });
    const result = orch.continueLastSession();
    assert.equal(result, true);
    assert.equal(orch._sessionId, s2.id);
    orch.shutdown();
  });

  it('should handle double shutdown gracefully', () => {
    const orch = new TUIOrchestrator(tmpDir);
    orch.shutdown();
    assert.doesNotThrow(() => {
      orch.shutdown();
    });
    assert.equal(orch.isRunning(), false);
  });

  it('should return persona manager after shutdown', () => {
    const orch = new TUIOrchestrator(tmpDir);
    const pm = orch.getPersonaManager();
    assert.ok(pm);
    orch.shutdown();
    const pmAfter = orch.getPersonaManager();
    assert.ok(pmAfter !== null);
  });

  it('should return quick command registry after shutdown', () => {
    const orch = new TUIOrchestrator(tmpDir);
    orch.shutdown();
    const qcr = orch.getQuickCommandRegistry();
    assert.ok(qcr !== null);
    assert.equal(qcr.getStats().totalCommands, 0);
  });

  it('should return null TUIApp and REPLEngine after start+shutdown', async () => {
    const orch = new TUIOrchestrator(tmpDir);
    await orch.start();
    assert.ok(orch.getTUIApp() !== null);
    assert.ok(orch.getREPLEngine() !== null);
    orch.shutdown();
    assert.equal(orch.getTUIApp(), null);
    assert.equal(orch.getREPLEngine(), null);
  });

  it('should clean up external listeners on stop', () => {
    const sm = new MockSessionManager();
    const tm = new MockTokenManager();
    const orch = new TUIOrchestrator(tmpDir, { sessionManager: sm, tokenManager: tm });
    const smListenerCount = sm.listenerCount('budget-warning');
    const tmListenerCount = tm.listenerCount('token-warning-80');
    orch._setupSessionIntegration();
    orch._setupTokenIntegration();
    assert.ok(sm.listenerCount('budget-warning') > smListenerCount);
    assert.ok(tm.listenerCount('token-warning-80') > tmListenerCount);
    orch._cleanupExternalListeners();
    assert.equal(sm.listenerCount('budget-warning'), smListenerCount);
    assert.equal(tm.listenerCount('token-warning-80'), tmListenerCount);
    orch.shutdown();
  });

  it('should handle _cleanupExternalListeners when no listeners set', () => {
    const orch = new TUIOrchestrator(tmpDir);
    assert.doesNotThrow(() => {
      orch._cleanupExternalListeners();
    });
    orch.shutdown();
  });

  it('should update token display with active TUIApp', async () => {
    const tm = new MockTokenManager();
    const orch = new TUIOrchestrator(tmpDir, { tokenManager: tm });
    await orch.start();
    orch._sessionId = 'test-sess';
    tm.store('test-sess', 500);
    orch._updateTokenDisplay();
    const tuiApp = orch.getTUIApp();
    assert.ok(tuiApp);
    assert.ok(tuiApp._tokenUsage);
    assert.equal(tuiApp._tokenUsage.used, 500);
    orch.shutdown();
  });
});
