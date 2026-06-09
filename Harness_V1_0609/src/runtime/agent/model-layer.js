'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');

const MAX_DOMAIN_PROMPTS = 50;
const MAX_FEW_SHOT_DOMAINS = 50;

/**
 * @module runtime/agent/model-layer
 * @classdesc 模型层（ModelLayer）。LLM模型调用抽象层，
 * 管理LLM客户端连接、领域系统提示词注册、Few-Shot示例注入和推理调用。
 *
 * ModelLayer — LLM模型交互层
 * 管理LLM客户端连接、领域系统提示词注册、Few-Shot示例注入和推理调用。
 * 将消息与领域提示词和Few-Shot示例组装为完整请求序列，委托LLM客户端执行推理。
 *
 * @extends EventEmitter
 * @emits ModelLayer#llm-client-attached
 * @emits ModelLayer#domain-prompt-registered
 * @emits ModelLayer#few-shots-registered
 * @emits ModelLayer#infer-completed
 * @emits ModelLayer#infer-error
 */
class ModelLayer extends EventEmitter {
  /**
   * @param {Object} [config] - 配置选项
   */
  constructor(config) {
    super();
    this._llmClient = null;
    this._systemPrompts = new Map();
    this._fewShots = new Map();
    this._config = config ?? {};
    this._outputLanguage = this._config.outputLanguage ?? null;
  }

  /**
   * 设置LLM输出语言偏好。融合来源：DeepSeek CodeGPT X 中文指令优化
   * 设置后，infer() 会在系统提示词中自动追加语言指令。
   * @param {string|null} language - 语言代码（如 'zh-CN', 'en-US'），null表示不控制
   * @returns {ModelLayer} this（支持链式调用）
   */
  setOutputLanguage(language) {
    this.guardShutdown();
    this._outputLanguage = (typeof language === 'string' && language.length > 0) ? language : null;
    return this;
  }

  /**
   * 获取当前LLM输出语言偏好
   * @returns {string|null} 当前语言代码，null表示不控制
   */
  getOutputLanguage() {
    return this._outputLanguage;
  }

  /**
   * 附加LLM客户端实例。
   * @param {Object} client - LLM客户端，需实现chat(messages, options)方法
   * @returns {void}
   * @fires ModelLayer#llm-client-attached
   */
  attachLlmClient(client) {
    this.guardShutdown();
    this._llmClient = client;
    this.emit('llm-client-attached', { hasClient: true });
  }

  /**
   * 注册领域系统提示词。推理时根据domain参数自动注入对应提示词。
   * @param {string} domain - 领域标识符
   * @param {string} prompt - 系统提示词内容
   * @returns {void}
   * @fires ModelLayer#domain-prompt-registered
   */
  registerDomainPrompt(domain, prompt) {
    this.guardShutdown();
    if (this._systemPrompts.size >= MAX_DOMAIN_PROMPTS && !this._systemPrompts.has(domain)) {
      const oldest = this._systemPrompts.keys().next().value;
      if (oldest) this._systemPrompts.delete(oldest);
    }
    this._systemPrompts.set(domain, prompt);
    this.emit('domain-prompt-registered', { domain });
  }

  /**
   * 注册领域Few-Shot示例。推理时根据domain参数自动注入对应示例。
   * @param {string} domain - 领域标识符
   * @param {Array<{role: string, content: string}>} examples - Few-Shot示例消息数组
   * @returns {ModelLayer} this（支持链式调用）
   * @fires ModelLayer#few-shots-registered
   */
  registerFewShots(domain, examples) {
    this.guardShutdown();
    if (!Array.isArray(examples)) return this;
    if (this._fewShots.size >= MAX_FEW_SHOT_DOMAINS && !this._fewShots.has(domain)) {
      const oldest = this._fewShots.keys().next().value;
      if (oldest) this._fewShots.delete(oldest);
    }
    this._fewShots.set(domain, examples);
    this.emit('few-shots-registered', { domain, count: examples.length });
  }

  /**
   * 执行LLM推理。按 systemPrompt → fewShots → messages 的顺序组装完整消息序列，
   * 委托LLM客户端执行推理并返回结果。
   * @param {Array<{role: string, content: string}>} messages - 用户消息序列
   * @param {Object} [options] - 推理选项
   * @param {string} [options.domain='default'] - 领域标识符，用于匹配系统提示词和Few-Shot
   * @returns {Promise<*|null>} LLM响应结果，无客户端时返回null
   * @fires ModelLayer#infer-completed
   * @fires ModelLayer#infer-error
   */
  async infer(messages, options) {
    this.guardShutdown();
    if (!this._llmClient) return null;
    const opts = options ?? {};
    const domain = opts.domain ?? 'default';
    const systemPrompt = this._systemPrompts.get(domain) ?? '';
    const fewShots = this._fewShots.get(domain) ?? [];
    const fullMessages = [];
    if (systemPrompt || this._outputLanguage) {
      let finalSystemPrompt = systemPrompt;
      if (this._outputLanguage) {
        const langDirective = '\n\n[Language Directive: You must respond in ' + this._outputLanguage + '.]';
        finalSystemPrompt = finalSystemPrompt ? finalSystemPrompt + langDirective : langDirective.trim();
      }
      if (finalSystemPrompt) {
        fullMessages.push({ role: 'system', content: finalSystemPrompt });
      }
    }
    for (const shot of fewShots) {
      fullMessages.push(shot);
    }
    for (const msg of messages) {
      fullMessages.push(msg);
    }
    try {
      const response = await this._llmClient.chat(fullMessages, opts);
      this.emit('infer-completed', { domain, messageCount: messages.length });
      return response;
    } catch (err) {
      this.emit('infer-error', { domain, error: err && err.message ? err.message : String(err) });
      return null;
    }
  }

  /**
   * 列出所有已注册提示词或Few-Shot的领域标识符。
   * @returns {string[]} 领域标识符数组
   */
  listDomains() {
    const domains = new Set();
    for (const key of this._systemPrompts.keys()) {
      domains.add(key);
    }
    for (const key of this._fewShots.keys()) {
      domains.add(key);
    }
    return Array.from(domains);
  }

  _onShutdown() {
    this._llmClient = null;
    this._systemPrompts.clear();
    this._fewShots.clear();
    this.removeAllListeners();
  }
}

module.exports = withShutdown(ModelLayer);
