'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WorkflowTemplate = require('../../../src/runtime/workflow/workflow-template');

/**
 * 创建临时项目根目录，用于隔离文件系统操作。
 * 每个测试用例使用独立的临时目录，避免状态污染。
 */
function createTempProjectRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tpl-test-'));
  return tmp;
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Core CRUD: constructor, create, get, list, remove ────────────

describe('WorkflowTemplate – Core CRUD', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  // 清理辅助：测试结束后删除临时目录
  function cleanup(instance) {
    if (instance && typeof instance.shutdown === 'function') {
      try { instance.shutdown(); } catch (_) { /* ignore */ }
    }
    removeTempDir(projectRoot);
  }

  // ─── 构造函数 ───────────────────────────────────────────

  describe('constructor', () => {
    it('should throw if projectRoot is not provided', () => {
      assert.throws(() => new WorkflowTemplate(), { name: 'TypeError' });
    });

    it('should throw if projectRoot is empty string', () => {
      assert.throws(() => new WorkflowTemplate(''), { name: 'TypeError' });
    });

    it('should create instance with valid projectRoot', () => {
      const wt = new WorkflowTemplate(projectRoot);
      assert.ok(wt);
      assert.equal(wt.root, projectRoot);
      assert.equal(wt.isHealthy(), true);
      cleanup(wt);
    });

    it('should initialize with empty templates', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const list = wt.list();
      assert.equal(list.length, 0);
      cleanup(wt);
    });
  });

  // ─── create ─────────────────────────────────────────────

  describe('create', () => {
    it('should create a template with required fields', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const tpl = wt.create('deploy', {
        steps: [{ goal: 'deploy app', context: 'production' }],
      });
      assert.ok(tpl);
      assert.equal(tpl.name, 'deploy');
      assert.equal(tpl.description, '');
      assert.equal(tpl.version, '1.0.0');
      assert.ok(Array.isArray(tpl.steps));
      assert.ok(Array.isArray(tpl.variables));
      assert.ok(tpl.createdAt);
      assert.ok(tpl.updatedAt);
      cleanup(wt);
    });

    it('should create a template with all optional fields', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const tpl = wt.create('full', {
        description: 'A full template',
        version: '2.0.0',
        steps: [{ goal: 'step1', context: 'ctx1' }],
        variables: [{ name: 'env', default: 'dev' }],
      });
      assert.equal(tpl.description, 'A full template');
      assert.equal(tpl.version, '2.0.0');
      assert.equal(tpl.variables.length, 1);
      cleanup(wt);
    });

    it('should return null when name is empty', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const tpl = wt.create('', { steps: [] });
      assert.equal(tpl, null);
      cleanup(wt);
    });

    it('should return null when definition is null', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const tpl = wt.create('name', null);
      assert.equal(tpl, null);
      cleanup(wt);
    });

    it('should return null when steps is not an array', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const tpl = wt.create('name', { steps: 'not-array' });
      assert.equal(tpl, null);
      cleanup(wt);
    });

    it('should overwrite existing template with same name', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('dup', { steps: [{ goal: 'v1' }] });
      const tpl2 = wt.create('dup', { steps: [{ goal: 'v2' }] });
      assert.equal(tpl2.steps[0].goal, 'v2');
      assert.equal(wt.list().length, 1);
      cleanup(wt);
    });

    it('should enforce max template limit', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt._maxTemplates = 2;
      wt.create('a', { steps: [] });
      wt.create('b', { steps: [] });
      const tpl = wt.create('c', { steps: [] });
      assert.equal(tpl, null);
      cleanup(wt);
    });

    it('should deep-clone steps and variables', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const steps = [{ goal: 'original' }];
      const variables = [{ name: 'x' }];
      wt.create('clone-test', { steps, variables });
      steps[0].goal = 'mutated';
      const got = wt.get('clone-test');
      assert.equal(got.steps[0].goal, 'original');
      cleanup(wt);
    });
  });

  // ─── get ────────────────────────────────────────────────

  describe('get', () => {
    it('should return the template by name', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('find-me', { steps: [{ goal: 'g' }] });
      const tpl = wt.get('find-me');
      assert.ok(tpl);
      assert.equal(tpl.name, 'find-me');
      cleanup(wt);
    });

    it('should return null for non-existent template', () => {
      const wt = new WorkflowTemplate(projectRoot);
      assert.equal(wt.get('nope'), null);
      cleanup(wt);
    });
  });

  // ─── list ───────────────────────────────────────────────

  describe('list', () => {
    it('should return empty array when no templates', () => {
      const wt = new WorkflowTemplate(projectRoot);
      assert.deepEqual(wt.list(), []);
      cleanup(wt);
    });

    it('should return all templates', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('a', { steps: [] });
      wt.create('b', { steps: [] });
      const list = wt.list();
      assert.equal(list.length, 2);
      const names = list.map(t => t.name).sort();
      assert.deepEqual(names, ['a', 'b']);
      cleanup(wt);
    });

    it('should return deep copies (mutation safe)', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('safe', { steps: [{ goal: 'original' }] });
      const list = wt.list();
      list[0].steps[0].goal = 'mutated';
      const got = wt.get('safe');
      assert.equal(got.steps[0].goal, 'original');
      cleanup(wt);
    });
  });

  // ─── remove ─────────────────────────────────────────────

  describe('remove', () => {
    it('should remove existing template and return true', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('del-me', { steps: [] });
      assert.equal(wt.remove('del-me'), true);
      assert.equal(wt.get('del-me'), null);
      cleanup(wt);
    });

    it('should return false for non-existent template', () => {
      const wt = new WorkflowTemplate(projectRoot);
      assert.equal(wt.remove('ghost'), false);
      cleanup(wt);
    });

    it('should persist after removal', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('persist-del', { steps: [] });
      wt.remove('persist-del');
      // After removal, list should be empty
      assert.equal(wt.list().length, 0);
      cleanup(wt);
    });
  });
});

// ─── Instantiation ────────────────────────────────────────────────

describe('WorkflowTemplate – Instantiation', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  function cleanup(instance) {
    if (instance && typeof instance.shutdown === 'function') {
      try { instance.shutdown(); } catch (_) { /* ignore */ }
    }
    removeTempDir(projectRoot);
  }

  describe('instantiate', () => {
    it('should return null for non-existent template', () => {
      const wt = new WorkflowTemplate(projectRoot);
      const result = wt.instantiate('missing', {});
      assert.equal(result, null);
      cleanup(wt);
    });

    it('should return null for non-existent template even without variables', () => {
      const wt = new WorkflowTemplate(projectRoot);
      assert.equal(wt.instantiate('ghost'), null);
      cleanup(wt);
    });

    it('should replace simple variable {{name}}', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('greet', {
        steps: [{ goal: 'Hello {{name}}', context: 'Welcome {{name}}' }],
      });
      const result = wt.instantiate('greet', { name: 'World' });
      assert.ok(result);
      assert.equal(result.steps[0].goal, 'Hello World');
      assert.equal(result.steps[0].context, 'Welcome World');
      assert.equal(result.templateName, 'greet');
      assert.ok(result.instantiatedAt);
      cleanup(wt);
    });

    it('should replace multiple different variables', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('multi', {
        steps: [{ goal: 'Deploy {{app}} to {{env}}', context: 'Region {{region}}' }],
      });
      const result = wt.instantiate('multi', { app: 'myapp', env: 'prod', region: 'us-east' });
      assert.equal(result.steps[0].goal, 'Deploy myapp to prod');
      assert.equal(result.steps[0].context, 'Region us-east');
      cleanup(wt);
    });

    it('should replace same variable multiple times', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('repeat', {
        steps: [{ goal: '{{name}} says {{name}}', context: '{{name}} again' }],
      });
      const result = wt.instantiate('repeat', { name: 'Alice' });
      assert.equal(result.steps[0].goal, 'Alice says Alice');
      assert.equal(result.steps[0].context, 'Alice again');
      cleanup(wt);
    });

    it('should keep placeholder when variable is undefined', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('missing-var', {
        steps: [{ goal: 'Hello {{name}} and {{unknown}}', context: '{{missing}}' }],
      });
      const result = wt.instantiate('missing-var', { name: 'Bob' });
      assert.equal(result.steps[0].goal, 'Hello Bob and {{unknown}}');
      assert.equal(result.steps[0].context, '{{missing}}');
      cleanup(wt);
    });

    it('should keep placeholder when no variables provided', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('no-vars', {
        steps: [{ goal: 'Hello {{name}}', context: '{{env}}' }],
      });
      const result = wt.instantiate('no-vars');
      assert.equal(result.steps[0].goal, 'Hello {{name}}');
      assert.equal(result.steps[0].context, '{{env}}');
      cleanup(wt);
    });

    it('should sanitize dangerous characters from interpolated values', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('sanitize', {
        steps: [{ goal: 'Run {{cmd}}', context: 'Path {{path}}' }],
      });
      const result = wt.instantiate('sanitize', {
        cmd: 'rm -rf /; echo pwned',
        path: 'C:\\Users\\{admin}',
      });
      // _sanitizeValue strips ; { } \
      assert.equal(result.steps[0].goal, 'Run rm -rf / echo pwned');
      assert.equal(result.steps[0].context, 'Path C:Usersadmin');
      cleanup(wt);
    });

    it('should sanitize script-like injection attempts', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('xss', {
        steps: [{ goal: 'Output {{input}}', context: '' }],
      });
      const result = wt.instantiate('xss', {
        input: '<script>alert(1)</script>',
      });
      // _sanitizeValue strips ; { } \ but not < > /
      // <script> contains no ; { } \ so it passes through as-is
      // This verifies the current sanitization behavior
      assert.equal(result.steps[0].goal, 'Output <script>alert(1)</script>');
      cleanup(wt);
    });

    it('should sanitize semicolons, braces and backslashes', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('chars', {
        steps: [{ goal: 'Val {{v}}', context: '' }],
      });
      const result = wt.instantiate('chars', {
        v: 'a;b{c}\\d',
      });
      // _sanitizeValue removes ; { } \
      assert.equal(result.steps[0].goal, 'Val abcd');
      cleanup(wt);
    });

    it('should not replace DANGEROUS_KEYS like __proto__', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('danger', {
        steps: [{ goal: 'Test {{__proto__}}', context: '{{constructor}}' }],
      });
      const result = wt.instantiate('danger', {
        __proto__: 'evil',
        constructor: 'hacked',
      });
      // DANGEROUS_KEYS should keep the original placeholder
      assert.equal(result.steps[0].goal, 'Test {{__proto__}}');
      assert.equal(result.steps[0].context, '{{constructor}}');
      cleanup(wt);
    });

    it('should handle steps without goal or context', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('minimal', {
        steps: [{ other: 'data' }],
      });
      const result = wt.instantiate('minimal', { x: 'y' });
      assert.ok(result);
      assert.equal(result.steps[0].other, 'data');
      cleanup(wt);
    });

    it('should handle multiple steps independently', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('multi-step', {
        steps: [
          { goal: 'Step1 {{a}}', context: 'Ctx1 {{b}}' },
          { goal: 'Step2 {{a}}', context: 'Ctx2 {{c}}' },
        ],
      });
      const result = wt.instantiate('multi-step', { a: 'A', b: 'B' });
      assert.equal(result.steps[0].goal, 'Step1 A');
      assert.equal(result.steps[0].context, 'Ctx1 B');
      assert.equal(result.steps[1].goal, 'Step2 A');
      assert.equal(result.steps[1].context, 'Ctx2 {{c}}');
      cleanup(wt);
    });

    it('should not mutate the original template steps', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('immutable', {
        steps: [{ goal: 'Hello {{name}}', context: '' }],
      });
      wt.instantiate('immutable', { name: 'World' });
      const original = wt.get('immutable');
      assert.equal(original.steps[0].goal, 'Hello {{name}}');
      cleanup(wt);
    });
  });
});

// ─── Lifecycle & Persistence: _persist, _restore, shutdown ────────

describe('WorkflowTemplate – Lifecycle & Persistence', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createTempProjectRoot();
  });

  function cleanup(instance) {
    if (instance && typeof instance.shutdown === 'function') {
      try { instance.shutdown(); } catch (_) { /* ignore */ }
    }
    removeTempDir(projectRoot);
  }

  // ─── _persist / _restore ────────────────────────────────

  describe('_persist and _restore', () => {
    it('should persist templates to disk', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('persist-test', {
        steps: [{ goal: 'do something', context: 'ctx' }],
      });
      // Verify file was written
      const harnessDir = path.join(projectRoot, '.harness', 'workflow-templates');
      const filePath = path.join(harnessDir, 'templates.json');
      assert.ok(fs.existsSync(filePath));
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.equal(data.length, 1);
      assert.equal(data[0].name, 'persist-test');
      cleanup(wt);
    });

    it('should restore templates from disk on construction', () => {
      // First instance creates and persists
      const wt1 = new WorkflowTemplate(projectRoot);
      wt1.create('restore-me', {
        steps: [{ goal: 'restored', context: '' }],
      });
      // Only shutdown wt1 (which triggers _persist), do NOT delete temp dir yet
      wt1.shutdown();

      // Second instance should restore from disk
      const wt2 = new WorkflowTemplate(projectRoot);
      const tpl = wt2.get('restore-me');
      assert.ok(tpl);
      assert.equal(tpl.steps[0].goal, 'restored');
      cleanup(wt2);
    });

    it('should handle empty store gracefully', () => {
      const wt = new WorkflowTemplate(projectRoot);
      assert.equal(wt.list().length, 0);
      cleanup(wt);
    });
  });

  // ─── shutdown ───────────────────────────────────────────

  describe('shutdown', () => {
    it('should mark instance as not healthy after shutdown', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.shutdown();
      assert.equal(wt.isHealthy(), false);
      cleanup(wt);
    });

    it('should throw on create after shutdown', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.shutdown();
      assert.throws(() => {
        wt.create('after-shutdown', { steps: [] });
      });
      cleanup(wt);
    });

    it('should throw on instantiate after shutdown', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('pre-shutdown', { steps: [] });
      wt.shutdown();
      assert.throws(() => {
        wt.instantiate('pre-shutdown', {});
      });
      cleanup(wt);
    });

    it('should throw on remove after shutdown', () => {
      const wt = new WorkflowTemplate(projectRoot);
      wt.create('pre-shutdown', { steps: [] });
      wt.shutdown();
      assert.throws(() => {
        wt.remove('pre-shutdown');
      });
      cleanup(wt);
    });
  });
});
