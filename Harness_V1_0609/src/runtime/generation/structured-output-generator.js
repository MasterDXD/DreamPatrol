'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');

const OUTPUT_FORMATS = {
  JSON: 'json',
  MARKDOWN: 'markdown',
  TABLE: 'table',
  FORM: 'form',
  REPORT: 'report',
  EMAIL: 'email',
  PLAN: 'plan',
};

const BUILTIN_TEMPLATES = {
  report: {
    format: OUTPUT_FORMATS.REPORT,
    sections: [
      { id: 'title', type: 'string', required: true, placeholder: '{{title}}' },
      { id: 'summary', type: 'string', required: true, placeholder: '{{summary}}' },
      { id: 'findings', type: 'array', required: true, placeholder: '{{findings}}' },
      { id: 'recommendations', type: 'array', required: false, placeholder: '{{recommendations}}' },
      { id: 'risks', type: 'array', required: false, placeholder: '{{risks}}' },
    ],
    markdownTemplate: '# {{title}}\n\n## Summary\n{{summary}}\n\n## Findings\n{{findings}}\n\n## Recommendations\n{{recommendations}}\n\n## Risks\n{{risks}}',
  },
  email: {
    format: OUTPUT_FORMATS.EMAIL,
    sections: [
      { id: 'subject', type: 'string', required: true, placeholder: '{{subject}}' },
      { id: 'recipient', type: 'string', required: true, placeholder: '{{recipient}}' },
      { id: 'body', type: 'string', required: true, placeholder: '{{body}}' },
      { id: 'callToAction', type: 'string', required: false, placeholder: '{{callToAction}}' },
    ],
    markdownTemplate: 'Subject: {{subject}}\nTo: {{recipient}}\n\n{{body}}\n\n{{callToAction}}',
  },
  plan: {
    format: OUTPUT_FORMATS.PLAN,
    sections: [
      { id: 'goal', type: 'string', required: true, placeholder: '{{goal}}' },
      { id: 'steps', type: 'array', required: true, placeholder: '{{steps}}' },
      { id: 'timeline', type: 'string', required: false, placeholder: '{{timeline}}' },
      { id: 'resources', type: 'array', required: false, placeholder: '{{resources}}' },
      { id: 'successCriteria', type: 'array', required: true, placeholder: '{{successCriteria}}' },
    ],
    markdownTemplate: '# Plan: {{goal}}\n\n## Steps\n{{steps}}\n\n## Timeline\n{{timeline}}\n\n## Resources\n{{resources}}\n\n## Success Criteria\n{{successCriteria}}',
  },
  json: {
    format: OUTPUT_FORMATS.JSON,
    sections: [],
    markdownTemplate: '',
  },
};

const DEFAULT_OPTIONS = {
  maxTemplates: 100,
  maxHistorySize: 200,
  strictValidation: true,
  sanitizeInputs: true,
};

class StructuredOutputGenerator {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._templates = new BoundedMap(this._options.maxTemplates);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      templatesRegistered: 0,
      outputsGenerated: 0,
      validationFailures: 0,
      byFormat: {},
    };
    for (const [name, template] of Object.entries(BUILTIN_TEMPLATES)) {
      this._templates.set(name, template);
      this._stats.templatesRegistered++;
    }
  }

  registerTemplate(name, template) {
    if (!name || typeof name !== 'string') return false;
    if (!template || typeof template !== 'object') return false;
    const normalized = {
      format: template.format ?? OUTPUT_FORMATS.MARKDOWN,
      sections: Array.isArray(template.sections) ? template.sections : [],
      markdownTemplate: template.markdownTemplate ?? '',
      jsonSchema: template.jsonSchema ?? null,
      customValidators: template.customValidators ?? [],
    };
    const isNew = !this._templates.has(name);
    this._templates.set(name, normalized);
    if (isNew) this._stats.templatesRegistered++;
    return true;
  }

  generate(templateName, values, options) {
    const opts = options ?? {};
    const template = this._templates.get(templateName);
    if (!template) {
      return { success: false, error: 'Template not found: ' + templateName, output: null };
    }
    const sanitizedValues = this._options.sanitizeInputs ? this._sanitizeValues(values) : values;
    const validation = this._validateInputs(template, sanitizedValues);
    if (!validation.valid && this._options.strictValidation) {
      this._stats.validationFailures++;
      return { success: false, error: 'Validation failed: ' + validation.errors.join('; '), output: null, missingFields: validation.missing };
    }
    let output;
    if (template.format === OUTPUT_FORMATS.JSON && template.jsonSchema) {
      output = this._generateJson(template, sanitizedValues);
    } else {
      output = this._generateMarkdown(template, sanitizedValues);
    }
    const result = {
      success: true,
      output,
      format: template.format,
      templateName,
      warnings: validation.errors.length > 0 ? validation.errors : undefined,
    };
    this._stats.outputsGenerated++;
    this._stats.byFormat[template.format] = (this._stats.byFormat[template.format] ?? 0) + 1;
    this._history.push({
      templateName,
      format: template.format,
      timestamp: Date.now(),
      valid: validation.valid,
    });
    if (opts.validateOutput && typeof opts.validateOutput === 'function') {
      const outputValidation = safeExecute(() => opts.validateOutput(output));
      if (!outputValidation) {
        return { success: false, error: 'Output validation failed', output, templateName };
      }
    }
    return result;
  }

  _validateInputs(template, values) {
    const errors = [];
    const missing = [];
    if (!Array.isArray(template.sections)) return { valid: true, errors: [], missing: [] };
    for (const section of template.sections) {
      if (section.required && (!values || values[section.id] == null || values[section.id] === '')) {
        errors.push('Missing required field: ' + section.id);
        missing.push(section.id);
      }
    }
    return { valid: errors.length === 0, errors, missing };
  }

  _sanitizeValues(values) {
    if (!values || typeof values !== 'object') return {};
    const sanitized = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string') {
        sanitized[key] = value.replace(/<[^>]*>/g, '');
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map(v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '') : v);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  _generateMarkdown(template, values) {
    let output = template.markdownTemplate ?? '';
    for (const [key, value] of Object.entries(values ?? {})) {
      const placeholder = '{{' + key + '}}';
      const replacement = Array.isArray(value) ? value.map((v, i) => (i + 1) + '. ' + String(v)).join('\n') : String(value ?? '');
      output = output.split(placeholder).join(replacement);
    }
    output = output.replace(/\{\{[^}]+\}\}/g, '');
    return output.trim();
  }

  _generateJson(template, values) {
    const result = {};
    for (const section of template.sections) {
      if (values && values[section.id] != null) {
        result[section.id] = values[section.id];
      } else if (!section.required) {
        result[section.id] = section.type === 'array' ? [] : section.type === 'string' ? '' : null;
      }
    }
    return result;
  }

  getTemplate(name) {
    const t = this._templates.get(name); return t ? JSON.parse(JSON.stringify(t)) : null;
  }

  listTemplates() {
    const names = [];
    for (const [name] of this._templates) {
      names.push(name);
    }
    return names;
  }

  getStats() {
    return {
      templatesRegistered: this._stats.templatesRegistered,
      outputsGenerated: this._stats.outputsGenerated,
      validationFailures: this._stats.validationFailures,
      byFormat: Object.assign({}, this._stats.byFormat),
    };
  }

  _onShutdown() {
    this._templates.shutdown();
    this._history.shutdown();
  }
}

module.exports = withShutdown(StructuredOutputGenerator);
module.exports.OUTPUT_FORMATS = OUTPUT_FORMATS;
module.exports.BUILTIN_TEMPLATES = BUILTIN_TEMPLATES;
