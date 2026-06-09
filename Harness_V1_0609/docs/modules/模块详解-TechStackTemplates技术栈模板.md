# 模块详解 — TechStackTemplates 技术栈模板系统

> 所属子系统：[[基础设施子系统]] | 融合自：Claude Code Standards + DeepSeek CodeGPT X | 版本：2.73.4

## 模块概述

`tech-stack-templates.js` 是框架的技术栈标准化模板系统，融合自 Claude Code Standards（42.7K stars）的核心概念。提供22种主流技术栈的标准化代码模板（含4个中文开发生态模板），AI生成代码后自动校验命名规范、注释完整性、架构合理性，并支持一键修复不达标项。核心价值：减少80%的代码评审时间，让AI产出"开箱即用"的代码。

**源码位置**：`src/runtime/standards/tech-stack-templates.js`（逻辑层）+ `src/runtime/standards/templates-data.js`（数据层）

## 核心能力

| 能力 | 说明 |
|------|------|
| 22种技术栈模板 | 覆盖前端、后端、移动端、数据层、基础设施、小程序、鸿蒙七大类 |
| 自动校验 | 激活模板后自动检查命名、注释、架构规则 |
| 一键修复 | 可修复违规项（如console.log移除）自动修正 |
| 团队规则同步 | 导出/导入规则集，团队共享标准化模板 |
| 自定义规则 | 支持为任意技术栈添加自定义校验规则 |
| 批量检查 | 一次检查多个文件，汇总统计结果 |

## 22种技术栈模板

### 前端（Frontend）
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `react` | 18.x / 19.x | .jsx, .tsx | 组件≤300行，PascalCase命名 |
| `vue` | 3.x | .vue | 单文件组件，Composition API |
| `angular` | 17.x | .ts | 模块化，依赖注入 |
| `svelte` | 4.x | .svelte | 响应式声明，最小样板 |
| `nextjs` | 14.x | .jsx, .tsx | App Router，SSR/SSG |
| `nuxt` | 3.x | .vue | 自动导入，文件路由 |

### 后端（Backend）
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `express` | 4.x | .js, .ts | 中间件链，错误处理 |
| `fastify` | 4.x | .js, .ts | Schema验证，插件系统 |
| `nestjs` | 10.x | .ts | 装饰器，模块化 |
| `django` | 5.x | .py | MTV模式，ORM |
| `flask` | 3.x | .py | 蓝图，最小化 |
| `springboot` | 3.x | .java | 注解驱动，自动配置 |

### 移动端（Mobile）
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `react-native` | 0.73.x | .jsx, .tsx | 跨平台，原生桥接 |

### 数据层（Data）
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `prisma` | 5.x | .prisma | Schema驱动，类型安全 |
| `typeorm` | 0.3.x | .ts | 装饰器实体，迁移 |

### 基础设施（Infrastructure）
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `docker` | — | Dockerfile, .dockerignore | 多阶段构建，最小镜像 |
| `terraform` | 1.x | .tf | 声明式，状态管理 |
| `github-actions` | — | .yml, .yaml | 工作流定义，矩阵策略 |

### 小程序（Mini Program）— R50 DeepSeek CodeGPT X融合
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `uniapp` | 3.x (Vue 3) | .vue | 条件编译必须，禁止原生DOM，rpx单位优先 |
| `taro` | 4.x (React/Vue) | .jsx, .tsx | 禁止ReactDOM，跨平台API，Taro导入必须 |
| `wechatMiniprogram` | 基础库 3.x | .wxml, .wxss, .js, .json | 禁止DOM访问，仅wx API，Promise封装，分包必须 |

### 鸿蒙（HarmonyOS）— R50 DeepSeek CodeGPT X融合
| 模板 | 版本 | 文件扩展名 | 核心规则 |
|------|------|-----------|---------|
| `harmony` | API 12+ | .ets | ArkTS合规，禁止any类型，状态装饰器必须 |

## 模板数据结构

每个模板包含以下字段：

```javascript
{
  name: 'React',                    // 模板名称
  category: 'frontend',             // 分类：frontend/backend/mobile/data/infrastructure
  version: '18.x / 19.x',           // 目标版本
  naming: {                         // 命名规范
    componentFiles: 'PascalCase (.jsx/.tsx)',
    hookFiles: 'useCamelCase (.js/.ts)',
    testFiles: '*.test.jsx / *.spec.jsx',
  },
  structure: {                      // 目录结构规范
    entryPoint: 'src/index.jsx',
    componentDir: 'src/components/',
    hookDir: 'src/hooks/',
  },
  comments: {                       // 注释规范
    componentJSDoc: 'required',
    propTypes: 'required',
    inlineDocs: 'suggested',
  },
  rules: {                          // 校验规则
    maxComponentLines: 300,
    noConsoleLog: 'warn',
    preferFunctionalComponents: 'warn',
  },
}
```

## 违规项结构

```javascript
{
  ruleId: 'naming.componentFiles',           // 规则ID
  severity: 'warning' | 'error' | 'info',    // 严重级别
  message: 'React: Component file should be PascalCase',  // 违规描述
  fixable: true | false,                     // 是否可自动修复
  fix: function(code, violation) { ... },    // 修复函数（仅fixable=true时存在）
}
```

## API 参考

### 构造函数

#### `new TechStackTemplates(options)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项（预留） |

### 核心方法

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `activate(stackNames)` | string\|string[] | `{ activated, conflicts }` | 激活一个或多个技术栈模板 |
| `deactivate(stackNames)` | string\|string[] | void | 停用技术栈模板 |
| `getActiveStacks()` | — | string[] | 获取当前激活的模板列表 |
| `getTemplate(name)` | string | object\|null | 获取指定模板定义 |
| `check(filePath, code, options)` | string, string, object | `{ filePath, violations, summary }` | 校验单个文件 |
| `checkBatch(files)` | Array\<{filePath, code}\> | `{ results, totalViolations, totalErrors, passed }` | 批量校验多个文件 |
| `autoFix(filePath, code, violations)` | string, string, Violation[] | `{ fixed, code, changes }` | 自动修复违规项 |
| `addCustomRule(stackName, ruleId, rule)` | string, string, object | void | 添加自定义规则 |
| `removeCustomRule(stackName, ruleId)` | string, string | void | 移除自定义规则 |
| `exportRules()` | — | object | 导出当前规则集（团队同步） |
| `importRules(ruleset)` | object | `{ imported, customRules }` | 导入规则集 |
| `getStats()` | — | object | 获取校验统计 |

### 静态方法

| 方法 | 返回 | 说明 |
|------|------|------|
| `TechStackTemplates.getAvailableTemplates()` | string[] | 获取所有可用模板名称 |
| `TechStackTemplates.TEMPLATES` | object | 获取全部模板数据 |

### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `stack-activated` | 模板激活 | `{ name, template }` |
| `stack-deactivated` | 模板停用 | `{ name }` |
| `stacks-updated` | 模板列表变更 | `{ active: string[] }` |
| `check-complete` | 单文件校验完成 | `{ filePath, violations, summary }` |
| `batch-check-complete` | 批量校验完成 | `{ files, results, totalViolations, totalErrors }` |
| `auto-fix-complete` | 自动修复完成 | `{ filePath, changes }` |
| `rule-added` | 自定义规则添加 | `{ stackName, ruleId, rule }` |
| `rule-removed` | 自定义规则移除 | `{ stackName, ruleId }` |
| `rules-imported` | 规则集导入 | `{ source, stacks }` |
| `shutdown` | 模块关闭 | — |

## 使用示例

```javascript
const { TechStackTemplates } = require('./src/runtime/standards/tech-stack-templates');

// 创建实例
const templates = new TechStackTemplates();

// 查看可用模板
console.log(TechStackTemplates.getAvailableTemplates());
// → ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'express', ...]

// 激活技术栈
templates.activate(['react', 'express']);

// 校验代码
const result = templates.check('src/components/App.jsx', `
import React from 'react';
function app() {
  console.log('debug');
  return <div>Hello</div>;
}
`);

console.log(result.summary);
// → { total: 2, errors: 0, warnings: 2, infos: 0 }

// 自动修复
const fixResult = templates.autoFix('src/components/App.jsx', code, result.violations);
console.log(fixResult.fixed); // → true
console.log(fixResult.changes); // → [{ ruleId: 'rules.noConsoleLog', ... }]

// 批量检查
const batchResult = templates.checkBatch([
  { filePath: 'src/App.jsx', code: '...' },
  { filePath: 'src/server.js', code: '...' },
]);
console.log(batchResult.passed); // → true/false

// 添加自定义规则
templates.addCustomRule('react', 'no-any-types', {
  severity: 'warning',
  check: function(code) { return !code.includes(': any'); },
});

// 导出规则集（团队同步）
const ruleset = templates.exportRules();
// 在另一台机器上导入
templates.importRules(ruleset);

// 查看统计
console.log(templates.getStats());
// → { total: 10, passed: 8, fixed: 2, failed: 0 }

templates.shutdown();
```

## 与其他模块的关系

```
TechStackTemplates
  ├── FrameworkComplianceChecker — 共享autoFix管道，互补校验
  ├── IronRuleEngine — 规则同步机制的技术栈适配
  ├── SkillRouter — /standards 斜杠命令触发
  └── templates-data.js — 模板数据层，分离逻辑与数据
```

## 配置常量

| 常量 | 值 | 说明 |
|------|---|------|
| `VIOLATION_SEVERITY.ERROR` | `'error'` | 错误级别违规 |
| `VIOLATION_SEVERITY.WARNING` | `'warning'` | 警告级别违规 |
| `VIOLATION_SEVERITY.INFO` | `'info'` | 信息级别违规 |

## 相关文档

- [[模块详解-FrameworkComplianceChecker模块]] — 框架合规检查器
- [[模块详解-IronRuleEngine铁律引擎]] — 铁律引擎规则同步
- [[模块详解-基础设施子系统]] — 基础设施子系统总览