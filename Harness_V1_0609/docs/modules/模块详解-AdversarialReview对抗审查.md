# AdversarialReview 对抗审查

## 模块概述

**源文件**：`src/runtime/quality/adversarial-review.js`

AdversarialReview 是质量子系统的对抗审查器，采用魔鬼代言人角色与证伪实验设计，故意寻找缺陷和漏洞。支持双审查者多轮对抗审查、决策对抗审查和证伪检验三种审查模式，为系统提供主动防御性的质量保障能力。

核心原则：**不是验证正确性，而是主动寻找错误**

## 核心概念

### 对抗审查模式

| 模式 | 方法 | 说明 |
|------|------|------|
| 双审查者对抗 | `review()` | 两个审查者在最多N轮内对subject进行审查，寻求共识 |
| 决策对抗 | `decisionAdversarial()` | 从多个对立角色视角生成攻击清单与证伪信号 |
| 证伪检验 | `falsificationCheck()` | 对结论进行证伪检验，输出失败前提与最低可行实验建议 |

### 决策对抗角色

| 角色 | 名称 | 关注焦点 |
|------|------|---------|
| `cfo` | 冷静的CFO | 成本、ROI、现金流风险 |
| `investor` | 挑剔的投资人 | 市场规模、竞争壁垒、退出路径 |
| `veteran` | 行业老手 | 行业潜规则、隐性成本、监管风险 |
| `engineer` | 悲观工程师 | 技术可行性、复杂度、维护成本 |
| `ux_fanatic` | 用户体验偏执狂 | 用户学习成本、使用障碍、流失风险 |

## API 参考

### 构造函数

```javascript
new AdversarialReview(options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.maxRounds` | number | 3 | 最大审查轮数 |
| `options.reviewTimeout` | number | 30000 | 单次审查超时时间（毫秒） |

### review(subject, reviewerA, reviewerB)

双审查者多轮对抗审查。两个审查者在最多 `maxRounds` 轮内对 subject 进行审查，每轮收集双方反馈，若双方均 approved 则达成共识提前结束；否则合并反馈进入下一轮。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `subject` | object | 待审查的对象（提案/代码/设计等） |
| `reviewerA` | Function | 审查者A回调函数，签名为 `async (subject, context) => { approved, feedback, suggestions }` |
| `reviewerB` | Function | 审查者B回调函数，签名为 `async (subject, context) => { approved, feedback, suggestions }` |

**返回值**：`Promise<{ consensus, rounds, details, finalFeedback }>` 或 `Promise<{ consensus, rounds, error }>`

| 字段 | 类型 | 说明 |
|------|------|------|
| `consensus` | boolean | 是否达成共识 |
| `rounds` | number | 执行轮数 |
| `details` | Array\<object\> | 每轮审查详情 |
| `finalFeedback` | string | 最终合并反馈 |
| `error` | string | 错误信息（仅在异常时） |

**审查者回调返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `approved` | boolean | 是否批准 |
| `feedback` | string | 反馈意见 |
| `suggestions` | Array | 改进建议列表 |

### decisionAdversarial(proposal, options)

决策对抗审查，从多个对立角色视角生成攻击清单与证伪信号。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `proposal` | string | 待审查的决策提案 |
| `options` | object | 配置选项 |
| `options.roles` | Array\<string\> | 参与对抗的角色列表，默认 `['cfo', 'investor', 'veteran']` |

**返回值**：`Promise<{ type, proposal, attacks, falsification, antiSycophancyCheck, timestamp }>`

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `'decision_adversarial'` |
| `proposal` | string | 原始提案 |
| `attacks` | Array\<object\> | 各角色攻击清单，含 role/name/focus/challenges/falsificationSignals/prerequisites |
| `falsification` | object | 证伪信号与实验设计 |
| `antiSycophancyCheck` | object | 反谄媚检查结果 |
| `timestamp` | number | 时间戳 |

### falsificationCheck(conclusion, context)

对结论进行证伪检验，输出失败前提与最低可行实验建议。

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `conclusion` | string | 待证伪检验的结论 |
| `context` | object | 证伪上下文信息 |

**返回值**：`{ conclusion, context, whyItMightNotWork, prerequisitesForSuccess, falsificationSignals, minimumViableExperiment, confidenceLevel }`

| 字段 | 类型 | 说明 |
|------|------|------|
| `conclusion` | string | 原始结论 |
| `context` | string | 上下文信息 |
| `whyItMightNotWork` | Array | 可能失败的原因列表 |
| `prerequisitesForSuccess` | Array | 成功的前提条件列表 |
| `falsificationSignals` | Array | 证伪信号列表 |
| `minimumViableExperiment` | object\|null | 最低可行实验建议 |
| `confidenceLevel` | string | 置信度等级，默认 `'unverified'` |

## 事件类型

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `round-complete` | 每轮审查完成 | `{ round, reviewerA, reviewerB }` |
| `review-complete` | 审查完成 | `{ consensus, rounds, details, finalFeedback }` |

## 使用示例

### 基本双审查者对抗审查

```javascript
const AdversarialReview = require('./src/runtime/quality/adversarial-review');

const reviewer = new AdversarialReview({ maxRounds: 3, reviewTimeout: 15000 });

const result = await reviewer.review(
  { type: 'code', path: 'src/auth.js', content: '...' },
  // 审查者A：安全专家
  async (subject, context) => {
    const hasSQLInjection = subject.content.includes('raw SQL');
    return {
      approved: !hasSQLInjection,
      feedback: hasSQLInjection ? '检测到SQL注入风险' : '安全性通过',
      suggestions: hasSQLInjection ? ['使用参数化查询'] : [],
    };
  },
  // 审查者B：代码质量专家
  async (subject, context) => {
    const hasTests = subject.content.includes('test(');
    return {
      approved: hasTests,
      feedback: hasTests ? '测试覆盖充分' : '缺少单元测试',
      suggestions: hasTests ? [] : ['添加认证流程的单元测试'],
    };
  }
);

console.log(result.consensus);   // 是否达成共识
console.log(result.rounds);      // 审查轮数
console.log(result.finalFeedback); // 最终合并反馈
```

### 决策对抗审查

```javascript
const result = await reviewer.decisionAdversarial(
  '采用微服务架构重构现有单体应用',
  { roles: ['cfo', 'engineer', 'veteran'] }
);

// result.attacks 包含各角色的攻击清单
for (const attack of result.attacks) {
  console.log(`[${attack.name}] 关注: ${attack.focus}`);
  console.log(`  证伪信号: ${attack.falsificationSignals.join(', ')}`);
}
```

### 证伪检验

```javascript
const falsification = reviewer.falsificationCheck(
  '用户认证模块已经过充分测试，可以上线',
  { module: 'auth', testCoverage: 0.85 }
);

console.log(falsification.confidenceLevel); // 'unverified'
console.log(falsification.whyItMightNotWork); // 可能失败的原因
console.log(falsification.minimumViableExperiment); // 最低可行实验建议
```

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxRounds` | number | 3 | 双审查者对抗审查的最大轮数 |
| `reviewTimeout` | number | 30000 | 单次审查回调的超时时间（毫秒） |

**静态常量**：`AdversarialReview.DEFAULT_MAX_ROUNDS = 3`
