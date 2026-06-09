'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const DesignSkillEngine = require('../../src/gate/design-skill-engine');

describe('DesignSkillEngine - Scales', function() {
  let engine;

  before(function() {
    engine = new DesignSkillEngine(process.cwd());
  });

  describe('getTypographyScale()', function() {
    it('should return all 10 levels', function() {
      const scale = engine.getTypographyScale();
      assert.strictEqual(Object.keys(scale).length, 10);
      assert.ok(scale.xs);
      assert.ok(scale.display);
    });

    it('should have correct structure for each level', function() {
      const scale = engine.getTypographyScale();
      Object.keys(scale).forEach(function(level) {
        assert.ok(scale[level].size, level + ' missing size');
        assert.ok(scale[level].lineHeight, level + ' missing lineHeight');
        assert.ok(typeof scale[level].weight === 'number', level + ' weight not number');
        assert.ok(scale[level].tracking, level + ' missing tracking');
      });
    });
  });

  describe('getSpacingScale()', function() {
    it('should return spacing tokens', function() {
      const scale = engine.getSpacingScale();
      assert.ok(scale[0] === '0');
      assert.ok(scale[4] === '1rem');
      assert.ok(scale[64] === '16rem');
    });
  });

  describe('getColorSystem()', function() {
    it('should return all color systems when no name given', function() {
      const systems = engine.getColorSystem();
      assert.ok(systems.zinc);
      assert.ok(systems.slate);
      assert.ok(systems.neutral);
    });

    it('should return specific color system', function() {
      const zinc = engine.getColorSystem('zinc');
      assert.ok(zinc);
      assert.strictEqual(zinc[950], '#09090b');
    });

    it('should return null for unknown system', function() {
      assert.strictEqual(engine.getColorSystem('nonexistent'), null);
    });
  });

  describe('getMotionPreset()', function() {
    it('should return all presets when no name given', function() {
      const presets = engine.getMotionPreset();
      assert.strictEqual(Object.keys(presets).length, 6);
    });

    it('should return specific preset', function() {
      const micro = engine.getMotionPreset('micro');
      assert.strictEqual(micro.duration, 150);
      assert.ok(micro.easing.indexOf('cubic-bezier') >= 0);
    });

    it('should return null for unknown preset', function() {
      assert.strictEqual(engine.getMotionPreset('nonexistent'), null);
    });
  });

  describe('getDesignVariance()', function() {
    it('should return all levels when no level given', function() {
      const levels = engine.getDesignVariance();
      assert.strictEqual(Object.keys(levels).length, 4);
    });

    it('should return specific level', function() {
      const creative = engine.getDesignVariance('creative');
      assert.ok(creative.variance);
      assert.ok(creative.description);
    });

    it('should return null for unknown level', function() {
      assert.strictEqual(engine.getDesignVariance('nonexistent'), null);
    });
  });
});
