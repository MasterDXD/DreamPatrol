/**
 * @module i18n
 * @description 国际化工具模块，提供多语言消息翻译功能。支持中英文两种语言，
 * 使用{0}、{1}占位符进行参数替换，默认语言为中文。
 */

'use strict';

/** @constant {string} DEFAULT_LOCALE - 默认语言区域 */
const DEFAULT_LOCALE = 'zh-CN';
/** @constant {string[]} SUPPORTED_LOCALES_ARRAY - 支持的语言区域列表 */
const SUPPORTED_LOCALES_ARRAY = ['zh-CN', 'en-US'];
/** @constant {Set<string>} SUPPORTED_LOCALES - 支持的语言区域集合 */
const SUPPORTED_LOCALES = new Set(SUPPORTED_LOCALES_ARRAY);

/** @constant {Object.<string, Object.<string, string>>} messages - 多语言消息映射表 */
const messages = {
  'zh-CN': {
    'server.starting': '多Agent框架控制台',
    'server.error.internal': '服务器内部错误',
    'server.error.url_too_long': '请求地址过长',
    'server.error.method_not_allowed': '方法不允许',
    'server.error.url_invalid': '请求地址格式错误',
    'server.error.not_found': '接口未找到',
    'server.error.rate_limited': '请求过于频繁，请稍后再试',
    'server.error.resource_not_found': '未找到资源',
    'server.error.access_denied': '禁止访问',
    'session.not_found': '会话 {0} 未找到',
    'session.invalid_id': 'sessionId格式不合法',
    'session.invalid_phase': '无效的阶段转换: {0} -> {1}',
    'session.invalid_tokens': 'tokens必须是非负有限数',
    'permission.denied': '权限不足: {0}',
    'permission.path_traversal': '路径遍历攻击已阻止',
    'permission.system_file': '系统文件受保护，禁止修改',
    'permission.file_locked': '文件已被 {0} 锁定',
    'permission.dangerous_command': '危险命令已阻止: {0}',
    'tdd.no_test_first': 'TDD违规: 实现文件 {0} 没有对应的测试文件 {1}',
    'tdd.coverage_below': '覆盖率 {0}% 低于阈值 {1}%',
    'tdd.invalid_cycle': '无效的TDD周期顺序',
    'evidence.insufficient': '证据不足: 缺少 {0}',
    'config.invalid_version': '不支持的配置版本: {0}',
    'config.invalid_enforcement': '无效的执行级别: {0}',
    'rollback.requires_approval': '阶段回退需要审批: {0} -> {1}',
    'rollback.skills_invalidated': '以下技能将失效: {0}',
    'concurrency.slot_acquired': '并发槽位已获取: {0}',
    'concurrency.queued': '任务已排队等待: {0}',
    'concurrency.released': '并发槽位已释放: {0}',
    'adversarial.consensus': '对抗审查达成共识',
    'adversarial.no_consensus': '对抗审查未达成共识，共 {0} 轮',
    'checkpoint.created': '检查点已创建: {0}',
    'checkpoint.restored': '检查点已恢复: {0}',
    'memory.knowledge_added': '知识条目已添加: {0}',
    'memory.summary_saved': '会话摘要已保存: {0}',
    'improver.learning_recorded': '技能经验已记录: {0}',
    'workflow.template_created': '工作流模板已创建: {0}',
    'workflow.template_instantiated': '工作流模板已实例化: {0}',
    'platform.registered': '平台已注册: {0}',
    'platform.message_sent': '消息已发送到平台: {0}',
    'platform.broadcast': '消息已广播到 {0} 个平台',
  },
  'en-US': {
    'server.starting': 'Multi-Agent Framework Console',
    'server.error.internal': 'Internal Server Error',
    'server.error.url_too_long': 'URL too long',
    'server.error.method_not_allowed': 'Method Not Allowed',
    'server.error.url_invalid': 'Invalid URL format',
    'server.error.not_found': 'Endpoint not found',
    'server.error.rate_limited': 'Too many requests, please try again later',
    'server.error.resource_not_found': 'Resource not found',
    'server.error.access_denied': 'Access denied',
    'session.not_found': 'Session {0} not found',
    'session.invalid_id': 'Invalid sessionId format',
    'session.invalid_phase': 'Invalid phase transition: {0} -> {1}',
    'session.invalid_tokens': 'tokens must be a non-negative finite number',
    'permission.denied': 'Permission denied: {0}',
    'permission.path_traversal': 'Path traversal attack blocked',
    'permission.system_file': 'System file protected, modification denied',
    'permission.file_locked': 'File locked by {0}',
    'permission.dangerous_command': 'Dangerous command blocked: {0}',
    'tdd.no_test_first': 'TDD violation: implementation {0} exists without test {1}',
    'tdd.coverage_below': 'Coverage {0}% is below threshold {1}%',
    'tdd.invalid_cycle': 'Invalid TDD cycle order',
    'evidence.insufficient': 'Insufficient evidence: missing {0}',
    'compliance.error': 'Framework compliance violation: {0}',
    'compliance.warning': 'Framework compliance warning: {0}',
    'deviation.requested': 'Deviation requested for rule {0}',
    'deviation.approved': 'Deviation approved for rule {0}',
    'deviation.rejected': 'Deviation rejected for rule {0}',
    'deviation.expired': 'Deviation expired for rule {0}',
    'review.created': 'Code review created: {0}',
    'review.completed': 'Code review completed: verdict {0}',
    'review.approved': 'Code review approved',
    'config.invalid_version': 'Unsupported config version: {0}',
    'config.invalid_enforcement': 'Invalid enforcement level: {0}',
    'rollback.requires_approval': 'Phase rollback requires approval: {0} -> {1}',
    'rollback.skills_invalidated': 'Skills will be invalidated: {0}',
    'concurrency.slot_acquired': 'Concurrency slot acquired: {0}',
    'concurrency.queued': 'Task queued: {0}',
    'concurrency.released': 'Concurrency slot released: {0}',
    'adversarial.consensus': 'Adversarial review reached consensus',
    'adversarial.no_consensus': 'Adversarial review no consensus after {0} rounds',
    'checkpoint.created': 'Checkpoint created: {0}',
    'checkpoint.restored': 'Checkpoint restored: {0}',
    'memory.knowledge_added': 'Knowledge entry added: {0}',
    'memory.summary_saved': 'Session summary saved: {0}',
    'improver.learning_recorded': 'Skill learning recorded: {0}',
    'workflow.template_created': 'Workflow template created: {0}',
    'workflow.template_instantiated': 'Workflow template instantiated: {0}',
    'platform.registered': 'Platform registered: {0}',
    'platform.message_sent': 'Message sent to platform: {0}',
    'platform.broadcast': 'Message broadcast to {0} platforms',
  },
};

/** @type {string} currentLocale - 当前语言区域 */
let currentLocale = DEFAULT_LOCALE;

/**
 * 设置当前语言区域，仅接受支持的区域代码
 * @param {string} locale - 语言区域代码（如'zh-CN'、'en-US'）
 */
function setLocale(locale) {
  if (SUPPORTED_LOCALES.has(locale)) {
    currentLocale = locale;
  }
}

/**
 * 获取当前语言区域
 * @returns {string} 当前语言区域代码
 */
function getLocale() {
  return currentLocale;
}

/**
 * 翻译指定键的消息，支持{0}、{1}等占位符替换
 * @param {string} key - 消息键
 * @param {...*} args - 占位符替换参数
 * @returns {string} 翻译后的消息字符串
 */
function t(key, ...args) {
  const localeMessages = messages[currentLocale] || messages[DEFAULT_LOCALE];
  let msg = localeMessages[key] || messages[DEFAULT_LOCALE][key] || key;

  for (let i = 0; i < args.length; i++) {
    const placeholder = '{' + i + '}';
    const value = String(args[i]).replace(/[{}]/g, '');
    while (msg.indexOf(placeholder) !== -1) {
      msg = msg.replace(placeholder, value);
    }
  }

  return msg;
}

/**
 * 获取支持的语言区域列表副本
 * @returns {string[]} 语言区域代码数组
 */
function getSupportedLocales() {
  return SUPPORTED_LOCALES_ARRAY.slice();
}

module.exports = { t, setLocale, getLocale, getSupportedLocales, DEFAULT_LOCALE, SUPPORTED_LOCALES };
