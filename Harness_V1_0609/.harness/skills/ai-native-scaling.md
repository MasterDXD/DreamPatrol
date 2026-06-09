---
skill_id: ai-native-scaling
name: AI原生规模化
applicable_agents:
  - team-lead
  - domain-analyst
  - devops-engineer
trigger: 产品需要从MVP阶段扩展到规模化运营时
auto_trigger: true
phase: deployment
priority: 2
trigger_conditions:
  - "用户提到规模化或扩展"
  - "需要AI原生扩展策略"
  - "提到非线性增长"
  - "需要自动化运营系统"
  - "提到ai-native-scaling或AI原生规模化"
  - "用户说扩大规模或增长策略"
depends_on:
  - deployment
blocks: []
causal_inputs:
  - name: mvp-deliverable
    source: mvp-builder
    required: false
  - name: mvp-test-report
    source: mvp-builder
    required: false
  - name: validated-idea-report
    source: idea-validation
    required: false
causal_outputs:
  - name: scaling-strategy
    description: 规模化策略文档（AI优先扩展路径、人力引入决策点）
  - name: automation-blueprint
    description: 自动化蓝图（可自动化的运营流程清单及实现方案）
  - name: scaling-metrics
    description: 规模化指标体系（营收/团队/成本的非线性增长模型）
evidence_types:
  required:
    - scaling_strategy
  optional:
    - automation_blueprint
    - scaling_metrics
enforcement: optional
verified: true
stability: stable
usage_count: 0
success_rate: 0.0
tools:
  - scaling-path-analyzer: 规模化路径分析工具
  - automation-scanner: 自动化机会扫描工具
  - metrics-modeler: 指标建模工具
model: claude-3-opus-20240229
production_validated: false
---

# Skill: AI原生规模化

## 任务目标
在AI时代创业框架下，帮助用户实现非线性规模化——营收增长倍数远高于团队增长倍数。核心路径：先用AI智能体扩展能力边界，再在需要人类判断力的地方引入人力资源。

## 执行步骤

### 步骤1：评估规模化就绪度
- 检查PMF信号：
  - 用户是否主动寻找替代品（如果产品消失）
  - 留存率是否稳定（非新鲜感驱动）
  - 是否有自然增长（非依赖创始人个人影响力）
- 如果PMF未确认 → 建议回退到产品发布阶段重新验证
- 使用 `scaling-path-analyzer` 工具评估就绪度

### 步骤2：制定AI优先扩展路径
- 识别可由AI智能体扩展的能力维度：
  - **客服响应**：AI自动处理常见问题，人工处理复杂场景
  - **数据报告**：AI自动生成定期报告，人工解读和决策
  - **内容生产**：AI生成初稿，人工审核和优化
  - **代码维护**：AI处理bug修复和常规迭代，人工做架构决策
- 为每个维度定义：
  - AI可自动化的比例（目标：80%+）
  - 需要人工介入的判断点
  - 质量监控机制

### 步骤3：构建自动化运营系统
- 使用 `automation-scanner` 工具扫描可自动化的运营流程
- 按优先级排序（ROI从高到低）：
  1. 高频重复任务（客服、报告、监控）
  2. 数据密集型决策（定价、库存、推荐）
  3. 创意辅助任务（文案、设计初稿）
- 为每个自动化流程设计：
  - 触发条件
  - AI处理逻辑
  - 人工审核点
  - 异常处理机制
- 输出 `automation-blueprint`

### 步骤4：设计非线性增长模型
- 使用 `metrics-modeler` 工具构建增长模型
- 传统线性模型：营收×2 = 团队×2 = 成本×2
- AI原生非线性模型：营收×10 = 团队×2 = 成本×3
- 关键指标：
  - **人效比**：营收/团队人数（目标：行业平均3倍+）
  - **AI覆盖率**：AI处理的工作量/总工作量（目标：80%+）
  - **决策速度**：从数据到行动的平均时间（目标：分钟级）
- 定义预警阈值：
  - 人效比下降 → 可能需要调整AI/人工分工
  - AI覆盖率下降 → 可能需要新增自动化
  - 决策速度变慢 → 可能是流程瓶颈

### 步骤5：人力引入决策框架
- 明确哪些地方必须引入人类判断力：
  - **战略决策**：方向选择、重大投资、合作伙伴
  - **用户信任**：品牌建设、危机处理、关键客户关系
  - **团队文化**：价值观守护、决策机制、组织设计
- 引入人力的原则：
  - 先AI扩展，再人力补充（不是先招人再找AI替代）
  - 每个新岗位必须有AI无法替代的理由
  - 新人的第一件事是优化AI系统，而非重复AI的工作

### 步骤6：输出规模化策略
- 汇总扩展路径、自动化蓝图、增长模型
- 生成 `scaling-strategy` 文档
- 将策略发布到CausalDataBus

## 验收标准
- [ ] PMF就绪度已评估，有明确的GO/NO-GO判断
- [ ] AI优先扩展路径已定义，至少覆盖3个能力维度
- [ ] 自动化蓝图已生成，流程按ROI排序
- [ ] 非线性增长模型已建立，关键指标和预警阈值已定义
- [ ] 人力引入决策框架已明确

## 常见问题

### Q: 如何判断PMF是否真实？
A: 使用"消失测试"：如果产品明天消失，用户是否会因为真实痛苦主动寻找替代品？如果答案是不确定，PMF尚未确认，不建议规模化。

### Q: AI覆盖率80%是否过于激进？
A: 80%是目标而非起点。从MVP阶段开始，AI覆盖率可能只有30-40%。关键是持续提升——每解决一个自动化问题，覆盖率就上升一点。核心运营流程（客服、报告、监控）通常最先达到80%+。

### Q: 规模化过程中团队文化如何守护？
A: 这是创始人必须亲自守护的领域。AI可以处理信息和流程，但无法建立信任、塑造价值观或做道德判断。在规模化策略中，团队文化建设是"必须人力"的领域。
