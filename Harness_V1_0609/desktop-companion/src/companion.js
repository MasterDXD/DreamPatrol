/**
 * @file 桌面伙伴渲染进程逻辑
 * @description Harness Engineering 桌面伙伴（Desktop Companion）的核心渲染进程脚本。
 *   负责管理桌面伙伴的完整生命周期，包括：初始化与DOM元素绑定、拖拽移动与点击交互、
 *   AI状态可视化（思考/打字/建造/指挥等）、经验值与等级成长系统、成就解锁机制、
 *   皮肤切换（机器人/猫咪/幽灵/龙）、空闲检测与自动行为、自由漫游、权限审批卡片、
 *   语音气泡与音效反馈、右键上下文菜单、迷你面板、以及与主进程的API轮询通信。
 *   运行于 Electron 渲染进程的 IIFE 沙箱中，通过 window.companionAPI 与主进程交互。
 * @module companion
 */
(function () {
  'use strict';

  /**
   * 主进程API桥接对象
   * @description 通过 window.companionAPI 与 Electron 主进程通信。若主进程未注入，
   *   则使用回退实现（返回拒绝的Promise或空操作），确保渲染进程可独立运行于演示模式。
   * @property {Function} proxyAPI - 代理API请求到主进程HTTP服务
   * @property {Function} getStatus - 获取主进程连接状态
   * @property {Function} toggleWindow - 切换窗口显示/隐藏
   * @property {Function} openDashboard - 在浏览器中打开仪表盘
   * @property {Function} onSpeech - 监听主进程语音指令
   * @property {Function} sendCommand - 向主进程发送斜杠命令
   * @property {Function} moveWindow - 相对移动窗口位置
   * @property {Function} getWindowBounds - 获取窗口边界尺寸
   * @property {Function} resetPosition - 重置窗口到默认位置
   * @property {Function} quitApp - 退出应用
   * @property {Function} setIgnoreMouseEvents - 设置鼠标事件穿透
   * @property {Function} getWindowPosition - 获取窗口绝对坐标
   * @property {Function} getScreenSize - 获取屏幕尺寸
   * @property {Function} setWindowSize - 设置窗口尺寸
   * @property {Function} onPermissionRequest - 监听权限请求事件
   * @property {Function} onPermissionShortcut - 监听权限快捷键事件
   */
  var api = window.companionAPI || {
    proxyAPI: function () { return Promise.reject(new Error('不可用')); },
    getStatus: function () { return Promise.resolve({ status: 'demo' }); },
    toggleWindow: function () { return Promise.resolve(); },
    openDashboard: function () { window.open('http://localhost:3210', '_blank'); return Promise.resolve(); },
    onSpeech: function () {},
    sendCommand: function () { return Promise.resolve({ ok: false }); },
    moveWindow: function () { return Promise.resolve(); },
    getWindowBounds: function () { return Promise.resolve(null); },
    resetPosition: function () { return Promise.resolve(); },
    quitApp: function () { return Promise.resolve(); },
    setIgnoreMouseEvents: function () { return Promise.resolve(); },
    getWindowPosition: function () { return Promise.resolve(null); },
    getScreenSize: function () { return Promise.resolve({ width: 1920, height: 1080 }); },
    setWindowSize: function () { return Promise.resolve(); },
    onPermissionRequest: function () {},
    onPermissionShortcut: function () {},
  };

  /**
   * 皮肤配置表
   * @description 定义桌面伙伴的四种可选皮肤，每种皮肤包含名称、品牌徽标字符和专属语音台词。
   *   皮肤影响伙伴的视觉外观、粒子颜色、品牌标识以及点击/问候时的语音内容。
   * @type {Object.<string, {name: string, badge: string, speech: {greet: string[], click: string[]}}>}
   */
  var STORAGE_KEYS = {
    settings: 'companion-settings',
    windowPos: 'companion-window-pos',
  };

  var TIMING = {
    PET_WINDOW: 1500,
    SPEECH_DEFAULT: 3000,
    SPEECH_LONG: 4000,
    SPEECH_BRIEF: 2000,
    TOAST_DURATION: 4000,
    TOAST_FADE: 400,
    EXCITED_DURATION: 500,
    CORE_HOVER_PULSE: 500,
    HEAD_HOVER_DELAY: 600,
    IDLE_ACTION_INTERVAL: 12000,
    IDLE_DOZING_DELAY: 30000,
    IDLE_COLLAPSED_DELAY: 45000,
    IDLE_DEEP_DELAY: 70000,
    BLINK_MIN: 2000,
    BLINK_MAX: 5000,
    ROAM_STEP: 2000,
    ROAM_DIRECTION_CHANGE: 8000,
    LEVEL_UP_DISPLAY: 3000,
    LEVEL_UP_OVERLAY: 2500,
    SPIN_DURATION: 800,
    LONG_PRESS_THRESHOLD: 500,
    ROAM_PAUSE_MIN: 3000,
    ROAM_PAUSE_RANGE: 5000,
    FILE_DROP_XP: 10,
    CONNECT_XP: 10,
    AI_STATE_XP: 3,
    PET_XP: 2,
    ACHIEVEMENT_XP: 20,
    LEVEL_XP_BASE: 100,
    LEVEL_XP_FACTOR: 1.5,
    PARTICLE_COUNT: 18,
    CONFETTI_COUNT: 10,
    BURST_PARTICLE_DEFAULT: 6,
    MAX_TOASTS: 5,
    MAX_EVENT_LOG: 30,
    MAX_FILES_PREVIEW: 3,
  };

  var API_ENDPOINTS = {
    health: '/api/health',
    agents: '/api/agents',
    skills: '/api/skills',
    optimizationStatus: '/api/optimization/status',
  };

  var SKINS = {
    robot: { name: '经典机器人', badge: '驭', speech: { greet: ['你好呀！', '驭已就绪！'], click: ['嘿嘿~', '在呢在呢！', '别戳我啦~'] } },
    cat: { name: '赛博猫咪', badge: '喵', speech: { greet: ['喵~你好！', '喵呜~'], click: ['喵！', '喵呜~', '别摸我！喵~'] } },
    ghost: { name: '幽灵精灵', badge: '幽', speech: { greet: ['呜~你好！', '飘过来了~'], click: ['呜~', '嘻嘻~'] } },
    dragon: { name: '迷你龙', badge: '龙', speech: { greet: ['吼！你好！', '龙已觉醒！'], click: ['吼~', '嗷！'] } },
  };

  /**
   * 成长阶段定义表
   * @description 定义等级对应的成长阶段，每个阶段包含最低等级阈值、阶段名称和代表色。
   *   阶段用于伙伴的等级徽章显示和成长面板可视化，按 minLevel 升序排列。
   * @type {Array.<{minLevel: number, name: string, color: string}>}
   */
  var STAGES = [
    { minLevel: 1, name: '萌芽', color: '#94a3b8' },
    { minLevel: 5, name: '初生', color: '#34d399' },
    { minLevel: 10, name: '成长', color: '#22d3ee' },
    { minLevel: 15, name: '精英', color: '#818cf8' },
    { minLevel: 20, name: '大师', color: '#a78bfa' },
    { minLevel: 30, name: '传奇', color: '#fbbf24' },
    { minLevel: 50, name: '神话', color: '#f472b6' },
  ];

  /**
   * 成就定义表
   * @description 定义所有可解锁的成就，每个成就包含唯一键、名称、描述和检查函数。
   *   检查函数接收当前成长数据对象(growth)，返回布尔值表示是否达成。
   *   成就解锁时奖励20XP并弹出提示，支持互动类、等级类、时间类等多种触发条件。
   * @type {Object.<string, {name: string, desc: string, check: function(Object): boolean}>}
   */
  var ACHIEVEMENTS = {
    'first-meet': { name: '初次见面', desc: '首次启动桌面伙伴', check: function (g) { return g.totalInteractions >= 1; } },
    'pet-master': { name: '摸摸达人', desc: '累计点击50次', check: function (g) { return g.petCount >= 50; } },
    'drag-fly': { name: '翱翔天际', desc: '拖动伙伴10次', check: function (g) { return g.dragCount >= 10; } },
    'dance-king': { name: '舞蹈之王', desc: '跳舞5次', check: function (g) { return g.danceCount >= 5; } },
    'level5': { name: '初露锋芒', desc: '达到5级', check: function (g) { return g.level >= 5; } },
    'level10': { name: '茁壮成长', desc: '达到10级', check: function (g) { return g.level >= 10; } },
    'level20': { name: '精英战士', desc: '达到20级', check: function (g) { return g.level >= 20; } },
    'skin-collector': { name: '形象收藏家', desc: '切换过所有4种形象', check: function (g) { return g.skinsUsed && g.skinsUsed.length >= 4; } },
    'roamer': { name: '漫游者', desc: '自由漫游3次', check: function (g) { return g.roamCount >= 3; } },
    'night-owl': { name: '夜猫子', desc: '在深夜(22:00-6:00)使用伙伴', check: function (g) { var h = new Date().getHours(); return h >= 22 || h < 6; } },
    'file-receiver': { name: '文件接收者', desc: '拖放文件到伙伴上', check: function (g) { return g.fileDropCount >= 1; } },
    'perm-approver': { name: '权限审批者', desc: '批准3次权限请求', check: function (g) { return g.permApproved >= 3; } },
    'early-bird': { name: '早起鸟儿', desc: '在早晨(6:00-9:00)使用伙伴', check: function (g) { var h = new Date().getHours(); return h >= 6 && h < 9; } },
  };

  /**
   * AI状态配置表
   * @description 定义AI工作状态的可视化映射，每种状态包含显示标签、body CSS类名、
   *   嘴巴CSS类名和默认语音台词。状态切换时自动应用对应的视觉样式和动画效果，
   *   并触发相应的特效（如思考气泡、汗滴、五彩纸屑等）。
   * @type {Object.<string, {label: string, bodyClass: string, mouthClass: string, speech: string|null}>}
   */
  var AI_STATES = {
    idle: { label: '待机', bodyClass: '', mouthClass: '', speech: null },
    thinking: { label: '思考中', bodyClass: 'ai-thinking', mouthClass: 'mouth thinking', speech: '让我想想...' },
    typing: { label: '打字中', bodyClass: 'ai-typing', mouthClass: 'mouth happy', speech: '正在编写代码...' },
    building: { label: '建造中', bodyClass: 'ai-building', mouthClass: 'mouth', speech: '正在构建...' },
    juggling: { label: '杂耍中', bodyClass: 'idle-juggle', mouthClass: 'mouth happy', speech: '子代理工作中...' },
    conducting: { label: '指挥中', bodyClass: 'ai-conducting', mouthClass: 'mouth happy', speech: '多代理协作中...' },
    optimizing: { label: '优化中', bodyClass: 'ai-building', mouthClass: 'mouth happy', speech: '正在优化求解...' },
    converged: { label: '已收敛', bodyClass: 'ai-happy', mouthClass: 'mouth happy', speech: '优化收敛！' },
    reviewing: { label: '审查中', bodyClass: 'ai-reviewing', mouthClass: 'mouth thinking', speech: '代码审查中...' },
    architecting: { label: '架构中', bodyClass: 'ai-architecting', mouthClass: 'mouth thinking', speech: '架构设计中...' },
    validating: { label: '验证中', bodyClass: 'ai-validating', mouthClass: 'mouth happy', speech: '需求验证中...' },
    designing: { label: '设计中', bodyClass: 'ai-designing', mouthClass: 'mouth happy', speech: '设计打磨中...' },
    integrating: { label: '集成中', bodyClass: 'ai-integrating', mouthClass: 'mouth happy', speech: '工具集成中...' },
    selfhealing: { label: '自愈中', bodyClass: 'ai-selfhealing', mouthClass: 'mouth thinking', speech: '策略调整中...' },
    adapting: { label: '适配中', bodyClass: 'ai-adapting', mouthClass: 'mouth happy', speech: '模型切换中...' },
    memorizing: { label: '记忆加载', bodyClass: 'ai-memorizing', mouthClass: 'mouth thinking', speech: '加载项目记忆...' },
    skilling: { label: '技能执行', bodyClass: 'ai-skilling', mouthClass: 'mouth happy', speech: '执行技能流程...' },
    connecting: { label: '外部连接', bodyClass: 'ai-connecting', mouthClass: 'mouth happy', speech: '连接外部服务...' },
    delegating: { label: '任务分发', bodyClass: 'ai-delegating', mouthClass: 'mouth happy', speech: '分发子任务...' },
    automating: { label: '自动化', bodyClass: 'ai-automating', mouthClass: 'mouth', speech: '触发自动化...' },
    specifying: { label: '规格编写', bodyClass: 'ai-specifying', mouthClass: 'mouth thinking', speech: '编写规格文档...' },
    syncing: { label: '文档同步', bodyClass: 'ai-syncing', mouthClass: 'mouth', speech: '同步文档与代码...' },
    questioning: { label: '反问澄清', bodyClass: 'ai-questioning', mouthClass: 'mouth surprised', speech: '需要澄清需求...' },
    planning: { label: '计划制定', bodyClass: 'ai-planning', mouthClass: 'mouth thinking', speech: '制定执行计划...' },
    retrieving: { label: '检索思想', bodyClass: 'ai-thinking', mouthClass: 'mouth thinking', speech: '检索记忆中的思想...' },
    distilling: { label: '提炼思想', bodyClass: 'ai-building', mouthClass: 'mouth happy', speech: '提炼思想钻石...' },
    deduplicating: { label: '查重去冗', bodyClass: 'ai-reviewing', mouthClass: 'mouth thinking', speech: '查重去冗余...' },
    updating: { label: '更新记忆', bodyClass: 'ai-happy', mouthClass: 'mouth happy', speech: '思想已存入记忆！' },
    error: { label: '报错', bodyClass: 'ai-error', mouthClass: 'mouth sad', speech: '出错了...' },
    happy: { label: '完成', bodyClass: 'ai-happy', mouthClass: 'mouth happy', speech: '任务完成！' },
    notification: { label: '通知', bodyClass: 'ai-notification', mouthClass: 'mouth surprised', speech: '有新消息！' },
  };

  /**
   * 演示用Agent列表
   * @description 当API不可用时使用的回退Agent数据，用于面板展示和状态演示。
   * @type {Array.<{id: string, role: string, status: string}>}
   */
  var DEMO_AGENTS = [
    { id: 'team-lead', role: '团队负责人', status: 'active' },
    { id: 'domain-analyst', role: '领域分析师', status: 'idle' },
    { id: 'task-worker', role: '任务执行者', status: 'idle' },
    { id: 'quality-assurance', role: '质量保证', status: 'idle' },
    { id: 'devops-engineer', role: '运维工程师', status: 'idle' },
    { id: 'technical-writer', role: '技术文档工程师', status: 'idle' },
  ];

  /**
   * 演示用技能列表
   * @description 当API不可用时使用的回退技能数据，包含技能ID、名称和验证状态。
   * @type {Array.<{id: string, name: string, verified: boolean}>}
   */
  var DEMO_SKILLS = [
    { id: 'brainstorming', name: '头脑风暴', verified: true },
    { id: 'requirement-analysis', name: '需求分析', verified: true },
    { id: 'architecture-design', name: '架构设计', verified: true },
    { id: 'tdd-implement', name: 'TDD驱动开发', verified: true },
    { id: 'code-review', name: '代码审查', verified: true },
    { id: 'integration-testing', name: '集成测试', verified: true },
    { id: 'deployment', name: '部署上线', verified: true },
    { id: 'security-audit', name: '安全审计', verified: true },
    { id: 'performance-optimization', name: '性能优化', verified: false },
    { id: 'refactor-code', name: '系统化重构', verified: true },
  ];

  /**
   * 演示用健康状态数据
   * @description 当API不可用时使用的回退框架健康状态，用于面板信息展示。
   * @type {{status: string, version: string, phase: string, tokenUsage: number, tokenBudget: number}}
   */
  var DEMO_HEALTH = { status: 'demo', version: '2.7.122', phase: '待命', tokenUsage: 1250000, tokenBudget: 1000000000 };

  /**
   * 空闲行为动作名称列表
   * @description 伙伴空闲时循环执行的动画行为，按索引轮询触发，每个动作对应CSS动画类和语音台词。
   * @type {string[]}
   */
  var VIBE_CAPABILITIES = {
    reviewing: { name: '审查力', icon: '🔍', desc: 'AI代码视为初级产出，逐段审查守住质量底线', color: '#f87171', skill: 'code-review', hudClass: 'hud-thinking' },
    architecting: { name: '系统思维', icon: '🏗️', desc: '先规划蓝图再分模块交付，架构决定产出档次', color: '#818cf8', skill: 'architecture-design', hudClass: 'hud-building' },
    validating: { name: '产品感', icon: '🎯', desc: '聚焦核心需求验证，避免堆砌无用功能', color: '#34d399', skill: 'requirement-analysis', hudClass: 'hud-typing' },
    designing: { name: '审美', icon: '✨', desc: 'UI设计直接影响留存，明确好设计的标准', color: '#fbbf24', skill: 'taste-skill', hudClass: 'hud-active' },
  };

  var SUPERAGENT_CAPABILITIES = {
    integrating: { name: '全流程集成', icon: '🔗', desc: '多任务全流程覆盖，无需切换工具', color: '#60a5fa', skill: 'web-interaction', hudClass: 'hud-active' },
    selfhealing: { name: '自主迭代', icon: '🔄', desc: '卡点自调整策略，无需人工干预', color: '#a78bfa', skill: 'optimization-loop', hudClass: 'hud-building' },
    adapting: { name: '轻量适配', icon: '⚡', desc: '多模型兼容切换，本地云端无缝部署', color: '#2dd4bf', skill: 'ai-prompting', hudClass: 'hud-typing' },
  };

  var EXTENSION_LAYERS = {
    memorizing: { name: 'CLAUDE.md', icon: '🧠', desc: '长期记忆，项目约定自动加载', color: '#f97316', skill: 'session-start-hook', hudClass: 'hud-thinking', cost: 5, trigger: '两次搞错项目约定时写入' },
    skilling: { name: 'Skills', icon: '📦', desc: '自定义技能包，多步骤流程封装', color: '#8b5cf6', skill: 'skill-router', hudClass: 'hud-active', cost: 3, trigger: '同一流程重复三次时封装' },
    connecting: { name: 'MCP', icon: '🔌', desc: '连接外部服务，查数据库发消息', color: '#06b6d4', skill: 'web-interaction', hudClass: 'hud-typing', cost: 2, trigger: '反复从浏览器复制数据时添加' },
    delegating: { name: 'Subagents', icon: '👥', desc: '任务拆解并行，隔离辅助输出', color: '#ec4899', skill: 'dispatching-parallel', hudClass: 'hud-building', cost: 2, trigger: '辅助任务刷爆对话时隔离' },
    automating: { name: 'Hooks', icon: '⚙️', desc: '事件触发自动化，无需思考', color: '#84cc16', skill: 'verification-before-completion', hudClass: 'hud-active', cost: 1, trigger: '希望某操作自动发生时配置' },
  };

  var SDD_PRACTICES = {
    specifying: { name: '规格文档', icon: '📋', desc: '确保需求理解一致，先写规格再写代码', color: '#ef4444', skill: 'requirement-analysis', hudClass: 'hud-thinking', cost: 4, trigger: '每次给AI提需求都要重复解释时编写', evolution: 2 },
    syncing: { name: '同步机制', icon: '🔄', desc: '先改文档再写代码，保障文档与事实一致', color: '#f59e0b', skill: 'documentation', hudClass: 'hud-active', cost: 3, trigger: '直接改代码忘记更新文档时建立', evolution: 3 },
    questioning: { name: '反问机制', icon: '❓', desc: '强制AI不懂就问，拦截模糊需求', color: '#10b981', skill: 'brainstorming', hudClass: 'hud-building', cost: 2, trigger: '功能复杂容易漏细节时启用', evolution: 4 },
    planning: { name: '计划文档', icon: '📝', desc: '多文件修改先出计划，人类审核后再执行', color: '#6366f1', skill: 'architecture-design', hudClass: 'hud-typing', cost: 3, trigger: '修改涉及多文件时使用', evolution: 5 },
  };

  var THOUGHT_DIAMOND = {
    retrieving: { name: '检索思想', icon: '💎', desc: '从记忆中调取相关思想钻石', color: '#8b5cf6', hudClass: 'hud-thinking', tier: 'cut', step: 1 },
    distilling: { name: '提炼思想', icon: '✨', desc: '提取核心逻辑并评估置信度', color: '#f59e0b', hudClass: 'hud-building', tier: 'polished', step: 2 },
    deduplicating: { name: '查重去冗余', icon: '🔍', desc: '剔除重复信息保证信息密度', color: '#10b981', hudClass: 'hud-reviewing', tier: 'polished', step: 3 },
    updating: { name: '更新记忆', icon: '🧠', desc: '将精炼后的思想存入永久记忆', color: '#f43f5e', hudClass: 'hud-happy', tier: 'diamond', step: 4 },
  };

  /**
   * 事件日志数组
   * @description 记录伙伴活动的最近30条事件，用于面板中的事件日志渲染。每条包含文本、类型和时间戳。
   * @type {Array.<{text: string, type: string, time: string}>}
   */
  var eventLog = [];

  /**
   * 全局运行时状态对象
   * @description 桌面伙伴的完整运行时状态，涵盖连接状态、交互状态、动画控制、
   *   皮肤与漫游、AI状态、模式开关和成长数据等所有运行时信息。
   * @property {boolean} apiConnected - 是否已连接到主进程API
   * @property {string|null} currentAgent - 当前活跃的Agent ID
   * @property {string} mood - 当前心情模式（happy/calm/energetic）
   * @property {number|null} speechTimeout - 语音气泡自动隐藏定时器ID
   * @property {number|null} blinkTimer - 眨眼定时器ID
   * @property {number|null} idleTimer - 空闲检测定时器ID
   * @property {number} idleTimeout - 空闲触发阈值（毫秒）
   * @property {boolean} isIdle - 是否处于空闲状态
   * @property {number} sleepStage - 睡眠阶段（0=清醒,1=打盹,2=浅睡,3=深睡,4=熟睡）
   * @property {{x: number, y: number}} mousePos - 鼠标位置（用于眼球追踪）
   * @property {boolean} panelOpen - 迷你面板是否打开
   * @property {number} pollInterval - API轮询间隔（毫秒）
   * @property {boolean} isDragging - 是否正在拖拽
   * @property {{x: number, y: number}|null} dragStartPos - 拖拽起始位置
   * @property {number|null} longPressTimer - 长按检测定时器ID
   * @property {boolean} longPressTriggered - 长按是否已触发
   * @property {number} petCount - 连续点击计数（1.5秒内累计）
   * @property {number|null} petTimer - 连续点击重置定时器ID
   * @property {boolean} isSpinning - 是否正在旋转动画中
   * @property {string} currentSkin - 当前皮肤ID
   * @property {boolean} isRoaming - 是否正在自由漫游
   * @property {number|null} roamStepTimer - 漫游步进定时器ID
   * @property {number} roamDirection - 漫游方向（1=右,-1=左）
   * @property {number|null} fxTimeout - 特效定时器ID
   * @property {number|null} actionTimeout - 动作定时器ID
   * @property {string} aiState - 当前AI状态键名
   * @property {string|null} prevAiState - 上一个AI状态键名
   * @property {boolean} dndMode - 免打扰模式
   * @property {boolean} minimalMode - 迷你模式
   * @property {boolean} clickThroughEnabled - 点击穿透模式
   * @property {boolean} edgeAutoMinimal - 贴边自动迷你模式
   * @property {number|null} permTimeout - 权限卡片超时定时器ID
   * @property {Array.<number>} sleepTimers - 睡眠阶段定时器ID列表
   * @property {Object} growth - 成长数据（等级、经验、互动统计、成就等）
   */
  var state = {
    apiConnected: false, currentAgent: null, mood: 'happy',
    speechTimeout: null, blinkTimer: null, idleTimer: null,
    idleTimeout: 60000, isIdle: false, sleepStage: 0,
    mousePos: { x: 0, y: 0 }, panelOpen: false, pollInterval: 5000,
    isDragging: false, dragStartPos: null, longPressTimer: null, longPressTriggered: false,
    petCount: 0, petTimer: null, isSpinning: false,
    currentSkin: 'robot', isRoaming: false, roamStepTimer: null, roamWalkInterval: null, roamDirection: 1,
    fxTimeout: null, actionTimeout: null, activeFxClasses: [],
    aiState: 'idle', prevAiState: null, dndMode: false, minimalMode: false,
    manualState: false,
    clickThroughEnabled: false, edgeAutoMinimal: false,
    permTimeout: null, sleepTimers: [], intervals: [],
    idleActionTimer: null, handleDragMove: null, excitedTimer: null, skinTransitionTimer: null, levelUpTimer: null,
    growth: {
      level: 1, xp: 0, totalXp: 0, totalInteractions: 0,
      petCount: 0, dragCount: 0, danceCount: 0, roamCount: 0,
      skinsUsed: ['robot'], achievements: [],
      fileDropCount: 0, permApproved: 0, permDenied: 0,
    },
  };

  /**
   * DOM元素缓存对象
   * @description 在 init() 中批量获取并缓存的DOM元素引用，避免重复查询DOM树。
   * @type {Object.<string, HTMLElement>}
   */
  var els = {};

  /**
   * 语音台词配置表
   * @description 定义伙伴在各种交互场景下随机选取的语音台词，按场景分类。
   *   每个键对应一个字符串数组，showSpeech() 从中随机选取一条显示。
   *   包含问候（按时段）、点击、抚摸、空闲动作、AI状态、特效、模式切换等全场景覆盖。
   * @type {Object.<string, string[]>}
   */
  var SPEECH = {
    greet: ['你好呀！', '嗨！需要帮忙吗？', '驭已就绪！', '随时待命！'],
    greetMorning: ['早上好！新的一天开始了~', '早安☀️ 精神满满！', '早呀，今天也要加油哦！'],
    greetNoon: ['中午好！该休息一下啦~', '午安🌤️ 吃饭了吗？', '下午好，继续加油！'],
    greetEvening: ['晚上好！辛苦了一天了~', '晚安🌙 早点休息哦！'],
    greetNight: ['夜深了...注意休息哦~', '🌙 还在加班吗？早点睡吧！', '深夜了，身体最重要~'],
    click: ['嘿嘿~', '在呢在呢！', '有什么事？', '别戳我啦~'],
    doubleClick: ['哇！打开控制台！'],
    pet: ['好舒服~', '再摸摸~', '嘻嘻~'],
    petMany: ['啊啊好痒！', '够了够了~'],
    lookAround: ['嗯？什么？', '谁在看我？'],
    connected: ['已连接到驭框架！', 'API连接成功！'],
    disconnected: ['连接中断了...', 'API不可用'],
    idle: ['好无聊...', '有人吗？'],
    yawn: ['啊~好困'],
    stretch: ['伸个懒腰~'],
    breathe: ['呼~吸~'],
    think: ['让我想想...'],
    nod: ['嗯嗯！'],
    peek: ['偷看一下~'],
    sweep: ['扫扫扫~', '打扫卫生！'],
    juggle: ['接住！', '看我杂耍！'],
    carry: ['搬搬搬~', '好重...'],
    agentActive: ['{name} 正在工作'],
    moodHappy: ['开心模式！'],
    moodCalm: ['平静模式~'],
    moodEnergetic: ['活力全开！'],
    hug: ['好温暖~', '抱抱！'],
    drag: ['去哪里？', '飞起来了！'],
    drop: ['落地啦！'],
    spin: ['转圈圈~', '好晕~'],
    headPat: ['摸头杀~'],
    skinChange: ['换装完成！'],
    roamStart: ['出去走走~'],
    roamStop: ['走累了~'],
    dance: ['跳起来！', '一起来！'],
    magic: ['见证奇迹！', '变！'],
    sing: ['啦啦啦~', '♪~♪~♪'],
    rainbow: ['好漂亮！', '彩虹！'],
    hearteyes: ['好喜欢！', '心动~'],
    jump: ['跳！', '嘿！'],
    shake: ['摇摇摇~', '好晕~'],
    bow: ['请多指教！'],
    celebrate: ['太棒了！', '耶！'],
    tremble: ['好冷...', '怕怕...'],
    levelUp: ['升级了！', '变得更强了！'],
    achievement: ['解锁成就！'],
    wakeUp: ['啊！我醒了！', '嗯？发生什么了？'],
    dndOn: ['免打扰模式~'],
    dndOff: ['恢复提醒！'],
    minimalOn: ['躲起来了~'],
    minimalOff: ['我回来了！'],
    permApprove: ['批准！', '好的！'],
    permDeny: ['拒绝！', '不行~'],
    edgeHide: ['贴边隐藏~'],
    edgeShow: ['我出来了~'],
    juggling: ['接住！', '看我杂耍！'],
    conducting: ['大家跟上！', '指挥中~', '一起协作！'],
    reviewing: ['审查每一行代码！', '质量底线不能破！', 'AI产出必须审查！'],
    architecting: ['先画蓝图再动手！', '架构决定档次！', '模块拆分要清晰！'],
    validating: ['这是用户真正需要的吗？', '核心功能优先！', '验证需求再迭代！'],
    designing: ['好设计提升留存！', '配色布局交互！', '审美可以训练！'],
    integrating: ['全流程覆盖！', '工具链打通！', '一个工具搞定！'],
    selfhealing: ['策略自动调整！', '卡点自主突破！', '迭代优化中！'],
    adapting: ['模型无缝切换！', '本地云端适配！', '轻量部署！'],
    memorizing: ['加载项目记忆！', '约定自动加载！', '长期记忆激活！'],
    skilling: ['技能执行中！', '流程封装复用！', '按需调用！'],
    connecting: ['外部服务连接！', '数据库查询就绪！', 'MCP桥接中！'],
    delegating: ['任务分发中！', '并行处理启动！', '子代理就位！'],
    automating: ['自动化触发！', '无需思考执行！', 'Hook已激活！'],
    specifying: ['规格文档编写中！', '需求对齐！', '先规格后代码！'],
    syncing: ['文档同步中！', '先改文档再写代码！', '保持一致性！'],
    questioning: ['需要澄清！', '不懂就问！', '需求细节确认！'],
    planning: ['计划制定中！', '先计划后执行！', '多文件规划！'],
    retrieving: ['检索记忆中的思想...', '从钻石库中调取！', '思想检索中！'],
    distilling: ['提炼思想钻石！', '压缩知识精华！', '高置信度提炼！'],
    deduplicating: ['查重去冗余！', '信息密度优化！', '剔除重复！'],
    updating: ['思想已存入记忆！', '永久记忆更新！', '认知进化！'],
  };

  /**
   * 从数组中随机选取一个元素
   * @param {Array} arr - 待选取的数组
   * @returns {*} 数组中的随机元素
   */
  function randomFrom(arr) { return (Array.isArray(arr) && arr.length > 0) ? arr[Math.floor(Math.random() * arr.length)] : ''; }
  /**
   * 计算指定等级升级所需的经验值
   * @description 采用指数增长公式 80 * 1.25^(lv-1)，等级越高所需XP越多
   * @param {number} lv - 目标等级
   * @returns {number} 该等级升级所需XP值
   */
  function xpForLevel(lv) { return (typeof lv === 'number' && lv >= 1 && isFinite(lv)) ? Math.floor(TIMING.LEVEL_XP_BASE * Math.pow(TIMING.LEVEL_XP_FACTOR, lv - 1)) : TIMING.LEVEL_XP_BASE; }
  /**
   * 根据等级获取对应的成长阶段信息
   * @param {number} lv - 当前等级
   * @returns {{minLevel: number, name: string, color: string}} 匹配的阶段对象
   */
  function getStage(lv) { var s = STAGES[0]; for (var i = 0; i < STAGES.length; i++) { if (lv >= STAGES[i].minLevel) s = STAGES[i]; } return s; }

  /**
   * 记录一条事件到事件日志
   * @param {string} text - 事件描述文本
   * @param {string} [type='info'] - 事件类型（info/success/warning/error/level/xp）
   */
  function logEvent(text, type) {
    var validTypes = { info: 1, success: 1, warning: 1, error: 1, level: 1, xp: 1 };
    var t = validTypes[type] ? type : 'info';
    var now = new Date();
    var time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    eventLog.unshift({ text: text, type: t, time: time });
    if (eventLog.length > TIMING.MAX_EVENT_LOG) eventLog.length = TIMING.MAX_EVENT_LOG;
    renderEventLog();
  }

  function activateVibeCapability(capKey) {
    var cap = VIBE_CAPABILITIES[capKey];
    if (!cap) return;
    state.manualState = true;
    setAIState(capKey);
    showSpeech(cap.icon + ' ' + cap.name + ' — ' + cap.desc, 4000);
    showToast(cap.icon + ' ' + cap.name + ': ' + cap.desc, 'info');
    spawnBurstParticles(8);
    addXP(5, cap.name, false);
    logEvent('Vibe能力激活: ' + cap.name, 'success');
    if (capKey === 'designing') spawnFx('sparkle');
    if (capKey === 'architecting') spawnFx('sparkle');
  }

  function activateSuperAgent(capKey) {
    var cap = SUPERAGENT_CAPABILITIES[capKey];
    if (!cap) return;
    state.manualState = true;
    setAIState(capKey);
    showSpeech(cap.icon + ' ' + cap.name + ' — ' + cap.desc, 4000);
    showToast(cap.icon + ' ' + cap.name + ': ' + cap.desc, 'info');
    spawnBurstParticles(8);
    addXP(5, cap.name, false);
    logEvent('SuperAgent能力激活: ' + cap.name, 'success');
    if (capKey === 'integrating') spawnFx('sparkle');
    if (capKey === 'selfhealing') spawnFx('sparkle');
  }

  function activateExtension(extKey) {
    var ext = EXTENSION_LAYERS[extKey];
    if (!ext) return;
    state.manualState = true;
    setAIState(extKey);
    showSpeech(ext.icon + ' ' + ext.name + ' — ' + ext.desc, 4000);
    showToast(ext.icon + ' ' + ext.name + ': ' + ext.desc, 'info');
    spawnBurstParticles(8);
    addXP(5, ext.name, false);
    logEvent('扩展层激活: ' + ext.name + ' (成本:' + ext.cost + '/5 触发:' + ext.trigger + ')', 'success');
    if (extKey === 'memorizing') spawnFx('sparkle');
    if (extKey === 'skilling') spawnFx('sparkle');
  }

  function activateSDD(sddKey) {
    var sdd = SDD_PRACTICES[sddKey];
    if (!sdd) return;
    state.manualState = true;
    setAIState(sddKey);
    showSpeech(sdd.icon + ' ' + sdd.name + ' — ' + sdd.desc, 4000);
    showToast(sdd.icon + ' ' + sdd.name + ': ' + sdd.desc, 'info');
    spawnBurstParticles(8);
    addXP(5, sdd.name, false);
    logEvent('SDD实践激活: ' + sdd.name + ' (进化阶段:' + sdd.evolution + '/5 成本:' + sdd.cost + '/5)', 'success');
    if (sddKey === 'specifying') spawnFx('sparkle');
    if (sddKey === 'planning') spawnFx('sparkle');
  }

  function activateThoughtDiamond(tdKey) {
    var td = THOUGHT_DIAMOND[tdKey];
    if (!td) return;
    state.manualState = true;
    setAIState(tdKey);
    showSpeech(td.icon + ' ' + td.name + ' — ' + td.desc, 4000);
    showToast(td.icon + ' ' + td.name + ': ' + td.desc, 'info');
    spawnBurstParticles(8);
    addXP(5, td.name, false);
    logEvent('思想钻石: ' + td.name + ' (步骤:' + td.step + '/5 品级:' + td.tier + ')', 'success');
    if (tdKey === 'distilling') spawnFx('sparkle');
    if (tdKey === 'updating') spawnConfetti(6);
  }

  /**
   * 渲染事件日志到面板
   * @description 取最近10条事件渲染到 #eventLog 元素中，每条显示时间和文本
   */
  function renderEventLog() {
    var el = els.eventLog;
    if (!el) return;
    el.textContent = '';
    eventLog.slice(0, 10).forEach(function (e) {
      var entry = document.createElement('div');
      entry.className = 'log-entry log-' + e.type;
      var timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = e.time;
      var textSpan = document.createElement('span');
      textSpan.className = 'log-text';
      textSpan.textContent = e.text;
      entry.appendChild(timeSpan);
      entry.appendChild(textSpan);
      el.appendChild(entry);
    });
  }

  /**
   * 从 localStorage 加载持久化设置
   * @description 读取 companion-settings 键，恢复皮肤、心情、漫游、模式开关和成长数据到 state。
   *   解析失败时静默忽略，确保首次启动安全。
   */
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}');
      if (s.skin && SKINS[s.skin]) state.currentSkin = s.skin;
      if (s.mood && ({ happy: 1, calm: 1, energetic: 1 }[s.mood])) state.mood = s.mood;
      if (s.isRoaming) state.isRoaming = true;
      if (s.minimalMode) state.minimalMode = true;
      if (s.dndMode) state.dndMode = true;
      if (s.clickThrough) state.clickThroughEnabled = true;
      if (s.edgeAutoMinimal) state.edgeAutoMinimal = true;
      if (s.growth) {
        var g = s.growth;
        state.growth.level = (typeof g.level === 'number' && g.level > 0) ? g.level : 1;
        state.growth.xp = (typeof g.xp === 'number' && g.xp >= 0) ? g.xp : 0;
        state.growth.totalXp = (typeof g.totalXp === 'number' && g.totalXp >= 0) ? g.totalXp : 0;
        state.growth.totalInteractions = (typeof g.totalInteractions === 'number' && g.totalInteractions >= 0) ? g.totalInteractions : 0;
        state.growth.petCount = (typeof g.petCount === 'number' && g.petCount >= 0) ? g.petCount : 0;
        state.growth.dragCount = (typeof g.dragCount === 'number' && g.dragCount >= 0) ? g.dragCount : 0;
        state.growth.danceCount = (typeof g.danceCount === 'number' && g.danceCount >= 0) ? g.danceCount : 0;
        state.growth.roamCount = (typeof g.roamCount === 'number' && g.roamCount >= 0) ? g.roamCount : 0;
        state.growth.skinsUsed = Array.isArray(g.skinsUsed) ? g.skinsUsed.filter(function(s) { return SKINS[s]; }) : ['robot'];
        state.growth.achievements = Array.isArray(g.achievements) ? g.achievements : [];
        state.growth.fileDropCount = (typeof g.fileDropCount === 'number' && g.fileDropCount >= 0) ? g.fileDropCount : 0;
        state.growth.permApproved = (typeof g.permApproved === 'number' && g.permApproved >= 0) ? g.permApproved : 0;
        state.growth.permDenied = (typeof g.permDenied === 'number' && g.permDenied >= 0) ? g.permDenied : 0;
      }
    } catch {}
  }

  /**
   * 保存当前设置到 localStorage
   * @description 将皮肤、心情、模式开关和成长数据序列化为JSON写入 companion-settings 键。
   *   写入失败时静默忽略（如存储配额已满）。
   */
  function saveSettings() {
    try {
      var g = {
        level: state.growth.level, xp: state.growth.xp, totalXp: state.growth.totalXp,
        totalInteractions: state.growth.totalInteractions, petCount: state.growth.petCount,
        dragCount: state.growth.dragCount, danceCount: state.growth.danceCount,
        roamCount: state.growth.roamCount, skinsUsed: state.growth.skinsUsed,
        achievements: state.growth.achievements, fileDropCount: state.growth.fileDropCount,
        permApproved: state.growth.permApproved, permDenied: state.growth.permDenied,
      };
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({
        skin: state.currentSkin, mood: state.mood, isRoaming: state.isRoaming,
        minimalMode: state.minimalMode, dndMode: state.dndMode,
        clickThrough: state.clickThroughEnabled, edgeAutoMinimal: state.edgeAutoMinimal,
        growth: g,
      }));
    } catch {}
  }

  /**
   * 初始化桌面伙伴
   * @description 桌面伙伴的核心入口函数，执行以下初始化流程：
   *   1. 加载持久化设置（loadSettings）
   *   2. 批量获取并缓存所有DOM元素引用到 els 对象
   *   3. 应用已保存的皮肤样式
   *   4. 创建粒子背景和设置各项交互（眼球追踪、眨眼、拖拽、右键菜单、点击、面板等）
   *   5. 启动API轮询和恢复窗口位置
   *   6. 应用心情、更新成长UI、检查成就
   *   7. 恢复漫游/迷你/免打扰/穿透等模式状态
   *   8. 延时显示时段问候语和入场动画
   *   9. 启动定时主题切换和窗口位置自动保存
   */
  function init() {
    loadSettings();
    els.body = document.getElementById('companionBody');
    els.head = document.getElementById('companionHead');
    els.leftEye = document.getElementById('leftEye');
    els.rightEye = document.getElementById('rightEye');
    els.leftPupil = document.getElementById('leftPupil');
    els.rightPupil = document.getElementById('rightPupil');
    els.mouth = document.getElementById('mouth');
    els.coreLight = document.getElementById('coreLight');
    els.statusDot = document.getElementById('statusDot');
    els.statusText = document.getElementById('statusText');
    els.stageText = document.getElementById('stageText');
    els.speechBubble = document.getElementById('speechBubble');
    els.speechText = document.getElementById('speechText');
    els.contextMenu = document.getElementById('contextMenu');
    els.companion = document.getElementById('companion');
    els.miniPanel = document.getElementById('miniPanel');
    els.panelClose = document.getElementById('panelClose');
    els.particles = document.getElementById('particles');
    els.aura = document.getElementById('aura');
    els.infoActiveAgent = document.getElementById('infoActiveAgent');
    els.infoPhase = document.getElementById('infoPhase');
    els.infoTokens = document.getElementById('infoTokens');
    els.infoLevel = document.getElementById('infoLevel');
    els.infoStage = document.getElementById('infoStage');
    els.infoXP = document.getElementById('infoXP');
    els.infoTotalInteractions = document.getElementById('infoTotalInteractions');
    els.infoAIState = document.getElementById('infoAIState');
    els.brandBadge = document.getElementById('brandBadge');
    els.thoughtBubble = document.getElementById('thoughtBubble');
    els.toastContainer = document.getElementById('toastContainer');
    els.fxLayer = document.getElementById('fxLayer');
    els.sweatDrop = document.getElementById('sweatDrop');
    els.exclaim = document.getElementById('exclaim');
    els.levelBadge = document.getElementById('levelBadge');
    els.xpBarFill = document.getElementById('xpBarFill');
    els.xpBarText = document.getElementById('xpBarText');
    els.levelUpOverlay = document.getElementById('levelUpOverlay');
    els.levelUpLevel = document.getElementById('levelUpLevel');
    els.zzz = document.getElementById('zzz');
    els.notificationSign = document.getElementById('notificationSign');
    els.signText = document.getElementById('signText');
    els.hudDot = document.getElementById('hudDot');
    els.hudLabel = document.getElementById('hudLabel');
    els.permissionCard = document.getElementById('permissionCard');
    els.permAgent = document.getElementById('permAgent');
    els.permAction = document.getElementById('permAction');
    els.permClose = document.getElementById('permClose');
    els.permApprove = document.getElementById('permApprove');
    els.permDeny = document.getElementById('permDeny');
    els.antennaArea = document.getElementById('antennaArea');
    els.ambientRing = document.getElementById('ambientRing');
    els.edgeIndicator = document.getElementById('edgeIndicator');
    els.eventLog = document.getElementById('eventLog');

    var REQUIRED_ELS = ['body', 'companion', 'leftEye', 'rightEye', 'mouth', 'speechBubble', 'speechText', 'contextMenu', 'miniPanel', 'fxLayer', 'coreLight'];
    var missing = REQUIRED_ELS.filter(function (k) { return !els[k]; });
    if (missing.length) {
      console.error('[Companion] 关键DOM元素缺失，初始化中止:', missing.join(', '));
      return;
    }

    if (state.currentSkin !== 'robot' && SKINS[state.currentSkin]) {
      SKIN_CLASSES.forEach(function (cls) { els.companion.classList.remove(cls); });
      els.companion.classList.add('skin-' + state.currentSkin);
      if (els.brandBadge) els.brandBadge.textContent = SKINS[state.currentSkin].badge;
    }

    document.addEventListener('mousemove', function (e) {
      state.mousePos = { x: e.clientX, y: e.clientY };
      updatePupils();
      if (state.clickThroughEnabled) {
        var el = document.elementFromPoint(e.clientX, e.clientY);
        var isCompanion = el && (el.closest('.companion-body') || el.closest('.mini-panel') || el.closest('.context-menu') || el.closest('.permission-card') || el.closest('.speech-bubble'));
        api.setIgnoreMouseEvents(!isCompanion, isCompanion ? undefined : { forward: true });
      }
      if (state.handleDragMove) state.handleDragMove(e);
      resetIdle();
    });

    createParticles();
    setupEyeTracking();
    setupBlinking();
    setupDrag();
    setupContextMenu();
    setupClickInteraction();
    setupMiniPanel();
    setupCommandButtons();
    setupSpeechListener();
    setupIdleDetection();
    setupHoverEffects();
    setupClickThrough();
    setupPermissionCard();
    setupGlobalShortcuts();
    setupTooltipSystem();
    setupDragDrop();
    startApiPolling();
    setMood(state.mood);
    updateGrowthUI();
    checkAchievements();
    updateHUD();

    if (state.isRoaming) startRoaming();
    if (state.minimalMode) els.companion.classList.add('minimal');
    if (state.dndMode) els.companion.classList.add('dnd');
    if (state.clickThroughEnabled) els.companion.classList.add('clickthrough');

    setTimeout(function () {
      var timeGreet = getTimeGreeting();
      showSpeech(timeGreet.text);
      els.body.classList.add('entrance');
      setTimeout(function () { els.body.classList.remove('entrance'); }, 800);
      if (state.growth.totalInteractions === 0) addXP(5, '初次见面', false);
      logEvent('桌面伙伴启动 — ' + timeGreet.period, 'info');
      applyTimeTheme();
    }, 500);

    var themeTimer = setInterval(function () { applyTimeTheme(); }, 60000);
    state.intervals.push(themeTimer);
    restoreWindowPosition();

    window.addEventListener('beforeunload', function () {
      state.intervals.forEach(function (id) { clearInterval(id); });
      state.intervals.length = 0;
      if (state.blinkTimer) clearTimeout(state.blinkTimer);
      if (state.idleActionTimer) clearInterval(state.idleActionTimer);
      state.sleepTimers.forEach(function (t) { clearTimeout(t); });
      clearTimeout(state.idleTimer);
      clearTimeout(state.speechTimeout);
      clearTimeout(state.fxTimeout);
      clearTimeout(state.actionTimeout);
      clearTimeout(state.permTimeout);
      clearTimeout(state.petTimer);
      clearTimeout(state.roamStepTimer);
      clearTimeout(state.longPressTimer);
      clearTimeout(state.excitedTimer);
      clearTimeout(state.skinTransitionTimer);
      clearTimeout(state.levelUpTimer);
      if (state.roamWalkInterval) clearInterval(state.roamWalkInterval);
      if (audioCtx) { try { audioCtx.close(); audioCtx = null; } catch (e) {} }
    });
  }

  /**
   * 设置点击穿透模式
   * @description 监听鼠标移动事件，判断鼠标是否在伙伴元素上。
   *   若不在伙伴元素上且点击穿透已启用，则通知主进程忽略鼠标事件（实现窗口穿透）。
   */
  function setupClickThrough() {
  }

  /**
   * 设置权限审批卡片的事件监听
   * @description 绑定权限卡片的关闭、批准、拒绝按钮事件，并监听主进程的权限请求回调。
   *   批准权限时增加 permApproved 计数并奖励5XP，拒绝时增加 permDenied 计数。
   */
  function setupPermissionCard() {
    if (!els.permClose || !els.permApprove || !els.permDeny) return;
    els.permClose.addEventListener('click', function (e) { e.stopPropagation(); hidePermissionCard(); });
    els.permApprove.addEventListener('click', function (e) {
      e.stopPropagation();
      showSpeech(randomFrom(SPEECH.permApprove));
      state.growth.permApproved++;
      addXP(5, '批准权限');
      logEvent('批准权限: ' + els.permAction.textContent, 'success');
      playSound('success');
      hidePermissionCard();
    });
    els.permDeny.addEventListener('click', function (e) {
      e.stopPropagation();
      showSpeech(randomFrom(SPEECH.permDeny));
      state.growth.permDenied++;
      logEvent('拒绝权限: ' + els.permAction.textContent, 'warning');
      hidePermissionCard();
    });
    if (api.onPermissionRequest) {
      api.onPermissionRequest(function (data) {
        var d = data || {};
        showPermissionCard(d.agent || '未知角色', d.action || '请求操作');
      });
    }
  }

  /**
   * 获取当前时段的问候语
   * @description 根据当前小时数判断时段（早晨/午后/傍晚/深夜），返回时段名称和对应问候语。
   * @returns {{period: string, text: string}} 时段名称和随机问候语文本
   */
  function getTimeGreeting() {
    var h = new Date().getHours();
    if (h >= 6 && h < 12) return { period: '早晨', text: randomFrom(SPEECH.greetMorning) };
    if (h >= 12 && h < 18) return { period: '午后', text: randomFrom(SPEECH.greetNoon) };
    if (h >= 18 && h < 22) return { period: '傍晚', text: randomFrom(SPEECH.greetEvening) };
    return { period: '深夜', text: randomFrom(SPEECH.greetNight) };
  }

  /**
   * 应用时段主题样式
   * @description 根据当前时间在根元素上添加对应的时段CSS类（time-morning/afternoon/evening/night），
   *   用于调整伙伴的整体色调氛围。每60秒自动调用一次。
   */
  function applyTimeTheme() {
    var h = new Date().getHours();
    var root = document.documentElement;
    TIME_CLASSES.forEach(function (cls) { root.classList.remove(cls); });
    if (h >= 6 && h < 12) root.classList.add('time-morning');
    else if (h >= 12 && h < 18) root.classList.add('time-afternoon');
    else if (h >= 18 && h < 22) root.classList.add('time-evening');
    else root.classList.add('time-night');
  }

  /**
   * 恢复窗口位置并启动自动保存
   * @description 从 localStorage 读取上次保存的窗口坐标，若与当前位置不同且在屏幕范围内则移动窗口。
   *   同时启动5秒间隔的定时器，持续将窗口位置保存到 localStorage。
   */
  function restoreWindowPosition() {
    try {
      var pos = JSON.parse(localStorage.getItem(STORAGE_KEYS.windowPos) || 'null');
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        Promise.all([api.getWindowPosition(), api.getScreenSize()]).then(function (results) {
          var current = results[0], screen = results[1];
          if (!screen) return;
          var cx = Array.isArray(current) ? current[0] : (current && typeof current.x === 'number' ? current.x : 0);
          var cy = Array.isArray(current) ? current[1] : (current && typeof current.y === 'number' ? current.y : 0);
          if (cx === pos.x && cy === pos.y) return;
          if (pos.x >= 0 && pos.x < Math.max(0, screen.width - 50) && pos.y >= 0 && pos.y < Math.max(0, screen.height - 50)) {
            api.moveWindow(pos.x - cx, pos.y - cy);
          }
        }).catch(function () {});
      }
    } catch {}
    var posTimer = setInterval(function () {
      api.getWindowPosition().then(function (pos) {
        if (pos) {
          var px = Array.isArray(pos) ? pos[0] : (typeof pos.x === 'number' ? pos.x : null);
          var py = Array.isArray(pos) ? pos[1] : (typeof pos.y === 'number' ? pos.y : null);
          if (typeof px === 'number' && typeof py === 'number') {
            try { localStorage.setItem(STORAGE_KEYS.windowPos, JSON.stringify({ x: px, y: py })); } catch {}
          }
        }
      });
    }, 5000);
    state.intervals.push(posTimer);
  }

  /**
   * 在迷你模式下显示轻量通知
   * @description 仅在迷你模式激活时显示，创建临时DOM元素并添加入场/退场动画，2.5秒后自动消失。
   * @param {string} text - 通知文本
   * @param {string} [type='info'] - 通知类型（info/success/warning/error）
   */
  function showMinimalNotification(text, type) {
    if (!state.minimalMode) return;
    els.companion.querySelectorAll('.minimal-notif').forEach(function (el) { el.remove(); });
    var notif = document.createElement('div');
    var validTypes = { info: 1, success: 1, warning: 1, error: 1 };
    notif.className = 'minimal-notif minimal-notif-' + (validTypes[type] ? type : 'info');
    notif.textContent = text;
    els.companion.appendChild(notif);
    requestAnimationFrame(function () { notif.classList.add('visible'); });
    setTimeout(function () {
      notif.classList.remove('visible');
      setTimeout(function () { notif.remove(); }, 300);
    }, 2500);
  }

  /**
   * 显示权限审批卡片
   * @description 当Agent请求权限时弹出审批卡片，设置AI状态为通知模式，
   *   显示通知标志，记录事件日志，奖励3XP，并在迷你模式下显示轻量通知。
   *   30秒未操作则自动拒绝并提示超时。
   * @param {string} agent - 请求权限的Agent名称
   * @param {string} action - 请求的操作描述
   */
  function showPermissionCard(agent, action) {
    if (!els.permissionCard) return;
    if (els.permAgent) els.permAgent.textContent = agent;
    if (els.permAction) els.permAction.textContent = action;
    els.permissionCard.classList.add('visible');
    state.manualState = true;
    setAIState('notification');
    if (els.notificationSign) els.notificationSign.classList.add('visible');
    if (els.signText) els.signText.textContent = '?';
    logEvent('权限请求: ' + agent + ' - ' + action, 'warning');
    addXP(3, '权限请求', false);
    showMinimalNotification('🔐 ' + agent, 'warning');
    clearTimeout(state.permTimeout);
    state.permTimeout = setTimeout(function () {
      if (els.permissionCard && els.permissionCard.classList.contains('visible')) {
        logEvent('权限超时自动拒绝: ' + action, 'warning');
        hidePermissionCard();
        showToast('权限请求超时已自动拒绝', 'warning');
      }
    }, 30000);
  }

  /**
   * 隐藏权限审批卡片
   * @description 移除卡片和通知标志的可见状态，清除超时定时器，恢复AI状态为空闲并重新应用心情。
   */
  function hidePermissionCard() {
    if (els.permissionCard) els.permissionCard.classList.remove('visible');
    if (els.notificationSign) els.notificationSign.classList.remove('visible');
    clearTimeout(state.permTimeout);
    var prevState = state.prevAiState && state.prevAiState !== 'notification' ? state.prevAiState : 'idle';
    setAIState(prevState);
    setMood(state.mood);
  }

  /**
   * 设置工具提示系统
   * @description 为关键DOM元素（头部、核心灯、等级徽章等）绑定鼠标悬停提示，
   *   动态创建tooltip元素并根据目标元素位置定位显示。
   */
  function setupTooltipSystem() {
    var tips = {
      companionHead: '摸摸头~ 长按抱抱',
      coreLight: '核心能量灯 · 点击切换状态',
      levelBadge: '等级徽章 · 点击查看成长',
      statusDot: '连接状态指示器',
      hudDot: 'AI当前状态',
      brandBadge: '品牌标识 · 右键切换形象',
    };
    var tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.id = 'tooltip';
    els.companion.appendChild(tooltip);

    Object.keys(tips).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('mouseenter', function (e) {
        tooltip.textContent = tips[id];
        tooltip.classList.add('visible');
        var rect = el.getBoundingClientRect();
        var cRect = els.companion.getBoundingClientRect();
        tooltip.style.left = (rect.left - cRect.left + rect.width / 2) + 'px';
        tooltip.style.top = (rect.top - cRect.top - 28) + 'px';
      });
      el.addEventListener('mouseleave', function () {
        tooltip.classList.remove('visible');
      });
    });
  }

  /**
   * 设置文件拖放交互
   * @description 监听伙伴元素上的文件拖放事件，接收文件后显示文件名、
   *   增加 fileDropCount、奖励10XP、触发兴奋动画和粒子爆发效果。
   */
  function setupDragDrop() {
    els.companion.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.companion.classList.add('drop-target');
    });
    els.companion.addEventListener('dragleave', function () {
      els.companion.classList.remove('drop-target');
    });
    els.companion.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.companion.classList.remove('drop-target');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        var names = [];
        for (var i = 0; i < Math.min(files.length, TIMING.MAX_FILES_PREVIEW); i++) names.push(files[i].name);
        showSpeech('收到文件: ' + names.join(', '), 4000);
        showToast('文件已接收: ' + names.join(', '), 'success');
        state.growth.fileDropCount++;
        addXP(TIMING.FILE_DROP_XP, '接收文件');
        logEvent('拖放文件: ' + names.join(', '), 'info');
        spawnBurstParticles(8);
        triggerExcited();
      }
    });
  }

  /**
   * Web Audio API 音频上下文实例
   * @type {AudioContext|null}
   */
  var audioCtx = null;

  /**
   * 播放音效
   * @description 使用 Web Audio API 合成简短的提示音效。根据类型设置不同频率和增益：
   *   click(800Hz)、levelup(523→659→784Hz三连音)、error(200Hz)、success(660Hz)、perm(440Hz)。
   *   首次调用时创建 AudioContext，若被暂停则自动恢复。所有异常静默忽略。
   * @param {string} type - 音效类型（click/levelup/error/success/perm/其他）
   */
  var SOUND_CONFIG = {
    click: { freq: 800, gain: 0.04 },
    levelup: { freq: 523, gain: 0.08 },
    error: { freq: 200, gain: 0.05 },
    success: { freq: 660, gain: 0.06 },
    perm: { freq: 440, gain: 0.07 },
  };
  var SOUND_DEFAULT = { freq: 600, gain: 0.04 };

  function playSound(type) {
    if (typeof window.AudioContext !== 'function' && typeof window.webkitAudioContext !== 'function') return;
    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') { audioCtx.resume(); }
      var cfg = SOUND_CONFIG[type] || SOUND_DEFAULT;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      gain.gain.value = cfg.gain;
      osc.frequency.value = cfg.freq;
      osc.onended = function () { try { gain.disconnect(); osc.disconnect(); } catch (e) {} };
      osc.start();
      if (type === 'levelup') {
        setTimeout(function () { try { osc.frequency.value = 659; } catch (e) {} }, 100);
        setTimeout(function () { try { osc.frequency.value = 784; } catch (e) {} }, 200);
        setTimeout(function () { try { osc.stop(); } catch (e) {} }, 400);
      } else {
        setTimeout(function () { try { osc.stop(); } catch (e) {} }, 120);
      }
    } catch {}
  }

  /**
   * 设置全局快捷键
   * @description 注册键盘快捷键：Ctrl+Shift+Y 批准权限、Ctrl+Shift+N 拒绝权限、Escape 关闭菜单/面板/权限卡片。
   *   同时监听主进程的权限快捷键回调。
   */
  function setupGlobalShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && e.key === 'Y') {
        e.preventDefault();
        if (els.permissionCard && els.permissionCard.classList.contains('visible')) {
          if (els.permApprove) els.permApprove.click();
          showToast('快捷键: 批准权限', 'success');
        }
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        if (els.permissionCard && els.permissionCard.classList.contains('visible')) {
          if (els.permDeny) els.permDeny.click();
          showToast('快捷键: 拒绝权限', 'warning');
        }
      }
      if (e.key === 'Escape') {
        if (els.contextMenu.classList.contains('visible')) els.contextMenu.classList.remove('visible');
        else if (els.miniPanel.classList.contains('visible')) closePanel();
        else if (els.permissionCard && els.permissionCard.classList.contains('visible')) hidePermissionCard();
      }
    });
    if (api.onPermissionShortcut) {
      api.onPermissionShortcut(function (action) {
        if (action === 'approve' && els.permissionCard && els.permissionCard.classList.contains('visible')) {
          if (els.permApprove) els.permApprove.click();
          showToast('全局快捷键: 批准权限', 'success');
        } else if (action === 'deny' && els.permissionCard && els.permissionCard.classList.contains('visible')) {
          if (els.permDeny) els.permDeny.click();
          showToast('全局快捷键: 拒绝权限', 'warning');
        }
      });
    }
  }

  /**
   * 生成杂耍球特效元素
   * @description 在特效层中创建3个杂耍球DOM元素，配合CSS动画实现抛接效果。
   */
  function spawnJuggleBalls() {
    for (var i = 0; i < 3; i++) {
      (function () {
        var b = document.createElement('div');
        b.className = 'fx-juggle-ball';
        els.fxLayer.appendChild(b);
        setTimeout(function () { b.remove(); }, 3000);
      })();
    }
  }

  /**
   * 触发空闲动作
   * @description 执行指定的空闲动画行为，添加对应的CSS类、显示语音台词、
   *   触发关联特效（如杂耍球、清扫粒子），并在动画结束后恢复心情状态。
   * @param {string} actionName - 动作名称（yawn/stretch/lookAround/breathe/think/nod/peek/sweep/juggle/carry）
   */
  function triggerIdleAction(actionName) {
    clearFx();
    clearAIState();
    var cls = 'idle-' + actionName;
    addFxClass(cls);
    var speechKey = actionName;
    var speechKeyMap = { look: 'lookAround' };
    if (speechKeyMap[actionName]) speechKey = speechKeyMap[actionName];
    if (SPEECH[speechKey]) showSpeech(randomFrom(SPEECH[speechKey]), 2500);
    if (actionName === 'juggle') spawnJuggleBalls();
    if (actionName === 'sweep') spawnBurstParticles(3);
    if (actionName === 'carry') addXP(2, '搬运');
    else addXP(1, actionName);
    var duration = actionName === 'sweep' ? 3000 : actionName === 'juggle' ? 2500 : 2000;
    state.actionTimeout = setTimeout(function () {
      clearFx();
      setMood(state.mood);
    }, duration);
  }

  /**
   * 检测窗口是否在屏幕边缘并自动切换迷你模式
   * @description 当贴边自动迷你模式启用时，检测窗口是否贴近屏幕左右边缘（10px内），
   *   若是则自动进入迷你模式并显示贴边指示器。
   */
  function checkEdgePosition() {
    if (!state.edgeAutoMinimal) return;
    Promise.all([api.getWindowPosition(), api.getScreenSize()]).then(function (results) {
      var pos = results[0], screen = results[1];
      if (!pos || !screen) return;
      var px = Array.isArray(pos) ? pos[0] : (typeof pos.x === 'number' ? pos.x : 0);
      var atRightEdge = px + 276 >= screen.width - 10;
      var atLeftEdge = px <= 10;
      if ((atRightEdge || atLeftEdge) && !state.minimalMode) {
        state.minimalMode = true;
        els.companion.classList.add('minimal');
        if (!state.dndMode) showSpeech(randomFrom(SPEECH.edgeHide), 2000);
        if (els.edgeIndicator) { els.edgeIndicator.classList.add('visible'); setTimeout(function () { if (els.edgeIndicator) els.edgeIndicator.classList.remove('visible'); }, 2000); }
        saveSettings();
      }
    }).catch(function () {});
  }

  /**
   * 增加经验值
   * @description 核心成长函数。累加XP到当前等级和总XP，若达到升级阈值则循环升级。
   *   每次升级触发 onLevelUp()，最后更新成长UI、保存设置、检查成就并记录事件日志。
   * @param {number} amount - 增加的XP数量
   * @param {string} [reason] - 获得XP的原因描述，用于事件日志
   */
  function addXP(amount, reason, countInteraction) {
    if (typeof amount !== 'number' || !(amount > 0) || !isFinite(amount)) return;
    state.growth.xp += amount;
    state.growth.totalXp += amount;
    if (countInteraction !== false) state.growth.totalInteractions++;
    var needed = xpForLevel(state.growth.level);
    var safetyLimit = 50;
    while (state.growth.xp >= needed && needed > 0 && safetyLimit-- > 0) {
      state.growth.xp -= needed;
      state.growth.level++;
      needed = xpForLevel(state.growth.level);
      onLevelUp();
    }
    updateGrowthUI();
    saveSettings();
    checkAchievements();
    if (reason) logEvent(reason + ' (+' + amount + 'XP)', 'xp');
  }

  /**
   * 升级处理函数
   * @description 升级时触发：显示升级语音和Toast、播放升级音效、显示升级覆盖层动画、
   *   生成五彩纸屑和粒子爆发效果，2.5秒后隐藏覆盖层。
   */
  function onLevelUp() {
    try {
    var lv = state.growth.level;
    var stage = getStage(lv);
    showSpeech(randomFrom(SPEECH.levelUp) + ' Lv.' + lv + ' ' + stage.name, 4000);
    showToast('升级到 Lv.' + lv + ' — ' + stage.name, 'success');
    if (els.levelUpLevel) els.levelUpLevel.textContent = 'Lv.' + lv;
    if (!state.dndMode) {
      playSound('levelup');
      showMinimalNotification('⬆️ Lv.' + lv, 'success');
      if (els.levelUpOverlay) els.levelUpOverlay.classList.add('visible');
      spawnConfetti(20);
      spawnBurstParticles(10);
      clearTimeout(state.levelUpTimer);
      state.levelUpTimer = setTimeout(function () { if (els.levelUpOverlay) els.levelUpOverlay.classList.remove('visible'); state.levelUpTimer = null; }, TIMING.LEVEL_UP_OVERLAY);
    }
    logEvent('升级! Lv.' + lv + ' ' + stage.name, 'level');
    } catch (e) { console.error('onLevelUp', e); }
  }

  /**
   * 更新成长相关UI元素
   * @description 刷新等级徽章、XP进度条、阶段文本、面板中的等级/阶段/XP/互动次数等信息。
   */
  function updateGrowthUI() {
    var g = state.growth;
    var needed = xpForLevel(g.level);
    var pct = Math.min(100, (g.xp / needed) * 100);
    var stage = getStage(g.level);
    if (els.levelBadge) els.levelBadge.textContent = 'Lv.' + g.level;
    if (els.xpBarFill) els.xpBarFill.style.width = pct + '%';
    if (els.xpBarText) els.xpBarText.textContent = g.xp + ' / ' + needed + ' XP';
    if (els.stageText) { els.stageText.textContent = stage.name; els.stageText.style.color = stage.color; }
    if (els.infoLevel) els.infoLevel.textContent = 'Lv.' + g.level;
    if (els.infoStage) els.infoStage.textContent = stage.name;
    if (els.infoXP) els.infoXP.textContent = g.xp + ' / ' + needed;
    if (els.infoTotalInteractions) els.infoTotalInteractions.textContent = g.totalInteractions;
  }

  /**
   * 检查并解锁成就
   * @description 遍历所有成就定义，对未解锁的成就执行检查函数。达成时添加到成就列表、
   *   更新DOM状态、显示语音和Toast提示、奖励20XP。免打扰模式下仅解锁不提示。
   */
  var checkingAchievements = false;
  var achievementsNeedRecheck = false;

  function checkAchievements() {
    if (checkingAchievements) { achievementsNeedRecheck = true; return; }
    checkingAchievements = true;
    do {
      achievementsNeedRecheck = false;
      var g = state.growth;
      Object.keys(ACHIEVEMENTS).forEach(function (key) {
        if (g.achievements.indexOf(key) >= 0) return;
        try {
          if (!ACHIEVEMENTS[key].check(g)) return;
        } catch (e) { return; }
        g.achievements.push(key);
        var achEl = document.getElementById('ach-' + key);
        if (achEl) { achEl.classList.remove('locked'); achEl.classList.add('unlocked'); }
        if (!state.dndMode) {
          showSpeech(randomFrom(SPEECH.achievement) + ' ' + ACHIEVEMENTS[key].name, 4000);
          showToast('🏆 成就解锁: ' + ACHIEVEMENTS[key].name, 'success');
        }
        addXP(TIMING.ACHIEVEMENT_XP, ACHIEVEMENTS[key].name, false);
      });
    } while (achievementsNeedRecheck);
    saveSettings();
    checkingAchievements = false;
  }

  /**
   * 设置AI工作状态
   * @description 核心状态切换函数。切换AI状态时：保存前一状态、清除旧状态样式、
   *   应用新状态的body类名和嘴巴类名、触发状态专属特效（思考气泡/汗滴/五彩纸屑/通知标志等）、
   *   播放对应音效、显示状态语音、更新HUD和面板信息、奖励3XP并记录事件日志。
   *   若新状态与当前相同则不做任何操作。
   * @param {string} newState - 目标AI状态键名（idle/thinking/typing/building/juggling/conducting/error/happy/notification）
   */
  function setAIState(newState) {
    if (state.aiState === newState) return;
    try {
    state.prevAiState = state.aiState;
    var isManual = VIBE_CAPABILITIES[newState] || SUPERAGENT_CAPABILITIES[newState] || EXTENSION_LAYERS[newState] || SDD_PRACTICES[newState] || THOUGHT_DIAMOND[newState];
    if (!isManual) state.manualState = false;
    clearAIState();
    state.aiState = newState;
    var cfg = AI_STATES[newState];
    if (!cfg) return;
    if (cfg.bodyClass) addFxClass(cfg.bodyClass);
    if (cfg.mouthClass) els.mouth.className = cfg.mouthClass;
    if (newState === 'thinking' && els.thoughtBubble) els.thoughtBubble.classList.add('visible');
    if (newState === 'error') { if (els.sweatDrop) els.sweatDrop.classList.add('visible'); if (els.exclaim) els.exclaim.classList.add('visible'); playSound('error'); showMinimalNotification('❌ ' + cfg.label, 'error'); }
    if (newState === 'happy') { spawnConfetti(10); spawnBurstParticles(6); playSound('success'); showMinimalNotification('✅ ' + cfg.label, 'success'); }
    if (newState === 'notification' && els.notificationSign) { els.notificationSign.classList.add('visible'); playSound('perm'); }
    if (cfg.speech && !state.dndMode) showSpeech(cfg.speech, 3000);
    updateHUD();
    if (els.infoAIState) els.infoAIState.textContent = cfg.label;
    if (newState !== 'idle') addXP(TIMING.AI_STATE_XP, 'AI状态: ' + cfg.label, false);
    logEvent('AI状态: ' + cfg.label, newState === 'error' ? 'error' : 'info');
    } catch (e) { console.error('setAIState', e); }
  }

  /**
   * 清除所有AI状态的视觉样式
   * @description 移除所有AI状态body类名、思考气泡、汗滴、感叹号、通知标志和特殊眼睛表情类。
   */
  function clearAIState() {
    Object.keys(AI_STATES).forEach(function (key) {
      if (AI_STATES[key].bodyClass) removeFxClass(AI_STATES[key].bodyClass);
    });
    if (els.mouth) els.mouth.className = 'mouth';
    if (els.thoughtBubble) els.thoughtBubble.classList.remove('visible');
    if (els.sweatDrop) els.sweatDrop.classList.remove('visible');
    if (els.exclaim) els.exclaim.classList.remove('visible');
    if (els.notificationSign) els.notificationSign.classList.remove('visible');
    EYE_EXPR_CLASSES.forEach(function (cls) { if (els.leftEye) els.leftEye.classList.remove(cls); if (els.rightEye) els.rightEye.classList.remove(cls); });
    state.aiState = 'idle';
  }

  /**
   * 更新HUD状态指示器
   * @description 根据当前AI状态更新HUD标签文本和状态点样式，用于顶部状态栏的实时显示。
   */
  var HUD_STATE_MAP = {
    idle: 'hud-idle', thinking: 'hud-thinking', typing: 'hud-typing',
    building: 'hud-building', juggling: 'hud-active', conducting: 'hud-active',
    optimizing: 'hud-building', converged: 'hud-happy',
    reviewing: 'hud-thinking', architecting: 'hud-building', validating: 'hud-typing', designing: 'hud-active',
    integrating: 'hud-active', selfhealing: 'hud-building', adapting: 'hud-typing',
    memorizing: 'hud-thinking', skilling: 'hud-active', connecting: 'hud-typing', delegating: 'hud-building', automating: 'hud-active',
    specifying: 'hud-thinking', syncing: 'hud-active', questioning: 'hud-building', planning: 'hud-typing',
    retrieving: 'hud-thinking', distilling: 'hud-building', deduplicating: 'hud-reviewing', updating: 'hud-happy',
    error: 'hud-error', happy: 'hud-happy', notification: 'hud-active',
  };

  function updateHUD() {
    var cfg = AI_STATES[state.aiState] || AI_STATES.idle;
    if (els.hudLabel) els.hudLabel.textContent = cfg.label;
    if (els.hudDot) els.hudDot.className = 'hud-dot ' + (HUD_STATE_MAP[state.aiState] || 'hud-active');
  }

  /**
   * 创建背景粒子效果
   * @description 根据当前皮肤选择粒子颜色方案，在粒子容器中生成18个随机大小、位置、
   *   动画时长和延迟的粒子DOM元素，营造氛围感。
   */
  var SKIN_COLORS = {
    robot: ['var(--primary)', 'var(--purple)', 'var(--cyan)', 'var(--primary-light)', 'var(--pink)'],
    cat: ['var(--success)', 'var(--cyan)', '#6ee7b7', '#a7f3d0', 'var(--primary-light)'],
    ghost: ['var(--purple)', 'var(--pink)', '#c4b5fd', '#f9a8d4', 'var(--primary-light)'],
    dragon: ['var(--warning)', 'var(--danger)', '#fdba74', '#fca5a5', 'var(--primary-light)'],
  };

  function createParticles() {
    var container = els.particles;
    if (!container) return;
    container.textContent = '';
    var colors = SKIN_COLORS[state.currentSkin] || SKIN_COLORS.robot;
    for (var i = 0; i < TIMING.PARTICLE_COUNT; i++) {
      var p = document.createElement('div');
      p.className = 'particle';
      var size = 1.5 + Math.random() * 3.5;
      p.style.width = size + 'px'; p.style.height = size + 'px';
      p.style.transform = 'translate(' + (10 + Math.random() * 160) + 'px,' + (20 + Math.random() * 200) + 'px)';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration = (3 + Math.random() * 6) + 's';
      p.style.animationDelay = (Math.random() * 8) + 's';
      container.appendChild(p);
    }
  }

  /**
   * 设置眼球追踪
   * @description 监听鼠标移动事件，更新鼠标位置状态并触发瞳孔位置更新和空闲计时器重置。
   */
  function setupEyeTracking() {
  }

  /**
   * 更新瞳孔位置
   * @description 根据鼠标位置计算每只眼睛的瞳孔偏移量，最大偏移3.5px，
   *   偏移量与鼠标距离成反比（近处比例大，远处趋于固定值）。
   */
  function updatePupils() {
    [els.leftEye, els.rightEye].forEach(function (eye, i) {
      if (!eye) return;
      var rect = eye.getBoundingClientRect();
      var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      var dx = state.mousePos.x - cx, dy = state.mousePos.y - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var maxMove = 3.5;
      var mx = dist > 0 ? (dx / dist) * Math.min(maxMove, dist * 0.04) : 0;
      var my = dist > 0 ? (dy / dist) * Math.min(maxMove, dist * 0.04) : 0;
      var pupil = i === 0 ? els.leftPupil : els.rightPupil;
      if (pupil) pupil.style.transform = 'translate(' + mx + 'px, ' + my + 'px)';
    });
  }

  /**
   * 设置自动眨眼
   * @description 以2.8~5秒的随机间隔触发眨眼动画，25%概率在首次眨眼后180ms追加一次双眨。
   *   空闲或拖拽状态下不眨眼。
   */
  function setupBlinking() {
    function blink() {
      if (state.isIdle || state.isDragging) return;
      els.leftEye.classList.add('blink');
      els.rightEye.classList.add('blink');
      setTimeout(function () { els.leftEye.classList.remove('blink'); els.rightEye.classList.remove('blink'); }, 110);
    }
    function scheduleBlink() {
      state.blinkTimer = setTimeout(function () {
        blink();
        if (Math.random() < 0.25) setTimeout(blink, 180);
        scheduleBlink();
      }, TIMING.BLINK_MIN + Math.random() * (TIMING.BLINK_MAX - TIMING.BLINK_MIN));
    }
    scheduleBlink();
  }

  /**
   * 设置拖拽移动交互
   * @description 核心交互函数。实现伙伴窗口的拖拽移动，包含以下逻辑：
   *   - mousedown: 记录起始位置，启动800ms长按计时器（未拖动则触发抱抱）
   *   - mousemove: 超过5px阈值后进入拖拽模式，根据移动方向添加倾斜动画，通过API移动窗口
   *   - mouseup: 结束拖拽，播放落地弹跳动画，奖励3XP，检测边缘位置
   *   拖拽期间停止漫游，显示拖拽语音和光环特效。
   */
  function setupDrag() {
    var startX = 0, startY = 0, lastMoveX = 0, lastMoveY = 0;
    var DRAG_THRESHOLD = 5;
    els.companion.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (els.contextMenu.classList.contains('visible')) return;
      if (els.miniPanel.classList.contains('visible') && els.miniPanel.contains(e.target)) return;
      if (els.permissionCard && els.permissionCard.classList.contains('visible') && els.permissionCard.contains(e.target)) return;
      e.preventDefault();
      startX = e.screenX; startY = e.screenY;
      lastMoveX = e.screenX; lastMoveY = e.screenY;
      state.dragStartPos = { x: e.screenX, y: e.screenY };
      state.isDragging = false; state.longPressTriggered = false;
      stopRoaming();
      state.longPressTimer = setTimeout(function () {
        if (!state.isDragging) { state.longPressTriggered = true; triggerHug(); }
      }, TIMING.LONG_PRESS_THRESHOLD);
    });
    state.handleDragMove = function (e) {
      if (!state.dragStartPos) return;
      var dx = e.screenX - state.dragStartPos.x, dy = e.screenY - state.dragStartPos.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (!state.isDragging && dist > DRAG_THRESHOLD) {
        state.isDragging = true; clearTimeout(state.longPressTimer);
        els.companion.classList.add('dragging');
        els.body.classList.add('dragging-body');
        if (els.aura) els.aura.classList.add('active');
        if (!state.dndMode && Math.random() < 0.4) showSpeech(randomFrom(SPEECH.drag), 2000);
      }
      if (state.isDragging) {
        var moveDelta = e.screenX - lastMoveX;
        els.body.classList.remove('drag-tilt-left', 'drag-tilt-right');
        if (moveDelta > 3) els.body.classList.add('drag-tilt-right');
        else if (moveDelta < -3) els.body.classList.add('drag-tilt-left');
        api.moveWindow(e.screenX - startX, e.screenY - startY);
        startX = e.screenX; startY = e.screenY;
        lastMoveX = e.screenX; lastMoveY = e.screenY;
      }
    };
    document.addEventListener('mouseup', function () {
      if (state.dragStartPos) clearTimeout(state.longPressTimer);
      if (state.isDragging) {
        els.companion.classList.remove('dragging');
        els.body.classList.remove('dragging-body', 'drag-tilt-left', 'drag-tilt-right');
        if (els.aura) els.aura.classList.remove('active');
        els.body.classList.add('drop-bounce');
        setTimeout(function () { els.body.classList.remove('drop-bounce'); setMood(state.mood); }, 600);
        if (!state.dndMode && Math.random() < 0.5) showSpeech(randomFrom(SPEECH.drop), 2000);
        spawnBurstParticles(3);
        state.growth.dragCount++;
        addXP(3, '拖动');
        checkEdgePosition();
      }
      state.isDragging = false; state.dragStartPos = null;
    });
  }

  /**
   * 触发抱抱动画
   * @description 长按伙伴时触发，添加拥抱CSS类、显示语音、生成粒子、奖励8XP，1.6秒后恢复。
   */
  function triggerHug() {
    els.body.classList.add('hugging');
    if (!state.dndMode) showSpeech(randomFrom(SPEECH.hug), 3000);
    els.mouth.className = 'mouth happy';
    spawnBurstParticles(5);
    addXP(8, '抱抱');
    setTimeout(function () { els.body.classList.remove('hugging'); }, 1600);
  }

  /**
   * 生成点击涟漪效果
   * @param {number} x - 涟漪中心X坐标（相对于伙伴元素）
   * @param {number} y - 涟漪中心Y坐标（相对于伙伴元素）
   */
  function spawnRipple(x, y) {
    var r = document.createElement('div');
    r.className = 'ripple'; r.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    els.companion.appendChild(r);
    setTimeout(function () { r.remove(); }, 600);
  }

  /**
   * 生成爆发粒子效果
   * @description 在伙伴身体中心位置生成指定数量的粒子，按圆形均匀分布，
   *   颜色根据当前皮肤主题选取，0.7秒后自动移除。
   * @param {number} count - 粒子数量
   */
  function spawnBurstParticles(count) {
    var n = count || TIMING.BURST_PARTICLE_DEFAULT;
    var colors = SKIN_COLORS[state.currentSkin] || SKIN_COLORS.robot;
    for (var i = 0; i < n; i++) {
      (function (idx) {
        var p = document.createElement('div');
        p.className = 'burst-particle';
        var angle = (Math.PI * 2 / count) * idx + Math.random() * 0.5;
        var dist = 30 + Math.random() * 25;
        p.style.setProperty('--tx', (Math.cos(angle) * dist) + 'px');
        p.style.setProperty('--ty', (Math.sin(angle) * dist) + 'px');
        p.style.background = colors[Math.floor(Math.random() * colors.length)];
        var rect = els.body.getBoundingClientRect(), cRect = els.companion.getBoundingClientRect();
        p.style.transform = 'translate(' + (rect.left - cRect.left + rect.width / 2) + 'px,' + (rect.top - cRect.top + rect.height / 2) + 'px)';
        els.companion.appendChild(p);
        setTimeout(function () { p.remove(); }, 700);
      })(i);
    }
  }

  /**
   * 生成五彩纸屑效果
   * @description 在特效层中生成指定数量的彩色纸屑元素，随机颜色、位置和动画参数，3秒后移除。
   * @param {number} count - 纸屑数量
   */
  function spawnConfetti(count) {
    var n = count || TIMING.CONFETTI_COUNT;
    var confettiColors = ['#f87171', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#a78bfa', '#f472b6'];
    for (var i = 0; i < n; i++) {
      (function () {
        var c = document.createElement('div');
        c.className = 'fx fx-confetti';
        c.style.transform = 'translate(' + (20 + Math.random() * 140) + 'px,' + (10 + Math.random() * 30) + 'px)';
        c.style.background = confettiColors[Math.floor(Math.random() * confettiColors.length)];
        c.style.setProperty('--cx', (Math.random() * 80 - 40) + 'px');
        c.style.animationDuration = (1.5 + Math.random() * 1.5) + 's';
        c.style.animationDelay = (Math.random() * 0.5) + 's';
        c.style.width = (4 + Math.random() * 4) + 'px';
        c.style.height = (3 + Math.random() * 3) + 'px';
        els.fxLayer.appendChild(c);
        setTimeout(function () { c.remove(); }, 3000);
      })();
    }
  }

  /**
   * 生成气泡效果
   * @description 在特效层中生成指定数量的上升气泡元素，随机大小和动画参数，4秒后移除。
   * @param {number} count - 气泡数量
   */
  function spawnBubbles(count) {
    for (var i = 0; i < count; i++) {
      (function () {
        var b = document.createElement('div');
        b.className = 'fx fx-bubble';
        b.style.transform = 'translateX(' + (30 + Math.random() * 120) + 'px)';
        b.style.bottom = (10 + Math.random() * 20) + 'px';
        var size = 4 + Math.random() * 8;
        b.style.width = size + 'px'; b.style.height = size + 'px';
        b.style.animationDuration = (2 + Math.random() * 2) + 's';
        b.style.animationDelay = (Math.random() * 1) + 's';
        els.fxLayer.appendChild(b);
        setTimeout(function () { b.remove(); }, 4000);
      })();
    }
  }

  /**
   * 生成指定类型的特效元素
   * @param {string} type - 特效类型（rainbow/music/sparkle/hearts等）
   */
  function spawnFx(type) {
    var el = document.createElement('div');
    el.className = 'fx fx-' + type;
    els.fxLayer.appendChild(el);
    var dur = type === 'rainbow' ? 3000 : type === 'music' ? 3000 : type === 'sparkle' ? 1500 : 2000;
    setTimeout(function () { el.remove(); }, dur);
  }

  /**
   * 清除所有特效和动画状态
   * @description 清空特效层DOM、清除特效和动作定时器、移除所有动画CSS类和特殊眼睛表情。
   */
  var EYE_EXPR_CLASSES = ['heart-eye', 'dizzy-eye', 'spiral-eye', 'star-eye', 'squint-eye', 'wide-eye'];
  var FX_BODY_CLASSES = ['fx-dance', 'fx-sing', 'fx-hearteyes', 'fx-rainbow', 'fx-magic', 'fx-jump', 'fx-shake', 'fx-bow', 'fx-celebrate', 'fx-tremble', 'idle-sweep', 'idle-juggle', 'idle-carry', 'idle-yawn', 'idle-stretch', 'idle-lookAround', 'idle-breathe', 'idle-think', 'idle-nod', 'idle-peek', 'ai-thinking', 'ai-typing', 'ai-building', 'ai-conducting', 'ai-happy', 'ai-reviewing', 'ai-architecting', 'ai-validating', 'ai-designing', 'ai-integrating', 'ai-selfhealing', 'ai-adapting', 'ai-memorizing', 'ai-skilling', 'ai-connecting', 'ai-delegating', 'ai-automating', 'ai-specifying', 'ai-syncing', 'ai-questioning', 'ai-planning', 'ai-error', 'ai-notification', 'waving', 'look-around-click', 'excited', 'wake-up-startle'];
  var MOOD_CLASSES = ['mood-happy', 'mood-calm', 'mood-energetic'];
  var SKIN_CLASSES = ['skin-robot', 'skin-cat', 'skin-ghost', 'skin-dragon'];
  var TIME_CLASSES = ['time-morning', 'time-afternoon', 'time-evening', 'time-night'];
  var SLEEP_CLASSES = ['sleeping', 'sleep-dozing', 'sleep-collapsed', 'sleep-deep'];

  function addFxClass(cls) {
    els.body.classList.add(cls);
    if (state.activeFxClasses.indexOf(cls) < 0) state.activeFxClasses.push(cls);
  }

  function removeFxClass(cls) {
    els.body.classList.remove(cls);
    var idx = state.activeFxClasses.indexOf(cls);
    if (idx >= 0) state.activeFxClasses.splice(idx, 1);
  }

  function clearFx() {
    els.fxLayer.textContent = '';
    clearTimeout(state.fxTimeout);
    clearTimeout(state.actionTimeout);
    state.activeFxClasses.forEach(function (cls) { els.body.classList.remove(cls); });
    state.activeFxClasses.length = 0;
    EYE_EXPR_CLASSES.forEach(function (cls) { if (els.leftEye) els.leftEye.classList.remove(cls); if (els.rightEye) els.rightEye.classList.remove(cls); });
    if (els.sweatDrop) els.sweatDrop.classList.remove('visible');
    if (els.exclaim) els.exclaim.classList.remove('visible');
    els.companion.querySelectorAll('.burst-particle, .ripple').forEach(function (el) { el.remove(); });
  }

  /**
   * 设置悬停效果
   * @description 头部悬停600ms后触发摸头语音和2XP奖励；核心灯悬停触发脉冲发光效果。
   */
  function setupHoverEffects() {
    var headHoverTimer = null;
    if (els.head) {
      els.head.addEventListener('mouseenter', function () {
        headHoverTimer = setTimeout(function () {
          if (!state.isDragging && !state.isIdle && !state.dndMode) { showSpeech(randomFrom(SPEECH.headPat), 2000); addXP(TIMING.PET_XP, '摸头'); }
        }, TIMING.HEAD_HOVER_DELAY);
        if (els.antennaArea && state.currentSkin === 'cat') els.antennaArea.classList.add('cat-ear-active');
      });
      els.head.addEventListener('mouseleave', function () {
        clearTimeout(headHoverTimer);
        if (els.antennaArea) els.antennaArea.classList.remove('cat-ear-active');
      });
    }
    els.coreLight.addEventListener('mouseenter', function () {
      if (!state.isDragging) { els.coreLight.classList.add('core-hover'); setTimeout(function () { els.coreLight.classList.remove('core-hover'); }, TIMING.CORE_HOVER_PULSE); }
    });
    els.body.addEventListener('mouseenter', function () {
      if (els.ambientRing) els.ambientRing.classList.add('active');
    });
    els.body.addEventListener('mouseleave', function () {
      if (els.ambientRing) els.ambientRing.classList.remove('active');
    });
  }

  /**
   * 设置右键上下文菜单
   * @description 监听伙伴元素的右键事件，在点击位置显示自定义上下文菜单，
   *   点击菜单项时执行对应操作，点击其他区域关闭菜单。
   */
  function setupContextMenu() {
    els.companion.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var menu = els.contextMenu;
      menu.style.left = '0px'; menu.style.top = '0px';
      menu.classList.add('visible');
      var mRect = menu.getBoundingClientRect();
      var x = Math.min(e.clientX, window.innerWidth - mRect.width - 4);
      var y = Math.min(e.clientY, window.innerHeight - mRect.height - 4);
      x = Math.max(0, x); y = Math.max(0, y);
      menu.style.left = x + 'px'; menu.style.top = y + 'px';
    });
    document.addEventListener('click', function (e) {
      if (!els.contextMenu.contains(e.target)) els.contextMenu.classList.remove('visible');
    });
    var items = els.contextMenu.querySelectorAll('.menu-item[data-action]');
    items.forEach(function (item) {
      item.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      item.addEventListener('mouseup', function (e) { e.stopPropagation(); });
      item.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        handleMenuAction(item.getAttribute('data-action'));
        els.contextMenu.classList.remove('visible');
      });
    });
  }

  /**
   * 处理上下文菜单动作
   * @description 根据菜单项的 data-action 属性分发到对应的功能处理逻辑，
   *   涵盖控制台、面板、角色、技能、皮肤、心情、AI状态、特效动画、漫游、模式切换等全部操作。
   * @param {string} action - 动作标识符
   */
  function handleMenuAction(action) {
    switch (action) {
      case 'dashboard': api.openDashboard(); addXP(2, '打开控制台'); break;
      case 'panel': togglePanel(); break;
      case 'agents': fetchAndShowAgents(); addXP(3, '查看角色'); break;
      case 'skills': fetchAndShowSkills(); addXP(3, '查看技能'); break;
      case 'skin-robot': switchSkin('robot'); break;
      case 'skin-cat': switchSkin('cat'); break;
      case 'skin-ghost': switchSkin('ghost'); break;
      case 'skin-dragon': switchSkin('dragon'); break;
      case 'mood-happy': setMood('happy'); showSpeech(randomFrom(SPEECH.moodHappy)); addXP(1, '切换心情'); break;
      case 'mood-calm': setMood('calm'); showSpeech(randomFrom(SPEECH.moodCalm)); addXP(1, '切换心情'); break;
      case 'mood-energetic': setMood('energetic'); showSpeech(randomFrom(SPEECH.moodEnergetic)); addXP(1, '切换心情'); break;
      case 'ai-thinking': setAIState('thinking'); break;
      case 'ai-typing': setAIState('typing'); break;
      case 'ai-building': setAIState('building'); break;
      case 'ai-juggling': setAIState('juggling'); spawnJuggleBalls(); break;
      case 'ai-conducting': setAIState('conducting'); spawnJuggleBalls(); break;
      case 'ai-optimizing': setAIState('optimizing'); break;
      case 'ai-converged': setAIState('converged'); spawnConfetti(8); playSound('levelup'); break;
      case 'ai-reviewing': activateVibeCapability('reviewing'); break;
      case 'ai-architecting': activateVibeCapability('architecting'); break;
      case 'ai-validating': activateVibeCapability('validating'); break;
      case 'ai-designing': activateVibeCapability('designing'); break;
      case 'ai-integrating': activateSuperAgent('integrating'); break;
      case 'ai-selfhealing': activateSuperAgent('selfhealing'); break;
      case 'ai-adapting': activateSuperAgent('adapting'); break;
      case 'ai-memorizing': activateExtension('memorizing'); break;
      case 'ai-skilling': activateExtension('skilling'); break;
      case 'ai-connecting': activateExtension('connecting'); break;
      case 'ai-delegating': activateExtension('delegating'); break;
      case 'ai-automating': activateExtension('automating'); break;
      case 'ai-specifying': activateSDD('specifying'); break;
      case 'ai-syncing': activateSDD('syncing'); break;
      case 'ai-questioning': activateSDD('questioning'); break;
      case 'ai-planning': activateSDD('planning'); break;
      case 'ai-retrieving': activateThoughtDiamond('retrieving'); break;
      case 'ai-distilling': activateThoughtDiamond('distilling'); break;
      case 'ai-deduplicating': activateThoughtDiamond('deduplicating'); break;
      case 'ai-updating': activateThoughtDiamond('updating'); break;
      case 'ai-error': setAIState('error'); break;
      case 'ai-idle': setAIState('idle'); setMood(state.mood); break;
      case 'spin': triggerSpin(); addXP(5, '转圈圈'); break;
      case 'dance': triggerDance(); break;
      case 'magic': triggerMagic(); addXP(8, '变魔术'); break;
      case 'sing': triggerSing(); addXP(6, '唱歌'); break;
      case 'rainbow': triggerRainbow(); addXP(5, '彩虹'); break;
      case 'hearteyes': triggerHeartEyes(); addXP(4, '星星眼'); break;
      case 'eye-heart': setEyeExpression('heart-eye'); addXP(2, '爱心眼'); break;
      case 'eye-dizzy': setEyeExpression('dizzy-eye'); addXP(2, '眩晕眼'); break;
      case 'eye-spiral': setEyeExpression('spiral-eye'); addXP(2, '螺旋眼'); break;
      case 'eye-normal': setEyeExpression(''); addXP(1, '恢复眼睛'); break;
      case 'jump': triggerJump(); addXP(4, '跳跃'); break;
      case 'shake': triggerShake(); addXP(3, '摇晃'); break;
      case 'bow': triggerBow(); addXP(3, '鞠躬'); break;
      case 'celebrate': triggerCelebrate(); addXP(6, '庆祝'); break;
      case 'tremble': triggerTremble(); addXP(2, '发抖'); break;
      case 'roam': toggleRoaming(); break;
      case 'minimal': toggleMinimalMode(); break;
      case 'dnd': toggleDND(); break;
      case 'clickthrough': toggleClickThrough(); break;
      case 'edge-auto': toggleEdgeAutoMinimal(); break;
      case 'test-perm': showPermissionCard('Task Worker', '请求写入文件 src/app.js'); break;
      case 'reset-pos': api.resetPosition(); showSpeech('回到原位！'); break;
      case 'hide': api.toggleWindow(); break;
      case 'quit': api.quitApp(); break;
    }
  }

  /**
   * 切换点击穿透模式
   * @description 开启时非伙伴区域的鼠标事件穿透到下层窗口，关闭时恢复正常点击。
   */
  function toggleClickThrough() {
    state.clickThroughEnabled = !state.clickThroughEnabled;
    els.companion.classList.toggle('clickthrough', state.clickThroughEnabled);
    if (!state.clickThroughEnabled) api.setIgnoreMouseEvents(false);
    showSpeech(state.clickThroughEnabled ? '点击穿透已开启' : '点击穿透已关闭');
    showToast(state.clickThroughEnabled ? '透明区域点击将穿透到下层窗口' : '点击穿透已关闭', 'info');
    saveSettings();
  }

  /**
   * 切换贴边自动迷你模式
   * @description 开启后拖动伙伴到屏幕边缘时自动缩小为迷你模式。
   */
  function toggleEdgeAutoMinimal() {
    state.edgeAutoMinimal = !state.edgeAutoMinimal;
    showSpeech(state.edgeAutoMinimal ? '贴边自动隐藏已开启' : '贴边自动隐藏已关闭');
    showToast(state.edgeAutoMinimal ? '拖到屏幕边缘自动缩小' : '贴边隐藏已关闭', 'info');
    saveSettings();
  }

  /**
   * 切换迷你模式
   * @description 迷你模式下伙伴缩小为精简形态，减少屏幕占用。
   */
  function toggleMinimalMode() {
    state.minimalMode = !state.minimalMode;
    els.companion.classList.toggle('minimal', state.minimalMode);
    showSpeech(state.minimalMode ? randomFrom(SPEECH.minimalOn) : randomFrom(SPEECH.minimalOff));
    saveSettings();
  }

  /**
   * 切换免打扰模式
   * @description 免打扰模式下抑制语音气泡和非错误Toast提示。
   */
  function toggleDND() {
    state.dndMode = !state.dndMode;
    els.companion.classList.toggle('dnd', state.dndMode);
    showSpeech(state.dndMode ? randomFrom(SPEECH.dndOn) : randomFrom(SPEECH.dndOff));
    showToast(state.dndMode ? '免打扰模式已开启' : '免打扰模式已关闭', 'info');
    saveSettings();
  }

  /**
   * 切换伙伴皮肤
   * @description 核心外观切换函数。切换皮肤时：更新状态中的当前皮肤ID、记录已使用皮肤、
   *   移除旧皮肤CSS类并添加新皮肤类、保留当前心情/迷你/免打扰/穿透模式状态、
   *   播放换装过渡动画、更新品牌徽标、重新创建粒子、生成爆发粒子、显示语音、奖励10XP。
   *   若目标皮肤与当前相同则仅提示不切换。
   * @param {string} skinId - 目标皮肤ID（robot/cat/ghost/dragon）
   */
  function switchSkin(skinId) {
    if (!SKINS[skinId]) return;
    if (state.currentSkin === skinId) { showSpeech('已经是' + SKINS[skinId].name + '啦~'); return; }
    state.currentSkin = skinId;
    if (state.growth.skinsUsed.indexOf(skinId) < 0) state.growth.skinsUsed.push(skinId);
    clearFx();
    clearAIState();
    var skinClasses = SKIN_CLASSES;
    skinClasses.forEach(function (cls) { els.companion.classList.remove(cls); });
    els.companion.classList.add('skin-' + skinId);
    els.companion.classList.add('mood-' + state.mood);
    if (state.minimalMode) els.companion.classList.add('minimal');
    if (state.dndMode) els.companion.classList.add('dnd');
    if (state.clickThroughEnabled) els.companion.classList.add('clickthrough');
    els.body.classList.add('skin-transition');
    clearTimeout(state.skinTransitionTimer);
    state.skinTransitionTimer = setTimeout(function () { els.body.classList.remove('skin-transition'); state.skinTransitionTimer = null; }, 500);
    if (els.brandBadge) els.brandBadge.textContent = SKINS[skinId].badge;
    createParticles(); spawnBurstParticles(6);
    showSpeech(randomFrom(SPEECH.skinChange) + ' — ' + SKINS[skinId].name, 3000);
    addXP(10, '切换形象');
    saveSettings();
  }

  /**
   * 触发旋转动画
   * @description 伙伴身体360度旋转，防重复触发，1秒后恢复。
   */
  function triggerSpin() {
    if (state.isSpinning) return;
    state.isSpinning = true;
    els.body.classList.add('spinning');
    showSpeech(randomFrom(SPEECH.spin), 2000);
    spawnBurstParticles(6);
    setTimeout(function () { els.body.classList.remove('spinning'); state.isSpinning = false; setMood(state.mood); }, TIMING.SPIN_DURATION);
  }

  /**
   * 触发跳舞动画
   * @description 清除当前特效和AI状态，播放3秒跳舞动画，附带闪光和粒子效果，奖励8XP。
   */
  function triggerDance() {
    clearFx(); clearAIState();
    addFxClass('fx-dance');
    showSpeech(randomFrom(SPEECH.dance), 3000);
    spawnFx('sparkle'); spawnBurstParticles(8);
    state.growth.danceCount++;
    addXP(8, '跳舞');
    state.fxTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 3000);
  }

  /**
   * 触发魔术动画
   * @description 播放2.5秒魔术动画，分三波生成闪光特效和粒子，奖励8XP。
   */
  function triggerMagic() {
    clearFx(); clearAIState();
    addFxClass('fx-magic');
    showSpeech(randomFrom(SPEECH.magic), 2500);
    for (var i = 0; i < 3; i++) setTimeout(function () { spawnFx('sparkle'); }, i * 400);
    spawnBurstParticles(10);
    state.fxTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 2500);
  }

  /**
   * 触发唱歌动画
   * @description 播放3秒唱歌动画，附带音符特效和气泡效果，奖励6XP。
   */
  function triggerSing() {
    clearFx(); clearAIState();
    addFxClass('fx-sing');
    showSpeech(randomFrom(SPEECH.sing), 3000);
    spawnFx('music'); spawnBubbles(5);
    state.fxTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 3000);
  }

  /**
   * 触发彩虹动画
   * @description 播放3秒彩虹特效动画。
   */
  function triggerRainbow() {
    clearFx(); clearAIState();
    addFxClass('fx-rainbow');
    showSpeech(randomFrom(SPEECH.rainbow), 3000);
    spawnFx('rainbow');
    state.fxTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 3000);
  }

  /**
   * 触发星星眼动画
   * @description 播放2.5秒星星眼动画，双眼添加star-eye类，附带爱心特效和粒子。
   */
  function triggerHeartEyes() {
    clearFx(); clearAIState();
    addFxClass('fx-hearteyes');
    els.leftEye.classList.add('star-eye');
    els.rightEye.classList.add('star-eye');
    showSpeech(randomFrom(SPEECH.hearteyes), 2500);
    spawnFx('hearts'); spawnBurstParticles(4);
    state.fxTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 2500);
  }

  /**
   * 触发跳跃动画
   * @description 播放1.2秒跳跃动画，附带粒子效果。
   */
  function triggerJump() {
    clearFx(); clearAIState();
    addFxClass('fx-jump');
    showSpeech(randomFrom(SPEECH.jump), 2000);
    spawnBurstParticles(4);
    state.actionTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 1200);
  }

  /**
   * 触发摇晃动画
   * @description 播放1.5秒摇晃动画，双眼睁大（wide-eye）。
   */
  function triggerShake() {
    clearFx(); clearAIState();
    addFxClass('fx-shake');
    els.leftEye.classList.add('wide-eye');
    els.rightEye.classList.add('wide-eye');
    showSpeech(randomFrom(SPEECH.shake), 2000);
    state.actionTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 1500);
  }

  /**
   * 触发鞠躬动画
   * @description 播放2秒鞠躬动画，双眼眯起（squint-eye）。
   */
  function triggerBow() {
    clearFx(); clearAIState();
    addFxClass('fx-bow');
    els.leftEye.classList.add('squint-eye');
    els.rightEye.classList.add('squint-eye');
    showSpeech(randomFrom(SPEECH.bow), 2500);
    state.actionTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 2000);
  }

  /**
   * 触发庆祝动画
   * @description 播放3秒庆祝动画，生成五彩纸屑和粒子爆发效果。
   */
  function triggerCelebrate() {
    clearFx(); clearAIState();
    addFxClass('fx-celebrate');
    showSpeech(randomFrom(SPEECH.celebrate), 3000);
    spawnConfetti(15); spawnBurstParticles(8);
    state.actionTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 3000);
  }

  /**
   * 触发发抖动画
   * @description 播放2.5秒发抖动画，显示汗滴特效。
   */
  function triggerTremble() {
    clearFx(); clearAIState();
    addFxClass('fx-tremble');
    if (els.sweatDrop) els.sweatDrop.classList.add('visible');
    showSpeech(randomFrom(SPEECH.tremble), 2500);
    state.actionTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 2500);
  }

  /**
   * 切换漫游状态
   * @description 在开始漫游和停止漫游之间切换。
   */
  function toggleRoaming() { if (state.isRoaming) stopRoaming(); else startRoaming(); }

  /**
   * 开始自由漫游
   * @description 设置漫游状态、随机方向、显示语音、奖励5XP、保存设置，并启动步进调度。
   */
  function startRoaming() {
    stopRoaming();
    state.isRoaming = true;
    state.growth.roamCount++;
    state.roamDirection = Math.random() < 0.5 ? 1 : -1;
    showSpeech(randomFrom(SPEECH.roamStart));
    addXP(5, '开始漫游');
    saveSettings();
    scheduleRoamStep();
  }

  /**
   * 停止自由漫游
   * @description 清除漫游状态和步进定时器，移除行走动画和朝向类，显示语音并保存设置。
   */
  function stopRoaming() {
    state.isRoaming = false;
    clearTimeout(state.roamStepTimer);
    if (state.roamWalkInterval) { clearInterval(state.roamWalkInterval); state.roamWalkInterval = null; }
    els.body.classList.remove('walking');
    els.companion.classList.remove('facing-left', 'facing-right');
    showSpeech(randomFrom(SPEECH.roamStop));
    saveSettings();
  }

  /**
   * 调度漫游步进
   * @description 漫游的核心调度循环：随机暂停3~8秒后开始行走，行走8~20步，
   *   每步移动3px，30%概率随机变向。行走结束后递归调度下一步。
   */
  function scheduleRoamStep() {
    if (!state.isRoaming) return;
    if (state.roamStepTimer) clearTimeout(state.roamStepTimer);
    if (state.roamWalkInterval) clearInterval(state.roamWalkInterval);
    var pauseDuration = TIMING.ROAM_PAUSE_MIN + Math.random() * TIMING.ROAM_PAUSE_RANGE;
    state.roamStepTimer = setTimeout(function () {
      if (!state.isRoaming) return;
      els.body.classList.add('walking');
      els.companion.classList.remove('facing-left', 'facing-right');
      if (state.roamDirection > 0) els.companion.classList.add('facing-right');
      else els.companion.classList.add('facing-left');
      var steps = 8 + Math.floor(Math.random() * 12);
      var stepCount = 0;
      state.roamWalkInterval = setInterval(function () {
        if (!state.isRoaming || stepCount >= steps) {
          clearInterval(state.roamWalkInterval);
          state.roamWalkInterval = null;
          els.body.classList.remove('walking');
          els.companion.classList.remove('facing-left', 'facing-right');
          if (state.isRoaming) scheduleRoamStep();
          return;
        }
        api.moveWindow(state.roamDirection * 3, 0);
        stepCount++;
      }, 60);
      if (Math.random() < 0.3) {
        state.roamDirection = -state.roamDirection;
        els.companion.classList.remove('facing-left', 'facing-right');
        if (state.roamDirection > 0) els.companion.classList.add('facing-right');
        else els.companion.classList.add('facing-left');
      }
    }, pauseDuration);
  }

  /**
   * 设置点击交互
   * @description 核心交互函数。处理伙伴身体的单击和双击事件：
   *   - 单击：累计点击计数，1次点击显示皮肤专属语音+2XP，2次显示抚摸语音+3XP，
   *     4次以上触发东张西望动画+6XP并重置计数。1.5秒无点击自动重置。
   *   - 双击：打开仪表盘+5XP。
   *   每次点击生成涟漪效果和音效，并重置空闲计时器。
   */
  function setupClickInteraction() {
    els.body.addEventListener('click', function (e) {
      if (e.button !== 0 || state.isDragging || state.longPressTriggered) return;
      state.petCount++;
      state.growth.petCount++;
      clearTimeout(state.petTimer);
      state.petTimer = setTimeout(function () { state.petCount = 0; }, TIMING.PET_WINDOW);
      triggerExcited();
      spawnRipple(e.offsetX, e.offsetY);
      playSound('click');

      if (state.petCount >= 4) {
        addFxClass('look-around-click');
        showSpeech(randomFrom(SPEECH.lookAround), 2500);
        spawnBurstParticles(4);
        addXP(6, '东张西望');
        state.petCount = 0;
        setTimeout(function () { removeFxClass('look-around-click'); }, 1500);
      } else if (state.petCount >= 2) {
        showSpeech(randomFrom(SPEECH.pet), 2000);
        addXP(3, '摸摸');
      } else {
        var skinSpeech = SKINS[state.currentSkin] && SKINS[state.currentSkin].speech;
        showSpeech(skinSpeech ? randomFrom(skinSpeech.click) : randomFrom(SPEECH.click));
        addXP(2, '点击');
      }
      resetIdle();
    });
    els.body.addEventListener('dblclick', function (e) {
      e.preventDefault();
      if (state.isDragging) return;
      state.petCount = 0;
      clearTimeout(state.petTimer);
      showSpeech(randomFrom(SPEECH.doubleClick), 2000);
      api.openDashboard();
      addXP(5, '双击打开');
    });
  }

  /**
   * 触发兴奋弹跳动画
   * @description 通过移除再添加CSS类强制重启动画，0.5秒后恢复。
   */
  function triggerExcited() {
    removeFxClass('excited');
    void els.body.offsetWidth;
    addFxClass('excited');
    if (state.excitedTimer) clearTimeout(state.excitedTimer);
    state.excitedTimer = setTimeout(function () { removeFxClass('excited'); state.excitedTimer = null; }, TIMING.EXCITED_DURATION);
  }

  /**
   * 设置眼睛表情
   * @description 清除所有眼睛表情类后应用指定表情，支持 heart-eye/dizzy-eye/spiral-eye 等。
   * @param {string} expr - 表情CSS类名，空字符串则恢复正常
   */
  function setEyeExpression(expr) {
    EYE_EXPR_CLASSES.forEach(function (cls) { if (els.leftEye) els.leftEye.classList.remove(cls); if (els.rightEye) els.rightEye.classList.remove(cls); });
    if (expr && EYE_EXPR_CLASSES.indexOf(expr) >= 0) {
      els.leftEye.classList.add(expr);
      els.rightEye.classList.add(expr);
      showSpeech('眼睛变了~', 2000);
      spawnBurstParticles(3);
    }
  }

  /**
   * 设置迷你面板关闭按钮事件
   */
  function setupMiniPanel() {
    els.panelCards = { vibe: {}, sa: {}, ext: {}, sdd: {}, td: {} };
    Object.keys(VIBE_CAPABILITIES).forEach(function (key) {
      var id = 'vibe' + key.charAt(0).toUpperCase() + key.slice(1);
      var el = document.getElementById(id);
      if (el) els.panelCards.vibe[key] = el;
    });
    Object.keys(SUPERAGENT_CAPABILITIES).forEach(function (key) {
      var id = 'sa' + key.charAt(0).toUpperCase() + key.slice(1);
      var el = document.getElementById(id);
      if (el) els.panelCards.sa[key] = el;
    });
    Object.keys(EXTENSION_LAYERS).forEach(function (key) {
      var id = 'ext' + key.charAt(0).toUpperCase() + key.slice(1);
      var el = document.getElementById(id);
      if (el) els.panelCards.ext[key] = el;
    });
    Object.keys(SDD_PRACTICES).forEach(function (key) {
      var id = 'sdd' + key.charAt(0).toUpperCase() + key.slice(1);
      var el = document.getElementById(id);
      if (el) els.panelCards.sdd[key] = el;
    });
    Object.keys(THOUGHT_DIAMOND).forEach(function (key) {
      var id = 'td' + key.charAt(0).toUpperCase() + key.slice(1);
      var el = document.getElementById(id);
      if (el) els.panelCards.td[key] = el;
    });
    if (els.miniPanel) {
      els.panelCards.vibeCards = els.miniPanel.querySelectorAll('.vibe-card');
      els.panelCards.saCards = els.miniPanel.querySelectorAll('.sa-card');
      els.panelCards.extCards = els.miniPanel.querySelectorAll('.ext-card');
      els.panelCards.sddCards = els.miniPanel.querySelectorAll('.sdd-card');
      els.panelCards.tdCards = els.miniPanel.querySelectorAll('.td-card');
    }
    if (els.panelClose) els.panelClose.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    var vibeCards = els.panelCards.vibeCards || [];
    vibeCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-vibe');
        if (key && VIBE_CAPABILITIES[key]) activateVibeCapability(key);
      });
    });
    var saCards = els.panelCards.saCards || [];
    saCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-sa');
        if (key && SUPERAGENT_CAPABILITIES[key]) activateSuperAgent(key);
      });
    });
    var extCards = els.panelCards.extCards || [];
    extCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-ext');
        if (key && EXTENSION_LAYERS[key]) activateExtension(key);
      });
    });
    var sddCards = els.panelCards.sddCards || [];
    sddCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-sdd');
        if (key && SDD_PRACTICES[key]) activateSDD(key);
      });
    });
    var tdCards = els.panelCards.tdCards || [];
    tdCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-td');
        if (key && THOUGHT_DIAMOND[key]) activateThoughtDiamond(key);
      });
    });
  }
  /**
   * 切换面板显示状态
   */
  function togglePanel() { if (state.panelOpen) closePanel(); else openPanel(); triggerExcited(); }
  /**
   * 打开面板并刷新数据
   */
  function openPanel() {
    state.panelOpen = true;
    els.miniPanel.classList.add('visible');
    var sections = els.miniPanel.querySelectorAll('.panel-section');
    sections.forEach(function (s) { s.classList.remove('stagger-reveal'); void s.offsetWidth; s.classList.add('stagger-reveal'); });
    refreshPanelData();
    updateGrowthUI();
    renderEventLog();
    showSpeech('状态面板已打开', 2000);
  }
  /**
   * 关闭面板
   */
  function closePanel() { state.panelOpen = false; els.miniPanel.classList.remove('visible'); }

  /**
   * 刷新面板数据
   * @description 通过API获取Agent列表和健康状态数据更新面板信息，
   *   API不可用时回退到演示数据。
   */
  function refreshPanelData() {
    api.proxyAPI(API_ENDPOINTS.agents).then(function (res) {
      if (res && res.ok && res.data) {
        var agents = res.data.agents || res.data;
        if (Array.isArray(agents)) {
          var active = agents.filter(function (a) {
            if (!a || typeof a !== 'object') return false;
            var st = a.status || a.state || '';
            return st === 'active' || st === 'running' || a.running === true;
          });
          if (els.infoActiveAgent) els.infoActiveAgent.textContent = active.length > 0 ? active.map(function (a) { return a.name || a.role || a.id; }).join(', ') : '无活跃角色';
          return;
        }
      }
      if (els.infoActiveAgent) els.infoActiveAgent.textContent = DEMO_AGENTS.filter(function (a) { return a.status === 'active'; }).map(function (a) { return a.role; }).join(', ') || '无活跃角色';
    }).catch(function () {
      if (els.infoActiveAgent) els.infoActiveAgent.textContent = DEMO_AGENTS.filter(function (a) { return a.status === 'active'; }).map(function (a) { return a.role; }).join(', ') || '无活跃角色';
    });
    api.proxyAPI(API_ENDPOINTS.health).then(function (res) {
      if (res && res.ok && res.data) {
        var d = res.data;
        if (els.infoPhase) els.infoPhase.textContent = d.phase || d.currentPhase || '待命';
        if (els.infoTokens) els.infoTokens.textContent = d.tokenUsage !== undefined ? formatTokens(d.tokenUsage) : (d.tokens || '-');
        return;
      }
      if (els.infoPhase) els.infoPhase.textContent = DEMO_HEALTH.phase;
      if (els.infoTokens) els.infoTokens.textContent = formatTokens(DEMO_HEALTH.tokenUsage);
    }).catch(function () {
      if (els.infoPhase) els.infoPhase.textContent = DEMO_HEALTH.phase;
      if (els.infoTokens) els.infoTokens.textContent = formatTokens(DEMO_HEALTH.tokenUsage);
    });
    var vibeKeys = Object.keys(VIBE_CAPABILITIES);
    vibeKeys.forEach(function (key) {
      var el = els.panelCards.vibe[key];
      if (el) el.textContent = state.aiState === key ? '●' : '-';
    });
    var vibeCards = els.panelCards.vibeCards;
    if (vibeCards) vibeCards.forEach(function (c) { c.classList.remove('active'); });
    if (VIBE_CAPABILITIES[state.aiState] && vibeCards) {
      vibeCards.forEach(function (c) { if (c.getAttribute('data-vibe') === state.aiState) c.classList.add('active'); });
    }
    var saKeys = Object.keys(SUPERAGENT_CAPABILITIES);
    saKeys.forEach(function (key) {
      var el = els.panelCards.sa[key];
      if (el) el.textContent = state.aiState === key ? '●' : '-';
    });
    var saCards = els.panelCards.saCards;
    if (saCards) saCards.forEach(function (c) { c.classList.remove('active'); });
    if (SUPERAGENT_CAPABILITIES[state.aiState] && saCards) {
      saCards.forEach(function (c) { if (c.getAttribute('data-sa') === state.aiState) c.classList.add('active'); });
    }
    var extKeys = Object.keys(EXTENSION_LAYERS);
    extKeys.forEach(function (key) {
      var el = els.panelCards.ext[key];
      if (el) el.textContent = state.aiState === key ? '●' : '-';
    });
    var extCards = els.panelCards.extCards;
    if (extCards) extCards.forEach(function (c) { c.classList.remove('active'); });
    if (EXTENSION_LAYERS[state.aiState] && extCards) {
      extCards.forEach(function (c) { if (c.getAttribute('data-ext') === state.aiState) c.classList.add('active'); });
    }
    var sddKeys = Object.keys(SDD_PRACTICES);
    sddKeys.forEach(function (key) {
      var el = els.panelCards.sdd[key];
      if (el) el.textContent = state.aiState === key ? '●' : '-';
    });
    var sddCards = els.panelCards.sddCards;
    if (sddCards) sddCards.forEach(function (c) { c.classList.remove('active'); });
    if (SDD_PRACTICES[state.aiState] && sddCards) {
      sddCards.forEach(function (c) { if (c.getAttribute('data-sdd') === state.aiState) c.classList.add('active'); });
    }
    var tdKeys = Object.keys(THOUGHT_DIAMOND);
    tdKeys.forEach(function (key) {
      var el = els.panelCards.td[key];
      if (el) el.textContent = state.aiState === key ? '●' : '-';
    });
    var tdCards = els.panelCards.tdCards;
    if (tdCards) tdCards.forEach(function (c) { c.classList.remove('active'); });
    if (THOUGHT_DIAMOND[state.aiState] && tdCards) {
      tdCards.forEach(function (c) { if (c.getAttribute('data-td') === state.aiState) c.classList.add('active'); });
    }
  }

  /**
   * 格式化Token数量为可读字符串
   * @param {number} n - Token数量
   * @returns {string} 格式化后的字符串（如 "1.2M"、"125.0K"、"999"）
   */
  function formatTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  /**
   * 设置命令按钮事件
   * @description 为所有 .cmd-btn 元素绑定点击事件，发送斜杠命令到主进程，奖励4XP。
   */
  function setupCommandButtons() {
    document.querySelectorAll('.cmd-btn').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var cmd = btn.getAttribute('data-cmd');
        showSpeech('发送: ' + cmd, 2000);
        triggerExcited();
        addXP(4, '发送命令');
        api.sendCommand(cmd).then(function (res) {
          showToast(res && res.ok ? '命令已执行: ' + cmd : '命令已记录: ' + cmd, 'info');
        }).catch(function () { showToast('命令已记录: ' + cmd, 'info'); });
      });
    });
  }

  /**
   * 设置语音监听
   * @description 监听主进程推送的语音文本，显示4秒语音气泡。
   */
  function setupSpeechListener() { api.onSpeech(function (text) { showSpeech(text, 4000); }); }

  /**
   * 设置空闲检测
   * @description 监听鼠标移动、点击和键盘事件，任何用户活动都重置空闲计时器。
   */
  function setupIdleDetection() {
    ['click', 'keydown'].forEach(function (evt) { document.addEventListener(evt, resetIdle); });
    resetIdle();
  }

  /**
   * 重置空闲计时器
   * @description 核心空闲管理函数。用户有任何活动时调用：
   *   - 若当前处于空闲状态，则唤醒伙伴（清除睡眠动画、停止空闲动作、恢复心情）
   *   - 若之前处于深度睡眠（stage>=3），播放惊醒动画和语音
   *   - 重新启动 idleTimeout 毫秒后的空闲检测定时器
   */
  function resetIdle() {
    var wasSleeping = state.isIdle && state.sleepStage >= 3;
    if (state.isIdle) {
      state.isIdle = false;
      state.sleepStage = 0;
      state.manualState = false;
      if (state.idleActionTimer) { clearInterval(state.idleActionTimer); state.idleActionTimer = null; }
      state.sleepTimers.forEach(function (t) { clearTimeout(t); });
      state.sleepTimers = [];
      SLEEP_CLASSES.forEach(function (cls) { els.body.classList.remove(cls); });
      if (els.zzz) els.zzz.classList.remove('visible');
      if (els.thoughtBubble) els.thoughtBubble.classList.remove('visible');
      clearAIState();
      setMood(state.mood);
      if (wasSleeping) {
        addFxClass('wake-up-startle');
        if (!state.dndMode) showSpeech(randomFrom(SPEECH.wakeUp), 2500);
        setTimeout(function () { removeFxClass('wake-up-startle'); }, 600);
      }
    }
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(onIdle, state.idleTimeout);
  }

  /**
   * 空闲状态处理
   * @description 核心空闲行为函数。当用户长时间无操作时触发：
   *   - 进入空闲状态（sleepStage=1），显示空闲语音
   *   - 每12秒循环执行空闲动作（清扫/杂耍/搬运）
   *   - 30秒后进入浅睡（stage=2），45秒后深睡（stage=3，显示ZZZ），70秒后熟睡（stage=4）
   *   空闲动作在浅睡前停止，睡眠阶段逐步加深。
   */
  function onIdle() {
    state.isIdle = true;
    state.sleepStage = 1;
    SLEEP_CLASSES.forEach(function (cls) { if (els.body) els.body.classList.remove(cls); });
    if (els.body) els.body.classList.add('sleeping');
    if (els.mouth) els.mouth.className = 'mouth';
    if (!state.dndMode) showSpeech(randomFrom(SPEECH.idle), 4000);
    var idleActionNames = ['sweep', 'juggle', 'carry'];
    var idleActionIdx = 0;
    var idleActionTimer = setInterval(function () {
      if (!state.isIdle || state.sleepStage >= 2) { clearInterval(idleActionTimer); return; }
      var action = idleActionNames[idleActionIdx % idleActionNames.length];
      triggerIdleAction(action);
      idleActionIdx++;
    }, TIMING.IDLE_ACTION_INTERVAL);
    state.idleActionTimer = idleActionTimer;
    state.sleepTimers.push(
      setTimeout(function () { if (state.isIdle && state.sleepStage === 1) { state.sleepStage = 2; clearInterval(idleActionTimer); els.body.classList.add('sleep-dozing'); } }, TIMING.IDLE_DOZING_DELAY),
      setTimeout(function () { if (state.isIdle && state.sleepStage === 2) { state.sleepStage = 3; els.body.classList.add('sleep-collapsed'); if (els.zzz) els.zzz.classList.add('visible'); } }, TIMING.IDLE_COLLAPSED_DELAY),
      setTimeout(function () { if (state.isIdle && state.sleepStage === 3) { state.sleepStage = 4; els.body.classList.add('sleep-deep'); } }, TIMING.IDLE_DEEP_DELAY)
    );
  }

  /**
   * 显示语音气泡
   * @description 在伙伴旁边显示语音气泡文本，免打扰模式下不显示。
   *   自动清除前一个定时器，在指定时长后隐藏气泡。
   * @param {string} text - 语音文本内容
   * @param {number} [duration=3000] - 显示时长（毫秒）
   */
  function showSpeech(text, duration) {
    if (state.dndMode) return;
    if (typeof text !== 'string' || !text) return;
    if (!els.speechText || !els.speechBubble) return;
    var d = duration || TIMING.SPEECH_DEFAULT;
    els.speechText.textContent = text;
    els.speechBubble.classList.add('visible');
    if (state.speechTimeout) clearTimeout(state.speechTimeout);
    state.speechTimeout = setTimeout(function () { els.speechBubble.classList.remove('visible'); }, d);
  }

  /**
   * 显示Toast通知
   * @description 在通知容器中创建临时Toast元素，免打扰模式下仅显示error类型。
   *   根据类型显示不同图标（✓/✗/⚠/ℹ），4秒后自动消失。
   * @param {string} message - 通知消息文本
   * @param {string} [type='info'] - 通知类型（success/error/warning/info）
   */
  var TOAST_ICONS = { success: '\u2713', error: '\u2717', warning: '\u26A0' };

  function showToast(message, type) {
    if (typeof message !== 'string' || !message) return;
    if (state.dndMode && type !== 'error') return;
    if (els.toastContainer && els.toastContainer.children.length >= TIMING.MAX_TOASTS) {
      var oldest = els.toastContainer.children[0];
      if (oldest) oldest.remove();
    }
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    var icon = TOAST_ICONS[type] || '\u2139';
    var iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icon;
    var msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    t.appendChild(iconSpan);
    t.appendChild(msgSpan);
    if (!els.toastContainer) return;
    els.toastContainer.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('toast-visible'); });
    setTimeout(function () { t.classList.remove('toast-visible'); setTimeout(function () { t.remove(); }, TIMING.TOAST_FADE); }, TIMING.TOAST_DURATION);
  }

  /**
   * 设置心情模式
   * @description 切换伙伴的心情状态，更新CSS类和嘴巴表情。无论是否连接API都根据心情设置嘴巴样式：
   *   happy→笑脸、calm→中性嘴、energetic→笑脸。
   * @param {string} mood - 心情模式（happy/calm/energetic）
   */
  function setMood(mood) {
    if (!{ happy: 1, calm: 1, energetic: 1 }[mood]) return;
    state.mood = mood;
    MOOD_CLASSES.forEach(function (cls) { els.companion.classList.remove(cls); });
    els.companion.classList.add('mood-' + mood);
    if (mood === 'happy') { if (els.mouth) els.mouth.className = 'mouth happy'; }
    else if (mood === 'calm') { if (els.mouth) els.mouth.className = 'mouth'; }
    else if (mood === 'energetic') { if (els.mouth) els.mouth.className = 'mouth happy'; }
    saveSettings();
  }

  /**
   * 更新连接状态
   * @description 根据API连接状态更新状态指示灯、核心灯、嘴巴表情和状态文本。
   *   连接成功时触发兴奋动画和成功音效，断开时播放错误音效。
   * @param {boolean} connected - 是否已连接
   */
  function updateConnectionStatus(connected) {
    var prev = state.apiConnected;
    state.apiConnected = connected;
    if (connected) {
      if (els.statusDot) els.statusDot.className = 'status-dot connected';
      if (els.coreLight) els.coreLight.classList.remove('error');
      if (els.coreLight) els.coreLight.classList.add('connected');
      setMood(state.mood);
      if (els.statusText) els.statusText.textContent = '已连接';
      if (!prev) { showSpeech(randomFrom(SPEECH.connected), 3500); triggerExcited(); showToast('已连接到驭框架', 'success'); addXP(TIMING.CONNECT_XP, '连接框架', false); logEvent('连接到驭框架', 'success'); playSound('success'); showMinimalNotification('🟢 已连接', 'success'); }
    } else {
      if (els.statusDot) els.statusDot.className = 'status-dot disconnected';
      if (els.coreLight) els.coreLight.classList.remove('connected');
      if (els.coreLight) els.coreLight.classList.add('error');
      if (els.mouth) els.mouth.className = 'mouth sad';
      if (els.statusText) els.statusText.textContent = '未连接';
      if (prev) { showSpeech(randomFrom(SPEECH.disconnected), 3500); showToast('框架连接中断', 'error'); logEvent('框架连接中断', 'error'); playSound('error'); showMinimalNotification('🔴 连接中断', 'error'); }
    }
  }

  /**
   * 启动API轮询
   * @description 定期（默认5秒）请求 /api/health 检查连接状态，
   *   连接成功时同步轮询Agent状态，面板打开时刷新面板数据。
   */
  function startApiPolling() {
    var polling = false;
    function poll() {
      if (polling) return;
      polling = true;
      api.proxyAPI(API_ENDPOINTS.health).then(function (res) {
        if (res && res.ok) { updateConnectionStatus(true); pollAgentStatus(); pollOptimizationStatus(); if (state.panelOpen) refreshPanelData(); }
        else updateConnectionStatus(false);
      }).catch(function () { updateConnectionStatus(false); }).finally(function () { polling = false; });
    }
    poll(); var pollTimer = setInterval(poll, state.pollInterval);
    state.intervals.push(pollTimer);
  }

  /**
   * 轮询Agent状态
   * @description 请求 /api/agents 获取当前Agent数据并处理。
   */
  function pollAgentStatus() {
    api.proxyAPI(API_ENDPOINTS.agents).then(function (res) { if (res && res.ok && res.data) processAgentData(res.data); }).catch(function () {});
  }

  function pollOptimizationStatus() {
    try {
    api.proxyAPI(API_ENDPOINTS.optimizationStatus).then(function (res) {
      if (!res || !res.ok || !res.data || !res.data.available) {
        if (state.aiState === 'optimizing' && !state.manualState) {
          setAIState('idle');
          logEvent('优化服务不可用，状态已重置', 'warning');
        }
        return;
      }
      var data = res.data;
      if (data.status === 'running') {
        if (state.aiState !== 'optimizing' && !state.manualState) {
          setAIState('optimizing');
          logEvent('优化迭代 #' + data.currentIteration + ' 最佳分数: ' + (typeof data.bestScore === 'number' ? data.bestScore.toFixed(4) : 'N/A'), 'info');
        }
      } else if (data.status === 'converged') {
        if (state.aiState !== 'converged') {
          setAIState('converged');
          showSpeech('优化已收敛！最佳分数: ' + (typeof data.bestScore === 'number' ? data.bestScore.toFixed(4) : 'N/A'), 5000);
          spawnConfetti(12);
          playSound('levelup');
          logEvent('优化收敛于迭代 #' + data.bestIteration, 'success');
        }
      } else if (data.status === 'exhausted') {
        if (state.aiState === 'optimizing') {
          setAIState('idle');
          showSpeech('优化资源耗尽', 3000);
          logEvent('优化资源耗尽于迭代 #' + data.currentIteration, 'warning');
        }
      } else if (data.status === 'failed') {
        if (state.aiState === 'optimizing') {
          setAIState('error');
          logEvent('优化循环失败', 'error');
        }
      }
    }).catch(function () {});
    } catch (e) { console.error('pollOptimizationStatus', e); }
  }

  /**
   * 处理Agent数据
   * @description 分析活跃Agent数量：2个以上切换为指挥状态（多代理协作），
   *   1个活跃Agent时显示激活通知并播放挥手动画。
   * @param {Object} data - API返回的Agent数据
   */
  function processAgentData(data) {
    try {
    if (!data) return;
    var agents = data.agents || data;
    if (!Array.isArray(agents)) return;
    var activeAgents = agents.filter(function (a) {
      if (!a || typeof a !== 'object') return false;
      var st = a.status || a.state || '';
      return st === 'active' || st === 'running' || a.running === true;
    });
    if (activeAgents.length >= 2) {
      if (state.aiState !== 'conducting' && !state.manualState) {
        setAIState('conducting');
        spawnJuggleBalls();
        showToast(activeAgents.length + ' 个代理协作中', 'info');
        logEvent(activeAgents.length + ' 个代理协作中', 'info');
      }
    } else if (activeAgents.length === 1) {
      var activeAgent = activeAgents[0];
      var agentId = activeAgent.id || activeAgent.name || activeAgent.role || 'unknown';
      if (agentId !== state.currentAgent) {
        state.currentAgent = agentId;
        var name = activeAgent.name || activeAgent.role || agentId;
        showSpeech(randomFrom(SPEECH.agentActive).split('{name}').join(name), 4000);
        showToast(name + ' 已激活', 'info');
        addXP(5, '角色激活', false);
        addFxClass('waving');
        setTimeout(function () { removeFxClass('waving'); }, 1500);
        logEvent(name + ' 已激活', 'info');
      }
    } else {
      state.currentAgent = null;
    }
    } catch (e) { console.error('processAgentData', e); }
  }

  /**
   * 获取并显示Agent信息
   * @description 通过API获取Agent列表并显示活跃数量，失败时回退到演示数据。
   */
  function fetchAndShowAgents() {
    api.proxyAPI(API_ENDPOINTS.agents).then(function (res) {
      if (res && res.ok && res.data) {
        var agents = res.data.agents || res.data;
        if (Array.isArray(agents)) {
          var count = agents.length;
          var active = agents.filter(function (a) {
            if (!a || typeof a !== 'object') return false;
            var st = a.status || a.state || '';
            return st === 'active' || st === 'running' || a.running === true;
          }).length;
          showSpeech(active + '/' + count + ' 个角色活跃', 4000);
          showToast(active + '/' + count + ' 个角色活跃', 'success');
          return;
        }
      }
      showDemoAgents();
    }).catch(function () { showDemoAgents(); });
  }

  /**
   * 显示演示Agent信息
   * @description 使用回退数据展示Agent活跃状态。
   */
  function showDemoAgents() {
    var count = DEMO_AGENTS.length;
    var active = DEMO_AGENTS.filter(function (a) { return a.status === 'active'; }).length;
    showSpeech(active + '/' + count + ' 个角色活跃（演示）', 4000);
    showToast(active + '/' + count + ' 个角色活跃（演示模式）', 'info');
  }

  /**
   * 获取并显示技能信息
   * @description 通过API获取技能列表并显示数量，失败时回退到演示数据。
   */
  function fetchAndShowSkills() {
    api.proxyAPI(API_ENDPOINTS.skills).then(function (res) {
      if (res && res.ok && res.data) {
        var skills = res.data.skills || res.data;
        if (Array.isArray(skills)) { showSpeech(skills.length + ' 个技能已加载', 4000); showToast(skills.length + ' 个技能已加载', 'success'); return; }
        else if (typeof skills === 'object') { showSpeech(Object.keys(skills).length + ' 个技能类别', 4000); showToast(Object.keys(skills).length + ' 个技能类别', 'success'); return; }
      }
      showDemoSkills();
    }).catch(function () { showDemoSkills(); });
  }

  /**
   * 显示演示技能信息
   * @description 使用回退数据展示技能数量和验证状态。
   */
  function showDemoSkills() {
    var count = DEMO_SKILLS.length;
    var verified = DEMO_SKILLS.filter(function (s) { return s.verified; }).length;
    showSpeech(count + ' 个技能（演示）', 4000);
    showToast(count + ' 个技能 · ' + verified + ' 已验证（演示模式）', 'info');
  }

  /**
   * 入口：DOM加载完成后初始化桌面伙伴
   */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
