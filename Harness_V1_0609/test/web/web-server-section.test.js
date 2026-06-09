'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const DashboardServer = require(path.join(ROOT, 'src', 'web', 'server'));

process.env.NODE_ENV = 'development';
process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
delete process.env.HARNESS_API_TOKEN;

function fetch(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

describe('DashboardServer - Section Tokens API', () => {
  let server; let port;
  let origApiToken;
  before(async () => {
    origApiToken = process.env.HARNESS_API_TOKEN;
    delete process.env.HARNESS_API_TOKEN;
    port = 0; server = new DashboardServer(ROOT, port); await server.start();
    port = server.port;
  });
  after(() => {
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should return section tokens via dedicated API', async () => {
    const res = await fetch(port, '/api/design/section/tokens');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.component, 'section');
    assert.ok(res.data.tokens);
    assert.ok(Array.isArray(res.data.tokens.variants));
    assert.ok(res.data.tokens.spacing);
    assert.ok(res.data.tokens.animation);
  });

  it('should filter section tokens by variant', async () => {
    const res = await fetch(port, '/api/design/section/tokens?variant=collapsible');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.activeVariant, 'collapsible');
  });

  it('should filter section tokens by spacing', async () => {
    const res = await fetch(port, '/api/design/section/tokens?spacing=compact');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.activeSpacing, 'compact');
    assert.ok(res.data.spacingValues);
    assert.ok(res.data.spacingValues.padding);
    assert.ok(res.data.spacingValues.gap);
  });

  it('should reject invalid variant in section tokens', async () => {
    const res = await fetch(port, '/api/design/section/tokens?variant=nonexistent');
    assert.equal(res.status, 400);
  });

  it('should reject invalid spacing in section tokens', async () => {
    const res = await fetch(port, '/api/design/section/tokens?spacing=huge');
    assert.equal(res.status, 400);
  });
});

describe('DashboardServer - Section CSS API', () => {
  let server; let port;
  let origApiToken;
  before(async () => {
    origApiToken = process.env.HARNESS_API_TOKEN;
    delete process.env.HARNESS_API_TOKEN;
    port = 0; server = new DashboardServer(ROOT, port); await server.start();
    port = server.port;
  });
  after(() => {
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should return section CSS with variant', async () => {
    const res = await fetch(port, '/api/design/section/css?variant=accent&accentColor=primary');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.component, 'section');
    assert.strictEqual(res.data.variant, 'accent');
    assert.strictEqual(res.data.accentColor, 'primary');
    assert.ok(res.data.baseCSS);
    assert.ok(res.data.variantCSS);
    assert.ok(res.data.animation);
  });

  it('should return section CSS with titleSize', async () => {
    const res = await fetch(port, '/api/design/section/css?variant=default&titleSize=lg');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.titleSize, 'lg');
    assert.ok(res.data.variantCSS.indexOf('ds-section--title-lg') >= 0);
    assert.ok(res.data.variantCSS.indexOf('0.875rem') >= 0);
  });

  it('should return section CSS with borderRadius', async () => {
    const res = await fetch(port, '/api/design/section/css?variant=bordered&borderRadius=lg');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.borderRadius, 'lg');
    assert.ok(res.data.variantCSS.indexOf('ds-section--radius-lg') >= 0);
    assert.ok(res.data.variantCSS.indexOf('12px') >= 0);
  });

  it('should reject invalid titleSize in section CSS', async () => {
    const res = await fetch(port, '/api/design/section/css?titleSize=xl');
    assert.equal(res.status, 400);
  });

  it('should reject invalid borderRadius in section CSS', async () => {
    const res = await fetch(port, '/api/design/section/css?borderRadius=huge');
    assert.equal(res.status, 400);
  });

  it('should reject invalid variant in section CSS', async () => {
    const res = await fetch(port, '/api/design/section/css?variant=invalid');
    assert.equal(res.status, 400);
  });

  it('should reject invalid spacing in section CSS', async () => {
    const res = await fetch(port, '/api/design/section/css?spacing=invalid');
    assert.equal(res.status, 400);
  });

  it('should reject invalid accentColor in section CSS', async () => {
    const res = await fetch(port, '/api/design/section/css?variant=accent&accentColor=invalid');
    assert.equal(res.status, 400);
  });

  it('should return section CSS with titleSize and borderRadius', async () => {
    const res = await fetch(port, '/api/design/section/css?variant=bordered&titleSize=sm&borderRadius=lg');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.titleSize, 'sm');
    assert.strictEqual(res.data.borderRadius, 'lg');
  });
});

describe('DashboardServer - Section Variants API', () => {
  let server; let port;
  let origApiToken;
  before(async () => {
    origApiToken = process.env.HARNESS_API_TOKEN;
    delete process.env.HARNESS_API_TOKEN;
    port = 0; server = new DashboardServer(ROOT, port); await server.start();
    port = server.port;
  });
  after(() => {
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });
  it('should return section variants list', async () => {
    const res = await fetch(port, '/api/design/section/variants');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.component, 'section');
    assert.ok(Array.isArray(res.data.variants));
    assert.strictEqual(res.data.variants.length, 5);
    assert.ok(res.data.variants[0].name);
    assert.ok(res.data.variants[0].description);
    assert.ok(res.data.variants[0].className);
    assert.ok(Array.isArray(res.data.spacingOptions));
    assert.ok(Array.isArray(res.data.accentColors));
    assert.ok(res.data.animation);
  });

  it('should return titleSizes in section variants', async () => {
    const res = await fetch(port, '/api/design/section/variants');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.titleSizes));
    assert.ok(res.data.titleSizes.length >= 3);
    assert.ok(res.data.titleSizes.some(function(t) { return t.name === 'sm'; }));
    assert.ok(res.data.titleSizes.some(function(t) { return t.name === 'md'; }));
    assert.ok(res.data.titleSizes.some(function(t) { return t.name === 'lg'; }));
  });

  it('should return borderRadiusOptions in section variants', async () => {
    const res = await fetch(port, '/api/design/section/variants');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.borderRadiusOptions));
    assert.ok(res.data.borderRadiusOptions.length >= 3);
    assert.ok(res.data.borderRadiusOptions.some(function(b) { return b.name === 'sm'; }));
    assert.ok(res.data.borderRadiusOptions.some(function(b) { return b.name === 'md'; }));
    assert.ok(res.data.borderRadiusOptions.some(function(b) { return b.name === 'lg'; }));
  });
});

describe('DashboardServer - Section Validate API', () => {
  let server; let port;
  let origApiToken;
  before(async () => {
    origApiToken = process.env.HARNESS_API_TOKEN;
    delete process.env.HARNESS_API_TOKEN;
    port = 0; server = new DashboardServer(ROOT, port); await server.start();
    port = server.port;
  });
  after(() => {
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should validate valid section config', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=accent&spacing=default&accentColor=primary');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.strictEqual(res.data.errors.length, 0);
    assert.strictEqual(res.data.config.variant, 'accent');
    assert.strictEqual(res.data.config.spacing, 'default');
    assert.strictEqual(res.data.config.accentColor, 'primary');
  });

  it('should validate invalid section config', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=invalid&spacing=bad&accentColor=nope');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, false);
    assert.ok(res.data.errors.length >= 3);
    assert.ok(res.data.errors.some(function(e) { return e.field === 'variant'; }));
    assert.ok(res.data.errors.some(function(e) { return e.field === 'spacing'; }));
    assert.ok(res.data.errors.some(function(e) { return e.field === 'accentColor'; }));
  });

  it('should warn on hero+compact combination', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=hero&spacing=compact');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.ok(res.data.warnings.length >= 1);
    assert.ok(res.data.warnings.some(function(w) { return w.field === 'spacing'; }));
  });

  it('should warn on accentColor with default variant', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=default&accentColor=primary');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.ok(res.data.warnings.some(function(w) { return w.field === 'accentColor'; }));
  });

  it('should validate collapsible parameter', async () => {
    const res = await fetch(port, '/api/design/section/validate?collapsible=true');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.strictEqual(res.data.config.collapsible, true);
  });

  it('should reject invalid collapsible parameter', async () => {
    const res = await fetch(port, '/api/design/section/validate?collapsible=yes');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, false);
    assert.ok(res.data.errors.some(function(e) { return e.field === 'collapsible'; }));
  });

  it('should validate valid titleSize parameter', async () => {
    const res = await fetch(port, '/api/design/section/validate?titleSize=sm');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.strictEqual(res.data.config.titleSize, 'sm');
  });

  it('should reject invalid titleSize parameter', async () => {
    const res = await fetch(port, '/api/design/section/validate?titleSize=xl');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, false);
    assert.ok(res.data.errors.some(function(e) { return e.field === 'titleSize'; }));
  });

  it('should validate valid borderRadius parameter', async () => {
    const res = await fetch(port, '/api/design/section/validate?borderRadius=lg');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.strictEqual(res.data.config.borderRadius, 'lg');
  });

  it('should reject invalid borderRadius parameter', async () => {
    const res = await fetch(port, '/api/design/section/validate?borderRadius=huge');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, false);
    assert.ok(res.data.errors.some(function(e) { return e.field === 'borderRadius'; }));
  });

  it('should warn on borderRadius with non-bordered variant', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=default&borderRadius=lg');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.ok(res.data.warnings.some(function(w) { return w.field === 'borderRadius'; }));
  });

  it('should not warn on borderRadius with bordered variant', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=bordered&borderRadius=lg');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.ok(!res.data.warnings.some(function(w) { return w.field === 'borderRadius'; }));
  });

  it('should validate combined titleSize and borderRadius', async () => {
    const res = await fetch(port, '/api/design/section/validate?variant=bordered&titleSize=lg&borderRadius=md');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.valid, true);
    assert.strictEqual(res.data.config.titleSize, 'lg');
    assert.strictEqual(res.data.config.borderRadius, 'md');
  });

  it('should validate all accent colors', async () => {
    const colors = ['primary', 'success', 'warning', 'danger', 'purple', 'cyan'];
    for (const color of colors) {
      const res = await fetch(port, '/api/design/section/validate?variant=accent&accentColor=' + color);
      assert.equal(res.status, 200, 'Failed for color: ' + color);
      assert.strictEqual(res.data.valid, true, 'Failed for color: ' + color);
    }
  });
});

describe('DashboardServer - Section Presets API', () => {
  let server; let port;
  let origApiToken;
  before(async () => {
    origApiToken = process.env.HARNESS_API_TOKEN;
    delete process.env.HARNESS_API_TOKEN;
    port = 0; server = new DashboardServer(ROOT, port); await server.start();
    port = server.port;
  });
  after(() => {
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should return section presets', async () => {
    const res = await fetch(port, '/api/design/section/presets');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.component, 'section');
    assert.ok(Array.isArray(res.data.presets));
    assert.ok(res.data.presets.length >= 5);
    assert.ok(Array.isArray(res.data.categories));
    assert.ok(res.data.categories.length >= 2);
    assert.strictEqual(res.data.total, res.data.presets.length);
  });

  it('should filter section presets by category', async () => {
    const res = await fetch(port, '/api/design/section/presets?category=status');
    assert.equal(res.status, 200);
    assert.ok(res.data.presets.length >= 2);
    assert.ok(res.data.presets.every(function(p) { return p.category === 'status'; }));
    assert.ok(res.data.filtered < res.data.total);
  });

  it('should return empty presets for unknown category', async () => {
    const res = await fetch(port, '/api/design/section/presets?category=nonexistent');
    assert.equal(res.status, 200);
    assert.strictEqual(res.data.presets.length, 0);
    assert.strictEqual(res.data.filtered, 0);
  });

  it('should include usage in section presets', async () => {
    const res = await fetch(port, '/api/design/section/presets');
    assert.equal(res.status, 200);
    assert.ok(res.data.presets.every(function(p) { return typeof p.usage === 'string' && p.usage.length > 0; }));
  });

  it('should include config in section presets', async () => {
    const res = await fetch(port, '/api/design/section/presets');
    assert.equal(res.status, 200);
    assert.ok(res.data.presets.every(function(p) { return p.config && typeof p.config.variant === 'string'; }));
  });
});

after(() => { delete process.env.NODE_ENV; delete process.env.HARNESS_ALLOW_DEV_BYPASS; delete process.env.HARNESS_API_TOKEN; });
