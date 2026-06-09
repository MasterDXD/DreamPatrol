'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const nodePath = require('path');

const SKILLS_DIR = nodePath.join(__dirname, '../../.harness/skills');

describe('Codex Skills Fusion - v2.7.100', () => {
  describe('AI Service Safety Check Hook', () => {
    it('should detect hardcoded API keys', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const content = 'const apiKey = "sk-abcdefghijklmnopqrstuvwx";\nmodule.exports = apiKey;';
      const result = BUILTIN_HANDLERS.ai_service_safety_check({ content, file_path: 'test.js' });
      assert.equal(result.passed, false, 'Should detect hardcoded API key');
      assert.ok(result.details.violations.length > 0, 'Should have violations');
    });

    it('should detect Azure-style API keys', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const content = 'const key = "AIZASyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\nmodule.exports = key;';
      const result = BUILTIN_HANDLERS.ai_service_safety_check({ content, file_path: 'test.js' });
      assert.equal(result.passed, false, 'Should detect Azure-style API key');
    });

    it('should detect unbounded max_tokens', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const content = 'const response = await openai.chat.completions.create({ model: "gpt-4", max_tokens: 99999 });';
      const result = BUILTIN_HANDLERS.ai_service_safety_check({ content, file_path: 'test.js' });
      assert.equal(result.passed, false, 'Should detect unbounded max_tokens');
    });

    it('should pass for safe AI service code', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      const content = 'const apiKey = process.env.OPENAI_API_KEY;\nconst response = await openai.chat.completions.create({ model: "gpt-4", max_tokens: 1000, temperature: 0.7 });';
      const result = BUILTIN_HANDLERS.ai_service_safety_check({ content, file_path: 'test.js' });
      assert.equal(result.passed, true, 'Should pass for safe AI service code');
    });

    it('should handle empty or non-string content', () => {
      const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');
      assert.equal(BUILTIN_HANDLERS.ai_service_safety_check({ content: '' }).passed, true);
      assert.equal(BUILTIN_HANDLERS.ai_service_safety_check({ content: null }).passed, true);
      assert.equal(BUILTIN_HANDLERS.ai_service_safety_check({ content: undefined }).passed, true);
      assert.equal(BUILTIN_HANDLERS.ai_service_safety_check({}).passed, true);
    });
  });

  describe('Cloud AI Blueprint Skill Validation', () => {
    it('should have cloud-ai-blueprint skill file with required fields', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'cloud-ai-blueprint.md');
      assert.ok(fs.existsSync(skillPath), 'cloud-ai-blueprint.md should exist');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('skill_id: cloud-ai-blueprint'), 'Should have skill_id');
      assert.ok(content.includes('模型层'), 'Should have model layer');
      assert.ok(content.includes('工具层'), 'Should have tool layer');
      assert.ok(content.includes('数据流层'), 'Should have dataflow layer');
      assert.ok(content.includes('工作流层'), 'Should have workflow layer');
      assert.ok(content.includes('architecture-design'), 'Should belong to architecture-design phase');
    });

    it('should have 4-layer architecture model defined', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'cloud-ai-blueprint.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      const layerCount = ['模型层', '工具层', '数据流层', '工作流层'].filter(l => content.includes(l)).length;
      assert.equal(layerCount, 4, 'Should have all 4 layers defined');
    });

    it('should have blueprint document template', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'cloud-ai-blueprint.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('AI系统蓝图'), 'Should have blueprint document template');
      assert.ok(content.includes('安全边界'), 'Should have security boundary section');
      assert.ok(content.includes('成本预算'), 'Should have cost budget section');
    });
  });

  describe('Taste Skill - User Path Enhancement', () => {
    it('should have user path taste dimension in taste-skill.md', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'taste-skill.md');
      assert.ok(fs.existsSync(skillPath), 'taste-skill.md should exist');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('用户路径品味'), 'Should have user path taste dimension');
      assert.ok(content.includes('首屏重点'), 'Should have first-screen focus');
      assert.ok(content.includes('按钮层级'), 'Should have button hierarchy');
      assert.ok(content.includes('操作路径'), 'Should have operation path');
    });

    it('should have user path dimension in scoring table with 25% weight', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'taste-skill.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('用户路径') && content.includes('25%'), 'Should have user path with 25% weight');
    });

    it('should have user path criteria in acceptance standards', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'taste-skill.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('首屏核心价值主张'), 'Should have first-screen value proposition in acceptance');
      assert.ok(content.includes('核心任务操作路径不超过3步'), 'Should have 3-step max in acceptance');
    });
  });

  describe('Deployment Skill - 3-Step Flow Enhancement', () => {
    it('should have 3-step deployment flow in deployment.md', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'deployment.md');
      assert.ok(fs.existsSync(skillPath), 'deployment.md should exist');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('3步部署流程'), 'Should have 3-step deployment flow');
      assert.ok(content.includes('准备（Prepare）'), 'Should have Prepare step');
      assert.ok(content.includes('验证（Validate）'), 'Should have Validate step');
      assert.ok(content.includes('部署（Deploy）'), 'Should have Deploy step');
    });

    it('should have failure handling for each step', () => {
      const skillPath = nodePath.join(SKILLS_DIR, 'deployment.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.includes('准备未通过'), 'Should have Prepare failure handling');
      assert.ok(content.includes('验证未通过'), 'Should have Validate failure handling');
      assert.ok(content.includes('部署失败'), 'Should have Deploy failure handling');
    });
  });
});
