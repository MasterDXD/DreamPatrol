---
skill_id: cloud-ai-blueprint
name: AI系统蓝图规划
applicable_agents: [domain-analyst, task-worker]
trigger: 需要规划AI系统架构或集成AI能力时
auto_trigger: true
phase: architecture-design
priority: 2
trigger_conditions:
  - user mentions "AI系统" or "AI架构" or "AI blueprint"
  - user asks to integrate AI capabilities
  - project involves model/tool/dataflow/workflow planning
  - user wants to build AI-powered features
depends_on: [architecture-design]
blocks: [module-development]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: true
causal_outputs:
  - name: ai-blueprint-document
    description: AI系统蓝图文档（4层架构定义）
evidence_types:
  required:
    - architecture_document
    - ai_blueprint_document
enforcement: recommended
tools: [model-selector, mcp-client, embedding-service]
verified: true
stability: stable
---

## 目标

在编写任何AI代码之前规划4层架构（模型层→工具层→数据流层→工作流层），确保AI系统架构清晰、安全边界明确、成本预算可控，避免跳过蓝图规划直接编码导致的返工和系统脆弱。

# AI系统蓝图规划

## 核心原则
AI系统不是聊天框。在编写任何AI代码之前，必须先规划4层架构：模型层→工具层→数据流层→工作流层。跳过蓝图规划直接编码，将导致返工和系统脆弱。

## 四层架构模型（源自Microsoft Foundry Skill）

### 第一层：模型层（Model Layer）
定义系统使用的AI模型及其职责分工：

```markdown
| 模型角色 | 推荐模型 | 用途 | 备选模型 |
|---------|---------|------|---------|
| 推理引擎 | gpt-4o | 复杂推理、规划、代码生成 | claude-3-opus, deepseek-v3 |
| 执行引擎 | gpt-4o-mini | 简单任务、快速响应 | gpt-3.5-turbo |
| 嵌入引擎 | text-embedding-3 | 文本向量化、语义搜索 | local-128d |
| 专用引擎 | 按需选择 | 图像/音频/代码等专用任务 | 按需配置 |
```

决策规则：
- 推理深度 >= 0.7 → 使用premium模型
- 推理深度 0.3-0.7 → 使用standard模型
- 推理深度 < 0.3 → 使用economy模型
- 始终配置降级链：premium → standard → economy

### 第二层：工具层（Tool Layer）
定义AI可调用的工具和能力边界：

```markdown
| 工具名称 | 类型 | 能力 | 安全级别 |
|---------|------|------|---------|
| 文件系统 | MCP | 读写项目文件 | 受限（项目根目录内） |
| 知识图谱 | MCP | 长期记忆存取 | 只读优先 |
| 顺序思维 | MCP | 复杂推理辅助 | 无限制 |
| HTTP请求 | MCP | 外部API调用 | SSRF防护 |
| 浏览器 | MCP | 页面自动化 | 受限（白名单域名） |
```

安全规则：
- 每个工具必须声明安全级别（无限制/受限/只读/禁止）
- 危险操作（文件删除/系统命令/生产部署）需人工确认
- 环境变量过滤：禁止泄露AWS_/GOOGLE_/AZURE_等敏感键

### 第三层：数据流层（Dataflow Layer）
定义数据在系统中的流转路径：

```markdown
输入源 → 预处理 → 模型调用 → 后处理 → 输出
  │         │         │         │        │
  ▼         ▼         ▼         ▼        ▼
用户请求  意图解析  模型路由  结果验证  格式化输出
MCP事件   上下文注入  Token预算  证据验证  因果发布
API调用   参数校验   降级策略   质量评分   审计记录
```

数据流规则：
- 每个数据流必须定义输入验证和输出验证
- 模型调用前必须检查Token预算
- 数据流转必须通过因果数据总线发布事件
- 敏感数据必须加密存储，禁止日志泄露

### 第四层：工作流层（Workflow Layer）
定义AI系统的执行流程和状态转换：

```markdown
工作流类型：
- 顺序管道（Pipeline）：多步骤顺序执行，条件分支
- 目标驱动（Goal）：自主迭代收敛，自动分解子任务
- 协作模式（Collaboration）：solo/pair/chain/ensemble/deepening
- DAG工作流（WorkflowDag）：有向无环图，依赖解析
```

工作流规则：
- 多步骤任务必须声明验证计划
- 每步完成后必须验证再进入下一步
- 失败必须快速暴露，不允许静默绕过
- 协作模式由CollaborationModeRouter自动路由

## 蓝图文档模板

```markdown
# AI系统蓝图

## 1. 系统概述
- 系统名称：
- 核心目标：
- 成功标准（强/弱）：

## 2. 模型层
| 角色 | 模型 | 用途 | 降级链 |
|------|------|------|--------|

## 3. 工具层
| 工具 | 类型 | 能力 | 安全级别 |
|------|------|------|---------|

## 4. 数据流层
输入源 → 预处理 → 模型调用 → 后处理 → 输出
[具体数据流描述]

## 5. 工作流层
- 工作流类型：
- 状态转换图：
- 验证计划：
  1. [步骤] → 验证: [检查]
  2. [步骤] → 验证: [检查]

## 6. 安全边界
- 禁止操作：
- 需确认操作：
- 数据隔离要求：

## 7. 成本预算
- Token预算分配：
- 模型调用成本估算：
- 降级策略触发条件：
```

## 执行步骤
1. 确认AI系统的核心目标和成功标准
2. 规划模型层（角色分工+降级链）
3. 规划工具层（能力边界+安全级别）
4. 规划数据流层（流转路径+验证节点）
5. 规划工作流层（执行模式+状态转换）
6. 定义安全边界和成本预算
7. 输出AI蓝图文档
8. 通过necessity-review验证蓝图必要性

## 验收标准
- 4层架构均有明确定义
- 每个模型角色有降级链
- 每个工具有安全级别声明
- 数据流有输入/输出验证
- 工作流有验证计划
- 安全边界明确
- 成本预算合理

## 阻塞规则
- 未完成蓝图规划不得进入module-development阶段
- 模型层缺少降级链阻塞实现
- 工具层缺少安全级别声明阻塞实现

## FAQ

- **Q: 什么时候必须使用蓝图规划？** A: 在编写任何AI代码之前，需要明确4层架构（模型层→工具层→数据流层→工作流层）。
- **Q: 蓝图规划与架构设计有何区别？** A: 蓝图规划专注于AI系统的4层架构定义，是架构设计的AI特化版，关注模型降级链、工具安全边界和成本预算。
- **Q: 蓝图规划需要多长时间？** A: 取决于系统复杂度，通常30分钟到2小时，但能避免架构级返工。
