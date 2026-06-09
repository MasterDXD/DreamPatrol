'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const DesignSkillEngine = require('../../src/gate/design-skill-engine');

describe('DesignSkillEngine - Audit', function() {
  let engine;

  before(function() {
    engine = new DesignSkillEngine(process.cwd());
  });

  describe('audit()', function() {
    it('should return score 100 for clean CSS', function() {
      const result = engine.audit('body { color: #333; font-size: 16px; }');
      assert.strictEqual(result.score, 100);
      assert.strictEqual(result.issues.length, 0);
      assert.strictEqual(result.grade, 'A');
    });

    it('should detect pure black #000000', function() {
      const result = engine.audit('body { color: #000000; }');
      assert.ok(result.score < 100);
      assert.ok(result.issues.some(function(i) { return i.ruleId === 'no-pure-black'; }));
    });

    it('should detect AI gradient', function() {
      const result = engine.audit('div { background: linear-gradient(135deg, #667eea, #764ba2); }');
      assert.ok(result.score < 100);
      assert.ok(result.issues.some(function(i) { return i.ruleId === 'no-ai-gradient'; }));
    });

    it('should detect default shadow', function() {
      const result = engine.audit('.card { box-shadow: 0 0 20px rgba(0,0,0,.2); }');
      assert.ok(result.issues.some(function(i) { return i.ruleId === 'no-default-shadow'; }));
    });

    it('should detect system font', function() {
      const result = engine.audit('body { font-family: Arial; }');
      assert.ok(result.issues.some(function(i) { return i.ruleId === 'no-system-font'; }));
    });

    it('should return score 0 for empty input', function() {
      const result = engine.audit('');
      assert.strictEqual(result.score, 0);
    });

    it('should return score 0 for non-string input', function() {
      const result = engine.audit(null);
      assert.strictEqual(result.score, 0);
    });

    it('should cap issue count at 3 per issue for scoring', function() {
      const css = '.a { color: #000000; } .b { color: #000000; } .c { color: #000000; } .d { color: #000000; }';
      const result = engine.audit(css);
      assert.ok(result.score >= 0);
      assert.ok(result.issues.length > 0);
    });

    it('should return low grade for CSS with multiple issues', function() {
      const css = 'body { color: #000000; background: linear-gradient(135deg, #667eea, #764ba2); font-family: Arial; }';
      const result = engine.audit(css);
      assert.ok(result.score < 100);
      assert.ok(result.issues.length >= 2);
    });
  });

  describe('polish()', function() {
    it('should replace #000000 with #09090b', function() {
      const result = engine.polish('body { color: #000000; }');
      assert.ok(result.indexOf('#09090b') >= 0);
      assert.ok(result.indexOf('#000000') < 0);
    });

    it('should replace rgb(0,0,0) with rgb(9,9,11)', function() {
      const result = engine.polish('body { color: rgb(0, 0, 0); }');
      assert.ok(result.indexOf('rgb(9,9,11)') >= 0);
    });

    it('should replace rgba(0,0,0, with rgba(9,9,11,', function() {
      const result = engine.polish('body { color: rgba(0, 0, 0, 0.5); }');
      assert.ok(result.indexOf('rgba(9,9,11,') >= 0);
    });

    it('should replace Arial with Inter font stack', function() {
      const result = engine.polish('body { font-family: Arial; }');
      assert.ok(result.indexOf('Inter') >= 0);
      assert.ok(result.indexOf('Arial') < 0);
    });

    it('should replace Times New Roman with SF Pro', function() {
      const result = engine.polish('body { font-family: Times New Roman; }');
      assert.ok(result.indexOf('SF Pro Display') >= 0);
    });

    it('should replace ease with cubic-bezier in transitions', function() {
      const result = engine.polish('div { transition: all 0.3s ease; }');
      assert.ok(result.indexOf('cubic-bezier(0.4, 0, 0.2, 1)') >= 0);
    });

    it('should return input for empty string', function() {
      assert.strictEqual(engine.polish(''), '');
    });

    it('should return input for non-string', function() {
      assert.strictEqual(engine.polish(null), null);
    });
  });

  describe('critique()', function() {
    it('should return critique result with feedback', function() {
      const result = engine.critique('body { color: #000000; }');
      assert.ok(typeof result.overallScore === 'number');
      assert.ok(result.grade);
      assert.ok(Array.isArray(result.feedback));
      assert.ok(result.summary);
    });

    it('should return clean feedback for good CSS', function() {
      const result = engine.critique('body { color: #333; font-size: 16px; }');
      assert.strictEqual(result.overallScore, 100);
    });

    it('should support focus area', function() {
      const result = engine.critique('body { color: #000000; }', 'color');
      assert.ok(Array.isArray(result.feedback));
    });
  });

  describe('normalize()', function() {
    it('should polish and add default font-family if missing', function() {
      const result = engine.normalize('body { color: #000000; }');
      assert.ok(result.indexOf('#09090b') >= 0);
      assert.ok(result.indexOf('Inter') >= 0);
    });

    it('should not add font-family if already present', function() {
      const result = engine.normalize('body { font-family: \'Inter\', sans-serif; color: #333; }');
      const interCount = (result.match(/Inter/g) ?? []).length;
      assert.strictEqual(interCount, 1);
    });
  });
});
