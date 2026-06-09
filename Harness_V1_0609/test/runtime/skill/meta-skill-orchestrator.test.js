'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('MetaSkillOrchestrator - template generation', () => {
  const MetaSkillOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'skill', 'meta-skill-orchestrator'));

  it('should have available templates', () => {
    const templates = MetaSkillOrchestrator.AVAILABLE_TEMPLATES;
    assert.ok(Array.isArray(templates));
    assert.ok(templates.includes('standard-pipeline'));
    assert.ok(templates.includes('quality-assurance'));
    assert.ok(templates.includes('research-driven'));
  });

  it('should generate from standard-pipeline template', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.generateFromTemplate('standard-pipeline', {
      name: 'Test Pipeline',
      availableSkills: ['requirement-analysis', 'architecture-design', 'tdd-implement', 'integration-testing', 'deployment'],
    });
    assert.ok(result.success, result.error);
    assert.ok(result.definition);
    assert.strictEqual(result.definition.name, 'Test Pipeline');
    assert.ok(result.definition.phases.length >= 4);
    mso.shutdown();
  });

  it('should generate from quality-assurance template', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.generateFromTemplate('quality-assurance', {
      availableSkills: ['code-review', 'security-audit', 'systematic-debugging', 'bug-fix', 'verification-before-completion'],
    });
    assert.ok(result.success, result.error);
    assert.ok(result.definition);
    assert.ok(result.definition.phases.length >= 3);
    mso.shutdown();
  });

  it('should generate from research-driven template', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.generateFromTemplate('research-driven', {
      availableSkills: ['brainstorming', 'ai-research', 'requirement-analysis', 'architecture-design'],
    });
    assert.ok(result.success, result.error);
    assert.ok(result.definition);
    assert.ok(result.definition.phases.length >= 3);
    mso.shutdown();
  });

  it('should handle unknown template', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.generateFromTemplate('nonexistent', {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unknown template'));
    mso.shutdown();
  });

  it('should handle empty template name', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.generateFromTemplate('', {});
    assert.strictEqual(result.success, false);
    mso.shutdown();
  });

  it('should emit meta-skill-generated event on template generation', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    let emitted = false;
    mso.on('meta-skill-generated', (_data) => { emitted = true; });
    mso.generateFromTemplate('standard-pipeline', {
      availableSkills: ['requirement-analysis', 'tdd-implement'],
    });
    assert.ok(emitted);
    mso.shutdown();
  });

  it('should handle template with no matching skills', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.generateFromTemplate('standard-pipeline', {
      availableSkills: ['unknown-skill'],
    });
    assert.ok(result.success);
    assert.ok(result.definition);
    // Should fall back to a default phase
    assert.ok(result.definition.phases.length > 0);
    mso.shutdown();
  });

  it('should get available templates', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const templates = mso.getAvailableTemplates();
    assert.strictEqual(templates.length, 3);
    assert.ok(templates.includes('standard-pipeline'));
    mso.shutdown();
  });
});

describe('MetaSkillOrchestrator - auto registration', () => {
  const MetaSkillOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'skill', 'meta-skill-orchestrator'));

  it('should auto-register a valid generated definition', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const genResult = mso.generateFromTemplate('standard-pipeline', {
      name: 'Auto Register Test',
      availableSkills: ['requirement-analysis', 'tdd-implement'],
    });
    assert.ok(genResult.success);

    const regResult = mso.autoRegisterGenerated(genResult.definition);
    assert.ok(regResult.success, regResult.error);
    assert.ok(regResult.metaSkillId);

    // Verify it's registered
    const registered = mso.getMetaSkill(regResult.metaSkillId);
    assert.ok(registered);
    assert.strictEqual(registered.name, 'Auto Register Test');
    mso.shutdown();
  });

  it('should reject invalid definition', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.autoRegisterGenerated({ invalid: true });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    mso.shutdown();
  });

  it('should reject null definition', () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const result = mso.autoRegisterGenerated(null);
    assert.strictEqual(result.success, false);
    mso.shutdown();
  });
});

describe('MetaSkillOrchestrator - async generation', () => {
  const MetaSkillOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'skill', 'meta-skill-orchestrator'));

  it('should generate via LLM handler returning JSON string', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const mockLLM = async (_prompt) => {
      return JSON.stringify({
        id: 'meta-test-llm',
        name: 'Test LLM Generated',
        description: 'Generated by test LLM',
        phases: [
          { phase: 'analyze', skills: ['requirement-analysis'], onFailure: 'stop' },
          { phase: 'implement', skills: ['tdd-implement'], onFailure: 'retry' },
        ],
        estimatedTokens: 10000,
      });
    };

    const result = await mso.generateMetaSkillAsync(
      'build a test feature',
      ['requirement-analysis', 'tdd-implement'],
      mockLLM,
    );
    assert.ok(result.success, result.error);
    assert.ok(result.definition);
    assert.strictEqual(result.definition.name, 'Test LLM Generated');
    assert.ok(result.requestId);
    mso.shutdown();
  });

  it('should generate via LLM handler returning JSON object', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const mockLLM = async () => ({
      id: 'meta-test-obj',
      name: 'Object Generated',
      description: 'From object',
      phases: [
        { phase: 'test', skills: ['code-review'], onFailure: 'skip' },
      ],
    });

    const result = await mso.generateMetaSkillAsync('test', ['code-review'], mockLLM);
    assert.ok(result.success, result.error);
    assert.strictEqual(result.definition.name, 'Object Generated');
    mso.shutdown();
  });

  it('should extract JSON from text response', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const mockLLM = async () => 'Here is the definition:\n```json\n{"id":"meta-extracted","name":"Extracted","description":"test","phases":[{"phase":"a","skills":["code-review"],"onFailure":"stop"}]}\n```';

    const result = await mso.generateMetaSkillAsync('test', ['code-review'], mockLLM);
    assert.ok(result.success, result.error);
    assert.strictEqual(result.definition.name, 'Extracted');
    mso.shutdown();
  });

  it('should fail on invalid LLM-handler generated definition', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const mockLLM = async () => JSON.stringify({ id: 'bad', name: 'Bad' }); // missing phases

    const result = await mso.generateMetaSkillAsync('test', ['code-review'], mockLLM);
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    mso.shutdown();
  });

  it('should fail on non-JSON LLM response', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    const mockLLM = async () => 'This is just plain text with no JSON';

    const result = await mso.generateMetaSkillAsync('test', ['code-review'], mockLLM);
    assert.strictEqual(result.success, false);
    mso.shutdown();
  });

  it('should throw on invalid llmHandler', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    await assert.rejects(
      () => mso.generateMetaSkillAsync('test', ['code-review'], 'not-a-function'),
      /llmHandler must be a function/,
    );
    mso.shutdown();
  });

  it('should emit meta-skill-generated event on async generation', async () => {
    const mso = new MetaSkillOrchestrator({ includePresets: false });
    let emitted = false;
    mso.on('meta-skill-generated', () => { emitted = true; });

    const mockLLM = async () => JSON.stringify({
      id: 'meta-event-test',
      name: 'Event Test',
      phases: [{ phase: 'a', skills: ['code-review'], onFailure: 'stop' }],
    });

    await mso.generateMetaSkillAsync('test', ['code-review'], mockLLM);
    assert.ok(emitted);
    mso.shutdown();
  });
});
