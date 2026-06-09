'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const THREAT_LEVELS = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const FRAGMENT_PATTERNS = {
  SYSTEM_ROLE_INJECTION: {
    keywords: ['ignore previous', 'forget instructions', 'new instructions', 'override', 'system prompt', 'you are now', 'act as', 'pretend'],
    weight: 0.8,
    category: 'role-injection',
  },
  DATA_EXFILTRATION: {
    keywords: ['output all', 'print everything', 'reveal', 'show me the prompt', 'display instructions', 'repeat back', 'echo', 'dump'],
    weight: 0.7,
    category: 'data-exfiltration',
  },
  CODE_EXECUTION: {
    keywords: ['execute', 'run command', 'eval(', 'exec(', 'child_process', 'spawn', 'shell', 'bash', 'terminal'],
    weight: 0.9,
    category: 'code-execution',
  },
  PERMISSION_ESCALATION: {
    keywords: ['sudo', 'admin', 'root', 'elevated', 'privileged', 'bypass', 'disable security', 'skip check'],
    weight: 0.85,
    category: 'permission-escalation',
  },
  INDIRECT_INJECTION: {
    keywords: ['when you see', 'if asked about', 'whenever', 'always respond', 'secretly', 'without mentioning', 'covertly'],
    weight: 0.75,
    category: 'indirect-injection',
  },
};

const DEFAULT_OPTIONS = {
  windowSize: 10,
  maxFragmentStore: 500,
  aggregationThreshold: 0.6,
  criticalThreshold: 0.85,
  fragmentDecayMs: 3600000,
  maxHistorySize: 1000,
};

class InstructionFragmentDetector {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._fragments = new BoundedMap(this._options.maxFragmentStore);
    this._sessionWindows = new BoundedMap(100);
    this._history = new BoundedArray(this._options.maxHistorySize);
    this._stats = {
      messagesScanned: 0,
      fragmentsDetected: 0,
      threatsIdentified: 0,
      byCategory: {},
      byThreatLevel: {},
    };
  }

  scanMessage(sessionId, message) {
    this.guardShutdown();
    if (!message || typeof message !== 'string') return null;
    this._stats.messagesScanned++;
    const window = this._getOrCreateWindow(sessionId);
    const fragmentScores = this._detectFragments(message);
    window.messages.push({
      content: message,
      scores: fragmentScores,
      timestamp: Date.now(),
    });
    if (window.messages.length > this._options.windowSize) {
      window.messages.shift();
    }
    const aggregatedThreat = this._aggregateFragments(window);
    if (aggregatedThreat.threatLevel !== THREAT_LEVELS.NONE) {
      this._stats.threatsIdentified++;
      this._stats.byThreatLevel[aggregatedThreat.threatLevel] = (this._stats.byThreatLevel[aggregatedThreat.threatLevel] ?? 0) + 1;
      this._history.push({
        sessionId,
        threatLevel: aggregatedThreat.threatLevel,
        categories: aggregatedThreat.categories,
        score: aggregatedThreat.score,
        timestamp: Date.now(),
      });
    }
    return aggregatedThreat;
  }

  _getOrCreateWindow(sessionId) {
    let window = this._sessionWindows.get(sessionId);
    if (!window) {
      window = {
        sessionId,
        messages: [],
        createdAt: Date.now(),
      };
      this._sessionWindows.set(sessionId, window);
    }
    return window;
  }

  _detectFragments(message) {
    const lowerMessage = message.toLowerCase();
    const scores = {};
    for (const [patternName, pattern] of Object.entries(FRAGMENT_PATTERNS)) {
      let matchCount = 0;
      for (const keyword of pattern.keywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        const score = Math.min(1, (matchCount / pattern.keywords.length) * pattern.weight);
        scores[patternName] = {
          score,
          matchCount,
          category: pattern.category,
        };
        this._stats.fragmentsDetected++;
        this._stats.byCategory[pattern.category] = (this._stats.byCategory[pattern.category] ?? 0) + 1;
      }
    }
    return scores;
  }

  _aggregateFragments(window) {
    if (window.messages.length === 0) {
      return { threatLevel: THREAT_LEVELS.NONE, score: 0, categories: [], details: {} };
    }
    const categoryScores = {};
    const now = Date.now();
    for (const msg of window.messages) {
      const age = now - msg.timestamp;
      const decay = Math.max(0, 1 - age / this._options.fragmentDecayMs);
      for (const [, fragment] of Object.entries(msg.scores)) {
        const category = fragment.category;
        categoryScores[category] = (categoryScores[category] ?? 0) + fragment.score * decay;
      }
    }
    let maxScore = 0;
    let dominantCategory = null;
    const details = {};
    for (const [category, score] of Object.entries(categoryScores)) {
      const normalizedScore = Math.min(1, score / window.messages.length);
      details[category] = normalizedScore;
      if (normalizedScore > maxScore) {
        maxScore = normalizedScore;
        dominantCategory = category;
      }
    }
    const crossCategoryBoost = Object.keys(categoryScores).length > 2 ? 0.15 : 0;
    const finalScore = Math.min(1, maxScore + crossCategoryBoost);
    let threatLevel;
    if (finalScore >= this._options.criticalThreshold) {
      threatLevel = THREAT_LEVELS.CRITICAL;
    } else if (finalScore >= this._options.aggregationThreshold) {
      threatLevel = THREAT_LEVELS.HIGH;
    } else if (finalScore >= 0.4) {
      threatLevel = THREAT_LEVELS.MEDIUM;
    } else if (finalScore >= 0.2) {
      threatLevel = THREAT_LEVELS.LOW;
    } else {
      threatLevel = THREAT_LEVELS.NONE;
    }
    return {
      threatLevel,
      score: finalScore,
      categories: dominantCategory ? [dominantCategory] : [],
      details,
      messageCount: window.messages.length,
    };
  }

  getSessionThreatLevel(sessionId) {
    const window = this._sessionWindows.get(sessionId);
    if (!window || window.messages.length === 0) {
      return { threatLevel: THREAT_LEVELS.NONE, score: 0, categories: [] };
    }
    return this._aggregateFragments(window);
  }

  clearSession(sessionId) {
    this.guardShutdown();
    this._sessionWindows.delete(sessionId);
  }

  getStats() {
    this.guardShutdown();
    return {
      messagesScanned: this._stats.messagesScanned,
      fragmentsDetected: this._stats.fragmentsDetected,
      threatsIdentified: this._stats.threatsIdentified,
      byCategory: Object.assign({}, this._stats.byCategory),
      byThreatLevel: Object.assign({}, this._stats.byThreatLevel),
      activeSessions: this._sessionWindows.size,
    };
  }

  _onShutdown() {
    this._fragments.shutdown();
    this._sessionWindows.shutdown();
    this._history.shutdown();
    this._stats = { messagesScanned: 0, fragmentsDetected: 0, threatsIdentified: 0, byCategory: {}, byThreatLevel: {} };
  }
}

module.exports = withShutdown(InstructionFragmentDetector);
module.exports.THREAT_LEVELS = THREAT_LEVELS;
module.exports.FRAGMENT_PATTERNS = FRAGMENT_PATTERNS;
