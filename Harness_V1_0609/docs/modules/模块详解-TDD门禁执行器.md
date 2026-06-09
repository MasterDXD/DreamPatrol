# 模块详解-TDD门禁执行器

> 版本：2.73.4 | 目录：src/gate/ | 文件数：16

---

## 模块定位

TDD门禁执行器（gate子系统）是Harness Engineering多Agent框架的质量防线，将文档中的规则转化为可强制执行的代码。gate子系统负责在模块开发、代码审查、部署上线等关键节点执行质量门禁，确保"测试优先、证据验证、合规达标"的核心原则得到执行。

gate子系统包含15个模块（另有3个已有独立文档：TDDGate、EvidenceVerifier、KarpathyEnhancer），覆盖七大职责域：

| 职责域 | 模块 | 说明 |
|--------|------|------|
| **TDD强制** | tdd-gate.js | RED-GREEN-REFACTOR循环检测、覆盖率验证 |
| **证据验证** | evidence-verifier.js | 完成声明证据验证、成功标准强度分类 |
| **合规检查** | framework-compliance-checker.js, code-review-framework-check.js, shared-rule-helpers.js | 八大维度合规扫描、代码审查自动检查清单、共享规则辅助工具 |
| **设计规范** | design-skill-engine.js, design-tokens.js | 反模式检测、设计令牌体系、CSS生成、无障碍审计 |
| **审批治理** | deviation-approval.js, skill-patch-approval.js | 规则偏差审批、技能补丁生命周期管理 |
| **架构守护** | architecture-boundary-enforcer.js, layer-boundary-guard.js, code-drift-detector.js | 架构边界强制、分层依赖守护、代码漂移检测 |
| **生成验证** | generator-verifier.js | AI生成器输出6维度正确性评估+验证循环 |
| **质量守护** | error-prevention-guard.js, output-conciseness-guard.js | 错误模式预防+反思闭环、输出精简度五维检测 |

## 架构图

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          gate 子系统完整架构                                │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────── 已有独立文档 ───────────────┐                            │
│  │                                             │                            │
│  │  ┌──────────┐  ┌────────────────┐          │                            │
│  │  │ TDDGate  │  │EvidenceVerifier│          │                            │
│  │  │ TDD强制  │◄─┤ 证据验证       │          │                            │
│  │  └────┬─────┘  └───────┬────────┘          │                            │
│  │       │                │                    │                            │
│  │  ┌────┴────────────────┴─────────────┐     │                            │
│  │  │      KarpathyEnhancer             │     │                            │
│  │  │      工程纪律增强器                │     │                            │
│  │  └───────────────────────────────────┘     │                            │
│  │                                             │                            │
│  │  ┌───────────────────────────────────┐     │                            │
│  │  │  FrameworkComplianceChecker       │     │                            │
│  │  │  框架合规检查器                    │     │                            │
│  │  └───────────┬───────────────────────┘     │                            │
│  └──────────────┼──────────────────────────────┘                            │
│                 │ uses                                                      │
│  ┌──────────────┼──────────────────────────────────────────────────────┐   │
│  │              ▼     本文档覆盖的15个模块                              │   │
│  │                                                                    │   │
│  │  ┌─────────────────────── 设计规范层 ──────────────────────────┐   │   │
│  │  │                                                            │   │   │
│  │  │  ┌──────────────────┐      ┌──────────────────┐           │   │   │
│  │  │  │ DesignSkillEngine│─────►│  DesignTokens    │           │   │   │
│  │  │  │ 设计技能引擎     │ uses │  设计令牌(纯数据) │           │   │   │
│  │  │  └──────────────────┘      └──────────────────┘           │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                    │   │
│  │  ┌─────────────────────── 架构守护层 ──────────────────────────┐   │   │
│  │  │                                                            │   │   │
│  │  │  ┌──────────────────────┐                                 │   │   │
│  │  │  │ArchitectureBoundary  │ 域间依赖约束                     │   │   │
│  │  │  │Enforcer              │                                  │   │   │
│  │  │  └──────────┬───────────┘                                 │   │   │
│  │  │             │ 互补                                        │   │   │
│  │  │  ┌──────────┴───────────┐  ┌──────────────────────┐      │   │   │
│  │  │  │ LayerBoundaryGuard   │  │  CodeDriftDetector   │      │   │   │
│  │  │  │ 分层依赖守护         │  │  代码漂移检测        │      │   │   │
│  │  │  └──────────────────────┘  └──────────────────────┘      │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                    │   │
│  │  ┌─────────────────────── 合规检查层 ──────────────────────────┐   │   │
│  │  │                                                            │   │   │
│  │  │  ┌──────────────────────┐  ┌──────────────────────┐       │   │   │
│  │  │  │CodeReviewFramework   │─►│ SharedRuleHelpers    │       │   │   │
│  │  │  │Check 代码审查框架    │uses│ 共享规则辅助(纯工具) │       │   │   │
│  │  │  └──────────────────────┘  └──────────────────────┘       │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                    │   │
│  │  ┌─────────────────────── 审批治理层 ──────────────────────────┐   │   │
│  │  │                                                            │   │   │
│  │  │  ┌──────────────────┐  ┌──────────────────────┐           │   │   │
│  │  │  │DeviationApproval │  │ SkillPatchApproval   │           │   │   │
│  │  │  │ 偏差审批         │  │ 技能补丁审批         │           │   │   │
│  │  │  └──────────────────┘  └──────────────────────┘           │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                    │   │
│  │  ┌─────────────────────── 生成验证层 ──────────────────────────┐   │   │
│  │  │                                                            │   │   │
│  │  │  ┌──────────────────┐                                     │   │   │
│  │  │  │GeneratorVerifier │ 6维度正确性评估+验证循环             │   │   │
│  │  │  └──────────────────┘                                     │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                    │   │
│  │  ┌─────────────────────── 质量守护层 ──────────────────────────┐   │   │
│  │  │                                                            │   │   │
│  │  │  ┌──────────────────────┐  ┌──────────────────────────┐   │   │   │
│  │  │  │ErrorPreventionGuard  │  │OutputConcisenessGuard    │   │   │   │
│  │  │  │ 错误模式预防+反思    │  │ 输出精简度五维检测       │   │   │   │
│  │  │  └──────────────────────┘  └──────────────────────────┘   │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  │                                                                    │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│  依赖：src/utils/ (constants, shutdown-mixin, safe-execute, etc.)          │
│  依赖：src/errors/ (HarnessError, TDDGateError)                            │
│  被依赖：src/index.js (主入口装配)                                          │
│  被依赖：verification-before-completion Skill                              │
└────────────────────────────────────────────────────────────────────────────┘
```

## 模块间交互

### 核心协作流程

```
Agent声称任务完成
       │
       ▼
  ┌─────────┐     TDD合规?     ┌──────────────┐
  │ TDDGate  │────────────────►│EvidenceVerifier│
  │ check()  │                 │  verify()      │
  └────┬─────┘                 └───────┬────────┘
       │                               │
       │ 通过                           │ 验证通过
       ▼                               ▼
  ┌──────────────────┐         ┌──────────────────┐
  │FrameworkCompliance│         │GeneratorVerifier  │
  │Checker checkFile()│         │verifyCorrectness()│
  └────────┬─────────┘         └────────┬─────────┘
           │                            │
           │ 合规                        │ 逻辑正确
           ▼                            ▼
  ┌──────────────────┐         ┌──────────────────┐
  │CodeReviewFramework│        │DesignSkillEngine  │
  │Check runChecklist()│       │audit() / polish() │
  └────────┬─────────┘         └──────────────────┘
           │                            │
           │ 审查通过                    │ 设计达标
           ▼                            ▼
  ┌─────────────────────────────────────────────┐
  │           任务完成 ✓                         │
  │  如有规则偏差 → DeviationApproval.request()  │
  │  如有技能修改 → SkillPatchApproval.submit()  │
  └─────────────────────────────────────────────┘
```

### 架构守护协作

```
代码变更
    │
    ├─► ArchitectureBoundaryEnforcer.enforce()  ── 检查跨域导入
    │         │
    │         ▼
    ├─► LayerBoundaryGuard.checkImport()  ── 检查分层依赖方向
    │         │
    │         ▼
    └─► CodeDriftDetector.detect()  ── 对比基线检测漂移
              │
              ▼
         漂移记录 → 触发修正流程
```

---

## 共同设计模式

### 1. EventEmitter事件驱动

15个模块中有8个继承自`EventEmitter`，通过事件通知状态变更：

| 模块 | 关键事件 |
|------|---------|
| ArchitectureBoundaryEnforcer | `violation`, `whitelist:added` |
| LayerBoundaryGuard | `violation` |
| CodeDriftDetector | `baseline:set`, `drift:detected` |
| CodeReviewFrameworkCheck | `review-created`, `review-completed`, `review-approved`, `review-needs-changes`, `review-rejected`, `check-error` |
| DeviationApproval | `deviation-requested`, `deviation-approved`, `deviation-rejected`, `deviation-revoked`, `deviation-expired`, `persist-error` |
| SkillPatchApproval | `patch-submitted`, `patch-approved`, `patch-rejected`, `patch-applied`, `patch-revoked`, `persist-error` |
| GeneratorVerifier | `verification-complete`, `verification-error` |
| ErrorPreventionGuard | `warnings-injected`, `reflection-recorded` |

### 2. withShutdown优雅关闭

6个模块使用`withShutdown`混入，提供`shutdown()`方法和`_onShutdown()`钩子：

| 模块 | 关闭行为 |
|------|---------|
| DesignSkillEngine | 无特殊清理 |
| CodeReviewFrameworkCheck | flush持久化 |
| DeviationApproval | flush持久化 |
| SkillPatchApproval | flush持久化 + 清空内存 |
| GeneratorVerifier | 清空历史记录 |
| ErrorPreventionGuard | 清空patterns、history和reflections |

### 3. 防抖持久化

3个模块使用`createPersister`实现防抖持久化，避免高频写入：

| 模块 | 存储路径 | 格式 |
|------|---------|------|
| CodeReviewFrameworkCheck | `reviews/reviews.json` | Array |
| DeviationApproval | `deviations/deviations.json` | Array |
| SkillPatchApproval | `.harness/skill-patches/patches.json` | Object |

### 4. 状态机生命周期

2个审批模块采用状态机模式管理实体生命周期：

| 模块 | 状态 | 终态 |
|------|------|------|
| DeviationApproval | pending → approved / rejected → revoked / expired | rejected, revoked, expired |
| SkillPatchApproval | pending → approved → applied / rejected / expired → revoked | rejected, revoked, expired |

### 5. 容量限制与淘汰

所有持久化模块均设置最大记录数，超出时淘汰最旧的终态记录：

| 模块 | 最大记录数 | 淘汰策略 |
|------|-----------|---------|
| CodeReviewFrameworkCheck | 100 | 淘汰最旧的rejected/approved |
| DeviationApproval | 200 | 淘汰最旧的rejected/expired |
| SkillPatchApproval | 200 | 淘汰最旧的rejected/expired/revoked |
| GeneratorVerifier | 500 (历史) | 截断最旧记录 |
| ArchitectureBoundaryEnforcer | 1000 (违规) | FIFO |
| LayerBoundaryGuard | 1000 (违规) | FIFO |
| CodeDriftDetector | 10 (历史快照) | FIFO |
| ErrorPreventionGuard | 500 (模式), 200 (反思), 100 (警告历史) | FIFO |
| OutputConcisenessGuard | 50 (检查历史) | FIFO |

---

## 各模块详解

### 1. tdd-gate.js — TDD强制门禁

**核心职责**：检测RED-GREEN-REFACTOR循环合规性，验证测试覆盖率，强制测试优先原则。核心规则：实现文件必须先有对应的测试文件，否则视为违规。

**类定义**：

```javascript
class TDDGate {
  constructor()
  check(context)              // 主检查方法
  checkCoverage(context)      // 覆盖率验证
  enforceCheck(context)       // 强制检查（不通过抛TDDGateError）
  enforceCoverage(context)    // 强制覆盖率检查
}
```

**check()检查流程**：

```
check(context)
  ├─ 无效context → { passed: false, phase: 'ERROR' }
  ├─ !testExists && implExists → VIOLATION（实现无测试）
  ├─ testExists && !implExists → RED阶段（测试优先，满足要求）
  ├─ testExists && implExists → GREEN阶段（测试需通过）
  └─ !testExists && !implExists → { passed: true, phase: 'EMPTY' }
```

**enforceCheck()错误码映射**：

| phase | 错误码 |
|-------|--------|
| `VIOLATION` | `NO_TEST_FIRST` |
| `EMPTY` | `NO_FILES_EXIST` |
| 其他 | `INVALID_CYCLE_ORDER` |

**checkCoverage()逻辑**：

- coverage和threshold均需为0-100范围内的有限数
- coverage < threshold时返回`{ passed: false }`
- 无效coverage回退值为-1，返回`coverage: null`

**依赖**：`../errors`（TDDGateError）、`../utils/sanitizer`、`../utils/constants`、`../utils/shutdown-mixin`

**详细文档**：[[模块详解-TDDGate模块]]

---

### 2. evidence-verifier.js — 证据验证器

**核心职责**：定义每种Skill所需的证据类型，验证Agent完成声明是否有足够证据支撑，通过多维度质量评估对证据打分，在证据不足时生成自反思提示。与`verification-before-completion` Skill配合使用。

**类定义**：

```javascript
class EvidenceVerifier {
  constructor(options = {})
  verify(context)                    // 验证完成声明的证据
  getRequiredEvidenceTypes(skillId)  // 获取Skill所需证据类型
  setEvidenceRequirements(requirements)  // 设置自定义证据需求
  setVerificationThreshold(threshold)    // 设置验证阈值
  classifyCriteriaStrength(criteriaText) // 分类成功标准强度
}
```

**评分公式**：`score = typeScore × 0.6 + qualityScore × 0.4`

**验证通过条件**：硬性缺失为0 且 综合评分 >= 阈值（默认0.8）

**质量评估维度**（有qualityCriteria时）：

| 维度 | 默认权重 | 说明 |
|------|---------|------|
| completeness | 0.25 | 证据内容是否足够详细（最小50字符） |
| specificity | 0.25 | 证据是否包含具体信息 |
| consistency | 0.15 | 证据内部是否自相矛盾 |
| actionability | 0.15 | 证据是否包含可操作信息 |
| memory_code_consistency | 0.20 | 引用的文件路径是否存在于已知路径集合 |

**成功标准强度分类**：

- **强标准（strong）**：包含可量化指标（test passes、coverage >= N、lint zero error）
- **弱标准（weak）**：模糊表达（make it work、looks good、大概、差不多）
- 弱标准时`requiresHumanConfirmation = true`，需人工确认

**内置证据需求**：覆盖84个Skill，从`tdd-implement`到`writing-skills`

**依赖**：`../utils/shutdown-mixin`、`../utils/safe-execute`（clamp01）、`../utils/safe-assign`

**详细文档**：[[模块详解-EvidenceVerifier模块]]

---

### 3. framework-compliance-checker.js — 框架合规检查器

**核心职责**：自动检查代码是否符合项目规范，涵盖八大检查维度。支持同步/异步检查、目录递归扫描、豁免机制和结果汇总。

**类定义**：

```javascript
class FrameworkComplianceChecker extends EventEmitter {
  constructor(projectRoot, options = {})
  checkFile(filePath)               // 同步单文件检查
  checkFileAsync(filePath)           // 异步单文件检查
  checkDirectory(dirPath)            // 同步目录递归检查
  checkDirectoryAsync(dirPath)       // 异步目录递归检查
  checkProject()                     // 同步全项目检查
  checkProjectAsync()                // 异步全项目检查
  checkNamingConvention(type, name)  // 命名规范检查
  checkDependency(moduleName)        // 依赖检查
  addExemption(ruleId, filePath)     // 添加豁免
  removeExemption(ruleId, filePath)  // 移除豁免
  getExemptions()                    // 获取豁免列表
  getSummary()                       // 获取结果汇总
  getResults()                       // 获取所有结果
}
```

**八大检查维度**：

| 维度 | 规则数 | 关键规则 |
|------|--------|---------|
| 命名规范（NAMING_RULES） | 6 | file-kebab-case, class-pascal-case, constant-upper-snake |
| 结构规则（STRUCTURE_RULES） | 4 | use-strict, no-external-deps, src-dir-structure |
| 安全规则（SECURITY_RULES） | 5 | no-eval, crypto-safe-random, path-traversal-guard |
| 持久化规则（PERSISTENCE_RULES） | 3 | debounce-write, atomic-write, graceful-shutdown |
| API规则（API_RULES） | 4 | cors-headers, rate-limit, input-validation |
| 错误规则（ERROR_RULES） | 3 | custom-error-class, error-code-upper |
| Karpathy规则（KARPATHY_RULES） | 6 | no-speculative-code, file-line-limit, traceability-required |
| 设计规则（DESIGN_RULES） | 8 | no-pure-black, no-ai-gradient, accessibility-contrast |

**批准的src子目录**：`runtime`、`gate`、`permission`、`web`、`utils`、`errors`

**允许的外部依赖**：`better-sqlite3`

**Violation结构**：`{ ruleId, level, description, file, message, timestamp }`

**事件**：`file-checked`、`directory-checked`、`exemption-added`、`exemption-removed`

**依赖**：`./shared-rule-helpers`、`../utils/constants`、`../utils/path-utils`、`../utils/deep-clone`、`../utils/safe-assign`

**详细文档**：[[模块详解-FrameworkComplianceChecker模块]]

---

### 4. DesignSkillEngine — 设计技能引擎

> 文件：src/gate/design-skill-engine.js | 行数：~590行

**核心职责**：前端设计规范的执行引擎，提供六大反模式检测、CSS自动修正（polish）、WCAG对比度检查、无障碍审计、设计语言文档生成、CSS变量生成等能力。与`design-md`、`impeccable`、`taste-skill`、`ui-skills`等Skill配合使用。

#### 构造函数

```javascript
new DesignSkillEngine(projectRoot)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `audit(source, type)` | source: string, type?: string | `AuditResult` | 设计反模式审计，检测6种反模式 |
| `polish(source)` | source: string | `string` | CSS自动修正，替换反模式为推荐值 |
| `normalize(source)` | source: string | `string` | 标准化（polish + 字体注入） |
| `critique(source, focusArea)` | source: string, focusArea?: string | `CritiqueResult` | 设计评审与反馈 |
| `auditAccessibility(source)` | source: string | `A11yAuditResult` | 无障碍审计 |
| `checkContrast(fg, bg)` | fg: string, bg: string | `ContrastResult` | WCAG对比度检查 |
| `generateResponsiveCSS()` | 无 | `string` | 生成响应式CSS变量 |
| `generateAccessibilityCSS()` | 无 | `string` | 生成无障碍CSS |
| `generateComponentCSS(component)` | component: string | `string` | 生成组件令牌CSS |
| `generateSectionCSS()` | 无 | `string` | 生成Section组件CSS |
| `generateMotionCSS(preset)` | preset?: string | `string` | 生成动效CSS |
| `generateDesignMd(options)` | options?: object | `string` | 生成DESIGN.md文档 |
| `searchIcons(query, collection)` | query: string, collection?: string | `IconResult[]` | 图标搜索 |
| `getTypographyScale()` | 无 | `object` | 获取排版比例（深拷贝） |
| `getSpacingScale()` | 无 | `object` | 获取间距比例（深拷贝） |
| `getColorSystem(name)` | name?: string | `object\|null` | 获取色彩系统，无参返回全部 |
| `getMotionPreset(name)` | name?: string | `object\|null` | 获取动效预设 |
| `getDesignVariance(level)` | level?: string | `object\|null` | 获取设计方差级别 |
| `getCompanyDesignLanguage(company)` | company?: string | `object\|null` | 获取公司设计语言预设 |
| `getIconCollections()` | 无 | `string[]` | 获取图标集合列表 |
| `getResponsiveBreakpoints(name)` | name?: string | `object\|null` | 获取响应式断点 |
| `getVisualHierarchy(aspect)` | aspect?: string | `object\|null` | 获取视觉层级 |
| `getComponentTokens(component)` | component?: string | `object\|null` | 获取组件令牌 |
| `getMicroInteractions(name)` | name?: string | `object\|null` | 获取微交互定义 |
| `getAccessibilityStandards(aspect)` | aspect?: string | `object\|null` | 获取无障碍标准 |
| `getInteractionStates(state)` | state?: string | `object\|null` | 获取交互状态定义 |
| `getStats()` | 无 | `object` | 获取统计信息 |

#### 六大反模式检测

| 反模式 | ruleId | 严重度 | 修正建议 |
|--------|--------|--------|---------|
| 纯黑 | `no-pure-black` | high | `#000000` → `#09090b`（Zinc-950） |
| 霓虹外发光 | `no-neon-glow` | high | 使用柔和分层阴影 |
| AI紫蓝渐变 | `no-ai-gradient` | high | 使用单色系低饱和度渐变 |
| 默认大阴影 | `no-default-shadow` | medium | 使用分层阴影系统 |
| 过饱和色彩 | `no-oversaturated` | medium | 降低饱和度至60-80% |
| 系统默认字体 | `no-system-font` | low | 使用专业字体栈 |

#### 审计评分机制

- **基础分**：100分
- **扣分规则**：high扣15分/次，medium扣8分/次，low扣3分/次
- **每种反模式最多计3次**
- **评级**：A(≥90) / B(≥75) / C(≥60) / D(≥40) / F(<40)

#### AuditResult结构

```javascript
{
  score: number,       // 0-100
  issues: [{
    ruleId: string,
    severity: 'high' | 'medium' | 'low',
    count: number,
    message: string,
    fix: string,
    matches: string[]   // 最多5个匹配样本
  }],
  summary: string,
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
}
```

#### polish()自动修正规则

| 原始值 | 修正值 |
|--------|--------|
| `#000000` / `#000` | `#09090b` |
| `rgb(0,0,0)` | `rgb(9,9,11)` |
| `rgba(0,0,0,` | `rgba(9,9,11,` |
| `font-family: Arial` | `font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif` |
| `font-family: Times New Roman` | `font-family: 'SF Pro Display', 'Inter', Georgia, serif` |
| `transition: all Xs ease` | `transition: all Xs cubic-bezier(0.4, 0, 0.2, 1)` |

#### checkContrast()返回值

```javascript
{
  ratio: number,      // 对比度比值，保留2位小数
  aa: boolean,        // ratio >= 4.5
  aaLarge: boolean,   // ratio >= 3
  aaa: boolean,       // ratio >= 7
  aaaLarge: boolean   // ratio >= 4.5
}
```

- 当前景色或背景色为无效颜色值时，返回 `{ ratio: 0, aa: false, aaLarge: false, aaa: false, aaaLarge: false, invalid: true }`
- 有效颜色正常返回对比度计算结果（不含 `invalid` 字段）

**颜色解析支持**：`#RGB`、`#RRGGBB`、`#RRGGBBAA`（忽略alpha）、`rgb(r,g,b)`、`rgba(r,g,b,a)`

#### auditAccessibility()检测项

| ruleId | 严重度 | 检测条件 | 修正建议 |
|--------|--------|---------|---------|
| `missing-aria` | high | 无`aria-`属性 | 添加role、aria-label等 |
| `missing-alt` | high | 有`<img>`但无`alt` | 为img添加alt属性 |
| `missing-label` | high | 有`<input>`但无`<label>` | 使用label for关联 |
| `no-reduced-motion` | medium | 有动画但无prefers-reduced-motion | 添加回退样式 |
| `no-focus-style` | high | 无`:focus`或`:focus-visible` | 添加焦点样式 |
| `color-only` | medium | 有color但无background | 确保不单独依赖颜色 |

**无障碍评分**：基础100分，high扣20分/次，medium扣10分/次，low扣5分/次

#### critique()返回值

```javascript
{
  overallScore: number,
  grade: 'A' | 'B' | 'C' | 'D' | 'F',
  feedback: [{
    area: string,          // color/typography/spacing/motion/layout/consistency
    severity: 'high' | 'medium' | 'low' | 'none',
    issues: number,
    recommendation: string
  }],
  summary: string
}
```

#### generateDesignMd()选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `company` | string | `'vercel'` | 公司设计语言预设 |
| `variance` | string | `'balanced'` | 设计方差级别 |
| `motionIntensity` | number | `5` | 动效强度（1-10） |

#### 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `DESIGN_SCORE_CONFIG.BASE` | 100 | 设计审计基础分 |
| `DESIGN_SCORE_CONFIG.HIGH_PENALTY` | 15 | high级别扣分 |
| `DESIGN_SCORE_CONFIG.MEDIUM_PENALTY` | 8 | medium级别扣分 |
| `DESIGN_SCORE_CONFIG.LOW_PENALTY` | 3 | low级别扣分 |
| `DESIGN_SCORE_CONFIG.MAX_ISSUE_COUNT` | 3 | 每种反模式最大计次 |
| `A11Y_SCORE_CONFIG.BASE` | 100 | 无障碍审计基础分 |
| `A11Y_SCORE_CONFIG.HIGH_PENALTY` | 20 | 无障碍high级别扣分 |
| `A11Y_SCORE_CONFIG.MEDIUM_PENALTY` | 10 | 无障碍medium级别扣分 |
| `A11Y_SCORE_CONFIG.LOW_PENALTY` | 5 | 无障碍low级别扣分 |

#### 静态属性

| 属性 | 说明 |
|------|------|
| `ANTI_PATTERNS` | 反模式规则定义 |
| `TYPOGRAPHY_SCALE` | 排版比例 |
| `SPACING_SCALE` | 间距比例 |
| `COLOR_SYSTEMS` | 色彩系统 |
| `MOTION_PRESETS` | 动效预设 |
| `RESPONSIVE_BREAKPOINTS` | 响应式断点 |
| `VISUAL_HIERARCHY` | 视觉层级 |
| `COMPONENT_TOKENS` | 组件令牌 |
| `MICRO_INTERACTIONS` | 微交互 |
| `ACCESSIBILITY_STANDARDS` | 无障碍标准 |
| `INTERACTION_STATES` | 交互状态 |
| `DESIGN_VARIANCE_LEVELS` | 设计方差级别 |
| `ICON_COLLECTIONS` | 图标集合 |
| `COMPANY_DESIGN_LANGUAGES` | 公司设计语言预设 |

#### 使用示例

```javascript
const DesignSkillEngine = require('./src/gate/design-skill-engine');

const engine = new DesignSkillEngine('/path/to/project');

const auditResult = engine.audit(cssSource);
console.log('评分:', auditResult.score, '评级:', auditResult.grade);

const polished = engine.polish(cssSource);

const contrast = engine.checkContrast('#09090b', '#fafafa');
console.log('对比度:', contrast.ratio, 'AA通过:', contrast.aa);

const a11yResult = engine.auditAccessibility(htmlSource);
console.log('无障碍评分:', a11yResult.score);

const designMd = engine.generateDesignMd({ company: 'stripe', variance: 'creative' });

const critique = engine.critique(cssSource, 'color');
console.log('色彩反馈:', critique.feedback);

engine.shutdown();
```

#### 与其他模块的交互关系

- **DesignTokens**：DesignSkillEngine构造时加载所有设计令牌，查询方法返回令牌的深拷贝
- **FrameworkComplianceChecker**：设计规则（DESIGN_RULES）中的反模式定义与DesignSkillEngine的ANTI_PATTERNS共享同一套规则
- **CodeReviewFrameworkCheck**：代码审查框架的设计合规类别使用DesignSkillEngine的反模式检测逻辑
- **design-md Skill**：调用`generateDesignMd()`生成设计语言文档
- **impeccable Skill**：调用`audit()`和`polish()`进行设计规范落地
- **taste-skill Skill**：调用`critique()`进行审美判断

---

### 5. CodeReviewFrameworkCheck — 代码审查框架

> 文件：src/gate/code-review-framework-check.js | 行数：~560行

**核心职责**：自动代码审查检查清单的实现，覆盖9大审查类别（命名规范、框架合规、安全、错误处理、持久化、API设计、测试覆盖、文档、设计合规），支持自动/手动检查项，审查状态生命周期管理，防抖持久化存储。

#### 构造函数

```javascript
new CodeReviewFrameworkCheck(projectRoot, options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验 |
| `options` | object | 否 | 配置选项 |
| `options.maxReviews` | number | 否 | 最大审查记录数，默认100 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `createReview(data)` | data: object | `Review` | 创建审查 |
| `runChecklist(reviewId)` | reviewId: string | `Review\|null` | 执行检查清单 |
| `approveReview(reviewId, approver, comment)` | reviewId: string, approver: string, comment?: string | `Review\|object\|null` | 批准审查 |
| `requestChanges(reviewId, requester, comment)` | reviewId: string, requester: string, comment?: string | `Review\|null` | 请求修改 |
| `rejectReview(reviewId, rejecter, comment)` | reviewId: string, rejecter: string, comment?: string | `Review\|null` | 驳回审查 |
| `getReview(reviewId)` | reviewId: string | `Review\|null` | 获取审查 |
| `getReviewsByStatus(status)` | status: string | `Review[]` | 按状态查询 |
| `getReviewsByAuthor(author)` | author: string | `Review[]` | 按作者查询 |
| `getStats()` | 无 | `object` | 获取统计 |
| `flush()` | 无 | `void` | 刷盘持久化 |

#### createReview()参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `targetFiles` | string[] | 是 | 目标文件路径列表 |
| `reviewer` | string | 否 | 审查人，默认`'system'` |
| `author` | string | 否 | 作者，默认`'unknown'` |
| `description` | string | 否 | 审查描述 |

#### Review结构

```javascript
{
  id: string,
  targetFiles: string[],
  reviewer: string,
  author: string,
  description: string,
  status: 'pending' | 'in_progress' | 'approved' | 'rejected' | 'needs_changes',
  createdAt: string,
  updatedAt: string,
  checklist: ChecklistItem[],
  findings: Finding[],
  verdict: 'fail' | 'pass-with-warnings' | 'pass' | null
}
```

#### 审查状态生命周期

```
pending ──► in_progress ──► approved
   │              │
   │              ├──► rejected
   │              │
   │              └──► needs_changes
   │
   └──► (runChecklist触发) in_progress
```

**approveReview()前置条件**：审查状态不能为`pending`（需先执行runChecklist）

#### 9大审查类别（REVIEW_CATEGORIES）

| 类别 | 自动检查项 | 关键规则 |
|------|-----------|---------|
| 命名规范（naming-convention） | 4 | file-kebab-case, class-pascal-case, constant-upper-snake, event-kebab-case |
| 框架合规（framework-compliance） | 3 | use-strict, class-export, no-external-deps |
| 安全（security） | 2自动+1手动 | no-eval, crypto-safe-random, path-traversal-guard |
| 错误处理（error-handling） | 0自动+2手动 | custom-error-class, error-code-upper |
| 持久化（persistence） | 0自动+2手动 | debounce-write, graceful-shutdown |
| API设计（api-design） | 0自动+3手动 | cors-headers, security-headers, input-validation |
| 测试覆盖（test-coverage） | 0自动+2手动 | test-exists, test-edge-cases |
| 文档（documentation） | 0自动+1手动 | jsdoc-present |
| 设计合规（design-compliance） | 4自动+4手动 | no-pure-black, no-ai-gradient, accessibility-* |

#### 检查清单动态构建

根据目标文件路径自动判断包含哪些类别：

| 文件类型 | 额外包含类别 |
|---------|------------|
| `src/runtime/`、`src/gate/`、`src/permission/` | 错误处理 + 持久化 |
| `src/web/` | API设计 |
| `test` | 测试覆盖 |

#### 审查结论（verdict）

| 结论 | 条件 |
|------|------|
| `fail` | 存在error级别发现 |
| `pass-with-warnings` | 存在warn级别发现，无error |
| `pass` | 无error和warn |

#### 自动检查规则（RULE_CHECKERS）

| ruleId | 检查逻辑 |
|--------|---------|
| `file-kebab-case` | 使用`checkKebabCase`检测文件名 |
| `class-pascal-case` | 正则匹配`class Name`，验证PascalCase |
| `constant-upper-snake` | 正则匹配`const NAME =`，验证UPPER_SNAKE_CASE |
| `use-strict` | 检查首行是否为`'use strict'` |
| `no-external-deps` | 检测非内置模块的require |
| `no-eval` | 使用`checkNoEval`检测eval/Function |
| `crypto-safe-random` | 使用`checkCryptoSafe`检测Math.random |
| `class-export` | 使用`checkClassExport`检测类未导出 |
| `event-kebab-case` | 检测`.emit()`和`.publish()`的事件名 |
| `no-pure-black` | 检测纯黑颜色值 |
| `no-ai-gradient` | 检测AI风格紫蓝渐变 |
| `no-neon-glow` | 检测大范围霓虹发光 |
| `accessibility-contrast` | 前端文件中提示需手动WCAG验证 |
| `accessibility-alt-text` | 检测img标签缺少alt |
| `accessibility-reduced-motion` | 检测动画缺少reduced-motion回退 |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `review-created` | 审查创建 | `Review`对象 |
| `review-completed` | 检查清单执行完成 | `{ reviewId, verdict, findingCount }` |
| `review-approved` | 审查批准 | `Review`对象 |
| `review-needs-changes` | 请求修改 | `Review`对象 |
| `review-rejected` | 审查驳回 | `Review`对象 |
| `check-error` | 检查项执行出错 | 错误信息 |

#### 持久化

- 存储路径：`reviews/reviews.json`
- 格式：Array
- 防抖间隔：DEFAULT_DEBOUNCE_MS
- 恢复时过滤DANGEROUS_KEYS

#### 静态属性

| 属性 | 说明 |
|------|------|
| `REVIEW_STATUS` | 审查状态枚举 |
| `REVIEW_CATEGORIES` | 审查类别枚举 |
| `MAX_REVIEWS` | 最大审查记录数（100） |

#### 使用示例

```javascript
const CodeReviewFrameworkCheck = require('./src/gate/code-review-framework-check');

const reviewCheck = new CodeReviewFrameworkCheck('/path/to/project');

const review = reviewCheck.createReview({
  targetFiles: ['src/gate/tdd-gate.js', 'src/web/server.js'],
  reviewer: 'domain-analyst',
  author: 'task-worker',
  description: '新增TDD门禁功能',
});
console.log('审查ID:', review.id);

const result = reviewCheck.runChecklist(review.id);
console.log('审查结论:', result.verdict);
console.log('发现数:', result.findings.length);

if (result.verdict === 'pass' || result.verdict === 'pass-with-warnings') {
  reviewCheck.approveReview(review.id, 'team-lead', '代码质量达标');
}

const stats = reviewCheck.getStats();
console.log('审查统计:', stats);

reviewCheck.flush();
reviewCheck.shutdown();
```

#### 与其他模块的交互关系

- **SharedRuleHelpers**：使用`stripCommentsAndStrings`、`checkNoEval`、`checkCryptoSafe`、`checkClassExport`、`checkKebabCase`等共享工具函数
- **FrameworkComplianceChecker**：共享相同的规则定义和检查逻辑，但CodeReviewFrameworkCheck增加了审查生命周期管理
- **DesignSkillEngine**：设计合规类别中的规则与DesignSkillEngine的反模式检测逻辑一致
- **DeviationApproval**：审查不通过时，可通过DeviationApproval请求规则偏差

---

### 6. DeviationApproval — 偏差审批

> 文件：src/gate/deviation-approval.js | 行数：~375行

**核心职责**：管理框架合规规则的偏差审批流程，支持请求→批准→拒绝→撤销→过期完整生命周期，TTL自动过期，防抖持久化。当代码无法完全符合框架规则时（如遗留代码、第三方依赖），通过偏差审批机制进行受控豁免。

#### 构造函数

```javascript
new DeviationApproval(projectRoot, options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验 |
| `options` | object | 否 | 配置选项 |
| `options.maxDeviations` | number | 否 | 最大偏差记录数，默认200 |
| `options.defaultTtlDays` | number | 否 | 批准偏差默认TTL天数，默认14 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `request(data)` | data: object | `Deviation` | 请求偏差 |
| `approve(deviationId, reviewer, comment)` | deviationId: string, reviewer?: string, comment?: string | `Deviation\|null` | 批准 |
| `reject(deviationId, reviewer, comment)` | deviationId: string, reviewer?: string, comment?: string | `Deviation\|null` | 拒绝 |
| `revoke(deviationId, revoker, reason)` | deviationId: string, revoker?: string, reason?: string | `Deviation\|null` | 撤销 |
| `isApproved(ruleId, filePath)` | ruleId: string, filePath: string | `boolean` | 检查是否已批准（含过期检查） |
| `expireIfStale(ruleId, filePath)` | ruleId: string, filePath: string | `boolean` | 过期检查并标记 |
| `getPending()` | 无 | `Deviation[]` | 获取待审批（自动清理超期pending） |
| `getApproved()` | 无 | `Deviation[]` | 获取已批准 |
| `getRejected()` | 无 | `Deviation[]` | 获取已拒绝 |
| `getByRule(ruleId)` | ruleId: string | `Deviation[]` | 按规则查询 |
| `getByFile(filePath)` | ruleId: string | `Deviation[]` | 按文件查询 |
| `getStats()` | 无 | `object` | 获取统计 |
| `flush()` | 无 | `void` | 刷盘持久化 |

#### request()参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ruleId` | string | 是 | 规则ID |
| `file` | string | 是 | 文件路径（必须为安全相对路径） |
| `reason` | string | 是 | 偏差原因 |
| `proposedAlternative` | string | 否 | 建议的替代方案 |
| `severity` | string | 否 | 严重度：`low`/`medium`/`high`，默认`medium` |
| `requestedBy` | string | 否 | 请求者，默认`'unknown'` |
| `ttlDays` | number | 否 | TTL天数，默认使用构造函数配置 |

**安全约束**：
- 文件路径必须为安全相对路径（禁止绝对路径、路径遍历）
- 同一ruleId+file已有approved偏差时直接返回已有记录

#### Deviation结构

```javascript
{
  id: string,                  // 'dev-' + UUID
  ruleId: string,
  file: string,
  reason: string,
  proposedAlternative: string,
  severity: 'low' | 'medium' | 'high',
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked',
  requestedBy: string,
  requestedAt: string,         // ISO时间戳
  expiresAt: string,           // ISO时间戳
  reviewedBy: string|null,
  reviewedAt: string|null,
  reviewComment: string|null,
  revokedBy: string|null,
  revokedAt: string|null,
  revokeReason: string|null,
}
```

#### 偏差状态生命周期

```
pending ──► approved ──► (过期) expired
   │            │
   ├──► rejected    └──► revoked
   │
   └──► (7天未审批) expired
```

| 当前状态 | 允许操作 |
|---------|---------|
| `pending` | approve, reject, 自动过期 |
| `approved` | revoke, 自动过期 |
| `rejected` | （终态） |
| `expired` | （终态） |
| `revoked` | （终态） |

#### TTL机制

| 状态 | TTL | 说明 |
|------|-----|------|
| pending | 7天 | 超期自动标记为expired |
| approved | 可配置（默认14天） | `isApproved()`实时检查，过期返回false |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `deviation-requested` | 偏差请求 | Deviation对象 |
| `deviation-approved` | 偏差批准 | Deviation对象 |
| `deviation-rejected` | 偏差拒绝 | Deviation对象 |
| `deviation-revoked` | 偏差撤销 | Deviation对象 |
| `deviation-expired` | 偏差过期 | Deviation对象 |
| `persist-error` | 持久化出错 | 错误对象 |

#### 持久化

- 存储路径：`deviations/deviations.json`
- 格式：Array
- 恢复时过滤DANGEROUS_KEYS，验证状态合法性，验证文件路径安全性
- 恢复时自动清理超期pending和过期approved

#### 静态属性

| 属性 | 说明 |
|------|------|
| `DEVIATION_STATUS` | 偏差状态枚举 |
| `DEVIATION_SEVERITY` | 偏差严重度枚举 |
| `MAX_DEVIATIONS` | 最大偏差记录数（200） |
| `DEFAULT_TTL_DAYS` | 默认TTL天数（14） |

#### 使用示例

```javascript
const DeviationApproval = require('./src/gate/deviation-approval');

const approval = new DeviationApproval('/path/to/project', {
  defaultTtlDays: 21,
});

const deviation = approval.request({
  ruleId: 'no-external-deps',
  file: 'src/web/server.js',
  reason: '需要better-sqlite3进行数据持久化',
  proposedAlternative: '后续考虑抽象存储层',
  severity: 'medium',
  requestedBy: 'task-worker',
  ttlDays: 30,
});
console.log('偏差ID:', deviation.id);

approval.approve(deviation.id, 'team-lead', '临时允许，30天内重构');
console.log('已批准:', approval.isApproved('no-external-deps', 'src/web/server.js'));

const pending = approval.getPending();
const stats = approval.getStats();
console.log('统计:', stats);

approval.expireIfStale('no-external-deps', 'src/web/server.js');

approval.flush();
approval.shutdown();
```

#### 与其他模块的交互关系

- **FrameworkComplianceChecker**：合规检查发现违规时，可通过DeviationApproval请求偏差
- **CodeReviewFrameworkCheck**：审查不通过时，可通过DeviationApproval请求规则偏差
- **SkillPatchApproval**：互补关系。DeviationApproval管理规则偏差，SkillPatchApproval管理Skill定义变更
- **RBACEnforcer**：偏差审批需检查Agent是否有权限请求/批准偏差

---

### 7. GeneratorVerifier — 生成器验证器

> 文件：src/gate/generator-verifier.js | 行数：~415行

**核心职责**：从6个维度评估AI生成器输出的正确性（逻辑正确性、需求对齐度、边界覆盖度、场景覆盖度、一致性、完整性），支持验证循环（生成→验证→反馈→再生成），确保AI生成输出质量达标。与EvidenceVerifier互补：EvidenceVerifier验证完成证据，GeneratorVerifier验证生成逻辑。

#### 构造函数

```javascript
new GeneratorVerifier(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.maxIterations` | number | 否 | 验证循环最大迭代数，默认3 |
| `options.passThreshold` | number | 否 | 验证通过阈值（0-1），默认0.8 |
| `options.customVerifiers` | object | 否 | 自定义验证Agent映射 |
| `options.maxHistory` | number | 否 | 最大历史记录数，默认500 |

**构造时校验**：CORRECTNESS_DIMENSIONS权重之和必须为1.0，否则抛出`CONFIG_INVALID`错误

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `verifyCorrectness(context)` | context: object | `VerifyResult` | 6维度正确性验证 |
| `createVerificationLoop(context)` | context: object | `VerificationLoop` | 创建验证循环 |
| `executeVerificationLoop(loop, generateFn, verifyFn)` | loop: object, generateFn?: Function, verifyFn?: Function | `Promise<LoopResult>` | 执行验证循环 |
| `getVerifierAgent(skillId)` | skillId: string | `string` | 获取验证Agent |
| `getVerificationHistory(skillId, limit)` | skillId?: string, limit?: number | `HistoryEntry[]` | 查询验证历史 |
| `getStats()` | 无 | `object` | 获取统计 |

#### verifyCorrectness()参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skillId` | string | 否 | Skill ID |
| `generatorAgent` | string | 否 | 生成器Agent名称 |
| `output` | string\|object | 否 | 待验证的输出 |
| `requirements` | string\|string[] | 否 | 需求描述 |
| `evidence` | EvidenceItem[] | 否 | 证据列表 |
| `iteration` | number | 否 | 当前迭代次数 |

#### VerifyResult结构

```javascript
{
  passed: boolean,
  score: number,            // 0-1加权综合评分
  dimensions: {
    [dimName]: {
      score: number,        // 0-1
      weight: number,
      weightedScore: number,
      issues: Issue[],
      checkPrompt: string
    }
  },
  feedback: [{
    dimension: string,
    severity: 'critical' | 'high' | 'medium' | 'low',
    description: string,
    suggestion: string
  }],
  verifierAgent: string,
  generatorAgent: string,
  skillId: string,
  iteration: number,
  summary: string
}
```

#### 6维度正确性评估（CORRECTNESS_DIMENSIONS）

| 维度 | 权重 | 说明 | 检测内容 |
|------|------|------|---------|
| `logical_correctness` | 0.25 | 逻辑正确性 | 矛盾指令（"必须...不能"、"always...never"）、绝对矛盾 |
| `requirement_alignment` | 0.20 | 需求对齐度 | 需求关键词是否在输出中出现 |
| `boundary_coverage` | 0.15 | 边界覆盖度 | 是否考虑null/undefined/error/catch/fallback/default等边界信号 |
| `scenario_coverage` | 0.15 | 场景覆盖度 | 是否包含Given-When-Then结构、场景验证证据 |
| `consistency` | 0.15 | 一致性 | 命名风格是否混用camelCase和snake_case |
| `completeness` | 0.10 | 完整性 | 证据类型是否充足（≥2种） |

#### 逻辑正确性检测模式

| 模式 | 严重度 | 说明 |
|------|--------|------|
| `/必须[^，。；\n]{0,6}不能/` | critical | 中文矛盾指令 |
| `/始终[^，。；\n]{0,6}从不/` | high | 中文绝对矛盾 |
| `/must\s+[^.]*?\bcannot\b/i` | critical | 英文矛盾指令 |
| `/always\s+[^.]*?\bnever\b/i` | high | 英文绝对矛盾 |
| `/required.*forbidden/i` | critical | 英文矛盾指令 |

#### 验证Agent映射（VERIFIER_AGENTS）

| Skill | 验证Agent |
|-------|----------|
| tdd-implement, module-development, code-review, bug-fix, security-audit, deployment, architecture-design | quality-assurance |
| verification-before-completion, integration-testing, iterative-deepening, multi-agent-fusion | domain-analyst |
| 其他（默认） | quality-assurance |

#### 验证循环

```
executeVerificationLoop(loop, generateFn, verifyFn)
  │
  ├─ iteration 1: verifyFn(context) → 未通过?
  │     └─ generateFn(context + feedback) → 新输出
  ├─ iteration 2: verifyFn(context) → 未通过?
  │     └─ generateFn(context + feedback) → 新输出
  ├─ iteration 3: verifyFn(context) → 通过/未通过
  │
  └─ 返回 { converged, iterations, finalResult, totalIterations }
```

- `verifyFn`为null时使用内置`verifyCorrectness`
- `generateFn`为null时不重新生成
- 验证函数或生成函数抛出异常时，循环终止并返回错误信息

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `verification-complete` | 验证完成 | VerifyResult对象 |
| `verification-error` | 验证或生成出错 | 错误信息 |

#### 静态属性

| 属性 | 说明 |
|------|------|
| `VERIFIER_AGENTS` | 验证Agent映射 |
| `CORRECTNESS_DIMENSIONS` | 正确性维度定义 |

#### 使用示例

```javascript
const GeneratorVerifier = require('./src/gate/generator-verifier');

const verifier = new GeneratorVerifier({
  passThreshold: 0.8,
  maxIterations: 3,
});

const result = verifier.verifyCorrectness({
  skillId: 'tdd-implement',
  generatorAgent: 'task-worker',
  output: '实现TDD门禁检查，先写测试再写实现...',
  requirements: ['测试优先', '覆盖率80%以上'],
  evidence: [
    { type: 'test_output', content: 'All tests passed' },
    { type: 'coverage_report', content: 'Line coverage: 92%' },
  ],
});
console.log('通过:', result.passed, '评分:', result.score);
console.log('验证Agent:', result.verifierAgent);
console.log('反馈:', result.feedback);

const loop = verifier.createVerificationLoop({
  skillId: 'tdd-implement',
  output: '初始输出',
  requirements: ['测试优先'],
});

const loopResult = await verifier.executeVerificationLoop(
  loop,
  async (ctx) => '改进后的输出',
  (ctx) => verifier.verifyCorrectness(ctx),
);
console.log('收敛:', loopResult.converged, '迭代:', loopResult.totalIterations);

verifier.shutdown();
```

#### 与其他模块的交互关系

- **EvidenceVerifier**：互补关系。EvidenceVerifier验证完成证据的充分性，GeneratorVerifier验证生成逻辑的正确性
- **DeepeningOrchestrator**：深化推理中使用GeneratorVerifier的验证循环
- **AgentDebugLoop**：自调试闭环中可使用验证循环进行质量检查
- **SkillImprover**：Skill改进时使用GeneratorVerifier验证改进效果

---

### 8. SharedRuleHelpers — 共享规则辅助

> 文件：src/gate/shared-rule-helpers.js | 行数：~48行

**核心职责**：为FrameworkComplianceChecker和CodeReviewFrameworkCheck提供共享的规则检查工具函数，避免重复实现。纯工具模块，无类定义，无状态，所有函数均为纯函数。

#### 导出函数

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `stripCommentsAndStrings(content)` | content: string | `string` | 剥离注释和字符串，返回纯代码 |
| `checkNoEval(stripped)` | stripped: string | `boolean` | 检测eval()或new Function() |
| `checkCryptoSafe(stripped)` | stripped: string | `boolean` | 检测Math.random()用于ID生成 |
| `checkClassExport(content)` | content: string | `boolean` | 检测定义了类但未通过module.exports导出 |
| `checkKebabCase(basename)` | basename: string | `boolean` | 检测文件名不符合kebab-case |

#### stripCommentsAndStrings处理顺序

1. 剥离块注释 `/* ... */`
2. 剥离行注释 `// ...`
3. 剥离单引号字符串 `'...'`
4. 剥离双引号字符串 `"..."`
5. 剥离模板字符串 `` `...` ``（保留`${...}`表达式内容）

#### checkNoEval检测模式

| 正则 | 说明 |
|------|------|
| `/\beval\s*\(/` | 检测`eval(`调用 |
| `/new\s+Function\s*\(/` | 检测`new Function(`构造 |

#### checkCryptoSafe检测逻辑

同时满足两个条件时返回true：
1. 包含`Math.random()`调用
2. 包含ID生成函数名（`_generateId`、`generateId`、`generate.*Id`）

#### checkClassExport检测逻辑

同时满足两个条件时返回true：
1. 包含类定义：`/\bclass\s+[A-Z]/`
2. 不包含模块导出：`/module\.exports\s*=/`

#### checkKebabCase规则

- 文件名需匹配`/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(js|ts|d\.ts|mjs|cjs)$/`
- `index.js`和`index.d.ts`例外
- 返回true表示**不符合**kebab-case（注意：是"违规检测"语义）

#### 使用示例

```javascript
const {
  stripCommentsAndStrings,
  checkNoEval,
  checkCryptoSafe,
  checkClassExport,
  checkKebabCase,
} = require('./src/gate/shared-rule-helpers');

const code = `
'use strict';
const id = Math.random();
class MyHelper {}
`;
const stripped = stripCommentsAndStrings(code);
console.log('eval检测:', checkNoEval(stripped));
console.log('加密安全:', checkCryptoSafe(stripped));
console.log('类导出:', checkClassExport(code));
console.log('kebab-case违规:', checkKebabCase('MyHelper.js'));
```

#### 与其他模块的交互关系

- **FrameworkComplianceChecker**：使用全部5个函数进行内容检查
- **CodeReviewFrameworkCheck**：使用全部5个函数进行自动检查项

---

### 9. SkillPatchApproval — 技能补丁审批

> 文件：src/gate/skill-patch-approval.js | 行数：~440行

**核心职责**：管理Skill定义修改的审批流程，包含tips（建议）和avoidances（避免项）。支持完整的状态机转换（pending→approved→applied→revoked）、TTL自动过期、防抖持久化。与SkillImprover和SkillImprovementLoop配合，确保Skill的持续改进受控。

#### 构造函数

```javascript
new SkillPatchApproval(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.projectRoot` | string | 否 | 项目根目录，提供后启用持久化 |
| `options.pendingTTLDays` | number | 否 | 待审批TTL天数，默认7 |
| `options.approvedTTLDays` | number | 否 | 已批准TTL天数，默认30 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `submit(skillId, patchData)` | skillId: string, patchData: object | `SubmitResult` | 提交补丁 |
| `approve(patchId, reviewer)` | patchId: string, reviewer?: string | `TransitionResult` | 批准 |
| `reject(patchId, reviewer, reason)` | patchId: string, reviewer?: string, reason?: string | `TransitionResult` | 拒绝 |
| `markApplied(patchId)` | patchId: string | `TransitionResult` | 标记已应用 |
| `revoke(patchId, revoker, reason)` | patchId: string, revoker?: string, reason?: string | `TransitionResult` | 撤销 |
| `isApproved(patchId)` | patchId: string | `boolean` | 检查是否已批准（含TTL检查） |
| `getApprovedPatchForSkill(skillId)` | skillId: string | `Patch\|null` | 获取Skill的已批准补丁 |
| `getPendingPatches()` | 无 | `Patch[]` | 获取待审批补丁（按提交时间排序） |
| `getPatch(patchId)` | patchId: string | `Patch\|null` | 获取单个补丁 |
| `getPatchesBySkill(skillId)` | skillId: string | `Patch[]` | 按Skill查询补丁 |
| `attachProjectRoot(projectRoot)` | projectRoot: string | `this` | 延迟附加项目根目录 |
| `getStats()` | 无 | `object` | 获取统计 |
| `isHealthy()` | 无 | `boolean` | 健康检查 |
| `flush()` | 无 | `void` | 刷盘持久化 |

#### submit()参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tips` | string[] | 否 | 建议列表，最多10条，每条最长500字符 |
| `avoidances` | string[] | 否 | 避免项列表，最多10条，每条最长500字符 |
| `count` | number | 否 | 学习次数 |
| `submittedBy` | string | 否 | 提交者，默认`'system'` |

**提交条件**：tips和avoidances至少有一个非空

#### Patch结构

```javascript
{
  patchId: string,          // 'patch-' + 时间戳
  skillId: string,
  state: string,            // pending/approved/rejected/applied/revoked/expired
  tips: string[],
  avoidances: string[],
  learningCount: number,
  submittedAt: string,      // ISO时间戳
  submittedBy: string,
  approvedAt: string|null,
  approvedBy: string|null,
  appliedAt: string|null,
  revokedAt: string|null,
  revocationReason: string|null,
  rejectionReason: string|null,
}
```

#### 状态机（VALID_TRANSITIONS）

```
pending ──► approved ──► applied
   │            │
   ├──► rejected    └──► expired
   │
   ├──► expired (pendingTTLDays=7)
   │
   └──► (approvedTTLDays=30) expired

applied ──► revoked
```

| 当前状态 | 允许转换 |
|---------|---------|
| `pending` | approved, rejected, expired |
| `approved` | applied, expired |
| `rejected` | （终态） |
| `applied` | revoked |
| `revoked` | （终态） |
| `expired` | （终态） |

#### TTL机制

| 状态 | 默认TTL | 说明 |
|------|--------|------|
| pending | 7天 | 超期自动标记为expired（恢复时检查） |
| approved | 30天 | `isApproved()`和`getApprovedPatchForSkill()`实时检查 |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `patch-submitted` | 补丁提交 | `{ patchId, skillId }` |
| `patch-approved` | 补丁批准 | `{ patchId, skillId, approvedBy }` |
| `patch-rejected` | 补丁拒绝 | `{ patchId, skillId, reason }` |
| `patch-applied` | 补丁应用 | `{ patchId, skillId }` |
| `patch-revoked` | 补丁撤销 | `{ patchId, skillId, reason }` |
| `persist-error` | 持久化出错 | 错误对象 |

#### 持久化

- 存储路径：`.harness/skill-patches/patches.json`
- 格式：Object（`{ patches: [...], savedAt, version }`）
- 恢复时过滤DANGEROUS_KEYS，自动过期超期的pending/approved补丁

#### 静态属性

| 属性 | 说明 |
|------|------|
| `PATCH_STATES` | 补丁状态枚举 |
| `VALID_TRANSITIONS` | 合法状态转换映射 |

#### 使用示例

```javascript
const SkillPatchApproval = require('./src/gate/skill-patch-approval');

const spa = new SkillPatchApproval({
  projectRoot: '/path/to/project',
  pendingTTLDays: 5,
  approvedTTLDays: 20,
});

const result = spa.submit('tdd-implement', {
  tips: ['先写测试再写实现', '覆盖率阈值80%'],
  avoidances: ['不要跳过RED阶段', '不要忽略测试失败'],
  count: 15,
  submittedBy: 'skill-improver',
});
console.log('提交结果:', result.success, result.patchId);

spa.approve(result.patchId, 'team-lead');
console.log('已批准:', spa.isApproved(result.patchId));

spa.markApplied(result.patchId);

const approved = spa.getApprovedPatchForSkill('tdd-implement');
console.log('Skill已批准补丁:', approved?.patchId);

spa.flush();
spa.shutdown();
```

#### 与其他模块的交互关系

- **SkillImprover**：SkillImprover生成改进建议后通过SkillPatchApproval提交补丁
- **SkillImprovementLoop**：循环中调用submit()提交改进补丁，调用approve()批准后应用
- **DeviationApproval**：互补关系。SkillPatchApproval管理Skill定义变更，DeviationApproval管理规则偏差

---

### 10. DesignTokens — 设计令牌

> 文件：src/gate/design-tokens.js | 行数：~237行

**核心职责**：定义完整的设计令牌体系，为DesignSkillEngine和前端提供统一的设计变量。纯数据模块，无类定义，无方法，无状态，仅导出13个常量对象。所有令牌数据通过DesignSkillEngine的查询方法以深拷贝形式对外提供。

#### 导出令牌

| 令牌 | 类型 | 说明 | 规模 |
|------|------|------|------|
| `TYPOGRAPHY_SCALE` | object | 排版比例 | 10级（xs→display） |
| `SPACING_SCALE` | object | 间距比例 | 20档（0→64） |
| `COLOR_SYSTEMS` | object | 色彩系统 | 3套×11级（zinc/slate/neutral） |
| `MOTION_PRESETS` | object | 动效预设 | 6种（micro→dramatic） |
| `RESPONSIVE_BREAKPOINTS` | object | 响应式断点 | 6档（xs→2xl） |
| `VISUAL_HIERARCHY` | object | 视觉层级 | 3类（shadows/zIndex/opacity） |
| `COMPONENT_TOKENS` | object | 组件令牌 | 6组件（section/button/input/card/modal/toast） |
| `MICRO_INTERACTIONS` | object | 微交互 | 12种（hover/press/focus/toggle/expand等） |
| `ACCESSIBILITY_STANDARDS` | object | 无障碍标准 | 8项（WCAG AA级） |
| `INTERACTION_STATES` | object | 交互状态 | 8种（idle/hover/active/focus/disabled等） |
| `DESIGN_VARIANCE_LEVELS` | object | 设计方差级别 | 4级（conservative→bold） |
| `ICON_COLLECTIONS` | string[] | 图标集合 | 10套 |
| `COMPANY_DESIGN_LANGUAGES` | object | 公司设计语言预设 | 5套 |

#### TYPOGRAPHY_SCALE详情

| 级别 | size | lineHeight | weight | tracking |
|------|------|------------|--------|----------|
| xs | 0.75rem | 1rem | 400 | 0.01em |
| sm | 0.875rem | 1.25rem | 400 | 0.005em |
| base | 1rem | 1.5rem | 400 | 0em |
| lg | 1.125rem | 1.75rem | 500 | -0.01em |
| xl | 1.25rem | 1.75rem | 600 | -0.01em |
| 2xl | 1.5rem | 2rem | 600 | -0.02em |
| 3xl | 1.875rem | 2.25rem | 700 | -0.02em |
| 4xl | 2.25rem | 2.5rem | 700 | -0.03em |
| 5xl | 3rem | 3.5rem | 800 | -0.04em |
| display | 4.5rem | 5rem | 800 | -0.05em |

#### SPACING_SCALE详情

基于4px网格：0, 0.125rem, 0.25rem, 0.375rem, 0.5rem, 0.75rem, 1rem, 1.25rem, 1.5rem, 2rem, 2.5rem, 3rem, 4rem, 5rem, 6rem, 8rem, 10rem, 12rem, 14rem, 16rem

#### COLOR_SYSTEMS详情

3套色彩系统，每套11级（50→950）：

| 系统 | 色调 | 50级 | 950级 |
|------|------|------|-------|
| zinc | 中性灰 | #fafafa | #09090b |
| slate | 蓝灰 | #f8fafc | #020617 |
| neutral | 纯灰 | #fafafa | #0a0a0a |

#### MOTION_PRESETS详情

| 预设 | duration | easing | 适用场景 |
|------|----------|--------|---------|
| micro | 150ms | cubic-bezier(0.4, 0, 0.2, 1) | 微交互（hover/press） |
| smooth | 300ms | cubic-bezier(0.4, 0, 0.2, 1) | 标准过渡 |
| spring | 500ms | cubic-bezier(0.34, 1.56, 0.64, 1) | 弹性效果 |
| bounce | 600ms | cubic-bezier(0.68, -0.55, 0.265, 1.55) | 弹跳效果 |
| elegant | 700ms | cubic-bezier(0.32, 0.72, 0, 1) | 优雅过渡 |
| dramatic | 1000ms | cubic-bezier(0.16, 1, 0.3, 1) | 戏剧性效果 |

#### RESPONSIVE_BREAKPOINTS详情

| 断点 | minWidth | maxWidth | columns | margin | gutter |
|------|----------|----------|---------|--------|--------|
| xs | 0 | 479 | 4 | 16px | 16px |
| sm | 480 | 767 | 4 | 16px | 16px |
| md | 768 | 1023 | 8 | 24px | 24px |
| lg | 1024 | 1279 | 12 | 32px | 24px |
| xl | 1280 | 1535 | 12 | 48px | 32px |
| 2xl | 1536 | Infinity | 12 | 64px | 32px |

#### VISUAL_HIERARCHY详情

**阴影系统**：xs / sm / md / lg / xl / 2xl / inner（7级分层阴影）

**z-index层级**：base(0) → dropdown(1000) → sticky(1020) → fixed(1030) → modalBackdrop(1040) → modal(1050) → popover(1060) → tooltip(1070) → notification(1080)

**透明度**：disabled(0.5) / placeholder(0.6) / secondary(0.8) / primary(1)

#### COMPONENT_TOKENS详情

6个组件的完整令牌定义：

| 组件 | 变体 | 令牌维度 |
|------|------|---------|
| section | default/collapsible/accent/bordered/hero | spacing, titleSizes, borderRadius, accentColors, animation |
| button | primary/secondary/ghost/danger/outline | sizes, borderRadius, focusRing |
| input | default/filled/flushed | sizes, states |
| card | elevated/outlined/filled | padding, borderRadius |
| modal | — | sizes, overlayOpacity, animation |
| toast | info/success/warning/error | position, duration |

#### MICRO_INTERACTIONS详情

12种微交互定义：hover, press, focus, toggle, expand, collapse, fadeIn, fadeOut, slideIn, slideOut, scaleIn, skeleton

每种包含：scale/duration/easing/from/to等参数

#### ACCESSIBILITY_STANDARDS详情

| 维度 | 标准 |
|------|------|
| WCAG级别 | AA |
| 对比度（正常文字） | 4.5:1 |
| 对比度（大文字） | 3:1 |
| 对比度（UI组件） | 3:1 |
| 触控目标（最小） | 44px |
| 触控目标（推荐） | 48px |
| 最小字号 | 16px |
| 动效偏好 | 尊重prefers-reduced-motion |
| 色彩独立性 | 不单独依赖颜色传达信息 |
| 阅读水平 | 8年级，最大句长25词 |

#### INTERACTION_STATES详情

8种交互状态：idle, hover, active, focus, disabled, loading, error, selected

每种包含：description, opacity, scale, cursor, ring等属性

#### DESIGN_VARIANCE_LEVELS详情

| 级别 | 方差值 | 说明 | 适用场景 |
|------|--------|------|---------|
| conservative | 1-3 | 安全居中布局，标准网格 | 后台管理系统 |
| balanced | 4-5 | 适度创意，微妙偏移和重叠 | 企业官网 |
| creative | 6-7 | 元素重叠，文字偏移，图片大小各异 | 品牌展示 |
| bold | 8-10 | 非对称布局，大面积留白，瀑布流 | 杂志感设计 |

#### ICON_COLLECTIONS详情

10套图标集合：lucide, heroicons, material-design, phosphor, tabler, feather, remix-icon, bootstrap-icons, ionicons, font-awesome

#### COMPANY_DESIGN_LANGUAGES详情

5套公司设计语言预设：

| 公司 | 风格 | 主色 | 圆角 | 间距 | 动效 | 适用场景 |
|------|------|------|------|------|------|---------|
| Apple / Airbnb | 磨砂玻璃、大留白 | #007AFF | 12-20px | generous | spring, 300-500ms | 消费级应用 |
| Stripe | 丝滑渐变、极强排版 | #635BFF | 8-12px | structured | smooth, 200-400ms | 金融科技 |
| Vercel / Linear | 极简黑白、高对比 | #FFFFFF | 4-8px | tight | snappy, 150-300ms | 开发者工具 |
| Notion / Linear | 温暖中性、清晰层次 | #2EAADC | 4-8px | comfortable | subtle, 200-300ms | 生产力工具 |
| GitHub | 功能优先、暗色友好 | #58A6FF | 6px | compact | minimal, 100-200ms | 代码平台 |

#### 使用示例

```javascript
const {
  TYPOGRAPHY_SCALE,
  COLOR_SYSTEMS,
  MOTION_PRESETS,
  COMPANY_DESIGN_LANGUAGES,
} = require('./src/gate/design-tokens');

console.log('排版级别:', Object.keys(TYPOGRAPHY_SCALE));
console.log('Zinc-950:', COLOR_SYSTEMS.zinc[950]);
console.log('平滑动效:', MOTION_PRESETS.smooth);
console.log('Vercel风格:', COMPANY_DESIGN_LANGUAGES.vercel.style);
```

#### 与其他模块的交互关系

- **DesignSkillEngine**：DesignSkillEngine构造时加载所有令牌，查询方法返回令牌的深拷贝
- **FrameworkComplianceChecker**：设计规则中的`no-pure-black`、`no-ai-gradient`等规则与DesignTokens中定义的替代值一致
- **CodeReviewFrameworkCheck**：设计合规类别使用DesignTokens中的标准进行验证
- **前端SPA**：`generateResponsiveCSS()`、`generateAccessibilityCSS()`等生成的CSS变量基于DesignTokens

---

### 11. ArchitectureBoundaryEnforcer — 架构边界强制器

> 文件：src/gate/architecture-boundary-enforcer.js | 行数：~110行

**核心职责**：强制执行架构域间导入规则，防止跨域违规导入。基于预定义的依赖约束矩阵（DEPENDENCY_RULES），检查模块间的导入关系是否合法。支持白名单机制和违规记录管理。

#### 构造函数

```javascript
new ArchitectureBoundaryEnforcer(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.mode` | string | 否 | 执行模式：`strict`/`recommended`/`optional`，默认`recommended` |
| `options.maxViolations` | number | 否 | 最大违规记录数，默认1000 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getModuleForPath(filePath)` | filePath: string | `string\|null` | 根据文件路径提取所属模块名 |
| `isDependencyAllowed(fromModule, toModule)` | fromModule: string\|null, toModule: string\|null | `boolean` | 检查依赖是否被允许 |
| `addWhitelistEntry(fromModule, toModule)` | fromModule: string, toModule: string | `void` | 添加白名单条目 |
| `checkFile(filePath, deps)` | filePath: string, deps: string[] | `Violation[]` | 检查文件的所有依赖是否合法 |
| `getRules()` | 无 | `object` | 获取依赖规则矩阵 |
| `getViolations()` | 无 | `Violation[]` | 获取所有违规记录（浅拷贝） |
| `clearViolations()` | 无 | `void` | 清除违规记录 |

#### 依赖规则矩阵（DEPENDENCY_RULES）

| 模块 | 允许依赖 |
|------|---------|
| `gate` | utils |
| `permission` | utils |
| `runtime` | utils |
| `web` | gate, permission, runtime, utils |
| `utils` | （无） |
| `errors` | （无） |

#### 路径-模块映射（PATH_MODULE_MAP）

| 路径前缀 | 模块名 |
|---------|--------|
| `src/gate/` | gate |
| `src/permission/` | permission |
| `src/runtime/` | runtime |
| `src/web/` | web |
| `src/utils/` | utils |
| `src/errors/` | errors |

#### 依赖判断逻辑

1. `fromModule`或`toModule`为null → 允许（无法识别的模块不限制）
2. 同模块导入 → 允许
3. 在白名单中 → 允许
4. 在DEPENDENCY_RULES[fromModule].allowedDeps中 → 允许
5. 其他 → 拒绝

#### Violation结构

```javascript
{
  fromModule: string,
  toModule: string,
  filePath: string,
  dependency: string
}
```

#### 执行模式（ENFORCEMENT_MODES）

| 模式 | 说明 |
|------|------|
| `strict` | 违规即阻止（抛出`ARCHITECTURE_VIOLATION`错误） |
| `recommended` | 违规转为警告（默认） |
| `optional` | 不执行检查，直接返回空数组 |

#### 边界规则（BOUNDARY_RULES）

| 规则ID | 说明 |
|--------|------|
| `no_upward_import` | 禁止向上层导入 |
| `no_cross_domain` | 禁止跨域导入 |
| `no_circular` | 禁止循环依赖 |
| `single_responsibility` | 单一职责检查 |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `violation` | 检测到违规导入 | `Violation`对象 |
| `whitelist:added` | 白名单条目添加 | `{ from, to }` |

#### 导出

```javascript
module.exports = { ArchitectureBoundaryEnforcer, DEPENDENCY_RULES, ENFORCEMENT_MODES, BOUNDARY_RULES };
```

#### 使用示例

```javascript
const { ArchitectureBoundaryEnforcer } = require('./src/gate/architecture-boundary-enforcer');

const enforcer = new ArchitectureBoundaryEnforcer({ mode: 'strict' });

enforcer.addWhitelistEntry('gate', 'errors');

const violations = enforcer.checkFile('src/gate/tdd-gate.js', [
  '../utils/sanitizer',
  '../web/server',
]);
console.log('违规数:', violations.length);

const module = enforcer.getModuleForPath('src/gate/tdd-gate.js');
console.log('所属模块:', module);

const allowed = enforcer.isDependencyAllowed('gate', 'utils');
console.log('gate→utils允许:', allowed);
```

#### 与其他模块的交互关系

- **LayerBoundaryGuard**：互补关系。ArchitectureBoundaryEnforcer检查域间依赖（gate/web/runtime等），LayerBoundaryGuard检查分层依赖（interaction/business/domain/infrastructure）
- **CodeDriftDetector**：CodeDriftDetector的违规增长检测可消费ArchitectureBoundaryEnforcer的违规记录
- **FrameworkComplianceChecker**：`no-external-deps`规则与架构边界检查互补

---

### 12. LayerBoundaryGuard — 分层依赖守护

> 文件：src/gate/layer-boundary-guard.js | 行数：~112行

**核心职责**：守护分层架构的依赖方向，确保高层模块不直接依赖低层模块。支持两种分层体系：四层架构（Interaction/Business/Domain/Infrastructure）和项目目录层级（runtime/gate/permission/web/utils）。维护清晰的分层边界，防止依赖方向违规。

#### 构造函数

```javascript
new LayerBoundaryGuard(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.strict` | boolean | 否 | 是否严格模式，默认false |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getLayerForPath(modulePath)` | modulePath: string | `string\|null` | 根据路径获取所属层级 |
| `isDependencyAllowed(fromLayer, toLayer)` | fromLayer: string\|null, toLayer: string\|null | `boolean` | 检查层间依赖是否合法 |
| `checkFile(filePath, deps)` | filePath: string, deps: string[] | `Violation[]` | 检查文件的所有依赖是否合法 |
| `getViolations()` | 无 | `Violation[]` | 获取违规记录（浅拷贝） |
| `clearViolations()` | 无 | `void` | 清除违规记录 |
| `getLayers()` | 无 | `object` | 获取层级定义 |
| `getOrder()` | 无 | `string[]` | 获取层级顺序 |

#### 四层架构定义（LAYERS）

| 层级 | level | 说明 |
|------|-------|------|
| `interaction` | 3 | 交互层（Web/API入口） |
| `business` | 2 | 业务层（工作流/协作） |
| `domain` | 1 | 领域层（Agent/因果/上下文等） |
| `infrastructure` | 0 | 基础设施层（工具/底层服务） |

#### 依赖方向规则

高层（level大）可以依赖低层（level小），反之不允许。同层依赖允许。

#### 路径-层级映射（PATH_PREFIX_MAP）

| 路径前缀 | 层级 |
|---------|------|
| `src/web/` | interaction |
| `src/runtime/workflow/` | business |
| `src/runtime/collaboration/` | business |
| `src/runtime/agent/` | domain |
| `src/runtime/causal/` | domain |
| `src/runtime/context/` | domain |
| `src/runtime/deepening/` | domain |
| `src/runtime/model/` | domain |
| `src/runtime/quality/` | domain |
| `src/runtime/session/` | domain |
| `src/runtime/skill/` | domain |
| `src/runtime/thought/` | domain |
| `src/runtime/user/` | domain |
| `src/runtime/infrastructure/` | infrastructure |
| `src/utils/` | infrastructure |

#### 项目目录层级定义（LAYER_DEFINITIONS）

| 模块 | level | 允许依赖 |
|------|-------|---------|
| `runtime` | 0 | （无） |
| `gate` | 1 | runtime |
| `permission` | 1 | runtime |
| `web` | 2 | runtime, gate, permission |
| `utils` | -1 | （工具层，任何层均可依赖） |

#### 违规类型（VIOLATION_TYPES）

| 类型 | 说明 |
|------|------|
| `cross_layer_import` | 跨层导入未在允许列表中 |
| `circular_dependency` | 循环依赖 |
| `unregistered_layer` | 未注册的层级 |
| `direction_violation` | 依赖方向违规（高层导入低层） |

#### Violation结构

```javascript
{
  fromLayer: string,
  toLayer: string,
  filePath: string,
  dependency: string
}
```

#### 严格模式执行

- `strict` 为 true 时：检测到违规后抛出 `LAYER_VIOLATION` 错误，阻止违规依赖通过检查
- `strict` 为 false 时：仅记录违规并发射 `violation` 事件（默认行为，保持向后兼容）

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `violation` | 检测到违规依赖 | `Violation`对象 |

#### 导出

```javascript
module.exports = { LayerBoundaryGuard, LAYERS, LAYER_ORDER, LAYER_DEFINITIONS, VIOLATION_TYPES };
```

#### 使用示例

```javascript
const { LayerBoundaryGuard } = require('./src/gate/layer-boundary-guard');

const guard = new LayerBoundaryGuard({ strict: true });

const layer = guard.getLayerForPath('src/runtime/agent/agent-runtime.js');
console.log('层级:', layer);

const allowed = guard.isDependencyAllowed('interaction', 'domain');
console.log('interaction→domain允许:', allowed);

const violations = guard.checkFile('src/web/server.js', [
  '../runtime/agent/agent-runtime',
  '../utils/constants',
]);
console.log('违规数:', violations.length);

console.log('层级顺序:', guard.getOrder());
```

#### 与其他模块的交互关系

- **ArchitectureBoundaryEnforcer**：互补关系。ArchitectureBoundaryEnforcer检查域间依赖，LayerBoundaryGuard检查分层依赖方向
- **CodeDriftDetector**：漂移检测可消费LayerBoundaryGuard的违规记录
- **FrameworkComplianceChecker**：`src-dir-structure`规则与分层检查互补

---

### 13. CodeDriftDetector — 代码漂移检测器

> 文件：src/gate/code-drift-detector.js | 行数：~115行

**核心职责**：检测代码相对于历史基线的漂移趋势，通过快照对比分析违规增长、模块耦合度变化，自动分类漂移严重度。与ArchitectureBoundaryEnforcer和LayerBoundaryGuard配合，形成"检测→记录→趋势分析→告警"的完整架构守护闭环。

#### 构造函数

```javascript
new CodeDriftDetector(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.maxHistory` | number | 否 | 最大历史快照数，默认10 |
| `options.violationGrowthRate` | number | 否 | 违规增长率告警阈值，默认0.5（50%） |
| `options.moduleCouplingScore` | number | 否 | 模块耦合度告警阈值，默认0.5 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `snapshot(violations, moduleStats, couplingStats)` | violations: array, moduleStats: object, couplingStats: object | `void` | 记录快照 |
| `detectDrift()` | 无 | `DriftResult` | 检测漂移趋势 |
| `getHistory()` | 无 | `Snapshot[]` | 获取历史快照（浅拷贝） |
| `setBaseline(baseline)` | baseline: object | `void` | 设置基线 |
| `getBaseline()` | 无 | `object\|null` | 获取基线 |
| `getThresholds()` | 无 | `object` | 获取告警阈值 |

#### snapshot()参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `violations` | array | 当前违规列表 |
| `moduleStats` | object | 模块统计信息 |
| `couplingStats` | object | 耦合度统计，键为模块名，值为耦合分数 |

#### DriftResult结构

```javascript
{
  drifting: boolean,
  trend: 'increasing' | 'decreasing' | 'stable',
  alerts: [{
    type: 'violation_growth' | 'high_coupling',
    from?: number,           // violation_growth
    to?: number,             // violation_growth
    growthRate?: number,     // violation_growth
    module?: string,         // high_coupling
    score?: number           // high_coupling
  }],
  reason: 'drift_detected' | 'stable' | 'insufficient_history'
}
```

#### 漂移检测逻辑

1. 历史快照不足2个 → 返回`insufficient_history`
2. 对比最近两个快照的违规数量：
   - 前一次0、当前>0 → 违规增长告警
   - 增长率超过`violationGrowthRate` → 违规增长告警
3. 检查当前快照的耦合度：
   - 任一模块耦合分数超过`moduleCouplingScore` → 高耦合告警
4. 计算趋势（需至少3个快照）：
   - 违规数持续上升 → `increasing`
   - 违规数持续下降 → `decreasing`
   - 其他 → `stable`

#### 漂移类型（DRIFT_TYPES）

| 类型 | 说明 |
|------|------|
| `architecture_violation` | 层级变更 |
| `dependency_drift` | 依赖增减 |
| `pattern_drift` | 导出增减 |
| `naming_drift` | 命名变更 |
| `structure_drift` | 结构变更 |

#### 漂移严重度（DRIFT_SEVERITY）

| 严重度 | 说明 |
|--------|------|
| `low` | 轻微漂移 |
| `medium` | 中等漂移 |
| `high` | 严重漂移 |
| `critical` | 关键漂移 |

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `baseline:set` | 基线设置 | baseline对象 |
| `drift:detected` | 漂移检测完成 | DriftResult对象 |

#### 导出

```javascript
module.exports = { CodeDriftDetector, DRIFT_SEVERITY, DRIFT_TYPES };
```

#### 使用示例

```javascript
const { CodeDriftDetector } = require('./src/gate/code-drift-detector');

const detector = new CodeDriftDetector({
  maxHistory: 20,
  violationGrowthRate: 0.3,
  moduleCouplingScore: 0.6,
});

detector.snapshot(
  [{ fromModule: 'gate', toModule: 'web' }],
  { totalModules: 6 },
  { 'gate→web': 0.7 }
);

detector.snapshot(
  [{ fromModule: 'gate', toModule: 'web' }, { fromModule: 'runtime', toModule: 'web' }],
  { totalModules: 6 },
  { 'gate→web': 0.8 }
);

const drift = detector.detectDrift();
console.log('漂移:', drift.drifting, '趋势:', drift.trend);
console.log('告警:', drift.alerts);

detector.setBaseline({ exports: ['TDDGate'], dependencies: ['../errors'], layer: 'gate' });
console.log('阈值:', detector.getThresholds());
```

#### 与其他模块的交互关系

- **ArchitectureBoundaryEnforcer**：消费其违规记录作为snapshot输入
- **LayerBoundaryGuard**：消费其违规记录作为snapshot输入
- **KarpathyEnhancer**：返工率数据可为rework-rate规则提供输入
- **CodeReviewFrameworkCheck**：审查发现可作为漂移检测的数据源

---

### 14. ErrorPreventionGuard — 错误预防守卫

> 文件：src/gate/error-prevention-guard.js | 行数：~190行

**核心职责**：维护全局错误模式注册表，在任务执行前自动检查历史错误模式并注入警告，与DreamEngine闭环集成。通过模式匹配（精确+模糊）检测潜在风险，提前预警防止重复犯错。支持反思记录（reflection），将历史失败经验转化为可检索的上下文提醒。

#### 构造函数

```javascript
new ErrorPreventionGuard(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.dreamEngine` | object | 否 | DreamEngine实例，提供error-avoidance类别笔记加载 |
| `options.minConfidence` | number | 否 | 最低置信度阈值，默认0.5 |
| `options.maxHistory` | number | 否 | 最大警告历史记录数，默认100 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `registerErrorPattern(patternData)` | patternData: object | `object` | 注册错误模式，返回{ id, pattern, description, solution, confidence, registeredAt } |
| `getPatternCount()` | 无 | `number` | 返回已注册模式数 |
| `check(context)` | context: object | `CheckResult` | 检查上下文是否匹配已知错误模式 |
| `loadFromDreamEngine()` | 无 | `number` | 从DreamEngine加载error-avoidance类别笔记，返回加载数 |
| `removePattern(id)` | id: string | `boolean` | 删除指定模式 |
| `getWarningHistory()` | 无 | `array` | 返回警告历史副本 |
| `recordReflection(entry)` | entry: object | `object\|null` | 记录反思条目，同时自动注册为错误模式 |
| `getReflections(category)` | category?: string | `array` | 获取反思记录，可按类别过滤 |
| `getReflectionsAsContext(taskDescription)` | taskDescription: string | `string` | 获取与任务相关的反思，格式化为上下文提醒 |
| `getStats()` | 无 | `object` | 返回统计信息 |
| `isHealthy()` | 无 | `boolean` | 错误数<100返回true |
| `_onShutdown()` | 无 | `void` | 清空patterns、history和reflections |

#### registerErrorPattern()参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | 是 | 错误模式文本，用于匹配检测 |
| `description` | string | 否 | 模式描述 |
| `solution` | string | 否 | 解决方案 |
| `confidence` | number | 否 | 置信度（0-1），默认1.0 |

**容量限制**：超过MAX_PATTERNS（500）时淘汰最旧条目（Map插入顺序）

#### check()参数与返回值

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `context.task` | string | 否 | 任务描述文本，用于模式匹配 |

**CheckResult结构**：

```javascript
{
  safe: boolean,        // 无警告时为true
  warnings: [{
    patternId: string,
    pattern: string,
    description: string,
    solution: string,
    confidence: number
  }]
}
```

#### 模糊匹配算法

1. 将模式文本按空格分词，过滤长度≤2的词
2. 计算匹配词占模式总词数的比例
3. 比例≥50%视为匹配

#### recordReflection()参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `category` | string | 否 | 类别：bugfix/codegen/refactor/test/deploy/config/general，默认general |
| `pattern` | string | 否 | 失败模式 |
| `rootCause` | string | 否 | 根因分析 |
| `solution` | string | 否 | 解决方案 |
| `context` | string | 否 | 上下文描述 |

**副作用**：记录反思时自动以confidence=0.8注册为错误模式

#### 反思类别（REFLECTION_CATEGORIES）

| 类别 | 说明 |
|------|------|
| `bugfix` | 缺陷修复经验 |
| `codegen` | 代码生成经验 |
| `refactor` | 重构经验 |
| `test` | 测试经验 |
| `deploy` | 部署经验 |
| `config` | 配置经验 |
| `general` | 通用经验（默认） |

#### getReflectionsAsContext()输出格式

```markdown
## 历史失败模式提醒
- [bugfix] 模式文本 → 根因: xxx; 解决: xxx
- [codegen] 模式文本 → 根因: xxx; 解决: xxx
```

最多返回5条相关反思。

#### 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_PATTERNS` | 500 | 最大模式注册数 |
| `DEFAULT_MIN_CONFIDENCE` | 0.5 | 默认最低置信度 |
| `DEFAULT_MAX_HISTORY` | 100 | 默认最大警告历史数 |
| `MAX_REFLECTION_ENTRIES` | 200 | 最大反思记录数 |

#### getStats()返回值

```javascript
{
  checksPerformed: number,
  warningsInjected: number,
  patternsRegistered: number,
  errors: number,
  reflectionsRecorded: number,
  totalPatterns: number,
  totalReflections: number
}
```

#### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `warnings-injected` | 检测到匹配模式并注入警告 | `{ warnings, context }` |
| `reflection-recorded` | 反思条目记录完成 | Reflection对象 |

#### 导出

```javascript
module.exports = { ErrorPreventionGuard };
```

#### 使用示例

```javascript
const { ErrorPreventionGuard } = require('./src/gate/error-prevention-guard');

const guard = new ErrorPreventionGuard({
  dreamEngine: dreamEngineInstance,
  minConfidence: 0.6,
  maxHistory: 200,
});

guard.registerErrorPattern({
  pattern: 'eval usage in input validation',
  description: '使用eval处理用户输入存在注入风险',
  solution: '使用JSON.parse或专用解析器替代eval',
  confidence: 0.9,
});

const result = guard.check({ task: 'implement input validation with eval' });
console.log('安全:', result.safe);
if (!result.safe) {
  result.warnings.forEach(w => console.log('警告:', w.description, '→', w.solution));
}

guard.recordReflection({
  category: 'bugfix',
  pattern: 'missing error handling in async',
  rootCause: '未捕获Promise rejection',
  solution: '始终使用try-catch包裹async调用',
});

const ctx = guard.getReflectionsAsContext('implement async handler');
console.log('历史提醒:', ctx);

const loaded = guard.loadFromDreamEngine();
console.log('从DreamEngine加载:', loaded, '条模式');

console.log('统计:', guard.getStats());
console.log('健康:', guard.isHealthy());
```

#### 与其他模块的交互关系

- **DreamEngine**：通过`loadFromDreamEngine()`加载error-avoidance类别笔记，形成"犯错→反思→预防"闭环
- **DreamScheduler**：定时触发DreamEngine回顾时，ErrorPreventionGuard消费其产出的错误避免经验
- **GeneratorVerifier**：验证循环中可使用ErrorPreventionGuard的警告作为反馈输入
- **AgentDebugLoop**：自调试闭环中可使用`check()`在执行前预警，使用`recordReflection()`记录调试经验
- **OutputConcisenessGuard**：互补关系。ErrorPreventionGuard防止逻辑错误重复，OutputConcisenessGuard防止输出冗余

---

### 15. OutputConcisenessGuard — 输出精简度守卫

> 文件：src/gate/output-conciseness-guard.js | 行数：~110行

**核心职责**：对AI输出进行五维精简度检测（Token数/行数/重复率/填充词/注释比），实施冗长惩罚机制。防止AI输出过度冗长、重复或填充无意义内容，确保输出简洁高效。纯工具类模块，不继承EventEmitter，无持久化。

#### 构造函数

```javascript
new OutputConcisenessGuard(options)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.maxTokens` | number | 否 | 最大Token估算数，默认2000 |
| `options.maxLines` | number | 否 | 最大行数，默认100 |
| `options.maxRepetitionRatio` | number | 否 | 最大重复率，默认0.3 |
| `options.penaltyThreshold` | number | 否 | 惩罚阈值（低于此分数视为不精简），默认0.7 |

#### 公共方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `check(output)` | output: string | `CheckResult` | 检查输出精简度 |
| `getHistory()` | 无 | `array` | 返回检查历史副本 |
| `getAverageScore()` | 无 | `number` | 返回平均精简度分数 |

#### check()返回值

```javascript
{
  concise: boolean,       // score >= penaltyThreshold
  score: number,          // 0-1，保留2位小数
  violations: [{
    type: string,         // 违规类型
    value: number,        // 实际值
    limit?: number        // 限制值
  }],
  suggestions: string[],  // 改进建议
  metrics: {
    lineCount: number,
    charCount: number,
    tokenEstimate: number,
    wordCount: number,
    repetitionRatio: number,
    fillerRatio: number,
    codeCommentRatio: number,
    codeLineCount: number
  }
}
```

**空输入处理**：output为null/undefined/非字符串时返回`{ concise: true, score: 1.0, violations: [], suggestions: [] }`

#### 五维违规检测

| 违规类型 | 检测条件 | 扣分 | 说明 |
|---------|---------|------|------|
| `token_limit` | tokenEstimate > maxTokens | -0.3 | Token估算超过上限（字符数÷4） |
| `line_limit` | lineCount > maxLines | -0.2 | 行数超过上限 |
| `repetition` | repetitionRatio > maxRepetitionRatio | -0.25 | 三元组重复率超过阈值 |
| `filler_words` | fillerRatio > 10% | -0.15 | 填充词占比过高 |
| `excessive_comments` | codeCommentRatio > 50% 且 codeLineCount > 10 | -0.1 | 代码注释比过高 |

#### 评分机制

- **基础分**：1.0
- **扣分**：每类违规按上表扣分，可叠加
- **最低分**：0
- **精简判定**：score >= penaltyThreshold（默认0.7）

#### 重复率计算（三元组法）

1. 将输出按空白分词
2. 构建所有连续3词组合（trigram）
3. 统计每个trigram出现次数
4. 重复率 = 重复出现次数 / 总trigram数
5. 词数<4时返回0

#### 填充词检测模式

| 正则 | 说明 |
|------|------|
| `/\b(it's worth noting\|as mentioned\|in summary\|it should be noted\|needless to say\|it goes without saying\|importantly\|basically\|essentially\|fundamentally)\b/gi` | 10种常见填充短语 |

#### 注释比计算

- **注释行**：以`//`、`*`、`/*`开头的行
- **代码行**：非空且非注释行
- **注释比**：注释行数 / 代码行数

#### 检查历史

- 最大记录数：50
- 淘汰策略：FIFO
- 每条记录包含：score、violationCount、timestamp

#### 使用示例

```javascript
const { OutputConcisenessGuard } = require('./src/gate/output-conciseness-guard');

const guard = new OutputConcisenessGuard({
  maxTokens: 1500,
  maxLines: 80,
  maxRepetitionRatio: 0.25,
  penaltyThreshold: 0.75,
});

const result = guard.check(`
  It's worth noting that the implementation follows the standard pattern.
  Basically, the system processes input data and transforms it.
  Essentially, this is a data transformation pipeline.
  Essentially, this is a data transformation pipeline.
  Needless to say, error handling is important.
`);

console.log('精简:', result.concise);
console.log('评分:', result.score);
console.log('违规:', result.violations);
console.log('建议:', result.suggestions);
console.log('指标:', result.metrics);

const history = guard.getHistory();
console.log('检查次数:', history.length);

const avgScore = guard.getAverageScore();
console.log('平均评分:', avgScore);
```

#### 与其他模块的交互关系

- **ErrorPreventionGuard**：互补关系。ErrorPreventionGuard防止逻辑错误重复，OutputConcisenessGuard防止输出冗余
- **OutputConcisenessGuard（规则）**：与`.harness/rules/token-efficiency.md`和`output-conciseness-guard`规则文件配合
- **KarpathyEnhancer**：代码简洁性检查与OutputConcisenessGuard的注释比检测互补
- **ContextCompressionEngine**：上下文压缩时可用OutputConcisenessGuard评估压缩效果

---

## 配置

gate子系统在`.harness/config.json`中的配置节为`gate_config`：

```json
{
  "gate_config": {
    "tdd_gate": {
      "enabled": true,
      "coverage_threshold": 0.8,
      "block_implementation_without_test": true,
      "max_cycles_per_task": 100
    },
    "evidence_verifier": {
      "enabled": true
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tdd_gate.enabled` | boolean | true | 是否启用TDD门禁 |
| `tdd_gate.coverage_threshold` | number | 0.8 | 测试覆盖率阈值 |
| `tdd_gate.block_implementation_without_test` | boolean | true | 无测试时阻止实现 |
| `tdd_gate.max_cycles_per_task` | number | 100 | 每任务最大RED-GREEN循环数 |
| `evidence_verifier.enabled` | boolean | true | 是否启用证据验证 |

各模块内部配置常量：

| 模块 | 常量 | 值 | 说明 |
|------|------|---|------|
| TDDGate | DEFAULT_COVERAGE_THRESHOLD | 80 | 默认覆盖率阈值(%) |
| EvidenceVerifier | verificationThreshold | 0.8 | 验证通过阈值 |
| FrameworkComplianceChecker | MAX_RESULTS | 8000 | 最大结果缓存 |
| FrameworkComplianceChecker | MAX_FILE_LINES | 500 | 文件行数限制 |
| CodeReviewFrameworkCheck | MAX_REVIEWS | 100 | 最大审查记录数 |
| DeviationApproval | MAX_DEVIATIONS | 200 | 最大偏差记录数 |
| DeviationApproval | DEFAULT_TTL_DAYS | 14 | 批准偏差默认TTL |
| DeviationApproval | PENDING_TTL_DAYS | 7 | 待审批偏差TTL |
| SkillPatchApproval | MAX_PATCHES | 200 | 最大补丁记录数 |
| SkillPatchApproval | DEFAULT_PENDING_TTL_DAYS | 7 | 待审批补丁TTL |
| SkillPatchApproval | DEFAULT_APPROVED_TTL_DAYS | 30 | 已批准补丁TTL |
| GeneratorVerifier | passThreshold | 0.8 | 验证通过阈值 |
| GeneratorVerifier | maxIterations | 3 | 验证循环最大迭代数 |
| ArchitectureBoundaryEnforcer | maxLogEntries | 1000 | 最大执行日志条数 |
| CodeDriftDetector | maxRecords | 500 | 最大漂移记录数 |
| ErrorPreventionGuard | MAX_PATTERNS | 500 | 最大模式注册数 |
| ErrorPreventionGuard | DEFAULT_MIN_CONFIDENCE | 0.5 | 默认最低置信度 |
| ErrorPreventionGuard | DEFAULT_MAX_HISTORY | 100 | 默认最大警告历史数 |
| ErrorPreventionGuard | MAX_REFLECTION_ENTRIES | 200 | 最大反思记录数 |
| OutputConcisenessGuard | maxTokens (默认) | 2000 | 最大Token估算数 |
| OutputConcisenessGuard | maxLines (默认) | 100 | 最大行数 |
| OutputConcisenessGuard | maxRepetitionRatio (默认) | 0.3 | 最大重复率 |
| OutputConcisenessGuard | penaltyThreshold (默认) | 0.7 | 惩罚阈值 |

---

## 依赖关系总览

```
gate/
  ├── tdd-gate.js ──────► errors(TDDGateError), utils/sanitizer, utils/constants, utils/shutdown-mixin
  ├── evidence-verifier.js ──► utils/shutdown-mixin, utils/safe-execute, utils/safe-assign
  ├── framework-compliance-checker.js ──► shared-rule-helpers, utils/constants, utils/path-utils,
  │                                       utils/deep-clone, utils/safe-assign, utils/shutdown-mixin
  ├── design-skill-engine.js ──► design-tokens, utils/constants, utils/deep-clone,
  │                              utils/safe-execute, utils/shutdown-mixin
  ├── code-review-framework-check.js ──► shared-rule-helpers, utils/constants,
  │                                      utils/debounced-persister, utils/json-store-restorer,
  │                                      utils/unique-id, utils/shutdown-mixin, errors
  ├── shared-rule-helpers.js ──► （纯工具，无外部依赖）
  ├── deviation-approval.js ──► errors, utils/constants, utils/path-utils,
  │                              utils/debounced-persister, utils/json-store-restorer,
  │                              utils/unique-id, utils/shutdown-mixin, utils/safe-execute
  ├── skill-patch-approval.js ──► utils/constants, utils/fs-utils, utils/debounced-persister,
  │                                utils/json-store-restorer, utils/unique-id,
  │                                utils/shutdown-mixin, utils/safe-execute
  ├── generator-verifier.js ──► errors, utils/safe-assign, utils/safe-execute,
  │                              utils/shutdown-mixin
  ├── design-tokens.js ──► （纯数据，无外部依赖）
  ├── architecture-boundary-enforcer.js ──► events（纯Node.js内置）
  ├── layer-boundary-guard.js ──► events（纯Node.js内置）
  ├── code-drift-detector.js ──► events（纯Node.js内置）
  ├── error-prevention-guard.js ──► events, utils/debug-logger, utils/unique-id
  └── output-conciseness-guard.js ──► （纯工具，无外部依赖）
```

---

## 相关文档

- [[核心功能-TDD门禁执行流程]]
- [[模块详解-TDDGate模块]]
- [[模块详解-EvidenceVerifier模块]]
- [[模块详解-Karpathy增强器]]
- [[模块详解-FrameworkComplianceChecker模块]]
- [[模块详解-工具层辅助模块]] — shared-rule-helpers的工具层定位
- [[模块详解-RBACEnforcer模块]] — 权限执行引擎，与gate子系统协同
- [[模块详解-PermissionGuard模块]] — 文件操作权限守卫
- [[模块详解-DeepeningOrchestrator模块]] — 深化推理中使用GeneratorVerifier
- [[模块详解-SessionManager会话管理器]] — 会话阶段转换时触发TDD门禁
- [[模块详解-PhaseOrchestrator阶段编排器]] — 六阶段流程中强制TDD门禁
- [[模块详解-技能子系统]] — SkillImprover/SkillImprovementLoop与SkillPatchApproval协同

---

## 缺陷修复记录

### Round 5 缺陷修复记录

> 本轮修复涉及TDD门禁子系统中7个模块的关键缺陷，涵盖eval检测绕过、NaN处理、正则匹配、空catch检测、文件路径误判、RGB溢出和零阈值除零等问题。

#### SharedRuleHelpers — 模板字符串eval检测绕过修复

**缺陷**：`stripCommentsAndStrings` 在剥离模板字符串时，将 `` `...` `` 整体移除，包括其中的模板表达式 `${...}`。这导致包含 `eval()` 或 `new Function()` 调用的模板表达式（如 `` `code: ${eval(input)}` ``）被完全剥离，后续 `checkNoEval` 检测无法发现这些危险调用，形成eval检测绕过。

**修复**：`stripCommentsAndStrings` 在处理模板字符串时，保留 `${...}` 表达式内容。具体实现为：剥离模板字符串的字面量部分，但将 `${...}` 中的表达式内容保留在输出中，确保 `checkNoEval` 能正确检测模板表达式内的eval调用。

**影响范围**：模板字符串中的eval/Function调用不再被注释剥离逻辑隐藏，安全审计更准确。

#### SkillPatchApproval — NaN learningCount 修复

**缺陷**：`submit()` 方法在计算 `learningCount` 时使用 `?? 0`（nullish coalescing），但 `parseInt(patchData.count)` 返回 `NaN` 时，`NaN ?? 0` 仍为 `NaN`（因为 `NaN` 不是 `null` 或 `undefined`），导致 `learningCount` 字段存储了 `NaN` 值。

**修复**：将 `?? 0` 改为 `|| 0`，利用 `NaN` 的 falsy 特性正确回退到默认值 0。

**影响范围**：`learningCount` 字段不再出现 `NaN`，统计和持久化数据更可靠。

#### CodeReviewFrameworkCheck — 作用域npm包检测正则修复

**缺陷**：`no-external-deps` 检查中的npm包名检测正则无法正确匹配作用域包（如 `@scope/package`），导致作用域包的引入被漏检。

**修复**：修正正则表达式，支持 `@scope/package` 格式的匹配，确保作用域npm包的引入能被正确检测。

**影响范围**：代码审查中作用域npm包的引入不再被漏检，外部依赖检查更完整。

#### FrameworkComplianceChecker — 外部依赖检查与空catch检测修复

**缺陷1**：`_checkExternalDeps` 方法使用手动的注释剥离逻辑（简易正则），与 `SharedRuleHelpers.stripCommentsAndStrings` 的完整剥离逻辑不一致，可能导致注释中的require被误检为外部依赖。

**修复1**：`_checkExternalDeps` 改为调用 `stripCommentsAndStrings` 进行注释和字符串剥离，与CodeReviewFrameworkCheck使用相同的剥离逻辑，确保一致性。

**缺陷2**：空catch块检测仅支持单行模式 `catch(e){}`，无法匹配多行空catch块（如 `catch(e) {\n}`），导致多行空catch被漏检。

**修复2**：空catch检测正则增加多行匹配支持，能正确识别跨行的空catch块。

**影响范围**：外部依赖检查更准确（不再误报注释中的require）；空catch检测覆盖多行模式。

#### EvidenceVerifier — 文件路径检测误判修复

**缺陷**：文件路径检测正则将URL中的路径分隔符（如 `https://example.com/path`）误判为文件路径引用，导致URL被错误地识别为证据文件路径。

**修复**：文件路径检测正则新增负向前瞻 `(?!\/)`，排除以 `/` 开头的路径（URL特征），仅匹配相对路径和绝对文件路径。

**影响范围**：证据验证不再将URL误判为文件路径，减少误报。

#### DesignSkillEngine — RGB溢出与动画空指针修复

**缺陷1**：`polish()` 方法中的RGB替换逻辑未对RGB值进行范围校验，当输入值超出0-255范围时，生成的CSS颜色值无效。

**修复1**：RGB值现在使用 `Math.max(0, Math.min(255, value))` 进行范围钳制（clamping），确保输出值始终在0-255范围内。

**缺陷2**：`generateSectionCSS()` 方法访问 `tokens.animation` 时未进行空值检查，当设计令牌中未定义 `animation` 字段时抛出 `TypeError`。

**修复2**：新增 `tokens.animation` 空值检查，未定义时跳过动画相关CSS生成。

**影响范围**：CSS生成不再产生无效颜色值；缺少动画令牌时不再崩溃。

#### KarpathyEnhancer — 零阈值除零修复

**缺陷**：评分计算中使用 `score = actual / threshold` 公式，当 `threshold` 为 0 时触发除零错误，导致评分为 `Infinity` 或 `NaN`。

**修复**：零阈值现在表示"无约束"语义——当 `threshold === 0` 时，直接返回满分 `score = 1`，而非执行除法运算。

**影响范围**：阈值为0的检查项不再导致评分异常，语义更清晰（0阈值=不限制）。

### Round 7 — 同步化修复与分级执行实现

本轮变更涉及TDD门禁子系统中4个模块的关键修复，涵盖同步化改造、正则扩展和分级执行实现。

#### FrameworkComplianceChecker — checkFile()同步化修复

**缺陷**：`checkFile()` 方法内部调用 `fs.readFileSync` 读取文件内容后，将内容传递给 `_checkFileContent()` 进行规则检查。但 `_checkFileContent()` 被定义为 `async` 函数，而 `checkFile()` 未使用 `await` 等待其结果，导致规则检查结果（Promise对象）被直接返回而非实际检查结果，所有文件检查均返回空数组（无违规），合规检查形同虚设。

**修复**：
1. 新增 `_checkFileContentSync()` 同步方法，替代原 `_checkFileContent()` 异步方法，在 `checkFile()` 中直接调用同步版本
2. `checkFile()` 改为同步调用链，确保规则检查结果正确返回
3. `checkDirectory()` 同步化：原实现中 `checkDirectory()` 调用 `checkFile()` 后对结果进行 `Promise.all()` 处理，但 `checkFile()` 实际返回同步结果，`Promise.all()` 包装无意义。修复后 `checkDirectory()` 直接收集同步结果

**影响范围**：`checkFile()` 和 `checkDirectory()` 现在正确返回违规列表，框架合规检查功能恢复有效。

#### SharedRuleHelpers — kebab-case正则支持多扩展名

**缺陷**：`checkKebabCase()` 的正则表达式 `/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.js$/` 仅匹配 `.js` 扩展名，导致 `.ts`、`.d.ts`、`.mjs`、`.cjs` 等扩展名的文件始终被判定为不符合 kebab-case 命名规范，产生大量误报。

**修复**：正则表达式更新为 `/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(js|ts|d\.ts|mjs|cjs)$/`，支持 `.js`、`.ts`、`.d.ts`、`.mjs`、`.cjs` 五种扩展名。`index.js` 和 `index.d.ts` 例外规则保持不变。

**影响范围**：TypeScript 定义文件、ESM 和 CommonJS 模块文件不再被误判为命名违规。

#### ArchitectureBoundaryEnforcer — _mode分级执行实现

**缺陷**：构造函数接受 `mode` 参数（`strict`/`recommended`/`optional`），但 `checkFile()` 方法中未根据 `mode` 值执行不同的处理逻辑——所有模式均执行相同的违规检测和记录，`strict` 模式不阻止违规，`optional` 模式不跳过检查，`mode` 参数形同虚设。

**修复**：实现分级执行逻辑：
- `strict` 模式：检测到违规后抛出 `ARCHITECTURE_VIOLATION` 错误，阻止违规代码通过检查
- `recommended` 模式：检测到违规后记录违规并发射 `violation` 事件（默认行为，保持向后兼容）
- `optional` 模式：跳过检查，直接返回空数组

**影响范围**：`strict` 模式现在真正阻止架构违规；`optional` 模式不再产生无意义的违规记录。

#### LayerBoundaryGuard — _strict模式执行实现

**缺陷**：构造函数接受 `strict` 布尔参数，但 `checkFile()` 方法中未根据 `strict` 值执行不同逻辑——无论 `strict` 为 true 或 false，均仅记录违规并发射事件，严格模式下不阻止违规依赖。

**修复**：实现严格模式执行逻辑：
- `strict` 为 true 时：检测到违规后抛出 `LAYER_VIOLATION` 错误，阻止违规依赖通过检查
- `strict` 为 false 时：仅记录违规并发射 `violation` 事件（默认行为，保持向后兼容）

**影响范围**：`strict: true` 配置现在真正阻止分层违规依赖，架构守护更有效。

### Round 9 缺陷修复记录

#### TDDGate — enforceCoverage精确错误码

**缺陷**：`enforceCoverage()` 方法在覆盖率检查未通过时，统一使用模糊的错误码（如通用的 `COVERAGE_CHECK_FAILED`），调用方无法根据错误码区分失败原因（无效值、越界、低于阈值），不利于自动化错误处理和诊断。

**修复**：`enforceCoverage()` 现在根据 `checkCoverage()` 返回结果的具体情况，使用三种精确错误码：
- `INVALID_COVERAGE_VALUE`：coverage值为null/undefined，无法进行有效比较
- `COVERAGE_OUT_OF_RANGE`：coverage值超出0-100有效范围
- `COVERAGE_BELOW_THRESHOLD`：coverage值有效但低于阈值

**影响范围**：调用方可根据错误码精确区分覆盖率检查失败的原因，实现差异化的错误处理策略（如自动修正无效值、提示越界、触发补充测试等）。
