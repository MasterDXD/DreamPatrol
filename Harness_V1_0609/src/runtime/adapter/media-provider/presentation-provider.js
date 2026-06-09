'use strict';

/**
 * @module runtime/adapter/media-provider/presentation-provider
 * PresentationProvider — 演示文稿生成适配器。
 * 融合Presenton开源项目（开源版Gamma）的设计理念，通过API生成专业PPT。
 * 继承MediaProviderBase，复用重试/超时/并发控制/指标追踪等基础设施。
 *
 * 生成模式：
 * - 'generate'：文本→PPT，从文本描述生成完整演示文稿
 * - 'textToSlides'：文本→幻灯片，将长文本拆分为多页幻灯片
 * - 'outlineToPresentation'：大纲→PPT，从结构化大纲生成演示文稿
 */

const MediaProviderBase = require('./media-provider-base');
const { debug } = require('../../../utils/debug-logger');
const { generateId } = require('../../../utils/unique-id');
const BoundedMap = require('../../../utils/bounded-map');
const http = require('http');
const https = require('https');

const PRESENTATION_MODES = {
  GENERATE: 'generate',
  TEXT_TO_SLIDES: 'textToSlides',
  OUTLINE_TO_PRESENTATION: 'outlineToPresentation',
};

const DEFAULT_TEMPLATES = [
  { id: 'professional', name: 'Professional', category: 'business' },
  { id: 'creative', name: 'Creative', category: 'design' },
  { id: 'technical', name: 'Technical', category: 'engineering' },
  { id: 'minimal', name: 'Minimal', category: 'general' },
];

const DEFAULT_CONFIG = {
  apiEndpoint: '',
  apiKey: '',
  defaultTemplate: 'professional',
  defaultTheme: 'light',
  maxSlidesPerPresentation: 50,
  maxPromptLength: 5000,
  supportedFormats: ['pptx', 'pdf', 'html'],
  taskCacheSize: 200,
};

/** HTTP响应最大大小限制（10MB），防止内存耗尽攻击 */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB - HTTP响应最大大小限制

/**
 * 演示文稿生成提供者，通过API接口生成和管理演示文稿内容
 *
 * @classdesc 演示文稿生成提供者，通过API接口生成和管理演示文稿内容
 * @extends MediaProviderBase
 */
class PresentationProvider extends MediaProviderBase {
  /**
   * 创建PresentationProvider实例。
   *
   * @param {Object} [config] - 配置
   * @param {string} [config.apiEndpoint] - Presenton API端点URL
   * @param {string} [config.apiKey] - API密钥
   * @param {string} [config.defaultTemplate] - 默认模板ID
   * @param {string} [config.defaultTheme] - 默认主题（'light'|'dark'）
   */
  constructor(config) {
    super(config);
    this._presConfig = Object.assign({}, DEFAULT_CONFIG, config ?? {});
    this._taskCache = new BoundedMap(this._presConfig.taskCacheSize);
    this._templateCache = null;
    this._log = debug('PresentationProvider');
  }

  /** @type {string} */
  get name() {
    return 'presentation-provider';
  }

  /**
   * 获取Provider支持的模式和能力。
   *
   * @returns {{modes: string[], maxSlides: number, supportedFormats: string[], provider: string}}
   */
  getCapabilities() {
    return {
      modes: [PRESENTATION_MODES.GENERATE, PRESENTATION_MODES.TEXT_TO_SLIDES, PRESENTATION_MODES.OUTLINE_TO_PRESENTATION],
      maxSlides: this._presConfig.maxSlidesPerPresentation,
      supportedFormats: this._presConfig.supportedFormats,
      provider: this.name,
    };
  }

  /**
   * 连接到Presenton API服务。
   *
   * @returns {Promise<{connected: boolean, provider: string}>}
   * @private
   */
  async _doConnect() {
    if (!this._presConfig.apiEndpoint) {
      this._connected = true;
      this._healthy = true;
      return { connected: true, provider: this.name };
    }
    const client = this._presConfig.apiEndpoint.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL('/api/health', this._presConfig.apiEndpoint); } catch (e) {
        return reject(new Error('Invalid API endpoint URL: ' + (e && e.message ? e.message : String(e))));
      }
      const req = client.get(url, { timeout: 5000, headers: { 'Authorization': 'Bearer ' + this._presConfig.apiKey } }, function(res) {
        let _body = '';
        let bodySize = 0;
        res.on('data', function(chunk) {
          bodySize += chunk.length;
          if (bodySize > MAX_RESPONSE_SIZE) {
            res.destroy();
            reject(new Error('Response too large (max ' + MAX_RESPONSE_SIZE + ' bytes)'));
            return;
          }
          _body += chunk;
        });
        res.on('end', function() {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ connected: true, provider: 'presentation-provider' });
          } else {
            reject(new Error('Health check failed: HTTP ' + res.statusCode));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('Health check timeout')); });
    });
  }

  /**
   * 断开连接。
   *
   * @private
   */
  async _doDisconnect() {
    this._taskCache.shutdown();
    this._templateCache = null;
  }

  /**
   * 健康检查。
   *
   * @returns {Promise<{healthy: boolean}>}
   * @private
   */
  async _doHealthCheck() {
    if (!this._presConfig.apiEndpoint) {
      return { healthy: true };
    }
    return this._doConnect();
  }

  /**
   * 生成演示文稿。支持三种模式：generate/textToSlides/outlineToPresentation。
   *
   * @param {Object} request - 生成请求
   * @param {string} request.prompt - 文本描述或大纲内容
   * @param {string} [request.mode] - 生成模式
   * @param {Object} [request.options] - 选项
   * @param {string} [request.options.template] - 模板ID
   * @param {string} [request.options.theme] - 主题（'light'|'dark'）
   * @param {string} [request.options.format] - 输出格式（'pptx'|'pdf'|'html'）
   * @param {number} [request.options.maxSlides] - 最大幻灯片数
   * @param {string} [request.options.language] - 内容语言
   * @returns {Promise<{taskId: string, status: string, provider: string, slides?: number}>}
   * @private
   */
  async _doGenerate(request) {
    const prompt = request && request.prompt;
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('prompt is required and must be a non-empty string');
    }
    if (prompt.length > this._presConfig.maxPromptLength) {
      throw new Error('prompt exceeds maximum length (' + this._presConfig.maxPromptLength + ')');
    }
    const mode = request.mode || PRESENTATION_MODES.GENERATE;
    const validModes = [PRESENTATION_MODES.GENERATE, PRESENTATION_MODES.TEXT_TO_SLIDES, PRESENTATION_MODES.OUTLINE_TO_PRESENTATION];
    if (!validModes.includes(mode)) {
      throw new Error('Invalid mode: ' + mode + '. Valid modes: ' + validModes.join(', '));
    }
    const options = request.options ?? {};
    const template = options.template || this._presConfig.defaultTemplate;
    const theme = options.theme || this._presConfig.defaultTheme;
    const format = options.format || 'pptx';
    const maxSlides = Math.min(
      Math.abs(options.maxSlides || this._presConfig.maxSlidesPerPresentation),
      this._presConfig.maxSlidesPerPresentation,
    );
    const language = options.language || 'en';

    if (!this._presConfig.supportedFormats.includes(format)) {
      throw new Error('Unsupported format: ' + format + '. Supported: ' + this._presConfig.supportedFormats.join(', '));
    }

    const taskId = 'ppt-' + generateId();

    if (this._presConfig.apiEndpoint) {
      return this._generateViaApi(taskId, prompt, mode, { template, theme, format, maxSlides, language });
    }

    return this._generateLocal(taskId, prompt, mode, { template, theme, format, maxSlides, language });
  }

  /**
   * 通过Presenton API生成演示文稿。
   *
   * @param {string} taskId - 任务ID
   * @param {string} prompt - 文本描述
   * @param {string} mode - 生成模式
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 生成结果
   * @private
   */
  async _generateViaApi(taskId, prompt, mode, options) {
    const client = this._presConfig.apiEndpoint.startsWith('https') ? https : http;
    const body = JSON.stringify({ prompt, mode, options, taskId });
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL('/api/generate', this._presConfig.apiEndpoint); } catch (e) {
        return reject(new Error('Invalid API endpoint URL: ' + (e && e.message ? e.message : String(e))));
      }
      const reqOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': 'Bearer ' + this._presConfig.apiKey,
        },
        timeout: this._providerConfig.requestTimeoutMs,
      };
      const req = client.request(reqOptions, function(res) {
        let data = '';
        let dataSize = 0;
        res.on('data', function(chunk) {
          dataSize += chunk.length;
          if (dataSize > MAX_RESPONSE_SIZE) {
            res.destroy();
            reject(new Error('Response too large (max ' + MAX_RESPONSE_SIZE + ' bytes)'));
            return;
          }
          data += chunk;
        });
        res.on('end', function() {
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({
                taskId: result.taskId || taskId,
                status: result.status || 'processing',
                provider: 'presentation-provider',
                slides: result.slides,
                downloadUrl: result.downloadUrl,
              });
            } else {
              reject(new Error('API error: HTTP ' + res.statusCode));
            }
          } catch (_e) {
            reject(new Error('Invalid API response'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('API request timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 本地生成演示文稿（无API时的降级方案）。
   * 生成结构化的幻灯片数据，可由前端渲染或导出为PPTX。
   *
   * @param {string} taskId - 任务ID
   * @param {string} prompt - 文本描述
   * @param {string} mode - 生成模式
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 生成结果
   * @private
   */
  async _generateLocal(taskId, prompt, mode, options) {
    const slides = this._textToSlides(prompt, mode, options.maxSlides);
    const result = {
      taskId: taskId,
      status: 'completed',
      provider: 'presentation-provider',
      slides: slides.length,
      format: options.format,
      template: options.template,
      theme: options.theme,
      data: {
        title: this._extractTitle(prompt),
        slides: slides,
        metadata: {
          generatedAt: new Date().toISOString(),
          mode: mode,
          language: options.language,
        },
      },
    };
    this._taskCache.set(taskId, result);
    this.emit('task-completed', { taskId, provider: this.name, slides: slides.length });
    return result;
  }

  /**
   * 将文本拆分为幻灯片结构。
   *
   * @param {string} text - 输入文本
   * @param {string} mode - 生成模式
   * @param {number} maxSlides - 最大幻灯片数
   * @returns {Array<Object>} 幻灯片数组
   * @private
   */
  _textToSlides(text, mode, maxSlides) {
    const slides = [];
    if (mode === PRESENTATION_MODES.OUTLINE_TO_PRESENTATION) {
      const sections = text.split(/\n(?=#{1,3}\s)/).filter(function(s) { return s.trim().length > 0; });
      for (let i = 0; i < Math.min(sections.length, maxSlides); i++) {
        const section = sections[i].trim();
        const lines = section.split('\n');
        const title = lines[0].replace(/^#+\s*/, '').trim();
        const bullets = lines.slice(1).filter(function(l) { return l.trim().length > 0; }).map(function(l) {
          return l.trim().replace(/^[-*]\s*/, '').trim();
        });
        slides.push({ slideNumber: i + 1, title: title, bullets: bullets, type: bullets.length > 0 ? 'content' : 'section' });
      }
    } else {
      const paragraphs = text.split(/\n\n+/).filter(function(p) { return p.trim().length > 0; });
      if (paragraphs.length > 0) {
        slides.push({ slideNumber: 1, title: this._extractTitle(text), type: 'title' });
      }
      const contentParas = paragraphs.slice(1);
      const divisor = Math.max(1, maxSlides - 1); const slidesPerPara = Math.max(1, Math.ceil(contentParas.length / divisor));
      for (let i = 0; i < contentParas.length && slides.length < maxSlides; i += slidesPerPara) {
        const chunk = contentParas.slice(i, i + slidesPerPara);
        if (!chunk || chunk.length === 0) continue;
        const firstLine = chunk[0].split('\n')[0].replace(/^#+\s*/, '').trim();
        const title = firstLine.length <= 80 ? firstLine : 'Slide ' + (slides.length + 1);
        const bullets = chunk.flatMap(function(p) {
          return p.split('\n').filter(function(l) { return l.trim().length > 0; }).map(function(l) {
            return l.trim().replace(/^[-*]\s*/, '').trim();
          });
        });
        slides.push({ slideNumber: slides.length + 1, title: title, bullets: bullets, type: 'content' });
      }
    }
    if (slides.length === 0) {
      slides.push({ slideNumber: 1, title: 'Untitled', type: 'title' });
    }
    return slides;
  }

  /**
   * 从文本中提取标题。
   *
   * @param {string} text - 输入文本
   * @returns {string} 提取的标题
   * @private
   */
  _extractTitle(text) {
    const firstLine = text.split('\n')[0].trim();
    const cleaned = firstLine.replace(/^#+\s*/, '').trim();
    return cleaned.length <= 120 ? cleaned : cleaned.slice(0, 117) + '...';
  }

  /**
   * 查询任务状态。
   *
   * @param {string} taskId - 任务ID
   * @returns {Promise<Object>} 任务状态
   * @private
   */
  async _doGetTaskStatus(taskId) {
    const cached = this._taskCache.get(taskId);
    if (cached) {
      return cached;
    }
    if (this._presConfig.apiEndpoint) {
      const client = this._presConfig.apiEndpoint.startsWith('https') ? https : http;
      return new Promise((resolve, reject) => {
        let url;
        try { url = new URL('/api/tasks/' + taskId, this._presConfig.apiEndpoint); } catch (e) {
          return reject(new Error('Invalid API endpoint URL: ' + (e && e.message ? e.message : String(e))));
        }
        const req = client.get(url, { timeout: 10000, headers: { 'Authorization': 'Bearer ' + this._presConfig.apiKey } }, function(res) {
          let data = '';
          let dataSize = 0;
          res.on('data', function(chunk) {
            dataSize += chunk.length;
            if (dataSize > MAX_RESPONSE_SIZE) {
              res.destroy();
              reject(new Error('Response too large (max ' + MAX_RESPONSE_SIZE + ' bytes)'));
              return;
            }
            data += chunk;
          });
          res.on('end', function() {
            try {
              const result = JSON.parse(data);
              resolve(result);
            } catch (_e) {
              debug('PresentationProvider', '_doGetTaskStatus:jsonParse', _e && _e.message ? _e.message : String(_e));
              reject(new Error('Invalid API response'));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', function() { req.destroy(); reject(new Error('Status check timeout')); });
      });
    }
    return { taskId: taskId, status: 'not_found', error: 'Task not found' };
  }

  /**
   * 取消任务。
   *
   * @param {string} taskId - 任务ID
   * @returns {Promise<{cancelled: boolean}>}
   * @private
   */
  async _doCancelTask(taskId) {
    this._taskCache.delete(taskId);
    if (this._presConfig.apiEndpoint) {
      const client = this._presConfig.apiEndpoint.startsWith('https') ? https : http;
      return new Promise((resolve) => {
        let url;
        try { url = new URL('/api/tasks/' + taskId + '/cancel', this._presConfig.apiEndpoint); } catch (e) {
          return resolve({ cancelled: false, error: 'Invalid API endpoint URL: ' + (e && e.message ? e.message : String(e)) });
        }
        const reqOptions = { method: 'POST', timeout: 10000, headers: { 'Authorization': 'Bearer ' + this._presConfig.apiKey } };
        const req = client.request(url, reqOptions, function(res) {
          let _data = '';
          let dataSize = 0;
          res.on('data', function(chunk) {
            dataSize += chunk.length;
            if (dataSize > MAX_RESPONSE_SIZE) {
              res.destroy();
              resolve({ cancelled: false, error: 'Response too large' });
              return;
            }
            _data += chunk;
          });
          res.on('end', function() { resolve({ cancelled: res.statusCode >= 200 && res.statusCode < 300 }); });
        });
        req.on('error', function(err) { debug('PresentationProvider', 'cancelTask:error', err && err.message ? err.message : String(err)); resolve({ cancelled: false }); });
        req.on('timeout', function() { req.destroy(); debug('PresentationProvider', 'cancelTask:timeout'); resolve({ cancelled: false }); });
        req.end();
      });
    }
    return { cancelled: true };
  }

  /**
   * 获取可用模板列表。
   *
   * @returns {Array<Object>} 模板列表
   */
  getTemplates() {
    if (this._templateCache) return this._templateCache;
    return DEFAULT_TEMPLATES.slice();
  }

  /**
   * 获取统计信息。
   *
   * @returns {Object} 统计信息
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalRequests: 0, successfulRequests: 0, failedRequests: 0, cachedTasks: 0, apiEndpoint: 'local' };
    }
    const baseStats = super.getStats();
    return Object.assign({}, baseStats, {
      cachedTasks: this._taskCache.size,
      apiEndpoint: this._presConfig.apiEndpoint ? 'configured' : 'local',
    });
  }

  /** 关闭清理回调。清除任务缓存和模板缓存。@returns {void} @private */
  _onShutdown() {
    this._taskCache.shutdown();
    this._templateCache = null;
    this._presConfig = {};
    super._onShutdown();
  }
}

PresentationProvider.PRESENTATION_MODES = PRESENTATION_MODES;
PresentationProvider.DEFAULT_TEMPLATES = DEFAULT_TEMPLATES;
PresentationProvider.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = PresentationProvider;
