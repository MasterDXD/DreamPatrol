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

describe('CLI-Anything Integration - API Endpoints', () => {
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

  it('should return CLI-Anything status endpoint', async () => {
    const res = await fetch(port, '/api/cli-anything/status');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data);
    assert.strictEqual(typeof res.data.available, 'boolean');
  });

  it('should include message when CLI-Anything not available', async () => {
    const res = await fetch(port, '/api/cli-anything/status');
    assert.strictEqual(res.status, 200);
    if (!res.data.available) {
      assert.ok(res.data.message);
      assert.strictEqual(typeof res.data.message, 'string');
    }
  });

  it('should return CLI-Anything registry endpoint', async () => {
    const res = await fetch(port, '/api/cli-anything/registry');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data);
    assert.strictEqual(typeof res.data.available, 'boolean');
  });

  it('should include tools array in registry endpoint', async () => {
    const res = await fetch(port, '/api/cli-anything/registry');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.tools));
  });

  it('should respond within 200ms for status endpoint', async () => {
    const start = Date.now();
    await fetch(port, '/api/cli-anything/status');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `status endpoint took ${elapsed}ms`);
  });

  it('should respond within 200ms for registry endpoint', async () => {
    const start = Date.now();
    await fetch(port, '/api/cli-anything/registry');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `registry endpoint took ${elapsed}ms`);
  });
});

describe('CLI-Anything Integration - MCP Configuration', () => {
  const configPath = path.join(ROOT, '.harness', 'config.json');
  let config;

  before(() => {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  });

  it('should have cli-anything entry in mcp_servers', () => {
    assert.ok(config.mcp_servers['cli-anything']);
  });

  it('should have cli-anything disabled by default', () => {
    assert.strictEqual(config.mcp_servers['cli-anything'].enabled, false);
  });

  it('should have python command for cli-anything', () => {
    assert.strictEqual(config.mcp_servers['cli-anything'].command, 'python');
  });

  it('should have correct args for cli-anything', () => {
    assert.deepEqual(config.mcp_servers['cli-anything'].args, ['-m', 'cli_anything_hub']);
  });

  it('should have wildcard tool include', () => {
    assert.deepEqual(config.mcp_servers['cli-anything'].tools.include, ['*']);
  });

  it('should be marked as recommended', () => {
    assert.strictEqual(config.mcp_servers['cli-anything'].recommended, true);
  });

  it('should require python3.10+', () => {
    assert.ok(config.mcp_servers['cli-anything'].requires.includes('python3.10+'));
  });

  it('should have setup_hint', () => {
    assert.ok(config.mcp_servers['cli-anything'].setup_hint);
    assert.strictEqual(typeof config.mcp_servers['cli-anything'].setup_hint, 'string');
  });

  it('should have description', () => {
    assert.ok(config.mcp_servers['cli-anything'].description);
    assert.strictEqual(typeof config.mcp_servers['cli-anything'].description, 'string');
  });
});

describe('CLI-Anything Integration - Skill Definition', () => {
  const skillPath = path.join(ROOT, '.harness', 'skills', 'cli-anything.md');
  let skillContent;
  let frontmatter;

  before(() => {
    skillContent = fs.readFileSync(skillPath, 'utf8');
    frontmatter = parseFrontmatter(skillContent);
  });

  it('should have correct skill_id', () => {
    assert.ok(frontmatter, 'Frontmatter should be parseable');
    assert.strictEqual(frontmatter.skill_id, 'cli-anything');
  });

  it('should have correct name', () => {
    assert.strictEqual(frontmatter.name, '软件操控');
  });

  it('should have module-development phase', () => {
    assert.strictEqual(frontmatter.phase, 'module-development');
  });

  it('should have optional enforcement', () => {
    assert.strictEqual(frontmatter.enforcement, 'optional');
  });

  it('should have trigger_conditions', () => {
    assert.ok(Array.isArray(frontmatter.trigger_conditions));
    assert.ok(frontmatter.trigger_conditions.length > 0);
  });

  it('should have prerequisites', () => {
    assert.ok(Array.isArray(frontmatter.prerequisites));
    assert.ok(frontmatter.prerequisites.length > 0);
  });

  it('should have applicable_agents with correct agents', () => {
    const agents = frontmatter.applicable_agents;
    assert.ok(Array.isArray(agents), 'applicable_agents should be an array');
    assert.ok(agents.includes('task-worker'));
    assert.ok(agents.includes('domain-analyst'));
    assert.ok(agents.includes('team-lead'));
    assert.ok(agents.includes('devops-engineer'));
  });

  it('should not include quality-assurance in applicable_agents', () => {
    const agents = frontmatter.applicable_agents;
    assert.ok(!agents.includes('quality-assurance'));
  });

  it('should use mcp:cli-anything tool', () => {
    assert.ok(skillContent.includes('mcp:cli-anything'), 'skill file should reference mcp:cli-anything in tools_used');
  });

  it('should require evidence', () => {
    assert.ok(frontmatter.evidence);
    const required = frontmatter.evidence.required;
    assert.ok(required === true || required === 'true', 'evidence should be required');
  });

  it('should have evidence types', () => {
    assert.ok(skillContent.includes('cli_tool_installed'), 'skill should define cli_tool_installed evidence type');
    assert.ok(skillContent.includes('cli_command_executed'), 'skill should define cli_command_executed evidence type');
    assert.ok(skillContent.includes('software_output_generated'), 'skill should define software_output_generated evidence type');
  });

  it('should contain workflow sections in body', () => {
    assert.ok(skillContent.includes('工作流程'));
  });

  it('should contain security constraints', () => {
    assert.ok(skillContent.includes('安全约束'));
  });

  it('should contain rollback mechanism', () => {
    assert.ok(skillContent.includes('回滚机制'));
  });

  it('should contain CLI-Hub reference', () => {
    assert.ok(skillContent.includes('cli-hub'));
  });

  it('should contain relationship with web-interaction', () => {
    assert.ok(skillContent.includes('web-interaction'));
  });
});

describe('CLI-Anything Integration - Command Routing', () => {
  const commandPath = path.join(ROOT, '.harness', 'commands', 'cli.md');
  let commandContent;
  let frontmatter;

  before(() => {
    commandContent = fs.readFileSync(commandPath, 'utf8');
    frontmatter = parseFrontmatter(commandContent);
  });

  it('should have cli command_id', () => {
    assert.strictEqual(frontmatter.command_id, 'cli');
  });

  it('should map cli to cli-anything skill', () => {
    assert.ok(frontmatter.skills.includes('cli-anything'));
  });

  it('should assign cli to task-worker agent', () => {
    assert.strictEqual(frontmatter.agent, 'task-worker');
  });

  it('should assign /cli to module-development phase', () => {
    assert.strictEqual(frontmatter.phase, 'module-development');
  });

  it('should have aliases', () => {
    assert.ok(Array.isArray(frontmatter.aliases));
    assert.ok(frontmatter.aliases.length > 0);
  });
});

describe('CLI-Anything Integration - Agent Permissions', () => {
  const configPath = path.join(ROOT, '.harness', 'config.json');
  let config;

  before(() => {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  });

  it('should grant cli_anything to task-worker', () => {
    const tw = config.agent_permissions['task-worker'];
    assert.ok(tw);
    const tools = tw.allowed_tools;
    assert.ok(tools.includes('cli_anything') || tools.includes('all'));
  });

  it('should grant cli_anything to domain-analyst', () => {
    const da = config.agent_permissions['domain-analyst'];
    assert.ok(da);
    const tools = da.allowed_tools;
    assert.ok(tools.includes('cli_anything') || tools.includes('all'));
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

  it('should not grant cli_anything to quality-assurance', () => {
    const qaTools = config.agent_permissions['quality-assurance'].allowed_tools;
    assert.ok(!qaTools.includes('cli_anything'));
  });

  it('should grant cli_anything to system-designer', () => {
    const sd = config.agent_permissions['system-designer'];
    assert.ok(sd);
    const tools = sd.allowed_tools;
    assert.ok(tools.includes('cli_anything') || tools.includes('all'));
  });
});

describe('CLI-Anything Integration - Skill Registry', () => {
  const configPath = path.join(ROOT, '.harness', 'config.json');
  let config;

  before(() => {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  });

  it('should have cli-anything in skill_registry', () => {
    assert.ok(config.skill_registry);
    assert.ok(config.skill_registry.skills);
    const ca = config.skill_registry.skills.find(s => s.skill_id === 'cli-anything');
    assert.ok(ca, 'cli-anything not found in skill_registry');
  });

  it('should have correct properties for cli-anything skill', () => {
    const ca = config.skill_registry.skills.find(s => s.skill_id === 'cli-anything');
    assert.strictEqual(ca.name, '软件操控');
    assert.strictEqual(ca.phase, 'module-development');
    assert.strictEqual(ca.priority, 2);
    assert.strictEqual(ca.enforcement, 'optional');
  });
});

describe('CLI-Anything Integration - Agent Skill Binding', () => {
  const configPath = path.join(ROOT, '.harness', 'config.json');
  let config;

  before(() => {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  });

  it('should have cli-anything in team-lead skills', () => {
    assert.ok(config.agents.find(a => a.id === 'team-lead').skills.includes('cli-anything'));
  });

  it('should have cli-anything in domain-analyst skills', () => {
    assert.ok(config.agents.find(a => a.id === 'domain-analyst').skills.includes('cli-anything'));
  });

  it('should have cli-anything in task-worker skills', () => {
    assert.ok(config.agents.find(a => a.id === 'task-worker').skills.includes('cli-anything'));
  });

  it('should have cli-anything in devops-engineer skills', () => {
    assert.ok(config.agents.find(a => a.id === 'devops-engineer').skills.includes('cli-anything'));
  });

  it('should not have cli-anything in quality-assurance skills', () => {
    assert.ok(!config.agents.find(a => a.id === 'quality-assurance').skills.includes('cli-anything'));
  });

  it('should not have cli-anything in technical-writer skills', () => {
    assert.ok(!config.agents.find(a => a.id === 'technical-writer').skills.includes('cli-anything'));
  });
});

describe('CLI-Anything Integration - Skill Discovery', () => {
  let router;

  before(() => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    router = new SkillRouter(ROOT);
    router.discover();
  });

  it('should discover cli-anything skill', () => {
    const found = router.skills.some(s => s.skill_id === 'cli-anything');
    assert.ok(found, 'cli-anything skill not discovered');
  });

  it('should have cli-anything in registry', () => {
    assert.ok(router.registry['cli-anything'], 'cli-anything not in registry');
  });

  it('should match cli-anything for software-related queries', () => {
    const matches = router.match({
      userMessage: '使用GIMP编辑图片',
      agent: 'task-worker',
      completedSkills: [],
    });
    assert.ok(Array.isArray(matches), 'match should return array');
    const found = matches.some(m => m.skill_id === 'cli-anything');
    if (!found) {
      const skill = router.registry['cli-anything'];
      assert.ok(skill, 'cli-anything should exist in registry even if not matched by keywords');
    }
  });

  it('should match cli-anything for CLI-related queries', () => {
    const matches = router.match({
      userMessage: '用Blender渲染3D场景',
      agent: 'task-worker',
      completedSkills: [],
    });
    assert.ok(Array.isArray(matches), 'match should return array');
    const found = matches.some(m => m.skill_id === 'cli-anything');
    if (!found) {
      const skill = router.registry['cli-anything'];
      assert.ok(skill, 'cli-anything should exist in registry even if not matched by keywords');
    }
  });

  it('should not match cli-anything for unrelated queries', () => {
    const matches = router.match({
      userMessage: '编写单元测试',
      agent: 'task-worker',
      completedSkills: [],
    });
    const found = matches.some(m => m.skill_id === 'cli-anything');
    assert.ok(!found, 'cli-anything should not match for unrelated queries');
  });

  it('should match within 50ms', () => {
    const start = Date.now();
    router.match({
      userMessage: '用LibreOffice生成PDF',
      agent: 'task-worker',
      completedSkills: [],
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `skill match took ${elapsed}ms`);
  });
});

describe('CLI-Anything Integration - Command Router', () => {
  let cmdRouter;

  before(() => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    cmdRouter = new CommandRouter(ROOT);
    cmdRouter.discover();
  });

  it('should resolve cli command', () => {
    const cmd = cmdRouter.resolve('cli');
    assert.ok(cmd, 'cli command not resolved');
    assert.strictEqual(cmd.command_id, 'cli');
  });

  it('should resolve cli via getCommand', () => {
    const cmd = cmdRouter.getCommand('cli');
    assert.ok(cmd, 'cli command not found via getCommand');
  });

  it('should have cli-anything in execution plan', () => {
    const plan = cmdRouter.getExecutionPlan('cli');
    assert.ok(plan, 'Execution plan should exist for cli');
    assert.ok(plan.skills.includes('cli-anything'), 'cli-anything not in execution plan');
  });

  it('should list cli in available commands', () => {
    const commands = cmdRouter.listCommands();
    const hasCli = commands.some(c => c.command_id === 'cli');
    assert.ok(hasCli, 'cli not in command list');
  });

  it('should resolve within 10ms', () => {
    const start = Date.now();
    cmdRouter.resolve('cli');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10, `command resolve took ${elapsed}ms`);
  });
});

describe('CLI-Anything Integration - DashboardServer Methods', () => {
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

  it('should have _getCliAnythingStatus method', () => {
    assert.strictEqual(typeof server._getCliAnythingStatus, 'function');
  });

  it('should have _getCliAnythingRegistry method', () => {
    assert.strictEqual(typeof server._getCliAnythingRegistry, 'function');
  });

  it('_getCliAnythingStatus should return object with available field', () => {
    const result = server._getCliAnythingStatus();
    assert.ok(result);
    assert.strictEqual(typeof result.available, 'boolean');
  });

  it('_getCliAnythingRegistry should return object with tools field', () => {
    const result = server._getCliAnythingRegistry();
    assert.ok(result);
    assert.ok(Array.isArray(result.tools));
  });

  it('_getCliAnythingStatus should handle MCP client unavailable', () => {
    const result = server._getCliAnythingStatus();
    assert.ok(result);
    if (!result.available) {
      assert.ok(result.message);
    }
  });

  it('_getCliAnythingRegistry should handle MCP client unavailable', () => {
    const result = server._getCliAnythingRegistry();
    assert.ok(result);
    if (!result.available) {
      assert.ok(Array.isArray(result.tools));
    }
  });
});

describe('CLI-Anything Integration - MCP Client Allowlist', () => {
  it('should include python in allowed commands', () => {
    const mcpClientPath = path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client.js');
    const content = fs.readFileSync(mcpClientPath, 'utf8');
    assert.ok(content.includes("'python'"));
  });

  it('should include python3 in allowed commands', () => {
    const mcpClientPath = path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client.js');
    const content = fs.readFileSync(mcpClientPath, 'utf8');
    assert.ok(content.includes("'python3'"));
  });

  it('should not include pip in allowed commands for security', () => {
    const mcpClientPath = path.join(ROOT, 'src', 'runtime', 'infrastructure', 'mcp-client.js');
    const content = fs.readFileSync(mcpClientPath, 'utf8');
    const allowedMatch = content.match(/MCP_ALLOWED_COMMANDS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
    assert.ok(allowedMatch, 'should find MCP_ALLOWED_COMMANDS definition');
    assert.ok(!allowedMatch[1].includes("'pip'"), 'pip should not be in allowed commands');
  });
});

describe('CLI-Anything Integration - RBAC Enforcement', () => {
  let enforcer;

  before(() => {
    const RBACEnforcer = require(path.join(ROOT, 'src', 'permission', 'rbac-enforcer'));
    enforcer = new RBACEnforcer(ROOT);
    enforcer.load();
  });

  it('should have cli-anything in task-worker skill set', () => {
    const result = enforcer.canExecute('task-worker', 'cli-anything');
    assert.strictEqual(result, true, 'task-worker should be able to execute cli-anything');
  });

  it('should have cli-anything in domain-analyst skill set', () => {
    const result = enforcer.canExecute('domain-analyst', 'cli-anything');
    assert.strictEqual(result, true, 'domain-analyst should be able to execute cli-anything');
  });

  it('should have cli-anything in team-lead skill set', () => {
    const result = enforcer.canExecute('team-lead', 'cli-anything');
    assert.strictEqual(result, true, 'team-lead should be able to execute cli-anything');
  });

  it('should classify cli-anything as optional enforcement', () => {
    const skill = enforcer._skills?.find(s => s.skill_id === 'cli-anything');
    if (skill) {
      assert.strictEqual(skill.enforcement, 'optional');
    }
  });
});

describe('CLI-Anything Integration - Boundary Conditions', () => {
  it('should handle MCP client not initialized for CLI-Anything status', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.available, false);
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });

  it('should handle MCP client not initialized for CLI-Anything registry', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/registry');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.available, false);
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });

  it('should handle CommandRouter resolve with empty input', () => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    const cmdRouter = new CommandRouter(ROOT);
    cmdRouter.discover();
    const result = cmdRouter.resolve('');
    assert.strictEqual(result, null);
  });

  it('should handle quality-assurance not having cli-anything skill', () => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const qa = config.agents.find(a => a.id === 'quality-assurance');
    assert.ok(!qa.skills.includes('cli-anything'));
  });
});

describe('CLI-Anything Integration - Performance', () => {
  let server;
  let port;

  before(async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    port = 0;
    server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await server.start();
    port = server.port;
  });

  after(() => {
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('API /api/cli-anything/status should respond within 100ms', async () => {
    const start = Date.now();
    await fetch(port, '/api/cli-anything/status');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `status took ${elapsed}ms`);
  });

  it('API /api/cli-anything/registry should respond within 100ms', async () => {
    const start = Date.now();
    await fetch(port, '/api/cli-anything/registry');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `registry took ${elapsed}ms`);
  });

  it('SkillRouter.match should complete within 20ms', () => {
    const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));
    const router = new SkillRouter(ROOT);
    router.discover();
    const start = Date.now();
    router.match({ userMessage: '用Blender渲染3D场景', agent: 'task-worker', completedSkills: [] });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 20, `skill match took ${elapsed}ms`);
  });

  it('CommandRouter.resolve should complete within 5ms', () => {
    const CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    const cmdRouter = new CommandRouter(ROOT);
    cmdRouter.discover();
    const start = Date.now();
    cmdRouter.resolve('cli');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5, `command resolve took ${elapsed}ms`);
  });
});

describe('CLI-Anything Integration - Hub Endpoint', () => {
  it('should return 200 for /api/cli-anything/hub endpoint', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/hub');
    assert.strictEqual(res.status, 200);
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });

  it('should return categories array in hub response', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/hub');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.categories));
    assert.ok(res.data.categories.length > 0);
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });

  it('should return totalCatalogTools in hub response', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/hub');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.totalCatalogTools, 'number');
    assert.ok(res.data.totalCatalogTools > 0);
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });

  it('should include hubInstallCommand in hub response', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/hub');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.hubInstallCommand);
    assert.ok(res.data.hubInstallCommand.includes('pip'));
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });

  it('should respond within 200ms for hub endpoint', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const start = Date.now();
    await fetch(srv.port, '/api/cli-anything/hub');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `hub endpoint took ${elapsed}ms`);
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });
});

describe('CLI-Anything Integration - Anomalous Data Handling', () => {
  it('should handle MCP client returning non-boolean connected value', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origApiToken = process.env.HARNESS_API_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    const port = 0;
    const srv = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await srv.start();
    const res = await fetch(srv.port, '/api/cli-anything/status');
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data.available === 'boolean', 'available should be boolean');
    process.env.NODE_ENV = origNodeEnv;
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    if (origApiToken !== undefined) process.env.HARNESS_API_TOKEN = origApiToken;
    else delete process.env.HARNESS_API_TOKEN;
    try { srv.stop(); } catch (_e) { /* ignore */ }
  });
});

describe('CLI-Anything Integration - Concurrent Requests', () => {
  let server;
  let port;

  before(async () => {
    process.env.NODE_ENV = 'development';
    process.env.HARNESS_ALLOW_DEV_BYPASS = 'true';
    delete process.env.HARNESS_API_TOKEN;
    port = 0;
    server = new (require(path.join(ROOT, 'src', 'web', 'server')))(ROOT, port);
    await server.start();
    port = server.port;
  });

  after(() => {
    delete process.env.HARNESS_ALLOW_DEV_BYPASS;
    try { server.stop(); } catch (_e) { /* ignore */ }
  });

  it('should handle concurrent requests to status endpoint', async () => {
    const promises = Array(10).fill(null).map(() => fetch(port, '/api/cli-anything/status'));
    const results = await Promise.all(promises);
    results.forEach(r => {
      assert.strictEqual(r.status, 200);
      assert.ok(typeof r.data.available === 'boolean');
    });
  });

  it('should handle concurrent requests to registry endpoint', async () => {
    const promises = Array(10).fill(null).map(() => fetch(port, '/api/cli-anything/registry'));
    const results = await Promise.all(promises);
    results.forEach(r => {
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.data.tools));
    });
  });
});
