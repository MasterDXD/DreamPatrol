# 模块详解 — DynamicHarnessGenerator 动态工作流 Harness 生成器

> 所属子系统：[[工作流子系统]] | 依赖：[[DynamicWorkflowEngine]] [[TaskDecomposer]] [[SubagentExecutor]] [[AdversarialReview]] [[CheckpointManager]] [[CapabilityGapAnalyzer]] | 参考：Anthropic Dynamic Workflow Harness | 版本：2.73.4

---

## 模块概述

`DynamicHarnessGenerator` 融合 Anthropic 动态工作流 Harness 理念，让 AI 针对任务自动生成调度脚本，实现从"概率黑盒"到"工业级确定性工程"的跨越。

**核心公式：Agent = Model + Harness**
模型决定能力上限，Harness 决定能否驾驭它完成复杂任务。

**源码位置**：`src/runtime/workflow/dynamic-harness-generator.js`（~1208行）

---

## 模块定位

在工作流子系统中，`DynamicHarnessGenerator` 是最高层级的动态编排引擎：

- **RalphWiggumLoop**：自主开发闭环（generate→review→test→fix→learn）
- **DynamicWorkflowEngine**：DAG 工作流引擎（DSL 编译 + 执行）
- **DynamicHarnessGenerator**：AI 驱动的动态脚本生成 + 沙箱执行 + 确定性编排

---

## 架构角色

```
                    DynamicHarnessGenerator
               ┌──────────────────────────────────────────┐
Prompt ───────→│  generateAndExecute(task, context)        │
               │   ├── _generateScript()                  │──→ LLM Client / SkillExecutor
               │   │    └── 生成 JavaScript Harness 脚本  │
               │   ├── _compileScript()                   │──→ 语法检查 + 安全扫描
               │   ├── _executeScript()                   │──→ vm.Script 沙箱执行
               │   │    └── Harness DSL API               │
               │   │        ├── parallel()                │──→ SubagentExecutor
               │   │        ├── sequential()              │──→ SubagentExecutor
               │   │        ├── subagent()                │──→ SubagentExecutor
               │   │        ├── verify()                  │──→ AdversarialReview
               │   │        ├── checkpoint()              │──→ CheckpointManager
               │   │        ├── decompose()               │──→ TaskDecomposer
               │   │        ├── log()                     │──→ 日志输出
               │   │        ├── setBudget()               │──→ Token 预算
               │   │        └── getBudget()               │──→ 预算查询
               │   ├── _runAdversarialVerification()      │──→ AdversarialReview
               │   ├── _saveCheckpoint()                  │──→ CheckpointManager
               │   └── on failure:                        │
               │        └── CapabilityGapAnalyzer          │──→ 能力缺口分析
               │                                           │
外部依赖 ─────→│  _skillExecutor / _llmClient               │
               │  _subagentExecutor                        │
               │  _dynamicWorkflowEngine                   │
               │  _taskDecomposer                          │
               │  _adversarialReview                       │
               │  _checkpointManager                       │
               │  _capabilityGapAnalyzer                   │
               └──────────────────────────────────────────┘
```

---

## 三大突破

### 1. 确定性代码框住概率输出
AI 生成 JavaScript 脚本，将任务拆解、子 Agent 并行、校验器调用等逻辑"写死"在代码里，用确定性程序约束模型的概率性输出。

### 2. 自带对抗验证
A Agent 写代码，B Agent 专门挑错，甚至调用更强的模型审查，过不了验证闭环就无法推进，保障输出质量。

### 3. 留痕容灾
内置检查点机制，哪怕任务跑了 3 小时、派了数百个子 Agent 中途被叫停，也能记住执行状态，下次继续从断点运行。

---

## 工作流

```
Prompt → [Script Generation] → [Compile] → [Execute in Sandbox] → [Verify] → [Checkpoint] → Done
              ↑         ↓                                          │
              │    [LLM Client]                                    │
              │    [Skill Executor]                                │
              │    [Fallback Template]                             │
              └────────────────────────────────────────────────────┘
```

### 状态转换

```
IDLE → GENERATING → COMPILING → EXECUTING → VERIFYING → COMPLETED
              ↓            ↓           ↓           ↓           ↓
                         FAILED ←───────────────────────────────┘
                                              ↓
                                        (gap analysis on failure)
```

---

## Harness DSL API

脚本中获得 `harness` 对象，提供以下 API：

| API | 功能 | 参数 |
|-----|------|------|
| `harness.parallel(tasks)` | 并行执行子任务（max 20） | `Array<{task, agentType?}>` |
| `harness.sequential(tasks)` | 顺序执行子任务 | `Array<{task, agentType?}>` |
| `harness.subagent(task, agentType)` | 生成单个子 Agent | `task: string, agentType?: string` |
| `harness.verify(subject, criteria)` | 对抗验证 | `subject: any, criteria?: string[]` |
| `harness.checkpoint(name, data)` | 保存检查点 | `name: string, data?: Object` |
| `harness.decompose(task)` | 任务分解 | `task: string` |
| `harness.log(message)` | 日志记录 | `message: string` |
| `harness.setBudget(tokens)` | 设置 Token 预算 | `tokens: number` |
| `harness.getBudget()` | 获取剩余预算 | 返回 `number` |

---

## 触发方式

在 Prompt 中加入以下关键字触发动态工作流（支持中英文）：

**英文关键字**：`workflow`, `ultracode`, `harness`

**中文关键字**：`动态工作流`, `并行agent`, `对抗验证`, `检查点`, `断点续跑`, `确定性工程`, `子agent并行`, `调度脚本`

```javascript
// 静态检测
DynamicHarnessGenerator.isTriggered('筛选80份简历并排序 workflow'); // true
DynamicHarnessGenerator.isTriggered('使用动态工作流处理任务'); // true
DynamicHarnessGenerator.isTriggered('build a simple API'); // false
DynamicHarnessGenerator.isTriggered(null); // false
```

---

## 安全检查

脚本编译时自动拒绝以下危险操作：
- `require()` — 禁止引用外部模块
- `import` — 禁止 ES 模块导入
- `process.exit()` — 禁止进程退出
- `child_process` — 禁止子进程
- `fs.` — 禁止文件系统操作
- `eval()` — 禁止动态代码执行
- `Function()` — 禁止动态函数构造

---

## 使用示例

```javascript
const { DynamicHarnessGenerator } = require('./src/runtime/workflow/dynamic-harness-generator');

const generator = new DynamicHarnessGenerator({
  maxParallelAgents: 20,
  tokenBudget: 100000,
  autoCheckpoint: true,
  enableAdversarialReview: true,
});

// 注入依赖
generator
  .attachLLMClient({ complete: async (prompt) => ({ content: '...' }) })
  .attachSkillExecutor(async (skillId, ctx) => ({ result: '...' }))
  .attachSubagentExecutor(subagentExecutor)
  .attachAdversarialReview(adversarialReview)
  .attachCheckpointManager(checkpointManager)
  .attachTaskDecomposer(taskDecomposer)
  .attachCapabilityGapAnalyzer(gapAnalyzer);

// 执行动态工作流
const result = await generator.generateAndExecute(
  '筛选 80 份简历，自动排序，复核前十，生成评估报告 workflow',
  { projectRoot: '/path/to/project' },
);

console.log(result.summary);
console.log('Script:', result.script);
console.log('Nodes executed:', result.nodesExecuted);
console.log('Tokens used:', result.tokensUsed);
console.log('Verification:', result.verification);
```

### 检查点恢复

```javascript
// 从检查点恢复执行
const resumeResult = await generator.resumeFromCheckpoint('checkpoint-id');
console.log('Resumed:', resumeResult.success ? 'success' : 'failed: ' + resumeResult.error);
```

### 取消执行

```javascript
// 异步取消正在执行的 harness
generator.cancel();
```

### 错误处理

```javascript
const result = await generator.generateAndExecute(task, context);

if (!result.success) {
  console.error('Harness 执行失败:', result.error);
  if (result.gapAnalysis) {
    console.log('能力缺口:', result.gapAnalysis.gaps);
    console.log('建议:', result.gapAnalysis.recommendations);
  }
}
```

---

## Harness 脚本示例

```javascript
// AI 自动生成的 Harness 脚本
async function run(harness) {
  harness.setBudget(50000);
  harness.log('开始简历筛选工作流');

  // 步骤1：分解任务
  const subtasks = harness.decompose('筛选简历。排序。复核。生成报告');
  harness.checkpoint('task-decomposed', { count: subtasks.length });

  // 步骤2：并行处理简历
  const results = await harness.parallel(
    subtasks.map(t => ({ task: t.description, agentType: 'resume-processor' }))
  );
  harness.checkpoint('resumes-processed', { processed: results.length });

  // 步骤3：对抗验证
  const verification = await harness.verify(results, ['accuracy', 'fairness']);
  if (!verification.passed) {
    harness.log('验证未通过，需要人工复核');
  }

  harness.checkpoint('verified', { passed: verification.passed });
  harness.log('工作流执行完成');

  return {
    success: verification.passed,
    results,
    summary: `处理了 ${results.length} 份简历，验证${verification.passed ? '通过' : '未通过'}`,
  };
}
```

---

## 事件

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| `state-change` | 状态变更时 | `{ from, to }` |
| `script-generated` | 脚本生成完成时 | `{ executionId, scriptSize }` |
| `script-compiled` | 脚本编译通过时 | `{ executionId }` |
| `execution-started` | 开始执行时 | `{ executionId }` |
| `checkpoint-created` | 检查点创建时 | `{ name, timestamp, data }` |
| `verification-result` | 验证完成时 | `{ passed, feedback, rounds }` |
| `budget-warning` | 预算告警时 | `{ used, budget, ratio }` |
| `execution-completed` | 执行完成时 | 完整结果对象 |
| `execution-failed` | 执行失败时 | `{ executionId, error }` |

---

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `scriptTimeoutMs` | 300000 | 脚本执行超时（毫秒） |
| `maxParallelAgents` | 20 | 最大并行 Agent 数 |
| `maxScriptSize` | 65536 | 脚本最大大小（字节） |
| `autoCheckpoint` | true | 是否自动保存检查点 |
| `checkpointInterval` | 5 | 检查点间隔（节点数） |
| `enableAdversarialReview` | true | 是否启用对抗审查 |
| `enableGapAnalysis` | true | 是否启用缺口分析 |
| `tokenBudget` | 100000 | Token 预算 |
| `maxRetries` | 3 | 最大重试次数 |
| `budgetWarningRatio` | 0.8 | 预算告警比例 |

---

## 完整 API 参考

### 构造函数

```javascript
new DynamicHarnessGenerator(options?: {
  maxParallelAgents?: number;     // 最大并行Agent数（默认20）
  tokenBudget?: number;           // Token预算（默认100000）
  scriptTimeoutMs?: number;       // 脚本执行超时（默认300000ms）
  enableAdversarialReview?: boolean;  // 启用对抗验证（默认true）
  autoCheckpoint?: boolean;       // 自动检查点（默认true）
  enableGapAnalysis?: boolean;    // 启用缺口分析（默认true）
  maxRetries?: number;            // 最大重试次数（默认3）
})
```

### 依赖注入方法

| 方法 | 说明 |
|------|------|
| `attachLLMClient(client)` | 注入 LLM 客户端 |
| `attachSkillExecutor(executor)` | 注入 Skill 执行器 |
| `attachSubagentExecutor(executor)` | 注入子 Agent 执行器 |
| `attachAdversarialReview(review)` | 注入对抗验证器 |
| `attachCheckpointManager(manager)` | 注入检查点管理器 |
| `attachTaskDecomposer(decomposer)` | 注入任务分解器 |
| `attachCapabilityGapAnalyzer(analyzer)` | 注入能力缺口分析器 |
| `attachDynamicWorkflowEngine(engine)` | 注入动态工作流引擎 |

所有依赖注入方法均返回 `this`，支持链式调用。

### 核心执行方法

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `generateAndExecute(task, context?)` | 生成并执行 Harness 脚本 | `Promise<{ success, result, script, ... }>` |
| `resumeFromCheckpoint(checkpointId)` | 从检查点恢复执行 | `Promise<{ success, ... }>` |
| `cancel()` | 取消当前执行 | `void` |

### 状态与统计

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `getStatus()` | 获取当前状态（参见 HARNESS_STATUS） | `string` |
| `getStats()` | 获取执行统计信息 | `{ totalExecutions, totalTokens, avgDuration, ... }` |
| `getHistory(limit?)` | 获取执行历史记录 | `Array<{ id, task, success, ... }>` |
| `isHealthy()` | 检查实例是否健康 | `boolean` |

### 生命周期方法

| 方法 | 说明 |
|------|------|
| `on(event, listener)` | 注册事件监听器（继承自 EventEmitter） |
| `shutdown()` | 优雅关闭，释放资源 |
| `guardShutdown()` | 检查是否已关闭，已关闭则抛出错误 |

### 静态方法

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `isTriggered(taskDescription)` | 检测任务是否触发动态工作流 | `boolean` |

### 常量

| 常量 | 说明 |
|------|------|
| `HARNESS_STATUS` | 状态枚举：`IDLE`, `GENERATING`, `COMPILING`, `EXECUTING`, `PAUSED`, `CHECKPOINTING`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `TRIGGER_KEYWORDS` | 触发关键词列表（含中英文） |