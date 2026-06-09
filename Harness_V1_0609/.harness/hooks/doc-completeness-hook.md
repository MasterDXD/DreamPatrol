---
hook_id: doc-completeness-hook
name: 文档完整性门禁Hook
type: gate
phase: development
enforcement: strict
priority: 10
auto_trigger: true
depends_on: [brainstorming, requirement-analysis, architecture-design]
applicable_agents: [task-worker, domain-analyst, team-lead]
trigger: before_skill
trigger_skills: [tdd-implement, module-development]
version: 1.0.0
---

# 文档完整性门禁Hook

## 概述
在进入模块开发阶段（tdd-implement / module-development）之前，强制检查需求规格说明书和架构设计文档是否已存在。防止AI跳过文档阶段直接编码。

## 触发条件
- **触发时机**：tdd-implement 或 module-development 技能执行前
- **检查对象**：docs/ 目录下的文档文件

## 检查规则

### 1. 需求规格说明书检查
- **规则ID**：requirement-spec-exists
- **级别**：ERROR
- **检查方式**：扫描 docs/ 目录，查找文件名匹配 `*需求*` 或 `*requirement*` 的文档
- **失败动作**：阻止开发阶段启动，提示"需求规格说明书缺失，请先完成 brainstorming 和 requirement-analysis 技能"

### 2. 架构设计文档检查
- **规则ID**：architecture-doc-exists
- **级别**：ERROR
- **检查方式**：扫描 docs/ 目录，查找文件名匹配 `*架构*` 或 `*architecture*` 的文档
- **失败动作**：阻止开发阶段启动，提示"架构设计文档缺失，请先完成 architecture-design 技能"

### 3. 无规格代码警告
- **规则ID**：no-code-without-spec
- **级别**：WARN
- **检查方式**：当 src/ 目录存在代码文件但文档不完整时触发
- **失败动作**：发出警告，建议补充文档

## 执行流程

```
1. Agent 请求执行 tdd-implement 或 module-development
2. Hook 触发文档完整性检查
3. 扫描 docs/ 目录：
   a. 查找需求规格说明书 → 存在？继续：阻止 + 提示
   b. 查找架构设计文档 → 存在？继续：阻止 + 提示
4. 所有检查通过 → 允许技能执行
5. 任一 ERROR 级别检查失败 → 阻止执行，返回缺失文档列表
```

## 强制执行模式

| 模式 | 行为 |
|------|------|
| strict | 缺失文档时完全阻止开发技能执行 |
| recommended | 缺失文档时发出警告但允许继续 |
| optional | 仅记录日志，不干预执行 |

默认使用 **strict** 模式，确保文档驱动开发不被跳过。

## 与 PhaseOrchestrator 集成

本 Hook 与 PhaseOrchestrator 的 spec gate 机制协同工作：
- PhaseOrchestrator 在构造时注册 `development` 阶段的 spec 要求：`requirement-spec` 和 `architecture-doc`
- 当 `markSpecVerified('development', 'requirement-spec')` 和 `markSpecVerified('development', 'architecture-doc')` 均被调用后，开发阶段才能启动
- 本 Hook 在技能执行前做额外的文件系统级验证，作为双重保障

## 与 FrameworkComplianceChecker 集成

FrameworkComplianceChecker 的 `checkDocCompleteness()` 方法提供程序化的文档完整性检查：
- 扫描 docs/ 目录查找需求规格和架构文档
- 当 src/ 存在代码但文档缺失时生成违规记录
- 可通过 `checkProject()` 或独立调用 `checkDocCompleteness()` 触发
