---
skill_id: optimization-loop
name: 优化循环求解器
applicable_agents: [domain-analyst, task-worker, team-lead]
trigger: 用户提及优化/最优化/迭代优化/optimization/optimize/minimize/maximize或任务涉及可量化的优化目标
auto_trigger: true
phase: module-development
priority: 5
trigger_conditions:
  - 用户提及"优化/最优化/迭代优化/optimization/optimize/minimize/maximize"
  - 任务涉及可量化的优化目标（如loss下降、ROI提升、参数调优）
  - 需要持续迭代逼近最优解的场景
depends_on: [tdd-implement]
blocks: []
causal_inputs:
  - name: module-source-code
    source: tdd-implement
    required: true
causal_outputs:
  - name: optimization-journal
    description: MD优化日志
  - name: metrics-report
    description: 指标报告
  - name: best-result
    description: 最优结果
verified: true
stability: beta
usage_count: 0
success_rate: 0.0
enforcement: recommended
tools:
  - optimization-loop: 优化循环求解器
  - convergence-detector: 收敛检测器
  - metrics-collector: 指标采集器
model: claude-3-5-sonnet-20240620
production_validated: false
evidence_types:
  required:
    - optimization_journal
    - metrics_report
---

## 目标

将AI Agent转化为通用最优化求解器，通过无限循环迭代实现目标的持续自动化优化，支持牧羊人循环、约束执行、扰动策略和人工审批门控，不断逼近最优解。

# Skill: 优化循环求解器 (Optimization Loop Solver)

## 概述
基于"Auto Research"范式，将AI Agent转化为通用最优化求解器。通过无限循环迭代实现目标的持续自动化优化，不断逼近最优解。

## 触发条件
- 用户提出可量化的优化目标
- 需要持续迭代改进的场景
- 涉及loss/ROI/精确率等可量化指标的任务

## 执行步骤

### Step 1: 定义优化目标
使用 `OptimizationLoop.defineObjective()` 定义：
- **目标描述**: 如"将模型loss降至0.01以下"
- **约束条件**: 如"单日预算≤5000元"、"训练时间≤2小时"
- **量化指标**: 如 loss(minimize, target=0.01)、roi(maximize, target=3.0)
- **迭代策略**: 有界(固定轮数)或无限(持续优化直到收敛)

### Step 2: 配置迭代参数
- `maxIterations`: 最大迭代次数（Infinity=无限模式）
- `iterationIntervalMs`: 迭代间隔（0=最快，60000=每分钟，86400000=每天）
- `convergenceThreshold`: 收敛阈值（默认0.85）
- `stagnationWindow`: 停滞检测窗口（默认5轮）
- `resourceBudget`: 资源预算上限

### Step 3: 启动优化循环
调用 `OptimizationLoop.start(executeFn)` 启动循环。每次迭代：
1. 执行任务（运行脚本/训练模型/投放广告等）
2. 采集指标（loss/ROI/精确率等）
3. 评估质量（加权归一化复合分数）
4. 记录到MD优化日志
5. 检查收敛/停滞/资源耗尽
6. 策略自动切换（plateau→换策略，degrading→回滚）

### Step 4: 监控与干预
- 监听事件: iteration-complete, convergence-detected, stagnation-detected, strategy-suggestion, auto-rollback
- 查看进度: `getProgress()` 返回当前迭代、最佳分数、指标历史
- 查看日志: `getJournal()` 返回MD优化日志
- 人工干预: pause/resume/stop 生命周期控制

### Step 5: 获取最优结果
- 收敛后获取 `bestResult` 和 `bestScore`
- 查看完整优化轨迹（MD日志）
- 必要时 `rollbackTo(iteration)` 回滚到历史迭代

## 进阶：牧羊人循环（运行时强制执行）
在基础优化循环上增加（v2.7.161起已内置为运行时功能，无需手动实现）：
- **定期重读目标**: `shepherdInterval`配置（默认10轮），自动重新注入原始目标和约束到迭代上下文，触发`shepherd-reinject`事件
- **阶段性评估**: 每`shepherdInterval`轮进行一次全局评估，防止局部最优
- **人类反馈节点**: 通过`attachHumanApprovalGate(gate)`注入HumanApprovalGate，在收敛检测时自动触发人工审批

### 牧羊人循环配置
```javascript
const loop = new OptimizationLoop({
  shepherdInterval: 10,          // 每10轮重新注入目标（默认10）
  perturbationEnabled: true,     // 启用扰动策略（默认false）
  perturbationStrength: 0.1,     // 扰动强度（默认0.1）
});

// 监听牧羊人重注入事件
loop.on('shepherd-reinject', (data) => {
  console.log(`牧羊人重注入: 迭代${data.iteration}, 目标=${data.objective}`);
});

// 注入人工审批门控
const gate = new HumanApprovalGate({ timeout: 300000 });
loop.attachHumanApprovalGate(gate);
```

## 环境配置管理
优化循环的三要素配置文件（v2.7.161起支持`loadEnvironmentConfig()`自动加载）：

### 1. 环境变量文件（`.harness/optimization.env.js`或`.env.json`）
```javascript
// .harness/optimization.env.js
module.exports = {
  objective: '将模型验证loss降至0.01以下',
  constraints: [
    { name: 'trainingTime', max: 7200 },
    { name: 'gpuMemory', max: 8192 },
    { name: 'dailyBudget', max: 5000 },
  ],
  metrics: [
    { name: 'val_loss', direction: 'minimize', target: 0.01, weight: 0.6 },
    { name: 'val_accuracy', direction: 'maximize', target: 0.99, weight: 0.4 },
  ],
  options: {
    convergenceThreshold: 0.9,
    iterationIntervalMs: 300000,
    maxIterations: Infinity,
  },
};
```

自动加载：
```javascript
const loop = new OptimizationLoop();
const result = loop.loadEnvironmentConfig(); // 自动查找.harness/optimization.env.js/.json
if (result.success) {
  await loop.start(executeFn);
}
```

### 2. 执行工具逻辑（`OptimizationLoop.start(executeFn)`）
executeFn 接收上下文并返回指标：
```javascript
async function executeFn(context, options) {
  // 1. 读取上一次最优结果
  const previousBest = context._previousBestResult;
  // 2. 执行优化操作（训练/投流/调参）
  const result = await runOptimizationStep(context);
  // 3. 返回量化指标
  return {
    metrics: { val_loss: result.loss, val_accuracy: result.accuracy },
    changes: result.summary,
    resourceUsed: result.cost,
  };
}
```

### 3. MD优化日志（自动生成）
`OptimizationLoop` 自动维护 `.harness/optimization-journal.md`，包含：
- 目标和约束定义
- 指标定义表（名称/类型/方向/目标/权重）
- 每次迭代的分数、策略、变更记录
- 实时更新的汇总表（最佳分数/最佳迭代/收敛状态）

## Dashboard API
优化循环提供三个 Dashboard API 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/optimization/status` | GET | 优化循环状态（status/iteration/bestScore/strategyTrend） |
| `/api/optimization/progress` | GET | 优化进度详情（含指标历史和收敛状态） |
| `/api/optimization/journal` | GET | MD优化日志全文 |

## 桌面伙伴集成
桌面伙伴自动监控优化循环状态：
- **优化中**（running）→ AI状态切换为"优化中"，事件日志记录迭代进度
- **已收敛**（converged）→ AI状态切换为"已收敛"，触发庆祝动画+音效
- **资源耗尽**（exhausted）→ AI状态切换为待机，显示资源耗尽提示
- **失败**（failed）→ AI状态切换为报错，记录错误日志

## 代码示例
```javascript
const OptimizationLoop = require('./src/runtime/workflow/optimization-loop');

const loop = new OptimizationLoop({
  maxIterations: Infinity,
  iterationIntervalMs: 300000,
  convergenceThreshold: 0.9,
  journalPath: '.harness/optimization-journal.md',
  shepherdInterval: 10,          // 牧羊人循环：每10轮重注入目标
  perturbationEnabled: true,     // 扰动策略：plateau时注入随机扰动
  perturbationStrength: 0.15,    // 扰动强度
});

loop.defineObjective(
  '将模型验证loss降至0.01以下',
  [
    { name: 'trainingTime', max: 7200 },    // 约束：训练时间≤2小时
    { name: 'dailyBudget', max: 5000 },     // 约束：日预算≤5000
  ],
  [
    { name: 'val_loss', direction: 'minimize', target: 0.01, weight: 0.6 },
    { name: 'val_accuracy', direction: 'maximize', target: 0.99, weight: 0.4 },
  ]
);

loop.on('iteration-complete', (data) => {
  console.log(`迭代 ${data.iteration}: 分数=${data.compositeScore.toFixed(4)}, 最佳=${data.bestScore.toFixed(4)}`);
});

loop.on('shepherd-reinject', (data) => {
  console.log(`牧羊人重注入: 迭代${data.iteration}, 目标=${data.objective}`);
});

loop.on('constraint-violation', (data) => {
  console.warn(`约束违反: 迭代${data.iteration}, 违反=${data.violations.length}项`);
});

loop.on('convergence-detected', (data) => {
  console.log(`收敛! 最佳分数=${data.bestScore}, 最佳迭代=${data.bestIteration}`);
});

await loop.start(async (context) => {
  // context包含：objective, constraints, _previousBestResult, _shepherdReinject, _perturbation
  const result = await runOptimizationStep(context);
  return {
    metrics: { val_loss: result.loss, val_accuracy: result.accuracy },
    changes: result.summary,
    resourceUsed: result.cost,
  };
});
```

## 重启恢复
```javascript
const loop = new OptimizationLoop({ journalPath: '.harness/optimization-journal.md' });
const restored = loop.restoreFromJournal();
if (restored.success) {
  console.log(`恢复: 最佳分数=${restored.restored.bestScore}, 迭代=${restored.restored.totalIterations}`);
  await loop.start(executeFn); // 从上次中断处继续
}
```

## R52安全加固

### guardShutdown保护
以下方法在执行前调用`guardShutdown()`，防止在实例关闭后调用：
- `rollbackTo(iteration)` — 回滚到指定迭代
- `attachMetricsCollector(collector)` — 附加外部指标收集器
- `attachConvergenceDetector(detector)` — 附加自定义收敛检测器
- `getProgress()` — 获取当前优化进度
- `getStats()` — 获取统计信息
- `restoreFromJournal(journalPath)` — 从日志恢复状态
- `loadEnvironmentConfig(envPath)` — 加载环境配置

### _onShutdown完整清理
关闭时执行完整清理序列（R52增强）：
1. 清除迭代定时器（`_nextIterationTimer`）
2. 解除待定延迟Promise（`_pendingDelayResolve`）
3. 若循环正在运行，状态设为STOPPED并记录停止时间
4. 同步刷写优化日志（`_flushJournalSync()`）
5. 清除人工审批门引用（`_humanApprovalGate = null`）
6. 清空快照和指标历史（`_snapshots.clear()`, `_metricsHistory = []`）
7. 关闭收敛检测器（`_convergenceDetector.shutdown()`）
8. 清空指标定义和日志缓冲
9. 清空执行函数和选项引用
10. 返回`_loopPromise`确保异步循环正确终止

### getStats()增强字段（R52）
`getStats()`返回值新增以下字段：
- `shepherdInterval` — 牧羊人重注入间隔
- `perturbationEnabled` — 扰动策略是否启用
- `humanGateAttached` — 是否已附加人工审批门
- `healthy` — 实例是否健康（未关闭且非FAILED状态）
- `shutDown` — 实例是否已关闭

## 验收标准
- [ ] 优化目标已量化定义
- [ ] 指标方向（minimize/maximize）正确
- [ ] 收敛阈值合理
- [ ] MD优化日志正常生成
- [ ] 收敛/停滞检测有效
- [ ] 策略自动切换触发正确
- [ ] 牧羊人循环（shepherdInterval）配置合理
- [ ] 约束违反检测有效（constraint-violation事件）
- [ ] 扰动策略在plateau时触发（perturbationEnabled）
- [ ] 人工审批门控在收敛时触发（attachHumanApprovalGate）
- [ ] 环境配置自动加载（loadEnvironmentConfig）
- [ ] 重启恢复从日志正确恢复状态（restoreFromJournal）
- [ ] guardShutdown在关键方法上生效（R52）
- [ ] _onShutdown完整清理序列正确执行（R52）
- [ ] _loopPromise在关闭时正确返回（R52）

## 常见问题
- **Q: 优化一直不收敛怎么办？**
  A: 检查收敛阈值是否过高，考虑调整指标权重或增加stagnationWindow触发策略切换
- **Q: 如何避免局部最优？**
  A: 启用perturbationEnabled配置，在plateau时自动注入扰动；配合shepherdInterval定期重读目标
- **Q: 资源预算耗尽但未收敛怎么办？**
  A: 查看优化日志分析趋势，考虑增加资源预算或调整优化策略
- **Q: 如何在关键节点请求人类确认？**
  A: 使用attachHumanApprovalGate(gate)注入审批门控，收敛检测时自动触发人类审批
- **Q: 进程崩溃后如何恢复？**
  A: 使用restoreFromJournal()从MD优化日志恢复最佳分数和迭代状态
- **Q: 关闭后调用方法报错怎么办？**（R52）
  A: R52起所有关键方法添加了guardShutdown()保护，关闭后调用会抛出错误。确保在调用前检查loop.isHealthy()或捕获错误
- **Q: _onShutdown返回的_loopPromise有什么用？**（R52）
  A: _onShutdown返回_loopPromise确保异步循环正确终止，调用方可以await此Promise等待循环完全停止
