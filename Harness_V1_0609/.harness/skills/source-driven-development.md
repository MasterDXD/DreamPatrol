---
skill_id: source-driven-development
name: 源码驱动开发
trigger: "源码驱动 官方文档验证 文档验证 source-driven 引用验证 API验证"
auto_trigger: true
phase: module-development
priority: 0
applicable_agents: [domain-analyst, task-worker, code-reviewer, typescript-reviewer, python-reviewer, go-reviewer, rust-reviewer, java-reviewer]
depends_on: []
blocks: [tdd-implement, module-development]
causal_inputs:
  - name: framework-decision
    required: false
causal_outputs:
  - name: source-citation-report
    description: 源码引用验证报告
evidence_types:
  required:
    - source_citations
trigger_conditions:
  - "使用框架特定API"
  - "实现框架推荐模式"
  - "引入新依赖"
  - "API签名不确定"
  - "怀疑训练数据过时"
enforcement: recommended
production_validated: true
stability: stable
usage_count: 0
success_rate: 0
tools:
  - web-fetch: 获取官方文档
  - codebase-analyzer: 代码库分析
  - dependency-scanner: 依赖扫描
model: claude-3-opus-20240229
verified: true
---

## 目标

基于官方文档验证每个框架特定的代码决策，确保API签名、设计模式和最佳实践与当前版本一致，避免因训练数据过时导致的代码错误。

## 步骤

1. 检测技术栈和版本（从依赖文件识别确切版本）
2. 获取官方文档（按权威性层级：官方文档→官方博客→Web标准→兼容性数据）
3. 按文档模式实现（使用文档中的API签名，而非记忆中的）
4. 引用来源（每个框架特定模式附带完整URL引用）

# 源码驱动开发 — 基于官方文档验证代码决策

## 触发条件
- 使用框架特定API或模式时
- 实现框架推荐的功能时（如表单处理、路由、数据获取、状态管理、认证）
- 引入新依赖时
- 对API签名不确定时
- 怀疑训练数据可能过时时
- 审查或改进使用框架特定模式的代码时

**不触发条件**：纯逻辑代码（循环、条件、数据结构）、重命名变量、修复拼写错误、移动文件

## 核心原则

**训练数据会过时，API会被废弃，最佳实践会演进。** 每个框架特定的代码决策必须由官方文档支撑——不要凭记忆实现，要验证、引用、让用户看到你的来源。

## 执行流程

### 第一步：检测技术栈和版本
读取项目的依赖文件，识别确切版本：
- `package.json` → Node/React/Vue/Angular/Svelte
- `composer.json` → PHP/Symfony/Laravel
- `requirements.txt` / `pyproject.toml` → Python/Django/Flask
- `go.mod` → Go
- `Cargo.toml` → Rust
- `Gemfile` → Ruby/Rails

明确声明检测到的技术栈：
```
技术栈检测：
- React 19.1.0（来自 package.json）
- Vite 6.2.0
- Tailwind CSS 4.0.3
→ 正在获取相关模式的官方文档。
```

如果版本缺失或模糊，**必须询问用户**，不要猜测——版本决定了哪些模式是正确的。

### 第二步：获取官方文档
获取正在实现的功能的特定文档页面，不是首页，不是全部文档——是相关页面。

**来源层级（按权威性排序）**：

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1 | 官方文档 | react.dev, docs.djangoproject.com |
| 2 | 官方博客/更新日志 | react.dev/blog, nextjs.org/blog |
| 3 | Web标准参考 | MDN, web.dev, html.spec.whatwg.org |
| 4 | 浏览器/运行时兼容性 | caniuse.com, node.green |

**不可作为主要来源引用**：
- Stack Overflow 回答
- 博客文章或教程（即使很流行）
- AI生成的文档或摘要
- 自己的训练数据

### 第三步：按文档模式实现
编写与文档展示一致的代码：
- 使用文档中的API签名，而非记忆中的
- 如果文档展示了新的方式，使用新方式
- 如果文档废弃了某个模式，不使用废弃版本
- 如果文档未覆盖某内容，标记为未验证

**当文档与现有项目代码冲突时**：
```
冲突检测：
现有代码使用 useState 管理表单加载状态，
但 React 19 文档推荐 useActionState 处理此模式。
（来源：react.dev/reference/react/useActionState）
选项：
A) 使用现代模式（useActionState）—— 与当前文档一致
B) 匹配现有代码（useState）—— 与代码库一致
→ 选择哪种方式？
```
暴露冲突，不要静默选择。

### 第四步：引用来源
每个框架特定的模式都必须有引用，用户必须能够验证每个决策。

**代码注释中**：
```javascript
// React 19 表单处理使用 useActionState
// 来源：https://react.dev/reference/react/useActionState#usage
const [state, formAction, isPending] = useActionState(submitOrder, initialState);
```

**对话中**：说明为什么选择这个模式，附完整URL。

**引用规则**：
- 完整URL，不使用短链接
- 优先使用带锚点的深层链接
- 引用相关段落支持非显而易见的决策
- 如果找不到文档，明确声明：
```
未验证：无法找到此模式的官方文档。
此基于训练数据，可能已过时。
生产使用前请验证。
```

## 反合理化表

| 合理化 | 现实 |
|--------|------|
| "我对这个API很有信心" | 信心不是证据。训练数据包含看起来正确但当前版本会崩溃的过时模式。验证。 |
| "获取文档浪费Token" | 幻觉一个API浪费更多。用户调试一小时后发现函数签名变了。一次获取防止数小时返工。 |
| "文档不会有我需要的" | 如果文档不覆盖，那本身就是有价值的信息——该模式可能不是官方推荐的。 |
| "这只是简单任务" | 使用错误模式的简单任务会变成模板。用户把废弃的表单处理器复制到十个组件后才发现有现代方式。 |

## 验收标准
- [ ] 从依赖文件识别了框架和库版本
- [ ] 为框架特定模式获取了官方文档
- [ ] 所有来源是官方文档，非博客或训练数据
- [ ] 代码遵循当前版本文档中的模式
- [ ] 非平凡决策包含带完整URL的来源引用
- [ ] 未使用废弃API（已对照迁移指南检查）
- [ ] 文档与现有代码的冲突已暴露给用户
- [ ] 无法验证的内容已明确标记为未验证

## FAQ

- **Q: 为什么不能凭记忆使用API？** A: 训练数据会过时，API会被废弃，最佳实践会演进。凭记忆使用可能导致代码崩溃。
- **Q: 哪些来源可以作为引用依据？** A: 官方文档、官方博客/更新日志、Web标准参考（MDN等）、浏览器兼容性数据。不能使用Stack Overflow、博客或AI生成内容。
- **Q: 文档与现有代码冲突时如何处理？** A: 暴露冲突给用户，提供两种选项（使用现代模式 vs 匹配现有代码），不要静默选择。
