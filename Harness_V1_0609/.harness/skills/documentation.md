---
skill_id: documentation
name: 文档编写
applicable_agents: [technical-writer]
trigger: 代码开发完成、接口变更、新功能上线时
auto_trigger: true
phase: deployment
priority: 7
trigger_conditions:
  - code changes are merged to shared workspace
  - user mentions "文档" or "documentation" or "编写文档"
  - user asks to generate or update documentation
  - deployment skill completes and needs documentation
depends_on: [module-development]
blocks: []
causal_inputs:
  - name: module-source-code
    source: module-development
    required: true
  - name: module-docs
    source: module-development
    required: false
causal_outputs:
  - name: api-docs
    description: API文档
  - name: user-manual
    description: 用户手册
  - name: changelog
    description: 变更日志
evidence_types:
  required:
    - document_file
verified: true
stability: stable
usage_count: 70
success_rate: 0.86
enforcement: recommended
production_validated: true
---

# Skill: 文档编写

## 任务目标
根据代码和设计文档，编写或更新项目文档，确保文档与代码保持同步，为用户提供清晰的使用指引。

## 执行步骤
1. **收集信息**：
   - 阅读相关代码和设计文档
   - 与Domain Analyst确认技术方案
   - 与Task Worker确认实现细节
2. **确定文档类型**：
   - API文档：接口定义、参数、响应、错误码
   - 用户手册：功能介绍、使用步骤、常见问题
   - 运维手册：部署、监控、故障处理
   - 变更日志：版本变更、新增/修改/修复/移除
3. **编写文档**：
   - 按对应模板编写
   - 代码示例必须可运行
   - 技术术语首次出现时定义
   - 添加双向链接关联相关文档
4. **审核校对**：
   - 提交Domain Analyst审核技术准确性
   - 检查文档格式是否符合规范
   - 验证双向链接是否有效
5. **发布更新**：
   - 更新到docs/对应目录
   - 通知相关Agent文档已更新

## 验收标准
- 文档内容与技术实现一致
- 代码示例可运行
- 双向链接有效
- 格式符合文档规范
- 无错别字和语法错误

## 常见问题
- **Q: 代码变更频繁，文档如何保持同步？**
  A: 每次代码合并时触发文档更新任务，变更日志必须同步更新
- **Q: 技术细节不确定怎么办？**
  A: 与Domain Analyst或Task Worker确认，不自行猜测
- **Q: 文档受众不明确怎么办？**
  A: 明确文档目标读者（开发者/运维/用户），按读者水平调整表述
