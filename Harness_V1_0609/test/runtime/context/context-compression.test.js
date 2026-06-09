'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('ContextCompressionEngine', () => {
  const ContextCompressionEngine = require('../../../src/runtime/context/context-compression-engine');

  describe('compress()', () => {
    it('should retain current phase skill instructions', () => {
      const engine = new ContextCompressionEngine();
      const context = {
        currentPhase: 'module-development',
        skills: [
          { skill_id: 'tdd-implement', phase: 'module-development', instruction: 'TDD detailed instructions here that are very long and should be retained during compression because this is the current phase skill', summary: 'TDD驱动开发' },
          { skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'Brainstorming detailed instructions that should be compressed because this phase is already completed', summary: '头脑风暴' },
          { skill_id: 'architecture-design', phase: 'architecture-design', instruction: 'Architecture design detailed instructions that should also be compressed since this phase is done', summary: '架构设计' },
        ],
        completedSkills: ['brainstorming', 'architecture-design'],
        keyDecisions: ['Use microservices architecture', 'Choose PostgreSQL for persistence'],
        sessionState: { tokensUsed: 500000, budget: 1000000 },
      };

      const result = engine.compress(context);
      assert.ok(result);
      assert.ok(result.retainedSkills);
      assert.ok(result.retainedSkills.some(s => s.skill_id === 'tdd-implement'));
      assert.ok(result.compressedSkills);
    });

    it('should compress completed skills to summaries', () => {
      const engine = new ContextCompressionEngine();
      const context = {
        currentPhase: 'module-development',
        skills: [
          { skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'A'.repeat(500), summary: '头脑风暴' },
        ],
        completedSkills: ['brainstorming'],
        keyDecisions: [],
        sessionState: {},
      };

      const result = engine.compress(context);
      const compressed = result.compressedSkills.find(s => s.skill_id === 'brainstorming');
      assert.ok(compressed);
      assert.ok(compressed.compressed);
      assert.equal(compressed.summary, '头脑风暴');
    });

    it('should retain key decisions', () => {
      const engine = new ContextCompressionEngine();
      const context = {
        currentPhase: 'module-development',
        skills: [],
        completedSkills: [],
        keyDecisions: ['Decision 1', 'Decision 2'],
        sessionState: {},
      };

      const result = engine.compress(context);
      assert.deepEqual(result.keyDecisions, ['Decision 1', 'Decision 2']);
    });

    it('should estimate token savings', () => {
      const engine = new ContextCompressionEngine();
      const context = {
        currentPhase: 'module-development',
        skills: [
          { skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'A'.repeat(1000), summary: '头脑风暴' },
          { skill_id: 'tdd-implement', phase: 'module-development', instruction: 'B'.repeat(1000), summary: 'TDD' },
        ],
        completedSkills: ['brainstorming'],
        keyDecisions: [],
        sessionState: {},
      };

      const result = engine.compress(context);
      assert.ok(result.tokenSavings > 0);
      assert.ok(result.compressionRatio > 0);
    });
  });

  describe('shouldCompress()', () => {
    it('should recommend compression when threshold exceeded', () => {
      const engine = new ContextCompressionEngine({ threshold: 0.8 });
      const result = engine.shouldCompress({
        tokensUsed: 850000,
        tokenBudget: 1000000,
        currentPhase: 'module-development',
      });
      assert.equal(result, true);
    });

    it('should not recommend compression when below threshold', () => {
      const engine = new ContextCompressionEngine({ threshold: 0.8 });
      const result = engine.shouldCompress({
        tokensUsed: 500000,
        tokenBudget: 1000000,
        currentPhase: 'module-development',
      });
      assert.equal(result, false);
    });
  });

  describe('getCompressionPlan()', () => {
    it('should generate a compression plan', () => {
      const engine = new ContextCompressionEngine();
      const plan = engine.getCompressionPlan({
        currentPhase: 'module-development',
        skills: [
          { skill_id: 'brainstorming', phase: 'brainstorming', instruction: 'x'.repeat(500), summary: '头脑风暴' },
          { skill_id: 'tdd-implement', phase: 'module-development', instruction: 'y'.repeat(500), summary: 'TDD' },
        ],
        completedSkills: ['brainstorming'],
      });

      assert.ok(plan);
      assert.ok(plan.retain);
      assert.ok(plan.compress);
      assert.ok(plan.estimatedSavings > 0);
    });
  });

  describe('strategies', () => {
    it('should return default strategies', () => {
      const engine = new ContextCompressionEngine();
      const strats = engine.getStrategies();
      assert.ok(strats);
      assert.equal(strats.current_phase, 'full');
      assert.equal(strats.completed_phase, 'summary');
      assert.equal(strats.future_phase, 'summary');
      assert.equal(strats.unclassified, 'full');
    });

    it('should set strategy', () => {
      const engine = new ContextCompressionEngine();
      const result = engine.setStrategy('completed_phase', 'discard');
      assert.equal(result, true);
      assert.equal(engine.getStrategies().completed_phase, 'discard');
    });

    it('should reject invalid strategy', () => {
      const engine = new ContextCompressionEngine({ strategies: { completed_phase: 'summary' } });
      const result = engine.setStrategy('completed_phase', 'invalid');
      assert.equal(result, false);
      assert.equal(engine.getStrategies().completed_phase, 'summary');
    });

    it('should reject invalid category', () => {
      const engine = new ContextCompressionEngine({ strategies: { completed_phase: 'summary', current_phase: 'full', future_phase: 'summary', unclassified: 'full' } });
      const result = engine.setStrategy('nonexistent', 'full');
      assert.equal(result, false);
    });

    it('should accept custom strategies in constructor', () => {
      const engine = new ContextCompressionEngine({
        strategies: { completed_phase: 'discard', future_phase: 'discard' },
      });
      const strats = engine.getStrategies();
      assert.equal(strats.completed_phase, 'discard');
      assert.equal(strats.future_phase, 'discard');
      assert.equal(strats.current_phase, 'full');
    });

    it('should return config', () => {
      const engine = new ContextCompressionEngine({ threshold: 0.9 });
      const config = engine.getConfig();
      assert.equal(config.threshold, 0.9);
    });
  });
});

describe('ContextCompressionEngine - compressOutput()', () => {
  const ContextCompressionEngine = require('../../../src/runtime/context/context-compression-engine');

  it('should strip filler phrases', () => {
    const engine = new ContextCompressionEngine();
    const input = 'Sure, let me explain this to you. The code works as follows.';
    const result = engine.compressOutput(input);
    assert.ok(!result.startsWith('Sure'));
    assert.ok(result.includes('The code works'));
  });

  it('should strip summary filler phrases', () => {
    const engine = new ContextCompressionEngine();
    const input = 'In summary, the architecture uses microservices.';
    const result = engine.compressOutput(input, { stripFiller: true });
    assert.ok(!result.startsWith('In summary'));
    assert.ok(result.includes('microservices'));
  });

  it('should preserve short code blocks', () => {
    const engine = new ContextCompressionEngine();
    const input = '```js\nconst x = 1;\nconst y = 2;\n```';
    const result = engine.compressOutput(input, { stripRedundant: true });
    assert.ok(result.includes('const x = 1'));
  });

  it('should truncate long output', () => {
    const engine = new ContextCompressionEngine();
    const input = 'A'.repeat(5000);
    const result = engine.compressOutput(input, { maxLength: 1000 });
    assert.ok(result.length <= 1010);
  });

  it('should return non-string input unchanged', () => {
    const engine = new ContextCompressionEngine();
    assert.equal(engine.compressOutput(null), null);
    assert.equal(engine.compressOutput(undefined), undefined);
    assert.equal(engine.compressOutput(''), '');
  });

  it('should track output compression stats', () => {
    const engine = new ContextCompressionEngine();
    const input = 'Sure, let me help you with this. ' + 'A'.repeat(3000);
    engine.compressOutput(input, { maxLength: 500 });
    const stats = engine.getStats();
    assert.ok(stats.outputCompressions >= 1);
    assert.ok(stats.outputTokensSaved > 0);
  });

  it('should respect stripFiller false option', () => {
    const engine = new ContextCompressionEngine();
    const input = 'Sure, the answer is 42.';
    const result = engine.compressOutput(input, { stripFiller: false });
    assert.ok(result.startsWith('Sure'));
  });
});

describe('ContextCompressionEngine - compressToolOutput()', () => {
  const ContextCompressionEngine = require('../../../src/runtime/context/context-compression-engine');

  it('should group repeating lines', () => {
    const engine = new ContextCompressionEngine();
    const input = 'line1\nline1\nline1\nline1\nunique';
    const result = engine.compressToolOutput(input, { groupThreshold: 3, maxLines: 100, filterPatterns: [] });
    assert.ok(result.includes('(x4)') || result.includes('line1'));
    assert.ok(result.includes('unique'));
  });

  it('should limit line count', () => {
    const engine = new ContextCompressionEngine();
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push('line ' + i);
    const input = lines.join('\n');
    const result = engine.compressToolOutput(input, { maxLines: 10, groupThreshold: 100, filterPatterns: [] });
    assert.ok(result.includes('lines omitted'));
  });

  it('should filter lines by pattern', () => {
    const engine = new ContextCompressionEngine();
    const input = 'warning: something\nerror: bad\ninfo: good\nwarning: other';
    const result = engine.compressToolOutput(input, { maxLines: 50, groupThreshold: 100, filterPatterns: ['^warning:'] });
    assert.ok(!result.includes('warning:'));
    assert.ok(result.includes('error:'));
    assert.ok(result.includes('info:'));
  });

  it('should compress object output with long arrays', () => {
    const engine = new ContextCompressionEngine();
    const input = Array.from({ length: 20 }, (_, i) => i);
    const result = engine.compressToolOutput(input, { maxLines: 50, groupThreshold: 100, filterPatterns: [], preserveKeys: [] });
    assert.ok(Array.isArray(result));
    assert.ok(result.length < 20);
    assert.ok(result.some(r => typeof r === 'string' && r.includes('omitted')));
  });

  it('should compress object output with long string values', () => {
    const engine = new ContextCompressionEngine();
    const input = { short: 'ok', long: 'x'.repeat(1000) };
    const result = engine.compressToolOutput(input, { maxLines: 50, groupThreshold: 100, filterPatterns: [], preserveKeys: [] });
    assert.equal(result.short, 'ok');
    assert.ok(typeof result.long === 'string');
    assert.ok(result.long.length < 1000);
    assert.ok(result.long.includes('omitted'));
  });

  it('should preserve keys listed in preserveKeys', () => {
    const engine = new ContextCompressionEngine();
    const input = { important: 'x'.repeat(1000), other: 'y'.repeat(1000) };
    const result = engine.compressToolOutput(input, { maxLines: 50, groupThreshold: 100, filterPatterns: [], preserveKeys: ['important'] });
    assert.equal(result.important, 'x'.repeat(1000));
    assert.ok(result.other.length < 1000);
  });

  it('should return non-string non-object output unchanged', () => {
    const engine = new ContextCompressionEngine();
    assert.equal(engine.compressToolOutput(42), 42);
    assert.equal(engine.compressToolOutput(null), null);
  });
});

describe('ContextCompressionEngine regression: summary larger than original fallback', () => {
  const ContextCompressionEngine = require('../../../src/runtime/context/context-compression-engine');

  it('should fall back to full strategy when summary is larger than instruction', () => {
    const engine = new ContextCompressionEngine({
      strategies: { completed_phase: 'summary', future_phase: 'summary', current_phase: 'full', unclassified: 'full' },
    });
    const shortInstruction = 'abc';
    const longSummary = 'This is a very long summary that is definitely longer than the short instruction text above';
    const context = {
      currentPhase: 'module-development',
      skills: [
        { skill_id: 'tiny-skill', phase: 'brainstorming', instruction: shortInstruction, summary: longSummary },
      ],
      completedSkills: ['tiny-skill'],
      keyDecisions: [],
      sessionState: {},
    };
    const result = engine.compress(context);
    const retained = result.retainedSkills.find(s => s.skill_id === 'tiny-skill');
    assert.ok(retained);
    assert.equal(retained.retained, true);
    assert.equal(retained.strategy, 'full');
  });
});
