'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const DesignSkillEngine = require('../../src/gate/design-skill-engine');

describe('DesignSkillEngine - Design', function() {
  let engine;

  before(function() {
    engine = new DesignSkillEngine(process.cwd());
  });

  describe('getCompanyDesignLanguage()', function() {
    it('should return all companies when no name given', function() {
      const companies = engine.getCompanyDesignLanguage();
      assert.ok(companies.apple);
      assert.ok(companies.stripe);
      assert.ok(companies.vercel);
      assert.ok(companies.notion);
      assert.ok(companies.github);
    });

    it('should return specific company', function() {
      const apple = engine.getCompanyDesignLanguage('apple');
      assert.ok(apple.name);
      assert.ok(apple.colors);
      assert.ok(apple.borderRadius);
    });

    it('should return null for unknown company', function() {
      assert.strictEqual(engine.getCompanyDesignLanguage('nonexistent'), null);
    });
  });

  describe('getIconCollections()', function() {
    it('should return array of collection names', function() {
      const collections = engine.getIconCollections();
      assert.ok(Array.isArray(collections));
      assert.ok(collections.indexOf('lucide') >= 0);
      assert.ok(collections.indexOf('heroicons') >= 0);
    });
  });

  describe('generateDesignMd()', function() {
    it('should generate markdown with default options', function() {
      const md = engine.generateDesignMd();
      assert.ok(md.indexOf('DESIGN.md') >= 0);
      assert.ok(md.indexOf('Vercel') >= 0);
      assert.ok(md.indexOf('Color System') >= 0);
      assert.ok(md.indexOf('Typography Scale') >= 0);
      assert.ok(md.indexOf('Anti-Patterns') >= 0);
    });

    it('should generate markdown with Apple style', function() {
      const md = engine.generateDesignMd({ company: 'apple', variance: 'creative' });
      assert.ok(md.indexOf('Apple') >= 0);
      assert.ok(md.indexOf('6-7') >= 0);
    });

    it('should include motion presets', function() {
      const md = engine.generateDesignMd();
      assert.ok(md.indexOf('cubic-bezier') >= 0);
    });

    it('should include spacing scale', function() {
      const md = engine.generateDesignMd();
      assert.ok(md.indexOf('4px') >= 0);
    });
  });

  describe('searchIcons()', function() {
    it('should return empty array for empty query', function() {
      const results = engine.searchIcons('');
      assert.strictEqual(results.length, 0);
    });

    it('should return results for valid query', function() {
      const results = engine.searchIcons('plus');
      assert.ok(results.length > 0);
      assert.ok(results[0].collection);
      assert.ok(results[0].usage.indexOf('svg') >= 0);
    });

    it('should filter by collection', function() {
      const results = engine.searchIcons('plus', 'lucide');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].collection, 'lucide');
    });
  });

  describe('getStats()', function() {
    it('should return comprehensive stats', function() {
      const stats = engine.getStats();
      assert.strictEqual(stats.antiPatternRules, 6);
      assert.strictEqual(stats.typographyLevels, 10);
      assert.ok(stats.spacingTokens > 0);
      assert.strictEqual(stats.colorSystems, 3);
      assert.strictEqual(stats.motionPresets, 6);
      assert.strictEqual(stats.varianceLevels, 4);
      assert.ok(stats.iconCollections > 0);
      assert.strictEqual(stats.companyDesignLanguages, 15);
    });
  });
});
