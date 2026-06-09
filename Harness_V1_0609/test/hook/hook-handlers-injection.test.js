'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BUILTIN_HANDLERS } = require('../../src/runtime/workflow/hook-handlers');

describe('Hook Handlers - Injection', () => {
  describe('inject_core_identity', () => {
    it('should inject core identity', async () => {
      const result = await BUILTIN_HANDLERS.inject_core_identity({});
      assert.equal(result.passed, true);
      assert.ok(result.injection.type === 'core_identity');
      assert.ok(result.injection.identity.principles.length > 0);
    });
  });

  describe('inject_skill_router', () => {
    it('should inject skill router', async () => {
      const result = await BUILTIN_HANDLERS.inject_skill_router({ project_root: '' });
      assert.equal(result.passed, true);
      assert.ok(result.injection.type === 'skill_router');
      assert.ok(result.injection.routing.slashCommands);
    });
  });
});
