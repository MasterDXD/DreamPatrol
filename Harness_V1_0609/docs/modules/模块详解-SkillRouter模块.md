# 模块详解-SkillRouter模块

> 版本：2.73.4 | 文件：src/runtime/skill/skill-router.js | 行数：~1200行

---

## 模块定位

SkillRouter是运行时引擎的核心路由组件，负责Skill的自动发现、匹配和激活。

## 类定义

```javascript
class SkillRouter extends EventEmitter {
  constructor(projectRoot, options)
  discover()
  discoverAsync()
  match(context)
  getSkill(skillId)
  resolveConflict(matches)
  checkDependencies(skillId, completedSkills)
  attachSkillImprover(improver)
  attachSkillReducer(reducer)
  matchTopK(context, k?)
  loadL2(skillId)
  loadL2Async(skillId)
  unloadL2(skillId)
  loadL3(skillId, resourcePath)
  loadL3Async(skillId, resourcePath)
  watchForChanges(interval)
  isHealthy()
  shutdown() // via withShutdown mixin
  validateBehaviorEquivalence(skillId, beforeContext, afterContext)
  validateDeploymentChecklist(skillId, checklistData)
  preloadL2(skillIds)
  getContextEstimate(filterTags)
  getLayerStats()
  getVerifiedSkills()
  getSkillsByStability(stability)
  getSkillsByTag(tag)
  getAllTags()
  getDeduplicationReport()
}
```

## 核心属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `projectRoot` | string | 项目根目录 |
| `skills` | Array | 已发现的Skill定义 |
| `_routeCache` | Map\<string, {result, loadedAt}\> | 路由结果缓存。存储`{result, loadedAt}`对象，支持TTL过期淘汰（v2.7.122变更） |
| `negationPatterns` | RegExp | 否定模式（NEGATION_PATTERN常量） |

## 方法详解

### validateBehaviorEquivalence(skillId, beforeContext, afterContext)

验证技能行为等价性。比较技能执行前后的上下文快照，检测行为变化。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `skillId` | string | 技能标识 |
| `beforeContext` | Object | 执行前状态快照 |
| `afterContext` | Object | 执行后状态快照 |

**返回：** `{ valid: boolean, skillId?: string, checks?: Array<{key, changed}>, summary?: string, reason?: string }`

**逻辑：** 查找技能的 `causal_outputs` 中 `behavior-equivalence-report` 或 `refactored-code` 输出，逐键比较 `beforeContext` 和 `afterContext`（跳过 `timestamp`），使用 `stableStringify` 进行深度比较。

---

### validateDeploymentChecklist(skillId, checklistData)

验证部署检查清单。检查部署技能的7项必需检查项是否全部通过。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `skillId` | string | 技能标识 |
| `checklistData` | Object | 检查项名→true/'true'映射 |

**返回：** `{ valid: boolean, skillId?: string, checkedItems?: string[], missingItems?: string[], completionRate?: number, summary?: string, reason?: string }`

**7项必需检查项：** `all-tests-passed`, `code-merged-to-shared`, `environment-config-verified`, `rollback-plan-ready`, `health-check-passed`, `smoke-test-passed`, `monitoring-configured`

---

### preloadL2(skillIds)

批量预加载L2缓存。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `skillIds` | string[] | 技能ID列表 |

**返回：** `string[]` — 成功加载的技能ID列表

---

### getContextEstimate(filterTags)

估算上下文Token消耗。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `filterTags` | string[] | 可选标签过滤 |

**返回：** `{ l1Tokens, l2Tokens, l3Tokens, totalTokens, tagSavings: { skippedCount, skippedTokens, savingsPercent } }`

---

### getLayerStats()

获取三层缓存综合统计。

**返回：** `{ l1Count, l2Cached, l3Cached, l2Hits, l2Misses, l2HitRate, l3Hits, l3Misses, l2Evictions, l3Evictions, deduplicationSavings, totalTokenSavings, tagFilterSkips, contextEstimate }`

---

### getVerifiedSkills()

获取已验证技能列表。

**返回：** `SkillDef[]` — `verified === true` 的技能

---

### getSkillsByStability(stability)

按稳定性级别筛选技能。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `stability` | string | 稳定性级别：`'unverified'` / `'stable'` / `'experimental'` |

**返回：** `SkillDef[]`

---

### getSkillsByTag(tag)

按标签筛选技能。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `tag` | string | 标签名（大小写不敏感） |

**返回：** `SkillDef[]` — 排除基础设施技能

---

### getAllTags()

获取所有标签及使用计数。

**返回：** `Map<string, number>` — 标签→技能数

---

### getDeduplicationReport()

获取内容去重报告。

**返回：** `{ duplicateGroups: number, details: Array<{contentPreview, sharedBy}> }` — 最多20条

---

---

### _findMatchingSkills(agent, safeMessage, completedSet, filterTags)

内部匹配核心方法。遍历候选技能列表，按条件筛选匹配的技能。

**v2.7.122执行顺序变更：** 触发条件（trigger_conditions）在因果输入（causal_inputs）之前检查。因果输入仅在无关键词触发匹配时才强制执行——即当技能的`trigger_conditions`中包含与用户消息直接匹配的关键词时，可绕过必需因果输入的约束。

**筛选逻辑：**
1. 跳过基础设施技能
2. 按Agent角色过滤
3. 按标签过滤（可选）
4. 检查触发条件（`_checkTriggerConditions`）
5. 检查因果输入（`_checkCausalInputs`），若关键词触发匹配则跳过

---

### _hasKeywordTrigger(skill, userMessage)

检查技能的`trigger_conditions`是否包含与用户消息的关键词匹配。当存在直接关键词触发时，可绕过必需因果输入的约束。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `skill` | SkillDef | 技能定义 |
| `userMessage` | string | 用户消息文本 |

**返回：** `boolean` — 是否存在关键词触发匹配

**逻辑：** 委托`_matchKeywordsInConditions(skill.trigger_conditions, userMessage.toLowerCase(), userMessage)`，对`trigger_conditions`中的每个条件提取关键词并与用户消息进行匹配。

---

### _normalizeMatchInput(context)

规范化匹配输入上下文。从原始`context`对象中提取并校验各字段，确保类型安全。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | MatchContext | 原始匹配上下文 |

**返回：** `{ safeMessage, agent, safeCompleted, safeTags, specificationState } | null`

**逻辑：**
- `safeMessage`：截断至`MAX_MESSAGE_LENGTH`（10000字符）
- `safeCompleted`：确保为有效数组
- `safeTags`：标签统一转小写
- `specificationState`：提取规格状态，默认空结构

---

### _buildRouteCacheKey(agent, safeMessage, safeCompleted, specificationState, safeTags)

构建路由缓存键。将匹配参数序列化为唯一字符串用于缓存查找。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `agent` | string | Agent角色ID |
| `safeMessage` | string | 已规范化的用户消息 |
| `safeCompleted` | string[] | 已完成的技能列表 |
| `specificationState` | Object | 规格状态 |
| `safeTags` | string[] | 已规范化的标签列表 |

**返回：** `string` — 序列化的缓存键

**逻辑：** 对消息超过200字符时使用前200字符+长度作为哈希摘要；规格状态仅取`activeSpecs`和`staleSpecs`参与键构建。

---

### _lookupRouteCache(cacheKey)

查找路由缓存。支持TTL过期检测，过期条目自动删除。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `cacheKey` | string | 缓存键 |

**返回：** `SkillDef[] | null` — 缓存命中返回结果数组，未命中或过期返回`null`

**逻辑：** 从`_routeCache`中取出`{result, loadedAt}`对象，检查`Date.now() - loadedAt <= _cacheTTL`，过期则删除。

---

### _storeRouteCache(cacheKey, result)

存储路由结果到缓存。存储格式为`{result, loadedAt}`对象，支持容量上限淘汰（FIFO）。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `cacheKey` | string | 缓存键 |
| `result` | SkillDef[] | 路由结果数组 |

**逻辑：** 若`_routeCache`未初始化则创建；容量达到`_cacheMax`时淘汰最早条目；存储`{result, loadedAt: Date.now()}`。

---

### _buildDeduplicationIndex(contentMap)

构建内容去重索引。扫描所有技能的内容段落，检测重复内容。

**v2.7.122变更：** 内容获取优先级调整为 `contentMap[skill.skill_id]` → `skill.body` → `skill._body` → `parseMarkdownFile(skill._filePath)`，优先使用技能对象上已缓存的`body`/`_body`属性，避免重复文件解析。

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `contentMap` | Object | 技能ID→原始文件内容的映射 |

**逻辑：**
1. 遍历所有技能，按优先级获取内容主体
2. 按双换行分段，过滤长度≤30字符的段落
3. 段落归一化（trim + lowercase + 空白合并）后取前`DEDUP_KEY_LENGTH`字符作为键
4. 相同键被多个技能共享时记入`_deduplicationIndex`

---

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `skill:matched` | Skill匹配成功 | { skillId, matchScore } |
| `skill:activated` | Skill被激活 | { skillId, agent } |
| `cache:invalidated` | 缓存失效 | { level } |

## 依赖关系

- 依赖：`../utils/constants.js`（Front Matter解析）
- 依赖：`../utils/debug-logger.js`（调试日志）
- 被依赖：`src/index.js`（主入口装配）

## 解析行为

### 空指令体跳过

`_parseSkillFiles` 和 `_parseSkillFilesWith` 在解析 Skill 文件时，会跳过指令体（即 Front Matter 之后的 Markdown 正文）为空的文件。当解析结果中指令体为空字符串或仅包含空白字符时，该 Skill 不会被加入 `skills` 列表，避免无实际指令内容的 Skill 参与路由匹配。

## 安全机制

1. **路径遍历防护**：L3资源加载时验证路径在项目目录内
2. **符号链接检测**：检测并拒绝符号链接指向项目外
3. **文件大小限制**：MAX_FILE_SIZE = 1MB

## 相关文档

- [核心功能-Skill自动路由机制](../core/核心功能-Skill自动路由机制.md)
- [深度拆解-任务调度执行链路](../deep-dive/深度拆解-任务调度执行链路.md)

---

## v2.7.122变更记录

> Round 13变更，基于skill-router.js源码更新

### 新增方法

| 方法 | 说明 |
|------|------|
| `_hasKeywordTrigger(skill, userMessage)` | 检查技能的`trigger_conditions`是否包含与用户消息的关键词匹配，用于在存在直接关键词触发时绕过必需因果输入约束 |
| `_normalizeMatchInput(context)` | 从`match()`中提取的输入规范化辅助方法，校验并截断用户消息、完成技能列表、标签等字段 |
| `_buildRouteCacheKey(agent, safeMessage, safeCompleted, specificationState, safeTags)` | 从`match()`中提取的缓存键构建辅助方法，序列化匹配参数为唯一字符串 |
| `_lookupRouteCache(cacheKey)` | 从`match()`中提取的缓存查找辅助方法，支持TTL过期检测和自动清理 |
| `_storeRouteCache(cacheKey, result)` | 从`match()`中提取的缓存存储辅助方法，存储`{result, loadedAt}`对象并支持容量淘汰 |

### 行为变更

1. **`_findMatchingSkills`执行顺序调整**：触发条件（trigger_conditions）现在在因果输入（causal_inputs）之前检查。因果输入仅在无关键词触发匹配时才强制执行，即`_hasKeywordTrigger`返回`true`时可绕过`_checkCausalInputs`的约束
2. **`_routeCache`存储格式变更**：从直接存储路由结果数组改为存储`{result, loadedAt}`对象，支持基于TTL的过期淘汰机制
3. **`_buildDeduplicationIndex`内容获取优先级调整**：新增`skill.body`和`skill._body`作为内容获取的优先来源，避免对已缓存内容的重复文件解析

### 重构

- `match()`方法中的输入规范化、缓存键构建、缓存查找、缓存存储逻辑提取为独立辅助方法，降低方法复杂度
