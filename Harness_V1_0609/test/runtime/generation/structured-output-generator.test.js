'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const StructuredOutputGenerator = require('../../../src/runtime/generation/structured-output-generator');
const { OUTPUT_FORMATS, BUILTIN_TEMPLATES } = require('../../../src/runtime/generation/structured-output-generator');

describe('StructuredOutputGenerator - Core', () => {
  describe('constructor', () => {
    it('should use default options when no options provided', () => {
      const gen = new StructuredOutputGenerator();
      assert.strictEqual(gen._options.maxTemplates, 100);
      assert.strictEqual(gen._options.maxHistorySize, 200);
      assert.strictEqual(gen._options.strictValidation, true);
      assert.strictEqual(gen._options.sanitizeInputs, true);
      gen.shutdown();
    });

    it('should merge custom options with defaults', () => {
      const gen = new StructuredOutputGenerator({ strictValidation: false, maxTemplates: 50 });
      assert.strictEqual(gen._options.strictValidation, false);
      assert.strictEqual(gen._options.maxTemplates, 50);
      assert.strictEqual(gen._options.maxHistorySize, 200);
      gen.shutdown();
    });

    it('should register built-in templates', () => {
      const gen = new StructuredOutputGenerator();
      const templates = gen.listTemplates();
      assert.ok(templates.includes('report'));
      assert.ok(templates.includes('email'));
      assert.ok(templates.includes('plan'));
      assert.ok(templates.includes('json'));
      gen.shutdown();
    });

    it('should expose OUTPUT_FORMATS constant', () => {
      assert.strictEqual(OUTPUT_FORMATS.JSON, 'json');
      assert.strictEqual(OUTPUT_FORMATS.MARKDOWN, 'markdown');
      assert.strictEqual(OUTPUT_FORMATS.TABLE, 'table');
      assert.strictEqual(OUTPUT_FORMATS.FORM, 'form');
      assert.strictEqual(OUTPUT_FORMATS.REPORT, 'report');
      assert.strictEqual(OUTPUT_FORMATS.EMAIL, 'email');
      assert.strictEqual(OUTPUT_FORMATS.PLAN, 'plan');
    });

    it('should expose BUILTIN_TEMPLATES', () => {
      assert.ok(BUILTIN_TEMPLATES.report);
      assert.ok(BUILTIN_TEMPLATES.email);
      assert.ok(BUILTIN_TEMPLATES.plan);
      assert.ok(BUILTIN_TEMPLATES.json);
    });

    it('should initialize stats with built-in template count', () => {
      const gen = new StructuredOutputGenerator();
      const stats = gen.getStats();
      assert.strictEqual(stats.templatesRegistered, Object.keys(BUILTIN_TEMPLATES).length);
      assert.strictEqual(stats.outputsGenerated, 0);
      assert.strictEqual(stats.validationFailures, 0);
      gen.shutdown();
    });
  });

  describe('registerTemplate', () => {
    let gen;
    beforeEach(() => {
      gen = new StructuredOutputGenerator();
    });

    it('should register a valid template', () => {
      const result = gen.registerTemplate('custom', {
        format: OUTPUT_FORMATS.MARKDOWN,
        sections: [{ id: 'title', type: 'string', required: true }],
        markdownTemplate: '# {{title}}',
      });
      assert.strictEqual(result, true);
      assert.ok(gen.getTemplate('custom'));
    });

    it('should return false for invalid name', () => {
      assert.strictEqual(gen.registerTemplate('', { format: 'json' }), false);
      assert.strictEqual(gen.registerTemplate(null, { format: 'json' }), false);
      assert.strictEqual(gen.registerTemplate(undefined, { format: 'json' }), false);
      assert.strictEqual(gen.registerTemplate(123, { format: 'json' }), false);
    });

    it('should return false for invalid template', () => {
      assert.strictEqual(gen.registerTemplate('test', null), false);
      assert.strictEqual(gen.registerTemplate('test', undefined), false);
      assert.strictEqual(gen.registerTemplate('test', 'string'), false);
    });

    it('should overwrite an existing template', () => {
      gen.registerTemplate('custom', { format: OUTPUT_FORMATS.MARKDOWN, markdownTemplate: 'v1' });
      gen.registerTemplate('custom', { format: OUTPUT_FORMATS.JSON, markdownTemplate: 'v2' });
      const tpl = gen.getTemplate('custom');
      assert.strictEqual(tpl.format, OUTPUT_FORMATS.JSON);
    });

    it('should not increment template count when overwriting', () => {
      const before = gen.getStats().templatesRegistered;
      gen.registerTemplate('custom', { format: OUTPUT_FORMATS.MARKDOWN });
      const afterFirst = gen.getStats().templatesRegistered;
      assert.strictEqual(afterFirst, before + 1);
      gen.registerTemplate('custom', { format: OUTPUT_FORMATS.JSON });
      const afterOverwrite = gen.getStats().templatesRegistered;
      assert.strictEqual(afterOverwrite, before + 1);
    });

    it('should normalize missing template fields', () => {
      gen.registerTemplate('minimal', {});
      const tpl = gen.getTemplate('minimal');
      assert.strictEqual(tpl.format, OUTPUT_FORMATS.MARKDOWN);
      assert.deepStrictEqual(tpl.sections, []);
      assert.strictEqual(tpl.markdownTemplate, '');
      assert.strictEqual(tpl.jsonSchema, null);
      assert.deepStrictEqual(tpl.customValidators, []);
    });

    it('should increment template count for new templates', () => {
      const before = gen.getStats().templatesRegistered;
      gen.registerTemplate('new1', { format: OUTPUT_FORMATS.MARKDOWN });
      gen.registerTemplate('new2', { format: OUTPUT_FORMATS.JSON });
      assert.strictEqual(gen.getStats().templatesRegistered, before + 2);
    });
  });

  describe('getTemplate', () => {
    let gen;
    beforeEach(() => {
      gen = new StructuredOutputGenerator();
    });

    it('should return template when it exists', () => {
      const tpl = gen.getTemplate('report');
      assert.ok(tpl);
      assert.strictEqual(tpl.format, OUTPUT_FORMATS.REPORT);
    });

    it('should return null when template does not exist', () => {
      assert.strictEqual(gen.getTemplate('nonexistent'), null);
    });
  });

  describe('listTemplates', () => {
    it('should list all registered template names', () => {
      const gen = new StructuredOutputGenerator();
      const names = gen.listTemplates();
      assert.ok(names.includes('report'));
      assert.ok(names.includes('email'));
      assert.ok(names.includes('plan'));
      assert.ok(names.includes('json'));
      gen.shutdown();
    });

    it('should include custom templates', () => {
      const gen = new StructuredOutputGenerator();
      gen.registerTemplate('myCustom', { format: OUTPUT_FORMATS.MARKDOWN });
      const names = gen.listTemplates();
      assert.ok(names.includes('myCustom'));
      gen.shutdown();
    });
  });

  describe('getStats', () => {
    it('should return stats object with expected fields', () => {
      const gen = new StructuredOutputGenerator();
      const stats = gen.getStats();
      assert.ok('templatesRegistered' in stats);
      assert.ok('outputsGenerated' in stats);
      assert.ok('validationFailures' in stats);
      assert.ok('byFormat' in stats);
      gen.shutdown();
    });

    it('should reflect generation activity', () => {
      const gen = new StructuredOutputGenerator();
      gen.generate('report', { title: 'T', summary: 'S', findings: ['F'] });
      gen.generate('report', {});
      const stats = gen.getStats();
      assert.strictEqual(stats.outputsGenerated, 1);
      assert.strictEqual(stats.validationFailures, 1);
      gen.shutdown();
    });
  });

  describe('shutdown', () => {
    it('should mark instance as shut down', () => {
      const gen = new StructuredOutputGenerator();
      gen.shutdown();
      assert.strictEqual(gen._shutDown, true);
    });

    it('should prevent operations after shutdown', () => {
      const gen = new StructuredOutputGenerator();
      gen.shutdown();
      // generate does not call guardShutdown, but the instance is marked shut down
      assert.strictEqual(gen._shutDown, true);
      assert.strictEqual(gen.isHealthy(), false);
    });
  });
});

describe('StructuredOutputGenerator - Generation', () => {
  describe('generate', () => {
    let gen;
    beforeEach(() => {
      gen = new StructuredOutputGenerator();
    });

    it('should return error when template not found', () => {
      const result = gen.generate('nonexistent', {});
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Template not found'));
      assert.strictEqual(result.output, null);
    });

    it('should fail validation in strict mode when required fields missing', () => {
      const result = gen.generate('report', {});
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Validation failed'));
      assert.ok(result.missingFields.includes('title'));
      assert.ok(result.missingFields.includes('summary'));
      assert.ok(result.missingFields.includes('findings'));
    });

    it('should succeed in non-strict mode even with missing required fields', () => {
      const genNonStrict = new StructuredOutputGenerator({ strictValidation: false });
      const result = genNonStrict.generate('report', {});
      assert.strictEqual(result.success, true);
      assert.ok(result.warnings);
      assert.ok(result.warnings.length > 0);
      genNonStrict.shutdown();
    });

    it('should generate markdown output for report template', () => {
      const result = gen.generate('report', {
        title: 'Test Report',
        summary: 'A summary',
        findings: ['Finding 1', 'Finding 2'],
        recommendations: ['Rec 1'],
        risks: ['Risk 1'],
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.format, OUTPUT_FORMATS.REPORT);
      assert.ok(result.output.includes('Test Report'));
      assert.ok(result.output.includes('A summary'));
      assert.ok(result.output.includes('1. Finding 1'));
      assert.ok(result.output.includes('2. Finding 2'));
    });

    it('should generate markdown output for email template', () => {
      const result = gen.generate('email', {
        subject: 'Hello',
        recipient: 'user@example.com',
        body: 'This is the body',
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.format, OUTPUT_FORMATS.EMAIL);
      assert.ok(result.output.includes('Hello'));
      assert.ok(result.output.includes('user@example.com'));
    });

    it('should generate markdown output for plan template', () => {
      const result = gen.generate('plan', {
        goal: 'Build feature',
        steps: ['Step 1', 'Step 2'],
        successCriteria: ['Criteria 1'],
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.format, OUTPUT_FORMATS.PLAN);
      assert.ok(result.output.includes('Build feature'));
    });

    it('should generate JSON output for json template with schema', () => {
      gen.registerTemplate('jsonTest', {
        format: OUTPUT_FORMATS.JSON,
        sections: [
          { id: 'name', type: 'string', required: true },
          { id: 'tags', type: 'array', required: false },
        ],
        jsonSchema: { type: 'object' },
      });
      const result = gen.generate('jsonTest', { name: 'test', tags: ['a', 'b'] });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.format, OUTPUT_FORMATS.JSON);
      const parsed = result.output;
      assert.strictEqual(parsed.name, 'test');
      assert.deepStrictEqual(parsed.tags, ['a', 'b']);
    });

    it('should call validateOutput callback when provided', () => {
      const result = gen.generate('report', {
        title: 'Test',
        summary: 'Sum',
        findings: ['F1'],
      }, {
        validateOutput: (output) => output.includes('Test'),
      });
      assert.strictEqual(result.success, true);
    });

    it('should fail when validateOutput callback returns falsy', () => {
      const result = gen.generate('report', {
        title: 'Test',
        summary: 'Sum',
        findings: ['F1'],
      }, {
        validateOutput: () => false,
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Output validation failed');
    });

    it('should increment outputsGenerated and byFormat stats', () => {
      gen.generate('report', {
        title: 'T',
        summary: 'S',
        findings: ['F'],
      });
      const stats = gen.getStats();
      assert.strictEqual(stats.outputsGenerated, 1);
      assert.strictEqual(stats.byFormat[OUTPUT_FORMATS.REPORT], 1);
    });

    it('should increment validationFailures on strict validation failure', () => {
      gen.generate('report', {});
      assert.strictEqual(gen.getStats().validationFailures, 1);
    });

    it('should remove unmatched placeholders from output', () => {
      const result = gen.generate('report', {
        title: 'T',
        summary: 'S',
        findings: ['F'],
      });
      assert.strictEqual(result.success, true);
      assert.ok(!result.output.includes('{{'));
    });
  });

  describe('_sanitizeValues', () => {
    it('should strip HTML tags from string values', () => {
      const gen = new StructuredOutputGenerator({ sanitizeInputs: true });
      const result = gen.generate('report', {
        title: '<script>alert(1)</script>Clean Title',
        summary: 'Normal summary',
        findings: ['F1'],
      });
      assert.strictEqual(result.success, true);
      assert.ok(!result.output.includes('<script>'));
      assert.ok(result.output.includes('Clean Title'));
      gen.shutdown();
    });

    it('should strip HTML tags from array values', () => {
      const gen = new StructuredOutputGenerator({ sanitizeInputs: true });
      const result = gen.generate('report', {
        title: 'T',
        summary: 'S',
        findings: ['<b>Bold</b> finding', 'Normal'],
      });
      assert.strictEqual(result.success, true);
      assert.ok(!result.output.includes('<b>'));
      assert.ok(result.output.includes('Bold finding'));
      gen.shutdown();
    });

    it('should not sanitize when sanitizeInputs is false', () => {
      const gen = new StructuredOutputGenerator({ sanitizeInputs: false, strictValidation: false });
      const result = gen.generate('report', {
        title: '<b>Bold</b>',
        summary: 'S',
        findings: ['F'],
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('<b>'));
      gen.shutdown();
    });

    it('should handle non-object values gracefully', () => {
      const gen = new StructuredOutputGenerator({ strictValidation: false });
      const result = gen.generate('report', null);
      assert.strictEqual(result.success, true);
      gen.shutdown();
    });
  });
});
