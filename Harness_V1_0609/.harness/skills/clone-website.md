---
skill_id: clone-website
name: 网站逆向克隆
phase: module-development
priority: 2
enforcement: optional
description: |
  通过WebsiteCloner引擎实现网站逆向工程，将目标URL的视觉设计、交互逻辑和内容结构
  重建为可编辑的Vanilla HTML/CSS/JS代码。核心能力包括：
  - 5阶段流水线：侦察→令牌提取→组件规格→构建→质量保证
  - CSS逆向提取：通过CDP注入getComputedStyle扫描，提取颜色/字体/间距/圆角/阴影等设计令牌
  - 颜色聚类算法：自动将提取的颜色归纳为主色/辅色/中性色/强调色系统
  - 组件模式识别：基于DOM结构和CSS类名自动识别导航/英雄区/卡片/表单等10种组件模式
  - 间距模式检测：自动检测基础间距单位和倍数关系
  - Vanilla HTML/CSS/JS输出：生成CSS变量+组件化HTML+语义化CSS
  - 与BrowserUseAdapter深度集成：复用CDP浏览器自动化能力
  - 与DesignSkillEngine深度集成：QA阶段自动审计设计质量
trigger: auto
trigger_conditions:
  - 用户要求克隆/复制/逆向某个网站
  - 用户要求从网页提取设计令牌（颜色/字体/间距）
  - 用户要求将网站转换为可编辑的HTML/CSS代码
  - 用户提到"网站克隆"、"逆向工程"、"复刻网页"
  - 需要从现有网站提取设计系统信息
prerequisites:
  - WebsiteCloner模块已加载（src/runtime/web/website-cloner.js）
  - BrowserUseAdapter已初始化（用于浏览器自动化，可选但推荐）
  - DesignSkillEngine已初始化（用于设计质量审计，可选）
applicable_agents: [task-worker, domain-analyst]
auto_trigger: true
tools_used:
  - website-cloner
  - browser-use-adapter
  - design-skill-engine
slash_command: /clone-website
evidence:
  required: true
  types:
    - clone-result
    - design-tokens
    - component-specs
    - generated-code
verified: true
stability: beta
---

## 目标

通过5阶段流水线（侦察→令牌提取→组件规格→构建→质量保证）将目标网站逆向克隆为可编辑的Vanilla HTML/CSS/JS代码，提取设计令牌、识别组件模式、生成可运行的前端代码。

# 网站逆向克隆技能

## 执行步骤

### 步骤1：环境准备

1. 确认WebsiteCloner实例可用
2. 检查BrowserUseAdapter是否已连接（推荐但非必需）
3. 检查DesignSkillEngine是否可用（可选，用于QA阶段）
4. 解析用户提供的URL参数

### 步骤2：执行克隆流水线

使用WebsiteCloner.clone(url, options)执行5阶段流水线：

**Phase 1 — 侦察（Recon）**
- 通过BrowserUseAdapter导航到目标URL
- 在多个断点（mobile/tablet/desktop）截图
- 注入JS脚本执行getComputedStyle()扫描
- 提取DOM结构、图片/SVG/字体资源、meta信息

**Phase 2 — 令牌提取（Token Extraction）**
- 从computed styles中提取颜色值，归一化为hex
- 颜色聚类：基于欧几里得距离将相似颜色归组
- HSL分类：按饱和度区分主色/中性色/强调色
- 字体栈提取与去重
- 字号频率排序
- 间距值提取与模式检测（基础单位×倍数）
- 圆角/阴影/过渡值收集

**Phase 3 — 组件规格（Component Spec）**
- 基于10种预定义组件模式匹配DOM元素
- 自动页面分段（当无模式匹配时）
- 为每个组件生成规格文档：类型/选择器/设计令牌/内容

**Phase 4 — 构建（Build）**
- 生成CSS变量（:root自定义属性）
- 生成基础样式（reset + body）
- 为每个组件生成HTML和CSS
- 组装完整HTML页面

**Phase 5 — 质量保证（QA）**
- 检查生成代码的完整性
- 可选：通过DesignSkillEngine.audit()审计设计质量
- 输出质量评分和问题列表

### 步骤3：结果交付

1. 输出设计令牌摘要（颜色系统/字体/间距/圆角/阴影）
2. 输出组件识别结果（类型/数量/规格）
3. 输出生成的HTML/CSS/JS代码
4. 输出QA质量评分和问题列表
5. 如有浏览器适配器，提供截图对比

## 代码示例

```javascript
const WebsiteCloner = require('./src/runtime/web/website-cloner');
const BrowserUseAdapter = require('./src/runtime/infrastructure/browser-use-adapter');

const cloner = new WebsiteCloner();
const browser = new BrowserUseAdapter({ mode: 'direct' });

cloner.attachBrowserAdapter(browser);

const result = await cloner.clone('https://example.com', {
  outputFormat: 'html',
  fidelityLevel: 'high',
});

console.log('Tokens:', result.tokens);
console.log('Components:', result.specs.components.length);
console.log('HTML length:', result.build.html.length);
console.log('QA score:', result.qa.qualityScore);
```

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| outputFormat | 'html' | 输出格式（html） |
| fidelityLevel | 'high' | 保真度级别（high/medium/low） |
| maxComponents | 50 | 最大组件识别数量 |
| tokenClusteringThreshold | 0.05 | 颜色聚类阈值（0-1，越小越精确） |
| screenshotBreakpoints | mobile/tablet/desktop | 截图断点配置 |
| timeoutMs | 300000 | 克隆超时时间（毫秒） |

## 事件

| 事件名 | 触发时机 | 数据 |
|--------|----------|------|
| phase-started | 阶段开始 | { phase } |
| phase-completed | 阶段完成 | { phase, result } |
| phase-failed | 阶段失败 | { phase, error } |
| clone-completed | 克隆完成 | { url, durationMs, result } |
| clone-failed | 克隆失败 | { url, error } |

## 验收标准
- [ ] 5阶段流水线完整执行（Recon→Token→Spec→Build→QA）
- [ ] 设计令牌提取完整（颜色/字体/间距/圆角/阴影）
- [ ] 组件识别数量合理
- [ ] 生成的HTML/CSS代码可运行
- [ ] QA质量评分可用

## 常见问题
- **Q: 颜色聚类结果不准确？**
  A: 调整tokenClusteringThreshold（默认0.05），值越小聚类越精确
- **Q: 组件识别遗漏？**
  A: 检查maxComponents限制，部分自定义组件可能不在10种预定义模式中
- **Q: BrowserUseAdapter未连接？**
  A: 克隆仍可执行但功能受限（无截图、无computed style扫描），建议连接CDP
