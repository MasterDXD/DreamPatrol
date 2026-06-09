---
component_id: session-start-hook
skill_id: session-start-hook
name: 会话启动Hook
type: infrastructure
infrastructure: true
phase: infrastructure
enforcement: strict
priority: 0
auto_trigger: true
depends_on: [skill-router]
applicable_agents: [team-lead, domain-analyst, task-worker, quality-assurance, devops-engineer, technical-writer]
verified: true
stability: stable
trigger: session_start
version: 1.0.0
production_validated: true
---

# SessionStart Hook自动注入

## 概述
在每次AI对话会话开始时，自动注入核心规则和Skill路由指令，确保Agent从第一刻起就遵循框架规范，无需用户手动指定。

## 注入时机
- AI编辑器打开项目并开始新对话时
- 上下文窗口重置后重新加载时
- 用户输入第一条消息时

## 注入内容

### 第一层：核心身份声明
```
你是Harness Engineering多Agent框架的执行引擎。你拥有17个专业技能（Skills），
它们是强制性的工作流程，不是可选建议。在执行任何任务前，必须检查是否有相关技能应该被激活。

核心原则：
1. 分层分责：根据任务性质切换到对应Agent角色
2. 文档驱动：所有决策和交付物以文档形式记录
3. 流程管控：严格遵循六阶段执行流程
4. 容错自愈：失败时自动重试、降级、恢复
5. TDD强制：先写测试后写代码，无例外
6. 证据验证：声称完成必须提供实际证据
```

### 第二层：Skill路由指令
（完整内容见 skill-router.md 的"路由指令"部分）

### 第三层：当前项目上下文
```
项目名称：{从config.json读取}
项目版本：{从config.json读取}
当前阶段：{从sessions/读取或默认为requirement-analysis}
已完成Skill：{从sessions/读取}
活跃Agent：{根据当前任务推断}
```

### 第四层：快速参考
```
常用指令：
- "开始新项目" → 激活 brainstorming → requirement-analysis → architecture-design
- "实现XXX功能" → 激活 tdd-implement → module-development
- "修复XXX问题" → 激活 systematic-debugging → bug-fix
- "审查代码" → 激活 code-review
- "部署上线" → 激活 verification-before-completion → deployment
- "并行开发" → 激活 dispatching-parallel

Agent角色切换：
- 项目管理 → Team Lead
- 设计审核 → Domain Analyst
- 编码实现 → Task Worker
- 质量检查 → Quality Assurance
- 部署运维 → DevOps Engineer
- 文档编写 → Technical Writer
```

## 注入方式

### Claude Code
通过CLAUDE.md的@include指令自动加载。SessionStart时Claude Code自动读取CLAUDE.md。

### Trae
通过.trae/rules/project_rules.md自动加载。Trae在会话开始时自动读取项目规则。

### Cursor
通过.cursor/rules/harness-engineering.mdc自动加载。Cursor在会话开始时自动读取规则文件。

### GitHub Copilot
通过.github/copilot-instructions.md自动加载。Copilot在会话开始时自动读取指令文件。

### Windsurf
通过.windsurfrules自动加载。Windsurf在会话开始时自动读取规则文件。

## 上下文优化策略
为避免注入内容过长占用Token预算：
1. **分层加载**：核心身份声明始终注入；Skill路由指令按需加载当前阶段相关的Skill
2. **摘要替代**：非当前阶段的Skill仅注入名称和触发条件，不注入完整步骤
3. **渐进展开**：当Skill被激活时，才加载其完整内容
4. **压缩回收**：已完成Skill的详细步骤从上下文中移除，仅保留完成状态

## 验证机制
注入后，通过以下方式验证注入是否生效：
- 用户首次提问时，Agent应自动识别并激活相关Skill
- Agent应按照五阶段流程和TDD门禁执行任务
- Agent在声称完成前应执行verification-before-completion检查

## 令牌消耗自动记录

### 问题
当使用Trae等AI编辑器进行对话时，LLM API的token消耗不会自动记录到框架的SessionManager/TokenManager中，导致Dashboard显示的令牌使用率始终为0。

### 原因
Harness是多Agent编排框架，不直接调用LLM API。实际的LLM调用由Trae/Claude Code/Cursor等宿主编辑器完成，框架无法自动获取API响应中的token使用量。

### 解决方案
在对话过程中，Agent应主动记录token消耗。以下是必须遵循的规则：

#### 规则1：每次对话轮次结束后记录token
当你在一次对话轮次中完成了任务（包括编码、搜索、分析等），你应该估算并记录本次轮次的token消耗：

```
POST http://localhost:{port}/api/token/record
Content-Type: application/json

{
  "sessionId": "当前会话ID",
  "tokens": 估算的总token数,
  "inputTokens": 估算的输入token数,
  "outputTokens": 估算的输出token数,
  "toolCallTokens": 估算的工具调用token数
}
```

#### 规则2：Token估算方法
由于无法精确获取API返回的token数，使用以下估算方法：
- **输入token**：约等于输入文本字符数 / 4（英文）或字符数 / 2（中文）
- **输出token**：约等于输出文本字符数 / 4（英文）或字符数 / 2（中文）
- **工具调用token**：每次工具调用约估算为 200-500 token（包括参数和返回值）

#### 规则3：记录时机
- 每完成一个Skill执行后
- 每完成一个任务批次后
- 会话结束前（shutdown时自动触发）

#### 规则4：预算检查
记录token后，检查返回的budgetStatus：
- warning80=true：继续执行但减少上下文加载
- warning95=true：切换到低成本模式，仅执行必要任务
- exhausted=true：停止执行，等待用户确认

### Trae编辑器集成
Trae通过.trae/rules/project_rules.md加载此规则。当Trae对话时，Agent应：
1. 在会话开始时创建或恢复session
2. 在每次对话轮次结束后调用 /api/token/record
3. 根据预算状态调整执行策略

## 验收标准
- [ ] 会话启动时核心规则自动注入
- [ ] Skill路由指令按需加载
- [ ] 项目上下文正确读取
- [ ] Token消耗记录机制可用

## 常见问题
- **Q: 注入内容占用太多Token？**
  A: 分层加载策略自动处理：核心身份始终注入，Skill路由按需加载，非当前阶段仅注入摘要
- **Q: Token消耗记录不准确？**
  A: 使用估算方法（英文/4，中文/2），每次工具调用约200-500 token
