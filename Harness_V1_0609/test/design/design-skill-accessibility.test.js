'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const DesignSkillEngine = require('../../src/gate/design-skill-engine');

describe('DesignSkillEngine - Accessibility - ResponsiveBreakpoints', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return all breakpoints when no name given', function() {
    const bps = engine.getResponsiveBreakpoints();
    assert.ok(bps.xs);
    assert.ok(bps.sm);
    assert.ok(bps.md);
    assert.ok(bps.lg);
    assert.ok(bps.xl);
    assert.ok(bps['2xl']);
  });

  it('should return specific breakpoint', function() {
    const md = engine.getResponsiveBreakpoints('md');
    assert.strictEqual(md.minWidth, 768);
    assert.strictEqual(md.maxWidth, 1023);
    assert.strictEqual(md.columns, 8);
  });

  it('should return null for unknown breakpoint', function() {
    assert.strictEqual(engine.getResponsiveBreakpoints('nonexistent'), null);
  });
});

describe('DesignSkillEngine - Accessibility - VisualHierarchy', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return all hierarchy when no aspect given', function() {
    const vh = engine.getVisualHierarchy();
    assert.ok(vh.shadows);
    assert.ok(vh.zIndex);
    assert.ok(vh.opacity);
  });

  it('should return specific aspect', function() {
    const shadows = engine.getVisualHierarchy('shadows');
    assert.ok(shadows.xs);
    assert.ok(shadows.md);
    assert.ok(shadows['2xl']);
    const zIndex = engine.getVisualHierarchy('zIndex');
    assert.strictEqual(zIndex.modal, 1050);
  });

  it('should return null for unknown aspect', function() {
    assert.strictEqual(engine.getVisualHierarchy('nonexistent'), null);
  });
});

describe('DesignSkillEngine - Accessibility - ComponentTokens', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return all tokens when no component given', function() {
    const tokens = engine.getComponentTokens();
    assert.ok(tokens.button);
    assert.ok(tokens.input);
    assert.ok(tokens.card);
    assert.ok(tokens.modal);
  });

  it('should return specific component tokens', function() {
    const btn = engine.getComponentTokens('button');
    assert.ok(btn.variants);
    assert.ok(btn.sizes);
    assert.ok(btn.borderRadius);
  });

  it('should return null for unknown component', function() {
    assert.strictEqual(engine.getComponentTokens('nonexistent'), null);
  });
});

describe('DesignSkillEngine - Accessibility - MicroInteractions', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return all interactions when no name given', function() {
    const mi = engine.getMicroInteractions();
    assert.ok(mi.hover);
    assert.ok(mi.press);
    assert.ok(mi.focus);
    assert.ok(mi.fadeIn);
    assert.ok(mi.skeleton);
  });

  it('should return specific interaction', function() {
    const hover = engine.getMicroInteractions('hover');
    assert.strictEqual(hover.scale, 1.02);
    assert.strictEqual(hover.duration, 150);
  });

  it('should return null for unknown interaction', function() {
    assert.strictEqual(engine.getMicroInteractions('nonexistent'), null);
  });
});

describe('DesignSkillEngine - Accessibility - AccessibilityStandards', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return all standards when no aspect given', function() {
    const a11y = engine.getAccessibilityStandards();
    assert.strictEqual(a11y.wcagLevel, 'AA');
    assert.ok(a11y.contrastRatios);
    assert.ok(a11y.focusRequirements);
    assert.ok(a11y.touchTargets);
  });

  it('should return specific aspect', function() {
    const ratios = engine.getAccessibilityStandards('contrastRatios');
    assert.strictEqual(ratios.normal, 4.5);
    assert.strictEqual(ratios.large, 3);
  });

  it('should return null for unknown aspect', function() {
    assert.strictEqual(engine.getAccessibilityStandards('nonexistent'), null);
  });
});

describe('DesignSkillEngine - Accessibility - InteractionStates', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return all states when no state given', function() {
    const states = engine.getInteractionStates();
    assert.ok(states.idle);
    assert.ok(states.hover);
    assert.ok(states.active);
    assert.ok(states.focus);
    assert.ok(states.disabled);
    assert.ok(states.loading);
    assert.ok(states.error);
    assert.ok(states.selected);
  });

  it('should return specific state', function() {
    const disabled = engine.getInteractionStates('disabled');
    assert.strictEqual(disabled.opacity, 0.5);
    assert.strictEqual(disabled.cursor, 'not-allowed');
  });

  it('should return null for unknown state', function() {
    assert.strictEqual(engine.getInteractionStates('nonexistent'), null);
  });
});

describe('DesignSkillEngine - Accessibility - ContrastCheck', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return correct ratio for white on black', function() {
    const result = engine.checkContrast('#ffffff', '#000000');
    assert.strictEqual(result.ratio, 21);
    assert.strictEqual(result.aa, true);
    assert.strictEqual(result.aaa, true);
  });

  it('should return correct ratio for same color', function() {
    const result = engine.checkContrast('#ffffff', '#ffffff');
    assert.strictEqual(result.ratio, 1);
    assert.strictEqual(result.aa, false);
    assert.strictEqual(result.aaa, false);
  });

  it('should pass AA for good contrast', function() {
    const result = engine.checkContrast('#1d1d1f', '#f5f5f7');
    assert.ok(result.ratio >= 4.5);
    assert.strictEqual(result.aa, true);
    assert.strictEqual(result.aaLarge, true);
  });

  it('should fail AA for poor contrast', function() {
    const result = engine.checkContrast('#a1a1aa', '#e4e4e7');
    assert.ok(result.ratio < 4.5);
    assert.strictEqual(result.aa, false);
  });

  it('should distinguish AA and AAA levels', function() {
    const result = engine.checkContrast('#18181b', '#f4f4f5');
    assert.ok(result.aa);
    assert.ok(result.ratio >= 4.5);
    if (result.ratio >= 7) {
      assert.strictEqual(result.aaa, true);
    }
  });
});

describe('DesignSkillEngine - Accessibility - RelativeLuminance', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return 1 for white', function() {
    const lum = engine._relativeLuminance('#ffffff');
    assert.strictEqual(lum, 1);
  });

  it('should return 0 for black', function() {
    const lum = engine._relativeLuminance('#000000');
    assert.strictEqual(lum, 0);
  });

  it('should return 0 for invalid input', function() {
    assert.strictEqual(engine._relativeLuminance(null), 0);
    assert.strictEqual(engine._relativeLuminance(''), 0);
    assert.strictEqual(engine._relativeLuminance('abc'), 0);
    assert.ok(engine._relativeLuminance('#fff') > 0);
  });

  it('should return value between 0 and 1 for gray', function() {
    const lum = engine._relativeLuminance('#808080');
    assert.ok(lum > 0);
    assert.ok(lum < 1);
  });
});

describe('DesignSkillEngine - Accessibility - CSSGeneration', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should generate responsive CSS with media queries', function() {
    const css = engine.generateResponsiveCSS();
    assert.ok(css.indexOf('@media (min-width:') >= 0);
    assert.ok(css.indexOf('--grid-columns') >= 0);
    assert.ok(css.indexOf('--grid-margin') >= 0);
    assert.ok(css.indexOf('--grid-gutter') >= 0);
  });

  it('should not include xs breakpoint (minWidth 0)', function() {
    const css = engine.generateResponsiveCSS();
    assert.ok(css.indexOf('min-width: 0px') < 0);
  });

  it('should include md breakpoint with 8 columns', function() {
    const css = engine.generateResponsiveCSS();
    assert.ok(css.indexOf('768px') >= 0);
    assert.ok(css.indexOf('8') >= 0);
  });

  it('should generate focus ring CSS variables', function() {
    const css = engine.generateAccessibilityCSS();
    assert.ok(css.indexOf('--a11y-focus-ring') >= 0);
    assert.ok(css.indexOf('--a11y-min-touch') >= 0);
    assert.ok(css.indexOf('--a11y-min-font') >= 0);
  });

  it('should include prefers-reduced-motion media query', function() {
    const css = engine.generateAccessibilityCSS();
    assert.ok(css.indexOf('prefers-reduced-motion') >= 0);
    assert.ok(css.indexOf('animation-duration') >= 0);
    assert.ok(css.indexOf('transition-duration') >= 0);
  });

  it('should include skip-link styles', function() {
    const css = engine.generateAccessibilityCSS();
    assert.ok(css.indexOf('.skip-link') >= 0);
    assert.ok(css.indexOf(':focus') >= 0);
  });

  it('should generate CSS for button component', function() {
    const css = engine.generateComponentCSS('button');
    assert.ok(css.indexOf('button') >= 0);
    assert.ok(css.indexOf('--button-') >= 0);
  });

  it('should generate CSS for input component', function() {
    const css = engine.generateComponentCSS('input');
    assert.ok(css.indexOf('input') >= 0);
    assert.ok(css.indexOf('--input-') >= 0);
  });

  it('should return empty string for unknown component', function() {
    assert.strictEqual(engine.generateComponentCSS('nonexistent'), '');
  });
});

describe('DesignSkillEngine - Accessibility - AuditAccessibility', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return score 0 for empty input', function() {
    const result = engine.auditAccessibility('');
    assert.strictEqual(result.score, 0);
  });

  it('should return score 0 for non-string input', function() {
    const result = engine.auditAccessibility(null);
    assert.strictEqual(result.score, 0);
  });

  it('should detect missing ARIA attributes', function() {
    const result = engine.auditAccessibility('body { color: #333; }');
    assert.ok(result.issues.some(function(i) { return i.ruleId === 'missing-aria'; }));
  });

  it('should detect missing alt text on images', function() {
    const result = engine.auditAccessibility('<img src="photo.jpg">');
    assert.ok(result.issues.some(function(i) { return i.ruleId === 'missing-alt'; }));
  });

  it('should detect missing labels on inputs', function() {
    const result = engine.auditAccessibility('<input type="text">');
    assert.ok(result.issues.some(function(i) { return i.ruleId === 'missing-label'; }));
  });

  it('should detect missing prefers-reduced-motion', function() {
    const result = engine.auditAccessibility('div { animation: fadeIn 0.3s; }');
    assert.ok(result.issues.some(function(i) { return i.ruleId === 'no-reduced-motion'; }));
  });

  it('should detect missing focus styles', function() {
    const result = engine.auditAccessibility('div { color: #333; }');
    assert.ok(result.issues.some(function(i) { return i.ruleId === 'no-focus-style'; }));
  });

  it('should return high score for accessible CSS', function() {
    const css = 'button:focus-visible { outline: 2px solid blue; } [aria-label] { } @media (prefers-reduced-motion: reduce) { * { animation: none; } }';
    const result = engine.auditAccessibility(css);
    assert.ok(result.score > 50);
  });
});

describe('DesignSkillEngine - Accessibility - HealthCheck', function() {
  let engine;
  before(function() { engine = new DesignSkillEngine(process.cwd()); });

  it('should return true', function() {
    assert.strictEqual(engine.isHealthy(), true);
  });
});
