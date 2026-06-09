'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const PromptBuilder = require('../../../src/runtime/prompt/prompt-builder');

/**
 * 创建临时项目根目录，包含 .harness 子目录结构。
 * 每个测试用例使用独立的临时目录，避免状态污染。
 */
function createTempProjectRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-'));
  fs.mkdirSync(path.join(tmp, '.harness'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.harness', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.harness', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.harness', 'skills'), { recursive: true });
  return tmp;
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cleanup(instance, projectRoot) {
  if (instance && typeof instance.shutdown === 'function') {
    try { instance.shutdown(); } catch (_) { /* ignore */ }
  }
  if (projectRoot) removeTempDir(projectRoot);
}

// ─── 构造函数 ──────────────────────────────────────────────────────

describe('PromptBuilder – Constructor', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should create instance with valid projectRoot', () => {
    const pb = new PromptBuilder(projectRoot);
    assert.ok(pb);
    assert.equal(pb._projectRoot, projectRoot);
    cleanup(pb);
  });

  it('should apply default config when no options provided', () => {
    const pb = new PromptBuilder(projectRoot);
    assert.equal(pb._config.maxStaticTokens, 8000);
    assert.equal(pb._config.maxDynamicTokens, 4000);
    assert.equal(pb._config.cacheStaticPrefix, true);
    assert.equal(pb._config.includeRules, true);
    assert.equal(pb._config.includePersona, true);
    assert.equal(pb._config.includeSkills, true);
    cleanup(pb);
  });

  it('should merge custom options with defaults', () => {
    const pb = new PromptBuilder(projectRoot, { maxStaticTokens: 4000, includeRules: false });
    assert.equal(pb._config.maxStaticTokens, 4000);
    assert.equal(pb._config.maxDynamicTokens, 4000); // default preserved
    assert.equal(pb._config.includeRules, false);
    cleanup(pb);
  });

  it('should initialize internal caches and state', () => {
    const pb = new PromptBuilder(projectRoot);
    assert.ok(pb._staticPrefixCache);
    assert.ok(pb._staticPrefixHashes);
    assert.ok(pb._invalidatedAgents);
    assert.equal(pb._patternExtractor, null);
    assert.equal(pb._skillToolAdapter, null);
    assert.equal(pb._skillRouter, null);
    cleanup(pb);
  });

  it('should expose static constants', () => {
    assert.ok(Array.isArray(PromptBuilder.STATIC_SECTIONS));
    assert.ok(Array.isArray(PromptBuilder.DYNAMIC_SECTIONS));
    assert.ok(PromptBuilder.DEFAULT_CONFIG);
    assert.ok(PromptBuilder.RULE_PRIORITY_LAYERS);
    assert.ok(PromptBuilder.RULE_PRIORITY_NAMES);
  });
});

// ─── buildSystemPrompt ─────────────────────────────────────────────

describe('PromptBuilder – buildSystemPrompt', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should return an object with all expected fields', () => {
    const pb = new PromptBuilder(projectRoot);
    const result = pb.buildSystemPrompt('test-agent', {});
    assert.ok(result.systemPrompt);
    assert.ok(result.staticPrefix);
    assert.ok(result.dynamicSuffix !== undefined);
    assert.equal(typeof result.staticTokenCount, 'number');
    assert.equal(typeof result.dynamicTokenCount, 'number');
    assert.equal(typeof result.prefixHash, 'string');
    cleanup(pb);
  });

  it('should combine static prefix and dynamic suffix in systemPrompt', () => {
    const pb = new PromptBuilder(projectRoot);
    const result = pb.buildSystemPrompt('test-agent', {});
    assert.ok(result.systemPrompt.includes(result.staticPrefix));
    assert.ok(result.systemPrompt.includes(result.dynamicSuffix));
    assert.ok(result.systemPrompt.includes('---'));
    cleanup(pb);
  });

  it('should emit prompt-built event', () => {
    const pb = new PromptBuilder(projectRoot);
    let emitted = false;
    pb.on('prompt-built', (data) => {
      emitted = true;
      assert.equal(data.agentId, 'test-agent');
      assert.equal(typeof data.staticTokenCount, 'number');
      assert.equal(typeof data.dynamicTokenCount, 'number');
    });
    pb.buildSystemPrompt('test-agent', {});
    assert.ok(emitted);
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.buildSystemPrompt('test-agent', {}));
    cleanup(pb);
  });
});

// ─── buildStaticPrefix ─────────────────────────────────────────────

describe('PromptBuilder – buildStaticPrefix', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should include primacy emphasis at the beginning', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(prefix.includes('Core Directives'));
    cleanup(pb);
  });

  it('should include recency emphasis at the end', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(prefix.includes('Reminder'));
    cleanup(pb);
  });

  it('should include agent persona when includePersona is true', () => {
    const agentDir = path.join(projectRoot, '.harness', 'agents');
    fs.writeFileSync(path.join(agentDir, 'my-agent.md'), 'You are a helpful assistant.');
    const pb = new PromptBuilder(projectRoot, { includePersona: true, includeRules: false });
    const prefix = pb.buildStaticPrefix('my-agent');
    assert.ok(prefix.includes('Agent Identity'));
    assert.ok(prefix.includes('helpful assistant'));
    cleanup(pb);
  });

  it('should not include agent persona when includePersona is false', () => {
    const agentDir = path.join(projectRoot, '.harness', 'agents');
    fs.writeFileSync(path.join(agentDir, 'my-agent.md'), 'You are a helpful assistant.');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    const prefix = pb.buildStaticPrefix('my-agent');
    assert.ok(!prefix.includes('Agent Identity'));
    cleanup(pb);
  });

  it('should include rules when includeRules is true', () => {
    const rulesDir = path.join(projectRoot, '.harness', 'rules');
    fs.writeFileSync(path.join(rulesDir, 'naming.md'), 'Use camelCase for variables.');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: true });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(prefix.includes('Rules'));
    assert.ok(prefix.includes('camelCase'));
    cleanup(pb);
  });

  it('should not include rules when includeRules is false', () => {
    const rulesDir = path.join(projectRoot, '.harness', 'rules');
    fs.writeFileSync(path.join(rulesDir, 'naming.md'), 'Use camelCase for variables.');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(!prefix.includes('camelCase'));
    cleanup(pb);
  });

  it('should cache static prefix for same agentId', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    const prefix1 = pb.buildStaticPrefix('test-agent');
    const prefix2 = pb.buildStaticPrefix('test-agent');
    assert.equal(prefix1, prefix2);
    cleanup(pb);
  });

  it('should rebuild after invalidation', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    const prefix1 = pb.buildStaticPrefix('test-agent');
    pb.invalidateStaticPrefix('test-agent');
    const prefix2 = pb.buildStaticPrefix('test-agent');
    // Same content since no files changed, but cache was cleared and rebuilt
    assert.equal(prefix1, prefix2);
    cleanup(pb);
  });

  it('should emit static-prefix-rebuilt event on first build', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    let emitted = false;
    pb.on('static-prefix-rebuilt', (data) => {
      emitted = true;
      assert.equal(data.agentId, 'test-agent');
      assert.ok(data.hash);
      assert.equal(typeof data.tokenCount, 'number');
    });
    pb.buildStaticPrefix('test-agent');
    assert.ok(emitted);
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.buildStaticPrefix('test-agent'));
    cleanup(pb);
  });
});

// ─── buildDynamicSuffix ────────────────────────────────────────────

describe('PromptBuilder – buildDynamicSuffix', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should return empty string when context is empty', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({});
    assert.equal(suffix, '');
    cleanup(pb);
  });

  it('should include task context when provided', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({ taskContext: 'Implement auth module' });
    assert.ok(suffix.includes('Task Context'));
    assert.ok(suffix.includes('Implement auth module'));
    cleanup(pb);
  });

  it('should include environment when provided', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({ environment: { NODE_ENV: 'production', PORT: 3000 } });
    assert.ok(suffix.includes('Environment'));
    assert.ok(suffix.includes('NODE_ENV'));
    assert.ok(suffix.includes('production'));
    cleanup(pb);
  });

  it('should skip environment when empty object', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({ environment: {} });
    assert.ok(!suffix.includes('Environment'));
    cleanup(pb);
  });

  it('should include session state when provided', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({ sessionState: { phase: 'development', iteration: 3 } });
    assert.ok(suffix.includes('Session State'));
    assert.ok(suffix.includes('development'));
    cleanup(pb);
  });

  it('should include recent actions when provided', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({ recentActions: ['Created auth module', 'Ran tests'] });
    assert.ok(suffix.includes('Recent Actions'));
    assert.ok(suffix.includes('1. Created auth module'));
    assert.ok(suffix.includes('2. Ran tests'));
    cleanup(pb);
  });

  it('should skip recent actions when empty array', () => {
    const pb = new PromptBuilder(projectRoot);
    const suffix = pb.buildDynamicSuffix({ recentActions: [] });
    assert.ok(!suffix.includes('Recent Actions'));
    cleanup(pb);
  });

  it('should include skill instructions when skillIds provided and includeSkills is true', () => {
    const skillsDir = path.join(projectRoot, '.harness', 'skills');
    fs.writeFileSync(path.join(skillsDir, 'tdd.md'), 'Write tests first.');
    const pb = new PromptBuilder(projectRoot, { includeSkills: true });
    const suffix = pb.buildDynamicSuffix({ skillIds: ['tdd'] });
    assert.ok(suffix.includes('Skill Instructions'));
    assert.ok(suffix.includes('Write tests first'));
    cleanup(pb);
  });

  it('should not include skill instructions when includeSkills is false', () => {
    const skillsDir = path.join(projectRoot, '.harness', 'skills');
    fs.writeFileSync(path.join(skillsDir, 'tdd.md'), 'Write tests first.');
    const pb = new PromptBuilder(projectRoot, { includeSkills: false });
    const suffix = pb.buildDynamicSuffix({ skillIds: ['tdd'] });
    assert.ok(!suffix.includes('Skill Instructions'));
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.buildDynamicSuffix({}));
    cleanup(pb);
  });
});

// ─── getStaticPrefixHash ───────────────────────────────────────────

describe('PromptBuilder – getStaticPrefixHash', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should return empty string for unbuilt agent', () => {
    const pb = new PromptBuilder(projectRoot);
    const hash = pb.getStaticPrefixHash('unknown-agent');
    assert.equal(hash, '');
    cleanup(pb);
  });

  it('should return a hash after building static prefix', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    pb.buildStaticPrefix('test-agent');
    const hash = pb.getStaticPrefixHash('test-agent');
    assert.ok(hash);
    assert.equal(hash.length, 16); // SHA-256 truncated to 16 hex chars
    cleanup(pb);
  });

  it('should return consistent hash for same content', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    pb.buildStaticPrefix('test-agent');
    const hash1 = pb.getStaticPrefixHash('test-agent');
    const hash2 = pb.getStaticPrefixHash('test-agent');
    assert.equal(hash1, hash2);
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.getStaticPrefixHash('test-agent'));
    cleanup(pb);
  });
});

// ─── invalidateStaticPrefix ────────────────────────────────────────

describe('PromptBuilder – invalidateStaticPrefix', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should clear cached prefix for the agent', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    pb.buildStaticPrefix('test-agent');
    assert.ok(pb._staticPrefixCache.has('test-agent'));
    pb.invalidateStaticPrefix('test-agent');
    assert.ok(!pb._staticPrefixCache.has('test-agent'));
    cleanup(pb);
  });

  it('should clear hash for the agent', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    pb.buildStaticPrefix('test-agent');
    assert.ok(pb._staticPrefixHashes.has('test-agent'));
    pb.invalidateStaticPrefix('test-agent');
    assert.ok(!pb._staticPrefixHashes.has('test-agent'));
    cleanup(pb);
  });

  it('should ignore invalid agentId', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.buildStaticPrefix('test-agent');
    pb.invalidateStaticPrefix('');
    pb.invalidateStaticPrefix(null);
    pb.invalidateStaticPrefix(undefined);
    // Original cache should still exist
    assert.ok(pb._staticPrefixCache.has('test-agent'));
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.invalidateStaticPrefix('test-agent'));
    cleanup(pb);
  });
});

// ─── attachPatternExtractor ────────────────────────────────────────

describe('PromptBuilder – attachPatternExtractor', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should attach extractor and return this for chaining', () => {
    const pb = new PromptBuilder(projectRoot);
    const mockExtractor = { getRecommendedInjections: () => ({ injections: [] }) };
    const result = pb.attachPatternExtractor(mockExtractor);
    assert.equal(result, pb);
    assert.equal(pb._patternExtractor, mockExtractor);
    cleanup(pb);
  });

  it('should inject learned patterns into dynamic suffix', () => {
    const pb = new PromptBuilder(projectRoot);
    const mockExtractor = {
      getRecommendedInjections: () => ({
        injections: [
          { category: 'style', recommendation: 'Use concise responses', confidence: 0.9 },
        ],
      }),
    };
    pb.attachPatternExtractor(mockExtractor);
    const suffix = pb.buildDynamicSuffix({ taskContext: 'Write code' });
    assert.ok(suffix.includes('Learned Prompt Patterns'));
    assert.ok(suffix.includes('Use concise responses'));
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.attachPatternExtractor({}));
    cleanup(pb);
  });
});

// ─── attachSkillToolAdapter ────────────────────────────────────────

describe('PromptBuilder – attachSkillToolAdapter', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should attach adapter and return this for chaining', () => {
    const pb = new PromptBuilder(projectRoot);
    const mockAdapter = { getCoreSkillIds: () => [] };
    const result = pb.attachSkillToolAdapter(mockAdapter);
    assert.equal(result, pb);
    assert.equal(pb._skillToolAdapter, mockAdapter);
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.attachSkillToolAdapter({}));
    cleanup(pb);
  });
});

// ─── attachSkillRouter ─────────────────────────────────────────────

describe('PromptBuilder – attachSkillRouter', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should attach skillRouter and return this for chaining', () => {
    const pb = new PromptBuilder(projectRoot);
    const mockRouter = { getSkill: () => null };
    const result = pb.attachSkillRouter(mockRouter);
    assert.equal(result, pb);
    assert.equal(pb._skillRouter, mockRouter);
    cleanup(pb);
  });

  it('should throw after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.attachSkillRouter({}));
    cleanup(pb);
  });
});

// ─── Token estimation and truncation ───────────────────────────────

describe('PromptBuilder – Token estimation and truncation', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should estimate tokens as chars / 4', () => {
    const pb = new PromptBuilder(projectRoot);
    assert.equal(pb._estimateTokens(''), 0);
    assert.equal(pb._estimateTokens('abcd'), 1);
    assert.equal(pb._estimateTokens('abcdefgh'), 2);
    assert.equal(pb._estimateTokens(null), 0);
    assert.equal(pb._estimateTokens(undefined), 0);
    cleanup(pb);
  });

  it('should truncate text to token budget', () => {
    const pb = new PromptBuilder(projectRoot);
    // budget=2 tokens = 8 chars max
    const result = pb._truncateToBudget('abcdefghij', 2);
    assert.ok(result.length <= 8);
    assert.ok(result.endsWith('...'));
    cleanup(pb);
  });

  it('should not truncate text within budget', () => {
    const pb = new PromptBuilder(projectRoot);
    const result = pb._truncateToBudget('abc', 10);
    assert.equal(result, 'abc');
    cleanup(pb);
  });

  it('should return empty string for null/undefined text', () => {
    const pb = new PromptBuilder(projectRoot);
    assert.equal(pb._truncateToBudget(null, 100), '');
    assert.equal(pb._truncateToBudget(undefined, 100), '');
    cleanup(pb);
  });

  it('should respect maxStaticTokens budget', () => {
    const pb = new PromptBuilder(projectRoot, {
      maxStaticTokens: 5, // very small budget
      includePersona: false,
      includeRules: false,
    });
    const prefix = pb.buildStaticPrefix('test-agent');
    // 5 tokens = 20 chars max
    assert.ok(prefix.length <= 20);
    cleanup(pb);
  });

  it('should respect maxDynamicTokens budget', () => {
    const pb = new PromptBuilder(projectRoot, { maxDynamicTokens: 5 });
    const suffix = pb.buildDynamicSuffix({ taskContext: 'A'.repeat(100) });
    // 5 tokens = 20 chars max
    assert.ok(suffix.length <= 20);
    cleanup(pb);
  });
});

// ─── Shutdown ──────────────────────────────────────────────────────

describe('PromptBuilder – Shutdown', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should clear caches on shutdown', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: false });
    pb.buildStaticPrefix('test-agent');
    assert.ok(pb._staticPrefixCache.has('test-agent'));
    pb.shutdown();
    assert.ok(!pb._staticPrefixCache.has('test-agent'));
  });

  it('should clear pattern extractor on shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.attachPatternExtractor({ getRecommendedInjections: () => ({ injections: [] }) });
    assert.ok(pb._patternExtractor);
    pb.shutdown();
    assert.equal(pb._patternExtractor, null);
  });

  it('should clear skill tool adapter on shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.attachSkillToolAdapter({ getCoreSkillIds: () => [] });
    assert.ok(pb._skillToolAdapter);
    pb.shutdown();
    assert.equal(pb._skillToolAdapter, null);
  });

  it('should clear skill router on shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.attachSkillRouter({ getSkill: () => null });
    assert.ok(pb._skillRouter);
    pb.shutdown();
    assert.equal(pb._skillRouter, null);
  });

  it('should guard all public methods after shutdown', () => {
    const pb = new PromptBuilder(projectRoot);
    pb.shutdown();
    assert.throws(() => pb.buildSystemPrompt('x', {}));
    assert.throws(() => pb.buildStaticPrefix('x'));
    assert.throws(() => pb.buildDynamicSuffix({}));
    assert.throws(() => pb.getStaticPrefixHash('x'));
    assert.throws(() => pb.invalidateStaticPrefix('x'));
    assert.throws(() => pb.attachPatternExtractor({}));
    assert.throws(() => pb.attachSkillToolAdapter({}));
    assert.throws(() => pb.attachSkillRouter({}));
  });
});

// ─── Rules priority layers ─────────────────────────────────────────

describe('PromptBuilder – Rules priority layers', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should load rules from .harness/rules/ directory', () => {
    const rulesDir = path.join(projectRoot, '.harness', 'rules');
    fs.writeFileSync(path.join(rulesDir, 'style.md'), 'Use 2-space indentation.');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: true });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(prefix.includes('2-space indentation'));
    cleanup(pb);
  });

  it('should load CONVENTION.md as project-level rules', () => {
    fs.writeFileSync(path.join(projectRoot, '.harness', 'CONVENTION.md'), '## Coding\n\nAlways write tests first.');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: true });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(prefix.includes('Always write tests first'));
    cleanup(pb);
  });

  it('should include priority labels in rules output', () => {
    const rulesDir = path.join(projectRoot, '.harness', 'rules');
    fs.writeFileSync(path.join(rulesDir, 'style.md'), 'Use 2-space indentation.');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: true });
    const prefix = pb.buildStaticPrefix('test-agent');
    assert.ok(prefix.includes('project'));
    cleanup(pb);
  });

  it('should handle missing rules directory gracefully', () => {
    fs.rmSync(path.join(projectRoot, '.harness', 'rules'), { recursive: true, force: true });
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: true });
    const prefix = pb.buildStaticPrefix('test-agent');
    // Should still have primacy and recency emphasis
    assert.ok(prefix.includes('Core Directives'));
    assert.ok(prefix.includes('Reminder'));
    cleanup(pb);
  });

  it('should cache rules content for 60 seconds', () => {
    const rulesDir = path.join(projectRoot, '.harness', 'rules');
    fs.writeFileSync(path.join(rulesDir, 'style.md'), 'Version 1');
    const pb = new PromptBuilder(projectRoot, { includePersona: false, includeRules: true });
    pb.buildStaticPrefix('test-agent');
    // Modify file
    fs.writeFileSync(path.join(rulesDir, 'style.md'), 'Version 2');
    // Should still return cached version
    const rules1 = pb._loadRules();
    assert.ok(rules1.includes('Version 1'));
    cleanup(pb);
  });
});

// ─── Agent persona loading ─────────────────────────────────────────

describe('PromptBuilder – Agent persona loading', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should load agent persona from .harness/agents/{agentId}.md', () => {
    const agentDir = path.join(projectRoot, '.harness', 'agents');
    fs.writeFileSync(path.join(agentDir, 'coder.md'), 'You are an expert coder.');
    const pb = new PromptBuilder(projectRoot, { includePersona: true, includeRules: false });
    const prefix = pb.buildStaticPrefix('coder');
    assert.ok(prefix.includes('Agent Identity'));
    assert.ok(prefix.includes('expert coder'));
    cleanup(pb);
  });

  it('should handle missing agent file gracefully', () => {
    const pb = new PromptBuilder(projectRoot, { includePersona: true, includeRules: false });
    const prefix = pb.buildStaticPrefix('nonexistent-agent');
    // Should still have primacy and recency emphasis
    assert.ok(prefix.includes('Core Directives'));
    assert.ok(prefix.includes('Reminder'));
    cleanup(pb);
  });
});

// ─── Skill instructions loading ────────────────────────────────────

describe('PromptBuilder – Skill instructions loading', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('should load skill instructions from .harness/skills/{skillId}.md', () => {
    const skillsDir = path.join(projectRoot, '.harness', 'skills');
    fs.writeFileSync(path.join(skillsDir, 'tdd.md'), 'Write tests before code.');
    const pb = new PromptBuilder(projectRoot, { includeSkills: true });
    const suffix = pb.buildDynamicSuffix({ skillIds: ['tdd'] });
    assert.ok(suffix.includes('Skill Instructions'));
    assert.ok(suffix.includes('Write tests before code'));
    cleanup(pb);
  });

  it('should handle missing skill files gracefully', () => {
    const pb = new PromptBuilder(projectRoot, { includeSkills: true });
    const suffix = pb.buildDynamicSuffix({ skillIds: ['nonexistent-skill'] });
    assert.ok(!suffix.includes('Skill Instructions'));
    cleanup(pb);
  });

  it('should skip skill instructions when skillIds is empty', () => {
    const pb = new PromptBuilder(projectRoot, { includeSkills: true });
    const suffix = pb.buildDynamicSuffix({ skillIds: [] });
    assert.ok(!suffix.includes('Skill Instructions'));
    cleanup(pb);
  });
});
