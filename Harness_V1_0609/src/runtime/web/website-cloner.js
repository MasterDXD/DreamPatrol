/**
 * @module runtime/web/website-cloner
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const debug = require('../../utils/debug-logger')('WebsiteCloner');
const { safeCall, safeExecute } = require('../../utils/safe-execute');
const safeAssign = require('../../utils/safe-assign');

const CLONE_PHASES = {
  RECON: 'recon',
  TOKEN_EXTRACTION: 'token-extraction',
  COMPONENT_SPEC: 'component-spec',
  BUILD: 'build',
  QA: 'qa',
};

const CLONE_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const DEFAULT_CONFIG = {
  maxRetries: 3,
  screenshotBreakpoints: [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1440, height: 900 },
  ],
  outputFormat: 'html',
  fidelityLevel: 'high',
  maxComponents: 50,
  tokenClusteringThreshold: 0.05,
  maxAssetSize: 10 * 1024 * 1024,
  timeoutMs: 300000,
};

const CSS_PROPERTIES_TO_EXTRACT = [
  'color', 'background-color', 'background-image', 'border-color',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-radius', 'box-shadow', 'opacity',
  'display', 'flex-direction', 'justify-content', 'align-items', 'gap',
  'grid-template-columns', 'grid-template-rows',
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'max-width', 'min-height',
  'text-align', 'text-decoration', 'text-transform',
  'transition', 'animation', 'transform', 'overflow',
];

const COMPONENT_PATTERNS = [
  { type: 'navigation', selectors: ['nav', 'header', '[role="navigation"]', '.navbar', '.nav', '.header'] },
  { type: 'hero', selectors: ['.hero', '[class*="hero"]', '[class*="banner"]', 'section:first-of-type'] },
  { type: 'footer', selectors: ['footer', '[role="contentinfo"]', '.footer'] },
  { type: 'card', selectors: ['.card', '[class*="card"]', '[class*="item"]', '[class*="tile"]'] },
  { type: 'form', selectors: ['form', '[class*="form"]', '[class*="contact"]'] },
  { type: 'testimonial', selectors: ['.testimonial', '[class*="testimonial"]', '[class*="review"]'] },
  { type: 'feature-grid', selectors: ['.features', '[class*="feature"]', '[class*="grid"]'] },
  { type: 'cta', selectors: ['.cta', '[class*="cta"]', '[class*="call-to-action"]'] },
  { type: 'pricing', selectors: ['.pricing', '[class*="pricing"]', '[class*="plan"]'] },
  { type: 'sidebar', selectors: ['aside', '.sidebar', '[class*="sidebar"]'] },
];

const INJECT_RECON_SCRIPT = `
(function() {
  var result = {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    styles: [],
    domStructure: [],
    assets: { images: [], fonts: [], svgs: [] },
    meta: {}
  };

  var metaTags = document.querySelectorAll('meta');
  for (var i = 0; i < metaTags.length; i++) {
    var name = metaTags[i].getAttribute('name') || metaTags[i].getAttribute('property');
    var content = metaTags[i].getAttribute('content');
    if (name && content) result.meta[name] = content;
  }

  var props = ${JSON.stringify(CSS_PROPERTIES_TO_EXTRACT)};
  var allElements = document.querySelectorAll('*');
  var maxElements = Math.min(allElements.length, 500);

  for (var i = 0; i < maxElements; i++) {
    var el = allElements[i];
    var computed = window.getComputedStyle(el);
    var style = {};
    style.selector = el.tagName.toLowerCase();
    if (el.id) style.selector += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      style.selector += '.' + el.className.trim().split(/\s+/).join('.');
    }
    style.properties = {};
    for (var j = 0; j < props.length; j++) {
      var val = computed.getPropertyValue(props[j]);
      if (val && val !== '' && val !== 'none' && val !== 'normal' && val !== '0px') {
        style.properties[props[j]] = val;
      }
    }
    style.textContent = (el.textContent || '').trim().substring(0, 200);
    style.childrenCount = el.children.length;
    style.rect = el.getBoundingClientRect();
    result.styles.push(style);
  }

  var imgs = document.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    result.assets.images.push({
      src: imgs[i].src || imgs[i].dataset.src || '',
      alt: imgs[i].alt || '',
      width: imgs[i].naturalWidth ?? 0,
      height: imgs[i].naturalHeight ?? 0,
    });
  }

  var svgs = document.querySelectorAll('svg');
  for (var i = 0; i < svgs.length; i++) {
    result.assets.svgs.push({
      outerHTML: svgs[i].outerHTML.substring(0, 5000),
      viewBox: svgs[i].getAttribute('viewBox') || '',
      width: svgs[i].getAttribute('width') || '',
      height: svgs[i].getAttribute('height') || '',
    });
  }

  var fontFaces = document.fonts ? document.fonts.values() : null;
  if (fontFaces) {
    var font = fontFaces.next();
    while (!font.done) {
      result.assets.fonts.push({
        family: font.value.family || '',
        weight: font.value.weight || '',
        style: font.value.style || '',
      });
      font = fontFaces.next();
    }
  }

  return result;
})()
`;

class WebsiteCloner extends EventEmitter {
  static CLONE_PHASES = CLONE_PHASES;
  static CLONE_STATUS = CLONE_STATUS;
  static DEFAULT_CONFIG = DEFAULT_CONFIG;
  static COMPONENT_PATTERNS = COMPONENT_PATTERNS;

  /**
   * 创建WebsiteCloner实例。
   * @param {object} [options] - 配置选项
   * @param {number} [options.maxRetries=3] - 最大重试次数
   * @param {Array<{name: string, width: number, height: number}>} [options.screenshotBreakpoints] - 截图断点配置
   * @param {string} [options.outputFormat='html'] - 输出格式
   * @param {string} [options.fidelityLevel='high'] - 保真级别
   * @param {number} [options.maxComponents=50] - 最大组件数量
   * @param {number} [options.tokenClusteringThreshold=0.05] - 令牌聚类阈值
   * @param {number} [options.maxAssetSize=10485760] - 最大资源大小（字节）
   * @param {number} [options.timeoutMs=300000] - 超时时间（毫秒）
   */
  constructor(options) {
    super();
    this._config = safeAssign({}, DEFAULT_CONFIG, options);
    this._status = CLONE_STATUS.IDLE;
    this._currentPhase = null;
    this._browserAdapter = null;
    this._designSkillEngine = null;
    this._subagentExecutor = null;
    this._lastResult = null;
    this._stats = {
      clonesCompleted: 0,
      clonesFailed: 0,
      tokensExtracted: 0,
      componentsIdentified: 0,
      totalDurationMs: 0,
    };
  }

  /**
   * 挂载浏览器适配器，用于页面导航、截图和DOM操作。
   * @param {object} adapter - 浏览器适配器实例，须实现navigate和executeAction方法
   * @returns {WebsiteCloner} 当前实例，支持链式调用
   */
  attachBrowserAdapter(adapter) {
    this.guardShutdown();
    if (adapter && typeof adapter.navigate === 'function' && typeof adapter.executeAction === 'function') {
      this._browserAdapter = adapter;
    }
    return this;
  }

  /**
   * 挂载设计技能引擎，用于QA阶段的设计质量审计。
   * @param {object} engine - DesignSkillEngine实例，须实现audit方法
   * @returns {WebsiteCloner} 当前实例，支持链式调用
   */
  attachDesignSkillEngine(engine) {
    this.guardShutdown();
    if (engine && typeof engine.audit === 'function') {
      this._designSkillEngine = engine;
    }
    return this;
  }

  /**
   * 挂载子代理执行器，用于委托子任务执行。
   * @param {object} executor - 子代理执行器实例，须实现spawn方法
   * @returns {WebsiteCloner} 当前实例，支持链式调用
   */
  attachSubagentExecutor(executor) {
    this.guardShutdown();
    if (executor && typeof executor.spawn === 'function') {
      this._subagentExecutor = executor;
    }
    return this;
  }

  /**
   * 克隆指定URL的网站，依次执行侦察、令牌提取、组件规格、构建和QA五个阶段。
   * @param {string} url - 目标网站URL
   * @param {object} [options] - 克隆选项，覆盖默认配置
   * @returns {Promise<{url: string, status: string, durationMs: number, recon: object, tokens: object, specs: object, build: object, qa: object}>} 克隆结果
   * @throws {Error} URL无效或已有克隆任务进行中时抛出
   */
  async clone(url, options) {
    this.guardShutdown();
    if (this._status === CLONE_STATUS.RUNNING) {
      throw new Error('Clone already in progress');
    }
    if (!url || typeof url !== 'string') {
      throw new Error('URL is required');
    }

    const normalizedUrl = this._normalizeUrl(url);
    const cloneOptions = safeAssign({}, this._config, options);
    const startTime = Date.now();

    this._status = CLONE_STATUS.RUNNING;
    this._lastResult = null;

    try {
      const reconResult = await this._executePhase(CLONE_PHASES.RECON, () =>
        this._reconPhase(normalizedUrl, cloneOptions));

      const tokenResult = await this._executePhase(CLONE_PHASES.TOKEN_EXTRACTION, () =>
        this._tokenExtractionPhase(reconResult, cloneOptions));

      const specResult = await this._executePhase(CLONE_PHASES.COMPONENT_SPEC, () =>
        this._componentSpecPhase(reconResult, tokenResult, cloneOptions));

      const buildResult = await this._executePhase(CLONE_PHASES.BUILD, () =>
        this._buildPhase(specResult, tokenResult, cloneOptions));

      const qaResult = await this._executePhase(CLONE_PHASES.QA, () =>
        this._qaPhase(buildResult, reconResult, cloneOptions));

      const durationMs = Date.now() - startTime;
      this._stats.clonesCompleted++;
      this._stats.tokensExtracted += tokenResult.tokens ? Object.keys(tokenResult.tokens).length : 0;
      this._stats.componentsIdentified += specResult.components ? specResult.components.length : 0;
      this._stats.totalDurationMs += durationMs;

      this._status = CLONE_STATUS.COMPLETED;
      this._lastResult = {
        url: normalizedUrl,
        status: CLONE_STATUS.COMPLETED,
        durationMs,
        recon: reconResult,
        tokens: tokenResult,
        specs: specResult,
        build: buildResult,
        qa: qaResult,
      };

      this.emit('clone-completed', { url: normalizedUrl, durationMs, result: this._lastResult });
      return this._lastResult;
    } catch (err) {
      this._stats.clonesFailed++;
      this._status = CLONE_STATUS.FAILED;
      this.emit('clone-failed', { url: normalizedUrl, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  async _executePhase(phase, fn) {
    this._currentPhase = phase;
    this.emit('phase-started', { phase });
    debug('WebsiteCloner', 'phaseStarted', { phase });
    try {
      const result = await fn();
      this.emit('phase-completed', { phase, result });
      debug('WebsiteCloner', 'phaseCompleted', { phase });
      return result;
    } catch (err) {
      this.emit('phase-failed', { phase, error: err && err.message ? err.message : String(err) });
      debug('WebsiteCloner', 'phaseFailed', { phase, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  async _reconPhase(url, options) {
    if (!this._browserAdapter) {
      return this._reconWithoutBrowser(url, options);
    }

    await this._browserAdapter.navigate(url);

    const screenshots = [];
    for (const bp of Array.isArray(options.screenshotBreakpoints) ? options.screenshotBreakpoints : []) {
      const _ssResult = await safeCall(
        () => this._browserAdapter.executeAction('evaluate', {
          script: `window.resizeTo(${bp.width}, ${bp.height}); document.documentElement.clientWidth;`,
        }),
        'WebsiteCloner', 'resizeViewport',
      );
      const screenshot = await safeExecute(
        () => this._browserAdapter.takeScreenshot('recon-' + bp.name),
        'WebsiteCloner', 'takeScreenshot',
      );
      if (screenshot) {
        screenshots.push({ breakpoint: bp.name, width: bp.width, height: bp.height, data: screenshot });
      }
    }

    const reconData = await safeExecute(
      () => this._browserAdapter.executeAction('evaluate', { script: INJECT_RECON_SCRIPT }),
      'WebsiteCloner', 'injectReconScript',
    );

    const domStructure = await safeExecute(
      () => this._browserAdapter.executeAction('getDOM', {}),
      'WebsiteCloner', 'getDOM',
    );

    return {
      url,
      screenshots,
      computedStyles: (reconData && reconData.styles) ?? [],
      assets: (reconData && reconData.assets) || { images: [], fonts: [], svgs: [] },
      meta: (reconData && reconData.meta) ?? {},
      domStructure: domStructure ?? null,
      viewport: (reconData && reconData.viewport) ?? null,
      title: (reconData && reconData.title) || '',
    };
  }

  _reconWithoutBrowser(url, _options) {
    return {
      url,
      screenshots: [],
      computedStyles: [],
      assets: { images: [], fonts: [], svgs: [] },
      meta: {},
      domStructure: null,
      viewport: null,
      title: '',
      warning: 'No browser adapter attached; recon data is empty',
    };
  }

  _tokenExtractionPhase(reconResult, options) {
    const tokens = {
      colors: {},
      typography: { families: [], sizes: [], weights: [] },
      spacing: { values: [], patterns: [] },
      borderRadius: { values: [] },
      shadows: { values: [] },
      transitions: { values: [] },
    };

    const colorMap = new Map();
    const fontFamilySet = new Set();
    const fontSizeMap = new Map();
    const fontWeightSet = new Set();
    const spacingValues = new Set();
    const borderRadiusValues = new Set();
    const shadowValues = new Set();
    const transitionValues = new Set();

    for (const entry of reconResult.computedStyles) {
      if (!entry.properties) continue;
      const props = entry.properties;

      this._extractColorTokens(props, 'color', colorMap);
      this._extractColorTokens(props, 'background-color', colorMap);
      this._extractColorTokens(props, 'border-color', colorMap);

      if (props['font-family']) {
        const families = props['font-family'].split(',').map(function(f) { return f.trim().replace(/['"]/g, ''); });
        for (const f of families) {
          if (f && f !== 'inherit' && f !== 'initial') fontFamilySet.add(f);
        }
      }
      if (props['font-size']) fontSizeMap.set(props['font-size'], (fontSizeMap.get(props['font-size']) ?? 0) + 1);
      if (props['font-weight']) fontWeightSet.add(props['font-weight']);

      this._extractSpacingTokens(props, spacingValues);
      if (props['border-radius'] && props['border-radius'] !== '0px') borderRadiusValues.add(props['border-radius']);
      if (props['box-shadow'] && props['box-shadow'] !== 'none') shadowValues.add(props['box-shadow']);
      if (props['transition'] && props['transition'] !== 'none') transitionValues.add(props['transition']);
    }

    tokens.colors = this._clusterColors(colorMap, options.tokenClusteringThreshold);
    tokens.typography.families = Array.from(fontFamilySet);
    tokens.typography.sizes = this._rankByFrequency(fontSizeMap);
    tokens.typography.weights = Array.from(fontWeightSet);
    tokens.spacing.values = Array.from(spacingValues).sort(this._sortCssValues);
    tokens.spacing.patterns = this._detectSpacingPatterns(spacingValues);
    tokens.borderRadius.values = Array.from(borderRadiusValues).sort(this._sortCssValues);
    tokens.shadows.values = Array.from(shadowValues);
    tokens.transitions.values = Array.from(transitionValues);

    return { tokens, sourceUrl: reconResult.url };
  }

  _extractColorTokens(props, propName, colorMap) {
    const val = props[propName];
    if (!val || val === 'transparent' || val === 'inherit' || val === 'initial' || val === 'currentColor') return;
    const hex = this._normalizeColorToHex(val);
    if (hex) {
      colorMap.set(hex, (colorMap.get(hex) ?? 0) + 1);
    }
  }

  _normalizeColorToHex(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    if (colorStr.startsWith('#')) {
      const hex = colorStr.toLowerCase();
      if (hex.length === 4) {
        return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
      }
      return hex.length === 7 ? hex : null;
    }
    const rgbMatch = colorStr.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10);
      const g = parseInt(rgbMatch[2], 10);
      const b = parseInt(rgbMatch[3], 10);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return '#' + [r, g, b].map(function(c) { return c.toString(16).padStart(2, '0'); }).join('');
      }
    }
    return null;
  }

  _clusterColors(colorMap, threshold) {
    const entries = Array.from(colorMap.entries()).sort(function(a, b) { return b[1] - a[1]; });
    const clusters = [];
    const used = new Set();

    for (let i = 0; i < entries.length; i++) {
      if (used.has(i)) continue;
      const cluster = { representative: entries[i][0], members: [entries[i][0]], frequency: entries[i][1] };
      used.add(i);

      for (let j = i + 1; j < entries.length; j++) {
        if (used.has(j)) continue;
        if (this._colorDistance(entries[i][0], entries[j][0]) < threshold) {
          cluster.members.push(entries[j][0]);
          cluster.frequency += entries[j][1];
          used.add(j);
        }
      }
      clusters.push(cluster);
    }

    const result = { primary: [], secondary: [], neutral: [], accent: [] };
    for (const c of clusters) {
      const hsl = this._hexToHsl(c.representative);
      if (!hsl) { result.secondary.push(c); continue; }
      if (hsl.s < 0.1) {
        result.neutral.push(c);
      } else if (c.frequency > 5 || clusters.indexOf(c) < 3) {
        result.primary.push(c);
      } else {
        result.accent.push(c);
      }
    }
    return result;
  }

  _colorDistance(hex1, hex2) {
    const r1 = parseInt(hex1.slice(1, 3), 16);
    const g1 = parseInt(hex1.slice(3, 5), 16);
    const b1 = parseInt(hex1.slice(5, 7), 16);
    const r2 = parseInt(hex2.slice(1, 3), 16);
    const g2 = parseInt(hex2.slice(3, 5), 16);
    const b2 = parseInt(hex2.slice(5, 7), 16);
    return Math.sqrt(
      Math.pow((r1 - r2) / 255, 2) +
      Math.pow((g1 - g2) / 255, 2) +
      Math.pow((b1 - b2) / 255, 2),
    ) / Math.sqrt(3);
  }

  _hexToHsl(hex) {
    const ri = parseInt(hex.slice(1, 3), 16);
    const gi = parseInt(hex.slice(3, 5), 16);
    const bi = parseInt(hex.slice(5, 7), 16);
    if (!Number.isFinite(ri) || !Number.isFinite(gi) || !Number.isFinite(bi)) {
      return { h: 0, s: 0, l: 0 };
    }
    const r = ri / 255;
    const g = gi / 255;
    const b = bi / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h, s, l };
  }

  _extractSpacingTokens(props, spacingValues) {
    const spacingProps = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap'];
    for (const p of spacingProps) {
      const val = props[p];
      if (val && val !== '0px' && val !== '0' && val !== 'auto') spacingValues.add(val);
    }
  }

  _detectSpacingPatterns(spacingValues) {
    const numericValues = [];
    for (const v of spacingValues) {
      const num = parseFloat(v);
      if (Number.isFinite(num) && num > 0) numericValues.push(num);
    }
    if (numericValues.length === 0) return [];

    numericValues.sort(function(a, b) { return a - b; });
    const baseUnit = numericValues[0];
    const patterns = [{ baseUnit, multiples: [] }];
    for (const n of numericValues) {
      const ratio = n / baseUnit;
      if (Number.isFinite(ratio) && Math.abs(ratio - Math.round(ratio)) < 0.1) {
        patterns[0].multiples.push(Math.round(ratio));
      }
    }
    return patterns;
  }

  _rankByFrequency(freqMap) {
    return Array.from(freqMap.entries())
      .sort(function(a, b) { return b[1] - a[1]; })
      .map(function(e) { return { value: e[0], frequency: e[1] }; });
  }

  _sortCssValues(a, b) {
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
    if (Number.isFinite(numA)) return -1;
    if (Number.isFinite(numB)) return 1;
    return a.localeCompare(b, 'en');
  }

  _componentSpecPhase(reconResult, tokenResult, options) {
    const components = [];
    const identifiedSections = new Set();

    for (const pattern of COMPONENT_PATTERNS) {
      for (const selector of pattern.selectors) {
        const matching = reconResult.computedStyles.filter(function(e) {
          return e.selector && e.selector.includes(selector.replace(/[\[\]]/g, '').replace(/[:*]/g, ''));
        });
        if (matching.length > 0 && !identifiedSections.has(pattern.type)) {
          identifiedSections.add(pattern.type);
          components.push({
            type: pattern.type,
            selector: selector,
            elementCount: matching.length,
            styles: matching.map(function(m) { return m.properties ?? {}; }),
            textContent: matching.map(function(m) { return m.textContent || ''; }).filter(Boolean),
          });
        }
      }
    }

    if (components.length === 0 && reconResult.computedStyles.length > 0) {
      const sections = this._autoSegmentPage(reconResult.computedStyles);
      for (const section of sections) {
        components.push(section);
      }
    }

    const specs = components.slice(0, options.maxComponents).map(function(comp, idx) {
      return {
        id: 'comp-' + (idx + 1),
        type: comp.type,
        selector: comp.selector,
        spec: {
          elementCount: comp.elementCount,
          designTokens: {
            colors: comp.styles.reduce(function(acc, s) {
              if (s.color) acc.textColor = s.color;
              if (s['background-color']) acc.backgroundColor = s['background-color'];
              return acc;
            }, {}),
            typography: comp.styles.reduce(function(acc, s) {
              if (s['font-family']) acc.fontFamily = s['font-family'];
              if (s['font-size']) acc.fontSize = s['font-size'];
              if (s['font-weight']) acc.fontWeight = s['font-weight'];
              return acc;
            }, {}),
            spacing: comp.styles.reduce(function(acc, s) {
              if (s['padding-top']) acc.padding = s['padding-top'];
              if (s.gap) acc.gap = s.gap;
              return acc;
            }, {}),
          },
          content: comp.textContent.slice(0, 5),
        },
      };
    });

    return { components: specs, totalIdentified: components.length, sourceUrl: reconResult.url };
  }

  _autoSegmentPage(styles) {
    const sections = [];
    const topLevel = styles.filter(function(s) {
      return s.childrenCount > 0 && s.properties &&
        (s.properties.display === 'flex' || s.properties.display === 'grid' || s.properties.display === 'block');
    });

    let sectionIdx = 0;
    for (const element of topLevel.slice(0, 20)) {
      sectionIdx++;
      sections.push({
        type: 'section-' + sectionIdx,
        selector: element.selector,
        elementCount: element.childrenCount,
        styles: [element.properties ?? {}],
        textContent: element.textContent ? [element.textContent] : [],
      });
    }
    return sections;
  }

  _buildPhase(specResult, tokenResult, options) {
    const htmlParts = [];
    const cssParts = [];
    const jsParts = [];

    cssParts.push(this._generateCSSVariables(tokenResult.tokens));
    cssParts.push(this._generateBaseStyles(tokenResult.tokens));

    for (const comp of specResult.components) {
      const html = this._generateComponentHTML(comp);
      const css = this._generateComponentCSS(comp);
      htmlParts.push(html);
      cssParts.push(css);
    }

    const html = this._assemblePage(htmlParts, tokenResult.tokens, specResult);
    const css = cssParts.join('\n\n');
    const js = jsParts.join('\n\n');

    return {
      format: options.outputFormat,
      html,
      css,
      js,
      componentCount: specResult.components.length,
      assetList: this._generateAssetList(specResult),
    };
  }

  _generateCSSVariables(tokens) {
    const lines = [':root {'];
    if (tokens.colors && tokens.colors.primary) {
      tokens.colors.primary.forEach(function(c, i) {
        lines.push('  --color-primary-' + (i + 1) + ': ' + c.representative + ';');
      });
    }
    if (tokens.colors && tokens.colors.neutral) {
      tokens.colors.neutral.forEach(function(c, i) {
        lines.push('  --color-neutral-' + (i + 1) + ': ' + c.representative + ';');
      });
    }
    if (tokens.colors && tokens.colors.accent) {
      tokens.colors.accent.forEach(function(c, i) {
        lines.push('  --color-accent-' + (i + 1) + ': ' + c.representative + ';');
      });
    }
    if (tokens.typography && tokens.typography.families.length > 0) {
      lines.push("  --font-family-base: '" + tokens.typography.families[0] + "', sans-serif;");
    }
    if (tokens.typography && tokens.typography.sizes.length > 0) {
      tokens.typography.sizes.slice(0, 6).forEach(function(s, i) {
        lines.push('  --font-size-' + (i + 1) + ': ' + s.value + ';');
      });
    }
    if (tokens.spacing && tokens.spacing.values.length > 0) {
      tokens.spacing.values.slice(0, 8).forEach(function(v, i) {
        lines.push('  --spacing-' + (i + 1) + ': ' + v + ';');
      });
    }
    if (tokens.borderRadius && tokens.borderRadius.values.length > 0) {
      tokens.borderRadius.values.slice(0, 4).forEach(function(v, i) {
        lines.push('  --radius-' + (i + 1) + ': ' + v + ';');
      });
    }
    if (tokens.shadows && tokens.shadows.values.length > 0) {
      tokens.shadows.values.slice(0, 3).forEach(function(v, i) {
        lines.push('  --shadow-' + (i + 1) + ': ' + v + ';');
      });
    }
    lines.push('}');
    return lines.join('\n');
  }

  _generateBaseStyles(tokens) {
    const family = (tokens.typography && tokens.typography.families.length > 0)
      ? "'" + tokens.typography.families[0] + "', sans-serif"
      : 'system-ui, sans-serif';
    const baseColor = (tokens.colors && tokens.colors.neutral.length > 0)
      ? tokens.colors.neutral[0].representative
      : '#18181b';
    const bgColor = (tokens.colors && tokens.colors.neutral.length > 0)
      ? tokens.colors.neutral[tokens.colors.neutral.length - 1].representative
      : '#ffffff';

    return [
      '* { margin: 0; padding: 0; box-sizing: border-box; }',
      'body {',
      '  font-family: ' + family + ';',
      '  color: ' + baseColor + ';',
      '  background-color: ' + bgColor + ';',
      '  line-height: 1.5;',
      '}',
    ].join('\n');
  }

  _generateComponentHTML(comp) {
    const tag = this._componentTypeToTag(comp.type);
    const className = 'clone-' + comp.type;
    const content = (comp.spec && comp.spec.content && comp.spec.content.length > 0)
      ? comp.spec.content[0]
      : '';
    return '<' + tag + ' class="' + className + '">\n  <!-- ' + comp.type + ' section -->\n' +
      (content ? '  <p>' + content + '</p>\n' : '') +
      '</' + tag + '>';
  }

  _componentTypeToTag(type) {
    const map = {
      navigation: 'nav', hero: 'section', footer: 'footer',
      card: 'div', form: 'form', testimonial: 'section',
      'feature-grid': 'section', cta: 'section', pricing: 'section', sidebar: 'aside',
    };
    return map[type] || 'section';
  }

  _generateComponentCSS(comp) {
    const className = '.clone-' + comp.type;
    const lines = [className + ' {'];
    const dt = comp.spec && comp.spec.designTokens ? comp.spec.designTokens : {};
    if (dt.colors) {
      if (dt.colors.textColor) lines.push('  color: ' + dt.colors.textColor + ';');
      if (dt.colors.backgroundColor) lines.push('  background-color: ' + dt.colors.backgroundColor + ';');
    }
    if (dt.typography) {
      if (dt.typography.fontFamily) lines.push('  font-family: ' + dt.typography.fontFamily + ';');
      if (dt.typography.fontSize) lines.push('  font-size: ' + dt.typography.fontSize + ';');
      if (dt.typography.fontWeight) lines.push('  font-weight: ' + dt.typography.fontWeight + ';');
    }
    if (dt.spacing) {
      if (dt.spacing.padding) lines.push('  padding: ' + dt.spacing.padding + ';');
      if (dt.spacing.gap) lines.push('  gap: ' + dt.spacing.gap + ';');
    }
    lines.push('}');
    return lines.join('\n');
  }

  _assemblePage(htmlParts, tokens, specResult) {
    const nav = htmlParts.filter(function(_, i) { return specResult.components[i].type === 'navigation'; }).join('\n');
    const main = htmlParts.filter(function(_, i) { return specResult.components[i].type !== 'navigation' && specResult.components[i].type !== 'footer'; }).join('\n');
    const footer = htmlParts.filter(function(_, i) { return specResult.components[i].type === 'footer'; }).join('\n');

    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
      '  <meta charset="UTF-8">\n' +
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '  <title>Cloned Page</title>\n' +
      '  <link rel="stylesheet" href="styles.css">\n' +
      '</head>\n<body>\n' +
      (nav ? nav + '\n' : '') +
      '<main>\n' + (main || '<!-- No main content -->') + '\n</main>\n' +
      (footer ? footer + '\n' : '') +
      '</body>\n</html>';
  }

  _generateAssetList(specResult) {
    const assets = [];
    for (const comp of specResult.components) {
      if (comp.spec && comp.spec.designTokens) {
        const dt = comp.spec.designTokens;
        if (dt.colors && dt.colors.backgroundColor && dt.colors.backgroundColor.includes('url(')) {
          assets.push({ type: 'image', source: dt.colors.backgroundColor, componentId: comp.id });
        }
      }
    }
    return assets;
  }

  async _qaPhase(buildResult, reconResult, _options) {
    const issues = [];
    let qualityScore = 100;

    if (!buildResult.html || buildResult.html.length < 100) {
      issues.push({ severity: 'high', message: 'Generated HTML is empty or too short' });
      qualityScore -= 30;
    }

    if (!buildResult.css || buildResult.css.length < 50) {
      issues.push({ severity: 'medium', message: 'Generated CSS is empty or too short' });
      qualityScore -= 20;
    }

    if (buildResult.componentCount === 0) {
      issues.push({ severity: 'high', message: 'No components were generated' });
      qualityScore -= 40;
    }

    if (this._designSkillEngine && buildResult.css) {
      try {
        const auditResult = this._designSkillEngine.audit(buildResult.css);
        if (auditResult && auditResult.score < 70) {
          issues.push({
            severity: 'medium',
            message: 'Design quality score is below threshold: ' + auditResult.score,
            details: auditResult.issues ? auditResult.issues.slice(0, 5) : [],
          });
          qualityScore -= (70 - auditResult.score) / 2;
        }
      } catch (_e) {
        debug('WebsiteCloner', 'qaAuditSkipped', { error: _e.message });
      }
    }

    if (reconResult.warning) {
      issues.push({ severity: 'low', message: reconResult.warning });
      qualityScore -= 5;
    }

    qualityScore = Math.max(0, Math.min(100, qualityScore));

    return {
      qualityScore,
      issues,
      componentCount: buildResult.componentCount,
      hasScreenshots: reconResult.screenshots && reconResult.screenshots.length > 0,
      visualComparisonAvailable: false,
    };
  }

  _normalizeUrl(url) {
    let normalized = url.trim();
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'https://' + normalized;
    }
    return normalized;
  }

  /**
   * 获取当前克隆任务的状态信息。
   * @returns {{status: string, currentPhase: string|null, lastResult: object|null}} 状态信息
   */
  getStatus() {
    return {
      status: this._status,
      currentPhase: this._currentPhase,
      lastResult: this._lastResult,
    };
  }

  /**
   * 获取克隆器统计信息。
   * @returns {{clonesCompleted: number, clonesFailed: number, tokensExtracted: number, componentsIdentified: number, totalDurationMs: number}} 统计数据
   */
  getStats() {
    return { ...this._stats };
  }

  _onShutdown() {
    this._shutDown = true;
    this._status = CLONE_STATUS.IDLE;
    this._currentPhase = null;
    this._browserAdapter = null;
    this._designSkillEngine = null;
    this._subagentExecutor = null;
    this._lastResult = null;
    this._stats = { clonesCompleted: 0, clonesFailed: 0, tokensExtracted: 0, componentsIdentified: 0, totalDurationMs: 0 };
    this.removeAllListeners();
  }
}

module.exports = withShutdown(WebsiteCloner);
module.exports.CLONE_PHASES = CLONE_PHASES;
module.exports.CLONE_STATUS = CLONE_STATUS;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.COMPONENT_PATTERNS = COMPONENT_PATTERNS;
