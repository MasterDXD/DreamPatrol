---
skill_id: better-icons
name: 图标技能
applicable_agents: [task-worker]
trigger: 需要为界面选择、生成或优化图标时
auto_trigger: false
phase: module-development
priority: 3
trigger_conditions:
  - user mentions "图标" or "icon" or "SVG"
  - user asks to add or improve icons
  - UI needs icon integration
depends_on: [ui-skills]
blocks: []
causal_inputs:
  - name: ui-components
    source: ui-skills
    required: true
causal_outputs:
  - name: icon-integration-report
    description: 图标集成报告
evidence_types:
  required:
    - icon_selection_report
enforcement: optional
verified: true
stability: beta
usage_count: 25
success_rate: 0.82
production_validated: true
---

# Skill: Better Icons 图标技能

## 任务目标
解决AI开发中的图标难题，提供图标搜索、选择、优化和集成的完整方案，确保图标风格统一、性能最优。

## 图标库资源

### 核心集合（150+集合，200,000+图标）
| 集合 | 风格 | 图标数 | 适用场景 |
|------|------|--------|----------|
| Lucide | 线性、简洁 | 1,500+ | 通用UI、工具类 |
| Heroicons | 线性/实心 | 300+ | 导航、操作 |
| Material Design | 线性/实心/双色 | 2,500+ | 安卓风格、通用 |
| Phosphor | 6种粗细 | 7,000+ | 灵活定制 |
| Tabler | 线性 | 4,500+ | 仪表盘、管理界面 |
| Feather | 极简线性 | 280+ | 极简风格 |
| Remix Icon | 线性/实心 | 2,800+ | 中性风格、通用 |

## 图标选择原则

### 一致性优先
1. 同一项目只使用一个图标集合
2. 统一风格：线性(linear)或实心(filled)
3. 统一粗细：1.5px 或 2px stroke-width
4. 统一尺寸：16/20/24px

### 语义匹配
- 操作类：使用动词图标（添加、删除、编辑）
- 状态类：使用形容词图标（成功、警告、错误）
- 导航类：使用方向图标（箭头、菜单、关闭）

### 避免AI常见错误
1. 禁止混用不同集合的图标
2. 禁止使用emoji替代图标
3. 禁止使用文字描述替代图标
4. 禁止使用过大或过小的图标尺寸

## SVG优化规则

### 代码优化
```html
<!-- 错误：内联SVG消耗大量token -->
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" 
  stroke="currentColor" stroke-width="2" stroke-linecap="round" 
  stroke-linejoin="round">
  <path d="M12 5v14M5 12h14"/>
</svg>

<!-- 正确：使用图标组件或CSS类 -->
<i class="icon icon-plus" aria-hidden="true"></i>
```

### 性能优化
1. 使用CSS sprite或图标字体减少HTTP请求
2. 内联关键图标，延迟加载非关键图标
3. 使用 `currentColor` 继承颜色
4. 移除SVG中不必要的属性（id、title、desc）
5. 压缩SVG路径数据

## 图标集成方案

### CSS方案
```css
.icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
  background-color: currentColor;
}
.icon-plus { mask-image: url('data:image/svg+xml,...'); }
```

### React组件方案
```jsx
function Icon({ name, size = 24, className }) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true">
      <use href={`#icon-${name}`} />
    </svg>
  );
}
```

## 执行步骤
1. 确定项目图标风格和集合
2. 使用 DesignSkillEngine.searchIcons() 搜索图标
3. 选择语义匹配的图标
4. 优化SVG代码
5. 集成到项目中
6. 输出图标使用规范

## 交付物
- 图标选择清单
- 优化后的SVG代码
- 图标集成代码
- 图标使用规范文档

## 验收标准
- 同一项目仅使用一个图标集合，风格统一
- 所有图标使用 currentColor 继承颜色
- SVG代码已优化，移除冗余属性
- 图标尺寸统一为16/20/24px之一
- 无emoji替代图标的情况

## 常见问题

### Q: 项目中已有多个图标集合怎么办？
A: 选择与项目风格最匹配的一个集合，逐步替换其他集合的图标，保持迁移期间视觉一致性。

### Q: 找不到语义完全匹配的图标怎么办？
A: 优先选择含义最接近的图标，避免使用含义相反或容易误解的图标。必要时可使用文字标签辅助说明。
