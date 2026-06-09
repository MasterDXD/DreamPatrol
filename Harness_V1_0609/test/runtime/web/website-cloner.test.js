'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WebsiteCloner = require(path.join(ROOT, 'src', 'runtime', 'web', 'website-cloner'));
const { CLONE_PHASES, CLONE_STATUS, DEFAULT_CONFIG, COMPONENT_PATTERNS } = WebsiteCloner;

describe('WebsiteCloner - Constructor', () => {
  it('should create instance with default config', () => {
    const cloner = new WebsiteCloner();
    assert.strictEqual(cloner._config.outputFormat, 'html');
    assert.strictEqual(cloner._config.fidelityLevel, 'high');
    assert.strictEqual(cloner._config.maxComponents, 50);
    assert.strictEqual(cloner._status, CLONE_STATUS.IDLE);
    assert.strictEqual(cloner._currentPhase, null);
    cloner.shutdown();
  });

  it('should merge custom options with defaults', () => {
    const cloner = new WebsiteCloner({ fidelityLevel: 'low', maxComponents: 10 });
    assert.strictEqual(cloner._config.fidelityLevel, 'low');
    assert.strictEqual(cloner._config.maxComponents, 10);
    assert.strictEqual(cloner._config.outputFormat, 'html');
    cloner.shutdown();
  });

  it('should expose static constants', () => {
    assert.ok(CLONE_PHASES.RECON);
    assert.ok(CLONE_PHASES.TOKEN_EXTRACTION);
    assert.ok(CLONE_PHASES.COMPONENT_SPEC);
    assert.ok(CLONE_PHASES.BUILD);
    assert.ok(CLONE_PHASES.QA);
    assert.ok(CLONE_STATUS.IDLE);
    assert.ok(CLONE_STATUS.RUNNING);
    assert.ok(CLONE_STATUS.COMPLETED);
    assert.ok(CLONE_STATUS.FAILED);
    assert.ok(DEFAULT_CONFIG);
    assert.ok(COMPONENT_PATTERNS.length > 0);
  });
});

describe('WebsiteCloner - attach methods', () => {
  it('should attach browser adapter', () => {
    const cloner = new WebsiteCloner();
    const mockAdapter = { navigate() {}, executeAction() {} };
    cloner.attachBrowserAdapter(mockAdapter);
    assert.strictEqual(cloner._browserAdapter, mockAdapter);
    cloner.shutdown();
  });

  it('should ignore invalid browser adapter', () => {
    const cloner = new WebsiteCloner();
    cloner.attachBrowserAdapter(null);
    cloner.attachBrowserAdapter({ navigate: true });
    cloner.attachBrowserAdapter({});
    assert.strictEqual(cloner._browserAdapter, null);
    cloner.shutdown();
  });

  it('should attach design skill engine', () => {
    const cloner = new WebsiteCloner();
    const mockEngine = { audit() {} };
    cloner.attachDesignSkillEngine(mockEngine);
    assert.strictEqual(cloner._designSkillEngine, mockEngine);
    cloner.shutdown();
  });

  it('should attach subagent executor', () => {
    const cloner = new WebsiteCloner();
    const mockExecutor = { spawn() {} };
    cloner.attachSubagentExecutor(mockExecutor);
    assert.strictEqual(cloner._subagentExecutor, mockExecutor);
    cloner.shutdown();
  });

  it('should support chaining', () => {
    const cloner = new WebsiteCloner();
    const result = cloner
      .attachBrowserAdapter({ navigate() {}, executeAction() {} })
      .attachDesignSkillEngine({ audit() {} })
      .attachSubagentExecutor({ spawn() {} });
    assert.strictEqual(result, cloner);
    cloner.shutdown();
  });
});

describe('WebsiteCloner - clone without browser', () => {
  it('should clone URL and return result structure', async () => {
    const cloner = new WebsiteCloner();
    const result = await cloner.clone('https://example.com');
    assert.strictEqual(result.url, 'https://example.com');
    assert.strictEqual(result.status, CLONE_STATUS.COMPLETED);
    assert.ok(result.recon);
    assert.ok(result.tokens);
    assert.ok(result.specs);
    assert.ok(result.build);
    assert.ok(result.qa);
    assert.ok(Number.isFinite(result.durationMs));
    cloner.shutdown();
  });

  it('should include warning when no browser adapter', async () => {
    const cloner = new WebsiteCloner();
    const result = await cloner.clone('https://example.com');
    assert.ok(result.recon.warning);
    assert.strictEqual(result.recon.computedStyles.length, 0);
    cloner.shutdown();
  });

  it('should reject empty URL', async () => {
    const cloner = new WebsiteCloner();
    await assert.rejects(() => cloner.clone(''), { message: 'URL is required' });
    await assert.rejects(() => cloner.clone(null), { message: 'URL is required' });
    cloner.shutdown();
  });

  it('should normalize URL without protocol', async () => {
    const cloner = new WebsiteCloner();
    const result = await cloner.clone('example.com');
    assert.strictEqual(result.url, 'https://example.com');
    cloner.shutdown();
  });

  it('should reject clone when already running', async () => {
    const cloner = new WebsiteCloner();
    const clonePromise = cloner.clone('https://example.com');
    await assert.rejects(() => cloner.clone('https://other.com'), { message: 'Clone already in progress' });
    await clonePromise;
    cloner.shutdown();
  });

  it('should reject after shutdown', async () => {
    const cloner = new WebsiteCloner();
    cloner.shutdown();
    await assert.rejects(() => cloner.clone('https://example.com'));
  });
});

describe('WebsiteCloner - token extraction', () => {
  it('should extract colors from computed styles', async () => {
    const cloner = new WebsiteCloner();
    const reconResult = {
      url: 'https://test.com',
      computedStyles: [
        { properties: { color: 'rgb(0, 0, 0)', 'background-color': '#ffffff' }, selector: 'body' },
        { properties: { color: '#2563eb', 'font-size': '16px' }, selector: 'a' },
        { properties: { color: 'rgb(0, 0, 0)', 'font-size': '24px' }, selector: 'h1' },
      ],
      assets: { images: [], fonts: [], svgs: [] },
      meta: {},
      screenshots: [],
    };
    const result = cloner._tokenExtractionPhase(reconResult, DEFAULT_CONFIG);
    assert.ok(result.tokens);
    assert.ok(result.tokens.colors);
    assert.ok(result.tokens.colors.primary || result.tokens.colors.neutral || result.tokens.colors.accent);
    assert.ok(result.tokens.typography.sizes.length > 0);
    cloner.shutdown();
  });

  it('should handle empty computed styles', () => {
    const cloner = new WebsiteCloner();
    const reconResult = {
      url: 'https://test.com',
      computedStyles: [],
      assets: { images: [], fonts: [], svgs: [] },
      meta: {},
    };
    const result = cloner._tokenExtractionPhase(reconResult, DEFAULT_CONFIG);
    assert.ok(result.tokens);
    assert.strictEqual(result.tokens.typography.families.length, 0);
    cloner.shutdown();
  });

  it('should normalize rgb colors to hex', () => {
    const cloner = new WebsiteCloner();
    assert.strictEqual(cloner._normalizeColorToHex('rgb(255, 0, 0)'), '#ff0000');
    assert.strictEqual(cloner._normalizeColorToHex('rgba(0, 128, 255, 0.5)'), '#0080ff');
    assert.strictEqual(cloner._normalizeColorToHex('#abc'), '#aabbcc');
    assert.strictEqual(cloner._normalizeColorToHex('#aabbcc'), '#aabbcc');
    assert.strictEqual(cloner._normalizeColorToHex('transparent'), null);
    assert.strictEqual(cloner._normalizeColorToHex('inherit'), null);
    assert.strictEqual(cloner._normalizeColorToHex(null), null);
  });

  it('should cluster similar colors', () => {
    const cloner = new WebsiteCloner();
    const colorMap = new Map([
      ['#000000', 10],
      ['#010101', 8],
      ['#2563eb', 5],
      ['#ffffff', 15],
    ]);
    const result = cloner._clusterColors(colorMap, 0.05);
    assert.ok(result.primary || result.neutral || result.accent);
  });

  it('should detect spacing patterns', () => {
    const cloner = new WebsiteCloner();
    const spacingValues = new Set(['4px', '8px', '12px', '16px', '24px', '32px']);
    const patterns = cloner._detectSpacingPatterns(spacingValues);
    assert.ok(patterns.length > 0);
    assert.strictEqual(patterns[0].baseUnit, 4);
    assert.ok(patterns[0].multiples.length > 0);
  });
});

describe('WebsiteCloner - component spec', () => {
  it('should identify navigation component', () => {
    const cloner = new WebsiteCloner();
    const reconResult = {
      computedStyles: [
        { selector: 'nav.main-nav', properties: { display: 'flex' }, textContent: 'Home About', childrenCount: 3 },
      ],
      url: 'https://test.com',
    };
    const tokenResult = { tokens: { colors: {}, typography: { families: [], sizes: [], weights: [] }, spacing: { values: [], patterns: [] }, borderRadius: { values: [] }, shadows: { values: [] }, transitions: { values: [] } } };
    const result = cloner._componentSpecPhase(reconResult, tokenResult, DEFAULT_CONFIG);
    assert.ok(result.components.length > 0);
    assert.strictEqual(result.components[0].type, 'navigation');
    cloner.shutdown();
  });

  it('should auto-segment when no patterns match', () => {
    const cloner = new WebsiteCloner();
    const reconResult = {
      computedStyles: [
        { selector: 'div.custom', properties: { display: 'flex' }, textContent: 'Custom section', childrenCount: 5 },
      ],
      url: 'https://test.com',
    };
    const tokenResult = { tokens: { colors: {}, typography: { families: [], sizes: [], weights: [] }, spacing: { values: [], patterns: [] }, borderRadius: { values: [] }, shadows: { values: [] }, transitions: { values: [] } } };
    const result = cloner._componentSpecPhase(reconResult, tokenResult, DEFAULT_CONFIG);
    assert.ok(result.components.length > 0);
    cloner.shutdown();
  });
});

describe('WebsiteCloner - build phase', () => {
  it('should generate HTML and CSS output', () => {
    const cloner = new WebsiteCloner();
    const specResult = {
      components: [
        { id: 'comp-1', type: 'navigation', spec: { designTokens: { colors: { textColor: '#000000', backgroundColor: '#ffffff' }, typography: { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400' }, spacing: { padding: '16px' } }, content: ['Home', 'About'] } },
        { id: 'comp-2', type: 'hero', spec: { designTokens: { colors: {}, typography: {}, spacing: {} }, content: ['Welcome'] } },
      ],
      sourceUrl: 'https://test.com',
    };
    const tokenResult = {
      tokens: {
        colors: { primary: [{ representative: '#2563eb', members: ['#2563eb'], frequency: 5 }], neutral: [{ representative: '#18181b', members: ['#18181b'], frequency: 10 }], accent: [] },
        typography: { families: ['Inter'], sizes: [{ value: '16px', frequency: 10 }], weights: ['400'] },
        spacing: { values: ['16px'], patterns: [{ baseUnit: 4, multiples: [4] }] },
        borderRadius: { values: ['8px'] },
        shadows: { values: [] },
        transitions: { values: [] },
      },
    };
    const result = cloner._buildPhase(specResult, tokenResult, DEFAULT_CONFIG);
    assert.ok(result.html);
    assert.ok(result.css);
    assert.ok(result.html.includes('<!DOCTYPE html>'));
    assert.ok(result.css.includes(':root'));
    assert.ok(result.css.includes('--color-primary-1'));
    assert.strictEqual(result.componentCount, 2);
    cloner.shutdown();
  });
});

describe('WebsiteCloner - QA phase', () => {
  it('should return quality score 100 for valid build', async () => {
    const cloner = new WebsiteCloner();
    const buildResult = { html: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Test Page</title></head><body><main><h1>Welcome</h1><p>Content paragraph with text</p></main></body></html>', css: ':root { --color-primary: #3366cc; --color-secondary: #cc6633; --font-body: "Helvetica Neue", sans-serif; --spacing-md: 16px; } body { color: var(--color-primary); font-family: var(--font-body); margin: 0; padding: var(--spacing-md); }', componentCount: 3 };
    const reconResult = { screenshots: [{ breakpoint: 'desktop' }] };
    const result = await cloner._qaPhase(buildResult, reconResult, DEFAULT_CONFIG);
    assert.strictEqual(result.qualityScore, 100);
    assert.strictEqual(result.issues.length, 0);
    cloner.shutdown();
  });

  it('should detect empty HTML', async () => {
    const cloner = new WebsiteCloner();
    const buildResult = { html: '', css: '', componentCount: 0 };
    const reconResult = {};
    const result = await cloner._qaPhase(buildResult, reconResult, DEFAULT_CONFIG);
    assert.ok(result.qualityScore < 100);
    assert.ok(result.issues.length > 0);
    cloner.shutdown();
  });
});

describe('WebsiteCloner - events', () => {
  it('should emit phase-started and phase-completed events', async () => {
    const cloner = new WebsiteCloner();
    const phases = [];
    cloner.on('phase-started', (e) => phases.push('start:' + e.phase));
    cloner.on('phase-completed', (e) => phases.push('complete:' + e.phase));
    await cloner.clone('https://example.com');
    assert.ok(phases.includes('start:recon'));
    assert.ok(phases.includes('complete:recon'));
    assert.ok(phases.includes('start:qa'));
    assert.ok(phases.includes('complete:qa'));
    cloner.shutdown();
  });

  it('should emit clone-completed event', async () => {
    const cloner = new WebsiteCloner();
    let eventFired = false;
    cloner.on('clone-completed', () => { eventFired = true; });
    await cloner.clone('https://example.com');
    assert.strictEqual(eventFired, true);
    cloner.shutdown();
  });
});

describe('WebsiteCloner - getStats / getStatus', () => {
  it('should return stats after clone', async () => {
    const cloner = new WebsiteCloner();
    await cloner.clone('https://example.com');
    const stats = cloner.getStats();
    assert.strictEqual(stats.clonesCompleted, 1);
    assert.strictEqual(stats.clonesFailed, 0);
    assert.ok(Number.isFinite(stats.totalDurationMs));
    cloner.shutdown();
  });

  it('should return status', async () => {
    const cloner = new WebsiteCloner();
    const status = cloner.getStatus();
    assert.strictEqual(status.status, CLONE_STATUS.IDLE);
    assert.strictEqual(status.currentPhase, null);
    cloner.shutdown();
  });
});

describe('WebsiteCloner - shutdown', () => {
  it('should clear state on shutdown', async () => {
    const cloner = new WebsiteCloner();
    await cloner.clone('https://example.com');
    cloner.shutdown();
    assert.strictEqual(cloner._status, CLONE_STATUS.IDLE);
    assert.strictEqual(cloner._browserAdapter, null);
    assert.strictEqual(cloner._lastResult, null);
  });
});
