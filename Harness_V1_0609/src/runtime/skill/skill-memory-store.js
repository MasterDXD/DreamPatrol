'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { timestampId } = require('../../utils/unique-id');

const DEFAULT_CONFIG = {
  maxSkills: 500,
  maxExperiencesPerSkill: 200,
  maxTransferIndex: 1000,
  minTransferSimilarity: 0.5,
  defaultConfidence: 0.7,
  lowEffectivenessThreshold: 0.3,
};

const EXPERIENCE_TYPES = { TIP: 'tip', AVOIDANCE: 'avoidance', PATTERN: 'pattern' };

class SkillMemoryStore extends EventEmitter {
  /**
   * 创建 SkillMemoryStore 实例。
   * @param {Object} [config] - 配置选项
   * @param {number} [config.maxSkills=500] - 最大技能数
   * @param {number} [config.maxExperiencesPerSkill=200] - 每个技能最大经验数
   * @param {number} [config.maxTransferIndex=1000] - 最大迁移索引数
   * @param {number} [config.minTransferSimilarity=0.5] - 最小迁移相似度
   * @param {number} [config.defaultConfidence=0.7] - 默认置信度
   * @param {number} [config.lowEffectivenessThreshold=0.3] - 低效能阈值
   */
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._memories = new BoundedMap(this._config.maxSkills);
    this._transferIndex = new BoundedMap(this._config.maxTransferIndex);
    this._stats = { experiencesStored: 0, experiencesRetrieved: 0, transfersCompleted: 0, prunedCount: 0 };
  }

  storeExperience(skillId, experience) {
    this.guardShutdown();
    if (!skillId || !experience || !experience.type || !experience.content) {
      return { id: null, reason: 'skillId, type, and content are required' };
    }

    return safeExecute(() => {
      if (!this._memories.has(skillId)) {
        this._memories.set(skillId, {
          tips: new BoundedArray(this._config.maxExperiencesPerSkill),
          avoidances: new BoundedArray(this._config.maxExperiencesPerSkill),
          patterns: new BoundedArray(this._config.maxExperiencesPerSkill),
          outcomes: new BoundedMap(this._config.maxExperiencesPerSkill),
        });
      }

      const memory = this._memories.get(skillId);
      const id = timestampId('sme-');
      const entry = {
        id: id,
        type: experience.type,
        content: experience.content,
        context: experience.context || '',
        confidence: experience.confidence ?? this._config.defaultConfidence,
        timestamp: Date.now(),
        effectiveness: { triggered: 0, effective: 0 },
      };

      const targetArray = this._getTargetArray(memory, experience.type);
      if (targetArray) {
        targetArray.push(entry);
      } else {
        return { id: null, reason: 'Invalid experience type: ' + experience.type };
      }

      this._stats.experiencesStored++;
      this.emit('experience-stored', { skillId, experienceId: id, type: experience.type });

      return { id: id, skillId: skillId };
    }, 'SkillMemoryStore', 'storeExperience', { id: null, reason: 'Internal error' });
  }

  getExperiences(skillId, options) {
    this.guardShutdown();
    if (!skillId || !this._memories.has(skillId)) return [];

    return safeExecute(() => {
      const memory = this._memories.get(skillId);
      const opts = options ?? {};
      const type = opts.type;
      const minConfidence = opts.minConfidence ?? 0;
      const limit = opts.limit ?? 100;

      let results = [];

      if (!type || type === EXPERIENCE_TYPES.TIP) {
        results = results.concat(memory.tips.toArray());
      }
      if (!type || type === EXPERIENCE_TYPES.AVOIDANCE) {
        results = results.concat(memory.avoidances.toArray());
      }
      if (!type || type === EXPERIENCE_TYPES.PATTERN) {
        results = results.concat(memory.patterns.toArray());
      }

      if (minConfidence > 0) {
        results = results.filter(function(e) { return e.confidence >= minConfidence; });
      }

      results.sort(function(a, b) { return b.timestamp - a.timestamp; });

      this._stats.experiencesRetrieved += Math.min(results.length, limit);
      return results.slice(0, limit);
    }, 'SkillMemoryStore', 'getExperiences', []);
  }

  getTips(skillId) {
    this.guardShutdown();
    if (!skillId || !this._memories.has(skillId)) return [];
    const memory = this._memories.get(skillId);
    return memory.tips.toArray();
  }

  getAvoidances(skillId) {
    this.guardShutdown();
    if (!skillId || !this._memories.has(skillId)) return [];
    const memory = this._memories.get(skillId);
    return memory.avoidances.toArray();
  }

  getPatterns(skillId) {
    this.guardShutdown();
    if (!skillId || !this._memories.has(skillId)) return [];
    const memory = this._memories.get(skillId);
    return memory ? memory.patterns.toArray().map(p => ({ ...p })) : [];
  }

  transferExperiences(sourceSkillId, targetSkillId, similarityScore) {
    this.guardShutdown();
    if (!sourceSkillId || !targetSkillId || sourceSkillId === targetSkillId) {
      return { transferred: 0, reason: 'Invalid source/target skillId' };
    }
    if (typeof similarityScore !== 'number' || similarityScore < this._config.minTransferSimilarity) {
      return { transferred: 0, reason: 'Similarity score below threshold' };
    }

    return safeExecute(() => {
      if (!this._memories.has(sourceSkillId)) return { transferred: 0, reason: 'Source skill not found' };

      const sourceMemory = this._memories.get(sourceSkillId);
      const allExperiences = []
        .concat(sourceMemory.tips.toArray())
        .concat(sourceMemory.avoidances.toArray())
        .concat(sourceMemory.patterns.toArray());

      let transferred = 0;
      for (const exp of allExperiences) {
        const result = this.storeExperience(targetSkillId, {
          type: exp.type,
          content: exp.content,
          context: (exp.context || '') + ' [transferred from ' + sourceSkillId + ']',
          confidence: Math.min(exp.confidence, similarityScore),
        });
        if (result.id) transferred++;
      }

      this._transferIndex.set(sourceSkillId + '->' + targetSkillId, {
        source: sourceSkillId,
        target: targetSkillId,
        similarity: similarityScore,
        transferredCount: transferred,
        timestamp: Date.now(),
      });

      this._stats.transfersCompleted++;
      this.emit('experiences-transferred', { sourceSkillId, targetSkillId, count: transferred });

      return { transferred: transferred };
    }, 'SkillMemoryStore', 'transferExperiences', { transferred: 0, reason: 'Internal error' });
  }

  autoTransfer(skillGraph) {
    this.guardShutdown();
    if (!skillGraph || typeof skillGraph.getSimilarSkills !== 'function') {
      return { transferred: 0 };
    }

    return safeExecute(() => {
      let totalTransferred = 0;
      this._memories.forEach((memory, _skillId) => {
        const similar = skillGraph.getSimilarSkills(_skillId);
        if (!Array.isArray(similar)) return;
        for (const { skillId: targetId, similarity } of similar) {
          if (similarity >= this._config.minTransferSimilarity) {
            const result = this.transferExperiences(_skillId, targetId, similarity);
            totalTransferred += result.transferred ?? 0;
          }
        }
      });
      return { transferred: totalTransferred };
    }, 'SkillMemoryStore', 'autoTransfer', { transferred: 0 });
  }

  recordOutcome(skillId, experienceId, effective) {
    this.guardShutdown();
    if (!skillId || !experienceId || !this._memories.has(skillId)) return false;

    return safeExecute(() => {
      const memory = this._memories.get(skillId);
      const allArrays = [memory.tips, memory.avoidances, memory.patterns];
      for (const arr of allArrays) {
        const items = arr.toArray();
        for (const item of items) {
          if (item.id === experienceId) {
            item.effectiveness.triggered++;
            if (effective) item.effectiveness.effective++;
            memory.outcomes.set(experienceId, {
              triggered: item.effectiveness.triggered,
              effective: item.effectiveness.effective,
              lastUpdated: Date.now(),
            });
            this.emit('outcome-recorded', { skillId, experienceId, effective });
            return true;
          }
        }
      }
      return false;
    }, 'SkillMemoryStore', 'recordOutcome', false);
  }

  getEffectivenessReport(skillId) {
    this.guardShutdown();
    if (!skillId || !this._memories.has(skillId)) return null;

    return safeExecute(() => {
      const memory = this._memories.get(skillId);
      const allExperiences = []
        .concat(memory.tips.toArray())
        .concat(memory.avoidances.toArray())
        .concat(memory.patterns.toArray());

      const totalExperiences = allExperiences.length;
      let totalTriggered = 0;
      let totalEffective = 0;
      const byType = {};

      for (const exp of allExperiences) {
        const t = exp.type;
        if (!byType[t]) byType[t] = { count: 0, triggered: 0, effective: 0 };
        byType[t].count++;
        byType[t].triggered += exp.effectiveness.triggered;
        byType[t].effective += exp.effectiveness.effective;
        totalTriggered += exp.effectiveness.triggered;
        totalEffective += exp.effectiveness.effective;
      }

      return {
        skillId: skillId,
        totalExperiences: totalExperiences,
        totalTriggered: totalTriggered,
        totalEffective: totalEffective,
        overallEffectiveness: totalTriggered > 0 ? totalEffective / totalTriggered : 0,
        byType: byType,
      };
    }, 'SkillMemoryStore', 'getEffectivenessReport', null);
  }

  pruneLowEffectiveness(threshold) {
    this.guardShutdown();
    const t = threshold ?? this._config.lowEffectivenessThreshold;
    let pruned = 0;

    this._memories.forEach((memory, _skillId) => {
      const arrays = [
        { arr: memory.tips, type: 'tips' },
        { arr: memory.avoidances, type: 'avoidances' },
        { arr: memory.patterns, type: 'patterns' },
      ];

      for (const { arr, type } of arrays) {
        const items = arr.toArray();
        const kept = [];
        for (const item of items) {
          const eff = item.effectiveness.triggered > 0
            ? item.effectiveness.effective / item.effectiveness.triggered
            : item.confidence;
          if (eff >= t) {
            kept.push(item);
          } else {
            pruned++;
            memory.outcomes.delete(item.id);
          }
        }
        const newArr = new BoundedArray(this._config.maxExperiencesPerSkill);
        for (const item of kept) {
          newArr.push(item);
        }
        if (type === 'tips') memory.tips = newArr;
        else if (type === 'avoidances') memory.avoidances = newArr;
        else memory.patterns = newArr;
      }
    });

    this._stats.prunedCount += pruned;
    if (pruned > 0) {
      this.emit('experiences-pruned', { count: pruned, threshold: t });
    }
    return pruned;
  }

  getSkillIds() {
    const ids = [];
    this._memories.forEach(function(_, key) { ids.push(key); });
    return ids;
  }

  getStats() {
    return { ...this._stats };
  }

  _getTargetArray(memory, type) {
    switch (type) {
      case EXPERIENCE_TYPES.TIP: return memory.tips;
      case EXPERIENCE_TYPES.AVOIDANCE: return memory.avoidances;
      case EXPERIENCE_TYPES.PATTERN: return memory.patterns;
      default: return null;
    }
  }

  _onShutdown() {
    this._memories.clear();
    this._transferIndex.clear();
    this._stats = { experiencesStored: 0, experiencesRetrieved: 0, transfersCompleted: 0, prunedCount: 0 };
    this.removeAllListeners();
  }
}

SkillMemoryStore.EXPERIENCE_TYPES = EXPERIENCE_TYPES;

module.exports = withShutdown(SkillMemoryStore);
