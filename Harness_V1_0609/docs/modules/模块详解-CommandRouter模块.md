# 模块详解-CommandRouter模块

## 概述

CommandRouter 负责自动发现、解析和路由斜杠命令，支持别名、中文命令和模糊匹配。它是用户与框架交互的快捷入口，将命令映射到对应的 Skill 执行链。

## 模块位置

`src/runtime/workflow/command-router.js`

## 核心职责

1. **命令发现**：自动扫描 `.harness/commands/` 目录下的命令定义
2. **命令解析**：识别用户输入中的斜杠命令并提取参数
3. **执行计划生成**：将命令映射为 Skill 执行序列
4. **别名支持**：支持命令别名和中文命令

## 命令定义格式

命令定义文件存放于`.harness/commands/`目录，采用Markdown + YAML frontmatter格式：

```markdown
---
command_id: /plan
name: 规划
description: 头脑风暴→需求分析→架构设计
skills:
  - brainstorming
  - requirement-analysis
  - architecture-design
agent: Analyst
phase: requirement-analysis
aliases:
  - /规划
  - /p
enforcement: recommended
---

## 指令内容

在此编写命令被触发后注入的指令正文...
```

### YAML Frontmatter字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `command_id` | string | **是** | — | 命令唯一标识，如`/plan`，无frontmatter或无此字段的文件被跳过 |
| `name` | string | 否 | command_id | 命令显示名称 |
| `description` | string | 否 | `''` | 命令简要描述 |
| `skills` | string/string[] | 否 | `[]` | 触发的技能链，支持逗号分隔字符串或数组 |
| `agent` | string | 否 | `''` | 适用Agent角色 |
| `phase` | string | 否 | `''` | 所属执行阶段 |
| `aliases` | string/string[] | 否 | `[]` | 命令别名列表，支持中文 |
| `enforcement` | string | 否 | `'recommended'` | 执行级别：strict/recommended/optional |

## 关键 API

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `discover()` | 扫描命令定义目录 | `Array` (命令数组) |
| `discoverAsync()` | 异步命令发现 | `Promise<Array>` |
| `isCommand(input)` | 判断输入是否为命令 | `boolean` |
| `resolve(input)` | 命令解析（核心方法） | `{ commandId, name, skills, options }` |
| `executeCommand(commandId, context)` | 执行指定命令 | `Promise<object>` |
| `getExecutionPlan(input)` | 获取命令执行计划 | `{ commandId, name, skills }` |
| `getCommand(commandId)` | 获取命令定义 | `object` |
| `listCommands()` | 列出所有命令 | `array` |
| `getExecutionHistory(limit)` | 获取执行历史 | `Array<object>` |
| `getHelpText(useColor)` | 获取帮助文本 | `string` |
| `complete(partial)` | Tab补全 | `Array<string>` |
| `fuzzyMatch(input)` | 模糊匹配（需显式调用） | `Array<{commandId, score}>` |
| `getStats()` | 统计信息 | `object` |
| `setCausalBus(bus)` | 设置因果数据总线 | `void` |

## 内置命令

| 命令 | 别名 | Skill 链 |
|------|------|---------|
| `/plan` | 规划, 计划 | brainstorming → requirement-analysis → architecture-design |
| `/code-review` | 代码审查 | code-review |
| `/security-review` | 安全审查 | security-audit |
| `/debug` | 调试 | systematic-debugging → bug-fix |
| `/fix` | 修复 | bug-fix → verification-before-completion |
| `/deploy` | 部署 | verification-before-completion → deployment |
| `/test` | 测试 | integration-testing |
| `/refactor` | 重构 | refactor-code |
| `/prompt` | 提示词 | ai-prompting |
| `/audit` | 审计 | security-audit |
| `/build` | 构建 | tdd-implement → module-development |
| `/code-simplify` | 代码简化 | refactor-code |
| `/goal` | 目标 | iterative-deepening → brainstorming → requirement-analysis |
| `/learn` | 学习 | iterative-deepening |
| `/optimize` | 优化 | optimization-loop |
| `/review` | 审查 | code-review → security-audit |
| `/section` | 界面 | ui-skills → design-md |
| `/ship` | 发布 | verification-before-completion → deployment |
| `/spec` | 规格 | requirement-analysis → architecture-design |
| `/startup` | 创业 | brainstorming → idea-validation → requirement-analysis → architecture-design → mvp-builder → deployment → ai-native-scaling |
| `/decide` | 决策 | decision-loop |
| `/web` | 网页 | web-interaction |
| `/cli` | 命令行 | cli-anything |
| `/research` | 调研 | ai-research → source-driven-development |

## 匹配算法

主匹配流程（`resolve()` / `isCommand()` 使用）：
1. **精确匹配**：输入完全等于命令 ID 或名称
2. **别名匹配**：输入匹配任一别名
3. **斜杠前缀正则提取**：输入以 `/` 开头，正则 `/(\/[\w-]+)/` 提取首个 `/word` 片段后匹配

模糊匹配（需显式调用 `fuzzyMatch()`）：
- 先调用 `resolve()`，若返回非空则直接使用；否则进入模糊评分
- 输入和命令ID/名称均做归一化处理：`toLowerCase().replace(/[/\s-]/g, '')`
- 对每个命令计算匹配分数，取最高分且≥0.5的命令返回

| 匹配方式 | 分数 | 说明 |
|---------|------|------|
| 命令ID包含输入 | **0.9** | 最高置信度，ID是最精确的标识 |
| 命令名称包含输入 | **0.7** | 名称匹配次之 |
| 部分字符匹配 | `(匹配字符数/输入长度) × 0.5` | 逐字符在ID中顺序查找，按比例×0.5倍率 |
| 最低阈值 | **0.5** | 低于此分数的匹配被丢弃 |

- 不属于自动匹配流程，仅在用户主动调用时执行

## 相关模块

- [模块详解-SkillRouter模块](模块详解-SkillRouter模块.md) — Skill 路由
- [深度拆解-事件驱动架构与消息流转](../deep-dive/深度拆解-事件驱动架构与消息流转.md) — 命令执行事件流
