'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TechStackTemplates, TEMPLATE_CATEGORIES, VIOLATION_SEVERITY } = require('../../../src/runtime/standards/tech-stack-templates');

describe('TechStackTemplates - Construction & Templates', () => {
  describe('constructor', () => {
    it('should create instance with default options', () => {
      const tst = new TechStackTemplates();
      assert.deepStrictEqual(tst.getActiveStacks(), []);
      assert.deepStrictEqual(tst.getStats(), { total: 0, passed: 0, fixed: 0, failed: 0 });
      tst.shutdown();
    });

    it('should accept custom options', () => {
      const tst = new TechStackTemplates({ customOption: true });
      assert.strictEqual(tst._options.customOption, true);
      tst.shutdown();
    });
  });

  describe('activate / deactivate', () => {
    let tst;
    beforeEach(() => {
      tst = new TechStackTemplates();
    });

    it('should activate a known stack', () => {
      const result = tst.activate('react');
      assert.ok(result.activated.includes('react'));
      assert.strictEqual(result.conflicts.length, 0);
      assert.ok(tst.getActiveStacks().includes('react'));
    });

    it('should activate multiple stacks', () => {
      const result = tst.activate(['react', 'vue']);
      assert.ok(result.activated.includes('react'));
      assert.ok(result.activated.includes('vue'));
      assert.strictEqual(tst.getActiveStacks().length, 2);
    });

    it('should report conflict for unknown stack', () => {
      const result = tst.activate('unknown-stack');
      assert.strictEqual(result.activated.length, 0);
      assert.ok(result.conflicts.length > 0);
    });

    it('should emit stack-activated event', (t, done) => {
      tst.on('stack-activated', (data) => {
        assert.strictEqual(data.name, 'react');
        done();
      });
      tst.activate('react');
    });

    it('should emit stacks-updated event on activate', (t, done) => {
      tst.on('stacks-updated', () => {
        done();
      });
      tst.activate('react');
    });

    it('should deactivate a stack', () => {
      tst.activate('react');
      tst.deactivate('react');
      assert.ok(!tst.getActiveStacks().includes('react'));
    });

    it('should emit stack-deactivated event', (t, done) => {
      tst.activate('react');
      tst.on('stack-deactivated', (data) => {
        assert.strictEqual(data.name, 'react');
        done();
      });
      tst.deactivate('react');
    });

    it('should throw when activating after shutdown', () => {
      tst.shutdown();
      assert.throws(() => tst.activate('react'), /shut down/i);
    });
  });

  describe('getActiveStacks', () => {
    it('should return empty array initially', () => {
      const tst = new TechStackTemplates();
      assert.deepStrictEqual(tst.getActiveStacks(), []);
      tst.shutdown();
    });

    it('should return activated stacks', () => {
      const tst = new TechStackTemplates();
      tst.activate(['react', 'vue']);
      const stacks = tst.getActiveStacks();
      assert.strictEqual(stacks.length, 2);
      assert.ok(stacks.includes('react'));
      assert.ok(stacks.includes('vue'));
      tst.shutdown();
    });
  });

  describe('getAvailableTemplates (static)', () => {
    it('should return an array of template names', () => {
      const names = TechStackTemplates.getAvailableTemplates();
      assert.ok(Array.isArray(names));
      assert.ok(names.includes('react'));
      assert.ok(names.includes('vue'));
      assert.ok(names.includes('express'));
    });
  });

  describe('getTemplate', () => {
    let tst;
    beforeEach(() => {
      tst = new TechStackTemplates();
    });

    it('should return template when it exists', () => {
      const tpl = tst.getTemplate('react');
      assert.ok(tpl);
      assert.strictEqual(tpl.name, 'React');
      assert.ok(tpl.naming);
      assert.ok(tpl.rules);
    });

    it('should return null for non-existent template', () => {
      assert.strictEqual(tst.getTemplate('nonexistent'), null);
    });

    it('should return a deep copy (isolation)', () => {
      const tpl1 = tst.getTemplate('react');
      const tpl2 = tst.getTemplate('react');
      tpl1.name = 'Modified';
      assert.strictEqual(tpl2.name, 'React');
    });
  });

  describe('addCustomRule / removeCustomRule', () => {
    let tst;
    beforeEach(() => {
      tst = new TechStackTemplates();
    });

    it('should add a custom rule', () => {
      tst.addCustomRule('react', 'myRule', { severity: 'error' });
      // Verify it takes effect via check
      tst.activate('react');
      const code = 'export function App() { console.log("hi"); }';
      const result = tst.check('App.jsx', code);
      // The custom rule should be in the rule set
      assert.ok(result);
    });

    it('should throw for unknown template', () => {
      assert.throws(() => tst.addCustomRule('unknown', 'rule', {}), /Unknown template/);
    });

    it('should emit rule-added event', (t, done) => {
      tst.on('rule-added', (data) => {
        assert.strictEqual(data.stackName, 'react');
        assert.strictEqual(data.ruleId, 'myRule');
        done();
      });
      tst.addCustomRule('react', 'myRule', { severity: 'error' });
    });

    it('should remove a custom rule', () => {
      tst.addCustomRule('react', 'myRule', { severity: 'error' });
      tst.removeCustomRule('react', 'myRule');
      // Should not throw
    });

    it('should emit rule-removed event', (t, done) => {
      tst.addCustomRule('react', 'myRule', { severity: 'error' });
      tst.on('rule-removed', (data) => {
        assert.strictEqual(data.ruleId, 'myRule');
        done();
      });
      tst.removeCustomRule('react', 'myRule');
    });

    it('should not throw when removing non-existent rule', () => {
      assert.doesNotThrow(() => tst.removeCustomRule('react', 'nonexistent'));
    });
  });
});

describe('TechStackTemplates - Checking & Fixing', () => {
  describe('check', () => {
    let tst;
    beforeEach(() => {
      tst = new TechStackTemplates();
      tst.activate('react');
    });

    it('should check naming conventions', () => {
      // Lowercase component file name for .jsx should trigger warning
      const result = tst.check('app.jsx', 'export function app() {}');
      const namingViolations = result.violations.filter(v => v.ruleId.startsWith('naming.'));
      // app.jsx starts with lowercase, should trigger componentFiles warning
      assert.ok(namingViolations.length > 0);
    });

    it('should check comments', () => {
      // Code with exports but no JSDoc
      const code = 'export function MyComponent() { return 1; }';
      const result = tst.check('MyComponent.jsx', code);
      const commentViolations = result.violations.filter(v => v.ruleId.startsWith('comments.'));
      assert.ok(commentViolations.length > 0);
    });

    it('should check rules (e.g., noConsoleLog)', () => {
      tst.addCustomRule('react', 'noConsoleLog', { severity: 'error' });
      const code = 'export function App() { console.log("debug"); }';
      const result = tst.check('App.jsx', code);
      const ruleViolations = result.violations.filter(v => v.ruleId === 'rules.noConsoleLog');
      assert.ok(ruleViolations.length > 0);
    });

    it('should return summary with violation counts', () => {
      const result = tst.check('app.jsx', 'export function app() { console.log("hi"); }');
      assert.ok('total' in result.summary);
      assert.ok('errors' in result.summary);
      assert.ok('warnings' in result.summary);
      assert.ok('infos' in result.summary);
    });

    it('should skip naming check when checkNaming is false', () => {
      const result = tst.check('app.jsx', 'export function app() {}', { checkNaming: false });
      const namingViolations = result.violations.filter(v => v.ruleId.startsWith('naming.'));
      assert.strictEqual(namingViolations.length, 0);
    });

    it('should skip comments check when checkComments is false', () => {
      const code = 'export function App() { return 1; }';
      const result = tst.check('App.jsx', code, { checkComments: false });
      const commentViolations = result.violations.filter(v => v.ruleId.startsWith('comments.'));
      assert.strictEqual(commentViolations.length, 0);
    });

    it('should skip rules check when checkRules is false', () => {
      const code = 'export function App() { console.log("hi"); }';
      const result = tst.check('App.jsx', code, { checkRules: false });
      const ruleViolations = result.violations.filter(v => v.ruleId.startsWith('rules.'));
      assert.strictEqual(ruleViolations.length, 0);
    });

    it('should emit check-complete event', (t, done) => {
      tst.on('check-complete', (data) => {
        assert.ok(data.filePath);
        assert.ok(data.violations);
        done();
      });
      tst.check('App.jsx', 'export function App() {}');
    });

    it('should throw after shutdown', () => {
      tst.shutdown();
      assert.throws(() => tst.check('App.jsx', 'code'), /shut down/i);
    });

    it('should update stats', () => {
      tst.check('App.jsx', 'export function App() {}');
      const stats = tst.getStats();
      assert.strictEqual(stats.total, 1);
    });
  });

  describe('checkBatch', () => {
    it('should check multiple files', () => {
      const tst = new TechStackTemplates();
      tst.activate('react');
      const files = [
        { filePath: 'App.jsx', code: 'export function App() {}' },
        { filePath: 'app.jsx', code: 'export function app() {}' },
      ];
      const result = tst.checkBatch(files);
      assert.strictEqual(result.results.length, 2);
      assert.ok('totalViolations' in result);
      assert.ok('totalErrors' in result);
      assert.ok('passed' in result);
      tst.shutdown();
    });

    it('should emit batch-check-complete event', (t, done) => {
      const tst = new TechStackTemplates();
      tst.activate('react');
      tst.on('batch-check-complete', () => {
        done();
      });
      tst.checkBatch([{ filePath: 'App.jsx', code: 'export function App() {}' }]);
    });
  });

  describe('autoFix', () => {
    it('should apply fixable violations', () => {
      const tst = new TechStackTemplates();
      const code = 'console.log("debug");';
      const violations = [{
        ruleId: 'rules.noConsoleLog',
        severity: VIOLATION_SEVERITY.WARNING,
        message: 'Avoid console.log',
        fixable: true,
        fix: (c) => c.replace(/console\.(log|error)\s*\([^)]*\);?\s*/g, '// [console removed] '),
      }];
      const result = tst.autoFix('App.jsx', code, violations);
      assert.strictEqual(result.fixed, true);
      assert.ok(result.code.includes('[console removed]'));
      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].applied, true);
      tst.shutdown();
    });

    it('should skip non-fixable violations', () => {
      const tst = new TechStackTemplates();
      const code = 'export function App() {}';
      const violations = [{
        ruleId: 'naming.componentFiles',
        severity: VIOLATION_SEVERITY.WARNING,
        message: 'PascalCase required',
        fixable: false,
      }];
      const result = tst.autoFix('App.jsx', code, violations);
      assert.strictEqual(result.fixed, false);
      assert.strictEqual(result.changes.length, 0);
      tst.shutdown();
    });

    it('should handle fix function errors gracefully', () => {
      const tst = new TechStackTemplates();
      const code = 'some code';
      const violations = [{
        ruleId: 'test.rule',
        severity: VIOLATION_SEVERITY.WARNING,
        message: 'Test',
        fixable: true,
        fix: () => { throw new Error('Fix failed'); },
      }];
      const result = tst.autoFix('App.jsx', code, violations);
      // fix threw, so applied is false but changes still recorded
      assert.strictEqual(result.changes[0].applied, false);
      assert.strictEqual(result.changes[0].error, 'Fix failed');
      tst.shutdown();
    });

    it('should throw after shutdown', () => {
      const tst = new TechStackTemplates();
      tst.shutdown();
      assert.throws(() => tst.autoFix('f.jsx', 'code', []), /shut down/i);
    });
  });
});

describe('TechStackTemplates - Import/Export & Lifecycle', () => {
  describe('exportRules / importRules', () => {
    let tst;
    beforeEach(() => {
      tst = new TechStackTemplates();
      tst.activate('react');
    });

    it('should export rules with expected structure', () => {
      const exported = tst.exportRules();
      assert.strictEqual(exported.version, '1.0.0');
      assert.ok(exported.exportedAt);
      assert.ok(exported.activeStacks.includes('react'));
      assert.ok(exported.templates.react);
      assert.ok(exported.customRules);
    });

    it('should export custom rules', () => {
      tst.addCustomRule('react', 'myRule', { severity: 'error', message: 'Test rule' });
      const exported = tst.exportRules();
      assert.ok(exported.customRules.react);
      assert.strictEqual(exported.customRules.react[0].id, 'myRule');
    });

    it('should import rules', () => {
      const ruleset = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        activeStacks: ['vue'],
        customRules: {},
      };
      const result = tst.importRules(ruleset);
      assert.strictEqual(result.imported, 1);
      assert.ok(tst.getActiveStacks().includes('vue'));
    });

    it('should import custom rules', () => {
      const ruleset = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        activeStacks: ['react'],
        customRules: {
          react: [{ id: 'importedRule', severity: 'warn' }],
        },
      };
      const result = tst.importRules(ruleset);
      assert.strictEqual(result.customRules, 1);
    });

    it('should throw for invalid ruleset format', () => {
      assert.throws(() => tst.importRules(null), /Invalid ruleset/);
      assert.throws(() => tst.importRules({}), /Invalid ruleset/);
    });

    it('should emit rules-imported event', (t, done) => {
      tst.on('rules-imported', () => {
        done();
      });
      tst.importRules({
        activeStacks: ['vue'],
        customRules: {},
      });
    });

    it('should round-trip export/import', () => {
      tst.addCustomRule('react', 'testRule', { severity: 'error' });
      const exported = tst.exportRules();
      const tst2 = new TechStackTemplates();
      tst2.importRules(exported);
      assert.ok(tst2.getActiveStacks().includes('react'));
      tst2.shutdown();
    });
  });

  describe('getStats', () => {
    it('should return stats object', () => {
      const tst = new TechStackTemplates();
      const stats = tst.getStats();
      assert.ok('total' in stats);
      assert.ok('passed' in stats);
      assert.ok('fixed' in stats);
      assert.ok('failed' in stats);
      tst.shutdown();
    });

    it('should reflect check activity', () => {
      const tst = new TechStackTemplates();
      tst.activate('react');
      tst.check('App.jsx', 'export function App() {}');
      const stats = tst.getStats();
      assert.strictEqual(stats.total, 1);
      tst.shutdown();
    });
  });

  describe('shutdown', () => {
    it('should clear all state', () => {
      const tst = new TechStackTemplates();
      tst.activate('react');
      tst.addCustomRule('react', 'rule1', { severity: 'error' });
      tst.shutdown();
      assert.strictEqual(tst._shutDown, true);
      assert.strictEqual(tst.getActiveStacks().length, 0);
    });

    it('should throw on activate after shutdown', () => {
      const tst = new TechStackTemplates();
      tst.shutdown();
      assert.throws(() => tst.activate('react'), /shut down/i);
    });

    it('should throw on check after shutdown', () => {
      const tst = new TechStackTemplates();
      tst.shutdown();
      assert.throws(() => tst.check('f.jsx', 'code'), /shut down/i);
    });

    it('should throw on autoFix after shutdown', () => {
      const tst = new TechStackTemplates();
      tst.shutdown();
      assert.throws(() => tst.autoFix('f.jsx', 'code', []), /shut down/i);
    });

    it('should remove all listeners', () => {
      const tst = new TechStackTemplates();
      tst.shutdown();
      assert.strictEqual(tst.listenerCount('stack-activated'), 0);
    });
  });

  describe('TEMPLATE_CATEGORIES', () => {
    it('should have expected category values', () => {
      assert.strictEqual(TEMPLATE_CATEGORIES.FRONTEND, 'frontend');
      assert.strictEqual(TEMPLATE_CATEGORIES.BACKEND, 'backend');
      assert.strictEqual(TEMPLATE_CATEGORIES.FULLSTACK, 'fullstack');
      assert.strictEqual(TEMPLATE_CATEGORIES.MOBILE, 'mobile');
      assert.strictEqual(TEMPLATE_CATEGORIES.SYSTEMS, 'systems');
      assert.strictEqual(TEMPLATE_CATEGORIES.DATA, 'data');
      assert.strictEqual(TEMPLATE_CATEGORIES.MINIPROGRAM, 'miniprogram');
      assert.strictEqual(TEMPLATE_CATEGORIES.HARMONY, 'harmony');
    });
  });

  describe('VIOLATION_SEVERITY', () => {
    it('should have expected severity values', () => {
      assert.strictEqual(VIOLATION_SEVERITY.ERROR, 'error');
      assert.strictEqual(VIOLATION_SEVERITY.WARNING, 'warning');
      assert.strictEqual(VIOLATION_SEVERITY.INFO, 'info');
    });
  });
});
