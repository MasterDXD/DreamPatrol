'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const DashboardServer = require(path.join(ROOT, 'src', 'web', 'server'));

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

describe('DashboardServer - Design', () => {
  let server;
  let port;
  let origNodeEnv;
  let origApiToken;

  before(async () => {
    origNodeEnv = process.env.NODE_ENV;
    origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    port = 0;
    server = new DashboardServer(ROOT, port);
    await server.start();
    port = server.port;
  });

  after(() => {
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should return design stats', async () => {
    const res = await fetch(port, '/api/design/stats');
    assert.equal(res.status, 200);
    assert.ok(res.data.antiPatternRules);
    assert.ok(res.data.typographyLevels);
    assert.ok(res.data.spacingTokens);
    assert.ok(res.data.colorSystems);
    assert.ok(res.data.motionPresets);
  });

  it('should return design presets with values', async () => {
    const res = await fetch(port, '/api/design/presets');
    assert.equal(res.status, 200);
    assert.ok(res.data.typography);
    assert.ok(res.data.spacing);
    assert.ok(Array.isArray(res.data.colorSystems));
    assert.ok(res.data.colorValues);
    assert.ok(res.data.motionValues);
    assert.ok(res.data.responsiveValues);
    assert.ok(res.data.componentValues);
    assert.ok(res.data.microInteractionValues);
    assert.ok(res.data.accessibilityValues);
    assert.ok(res.data.varianceValues);
  });

  it('should return design presets by category', async () => {
    const res = await fetch(port, '/api/design/presets?category=typography');
    assert.equal(res.status, 200);
    assert.ok(res.data.xs);
    assert.ok(res.data.display);
  });

  it('should return section component tokens', async () => {
    const res = await fetch(port, '/api/design/presets?category=components');
    assert.equal(res.status, 200);
    assert.ok(res.data.section);
    assert.ok(res.data.section.variants);
    assert.ok(res.data.section.spacing);
    assert.ok(res.data.section.animation);
  });

  it('should return design companies', async () => {
    const res = await fetch(port, '/api/design/companies');
    assert.equal(res.status, 200);
    assert.ok(res.data.apple);
    assert.ok(res.data.stripe);
  });

  it('should return generated CSS with section tokens', async () => {
    const res = await fetch(port, '/api/design/generate-css?type=all');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.sections));
    const sectionEntry = res.data.sections.find(function(s) { return s.label === 'section'; });
    assert.ok(sectionEntry, 'should include section CSS');
    assert.ok(sectionEntry.css.indexOf('--section-collapse-duration') >= 0);
  });

  it('should return section CSS specifically', async () => {
    const res = await fetch(port, '/api/design/generate-css?type=section');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.sections));
    assert.strictEqual(res.data.sections.length, 1);
    assert.strictEqual(res.data.sections[0].label, 'section');
    assert.ok(res.data.sections[0].css.indexOf('--section-') >= 0);
  });

  it('should perform contrast check', async () => {
    const res = await fetch(port, '/api/design/contrast-check?fg=%23ffffff&bg=%23000000');
    assert.equal(res.status, 200);
    assert.ok(res.data.ratio);
    assert.strictEqual(res.data.aa, true);
  });
});
