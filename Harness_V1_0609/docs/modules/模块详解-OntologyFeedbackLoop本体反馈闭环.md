# 模块详解 — OntologyFeedbackLoop 本体反馈闭环

> 所属子系统：[[基础设施子系统]] | 融合自：Palantir Ontology "AI Actions" | 版本：2.73.4

## 模块概述

`ontology-feedback-loop.js` 是本体模型执行反馈闭环模块，融合 Palantir Ontology "AI Actions" 核心机制，实现 **"行动→效果→模型优化"** 的自循环。当业务规则被触发执行后，执行结果（成功/失败/部分成功）实时反馈至本体模型，系统据此自动评估规则效果并动态调整规则阈值，形成持续优化的闭环控制。

**源码位置**：`src/runtime/infrastructure/ontology-feedback-loop.js`

## 核心能力

| 能力 | 说明 |
|------|------|
| **执行结果反馈** | 接收规则执行结果（成功/失败/部分成功），评估与本体规则的偏差 |
| **自动调整规则** | 基于执行效果的滑动窗口统计，自动调整规则阈值或禁用规则 |
| **规则效果追踪** | 记录每条规则的触发次数、通过率、失败模式 |
| **反馈事件驱动** | 执行结果自动触发规则重评估，事件驱动架构 |
| **双向联动** | 与 BusinessOntologyModel 双向联动，反馈结果直接驱动模型更新 |

## 核心常量

### FEEDBACK_STATUS — 反馈状态

| 常量 | 值 | 说明 |
|------|---|------|
| `FEEDBACK_STATUS.SUCCESS` | `'success'` | 执行成功 |
| `FEEDBACK_STATUS.FAILURE` | `'failure'` | 执行失败 |
| `FEEDBACK_STATUS.PARTIAL` | `'partial'` | 部分成功 |

### ADJUSTMENT_TYPES — 调整类型

| 常量 | 值 | 说明 |
|------|---|------|
| `ADJUSTMENT_TYPES.THRESHOLD_TIGHTEN` | `'threshold-tighten'` | 收紧阈值 |
| `ADJUSTMENT_TYPES.THRESHOLD_LOOSEN` | `'threshold-loosen'` | 放宽阈值 |
| `ADJUSTMENT_TYPES.RULE_DISABLE` | `'rule-disable'` | 禁用规则 |
| `ADJUSTMENT_TYPES.RULE_ENABLE` | `'rule-enable'` | 启用规则 |
| `ADJUSTMENT_TYPES.CONDITION_UPDATE` | `'condition-update'` | 更新条件表达式 |

### DEFAULT_CONFIG — 默认配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `historySize` | `500` | 反馈历史容量（BoundedArray 上限） |
| `ruleEffectSize` | `200` | 规则效果追踪容量（BoundedMap 上限） |
| `slidingWindowSize` | `20` | 滑动窗口大小（最近 N 次执行） |
| `autoAdjustFailureRate` | `0.7` | 自动调整阈值：失败率 ≥ 此值时触发放宽/禁用 |
| `autoAdjustSuccessRate` | `0.95` | 自动调整阈值：成功率 ≥ 此值时触发收紧 |
| `thresholdAdjustStep` | `0.1` | 阈值调整步长（当前值的 10%） |
| `autoAdjustEnabled` | `true` | 是否启用自动调整 |

## 类定义

```javascript
class OntologyFeedbackLoop extends EventEmitter {
  constructor(config, ontologyModel)
  attachOntologyModel(model)
  submitFeedback(feedback)
  submitFeedbackBatch(feedbacks)
  getRuleEffect(ruleId)
  getRuleEffectOverview()
  adjustRule(ruleId, adjustmentType, params)
  getHistory(filter)
  getStats()

  // 内部方法
  _updateRuleEffect(ruleId, status)
  _checkAutoAdjust(ruleId)
  _adjustThreshold(rule, direction, params)
  _updateCondition(ruleId, newCondition)

  // 生命周期
  _onShutdown()
}
```

**注意**：导出时通过 `withShutdown()` 混入关机能力，所有公共方法内部均调用 `this.guardShutdown()` 防止关闭后操作。

## API 参考

### 构造函数

#### `new OntologyFeedbackLoop(config, ontologyModel)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config` | object | 否 | 配置选项，与 DEFAULT_CONFIG 合并 |
| `ontologyModel` | object | 否 | BusinessOntologyModel 实例，也可后续通过 `attachOntologyModel()` 注入 |

构造时初始化：
- `_history` — BoundedArray，存储反馈历史，容量为 `historySize`
- `_ruleEffects` — BoundedMap，存储规则效果追踪数据，容量为 `ruleEffectSize`
- `_stats` — 统计计数器（feedbackReceived、adjustmentsMade、adjustmentsByType、rulesTracked）

### 公共方法

#### `attachOntologyModel(model)`

注入 BusinessOntologyModel 实例。要求 model 必须包含 `evaluateRules` 方法，否则抛出错误。注入成功后触发 `ontology-model-attached` 事件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | object | 是 | BusinessOntologyModel 实例 |

**异常**：若 model 为空或不含 `evaluateRules` 方法，抛出 `Error`。

---

#### `submitFeedback(feedback)`

提交单条执行反馈。核心入口方法，处理流程：

1. 校验 `feedback.ruleId`（必填）和 `feedback.status`（必须为 success/failure/partial）
2. 构建反馈条目（含 ruleId、status、entityData、reason、context、timestamp），写入 `_history`
3. 调用 `_updateRuleEffect()` 更新规则效果追踪
4. 调用 `_checkAutoAdjust()` 检查是否需要自动调整
5. 触发 `feedback-received` 事件

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `feedback.ruleId` | string | 是 | 触发的规则 ID |
| `feedback.status` | string | 是 | `'success'` / `'failure'` / `'partial'` |
| `feedback.entityData` | object | 否 | 实体数据 |
| `feedback.reason` | string | 否 | 失败原因 |
| `feedback.context` | object | 否 | 执行上下文 |

**返回**：`{ recorded: true, adjustment: adjustment | null }`

**异常**：ruleId 缺失或 status 不合法时抛出 `Error`。

---

#### `submitFeedbackBatch(feedbacks)`

批量提交执行反馈。遍历数组逐条调用 `submitFeedback()`，收集所有触发的调整结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `feedbacks` | Array\<Object\> | 是 | 反馈对象数组 |

**返回**：`{ total: number, adjustments: Array }`

**异常**：feedbacks 非数组时抛出 `Error`。

---

#### `getRuleEffect(ruleId)`

获取指定规则的效果追踪数据。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ruleId` | string | 是 | 规则 ID |

**返回**：规则效果对象或 `null`（未追踪时）。效果对象结构：

```javascript
{
  ruleId: 'order-amount-threshold',
  triggers: 42,          // 总触发次数
  successes: 30,         // 成功次数
  failures: 10,          // 失败次数
  recentResults: [...],  // 滑动窗口内的最近结果
  lastAdjusted: 1717891200000,  // 最后调整时间戳（null 表示未调整过）
}
```

---

#### `getRuleEffectOverview()`

获取所有已追踪规则的效果概览。对每条规则计算滑动窗口内的近期成功率和失败率。

**返回**：数组，每项结构：

```javascript
{
  ruleId: 'order-amount-threshold',
  totalTriggers: 42,
  totalSuccesses: 30,
  totalFailures: 10,
  recentSuccessRate: 0.85,   // 滑动窗口内成功率
  recentFailureRate: 0.10,   // 滑动窗口内失败率
  lastAdjusted: 1717891200000,
}
```

---

#### `adjustRule(ruleId, adjustmentType, params)`

手动触发规则调整。需要已注入 BusinessOntologyModel 实例。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ruleId` | string | 是 | 规则 ID |
| `adjustmentType` | string | 是 | ADJUSTMENT_TYPES 中的值 |
| `params` | object | 否 | 调整参数（如 `{ step: 5 }` 或 `{ newCondition: '...' }`） |

**调整类型处理逻辑**：

| adjustmentType | 处理方式 |
|----------------|---------|
| `THRESHOLD_TIGHTEN` | 调用 `_adjustThreshold(rule, 'tighten', params)` |
| `THRESHOLD_LOOSEN` | 调用 `_adjustThreshold(rule, 'loosen', params)` |
| `RULE_DISABLE` | 调用 `ontologyModel.toggleBusinessRule(ruleId, false)` |
| `RULE_ENABLE` | 调用 `ontologyModel.toggleBusinessRule(ruleId, true)` |
| `CONDITION_UPDATE` | 调用 `_updateCondition(ruleId, params.newCondition)`，需提供 `params.newCondition` |

**返回**：`{ success: boolean, adjustmentType, details }`。失败时 details 含 `reason` 字段。

调整成功时：
- 更新 `_stats.adjustmentsMade` 和 `adjustmentsByType` 计数
- 更新规则效果的 `lastAdjusted` 时间戳
- 触发 `rule-adjusted` 事件

---

#### `getHistory(filter)`

获取反馈历史，按时间倒序返回。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filter.ruleId` | string | 否 | 按规则 ID 过滤 |
| `filter.status` | string | 否 | 按状态过滤 |
| `filter.limit` | number | 否 | 返回条数上限（默认 100） |

**返回**：反馈条目数组。

---

#### `getStats()`

获取统计信息。

**返回**：

```javascript
{
  feedbackReceived: 150,       // 总反馈数
  adjustmentsMade: 5,          // 总调整数
  adjustmentsByType: {         // 按类型统计调整次数
    'threshold-loosen': 3,
    'threshold-tighten': 2,
  },
  rulesTracked: 8,             // 已追踪规则数
  historySize: 150,            // 当前历史记录数
}
```

## 内部方法

### `_updateRuleEffect(ruleId, status)`

更新规则效果追踪数据。每次提交反馈时调用。

**处理逻辑**：
1. 若 ruleId 尚无追踪记录，创建初始效果对象（triggers=0, successes=0, failures=0, recentResults=[], lastAdjusted=null），`rulesTracked++`
2. `triggers++`；根据 status 递增 `successes` 或 `failures`
3. 将 status 推入 `recentResults` 滑动窗口，超出 `slidingWindowSize` 时移除最早记录

---

### `_checkAutoAdjust(ruleId)`

检查是否需要自动调整规则。每次提交反馈时调用。

**前置条件**（任一不满足则返回 null）：
- `autoAdjustEnabled` 配置为 true
- 已注入 `_ontologyModel`
- 规则效果追踪存在且 `recentResults.length >= 5`（至少 5 次触发才有统计意义）
- 距上次调整至少间隔 5 次触发（防抖机制）

**自动调整决策逻辑**：

| 条件 | 动作 | 说明 |
|------|------|------|
| 失败率 ≥ 0.7 且规则为 threshold 类型 | `THRESHOLD_LOOSEN` | 放宽阈值，降低规则触发门槛 |
| 失败率 ≥ 0.9 且规则非 validation 类型 | `RULE_DISABLE` | 过高失败率，直接禁用规则 |
| 成功率 ≥ 0.95 且规则为 threshold 类型 | `THRESHOLD_TIGHTEN` | 提高标准，收紧阈值 |

**返回**：`{ type, reason, failureRate/successRate }` 或 `null`（无需调整时）。

---

### `_adjustThreshold(rule, direction, params)`

调整阈值类规则的条件表达式。

**处理逻辑**：
1. 解析规则条件表达式，匹配数值比较模式：`field operator value`（如 `amount > 100`）
2. 计算调整步长：`params.step` 或 `currentValue * thresholdAdjustStep`
3. 根据方向调整数值：
   - **tighten（收紧）**：`>`/`>=` 运算符增大阈值，`<`/`<=` 运算符减小阈值
   - **loosen（放宽）**：`>`/`>=` 运算符减小阈值，`<`/`<=` 运算符增大阈值
4. 构建新条件字符串，调用 `_updateCondition()` 写入本体模型

**示例**：规则条件为 `amount > 100`，步长 10：
- tighten → `amount > 110`
- loosen → `amount > 90`

**返回**：`boolean`，是否调整成功。

---

### `_updateCondition(ruleId, newCondition)`

更新规则条件。通过 `ontologyModel.addBusinessRule()` 以相同 ruleId 重新添加规则，利用其版本号自增机制实现条件更新。保留原规则的 entityType、ruleType、action、priority、description、enabled 等属性。

**返回**：`boolean`，是否更新成功。

## 滑动窗口统计机制

OntologyFeedbackLoop 使用滑动窗口（Sliding Window）统计规则效果，核心设计：

- **窗口大小**：由 `slidingWindowSize`（默认 20）控制，仅关注最近 N 次执行结果
- **数据结构**：每条规则的 `recentResults` 数组，存储最近 N 次 status 值
- **窗口维护**：新结果推入尾部，超出窗口大小时移除头部（FIFO）
- **统计计算**：从 `recentResults` 计算近期成功率和失败率，作为自动调整的决策依据

滑动窗口的优势：
- **时效性**：仅关注近期表现，避免历史数据稀释当前趋势
- **自适应性**：规则效果变化后，窗口内数据自然更新，无需手动重置
- **低开销**：固定大小数组，内存占用可控

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `ontology-model-attached` | BusinessOntologyModel 注入成功 | 无 |
| `feedback-received` | 每次反馈提交后 | `{ ruleId, status, adjustment }` |
| `rule-adjusted` | 规则调整成功后 | `{ ruleId, adjustmentType, details }` |

## 与 BusinessOntologyModel 的集成

OntologyFeedbackLoop 与 BusinessOntologyModel 形成双向联动闭环：

```
BusinessOntologyModel                OntologyFeedbackLoop
       │                                      │
       │  evaluateRules() → 执行结果           │
       │ ──────────────────────────────────→   │
       │                                      │ submitFeedback()
       │                                      │ _updateRuleEffect()
       │                                      │ _checkAutoAdjust()
       │                                      │
       │  ←──────────────────────────────────  │
       │  adjustRule() → toggleBusinessRule()  │
       │  adjustRule() → addBusinessRule()     │
       │  （阈值调整/条件更新/规则启停）          │
```

**集成方式**：

1. **注入**：通过构造函数参数或 `attachOntologyModel()` 注入 BusinessOntologyModel 实例
2. **读取**：通过 `getBusinessRule(ruleId)` 获取规则定义，用于判断规则类型和解析条件
3. **写入**：通过以下方法修改本体模型：
   - `toggleBusinessRule(ruleId, enabled)` — 启用/禁用规则
   - `addBusinessRule(ruleId, ruleDef, options)` — 更新规则条件（版本号自增）

**注入校验**：`attachOntologyModel()` 要求 model 必须包含 `evaluateRules` 方法，确保接口兼容。

## 使用示例

### 基本用法

```javascript
const { OntologyFeedbackLoop, FEEDBACK_STATUS, ADJUSTMENT_TYPES } = require('./src/runtime/infrastructure/ontology-feedback-loop');
const BusinessOntologyModel = require('./src/runtime/infrastructure/business-ontology-model');

// 创建本体模型
const ontologyModel = new BusinessOntologyModel();
ontologyModel.defineEntityType('Order', {
  properties: { amount: { type: 'number' }, status: { type: 'string' } },
  required: ['amount'],
});
ontologyModel.addBusinessRule('order-amount-threshold', {
  entityType: 'Order',
  ruleType: 'threshold',
  condition: 'amount > 100',
  action: 'flag-for-review',
});

// 创建反馈闭环并注入本体模型
const feedbackLoop = new OntologyFeedbackLoop({ slidingWindowSize: 20 });
feedbackLoop.attachOntologyModel(ontologyModel);

// 监听事件
feedbackLoop.on('feedback-received', (data) => {
  console.log(`规则 ${data.ruleId} 反馈: ${data.status}`);
  if (data.adjustment) {
    console.log(`自动调整: ${data.adjustment.type}, 原因: ${data.adjustment.reason}`);
  }
});

feedbackLoop.on('rule-adjusted', (data) => {
  console.log(`规则 ${data.ruleId} 已调整: ${data.adjustmentType}`);
});

// 提交执行反馈
feedbackLoop.submitFeedback({
  ruleId: 'order-amount-threshold',
  status: FEEDBACK_STATUS.SUCCESS,
  entityData: { amount: 150, status: 'pending' },
});

feedbackLoop.submitFeedback({
  ruleId: 'order-amount-threshold',
  status: FEEDBACK_STATUS.FAILURE,
  reason: '阈值过高导致误报',
  entityData: { amount: 95, status: 'approved' },
});

// 查看规则效果
const effect = feedbackLoop.getRuleEffect('order-amount-threshold');
console.log(effect);
// → { ruleId: 'order-amount-threshold', triggers: 2, successes: 1, failures: 1, ... }

// 查看效果概览
const overview = feedbackLoop.getRuleEffectOverview();
console.log(overview);
// → [{ ruleId: 'order-amount-threshold', totalTriggers: 2, recentSuccessRate: 0.5, ... }]

// 查看统计
const stats = feedbackLoop.getStats();
console.log(stats);
// → { feedbackReceived: 2, adjustmentsMade: 0, rulesTracked: 1, ... }

feedbackLoop.shutdown();
ontologyModel.shutdown();
```

### 批量反馈提交

```javascript
const results = feedbackLoop.submitFeedbackBatch([
  { ruleId: 'order-amount-threshold', status: FEEDBACK_STATUS.SUCCESS, entityData: { amount: 200 } },
  { ruleId: 'order-amount-threshold', status: FEEDBACK_STATUS.FAILURE, reason: '边界情况' },
  { ruleId: 'order-amount-threshold', status: FEEDBACK_STATUS.PARTIAL, context: { mode: 'test' } },
]);

console.log(results);
// → { total: 3, adjustments: [] }
```

### 手动规则调整

```javascript
// 收紧阈值
const tightenResult = feedbackLoop.adjustRule(
  'order-amount-threshold',
  ADJUSTMENT_TYPES.THRESHOLD_TIGHTEN,
  { step: 20 },  // 自定义步长
);
// 条件从 "amount > 100" 变为 "amount > 120"

// 放宽阈值
const loosenResult = feedbackLoop.adjustRule(
  'order-amount-threshold',
  ADJUSTMENT_TYPES.THRESHOLD_LOOSEN,
);
// 条件从 "amount > 120" 变为 "amount > 108"（默认步长 10%）

// 更新条件表达式
const updateResult = feedbackLoop.adjustRule(
  'order-amount-threshold',
  ADJUSTMENT_TYPES.CONDITION_UPDATE,
  { newCondition: 'amount > 80 AND status:exists' },
);

// 禁用规则
feedbackLoop.adjustRule('order-amount-threshold', ADJUSTMENT_TYPES.RULE_DISABLE);

// 启用规则
feedbackLoop.adjustRule('order-amount-threshold', ADJUSTMENT_TYPES.RULE_ENABLE);
```

### 查询反馈历史

```javascript
// 获取所有历史（最近 100 条）
const allHistory = feedbackLoop.getHistory();

// 按规则过滤
const ruleHistory = feedbackLoop.getHistory({ ruleId: 'order-amount-threshold' });

// 按状态过滤
const failures = feedbackLoop.getHistory({ status: FEEDBACK_STATUS.FAILURE, limit: 50 });
```

### 自动调整触发场景

```javascript
// 场景：连续失败触发自动放宽
// 假设 slidingWindowSize=20, autoAdjustFailureRate=0.7
for (let i = 0; i < 15; i++) {
  feedbackLoop.submitFeedback({
    ruleId: 'order-amount-threshold',
    status: FEEDBACK_STATUS.FAILURE,
    reason: '阈值过高',
  });
}
// 失败率 = 15/15 = 1.0 ≥ 0.7 → 自动触发 THRESHOLD_LOOSEN
// 若失败率继续升至 ≥ 0.9 且非 validation 规则 → 自动触发 RULE_DISABLE

// 场景：高成功率触发自动收紧
// 假设 slidingWindowSize=20, autoAdjustSuccessRate=0.95
for (let i = 0; i < 20; i++) {
  feedbackLoop.submitFeedback({
    ruleId: 'order-amount-threshold',
    status: FEEDBACK_STATUS.SUCCESS,
  });
}
// 成功率 = 20/20 = 1.0 ≥ 0.95 → 自动触发 THRESHOLD_TIGHTEN
```

## 与其他模块的关系

```
OntologyFeedbackLoop
  ├── BusinessOntologyModel — 本体模型（双向联动：读取规则定义、写入规则调整）
  ├── IronRuleEngine — 铁律引擎（通过 BusinessOntologyModel 间接同步）
  ├── BoundedArray — 有界数组（反馈历史存储）
  ├── BoundedMap — 有界映射（规则效果追踪存储）
  ├── shutdown-mixin — 关机混入（生命周期管理）
  ├── debug-logger — 调试日志
  └── 基础设施子系统 — 所属子系统
```

## 相关文档

- [[模块详解-基础设施子系统]] — 基础设施子系统总览
- [[模块详解-基础设施核心模块群]] — 基础设施核心模块群
- [[核心功能-因果数据总线与一致性]] — 数据一致性与因果追踪
- [[核心功能-质量评估与自反思]] — 自反思与规则优化
