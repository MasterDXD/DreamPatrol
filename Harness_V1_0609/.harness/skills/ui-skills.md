---
skill_id: ui-skills
name: 模块化UI工程
applicable_agents: [task-worker]
trigger: 构建或优化UI组件、界面布局时
auto_trigger: true
phase: module-development
priority: 2
trigger_conditions:
  - user mentions "UI组件" or "UI component" or "界面" or "layout"
  - user asks to build or improve UI elements
  - frontend component development is needed
depends_on: [taste-skill, impeccable]
blocks: []
causal_inputs:
  - name: aesthetic-criteria
    source: taste-skill
    required: false
  - name: polished-code
    source: impeccable
    required: false
causal_outputs:
  - name: ui-components
    description: UI组件集
evidence_types:
  required:
    - component_code
    - accessibility_report
enforcement: recommended
verified: true
stability: stable
usage_count: 40
success_rate: 0.85
production_validated: true
---

# Skill: UI Skills 模块化UI工程

## 任务目标
提供模块化UI工程技能集合，确保AI生成的UI组件符合专业设计标准，具备一致性、可访问性和响应式能力。

## 子技能模块

### baseline-ui — UI基线规范
验证动画时长、强制排版比例、检查组件可访问性、防止布局反模式。
- 动画时长：微交互 ≤ 200ms，过渡 200-500ms，页面级 ≥ 500ms
- 排版比例：遵循模块化比例，禁止随意字号
- 可访问性：ARIA标签、键盘导航、颜色对比度 ≥ 4.5:1
- 布局反模式：禁止固定宽度、禁止 !important、禁止内联样式覆盖

### fixing-accessibility — 可访问性修复
系统性修复UI组件的可访问性问题：
- 语义化HTML标签
- ARIA角色和属性
- 键盘导航支持
- 屏幕阅读器兼容
- 颜色对比度达标

### fixing-metadata — 元数据修复
确保UI组件的元数据完整：
- 正确的title和description
- Open Graph标签
- 结构化数据标记
- SEO最佳实践

### fixing-motion-performance — 动效性能修复
优化UI动效的性能：
- 使用 transform 和 opacity 替代布局属性
- will-change 正确使用
- requestAnimationFrame 替代 setTimeout
- 减少重排重绘

## 设计令牌系统

### 颜色令牌
```css
:root {
  --color-primary: /* 由DESIGN.md定义 */;
  --color-bg: /* 由DESIGN.md定义 */;
  --color-surface: /* 由DESIGN.md定义 */;
  --color-text: /* 由DESIGN.md定义 */;
  --color-text-secondary: /* 主文本60%透明度 */;
  --color-border: /* 中性色200 */;
}
```

### 间距令牌
基于4px网格：0/0.5/1/1.5/2/3/4/5/6/8/10/12/16/20/24/32/40/48/56/64

### 圆角令牌
- sm: 4px（小元素：标签、徽章）
- md: 8px（中元素：按钮、输入框）
- lg: 12px（大元素：卡片、面板）
- xl: 20px（容器级：模态框、对话框）
- full: 9999px（圆形：头像、圆形按钮）

### 阴影令牌
```css
--shadow-sm: 0 1px 2px rgba(0,0,0,.05);
--shadow-md: 0 2px 4px rgba(0,0,0,.05), 0 4px 8px rgba(0,0,0,.05);
--shadow-lg: 0 4px 8px rgba(0,0,0,.05), 0 8px 16px rgba(0,0,0,.08);
--shadow-xl: 0 8px 16px rgba(0,0,0,.08), 0 16px 32px rgba(0,0,0,.12);
```

## 组件规范

### 按钮
- 最小点击区域 44x44px
- 明确的hover/active/focus/disabled状态
- 圆角使用 md (8px)
- 内边距 8px 16px（sm）或 12px 24px（md）

### 卡片
- 圆角使用 lg (12px)
- 内边距 16-24px
- 阴影使用 md，hover时过渡到 lg
- 边框使用1px中性色

### 输入框
- 高度 40-44px
- 圆角使用 md (8px)
- 清晰的focus状态（2px主色边框）
- 错误状态使用红色提示

## 执行步骤
1. 确定UI组件类型和设计语言
2. 加载对应的设计令牌系统
3. 按组件规范构建组件
4. 运行 baseline-ui 检查
5. 修复可访问性和性能问题
6. 输出组件代码和设计令牌

## 交付物
- UI组件代码
- 设计令牌定义
- 可访问性检查报告
- 性能优化报告

## 验收标准
- 所有组件满足最小点击区域44x44px
- 颜色对比度达到WCAG AA标准（≥4.5:1）
- 组件支持键盘导航和ARIA标签
- 响应式布局在320px-1920px范围内正常显示
- 无布局反模式（固定宽度、!important覆盖、内联样式）

## 常见问题

### Q: 组件设计与现有代码风格不一致怎么办？
A: 以DESIGN.md定义的设计令牌为准，逐步对齐现有组件。新组件必须严格遵循设计令牌，旧组件在迭代中逐步迁移。

### Q: 可访问性修复是否影响视觉效果？
A: 正确的可访问性实现不会影响视觉设计。ARIA标签对视觉无影响，键盘导航通过focus-visible样式增强而非改变布局。
