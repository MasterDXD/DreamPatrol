---
skill_id: plan-eng-review
name: 工程架构审查
applicable_agents: [architect]
trigger: 需要锁定架构、数据流、状态转换和失败模式时
auto_trigger: false
phase: architecture-design
priority: 2
trigger_conditions:
  - architecture-design skill produces initial architecture
  - user mentions "工程审查" or "架构审查" or "eng review" or "架构锁定"
  - architecture needs validation before module development begins
depends_on: [architecture-design]
blocks: [module-development]
causal_inputs:
  - name: architecture-document
    source: architecture-design
    required: true
  - name: scope-decision
    source: plan-ceo-review
    required: false
causal_outputs:
  - name: reviewed-architecture
    description: 审查通过的架构文档
  - name: risk-register
    description: 风险登记表
evidence_types:
  required:
    - architecture_review_report
enforcement: strict
model_tier: large
tags: [architecture, review, engineering]
verified: true
stability: stable
---

# Skill: 工程架构审查

## 任务目标
对架构设计进行严格审查，锁定数据流、状态转换和失败模式，确保架构在生产环境中可靠运行。遵循Boil the Lake原则——不做过度设计，但必须覆盖所有已知的失败场景。

## 执行步骤

### 架构图表审查（4类图表必须齐全）

1. **序列图审查**：
   - 每个核心用例是否有对应的序列图？
   - 跨服务调用链是否标注了超时和重试策略？
   - 异步消息是否有明确的顺序保证或幂等设计？

2. **状态图审查**：
   - 核心实体是否有完整的状态转换图？
   - 每个状态转换是否有触发条件、前置检查和后置动作？
   - 是否存在"孤儿状态"（无法到达或无法退出的状态）？

3. **组件图审查**：
   - 组件边界是否清晰？职责是否单一？
   - 组件间依赖是否是单向的？是否存在循环依赖？
   - 每个组件是否有明确的接口契约？

4. **数据流图审查**：
   - 数据流向是否清晰标注？
   - 敏感数据是否标注了加密和脱敏要求？
   - 数据存储是否有明确的读写分离策略？

### 边界情况检查

- 并发场景：同一资源被多个请求同时修改时的行为
- 幂等性：重复请求是否产生相同结果
- 资源耗尽：连接池、线程池、内存耗尽时的降级策略
- 时序问题：时钟偏移、消息乱序的处理

### 失败模式分析

- 单点故障识别：哪些组件故障会导致整体不可用？
- 级联失败分析：一个组件故障是否会扩散？
- 降级策略：核心功能降级后是否仍可提供基本服务？
- 恢复策略：故障恢复后数据一致性如何保证？

## 验收标准
- 4类架构图表齐全且审查通过
- 所有边界情况有明确的处理方案
- 失败模式分析覆盖所有关键路径
- 输出风险登记表，每项风险有等级、影响和缓解措施
- 无未解决的架构级阻塞问题

## 角色边界约束
- **禁止**：讨论产品方向和功能优先级（这是CEO审查的工作）
- **禁止**：跳过任何一类架构图表的审查
- **禁止**：以"后续优化"为由推迟关键失败模式的处理
- **禁止**：在存在单点故障时标记架构审查为"通过"

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 对架构设计进行严格审查，通过4类架构图表审查（序列图、状态图、组件图、数据流图）、边界情况检查和失败模式分析，确保架构在生产环境中可靠运行。

### Q: 适用于哪些场景？
A: 适用于架构设计阶段完成后的工程审查，特别是有严格可靠性和可用性要求的生产系统。也可用于架构重构前的现状评估和架构决策的记录归档。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成架构设计（architecture-design），有完整的4类架构图表和架构文档。建议已完成CEO产品审查（plan-ceo-review），确保产品范围已锁定。
