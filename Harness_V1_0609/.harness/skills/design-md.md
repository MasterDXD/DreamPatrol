---
skill_id: design-md
name: DESIGN.md 设计语言文档
applicable_agents: [domain-analyst, task-worker]
trigger: 需要建立项目设计系统或设计规范时
auto_trigger: true
phase: architecture-design
priority: 1
trigger_conditions:
  - user mentions "设计系统" or "design system" or "DESIGN.md"
  - user asks to establish design standards
  - project needs design language definition
  - frontend development starts
depends_on: [taste-skill]
blocks: [impeccable, ui-skills, motion-ai-kit, better-icons]
causal_inputs:
  - name: aesthetic-criteria
    source: taste-skill
    required: true
  - name: design-document
    source: brainstorming
    required: false
causal_outputs:
  - name: design-language-document
    description: 设计语言文档
evidence_types:
  required:
    - design_document
    - anti_pattern_checklist
enforcement: strict
verified: true
stability: stable
usage_count: 45
success_rate: 0.88
production_validated: true
---

# Skill: DESIGN.md 设计语言文档

## 任务目标
创建项目级设计语言文档（DESIGN.md），将顶级大厂UI规范浓缩为可执行的设计约束，强行将AI的生成范围约束在"高级感"范畴内，显著降低"AI味"。

## 设计语言来源（58家顶级公司）

### 消费级（Apple / Airbnb）
- 磨砂玻璃质感（backdrop-filter: blur）
- 大留白（spacing: generous）
- 精致圆角（12px-20px）
- 弹簧动画（spring-based, 300-500ms）

### 金融科技（Stripe）
- 丝滑渐变色（低饱和度渐变）
- 极强排版逻辑感（严格字号层级）
- 结构化间距（spacing: structured）
- 平滑动画（smooth, 200-400ms）

### 开发者工具（Vercel / Linear）
- 极简黑白（高对比度）
- 锐利边角（4px-8px）
- 紧凑间距（spacing: tight）
- 快速动画（snappy, 150-300ms）

### 生产力（Notion / Linear）
- 温暖中性色调
- 清晰信息层级
- 舒适间距（spacing: comfortable）
- 微妙动画（subtle, 200-300ms）

### 代码平台（GitHub）
- 功能优先设计
- 信息密度高
- 暗色主题友好
- 最小动画（minimal, 100-200ms）

## DESIGN.md 文件结构

```markdown
# DESIGN.md — [项目名] Design Language

## Design Variance: [1-10]
## Motion Intensity: [1-10]

## Color System
- Primary: [主色]
- Background: [背景色]
- Surface: [表面色]
- Text: [文本色]

## Typography Scale
| Level | Size | Line Height | Weight | Tracking |

## Spacing Scale
Based on 4px grid

## Border Radius
## Motion Presets
## Anti-Patterns (禁止)
## Suitable For: [适用场景]
```

## 设计差异度（Design Variance）

### 1-3（常规/保守）
- 安全的居中布局
- 标准网格系统
- 适合：后台管理系统、内部工具

### 4-5（平衡/适度）
- 适度创意元素
- 微妙的偏移和重叠
- 适合：企业官网、SaaS平台

### 6-7（创意/大胆）
- 元素重叠
- 文字偏移
- 图片大小各异
- 适合：品牌展示、产品页面

### 8-10（狂野/实验）
- 非对称布局
- 大面积留白
- 瀑布流网格
- 杂志感设计
- 适合：创意机构、艺术项目

## 去除"AI味"的核心原理

### 1. 约束而非自由
AI在无约束时倾向于生成"所有设计的平均值"——这就是AI味的来源。DESIGN.md通过严格约束，将AI限制在特定设计语言内。

### 2. 反模式清单
明确列出AI容易犯的设计错误，在生成前就预防：
- 纯黑背景 → 偏黑
- 霓虹发光 → 柔和阴影
- 紫蓝渐变 → 单色系
- 系统字体 → 专业字体
- 默认ease → 物理缓动

### 3. 量化标准
将模糊的"好看"转化为可量化的标准：
- 颜色饱和度 ≤ 80%
- 阴影层数 ≥ 2
- 圆角一致性（同一项目不超过3种圆角值）
- 间距遵循4px网格

### 4. 参考对标
选择一个目标公司设计语言作为锚点，所有设计决策以此为参照。

## 执行步骤
1. 确定项目类型和目标用户
2. 选择参考公司设计语言
3. 确定设计差异度（1-10）
4. 使用 DesignSkillEngine.generateDesignMd() 生成DESIGN.md
5. 根据项目需求定制调整
6. 将DESIGN.md放置在项目根目录
7. 在AI对话中引用DESIGN.md作为设计约束

## 交付物
- DESIGN.md 文件
- 设计令牌定义（CSS变量）
- 设计语言选择依据文档
- 反模式检查清单

## 验收标准
- DESIGN.md 包含完整的色彩、排版、间距、圆角、动效定义
- 设计差异度（1-10）已明确设定
- 反模式清单覆盖至少5项AI常见设计错误
- CSS变量已从DESIGN.md提取并应用到项目
- 所有设计决策有参考对标公司

## 常见问题

### Q: 设计差异度应该设为多少？
A: 后台管理系统建议1-3，企业官网4-5，品牌展示6-7，创意项目8-10。不确定时从4-5开始。

### Q: 已有项目如何引入DESIGN.md？
A: 先审计现有设计，提取已有模式作为基线，再逐步对齐到DESIGN.md规范，避免一次性大规模重构。
