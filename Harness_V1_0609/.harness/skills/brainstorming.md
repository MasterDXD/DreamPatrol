---
skill_id: brainstorming
name: 头脑风暴
applicable_agents: [domain-analyst, team-lead, planner]
trigger: 用户提出模糊需求或新项目想法时
auto_trigger: true
phase: brainstorming
priority: 0
trigger_conditions:
  - user presents a vague or incomplete idea
  - user mentions "头脑风暴" or "brainstorm" or "讨论方案" or "探索想法"
  - user starts a new project without clear requirements
  - no design document exists for the requested feature
depends_on: []
blocks: [idea-validation, requirement-analysis]
causal_inputs: []
causal_outputs:
  - name: design-document
    description: 设计方案文档
  - name: assumption-list
    description: 假设清单
  - name: feasibility-assessment
    description: 可行性评估
evidence_types:
  required:
    - design_document
enforcement: recommended
verified: true
stability: stable
usage_count: 110
success_rate: 0.85
tools:
  - socratic-questioner: 苏格拉底式提问工具
  - idea-clustering: 想法聚类归纳
  - feasibility-assessor: 可行性评估
  - mind-mapper: 思维导图可视化
model: claude-3-opus-20240229
production_validated: true
---

# Skill: 头脑风暴

## 任务目标
通过苏格拉底式提问，帮助用户从模糊想法中提炼出清晰、可执行的设计方案。在需求分析之前，确保需求本身经过充分探索和验证。

## 执行步骤
1. **理解初始想法**：
   - 倾听用户描述，识别核心意图
   - 不做假设，记录用户的原始表述
   - 标记模糊点和需要澄清的区域
2. **苏格拉底式提问**（逐个问题提问，不一次性抛出所有问题）：
   - **目标澄清**：这个功能要解决什么问题？谁会使用它？
   - **边界探索**：什么情况下不需要这个功能？最大规模预期是多少？
   - **方案对比**：有没有其他方式可以解决同样的问题？各有什么优劣？
   - **约束识别**：有没有技术限制？时间要求？兼容性要求？
   - **风险预判**：什么可能导致失败？最坏情况是什么？
3. **非共识输入注入**（在生成方案前执行）：
   - 要求用户提供独特资源、特殊约束、过往失败案例等非常规信息
   - 确保AI产出个性化选项空间而非通用方案
   - 收集信息包括但不限于：团队独有优势、非典型约束条件、行业反直觉经验、历史失败教训
4. **方案探索**（生成至少5个（理想10个）不同思路，而非2-3个）：
   - 每种思路列出：核心思路、优势、劣势、适用场景
   - 每个思路必须标注：①适用前提 ②风险 ③属于"共识方案"还是"非共识方案"
   - 不急于推荐，让用户参与权衡
   - 对比各思路的复杂度、风险、收益
   - 确保包含至少2个非共识方案，避免全部为行业通用做法
5. **假设质疑**（Karpathy原则：编码前思考）：
   - 列出当前方案中所有隐含假设，标注"确定/待验证/存疑"
   - 对每个"存疑"假设，提出至少2种替代解释
   - 如果存在更简单的方案，必须主动提出并说明理由
   - 遇到不理解的地方，必须明确指出哪里不清楚
6. **必要性评估**（Karpathy原则：简单至上）：
   - 评估方案是否包含未被要求的功能
   - 检查是否存在"以防万一"的抽象或配置
   - 确认每个模块都有至少2个调用方
   - 标记所有可删除而不影响核心功能的代码
7. **分段验证**：
   - 将设计分成独立部分，逐段呈现给用户确认
   - 每段确认后再进入下一段
   - 用户可随时调整方向
8. **输出设计文档**：
   - 将确认的设计方案保存到 outputs/ 目录
   - 文档包含：问题定义、方案选择、核心设计决策、待确认项
   - 设计文档作为 requirement-analysis Skill 的输入

## 验收标准
- 所有核心问题已向用户确认，无未解决的模糊点
- 至少探索了5种不同思路（理想10种）并进行了对比，包含非共识方案
- 设计方案已分段获得用户确认
- 输出的设计文档清晰、完整、可执行
- 无自行假设的用户意图

## 常见问题
- **Q: 用户对问题本身都不清楚怎么办？**
  A: 从最基本的问题开始："你希望达成什么效果？"，用具体场景引导思考
- **Q: 用户频繁改变方向怎么办？**
  A: 记录每次方向变更的原因，帮助用户理清思路，避免反复摇摆
- **Q: 技术方案超出用户理解范围怎么办？**
  A: 用类比和示例解释，避免使用专业术语，聚焦于方案的效果而非实现细节
- **Q: 提问过多导致用户不耐烦怎么办？**
  A: 优先问最关键的问题，次要问题可标注为"待确认"，不阻塞后续流程
