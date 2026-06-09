'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeCall, safeDateGetTime } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');
const BoundedMap = require('../../utils/bounded-map');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 行为类型枚举
 * @enum {string}
 */
const BEHAVIOR_TYPES = {
  CODING: 'coding',
  DECISION: 'decision',
  LEARNING: 'learning',
  COLLABORATION: 'collaboration',
  PREFERENCE: 'preference',
};

/**
 * 决策模式枚举
 * @enum {string}
 */
const DECISION_PATTERNS = {
  CONSERVATIVE: 'conservative',
  BALANCED: 'balanced',
  AGGRESSIVE: 'aggressive',
  PRAGMATIC: 'pragmatic',
};

/**
 * 默认配置
 * @type {Object}
 */
const DEFAULT_CONFIG = {
  maxBehaviorRecords: 1000,
  maxPatterns: 200,
  maxPredictions: 100,
  patternConfidenceThreshold: 0.6,
  enableAutoLearning: true,
  learningInterval: 10 * 60 * 1000, // 10分钟
};

/**
 * 决策风格关键词映射
 * @private
 */
const DECISION_KEYWORDS = {
  [DECISION_PATTERNS.CONSERVATIVE]: ['stable', 'safe', 'proven', '保守', '稳定'],
  [DECISION_PATTERNS.AGGRESSIVE]: ['latest', 'cutting-edge', '新', '最新'],
  [DECISION_PATTERNS.PRAGMATIC]: ['simple', 'practical', '简单', '实用'],
};

/**
 * @module runtime/user/digital-twin-engine
 * DigitalTwinEngine — 数字孪生引擎
 * 创建用户行为模式、决策偏好和知识图谱的动态数字孪生体。
 * 将Harness现有的UserModelManager（偏好存储）升级到OpenHuman"数字孪生"级别，
 * 支持行为序列建模和决策预测。
 *
 * @classdesc 数字孪生引擎
 *
 * @extends EventEmitter
 * @emits DigitalTwinEngine#behavior-recorded
 * @emits DigitalTwinEngine#patterns-analyzed
 * @emits DigitalTwinEngine#prediction-made
 *
 * @example
 * const DigitalTwinEngine = require('./digital-twin-engine');
 * const engine = new DigitalTwinEngine({ enableAutoLearning: true });
 *
 * engine.attachUserModelManager(userModelManager);
 * engine.attachKnowledgeGraph(knowledgeGraph);
 *
 * engine.recordBehavior({
 *   type: 'coding',
 *   action: 'wrote-unit-test',
 *   context: { language: 'javascript', framework: 'node' },
 * });
 *
 * const style = engine.getDecisionStyle();
 * const prediction = engine.predictNextAction({ language: 'javascript' });
 * const profile = engine.getTwinProfile();
 *
 * engine.startAutoLearning();
 * // ... later
 * engine.shutdown();
 */
class DigitalTwinEngine extends EventEmitter {
  /**
   * 创建数字孪生引擎实例
   * @param {Object} [options={}] - 配置选项
   * @param {number} [options.maxBehaviorRecords=1000] - 最大行为记录数
   * @param {number} [options.maxPatterns=200] - 最大模式数
   * @param {number} [options.maxPredictions=100] - 最大预测数
   * @param {number} [options.patternConfidenceThreshold=0.6] - 模式置信度阈值
   * @param {boolean} [options.enableAutoLearning=true] - 是否启用自动学习
   * @param {number} [options.learningInterval=600000] - 自动学习间隔（毫秒）
   */
  constructor(options = {}) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);

    // 行为记录，有界映射防止内存溢出
    this._behaviors = new BoundedMap(this._config.maxBehaviorRecords);
    // 已识别的模式
    this._patterns = new BoundedMap(this._config.maxPatterns);
    // 用户数字孪生画像
    this._profile = {
      decisionStyle: null,
      techPreferences: {},
      workPatterns: {},
      learningCurve: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // 统计信息
    this._stats = {
      behaviorsRecorded: 0,
      patternsRecognized: 0,
      predictionsMade: 0,
      autoLearnings: 0,
    };
    // 自动学习定时器
    this._learningTimer = null;
    // 依赖注入标记
    this._attached = {
      userModelManager: false,
      knowledgeGraph: false,
    };
    // 外部依赖实例
    this._umm = null;
    this._kg = null;
  }

  /**
   * 附加UserModelManager实例，用于读取用户偏好数据
   * @param {Object} manager - UserModelManager实例，需提供getPreference方法
   * @returns {DigitalTwinEngine} 返回this以支持链式调用
   * @throws {TypeError} manager缺少getPreference方法时抛出
   */
  attachUserModelManager(manager) {
    this.guardShutdown();
    if (!manager || typeof manager.getPreference !== 'function') {
      throw new TypeError('UserModelManager must have a getPreference method');
    }
    this._umm = manager;
    this._attached.userModelManager = true;
    debug('DigitalTwinEngine', 'attachUserModelManager', 'attached');
    return this;
  }

  /**
   * 附加知识图谱实例，用于语义查询和推理
   * @param {Object} graph - 知识图谱实例，需提供query方法
   * @returns {DigitalTwinEngine} 返回this以支持链式调用
   * @throws {TypeError} graph缺少query方法时抛出
   */
  attachKnowledgeGraph(graph) {
    this.guardShutdown();
    if (!graph || typeof graph.query !== 'function') {
      throw new TypeError('KnowledgeGraph must have a query method');
    }
    this._kg = graph;
    this._attached.knowledgeGraph = true;
    debug('DigitalTwinEngine', 'attachKnowledgeGraph', 'attached');
    return this;
  }

  /**
   * 记录用户行为，存入行为池并触发模式分析
   * @param {Object} behavior - 行为对象
   * @param {string} behavior.type - 行为类型（BEHAVIOR_TYPES枚举值）
   * @param {string} behavior.action - 行为动作描述
   * @param {Object} behavior.context - 行为上下文信息
   * @param {*} [behavior.outcome] - 行为结果
   * @param {number} [behavior.timestamp] - 行为时间戳
   * @returns {Object|null} 记录的行为对象，验证失败返回null
   * @fires DigitalTwinEngine#behavior-recorded
   */
  recordBehavior(behavior) {
    this.guardShutdown();
    if (!behavior || typeof behavior !== 'object') return null;

    // 验证行为类型
    const validTypes = Object.values(BEHAVIOR_TYPES);
    if (!behavior.type || !validTypes.includes(behavior.type)) {
      debug('DigitalTwinEngine', 'recordBehavior', 'invalid type: ' + behavior.type);
      return null;
    }

    // 构建行为记录
    const record = {
      id: generateId(),
      type: behavior.type,
      action: behavior.action || '',
      context: behavior.context ?? {},
      outcome: behavior.outcome,
      timestamp: behavior.timestamp ?? Date.now(),
    };

    // 存入有界映射
    this._behaviors.set(record.id, record);
    this._stats.behaviorsRecorded++;

    // 每10条行为触发一次模式分析
    if (this._config.enableAutoLearning && this._stats.behaviorsRecorded % 10 === 0) {
      safeCall(() => this._analyzePatterns(), 'DigitalTwinEngine', 'auto-analyze');
    }

    /**
     * 行为记录事件
     * @event DigitalTwinEngine#behavior-recorded
     * @type {Object}
     * @property {string} behaviorId - 行为记录ID
     * @property {string} type - 行为类型
     */
    this.emit('behavior-recorded', { behaviorId: record.id, type: record.type });

    return record;
  }

  /**
   * 分析已记录的行为，提取模式并更新用户画像
   * 按行为类型分组统计动作频率，识别高频模式；
   * 对决策行为分析决策风格，对编码行为提取技术偏好，对学习行为追踪学习曲线
   * @private
   * @fires DigitalTwinEngine#patterns-analyzed
   */
  _analyzePatterns() {
    // 按行为类型分组
    const grouped = {};
    for (const [, record] of this._behaviors) {
      if (!grouped[record.type]) grouped[record.type] = [];
      grouped[record.type].push(record);
    }

    // 对每种类型统计动作频率，提取高频模式
    for (const [type, records] of Object.entries(grouped)) {
      const actionCounts = {};
      for (const r of records) {
        const key = r.action;
        actionCounts[key] = (actionCounts[key] ?? 0) + 1;
      }

      // 按频率排序，取高频动作作为模式
      const sorted = Object.entries(actionCounts)
        .sort((a, b) => b[1] - a[1]);

      const total = records.length;
      const patterns = [];
      for (const [action, count] of sorted) {
        const confidence = count / total;
        if (confidence >= this._config.patternConfidenceThreshold) {
          patterns.push({ action, count, confidence });
        }
      }

      // 存储识别出的模式
      const patternId = generateId();
      this._patterns.set(patternId, {
        id: patternId,
        type,
        patterns,
        totalRecords: total,
        analyzedAt: Date.now(),
      });

      // 根据行为类型更新画像不同维度
      if (type === BEHAVIOR_TYPES.DECISION) {
        this._analyzeDecisionStyle(records);
      } else if (type === BEHAVIOR_TYPES.CODING) {
        this._extractTechPreferences(records);
      } else if (type === BEHAVIOR_TYPES.LEARNING) {
        this._trackLearningCurve(records);
      }
    }

    this._stats.patternsRecognized = this._patterns.size;
    this._profile.updatedAt = Date.now();

    /**
     * 模式分析完成事件
     * @event DigitalTwinEngine#patterns-analyzed
     * @type {Object}
     * @property {number} patternCount - 已识别的模式数量
     */
    this.emit('patterns-analyzed', { patternCount: this._patterns.size });
  }

  /**
   * 分析决策行为，确定用户的决策风格
   * 基于上下文关键词匹配DECISION_PATTERNS，取最高频风格
   * @private
   * @param {Array<Object>} records - 决策类型的行为记录
   */
  _analyzeDecisionStyle(records) {
    const styleCounts = {};
    for (const pattern of Object.values(DECISION_PATTERNS)) {
      styleCounts[pattern] = 0;
    }

    for (const record of records) {
      const ctx = record.context;
      if (!ctx) continue;
      // 将上下文值拼接为字符串进行关键词匹配
      const text = Object.values(ctx).filter(v => typeof v === 'string' || typeof v === 'number').join(' ').toLowerCase();
      let matched = false;
      for (const [style, keywords] of Object.entries(DECISION_KEYWORDS)) {
        for (const kw of keywords) {
          if (text.includes(kw.toLowerCase())) {
            styleCounts[style]++;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      // 未匹配任何关键词则归为平衡型
      if (!matched) {
        styleCounts[DECISION_PATTERNS.BALANCED]++;
      }
    }

    // 取最高频风格
    let maxStyle = DECISION_PATTERNS.BALANCED;
    let maxCount = 0;
    for (const [style, count] of Object.entries(styleCounts)) {
      if (count > maxCount) {
        maxCount = count;
        maxStyle = style;
      }
    }
    this._profile.decisionStyle = maxStyle;
  }

  /**
   * 从编码行为中提取技术栈偏好
   * 统计上下文中出现的语言、框架、工具频率
   * @private
   * @param {Array<Object>} records - 编码类型的行为记录
   */
  _extractTechPreferences(records) {
    const techCounts = {};
    for (const record of records) {
      const ctx = record.context;
      if (!ctx) continue;
      // 提取语言、框架、工具等字段
      const techFields = ['language', 'framework', 'tool', 'library', 'runtime'];
      for (const field of techFields) {
        if (ctx[field]) {
          const val = String(ctx[field]).toLowerCase();
          techCounts[val] = (techCounts[val] ?? 0) + 1;
        }
      }
    }
    // 更新技术偏好，保留频次
    this._profile.techPreferences = techCounts;
  }

  /**
   * 追踪学习曲线，记录学习行为的时间序列
   * @private
   * @param {Array<Object>} records - 学习类型的行为记录
   */
  _trackLearningCurve(records) {
    const sorted = records.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const curve = sorted.map((r, idx) => ({
      timestamp: r.timestamp,
      action: r.action,
      progressIndex: idx + 1,
    }));
    const MAX_CURVE_SIZE = 1000;
    this._profile.learningCurve = curve.length > MAX_CURVE_SIZE ? curve.slice(-MAX_CURVE_SIZE) : curve;
  }

  /**
   * 获取用户的决策风格
   * 优先返回已分析的画像，否则实时分析决策行为
   * @returns {string} 决策风格（DECISION_PATTERNS枚举值）
   */
  getDecisionStyle() {
    this.guardShutdown();
    if (this._profile.decisionStyle) {
      return this._profile.decisionStyle;
    }
    // 实时分析决策行为
    const decisionRecords = [];
    for (const [, record] of this._behaviors) {
      if (record.type === BEHAVIOR_TYPES.DECISION) {
        decisionRecords.push(record);
      }
    }
    if (decisionRecords.length === 0) {
      return DECISION_PATTERNS.BALANCED;
    }
    this._analyzeDecisionStyle(decisionRecords);
    return this._profile.decisionStyle || DECISION_PATTERNS.BALANCED;
  }

  /**
   * 获取技术偏好
   * @returns {Object} 技术偏好对象，键为技术名称，值为使用频次
   */
  getTechPreferences() {
    this.guardShutdown();
    return { ...this._profile.techPreferences };
  }

  /**
   * 获取工作模式分析
   * 基于行为时间戳分析活跃时段、平均会话长度和休息间隔
   * @returns {Object} 工作模式分析结果
   * @property {number[]} peakHours - 活跃时段（0-23小时）
   * @property {number} avgSessionLength - 平均会话长度（毫秒）
   * @property {number} preferredBreakInterval - 偏好休息间隔（毫秒）
   */
  getWorkPatterns() {
    this.guardShutdown();
    // 如果已缓存则直接返回
    if (this._profile.workPatterns && Object.keys(this._profile.workPatterns).length > 0) {
      return { ...this._profile.workPatterns };
    }

    // 从行为时间戳分析时段分布
    const hourCounts = new Array(24).fill(0);
    const timestamps = [];
    for (const [, record] of this._behaviors) {
      const tsRaw = safeDateGetTime(record.timestamp);
      const ts = Number.isFinite(tsRaw) ? new Date(tsRaw).getHours() : NaN;
      if (Number.isFinite(ts)) {
        hourCounts[ts]++;
        timestamps.push(record.timestamp);
      }
    }

    // 找出活跃时段（频次超过平均值的时段）
    const avgCount = timestamps.length > 0 ? timestamps.length / 24 : 0;
    const peakHours = [];
    for (let h = 0; h < 24; h++) {
      if (hourCounts[h] > avgCount) peakHours.push(h);
    }

    // 计算平均会话长度和休息间隔
    let avgSessionLength = 0;
    let preferredBreakInterval = 0;
    if (timestamps.length >= 2) {
      const sorted = timestamps.slice().sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push(sorted[i] - sorted[i - 1]);
      }
      if (gaps.length === 0) return { peakHours, avgSessionLength: 0, preferredBreakInterval: 0 };
      // 短间隔视为会话内，长间隔视为会话间
      const medianGap = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      const sessionGaps = gaps.filter(g => g <= medianGap);
      const breakGaps = gaps.filter(g => g > medianGap);
      avgSessionLength = sessionGaps.length > 0
        ? sessionGaps.reduce((s, g) => s + g, 0) / sessionGaps.length
        : 0;
      preferredBreakInterval = breakGaps.length > 0
        ? breakGaps.reduce((s, g) => s + g, 0) / breakGaps.length
        : 0;
    }

    const workPatterns = { peakHours, avgSessionLength, preferredBreakInterval };
    this._profile.workPatterns = workPatterns;
    return { peakHours: peakHours.slice(), avgSessionLength, preferredBreakInterval };
  }

  /**
   * 基于历史行为和已识别模式预测用户下一步动作
   * 在行为池中查找相似上下文，返回最常出现的后续动作
   * @param {Object} context - 当前上下文信息
   * @returns {Object} 预测结果
   * @property {string} id - 预测ID
   * @property {Object} context - 输入上下文
   * @property {string} predictedAction - 预测动作
   * @property {number} confidence - 置信度（0-1）
   * @property {number} basedOnBehaviors - 基于的行为记录数
   * @fires DigitalTwinEngine#prediction-made
   */
  predictNextAction(context) {
    this.guardShutdown();

    if (!context || typeof context !== 'object') {
      return {
        id: generateId(),
        context,
        predictedAction: '',
        confidence: 0,
        basedOnBehaviors: 0,
      };
    }

    // 在行为池中查找相似上下文
    const contextKeys = Object.keys(context);
    const similarActions = [];

    for (const [, record] of this._behaviors) {
      if (!record.context) continue;
      let matchScore = 0;
      for (const key of contextKeys) {
        if (record.context[key] === context[key]) {
          matchScore++;
        } else if (
          typeof record.context[key] === 'string' &&
          typeof context[key] === 'string' &&
          (record.context[key].toLowerCase().includes(context[key].toLowerCase()) ||
           context[key].toLowerCase().includes(record.context[key].toLowerCase()))
        ) {
          matchScore += 0.5;
        }
      }
      // 至少有一个上下文键匹配才纳入统计
      if (matchScore > 0) {
        similarActions.push({ action: record.action, score: matchScore });
      }
    }

    // 统计相似上下文下的动作频率
    const actionScores = {};
    for (const { action, score } of similarActions) {
      actionScores[action] = (actionScores[action] ?? 0) + score;
    }

    // 取得分最高的动作作为预测
    let predictedAction = '';
    let topScore = 0;
    for (const [action, score] of Object.entries(actionScores)) {
      if (score > topScore) {
        topScore = score;
        predictedAction = action;
      }
    }

    // 置信度 = 最高得分 / 总得分，无得分时为0
    const totalScore = Object.values(actionScores).reduce((s, v) => s + v, 0);
    const confidence = totalScore > 0 ? topScore / totalScore : 0;

    const prediction = {
      id: generateId(),
      context,
      predictedAction,
      confidence: Math.min(1, Math.max(0, confidence)),
      basedOnBehaviors: similarActions.length,
    };

    this._stats.predictionsMade++;

    /**
     * 预测完成事件
     * @event DigitalTwinEngine#prediction-made
     * @type {Object}
     * @property {string} predictionId - 预测ID
     * @property {number} confidence - 置信度
     */
    this.emit('prediction-made', {
      predictionId: prediction.id,
      confidence: prediction.confidence,
    });

    return prediction;
  }

  /**
   * 获取完整的数字孪生画像
   * 包含决策风格、技术偏好、工作模式、学习曲线、行为统计和模式数量
   * @returns {Object} 数字孪生画像
   * @property {string} decisionStyle - 决策风格
   * @property {Object} techPreferences - 技术偏好
   * @property {Object} workPatterns - 工作模式
   * @property {Array} learningCurve - 学习曲线
   * @property {Object} behaviorCounts - 各类型行为计数
   * @property {number} patternCount - 模式数量
   * @property {number} lastUpdated - 最后更新时间戳
   */
  getTwinProfile() {
    this.guardShutdown();

    // 统计各类型行为计数
    const behaviorCounts = {};
    for (const type of Object.values(BEHAVIOR_TYPES)) {
      behaviorCounts[type] = 0;
    }
    for (const [, record] of this._behaviors) {
      if (behaviorCounts[record.type] !== undefined) {
        behaviorCounts[record.type]++;
      }
    }

    return {
      decisionStyle: this._profile.decisionStyle,
      techPreferences: { ...this._profile.techPreferences },
      workPatterns: this.getWorkPatterns(),
      learningCurve: this._profile.learningCurve.slice(),
      behaviorCounts,
      patternCount: this._patterns.size,
      lastUpdated: this._profile.updatedAt,
    };
  }

  /**
   * 启动周期性自动学习
   * 按配置的learningInterval定期执行模式分析
   * 重复调用不会创建多个定时器
   */
  startAutoLearning() {
    this.guardShutdown();
    if (this._learningTimer) return;

    this._learningTimer = setInterval(() => {
      try {
        if (this._shutDown) return;
        safeCall(() => this._analyzePatterns(), 'DigitalTwinEngine', 'auto-learning');
        this._stats.autoLearnings++;
      } catch (err) {
        debug('DigitalTwinEngine', 'auto-learning-timer', err && err.message ? err.message : String(err));
      }
    }, typeof this._config.learningInterval === 'number' && Number.isFinite(this._config.learningInterval) && this._config.learningInterval > 0 ? this._config.learningInterval : DEFAULT_CONFIG.learningInterval);

    // 非阻塞定时器，不阻止进程退出
    if (typeof this._learningTimer.unref === 'function') {
      this._learningTimer.unref();
    }

    debug('DigitalTwinEngine', 'startAutoLearning', 'interval=' + this._config.learningInterval);
  }

  /**
   * 停止周期性自动学习
   * 清除定时器并置空引用
   */
  stopAutoLearning() {
    if (this._learningTimer) {
      clearInterval(this._learningTimer);
      this._learningTimer = null;
    }
    debug('DigitalTwinEngine', 'stopAutoLearning', 'stopped');
  }

  /**
   * 获取引擎统计信息
   * @returns {Object} 统计对象
   * @property {number} behaviorsRecorded - 已记录行为数
   * @property {number} patternsRecognized - 已识别模式数
   * @property {number} predictionsMade - 已生成预测数
   * @property {number} autoLearnings - 自动学习次数
   * @property {boolean} hasUserModelManager - 是否附加了UserModelManager
   * @property {boolean} hasKnowledgeGraph - 是否附加了知识图谱
   */
  getStats() {
    return {
      ...this._stats,
      hasUserModelManager: this._attached.userModelManager,
      hasKnowledgeGraph: this._attached.knowledgeGraph,
    };
  }

  /**
   * 优雅关闭，停止自动学习、清理状态
   * @private
   */
  _onShutdown() {
    this.stopAutoLearning();
    safeCall(() => this._behaviors.shutdown(), 'DigitalTwinEngine', 'shutdown-behaviors');
    safeCall(() => this._patterns.shutdown(), 'DigitalTwinEngine', 'shutdown-patterns');
    this._profile = {
      decisionStyle: null,
      techPreferences: {},
      workPatterns: {},
      learningCurve: [],
      createdAt: 0,
      updatedAt: 0,
    };
    this._stats = {
      behaviorsRecorded: 0,
      patternsRecognized: 0,
      predictionsMade: 0,
      autoLearnings: 0,
    };
    this._umm = null;
    this._kg = null;
    this._attached = { userModelManager: false, knowledgeGraph: false };
    this.removeAllListeners();
  }
}

// 静态属性：枚举和默认配置
DigitalTwinEngine.BEHAVIOR_TYPES = BEHAVIOR_TYPES;
DigitalTwinEngine.DECISION_PATTERNS = DECISION_PATTERNS;
DigitalTwinEngine.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(DigitalTwinEngine);
