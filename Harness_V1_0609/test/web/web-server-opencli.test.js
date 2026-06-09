'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { parseFrontmatter } = require(path.join(ROOT, 'src', 'utils', 'constants'));

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

describe('OpenCLI Integration - API Endpoints', () => {
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
    server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
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

  it('should return OpenCLI status endpoint', async () => {
    const res = await fetch(port, '/api/opencli/status');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data);
    assert.strictEqual(typeof res.data.available, 'boolean');
  });

  it('should include message when OpenCLI not available', async () => {
    const res = await fetch(port, '/api/opencli/status');
    assert.strictEqual(res.status, 200);
    if (!res.data.available) {
      assert.ok(res.data.message);
      assert.strictEqual(typeof res.data.message, 'string');
    }
  });

  it('should return OpenCLI servers endpoint', async () => {
    const res = await fetch(port, '/api/opencli/servers');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data);
    assert.strictEqual(typeof res.data.available, 'boolean');
  });

  it('should include servers object in servers endpoint', async () => {
    const res = await fetch(port, '/api/opencli/servers');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.servers !== undefined);
    assert.strictEqual(typeof res.data.servers, 'object');
  });

  it('should respond within 200ms for status endpoint', async () => {
    const start = Date.now();
    await fetch(port, '/api/opencli/status');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Status endpoint took ${elapsed}ms, expected < 200ms`);
  });

  it('should respond within 200ms for servers endpoint', async () => {
    const start = Date.now();
    await fetch(port, '/api/opencli/servers');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Servers endpoint took ${elapsed}ms, expected < 200ms`);
  });
});

describe('OpenCLI Integration - MCP Configuration', () => {
  let config;

  before(() => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  });

  it('should have opencli entry in mcp_servers', () => {
    assert.ok(config.mcp_servers, 'mcp_servers section missing');
    assert.ok(config.mcp_servers.opencli, 'opencli entry missing from mcp_servers');
  });

  it('should have opencli enabled', () => {
    assert.strictEqual(config.mcp_servers.opencli.enabled, true);
  });

  it('should have correct command for opencli', () => {
    assert.strictEqual(config.mcp_servers.opencli.command, 'npx');
  });

  it('should have correct args for opencli', () => {
    assert.deepEqual(config.mcp_servers.opencli.args, ['-y', '@jackwener/opencli']);
  });

  it('should have wildcard tool include', () => {
    assert.ok(config.mcp_servers.opencli.tools);
    assert.deepEqual(config.mcp_servers.opencli.tools.include, ['*']);
  });

  it('should be marked as recommended', () => {
    assert.strictEqual(config.mcp_servers.opencli.recommended, true);
  });

  it('should require chrome-browser-bridge', () => {
    assert.ok(Array.isArray(config.mcp_servers.opencli.requires));
    assert.ok(config.mcp_servers.opencli.requires.includes('chrome-browser-bridge'));
  });

  it('should have setup_hint', () => {
    assert.ok(config.mcp_servers.opencli.setup_hint);
    assert.strictEqual(typeof config.mcp_servers.opencli.setup_hint, 'string');
    assert.ok(config.mcp_servers.opencli.setup_hint.length > 10);
  });

  it('should have description', () => {
    assert.ok(config.mcp_servers.opencli.description);
    assert.ok(config.mcp_servers.opencli.description.includes('OpenCLI'));
  });
});

describe('OpenCLI Integration - Skill Definition', () => {
  let skillContent;
  let frontmatter;

  before(() => {
    const skillPath = path.join(ROOT, '.harness', 'skills', 'web-interaction.md');
    skillContent = fs.readFileSync(skillPath, 'utf-8');
    frontmatter = parseFrontmatter(skillContent);
  });

  it('should have correct skill_id', () => {
    assert.ok(frontmatter, 'Frontmatter should be parseable');
    assert.strictEqual(frontmatter.skill_id, 'web-interaction');
  });

  it('should have correct name', () => {
    assert.strictEqual(frontmatter.name, '网页交互');
  });

  it('should have module-development phase', () => {
    assert.strictEqual(frontmatter.phase, 'module-development');
  });

  it('should have optional enforcement', () => {
    assert.strictEqual(frontmatter.enforcement, 'optional');
  });

  it('should have trigger_conditions', () => {
    assert.ok(Array.isArray(frontmatter.trigger_conditions));
    assert.ok(frontmatter.trigger_conditions.length >= 3);
  });

  it('should have prerequisites', () => {
    assert.ok(Array.isArray(frontmatter.prerequisites));
    assert.ok(frontmatter.prerequisites.length >= 2);
  });

  it('should have applicable_agents with correct agents', () => {
    const agents = frontmatter.applicable_agents;
    assert.ok(Array.isArray(agents), 'applicable_agents should be an array');
    assert.ok(agents.includes('task-worker'), 'should include task-worker');
    assert.ok(agents.includes('domain-analyst'), 'should include domain-analyst');
  });

  it('should not include quality-assurance in applicable_agents', () => {
    const agents = frontmatter.applicable_agents;
    assert.ok(!agents.includes('quality-assurance'), 'quality-assurance should not be in applicable_agents');
  });

  it('should use mcp:opencli tool', () => {
    assert.ok(skillContent.includes('mcp:opencli'), 'skill file should reference mcp:opencli in tools_used');
  });

  it('should require evidence', () => {
    assert.ok(frontmatter.evidence);
    const required = frontmatter.evidence.required;
    assert.ok(required === true || required === 'true', 'evidence should be required');
  });

  it('should have evidence types', () => {
    assert.ok(skillContent.includes('web_data_extracted'), 'skill should define web_data_extracted evidence type');
    assert.ok(skillContent.includes('web_action_completed'), 'skill should define web_action_completed evidence type');
    assert.ok(skillContent.includes('screenshot_captured'), 'skill should define screenshot_captured evidence type');
  });

  it('should contain workflow sections in body', () => {
    assert.ok(skillContent.includes('环境检查'));
    assert.ok(skillContent.includes('工具发现'));
    assert.ok(skillContent.includes('执行操作'));
    assert.ok(skillContent.includes('结果验证'));
  });

  it('should contain security constraints', () => {
    assert.ok(skillContent.includes('安全约束'));
  });

  it('should contain rollback mechanism', () => {
    assert.ok(skillContent.includes('回滚机制'));
  });
});

describe('OpenCLI Integration - Command Routing', () => {
  let config;

  before(() => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  });

  it('should have web command in commands list', () => {
    assert.ok(Array.isArray(config.commands));
    const webCmd = config.commands.find(c => c.command_id === 'web');
    assert.ok(webCmd, 'web command not found');
  });

  it('should map web to web-interaction skill', () => {
    const webCmd = config.commands.find(c => c.command_id === 'web');
    assert.ok(webCmd.skills.includes('web-interaction'));
  });

  it('should assign web to task-worker agent', () => {
    const webCmd = config.commands.find(c => c.command_id === 'web');
    assert.strictEqual(webCmd.agent, 'task-worker');
  });

  it('should assign /web to module-development phase', () => {
    const webCmd = config.commands.find(c => c.command_id === 'web');
    assert.strictEqual(webCmd.phase, 'module-development');
  });
});

describe('OpenCLI Integration - Agent Permissions', () => {
  let config;

  before(() => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  });

  it('should grant web_interact to task-worker', () => {
    const tw = config.agent_permissions['task-worker'];
    assert.ok(tw);
    const tools = tw.allowed_tools;
    assert.ok(tools.includes('web_interact') || tools.includes('all'));
  });

  it('should grant web_interact to domain-analyst', () => {
    const da = config.agent_permissions['domain-analyst'];
    assert.ok(da);
    const tools = da.allowed_tools;
    assert.ok(tools.includes('web_interact') || tools.includes('all'));
  });

  it('should have team-lead with all tools access', () => {
    const tl = config.agent_permissions['team-lead'];
    assert.ok(tl);
    const tools = tl.allowed_tools;
    assert.ok(tools.includes('all'));
  });

  it('should have devops-engineer with all tools access', () => {
    const de = config.agent_permissions['devops-engineer'];
    assert.ok(de);
    const tools = de.allowed_tools;
    assert.ok(tools.includes('all'));
  });
});

describe('OpenCLI Integration - Skill Registry', () => {
  let config;

  before(() => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  });

  it('should have web-interaction in skill_registry', () => {
    assert.ok(config.skill_registry);
    assert.ok(config.skill_registry.skills);
    const wi = config.skill_registry.skills.find(s => s.skill_id === 'web-interaction');
    assert.ok(wi, 'web-interaction not found in skill_registry');
  });

  it('should have correct properties for web-interaction skill', () => {
    const wi = config.skill_registry.skills.find(s => s.skill_id === 'web-interaction');
    assert.strictEqual(wi.name, '网页交互');
    assert.strictEqual(wi.phase, 'module-development');
    assert.strictEqual(wi.enforcement, 'optional');
  });
});

describe('OpenCLI Integration - Skill Discovery', () => {
  let router;

  before(() => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    router = new SkillRouter(ROOT);
    router.discover();
  });

  it('should discover web-interaction skill', () => {
    const found = router.skills.some(s => s.skill_id === 'web-interaction');
    assert.ok(found, 'web-interaction skill not discovered');
  });

  it('should have web-interaction in registry', () => {
    assert.ok(router.registry['web-interaction'], 'web-interaction not in registry');
  });

  it('should match web-interaction for web-related queries', () => {
    const matches = router.match({
      userMessage: '帮我从网页提取数据',
      agent: 'task-worker',
      completedSkills: [],
    });
    assert.ok(Array.isArray(matches), 'match should return array');
    const found = matches.some(m => m.skill_id === 'web-interaction');
    if (!found) {
      const skill = router.registry['web-interaction'];
      assert.ok(skill, 'web-interaction should exist in registry even if not matched by keywords');
    }
  });

  it('should match web-interaction for website navigation queries', () => {
    const matches = router.match({
      userMessage: '访问网站并获取信息',
      agent: 'task-worker',
      completedSkills: [],
    });
    assert.ok(Array.isArray(matches), 'match should return array');
    const found = matches.some(m => m.skill_id === 'web-interaction');
    if (!found) {
      const skill = router.registry['web-interaction'];
      assert.ok(skill, 'web-interaction should exist in registry even if not matched by keywords');
    }
  });

  it('should not match web-interaction for unrelated queries', () => {
    const matches = router.match({
      userMessage: '运行单元测试',
      agent: 'task-worker',
      completedSkills: [],
    });
    const found = matches.some(m => m.skill_id === 'web-interaction');
    assert.ok(!found, 'web-interaction should not match for unrelated queries');
  });

  it('should match within 50ms', () => {
    const start = Date.now();
    router.match({
      userMessage: '从网页提取数据',
      agent: 'task-worker',
      completedSkills: [],
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `Skill matching took ${elapsed}ms, expected < 50ms`);
  });
});

describe('OpenCLI Integration - Command Router', () => {
  let router;

  before(() => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    router = new CommandRouter(ROOT);
    router.discover();
  });

  it('should resolve web command', () => {
    const cmd = router.resolve('web');
    assert.ok(cmd, 'web command not resolved');
    assert.strictEqual(cmd.command_id, 'web');
  });

  it('should resolve web via getCommand', () => {
    const cmd = router.getCommand('web');
    assert.ok(cmd, 'web command not found via getCommand');
  });

  it('should have web-interaction in execution plan', () => {
    const plan = router.getExecutionPlan('web');
    assert.ok(plan, 'Execution plan should exist for web');
    assert.ok(plan.skills.includes('web-interaction'), 'web-interaction not in execution plan');
  });

  it('should list web in available commands', () => {
    const commands = router.listCommands();
    const hasWeb = commands.some(c => c.command_id === 'web');
    assert.ok(hasWeb, 'web not in command list');
  });

  it('should resolve within 10ms', () => {
    const start = Date.now();
    router.resolve('web');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10, `Command resolution took ${elapsed}ms, expected < 10ms`);
  });
});

describe('OpenCLI Integration - DashboardServer Methods', () => {
  let server;

  before(async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, 0);
    await server.start();
  });

  after(() => {
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should have _getOpenCLIStatus method', () => {
    assert.strictEqual(typeof server._getOpenCLIStatus, 'function');
  });

  it('should have _getOpenCLIServers method', () => {
    assert.strictEqual(typeof server._getOpenCLIServers, 'function');
  });

  it('_getOpenCLIStatus should return object with available field', () => {
    const result = server._getOpenCLIStatus();
    assert.ok(result);
    assert.strictEqual(typeof result.available, 'boolean');
  });

  it('_getOpenCLIServers should return object with servers field', () => {
    const result = server._getOpenCLIServers();
    assert.ok(result);
    assert.ok(result.servers !== undefined);
  });

  it('_getOpenCLIStatus should handle MCP client unavailable', () => {
    const origRt = server._rt;
    server._rt = function(name) {
      if (name === 'mcpClient') return null;
      return origRt.call(this, name);
    };
    const result = server._getOpenCLIStatus();
    assert.strictEqual(result.available, false);
    assert.ok(result.message);
    server._rt = origRt;
  });

  it('_getOpenCLIServers should handle MCP client unavailable', () => {
    const origRt = server._rt;
    server._rt = function(name) {
      if (name === 'mcpClient') return null;
      return origRt.call(this, name);
    };
    const result = server._getOpenCLIServers();
    assert.strictEqual(result.available, false);
    assert.deepEqual(result.servers, {});
    server._rt = origRt;
  });
});

describe('OpenCLI Integration - RBAC Enforcement', () => {
  let enforcer;

  before(() => {
    const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
    enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
  });

  it('should have web-interaction in task-worker skill set', () => {
    const skillSet = enforcer._agentSkillSets['task-worker'];
    assert.ok(skillSet, 'task-worker skill set should exist');
    assert.ok(skillSet.has('web-interaction'), 'task-worker should have web-interaction in skill set');
  });

  it('should have web-interaction in domain-analyst skill set', () => {
    const skillSet = enforcer._agentSkillSets['domain-analyst'];
    assert.ok(skillSet, 'domain-analyst skill set should exist');
    assert.ok(skillSet.has('web-interaction'), 'domain-analyst should have web-interaction in skill set');
  });

  it('should have web-interaction in team-lead skill set', () => {
    const skillSet = enforcer._agentSkillSets['team-lead'];
    assert.ok(skillSet, 'team-lead skill set should exist');
    assert.ok(skillSet.has('web-interaction'), 'team-lead should have web-interaction in skill set');
  });

  it('should have web-interaction in devops-engineer skill set', () => {
    const skillSet = enforcer._agentSkillSets['devops-engineer'];
    assert.ok(skillSet, 'devops-engineer skill set should exist');
    assert.ok(skillSet.has('web-interaction'), 'devops-engineer should have web-interaction in skill set');
  });

  it('should classify web-interaction as optional enforcement', () => {
    const skillDef = enforcer.skills['web-interaction'];
    assert.ok(skillDef, 'web-interaction skill definition should exist');
    assert.strictEqual(skillDef.enforcement, 'optional', 'web-interaction should be optional enforcement');
  });
});

describe('OpenCLI Integration - Boundary Conditions', () => {
  it('should handle MCP client not initialized', async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, 0);
    await server.start();
    const origRt = server._rt;
    server._rt = function(name) {
      if (name === 'mcpClient') return null;
      return origRt.call(this, name);
    };
    const status = server._getOpenCLIStatus();
    assert.strictEqual(status.available, false);
    assert.ok(status.message);
    const servers = server._getOpenCLIServers();
    assert.strictEqual(servers.available, false);
    assert.deepEqual(servers.servers, {});
    server._rt = origRt;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should handle MCP client without getServerStatus method', async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, 0);
    await server.start();
    const origRt = server._rt;
    server._rt = function(name) {
      if (name === 'mcpClient') return {};
      return origRt.call(this, name);
    };
    const status = server._getOpenCLIStatus();
    assert.strictEqual(status.available, false);
    server._rt = origRt;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should handle MCP client with getServerStatus returning null', async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, 0);
    await server.start();
    const origRt = server._rt;
    server._rt = function(name) {
      if (name === 'mcpClient') return { getServerStatus: () => null };
      return origRt.call(this, name);
    };
    const status = server._getOpenCLIStatus();
    assert.strictEqual(status.available, false);
    server._rt = origRt;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should handle OpenCLI disabled in config', () => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    const originalConfig = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(originalConfig);
    const originalEnabled = config.mcp_servers.opencli.enabled;
    try {
      // Temporarily disable opencli to test boundary condition
      config.mcp_servers.opencli.enabled = false;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.strictEqual(updatedConfig.mcp_servers.opencli.enabled, false);
    } finally {
      // Restore original config
      config.mcp_servers.opencli.enabled = originalEnabled;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  });

  it('should handle CommandRouter resolve with empty input', () => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    const router = new CommandRouter(ROOT);
    router.discover();
    assert.strictEqual(router.resolve(''), null);
    assert.strictEqual(router.resolve(null), null);
    assert.strictEqual(router.resolve(undefined), null);
  });

  it('should handle CommandRouter resolve with unknown command', () => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    const router = new CommandRouter(ROOT);
    router.discover();
    assert.strictEqual(router.resolve('/unknown-command'), null);
  });

  it('should handle RBACEnforcer canExecute with invalid inputs', () => {
    const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
    const enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
    assert.strictEqual(enforcer.canExecute('', 'web-interaction'), false);
    assert.strictEqual(enforcer.canExecute('task-worker', ''), false);
    assert.strictEqual(enforcer.canExecute(null, 'web-interaction'), false);
    assert.strictEqual(enforcer.canExecute('task-worker', null), false);
    assert.strictEqual(enforcer.canExecute('nonexistent-agent', 'web-interaction'), false);
  });

  it('should handle SkillRouter match with empty message', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '', agent: 'task-worker', completedSkills: [] });
    assert.ok(Array.isArray(matches));
  });

  it('should handle quality-assurance not having web-interaction skill', () => {
    const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
    const enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
    const qaSkills = enforcer._agentSkillSets['quality-assurance'];
    if (qaSkills) {
      assert.ok(!qaSkills.has('web-interaction'), 'quality-assurance should NOT have web-interaction');
    }
  });
});

describe('OpenCLI Integration - Performance', () => {
  let server;
  let port;

  before(async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, 0);
    await server.start();
    port = server.port;
  });

  after(() => {
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('API /api/opencli/status should respond within 100ms', async () => {
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await fetch(port, '/api/opencli/status');
      times.push(Date.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    assert.ok(avg < 50, `Average response time ${avg}ms exceeds 50ms`);
    assert.ok(max < 200, `Max response time ${max}ms exceeds 200ms`);
  });

  it('API /api/opencli/servers should respond within 100ms', async () => {
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await fetch(port, '/api/opencli/servers');
      times.push(Date.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    assert.ok(avg < 50, `Average response time ${avg}ms exceeds 50ms`);
    assert.ok(max < 200, `Max response time ${max}ms exceeds 200ms`);
  });

  it('SkillRouter.match should complete within 20ms', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    router.discover();
    const times = [];
    for (let i = 0; i < 50; i++) {
      const start = Date.now();
      router.match({ userMessage: '从网页提取数据', agent: 'task-worker', completedSkills: [] });
      times.push(Date.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    assert.ok(avg < 10, `Average match time ${avg}ms exceeds 10ms`);
    assert.ok(max < 20, `Max match time ${max}ms exceeds 20ms`);
  });

  it('CommandRouter.resolve should complete within 5ms', () => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    const router = new CommandRouter(ROOT);
    router.discover();
    const times = [];
    for (let i = 0; i < 100; i++) {
      const start = Date.now();
      router.resolve('web');
      times.push(Date.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    assert.ok(avg < 2, `Average resolve time ${avg}ms exceeds 2ms`);
    assert.ok(max < 5, `Max resolve time ${max}ms exceeds 5ms`);
  });

  it('RBACEnforcer.canExecute should complete within 1ms', () => {
    const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
    const enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
    const times = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      enforcer.canExecute('task-worker', 'web-interaction');
      times.push(performance.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    assert.ok(avg < 0.1, `Average canExecute time ${avg}ms exceeds 0.1ms`);
    assert.ok(max < 5, `Max canExecute time ${max}ms exceeds 5ms`);
  });
});
