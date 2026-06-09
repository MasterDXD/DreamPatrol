'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const ComputeAccelerator = require(path.join(ROOT, 'src', 'runtime', 'model', 'compute-accelerator'));
const ComputeBackend = ComputeAccelerator.ComputeBackend;
const CpuBackend = ComputeAccelerator.CpuBackend;
const GpuBackend = ComputeAccelerator.GpuBackend;

describe('ComputeBackend', () => {
  it('should initialize _initialized=false and _stats with zeros', () => {
    const backend = new ComputeBackend();
    assert.strictEqual(backend._initialized, false);
    assert.deepStrictEqual(backend._stats, { operations: 0, totalLatencyMs: 0 });
  });

  it('should return false from isAvailable() before init', () => {
    const backend = new ComputeBackend();
    assert.strictEqual(backend.isAvailable(), false);
  });

  it('should return "unknown" from getBackendType()', () => {
    const backend = new ComputeBackend();
    assert.strictEqual(backend.getBackendType(), 'unknown');
  });

  it('should return stats copy from getStats()', () => {
    const backend = new ComputeBackend();
    const stats = backend.getStats();
    assert.strictEqual(stats.backendType, 'unknown');
    assert.strictEqual(stats.initialized, false);
    assert.strictEqual(stats.operations, 0);
    assert.strictEqual(stats.avgLatencyMs, 0);
    stats.operations = 999;
    assert.strictEqual(backend._stats.operations, 0);
  });
});

describe('CpuBackend', () => {
  it('should create instance normally', () => {
    const cpu = new CpuBackend();
    assert.ok(cpu instanceof ComputeBackend);
    assert.strictEqual(cpu._initialized, false);
  });

  it('should set _initialized=true after init()', async () => {
    const cpu = new CpuBackend();
    await cpu.init();
    assert.strictEqual(cpu._initialized, true);
  });

  it('should set _initialized=false after shutdown()', async () => {
    const cpu = new CpuBackend();
    await cpu.init();
    await cpu.shutdown();
    assert.strictEqual(cpu._initialized, false);
  });

  it('should always return true from isAvailable()', () => {
    const cpu = new CpuBackend();
    assert.strictEqual(cpu.isAvailable(), true);
  });

  it('should return "cpu" from getBackendType()', () => {
    const cpu = new CpuBackend();
    assert.strictEqual(cpu.getBackendType(), 'cpu');
  });

  it('should compute cosineSimilarity ≈ 1.0 for identical vectors', async () => {
    const cpu = new CpuBackend();
    const result = await cpu.cosineSimilarity([1, 0, 0], [1, 0, 0]);
    assert.ok(Math.abs(result - 1.0) < 1e-9, 'expected ≈ 1.0, got ' + result);
  });

  it('should compute cosineSimilarity ≈ 0.0 for orthogonal vectors', async () => {
    const cpu = new CpuBackend();
    const result = await cpu.cosineSimilarity([1, 0, 0], [0, 1, 0]);
    assert.ok(Math.abs(result - 0.0) < 1e-9, 'expected ≈ 0.0, got ' + result);
  });

  it('should return 0 for cosineSimilarity with zero vector', async () => {
    const cpu = new CpuBackend();
    const result = await cpu.cosineSimilarity([1, 0], [0, 0]);
    assert.strictEqual(result, 0);
  });

  it('should return 0 for cosineSimilarity with null input', async () => {
    const cpu = new CpuBackend();
    const result = await cpu.cosineSimilarity(null, [1, 0]);
    assert.strictEqual(result, 0);
  });

  it('should return correct similarity array from batchCosineSimilarity', async () => {
    const cpu = new CpuBackend();
    const query = [1, 0, 0];
    const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const results = await cpu.batchCosineSimilarity(query, vectors);
    assert.strictEqual(results.length, 3);
    assert.ok(Math.abs(results[0] - 1.0) < 1e-9);
    assert.ok(Math.abs(results[1] - 0.0) < 1e-9);
    assert.ok(Math.abs(results[2] - 0.0) < 1e-9);
  });

  it('should compute simple matrixMultiply correctly', async () => {
    const cpu = new CpuBackend();
    const a = [[1, 2], [3, 4]];
    const b = [[5, 6], [7, 8]];
    const result = await cpu.matrixMultiply(a, b, { m: 2, k: 2, n: 2 });
    assert.deepStrictEqual(result, [[19, 22], [43, 50]]);
  });

  it('should return embedding vector with correct dimensions and L2 norm ≈ 1', async () => {
    const cpu = new CpuBackend();
    const dims = 64;
    const vec = await cpu.embed('hello world', dims);
    assert.strictEqual(vec.length, dims);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1.0) < 1e-6, 'L2 norm should be ≈ 1.0, got ' + norm);
  });

  it('should return attentionScore in [0, 1] range', async () => {
    const cpu = new CpuBackend();
    const score = await cpu.attentionScore(
      { importance: 0.8, recency: 0.9 },
      { importance: 0.7, recency: 0.6 },
      5, 10,
    );
    assert.ok(score >= 0 && score <= 1, 'score should be in [0,1], got ' + score);
  });

  it('should return result with samples array from monteCarloSimulate', async () => {
    const cpu = new CpuBackend();
    const result = await cpu.monteCarloSimulate({
      iterations: 10,
      timeSteps: 5,
      variables: 1,
      simulateStep: (t, state) => state.map(v => v + 0.1),
    });
    assert.ok(Array.isArray(result.samples));
    assert.strictEqual(result.samples.length, 10);
    assert.strictEqual(result.iterations, 10);
    assert.ok(typeof result.mean === 'number');
    assert.ok(typeof result.variance === 'number');
  });
});

describe('GpuBackend', () => {
  it('should fall back to CpuBackend when no gpuBridge is provided', async () => {
    const gpu = new GpuBackend(null);
    await gpu.init();
    const sim = await gpu.cosineSimilarity([1, 0, 0], [1, 0, 0]);
    assert.ok(Math.abs(sim - 1.0) < 1e-9);
  });

  it('should return false from isAvailable() without gpuBridge', () => {
    const gpu = new GpuBackend(null);
    assert.strictEqual(gpu.isAvailable(), false);
  });

  it('should return "gpu-fallback-cpu" from getBackendType() without gpuBridge', () => {
    const gpu = new GpuBackend(null);
    assert.strictEqual(gpu.getBackendType(), 'gpu-fallback-cpu');
  });

  it('should return "gpu" from getBackendType() when gpuBridge is available', () => {
    const gpu = new GpuBackend({ initialized: true, isAvailable: () => true });
    assert.strictEqual(gpu.getBackendType(), 'gpu');
  });

  it('should increment gpuMisses on fallback', async () => {
    const gpu = new GpuBackend(null);
    await gpu.init();
    assert.strictEqual(gpu._gpuMisses, 0);
    await gpu.cosineSimilarity([1, 0], [0, 1]);
    assert.strictEqual(gpu._gpuMisses, 1);
  });

  it('should include gpuHits and gpuMisses in getStats()', async () => {
    const gpu = new GpuBackend(null);
    await gpu.init();
    await gpu.cosineSimilarity([1, 0], [0, 1]);
    const stats = gpu.getStats();
    assert.strictEqual(typeof stats.gpuHits, 'number');
    assert.strictEqual(typeof stats.gpuMisses, 'number');
    assert.strictEqual(stats.gpuMisses, 1);
  });
});

describe('ComputeAccelerator', () => {
  it('should default to defaultBackend="auto"', () => {
    const acc = new ComputeAccelerator();
    assert.strictEqual(acc._config.defaultBackend, 'auto');
  });

  it('should initialize backends on init()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    assert.strictEqual(acc._activeBackendName, 'cpu');
    assert.ok(acc._activeBackend !== null);
    await acc.shutdown();
  });

  it('should shut down cleanly', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    await acc.shutdown();
    assert.strictEqual(acc._activeBackend, null);
    assert.strictEqual(acc._activeBackendName, null);
  });

  it('should execute cosineSimilarity via execute()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    const result = await acc.execute('cosineSimilarity', {
      vecA: [1, 0, 0],
      vecB: [1, 0, 0],
    });
    assert.ok(Math.abs(result - 1.0) < 1e-9);
    await acc.shutdown();
  });

  it('should execute cosineSimilarity via executeSync() returning correct result', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    const result = acc.executeSync('cosineSimilarity', {
      vecA: [1, 0, 0],
      vecB: [1, 0, 0],
    });
    assert.strictEqual(typeof result, 'number');
    assert.ok(Math.abs(result - 1.0) < 0.001);
    await acc.shutdown();
  });

  it('should throw on unknown operation via execute()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    await assert.rejects(
      () => acc.execute('unknownOp', {}),
      { message: /Unknown operation/ },
    );
    await acc.shutdown();
  });

  it('should return active backend from getActiveBackend()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    const backend = acc.getActiveBackend();
    assert.ok(backend !== null);
    assert.strictEqual(backend.getBackendType(), 'cpu');
    await acc.shutdown();
  });

  it('should register custom backend via registerBackend()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    const custom = new CpuBackend();
    await custom.init();
    acc.registerBackend('custom', custom);
    assert.ok(acc._backends.has('custom'));
    await acc.shutdown();
  });

  it('should throw on invalid backend name in registerBackend()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    assert.throws(
      () => acc.registerBackend('', new CpuBackend()),
      { message: /non-empty string/ },
    );
    await acc.shutdown();
  });

  it('should force CPU when setFeatureFlags disables gpu-acceleration', async () => {
    const acc = new ComputeAccelerator({ defaultBackend: 'gpu' });
    await acc.init();
    acc._activeBackendName = 'gpu';
    acc._activeBackend = acc._backends.get('gpu');
    acc.setFeatureFlags({ 'gpu-acceleration': false });
    assert.strictEqual(acc._activeBackendName, 'cpu');
    await acc.shutdown();
  });

  it('should return aggregated stats from getStats()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    await acc.execute('cosineSimilarity', { vecA: [1, 0], vecB: [0, 1] });
    const stats = acc.getStats();
    assert.strictEqual(stats.totalOperations, 1);
    assert.ok(typeof stats.totalLatencyMs === 'number');
    assert.ok(typeof stats.avgLatencyMs === 'number');
    assert.ok(stats.operationsByType.cosineSimilarity);
    assert.ok(stats.backends);
    await acc.shutdown();
  });

  it('should emit "operation-completed" event on successful operation', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    let emitted = null;
    acc.on('operation-completed', (evt) => { emitted = evt; });
    await acc.execute('cosineSimilarity', { vecA: [1, 0], vecB: [1, 0] });
    assert.ok(emitted !== null);
    assert.strictEqual(emitted.operation, 'cosineSimilarity');
    assert.ok(typeof emitted.latencyMs === 'number');
    await acc.shutdown();
  });

  it('should emit "operation-failed" event on failed operation', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    let emitted = null;
    acc.on('operation-failed', (evt) => { emitted = evt; });
    try {
      await acc.execute('unknownOp', {});
    } catch (_) { /* expected */ }
    assert.ok(emitted !== null);
    assert.strictEqual(emitted.operation, 'unknownOp');
    assert.ok(emitted.error instanceof Error);
    await acc.shutdown();
  });

  it('should select cpu backend in auto mode without gpu', async () => {
    const acc = new ComputeAccelerator({ defaultBackend: 'auto' });
    await acc.init();
    assert.strictEqual(acc._activeBackendName, 'cpu');
    await acc.shutdown();
  });

  it('should select cpu backend when defaultBackend is "cpu"', async () => {
    const acc = new ComputeAccelerator({ defaultBackend: 'cpu' });
    await acc.init();
    assert.strictEqual(acc._activeBackendName, 'cpu');
    await acc.shutdown();
  });

  it('should expose static references to backend classes', () => {
    assert.strictEqual(typeof ComputeAccelerator.ComputeBackend, 'function');
    assert.strictEqual(typeof ComputeAccelerator.CpuBackend, 'function');
    assert.strictEqual(typeof ComputeAccelerator.GpuBackend, 'function');
  });

  it('should expose DEFAULT_CONFIG statically', () => {
    assert.ok(ComputeAccelerator.DEFAULT_CONFIG);
    assert.strictEqual(ComputeAccelerator.DEFAULT_CONFIG.defaultBackend, 'auto');
  });

  it('should reset stats on shutdown()', async () => {
    const acc = new ComputeAccelerator();
    await acc.init();
    await acc.execute('cosineSimilarity', { vecA: [1, 0], vecB: [0, 1] });
    assert.strictEqual(acc._stats.totalOperations, 1);
    await acc.shutdown();
    assert.strictEqual(acc._stats.totalOperations, 0);
  });

  it('should emit "backend-switched" when setFeatureFlags changes backend', async () => {
    const acc = new ComputeAccelerator({ defaultBackend: 'gpu' });
    await acc.init();
    acc._activeBackendName = 'gpu';
    acc._activeBackend = acc._backends.get('gpu');
    let switched = null;
    acc.on('backend-switched', (evt) => { switched = evt; });
    acc.setFeatureFlags({ 'gpu-acceleration': false });
    assert.ok(switched !== null);
    assert.strictEqual(switched.from, 'gpu');
    assert.strictEqual(switched.to, 'cpu');
    await acc.shutdown();
  });
});
