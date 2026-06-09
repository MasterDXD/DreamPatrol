'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PresentationProvider, VideoProvider } = require('../../../../src/runtime/adapter/media-provider');

// ─── PresentationProvider ──────────────────────────────────────

describe('PresentationProvider constructor', () => {
  it('should create instance with default config', () => {
    const p = new PresentationProvider();
    assert.equal(p.name, 'presentation-provider');
    assert.ok(p.getCapabilities());
    assert.ok(p.getCapabilities().modes.includes('generate'));
    assert.ok(p.getCapabilities().modes.includes('textToSlides'));
    assert.ok(p.getCapabilities().modes.includes('outlineToPresentation'));
  });

  it('should create instance with custom config', () => {
    const p = new PresentationProvider({ apiEndpoint: 'http://test', apiKey: 'key123', defaultTemplate: 'creative' });
    assert.equal(p.name, 'presentation-provider');
  });

  it('should have PRESENTATION_MODES static', () => {
    assert.equal(PresentationProvider.PRESENTATION_MODES.GENERATE, 'generate');
    assert.equal(PresentationProvider.PRESENTATION_MODES.TEXT_TO_SLIDES, 'textToSlides');
    assert.equal(PresentationProvider.PRESENTATION_MODES.OUTLINE_TO_PRESENTATION, 'outlineToPresentation');
  });

  it('should have DEFAULT_TEMPLATES static', () => {
    assert.ok(Array.isArray(PresentationProvider.DEFAULT_TEMPLATES));
    assert.ok(PresentationProvider.DEFAULT_TEMPLATES.length >= 4);
  });
});

describe('PresentationProvider generate', () => {
  it('should generate presentation locally (no API)', async () => {
    const p = new PresentationProvider();
    const result = await p.generate({ prompt: 'Introduction to AI\n\nAI is transforming industries.\n\nKey areas include NLP, Computer Vision, and Robotics.' });
    assert.equal(result.status, 'completed');
    assert.ok(result.taskId.startsWith('ppt-'));
    assert.ok(result.slides >= 1);
    assert.ok(result.data);
    assert.ok(Array.isArray(result.data.slides));
  });

  it('should generate with textToSlides mode', async () => {
    const p = new PresentationProvider();
    const result = await p.generate({ prompt: 'Topic A\n\nContent for A.\n\nTopic B\n\nContent for B.', mode: 'textToSlides' });
    assert.equal(result.status, 'completed');
    assert.ok(result.slides >= 1);
  });

  it('should generate with outlineToPresentation mode', async () => {
    const p = new PresentationProvider();
    const outline = '# Section 1\n- Point 1\n- Point 2\n# Section 2\n- Point 3';
    const result = await p.generate({ prompt: outline, mode: 'outlineToPresentation' });
    assert.equal(result.status, 'completed');
    assert.ok(result.slides >= 1);
  });

  it('should throw on empty prompt', async () => {
    const p = new PresentationProvider();
    await assert.rejects(() => p.generate({ prompt: '' }), /prompt is required/);
  });

  it('should throw on non-string prompt', async () => {
    const p = new PresentationProvider();
    await assert.rejects(() => p.generate({ prompt: 123 }), /prompt is required/);
  });

  it('should throw on invalid mode', async () => {
    const p = new PresentationProvider();
    await assert.rejects(() => p.generate({ prompt: 'test', mode: 'invalid' }), /Invalid mode/);
  });

  it('should throw on unsupported format', async () => {
    const p = new PresentationProvider();
    await assert.rejects(() => p.generate({ prompt: 'test', options: { format: 'docx' } }), /Unsupported format/);
  });

  it('should respect maxSlides option', async () => {
    const p = new PresentationProvider();
    const longText = Array.from({ length: 30 }, (_, i) => 'Paragraph ' + (i + 1) + ' with some content.').join('\n\n');
    const result = await p.generate({ prompt: longText, options: { maxSlides: 5 } });
    assert.ok(result.slides <= 5);
  });

  it('should get task status for cached task', async () => {
    const p = new PresentationProvider();
    const gen = await p.generate({ prompt: 'Test presentation' });
    const status = await p.getTaskStatus(gen.taskId);
    assert.equal(status.taskId, gen.taskId);
    assert.equal(status.status, 'completed');
  });

  it('should return not_found for unknown task', async () => {
    const p = new PresentationProvider();
    const status = await p.getTaskStatus('ppt-unknown');
    assert.equal(status.status, 'not_found');
  });

  it('should cancel task', async () => {
    const p = new PresentationProvider();
    const gen = await p.generate({ prompt: 'Test' });
    const result = await p.cancelTask(gen.taskId);
    assert.equal(result.cancelled, true);
  });

  it('should get templates', () => {
    const p = new PresentationProvider();
    const templates = p.getTemplates();
    assert.ok(Array.isArray(templates));
    assert.ok(templates.length >= 4);
  });

  it('should get stats', async () => {
    const p = new PresentationProvider();
    await p.generate({ prompt: 'Test' });
    const stats = p.getStats();
    assert.ok(stats.cachedTasks >= 0);
    assert.equal(stats.apiEndpoint, 'local');
  });

  it('should handle shutdown', async () => {
    const p = new PresentationProvider();
    await p.generate({ prompt: 'Test' });
    p.shutdown();
    assert.throws(() => p.guardShutdown());
  });
});

// ─── VideoProvider ──────────────────────────────────────────────

describe('VideoProvider constructor', () => {
  it('should create instance with default config', () => {
    const v = new VideoProvider();
    assert.equal(v.name, 'video-provider');
    assert.ok(v.getCapabilities());
    assert.ok(v.getCapabilities().modes.includes('generate'));
    assert.ok(v.getCapabilities().modes.includes('imageToVideo'));
    assert.ok(v.getCapabilities().modes.includes('videoToVideo'));
  });

  it('should have VIDEO_MODES static', () => {
    assert.equal(VideoProvider.VIDEO_MODES.GENERATE, 'generate');
    assert.equal(VideoProvider.VIDEO_MODES.IMAGE_TO_VIDEO, 'imageToVideo');
    assert.equal(VideoProvider.VIDEO_MODES.VIDEO_TO_VIDEO, 'videoToVideo');
  });

  it('should have RESOLUTION_PRESETS static', () => {
    assert.ok(VideoProvider.RESOLUTION_PRESETS.SD);
    assert.ok(VideoProvider.RESOLUTION_PRESETS.HD);
    assert.ok(VideoProvider.RESOLUTION_PRESETS.FHD);
    assert.ok(VideoProvider.RESOLUTION_PRESETS.UHD);
  });
});

describe('VideoProvider generate', () => {
  it('should generate video locally (no API)', async () => {
    const v = new VideoProvider();
    const result = await v.generate({ prompt: 'A cat walking in a garden', mode: 'generate' });
    assert.equal(result.status, 'completed');
    assert.ok(result.taskId.startsWith('vid-'));
    assert.ok(result.data);
    assert.ok(result.data.framesGenerated > 0);
    assert.equal(result.data.nvfp4Quantized, true);
  });

  it('should throw on empty prompt for generate mode', async () => {
    const v = new VideoProvider();
    await assert.rejects(() => v.generate({ prompt: '', mode: 'generate' }), /prompt is required/);
  });

  it('should throw on missing imageInput for imageToVideo mode', async () => {
    const v = new VideoProvider();
    await assert.rejects(() => v.generate({ mode: 'imageToVideo' }), /imageInput is required/);
  });

  it('should throw on missing videoInput for videoToVideo mode', async () => {
    const v = new VideoProvider();
    await assert.rejects(() => v.generate({ mode: 'videoToVideo' }), /videoInput is required/);
  });

  it('should throw on invalid mode', async () => {
    const v = new VideoProvider();
    await assert.rejects(() => v.generate({ prompt: 'test', mode: 'invalid' }), /Invalid mode/);
  });

  it('should throw on unsupported format', async () => {
    const v = new VideoProvider();
    await assert.rejects(() => v.generate({ prompt: 'test', options: { format: 'avi2' } }), /Unsupported format/);
  });

  it('should throw on zero duration', async () => {
    const v = new VideoProvider({ maxDurationSeconds: 0 });
    await assert.rejects(() => v.generate({ prompt: 'test', options: { durationSeconds: 5 } }), /duration must be at least 1 second/);
  });

  it('should calculate segments for long video', async () => {
    const v = new VideoProvider({ maxSegmentDuration: 10 });
    const result = await v.generate({ prompt: 'test', options: { durationSeconds: 30 } });
    assert.ok(result.data.segments.length >= 3);
  });

  it('should respect resolution option', async () => {
    const v = new VideoProvider();
    const result = await v.generate({ prompt: 'test', options: { resolution: 'FHD' } });
    assert.ok(result.resolution.includes('1920'));
  });

  it('should get task status for cached task', async () => {
    const v = new VideoProvider();
    const gen = await v.generate({ prompt: 'test' });
    const status = await v.getTaskStatus(gen.taskId);
    assert.equal(status.taskId, gen.taskId);
  });

  it('should cancel task', async () => {
    const v = new VideoProvider();
    const gen = await v.generate({ prompt: 'test' });
    const result = await v.cancelTask(gen.taskId);
    assert.equal(result.cancelled, true);
  });

  it('should get stats', async () => {
    const v = new VideoProvider();
    await v.generate({ prompt: 'test' });
    const stats = v.getStats();
    assert.equal(stats.nvfp4Enabled, true);
    assert.equal(stats.apiEndpoint, 'local');
  });

  it('should handle shutdown', async () => {
    const v = new VideoProvider();
    await v.generate({ prompt: 'test' });
    v.shutdown();
    assert.throws(() => v.guardShutdown());
  });
});
