# 模块详解-CausalDataBus因果数据总线

> 版本：2.73.4 | 文件：src/runtime/causal/causal-data-bus.js

---

## 模块定位

CausalDataBus是因果数据总线，负责管理Agent间数据流动的因果关系追踪。基于WAL（Write-Ahead Log）机制保证数据一致性，支持因果链追踪、接口定义、回滚操作和引用计数管理。

## 核心能力

| 能力 | 说明 |
|------|------|
| **因果链追踪** | 记录Skill间的数据依赖关系，形成因果链 |
| **WAL机制** | 通过预写日志保证数据一致性，支持崩溃恢复 |
| **接口定义** | defineSkillInterface()定义Skill的输入/输出接口约束 |
| **回滚操作** | rollbackToSequence()支持按WAL序列号回滚到指定状态 |
| **引用计数** | 自动管理因果链条目的引用计数，清理无用数据 |
| **有界存储** | _maxHistory和_maxPendingOutputs防止内存溢出 |

## 类定义

```javascript
class CausalDataBus extends EventEmitter {
  constructor(options = {})
  publishOutput(skillId, outputData)
  defineSkillInterface(skillId, definition)
  rollbackToSequence(targetSequence)
  rollbackToTimestamp(targetTimestamp)
  getPendingOutputs()
  getCausalChain(fromIndex)
  getCausalChainForSkill(skillId)
  getSkillInterface(skillId)
  getDefinedInterfaces()
  getOutputVersions(skillId)
  getCausalARContext(skillId, depth)
  checkScenarioCoverage(skillId, testedScenarios)
  validateInputs(skillId, context)
  isHealthy()
  flush()
  attachProjectRoot(projectRoot)
  attachSqliteStore(sqliteStore)
  getStats()
  shutdown()
}
```

## 关键方法

### publishOutput(skillId, outputData)
发布Skill输出数据，记录到因果链和待输出映射表。自动生成causalId（格式：`skillId-walSeq`），验证接口约束和不变量，维护输出版本历史和输出键索引。

### defineSkillInterface(skillId, definition)
定义Skill的接口约束。definition包含causalInputs、causalOutputs、invariants、scenarios、version字段。接口数量受maxInterfaces限制。

### rollbackToSequence(targetSequence)
按WAL序列号回滚，清理后续的因果链条目和待输出数据，返回回滚详情（移除条目数、受影响skillId列表）。

### rollbackToTimestamp(targetTimestamp)
按时间戳回滚，找到目标时间戳对应的最大walSeq，委托给rollbackToSequence执行。

### getPendingOutputs()
获取所有待处理输出，返回Map的浅拷贝（不暴露内部状态）。

### getSkillInterface(skillId)
获取指定Skill的接口定义，未找到时返回null。

### getDefinedInterfaces()
获取所有已定义接口的列表，每项包含skillId、causalInputs、causalOutputs、invariants、scenarios、version。

### getOutputVersions(skillId)
获取指定Skill的输出版本历史（最多保留5个版本），返回数组的浅拷贝。

### getCausalChainForSkill(skillId)
按Skill过滤因果链，返回该Skill相关的所有因果链条目。

### getCausalARContext(skillId, depth)
获取自回归上下文。通过BFS遍历接口定义的因果输入依赖链，收集上游Skill的arContext，depth默认为3。

### checkScenarioCoverage(skillId, testedScenarios)
场景覆盖检查。对比接口定义的场景与已测试场景，返回覆盖率百分比和未测试场景列表。

### validateInputs(skillId, context)
输入验证。检查context是否满足接口定义的causalInputs要求，返回缺失的必填输入列表。

### isHealthy()
健康检查。已关闭返回false；启用WAL但日志流和持久化器均不可用时返回false；否则返回true。

### flush()
刷新WAL，立即将当前状态持久化到磁盘。

### attachProjectRoot(projectRoot)
注入项目根路径。仅在未设置root时生效，触发WAL异步初始化，返回this以支持链式调用。

### attachSqliteStore(sqliteStore)
注入SQLite存储。要求sqliteStore对象包含persistCausalEntry方法，返回this以支持链式调用。

### _applyWALOp(entry)
WAL操作分发器，将publish/define_interface/rollback操作分发到独立方法：
- `_applyPublishOp(entry)` — 处理发布操作
- `_applyDefineInterfaceOp(entry)` — 处理接口定义
- `_applyRollbackOp(entry)` — 处理回滚操作

### _serializeState()
序列化当前总线状态用于持久化。序列化内容现在包含`refCounts`（引用计数映射表），确保进程重启后能正确恢复引用计数状态，避免因引用计数丢失导致的数据提前清理或泄漏。

### _initWALAsync()
WAL异步初始化方法。在每次`await`操作后插入关闭守卫检查（`_shuttingDown`/`_isShutdown`检测），若检测到关闭信号则立即终止初始化流程，防止在关闭过程中继续执行耗时的磁盘I/O操作。

### _writeWALEntry(operation, data, seq)
写入WAL条目。第三个参数`seq`为可选的序列号：
- 当`seq`未传入时，自动递增`_walSequence`并使用新值作为序列号
- 当`seq`已传入时，直接使用传入的序列号，不再自动递增`_walSequence`

此设计修复了`publishOutput`中的双重递增问题——`publishOutput`在内部先执行`++this._walSequence`获取序列号，然后将该序列号作为`seq`传入，避免`_writeWALEntry`再次递增。

### _sanitizeOutputData(data, depth, visited)
输出数据消毒器。递归清理输出数据中的危险键、截断超长字符串、限制数组长度和对象键数。第三个参数`visited`（Set类型）用于检测循环引用：
- 未传入时自动创建新的`Set`
- 遍历对象前先检查`visited.has(data)`，若已访问则返回`{_circular: true}`占位符
- 每次进入对象时将当前对象加入`visited`，递归传递同一`Set`实例确保跨层级循环引用检测

### shutdownAsync(timeoutMs)
异步关闭，确保WAL数据完整性。关闭流程：
1. 若`_walPendingQueue`中存在待写入条目，先逐条写入`_walLogStream`，刷写完毕后清空队列
2. 置空`_walLogStream`（先刷写后置空，防止数据丢失）
3. 等待流结束（finish/close事件）或超时后调用`shutdown()`完成清理

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| maxHistory | 1000 | 因果链最大长度 |
| maxPendingOutputs | 500 | 待输出映射表最大容量 |

## 事件

| 事件 | 触发条件 |
|------|---------|
| `published` | 数据发布成功 |
| `interface-defined` | 接口定义成功 |
| `rolled-back` | 回滚操作完成 |

## 依赖关系

- 继承自 `DeepeningBase`（src/runtime/deepening/deepening-base.js）
- 使用 `debug` 日志工具（src/utils/debug-logger.js）
