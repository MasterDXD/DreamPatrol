---
skill_id: motion-ai-kit
name: 动效技能
applicable_agents: [task-worker]
trigger: 需要为界面添加动画、过渡效果或动效优化时
auto_trigger: false
phase: module-development
priority: 3
trigger_conditions:
  - user mentions "动画" or "animation" or "动效" or "motion" or "过渡"
  - user asks to add transitions or animations
  - UI needs motion design
depends_on: [ui-skills]
blocks: []
causal_inputs:
  - name: ui-components
    source: ui-skills
    required: true
causal_outputs:
  - name: motion-spec
    description: 动效规格
  - name: animated-components
    description: 动画组件
evidence_types:
  required:
    - motion_css
    - performance_report
enforcement: optional
verified: true
stability: beta
usage_count: 20
success_rate: 0.80
production_validated: true
---

# Skill: Motion AI Kit 动效技能

## 任务目标
为AI生成的前端界面注入专业级动效，包括动画类型定义、参数控制和性能优化，确保动效具有物理重量感和目的性。

## 动效预设系统

### 预设类型
| 预设 | 时长 | 缓动曲线 | 适用场景 |
|------|------|----------|----------|
| micro | 150ms | cubic-bezier(0.4, 0, 0.2, 1) | 微交互：按钮hover、开关切换 |
| smooth | 300ms | cubic-bezier(0.4, 0, 0.2, 1) | 平滑过渡：面板展开、下拉菜单 |
| spring | 500ms | cubic-bezier(0.34, 1.56, 0.64, 1) | 弹簧效果：模态框弹出、通知出现 |
| bounce | 600ms | cubic-bezier(0.68, -0.55, 0.265, 1.55) | 弹跳效果：拖拽释放、错误抖动 |
| elegant | 700ms | cubic-bezier(0.32, 0.72, 0, 1) | 优雅过渡：页面切换、内容加载 |
| dramatic | 1000ms | cubic-bezier(0.16, 1, 0.3, 1) | 戏剧性效果：首屏加载、品牌展示 |

## 动效强度等级

### 1-3（静态/微动）
- 仅使用hover状态变化
- 过渡时长 ≤ 200ms
- 适合：后台管理系统、数据面板

### 4-5（适度动效）
- 页面加载动画
- 列表项交错出现
- 适合：企业官网、SaaS平台

### 6-7（丰富动效）
- 滚动触发动画
- 视差效果
- 适合：品牌展示、产品页面

### 8-10（沉浸式）
- 粒子系统
- 3D变换
- 适合：创意网站、游戏化界面

## 核心动效模式

### 页面加载编排
```css
.stagger-reveal > * {
  opacity: 0;
  transform: translateY(20px);
  animation: fadeSlideUp var(--motion-duration) var(--motion-easing) forwards;
}
.stagger-reveal > *:nth-child(1) { animation-delay: 0ms; }
.stagger-reveal > *:nth-child(2) { animation-delay: 80ms; }
.stagger-reveal > *:nth-child(3) { animation-delay: 160ms; }
```

### 磁性按钮效果
```css
.magnetic-btn {
  transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.magnetic-btn:hover {
  transform: scale(1.05);
}
```

### 浮动导航栏
```css
.floating-nav {
  backdrop-filter: blur(12px);
  transition: all 300ms cubic-bezier(0.32, 0.72, 0, 1);
}
.floating-nav.scrolled {
  box-shadow: var(--shadow-md);
}
```

## 性能优化规则

### 必须遵守
1. 仅动画 `transform` 和 `opacity`，避免布局属性
2. 使用 `will-change` 提示浏览器，但及时移除
3. 动画元素创建独立合成层
4. 避免同时运行动画超过3个
5. 使用 `requestAnimationFrame` 替代 `setTimeout`

### 禁止
1. 禁止动画 `width`/`height`/`top`/`left`
2. 禁止使用 `!important` 覆盖动画
3. 禁止无限循环动画（loading除外）
4. 禁止在滚动事件中直接修改DOM
5. 禁止 `animation: all`（明确指定属性）

## 执行步骤
1. 确定动效强度等级（1-10）
2. 选择对应的动效预设
3. 设计动效编排方案
4. 实现动效代码
5. 性能测试和优化
6. 输出动效规范文档

## 交付物
- 动效CSS/JS代码
- 动效预设配置
- 性能测试报告
- 动效规范文档

## 验收标准
- 所有动画仅使用 transform 和 opacity 属性
- 动效时长符合预设规范（微交互≤200ms，过渡200-500ms，页面级≥500ms）
- 无同时运行超过3个动画的情况
- 页面帧率保持在55fps以上
- 已设置 prefers-reduced-motion 媒体查询降级

## 常见问题

### Q: 动效导致页面卡顿怎么办？
A: 检查是否动画了布局属性（width/height/top/left），改用 transform 替代。确保使用 will-change 提示浏览器，并在动画结束后移除。

### Q: 如何处理用户偏好减少动画的设置？
A: 使用 @media (prefers-reduced-motion: reduce) 媒体查询，将动画时长设为0.01ms，保留状态变化但去除过渡效果。
