'use strict';

const { EventEmitter } = require('events');
const { validateProjectRoot, DESIGN_PATTERNS } = require('../utils/constants');
const deepClone = require('../utils/deep-clone');
const { withShutdown } = require('../utils/shutdown-mixin');
const { roundTo } = require('../utils/safe-execute');
const safeAssign = require('../utils/safe-assign');
const {
  TYPOGRAPHY_SCALE,
  SPACING_SCALE,
  COLOR_SYSTEMS,
  MOTION_PRESETS,
  RESPONSIVE_BREAKPOINTS,
  VISUAL_HIERARCHY,
  COMPONENT_TOKENS,
  MICRO_INTERACTIONS,
  ACCESSIBILITY_STANDARDS,
  INTERACTION_STATES,
  DESIGN_VARIANCE_LEVELS,
  ICON_COLLECTIONS,
  COMPANY_DESIGN_LANGUAGES,
  QUANTITATIVE_STANDARDS,
} = require('./design-tokens');

/** @constant {object} DESIGN_SCORE_CONFIG - 设计评分配置 */
const DESIGN_SCORE_CONFIG = {
  BASE: 100,
  HIGH_PENALTY: 15,
  MEDIUM_PENALTY: 8,
  LOW_PENALTY: 3,
  MAX_ISSUE_COUNT: 3,
  GRADES: { A: 90, B: 75, C: 60, D: 40 },
};

/** @constant {object} A11Y_SCORE_CONFIG - 无障碍评分配置 */
const A11Y_SCORE_CONFIG = {
  BASE: 100,
  HIGH_PENALTY: 20,
  MEDIUM_PENALTY: 10,
  LOW_PENALTY: 5,
};

/** @constant {object} CRITIQUE_WEIGHTS - 审美评审6维度权重配置 */
const CRITIQUE_WEIGHTS = {
  layout: { weight: 0.20, label: '视觉层次' },
  color: { weight: 0.20, label: '色彩品味' },
  typography: { weight: 0.15, label: '排版品味' },
  spacing: { weight: 0.10, label: '间距品味' },
  motion: { weight: 0.10, label: '动效品味' },
  userPath: { weight: 0.25, label: '用户路径' },
};

/** @constant {object} CRITIQUE_GRADES - 审美评级标准 */
const CRITIQUE_GRADES = { A: 90, B: 75, C: 60, D: 40 };

/** @constant {object} MOTION_PERFORMANCE_RULES - 动效性能规则 */
const MOTION_PERFORMANCE_RULES = {
  must: [
    { id: 'animate-transform-opacity-only', pattern: /animation:[^;]*(?:width|height|top|left|right|bottom|margin|padding)/gi, message: '仅动画transform/opacity，避免布局属性动画', severity: 'high' },
    { id: 'no-animation-all', pattern: /animation:\s*all\s/gi, message: '禁止animation: all，指定具体属性', severity: 'high' },
    { id: 'no-infinite-animation', pattern: /animation-iteration-count:\s*infinite/gi, message: '禁止无限循环动画（loading除外）', severity: 'medium' },
  ],
  mustNot: [
    { id: 'no-animate-layout-props', pattern: /transition:[^;]*(?:width|height|top|left|right|bottom|margin|padding)/gi, message: '禁止过渡布局属性，使用transform替代', severity: 'high' },
  ],
};

/** @constant {object} LAYOUT_ANTI_PATTERNS - 布局反模式规则 */
const LAYOUT_ANTI_PATTERNS = {
  fixedWidth: { id: 'no-fixed-width', pattern: /width:\s*\d{4,}px/gi, severity: 'medium', message: '避免过大的固定宽度，使用max-width或响应式单位', fix: '使用max-width或百分比宽度' },
  importantOverride: { id: 'no-important', pattern: /!important/gi, severity: 'low', message: '避免!important覆盖，使用CSS特异性', fix: '提高选择器特异性替代!important' },
};

/** @constant {object} ANTI_PATTERNS - 设计反模式规则集 */
const ANTI_PATTERNS = {
  color: {
    id: 'no-pure-black',
    severity: 'high',
    pattern: new RegExp(DESIGN_PATTERNS.PURE_BLACK.source, 'gi'),
    message: '禁止使用纯黑 #000000，使用偏黑色如 Zinc-950 (#09090b)、Charcoal (#1a1a2e)',
    fix: '#09090b',
  },
  glow: {
    id: 'no-neon-glow',
    severity: 'high',
    pattern: new RegExp(DESIGN_PATTERNS.NEON_GLOW.source, 'gi'),
    message: '禁止霓虹外发光效果，使用柔和的阴影层次',
    fix: 'box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06)',
  },
  gradient: {
    id: 'no-ai-gradient',
    severity: 'high',
    pattern: new RegExp(DESIGN_PATTERNS.AI_GRADIENT.source, 'gi'),
    message: '禁止紫蓝AI渐变配色，这是AI生成的典型标志',
    fix: '使用单色系或互补色低饱和度渐变',
  },
  shadow: {
    id: 'no-default-shadow',
    severity: 'medium',
    pattern: new RegExp(DESIGN_PATTERNS.DEFAULT_LARGE_SHADOW.source, 'gi'),
    message: '禁止大面积默认阴影，使用分层阴影系统',
    fix: 'box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 2px 4px rgba(0,0,0,.05), 0 4px 8px rgba(0,0,0,.05)',
  },
  saturation: {
    id: 'no-oversaturated',
    severity: 'medium',
    pattern: new RegExp(DESIGN_PATTERNS.OVERSATURATED.source, 'gi'),
    message: '避免过饱和色彩，降低饱和度至60-80%区间',
    fix: '降低饱和度至60-80%',
  },
  font: {
    id: 'no-system-font',
    severity: 'low',
    pattern: new RegExp(DESIGN_PATTERNS.SYSTEM_FONT.source, 'gi'),
    message: '避免系统默认字体，使用专业字体栈',
    fix: "font-family: 'Inter', 'SF Pro Display', -apple-system, sans-serif",
  },
};

/**
 * @module gate/design-skill-engine
 * 设计技能引擎。反模式检测，5大设计语言预设，无障碍审计，CSS生成，
 * 基于设计令牌体系实现视觉质量评估与改进建议。
 */
/**
 * @classdesc 设计技能引擎。反模式检测、审美评分、无障碍审计
 * 设计技能引擎。反模式检测，5大设计语言预设，无障碍审计，CSS生成，
 * 基于设计令牌体系实现视觉质量评估与改进建议。
 */
class DesignSkillEngine extends EventEmitter {
  /**
   * 创建DesignSkillEngine实例。
   * @param {string} projectRoot - 项目根目录路径
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'DesignSkillEngine');
    this.root = projectRoot;
    this._antiPatterns = ANTI_PATTERNS;
    this._typographyScale = TYPOGRAPHY_SCALE;
    this._spacingScale = SPACING_SCALE;
    this._colorSystems = COLOR_SYSTEMS;
    this._motionPresets = MOTION_PRESETS;
    this._responsiveBreakpoints = RESPONSIVE_BREAKPOINTS;
    this._visualHierarchy = VISUAL_HIERARCHY;
    this._componentTokens = COMPONENT_TOKENS;
    this._microInteractions = MICRO_INTERACTIONS;
    this._accessibilityStandards = ACCESSIBILITY_STANDARDS;
    this._interactionStates = INTERACTION_STATES;
    this._designVarianceLevels = DESIGN_VARIANCE_LEVELS;
    this._iconCollections = ICON_COLLECTIONS;
    this._companyDesignLanguages = COMPANY_DESIGN_LANGUAGES;
    this._quantitativeStandards = QUANTITATIVE_STANDARDS;
  }

  /**
   * 审计CSS源码的设计质量，检测反模式并评分。
   * @param {string} source - CSS源码
   * @param {string} [_type] - 文件类型（可选）
   * @returns {{score: number, issues: Array, summary: string, grade: string}} 审计结果，包含评分、问题列表、摘要和等级
   */
  audit(source, _type) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return { score: 0, issues: [], summary: '空输入' };

    const issues = [];
    const self = this;

    const printRanges = [];
    const printRe = /@media\s+print\s*\{/g;
    let pm;
    while ((pm = printRe.exec(source)) !== null) {
      const start = pm.index;
      let depth = 1;
      let i = start + pm[0].length;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      printRanges.push([start, i - 1]);
    }

    function isInPrintBlock(index) {
      for (let k = 0; k < printRanges.length; k++) {
        if (index >= printRanges[k][0] && index <= printRanges[k][1]) return true;
      }
      return false;
    }

    for (const key of Object.keys(this._antiPatterns)) {
      const rule = self._antiPatterns[key];
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      let count = 0;
      const sampleMatches = [];
      while ((m = re.exec(source)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (isInPrintBlock(m.index)) continue;
        count++;
        if (sampleMatches.length < 5) sampleMatches.push(m[0]);
      }
      if (count > 0) {
        issues.push({
          ruleId: rule.id,
          severity: rule.severity,
          count: count,
          message: rule.message,
          fix: rule.fix,
          matches: sampleMatches,
        });
      }
    }

    let score = DESIGN_SCORE_CONFIG.BASE;
    issues.forEach(function(issue) {
      if (issue.severity === 'high') score -= DESIGN_SCORE_CONFIG.HIGH_PENALTY * Math.min(issue.count, DESIGN_SCORE_CONFIG.MAX_ISSUE_COUNT);
      else if (issue.severity === 'medium') score -= DESIGN_SCORE_CONFIG.MEDIUM_PENALTY * Math.min(issue.count, DESIGN_SCORE_CONFIG.MAX_ISSUE_COUNT);
      else score -= DESIGN_SCORE_CONFIG.LOW_PENALTY * Math.min(issue.count, DESIGN_SCORE_CONFIG.MAX_ISSUE_COUNT);
    });
    score = Math.max(0, score);

    return {
      score: score,
      issues: issues,
      summary: '发现 ' + issues.length + ' 个设计问题，评分 ' + score + '/100',
      grade: score >= DESIGN_SCORE_CONFIG.GRADES.A ? 'A' : score >= DESIGN_SCORE_CONFIG.GRADES.B ? 'B' : score >= DESIGN_SCORE_CONFIG.GRADES.C ? 'C' : score >= DESIGN_SCORE_CONFIG.GRADES.D ? 'D' : 'F',
    };
  }

  /**
   * 修正CSS源码中的设计问题，替换纯黑色、系统字体和缓动函数。
   * @param {string} source - CSS源码
   * @returns {string} 修正后的CSS源码
   */
  polish(source) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return source;

    let result = source;

    result = result.replace(/#000000/g, '#09090b');
    result = result.replace(/#000\b/g, '#09090b');
    result = result.replace(/rgb\(0,\s*0,\s*0\)/g, 'rgb(9,9,11)');
    result = result.replace(/rgba\(0,\s*0,\s*0,/g, 'rgba(9,9,11,');

    result = result.replace(
      /font-family:\s*['"]?Arial['"]?/gi,
      "font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    );
    result = result.replace(
      /font-family:\s*['"]?Times New Roman['"]?/gi,
      "font-family: 'SF Pro Display', 'Inter', Georgia, serif",
    );

    result = result.replace(
      /transition:\s*all\s+(0\.\d+)s\s+ease/g,
      'transition: all $1s cubic-bezier(0.4, 0, 0.2, 1)',
    );

    result = result.replace(
      /box-shadow:\s*0\s+0\s+(?:20|30|40|50)px\s+(?:rgba\([0-9.]+,\s*[0-9.]+,\s*[0-9.]+,\s*[0-9.]+\)|[a-zA-Z]+)/gi,
      'box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06)',
    );

    result = result.replace(
      /background:\s*linear-gradient\(\s*(?:135deg|to\s+bottom\s+right)\s*,\s*(?:#7c3aed|#8b5cf6|#6366f1|#4f46e5)\s[^;]*?(?:#3b82f6|#2563eb|#06b6d4|#0ea5e9)\s[^;]*?\)/gi,
      'background: linear-gradient(135deg, #18181b, #27272a)',
    );

    result = result.replace(
      /hsl\(\s*(\d+)\s*,\s*(100|9[5-9])%\s*,\s*(\d+)%\s*\)/gi,
      function(_match, h, _s, l) {
        return 'hsl(' + h + ', 70%, ' + l + '%)';
      },
    );

    return result;
  }

  /**
   * 强化CSS源码的健壮性，自动补充溢出处理、文本截断和长单词断行。
   * @param {string} source - CSS源码
   * @returns {string} 强化后的CSS源码
   */
  harden(source) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return source;

    let result = source;
    const patches = [];

    if (!result.match(/overflow:\s*(?:hidden|auto|scroll)/g)) {
      patches.push('添加overflow处理防止内容溢出');
    }
    result = result.replace(
      /(\.[a-zA-Z_-][\w-]*\s*\{[^}]*)(\})/g,
      function(match, before, after) {
        if (!before.match(/overflow/) && before.match(/(?:width|height|position)/)) {
          return before + '  overflow: hidden;\n' + after;
        }
        return match;
      },
    );

    if (!result.match(/text-overflow/g)) {
      patches.push('添加text-overflow处理长文本');
    }
    result = result.replace(
      /(\.[a-zA-Z_-][\w-]*\s*\{[^}]*white-space:\s*nowrap[^}]*)(\})/g,
      function(match, before, after) {
        if (!before.match(/text-overflow/)) {
          return before + '  text-overflow: ellipsis;\n' + after;
        }
        return match;
      },
    );

    if (!result.match(/word-break|overflow-wrap/g)) {
      patches.push('添加word-break/overflow-wrap处理长单词');
    }
    result = result.replace(
      /(body\s*\{[^}]*)(\})/g,
      function(match, before, after) {
        if (!before.match(/word-break|overflow-wrap/)) {
          return before + '  overflow-wrap: break-word;\n  word-break: break-word;\n' + after;
        }
        return match;
      },
    );

    return result;
  }

  /**
   * 获取排版比例尺的深拷贝。
   * @returns {object} 排版比例尺配置
   */
  getTypographyScale() {
    return deepClone(this._typographyScale);
  }

  /**
   * 获取间距比例尺的深拷贝。
   * @returns {object} 间距比例尺配置
   */
  getSpacingScale() {
    return deepClone(this._spacingScale);
  }

  /**
   * 获取色彩系统配置。
   * @param {string} [name] - 色彩系统名称（如'zinc'、'slate'、'neutral'），不传则返回全部
   * @returns {object|null} 色彩系统配置，未找到时返回null
   */
  getColorSystem(name) {
    if (!name) return deepClone(this._colorSystems);
    const system = this._colorSystems[name];
    return system ? deepClone(system) : null;
  }

  /**
   * 获取动效预设配置。
   * @param {string} [name] - 预设名称（如'micro'、'smooth'、'spring'），不传则返回全部
   * @returns {object|null} 动效预设配置，未找到时返回null
   */
  getMotionPreset(name) {
    if (!name) return deepClone(this._motionPresets);
    const preset = this._motionPresets[name];
    return preset ? deepClone(preset) : null;
  }

  /**
   * 获取设计方差级别配置。
   * @param {string} [level] - 方差级别（如'conservative'、'balanced'、'creative'、'bold'），不传则返回全部
   * @returns {object|null} 方差级别配置，未找到时返回null
   */
  getDesignVariance(level) {
    if (!level) return deepClone(this._designVarianceLevels);
    return this._designVarianceLevels[level] ? deepClone(this._designVarianceLevels[level]) : null;
  }

  /**
   * 获取公司设计语言配置。
   * @param {string} [company] - 公司名称（如'apple'、'stripe'、'vercel'、'notion'、'github'），不传则返回全部
   * @returns {object|null} 公司设计语言配置，未找到时返回null
   */
  getCompanyDesignLanguage(company) {
    if (!company) return deepClone(this._companyDesignLanguages);
    return this._companyDesignLanguages[company] ? deepClone(this._companyDesignLanguages[company]) : null;
  }

  /**
   * 获取图标集合列表的副本。
   * @returns {string[]} 图标集合名称列表
   */
  getIconCollections() {
    return this._iconCollections.slice();
  }

  /**
   * 获取响应式断点配置。
   * @param {string} [name] - 断点名称（如'xs'、'sm'、'md'、'lg'、'xl'），不传则返回全部
   * @returns {object|null} 断点配置，未找到时返回null
   */
  getResponsiveBreakpoints(name) {
    if (!name) return deepClone(this._responsiveBreakpoints);
    return this._responsiveBreakpoints[name] ? deepClone(this._responsiveBreakpoints[name]) : null;
  }

  /**
   * 获取视觉层次配置。
   * @param {string} [aspect] - 方面名称（如'shadows'、'zIndex'、'opacity'），不传则返回全部
   * @returns {object|null} 视觉层次配置，未找到时返回null
   */
  getVisualHierarchy(aspect) {
    if (!aspect) return deepClone(this._visualHierarchy);
    return this._visualHierarchy[aspect] ? deepClone(this._visualHierarchy[aspect]) : null;
  }

  /**
   * 获取组件令牌配置。
   * @param {string} [component] - 组件名称（如'section'、'button'、'input'、'card'、'modal'、'toast'），不传则返回全部
   * @returns {object|null} 组件令牌配置，未找到时返回null
   */
  getComponentTokens(component) {
    if (!component) return deepClone(this._componentTokens);
    return this._componentTokens[component] ? deepClone(this._componentTokens[component]) : null;
  }

  /**
   * 获取微交互配置。
   * @param {string} [name] - 交互名称（如'hover'、'press'、'focus'、'toggle'等），不传则返回全部
   * @returns {object|null} 微交互配置，未找到时返回null
   */
  getMicroInteractions(name) {
    if (!name) return deepClone(this._microInteractions);
    return this._microInteractions[name] ? deepClone(this._microInteractions[name]) : null;
  }

  /**
   * 获取无障碍标准配置。
   * @param {string} [aspect] - 方面名称（如'contrastRatios'、'focusRequirements'、'touchTargets'等），不传则返回全部
   * @returns {object|null} 无障碍标准配置，未找到时返回null
   */
  getAccessibilityStandards(aspect) {
    if (!aspect) return deepClone(this._accessibilityStandards);
    return this._accessibilityStandards[aspect] ? deepClone(this._accessibilityStandards[aspect]) : null;
  }

  /**
   * 获取交互状态配置。
   * @param {string} [state] - 状态名称（如'idle'、'hover'、'active'、'focus'、'disabled'等），不传则返回全部
   * @returns {object|null} 交互状态配置，未找到时返回null
   */
  getInteractionStates(state) {
    if (!state) return deepClone(this._interactionStates);
    return this._interactionStates[state] ? deepClone(this._interactionStates[state]) : null;
  }

  /**
   * 检查前景色和背景色的对比度是否符合WCAG标准。
   * @param {string} fg - 前景色（支持#hex和rgb/rgba格式）
   * @param {string} bg - 背景色（支持#hex和rgb/rgba格式）
   * @returns {{ratio: number, aa: boolean, aaLarge: boolean, aaa: boolean, aaaLarge: boolean, fg: string, bg: string, invalid?: boolean}} 对比度检查结果
   */
  checkContrast(fg, bg) {
    const fgParsed = this._parseColor(fg);
    const bgParsed = this._parseColor(bg);
    if (!fgParsed || !bgParsed) {
      return { ratio: 0, aa: false, aaa: false, aaaLarge: false, aaLarge: false, fg, bg, invalid: true };
    }
    const fgLum = this._relativeLuminance(fgParsed);
    const bgLum = this._relativeLuminance(bgParsed);
    const lighter = Math.max(fgLum, bgLum);
    const darker = Math.min(fgLum, bgLum);
    const ratio = (lighter + 0.05) / (darker + 0.05);
    return {
      ratio: roundTo(ratio, 2),
      aa: ratio >= 4.5,
      aaLarge: ratio >= 3,
      aaa: ratio >= 7,
      aaaLarge: ratio >= 4.5,
      fg,
      bg,
    };
  }

  _parseColor(color) {
    if (!color || typeof color !== 'string') return null;
    if (color.startsWith('#')) {
      const cleaned = color.replace('#', '');
      if (cleaned.length === 3) return '#' + cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2];
      if (cleaned.length === 4) return '#' + cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2];
      if (cleaned.length === 6) return color;
      if (cleaned.length === 8) return color.toLowerCase();
      return null;
    }
    const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
      const r = Math.min(255, Math.max(0, Number.isFinite(parseInt(rgbMatch[1], 10)) ? parseInt(rgbMatch[1], 10) : 0)).toString(16).padStart(2, '0');
      const g = Math.min(255, Math.max(0, Number.isFinite(parseInt(rgbMatch[2], 10)) ? parseInt(rgbMatch[2], 10) : 0)).toString(16).padStart(2, '0');
      const b = Math.min(255, Math.max(0, Number.isFinite(parseInt(rgbMatch[3], 10)) ? parseInt(rgbMatch[3], 10) : 0)).toString(16).padStart(2, '0');
      return '#' + r + g + b;
    }
    return null;
  }

  _relativeLuminance(hex) {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return 0;
    let cleaned = hex.replace('#', '');
    if (cleaned.length === 3) {
      cleaned = cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2];
    }
    if (cleaned.length !== 6) return 0;
    const r = parseInt(cleaned.substring(0, 2), 16);
    const g = parseInt(cleaned.substring(2, 4), 16);
    const b = parseInt(cleaned.substring(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 0;
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const toLinear = function(c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * toLinear(rn) + 0.7152 * toLinear(gn) + 0.0722 * toLinear(bn);
  }

  _sanitizeCssIdentifier(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  _sanitizeCssValue(str) {
    return String(str).replace(/[;{}\/]/g, '');
  }

  /**
   * 生成响应式CSS变量。
   * @returns {string} 响应式CSS代码
   */
  generateResponsiveCSS() {
    const parts = [];
    for (const [_bp, config] of Object.entries(this._responsiveBreakpoints)) {
      if (config.minWidth > 0) {
        parts.push(
          '@media (min-width: ' + config.minWidth + 'px) {\n',
          '  :root {\n',
          '    --grid-columns: ' + config.columns + ';\n',
          '    --grid-margin: ' + config.margin + ';\n',
          '    --grid-gutter: ' + config.gutter + ';\n',
          '  }\n}\n',
        );
      }
    }
    return parts.join('');
  }

  /**
   * 生成无障碍CSS变量和样式。
   * @returns {string} 无障碍CSS代码
   */
  generateAccessibilityCSS() {
    if (!this.isHealthy()) return '';
    const a11y = this._accessibilityStandards ?? {};
    const motion = a11y.motionPreferences ?? {};
    const focus = a11y.focusRequirements ?? {};
    const touch = a11y.touchTargets ?? {};
    const fonts = a11y.fontSizes ?? {};
    const zIndex = (this._visualHierarchy ?? {}).zIndex ?? {};
    const fallbackDur = motion.fallbackDuration ?? 0;
    return [
      ':root {\n',
      `  --a11y-focus-ring: ${focus.ringStyle ?? '2px solid #005fcc'};\n`,
      `  --a11y-min-touch: ${touch.minimum ?? '44px'};\n`,
      `  --a11y-min-font: ${fonts.minimum ?? '16px'};\n`,
      '}\n\n',
      '@media (prefers-reduced-motion: reduce) {\n',
      '  *, *::before, *::after {\n',
      `    animation-duration: ${fallbackDur}ms !important;\n`,
      `    transition-duration: ${fallbackDur}ms !important;\n`,
      '  }\n}\n\n',
      '.skip-link {\n',
      '  position: absolute;\n',
      '  top: -100%;\n',
      '  left: 0;\n',
      `  z-index: ${zIndex.notification ?? 9999};\n`,
      '  padding: 8px 16px;\n',
      '  background: var(--color-primary);\n',
      '  color: var(--color-on-primary);\n',
      '}\n',
      '.skip-link:focus {\n',
      '  top: 0;\n',
      '}\n',
    ].join('');
  }

  /**
   * 生成组件CSS变量。
   * @param {string} component - 组件名称
   * @returns {string} 组件CSS变量代码，未找到组件时返回空字符串
   */
  generateComponentCSS(component) {
    const tokens = this._componentTokens[component];
    if (!tokens) return '';
    const safeComponent = this._sanitizeCssIdentifier(component);
    const parts = [`/* ${safeComponent} component tokens */\n`, ':root {\n'];
    if (tokens.sizes) {
      for (const [size, s] of Object.entries(tokens.sizes)) {
        const safeSize = this._sanitizeCssIdentifier(size);
        for (const [prop, val] of Object.entries(s)) {
          parts.push(`  --${safeComponent}-${safeSize}-${this._sanitizeCssIdentifier(prop)}: ${this._sanitizeCssValue(val)};\n`);
        }
      }
    }
    if (tokens.borderRadius) {
      for (const [radius, val] of Object.entries(tokens.borderRadius)) {
        parts.push(`  --${safeComponent}-radius-${this._sanitizeCssIdentifier(radius)}: ${this._sanitizeCssValue(val)};\n`);
      }
    }
    parts.push('}\n');
    return parts.join('');
  }

  /**
   * 生成Section组件CSS变量。
   * @returns {string} Section组件CSS变量代码
   */
  generateSectionCSS() {
    const tokens = this._componentTokens.section;
    if (!tokens) return '';
    const parts = ['/* section component tokens */\n', ':root {\n'];
    if (tokens.animation) {
      parts.push(`  --section-collapse-duration: ${this._sanitizeCssValue(tokens.animation.collapseDuration)}ms;\n`);
      parts.push(`  --section-collapse-easing: ${this._sanitizeCssValue(tokens.animation.collapseEasing)};\n`);
    }
    for (const [size, s] of Object.entries(tokens.spacing ?? {})) {
      const safeSize = this._sanitizeCssIdentifier(size);
      parts.push(`  --section-spacing-${safeSize}-padding: ${this._sanitizeCssValue(s.padding)};\n`);
      parts.push(`  --section-spacing-${safeSize}-gap: ${this._sanitizeCssValue(s.gap)};\n`);
    }
    for (const [size, val] of Object.entries(tokens.titleSizes ?? {})) {
      parts.push(`  --section-title-size-${this._sanitizeCssIdentifier(size)}: ${this._sanitizeCssValue(val)};\n`);
    }
    for (const [size, val] of Object.entries(tokens.borderRadius ?? {})) {
      parts.push(`  --section-radius-${this._sanitizeCssIdentifier(size)}: ${this._sanitizeCssValue(val)};\n`);
    }
    const accentColorMap = { primary: 'var(--primary)', success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)', purple: 'var(--purple)', cyan: 'var(--cyan)' };
    for (const color of Array.isArray(tokens.accentColors) ? tokens.accentColors : []) {
      parts.push(`  --section-accent-${this._sanitizeCssIdentifier(color)}: ${accentColorMap[color] || 'var(--primary)'};\n`);
    }
    parts.push('}\n');
    return parts.join('');
  }

  /**
   * 审计HTML/CSS源码的无障碍合规性。
   * @param {string} source - HTML/CSS源码
   * @returns {{score: number, issues: Array, summary: string}} 无障碍审计结果
   * @throws {Error} When source parameter is not a string
   */
  auditAccessibility(source) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return { score: 0, issues: [], summary: '空输入' };
    const issues = this._checkA11yBasic(source);
    const extraIssues = this._checkA11ySemantic(source);
    const allIssues = issues.concat(extraIssues);
    let score = A11Y_SCORE_CONFIG.BASE;
    allIssues.forEach(function(issue) {
      if (issue.severity === 'high') score -= A11Y_SCORE_CONFIG.HIGH_PENALTY;
      else if (issue.severity === 'medium') score -= A11Y_SCORE_CONFIG.MEDIUM_PENALTY;
      else score -= A11Y_SCORE_CONFIG.LOW_PENALTY;
    });
    return { score: Math.max(0, score), issues: allIssues, summary: '发现 ' + allIssues.length + ' 个无障碍问题，评分' + Math.max(0, score) + '/100' };
  }

  _checkA11yBasic(source) {
    if (typeof source !== 'string') return [];
    const issues = [];
    if (!source.match(/aria-/g)) {
      issues.push({ ruleId: 'missing-aria', severity: 'high', message: '缺少ARIA属性，确保语义化标签', fix: '添加role、aria-label、aria-describedby等属性' });
    }
    if (!source.match(/alt=["']/g) && source.match(/<img/g)) {
      issues.push({ ruleId: 'missing-alt', severity: 'high', message: '图片缺少alt文本', fix: '为所有img添加有意义的alt属性' });
    }
    const hasLabel = source.match(/<label/g);
    const hasAriaLabel = source.match(/aria-label\s*=/g) || source.match(/aria-labelledby\s*=/g);
    if (!hasLabel && !hasAriaLabel && source.match(/<(?:input|select|textarea)\b/g)) {
      issues.push({ ruleId: 'missing-label', severity: 'high', message: '表单控件缺少关联label', fix: '使用<label for>或aria-label关联标签' });
    }
    if (!source.match(/prefers-reduced-motion/g) && source.match(/[\{;]\s*(?:animation|transition)(?:-[^:]+)?\s*:/g)) {
      issues.push({ ruleId: 'no-reduced-motion', severity: 'medium', message: '动画未适配prefers-reduced-motion', fix: '添加@media (prefers-reduced-motion: reduce)回退样式' });
    }
    if (!source.match(/:focus/g) && !source.match(/:focus-visible/g)) {
      issues.push({ ruleId: 'no-focus-style', severity: 'high', message: '缺少焦点样式，键盘用户无法导航', fix: '添加:focus-visible样式和焦点环' });
    }
    if (source.match(/color:\s*#[0-9a-fA-F]{3,6}/g) && !source.match(/background/g)) {
      issues.push({ ruleId: 'color-only', severity: 'medium', message: '可能仅依赖颜色传达信息', fix: '确保不仅依赖颜色，同时使用图标或文字标注' });
    }
    return issues;
  }

  _checkA11ySemantic(source) {
    if (typeof source !== 'string') return [];
    const issues = [];
    if (!source.match(/<(?:header|nav|main|footer|aside|section|article)/g) && source.match(/<div/g)) {
      issues.push({ ruleId: 'no-semantic-html', severity: 'medium', message: '缺少语义化HTML标签，使用div代替了语义标签', fix: '使用header/nav/main/footer/aside/section/article替代div' });
    }
    if (!source.match(/tabindex/g) && source.match(/onclick/g)) {
      issues.push({ ruleId: 'no-keyboard-nav', severity: 'high', message: '有点击事件但无键盘导航支持', fix: '添加tabindex和键盘事件处理器' });
    }
    if (!source.match(/role=/g) && source.match(/<div[^>]*onclick/g)) {
      issues.push({ ruleId: 'no-role-attribute', severity: 'medium', message: '可交互div缺少role属性', fix: '为可交互元素添加role="button"等ARIA角色' });
    }
    return issues;
  }

  /**
   * 生成DESIGN.md设计语言文档。
   * @param {object} [options] - 生成选项
   * @param {string} [options.company='vercel'] - 公司设计语言名称
   * @param {string} [options.variance='balanced'] - 设计方差级别
   * @param {number} [options.motionIntensity=5] - 动效强度（1-10）
   * @returns {string} Markdown格式的设计语言文档
   */
  generateDesignMd(options) {
    const opts = options ?? {};
    const company = opts.company ?? 'vercel';
    const variance = opts.variance ?? 'balanced';
    const motionIntensity = Number.isFinite(opts.motionIntensity) ? opts.motionIntensity : 5;
    const lang = this._companyDesignLanguages[company] || this._companyDesignLanguages.vercel;
    const varianceInfo = this._designVarianceLevels[variance] || this._designVarianceLevels.balanced;

    let md = '# DESIGN.md 模板' + lang.name + ' Design Language\n\n';
    md += '## Design Variance: ' + varianceInfo.variance + ' (' + varianceInfo.description + ')\n\n';
    md += '## Motion Intensity: ' + motionIntensity + '/10\n\n';
    md += '## Color System\n\n';
    md += '```css\n';
    md += ':root {\n';
    md += '  --color-primary: ' + lang.colors.primary + ';\n';
    md += '  --color-bg: ' + lang.colors.bg + ';\n';
    md += '  --color-surface: ' + lang.colors.surface + ';\n';
    md += '  --color-text: ' + lang.colors.text + ';\n';
    md += '}\n```\n\n';
    md += '## Typography Scale\n\n';
    md += '| Level | Size | Line Height | Weight | Tracking |\n';
    md += '|-------|------|-------------|--------|----------|\n';
    for (const level of Object.keys(this._typographyScale)) {
      const t = this._typographyScale[level];
      md += '| ' + level + ' | ' + t.size + ' | ' + t.lineHeight + ' | ' + t.weight + ' | ' + t.tracking + ' |\n';
    }
    md += '\n## Spacing Scale\n\n';
    md += 'Based on 4px grid: ' + JSON.stringify(this._spacingScale ?? {}) + '\n\n';
    md += '## Border Radius: ' + (lang.borderRadius || 'default') + '\n\n';
    md += '## Motion\n\n';
    md += 'Style: ' + (lang.motion || 'default') + '\n\n';
    md += '```css\n';
    for (const preset of Object.keys(this._motionPresets)) {
      const m = this._motionPresets[preset];
      md += '/* ' + preset + ': ' + m.duration + 'ms */\n';
      md += '--ease-' + preset + ': ' + m.easing + ';\n';
    }
    md += '```\n\n';
    md += '## Anti-Patterns (禁止)\n\n';
    for (const key of Object.keys(this._antiPatterns)) {
      const rule = this._antiPatterns[key];
      md += '- **' + rule.id + '** [' + rule.severity + ']: ' + rule.message + '\n';
    }
    md += '\n## Suitable For: ' + lang.suitable + '\n';

    return md;
  }

  /**
   * 对CSS源码进行设计评审，按领域输出反馈。
   * @param {string} source - CSS源码
   * @param {string} [focusArea] - 聚焦领域（如'color'、'typography'、'spacing'等）
   * @returns {{overallScore: number, grade: string, feedback: Array, summary: string}} 评审结果
   */
  critique(source, focusArea) {
    this.guardShutdown();
    const auditResult = this.audit(source);
    const areas = focusArea ? [focusArea] : Object.keys(CRITIQUE_WEIGHTS);
    const feedback = [];
    const dimensionScores = {};

    areas.forEach(function(area) {
      const weightConfig = CRITIQUE_WEIGHTS[area];
      const weight = weightConfig ? weightConfig.weight : 0.1;
      const label = weightConfig ? weightConfig.label : area;

      const areaIssues = auditResult.issues.filter(function(i) {
        return i.ruleId.indexOf(area) >= 0 || i.message.toLowerCase().indexOf(area) >= 0;
      });

      let dimScore = 100;
      areaIssues.forEach(function(issue) {
        if (issue.severity === 'high') dimScore -= 20;
        else if (issue.severity === 'medium') dimScore -= 10;
        else dimScore -= 5;
      });
      dimScore = Math.max(0, dimScore);
      dimensionScores[area] = dimScore;

      if (areaIssues.length > 0) {
        const firstIssue = areaIssues[0] ?? {};
        feedback.push({
          area: area,
          label: label,
          weight: weight,
          score: dimScore,
          severity: firstIssue.severity,
          issues: areaIssues.length,
          recommendation: firstIssue.fix,
        });
      } else {
        feedback.push({
          area: area,
          label: label,
          weight: weight,
          score: dimScore,
          severity: 'none',
          issues: 0,
          recommendation: '符合规范',
        });
      }
    });

    let weightedScore = 0;
    let totalWeight = 0;
    feedback.forEach(function(f) {
      weightedScore += f.score * f.weight;
      totalWeight += f.weight;
    });
    const overallScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : auditResult.score;

    return {
      overallScore: overallScore,
      grade: overallScore >= CRITIQUE_GRADES.A ? 'A' : overallScore >= CRITIQUE_GRADES.B ? 'B' : overallScore >= CRITIQUE_GRADES.C ? 'C' : overallScore >= CRITIQUE_GRADES.D ? 'D' : 'F',
      feedback: feedback,
      dimensionScores: dimensionScores,
      summary: '审美评分 ' + overallScore + '/100，' + feedback.filter(function(f) { return f.issues > 0; }).length + ' 个维度存在问题',
    };
  }

  /**
   * 标准化CSS源码，先修正再确保包含字体声明。
   * @param {string} source - CSS源码
   * @returns {string} 标准化后的CSS源码
   */
  normalize(source) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return source;
    const result = this.polish(source);

    if (!result.includes('font-family')) {
      return 'body { font-family: \'Inter\', -apple-system, BlinkMacSystemFont, sans-serif; }\n' + result;
    }

    return result;
  }

  /**
   * 生成动效CSS变量。
   * @param {string} [preset] - 动效预设名称，默认使用'smooth'
   * @returns {string} 动效CSS变量代码
   */
  generateMotionCSS(preset) {
    const p = this._motionPresets[preset] || this._motionPresets.smooth;
    return ':root {\n' +
      '  --motion-duration: ' + p.duration + 'ms;\n' +
      '  --motion-easing: ' + p.easing + ';\n' +
      '  --motion-transition: all var(--motion-duration) var(--motion-easing);\n' +
      '}\n';
  }

  /**
   * 搜索图标。
   * @param {string} query - 搜索关键词
   * @param {string} [collection] - 指定图标集合名称
   * @returns {Array<{collection: string, query: string, status: string, usage: string}>} 图标搜索结果
   */
  searchIcons(query, collection) {
    if (!query) return [];
    const safeQuery = String(query).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/--/g, '__');
    const results = [];
    const cols = collection ? [collection] : this._iconCollections.slice(0, 5);
    cols.forEach(function(col) {
      results.push({
        collection: col,
        query: safeQuery,
        status: 'available',
        usage: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><!-- ' + col + ':' + safeQuery + ' --></svg>',
      });
    });
    return results;
  }

  /**
   * 审计CSS源码的动效性能，检测布局属性动画、无限循环动画等性能问题。
   * @param {string} source - CSS源码
   * @returns {{score: number, issues: Array, summary: string}} 动效性能审计结果
   */
  auditMotionPerformance(source) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return { score: 0, issues: [], summary: '空输入' };
    const issues = [];
    const self = this;

    MOTION_PERFORMANCE_RULES.must.forEach(function(rule) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      let count = 0;
      while ((m = re.exec(source)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        count++;
      }
      if (count > 0) {
        issues.push({ ruleId: rule.id, severity: rule.severity, count: count, message: rule.message });
      }
    });

    MOTION_PERFORMANCE_RULES.mustNot.forEach(function(rule) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      let count = 0;
      while ((m = re.exec(source)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        count++;
      }
      if (count > 0) {
        issues.push({ ruleId: rule.id, severity: rule.severity, count: count, message: rule.message });
      }
    });

    const animationCount = (source.match(/animation(?:-name)?:/g) ?? []).length;
    const maxSimultaneous = self._quantitativeStandards.maxSimultaneousAnimations;
    if (animationCount > maxSimultaneous) {
      issues.push({ ruleId: 'too-many-animations', severity: 'medium', count: 1, message: '同时运行动画超过' + maxSimultaneous + '个，影响性能' });
    }

    let score = 100;
    issues.forEach(function(issue) {
      if (issue.severity === 'high') score -= 20;
      else if (issue.severity === 'medium') score -= 10;
      else score -= 5;
    });
    return { score: Math.max(0, score), issues: issues, summary: '发现 ' + issues.length + ' 个动效性能问题' };
  }

  /**
   * 审计CSS源码的布局反模式，检测固定宽度和!important覆盖等问题。
   * @param {string} source - CSS源码
   * @returns {{score: number, issues: Array, summary: string}} 布局审计结果
   */
  auditLayout(source) {
    if (!source || typeof source !== 'string') return { score: 0, issues: [], summary: '空输入' };
    const issues = [];

    Object.keys(LAYOUT_ANTI_PATTERNS).forEach(function(key) {
      const rule = LAYOUT_ANTI_PATTERNS[key];
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      let count = 0;
      while ((m = re.exec(source)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        count++;
      }
      if (count > 0) {
        issues.push({ ruleId: rule.id, severity: rule.severity, count: count, message: rule.message, fix: rule.fix });
      }
    });

    let score = 100;
    issues.forEach(function(issue) {
      if (issue.severity === 'high') score -= 15;
      else if (issue.severity === 'medium') score -= 8;
      else score -= 3;
    });
    return { score: Math.max(0, score), issues: issues, summary: '发现 ' + issues.length + ' 个布局反模式' };
  }

  /**
   * 审计CSS源码的量化标准合规性，检测饱和度超标、圆角变体过多和阴影层数不足等问题。
   * @param {string} source - CSS源码
   * @returns {{score: number, issues: Array, summary: string}} 量化标准审计结果
   */
  auditQuantitative(source) {
    this.guardShutdown();
    if (!source || typeof source !== 'string') return { score: 0, issues: [], summary: '空输入' };
    const issues = [];
    const qs = this._quantitativeStandards;

    const hslMatches = source.match(/hsl\(\s*\d+\s*,\s*(\d+)%/g) ?? [];
    hslMatches.forEach(function(match) {
      const satMatch = match.match(/,\s*(\d+)%/);
      if (satMatch) {
        const saturation = parseInt(satMatch[1], 10);
        if (!Number.isFinite(saturation)) return;
        if (saturation > qs.maxSaturation) {
          issues.push({ ruleId: 'oversaturated-hsl', severity: 'medium', message: 'HSL饱和度' + saturation + '%超过上限' + qs.maxSaturation + '%', fix: '降低饱和度至' + qs.maxSaturation + '%以下' });
        }
      }
    });

    const borderRadiusValues = new Set();
    const brMatches = source.match(/border-radius:\s*([^;]+)/g) ?? [];
    brMatches.forEach(function(match) {
      const val = match.replace(/border-radius:\s*/, '').trim();
      borderRadiusValues.add(val);
    });
    if (borderRadiusValues.size > qs.maxBorderRadiusVariants) {
      issues.push({ ruleId: 'too-many-radius-variants', severity: 'low', message: '圆角变体' + borderRadiusValues.size + '种超过上限' + qs.maxBorderRadiusVariants + '种', fix: '统一圆角至' + qs.maxBorderRadiusVariants + '种以内' });
    }

    const shadowCount = (source.match(/box-shadow:/g) ?? []).length;
    if (shadowCount > 0 && shadowCount < qs.minShadowLayers) {
      issues.push({ ruleId: 'insufficient-shadow-layers', severity: 'low', message: '阴影层数不足，建议至少' + qs.minShadowLayers + '层', fix: '使用分层阴影系统' });
    }

    let score = 100;
    issues.forEach(function(issue) {
      if (issue.severity === 'high') score -= 15;
      else if (issue.severity === 'medium') score -= 8;
      else score -= 3;
    });
    return { score: Math.max(0, score), issues: issues, summary: '发现 ' + issues.length + ' 个量化标准问题' };
  }

  /**
   * 获取量化标准配置的安全副本。
   * @returns {object} 量化标准配置
   */
  getQuantitativeStandards() {
    return safeAssign({}, this._quantitativeStandards);
  }

  /**
   * 获取设计引擎统计信息。
   * @returns {{antiPatternRules: number, typographyLevels: number, spacingTokens: number, colorSystems: number, motionPresets: number, varianceLevels: number, iconCollections: number, companyDesignLanguages: number}} 统计信息
   */
  getStats() {
    return {
      antiPatternRules: Object.keys(this._antiPatterns).length,
      typographyLevels: Object.keys(this._typographyScale).length,
      spacingTokens: Object.keys(this._spacingScale).length,
      colorSystems: Object.keys(this._colorSystems).length,
      motionPresets: Object.keys(this._motionPresets).length,
      varianceLevels: Object.keys(this._designVarianceLevels).length,
      iconCollections: this._iconCollections.length,
      companyDesignLanguages: Object.keys(this._companyDesignLanguages).length,
    };
  }

  _onShutdown() {
    this._antiPatterns = {};
    this._typographyScale = {};
    this._spacingScale = {};
    this._colorSystems = {};
    this._motionPresets = {};
    this._responsiveBreakpoints = {};
    this._visualHierarchy = {};
    this._componentTokens = {};
    this._microInteractions = {};
    this._accessibilityStandards = {};
    this._interactionStates = {};
    this._designVarianceLevels = {};
    this._iconCollections = [];
    this._companyDesignLanguages = {};
    this._quantitativeStandards = {};
    this.removeAllListeners();
  }
}

DesignSkillEngine.ANTI_PATTERNS = ANTI_PATTERNS;
DesignSkillEngine.TYPOGRAPHY_SCALE = TYPOGRAPHY_SCALE;
DesignSkillEngine.SPACING_SCALE = SPACING_SCALE;
DesignSkillEngine.COLOR_SYSTEMS = COLOR_SYSTEMS;
DesignSkillEngine.MOTION_PRESETS = MOTION_PRESETS;
DesignSkillEngine.RESPONSIVE_BREAKPOINTS = RESPONSIVE_BREAKPOINTS;
DesignSkillEngine.VISUAL_HIERARCHY = VISUAL_HIERARCHY;
DesignSkillEngine.COMPONENT_TOKENS = COMPONENT_TOKENS;
DesignSkillEngine.MICRO_INTERACTIONS = MICRO_INTERACTIONS;
DesignSkillEngine.ACCESSIBILITY_STANDARDS = ACCESSIBILITY_STANDARDS;
DesignSkillEngine.INTERACTION_STATES = INTERACTION_STATES;
DesignSkillEngine.DESIGN_VARIANCE_LEVELS = DESIGN_VARIANCE_LEVELS;
DesignSkillEngine.ICON_COLLECTIONS = ICON_COLLECTIONS;
DesignSkillEngine.COMPANY_DESIGN_LANGUAGES = COMPANY_DESIGN_LANGUAGES;
DesignSkillEngine.QUANTITATIVE_STANDARDS = QUANTITATIVE_STANDARDS;
DesignSkillEngine.CRITIQUE_WEIGHTS = CRITIQUE_WEIGHTS;
DesignSkillEngine.MOTION_PERFORMANCE_RULES = MOTION_PERFORMANCE_RULES;
DesignSkillEngine.LAYOUT_ANTI_PATTERNS = LAYOUT_ANTI_PATTERNS;

module.exports = withShutdown(DesignSkillEngine);
