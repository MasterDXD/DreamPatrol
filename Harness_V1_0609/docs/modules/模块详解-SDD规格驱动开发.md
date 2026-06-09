# 模块详解-SDD规格驱动开发

> 版本：2.73.4 | 涉及模块：7个 | 跨越4个子系统

---

## 模块定位

SDD（Specification-Driven Development，规格驱动开发）是v2.7.134引入的跨模块集成能力，将"规格资产"作为一等公民贯穿框架的验证、记忆、新鲜度、因果、编排、压缩和路由7个核心模块。SDD的核心思想是：在AI辅助开发中，规格文档不是一次性交付物，而是需要持续维护、验证和追踪的"活资产"。

## 架构总览

SDD集成涉及7个模块，分布在4个子系统中：

```
src/gate/                    -- 证据验证
  evidence-verifier.js         specification_verified证据类型、软必需机制、_assessSpecConformance

src/runtime/thought/         -- 记忆持久化
  memory-store.js              specificationType/livenessStatus/relatedCodePaths、spec-protected淘汰

src/runtime/quality/         -- 质量守护
  doc-freshness-guard.js       SPEC_STALE_THRESHOLD_MS、规格文档检测、再验证队列

src/runtime/causal/          -- 因果验证
  causal-config-validator.js   源码依赖图、specificationBindings、源码影响分析

src/runtime/workflow/        -- 流程编排
  phase-orchestrator.js        规格门禁、registerSpecRequirement/markSpecVerified

src/runtime/context/         -- 上下文压缩
  context-compression-engine.js specification_asset策略、retainedSpecAssets

src/runtime/skill/           -- Skill路由
  skill-router.js              specification语义组、_applySpecBoost、specificationState
```

### 模块交互关系

```
                    +-------------------+
                    |   SkillRouter     |
                    | specification语义组 |
                    | _applySpecBoost   |
                    +--------+----------+
                             |
                    specificationState
                             |
                    +--------v----------+
                    | PhaseOrchestrator |
                    |   规格门禁         |
                    | registerSpecReq.  |
                    | markSpecVerified  |
                    +--------+----------+
                             |
              spec-gate-blocked / spec-verified
                             |
           +-----------------+-----------------+
           |                 |                 |
  +--------v------+  +------v--------+  +-----v-----------+
  | EvidenceV.    |  | MemoryStore   |  | DocFreshnessG.  |
  | spec_verified |  | specType/     |  | SPEC_STALE_     |
  | soft-required |  | liveness/     |  | THRESHOLD_MS    |
  | _assessSpec   |  | spec-protect  |  | reverification  |
  | Conformance   |  | eviction      |  | queue           |
  +--------+------+  +------+--------+  +-----+-----------+
           |                 |                 |
           +-----------------+-----------------+
                             |
                    +--------v----------+
                    | ConfigCausalV.    |
                    | sourceCodeGraph   |
                    | specification     |
                    | Bindings          |
                    +--------+----------+
                             |
                    +--------v----------+
                    | ContextCompressE. |
                    | specification_    |
                    | asset策略         |
                    | retainedSpecAssets|
                    +-------------------+
```

---

## API参考

### 1. EvidenceVerifier（证据验证器）

**文件**：`src/gate/evidence-verifier.js`

#### 新增证据类型：specification_verified

| 属性 | 说明 |
|------|------|
| 类型名 | `specification_verified` |
| 必需性 | 软必需（soft-required） |
| 用途 | 标记规格验证已通过，包含规格ID和一致性评分 |

软必需机制意味着：当`specification_verified`证据缺失时，不会导致验证失败（hardMissing），但会在`missing`列表中标记，提示Agent补充。

#### 新增方法：_assessSpecConformance

```javascript
function _assessSpecConformance(specEvidence)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `specEvidence` | EvidenceItem[] | 类型为`specification_verified`的证据列表 |
| **返回值** | number | 一致性评分（0-1） |

评分逻辑：

| 证据内容模式 | 分数变化 |
|-------------|---------|
| 基础分 | 0.5 |
| 包含"conforms"/"verified"/"一致"/"符合"/"validated" | +0.2 |
| 包含"drift"/"diverge"/"不一致"/"偏离" | -0.3 |
| 包含"full conformance"/"完全符合" | +0.15 |

#### verify()返回值扩展

`verify()`方法的返回对象新增`specificationConformance`字段：

```javascript
{
  verified: boolean,
  score: number,
  // ... 原有字段 ...
  specificationConformance: {
    specIds: string[],           // 规格ID列表
    conformanceScore: number,    // 一致性评分（0-1）
    driftDetected: boolean,      // 是否检测到漂移
  } | null,
}
```

#### classifyCriteriaStrength扩展

`classifyCriteriaStrength()`方法新增规格相关强标准模式：

| 模式 | 说明 |
|------|------|
| `/specification\s*(verified\|validated\|conforms)/i` | 英文规格验证标准 |
| `/规格\s*(验证\|确认\|一致)/i` | 中文规格验证标准 |
| `/specification\|spec\|规格\|规格说明/i` | 规格关键词出现即视为强标准 |

---

### 2. MemoryStore（记忆存储）

**文件**：`src/runtime/thought/memory-store.js`

#### 新增知识记录字段

`_buildKnowledgeRecord()`方法为知识条目新增3个SDD字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `specificationType` | string\|null | `null` | 规格类型（requirement/architecture/interface/behavior/general） |
| `livenessStatus` | string\|null | `null` | 存活状态：`alive`/`orphaned`/`stale`，仅规格条目有值 |
| `relatedCodePaths` | string[] | `[]` | 关联的源码路径列表 |
| `lastVerifiedAgainstCode` | number\|null | `null` | 上次针对代码验证的时间戳 |

#### 新增方法：updateSpecLiveness

```javascript
MemoryStore.prototype.updateSpecLiveness(id, status, verifiedPaths)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 知识条目ID |
| `status` | string | 新的存活状态（`alive`/`orphaned`/`stale`） |
| `verifiedPaths` | string[] | 验证后的关联代码路径 |
| **返回值** | object\|null | 更新后的条目，或null（条目不存在或非规格条目） |

触发事件：`spec-liveness-updated`，数据为`{ id, status }`。

#### 新增方法：getSpecAssetsByType

```javascript
MemoryStore.prototype.getSpecAssetsByType(specType)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `specType` | string | 规格类型（如`requirement`、`architecture`） |
| **返回值** | object[] | 该类型的所有规格资产条目 |

#### 规格保护淘汰机制

`_trimKnowledge()`方法在知识条目超出`MAX_KNOWLEDGE_ENTRIES`（500）上限时，按以下优先级淘汰：

1. 优先淘汰非规格条目
2. 非规格条目不足时，淘汰`livenessStatus === 'orphaned'`的规格条目
3. 活跃规格条目（`alive`/`stale`）最后淘汰

#### 查询扩展

`queryKnowledge()`方法新增3个过滤条件：

| 过滤字段 | 说明 |
|---------|------|
| `specificationType` | 按规格类型过滤 |
| `livenessStatus` | 按存活状态过滤 |
| `relatedCodePath` | 按关联代码路径过滤 |

#### 规格资产索引

MemoryStore内部维护`_specAssetIndex`（Map<specType, id[]>），在`addKnowledge`、`removeKnowledge`和`_rebuildSpecAssetIndex`中自动维护，支持`getSpecAssetsByType`的快速查询。

---

### 3. DocFreshnessGuard（文档新鲜度守卫）

**文件**：`src/runtime/quality/doc-freshness-guard.js`

#### 新增常量：SPEC_STALE_THRESHOLD_MS

| 常量 | 值 | 说明 |
|------|-----|------|
| `SPEC_STALE_THRESHOLD_MS` | `3 * 24 * 3600 * 1000`（3天） | 规格文档过期阈值，比普通文档的7天更短 |

规格文档使用更短的过期阈值，因为规格与代码的一致性更容易因代码变更而失效。

#### 新增方法：_isSpecificationDoc

```javascript
_isSpecificationDoc(content, docPath)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | string | 文档内容 |
| `docPath` | string | 文档路径 |
| **返回值** | boolean | 是否为规格文档 |

检测规则：

| 检测方式 | 模式 |
|---------|------|
| 路径匹配 | `spec-`/`specification`/`requirement-`/`architecture-`/`interface-`/`design-doc`/`design-spec` |
| 内容匹配 | 文档前2000字符内包含`## Specification`/`## 规格`/`## 需求规格`/`## 接口定义`/`## Interface` |

#### 新增方法：_detectSpecType

```javascript
_detectSpecType(content)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | string | 文档内容 |
| **返回值** | string | 规格类型：`requirement`/`architecture`/`interface`/`behavior`/`general` |

检测逻辑：统计文档前3000字符中各类型关键词的出现频次，取频次最高的类型。

| 类型 | 关键词 |
|------|--------|
| requirement | 需求、requirement |
| architecture | 架构、architecture |
| interface | 接口、interface |
| behavior | 行为、behavior |

#### 新增方法：triggerReverification

```javascript
triggerReverification(docPath)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `docPath` | string | 文档相对路径 |
| **返回值** | object | `{ triggered, specType?, attempt?, reason? }` |

触发条件与限制：

| 条件 | 说明 |
|------|------|
| 文档必须已索引 | 否则返回`{ triggered: false, reason: 'not_indexed' }` |
| 文档必须是规格文档 | 否则返回`{ triggered: false, reason: 'not_specification' }` |
| 最大重试次数 | 5次，超出返回`{ triggered: false, reason: 'max_attempts_exceeded' }` |

触发事件：`spec-reverification-triggered`，数据为`{ path, specType, attempt }`。

#### 新增方法：drainReverificationQueue

```javascript
drainReverificationQueue()
```

| 返回值 | 说明 |
|--------|------|
| object[] | 待再验证队列中的所有条目，并清空队列 |

每个条目格式：`{ path, entry, stalenessAge }`。

#### 新增事件：spec-stale

当规格文档被标记为过期时，额外触发`spec-stale`事件：

```javascript
{
  path: string,              // 文档路径
  specType: string,          // 规格类型
  staleReason: string,       // 过期原因
  reverificationNeeded: true // 是否需要再验证
}
```

#### 文档索引扩展

`_indexDocFileAsync()`方法为每个文档条目新增字段：

| 字段 | 说明 |
|------|------|
| `specificationType` | 规格类型（非规格文档为null） |
| `livenessPolicy` | 存活策略：`active`（规格文档）/ `passive`（普通文档） |
| `reverificationAttempts` | 再验证尝试次数 |
| `lastReverificationAt` | 上次再验证时间 |

#### validateFreshness扩展

`validateFreshness()`方法对规格文档使用`SPEC_STALE_THRESHOLD_MS`（3天）而非`STALE_THRESHOLD_MS`（7天）进行过期判断。超过阈值的活跃规格文档会被加入`_specReverificationQueue`。

---

### 4. ConfigCausalValidator（因果配置验证器）

**文件**：`src/runtime/causal/causal-config-validator.js`

#### 新增方法：_buildSourceCodeNodes

```javascript
_buildSourceCodeNodes()
```

| 返回值 | 说明 |
|--------|------|
| object | 源码节点图，键为相对路径，值为节点对象 |

节点对象结构：

```javascript
{
  id: string,                    // 相对路径
  exports: string[],             // 导出的类/函数名
  imports: string[],             // 导入路径列表
  dependsOnSet: Set<string>,     // 依赖集合
  specificationBindings: string[], // 绑定的Skill ID列表
  resolvedImports: string[],     // 解析后的导入路径
  dependedOnBy: string[],        // 被依赖列表
}
```

#### 新增方法：_buildSourceCodeEdges

```javascript
_buildSourceCodeEdges(graph)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `graph` | object | 依赖图对象，包含`sourceCode`和`skills` |

该方法完成两个工作：
1. 将Skill的`specificationBindings`映射到源码节点
2. 解析源码间的相对导入路径，建立`dependedOnBy`反向依赖

#### 新增方法：getSourceCodeGraph

```javascript
getSourceCodeGraph()
```

| 返回值 | 说明 |
|--------|------|
| object\|null | 源码依赖图，由`buildDependencyGraph()`构建 |

#### specificationBindings

Skill节点的`specificationBindings`字段（来自config.json中的`specification_bindings`配置）声明了Skill与源码文件的绑定关系：

```json
{
  "skill_registry": {
    "tdd-implement": {
      "specification_bindings": ["src/gate/tdd-gate.js", "src/gate/evidence-verifier.js"]
    }
  }
}
```

#### getImpactAnalysis扩展

`getImpactAnalysis()`方法新增`sourceCode`节点类型的影响分析：

| nodeType | 分析逻辑 |
|----------|---------|
| `sourceCode` | 查找导入该节点的其他源码 + 查找specificationBindings绑定了该节点的Skill |

---

### 5. PhaseOrchestrator（阶段编排器）

**文件**：`src/runtime/workflow/phase-orchestrator.js`

#### 新增属性：_specGate

```javascript
this._specGate = new Map(); // Map<phase, { requiredSpecs: string[], verifiedSpecs: Set<string> }>
```

规格门禁数据结构，按阶段存储该阶段需要验证的规格ID列表和已验证的规格ID集合。

#### 新增方法：registerSpecRequirement

```javascript
registerSpecRequirement(phase, specId)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `phase` | string | 阶段名称 |
| `specId` | string | 规格ID |
| **返回值** | PhaseOrchestrator | this（链式调用） |

为指定阶段注册规格验证要求。如果该阶段尚无门禁记录，自动创建。

#### 新增方法：markSpecVerified

```javascript
markSpecVerified(phase, specId)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `phase` | string | 阶段名称 |
| `specId` | string | 规格ID |
| **返回值** | boolean | 是否标记成功 |

标记指定阶段的规格为已验证。仅当该规格ID已注册时才能标记成功。

触发事件：`spec-verified`，数据为`{ phase, specId }`。

#### 新增方法：getSpecGateState

```javascript
getSpecGateState(phase)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `phase` | string | 阶段名称 |
| **返回值** | object | `{ requiredSpecs, verifiedSpecs, unverifiedSpecs }` |

#### 新增方法：_checkSpecGate

```javascript
_checkSpecGate(fromPhase, toPhase)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `fromPhase` | string | 源阶段 |
| `toPhase` | string | 目标阶段 |
| **返回值** | object | `{ passed: boolean, missing?: string[] }` |

在`setCurrentPhase()`中自动调用，检查源阶段和目标阶段的规格门禁。

#### 新增方法：_getSpecReadiness

```javascript
_getSpecReadiness(phase)
```

| 返回值 | 说明 |
|--------|------|
| object | `{ ready: boolean, missingSpecs: string[] }` |

在`canAdvanceToNext()`和`getCausalReadiness()`中自动调用。

#### 新增事件：spec-gate-blocked

当阶段转换因规格门禁未通过而被阻止时触发：

```javascript
{
  from: string,      // 源阶段
  to: string,        // 目标阶段
  missing: string[], // 未验证的规格ID列表
  gatePhase: string, // 门禁所在阶段
}
```

#### isPhaseComplete扩展

`isPhaseComplete()`方法在原有技能完成检查基础上，新增规格门禁检查：如果该阶段有规格门禁且存在未验证的规格，则阶段未完成。

---

### 6. ContextCompressionEngine（上下文压缩引擎）

**文件**：`src/runtime/context/context-compression-engine.js`

#### 新增策略：specification_asset

| 策略键 | 默认值 | 说明 |
|--------|--------|------|
| `specification_asset` | `'full'` | 规格资产始终保留完整内容 |

该策略不可修改：调用`setStrategy('specification_asset', ...)`时，任何非`'full'`的值都会被拒绝。

#### 规格资产检测：_hasSpecificationOutput

```javascript
_hasSpecificationOutput(skill)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `skill` | object | Skill定义对象 |
| **返回值** | boolean | Skill的`causal_outputs`中是否包含`specification`输出 |

当Skill的`causal_outputs`包含名为`specification`的输出时，该Skill被归类为`specification_asset`，在压缩时始终保留完整内容。

#### compress()返回值扩展：retainedSpecAssets

`compress()`方法的返回对象通过`_classifyContext()`新增`retainedSpecAssets`字段：

```javascript
{
  retainedSkills: [...],
  compressedSkills: [...],
  // ... 原有字段 ...
  retainedSpecAssets: [
    {
      asset_id: string,     // 资产ID
      asset_type: string,   // 资产类型
      retained: true,       // 是否保留
      reason: 'specification_asset',
      strategy: 'full',
    }
  ],
}
```

#### 统计扩展

`_stats`对象新增`specificationAssetsRetained`计数器，记录累计保留的规格资产数量。

#### 状态哈希扩展

`_computeStateHash()`方法将`specificationAssets`的ID列表纳入哈希计算，确保规格资产变化时压缩结果正确更新。

---

### 7. SkillRouter（Skill路由引擎）

**文件**：`src/runtime/skill/skill-router.js`

#### 新增语义组：specification

```javascript
'specification': ['规格', '规格说明', 'specification', 'spec', '接口规格', 'interface spec', '行为规格', 'behavior spec']
```

当用户消息包含规格相关关键词时，匹配到`specification`语义组的Skill会获得语义匹配加分。

#### 新增方法：_applySpecBoost

```javascript
_applySpecBoost(matches, specificationState)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `matches` | SkillDef[] | 匹配的Skill列表 |
| `specificationState` | object | 规格状态 |
| **返回值** | SkillDef[] | 按规格优先级重新排序的Skill列表 |

排序规则（在阶段优先级基础上）：

| 条件 | 优先级调整 |
|------|-----------|
| Skill的`specification_type`在`staleSpecs`中 | -5（降权） |
| Skill的`causal_outputs`包含`specification_verified` | +10（最高优先） |
| Skill的`specification_type`在`activeSpecs`中 | +5（提升优先） |

#### 新增方法：_getSpecBoost

```javascript
_getSpecBoost(skill, specificationState)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `skill` | object | Skill定义 |
| `specificationState` | object | 规格状态 |
| **返回值** | number | 优先级调整值（-5/0/5/10） |

#### match()扩展：specificationState

`match()`方法接受`context.specificationState`参数：

```javascript
const matches = router.match({
  userMessage: '...',
  agent: 'task-worker',
  completedSkills: [],
  specificationState: {
    activeSpecs: ['requirement', 'architecture'],  // 活跃规格类型
    verifiedSpecs: ['requirement'],                 // 已验证规格类型
    staleSpecs: ['interface'],                      // 过期规格类型
  },
});
```

`specificationState`参与路由缓存键计算，确保规格状态变化时缓存正确失效。

#### Skill定义扩展

`_buildSkillFromFrontmatter()`方法解析两个新的Front Matter字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `specification_required` | boolean | 是否需要规格验证 |
| `specification_type` | string\|null | 规格类型 |

#### 统计扩展

`_stats`对象新增`specDrivenMatches`计数器，记录经过规格优先级调整的匹配次数。

---

## 使用示例

### 基本SDD流程

```javascript
const SkillRouter = require('./src/runtime/skill/skill-router');
const PhaseOrchestrator = require('./src/runtime/workflow/phase-orchestrator');
const EvidenceVerifier = require('./src/gate/evidence-verifier');
const MemoryStore = require('./src/runtime/thought/memory-store');
const DocFreshnessGuard = require('./src/runtime/quality/doc-freshness-guard');
const ConfigCausalValidator = require('./src/runtime/causal/causal-config-validator');
const ContextCompressionEngine = require('./src/runtime/context/context-compression-engine');

const projectRoot = '/path/to/project';

const router = new SkillRouter(projectRoot);
router.discover();

const orchestrator = new PhaseOrchestrator();
const verifier = new EvidenceVerifier();
const memory = new MemoryStore(projectRoot);
const freshness = new DocFreshnessGuard({ projectRoot });
const causal = new ConfigCausalValidator(projectRoot);
const compression = new ContextCompressionEngine();

causal.buildDependencyGraph();
compression.attachConfigCausalValidator(causal);
```

### 注册规格门禁

```javascript
orchestrator.registerSpecRequirement('architecture-design', 'api-spec');
orchestrator.registerSpecRequirement('module-development', 'api-spec');
orchestrator.registerSpecRequirement('module-development', 'behavior-spec');

const state = orchestrator.getSpecGateState('module-development');
console.log(state.unverifiedSpecs);
```

### 验证规格一致性

```javascript
const result = verifier.verify({
  claim: 'API规格实现完成',
  evidence: [
    { type: 'test_output', content: 'All 42 tests passed' },
    { type: 'coverage_report', content: 'Coverage 92%' },
    {
      type: 'specification_verified',
      content: 'API规格完全符合，无漂移检测',
      metadata: { specId: 'api-spec' },
    },
  ],
  requiredTypes: ['test_output', 'coverage_report', 'specification_verified'],
});

console.log(result.specificationConformance);
```

### 管理规格资产存活状态

```javascript
memory.addKnowledge({
  category: 'specification',
  title: 'API接口规格',
  content: '...',
  specificationType: 'interface',
  relatedCodePaths: ['src/runtime/skill/skill-router.js'],
});

memory.updateSpecLiveness('mem-abc123', 'alive', [
  'src/runtime/skill/skill-router.js',
  'src/gate/evidence-verifier.js',
]);

const interfaceSpecs = memory.getSpecAssetsByType('interface');
```

### 处理规格过期

```javascript
freshness.on('spec-stale', (data) => {
  console.log(`规格文档 ${data.path} 已过期: ${data.staleReason}`);
  const result = freshness.triggerReverification(data.path);
  if (result.triggered) {
    console.log(`触发再验证，第 ${result.attempt} 次尝试`);
  }
});

const queue = freshness.drainReverificationQueue();
for (const item of queue) {
  console.log(`待再验证: ${item.path}, 过期时长: ${item.stalenessAge}ms`);
}
```

### 规格感知的Skill路由

```javascript
const matches = router.match({
  userMessage: '验证API规格一致性',
  agent: 'task-worker',
  completedSkills: ['architecture-design'],
  specificationState: {
    activeSpecs: ['interface'],
    verifiedSpecs: [],
    staleSpecs: ['interface'],
  },
});
```

---

## 配置选项

### config.json中的SDD相关配置

```json
{
  "skill_registry": {
    "tdd-implement": {
      "specification_bindings": [
        "src/gate/tdd-gate.js",
        "src/gate/evidence-verifier.js"
      ]
    }
  }
}
```

### Skill Front Matter中的SDD字段

```yaml
---
skill_id: architecture-design
specification_required: true
specification_type: architecture
causal_outputs:
  - name: specification
  - name: architecture_document
---
```

### ContextCompressionEngine策略配置

```javascript
const compression = new ContextCompressionEngine({
  strategies: {
    specification_asset: 'full',  // 不可修改，始终为'full'
    completed_phase: 'summary',
    current_phase: 'full',
  },
});
```

---

## 事件汇总

| 事件名 | 触发模块 | 数据 | 说明 |
|--------|---------|------|------|
| `spec-liveness-updated` | MemoryStore | `{ id, status }` | 规格资产存活状态变更 |
| `spec-stale` | DocFreshnessGuard | `{ path, specType, staleReason, reverificationNeeded }` | 规格文档被标记为过期 |
| `spec-reverification-triggered` | DocFreshnessGuard | `{ path, specType, attempt }` | 规格文档再验证被触发 |
| `spec-verified` | PhaseOrchestrator | `{ phase, specId }` | 规格门禁验证通过 |
| `spec-gate-blocked` | PhaseOrchestrator | `{ from, to, missing, gatePhase }` | 阶段转换被规格门禁阻止 |
| `specification_asset`策略保留 | ContextCompressionEngine | `retainedSpecAssets`数组 | 压缩时保留的规格资产列表 |

---

## 相关文档

- [模块详解-EvidenceVerifier模块](模块详解-EvidenceVerifier模块.md)
- [模块详解-PhaseOrchestrator阶段编排器](模块详解-PhaseOrchestrator阶段编排器.md)
- [模块详解-SkillRouter模块](模块详解-SkillRouter模块.md)
- [核心功能-TDD门禁执行流程](../core/核心功能-TDD门禁执行流程.md)
- [核心功能-上下文压缩引擎](../core/核心功能-上下文压缩引擎.md)
- [SDD集成指南](../guidelines/SDD集成指南.md)
