# 模块详解-LLM知识库

> 版本：2.73.4 | 文件：src/runtime/thought/llm-wiki.js | 行数：~450行

---

## 模块概述

LLMWiki模块实现了面向LLM的结构化知识库系统，采用文件系统作为持久化存储，以Markdown文件+YAML Front Matter格式管理知识条目。模块将知识分为五个类别（concepts/decisions/patterns/api/troubleshooting），支持条目的CRUD操作、全文搜索、双向链接索引和反向链接查询，以及基于上下文的更新建议。核心价值在于为Agent提供可持久化、可检索、可链接的知识管理能力，使Agent积累的知识能在后续会话中被复用。

## 融合来源

融合自个人知识管理（PKM）领域的"数字花园"（Digital Garden）概念和Zettelkasten卡片盒笔记法。双向链接机制借鉴了Obsidian/Roam Research等工具的知识图谱思想，使知识条目之间形成网状关联而非树状层级。文件系统存储方案融合了"文本即数据库"（Text as Database）理念，确保知识对人类和机器同时可读。

## 核心API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `initialize(wikiRoot)` | wikiRoot: string | `this` | 初始化知识库，创建目录结构和索引 |
| `createEntry(category, title, content, metadata?)` | category: string, title: string, content: string, metadata?: Object | `Object \| null` | 创建知识条目 |
| `updateEntry(category, slug, updates)` | category: string, slug: string, updates: Object | `Object \| null` | 更新知识条目 |
| `deleteEntry(category, slug)` | category: string, slug: string | `boolean` | 删除知识条目 |
| `getEntry(category, slug)` | category: string, slug: string | `Object \| null` | 获取指定条目 |
| `search(query, options?)` | query: string, options?: `{ categories, tags, fullText }` | `Object[]` | 搜索条目（标题+标签+全文） |
| `listEntries(category?)` | category?: string | `Object[]` | 列出条目 |
| `getBacklinks(category, slug)` | category: string, slug: string | `Object[]` | 获取反向链接 |
| `suggestUpdates(context)` | context: string | `Object[]` | 基于上下文建议需要更新的条目 |
| `getStats()` | 无 | `Object` | 获取统计信息 |
| `attachSqliteStore(sqliteStore)` | sqliteStore: SqliteStore | 无 | 关联SQLite存储 |
| `attachEmbeddingService(embeddingService)` | embeddingService: EmbeddingService | 无 | 关联嵌入服务 |

### 静态属性

| 属性 | 说明 |
|------|------|
| `DEFAULT_CONFIG` | 默认配置 |
| `VALID_CATEGORIES` | 有效类别集合 |

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `categories` | string[] | ['concepts', 'decisions', 'patterns', 'api', 'troubleshooting'] | 知识类别列表 |
| `maxEntriesPerCategory` | number | 200 | 每个类别最大条目数 |
| `autoIndex` | boolean | true | 初始化时是否自动加载所有条目建立索引 |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `initialized` | 知识库初始化完成 | `{ wikiRoot }` |
| `entry-created` | 条目创建 | `{ category, slug, title }` |
| `entry-updated` | 条目更新 | `{ category, slug, title }` |
| `entry-deleted` | 条目删除 | `{ category, slug }` |

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`fs`、`path`（文件系统操作）
- 依赖：`../../utils/shutdown-mixin.js`（优雅关闭混入）
- 依赖：`../../utils/debug-logger.js`（调试日志）
- 依赖：`../../utils/safe-execute.js`（safeCall, safeExecute）
- 依赖：`../../utils/fs-utils.js`（ensureDirSync, scanMarkdownDirSync, parseMarkdownFile）
- 依赖：`../../utils/constants.js`（UTF8_ENCODING, MARKDOWN_EXT）
- 可选关联：`SqliteStore`、`EmbeddingService`（通过attach方法）

## 使用示例

```javascript
const LLMWiki = require('./src/runtime/thought/llm-wiki');

const wiki = new LLMWiki({ maxEntriesPerCategory: 100 });
wiki.initialize('./knowledge-base');

wiki.createEntry('concepts', '分层架构', '框架采用四层架构：Interaction→Business→Domain→Infrastructure', {
  tags: ['架构', '分层', '依赖方向'],
  confidence: 0.9,
  source: 'architecture-design',
});

wiki.createEntry('patterns', 'TDD门禁', '先写测试后写代码，RED-GREEN-REFACTOR循环', {
  tags: ['TDD', '测试驱动', '门禁'],
  confidence: 0.95,
});

wiki.createEntry('decisions', '选择CommonJS', '项目采用CommonJS模块系统，参见[[架构分析-AIProject系统]]', {
  tags: ['模块系统', 'CommonJS'],
});

const results = wiki.search('分层架构', { categories: ['concepts', 'patterns'] });
console.log('Found:', results.length);

const backlinks = wiki.getBacklinks('concepts', '分层架构');
console.log('Referenced by:', backlinks.length, 'entries');

const suggestions = wiki.suggestUpdates('分层架构的依赖方向规则');
console.log('Update suggestions:', suggestions.length);
```

## 与现有模块的集成点

- **GraphRAG**：LLMWiki的文档内容可摄入GraphRAG，建立概念间的图谱关联，实现从条目搜索到图谱推理的升级
- **DreamEngine**：跨会话学习引擎生成的笔记可自动写入LLMWiki对应类别，实现知识的持久化积累
- **RagPipeline**：RAG管道将LLMWiki作为检索源之一，在生成回答时引用知识库中的已有知识
- **DocFreshnessGuard**：文档新鲜度守卫利用LLMWiki的`suggestUpdates()`检测过时知识
- **BrainMemory**：BrainMemory在存储高置信度记忆时，可同步写入LLMWiki实现知识的双重持久化
- **ContextCompressionEngine**：上下文压缩引擎在需要领域知识时，从LLMWiki检索相关条目注入上下文
