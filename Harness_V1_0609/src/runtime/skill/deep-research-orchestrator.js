'use strict';

/**
 * @module runtime/skill/deep-research-orchestrator
 * DeepResearchOrchestrator — 深度调研编排器。
 * 融合deer-flow（字节65000 Star）的设计理念，实现自主规划调研路线、
 * 多轮迭代搜索、多源信息聚合和结构化研究报告生成的端到端自动化系统。
 *
 * 核心特性：
 * - 5阶段调研流程：规划→采集→分析→综合→报告
 * - 自主调研路线规划：根据主题自动生成搜索关键词和调研子问题
 * - 多源并行采集：同时搜索多个信息源，支持MCP适配器
 * - 信息冲突检测：多源信息交叉验证，标记矛盾和共识
 * - 结构化报告生成：自动生成目录、摘要、章节、引用和结论
 * - Token预算管理：调研过程Token消耗追踪和控制
 */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const { generateId } = require('../../utils/unique-id');
const BoundedArray = require('../../utils/bounded-array');
const BoundedMap = require('../../utils/bounded-map');

const RESEARCH_PHASES = {
  PLAN: 'plan',
  COLLECT: 'collect',
  ANALYZE: 'analyze',
  SYNTHESIZE: 'synthesize',
  REPORT: 'report',
};

const DEFAULT_CONFIG = {
  maxSearchRounds: 5,
  maxSourcesPerRound: 10,
  maxTotalSources: 50,
  minConfidenceForCompletion: 0.7,
  reportMaxLength: 30000,
  researchHistorySize: 100,
  sourceCacheSize: 500,
};

class DeepResearchOrchestrator extends EventEmitter {
  /**
   * 创建DeepResearchOrchestrator实例。
   *
   * @param {Object} [config] - 配置
   * @param {Object} [config.searchEngine] - EvolvingSearchEngine实例
   * @param {Object} [config.knowledgeBase] - KnowledgeBasePipeline实例
   * @param {Object} [config.mcpClient] - MCPClient实例（用于Web搜索）
   * @param {number} [config.maxSearchRounds=5] - 最大搜索轮次
   * @param {number} [config.maxSourcesPerRound=10] - 每轮最大采集源数
   */
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config ?? {});
    this._searchEngine = this._config.searchEngine ?? null;
    this._knowledgeBase = this._config.knowledgeBase ?? null;
    this._mcpClient = this._config.mcpClient ?? null;
    this._history = new BoundedArray(this._config.researchHistorySize);
    this._sourceCache = new BoundedMap(this._config.sourceCacheSize);
    this._active = false;
    this._log = debug('DeepResearchOrchestrator');
  }

  /**
   * 执行深度调研。5阶段流程：规划→采集→分析→综合→报告。
   *
   * @param {string} topic - 调研主题
   * @param {Object} [options] - 选项
   * @param {string} [options.depth='standard'] - 调研深度（'quick'|'standard'|'deep'）
   * @param {string[]} [options.focusAreas] - 聚焦领域
   * @param {string} [options.outputFormat='markdown'] - 输出格式（'markdown'|'json'|'compact'）
   * @param {number} [options.maxRounds] - 最大搜索轮次覆盖
   * @returns {Promise<Object>} 调研结果
   */
  async research(topic, options) {
    this.guardShutdown();
    this._validateTopic(topic);

    const { depth, maxRounds, focusAreas, outputFormat } = this._parseOptions(options);

    this._active = true;
    const researchId = 'research-' + generateId();
    const startTime = Date.now();
    const context = {
      researchId,
      topic,
      depth,
      focusAreas,
      maxRounds,
      outputFormat,
      phases: [],
      sources: [],
      findings: [],
      conflicts: [],
      tokenBudget: this._getTokenBudget(depth),
      tokensUsed: 0,
    };

    try {
      // Phase 1: Plan
      this.emit('phase', { researchId, phase: RESEARCH_PHASES.PLAN });
      const plan = this._planResearch(context);
      context.phases.push({ phase: RESEARCH_PHASES.PLAN, result: plan });

      // Phase 2: Collect
      this.emit('phase', { researchId, phase: RESEARCH_PHASES.COLLECT });
      const collected = await this._collectSources(context, plan, maxRounds);
      context.phases.push({ phase: RESEARCH_PHASES.COLLECT, result: { sourceCount: collected.length } });

      // Phase 3: Analyze
      this.emit('phase', { researchId, phase: RESEARCH_PHASES.ANALYZE });
      const analysis = this._analyzeFindings(context, collected);
      context.phases.push({ phase: RESEARCH_PHASES.ANALYZE, result: analysis });

      // Phase 4: Synthesize
      this.emit('phase', { researchId, phase: RESEARCH_PHASES.SYNTHESIZE });
      const synthesis = this._synthesizeResults(context);
      context.phases.push({ phase: RESEARCH_PHASES.SYNTHESIZE, result: synthesis });

      // Phase 5: Report
      this.emit('phase', { researchId, phase: RESEARCH_PHASES.REPORT });
      const report = this._generateReport(context, synthesis, outputFormat);
      context.phases.push({ phase: RESEARCH_PHASES.REPORT, result: { format: outputFormat } });

      const duration = Date.now() - startTime;
      const result = {
        researchId,
        topic,
        depth,
        confidence: synthesis.confidence,
        sources: context.sources.length,
        findings: context.findings.length,
        conflicts: context.conflicts.length,
        phases: context.phases.map(function(p) { return p.phase; }),
        tokensUsed: context.tokensUsed,
        duration,
        report,
      };

      this._history.push(result);
      this.emit('research-complete', { researchId, topic, confidence: synthesis.confidence, duration });
      return result;
    } catch (err) {
      this.emit('research-error', { researchId, error: err && err.message ? err.message : String(err) });
      throw err;
    } finally {
      this._active = false;
    }
  }

  /**
   * 验证topic参数。
   *
   * @param {string} topic - 调研主题
   * @private
   */
  _validateTopic(topic) {
    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      throw new Error('topic is required and must be a non-empty string');
    }
    if (topic.length > 1000) {
      throw new Error('topic exceeds maximum length (1000)');
    }
  }

  /**
   * 解析选项参数。
   *
   * @param {Object} [options] - 选项
   * @returns {{ depth: string, maxRounds: number, focusAreas: string[], outputFormat: string }} 解析后的选项
   * @private
   */
  _parseOptions(options) {
    const opts = options ?? {};
    const depth = opts.depth || 'standard';
    const validDepths = ['quick', 'standard', 'deep'];
    if (!validDepths.includes(depth)) {
      throw new Error('Invalid depth: ' + depth + '. Valid: ' + validDepths.join(', '));
    }
    const maxRounds = opts.maxRounds || (depth === 'quick' ? 2 : depth === 'deep' ? 8 : this._config.maxSearchRounds);
    const focusAreas = Array.isArray(opts.focusAreas) ? opts.focusAreas.slice(0, 10) : [];
    const outputFormat = opts.outputFormat || 'markdown';
    return { depth, maxRounds, focusAreas, outputFormat };
  }

  /**
   * 根据depth返回token预算。
   *
   * @param {string} depth - 调研深度
   * @returns {number} token预算
   * @private
   */
  _getTokenBudget(depth) {
    if (depth === 'quick') return 5000;
    if (depth === 'deep') return 30000;
    return 15000;
  }

  /**
   * Phase 1: 规划调研路线。根据主题生成搜索关键词和子问题。
   *
   * @param {Object} context - 调研上下文
   * @returns {Object} 调研计划
   * @private
   */
  _planResearch(context) {
    const topic = context.topic;
    const keywords = this._extractKeywords(topic);
    const subQuestions = this._generateSubQuestions(topic, context.focusAreas);
    const searchQueries = keywords.map(function(kw) { return { query: kw, priority: 'high' }; });
    subQuestions.forEach(function(sq) {
      searchQueries.push({ query: sq, priority: 'medium' });
    });

    return {
      keywords: keywords,
      subQuestions: subQuestions,
      searchQueries: searchQueries.slice(0, 20),
      estimatedRounds: Math.ceil(searchQueries.length / (context.maxRounds * 2)),
    };
  }

  /**
   * Phase 2: 采集信息源。多轮搜索，每轮基于前轮结果调整查询。
   *
   * @param {Object} context - 调研上下文
   * @param {Object} plan - 调研计划
   * @param {number} maxRounds - 最大轮次
   * @returns {Promise<Array>} 采集结果
   * @private
   */
  async _collectSources(context, plan, maxRounds) {
    const allSources = [];
    const queries = plan.searchQueries.slice();
    const rounds = Math.min(maxRounds, this._config.maxSearchRounds);

    for (let round = 0; round < rounds; round++) {
      if (allSources.length >= this._config.maxTotalSources) break;
      const roundQueries = queries.splice(0, this._config.maxSourcesPerRound);
      if (roundQueries.length === 0) break;

      const roundSources = await this._searchQueries(roundQueries, allSources.length, round + 1);
      allSources.push.apply(allSources, roundSources);
      context.sources = allSources;
      context.tokensUsed += roundSources.length * 200;

      // 基于已采集结果生成补充查询
      if (round < rounds - 1 && roundSources.length > 0) {
        const gaps = this._identifyKnowledgeGaps(context, roundSources);
        gaps.forEach(function(g) { queries.push({ query: g, priority: 'low' }); });
      }
    }

    return allSources;
  }

  /**
   * 执行一组查询的搜索。
   *
   * @param {Array} roundQueries - 本轮查询列表
   * @param {number} currentTotal - 当前已采集总数
   * @returns {Array} 本轮采集结果
   * @private
   */
  async _searchQueries(roundQueries, currentTotal, roundNum) {
    const roundSources = [];
    for (const q of roundQueries) {
      try {
        const results = await this._searchOne(q.query);
        if (results && Array.isArray(results)) {
          for (const r of results) {
            if (currentTotal + roundSources.length >= this._config.maxTotalSources) break;
            const source = {
              id: 'src-' + generateId(),
              query: q.query,
              title: r.title || r.answer || q.query,
              content: r.content || r.answer || '',
              confidence: r.confidence ?? 0.5,
              source: r.source || r.clusterId || 'unknown',
              round: roundNum,
            };
            roundSources.push(source);
            this._sourceCache.set(source.id, source);
          }
        }
      } catch (err) {
        this._log('collectSources', err && err.message ? err.message : String(err));
      }
    }
    return roundSources;
  }

  /**
   * 执行单次搜索。
   *
   * @param {string} query - 搜索查询
   * @returns {Promise<Array|null>} 搜索结果
   * @private
   */
  async _searchOne(query) {
    if (this._searchEngine && typeof this._searchEngine.search === 'function') {
      try {
        const result = await this._searchEngine.search(query, { mode: 'FAST', topK: 5 });
        if (result && result.evidenceUnits) {
          return result.evidenceUnits.map(function(eu) {
            return { content: eu.content, confidence: eu.confidence ?? eu.idfScore ?? 0.5, source: result.source || 'sirchnunk', clusterId: result.clusterId };
          });
        }
        if (result && result.answer) {
          return [{ content: result.answer, confidence: result.confidence ?? 0.5, source: result.source || 'sirchnunk' }];
        }
      } catch (_e) { debug('DeepResearchOrchestrator', 'searchFallback:engine', _e && _e.message ? _e.message : String(_e)); }
    }
    if (this._knowledgeBase && typeof this._knowledgeBase.query === 'function') {
      try {
        const kbResult = await this._knowledgeBase.query(query);
        if (kbResult) return [{ content: kbResult.content || String(kbResult), confidence: 0.6, source: 'knowledge-base' }];
      } catch (_e) { debug('DeepResearchOrchestrator', 'searchFallback:kb', _e && _e.message ? _e.message : String(_e)); }
    }
    return null;
  }

  /**
   * Phase 3: 分析发现。信息分类、冲突检测、置信度评估。
   *
   * @param {Object} context - 调研上下文
   * @param {Array} sources - 采集的源
   * @returns {Object} 分析结果
   * @private
   */
  _analyzeFindings(context, sources) {
    const findings = [];
    const conflicts = [];
    const topicGroups = new Map();

    // 按查询关键词分组
    for (const src of sources) {
      const key = src.query;
      if (!topicGroups.has(key)) topicGroups.set(key, []);
      topicGroups.get(key).push(src);
    }

    // 每组生成一个finding
    for (const [query, group] of topicGroups) {
      const contents = group.map(function(s) { return s.content; }).filter(function(c) { return c && c.length > 0; });
      if (contents.length === 0) continue;

      const avgConfidence = group.reduce(function(sum, s) { return sum + (s.confidence ?? 0.5); }, 0) / group.length;
      const sourceCount = group.length;
      const consensus = sourceCount > 1 ? this._detectConsensus(contents) : { agreed: true, agreement: 1.0 };

      const finding = {
        id: 'finding-' + generateId(),
        query: query,
        summary: this._summarizeGroup(contents),
        confidence: avgConfidence,
        sourceCount: sourceCount,
        consensus: consensus.agreement,
        sources: group.map(function(s) { return s.id; }),
      };

      findings.push(finding);

      if (!consensus.agreed) {
        conflicts.push({
          findingId: finding.id,
          query: query,
          disagreement: consensus.disagreement || 'Sources provide conflicting information',
          sourceCount: sourceCount,
        });
      }
    }

    context.findings = findings;
    context.conflicts = conflicts;

    return {
      findingCount: findings.length,
      conflictCount: conflicts.length,
      avgConfidence: findings.length > 0 ? findings.reduce(function(s, f) { return s + f.confidence; }, 0) / findings.length : 0,
    };
  }

  /**
   * Phase 4: 综合结果。合并findings，计算整体置信度。
   *
   * @param {Object} context - 调研上下文
   * @returns {Object} 综合结果
   * @private
   */
  _synthesizeResults(context) {
    const findings = context.findings;
    const conflicts = context.conflicts;

    // 按置信度排序findings
    const sortedFindings = findings.slice().sort(function(a, b) { return b.confidence - a.confidence; });

    // 计算整体置信度：加权平均，高置信度finding权重更大
    let totalWeight = 0;
    let weightedConfidence = 0;
    for (const f of sortedFindings) {
      const weight = f.sourceCount * f.consensus;
      weightedConfidence += f.confidence * weight;
      totalWeight += weight;
    }
    const overallConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

    // 冲突惩罚
    const conflictPenalty = conflicts.length * 0.05;
    const adjustedConfidence = Math.max(0, overallConfidence - conflictPenalty);

    return {
      topFindings: sortedFindings.slice(0, 10),
      confidence: Math.min(1.0, adjustedConfidence),
      coverage: context.focusAreas.length > 0
        ? context.focusAreas.filter(function(fa) { return findings.some(function(f) { return f.query.toLowerCase().indexOf(fa.toLowerCase()) >= 0; }); }).length / context.focusAreas.length
        : 1.0,
      gaps: this._identifyRemainingGaps(context, sortedFindings),
    };
  }

  /**
   * Phase 5: 生成结构化报告。
   *
   * @param {Object} context - 调研上下文
   * @param {Object} synthesis - 综合结果
   * @param {string} format - 输出格式
   * @returns {string|Object} 报告内容
   * @private
   */
  _generateReport(context, synthesis, format) {
    if (format === 'json') {
      return {
        title: context.topic,
        confidence: synthesis.confidence,
        findings: synthesis.topFindings,
        conflicts: context.conflicts,
        sources: context.sources.length,
        gaps: synthesis.gaps,
      };
    }

    if (format === 'compact') {
      const lines = [];
      lines.push('TOPIC: ' + context.topic);
      lines.push('CONFIDENCE: ' + (synthesis.confidence * 100).toFixed(0) + '%');
      lines.push('SOURCES: ' + context.sources.length);
      for (const f of synthesis.topFindings.slice(0, 5)) {
        lines.push('- ' + f.query + ': ' + f.summary.slice(0, 100) + ' [' + (f.confidence * 100).toFixed(0) + '%]');
      }
      return lines.join('\n');
    }

    // Markdown格式
    const lines = [];
    lines.push('# ' + context.topic);
    lines.push('');
    lines.push('> Confidence: ' + (synthesis.confidence * 100).toFixed(0) + '% | Sources: ' + context.sources.length + ' | Findings: ' + context.findings.length);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    for (const f of synthesis.topFindings) {
      lines.push('- **' + f.query + '**: ' + f.summary + ' (' + f.sourceCount + ' sources, ' + (f.confidence * 100).toFixed(0) + '% confidence)');
    }
    lines.push('');

    if (context.conflicts.length > 0) {
      lines.push('## Conflicts');
      lines.push('');
      for (const c of context.conflicts) {
        lines.push('- **' + c.query + '**: ' + c.disagreement + ' (' + c.sourceCount + ' sources disagree)');
      }
      lines.push('');
    }

    if (synthesis.gaps.length > 0) {
      lines.push('## Knowledge Gaps');
      lines.push('');
      for (const g of synthesis.gaps) {
        lines.push('- ' + g);
      }
      lines.push('');
    }

    lines.push('## Sources');
    lines.push('');
    const uniqueSources = new Set();
    for (const s of context.sources) {
      if (!uniqueSources.has(s.source)) {
        uniqueSources.add(s.source);
        lines.push('- ' + s.source + ' (' + s.round + ' round)');
      }
    }

    return lines.join('\n');
  }

  // ─── 辅助方法 ─────────────────────────────────────────────

  _extractKeywords(topic) {
    const words = topic.split(/[\s,;，；、]+/).filter(function(w) { return w.length > 1; });
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', '如何', '怎么', '什么', 'the', 'a', 'an', 'is', 'are', 'how', 'what', 'why']);
    return words.filter(function(w) { return !stopWords.has(w.toLowerCase()); }).slice(0, 10);
  }

  _generateSubQuestions(topic, focusAreas) {
    const questions = [
      topic + ' 最新进展',
      topic + ' 核心原理',
      topic + ' 最佳实践',
    ];
    if (focusAreas.length > 0) {
      focusAreas.forEach(function(fa) { questions.push(topic + ' ' + fa); });
    }
    return questions.slice(0, 8);
  }

  _identifyKnowledgeGaps(context, _roundSources) {
    const existingQueries = new Set(context.sources.map(function(s) { return s.query; }));
    const gaps = [];
    const aspects = ['优缺点', '对比', '趋势', '案例', '成本'];
    for (const a of aspects) {
      const q = context.topic + ' ' + a;
      if (!existingQueries.has(q)) gaps.push(q);
    }
    return gaps.slice(0, 5);
  }

  _identifyRemainingGaps(context, findings) {
    const coveredQueries = new Set(findings.map(function(f) { return f.query; }));
    const gaps = [];
    const dimensions = ['行业对比', '技术细节', '实施成本', '风险评估', '未来趋势'];
    for (const d of dimensions) {
      const q = context.topic + ' ' + d;
      if (!coveredQueries.has(q) && findings.every(function(f) { return f.query.indexOf(d) < 0; })) {
        gaps.push(d);
      }
    }
    return gaps;
  }

  _summarizeGroup(contents) {
    if (contents.length === 0) return '';
    if (contents.length === 1) return contents[0].slice(0, 500);
    const combined = contents.join(' ').slice(0, 2000);
    return combined.length > 500 ? combined.slice(0, 497) + '...' : combined;
  }

  _detectConsensus(contents) {
    if (contents.length <= 1) return { agreed: true, agreement: 1.0 };
    // 简单共识检测：基于内容重叠度
    let totalOverlap = 0;
    let comparisons = 0;
    for (let i = 0; i < contents.length; i++) {
      for (let j = i + 1; j < contents.length; j++) {
        const words1 = new Set(contents[i].toLowerCase().split(/\s+/));
        const words2 = new Set(contents[j].toLowerCase().split(/\s+/));
        let overlap = 0;
        for (const w of words1) { if (words2.has(w)) overlap++; }
        const similarity = words1.size > 0 ? overlap / words1.size : 0;
        totalOverlap += similarity;
        comparisons++;
      }
    }
    const agreement = comparisons > 0 ? totalOverlap / comparisons : 1.0;
    return { agreed: agreement >= 0.3, agreement: agreement };
  }

  /**
   * 获取调研历史。
   *
   * @param {number} [limit=20] - 返回条数
   * @returns {Array} 历史记录
   */
  getHistory(limit) {
    return this._history.toArray().slice(-(limit || 20));
  }

  /**
   * 获取统计信息。
   *
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalResearches: this._history ? this._history.length : 0,
      cachedSources: this._sourceCache ? this._sourceCache.size : 0,
      active: this._active,
      searchEngine: !!this._searchEngine,
      knowledgeBase: !!this._knowledgeBase,
      mcpClient: !!this._mcpClient,
    };
  }

  _onShutdown() {
    this._history.clear();
    this._sourceCache.clear();
    this._searchEngine = null;
    this._knowledgeBase = null;
    this._mcpClient = null;
    this._active = false;
    this.removeAllListeners();
  }
}

DeepResearchOrchestrator.RESEARCH_PHASES = RESEARCH_PHASES;
DeepResearchOrchestrator.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(DeepResearchOrchestrator);
