# 模块详解-DreamOutcomes与DreamBridge模块

> 版本：2.73.4 | 文件：src/runtime/thought/dream-outcomes.js + dream-bridge.js | 行数：~658行 + ~450行

---

## 1. 模块定位

DreamOutcomes和DreamBridge均位于思维子系统（`src/runtime/thought/`）内，是Dreaming闭环的两个关键拼图。思维子系统包含DreamEngine、DreamScheduler、DreamOutcomes、DreamBridge四大核心模块，它们共同构成了"定义目标→执行任务→评估结果→反馈提炼→知识沉淀"的完整闭环。

### 依赖关系图

```
QualityScorer ──(事件)──→ DreamBridge ──(桥接)──→ DreamOutcomes
SelfReflection ─(事件)──→ DreamBridge ──(桥接)──→ DreamEngine
DreamOutcomes ─(事件)──→ DreamBridge ──(桥接)──→ DreamEngine
DreamOutcomes ─(事件)──→ DreamBridge ──(桥接)──→ SkillImprovementLoop
DreamEngine ───(事件)──→ DreamBridge ──(桥接)──→ LlmWiki
```

- **DreamOutcomes** 依赖 `DreamEngine`（通过`attachDreamEngine`注入，调用`startDreaming`同步评估结果）、`SkillImprovementLoop`（通过`attachSkillImprovementLoop`注入，调用`recordLearning`同步学习记录）、`QualityScorer`（通过`attachQualityScorer`注入，预留质量评分关联）。
- **DreamBridge** 依赖 `QualityScorer`、`SelfReflection`、`DreamOutcomes`、`DreamEngine`、`SkillImprovementLoop`、`LlmWiki`、`BrainMemory`共7个模块实例，通过`attachXxx`系列方法注入，以事件监听方式实现模块间自动数据传递。

两个模块的设计理念是：DreamOutcomes负责"闭环语义"——定义什么算成功、评估是否达成、追踪笔记效果；DreamBridge负责"闭环连接"——将原本隔离的模块通过事件桥接串联，使数据自动流转，无需上层业务手动编排。

---

## 2. DreamOutcomes核心能力

### 2.1 成功标准定义

DreamOutcomes为任务/会话/技能三类实体提供结构化的成功标准定义能力。每个Outcome由以下要素构成：

- **taskId**：任务唯一标识，作为Outcome的主键
- **criteria.description**：成功标准的自然语言描述
- **criteria.metrics**：度量指标数组，每个指标包含`name`（指标名）、`target`（目标值）、`weight`（权重）
- **criteria.category**：类别标签，可选值为`'task'`、`'session'`、`'skill'`，默认`'task'`

类别机制允许按不同维度管理和过滤Outcome定义，例如单独查看所有会话级别的成功标准。

### 2.2 加权评分评估

评估采用加权评分模型，核心算法为：

1. 对每个定义的metric，查找实际结果中对应的`actual`值
2. 计算达成比率 `ratio = min(actual / target, 1)`（target为0时特殊处理）
3. 加权汇总 `score = Σ(ratio × weight) / Σ(weight)`
4. 达成判定 `achieved = score >= 0.8`

0.8阈值的设定遵循帕累托原则——80%的加权达成率即视为任务成功，允许部分指标未达标但整体可接受。评分精度通过`roundTo`函数保留4位小数。

### 2.3 效果追踪

DreamOutcomes追踪DreamEngine产出笔记的实际使用效果，形成"笔记生成→使用→效果评估→低效清理"的闭环：

- **recordNoteUsage**：记录笔记被引用的次数和上下文
- **recordNoteOutcome**：记录笔记使用后的有效性（effective/ineffective）
- **getNoteEffectiveness**：计算单条笔记的有效率（effective / (effective + ineffective)）
- **getLowEffectivenessNotes**：筛选有效率低于阈值（默认0.3）的笔记，按有效率升序排列，供清理决策使用

笔记追踪数据存储在`_noteUsage` Map中，容量上限为`MAX_NOTE_USAGE = 500`，超出时淘汰最久未使用的条目（LRU策略）。

### 2.4 反馈闭环

DreamOutcomes实现了两条反馈闭环路径：

- **→ DreamEngine**：通过`syncToDreamEngine`将评估结果转化为DreamEngine的输入会话。达成的Outcome提取为`lessonsLearned`（经验教训），未达成的提取为`errors`（错误模式），所有指标细节映射为`keyDecisions`（关键决策）。DreamEngine在下次做梦时消费这些数据，实现"评估→提炼→改进"的循环。
- **→ SkillImprovementLoop**：通过`syncToSkillImprovementLoop`将评估结果转化为技能改进飞轮的learning记录。达成的指标映射为`whatWorked`，未达成的映射为`whatFailed`，驱动飞轮三道门验证流程。

### 2.5 Grader代理独立评估

融合自"AI Agent Dreaming"的Outcomes核心概念：**用Grader代理独立评估，避免执行者自我评估偏差**。

传统评估模式中，执行任务的Agent自行评估结果，存在"既当运动员又当裁判"的偏差风险。Grader代理机制引入独立的评估实体，与执行Agent完全分离，提供客观的第三方评估视角。

**核心设计**：

- **独立Grader注册**：通过`registerGraderAgent`注册任意数量的独立Grader，每个Grader拥有自己的评估函数、专业领域标签和权重
- **多Grader共识评估**：`evaluateWithGrader`支持同时使用多个Grader评估同一任务，采用加权平均计算最终评分
- **分歧检测**：当多个Grader评分差异过大（max-min >= 0.2）时标记为未达成共识，提示评估分歧
- **闭环反馈**：Grader评估结果通过DreamBridge规则#8自动同步到DreamEngine，使DreamEngine从独立评估中学习

**共识评估算法**：

1. 对每个已注册Grader，调用其`evaluate(taskId, actualResults, criteria)`函数
2. 将Grader评分限制在[0, 1]范围内
3. 计算加权平均：`consensusScore = Σ(score × weight) / Σ(weight)`
4. 计算分歧度：`divergence = max(scores) - min(scores)`
5. 共识判定：`consensusReached = divergence < 0.2`（当`options.consensus=true`时）

---

## 3. DreamOutcomes类定义与构造函数

### 继承体系

```
EventEmitter
  └─ DreamOutcomes（通过withShutdown混入ShutdownMixin）
```

DreamOutcomes继承Node.js原生`EventEmitter`，并通过`withShutdown`高阶函数混入优雅关闭能力（`guardShutdown`、`_onShutdown`、`_shutDown`等）。

### 构造函数

```javascript
constructor()
```

无参数构造。所有外部依赖通过`attachXxx`方法延迟注入。

### 内部状态

| 属性 | 类型 | 初始值 | 说明 |
|------|------|--------|------|
| `_outcomes` | Map\<string, object\> | `new Map()` | Outcome定义存储，key为taskId |
| `_evaluations` | Array\<object\> | `[]` | 评估结果历史，上限MAX_EVALUATIONS=2000 |
| `_noteUsage` | Map\<string, object\> | `new Map()` | 笔记使用效果追踪，上限MAX_NOTE_USAGE=500 |
| `_syncCounters` | Object | `{toDreamEngine: 0, toImprovementLoop: 0}` | 同步计数器 |
| `_dreamEngine` | Object\|null | `null` | DreamEngine实例引用 |
| `_skillImprovementLoop` | Object\|null | `null` | SkillImprovementLoop实例引用 |
| `_qualityScorer` | Object\|null | `null` | QualityScorer实例引用 |
| `_graderAgents` | Map\<string, object\> | `new Map()` | 已注册Grader代理存储，key为graderId |

### 静态属性

| 属性 | 值 | 说明 |
|------|----|------|
| `MAX_EVALUATIONS` | 2000 | 评估历史最大条目数，超出时FIFO淘汰 |
| `MAX_NOTE_USAGE` | 500 | 笔记追踪最大条目数，超出时LRU淘汰 |

### 关闭行为

`_onShutdown`方法在实例关闭时执行：清空`_outcomes`、`_noteUsage`两个Map，置空`_evaluations`数组，将所有外部引用置为null，调用`removeAllListeners`移除所有事件监听器，防止内存泄漏。

---

## 4. DreamOutcomes公开方法详解

### 4.1 defineOutcome(taskId, criteria)

为任务定义成功标准。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 任务标识，空或非字符串时返回null |
| criteria | object | 是 | 成功标准对象 |
| criteria.description | string | 否 | 成功标准描述，默认空字符串 |
| criteria.metrics | Array\<{name, target, weight}\> | 否 | 度量指标数组，默认空数组 |
| criteria.category | string | 否 | 类别，仅接受'session'/'skill'，其他值回退为'task' |

**返回值**：`{taskId, criteria, category, definedAt}` 或 `null`（参数无效时）

**行为**：校验参数→规范化category→构建entry存入`_outcomes` Map→触发`outcome-defined`事件

### 4.2 getOutcome(taskId)

获取指定任务的成功标准定义。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 任务标识 |

**返回值**：Outcome定义对象或`null`

### 4.3 listOutcomes(category)

列出所有Outcome定义，可按类别过滤。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| category | string | 否 | 类别过滤，不传则返回全部 |

**返回值**：Outcome定义对象数组

### 4.4 removeOutcome(taskId)

移除Outcome定义。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 任务标识 |

**返回值**：`boolean`，是否成功移除

### 4.5 evaluateOutcome(taskId, actualResults)

评估任务结果是否达成Outcomes，是模块的核心评估方法。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 任务标识 |
| actualResults | object | 是 | 实际结果对象 |
| actualResults.metrics | Array\<{name, actual}\> | 否 | 实际度量值数组 |
| actualResults.duration | number | 否 | 执行时长 |
| actualResults.agentId | string | 否 | 执行Agent标识 |

**返回值**：`{taskId, achieved, score, details, evaluatedAt}` 或 `null`（无Outcome定义或参数无效时）

**行为**：查找Outcome定义→逐指标计算达成比率和加权分→汇总加权评分→判定achieved（score≥0.8）→存入评估历史（超限时FIFO淘汰）→触发`outcome-evaluated`事件及`outcome-achieved`或`outcome-missed`事件

**details数组元素结构**：`{name, target, actual, achieved, weight}`

### 4.6 getEvaluation(taskId)

获取指定任务最近的评估结果。从`_evaluations`数组末尾向前查找，返回最新匹配项。

**返回值**：评估结果对象或`null`

### 4.7 getRecentEvaluations(limit)

获取最近N条评估结果。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| limit | number | 10 | 返回数量上限，必须为正数 |

**返回值**：评估结果数组，按评估时间降序（最新在前）

### 4.8 attachDreamEngine(dreamEngine)

挂载DreamEngine实例，供`syncToDreamEngine`调用。实例需提供`startDreaming`方法。

### 4.9 attachSkillImprovementLoop(loop)

挂载SkillImprovementLoop实例，供`syncToSkillImprovementLoop`调用。实例需提供`recordLearning`方法。

### 4.10 attachQualityScorer(scorer)

挂载QualityScorer实例，预留质量评分关联接口。

### 4.11 syncToDreamEngine()

将评估结果同步到DreamEngine，成功/失败模式作为新输入。

**返回值**：`Promise<{synced, errors}>`

**行为**：遍历所有评估结果→将达成的Outcome映射为`lessonsLearned`，未达成的映射为`errors`，指标细节映射为`keyDecisions`→调用`dreamEngine.startDreaming(sessions)`→递增同步计数器→触发`synced-to-dream-engine`事件

**数据映射规则**：

| 评估字段 | DreamEngine输入字段 | 映射逻辑 |
|----------|---------------------|----------|
| evaluation.taskId | sessionId | 直接映射 |
| evaluation.achieved=false | errors | `[{message: 'Outcome missed: score=' + score}]` |
| evaluation.achieved=true | lessonsLearned | `[{content, strategy}]` |
| evaluation.details | keyDecisions | `[{content: name + ': target=' + target + ' actual=' + actual}]` |

### 4.12 syncToSkillImprovementLoop()

将评估结果同步到技能改进飞轮，作为learning记录。

**返回值**：`{synced, errors}`（同步方法，非Promise）

**行为**：遍历所有评估结果→构建learning entry（达成的指标→`whatWorked`，未达成的→`whatFailed`）→通过`safeExecute`安全调用`recordLearning`→递增同步计数器→触发`synced-to-improvement-loop`事件

**learning entry结构**：`{skillId, agentId, whatWorked, whatFailed, category, score}`

### 4.13 registerGraderAgent(graderId, graderConfig)

注册独立Grader代理。Grader代理是独立于执行代理的评估实体，用于对任务结果进行独立、客观的评估，避免执行者自我评估的偏差。融合自"AI Agent Dreaming"的Outcomes核心概念。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| graderId | string | 是 | Grader代理标识，空或非字符串时返回false |
| graderConfig | object | 是 | Grader配置 |
| graderConfig.evaluate | Function | 是 | 评估函数，签名：`(taskId, actualResults, criteria) => {score, details, reasoning}` |
| graderConfig.specialties | string[] | 否 | Grader专业领域标签，默认空数组 |
| graderConfig.weight | number | 否 | 多Grader共识评估中的权重，默认1.0 |

**返回值**：`boolean`（是否注册成功）

**行为**：校验参数→构建Grader条目（含evaluate函数、specialties、weight、evaluations计数器）→存入`_graderAgents` Map→触发`grader-registered`事件

### 4.14 unregisterGraderAgent(graderId)

注销Grader代理。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| graderId | string | 是 | Grader代理标识 |

**返回值**：`boolean`（是否注销成功）

### 4.15 evaluateWithGrader(taskId, actualResults, options)

使用独立Grader代理评估任务结果。支持单Grader和多Grader共识评估。多Grader时采用加权平均计算最终评分，并检测评估分歧。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskId | string | 是 | 任务标识（需已定义Outcome） |
| actualResults | object | 是 | 实际结果对象 |
| options.graderId | string | 否 | 指定使用的Grader ID，不指定时使用所有已注册Grader |
| options.consensus | boolean | 否 | 是否要求多Grader共识，默认false |

**返回值**：`Promise<{taskId, graderScores, consensusScore, consensusReached, divergence, evaluatedAt}|null>`

- `graderScores`：每个Grader的评分详情数组，含`{graderId, score, details, reasoning, weight, failed?}`
- `consensusScore`：加权平均共识评分，保留4位小数
- `consensusReached`：是否达成共识（divergence < 0.2）
- `divergence`：评分分歧度（max - min）

**行为**：校验参数→获取指定或全部Grader→逐一调用evaluate函数（失败时score=0并标记failed）→计算加权平均→检测分歧→触发`grader-evaluated`事件

### 4.16 listGraderAgents()

获取已注册的Grader代理列表。

**返回值**：`Array<{id, specialties, weight, evaluations}>`

### 4.17 recordNoteUsage(noteId, context)

记录笔记被使用。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| noteId | string | 是 | 笔记标识 |
| context | string | 否 | 使用上下文描述 |

**行为**：若noteId不存在则新建条目（超限时LRU淘汰最旧条目）→递增uses计数→更新lastUsedAt→触发`note-usage-recorded`事件

### 4.14 recordNoteOutcome(noteId, effective)

记录笔记使用后的效果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| noteId | string | 是 | 笔记标识 |
| effective | boolean | 是 | 是否有效 |

**行为**：若noteId不存在则新建条目→递增effective或ineffective计数→触发`note-outcome-recorded`事件

### 4.15 getNoteEffectiveness(noteId)

获取笔记效果统计。

**返回值**：`{uses, effective, ineffective, effectivenessRate, lastUsedAt}` 或 `null`

`effectivenessRate = effective / (effective + ineffective)`，保留4位小数；分母为0时返回0。

### 4.16 getLowEffectivenessNotes(threshold)

获取低效果笔记列表，用于清理决策。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| threshold | number | 0.3 | 效果率阈值，低于此值的笔记将被返回 |

**返回值**：`Array<{noteId, effectivenessRate, uses}>`，按effectivenessRate升序排列。跳过尚无效果记录（effective+ineffective=0）的笔记。

### 4.17 getStats()

获取统计信息。

**返回值**：

```javascript
{
  outcomesDefined: number,        // 已定义的Outcome数量
  evaluationsTotal: number,       // 评估总数
  evaluationsAchieved: number,    // 达成的评估数
  achievementRate: number,        // 达成率，保留4位小数
  noteEffectivenessTracked: number, // 追踪中的笔记数
  syncedToDreamEngine: number,    // 同步到DreamEngine的次数
  syncedToImprovementLoop: number, // 同步到SkillImprovementLoop的次数
  gradersRegistered: number,      // 已注册Grader代理数量
  totalGraderEvaluations: number  // Grader代理累计评估次数
}
```

### 4.18 isHealthy()

检查实例健康状态。条件：未关闭且评估总数小于10000。

**返回值**：`boolean`

---

## 5. DreamBridge核心能力

### 5.1 八条自动桥接规则

DreamBridge实现了8条自动桥接规则，将8个模块串联为闭环：

| 编号 | 桥接名称 | 源模块 | 监听事件 | 目标模块 | 调用方法 | 语义 |
|------|----------|--------|----------|----------|----------|------|
| 1 | QualityScorer→DreamOutcomes | QualityScorer | `score-computed` | DreamOutcomes | `evaluateOutcome` | 质量评分结果自动触发Outcome评估 |
| 2 | SelfReflection→DreamEngine | SelfReflection | `reflection-completed` | DreamEngine | `consumeReflectionInput` | 自反思结论自动输入DreamEngine |
| 3 | DreamOutcomes→DreamEngine | DreamOutcomes | `outcome-evaluated` | DreamEngine | `syncToDreamEngine` | Outcome评估后自动同步到DreamEngine |
| 4 | DreamOutcomes→SkillImprovementLoop | DreamOutcomes | `outcome-evaluated` | DreamBridge | `syncToSkillImprovementLoop` | Outcome评估后自动同步到改进飞轮 |
| 5 | DreamEngine→LlmWiki | DreamEngine | `notes-merged`/`notes-generated` | LlmWiki | `createEntry` | 高置信度笔记自动沉淀到知识库 |
| 6 | SelfReflection→ErrorPreventionGuard | SelfReflection | `reflection-completed` | ErrorPreventionGuard | `registerFromReflection` | 自反思结论自动注册错误预防 |
| 7 | ErrorPreventionGuard→IronRuleEngine | ErrorPreventionGuard | `auto-registered-from-reflection` | IronRuleEngine | `addRule` | 错误预防模式自动升级为铁律 |
| 8 | GraderEvaluated→DreamEngine | DreamOutcomes | `grader-evaluated` | DreamEngine | `consumeReflectionInput` | Grader代理评估结果自动同步到DreamEngine |
| 9 | CodeWiki→DreamEngine | CodeWikiOrchestrator | `compile-completed` | DreamEngine | `consumeReflectionInput` | CodeWiki编译结果自动同步到DreamEngine，形成架构理解学习闭环 |

**规则5的过滤逻辑**：仅当笔记的`confidence >= 0.8`（`WIKI_HIGH_CONFIDENCE_THRESHOLD`）时才写入LlmWiki。笔记的`category`映射规则：`'error-avoidance'` → `'troubleshooting'`，其他 → `'patterns'`。标题取笔记内容前80字符并去除特殊字符。

**规则8的Grader闭环**：融合自"AI Agent Dreaming"的Outcomes核心概念。当独立Grader代理完成评估后，将评估结果（共识分数、分歧度、低分改进建议）同步到DreamEngine，使DreamEngine能够从Grader的独立评估中学习，形成更精准的经验提炼。

**规则9的CodeWiki闭环**：融合自谷歌CodeWiki的"代码库自解释"理念。当CodeWikiOrchestrator完成编译后，将编译摘要（模块数、调用关系、过时文档、编译错误）同步到DreamEngine，使DreamEngine能够从代码库结构中学习，形成更精准的架构理解。

### 5.2 事件驱动机制

DreamBridge采用纯事件驱动架构，不使用轮询或定时器：

- **注册阶段**（`activate`）：为每条桥接规则在源模块上注册事件监听器，监听器引用存入`_listeners`数组
- **运行阶段**：源模块触发事件→桥接handler执行数据转换→调用目标模块方法→递增桥接统计→触发`bridge-executed`事件
- **注销阶段**（`deactivate`）：遍历`_listeners`数组，逐个调用`emitter.removeListener`移除监听器，清空数组

所有桥接handler均通过`safeExecute`包装，确保单条桥接失败不影响其他桥接和主流程。

### 5.3 内存泄漏防护

DreamBridge从三个层面防护内存泄漏：

1. **监听器追踪**：所有注册的事件监听器都记录在`_listeners`数组中（包含emitter、event、handler三元组），确保`deactivate`时能精确移除每一个监听器，不会遗留孤立监听器
2. **安全移除**：`deactivate`中每个`removeListener`调用都通过`safeExecute`包装，即使某个emitter已销毁也不会抛出异常
3. **关闭清理**：`_onShutdown`调用`deactivate`移除所有监听器，置空`_modules`对象和`_bridgeStats`，调用`removeAllListeners`清除Bridge自身的事件监听器

---

## 6. DreamBridge类定义与构造函数

### 继承体系

```
EventEmitter
  └─ DreamBridge（通过withShutdown混入ShutdownMixin）
```

与DreamOutcomes相同，继承EventEmitter并通过withShutdown混入关闭能力。

### 构造函数

```javascript
constructor()
```

无参数构造。所有模块依赖通过`attachXxx`方法注入，桥接通过`activate`方法激活。

### 内部状态

| 属性 | 类型 | 初始值 | 说明 |
|------|------|--------|------|
| `_modules` | Object | `{}` | 模块实例字典，key为MODULE_NAMES中的名称 |
| `_active` | boolean | `false` | 桥接激活状态 |
| `_listeners` | Array\<{emitter, event, handler}\> | `[]` | 已注册的事件监听器引用列表 |
| `_bridgeStats` | Object | `{activated: {}, failed: {}}` | 桥接执行统计 |

### MODULE_NAMES常量

```javascript
const MODULE_NAMES = {
  dreamEngine: 'DreamEngine',
  dreamOutcomes: 'DreamOutcomes',
  qualityScorer: 'QualityScorer',
  selfReflection: 'SelfReflection',
  skillImprovementLoop: 'SkillImprovementLoop',
  llmWiki: 'LlmWiki',
  brainMemory: 'BrainMemory',
};
```

作为静态属性`DreamBridge.MODULE_NAMES`导出，供外部查询桥接涉及的模块名称。

### 关闭行为

`_onShutdown`方法：调用`deactivate`移除所有监听器→置空`_modules`→重置`_bridgeStats`→调用`removeAllListeners`清除Bridge自身事件。

---

## 7. DreamBridge公开方法详解

### 7.1 attachXxx系列方法

7个attach方法，每个对应一个模块实例的注入：

| 方法 | 参数 | _modules key | 目标模块需提供的方法 |
|------|------|-------------|---------------------|
| `attachDreamEngine(engine)` | DreamEngine实例 | `'DreamEngine'` | `startDreaming`, `consumeReflectionInput` |
| `attachDreamOutcomes(outcomes)` | DreamOutcomes实例 | `'DreamOutcomes'` | `evaluateOutcome`, `syncToDreamEngine`, `syncToSkillImprovementLoop` |
| `attachQualityScorer(scorer)` | QualityScorer实例 | `'QualityScorer'` | 触发`score-computed`事件 |
| `attachSelfReflection(reflection)` | SelfReflection实例 | `'SelfReflection'` | 触发`reflection-completed`事件 |
| `attachSkillImprovementLoop(loop)` | SkillImprovementLoop实例 | `'SkillImprovementLoop'` | `recordLearning` |
| `attachLlmWiki(wiki)` | LlmWiki实例 | `'LlmWiki'` | `createEntry` |
| `attachBrainMemory(brainMemory)` | BrainMemory实例 | `'BrainMemory'` | 预留接口 |

所有attach方法对null/undefined参数做防御处理（`?? null`），不会抛出异常。

### 7.2 activate()

激活所有桥接，注册事件监听器。

**行为**：幂等操作（已激活时直接返回）→设置`_active = true`→依次调用4个注册方法：

1. `_registerQualityScorerBridge()`：若QualityScorer和DreamOutcomes均已注入，在QualityScorer上监听`score-computed`事件
2. `_registerSelfReflectionBridge()`：若SelfReflection和DreamEngine均已注入，在SelfReflection上监听`reflection-completed`事件
3. `_registerDreamOutcomesBridge()`：若DreamOutcomes和DreamEngine均已注入，监听`outcome-evaluated`触发`syncToDreamEngine`；若DreamOutcomes和SkillImprovementLoop均已注入，监听`outcome-evaluated`触发`syncToSkillImprovementLoop`
4. `_registerDreamEngineBridge()`：若DreamEngine和LlmWiki均已注入，在DreamEngine上监听`notes-merged`和`notes-generated`两个事件

→触发`bridge-activated`事件

**容错**：任一注册方法的前置模块未注入时，该桥接静默跳过，不影响其他桥接注册。

### 7.3 deactivate()

停用所有桥接，移除事件监听器。

**行为**：幂等操作（未激活时直接返回）→设置`_active = false`→遍历`_listeners`数组，逐个调用`emitter.removeListener(event, handler)`（通过safeExecute包装）→清空`_listeners`→触发`bridge-deactivated`事件

### 7.4 isActive()

查询桥接激活状态。

**返回值**：`boolean`

### 7.5 getBridgeStats()

获取桥接统计信息。

**返回值**：

```javascript
{
  active: boolean,                    // 当前是否激活
  bridgesActivated: { [bridgeName: string]: number },  // 各桥接触发次数
  bridgesFailed: { [bridgeName: string]: number }      // 各桥接失败次数
}
```

`bridgesActivated`的key为桥接名称（如`'QualityScorer->DreamOutcomes'`），value为触发次数。

### 7.6 getStats()

`getBridgeStats`的别名，遵循项目统一的`getStats`命名约定。

### 7.7 isHealthy()

检查桥接器健康状态。条件：未关闭。

**返回值**：`boolean`

---

## 8. 事件体系

### 8.1 DreamOutcomes事件

| 事件名 | 触发时机 | 数据结构 |
|--------|---------|----------|
| `outcome-defined` | `defineOutcome`成功后 | `{taskId: string, category: string}` |
| `outcome-evaluated` | `evaluateOutcome`成功后 | `{taskId, achieved, score, details, evaluatedAt}` |
| `outcome-achieved` | 评估结果achieved=true时 | 同`outcome-evaluated`的evaluation对象 |
| `outcome-missed` | 评估结果achieved=false时 | 同`outcome-evaluated`的evaluation对象 |
| `note-usage-recorded` | `recordNoteUsage`成功后 | `{noteId: string, context: string, uses: number}` |
| `note-outcome-recorded` | `recordNoteOutcome`成功后 | `{noteId: string, effective: boolean}` |
| `synced-to-dream-engine` | `syncToDreamEngine`完成后 | `{synced: number, errors: number, evaluationsCount: number}` |
| `synced-to-improvement-loop` | `syncToSkillImprovementLoop`完成后 | `{synced: number, errors: number, evaluationsCount: number}` |
| `grader-registered` | `registerGraderAgent`成功后 | `{graderId: string, specialties: string[]}` |
| `grader-evaluated` | `evaluateWithGrader`完成后 | `{taskId, graderScores, consensusScore, consensusReached, divergence, evaluatedAt}` |

### 8.2 DreamBridge事件

| 事件名 | 触发时机 | 数据结构 |
|--------|---------|----------|
| `bridge-activated` | `activate`成功后 | `{bridges: string[]}` — 已注册的桥接名称列表 |
| `bridge-deactivated` | `deactivate`完成后 | `{}` |
| `bridge-executed` | 任一桥接handler执行后 | `{bridge: string}` — 桥接名称，如`'QualityScorer->DreamOutcomes'` |
| `bridge-failed` | 预留，当前未触发 | — |

### 8.3 桥接涉及的源模块事件

以下事件由外部模块触发，DreamBridge监听后执行桥接：

| 源模块 | 事件名 | DreamBridge桥接目标 |
|--------|--------|-------------------|
| QualityScorer | `score-computed` | DreamOutcomes.evaluateOutcome |
| SelfReflection | `reflection-completed` | DreamEngine.consumeReflectionInput |
| DreamOutcomes | `outcome-evaluated` | DreamEngine（syncToDreamEngine）+ SkillImprovementLoop（syncToSkillImprovementLoop） |
| DreamEngine | `notes-merged` | LlmWiki.createEntry |
| DreamEngine | `notes-generated` | LlmWiki.createEntry |

---

## 9. 使用示例

### 9.1 DreamOutcomes基本使用

```javascript
const DreamOutcomes = require('./src/runtime/thought/dream-outcomes');

const outcomes = new DreamOutcomes();

outcomes.defineOutcome('task-001', {
  description: '代码审查任务完成度',
  metrics: [
    { name: 'filesReviewed', target: 10, weight: 2 },
    { name: 'issuesFound', target: 5, weight: 1 },
    { name: 'coverage', target: 0.9, weight: 3 },
  ],
  category: 'task',
});

outcomes.on('outcome-evaluated', (evaluation) => {
  console.log('评估完成:', evaluation.taskId, '得分:', evaluation.score, '达成:', evaluation.achieved);
});

const result = outcomes.evaluateOutcome('task-001', {
  metrics: [
    { name: 'filesReviewed', actual: 8 },
    { name: 'issuesFound', actual: 6 },
    { name: 'coverage', actual: 0.85 },
  ],
});

outcomes.recordNoteUsage('note-pattern-42', '代码审查模式匹配');
outcomes.recordNoteOutcome('note-pattern-42', true);

console.log(outcomes.getStats());
console.log(outcomes.getNoteEffectiveness('note-pattern-42'));
```

### 9.2 DreamBridge桥接配置

```javascript
const DreamBridge = require('./src/runtime/thought/dream-bridge');

const bridge = new DreamBridge();

bridge.attachDreamEngine(dreamEngineInstance);
bridge.attachDreamOutcomes(dreamOutcomesInstance);
bridge.attachQualityScorer(qualityScorerInstance);
bridge.attachSelfReflection(selfReflectionInstance);
bridge.attachSkillImprovementLoop(skillImprovementLoopInstance);
bridge.attachLlmWiki(llmWikiInstance);

bridge.on('bridge-activated', ({ bridges }) => {
  console.log('桥接已激活:', bridges);
});

bridge.on('bridge-executed', ({ bridge: name }) => {
  console.log('桥接执行:', name);
});

bridge.activate();

console.log(bridge.getBridgeStats());

bridge.deactivate();
```

### 9.3 两者集成使用

```javascript
const DreamOutcomes = require('./src/runtime/thought/dream-outcomes');
const DreamBridge = require('./src/runtime/thought/dream-bridge');

const outcomes = new DreamOutcomes();
outcomes.attachDreamEngine(dreamEngineInstance);
outcomes.attachSkillImprovementLoop(skillImprovementLoopInstance);

const bridge = new DreamBridge();
bridge.attachDreamEngine(dreamEngineInstance);
bridge.attachDreamOutcomes(outcomes);
bridge.attachQualityScorer(qualityScorerInstance);
bridge.attachSelfReflection(selfReflectionInstance);
bridge.attachSkillImprovementLoop(skillImprovementLoopInstance);
bridge.attachLlmWiki(llmWikiInstance);

bridge.activate();

outcomes.defineOutcome('task-002', {
  description: '集成测试通过率',
  metrics: [
    { name: 'passRate', target: 0.95, weight: 3 },
    { name: 'coverage', target: 0.8, weight: 2 },
  ],
  category: 'task',
});

outcomes.evaluateOutcome('task-002', {
  metrics: [
    { name: 'passRate', actual: 0.92 },
    { name: 'coverage', actual: 0.85 },
  ],
});

outcomes.recordNoteUsage('dream-note-001', '测试模式优化');
outcomes.recordNoteOutcome('dream-note-001', true);

const lowNotes = outcomes.getLowEffectivenessNotes(0.3);
console.log('待清理笔记:', lowNotes);

console.log('Outcomes统计:', outcomes.getStats());
console.log('Bridge统计:', bridge.getBridgeStats());
```

---

## 相关文档

- [[模块详解-思维子系统]] — 思维子系统总览
- [[模块详解-DreamScheduler梦境调度器]] — DreamScheduler定时调度
- [[模块详解-Brain记忆系统]] — BrainMemory记忆架构
- [[模块详解-QualityScorer质量评分器]] — QualityScorer评分机制
- [[核心功能-记忆管道系统]] — 记忆管道Hermes三阶段流程
