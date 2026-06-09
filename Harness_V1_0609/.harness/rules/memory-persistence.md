---
rule_id: memory-persistence
name: 内存持久化规则
phase: all
enforcement: recommended
priority: 2
applicable_agents: [team-lead, domain-analyst, task-worker, quality-assurance]
---

# 内存持久化规则

## 跨会话知识保存

### 知识分类
- **项目知识**：架构决策、技术栈选择、模块依赖关系
- **代码知识**：关键算法、复杂逻辑、性能热点
- **流程知识**：团队约定、部署流程、测试策略
- **错误知识**：常见错误及解决方案、踩坑记录

### 保存策略
- 每次会话结束前，将关键决策和状态保存到.harness/knowledge/
- 使用结构化JSON格式存储，便于检索和更新
- 知识条目必须包含：时间戳、来源Agent、上下文描述、具体内容
- 过期知识定期清理（超过30天未引用的条目标记为候选清理）

### 加载策略
- 会话启动时，从.harness/knowledge/加载项目知识
- 按相关性排序：最近修改的优先加载
- 按需加载：仅加载与当前任务相关的知识条目
- 知识引用：在决策时引用相关知识点，确保一致性

## 上下文压缩

### 压缩触发
- 上下文Token超过预算80%时自动触发
- 阶段转换时压缩前一阶段的详细内容
- Skill完成后压缩其详细步骤，保留完成状态

### 压缩策略
- 保留：当前阶段Skill完整指令、关键决策、未完成任务
- 压缩：已完成Skill详细步骤 → 完成状态摘要
- 丢弃：临时计算结果、中间调试信息、重复内容

### 摘要规范
- 摘要长度不超过200字
- 必须包含：做了什么、结果如何、关键决策
- 使用结构化格式：`[SkillID] 完成状态 | 关键结果 | 重要决策`

## 持续学习

### 学习记录
- 记录每次Skill执行的效果和经验
- 保存"什么方法有效"和"什么方法无效"
- 积累特定场景的最佳实践

### 学习应用
- 新任务启动时，查询相关历史学习记录
- 优先使用历史验证有效的方案
- 避免重复已知的错误路径

## 做梦引擎与记忆桥接

### DreamEngine离线经验提炼
- DreamScheduler自动周期性触发DreamEngine回顾历史会话
- 会话结束时自动提炼经验，定时批量回顾
- DreamEngine从历史执行中提取模式、发现知识、整合经验

### DreamBridge自动桥接
- 7条自动桥接规则连接质量评估、自反思、错误预防等模块
- QualityScorer→DreamOutcomes：质量评分结果反馈到梦境闭环
- SelfReflection→DreamEngine：自反思结果输入梦境引擎
- DreamEngine→LlmWiki：梦境产出写入知识库
- ErrorPreventionGuard→IronRuleEngine：错误预防模式转化为铁律

### DreamOutcomes闭环
- 成功标准定义与加权评分评估
- 效果追踪与反馈闭环
- DreamEngine与SkillImprovementLoop双向同步

### 记忆提供商适配
- 支持外部记忆服务：mem0（云端/自托管）、Honcho（AI原生）、Hindsight（本地部署）
- ProviderHealthChecker周期性探测+熔断器保护
- 统一MemoryProviderInterface接口：connect/disconnect/healthCheck/recall/write/query/delete/sync
