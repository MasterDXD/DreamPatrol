# 模块详解-SessionManager会话管理器

> 版本：2.73.4 | 文件：src/runtime/session/session-manager.js

---

## 模块概述

SessionManager是Harness多Agent框架的会话状态管理器，负责跟踪会话的当前阶段、已完成Skill、Token用量和Agent操作历史。它继承EventEmitter，支持阶段转换验证（仅允许合法的PHASE_TRANSITIONS_SET转换）、Token预算检查（80%/95%/100%三级阈值）、防抖持久化（KeyedDebouncer驱动）、会话TTL过期自动清理，以及进程重启后的会话恢复。

该模块是会话子系统的核心组件，与PhaseOrchestrator、TokenManager、CausalDataBus、PhaseContextInjector等模块紧密协作，确保多Agent协作流程在六阶段框架下有序推进。

## 类定义

```javascript
class SessionManager extends EventEmitter {
  constructor(projectRoot)
  get ready
  create(sessionId)
  get(sessionId)
  advancePhase(sessionId, newPhase)
  completeSkill(sessionId, skillId)
  addTokenUsage(sessionId, tokens)
  checkBudget(sessionId)
  recordAgentAction(sessionId, agentId, action)
  recordDeepeningIteration(sessionId, data)
  recordDeepeningConvergence(sessionId, data)
  getDeepeningState(sessionId)
  updateEntropyState(sessionId, priorRichness)
  getPreviousSessionContext()
  getStats()
  flush()
  registerShutdownHooks()
  attachPhaseContextInjector(injector)
  attachCausalDataBus(causalDataBus)
  shutdown() // via withShutdown mixin
}
```

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `SessionManager.VALID_PHASES` | Array | 合法阶段列表 |
| `SessionManager.SESSION_ID_PATTERN` | RegExp | 会话ID格式校验正则 |
| `SessionManager.MAX_SESSIONS` | number | 最大会话数（100） |
| `SessionManager.SESSION_TTL_MS` | number | 会话TTL（默认24小时） |
| `SessionManager.DEBOUNCE_MS` | number | 防抖持久化延迟（毫秒） |
| `SessionManager.generateSessionId()` | Function | 生成唯一会话ID |

### Session数据结构

```javascript
{
  id: string,                    // 会话ID，匹配 /^[a-zA-Z0-9_-]{1,64}$/
  currentPhase: string,          // 当前阶段（PHASES之一）
  completedSkills: string[],     // 已完成的Skill列表（最大500，裁剪至400）
  tokensUsed: number,            // 已使用Token数量
  status: 'active'|'completed'|'expired',
  createdAt: string,             // ISO格式创建时间
  lastActivityAt: string,        // ISO格式最后活动时间
  agentHistory: AgentAction[],   // Agent操作历史（最大500，裁剪至400）
  deepeningState: Object,        // 深化推理状态
  entropyState: Object,          // 熵状态（收敛检测）
  metadata: Object,              // 自定义元数据
}
```

## 构造函数

### `new SessionManager(projectRoot)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径 |

构造时自动：加载.harness/config.json配置、启动TTL清理定时器（5分钟间隔）、注册配置文件变更监听器、从磁盘恢复已有会话。

## 核心方法

### `create(sessionId)`

创建新会话，sessionId需匹配`[a-zA-Z0-9_-]`，最长64字符。达到MAX_SESSIONS时自动淘汰最旧会话。若新会话的sessionId与从磁盘恢复的会话冲突，则替换恢复的会话并记录日志。

**返回值**：`Session` — 新创建的会话对象

**异常**：`SessionError('INVALID_SESSION_ID')` / `SessionError('SESSION_EXISTS')` / `SessionError('EVICT_IN_PROGRESS')`

**事件触发**：`session-created`

### `get(sessionId)`

获取指定会话的深拷贝，不存在返回null。对嵌套对象（deepeningState、entropyState等）使用deepClone进行深拷贝，确保返回的会话对象与内部存储完全隔离，防止外部修改影响内部状态。

**返回值**：`Session | null`

### `advancePhase(sessionId, newPhase)`

推进会话到新阶段，仅允许PHASE_TRANSITIONS_SET中定义的合法转换。

**返回值**：`Session`

**异常**：`SessionError('SESSION_NOT_FOUND')` / `SessionError('INVALID_PHASE_TRANSITION')`

**事件触发**：`phase-change`（含from/to字段）；若已附加PhaseContextInjector则自动注入新阶段上下文。

### `completeSkill(sessionId, skillId)`

记录已完成的Skill，超过MAX_COMPLETED_SKILLS(500)时自动裁剪至400。

**返回值**：`Session`

**异常**：`SessionError('SESSION_NOT_FOUND')` / `SessionError('INVALID_INPUT')`

**事件触发**：`skill-complete`；若已附加CausalDataBus则发布因果事件。

### `addTokenUsage(sessionId, tokens)`

增加Token使用量，tokens必须为非负有限数。自动触发预算检查。

**异常**：`SessionError('SESSION_NOT_FOUND')` / `SessionError('INVALID_TOKEN_USAGE')`

**事件触发**：`budget-warning`（当达到80%/95%/100%阈值时）

### `checkBudget(sessionId)`

检查Token预算使用情况。

**返回值**：`BudgetStatus` — {warning80, warning95, exhausted, ratio, sessionNotFound}

## 会话生命周期

```
创建 → 活跃(active) → 阶段推进 → Skill完成 → Token累加 → TTL过期/手动关闭
  ↓                                                        ↓
持久化(.harness/sessions/)                           磁盘文件删除
```

- **创建**：初始化currentPhase为PHASES[0]，completedSkills为空数组
- **持久化**：防抖写入磁盘，create/advancePhase/completeSkill使用immediate=true立即写入
- **恢复**：构造时从磁盘加载未过期的active会话
- **过期**：TTL清理器每5分钟扫描，超过session_ttl_ms的会话自动删除
- **淘汰**：会话数达MAX_SESSIONS时淘汰lastActivityAt最旧的会话

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `session-created` | 会话创建 | {sessionId, session} |
| `phase-change` | 阶段推进 | {sessionId, from, to} |
| `skill-complete` | Skill完成 | {sessionId, skillId} |
| `budget-warning` | Token预算预警 | {sessionId, tokensUsed, budget} |
| `session-expired` | 会话TTL过期 | {sessionId, age} |
| `session-evicted` | 会话容量淘汰 | {sessionId, reason} |
| `sessions-restored` | 会话恢复完成 | { count } |
| `budget-config-changed` | 阶段预算配置变更 | { config } |
| `entropy-updated` | 熵状态更新 | {sessionId, level} |
| `persist-error` | 持久化失败 | Error对象 |
| `config-reloaded` | 配置热更新 | {config} |

## 使用示例

```javascript
const SessionManager = require('./src/runtime/session/session-manager');

const mgr = new SessionManager('/path/to/project');
mgr.registerShutdownHooks();

mgr.on('phase-change', (evt) => {
  console.log(`阶段推进: ${evt.from} → ${evt.to}`);
});

mgr.on('budget-warning', (evt) => {
  console.warn(`预算预警: ${evt.budget.ratio * 100}%`);
});

const session = mgr.create('my-session');
mgr.completeSkill('my-session', 'brainstorming');
mgr.advancePhase('my-session', 'requirement-analysis');
mgr.addTokenUsage('my-session', 5000);

console.log(mgr.checkBudget('my-session'));
console.log(mgr.getStats());
```

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/constants`（PHASES、PHASE_TRANSITIONS_SET、SESSION_ID_PATTERN等常量）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 依赖：`../../utils/keyed-debouncer`（防抖持久化）
- 依赖：`../context/autoregressive-context-schema`（自回归上下文注入）
- 被依赖：PhaseOrchestrator（阶段编排，调用advancePhase）
- 被依赖：Web Dashboard（仪表盘，会话状态展示）

## 修复记录

### Round 5-6（2026-05-30）

| 修复内容 | 详情 |
|---------|------|
| TTL清理器KeyedDebouncer同步 | TTL过期清理会话时，原实现直接`delete this.sessions[id]`但未清理`_persistDebouncer`中对应的防抖键。过期会话的防抖回调仍可能在后续触发，尝试写入已删除的会话数据。修复：TTL清理时同步调用`this._persistDebouncer.delete(id)`取消待执行的持久化回调 |
| TTL清理器无效时间戳处理 | TTL清理循环中`new Date(session.lastActivityAt).getTime()`可能返回NaN（无效日期字符串），原实现未处理NaN情况导致`age > ttl`比较结果为false，过期会话无法被清理。修复：新增`Number.isFinite(activityTime)`检查，NaN时直接删除会话并发射`session-expired`事件（age=NaN） |
| `_persistDebouncer`替换原防抖实现 | 原持久化防抖使用内联`setTimeout`+`_persistTimers`对象管理，存在定时器泄漏风险（异常路径未清理）。替换为`KeyedDebouncer`统一管理，支持`flush()`/`delete()`/`destroy()`生命周期操作，关闭时`_onShutdown()`中调用`_persistDebouncer.destroy()`确保所有定时器被清理 |

### Round 8（2026-05-28）

| 修复内容 | 详情 |
|---------|------|
| create方法支持options参数 | `create(sessionId, options)`新增可选`options`参数，支持在创建会话时传入`agent`字段初始化Agent操作记录，避免创建后需额外调用`recordAgentAction` |

### Round 26（2026-05-30）

| 修复内容 | 详情 |
|---------|------|
| `_loadConfigWith`/`_loadConfig` NaN未捕获 | `Math.floor(Number(x)) ?? fallback` 模式无法捕获NaN（`NaN ?? 0`仍为`NaN`），当配置文件中`token_budget`/`max_sessions`/`session_ttl_ms`为非数字字符串时，值被设为NaN而非默认值。6处修复为`Number.isFinite(Number(x)) ? Math.max(...) : fallback`，确保非数字输入回退到安全默认值 |

### Round 29（2026-05-30）

| 修复内容 | 详情 |
|---------|------|
| `_configWatcher` error handler FSWatcher泄漏 | **缺陷**：`_configWatcher`的`'error'`事件处理器在捕获错误后仅将`this._configWatcher`置为`null`，但未先调用旧watcher的`.close()`方法。当文件监视器遇到错误（如被监视的配置文件被删除）时，底层FSWatcher对象仍然持有系统资源（文件描述符/句柄），置空引用后无法再访问和关闭它，导致FSWatcher泄漏。长期运行中反复触发错误会累积泄漏的watcher实例，最终可能耗尽系统文件描述符资源。**影响行**：`_configWatcher`的`'error'`事件回调。**修复**：在置空引用前先调用`this._configWatcher.close()`关闭旧watcher，释放系统资源。**影响**：消除FSWatcher泄漏风险，确保配置文件监视器在错误场景下正确释放资源 |

## 相关文档

- [[模块详解-CheckpointManager检查点管理器]]
- [[模块详解-TokenManager模块]]
- [[模块详解-PhaseOrchestrator阶段编排器]]
- [核心功能-成本控制机制](../core/核心功能-成本控制机制.md)
