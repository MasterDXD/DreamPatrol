'use strict';

/**
 * @module dashboard/data-providers/design-data
 * @description Dashboard设计系统数据提供模块，提供设计审计、预设、CSS生成、对比度检查和无障碍审计等功能
 */

const { _apiError } = require('./provider-helpers');
const { _safeDecodeURI } = require('../utils');
const DesignSkillEngine = require('../../../gate/design-skill-engine');

/** @constant {number} 设计源码最大长度 */
const MAX_SOURCE_LENGTH = 50000;
const { VALID_DESIGN_TYPES, VALID_DESIGN_COMPANIES, VALID_DESIGN_VARIANCES } = require('../constants');
/** @constant {RegExp[]} 危险内容模式列表（XSS/注入防护） */
const DANGEROUS_PATTERNS = Object.freeze([/<script[\s>]/i, /javascript\s*:/i, /on(error|load|click|mouseover|focus|blur)\s*=/i, /<iframe[\s>]/i, /<object[\s>]/i, /<embed[\s>]/i, /data\s*:\s*text\/html/i]);
/** @constant {RegExp} 控制字符正则 */
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/** @constant {RegExp} 十六进制颜色格式正则 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** @constant {Set<string>} 有效CSS类型集合 */
const VALID_CSS_TYPES = new Set(['all', 'responsive', 'accessibility', 'section', 'component']);
/** @constant {Set<string>} 有效CSS组件集合 */
const VALID_CSS_COMPONENTS = new Set(['button', 'input', 'card', 'modal', 'nav', 'form', 'table', 'alert', 'badge', 'tooltip', 'dropdown', 'checkbox', 'radio', 'switch', 'textarea', 'select', 'avatar', 'divider', 'spinner', 'progress']);

/**
 * 清理CSS值中的危险字符（分号、花括号），防止CSS注入
 * @param {string} value - 待清理的CSS值
 * @returns {string} 清理后的安全CSS值
 * @private
 */
function _sanitizeCssValue(value) {
  if (typeof value !== 'string') return String(value).replace(/[;{}]/g, '');
  return value.replace(/[;{}]/g, '');
}

/**
 * 验证设计源码安全性，检查长度、双重编码和危险模式
 * @param {string} source - 待验证的源码字符串
 * @returns {{decoded?: string, error?: string}|{_status: number, _data: object}} 验证结果，包含解码后的源码或错误
 * @private
 */
function _validateSource(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return _apiError('Source must be a non-empty string', 400);
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    return _apiError('Source exceeds maximum length of ' + MAX_SOURCE_LENGTH + ' characters', 400);
  }
  const decoded = _safeDecodeURI(source);
  if (decoded.length > MAX_SOURCE_LENGTH) {
    return _apiError('Decoded source exceeds maximum length of ' + MAX_SOURCE_LENGTH + ' characters', 400);
  }
  const doubleDecoded = _safeDecodeURI(decoded);
  if (doubleDecoded !== decoded) {
    for (let i = 0; i < DANGEROUS_PATTERNS.length; i++) {
      if (DANGEROUS_PATTERNS[i].test(doubleDecoded)) {
        return _apiError('Source contains double-encoded dangerous content', 400);
      }
    }
  }
  for (let i = 0; i < DANGEROUS_PATTERNS.length; i++) {
    if (DANGEROUS_PATTERNS[i].test(decoded)) {
      return _apiError('Source contains potentially dangerous content', 400);
    }
  }
  if (CONTROL_CHAR_RE.test(decoded)) {
    return _apiError('Source contains invalid control characters', 400);
  }
  return { decoded: decoded };
}

/**
 * 验证十六进制颜色值格式
 * @param {string} value - 颜色值
 * @param {string} paramName - 参数名称
 * @returns {{_status: number, _data: object}|null} 错误对象或null
 * @private
 */
function _validateHexColor(value, paramName) {
  if (!HEX_COLOR_RE.test(value)) {
    return _apiError('Invalid ' + paramName + ' color: must be hex format #rrggbb', 400);
  }
  return null;
}

/** @constant {Array<object>} Section预设配置列表 */
const SECTION_PRESETS = [
  { name: 'info-panel', label: '信息面板', category: 'layout', description: '带边框的信息展示面板，适合仪表盘卡片', config: { variant: 'bordered', spacing: 'default', borderRadius: 'md' }, usage: 'Components.borderedSection(title, content, { borderRadius: "md" })' },
  { name: 'collapsible-details', label: '可折叠详情', category: 'interactive', description: '可折叠的详情区域，默认收起', config: { variant: 'collapsible', spacing: 'default', defaultCollapsed: true }, usage: 'Components.collapsibleSection(title, content, { defaultCollapsed: true })' },
  { name: 'accent-status', label: '状态指示', category: 'status', description: '带强调色的状态指示区域', config: { variant: 'accent', accentColor: 'primary', spacing: 'compact' }, usage: 'Components.accentSection(title, content, { accentColor: "primary", spacing: "compact" })' },
  { name: 'success-card', label: '成功卡片', category: 'status', description: '成功状态卡片', config: { variant: 'accent', accentColor: 'success', spacing: 'default', icon: '✅' }, usage: 'Components.accentSection(title, content, { accentColor: "success", icon: "✅" })' },
  { name: 'warning-card', label: '警告卡片', category: 'status', description: '警告状态卡片', config: { variant: 'accent', accentColor: 'warning', spacing: 'default', icon: '⚠️' }, usage: 'Components.accentSection(title, content, { accentColor: "warning", icon: "⚠️" })' },
  { name: 'danger-card', label: '危险卡片', category: 'status', description: '危险/错误状态卡片', config: { variant: 'accent', accentColor: 'danger', spacing: 'default', icon: '❌' }, usage: 'Components.accentSection(title, content, { accentColor: "danger", icon: "❌" })' },
  { name: 'hero-banner', label: '英雄横幅', category: 'layout', description: '大号英雄区横幅，适合页面顶部', config: { variant: 'hero', spacing: 'spacious', icon: '🚀' }, usage: 'Components.heroSection(title, content, { spacing: "spacious", icon: "🚀" })' },
  { name: 'compact-list', label: '紧凑列表', category: 'layout', description: '紧凑间距的列表区域', config: { variant: 'default', spacing: 'compact', titleSize: 'sm' }, usage: 'Components.section(title, content, { spacing: "compact", titleSize: "sm" })' },
  { name: 'nested-section', label: '嵌套区域', category: 'layout', description: '嵌套在父 Section 中的子区域', config: { variant: 'default', spacing: 'compact', className: 'ds-section--nested' }, usage: 'Components.section(title, content, { spacing: "compact", className: "ds-section--nested" })' },
  { name: 'loading-section', label: '加载状态', category: 'interactive', description: '显示加载骨架屏的 Section', config: { variant: 'bordered', spacing: 'default', loading: true }, usage: 'Components.section(title, "", { variant: "bordered", loading: true })' },
];

/** @constant {Object<string, string>} Section变体描述映射 */
const VARIANT_DESCRIPTIONS = {
  default: '标准Section，带标题和内容区域',
  collapsible: '可折叠Section，支持展开/收起动画',
  accent: '强调色Section，左侧带彩色边框',
  bordered: '边框Section，带完整边框和背景头部',
  hero: '英雄区Section，大号标题和主色下划线',
};

/** @constant {Object<string, string>} 强调色到CSS变量的映射 */
const ACCENT_COLOR_MAP = { primary: 'var(--primary)', success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)', purple: 'var(--purple)', cyan: 'var(--cyan)' };

/**
 * 实现设计审计API，验证源码并调用引擎审计
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} 审计结果
 * @private
 */
function _implDesignAudit(params, engine) {
  const source = params.get('source') ?? '';
  const type = params.get('type') ?? 'css';
  if (!VALID_DESIGN_TYPES.has(type)) return _apiError('Invalid type: must be one of css, html, js', 400);
  const v = _validateSource(source);
  if (v.error) return v;
  return engine.audit(v.decoded, type);
}

/**
 * 实现设计预设API，按类别返回排版、间距、颜色等设计预设
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @param {object} mixin - 混入对象（用于调用_getVariancePreset）
 * @returns {object} 设计预设数据
 * @private
 */
function _implDesignPresets(params, engine, mixin) {
  const category = params ? (params.get('category') ?? '') : '';
  const H = {
    'typography': function() { return engine.getTypographyScale(); },
    'spacing': function() { return engine.getSpacingScale(); },
    'color': function() { return engine.getColorSystem(params.get('name') ?? ''); },
    'motion': function() { return engine.getMotionPreset(params.get('name') ?? ''); },
    'responsive': function() { return engine.getResponsiveBreakpoints(params.get('name') ?? ''); },
    'hierarchy': function() { return engine.getVisualHierarchy(params.get('aspect') ?? ''); },
    'components': function() { return engine.getComponentTokens(params.get('name') ?? ''); },
    'micro-interactions': function() { return engine.getMicroInteractions(params.get('name') ?? ''); },
    'accessibility': function() { return engine.getAccessibilityStandards(params.get('aspect') ?? ''); },
    'interaction-states': function() { return engine.getInteractionStates(params.get('state') ?? ''); },
    'variance': function() { return mixin._getVariancePreset(params); },
  };
  const handler = H[category];
  if (handler) return handler();
  return mixin._getAllDesignPresets();
}

/**
 * 实现方差预设API，返回指定级别的设计方差配置
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} 方差预设数据
 * @private
 */
function _implVariancePreset(params, engine) {
  const level = params.get('level') ?? '';
  if (level && !VALID_DESIGN_VARIANCES.has(level)) return _apiError('Invalid level: must be one of conservative, balanced, creative, bold', 400);
  return engine.getDesignVariance(level);
}

/**
 * 实现全量设计预设API，返回所有设计系统预设
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} 全量设计预设数据
 * @private
 */
function _implAllDesignPresets(engine) {
  return {
    typography: engine.getTypographyScale(), spacing: engine.getSpacingScale(),
    colorSystems: Object.keys(DesignSkillEngine.COLOR_SYSTEMS), colorValues: DesignSkillEngine.COLOR_SYSTEMS,
    motionPresets: Object.keys(DesignSkillEngine.MOTION_PRESETS), motionValues: DesignSkillEngine.MOTION_PRESETS,
    responsiveBreakpoints: Object.keys(engine.getResponsiveBreakpoints()), responsiveValues: engine.getResponsiveBreakpoints(),
    visualHierarchy: Object.keys(engine.getVisualHierarchy()),
    componentTokens: Object.keys(engine.getComponentTokens()), componentValues: engine.getComponentTokens(),
    microInteractions: Object.keys(engine.getMicroInteractions()), microInteractionValues: engine.getMicroInteractions(),
    accessibilityStandards: Object.keys(engine.getAccessibilityStandards()), accessibilityValues: engine.getAccessibilityStandards(),
    interactionStates: Object.keys(engine.getInteractionStates()),
    varianceLevels: Object.keys(DesignSkillEngine.DESIGN_VARIANCE_LEVELS), varianceValues: DesignSkillEngine.DESIGN_VARIANCE_LEVELS,
  };
}

/**
 * 实现设计语言文档生成API，按公司、方差和动效强度生成设计文档
 * @param {object} params - 查询参数
 * @param {Function} parseIntParam - 整数参数解析函数
 * @param {object} engine - DesignSkillEngine实例
 * @returns {{content: string, options: object}|{_status: number, _data: object}} 设计文档或错误
 * @private
 */
function _implDesignMd(params, parseIntParam, engine) {
  const company = params.get('company') || 'vercel';
  const variance = params.get('variance') || 'balanced';
  const motionIntensity = parseIntParam(params, 'motion', 5);
  if (!VALID_DESIGN_COMPANIES.has(company)) return _apiError('Invalid company: must be one of vercel, stripe, apple, google, spotify, airbnb, github, linear, notion, figma, shopify, slack', 400);
  if (!VALID_DESIGN_VARIANCES.has(variance)) return _apiError('Invalid variance: must be one of conservative, balanced, creative, bold', 400);
  if (motionIntensity < 0 || motionIntensity > 10) return _apiError('Invalid motion: must be between 0 and 10', 400);
  const options = { company: company, variance: variance, motionIntensity: motionIntensity };
  return { content: engine.generateDesignMd(options), options: options };
}

/**
 * 实现对比度检查API，验证前景色和背景色的对比度
 * @param {object} params - 查询参数，含fg和bg十六进制颜色
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} 对比度检查结果
 * @private
 */
function _implCheckContrast(params, engine) {
  const fg = params.get('fg') ?? '';
  const bg = params.get('bg') ?? '';
  if (!fg || !bg) return _apiError('Both fg and bg color parameters are required (hex format, e.g. #ffffff)', 400);
  const fgErr = _validateHexColor(fg, 'fg');
  if (fgErr) return fgErr;
  const bgErr = _validateHexColor(bg, 'bg');
  if (bgErr) return bgErr;
  return engine.checkContrast(fg, bg);
}

/**
 * 实现无障碍审计API，验证源码的无障碍合规性
 * @param {object} params - 查询参数，含source
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} 无障碍审计结果
 * @private
 */
function _implAuditAccessibility(params, engine) {
  const source = params.get('source') ?? '';
  if (!source) return _apiError('source parameter is required', 400);
  const v = _validateSource(source);
  if (v.error) return v;
  return engine.auditAccessibility(v.decoded);
}

/**
 * 实现设计CSS生成API，按类型生成响应式、无障碍、Section或组件CSS
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @returns {{type: string, sections: Array}|{_status: number, _data: object}} CSS生成结果
 * @private
 */
function _implDesignCSS(params, engine) {
  const type = params.get('type') ?? 'all';
  if (!VALID_CSS_TYPES.has(type)) return _apiError('Invalid type parameter', 400);
  const parts = [];
  if (type === 'all' || type === 'responsive') parts.push({ label: 'responsive', css: engine.generateResponsiveCSS() });
  if (type === 'all' || type === 'accessibility') parts.push({ label: 'accessibility', css: engine.generateAccessibilityCSS() });
  if (type === 'all' || type === 'section') parts.push({ label: 'section', css: engine.generateSectionCSS() });
  if (type === 'component') {
    const component = params.get('component') ?? 'button';
    if (!VALID_CSS_COMPONENTS.has(component)) return _apiError('Invalid component parameter', 400);
    parts.push({ label: 'component-' + component, css: engine.generateComponentCSS(component) });
  }
  return { type: type, sections: parts };
}

/**
 * 实现Section令牌获取API，返回Section组件令牌和可选的变体/间距配置
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} Section令牌数据
 * @private
 */
function _implSectionTokens(params, engine) {
  const section = engine.getComponentTokens('section');
  if (!section) return _apiError('Section tokens not found', 404);
  const variant = params.get('variant') ?? '';
  const spacing = params.get('spacing') ?? '';
  const result = { component: 'section', tokens: section };
  if (variant) {
    if (!section.variants || !section.variants.includes(variant)) return _apiError('Invalid variant: must be one of ' + section.variants.join(', '), 400);
    result.activeVariant = variant;
  }
  if (spacing) {
    if (!section.spacing || !section.spacing[spacing]) return _apiError('Invalid spacing: must be one of ' + Object.keys(section.spacing ?? {}).join(', '), 400);
    result.activeSpacing = spacing;
    result.spacingValues = section.spacing[spacing];
  }
  return result;
}

/**
 * 验证Section CSS参数合法性
 * @param {object} section - Section令牌对象
 * @param {string} variant - 变体名
 * @param {string} spacing - 间距名
 * @param {string} accentColor - 强调色
 * @param {string} titleSize - 标题大小
 * @param {string} borderRadius - 圆角大小
 * @returns {{_status: number, _data: object}|null} 错误对象或null
 * @private
 */
function _implValidateSectionCSSParams(section, variant, spacing, accentColor, titleSize, borderRadius) {
  if (!section.variants.includes(variant)) return _apiError('Invalid variant: must be one of ' + section.variants.join(', '), 400);
  if (!section.spacing[spacing]) return _apiError('Invalid spacing: must be one of ' + Object.keys(section.spacing ?? {}).join(', '), 400);
  if (accentColor && !section.accentColors.includes(accentColor)) return _apiError('Invalid accentColor: must be one of ' + section.accentColors.join(', '), 400);
  if (titleSize && (!section.titleSizes || !section.titleSizes[titleSize])) return _apiError('Invalid titleSize: must be one of ' + Object.keys(section.titleSizes ?? {}).join(', '), 400);
  if (borderRadius && (!section.borderRadius || !section.borderRadius[borderRadius])) return _apiError('Invalid borderRadius: must be one of ' + Object.keys(section.borderRadius ?? {}).join(', '), 400);
  return null;
}

/**
 * 构建Section变体CSS代码
 * @param {object} section - Section令牌对象
 * @param {string} variant - 变体名
 * @param {string} spacing - 间距名
 * @param {string} titleSize - 标题大小
 * @param {string} borderRadius - 圆角大小
 * @param {string} accentColor - 强调色
 * @returns {string} 生成的CSS代码
 * @private
 */
function _implBuildSectionVariantCSS(section, variant, spacing, titleSize, borderRadius, accentColor) {
  let css = '/* section variant: ' + variant + ' */\n';
  css += '.ds-section--' + variant + ' {\n';
  const sp = section.spacing[spacing];
  css += '  --section-active-padding: ' + _sanitizeCssValue(sp.padding) + ';\n';
  css += '  --section-active-gap: ' + _sanitizeCssValue(sp.gap) + ';\n}\n';
  if (titleSize) css += '.ds-section--title-' + titleSize + ' .ds-section__header {\n  font-size: ' + _sanitizeCssValue(section.titleSizes[titleSize]) + ';\n}\n';
  if (borderRadius) css += '.ds-section--radius-' + borderRadius + ' {\n  border-radius: ' + _sanitizeCssValue(section.borderRadius[borderRadius]) + ';\n}\n';
  if (accentColor) css += '.ds-section--accent.ds-section--accent-' + accentColor + ' .ds-section__header {\n  border-left-color: ' + _sanitizeCssValue(ACCENT_COLOR_MAP[accentColor] || 'var(--primary)') + ';\n}\n';
  return css;
}

/**
 * 实现Section CSS生成API，生成基础和变体CSS
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @param {object} _mixin - 混入对象（未使用）
 * @returns {object} Section CSS数据
 * @private
 */
function _implSectionCSS(params, engine, _mixin) {
  const variant = params.get('variant') ?? 'default';
  const spacing = params.get('spacing') ?? 'default';
  const accentColor = params.get('accentColor') ?? '';
  const titleSize = params.get('titleSize') ?? '';
  const borderRadius = params.get('borderRadius') ?? '';
  const section = engine.getComponentTokens('section');
  if (!section) return _apiError('Section tokens not found', 404);
  const validationError = _implValidateSectionCSSParams(section, variant, spacing, accentColor, titleSize, borderRadius);
  if (validationError) return validationError;
  const baseCss = engine.generateSectionCSS();
  const variantCss = _implBuildSectionVariantCSS(section, variant, spacing, titleSize, borderRadius, accentColor);
  return { component: 'section', variant: variant, spacing: spacing, accentColor: accentColor ?? null, titleSize: titleSize ?? null, borderRadius: borderRadius ?? null, baseCSS: baseCss, variantCSS: variantCss, animation: section.animation };
}

/**
 * 实现Section变体列表API，返回所有可用变体、间距和样式选项
 * @param {object} engine - DesignSkillEngine实例
 * @returns {object} Section变体数据
 * @private
 */
function _implSectionVariants(engine) {
  const section = engine.getComponentTokens('section');
  if (!section) return _apiError('Section tokens not found', 404);
  return {
    component: 'section',
    variants: section.variants.map(function(v) { return { name: v, description: VARIANT_DESCRIPTIONS[v] || '', className: 'ds-section--' + v }; }),
    spacingOptions: Object.keys(section.spacing ?? {}).map(function(s) { return { name: s, values: section.spacing[s] }; }),
    titleSizes: section.titleSizes ? Object.keys(section.titleSizes).map(function(s) { return { name: s, value: section.titleSizes[s] }; }) : [],
    borderRadiusOptions: section.borderRadius ? Object.keys(section.borderRadius).map(function(s) { return { name: s, value: section.borderRadius[s] }; }) : [],
    accentColors: section.accentColors, animation: section.animation,
  };
}

/**
 * 验证Section配置字段，收集错误信息
 * @param {object} section - Section令牌对象
 * @param {object} fields - 待验证的字段对象
 * @param {Array} errors - 错误收集数组
 * @private
 */
function _implValidateSectionFields(section, fields, errors) {
  const V = [
    { value: fields.variant, check: function() { return !section.variants.includes(fields.variant); }, msg: function() { return 'Invalid variant: ' + fields.variant + '. Must be one of: ' + section.variants.join(', '); }, field: 'variant' },
    { value: fields.spacing, check: function() { return !section.spacing || !section.spacing[fields.spacing]; }, msg: function() { return 'Invalid spacing: ' + fields.spacing + '. Must be one of: ' + Object.keys(section.spacing ?? {}).join(', '); }, field: 'spacing' },
    { value: fields.accentColor, check: function() { return !section.accentColors.includes(fields.accentColor); }, msg: function() { return 'Invalid accentColor: ' + fields.accentColor + '. Must be one of: ' + section.accentColors.join(', '); }, field: 'accentColor' },
    { value: fields.collapsible, check: function() { return !['true', 'false'].includes(fields.collapsible); }, msg: function() { return 'Invalid collapsible: must be "true" or "false"'; }, field: 'collapsible' },
    { value: fields.titleSize, check: function() { return !section.titleSizes || !section.titleSizes[fields.titleSize]; }, msg: function() { return 'Invalid titleSize: ' + fields.titleSize + '. Must be one of: ' + Object.keys(section.titleSizes ?? {}).join(', '); }, field: 'titleSize' },
    { value: fields.borderRadius, check: function() { return !section.borderRadius || !section.borderRadius[fields.borderRadius]; }, msg: function() { return 'Invalid borderRadius: ' + fields.borderRadius + '. Must be one of: ' + Object.keys(section.borderRadius ?? {}).join(', '); }, field: 'borderRadius' },
  ];
  for (let i = 0; i < V.length; i++) { if (V[i].value && V[i].check()) errors.push({ field: V[i].field, message: V[i].msg() }); }
}

/**
 * 验证Section配置警告，收集非错误性的最佳实践建议
 * @param {string} variant - 变体名
 * @param {string} spacing - 间距名
 * @param {string} accentColor - 强调色
 * @param {string} borderRadius - 圆角大小
 * @param {Array} warnings - 警告收集数组
 * @private
 */
function _implValidateSectionWarnings(variant, spacing, accentColor, borderRadius, warnings) {
  if (variant === 'hero' && spacing === 'compact') warnings.push({ field: 'spacing', message: 'Hero variant with compact spacing may not look optimal' });
  if (variant === 'default' && accentColor) warnings.push({ field: 'accentColor', message: 'accentColor has no effect on default variant; use accent variant instead' });
  if (borderRadius && variant !== 'bordered') warnings.push({ field: 'borderRadius', message: 'borderRadius has most visual effect on bordered variant' });
}

/**
 * 实现Section配置验证API，返回验证结果、错误和警告
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @param {object} _mixin - 混入对象（未使用）
 * @returns {{valid: boolean, errors: Array, warnings: Array, config: object}} 验证结果
 * @private
 */
function _implValidateSectionConfig(params, engine, _mixin) {
  const variant = params.get('variant') ?? '';
  const spacing = params.get('spacing') ?? '';
  const accentColor = params.get('accentColor') ?? '';
  const collapsible = params.get('collapsible') ?? '';
  const titleSize = params.get('titleSize') ?? '';
  const borderRadius = params.get('borderRadius') ?? '';
  const section = engine.getComponentTokens('section');
  if (!section) return _apiError('Section tokens not found', 404);
  const errors = [];
  const warnings = [];
  _implValidateSectionFields(section, { variant: variant, spacing: spacing, accentColor: accentColor, collapsible: collapsible, titleSize: titleSize, borderRadius: borderRadius }, errors);
  _implValidateSectionWarnings(variant, spacing, accentColor, borderRadius, warnings);
  return { valid: errors.length === 0, errors: errors, warnings: warnings, config: { variant: variant || 'default', spacing: spacing || 'default', accentColor: accentColor ?? null, collapsible: collapsible === 'true', titleSize: titleSize ?? null, borderRadius: borderRadius ?? null } };
}

/**
 * 实现Section预设API，按类别过滤返回预设配置列表
 * @param {object} params - 查询参数
 * @param {object} engine - DesignSkillEngine实例
 * @returns {{component: string, presets: Array, categories: Array, total: number, filtered: number}} 预设数据
 * @private
 */
function _implSectionPresets(params, engine) {
  const category = params.get('category') ?? '';
  const section = engine.getComponentTokens('section');
  if (!section) return _apiError('Section tokens not found', 404);
  const filtered = category ? SECTION_PRESETS.filter(function(p) { return p.category === category; }) : SECTION_PRESETS;
  const categories = [];
  SECTION_PRESETS.forEach(function(p) { if (categories.indexOf(p.category) === -1) categories.push(p.category); });
  return { component: 'section', presets: filtered, categories: categories, total: SECTION_PRESETS.length, filtered: filtered.length };
}

/**
 * 将设计系统方法混入DashboardServer原型
 * @param {Function} Klass - DashboardServer类
 */
function applyDesignMixin(Klass) {
  Klass.prototype._getDesignAudit = function(p) { return _implDesignAudit(p, this._designEngine); };
  Klass.prototype._getDesignPresets = function(p) { return _implDesignPresets(p, this._designEngine, this); };
  Klass.prototype._getVariancePreset = function(p) { return _implVariancePreset(p, this._designEngine); };
  Klass.prototype._getAllDesignPresets = function() { return _implAllDesignPresets(this._designEngine); };
  Klass.prototype._getDesignCompanies = function(p) { return this._designEngine.getCompanyDesignLanguage(p.get('name') ?? null); };
  Klass.prototype._generateDesignMd = function(p) { return _implDesignMd(p, this._parseIntParam, this._designEngine); };
  Klass.prototype._getDesignStats = function() { return this._designEngine.getStats(); };
  Klass.prototype._checkContrast = function(p) { return _implCheckContrast(p, this._designEngine); };
  Klass.prototype._auditAccessibility = function(p) { return _implAuditAccessibility(p, this._designEngine); };
  Klass.prototype._generateDesignCSS = function(p) { return _implDesignCSS(p, this._designEngine); };
  Klass.prototype._getSectionTokens = function(p) { return _implSectionTokens(p, this._designEngine); };
  Klass.prototype._getSectionCSS = function(p) { return _implSectionCSS(p, this._designEngine, this); };
  Klass.prototype._validateSectionCSSParams = function(s, v, sp, a, t, b) { return _implValidateSectionCSSParams(s, v, sp, a, t, b); };
  Klass.prototype._buildSectionVariantCSS = function(s, v, sp, t, b, a) { return _implBuildSectionVariantCSS(s, v, sp, t, b, a); };
  Klass.prototype._getSectionVariants = function() { return _implSectionVariants(this._designEngine); };
  Klass.prototype._validateSectionFields = function(s, f, e) { return _implValidateSectionFields(s, f, e); };
  Klass.prototype._validateSectionWarnings = function(v, sp, a, b, w) { return _implValidateSectionWarnings(v, sp, a, b, w); };
  Klass.prototype._validateSectionConfig = function(p) { return _implValidateSectionConfig(p, this._designEngine, this); };
  Klass.prototype._getSectionPresets = function(p) { return _implSectionPresets(p, this._designEngine); };
}

module.exports = { applyDesignMixin };
