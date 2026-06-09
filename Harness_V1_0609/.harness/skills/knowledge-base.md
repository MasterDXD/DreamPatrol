---
skill_id: knowledge-base
name: AI知识库管线
phase: module-development
priority: 2
enforcement: optional
applicable_agents: [domain-analyst, task-worker]
auto_trigger: true
slash_command: /kb
tool_references: [knowledge-base-pipeline]
trigger: auto
trigger_conditions: []
verified: true
stability: beta
---

## 目标

通过三文件夹架构（raw/wiki/outputs）实现AI驱动的知识库管线，支持素材摄入、AI整理编译、查询生成输出的完整工作流，形成"扔进素材→AI整理→提问获取结果→知识库越用越好"的正循环飞轮。

## 步骤

1. 摄入原始素材到raw/目录（手动放置、API摄入、Web抓取）
2. 触发Compile工作流将raw/内容编译为wiki/结构化知识条目
3. 通过Query工作流基于wiki/检索并生成回答
4. 查询结果可回灌raw/形成新素材，驱动正循环飞轮

# knowledge-base — AI知识库管线

## 概述

本技能实现AI驱动的知识库管线，采用三文件夹架构（raw/wiki/outputs），支持素材摄入、AI整理编译、查询生成输出的完整工作流。核心理念：**扔进素材→AI整理→提问获取结果→知识库越用越好**——正循环飞轮。

## 三文件夹架构

知识库根目录：`.harness/knowledge-base/`

### raw/ — 原始素材
- **用途**：存放未经处理的原始文件（文档、代码片段、网页抓取内容等）
- **支持格式**：`.md`、`.txt`、`.json`、`.js`、`.ts`、`.py`
- **最大文件数**：1000（由config.json `maxRawFiles`控制）
- **写入方式**：手动放置、API摄入、Web抓取自动存入
- **命名规范**：`{timestamp}-{sanitized-name}.{ext}`

### wiki/ — AI编译知识
- **用途**：存放经AI整理编译后的结构化知识条目
- **格式**：Markdown（含SCHEMA.md定义的元数据头）
- **最大条目数**：500（由config.json `maxWikiEntries`控制）
- **生成方式**：由compile工作流从raw/自动生成
- **命名规范**：`{id}.md`，id为内容哈希或语义化标识

### outputs/ — 查询输出
- **用途**：存放基于wiki/的查询结果和生成内容
- **最大文件数**：200（由config.json `maxOutputFiles`控制）
- **生成方式**：由query工作流从wiki/检索生成
- **命名规范**：`{query-id}.md`

## SCHEMA.md

wiki/目录下的每个条目遵循SCHEMA.md定义的结构：

```markdown
---
id: <唯一标识>
title: <知识条目标题>
source_file: <来源raw文件路径>
compiled_at: <编译时间ISO8601>
tags: [<标签数组>]
confidence: <置信度0-1>
related_entries: [<关联条目id数组>]
---

<结构化知识内容>
```

## Compile工作流（raw → wiki）

将原始素材编译为结构化知识条目：

1. **扫描raw/**：检测新增或变更的原始文件
2. **内容提取**：读取文件内容，识别文档类型和结构
3. **AI编译**：调用LLM将原始内容整理为结构化知识条目
   - 提取关键概念和实体
   - 建立条目间关联关系
   - 生成标签和分类
   - 计算置信度评分
4. **写入wiki/**：按SCHEMA.md格式写入编译结果
5. **索引更新**：更新内部索引，支持快速检索
6. **事件发布**：通过EventBus发布`kb-entry-compiled`事件

### 触发条件
- 手动触发：`/kb compile`
- 自动触发：当`autoCompile`配置为true时，raw/目录变更自动触发
- 阈值触发：raw/文件数超过wiki/条目数的2倍时建议触发

## Query工作流（wiki → outputs）

基于知识库回答问题并生成输出：

1. **接收查询**：解析用户问题，提取关键词和意图
2. **检索wiki/**：基于关键词和语义相似度检索相关条目
3. **上下文组装**：将检索到的条目组装为LLM上下文
4. **生成回答**：调用LLM基于知识库内容生成回答
5. **写入outputs/**：保存查询结果和引用来源
6. **事件发布**：通过EventBus发布`kb-output-generated`事件

### 检索策略
- **关键词匹配**：精确匹配标题和标签
- **语义检索**：基于EmbeddingService的向量相似度搜索
- **关联扩散**：沿related_entries链扩展1-2跳

## Web摄入工作流（url → raw → wiki）

从网页抓取内容并自动编译：

1. **URL验证**：检查URL格式和可访问性
2. **内容抓取**：通过BrowserUseAdapter或fetch获取网页内容
3. **清洗存储**：去除HTML标签和无关内容，存入raw/
4. **自动编译**：触发compile工作流将raw/内容编译到wiki/

### 安全约束
- URL必须为HTTP/HTTPS协议
- 禁止访问内网地址（SSRF防护）
- 单次抓取内容大小限制：1MB
- 抓取频率限制：每分钟最多10次

## 与现有模块集成

### RAGPipeline
- KB的query工作流可接入RAGPipeline作为检索增强源
- wiki/条目作为RAG文档源，提供高质量结构化上下文
- 配置路径：`RagPipeline.addSource('knowledge-base', { rootPath: '.harness/knowledge-base/wiki' })`

### LLMWiki
- KB的wiki/条目与LLMWiki的知识条目双向同步
- compile工作流产出自动写入LLMWiki索引
- LLMWiki的领域知识可导入KB的raw/作为素材

### GraphRAG
- wiki/条目的related_entries关系可作为GraphRAG的边
- GraphRAG的多跳查询增强KB的关联扩散检索
- 配置路径：`GraphRag.addEdgesFromKB('.harness/knowledge-base/wiki/')`

### BrowserUseAdapter
- Web摄入工作流通过BrowserUseAdapter获取网页内容
- 支持CDP直连和MCP双模式
- 已登录Chrome会话复用，零Token成本获取结构化数据

## 正循环飞轮

知识库的核心价值在于正循环效应：

```
扔进素材 → AI整理 → 提问获取结果 → 知识库越用越好
   ↑                                    |
   |____________________________________|
   每次查询产生新素材，每次编译提升知识质量
```

- **素材积累**：每次交互、调试、调研的产出自动归入raw/
- **知识精化**：compile工作流持续提炼，wiki/条目质量递增
- **查询反馈**：query工作流的输出可回灌raw/形成新素材
- **关联增强**：每次编译发现新的related_entries，检索覆盖面扩大

## 安全约束

### 路径遍历防护
- 所有文件操作必须验证路径在`.harness/knowledge-base/`范围内
- 禁止`..`、符号链接逃逸、绝对路径注入
- 文件名仅允许`[a-zA-Z0-9_-]`字符

### 文件大小限制
- 单个raw文件最大：5MB
- 单个wiki条目最大：2MB
- 单个output文件最大：1MB
- 总知识库大小上限：500MB

### 内容过滤
- 所有写入内容经过sanitizer消毒
- 过滤XSS、SQL注入、命令注入攻击向量
- 敏感信息（API密钥、密码、Token）自动脱敏
- 禁止存储可执行代码到wiki/和outputs/

## 证据要求

完成本技能执行时，必须提供以下证据：

### raw_ingested
- **类型**：结构化对象
- **字段**：`{ fileCount: number, totalSize: number, fileTypes: string[] }`
- **验证**：fileCount > 0，totalSize ≥ 0，fileTypes非空

### wiki_compiled
- **类型**：结构化对象
- **字段**：`{ entriesCompiled: number, entriesTotal: number, avgConfidence: number, newRelations: number }`
- **验证**：entriesCompiled > 0，avgConfidence ∈ [0, 1]

### output_generated
- **类型**：结构化对象
- **字段**：`{ queryId: string, wikiSources: string[], tokenEstimate: number, confidence: number }`
- **验证**：queryId有效，wikiSources非空，confidence ∈ [0, 1]

## 使用示例

```javascript
const KnowledgeBasePipeline = require('./src/runtime/knowledge-base/knowledge-base-pipeline');

const pipeline = new KnowledgeBasePipeline({
  rootPath: '.harness/knowledge-base',
  supportedFileTypes: ['.md', '.txt', '.json', '.js', '.ts', '.py'],
  autoCompile: false,
  maxRawFiles: 1000,
  maxWikiEntries: 500,
  maxOutputFiles: 200,
});

await pipeline.initialize();

await pipeline.ingestRaw('/path/to/document.md');
await pipeline.ingestUrl('https://example.com/docs/api');

const compileResult = await pipeline.compile();
const queryResult = await pipeline.query('如何配置多Agent协作模式？');

server.setKnowledgeBasePipeline(pipeline);
```

## 验收标准
- [ ] 三文件夹架构（raw/wiki/outputs）正常工作
- [ ] Compile工作流从raw生成wiki条目
- [ ] Query工作流从wiki检索并生成输出
- [ ] 正循环飞轮运转（查询→新素材→编译）

## 常见问题
- **Q: compile后wiki条目质量差？**
  A: 检查raw/素材质量，确保内容足够丰富和结构化
- **Q: query检索结果不相关？**
  A: 检查wiki条目的tags和related_entries是否完整，考虑增加语义检索权重
