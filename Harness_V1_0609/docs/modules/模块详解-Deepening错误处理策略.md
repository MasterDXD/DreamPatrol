# 模块详解-Deepening错误处理策略

## 概述

Deepening 子系统包含 50+ 模块，错误处理策略遵循"可观测性优先"原则：所有异常必须被记录或发出事件，禁止静默吞没。

## 错误处理分层

### 第一层：结构化日志（debug 级别）

所有 catch 块至少包含 `debug()` 调用，确保异常信息可追踪：

```javascript
const { debug } = require('../../utils/debug-logger');
// ...
catch (err) {
  debug('ModuleName', 'methodName', err);
}
```

### 第二层：事件发射（emit）

关键模块在 catch 块中同时发出结构化事件，供上层监控系统消费：

```javascript
catch (agentErr) {
  debug('DeepeningOrchestrator', 'agentExecute', agentErr);
  this.emit('agent-error', { agentId: agent.id, error: agentErr.message });
}
```

### 第三层：安全降级

当异常发生时，返回保守的默认值而非激进的默认值：

| 模块 | 异常场景 | 降级策略 |
|------|---------|---------|
| TokenAwareDeepening | Token 查询失败 | `canAfford: false`（阻止预算绕过） |
| TokenAwareDeepening | Token 管理器异常 | `maxIterations: 1`（保守迭代） |
| DeepeningOrchestrator | Agent 执行失败 | 发出 `agent-error` 事件，不递增调用计数 |
| IterativeRefinement | Reviewer 异常 | 发出 `review-error` 事件，跳出循环 |
| DeepeningErrorHandler | Fallback 处理器异常 | 记录日志，返回默认处理结果 |

## 事件清单

| 事件名 | 发射模块 | 触发条件 | 事件数据 |
|--------|---------|---------|---------|
| `agent-error` | DeepeningOrchestrator | Agent 执行抛异常 | `{ agentId, error }` |
| `review-error` | IterativeRefinement | Reviewer 抛异常 | `{ round, error }` |
| `review-error` | ProgressiveDeepening | Reviewer 抛异常 | `{ level, error }` |
| `adversarial-error` | ProgressiveDeepening | 对抗审查器抛异常 | `{ level, error }` |
| `evaluator-error` | RecurrentDeepeningScheduler | 评估器抛异常 | `{ iteration, error }` |
| `stage-error` | DeepeningDataPipeline | 管道阶段抛异常 | `{ stage, error }` |
| `plugin-error` | DeepeningPluginSystem | 插件钩子抛异常 | `{ hook, plugin, error }` |
| `handler-error` | DeepeningEventBus | 订阅处理器抛异常 | `{ topic, subscriptionId, error }` |
| `interceptor-error` | DeepeningEventBus | 拦截器抛异常 | `{ topic, error }` |
| `module-load-error` | DeepeningModuleRegistry | 模块加载失败 | `{ moduleName, error }` |
| `shutdown-error` | DeepeningModuleRegistry | 模块关闭失败 | `{ error }` |

## 安全关键修复

### TokenAwareDeepening.canAffordIteration

**修复前**（高危）：
```javascript
catch (_) { return { canAfford: true }; }
```
当 Token 预算查询异常时，系统默认允许继续执行，**可能绕过 Token 预算限制**，导致成本失控。

**修复后**（安全）：
```javascript
catch (affordErr) {
  debug('TokenAwareDeepening', 'canAffordIteration', affordErr);
  return { canAfford: false, reason: 'token-query-error' };
}
```
异常时默认拒绝，确保预算安全。

### TokenAwareDeepening.calculateMaxIterations

**修复前**：
```javascript
catch (_) { return { maxIterations: 4, reason: 'no-token-manager' }; }
```
异常时返回 4 次迭代（过于宽松）。

**修复后**：
```javascript
catch (calcErr) {
  debug('TokenAwareDeepening', 'calculateMaxIterations', calcErr);
  return { maxIterations: 1, reason: 'token-manager-error' };
}
```
异常时保守返回 1 次迭代。

## 最佳实践

1. **禁止空 catch 块**：所有 catch 块必须包含至少 `debug()` 调用
2. **保守降级**：异常时选择最安全的默认值（如 `canAfford: false`）
3. **事件驱动**：关键异常同时发出事件，支持上层监控
4. **错误传播**：对于不可恢复的错误，应向上传播而非静默处理
5. **日志命名**：`debug('模块名', '方法名:上下文', error)` 格式统一
