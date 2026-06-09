'use strict';

const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 记忆重整合器 — 基于 Mnemosyne Mutable RAG 的 Node.js 原生实现
 *
 * 核心原理：每次回忆时，记忆进入不稳定状态（labile），被当前上下文重写后才重新稳定。
 * 解决"过期事实"问题：如果用户说"我用 React"（2025）和"我迁移到 Rust"（2026），
 * 标准 RAG 会检索到两条矛盾记忆，Mutable RAG 会将旧记忆标记为过时并更新。
 *
 * 三阶段流程：
 * 1. Labile 标记：检索到的记忆被标记为"不稳定"
 * 2. 异步评估：检查记忆是否与当前上下文矛盾
 * 3. 重整合：矛盾记忆被更新（覆盖），非矛盾记忆重新稳定
 */
class MutableRAG {
  /**
   * @param {object} options - 配置选项
   * @param {number} [options.labileTimeoutMs=30000] - 不稳定状态超时时间
   * @param {number} [options.contradictionThreshold=0.7] - 矛盾检测阈值
   * @param {number} [options.maxLabileEntries=50] - 最大不稳定条目数
   */
  constructor(options = {}) {
    this._labileTimeoutMs = Math.max(1000, options.labileTimeoutMs ?? 30000);
    this._contradictionThreshold = Math.max(0, Math.min(1, options.contradictionThreshold ?? 0.7));
    this._maxLabileEntries = Math.max(1, options.maxLabileEntries ?? 50);
    this._labileEntries = new Map(); // memoryKey -> { entry, markedAt, context }
    this._reconsolidationCount = 0;
    this._supersededCount = 0;
  }

  /**
   * 标记检索到的记忆为不稳定状态
   * @param {object} entry - 记忆条目
   * @param {string} entry.key - 记忆键
   * @param {string} entry.content - 记忆内容
   * @param {object} [context] - 当前检索上下文
   */
  markLabile(entry, context = {}) {
    if (!entry || !entry.key) return;

    // 如果已达到最大不稳定条目数，移除最旧的
    if (this._labileEntries.size >= this._maxLabileEntries) {
      const oldest = this._findOldestLabile();
      if (oldest) this._labileEntries.delete(oldest);
    }

    this._labileEntries.set(entry.key, {
      entry,
      markedAt: Date.now(),
      context,
    });
  }

  /**
   * 评估不稳定记忆并执行重整合
   * @param {string} newContent - 新的内容/上下文
   * @param {Function} updateFn - 更新函数 (key, newEntry) => void
   * @returns {{reconsolidated: number, superseded: number, stable: number}}
   */
  reconsolidate(newContent, updateFn) {
    let reconsolidated = 0;
    const superseded = 0;
    let stable = 0;

    if (!newContent || typeof updateFn !== 'function') {
      return { reconsolidated, superseded, stable };
    }

    const newTokens = this._tokenize(newContent);
    const now = Date.now();

    for (const [key, labile] of this._labileEntries) {
      // 跳过超时的不稳定条目（自动重新稳定）
      if (now - labile.markedAt > this._labileTimeoutMs) {
        this._labileEntries.delete(key);
        stable++;
        continue;
      }

      const entryTokens = this._tokenize(labile.entry.content || '');
      const similarity = this._jaccardSimilarity(newTokens, entryTokens);

      if (similarity >= this._contradictionThreshold) {
        // 高相似度但可能已过时 — 执行重整合
        const updatedEntry = {
          ...labile.entry,
          content: newContent,
          reconsolidatedAt: now,
          previousContent: labile.entry.content,
          supersededBy: 'mutable-rag',
        };

        try {
          updateFn(key, updatedEntry);
          this._labileEntries.delete(key);
          reconsolidated++;
          this._reconsolidationCount++;
        } catch {
          // 更新失败，保持不稳定状态
        }
      } else {
        // 低相似度 — 重新稳定
        this._labileEntries.delete(key);
        stable++;
      }
    }

    this._supersededCount += reconsolidated;
    return { reconsolidated, superseded, stable };
  }

  /**
   * 获取统计信息
   * @returns {{labileCount: number, reconsolidationCount: number, supersededCount: number}}
   */
  getStats() {
    return {
      labileCount: this._labileEntries.size,
      reconsolidationCount: this._reconsolidationCount,
      supersededCount: this._supersededCount,
    };
  }

  /** @private */
  _findOldestLabile() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, labile] of this._labileEntries) {
      if (labile.markedAt < oldestTime) {
        oldestTime = labile.markedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  /** @private */
  _tokenize(content) {
    const tokens = new Set();
    const words = content.toLowerCase().split(/[\s,.;:!?()[\]{}'"\/\\]+/);
    for (const w of words) {
      if (w.length >= 2) tokens.add(w);
    }
    return tokens;
  }

  /** @private */
  _jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }

  _onShutdown() {
    this._labileEntries.clear();
  }
}

module.exports = { MutableRAG, MutableRAGEnhanced: withShutdown(MutableRAG) };
