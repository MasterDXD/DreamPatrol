# 模块详解 — TypeScript类型声明

> 源码路径：`index.d.ts`
> 版本：2.73.4

---

## 模块概述

TypeScript类型声明文件（`index.d.ts`）为Harness Engineering多Agent框架提供完整的TypeScript类型定义，涵盖所有公开API的类、接口、方法和事件类型。该文件使TypeScript项目可以获得框架API的类型提示和编译时类型检查。

### 声明范围

| 分类 | 说明 |
|------|------|
| 核心类 | DashboardServer、SessionManager、SkillRouter等 |
| 错误类型 | HarnessError及其子类型 |
| 配置类型 | 各模块构造函数选项接口 |
| 事件类型 | 各模块事件名和载荷类型 |

---

## 交叉引用

- [[模块详解-Web子系统]] — DashboardServer类定义
- [[模块详解-SessionManager会话管理器]] — SessionManager类定义
- [[模块详解-SkillRouter模块]] — SkillRouter类定义
- [[模块详解-TDD门禁执行器]] — TDDGate等类定义

---

## Round 10 缺陷修复记录

> 本轮修复涉及TypeScript类型声明文件中3项类型定义缺陷，涵盖声明语法、方法签名和嵌套命名空间。

### index.d.ts — export class改为export declare class

**缺陷**：类型声明文件中使用 `export class` 语法声明类，这在 `.d.ts` 文件中是不规范的。`export class` 隐含运行时值声明，而 `.d.ts` 文件应仅包含类型声明。TypeScript编译器在严格模式下可能产生警告，且与 `--isolatedModules` 模式不兼容。

**修复**：所有类声明从 `export class` 改为 `export declare class`，明确表示这些是纯类型声明，不含运行时实现。这是 `.d.ts` 文件的标准写法。

**影响范围**：类型声明文件符合TypeScript规范，严格模式和 `--isolatedModules` 模式下不再产生警告。

### index.d.ts — DashboardServer签名修复

**缺陷**：`DashboardServer` 类的构造函数签名与实际实现不一致。声明中构造函数参数为 `(projectRoot: string, port?: number)`，但实际实现接受三个参数 `(projectRoot, port, runtimeInstance)`，缺少 `runtimeInstance` 参数的类型声明。使用方在TypeScript中传入 `runtimeInstance` 时缺少类型提示。

**修复**：`DashboardServer` 构造函数签名修正为 `(projectRoot: string, port?: number, runtimeInstance?: any)`，与实际实现保持一致。

**影响范围**：DashboardServer的TypeScript类型提示与实际API一致，传入runtimeInstance参数时可获得正确的类型信息。

### index.d.ts — HarnessError嵌套声明修复

**缺陷**：`HarnessError` 类的声明中嵌套了同名的 `HarnessError` 命名空间（用于声明静态属性和方法），但嵌套声明的方式不正确——命名空间与类的成员声明冲突，导致TypeScript在解析时产生歧义，部分静态属性无法被正确识别。

**修复**：重构 `HarnessError` 的声明，将嵌套命名空间改为标准的声明合并模式（class声明 + 同名namespace声明），确保类的实例成员和命名空间的静态成员均可被正确识别。

**影响范围**：HarnessError的TypeScript类型提示完整且无歧义，实例方法和静态属性均可被正确识别。

---

## Round 25 缺陷修复记录

> 本轮修复涉及TypeScript类型声明文件中5项类型定义缺陷，涵盖缺失类声明、缺失常量声明、缺失构造函数选项、接口字段缺失和严重级别类型错误。

### index.d.ts — PipelineError/HookError 类声明缺失

**缺陷**：`PipelineError` 和 `HookError` 是 `src/errors/index.js` 中导出的两个错误子类，在 `index.d.ts` 中缺少对应的类型声明。TypeScript消费者无法获得这两个类的类型提示和类型安全保护。

**修复**：在 `CausalViolationError` 声明之后添加 `PipelineError` 和 `HookError` 的 `export declare class` 声明，与源码中的类定义保持一致。

### index.d.ts — ERROR_CODES/ERROR_SEVERITY/HTTP_STATUS_MAP 常量声明缺失

**缺陷**：`src/errors/index.js` 导出了三个核心常量对象 `ERROR_CODES`（88条错误码映射）、`ERROR_SEVERITY`（严重级别映射）和 `HTTP_STATUS_MAP`（HTTP状态码映射），但 `index.d.ts` 中缺少这些常量的类型声明。TypeScript消费者无法获得这些常量的类型信息。

**修复**：添加三个 `export declare const` 声明：
- `ERROR_CODES: Record<string, string>` — 错误码名称到错误码值的映射
- `ERROR_SEVERITY: Record<string, 'critical' | 'error' | 'warn' | 'info'>` — 错误码到严重级别的映射
- `HTTP_STATUS_MAP: Record<string, number>` — 错误码到HTTP状态码的映射

### index.d.ts — EventBus maxMiddleware 选项缺失

**缺陷**：`EventBus` 构造函数的实际实现接受 `maxMiddleware` 选项（默认值50），用于限制中间件函数数量。但 `index.d.ts` 中的构造函数签名仅包含 `maxListeners` 和 `maxHistory`，缺少 `maxMiddleware` 选项。

**修复**：在 EventBus 构造函数选项中添加 `maxMiddleware?: number`。

### index.d.ts — ValidationResult 接口字段缺失

**缺陷**：`validateConfig()` 函数返回的对象包含 `skillEnforcements`、`config` 和 `securityFindings` 三个字段，但 `ValidationResult` 接口仅声明了 `valid`、`errors` 和 `warnings`。TypeScript消费者无法访问这三个字段的类型信息。

**修复**：扩展 `ValidationResult` 接口，添加：
- `skillEnforcements: Record<string, { enforcement: string; priority: number; phase: string }>` — 技能执行级别映射
- `config: Record<string, unknown> | null` — 原始配置对象
- `securityFindings: Array<{ path: string; type: string; key: string; valuePreview: string }>` — 安全扫描发现

### index.d.ts — AntipatternDetection/AntipatternRule 严重级别类型纠正

**缺陷**：R24中将 `AntipatternDetection` 和 `AntipatternRule` 接口的 `severity` 类型从 `'critical' | 'warning' | 'info'` 改为 `'critical' | 'warn' | 'info'`，这是错误的。项目存在两套独立的严重级别命名系统：`ERROR_SEVERITY` 使用 `'warn'`，而反模式规则（`AgentMonitor.ANTIPATTERN_RULES`）和告警级别（`ALERT_LEVELS`）使用 `'warning'`。两者不应混用。

**修复**：将 `severity` 类型恢复为 `'critical' | 'warning' | 'info'`，与反模式系统的实际值保持一致。前端 `app.js` 中的颜色映射已添加 `'warn'` 兼容处理，确保两套系统在前端显示上均能正确着色。
