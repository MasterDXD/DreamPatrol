'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { timestampId } = require('../../utils/unique-id');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @module runtime/skill/playbook-generator
 * 模式最低出现频次阈值，低于此值的模式不会纳入Playbook生成。
 * @type {number}
 */
const DEFAULT_MIN_FREQUENCY = 2;

/**
 * 模式最低置信度阈值，低于此值的模式不会纳入Playbook生成。
 * @type {number}
 */
const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Playbook最大保留数量，超出时淘汰最早插入的Playbook（FIFO）。
 * @type {number}
 */
const DEFAULT_MAX_PLAYBOOKS = 50;

/**
 * 人类工作流提取的步骤分隔符模式。
 * 匹配编号步骤（1. / 1) / 第一步 / Step 1）和换行分隔的步骤。
 * @type {RegExp}
 */
const HUMAN_STEP_PATTERN = /(?:^|\n)\s*(?:\d+[.)]\s+|第[一二三四五六七八九十]+步[：:]\s*|Step\s+\d+[：:]\s*|[-*]\s+)/gi;

/**
 * 人类工作流文档中常见的非步骤标题行模式。
 * @type {RegExp}
 */
const SECTION_HEADER_PATTERN = /^(?:#{1,6}\s|={3,}|-{3,})/gm;

/**
 * DreamEngine类别到Playbook类别的映射表。
 * 将连字符格式（best-practice）转换为下划线格式（best_practice），
 * 以符合Playbook内部存储规范。
 * @type {Object<string, string>}
 */
const CATEGORY_MAP = {
  'best-practice': 'best_practice',
  'error-avoidance': 'error_prevention',
  'workflow-optimization': 'workflow_optimization',
};

/**
 * DreamEngine支持的梦境笔记类别列表。
 * 仅对这三个类别执行Playbook生成：最佳实践、错误规避、工作流优化。
 * @type {string[]}
 */
const DREAM_CATEGORIES = ['best-practice', 'error-avoidance', 'workflow-optimization'];

/**
 * PlaybookGenerator — Playbook生成器
 * 从DreamEngine模式自动生成结构化Playbook，支持版本追踪和持续精化。
 * 从best-practice/error-avoidance/workflow-optimization三类梦境笔记中提取高频高置信度模式，
 * 生成带步骤的Playbook，error-avoidance类别额外附加错误模式与解决方案。
 * 支持Playbook的更新（版本自增）与删除，最多保留DEFAULT_MAX_PLAYBOOKS个Playbook。
 * @extends EventEmitter
 * @emits PlaybookGenerator#playbook-updated 当Playbook更新时触发，载荷为{id: string, version: number}
 */
class PlaybookGenerator extends EventEmitter {
  /**
   * 创建PlaybookGenerator实例。
   * @param {Object} [options] - 配置选项
   * @param {Object|null} [options.dreamEngine=null] - DreamEngine实例，需提供getNotesByCategory方法
   * @param {number} [options.minPatternFrequency=2] - 模式最低出现频次阈值
   * @param {number} [options.minConfidence=0.6] - 模式最低置信度阈值
   * @param {number} [options.maxPlaybooks=50] - Playbook最大保留数量
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._dreamEngine = opts.dreamEngine ?? null;
    this._minPatternFrequency = opts.minPatternFrequency ?? DEFAULT_MIN_FREQUENCY;
    this._minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this._maxPlaybooks = opts.maxPlaybooks ?? DEFAULT_MAX_PLAYBOOKS;
    this._playbooks = new Map();
    this._stats = { generated: 0, updated: 0, removed: 0, errors: 0 };
  }

  /**
   * 从DreamEngine梦境笔记生成Playbook。
   * 遍历DREAM_CATEGORIES中的三个类别，通过DreamEngine.getNotesByCategory获取笔记，
   * 过滤出置信度≥minConfidence且频次≥minPatternFrequency的模式，
   * 提取步骤后生成结构化Playbook。error-avoidance类别额外附加errorPatterns字段。
   * 当Playbook数量达到上限时，淘汰最早插入的Playbook。
   * @returns {Object[]} 生成的Playbook数组，每个Playbook包含id/category/title/steps/version/sourceNotes/createdAt字段
   */
  generateFromDreams() {
    this.guardShutdown();
    if (!this._dreamEngine) return [];

    const getNotes = this._dreamEngine.getNotesByCategory || this._dreamEngine.getNotes;
    if (typeof getNotes !== 'function') return [];

    const results = [];
    for (const cat of DREAM_CATEGORIES) {
      try {
        const notes = getNotes.call(this._dreamEngine, cat);
        if (!Array.isArray(notes)) continue;

        const filtered = notes.filter(n =>
          (typeof n.confidence === 'number' && Number.isFinite(n.confidence) ? n.confidence : 0) >= this._minConfidence &&
          (typeof n.frequency === 'number' && Number.isFinite(n.frequency) ? n.frequency : 0) >= this._minPatternFrequency,
        );

        if (filtered.length === 0) continue;

        const mappedCategory = CATEGORY_MAP[cat] || cat.replace(/-/g, '_');
        const id = timestampId('pb-');

        const steps = this._extractSteps(filtered);
        const playbook = {
          id: id,
          category: mappedCategory,
          title: (filtered[0] && filtered[0].title) || mappedCategory,
          steps: steps,
          version: 1,
          sourceNotes: filtered.length,
          createdAt: new Date().toISOString(),
        };

        if (cat === 'error-avoidance') {
          playbook.errorPatterns = filtered.map(n => ({
            pattern: n.content || n.title || '',
            solution: n.solution || '',
            confidence: n.confidence ?? 0,
          }));
        }

        if (this._playbooks.size >= this._maxPlaybooks) {
          const oldestKey = this._playbooks.keys().next().value;
          if (oldestKey) this._playbooks.delete(oldestKey);
        }

        this._playbooks.set(id, playbook);
        this._stats.generated++;
        results.push(playbook);
      } catch (err) {
        debug('PlaybookGenerator', 'generateFromDreams', err && err.message ? err.message : String(err));
        this._stats.errors++;
      }
    }

    return results;
  }

  /**
   * 从人类工作流文档提取Playbook（Skill蒸馏核心入口）。
   * 将散在文档、会议纪要、操作手册中的人类工作方法拆解为可执行的步骤化Playbook，
   * 使小模型可按流程执行，而非依赖大模型的理解能力。
   *
   * 支持的输入格式：
   * - 编号步骤（1. xxx / 1) xxx）
   * - 中文步骤（第一步：xxx / 第二步：xxx）
   * - 英文步骤（Step 1: xxx）
   * - Markdown列表（- xxx / * xxx）
   * - 纯换行分隔的段落
   *
   * @param {Object} workflow - 人类工作流描述
   * @param {string} workflow.title - 工作流标题
   * @param {string} workflow.content - 工作流内容文本
   * @param {string} [workflow.category='workflow_optimization'] - Playbook类别
   * @param {string} [workflow.source='human'] - 来源标记
   * @param {string[]} [workflow.errorPatterns] - 已知的错误模式与解决方案
   * @returns {Object|null} 生成的Playbook对象，若内容为空则返回null
   */
  generateFromHumanWorkflow(workflow) {
    this.guardShutdown();
    if (!workflow || typeof workflow !== 'object') return null;
    const content = workflow.content || '';
    const title = workflow.title || 'Untitled Workflow';
    if (!content.trim()) return null;

    const steps = this._extractHumanSteps(content);
    if (steps.length === 0) return null;

    const category = workflow.category || 'workflow_optimization';
    const id = timestampId('pb-');
    const playbook = {
      id: id,
      category: category,
      title: title,
      steps: steps,
      version: 1,
      source: workflow.source || 'human',
      sourceNotes: 1,
      createdAt: new Date().toISOString(),
      modelTier: 'small',
    };

    if (Array.isArray(workflow.errorPatterns) && workflow.errorPatterns.length > 0) {
      playbook.errorPatterns = workflow.errorPatterns;
    }

    if (this._playbooks.size >= this._maxPlaybooks) {
      const oldestKey = this._playbooks.keys().next().value;
      if (oldestKey) this._playbooks.delete(oldestKey);
    }

    this._playbooks.set(id, playbook);
    this._stats.generated++;
    this.emit('playbook-generated', { id, category, source: 'human', stepCount: steps.length });
    return playbook;
  }

  /**
   * 从人类工作流文本中提取步骤。
   * 优先匹配编号/列表格式，回退到段落分割。
   * @param {string} content - 工作流文本
   * @returns {string[]} 提取的步骤数组
   * @private
   */
  _extractHumanSteps(content) {
    if (!content || typeof content !== 'string') return [];

    // 去除Markdown标题行
    const cleaned = content.replace(SECTION_HEADER_PATTERN, '').trim();
    if (!cleaned) return [];

    // 尝试匹配编号/列表步骤
    const matches = [];
    let match;
    HUMAN_STEP_PATTERN.lastIndex = 0;
    while ((match = HUMAN_STEP_PATTERN.exec(cleaned)) !== null) {
      matches.push({ index: match.index, prefix: match[0] });
    }

    if (matches.length >= 2) {
      const steps = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index + matches[i].prefix.length;
        const end = i + 1 < matches.length ? matches[i + 1].index : cleaned.length;
        const step = cleaned.substring(start, end).trim();
        if (step) steps.push(step);
      }
      return steps;
    }

    // 回退：按换行分割，过滤空行和过短行
    const lines = cleaned.split(/\n+/).map(l => l.trim()).filter(l => l.length > 3);
    return lines;
  }

  /**
   * 从梦境笔记数组中提取步骤。
   * 优先匹配编号步骤格式（如"1. 做某事"），提取编号后的文本；
   * 若无编号格式则将整条content作为单个步骤。
   * @param {Object[]} notes - 梦境笔记数组
   * @param {string} [notes.content] - 笔记内容
   * @returns {string[]} 提取的步骤文本数组
   * @private
   */
  _extractSteps(notes) {
    const steps = [];
    for (const note of notes) {
      const content = note.content || '';
      const numberedSteps = content.match(/\d+\.\s+[^\n]+/g);
      if (numberedSteps) {
        for (const s of numberedSteps) {
          steps.push(s.replace(/^\d+\.\s*/, '').trim());
        }
      } else if (content.trim()) {
        steps.push(content.trim());
      }
    }
    return steps;
  }

  /**
   * 获取当前Playbook总数。
   * @returns {number} Playbook数量
   */
  getPlaybookCount() {
    return this._playbooks.size;
  }

  /**
   * 更新指定Playbook的标题和/或步骤，版本号自增。
   * 更新成功后触发playbook-updated事件。
   * @param {string} id - Playbook标识
   * @param {Object} updates - 更新内容
   * @param {string} [updates.title] - 新标题
   * @param {string[]} [updates.steps] - 新步骤数组
   * @returns {Object|null} 更新后的Playbook对象，若id不存在则返回null
   */
  updatePlaybook(id, updates) {
    this.guardShutdown();
    const playbook = this._playbooks.get(id);
    if (!playbook) return null;

    if (updates && updates.title) playbook.title = updates.title;
    if (updates && updates.steps) playbook.steps = updates.steps;
    playbook.version = (typeof playbook.version === 'number' && Number.isFinite(playbook.version) ? playbook.version : 1) + 1;
    playbook.updatedAt = new Date().toISOString();

    this._stats.updated++;
    this.emit('playbook-updated', { id, version: playbook.version });
    return playbook;
  }

  /**
   * 删除指定Playbook。
   * @param {string} id - Playbook标识
   * @returns {boolean} 是否成功删除
   */
  removePlaybook(id) {
    this.guardShutdown();
    const deleted = this._playbooks.delete(id);
    if (deleted) this._stats.removed++;
    return deleted;
  }

  /**
   * 按类别查询Playbook列表。
   * @param {string} category - Playbook类别（如best_practice/error_prevention/workflow_optimization）
   * @returns {Object[]} 匹配类别的Playbook数组
   */
  getPlaybooksByCategory(category) {
    const results = [];
    for (const [, pb] of this._playbooks) {
      if (pb.category === category) results.push({ ...pb, steps: [...pb.steps] });
    }
    return results;
  }

  /**
   * 获取PlaybookGenerator运行统计信息。
   * @returns {Object} 统计对象
   * @returns {number} returns.generated - 已生成Playbook总数
   * @returns {number} returns.updated - 已更新Playbook总次数
   * @returns {number} returns.removed - 已删除Playbook总数
   * @returns {number} returns.errors - 累计错误次数
   * @returns {number} returns.totalPlaybooks - 当前Playbook总数
   */
  getStats() {
    return { ...this._stats, totalPlaybooks: this._playbooks.size };
  }

  /**
   * 检查PlaybookGenerator是否健康。
   * 当累计错误次数小于100时视为健康。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._stats.errors < 100;
  }

  /**
   * 关闭时清理所有Playbook数据。
   * @private
   */
  _onShutdown() {
    this._playbooks.clear();
    this.removeAllListeners();
  }
}

const _WrappedPlaybookGenerator = withShutdown(PlaybookGenerator);
module.exports = _WrappedPlaybookGenerator;
module.exports.PlaybookGenerator = _WrappedPlaybookGenerator;
