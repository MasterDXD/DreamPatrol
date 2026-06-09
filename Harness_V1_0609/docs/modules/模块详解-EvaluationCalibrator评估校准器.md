# 模块详解-EvaluationCalibrator评估校准器

> 版本：2.73.4 | 文件：src/runtime/quality/evaluation-calibrator.js

---

## 模块定位与架构角色

EvaluationCalibrator 是 Harness 多 Agent 框架质量子系统的评估校准器，融合自 Anthropic Harness 设计理念中的 Self-Evaluation 偏差校正机制。其核心职责是追踪模型声称的置信度与实际通过率之间的偏差，生成校准曲线，并根据历史校准数据自动调整评估阈值，防止模型系统性地高估自身产出质量。

在架构中，EvaluationCalibrator 位于质量子系统的校准层，为 QualityScorer、SelfReflection 等评分模块提供阈值校准服务，确保评估判定的客观性与可靠性。同时，校准报告可供 Harness 迁移性引擎参考，辅助跨场景决策。

## 核心能力

- **偏差追踪**：记录每次评估的模型置信度与实际通过结果，计算校准误差（calibration error）
- **自动校准**：当检测到系统性高估时自动提高评估阈值，低估时降低阈值，校准良好时缓慢回归
- **滑动窗口**：基于可配置的滑动窗口管理历史记录，保证校准数据的新鲜度
- **校准报告**：提供结构化校准报告，包含样本量、平均置信度、通过率、校准误差、偏差方向等指标
- **优雅关闭**：通过 `withShutdown` 混入支持标准化关闭流程

## 类定义与构造函数

### 类签名

```javascript
class EvaluationCalibrator {
  constructor(options)
  record(confidence, passed)
  getCalibratedThreshold(baseThreshold)
  getCalibrationReport()
  _recalibrate()       // 内部方法
  _onShutdown()        // 关闭钩子（withShutdown 混入）
}

module.exports = withShutdown(EvaluationCalibrator);
```

通过 `withShutdown` 混入后导出，自动获得 `shutdown()`、`isHealthy()`、`guardShutdown()` 方法和 `_onShutdown()` 生命周期钩子。

### 构造函数

#### `new EvaluationCalibrator(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.windowSize` | number | 否 | 50 | 滑动窗口大小，控制历史记录的最大条数 |
| `options.overestimateThreshold` | number | 否 | 0.15 | 高估检测阈值，置信度与通过率之差超过此值视为高估 |
| `options.adjustmentFactor` | number | 否 | 0.05 | 阈值调整步长，每次校准的调整幅度 |
| `options.maxThresholdAdjustment` | number | 否 | 0.3 | 最大阈值调整幅度，防止过度校正 |

## 公开方法详解

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `record` | `record(confidence, passed): void` | void | 记录一次评估结果，触发自动校准 |
| `getCalibratedThreshold` | `getCalibratedThreshold(baseThreshold): number` | number | 获取校准后的评估阈值 |
| `getCalibrationReport` | `getCalibrationReport(): Object` | Object | 获取校准报告 |

### `record(confidence, passed)`

记录一次评估结果并触发自动校准。当历史记录超过滑动窗口大小时，自动淘汰最旧的记录。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `confidence` | number | 是 | 模型声称的置信度（0-1） |
| `passed` | boolean | 是 | 实际是否通过 |

**行为细节**：
1. 将 `{ confidence, passed, timestamp }` 追加到内部记录数组
2. 若记录数超过 `_windowSize`，裁剪最早的记录
3. 调用 `_recalibrate()` 执行校准计算

### `getCalibratedThreshold(baseThreshold)`

基于当前校准偏移量，返回调整后的评估阈值。校准后的阈值上限为 1。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `baseThreshold` | number | 是 | 基础阈值（0-1） |

**返回值**：`number` — 校准后的阈值，计算公式为 `min(1, baseThreshold + _thresholdAdjustment)`

### `getCalibrationReport()`

获取结构化校准报告。当无历史记录时返回默认值。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sampleSize` | number | 样本量（历史记录数） |
| `avgConfidence` | number | 平均置信度（保留3位小数），无记录时为0 |
| `passRate` | number | 实际通过率（保留3位小数），无记录时为0 |
| `calibrationError` | number | 校准误差（保留3位小数），无记录时为0 |
| `thresholdAdjustment` | number | 当前阈值调整量（保留3位小数），无记录时为0 |
| `bias` | string | 偏差方向：`overestimate` / `underestimate` / `calibrated` / `unknown` |

### 内部方法 `_recalibrate()`

执行校准计算的核心逻辑，在 `record()` 中自动调用。仅当样本量 ≥ 5 时执行校准。

**校准算法**：

```
calibrationError = avgConfidence - passRate

if calibrationError > overestimateThreshold:
    thresholdAdjustment = min(maxThresholdAdjustment, thresholdAdjustment + adjustmentFactor)
elif calibrationError < -overestimateThreshold:
    thresholdAdjustment = max(-maxThresholdAdjustment, thresholdAdjustment - adjustmentFactor)
else:
    thresholdAdjustment *= 0.95  // 校准良好时缓慢回归
```

**偏差方向判定**：

| 条件 | bias 值 |
|------|---------|
| calibrationError > overestimateThreshold | `overestimate`（系统性高估） |
| calibrationError < -overestimateThreshold | `underestimate`（系统性低估） |
| 其他 | `calibrated`（校准良好） |
| 无记录 | `unknown` |

## 事件体系

EvaluationCalibrator 通过 `withShutdown` 混入继承 EventEmitter，在关闭时发射 `shutdown` 事件。模块本身不发射自定义业务事件。

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `shutdown` | 调用 `shutdown()` 时 | `{ signal }` |

## 配置常量

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `_windowSize` | 50 | 滑动窗口大小，控制校准数据的新鲜度 |
| `_overestimateThreshold` | 0.15 | 高估检测阈值，置信度偏差超过此值触发校准调整 |
| `_adjustmentFactor` | 0.05 | 阈值调整步长，每次校准的增减幅度 |
| `_maxThresholdAdjustment` | 0.3 | 最大阈值调整幅度，防止过度校正导致阈值失真 |
| 校准最低样本量 | 5 | `_recalibrate()` 在样本量不足5时不执行校准 |
| 回归衰减因子 | 0.95 | 校准良好时阈值调整量按此因子衰减回归 |

## 使用示例

### 基本用法

```javascript
const EvaluationCalibrator = require('./src/runtime/quality/evaluation-calibrator');

const calibrator = new EvaluationCalibrator({
  windowSize: 100,
  overestimateThreshold: 0.15,
  adjustmentFactor: 0.05,
  maxThresholdAdjustment: 0.3,
});

// 记录评估结果：模型声称0.9置信度，实际通过
calibrator.record(0.9, true);

// 记录评估结果：模型声称0.85置信度，实际未通过
calibrator.record(0.85, false);

// 获取校准后的阈值（基础阈值0.6）
const threshold = calibrator.getCalibratedThreshold(0.6);
console.log('校准后阈值:', threshold);

// 获取校准报告
const report = calibrator.getCalibrationReport();
console.log('校准报告:', report);
// 输出示例:
// {
//   sampleSize: 2,
//   avgConfidence: 0.875,
//   passRate: 0.5,
//   calibrationError: 0.375,
//   thresholdAdjustment: 0.05,
//   bias: 'overestimate'
// }
```

### 与 QualityScorer 集成

```javascript
const QualityScorer = require('./src/runtime/quality/quality-scorer');
const EvaluationCalibrator = require('./src/runtime/quality/evaluation-calibrator');

const scorer = new QualityScorer();
const calibrator = new EvaluationCalibrator({ windowSize: 50 });

// 评分后记录校准数据
scorer.on('scored', (score) => {
  const passed = score.total >= 0.6;
  calibrator.record(score.total, passed);
});

// 使用校准阈值进行质量判定
const result = scorer.score(output, task);
const calibratedThreshold = calibrator.getCalibratedThreshold(0.6);
const isAcceptable = result.total >= calibratedThreshold;
```

### 优雅关闭

```javascript
// 关闭校准器，清空内部状态
calibrator.shutdown();

// 检查健康状态
console.log(calibrator.isHealthy()); // false
```

## 依赖关系

- 依赖：`../../utils/shutdown-mixin`（`withShutdown` 优雅关闭混入）
- 被依赖：QualityScorer（质量评分器，阈值校准）
- 被依赖：SelfReflection（自反思引擎，评估偏差校正）
- 被依赖：Harness 迁移性引擎（校准报告参考）
