# 模块详解-FrameworkComplianceChecker模块

> 版本：2.73.4 | 文件：src/gate/framework-compliance-checker.js | 行数：~919行

---

## 模块定位

FrameworkComplianceChecker是框架合规检查器，是TDD门禁执行器的核心组件之一。它负责在代码审查和模块开发阶段自动检查代码是否符合项目规范，涵盖八大检查维度：命名规范、结构规则、安全规则、持久化规则、API规则、错误规则、Karpathy规则和设计规则。支持同步/异步检查、目录递归扫描、豁免机制和结果汇总。

## 类定义

```javascript
class FrameworkComplianceChecker extends EventEmitter {
  constructor(projectRoot, options = {})
  checkFile(filePath)
  checkFileAsync(filePath)
  checkDirectory(dirPath)
  checkDirectoryAsync(dirPath)
  checkProject()
  checkProjectAsync()
  checkNamingConvention(type, name)
  checkDependency(moduleName)
  autoFix(filePath, code, violations)   // v2.10.7新增
  addExemption(ruleId, filePath)
  removeExemption(ruleId, filePath)
  getExemptions()
  getSummary()
  getResults()
  isHealthy()
  shutdown() // via withShutdown mixin
}
```

## 构造函数

### `constructor(projectRoot, options)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectRoot` | string | 是 | 项目根目录绝对路径，内部通过`validateProjectRoot`校验 |
| `options` | object | 否 | 配置选项 |
| `options.exemptions` | object | 否 | 豁免规则，格式为`{ruleId: [filePath, ...]}` |

初始化内部状态：
- `_srcDir` — 源码目录：`<projectRoot>/src`
- `_rules` — 合并后的所有规则定义
- `_exemptions` — 豁免规则映射
- `_results` — 检查结果缓存（最多`MAX_RESULTS`条）
- `_maxExemptionsPerRule` — 每条规则最大豁免数（50）

## 公开方法详解

### `checkFile(filePath)`

同步检查单个文件的合规性。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |

**返回值**：`Array<Violation>` — 违规列表

### `checkFileAsync(filePath)`

异步检查单个文件的合规性。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |

**返回值**：`Promise<Array<Violation>>`

### `checkDirectory(dirPath)`

同步递归检查目录下所有`.js`文件的合规性。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dirPath` | string | 是 | 目标目录路径 |

**返回值**：`Array<Violation>` — 所有违规的合并列表

**行为细节**：
- 递归深度最大20层
- 自动跳过`node_modules`、`.git`、`coverage`目录
- 检测符号链接循环（realpath !== fullPath时跳过）
- 仅检查`.js`文件

### `checkDirectoryAsync(dirPath)`

异步递归检查目录下所有`.js`文件的合规性。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dirPath` | string | 是 | 目标目录路径 |

**返回值**：`Promise<Array<Violation>>`

### `checkProject()`

同步检查整个项目的`src/`目录。

**返回值**：`Array<Violation>` — 检查前清空历史结果

### `checkProjectAsync()`

异步检查整个项目的`src/`目录。

**返回值**：`Promise<Array<Violation>>`

### `checkNamingConvention(type, name)`

检查命名是否符合规范。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 命名类型：`file`/`class`/`method`/`constant`/`event`/`error-code` |
| `name` | string | 是 | 待检查的名称 |

**返回值**：`boolean` — 是否符合规范

| 类型 | 规范 | 正则 |
|------|------|------|
| `file` | kebab-case | 非`checkKebabCase`结果取反 |
| `class` | PascalCase | `/^[A-Z][a-zA-Z0-9]*$/` |
| `method` | camelCase | `/^[a-z][a-zA-Z0-9]*$/` |
| `constant` | UPPER_SNAKE_CASE | `/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/` |
| `event` | kebab-case | `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` |
| `error-code` | UPPER_SNAKE_CASE | `/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/` |

### `checkDependency(moduleName)`

检查模块是否为Node.js内置模块。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `moduleName` | string | 是 | 模块名称 |

**返回值**：`boolean` — 是内置模块返回true

### `autoFix(filePath, code, violations)` — v2.10.7新增

自动修复可修复的违规项。融合自Claude Code Standards的自动修复管道。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filePath` | string | 是 | 目标文件路径 |
| `code` | string | 是 | 原始代码内容 |
| `violations` | Violation[] | 是 | 违规列表（来自checkFile/checkProject） |

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `fixed` | boolean | 是否有修复应用 |
| `code` | string | 修复后的代码 |
| `changes` | Array\<{ruleId, description, applied, error?}\> | 修复变更详情 |

**可修复的违规类型**：

| 规则ID | 修复方式 |
|--------|---------|
| `use-strict` | 在文件开头添加 `'use strict';` |
| `console.log` | 移除 console.log/console.error 调用 |
| 其他 | 根据违规的 `fix` 函数执行 |

**行为细节**：
- 仅处理 `violation.fixable === true` 的违规项
- 修复失败不中断，记录错误继续处理后续违规
- 修复完成后触发 `auto-fix-complete` 事件
- 更新 `_stats.fixed` 计数

### `addExemption(ruleId, filePath)`

添加豁免规则。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ruleId` | string | 是 | 规则ID |
| `filePath` | string | 是 | 豁免的文件路径，支持目录前缀匹配 |

**行为细节**：
- 路径不能为`*`、`/`或过短
- 每条规则最多50个豁免
- 豁免支持目录前缀匹配（以`/`结尾的路径匹配其下所有文件）

### `removeExemption(ruleId, filePath)`

移除豁免规则。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ruleId` | string | 是 | 规则ID |
| `filePath` | string | 是 | 豁免的文件路径 |

### `getExemptions()`

获取所有豁免规则。

**返回值**：`Object<ruleId, string[]>` — 豁免规则的浅拷贝

### `getSummary()`

获取检查结果汇总。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `total` | number | 总违规数 |
| `errors` | number | error级别违规数 |
| `warnings` | number | warn级别违规数 |
| `infos` | number | info级别违规数 |
| `errorFiles` | string[] | 有error的文件列表（去重） |
| `warningFiles` | string[] | 有warning的文件列表（去重） |
| `compliant` | boolean | 是否合规（无error） |

### `getResults()`

获取所有检查结果。

**返回值**：`Array<Violation>` — 结果数组的浅拷贝

## Violation结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `ruleId` | string | 触发的规则ID |
| `level` | string | 严重级别：`error`/`warn`/`info` |
| `description` | string | 规则描述 |
| `file` | string | 相对文件路径 |
| `message` | string | 具体违规消息 |
| `timestamp` | string | ISO格式时间戳 |

## 检查维度详解

### 命名规范（NAMING_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `file-kebab-case` | error | 文件名必须使用kebab-case |
| `class-pascal-case` | error | 类名必须使用PascalCase |
| `method-camel-case` | warn | 公开方法必须使用camelCase |
| `private-underscore` | warn | 私有方法必须使用`_`前缀 |
| `constant-upper-snake` | error | 模块级常量必须使用UPPER_SNAKE_CASE |
| `event-kebab-case` | error | 事件名必须使用kebab-case |

### 结构规则（STRUCTURE_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `use-strict` | error | 文件必须以`'use strict'`开头 |
| `class-export` | warn | 模块应通过`module.exports`导出单个类 |
| `no-external-deps` | error | 生产代码禁止使用外部依赖（仅允许`better-sqlite3`） |
| `src-dir-structure` | warn | 源文件必须在批准的`src/`子目录内 |

**批准的src子目录**：`runtime`、`gate`、`permission`、`web`、`utils`、`errors`

### 安全规则（SECURITY_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `no-eval` | error | 禁止使用`eval()`和`Function()`构造函数 |
| `no-dangerous-commands` | error | 危险Shell命令必须使用PermissionGuard |
| `crypto-safe-random` | error | ID生成必须使用`crypto.randomUUID()`而非`Math.random()` |
| `path-traversal-guard` | error | 文件操作必须检查路径遍历 |
| `timing-safe-compare` | warn | Token/密钥比较必须使用`timingSafeEqual` |

### 持久化规则（PERSISTENCE_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `debounce-write` | warn | 高频写入必须使用防抖 |
| `atomic-write` | warn | 关键数据必须使用原子写入（.tmp + rename） |
| `graceful-shutdown` | error | 有持久化的模块必须实现`flush()`/`shutdown()` |

### API规则（API_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `cors-headers` | warn | API端点必须设置CORS头 |
| `security-headers` | warn | HTTP响应必须包含安全头 |
| `rate-limit` | warn | API端点应实现速率限制 |
| `input-validation` | error | API输入必须验证 |

### 错误规则（ERROR_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `custom-error-class` | error | 错误必须使用HarnessError子类层级 |
| `error-code-upper` | error | 错误码必须使用UPPER_SNAKE_CASE |
| `capture-stack-trace` | warn | 错误类应调用`Error.captureStackTrace` |

### Karpathy规则（KARPATHY_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `no-speculative-code` | warn | 禁止超出需求的投机性实现 |
| `no-unused-abstraction` | warn | 抽象必须至少有2个调用者（YAGNI） |
| `no-dead-config` | warn | 配置项必须被代码消费 |
| `file-line-limit` | warn | 文件不应超过500行 |
| `no-orphan-cleanup` | warn | 清理自己的孤立代码，不删除已有的死代码 |
| `traceability-required` | info | 每行变更应可追溯到用户需求 |

### 设计规则（DESIGN_RULES）

| 规则ID | 级别 | 说明 |
|--------|------|------|
| `no-pure-black` | warn | CSS禁止使用纯黑`#000000` |
| `no-ai-gradient` | warn | CSS禁止AI风格紫蓝渐变 |
| `no-neon-glow` | warn | CSS禁止霓虹发光效果 |
| `no-default-large-shadow` | warn | CSS禁止默认大阴影，使用分层阴影系统 |
| `no-oversaturated` | warn | CSS禁止过饱和颜色，饱和度应降至60-80% |
| `no-system-font` | info | CSS应使用专业字体栈 |
| `design-token-usage` | info | CSS应使用设计令牌变量 |
| `accessibility-contrast` | error | 前端代码必须满足WCAG AA对比度 |
| `accessibility-alt-text` | error | 图片必须有alt属性 |
| `accessibility-focus` | warn | 交互元素必须有焦点样式 |
| `accessibility-reduced-motion` | warn | 动画必须有`prefers-reduced-motion`回退 |

## 内容检查逻辑

`_checkContentRules`方法按序执行以下检查：

1. **外部依赖检查**：扫描`require()`调用，验证是否为内置模块或允许的外部依赖
2. **eval检查**：剥离注释和字符串后检测`eval()`和`Function()`构造函数
3. **加密安全检查**：检测`Math.random()`用于ID生成
4. **类导出检查**：检测定义了类但未通过`module.exports`导出
5. **文件行数限制**：超过500行触发警告
6. **投机代码检查**：检测过多的TODO/FIXME/始终启用的特性标志
7. **孤立清理检查**：检测标记为unused但未清理的导入、过多的console.log
8. **设计规则检查**：仅对前端文件（css/html/jsx/tsx/vue/svelte/scss/less）执行

## 静态属性

| 属性 | 说明 |
|------|------|
| `RULE_LEVELS` | `{ERROR: 'error', WARN: 'warn', INFO: 'info'}` |
| `NAMING_RULES` | 命名规范规则定义 |
| `STRUCTURE_RULES` | 结构规则定义 |
| `SECURITY_RULES` | 安全规则定义 |
| `PERSISTENCE_RULES` | 持久化规则定义 |
| `API_RULES` | API规则定义 |
| `ERROR_RULES` | 错误规则定义 |
| `APPROVED_SRC_DIRS` | 批准的src子目录列表 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `file-checked` | 单文件检查完成 | `{filePath, violations}` |
| `directory-checked` | 目录检查完成 | `{dirPath, violationCount}` |
| `directory-error` | 目录遍历出错 | `{error, dir}` |

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `MAX_RESULTS` | 8000 | 最大结果缓存数 |
| `MAX_FILE_LINES` | 500 | 文件行数限制 |
| `MAX_WALK_DEPTH` | 20 | 目录递归最大深度 |

## 使用示例

```javascript
const FrameworkComplianceChecker = require('./src/gate/framework-compliance-checker');

const checker = new FrameworkComplianceChecker('/path/to/project', {
  exemptions: {
    'file-kebab-case': ['src/legacy/'],
    'no-external-deps': ['src/web/server.js']
  }
});

const violations = await checker.checkProjectAsync();
const summary = checker.getSummary();
console.log(`合规: ${summary.compliant}, 错误: ${summary.errors}, 警告: ${summary.warnings}`);

const fileViolations = await checker.checkFileAsync('src/gate/tdd-gate.js');
console.log(`文件违规数: ${fileViolations.length}`);

console.log('命名检查:', checker.checkNamingConvention('class', 'MyClass'));
console.log('依赖检查:', checker.checkDependency('fs'));

checker.addExemption('use-strict', 'src/generated/');
console.log('豁免列表:', checker.getExemptions());

checker.shutdown();
```

## 依赖关系

- 依赖：`../utils/constants.js` — 内置模块集合、路径校验、设计模式正则
- 依赖：`../utils/path-utils.js` — 路径验证（同步/异步）
- 依赖：`../utils/debug-logger.js` — 调试日志
- 依赖：`../utils/deep-clone.js` — 深拷贝（豁免规则）
- 依赖：`../utils/safe-assign.js` — 配置合并
- 依赖：`./shared-rule-helpers.js` — 共享规则辅助（注释剥离、eval检测、加密检测、类导出检测、kebab-case检测）
- 依赖：`../utils/shutdown-mixin.js` — 优雅关闭
- 依赖：`../utils/safe-execute.js` — 安全执行工具
- 被依赖：`src/index.js` — 主入口装配

## 集成说明

- FrameworkComplianceChecker与TDDGate配合：TDD门禁在模块开发阶段调用合规检查
- 与CodeReviewFrameworkCheck配合：代码审查时自动执行合规检查清单
- 与ProgrammableHookExecutor的`quality_standards`内置处理器互补：HookExecutor做实时检查，ComplianceChecker做全量扫描
- 豁免机制允许遗留代码逐步合规，不阻塞开发流程
- 设计规则仅对前端文件生效，后端代码自动跳过

## 相关文档

- [核心功能-TDD门禁执行流程](../core/核心功能-TDD门禁执行流程.md)
- [模块详解-TDDGate模块](模块详解-TDDGate模块.md)
- [模块详解-SharedRuleHelpers模块](模块详解-工具层辅助模块.md)
