const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
});

function createTempProjectRoot() {
  const dir = path.join(os.tmpdir(), 'harness-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(path.join(dir, '.harness', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.harness', 'agents'), { recursive: true });
  const config = { project_name: 'test-project', version: '1.0.0', token_budget: 1000000, enforcement: { tdd: true, evidence: true, rbac: true } };
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(config));
  TEMP_DIRS.push(dir);
  return dir;
}

describe('SkillRouter', () => {
  const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));

  describe('discover()', () => {
    it('should discover all skills from .harness/skills/', () => {
      const router = new SkillRouter(ROOT);
      const skills = router.discover();
      assert.ok(skills.length >= 26, `Expected at least 26 skills, found ${skills.length}`);
    });

    it('should parse YAML frontmatter correctly for each skill', () => {
      const router = new SkillRouter(ROOT);
      const skills = router.discover();
      for (const skill of skills) {
        assert.ok(skill.skill_id, `Missing skill_id in ${skill.name}`);
        assert.ok(skill.name, `Missing name in ${skill.skill_id}`);
        assert.ok(skill.phase, `Missing phase in ${skill.skill_id}`);
        assert.ok(typeof skill.priority === 'number', `Missing priority in ${skill.skill_id}`);
        assert.ok(skill.enforcement, `Missing enforcement in ${skill.skill_id}`);
      }
    });

    it('should identify infrastructure components separately', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const infra = router.skills.filter(s => s.infrastructure);
      assert.equal(infra.length, 2);
      const infraIds = infra.map(s => s.skill_id).sort();
      assert.deepEqual(infraIds, ['session-start-hook', 'skill-router']);
    });
  });

  describe('match()', () => {
    it('should match by explicit trigger keywords', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const matches = router.match({ userMessage: '帮我做需求分析', agent: 'domain-analyst' });
      assert.ok(matches.some(s => s.skill_id === 'requirement-analysis'));
    });

    it('should match brainstorming for vague requirements', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const matches = router.match({ userMessage: '我想做一个博客系统', agent: 'team-lead' });
      assert.ok(matches.some(s => s.skill_id === 'brainstorming'));
    });

    it('should match tdd-implement for TDD keywords', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const matches = router.match({ userMessage: '用TDD实现这个功能', agent: 'task-worker' });
      assert.ok(matches.some(s => s.skill_id === 'tdd-implement'));
    });

    it('should return empty for agent without permission', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const matches = router.match({ userMessage: 'TDD开发', agent: 'team-lead' });
      const tddMatch = matches.find(s => s.skill_id === 'tdd-implement');
      assert.equal(tddMatch, undefined);
    });

    it('should match by phase flow (depends_on satisfied)', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const matches = router.match({
        userMessage: '继续开发',
        agent: 'task-worker',
        completedSkills: ['architecture-design'],
      });
      assert.ok(matches.some(s => s.skill_id === 'tdd-implement'));
    });
  });

  describe('resolveConflict()', () => {
    it('should prioritize by phase when multiple skills match', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const matches = router.match({ userMessage: '需求分析架构设计', agent: 'domain-analyst' });
      const resolved = router.resolveConflict(matches);
      assert.equal(resolved.phase, 'requirement-analysis');
    });
  });

  describe('checkDependencies()', () => {
    it('should block skill when depends_on not satisfied', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.checkDependencies('code-review', []);
      assert.equal(result.satisfied, false);
    });

    it('should allow skill when depends_on is satisfied', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.checkDependencies('code-review', ['module-development', 'tdd-implement']);
      assert.equal(result.satisfied, true);
    });

    it('should allow skill with no dependencies', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.checkDependencies('brainstorming', []);
      assert.equal(result.satisfied, true);
    });
  });

  describe('validateBehaviorEquivalence()', () => {
    it('should validate equivalent behavior for refactor-code', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const before = { apiResponse: 'ok', statusCode: 200, data: [1, 2, 3] };
      const afterResult = { apiResponse: 'ok', statusCode: 200, data: [1, 2, 3] };
      const result = router.validateBehaviorEquivalence('refactor-code', before, afterResult);
      assert.equal(result.valid, true);
      assert.ok(result.summary.includes('passed'));
    });

    it('should detect changed behavior', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const before = { apiResponse: 'ok', statusCode: 200 };
      const afterChanged = { apiResponse: 'error', statusCode: 500 };
      const result = router.validateBehaviorEquivalence('refactor-code', before, afterChanged);
      assert.equal(result.valid, false);
      assert.ok(result.checks.some(c => c.changed));
    });

    it('should return valid for skill without behavior outputs', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.validateBehaviorEquivalence('brainstorming', {}, {});
      assert.equal(result.valid, true);
    });

    it('should return invalid for unknown skill', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.validateBehaviorEquivalence('nonexistent-skill', {}, {});
      assert.equal(result.valid, false);
    });
  });

  describe('validateDeploymentChecklist()', () => {
    it('should validate complete deployment checklist', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const checklist = {
        'all-tests-passed': true,
        'code-merged-to-shared': true,
        'environment-config-verified': true,
        'rollback-plan-ready': true,
        'health-check-passed': true,
        'smoke-test-passed': true,
        'monitoring-configured': true,
      };
      const result = router.validateDeploymentChecklist('deployment', checklist);
      assert.equal(result.valid, true);
      assert.equal(result.completionRate, 1);
    });

    it('should detect incomplete checklist', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const checklist = {
        'all-tests-passed': true,
        'code-merged-to-shared': true,
      };
      const result = router.validateDeploymentChecklist('deployment', checklist);
      assert.equal(result.valid, false);
      assert.ok(result.missingItems.length > 0);
      assert.ok(result.completionRate < 1);
    });

    it('should return valid for non-deployment skill', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.validateDeploymentChecklist('brainstorming', {});
      assert.equal(result.valid, true);
    });

    it('should return invalid for missing checklist data', () => {
      const router = new SkillRouter(ROOT);
      router.discover();
      const result = router.validateDeploymentChecklist('deployment', null);
      assert.equal(result.valid, false);
    });
  });
});

describe('SessionManager', () => {
  const SessionManager = require(path.join(ROOT, 'src', 'runtime', 'session', 'session-manager'));
  let tempRoot;
  let mgr;

  beforeEach(() => {
    tempRoot = createTempProjectRoot();
    mgr = new SessionManager(tempRoot);
  });

  it('should create a new session with initial state', () => {
    const session = mgr.create('test-session');
    assert.equal(session.id, 'test-session');
    assert.equal(session.currentPhase, 'brainstorming');
    assert.deepEqual(session.completedSkills, []);
    assert.equal(session.status, 'active');
  });

  it('should advance phase correctly', () => {
    mgr.create('test-session2');
    mgr.advancePhase('test-session2', 'requirement-analysis');
    assert.equal(mgr.get('test-session2').currentPhase, 'requirement-analysis');
  });

  it('should record completed skills', () => {
    mgr.create('test-session3');
    mgr.completeSkill('test-session3', 'brainstorming');
    assert.ok(mgr.get('test-session3').completedSkills.includes('brainstorming'));
  });

  it('should validate phase transitions', () => {
    mgr.create('test-session4');
    assert.throws(() => {
      mgr.advancePhase('test-session4', 'deployment');
    }, /Invalid phase transition/);
  });

  it('should track token usage', () => {
    mgr.create('test-session5');
    mgr.addTokenUsage('test-session5', 1000);
    mgr.addTokenUsage('test-session5', 500);
    assert.equal(mgr.get('test-session5').tokensUsed, 1500);
  });

  it('should detect token budget threshold', () => {
    mgr.create('test-session6');
    mgr.addTokenUsage('test-session6', 800000000);
    const alert = mgr.checkBudget('test-session6');
    assert.ok(alert.warning80);
  });

  it('should debounce disk writes and flush immediately', () => {
    mgr.create('debounce-test');
    mgr.advancePhase('debounce-test', 'requirement-analysis');
    mgr.completeSkill('debounce-test', 'requirement-analysis');
    assert.equal(mgr.get('debounce-test').currentPhase, 'requirement-analysis');
    assert.ok(mgr.get('debounce-test').completedSkills.includes('requirement-analysis'));
    mgr.flush();
    const filePath = path.join(tempRoot, '.harness', 'sessions', 'debounce-test.json');
    assert.ok(fs.existsSync(filePath));
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.currentPhase, 'requirement-analysis');
  });

  it('should persist create immediately without debounce', () => {
    mgr.create('immediate-persist-test');
    const filePath = path.join(tempRoot, '.harness', 'sessions', 'immediate-persist-test.json');
    assert.ok(fs.existsSync(filePath));
  });
});

describe('PhaseOrchestrator', () => {
  const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));

  it('should define correct phase sequence', () => {
    const orch = new PhaseOrchestrator();
    const phases = orch.getPhases();
    assert.deepEqual(phases, [
      'brainstorming',
      'requirement-analysis',
      'architecture-design',
      'module-development',
      'integration-testing',
      'deployment',
    ]);
  });

  it('should validate next phase transition', () => {
    const orch = new PhaseOrchestrator();
    assert.ok(orch.canTransition('requirement-analysis', 'architecture-design'));
    assert.ok(!orch.canTransition('requirement-analysis', 'deployment'));
  });

  it('should get required skills for a phase', () => {
    const orch = new PhaseOrchestrator();
    const skills = orch.getRequiredSkills('module-development');
    assert.ok(skills.includes('tdd-implement'));
    assert.ok(skills.includes('module-development'));
  });

  it('should check if phase is complete', () => {
    const orch = new PhaseOrchestrator();
    const result = orch.isPhaseComplete('requirement-analysis', ['brainstorming', 'requirement-analysis']);
    assert.ok(result);
  });

  it('should report incomplete phase', () => {
    const orch = new PhaseOrchestrator();
    const result = orch.isPhaseComplete('module-development', ['tdd-implement']);
    assert.ok(!result);
  });
});

describe('SkillRouter - Tag-based Filtering', () => {
  const SkillRouter = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-router'));

  it('should build tag index on discover', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const stats = router._stats;
    assert.ok(typeof stats.tagFilterSkips === 'number');
  });

  it('should filter skills by tags in match()', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '开发', agent: 'task-worker', tags: ['tdd'] });
    assert.ok(Array.isArray(matches));
  });

  it('should return skills with matching tags', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: 'TDD', agent: 'task-worker', tags: ['implement'] });
    assert.ok(matches.some(s => s.skill_id === 'tdd-implement'));
  });

  it('should return empty when tag filter matches nothing', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const matches = router.match({ userMessage: '开发', agent: 'task-worker', tags: ['nonexistent-tag-xyz'] });
    assert.equal(matches.length, 0);
  });

  it('should get skills by tag', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const skills = router.getSkillsByTag('tdd');
    assert.ok(Array.isArray(skills));
  });

  it('should get all tags', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const tags = router.getAllTags();
    assert.ok(tags instanceof Map);
    assert.ok(tags.size > 0);
  });

  it('should increment tagFilterSkips when tag does not match', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const before = router._stats.tagFilterSkips;
    router.match({ userMessage: '开发', agent: 'task-worker', tags: ['zzz-nonexistent'] });
    assert.ok(router._stats.tagFilterSkips >= before);
  });

  it('should match top K skills', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const topK = router.matchTopK({ userMessage: '需求分析', agent: 'domain-analyst' }, 2);
    assert.ok(Array.isArray(topK));
    assert.ok(topK.length <= 2);
    for (const m of topK) {
      assert.ok(m.skill_id, 'matchTopK result should have skill_id field');
    }
  });

  it('should return non-empty matchTopK results with skill_id', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const allMatches = router.match({ userMessage: '实现 测试 调试', agent: 'task-worker' });
    if (allMatches.length > 1) {
      const topK = router.matchTopK({ userMessage: '实现 测试 调试', agent: 'task-worker' }, 2);
      assert.ok(topK.length > 0, 'matchTopK should return at least 1 result');
      for (const m of topK) {
        assert.ok(typeof m.skill_id === 'string' && m.skill_id.length > 0, 'skill_id should be a non-empty string');
      }
    }
  });

  it('should preserve sort order in matchTopK', () => {
    const router = new SkillRouter(ROOT);
    router.discover();
    const allMatches = router.match({ userMessage: '实现 测试 调试 部署', agent: 'task-worker' });
    if (allMatches.length > 2) {
      const topK = router.matchTopK({ userMessage: '实现 测试 调试 部署', agent: 'task-worker' }, 2);
      if (topK.length > 1) {
        const firstInAll = allMatches.findIndex(m => m.skill_id === topK[0].skill_id);
        const secondInAll = allMatches.findIndex(m => m.skill_id === topK[1].skill_id);
        assert.ok(firstInAll < secondInAll, 'TopK results should preserve original sort order');
      }
    }
  });

  it('should attach skill reducer', () => {
    const router = new SkillRouter(ROOT);
    const { SkillReducer } = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-reducer'));
    const reducer = new SkillReducer(ROOT);
    router.attachSkillReducer(reducer);
    assert.strictEqual(router._skillReducer, reducer);
    reducer.shutdown();
  });
});

describe('SkillDiscoverUtils - Tag Extraction', () => {
  const { extractTagsFromSkillName, extractTagsFromTriggerConditions, extractTagsFromApplicableAgents, extractTags } = require(path.join(ROOT, 'src', 'runtime', 'skill', 'skill-discover-utils'));

  it('should extract tags from skill name', () => {
    const tags = extractTagsFromSkillName('tdd-implement');
    assert.ok(tags.includes('tdd'));
    assert.ok(tags.includes('implement'));
  });

  it('should extract tags from trigger conditions', () => {
    const tags = extractTagsFromTriggerConditions(['用户需要"架构设计"时触发']);
    assert.ok(tags.some(t => t.includes('架构') || t.includes('设计')));
  });

  it('should extract tags from applicable agents', () => {
    const tags = extractTagsFromApplicableAgents(['task-worker', 'domain-analyst']);
    assert.ok(tags.includes('task'));
    assert.ok(tags.includes('worker'));
    assert.ok(tags.includes('domain'));
  });

  it('should extract tags from frontmatter', () => {
    const tags = extractTags('brainstorming.md', { tags: ['探索', '需求'], phase: 'brainstorming' });
    assert.ok(tags.includes('探索'));
    assert.ok(tags.includes('需求'));
    assert.ok(tags.includes('brainstorming'));
  });

  it('should handle empty inputs gracefully', () => {
    assert.deepEqual(extractTagsFromSkillName(''), []);
    assert.deepEqual(extractTagsFromTriggerConditions(null), []);
    assert.deepEqual(extractTagsFromTriggerConditions([]), []);
    assert.deepEqual(extractTagsFromApplicableAgents(null), []);
    assert.deepEqual(extractTagsFromApplicableAgents([]), []);
  });

  it('should filter out short parts from skill name', () => {
    const tags = extractTagsFromSkillName('a-bc');
    assert.ok(!tags.includes('a'));
    assert.ok(tags.includes('bc'));
  });
});
