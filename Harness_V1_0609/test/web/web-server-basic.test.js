'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

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

function fetchRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, data }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

describe('DashboardServer - Basic', () => {
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
    const cpDir = path.join(ROOT, '.harness', 'checkpoints');
    try {
      for (const f of fs.readdirSync(cpDir)) {
        if (f !== '.gitkeep') {
          try { fs.unlinkSync(path.join(cpDir, f)); } catch (_) { void _; }
        }
      }
    } catch (_) { void _; }
  });

  it('should serve index.html at /', async () => {
    const res = await fetchRaw(port, '/');
    assert.equal(res.status, 200);
    assert.ok(res.data.includes('多Agent框架控制台'));
    assert.ok(res.headers['content-type'].includes('text/html'));
  });

  it('should return 404 for unknown static files', async () => {
    const res = await fetchRaw(port, '/nonexistent.css');
    assert.equal(res.status, 404);
  });

  it('should return 404 for unknown API endpoints', async () => {
    const res = await fetch(port, '/api/unknown');
    assert.equal(res.status, 404);
  });

  it('should return overview data', async () => {
    const res = await fetch(port, '/api/overview');
    assert.equal(res.status, 200);
    assert.ok(res.data.version);
    assert.equal(typeof res.data.agentCount, 'number');
    assert.equal(typeof res.data.skillCount, 'number');
  });

  it('should return agents data', async () => {
    const res = await fetch(port, '/api/agents');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length > 0);
    assert.ok(res.data[0].id);
    assert.ok(res.data[0].role);
  });

  it('should return skills data', async () => {
    const res = await fetch(port, '/api/skills');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length > 0);
    assert.ok(res.data[0].id);
    assert.ok(res.data[0].enforcement);
  });

  it('should return sessions data', async () => {
    const res = await fetch(port, '/api/sessions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
  });

  it('should return workflow data', async () => {
    const res = await fetch(port, '/api/workflow');
    assert.equal(res.status, 200);
    assert.ok(res.data.phases);
    assert.equal(res.data.phases.length, 6);
  });

  it('should return config data', async () => {
    const res = await fetch(port, '/api/config');
    assert.equal(res.status, 200);
    assert.ok(res.data.version);
    assert.ok(res.data.token_budget);
  });

  it('should return changelog data', async () => {
    const res = await fetch(port, '/api/changelog');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    if (res.data.length > 0) {
      assert.ok(res.data[0].version);
      assert.ok(res.data[0].meta);
      assert.ok(res.data[0].sections);
    }
  });

  it('should return audit data', async () => {
    const res = await fetch(port, '/api/audit');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
  });

  it('should return memory data', async () => {
    const res = await fetch(port, '/api/memory');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return checkpoints data', async () => {
    const res = await fetch(port, '/api/checkpoints');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return learnings data', async () => {
    const res = await fetch(port, '/api/learnings');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return workflow-templates data', async () => {
    const res = await fetch(port, '/api/workflow-templates');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return changelog search results', async () => {
    const res = await fetch(port, '/api/changelog/search');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return changelog archive data', async () => {
    const res = await fetch(port, '/api/changelog/archive');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return changelog stats', async () => {
    const res = await fetch(port, '/api/changelog/stats');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return changelog verify result', async () => {
    const res = await fetch(port, '/api/changelog/verify');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return compliance data', async () => {
    const res = await fetch(port, '/api/compliance');
    assert.equal(res.status, 200);
    assert.ok(res.data);
    assert.ok('compliant' in res.data);
  });

  it('should return deviations data', async () => {
    const res = await fetch(port, '/api/deviations');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should return code-reviews data', async () => {
    const res = await fetch(port, '/api/code-reviews');
    assert.equal(res.status, 200);
    assert.ok(res.data);
  });

  it('should handle missing project root gracefully', async () => {
    const tmpServer = new DashboardServer(path.join(os.tmpdir(), 'no-harness-' + Date.now()), 0);
    await tmpServer.start();
    const tmpPort = tmpServer.port;
    try {
      const res = await fetch(tmpPort, '/api/overview');
      assert.equal(res.status, 200);
      assert.equal(res.data.agentCount, 0);
    } finally {
      tmpServer.stop();
    }
  });

  it('should block path traversal in static files', async () => {
    const res = await fetchRaw(port, '/../../package.json');
    assert.ok(res.status === 403 || res.status === 404);
  });
});
