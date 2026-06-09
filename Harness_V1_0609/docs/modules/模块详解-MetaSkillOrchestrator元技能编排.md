# 模块详解 — MetaSkillOrchestrator 元技能编排

> 所属子系统：[[技能子系统]] | 依赖：[[CausalDataPasser]] [[MetaSkillGenerator]] | 参考：OpenSquilla Meta Skill | 版本：2.73.4

---

## 模块概述

`MetaSkillOrchestrator` 是 Skill 2.0 时代的核心编排引擎，负责将多个原子技能组合为单一可调用的"元技能"（Meta Skill），按多阶段流水线顺序执行，并统一管理模型路由、Token 追踪和失败策略。它将"单技能调用"升级为"多技能流水线编排"，使 Agent 能够以更高层次的抽象完成复杂任务。

**核心理念**：一个 Meta Skill = 一个完整的业务流水线，由多个阶段（Phase）顺序组成，每个阶段包含一到多个原子技能（Skill），阶段间通过上下文变量传递数据，整体受超时、失败策略和模型路由的统一管理。

**源码位置**：`src/runtime/skill/meta-skill-orchestrator.js`（1120行）

---

## 模块定位

在 Harness 技能子系统中，`SkillRouter` 负责单个技能的发现和匹配，而 `MetaSkillOrchestrator` 负责将多个技能编排为流水线执行。两者的关系是：

- **SkillRouter**：回答"该用哪个技能？"——原子级技能调度
- **MetaSkillOrchestrator**：回答"该按什么顺序执行哪些技能？"——流水线级技能编排

MetaSkillOrchestrator 是 `/build`、`/ship`、`/startup` 等复合斜杠命令的底层引擎，也是 Skill 2.0 "从单技能到多技能组合"演进的关键基础设施。

---

## 架构角色

```
                          MetaSkillOrchestrator
                    ┌─────────────────────────────────┐
  Meta Skill定义 ──→│  registerMetaSkill()            │
                    │  validateMetaSkill()            │
                    │  generateMetaSkill()            │
                    │                                 │
  执行请求 ────────→│  executeMetaSkill()             │──→ 执行结果
                    │   ├── _runPhases()              │    (success/phases
                    │   │    ├── 阶段条件评估          │     /totalTokens
                    │   │    ├── 模型路由决策          │     /modelRouting)
                    │   │    └── _executePhaseSkills() │
                    │   │         ├── 超时控制         │
                    │   │         ├── 重试逻辑         │
                    │   │         └── Token追踪        │
                    │   └── _finalizeExecution()       │
                    │                                 │
  外部依赖 ────────→│  ctx.skillExecutor               │
                    │  ctx.modelRouter                 │
                    │  ctx.tokenTracker                │
                    └─────────────────────────────────┘
                              │
                              ↓
                      EventEmitter 事件
              (meta-skill-started / phase-started
               / skill-executed / phase-completed
               / meta-skill-completed
               / meta-skill-failed
               / model-routing-decision
               / token-usage
               / meta-skill-generated)
```

---

## 类定义

```javascript
class MetaSkillOrchestrator extends EventEmitter {
  constructor(options)

  // 注册与管理
  registerMetaSkill(definition)
  getMetaSkill(metaSkillId)
  listMetaSkills()
  validateMetaSkill(definition)
  estimateTokens(metaSkillId)
  generateMetaSkill(taskDescription, availableSkills)

  // 执行与取消
  async executeMetaSkill(metaSkillId, context)
  cancelExecution(executionId)

  // 运行状态
  getRunningExecutions()
  getStats()

  // 关闭
  shutdown() // via withShutdown mixin
}

// 静态属性
MetaSkillOrchestrator.PRESETS
MetaSkillOrchestrator.MAX_PHASES                // 10
MetaSkillOrchestrator.MAX_SKILLS_PER_PHASE       // 5
MetaSkillOrchestrator.DEFAULT_TIMEOUT_PER_SKILL  // 300000 (5分钟)
MetaSkillOrchestrator.MAX_TOTAL_TIMEOUT          // 1800000 (30分钟)
MetaSkillOrchestrator.FAILURE_STRATEGIES         // { STOP, SKIP, RETRY }
MetaSkillOrchestrator.MODEL_TIERS                // { SMALL, MEDIUM, LARGE }
```

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 多阶段流水线编排 | 按 phases 数组顺序执行，每阶段包含 1-5 个原子技能 |
| 5个预置Meta Skill | 全栈构建/代码质量/调试修复/文档生成/调研构建，开箱即用 |
| 失败策略 | 三种策略：stop（立即停止）/ skip（跳过继续）/ retry（重试一次） |
| 模型路由集成 | 按技能层级分配 small/medium/large 模型，支持自定义 modelPreference |
| Token估算与追踪 | 预置 estimatedTokens + 运行时实时追踪，每个技能执行后更新 |
| 超时保护 | 单技能超时（5分钟）+ 总超时（30分钟），双重保护 |
| 条件阶段 | 阶段支持 condition（函数/字符串），动态决定是否执行 |
| 上下文变量传递 | 通过 context.variables 在阶段间共享数据 |
| 执行统计 | 记录注册数/执行数/完成数/失败数/总Token/总耗时 |
| 自动生成 | 通过 generateMetaSkill() 与 LLM 集成，从任务描述自动生成 Meta Skill |
| 优雅关闭 | 通过 withShutdown mixin，关闭时清理所有注册和执行状态 |

---

## 5个预置 Meta Skill（PRESETS）

| Meta Skill ID | 名称 | 阶段数 | 技能数 | 估算Token | 说明 |
|---------------|------|--------|--------|-----------|------|
| `meta-fullstack-build` | 全栈构建 | 5 | 5 | 50,000 | 需求分析→架构设计→TDD实现→集成测试→部署上线 |
| `meta-code-quality` | 代码质量审查 | 4 | 4 | 30,000 | 代码审查→安全审计→重构→性能优化 |
| `meta-debug-fix` | 调试修复 | 3 | 3 | 20,000 | 系统化调试→缺陷修复→完成验证 |
| `meta-documentation` | 文档生成 | 2 | 2 | 15,000 | 文档编写→自动文档生成 |
| `meta-research-build` | 调研构建 | 4 | 4 | 40,000 | 头脑风暴→AI调研→需求分析→架构设计 |

### 各预置Meta Skill的阶段流水线

**meta-fullstack-build（全栈构建）**：
| 阶段 | 技能 | 失败策略 |
|------|------|---------|
| analyze | `requirement-analysis` | stop |
| design | `architecture-design` | stop |
| implement | `tdd-implement`, `module-development` | retry |
| test | `integration-testing` | retry |
| deploy | `deployment` | stop |

**meta-code-quality（代码质量审查）**：
| 阶段 | 技能 | 失败策略 |
|------|------|---------|
| review | `code-review` | skip |
| audit | `security-audit` | skip |
| refactor | `refactor-code` | skip |
| optimize | `performance-optimization` | skip |

**meta-debug-fix（调试修复）**：
| 阶段 | 技能 | 失败策略 |
|------|------|---------|
| debug | `systematic-debugging` | stop |
| fix | `bug-fix` | retry |
| verify | `verification-before-completion` | stop |

**meta-documentation（文档生成）**：
| 阶段 | 技能 | 失败策略 |
|------|------|---------|
| write | `documentation` | retry |
| generate | `auto-doc-generation` | skip |

**meta-research-build（调研构建）**：
| 阶段 | 技能 | 失败策略 |
|------|------|---------|
| explore | `brainstorming` | stop |
| research | `ai-research` | skip |
| analyze | `requirement-analysis` | stop |
| design | `architecture-design` | stop |

---

## API 参考

### 构造函数

#### `constructor(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options` | object | 否 | `{}` | 配置选项 |
| `options.timeoutPerSkill` | number | 否 | `300000` | 每个技能执行的超时时间（毫秒） |
| `options.maxTotalTimeout` | number | 否 | `1800000` | 最大总超时时间（毫秒） |
| `options.maxPhases` | number | 否 | `10` | 最大阶段数 |
| `options.maxSkillsPerPhase` | number | 否 | `5` | 每个阶段最大技能数 |
| `options.includePresets` | boolean | 否 | `true` | 是否自动注册预置Meta Skill |

构造函数初始化内部状态后，自动注册5个预置Meta Skill（可通过 `includePresets: false` 禁用）。

---

### 注册与管理

#### `registerMetaSkill(definition)`

注册一个新的Meta Skill定义。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `definition` | object | 是 | Meta Skill定义对象 |
| `definition.id` | string | 是 | 唯一标识符 |
| `definition.name` | string | 是 | 人类可读名称 |
| `definition.description` | string | 否 | 功能描述 |
| `definition.phases` | Array\<Object\> | 是 | 阶段数组 |
| `definition.phases[].phase` | string | 是 | 阶段名称 |
| `definition.phases[].skills` | Array\<string\> | 是 | 该阶段的技能ID列表 |
| `definition.phases[].onFailure` | string | 否 | 失败策略：`'stop'` / `'skip'` / `'retry'`，默认 `'stop'` |
| `definition.phases[].condition` | Function\|string | 否 | 阶段条件，返回 false 则跳过该阶段 |
| `definition.modelPreference` | object | 否 | 模型路由偏好，key为skillId，value为 `'small'`/`'medium'`/`'large'` |
| `definition.estimatedTokens` | number | 否 | 估算的Token消耗 |

**限制**：
- 最多注册200个Meta Skill
- 阶段数不超过 `maxPhases`（默认10）
- 每阶段技能数不超过 `maxSkillsPerPhase`（默认5）
- `onFailure` 必须是 `stop`、`skip` 或 `retry` 之一
- `modelPreference` 中的值必须是 `small`、`medium` 或 `large` 之一

**返回值**：`this`（支持链式调用）

**抛出**：`TypeError` — 定义无效时；`HarnessError('CAPACITY_EXCEEDED')` — 超过200个上限时

---

#### `getMetaSkill(metaSkillId)`

获取指定Meta Skill的定义（深拷贝，避免外部修改内部状态）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metaSkillId` | string | 是 | Meta Skill ID |

**返回值**：`Object | null` — Meta Skill定义对象，未注册时返回 `null`

---

#### `listMetaSkills()`

列出所有已注册的Meta Skill摘要信息。

**返回值**：`Array<Object>`

每条记录包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | Meta Skill ID |
| `name` | string | 名称 |
| `description` | string | 描述 |
| `phaseCount` | number | 阶段数 |
| `skillCount` | number | 总技能数（跨所有阶段汇总） |
| `estimatedTokens` | number | 估算Token消耗 |

---

#### `validateMetaSkill(definition)`

验证Meta Skill定义的合法性，不抛出异常。

**检查项**：
- 必填字段（id/name/phases）
- 阶段数不超过最大值
- 每个阶段的技能数不超过最大值
- `onFailure` 策略值有效
- 所有技能ID格式有效（非空字符串）
- 阶段名唯一性
- `modelPreference` 中的模型层级有效
- `estimatedTokens` 为非负有限数
- `condition` 为函数或字符串类型

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `definition` | object | 是 | 待验证的Meta Skill定义 |

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `valid` | boolean | 是否通过验证 |
| `errors` | Array\<string\> | 错误列表 |
| `warnings` | Array\<string\> | 警告列表 |

---

#### `estimateTokens(metaSkillId)`

估算指定Meta Skill的Token消耗。优先使用定义中的 `estimatedTokens` 字段，否则按每技能5000 Token估算。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metaSkillId` | string | 是 | Meta Skill ID |

**返回值**：`number` — 估算的Token消耗，未注册时返回 `0`

---

#### `generateMetaSkill(taskDescription, availableSkills)`

从任务描述自动生成Meta Skill定义。这是一个占位方法——实际生成依赖外部LLM集成。该方法会构建prompt，然后发出 `meta-skill-generate-request` 事件供外部LLM处理器使用。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskDescription` | string | 是 | 任务描述，用于指导生成 |
| `availableSkills` | Array\<string\> | 是 | 可用的技能ID列表 |

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `requestId` | string | 生成请求ID，格式 `gen-` + 时间戳 |
| `taskDescription` | string | 原始任务描述 |
| `availableSkills` | Array\<string\> | 可用技能列表（副本） |
| `prompt` | string | 构建的LLM提示词 |
| `createdAt` | string | ISO时间戳 |

**事件**：发出 `meta-skill-generate-request` 事件，载荷为上述返回对象。

---

### 执行与取消

#### `async executeMetaSkill(metaSkillId, context)`

执行一个已注册的Meta Skill。

按阶段顺序执行所有技能，支持失败策略（stop/skip/retry）、模型路由决策、Token使用追踪和超时控制。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metaSkillId` | string | 是 | 要执行的Meta Skill ID |
| `context` | object | 否 | 执行上下文 |
| `context.skillExecutor` | Function | 是（实际执行） | 技能执行器函数，签名为 `(skillId, context) => Promise<{success, result, tokensUsed}>` |
| `context.modelRouter` | Function | 否 | 模型路由器函数，签名为 `(skillId, modelTier) => { tier, estimatedCost }` |
| `context.tokenTracker` | Function | 否 | Token追踪器函数，签名为 `(skillId, tokensUsed) => void` |
| `context.variables` | object | 否 | 可在阶段间传递的共享变量 |

**返回值**：`Promise<Object>`

**成功返回结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否全部成功 |
| `phases` | Array\<Object\> | 各阶段执行结果 |
| `totalTokens` | number | 总Token消耗 |
| `totalDuration` | number | 总耗时（毫秒） |
| `modelRouting` | Array\<Object\> | 模型路由决策记录 |

**失败返回结构**（含额外字段）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `failedPhase` | string | 失败的阶段名（仅stop策略） |
| `failedSkill` | string | 失败的技能ID（仅stop策略） |
| `error` | string | 错误消息 |

**抛出**：`TypeError` — metaSkillId为空时；`Error` — metaSkillId未注册时

**执行流程**：
1. 初始化执行记录和状态
2. 发出 `meta-skill-started` 事件
3. 启动总超时竞态（`maxTotalTimeout`）
4. 按阶段顺序遍历：
   - 检查 shutdown 标志
   - 评估阶段条件（condition），不满足则跳过
   - 发出 `phase-started` 事件
   - 执行阶段内所有技能（带超时和重试）
   - 发出 `skill-executed` 和 `token-usage` 事件
   - 调用 `ctx.tokenTracker`（如果提供）
   - 根据失败策略处理：stop → 立即返回失败；skip → 继续下一技能
   - 发出 `phase-completed` 事件
5. 发出 `meta-skill-completed` 事件
6. 返回最终结果

---

#### `cancelExecution(executionId)`

取消正在进行的Meta Skill执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `executionId` | string | 是 | 执行ID（来自 `getRunningExecutions()` 的返回值） |

**返回值**：`boolean` — 是否成功取消

---

### 运行状态

#### `getRunningExecutions()`

获取正在进行的执行列表。

**返回值**：`Array<Object>`

每条记录包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `executionId` | string | 执行ID |
| `metaSkillId` | string | Meta Skill ID |
| `startedAt` | number | 开始时间戳 |
| `elapsed` | number | 已耗时（毫秒） |
| `totalTokens` | number | 已消耗Token |

---

#### `getStats()`

获取当前执行统计信息。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `registered` | number | 已注册的Meta Skill数 |
| `executions` | number | 累计执行次数 |
| `completions` | number | 累计完成次数 |
| `failures` | number | 累计失败次数 |
| `totalTokensUsed` | number | 累计Token消耗 |
| `totalDurationMs` | number | 累计总耗时（毫秒） |

---

## 失败策略

每个阶段可以指定一个 `onFailure` 策略，控制该阶段内技能失败时的行为：

| 策略 | 常量 | 行为 |
|------|------|------|
| `stop` | `FAILURE_STRATEGIES.STOP` | 立即停止整个Meta Skill执行，返回失败结果，`failedPhase` 和 `failedSkill` 指向失败点 |
| `skip` | `FAILURE_STRATEGIES.SKIP` | 跳过当前失败的技能，继续执行该阶段内后续技能（stage内继续） |
| `retry` | `FAILURE_STRATEGIES.RETRY` | 重试当前技能一次（共最多2次尝试），如果重试仍失败则按 skip 逻辑继续 |

**注意**：
- `retry` 仅重试一次（`retries < 1`），不会无限重试
- 默认策略为 `stop`（当阶段未指定 `onFailure` 时）
- 重试时也受 `timeoutPerSkill` 超时限制

---

## 模型路由集成

MetaSkillOrchestrator 支持按技能粒度分配模型层级，实现成本优化。

### 模型层级

| 层级 | 常量 | 适用场景 |
|------|------|---------|
| `small` | `MODEL_TIERS.SMALL` | 简单任务（文档生成、格式检查） |
| `medium` | `MODEL_TIERS.MEDIUM` | 常规任务（默认层级，代码审查、测试） |
| `large` | `MODEL_TIERS.LARGE` | 复杂任务（架构设计、安全审计） |

### 路由决策

优先级：Meta Skill 定义中的 `modelPreference` > 默认层级（`medium`）

```javascript
// 示例：为不同技能指定不同模型层级
const definition = {
  id: 'meta-optimized-build',
  name: '优化的构建流水线',
  phases: [...],
  modelPreference: {
    'code-review': 'small',           // 代码审查用小模型
    'architecture-design': 'large',   // 架构设计用大模型
    'security-audit': 'large',        // 安全审计用大模型
  },
};
```

每个技能执行前，会发出 `model-routing-decision` 事件，并记录到执行记录的 `modelRouting` 数组中。如果 context 中提供了 `modelRouter` 函数，还会调用它获取估算成本。

---

## 事件列表

MetaSkillOrchestrator 继承自 `EventEmitter`，发出以下事件：

| 事件名 | 触发时机 | 载荷 |
|--------|---------|------|
| `meta-skill-started` | Meta Skill 开始执行 | `{ metaSkillId, context }` |
| `phase-started` | 阶段开始时 | `{ metaSkillId, phase, skills }` |
| `skill-executed` | 单个技能执行完成时 | `{ metaSkillId, phase, skillId, success, result, tokensUsed, duration }` |
| `phase-completed` | 阶段完成时 | `{ metaSkillId, phase, skills }` |
| `meta-skill-completed` | Meta Skill 完成时 | `{ metaSkillId, phases, totalTokens, totalDuration }` |
| `meta-skill-failed` | Meta Skill 失败时 | `{ metaSkillId, phase, skillId, error }` |
| `model-routing-decision` | 模型路由决策时 | `{ skillId, modelTier, estimatedCost }` |
| `token-usage` | 追踪Token使用时 | `{ metaSkillId, skillId, tokensUsed }` |
| `meta-skill-generate-request` | 自动生成Meta Skill请求时 | `{ requestId, taskDescription, availableSkills, prompt, createdAt }` |

---

## 常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_SKILLS_PER_PHASE` | 5 | 每个阶段最大技能数 |
| `MAX_PHASES` | 10 | 每个Meta Skill最大阶段数 |
| `DEFAULT_TIMEOUT_PER_SKILL` | 300000 | 单技能默认超时（5分钟，毫秒） |
| `MAX_TOTAL_TIMEOUT` | 1800000 | 最大总超时（30分钟，毫秒） |
| `DEFAULT_MODEL_TIER` | `'medium'` | 默认模型层级 |
| `FAILURE_STRATEGIES.STOP` | `'stop'` | 失败时立即停止 |
| `FAILURE_STRATEGIES.SKIP` | `'skip'` | 失败时跳过继续 |
| `FAILURE_STRATEGIES.RETRY` | `'retry'` | 失败时重试一次 |
| `MODEL_TIERS.SMALL` | `'small'` | 小模型层级 |
| `MODEL_TIERS.MEDIUM` | `'medium'` | 中模型层级 |
| `MODEL_TIERS.LARGE` | `'large'` | 大模型层级 |

---

## 关闭行为

通过 `withShutdown` mixin 提供优雅关闭能力：

1. 清空所有已注册的Meta Skill定义（`_metaSkills.clear()`）
2. 清空所有运行中的执行（`_runningExecutions.clear()`）
3. 重置统计信息（所有计数器归零）

关闭后，所有 `guardShutdown()` 保护的方法（`registerMetaSkill`、`executeMetaSkill`、`getMetaSkill`、`listMetaSkills`、`estimateTokens`、`validateMetaSkill`、`generateMetaSkill`、`cancelExecution`、`getStats`、`getRunningExecutions`）均会抛出异常。

---

## 使用示例

### 注册并执行自定义Meta Skill

```javascript
const MetaSkillOrchestrator = require('./src/runtime/skill/meta-skill-orchestrator');

const orchestrator = new MetaSkillOrchestrator({
  maxPhases: 10,
  maxSkillsPerPhase: 5,
  timeoutPerSkill: 300000,
  includePresets: true,
});

// 注册自定义Meta Skill
orchestrator.registerMetaSkill({
  id: 'meta-api-development',
  name: 'API开发流水线',
  description: '从需求到部署的API开发完整流程',
  phases: [
    { phase: 'spec', skills: ['requirement-analysis'], onFailure: 'stop' },
    { phase: 'design', skills: ['architecture-design'], onFailure: 'stop' },
    { phase: 'code', skills: ['tdd-implement', 'module-development'], onFailure: 'retry' },
    { phase: 'review', skills: ['code-review', 'security-audit'], onFailure: 'skip' },
    { phase: 'test', skills: ['integration-testing'], onFailure: 'retry' },
    { phase: 'ship', skills: ['verification-before-completion', 'deployment'], onFailure: 'stop' },
  ],
  modelPreference: {
    'security-audit': 'large',
    'code-review': 'medium',
  },
  estimatedTokens: 60000,
});

// 模拟技能执行器
const skillExecutor = async (skillId, ctx) => {
  console.log(`执行技能: ${skillId} (阶段: ${ctx.phase})`);
  // 实际场景中调用SkillRouter等
  return { success: true, result: `${skillId} 完成`, tokensUsed: 5000 };
};

// 模拟模型路由器
const modelRouter = (skillId, modelTier) => {
  const costMap = { small: 0.001, medium: 0.005, large: 0.02 };
  return { tier: modelTier, estimatedCost: costMap[modelTier] || 0.005 };
};

// 模拟Token追踪器
const tokenTracker = (skillId, tokensUsed) => {
  console.log(`  [Token] ${skillId}: ${tokensUsed} tokens`);
};

// 执行
const result = await orchestrator.executeMetaSkill('meta-api-development', {
  skillExecutor,
  modelRouter,
  tokenTracker,
  variables: { projectName: 'my-api', language: 'javascript' },
});

console.log('执行结果:', JSON.stringify(result, null, 2));
console.log('统计:', orchestrator.getStats());
```

### 使用预置Meta Skill

```javascript
// 直接使用预置的 meta-debug-fix
const result = await orchestrator.executeMetaSkill('meta-debug-fix', {
  skillExecutor,
  modelRouter,
  tokenTracker,
  variables: { bugId: 'BUG-001', filePath: 'src/module.js' },
});

console.log(`调试修复完成: ${result.success}`);
console.log(`总耗时: ${result.totalDuration}ms, 总Token: ${result.totalTokens}`);
```

### 查询和验证

```javascript
// 列出所有Meta Skill
const allSkills = orchestrator.listMetaSkills();
console.log(`已注册 ${allSkills.length} 个Meta Skill`);
allSkills.forEach(s => console.log(`  - ${s.id}: ${s.name} (${s.phaseCount}阶段, ${s.skillCount}技能)`));

// 获取指定Meta Skill
const fullstack = orchestrator.getMetaSkill('meta-fullstack-build');
console.log('全栈构建流水线:', fullstack.phases.map(p => p.phase).join(' → '));

// 估算Token
console.log('全栈构建估算Token:', orchestrator.estimateTokens('meta-fullstack-build'));

// 验证定义
const validation = orchestrator.validateMetaSkill({
  id: 'test',
  name: '测试',
  phases: [{ phase: 'test', skills: ['code-review'] }],
});
console.log('验证结果:', validation.valid, validation.errors);

// 获取运行中的执行
const running = orchestrator.getRunningExecutions();
console.log('运行中的执行:', running.length);
```

### 自动生成Meta Skill

```javascript
const availableSkills = [
  'requirement-analysis', 'architecture-design', 'tdd-implement',
  'module-development', 'code-review', 'security-audit',
  'integration-testing', 'deployment', 'verification-before-completion',
];

const genRequest = orchestrator.generateMetaSkill(
  '为微服务项目创建完整的CI/CD流水线',
  availableSkills,
);

console.log('生成请求ID:', genRequest.requestId);
console.log('Prompt预览:', genRequest.prompt.substring(0, 200) + '...');

// 监听生成结果（由外部LLM处理器填充）
orchestrator.on('meta-skill-generated', ({ metaSkillId, definition }) => {
  console.log('新Meta Skill已生成:', metaSkillId);
  console.log('定义:', definition);
});
```

### 监听执行事件

```javascript
orchestrator.on('meta-skill-started', ({ metaSkillId }) => {
  console.log(`[开始] Meta Skill: ${metaSkillId}`);
});

orchestrator.on('phase-started', ({ phase, skills }) => {
  console.log(`  [阶段开始] ${phase}: ${skills.join(', ')}`);
});

orchestrator.on('skill-executed', ({ skillId, success, tokensUsed, duration }) => {
  const status = success ? '✓' : '✗';
  console.log(`    ${status} ${skillId}: ${tokensUsed} tokens, ${duration}ms`);
});

orchestrator.on('model-routing-decision', ({ skillId, modelTier, estimatedCost }) => {
  console.log(`    [路由] ${skillId} → ${modelTier} (成本: ${estimatedCost})`);
});

orchestrator.on('phase-completed', ({ phase }) => {
  console.log(`  [阶段完成] ${phase}`);
});

orchestrator.on('meta-skill-completed', ({ totalTokens, totalDuration }) => {
  console.log(`[完成] 总Token: ${totalTokens}, 总耗时: ${totalDuration}ms`);
});

orchestrator.on('meta-skill-failed', ({ phase, skillId, error }) => {
  console.error(`[失败] 阶段: ${phase}, 技能: ${skillId}, 错误: ${error}`);
});
```

### 带条件的阶段

```javascript
orchestrator.registerMetaSkill({
  id: 'meta-conditional-build',
  name: '条件构建',
  description: '根据条件决定是否执行某些阶段',
  phases: [
    { phase: 'analyze', skills: ['requirement-analysis'], onFailure: 'stop' },
    {
      phase: 'security-check',
      skills: ['security-audit'],
      onFailure: 'skip',
      condition: (ctx) => ctx.variables && ctx.variables.needsSecurityAudit === true,
    },
    { phase: 'implement', skills: ['tdd-implement'], onFailure: 'retry' },
    {
      phase: 'deploy',
      skills: ['deployment'],
      onFailure: 'stop',
      condition: (ctx) => ctx.variables && ctx.variables.environment === 'production',
    },
  ],
});
```

---

## 依赖关系

- **依赖**：`events` — Node.js 内置 EventEmitter
- **依赖**：`../../utils/safe-assign.js` — `mergeConfig` 配置合并
- **依赖**：`../../utils/debug-logger.js` — `debug` 调试日志
- **依赖**：`../../utils/safe-execute.js` — `safeExecute` / `safeCall` 安全执行
- **依赖**：`../../utils/constants.js` — `estimateTokens` / `HarnessError`
- **依赖**：`../../utils/shutdown-mixin.js` — `withShutdown` 优雅关闭混入
- **被依赖**：`src/index.js` — 主入口装配，与 `SkillRouter`、`CausalDataPasser`、`MetaSkillGenerator` 协作

---

## 集成说明

- **与 SkillRouter 配合**：MetaSkillOrchestrator 负责"编排什么技能"，SkillRouter 负责"找到并执行单个技能"。实际场景中，`ctx.skillExecutor` 通常由 SkillRouter 提供
- **与 CausalDataPasser 配合**：`collectOutputs()` 和 `injectInputs()` 可在阶段间传递因果数据，增强阶段间的数据流转
- **与 MetaSkillGenerator 配合**：`generateMetaSkill()` 发出 `meta-skill-generate-request` 事件，`MetaSkillGenerator` 监听该事件，调用 LLM 生成定义，再通过 `registerMetaSkill()` 注册
- **与 SkillRouter 的模型分级**：MetaSkillOrchestrator 的 `modelPreference` 与 SkillRouter 的 `MODEL_TIERS` 使用相同的三个层级（small/medium/large），保持一致性
- **与斜杠命令集成**：`/build`、`/ship`、`/startup` 等复合命令底层使用 `executeMetaSkill()` 驱动
- **关闭安全**：通过 `withShutdown` mixin 提供 `guardShutdown()` 门禁，已关闭后所有公共方法均抛出异常
- **unref 优化**：超时定时器调用 `.unref()`，确保不会阻止 Node.js 进程正常退出

---

## 相关文档

- [[模块详解-SkillRouter技能路由]] — 原子技能发现与路由
- [[模块详解-CausalDataPasser因果数据传递]] — 运行时因果数据传递
- [[模块详解-MetaSkillGenerator元技能生成]] — 元技能自动生成
- [[模块详解-SkillRouter模块]] — 技能路由引擎
- [[核心功能-技能子系统]] — 技能子系统总览
- [[核心功能-六阶段执行流程]] — 六阶段流水线