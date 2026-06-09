# 模块详解-GraphRag模块

> 版本：2.73.4 | 文件：src/runtime/workflow/graph-rag.js | 行数：~825行

---

## 1. 模块定位

GraphRAG是工作流子系统（`src/runtime/workflow/`）中的知识图谱RAG引擎，与同目录下的RagPipeline共同构成框架的双模RAG检索体系。v2.7.146新增Graphify子系统（`src/runtime/graphify/`）后，GraphRAG通过`attachGraphifyCompiler()`方法集成Graphify编译管线，查询时优先使用Graphify编译产出的图谱数据，当Graphify不可用时自动降级到原有正则提取逻辑，确保向后兼容。

### 与RagPipeline的区别与互补关系

| 维度 | GraphRAG | RagPipeline |
|------|----------|-------------|
| 检索范式 | 图结构遍历 + 实体关系推理 | 向量相似度搜索 |
| 知识表示 | 实体-关系三元组（有向加权图） | 文本分块 + 嵌入向量 |
| 查询方式 | 多跳子图扩展、路径提取 | Top-K向量近邻搜索 |
| 核心优势 | 关系推理、多跳关联发现 | 语义相似度匹配、大规模文本检索 |
| 适用场景 | "A依赖什么？""X和Y之间有何关联？" | "哪些文档与查询语义相关？" |

两者通过RagPipeline的`attachGraphRAG()`方法集成，查询时先执行向量搜索，再合并图谱结果，实现结构化知识与语义检索的互补。GraphRAG专注于**结构化知识**的提取与推理，RagPipeline专注于**非结构化文本**的语义检索。

---

## 2. 核心能力

### 知识图谱检索

从文档内容中自动提取四类实体（PERSON、ORG、TECH、CONCEPT）和三类关系（DEPENDS_ON、PART_OF、RELATED_TO），构建有向加权知识图谱。支持基于实体的子图检索和邻居扩展。

### 实体关系推理

通过段落级共现分析和关键词模式匹配，自动推断实体间的关系类型。关系权重随共现次数递增（每次+0.1，上限1.0），弱关系（低于`minRelationWeight`）自动剪枝。

### 多跳查询

从查询中提取实体种子，沿关系边进行BFS扩展，支持可配置的最大跳数（`maxHops`）。对扩展子图进行相关性评分（匹配度 + 关系权重加成 + 距离衰减），返回排序结果和推理路径。

---

## 3. 类定义与构造函数

### 继承体系

```
EventEmitter
  └─ GraphRAG
       └─ withShutdown(GraphRAG)  // 混入关闭能力
```

GraphRAG继承EventEmitter提供事件通知能力，通过`withShutdown`混入获得优雅关闭支持（`shutdown()`、`isHealthy()`、`guardShutdown()`）。

### 类定义

```javascript
class GraphRAG extends EventEmitter {
  constructor(options)
  ingestDocument(docId, content, metadata)
  buildClusters()
  query(question, options)
  getEntityGraph(entityId, depth)
  getClusters()
  getStats()
  attachEmbeddingService(service)
  attachVectorIndex(index)
  attachGraphifyCompiler(compiler)
  shutdown()          // via withShutdown mixin
  isHealthy()         // via withShutdown mixin
}
```

### 构造函数

#### `constructor(options)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | object | 否 | 配置选项 |
| `options.maxEntities` | number | 否 | 最大实体数量，默认5000 |
| `options.maxRelations` | number | 否 | 最大关系数量，默认10000 |
| `options.maxClusters` | number | 否 | 最大聚类数量，默认100 |
| `options.maxDocuments` | number | 否 | 最大文档数量，默认500 |
| `options.cooccurrenceWindow` | string | 否 | 共现窗口，默认`'paragraph'` |
| `options.minRelationWeight` | number | 否 | 关系最小权重阈值，默认0.1 |

初始化内部状态：

| 属性 | 类型 | 说明 |
|------|------|------|
| `_entities` | Map\<id, entity\> | 实体存储，键为`ent_N`格式ID |
| `_entityKeyIndex` | Map\<key, id\> | 实体键索引，键为`TYPE:Name`格式 |
| `_relations` | Map\<id, relation\> | 关系存储，键为`rel_N`格式ID |
| `_relationKeyIndex` | Map\<key, id\> | 关系键索引，键为`source->target:TYPE`格式 |
| `_clusters` | Map\<id, cluster\> | 聚类存储，键为`cluster_N`格式ID |
| `_documents` | Map\<docId, doc\> | 文档存储 |
| `_embeddingService` | object\|null | 嵌入服务实例（可选） |
| `_vectorIndex` | object\|null | 向量索引实例（可选） |
| `_stats` | object | 运行统计信息 |

---

## 4. 公开方法详解

### `ingestDocument(docId, content, metadata)`

摄入文档并提取实体与关系。若文档ID已存在，先移除旧实体再重新提取。文档数量达到上限时，自动淘汰最早摄入的文档。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docId` | string | 是 | 文档唯一标识 |
| `content` | string | 是 | 文档文本内容 |
| `metadata` | object | 否 | 文档元数据 |

**返回值**：`{ success: boolean, docId?: string, entityCount?: number, relationCount?: number, error?: string }`

**执行流程**：
1. 参数校验（docId和content必填）
2. 若文档已存在，调用`_removeDocumentEntities`清除旧数据
3. 文档数量达上限时淘汰最早文档
4. 存储文档记录
5. 调用`_extractEntities`提取实体
6. 调用`_extractRelations`提取关系
7. 更新统计信息
8. 触发`document-ingested`事件

### `buildClusters()`

基于实体关系图构建聚类。使用连通分量检测算法识别社区，按社区大小降序排列，取前`maxClusters`个。每次调用会清除旧聚类重新构建。

**返回值**：`{ success: boolean, clusterCount?: number, error?: string }`

**执行流程**：
1. 清除现有聚类
2. 构建邻接表（`_buildAdjacency`）
3. 查找连通分量（`_findConnectedComponents`）
4. 按社区大小降序排列
5. 为每个社区构建聚类对象（`_buildClusterFromCommunity`）
6. 触发`clusters-built`事件

### `query(question, options)`

执行图谱查询。从问题中提取实体种子，匹配图谱实体，扩展子图，评分排序，提取推理路径。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `question` | string | 是 | 查询问题文本 |
| `options` | object | 否 | 查询选项 |
| `options.topK` | number | 否 | 返回最大结果数，默认5 |
| `options.maxHops` | number | 否 | 最大扩展跳数，默认2 |
| `options.minRelevance` | number | 否 | 最小相关性阈值，默认0.3 |

**返回值**：`{ success: boolean, question?: string, results?: Array, paths?: Array, error?: string }`

**results数组元素结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `entityId` | string | 实体ID |
| `entity` | object | 实体对象（name, type, mentions） |
| `score` | number | 相关性评分（0~1.0） |
| `documentIds` | string[] | 关联文档ID列表 |
| `distance` | number | 距种子实体的跳数 |

**paths数组元素结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | string | 路径起点实体名 |
| `to` | string | 路径终点实体名 |
| `length` | number | 路径长度（跳数） |
| `entities` | Array | 路径上的实体序列 |

### `getEntityGraph(entityId, depth)`

获取以指定实体为中心的邻域子图，支持指定扩展深度。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `entityId` | string | 是 | 中心实体ID |
| `depth` | number | 否 | 扩展深度，默认1 |

**返回值**：`{ success: boolean, center?: object, entities?: Array, relations?: Array, error?: string }`

**行为细节**：使用BFS从中心实体出发，沿关系边逐层扩展，收集访问到的实体和关系。

### `getClusters()`

获取所有已构建的聚类列表。

**返回值**：`Array<cluster>` — 聚类对象数组

每个聚类对象包含：`id`、`entities`、`relations`、`summary`、`documentIds`。

### `getStats()`

获取运行统计信息。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `documentsIngested` | number | 累计摄入文档数 |
| `entitiesExtracted` | number | 累计提取实体数 |
| `relationsExtracted` | number | 累计提取关系数 |
| `clustersBuilt` | number | 当前聚类数 |
| `queriesExecuted` | number | 累计执行查询数 |
| `currentEntities` | number | 当前实体数 |
| `currentRelations` | number | 当前关系数 |
| `currentClusters` | number | 当前聚类数 |
| `currentDocuments` | number | 当前文档数 |
| `config` | object | 当前配置副本 |

### `attachEmbeddingService(service)`

附加嵌入服务实例，用于后续向量增强检索。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `service` | object | 否 | 嵌入服务实例 |

**返回值**：`this`（支持链式调用）

### `attachVectorIndex(index)`

附加向量索引实例，用于后续向量增强检索。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `index` | object | 否 | 向量索引实例 |

**返回值**：`this`（支持链式调用）

### `attachGraphifyCompiler(compiler)`

附加GraphifyCompiler实例，启用Graphify图谱编译集成。查询时优先使用Graphify编译产出的图谱数据（`_queryWithGraphify`），当Graphify不可用时自动降级到原有正则提取逻辑，确保向后兼容。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `compiler` | object | 否 | GraphifyCompiler实例 |

**返回值**：`this`（支持链式调用）

---

## 5. 图谱构建算法

### 实体提取

实体提取基于正则模式匹配，按四种实体类型分别识别：

#### 实体类型与模式

| 类型 | 常量 | 识别模式 |
|------|------|----------|
| PERSON | `ENTITY_TYPES.PERSON` | 英文人名：`Mr./Mrs./Ms./Dr./Prof. + 姓名组合`，或`名 + 首字母 + 姓` |
| ORG | `ENTITY_TYPES.ORG` | 英文组织名：`词组 + Inc/Corp/Ltd/LLC/Company/Group/Foundation/University等` |
| TECH | `ENTITY_TYPES.TECH` | 技术术语：点分命名（`a.b.C`）、连字符JS/TS文件名（`xxx-yyy.js`）、技术缩写词（`ReactJS`、`RESTAPI`）、驼峰命名 |
| CONCEPT | `ENTITY_TYPES.CONCEPT` | 中文概念词：2-8个汉字 + 后缀词（模型/架构/系统/引擎/框架/平台/模块/组件/服务/流程/策略/规则/协议/接口/数据/缓存/队列/任务/调度/监控/安全/权限/认证/授权） |

#### 提取流程

1. 对文档内容分别应用四类正则模式
2. 对匹配结果规范化实体名（`_normalizeEntityName`：去除首尾空格，合并内部空格）
3. 以`TYPE:Name`为键去重
4. 查找已有实体索引：若存在则追加mention记录，否则创建新实体
5. 实体数量达到`maxEntities`上限时停止提取

#### 实体数据结构

```javascript
{
  id: 'ent_N',           // 自增ID
  name: 'ReactJS',       // 规范化名称
  type: 'TECH',          // 实体类型
  mentions: [            // 出现位置列表
    { docId: 'doc_1', position: 42 }
  ]
}
```

### 关系推理

关系推理采用**段落级共现分析 + 关键词模式匹配**双策略：

#### 共现分析

1. 将文档按空行分割为段落（`PARAGRAPH_SPLIT = /\n\s*\n/`）
2. 对每个段落，查找其中出现的实体
3. 同一段落内的实体两两配对，创建共现关系
4. 关系初始权重为0.3，重复共现每次递增0.1（上限1.0）

#### 关系类型判定

通过关键词模式匹配判定关系类型：

| 关系类型 | 常量 | 判定关键词 |
|----------|------|------------|
| DEPENDS_ON | `RELATION_TYPES.DEPENDS_ON` | depends on / relies on / requires / needs / uses / 依赖 / 需要 / 引用 / 调用 |
| PART_OF | `RELATION_TYPES.PART_OF` | part of / belongs to / contained in / member of / 包含 / 属于 / 组成 / 一部分 |
| RELATED_TO | `RELATION_TYPES.RELATED_TO` | related to / associated with / connected to / links to / references / 相关 / 关联 / 连接 / 涉及 |

DEPENDS_ON额外要求源实体名在文本中出现在目标实体名之前（方向性判定）。若段落不匹配任何关键词模式，默认归类为RELATED_TO。

#### 弱关系剪枝

关系权重低于`minRelationWeight`（默认0.1）的关系在提取完成后被剪枝，从`_relations`和`_relationKeyIndex`中移除。

#### 关系数据结构

```javascript
{
  id: 'rel_N',                    // 自增ID
  source: 'ent_1',               // 源实体ID
  target: 'ent_2',               // 目标实体ID
  type: 'DEPENDS_ON',            // 关系类型
  weight: 0.3,                   // 关系权重（0.1~1.0）
  evidence: 'ReactJS depends...' // 证据文本（段落前200字符）
}
```

### 图谱存储结构

图谱采用内存Map存储，通过双重索引实现O(1)查找：

| 存储 | 键格式 | 值 | 用途 |
|------|--------|-----|------|
| `_entities` | `ent_N` | entity对象 | 实体主存储 |
| `_entityKeyIndex` | `TYPE:Name` | entity ID | 实体名→ID快速查找 |
| `_relations` | `rel_N` | relation对象 | 关系主存储 |
| `_relationKeyIndex` | `source->target:TYPE` | relation ID | 关系去重与查找 |
| `_clusters` | `cluster_N` | cluster对象 | 聚类主存储 |
| `_documents` | docId | document对象 | 文档主存储 |

---

## 6. 多跳查询算法

### 查询执行流程

```
问题文本 → 实体提取 → 实体匹配 → 子图扩展 → 评分排序 → 路径提取 → 返回结果
```

### 实体提取与匹配

1. **查询实体提取**（`_extractQueryEntities`）：对问题文本应用与文档相同的四类正则模式，额外提取大写首字母词组作为CONCEPT类型
2. **实体匹配**（`_matchEntities`）：
   - 精确匹配：`TYPE:Name`完全一致，评分1.0
   - 模糊匹配：名称子串包含关系（不区分大小写），评分0.8

### 子图扩展（BFS）

`_expandSubGraph`方法从匹配的种子实体出发，沿关系边进行广度优先搜索：

1. 构建全局邻接表（从`_relations`构建，双向边）
2. 将种子实体入队（hop=0）
3. BFS循环：出队实体，若未访问则加入子图；若当前跳数 < maxHops，将未访问邻居入队
4. 收集子图内所有关系（去重）
5. 仅保留两端实体均在子图内的关系

### 相关性评分

`_scoreSubGraph`方法对子图中每个实体计算评分：

```
score = 基础分 + 关系权重加成

基础分：
  - 种子实体：匹配评分（1.0 或 0.8）
  - 非种子实体：0.5 / max(distance, 1)

关系权重加成：
  - relationBoost = Σ(与该实体相关的关系权重)
  - 加成值 = relationBoost × 0.2

最终评分 = min(score, 1.0)
```

评分逻辑体现了三个核心因素：
- **匹配度**：直接命中的实体得分最高
- **距离衰减**：距种子越远，基础分越低（反比衰减）
- **关系强度**：与高权重关系相连的实体获得加成

### 结果排序与路径提取

1. 过滤掉评分低于`minRelevance`的结果
2. 按评分降序排列
3. 取前`topK`个结果
4. 对非种子实体的结果，提取从种子到该实体的推理路径（`_extractPaths`），最多返回10条路径

---

## 7. 事件体系

GraphRAG继承EventEmitter，定义以下事件：

### `document-ingested`

**触发时机**：文档摄入成功后

**数据结构**：

```javascript
{
  docId: 'doc_1',
  entityCount: 15,
  relationCount: 8
}
```

### `clusters-built`

**触发时机**：聚类构建完成后

**数据结构**：

```javascript
{
  clusterCount: 5
}
```

### `query-executed`

**触发时机**：查询执行完成后

**数据结构**：

```javascript
{
  question: 'ReactJS依赖哪些技术？',
  resultCount: 3
}
```

### `error`

**触发时机**：任何方法执行出错时

**数据结构**：Error对象

---

## 8. 与RagPipeline的集成

### 集成方式

RagPipeline通过`attachGraphRAG(graphRAG)`方法附加GraphRAG实例：

```javascript
const ragPipeline = new RAGPipeline(projectRoot, { chunkSize: 512 });
const graphRAG = new GraphRAG({ maxEntities: 5000 });
ragPipeline.attachGraphRAG(graphRAG);
```

RagPipeline校验传入对象是否实现了`query`方法，仅当校验通过时才建立关联。

### 混合检索策略

RagPipeline的`query()`方法执行混合检索：

1. **向量搜索优先**：先通过`CausalVectorIndex`执行Top-K向量近邻搜索
2. **图谱结果合并**：调用`_mergeGraphRAGResults`将图谱查询结果合并到向量搜索结果中
3. **去重与截断**：图谱结果中与向量结果ID重复的条目被跳过；图谱结果评分上限为0.8（确保向量搜索结果优先）

合并逻辑的关键细节：

| 维度 | 向量搜索结果 | 图谱合并结果 |
|------|-------------|-------------|
| 评分范围 | 0~1.0（原始相似度） | 上限0.8（`Math.min(score, 0.8)`） |
| 结果文本 | 原始文档分块文本 | 实体名+类型 |
| 元数据标记 | 无特殊标记 | `source: 'graph-rag'` |
| Top-K限制 | 用户指定值 | `min(topK, 3)`（最多3条） |

### 双模RAG的数据流

```
文档输入
  ├─ RagPipeline: 分块 → 嵌入 → 向量索引
  └─ GraphRAG:    实体提取 → 关系推理 → 图谱存储

查询输入
  ├─ RagPipeline: 向量搜索 → Top-K结果
  └─ GraphRAG:    实体匹配 → 子图扩展 → 评分排序
                    ↓
              合并去重 → 最终结果
```

### 互补场景

- **纯语义查询**（如"解释这个概念"）：向量搜索为主，图谱补充关联实体
- **关系查询**（如"A依赖B吗？"）：图谱结果为主，向量搜索补充上下文
- **探索性查询**（如"这个模块涉及哪些技术？"）：双模结果互补，图谱提供结构化关联，向量提供语义相关文本

---

## 9. 使用示例

### 基本使用

```javascript
const GraphRAG = require('./src/runtime/workflow/graph-rag');

const graphRAG = new GraphRAG({
  maxEntities: 3000,
  maxRelations: 5000,
  maxDocuments: 200,
  minRelationWeight: 0.15,
});

graphRAG.on('document-ingested', (data) => {
  console.log(`文档 ${data.docId} 摄入完成：${data.entityCount} 实体，${data.relationCount} 关系`);
});

graphRAG.on('error', (err) => {
  console.error('GraphRAG错误：', err.message);
});
```

### 图谱构建

```javascript
const result = graphRAG.ingestDocument(
  'arch-doc',
  'ReactJS depends on Node.js runtime. Redux is part of the ReactJS ecosystem. ' +
  'The ReactJS架构 uses virtual DOM for efficient rendering. ' +
  'Dr. Smith leads the React Foundation team.',
  { source: 'architecture.md' }
);

if (result.success) {
  console.log(`提取 ${result.entityCount} 个实体，${result.relationCount} 个关系`);
}

const clusterResult = graphRAG.buildClusters();
if (clusterResult.success) {
  const clusters = graphRAG.getClusters();
  clusters.forEach(cluster => {
    console.log(`聚类 ${cluster.id}：${cluster.summary}`);
  });
}
```

### 多跳查询

```javascript
const queryResult = graphRAG.query(
  'ReactJS依赖哪些技术？',
  { topK: 5, maxHops: 3, minRelevance: 0.2 }
);

if (queryResult.success) {
  console.log('查询结果：');
  queryResult.results.forEach(r => {
    console.log(`  ${r.entity.name} (${r.entity.type}) - 评分: ${r.score.toFixed(2)}, 距离: ${r.distance}`);
  });

  console.log('推理路径：');
  queryResult.paths.forEach(p => {
    console.log(`  ${p.from} → ${p.to} (${p.length}跳)`);
  });
}

const entityGraph = graphRAG.getEntityGraph('ent_1', 2);
if (entityGraph.success) {
  console.log(`中心实体：${entityGraph.center.name}`);
  console.log(`邻域实体数：${entityGraph.entities.length}`);
  console.log(`邻域关系数：${entityGraph.relations.length}`);
}
```

### 与RagPipeline混合使用

```javascript
const RAGPipeline = require('./src/runtime/workflow/rag-pipeline');
const GraphRAG = require('./src/runtime/workflow/graph-rag');

const ragPipeline = new RAGPipeline(projectRoot, {
  chunkSize: 512,
  chunkOverlap: 64,
  topK: 5,
});

const graphRAG = new GraphRAG({
  maxEntities: 5000,
  maxRelations: 10000,
});

ragPipeline.attachGraphRAG(graphRAG);

async function buildKnowledgeBase() {
  await ragPipeline.ingestDirectory('docs/');
  const docs = ['技术架构文档内容...'];
  for (let i = 0; i < docs.length; i++) {
    graphRAG.ingestDocument('graph_doc_' + i, docs[i], { source: 'docs' });
  }
  graphRAG.buildClusters();
}

async function hybridQuery(question) {
  const result = await ragPipeline.query(question, { topK: 8 });
  result.results.forEach(r => {
    const source = r.metadata.source || 'vector';
    console.log(`[${source}] ${r.text.substring(0, 80)}... (评分: ${r.score.toFixed(2)})`);
  });
}
```

### 统计与关闭

```javascript
const stats = graphRAG.getStats();
console.log(`实体: ${stats.currentEntities}, 关系: ${stats.currentRelations}, 聚类: ${stats.currentClusters}`);

graphRAG.shutdown();
```
