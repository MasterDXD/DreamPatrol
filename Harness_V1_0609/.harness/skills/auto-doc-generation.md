---
skill_id: auto-doc-generation
name: 自动文档生成
applicable_agents: [technical-writer]
trigger: deployment阶段documentation Skill完成后
auto_trigger: true
phase: deployment
priority: 3
trigger_conditions:
  - user mentions "自动文档" or "生成文档" or "auto-doc"
  - documentation skill completed
depends_on: [documentation]
conflicts_with: []
causal_inputs:
  - name: api-docs
    source: documentation
    required: true
causal_outputs:
  - name: generated-doc-set
    description: 生成的文档集
evidence_types:
  required:
    - document_file
    - dependency_list
enforcement: recommended
verified: true
stability: beta
usage_count: 30
success_rate: 0.81
production_validated: true
---

# 自动文档生成 Skill

## 目标
从代码、测试和配置中自动提取信息，生成标准化文档集，确保每个项目交付物包含完整的用户手册、依赖说明和变更日志。

## 概述
从代码、测试和配置中自动提取信息，生成标准化文档集，确保每个项目交付物包含完整的用户手册、依赖说明和变更日志。

## 触发条件
- deployment 阶段 documentation Skill 完成后
- 用户明确要求生成文档
- 项目里程碑完成时

## 执行步骤

### 1. 收集源数据
- 读取项目 package.json / config.json 获取依赖和配置
- 读取架构文档（architecture-design Skill 产出）
- 读取测试输出（tdd-implement / integration-testing Skill 产出）
- 读取变更日志（session summary / git log）

### 2. 生成用户手册
- 从架构文档提取功能描述
- 从测试用例提取使用场景
- 从配置文件提取配置选项
- 生成安装、配置、使用、排错四段式手册

### 3. 生成依赖说明
- 从 package.json 提取运行时依赖和开发依赖
- 标注版本约束和兼容性说明
- 列出环境变量和外部服务依赖

### 4. 生成 API 参考（可选）
- 从源码注释提取接口定义
- 从测试用例提取请求/响应示例
- 生成参数说明和返回值文档

### 5. 生成变更日志
- 从 session summary 提取关键决策
- 从 git log 提取变更记录
- 按 Keep a Changelog 格式组织

## 产出物
- `docs/user-manual.md` — 用户手册（必需）
- `docs/dependency-list.md` — 依赖说明（必需）
- `docs/api-reference.md` — API参考（可选）
- `docs/changelog.md` — 变更日志（必需）

## 验收标准
- 用户手册包含安装、配置、使用、排错四部分
- 依赖说明覆盖所有运行时依赖
- 变更日志格式符合 Keep a Changelog 规范
- 所有文档无死链接和空章节

## 证据要求
- document_file: 生成的文档文件
- dependency_list: 依赖清单

## FAQ
**Q: 何时触发自动文档生成？**
A: deployment阶段documentation Skill完成后自动触发，或用户明确要求时。

**Q: 如果项目没有API，是否需要生成API参考？**
A: 不需要，API参考为可选产出物，仅在有公开API时生成。

**Q: 变更日志的数据来源是什么？**
A: 从session summary提取关键决策，从git log提取变更记录。
