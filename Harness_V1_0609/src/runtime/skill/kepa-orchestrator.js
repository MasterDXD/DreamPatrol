'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { generateId } = require('../../utils/unique-id');

/**
 * KEPA循环各阶段状态
 * @readonly
 * @enum {string}
 */
const KEPA_PHASES = {
  COLLECT: 'collect',
  GENERATE: 'generate',
  VERIFY: 'verify',
  IDLE: 'idle',
};

/**
 * 经验条目类型
 * @readonly
 * @enum {string}
 */
const EXPERIENCE_TYPES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL: 'partial',
  FEEDBACK: 'feedback',
};

/**
 * 技能生成请求状态
 * @readonly
 * @enum {string}
 */
const GENERATION_STATUS = {
  PENDING: 'pending',
  LLM_PROCESSING: 'llm_processing',
  CANDIDATE_READY: 'candidate_ready',
  VERIFYING: 'verifying',
  PROMOTED: 'promoted',
  REJECTED: 'rejected',
  ROLLED_BACK: 'rolled_back',
};

/** KEPA循环最小经验条目数，达到后触发技能生成 */
const MIN_EXPERIENCES_FOR_GENERATION = 5;
/** 自我验证最小测试轮次 */
const MIN_VERIFY_ROUNDS = 3;
/** 验证通过率阈值 */
const VERIFY_PASS_RATE = 0.6;
/** 经验条目最大容量 */
const MAX_EXPERIENCES = 500;
/** 生成请求最大容量 */
const MAX_GENERATIONS = 200;
/** 循环心跳默认间隔（毫秒） */
const DEFAULT_HEARTBEAT_MS = 60 * 1000;
/** 经验过期时间（毫秒），默认7天 */
const EXPERIENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @module runtime/skill/kepa-orchestrator
 * KEPA（Knowledge-Evolved Progressive Architecture）编排器
 *
 * 将Hermes Agent的KEPA自学习进化思想融入Harness工具编排体系，
 * 实现经验收集→技能生成→自我验证的自动化闭环循环。
 *
 * 融合策略：
 * - 循环1（经验收集）：统一调度DreamEngine、SkillDistiller.captureTrace()、
 *   SkillMemoryStore、AutoReinLearningLoop，提供中心化经验入口
 * - 循环2（技能生成）：当经验积累达到阈值时，自动触发SkillEvolver.evolve()
 *   或SkillDistiller.fullDistillationPipeline()，生成新技能或改进现有技能
 * - 循环3（自我验证）：通过SkillImprovementLoop飞轮三道门、SkillCanary金丝雀、
 *   SelfReflection证伪检查，自动验证生成结果，保留有效、淘汰无效
 *
 * @extends EventEmitter
 * @emits {object} experience-collected - 经验已收集
 * @emits {object} generation-triggered - 技能生成已触发
 * @emits {object} generation-completed - 技能生成已完成
 * @emits {object} verification-passed - 验证通过
 * @emits {object} verification-failed - 验证失败
 * @emits {object} skill-promoted - 技能已晋升
 * @emits {object} skill-rolled-back - 技能已回滚
 * @emits {object} cycle-completed - 完整KEPA循环已完成
 * @emits {object} kepa-error - KEPA循环错误
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */
class KepaOrchestrator extends EventEmitter {
  /**
   * @param {object} [options] - 配置选项
   * @param {number} [options.heartbeatMs=60000] - 心跳间隔（毫秒）
   * @param {number} [options.minExperiencesForGeneration=5] - 触发生成的最小经验数
   * @param {number} [options.minVerifyRounds=3] - 最小验证轮次
   * @param {number} [options.verifyPassRate=0.6] - 验证通过率阈值
   * @param {number} [options.experienceTtlMs=604800000] - 经验过期时间（毫秒）
   * @param {boolean} [options.autoStart=false] - 是否自动启动循环
   */
  constructor(options) {
    super();
    this._config = mergeConfig({
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      minExperiencesForGeneration: MIN_EXPERIENCES_FOR_GENERATION,
      minVerifyRounds: MIN_VERIFY_ROUNDS,
      verifyPassRate: VERIFY_PASS_RATE,
      experienceTtlMs: EXPERIENCE_TTL_MS,
      autoStart: false,
    }, options);

    /** @type {string} 当前KEPA循环阶段 */
    this._phase = KEPA_PHASES.IDLE;

    /** @type {BoundedMap<string, object>} 经验缓冲区，按skillId分组 */
    this._experiences = new BoundedMap(MAX_EXPERIENCES);

    /** @type {BoundedArray<object>} 生成请求队列 */
    this._generationQueue = new BoundedArray(MAX_GENERATIONS);

    /** @type {BoundedMap<string, object>} 验证中的候选技能 */
    this._verifyingCandidates = new BoundedMap(50);

    /** @type {BoundedMap<string, object>} 已晋升技能追踪 */
    this._promotedSkills = new BoundedMap(100);

    /** @type {number} 循环计数器 */
    this._cycleCount = 0;

    /** @type {number} 成功晋升计数 */
    this._promotedCount = 0;

    /** @type {number} 回滚计数 */
    this._rolledBackCount = 0;

    /** @type {object|null} 心跳定时器 */
    this._heartbeatTimer = null;

    /** @type {boolean} 是否正在执行循环 */
    this._cycling = false;

    // ---- 依赖注入点 ----
    this._dreamEngine = null;
    this._skillDistiller = null;
    this._skillEvolver = null;
    this._skillMemoryStore = null;
    this._skillImprovementLoop = null;
    this._skillCanary = null;
    this._skillRouter = null;
    this._selfReflection = null;
    this._qualityScorer = null;
    this._autoReinLearningLoop = null;
    this._selfEvolutionGovernor = null;
    this._skillCreationEngine = null;
    this._skillPatchApproval = null;
    this._llmClient = null;
  }

  // ============================================================
  // 依赖注入
  // ============================================================

  /** 挂载DreamEngine */
  attachDreamEngine(engine) { this._dreamEngine = engine; return this; }
  /** 挂载SkillDistiller */
  attachSkillDistiller(distiller) { this._skillDistiller = distiller; return this; }
  /** 挂载SkillEvolver */
  attachSkillEvolver(evolver) { this._skillEvolver = evolver; return this; }
  /** 挂载SkillMemoryStore */
  attachSkillMemoryStore(store) { this._skillMemoryStore = store; return this; }
  /** 挂载SkillImprovementLoop */
  attachSkillImprovementLoop(loop) { this._skillImprovementLoop = loop; return this; }
  /** 挂载SkillCanary */
  attachSkillCanary(canary) { this._skillCanary = canary; return this; }
  /** 挂载SkillRouter */
  attachSkillRouter(router) { this._skillRouter = router; return this; }
  /** 挂载SelfReflection */
  attachSelfReflection(reflection) { this._selfReflection = reflection; return this; }
  /** 挂载QualityScorer */
  attachQualityScorer(scorer) { this._qualityScorer = scorer; return this; }
  /** 挂载AutoReinLearningLoop */
  attachAutoReinLearningLoop(loop) { this._autoReinLearningLoop = loop; return this; }
  /** 挂载SelfEvolutionGovernor */
  attachSelfEvolutionGovernor(governor) { this._selfEvolutionGovernor = governor; return this; }
  /** 挂载SkillCreationEngine */
  attachSkillCreationEngine(engine) { this._skillCreationEngine = engine; return this; }
  /** 挂载SkillPatchApproval */
  attachSkillPatchApproval(approval) { this._skillPatchApproval = approval; return this; }
  /** 挂载LLM客户端 */
  attachLlmClient(client) { this._llmClient = client; return this; }

  // ============================================================
  // 循环1：经验收集（Experience Collection）
  // ============================================================

  /**
   * 收集任务执行经验——KEPA循环的统一经验入口。
   * 将经验分发到SkillMemoryStore、SkillDistiller追踪缓冲区，
   * 并在经验积累达到阈值时自动触发生成阶段。
   *
   * @param {object} experience - 经验数据
   * @param {string} experience.skillId - 关联技能ID
   * @param {string} experience.type - 经验类型（success/failure/partial/feedback）
   * @param {string} experience.description - 经验描述
   * @param {object} [experience.context] - 执行上下文
   * @param {number} [experience.confidence=0.5] - 置信度(0-1)
   * @param {object} [experience.outcome] - 执行结果
   * @returns {{id: string, skillId: string, phase: string, generationTriggered: boolean}}
   */
  collectExperience(experience) {
    this.guardShutdown();
    if (!experience || !experience.skillId || !experience.type) {
      return { id: null, skillId: null, phase: this._phase, generationTriggered: false };
    }

    const id = generateId();
    const entry = {
      id,
      skillId: experience.skillId,
      type: experience.type,
      description: experience.description || '',
      context: experience.context ?? {},
      confidence: Number.isFinite(experience.confidence) ? experience.confidence : 0.5,
      outcome: experience.outcome ?? null,
      collectedAt: Date.now(),
    };

    // 存入KEPA经验缓冲区
    const skillExperiences = this._experiences.get(entry.skillId) ?? [];
    skillExperiences.push(entry);
    this._experiences.set(entry.skillId, skillExperiences);

    // 同步到SkillMemoryStore
    if (this._skillMemoryStore) {
      safeExecute(() => {
        const memType = entry.type === EXPERIENCE_TYPES.SUCCESS ? 'tip'
          : entry.type === EXPERIENCE_TYPES.FAILURE ? 'avoidance' : 'pattern';
        this._skillMemoryStore.storeExperience(entry.skillId, {
          type: memType,
          content: entry.description,
          context: entry.context,
          confidence: entry.confidence,
        });
      });
    }

    // 同步到SkillDistiller追踪
    if (this._skillDistiller) {
      safeExecute(() => {
        this._skillDistiller.captureTrace({
          skillId: entry.skillId,
          sessionId: entry.context.sessionId || 'kepa',
          steps: entry.context.steps ?? [],
          outcome: entry.outcome || { success: entry.type === EXPERIENCE_TYPES.SUCCESS },
        });
      });
    }

    // 同步到AutoReinLearningLoop
    if (this._autoReinLearningLoop && entry.type === EXPERIENCE_TYPES.FAILURE) {
      safeExecute(() => {
        this._autoReinLearningLoop.processTaskResult({
          success: false,
          error: entry.description,
          skillId: entry.skillId,
          context: entry.context,
        });
      });
    }

    // 检查是否达到生成阈值
    const generationTriggered = this._checkGenerationThreshold(entry.skillId);

    this.emit('experience-collected', { id, skillId: entry.skillId, type: entry.type, generationTriggered });
    debug('KepaOrchestrator', 'collectExperience', entry.skillId, entry.type, 'gen=' + generationTriggered);

    return { id, skillId: entry.skillId, phase: this._phase, generationTriggered };
  }

  /**
   * 批量收集经验（从DreamEngine笔记同步）
   *
   * @param {Array<object>} experiences - 经验数组
   * @returns {{collected: number, triggered: string[]}}
   */
  collectExperiencesBatch(experiences) {
    this.guardShutdown();
    if (!Array.isArray(experiences)) return { collected: 0, triggered: [] };

    let collected = 0;
    const triggered = [];
    for (const exp of experiences) {
      const result = this.collectExperience(exp);
      if (result.id) collected++;
      if (result.generationTriggered && !triggered.includes(result.skillId)) {
        triggered.push(result.skillId);
      }
    }
    return { collected, triggered };
  }

  /**
   * 从DreamEngine同步经验笔记
   *
   * @param {string} [category] - 笔记类别过滤
   * @param {number} [minConfidence=0.6] - 最低置信度
   * @returns {Promise<{synced: number, triggered: string[]}>}
   */
  async syncFromDreamEngine(category, minConfidence) {
    this.guardShutdown();
    if (!this._dreamEngine) return { synced: 0, triggered: [] };

    const notes = this._dreamEngine.getNotes(category, minConfidence ?? 0.6);
    const experiences = notes.map(function(note) {
      return {
        skillId: note.skillId || note.category || 'general',
        type: note.category === 'error-avoidance' ? EXPERIENCE_TYPES.FAILURE
        : note.category === 'best-practice' ? EXPERIENCE_TYPES.SUCCESS
        : EXPERIENCE_TYPES.PARTIAL,
        description: note.content || note.summary || '',
        context: note.context ?? {},
        confidence: note.confidence ?? 0.5,
        outcome: note.outcome,
      };
    });

    return this.collectExperiencesBatch(experiences);
  }

  // ============================================================
  // 循环2：技能生成（Skill Generation）
  // ============================================================

  /**
   * 触发技能生成——KEPA循环的核心创造环节。
   * 优先使用SkillEvolver三阶段演化，回退到SkillDistiller蒸馏管道。
   *
   * @param {string} skillId - 目标技能ID
   * @param {object} [options] - 生成选项
   * @param {string} [options.strategy='auto'] - 生成策略（auto/evolve/distill/create）
   * @param {boolean} [options.requireApproval=true] - 是否需要人工审批
   * @returns {Promise<{success: boolean, skillId: string, strategy: string, generationId: string, candidate?: object}>}
   */
  async triggerGeneration(skillId, options) {
    this.guardShutdown();
    if (!skillId) return { success: false, skillId: null, strategy: null, generationId: null };

    const opts = mergeConfig({ strategy: 'auto', requireApproval: true }, options);
    const generationId = generateId();
    this._phase = KEPA_PHASES.GENERATE;

    const generation = {
      id: generationId,
      skillId,
      strategy: opts.strategy,
      status: GENERATION_STATUS.PENDING,
      createdAt: Date.now(),
      requireApproval: opts.requireApproval,
      result: null,
    };

    this._generationQueue.push(generation);
    this.emit('generation-triggered', { generationId, skillId, strategy: opts.strategy });

    try {
      let result;

      // 策略选择：auto模式优先evolve，回退distill
      if (opts.strategy === 'auto' || opts.strategy === 'evolve') {
        result = await this._generateViaEvolver(skillId, opts);
        if (!result.success && opts.strategy === 'auto') {
          debug('KepaOrchestrator', 'triggerGeneration', 'evolver failed, falling back to distiller');
          result = await this._generateViaDistiller(skillId, opts);
        }
      } else if (opts.strategy === 'distill') {
        result = await this._generateViaDistiller(skillId, opts);
      } else if (opts.strategy === 'create') {
        result = await this._generateViaCreation(skillId, opts);
      } else {
        result = { success: false, reason: 'Unknown strategy: ' + opts.strategy };
      }

      generation.status = result.success ? GENERATION_STATUS.CANDIDATE_READY : GENERATION_STATUS.REJECTED;
      generation.result = result;

      this.emit('generation-completed', {
        generationId, skillId, strategy: opts.strategy, success: result.success,
      });

      // 生成成功后自动进入验证阶段
      if (result.success) {
        this._verifyingCandidates.set(generationId, {
          skillId,
          generationId,
          candidate: result.candidate || result,
          strategy: opts.strategy,
          verifyRounds: 0,
          verifyPassed: 0,
          startedAt: Date.now(),
        });
        this._phase = KEPA_PHASES.VERIFY;

        // 如果不需要审批，直接进入自动验证
        if (!opts.requireApproval) {
          await this._runVerification(generationId);
        }
      } else {
        this._phase = KEPA_PHASES.IDLE;
      }

      return {
        success: result.success,
        skillId,
        strategy: opts.strategy,
        generationId,
        candidate: result.candidate,
      };
    } catch (err) {
      generation.status = GENERATION_STATUS.REJECTED;
      debug('KepaOrchestrator', 'triggerGeneration', err && err.message ? err.message : String(err));
      this.emit('kepa-error', { phase: 'generate', skillId, error: err });
      this._phase = KEPA_PHASES.IDLE;
      return { success: false, skillId, strategy: opts.strategy, generationId };
    }
  }

  // ============================================================
  // 循环3：自我验证（Self-Verification）
  // ============================================================

  /**
   * 运行自我验证——KEPA循环的质量保障环节。
   * 依次执行：飞轮三道门 → 金丝雀部署 → 自反思证伪。
   *
   * @param {string} generationId - 生成请求ID
   * @returns {Promise<{passed: boolean, generationId: string, skillId: string, details: object}>}
   */
  async _runVerification(generationId) {
    const candidate = this._verifyingCandidates.get(generationId);
    if (!candidate) {
      return { passed: false, generationId, skillId: null, details: { reason: 'not found' } };
    }

    this._phase = KEPA_PHASES.VERIFY;
    const details = {};

    // 步骤1：飞轮三道门验证（如果SkillImprovementLoop可用）
    if (this._skillImprovementLoop) {
      details.flywheel = await this._verifyFlywheel(candidate);
      if (!details.flywheel.passed) {
        return this._verificationFailed(generationId, candidate, details, 'flywheel');
      }
    }

    // 步骤2：金丝雀部署验证（如果SkillCanary可用）
    if (this._skillCanary) {
      details.canary = await this._verifyCanary(candidate);
      if (!details.canary.passed) {
        return this._verificationFailed(generationId, candidate, details, 'canary');
      }
    }

    // 步骤3：自反思证伪检查（如果SelfReflection可用）
    if (this._selfReflection) {
      details.reflection = await this._verifySelfReflection(candidate);
      if (!details.reflection.passed) {
        return this._verificationFailed(generationId, candidate, details, 'reflection');
      }
    }

    // 步骤4：质量评分验证（如果QualityScorer可用）
    if (this._qualityScorer) {
      details.quality = await this._verifyQuality(candidate);
      if (!details.quality.passed) {
        return this._verificationFailed(generationId, candidate, details, 'quality');
      }
    }

    // 全部验证通过 → 晋升
    return this._promoteCandidate(generationId, candidate, details);
  }

  /**
   * 手动触发验证（用于需要人工审批后的场景）
   *
   * @param {string} generationId - 生成请求ID
   * @returns {Promise<{passed: boolean, generationId: string, skillId: string, details: object}>}
   */
  async verifyCandidate(generationId) {
    this.guardShutdown();
    return this._runVerification(generationId);
  }

  // ============================================================
  // 心跳循环
  // ============================================================

  /**
   * 启动KEPA循环心跳
   */
  start() {
    this.guardShutdown();
    if (this._heartbeatTimer) return;

    debug('KepaOrchestrator', 'start', 'heartbeat=' + this._config.heartbeatMs + 'ms');
    this._heartbeatTimer = setInterval(() => {
      if (this._shutDown) return;
      this._heartbeat().catch(function(err) {
        debug('KepaOrchestrator', 'heartbeat', err && err.message ? err.message : String(err));
      });
    }, this._config.heartbeatMs);
    if (this._heartbeatTimer && typeof this._heartbeatTimer.unref === 'function') {
      this._heartbeatTimer.unref();
    }

    if (this._config.autoStart) {
      safeExecute(() => this._heartbeat());
    }
  }

  /**
   * 停止KEPA循环心跳
   */
  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._phase = KEPA_PHASES.IDLE;
    debug('KepaOrchestrator', 'stop');
  }

  /**
   * 强制执行一次完整KEPA循环
   *
   * @returns {Promise<{cycle: number, collected: number, generated: number, verified: number, promoted: number}>}
   */
  async forceCycle() {
    this.guardShutdown();
    return this._heartbeat();
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取KEPA编排器统计信息
   *
   * @returns {{phase: string, cycleCount: number, experienceCount: number, generationQueueSize: number, verifyingCount: number, promotedCount: number, rolledBackCount: number}}
   */
  getStats() {
    let experienceCount = 0;
    for (const [, arr] of this._experiences) {
      experienceCount += arr.length;
    }
    return {
      phase: this._phase,
      cycleCount: this._cycleCount,
      experienceCount,
      generationQueueSize: this._generationQueue.size,
      verifyingCount: this._verifyingCandidates.size,
      promotedCount: this._promotedCount,
      rolledBackCount: this._rolledBackCount,
    };
  }

  /**
   * 获取指定技能的经验条目
   *
   * @param {string} skillId - 技能ID
   * @returns {Array<object>}
   */
  getExperiences(skillId) {
    const arr = this._experiences.get(skillId);
    return arr ? arr.slice() : [];
  }

  /**
   * 获取当前验证中的候选列表
   *
   * @returns {Array<object>}
   */
  getVerifyingCandidates() {
    const result = [];
    for (const [, v] of this._verifyingCandidates) {
      result.push(JSON.parse(JSON.stringify(v)));
    }
    return result;
  }

  /**
   * 获取已晋升技能列表
   *
   * @returns {Array<object>}
   */
  getPromotedSkills() {
    const result = [];
    for (const [, v] of this._promotedSkills) {
      result.push(JSON.parse(JSON.stringify(v)));
    }
    return result;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 心跳：执行一次完整的KEPA循环 */
  async _heartbeat() {
    if (this._cycling) return;
    this._cycling = true;

    let collected = 0;
    let generated = 0;
    let verified = 0;
    let promoted = 0;

    try {
      // 阶段1：收集经验（从DreamEngine同步）
      this._phase = KEPA_PHASES.COLLECT;
      if (this._dreamEngine) {
        const syncResult = await this.syncFromDreamEngine();
        collected = syncResult.synced;

        // 自动触发生成
        for (const skillId of syncResult.triggered) {
          await this.triggerGeneration(skillId, { strategy: 'auto', requireApproval: false });
          generated++;
        }
      }

      // 阶段2：处理待验证候选
      this._phase = KEPA_PHASES.VERIFY;
      const candidateIds = [];
      for (const [id] of this._verifyingCandidates) {
        candidateIds.push(id);
      }
      for (const id of candidateIds) {
        const result = await this._runVerification(id);
        verified++;
        if (result.passed) promoted++;
      }

      // 清理过期经验
      this._expireExperiences();

      this._cycleCount++;
      this._phase = KEPA_PHASES.IDLE;

      this.emit('cycle-completed', {
        cycle: this._cycleCount,
        collected,
        generated,
        verified,
        promoted,
      });

      debug('KepaOrchestrator', 'heartbeat', 'cycle=' + this._cycleCount,
        'collected=' + collected, 'generated=' + generated,
        'verified=' + verified, 'promoted=' + promoted);
    } catch (err) {
      debug('KepaOrchestrator', 'heartbeat', err && err.message ? err.message : String(err));
      this.emit('kepa-error', { phase: this._phase, error: err });
      this._phase = KEPA_PHASES.IDLE;
    } finally {
      this._cycling = false;
    }

    return { cycle: this._cycleCount, collected, generated, verified, promoted };
  }

  /** 检查指定技能的经验是否达到生成阈值 */
  _checkGenerationThreshold(skillId) {
    const experiences = this._experiences.get(skillId) ?? [];
    const validExperiences = experiences.filter(function(e) {
      return Date.now() - e.collectedAt < (this._config.experienceTtlMs);
    }.bind(this));
    return validExperiences.length >= this._config.minExperiencesForGeneration;
  }

  /** 通过SkillEvolver生成 */
  async _generateViaEvolver(skillId, _opts) {
    if (!this._skillEvolver) return { success: false, reason: 'SkillEvolver not attached' };

    const experiences = this._experiences.get(skillId) ?? [];
    const sessionTraces = experiences.map(function(e) {
      return {
        sessionId: e.context.sessionId || e.id,
        steps: e.context.steps ?? [],
        outcome: e.outcome || { success: e.type === EXPERIENCE_TYPES.SUCCESS },
        description: e.description,
      };
    });

    const result = await this._skillEvolver.evolve(skillId, sessionTraces);
    return {
      success: result && result.success,
      candidate: result,
      strategy: 'evolve',
    };
  }

  /** 通过SkillDistiller生成 */
  async _generateViaDistiller(skillId, _opts) {
    if (!this._skillDistiller) return { success: false, reason: 'SkillDistiller not attached' };

    const result = await this._skillDistiller.fullDistillationPipeline(skillId, {
      maxIterations: 3,
    });
    return {
      success: result && result.status === 'converged',
      candidate: result,
      strategy: 'distill',
    };
  }

  /** 通过SkillCreationEngine创建新技能 */
  async _generateViaCreation(skillId, _opts) {
    if (!this._skillCreationEngine) return { success: false, reason: 'SkillCreationEngine not attached' };

    const experiences = this._experiences.get(skillId) ?? [];
    const patterns = experiences
      .filter(function(e) { return e.type === EXPERIENCE_TYPES.SUCCESS; })
      .map(function(e) { return e.description; });

    return {
      success: patterns.length > 0,
      candidate: { skillId, patterns, source: 'kepa-creation' },
      strategy: 'create',
    };
  }

  /** 飞轮三道门验证 */
  async _verifyFlywheel(candidate) {
    try {
      const experiences = this._experiences.get(candidate.skillId) ?? [];
      const successCount = experiences.filter(function(e) {
        return e.type === EXPERIENCE_TYPES.SUCCESS;
      }).length;
      const total = experiences.length;
      const rate = total > 0 ? successCount / total : 0;

      // 第一道门：成功率
      if (successCount < this._config.minVerifyRounds) {
        return { passed: false, reason: 'insufficient_success_count', successCount, required: this._config.minVerifyRounds };
      }

      // 第二道门：通过率
      if (rate < this._config.verifyPassRate) {
        return { passed: false, reason: 'below_pass_rate', rate: rate, required: this._config.verifyPassRate };
      }

      // 第三道门：最小验证轮次
      if (total < this._config.minVerifyRounds) {
        return { passed: false, reason: 'insufficient_rounds', rounds: total, required: this._config.minVerifyRounds };
      }

      return { passed: true, successCount, total, rate };
    } catch (err) {
      return { passed: false, reason: 'error', error: err && err.message ? err.message : String(err) };
    }
  }

  /** 金丝雀验证 */
  async _verifyCanary(candidate) {
    try {
      if (!this._skillCanary) return { passed: true, reason: 'no_canary' };

      // 查询金丝雀状态
      const status = this._skillCanary.getStatus(candidate.skillId);
      if (!status) return { passed: true, reason: 'no_active_canary' };

      if (status.phase === 'promoted') return { passed: true, phase: 'promoted' };
      if (status.phase === 'rolled_back') return { passed: false, phase: 'rolled_back', reason: 'canary_rollback' };

      return { passed: true, phase: status.phase, trafficPercent: status.trafficPercent };
    } catch (err) {
      return { passed: true, reason: 'error_fallback', error: err && err.message ? err.message : String(err) };
    }
  }

  /** 自反思证伪验证 */
  async _verifySelfReflection(candidate) {
    try {
      if (!this._selfReflection) return { passed: true, reason: 'no_reflection' };

      const result = await this._selfReflection.reflect({
        skillId: candidate.skillId,
        artifactType: 'skill',
      });

      // 如果反思建议回滚，则验证失败
      if (result && result.recommendedAction === 'rollback-and-revise') {
        return { passed: false, reason: 'reflection_rollback', qualityTrend: result.qualityTrend };
      }

      return { passed: true, qualityTrend: result ? result.qualityTrend : 'unknown' };
    } catch (err) {
      return { passed: true, reason: 'error_fallback', error: err && err.message ? err.message : String(err) };
    }
  }

  /** 质量评分验证 */
  async _verifyQuality(candidate) {
    try {
      if (!this._qualityScorer) return { passed: true, reason: 'no_scorer' };

      const result = this._qualityScorer.score(candidate.candidate || candidate.skillId);
      const passed = result && result.total >= 0.6;

      return { passed, score: result ? result.total : 0, grade: result ? result.grade : 'unknown' };
    } catch (err) {
      return { passed: true, reason: 'error_fallback', error: err && err.message ? err.message : String(err) };
    }
  }

  /** 验证失败处理 */
  _verificationFailed(generationId, candidate, details, failedAt) {
    candidate.verifyRounds++;
    this.emit('verification-failed', {
      generationId, skillId: candidate.skillId, failedAt, details,
    });

    // 超过最大验证轮次则回滚
    if (candidate.verifyRounds >= this._config.minVerifyRounds * 2) {
      this._rollbackCandidate(generationId, candidate, 'max_verify_rounds_exceeded');
    }

    this._phase = KEPA_PHASES.IDLE;
    return { passed: false, generationId, skillId: candidate.skillId, details, failedAt };
  }

  /** 晋升候选技能 */
  _promoteCandidate(generationId, candidate, details) {
    this._verifyingCandidates.delete(generationId);
    this._promotedSkills.set(generationId, {
      ...candidate,
      promotedAt: Date.now(),
      verificationDetails: details,
    });
    this._promotedCount++;

    // 清理已晋升技能的经验缓冲区
    this._experiences.delete(candidate.skillId);

    this.emit('skill-promoted', {
      generationId, skillId: candidate.skillId, strategy: candidate.strategy, details,
    });
    this.emit('verification-passed', {
      generationId, skillId: candidate.skillId, details,
    });

    this._phase = KEPA_PHASES.IDLE;
    debug('KepaOrchestrator', 'promoteCandidate', candidate.skillId, candidate.strategy);

    return { passed: true, generationId, skillId: candidate.skillId, details };
  }

  /** 回滚候选技能 */
  _rollbackCandidate(generationId, candidate, reason) {
    this._verifyingCandidates.delete(generationId);
    this._rolledBackCount++;

    this.emit('skill-rolled-back', {
      generationId, skillId: candidate.skillId, reason,
    });

    debug('KepaOrchestrator', 'rollbackCandidate', candidate.skillId, reason);
  }

  /** 清理过期经验 */
  _expireExperiences() {
    const now = Date.now();
    const ttl = this._config.experienceTtlMs;
    const toDelete = [];

    for (const [skillId, experiences] of this._experiences) {
      const filtered = experiences.filter(function(e) { return now - e.collectedAt < ttl; });
      if (filtered.length === 0) {
        toDelete.push(skillId);
      } else if (filtered.length !== experiences.length) {
        this._experiences.set(skillId, filtered);
      }
    }

    for (const skillId of toDelete) {
      this._experiences.delete(skillId);
    }
  }

  /** 关闭处理 */
  _onShutdown() {
    this.stop();
    this._experiences.clear();
    this._generationQueue.clear();
    this._verifyingCandidates.clear();
    this.removeAllListeners();
    debug('KepaOrchestrator', 'shutdown');
  }
}

const KepaOrchestratorWithShutdown = withShutdown(KepaOrchestrator);

Object.assign(module.exports, {
  KepaOrchestrator,
  KepaOrchestratorWithShutdown,
  KEPA_PHASES,
  EXPERIENCE_TYPES,
  GENERATION_STATUS,
});
