'use strict';
const ChatChain = require('../../src/runtime/collaboration/chat-chain');

const c = new ChatChain();
let passed = 0;
let failed = 0;
let chainId = null;
let annotationId = null;

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

test('createChain', () => {
  const r = c.createChain('brainstorming', null);
  if (!r || !r.chainId) throw new Error('Expected chainId, got ' + JSON.stringify(r));
  chainId = r.chainId;
  console.log('  chainId:', chainId);
});

test('getChain', () => {
  const r = c.getChain(chainId);
  if (!r) throw new Error('Expected chain');
  console.log('  phase:', r.phase);
});

test('addAnnotation', () => {
  const r = c.addAnnotation(chainId, { type: 'review', message: 'Looks good', author: 'tester' });
  if (!r || !r.annotation) throw new Error('Expected annotation');
  annotationId = r.annotation.id;
});

test('resolveAnnotation', () => {
  const r = c.resolveAnnotation(chainId, annotationId, 'Fixed');
  if (!r || !r.annotation || r.annotation.status !== 'resolved') throw new Error('Expected resolved');
});

test('getAnnotationSummary', () => {
  const r = c.getAnnotationSummary(chainId);
  if (r.total !== 1) throw new Error('Expected total=1, got ' + r.total);
  console.log('  summary:', JSON.stringify(r));
});

test('registerArtifact', () => {
  const r = c.registerArtifact(chainId, { name: 'test-artifact', type: 'code', phase: 'coding', content: 'test' });
  if (!r || !r.artifactId) throw new Error('Expected artifactId');
});

test('getChainProgress', () => {
  const r = c.getChainProgress(chainId);
  if (!r) throw new Error('Expected chain progress');
  console.log('  progress:', JSON.stringify(r).substring(0, 100));
});

test('getStats', () => {
  const r = c.getStats();
  if (typeof r.totalChains !== 'number') throw new Error('Expected totalChains');
  console.log('  totalChains:', r.totalChains);
});

c.shutdown();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
