'use strict';

/** @module runtime/thought/dream-phase-pipeline
 * @classdesc 做梦阶段管道
 * DreamPhasePipeline — OpenClaw 4.5 Dreaming三阶段记忆巩固流水线
 * 借鉴OpenClaw 4.5的三阶段Dreaming架构，实现Light/Deep/REM三阶段流水线，
 * 通过6维加权评分和3个门控阈值实现记忆从短期到长期的晋升。
 * @extends EventEmitter
 * @emits DreamPhasePipeline#phase-complete
 * @emits DreamPhasePipeline#pipeline-complete
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall, roundTo } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { generateId } = require('../../utils/constants');

/** 做梦阶段枚举 */
const DREAM_PHASES = {
  LIGHT: 'light',
  DEEP: 'deep',
  REM: 'rem',
};

/** 候选记忆类别枚举 */
const CANDIDATE_CATEGORIES = {
  PREFERENCE: 'preference',
  FACT: 'fact',
  CORRECTION: 'correction',
  WORKFLOW: 'workflow',
  DECISION: 'decision',
  NOISE: 'noise',
};

/** 6维评分权重（借鉴OpenClaw 4.5） */
const SCORING_WEIGHTS = {
  frequency: 0.24,
  relevance: 0.30,
  queryDiversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  conceptualRichness: 0.06,
};

/** 默认门控阈值配置 */
const DEFAULT_GATE_CONFIG = {
  minScore: 0.5,
  minRecallCount: 2,
  minUniqueQueries: 1,
};

/** 偏好标记词 */
const PREFERENCE_MARKERS = [
  'prefer', 'like', 'want', 'favorite', 'best', 'recommend', 'always use',
  '偏好', '喜欢', '推荐', '首选', '最爱', '建议使用',
];

/** 事实标记词 */
const FACT_MARKERS = [
  'uses', 'runs on', 'built with', 'powered by', 'based on', 'consists of',
  '使用', '运行', '基于', '由...构成', '采用', '项目',
];

/** 纠正标记词 */
const CORRECTION_MARKERS = [
  'error', 'fail', 'bug', 'fix', 'fixed', 'corrected', 'wrong', 'mistake',
  '错误', '失败', '缺陷', '修复', '纠正', '修正',
];

/** 工作流标记词 */
const WORKFLOW_MARKERS = [
  'step', 'phase', 'process', 'workflow', 'pipeline', 'flow', 'procedure',
  '步骤', '阶段', '流程', '管道', '工作流', '过程',
];

/** 决策标记词 */
const DECISION_MARKERS = [
  'decided', 'decision', 'chose', 'chosen', 'adopted', 'selected', 'approved',
  '决定', '选择', '采纳', '选定', '批准', '决议',
];

/** 噪音标记词（无法归类时降级为噪音） */
const NOISE_MARKERS = [
  'hello', 'hi', 'ok', 'thanks', 'bye', 'random', 'test message',
  '你好', '谢谢', '再见', '随便', '测试消息',
];

/** 半衰期天数（时间衰减） */
const HALF_LIFE_DAYS = 7;

/** 每日毫秒数 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 最大候选记忆数 */
const MAX_CANDIDATES = 500;

/** 最大主题数 */
const MAX_THEMES = 50;

/** 最大反思数 */
const MAX_REFLECTIONS = 20;

/** 相似度阈值（冲突检测） */
const CONFLICT_SIMILARITY_THRESHOLD = 0.6;

/** 主题关键词最小共现次数 */
const MIN_THEME_CO_OCCURRENCE = 2;

/**
 * DreamPhasePipeline — 三阶段记忆巩固流水线
 * Light Sleep: 扫描近期会话，标记候选记忆
 * Deep Sleep: 6维加权评分 + 3门控阈值过滤
 * REM Sleep: 提取主题和反思信号
 */
class DreamPhasePipeline extends EventEmitter {
  /**
   * 创建三阶段流水线实例
   * @param {object} [options] - 配置选项
   * @param {object} [options.gateConfig] - 门控阈值配置
   * @param {number} [options.gateConfig.minScore] - 最低综合评分
   * @param {number} [options.gateConfig.minRecallCount] - 最低被召回次数
   * @param {number} [options.gateConfig.minUniqueQueries] - 最低不同查询数
   */
  constructor(options) {
    super();
    this._gateConfig = { ...DEFAULT_GATE_CONFIG };
    if (options && options.gateConfig) {
      for (const key of Object.keys(DEFAULT_GATE_CONFIG)) {
        if (options.gateConfig[key] !== undefined) {
          this._gateConfig[key] = options.gateConfig[key];
        }
      }
    }
    this._stats = {
      lightExecutions: 0,
      deepExecutions: 0,
      remExecutions: 0,
      totalCandidates: 0,
      totalPromoted: 0,
      totalRejected: 0,
      totalThemes: 0,
    };
    this._recentCandidates = new BoundedArray(MAX_CANDIDATES);
  }

  /**
   * Light Sleep阶段 — 扫描近期会话，标记候选记忆
   * @param {Array<object>} sessionHistory - 历史会话数组
   * @returns {{ candidates: Array<object>, phase: string, timestamp: string }} 候选记忆列表
   */
  executeLightPhase(sessionHistory) {
    this.guardShutdown();
    this._stats.lightExecutions++;
    const timestamp = new Date().toISOString();
    const candidates = [];

    if (!Array.isArray(sessionHistory) || sessionHistory.length === 0) {
      return { candidates, phase: DREAM_PHASES.LIGHT, timestamp };
    }

    const textBuffer = new BoundedArray(MAX_CANDIDATES);

    for (const session of sessionHistory) {
      if (!session || typeof session !== 'object') continue;
      this._extractSessionTexts(session, textBuffer);
    }

    const seen = new BoundedMap(MAX_CANDIDATES);
    for (let i = 0; i < textBuffer.length; i++) {
      const item = textBuffer.get(i);
      if (!item || !item.text || item.text.trim().length < 5) continue;

      const normalizedKey = this._normalizeText(item.text);
      if (!normalizedKey || seen.has(normalizedKey)) continue;

      const category = this._classifyCategory(item.text, item.source);
      const signals = this._computeInitialSignals(item, sessionHistory);
      const candidate = {
        id: generateId('dpc-'),
        category,
        content: item.text.slice(0, 500),
        signals,
        sourceSessions: item.sessionIds ?? [],
        createdAt: timestamp,
      };

      seen.set(normalizedKey, true);
      candidates.push(candidate);
      this._recentCandidates.push(candidate);
    }

    this._stats.totalCandidates += candidates.length;
    this.emit('phase-complete', { phase: DREAM_PHASES.LIGHT, candidateCount: candidates.length, timestamp });
    return { candidates, phase: DREAM_PHASES.LIGHT, timestamp };
  }

  /**
   * Deep Sleep阶段 — 6维加权评分 + 3门控阈值过滤
   * @param {Array<object>} candidates - Light阶段产出的候选记忆
   * @param {Array<object>} existingNotes - 已有长期记忆笔记
   * @returns {{ promoted: Array, rejected: Array, updated: Array, phase: string, timestamp: string }} 晋升/拒绝/更新结果
   */
  executeDeepPhase(candidates, existingNotes) {
    this.guardShutdown();
    this._stats.deepExecutions++;
    const timestamp = new Date().toISOString();
    const promoted = [];
    const rejected = [];
    const updated = [];

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { promoted, rejected, updated, phase: DREAM_PHASES.DEEP, timestamp };
    }

    const notes = Array.isArray(existingNotes) ? existingNotes : [];

    for (const candidate of candidates) {
      if (!candidate || !candidate.signals) continue;

      /* 噪音类别永远不晋升 */
      if (candidate.category === CANDIDATE_CATEGORIES.NOISE) {
        rejected.push({ ...candidate, rejectReason: 'noise_category' });
        continue;
      }

      const score = this._computeWeightedScore(candidate.signals);
      const passes = this._passesGateControls(score, candidate);

      if (!passes) {
        rejected.push({ ...candidate, score, rejectReason: 'gate_failed' });
        continue;
      }

      const conflicts = this._findConflicts(candidate, notes);
      if (conflicts.length > 0) {
        const merged = this._mergeWithConflict(candidate, conflicts[0], score);
        updated.push(merged);
      } else {
        promoted.push({
          ...candidate,
          score: roundTo(score, 4),
          promotedAt: timestamp,
        });
      }
    }

    this._stats.totalPromoted += promoted.length;
    this._stats.totalRejected += rejected.length;
    this.emit('phase-complete', { phase: DREAM_PHASES.DEEP, promoted: promoted.length, rejected: rejected.length, updated: updated.length, timestamp });
    return { promoted, rejected, updated, phase: DREAM_PHASES.DEEP, timestamp };
  }

  /**
   * REM Sleep阶段 — 提取主题和反思信号
   * @param {Array<object>} promoted - Deep阶段晋升的记忆
   * @param {Array<object>} allNotes - 所有长期记忆笔记
   * @returns {{ themes: Array, reflections: Array, phase: string, timestamp: string }} 主题和反思结果
   */
  executeRemPhase(promoted, allNotes) {
    this.guardShutdown();
    this._stats.remExecutions++;
    const timestamp = new Date().toISOString();

    const prom = Array.isArray(promoted) ? promoted : [];
    const notes = Array.isArray(allNotes) ? allNotes : [];

    if (prom.length === 0 && notes.length === 0) {
      return { themes: [], reflections: [], phase: DREAM_PHASES.REM, timestamp };
    }

    const combined = [...prom, ...notes];
    const themes = this._extractThemes(combined);
    const reflections = this._generateReflections(prom, themes);

    this._stats.totalThemes += themes.length;
    this.emit('phase-complete', { phase: DREAM_PHASES.REM, themes: themes.length, reflections: reflections.length, timestamp });
    return { themes, reflections, phase: DREAM_PHASES.REM, timestamp };
  }

  /**
   * 执行完整流水线 Light -> Deep -> REM
   * @param {Array<object>} sessionHistory - 历史会话数组
   * @param {Array<object>} existingNotes - 已有长期记忆笔记
   * @returns {{ light: object, deep: object, rem: object }} 完整流水线结果
   */
  executePipeline(sessionHistory, existingNotes) {
    this.guardShutdown();

    const light = this.executeLightPhase(sessionHistory);
    const deep = this.executeDeepPhase(light.candidates, existingNotes);
    const rem = this.executeRemPhase(deep.promoted, existingNotes);

    const result = { light, deep, rem };
    this.emit('pipeline-complete', result);
    return result;
  }

  /**
   * 计算6维加权评分
   * @param {object} signals - 6维信号对象
   * @returns {number} 加权评分（0-1）
   */
  _computeWeightedScore(signals) {
    if (!signals) return 0;
    const s = signals;
    const raw =
      (s.frequency ?? 0) * SCORING_WEIGHTS.frequency +
      (s.relevance ?? 0) * SCORING_WEIGHTS.relevance +
      (s.queryDiversity ?? 0) * SCORING_WEIGHTS.queryDiversity +
      (s.recency ?? 0) * SCORING_WEIGHTS.recency +
      (s.consolidation ?? 0) * SCORING_WEIGHTS.consolidation +
      (s.conceptualRichness ?? 0) * SCORING_WEIGHTS.conceptualRichness;
    return roundTo(Math.min(1, Math.max(0, raw)), 4);
  }

  /**
   * 检查是否通过3个门控阈值
   * @param {number} score - 加权评分
   * @param {object} candidate - 候选记忆
   * @returns {boolean} 是否通过
   */
  _passesGateControls(score, candidate) {
    if (score < this._gateConfig.minScore) return false;
    const recallCount = (candidate.sourceSessions && candidate.sourceSessions.length) ?? 0;
    if (recallCount < this._gateConfig.minRecallCount) return false;
    const uniqueQueries = candidate.signals?.queryDiversity ?? 0;
    if (uniqueQueries < this._gateConfig.minUniqueQueries) return false;
    return true;
  }

  /**
   * 计算时间衰减评分（半衰期7天）
   * @param {string} createdAt - ISO时间字符串
   * @returns {number} 新鲜度评分（0-1）
   */
  _computeRecencyScore(createdAt) {
    if (!createdAt) return 0.5;
    let createdMs;
    try {
      createdMs = new Date(createdAt).getTime();
    } catch (_e) {
      return 0.5;
    }
    if (!Number.isFinite(createdMs)) return 0.5;
    const nowMs = Date.now();
    const ageDays = Math.max(0, (nowMs - createdMs) / MS_PER_DAY);
    const halfLife = HALF_LIFE_DAYS;
    return roundTo(Math.pow(0.5, ageDays / halfLife), 4);
  }

  /**
   * 提取概念标签
   * @param {string} content - 文本内容
   * @returns {Array<string>} 概念标签数组
   */
  _extractConceptTags(content) {
    if (!content || typeof content !== 'string') return [];
    const normalized = content.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = normalized.split(/\s+/).filter(w => w.length > 2);
    const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'this', 'that', 'with', 'from', 'they', 'been', 'said', 'each', 'which', 'their', 'will', 'other', 'about', 'many', 'then', 'them', 'these', 'some', 'would', 'make', 'like', 'into', 'time', 'very', 'when', 'come', 'could', 'more', 'over', 'such', 'after']);
    const tags = [];
    for (const w of words) {
      if (!stopWords.has(w) && w.length > 2) {
        tags.push(w);
      }
    }
    return [...new Set(tags)].slice(0, 10);
  }

  /**
   * 查找与已有笔记的冲突
   * @param {object} candidate - 候选记忆
   * @param {Array<object>} existingNotes - 已有笔记
   * @returns {Array<object>} 冲突笔记列表
   */
  _findConflicts(candidate, existingNotes) {
    if (!candidate || !Array.isArray(existingNotes)) return [];
    const conflicts = [];
    for (const note of existingNotes) {
      if (!note) continue;
      if (note.category && candidate.category && note.category !== candidate.category) continue;
      const sim = this._computeTextSimilarity(candidate.content || '', note.content || '');
      if (sim >= CONFLICT_SIMILARITY_THRESHOLD) {
        conflicts.push(note);
      }
    }
    return conflicts;
  }

  /**
   * 提取主题（基于关键词共现）
   * @param {Array<object>} notes - 笔记数组
   * @returns {Array<{name: string, noteIds: Array<string>, strength: number}>} 主题列表
   */
  _extractThemes(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return [];

    /* 构建每条笔记的关键词集合 */
    const noteKeywords = [];
    for (const note of notes) {
      if (!note || !note.content) continue;
      const tags = this._extractConceptTags(note.content);
      noteKeywords.push({ id: note.id, tags: new Set(tags) });
    }

    /* 计算关键词共现矩阵 */
    const coOccurrence = new Map();
    for (let i = 0; i < noteKeywords.length; i++) {
      for (let j = i + 1; j < noteKeywords.length; j++) {
        const common = [];
        for (const t of noteKeywords[i].tags) {
          if (noteKeywords[j].tags.has(t)) common.push(t);
        }
        if (common.length >= MIN_THEME_CO_OCCURRENCE) {
          const key = common.sort().join('|');
          if (!coOccurrence.has(key)) {
            coOccurrence.set(key, { keywords: common, noteIds: [], count: 0 });
          }
          const entry = coOccurrence.get(key);
          if (!entry.noteIds.includes(noteKeywords[i].id)) entry.noteIds.push(noteKeywords[i].id);
          if (!entry.noteIds.includes(noteKeywords[j].id)) entry.noteIds.push(noteKeywords[j].id);
          entry.count++;
        }
      }
    }

    const themes = [];
    for (const [, entry] of coOccurrence) {
      if (entry.count >= MIN_THEME_CO_OCCURRENCE) {
        themes.push({
          name: entry.keywords.slice(0, 3).join(' / '),
          noteIds: entry.noteIds,
          strength: roundTo(Math.min(1, entry.count / 5), 3),
        });
      }
      if (themes.length >= MAX_THEMES) break;
    }

    themes.sort((a, b) => b.strength - a.strength);
    return themes;
  }

  /**
   * 从会话中提取文本条目
   * @param {object} session - 会话对象
   * @param {BoundedArray} buffer - 文本缓冲区
   * @private
   */
  _extractSessionTexts(session, buffer) {
    const sessionId = session.sessionId || session.id || '';
    const addText = (text, source) => {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      if (trimmed.length < 5) return;
      buffer.push({ text: trimmed, source, sessionIds: [sessionId] });
    };

    this._extractArrayField(session.errors, 'errors', addText);
    this._extractArrayField(session.lessonsLearned, 'lessonsLearned', addText);
    this._extractArrayField(session.keyDecisions, 'keyDecisions', addText);

    if (Array.isArray(session.completedSkills)) {
      addText('completed skills: ' + session.completedSkills.join(', '), 'completedSkills');
    }
    if (typeof session.output === 'string' && session.output.trim().length > 5) {
      const lines = session.output.split('\n').filter(l => l.trim().length > 5);
      for (const line of lines) {
        addText(line.trim(), 'output');
      }
    }
    this._extractArrayField(session.artifacts, 'artifacts', addText);
  }

  /**
   * Extract text items from an array field and add them to the buffer.
   * @param {*} field - The field value (expected to be an array)
   * @param {string} source - Source label for the extracted items
   * @param {Function} addText - Callback to add text to the buffer
   * @private
   */
  _extractArrayField(field, source, addText) {
    if (!Array.isArray(field)) return;
    for (const item of field) {
      const text = typeof item === 'string'
        ? item
        : (item && (item.message || item.text || item.content || String(item)));
      addText(text, source);
    }
  }

  /**
   * 根据标记词分类候选记忆类别
   * @param {string} text - 文本内容
   * @param {string} source - 来源字段名
   * @returns {string} CANDIDATE_CATEGORIES中的类别
   * @private
   */
  _classifyCategory(text, source) {
    if (!text || typeof text !== 'string') return CANDIDATE_CATEGORIES.NOISE;
    const lower = text.toLowerCase();

    /* 优先根据来源字段推断 */
    if (source === 'keyDecisions') return CANDIDATE_CATEGORIES.DECISION;
    if (source === 'errors') return CANDIDATE_CATEGORIES.CORRECTION;

    /* 根据标记词分类 */
    if (this._matchesMarkers(lower, DECISION_MARKERS)) return CANDIDATE_CATEGORIES.DECISION;
    if (this._matchesMarkers(lower, PREFERENCE_MARKERS)) return CANDIDATE_CATEGORIES.PREFERENCE;
    if (this._matchesMarkers(lower, CORRECTION_MARKERS)) return CANDIDATE_CATEGORIES.CORRECTION;
    if (this._matchesMarkers(lower, WORKFLOW_MARKERS)) return CANDIDATE_CATEGORIES.WORKFLOW;
    if (this._matchesMarkers(lower, FACT_MARKERS)) return CANDIDATE_CATEGORIES.FACT;

    /* 无法归类时降级为噪音 */
    if (this._matchesMarkers(lower, NOISE_MARKERS)) return CANDIDATE_CATEGORIES.NOISE;
    return CANDIDATE_CATEGORIES.NOISE;
  }

  /**
   * 计算候选记忆的初始信号
   * @param {object} item - 文本条目
   * @param {Array<object>} sessionHistory - 会话历史
   * @returns {object} 6维信号对象
   * @private
   */
  _computeInitialSignals(item, sessionHistory) {
    const text = item.text || '';
    const sessionCount = Array.isArray(sessionHistory) ? sessionHistory.length : 1;

    /* frequency: 在会话中出现的频率（归一化到0-1） */
    let freq = 0;
    if (Array.isArray(sessionHistory)) {
      let occurrences = 0;
      const normText = this._normalizeText(text);
      for (const session of sessionHistory) {
        if (!session) continue;
        const sessionTexts = this._getAllSessionText(session);
        for (const st of sessionTexts) {
          if (this._normalizeText(st).includes(normText.slice(0, 30))) {
            occurrences++;
            break;
          }
        }
      }
      freq = sessionCount > 0 ? Math.min(1, occurrences / sessionCount) : 0;
    }

    /* relevance: 基于文本长度和内容丰富度的初始估计 */
    const relevance = roundTo(Math.min(1, text.length / 200), 3);

    /* queryDiversity: 基于候选记忆在不同会话上下文中出现的次数归一化 */
    let uniqueSourceCount = 1;
    if (Array.isArray(sessionHistory) && sessionHistory.length > 0) {
      const normText = this._normalizeText(text);
      const sourceSessions = new Set();
      for (const session of sessionHistory) {
        if (!session) continue;
        const sessionTexts = this._getAllSessionText(session);
        for (const st of sessionTexts) {
          if (this._normalizeText(st).includes(normText.slice(0, 30))) {
            sourceSessions.add(session.sessionId || session.id || '');
            break;
          }
        }
      }
      uniqueSourceCount = sourceSessions.size || 1;
    }
    const queryDiversity = roundTo(Math.min(1, uniqueSourceCount / 5), 3);

    /* recency: 当前时间的新鲜度 */
    const recency = 1.0;

    /* consolidation: 初始为0，需要多日复发才能增长 */
    const consolidation = 0;

    /* conceptualRichness: 概念标签密度 */
    const tags = this._extractConceptTags(text);
    const conceptualRichness = roundTo(Math.min(1, tags.length / 8), 3);

    return {
      frequency: roundTo(freq, 3),
      relevance,
      queryDiversity,
      recency,
      consolidation,
      conceptualRichness,
    };
  }

  /**
   * 获取会话中所有文本内容
   * @param {object} session - 会话对象
   * @returns {Array<string>} 文本数组
   * @private
   */
  _getAllSessionText(session) {
    const texts = [];
    const collect = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        texts.push(typeof item === 'string' ? item : String(item));
      }
    };
    collect(session.errors);
    collect(session.lessonsLearned);
    collect(session.keyDecisions);
    collect(session.completedSkills);
    if (typeof session.output === 'string') texts.push(session.output);
    collect(session.artifacts);
    return texts;
  }

  /**
   * 检查文本是否匹配标记词列表
   * @param {string} lowerText - 小写文本
   * @param {Array<string>} markers - 标记词列表
   * @returns {boolean} 是否匹配
   * @private
   */
  _matchesMarkers(lowerText, markers) {
    for (const marker of markers) {
      if (lowerText.includes(marker)) return true;
    }
    return false;
  }

  /**
   * 规范化文本用于去重
   * @param {string} text - 原始文本
   * @returns {string} 规范化后的文本
   * @private
   */
  _normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  /**
   * 计算两段文本的相似度（Jaccard + 编辑距离混合）
   * @param {string} a - 文本A
   * @param {string} b - 文本B
   * @returns {number} 相似度（0-1）
   * @private
   */
  _computeTextSimilarity(a, b) {
    if (!a || !b) return 0;
    const normA = this._normalizeText(a);
    const normB = this._normalizeText(b);
    if (normA === normB) return 1.0;

    const wordsA = new Set(normA.split(/\s+/));
    const wordsB = new Set(normB.split(/\s+/));
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    return jaccard;
  }

  /**
   * 将候选记忆与冲突笔记合并
   * @param {object} candidate - 候选记忆
   * @param {object} conflict - 冲突笔记
   * @param {number} score - 候选记忆评分
   * @returns {object} 合并后的笔记
   * @private
   */
  _mergeWithConflict(candidate, conflict, score) {
    return {
      id: conflict.id || candidate.id,
      category: candidate.category,
      content: candidate.content,
      score: roundTo(Math.max(score, conflict.confidence ?? conflict.score ?? 0), 4),
      sourceSessions: Array.from(new Set([
        ...(candidate.sourceSessions ?? []),
        ...(conflict.source_sessions ?? conflict.sourceSessions ?? []),
      ])),
      mergedFrom: conflict.id,
      mergedAt: new Date().toISOString(),
    };
  }

  /**
   * 从晋升记忆和主题中生成反思信号
   * @param {Array<object>} promoted - 晋升的记忆
   * @param {Array<object>} themes - 提取的主题
   * @returns {Array<object>} 反思信号数组
   * @private
   */
  _generateReflections(promoted, themes) {
    const reflections = [];

    /* 基于主题生成反思 */
    for (const theme of themes) {
      if (theme.noteIds && theme.noteIds.length >= 2) {
        reflections.push({
          type: 'cross_pattern',
          theme: theme.name,
          relatedNotes: theme.noteIds,
          insight: 'Multiple memories share the theme: ' + theme.name,
          strength: theme.strength,
        });
      }
      if (reflections.length >= MAX_REFLECTIONS) break;
    }

    /* 基于类别分布生成反思 */
    const categoryCounts = {};
    for (const p of promoted) {
      if (p && p.category) {
        categoryCounts[p.category] = (categoryCounts[p.category] ?? 0) + 1;
      }
    }
    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
    if (topCategory && topCategory[1] >= 2) {
      reflections.push({
        type: 'category_dominance',
        category: topCategory[0],
        count: topCategory[1],
        insight: 'Dominant memory category: ' + topCategory[0] + ' (' + topCategory[1] + ' memories)',
        strength: roundTo(Math.min(1, topCategory[1] / 5), 3),
      });
    }

    return reflections.slice(0, MAX_REFLECTIONS);
  }

  /**
   * 获取流水线统计信息
   * @returns {object} 统计对象
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { lightExecutions: 0, deepExecutions: 0, remExecutions: 0, totalCandidates: 0, totalPromoted: 0, totalRejected: 0, totalThemes: 0 };
    }
    return { ...this._stats };
  }

  _onShutdown() {
    safeCall(() => this._recentCandidates.shutdown(), 'DreamPhasePipeline', 'shutdown-recentCandidates');
    this._recentCandidates = null;
    this._stats = { lightExecutions: 0, deepExecutions: 0, remExecutions: 0, totalCandidates: 0, totalPromoted: 0, totalRejected: 0, totalThemes: 0 };
    this.removeAllListeners();
  }

  /**
   * 检查流水线是否健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown;
  }
}

DreamPhasePipeline.DREAM_PHASES = DREAM_PHASES;
DreamPhasePipeline.CANDIDATE_CATEGORIES = CANDIDATE_CATEGORIES;
DreamPhasePipeline.SCORING_WEIGHTS = SCORING_WEIGHTS;
DreamPhasePipeline.DEFAULT_GATE_CONFIG = DEFAULT_GATE_CONFIG;

module.exports = withShutdown(DreamPhasePipeline);
