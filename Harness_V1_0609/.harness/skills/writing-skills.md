---
skill_id: writing-skills
name: 技能编写
applicable_agents: [domain-analyst, task-worker, team-lead]
trigger: 需要创建新的自定义Skill时
auto_trigger: true
phase: module-development
priority: 8
trigger_conditions:
  - user mentions "创建技能" or "编写技能" or "new skill" or "custom skill"
  - existing skills cannot cover a specific workflow
  - user asks to extend the framework with new capabilities
  - recurring workflow pattern is identified that should be formalized
depends_on: []
blocks: []
causal_inputs: []
causal_outputs:
  - name: new-skill-definition
    description: 新技能定义
enforcement: optional
verified: true
stability: beta
usage_count: 15
success_rate: 0.70
production_validated: true
evidence_types:
  required:
    - skill_definition_document
---

# Skill: 技能编写

## 任务目标
指导用户和Agent创建符合框架规范的新Skill，确保新Skill与现有Skill体系一致、可自动触发、可组合使用。

## 执行步骤
1. **识别技能需求**：
   - 明确新Skill要解决什么问题
   - 确认现有Skill无法覆盖此场景
   - 评估新Skill的使用频率和通用性
2. **定义技能元数据**（YAML Frontmatter）：
   ```yaml
   ---
   skill_id: unique-skill-name        # 小写字母+连字符，全局唯一
   name: 技能中文名                    # 简洁描述
   applicable_agents: [agent-list]     # 适用的Agent角色
   trigger: 触发时机描述               # 何时使用此技能
   auto_trigger: true/false            # 是否支持自动触发
   phase: 所属阶段                     # 对应五阶段流程中的哪个阶段
   priority: N                         # 同阶段内的优先级（数字越小越高）
   trigger_conditions:                 # 自动触发的条件列表
     - condition 1
     - condition 2
   depends_on: [skill-list]            # 前置依赖的Skill
   blocks: [skill-list]                # 完成后才可执行的Skill
   ---
   ```
3. **编写技能内容**：
   - **任务目标**：一句话说明此Skill要达成什么
   - **执行步骤**：按顺序列出具体操作步骤，每步可执行、可验证
   - **验收标准**：明确、可量化的完成条件
   - **常见问题**：3-5个典型问题及解答
4. **验证技能质量**：
   - 检查YAML Frontmatter格式正确
   - 检查skill_id全局唯一
   - 检查depends_on和blocks引用的Skill存在
   - 检查trigger_conditions清晰无歧义
   - 检查执行步骤可操作、可验证
5. **测试技能**：
   - 模拟触发条件，验证Skill是否被正确路由
   - 按执行步骤走一遍，验证步骤可执行
   - 检查验收标准是否可量化检查
6. **注册技能**：
   - 将Skill文件放入 .harness/skills/ 目录
   - 更新 config.json 中的 skills 配置
   - 更新 CLAUDE.md 和其他编辑器入口文件

## 技能编写规范
- skill_id使用小写字母+连字符，不超过30字符
- 每个Skill聚焦单一职责，不混合多个不相关流程
- 执行步骤不超过10步，每步可独立验证
- 验收标准至少3条，全部可量化或可明确判断
- 常见问题3-5个，覆盖最可能遇到的场景
- auto_trigger为true时，trigger_conditions至少2条

## 验收标准
- YAML Frontmatter格式正确，所有必填字段完整
- skill_id全局唯一，无冲突
- 执行步骤可操作、可验证
- 验收标准可量化
- Skill可被自动路由引擎发现和触发
- 与现有Skill体系无冲突

## 常见问题
- **Q: 新Skill与现有Skill有重叠怎么办？**
  A: 优先扩展现有Skill而非创建新Skill。如果职责确实不同，明确划分边界
- **Q: trigger_conditions怎么写才能确保准确触发？**
  A: 从用户视角描述触发场景，使用具体的动作和关键词，避免模糊表述
- **Q: 新Skill需要新的Agent角色怎么办？**
  A: 在.harness/agents/中创建新Agent定义，并在config.json中配置权限
