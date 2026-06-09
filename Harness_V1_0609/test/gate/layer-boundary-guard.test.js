'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LayerBoundaryGuard, LAYERS, LAYER_ORDER } = require('../../src/gate/layer-boundary-guard');

describe('LayerBoundaryGuard', () => {
  it('should define four architecture layers', () => {
    assert.equal(LAYER_ORDER.length, 4);
    assert.ok(LAYERS.interaction);
    assert.ok(LAYERS.business);
    assert.ok(LAYERS.domain);
    assert.ok(LAYERS.infrastructure);
  });

  it('should identify layer for file path', () => {
    const guard = new LayerBoundaryGuard();
    assert.equal(guard.getLayerForPath('src/web/public/app.js'), 'interaction');
    assert.equal(guard.getLayerForPath('src/runtime/workflow/phase-orchestrator.js'), 'business');
    assert.equal(guard.getLayerForPath('src/runtime/agent/agent-runtime.js'), 'domain');
    assert.equal(guard.getLayerForPath('src/runtime/infrastructure/event-bus.js'), 'infrastructure');
    assert.equal(guard.getLayerForPath('src/utils/constants.js'), 'infrastructure');
  });

  it('should return null for gate/permission modules', () => {
    const guard = new LayerBoundaryGuard();
    assert.equal(guard.getLayerForPath('src/gate/tdd-gate.js'), null);
    assert.equal(guard.getLayerForPath('src/permission/rbac-enforcer.js'), null);
  });

  it('should enforce dependency direction rules', () => {
    const guard = new LayerBoundaryGuard({ strict: true });
    assert.equal(guard.isDependencyAllowed('interaction', 'business'), true);
    assert.equal(guard.isDependencyAllowed('business', 'domain'), true);
    assert.equal(guard.isDependencyAllowed('domain', 'infrastructure'), true);
    assert.equal(guard.isDependencyAllowed('infrastructure', 'domain'), false);
    assert.equal(guard.isDependencyAllowed('infrastructure', 'business'), false);
    assert.equal(guard.isDependencyAllowed('infrastructure', 'interaction'), false);
    assert.equal(guard.isDependencyAllowed('domain', 'business'), false);
    assert.equal(guard.isDependencyAllowed('business', 'interaction'), false);
  });

  it('should allow same-layer dependencies', () => {
    const guard = new LayerBoundaryGuard();
    assert.equal(guard.isDependencyAllowed('domain', 'domain'), true);
    assert.equal(guard.isDependencyAllowed('infrastructure', 'infrastructure'), true);
  });

  it('should allow null layer dependencies', () => {
    const guard = new LayerBoundaryGuard();
    assert.equal(guard.isDependencyAllowed(null, 'domain'), true);
    assert.equal(guard.isDependencyAllowed('domain', null), true);
  });

  it('should detect violations in checkFile', () => {
    const guard = new LayerBoundaryGuard({ strict: false });
    const violations = guard.checkFile('src/runtime/infrastructure/event-bus.js', [
      'src/runtime/agent/agent-runtime.js',
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].fromLayer, 'infrastructure');
    assert.equal(violations[0].toLayer, 'domain');
  });

  it('should throw in strict mode on violations', () => {
    const guard = new LayerBoundaryGuard({ strict: true });
    assert.throws(() => {
      guard.checkFile('src/runtime/infrastructure/event-bus.js', ['src/runtime/agent/agent-runtime.js']);
    }, /Layer boundary violation/);
  });

  it('should accumulate violations', () => {
    const guard = new LayerBoundaryGuard({ strict: false });
    guard.checkFile('src/runtime/infrastructure/event-bus.js', ['src/runtime/agent/agent-runtime.js']);
    guard.checkFile('src/utils/constants.js', ['src/runtime/workflow/phase-orchestrator.js']);
    assert.equal(guard.getViolations().length, 2);
  });

  it('should clear violations', () => {
    const guard = new LayerBoundaryGuard();
    guard.checkFile('src/runtime/infrastructure/event-bus.js', ['src/runtime/agent/agent-runtime.js']);
    guard.clearViolations();
    assert.equal(guard.getViolations().length, 0);
  });

  it('should return layers and order', () => {
    const guard = new LayerBoundaryGuard();
    const layers = guard.getLayers();
    assert.ok(layers.interaction);
    assert.ok(layers.business);
    assert.ok(layers.domain);
    assert.ok(layers.infrastructure);
    assert.equal(guard.getOrder().length, 4);
  });
});
