'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const DesignSkillEngine = require('../../src/gate/design-skill-engine');

describe('DesignSkillEngine - Static Constants', function() {

  describe('static constants', function() {
    it('should expose ANTI_PATTERNS as static', function() {
      assert.ok(DesignSkillEngine.ANTI_PATTERNS);
      assert.ok(DesignSkillEngine.ANTI_PATTERNS.color);
    });

    it('should expose TYPOGRAPHY_SCALE as static', function() {
      assert.ok(DesignSkillEngine.TYPOGRAPHY_SCALE);
      assert.ok(DesignSkillEngine.TYPOGRAPHY_SCALE.base);
    });

    it('should expose COLOR_SYSTEMS as static', function() {
      assert.ok(DesignSkillEngine.COLOR_SYSTEMS);
      assert.ok(DesignSkillEngine.COLOR_SYSTEMS.zinc);
    });

    it('should expose MOTION_PRESETS as static', function() {
      assert.ok(DesignSkillEngine.MOTION_PRESETS);
      assert.ok(DesignSkillEngine.MOTION_PRESETS.smooth);
    });

    it('should expose COMPANY_DESIGN_LANGUAGES as static', function() {
      assert.ok(DesignSkillEngine.COMPANY_DESIGN_LANGUAGES);
      assert.ok(DesignSkillEngine.COMPANY_DESIGN_LANGUAGES.apple);
    });

    it('should expose RESPONSIVE_BREAKPOINTS as static', function() {
      assert.ok(DesignSkillEngine.RESPONSIVE_BREAKPOINTS);
      assert.ok(DesignSkillEngine.RESPONSIVE_BREAKPOINTS.md);
      assert.strictEqual(DesignSkillEngine.RESPONSIVE_BREAKPOINTS.md.columns, 8);
    });

    it('should expose VISUAL_HIERARCHY as static', function() {
      assert.ok(DesignSkillEngine.VISUAL_HIERARCHY);
      assert.ok(DesignSkillEngine.VISUAL_HIERARCHY.shadows);
      assert.ok(DesignSkillEngine.VISUAL_HIERARCHY.zIndex);
      assert.ok(DesignSkillEngine.VISUAL_HIERARCHY.opacity);
    });

    it('should expose COMPONENT_TOKENS as static', function() {
      assert.ok(DesignSkillEngine.COMPONENT_TOKENS);
      assert.ok(DesignSkillEngine.COMPONENT_TOKENS.button);
      assert.ok(DesignSkillEngine.COMPONENT_TOKENS.input);
      assert.ok(DesignSkillEngine.COMPONENT_TOKENS.card);
      assert.ok(DesignSkillEngine.COMPONENT_TOKENS.modal);
      assert.ok(DesignSkillEngine.COMPONENT_TOKENS.section);
    });

    it('should expose MICRO_INTERACTIONS as static', function() {
      assert.ok(DesignSkillEngine.MICRO_INTERACTIONS);
      assert.ok(DesignSkillEngine.MICRO_INTERACTIONS.hover);
      assert.ok(DesignSkillEngine.MICRO_INTERACTIONS.press);
    });

    it('should expose ACCESSIBILITY_STANDARDS as static', function() {
      assert.ok(DesignSkillEngine.ACCESSIBILITY_STANDARDS);
      assert.strictEqual(DesignSkillEngine.ACCESSIBILITY_STANDARDS.wcagLevel, 'AA');
    });

    it('should expose INTERACTION_STATES as static', function() {
      assert.ok(DesignSkillEngine.INTERACTION_STATES);
      assert.ok(DesignSkillEngine.INTERACTION_STATES.idle);
      assert.ok(DesignSkillEngine.INTERACTION_STATES.hover);
      assert.ok(DesignSkillEngine.INTERACTION_STATES.disabled);
    });
  });
});
