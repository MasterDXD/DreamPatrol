'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall, safeExecute, clamp01 } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

const COMPARISON_DIMENSIONS = {
  QUALITY: 'quality',
  SPEED: 'speed',
  RELIABILITY: 'reliability',
  COVERAGE: 'coverage',
};

const DIMENSION_WEIGHTS = {
  quality: 0.3,
  speed: 0.2,
  reliability: 0.3,
  coverage: 0.2,
};

const DEFAULT_COMPARISON_CONFIG = {
  maxAlternatives: 3,
  minQualityScore: 0.5,
  comparisonDimensions: ['quality', 'speed', 'reliability', 'coverage'],
};

class SkillComparisonRecommender extends EventEmitter {
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_COMPARISON_CONFIG, config);
    this._skillRouter = null;
    this._qualityIndex = null;
    this._effectivenessOptimizer = null;
    this._cache = new BoundedMap(200);
    this._stats = {
      recommendationsGenerated: 0,
      comparisonsPerformed: 0,
      alternativesGenerated: 0,
    };
  }

  attachSkillRouter(skillRouter) {
    this.guardShutdown();
    this._skillRouter = skillRouter;
  }

  attachQualityIndex(qualityIndex) {
    this.guardShutdown();
    this._qualityIndex = qualityIndex;
  }

  attachEffectivenessOptimizer(optimizer) {
    this.guardShutdown();
    this._effectivenessOptimizer = optimizer;
  }

  /**
   * 根据任务描述推荐技能方案，生成多个备选方案并按综合评分排序。
   * @async
   * @param {string} taskDescription - 任务描述文本
   * @param {object} [options] - 推荐选项，与DEFAULT_COMPARISON_CONFIG合并
   * @param {number} [options.maxAlternatives=3] - 最大备选方案数
   * @param {number} [options.minQualityScore=0.5] - 最低质量分数过滤阈值
   * @returns {Promise<{alternatives: Array<object>, recommendation: object|null}>} 推荐结果，alternatives为按综合评分降序排列的备选方案，recommendation为最优方案
   */
  async recommend(taskDescription, options) {
    this.guardShutdown();
    if (!taskDescription || typeof taskDescription !== 'string') {
      return { alternatives: [], recommendation: null };
    }

    const opts = Object.assign({}, this._config, options);
    const candidates = this._findCandidates(taskDescription);
    if (candidates.length === 0) {
      return { alternatives: [], recommendation: null };
    }

    const filtered = this._filterByQuality(candidates, opts.minQualityScore);
    if (filtered.length === 0) {
      return { alternatives: [], recommendation: null };
    }

    const solutions = this._generateAlternatives(filtered, opts.maxAlternatives);
    const alternatives = solutions.map((skillIds) => {
      const scores = this._scoreSolution(skillIds, taskDescription);
      const compositeScore = this._computeCompositeScore(scores);
      const { pros, cons } = this._generateProsCons(skillIds, scores);
      return { skills: skillIds, scores, compositeScore, pros, cons };
    });

    alternatives.sort((a, b) => b.compositeScore - a.compositeScore);
    this._stats.recommendationsGenerated++;
    this._stats.alternativesGenerated += alternatives.length;

    const recommendation = alternatives.length > 0 ? alternatives[0] : null;
    return { alternatives, recommendation };
  }

  /**
   * 比较多个技能方案的综合评分，按质量、速度、可靠性和覆盖度四个维度打分。
   * @async
   * @param {Array<string[]|string>} solutions - 技能ID数组或技能ID的数组（每个元素代表一个方案）
   * @returns {Promise<{comparisons: Array<object>}>} 比较结果，comparisons中每项包含skills、scores和compositeScore
   */
  async compareSolutions(solutions) {
    this.guardShutdown();
    if (!Array.isArray(solutions) || solutions.length === 0) {
      return { comparisons: [] };
    }

    const comparisons = solutions.map((skillIds) => {
      const ids = Array.isArray(skillIds) ? skillIds : [skillIds];
      const scores = this._scoreSolution(ids, '');
      const compositeScore = this._computeCompositeScore(scores);
      return { skills: ids, scores, compositeScore };
    });

    this._stats.comparisonsPerformed++;
    return { comparisons };
  }

  _findCandidates(taskDescription) {
    if (!this._skillRouter) return [];
    return safeExecute(() => {
      const matches = this._skillRouter.match({ userMessage: taskDescription });
      return Array.isArray(matches) ? matches : [];
    }, 'SkillComparisonRecommender', 'findCandidates', []);
  }

  _filterByQuality(candidates, minQualityScore) {
    if (!this._qualityIndex) return candidates.map((c) => c.skill_id ?? c);
    const result = [];
    for (const candidate of candidates) {
      const skillId = candidate.skill_id ?? candidate;
      const entry = safeExecute(
        () => this._qualityIndex.getQualityScore(skillId),
        'SkillComparisonRecommender', 'filterByQuality', null,
      );
      const score = entry?.compositeScore ?? 1;
      if (score >= minQualityScore) {
        result.push(skillId);
      }
    }
    return result;
  }

  _generateAlternatives(skillIds, maxAlternatives) {
    const solutions = [];
    // Single skill alternatives
    for (const id of skillIds) {
      solutions.push([id]);
      if (solutions.length >= maxAlternatives) break;
    }
    // Skill pairs
    if (solutions.length < maxAlternatives && skillIds.length >= 2) {
      for (let i = 0; i < skillIds.length - 1 && solutions.length < maxAlternatives; i++) {
        for (let j = i + 1; j < skillIds.length && solutions.length < maxAlternatives; j++) {
          solutions.push([skillIds[i], skillIds[j]]);
        }
      }
    }
    // Skill chains (3 skills)
    if (solutions.length < maxAlternatives && skillIds.length >= 3) {
      solutions.push(skillIds.slice(0, 3));
    }
    return solutions.slice(0, maxAlternatives);
  }

  _scoreSolution(skillIds, taskDescription) {
    return {
      quality: this._scoreQuality(skillIds),
      speed: this._scoreSpeed(skillIds),
      reliability: this._scoreReliability(skillIds),
      coverage: this._scoreCoverage(skillIds, taskDescription),
    };
  }

  _scoreQuality(skillIds) {
    if (!this._qualityIndex || skillIds.length === 0) return 0.5;
    let total = 0;
    for (const id of skillIds) {
      const entry = safeExecute(
        () => this._qualityIndex.getQualityScore(id),
        'SkillComparisonRecommender', 'scoreQuality', null,
      );
      total += entry?.compositeScore ?? 0.5;
    }
    return clamp01(total / skillIds.length);
  }

  _scoreSpeed(skillIds) {
    if (skillIds.length === 0) return 0;
    const avgTime = this._getAvgExecutionTime(skillIds);
    // Fewer skills = faster; normalize: 1 skill = 1.0, 2 = 0.7, 3+ = 0.4
    const countPenalty = skillIds.length === 1 ? 1.0 : skillIds.length === 2 ? 0.7 : 0.4;
    const timePenalty = avgTime > 0 ? Math.max(0.1, 1 - avgTime / 10000) : 0.8;
    return clamp01(countPenalty * timePenalty);
  }

  _getAvgExecutionTime(skillIds) {
    if (!this._effectivenessOptimizer) return 0;
    let totalTime = 0;
    let count = 0;
    for (const id of skillIds) {
      const stats = safeExecute(
        () => this._effectivenessOptimizer.getSkillStats?.(id),
        'SkillComparisonRecommender', 'getAvgExecutionTime', null,
      );
      if (stats?.avgExecutionTime) {
        totalTime += stats.avgExecutionTime;
        count++;
      }
    }
    return count > 0 ? totalTime / count : 0;
  }

  _scoreReliability(skillIds) {
    if (!this._qualityIndex || skillIds.length === 0) return 0.5;
    let total = 0;
    for (const id of skillIds) {
      const entry = safeExecute(
        () => this._qualityIndex.getQualityScore(id),
        'SkillComparisonRecommender', 'scoreReliability', null,
      );
      total += entry?.metrics?.successRate ?? 0.5;
    }
    return clamp01(total / skillIds.length);
  }

  _scoreCoverage(skillIds, taskDescription) {
    if (!taskDescription || !this._skillRouter) return 0.5;
    const msgLower = taskDescription.toLowerCase();
    let totalTags = 0;
    let matchedTags = 0;
    for (const id of skillIds) {
      const skill = safeExecute(
        () => this._skillRouter.getSkill(id),
        'SkillComparisonRecommender', 'scoreCoverage', null,
      );
      if (skill?.tags && Array.isArray(skill.tags)) {
        for (const tag of skill.tags) {
          totalTags++;
          if (msgLower.includes(tag.toLowerCase())) {
            matchedTags++;
          }
        }
      }
    }
    return totalTags > 0 ? clamp01(matchedTags / totalTags) : 0.5;
  }

  _generateProsCons(solution, scores) {
    const pros = [];
    const cons = [];
    if (scores.quality >= 0.7) {
      pros.push('High quality skills');
    } else if (scores.quality < 0.4) {
      cons.push('Low quality score');
    }
    if (scores.speed >= 0.7) {
      pros.push('Fast execution');
    } else if (scores.speed < 0.4) {
      cons.push('Slow execution');
    }
    if (scores.reliability >= 0.7) {
      pros.push('High reliability');
    } else if (scores.reliability < 0.4) {
      cons.push('Low reliability');
    }
    if (scores.coverage >= 0.7) {
      pros.push('Good task coverage');
    } else if (scores.coverage < 0.4) {
      cons.push('Poor task coverage');
    }
    if (solution.length === 1) {
      pros.push('Simple single-skill solution');
    } else if (solution.length >= 3) {
      cons.push('Complex multi-skill chain');
    }
    return { pros, cons };
  }

  _computeCompositeScore(scores) {
    let composite = 0;
    for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
      composite += (scores[dim] ?? 0) * weight;
    }
    return clamp01(composite);
  }

  getStats() {
    try {
      this.guardShutdown();
      return {
        recommendationsGenerated: this._stats.recommendationsGenerated,
        comparisonsPerformed: this._stats.comparisonsPerformed,
        alternativesGenerated: this._stats.alternativesGenerated,
        cacheSize: this._cache.size,
      };
    } catch (_err) {
      return {
        recommendationsGenerated: 0,
        comparisonsPerformed: 0,
        alternativesGenerated: 0,
        cacheSize: 0,
      };
    }
  }

  _onShutdown() {
    safeCall(() => this._cache.clear(), 'SkillComparisonRecommender', 'shutdown-cache');
    safeCall(() => this._cache.shutdown(), 'SkillComparisonRecommender', 'shutdown-cache-map');
    this._skillRouter = null;
    this._qualityIndex = null;
    this._effectivenessOptimizer = null;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(SkillComparisonRecommender);
module.exports.DEFAULT_COMPARISON_CONFIG = DEFAULT_COMPARISON_CONFIG;
module.exports.COMPARISON_DIMENSIONS = COMPARISON_DIMENSIONS;
module.exports.DIMENSION_WEIGHTS = DIMENSION_WEIGHTS;
