'use strict';
const OptimizationLoop = require('../../src/runtime/workflow/optimization-loop');

const loop = new OptimizationLoop();
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

test('defineObjective', () => {
  loop.defineObjective('Test optimization', ['test'], [{ name: 'score', type: 'custom', weight: 1.0 }], { maxIterations: 3 });
  if (!loop._objective) throw new Error('Expected _objective');
});

test('attachMetricsCollector', () => {
  loop.attachMetricsCollector({ track: function() {} });
  // Should not throw
});

test('getProgress', () => {
  const r = loop.getProgress();
  if (typeof r !== 'object') throw new Error('Expected object');
  console.log('  status:', r.status);
});

test('getStats', () => {
  const r = loop.getStats();
  if (typeof r !== 'object') throw new Error('Expected object');
  console.log('  keys:', Object.keys(r).join(','));
});

test('isHealthy', () => {
  const r = loop.isHealthy();
  // Should return boolean
  console.log('  healthy:', r);
});

test('rollbackTo (no snapshots)', () => {
  const r = loop.rollbackTo(0);
  if (!r.error) throw new Error('Expected error when no snapshots');
  console.log('  error:', r.error);
});

loop.shutdown();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
