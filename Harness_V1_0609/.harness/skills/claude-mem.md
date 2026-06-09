---
skill_id: claude-mem
name: 对话记忆持久化与会话恢复
phase: module-development
priority: 2
enforcement: optional
applicable_agents: [task-worker, domain-analyst]
auto_trigger: true
slash_command: /memory
tool_references: [conversation-context-store, session-resumption-protocol]
trigger: auto
trigger_conditions: []
verified: true
stability: beta
---

## 目标

实现LLM对话上下文的持久化存储、智能压缩与会话恢复，通过5-Hook架构和3层渐进搜索，确保Agent跨会话保持上下文连续性。

## 步骤

1. 会话启动时加载上一会话摘要并注入恢复上下文
2. 每次用户交互记录轮次并触发3层渐进搜索检索相关记忆
3. 工具调用后提取关键信息存储为结构化记忆
4. 上下文接近Token阈值时触发压缩工作流
5. 会话结束时生成摘要并持久化所有数据

# claude-mem — 对话记忆持久化与会话恢复

## 概述

本技能实现LLM对话上下文的持久化存储、智能压缩与会话恢复，灵感源自Claude-mem的5-Hook架构，适配Harness多Agent框架的ConversationContextStore和SessionResumptionProtocol原生组件。当Agent需要跨会话保持上下文连续性时自动触发。

## 5-Hook架构

Claude-mem的核心是5个生命周期Hook，在Harness中映射为ConversationContextStore的事件驱动机制：

### 1. SessionStart（会话启动）
- **触发时机**：新会话创建时
- **Harness映射**：`ConversationContextStore.startSession()` → `session-started`事件
- **行为**：从持久化存储加载上一会话摘要，通过SessionResumptionProtocol构建恢复上下文，注入为系统轮次
- **数据流**：SqliteStore/JSON → ConversationContextStore → SessionResumptionProtocol.buildResumptionContext()

### 2. UserPromptSubmit（用户提交提示）
- **触发时机**：用户消息记录时
- **Harness映射**：`ConversationContextStore.recordTurn({ role: 'user' })` → `turn-recorded`事件
- **行为**：记录用户输入，触发3层渐进搜索检索相关历史记忆，将检索结果附加到上下文
- **数据流**：用户输入 → recordTurn → MemoryStore/BrainMemory检索 → 上下文增强

### 3. PostToolUse（工具调用后）
- **触发时机**：工具调用结果记录时
- **Harness映射**：`ConversationContextStore.recordTurn({ role: 'tool' })` → `turn-recorded`事件
- **行为**：提取工具调用中的关键信息（文件路径、命令结果、错误信息），存储为结构化记忆条目
- **数据流**：工具结果 → recordTurn → 关键信息提取 → MemoryStore写入

### 4. Stop（会话暂停/压缩）
- **触发时机**：上下文接近Token阈值时
- **Harness映射**：`ConversationContextStore.compressSession()` → `session-compressed`事件
- **行为**：触发压缩工作流，将早期轮次摘要化，保留近期轮次完整内容
- **数据流**：Token阈值检测 → compressSession → 摘要生成 → 轮次替换

### 5. SessionEnd（会话结束）
- **触发时机**：会话关闭时
- **Harness映射**：`ConversationContextStore.endSession()` → `session-ended`事件
- **行为**：生成会话摘要，持久化所有未保存数据，更新MemoryStore中的长期记忆
- **数据流**：endSession → 摘要生成 → 双持久化写入 → MemoryStore更新

## 3层渐进搜索

记忆检索采用3层渐进策略，从精确到模糊逐层扩大搜索范围：

### 第1层：精确匹配（Exact Match）
- **搜索范围**：当前会话的最近N轮对话
- **匹配策略**：关键词精确匹配
- **适用场景**：用户引用了之前对话中的具体内容
- **Token预算**：总检索预算的20%

### 第2层：语义相似（Semantic Similarity）
- **搜索范围**：MemoryStore + BrainMemory的索引记忆
- **匹配策略**：基于嵌入向量的余弦相似度搜索（threshold ≥ 0.3）
- **适用场景**：用户的问题与历史讨论主题相关但措辞不同
- **Token预算**：总检索预算的50%

### 第3层：关联扩散（Association Spread）
- **搜索范围**：DreamEngine的提炼笔记 + LlmWiki的领域知识
- **匹配策略**：从第2层命中的记忆出发，沿知识图谱边扩散1-2跳
- **适用场景**：需要跨领域知识或隐性经验的场景
- **Token预算**：总检索预算的30%

## 双持久化策略

采用SqliteStore主存储 + JSON文件降级的双持久化方案：

### SqliteStore（主存储）
- **条件**：SqliteStore实例可用且数据库连接正常
- **表结构**：conversation_sessions + conversation_turns + FTS5全文索引
- **写入模式**：每轮记录实时写入（INSERT OR REPLACE）
- **读取模式**：会话恢复时批量加载，支持FTS5全文搜索
- **优势**：事务安全、WAL模式并发、FTS5高效检索

### JSON文件降级（Fallback）
- **触发条件**：SqliteStore不可用或数据库连接异常
- **存储路径**：`.harness/conversations/{sessionId}.json`
- **写入模式**：每轮记录追加写入完整JSON文件
- **读取模式**：会话恢复时读取JSON文件反序列化
- **优势**：零依赖、人类可读、便于调试

### 持久化选择逻辑
```
if (this._sqliteStore && this._sqliteStore._db) → SqliteStore路径
else → JSON文件降级路径
```

## 压缩工作流

当会话轮次超过压缩阈值时自动触发：

1. **阈值检测**：`turns.length > COMPRESSION_THRESHOLD`（默认50轮）
2. **轮次分割**：保留最近`threshold/2`轮完整内容，早期轮次标记为待压缩
3. **摘要生成**：对早期轮次提取关键信息生成结构化摘要（≤MAX_SUMMARY_LENGTH字符）
4. **轮次替换**：用一条`role=system, type=compression-summary`的轮次替换所有被压缩的轮次
5. **统计更新**：记录压缩比、Token节省量，更新`totalTokensSaved`统计
6. **事件发射**：`session-compressed`事件通知下游组件

## 会话恢复协议

SessionResumptionProtocol实现完整的会话恢复工作流：

### 恢复流程
1. `buildResumptionContext(options)` — 从4个来源收集上下文：
   - ConversationContextStore（最高优先级）：上一会话摘要和最近轮次
   - SessionManager：会话元数据（阶段、已完成技能、关键决策）
   - MemoryStore/BrainMemory：语义相关的长期记忆
   - DreamEngine：提炼的经验笔记和用户偏好
2. Token估算和截断：ASCII字符/4 + 非ASCII字符/2，超出maxResumptionTokens时按优先级截断
3. `injectResumptionContext(sessionId, context)` — 将恢复上下文注入新会话
4. `resumeSession(sessionId, options)` — 一步完成构建+注入

### 恢复上下文格式
```
[Session Resumption Context]
Previous Session Summary: <上一会话摘要>
Active Tasks: <当前阶段和任务>
Key Decisions: <关键决策列表>
Relevant Knowledge: <相关记忆和知识>
Recent Errors: <最近错误信息>
User Preferences: <用户偏好和习惯>
```

### 优先级排序
当Token预算不足时，按以下优先级截断：
1. Previous Session Summary（最高优先级）
2. Active Tasks
3. Key Decisions
4. Recent Errors
5. Relevant Knowledge
6. User Preferences（最低优先级）

## 安全约束

### 内容过滤
- 所有持久化内容经过sanitizer消毒，过滤XSS和注入攻击向量
- 工具调用结果中的敏感信息（API密钥、密码、Token）自动脱敏
- 日志输出中禁止记录完整对话内容，仅记录摘要和统计信息

### 敏感数据脱敏
- 匹配API密钥模式（`sk-...`、`key-...`、`token-...`）的内容替换为`[REDACTED]`
- 文件路径中的用户主目录替换为`~`
- 数据库连接字符串中的密码部分替换为`***`

### Token预算控制
- 单次恢复上下文最大Token数：`MAX_RESUMPTION_TOKENS = 4000`
- 压缩摘要最大长度：`MAX_SUMMARY_LENGTH = 2000`字符
- 单会话最大轮次数：`MAX_TURNS_PER_SESSION = 1000`
- 最大会话存储数：`MAX_SESSIONS = 100`

## 证据要求

完成本技能执行时，必须提供以下证据：

### context_restored
- **类型**：结构化对象
- **字段**：`{ sessionId, sources: string[], tokenEstimate: number, warnings: string[] }`
- **验证**：sources非空，tokenEstimate ≤ MAX_RESUMPTION_TOKENS

### session_resumed
- **类型**：结构化对象
- **字段**：`{ sessionId, context: string, tokenEstimate: number, sources: string[] }`
- **验证**：context包含`[Session Resumption Context]`头部，sessionId有效

### memory_compressed
- **类型**：结构化对象
- **字段**：`{ sessionId, turnsRemoved: number, turnsKept: number, compressionRatio: number, tokensSaved: number }`
- **验证**：turnsRemoved > 0，compressionRatio ∈ (0, 1]，tokensSaved ≥ 0

## 使用示例

```javascript
const ConversationContextStore = require('./src/runtime/infrastructure/conversation-context-store');
const SessionResumptionProtocol = require('./src/runtime/infrastructure/session-resumption-protocol');

const store = new ConversationContextStore({ sqliteStore, maxTurnsPerSession: 1000 });
const protocol = new SessionResumptionProtocol({
  conversationStore: store,
  sessionManager,
  memoryStore,
  dreamEngine,
  maxResumptionTokens: 4000,
});

// 会话恢复
const { context, tokenEstimate, sources } = await protocol.resumeSession('new-session-001', {
  sessionId: 'previous-session',
  projectRoot: '/project',
  taskHint: 'implement authentication',
});

// 手动构建和注入
const result = await protocol.buildResumptionContext({ sessionId: 'prev', taskHint: 'debug' });
await protocol.injectResumptionContext('new-session', result.context);

// 查看统计
const stats = protocol.getStats();
```

## 验收标准
- [ ] 会话上下文持久化成功
- [ ] 3层渐进搜索返回相关记忆
- [ ] 压缩工作流在Token阈值时触发
- [ ] 会话恢复上下文包含必要信息

## 常见问题
- **Q: 会话恢复后上下文不完整？**
  A: 检查maxResumptionTokens限制（默认4000），按优先级截断时低优先级信息可能丢失
- **Q: 压缩后信息丢失？**
  A: 压缩保留最近threshold/2轮完整内容，早期轮次仅保留摘要
