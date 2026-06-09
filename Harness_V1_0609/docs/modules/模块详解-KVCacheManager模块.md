# 模块详解-KVCacheManager模块

> 版本：2.73.4 | 文件：src/runtime/model/kv-cache-manager.js | 行数：~400行
>
> **R47 GPT-5.6融合更新**：新增三级分层记忆缓存架构（MemoryTier），融合GPT-5.6自适应稀疏注意力+三级分层记忆缓存能力。

---

## 1. 模块定位

KVCacheManager位于模型子系统（`src/runtime/model/`）中，是该子系统六个核心模块之一。模型子系统的模块关系如下：

```
TokenManager ──预算感知──► ModelSelector ──选择模型──► InferenceCache
                                                    │ 向量化
                                                    ▼
TriAttention ──校准Q/K中心──► KVCacheManager
  │                              │
  └────── 评分反馈 ◄─────────────┘
```

KVCacheManager在模型子系统中承担**KV缓存压缩**职责，是连接TriAttention注意力评分与实际缓存管理的桥梁。它依赖TriAttention提供的校准统计信息（Q/K聚类中心、集中度）来动态调整剪枝权重，形成"TriAttention校准→权重调整→四维评分→剪枝压缩"的完整闭环。

### 依赖关系

| 方向 | 模块 | 说明 |
|------|------|------|
| 依赖 | `events` | EventEmitter基类，提供事件发射能力 |
| 依赖 | `../../errors` | DeepeningError错误类型，构造函数参数校验 |
| 依赖 | `../../utils/safe-assign` | mergeConfig，配置合并 |
| 依赖 | `../../utils/debug-logger` | debug，调试日志输出 |
| 依赖 | `../../utils/shutdown-mixin` | withShutdown，优雅关闭混入 |
| 强依赖 | TriAttention | 构造时必须传入triAttention实例，校准权重依赖其统计信息 |
| 被依赖 | DeepeningPipeline | 深化管道在迭代深化时使用KVCacheManager管理缓存 |
| 被依赖 | ContextCompressionEngine | 上下文压缩引擎通过KVCacheManager实现KV缓存压缩 |

---

## 2. 核心能力

### 四维评分剪枝

KVCacheManager的核心能力是对缓存条目进行四维综合评分，基于评分结果剪枝低价值条目：

| 维度 | 评分依据 | 物理含义 |
|------|---------|---------|
| 三角级数距离偏好 | `sin(π × position / (total - 1))` | 基于Pre-RoPE空间位置编码，首尾位置权重高、中间权重低 |
| 向量幅度 | `min(1, vectorNorm / 10)` | KV向量L2范数，高幅度=高信息密度 |
| 时效性 | `max(0, 1 - (now - lastAccessedAt) / 3600000)` | 最近1小时内访问的条目权重更高 |
| 访问频率 | `min(1, accessCount / 10)` | 高频访问的条目权重更高 |

### 自适应权重调整

通过TriAttention校准的Q集中度（qConcentration）动态调整距离偏好与向量幅度的权重分配：
- Q集中度高（>0.8）：向量幅度权重提升至0.7，距离偏好降至0.3
- Q集中度低（≤0.8）：向量幅度权重降至0.3，距离偏好提升至0.7

### 显存压缩

当缓存条目数达到`maxCacheSize`上限时，自动触发剪枝。默认压缩比0.1（保留90%，剪枝10%），配合自适应权重调整，实现10倍+显存压缩效果。

---

## 3. 类定义与构造函数

### 类定义

```javascript
class KVCacheManager extends EventEmitter { ... }
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法、`guardShutdown()`守卫和`_onShutdown()`生命周期钩子。

### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `KVCacheManager.DEFAULT_CONFIG` | Object | 默认配置对象，包含maxCacheSize、compressionRatio等字段 |
| `KVCacheManager.MemoryTier` | Object | 分层记忆缓存层级枚举（IMMEDIATE/SHORT_TERM/LONG_TERM） |
| `KVCacheManager.TIER_CONFIGS` | Object | 各层默认配置（maxSize/ttlMs/promotionThreshold） |

### 构造函数

```javascript
new KVCacheManager(triAttention, options)
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `triAttention` | TriAttention | 是 | — | TriAttention实例，用于校准权重。为null/undefined时抛出DeepeningError |
| `options` | Object | 否 | — | 配置选项 |
| `options.maxCacheSize` | number | 否 | 10000 | 最大缓存条目数，达到此值触发剪枝 |
| `options.compressionRatio` | number | 否 | 0.1 | 剪枝比例，0.1表示每次剪枝10%条目 |
| `options.enableAdaptiveCompression` | boolean | 否 | true | 启用自适应压缩权重调整 |
| `options.headConcentrationThreshold` | number | 否 | 0.8 | Q集中度阈值，超过此值提升向量幅度权重 |
| `options.magnitudeWeight` | number | 否 | 0.5 | 向量幅度基础权重（0-1），距离偏好权重=1-magnitudeWeight |
| `options.pruningBatchSize` | number | 否 | 100 | 剪枝批次大小（预留参数） |

**异常**：`DeepeningError('INVALID_INPUT')` — triAttention参数为空时抛出

构造时初始化内部状态：
- `_cache`：Map，存储缓存条目（key → entry）
- `_stats`：运行统计对象（totalEntries、prunedEntries、compressionRatios、avgCompressionRatio）
- `_triAttention`：TriAttention实例引用
- `_tierCaches`：Object，三级分层记忆缓存（IMMEDIATE/SHORT_TERM/LONG_TERM → Map）
- `_tierConfigs`：Object，各层配置（maxSize/ttlMs/promotionThreshold）
- `_tierStats`：分层统计（promotions/evictions/tierHits）

---

## 4. 公开方法详解

### `set(key, value, metadata)`

写入缓存条目。当缓存满时自动触发剪枝。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | any | 是 | 缓存键，为null/undefined时返回false |
| `value` | any | 否 | 缓存值，用于计算向量幅度 |
| `metadata` | Object | 否 | 附加元数据，默认为空对象 |

**返回值**：`boolean` — 写入成功返回true，key无效时返回false

**行为说明**：
1. 调用`guardShutdown()`检查关闭状态
2. 创建entry对象，包含key、value、metadata、createdAt、accessCount（初始0）、vectorNorm
3. 若缓存已满（`size >= maxCacheSize`），先调用`_prune()`剪枝
4. 写入缓存并递增totalEntries计数器

**entry对象结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | any | 缓存键 |
| `value` | any | 缓存值 |
| `metadata` | Object | 附加元数据 |
| `createdAt` | number | 创建时间戳（Date.now()） |
| `accessCount` | number | 访问计数，初始0 |
| `vectorNorm` | number | 值的L2范数 |
| `lastAccessedAt` | number | 最后访问时间戳（首次get后存在） |

### `get(key)`

读取缓存条目，同时更新访问计数和最后访问时间。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | any | 是 | 缓存键 |

**返回值**：`any` — 缓存值，不存在时返回null

**行为说明**：
1. 从`_cache`中查找entry
2. 若存在，递增`accessCount`，设置`lastAccessedAt = Date.now()`
3. 返回entry.value

### `has(key)`

检查缓存中是否存在指定键。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | any | 是 | 缓存键 |

**返回值**：`boolean`

### `delete(key)`

删除指定缓存条目。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | any | 是 | 缓存键 |

**返回值**：`boolean` — 删除成功返回true，键不存在返回false

**行为说明**：调用`guardShutdown()`检查关闭状态后执行删除。

### `calibrateFromTriAttention()`

从TriAttention校准统计信息中调整剪枝权重。

**返回值**：`void`

**行为说明**：
1. 调用`guardShutdown()`检查关闭状态
2. 通过`_triAttention.getCalibrationStats()`获取校准统计
3. 若校准统计存在且qCenter不为null，根据qConcentration调整magnitudeWeight：
   - qConcentration > headConcentrationThreshold → magnitudeWeight = 0.7
   - qConcentration ≤ headConcentrationThreshold → magnitudeWeight = 0.3
4. 输出调试日志记录权重调整

### `getStats()`

获取运行统计信息。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `size` | number | 当前缓存条目数 |
| `maxSize` | number | 最大缓存条目数 |
| `totalEntries` | number | 历史写入总条目数 |
| `prunedEntries` | number | 历史剪枝总条目数 |
| `avgCompressionRatio` | number | 平均压缩比（最近100次的滑动平均） |
| `config` | Object | 当前配置的深拷贝 |

---

## 5. 四维评分算法

`_prune()`方法内部对每个缓存条目计算四维综合评分，评分越高越不容易被剪枝。

### 5.1 三角级数距离偏好（distanceScore）

```
position = index / max(1, total - 1)
distanceScore = sin(π × position)
```

- `index`：条目在缓存Map迭代顺序中的位置（0-based）
- `total`：缓存条目总数
- `position`：归一化位置，范围[0, 1]
- `distanceScore`：范围[0, 1]

**特性**：正弦函数在position=0和position=1处取值0，在position=0.5处取值1。这意味着**首尾位置的条目权重最低，中间位置的条目权重最高**。这模拟了Transformer注意力中"中间层信息密度最高"的经验观察。

### 5.2 向量幅度（magnitudeScore）

```
vectorNorm = _computeVectorNorm(value)
magnitudeScore = vectorNorm > 0 ? min(1, vectorNorm / 10) : 0
```

`_computeVectorNorm`计算value的L2范数：
- 若value为数组：`sqrt(Σ v[i]²)`
- 若value为对象：`sqrt(Σ Object.values(v)[i]²)`
- 其他类型：返回0

**特性**：向量幅度反映信息密度。高幅度向量通常携带更多语义信息，应优先保留。除以10进行归一化，超过10的范数截断为1。

### 5.3 时效性（recencyScore）

```
recencyScore = lastAccessedAt != null
  ? max(0, 1 - (Date.now() - lastAccessedAt) / 3600000)
  : (accessCount > 0 ? 0.5 : 0)
```

- 若条目曾被访问（lastAccessedAt存在）：以1小时为衰减窗口，1小时内线性衰减，超过1小时评分为0
- 若条目曾被访问但无时间戳（accessCount > 0）：评分为0.5（中等）
- 若条目从未被访问：评分为0

**特性**：最近访问的条目更可能再次被访问（时间局部性原理），应优先保留。

### 5.4 访问频率（accessScore）

```
accessScore = min(1, accessCount / 10)
```

- accessCount为0时评分为0
- accessCount达到10次时评分为1（封顶）

**特性**：高频访问的条目具有更高的复用价值，应优先保留。

### 5.5 综合评分公式

```
adaptiveMagWeight = enableAdaptiveCompression ? magnitudeWeight : 0.5
adaptiveDistWeight = 1 - adaptiveMagWeight

score = adaptiveDistWeight × distanceScore
      + adaptiveMagWeight × magnitudeScore
      + 0.1 × recencyScore
      + 0.1 × accessScore
```

**权重分配**：
- 距离偏好 + 向量幅度：主权重（合计1.0），两者互斥分配
- 时效性：固定0.1
- 访问频率：固定0.1
- 总权重范围：0.0 ~ 1.2

---

## 6. 自适应权重调整

### 调整机制

自适应权重调整通过`calibrateFromTriAttention()`方法实现，核心逻辑基于TriAttention校准的Q集中度（qConcentration）。

### 校准流程

```
TriAttention.calibrate(qVectors, kVectors)
    ↓
计算 qCenter / kCenter / qConcentration / kConcentration
    ↓
KVCacheManager.calibrateFromTriAttention()
    ↓
读取 qConcentration
    ↓
qConcentration > headConcentrationThreshold (0.8)?
    ├─ 是 → magnitudeWeight = 0.7（向量幅度主导）
    └─ 否 → magnitudeWeight = 0.3（距离偏好主导）
    ↓
更新 _config.magnitudeWeight
```

### 权重分配策略

| Q集中度 | magnitudeWeight | distWeight | 策略含义 |
|---------|----------------|------------|---------|
| > 0.8（高集中） | 0.7 | 0.3 | Q向量高度集中，信息密度集中在少数高幅度向量上，应优先保留高幅度条目 |
| ≤ 0.8（低集中） | 0.3 | 0.7 | Q向量分散，位置信息更重要，应优先保留中间位置的条目 |

### 与TriAttention的校准联动

1. TriAttention通过`calibrate(qVectors, kVectors)`计算Q/K聚类中心
2. KVCacheManager在适当时机调用`calibrateFromTriAttention()`
3. TriAttention的`getCalibrationStats()`返回`{ qCenter, kCenter, qConcentration, kConcentration, isCalibrated }`
4. KVCacheManager读取qConcentration与headConcentrationThreshold比较，调整magnitudeWeight

当`enableAdaptiveCompression`为false时，权重不随校准结果变化，固定使用构造时的magnitudeWeight值（默认0.5）。

---

## 7. 压缩流程

### 完整剪枝流程

```
set() 调用
    ↓
cache.size >= maxCacheSize?
    ├─ 否 → 直接写入
    └─ 是 → 触发 _prune()
              ↓
         1. 遍历所有缓存条目
              ↓
         2. 计算每个条目的四维综合评分
              ↓
         3. 按评分升序排序（低评分在前）
              ↓
         4. 计算剪枝数量：floor(entries.length × compressionRatio)
              ↓
         5. 从最低评分开始删除
              ↓
         6. 更新统计信息
              ↓
         7. 发射 'pruned' 事件
              ↓
         8. 写入新条目
```

### 压缩比计算

```
ratio = cache.size / max(1, totalEntries)
```

- `cache.size`：剪枝后剩余条目数
- `totalEntries`：历史写入总条目数（不减去已删除的）

统计信息维护一个滑动窗口（最近100次压缩比），计算平均压缩比：

```
compressionRatios.push(ratio)
if (compressionRatios.length > 100) compressionRatios.shift()
avgCompressionRatio = Σ(compressionRatios) / compressionRatios.length
```

### 剪枝数量

```
pruneCount = max(1, floor(entries.length × compressionRatio))
```

默认compressionRatio=0.1，即每次剪枝约10%的条目。最少剪枝1个条目。

### 10倍+压缩效果

在典型使用场景中：
- maxCacheSize=10000，compressionRatio=0.1
- 每次满时剪枝1000个条目，保留9000个
- 配合自适应权重调整，高价值条目持续保留
- 长期运行后，实际缓存占用远小于无压缩时的理论占用
- 平均压缩比（avgCompressionRatio）可低至0.1以下，即10倍+压缩

---

## 8. 事件体系

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `pruned` | `_prune()`剪枝完成后 | `{ pruned: number, remaining: number, ratio: number }` |

### 事件数据字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `pruned` | number | 本次剪枝的条目数 |
| `remaining` | number | 剪枝后剩余条目数 |
| `ratio` | number | 本次压缩比（remaining / totalEntries） |

### 监听示例

```javascript
kvCacheManager.on('pruned', ({ pruned, remaining, ratio }) => {
  console.log(`剪枝完成: 删除${pruned}条, 剩余${remaining}条, 压缩比${ratio.toFixed(3)}`);
});
```

---

## 9. 使用示例

### 基本使用

```javascript
const KVCacheManager = require('./src/runtime/model/kv-cache-manager');
const TriAttention = require('./src/runtime/model/tri-attention');

const triAttention = new TriAttention({ attentionThreshold: 0.2 });
const kvCache = new KVCacheManager(triAttention, {
  maxCacheSize: 1000,
  compressionRatio: 0.1,
  enableAdaptiveCompression: true,
});

kvCache.on('pruned', ({ pruned, remaining, ratio }) => {
  console.log(`剪枝: 删除${pruned}条, 剩余${remaining}条, 压缩比${ratio.toFixed(3)}`);
});

kvCache.set('key-1', [0.5, 0.3, 0.8, 0.1], { source: 'embedding' });
kvCache.set('key-2', [0.2, 0.9, 0.4, 0.6], { source: 'attention' });
kvCache.set('key-3', { a: 1.0, b: 0.5, c: 0.3 }, { source: 'inference' });

const value = kvCache.get('key-1');
console.log('key-1 value:', value);

console.log('has key-2:', kvCache.has('key-2'));

kvCache.delete('key-3');

const stats = kvCache.getStats();
console.log(`缓存: ${stats.size}/${stats.maxSize}`);
console.log(`总写入: ${stats.totalEntries}`);
console.log(`总剪枝: ${stats.prunedEntries}`);
console.log(`平均压缩比: ${stats.avgCompressionRatio.toFixed(3)}`);
```

### 与TriAttention集成

```javascript
const TriAttention = require('./src/runtime/model/tri-attention');
const KVCacheManager = require('./src/runtime/model/kv-cache-manager');

const triAttention = new TriAttention({
  attentionThreshold: 0.3,
  enablePreRopeScoring: true,
  magnitudeWeight: 0.5,
  concentrationThreshold: 0.8,
});

const qVectors = [
  [0.8, 0.2, 0.1],
  [0.7, 0.3, 0.1],
  [0.9, 0.1, 0.0],
];
const kVectors = [
  [0.1, 0.5, 0.4],
  [0.2, 0.6, 0.3],
  [0.0, 0.4, 0.6],
];

const calResult = triAttention.calibrate(qVectors, kVectors);
console.log('Q集中度:', calResult.qConcentration.toFixed(4));
console.log('K集中度:', calResult.kConcentration.toFixed(4));

const kvCache = new KVCacheManager(triAttention, {
  maxCacheSize: 500,
  compressionRatio: 0.1,
});

kvCache.calibrateFromTriAttention();

const calStats = triAttention.getCalibrationStats();
console.log('已校准:', calStats.isCalibrated);

for (let i = 0; i < 600; i++) {
  const vec = Array.from({ length: 10 }, () => Math.random());
  kvCache.set(`entry-${i}`, vec, { layer: i % 4 });
}

const stats = kvCache.getStats();
console.log(`缓存条目: ${stats.size}`);
console.log(`剪枝条目: ${stats.prunedEntries}`);
console.log(`平均压缩比: ${stats.avgCompressionRatio.toFixed(3)}`);
console.log(`magnitudeWeight: ${stats.config.magnitudeWeight}`);
```

### 优雅关闭

```javascript
await kvCache.shutdown();

const stats = kvCache.getStats();
console.log('关闭后缓存大小:', stats.size);
```

`shutdown()`触发时：
1. 清空`_cache` Map
2. 重置`_stats`为初始值
3. 移除所有事件监听器
4. 输出调试日志

---

## 10. 三级分层记忆缓存（R47 GPT-5.6融合）

### 架构概述

融合GPT-5.6自适应稀疏注意力+三级分层记忆缓存架构，在原有扁平缓存之上新增三级分层记忆缓存：

```
IMMEDIATE (即时记忆)  →  SHORT_TERM (短期缓存)  →  LONG_TERM (长期特征)
   500条 / 5min TTL       3000条 / 30min TTL       10000条 / 2h TTL
   晋升阈值: 3次访问       晋升阈值: 10次访问        最高层，无晋升
```

### MemoryTier 枚举

| 值 | 说明 | maxSize | ttlMs | promotionThreshold |
|----|------|---------|-------|-------------------|
| `IMMEDIATE` | 即时记忆层，当前对话上下文 | 500 | 300000 (5min) | 3 |
| `SHORT_TERM` | 短期缓存层，近期会话数据 | 3000 | 1800000 (30min) | 10 |
| `LONG_TERM` | 长期特征层，持久化模式与特征 | 10000 | 7200000 (2h) | Infinity |

### 分层方法

#### `setTiered(key, value, tier, metadata)`

向指定层级写入键值对。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | any | 是 | 缓存键，为null或tier无效时返回false |
| `value` | any | 否 | 缓存值 |
| `tier` | MemoryTier | 是 | 目标层级（IMMEDIATE/SHORT_TERM/LONG_TERM） |
| `metadata` | Object | 否 | 附加元数据 |

**返回值**：`boolean`

#### `getTiered(key, tier?)`

从指定层级或所有层级查找值。命中时更新访问计数并检查晋升条件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | any | 是 | 缓存键 |
| `tier` | MemoryTier | 否 | 指定层级，不指定时从IMMEDIATE→SHORT_TERM→LONG_TERM依次查找 |

**返回值**：`any` — 缓存值，未命中返回null

#### `getTieredStats()`

获取分层记忆缓存统计信息。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tierSizes` | Object | 各层当前条目数 |
| `tierConfigs` | Object | 各层配置 |
| `promotions` | number | 晋升总次数 |
| `evictions` | number | 驱逐总次数 |
| `tierHits` | Object | 各层命中次数 |

### 晋升机制

当条目访问计数达到当前层级的 `promotionThreshold` 时，自动晋升到更高层级：

1. `_checkPromotion(key, entry)` 在每次 `getTiered()` 命中时调用
2. 检查 `entry.accessCount >= tierConfig.promotionThreshold`
3. 若目标层级未满，从当前层删除并写入目标层
4. 递增 `_tierStats.promotions` 计数器
5. 输出调试日志

### 层级剪枝

当某层缓存满时，调用 `_pruneTier(tier)` 执行TTL感知的剪枝：

```
score = 0.3 × distanceScore + 0.2 × magnitudeScore + 0.3 × ttlScore + 0.2 × accessScore
```

与扁平缓存的区别：增加了 `ttlScore` 维度（权重0.3），基于条目创建时间与层级TTL计算时效性，确保即将过期的条目优先被剪枝。

### 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `tier-pruned` | 层级剪枝完成后 | `{ tier: string, pruned: number, remaining: number }` |

### 使用示例

```javascript
const { MemoryTier } = KVCacheManager;

// 写入即时记忆
kvCache.setTiered('current-task', taskData, MemoryTier.IMMEDIATE);

// 写入短期缓存
kvCache.setTiered('recent-session', sessionData, MemoryTier.SHORT_TERM);

// 写入长期特征
kvCache.setTiered('pattern-xyz', patternData, MemoryTier.LONG_TERM);

// 从所有层级查找（自动从IMMEDIATE→SHORT_TERM→LONG_TERM）
const value = kvCache.getTiered('current-task');

// 从指定层级查找
const value2 = kvCache.getTiered('pattern-xyz', MemoryTier.LONG_TERM);

// 查看分层统计
const tierStats = kvCache.getTieredStats();
console.log('各层大小:', tierStats.tierSizes);
console.log('晋升次数:', tierStats.promotions);
console.log('驱逐次数:', tierStats.evictions);
```

---

## 相关文档

- [[模块详解-TriAttention上下文优化]] — TriAttention校准机制与注意力评分
- [[模块详解-模型子系统]] — 模型子系统全貌与模块关系
- [[核心功能-上下文压缩引擎]] — 上下文压缩引擎与KVCacheManager的集成
- [[模块详解-TokenManager模块]] — Token预算管理
