# 模块详解-AgentMonitor模块

> 版本：2.73.4 | 文件：src/runtime/agent/agent-monitor.js

---

## 模块定位

AgentMonitor是Agent监控器，负责实时监控Agent的资源使用、性能指标和行为模式。提供阈值告警、反模式检测和自定义指标收集能力。

## 核心能力

| 能力 | 说明 |
|------|------|
| **指标收集** | 支持7种指标类型：CPU/内存/响应时间/任务数/错误率/吞吐量/自定义 |
| **阈值告警** | 可配置warning/critical两级阈值，自动触发告警 |
| **反模式检测** | 内置5种反模式规则：过度实现/重复搜索/跳过验证/范围蔓延/过度重试 |
| **行为日志** | 记录Agent行为日志，支持info/warn/error/debug级别 |
| **策略映射** | 使用_metricHandlers Map替代switch-case，提升可维护性 |
| **有界存储** | BoundedArray限制历史记录和告警数量 |

## 类定义

```javascript
class AgentMonitor extends EventEmitter {
  constructor(projectRoot, options = {})
  registerAgent(agentId, options)
  unregisterAgent(agentId)
  recordMetric(agentId, type, value, metadata)
  recordMetrics(agentId, metrics)
  logEvent(agentId, level, message, data)
  startCollection(agentId)
  recordBehavior(agentId, behaviorData)
  detectAntipatterns(agentId, behaviorContext)
  getAntipatternRules()
  getAlerts(options)
  getStats()
  shutdown()
}
```

## 指标类型

| 类型 | 常量 | 说明 | 阈值检查 |
|------|------|------|---------|
| CPU | METRIC_TYPES.CPU | CPU使用百分比 | ✅ |
| MEMORY | METRIC_TYPES.MEMORY | 内存使用MB | ✅ |
| RESPONSE_TIME | METRIC_TYPES.RESPONSE_TIME | 响应时间ms | ✅ |
| TASK_COUNT | METRIC_TYPES.TASK_COUNT | 任务数量 | ❌ |
| ERROR_RATE | METRIC_TYPES.ERROR_RATE | 错误率 | ✅ |
| THROUGHPUT | METRIC_TYPES.THROUGHPUT | 吞吐量 | ❌ |
| CUSTOM | METRIC_TYPES.CUSTOM | 自定义指标 | ❌ |

## 默认阈值

| 指标 | Warning | Critical |
|------|---------|----------|
| cpuPercent | 70% | 90% |
| memoryMB | 400MB | 480MB |
| responseTimeMs | 5000ms | 10000ms |
| errorRate | 0.05 | 0.1 |

## 反模式规则

| ID | 名称 | 检测条件 | 严重级别 |
|----|------|---------|---------|
| over-implementation | 过度实现 | 新增文件>3或新增行>300或新增抽象>3 | warning |
| repeated-search | 重复搜索 | 搜索次数≥3且唯一目标<50% | info |
| skip-verification | 跳过验证 | 无验证步骤 | critical |
| scope-creep | 范围蔓延 | 修改文件>5且任务相关<50% | warning |
| excessive-retries | 过度重试 | 重试次数>3 | warning |

## 事件

AgentMonitor继承EventEmitter，以下为该类发出的事件：

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `agent-registered` | Agent注册时 | `{ agentId, options }` |
| `agent-unregistered` | Agent注销时 | `{ agentId }` |
| `metric-recorded` | 指标记录时 | `{ agentId, type, value, metadata }` |
| `log-event` | 行为日志记录时 | `{ agentId, level, message, data }` |
| `alert` | 阈值告警触发时 | `{ agentId, type, level, value, threshold }` |
| `critical-alert` | 严重告警触发时 | `{ agentId, type, value, threshold }` |
| `collection-started` | 指标收集启动时 | `{ agentId }` |
| `collection-stopped` | 指标收集停止时 | `{ agentId }` |
| `behavior-recorded` | 行为记录时 | `{ agentId, ...updatedFields }` |
| `antipattern-detected` | 反模式检测到时 | `{ agentId, rule, severity, details }` |

## 依赖关系

- 继承自 `EventEmitter`
- 使用 `BoundedArray`（src/utils/bounded-array.js）
- 使用 `AgentError`（src/errors/index.js）

## v2.7.122 变更说明

| 方法/行为 | 变更内容 |
|-----------|---------|
| `recordMetric()` | 当传入值为非有限数（NaN/Infinity/-Infinity）时，会将其强制归零并记录debug级别日志 |
| `_collectAgentMetrics()` | 当Agent状态为null时，记录debug级别日志而非静默跳过 |
| `startCollection()` | 启动收集前检查Agent是否已注册，未注册时不启动 |
| `unregisterAgent()` | 增加关闭守卫（shutdown guard），在monitor已关闭时不再执行注销逻辑 |
| `recordBehavior()` | 仅在实际更新了字段时才发出`behavior-recorded`事件，事件数据中仅包含实际更新的字段 |
