---
rule_id: karpathy-principles
name: Karpathy编码原则
phase: all
enforcement: strict
priority: 0
applicable_agents: [task-worker, code-reviewer, domain-analyst, typescript-reviewer, python-reviewer, go-reviewer, rust-reviewer, java-reviewer, build-error-solver, test-writer]
---

# Karpathy编码原则 — 四大戒律

## 1. 编码前思考（Think Before Coding）

### 强制规则
- **明确假设**：编码前必须列出所有假设，不确定的假设标注为"待验证"
- **多种解释**：当需求有歧义时，必须列出至少2种可能的解释，不能静默选择
- **主动反驳**：如果发现更简单的方案，必须提出并说明理由
- **遇惑即停**：遇到不理解的地方，必须停下来说明哪里不清楚，请求澄清

### 执行机制
- **thinking_required门禁**：当`requireThinking=true`且未提供`thinkingOutput`时，executePipeline返回`status: 'thinking_required'`，要求提供assumptions、ambiguities、simpler_alternative
- **clarification_needed阻断**：当StructuredIntent检测到意图完整度低于阈值时，executePipeline返回`status: 'clarification_needed'`，阻止在歧义下继续执行

### 检查清单
- [ ] 我是否理解了要解决的问题？
- [ ] 我是否列出了所有假设？
- [ ] 是否有歧义需要澄清？
- [ ] 是否存在更简单的方案？
- [ ] 我是否在不确定时选择了沉默？

## 2. 简单至上（Simplicity First）

### 强制规则
- **最小代码**：用最少的代码解决问题，不做任何推测性实现
- **禁止过度设计**：
  - 不实现未被要求的功能
  - 不为一次性代码创建抽象
  - 不添加"灵活性"或"可配置性"除非明确需要
  - 不创建"以防万一"的接口
- **禁止不必要的错误处理**：只为可能真实发生的错误写处理代码。注意：外部输入校验、资源操作保护、并发场景防护、边界条件处理属于**必要错误处理**，不可省略。详见[[anti-bad-code]]规则中"必要vs不必要错误处理"判定标准
- **禁止过早优化**：先让它工作，再让它正确，最后才考虑让它快

### YAGNI检查
在创建新模块或抽象前，必须回答：
1. 这个抽象现在是否被至少2个地方使用？如果不是，不要创建
2. 这个功能是否被明确要求？如果不是，不要实现
3. 这个配置项是否有人会修改？如果不是，不要添加
4. 这个接口是否比直接调用更简单？如果不是，不要抽象

### 执行机制
- **simplicity_check Hook**：在pre_tool_call和post_file_write时自动检查：新建文件数>3告警、新增行数>200且删除<10%告警（过度实现）、Factory/Builder/Strategy/Adapter抽象检测、无实现的Config接口检测、代码行数预算超150%告警
- **necessity-review Skill**：auto_trigger=true，在新模块创建、新抽象引入、新依赖添加时自动触发YAGNI审查
- **yagni_pre_check Hook**：在pre_tool_call时检查新文件数、抽象数量、新增行数，超过阈值时建议触发necessity-review

## 3. 手术改变（Surgical Changes）

### 强制规则
- **只改必须改的**：不"改进"相邻代码、注释或格式
- **不重构未损坏的代码**：如果它工作正常，不要动它
- **匹配现有风格**：即使你更喜欢不同的风格
- **最小依赖引入**：新依赖必须证明其必要性
- **不添加无用注释**：代码本身应足够清晰
- **孤立代码处理**（v2.7.109增强，源自andrej-karpathy-skills）：
  - 清理**自己改动产生的**孤立代码（因你的变更而变得未使用的import/变量/函数）
  - 发现**预存的**死代码时，仅提及而不删除，除非被明确要求
  - 每行变更应可追溯到用户请求——"Every changed line should trace directly to the user's request"

### 修改范围控制
- 每次修改只解决一个问题
- 不在修复bug时顺便重构
- 不在添加功能时顺便改格式
- 不在重构时顺便改API

### 执行机制
- **surgical_change_check Hook**：在post_file_write时自动检查：修改文件数>10告警（范围过宽）、非重构任务中的重构行为检测、纯样式变更检测、孤立代码残留检测
- **permission_check Hook**：只读Agent（code-reviewer、security-reviewer等）被阻止执行write_file和file_delete操作

## 4. 目标驱动执行（Goal-Driven Execution）

### 强制规则
- **声明式目标**：将任务转化为可验证的目标，而非步骤列表
- **验证循环**：每完成一个目标，必须验证后再进行下一个
- **失败快速暴露**：如果目标无法达成，立即报告而非继续
- **成功标准强度分类**（v2.7.109增强，源自andrej-karpathy-skills）：
  - **强成功标准**：可独立验证的明确标准（如"测试通过"、"覆盖率≥80%"）→ 允许Agent自主循环直到验证通过
  - **弱成功标准**：模糊标准（如"让它工作"、"看起来不错"）→ 需要持续人工确认，不允许Agent自主标记完成
  - 转化弱标准为强标准是编码前的必要步骤

### 目标格式
```
目标：<声明式描述>
验证标准：<如何确认目标达成>
标准强度：<强/弱>
当前状态：<未开始/进行中/已达成/已失败>
```

### 执行机制
- **evidenceVerifier验证**：任务完成时调用evidenceVerifier.verify()，验证声明的证据是否充分，未通过标记`evidence_insufficient`
- **goalVerification验证**：当提供goalVerification时，逐项验证successCriteria是否达成，未达成标记`goal_not_achieved`
- **verification_before_completion Hook**：对strict技能（tdd-implement、module-development、bug-fix等）强制检查：测试失败阻止完成、lint错误阻止完成
- **tddGate门禁**：enforceCheck()阻止无测试的实现、enforceCoverage()强制覆盖率阈值

### 禁止模式
- 禁止在没有验证标准的情况下开始编码
- 禁止在目标未达成时标记任务完成
- 禁止在遇到问题时静默绕过

## 5. 执行弹性与有效性度量（v2.7.109增强，源自andrej-karpathy-skills）

### 执行弹性
- **权衡声明**：本规则偏向谨慎而非速度。对于琐碎任务，使用判断力适当简化流程
- **非全量强制**：紧急bug修复可跳过部分检查，但必须事后补审
- **渐进执行**：根据任务复杂度动态调整规则执行深度

### 有效性度量
以下指标用于评估Karpathy原则是否在项目中有效运行：
- **diff洁净度**：不必要的变更行数占总变更行数的比例应持续下降
- **返工率**：因过度复杂化导致重写的次数应持续下降
- **澄清前置率**：澄清问题在实现前提出的比例应高于实现后
- **孤立代码率**：因变更产生的未清理孤立代码数量应趋近于零
- **标准强度比**：强成功标准占所有成功标准的比例应持续提升
- **思考质量**：编码前思考输出中包含假设、歧义、替代方案的比例应持续提升
- **变更范围合规率**：单次变更中符合"精准修改"原则的比例应持续提升
- **代码预算合规率**：新增代码行数未超出预算估算的比例应持续提升
