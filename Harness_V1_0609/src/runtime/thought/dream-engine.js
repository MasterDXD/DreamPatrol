'use strict';

const { EventEmitter } = require('events');
const { generateId } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { safeCall, roundTo } = require('../../utils/safe-execute');
const { withShutdown } = require('../../utils/shutdown-mixin');
const DreamPhasePipeline = require('./dream-phase-pipeline');

const DEFAULT_CONFIG = {
  maxNotes: 500,
  maxSessionsPerDream: 20,
  similarityThreshold: 0.75,
  minPatternFrequency: 2,
  minConfidence: 0.6,
};

const NOTE_CATEGORIES = {
  ERROR_AVOIDANCE: 'error-avoidance',
  BEST_PRACTICE: 'best-practice',
  WORKFLOW_OPTIMIZATION: 'workflow-optimization',
};

const PATTERN_TYPES = {
  ERROR_PATTERNS: 'error_patterns',
  SUCCESS_PATTERNS: 'success_patterns',
  WORKFLOW_PATTERNS: 'workflow_patterns',
};

const ERROR_MARKERS = [
  'error', 'fail', 'bug', 'crash', 'exception', 'timeout', 'refused',
  '错误', '失败', '缺陷', '崩溃', '异常', '超时', '拒绝',
];

const SUCCESS_MARKERS = [
  'success', 'completed', 'resolved', 'fixed', 'optimized', 'passed',
  '成功', '完成', '解决', '修复', '优化', '通过',
];

const WORKFLOW_MARKERS = [
  'step', 'phase', 'process', 'workflow', 'pipeline', 'flow',
  '步骤', '阶段', '流程', '管道', '工作流',
];

const MAX_COMPARE_LENGTH = 500;

/**
 * @module runtime/thought/dream-engine
 * @classdesc 做梦引擎。离线经验提炼、模式发现、知识整合
 * DreamEngine — Offline experience refinement and pattern discovery engine
 * Processes historical session data to extract error-avoidance, best-practice, and
 * workflow-optimization notes. Supports note merging by similarity and persistent storage.
 * @extends EventEmitter
 * @emits DreamEngine#dream-started
 * @emits DreamEngine#dream-completed
 * @emits DreamEngine#note-created
 * @emits DreamEngine#note-merged
 */
class DreamEngine extends EventEmitter {
  /**
   * 创建DreamEngine实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxNotes=500] - 最大笔记数量
   * @param {number} [options.maxSessionsPerDream=20] - 每次做梦最大处理会话数
   * @param {number} [options.similarityThreshold=0.75] - 相似度阈值
   * @param {number} [options.minPatternFrequency=2] - 最小模式频率
   * @param {number} [options.minConfidence=0.6] - 最小置信度
   * @param {Object} [options.phasePipeline] - 阶段管道配置
   */
  constructor(options) {
    super();
    this._config = { ...DEFAULT_CONFIG };
    if (options) {
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (options[key] !== undefined) {
          this._config[key] = options[key];
        }
      }
    }
    this._notes = new Map();
    this._sqliteStore = null;
    this._thoughtMemoryStore = null;
    this._embeddingService = null;
    this._dreaming = false;
    this._brainMemory = null;
    this._memoryStore = null;
    this._dreamCount = 0;
    this._phasePipeline = new DreamPhasePipeline(options && options.phasePipeline);
    this._stats = {
      totalDreams: 0,
      sessionsProcessed: 0,
      patternsFound: 0,
      notesCreated: 0,
      notesMerged: 0,
      errors: 0,
    };
  }

  /**
   * 附加SQLite存储实例，并从持久化存储中恢复已有笔记
   * @param {object|null} sqliteStore - SQLite存储实例，需提供query和upsert方法
   * @returns {void}
   */
  attachSqliteStore(sqliteStore) {
    this.guardShutdown();
    this._sqliteStore = sqliteStore ?? null;
    if (this._sqliteStore) {
      this._restoreFromSqlite();
    }
  }

  /**
   * 附加思维记忆存储实例，用于在检索相关笔记时搜索历史思维链
   * @param {object|null} thoughtMemoryStore - 思维记忆存储实例，需提供search方法
   * @returns {void}
   */
  attachThoughtMemoryStore(thoughtMemoryStore) {
    this.guardShutdown();
    this._thoughtMemoryStore = thoughtMemoryStore ?? null;
  }

  /**
   * 附加嵌入服务实例，用于计算语义相似度分数
   * @param {object|null} embeddingService - 嵌入服务实例，需提供embed和cosineSimilarity方法
   * @returns {void}
   */
  attachEmbeddingService(embeddingService) {
    this.guardShutdown();
    this._embeddingService = embeddingService ?? null;
  }

  /**
   * 附加脑记忆实例，用于将笔记同步到分层记忆架构
   * @param {object|null} brainMemory - 脑记忆实例，需提供store方法
   * @returns {void}
   */
  attachBrainMemory(brainMemory) {
    this.guardShutdown();
    this._brainMemory = brainMemory ?? null;
  }

  /**
   * 附加记忆存储实例，用于将笔记同步到长期知识库
   * @param {object|null} memoryStore - 记忆存储实例，需提供addKnowledge方法
   * @returns {void}
   */
  attachMemoryStore(memoryStore) {
    this.guardShutdown();
    this._memoryStore = memoryStore ?? null;
  }

  /**
   * 启动做梦流程，分析历史会话数据以提取错误规避、最佳实践和工作流优化笔记
   * @param {Array<object>} sessionHistory - 历史会话数组，每个会话可包含errors、lessonsLearned、keyDecisions、completedSkills、output、artifacts字段
   * @returns {Promise<object|null>} 做梦结果对象，包含dreamId、sessionsAnalyzed、patternsFound、notesCreated、notesMerged、notesAdded、totalNotes、dreamedAt；若正在做梦或输入为空则返回null
   * @throws {Error} When sessionData is invalid or not an object
   */
  async startDreaming(sessionHistory) {
    this.guardShutdown();
    if (this._dreaming) {
      debug('DreamEngine', 'startDreaming', 'already dreaming');
      return null;
    }
    if (!Array.isArray(sessionHistory) || sessionHistory.length === 0) {
      debug('DreamEngine', 'startDreaming', 'empty session history');
      return null;
    }

    this._dreaming = true;
    this._dreamCount++;
    this._stats.totalDreams++;

    try {
      const sessions = sessionHistory.slice(0, this._config.maxSessionsPerDream);
      this._stats.sessionsProcessed += sessions.length;

      const patterns = this._analyzePatterns(sessions);
      this._stats.patternsFound += patterns.error_patterns.length +
        patterns.success_patterns.length + patterns.workflow_patterns.length;

      const newNotes = this._extractNotes(patterns);
      const mergeResult = this._mergeWithExistingNotes(newNotes);
      this._persistToSqlite();

      const result = {
        dreamId: generateId('drm-'),
        sessionsAnalyzed: sessions.length,
        patternsFound: patterns,
        notesCreated: newNotes.length,
        notesMerged: mergeResult.merged,
        notesAdded: mergeResult.added,
        totalNotes: this._notes.size,
        dreamedAt: new Date().toISOString(),
      };

      this._dreaming = false;
      if (this._brainMemory || this._memoryStore) {
        const syncResult = this.syncNotesToStores();
        result.notesSynced = syncResult.synced;
        result.syncErrors = syncResult.errors;
      }
      this.emit('dream-complete', result);
      return result;
    } catch (err) {
      this._dreaming = false;
      this._stats.errors++;
      debug('DreamEngine', 'startDreaming', err);
      this.emit('dream-error', { error: err && err.message ? err.message : String(err), dreamCount: this._dreamCount });
      return null;
    }
  }

  /**
   * 使用三阶段流水线（Light/Deep/REM）启动做梦流程
   * @param {Array<object>} sessionHistory - 历史会话数组
   * @returns {Promise<object|null>} 三阶段流水线结果对象；若正在做梦或输入为空则返回null
   */
  async startDreamingWithPhases(sessionHistory) {
    this.guardShutdown();
    if (this._dreaming) {
      debug('DreamEngine', 'startDreamingWithPhases', 'already dreaming');
      return null;
    }
    if (!Array.isArray(sessionHistory) || sessionHistory.length === 0) {
      debug('DreamEngine', 'startDreamingWithPhases', 'empty session history');
      return null;
    }

    this._dreaming = true;
    this._dreamCount++;
    this._stats.totalDreams++;

    try {
      const existingNotes = this.getNotes();
      const result = this._phasePipeline.executePipeline(sessionHistory, existingNotes);

      this._processPromotedNotes(result);
      this._processUpdatedNotes(result);

      this._persistToSqlite();
      this._trimNotes();

      /* 同步到BrainMemory/MemoryStore */
      if (this._brainMemory || this._memoryStore) {
        const syncResult = this.syncNotesToStores();
        result.notesSynced = syncResult.synced;
        result.syncErrors = syncResult.errors;
      }

      this._dreaming = false;
      this.emit('dream-with-phases-complete', result);
      return result;
    } catch (err) {
      this._dreaming = false;
      this._stats.errors++;
      debug('DreamEngine', 'startDreamingWithPhases', err);
      this.emit('dream-error', { error: err && err.message ? err.message : String(err), dreamCount: this._dreamCount });
      return null;
    }
  }

  /**
   * Write promoted memories from the pipeline result into this._notes.
   * @param {Object} result - Pipeline execution result
   * @private
   */
  _processPromotedNotes(result) {
    for (const promoted of result.deep.promoted) {
      const note = {
        id: promoted.id || generateId('dnote-'),
        category: promoted.category,
        content: promoted.content,
        confidence: promoted.score ?? 0.5,
        source_sessions: promoted.sourceSessions ?? [],
        created_at: promoted.promotedAt || new Date().toISOString(),
        source: 'dream-phase-pipeline',
      };
      this._notes.set(note.id, note);
      this._stats.notesCreated++;
    }
  }

  /**
   * Process updated memories from the pipeline result.
   * Merges updated content into existing notes in this._notes.
   * @param {Object} result - Pipeline execution result
   * @private
   */
  _processUpdatedNotes(result) {
    for (const updated of result.deep.updated) {
      if (updated && updated.id) {
        const existing = this._notes.get(updated.id);
        if (existing) {
          existing.content = updated.content;
          existing.confidence = updated.score || existing.confidence;
          existing.updated_at = updated.mergedAt || new Date().toISOString();
          existing.merge_count = (existing.merge_count ?? 0) + 1;
          this._stats.notesMerged++;
        }
      }
    }
  }

  /**
   * 附加自定义的三阶段流水线实例
   * @param {object|null} phasePipeline - DreamPhasePipeline实例
   * @returns {void}
   */
  attachPhasePipeline(phasePipeline) {
    this.guardShutdown();
    this._phasePipeline = phasePipeline ?? null;
  }

  _analyzePatterns(sessions) {
    const errorPatterns = new Map();
    const successPatterns = new Map();
    const workflowPatterns = new Map();

    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;

      this._extractErrorPatterns(session, errorPatterns);
      this._extractSuccessPatterns(session, successPatterns);
      this._extractWorkflowPatterns(session, workflowPatterns);
    }

    return {
      error_patterns: this._filterPatterns(errorPatterns),
      success_patterns: this._filterPatterns(successPatterns),
      workflow_patterns: this._filterPatterns(workflowPatterns),
    };
  }

  _extractErrorPatterns(session, patternMap) {
    const errors = this._collectFromSession(session, ERROR_MARKERS);
    for (const err of errors) {
      const key = this._normalizePattern(err.text);
      if (!key) continue;
      if (!patternMap.has(key)) {
        patternMap.set(key, {
          pattern: key,
          frequency: 0,
          confidence: 0,
          examples: [],
          solutions: [],
        });
      }
      const entry = patternMap.get(key);
      entry.frequency++;
      if (entry.examples.length < 5) {
        entry.examples.push({
          sessionId: session.sessionId || session.id || '',
          text: err.text.slice(0, 200),
        });
      }
      if (err.resolution && entry.solutions.length < 5) {
        entry.solutions.push(err.resolution);
      }
    }
  }

  _extractSuccessPatterns(session, patternMap) {
    const successes = this._collectFromSession(session, SUCCESS_MARKERS);
    for (const succ of successes) {
      const key = this._normalizePattern(succ.text);
      if (!key) continue;
      if (!patternMap.has(key)) {
        patternMap.set(key, {
          pattern: key,
          frequency: 0,
          confidence: 0,
          examples: [],
          strategies: [],
        });
      }
      const entry = patternMap.get(key);
      entry.frequency++;
      if (entry.examples.length < 5) {
        entry.examples.push({
          sessionId: session.sessionId || session.id || '',
          text: succ.text.slice(0, 200),
        });
      }
      if (succ.strategy && entry.strategies.length < 5) {
        entry.strategies.push(succ.strategy);
      }
    }
  }

  _extractWorkflowPatterns(session, patternMap) {
    const workflows = this._collectFromSession(session, WORKFLOW_MARKERS);
    for (const wf of workflows) {
      const key = this._normalizePattern(wf.text);
      if (!key) continue;
      if (!patternMap.has(key)) {
        patternMap.set(key, {
          pattern: key,
          frequency: 0,
          confidence: 0,
          examples: [],
          steps: [],
        });
      }
      const entry = patternMap.get(key);
      entry.frequency++;
      if (entry.examples.length < 5) {
        entry.examples.push({
          sessionId: session.sessionId || session.id || '',
          text: wf.text.slice(0, 200),
        });
      }
      if (wf.steps && entry.steps.length < 5) {
        entry.steps.push(wf.steps);
      }
    }
  }

  _collectFromSession(session, markers) {
    const results = [];
    const sessionId = session.sessionId || session.id || '';

    const texts = this._extractTextsFromSession(session);
    for (const item of texts) {
      const lower = item.text.toLowerCase();
      for (const marker of markers) {
        if (lower.includes(marker)) {
          results.push({
            text: item.text,
            resolution: item.resolution ?? null,
            strategy: item.strategy ?? null,
            steps: item.steps ?? null,
            sessionId,
          });
          break;
        }
      }
    }

    return results;
  }

  _extractTextsFromSession(session) {
    const texts = [];
    this._collectErrors(session, texts);
    this._collectLessons(session, texts);
    this._collectDecisions(session, texts);
    this._collectSkills(session, texts);
    this._collectOutput(session, texts);
    this._collectArtifacts(session, texts);
    return texts;
  }

  _collectErrors(session, texts) {
    if (!session.errors || !Array.isArray(session.errors)) return;
    for (const err of session.errors) {
      texts.push({
        text: typeof err === 'string' ? err : ((err && err.message) || (err && err.text) || String(err)),
        resolution: (err && err.resolution) ?? (err && err.fix) ?? null,
      });
    }
  }

  _collectLessons(session, texts) {
    if (!session.lessonsLearned || !Array.isArray(session.lessonsLearned)) return;
    for (const lesson of session.lessonsLearned) {
      texts.push({
        text: typeof lesson === 'string' ? lesson : ((lesson && lesson.content) || String(lesson)),
        strategy: (lesson && lesson.strategy) ?? (lesson && lesson.approach) ?? null,
      });
    }
  }

  _collectDecisions(session, texts) {
    if (!session.keyDecisions || !Array.isArray(session.keyDecisions)) return;
    for (const decision of session.keyDecisions) {
      texts.push({
        text: typeof decision === 'string' ? decision : ((decision && decision.content) || String(decision)),
        strategy: (decision && decision.rationale) ?? null,
      });
    }
  }

  _collectSkills(session, texts) {
    if (!session.completedSkills || !Array.isArray(session.completedSkills)) return;
    texts.push({
      text: 'completed skills: ' + session.completedSkills.join(', '),
      steps: session.completedSkills,
    });
  }

  _collectOutput(session, texts) {
    if (!session.output || typeof session.output !== 'string') return;
    const lines = session.output.split('\n').filter(l => l.trim().length > 10);
    const MAX_OUTPUT_LINES = 500;
    const limited = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES) : lines;
    for (const line of limited) {
      texts.push({ text: line.trim() });
    }
  }

  _collectArtifacts(session, texts) {
    if (!session.artifacts || !Array.isArray(session.artifacts)) return;
    for (const artifact of session.artifacts) {
      if (typeof artifact === 'string') {
        texts.push({ text: artifact });
      } else if (artifact && artifact.content) {
        texts.push({ text: artifact.content });
      }
    }
  }

  _normalizePattern(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_COMPARE_LENGTH);
  }

  _filterPatterns(patternMap) {
    const result = [];
    for (const [, entry] of patternMap) {
      if (entry.frequency < this._config.minPatternFrequency) continue;
      entry.confidence = roundTo(
        Math.min(0.95, this._config.minConfidence + (entry.frequency - this._config.minPatternFrequency) * 0.1),
        3,
      );
      if (entry.confidence < this._config.minConfidence) continue;
      result.push(entry);
    }
    result.sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
    return result;
  }

  _extractNotes(patterns) {
    const notes = [];

    for (const ep of patterns.error_patterns) {
      notes.push(this._buildNote(
        NOTE_CATEGORIES.ERROR_AVOIDANCE,
        this._buildErrorAvoidanceContent(ep),
        ep.confidence,
        ep.examples,
      ));
    }

    for (const sp of patterns.success_patterns) {
      notes.push(this._buildNote(
        NOTE_CATEGORIES.BEST_PRACTICE,
        this._buildBestPracticeContent(sp),
        sp.confidence,
        sp.examples,
      ));
    }

    for (const wp of patterns.workflow_patterns) {
      notes.push(this._buildNote(
        NOTE_CATEGORIES.WORKFLOW_OPTIMIZATION,
        this._buildWorkflowContent(wp),
        wp.confidence,
        wp.examples,
      ));
    }

    return notes;
  }

  _buildNote(category, content, confidence, examples) {
    return {
      id: generateId('dnote-'),
      category,
      content,
      confidence: roundTo(confidence, 3),
      source_sessions: examples.map(e => e.sessionId).filter(Boolean),
      created_at: new Date().toISOString(),
    };
  }

  _buildErrorAvoidanceContent(pattern) {
    let content = 'Recurring error pattern: ' + pattern.pattern;
    if (pattern.solutions && pattern.solutions.length > 0) {
      const uniqueSolutions = [...new Set(pattern.solutions.filter(Boolean))];
      if (uniqueSolutions.length > 0) {
        content += ' | Solutions: ' + uniqueSolutions.slice(0, 3).join('; ');
      }
    }
    content += ' | Frequency: ' + pattern.frequency;
    return content;
  }

  _buildBestPracticeContent(pattern) {
    let content = 'Successful strategy: ' + pattern.pattern;
    if (pattern.strategies && pattern.strategies.length > 0) {
      const uniqueStrategies = [...new Set(pattern.strategies.filter(Boolean))];
      if (uniqueStrategies.length > 0) {
        content += ' | Approaches: ' + uniqueStrategies.slice(0, 3).join('; ');
      }
    }
    content += ' | Frequency: ' + pattern.frequency;
    return content;
  }

  _buildWorkflowContent(pattern) {
    let content = 'Common workflow: ' + pattern.pattern;
    if (pattern.steps && pattern.steps.length > 0) {
      const allSteps = pattern.steps.flat().filter(Boolean);
      const uniqueSteps = [...new Set(allSteps)];
      if (uniqueSteps.length > 0) {
        content += ' | Steps: ' + uniqueSteps.slice(0, 5).join(' -> ');
      }
    }
    content += ' | Frequency: ' + pattern.frequency;
    return content;
  }

  _mergeWithExistingNotes(newNotes) {
    let merged = 0;
    let added = 0;
    const snapshot = new Map();
    for (const [id, note] of this._notes) {
      snapshot.set(id, { ...note, source_sessions: [...(note.source_sessions ?? [])] });
    }

    const savedStatsMerged = this._stats.notesMerged;
    const savedStatsCreated = this._stats.notesCreated;

    try {
      for (const note of newNotes) {
        let bestMatch = null;
        let bestSimilarity = 0;

        for (const [existingId, existing] of snapshot) {
          if (existing.category !== note.category) continue;
          const sim = this._computeSimilarity(existing.content, note.content);
          if (sim > bestSimilarity) {
            bestSimilarity = sim;
            bestMatch = { id: existingId, note: existing };
          }
        }

        if (bestSimilarity >= this._config.similarityThreshold && bestMatch) {
          const existing = bestMatch.note;
          const mergedNote = {
            ...existing,
            confidence: Math.max(existing.confidence ?? 0, note.confidence ?? 0),
            source_sessions: Array.from(new Set([...(existing.source_sessions ?? []), ...(note.source_sessions ?? [])])),
            updated_at: new Date().toISOString(),
            merge_count: (existing.merge_count ?? 0) + 1,
          };
          this._notes.set(bestMatch.id, mergedNote);
          merged++;
          this._stats.notesMerged++;
        } else {
          this._notes.set(note.id, note);
          added++;
          this._stats.notesCreated++;
        }
      }
    } catch (err) {
      this._notes = snapshot;
      this._stats.notesMerged = savedStatsMerged;
      this._stats.notesCreated = savedStatsCreated;
      debug('DreamEngine', '_mergeWithExistingNotes', 'Rollback due to error: ' + (err && err.message ? err.message : String(err)));
      throw err;
    }

    this._trimNotes();
    return { merged, added };
  }

  _trimNotes() {
    if (this._notes.size <= this._config.maxNotes) return;
    const entries = Array.from(this._notes.entries());
    entries.sort((a, b) => (b[1].confidence ?? 0) - (a[1].confidence ?? 0));
    this._notes.clear();
    const keep = entries.slice(0, this._config.maxNotes);
    for (const [id, note] of keep) {
      this._notes.set(id, note);
    }
  }

  _computeSimilarity(a, b) {
    if (!a || !b) return 0;
    const normA = this._normalize(a).slice(0, MAX_COMPARE_LENGTH);
    const normB = this._normalize(b).slice(0, MAX_COMPARE_LENGTH);
    if (normA === normB) return 1.0;

    const wordsA = new Set(normA.split(/\s+/));
    const wordsB = new Set(normB.split(/\s+/));

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard === 0) return 0;

    const editSim = this._editDistanceSimilarity(normA, normB);

    return jaccard * 0.6 + editSim * 0.4;
  }

  _editDistanceSimilarity(a, b) {
    if (a.length === 0 && b.length === 0) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;
    const maxLen = Math.max(a.length, b.length);
    const dist = this._levenshtein(a, b);
    return 1.0 - dist / maxLen;
  }

  _levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost,
        );
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[n];
  }

  _normalize(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 获取所有笔记，可按类别和最低置信度过滤
   * @param {string} [category] - 笔记类别过滤，可选值为'error-avoidance'、'best-practice'、'workflow-optimization'
   * @param {number} [minConfidence] - 最低置信度阈值
   * @returns {Array<object>} 按置信度降序排列的笔记数组
   */
  getNotes(category, minConfidence) {
    let results = Array.from(this._notes.values());
    if (category) {
      results = results.filter(n => n.category === category);
    }
    if (minConfidence != null) {
      results = results.filter(n => n.confidence >= minConfidence);
    }
    results.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    results = results.map(n => ({ ...n, source_sessions: [...(n.source_sessions ?? [])] }));
    return results;
  }

  _computeKeywordOverlap(queryWords, textWords) {
    let matchCount = 0;
    for (const w of queryWords) {
      if (textWords.has(w)) matchCount++;
    }
    return queryWords.size > 0 ? matchCount / queryWords.size : 0;
  }

  _searchThoughtMemory(context, queryWords) {
    if (!this._thoughtMemoryStore || typeof this._thoughtMemoryStore.search !== 'function') return [];
    try {
      const memoryResults = this._thoughtMemoryStore.search(context, { limit: 5 });
      if (!Array.isArray(memoryResults)) return [];
      const items = [];
      for (const mr of memoryResults) {
        if (!mr || !mr.content) continue;
        const memNorm = this._normalize(mr.content);
        const memWords = new Set(memNorm.split(/\s+/));
        const memKeywordScore = this._computeKeywordOverlap(queryWords, memWords);
        if (memKeywordScore > 0.1) {
          items.push({
            id: mr.id || generateId('mem-'),
            category: NOTE_CATEGORIES.BEST_PRACTICE,
            content: mr.content,
            confidence: Number.isFinite(mr.confidence) ? mr.confidence : 0.5,
            relevance: roundTo(memKeywordScore * 0.6, 3),
            source: 'thought-memory',
            _contentKey: mr.content,
          });
        }
      }
      return items;
    } catch (err) {
      debug('DreamEngine', 'getRelevantNotes.memorySearch', err);
      return [];
    }
  }

  /**
   * 根据上下文检索相关笔记，结合关键词重叠和语义相似度混合评分
   * @param {string} context - 查询上下文文本
   * @returns {Array<object>} 按相关度降序排列的笔记数组，最多返回20条，每条附加relevance字段
   */
  getRelevantNotes(context) {
    if (!context || typeof context !== 'string') return [];

    const queryNorm = this._normalize(context);
    const queryWords = new Set(queryNorm.split(/\s+/));
    const results = [];

    for (const note of this._notes.values()) {
      const contentNorm = this._normalize(note.content);
      const contentWords = new Set(contentNorm.split(/\s+/));
      const keywordScore = this._computeKeywordOverlap(queryWords, contentWords);

      let semanticScore = 0;
      if (this._embeddingService) {
        semanticScore = this._computeSemanticScore(note, context);
      }

      const relevance = keywordScore * 0.6 + semanticScore * 0.4;
      if (relevance > 0.1) {
        results.push({ ...note, relevance: roundTo(relevance, 3) });
      }
    }

    const memoryItems = this._searchThoughtMemory(context, queryWords);
    for (const item of memoryItems) {
      if (!item) continue;
      if (!results.some(r => r.content === item._contentKey)) {
        const { _contentKey, ...rest } = item;
        results.push(rest);
      }
    }

    results.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    return results.slice(0, 20);
  }

  /**
   * 将满足置信度阈值的笔记同步到已附加的BrainMemory和MemoryStore
   * @param {number} [minConfidence=0.7] - 最低置信度阈值
   * @returns {{ synced: number, errors: number }} 同步结果，包含成功数和失败数
   * @fires DreamEngine#notes-synced
   */
  syncNotesToStores(minConfidence) {
    if (this._shutDown) return { synced: 0, errors: 0 };
    const threshold = minConfidence !== undefined ? minConfidence : 0.7;
    const notes = this.getNotes(null, threshold);
    let synced = 0;
    let errors = 0;

    for (const note of notes) {
      if (this._brainMemory && typeof this._brainMemory.store === 'function') {
        try {
          const result = this._brainMemory.store(
            'dream-' + note.id,
            note.content,
            { category: note.category, confidence: note.confidence, source: 'dream-engine' },
          );
          if (result) synced++;
          else errors++;
        } catch (err) {
          debug('DreamEngine', 'syncNotesToStores_brainMemory', err);
          errors++;
        }
      }
      if (this._memoryStore && typeof this._memoryStore.addKnowledge === 'function') {
        try {
          const result = this._memoryStore.addKnowledge({
            category: 'dream-' + note.category,
            content: note.content,
            tags: ['dream-engine', note.category],
            source: 'dream-engine',
          });
          if (result) synced++;
          else errors++;
        } catch (err) {
          debug('DreamEngine', 'syncNotesToStores_memoryStore', err);
          errors++;
        }
      }
    }

    this.emit('notes-synced', { synced, errors, threshold });
    return { synced, errors };
  }

  _computeSemanticScore(note, context) {
    if (!this._embeddingService) return 0;
    try {
      const noteVec = this._embeddingService.embed(note.content);
      const queryVec = this._embeddingService.embed(context);
      if ((noteVec && typeof noteVec.then === 'function') || (queryVec && typeof queryVec.then === 'function')) {
        debug('DreamEngine', '_computeSemanticScore', 'Async embedding not supported in sync context');
        return 0;
      }
      if (!noteVec || !queryVec || noteVec.length === 0 || queryVec.length === 0) return 0;
      if (typeof this._embeddingService.cosineSimilarity === 'function') {
        return this._embeddingService.cosineSimilarity(queryVec, noteVec);
      }
      return this._cosineSimilarity(queryVec, noteVec);
    } catch (err) {
      debug('DreamEngine', '_computeSemanticScore', err);
      this._stats.errors++;
      this.emit('semantic-score-error', { error: err && err.message ? err.message : String(err) });
      return 0;
    }
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (!Number.isFinite(denom) || denom === 0) return 0;
    return dotProduct / denom;
  }

  /**
   * 获取做梦引擎的统计信息，包括总做梦次数、处理会话数、发现模式数、笔记数等
   * @returns {object} 统计对象，包含totalDreams、sessionsProcessed、patternsFound、notesCreated、notesMerged、errors、totalNotes、avgConfidence、byCategory、dreaming字段
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('DreamEngine', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { totalDreams: 0, sessionsProcessed: 0, patternsFound: 0, notesCreated: 0, notesMerged: 0, errors: 0, totalNotes: 0, avgConfidence: 0, byCategory: {}, dreaming: false }; }
    const byCategory = {};
    for (const note of this._notes.values()) {
      byCategory[note.category] = (byCategory[note.category] ?? 0) + 1;
    }
    let totalConfidence = 0;
    for (const note of this._notes.values()) {
      totalConfidence += note.confidence ?? 0;
    }
    return {
      ...this._stats,
      totalNotes: this._notes.size,
      avgConfidence: this._notes.size > 0
        ? roundTo(totalConfidence / this._notes.size, 3)
        : 0,
      byCategory,
      dreaming: this._dreaming,
      phasePipelineStats: this._phasePipeline ? this._phasePipeline.getStats() : null,
    };
  }

  _restoreFromSqlite() {
    if (!this._sqliteStore) return;
    safeCall(() => {
      const rows = this._sqliteStore.query('dream_notes', {});
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && row.id) {
            this._notes.set(row.id, row);
          }
        }
      }
    }, 'DreamEngine', '_restoreFromSqlite');
    this._trimNotes();
  }

  _persistToSqlite() {
    if (!this._sqliteStore) return;
    safeCall(() => {
      for (const note of this._notes.values()) {
        this._sqliteStore.upsert('dream_notes', note.id, note);
      }
    }, 'DreamEngine', '_persistToSqlite');
  }

  _onShutdown() {
    this._persistToSqlite();
    this._notes.clear();
    this._dreaming = false;
    this._dreamCount = 0;
    this._sqliteStore = null;
    this._thoughtMemoryStore = null;
    this._embeddingService = null;
    this._brainMemory = null;
    this._memoryStore = null;
    safeCall(() => {
      if (this._phasePipeline && typeof this._phasePipeline.shutdown === 'function') {
        this._phasePipeline.shutdown();
      }
    }, 'DreamEngine', 'shutdown-phasePipeline');
    this._phasePipeline = null;
    this.removeAllListeners();
  }

  /**
   * 检查做梦引擎是否健康，未关闭且错误数低于100即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._stats.errors < 100;
  }
}

DreamEngine.DEFAULT_CONFIG = DEFAULT_CONFIG;
DreamEngine.NOTE_CATEGORIES = NOTE_CATEGORIES;
DreamEngine.PATTERN_TYPES = PATTERN_TYPES;

module.exports = withShutdown(DreamEngine);
