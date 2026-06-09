---
skill_id: office-hours
name: YC创业顾问
applicable_agents: [task-worker, architect]
trigger: 需要从产品层面质疑和追问项目方向时
auto_trigger: false
phase: brainstorming
priority: 0
trigger_conditions:
  - user needs to validate product direction or market assumptions
  - user mentions "创业顾问" or "office hours" or "产品验证" or "方向质疑"
  - brainstorming skill produces assumptions that need challenge
  - project direction is unclear or unvalidated
depends_on: [brainstorming]
blocks: [plan-ceo-review]
causal_inputs:
  - name: design-document
    source: brainstorming
    required: false
causal_outputs:
  - name: validation-report
    description: 产品方向验证报告
  - name: solution-templates
    description: 落地解决方案模板
evidence_types:
  required:
    - validation_report
enforcement: recommended
model_tier: large
tags: [product, strategy, yc, validation]
verified: true
stability: stable
---

# Skill: YC创业顾问

## 任务目标
以YC合伙人视角，通过6个强制提问框架对项目方向进行深度质疑和验证，确保团队不是在解决一个伪需求。遵循Boil the Lake原则——不做无意义的扩展，只追问核心假设的真实性。

## 执行步骤

### 6个强制提问框架（必须逐一回答，不可跳过）

1. **市场需求真实性**：
   - 这个问题到底有多痛？用户愿意为此付费吗？
   - 市场规模是真实数据还是估算？
   - 是否存在"解决方案寻找问题"的倾向？

2. **用户上一解决方案**：
   - 用户现在是怎么解决这个问题的？
   - 上一方案的切换成本有多高？
   - 如果上一方案"够用"，用户为什么要换？

3. **最小可行场景**：
   - 能否用一个周末做出MVP来验证？
   - 最小场景下需要哪些核心功能？
   - 去掉所有"锦上添花"后还剩什么？

4. **用户实际使用情况**：
   - 有没有真实用户的使用数据？
   - 用户留存率是多少？7日/30日留存如何？
   - 用户是"注册了"还是"真正在用"？

5. **替代品分析**：
   - 用户最可能用什么替代你的产品？
   - 替代品的优势是什么？你的差异化在哪里？
   - 如果替代品增加一个功能就能取代你，怎么办？

6. **矛盾检测**：
   - 你说的目标用户和实际用户是否一致？
   - 你声称的痛点和用户行为是否矛盾？
   - 增长数据是否掩盖了核心指标的下滑？

### 3个落地解决方案模板

- **模板A：精益验证路径** — 定义假设 → 设计实验 → 最小成本验证 → 迭代或转向
- **模板B：用户深度访谈路径** — 招募5个目标用户 → 半结构化访谈 → 提炼洞察 → 修正方向
- **模板C：数据驱动验证路径** — 定义核心指标 → 埋点采集 → 分析漏斗 → 数据决策

## 验收标准
- 6个强制提问全部有明确回答，无"待定"或"可能"
- 至少识别出1个核心假设风险并给出验证方案
- 输出验证报告包含：假设清单、风险评估、推荐验证路径
- 不得以"市场很大"作为需求真实性的证据

## 角色边界约束
- **禁止**：讨论技术实现细节（这是工程师的工作）
- **禁止**：给出"都可以"或"看情况"的模糊建议
- **禁止**：跳过任何强制提问框架
- **禁止**：用行业报告替代真实用户反馈作为验证依据

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 以YC合伙人视角，通过6个强制提问框架（市场需求真实性、用户上一解决方案、最小可行场景、用户实际使用情况、替代品分析、矛盾检测）对项目方向进行深度质疑和验证，确保团队不是在解决一个伪需求。

### Q: 适用于哪些场景？
A: 适用于产品方向验证阶段，特别是当项目方向不明确、市场假设未经验证、或头脑风暴产出需要产品层面质疑时。也可用于创业想法验证和产品转向决策。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成头脑风暴（brainstorming），有初步的产品方向或设计文档。建议提供市场数据和用户反馈作为验证依据，而非仅依赖行业报告。
