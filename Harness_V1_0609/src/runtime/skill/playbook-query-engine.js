'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');

const DEFAULT_OPTIONS = {
  maxPlaybooks: 200,
  maxQueryHistory: 500,
  relevanceThreshold: 0.3,
  topK: 3,
  feedbackCooldownMs: 60000,
};

class PlaybookQueryEngine {
  /**
   * 创建 PlaybookQueryEngine 实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxPlaybooks=200] - 最大Playbook数量
   * @param {number} [options.maxQueryHistory=500] - 最大查询历史条数
   * @param {number} [options.relevanceThreshold=0.3] - 相关性阈值
   * @param {number} [options.topK=3] - Top-K查询结果数
   * @param {number} [options.feedbackCooldownMs=60000] - 反馈冷却时间（毫秒）
   */
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._playbooks = new BoundedMap(this._options.maxPlaybooks);
    this._queryHistory = new BoundedArray(this._options.maxQueryHistory);
    this._feedbackBuffer = new BoundedMap(this._options.maxPlaybooks);
    this._stats = { queries: 0, hits: 0, feedbacks: 0, autoUpdates: 0 };
  }

  registerPlaybook(playbookId, playbook) {
    const entry = {
      id: playbookId,
      name: playbook.name ?? playbookId,
      description: playbook.description ?? '',
      steps: playbook.steps ?? [],
      tags: playbook.tags ?? [],
      category: playbook.category ?? 'general',
      successRate: playbook.successRate ?? 0,
      usageCount: playbook.usageCount ?? 0,
      lastUsed: playbook.lastUsed ?? null,
      createdAt: playbook.createdAt ?? Date.now(),
      version: playbook.version ?? 1,
    };
    this._playbooks.set(playbookId, entry);
  }

  registerPlaybooks(playbooks) {
    if (!Array.isArray(playbooks)) return;
    for (const pb of playbooks) {
      const id = pb.id ?? pb.name ?? 'pb-' + Date.now();
      this.registerPlaybook(id, pb);
    }
  }

  consultPlaybook(taskSignature) {
    this._stats.queries++;
    const sig = this._normalizeSignature(taskSignature);
    const candidates = [];
    for (const [_id, pb] of this._playbooks) {
      const score = this._computeRelevance(sig, pb);
      if (score >= this._options.relevanceThreshold) {
        candidates.push({ playbook: pb, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const topK = candidates.slice(0, this._options.topK);
    if (topK.length > 0) this._stats.hits++;
    this._queryHistory.push({ signature: sig, results: topK.length, timestamp: Date.now() });
    for (const { playbook } of topK) {
      playbook.usageCount = (playbook.usageCount ?? 0) + 1;
      playbook.lastUsed = Date.now();
    }
    return topK.map(r => ({
      id: r.playbook.id,
      name: r.playbook.name,
      steps: r.playbook.steps ? r.playbook.steps.slice() : [],
      relevance: r.score,
      successRate: r.playbook.successRate,
    }));
  }

  submitFeedback(playbookId, feedback) {
    const pb = this._playbooks.get(playbookId);
    if (!pb) return false;
    this._stats.feedbacks++;
    const success = feedback.success ?? false;
    const totalUses = (pb.usageCount ?? 0);
    const currentRate = pb.successRate ?? 0;
    if (totalUses > 0) {
      pb.successRate = (currentRate * (totalUses - 1) + (success ? 1 : 0)) / totalUses;
    } else {
      pb.successRate = success ? 1 : 0;
    }
    if (feedback.suggestedSteps && Array.isArray(feedback.suggestedSteps)) {
      const key = playbookId + '-feedback';
      const existing = this._feedbackBuffer.get(key) ?? [];
      existing.push({ steps: feedback.suggestedSteps, success, timestamp: Date.now() });
      this._feedbackBuffer.set(key, existing);
      if (existing.length >= 3) {
        this._applyFeedbackUpdate(playbookId, existing);
      }
    }
    return true;
  }

  _applyFeedbackUpdate(playbookId, feedbackEntries) {
    const pb = this._playbooks.get(playbookId);
    if (!pb) return;
    const successfulSteps = feedbackEntries
      .filter(e => e.success && e.steps && e.steps.length > 0)
      .flatMap(e => e.steps);
    if (successfulSteps.length > 0) {
      const stepCounts = {};
      for (const step of successfulSteps) {
        const key = typeof step === 'string' ? step : JSON.stringify(step);
        stepCounts[key] = (stepCounts[key] ?? 0) + 1;
      }
      const topSteps = Object.entries(stepCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([step]) => { try { return JSON.parse(step); } catch (_e) { debug('PlaybookQueryEngine', 'parseStep', _e && _e.message ? _e.message : String(_e)); return step; } });
      pb.steps = topSteps;
      pb.version = (pb.version ?? 1) + 1;
      this._stats.autoUpdates++;
    }
    this._feedbackBuffer.delete(playbookId + '-feedback');
  }

  _normalizeSignature(sig) {
    if (typeof sig === 'string') return sig.toLowerCase().trim();
    if (sig && typeof sig === 'object') {
      return [sig.task ?? '', sig.type ?? '', sig.domain ?? '', sig.intent ?? '']
        .filter(Boolean).join(' ').toLowerCase().trim();
    }
    return String(sig).toLowerCase().trim();
  }

  _computeRelevance(signature, playbook) {
    let score = 0;
    const sigTokens = signature.split(/\s+/).filter(Boolean);
    const pbText = [playbook.name, playbook.description, playbook.category, ...(playbook.tags ?? [])]
      .join(' ').toLowerCase();
    if (sigTokens.length === 0) return 0;
    let matchCount = 0;
    for (const token of sigTokens) {
      if (pbText.includes(token)) matchCount++;
    }
    score = matchCount / sigTokens.length;
    const successRate = playbook.successRate ?? 0;
    score = score * 0.7 + successRate * 0.3;
    return Math.min(1, score);
  }

  getStats() {
    return {
      queries: this._stats.queries,
      hits: this._stats.hits,
      hitRate: this._stats.queries > 0 ? this._stats.hits / this._stats.queries : 0,
      feedbacks: this._stats.feedbacks,
      autoUpdates: this._stats.autoUpdates,
      playbookCount: this._playbooks.size,
    };
  }

  _onShutdown() {
    this._playbooks.shutdown();
    this._queryHistory.shutdown();
    this._feedbackBuffer.shutdown();
  }
}

module.exports = withShutdown(PlaybookQueryEngine);
