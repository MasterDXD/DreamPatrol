'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const { withShutdown } = require('../../utils/shutdown-mixin');

const META_SKILL_TYPE = 'meta-skill';

const DEFAULT_OPTIONS = {
  maxPatterns: 200,
  maxGeneratedSkills: 100,
  minPatternFrequency: 3,
  minPatternSuccessRate: 0.6,
  maxCompositionSize: 7,
  generationCooldownMs: 3600000,
};

class MetaSkillGenerator {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._skillPatterns = new BoundedMap(this._options.maxPatterns);
    this._generatedSkills = new BoundedMap(this._options.maxGeneratedSkills);
    this._skillCreationEngine = null;
    this._stats = {
      patternsDetected: 0,
      skillsGenerated: 0,
      generationAttempts: 0,
      generationFailures: 0,
      lastGenerationAt: 0,
    };
  }

  attachSkillCreationEngine(engine) {
    this._skillCreationEngine = engine;
  }

  recordExecution(skillIds, success, metadata) {
    if (!Array.isArray(skillIds) || skillIds.length < 2) return;
    this._stats.patternsDetected++;
    const patternKey = skillIds.slice().sort().join('->');
    const existing = this._skillPatterns.get(patternKey);
    if (existing) {
      existing.frequency++;
      if (success) existing.successes++;
      existing.lastSeen = Date.now();
      if (metadata?.duration) existing.totalDuration = (existing.totalDuration ?? 0) + metadata.duration;
      if (metadata?.tokensUsed) existing.totalTokens = (existing.totalTokens ?? 0) + metadata.tokensUsed;
    } else {
      this._skillPatterns.set(patternKey, {
        key: patternKey,
        skillIds: skillIds.slice(),
        frequency: 1,
        successes: success ? 1 : 0,
        lastSeen: Date.now(),
        firstSeen: Date.now(),
        totalDuration: metadata?.duration ?? 0,
        totalTokens: metadata?.tokensUsed ?? 0,
      });
    }
  }

  detectAndGenerate() {
    this._stats.generationAttempts++;
    const candidates = this._findGenerationCandidates();
    const generated = [];
    for (const pattern of candidates) {
      if (generated.length >= 5) break;
      const metaSkill = this._generateMetaSkill(pattern);
      if (metaSkill) {
        const skillId = metaSkill.skill_id ?? metaSkill.id;
        this._generatedSkills.set(skillId, metaSkill);
        if (this._skillCreationEngine && this._skillCreationEngine.createSkill) {
          try {
            this._skillCreationEngine.createSkill(metaSkill);
          } catch (_) {
            this._stats.generationFailures++;
            debug('MetaSkillGenerator', 'createSkill', _ && _.message ? _.message : String(_));
          }
        }
        generated.push(metaSkill);
        this._stats.skillsGenerated++;
      }
    }
    this._stats.lastGenerationAt = Date.now();
    return generated;
  }

  _findGenerationCandidates() {
    const candidates = [];
    for (const [, pattern] of this._skillPatterns) {
      const successRate = pattern.frequency > 0 ? pattern.successes / pattern.frequency : 0;
      if (pattern.frequency >= this._options.minPatternFrequency &&
          successRate >= this._options.minPatternSuccessRate &&
          pattern.skillIds.length <= this._options.maxCompositionSize) {
        const existingId = 'meta-' + pattern.skillIds.join('-');
        if (!this._generatedSkills.has(existingId)) {
          candidates.push(Object.assign({}, pattern, { successRate }));
        }
      }
    }
    candidates.sort((a, b) => {
      const scoreA = a.frequency * a.successRate;
      const scoreB = b.frequency * b.successRate;
      return scoreB - scoreA;
    });
    return candidates.slice(0, 10);
  }

  _generateMetaSkill(pattern) {
    const skillId = 'meta-' + pattern.skillIds.join('-');
    const name = this._generateName(pattern.skillIds);
    const avgDuration = pattern.frequency > 0 ? Math.round((pattern.totalDuration ?? 0) / pattern.frequency) : 0;
    const avgTokens = pattern.frequency > 0 ? Math.round((pattern.totalTokens ?? 0) / pattern.frequency) : 0;
    return {
      skill_id: skillId,
      name,
      type: META_SKILL_TYPE,
      description: 'Auto-generated meta-skill combining: ' + pattern.skillIds.join(', '),
      composition: pattern.skillIds.slice(),
      model_routing: this._inferModelRouting(pattern.skillIds),
      token_budget: avgTokens > 0 ? Math.round(avgTokens * 1.2) : 50000,
      avg_duration_ms: avgDuration,
      avg_tokens: avgTokens,
      success_rate: pattern.frequency > 0 ? pattern.successes / pattern.frequency : 0,
      frequency: pattern.frequency,
      auto_generated: true,
      generated_at: Date.now(),
    };
  }

  _generateName(skillIds) {
    if (skillIds.length <= 3) {
      return 'Meta: ' + skillIds.map(id => id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).join(' → ');
    }
    return 'Meta: ' + skillIds.slice(0, 2).map(id => id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).join(' → ') + ' → ... (' + skillIds.length + ' steps)';
  }

  _inferModelRouting(skillIds) {
    const routing = {};
    for (const skillId of skillIds) {
      const id = skillId.toLowerCase();
      if (id.includes('architect') || id.includes('design') || id.includes('brainstorm')) {
        routing[skillId] = 'premium';
      } else if (id.includes('test') || id.includes('lint') || id.includes('format')) {
        routing[skillId] = 'economy';
      } else {
        routing[skillId] = 'standard';
      }
    }
    return routing;
  }

  getPatternStats() {
    const patterns = [];
    for (const [, pattern] of this._skillPatterns) {
      patterns.push({
        key: pattern.key,
        skillIds: [...pattern.skillIds],
        frequency: pattern.frequency,
        successRate: pattern.frequency > 0 ? pattern.successes / pattern.frequency : 0,
      });
    }
    return patterns.sort((a, b) => b.frequency - a.frequency);
  }

  getGeneratedSkills() {
    const skills = [];
    for (const [, skill] of this._generatedSkills) {
      skills.push({ ...skill });
    }
    return skills;
  }

  getStats() {
    return {
      patternsDetected: this._stats.patternsDetected,
      patternsStored: this._skillPatterns.size,
      skillsGenerated: this._stats.skillsGenerated,
      generationAttempts: this._stats.generationAttempts,
      generationFailures: this._stats.generationFailures,
      lastGenerationAt: this._stats.lastGenerationAt,
    };
  }

  _onShutdown() {
    this._skillPatterns.shutdown();
    this._generatedSkills.shutdown();
  }
}

module.exports = withShutdown(MetaSkillGenerator);
module.exports.META_SKILL_TYPE = META_SKILL_TYPE;
