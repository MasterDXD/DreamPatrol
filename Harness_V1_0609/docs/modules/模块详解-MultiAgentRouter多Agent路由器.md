# 模块详解-MultiAgentRouter多Agent路由器

> 版本：2.73.4 | 文件：src/runtime/agent/multi-agent-router.js

---

## 模块概述

MultiAgentRouter是多Agent路由器，负责将任务智能匹配到最合适的Agent。它基于任务类型识别、Agent能力画像和负载均衡三重机制，实现高效的任务-Agent调度。同时支持亲和力学习——通过历史反馈动态调整Agent与任务类型的匹配权重，使路由决策随使用不断优化。

核心设计理念：
- **能力匹配**：预定义6种职能型Agent的能力画像（strengths + scope），与任务类型信号进行语义匹配
- **负载感知**：路由评分时考虑Agent当前活跃任务数，负载越低优先级越高
- **亲和力学习**：通过`updateAffinity()`动态调整Agent-任务类型的匹配权重，实现经验积累
- **Top-K选择**：返回亲和度最高的K个Agent，支持多Agent协同处理
- **中英双语信号**：任务类型信号同时覆盖中文和英文关键词，适配多语言场景

## 类定义

```javascript
class MultiAgentRouter extends EventEmitter {
  constructor(options)

  // 路由核心
  route(task, availableAgents)

  // 亲和力管理
  updateAffinity(agentId, taskType, delta)
  getAffinity(agentId, taskType)

  // 负载管理
  recordAgentLoad(agentId, activeTaskCount)

  // 查询方法
  getRoutingHistory(limit)
  getStats()

  // 内部方法
  _identifyTaskTypes(task)
  _computeAffinities(taskTypes, agents)
  _extractDescription(task)
  _getAgentLoad(agentId)
  _onShutdown()
}
```

### 关键属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `_topK` | number | 路由返回的Top-K Agent数量，默认2 |
| `_minAffinity` | number | 最低亲和度阈值，低于此值的Agent不参与路由，默认0.3 |
| `_agentAffinities` | Map<string, object> | 学习到的Agent亲和力表，key为agentId，value为{taskType: score} |
| `_maxHistory` | number | 路由历史记录上限，默认500 |
| `_routingHistory` | RingBuffer | 环形缓冲区存储路由历史 |
| `_agentLoad` | Map<string, number> | Agent当前负载表，key为agentId，value为活跃任务数 |

### 静态属性

| 属性 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_TOP_K` | 2 | 默认Top-K值 |
| `DEFAULT_MIN_AFFINITY` | 0.3 | 默认最低亲和度 |
| `AGENT_CAPABILITIES` | object | 6种职能型Agent能力画像 |
| `TASK_TYPE_SIGNALS` | object | 10种任务类型的信号词表 |

## 公开API

### constructor(options)

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.topK` | number | 2 | 路由返回的Agent数量 |
| `options.minAffinity` | number | 0.3 | 最低亲和度阈值 |
| `options.maxHistory` | number | 500 | 路由历史记录上限 |

---

### route(task, availableAgents)

根据任务描述将任务路由到最合适的Agent。

| 参数 | 类型 | 说明 |
|------|------|------|
| `task` | object | 任务对象，需包含description/goal/message/userMessage中至少一个 |
| `availableAgents` | string[] \| undefined | 可用Agent ID列表，不传则使用全部AGENT_CAPABILITIES |

**返回值**：

```javascript
{
  agents: Array<{agentId, score, capabilities}>,  // Top-K Agent列表
  affinities: { [agentId]: number },               // 所有Agent亲和度评分
  taskTypes: string[],                              // 识别出的任务类型
  routingId: string,                                // 路由唯一ID（mar-前缀）
  timestamp: string                                 // 路由时间戳
}
```

当task为空或非对象时，返回`{ agents: [], affinities: {}, taskTypes: [] }`。

**路由算法**：
1. 从任务对象中提取描述文本
2. 通过信号词匹配识别任务类型（`_identifyTaskTypes`）
3. 计算每个Agent的亲和度评分（`_computeAffinities`）
4. 过滤低于`minAffinity`阈值的Agent
5. 按负载调整后的评分降序排序：`score * (1 / (1 + load))`
6. 返回Top-K个Agent

---

### updateAffinity(agentId, taskType, delta)

更新Agent对特定任务类型的亲和力权重。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |
| `taskType` | string | 任务类型（如'implementation'、'review'） |
| `delta` | number | 亲和力增量，正值增强、负值减弱 |

**行为**：
- 初始亲和力默认为0.5
- 最终值通过`clamp01`约束在[0, 1]区间
- delta非有限数时视为0

---

### getAffinity(agentId, taskType)

查询Agent对特定任务类型的亲和力。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |
| `taskType` | string | 任务类型 |

**返回值**：`number` — 亲和度值[0, 1]，默认0.5

---

### recordAgentLoad(agentId, activeTaskCount)

记录Agent当前活跃任务数，用于负载感知路由。

| 参数 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent唯一标识符 |
| `activeTaskCount` | number | 当前活跃任务数 |

---

### getRoutingHistory(limit)

查询路由历史记录。

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | number \| undefined | 返回最近N条记录，默认返回全部 |

**返回值**：`Array<RoutingRecord>`

---

### getStats()

获取路由器统计信息。

**返回值**：

```javascript
{
  totalRoutings: number,       // 历史路由总数
  topK: number,                // 当前Top-K配置
  minAffinity: number,         // 当前最低亲和度阈值
  knownAgents: number,         // 已知Agent数量
  learnedAffinities: number    // 已学习亲和力的Agent数量
}
```

## Agent能力画像

| Agent ID | 能力标签(strengths) | 作用域(scope) |
|----------|---------------------|---------------|
| `team-lead` | coordination, planning, dispatching | project |
| `domain-analyst` | analysis, design, review, architecture | domain |
| `task-worker` | implementation, coding, debugging, testing | task |
| `quality-assurance` | testing, review, security, verification | quality |
| `devops-engineer` | deployment, infrastructure, monitoring | operations |
| `technical-writer` | documentation, knowledge, communication | docs |

## 任务类型信号表

| 任务类型 | 中文信号 | 英文信号 |
|---------|---------|---------|
| `coordination` | 协调、分配、管理 | coordinate, manage, dispatch |
| `analysis` | 分析、设计、评估 | analyze, design, evaluate |
| `implementation` | 实现、编码、开发 | implement, code, develop |
| `testing` | 测试、验证 | test, verify, validate |
| `review` | 审查、审核 | review, inspect, audit |
| `deployment` | 部署、上线 | deploy, release, ship |
| `documentation` | 文档、说明 | document, describe |
| `security` | 安全、漏洞 | security, vulnerability |
| `debugging` | 调试、修复 | debug, fix, troubleshoot |
| `architecture` | 架构、模块 | architecture, module, structure |

**默认回退**：当无法识别任何任务类型时，默认归类为`implementation`。

## 状态机/流程图

### 路由决策流程

```
任务输入
  │
  ▼
┌──────────────────────┐
│ _extractDescription  │  提取任务描述文本
│ (description/goal/   │  拼接description + goal +
│  message/userMessage)│  message + userMessage
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ _identifyTaskTypes   │  信号词匹配识别任务类型
│ 遍历TASK_TYPE_SIGNALS│  中英文双语匹配
│ 匹配→加入types列表   │  无匹配→默认implementation
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ _computeAffinities   │  计算Agent亲和度
│ ┌──────────────────┐ │
│ │ 基础评分         │ │  strengthSet匹配→+0.3/类型
│ │ (上限1.0)        │ │  无匹配→0.1
│ └────────┬─────────┘ │
│          │           │
│ ┌────────▼─────────┐ │
│ │ 学习加成         │ │  learnedAffinity[type]-0.5
│ │ (clamp01约束)    │ │  ×0.2叠加到基础分
│ └──────────────────┘ │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 过滤 + 负载排序      │
│ score >= minAffinity │  过滤低亲和度Agent
│ score×1/(1+load)     │  负载感知排序
│ 取Top-K              │
└──────────┬───────────┘
           │
           ▼
    路由结果 + 发射routed事件
```

### 亲和力学习流程

```
任务完成反馈
  │
  ▼
updateAffinity(agentId, taskType, delta)
  │
  ├─ delta > 0 → 亲和力增强（成功反馈）
  ├─ delta < 0 → 亲和力减弱（失败反馈）
  └─ delta = 0 → 无变化
  │
  ▼
clamp01(current + delta)  ← 约束在[0,1]
  │
  ▼
存储到 _agentAffinities Map
  │
  ▼
下次route()时通过_computeAffinities
以 (learnedAffinity - 0.5) × 0.2 叠加
```

## 事件

| 事件 | 触发时机 | Payload |
|------|---------|---------|
| `routed` | 每次路由完成 | `{ agents, affinities, taskTypes, routingId, timestamp }` |

## 配置

### 构造选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `topK` | 2 | 路由返回的Agent数量 |
| `minAffinity` | 0.3 | 最低亲和度阈值，低于此值的Agent不参与路由 |
| `maxHistory` | 500 | 路由历史记录上限（RingBuffer容量） |

### 亲和度计算参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 基础匹配加分 | 0.3/类型 | Agent strength匹配任务类型时每项加0.3 |
| 基础分上限 | 1.0 | 基础评分不超过1.0 |
| 学习加成权重 | 0.2 | `(learnedAffinity - 0.5) × 0.2` |
| 默认亲和力 | 0.5 | 未学习时的初始亲和力 |
| 未知Agent基础分 | 0.1 | 不在AGENT_CAPABILITIES中的Agent |

### 负载调整公式

```
adjustedScore = baseScore × (1 / (1 + activeTaskCount))
```

负载为0时调整系数为1.0（无衰减），负载为1时为0.5，负载为2时为0.33，以此类推。

## 使用示例

### 基础路由

```javascript
const MultiAgentRouter = require('./src/runtime/agent/multi-agent-router');

const router = new MultiAgentRouter();

const result = router.route({
  description: '实现用户登录功能',
  goal: '完成编码和单元测试'
});

console.log(result.taskTypes);
// ['implementation', 'testing']

console.log(result.agents);
// [{ agentId: 'task-worker', score: 0.6, capabilities: {...} }, ...]
```

### 自定义配置路由

```javascript
const router = new MultiAgentRouter({
  topK: 3,
  minAffinity: 0.4,
  maxHistory: 1000
});

const result = router.route(
  { description: '审查代码安全漏洞' },
  ['domain-analyst', 'quality-assurance', 'task-worker']
);
```

### 亲和力学习

```javascript
const router = new MultiAgentRouter();

router.route({ description: '部署到生产环境' });

router.updateAffinity('devops-engineer', 'deployment', 0.2);
router.updateAffinity('task-worker', 'deployment', -0.1);

console.log(router.getAffinity('devops-engineer', 'deployment'));
// 0.7 (0.5 + 0.2)

const nextResult = router.route({ description: '部署上线' });
// devops-engineer的亲和度更高，排序更靠前
```

### 负载感知路由

```javascript
const router = new MultiAgentRouter();

router.recordAgentLoad('task-worker', 5);
router.recordAgentLoad('domain-analyst', 0);

const result = router.route({ description: '分析系统架构' });
// domain-analyst负载低，即使基础分相同也会优先选择
```

### 路由历史查询

```javascript
const router = new MultiAgentRouter();

router.route({ description: '实现功能' });
router.route({ description: '测试验证' });

const allHistory = router.getRoutingHistory();
const recentHistory = router.getRoutingHistory(1);

const stats = router.getStats();
console.log(stats);
// { totalRoutings: 2, topK: 2, minAffinity: 0.3, knownAgents: 6, learnedAffinities: 0 }
```

## 依赖关系

### 上游依赖（本模块使用）

| 模块 | 文件 | 用途 |
|------|------|------|
| RingBuffer | src/utils/ring-buffer.js | 环形缓冲区，存储路由历史记录 |
| constants | src/utils/constants.js | generateId生成路由ID |
| safe-execute | src/utils/safe-execute.js | clamp01约束亲和度值在[0,1]区间 |
| shutdown-mixin | src/utils/shutdown-mixin.js | 优雅关闭混入 |

### 下游依赖（使用本模块）

| 模块 | 用途 |
|------|------|
| AgentWorkflowIntegration | 工作流集成中调度任务到Agent |
| CollaborationModeRouter | 协作模式路由中选择参与Agent |
| SubagentExecutor | 子Agent执行器中选择目标Agent |
| Dashboard API | `/api/agents/routing` 端点提供路由查询 |

## 交叉引用

- [[模块详解-AgentRuntime模块]] — Agent运行时核心，提供Agent实例管理
- [[模块详解-AgentLifecycleController生命周期控制器]] — Agent生命周期控制
- [[模块详解-SubagentExecutor模块]] — 子Agent执行器，消费路由结果
- [[模块详解-CollaborationModeRouter模块]] — 协作模式路由
- [[模块详解-PhaseOrchestrator阶段编排器]] — 六阶段流程编排
- [[核心功能-多Agent协作流程]] — 多Agent路由调度流程文档
