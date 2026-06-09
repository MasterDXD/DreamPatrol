'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ArchitectureBoundaryEnforcer, DEPENDENCY_RULES } = require('../../src/gate/architecture-boundary-enforcer');

describe('ArchitectureBoundaryEnforcer', () => {
  it('should define dependency rules for all modules', () => {
    assert.ok(DEPENDENCY_RULES.gate);
    assert.ok(DEPENDENCY_RULES.permission);
    assert.ok(DEPENDENCY_RULES.runtime);
    assert.ok(DEPENDENCY_RULES.web);
    assert.ok(DEPENDENCY_RULES.utils);
    assert.ok(DEPENDENCY_RULES.errors);
  });

  it('should identify module for file path', () => {
    const enforcer = new ArchitectureBoundaryEnforcer();
    assert.strictEqual(enforcer.getModuleForPath('src/gate/tdd-gate.js'), 'gate');
    assert.strictEqual(enforcer.getModuleForPath('src/runtime/agent/agent-runtime.js'), 'runtime');
    assert.strictEqual(enforcer.getModuleForPath('src/web/server.js'), 'web');
    assert.strictEqual(enforcer.getModuleForPath('src/utils/constants.js'), 'utils');
  });

  it('should enforce dependency rules', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });
    assert.strictEqual(enforcer.isDependencyAllowed('gate', 'utils'), true);
    assert.strictEqual(enforcer.isDependencyAllowed('gate', 'runtime'), false);
    assert.strictEqual(enforcer.isDependencyAllowed('permission', 'runtime'), false);
    assert.strictEqual(enforcer.isDependencyAllowed('runtime', 'utils'), true);
    assert.strictEqual(enforcer.isDependencyAllowed('utils', 'runtime'), false);
    assert.strictEqual(enforcer.isDependencyAllowed('errors', 'utils'), false);
  });

  it('should allow same-module dependencies', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });
    assert.strictEqual(enforcer.isDependencyAllowed('runtime', 'runtime'), true);
  });

  it('should allow null module dependencies', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });
    assert.strictEqual(enforcer.isDependencyAllowed(null, 'runtime'), true);
    assert.strictEqual(enforcer.isDependencyAllowed('runtime', null), true);
  });

  it('should support whitelist entries', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });
    assert.strictEqual(enforcer.isDependencyAllowed('gate', 'runtime'), false);
    enforcer.addWhitelistEntry('gate', 'runtime');
    assert.strictEqual(enforcer.isDependencyAllowed('gate', 'runtime'), true);
  });

  it('should detect violations in checkFile', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'recommended' });
    const violations = enforcer.checkFile('src/gate/tdd-gate.js', [
      'src/runtime/agent/agent-runtime.js',
    ]);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].fromModule, 'gate');
    assert.strictEqual(violations[0].toModule, 'runtime');
  });

  it('should throw in strict mode on violations', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });
    assert.throws(() => {
      enforcer.checkFile('src/gate/tdd-gate.js', ['src/runtime/agent/agent-runtime.js']);
    }, /Architecture boundary violation/);
  });

  it('should return rules and violations', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'recommended' });
    const rules = enforcer.getRules();
    assert.ok(rules.gate);
    enforcer.checkFile('src/gate/tdd-gate.js', ['src/runtime/agent/agent-runtime.js']);
    assert.strictEqual(enforcer.getViolations().length, 1);
    enforcer.clearViolations();
    assert.strictEqual(enforcer.getViolations().length, 0);
  });

  it('should expose getMode()', () => {
    const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });
    assert.strictEqual(enforcer.getMode(), 'strict');
    const enforcer2 = new ArchitectureBoundaryEnforcer();
    assert.strictEqual(enforcer2.getMode(), 'recommended');
  });
});
