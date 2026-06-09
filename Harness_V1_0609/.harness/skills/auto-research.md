---
skill_id: auto-research
name: 自动调研优化循环
phase: module-development
priority: 3
enforcement: optional
applicable_agents: [domain-analyst, task-worker]
trigger: 用户提及自动调研/优化循环/auto-research或需要自动化迭代研究
trigger_conditions: []
auto_trigger: true
depends_on: [optimization-loop]
blocks: []
verified: true
stability: beta
---

## 目标

基于OptimizationLoop引擎实现自动化研究优化循环，通过牧羊人循环、约束执行、扰动策略和人工审批门控，确保优化目标对齐、防止漂移、支持崩溃恢复。

## 步骤

1. 配置优化环境（.harness/optimization.env.js）
2. 定义优化目标和约束条件
3. 启动优化循环并附加牧羊人循环和人工审批门控
4. 监控迭代进度（收敛检测、约束违反、扰动触发）
5. 从日志恢复状态（崩溃恢复）

# Auto Research Skill

## Overview

Automated research optimization loop with runtime-enforced patterns for goal alignment, crash recovery, constraint enforcement, perturbation escape, and human-in-the-loop approval. Based on the `OptimizationLoop` engine.

## 3-File Pattern

Auto research uses a standardized 3-file configuration pattern:

### 1. `.harness/optimization.env.js` or `.harness/optimization.env.json` — Environment Configuration

Configuration file containing runtime environment settings:

```javascript
// .harness/optimization.env.js
module.exports = {
  objective: '将模型验证loss降至0.01以下',
  constraints: [
    { name: 'trainingTime', max: 7200 },
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

Load via instance method: `loop.loadEnvironmentConfig()` or `loop.loadEnvironmentConfig('custom/path.env')`

### 2. `.harness/optimization-journal.md` — Optimization Journal

Auto-generated markdown journal tracking all iterations, metrics, and convergence status. Used for crash recovery via `loop.restoreFromJournal()`.

### 3. Loop Configuration — Constructor Options

Configuration passed directly to the `OptimizationLoop` constructor (see optimization-loop.md for full reference).

## Enhancement Features

### Shepherd Loop (Goal Re-injection)

Prevents goal drift by periodically re-injecting the original objective into the iteration context.

- Config: `shepherdInterval` (default: 10 iterations)
- Event: `shepherd-reinject` — fired when shepherd loop activates, data: `{ iteration, objective }`
- Context: `_buildShepherdContext()` returns original objective, constraints, best score, and alignment prompt

### Restore from Journal (Crash Recovery)

Recovers loop state from the MD journal file after crashes.

- Method: `loop.restoreFromJournal(journalPath)` (instance method, not static)
- Returns: `{ success: boolean, restored?: { bestScore, bestIteration, totalIterations, convergenceStatus }, error?: string }`
- Returns `{ success: false }` if file missing or malformed

### Constraint Enforcement

Active constraint checking during optimization iterations.

- Method: `_checkConstraints(result)` evaluates constraint satisfaction
- Event: `constraint-violation` — fired with violation details `{ iteration, violations }`
- Constraints defined via `defineObjective()` or `addConstraint()`
- Violations tracked per iteration, emitted as events

### Perturbation Strategy

Escapes local optima via perturbation when plateau detected.

- Config: `perturbationEnabled` — boolean (default: false), enable perturbation on plateau
- Config: `perturbationStrength` — number (default: 0.1), perturbation magnitude
- When enabled: plateau detection triggers perturbation injection into iteration context
- Perturbation data available in executeFn context via `_perturbation` field

### Human Approval Gate

Wires HumanApprovalGate into the optimization loop lifecycle.

- Method: `loop.attachHumanApprovalGate(gate)` — attach a HumanApprovalGate instance
- Approval triggered automatically at convergence detection
- Gate receives: `{ type: 'convergence-checkpoint', iteration, score, bestScore, reason }`
- If approval denied, loop continues iterating

### Environment Loader

Standardized `.harness/optimization.env.js/.json` file loader.

- Method: `loop.loadEnvironmentConfig(envPath)` (instance method, not static)
- Searches for `.harness/optimization.env.js` first, then `.harness/optimization.env.json`
- Returns `{ success: boolean, config?: Object, error?: string }`
- Applies objective, constraints, metrics, and options to the loop

## Usage Example

```javascript
const OptimizationLoop = require('./src/runtime/workflow/optimization-loop');
const HumanApprovalGate = require('./src/runtime/workflow/human-approval-gate');

const loop = new OptimizationLoop({
  maxIterations: 100,
  shepherdInterval: 10,
  perturbationEnabled: true,
  perturbationStrength: 0.1,
});

// Load environment config
const envResult = loop.loadEnvironmentConfig();
if (envResult.success) {
  console.log('Environment config loaded:', envResult.config);
}

// Restore from crash
const restored = loop.restoreFromJournal('.harness/optimization-journal.md');
if (restored.success) {
  console.log('Restored:', restored.restored);
}

// Attach human approval gate
const gate = new HumanApprovalGate({ timeout: 60000 });
loop.attachHumanApprovalGate(gate);

// Define objective with constraints
loop.defineObjective(
  'Minimize model loss below 0.01',
  [{ name: 'trainingTime', max: 7200 }],
  [{ name: 'loss', direction: 'minimize', target: 0.01, weight: 1 }],
);

// Listen for events
loop.on('shepherd-reinject', (data) => console.log('Goal re-injection:', data));
loop.on('constraint-violation', (data) => console.log('Constraint violated:', data));
loop.on('convergence-detected', (data) => console.log('Converged:', data));

await loop.start(async (ctx) => ({
  metrics: { loss: 0.05 },
  summary: 'improved model',
}));
```

## 验收标准
- [ ] 优化目标已量化定义
- [ ] 牧羊人循环（shepherdInterval）配置合理
- [ ] 约束违反检测有效（constraint-violation事件）
- [ ] 扰动策略在plateau时触发（perturbationEnabled）
- [ ] 人工审批门控在收敛时触发（attachHumanApprovalGate）
- [ ] 环境配置自动加载（loadEnvironmentConfig）
- [ ] 重启恢复从日志正确恢复状态（restoreFromJournal）

## 常见问题
- **Q: loadEnvironmentConfig()和loadEnv()有什么区别？**
  A: `loadEnvironmentConfig()`是当前正确的实例方法名，旧文档中的`loadEnv()`是静态方法，已不存在
- **Q: restoreFromJournal()是静态方法还是实例方法？**
  A: 是实例方法，需要先创建OptimizationLoop实例再调用：`loop.restoreFromJournal()`
- **Q: perturbationStrategy和perturbationInterval配置去哪了？**
  A: 已替换为`perturbationEnabled`(boolean)和`perturbationStrength`(number)配置，更简洁
- **Q: humanApprovalPoints和milestoneInterval配置去哪了？**
  A: 已简化为通过`attachHumanApprovalGate(gate)`注入，审批在收敛检测时自动触发
