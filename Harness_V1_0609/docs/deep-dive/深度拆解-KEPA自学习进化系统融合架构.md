# 深度拆解 — KEPA自学习进化系统融合架构

## 一、融合背景与动机

### 1.1 两套技术路线的对比

| 维度 | OpenClaw/Harness策略 | Hermes/KEPA策略 |
|------|---------------------|-----------------|
| 核心逻辑 | 工具编排：开发者预设工具和策略 | 知识进化：Agent自主生成和优化技能 |
| 能力边界 | 由开发者定义，不会创造新能力 | 由学习过程决定，理论上可突破预设边界 |
| 稳定性 | 生产级，可控可审计 | 早期阶段，自学习效果待验证 |
| 适用场景 | 企业落地、团队协作 | 长期潜力、自我突破 |

### 1.2 融合必要性评估

当前Harness项目已具备KEPA三大循环的**90%基础设施**：

- **经验收集**：DreamEngine、SkillDistiller.captureTrace()、SkillMemoryStore、AutoReinLearningLoop
- **技能生成**：SkillEvolver、SkillDistiller.fullDistillationPipeline()、SkillCreationEngine
- **自我验证**：SkillImprovementLoop飞轮三道门、SkillCanary金丝雀、SelfReflection证伪、QualityScorer评分

**关键缺失**：统一的闭环调度器，将分散模块串联为自动运行的KEPA循环。

### 1.3 融合可行性评估

| 评估维度 | 评分 | 说明 |
|----------|------|------|
| 功能匹配度 | ★★★★★ | 21个技能模块+14个自学习模块已覆盖KEPA三大循环 |
| 技术兼容性 | ★★★★★ | 编排层融合，零侵入，不修改任何现有模块 |
| 性能影响 | ★★★★☆ | 心跳循环默认60s，增量同步，不阻塞主流程 |
| 可维护性 | ★★★★★ | 统一入口替代分散调用，依赖注入零耦合 |
| 开发效率 | ★★★★☆ | 自动触发替代手动调度，减少人工干预 |

## 二、KepaOrchestrator架构设计

### 2.1 模块定位

```
┌──────────────────────────────────────────────────────────┐
│                    KepaOrchestrator                       │
│                   （闭环编排层）                            │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│  │ 循环1     │───→│ 循环2     │───→│ 循环3     │           │
│  │ 经验收集  │    │ 技能生成  │    │ 自我验证  │           │
│  └──────────┘    └──────────┘    └──────────┘           │
│       ↑                               │                  │
│       └───────── 晋升/回滚 ───────────┘                  │
└──────────────────────────────────────────────────────────┘
         │              │              │
         ↓              ↓              ↓
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ DreamEngine │ │SkillEvolver │ │SkillImprovement│
│ SkillDistiller│ │SkillDistiller│ │Loop(飞轮)     │
│ SkillMemory │ │SkillCreation│ │SkillCanary    │
│ AutoRein    │ │Engine       │ │SelfReflection │
│ LearningLoop│ │             │ │QualityScorer  │
└─────────────┘ └─────────────┘ └─────────────┘
```

### 2.2 循环1：经验收集（Experience Collection）

**统一入口**：`collectExperience(experience)`

经验数据流：
```
任务执行结果 → collectExperience()
                  ├──→ _experiences 缓冲区（按skillId分组）
                  ├──→ SkillMemoryStore.storeExperience()（持久化）
                  ├──→ SkillDistiller.captureTrace()（追踪）
                  └──→ AutoReinLearningLoop.processTaskResult()（规则生成）
                        │
                        └──→ 经验数 ≥ 阈值 → 自动触发 triggerGeneration()
```

经验类型映射：
| KEPA类型 | SkillMemoryStore类型 | 说明 |
|----------|---------------------|------|
| success | tip | 成功经验→技巧 |
| failure | avoidance | 失败经验→规避项 |
| partial/feedback | pattern | 部分成功→模式 |

### 2.3 循环2：技能生成（Skill Generation）

**核心方法**：`triggerGeneration(skillId, options)`

生成策略选择：
```
triggerGeneration(skillId, { strategy: 'auto' })
    │
    ├── strategy === 'auto' || 'evolve'
    │   └── _generateViaEvolver(skillId)
    │       ├── SkillEvolver.evolve(skillId, sessionTraces)
    │       │   └── 三阶段：summarize → aggregate → execute
    │       └── 失败 && strategy === 'auto'
    │           └── _generateViaDistiller(skillId)  ← 回退
    │
    ├── strategy === 'distill'
    │   └── _generateViaDistiller(skillId)
    │       └── SkillDistiller.fullDistillationPipeline(skillId)
    │           └── trace → pattern → distillation → rewrite → eval → canary
    │
    └── strategy === 'create'
        └── _generateViaCreation(skillId)
            └── SkillCreationEngine（从成功经验提取模式）
```

### 2.4 循环3：自我验证（Self-Verification）

**四层验证流水线**：
```
_runVerification(generationId)
    │
    ├── 层1：飞轮三道门（SkillImprovementLoop）
    │   ├── 门1：成功率 ≥ minVerifyRounds
    │   ├── 门2：通过率 ≥ verifyPassRate
    │   └── 门3：验证轮次 ≥ minVerifyRounds
    │
    ├── 层2：金丝雀部署（SkillCanary）
    │   └── 检查金丝雀状态：promoted/rolled_back/进行中
    │
    ├── 层3：自反思证伪（SelfReflection）
    │   └── recommendedAction !== 'rollback-and-revise'
    │
    └── 层4：质量评分（QualityScorer）
        └── total ≥ 0.6（acceptable以上）
            │
            ├── 全部通过 → _promoteCandidate()
            │   └── 清理经验缓冲区 + 发射skill-promoted事件
            │
            └── 任一层失败 → _verificationFailed()
                └── verifyRounds ≥ 阈值*2 → _rollbackCandidate()
```

### 2.5 心跳循环

```
start() → setInterval(_heartbeat, 60s)
              │
              ├── 阶段1：syncFromDreamEngine()
              │   └── 自动触发生成（经验达阈值的技能）
              │
              ├── 阶段2：处理待验证候选
              │   └── 对每个verifyingCandidate执行_runVerification()
              │
              ├── 阶段3：清理过期经验
              │   └── 超过experienceTtlMs的经验自动清除
              │
              └── 发射cycle-completed事件
```

## 三、依赖注入与模块集成

### 3.1 14个挂载点

| 挂载方法 | 模块 | 循环角色 |
|----------|------|----------|
| attachDreamEngine | DreamEngine | 经验源（笔记同步） |
| attachSkillDistiller | SkillDistiller | 经验接收+生成器 |
| attachSkillEvolver | SkillEvolver | 生成器（三阶段演化） |
| attachSkillMemoryStore | SkillMemoryStore | 经验持久化 |
| attachSkillImprovementLoop | SkillImprovementLoop | 验证器（飞轮三道门） |
| attachSkillCanary | SkillCanary | 验证器（金丝雀部署） |
| attachSkillRouter | SkillRouter | 技能发现与匹配 |
| attachSelfReflection | SelfReflection | 验证器（证伪检查） |
| attachQualityScorer | QualityScorer | 验证器（质量评分） |
| attachAutoReinLearningLoop | AutoReinLearningLoop | 经验接收+规则生成 |
| attachSelfEvolutionGovernor | SelfEvolutionGovernor | 治理层 |
| attachSkillCreationEngine | SkillCreationEngine | 生成器（新技能创建） |
| attachSkillPatchApproval | SkillPatchApproval | 审批层 |
| attachLlmClient | LLM客户端 | 生成器依赖 |

### 3.2 集成示例

```javascript
const { KepaOrchestratorWithShutdown } = require('./runtime/skill/kepa-orchestrator');

// 创建KEPA编排器
const kepa = new KepaOrchestratorWithShutdown({
  heartbeatMs: 60000,
  minExperiencesForGeneration: 5,
  verifyPassRate: 0.6,
  autoStart: true,
});

// 注入依赖
kepa
  .attachDreamEngine(dreamEngine)
  .attachSkillDistiller(skillDistiller)
  .attachSkillEvolver(skillEvolver)
  .attachSkillMemoryStore(skillMemoryStore)
  .attachSkillImprovementLoop(skillImprovementLoop)
  .attachSkillCanary(skillCanary)
  .attachSelfReflection(selfReflection)
  .attachQualityScorer(qualityScorer)
  .attachAutoReinLearningLoop(autoReinLearningLoop);

// 启动KEPA循环
kepa.start();

// 手动收集经验
kepa.collectExperience({
  skillId: 'tdd-implement',
  type: 'success',
  description: 'Red-Green-Refactor循环在3步内通过',
  confidence: 0.9,
});

// 手动触发生成
await kepa.triggerGeneration('tdd-implement', { strategy: 'auto' });

// 查看统计
kepa.getStats();
```

## 四、事件体系

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| experience-collected | {id, skillId, type, generationTriggered} | 经验已收集 |
| generation-triggered | {generationId, skillId, strategy} | 生成已触发 |
| generation-completed | {generationId, skillId, strategy, success} | 生成已完成 |
| verification-passed | {generationId, skillId, details} | 验证通过 |
| verification-failed | {generationId, skillId, failedAt, details} | 验证失败 |
| skill-promoted | {generationId, skillId, strategy, details} | 技能已晋升 |
| skill-rolled-back | {generationId, skillId, reason} | 技能已回滚 |
| cycle-completed | {cycle, collected, generated, verified, promoted} | 循环完成 |
| kepa-error | {phase, error} | 循环错误 |

## 五、配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| heartbeatMs | 60000 | 心跳间隔（毫秒） |
| minExperiencesForGeneration | 5 | 触发生成的最小经验数 |
| minVerifyRounds | 3 | 最小验证轮次 |
| verifyPassRate | 0.6 | 验证通过率阈值 |
| experienceTtlMs | 604800000 | 经验过期时间（7天） |
| autoStart | false | 是否自动启动循环 |

## 六、回滚机制

1. **验证失败回滚**：verifyRounds超过阈值*2时自动回滚
2. **金丝雀回滚**：SkillCanary检测到性能回归时自动回滚
3. **自反思回滚**：SelfReflection建议rollback-and-revise时验证失败
4. **熔断器**：连续验证失败超过阈值时暂停生成阶段
5. **人工审批**：requireApproval=true时需人工确认才晋升

## 七、与现有系统的关系

KepaOrchestrator是**纯编排层**，不替代任何现有模块：

| 现有模块 | KEPA中的角色 | 是否修改 |
|----------|-------------|---------|
| DreamEngine | 经验源 | 否 |
| SkillDistiller | 经验接收+生成器 | 否 |
| SkillEvolver | 生成器 | 否 |
| SkillMemoryStore | 经验持久化 | 否 |
| SkillImprovementLoop | 验证器 | 否 |
| SkillCanary | 验证器 | 否 |
| SelfReflection | 验证器 | 否 |
| QualityScorer | 验证器 | 否 |
| AutoReinLearningLoop | 经验接收 | 否 |
| SelfEvolutionGovernor | 治理层 | 否 |

所有模块通过attach*()方法注入，KepaOrchestrator仅调用其公共API，不修改其内部实现。
