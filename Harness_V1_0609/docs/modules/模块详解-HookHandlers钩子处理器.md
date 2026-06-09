# 模块详解 — HookHandlers 钩子处理器集合

> 所属子系统：[[工作流子系统]] | 依赖：[[ProgrammableHookExecutor]] | 版本：2.73.4

## 模块概述

`hook-handlers.js` 是框架安全防线的核心组件，提供 20+ 内置钩子处理器实现。所有处理器遵循统一的 `{ passed, reason?, message?, ... }` 返回格式，由 `ProgrammableHookExecutor` 在 Skill 执行的关键节点调用。

**源码位置**：`src/runtime/workflow/hook-handlers.js`

## 架构地位

```
ProgrammableHookExecutor（执行器，已有文档）
  └── HookHandlers（处理器集合，本文档）← 执行器依赖的处理器实现
        ├── 安全类处理器（路径验证、敏感信息、权限、速率限制）
        ├── 质量类处理器（交付物完整性、质量标准、完成前验证）
        ├── 效率类处理器（Token预算、简洁性、YAGNI预检）
        ├── 注入类处理器（核心身份、技能路由、阶段上下文）
        └── 检查类处理器（输出格式、设计反模式、无障碍、AI服务安全）
```

## 关键常量

| 常量 | 类型 | 说明 |
|------|------|------|
| `SECRET_PATTERNS` | RegExp[] | 敏感信息检测正则（API Key、密码、私钥等） |
| `RESTRICTED_AGENTS` | Set\<string\> | 只读Agent集合（code-reviewer, security-reviewer 等7个） |
| `PRIVILEGED_AGENTS` | Set\<string\> | 特权Agent集合（team-lead, devops-engineer） |
| `STRICT_SKILLS` | Set\<string\> | 严格验证技能（tdd-implement, bug-fix 等7个） |
| `RATE_LIMIT_WINDOW` | number | 速率限制滑动窗口（60秒） |
| `RATE_LIMIT_MAX_CALLS` | number | 单Agent窗口内最大调用次数（100） |
| `YAGNI_MAX_NEW_FILES` | number | YAGNI允许最大新建文件数（3） |
| `YAGNI_MAX_ABSTRACTIONS` | number | YAGNI允许最大新抽象数（3） |
| `YAGNI_MAX_ADDED_LINES` | number | YAGNI允许最大新增行数（300） |

## 处理器分类详解

### 安全类处理器

#### 1. pathValidation — 路径遍历防护
- **触发点**：文件操作前
- **检查内容**：解析目标路径，验证不超出项目根目录
- **防护对象**：`../` 路径遍历攻击、符号链接逃逸
- **返回**：`{ passed, reason?, resolvedPath? }`

#### 2. sensitiveContentCheck — 敏感信息检测
- **触发点**：输出/日志写入前
- **检查内容**：使用 `SECRET_PATTERNS` 正则匹配 API Key、密码、私钥
- **防护对象**：敏感信息泄露到日志或输出
- **返回**：`{ passed, reason?, foundPatterns? }`

#### 3. permissionCheck — 权限检查（RBAC）
- **触发点**：Skill执行前
- **检查内容**：验证Agent角色是否有权执行当前Skill
- **防护对象**：未授权操作（如 code-reviewer 执行 deployment）
- **返回**：`{ passed, reason?, agent?, skill? }`

#### 4. rateLimitCheck — 速率限制
- **触发点**：每次Skill调用
- **检查内容**：滑动窗口内Agent调用频率
- **防护对象**：Agent过频调用导致资源耗尽
- **返回**：`{ passed, reason?, callsInWindow?, windowMs? }`

### 质量类处理器

#### 5. deliverableIntegrity — 交付物完整性
- **触发点**：Skill完成时
- **检查内容**：验证声明的交付物文件是否存在且非空
- **返回**：`{ passed, reason?, missingFiles? }`

#### 6. qualityStandards — 质量标准
- **触发点**：Skill完成时
- **检查内容**：运行 lint 和测试检查（对 `STRICT_SKILLS` 中的技能强制）
- **返回**：`{ passed, reason?, lintErrors?, testFailures? }`

#### 7. verificationBeforeCompletion — 完成前验证
- **触发点**：Agent声称任务完成时
- **检查内容**：验证完成声明的证据充分性
- **返回**：`{ passed, reason?, evidenceType?, evidenceStrength? }`

### 效率类处理器

#### 8. tokenBudgetCheck — Token预算
- **触发点**：每次LLM调用前
- **检查内容**：当前Token使用量是否超过预算阈值
- **阈值**：80% 预警，95% 切换低价模型，100% 暂停
- **返回**：`{ passed, reason?, usage?, budget?, ratio? }`

#### 9. outputConciseness — 输出精简度
- **触发点**：输出生成后
- **检查内容**：Token数、行数、重复率、填充词比、注释比五维检测
- **返回**：`{ passed, reason?, metrics? }`

#### 10. yagniPreCheck — YAGNI预检
- **触发点**：代码变更前
- **检查内容**：新建文件数、新抽象数、新增行数、纯样式变更数
- **阈值**：`YAGNI_MAX_NEW_FILES=3`, `YAGNI_MAX_ABSTRACTIONS=3`, `YAGNI_MAX_ADDED_LINES=300`
- **返回**：`{ passed, reason?, newFiles?, newAbstractions?, addedLines? }`

### 注入类处理器

#### 11. coreIdentityInjection — 核心身份注入
- **触发点**：会话开始时
- **行为**：向上下文注入当前Agent的角色定义和核心规则

#### 12. skillRouteInjection — 技能路由注入
- **触发点**：Skill匹配后
- **行为**：将匹配到的Skill完整指令注入上下文

#### 13. phaseContextLoading — 阶段上下文加载
- **触发点**：阶段转换时
- **行为**：加载当前阶段相关的文档和规则

#### 14. phaseErrorHandling — 阶段错误回滚/重试/升级
- **触发点**：阶段执行失败时
- **行为**：根据错误类型决定回滚、重试或升级处理

### 检查类处理器

#### 15. outputFormatCheck — 输出格式检查
- **触发点**：输出生成后
- **检查内容**：标题数量（`OUTPUT_MAX_HEADERS=8`）、结构规范性

#### 16. designAntiPatternCheck — 设计反模式检查
- **触发点**：前端代码变更时
- **检查内容**：硬编码间距值数量（`DESIGN_MAX_HARDCODED_SPACING=5`）

#### 17. accessibilityCompliance — 无障碍合规检查
- **触发点**：前端代码变更时
- **检查内容**：焦点样式缺失数量（`A11Y_MAX_FOCUS_VIOLATIONS`）

#### 18. aiServiceSecurity — AI服务安全检查
- **触发点**：AI服务调用前
- **检查内容**：API Key 不在请求体中明文传输、模型降级策略可用

#### 19. auditLogging — 审计日志
- **触发点**：所有关键操作
- **行为**：记录操作到审计日志，链式哈希完整性验证

#### 20. preciseChangeCheck — 精准变更检查
- **触发点**：代码变更提交前
- **检查内容**：变更范围是否与任务目标一致

## 与 ProgrammableHookExecutor 的关系

`ProgrammableHookExecutor` 负责执行流程编排（顺序执行、阻塞中断、60s超时），`HookHandlers` 提供具体的检查逻辑。两者通过处理器注册机制解耦：

```javascript
const executor = new ProgrammableHookExecutor(projectRoot);
executor.registerHandler('pathValidation', hookHandlers.pathValidation);
executor.registerHandler('sensitiveContent', hookHandlers.sensitiveContentCheck);
```

## 安全模型

```
请求 → pathValidation → sensitiveContentCheck → permissionCheck → rateLimitCheck → 执行
         ↓                  ↓                      ↓                ↓
      路径遍历防护      敏感信息过滤           RBAC权限验证      频率限制
```

安全类处理器按优先级顺序执行，任一处理器返回 `{ passed: false }` 即中断执行链。

## 相关文档

- [[模块详解-ProgrammableHookExecutor模块]] — 钩子执行器
- [[模块详解-RBACEnforcer模块]] — RBAC权限执行
- [[模块详解-PermissionGuard模块]] — 文件操作权限守卫
- [[核心功能-权限控制与审计]] — 权限控制流程
