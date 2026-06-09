'use strict';

const { EventEmitter } = require('events');
const { generateId } = require('../../utils/constants');
const { roundTo } = require('../../utils/safe-execute');
const { withShutdown } = require('../../utils/shutdown-mixin');

const THOUGHT_TYPES = {
  INSIGHT: 'insight',
  PATTERN: 'pattern',
  DECISION: 'decision',
  CORRECTION: 'correction',
  PRINCIPLE: 'principle',
};

const EXTRACTION_PATTERNS = [
  { type: THOUGHT_TYPES.INSIGHT, markers: ['insight:', 'key insight:', '发现:', '关键发现:', 'important finding:'], weight: 0.9 },
  { type: THOUGHT_TYPES.PATTERN, markers: ['pattern:', 'recurring pattern:', '模式:', '规律:', 'common pattern:'], weight: 0.85 },
  { type: THOUGHT_TYPES.DECISION, markers: ['decision:', 'decided:', '决定:', '决策:', 'chosen approach:'], weight: 0.95 },
  { type: THOUGHT_TYPES.CORRECTION, markers: ['correction:', 'fix:', '修正:', '纠正:', 'previously incorrect:'], weight: 0.9 },
  { type: THOUGHT_TYPES.PRINCIPLE, markers: ['principle:', 'rule:', '原则:', '规则:', 'best practice:'], weight: 0.85 },
];

const MIN_THOUGHT_LENGTH = 10;
const MAX_THOUGHT_LENGTH = 500;
const CONFIDENCE_THRESHOLD = 0.7;

/**
 * @module runtime/thought/thought-extractor
 * @classdesc 思维提取器。从对话中提取关键思维链
 * ThoughtExtractor — Extracts key thought chains from agent output text
 * Parses conversational output using marker-based pattern matching across five thought
 * types (insight, pattern, decision, correction, principle) with confidence scoring.
 * @extends EventEmitter
 * @emits ThoughtExtractor#thoughts-extracted
 */
class ThoughtExtractor extends EventEmitter {
  constructor(options) {
    super();
    this._confidenceThreshold = (options && options.confidenceThreshold) ?? CONFIDENCE_THRESHOLD;
    this._minLength = (options && options.minLength) ?? MIN_THOUGHT_LENGTH;
    this._maxLength = (options && options.maxLength) ?? MAX_THOUGHT_LENGTH;
    this._stats = {
      totalExtractions: 0,
      thoughtsExtracted: 0,
      thoughtsFiltered: 0,
      errors: 0,
      byType: {},
    };
    for (const t of Object.values(THOUGHT_TYPES)) {
      this._stats.byType[t] = 0;
    }
  }

  /**
   * 从Agent输出文本中提取关键思维链，使用标记模式匹配五种思维类型（洞察、模式、决策、修正、原则）
   * @param {string} output - Agent输出文本
   * @param {object} [context] - 提取上下文，可包含taskId、sessionId、agentId、skillId、iteration、domain、qualityScore
   * @returns {object} 提取结果对象，包含thoughts数组、sourceId、extractedAt字段
   * @throws {Error} When output is not a string
   */
  extract(output, context) {
    this.guardShutdown();
    if (!output || typeof output !== 'string') {
      this._stats.errors++;
      return { thoughts: [], stats: this._getExtractionStats(0, 0) };
    }

    this._stats.totalExtractions++;
    const rawThoughts = this._parseOutput(output, context);
    const filtered = this._filterAndScore(rawThoughts, context);

    this._stats.thoughtsExtracted += filtered.length;
    this._stats.thoughtsFiltered += rawThoughts.length - filtered.length;

    const result = {
      thoughts: filtered,
      sourceId: (context && context.taskId) || (context && context.sessionId) || 'unknown',
      extractedAt: new Date().toISOString(),
    };

    this.emit('thoughts-extracted', result);
    return result;
  }

  _parseOutput(output, context) {
    if (typeof output !== 'string') return [];
    const thoughts = [];
    const lines = output.split('\n');
    let currentThought = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const matched = this._matchPattern(line);
      if (matched) {
        if (currentThought) {
          thoughts.push(currentThought);
        }
        currentThought = {
          id: generateId('tht-'),
          type: matched.type,
          content: this._extractContent(line, matched.marker),
          confidence: matched.weight,
          sourceTrace: this._buildSourceTrace(context, i + 1),
          domain: (context && context.domain) || 'general',
          tags: this._inferTags(line, context),
        };
      } else if (currentThought && line.length > 3) {
        if (currentThought.content.length < this._maxLength) {
          currentThought.content += ' ' + line;
        }
      }
    }

    if (currentThought) {
      thoughts.push(currentThought);
    }

    if (thoughts.length === 0) {
      const implicitThoughts = this._extractImplicitThoughts(output, context);
      thoughts.push(...implicitThoughts);
    }

    return thoughts;
  }

  _matchPattern(line) {
    const lower = line.toLowerCase();
    for (const pattern of EXTRACTION_PATTERNS) {
      for (const marker of pattern.markers) {
        if (lower.includes(marker)) {
          return { type: pattern.type, marker, weight: pattern.weight };
        }
      }
    }
    return null;
  }

  _extractContent(line, marker) {
    const idx = line.toLowerCase().indexOf(marker.toLowerCase());
    if (idx < 0) return line;
    let content = line.substring(idx + marker.length).trim();
    content = content.replace(/^[:：\-–—]\s*/, '');
    return content;
  }

  _extractImplicitThoughts(output, context) {
    const thoughts = [];
    const sentences = output.split(/[.。!！?？;；\n]+/).filter(s => s.trim().length > this._minLength);

    const significanceMarkers = [
      'therefore', 'consequently', 'thus', 'hence', 'so',
      '因此', '所以', '结论', '总之', '综上',
      'importantly', 'notably', 'significantly', 'crucially',
      'must', 'should', 'always', 'never',
      '必须', '应该', '务必', '切忌',
    ];

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase().trim();
      let isSignificant = false;
      for (const marker of significanceMarkers) {
        if (lower.includes(marker)) {
          isSignificant = true;
          break;
        }
      }

      if (isSignificant && sentence.trim().length <= this._maxLength) {
        thoughts.push({
          id: generateId('tht-'),
          type: THOUGHT_TYPES.INSIGHT,
          content: sentence.trim(),
          confidence: 0.6,
          sourceTrace: this._buildSourceTrace(context, 0),
          domain: (context && context.domain) || 'general',
          tags: this._inferTags(sentence, context),
        });
      }
    }

    return thoughts.slice(0, 5);
  }

  _filterAndScore(thoughts, context) {
    const filtered = [];
    for (const thought of thoughts) {
      thought.content = this._normalizeContent(thought.content);
      if (thought.content.length < this._minLength) continue;
      if (thought.content.length > this._maxLength) {
        thought.content = thought.content.substring(0, Math.max(0, this._maxLength - 3)) + '...';
      }

      thought.confidence = this._adjustConfidence(thought, context);
      if (thought.confidence < this._confidenceThreshold) {
        continue;
      }

      this._stats.byType[thought.type] = (this._stats.byType[thought.type] ?? 0) + 1;
      filtered.push(thought);
    }
    return filtered;
  }

  _normalizeContent(content) {
    return content
      .replace(/\s+/g, ' ')
      .replace(/^["'""''`]+|["'""''`]+$/g, '')
      .trim();
  }

  _adjustConfidence(thought, context) {
    let confidence = thought.confidence;

    if (thought.type === THOUGHT_TYPES.DECISION) {
      confidence = Math.min(confidence + 0.05, 1.0);
    }
    if (thought.type === THOUGHT_TYPES.CORRECTION) {
      confidence = Math.min(confidence + 0.03, 1.0);
    }

    if (context && context.qualityScore !== undefined) {
      confidence = confidence * (0.5 + context.qualityScore * 0.5);
    }

    if (thought.content.length < 20) {
      confidence *= 0.85;
    }

    return roundTo(confidence, 3);
  }

  _buildSourceTrace(context, lineNumber) {
    return {
      taskId: (context && context.taskId) || '',
      sessionId: (context && context.sessionId) || '',
      agentId: (context && context.agentId) || '',
      skillId: (context && context.skillId) || '',
      iteration: (context && context.iteration) ?? 0,
      lineNumber: lineNumber ?? 0,
      timestamp: new Date().toISOString(),
    };
  }

  _inferTags(text, context) {
    const tags = [];
    const tagSet = new Set();
    const lower = text.toLowerCase();

    const tagPatterns = {
      'security': ['security', 'vulnerability', 'xss', 'injection', '安全', '漏洞'],
      'performance': ['performance', 'optimization', 'latency', '性能', '优化'],
      'testing': ['test', 'coverage', 'tdd', '测试', '覆盖'],
      'architecture': ['architecture', 'design', 'pattern', '架构', '设计'],
      'bug': ['bug', 'fix', 'error', '缺陷', '修复'],
      'api': ['api', 'endpoint', 'route', '接口'],
      'database': ['database', 'query', 'sql', '数据库'],
    };

    for (const [tag, keywords] of Object.entries(tagPatterns)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          if (!tagSet.has(tag)) { tags.push(tag); tagSet.add(tag); }
          break;
        }
      }
    }

    if (context && context.domain && !tagSet.has(context.domain)) {
      tags.push(context.domain);
      tagSet.add(context.domain);
    }

    return tags;
  }

  _getExtractionStats(extracted, filtered) {
    return {
      extracted,
      filtered,
      totalExtractions: this._stats.totalExtractions,
    };
  }

  /**
   * 获取思维提取器的统计信息
   * @returns {object} 统计对象，包含totalExtractions、thoughtsExtracted、thoughtsFiltered、errors、byType字段
   */
  getStats() {
    return { ...this._stats };
  }

  _onShutdown() {
    this._confidenceThreshold = CONFIDENCE_THRESHOLD;
    this._minLength = MIN_THOUGHT_LENGTH;
    this._maxLength = MAX_THOUGHT_LENGTH;
    this._stats = {
      totalExtractions: 0,
      thoughtsExtracted: 0,
      thoughtsFiltered: 0,
      errors: 0,
      byType: {},
    };
    for (const t of Object.values(THOUGHT_TYPES)) {
      this._stats.byType[t] = 0;
    }
    this.removeAllListeners();
  }

  /**
   * 检查思维提取器是否健康，未关闭且错误数低于100即为健康
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._stats.errors < 100;
  }
}

ThoughtExtractor.THOUGHT_TYPES = THOUGHT_TYPES;
ThoughtExtractor.CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;

module.exports = withShutdown(ThoughtExtractor);
