# 模块详解 — Graphify 代码图谱编译器

> 版本：2.73.4
> 路径：`src/runtime/graphify/`
> 文件数：7
> 核心职责：将项目源码编译为结构化代码图谱，支持文件类型检测、AST解析、语义提取、社区聚类与图谱查询

---

## 目录

- [第一部分：架构概览](#第一部分架构概览)
  - [概述](#概述)
  - [模块清单](#模块清单)
  - [模块协作关系图](#模块协作关系图)
  - [关键依赖关系](#关键依赖关系)
- [第二部分：架构设计详解](#第二部分架构设计详解)
  - [GraphifyCompiler 设计](#graphifycompiler-设计)
  - [FileTypeDetector 设计](#filetypedetector-设计)
  - [AstParser 设计](#astparser-设计)
  - [SemanticExtractor 设计](#semanticextractor-设计)
  - [GraphBuilder 设计](#graphbuilder-设计)
  - [LouvainClusterer 设计](#louvainclusterer-设计)
  - [GraphQueryEngine 设计](#graphqueryengine-设计)
- [第三部分：API参考](#第三部分api参考)
  - [1. GraphifyCompiler — 图谱编译器](#1-graphifycompiler--图谱编译器)
  - [2. FileTypeDetector — 文件类型检测器](#2-filetypedetector--文件类型检测器)
  - [3. AstParser — AST解析器](#3-astparser--ast解析器)
  - [4. SemanticExtractor — 语义提取器](#4-semanticextractor--语义提取器)
  - [5. GraphBuilder — 图谱构建器](#5-graphbuilder--图谱构建器)
  - [6. LouvainClusterer — Louvain社区发现](#6-louvainclusterer--louvain社区发现)
  - [7. GraphQueryEngine — 图谱查询引擎](#7-graphqueryengine--图谱查询引擎)
- [端到端使用示例](#端到端使用示例)
- [相关文档](#相关文档)

---

# 第一部分：架构概览

## 概述

Graphify子系统（Graphify Subsystem）负责将项目源码编译为结构化代码图谱，提供从文件发现、内容解析、图谱构建、社区聚类到查询检索的完整7阶段管线能力。该子系统包含7个核心模块，协同完成代码图谱的编译、增量更新与多策略查询。

## 模块清单

| 模块 | 源文件 | 说明 |
|------|--------|------|
| GraphifyCompiler | graphify-compiler.js | 图谱编译器主入口，7阶段管线编排、增量编译、成本追踪、Manifest管理 |
| FileTypeDetector | file-type-detector.js | 文件类型检测器，40+扩展名映射、批量检测、自定义映射 |
| AstParser | ast-parser.js | AST解析器，tree-sitter可选+regex降级，支持JS/TS/Python |
| SemanticExtractor | semantic-extractor.js | 语义提取器，LLM语义提取、多模态支持、并行批处理、Token成本追踪 |
| GraphBuilder | graph-builder.js | 图谱构建器，AST+语义合并、跨文件引用解析、边去重 |
| LouvainClusterer | louvain-clusterer.js | Louvain社区发现，两阶段模块度优化、层次聚类、可配置分辨率 |
| GraphQueryEngine | graph-query-engine.js | 图谱查询引擎，4种优化策略、路径查找、子图提取、架构概览 |

## 模块协作关系图

```
                         ┌──────────────────────────┐
                         │   GraphifyCompiler       │
                         │   (7阶段管线编排器)        │
                         └──┬───┬───┬───┬───┬───┬───┘
                            │   │   │   │   │   │
              ┌─────────────┘   │   │   │   │   └──────────────┐
              ▼                 ▼   │   │   ▼                  ▼
   ┌──────────────────┐ ┌──────────┐│   │ ┌──────────────┐ ┌────────────────┐
   │ FileTypeDetector │ │ AstParser││   │ │   Semantic   │ │  GraphBuilder  │
   │ (文件类型检测)    │ │(AST解析) ││   │ │  Extractor   │ │  (图谱构建)    │
   └──────────────────┘ └──────────┘│   │ │(语义提取)     │ └───────┬────────┘
                                     │   │ └──────────────┘         │
                                     │   │                          │
                                     ▼   ▼                          ▼
                              ┌──────────────────┐        ┌────────────────┐
                              │  LouvainClusterer│        │ GraphQueryEngine│
                              │  (社区发现聚类)   │◄───────│  (图谱查询)     │
                              └──────────────────┘        └────────────────┘
```

## 关键依赖关系

- **GraphifyCompiler** 是核心编排器，按7阶段管线顺序调度所有子模块
- **FileTypeDetector** 在detect阶段使用，决定每个文件的解析路径（ast/text/multimodal）
- **AstParser** 在build阶段使用，解析ast类别文件（JS/TS/Python），支持tree-sitter降级到regex
- **SemanticExtractor** 在build阶段使用，提取text和multimodal类别文件的语义信息
- **GraphBuilder** 在build阶段使用，将解析结果合并为图谱节点和边，并解析跨文件引用
- **LouvainClusterer** 在cluster阶段使用，基于模块度优化将节点聚类为社区
- **GraphQueryEngine** 在analyze阶段及之后使用，提供4种查询策略和路径查找能力

---

# 第二部分：架构设计详解

## GraphifyCompiler 设计

### 核心职责

GraphifyCompiler是Graphify子系统的核心编排器，负责：
- 7阶段管线编排（detect→ingest→build→cluster→analyze→report→export）
- 增量编译（基于文件哈希变更检测）
- Manifest管理（文件哈希追踪、版本号、时间戳）
- 成本追踪（Token消耗统计）
- 查询代理（委托GraphQueryEngine）

### 7阶段管线

| 阶段 | 方法 | 说明 |
|------|------|------|
| **detect** | `_detect()` | 递归扫描项目目录，检测文件类型，过滤忽略目录和未知文件 |
| **ingest** | `_ingest()` | 读取文件内容，计算MD5哈希，跳过超大文件 |
| **build** | `_build()` | 解析文件（AST/语义），构建图谱节点和边，解析跨文件引用 |
| **cluster** | `_cluster()` | Louvain社区发现，将节点聚类为逻辑分组 |
| **analyze** | `_analyze()` | 生成架构分析（节点/边/聚类统计） |
| **report** | `_report()` | 生成Markdown格式编译报告 |
| **export** | `_export()` | 导出图谱数据（节点、边、聚类、Manifest） |

### 增量编译机制

`compileIncremental(projectRoot, changedFiles)`基于Manifest中的文件哈希实现增量编译：

1. 对每个变更文件检测类型，跳过未知类型
2. 读取文件内容并计算MD5哈希
3. 与Manifest中旧哈希比较，跳过未变更文件
4. 仅对变更文件执行解析和图谱构建
5. 重新解析跨文件引用
6. 可选重新聚类

### Manifest结构

```javascript
{
  version: 1,
  createdAt: '2026-06-03T10:00:00.000Z',
  updatedAt: '2026-06-03T10:05:00.000Z',
  fileHashes: {
    '/path/to/file.js': 'a1b2c3d4e5f6...',
    // ...
  }
}
```

---

## FileTypeDetector 设计

### 核心职责

FileTypeDetector负责根据文件扩展名检测文件类型和解析类别，支持40+扩展名映射和自定义映射。

### 文件类型映射（40+扩展名）

| 扩展名 | 类型 | 解析类别 |
|--------|------|---------|
| `.js` `.jsx` `.mjs` `.cjs` | `javascript` | `ast` |
| `.ts` `.tsx` | `typescript` | `ast` |
| `.py` `.pyw` | `python` | `ast` |
| `.go` | `go` | `ast` |
| `.rs` | `rust` | `ast` |
| `.java` | `java` | `ast` |
| `.rb` | `ruby` | `ast` |
| `.php` | `php` | `ast` |
| `.c` `.h` | `c` | `ast` |
| `.cpp` `.hpp` | `cpp` | `ast` |
| `.md` `.mdx` | `markdown` | `text` |
| `.json` | `json` | `text` |
| `.yaml` `.yml` | `yaml` | `text` |
| `.toml` | `toml` | `text` |
| `.css` `.scss` `.less` | `css` | `text` |
| `.html` `.htm` | `html` | `text` |
| `.txt` `.csv` `.xml` `.sql` `.graphql` `.proto` `.sh` | 对应类型 | `text` |
| `.pdf` | `pdf` | `multimodal` |
| `.png` `.jpg` `.jpeg` `.gif` `.svg` `.webp` | `image` | `multimodal` |
| `.mp3` `.wav` `.ogg` `.flac` | `audio` | `multimodal` |

### 解析类别与处理路径

| 解析类别 | 处理模块 | 说明 |
|---------|---------|------|
| `ast` | AstParser | 可进行语法树解析，提取函数/类/导入/导出/调用 |
| `text` | SemanticExtractor | 通过正则提取标题/决策/规则/业务/TODO等语义 |
| `multimodal` | SemanticExtractor + LLM | 需LLM客户端进行多模态语义提取 |

---

## AstParser 设计

### 核心职责

AstParser负责解析源码文件的抽象语法树，提取函数、类、导入、导出和调用关系。支持tree-sitter精确解析和regex降级方案。

### 双模式解析

| 模式 | 触发条件 | 说明 |
|------|---------|------|
| **tree-sitter** | `tree-sitter`和对应语言包可用 | 精确AST遍历，提取函数声明/类声明/导入/导出/调用表达式 |
| **regex降级** | tree-sitter不可用或语言包加载失败 | 正则匹配，支持JS/TS/Python，提取函数/类/导入/导出/调用 |

### 支持语言

| 语言 | tree-sitter语言包 | regex支持 |
|------|-------------------|----------|
| JavaScript/JSX/MJS/CJS | `tree-sitter-javascript` | ✅ |
| TypeScript/TSX | `tree-sitter-typescript` | ✅（与JS共用正则） |
| Python | `tree-sitter-python` | ✅ |

### 提取结构

```javascript
{
  filePath: '/path/to/file.js',
  functions: [{ name: 'myFunc', startRow: 10, endRow: 25 }],
  classes: [{ name: 'MyClass', startRow: 30, endRow: 80 }],
  imports: [{ source: './utils', type: 'import' }],
  exports: [{ name: 'myFunc', type: 'export' }],
  calls: [{ name: 'helper', startRow: 15 }],
  parser: 'tree-sitter' | 'regex'
}
```

### 关键字与内建过滤

regex模式下的调用提取会过滤JavaScript关键字（`if`/`for`/`while`等）和内建对象（`console`/`Math`/`JSON`/`Promise`等），避免噪声。

---

## SemanticExtractor 设计

### 核心职责

SemanticExtractor负责从文本和多媒体文件中提取语义信息，支持正则文本提取、结构化数据提取和LLM多模态提取。

### 提取模式

| 文件类型 | 提取方法 | 说明 |
|---------|---------|------|
| `markdown`/`text` | `_extractFromText()` | 正则提取标题/决策/规则/业务/TODO |
| `json`/`yaml`/`toml` | `_extractFromStructured()` | 解析结构化数据，提取顶层键名 |
| `pdf`/`image`/`audio` | `_extractFromMultimodal()` | LLM客户端提取（无LLM时返回空结果） |

### 语义提取模式（正则）

| 模式 | 正则 | 语义类型 | 类别 |
|------|------|---------|------|
| 标题 | `^(#{1,6})\s+(.+)$` | `heading` | `structure` |
| 决策 | `(?:决策|决定|decision)[:：]\s*(.+)` | `decision` | `logic` |
| 规则 | `(?:规则|rule)[:：]\s*(.+)` | `rule` | `logic` |
| 业务 | `(?:业务|business)[:：]\s*(.+)` | `business` | `domain` |
| TODO | `(?:TODO|FIXME|HACK|XXX)[:：]?\s*(.+)` | `todo` | `meta` |

### 并行批处理

`extractBatch(files)`支持并行提取，按`maxConcurrency`（默认4）分批执行，使用`Promise.allSettled`确保单文件失败不影响批次。

### Token成本追踪

```javascript
const costReport = extractor.getCostReport();
// {
//   totalTokens: 12500,
//   totalCalls: 3,
//   stages: {},
//   activeExtractions: 0
// }
```

---

## GraphBuilder 设计

### 核心职责

GraphBuilder负责将解析结果构建为图谱节点和边，支持AST节点、语义节点、跨文件引用解析和边去重。

### 节点类型

| 类型 | 常量 | 说明 |
|------|------|------|
| `file` | `NODE_TYPES.FILE` | 文件节点 |
| `function` | `NODE_TYPES.FUNCTION` | 函数节点 |
| `class` | `NODE_TYPES.CLASS` | 类节点 |
| `module` | `NODE_TYPES.MODULE` | 模块节点 |
| `import` | `NODE_TYPES.IMPORT` | 导入节点 |
| `export` | `NODE_TYPES.EXPORT` | 导出节点 |
| `semantic` | `NODE_TYPES.SEMANTIC` | 语义节点 |

### 边类型

| 类型 | 常量 | 说明 |
|------|------|------|
| `imports` | `EDGE_TYPES.IMPORTS` | 文件导入关系 |
| `exports` | `EDGE_TYPES.EXPORTS` | 文件导出关系 |
| `calls` | `EDGE_TYPES.CALLS` | 函数调用关系 |
| `contains` | `EDGE_TYPES.CONTAINS` | 包含关系（文件包含函数/类） |
| `depends_on` | `EDGE_TYPES.DEPENDS_ON` | 依赖关系 |
| `references` | `EDGE_TYPES.REFERENCES` | 引用关系 |

### 跨文件引用解析

`resolveReferences()`方法将基于名称的边（`calls`/`references`类型，target为名称字符串而非节点ID）解析为基于节点ID的边：

1. 构建名称→节点ID映射
2. 遍历所有`calls`/`references`类型的边
3. 如果target是名称字符串（非`gn_`前缀），查找名称映射
4. 找到候选节点后，移除旧边，添加新的基于节点ID的边
5. 返回解析数量

### 边去重

当`deduplicateEdges`配置为`true`（默认）时，重复边不会创建新条目，而是增加已有边的`weight`值。

### 节点/边ID生成

- 节点ID：`gn_` + 自增计数器（如`gn_1`、`gn_2`）
- 边ID：`ge_` + 自增计数器（如`ge_1`、`ge_2`）

---

## LouvainClusterer 设计

### 核心职责

LouvainClusterer实现Louvain社区发现算法，通过两阶段模块度优化将图谱节点聚类为逻辑社区。

### Louvain算法流程

1. **初始化**：每个节点独立为一个社区
2. **第一阶段（模块度优化）**：遍历每个节点，尝试将其移至邻居所在社区，选择模块度增益最大的移动
3. **收敛判断**：当模块度增益低于`minModularityGain`或达到`maxIterations`时停止
4. **构建结果**：生成聚类Map和层次结构

### 模块度计算

模块度Q的公式：

```
Q = (1/2m) × Σ[Aij - (ki × kj)/(2m)] × δ(ci, cj)
```

其中：
- `m`：总边权重的一半
- `Aij`：节点i和j之间的边权重
- `ki`：节点i的度
- `ci`：节点i所属社区
- `δ(ci, cj)`：社区指示函数（同社区为1，否则为0）

### 聚类结果结构

```javascript
{
  clusters: Map<string, {
    id: 'cluster_0',
    nodeIds: ['gn_1', 'gn_5', 'gn_12'],
    nodes: [nodeObject, ...],
    size: 3
  }>,
  modularity: 0.42,
  iterations: 15
}
```

### 特殊情况

当图谱无边（`totalWeight === 0`）时，每个节点独立为一个聚类（单例聚类），模块度为0。

---

## GraphQueryEngine 设计

### 核心职责

GraphQueryEngine提供图谱查询能力，支持4种查询策略、双向BFS路径查找、子图提取和架构概览。

### 4种查询策略

| 策略 | 常量 | 说明 |
|------|------|------|
| **分类索引** | `CLASSIFIED_INDEX` | 默认策略，按类型/名称/聚类索引查询 |
| **选择性优先** | `SELECTIVE_PRIORITY` | 按自定义优先级顺序查询（默认：type→name→clusterId） |
| **双向搜索** | `BIDIRECTIONAL_SEARCH` | 从两个节点双向BFS搜索路径 |
| **缓存物化** | `CACHE_MATERIALIZATION` | 基于分类索引结果缓存 |

### 索引结构

`attachGraph()`后自动构建5类索引：

| 索引 | 类型 | 说明 |
|------|------|------|
| `_typeIndex` | `Map<type, nodeId[]>` | 按节点类型索引 |
| `_nameIndex` | `Map<nameLower, nodeId[]>` | 按节点名称（小写）索引 |
| `_clusterIndex` | `Map<nodeId, clusterId>` | 按节点ID到聚类ID的映射 |
| `_adjacency` | `Map<nodeId, {incoming, outgoing}>` | 邻接表（入边/出边） |
| `_queryCache` | `BoundedMap` | 查询结果缓存 |

### 双向BFS路径查找

`findPath(fromId, toId)`使用双向BFS算法：

1. 从`fromId`向前搜索，从`toId`向后搜索
2. 每轮迭代各扩展一层
3. 当两个搜索前沿相遇时，拼接路径返回
4. 最大迭代次数为`maxPathLength × 2`
5. 未找到路径返回`null`

### 架构概览

`getArchitectureOverview()`返回图谱的统计概览：

```javascript
{
  totalNodes: 150,
  totalEdges: 320,
  totalClusters: 8,
  nodeTypes: { file: 30, function: 80, class: 25, import: 15 },
  edgeTypes: { contains: 105, imports: 15, calls: 200 },
  clusters: [{ id: 'cluster_0', size: 25 }, ...]
}
```

---

# 第三部分：API参考

## 1. GraphifyCompiler — 图谱编译器

**源文件**：[graphify-compiler.js](../../src/runtime/graphify/graphify-compiler.js)

### 职责概述

图谱编译器是Graphify子系统的核心入口，编排7阶段管线，管理文件索引、聚类索引、报告历史和Manifest，支持全量编译和增量编译。

### 构造函数参数

```javascript
new GraphifyCompiler(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.maxFileIndexSize` | `number` | `5000` | 文件索引最大容量 |
| `config.maxClusterIndexSize` | `number` | `500` | 聚类索引最大容量 |
| `config.maxReportHistorySize` | `number` | `50` | 报告历史最大条目数 |
| `config.maxConcurrency` | `number` | `4` | 最大并发数 |
| `config.maxFileSize` | `number` | `1048576`（1MB） | 单文件最大大小（字节） |
| `config.ignorePatterns` | `string[]` | `['node_modules', '.git', ...]` | 忽略目录模式 |
| `config.fileExtensions` | `string[]` | `['.js', '.jsx', ...]` | 处理的文件扩展名 |
| `config.enableSemanticExtraction` | `boolean` | `true` | 是否启用语义提取 |
| `config.enableClustering` | `boolean` | `true` | 是否启用聚类 |
| `config.enableReport` | `boolean` | `true` | 是否生成报告 |
| `config.reportOutputDir` | `string` | `null` | 报告输出目录 |
| `config.llmClient` | `object` | `null` | LLM客户端实例（多模态提取） |

**静态属性**：`GraphifyCompiler.PIPELINE_STAGES` = `['detect', 'ingest', 'build', 'cluster', 'analyze', 'report', 'export']`

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `compile` | `async compile(projectRoot: string, options?: object)` | `{success, nodeCount, edgeCount, clusterCount, report, manifest}` | 执行完整7阶段编译 |
| `compileIncremental` | `async compileIncremental(projectRoot: string, changedFiles: string[])` | `{success, reprocessedFiles, nodeCount, edgeCount}` | 增量编译（仅处理变更文件） |
| `query` | `async query(querySpec: object)` | `queryResult` | 委托GraphQueryEngine查询 |
| `getNode` | `getNode(nodeId: string)` | `node \| null` | 获取指定节点 |
| `getEdges` | `getEdges(nodeId: string)` | `{incoming, outgoing}` | 获取指定节点的边 |
| `getCluster` | `getCluster(clusterId: string)` | `cluster \| null` | 获取指定聚类 |
| `getReport` | `getReport()` | `string \| null` | 获取最近编译报告 |
| `getStats` | `getStats()` | `object` | 获取统计信息 |
| `getCostReport` | `getCostReport()` | `object` | 获取Token成本报告 |
| `getManifest` | `getManifest()` | `object` | 获取Manifest副本 |

### 事件列表

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `stage-started` | `{stage}` | 阶段开始执行 |
| `stage-completed` | `{stage, duration}` | 阶段执行完成 |
| `stage-failed` | `{stage, error}` | 阶段执行失败 |
| `compile-completed` | `{nodeCount, edgeCount, clusterCount}` | 编译完成 |

### 使用示例

```javascript
const GraphifyCompiler = require('./src/runtime/graphify/graphify-compiler');

const compiler = new GraphifyCompiler({
  enableSemanticExtraction: true,
  enableClustering: true,
  ignorePatterns: ['node_modules', '.git', 'dist'],
});

const result = await compiler.compile('/path/to/project');
if (result.success) {
  console.log(`Nodes: ${result.nodeCount}, Edges: ${result.edgeCount}, Clusters: ${result.clusterCount}`);
}

const incremental = await compiler.compileIncremental('/path/to/project', [
  '/path/to/project/src/new-file.js',
  '/path/to/project/src/modified-file.js',
]);

const stats = compiler.getStats();
console.log(`Pipeline: ${stats.pipelineState}, Files: ${stats.fileCount}`);

const cost = compiler.getCostReport();
console.log(`Tokens: ${cost.totalTokens}, Calls: ${cost.totalCalls}`);
```

---

## 2. FileTypeDetector — 文件类型检测器

**源文件**：[file-type-detector.js](../../src/runtime/graphify/file-type-detector.js)

### 职责概述

文件类型检测器根据扩展名识别文件类型和解析类别，支持40+扩展名映射、自定义映射和批量检测。

### 构造函数参数

```javascript
new FileTypeDetector(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.maxCacheSize` | `number` | `500` | 检测结果缓存最大容量 |
| `config.customMappings` | `object` | `{}` | 自定义扩展名→类型映射（如`{'.vue': 'vue'}`） |

**静态属性**：`FileTypeDetector.FILE_TYPE_MAP`、`FileTypeDetector.PARSER_CATEGORY`

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `detect` | `detect(filePath: string)` | `{type, category, extension}` | 检测单个文件类型 |
| `detectBatch` | `detectBatch(filePaths: string[])` | `Array<{filePath, type, category, extension}>` | 批量检测文件类型 |
| `getSupportedTypes` | `getSupportedTypes()` | `string[]` | 获取所有支持的文件类型 |
| `getSupportedExtensions` | `getSupportedExtensions()` | `string[]` | 获取所有支持的扩展名 |
| `getCategoryForType` | `getCategoryForType(type: string)` | `string` | 获取类型对应的解析类别 |
| `isAstType` | `isAstType(type: string)` | `boolean` | 判断是否为AST类型 |
| `isMultimodalType` | `isMultimodalType(type: string)` | `boolean` | 判断是否为多模态类型 |

### 使用示例

```javascript
const FileTypeDetector = require('./src/runtime/graphify/file-type-detector');

const detector = new FileTypeDetector({
  customMappings: { '.vue': 'vue', '.svelte': 'svelte' },
});

const result = detector.detect('/path/to/file.ts');
// { type: 'typescript', category: 'ast', extension: '.ts' }

const batch = detector.detectBatch(['/a.js', '/b.md', '/c.png']);
const types = detector.getSupportedTypes();
const exts = detector.getSupportedExtensions();
```

---

## 3. AstParser — AST解析器

**源文件**：[ast-parser.js](../../src/runtime/graphify/ast-parser.js)

### 职责概述

AST解析器解析源码文件的抽象语法树，提取函数、类、导入、导出和调用关系。支持tree-sitter精确解析和regex降级方案。

### 构造函数参数

```javascript
new AstParser(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.maxCacheSize` | `number` | `200` | 解析结果缓存最大容量 |
| `config.maxParseBatchSize` | `number` | `50` | 批量解析最大文件数 |

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `parseFile` | `async parseFile(filePath: string, content: string)` | `{functions, classes, imports, exports, calls, filePath, parser}` | 解析单个文件 |
| `parseBatch` | `async parseBatch(files: Array<{filePath, content}>)` | `Map<filePath, result>` | 批量解析文件 |
| `isTreeSitterAvailable` | `isTreeSitterAvailable`（getter） | `boolean` | tree-sitter是否可用 |
| `clearCache` | `clearCache()` | `void` | 清除解析缓存 |

### 使用示例

```javascript
const AstParser = require('./src/runtime/graphify/ast-parser');

const parser = new AstParser();

if (parser.isTreeSitterAvailable) {
  console.log('tree-sitter available for precise AST parsing');
}

const result = await parser.parseFile('/path/to/module.js', sourceCode);
console.log(`Functions: ${result.functions.length}`);
console.log(`Classes: ${result.classes.length}`);
console.log(`Imports: ${result.imports.map(i => i.source).join(', ')}`);
console.log(`Parser: ${result.parser}`);
```

---

## 4. SemanticExtractor — 语义提取器

**源文件**：[semantic-extractor.js](../../src/runtime/graphify/semantic-extractor.js)

### 职责概述

语义提取器从文本和多媒体文件中提取语义信息，支持正则文本提取、结构化数据提取和LLM多模态提取，提供并行批处理和Token成本追踪。

### 构造函数参数

```javascript
new SemanticExtractor(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.maxCacheSize` | `number` | `200` | 提取结果缓存最大容量 |
| `config.maxConcurrency` | `number` | `4` | 批量提取最大并发数 |
| `config.maxBatchSize` | `number` | `30` | 批量提取最大文件数 |
| `config.maxContentLength` | `number` | `50000` | 单文件最大内容长度（字符） |
| `config.llmClient` | `object` | `null` | LLM客户端实例 |

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `extractSemantic` | `async extractSemantic(filePath: string, content: string, type: string)` | `{filePath, semantics, parser}` | 提取单个文件语义 |
| `extractBatch` | `async extractBatch(files: Array<{filePath, content, type}>)` | `Map<filePath, result>` | 并行批量提取语义 |
| `getCostReport` | `getCostReport()` | `{totalTokens, totalCalls, stages, activeExtractions}` | 获取Token成本报告 |
| `clearCache` | `clearCache()` | `void` | 清除提取缓存 |

### 使用示例

```javascript
const SemanticExtractor = require('./src/runtime/graphify/semantic-extractor');

const extractor = new SemanticExtractor({
  llmClient: myLlmClient,
  maxConcurrency: 6,
});

const result = await extractor.extractSemantic('/path/to/doc.md', markdownContent, 'markdown');
for (const sem of result.semantics) {
  console.log(`[${sem.category}] ${sem.type}: ${sem.text}`);
}

const batch = await extractor.extractBatch([
  { filePath: '/a.md', content: '...', type: 'markdown' },
  { filePath: '/b.json', content: '...', type: 'json' },
]);

const cost = extractor.getCostReport();
console.log(`Tokens used: ${cost.totalTokens}`);
```

---

## 5. GraphBuilder — 图谱构建器

**源文件**：[graph-builder.js](../../src/runtime/graphify/graph-builder.js)

### 职责概述

图谱构建器将解析结果合并为图谱节点和边，支持AST节点、语义节点、跨文件引用解析和边去重。

### 构造函数参数

```javascript
new GraphBuilder(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.maxNodes` | `number` | `10000` | 最大节点数 |
| `config.maxEdges` | `number` | `20000` | 最大边数 |
| `config.maxCacheSize` | `number` | `200` | 缓存最大容量 |
| `config.deduplicateEdges` | `boolean` | `true` | 是否去重边（重复边增加权重） |

**静态属性**：`GraphBuilder.NODE_TYPES`、`GraphBuilder.EDGE_TYPES`

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `buildFromParsedData` | `buildFromParsedData(parsedData: object)` | `{nodesAdded, edgesAdded}` | 从解析数据构建图谱 |
| `addNode` | `addNode(nodeData: {type, name?, filePath?})` | `node \| null` | 添加节点 |
| `addEdge` | `addEdge(edgeData: {source, target, type?, weight?})` | `edge \| null` | 添加边 |
| `resolveReferences` | `resolveReferences()` | `number` | 解析跨文件引用，返回解析数量 |
| `getGraph` | `getGraph()` | `{nodes, edges, nodeCount, edgeCount}` | 获取完整图谱 |
| `getNode` | `getNode(nodeId: string)` | `node \| null` | 获取指定节点 |
| `getEdge` | `getEdge(edgeId: string)` | `edge \| null` | 获取指定边 |
| `getNodesByType` | `getNodesByType(type: string)` | `node[]` | 按类型获取节点 |
| `getEdgesByType` | `getEdgesByType(type: string)` | `edge[]` | 按类型获取边 |
| `getEdgesForNode` | `getEdgesForNode(nodeId: string)` | `{incoming, outgoing}` | 获取指定节点的入边和出边 |

### 事件列表

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `node-added` | `node` | 节点添加成功 |
| `edge-added` | `edge` | 边添加成功 |
| `data-built` | `{nodesAdded, edgesAdded}` | 解析数据构建完成 |
| `references-resolved` | `{resolved}` | 跨文件引用解析完成 |

### 使用示例

```javascript
const GraphBuilder = require('./src/runtime/graphify/graph-builder');

const builder = new GraphBuilder({
  maxNodes: 50000,
  maxEdges: 100000,
  deduplicateEdges: true,
});

builder.on('node-added', (node) => {
  console.log(`Node added: ${node.id} (${node.type})`);
});

const result = builder.buildFromParsedData({
  filePath: '/path/to/module.js',
  functions: [{ name: 'init', startRow: 5, endRow: 20 }],
  classes: [{ name: 'App', startRow: 25, endRow: 80 }],
  imports: [{ source: './utils', type: 'import' }],
  exports: [{ name: 'App', type: 'export' }],
  calls: [{ name: 'init', startRow: 10 }],
  parser: 'regex',
});

const resolved = builder.resolveReferences();
console.log(`Resolved ${resolved} cross-file references`);

const graph = builder.getGraph();
console.log(`Graph: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);
```

---

## 6. LouvainClusterer — Louvain社区发现

**源文件**：[louvain-clusterer.js](../../src/runtime/graphify/louvain-clusterer.js)

### 职责概述

Louvain社区发现算法实现，通过两阶段模块度优化将图谱节点聚类为逻辑社区，支持可配置分辨率和收敛条件。

### 构造函数参数

```javascript
new LouvainClusterer(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.resolution` | `number` | `1.0` | 分辨率参数（影响聚类粒度） |
| `config.maxIterations` | `number` | `100` | 最大迭代次数 |
| `config.minModularityGain` | `number` | `0.0001` | 最小模块度增益阈值 |

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `cluster` | `cluster(graph: {nodes, edges})` | `{clusters, modularity, iterations}` | 执行社区发现 |
| `getCluster` | `getCluster(clusterId: string)` | `cluster \| null` | 获取指定聚类 |
| `getClusterHierarchy` | `getClusterHierarchy()` | `Array<{level, clusters}>` | 获取聚类层次结构 |
| `getModularity` | `getModularity()` | `number` | 获取最终模块度 |
| `getIterations` | `getIterations()` | `number` | 获取实际迭代次数 |

### 事件列表

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `clusters-computed` | `{clusterCount, modularity}` | 聚类计算完成 |

### 使用示例

```javascript
const LouvainClusterer = require('./src/runtime/graphify/louvain-clusterer');

const clusterer = new LouvainClusterer({
  resolution: 1.0,
  maxIterations: 100,
  minModularityGain: 0.0001,
});

const result = clusterer.cluster(graph);
console.log(`Clusters: ${result.clusters.size}, Modularity: ${result.modularity.toFixed(4)}`);

for (const [clusterId, cluster] of result.clusters) {
  console.log(`${clusterId}: ${cluster.size} nodes`);
}
```

---

## 7. GraphQueryEngine — 图谱查询引擎

**源文件**：[graph-query-engine.js](../../src/runtime/graphify/graph-query-engine.js)

### 职责概述

图谱查询引擎提供多策略查询、双向BFS路径查找、子图提取和架构概览能力，支持分类索引、选择性优先、双向搜索和缓存物化4种查询策略。

### 构造函数参数

```javascript
new GraphQueryEngine(config)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `config.maxCacheSize` | `number` | `300` | 查询缓存最大容量 |
| `config.maxPathLength` | `number` | `10` | 路径查找最大长度 |
| `config.maxSubgraphSize` | `number` | `100` | 子图提取最大边数 |
| `config.defaultStrategy` | `string` | `'classified-index'` | 默认查询策略 |

**静态属性**：`GraphQueryEngine.QUERY_STRATEGIES` = `{CLASSIFIED_INDEX, SELECTIVE_PRIORITY, BIDIRECTIONAL_SEARCH, CACHE_MATERIALIZATION}`

### 公共方法签名

| 方法 | 签名 | 返回值 | 说明 |
|------|------|--------|------|
| `attachGraph` | `attachGraph(graph: {nodes, edges}, clusters: Map)` | `void` | 附加图谱数据并重建索引 |
| `query` | `query(spec: {nodeId?, type?, name?, clusterId?, strategy?, limit?, fromId?, toId?, priorities?})` | `{results, strategy}` | 执行查询 |
| `findPath` | `findPath(fromId: string, toId: string)` | `{nodes, edges, length} \| null` | 双向BFS路径查找 |
| `getSubgraph` | `getSubgraph(nodeIds: string[])` | `{nodes, edges}` | 提取子图 |
| `getArchitectureOverview` | `getArchitectureOverview()` | `{totalNodes, totalEdges, totalClusters, nodeTypes, edgeTypes, clusters}` | 获取架构概览 |
| `getStats` | `getStats()` | `{queriesExecuted, cacheHits, cacheMisses, cacheHitRate}` | 获取查询统计 |
| `clearCache` | `clearCache()` | `void` | 清除查询缓存 |

### 事件列表

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `query-executed` | `{strategy, resultCount}` | 查询执行完成 |

### 使用示例

```javascript
const GraphQueryEngine = require('./src/runtime/graphify/graph-query-engine');

const engine = new GraphQueryEngine({
  maxPathLength: 15,
  defaultStrategy: GraphQueryEngine.QUERY_STRATEGIES.CLASSIFIED_INDEX,
});

engine.attachGraph(graph, clusters);

const byType = engine.query({ type: 'function', limit: 20 });
const byName = engine.query({ name: 'MyClass' });
const byCluster = engine.query({ clusterId: 'cluster_0' });

const path = engine.findPath('gn_1', 'gn_50');
if (path) {
  console.log(`Path length: ${path.length}, Nodes: ${path.nodes.join(' → ')}`);
}

const subgraph = engine.getSubgraph(['gn_1', 'gn_5', 'gn_12']);
console.log(`Subgraph: ${subgraph.nodes.length} nodes, ${subgraph.edges.length} edges`);

const overview = engine.getArchitectureOverview();
console.log(`Architecture: ${overview.totalNodes} nodes, ${overview.totalClusters} clusters`);

const stats = engine.getStats();
console.log(`Queries: ${stats.queriesExecuted}, Hit rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`);
```

---

## 端到端使用示例

```javascript
const {
  GraphifyCompiler,
  FileTypeDetector,
  AstParser,
  SemanticExtractor,
  GraphBuilder,
  LouvainClusterer,
  GraphQueryEngine,
} = require('./src/runtime/graphify');

// 1. 初始化编译器
const compiler = new GraphifyCompiler({
  enableSemanticExtraction: true,
  enableClustering: true,
  enableReport: true,
  ignorePatterns: ['node_modules', '.git', 'dist', 'coverage'],
  llmClient: myLlmClient,
});

// 2. 执行全量编译
const result = await compiler.compile('/path/to/project');
if (!result.success) {
  console.error('Compilation failed:', result.error);
  return;
}

console.log(`Compilation completed:`);
console.log(`  Nodes: ${result.nodeCount}`);
console.log(`  Edges: ${result.edgeCount}`);
console.log(`  Clusters: ${result.clusterCount}`);

// 3. 查看编译报告
console.log(result.report);

// 4. 查询图谱
const functions = await compiler.query({ type: 'function', limit: 10 });
const path = await compiler.query({
  strategy: GraphQueryEngine.QUERY_STRATEGIES.BIDIRECTIONAL_SEARCH,
  fromId: 'gn_1',
  toId: 'gn_50',
});

// 5. 增量编译（文件变更后）
const incremental = await compiler.compileIncremental('/path/to/project', [
  '/path/to/project/src/updated-module.js',
]);
console.log(`Reprocessed ${incremental.reprocessedFiles} files`);

// 6. 查看成本
const cost = compiler.getCostReport();
console.log(`Total tokens: ${cost.totalTokens}, Total calls: ${cost.totalCalls}`);

// 7. 查看Manifest
const manifest = compiler.getManifest();
console.log(`Manifest version: ${manifest.version}, Files tracked: ${Object.keys(manifest.fileHashes).length}`);

// 8. 独立使用子模块
const detector = new FileTypeDetector({ customMappings: { '.vue': 'vue' } });
const parser = new AstParser();
const extractor = new SemanticExtractor({ llmClient: myLlmClient });
const builder = new GraphBuilder({ maxNodes: 50000, maxEdges: 100000 });
const clusterer = new LouvainClusterer({ resolution: 1.2 });
const queryEngine = new GraphQueryEngine({ maxPathLength: 20 });

// 手动编排管线
const detection = detector.detect('/path/to/file.js');
const parsed = await parser.parseFile('/path/to/file.js', fileContent);
builder.buildFromParsedData(parsed);
builder.resolveReferences();
const graph = builder.getGraph();
const clusterResult = clusterer.cluster(graph);
queryEngine.attachGraph(graph, clusterResult.clusters);
const overview = queryEngine.getArchitectureOverview();
```

---

## 相关文档

- [[模块详解-GraphRag模块]] — GraphRag图谱检索模块，支持Graphify集成向后兼容降级
- [[模块详解-代码仓库图谱]] — CodeGraph代码依赖图，与Graphify互补的轻量级依赖分析
- [[模块详解-技能图谱]] — SkillGraph技能关系建模与依赖可视化
- [[核心功能-Skill自动路由机制]] — SkillRouter三层缓存与语义匹配
