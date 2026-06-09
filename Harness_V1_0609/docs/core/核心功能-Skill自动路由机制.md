# 核心功能-Skill自动路由机制

> 版本：2.73.4 | 模块：src/runtime/skill/skill-router.js | 依赖：fs, path, EventEmitter

---

## 概述

SkillRouter是框架的核心路由引擎，负责自动发现、匹配和激活Skill。它实现了三层缓存架构（L1摘要/L2指令/L3资源），支持语义匹配和否定模式检测。

> 详细的API文档请参见 [模块详解-SkillRouter模块](../modules/模块详解-SkillRouter模块.md)

## 核心能力

| 能力 | 说明 |
|------|------|
| **自动发现** | 扫描.harness/skills/目录，解析YAML Front Matter元数据 |
| **语义匹配** | 基于trigger_conditions和用户消息进行语义匹配 |
| **否定模式检测** | 识别"不要xxx"类否定意图，避免错误激活 |
| **三层缓存** | L1摘要缓存/L2指令缓存/L3资源缓存，减少重复加载 |
| **内容去重** | 避免相同内容被多次加载到上下文 |
| **SpecBoost** | 规格驱动优先级提升，活跃规格存在时提升SDD相关技能优先级 |
| **标签过滤** | match()支持tags参数，按标签交集过滤匹配候选集 |
| **文件变更监听** | watchForChanges()监控技能文件变更，自动重载注册表 |
| **行为等价性验证** | validateBehaviorEquivalence()验证重构前后技能行为一致性 |
| **部署检查清单验证** | validateDeploymentChecklist()验证部署类技能检查清单完整性 |

## 匹配流程

```
用户消息 → 预处理（否定模式检测+规范化+标签过滤）→ 触发条件匹配 → 关键词触发检测 → 因果输入检查（仅当无关键词触发时强制）→ SpecBoost优先级提升 → L1摘要匹配 → L2指令匹配 → L3资源加载 → 返回匹配结果
```

## SpecBoost规格驱动优先级提升

当项目中存在活跃的规格说明文件（spec.md）时，SpecBoost机制自动提升与规格驱动开发相关的技能优先级，确保规格驱动的开发流程获得优先执行。

**提升规则**：

| 条件 | 提升值 | 说明 |
|------|--------|------|
| 技能因果输出包含`specification_verified` | +10 | 规格验证类技能获得最高优先级 |
| 技能`specification_type`匹配活跃规格 | +5 | 规格相关技能获得中等优先级提升 |
| 技能`specification_type`匹配过时规格 | -5 | 过时规格相关技能优先级降低 |

**触发条件**：`specificationState.activeSpecs`数组非空时激活。

**使用方式**：

```javascript
const result = router.match({
  userMessage: '验证接口规格',
  agent: 'task-worker',
  specificationState: {
    activeSpecs: ['api-spec'],
    verifiedSpecs: [],
    staleSpecs: ['legacy-spec'],
  },
});
```

## 标签过滤

`match()`方法支持`tags`参数，用于按标签过滤匹配结果。仅当技能的`tags`字段与请求标签存在交集时，该技能才会被纳入匹配候选集。

**过滤逻辑**：

1. `tags`参数在`_normalizeMatchInput`中规范化为小写数组
2. `_findMatchingSkills`遍历候选技能时检查标签交集
3. 无标签交集的技能被跳过，并递增`tagFilterSkips`统计计数
4. 无`tags`参数或技能无标签时不进行过滤

**使用方式**：

```javascript
const result = router.match({
  userMessage: '运行测试',
  agent: 'task-worker',
  tags: ['testing', 'ci'],
});
```

**统计查询**：

```javascript
const stats = router.getLayerStats();
console.log(stats.tagFilterSkips); // 被标签过滤跳过的技能数
```

## 文件变更监听

`watchForChanges()`方法监控技能目录的文件变更，当技能文件被修改时自动重新加载技能注册表。

**三级监听策略**：

| 级别 | 机制 | 触发条件 |
|------|------|----------|
| 主策略 | `fs.watch` | 技能目录中.md文件发生变更 |
| 降级策略1 | mtime轮询 | `fs.watch`初始化失败或运行时出错 |
| 降级策略2 | access轮询 | mtime检测不可用时的最终降级 |

**防抖机制**：文件变更事件通过`DEFAULT_PERSIST_DEBOUNCE_MS`防抖间隔合并，避免频繁重载。

**事件通知**：重载完成后触发`skills-reloaded`事件，携带`skillCount`和触发来源信息。

**使用方式**：

```javascript
router.watchForChanges(); // 使用默认间隔
router.watchForChanges(5000); // 指定轮询间隔（降级时生效）
router.on('skills-reloaded', (data) => {
  console.log(`重新加载 ${data.skillCount} 个技能，触发文件: ${data.trigger}`);
});
```

## 行为等价性验证

`validateBehaviorEquivalence()`方法验证技能在重构前后的行为等价性，确保重构不改变技能的因果输出行为。

**验证逻辑**：

1. 检查技能是否存在`causal_outputs`定义
2. 筛选包含`behavior-equivalence-report`或`refactored-code`输出的技能
3. 对比重构前后上下文快照的每个键值（排除`timestamp`）
4. 使用`stableStringify`进行深层对象比较

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `valid` | boolean | 是否通过等价性验证 |
| `skillId` | string | 技能ID |
| `checks` | Array | 各键的变更检查结果（`{key, changed}`） |
| `summary` | string | 验证结果摘要 |

**使用方式**：

```javascript
const result = router.validateBehaviorEquivalence(
  'refactor-code',
  { inputFormat: 'json', outputKeys: ['a', 'b'] },
  { inputFormat: 'json', outputKeys: ['a', 'b', 'c'] },
);
// result.valid === false
// result.summary === 'outputKeys changed after refactoring'
```

## 部署检查清单验证

`validateDeploymentChecklist()`方法验证部署类技能的检查清单完整性，确保部署前所有必需检查项已通过。

**必需检查项**：

| 检查项 | 说明 |
|--------|------|
| `all-tests-passed` | 所有测试通过 |
| `code-merged-to-shared` | 代码已合并到共享区 |
| `environment-config-verified` | 环境配置已验证 |
| `rollback-plan-ready` | 回滚方案就绪 |
| `health-check-passed` | 健康检查通过 |
| `smoke-test-passed` | 冒烟测试通过 |
| `monitoring-configured` | 监控已配置 |

**验证条件**：仅当技能的`causal_outputs`包含`deployment-checklist`时触发验证，非部署类技能直接返回`valid: true`。

**返回值**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `valid` | boolean | 检查清单是否完整 |
| `checkedItems` | string[] | 已通过的检查项 |
| `missingItems` | string[] | 缺失的检查项 |
| `completionRate` | number | 完成率（0-1） |
| `summary` | string | 验证结果摘要 |

**使用方式**：

```javascript
const result = router.validateDeploymentChecklist('deployment', {
  'all-tests-passed': true,
  'code-merged-to-shared': true,
  'environment-config-verified': true,
  'rollback-plan-ready': true,
  'health-check-passed': true,
  'smoke-test-passed': true,
  'monitoring-configured': false,
});
// result.valid === false
// result.completionRate === 0.857
// result.missingItems === ['monitoring-configured']
```

## 三层缓存架构详解

SkillRouter采用三层缓存架构（L1/L2/L3），按需逐层加载技能内容，避免一次性将全部技能数据注入上下文，显著降低Token消耗。三层缓存的设计遵循"轻量匹配→按需加载→资源扩展"的渐进式原则。

### L1摘要缓存

L1层存储技能的摘要信息，是匹配阶段的唯一数据源。所有技能在`discover()`时即构建L1条目，常驻内存。

**数据结构**（由`buildBaseSkillEntry()`构建）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `skill_id` | string | 技能唯一标识 |
| `name` | string | 技能名称 |
| `summary` | string | 摘要文本（默认截断至`DEFAULT_SUMMARY_MAX_LENGTH`字符） |
| `phase` | string | 所属阶段 |
| `priority` | number | 优先级 |
| `enforcement` | string | 执行级别 |
| `applicable_agents` | Array | 适用Agent列表 |
| `infrastructure` | boolean | 是否基础设施组件 |
| `tags` | string[] | 标签数组（综合提取自frontmatter/技能名/触发条件/Agent/阶段） |
| `_filePath` | string | 源文件绝对路径（用于L2/L3按需加载） |
| `_fullContentLength` | number | 完整内容长度 |

**摘要生成策略**：优先使用frontmatter中的`summary`字段；若缺失，则调用`generateSkillSummary()`从内容自动生成，截断至配置的`summaryMaxLength`。

**Token估算**：`estimateTokens(skill.name + skill.summary)`，用于`getContextEstimate()`的L1层Token统计。

### L2指令缓存

L2层存储技能的Markdown正文（去除YAML Frontmatter后的指令体），仅在技能被匹配激活后按需加载。

**数据结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `skill_id` | string | 技能ID |
| `name` | string | 技能名称 |
| `instruction` | string | Markdown正文（由`extractMarkdownBody()`提取） |
| `loadedAt` | number | 加载时间戳（用于TTL过期判断） |
| `tokenEstimate` | number | Token估算值 |

**加载流程**：

1. 调用`loadL2(skillId)`或`loadL2Async(skillId)`
2. 检查`_l2Cache`是否命中（`_getCachedL2()`）
3. 命中时递增`l2Hits`统计，直接返回缓存条目
4. 未命中时递增`l2Misses`，从`_filePath`读取文件
5. 使用`extractMarkdownBody()`去除Frontmatter，提取指令正文
6. 构建`l2Entry`，写入`_l2Cache`（`_putL2Cache()`）
7. 记录Token节省量：`rawContent.length - instructionBody.length`

**批量预加载**：`preloadL2(skillIds)`支持一次性预加载多个技能的L2层，适用于已知即将执行的技能链场景。

**卸载**：`unloadL2(skillId)`从缓存中移除指定技能的L2条目，递增`l2Evictions`统计。

### L3资源缓存

L3层存储技能的引用资源文件（如`references/index.md`），仅在需要深度上下文时加载。

**数据结构**（由`buildL3Entry()`构建）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `skill_id` | string | 技能ID |
| `resourcePath` | string | 资源相对路径（默认`references/index.md`） |
| `content` | string | 资源文件完整内容 |
| `loadedAt` | number | 加载时间戳 |
| `tokenEstimate` | number | Token估算值 |

**安全机制**：L3加载内置路径遍历防护。`loadL3()`调用`validatePath()`验证资源路径在技能目录范围内，防止`../`等路径遍历攻击。异步版本`loadL3Async()`使用`validatePathAsync()`。

**缓存键**：L3使用复合键`skillId:resourcePath`，同一技能的不同资源文件独立缓存。

### 缓存失效策略

| 策略 | 适用层 | 实现方式 |
|------|--------|----------|
| **TTL过期** | L2/L3/路由缓存 | `Date.now() - entry.loadedAt > _cacheTTL`，查询时惰性淘汰 |
| **容量淘汰** | L2/L3/路由缓存/去重索引 | 达到`_cacheMax`时FIFO淘汰最旧条目 |
| **全量失效** | L1/L2/L3/路由缓存 | `discover()`/`discoverAsync()`时清空所有缓存 |
| **文件变更失效** | 全部 | `watchForChanges()`检测到文件变更后触发`discoverAsync()`全量重载 |
| **手动卸载** | L2 | `unloadL2(skillId)`主动移除 |

**TTL过期实现**：缓存条目存储格式为`{result, loadedAt}`。`_lookupRouteCache()`查询时检查时间戳，过期则删除并返回null。L2/L3通过`_getCachedFrom()`统一实现，过期条目同样惰性删除。

**容量淘汰实现**：`_putCache()`在写入前检查`cacheMap.size >= _cacheMax`，超出时删除Map中第一个（最旧）条目，递增对应的eviction统计。

### 缓存命中率优化

**路由缓存**：`match()`的结果按`[agent, msgHash, completedSkills, specKey, tags]`复合键缓存。消息超过200字符时截断前200字符+长度后缀作为哈希键，平衡精度与内存。

**LRU近似**：L2/L3缓存在`_getCachedFrom()`命中时执行delete+set操作，将命中条目移至Map末尾，近似LRU淘汰效果。

**统计监控**：`getLayerStats()`返回完整的缓存运行指标：

```javascript
const stats = router.getLayerStats();
// stats.l2HitRate — L2命中率
// stats.l2Evictions / l3Evictions — 淘汰次数
// stats.deduplicationSavings — 去重节省量
// stats.totalTokenSavings — Token节省总量
// stats.contextEstimate — 三层Token估算
```

**上下文Token估算**：`getContextEstimate(filterTags)`按标签过滤统计三层缓存的Token占用量，`tagSavings`字段报告标签过滤带来的Token节省百分比。

## 语义匹配算法

SkillRouter的语义匹配基于预构建的语义索引（`SEMANTIC_GROUPS`），将技能ID映射到语义关键词组，实现用户消息与技能的语义关联。

### 语义索引构建

`_buildSemanticIndex()`在构造时将硬编码的`SEMANTIC_GROUPS`转换为小写关键词映射：

```
SEMANTIC_GROUPS = {
  'tdd': ['测试驱动', '先写测试', 'red-green', 'tdd', ...],
  'architecture': ['架构', '设计', '模块划分', ...],
  'deploy': ['部署', '上线', '发布', 'deploy', ...],
  ...
}
```

当前覆盖20个语义组，涵盖TDD、架构、部署、审查、调试、测试、安全、重构、性能、头脑风暴、需求分析、深化推理、收敛检测、融合、规格、想法验证、MVP、规模化、CLI操控、调研等核心领域。

### 技能-语义关联缓存

`_buildSkillSemanticCache()`在`discover()`后构建技能ID到语义键的映射。遍历所有技能，检查`skillId`是否包含某个语义键（如`tdd-implement`包含`tdd`），建立`skillId → semanticKey`的快速查找表。

```javascript
// 缓存示例
{ 'tdd-implement': 'tdd', 'architecture-design': 'architecture', ... }
```

`_getSemanticKey(skillId)`优先查缓存，未命中时遍历语义键进行匹配。

### 匹配流程

`_semanticMatch(skillId, userMessage)`执行语义匹配：

1. 将用户消息转为小写
2. 获取技能的语义键（`_getSemanticKey()`）
3. 查找语义键对应的关键词列表
4. 逐一检查用户消息是否包含任一关键词
5. 任一命中即返回`true`

**匹配阈值**：语义匹配采用包含检测（`includes`），不做模糊匹配或相似度评分。这意味着匹配是确定性的——关键词完全包含在用户消息中即匹配成功。

### 关键词提取

`_extractKeywords(condition)`从触发条件字符串中提取关键词，采用两阶段策略：

1. **引号提取**：优先提取引号包裹的内容（支持中英文引号`""""""`），引号内容被视为精确关键词
2. **OR分割**：无引号时按`or`分割条件，每部分trim后作为独立关键词（长度1-50字符）
3. **兜底**：以上均无结果时，整个条件字符串作为关键词

### 触发条件匹配

`_matchKeywordsInConditions()`执行触发条件的关键词匹配：

1. 遍历技能的`trigger_conditions`数组
2. 对每个条件调用`_extractKeywords()`提取关键词
3. 短关键词（≤2字符）被跳过（`MIN_KEYWORD_LENGTH = 2`）
4. 检查关键词是否出现在用户消息的小写形式或原始形式中
5. 消息长度>5时，额外检查条件中的长单词（>3字符）是否出现在消息中

### 完整匹配决策链

`_checkTriggerConditions()`按以下优先级依次检查：

1. **否定模式检测**：`_isNegated()`返回true时直接拒绝
2. **关键词触发**：`_matchKeywordsInConditions()`匹配触发条件关键词
3. **语义匹配**：`_semanticMatch()`基于语义索引匹配
4. **依赖满足触发**：技能的所有`depends_on`依赖已完成
5. **自动触发**：`_checkAutoTrigger()`检查阶段关键词自动触发

## 否定模式检测

否定模式检测是SkillRouter防止错误激活技能的关键机制。当用户表达"不要执行某类操作"时，系统应避免激活对应技能。

### 否定模式定义

系统通过`NEGATION_PATTERN`正则表达式定义否定模式：

```javascript
const NEGATION_PATTERN = /不需要\s*|不要\s*|跳过\s*|不使用\s*|不用\s*|no\s+|don'?t\s+|skip\s+|without\s+|not\s+/i;
```

覆盖中英文共10种否定表达：

| 语言 | 否定词 | 示例 |
|------|--------|------|
| 中文 | 不需要、不要、跳过、不使用、不用 | "不要做代码审查" |
| 英文 | no、don't、skip、without、not | "skip the security audit" |

### 检测算法

`_isNegated(skill, userMessage)`执行三步检测：

1. **语义键查找**：通过`_getSemanticKey(skillId)`获取技能的语义组键（如`security-audit`→`security`）。无语义键的技能不会被否定检测拦截。
2. **否定词匹配**：使用`NEGATION_PATTERN`在用户消息中查找否定词位置。
3. **上下文验证**：提取否定词之后的文本（`afterNegation`），检查是否包含该语义组的任一关键词。只有否定词后紧跟相关领域关键词时才判定为否定。

**示例**：

| 用户消息 | 技能 | 结果 | 原因 |
|----------|------|------|------|
| "不要做安全审计" | security-audit | ✅否定 | "不要"后紧跟"安全审计" |
| "不需要部署" | deployment | ✅否定 | "不需要"后紧跟"部署" |
| "跳过测试阶段" | tdd-implement | ✅否定 | "跳过"后紧跟"测试" |
| "不要担心性能" | performance-optimization | ✅否定 | "不要"后紧跟"性能" |
| "安全审计很重要" | security-audit | ❌未否定 | 无否定词前缀 |

### 与正向匹配的交互

否定检测在匹配决策链中具有**最高优先级**——在`_checkTriggerConditions()`中首先执行：

```javascript
_checkTriggerConditions(skill, userMessage, completedSet) {
  if (this._isNegated(skill, userMessage)) return false;  // 一票否决
  // 后续：关键词触发 → 语义匹配 → 依赖触发 → 自动触发
}
```

即使技能满足所有正向匹配条件（关键词命中、语义匹配、依赖满足），只要否定检测通过，技能仍会被排除。这确保了用户意图的精确表达不会被误匹配覆盖。

## 内容去重机制

当多个技能包含相同或高度相似的指令段落时，内容去重机制避免重复内容被多次注入上下文，节省Token消耗。

### 去重索引构建

`_buildDeduplicationIndex(contentMap)`在`discover()`后执行，流程如下：

1. **正文提取**：对每个技能，按优先级获取Markdown正文：
   - `contentMap[skillId]`（discover时传入的原始内容）
   - `skill.body`（frontmatter解析后的body字段）
   - `skill._body`（备选body字段）
   - `parseMarkdownFile(skill._filePath)`（兜底：重新解析文件）
2. **段落分割**：按双换行符（`\n\n+`）分割正文为段落，过滤长度≤30字符的短段落
3. **规范化**：每个段落执行`trim().toLowerCase().replace(/\s+/g, ' ')`，消除空白差异
4. **哈希键生成**：取规范化文本的前`DEDUP_KEY_LENGTH`字符作为去重键
5. **冲突检测**：相同去重键被多个技能共享时，记录到`_deduplicationIndex`

### 去重索引结构

```
_deduplicationIndex: Map<string, string[]>
// 键：内容前缀哈希
// 值：共享该内容的技能ID数组
```

**容量限制**：去重索引受`_cacheMax`约束，超出时FIFO淘汰最旧条目。

### 去重统计

| 统计项 | 说明 |
|--------|------|
| `deduplicationSavings` | 累计去重节省量：`key.length × (skillIds.length - 1)` |
| `totalTokenSavings` | L2加载时的Token节省量：`rawContent.length - instructionBody.length` |

### 去重报告

`getDeduplicationReport()`返回当前去重状态：

```javascript
const report = router.getDeduplicationReport();
// report.duplicateGroups — 重复内容组数
// report.details — 前20组详细信息
//   [{ contentPreview: '前40字符...', sharedBy: ['skill-a', 'skill-b'] }, ...]
```

### 去重阈值

- **段落最小长度**：30字符（过滤标题、分隔线等短段落）
- **哈希键长度**：`DEDUP_KEY_LENGTH`（常量定义），前缀匹配策略
- **匹配策略**：前缀精确匹配，不做模糊相似度比较。相同前缀即判定为重复内容

## Skill发现流程

SkillRouter通过`discover()`（同步）和`discoverAsync()`（异步）两种方式扫描并注册技能。

### discover()同步流程

```
1. scanSkillFilesSync(skillsDir) — 扫描.harness/skills/目录下所有.md文件
2. _parseSkillFiles(files, skillsDir, parseSkillFileSync, 'discover') — 逐文件解析
   ├─ parseSkillFileSync(filePath) — 解析YAML Frontmatter
   │   └─ parseMarkdownFile(filePath) — 提取content和frontmatter
   ├─ _buildSkillFromFrontmatter(file, fm, content, filePath) — 构建技能定义
   │   ├─ buildBaseSkillEntry() — 构建L1摘要条目
   │   └─ 扩展字段：applicable_agents, trigger, auto_trigger, priority,
   │       trigger_conditions, depends_on, blocks, enforcement, category,
   │       verified, stability, usage_count, success_rate, causal_inputs/outputs/invariants,
   │       specification_required, specification_type
   └─ 错误处理：emitError('skill-load-error')
3. _applyDiscoveredSkills(parsed) — 应用发现结果
   ├─ 更新 skills, registry, _agentSets
   ├─ _buildAgentIndex() — 构建Agent→技能倒排索引
   ├─ _buildTagIndex() — 构建标签→技能倒排索引
   ├─ 清空路由缓存、L2缓存、L3缓存
   ├─ _buildSkillSemanticCache() — 构建技能-语义关联缓存
   └─ _buildDeduplicationIndex(contentMap) — 构建内容去重索引
4. 返回非基础设施技能列表
```

### discoverAsync()异步流程

与同步流程结构一致，区别在于文件扫描和解析使用异步API：

- `scanSkillFilesAsync()` → `fs.promises.access()` + `scanMarkdownDirAsync()`
- `parseSkillFileAsync()` → `parseMarkdownFileAsync()`
- `_parseSkillFilesAsync()` → 逐文件await解析

### 文件扫描策略

`scanSkillFilesSync()`/`scanSkillFilesAsync()`负责扫描技能目录：

1. 检查目录是否存在（`fs.existsSync`/`fs.promises.access`）
2. 调用`scanMarkdownDirSync()`/`scanMarkdownDirAsync()`列出所有`.md`文件
3. 目录不存在时返回`null`（非错误），触发`discover-error`事件

### 元数据提取

`buildBaseSkillEntry()`从YAML Frontmatter提取核心元数据，`_buildSkillFromFrontmatter()`在此基础上扩展完整字段：

**标签提取**（`extractTags()`，来自skill-discover-utils）综合5个来源：

| 来源 | 提取方法 | 示例 |
|------|----------|------|
| frontmatter `tags` | `parseArray(fm.tags)` | `['testing', 'ci']` |
| 技能ID | `extractTagsFromSkillName()` 按`-`/`_`分割 | `tdd-implement` → `['tdd', 'implement']` |
| 触发条件 | `extractTagsFromTriggerConditions()` 优先提取引号内容 | `"代码审查"` → `['代码审查']` |
| 适用Agent | `extractTagsFromApplicableAgents()` | `task-worker` → `['task-worker', 'task', 'worker']` |
| 阶段 | `fm.phase.toLowerCase()` | `'module-development'` |

**停用词过滤**：触发条件关键词提取时，使用`STOP_WORDS`集合过滤英文停用词（the, a, an, and等80+个），确保标签质量。

**因果字段解析**：`_parseCausalField()`支持多种输入格式——数组直接返回、对象包装为数组、字符串按逗号分割或单元素数组。

### 基础设施技能识别

`buildBaseSkillEntry()`通过两种方式识别基础设施组件：
- frontmatter包含`component_id`字段
- frontmatter的`type`为`'infrastructure'`

基础设施技能（`skill-router`、`session-start-hook`）不参与匹配，`discover()`返回时自动过滤。

## 与PhaseOrchestrator的集成

SkillRouter与PhaseOrchestrator、RBACEnforcer、TDDGate协同工作，构成框架的执行管控三角。

### 集成架构

```
用户消息 → SkillRouter.match() → 匹配技能列表
                                        ↓
                              PhaseOrchestrator阶段检查
                              ├─ 当前阶段是否允许执行该技能？
                              ├─ 阶段完成条件是否满足？
                              └─ SpecGate是否通过？
                                        ↓
                              RBACEnforcer权限检查
                              ├─ Agent角色是否有权执行？
                              └─ enforcement级别是否允许？
                                        ↓
                              TDDGate门禁检查（模块开发阶段）
                              ├─ RED-GREEN-REFACTOR检测
                              └─ 覆盖率验证
                                        ↓
                              技能执行
```

### 阶段编排交互

**阶段排序**：SkillRouter的`_phaseOrder()`定义了与PhaseOrchestrator一致的阶段顺序：

```javascript
['brainstorming', 'requirement-analysis', 'architecture-design',
 'module-development', 'integration-testing', 'deployment']
```

`match()`返回结果按阶段优先级排序——早期阶段的技能排在前面，确保执行顺序符合流程规范。

**阶段完成检查**：PhaseOrchestrator的`isPhaseComplete()`检查三个条件：
1. 所有strict技能已完成（`STRICT_SKILLS`集合定义了12个强制技能）
2. SpecGate验证通过（`registerSpecRequirement()`注册的规格已验证）
3. CausalDataBus输出就绪（所有强制技能的因果输出可用）

**阶段转换验证**：`canAdvanceToNext(completedSkills)`在阶段推进前综合检查当前阶段完成状态和SpecGate就绪状态。

**回滚验证**：`validateRollback()`计算回滚目标阶段与当前阶段之间的所有阶段，识别需要失效的已完成技能，要求人工审批。

### TDD门禁验证

在模块开发阶段，TDD门禁与Skill路由深度集成：

- `tdd-implement`和`module-development`被列入`STRICT_SKILLS`，必须在当前阶段完成
- `module-development`的`enforcement`为`strict`，不可跳过
- TDDGate在技能执行前检查RED-GREEN-REFACTOR状态
- `verification-before-completion`作为强制验证技能，确保每个模块交付物经过证据验证

### RBAC权限检查

RBACEnforcer与SkillRouter的集成通过enforcement级别实现：

| enforcement级别 | 行为 |
|-----------------|------|
| `strict` | 必须执行，不可跳过，RBAC强制检查 |
| `recommended` | 建议执行，可申请偏差审批（DeviationApproval） |
| `optional` | 可选执行，无强制约束 |

SkillRouter在`_buildSkillFromFrontmatter()`中解析`fm.enforcement`字段，默认为`'recommended'`。RBACEnforcer根据Agent角色和enforcement级别决定是否允许执行。

### 因果数据流集成

SkillRouter的因果字段（`causal_inputs`/`causal_outputs`）与PhaseOrchestrator的CausalDataBus协同：

- `_checkCausalInputs()`检查技能的必需因果输入是否已由已完成技能的因果输出提供
- PhaseOrchestrator的`isPhaseComplete()`通过CausalDataBus验证所有强制技能的因果输出可用
- 因果输入检查可被关键词触发绕过（`_hasKeywordTrigger()`），确保显式触发条件匹配时不受因果链缺失阻断

### ModuleInitializer统一初始化

`ModuleInitializer`按依赖顺序初始化核心模块，SkillRouter是第一个被初始化的模块：

```
SkillRouter → SessionManager → RBACEnforcer → PhaseOrchestrator → ...
```

初始化后，SkillRouter实例被注入到多个下游模块：
- `SkillImprovementLoop`（`attachSkillRouter()`）
- `SkillCreationEngine`（构造参数`skillRouter`）
- `SkillCurator`（构造参数`skillRouter`）
- `SkillEvolver`（构造参数`skillRouter`）
- `SkillGraph`（`attachSkillRouter()`）
- `SkillAuditTrail`（`attachSkillRouter()`）

这种统一注入模式确保所有技能子系统共享同一个SkillRouter实例，避免注册表不一致。

## 相关文档

- [架构分析-AIProject系统](../architecture/架构分析-AIProject系统.md)
- [模块详解-SkillRouter模块](../modules/模块详解-SkillRouter模块.md)
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md)

## 技能进化与跨Agent共享

### SkillEvolver — LLM驱动的技能进化

SkillEvolver（`src/runtime/skill/skill-evolver.js`）是v2.7.122新增的可选模块，提供LLM驱动的3阶段技能进化管道：

1. **总结阶段（Summarize）**：从会话轨迹中提取成功/失败模式
2. **聚合阶段（Aggregate）**：识别不变量（必须保留）和修改目标（需要改进）
3. **执行阶段（Execute）**：生成改进后的技能指令体

**安全机制**：
- 可选启用：需显式调用 `attachLlmClient()` 激活，默认不调用LLM
- Token预算约束：剩余Token<30%时跳过进化
- 审批门控：LLM生成的改进必须经过 SkillPatchApproval 审批
- 原子写入+备份：修改前自动备份到 `.harness/skills/.backups/`

### 跨Agent技能共享

SkillImprovementLoop（v2.7.122增强）支持通过CausalDataBus实现跨Agent学习经验共享：

- Agent A 执行技能后记录学习经验 → CausalDataBus 广播 `skill:learning-recorded` 事件
- Agent B 通过 `getSharedLearnings()` 获取共享经验
- `getSharedTipsForContext()` 合并本地+共享经验注入上下文
- SqliteStore 新增 `shared_learnings` 表，支持跨Agent经验持久化

### 会话轨迹自动录制

SkillCreationEngine（v2.7.122增强）新增 `attachToAgentRuntime()` 方法，可订阅AgentRuntime的 `task:completed` 和 `task:failed` 事件，自动触发技能评估和创建流程，无需显式传入executionTrace。

## v2.7.122变更记录

| 变更项 | 说明 |
|--------|------|
| **触发条件优先** | 触发条件检查优先于因果输入检查，确保显式触发条件匹配时不受因果输入缺失阻断 |
| **_hasKeywordTrigger方法** | 新增关键词触发检测方法，当用户消息命中技能关键词时绕过因果输入要求 |
| **路由缓存TTL过期** | 缓存存储格式从裸结果改为 `{result, loadedAt}`，支持基于时间戳的TTL过期淘汰 |
| **去重索引优化** | 去重索引优先使用 `skill.body`/`skill._body`，提升内容去重准确性 |
| **辅助方法提取** | 提取4个辅助方法降低主流程复杂度：`_normalizeMatchInput`（输入规范化）、`_buildRouteCacheKey`（缓存键构建）、`_lookupRouteCache`（缓存查询）、`_storeRouteCache`（缓存写入） |
| **SpecBoost** | 新增`_applySpecBoost`/`_getSpecBoost`方法，活跃规格存在时自动提升SDD相关技能优先级（+10/+5/-5三级） |
| **标签过滤** | match()新增tags参数支持，按标签交集过滤匹配候选集，新增`tagFilterSkips`统计计数 |
| **文件变更监听** | 新增`watchForChanges()`方法，支持fs.watch主策略+mtime轮询降级+access轮询最终降级三级监听 |
| **行为等价性验证** | 新增`validateBehaviorEquivalence()`方法，验证重构前后技能因果输出行为一致性 |
| **部署检查清单验证** | 新增`validateDeploymentChecklist()`方法，验证部署类技能7项必需检查清单完整性 |
