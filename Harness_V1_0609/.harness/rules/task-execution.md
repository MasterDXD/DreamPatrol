# 任务执行规则

## 六阶段执行流程（v2.0 — TDD强制 + Skill自动路由）

### 阶段0：需求探索（brainstorming）
- **输入**：用户的模糊想法或初步需求
- **输出**：确认的设计方案文档
- **负责人**：Team Lead + Domain Analyst
- **激活Skill**：brainstorming
- **验收标准**：核心问题已确认，至少2种方案已对比，设计方案已分段获得用户确认

### 阶段1：需求分析与规划
- **输入**：用户需求文档 / brainstorming输出
- **输出**：项目计划书、需求规格说明书、任务拆解清单
- **负责人**：Team Lead + Domain Analyst
- **激活Skill**：requirement-analysis
- **验收标准**：需求明确、任务拆解合理、里程碑清晰

### 阶段2：架构设计
- **输入**：需求规格说明书
- **输出**：系统架构图、模块划分文档、接口设计文档
- **负责人**：Domain Analyst
- **激活Skill**：architecture-design
- **验收标准**：架构合理、模块职责清晰、接口定义明确

### 阶段3：模块开发（TDD门禁）
- **输入**：架构设计文档
- **输出**：各模块的源码、单元测试、文档
- **负责人**：Task Worker + Domain Analyst审核
- **激活Skill**：tdd-implement → module-development → code-review → verification-before-completion
- **TDD铁律**：NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
- **验收标准**：代码符合规范、TDD流程遵守、测试覆盖率≥80%、verification证据充分

### 阶段4：集成测试
- **输入**：各模块交付物
- **输出**：集成测试报告、缺陷报告、修复后的代码
- **负责人**：QA + Domain Analyst
- **激活Skill**：integration-testing → bug-fix（如需）→ systematic-debugging（如需）
- **验收标准**：所有功能正常、缺陷率低于阈值

### 阶段5：部署上线
- **输入**：测试通过的代码
- **输出**：部署文档、运行监控报告、用户手册
- **负责人**：DevOps + Team Lead
- **激活Skill**：verification-before-completion → deployment → documentation
- **验收标准**：部署成功、系统运行稳定、文档齐全

## 单任务执行流程（v2.0）
1. **任务分配**：Team Lead将任务分配给对应Agent，明确任务目标、交付物、截止时间
2. **Skill自动路由**：Agent根据任务上下文自动匹配并激活相关Skill
3. **上下文加载**：Agent自动加载相关的规则、文档、历史状态（仅加载当前阶段相关Skill）
4. **TDD执行**：Task Worker按RED-GREEN-REFACTOR循环执行（新功能必须先写测试）
5. **完成验证**：Agent执行verification-before-completion，提供完成证据
6. **提交审核**：Agent将成果和验证证据提交给Analyst审核
7. **审核反馈**：Analyst审核通过则进入下一步，不通过则返回修改
8. **任务完成**：审核通过后，Team Lead标记任务完成，更新进度

## 批次化执行
- 将大任务拆分为6-9个批次
- 从宏观架构到微观细节逐步深入
- 每批完成后自动验收并生成Checkpoint
- 未通过验收的批次自动触发修正流程
- 每个批次内的开发任务遵循TDD流程

## 里程碑管控
- 每个阶段设置明确的交付物和验收标准
- 里程碑未通过则自动触发修正流程
- 所有Agent共享统一的知识状态
- 任务进度实时同步，避免重复工作
- 每个里程碑必须通过verification-before-completion验证

## Skill自动路由规则
- 收到新任务时，扫描所有Skill的trigger_conditions
- 任务匹配某个Skill的触发条件时，必须按该Skill的步骤执行
- 前序Skill完成后，自动检查后继Skill是否需要激活
- enforcement为strict的Skill（tdd-implement、verification-before-completion）不可跳过
- 不确定激活哪个Skill时，按阶段和优先级排序选择
