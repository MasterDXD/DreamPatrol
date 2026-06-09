'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { OutputConcisenessGuard } = require(path.join(__dirname, '..', '..', 'src', 'gate', 'output-conciseness-guard'));

describe('OutputConcisenessGuard', () => {
  it('should pass concise output', () => {
    const guard = new OutputConcisenessGuard();
    const result = guard.check('Short and clear response.');
    assert.equal(result.concise, true);
    assert.equal(result.violations.length, 0);
  });

  it('should detect verbose output exceeding token limit', () => {
    const guard = new OutputConcisenessGuard({ maxTokens: 50 });
    const longOutput = 'word '.repeat(200);
    const result = guard.check(longOutput);
    assert.equal(result.concise, false);
    assert.ok(result.violations.some(v => v.type === 'token_limit'));
  });

  it('should detect repetition', () => {
    const guard = new OutputConcisenessGuard({ maxRepetitionRatio: 0.2 });
    const result = guard.check('the quick brown fox the quick brown fox the quick brown fox the quick brown fox');
    assert.ok(result.violations.some(v => v.type === 'repetition'));
  });

  it('should detect filler words', () => {
    const guard = new OutputConcisenessGuard();
    const result = guard.check("It's worth noting that essentially the code basically works. It should be noted that importantly this is fine. Needless to say fundamentally it goes without saying.");
    assert.ok(result.violations.some(v => v.type === 'filler_words'));
  });

  it('should handle empty or non-string input', () => {
    const guard = new OutputConcisenessGuard();
    assert.equal(guard.check(null).concise, true);
    assert.equal(guard.check('').concise, true);
    assert.equal(guard.check(123).concise, true);
  });

  it('should track history and average score', () => {
    const guard = new OutputConcisenessGuard({ maxTokens: 50 });
    guard.check('short');
    guard.check('word '.repeat(200));
    assert.equal(guard.getHistory().length, 2);
    assert.ok(guard.getAverageScore() > 0);
  });

  it('should provide suggestions for violations', () => {
    const guard = new OutputConcisenessGuard({ maxTokens: 20, maxLines: 5 });
    const result = guard.check('line1\nline2\nline3\nline4\nline5\nline6\n' + 'word '.repeat(100));
    assert.ok(result.suggestions.length > 0);
  });

  it('should compute score correctly', () => {
    const guard = new OutputConcisenessGuard();
    const conciseResult = guard.check('Clear and brief.');
    assert.ok(conciseResult.score >= 0.7);
  });
});
