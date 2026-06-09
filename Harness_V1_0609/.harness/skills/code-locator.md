---
skill_id: code-locator
name: 精准代码定位
trigger: "代码定位 定位文件 找到模块 依赖追踪 调用链 code-locate locate dependency-trace"
auto_trigger: true
phase: module-development
priority: 0
applicable_agents: [domain-analyst, task-worker, code-reviewer, build-error-solver]
depends_on: []
blocks: [tdd-implement, module-development, bug-fix]
causal_inputs:
  - name: task-description
    required: true
causal_outputs:
  - name: location-report
    description: 代码定位报告（相关文件+依赖链+影响范围）
evidence_types:
  required:
    - location_report
trigger_conditions:
  - "需要修改但不确定涉及哪些文件"
  - "修复bug但不知道根因在哪个模块"
  - "添加功能但不确定影响范围"
  - "重构但需要理解跨文件依赖"
enforcement: recommended
production_validated: true
stability: stable
usage_count: 0
success_rate: 0
tools:
  - codebase-analyzer: 代码库分析
  - dependency-scanner: 依赖扫描
model: claude-3-opus-20240229
verified: true
---

## 目标

通过两阶段检索（关键词召回+依赖链展开）精准定位代码修改涉及的所有文件，包括隐藏依赖，输出结构化定位报告，避免凭猜测修改代码导致的遗漏和返工。

## 步骤

1. 从任务描述中提取关键词
2. 关键词召回（文件名匹配、导出名匹配、字符串匹配、注释匹配）
3. 依赖链展开（向上追踪谁依赖了我、向下追踪我依赖了谁、隐藏依赖检测）
4. 影响范围评估（直接修改文件、间接影响文件、测试文件、隐藏依赖）
5. 生成结构化定位报告

# 精准代码定位 — 两阶段检索+依赖链展开

## 触发条件
- 需要修改代码但不确定涉及哪些文件
- 修复bug但不知道根因在哪个模块
- 添加功能但不确定影响范围
- 重构但需要理解跨文件依赖关系

## 核心原则

**不要靠猜。** 小模型猜文件，大模型也猜文件——区别只是猜对的概率。精准定位靠算法，不靠运气。两阶段检索（关键词召回+依赖链展开）可以在毫秒级定位到所有相关文件，包括隐藏依赖。

## 执行流程

### 第一步：关键词召回（毫秒级，不调LLM）

从任务描述中提取关键词，在代码库中搜索匹配文件：

```
任务："修复登录验证失败的问题"
关键词提取：["登录", "验证", "失败", "login", "auth", "verify"]
```

**搜索策略**：
1. **文件名匹配**：搜索文件名包含关键词的文件（如 `auth.js`、`login.js`）
2. **导出名匹配**：搜索 `module.exports` 和 `exports.xxx` 中包含关键词的模块
3. **字符串匹配**：搜索代码中包含关键词的字符串字面量（如错误消息、路由路径）
4. **注释匹配**：搜索JSDoc `@module`、`@namespace` 标签中的关键词

**输出**：候选文件列表（按匹配度排序）

### 第二步：依赖链展开（毫秒级，不调LLM）

从候选文件出发，沿 `require()` / `import` 链双向展开：

**向上追踪（谁依赖了我）**：
```
auth.js ← 被谁引用？
  → server.js (require('./auth'))
  → middleware.js (require('./auth'))
  → test/auth.test.js (require('../auth'))
```

**向下追踪（我依赖了谁）**：
```
auth.js → 依赖了谁？
  → jwt.js (require('./jwt'))
  → user-model.js (require('./user-model'))
  → config.js (require('./config'))
```

**隐藏依赖检测**：
- 通过 `src/index.js` 懒加载导出的间接依赖
- 通过事件总线（EventBus）的松耦合依赖
- 通过配置文件（config.json）的运行时依赖

**输出**：完整依赖图（直接依赖+间接依赖+隐藏依赖）

### 第三步：影响范围评估

基于依赖图，评估修改的影响范围：

```
影响范围报告：
┌──────────────────────────────────────┐
│ 直接修改文件（必须改）                │
│   src/runtime/infrastructure/auth.js │
│ 间接影响文件（可能需要调整）          │
│   src/web/server.js                  │
│   src/web/dashboard/middleware.js    │
│ 测试文件（必须更新）                  │
│   test/web/auth.test.js              │
│ 隐藏依赖（需验证）                    │
│   src/index.js (lazyExport: Auth)    │
│   .harness/config.json (auth配置)    │
└──────────────────────────────────────┘
风险等级：Medium（3个直接依赖，2个隐藏依赖）
```

### 第四步：生成定位报告

输出结构化定位报告，作为后续Skill（tdd-implement、bug-fix等）的输入：

```markdown
## 代码定位报告

### 任务描述
修复登录验证失败的问题

### 关键词
登录, 验证, 失败, login, auth, verify

### 定位结果

| 文件 | 关联类型 | 匹配原因 | 风险等级 |
|------|----------|----------|----------|
| src/runtime/infrastructure/auth.js | 直接 | 文件名+导出名匹配 | High |
| src/web/server.js | 间接 | require('./auth') | Medium |
| src/web/dashboard/middleware.js | 间接 | require('./auth') | Medium |
| test/web/auth.test.js | 测试 | 测试文件 | Low |

### 依赖链
auth.js → jwt.js → crypto
auth.js → user-model.js → database
auth.js ← server.js ← app.js

### 建议修改范围
1. auth.js（核心修改）
2. jwt.js（可能需要调整token验证逻辑）
3. auth.test.js（必须更新测试）
```

## 与Harness现有模块的集成

### 利用CausalDataBus追踪依赖
Harness的因果数据总线（CausalDataBus）已实现事件发布/订阅和因果排序。代码定位的第二阶段"依赖链展开"可复用其因果追踪能力：
- `require()` 关系 → 映射为因果依赖边
- 事件总线订阅关系 → 映射为松耦合依赖边
- 懒加载导出关系 → 映射为间接依赖边

### 利用fs-utils扫描代码
Harness的fs-utils已实现Markdown扫描和安全路径。扩展其能力：
- 扫描所有JS文件的 `require()` 调用
- 提取 `module.exports` 和 `exports.xxx` 导出名
- 解析 `src/index.js` 的 `lazyExports` 对象

## 反合理化表

| 合理化 | 现实 |
|--------|------|
| "我熟悉项目，不需要定位" | 熟悉度会过期。3个月前的依赖关系可能已改变。定位只需毫秒，猜错浪费小时。 |
| "全局搜索就够了" | 全局搜索只能找到关键词，找不到隐藏依赖。A require B，B require C，全局搜索只找到A和B，漏掉C。 |
| "定位浪费时间" | 不定位导致改错文件、漏改依赖、测试失败返工——这些浪费远超定位时间。 |

## 验收标准
- [ ] 从任务描述提取了有效关键词
- [ ] 关键词召回找到了所有直接相关文件
- [ ] 依赖链展开覆盖了向上和向下两个方向
- [ ] 隐藏依赖（懒加载/事件总线/配置）已被识别
- [ ] 影响范围评估包含风险等级
- [ ] 定位报告结构化输出，可供后续Skill使用

## FAQ

- **Q: 代码定位与全局搜索有何区别？** A: 全局搜索只能找到关键词匹配，代码定位通过依赖链展开还能找到隐藏依赖（懒加载/事件总线/配置）。
- **Q: 定位结果是否包含测试文件？** A: 是的，依赖链展开会自动识别并包含相关测试文件。
- **Q: 定位报告需要多长时间？** A: 毫秒级，不调用LLM，纯算法实现。
