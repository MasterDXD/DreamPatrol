---
skill_id: performance-optimization
name: 性能优化
applicable_agents: [domain-analyst, task-worker]
trigger: 系统性能不达标或响应时间超过阈值时
auto_trigger: true
phase: module-development
priority: 5
trigger_conditions:
  - system performance metrics exceed thresholds
  - user mentions "性能优化" or "performance optimization" or "优化性能"
  - integration-testing reveals performance issues
  - user asks to improve speed or reduce resource usage
depends_on: [module-development]
blocks: []
causal_inputs:
  - name: module-source-code
    source: module-development
    required: true
causal_outputs:
  - name: optimization-report
    description: 优化报告
  - name: benchmark-results
    description: 基准测试结果
verified: true
stability: beta
usage_count: 50
success_rate: 0.82
enforcement: recommended
tools:
  - profiler: 性能分析工具
  - benchmark-runner: 基准测试工具
  - memory-analyzer: 内存分析工具
  - bottleneck-detector: 瓶颈检测工具
model: claude-3-5-sonnet-20240620
production_validated: true
evidence_types:
  required:
    - performance_report
---

# Skill: 性能优化

## 任务目标
定位性能瓶颈，制定优化方案，实施优化并验证效果，确保系统满足性能指标要求。

## 执行步骤
1. **性能基线**：
   - 确认当前性能指标（响应时间、吞吐量、资源占用）
   - 确认目标性能指标
   - 记录差距
2. **瓶颈定位**：
   - 分析慢查询日志和API响应时间
   - 识别CPU/内存/IO瓶颈
   - 使用性能分析工具定位热点代码
3. **优化方案**：
   - 数据库优化：索引、查询优化、连接池
   - 代码优化：算法改进、缓存、异步处理
   - 架构优化：负载均衡、读写分离、CDN
   - 评估每种方案的成本和收益
4. **实施优化**：
   - 按优先级实施优化（收益大、风险小优先）
   - 每项优化后立即验证效果
   - 记录优化前后对比数据
5. **效果验证**：
   - 运行性能测试，对比优化前后
   - 确认未引入新问题
   - 更新性能基线

## 验收标准
- 性能指标达到目标值
- 优化有量化数据支撑（前后对比）
- 未引入功能缺陷
- 优化方案有文档记录

## 常见问题
- **Q: 优化后性能仍不达标怎么办？**
  A: 重新定位瓶颈，考虑架构级优化，必要时调整性能目标
- **Q: 优化与可读性冲突怎么办？**
  A: 优先保证可读性，性能关键路径可添加详细注释说明优化逻辑
- **Q: 如何避免过度优化？**
  A: 只优化达到性能瓶颈的部分，不提前优化非关键路径
