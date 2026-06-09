---
component_id: skill-router
skill_id: skill-router
name: Skill路由引擎
type: infrastructure
infrastructure: true
phase: infrastructure
trigger: skill_discovery
enforcement: strict
priority: 0
auto_trigger: true
depends_on: []
applicable_agents: [team-lead, domain-analyst, task-worker, quality-assurance, devops-engineer, technical-writer]
verified: true
stability: stable
version: 1.0.0
production_validated: true
---

# Skill自动发现与路由引擎

## 概述
本引擎负责在每次任务执行前，自动扫描所有可用Skill，根据当前上下文匹配最合适的Skill并激活执行。Agent无需手动指定Skill，引擎根据任务上下文自动路由。

## 工作机制

### 1. Skill发现（Discovery）
在会话开始时，扫描 `.harness/skills/` 目录下所有 `.md` 文件，解析YAML Frontmatter，构建Skill注册表。

**Skill注册表结构**：
```
skill_registry = {
  "brainstorming": {
    skill_id: "brainstorming",
    name: "头脑风暴",
    applicable_agents: ["domain-analyst", "team-lead"],
    auto_trigger: true,
    phase: "requirement-analysis",
    priority: 0,
    trigger_conditions: [...],
    depends_on: [],
    blocks: ["requirement-analysis"]
  },
  ...
}
```

### 2. 上下文分析（Context Analysis）
接收任务上下文，提取关键信号用于Skill匹配：
- **用户意图**：用户消息中的关键词和语义
- **当前阶段**：项目所处的六阶段流程位置
- **已完成Skill**：已执行的Skill列表（用于依赖检查）
- **Agent角色**：当前活跃的Agent角色（用于权限过滤）

### 3. Skill匹配（Matching）
按以下优先级顺序匹配Skill：

**优先级1：显式请求**
用户明确提到Skill名称或功能关键词时，直接激活对应Skill。
- 匹配规则：用户消息包含trigger_conditions中的关键词
- 示例：用户说"帮我做需求分析" → 激活 requirement-analysis

**优先级2：流程驱动**
前序Skill完成，后继Skill的depends_on条件满足时，自动激活。
- 匹配规则：已完成的Skill集合 ⊇ 待激活Skill的depends_on
- 示例：architecture-design完成 → 自动激活 tdd-implement

**优先级3：上下文推断**
根据当前任务上下文推断最可能需要的Skill。
- 匹配规则：当前阶段 + Agent角色 + 任务描述 → 最佳匹配Skill
- 示例：在module-development阶段，Task Worker遇到Bug → 激活 systematic-debugging

### 4. 冲突解决（Conflict Resolution）
当多个Skill同时匹配时：
1. 按phase排序：当前阶段的Skill优先
2. 按priority排序：同阶段内priority数字小的优先
3. 按depends_on排序：依赖已满足的优先
4. 询问用户：仍无法决定时，列出候选Skill让用户选择

### 5. 执行调度（Execution）
激活Skill后：
1. 加载Skill的完整内容到上下文
2. 检查depends_on是否全部满足
3. 检查当前Agent是否有权限执行（applicable_agents）
4. 执行Skill的步骤
5. 完成后更新已完成Skill列表
6. 检查是否有后继Skill需要自动激活

## Skill依赖图

```
brainstorming (phase: requirement-analysis, priority: 0)
    ↓
requirement-analysis (phase: requirement-analysis, priority: 1)
    ↓
architecture-design (phase: architecture-design, priority: 2)
    ↓
tdd-implement (phase: module-development, priority: 3)
dispatching-parallel (phase: module-development, priority: 3)
    ↓
module-development (phase: module-development, priority: 3) [TDD门禁]
    ↓
code-review (phase: module-development, priority: 4)
verification-before-completion (phase: module-development, priority: 4)
bug-fix (phase: module-development, priority: 4)
systematic-debugging (phase: module-development, priority: 4)
    ↓
security-audit (phase: module-development, priority: 5)
performance-optimization (phase: module-development, priority: 5)
refactor-code (phase: module-development, priority: 5)
    ↓
integration-testing (phase: integration-testing, priority: 6)
    ↓
deployment (phase: deployment, priority: 7)
documentation (phase: deployment, priority: 7)
```

## 路由指令
在会话开始时，通过SessionStart Hook注入以下路由指令：

```
你拥有以下技能（Skills），它们是强制性的工作流程，不是可选建议。
在执行任何任务前，检查是否有相关技能应该被激活。
技能会根据上下文自动触发，你不需要手动选择。

技能发现规则：
1. 收到新任务时，扫描所有技能的trigger_conditions
2. 如果任务匹配某个技能的触发条件，必须按该技能的步骤执行
3. 如果前序技能刚完成，检查是否有后继技能需要激活
4. 如果不确定激活哪个技能，按阶段和优先级排序选择

当前可用技能列表：
- brainstorming: 头脑风暴（需求探索阶段）
- requirement-analysis: 需求分析（需求分析阶段）
- architecture-design: 架构设计（架构设计阶段）
- tdd-implement: TDD驱动开发（开发阶段，强制测试先行）
- module-development: 模块开发（开发阶段，TDD门禁）
- code-review: 代码审查（开发阶段）
- verification-before-completion: 完成前验证（开发阶段，强制证据）
- systematic-debugging: 系统化调试（开发阶段）
- bug-fix: 缺陷修复（开发阶段）
- security-audit: 安全审计（开发阶段）
- performance-optimization: 性能优化（开发阶段）
- refactor-code: 系统化重构（开发阶段）
- dispatching-parallel: 并行子代理调度（开发阶段）
- integration-testing: 集成测试（测试阶段）
- deployment: 部署上线（部署阶段）
- documentation: 文档编写（部署阶段）
- writing-skills: 技能编写（扩展用）
```

## 注意事项
- auto_trigger为false的Skill不会自动激活，需要用户显式请求
- enforcement为strict的Skill（如tdd-implement、verification-before-completion）不可跳过
- Skill路由应避免循环依赖（A depends on B, B depends on A）
- 同一阶段内，priority数字越小的Skill越先执行
