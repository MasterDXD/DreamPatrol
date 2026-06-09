# 驭·桌面伙伴

Harness Engineering 多Agent框架的桌面伙伴应用，基于 Electron v36 构建。

## 功能特性

- **CSS角色系统**：4种形象（经典机器人、赛博猫咪、幽灵精灵、迷你龙），零刷新切换
- **AI状态机**：31种状态（待机/思考/打字/建造/杂耍/指挥/优化中/已收敛/审查中/架构中/验证中/设计中/集成中/自愈中/适配中/记忆加载/技能执行/外部连接/任务分发/自动化/规格编写/文档同步/反问澄清/计划制定/检索思想/提炼思想/查重去冗/更新记忆/报错/完成/通知）
- **成长系统**：XP经验值、7阶段等级（萌芽→神话）、13个成就
- **交互系统**：眼球追踪、眨眼、点击/双击/长按/拖动、右键菜单
- **特效系统**：粒子、五彩纸屑、气泡、火花、彩虹、爱心、音符
- **闲置行为**：扫地/杂耍/搬运，4阶段睡眠（打哈欠→打盹→倒下→深睡→惊醒弹起）
- **权限审批**：浮动权限卡片，30秒超时自动拒绝
- **时间感知**：根据时段问候和改变环境光环
- **窗口管理**：拖动、贴边自动隐藏、点击穿透、位置持久化
- **音效反馈**：Web Audio API 提示音
- **拖放文件**：接收文件触发交互
- **全局快捷键**：Ctrl+Shift+H 显示/隐藏，Ctrl+Shift+Y/N 批准/拒绝权限
- **免打扰/极简模式**
- **Tooltip悬浮提示**
- **眼睛表情**：爱心眼/眩晕眼/螺旋眼/星星眼
- **五配置表体系**：Vibe能力（审查力/系统思维/产品感/审美）+ SuperAgent（全流程集成/自主迭代/轻量适配）+ 扩展层（CLAUDE.md/Skills/MCP/Subagents/Hooks）+ SDD实践（规格文档/同步机制/反问机制/计划文档）+ 思想钻石（检索思想/提炼思想/查重去冗/更新记忆）

## 快速开始

```bash
cd desktop-companion
npm install
npm start
```

## 项目结构

```
desktop-companion/
├── main.js              # Electron主进程：窗口创建、系统托盘、IPC处理、API代理
├── preload.js           # 预加载脚本：contextBridge暴露16个API方法
├── package.json         # 项目配置
├── src/
│   ├── index.html       # 主UI结构：角色、面板、菜单、权限卡片
│   ├── companion.js     # 交互逻辑：拖动、点击、AI状态、成长系统、特效
│   ├── companion.css    # 样式和动画：4种皮肤、时间主题、30+关键帧动画
│   └── icon.png         # 应用图标
└── docs/
    ├── api-reference.md    # API参考文档：IPC通道、渲染进程API、事件通道、数据结构
    ├── user-guide.md       # 用户手册：操作指南、功能说明、常见问题
    └── development-guide.md # 开发指南：架构、扩展、调试、代码规范
```

## 技术栈

- **Electron v36**：透明无边框窗口、系统托盘、IPC通信
- **原生HTML5 + CSS3 + Vanilla JS**：无框架依赖
- **Node.js http模块**：API代理（无Express/Koa）
- **Web Audio API**：音效反馈
- **localStorage**：设置和成长数据持久化

## 安全架构

- **上下文隔离**：`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，渲染进程无法直接访问 Node.js API
- **CSP 安全策略**：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`，禁止内联脚本和外部资源加载
- **API 端点校验**：所有代理请求必须以 `/api/` 开头，防止 SSRF 和路径遍历
- **XSS 防护**：所有动态内容使用 `textContent` 渲染，禁止 `innerHTML` 拼接未转义文本
- **输入验证**：枚举参数（mood/type/skin/AI状态）均通过白名单验证
- **IPC 监听器管理**：使用 `removeListener` 精确清理，防止内存泄漏和重复触发
- **递归防护**：`checkAchievements` 使用重入守卫标志防止无限递归
- **数据校验**：localStorage 恢复数据经过严格的类型和范围验证

## 右键菜单功能

| 分类 | 功能 |
|------|------|
| 基础 | 打开控制台、状态面板、角色状态、技能状态 |
| 形象 | 经典机器人、赛博猫咪、幽灵精灵、迷你龙 |
| 技能表演 | 跳舞、变魔术、唱歌、彩虹光环、星星眼、转圈圈 |
| 眼睛表情 | 爱心眼、眩晕眼、螺旋眼、正常眼 |
| 动作 | 跳跃、摇晃、鞠躬、庆祝、发抖 |
| 心情 | 开心、平静、活力 |
| AI状态 | 思考中、打字中、建造中、杂耍中、指挥中、优化中、已收敛、审查中、架构中、验证中、设计中、集成中、自愈中、适配中、记忆加载、技能执行、外部连接、任务分发、自动化、规格编写、文档同步、反问澄清、计划制定、检索思想、提炼思想、查重去冗、更新记忆、报错、完成、通知、待机 |
| 模式 | 自由漫游、极简模式、免打扰 |
| 高级 | 点击穿透、贴边自动隐藏、测试权限卡片 |
| 系统 | 回到默认位置、隐藏伙伴、退出 |
| Vibe能力 | 🔍审查力、🏗️系统思维、🎯产品感、✨审美 |
| SuperAgent | 🔗全流程集成、🔄自主迭代、⚡轻量适配 |
| 扩展层 | 🧠CLAUDE.md、📦Skills、🔌MCP、👥Subagents、⚙️Hooks |
| SDD实践 | 📋规格文档、🔄同步机制、❓反问机制、📝计划文档 |
| 思想钻石 | 💎检索思想、✨提炼思想、🔍查重去冗、🧠更新记忆 |

## 快捷命令

| 按钮 | 命令 | 触发技能链 |
|------|------|-----------|
| 📋 规划 | /plan | brainstorming → requirement-analysis → architecture-design |
| 🔨 构建 | /build | tdd-implement → module-development |
| 🔍 审查 | /review | code-review → security-audit |
| 🧪 测试 | /test | integration-testing |
| 🚀 部署 | /deploy | verification-before-completion → deployment |
| 🐛 调试 | /debug | systematic-debugging → bug-fix |
| ♻️ 重构 | /refactor | refactor-code |
| ⚡ 优化 | /optimize | performance-optimization |
| 📝 规格 | /spec | requirement-analysis → architecture-design |

## 成就列表

| 成就 | 条件 | XP奖励 |
|------|------|--------|
| 🤝 初次见面 | 首次启动 | 20 |
| 🥰 摸摸达人 | 累计点击50次 | 20 |
| ✈️ 翱翔天际 | 拖动10次 | 20 |
| 💃 舞蹈之王 | 跳舞5次 | 20 |
| ⭐ 初露锋芒 | 达到5级 | 20 |
| 🌟 茁壮成长 | 达到10级 | 20 |
| 💎 精英战士 | 达到20级 | 20 |
| 🎨 形象收藏家 | 切换过所有4种形象 | 20 |
| 🚶 漫游者 | 自由漫游3次 | 20 |
| 🦉 夜猫子 | 深夜(22:00-6:00)使用 | 20 |
| 📁 文件接收者 | 拖放文件到伙伴 | 20 |
| 🔐 权限审批者 | 批准3次权限请求 | 20 |
| 🐦 早起鸟儿 | 早晨(6:00-9:00)使用 | 20 |

## 配置说明

所有设置通过 `localStorage` 持久化，存储键为 `companion-settings`：

```json
{
  "skin": "robot",
  "mood": "happy",
  "isRoaming": false,
  "minimalMode": false,
  "dndMode": false,
  "clickThrough": false,
  "edgeAutoMinimal": false,
  "growth": {
    "level": 1,
    "xp": 0,
    "totalXp": 0,
    "totalInteractions": 0,
    "petCount": 0,
    "dragCount": 0,
    "danceCount": 0,
    "roamCount": 0,
    "skinsUsed": ["robot"],
    "achievements": [],
    "fileDropCount": 0,
    "permApproved": 0,
    "permDenied": 0
  }
}
```

窗口位置通过 `companion-window-pos` 单独存储。

## 开发指南

### 添加新形象

1. 在 `companion.js` 的 `SKINS` 对象中添加新条目
2. 在 `companion.css` 中添加 `.skin-{name}` CSS变量覆盖
3. 在 `index.html` 右键菜单中添加切换项
4. 在 `handleMenuAction` 中添加处理逻辑

### 添加新动画

1. 在 `companion.css` 中定义 `@keyframes` 动画
2. 在 `companion.js` 中添加触发函数
3. 在 `clearFx` 中添加类名清理
4. 在右键菜单中添加触发项

### 添加新成就

1. 在 `ACHIEVEMENTS` 对象中添加新条目，包含 `name`、`desc`、`check` 函数
2. 在 `index.html` 的成就列表中添加 DOM 元素
3. `checkAchievements` 会自动检测并解锁

## 全局快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+Shift+H | 显示/隐藏伙伴窗口 |
| Ctrl+Shift+Y | 批准权限请求 |
| Ctrl+Shift+N | 拒绝权限请求 |
| Escape | 关闭菜单/面板/权限卡片 |

## 文档导航

| 文档 | 说明 |
|------|------|
| [API 参考文档](docs/api-reference.md) | IPC 通道、渲染进程 API、事件通道、数据结构、存储架构、CSS 变量 |
| [用户手册](docs/user-guide.md) | 安装启动、操作指南、形象/成长/AI状态详解、常见问题 |
| [开发指南](docs/development-guide.md) | 架构概览、扩展指南、构建打包、调试技巧、代码规范 |
