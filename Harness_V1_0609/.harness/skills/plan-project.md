---
skill_id: plan-project
name: 项目规划脚手架
phase: architecture-design
priority: high
description: |
  项目文件结构自动生成器，融合Vibe Coding PlanningWithFiles核心能力。
  从需求描述自动检测技术栈和项目类型，生成完整的项目目录结构和初始文件。
trigger: auto
trigger_conditions:
  - 新项目初始化
  - 用户请求"规划项目结构"或"创建项目脚手架"
  - 架构设计阶段需要文件结构规划
  - 需要快速搭建项目骨架
applicable_agents: []
auto_trigger: true
depends_on: []
blocks: []
verified: true
stability: stable
---

## 目标

从需求描述自动检测技术栈和项目类型，生成完整的项目目录结构和初始文件（样板代码、配置文件、README等），快速搭建项目骨架。

## 步骤

1. 分析需求描述，自动检测技术栈和项目类型
2. 选择或匹配预设模板（8种模板可选）
3. 预览生成结果（dryRun模式）
4. 确认后生成完整项目目录结构和初始文件

# 项目规划脚手架（Project Scaffolder）

融合自Vibe Coding PlanningWithFiles技能。

## 核心能力

1. **8种预设模板**：node-cli/node-web/node-api/fullstack/library/pwa/monorepo/custom
2. **自然语言规划**：从描述自动检测技术栈、项目类型和特性
3. **完整文件生成**：样板代码、配置文件、README、.gitignore、package.json
4. **dryRun模式**：预览生成结果而不实际创建文件

## 使用方式

### 编程接口
```javascript
const ProjectScaffolder = require('./src/runtime/workflow/project-scaffolder');
const scaffolder = new ProjectScaffolder({ dryRun: false });

// 从模板生成
const result = await scaffolder.scaffold('node-web', { outputDir: './my-project' });

// 从描述生成（PlanningWithFiles核心能力）
const result = await scaffolder.scaffoldFromDescription(
  '一个使用Node.js和SQLite的Web应用，需要用户认证和REST API',
  { outputDir: './my-app' }
);
```

### 斜杠命令
`/plan-project` — 启动项目规划

## 预设模板

| 模板ID | 名称 | 说明 | 文件数 |
|--------|------|------|--------|
| node-cli | Node.js CLI | 命令行工具 | 8 |
| node-web | Node.js Web | Web应用 | 11 |
| node-api | Node.js API | REST API | 10 |
| fullstack | Full-Stack | 全栈应用 | 14 |
| library | Library | 库/包 | 9 |
| pwa | PWA | 渐进式Web应用 | 11 |
| monorepo | Monorepo | 多包项目 | 9 |
| custom | Custom | 自定义结构 | 0 |

## 事件

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| scaffold-completed | 脚手架生成完成 | { templateId, outputDir, fileCount } |

## 验收标准
- [ ] 项目目录结构已生成
- [ ] 样板代码、配置文件、README完整
- [ ] dryRun模式下预览结果正确
- [ ] 技术栈自动检测准确

## 常见问题
- **Q: 自动检测的技术栈不准确？**
  A: 使用scaffoldFromDescription()时提供更详细的需求描述，或直接使用模板ID指定
- **Q: 生成的文件需要修改？**
  A: 脚手架生成的是初始结构，后续可通过tdd-implement和module-development技能继续开发
