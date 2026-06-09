# 上下文管理规则

## SessionStart Hook自动注入
1. **核心身份声明**：始终注入框架核心原则（分层分责、TDD强制、证据验证、自动路由）
2. **Skill路由指令**：注入当前阶段相关Skill的名称和触发条件
3. **当前项目上下文**：从config.json和sessions/读取项目状态
4. **快速参考**：常用指令和Agent角色切换参考

## CLAUDE.md 自动注入流程
1. **文件发现**：扫描项目内所有`.md`文件，包括`.harness/rules/`和`docs/guidelines/`
2. **解析处理**：解析Frontmatter、@include指令、Markdown内容
3. **合并注入**：按类型合并为统一的系统提示词，注入到所有Agent的上下文中

## Skill按需加载策略
- **分层加载**：核心身份声明始终注入；Skill路由指令按需加载当前阶段相关的Skill
- **摘要替代**：非当前阶段的Skill仅注入名称和触发条件，不注入完整步骤
- **渐进展开**：当Skill被激活时，才加载其完整内容到上下文
- **压缩回收**：已完成Skill的详细步骤从上下文中移除，仅保留完成状态
- **阶段感知**：根据当前phase字段，仅加载同阶段及前序阶段的Skill摘要

## Session 生命周期管理
1. **创建**：用户启动项目时创建新的Session
2. **初始化**：加载CLAUDE.md、Memory、工具状态、SessionStart Hook
3. **运行中**：接收用户输入、调用API、执行工具、增长上下文
4. **Compact触发**：当Token使用率达到阈值（默认80%）时，自动压缩上下文
5. **持久化**：定期将Session状态保存到`.harness/sessions/`
6. **恢复**：用户重新进入项目时，自动恢复最近的Session状态

## 上下文压缩策略
- **保留**：核心逻辑、决策结果、任务状态、关键引用和链接、当前激活Skill的完整内容
- **丢弃**：冗余的中间过程、重复的信息、过期的临时数据、已完成Skill的详细步骤
- **摘要化**：将长文本生成摘要代替，压缩比可达50%以上
- **增量同步**：所有Agent共享统一的知识状态，任务进度实时同步

## 上下文加载规则
- Agent仅加载当前任务所需的文档片段，避免信息过载
- 优先加载与当前任务直接相关的规则和文档
- 按需加载依赖模块的文档，不预先加载全部
- 加载文档时保留文档间的双向链接关系
- Skill内容按阶段加载，非当前阶段Skill仅加载摘要

## Session数据格式
```json
{
  "session_id": "sess-xxx",
  "created_at": "2026-04-10T00:00:00Z",
  "updated_at": "2026-04-10T00:00:00Z",
  "status": "active",
  "current_phase": "module-development",
  "active_skills": ["tdd-implement", "module-development"],
  "completed_skills": ["brainstorming", "requirement-analysis", "architecture-design"],
  "task_progress": {},
  "context_summary": "",
  "token_usage": {
    "input": 0,
    "output": 0,
    "tool_calls": 0
  }
}
```
