# 模块详解 — CLI与脚本

> 源码路径：项目根目录及 `scripts/`
> 核心文件：harness-cli.js / api-check.js / version.js / verify-api-docs.js / recover-changelog.js

---

## 模块概述

CLI与脚本模块群是框架的命令行入口和辅助工具集，提供框架验证、API检查、版本管理、文档校验和变更日志恢复等能力。这些脚本位于项目根目录和 `scripts/` 目录下，是开发者与框架交互的命令行界面。

### 模块清单

| 模块 | 源文件 | 说明 |
|------|--------|------|
| harness-cli | harness-cli.js | 框架CLI入口，提供validate/commands/skills/dashboard等子命令 |
| api-check | scripts/api-check.js | API端点可用性检查工具 |
| version | scripts/version.js | 版本号提取与CHANGELOG解析 |
| verify-api-docs | scripts/verify-api-docs.js | API文档与实际端点一致性校验 |
| recover-changelog | scripts/recover-changelog.js | 变更日志损坏恢复工具 |

---

## harness-cli.js 详解

### 职责概述

框架CLI入口，提供多个子命令用于框架验证、状态查询和Dashboard启动。支持 `validate`、`commands`、`skills`、`dashboard`、`memory-verify`、`antipattern-detect` 等子命令。

### 子命令

| 命令 | 说明 |
|------|------|
| `validate` | 框架一致性检查 + 测试 |
| `commands` | 列出所有24个斜杠命令 |
| `skills` | 列出所有84个技能及验证状态 |
| `memory-verify` | 验证记忆-代码一致性 |
| `antipattern-detect` | 运行反模式检测 |
| `dashboard` | 启动监控仪表盘（默认端口3210） |
| `dashboard --open` | 启动并自动打开浏览器 |
| `dashboard --port <number>` | 指定端口启动 |

---

## api-check.js 详解

### 职责概述

API端点可用性检查工具，向Dashboard服务器发送HTTP请求验证各API端点的响应状态和内容格式。

---

## version.js 详解

### 职责概述

版本号提取与CHANGELOG解析工具，从 `package.json` 和 `CHANGELOG.md` 中提取版本信息，供CLI和Dashboard使用。

---

## verify-api-docs.js 详解

### 职责概述

API文档与实际端点一致性校验工具，比对文档中记录的API端点与服务器实际注册的端点，检测文档缺失或过时。

---

## recover-changelog.js 详解

### 职责概述

变更日志损坏恢复工具，当 `CHANGELOG.md` 文件损坏或格式异常时，尝试从归档数据中恢复变更记录。

---

## 交叉引用

- [[模块详解-Web子系统]] — Dashboard服务器，CLI的dashboard子命令启动目标
- [[模块详解-Web仪表盘系统]] — Web仪表盘系统整体架构
- [[工具详解-工具层模块群]] — 工具层辅助模块

---

## Round 10 缺陷修复记录

> 本轮修复涉及CLI与脚本模块群中5个文件的关键缺陷，涵盖配置修正、类型安全、竞态条件和错误处理。

### harness-cli.js — token_budget修正、config set嵌套键类型检查、quickstart信息更新、FRAMEWORK_VERSION动态读取

**缺陷1**：`token_budget` 配置项默认值为100万（1,000,000），与项目规则中定义的10亿（1,000,000,000）不一致，导致CLI显示的Token预算与实际配置不符。

**修复1**：`token_budget` 默认值修正为1,000,000,000（10亿），与项目规则保持一致。

**缺陷2**：`config set` 子命令在设置嵌套键（如 `model.temperature`）时，未对值进行类型检查，字符串 `"3"` 被直接写入配置而非数值 `3`，导致下游期望数值的模块行为异常。

**修复2**：`config set` 新增嵌套键类型检查，自动将数值字符串转换为数值类型，确保配置值类型与预期一致。

**缺陷3**：`quickstart` 子命令显示的框架信息为旧版数据（如"25 Agents/66 Skills"），与当前版本（28 Agents/80 Skills）不符。

**修复3**：quickstart信息更新为当前版本数据（28 Agents/80 Skills），与项目规则保持同步。

**缺陷4**：`FRAMEWORK_VERSION` 常量硬编码在CLI文件中，版本更新时需手动同步，容易遗漏导致版本号不一致。

**修复4**：`FRAMEWORK_VERSION` 改为动态读取 `package.json` 的 `version` 字段，确保版本号始终与包版本一致。

**影响范围**：Token预算显示与配置一致；嵌套键配置值类型正确；quickstart信息与当前版本同步；版本号自动跟随package.json更新。

### api-check.js — 超时竞态条件修复

**缺陷**：API检查工具在发送HTTP请求时，超时定时器和HTTP响应回调之间存在竞态条件。当HTTP响应在超时定时器触发后到达时，响应回调仍被执行，导致超时后的响应数据被错误处理（如写入已关闭的流或触发重复回调）。

**修复**：新增竞态条件防护，超时触发后设置标志位，HTTP响应回调检查标志位，若已超时则忽略响应，确保超时和响应互斥处理。

**影响范围**：API检查在超时场景下不再产生重复回调或错误处理，竞态条件被消除。

### version.js — CHANGELOG.md不存在处理与版本提取null防护

**缺陷1**：`getVersion()` 方法在 `CHANGELOG.md` 文件不存在时，直接抛出未捕获的文件系统异常，导致CLI命令执行中断。

**修复1**：新增文件存在性检查，`CHANGELOG.md` 不存在时返回默认版本号（从 `package.json` 读取），而非抛出异常。

**缺陷2**：版本号提取正则匹配结果未进行null检查，当CHANGELOG内容格式异常（无版本号行）时，访问匹配结果的索引抛出TypeError。

**修复2**：正则匹配结果新增null防护，匹配失败时回退到 `package.json` 版本号，确保版本提取始终返回有效值。

**影响范围**：CHANGELOG文件缺失或格式异常时CLI不再崩溃，版本信息始终可获取。

### verify-api-docs.js — 错误处理

**缺陷**：文档校验工具在处理API端点时，未捕获文件读取和解析异常，单个端点校验失败导致整个校验流程中断，无法获取完整的校验报告。

**修复**：为每个端点的校验逻辑添加try-catch错误处理，单个端点校验失败时记录错误并继续校验后续端点，最终在报告中汇总所有失败项。

**影响范围**：文档校验在单个端点异常时不再整体中断，可获取完整的校验报告。

### recover-changelog.js — 删除未使用导入

**缺陷**：文件顶部包含未使用的模块导入（如 `fs` 的 `promises` 命名空间），增加不必要的模块加载开销，且可能误导代码阅读者认为该模块被使用。

**修复**：移除所有未使用的导入语句，保持代码整洁。

**影响范围**：代码更整洁，模块加载开销略微降低。
