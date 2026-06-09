# 深度拆解-Skill路由全链路

> 版本：2.73.4 | 更新时间：2026-06-02

---

## 概述

Skill路由是Harness框架的核心机制之一，从用户输入到Skill激活，经历发现、匹配、验证、激活四个阶段。本文深入拆解这一全链路。

## 链路概览

```
用户输入 → SkillRouter.discover() → SkillRouter.match() → RBACEnforcer.canExecute() → Skill激活
              ↓                        ↓                      ↓
         扫描.harness/skills/     关键词/语义/否定匹配     权限验证
```

## 阶段一：Skill发现（discover）

### 执行流程

1. 扫描 `.harness/skills/` 目录下所有 `.md` 文件
2. 解析每个文件的 Front Matter 元数据
3. 构建 Skill 定义对象（skill_id, name, trigger_conditions, applicable_agents 等）
4. 建立三层缓存（L1摘要/L2指令/L3资源）
5. 构建去重索引（内容哈希 → Skill ID列表）

### 关键数据结构

```javascript
// Skill定义
{
  skill_id: 'tdd-implement',
  name: 'TDD驱动开发',
  applicable_agents: ['task-worker'],
  trigger_conditions: ['设计文档完成', '需编码实现'],
  phase: 'module-development',
  priority: 10,
  enforcement: 'strict',
  depends_on: ['architecture-design'],
  blocks: ['integration-testing']
}
```

### 缓存层级

| 层级 | 缓存内容 | TTL | 最大容量 |
|------|---------|-----|---------|
| L1 | Skill摘要（id, name, phase） | 无 | 全量 |
| L2 | Skill完整指令 | 可配置 | 可配置 |
| L3 | Skill资源文件内容 | 可配置 | 可配置 |

## 阶段二：Skill匹配（match）

### 匹配策略

1. **关键词匹配**：用户消息包含Skill的trigger_conditions关键词
2. **语义匹配**：基于SEMANTIC_GROUPS的语义等价类匹配
3. **否定模式检测**：检测用户消息中的否定词（"不需要"、"跳过"等）
4. **Agent过滤**：仅返回当前Agent可执行的Skill
5. **依赖检查**：检查Skill的前置依赖是否已完成

### 语义等价类

```javascript
const SEMANTIC_GROUPS = {
  'tdd': ['测试驱动', '先写测试', 'red-green', 'tdd'],
  'architecture': ['架构', '设计', '模块划分', 'architecture'],
  'deploy': ['部署', '上线', '发布', 'deploy'],
  // ... 更多等价类
};
```

### 匹配评分

每个匹配的Skill获得一个综合评分：

```
score = keywordScore * 0.4 + semanticScore * 0.3 + priorityScore * 0.2 + dependencyScore * 0.1
```

## 阶段三：权限验证（canExecute）

### RBAC执行流程

1. 验证Agent ID格式（AGENT_ID_PATTERN）
2. 检查Agent是否在agents定义中
3. 检查Skill是否在skills定义中
4. 检查Agent的available_skills是否包含该Skill
5. 检查Skill的enforcement级别与Agent权限是否匹配

### 执行级别

| 级别 | 说明 | 验证策略 |
|------|------|---------|
| `strict` | 强制执行 | 必须在available_skills中 |
| `recommended` | 推荐执行 | 警告但允许执行 |
| `optional` | 可选执行 | 直接允许 |

## 阶段四：Skill激活

### 激活流程

1. 检查Skill依赖是否已完成
2. 检查Skill是否被其他Skill阻塞
3. 触发 `skill:activated` 事件
4. 将Skill加入会话的completedSkills列表
5. 发布因果数据到CausalDataBus

## 性能优化

### 当前优化措施

- 三层缓存减少重复文件读取
- LRU淘汰策略控制内存使用
- 去重索引避免重复内容加载
- 否定模式短路减少无效匹配

### 优化历史

| 版本 | 优化项 | 效果 |
|------|--------|------|
| v2.5 | 引入L2/L3缓存 | 匹配延迟降低60% |
| v2.6 | 统一缓存操作方法 | 代码行数减少5行 |
| v2.72.0 | 懒加载Deepening模块导出 | 启动时间减少30% |

## 阶段一补充：发现阶段详解

### 文件扫描流程

`discover()` 的完整执行链路如下：

```
SkillRouter.discover()
  → scanSkillFilesSync(skillsDir)           // 1. 目录存在性检查 + 文件枚举
  → _parseSkillFiles(files, skillsDir)       // 2. 逐文件解析
      → parseSkillFileSync(filePath)         // 3. Front Matter提取
      → _buildSkillFromFrontmatter(...)      // 4. 构建SkillDef对象
  → _applyDiscoveredSkills(parsed)           // 5. 索引构建 + 缓存重建
```

**步骤1：目录扫描**（[skill-discover-utils.js](file:///e:/Harness_V1_0429/src/runtime/skill/skill-discover-utils.js)）

```javascript
// scanSkillFilesSync 实现
function scanSkillFilesSync(skillsDir, moduleLabel, emitter) {
  if (!fs.existsSync(skillsDir)) return null;       // 目录不存在直接返回null
  const files = scanMarkdownDirSync(skillsDir);      // 仅扫描.md文件
  return files;
}
```

| 检查项 | 处理方式 |
|--------|---------|
| 目录不存在 | 返回 `null`，discover() 返回空数组 |
| 目录为空 | 返回空数组 `[]` |
| 非 `.md` 文件 | `scanMarkdownDirSync` 自动过滤 |
| 读取权限不足 | 捕获异常，emit `discover-error` 事件 |

**步骤2：Front Matter解析**

每个 `.md` 文件经 `parseMarkdownFile()` 解析，提取 YAML Front Matter 和正文内容：

```javascript
// parseSkillFileSync 实现
function parseSkillFileSync(filePath) {
  const { content, frontmatter: fm } = parseMarkdownFile(filePath);
  return { content, fm };    // content=完整文件内容, fm=YAML对象
}
```

**步骤3：SkillDef对象构建**（[_buildSkillFromFrontmatter](file:///e:/Harness_V1_0429/src/runtime/skill/skill-router.js#L294)）

`buildBaseSkillEntry()` 先构建基础字段，再由 `_buildSkillFromFrontmatter()` 扩展完整定义：

```javascript
// buildBaseSkillEntry 核心逻辑
{
  skill_id: isInfra ? fm.component_id : (fm.skill_id || skillId),
  name: fm.name || skillId,
  summary: fm.summary || generateSkillSummary(fm, content, summaryMaxLength),
  phase: fm.phase || '',
  priority: parseInt(fm.priority, 10) || 0,
  enforcement: fm.enforcement || 'recommended',
  infrastructure: fm.component_id !== undefined || fm.type === 'infrastructure',
  tags: extractTags(file, fm),    // 综合提取标签
  _filePath: filePath,
  _fullContentLength: content.length,
}
```

### 元数据提取：标签系统

标签提取是发现阶段的核心增值环节，由 `extractTags()` 综合四个来源：

```
┌──────────────────────────────────────────────────────────────┐
│                    extractTags(file, fm)                      │
├──────────────┬──────────────┬───────────────┬────────────────┤
│  frontmatter │  skill名称   │  触发条件      │  适用Agent     │
│  fm.tags     │  按-/_分割    │  引号词优先    │  Agent名+子部  │
│              │  过滤<2字符   │  停用词过滤    │                │
└──────────────┴──────────────┴───────────────┴────────────────┘
                              ↓
                     + fm.phase（阶段标签）
                              ↓
                     Set去重 → Array输出
```

| 提取来源 | 函数 | 示例输入 | 示例输出 |
|---------|------|---------|---------|
| Front Matter `tags` | `parseArray(fm.tags)` | `['tdd', 'test']` | `['tdd', 'test']` |
| Skill名称 | `extractTagsFromSkillName` | `tdd-implement` | `['tdd', 'implement']` |
| 触发条件 | `extractTagsFromTriggerConditions` | `"测试驱动" or TDD` | `['测试驱动', 'tdd']` |
| 适用Agent | `extractTagsFromApplicableAgents` | `task-worker` | `['task-worker', 'task', 'worker']` |
| 阶段 | `fm.phase` | `module-development` | `['module-development']` |

**停用词过滤**：`extractTagsFromTriggerConditions` 使用包含70+英文停用词的 `STOP_WORDS` 集合（the, a, an, and, or, but, in, on, at...），确保仅保留有意义的标签。

### Front Matter字段映射

| Front Matter字段 | SkillDef字段 | 解析方式 | 默认值 |
|-----------------|-------------|---------|-------|
| `skill_id` / 文件名 | `skill_id` | 基础设施用 `component_id` | 文件名去 `.md` |
| `name` | `name` | 直接取值 | 同 `skill_id` |
| `summary` | `summary` | 直接取值或自动生成 | `generateSkillSummary()` |
| `applicable_agents` | `applicable_agents` | `parseArray()` | `[]` |
| `trigger_conditions` | `trigger_conditions` | `parseArray()` | `[]` |
| `depends_on` | `depends_on` | `parseArray()` | `[]` |
| `blocks` | `blocks` | `parseArray()` | `[]` |
| `priority` | `priority` | `parseInt()` | `0` |
| `enforcement` | `enforcement` | 直接取值 | `'recommended'` |
| `auto_trigger` | `auto_trigger` | 布尔转换 | `false` |
| `verified` | `verified` | 布尔转换 | `false` |
| `stability` | `stability` | 直接取值 | `'unverified'` |
| `causal_inputs` | `causal_inputs` | `_parseCausalField()` | `[]` |
| `causal_outputs` | `causal_outputs` | `_parseCausalField()` | `[]` |
| `specification_required` | `specification_required` | 布尔转换 | `false` |

`_parseCausalField()` 支持三种输入格式：数组直接返回、对象包装为单元素数组、字符串按逗号分割（支持 `[a, b]` 格式）。

## 阶段二补充：匹配算法详解

### 匹配主流程

`match()` 方法的完整执行链路：

```
match(context)
  → _normalizeMatchInput(context)           // 输入规范化 + 截断保护
  → _buildRouteCacheKey(...)                // 构建路由缓存键
  → _lookupRouteCache(cacheKey)             // 查询路由缓存
  → _findMatchingSkills(agent, msg, ...)    // 核心匹配循环
      → _checkTriggerConditions(skill, msg) // 触发条件检查
          → _isNegated(skill, msg)          //   否定模式检测（短路）
          → _matchKeywordsInConditions(...) //   关键词匹配
          → _semanticMatch(skillId, msg)    //   语义匹配
          → 依赖完成度检查                   //   全部依赖已完成
          → _checkAutoTrigger(skill, msg)   //   自动触发检测
      → _checkCausalInputs(skill, set)      // 因果输入验证
      → _hasKeywordTrigger(skill, msg)      // 关键词兜底
  → _applySpecBoost(matches, specState)     // 规格驱动提权
  → 排序（阶段优先 → priority升序）          // 结果排序
  → checkDependencies() + _enrichWithLearnings()  // 依赖标记 + 学习注入
  → _storeRouteCache(cacheKey, result)      // 写入路由缓存
```

### 关键词匹配实现

[_matchKeywordsInConditions](file:///e:/Harness_V1_0429/src/runtime/skill/skill-router.js#L632) 对每个触发条件执行两级匹配：

```javascript
// 第一级：提取关键词后精确包含匹配
for (const cond of conditions) {
  const keywords = _extractKeywords(cond);  // 提取引号词或or分词
  for (const kw of keywords) {
    if (kw.length <= 2) continue;           // 跳过过短关键词
    if (msgLower.includes(kw.toLowerCase())) return true;
  }
}

// 第二级：长消息中的单词匹配（消息长度>5时启用）
if (msgLower.length > 5) {
  const words = condLower.split(/\s+/);
  for (const word of words) {
    if (word.length > 3 && msgLower.includes(word)) return true;
  }
}
```

**关键词提取策略**（`_extractKeywords`）：

| 优先级 | 策略 | 示例条件 | 提取结果 |
|-------|------|---------|---------|
| 1 | 引号内容 | `"测试驱动" or TDD` | `['测试驱动']` |
| 2 | `or` 分词 | `先写测试 or TDD` | `['先写测试', 'TDD']` |
| 3 | 原始条件 | `编码实现` | `['编码实现']` |

### 语义匹配实现

[_semanticMatch](file:///e:/Harness_V1_0429/src/runtime/skill/skill-router.js#L691) 基于 `SEMANTIC_GROUPS` 语义等价类实现：

```javascript
_semanticMatch(skillId, userMessage) {
  const semanticKey = this._getSemanticKey(skillId);  // skill_id → 语义组键
  if (!semanticKey) return false;
  const lowerTerms = this._semanticIndex[semanticKey]; // 等价类词条
  for (const term of lowerTerms) {
    if (userMessage.toLowerCase().includes(term)) return true;
  }
  return false;
}
```

**语义键缓存**：`_buildSkillSemanticCache()` 在 `discover()` 时预构建，避免每次匹配都遍历所有语义组：

```javascript
// 缓存结构：skill_id → 语义组键
{ 'tdd-implement': 'tdd', 'architecture-design': 'architecture', ... }
```

**完整语义等价类表**：

| 语义组键 | 等价词条 |
|---------|---------|
| `tdd` | 测试驱动, 先写测试, red-green, tdd, test-driven, 测试优先 |
| `architecture` | 架构, 设计, 模块划分, 接口设计, architecture, design, structure |
| `deploy` | 部署, 上线, 发布, deploy, release, ship, publish |
| `review` | 审查, 审核, 代码评审, code review, review, inspect |
| `debug` | 调试, 排错, bug, debug, troubleshoot, fix |
| `test` | 测试, 单元测试, 集成测试, test, testing, spec |
| `security` | 安全, 漏洞, 审计, security, audit, vulnerability |
| `refactor` | 重构, 优化, refactor, restructure, clean |
| `performance` | 性能, 优化, 加速, performance, optimize, speed |
| `brainstorm` | 头脑风暴, 需求探索, brainstorm, explore, ideate |
| `requirement` | 需求分析, 需求规格, requirement, spec, analysis |
| `deepening` | 深化, 迭代精炼, 循环深化, 多轮推理, deepening, iterate, refine |
| `fusion` | 融合, 多Agent协同, 输出融合, 投票, fusion, merge, vote, cascade |
| `cli-anything` | 软件操控, CLI工具, GIMP, Blender, LibreOffice, OBS, cli-anything |
| `research` | 调研, 研究, 最佳实践, 技术方案, research, investigate, best practice |

### 否定模式检测

[_isNegated](file:///e:/Harness_V1_0429/src/runtime/skill/skill-router.js#L673) 使用正则表达式检测用户消息中的否定意图：

```javascript
const NEGATION_PATTERN = /不需要\s*|不要\s*|跳过\s*|不使用\s*|不用\s*|no\s+|don'?t\s+|skip\s+|without\s+|not\s+/i;
```

**检测逻辑**：

```
用户消息: "不需要TDD流程"
  → NEGATION_PATTERN 匹配 "不需要"
  → 截取否定词之后内容: "TDD流程"
  → 检查语义等价类: tdd → ['测试驱动', '先写测试', 'tdd', ...]
  → "TDD流程".includes('tdd') → true → 返回 true（被否定）
```

| 否定词（中文） | 否定词（英文） | 示例 |
|--------------|--------------|------|
| 不需要 | no | "不需要架构设计" / "no architecture" |
| 不要 | don't | "不要重构" / "don't refactor" |
| 跳过 | skip | "跳过测试" / "skip test" |
| 不使用 | without | "不使用安全审计" / "without security" |
| 不用 | not | "不用部署" / "not deploy" |

否定检测在 `_checkTriggerConditions` 中**优先执行**，一旦检测到否定立即返回 `false`，短路后续所有匹配逻辑。

### 自动触发机制

`_checkAutoTrigger` 根据Skill的阶段和 `auto_trigger` 标志，检测用户消息中的项目级/模块级关键词：

| 阶段 | 触发关键词 | 示例 |
|------|----------|------|
| `brainstorming` / `requirement-analysis` | 项目, 系统, project, app, application, platform | "开始一个新项目" |
| `module-development` | 新模块, 新抽象, 新依赖, 新接口, 创建模块, 添加依赖 | "需要引入新依赖" |

自动触发仅在 `auto_trigger=true` 且 `depends_on` 为空时生效，避免误触发有前置依赖的Skill。

### 规格驱动提权

`_applySpecBoost` 根据规格状态（specificationState）调整匹配结果的排序权重：

| 条件 | 提权值 | 说明 |
|------|-------|------|
| Skill的 `specification_type` 在 `activeSpecs` 中 | +5 | 激活规格匹配提权 |
| Skill的 `causal_outputs` 包含 `specification_verified` | +10 | 规格验证输出强提权 |
| Skill的 `specification_type` 在 `staleSpecs` 中 | -5 | 过时规格降权 |

### 路由缓存

`match()` 使用 `_routeCache`（Map）缓存匹配结果，避免对相同输入重复计算：

```javascript
// 缓存键构建
_buildRouteCacheKey(agent, safeMessage, safeCompleted, specificationState, safeTags) {
  const msgHash = safeMessage.length > 200
    ? safeMessage.slice(0, 200) + ':' + safeMessage.length
    : safeMessage;
  return JSON.stringify([agent, msgHash, safeCompleted, specKey, safeTags]);
}
```

| 参数 | 缓存策略 |
|------|---------|
| 消息长度 ≤ 200 | 完整消息作为键 |
| 消息长度 > 200 | 前200字符 + 长度哈希 |
| TTL | `_cacheTTL` 毫秒后过期 |
| 容量 | 达到 `_cacheMax` 时淘汰最旧条目 |

## 内容去重机制

### 去重索引构建

[_buildDeduplicationIndex](file:///e:/Harness_V1_0429/src/runtime/skill/skill-router.js#L1149) 在每次 `discover()` 时重建，检测不同Skill间的重复内容段落：

```
┌─────────────────────────────────────────────────────────────┐
│              _buildDeduplicationIndex(contentMap)            │
├─────────────────────────────────────────────────────────────┤
│  1. 遍历所有Skill，提取Markdown正文                           │
│  2. 按双换行分段，过滤 <30字符的短段落                         │
│  3. 归一化：trim + lowercase + 空格压缩                       │
│  4. 取前 DEDUP_KEY_LENGTH 字符作为哈希键                      │
│  5. 相同键的Skill ID归入同一组                                 │
│  6. 仅保留被 ≥2 个Skill共享的段落                              │
└─────────────────────────────────────────────────────────────┘
```

```javascript
// 核心逻辑
const paragraphs = body.split(/\n\n+/).filter(p => p.trim().length > 30);
for (const para of paragraphs) {
  const normalized = para.trim().toLowerCase().replace(/\s+/g, ' ');
  const key = normalized.slice(0, DEDUP_KEY_LENGTH);   // 截取前N字符作为哈希
  contentChunks.get(key).push(skill.skill_id);
}
// 仅保留重复组
for (const [key, skillIds] of contentChunks) {
  if (skillIds.length > 1) {
    this._deduplicationIndex.set(key, skillIds);
    this._stats.deduplicationSavings += key.length * (skillIds.length - 1);
  }
}
```

### 去重报告

`getDeduplicationReport()` 返回结构化的重复内容报告：

```javascript
{
  duplicateGroups: 3,    // 重复内容组数
  details: [
    {
      contentPreview: "本技能用于在代码提交前执行自动化测试...",  // 前 MAX_CONTENT_PREVIEW_LENGTH 字符
      sharedBy: ['tdd-implement', 'verification-before-completion']  // 共享该内容的Skill
    },
    // ... 最多20条
  ]
}
```

### 去重索引容量控制

| 参数 | 值 | 说明 |
|------|---|------|
| `DEDUP_KEY_LENGTH` | 常量定义 | 哈希键截取长度 |
| `_cacheMax` | 默认1000 | 去重索引最大条目数 |
| 淘汰策略 | FIFO | 达到上限时删除最早插入的键 |
| 统计指标 | `deduplicationSavings` | 累计节省的字符数 |

## Skill策展（SkillCurator）

### 架构概览

[SkillCurator](file:///e:/Harness_V1_0429/src/runtime/skill/skill-curator.js) 负责技能的全生命周期质量管理，通过使用统计驱动策展决策：

```
┌─────────────────────────────────────────────────────────────┐
│                      SkillCurator                            │
├──────────────┬──────────────┬───────────────┬───────────────┤
│  使用追踪     │  质量评估     │  生命周期管理   │  快照/回滚    │
│ recordUsage  │ runCuration  │ classifySkill │ createSnapshot│
│ getSkillStats│ dryRun       │ pinSkill      │ rollback      │
│ getAllStats  │              │ unpinSkill    │ listSnapshots │
└──────────────┴──────────────┴───────────────┴───────────────┘
```

### 使用追踪

`recordUsage()` 记录每次Skill执行的结果，维护五维统计：

```javascript
{
  calls: 0,          // 调用次数
  successes: 0,      // 成功次数
  failures: 0,       // 失败次数
  lastUsed: 0,       // 最后使用时间戳
  totalDuration: 0   // 累计执行耗时（ms）
}
```

| 容量控制 | 值 |
|---------|---|
| 最大追踪条目 | 500（`MAX_USAGE_ENTRIES`） |
| 淘汰策略 | FIFO（达到上限删除最早条目） |
| 安全过滤 | `DANGEROUS_KEYS` 集合中的ID不被追踪 |

### 质量评估算法

`runCuration()` 的核心评估逻辑：

```
对于每个Skill（跳过已钉选的）:
  1. 获取使用统计，无记录或0次调用则跳过
  2. 计算成功率 = successes / calls
  3. 获取质量阈值:
     - builtin来源: 0.15 (BUILTIN_QUALITY_THRESHOLD)
     - 其他来源:    0.3  (DEFAULT_QUALITY_THRESHOLD)
  4. 如果 成功率 < 阈值 AND 调用次数 ≥ 5:
     → emit 'skill-low-quality' 事件
  5. 如果 距上次使用 > 30天 (STALE_THRESHOLD_DAYS):
     → emit 'skill-stale' 事件
```

| 参数 | builtin | 其他来源 | 说明 |
|------|---------|---------|------|
| 质量阈值 | 15% | 30% | 内置技能容忍更低成功率 |
| 最低调用次数 | 5 | 5 | 低于5次不评估质量 |
| 过时阈值 | 30天 | 30天 | 超过未使用标记为过时 |

### 技能分类系统

| 来源类型 | 说明 | 示例 |
|---------|------|------|
| `builtin` | 框架内置技能 | tdd-implement, code-review |
| `user` | 用户自定义技能 | custom-deploy |
| `generated` | AI生成技能 | auto-doc-generation |
| `evolved` | 演化产生的技能 | 从种子技能evolveFromSeed生成 |

分类容量上限为500（`MAX_CLASSIFICATIONS`），超出时FIFO淘汰。

### 钉选保护

被钉选的Skill在策展时**完全跳过**，不会被标记为低质量或过时：

```javascript
pinSkill('tdd-implement', '核心技能，不可归档');
// 策展时: if (this.isPinned(skill.skill_id)) continue;
```

钉选容量上限为100（`MAX_PINS`）。

### 自动策展模式

| 模式 | 方法 | 触发条件 | 适用场景 |
|------|------|---------|---------|
| 定时策展 | `startAutoCuration(interval)` | 每隔1小时（默认）执行 | 持续运行的服务 |
| 智能空闲策展 | `startSmartCuration(options)` | 系统空闲时执行 | 交互式应用 |

智能空闲策展依赖 `IdleDetector` 实例的 `isIdle()` 方法判断系统状态。

### 快照与回滚

```javascript
// 创建快照
const snap = curator.createSnapshot();
// { id: 'snap_xxx', timestamp, usageEntries, pinnedCount, classificationCount, data }

// 回滚到快照
curator.rollbackToSnapshot('snap_xxx');
// 恢复 usageTracker / classifications / pins 到快照状态
```

| 参数 | 值 | 说明 |
|------|---|------|
| 最大快照数 | 10（`MAX_SNAPSHOTS_DEFAULT`） | 超出时删除最早快照 |
| 持久化路径 | `.harness/skills/.snapshots/` | JSON文件存储 |
| 持久化方式 | 异步写入（`_persistSnapshot`） | 不阻塞主流程 |

## Skill精简（SkillReducer）

### 架构概览

[SkillReducer](file:///e:/Harness_V1_0429/src/runtime/skill/skill-reducer.js) 是动态技能管理系统，实现"按需加载，用完即藏"范式。在三层缓存架构基础上，提供动态分层、Top-K选择、任务驱动激活/卸载、过载检测和注意力压缩能力。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            SkillReducer                                      │
├──────────────┬──────────────┬───────────────┬──────────────┬─────────────────┤
│  L1注册表     │  L2指令缓存   │  L3资源缓存    │  动态分层      │  任务驱动       │
│ _l1Registry  │  _l2Cache    │  _l3Cache     │ _layerIndex  │ _activeTasks    │
│ (Map)        │  (LRUCache)  │  (LRUCache)   │ (Map)        │ (Map)           │
│ +skill_layer │              │               │ core/domain  │ activate/       │
│ +trigger_kw  │              │               │ /infra       │ deactivate      │
└──────────────┴──────────────┴───────────────┴──────────────┴─────────────────┘
```

### 与SkillRouter的关键差异

| 特性 | SkillRouter | SkillReducer |
|------|------------|-------------|
| L1存储 | `this.skills` 数组 + `this.registry` 对象 | `_l1Registry` Map |
| L2/L3缓存 | 原生Map + 手动LRU淘汰 | `LRUCache` 实例 |
| 匹配方式 | 关键词 + 语义 + 否定 + 因果 + 自动触发 | 仅关键词匹配 + Top-K选择 |
| 动态分层 | 无 | core/domain/infrastructure三层 |
| 核心技能常驻 | 无 | discover后自动预加载核心技能到L2 |
| 任务驱动 | 无 | activateForTask/deactivateAfterTask |
| 过载检测 | 无 | detectOverload |
| 注意力压缩 | 无 | compressSkillSummary/getCompressedL1Entries |
| 去重索引 | `_deduplicationIndex` | 无 |
| 路由缓存 | `_routeCache` Map | 无 |
| 标签索引 | `_tagIndex` Map | 无 |
| 事件发射 | 丰富（skill-load-error等） | 更丰富（l2-hit, l2-loaded, overload-detected, skills-activated等） |

### 动态技能分层

SkillReducer将技能分为三个层级，实现差异化加载策略：

| 层级 | 常量 | 加载策略 | 说明 |
|------|------|---------|------|
| 核心层 | `SKILL_LAYER_CORE` | 常驻L2（静默预加载） | 15个核心技能，discover后自动加载 |
| 领域层 | `SKILL_LAYER_DOMAIN` | 按需加载 | 非核心非基础设施技能 |
| 基础设施层 | `SKILL_LAYER_INFRASTRUCTURE` | 排除匹配 | skill-router、session-start-hook等 |

核心技能集合定义在 `constants.js` 的 `SKILL_REDUCER_CORE_SKILL_IDS`（Set类型）。

预加载使用 `_loadL2Silent()` 方法，不递增l2Hits/l2Misses统计，避免干扰用户操作的命中率统计。

### Top-K技能选择

`matchTopK(context, k)` 从匹配结果中选择最相关的K个技能，核心技能优先占位，保持原始排序：

1. 调用 `matchL1(context)` 获取全部匹配结果（已按phase+priority排序）
2. 按原始顺序选取核心技能（最多K个）
3. 剩余槽位按原始顺序选取领域技能
4. 最终结果保持原始排序（核心和领域技能交错出现时保持相对位置）

### 任务驱动激活与自动卸载

**"按需加载，用完即藏"** 的核心执行流程：

1. **任务解析**：`activateForTask(taskSignature, context)` 自动匹配Top-K技能并加载L2
2. **执行与卸载**：`deactivateAfterTask(taskSignature, immediate)` 卸载领域技能（核心技能保留）
   - `immediate=true`：立即卸载（适用于任务失败场景）
   - `immediate=false`：延迟卸载（默认5秒，适用于任务成功场景）
3. **事件驱动**：`attachEventSource(emitter)` 监听 `task:completed`/`task:failed` 事件自动触发卸载

**竞态保护**：重复调用 `activateForTask` 同一 `taskSignature` 时，自动取消前一个任务的延迟卸载定时器并清理旧条目。

### 技能过载检测

`detectOverload(tokenBudget)` 综合评估L2缓存占用率和Token预算消耗率：

| 级别 | 条件 | 说明 |
|------|------|------|
| none | 有效比率 < overloadThreshold | 正常运行 |
| warning | 有效比率 >= overloadThreshold（默认0.7） | 建议清理缓存 |
| critical | 有效比率 >= 0.95 | 必须立即清理 |

有效比率 = max(L2缓存占用率, Token消耗率)。tokenBudget为0或未提供时仅使用L2缓存率（避免除零错误）。

### 注意力压缩

`compressSkillSummary(summary)` 将技能摘要压缩为核心关键词：

- 自动检测中英文：中文按字符级提取，英文按词级提取并过滤70+个停用词
- 压缩后最大长度40字符，超长截断加'...'
- 内部方法 `_compressSummaryInternal(summary, trackStats)` 支持控制是否递增统计计数器
- `getCompressedL1Entries()` 和 `getCompressedContextEstimate()` 使用内部版本，不虚增统计

### 触发关键词提取

[_extractTriggerKeywords](file:///e:/Harness_V1_0429/src/runtime/skill/skill-reducer.js) 从 Front Matter 提取最多15个关键词：

```javascript
_extractTriggerKeywords(fm) {
  // 1. 从 trigger_conditions 提取
  //    - 引号内容优先: "测试驱动" → ['测试驱动']
  //    - or分词: 先写测试 or TDD → ['先写测试', 'TDD']
  //    - 单词分割: 长度≥3的词

  // 2. 从 trigger 字段提取
  //    - 逗号/空格分割，长度>2的词

  return keywords.slice(0, 15);  // 最多15个
}
```

### L1匹配实现

`matchL1()` 提供简化的关键词匹配，适用于快速预筛选场景：

```javascript
matchL1(context) {
  const msgLower = userMessage.toLowerCase();
  for (const [, entry] of this._l1Registry) {
    if (entry.infrastructure) continue;
    if (agentSet && !agentSet.has(agent)) continue;
    for (const kw of entry.trigger_keywords) {
      if (kw.length < 2) continue;
      if (msgLower.includes(kw.toLowerCase())) { matched = true; break; }
    }
  }
  // 按阶段优先级 + priority排序
}
```

### 导出常量

```javascript
SkillReducer.LAYER_METADATA = 1;              // L1: 技能元数据
SkillReducer.LAYER_INSTRUCTION = 2;            // L2: 技能指令
SkillReducer.LAYER_RESOURCES = 3;              // L3: 技能资源
SkillReducer.SKILL_LAYER_CORE = 'core';        // 核心层
SkillReducer.SKILL_LAYER_DOMAIN = 'domain';    // 领域层
SkillReducer.SKILL_LAYER_INFRASTRUCTURE = 'infrastructure'; // 基础设施层
SkillReducer.DEFAULT_TOP_K = 3;                // Top-K默认值
SkillReducer.DEFAULT_OVERLOAD_THRESHOLD = 0.7;  // 过载阈值
SkillReducer.DEFAULT_COMPRESSED_SUMMARY_MAX_LENGTH = 40; // 压缩摘要最大长度
SkillReducer.DEFAULT_AUTO_UNLOAD_DELAY_MS = 5000;       // 自动卸载延迟
```

### 集成架构与已知问题

SkillReducer 与其他子系统的集成架构：

```
ModuleInitializer ──创建──→ SkillReducer ──discover()──→ L1/L2/L3缓存
       │                         │
       │                         ├── attachModule('reducer') ──→ SkillObservability
       │                         │
       │                         ├── 9个事件桥接 ──→ EventRegistrar ──→ WebSocket/Dashboard
       │                         │
       │                         ├── isHealthy() ──→ HealthRegistrar
       │                         │
       └──创建──→ SkillRouter ──attachSkillReducer()──→ 桥接（预留接口）
```

**已修复的集成问题**：

| 问题 | 修复 | 影响 |
|------|------|------|
| SkillObservability VALID_MODULE_NAMES 缺少 'reducer' | 已添加 | SkillReducer 指标可被可观察性系统收集 |
| EventRegistrar 仅注册3/10个事件 | 已扩展到9个 | 过载检测、任务激活等关键事件可通过Dashboard感知 |
| discover/discoverAsync 未清理旧任务状态 | 已添加 `_clearActiveTasks()` | re-discover时不会残留旧任务的延迟卸载定时器 |
| loadL3Async 双重 l3Misses 递增 | 已移除重复统计 | L3命中率统计准确 |
| _putL2Cache/_putL3Cache 更新已存在key时误计淘汰 | 已区分新增/更新 | l2Evictions/l3Evictions统计准确 |

**已知架构问题（需后续迭代解决）**：

1. **双重 discover() 调用**：ModuleInitializer 的 SIMPLE_MODULES postInit 和 _initSubsystems 均调用 discover()，导致技能文件被重复扫描。建议移除其中一个。
2. **SkillRouter 与 SkillReducer 双套缓存**：两者各自维护独立的三层缓存，同一技能文件可能被两边同时缓存。建议通过 `attachSkillReducer()` 桥接后共享缓存。
3. **Dashboard 展示不完整**：`_getSkillLayerStats()` 仅调用 SkillRouter 的 `getLayerStats()`，SkillReducer 的层级分布、过载检测、任务激活等指标不可见。建议增加 `/api/skill-reducer/stats` 端点。

## Skill树DAG（SkillTreeDAG）

### 架构概览

[SkillTreeDAG](file:///e:/Harness_V1_0429/src/runtime/skill/skill-tree-dag.js) 以有向无环图管理Skill间的依赖关系，支持拓扑排序执行和循环依赖检测：

```
┌──────────────────────────────────────────────────────────┐
│                    SkillTreeDAG                           │
├──────────────┬──────────────┬───────────────┬────────────┤
│  节点管理     │  依赖管理     │  图查询        │  种子演化   │
│  addNode     │  addDependency│ getRoots     │ evolveFrom │
│  removeNode  │              │ getLeaves    │ Seed       │
│  getNode     │              │ getSubtree   │            │
│              │              │ getDependents│            │
└──────────────┴──────────────┴───────────────┴────────────┘
```

### 节点数据结构

```javascript
{
  id: 'tdd-implement',       // 技能ID
  category: 'core',          // 分类（默认'general'）
  level: 3,                  // 层级（自动计算）
  status: 'active',          // 状态
  seed: false,               // 是否种子技能
  createdAt: 1715385600000,  // 创建时间
  updatedAt: 1715385600000,  // 更新时间
}
```

### 依赖图构建

`addDependency(skillId, dependsOnId)` 添加依赖边时执行三重检查：

```
addDependency('integration-testing', 'tdd-implement')
  1. 节点存在性检查: 两个节点都必须已存在
  2. 循环依赖检测:  _wouldCreateCycle(skillId, dependsOnId)
  3. 子节点上限检查: deps.length < maxChildren (默认20)
  4. 层级传播:       node.level = max(node.level, depNode.level + 1)
                    → _propagateLevel(skillId)  递归更新下游
```

### 循环依赖检测

[_wouldCreateCycle](file:///e:/Harness_V1_0429/src/runtime/skill/skill-tree-dag.js#L113) 使用DFS从被依赖节点出发，检查是否能到达依赖方：

```javascript
_wouldCreateCycle(skillId, dependsOnId) {
  if (skillId === dependsOnId) return true;    // 自环检测
  const visited = new Set();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === skillId) return true;      // 发现环路
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of this._edges.get(current) ?? []) stack.push(dep);
  }
  return false;
}
```

检测到循环时 emit `cycle-detected` 事件，并拒绝添加该依赖边。

### 拓扑排序

[getExecutionOrder](file:///e:/Harness_V1_0429/src/runtime/skill/skill-tree-dag.js#L154) 使用DFS三色标记法实现拓扑排序：

```javascript
getExecutionOrder() {
  const visited = new Set();    // 已完成节点（黑色）
  const visiting = new Set();   // 正在访问节点（灰色）
  const order = [];             // 拓扑序列
  const cyclicNodes = [];       // 检测到的环环节点

  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {     // 灰色节点→发现环
      cyclicNodes.push(id);
      return;
    }
    visiting.add(id);
    for (const dep of this.getDependencies(id)) visit(dep);
    visiting.delete(id);
    visited.add(id);
    order.push(id);             // 后序插入=拓扑序
  };

  for (const id of this._nodes.keys()) visit(id);
  return { order, cyclicNodes, hasCycle: cyclicNodes.length > 0 };
}
```

| 返回字段 | 类型 | 说明 |
|---------|------|------|
| `order` | `string[]` | 拓扑排序结果（依赖在前） |
| `cyclicNodes` | `string[]` | 参与循环的节点列表 |
| `hasCycle` | `boolean` | 是否存在循环依赖 |

### 图查询API

| 方法 | 返回 | 说明 |
|------|------|------|
| `getRoots()` | `string[]` | 无依赖的根节点 |
| `getLeaves()` | `string[]` | 无被依赖的叶节点 |
| `getSubtree(id)` | `string[]` | 包含自身及所有直接/间接依赖方的子树 |
| `getDependencies(id)` | `string[]` | 直接依赖列表 |
| `getDependents(id)` | `string[]` | 直接被依赖列表 |
| `getSeedSkills()` | `Object[]` | 所有种子技能节点 |
| `getDepth()` | `number` | DAG最大深度 |
| `getNodeCount()` | `number` | 节点总数 |
| `getEdgeCount()` | `number` | 边总数 |

### 种子技能演化

`evolveFromSeed()` 从种子技能派生新技能，自动建立依赖关系：

```javascript
const newNode = dag.evolveFromSeed('tdd-implement', 'tdd-implement-v2', {
  category: 'core',
  status: 'experimental'
});
// 自动: addNode('tdd-implement-v2', { level: seed.level+1, seed: false })
// 自动: addDependency('tdd-implement-v2', 'tdd-implement')
```

### 容量限制

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `maxDepth` | 10 | DAG最大深度 |
| `maxChildren` | 20 | 单节点最大依赖数 |
| `maxNodes` | 200 | 最大节点数 |
| `maxEdges` | 1000 | 最大边数 |

## 懒加载机制（v2.72.0）

### DeepeningModuleRegistry 三层懒加载

v2.72.0 引入 [DeepeningModuleRegistry](file:///e:/Harness_V1_0429/src/runtime/deepening/deepening-module-registry.js) 实现深化子系统的分层懒加载，将50+子模块按重要性分为三个层级：

```
┌─────────────────────────────────────────────────────────────┐
│              DeepeningModuleRegistry                         │
├──────────────┬──────────────┬───────────────┬───────────────┤
│  CORE层       │ INFRA层      │ ADVANCED层     │              │
│  启动时加载    │ standard时   │ deep时加载     │              │
│  (quick)     │ 加载         │               │              │
├──────────────┼──────────────┼───────────────┤              │
│ 调度器        │ 缓存         │ 审计追踪       │              │
│ 控制器        │ 熔断器       │ 背压管理       │              │
│ 路由器        │ 连接池       │ 基准测试       │              │
│ 融合器        │ 限流器       │ 可视化         │              │
│ ...          │ ...          │ ...           │              │
└──────────────┴──────────────┴───────────────┴───────────────┘
```

### 深度感知加载

```javascript
loadForDepth(level) {
  if (level === 'quick')     return this._loadTier('core', level);
  if (level === 'standard')  return this._loadTier('infrastructure', level);
  return this._loadTier('advanced', level);
}
```

| 深度级别 | 加载层级 | 适用场景 |
|---------|---------|---------|
| `quick` | CORE | 简单任务，快速响应 |
| `standard` | CORE + INFRASTRUCTURE | 常规任务，标准推理 |
| 其他 | CORE + INFRASTRUCTURE + ADVANCED | 复杂任务，深度推理 |

### 懒加载实现

```javascript
get(name) {
  if (!MODULE_DEFS[name]) return null;           // 模块未定义
  if (this._instances.has(name)) return this._instances.get(name);  // 已加载
  // 首次访问时才 require()
  const mod = require(MODULE_DEFS[name].path);
  const Cls = mod.default || mod;
  const inst = typeof Cls === 'function' ? new Cls({}) : Cls;
  this._instances.set(name, inst);
  this._lazyLoads++;
  return inst;
}
```

**关键设计**：模块定义（`MODULE_DEFS`）在启动时即加载（仅包含路径字符串），但模块实例的 `require()` 和实例化延迟到首次 `get()` 调用时执行。

### 废弃警告

已废弃模块首次访问时自动发出替代提示：

```javascript
if (MODULE_DEFS[name].deprecated && !this._deprecationWarned.has(name)) {
  this._deprecationWarned.add(name);
  this.emit('deprecation-warning', { module: name, replacement: MODULE_DEFS[name].replacement });
}
```

### 性能收益

| 指标 | 优化前 | 优化后 | 提升 |
|------|-------|-------|------|
| 启动时间 | 全量加载50+模块 | 仅加载CORE层 | 减少30% |
| 内存占用 | 所有模块实例常驻 | 按需实例化 | 显著降低 |
| 首次匹配延迟 | 无差异 | 无差异 | 懒加载对热路径无影响 |

## 缓存一致性

### discover() 导致的缓存失效

`_applyDiscoveredSkills()` 在每次 `discover()` 时**完全重建**所有缓存和索引：

```javascript
_applyDiscoveredSkills({ newSkills, newRegistry, newAgentSets, contentMap }) {
  this.skills = newSkills;                        // 替换Skill列表
  this.registry = newRegistry;                    // 替换注册表
  this._agentSets = newAgentSets;                 // 替换Agent集合
  this._agentIndex = this._buildAgentIndex(newSkills);    // 重建Agent索引
  this._tagIndex = this._buildTagIndex(newSkills);        // 重建标签索引
  this._routeCache = null;                        // 清空路由缓存
  this._l2Cache.clear();                          // 清空L2指令缓存
  this._l3Cache.clear();                          // 清空L3资源缓存
  this._skillSemanticCache = this._buildSkillSemanticCache();  // 重建语义缓存
  this._buildDeduplicationIndex(contentMap);      // 重建去重索引
  return this.skills.filter(s => !s.infrastructure);
}
```

### 缓存重建流程图

```
discover() 触发
       ↓
┌──────────────────────────────────────────────────┐
│              缓存失效与重建                        │
├──────────────────┬───────────────────────────────┤
│  立即清空          │  重建                         │
├──────────────────┼───────────────────────────────┤
│  _routeCache=null │  _agentIndex (Agent→Skill[]) │
│  _l2Cache.clear() │  _tagIndex (Tag→Skill[])     │
│  _l3Cache.clear() │  _skillSemanticCache         │
│                   │  _deduplicationIndex          │
└──────────────────┴───────────────────────────────┘
       ↓
后续 match() / loadL2() / loadL3() 调用
将按需重新填充各层缓存
```

### 文件变更监听与自动重载

`watchForChanges()` 提供三级降级的文件监听机制：

| 优先级 | 机制 | 实现 | 说明 |
|-------|------|------|------|
| 1 | `fs.watch` | 原生文件系统事件 | 最高效，但某些平台不可靠 |
| 2 | mtime轮询 | `_startMtimeFallbackPolling` | 检测文件修改时间变化 |
| 3 | access轮询 | `_startAccessFallbackPolling` | 仅检测目录可访问性 |

```javascript
// fs.watch 失败时自动降级
this._watcher = fs.watch(skillsDir, onChange);
this._watcher.on('error', function(err) {
  // 降级到mtime轮询
  self._watcher = self._startMtimeFallbackPolling(skillsDir, interval);
});
```

**防抖机制**：文件变更事件经 `DEFAULT_PERSIST_DEBOUNCE_MS` 防抖后触发 `discoverAsync()`，避免短时间内多次重载。

### RBACEnforcer热重载

[RBACEnforcer](file:///e:/Harness_V1_0429/src/permission/rbac-enforcer.js) 的热重载包含额外的安全保护：

```javascript
_hotReload(eventType, filename) {
  // 1. 冷却检查: 距上次重载 < RELOAD_COOLDOWN_MS 则延迟
  if (now - this._lastReloadAt < RELOAD_COOLDOWN_MS) {
    this._scheduleReload(eventType, filename);
    return;
  }
  // 2. 重载计数: 超过100次则暂停监听30秒
  if (this._reloadCount > MAX_RELOAD_COUNT) {
    this.stopWatching();
    setTimeout(() => this.startWatching(), COOLDOWN_MS);  // 30秒后恢复
    return;
  }
  // 3. 原子替换: 仅在无错误时替换数据
  if (this._loadErrors.length === 0) {
    this.agents = newAgents;
    this._agentSkillSets = newAgentSkillSets;
    this.skills = newSkills;
  }
}
```

| 保护机制 | 参数 | 说明 |
|---------|------|------|
| 重载防抖 | `RELOAD_DEBOUNCE_MS = 1000ms` | 短时间内多次变更合并为一次 |
| 重载冷却 | `DEFAULT_MIN_HEARTBEAT_MS` | 两次重载间最小间隔 |
| 重载计数 | `MAX_RELOAD_COUNT = 100` | 单次会话最大重载次数 |
| 冷却期 | `COOLDOWN_MS = 30000ms` | 超限后暂停监听的时长 |
| 错误保护 | `_loadErrors` | 加载出错时保留旧数据不替换 |

### 缓存统计监控

`getLayerStats()` 提供完整的缓存运行指标：

```javascript
{
  l1Count: 42,           // L1已注册技能数
  l2Cached: 5,           // L2缓存条目数
  l3Cached: 2,           // L3缓存条目数
  l2Hits: 120,           // L2命中次数
  l2Misses: 30,          // L2未命中次数
  l2HitRate: 0.8,        // L2命中率
  l3Hits: 15,            // L3命中次数
  l3Misses: 5,           // L3未命中次数
  l2Evictions: 3,        // L2淘汰次数
  l3Evictions: 1,        // L3淘汰次数
  deduplicationSavings: 2048,  // 去重节省字符数
  totalTokenSavings: 15000,    // 总Token节省量
  tagFilterSkips: 8,          // 标签过滤跳过次数
  contextEstimate: { ... }     // 上下文Token估算
}
```

## 相关文档

- [模块详解-SkillRouter模块](../modules/模块详解-SkillRouter模块.md)
- [模块详解-RBACEnforcer模块](../modules/模块详解-RBACEnforcer模块.md)
- [核心功能-Skill自动路由机制](../core/核心功能-Skill自动路由机制.md)
