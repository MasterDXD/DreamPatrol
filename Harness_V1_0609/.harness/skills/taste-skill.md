---
skill_id: taste-skill
name: 审美判断
applicable_agents: [domain-analyst, task-worker]
trigger: 需要评估或提升前端界面审美水平时
auto_trigger: true
phase: architecture-design
priority: 2
trigger_conditions:
  - user mentions "审美" or "taste" or "美观" or "设计感"
  - user asks to evaluate or improve visual quality
  - frontend design review is needed
depends_on: [brainstorming]
blocks: [impeccable]
causal_inputs:
  - name: design-document
    source: brainstorming
    required: false
causal_outputs:
  - name: aesthetic-criteria
    description: 审美标准
  - name: visual-standards
    description: 视觉规范
evidence_types:
  required:
    - aesthetic_score_report
    - design_review
enforcement: recommended
verified: true
stability: stable
usage_count: 50
success_rate: 0.84
production_validated: true
---

# Skill: Taste Skill 审美判断

## 任务目标
提升AI前端审美判断能力，建立审美标准定义、判断模型和优化策略，确保生成界面具备专业设计水准。

## 审美标准定义

### 视觉层次（Visual Hierarchy）
- 清晰的信息层级：标题 → 副标题 → 正文 → 辅助文本
- 对比度控制：标题与正文至少2:1的字号比
- 留白节奏：内容区域间距遵循4px网格倍数

### 色彩品味（Color Taste）
- 禁止"AI通用配色"：紫蓝渐变、霓虹色、过饱和色
- 推荐低饱和度中性色系：Zinc/Slate/Neutral灰阶
- 强调色使用克制：一个主色 + 一个辅助色
- 暗色主题：使用偏黑而非纯黑，保持层次感

### 排版品味（Typography Taste）
- 专业字体栈：Inter / SF Pro / Geist Sans
- 字号比例：遵循模块化排版比例（1.25倍递增）
- 行高规范：正文1.5-1.75，标题1.1-1.3
- 字间距：大标题收紧(-0.03em)，正文宽松(0em)

### 间距品味（Spacing Taste）
- 4px基准网格
- 组件内间距：8-16px
- 组件间间距：16-32px
- 区块间间距：32-64px
- 大面积留白是高级感的来源

### 动效品味（Motion Taste）
- 拒绝"无意义的动画"
- 每个动效必须有功能目的：引导注意力、提供反馈、建立空间关系
- 缓动函数：优先使用物理弹簧曲线而非线性/默认ease
- 时长规范：微交互150ms，过渡300ms，页面级500-700ms

### 用户路径品味（User Path Taste，v2.7.109增强，源自Web Design Skill）
- 首屏重点：用户第一秒必须看到核心价值主张，而非装饰元素
- 按钮层级：主操作按钮 > 次要操作 > 辅助链接，视觉权重严格区分
- 操作路径：核心任务完成步骤不超过3步，迷路率趋近于零
- 认知负荷：每个页面只传达一个核心信息，避免信息过载
- 转化漏斗：关键操作路径必须有清晰的视觉引导（箭头/高亮/动效提示）

## 判断模型

### 评分维度（满分100）
| 维度 | 权重 | 评分标准 |
|------|------|----------|
| 视觉层次 | 20% | 信息层级是否清晰，对比度是否合理 |
| 色彩品味 | 20% | 是否避免AI通用配色，饱和度是否克制 |
| 排版品味 | 15% | 字体选择、字号比例、行高是否专业 |
| 间距品味 | 10% | 是否遵循网格系统，留白是否合理 |
| 动效品味 | 10% | 动效是否有目的，缓动是否自然 |
| 用户路径 | 25% | 首屏重点是否清晰，操作路径是否简洁，按钮层级是否分明 |

### 评级标准
- A (90-100): 专业级设计，可直接上线
- B (75-89): 良好设计，需要少量打磨
- C (60-74): 及格，存在明显AI痕迹
- D (40-59): 不及格，需要大幅重构
- F (0-39): 严重AI味，需要完全重做

## 优化策略
1. **预防优于修复**：在生成前加载设计规范
2. **模式识别**：识别并标记AI生成特征
3. **渐进增强**：从基础规范开始，逐步提升
4. **参考对标**：与顶级公司设计语言对比

## 执行步骤
1. 使用 DesignSkillEngine.critique() 评估当前设计
2. 分析各维度得分，识别薄弱环节
3. 针对低分维度制定优化方案
4. 实施优化并重新评估
5. 输出审美评估报告

## 交付物
- 审美评估报告（各维度评分、评级、改进建议）
- 优化方案文档
- 优化前后对比

## 验收标准
- 审美评分达到B级（75分）以上
- 各维度无低于60分的项
- AI通用配色已消除（紫蓝渐变、霓虹色、过饱和色）
- 排版遵循模块化比例，无随意字号
- 间距符合4px网格系统
- 首屏核心价值主张在1秒内可识别（v2.7.109增强）
- 核心任务操作路径不超过3步（v2.7.109增强）
- 按钮层级视觉权重有明显区分（v2.7.109增强）

## 常见问题

### Q: 审美评分一直偏低怎么办？
A: 优先修复权重最高的维度（视觉层次25%、色彩品味25%），这两项改善对总分影响最大。参考对标公司设计语言逐步调整。

### Q: 如何平衡审美与功能需求？
A: 功能优先，审美增强。确保交互逻辑和可访问性不受影响的前提下，逐步提升视觉品质。
