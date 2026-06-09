'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SkillRouter = require('../src/runtime/skill/skill-router');
const SessionManager = require('../src/runtime/session/session-manager');
const PhaseOrchestrator = require('../src/runtime/workflow/phase-orchestrator');
const RBACEnforcer = require('../src/permission/rbac-enforcer');
const PermissionGuard = require('../src/permission/permission-guard');
const AuditLogger = require('../src/permission/audit-logger');
const TDDGate = require('../src/gate/tdd-gate');
const EvidenceVerifier = require('../src/gate/evidence-verifier');
const EventBus = require('../src/runtime/infrastructure/event-bus');
const PluginManager = require('../src/runtime/infrastructure/plugin-manager');
const HealthChecker = require('../src/runtime/infrastructure/health-checker');
const StructuredLogger = require('../src/utils/structured-logger');
const { debug, setBridge } = require('../src/utils/debug-logger');
const AgentRuntime = require('../src/runtime/agent/agent-runtime');
const AgentMonitor = require('../src/runtime/agent/agent-monitor');
const AgentSandbox = require('../src/runtime/agent/agent-sandbox');
const AgentLifecycleController = require('../src/runtime/agent/agent-lifecycle-controller');
const AgentStateManager = require('../src/runtime/agent/agent-state-manager');
const DesignSkillEngine = require('../src/gate/design-skill-engine');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const _tempDirs = [];
/**
 * @returns {string} 创建的临时目录绝对路径
 */
function createTempDir() {
  const dir = path.join(os.tmpdir(), 'harness-verify-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  const harnessDir = path.join(dir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'agents-runtime'), { recursive: true });
  _tempDirs.push(dir);
  return dir;
}

afterEach(function() {
  for (const d of _tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
  _tempDirs.length = 0;
});

describe('V1: Agent/Skill自动触发条件与执行流程', function() {

  test('V1.1: SkillRouter自动发现Skill', function() {
    const router = new SkillRouter(PROJECT_ROOT);
    const skills = router.discover();
    assert.ok(skills.length >= 20, '应发现至少20个Skill，实际' + skills.length);
    assert.ok(router.registry['brainstorming']);
    assert.ok(router.registry['tdd-implement']);
    assert.ok(router.registry['verification-before-completion']);
    assert.ok(router.registry['deployment']);
  });

  test('V1.2: SkillRouter按关键词自动匹配', function() {
    const router = new SkillRouter(PROJECT_ROOT);
    router.discover();
    const matches = router.match({
      userMessage: '我需要做一个新项目，帮我头脑风暴一下',
      agent: 'team-lead',
      completedSkills: [],
    });
    assert.ok(matches.some(s => s.skill_id === 'brainstorming'), '应匹配brainstorming');
  });

  test('V1.3: SkillRouter否定模式阻止误触发', function() {
    const router = new SkillRouter(PROJECT_ROOT);
    router.discover();
    const matches = router.match({
      userMessage: '不需要做需求分析，直接开始编码',
      agent: 'task-worker',
      completedSkills: [],
    });
    assert.ok(!matches.some(s => s.skill_id === 'requirement-analysis'), '否定模式应阻止匹配');
  });

  test('V1.4: SkillRouter依赖链自动激活', function() {
    const router = new SkillRouter(PROJECT_ROOT);
    router.discover();
    const matches = router.match({
      userMessage: '继续开发',
      agent: 'task-worker',
      completedSkills: ['brainstorming', 'requirement-analysis', 'architecture-design'],
    });
    const skillIds = matches.map(s => s.skill_id);
    assert.ok(skillIds.length > 0, '应匹配到至少一个Skill，实际: ' + skillIds.join(','));
  });

  test('V1.5: RBACEnforcer自动加载Agent权限', function() {
    const enforcer = new RBACEnforcer(PROJECT_ROOT);
    enforcer.load();
    const perms = enforcer.getAgentPermissions('team-lead');
    assert.ok(perms, 'team-lead权限应被加载');
    assert.ok(perms.skills.includes('brainstorming'), '应有brainstorming权限');
    assert.strictEqual(perms.auto_route, true, '应启用auto_route');
  });

  test('V1.6: RBACEnforcer强制执行权限检查', function() {
    const enforcer = new RBACEnforcer(PROJECT_ROOT);
    enforcer.load();
    assert.ok(enforcer.canExecute('task-worker', 'tdd-implement'), 'task-worker可执行tdd-implement');
    assert.throws(function() {
      enforcer.enforceExecute('unknown-agent', 'tdd-implement');
    }, function(err) {
      return err && err.message && err.message.includes('cannot execute');
    }, '未授权Agent应抛出PermissionError');
  });

  test('V1.7: RBACEnforcer执行顺序验证', function() {
    const enforcer = new RBACEnforcer(PROJECT_ROOT);
    enforcer.load();
    const result1 = enforcer.validateExecutionOrder('module-development', []);
    assert.ok(!result1.valid, '未完成depends_on应失败');
    const result2 = enforcer.validateExecutionOrder('module-development', ['tdd-implement', 'architecture-design']);
    assert.ok(result2.valid, '完成depends_on应通过, result=' + JSON.stringify(result2));
  });

  test('V1.8: PhaseOrchestrator阶段转换验证', function() {
    const orch = new PhaseOrchestrator();
    assert.ok(orch.canTransition('requirement-analysis', 'architecture-design'), '需求→架构应合法');
    assert.ok(!orch.canTransition('requirement-analysis', 'deployment'), '需求→部署应不合法');
  });

  test('V1.9: PhaseOrchestrator阶段完成条件', function() {
    const orch = new PhaseOrchestrator();
    const requiredSkills = orch.getRequiredSkills('module-development');
    const result1 = orch.isPhaseComplete('module-development', requiredSkills);
    assert.ok(result1, '全部完成应通过');
    const result2 = orch.isPhaseComplete('module-development', []);
    assert.ok(!result2, '缺少Skill应不通过');
  });
});

describe('V2: 功能模块自动激活与运行状态', function() {

  test('V2.1: SessionManager自动持久化', function() {
    const dir = createTempDir();
    const mgr = new SessionManager(dir);
    mgr.create('s-001');
    mgr.completeSkill('s-001', 'brainstorming');
    mgr.flush();
    const filePath = path.join(dir, '.harness', 'sessions', 's-001.json');
    assert.ok(fs.existsSync(filePath), '会话应持久化到磁盘');
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.ok(content.completedSkills.includes('brainstorming'), 'Skill应持久化');
    mgr.shutdown();
  });

  test('V2.2: SessionManager事件自动发射', function() {
    const dir = createTempDir();
    const mgr = new SessionManager(dir);
    const events = [];
    mgr.on('session-created', (e) => events.push('created:' + e.sessionId));
    mgr.on('skill-complete', (e) => events.push('skill:' + e.skillId));
    mgr.on('phase-change', (e) => events.push('phase:' + e.to));
    mgr.create('s-002');
    mgr.completeSkill('s-002', 'brainstorming');
    try { mgr.advancePhase('s-002', 'architecture-design'); } catch (_e) { /* phase may not match expected transition */ }
    assert.ok(events.includes('created:s-002'), '应发射created');
    assert.ok(events.includes('skill:brainstorming'), '应发射skill-complete');
    mgr.shutdown();
  });

  test('V2.3: SessionManager预算预警自动触发', function() {
    const dir = createTempDir();
    const mgr = new SessionManager(dir);
    let warned = false;
    mgr.on('budget-warning', () => { warned = true; });
    mgr.create('s-003');
    mgr.addTokenUsage('s-003', 800000000);
    assert.ok(warned, '80%预算应触发预警');
    mgr.shutdown();
  });

  test('V2.4: EventBus→AuditLogger中间件自动传播', function() {
    const dir = createTempDir();
    const bus = new EventBus();
    const audit = new AuditLogger(dir, { maxEntries: 1000 });
    bus.use(function(event, data) {
      if (event.startsWith('agent:') || event.startsWith('session:')) {
        audit.log({ agent: (data && data.agentId) || 'system', action: event, target: '', result: 'emitted' });
      }
    });
    bus.emit('agent:created', { agentId: 'a-001' });
    const logs = audit.query({ agent: 'a-001' });
    assert.ok(logs.length > 0, 'Agent事件应自动记录到AuditLogger');
    bus.shutdown();
    audit.shutdown();
  });

  test('V2.5: TDDGate门禁自动阻止违规', function() {
    const gate = new TDDGate();
    const v = gate.check({ implFile: 'src/f.js', testFile: 'test/f.test.js', testExists: false, implExists: true });
    assert.ok(!v.passed, '无测试实现应被阻止');
    assert.strictEqual(v.phase, 'VIOLATION');
    const red = gate.check({ implFile: 'src/f.js', testFile: 'test/f.test.js', testExists: true, implExists: false, testResult: 'fail' });
    assert.strictEqual(red.phase, 'RED', '应为RED阶段');
    const green = gate.check({ implFile: 'src/f.js', testFile: 'test/f.test.js', testExists: true, implExists: true, testResult: 'pass' });
    assert.strictEqual(green.phase, 'GREEN', '应为GREEN阶段');
  });

  test('V2.6: EvidenceVerifier自动验证完成声明', function() {
    const verifier = new EvidenceVerifier();
    const noEv = verifier.verify({ claim: 'done', evidence: [], requiredTypes: verifier.getRequiredEvidenceTypes('tdd-implement') });
    assert.ok(!noEv.verified, '无证据应失败');
    assert.ok(noEv.missing.includes('test_output'), '应缺少test_output');
    const withEv = verifier.verify({
      claim: 'done',
      evidence: [{ type: 'test_output', content: 'pass' }, { type: 'coverage_report', content: '85%' }],
      requiredTypes: verifier.getRequiredEvidenceTypes('tdd-implement'),
    });
    assert.ok(withEv.verified, '证据充足应通过');
  });

  test('V2.7: PermissionGuard自动阻止项目外操作', function() {
    const dir = createTempDir();
    const guard = new PermissionGuard(dir);
    assert.ok(!guard.checkFileWrite('/etc/passwd', 'task-worker').allowed, '项目外应阻止');
    assert.ok(guard.checkFileWrite(path.join(dir, 'src/main.js'), 'task-worker').allowed, '项目内应允许');
    assert.ok(!guard.checkFileWrite(path.join(dir, '.harness/config.json'), 'task-worker').allowed, '系统文件应阻止');
    assert.ok(guard.checkFileDelete(path.join(dir, 'src/main.js'), 'task-worker').requiresConfirmation, '删除需确认');
    guard.shutdown && guard.shutdown();
  });

  test('V2.8: AgentRuntime状态转换自动验证', function() {
    const dir = createTempDir();
    const runtime = new AgentRuntime(dir);
    const events = [];
    runtime.on('agent-state-change', (e) => events.push(e));
    runtime.register('a-001', { resourceLimits: { maxMemoryMB: 128 } });
    runtime.transition('a-001', AgentRuntime.STATES.INITIALIZING);
    runtime.transition('a-001', AgentRuntime.STATES.RUNNING);
    assert.ok(events.some(e => e.to === 'running'), '应发射running状态');
    assert.throws(function() {
      runtime.transition('a-001', AgentRuntime.STATES.CREATED);
    }, function(err) {
      return err && err.message && err.message.includes('Invalid state transition');
    }, '非法转换应抛出AgentError');
    runtime.shutdown();
  });

  test('V2.9: AgentLifecycleController完整生命周期', function() {
    const dir = createTempDir();
    const runtime = new AgentRuntime(dir);
    const stateMgr = new AgentStateManager(dir);
    const sandbox = new AgentSandbox(dir);
    const lc = new AgentLifecycleController(runtime, stateMgr, sandbox);
    const events = [];
    lc.on('agent-created', (e) => events.push('created:' + e.agentId));
    lc.on('agent-started', (e) => events.push('started:' + e.agentId));
    lc.on('agent-stopped', (e) => events.push('stopped:' + e.agentId));
    lc.on('agent-destroyed', (e) => events.push('destroyed:' + e.agentId));
    lc.create('lc-001', { resourceLimits: { maxMemoryMB: 128 } });
    lc.start('lc-001');
    lc.stop('lc-001');
    lc.destroy('lc-001');
    assert.ok(events.includes('created:lc-001'), '应发射created');
    assert.ok(events.includes('started:lc-001'), '应发射started');
    assert.ok(events.includes('stopped:lc-001'), '应发射stopped');
    assert.ok(events.includes('destroyed:lc-001'), '应发射destroyed');
    lc.shutdown();
  });

  test('V2.10: AgentMonitor阈值自动告警', function() {
    const dir = createTempDir();
    const monitor = new AgentMonitor(dir);
    const alerts = [];
    monitor.on('alert', (a) => alerts.push(a));
    monitor.on('critical-alert', (a) => alerts.push(a));
    monitor.registerAgent('m-001');
    monitor.recordMetric('m-001', 'cpu', 95);
    assert.ok(alerts.some(a => a.level === 'critical'), 'CPU 95%应触发critical');
    monitor.shutdown();
  });

  test('V2.11: DesignSkillEngine自动审计与对比度检测', function() {
    const engine = new DesignSkillEngine(PROJECT_ROOT);
    const audit = engine.audit('body { color: #000000; }');
    assert.ok(audit.score < 100, '含反模式应低分');
    const contrast = engine.checkContrast('#ffffff', '#000000');
    assert.strictEqual(contrast.ratio, 21, '白黑对比度21:1');
    assert.ok(contrast.aaa, '应通过AAA');
    const poor = engine.checkContrast('#a1a1aa', '#e4e4e7');
    assert.ok(!poor.aa, '低对比度不应通过AA');
  });

  test('V2.12: HealthChecker自动注册', async function() {
    const checker = new HealthChecker();
    checker.register('ok-mod', () => ({ healthy: true, message: 'OK' }));
    checker.register('fail-mod', () => ({ healthy: false, message: 'Down' }));
    const result = await checker.checkAll();
    assert.ok(result && (result.status === 'degraded' || result.status === 'unhealthy'), '部分不健康应为degraded, got: ' + (result && result.status));
  });

  test('V2.13: PluginManager Hook自动执行', function() {
    const bus = new EventBus();
    const pm = new PluginManager(bus);
    let hookCalled = false;
    pm.register({
      id: 'test-plugin',
      init(ctx) {
        ctx.registerHook('before-skill', (data) => { hookCalled = true; return data; });
      },
    });
    pm.executeHook('before-skill', { skillId: 'tdd-implement' });
    assert.ok(hookCalled, 'Hook应自动执行');
    pm.shutdown();
    bus.shutdown();
  });
});

describe('V3: 日志系统自动捕获/存储/输出', function() {

  test('V3.1: StructuredLogger自动分级记录', function() {
    const logger = new StructuredLogger({ level: 'info', module: 'verify' });
    const entries = [];
    logger.on('log', (e) => entries.push(e));
    logger.debug('skip');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    assert.ok(!entries.some(e => e.level === 'debug'), 'info级别不应记录debug');
    assert.ok(entries.some(e => e.level === 'info'), '应记录info');
    assert.ok(entries.some(e => e.level === 'warn'), '应记录warn');
    assert.ok(entries.some(e => e.level === 'error'), '应记录error');
  });

  test('V3.2: StructuredLogger error-log事件自动发射', function() {
    const logger = new StructuredLogger({ level: 'info', module: 'verify' });
    const errorLogs = [];
    logger.on('error-log', (e) => errorLogs.push(e));
    logger.info('normal');
    logger.error('fail');
    assert.strictEqual(errorLogs.length, 1, 'error应触发error-log');
  });

  test('V3.3: debug-logger桥接到StructuredLogger', function() {
    const logger = new StructuredLogger({ level: 'debug', module: 'verify' });
    const bridged = [];
    logger.on('log', (e) => bridged.push(e));
    setBridge(logger);
    debug('TestMod', 'testAct', new Error('bridge test'));
    assert.ok(bridged.some(e => e.message.includes('TestMod')), '桥接后应通过StructuredLogger输出');
    setBridge(null);
  });

  test('V3.4: AuditLogger自动持久化到磁盘', function() {
    const dir = createTempDir();
    const logger = new AuditLogger(dir, { maxEntries: 1000 });
    logger.log({ agent: 'task-worker', action: 'file-write', target: '/src/main.js', result: 'allowed' });
    logger.log({ agent: 'unknown', action: 'file-delete', target: '/etc/passwd', result: 'denied' });
    logger.flush();
    const filePath = path.join(dir, '.harness', 'audit', 'audit-log.json');
    assert.ok(fs.existsSync(filePath), '审计日志应持久化');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.ok(data.some(e => e.agent === 'task-worker'), '应包含task-worker记录');
    assert.ok(data.some(e => e.result === 'denied'), '应包含denied记录');
    logger.shutdown();
  });

  test('V3.5: AuditLogger自动恢复历史记录', function() {
    const dir = createTempDir();
    let logger = new AuditLogger(dir, { maxEntries: 1000 });
    logger.log({ agent: 'a-1', action: 'test', target: '', result: 'ok' });
    logger.flush();
    logger.shutdown();
    logger = new AuditLogger(dir, { maxEntries: 1000 });
    const restored = logger.query({ agent: 'a-1' });
    assert.ok(restored.length > 0, '重启后应恢复历史记录');
    logger.shutdown();
  });

  test('V3.6: EventBus事件历史自动记录', function() {
    const bus = new EventBus({ maxHistory: 100 });
    bus.emit('test-event', { foo: 'bar' });
    bus.emit('other-event', { baz: 42 });
    const history = bus.getHistory();
    assert.ok(history.length >= 2, '事件历史应自动记录');
    const filtered = bus.getHistory('test-event');
    assert.strictEqual(filtered.length, 1, '应能按事件名过滤');
    bus.shutdown();
  });

  test('V3.7: StructuredLogger子日志器自动传播', function() {
    const parent = new StructuredLogger({ level: 'info', module: 'parent' });
    const propagated = [];
    parent.on('log', (e) => propagated.push(e));
    const child = parent.child('sub');
    child.info('child msg');
    assert.ok(propagated.some(e => e.module === 'parent:sub'), '子日志器应传播到父');
    child.destroy && child.destroy();
  });

  test('V3.8: AgentMonitor日志自动记录', function() {
    const dir = createTempDir();
    const monitor = new AgentMonitor(dir);
    monitor.registerAgent('log-001');
    monitor.logEvent('log-001', 'error', 'Something went wrong', { code: 'ERR001' });
    const logs = monitor.getLogs('log-001', { level: 'error' });
    assert.ok(logs.length > 0, '应记录error级别日志');
    assert.strictEqual(logs[0].message, 'Something went wrong');
    monitor.shutdown();
  });

  test('V3.9: AgentSandbox访问日志自动记录', function() {
    const dir = createTempDir();
    const sandbox = new AgentSandbox(dir);
    sandbox.prepare('sb-001', { sandboxLevel: 'strict' });
    sandbox.checkAccess('sb-001', 'filesystem', 'read');
    sandbox.checkAccess('sb-001', 'network', 'connect');
    const accessLog = sandbox.getAccessLog('sb-001', { deniedOnly: true });
    assert.ok(accessLog.length > 0, '应自动记录被拒绝的访问');
    sandbox.shutdown();
  });

  test('V3.10: SessionManager AgentHistory自动限制', function() {
    const dir = createTempDir();
    const mgr = new SessionManager(dir);
    mgr.create('s-hist');
    for (let i = 0; i < 600; i++) {
      mgr.recordAgentAction('s-hist', 'task-worker', 'action-' + i);
    }
    const session = mgr.get('s-hist');
    assert.ok(session.agentHistory.length <= 500, 'AgentHistory应限制在500以内');
    mgr.shutdown();
  });
});
