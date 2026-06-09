# 模块详解-RagPipeline检索增强生成管道

> 版本：2.73.4 | 文件：src/runtime/workflow/rag-pipeline.js

## 概述

RAGPipeline 位于 `src/runtime/workflow/rag-pipeline.js`，是框架的检索增强生成（RAG）管道，提供文档摄入、文本分块、向量嵌入和语义检索能力。支持单文档和目录级批量摄入，可配置分块大小与重叠，通过 CausalVectorIndex 实现向量搜索，并可选集成 GraphRAG 以合并知识图谱结果。继承自 `EventEmitter`，使用 `withShutdown` 混入提供优雅关闭能力，摄入操作串行排队执行以避免并发冲突。

## 核心特性

- **文档摄入管道**：支持单文档摄入（`ingestDocument`）和目录递归批量摄入（`ingestDirectory`）
- **智能分块**：可配置分块大小和重叠，在换行符处优先切分以保持语义完整性
- **向量检索**：基于 CausalVectorIndex 的 Top-K 语义搜索
- **GraphRAG 集成**：可选附加 GraphRAG 实例，查询时合并知识图谱结果与向量搜索结果
- **串行摄入队列**：所有摄入操作通过 Promise 链串行排队，避免并发写入冲突
- **容量保护**：文档数上限 500、分块数上限 50000，超限时自动淘汰最旧文档
- **文件类型过滤**：目录摄入时仅处理支持的文件扩展名，跳过隐藏目录和 node_modules
- **路径安全**：目录摄入限制在项目根目录内，防止路径遍历

## 类定义

```javascript
class RAGPipeline extends EventEmitter
```

通过 `withShutdown` 混入增强，导出为：

```javascript
module.exports = withShutdown(RAGPipeline)
```

## 常量

### 分块与检索配置

| 常量 | 值 | 说明 |
|------|------|------|
| DEFAULT_CHUNK_SIZE | 512 | 默认分块大小（字符数） |
| DEFAULT_CHUNK_OVERLAP | 64 | 默认分块重叠（字符数） |
| DEFAULT_TOP_K | 5 | 默认返回的最大结果数 |
| MAX_DOCUMENT_SIZE | MAX_JSON_FILE_SIZE | 单文档最大尺寸 |
| MAX_DOCUMENTS | 500 | 最大文档数 |
| MAX_CHUNKS | 50000 | 最大分块数 |

### 支持的文件扩展名

```
.md, .txt, .json, .js, .ts, .py, .go, .rs, .java, .jsx, .tsx
```

## 构造函数

```javascript
new RAGPipeline(projectRoot, options?)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `projectRoot` | string | - | 项目根目录路径（必填） |
| `options.chunkSize` | number | 512 | 文本分块大小（字符数） |
| `options.chunkOverlap` | number | 64 | 连续分块间的重叠字符数 |
| `options.topK` | number | 5 | 默认向量搜索返回结果数 |

## 核心 API

### 文档操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `ingestDocument` | `ingestDocument(docPath, content, metadata?) → Promise<{success, docId?, chunkCount?, error?}>` | 摄入单个文档，分块、嵌入并索引，已存在则先移除再重新索引 |
| `ingestDirectory` | `ingestDirectory(dirPath, options?) → Promise<{success, results?}>` | 批量摄入目录下所有支持的文件，递归遍历子目录 |
| `removeDocument` | `removeDocument(docId) → boolean` | 移除指定文档及其所有分块，从向量索引中删除 |
| `query` | `query(queryText, options?) → Promise<{success, query?, results?, error?}>` | 执行 RAG 查询，先向量搜索再合并 GraphRAG 结果 |

### 查询与统计

| 方法 | 签名 | 说明 |
|------|------|------|
| `getStats` | `getStats() → Object` | 获取管道统计信息，含子组件统计 |

### 依赖注入

| 方法 | 签名 | 说明 |
|------|------|------|
| `attachGraphRAG` | `attachGraphRAG(graphRAG) → this` | 附加 GraphRAG 实例，需实现 `query` 方法 |

### ingestDocument() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `docPath` | string | 文档路径标识（必填，非空字符串） |
| `content` | string | 文档文本内容（必填，非空字符串） |
| `metadata` | Object | 文档元数据（可选） |

### ingestDocument() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `docId` | string | 文档唯一标识 |
| `chunkCount` | number | 生成的分块数 |
| `error` | string | 错误信息（失败时） |

### ingestDirectory() 参数详情

| 参数 | 类型 | 说明 |
|------|------|------|
| `dirPath` | string | 相对于项目根目录的目录路径 |
| `options.maxDepth` | number | 最大递归深度（默认 10） |

### ingestDirectory() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `results.ingested` | number | 成功摄入的文件数 |
| `results.failed` | number | 失败的文件数 |
| `results.skipped` | number | 跳过的文件数（不支持的扩展名） |

### query() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `query` | string | 查询文本 |
| `results` | Array | 搜索结果列表 |
| `results[].id` | string | 分块 ID |
| `results[].score` | number | 相似度分数 |
| `results[].text` | string | 分块文本内容 |
| `results[].metadata` | Object | 分块元数据 |

### getStats() 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `documentsIndexed` | number | 已索引的文档总数 |
| `chunksCreated` | number | 已创建的分块总数 |
| `queriesExecuted` | number | 已执行的查询总数 |
| `vectorIndexStats` | Object | 向量索引统计 |
| `embeddingStats` | Object | 嵌入服务统计 |

## 事件

| 事件 | 触发时机 | 事件数据 |
|------|---------|---------|
| `document-indexed` | 文档索引完成 | `{docId, chunkCount}` |
| `document-removed` | 文档移除完成 | `{docId}` |
| `query-executed` | 查询执行完成 | `{query, resultCount}` |
| `error` | 操作发生错误 | Error 对象 |

## 与其他模块的集成

| 模块 | 集成方式 | 说明 |
|------|---------|------|
| EmbeddingService | 内部创建 | 文本向量化，配置为本地提供者、128维、启用缓存 |
| CausalVectorIndex | 内部创建 | 向量索引与搜索，最大 10000 向量 |
| GraphRAG | `attachGraphRAG()` | 可选附加，查询时合并知识图谱结果（最多取 min(topK, 3) 个图谱结果） |
| withShutdown | 混入 | 提供优雅关闭能力，`_onShutdown()` 清理文档/分块/嵌入服务/向量索引 |
| safeAssign | 工具函数 | 安全合并元数据对象 |

### 摄入队列机制

所有摄入操作通过 `_ingestQueue`（Promise 链）串行排队执行：

```
ingestDocument(A) → ingestDocument(B) → ingestDocument(C)
        ↓                  ↓                  ↓
   _ingestQueue       _ingestQueue       _ingestQueue
```

每个新的 `ingestDocument` 调用将操作追加到队列尾部，确保文档索引不会并发冲突。

### GraphRAG 结果合并

查询时，若已附加 GraphRAG 实例，会额外执行图谱查询并合并结果：

1. 向量搜索获取 Top-K 结果
2. GraphRAG 查询获取最多 min(topK, 3) 个图谱结果
3. 去重合并：图谱结果中与向量结果 ID 不同的条目追加到结果列表
4. 图谱结果分数上限为 0.8，避免覆盖高相关性的向量结果

### 分块算法

`_chunkText` 方法实现智能分块：

1. 按指定 `chunkSize` 切分文本
2. 在切分点附近寻找换行符，优先在换行处切分（保持语义完整性）
3. 连续分块间保留 `chunkOverlap` 字符的重叠
4. 重叠不超过 `chunkSize - 1`

## 使用示例

### 基本用法：文档摄入与查询

```javascript
const RAGPipeline = require('./src/runtime/workflow/rag-pipeline');

const pipeline = new RAGPipeline('/project/root', {
  chunkSize: 512,
  chunkOverlap: 64,
  topK: 5,
});

// 摄入单个文档
const result = await pipeline.ingestDocument('src/README.md', content, {
  extension: '.md',
  fileName: 'README.md',
});
console.log('文档ID:', result.docId, '分块数:', result.chunkCount);

// 执行查询
const queryResult = await pipeline.query('如何配置缓存策略？', { topK: 3 });
for (const r of queryResult.results) {
  console.log(`[${r.score.toFixed(3)}] ${r.text.substring(0, 80)}...`);
}
```

### 批量摄入目录

```javascript
// 递归摄入 src 目录下所有支持的文件
const dirResult = await pipeline.ingestDirectory('src', { maxDepth: 10 });
console.log(`摄入: ${dirResult.results.ingested}, 失败: ${dirResult.results.failed}, 跳过: ${dirResult.results.skipped}`);
```

### 集成 GraphRAG

```javascript
const pipeline = new RAGPipeline('/project/root');

// 附加 GraphRAG 实例
pipeline.attachGraphRAG(graphRAGInstance);

// 查询时自动合并图谱结果
const result = await pipeline.query('用户认证流程');
// result.results 包含向量搜索 + 知识图谱的合并结果
```

### 文档管理与统计

```javascript
// 移除文档
pipeline.removeDocument('doc_src_README_md_xxxx');

// 查看统计
const stats = pipeline.getStats();
console.log(`文档: ${stats.documentsIndexed}, 分块: ${stats.chunksCreated}, 查询: ${stats.queriesExecuted}`);
```

## 相关文档

- [模块详解-GraphRag模块](模块详解-GraphRag模块.md)
- [模块详解-因果子系统](模块详解-因果子系统.md)
- [模块详解-工作流子系统](模块详解-工作流子系统.md)
