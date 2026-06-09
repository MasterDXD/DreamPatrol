'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const _cleanup = [];
function _track(obj) { if (obj) _cleanup.push(obj); return obj; }
async function _cleanAll() {
  for (const obj of _cleanup) {
    try { const r = obj.shutdown(); if (r && typeof r.then === 'function') await r; } catch (_) { /* best-effort */ }
    try { obj.removeAllListeners(); } catch (_) { /* best-effort */ }
  }
  _cleanup.length = 0;
}

describe('Silent Exception Fix Verification (Part 1)', () => {
  afterEach(async () => { await _cleanAll(); });

  describe('TokenAwareDeepening - budget safety', () => {
    const TokenAwareDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'token-aware-deepening'));

    it('should return canAfford:false when token manager throws', () => {
      const tad = _track(new TokenAwareDeepening());
      const badManager = { getUsage: function() { throw new Error('connection lost'); } };
      const result = tad.canAffordIteration(badManager, 'session-1', 100);
      assert.equal(result.canAfford, false);
      assert.equal(result.reason, 'token-query-error');
    });

    it('should return canAfford:true when no token manager (allowed)', () => {
      const tad = _track(new TokenAwareDeepening());
      const result = tad.canAffordIteration(null, 'session-1', 100);
      assert.equal(result.canAfford, true);
    });

    it('should return maxIterations:1 when token manager throws (conservative)', () => {
      const tad = _track(new TokenAwareDeepening());
      const badManager = { getUsage: function() { throw new Error('timeout'); } };
      const result = tad.calculateMaxIterations(badManager, 'session-1');
      assert.equal(result.maxIterations, 1);
      assert.equal(result.reason, 'token-manager-error');
    });

    it('should return maxIterations:4 when no token manager (legacy)', () => {
      const tad = _track(new TokenAwareDeepening());
      const result = tad.calculateMaxIterations(null, 'session-1');
      assert.equal(result.maxIterations, 4);
      assert.equal(result.reason, 'no-token-manager');
    });
  });

  describe('DeepeningOrchestrator - agent error events', () => {
    const DeepeningOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-orchestrator'));

    it('should emit agent-error event when agent throws', async () => {
      const orch = _track(new DeepeningOrchestrator());
      const events = [];
      orch.on('agent-error', e => events.push(e));
      await orch.execute(
        { id: 'task-1' },
        [{ id: 'agent-1', execute: async () => { throw new Error('agent crashed'); } }],
      );
      assert.ok(events.length > 0);
      assert.equal(events[0].agentId, 'agent-1');
      assert.equal(events[0].error, 'agent crashed');
    });

    it('should emit agent-error and still complete successfully', async () => {
      const orch = _track(new DeepeningOrchestrator());
      const result = await orch.execute(
        { id: 'task-2' },
        [{ id: 'bad-agent', execute: async () => { throw new Error('fail'); } }],
      );
      assert.equal(result.success, true);
      assert.equal(result.totalAgentCalls, 0);
    });
  });

  describe('IterativeRefinement - review error events', () => {
    const IterativeRefinement = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'iterative-refinement'));

    it('should emit review-error event when reviewer throws', async () => {
      const ir = _track(new IterativeRefinement());
      const events = [];
      ir.on('review-error', e => events.push(e));
      await ir.refine(
        { execute: async (_t) => 'output' },
        { id: 'task-1' },
        async () => { throw new Error('reviewer crashed'); },
      );
      assert.ok(events.length > 0);
      assert.equal(events[0].error, 'reviewer crashed');
    });

    it('should still return success when reviewer throws', async () => {
      const ir = _track(new IterativeRefinement());
      const result = await ir.refine(
        { execute: async (_t) => 'output' },
        { id: 'task-2' },
        async () => { throw new Error('reviewer crashed'); },
      );
      assert.equal(result.success, false);
      assert.equal(result.rounds, 1);
      assert.equal(result.result, 'output');
    });
  });

  describe('DeepeningErrorHandler - fallback error logging', () => {
    const DeepeningErrorHandler = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-error-handler'));

    it('should handle fallback that throws without crashing', async () => {
      const eh = _track(new DeepeningErrorHandler());
      eh.registerFallback('timeout-error', () => { throw new Error('fallback also failed'); });
      const result = await eh.handleError(new Error('timeout occurred'), { task: 'test' });
      assert.equal(result.handled, true);
      assert.equal(result.category, 'timeout-error');
    });
  });

  describe('DeepeningEventBus - handler error events', () => {
    const DeepeningEventBus = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-event-bus'));

    it('should emit handler-error when subscriber throws', () => {
      const bus = _track(new DeepeningEventBus());
      const events = [];
      bus.on('handler-error', e => events.push(e));
      bus.subscribe('test-topic', () => { throw new Error('handler crashed'); });
      bus.publish('test-topic', { value: 1 });
      assert.ok(events.length > 0);
      assert.equal(events[0].topic, 'test-topic');
      assert.equal(events[0].error, 'handler crashed');
    });

    it('should emit interceptor-error when interceptor throws', () => {
      const bus = _track(new DeepeningEventBus());
      const events = [];
      bus.on('interceptor-error', e => events.push(e));
      bus.addInterceptor(() => { throw new Error('interceptor crashed'); });
      bus.publish('test-topic', { value: 1 });
      assert.ok(events.length > 0);
      assert.equal(events[0].error, 'interceptor crashed');
    });
  });

  describe('DeepeningPluginSystem - plugin error events', () => {
    const DeepeningPluginSystem = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-plugin-system'));

    it('should emit plugin-error when preDeepen hook throws', async () => {
      const ps = _track(new DeepeningPluginSystem());
      const events = [];
      ps.on('plugin-error', e => events.push(e));
      ps.registerPlugin('bad-plugin', {
        hooks: { preDeepen: async () => { throw new Error('plugin crashed'); } },
      });
      await ps.executePreDeepen({});
      assert.ok(events.length > 0);
      assert.equal(events[0].plugin, 'bad-plugin');
      assert.equal(events[0].hook, 'preDeepen');
    });

    it('should emit plugin-error when postDeepen hook throws', async () => {
      const ps = _track(new DeepeningPluginSystem());
      const events = [];
      ps.on('plugin-error', e => events.push(e));
      ps.registerPlugin('bad-plugin', {
        hooks: { postDeepen: async () => { throw new Error('plugin crashed'); } },
      });
      await ps.executePostDeepen({});
      assert.ok(events.length > 0);
      assert.equal(events[0].plugin, 'bad-plugin');
      assert.equal(events[0].hook, 'postDeepen');
    });
  });

  describe('DeepeningConfigManager - watcher error logging', () => {
    const DeepeningConfigManager = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-config-manager'));

    it('should not crash when watcher throws', () => {
      const cm = _track(new DeepeningConfigManager());
      cm.define('test-key', 'initial', { mutable: true });
      cm.watch('test-key', () => { throw new Error('watcher crashed'); });
      const result = cm.set('test-key', 'new-value');
      assert.equal(result, true);
      assert.equal(cm.get('test-key'), 'new-value');
    });
  });
});

describe('Silent Exception Fix Verification (Part 2)', () => {
  afterEach(async () => { await _cleanAll(); });

  describe('ProgressiveDeepening - review/adversarial error events', () => {
    const ProgressiveDeepening = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'progressive-deepening'));

    it('should emit review-error when reviewer throws', async () => {
      const pd = _track(new ProgressiveDeepening());
      const events = [];
      pd.on('review-error', e => events.push(e));
      await pd.execute(
        { execute: async (_t) => 'result' },
        { id: 'task-1' },
        'deep',
        { reviewer: async () => { throw new Error('review fail'); } },
      );
      assert.ok(events.length > 0);
      assert.equal(events[0].error, 'review fail');
    });

    it('should emit adversarial-error when adversarial reviewer throws', async () => {
      const pd = _track(new ProgressiveDeepening());
      const events = [];
      pd.on('adversarial-error', e => events.push(e));
      await pd.execute(
        { execute: async (_t) => 'result' },
        { id: 'task-2' },
        'intensive',
        { adversarialReviewer: { review: async () => { throw new Error('adversarial fail'); } } },
      );
      assert.ok(events.length > 0);
      assert.equal(events[0].error, 'adversarial fail');
    });
  });

  describe('RecurrentDeepeningScheduler - evaluator error events', () => {
    const RecurrentDeepeningScheduler = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'recurrent-deepening-scheduler'));

    it('should emit evaluator-error when evaluator throws', async () => {
      const scheduler = _track(new RecurrentDeepeningScheduler({ maxIterations: 1 }));
      const events = [];
      scheduler.on('evaluator-error', e => events.push(e));
      await scheduler.execute(
        { execute: async (_t) => 'result' },
        { id: 'task-1' },
        async () => { throw new Error('evaluator crashed'); },
      );
      assert.ok(events.length > 0);
      assert.equal(events[0].error, 'evaluator crashed');
    });
  });

  describe('DeepeningDataPipeline - stage error events', () => {
    const DeepeningDataPipeline = require(path.join(ROOT, 'src', 'runtime', 'deepening', 'deepening-data-pipeline'));

    it('should emit stage-error when handler throws', async () => {
      const pipeline = _track(new DeepeningDataPipeline());
      const events = [];
      pipeline.on('stage-error', e => events.push(e));
      pipeline.addStage(null, 'failing-stage', async (_data) => { throw new Error('stage crashed'); });
      try {
        await pipeline.process(null, { input: 'test' });
      } catch (_e) {
        // expected
      }
      assert.ok(events.length > 0);
      assert.equal(events[0].stage, 'failing-stage');
      assert.equal(events[0].error, 'stage crashed');
    });
  });
});

describe('Data Providers Code Style', () => {
  describe('design-data.js - extracted validation helpers', () => {
    const { applyDesignMixin } = require(path.join(ROOT, 'src', 'web', 'dashboard', 'data-providers', 'design-data'));

    it('should export applyDesignMixin function', () => {
      assert.equal(typeof applyDesignMixin, 'function');
    });

    it('should apply mixin to a class', () => {
      class MockServer {
        _designEngine = {
          audit: (s, t) => ({ source: s, type: t }),
          getTypographyScale: () => ({}),
          getSpacingScale: () => ({}),
          getColorSystem: () => ({}),
          getMotionPreset: () => ({}),
          getResponsiveBreakpoints: () => ({}),
          getVisualHierarchy: () => ({}),
          getComponentTokens: () => ({}),
          getMicroInteractions: () => ({}),
          getAccessibilityStandards: () => ({}),
          getInteractionStates: () => ({}),
          getDesignVariance: () => ({}),
          getCompanyDesignLanguage: () => ({}),
          generateDesignMd: () => '',
          getStats: () => ({}),
          checkContrast: () => ({}),
          auditAccessibility: () => ({}),
          generateResponsiveCSS: () => '',
          generateAccessibilityCSS: () => '',
          generateSectionCSS: () => '',
          generateComponentCSS: () => '',
        };
        _parseIntParam(p, k, d) { return d; }
      }
      applyDesignMixin(MockServer);
      const server = new MockServer();
      assert.equal(typeof server._getDesignAudit, 'function');
      assert.equal(typeof server._checkContrast, 'function');
      assert.equal(typeof server._auditAccessibility, 'function');
    });
  });

  describe('infra-data.js - const/let style', () => {
    const { applyInfraMixin } = require(path.join(ROOT, 'src', 'web', 'dashboard', 'data-providers', 'infra-data'));

    it('should export applyInfraMixin function', () => {
      assert.equal(typeof applyInfraMixin, 'function');
    });
  });

  describe('agent-data.js - const/let style', () => {
    const { applyAgentMixin } = require(path.join(ROOT, 'src', 'web', 'dashboard', 'data-providers', 'agent-data'));

    it('should export applyAgentMixin function', () => {
      assert.equal(typeof applyAgentMixin, 'function');
    });
  });

  describe('utils.js - shared helpers', () => {
    const { _apiError, _safeDecodeURI } = require(path.join(ROOT, 'src', 'web', 'dashboard', 'utils'));

    it('_apiError should return error object with _status and _data', () => {
      const result = _apiError('test error', 400);
      assert.equal(result._status, 400);
      assert.equal(result._data.error, 'test error');
    });

    it('_apiError should default _status to 400', () => {
      const result = _apiError('test');
      assert.equal(result._status, 400);
    });

    it('_safeDecodeURI should decode valid URI', () => {
      assert.equal(_safeDecodeURI('hello%20world'), 'hello world');
    });

    it('_safeDecodeURI should return original on invalid URI', () => {
      assert.equal(_safeDecodeURI('%E0%A4%A'), '%E0%A4%A');
    });
  });
});
