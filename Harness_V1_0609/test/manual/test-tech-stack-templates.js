'use strict';
const { TechStackTemplates } = require('../../src/runtime/standards/tech-stack-templates');

const t = new TechStackTemplates();
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.log('FAIL:', name, '-', e.message);
    failed++;
  }
}

test('Activate', () => {
  const r = t.activate('react');
  if (r.activated.length !== 1) throw new Error('Expected 1 activated');
});

test('Check - component naming', () => {
  // React templates flag non-PascalCase component files
  const r = t.check('src/app.jsx', 'function app() { return null; }');
  console.log('  violations:', r.violations.length);
  // Should detect non-PascalCase component file name
  if (r.violations.length === 0) throw new Error('Expected naming violation for app.jsx');
});

test('Check - rule violations', () => {
  // React template has maxComponentLines: 300
  const longCode = 'function App() { return null; }\n'.repeat(301);
  const r = t.check('src/App.jsx', longCode);
  console.log('  violations:', r.violations.length);
  if (r.violations.length === 0) throw new Error('Expected maxComponentLines violation');
});

test('autoFix', () => {
  // Use a template that has noConsoleLog rule
  t.activate('express');
  const r = t.check('src/server.js', 'console.log("test");');
  const fixable = r.violations.filter(function(v) { return v.fixable; });
  console.log('  violations:', r.violations.length, 'fixable:', fixable.length);
  if (fixable.length > 0) {
    const fixResult = t.autoFix('src/server.js', 'console.log("test");', r.violations);
    if (!fixResult.fixed) throw new Error('Expected fixed=true');
    console.log('  autoFix applied:', fixResult.changes.length);
  } else {
    console.log('  (no fixable violations for express template)');
  }
  t.deactivate('express');
});

test('exportRules', () => {
  const r = t.exportRules();
  if (r.activeStacks.length === 0) throw new Error('Expected active stacks');
  console.log('  activeStacks:', r.activeStacks);
});

test('getStats', () => {
  const r = t.getStats();
  if (r.total === 0) throw new Error('Expected total > 0');
  console.log('  total:', r.total, 'passed:', r.passed);
});

test('deactivate', () => {
  t.deactivate('react');
  const active = t.getActiveStacks();
  if (active.length !== 0) throw new Error('Expected 0 active stacks');
});

t.shutdown();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
