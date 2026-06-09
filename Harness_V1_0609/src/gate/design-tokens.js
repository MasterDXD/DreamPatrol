'use strict';

/**
 * @module gate/design-tokens
 * 设计令牌定义。包含排版比例尺、间距比例尺、色彩系统、动效预设、响应式断点、
 * 视觉层次、组件令牌、微交互、无障碍标准、交互状态、设计方差级别、
 * 图标集合和公司设计语言等完整设计体系。
 */

/** @constant {object} TYPOGRAPHY_SCALE - 排版比例尺配置 */
const TYPOGRAPHY_SCALE = {
  xs: { size: '0.75rem', lineHeight: '1rem', weight: 400, tracking: '0.01em' },
  sm: { size: '0.875rem', lineHeight: '1.25rem', weight: 400, tracking: '0.005em' },
  base: { size: '1rem', lineHeight: '1.5rem', weight: 400, tracking: '0em' },
  lg: { size: '1.125rem', lineHeight: '1.75rem', weight: 500, tracking: '-0.01em' },
  xl: { size: '1.25rem', lineHeight: '1.75rem', weight: 600, tracking: '-0.01em' },
  '2xl': { size: '1.5rem', lineHeight: '2rem', weight: 600, tracking: '-0.02em' },
  '3xl': { size: '1.875rem', lineHeight: '2.25rem', weight: 700, tracking: '-0.02em' },
  '4xl': { size: '2.25rem', lineHeight: '2.5rem', weight: 700, tracking: '-0.03em' },
  '5xl': { size: '3rem', lineHeight: '3.5rem', weight: 800, tracking: '-0.04em' },
  display: { size: '4.5rem', lineHeight: '5rem', weight: 800, tracking: '-0.05em' },
};

/** @constant {object} SPACING_SCALE - 间距比例尺配置（基于4px网格） */
const SPACING_SCALE = {
  0: '0', 0.5: '0.125rem', 1: '0.25rem', 1.5: '0.375rem', 2: '0.5rem',
  3: '0.75rem', 4: '1rem', 5: '1.25rem', 6: '1.5rem', 8: '2rem',
  10: '2.5rem', 12: '3rem', 16: '4rem', 20: '5rem', 24: '6rem',
  32: '8rem', 40: '10rem', 48: '12rem', 56: '14rem', 64: '16rem',
};

/** @constant {object} COLOR_SYSTEMS - 色彩系统配置（zinc/slate/neutral） */
const COLOR_SYSTEMS = {
  zinc: {
    50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8',
    400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46',
    800: '#27272a', 900: '#18181b', 950: '#09090b',
  },
  slate: {
    50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
    400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155',
    800: '#1e293b', 900: '#0f172a', 950: '#020617',
  },
  neutral: {
    50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4',
    400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040',
    800: '#262626', 900: '#171717', 950: '#0a0a0a',
  },
};

/** @constant {object} MOTION_PRESETS - 动效预设配置 */
const MOTION_PRESETS = {
  micro: { duration: 150, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  smooth: { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  spring: { duration: 500, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  bounce: { duration: 600, easing: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)' },
  elegant: { duration: 700, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  dramatic: { duration: 1000, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
};

/** @constant {object} RESPONSIVE_BREAKPOINTS - 响应式断点配置 */
const RESPONSIVE_BREAKPOINTS = {
  xs: { minWidth: 0, maxWidth: 479, columns: 4, margin: '16px', gutter: '16px' },
  sm: { minWidth: 480, maxWidth: 767, columns: 4, margin: '16px', gutter: '16px' },
  md: { minWidth: 768, maxWidth: 1023, columns: 8, margin: '24px', gutter: '24px' },
  lg: { minWidth: 1024, maxWidth: 1279, columns: 12, margin: '32px', gutter: '24px' },
  xl: { minWidth: 1280, maxWidth: 1535, columns: 12, margin: '48px', gutter: '32px' },
  '2xl': { minWidth: 1536, maxWidth: Infinity, columns: 12, margin: '64px', gutter: '32px' },
};

/** @constant {object} VISUAL_HIERARCHY - 视觉层次配置（阴影、zIndex、透明度） */
const VISUAL_HIERARCHY = {
  shadows: {
    xs: '0 1px 2px rgba(0,0,0,.05)',
    sm: '0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06)',
    md: '0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)',
    lg: '0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)',
    xl: '0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)',
    '2xl': '0 25px 50px -12px rgba(0,0,0,.25)',
    inner: 'inset 0 2px 4px rgba(0,0,0,.05)',
  },
  zIndex: {
    base: 0,
    dropdown: 1000,
    sticky: 1020,
    fixed: 1030,
    modalBackdrop: 1040,
    modal: 1050,
    popover: 1060,
    tooltip: 1070,
    notification: 1080,
  },
  opacity: {
    disabled: 0.5,
    placeholder: 0.6,
    secondary: 0.8,
    primary: 1,
  },
};

/** @constant {object} COMPONENT_TOKENS - 组件令牌配置（section/button/input/card/modal/toast） */
const COMPONENT_TOKENS = {
  section: {
    variants: ['default', 'collapsible', 'accent', 'bordered', 'hero'],
    spacing: { compact: { padding: '8px 12px', gap: '8px' }, default: { padding: '12px 18px', gap: '12px' }, spacious: { padding: '16px 24px', gap: '16px' } },
    titleSizes: { sm: '0.6875rem', md: '0.75rem', lg: '0.875rem' },
    borderRadius: { sm: '6px', md: '8px', lg: '12px' },
    accentColors: ['primary', 'success', 'warning', 'danger', 'purple', 'cyan'],
    animation: { collapseDuration: 200, collapseEasing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  },
  button: {
    variants: ['primary', 'secondary', 'ghost', 'danger', 'outline'],
    sizes: { sm: { height: '32px', padding: '0 12px', fontSize: '0.875rem' }, md: { height: '40px', padding: '0 16px', fontSize: '1rem' }, lg: { height: '48px', padding: '0 24px', fontSize: '1.125rem' } },
    borderRadius: { sm: '6px', md: '8px', lg: '12px', pill: '9999px' },
    focusRing: '0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-primary)',
  },
  input: {
    variants: ['default', 'filled', 'flushed'],
    sizes: { sm: { height: '32px', padding: '0 12px', fontSize: '0.875rem' }, md: { height: '40px', padding: '0 12px', fontSize: '1rem' }, lg: { height: '48px', padding: '0 16px', fontSize: '1.125rem' } },
    states: { default: 'var(--color-border)', hover: 'var(--color-primary)', focus: 'var(--color-primary)', error: 'var(--color-error)', disabled: 'var(--color-border-disabled)' },
  },
  card: {
    variants: ['elevated', 'outlined', 'filled'],
    padding: { sm: '12px', md: '16px', lg: '24px', xl: '32px' },
    borderRadius: { sm: '8px', md: '12px', lg: '16px', xl: '20px' },
  },
  modal: {
    sizes: { sm: '400px', md: '560px', lg: '720px', xl: '960px', full: '100vw' },
    overlayOpacity: 0.5,
    animation: { enter: 'scale(0.95) translateY(10px)', exit: 'scale(0.95) translateY(10px)' },
  },
  toast: {
    variants: ['info', 'success', 'warning', 'error'],
    position: ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'],
    duration: { short: 3000, medium: 5000, long: 8000 },
  },
};

/** @constant {object} MICRO_INTERACTIONS - 微交互配置 */
const MICRO_INTERACTIONS = {
  hover: { scale: 1.02, duration: 150, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  press: { scale: 0.98, duration: 100, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  focus: { ring: '0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-primary)', duration: 150 },
  toggle: { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  expand: { duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  collapse: { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  fadeIn: { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'translateY(0)' }, duration: 300 },
  fadeOut: { from: { opacity: 1, transform: 'translateY(0)' }, to: { opacity: 0, transform: 'translateY(-8px)' }, duration: 200 },
  slideIn: { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' }, duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  slideOut: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(100%)' }, duration: 250, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  scaleIn: { from: { opacity: 0, transform: 'scale(0.95)' }, to: { opacity: 1, transform: 'scale(1)' }, duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  skeleton: { background: 'linear-gradient(90deg, var(--color-surface) 25%, var(--color-surface-hover) 50%, var(--color-surface) 75%)', duration: 1500, easing: 'linear' },
};

/** @constant {object} ACCESSIBILITY_STANDARDS - 无障碍标准配置 */
const ACCESSIBILITY_STANDARDS = {
  wcagLevel: 'AA',
  contrastRatios: { normal: 4.5, large: 3, ui: 3 },
  focusRequirements: { visible: true, ringStyle: '0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-primary)', skipLinks: true },
  touchTargets: { minimum: '44px', recommended: '48px' },
  fontSizes: { minimum: '16px', recommended: '16px' },
  motionPreferences: { respectReducedMotion: true, fallbackDuration: 0 },
  ariaLandmarks: ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'],
  colorIndependence: { mustNotRelyOnColorAlone: true, patternsOrIconsRequired: true },
  readingLevel: { target: '8th grade', maxSentenceLength: 25 },
};

/** @constant {object} INTERACTION_STATES - 交互状态配置 */
const INTERACTION_STATES = {
  idle: { description: '默认静止状态', opacity: 1, scale: 1 },
  hover: { description: '鼠标悬停', opacity: 1, scale: 1.02, shadow: 'sm' },
  active: { description: '按下/激活', opacity: 0.9, scale: 0.98 },
  focus: { description: '键盘焦点', opacity: 1, scale: 1, ring: true },
  disabled: { description: '禁用不可交互', opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' },
  loading: { description: '加载中', opacity: 0.7, cursor: 'wait' },
  error: { description: '错误状态', borderColor: 'var(--color-error)' },
  selected: { description: '选中/激活', bg: 'var(--color-primary)', color: 'var(--color-on-primary)' },
};

/** @constant {object} DESIGN_VARIANCE_LEVELS - 设计方差级别配置 */
const DESIGN_VARIANCE_LEVELS = {
  conservative: { variance: '1-3', description: '安全居中布局，标准网格，适合后台管理系统' },
  balanced: { variance: '4-5', description: '适度创意，微妙的偏移和重叠，适合企业官网' },
  creative: { variance: '6-7', description: '元素开始重叠，文字偏移，图片大小各异，适合品牌展示' },
  bold: { variance: '8-10', description: '非对称布局、大面积留白、瀑布流网格，杂志感拉满' },
};

/** @constant {string[]} ICON_COLLECTIONS - 图标集合名称列表 */
const ICON_COLLECTIONS = [
  'lucide', 'heroicons', 'material-design', 'phosphor', 'tabler',
  'feather', 'remix-icon', 'bootstrap-icons', 'ionicons', 'font-awesome',
];

/** @constant {object} COMPANY_DESIGN_LANGUAGES - 公司设计语言预设配置 */
const COMPANY_DESIGN_LANGUAGES = {
  apple: {
    name: 'Apple / Airbnb',
    style: '磨砂玻璃质感、大留白、精致圆角',
    colors: { primary: '#007AFF', bg: '#F5F5F7', surface: 'rgba(255,255,255,.72)', text: '#1D1D1F' },
    borderRadius: '12px-20px',
    spacing: 'generous',
    motion: 'spring-based, 300-500ms',
    suitable: '消费级应用、展示型官网',
  },
  stripe: {
    name: 'Stripe',
    style: '丝滑渐变色、极强排版逻辑',
    colors: { primary: '#635BFF', bg: '#F6F9FC', surface: '#FFFFFF', text: '#1A1F36' },
    borderRadius: '8px-12px',
    spacing: 'structured',
    motion: 'smooth, 200-400ms',
    suitable: '金融科技、复杂表单、营销页',
  },
  vercel: {
    name: 'Vercel / Linear',
    style: '极简黑白、锐利边角、高对比度',
    colors: { primary: '#FFFFFF', bg: '#000000', surface: '#111111', text: '#EDEDED' },
    borderRadius: '4px-8px',
    spacing: 'tight',
    motion: 'snappy, 150-300ms',
    suitable: '开发者工具、技术文档、SaaS平台',
  },
  notion: {
    name: 'Notion / Linear',
    style: '温暖中性色调、清晰信息层次',
    colors: { primary: '#2EAADC', bg: '#FFFFFF', surface: '#F7F6F3', text: '#37352F' },
    borderRadius: '4px-8px',
    spacing: 'comfortable',
    motion: 'subtle, 200-300ms',
    suitable: '生产力工具、文档类产品',
  },
  github: {
    name: 'GitHub',
    style: '功能优先、信息密度高、暗色主题友好',
    colors: { primary: '#58A6FF', bg: '#0D1117', surface: '#161B22', text: '#C9D1D9' },
    borderRadius: '6px',
    spacing: 'compact',
    motion: 'minimal, 100-200ms',
    suitable: '代码平台、开发者社区',
  },
  spotify: {
    name: 'Spotify',
    style: '大胆撞色、圆角卡片、沉浸式布局',
    colors: { primary: '#1DB954', bg: '#121212', surface: '#181818', text: '#FFFFFF' },
    borderRadius: '8px-12px',
    spacing: 'spacious',
    motion: 'smooth, 200-400ms',
    suitable: '媒体娱乐、音乐视频、内容平台',
  },
  figma: {
    name: 'Figma',
    style: '柔和配色、工具感UI、紧凑布局',
    colors: { primary: '#A259FF', bg: '#FFFFFF', surface: '#F5F5F5', text: '#333333' },
    borderRadius: '6px-8px',
    spacing: 'compact',
    motion: 'responsive, 100-200ms',
    suitable: '设计工具、协作平台、创意工具',
  },
  shopify: {
    name: 'Shopify',
    style: '商业友好、清晰CTA、信任感设计',
    colors: { primary: '#008060', bg: '#FFFFFF', surface: '#F6F6F7', text: '#202223' },
    borderRadius: '8px',
    spacing: 'structured',
    motion: 'subtle, 150-300ms',
    suitable: '电商平台、SaaS后台、商业应用',
  },
  slack: {
    name: 'Slack',
    style: '活泼配色、圆角气泡、友好交互',
    colors: { primary: '#4A154B', bg: '#FFFFFF', surface: '#F4EDE4', text: '#1D1C1D' },
    borderRadius: '8px-12px',
    spacing: 'comfortable',
    motion: 'playful, 200-400ms',
    suitable: '通讯工具、社交平台、团队协作',
  },
  netflix: {
    name: 'Netflix',
    style: '深色沉浸、大图卡片、流畅过渡',
    colors: { primary: '#E50914', bg: '#141414', surface: '#1F1F1F', text: '#FFFFFF' },
    borderRadius: '4px-8px',
    spacing: 'tight',
    motion: 'cinematic, 300-600ms',
    suitable: '视频流媒体、内容展示、娱乐平台',
  },
  airbnb: {
    name: 'Airbnb',
    style: '温暖摄影感、大留白、圆润友好',
    colors: { primary: '#FF385C', bg: '#FFFFFF', surface: '#F7F7F7', text: '#222222' },
    borderRadius: '12px-16px',
    spacing: 'generous',
    motion: 'smooth, 200-400ms',
    suitable: '旅行预订、生活服务、社区平台',
  },
  tesla: {
    name: 'Tesla',
    style: '极简科技感、大留白、锐利线条',
    colors: { primary: '#CC0000', bg: '#FFFFFF', surface: '#F5F5F5', text: '#1A1A1A' },
    borderRadius: '2px-4px',
    spacing: 'spacious',
    motion: 'precise, 150-300ms',
    suitable: '汽车科技、硬件产品、创新品牌',
  },
  discord: {
    name: 'Discord',
    style: '游戏化暗色、圆角卡片、活泼微交互',
    colors: { primary: '#5865F2', bg: '#36393F', surface: '#2F3136', text: '#DCDDDE' },
    borderRadius: '8px',
    spacing: 'compact',
    motion: 'playful, 150-300ms',
    suitable: '游戏社区、聊天应用、社交平台',
  },
  linear: {
    name: 'Linear (独立)',
    style: '极致极简、暗色优先、丝滑动效',
    colors: { primary: '#5E6AD2', bg: '#0A0A0F', surface: '#14141F', text: '#E8E8ED' },
    borderRadius: '6px-8px',
    spacing: 'tight',
    motion: 'fluid, 200-400ms',
    suitable: '项目管理、开发者工具、SaaS',
  },
  tailwind: {
    name: 'Tailwind CSS',
    style: '实用主义、工具类优先、中性配色',
    colors: { primary: '#06B6D4', bg: '#FFFFFF', surface: '#F8FAFC', text: '#0F172A' },
    borderRadius: '6px-8px',
    spacing: 'systematic',
    motion: 'functional, 150-200ms',
    suitable: '技术文档、组件库、开发者工具',
  },
};

/** @constant {object} QUANTITATIVE_STANDARDS - 量化设计标准 */
const QUANTITATIVE_STANDARDS = {
  maxSaturation: 80,
  minShadowLayers: 2,
  maxBorderRadiusVariants: 3,
  spacingGridUnit: 4,
  minTouchTarget: 44,
  maxSimultaneousAnimations: 3,
  typographyMinRatio: 1.2,
  colorContrastMinAA: 4.5,
};

module.exports = {
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
};
