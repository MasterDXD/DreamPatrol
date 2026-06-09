# 模块详解-EvidenceVerifier模块

> 版本：2.73.4 | 文件：src/gate/evidence-verifier.js | 行数：~440行

---

## 模块定位

EvidenceVerifier是证据验证器，是TDD门禁执行器的核心组件之一。它定义每种Skill所需的证据类型，验证Agent完成声明是否有足够证据支撑，通过多维度质量评估（完整性、特异性、一致性、可操作性、记忆-代码一致性）对证据进行打分，并在证据不足时生成自反思提示。与`verification-before-completion` Skill配合使用，确保"声称完成必须提供实际证据"的核心原则得到执行。

## 类定义

```javascript
class EvidenceVerifier {
  constructor(options = {})
  verify(context)
  getRequiredEvidenceTypes(skillId)
  setEvidenceRequirements(requirements)
  setVerificationThreshold(threshold)
  classifyCriteriaStrength(criteriaText)
  isHealthy()
  shutdown() // via withShutdown mixin
}
```

## 构造函数

### `constructor(options)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.verificationThreshold` | number | 否 | 验证通过阈值，默认0.8 |
| `options.typeScoreWeight` | number | 否 | 类型完整度权重，默认0.6 |
| `options.qualityScoreWeight` | number | 否 | 质量评分权重，默认0.4 |
| `options.evidenceRequirements` | object | 否 | 自定义证据需求映射 |

**评分公式**：`score = typeScore × typeScoreWeight + qualityScore × qualityScoreWeight`

## 公开方法详解

### `verify(context)`

验证Agent完成声明的证据是否充分。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context` | object | 是 | 验证上下文 |
| `context.claim` | string | 否 | 完成声明描述 |
| `context.evidence` | EvidenceItem[] | 否 | 提供的证据列表 |
| `context.requiredTypes` | string[] | 否 | 要求的证据类型列表 |
| `context.skillId` | string | 否 | Skill ID（用于生成反思提示） |
| `context.agentId` | string | 否 | Agent ID（用于生成反思提示） |
| `context.qualityCriteria` | object | 否 | 自定义质量评估维度和权重 |
| `context.successCriteria` | string | 否 | 成功标准描述（用于强度分类） |

**返回值**：`VerifyResult`

| 字段 | 类型 | 说明 |
|------|------|------|
| `verified` | boolean | 是否验证通过 |
| `score` | number | 综合评分（0-1） |
| `typeScore` | number | 类型完整度评分（0-1） |
| `qualityScore` | number | 质量评分（0-1） |
| `missing` | string[] | 缺失的证据类型 |
| `qualityIssues` | QualityIssue[] | 质量问题列表 |
| `report` | string | 验证报告文本 |
| `evidenceCount` | number | 有效证据数量 |
| `requiredCount` | number | 要求的证据类型数量 |
| `shouldReflect` | boolean | 是否应触发自反思 |
| `reflectionPrompt` | string|null | 自反思提示文本 |
| `criteriaStrength` | string | 成功标准强度：`strong`/`weak` |
| `requiresHumanConfirmation` | boolean | 弱标准时需人工确认 |
| `specificationConformance` | object|null | 规格一致性信息 |

**验证逻辑**：
1. 过滤有效证据（type和content非空）
2. 计算缺失的证据类型
3. 区分硬性缺失和软性缺失（`specification_verified`为软性）
4. 计算类型完整度评分：`(总类型数 - 缺失数) / 总类型数`
5. 计算质量评分：有qualityCriteria时用多维度评估，否则用自动评估
6. 综合评分 = typeScore × 0.6 + qualityScore × 0.4
7. 验证通过条件：硬性缺失为0 且 综合评分 >= 阈值
8. 评分低于阈值时生成自反思提示

### `getRequiredEvidenceTypes(skillId)`

获取指定Skill所需的证据类型列表。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 是 | Skill ID |

**返回值**：`string[]` — 优先返回自定义需求，否则返回内置需求，未知Skill返回`['test_output', 'coverage_report']`

### `setEvidenceRequirements(requirements)`

设置自定义证据需求映射。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requirements` | object | 是 | 格式为`{skillId: [type1, type2, ...]}`，值必须为字符串数组 |

**行为细节**：
- 验证每个值是否为字符串数组，仅保留合法条目
- 传入非对象或数组时清空自定义需求

### `setVerificationThreshold(threshold)`

设置验证通过阈值。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `threshold` | number | 是 | 阈值范围(0, 1]，默认0.8 |

### `classifyCriteriaStrength(criteriaText)`

分类成功标准的强度。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `criteriaText` | string | 是 | 成功标准文本 |

**返回值**：`'strong'` | `'weak'`

**分类逻辑**：
- 匹配强标准模式（如"test passes"、"coverage >= 80%"、"lint zero error"）→ `strong`
- 匹配弱标准模式（如"make it work"、"looks good"、"大概"、"差不多"）→ `weak`
- 包含可量化指标（`>=`、`%`、`pass`、`fail`）→ `strong`
- 包含规格关键词（`specification`、`规格`）→ `strong`
- 其他 → `weak`

## 内置证据需求

| Skill ID | 所需证据类型 |
|----------|------------|
| `tdd-implement` | test_output, coverage_report |
| `module-development` | test_output, coverage_report, lint_output |
| `code-review` | review_report |
| `verification-before-completion` | test_output, coverage_report, lint_output, security_check |
| `bug-fix` | test_output, fix_verification |
| `security-audit` | security_report |
| `integration-testing` | test_output, coverage_report |
| `deployment` | deployment_verification, health_check |
| `performance-optimization` | performance_report |
| `refactor-code` | test_output, refactor_report |
| `brainstorming` | design_document |
| `requirement-analysis` | requirement_spec |
| `architecture-design` | architecture_document |
| `documentation` | document_file |
| `iterative-deepening` | quality_score_report, convergence_report |
| `multi-agent-fusion` | fusion_report, agent_affinity_report |
| `pair-chat` | pair_chat_report, correction_summary |
| `self-reflection` | reflection_report, improvement_record |
| `auto-doc-generation` | document_file, dependency_list |
| `design-md` | design_document, anti_pattern_checklist |
| `taste-skill` | aesthetic_score_report, design_review |
| `impeccable` | design_audit_report, polish_diff |
| `ui-skills` | component_code, accessibility_report |
| `motion-ai-kit` | motion_css, performance_report |
| `better-icons` | icon_selection_report |
| `cloud-ai-blueprint` | architecture_document, ai_blueprint_document |
| `ai-prompting` | prompt_template, quality_report |
| `necessity-review` | necessity_review_report |
| `dispatching-parallel` | parallel_execution_report |
| `systematic-debugging` | debug_report, root_cause_analysis |
| `writing-skills` | skill_definition_document |

## 质量评估维度

当提供`qualityCriteria`时，使用多维度评估：

| 维度 | 默认权重 | 说明 |
|------|---------|------|
| `completeness` | 0.25 | 证据内容是否足够详细（最小长度50字符） |
| `specificity` | 0.25 | 证据是否包含具体信息（关键词数>5的词>=2个） |
| `consistency` | 0.15 | 证据内部是否自相矛盾（同时出现pass和fail） |
| `actionability` | 0.15 | 证据是否包含可操作信息（fix/implement/add等动词） |
| `memory_code_consistency` | 0.20 | 证据引用的文件路径是否存在于已知路径集合 |

**QualityIssue结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dimension` | string | 维度名称 |
| `severity` | string | 严重级别：`high`/`medium`/`low` |
| `description` | string | 问题描述 |

## 自动质量评估

无`qualityCriteria`时使用`_assessEvidenceQuality`自动评估：

- **基础分**：每条证据0.6分
- **内容长度加分**：>10字符+0.05，>30字符+0.05，>80字符+0.05
- **元数据加分**：有metadata字段+0.05
- **正向信号加分**：包含passed/success/complete/ok/✅ +0.1
- **负向信号扣分**：包含failed/error/missing/❌ -0.1
- **规格一致性加分**：specification_verified类型且包含conforms/verified +0.15
- 单项评分clamp到[0,1]，最终取所有证据的平均分

## 成功标准强度分类

### 弱标准模式

| 模式 | 说明 |
|------|------|
| `make it work` | 模糊完成标准 |
| `looks good/ok/fine/nice` | 主观判断 |
| `just fix it` | 无验证要求 |
| `should be fine` | 推测性判断 |
| `大概/差不多/看起来/应该可以/好像` | 中文模糊表达 |

### 强标准模式

| 模式 | 说明 |
|------|------|
| `test passes/green` | 测试通过 |
| `coverage >= N` | 覆盖率达标 |
| `lint passes/zero error` | Lint零错误 |
| `all tests pass` | 全部测试通过 |
| `no error/warning/violation` | 零违规 |
| `测试通过/覆盖率/零错误` | 中文强标准 |

## 规格一致性

当证据中包含`specification_verified`类型时，自动计算规格一致性：

| 字段 | 说明 |
|------|------|
| `specIds` | 涉及的规格ID列表 |
| `conformanceScore` | 一致性评分（0-1） |
| `driftDetected` | 是否检测到规格偏移 |

## 验证报告格式

`_generateReport`生成的报告包含：
1. 声明标题
2. 已提供的证据列表（✅标记）
3. 缺失的证据类型（❌标记）
4. 质量问题（⚠️标记）
5. 验证结果（VERIFIED ✅ / NOT VERIFIED ❌）

## 自反思提示

当`shouldReflect`为true时，生成包含以下内容的反思提示：
1. Agent和Skill标识
2. 缺失的证据类型列表
3. 质量问题描述
4. 四个反思问题：为什么缺失、是否有替代、是否意味着不完整、补充计划

## 静态属性

| 属性 | 说明 |
|------|------|
| `EVIDENCE_REQUIREMENTS` | 内置证据需求映射（84个Skill） |

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `TYPE_SCORE_WEIGHT` | 0.6 | 类型完整度权重 |
| `QUALITY_SCORE_WEIGHT` | 0.4 | 质量评分权重 |
| `BASE_ITEM_SCORE` | 0.6 | 证据基础分 |
| `CONTENT_LENGTH_BONUS` | 0.05 | 内容长度加分 |
| `METADATA_BONUS` | 0.05 | 元数据加分 |
| `POSITIVE_SIGNAL_BONUS` | 0.1 | 正向信号加分 |
| `NEGATIVE_SIGNAL_PENALTY` | 0.1 | 负向信号扣分 |
| `SHORT_EVIDENCE_PENALTY` | 0.5 | 短证据扣分系数 |
| `VAGUE_THRESHOLD_RATIO` | 0.5 | 模糊证据比例阈值 |
| `DEFAULT_UNKNOWN_SKILL_EVIDENCE` | ['test_output', 'coverage_report'] | 未知Skill默认证据需求 |

## 使用示例

```javascript
const EvidenceVerifier = require('./src/gate/evidence-verifier');

const verifier = new EvidenceVerifier({
  verificationThreshold: 0.8
});

const result = verifier.verify({
  claim: 'TDD实现完成',
  skillId: 'tdd-implement',
  agentId: 'task-worker',
  evidence: [
    { type: 'test_output', content: 'All 42 tests passed, 0 failures' },
    { type: 'coverage_report', content: 'Line coverage: 92%, Branch coverage: 87%' }
  ]
});

console.log('验证通过:', result.verified);
console.log('综合评分:', result.score);
console.log('类型评分:', result.typeScore);
console.log('质量评分:', result.qualityScore);
console.log('缺失证据:', result.missing);
console.log('标准强度:', result.criteriaStrength);
console.log('需人工确认:', result.requiresHumanConfirmation);

if (result.shouldReflect) {
  console.log('反思提示:', result.reflectionPrompt);
}

console.log('报告:\n', result.report);

const required = verifier.getRequiredEvidenceTypes('tdd-implement');
console.log('tdd-implement需要:', required);

verifier.setVerificationThreshold(0.9);
verifier.shutdown();
```

## 依赖关系

- 依赖：`../utils/shutdown-mixin.js` — 优雅关闭混入
- 依赖：`../utils/safe-execute.js` — clamp01工具
- 依赖：`../utils/safe-assign.js` — 安全配置合并
- 被依赖：`src/gate/tdd-gate.js` — TDD门禁调用
- 被依赖：`verification-before-completion` Skill — 完成前验证

## 集成说明

- EvidenceVerifier与TDDGate配合：TDD门禁在RED-GREEN-REFACTOR检测中使用证据验证
- 与`verification-before-completion` Skill配合：Skill执行时调用verify()验证完成声明
- 与GeneratorVerifier互补：GeneratorVerifier验证生成器逻辑，EvidenceVerifier验证完成证据
- 弱标准需人工确认的机制与HumanApprovalGate配合，确保关键决策点有人工介入
- 自反思提示与SelfReflection模块配合，驱动Agent自我改进

## 相关文档

- [核心功能-TDD门禁执行流程](../core/核心功能-TDD门禁执行流程.md)
- [模块详解-TDDGate模块](模块详解-TDDGate模块.md)
- [核心功能-TDD门禁执行流程](../core/核心功能-TDD门禁执行流程.md)
