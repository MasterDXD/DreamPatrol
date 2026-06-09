# 核心功能-TDD门禁执行流程

> 版本：2.73.4 | 模块：src/gate/ | 文件：tdd-gate.js, evidence-verifier.js, framework-compliance-checker.js等16个文件

---

## 概述

TDD门禁执行器是框架质量保障的核心组件，强制执行RED-GREEN-REFACTOR开发流程，确保代码质量和测试覆盖率。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    TDD门禁执行器                          │
├──────────────┬───────────────┬──────────────────────────┤
│   TDDGate    │EvidenceVerifier│FrameworkComplianceChecker│
│  TDD强制门禁  │  证据验证器     │   框架合规检查器          │
├──────────────┼───────────────┼──────────────────────────┤
│ DesignSkill  │CodeReview     │  DeviationApproval       │
│  Engine      │FrameworkCheck │  偏差审批                 │
│ 设计技能引擎   │ 代码审查框架   │                          │
├──────────────┼───────────────┼──────────────────────────┤
│ GeneratorVerifier│                                    │
│  生成器验证器     │                                    │
└──────────────┴───────────────┴──────────────────────────┘
```

## TDDGate — TDD强制门禁

### RED-GREEN-REFACTOR检测

| 阶段 | 检测内容 | 通过条件 |
|------|---------|---------|
| RED | 测试文件存在且测试失败 | testExists=true && testsFailing=true |
| GREEN | 测试文件存在且测试通过 | testExists=true && testsPassing=true |
| REFACTOR | 测试仍通过且代码已变更 | testsPassing=true && codeChanged=true |

### 使用方式

```javascript
const { TDDGate } = require('./src');

const gate = new TDDGate();
const result = gate.check({
  implFile: 'src/main.py',
  testFile: 'test/test_main.py',
  testExists: false,
  implExists: true,
});

if (!result.passed) {
  console.log('TDD违规：', result.violations);
}
```

## EvidenceVerifier — 证据验证器

验证Agent声称完成时必须提供的证据类型：

| 证据类型 | 说明 | 必需性 |
|---------|------|--------|
| test_output | 测试运行输出 | 必须 |
| coverage_report | 覆盖率报告 | 必须 |
| lint_result | Lint检查结果 | 推荐 |
| build_output | 构建输出 | 条件必须 |

## FrameworkComplianceChecker — 框架合规检查器

### 检查维度

1. **命名规范**：文件名kebab-case，类名PascalCase
2. **结构规则**：模块导出规范、目录结构规范
3. **安全规则**：无硬编码密钥、无SQL拼接
4. **Karpathy规则**：简洁代码原则
5. **设计规则**：设计系统合规

## 配置

在.harness/config.json中配置：

```json
{
  "tdd_config": {
    "enabled": true,
    "test_coverage_threshold": 0.8,
    "red_green_refactor_enforced": true,
    "no_code_without_test": true
  }
}
```

## TDDGate 详细API

### check(context)

检查TDD合规性，根据测试文件和实现文件的存在状态及测试结果，判断当前处于RED-GREEN-REFACTOR的哪个阶段。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context` | object | 是 | 检查上下文 |
| `context.implFile` | string | 是 | 实现文件路径 |
| `context.testFile` | string | 是 | 测试文件路径 |
| `context.testExists` | boolean | 是 | 测试文件是否存在 |
| `context.implExists` | boolean | 是 | 实现文件是否存在 |
| `context.testResult` | string\|object | 否 | 测试执行结果，支持`'fail'`/`'pass'`字符串或`{failed, passed}`对象 |

**返回值**：`{passed: boolean, phase: string, reason: string}`

**违规类型枚举**：

| phase | passed | 含义 |
|-------|--------|------|
| `VIOLATION` | false | 实现文件存在但无对应测试文件（核心违规） |
| `RED` | true | 仅测试存在且测试失败（RED阶段正常） |
| `RED` | true | 仅测试存在，等待实现 |
| `UNKNOWN` | false | 测试存在但未运行 |
| `GREEN` | true | 测试和实现均存在且测试通过 |
| `RED` | false | 实现存在但测试仍失败 |
| `UNKNOWN` | false | 实现和测试均存在但结果未知 |
| `ERROR` | false | 非预期的测试结果 |
| `EMPTY` | true | 尚无任何文件 |

### checkCoverage(context)

检查测试覆盖率是否达到阈值。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context.coverage` | number | 是 | 当前覆盖率（0-100） |
| `context.threshold` | number | 否 | 覆盖率阈值（0-100），默认`DEFAULT_COVERAGE_THRESHOLD=80` |

**返回值**：`{passed: boolean, reason: string, coverage: number|null, threshold: number}`

### enforceCheck(context) / enforceCoverage(context)

强制执行版本，不通过时抛出`TDDGateError`异常。

**TDDGateError错误码**：

| 错误码 | 触发条件 |
|--------|---------|
| `NO_TEST_FIRST` | 实现文件存在但无测试（phase=VIOLATION） |
| `NO_FILES_EXIST` | 无任何文件存在（phase=EMPTY） |
| `INVALID_CYCLE_ORDER` | RED-GREEN-REFACTOR循环顺序错误 |
| `INVALID_COVERAGE_VALUE` | 覆盖率值为null或非有限数 |
| `COVERAGE_OUT_OF_RANGE` | 覆盖率值超出0-100范围 |
| `COVERAGE_BELOW_THRESHOLD` | 覆盖率低于阈值 |

### testResult标准化规则

`_normalizeTestResult()`方法将原始测试结果统一为`'fail'`/`'pass'`/`'unknown'`/`null`：

| 输入类型 | 标准化逻辑 |
|---------|-----------|
| `'fail'`/`'pass'` | 直接返回 |
| `null`/`undefined` | 返回`null` |
| `{failed: N, passed: M}` | failed>0→`'fail'`；passed>0且failed=0→`'pass'` |
| 其他 | 返回`'unknown'` |

## EvidenceVerifier 证据类型详解

### Skill证据需求映射表

| Skill | 所需证据类型 |
|-------|------------|
| `tdd-implement` | `test_output`, `coverage_report` |
| `module-development` | `test_output`, `coverage_report`, `lint_output` |
| `code-review` | `review_report` |
| `verification-before-completion` | `test_output`, `coverage_report`, `lint_output`, `security_check` |
| `bug-fix` | `test_output`, `fix_verification` |
| `security-audit` | `security_report` |
| `integration-testing` | `test_output`, `coverage_report` |
| `deployment` | `deployment_verification`, `health_check` |
| `performance-optimization` | `performance_report` |
| `refactor-code` | `test_output`, `refactor_report` |
| `brainstorming` | `design_document` |
| `requirement-analysis` | `requirement_spec` |
| `architecture-design` | `architecture_document` |
| `documentation` | `document_file` |
| `iterative-deepening` | `quality_score_report`, `convergence_report` |
| `multi-agent-fusion` | `fusion_report`, `agent_affinity_report` |
| `pair-chat` | `pair_chat_report`, `correction_summary` |
| `self-reflection` | `reflection_report`, `improvement_record` |
| `auto-doc-generation` | `document_file`, `dependency_list` |
| `design-md` | `design_document`, `anti_pattern_checklist` |
| `taste-skill` | `aesthetic_score_report`, `design_review` |
| `impeccable` | `design_audit_report`, `polish_diff` |
| `ui-skills` | `component_code`, `accessibility_report` |
| `motion-ai-kit` | `motion_css`, `performance_report` |
| `better-icons` | `icon_selection_report` |
| `cloud-ai-blueprint` | `architecture_document`, `ai_blueprint_document` |
| `ai-prompting` | `prompt_template`, `quality_report` |
| `necessity-review` | `necessity_review_report` |
| `dispatching-parallel` | `parallel_execution_report` |
| `systematic-debugging` | `debug_report`, `root_cause_analysis` |
| `writing-skills` | `skill_definition_document` |
| 未知Skill | `test_output`, `coverage_report`（默认） |

### 软性证据类型

`specification_verified`为软性证据类型（`SOFT_REQUIRED_TYPES`），缺失时不阻塞验证通过，但会影响质量得分。

### 验证流程

```
1. 类型完整性检查 → 提供的证据是否覆盖Skill要求的所有证据类型
2. 内容质量评估 → 证据内容是否详实、具体、一致、可操作
3. 成功标准强度分类 → 强标准（可量化）vs 弱标准（模糊），弱标准需人工确认
4. 规格-代码一致性检查 → 证据中引用的文件路径是否与已知路径匹配
5. 自反思提示生成 → 验证不通过时生成反思提示，驱动Agent补充证据
```

### 成功标准强度分类

**强标准模式**（`STRONG_CRITERIA_PATTERNS`）：

| 模式 | 示例 |
|------|------|
| 测试通过 | `test passes`、`测试通过` |
| 覆盖率数值 | `coverage >= 80`、`覆盖率` |
| Lint零错误 | `lint passes`、`zero error`、`零错误` |
| 全部通过 | `all tests pass` |
| 无违规 | `no error`、`no warning`、`no violation` |
| 规格验证 | `specification verified`、`规格验证` |

**弱标准模式**（`WEAK_CRITERIA_PATTERNS`）：

| 模式 | 示例 |
|------|------|
| 模糊肯定 | `looks good`、`看起来`、`应该可以` |
| 敷衍修复 | `just fix it`、`差不多` |
| 含糊判断 | `seems right`、`好像`、`应该可以` |

**分类逻辑**：匹配强模式→`'strong'`；匹配弱模式→`'weak'`；包含可量化指标（`>=`、`%`、`pass/fail`）→`'strong'`；包含规格关键词→`'strong'`；其他→`'weak'`。弱标准时`requiresHumanConfirmation=true`。

### 内容质量评估维度

| 维度 | 权重 | 检查逻辑 | 严重度 |
|------|------|---------|--------|
| `completeness` | 0.25 | 内容过短（<50字符）的证据比例，短证据>50%额外扣分 | high/medium |
| `specificity` | 0.25 | 缺乏具体术语（长度>5的词<2个）的证据比例，模糊>50%扣分 | medium |
| `consistency` | 0.15 | 同一证据中是否包含矛盾信息（正面+负面信号词且上下文不同） | high |
| `actionability` | 0.15 | 是否包含可操作动作词（fix/implement/add/remove等） | low |
| `memory_code_consistency` | 0.20 | 证据中引用的文件路径是否在已知路径集合中 | high |

### 评分算法

```
综合得分 = typeScore × 0.6 + qualityScore × 0.4

typeScore = (要求类型数 - 缺失类型数) / 要求类型数

qualityScore（无自定义标准时）= 各证据项平均分：
  基础分 0.6
  + 内容长度 >10/30/80字符 各加 0.05
  + 存在metadata 加 0.05
  + 正向信号词（passed/success/complete）加 0.1
  - 负向信号词（failed/error/missing）扣 0.1
  + specification_verified类型含符合关键词 加 0.15

验证通过条件：hardMissing.length === 0 && score >= verificationThreshold
```

### verify()返回值字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `verified` | boolean | 是否验证通过 |
| `score` | number | 综合得分 [0, 1] |
| `typeScore` | number | 类型完整性得分 [0, 1] |
| `qualityScore` | number | 内容质量得分 [0, 1] |
| `missing` | string[] | 缺失的证据类型列表 |
| `qualityIssues` | QualityIssue[] | 质量问题列表 |
| `report` | string | 人类可读的验证报告文本 |
| `evidenceCount` | number | 提供的有效证据数量 |
| `requiredCount` | number | 要求的证据类型数量 |
| `shouldReflect` | boolean | 是否需要自反思 |
| `reflectionPrompt` | string\|null | 自反思提示文本 |
| `criteriaStrength` | 'strong'\|'weak' | 成功标准强度 |
| `requiresHumanConfirmation` | boolean | 弱标准时是否需人工确认 |
| `specificationConformance` | object\|null | 规格一致性信息（含specIds/conformanceScore/driftDetected） |

## FrameworkComplianceChecker 检查维度详解

### 十大规则集

#### 1. 命名规范（NAMING_RULES）

| 规则ID | 级别 | 说明 | 正则 |
|--------|------|------|------|
| `file-kebab-case` | error | 文件名必须使用kebab-case | `checkKebabCase()` |
| `class-pascal-case` | error | 类名必须使用PascalCase | `/^[A-Z][a-zA-Z0-9]*$/` |
| `method-camel-case` | warn | 公共方法必须使用camelCase | `/^[a-z][a-zA-Z0-9]*$/` |
| `private-underscore` | warn | 私有方法必须使用`_`前缀 | — |
| `constant-upper-snake` | error | 模块级常量必须使用UPPER_SNAKE_CASE | `/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/` |
| `event-kebab-case` | error | 事件名必须使用kebab-case | `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` |

#### 2. 结构规则（STRUCTURE_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `use-strict` | error | 文件必须以`'use strict'`开头 |
| `class-export` | warn | 模块应通过`module.exports`导出单个类 |
| `no-external-deps` | error | 生产代码禁止使用外部依赖（仅允许`better-sqlite3`） |
| `src-dir-structure` | warn | 源文件必须在批准的src/子目录中（runtime/gate/permission/web/utils/errors） |

#### 3. 安全规则（SECURITY_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `no-eval` | error | 禁止`eval()`和`Function()`构造函数 |
| `no-dangerous-commands` | error | 危险Shell命令必须使用PermissionGuard |
| `crypto-safe-random` | error | ID生成必须使用`crypto.randomUUID()`而非`Math.random()` |
| `path-traversal-guard` | error | 文件操作必须检查路径遍历 |
| `timing-safe-compare` | warn | Token/密钥比较必须使用`timingSafeEqual` |

#### 4. 持久化规范（PERSISTENCE_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `debounce-write` | warn | 高频写入必须使用防抖 |
| `atomic-write` | warn | 关键数据必须使用原子写入（.tmp + rename） |
| `graceful-shutdown` | error | 含持久化的模块必须实现`flush()`/`shutdown()` |

#### 5. API规范（API_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `cors-headers` | warn | API端点必须设置正确的CORS头 |
| `security-headers` | warn | HTTP响应必须包含安全头 |
| `rate-limit` | warn | API端点应实现速率限制 |
| `input-validation` | error | API输入必须验证 |

#### 6. 错误处理规范（ERROR_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `custom-error-class` | error | 错误必须使用HarnessError子类层次 |
| `error-code-upper` | error | 错误码必须使用UPPER_SNAKE_CASE |
| `capture-stack-trace` | warn | 错误类应调用`Error.captureStackTrace` |

#### 7. Karpathy原则（KARPATHY_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `no-speculative-code` | warn | 禁止超出需求的投机性实现（YAGNI） |
| `no-unused-abstraction` | warn | 抽象必须至少有2个调用者 |
| `no-dead-config` | warn | 配置项必须被代码消费 |
| `file-line-limit` | warn | 文件不超过500行 |
| `no-orphan-cleanup` | warn | 清理自己的孤立代码，不删除预先存在的死代码 |
| `traceability-required` | info | 每行变更应可追溯到用户请求 |
| `change-scope-limit` | warn | 变更文件不应超出请求范围 |
| `code-budget-exceeded` | warn | 新增代码行数不应超出估算预算 |

#### 8. 设计规范（DESIGN_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `no-pure-black` | warn | CSS禁止纯黑#000000 |
| `no-ai-gradient` | warn | CSS禁止AI风格紫蓝渐变 |
| `no-neon-glow` | warn | CSS禁止霓虹发光效果 |
| `no-default-large-shadow` | warn | CSS禁止默认大阴影 |
| `no-oversaturated` | warn | CSS禁止过饱和色彩 |
| `no-system-font` | info | CSS应使用专业字体栈 |
| `design-token-usage` | info | CSS应使用设计令牌变量 |
| `accessibility-contrast` | error | 前端代码必须满足WCAG AA对比度 |
| `accessibility-alt-text` | error | 图片必须有alt属性 |
| `accessibility-focus` | warn | 交互元素必须有焦点样式 |
| `accessibility-reduced-motion` | warn | 动画必须有prefers-reduced-motion回退 |

#### 9. AI劣质代码检测（AI_BAD_CODE_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `empty-catch` | error | 禁止空catch块 |
| `nan-nullish` | error | `parseInt`/`Number`后用`??`不捕获NaN，应使用`\|\|` |
| `placeholder-code` | warn | TODO/FIXME/STUB代码不应标记为完成 |
| `hardcoded-value` | warn | 硬编码配置值应使用常量或环境变量 |
| `silent-promise-catch` | error | `.catch(function() {})`静默吞错误 |

#### 10. 文档完整性（DOC_COMPLETENESS_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `requirement-spec-exists` | error | 模块开发前需求规格文档必须存在 |
| `architecture-doc-exists` | error | 模块开发前架构设计文档必须存在 |
| `no-code-without-spec` | warn | 生产代码不应无对应规格文档 |

### 规则豁免机制

```javascript
const checker = new FrameworkComplianceChecker(projectRoot, {
  exemptions: {
    'file-kebab-case': ['src/legacy/OLDModule.js'],
    'use-strict': ['src/generated/'],
  },
});

checker.addExemption('no-eval', 'src/sandbox/eval-runner.js');
checker.removeExemption('no-eval', 'src/sandbox/eval-runner.js');
```

- 豁免支持文件路径和目录前缀匹配（以`/`结尾）
- 每条规则最多50个豁免条目
- 路径遍历和危险路径不允许豁免

### 合规摘要统计

`getSummary()`返回值：

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 违规总数 |
| `errors` | number | error级别数 |
| `warnings` | number | warn级别数 |
| `infos` | number | info级别数 |
| `errorFiles` | string[] | 含error的文件列表 |
| `warningFiles` | string[] | 含warn的文件列表 |
| `compliant` | boolean | 是否合规（errors===0） |

## GeneratorVerifier 五维度评估

### 正确性维度定义

| 维度 | 权重 | 说明 | 检查提示 |
|------|------|------|---------|
| `logical_correctness` | 0.25 | 逻辑正确性：输出是否在逻辑上自洽，无矛盾 | 检查输出中是否存在逻辑矛盾、循环依赖或自相矛盾的陈述 |
| `requirement_alignment` | 0.20 | 需求对齐度：输出是否满足原始需求的全部要求 | 检查输出是否覆盖了原始需求的所有要点 |
| `boundary_coverage` | 0.15 | 边界覆盖度：是否考虑了边界条件和异常场景 | 检查是否覆盖了边界条件、空值、极端情况 |
| `scenario_coverage` | 0.15 | 场景覆盖度：是否覆盖了所有定义的行为场景 | 检查输出是否覆盖了Given-When-Then场景 |
| `consistency` | 0.15 | 一致性：输出是否与已有代码/文档风格一致 | 检查命名规范、代码风格和架构模式一致性 |
| `completeness` | 0.10 | 完整性：输出是否包含所有必要的部分 | 检查错误处理、文档注释、类型定义等 |

> 权重总和必须为1.0，否则构造时抛出`CONFIG_INVALID`错误。

### 各维度评估方法

#### logical_correctness（逻辑正确性）

检测矛盾指令模式，每匹配一个扣0.3分：

| 模式 | 严重度 | 说明 |
|------|--------|------|
| `必须...不能`（非遗漏类） | critical | 包含矛盾指令 |
| `始终...从不` | high | 包含绝对矛盾 |
| `must...cannot` | critical | 英文矛盾指令 |
| `always...never` | high | 英文绝对矛盾 |
| `required...forbidden` | critical | 英文矛盾指令 |

#### requirement_alignment（需求对齐度）

遍历需求列表，提取关键词（长度>3），检查输出是否覆盖。每条未覆盖需求扣0.2分。

#### boundary_coverage（边界覆盖度）

检测边界信号词：`边界`、`异常`、`空值`、`null`、`undefined`、`error`、`catch`、`fallback`、`default`。无任何边界信号扣0.25分。

#### scenario_coverage（场景覆盖度）

检测场景信号词：`given`、`when`、`then`、`scenario`、`场景`、`前提`、`操作`、`预期`。有需求但无场景扣0.3分；有场景但缺少`scenario_result`类型证据扣0.1分。

#### consistency（一致性）

检测命名风格混用（camelCase与snake_case混用且数量不等），扣0.1分。

#### completeness（完整性）

检查证据类型数量，少于2种扣0.2分。

### 技能-验证Agent映射

| Skill | 验证Agent |
|-------|----------|
| `tdd-implement` | quality-assurance |
| `module-development` | quality-assurance |
| `code-review` | quality-assurance |
| `verification-before-completion` | domain-analyst |
| `bug-fix` | quality-assurance |
| `security-audit` | quality-assurance |
| `integration-testing` | domain-analyst |
| `deployment` | quality-assurance |
| `architecture-design` | quality-assurance |
| `iterative-deepening` | domain-analyst |
| `multi-agent-fusion` | domain-analyst |
| 未知Skill | quality-assurance（默认） |

### 迭代验证循环

```javascript
const verifier = new GeneratorVerifier({ maxIterations: 3, passThreshold: 0.8 });
const loop = verifier.createVerificationLoop(context);

const result = await verifier.executeVerificationLoop(
  loop,
  async (ctx) => regenerateOutput(ctx),  // 重新生成函数
  async (ctx) => customVerify(ctx),       // 自定义验证函数（可选）
);

// result: { converged, iterations, finalResult, totalIterations, error? }
```

- 每轮先验证，通过则`converged=true`
- 未通过且有`generateFn`则重新生成，进入下一轮
- 达到`maxIterations`仍未通过则`converged=false`
- 验证/生成异常时立即终止并返回错误

## DeviationApproval 生命周期

### 状态枚举

| 状态 | 说明 |
|------|------|
| `pending` | 待审批 |
| `approved` | 已批准 |
| `rejected` | 已拒绝 |
| `expired` | 已过期 |
| `revoked` | 已撤销 |

### 严重度枚举

| 严重度 | 说明 |
|--------|------|
| `low` | 低严重度 |
| `medium` | 中严重度（默认） |
| `high` | 高严重度 |

### 完整生命周期流程

```
请求(request) → pending
    ├── 批准(approve) → approved → TTL到期 → expired
    │                                  └── 撤销(revoke) → revoked
    ├── 拒绝(reject) → rejected
    └── 待审批超时(7天) → expired
```

### request(data) — 提交偏差请求

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `data.ruleId` | string | 是 | 违反的规则ID |
| `data.file` | string | 是 | 违规文件路径（必须为安全相对路径） |
| `data.reason` | string | 是 | 偏差原因 |
| `data.proposedAlternative` | string | 否 | 建议的替代方案 |
| `data.severity` | 'low'\|'medium'\|'high' | 否 | 严重度，默认`medium` |
| `data.requestedBy` | string | 否 | 请求人，默认`unknown` |
| `data.ttlDays` | number | 否 | TTL天数，默认14天 |

**特殊逻辑**：若同一ruleId+file已有`approved`状态的偏差，直接返回已有记录（幂等）。

### approve(deviationId, reviewer, comment) — 批准

仅`pending`状态可批准。设置`reviewedBy`、`reviewedAt`、`reviewComment`。

### reject(deviationId, reviewer, comment) — 拒绝

仅`pending`状态可拒绝。

### revoke(deviationId, revoker, reason) — 撤销

仅`approved`状态可撤销。设置`revokedBy`、`revokedAt`、`revokeReason`。

### TTL过期机制

| 场景 | TTL | 说明 |
|------|-----|------|
| 已批准偏差 | 默认14天（可配置） | `expiresAt`到期后自动标记为`expired` |
| 待审批偏差 | 7天（固定） | 超过7天未审批自动过期 |

### 容量管理

- 最大偏差记录数：200（可配置`maxDeviations`）
- 超出时优先驱逐最旧的`rejected`/`expired`记录
- 无可驱逐记录时驱逐最旧的`pending`记录

### 持久化

使用防抖持久化（`debounced-persister`），自动保存到`deviations/deviations.json`。恢复时使用`JsonStoreRestorer`进行损坏检测和自动修复，过滤危险键（`__proto__`、`constructor`、`prototype`）。

### 事件

| 事件名 | 触发时机 |
|--------|---------|
| `deviation-requested` | 提交偏差请求 |
| `deviation-approved` | 批准偏差 |
| `deviation-rejected` | 拒绝偏差 |
| `deviation-revoked` | 撤销偏差 |
| `deviation-expired` | 偏差过期 |
| `persist-error` | 持久化失败 |

## DesignSkillEngine 反模式检测

### 反模式规则集

| 键 | 规则ID | 严重度 | 检测内容 | 修复建议 |
|----|--------|--------|---------|---------|
| `color` | `no-pure-black` | high | 纯黑#000000 | 使用`#09090b`（Zinc-950） |
| `glow` | `no-neon-glow` | high | 霓虹外发光效果 | 使用柔和阴影层次 |
| `gradient` | `no-ai-gradient` | high | 紫蓝AI渐变配色 | 使用单色系或互补色低饱和度渐变 |
| `shadow` | `no-default-shadow` | medium | 大面积默认阴影 | 使用分层阴影系统 |
| `saturation` | `no-oversaturated` | medium | 过饱和色彩 | 降低饱和度至60-80% |
| `font` | `no-system-font` | low | 系统默认字体 | 使用专业字体栈 |

### 设计评分算法

```
基础分 100
- high严重度: 每个问题扣 15分（最多计3个）
- medium严重度: 每个问题扣 8分（最多计3个）
- low严重度: 每个问题扣 3分（最多计3个）

等级: A(≥90) B(≥75) C(≥60) D(≥40) F(<40)
```

> `@media print`块内的匹配会被跳过，不计入违规。

### 无障碍审计

`auditAccessibility(source)`检查项：

| 规则ID | 严重度 | 检测内容 | 修复建议 |
|--------|--------|---------|---------|
| `missing-aria` | high | 缺少ARIA属性 | 添加role、aria-label等 |
| `missing-alt` | high | 图片缺少alt文本 | 为img添加alt属性 |
| `missing-label` | high | 表单控件缺少label | 使用`<label for>`或`aria-label` |
| `no-reduced-motion` | medium | 动画未适配reduced-motion | 添加`@media (prefers-reduced-motion: reduce)` |
| `no-focus-style` | high | 缺少焦点样式 | 添加`:focus-visible`样式 |
| `color-only` | medium | 可能仅依赖颜色传达信息 | 同时使用图标或文字标注 |

无障碍评分：基础100分，high扣20分，medium扣10分，low扣5分。

### 5大设计语言预设

| 预设 | 风格特征 |
|------|---------|
| Apple | 极简、高留白、SF Pro字体、精致动效 |
| Stripe | 渐变精致、Inter字体、专业感 |
| Vercel | 暗色系、高对比、几何感、极简 |
| Notion | 温暖色调、清晰层次、友好感 |
| GitHub | 中性色调、代码优先、功能导向 |

### 设计方差级别

| 级别 | 说明 |
|------|------|
| `conservative` | 保守：严格遵循设计令牌，最小偏差 |
| `balanced` | 平衡：适度创意，保持一致性 |
| `creative` | 创意：允许更多视觉表达 |
| `bold` | 大胆：最大化视觉冲击力 |

### WCAG对比度检查

`checkContrast(fg, bg)`支持`#hex`和`rgb()`/`rgba()`格式：

| 标准 | 对比度要求 |
|------|-----------|
| AA | ≥ 4.5:1 |
| AA Large | ≥ 3:1 |
| AAA | ≥ 7:1 |
| AAA Large | ≥ 4.5:1 |

### CSS生成方法

| 方法 | 说明 |
|------|------|
| `generateResponsiveCSS()` | 生成响应式断点CSS变量 |
| `generateAccessibilityCSS()` | 生成无障碍CSS变量和prefers-reduced-motion回退 |
| `generateComponentCSS(component)` | 生成指定组件的CSS变量 |
| `generateSectionCSS()` | 生成Section组件CSS变量 |
| `generateMotionCSS(preset)` | 生成动效CSS变量（默认smooth预设） |
| `generateDesignMd(options)` | 生成DESIGN.md设计语言文档 |

### polish()自动修正

| 修正项 | 原始 | 修正后 |
|--------|------|--------|
| 纯黑色 | `#000000`/`#000`/`rgb(0,0,0)` | `#09090b`/`rgb(9,9,11)` |
| Arial字体 | `font-family: Arial` | `'Inter', -apple-system, BlinkMacSystemFont, sans-serif` |
| Times New Roman | `font-family: Times New Roman` | `'SF Pro Display', 'Inter', Georgia, serif` |
| ease缓动 | `transition: all 0.Xs ease` | `transition: all 0.Xs cubic-bezier(0.4, 0, 0.2, 1)` |

## 门禁执行顺序

各门禁组件按以下优先级和依赖关系执行：

```
┌──────────────────────────────────────────────────────────────┐
│  Phase 1: TDDGate（最高优先级，TDD强制门禁）                    │
│  ├── check() → RED-GREEN-REFACTOR检测                        │
│  └── checkCoverage() → 覆盖率阈值检测                         │
├──────────────────────────────────────────────────────────────┤
│  Phase 2: EvidenceVerifier（证据充分性验证）                    │
│  ├── verify() → 类型完整性 + 内容质量 + 成功标准强度            │
│  └── 失败时 → 生成自反思提示                                    │
├──────────────────────────────────────────────────────────────┤
│  Phase 3: FrameworkComplianceChecker（框架合规检查）            │
│  ├── checkFile()/checkDirectory() → 十大规则集扫描             │
│  └── checkDocCompleteness() → 文档完整性检查                   │
├──────────────────────────────────────────────────────────────┤
│  Phase 4: GeneratorVerifier（生成输出正确性验证）               │
│  ├── verifyCorrectness() → 六维度加权评估                      │
│  └── executeVerificationLoop() → 迭代验证循环                  │
├──────────────────────────────────────────────────────────────┤
│  Phase 5: DesignSkillEngine（设计质量审计）                     │
│  ├── audit() → 反模式检测 + 评分                               │
│  ├── auditAccessibility() → 无障碍审计                         │
│  └── polish() → 自动修正                                       │
├──────────────────────────────────────────────────────────────┤
│  Phase 6: DeviationApproval（偏差审批，贯穿全流程）              │
│  ├── 任何门禁不通过时可提交偏差请求                              │
│  ├── isApproved() → 检查是否有有效偏差豁免                      │
│  └── expireIfStale() → 过期已失效偏差                           │
└──────────────────────────────────────────────────────────────┘
```

**执行依赖关系**：

- Phase 1不通过 → 阻塞后续所有Phase（TDD是硬性前提）
- Phase 2不通过 → 阻塞Phase 4（证据不足时无法验证正确性）
- Phase 3可独立执行，但error级别违规建议在Phase 4前修复
- Phase 5仅对前端文件生效，可与其他Phase并行
- Phase 6作为豁免通道，可在任何Phase触发

## 配置参数详解

### TDDGate配置

| 参数 | 路径 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | `tdd_config.enabled` | boolean | `true` | 是否启用TDD门禁 |
| `test_coverage_threshold` | `tdd_config.test_coverage_threshold` | number | `0.8` | 测试覆盖率阈值（0-1比例） |
| `red_green_refactor_enforced` | `tdd_config.red_green_refactor_enforced` | boolean | `true` | 是否强制RED-GREEN-REFACTOR |
| `no_code_without_test` | `tdd_config.no_code_without_test` | boolean | `true` | 禁止无测试的代码 |

> 注意：`checkCoverage()`使用0-100范围的数值，`DEFAULT_COVERAGE_THRESHOLD=80`；配置文件中`test_coverage_threshold`使用0-1比例。

### EvidenceVerifier配置

| 参数 | 构造选项 | 类型 | 默认值 | 说明 |
|------|---------|------|--------|------|
| `verificationThreshold` | `options.verificationThreshold` | number | `0.8` | 验证通过阈值 (0, 1] |
| `typeScoreWeight` | `options.typeScoreWeight` | number | `0.6` | 类型完整性权重 |
| `qualityScoreWeight` | `options.qualityScoreWeight` | number | `0.4` | 内容质量权重 |
| `evidenceRequirements` | `options.evidenceRequirements` | object | `EVIDENCE_REQUIREMENTS` | 自定义Skill证据需求映射 |

### GeneratorVerifier配置

| 参数 | 构造选项 | 类型 | 默认值 | 说明 |
|------|---------|------|--------|------|
| `maxIterations` | `options.maxIterations` | number | `3` | 最大验证迭代次数 |
| `passThreshold` | `options.passThreshold` | number | `0.8` | 通过阈值 (0-1) |
| `customVerifiers` | `options.customVerifiers` | object | `VERIFIER_AGENTS` | 自定义验证Agent映射 |
| `maxHistory` | `options.maxHistory` | number | `500` | 最大验证历史记录数 |

### DeviationApproval配置

| 参数 | 构造选项 | 类型 | 默认值 | 说明 |
|------|---------|------|--------|------|
| `maxDeviations` | `options.maxDeviations` | number | `200` | 最大偏差记录数 |
| `defaultTtlDays` | `options.defaultTtlDays` | number | `14` | 默认TTL天数 |
| — | — | — | `7` | 待审批TTL天数（固定） |

### FrameworkComplianceChecker配置

| 参数 | 构造选项 | 类型 | 默认值 | 说明 |
|------|---------|------|--------|------|
| `exemptions` | `options.exemptions` | object | `{}` | 规则豁免映射 |
| — | — | number | `50` | 每条规则最大豁免数 |
| — | — | number | `8000` | 最大结果存储数 |
| — | — | number | `500` | 文件行数上限（Karpathy规则） |
| — | — | number | `20` | 目录遍历最大深度 |

### DesignSkillEngine配置

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `DESIGN_SCORE_CONFIG.BASE` | 设计评分基础分 | 100 |
| `DESIGN_SCORE_CONFIG.HIGH_PENALTY` | high严重度扣分 | 15 |
| `DESIGN_SCORE_CONFIG.MEDIUM_PENALTY` | medium严重度扣分 | 8 |
| `DESIGN_SCORE_CONFIG.LOW_PENALTY` | low严重度扣分 | 3 |
| `DESIGN_SCORE_CONFIG.MAX_ISSUE_COUNT` | 每类问题最大计数量 | 3 |
| `A11Y_SCORE_CONFIG.BASE` | 无障碍评分基础分 | 100 |
| `A11Y_SCORE_CONFIG.HIGH_PENALTY` | 无障碍high扣分 | 20 |
| `A11Y_SCORE_CONFIG.MEDIUM_PENALTY` | 无障碍medium扣分 | 10 |
| `A11Y_SCORE_CONFIG.LOW_PENALTY` | 无障碍low扣分 | 5 |

## 相关文档

- [架构分析-AIProject系统](../architecture/架构分析-AIProject系统.md)
- [模块详解-TDDGate模块](../modules/模块详解-TDDGate模块.md)
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md)
