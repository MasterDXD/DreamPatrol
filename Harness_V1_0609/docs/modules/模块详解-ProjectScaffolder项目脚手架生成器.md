# 模块详解-ProjectScaffolder项目脚手架生成器

> 版本：2.73.4 | 文件：src/runtime/workflow/project-scaffolder.js

## 概述

ProjectScaffolder 位于 `src/runtime/workflow/project-scaffolder.js`，是框架的项目脚手架生成器，融合 Vibe Coding "PlanningWithFiles" 技能核心能力，从需求描述自动生成项目文件结构。桥接 Harness PhaseOrchestrator（开发阶段管理）与 Vibe Coding（项目目录树和文件结构自动生成）之间的能力缺口。继承自 `EventEmitter`，使用 `withShutdown` 混入提供优雅关闭能力，内置 8 个预设模板和自然语言描述匹配功能。

## 核心特性

- **预设模板**：内置 8 个项目模板（node-cli、node-web、node-api、fullstack、library、pwa、monorepo、custom）
- **自然语言匹配**：从需求描述自动检测技术栈、项目类型和特性关键词，匹配最佳模板
- **特性检测**：支持认证、数据库、配置、日志、Docker 等特性关键词检测，自动生成对应文件
- **自定义文件**：支持在模板基础上追加自定义文件列表
- **路径安全防护**：禁止 `..`、空字节和绝对路径，防止路径遍历攻击
- **试运行模式**：`dryRun` 选项下仅模拟生成，不实际创建文件
- **可选标准文件**：自动生成 README.md、.gitignore、package.json（可配置开关）
- **依赖注入**：支持挂载 GoalExecutor 和 PhaseOrchestrator

## 类定义

```javascript
class ProjectScaffolder extends EventEmitter
```

通过 `withShutdown` 混入增强，导出为：

```javascript
module.exports = withShutdown(ProjectScaffolder)
```

## 常量

### 文件类型枚举（FILE_TYPES）

| 类型 | 值 | 说明 |
|------|------|------|
| ENTRY | `'entry'` | 入口文件 |
| MODULE | `'module'` | 模块文件 |
| DIRECTORY | `'directory'` | 目录 |
| CONFIG | `'config'` | 配置文件 |
| TEST | `'test'` | 测试文件 |
| DOCS | `'docs'` | 文档文件 |
| TEMPLATE | `'template'` | 模板文件 |
| STYLE | `'style'` | 样式文件 |

### 默认配置（DEFAULT_CONFIG）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `defaultStack` | string | `'node'` | 默认技术栈 |
| `maxFiles` | number | 200 | 单次脚手架最大文件数 |
| `maxDepth` | number | 5 | 目录最大深度 |
| `includeReadme` | boolean | true | 是否包含 README |
| `includeGitignore` | boolean | true | 是否包含 .gitignore |
| `includePackageJson` | boolean | true | 是否包含 package.json |
| `dryRun` | boolean | false | 试运行模式 |

### 预设模板（PRESET_TEMPLATES）

| 模板 ID | 名称 | 技术栈 | 文件数 | 说明 |
|---------|------|--------|--------|------|
| `node-cli` | Node.js CLI | node, javascript | 8 | 命令行工具项目 |
| `node-web` | Node.js Web | node, javascript, html, css | 11 | Web 应用项目 |
| `node-api` | Node.js API | node, javascript | 10 | REST API 项目 |
| `fullstack` | Full-Stack | node, javascript, html, css | 14 | 全栈 Web 应用 |
| `library` | Library | node, javascript | 9 | 库/包项目 |
| `pwa` | PWA | html, css, javascript | 11 | 渐进式 Web 应用 |
| `monorepo` | Monorepo | node, javascript | 9 | Monorepo 多包项目 |
| `custom` | Custom | - | 0 | 自定义项目结构 |

### 特性关键词映射（FEATURE_KEYWORDS）

| 特性 | 关键词 | 生成的额外文件 |
|------|--------|---------------|
| auth | auth, 认证, 登录, jwt, token, oauth | src/auth/, src/auth/middleware.js, src/auth/strategies/ |
| database | database, 数据库, db, sql, mongo, postgres | src/db/, src/db/connection.js, src/db/migrations/ |
| config | config, 配置, env, dotenv | src/config/, src/config/index.js, .env.example |
| logging | log, 日志, logger, winston, pino | src/logger/, src/logger/index.js |
| docker | docker, 容器, deploy, 部署 | Dockerfile, docker-compose.yml, .dockerignore |

## 构造函数

```javascript
new ProjectScaffolder(options?)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options.defaultStack` | string | `'node'` | 默认技术栈 |
| `options.maxFiles` | number | 200 | 单次脚手架最大文件数 |
| `options.maxDepth` | number | 5 | 目录最大深度 |
| `options.includeReadme` | boolean | true | 是否包含 README |
| `options.includeGitignore` | boolean | true | 是否包含 .gitignore |
| `options.includePackageJson` | boolean | true | 是否包含 package.json |
| `options.dryRun` | boolean | false | 试运行模式 |

## 核心 API

### 模板操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `listTemplates` | `listTemplates() → Array<{id, name, description, stack, fileCount}>` | 列出所有可用的项目模板 |
| `getTemplate` | `getTemplate(templateId) → Object\|null` | 获取指定模板的完整定义 |

### 脚手架生成

| 方法 | 签名 | 说明 |
|------|------|------|
| `scaffold` | `scaffold(templateId, options?) → Promise<{scaffoldId, templateId, outputDir, files, stats}>` | 从模板生成项目文件结构 |
| `scaffoldFromDescription` | `scaffoldFromDescription(description, options?) → Promise<Object>` | 从自然语言描述生成项目结构（PlanningWithFiles 核心能力） |

### 查询与统计

| 方法 | 签名 | 说明 |
|------|------|------|
| `getScaffold` | `getScaffold(scaffoldId) → Object\|null` | 获取指定脚手架记录 |
| `getStats` | `getStats() → Object` | 获取统计信息 |

### 依赖注入

| 方法 | 签名 | 说明 |
|------|------|------|
| `attachGoalExecutor` | `attachGoalExecutor(executor) → this` | 挂载 GoalExecutor，需实现 `createGoal` 方法 |
| `attachPhaseOrchestrator` | `attachPhaseOrchestrator(orchestrator) → this` | 挂载 PhaseOrchestrator，需实现 `getCurrentPhase` 方法 |

### scaffold() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `templateId` | string | 模板标识符（必填，必须存在于 PRESET_TEMPLATES） |
| `options.outputDir` | string | 输出目录，默认 `process.cwd()` |
| `options.customFiles` | Array | 自定义文件列表，与模板文件合并 |
| `options.projectName` | string | 项目名称，默认为 outputDir 的 basename |

### scaffold() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `scaffoldId` | string | 脚手架唯一标识 |
| `templateId` | string | 使用的模板标识符 |
| `outputDir` | string | 输出目录 |
| `files` | Array | 已创建文件列表 |
| `stats` | Object | 统计信息 |

### scaffoldFromDescription() 返回值

除 scaffold() 返回值外，额外包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `detectedFeatures` | string[] | 检测到的特性列表 |
| `matchedTemplateId` | string | 匹配的模板标识符 |

### getStats() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `scaffoldsCreated` | number | 已创建的脚手架总数 |
| `filesGenerated` | number | 已生成的文件总数 |
| `templatesUsed` | Object | 各模板使用次数统计 |

## 事件

| 事件 | 触发时机 | 事件数据 |
|------|---------|---------|
| `scaffold-completed` | 脚手架生成完成 | `{scaffoldId, templateId, outputDir, fileCount}` |
| `scaffold-failed` | 脚手架生成失败 | Error 对象 + `{templateId?, path?}` |
| `goal-creation-failed` | GoalExecutor 目标创建失败（不阻塞流程） | `{templateId, scaffoldId, error}` |
| `shutdown` | 脚手架生成器关闭 | - |

## 与其他模块的集成

| 模块 | 集成方式 | 说明 |
|------|---------|------|
| GoalExecutor | `attachGoalExecutor()` | 脚手架生成时创建目标追踪，目标创建失败不阻塞流程 |
| PhaseOrchestrator | `attachPhaseOrchestrator()` | 衔接脚手架生成与开发阶段流程 |
| withShutdown | 混入 | 提供优雅关闭能力，`_onShutdown()` 清理脚手架记录和依赖引用 |
| ensureDirSync | 工具函数 | 确保目录存在，用于创建文件和目录 |
| generateId | 工具函数 | 生成脚手架唯一标识 |
| mergeConfig | 工具函数 | 安全合并配置对象 |

### 路径安全防护

`_validateFiles` 方法对所有文件路径执行安全检查：

| 检查项 | 规则 | 说明 |
|--------|------|------|
| 路径遍历 | 禁止包含 `..` | 防止目录遍历攻击 |
| 空字节 | 禁止包含 `\0` | 防止空字节注入 |
| 绝对路径 | 禁止绝对路径 | 确保所有路径相对于输出目录 |
| 文件数量 | 不超过 `maxFiles` | 防止资源耗尽 |
| 目录深度 | 不超过 `maxDepth` | 防止过深的目录嵌套 |

### 自然语言匹配算法

`_matchTemplate` 方法通过关键词评分机制匹配最佳模板：

1. **项目类型关键词匹配**（权重 ×2）：TYPE_KEYWORDS 中的关键词命中加分
2. **技术栈关键词匹配**（权重 ×1）：STACK_KEYWORDS 中的关键词命中加分
3. **模板描述关键词匹配**（权重 ×1）：模板描述中的词命中加分
4. 返回最高分模板，无匹配时默认返回 `node-cli`

## 使用示例

### 从模板生成项目

```javascript
const ProjectScaffolder = require('./src/runtime/workflow/project-scaffolder');

const scaffolder = new ProjectScaffolder({ defaultStack: 'node' });

// 从模板生成项目
const result = await scaffolder.scaffold('node-api', {
  outputDir: '/project/my-api',
  projectName: 'my-api',
});
console.log('脚手架ID:', result.scaffoldId);
console.log('创建文件数:', result.files.filter(f => f.created).length);
```

### 从自然语言描述生成项目

```javascript
const result = await scaffolder.scaffoldFromDescription(
  '一个Node.js REST API项目，需要用户认证和数据库模块',
  { outputDir: '/project/my-api' }
);
console.log('匹配模板:', result.matchedTemplateId);
console.log('检测到特性:', result.detectedFeatures); // ['auth', 'database']
```

### 试运行模式

```javascript
const scaffolder = new ProjectScaffolder({ dryRun: true });

const result = await scaffolder.scaffold('fullstack', {
  outputDir: '/project/my-app',
});
// result.files 中所有文件的 created 为 false，不实际创建文件
```

### 自定义文件追加

```javascript
const result = await scaffolder.scaffold('node-web', {
  outputDir: '/project/my-web',
  customFiles: [
    { path: 'src/plugins/', type: 'directory', description: '插件目录' },
    { path: 'src/plugins/auth.js', type: 'module', description: '认证插件' },
  ],
});
```

### 查看模板列表与统计

```javascript
// 列出所有模板
const templates = scaffolder.listTemplates();
for (const t of templates) {
  console.log(`${t.id}: ${t.name} (${t.fileCount} files)`);
}

// 查看统计
const stats = scaffolder.getStats();
console.log(`已创建: ${stats.scaffoldsCreated}, 文件: ${stats.filesGenerated}`);
```

## 相关文档

- [模块详解-GoalExecutor目标执行器](模块详解-GoalExecutor目标执行器.md)
- [模块详解-PhaseOrchestrator阶段编排器](模块详解-PhaseOrchestrator阶段编排器.md)
- [模块详解-工作流子系统](模块详解-工作流子系统.md)
