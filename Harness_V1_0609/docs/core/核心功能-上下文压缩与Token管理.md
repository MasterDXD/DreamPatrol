# 核心功能-上下文压缩与Token管理

> 版本：2.73.4 | 模块：src/runtime/context/、src/runtime/model/token-manager.js

---

## 概述

上下文压缩与Token管理是Harness Engineering多Agent框架的资源管控核心，负责在Token预算约束下智能管理上下文内容，确保关键信息不丢失的同时最大化Token利用效率。系统由五个紧密协作的模块构成：

- **ContextCompressionEngine** — 上下文压缩引擎。智能分类（keep/summarize/discard）、Token估算、压缩计划生成
- **TokenManager** — Token使用量追踪、预算阈值检查（80%/95%/100%三级预警）、分类统计
- **IsolatedContextManager** — Agent间上下文隔离、共享边界控制、访问控制策略
- **PhaseContextInjector** — 根据执行阶段自动注入相关规则、Agent定义和核心身份文档
- **AutoregressiveContextSchema** — 上下文自回归生成与验证，支持迭代深化推理的状态传递

五者共同实现"按需加载、智能压缩、隔离安全、预算可控"的上下文管理目标。

### 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                   上下文压缩与Token管理子系统                         │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  ContextCompressionEngine                     │  │
│  │                                                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │  │
│  │  │ compress │  │ should   │  │ getComp  │  │ compressOut  │ │  │
│  │  │ (压缩)   │  │ Compress │  │ ression  │  │ put/toolOut  │ │  │
│  │  │          │  │ (判断)   │  │ Plan     │  │ (输出压缩)   │ │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘ │  │
│  │       │              │              │               │         │  │
│  │       ▼              ▼              ▼               ▼         │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │  _classifySkill → _determineSkillCategory → _applyStrat │ │  │
│  │  │  因果覆盖 → 规格资产 → 阶段分类 → full/summary/discard  │ │  │
│  │  └──────────────────────────┬──────────────────────────────┘ │  │
│  │                             │                                │  │
│  │       ┌─────────────────────┼─────────────────────┐          │  │
│  │       ▼                     ▼                     ▼          │  │
│  │  ┌──────────┐      ┌──────────────┐      ┌──────────────┐   │  │
│  │  │增量跳过  │      │ 计划缓存     │      │ 因果感知     │   │  │
│  │  │StateHash │      │ PlanCache    │      │ CausalValid  │   │  │
│  │  └──────────┘      └──────────────┘      └──────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────┐  ┌───────────────────────────────┐   │
│  │     TokenManager         │  │   IsolatedContextManager      │   │
│  │                          │  │                               │   │
│  │  store → validate        │  │  createIsolatedContext        │   │
│  │  addBreakdown → getBreak │  │  grantContextAccess           │   │
│  │  warning80/95/exhausted  │  │  getContext → ACL检查        │   │
│  │  formatTokens/parseFmt   │  │  submitResult → completed    │   │
│  └──────────┬───────────────┘  └───────────────┬───────────────┘   │
│             │                                    │                  │
│             ▼                                    ▼                  │
│  ┌──────────────────────────┐  ┌───────────────────────────────┐   │
│  │   PhaseContextInjector   │  │ AutoregressiveContextSchema   │   │
│  │                          │  │                               │   │
│  │  injectForPhase          │  │  inject → extract → merge     │   │
│  │  PHASE_RULES_MAP         │  │  validate → compatibilityChk  │   │
│  │  PHASE_AGENTS_MAP        │  │  strip → 清除上下文          │   │
│  │  CoreIdentity提取        │  │  FIELDS/SOURCE_IDS/VERSION    │   │
│  └──────────────────────────┘  └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## ContextCompressionEngine详解

> 源码：[context-compression-engine.js](file:///e:/Harness_V1_0429/src/runtime/context/context-compression-engine.js)

### 智能分类算法（keep/summarize/discard三级分类）

ContextCompressionEngine的核心能力是对上下文中的每个Skill条目进行智能分类，根据分类结果应用不同的压缩策略。分类过程由`_determineSkillCategory()`驱动，遵循严格的优先级链：

**分类优先级链**：

```
1. 因果覆盖检测（_matchSkillPattern）
   → CausalBufferManager已连接 且 Skill已完成 且 当前SkillId已设置？
     → getCompressionStrategy(skillId, currentSkillId)
     → 'full' → causal_relevance_high（保留）
     → 'summary' → causal_relevance_medium（摘要）
     → 其他 → causal_relevance_low（丢弃）
   → ConfigCausalValidator已连接 且 Skill已完成？
     → _isCausalUpstream(skillId, currentPhase)
     → true → causal_upstream（保留）

2. 规格资产检测（_hasSpecificationOutput）
   → Skill的causal_outputs中包含'specification'输出
   → 标记为 specification_asset（强制full策略，不可更改）

3. 阶段分类
   → current_phase：Skill的phase与当前执行阶段一致
   → completed_phase：Skill的skill_id在completedSkills集合中
   → future_phase：Skill的phase在当前阶段之后
   → unclassified：无法归入以上三类
```

**三级策略详解**：

| 策略 | 行为 | Token效果 | 适用内容 |
|------|------|----------|---------|
| **full** | 保留原文，不做压缩 | 压缩后Token = 原始Token | 当前阶段指令、规格资产、因果高相关Skill |
| **summary** | 仅保留summary字段 | 压缩后Token = summaryTokenEstimate | 已完成阶段、未来阶段、因果中等相关Skill |
| **discard** | 完全丢弃 | 压缩后Token = 0 | 临时数据、因果低相关Skill |

**策略应用中的安全保护**：当summary策略下summaryTokens ≥ instructionTokens时（即摘要比原文还长），自动回退为full策略，避免"压缩反而膨胀"的反模式。

### Token估算方法

引擎提供两种Token估算机制：

**1. 内部估算（`_estimateTokens`）**

ContextCompressionEngine内置的Token估算方法，用于Skill指令和摘要的Token计数：

```
非ASCII字符数 = text.match(/[\x80-\uFFFF]/g).length
ASCII字符数 = text.length - 非ASCII字符数
Token数 = ceil((ASCII字符数 + 非ASCII字符数 × 2) / tokenCharsRatio)
```

- ASCII字符：每4个字符约1个Token（默认tokenCharsRatio=4）
- 非ASCII字符（中文等）：每2个字符约1个Token（权重×2）
- 此为近似估算，实际Token消耗取决于模型分词器

**2. 全局估算（`estimateTokens`，来自constants.js）**

项目级Token估算函数，用于IsolatedContextManager等模块：

```
CJK字符数 = 统计Unicode范围 0x4E00-0x9FFF、0x3400-0x4DBF、
            0x3000-0x303F、0xFF00-0xFFEF、0xAC00-0xD7AF
非CJK长度 = text.length - CJK字符数
Token数 = ceil(非CJK长度 / 4 + CJK字符数 / 1.5)
```

两种算法的差异：内部估算使用宽泛的非ASCII匹配（0x80以上），全局估算精确识别CJK字符范围。全局估算更精确但计算成本略高。

### 压缩计划生成

`getCompressionPlan(context)`方法生成压缩预览，不执行实际压缩，用于决策参考：

```javascript
const plan = engine.getCompressionPlan({
  currentPhase: 'module-development',
  skills: [...],
  completedSkills: ['brainstorming', 'requirement-analysis'],
});

// 返回结构：
{
  retain: [
    { skill_id: 'tdd-implement', reason: 'current_phase_full', strategy: 'full' },
    { skill_id: 'brainstorming', reason: 'causal_upstream', strategy: 'full' },
  ],
  compress: [
    { skill_id: 'requirement-analysis', reason: 'completed_phase', strategy: 'summary', savings: 1200 },
    { skill_id: 'deployment', reason: 'future_phase', strategy: 'summary', savings: 800 },
  ],
  estimatedSavings: 2000,
}
```

**计划缓存机制**：

- 缓存键：`currentPhase:sortedSkillIds:sortedCompletedIds`
- 最大缓存条目：50（`_planCacheMaxSize`）
- 淘汰策略：FIFO（超出上限时删除最早插入的条目）
- 缓存命中时`cacheHits`计数器递增，避免重复分类计算

### 压缩触发条件

`shouldCompress(context)`方法判断是否需要触发压缩：

```javascript
shouldCompress({ tokensUsed, tokenBudget })
```

**触发逻辑**：

1. 若tokenBudget ≤ 0：只要有tokensUsed > 0即触发
2. 若tokenBudget > 0：tokensUsed / tokenBudget ≥ threshold（默认0.8）时触发
3. 关机状态：始终返回false

**触发阈值配置**：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `threshold` | `TOKEN_BUDGET_WARNING_RATIO`（0.8） | 触发压缩的Token使用率阈值 |

### 输出压缩

除Skill上下文压缩外，引擎还提供两种输出压缩能力：

**1. 文本输出压缩（`compressOutput`）**

针对LLM生成的文本输出进行压缩，支持：
- 去除填充词（Sure, Great question, Let me explain等）
- 去除冗余注释（保留TODO/FIXME/HACK/NOTE/IMPORTANT标记注释）
- 超长内容截断（优先保留代码块，按句子边界截断）
- 最大长度限制（默认2000字符）

**2. 工具调用输出压缩（`compressToolOutput`）**

针对工具调用返回结果进行压缩，支持：
- 字符串行压缩：去重、正则过滤、重复行合并、截断
- 对象输出压缩：截断长字符串、限制数组长度、保留指定键
- ReDoS防护：拒绝超过200字符或含危险量词嵌套的正则模式

---

## TokenManager详解

> 源码：[token-manager.js](file:///e:/Harness_V1_0429/src/runtime/model/token-manager.js)

### 使用量追踪机制

TokenManager通过`_sessionTokens`（Map）和`_sessionBreakdowns`（Map）两个核心数据结构实现Token使用量的追踪：

**核心数据结构**：

```
_sessionTokens: Map<sessionId, number>
  → 每个会话的Token累计总量

_sessionBreakdowns: Map<sessionId, Object>
  → 每个会话的分类Token消耗明细
  → 结构：{ input: 2000, output: 1500, toolCall: 500 }
```

**`store(sessionId, amount)`执行流程**：

```
1. 关机检查 → SHUTDOWN错误
2. ID验证 → INVALID_SESSION_ID错误
3. 数值验证 → INVALID_TOKEN_AMOUNT错误
4. 预算检查 → 已耗尽则抛出BUDGET_EXCEEDED错误
5. 累加Token → _sessionTokens.set(sessionId, prev + amount)
6. LRU淘汰 → 会话数 ≥ maxSessions时驱逐最早会话
7. 预算验证 → validate()
8. 事件发射 → 根据阈值状态发射对应事件（互斥，只发射最高优先级）
```

**`set(sessionId, amount)`**：覆盖设置（非累加），同样触发预算验证和事件发射。

**容量控制**：当`_sessionTokens`大小达到`maxSessions`（默认1000）时，自动驱逐最早插入的会话条目。淘汰策略基于Map的插入顺序（FIFO）。

### 预算检查逻辑

`validate(sessionId, budget?)`方法是预算检查的核心，返回完整的预算状态对象：

```javascript
{
  sessionId: 'session-1',
  tokensUsed: 850000,
  budget: 1000000000,
  ratio: 0.85,
  warning80: true,    // ratio >= 0.8
  warning95: false,   // ratio >= 0.95
  exhausted: false,   // ratio >= 1.0
}
```

**预算优先级**：传入的budget参数优先于全局预算（`_globalBudget`），支持按会话自定义预算上限。

**事件发射规则**（在`store()`和`set()`中触发）：

```
validate() 结果判断（互斥，优先级从高到低）：
  → exhausted?  → emit('token-exhausted', { sessionId, tokensUsed, budget })
  → warning95?  → emit('token-warning-95', { sessionId, tokensUsed, budget })
  → warning80?  → emit('token-warning-80', { sessionId, tokensUsed, budget })
```

### 分类统计（输入/输出/工具调用三类Token）

`addBreakdown(sessionId, category, amount)`方法按类别记录Token消耗，支持任意自定义分类，典型分类为：

| 分类 | 说明 | 估算方法 |
|------|------|---------|
| `input` | 输入Token（用户消息、系统提示、注入上下文） | 输入字符数/4(英文)或/2(中文) |
| `output` | 输出Token（LLM生成内容） | 输出字符数/4(英文)或/2(中文) |
| `toolCall` | 工具调用Token（工具调用参数和返回值） | 每次工具调用约200-500 token |

```javascript
tokenMgr.addBreakdown('session-1', 'input', 2000);
tokenMgr.addBreakdown('session-1', 'output', 1500);
tokenMgr.addBreakdown('session-1', 'toolCall', 500);

const breakdown = tokenMgr.getBreakdown('session-1');
// { input: 2000, output: 1500, toolCall: 500 }

const allBreakdowns = tokenMgr.getAllBreakdowns();
// { 'session-1': { input: 2000, output: 1500, toolCall: 500 } }
```

**容量控制**：`_sessionBreakdowns`同样受`maxSessions`限制，超出时驱逐最早条目。

### 与SessionManager的集成

TokenManager与SessionManager通过事件机制紧密集成：

```
用户操作 → SessionManager.addTokenUsage(sessionId, tokens)
  → session.tokensUsed += tokens
  → SessionManager.checkBudget(sessionId)
  → 预算预警 → SessionManager.emit('budget-warning', { sessionId, tokensUsed, budget })
  → ModelSelector监听 → 自动降级决策
```

**SessionManager.checkBudget()**返回结构与TokenManager.validate()对应：

```javascript
{
  warning80: ratio >= TOKEN_BUDGET_WARNING_RATIO,  // 0.8
  warning95: ratio >= TOKEN_BUDGET_DANGER_RATIO,   // 0.95
  exhausted: ratio >= 1.0,
  ratio: roundTo(ratio, 2),
}
```

**ModelSelector.attachTokenManager()**建立事件监听：

```
TokenManager.on('token-warning-80') → ModelSelector._budgetConstrained = true
TokenManager.on('token-warning-95') → ModelSelector._budgetCritical = true
TokenManager.on('token-exhausted')  → ModelSelector._budgetExhausted = true
TokenManager.on('token-reset')      → 重置所有预算标志，emit('budget-recovered')
```

**配置热更新**：SessionManager通过`fs.watch`监控`.harness/config.json`变更，当`token_budget`或`phase_budget_allocation`变化时发射`budget-config-changed`事件。

### Token格式化工具

```javascript
tokenMgr.formatTokens(1500000);    // '1.5M'
tokenMgr.formatTokens(2500);       // '3K'
tokenMgr.formatTokens(2500000000); // '2.50B'
tokenMgr.formatTokens(42);         // '42'

tokenMgr.parseFormatted('1.5M');   // 1500000
tokenMgr.parseFormatted('3K');     // 3000
tokenMgr.parseFormatted('2.50B');  // 2500000000
```

| 单位 | 倍率 |
|------|------|
| K | 1,000 |
| M | 1,000,000 |
| B | 1,000,000,000 |

---

## IsolatedContextManager详解

> 源码：[isolated-context-manager.js](file:///e:/Harness_V1_0429/src/runtime/context/isolated-context-manager.js)

### Agent间上下文隔离机制

IsolatedContextManager为每个Agent任务创建隔离的执行上下文，确保Agent间的上下文不会互相干扰。核心设计原则：

**1. 上下文创建（`createIsolatedContext`）**

每个Agent任务获得独立的上下文空间，包含：

| 属性 | 说明 | 默认值 |
|------|------|--------|
| `contextId` | 唯一上下文ID | `ictx-{random}` |
| `agentId` | Agent角色ID | `'task-worker'` |
| `taskDescription` | 任务描述 | 必填 |
| `toolSet` | 可用工具集 | 按agentId分配默认工具集 |
| `systemPrompt` | 系统提示 | 按agentId自动生成 |
| `injectedContext` | 注入的上下文内容 | `''` |
| `constraints` | 约束条件列表 | `[]` |
| `successCriteria` | 成功标准列表 | `[]` |
| `outputFormat` | 输出格式 | `'structured'` |
| `tokenEstimate` | Token估算值 | 自动计算 |

**2. 访问控制列表（ACL）**

每个上下文创建时自动建立ACL：

```javascript
_accessControl.set(contextId, {
  owner: agentId,                    // 创建者即为所有者
  allowedAgents: new Set([agentId]), // 初始仅所有者可访问
});
```

**3. 上下文获取（`getContext`）**

获取上下文时需通过ACL检查：

```
getContext(contextId, requestingAgentId)
  → 上下文不存在？→ 返回null
  → requestingAgentId存在？
    → ACL检查：allowedAgents.has(requestingAgentId)?
    → 无权限 → emit('access-denied') → 返回null
    → 有权限 → 更新lastAccessedAt → 返回深拷贝
  → requestingAgentId不存在？→ 跳过ACL检查，直接返回
```

返回的是深拷贝，修改不影响内部状态，防止跨Agent上下文泄漏。

**4. 结果提交（`submitResult`）**

Agent完成任务后提交结果，上下文状态从`active`变为`completed`：

```javascript
submitResult(contextId, {
  output: '代码实现完成',
  summary: '实现了用户认证模块',    // 可选，未提供时自动生成
  confidence: 0.92,                // 可选，默认0.5
  evidence: [...],                 // 可选，证据列表
});
```

### 共享边界控制

**授权机制**：

```javascript
// 授予domain-analyst访问task-worker的上下文
icm.grantContextAccess('ictx-abc123', 'domain-analyst');

// 撤销访问权限（不允许撤销所有者自身的权限）
icm.revokeContextAccess('ictx-abc123', 'domain-analyst');
```

**共享边界规则**：

| 操作 | 规则 |
|------|------|
| 授权 | 任何已存在的contextId均可向任意agentId授权 |
| 撤销 | 不允许撤销所有者自身的权限（owner不可被移除） |
| 读取 | 需通过ACL检查，无权限触发`access-denied`事件 |
| 写入 | 仅通过`submitResult`提交结果，不允许直接修改上下文内容 |

### 隔离策略配置

**默认工具集分配**：

| Agent角色 | 默认工具集 |
|-----------|-----------|
| `task-worker` | `['read', 'write', 'search', 'run']` |
| `domain-analyst` | `['read', 'write', 'search', 'web']` |
| `quality-assurance` | `['read', 'search', 'run', 'web']` |
| `devops-engineer` | `['read', 'write', 'search', 'run']` |
| `technical-writer` | `['read', 'write', 'search']` |

**容量与淘汰策略**：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `maxContexts` | 20 | 最大上下文数量 |
| `maxContextSize` | 50000 | 单个上下文最大字符数（injectedContext） |
| `maxHistory` | 200 | 操作历史最大条目数（RingBuffer） |

**淘汰优先级**（`_evictOldest`）：

```
1. 优先驱逐已完成的上下文（status === 'completed'，按lastAccessedAt排序）
2. 其次驱逐已释放/失败的上下文（status === 'released' | 'failed'）
3. 最后驱逐最久未访问的活跃上下文（LRU），触发active-context-evicted事件
```

**系统提示自动生成**：

每个Agent角色有预定义的系统提示模板：

```
task-worker: "你是任务执行者。专注于: {taskDescription}
              可用工具: 读写文件、搜索代码、运行命令
              约束: 遵循TDD流程，先写测试后写实现"

domain-analyst: "你是领域分析师。专注于: {taskDescription}
                可用工具: 读写文件、搜索代码、网络搜索
                约束: 确保设计决策的一致性和合理性"
```

---

## PhaseContextInjector详解

> 源码：[phase-context-injector.js](file:///e:/Harness_V1_0429/src/runtime/context/phase-context-injector.js)

### 根据执行阶段自动注入相关上下文的机制

PhaseContextInjector的核心设计思想是**按需加载**：每个执行阶段仅加载该阶段所需的规则文件和Agent定义，避免全量加载导致Token浪费。

**注入流程**：

```
injectForPhase(phase)
  ↓
1. 阶段验证 → 无效阶段名降级为'brainstorming'
2. 缓存检查 → TTL内（60秒）命中缓存直接返回
3. 核心身份提取 → _extractCoreIdentity()
   → 读取CLAUDE.md，排除Agent/规则/Skill章节
   → 最多保留60行（CORE_IDENTITY_MAX_LINES）
4. 规则加载 → _loadRulesForPhase(phase)
   → 从.harness/rules/目录加载对应规则文件
5. Agent加载 → _loadAgentsForPhase(phase)
   → 从.harness/agents/目录加载对应Agent定义
6. 阶段技能 → PHASE_SKILLS[phase]
7. Token估算 → _estimateTokens()
   → 每行约15个Token（AVG_TOKENS_PER_LINE = 15）
8. 缓存写入 → 设置timestamp，TTL=60秒
9. 事件发射 → phase-context-injected
```

**核心身份提取（`_extractCoreIdentity`）**：

从项目根目录的`CLAUDE.md`文件中提取核心身份信息，排除以下章节：

| 排除章节 | 匹配模式 |
|---------|---------|
| Agent/角色 | `^##\s+Agent` 或 `^##\s+角色` |
| 全局规则 | `^##\s+全局规则` 或 `^##\s+Rules` |
| Skill/技能 | `^##\s+Skill` 或 `^##\s+技能` |

同时排除`@include`指令行。保留的内容包括项目概述、技术栈、核心原则等基础信息，最多60行。

**同步与异步接口**：

| 方法 | 说明 |
|------|------|
| `injectForPhase(phase)` | 同步注入，适用于启动和简单场景 |
| `injectForPhaseAsync(phase)` | 异步注入，适用于生产环境（非阻塞IO） |

生产环境建议使用异步接口，同步接口会输出`syncReadWarning`调试日志。

### 阶段-上下文映射表

**阶段→规则映射（PHASE_RULES_MAP）**：

| 阶段 | 规则文件 | 说明 |
|------|---------|------|
| `brainstorming` | context-management, cost-control, task-execution | 基础规则，3个 |
| `requirement-analysis` | + document-standards | 增加文档规范，4个 |
| `architecture-design` | + best-practices | 增加最佳实践，5个 |
| `module-development` | + coding-standards, karpathy-principles, monitoring-fault-tolerance, security-permissions | 编码阶段全量规则，9个 |
| `integration-testing` | context-management, cost-control, task-execution, best-practices, monitoring-fault-tolerance | 测试阶段精简规则，5个 |
| `deployment` | context-management, cost-control, task-execution, security-permissions, monitoring-fault-tolerance | 部署阶段安全优先，5个 |

**阶段→Agent映射（PHASE_AGENTS_MAP）**：

| 阶段 | Agent角色 | 说明 |
|------|----------|------|
| `brainstorming` | team-lead, domain-analyst | 创意探索，2个 |
| `requirement-analysis` | team-lead, domain-analyst | 需求分析，2个 |
| `architecture-design` | domain-analyst, team-lead | 架构设计，2个 |
| `module-development` | task-worker, domain-analyst, quality-assurance, code-reviewer, test-writer | 开发阶段全量Agent，5个 |
| `integration-testing` | quality-assurance, domain-analyst | 测试验证，2个 |
| `deployment` | devops-engineer, team-lead, technical-writer | 部署上线，3个 |

**阶段→技能映射（PHASE_SKILLS）**：

| 阶段 | 技能列表 |
|------|---------|
| `brainstorming` | brainstorming, idea-validation, ai-research |
| `requirement-analysis` | requirement-analysis |
| `architecture-design` | architecture-design |
| `module-development` | tdd-implement, module-development, dispatching-parallel, code-review, verification-before-completion, systematic-debugging, bug-fix, security-audit, performance-optimization, refactor-code, iterative-deepening, multi-agent-fusion, mvp-builder, optimization-loop, pair-chat, self-reflection |
| `integration-testing` | integration-testing |
| `deployment` | deployment, documentation, auto-doc-generation, ai-native-scaling |

**Token消耗估算**：

注入上下文的Token消耗通过行数估算：

```
estimatedTokens = (coreIdentityLines + rulesLines + agentsLines) × 15
```

其中`AVG_TOKENS_PER_LINE = 15`为经验值。可通过`getInjectedTokenEstimate()`获取最近一次注入的Token估算值。

**缓存机制**：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `CACHE_TTL_MS` | 60000 | 缓存有效期60秒 |
| 缓存键 | phase名称 | 每个阶段独立缓存 |
| 清除 | `clearCache()` | 手动清除所有缓存 |

---

## AutoregressiveContextSchema详解

> 源码：[autoregressive-context-schema.js](file:///e:/Harness_V1_0429/src/runtime/context/autoregressive-context-schema.js)

### 上下文自回归生成与验证的工作原理

AutoregressiveContextSchema实现了上下文的自回归生成与验证机制，为迭代深化推理提供状态传递能力。"自回归"意味着每次迭代的上下文基于前一次迭代的输出自动生成，形成递归式的上下文演化链。

**核心概念**：

- **自回归上下文**：存储在目标对象的`_ar`属性中，包含前次结果、质量历史、反馈等迭代状态
- **版本管理**：当前版本为1，通过`VERSION_FIELD_MAP`定义每个版本支持的字段集合
- **来源标识**：通过`SOURCE_IDS`标记上下文注入的来源模块

**字段定义（FIELDS）**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `previousResult` | string | 前次迭代的结果标识 |
| `previousScore` | number | 前次迭代的质量评分（0~1） |
| `qualityHistory` | array | 质量评分历史记录 |
| `feedback` | string | 反馈信息 |
| `previousOutput` | string | 前次迭代的输出内容 |
| `focusAreas` | array | 当前聚焦的改进领域 |
| `originalGoal` | string | 原始目标描述 |
| `iteration` | number | 当前迭代次数（≥0） |
| `maxIterations` | number | 最大迭代次数（1~100） |
| `iterationSummary` | string | 迭代摘要 |
| `source` | string | 来源标识 |

**来源标识（SOURCE_IDS）**：

| 来源ID | 模块 | 说明 |
|--------|------|------|
| `deepening-orchestrator` | DeepeningOrchestrator | 深化推理编排器注入 |
| `iterative-refinement` | IterativeRefinement | 迭代精化器注入 |
| `recurrent-deepening-scheduler` | RecurrentDeepeningScheduler | 循环深化调度器注入 |
| `skill-complete` | SessionManager | Skill完成时注入 |
| `phase-advance` | PhaseOrchestrator | 阶段推进时注入 |

### 核心API

**inject(target, fields)** — 注入自回归上下文

```
1. 危险键过滤 → DANGEROUS_KEYS（__proto__, constructor, prototype等）
2. 未知字段过滤 → 仅允许FIELDS中定义的字段
3. 字段数限制 → 最多20个字段（MAX_AR_FIELDS）
4. 字符串截断 → 超过2000字符截断（MAX_STRING_LENGTH）
5. 数组截断 → 超过100个元素截断（MAX_ARRAY_LENGTH）
6. 版本标记 → _version = 1
7. 时间戳 → updatedAt = Date.now()
```

**extract(target)** — 提取自回归上下文

从目标对象的`_ar`属性中提取上下文数据，排除`_version`和`updatedAt`元数据字段。

**merge(target, overrides)** — 合并上下文

提取现有上下文，与覆盖字段合并后重新注入：

```javascript
const merged = merge(target, { previousScore: 0.85, iteration: 3 });
```

**validate(target)** — 验证上下文数据

检查数值范围、数组类型和字符串类型的合法性：

| 验证项 | 规则 |
|--------|------|
| `previousScore` | 必须为0~1之间的数字 |
| `iteration` | 必须≥0的数字 |
| `maxIterations` | 必须1~100之间的数字 |
| `qualityHistory` | 必须为数组 |
| `focusAreas` | 必须为数组 |
| 字符串字段 | 必须为字符串类型 |

**compatibilityCheck(target, requiredVersion)** — 版本兼容性检查

| 情况 | 结果 |
|------|------|
| 目标无`_ar`属性 | `{ compatible: true, reason: 'no_ar_context' }` |
| 版本匹配 | `{ compatible: true, reason: 'version_match' }` |
| 目标版本更新 | `{ compatible: false, reason: 'newer_version_not_guaranteed_compatible' }` |
| 目标版本更旧 | 检查缺失字段，缺失则不兼容 |

**strip(target)** — 移除自回归上下文

从目标对象中删除`_ar`属性，返回原对象引用。

### 与SessionManager的集成

SessionManager在Skill完成时自动注入自回归上下文：

```javascript
// SessionManager._injectSkillCompleteAR(session, skillId)
AR.inject(session._arContext, {
  [AR.FIELDS.PREVIOUS_RESULT]: skillId,
  [AR.FIELDS.ITERATION]: session.completedSkills.length,
  [AR.FIELDS.SOURCE]: AR.SOURCE_IDS.SKILL_COMPLETE,
});
```

### 典型使用场景

**迭代深化推理**：

```javascript
const { inject, extract, validate, merge } = require('./src/runtime/context/autoregressive-context-schema');

// 第1次迭代
let target = {};
inject(target, {
  originalGoal: '优化数据库查询性能',
  iteration: 0,
  maxIterations: 5,
  source: 'deepening-orchestrator',
});

// 第2次迭代 — 基于前次结果
merge(target, {
  previousScore: 0.65,
  previousResult: 'tdd-implement',
  iteration: 1,
  feedback: '查询仍有N+1问题',
  focusAreas: ['eager-loading', 'query-optimization'],
  qualityHistory: [0.65],
});

// 验证上下文
const { valid, warnings } = validate(target);
// valid: true, warnings: []

// 版本兼容性检查
const compat = compatibilityCheck(target, 1);
// compatible: true, reason: 'version_match'
```

---

## Token预算管理策略

### 三层Token计数

Harness框架采用三层Token计数体系，确保从宏观到微观的全面追踪：

| 层级 | 模块 | 追踪粒度 | 说明 |
|------|------|---------|------|
| **全局层** | TokenManager | `_globalBudget` | 全局Token预算上限，默认1B |
| **会话层** | SessionManager | `session.tokensUsed` | 每个会话的Token累计消耗 |
| **分类层** | TokenManager | `_sessionBreakdowns` | 按input/output/toolCall分类统计 |

**三层关系**：

```
全局预算（1B）
  ├── 会话1（tokensUsed: 500K）
  │     ├── input: 300K
  │     ├── output: 150K
  │     └── toolCall: 50K
  ├── 会话2（tokensUsed: 200K）
  │     ├── input: 120K
  │     ├── output: 60K
  │     └── toolCall: 20K
  └── 总计（700K / 1B = 0.07%）
```

### 预算阈值告警（80%/95%/100%）

```
0% ─────────── 80% ─────────── 95% ─────────── 100%
  正常运行区      预警区          危险区          耗尽区
                 warning80      warning95      exhausted
                 触发上下文压缩  切换低价模型    暂停所有任务
```

**阈值常量**（定义在[src/utils/constants.js](file:///e:/Harness_V1_0429/src/utils/constants.js)）：

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_TOKEN_BUDGET` | 1000000000 (1B) | 默认全局Token预算 |
| `TOKEN_BUDGET_WARNING_RATIO` | 0.8 | 80%预警比例 |
| `TOKEN_BUDGET_DANGER_RATIO` | 0.95 | 95%危险比例 |

**80%预警区（warning80）**：

- TokenManager发射`token-warning-80`事件
- SessionManager转发为`budget-warning`事件
- ContextCompressionEngine触发上下文压缩（`shouldCompress`返回true）
- ModelSelector标记`_budgetConstrained = true`

**95%危险区（warning95）**：

- TokenManager发射`token-warning-95`事件
- ModelSelector标记`_budgetCritical = true`
- 后续任务自动降级到低价模型（standard或economy层）
- TokenAwareDeepening降低深化深度或提前终止迭代

**100%耗尽区（exhausted）**：

- TokenManager发射`token-exhausted`事件
- `store()`方法抛出`BUDGET_EXCEEDED`错误，拒绝新的Token消耗
- ModelSelector标记`_budgetExhausted = true`
- 所有任务暂停，等待人工干预或预算重置

### 模型降级策略

ModelSelector通过`attachTokenManager()`监听TokenManager的预算事件，实现自动降级：

**降级触发条件**：

| 条件 | 降级行为 | source标识 |
|------|---------|-----------|
| 预算达95% | 后续任务自动选择低价模型 | `budget-constrained` |
| 简单任务检测 | premium → standard | `context-downgrade` |
| 重试升级 | economy失败 → standard | `retry-upgrade` |
| 会话成本逼近 | premium → standard | `budget-downgrade` |

**降级链**：

```
gpt-4o (premium) → gpt-4o-mini (standard) → gpt-3.5-turbo (economy)
```

**预算恢复**：

当TokenManager发射`token-reset`事件时（通过`clear()`或`clearAll()`），ModelSelector重置所有预算标志并发射`budget-recovered`事件：

```javascript
tokenMgr.clear('session-1');
// → ModelSelector: _budgetConstrained = false
// → ModelSelector: _budgetCritical = false
// → ModelSelector: _budgetExhausted = false
// → ModelSelector.emit('budget-recovered', { wasConstrained, wasCritical, wasExhausted })
```

### 令牌消耗自动记录

根据项目规则，每次对话轮次结束后必须通过`/api/token/record`端点记录Token消耗：

**请求格式**：

```json
{
  "sessionId": "session-abc123",
  "tokens": 5000,
  "inputTokens": 3000,
  "outputTokens": 1500,
  "toolCallTokens": 500
}
```

**估算方法**：

| 类型 | 估算方法 |
|------|---------|
| 输入Token | 输入字符数/4(英文)或/2(中文) |
| 输出Token | 输出字符数/4(英文)或/2(中文) |
| 工具调用Token | 每次工具调用约200-500 token |

**记录时机**：Skill执行后、任务批次完成后、会话结束前。

### 上下文压缩与预算联动

ContextCompressionEngine与TokenManager形成闭环联动：

```
TokenManager.validate() → ratio >= 0.8?
  → ContextCompressionEngine.shouldCompress() → true
  → ContextCompressionEngine.compress()
    → 智能分类 → full/summary/discard
    → 压缩执行 → tokenSavings
  → 压缩结果反馈 → 更新上下文
  → PhaseContextInjector.injectForPhase() → 按需加载新阶段上下文
```

**压缩效果度量**：

```javascript
const stats = engine.getStats();
// {
//   totalCompressions: 15,
//   totalTokensSaved: 125000,
//   avgCompressionRatio: 0.42,
//   cacheHits: 8,
//   incrementalSkips: 3,
//   specificationAssetsRetained: 5,
//   planCacheSize: 12,
//   hasIncrementalState: true,
// }
```

---

## 完整API列表

### ContextCompressionEngine

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `compress(context)` | `Object` | 执行上下文压缩 |
| `shouldCompress(context)` | `boolean` | 判断是否应触发压缩 |
| `getCompressionPlan(context)` | `Object` | 获取压缩计划（不执行） |
| `compressOutput(output, options?)` | `string` | 压缩文本输出 |
| `compressToolOutput(output, options?)` | `string\|Object` | 压缩工具调用输出 |
| `setStrategy(category, strategy)` | `boolean` | 运行时修改策略 |
| `getStrategies()` | `Object` | 获取当前策略映射 |
| `setCurrentSkillId(skillId)` | `this` | 设置当前Skill ID |
| `attachConfigCausalValidator(validator)` | `this` | 注入因果验证器 |
| `attachCausalBufferManager(manager)` | `this` | 注入因果缓冲管理器 |
| `getConfig()` | `Object` | 获取当前配置 |
| `getStats()` | `Object` | 获取统计信息 |

### TokenManager

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `store(sessionId, amount)` | `number` | 累加Token使用量 |
| `get(sessionId)` | `number` | 获取会话Token使用量 |
| `set(sessionId, amount)` | `number` | 覆盖设置Token使用量 |
| `validate(sessionId, budget?)` | `Object` | 验证预算阈值 |
| `clear(sessionId)` | `void` | 清除指定会话 |
| `clearAll()` | `void` | 清除所有会话 |
| `addBreakdown(sessionId, category, amount)` | `Object` | 添加分类Token消耗 |
| `getBreakdown(sessionId)` | `Object` | 获取分类统计 |
| `getAllBreakdowns(sessionId?)` | `Object` | 获取所有分类统计 |
| `getTotal(budget?)` | `Object` | 获取总Token消耗 |
| `getUsage(sessionId, budget?)` | `Object` | 获取会话使用详情 |
| `getStats(budget?)` | `Object` | 获取全局统计 |
| `formatTokens(n)` | `string` | 格式化Token数量 |
| `parseFormatted(formatted)` | `number` | 解析格式化字符串 |
| `setGlobalBudget(budget)` | `number` | 设置全局预算 |
| `getGlobalBudget()` | `number` | 获取全局预算 |
| `listSessions()` | `string[]` | 列出所有会话ID |

### IsolatedContextManager

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `createIsolatedContext(config)` | `Object\|null` | 创建隔离上下文 |
| `getContext(contextId, agentId?)` | `Object\|null` | 获取上下文（ACL检查） |
| `grantContextAccess(contextId, agentId)` | `boolean` | 授予访问权限 |
| `revokeContextAccess(contextId, agentId)` | `boolean` | 撤销访问权限 |
| `submitResult(contextId, result)` | `boolean` | 提交执行结果 |
| `releaseContext(contextId)` | `boolean` | 释放上下文 |
| `getActiveContexts()` | `Array` | 获取活跃上下文列表 |
| `getContextsBySession(sessionId, agentId?)` | `Array` | 按会话查询上下文 |
| `getTotalTokenEstimate()` | `number` | 计算总Token估算 |
| `getStats()` | `Object` | 获取统计信息 |
| `isHealthy()` | `boolean` | 健康检查 |

### PhaseContextInjector

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `injectForPhase(phase)` | `Object` | 同步注入阶段上下文 |
| `injectForPhaseAsync(phase)` | `Promise<Object>` | 异步注入阶段上下文 |
| `getInjectedTokenEstimate()` | `number` | 获取最近注入的Token估算 |
| `getCurrentPhase()` | `string\|null` | 获取当前阶段 |
| `getPhaseRulesMap()` | `Object` | 获取阶段-规则映射 |
| `getPhaseAgentsMap()` | `Object` | 获取阶段-Agent映射 |
| `getStats()` | `Object` | 获取统计信息 |
| `clearCache()` | `void` | 清除缓存 |

### AutoregressiveContextSchema

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `inject(target, fields)` | `Object` | 注入自回归上下文 |
| `extract(target)` | `Object\|null` | 提取自回归上下文 |
| `merge(target, overrides)` | `Object` | 合并上下文 |
| `validate(target)` | `{ valid, warnings }` | 验证上下文数据 |
| `compatibilityCheck(target, version?)` | `Object` | 版本兼容性检查 |
| `strip(target)` | `Object` | 移除自回归上下文 |

---

## 事件列表

### ContextCompressionEngine事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `compression-complete` | compress()完成 | 压缩结果对象 |
| `strategy-changed` | setStrategy()成功 | `{ category, strategy }` |
| `invalid-phase` | currentPhase不在PHASE_INDEX中 | `{ currentPhase }` |

### TokenManager事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `token-warning-80` | Token使用达80% | `{ sessionId, tokensUsed, budget }` |
| `token-warning-95` | Token使用达95% | `{ sessionId, tokensUsed, budget }` |
| `token-exhausted` | Token预算耗尽 | `{ sessionId, tokensUsed, budget }` |
| `token-reset` | clear()或clearAll() | `{ sessionId }` |

### IsolatedContextManager事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `context-created` | 创建隔离上下文 | `{ contextId, agentId, taskDescription }` |
| `context-accessed` | 获取上下文 | `{ contextId, agentId }` |
| `access-denied` | ACL检查失败 | `{ contextId, agentId }` |
| `result-submitted` | 提交执行结果 | `{ contextId, agentId, confidence }` |
| `context-released` | 释放上下文 | `{ contextId, agentId }` |
| `context-evicted` | 上下文被驱逐 | `{ contextId }` |
| `active-context-evicted` | 活跃上下文被驱逐 | `{ contextId, sessionId }` |

### PhaseContextInjector事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `phase-context-injected` | 阶段上下文注入完成 | `{ phase, estimatedTokens, rulesCount, agentsCount }` |
| `cache-cleared` | 缓存清除 | 无 |

---

## 相关文档

- [[核心功能-上下文压缩引擎]] — ContextCompressionEngine的完整技术文档
- [[核心功能-模型选择与Token管理]] — TokenManager与ModelSelector的完整技术文档
- [[核心功能-会话管理与检查点恢复]] — SessionManager的Token预算追踪与TokenManager协作
- [[核心功能-深化推理引擎]] — TokenAwareDeepening的预算约束深化策略
- [[核心功能-多Agent协作流程]] — 多Agent场景下的上下文隔离与Token分配
- [[模块详解-上下文管理模块]] — 上下文管理子系统的模块级详解
- [[模块详解-因果子系统模块]] — CausalBufferManager与CausalVectorIndex的因果感知压缩
