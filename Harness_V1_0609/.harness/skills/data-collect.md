---
skill_id: data-collect
name: 多平台数据采集
phase: module-development
priority: 2
enforcement: recommended
stability: beta
applicable_agents:
  - task-worker
  - domain-analyst
auto_trigger: true
tags: [data-collect, scrape, crawl, 小红书, 公众号, 抖音, 视频号, 选题, 数据分析]
dependencies: [web-interaction]
causal_inputs:
  - user-requirement(from:requirement-analysis)
causal_outputs:
  - collected-data
  - data-collect-report
trigger: auto
trigger_conditions: []
verified: true
---

## 目标

通过三层采集体系（OpenCLI适配器/BrowserUse模板/CLI-Anything扩展）从多平台采集结构化数据，支持选题分析、竞品分析和趋势监控，确保数据质量和合规性。

# 多平台数据采集技能

## 适用性决策

### 适合采集的场景
- 选题分析：需要批量采集某平台内容的数据维度（点赞/收藏/评论/话题）辅助选题决策
- 竞品分析：采集竞品账号的内容数据和互动指标
- 趋势监控：定期采集特定话题或关键词下的内容数据
- 内容库建设：批量采集优质内容元数据构建本地知识库

### 不适合采集的场景
- 实时性要求极高的场景（数据采集有延迟，不适合毫秒级响应）
- 需要登录态的深度数据（如私信、交易数据，涉及隐私合规风险）
- 大规模全量采集（可能触发反爬机制，应控制速率和规模）
- 法律合规灰色地带的数据（应遵守平台ToS和当地法律）

## 采集架构

### 三层采集体系

```
Layer 1: OpenCLI适配器（推荐首选）
  ├── 80+网站适配器（小红书/知乎/Bilibili/Twitter等）
  ├── Chrome Bridge复用登录态
  └── 零Token成本，结构化JSON输出

Layer 2: BrowserUse模板采集（深度定制）
  ├── DATA_COLLECT_TEMPLATES字段映射
  ├── CDP直连/MCP双模式
  └── 自愈机制应对页面结构变化

Layer 3: CLI-Anything扩展（本地工具）
  ├── CLI-Hub预生成工具
  └── 7阶段自动生成新CLI接口
```

### 平台-方案映射

| 平台 | 推荐方案 | 模板ID | 可采集字段 |
|------|----------|--------|-----------|
| 小红书 | OpenCLI → BrowserUse | xiaohongshu-note | 封面/标题/作者ID/点赞/收藏/评论/发布时间/笔记类型/话题 |
| 抖音 | BrowserUse | douyin-video | 封面/标题/作者ID/点赞/收藏/评论/发布时间/话题 |
| 公众号 | BrowserUse | wechat-article | 封面/标题/作者ID/点赞/发布时间/话题 |
| 视频号 | BrowserUse(generic) | generic | 标题/作者/发布时间/内容 |
| 通用网页 | BrowserUse | generic | 标题/作者/发布时间/内容 |

## 执行步骤

### Step 1: 确定采集需求
- 明确目标平台和采集字段
- 确认数据用途（选题/竞品分析/趋势监控）
- 评估合规性（平台ToS、数据量、频率）

### Step 2: 选择采集方案
- 优先使用OpenCLI适配器（`opencli list`查看可用适配器）
- 无适配器时使用BrowserUse模板采集（`extractByTemplate(templateId)`）
- 需要本地工具时使用CLI-Anything（`cli-hub install`）

### Step 3: 执行数据采集
```
# OpenCLI方式
opencli <platform> <command> --format json

# BrowserUse模板方式
adapter.navigate(url);
const data = await adapter.extractByTemplate('xiaohongshu-note');

# 自定义字段
const data = await adapter.extractByTemplate('xiaohongshu-note', [
  { key: 'title', selector: '.note-title', attr: 'textContent', type: 'string' },
  { key: 'likes', selector: '.like-count', attr: 'textContent', type: 'number' },
]);
```

### Step 4: 数据验证与清洗
- 检查采集字段完整性（必填字段非空率）
- 数值字段类型转换（字符串→数字）
- 去重（基于标题+作者ID组合键）
- 异常值过滤（点赞数为负数等）

### Step 5: 结果输出
- 结构化JSON/Excel格式输出
- 采集报告：平台/条数/字段覆盖率/耗时/异常记录

### Step 6: 技能扩展（"拿来主义"）
- 现有模板不满足时，自定义字段映射
- 新平台无适配器时，通过CLI-Anything生成新CLI接口
- 高频采集场景可提炼为自动创建技能（SkillCreationEngine）

## 验收标准

- [ ] 采集字段覆盖率 >= 80%（必填字段非空率）
- [ ] 数值字段已正确类型转换
- [ ] 去重后无重复数据
- [ ] 采集速率符合平台限制（无触发反爬）
- [ ] 输出格式为结构化JSON或Excel
- [ ] 采集报告包含：平台/条数/字段覆盖率/耗时/异常

## 反模式清单

| 反模式 | 说明 | 替代方案 |
|--------|------|----------|
| 全量无差别采集 | 不加筛选地采集全平台数据 | 明确采集目标和范围 |
| 忽视合规性 | 不检查平台ToS和法律要求 | 采集前评估合规风险 |
| 高频暴力采集 | 短时间大量请求触发反爬 | 控制速率，添加延迟 |
| 忽略数据质量 | 不验证采集结果的完整性和准确性 | Step 4数据验证 |
| 硬编码选择器 | 直接写死CSS选择器不维护 | 使用DATA_COLLECT_TEMPLATES模板 |

## 常见问题
- **Q: 采集被反爬封禁？**
  A: 控制请求速率（每平台每分钟最多10次），添加随机延迟，使用Chrome Bridge复用已登录会话
- **Q: 模板字段提取不完整？**
  A: 检查DATA_COLLECT_TEMPLATES模板定义，部分平台页面结构变化需要更新模板
