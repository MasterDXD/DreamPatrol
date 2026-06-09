# Section 组件 API 文档

## 概述

Section 组件是框架设计系统中的核心布局组件，用于组织页面内容区域。支持 5 种变体、3 种间距、6 种强调色，以及可折叠交互。

## RESTful API

### 1. 获取 Section 令牌

```
GET /api/design/section/tokens
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| variant | string | 否 | 过滤特定变体：default/collapsible/accent/bordered/hero |
| spacing | string | 否 | 过滤特定间距：compact/default/spacious |

**响应示例：**

```json
{
  "component": "section",
  "tokens": {
    "variants": ["default", "collapsible", "accent", "bordered", "hero"],
    "spacing": {
      "compact": { "padding": "8px 12px", "gap": "8px" },
      "default": { "padding": "12px 18px", "gap": "12px" },
      "spacious": { "padding": "16px 24px", "gap": "16px" }
    },
    "titleSizes": { "sm": "0.6875rem", "md": "0.75rem", "lg": "0.875rem" },
    "borderRadius": { "sm": "6px", "md": "8px", "lg": "12px" },
    "accentColors": ["primary", "success", "warning", "danger", "purple", "cyan"],
    "animation": {
      "collapseDuration": 200,
      "collapseEasing": "cubic-bezier(0.4, 0, 0.2, 1)"
    }
  }
}
```

### 2. 获取 Section CSS

```
GET /api/design/section/css
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| variant | string | 否 | 变体名称，默认 default |
| spacing | string | 否 | 间距选项，默认 default |
| accentColor | string | 否 | 强调色，仅 accent 变体有效 |

**响应示例：**

```json
{
  "component": "section",
  "variant": "accent",
  "spacing": "default",
  "accentColor": "primary",
  "baseCSS": "/* section component tokens */\n:root { ... }",
  "variantCSS": "/* section variant: accent */\n.ds-section--accent { ... }",
  "animation": { "collapseDuration": 200, "collapseEasing": "..." }
}
```

### 3. 获取 Section 变体列表

```
GET /api/design/section/variants
```

**响应示例：**

```json
{
  "component": "section",
  "variants": [
    { "name": "default", "description": "标准Section，带标题和内容区域", "className": "ds-section--default" },
    { "name": "collapsible", "description": "可折叠Section，支持展开/收起动画", "className": "ds-section--collapsible" },
    { "name": "accent", "description": "强调色Section，左侧带彩色边框", "className": "ds-section--accent" },
    { "name": "bordered", "description": "边框Section，带完整边框和背景头部", "className": "ds-section--bordered" },
    { "name": "hero", "description": "英雄区Section，大号标题和主色下划线", "className": "ds-section--hero" }
  ],
  "spacingOptions": [
    { "name": "compact", "values": { "padding": "8px 12px", "gap": "8px" } },
    { "name": "default", "values": { "padding": "12px 18px", "gap": "12px" } },
    { "name": "spacious", "values": { "padding": "16px 24px", "gap": "16px" } }
  ],
  "accentColors": ["primary", "success", "warning", "danger", "purple", "cyan"],
  "animation": { "collapseDuration": 200, "collapseEasing": "cubic-bezier(0.4, 0, 0.2, 1)" }
}
```

### 4. 验证 Section 配置

```
GET /api/design/section/validate
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| variant | string | 否 | 待验证的变体值 |
| spacing | string | 否 | 待验证的间距值 |
| accentColor | string | 否 | 待验证的强调色值 |
| collapsible | string | 否 | "true" 或 "false" |

**响应示例（验证通过）：**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "config": { "variant": "accent", "spacing": "default", "accentColor": "primary", "collapsible": false }
}
```

**响应示例（验证失败）：**

```json
{
  "valid": false,
  "errors": [
    { "field": "variant", "message": "Invalid variant: custom. Must be one of: default, collapsible, accent, bordered, hero" }
  ],
  "warnings": [],
  "config": { "variant": "custom", "spacing": "default", "accentColor": null, "collapsible": false }
}
```

## 前端组件 API

### Components.section(title, content, options)

通用 Section 组件，支持所有变体和配置。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | Section 标题文本 |
| content | string | 是 | Section 内容 HTML |
| options | object | 否 | 配置选项 |

**options 配置项：**

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| variant | string | 'default' | 变体：default/collapsible/accent/bordered/hero |
| id | string | 自动生成 | Section 唯一标识符 |
| icon | string | '' | 标题前的 emoji 图标 |
| badge | string | '' | 标题后的徽章文本（如数量） |
| spacing | string | 'default' | 间距：compact/default/spacious |
| accentColor | string | '' | 强调色（仅 accent 变体有效）：primary/success/warning/danger/purple/cyan |
| collapsible | boolean | false | 是否可折叠（variant=collapsible 时自动为 true） |
| defaultCollapsed | boolean | false | 默认折叠状态 |
| className | string | '' | 额外 CSS 类名 |

### 快捷方法

```javascript
Components.collapsibleSection(title, content, options)
Components.accentSection(title, content, options)
Components.borderedSection(title, content, options)
Components.heroSection(title, content, options)
```

## DesignSection 交互管理器

### 方法

| 方法 | 参数 | 说明 |
|------|------|------|
| register(sectionEl) | DOM 元素 | 注册可折叠 Section，绑定事件 |
| toggle(sectionId) | string | 切换折叠/展开状态 |
| collapse(sectionId) | string | 折叠指定 Section |
| expand(sectionId) | string | 展开指定 Section |
| expandAll() | - | 展开所有已注册的 Section |
| collapseAll() | - | 折叠所有已注册的 Section |
| isCollapsed(sectionId) | string | 查询折叠状态，返回 boolean |
| initAll() | - | 自动发现并注册所有可折叠 Section |
| destroy(sectionId?) | string? | 清理指定或所有 Section 注册 |

## 使用示例

### 基础用法

```javascript
var html = Components.section('标题', '<p>内容</p>');
```

### 带图标和徽章

```javascript
var html = Components.section('色彩系统', colorContent, {
  icon: '🎨',
  badge: '3套'
});
```

### 可折叠 Section

```javascript
var html = Components.collapsibleSection('高级设置', settingsContent, {
  defaultCollapsed: true,
  icon: '⚙️',
  badge: '12项'
});
```

### 强调色 Section

```javascript
var html = Components.accentSection('重要通知', noticeContent, {
  accentColor: 'danger',
  icon: '⚠️'
});
```

### 边框 Section

```javascript
var html = Components.borderedSection('配置详情', configContent, {
  spacing: 'spacious'
});
```

### 英雄区 Section

```javascript
var html = Components.heroSection('欢迎', heroContent, {
  icon: '🚀'
});
```

### 交互控制

```javascript
DesignSection.initAll();
DesignSection.collapse('section-abc123');
DesignSection.expand('section-abc123');
DesignSection.toggle('section-abc123');
DesignSection.isCollapsed('section-abc123');
DesignSection.expandAll();
DesignSection.collapseAll();
```

## 变体说明

| 变体 | 类名 | 说明 | 适用场景 |
|------|------|------|---------|
| default | ds-section--default | 标准标题+内容 | 通用内容分组 |
| collapsible | ds-section--collapsible | 可折叠，带箭头动画 | 可选内容、高级设置 |
| accent | ds-section--accent | 左侧彩色边框 | 强调重要区域 |
| bordered | ds-section--bordered | 完整边框+背景头部 | 卡片式内容块 |
| hero | ds-section--hero | 大标题+主色下划线 | 页面主区域 |

## 浏览器兼容性

| 浏览器 | 最低版本 | 备注 |
|--------|---------|------|
| Chrome | 51+ | 完全支持 |
| Firefox | 50+ | 完全支持 |
| Safari | 10+ | 完全支持 |
| Edge | 16+ | 完全支持 |
| IE 11 | - | 部分支持（keyCode 回退、无 NodeList.forEach） |

## 常见问题

### Q: 为什么 Section 内容显示为空？

确保 API 端点 `/api/design/presets` 返回了正确的数据。检查浏览器控制台是否有网络错误。

### Q: 折叠动画不生效？

1. 确保 `DesignSection.initAll()` 在 DOM 渲染后调用
2. 检查 CSS 中 `ds-section--collapsible` 样式是否加载
3. 某些旧浏览器不支持 CSS transition，会直接切换显示/隐藏

### Q: 如何自定义 Section 样式？

通过 `className` 选项添加自定义 CSS 类：

```javascript
Components.section('标题', content, { className: 'my-custom-section' });
```

### Q: 如何获取 Section 的 DOM 元素？

每个 Section 都有唯一的 `id` 属性：

```javascript
var el = document.getElementById('section-abc123');
```

### Q: accent 变体的强调色不显示？

确保 `accentColor` 参数与支持的值匹配：primary/success/warning/danger/purple/cyan。使用 validate API 验证配置：

```
GET /api/design/section/validate?variant=accent&accentColor=primary
```
