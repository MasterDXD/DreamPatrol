# 模块详解-PhaseOrchestrator阶段编排器

## 概述

PhaseOrchestrator 是 Harness 框架六阶段执行流程的核心编排模块，负责管理阶段状态机、验证阶段转换合法性、强制 TDD 门禁检查、追踪阶段历史，以及与因果子系统（CausalDataBus）集成进行因果就绪性检查。

**源码位置**：`src/runtime/workflow/phase-orchestrator.js`（253行）

## 架构角色

```
用户请求 → PipelineExecutor → PhaseOrchestrator → 六阶段流程
                                    ↓
                              CausalDataBus（因果就绪性）
                              AR Context（自回归上下文注入）
```

PhaseOrchestrator 在框架中充当"流程管控器"角色：
- 定义哪些阶段转换是合法的（`PHASE_TRANSITIONS_SET`）
- 确保阶段推进前所有必需技能已完成（TDD 门禁）
- 回滚时自动标记受影响技能为无效

## 六阶段流程

| 序号 | 阶段 | 必需技能 | 说明 |
|------|------|---------|------|
| 0 | brainstorming | — | 需求探索 |
| 1 | requirement-analysis | — | 需求分析与规划 |
| 2 | architecture-design | — | 架构设计 |
| 3 | module-development | tdd-implement, module-development, code-review, verification-before-completion | 模块开发（TDD强制） |
| 4 | integration-testing | integration-testing | 集成测试 |
| 5 | deployment | deployment | 部署上线 |

## 核心 API

### 阶段管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `getCurrentPhase()` | `() → string\|null` | 获取当前阶段 |
| `setCurrentPhase(phase, reason)` | `(string, string) → boolean` | 设置当前阶段，自动验证转换合法性 |
| `canTransition(from, to)` | `(string, string) → boolean` | 检查阶段转换是否合法 |
| `isForwardTransition(from, to)` | `(string, string) → boolean` | 是否为前进转换 |
| `isBackwardTransition(from, to)` | `(string, string) → boolean` | 是否为回退转换 |
| `getNextPhase(currentPhase)` | `(string) → string\|null` | 获取下一阶段 |
| `getPhaseIndex(phase)` | `(string) → number` | 获取阶段序号（-1表示无效） |
| `getPhases()` | `() → string[]` | 获取所有阶段的定义列表，顺序与执行顺序一致 |

### 阶段完成性检查

| 方法 | 签名 | 说明 |
|------|------|------|
| `isPhaseComplete(phase, completedSkills, strictSkillIds?)` | `(string, string[], string[]?) → boolean` | 检查阶段是否完成（含因果检查） |
| `canAdvanceToNext(completedSkills)` | `(string[]) → boolean` | 是否可以推进到下一阶段 |
| `getCausalReadiness(phase, completedSkills)` | `(string, string[]) → object` | 获取因果就绪性报告 |
| `getRequiredSkills(phase)` | `(string) → string[]` | 获取阶段所需技能列表 |

### 回滚验证

| 方法 | 签名 | 说明 |
|------|------|------|
| `validateRollback(fromPhase, toPhase, completedSkills)` | `(string, string, string[]) → object` | 验证回滚合法性，返回受影响的技能列表 |

返回值结构：
```javascript
{
  allowed: boolean,
  requiresApproval?: boolean,
  phasesToRollback: string[],
  skillsToInvalidate: string[]
}
```

### 因果集成

| 方法 | 签名 | 说明 |
|------|------|------|
| `attachCausalDataBus(bus)` | `(CausalDataBus) → this` | 附加因果数据总线 |

附加后，`isPhaseComplete` 和 `getCausalReadiness` 将自动检查因果接口和待处理输出。

### 自回归上下文

阶段推进时自动注入 AR 上下文：
- `PREVIOUS_RESULT`：前阶段名称
- `ORIGINAL_GOAL`：目标阶段名称
- `SOURCE`：`PHASE_ADVANCE`

通过 `getARContext()` 获取当前 AR 上下文。

## 严格技能（STRICT_SKILLS）

以下技能在阶段完成性检查中被视为"严格"——必须完成才能推进：

```
tdd-implement, module-development, code-review, verification-before-completion,
bug-fix, security-audit, integration-testing, deployment, iterative-deepening
```

## 阶段历史

- 每次阶段转换自动记录 `{ from, to, reason, timestamp }`
- 历史上限 `MAX_PHASE_HISTORY = 100`，超出后裁剪至 `PHASE_HISTORY_KEEP = 50`
- 通过 `getPhaseHistory()` 获取副本

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `phase-changed` | 阶段变更 | `{ from, to, reason }` |
| `shutdown` | 关闭 | `{ lastPhase }` |

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| PipelineExecutor | 调用 PhaseOrchestrator 管理阶段状态 |
| CausalDataBus | 提供因果就绪性数据 |
| SessionManager | 持久化当前阶段状态 |
| SkillRouter | 根据当前阶段匹配技能 |
| TDDGate | 阶段推进时的 TDD 门禁检查 |
| AR Context | 阶段推进时注入自回归上下文 |

## 设计决策

1. **有限状态机**：阶段转换由 `PHASE_TRANSITIONS_SET` 严格定义，不允许任意跳转
2. **TDD 门禁**：严格技能必须完成才能推进，确保代码质量
3. **因果一致性**：阶段完成性检查包含因果接口和输出验证，确保跨模块数据一致性
4. **回滚安全**：回滚时自动标记受影响技能为无效，防止脏状态传播
