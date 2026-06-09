# 监控与容错规则

## 任务监控
- 实时监控每个任务的执行状态、进度、耗时
- 当任务超时（默认20分钟）未完成时，自动发送告警
- 当任务失败时，自动记录失败原因和堆栈信息
- 任务状态变更时实时通知相关Agent

## 容错处理

### 失败重试
- 任务失败后自动重试，最多重试3次（可配置）
- 重试间隔采用指数退避策略：1s → 2s → 4s
- 每次重试前检查失败原因，避免无效重试

### 任务重分配
- 重试失败后，将任务分配给其他Agent
- 重分配时附带完整的上下文和失败记录
- 最多重分配2次，超过则上报Team Lead

### Checkpoint恢复
- 每隔30分钟（可配置）自动创建Checkpoint
- 每个阶段完成时创建Checkpoint
- 任务失败时从最近的Checkpoint恢复
- Checkpoint包含：任务状态、上下文摘要、已完成的工作

### 模型降级
- 当主模型不可用时，自动切换到备用模型
- 降级顺序：gpt-4o → claude-3-opus → deepseek-v3
- 降级后自动降低任务复杂度预期
- 主模型恢复后自动切回

## Checkpoint数据格式
```json
{
  "checkpoint_id": "cp-xxx",
  "created_at": "2026-04-10T00:00:00Z",
  "phase": "module-development",
  "completed_tasks": [],
  "in_progress_tasks": [],
  "pending_tasks": [],
  "context_summary": "",
  "key_decisions": []
}
```

## 异常告警规则
- **任务超时**：任务执行超过配置的超时时间
- **重试耗尽**：任务重试次数达到上限
- **模型不可用**：主模型和所有备用模型均不可用
- **Token超限**：Token使用量超过预算阈值
- **并发冲突**：多个Agent同时修改同一文件
- **Agent心跳丢失**：ManagedAgentHost托管Agent心跳超时未上报
- **技能质量退化**：SkillQualityIndex检测到技能成功率持续下降

## 托管Agent监控（ManagedAgentHost）

### 心跳监控
- ManagedAgentHost对托管Agent执行心跳监控
- 心跳超时自动触发重启或故障转移
- 4种触发模式（事件/定时/Webhook/即发即忘）各有独立的超时策略
- HMAC-SHA256签名验证确保Agent通信安全

### 执行超时保护
- 每个托管Agent执行有独立超时保护
- 超时后自动取消执行并释放资源
- 执行历史通过BoundedArray限制容量

## 资源清理
- 任务完成后，自动清理临时文件和资源
- 定期清理过期的Session和Checkpoint（保留最近7天）
- 自动压缩历史日志和数据
- 清理前确认无正在进行的任务依赖这些资源
