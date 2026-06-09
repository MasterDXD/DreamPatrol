---
skill_id: opportunity-discovery
name: 机会发现管线
phase: brainstorming
priority: 0
enforcement: strict
stability: beta
applicable_agents:
  - domain-analyst
  - task-worker
auto_trigger: true
slash_command: /discover-opportunities
tool_reference: opportunity-discovery-pipeline
dependencies:
  - web-interaction
  - data-collect
  - ai-research
trigger: auto
trigger_conditions: []
triggers:
  - 用户需要发现市场机会或产品方向
  - 用户需要从用户抱怨中提取需求
  - 用户需要竞品差评分析或空隙识别
  - 用户需要评估技术红利窗口
  - 用户提到"机会"、"痛点扫描"、"竞品空隙"、"技术红利"、"Product Lens"
  - brainstorming阶段需要数据驱动的方向发现
verified: true
---

## 目标

通过三条猎人路径（痛苦扫描/竞品空隙/技术红利）和Product Lens三问，从多平台用户抱怨中系统化发现真实痛点，识别竞品空隙和技术红利窗口，为产品方向决策提供数据支撑。

# 机会发现管线技能

## 适用性决策

### 适合使用（4种场景）
1. 需要从多平台用户抱怨中系统化发现真实痛点
2. 需要竞品差评+Feature Request数据支撑空隙识别
3. 需要评估新技术/新协议的edge case应用机会
4. brainstorming阶段需要数据驱动的方向发现，而非拍脑袋决策

### 不适合使用（4种场景）
1. 方向已明确，只需执行实现（→ tdd-implement）
2. 纯技术选型问题（→ ai-research）
3. 已有需求规格，只需形式化（→ requirement-analysis）
4. 代码级必要性判断（→ necessity-review）

## 三条猎人路径

### 路径1：痛苦扫描
**核心逻辑**：从Reddit/HN/V2EX等平台搜索用户抱怨，"哪里有抱怨哪里就有需求"

**执行步骤**：
1. **平台选择**：根据目标用户群体选择扫描平台
   - 海外开发者：Reddit（r/programming, r/webdev, r/SideProject）、Hacker News、ProductHunt
   - 国内用户：V2EX、小红书、知乎、即刻
   - 行业垂直：GitHub Issues/Discussions、Stack Overflow、Discord社区
2. **关键词扫描**：使用 data-collect 技能采集含以下模式的帖子
   - 抱怨模式："为什么 X 不能..."、"X 太烂了"、"求替代"、"忍不了"
   - 需求模式："有没有工具能..."、"希望能..."、"如果 X 能做 Y 就好了"
   - 痛苦模式："每次做 X 都要..."、"X 浪费了我太多时间"
3. **痛点提取**：从采集数据中提取结构化痛点
   - 去重：相似抱怨合并为同一痛点
   - 计频：统计同一痛点的出现次数
   - 分级：must-have > nice-to-have > vitamin
4. **机会识别**：将痛点转化为方向假设
   - 高频+未解决 = 强机会
   - 高频+已有解决方案但用户仍抱怨 = 体验优化机会
   - 低频+深度痛苦 = 垂直领域机会

**依赖技能**：data-collect（平台数据采集）、web-interaction（浏览器交互）

### 路径2：竞品空隙
**核心逻辑**：分析成熟产品差评区+FeatureRequest，做更轻量更垂直的替代

**执行步骤**：
1. **竞品识别**：列出目标领域的直接竞品和间接竞品
2. **差评区分析**：使用 data-collect 技能采集竞品差评
   - 采集维度：评分≤3星评论、高频负面关键词、用户流失原因
   - 提取模式：功能缺失、体验糟糕、价格过高、学习成本高
3. **Feature Request聚合**：采集竞品的高票功能请求
   - 采集维度：投票数>100的请求、官方标记"planned"但超1年未实现的请求
   - 分类模式：用户最想要但竞品拖延不做的功能
4. **空隙矩阵**：构建竞品-功能矩阵
   - 横轴：用户核心需求（从差评和Feature Request中提取）
   - 纵轴：竞品产品
   - 填充：每格标注竞品对该需求的满足程度（✓/◐/✗）
   - 空隙：✗最多的列 = 最大市场空白

**依赖技能**：data-collect（差评/Feature Request采集）、idea-validation（竞争格局验证）

### 路径3：技术红利
**核心逻辑**：新开源模型/新协议的edge case，新技术+旧场景=新机会

**执行步骤**：
1. **技术信号扫描**：关注以下来源
   - 新开源模型发布（GitHub Trending、HuggingFace新模型）
   - 新协议/新标准（W3C、IETF草案）
   - API更新（主要平台API changelog）
2. **Edge Case发现**：寻找新技术的边缘应用场景
   - 模式：新技术 + 旧场景 = 新机会
   - 示例：LLM + 客服 = AI客服、WebRTC + 教育 = 在线课堂
3. **窗口期判断**：评估技术红利的时效性
   - 早期（0-6个月）：先发优势大，但技术不成熟
   - 成长期（6-18个月）：最佳窗口，技术稳定+市场未饱和
   - 成熟期（18个月+）：红利消退，需差异化竞争

**依赖技能**：ai-research（技术调研）、web-interaction（技术社区监控）

## Product Lens 三问

完成猎人路径后，对每个方向假设进行三问过滤：

### 第1问：给谁用？
**目标**：构建目标用户画像，而非泛泛描述

**产出**：
- 核心用户：最痛、最可能付费的用户群体（1-2个细分）
- 用户画像：人口统计 + 行为特征 + 使用场景 + 决策链路
- 用户分层：核心用户 / 边缘用户 / 潜在用户

**判断标准**：能画出3个具体用户的人物卡片 = 通过

### 第2问：他们有多痛？
**目标**：量化痛点强度，区分真需求和伪需求

**量化维度**：
- 频率：每天/每周/每月遇到？
- 强度：1-10分，10分=无法工作必须解决（阈值≥7）
- 现有方案满意度：1-10分，1分=完全无法忍受（阈值≤4）
- 支付意愿：愿意为解决方案付多少钱？

**判断标准**：
- 频率≥每周 + 强度≥7 + 现有方案满意度≤4 = 强痛点
- 任意一项不达标 = 需要重新评估

### 第3问：为什么是现在做？
**目标**：判断时机是否合适

**分析维度**：
- 市场窗口：是否有新趋势/新政策/新用户行为创造窗口？
- 技术成熟度：所需技术是否已足够成熟且成本可接受？
- 竞争态势：竞品是否尚未覆盖此方向？是否有进入壁垒？

**判断标准**：三个维度至少一个有明确有利信号 = 通过

### 三问判定规则
- 三问都能回答 = 真机会，进入方向定义
- 有一题答不上 = 回到猎人路径继续挖掘
- 有两题答不上 = 放弃此方向

## 最低数据阈值

**每个痛点至少5个独立来源支撑**（minSourcesPerPainPoint: 5）

来源包括但不限于：
- 不同平台的用户帖子/评论
- 独立用户的反馈
- 不同时间段的重复提及
- 竞品差评中的独立投诉
- 社区讨论中的独立发言

不足5个来源的痛点标记为"弱信号"，不进入Product Lens验证。

## 支持平台

| 平台 | 类型 | 数据采集方式 |
|------|------|-------------|
| Reddit | 海外社区 | data-collect + web-interaction |
| HackerNews | 技术社区 | data-collect + web-interaction |
| ProductHunt | 产品社区 | data-collect + web-interaction |
| V2EX | 国内社区 | data-collect + web-interaction |
| StackOverflow | 技术问答 | data-collect + web-interaction |
| GitHub Issues | 开源社区 | data-collect + web-interaction |

## 安全约束

1. **SSRF防护**：所有外部HTTP请求必须经过SSRF防护检查，禁止访问内网地址（127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16）
2. **速率限制**：每个平台每分钟最多10次请求，避免被反爬封禁
3. **数据隐私**：采集的用户数据仅提取痛点信号，不存储用户个人身份信息（PII），帖子内容脱敏处理

## 产出物规范

### 1. 痛点清单
```markdown
## 痛点清单

| # | 痛点描述 | 来源平台 | 出现频率 | 痛点强度(1-10) | 现有方案满意度(1-10) | 是否已解决 | 方向假设 |
|---|---------|---------|---------|---------------|-------------------|-----------|---------|
| 1 | ... | Reddit/HN/V2EX | 每周 | 8 | 3 | 否 | 假设1 |
```

### 2. 竞品分析矩阵
```markdown
## 竞品空隙分析

### 竞品-需求矩阵
| 用户核心需求 | 竞品A | 竞品B | 竞品C | 空隙程度 |
|-------------|-------|-------|-------|---------|
| 需求1 | ✓ | ◐ | ✗ | 高 |
| 需求2 | ◐ | ✗ | ✗ | 极高 |

### 高票Feature Request（竞品拖延未做）
| 竞品 | Feature Request | 投票数 | 等待时间 | 我们的切入点 |
|------|----------------|-------|---------|------------|
```

### 3. 一句话方向描述
```markdown
## 方向定义

**方向**：为[目标用户]解决[核心痛点]，通过[关键差异化手段]，在[时间窗口]内抢占[市场空白]。

**Product Lens验证**：
- 给谁用：[核心用户画像]
- 有多痛：[频率+强度+现有方案满意度]
- 为什么是现在：[时机信号]
```

## 执行流程

1. **路径选择**：根据项目阶段选择1-2条猎人路径（建议至少执行痛苦扫描+竞品空隙）
2. **数据采集**：调用 data-collect/web-interaction 技能采集平台数据
3. **痛点提取**：从采集数据中提取结构化痛点，生成痛点清单
4. **竞品分析**：执行差评区分析+Feature Request聚合，生成竞品空隙矩阵
5. **Product Lens过滤**：对每个方向假设执行三问，过滤伪需求
6. **方向定义**：通过三问的方向，产出竞品分析和一句话方向描述
7. **交接**：将方向描述传递给 idea-validation 技能进行深度验证

## 证据要求

完成本技能执行后，必须提供以下证据：

| 证据类型 | 说明 | 最低标准 |
|---------|------|---------|
| pain_points_scanned | 扫描的痛点数量 | ≥1 |
| competitive_gaps_analyzed | 分析的竞品空隙数量 | ≥1 |
| product_lens_validated | 通过Product Lens验证的方向数量 | ≥1 |

## R52/R53安全加固

### R52: keywords参数传递
`scanPainPoints(platforms, keywords, options)` 的 `keywords` 参数现在正确传递到 `_scanPlatform()` 和浏览器适配器：
- `_scanPlatform(platform, opts, keywords)` 接收keywords参数
- 当keywords非空数组时，自动注入到`opts.keywords`供浏览器适配器过滤
- 修复前：keywords参数被忽略，浏览器适配器无法按关键词过滤

### R52: guardShutdown保护
以下5个getter方法添加了`guardShutdown()`保护，防止在实例关闭后调用：
- `getPainPoints(category)` — 获取痛点列表
- `getCompetitors()` — 获取竞品列表
- `getTechTrends()` — 获取技术趋势
- `getProductLensResults(passedOnly)` — 获取验证结果
- `getStats()` — 获取统计信息

### R52: emit()后检查_shutDown
以下4处`emit()`调用在await之后增加了`_shutDown`检查，防止关闭后继续执行：
- `scanPainPoints()` — 痛点扫描完成后检查
- `analyzeCompetitiveGaps()` — 竞品分析完成后检查
- `discoverTechDividends()` — 技术红利发现完成后检查
- `runFullDiscovery()` — 完整发现管线中多处检查

### R53: competitorReviewMinCount实际使用
`competitorReviewMinCount`配置（默认20）现在在`analyzeCompetitiveGaps()`中实际生效：
- 竞品分析结果按`reviewCount >= competitorReviewMinCount`过滤
- 低于最低评论数的竞品从结果和空隙矩阵中排除
- 修复前：该配置项存在但未被使用，所有竞品均返回

### R53: 服务器端点修正
Dashboard API端点`/api/opportunity-discovery/competitors`现在正确调用`getCompetitors()`方法：
- 修复前：错误调用不存在的`getCompetitiveAnalysis()`方法
- 修复后：调用`getCompetitors()`返回竞品列表

## Vibe Coding融合增强 (v2.7.167)

R56 Vibe Coding Step 1增强，7项运行时能力升级使机会发现管线从"方法论文档"进化为"全功能运行时管线"。

### 1. Deep Research Integration
`_deepResearch(painPoints, topN)` 方法：对痛点清单执行LLM深度分析，自动扩展痛点上下文（行业趋势、竞品动态、技术演进），返回topN个最有价值的深度研究方向。与ai-research技能联动，避免浅层扫描遗漏关键信号。

### 2. Exa Search Adapter
`_exaSearch(query, options)` 方法：Exa API语义搜索适配器，支持高质量网页内容检索。内置MCPClient fallback机制——Exa API不可用时自动降级到MCPClient web-interaction搜索，确保搜索能力不中断。SSRF防护+速率限制继承安全约束。

### 3. Feature Request Quality Analysis
Feature Request质量分析增强：自动提取投票数(vote counts)、状态(status: open/planned/implemented)、等待时长(age)三项质量指标。新增`minFeatureRequestVotes`配置（默认50），低于阈值的Feature Request标记为"弱信号"不进入空隙矩阵，防止低质量请求污染方向判断。

### 4. Tech Dividend Source Integration
`TECH_SOURCES` 常量：定义技术红利信号源及其专用搜索查询模板，包括：
- `github-trending`：GitHub Trending + "new open source model" 查询
- `huggingface`：HuggingFace新模型 + "new LLM release" 查询
- `w3c-ietf`：W3C/IETF草案 + "new web standard" 查询
- `api-changelog`：主要平台API变更 + "API breaking change" 查询

每个源自动生成源特定的搜索策略，替代原先笼统的"技术信号扫描"。

### 5. Persona Generation
`_generatePersona(painPoints, competitors)` 方法：基于痛点清单和竞品分析自动生成用户画像(Persona)。从痛点中提取人口统计特征、行为模式、使用场景、决策链路，输出结构化Persona卡片（含name/demographics/behaviors/scenarios/decisionChain）。满足Product Lens第1问"给谁用"的量化标准。

### 6. One-Sentence Direction Template
增强一句话方向描述模板：从原始`为[目标用户]解决[核心痛点]，通过[关键差异化手段]，在[时间窗口]内抢占[市场空白]`升级为包含**差异化定位**(differentiation)、**时间窗口**(timeWindow)、**市场空隙**(marketGap)三维度结构化输出的富模板。每个维度附带量化指标支撑，避免模糊方向描述。

### 7. Alternative Positioning Analysis
`_analyzeAlternativePositioning()` 方法：替代定位分析，4种策略评估产品定位的替代方案：
1. **Cost Leader**：成本领先——以更低价格提供核心功能
2. **Niche Dominator**：垂直统治——聚焦细分市场深度满足
3. **Experience Innovator**：体验创新——重新定义交互范式
4. **Ecosystem Play**：生态玩法——通过集成和平台效应获胜

每种策略输出可行性评分(1-10)、所需资源、风险等级、与现有竞品的差异化程度，辅助Team Lead做出定位决策。

### 覆盖矩阵更新

| Vibe Coding Step 1 需求 | 原状态 | v2.7.167状态 | 增强项 |
|------------------------|--------|-------------|--------|
| 痛点深度分析 | PARTIAL | COVERED | #1 Deep Research |
| 高质量搜索 | PARTIAL | COVERED | #2 Exa Search |
| Feature Request质量过滤 | NOT_COVERED | COVERED | #3 Quality Analysis |
| 技术红利源特定搜索 | PARTIAL | COVERED | #4 TECH_SOURCES |
| 用户画像自动生成 | NOT_COVERED | COVERED | #5 Persona Generation |
| 方向描述结构化输出 | PARTIAL | COVERED | #6 Rich Template |
| 定位替代方案分析 | NOT_COVERED | COVERED | #7 Alternative Positioning |

## 反模式清单

| 反模式 | 表现 | 正确做法 |
|--------|------|---------|
| 自嗨式发现 | 只看自己想看的数据，忽略反面信号 | 三条路径至少执行两条，交叉验证 |
| 伪需求陷阱 | 把"我觉得用户需要"当作用户真痛点 | 必须有外部平台数据支撑，Product Lens三问缺一不可 |
| 竞品崇拜 | 试图做"更好的竞品"而非"不同的产品" | 聚焦空隙而非全面超越 |
| 技术执念 | 因为技术酷而做，忽略用户是否需要 | 技术红利必须通过Product Lens验证 |
| 方向发散 | 同时追5个方向，每个都浅尝辄止 | 三问过滤后最多保留2个方向深度验证 |
| 数据不足就下结论 | 只看了3条抱怨就认定是痛点 | 每个痛点至少5条独立数据源支撑 |

## 验收标准
- [ ] 至少执行两条猎人路径（痛苦扫描+竞品空隙推荐）
- [ ] 每个痛点至少5条独立数据源支撑
- [ ] Product Lens三问验证完成
- [ ] 竞品空隙矩阵已构建
- [ ] 一句话方向描述已产出
- [ ] keywords参数正确传递到浏览器适配器（R52）
- [ ] guardShutdown在getter方法上生效（R52）
- [ ] competitorReviewMinCount过滤竞品结果正确（R53）
- [ ] _deepResearch()深度分析痛点可用（R56）
- [ ] _exaSearch()搜索+MCPClient fallback可用（R56）
- [ ] Feature Request质量过滤(minFeatureRequestVotes)生效（R56）
- [ ] TECH_SOURCES源特定搜索查询生成正确（R56）
- [ ] _generatePersona()用户画像自动生成可用（R56）
- [ ] 一句话方向描述富模板输出结构化（R56）
- [ ] _analyzeAlternativePositioning()4种策略评估可用（R56）

## 常见问题
- **Q: 扫描平台时关键词过滤不生效怎么办？**
  A: R52已修复keywords参数传递，确保scanPainPoints()的keywords参数非空数组
- **Q: 竞品分析结果包含评论数很少的竞品？**
  A: R53已修复，competitorReviewMinCount（默认20）现在实际过滤低评论数竞品
- **Q: 关闭后调用getter方法报错？**
  A: R52起5个getter方法添加了guardShutdown()保护，关闭后调用会抛出错误
- **Q: Dashboard的竞品端点返回空数据？**
  A: R53已修复服务器端点，现在正确调用getCompetitors()方法
