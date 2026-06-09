'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cmd-test-'));

describe('discover()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should discover command files from .harness/commands/', () => {
    const router = new CommandRouter(TEST_DIR);
    const commands = router.discover();
    assert.ok(Array.isArray(commands));
    assert.ok(commands.length >= 3);
  });

  it('should parse command frontmatter correctly', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const cmd = router.getCommand('/plan');
    assert.ok(cmd);
    assert.equal(cmd.command_id, '/plan');
    assert.equal(cmd.name, 'Plan');
  });

  it('should parse aliases', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const cmd = router.getCommand('/test');
    assert.ok(cmd.aliases);
    assert.ok(cmd.aliases.includes('t'));
  });

  it('should return empty array when commands dir does not exist', () => {
    const emptyDir = path.join(os.tmpdir(), 'harness-empty-' + Date.now());
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
      const router = new CommandRouter(emptyDir);
      const commands = router.discover();
      assert.ok(Array.isArray(commands));
      assert.equal(commands.length, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('resolve()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should resolve slash command from user input', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.resolve('/plan');
    assert.ok(result);
    assert.equal(result.command_id, '/plan');
  });

  it('should resolve command by alias', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.resolve('t');
    assert.ok(result);
    assert.equal(result.command_id, '/test');
  });

  it('should resolve command embedded in natural language', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.resolve('请帮我 /deploy 一下');
    assert.ok(result);
    assert.equal(result.command_id, '/deploy');
  });

  it('should return null for unknown command', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.resolve('/unknown-command');
    assert.equal(result, null);
  });

  it('should return null for non-command input', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.resolve('帮我实现一个功能');
    assert.equal(result, null);
  });
});

describe('getExecutionPlan()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\nskills: [brainstorming, requirement-analysis, architecture-design]\nagent: team-lead\nphase: brainstorming\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should return execution plan with skills and agent', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const plan = router.getExecutionPlan('/plan');
    assert.ok(plan);
    assert.ok(Array.isArray(plan.skills));
    assert.equal(plan.skills.length, 3);
    assert.equal(plan.agent, 'team-lead');
    assert.equal(plan.phase, 'brainstorming');
  });

  it('should return null for unknown command', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const plan = router.getExecutionPlan('/nonexistent');
    assert.equal(plan, null);
  });
});

describe('listCommands()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should list all available commands', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const list = router.listCommands();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 3);
    assert.ok(list.some(c => c.command_id === '/plan'));
  });
});

describe('getHelpText()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should generate help text for all commands', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const help = router.getHelpText(false);
    assert.ok(typeof help === 'string');
    assert.ok(help.includes('/plan'));
  });
});

describe('isCommand()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should detect slash command in input', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    assert.equal(router.isCommand('/plan'), true);
    assert.equal(router.isCommand('/deploy'), true);
    assert.equal(router.isCommand('帮我实现功能'), false);
    assert.equal(router.isCommand(''), false);
  });
});

describe('complete()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'code-review.md'), '---\ncommand_id: /code-review\nname: Code Review\n---\nCode review content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should complete partial command', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const matches = router.complete('/co');
    assert.ok(Array.isArray(matches));
    assert.ok(matches.some(m => m.command_id === '/code-review'));
  });

  it('should complete alias prefix', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const matches = router.complete('/de');
    assert.ok(Array.isArray(matches));
    assert.ok(matches.some(m => m.command_id === '/deploy'));
  });

  it('should return empty for non-slash input', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const matches = router.complete('plan');
    assert.deepEqual(matches, []);
  });
});

describe('fuzzyMatch()', () => {
  let CommandRouter;
  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\n---\nPlan command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\n---\nDeploy command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'test.md'), '---\ncommand_id: /test\nname: Test\naliases: ["t", "check"]\n---\nTest command content');
    fs.writeFileSync(path.join(TEST_DIR, '.harness', 'commands', 'code-review.md'), '---\ncommand_id: /code-review\nname: Code Review\n---\nCode review content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
  });
  after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should fuzzy match partial command', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.fuzzyMatch('/revi');
    assert.ok(result);
    assert.equal(result.command_id, '/code-review');
  });

  it('should return exact match first', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.fuzzyMatch('/plan');
    assert.ok(result);
    assert.equal(result.command_id, '/plan');
  });

  it('should return null for no match', () => {
    const router = new CommandRouter(TEST_DIR);
    router.discover();
    const result = router.fuzzyMatch('/zzzzz');
    assert.equal(result, null);
  });
});

describe('executeCommand() and causal bus integration', () => {
  let CommandRouter, CausalDataBus;
  const causalTestDir = path.join(os.tmpdir(), 'harness-cmd-causal-' + Date.now());

  before(() => {
    fs.mkdirSync(path.join(causalTestDir, '.harness', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(causalTestDir, '.harness', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(causalTestDir, '.harness', 'agents'), { recursive: true });
    const config = {
      project_name: 'test',
      version: '1.0.0',
      models: { default: 'gpt-4' },
      agents: {},
      skills: {},
      commands: {},
      hooks: {},
      logging: { level: 'info' },
    };
    fs.writeFileSync(path.join(causalTestDir, '.harness', 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(causalTestDir, '.harness', 'commands', 'plan.md'), '---\ncommand_id: /plan\nname: Plan\nskills: [brainstorming, requirement-analysis]\nphase: brainstorming\n---\nPlan content');
    fs.writeFileSync(path.join(causalTestDir, '.harness', 'commands', 'deploy.md'), '---\ncommand_id: /deploy\nname: Deploy\nskills: [deployment]\nphase: deployment\n---\nDeploy content');
    CommandRouter = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'command-router'));
    CausalDataBus = require(path.join(ROOT, 'src', 'runtime', 'causal', 'causal-data-bus'));
  });
  after(() => { try { fs.rmSync(causalTestDir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ } });

  it('should execute command and return plan', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    const plan = router.executeCommand('/plan');
    assert.ok(plan);
    assert.equal(plan.commandId, '/plan');
    assert.deepEqual(plan.skills, ['brainstorming', 'requirement-analysis']);
  });

  it('should record execution history', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    router.executeCommand('/plan');
    router.executeCommand('/deploy');
    const history = router.getExecutionHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].commandId, '/plan');
    assert.equal(history[1].commandId, '/deploy');
  });

  it('should limit execution history', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    for (let i = 0; i < 120; i++) {
      router.executeCommand('/plan');
    }
    const history = router.getExecutionHistory();
    assert.ok(history.length <= 100);
  });

  it('should return null for unknown command execution', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    const result = router.executeCommand('/nonexistent');
    assert.equal(result, null);
  });

  it('should publish to causal bus when connected', () => {
    const router = new CommandRouter(causalTestDir);
    const bus = new CausalDataBus();
    router.discover();
    router.setCausalBus(bus);
    router.executeCommand('/plan', { userRequest: 'test' });
    const chain = bus.getCausalChain();
    const cmdEntry = chain.find(e => e.skillId === 'cmd:/plan');
    assert.ok(cmdEntry);
    assert.equal(cmdEntry.data.commandId, '/plan');
    assert.equal(cmdEntry.data.phase, 'brainstorming');
    bus.shutdown();
  });

  it('should emit command-executed event', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    let emitted = null;
    router.on('command-executed', (record) => { emitted = record; });
    router.executeCommand('/deploy');
    assert.ok(emitted);
    assert.equal(emitted.commandId, '/deploy');
    assert.equal(emitted.status, 'dispatched');
  });

  it('should report causalBusConnected in stats', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    assert.equal(router.getStats().causalBusConnected, false);
    const bus = new CausalDataBus();
    router.setCausalBus(bus);
    assert.equal(router.getStats().causalBusConnected, true);
    bus.shutdown();
  });

  it('should reject invalid causal bus', () => {
    const router = new CommandRouter(causalTestDir);
    assert.throws(() => { router.setCausalBus({}); }, /publishOutput/);
  });

  it('should clear history on shutdown', () => {
    const router = new CommandRouter(causalTestDir);
    router.discover();
    router.executeCommand('/plan');
    assert.ok(router.getExecutionHistory().length > 0);
    router.shutdown();
    assert.equal(router.getExecutionHistory().length, 0);
  });

  it('should register causal interfaces on discover when bus is connected', () => {
    const bus = new CausalDataBus();
    const router = new CommandRouter(causalTestDir, { causalBus: bus });
    router.discover();
    const planIface = bus.getSkillInterface('cmd:/plan');
    assert.ok(planIface);
    assert.ok(planIface.causalOutputs.length > 0);
    const deployIface = bus.getSkillInterface('cmd:/deploy');
    assert.ok(deployIface);
    assert.ok(deployIface.causalInputs.length > 0);
    bus.shutdown();
  });

  it('should register causal interfaces when bus is set after discover', () => {
    const bus = new CausalDataBus();
    const router = new CommandRouter(causalTestDir);
    router.discover();
    router.setCausalBus(bus);
    const planIface = bus.getSkillInterface('cmd:/plan');
    assert.ok(planIface);
    bus.shutdown();
  });

  it('should compute previous phases correctly', () => {
    const router = new CommandRouter(causalTestDir);
    assert.deepEqual(router._getPreviousPhases('brainstorming'), []);
    assert.deepEqual(router._getPreviousPhases('module-development'), ['brainstorming', 'requirement-analysis', 'architecture-design']);
    assert.deepEqual(router._getPreviousPhases('deployment'), ['brainstorming', 'requirement-analysis', 'architecture-design', 'module-development', 'integration-testing']);
  });
});
