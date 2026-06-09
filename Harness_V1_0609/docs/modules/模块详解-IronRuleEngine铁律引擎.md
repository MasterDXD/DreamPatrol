# 模块详解 — IronRuleEngine 铁律引擎

> 所属子系统：[[SDD规范驱动子系统]] | 融合自：Claude Code Standards | 版本：2.73.4

## 模块概述

`iron-rule-engine.js` 是框架的强制性规则执行引擎，是SDD规范驱动开发子系统的核心组件。它维护一组不可违反的"铁律"规则，在代码生成和审查阶段自动执行检查。内置10+条铁律规则，支持自定义规则扩展、规则启停、违规追踪、规则效果评估、规则导出/导入同步和指纹生成。

**源码位置**：`src/runtime/sdd/iron-rule-engine.js`

## 核心能力

| 能力 | 说明 |
|------|------|
| 10+内置铁律 | 覆盖架构、安全、风格、性能四大类别 |
| 自定义规则 | 在线添加/移除自定义规则，支持动态注册 |
| 违规追踪 | 记录每次违规，统计违规频率和趋势 |
| 规则效果评估 | 追踪每条规则的实际效果（命中率、误报率） |
| 团队规则同步 | 导出/导入规则集，支持团队间规则同步 |
| 规则指纹 | 生成规则集指纹，检测规则变更 |
| 模式规则生成 | 从错误模式自动生成规则（与AutoReinLearningLoop集成） |

## 内置铁律规则

### 架构规则（Architecture）

| 规则ID | 名称 | 严重级别 | 说明 |
|--------|------|---------|------|
| `no-cross-layer-calls` | 禁止跨层调用 | CRITICAL | 严格禁止跨层调用（Interaction→Domain/Infra） |
| `no-direct-db-access` | 禁止直接DB访问 | CRITICAL | 业务层禁止直接访问数据库 |

### 安全规则（Security）

| 规则ID | 名称 | 严重级别 | 说明 |
|--------|------|---------|------|
| `no-hardcoded-secrets` | 禁止硬编码密钥 | CRITICAL | 禁止在源码中硬编码密码、API密钥、Token |
| `no-eval-injection` | 禁止eval注入 | CRITICAL | 禁止使用eval()和Function()构造函数 |
| `no-path-traversal` | 禁止路径遍历 | CRITICAL | 文件操作必须检查路径遍历 |

### 风格规则（Style）

| 规则ID | 名称 | 严重级别 | 说明 |
|--------|------|---------|------|
| `no-untyped-parameters` | 禁止无类型参数 | WARNING | 公开API函数参数必须有类型注解 |
| `no-magic-numbers` | 禁止魔法数字 | WARNING | 禁止使用未命名的魔法数字 |
| `no-excessive-params` | 禁止过多参数 | WARNING | 函数参数不应超过5个 |

### 性能规则（Performance）

| 规则ID | 名称 | 严重级别 | 说明 |
|--------|------|---------|------|
| `no-sync-io` | 禁止同步I/O | WARNING | 禁止同步I/O操作（fs.readFileSync等） |
| `no-memory-leak` | 禁止内存泄漏 | WARNING | 检测常见内存泄漏模式（未清理的定时器/监听器） |

## 规则结构

```javascript
{
  id: 'no-cross-layer-calls',           // 唯一规则ID
  name: 'No Cross-Layer Calls',         // 人类可读名称
  description: 'Strictly prohibit...',  // 规则描述
  severity: 'critical',                 // 严重级别：critical/warning/info
  category: 'architecture',             // 分类：architecture/security/style/performance
  enabled: true,                        // 是否启用
  check: function(ctx) { ... },        // 校验函数，返回 { violated, evidence }
  source: 'built-in',                   // 来源：built-in/custom/imported
  solution: 'Use dependency injection', // 修复建议
  addedAt: '2026-06-04T...',           // 添加时间
  effectiveness: {                      // 效果追踪
    hits: 0,                           // 命中次数
    falsePositives: 0,                 // 误报次数
    lastHit: null,                     // 最后命中时间
  },
}
```

## 校验上下文（ctx）

```javascript
{
  code: '...',          // 源代码内容
  filePath: '...',      // 文件路径
  language: 'js',       // 编程语言
  moduleName: '...',    // 模块名称
  metadata: { ... },    // 附加元数据
}
```

## API 参考

### 构造函数

#### `new IronRuleEngine(options)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.defaultRules` | string[] | 否 | 默认启用的规则ID列表 |
| `options.maxViolations` | number | 否 | 最大违规记录数（默认1000） |

### 核心方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `check(ctx)` | object | Violation[] | 执行所有启用规则的校验 |
| `checkRule(ruleId, ctx)` | string, object | Violation\|null | 执行单条规则校验 |
| `addRule(rule)` | object | `{ ruleId }` | 添加自定义规则 |
| `removeRule(ruleId)` | string | boolean | 移除规则 |
| `enableRule(ruleId)` | string | void | 启用规则 |
| `disableRule(ruleId)` | string | void | 禁用规则 |
| `getRule(ruleId)` | string | object\|null | 获取规则定义 |
| `getAllRules()` | — | object[] | 获取所有规则 |
| `getViolations(options)` | object | Violation[] | 获取违规记录 |
| `getViolationStats()` | — | object | 获取违规统计 |
| `clearViolations()` | — | void | 清空违规记录 |

### 规则同步方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `exportRules()` | — | object | 导出规则集（含效果数据） |
| `importRules(ruleset)` | object | `{ added, updated, errors }` | 导入规则集 |
| `syncFrom(ruleset)` | object | `{ added, updated, removed, unchanged, errors }` | 从远程规则集同步（增/改/删） |
| `getRuleFingerprint()` | — | string | 获取规则集指纹（SHA-256） |

### 模式规则方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `addPatternRule(pattern)` | object | `{ ruleId }` | 从错误模式生成规则 |
| `getRuleEffectiveness(ruleId)` | string | object | 获取规则效果报告 |
| `recordRuleOutcome(ruleId, outcome)` | string, object | void | 记录规则执行结果 |

### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `rule-violated` | 规则被违反 | `{ ruleId, rule, violation }` |
| `rule-added` | 规则添加 | `{ ruleId, rule }` |
| `rule-removed` | 规则移除 | `{ ruleId }` |
| `rule-enabled` | 规则启用 | `{ ruleId }` |
| `rule-disabled` | 规则禁用 | `{ ruleId }` |
| `rules-exported` | 规则导出 | `{ version, ruleCount }` |
| `rules-imported` | 规则导入 | `{ added, updated }` |
| `rules-synced` | 规则同步 | `{ added, updated, removed }` |
| `pattern-rule-generated` | 模式规则生成 | `{ ruleId, pattern }` |

## 使用示例

```javascript
const IronRuleEngine = require('./src/runtime/sdd/iron-rule-engine');

const engine = new IronRuleEngine();

// 校验代码
const violations = engine.check({
  code: 'const password = "admin123";',
  filePath: 'src/config.js',
  language: 'js',
});

console.log(violations);
// → [{ ruleId: 'no-hardcoded-secrets', severity: 'critical', ... }]

// 添加自定义规则
engine.addRule({
  id: 'no-jquery',
  name: 'No jQuery',
  description: 'Prohibit jQuery usage in modern code',
  severity: 'warning',
  category: 'style',
  check: function(ctx) {
    const hasJQuery = /\$\s*\(/.test(ctx.code || '');
    return { violated: hasJQuery, evidence: hasJQuery ? 'jQuery usage detected' : '' };
  },
});

// 导出规则集
const ruleset = engine.exportRules();
console.log(ruleset.ruleCount); // → 11

// 在另一台机器同步
const syncResult = engine.syncFrom(ruleset);
console.log(syncResult);
// → { added: 0, updated: 0, removed: 0, unchanged: 11, errors: 0 }

// 获取规则指纹
const fingerprint = engine.getRuleFingerprint();
console.log(fingerprint); // → SHA-256 hash

// 查看违规统计
const stats = engine.getViolationStats();
console.log(stats);
// → { total: 5, critical: 2, warning: 3, byRule: { ... } }

// 查看规则效果
const effectiveness = engine.getRuleEffectiveness('no-hardcoded-secrets');
console.log(effectiveness);
// → { hits: 3, falsePositives: 0, accuracy: 1.0 }

engine.shutdown();
```

## 与其他模块的关系

```
IronRuleEngine
  ├── AutoReinLearningLoop — 自增强学习循环（模式→规则生成）
  ├── ErrorPreventionGuard — 错误预防守卫（执行前注入历史错误模式）
  ├── FrameworkComplianceChecker — 框架合规检查（互补校验）
  ├── TechStackTemplates — 技术栈模板（规则同步）
  ├── SDD规范驱动子系统 — 所属子系统
  └── DreamBridge — 梦境桥接（DreamEngine→IronRuleEngine规则更新）
```

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `SEVERITY_LEVELS.CRITICAL` | `'critical'` | 严重级别（不可违反） |
| `SEVERITY_LEVELS.WARNING` | `'warning'` | 警告级别 |
| `SEVERITY_LEVELS.INFO` | `'info'` | 信息级别 |
| `CATEGORY_TYPES.ARCHITECTURE` | `'architecture'` | 架构规则 |
| `CATEGORY_TYPES.SECURITY` | `'security'` | 安全规则 |
| `CATEGORY_TYPES.STYLE` | `'style'` | 风格规则 |
| `CATEGORY_TYPES.PERFORMANCE` | `'performance'` | 性能规则 |

## 相关文档

- [[模块详解-SDD规范驱动子系统]] — SDD规范驱动开发总览
- [[模块详解-FrameworkComplianceChecker模块]] — 框架合规检查器
- [[模块详解-TechStackTemplates技术栈模板]] — 技术栈模板系统
- [[核心功能-质量评估与自反思]] — 自反思与规则生成