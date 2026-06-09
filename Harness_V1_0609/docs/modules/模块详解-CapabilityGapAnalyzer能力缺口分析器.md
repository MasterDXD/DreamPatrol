# 模块详解 — CapabilityGapAnalyzer 能力缺口分析器

> 所属子系统：[[工作流子系统]] | 依赖：无 | 参考：OpenAI Harness Engineering | 版本：2.73.4

---

## 模块概述

`CapabilityGapAnalyzer` 是 Harness Engineering 范式的核心组件，负责系统性诊断当前项目环境中的能力缺口，涵盖六个维度：技能（Skills）、工具（Tools）、规则（Rules）、CI/CD、文档（Docs）、测试（Tests）。

**核心理念**：当 AI Agent 执行任务失败时，不是简单地"再试一次"，而是回溯分析环境缺少了什么能力，对应 Harness Engineering 三大核心职责中的"设计环境"和"构建反馈"。

**源码位置**：`src/runtime/workflow/capability-gap-analyzer.js`（~676行）

---

## 模块定位

在 Harness 工作流子系统中，`CapabilityGapAnalyzer` 是环境诊断的核心组件：

- **RalphWiggumLoop**：自主开发闭环的执行引擎，在失败时调用 CapabilityGapAnalyzer 分析缺口
- **CapabilityGapAnalyzer**：独立的六维能力缺口分析器，提供可操作的改进建议

---

## 架构角色

```
                      CapabilityGapAnalyzer
                    ┌─────────────────────────────────┐
  分析上下文 ──────→│  analyze(context)                │
                    │   ├── _analyzeSkillsGap()       │──→ 技能缺口
                    │   ├── _analyzeToolsGap()        │──→ 工具缺口
                    │   ├── _analyzeRulesGap()        │──→ 规则缺口
                    │   ├── _analyzeCIGap()           │──→ CI/CD缺口
                    │   ├── _analyzeDocsGap()         │──→ 文档缺口
                    │   └── _analyzeTestsGap()        │──→ 测试缺口
                    │                                 │
                    │   _buildRecommendations()       │──→ 排序推荐
                    │   _buildSummary()               │──→ 分析摘要
                    │                                 │
  能力注册 ────────→│  registerCapability()           │
                    │  registerCapabilities()         │
                    │  hasCapability()                │
                    └─────────────────────────────────┘
```

---

## 六维分析维度

### 1. 技能（Skills）
分析当前可用技能是否满足任务类型的基础要求。支持 6 种任务类型的基础技能要求：

| 任务类型 | 基础技能 |
|----------|----------|
| fullstack-build | requirement-analysis, architecture-design, tdd-implement, module-development, code-review, integration-testing, deployment, verification-before-completion |
| api-development | requirement-analysis, api-design, tdd-implement, code-review, integration-testing, deployment |
| bug-fix | systematic-debugging, bug-fix, code-review, verification-before-completion |
| refactoring | architecture-design, code-review, module-development, integration-testing, verification-before-completion |
| documentation | document-parsing, code-wiki-generation, verification-before-completion |
| research | brainstorming, ai-research, requirement-analysis, architecture-design |

### 2. 工具（Tools）
检查基础开发工具（git, node, npm）和 CI/CD 运行器是否可用。

### 3. 规则（Rules）
检查 ESLint 配置和基础规则（no-unused-vars, no-console, complexity, max-lines）是否配置。

### 4. CI/CD
检查 CI 流水线是否配置，以及基础步骤（lint, test, build）是否完整。

### 5. 文档（Docs）
检查基础文档（README, API-docs, architecture-overview）是否存在。

### 6. 测试（Tests）
检查测试框架是否配置，以及基础测试类型（unit-tests, integration-tests）是否覆盖。

---

## 严重程度分级

| 级别 | 权重 | 说明 |
|------|------|------|
| critical | 100 | 核心功能缺失，必须立即修复 |
| high | 70 | 重要功能缺失，强烈建议修复 |
| medium | 40 | 建议修复，影响中等 |
| low | 10 | 可选修复，影响较小 |

---

## 使用示例

```javascript
const CapabilityGapAnalyzer = require('./src/runtime/workflow/capability-gap-analyzer');

const analyzer = new CapabilityGapAnalyzer({
  maxRecommendations: 20,
  severityThreshold: 'low',
  autoPrioritize: true,
});

// 注册已知能力（可选，用于跳过已满足的能力）
analyzer.registerCapability('skills', 'tdd-implement', { phase: 'implement' });
analyzer.registerCapabilities([
  { dimension: 'tools', name: 'git' },
  { dimension: 'rules', name: 'eslint' },
]);

// 执行分析
const result = await analyzer.analyze({
  task: 'build a full-stack web application with authentication',
  taskType: 'fullstack-build',
  availableSkills: ['requirement-analysis'],
  availableTools: ['git', 'node', 'npm'],
  lintRules: ['eslint'],
  ciSteps: ['lint', 'test'],
  docs: ['README'],
  testTypes: ['unit-tests'],
  environment: { hasCI: true, hasLint: true, hasTests: true },
});

console.log('Summary:', result.summary);
console.log('Gaps:', result.gaps);
console.log('Recommendations:');
for (const rec of result.recommendations) {
  console.log(`  [${rec.severity}] ${rec.dimension}: ${rec.name} - ${rec.suggestion}`);
}

// 获取统计信息
const stats = analyzer.getStats();
console.log('Total analyses:', stats.totalAnalyses);
console.log('Total gaps:', stats.totalGaps);
```

---

## 事件

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| `gap-identified` | 识别到能力缺口时 | `{ dimension, name, severity }` |
| `analysis-complete` | 分析完成时 | `{ gaps, recommendations }` |
| `recommendation-added` | 注册能力时 | `{ dimension, name }` |

---

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `maxRecommendations` | 20 | 最大推荐数量 |
| `severityThreshold` | 'low' | 最低严重程度阈值（只返回此级别及以上的推荐） |
| `autoPrioritize` | true | 是否自动按严重程度排序推荐 |
| `historySize` | 100 | 分析历史最大条目数 |