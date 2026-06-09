/**
 * @module runtime/tui/persona-manager
 * @description 人格管理器，维护14个内置人格与自定义人格的注册、切换和查询。
 * 内置人格映射到Harness 25个Agent角色体系，为TUI交互提供角色上下文切换能力。
 *
 * 架构角色：TUI子系统的角色上下文层，为REPLEngine和TUIOrchestrator提供人格状态管理。
 *
 * 内置人格与Agent角色映射：
 * | 人格ID     | 名称   | 对应Agent角色                          |
 * |-----------|--------|----------------------------------------|
 * | default   | 默认   | 标准专业模式（无特定角色）              |
 * | analyst   | 分析师 | Domain Analyst（领域分析师）            |
 * | worker    | 执行者 | Task Worker（任务执行者）               |
 * | qa        | 质量保证| Quality Assurance（质量保证）           |
 * | lead      | 负责人 | Team Lead（团队负责人）                 |
 * | devops    | 运维   | DevOps Engineer（运维工程师）           |
 * | writer    | 文档   | Technical Writer（技术文档工程师）      |
 * | reviewer  | 审查员 | Code Reviewer（代码审查员）             |
 * | security  | 安全员 | Security Reviewer（安全审查员）         |
 * | planner   | 规划师 | Planner（实现规划师）                   |
 * | tester    | 测试员 | Test Writer（测试编写者）               |
 * | concise   | 极简   | 风格模式（简洁回复）                    |
 * | detailed  | 详细   | 风格模式（详细解释）                    |
 * | pirate    | 海盗   | 风格模式（海盗风格）                    |
 * | kawaii    | 可爱   | 风格模式（可爱风格）                    |
 *
 * 集成点：
 * - 由 {@link module:tui-orchestrator|TUIOrchestrator} 创建和管理
 * - 通过 persona-changed 事件通知 {@link module:repl-engine|REPLEngine} 更新提示符
 * - 人格切换通过 /persona 斜杠命令触发
 */

'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

const MAX_PERSONAS = 50;
const BUILTIN_PERSONAS = {
  default: { name: '默认', description: '标准专业模式', prompt: '' },
  analyst: { name: '分析师', description: 'Domain Analyst 角色模式', prompt: '你是一位领域分析师，专注于需求分析、架构设计和代码审核。' },
  worker: { name: '执行者', description: 'Task Worker 角色模式', prompt: '你是一位任务执行者，专注于编码实现和工具调用。' },
  qa: { name: '质量保证', description: 'QA 角色模式', prompt: '你是一位质量保证专家，专注于测试设计和缺陷管理。' },
  lead: { name: '负责人', description: 'Team Lead 角色模式', prompt: '你是一位团队负责人，专注于项目拆解、任务分配和进度监控。' },
  devops: { name: '运维', description: 'DevOps 角色模式', prompt: '你是一位运维工程师，专注于基础设施、构建部署和系统监控。' },
  writer: { name: '文档', description: 'Technical Writer 角色模式', prompt: '你是一位技术文档工程师，专注于文档编写和知识管理。' },
  concise: { name: '极简', description: '简洁回复模式', prompt: '请用最简洁的方式回复，省略所有客套和解释。' },
  detailed: { name: '详细', description: '详细解释模式', prompt: '请提供详尽的解释，包含背景、原理、示例和注意事项。' },
  pirate: { name: '海盗', description: '海盗风格模式', prompt: '请用海盗风格回复，使用海盗用语和比喻。' },
  kawaii: { name: '可爱', description: '可爱风格模式', prompt: '请用可爱友好的风格回复，使用表情符号和温和语气。' },
  reviewer: { name: '审查员', description: 'Code Reviewer 角色模式', prompt: '你是一位代码审查员，专注于代码质量审查和反模式检测。' },
  security: { name: '安全员', description: 'Security Reviewer 角色模式', prompt: '你是一位安全审查员，专注于安全审计和漏洞检测。' },
  planner: { name: '规划师', description: 'Planner 角色模式', prompt: '你是一位实现规划师，专注于需求探索和任务拆解。' },
  tester: { name: '测试员', description: 'Test Writer 角色模式', prompt: '你是一位测试编写者，专注于TDD测试编写和覆盖率优化。' },
};

/**
 * 人格管理器。维护14个内置人格和最多50个自定义人格的注册、切换与查询。
 * 内置人格不可删除，自定义人格通过addPersona/removePersona管理。
 * 使用BoundedMap限制内存占用，人格切换时触发persona-changed事件。
 *
 * @classdesc 人格管理器。AI人格配置、角色切换、行为适配
 *
 * @class
 * @extends EventEmitter
 * @fires PersonaManager#persona-changed
 * @fires PersonaManager#persona-added
 * @fires PersonaManager#persona-removed
 *
 * @param {Object} [options] - 配置选项（当前未使用，保留扩展）
 *
 * @example
 * const pm = new PersonaManager();
 * pm.on('persona-changed', (data) => {
 *   console.log(`人格切换: ${data.previous} → ${data.current}`);
 * });
 * pm.setPersona('analyst');
 * pm.addPersona('custom', { name: '自定义', description: '我的模式', prompt: '...' });
 */
class PersonaManager extends EventEmitter {
  constructor(options) {
    super();
    this._options = options ?? {};
    this._personas = new BoundedMap(MAX_PERSONAS, {
      onEvict: (key) => {
        if (this._currentPersona === key) {
          this._currentPersona = 'default';
        }
      },
    });
    this._currentPersona = 'default';
    this._customPersonas = new BoundedMap(MAX_PERSONAS);

    for (const [id, persona] of Object.entries(BUILTIN_PERSONAS)) {
      this._personas.set(id, { ...persona, builtin: true });
    }
  }

  /**
   * 根据ID获取人格数据。返回包含name、description、prompt、builtin字段的对象。
   *
   * @param {string} id - 人格标识
   * @returns {Object|null} 人格数据对象，不存在时返回null
   *
   * @example
   * const analyst = pm.getPersona('analyst');
   * // { name: '分析师', description: 'Domain Analyst 角色模式', prompt: '...', builtin: true }
   */
  getPersona(id) {
    const persona = this._personas.get(id);
    return persona ? { ...persona } : null;
  }

  /**
   * 获取当前激活的人格ID。
   *
   * @returns {string} 当前人格标识
   */
  getCurrentPersona() {
    return this._currentPersona;
  }

  /**
   * 获取当前激活人格的完整数据对象。
   * 若当前人格数据异常则回退到default。
   *
   * @returns {Object} 当前人格数据
   */
  getCurrentPersonaData() {
    const persona = this._personas.get(this._currentPersona);
    return persona ? { ...persona } : { ...BUILTIN_PERSONAS.default };
  }

  /**
   * 切换当前激活人格。仅当目标人格已注册时才切换。
   *
   * @param {string} id - 目标人格标识
   * @fires PersonaManager#persona-changed
   * @returns {boolean} 切换是否成功
   *
   * @example
   * if (pm.setPersona('qa')) {
   *   console.log('已切换到QA模式');
   * } else {
   *   console.log('未知人格');
   * }
   */
  setPersona(id) {
    this.guardShutdown();
    if (!this._personas.has(id)) {
      return false;
    }
    const prev = this._currentPersona;
    this._currentPersona = id;
    this.emit('persona-changed', { previous: prev, current: id, data: this._personas.get(id) });
    return true;
  }

  /**
   * 注册自定义人格。内置人格ID不可覆盖。
   * ID仅允许字母、数字、下划线和连字符，长度不超过64。
   *
   * @param {string} id - 人格标识（必须匹配 /^[a-zA-Z0-9_-]+$/，长度≤64）
   * @param {Object} persona - 人格定义
   * @param {string} [persona.name=id] - 显示名称
   * @param {string} [persona.description=''] - 人格描述
   * @param {string} [persona.prompt=''] - 系统提示词
   * @fires PersonaManager#persona-added
   * @returns {boolean} 注册是否成功
   *
   * @example
   * pm.addPersona('mentor', {
   *   name: '导师',
   *   description: '教学指导模式',
   *   prompt: '你是一位耐心的导师，用苏格拉底式提问引导学习。'
   * });
   */
  addPersona(id, persona) {
    this.guardShutdown();
    if (!id || typeof id !== 'string' || id.length > 64) return false;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return false;
    if (BUILTIN_PERSONAS[id]) return false;
    if (this._personas.size >= MAX_PERSONAS) return false;
    if (!persona || typeof persona !== 'object') return false;

    const entry = {
      name: persona.name ?? id,
      description: persona.description ?? '',
      prompt: persona.prompt ?? '',
      builtin: false,
    };
    this._personas.set(id, entry);
    this._customPersonas.set(id, entry);
    this.emit('persona-added', { id, data: entry });
    return true;
  }

  /**
   * 移除自定义人格。内置人格不可移除。
   * 若移除的是当前激活人格，自动回退到default。
   *
   * @param {string} id - 要移除的人格标识
   * @fires PersonaManager#persona-removed
   * @returns {boolean} 移除是否成功
   */
  removePersona(id) {
    this.guardShutdown();
    if (BUILTIN_PERSONAS[id]) return false;
    if (!this._customPersonas.has(id)) return false;
    const wasCurrent = this._currentPersona === id;
    if (wasCurrent) {
      this._currentPersona = 'default';
    }
    this._personas.delete(id);
    this._customPersonas.delete(id);
    this.emit('persona-removed', { id });
    if (wasCurrent) {
      this.emit('persona-changed', { previous: id, current: 'default', data: this._personas.get('default') });
    }
    return true;
  }

  /**
   * 列出所有已注册人格（内置+自定义），包含激活状态标记。
   *
   * @returns {Array<{id: string, name: string, description: string, builtin: boolean, active: boolean}>} 人格列表
   *
   * @example
   * pm.listPersonas().forEach(p => {
   *   console.log(`${p.id} (${p.name})${p.active ? ' *' : ''} [${p.builtin ? '内置' : '自定义'}]`);
   * });
   */
  listPersonas() {
    const result = [];
    for (const [id, data] of this._personas.entries()) {
      result.push({
        id,
        name: data.name,
        description: data.description,
        builtin: data.builtin,
        active: id === this._currentPersona,
      });
    }
    return result;
  }

  /**
   * 获取指定人格的系统提示词。未指定ID时返回当前人格的提示词。
   *
   * @param {string} [id] - 人格标识，省略则使用当前人格
   * @returns {string} 系统提示词，空字符串表示无提示词
   */
  getPersonaPrompt(id) {
    const persona = this._personas.get(id ?? this._currentPersona);
    return persona ? persona.prompt : '';
  }

  /**
   * 优雅关闭回调。清空所有人格映射。
   * 由withShutdown混入自动调用。
   *
   * @returns {void}
   * @private
   */
  _onShutdown() {
    safeCall(() => this._personas.shutdown(), 'PersonaManager', 'shutdown-personas');
    safeCall(() => this._customPersonas.shutdown(), 'PersonaManager', 'shutdown-customPersonas');
    this.removeAllListeners();
  }

  /**
   * 获取人格管理器统计信息。
   *
   * @returns {Object} 统计快照
   * @returns {number} returns.totalPersonas - 总人格数（内置+自定义）
   * @returns {number} returns.builtinCount - 内置人格数
   * @returns {number} returns.customCount - 自定义人格数
   * @returns {string} returns.currentPersona - 当前激活人格ID
   */
  getStats() {
    return {
      totalPersonas: this._personas.size,
      builtinCount: Object.keys(BUILTIN_PERSONAS).length,
      customCount: this._customPersonas.size,
      currentPersona: this._currentPersona,
    };
  }
}

PersonaManager.BUILTIN_PERSONAS = BUILTIN_PERSONAS;

module.exports = withShutdown(PersonaManager);
