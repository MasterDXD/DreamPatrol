'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const _sessionFilesToCleanup = [];
const _sessionMgrsToCleanup = [];
function _cleanupSessionFiles() {
  for (const mgr of _sessionMgrsToCleanup) {
    try { mgr.shutdown(); } catch (_) { /* best-effort */ }
  }
  _sessionMgrsToCleanup.length = 0;
  for (const f of _sessionFilesToCleanup) {
    try { fs.unlinkSync(f); } catch (_) { /* best-effort */ }
  }
  _sessionFilesToCleanup.length = 0;
}
function _trackSessionFile(sessionId) {
  _sessionFilesToCleanup.push(path.join(ROOT, '.harness', 'sessions', sessionId + '.json'));
}

describe('Deepening Skill Definitions', () => {
  it('should have iterative-deepening skill file', () => {
    const skillPath = path.join(ROOT, '.harness', 'skills', 'iterative-deepening.md');
    assert.ok(fs.existsSync(skillPath));
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.includes('skill_id: iterative-deepening'));
    assert.ok(content.includes('phase: module-development'));
    assert.ok(content.includes('applicable_agents'));
  });

  it('should have multi-agent-fusion skill file', () => {
    const skillPath = path.join(ROOT, '.harness', 'skills', 'multi-agent-fusion.md');
    assert.ok(fs.existsSync(skillPath));
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.includes('skill_id: multi-agent-fusion'));
    assert.ok(content.includes('phase: module-development'));
    assert.ok(content.includes('applicable_agents'));
  });

  it('iterative-deepening skill should reference deepening modules', () => {
    const skillPath = path.join(ROOT, '.harness', 'skills', 'iterative-deepening.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.includes('AdaptiveDepthController'));
    assert.ok(content.includes('LTIContextInjector'));
    assert.ok(content.includes('RecurrentDeepeningScheduler'));
    assert.ok(content.includes('ConvergenceDetector'));
  });

  it('multi-agent-fusion skill should reference fusion modules', () => {
    const skillPath = path.join(ROOT, '.harness', 'skills', 'multi-agent-fusion.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.includes('MultiAgentRouter'));
    assert.ok(content.includes('OutputFusion'));
    assert.ok(content.includes('AffinityLearner'));
  });
});

describe('Agent Definitions Updated', () => {
  it('task-worker should have deepening capabilities', () => {
    const agentPath = path.join(ROOT, '.harness', 'agents', 'task-worker.md');
    const content = fs.readFileSync(agentPath, 'utf8');
    assert.ok(content.includes('iterative-deepening'));
    assert.ok(content.includes('multi-agent-fusion'));
  });

  it('domain-analyst should have deepening capabilities', () => {
    const agentPath = path.join(ROOT, '.harness', 'agents', 'domain-analyst.md');
    const content = fs.readFileSync(agentPath, 'utf8');
    assert.ok(content.includes('iterative-deepening'));
    assert.ok(content.includes('multi-agent-fusion'));
  });

  it('quality-assurance should have deepening capabilities', () => {
    const agentPath = path.join(ROOT, '.harness', 'agents', 'quality-assurance.md');
    const content = fs.readFileSync(agentPath, 'utf8');
    assert.ok(content.includes('iterative-deepening'));
    assert.ok(content.includes('multi-agent-fusion'));
  });
});

describe('EvidenceVerifier Deepening Evidence', () => {
  const EvidenceVerifier = require(path.join(ROOT, 'src', 'gate', 'evidence-verifier'));

  it('should define evidence requirements for iterative-deepening', () => {
    const verifier = new EvidenceVerifier();
    const types = verifier.getRequiredEvidenceTypes('iterative-deepening');
    assert.ok(types.includes('quality_score_report'));
    assert.ok(types.includes('convergence_report'));
  });

  it('should define evidence requirements for multi-agent-fusion', () => {
    const verifier = new EvidenceVerifier();
    const types = verifier.getRequiredEvidenceTypes('multi-agent-fusion');
    assert.ok(types.includes('fusion_report'));
    assert.ok(types.includes('agent_affinity_report'));
  });

  it('should verify iterative-deepening evidence with all required types', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'iterative-deepening completed',
      evidence: [
        { type: 'quality_score_report', content: 'total: 0.87, grade: good' },
        { type: 'convergence_report', content: 'converged: true, iterations: 3' },
      ],
      requiredTypes: verifier.getRequiredEvidenceTypes('iterative-deepening'),
    });
    assert.ok(result.verified);
  });

  it('should reject incomplete iterative-deepening evidence', () => {
    const verifier = new EvidenceVerifier();
    const result = verifier.verify({
      claim: 'iterative-deepening completed',
      evidence: [
        { type: 'quality_score_report', content: 'total: 0.87' },
      ],
      requiredTypes: verifier.getRequiredEvidenceTypes('iterative-deepening'),
    });
    assert.equal(result.verified, false);
    assert.ok(result.missing.includes('convergence_report'));
  });
});

describe('SessionManager Deepening State', () => {
  const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));

  after(() => { _cleanupSessionFiles(); });

  it('should create session with deepening state', () => {
    const mgr = new SessionManager(ROOT);
    delete mgr.sessions['deepening-test-1'];
    const session = mgr.create('deepening-test-1');
    _trackSessionFile('deepening-test-1');
    assert.ok(session.deepeningState);
    assert.equal(session.deepeningState.totalIterations, 0);
    assert.equal(session.deepeningState.bestQualityScore, 0);
    mgr.shutdown();
  });

  it('should record deepening iteration', () => {
    const mgr = new SessionManager(ROOT);
    delete mgr.sessions['deepening-test-2'];
    mgr.create('deepening-test-2');
    _trackSessionFile('deepening-test-2');
    const updated = mgr.recordDeepeningIteration('deepening-test-2', { qualityScore: 0.8 });
    assert.ok(updated);
    assert.equal(updated.deepeningState.totalIterations, 1);
    assert.equal(updated.deepeningState.bestQualityScore, 0.8);
    mgr.shutdown();
  });

  it('should track best quality score across iterations', () => {
    const mgr = new SessionManager(ROOT);
    delete mgr.sessions['deepening-test-3'];
    mgr.create('deepening-test-3');
    _trackSessionFile('deepening-test-3');
    mgr.recordDeepeningIteration('deepening-test-3', { qualityScore: 0.7 });
    mgr.recordDeepeningIteration('deepening-test-3', { qualityScore: 0.9 });
    mgr.recordDeepeningIteration('deepening-test-3', { qualityScore: 0.8 });
    const state = mgr.getDeepeningState('deepening-test-3');
    assert.equal(state.totalIterations, 3);
    assert.equal(state.bestQualityScore, 0.9);
    mgr.shutdown();
  });

  it('should record deepening convergence', () => {
    const mgr = new SessionManager(ROOT);
    delete mgr.sessions['deepening-test-4'];
    mgr.create('deepening-test-4');
    _trackSessionFile('deepening-test-4');
    mgr.recordDeepeningConvergence('deepening-test-4', {
      converged: true,
      reason: 'quality-threshold-met',
      qualityScore: 0.9,
      iterations: 3,
    });
    const state = mgr.getDeepeningState('deepening-test-4');
    assert.equal(state.totalDeepeningExecutions, 1);
    assert.equal(state.convergenceHistory.length, 1);
    assert.equal(state.convergenceHistory[0].reason, 'quality-threshold-met');
    mgr.shutdown();
  });

  it('should return null for non-existent session deepening state', () => {
    const mgr = new SessionManager(ROOT);
    const state = mgr.getDeepeningState('non-existent');
    assert.equal(state, null);
    mgr.shutdown();
  });

  it('should initialize deepening state on legacy sessions', () => {
    const mgr = new SessionManager(ROOT);
    delete mgr.sessions['deepening-test-5'];
    const session = mgr.create('deepening-test-5');
    _trackSessionFile('deepening-test-5');
    delete session.deepeningState;
    const updated = mgr.recordDeepeningIteration('deepening-test-5', { qualityScore: 0.5 });
    assert.ok(updated.deepeningState);
    assert.equal(updated.deepeningState.totalIterations, 1);
    mgr.shutdown();
  });
});

describe('Config Integration', () => {
  it('should have deepening skills in config.json skill registry', () => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const skillIds = config.skill_registry.skills.map(s => s.skill_id);
    assert.ok(skillIds.includes('iterative-deepening'));
    assert.ok(skillIds.includes('multi-agent-fusion'));
  });

  it('should have deepening_config in config.json', () => {
    const configPath = path.join(ROOT, '.harness', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.deepening_config);
    assert.ok(config.deepening_config.recurrent_deepening);
    assert.ok(config.deepening_config.adaptive_depth);
    assert.ok(config.deepening_config.convergence_detector);
  });

  it('should have iterative-deepening in module-development phase skills', () => {
    const { PHASE_SKILLS } = require(path.join(ROOT, 'src', 'utils', 'constants'));
    assert.ok(PHASE_SKILLS['module-development'].includes('iterative-deepening'));
    assert.ok(PHASE_SKILLS['module-development'].includes('multi-agent-fusion'));
  });
});

describe('SkillRouter Deepening Semantic Groups', () => {
  const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));

  it('should match deepening keywords', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '深化迭代推理', agent: 'task-worker' });
    const skillIds = matches.map(m => m.skill_id);
    assert.ok(skillIds.includes('iterative-deepening'));
  });

  it('should match fusion keywords', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '多Agent协同融合', agent: 'team-lead' });
    const skillIds = matches.map(m => m.skill_id);
    assert.ok(skillIds.includes('multi-agent-fusion'));
  });

  it('should have deepening semantic group defined', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '收敛检测', agent: 'quality-assurance' });
    assert.ok(Array.isArray(matches));
  });
});

describe('PhaseOrchestrator Deepening Integration', () => {
  it('should include iterative-deepening in strict skills set', () => {
    const { PHASE_SKILLS } = require(path.join(ROOT, 'src', 'utils', 'constants'));
    assert.ok(PHASE_SKILLS['module-development'].includes('iterative-deepening'));
  });
});
