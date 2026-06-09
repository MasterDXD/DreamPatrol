'use strict';
const IronRuleEngine = require('../../src/runtime/sdd/iron-rule-engine');

const e = new IronRuleEngine();
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed++;
  } catch (e2) {
    console.log('FAIL:', name, '-', e2.message);
    failed++;
  }
}

test('checkViolation', () => {
  const r = e.checkViolation('const password = "secret123";', { filePath: 'src/config.js' });
  if (r.length === 0) throw new Error('Expected violations');
  console.log('  violations:', r.length);
});

test('addRule', () => {
  const r = e.addRule({ id: 'test-rule', name: 'Test Rule', severity: 'warning', category: 'style', check: function(_ctx) { return { violated: false, evidence: '' }; } });
  if (!r || !r.ruleId) throw new Error('Expected ruleId');
});

test('exportRules', () => {
  const r = e.exportRules();
  if (r.ruleCount === 0) throw new Error('Expected ruleCount > 0');
  console.log('  ruleCount:', r.ruleCount);
});

test('getRuleFingerprint', () => {
  const r = e.getRuleFingerprint();
  if (!r || r.length === 0) throw new Error('Expected fingerprint');
  console.log('  fingerprint length:', r.length);
});

test('syncFrom', () => {
  const ruleset = e.exportRules();
  const r = e.syncFrom(ruleset);
  if (r.errors !== 0) throw new Error('Expected 0 errors');
  console.log('  added:', r.added, 'updated:', r.updated, 'removed:', r.removed);
});

test('getRuleStats', () => {
  const r = e.getRuleStats();
  if (typeof r !== 'object') throw new Error('Expected object');
  console.log('  keys:', Object.keys(r).join(','));
});

e.shutdown();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
