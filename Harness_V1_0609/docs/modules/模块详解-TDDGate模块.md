# 模块详解-TDDGate模块

> 版本：2.73.4 | 文件：src/gate/tdd-gate.js

---

## 模块定位

TDDGate是TDD强制门禁的核心实现，检测RED-GREEN-REFACTOR违规，验证测试覆盖率。核心规则：实现文件必须先有对应的测试文件，否则视为违规。

## 核心能力

| 能力 | 说明 |
|------|------|
| **RED检测** | 检测是否有测试文件且测试失败 |
| **GREEN检测** | 检测测试是否通过 |
| **REFACTOR检测** | 检测重构后测试是否仍通过 |
| **覆盖率验证** | 检查测试覆盖率是否达标 |
| **强制检查** | enforceCheck不通过时抛出TDDGateError异常 |
| **结果归一化** | 支持多种测试结果格式（字符串/对象/null），统一转换为标准格式 |

## 类定义

```javascript
class TDDGate {
  constructor()
  _normalizeTestResult(testResult)
  _resolveTestOnlyPhase(normalized)
  _resolveBothExistPhase(normalized)
  check(context)
  checkCoverage(context)
  enforceCheck(context)
  enforceCoverage(context)
  isHealthy()
  shutdown()
}
```

## 辅助方法

### `_normalizeTestResult(testResult)`

归一化测试结果，将多种输入格式统一转换为标准格式。

**输入支持：**

| 输入类型 | 示例 | 输出 |
|---------|------|------|
| 字符串 `'pass'` | `'pass'` | `'pass'` |
| 字符串 `'fail'` | `'fail'` | `'fail'` |
| `null` / `undefined` | `null` | `null` |
| 对象 `{passed, failed}` | `{passed: 3, failed: 0}` | `'pass'` / `'fail'`（根据failed>0判断） |
| 其他 | 任意 | `'unknown'` |

**对象类型判断规则：** `failed > 0` → `'fail'`；`passed > 0 && failed === 0` → `'pass'`。

### `_resolveTestOnlyPhase(normalized)`

处理测试文件存在但实现文件不存在的情况（testExists=true, implExists=false）。TDD门禁的核心目的是强制"测试优先"，测试文件存在即满足要求。

| normalized | passed | phase | reason |
|-----------|--------|-------|--------|
| `'fail'` | `true` | `'RED'` | Test fails as expected (RED phase) |
| `'pass'` | `true` | `'RED'` | Test written, awaiting implementation (test already passes) |
| `null` | `false` | `'UNKNOWN'` | Test exists but has not been run |
| `'unknown'` | `true` | `'RED'` | Test written, awaiting implementation |

> **行为变更说明：** 当 testExists=true && implExists=false && testResult='pass' 时，现在返回 `passed:true`（测试已写，等待实现），而非之前的 `passed:false`（意外状态）。这是因为TDD门禁的核心目的是强制"测试优先"，测试文件存在即满足要求，测试通过不代表违规。

### `_resolveBothExistPhase(normalized)`

处理测试文件和实现文件都存在的情况（testExists=true, implExists=true）。

| normalized | passed | phase | reason |
|-----------|--------|-------|--------|
| `'pass'` | `true` | `'GREEN'` | Test passes (GREEN phase) |
| `'fail'` | `false` | `'RED'` | Implementation exists but test still fails |
| `null` | `false` | `'UNKNOWN'` | Implementation and test exist but test result is unknown — run tests first |
| `'unknown'` | `false` | `'ERROR'` | Unexpected test result |

## check() 方法

主检查方法，根据测试文件和实现文件的存在状态及测试结果，判断TDD合规性。

**检查流程：**

```
check(context)
  ├─ 无效context → { passed: false, phase: 'ERROR' }
  ├─ !testExists && implExists → VIOLATION（实现无测试）
  ├─ testExists && !implExists → _resolveTestOnlyPhase(_normalizeTestResult(testResult))
  ├─ testExists && implExists → _resolveBothExistPhase(_normalizeTestResult(testResult))
  └─ !testExists && !implExists → { passed: true, phase: 'EMPTY' }
```

**输入context字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `implFile` | string | 实现文件路径（经sanitizeFilePath消毒） |
| `testFile` | string | 测试文件路径（经sanitizeFilePath消毒） |
| `testExists` | boolean | 测试文件是否存在 |
| `implExists` | boolean | 实现文件是否存在 |
| `testResult` | string/object/null | 测试结果（支持多种格式，经_normalizeTestResult归一化） |

## 检查结果

```javascript
{
  passed: boolean,
  violations: string[],
  phase: 'RED' | 'GREEN' | 'REFACTOR' | 'VIOLATION' | 'EMPTY' | 'UNKNOWN' | 'ERROR',
  reason: string,
  coverage: { lines: number, functions: number, branches: number }
}
```

## enforceCheck() 方法

强制检查，不通过时抛出TDDGateError异常。

**错误码映射：**

| phase | 错误码 |
|-------|--------|
| `VIOLATION` | `NO_TEST_FIRST` |
| `EMPTY` | `NO_FILES_EXIST` |
| 其他 | `INVALID_CYCLE_ORDER` |

> **行为变更说明：** EMPTY phase 现在映射到 `'NO_FILES_EXIST'` 错误码（而非之前的 `'NO_TEST_FIRST'`），更准确地描述"尚无任何文件"的状态。

## checkCoverage() 方法

验证测试覆盖率是否达标。

**无效coverage处理：**

- 当 `context.coverage` 不是数字时，回退值为 `-1`
- 当 coverage 为 `-1`（非有限数）时，返回 `coverage: null`
- coverage 和 threshold 均需在 0-100 范围内

```javascript
checkCoverage(context)
  ├─ 无效context → { passed: false, coverage: 0, threshold: DEFAULT_COVERAGE_THRESHOLD }
  ├─ coverage非数字 → coverage = -1 → { passed: false, coverage: null }
  ├─ coverage < 0 或 > 100 → { passed: false, coverage }
  ├─ threshold < 0 或 > 100 → { passed: false, coverage }
  ├─ coverage < threshold → { passed: false, coverage, threshold }
  └─ coverage >= threshold → { passed: true, coverage, threshold }
```

## 配置

```json
{
  "tdd_config": {
    "enabled": true,
    "test_coverage_threshold": 0.8,
    "red_green_refactor_enforced": true,
    "no_code_without_test": true,
    "delete_prewritten_implementation": true
  }
}
```

## 相关文档

- [核心功能-TDD门禁执行流程](../core/核心功能-TDD门禁执行流程.md)
- [模块详解-EvidenceVerifier模块](模块详解-EvidenceVerifier模块.md)

---

## Round 20-22 缺陷修复记录

### output-conciseness-guard.js — 注释行检测正则精确化（Round 20）

**缺陷**：以`*`开头的非注释代码行（如`*ptr`、`* 2`、Markdown列表`* item`）被误分类为注释行，导致`codeCommentRatio`偏高。

**修复**：改用精确正则`/^\s*(\/\/|\/\*|\*\/|\*\s|\*\/)/`替代松散的`startsWith`检查。

### output-conciseness-guard.js — 纯注释文件codeCommentRatio返回0（Round 22）

**缺陷**：当文件只有注释行和空行时，`totalCodeLines`为0，`codeCommentRatio`返回0而非1.0，导致纯注释文件不会被标记为"注释过多"。

**修复**：当`totalCodeLines === 0 && codeLines > 0`时返回1.0（100%注释率）。

### design-skill-engine.js — missing-label检查扩展表单控件（Round 21-22）

**缺陷1**：`missing-label`规则仅检查`<input>`元素，未考虑通过`aria-label`或`aria-labelledby`标注的元素。

**修复1**：增加`aria-label`/`aria-labelledby`排除检查。

**缺陷2**：仅检查`<input>`，缺少`<select>`和`<textarea>`等表单控件。

**修复2**：扩展检测范围为`/<(?:input|select|textarea)\b/`。

### design-skill-engine.js — checkContrast返回结构不一致（Round 22）

**缺陷**：`checkContrast`在输入无效时返回`fg`和`bg`字段，但有效结果中缺少这两个字段，API返回结构不一致。

**修复**：有效结果中也包含`fg`和`bg`字段。

### design-skill-engine.js — _parseColor对4位hex处理顺序（Round 22）

**缺陷**：4位hex（#RGBA简写）处理分支在6位hex之后，逻辑上应先处理短格式再处理长格式。

**修复**：调整处理顺序，4位hex在6位hex之前。

### framework-compliance-checker.js — NaN/nullish检测正则无法匹配嵌套括号（Round 22）

**缺陷**：`[^)]*`无法匹配嵌套括号调用如`parseInt(someFunc(a, b))`，导致漏报。

**修复**：改用`.*?`宽松匹配模式，覆盖更多实际场景。

### config-validator.js — 敏感值正则误报率高（Round 22）

**缺陷**：`^[a-zA-Z0-9]{40,}$`将任何40+字符的字母数字字符串标记为敏感值，误报率高。

**修复**：缩短最小长度为64字符，并增加常见密钥前缀检测（sk_/ak_/pk_/key_/token_）。

### design-skill-engine.js — parseInt缺基数参数与NaN未检查（Round 26）

**缺陷**：`_parseColor`中RGB颜色解析使用`parseInt(rgbMatch[1])`缺少基数参数（应为`parseInt(rgbMatch[1], 10)`），且无NaN检查。虽然正则`(\d+)`通常只匹配数字，但`parseInt`返回NaN时，`Math.max(0, NaN)`为`NaN`，`NaN.toString(16)`为`"NaN"`，会生成无效的十六进制颜色值。

**修复**：添加基数参数10，并添加`|| 0`兜底：`parseInt(rgbMatch[1], 10) || 0`。

### config-validator.js — 敏感值正则前缀组可选导致误报（Round 25-26）

**缺陷**：R22修复的正则`^(?:sk_|ak_|pk_|key_|token_)?[a-zA-Z0-9]{64,}$`中前缀组`(?:...)?`是可选的，导致任何64+字符的字母数字字符串仍被误判为敏感值。

**修复**：将正则拆分为两条规则：带前缀的64+字符匹配`^(?:sk_|ak_|pk_|key_|token_)[a-zA-Z0-9]{64,}$`，无前缀的128+字符匹配`^[a-zA-Z0-9]{128,}$`。

### config-validator.js — _validateRuntimeConfig真值检查跳过0值（Round 25-26）

**缺陷**：`_validateRuntimeConfig`使用`&&`检查`session_ttl_ms`、`max_concurrent`、`default_timeout_ms`，当这些值为0时被falsy跳过，无法检测不合理的0值配置。

**修复**：改为`!= null &&`，仅跳过null/undefined，0值也能被正确验证。
