# 模块详解 — ChatChain 链式对话编排器

> 所属子系统：[[协作子系统]] | 融合自：ChatDev + Claude Collab Flow | 版本：2.73.4

## 模块概述

`chat-chain.js` 是框架的链式对话编排器，编排多Agent按预定义的原子任务链顺序处理，上下文在链中逐级传递和累积。内置六阶段原子任务链模板（brainstorming→requirement-analysis→architecture-design→module-development→integration-testing→deployment），支持任务依赖解析、条件分支、TDD阶段标记、阶段产物追踪和批注式协作。

**源码位置**：`src/runtime/collaboration/chat-chain.js`

## 核心能力

| 能力 | 说明 |
|------|------|
| 六阶段原子任务链 | 预定义6个阶段模板，覆盖完整开发生命周期 |
| 任务依赖解析 | 拓扑排序自动解析任务依赖，并行执行无依赖任务 |
| 条件分支 | 支持`condition`条件触发和`mode`协作模式切换 |
| TDD阶段标记 | 内置RED-GREEN-REFACTOR三阶段标记 |
| 阶段产物追踪 | 产物注册、版本化、跨阶段流转与溯源 |
| 批注式协作 | 代码审查批注、bug标注、优化建议、提问讨论 |
| 任务重试 | 失败任务自动重试（最多3次），指数退避 |

## 六阶段原子任务链

### 1. brainstorming（探索阶段）
| 任务ID | Agent | 技能 | 描述 | 必填 |
|--------|-------|------|------|------|
| `explore-requirements` | team-lead | brainstorming | 探索需求边界和约束 | 是 |
| `validate-feasibility` | domain-analyst | brainstorming | 验证技术可行性 | 是 |

### 2. requirement-analysis（分析阶段）
| 任务ID | Agent | 技能 | 描述 | 必填 |
|--------|-------|------|------|------|
| `gather-requirements` | team-lead | requirement-analysis | 收集和整理需求 | 是 |
| `analyze-constraints` | domain-analyst | requirement-analysis | 分析技术约束和依赖 | 是 |
| `define-acceptance` | quality-assurance | requirement-analysis | 定义验收标准 | 否 |

### 3. architecture-design（设计阶段）
| 任务ID | Agent | 技能 | 描述 | 必填 |
|--------|-------|------|------|------|
| `design-architecture` | domain-analyst | architecture-design | 设计系统架构 | 是 |
| `review-architecture` | domain-analyst | code-review | 审查架构设计（PairChat） | 是 |
| `define-interfaces` | domain-analyst | architecture-design | 定义模块接口 | 是 |

### 4. module-development（开发阶段）
| 任务ID | Agent | 技能 | 描述 | 必填 | TDD阶段 |
|--------|-------|------|------|------|---------|
| `write-test-first` | task-worker | tdd-implement | 编写测试用例 | 是 | RED |
| `implement-feature` | task-worker | tdd-implement | 实现功能代码 | 是 | GREEN |
| `pair-review-code` | domain-analyst | code-review | 两两对话审查代码 | 是 | — |
| `refactor-if-needed` | task-worker | refactor-code | 根据审查反馈重构 | 否 | REFACTOR |
| `security-check` | quality-assurance | security-audit | 安全审计 | 是 | — |
| `self-reflect` | task-worker | verification-before-completion | 自反思验证 | 是 | — |

### 5. integration-testing（测试阶段）
| 任务ID | Agent | 技能 | 描述 | 必填 |
|--------|-------|------|------|------|
| `write-integration-tests` | quality-assurance | integration-testing | 编写集成测试 | 是 |
| `pair-debug-failures` | QA+Worker | systematic-debugging | 两两对话协同调试 | 否 |
| `regression-check` | quality-assurance | verification-before-completion | 回归验证 | 是 |

### 6. deployment（部署阶段）
| 任务ID | Agent | 技能 | 描述 | 必填 |
|--------|-------|------|------|------|
| `generate-docs` | technical-writer | documentation | 生成项目文档 | 是 |
| `auto-doc-gen` | technical-writer | auto-doc-generation | 自动生成用户手册和依赖说明 | 是 |
| `deploy` | devops-engineer | deployment | 部署上线 | 是 |
| `health-check` | devops-engineer | verification-before-completion | 部署后健康检查 | 是 |

## 任务状态

| 状态 | 常量 | 说明 |
|------|------|------|
| 待处理 | `PENDING` | 初始状态，等待依赖任务完成 |
| 进行中 | `IN_PROGRESS` | 正在执行 |
| 已完成 | `COMPLETED` | 执行成功 |
| 已跳过 | `SKIPPED` | 条件不满足，跳过执行 |
| 已失败 | `FAILED` | 执行失败（可重试） |
| 已阻塞 | `BLOCKED` | 被依赖任务阻塞 |

## 批注式协作

ChatChain 支持批注式协作（融合自Claude Collab Flow），允许在代码审查、bug修复、优化建议等场景中精确定位和标注问题。

### 批注类型

| 类型 | 说明 |
|------|------|
| `review` | 代码审查批注 |
| `bug` | Bug标注 |
| `optimization` | 优化建议 |
| `question` | 提问讨论 |
| `suggestion` | 改进建议 |

### 批注结构

```javascript
{
  id: 'annot-1717500000000-123',     // 唯一ID
  chainId: '...',                     // 所属链ID
  taskId: 'pair-review-code',        // 关联任务ID（可选）
  line: 42,                          // 行号（可选）
  file: 'src/module.js',            // 文件路径（可选）
  type: 'bug',                       // 批注类型
  message: '空指针未检查',            // 批注内容
  author: 'domain-analyst',          // 作者
  status: 'open',                    // 状态：open/resolved
  createdAt: '2026-06-04T...',      // 创建时间
  resolvedAt: null,                  // 解决时间
  resolution: null,                  // 解决方案
  response: null,                    // 回应
}
```

## API 参考

### 构造函数

#### `new ChatChain(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.maxChains` | number | 否 | 100 | 最大链数量，超出时淘汰已完成的链 |

### 链管理方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `createChain(options)` | object | `{ chainId, chain }` | 创建新链 |
| `getChain(chainId)` | string | object\|null | 获取链信息 |
| `getChainStatus(chainId)` | string | object | 获取链状态摘要 |
| `getAllChains()` | — | object[] | 获取所有链 |
| `removeChain(chainId)` | string | boolean | 移除链 |

### 任务管理方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `startChain(chainId)` | string | Promise\<object\> | 启动链执行 |
| `executeTask(chainId, taskId)` | string, string | Promise\<object\> | 手动执行单个任务 |
| `retryTask(chainId, taskId)` | string, string | Promise\<object\> | 重试失败任务 |
| `skipTask(chainId, taskId)` | string, string | object | 跳过条件任务 |
| `getTaskResult(chainId, taskId)` | string, string | object\|null | 获取任务结果 |

### 产物追踪方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `registerArtifact(chainId, artifact)` | string, object | `{ artifactId }` | 注册阶段产物 |
| `getArtifactFlow(chainId)` | string | object[] | 获取产物流转视图 |
| `getArtifactsByPhase(chainId, phase)` | string, string | object[] | 按阶段获取产物 |

### 批注方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `addAnnotation(chainId, annotation)` | string, object | `{ annotation }` | 添加批注 |
| `getAnnotations(chainId, options)` | string, object | object[] | 获取批注列表 |
| `resolveAnnotation(chainId, annotationId, resolution)` | string, string, string | `{ annotation }` | 解决批注 |
| `respondToAnnotation(chainId, annotationId, response)` | string, string, string | `{ annotation }` | 回应批注 |
| `getAnnotationSummary(chainId)` | string | object | 获取批注摘要 |

### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `chain-created` | 链创建 | `{ chainId, chain }` |
| `chain-started` | 链开始执行 | `{ chainId }` |
| `task-started` | 任务开始 | `{ chainId, taskId }` |
| `task-completed` | 任务完成 | `{ chainId, taskId, result }` |
| `task-failed` | 任务失败 | `{ chainId, taskId, error }` |
| `task-skipped` | 任务跳过 | `{ chainId, taskId }` |
| `task-retry` | 任务重试 | `{ chainId, taskId, attempt }` |
| `chain-completed` | 链完成 | `{ chainId, summary }` |
| `chain-failed` | 链失败 | `{ chainId, error }` |
| `artifact-registered` | 产物注册 | `{ chainId, artifactId, artifact }` |
| `artifact-versioned` | 产物版本化 | `{ chainId, artifactId, version }` |
| `annotation-added` | 批注添加 | `{ annotation }` |

## 使用示例

```javascript
const ChatChain = require('./src/runtime/collaboration/chat-chain');

const chain = new ChatChain();

// 创建模块开发链
const { chainId } = chain.createChain({
  name: 'User Auth Module',
  workflow: 'module-development',
  artifacts: { input: '需求文档v2', context: '用户认证模块' },
  annotations: { enabled: true },
});

// 添加批注
chain.addAnnotation(chainId, {
  taskId: 'pair-review-code',
  file: 'src/auth/login.js',
  line: 42,
  type: 'bug',
  message: '缺少SQL注入防护',
  author: 'security-reviewer',
});

// 解决批注
chain.resolveAnnotation(chainId, 'annot-xxx', '已添加参数化查询');

// 查看批注摘要
const summary = chain.getAnnotationSummary(chainId);
console.log(summary);
// → { total: 1, open: 0, resolved: 1, byType: { bug: 1 } }

// 注册产物
chain.registerArtifact(chainId, {
  name: 'login-module',
  type: 'code',
  phase: 'coding',
  content: '...',
  version: '1.0.0',
});

// 查看产物流转
const flow = chain.getArtifactFlow(chainId);
console.log(flow.map(a => a.name));
// → ['design-doc', 'login-module', 'test-suite']

// 启动链
const result = await chain.startChain(chainId);
console.log(result.status); // → 'completed'

chain.shutdown();
```

## 与其他模块的关系

```
ChatChain
  ├── PairChat — 两两对话交叉验证（pair-chat模式）
  ├── OptimizationLoop — 版本轨迹（协作产物版本管理）
  ├── SkillRouter — 技能路由（技能自动匹配）
  ├── EventBus — 事件总线（链事件发布）
  └── DevMetricsCollector — 开发指标采集（链完成度量）
```

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `ATOMIC_TASK_CHAINS` | 6个阶段 | 预定义原子任务链模板 |
| `TASK_STATUS.PENDING` | `'pending'` | 待处理 |
| `TASK_STATUS.IN_PROGRESS` | `'in_progress'` | 进行中 |
| `TASK_STATUS.COMPLETED` | `'completed'` | 已完成 |
| `TASK_STATUS.FAILED` | `'failed'` | 已失败 |
| `TASK_STATUS.BLOCKED` | `'blocked'` | 已阻塞 |

## 相关文档

- [[模块详解-协作子系统]] — 协作子系统总览
- [[模块详解-PairChat模块]] — 两两对话交叉验证（如有）
- [[核心功能-多Agent协作流程]] — 多Agent协作流程
- [[模块详解-OptimizationLoop优化循环]] — 版本轨迹功能