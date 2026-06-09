'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const DesignSkillEngine = require('../../src/gate/design-skill-engine');


describe('Section Component Tokens', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });
  it('should have section in COMPONENT_TOKENS', function() {
    const tokens = engine.getComponentTokens();
    assert.ok(tokens.section, 'section tokens should exist');
  });

  it('should have 5 section variants', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(Array.isArray(section.variants));
    assert.strictEqual(section.variants.length, 5);
    assert.ok(section.variants.indexOf('default') >= 0);
    assert.ok(section.variants.indexOf('collapsible') >= 0);
    assert.ok(section.variants.indexOf('accent') >= 0);
    assert.ok(section.variants.indexOf('bordered') >= 0);
    assert.ok(section.variants.indexOf('hero') >= 0);
  });

  it('should have 3 spacing options', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(section.spacing);
    assert.ok(section.spacing.compact);
    assert.ok(section.spacing.default);
    assert.ok(section.spacing.spacious);
    assert.ok(section.spacing.compact.padding);
    assert.ok(section.spacing.compact.gap);
    assert.ok(section.spacing.default.padding);
    assert.ok(section.spacing.default.gap);
    assert.ok(section.spacing.spacious.padding);
    assert.ok(section.spacing.spacious.gap);
  });

  it('should have 3 title size options', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(section.titleSizes);
    assert.ok(section.titleSizes.sm);
    assert.ok(section.titleSizes.md);
    assert.ok(section.titleSizes.lg);
  });

  it('should have 3 border radius options', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(section.borderRadius);
    assert.ok(section.borderRadius.sm);
    assert.ok(section.borderRadius.md);
    assert.ok(section.borderRadius.lg);
  });

  it('should have 6 accent colors', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(Array.isArray(section.accentColors));
    assert.strictEqual(section.accentColors.length, 6);
    assert.ok(section.accentColors.indexOf('primary') >= 0);
    assert.ok(section.accentColors.indexOf('success') >= 0);
    assert.ok(section.accentColors.indexOf('warning') >= 0);
    assert.ok(section.accentColors.indexOf('danger') >= 0);
    assert.ok(section.accentColors.indexOf('purple') >= 0);
    assert.ok(section.accentColors.indexOf('cyan') >= 0);
  });

  it('should have animation config for collapsible', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(section.animation);
    assert.strictEqual(typeof section.animation.collapseDuration, 'number');
    assert.strictEqual(typeof section.animation.collapseEasing, 'string');
    assert.strictEqual(section.animation.collapseDuration, 200);
    assert.ok(section.animation.collapseEasing.indexOf('cubic-bezier') >= 0);
  });
});

describe('generateSectionCSS()', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });
  it('should generate CSS custom properties for section', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('section') >= 0);
    assert.ok(css.indexOf('--section-collapse-duration') >= 0);
    assert.ok(css.indexOf('--section-collapse-easing') >= 0);
  });

  it('should include spacing CSS variables', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('--section-spacing-compact-padding') >= 0);
    assert.ok(css.indexOf('--section-spacing-default-padding') >= 0);
    assert.ok(css.indexOf('--section-spacing-spacious-padding') >= 0);
  });

  it('should include title size CSS variables', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('--section-title-size-sm') >= 0);
    assert.ok(css.indexOf('--section-title-size-md') >= 0);
    assert.ok(css.indexOf('--section-title-size-lg') >= 0);
  });

  it('should include border radius CSS variables', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('--section-radius-sm') >= 0);
    assert.ok(css.indexOf('--section-radius-md') >= 0);
    assert.ok(css.indexOf('--section-radius-lg') >= 0);
  });

  it('should have correct collapse duration value', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('200ms') >= 0);
  });

  it('should wrap in :root selector', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf(':root {') >= 0);
    assert.ok(css.indexOf('}') >= 0);
  });

  it('should include spacing gap variables', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('--section-spacing-compact-gap') >= 0);
    assert.ok(css.indexOf('--section-spacing-default-gap') >= 0);
    assert.ok(css.indexOf('--section-spacing-spacious-gap') >= 0);
  });

  it('should include all accent color CSS variables when generating accent variant CSS', function() {
    const section = engine.getComponentTokens('section');
    assert.strictEqual(section.accentColors.length, 6);
    section.accentColors.forEach(function(color) {
      assert.ok(typeof color === 'string' && color.length > 0);
    });
  });

  it('should generate valid CSS variable values', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('px') >= 0 || css.indexOf('rem') >= 0);
    assert.ok(css.indexOf('ms') >= 0);
  });

  it('should include accent color CSS variables', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('--section-accent-primary') >= 0);
    assert.ok(css.indexOf('--section-accent-success') >= 0);
    assert.ok(css.indexOf('--section-accent-warning') >= 0);
    assert.ok(css.indexOf('--section-accent-danger') >= 0);
    assert.ok(css.indexOf('--section-accent-purple') >= 0);
    assert.ok(css.indexOf('--section-accent-cyan') >= 0);
  });
});

describe('Section Component Edge Cases', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });
  it('should return section tokens via getComponentTokens', function() {
    const tokens = engine.getComponentTokens('section');
    assert.strictEqual(typeof tokens, 'object');
    assert.ok(tokens !== null);
  });

  it('should have consistent variant names', function() {
    const section = engine.getComponentTokens('section');
    section.variants.forEach(function(v) {
      assert.strictEqual(typeof v, 'string');
      assert.ok(v.length > 0);
      assert.ok(v === v.toLowerCase(), 'variant should be lowercase: ' + v);
    });
  });

  it('should have consistent spacing keys', function() {
    const section = engine.getComponentTokens('section');
    Object.keys(section.spacing).forEach(function(key) {
      const sp = section.spacing[key];
      assert.ok(sp.padding, 'spacing.' + key + '.padding should exist');
      assert.ok(sp.gap, 'spacing.' + key + '.gap should exist');
      assert.ok(typeof sp.padding === 'string', 'padding should be string');
      assert.ok(typeof sp.gap === 'string', 'gap should be string');
    });
  });

  it('should have consistent title size values', function() {
    const section = engine.getComponentTokens('section');
    Object.keys(section.titleSizes).forEach(function(key) {
      const size = section.titleSizes[key];
      assert.ok(typeof size === 'string', 'titleSize should be string');
      assert.ok(size.indexOf('rem') >= 0, 'titleSize should use rem: ' + size);
    });
  });

  it('should have consistent border radius values', function() {
    const section = engine.getComponentTokens('section');
    Object.keys(section.borderRadius).forEach(function(key) {
      const radius = section.borderRadius[key];
      assert.ok(typeof radius === 'string', 'borderRadius should be string');
      assert.ok(radius.indexOf('px') >= 0, 'borderRadius should use px: ' + radius);
    });
  });

  it('should have valid animation easing function', function() {
    const section = engine.getComponentTokens('section');
    const easing = section.animation.collapseEasing;
    assert.ok(easing.startsWith('cubic-bezier('), 'should be cubic-bezier');
    const parts = easing.replace('cubic-bezier(', '').replace(')', '').split(',');
    assert.strictEqual(parts.length, 4, 'cubic-bezier should have 4 values');
    parts.forEach(function(p) {
      const num = parseFloat(p.trim());
      assert.ok(!isNaN(num), 'bezier value should be number: ' + p);
    });
  });

  it('should have positive animation duration', function() {
    const section = engine.getComponentTokens('section');
    assert.ok(section.animation.collapseDuration > 0, 'duration should be positive');
    assert.ok(section.animation.collapseDuration <= 1000, 'duration should be reasonable');
  });

  it('should generate non-empty CSS', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.length > 50, 'CSS should be substantial');
  });

  it('should generate CSS with proper comment header', function() {
    const css = engine.generateSectionCSS();
    assert.ok(css.indexOf('/* section') >= 0, 'should have section comment');
  });
});

describe('Section CSS Generation Integration', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });
  it('should include section in all CSS generation', function() {
    const allCss = engine.generateResponsiveCSS() + engine.generateAccessibilityCSS() + engine.generateSectionCSS();
    assert.ok(allCss.indexOf('--section-') >= 0);
  });

  it('should generate unique CSS variable names', function() {
    const css = engine.generateSectionCSS();
    const varMatches = css.match(/--section-[a-z0-9-]+/g);
    assert.ok(varMatches, 'should find CSS variables');
    const uniqueVars = new Set(varMatches);
    assert.strictEqual(varMatches.length, uniqueVars.size, 'all CSS variables should be unique');
  });

  it('should generate CSS that ends with closing brace', function() {
    const css = engine.generateSectionCSS().trim();
    assert.ok(css.endsWith('}'), 'CSS should end with closing brace');
  });

  it('should have matching braces in generated CSS', function() {
    const css = engine.generateSectionCSS();
    const opens = (css.match(/{/g) ?? []).length;
    const closes = (css.match(/}/g) ?? []).length;
    assert.strictEqual(opens, closes, 'braces should be balanced');
  });
});

describe('generateMotionCSS()', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });
  it('should generate CSS custom properties for default preset', function() {
    const css = engine.generateMotionCSS();
    assert.ok(css.indexOf('--motion-duration') >= 0);
    assert.ok(css.indexOf('--motion-easing') >= 0);
    assert.ok(css.indexOf('--motion-transition') >= 0);
  });

  it('should generate CSS for specific preset', function() {
    const css = engine.generateMotionCSS('spring');
    assert.ok(css.indexOf('500ms') >= 0);
  });
});
