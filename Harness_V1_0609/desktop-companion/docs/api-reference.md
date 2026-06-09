# API 参考文档

驭·桌面伙伴的完整 API 参考文档，涵盖 IPC 通道、渲染进程 API、事件通道、后端代理、数据结构和存储架构。

## IPC 通道列表

主进程（main.js）与预加载脚本（preload.js）之间的 IPC 通信通道。所有通道均使用 `ipcMain.handle` / `ipcRenderer.invoke` 的 Promise 模式。

### proxy-api

代理 API 请求到 Harness 后端。

- **通道**：`proxy-api`
- **参数**：`endpoint` (string) — 必须以 `/api/` 开头
- **返回值**：`{ ok: boolean, data: object|null, status: number }` 或 `{ ok: false, data: null, error: string }`
- **安全校验**：端点必须以 `/api/` 开头，且路径中不含 `..`（防止路径遍历），否则返回 `{ ok: false, error: 'Endpoint not allowed' }`
- **超时**：5秒，超时后 reject 并返回 `{ ok: false, error: 'timeout' }`
- **响应大小限制**：5MB（`MAX_RESPONSE_SIZE`），超出时中止请求并返回 `{ ok: false, error: 'response too large' }`

```javascript
const result = await window.companionAPI.proxyAPI('/api/health');
// result: { ok: true, data: { status: 'active', version: '2.7.133', ... }, status: 200 }
```

### get-companion-status

获取伙伴状态信息。

- **通道**：`get-companion-status`
- **返回值**：`{ status: string, version: string, apiConnected: boolean }`
- **说明**：`apiConnected` 通过实际请求 `/api/health` 判断，非缓存值

### toggle-window

切换窗口显示/隐藏。

- **通道**：`toggle-window`
- **返回值**：`void`

### open-dashboard

在默认浏览器中打开控制台。

- **通道**：`open-dashboard`
- **返回值**：`void`
- **说明**：使用 `shell.openExternal` 打开 `http://localhost:3210`

### send-command

发送斜杠命令到 Harness 后端。

- **通道**：`send-command`
- **参数**：`cmd` (string) — 命令字符串，如 `/plan`、`/build`
- **返回值**：`{ ok: boolean, data?: object, error?: string }`
- **说明**：使用 POST 方法发送到 `/api/command`
- **安全校验**：端点硬编码为 `/api/command`，不接受渲染进程传入的 endpoint 参数，从根源上避免路径注入风险（与 `proxy-api` 的动态 endpoint 校验不同，`send-command` 无需运行时校验即保证请求仅发往 `/api/` 前缀端点）

### move-window

相对移动窗口位置。

- **通道**：`move-window`
- **参数**：`dx` (number), `dy` (number) — 相对偏移量（像素），正值向右/下
- **返回值**：`void`
- **说明**：坐标会通过 `Math.round()` 取整

### get-window-bounds

获取窗口边界信息。

- **通道**：`get-window-bounds`
- **返回值**：`{ x: number, y: number, width: number, height: number } | null`
- **说明**：窗口不存在时返回 `null`

### reset-position

重置窗口到默认位置（屏幕右下角）。

- **通道**：`reset-position`
- **返回值**：`void`
- **默认位置**：`x = screenWidth - 310, y = screenHeight - 420`

### quit-app

退出应用。

- **通道**：`quit-app`
- **返回值**：`void`
- **说明**：调用 `app.quit()`，触发 `will-quit` 事件注销全局快捷键

### set-ignore-mouse-events

设置窗口是否忽略鼠标事件（点击穿透）。

- **通道**：`set-ignore-mouse-events`
- **参数**：`ignore` (boolean), `options` (object|undefined) — `{ forward: true }` 时转发鼠标移动事件到下层窗口
- **返回值**：`void`
- **说明**：用于透明区域的点击穿透，配合渲染进程的 `mousemove` 检测实现动态穿透

### get-window-position

获取窗口当前位置。

- **通道**：`get-window-position`
- **返回值**：`[number, number] | null` — `[x, y]` 坐标数组
- **说明**：窗口不存在时返回 `null`

### get-screen-size

获取主屏幕工作区尺寸。

- **通道**：`get-screen-size`
- **返回值**：`{ width: number, height: number }`
- **兜底值**：异常时返回 `{ width: 1920, height: 1080 }`

### set-window-size

设置窗口尺寸。

- **通道**：`set-window-size`
- **参数**：`w` (number), `h` (number) — 宽度和高度（像素）
- **参数校验**：`w` 和 `h` 必须为 number 类型，且满足 `100 ≤ w ≤ 4000`、`100 ≤ h ≤ 4000`，不合法时静默返回（不修改窗口尺寸）。内部使用 `Math.round()` 取整
- **返回值**：`void`
- **安全说明**：防止渲染进程传入0/负数/超大值导致窗口异常

## 渲染进程 API

通过 `window.companionAPI` 暴露给渲染进程的所有方法。

### 请求类 API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `proxyAPI(endpoint)` | `endpoint: string` | `Promise<Object>` | 代理API请求到后端 |
| `getStatus()` | 无 | `Promise<Object>` | 获取伙伴状态（含API连接状态） |
| `sendCommand(cmd)` | `cmd: string` | `Promise<Object>` | 发送斜杠命令到后端 |

### 窗口控制 API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `toggleWindow()` | 无 | `Promise<void>` | 切换窗口显隐 |
| `openDashboard()` | 无 | `Promise<void>` | 在浏览器打开控制台 |
| `moveWindow(dx, dy)` | `dx: number, dy: number` | `Promise<void>` | 相对移动窗口 |
| `getWindowBounds()` | 无 | `Promise<Object|null>` | 获取窗口边界 |
| `getWindowPosition()` | 无 | `Promise<Array|null>` | 获取窗口位置 `[x, y]` |
| `getScreenSize()` | 无 | `Promise<Object>` | 获取屏幕尺寸 |
| `setWindowSize(w, h)` | `w: number, h: number` | `Promise<void>` | 设置窗口尺寸 |
| `resetPosition()` | 无 | `Promise<void>` | 重置到默认位置 |
| `setIgnoreMouseEvents(ignore, options)` | `ignore: boolean, options?: object` | `Promise<void>` | 设置点击穿透 |

### 应用控制 API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `quitApp()` | 无 | `Promise<void>` | 退出应用 |

### 事件监听 API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `onSpeech(callback)` | `(text: string) => void` | `void` | 监听语音事件，每次调用移除旧监听器 |
| `onPermissionRequest(callback)` | `(data: { agent: string, action: string }) => void` | `void` | 监听权限请求，每次调用移除旧监听器 |
| `onPermissionShortcut(callback)` | `(action: 'approve' \| 'deny') => void` | `void` | 监听快捷键权限操作，每次调用移除旧监听器 |

### 使用示例

```javascript
var api = window.companionAPI;

api.proxyAPI('/api/health').then(function (res) {
  console.log('Health:', res.ok, res.data);
});

api.onSpeech(function (text) {
  console.log('Speech:', text);
});

api.onPermissionRequest(function (data) {
  console.log('Permission:', data.agent, data.action);
});

api.getWindowPosition().then(function (pos) {
  if (pos) console.log('Window at:', pos[0], pos[1]);
});
```

### Demo 模式回退

当 `window.companionAPI` 不可用时（如在普通浏览器中打开），渲染进程会自动使用 demo 回退对象：

```javascript
var api = window.companionAPI || {
  proxyAPI: function () { return Promise.reject(new Error('不可用')); },
  getStatus: function () { return Promise.resolve({ status: 'demo' }); },
  // ... 其他方法提供空实现
};
```

## 事件通道

主进程向渲染进程发送的事件（使用 `webContents.send`）。

### companion-speech

主进程发送语音文本到渲染进程。

- **触发场景**：系统托盘菜单点击"角色状态"或"技能状态"
- **数据格式**：`text: string`
- **监听方式**：`api.onSpeech(callback)`

### permission-request

主进程发送权限请求到渲染进程。

- **触发场景**：AI Agent 请求权限操作
- **数据格式**：`{ agent: string, action: string }`
- **监听方式**：`api.onPermissionRequest(callback)`

### permission-shortcut

主进程转发全局快捷键权限操作到渲染进程。

- **触发场景**：用户按下 Ctrl+Shift+Y（批准）或 Ctrl+Shift+N（拒绝）
- **数据格式**：`action: string` — `'approve'` 或 `'deny'`
- **监听方式**：`api.onPermissionShortcut(callback)`

## Harness 后端 API 代理

桌面伙伴通过 `proxyAPI` 代理请求到 Harness 后端（默认 `http://localhost:3210`）。所有请求超时5秒。

### API 认证

主进程通过 `HARNESS_API_TOKEN` 环境变量读取认证令牌，自动附加到所有代理请求：

- **GET 请求**：`Authorization: Bearer <token>` 请求头
- **POST 请求**：`Authorization: Bearer <token>` 请求头（与 `Content-Type` 一同发送）
- **未配置令牌**：`HARNESS_API_TOKEN` 为空字符串时，不发送 `Authorization` 头，后端以匿名模式处理
- **配置方式**：启动 Electron 前设置环境变量 `export HARNESS_API_TOKEN=your-token-here`

```javascript
// main.js 中的认证实现
const HARNESS_API_TOKEN = process.env.HARNESS_API_TOKEN || '';

// GET 请求
const headers = HARNESS_API_TOKEN ? { Authorization: `Bearer ${HARNESS_API_TOKEN}` } : {};
const req = http.get(url, { headers }, (res) => { /* ... */ });

// POST 请求
const reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
if (HARNESS_API_TOKEN) reqHeaders.Authorization = `Bearer ${HARNESS_API_TOKEN}`;
```

### GET /api/health

健康检查端点。

- **返回值**：`{ status: string, version: string, phase: string, tokenUsage: number, tokenBudget: number }`
- **phase 字段**：当前执行阶段（从 `phaseOrchestrator.getCurrentPhase()` 获取），如 `requirement-analysis`、`module-development` 等
- **tokenUsage/tokenBudget**：Token 使用量和预算（从 `tokenManager` 获取），用于面板信息显示
- **version**：从 `package.json` 读取的框架版本号
- **轮询频率**：每5秒
- **用途**：判断后端连接状态，更新连接指示器，显示阶段和Token信息

### GET /api/agents

获取 Agent 列表。

- **返回值**：`{ agents: Array<{ id: string, name: string, role: string, status: string, running: boolean }> }`
- **兼容处理**：同时支持 `data.agents` 和 `data` 直接为数组两种格式
- **活跃判断**：`status === 'active' || status === 'running' || running === true`
- **status 字段**：从 `agentMonitor.getAllStatuses()` 获取，值为 `'active'`、`'running'`、`'idle'` 等
- **name 字段**：Agent 显示名称，优先取 `name`，回退到 `role`，再回退到 `id`
- **running 字段**：布尔值，`status === 'active' || status === 'running'` 时为 `true`
- **旧API兼容**：若Agent对象无 `status` 字段，同时检查 `state` 字段；数组元素类型守卫过滤非对象元素

### GET /api/skills

获取技能列表。

- **返回值**：`{ skills: Array<{ id: string, name: string, verified: boolean }> }` 或 `Object`（技能分类对象）
- **兼容处理**：数组取 `length`，对象取 `Object.keys().length`

### POST /api/command

发送命令到后端。

- **请求体**：`{ command: string }`
- **返回值**：`{ ok: boolean, data?: object }`
- **Content-Type**：`application/json`

### GET /api/optimization/status

获取优化循环状态。

- **返回值**：`{ available: boolean, status?: string, currentIteration?: number, bestScore?: number|null, bestIteration?: number|null, stagnationCounter?: number, plateauCounter?: number, strategyTrend?: string[], healthy?: boolean }`
- **status 枚举**：`idle` | `running` | `paused` | `stopped` | `converged` | `exhausted` | `failed`
- **轮询频率**：随健康检查一起轮询（每5秒）
- **用途**：桌面伙伴自动监控优化循环状态，切换 AI 状态和触发动画

### GET /api/optimization/progress

获取优化循环进度详情。

- **返回值**：`{ available: boolean, status?: string, currentIteration?: number, bestScore?: number|null, bestIteration?: number|null, lastScore?: number|null, convergenceStatus?: object, metricsHistory?: Array, stagnationCounter?: number, resourceUsed?: number, resourceBudget?: number|null, elapsed?: number, objective?: string }`
- **metricsHistory**：最近10次迭代的指标历史
- **convergenceStatus**：`{ status: string, threshold: number }` — `converged` | `stagnant` | `exhausted` | `not-converged`

### GET /api/optimization/journal

获取 MD 优化日志全文。

- **返回值**：`{ available: boolean, journal: string }`
- **journal**：Markdown 格式的优化日志，包含目标、约束、指标定义和每次迭代记录

## 数据结构参考

### STORAGE_KEYS — 存储键名常量

```javascript
var STORAGE_KEYS = {
  settings: 'companion-settings',
  windowPos: 'companion-window-pos',
};
```

- `settings` — 用户设置持久化键（皮肤、心情、成长数据等）
- `windowPos` — 窗口位置持久化键（x, y坐标）
- **使用规范**：所有 localStorage 操作必须通过 `STORAGE_KEYS.xxx` 引用键名，禁止硬编码字符串

### API_ENDPOINTS — API端点常量

```javascript
var API_ENDPOINTS = {
  health: '/api/health',
  agents: '/api/agents',
  skills: '/api/skills',
  optimizationStatus: '/api/optimization/status',
  optimizationProgress: '/api/optimization/progress',
  optimizationJournal: '/api/optimization/journal',
};
```

- `health` — 后端健康检查端点
- `agents` — Agent状态查询端点
- `skills` — 技能列表查询端点
- `optimizationStatus` — 优化循环状态查询端点
- `optimizationProgress` — 优化循环进度查询端点
- `optimizationJournal` — 优化循环日志查询端点
- **使用规范**：所有 `api.proxyAPI()` 调用必须通过 `API_ENDPOINTS.xxx` 引用端点，禁止硬编码字符串

### SKINS — 皮肤配置

```javascript
var SKINS = {
  robot: { name: '经典机器人', badge: '驭', speech: { greet: [...], click: [...] } },
  cat:   { name: '赛博猫咪',   badge: '喵', speech: { greet: [...], click: [...] } },
  ghost: { name: '幽灵精灵',   badge: '幽', speech: { greet: [...], click: [...] } },
  dragon:{ name: '迷你龙',     badge: '龙', speech: { greet: [...], click: [...] } },
};
```

- `name` — 显示名称
- `badge` — 品牌标识文字
- `speech.greet` — 专属问候语数组
- `speech.click` — 专属点击语数组

### STAGES — 成长阶段

| minLevel | 名称 | 颜色 |
|----------|------|------|
| 1 | 萌芽 | `#94a3b8` |
| 5 | 初生 | `#34d399` |
| 10 | 成长 | `#22d3ee` |
| 15 | 精英 | `#818cf8` |
| 20 | 大师 | `#a78bfa` |
| 30 | 传奇 | `#fbbf24` |
| 50 | 神话 | `#f472b6` |

XP 公式：`xpForLevel(lv) = Math.floor(80 × 1.25^(lv-1))`

### AI_STATES — AI 状态配置

| 状态 | 标签 | bodyClass | mouthClass | 特效 |
|------|------|-----------|------------|------|
| idle | 待机 | — | — | — |
| thinking | 思考中 | ai-thinking | thinking | 思考气泡 |
| typing | 打字中 | ai-typing | happy | — |
| building | 建造中 | ai-building | mouth | — |
| juggling | 杂耍中 | idle-juggle | happy | 杂耍球 |
| conducting | 指挥中 | ai-conducting | happy | 杂耍球 |
| optimizing | 优化中 | ai-building | happy | 优化循环运行时自动触发 |
| converged | 已收敛 | ai-happy | happy | 五彩纸屑+升级音效 |
| reviewing | 审查中 | ai-reviewing | mouth thinking | 代码审查中... |
| architecting | 架构中 | ai-architecting | mouth thinking | 架构设计中... |
| validating | 验证中 | ai-validating | mouth happy | 需求验证中... |
| designing | 设计中 | ai-designing | mouth happy | 设计打磨中... |
| integrating | 集成中 | ai-integrating | mouth happy | 工具集成中... |
| selfhealing | 自愈中 | ai-selfhealing | mouth thinking | 策略调整中... |
| adapting | 适配中 | ai-adapting | mouth happy | 模型切换中... |
| memorizing | 记忆加载 | ai-memorizing | mouth thinking | 加载项目记忆... |
| skilling | 技能执行 | ai-skilling | mouth happy | 执行技能流程... |
| connecting | 外部连接 | ai-connecting | mouth happy | 连接外部服务... |
| delegating | 任务分发 | ai-delegating | mouth happy | 分发子任务... |
| automating | 自动化 | ai-automating | mouth | 触发自动化... |
| specifying | 规格编写 | ai-specifying | mouth thinking | 编写规格文档... |
| syncing | 文档同步 | ai-syncing | mouth | 同步文档与代码... |
| questioning | 反问澄清 | ai-questioning | mouth surprised | 需要澄清需求... |
| planning | 计划制定 | ai-planning | mouth thinking | 制定执行计划... |
| error | 报错 | ai-error | sad | 汗滴+感叹号+错误音 |
| happy | 完成 | ai-happy | happy | 五彩纸屑+粒子+成功音 |
| notification | 通知 | ai-notification | surprised | 通知标志+权限音 |

### VIBE_CAPABILITIES 配置表

Vibe Coding 四大底层能力配置，每个能力映射到对应的AI状态和Harness Skill：

| 键 | 名称 | 图标 | 描述 | 主题色 | 对应Skill |
|----|------|------|------|--------|----------|
| reviewing | 审查力 | 🔍 | AI代码视为初级产出，逐段审查守住质量底线 | #f87171 | code-review |
| architecting | 系统思维 | 🏗️ | 先规划蓝图再分模块交付，架构决定产出档次 | #818cf8 | architecture-design |
| validating | 产品感 | 🎯 | 聚焦核心需求验证，避免堆砌无用功能 | #34d399 | requirement-analysis |
| designing | 审美 | ✨ | UI设计直接影响留存，明确好设计的标准 | #fbbf24 | taste-skill |

**activateVibeCapability(capKey)** 函数：
- **参数**：`capKey` (string) — VIBE_CAPABILITIES 中的键名
- **行为**：设置AI状态 → 显示语音气泡 → 弹出Toast → 粒子爆发 → 加5XP → 记录事件日志
- **验证**：`capKey` 不在 VIBE_CAPABILITIES 中时静默返回
- **特殊效果**：`designing` 和 `architecting` 额外触发 sparkle 特效

### SUPERAGENT_CAPABILITIES 配置表

SuperAgent 三大核心能力配置，每个能力映射到对应的AI状态和Harness Skill：

| 键 | 名称 | 图标 | 描述 | 主题色 | 对应Skill |
|----|------|------|------|--------|----------|
| integrating | 全流程集成 | 🔗 | 多任务全流程覆盖，无需切换工具 | #60a5fa | web-interaction |
| selfhealing | 自主迭代 | 🔄 | 卡点自调整策略，无需人工干预 | #a78bfa | optimization-loop |
| adapting | 轻量适配 | ⚡ | 多模型兼容切换，本地云端无缝部署 | #2dd4bf | ai-prompting |

**activateSuperAgent(capKey)** 函数：
- **参数**：`capKey` (string) — SUPERAGENT_CAPABILITIES 中的键名
- **行为**：设置AI状态 → 显示语音气泡 → 弹出Toast → 粒子爆发 → 加5XP → 记录事件日志
- **验证**：`capKey` 不在 SUPERAGENT_CAPABILITIES 中时静默返回
- **特殊效果**：`integrating` 和 `selfhealing` 额外触发 sparkle 特效

### EXTENSION_LAYERS 配置表

Claude Code 5层扩展功能配置，每层映射到AI状态、Harness Skill和上下文成本等级：

| 键 | 名称 | 图标 | 描述 | 主题色 | 对应Skill | 成本 | 触发场景 |
|----|------|------|------|--------|----------|------|---------|
| memorizing | CLAUDE.md | 🧠 | 长期记忆，项目约定自动加载 | #f97316 | session-start-hook | 5 | 两次搞错项目约定时写入 |
| skilling | Skills | 📦 | 自定义技能包，多步骤流程封装 | #8b5cf6 | skill-router | 3 | 同一流程重复三次时封装 |
| connecting | MCP | 🔌 | 连接外部服务，查数据库发消息 | #06b6d4 | web-interaction | 2 | 反复从浏览器复制数据时添加 |
| delegating | Subagents | 👥 | 任务拆解并行，隔离辅助输出 | #ec4899 | dispatching-parallel | 2 | 辅助任务刷爆对话时隔离 |
| automating | Hooks | ⚙️ | 事件触发自动化，无需思考 | #84cc16 | verification-before-completion | 1 | 希望某操作自动发生时配置 |

**activateExtension(extKey)** 函数：
- **参数**：`extKey` (string) — EXTENSION_LAYERS 中的键名
- **行为**：设置AI状态 → 显示语音气泡 → 弹出Toast → 粒子爆发 → 加5XP → 记录事件日志（含成本和触发场景）
- **验证**：`extKey` 不在 EXTENSION_LAYERS 中时静默返回
- **特殊效果**：`memorizing` 和 `skilling` 额外触发 sparkle 特效
- **日志格式**：`扩展层激活: {name} (成本:{cost}/5 触发:{trigger})`

### SDD_PRACTICES 配置表

规格驱动开发（SDD）4大核心实践配置，按进化阶段排列：

| 键 | 名称 | 图标 | 描述 | 主题色 | 对应Skill | 成本 | 进化阶段 | 触发场景 |
|----|------|------|------|--------|----------|------|---------|---------|
| specifying | 规格文档 | 📋 | 确保需求理解一致，先写规格再写代码 | #ef4444 | requirement-analysis | 4 | 2 | 每次给AI提需求都要重复解释时编写 |
| syncing | 同步机制 | 🔄 | 先改文档再写代码，保障文档与事实一致 | #f59e0b | documentation | 3 | 3 | 直接改代码忘记更新文档时建立 |
| questioning | 反问机制 | ❓ | 强制AI不懂就问，拦截模糊需求 | #10b981 | brainstorming | 2 | 4 | 功能复杂容易漏细节时启用 |
| planning | 计划文档 | 📝 | 多文件修改先出计划，人类审核后再执行 | #6366f1 | architecture-design | 3 | 5 | 修改涉及多文件时使用 |

**activateSDD(sddKey)** 函数：
- **参数**：`sddKey` (string) — SDD_PRACTICES 中的键名
- **行为**：设置AI状态 → 显示语音气泡 → 弹出Toast → 粒子爆发 → 加5XP → 记录事件日志（含进化阶段和成本）
- **验证**：`sddKey` 不在 SDD_PRACTICES 中时静默返回
- **特殊效果**：`specifying` 和 `planning` 额外触发 sparkle 特效
- **日志格式**：`SDD实践激活: {name} (进化阶段:{evolution}/5 成本:{cost}/5)`
- **evolution 字段**：表示SDD进化路径中的阶段编号（1=裸跑, 2=规格文档, 3=同步机制, 4=反问机制, 5=计划文档）

### 状态优先级机制

AI状态分为手动状态和自动状态，具有不同的优先级：

| 类型 | 触发方式 | 状态列表 | 优先级 |
|------|---------|---------|--------|
| 手动状态 | 右键菜单/面板卡片点击 | reviewing, architecting, validating, designing, integrating, selfhealing, adapting | 高（不被API轮询覆盖） |
| 自动状态 | API轮询自动触发 | thinking, typing, building, juggling, conducting, optimizing, converged, error, happy, notification | 低（可被手动状态覆盖） |

**manualState 标志**：
- 手动激活 Vibe/SuperAgent 能力时设为 `true`
- `setAIState()` 切换到非手动状态时自动设为 `false`
- `resetIdle()` 唤醒时清除为 `false`
- API轮询（`processAgentData`、`pollOptimizationStatus`）检测到 `manualState === true` 时跳过状态切换
- 用户从空闲唤醒时自动清除手动状态，恢复API驱动的自动状态

### ACHIEVEMENTS — 成就定义

每个成就包含 `name`（名称）、`desc`（描述）、`check(growth)`（检查函数，接收成长数据返回布尔值）。解锁奖励固定 20 XP。

### state — 运行时状态

核心状态字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `apiConnected` | boolean | 后端API连接状态 |
| `currentAgent` | string\|null | 当前活跃Agent ID |
| `mood` | string | 心情：'happy'/'calm'/'energetic' |
| `aiState` | string | AI状态机当前状态 |
| `isDragging` | boolean | 是否正在拖动 |
| `isIdle` | boolean | 是否处于闲置状态 |
| `sleepStage` | number | 睡眠阶段（0-4） |
| `currentSkin` | string | 当前皮肤ID |
| `isRoaming` | boolean | 是否正在漫游 |
| `minimalMode` | boolean | 极简模式 |
| `dndMode` | boolean | 免打扰模式 |
| `clickThroughEnabled` | boolean | 点击穿透 |
| `edgeAutoMinimal` | boolean | 贴边自动隐藏 |
| `intervals` | Array | 定时器引用数组，存储所有 `setInterval` 返回的 ID，用于统一清理（健康轮询、窗口位置保存、时间主题切换、眨眼等） |
| `roamWalkInterval` | number\|null | 漫游行走定时器 ID（`setInterval` 返回值），`stopRoaming()` 时通过 `clearInterval` 清除并置为 `null` |
| `growth` | object | 成长数据（level/xp/achievements等） |

## localStorage 存储

### companion-settings

主设置存储键，JSON 格式：

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

- **写入时机**：每次设置变更时立即写入
- **读取时机**：`init()` 时通过 `loadSettings()` 读取
- **异常处理**：读写均包裹 try/catch，失败时静默使用默认值
- **数据验证**：`loadSettings()` 对 growth 数据执行严格的类型和范围校验：
  - 数值字段（level/xp/totalXp 等）：验证 `typeof === 'number'` 且非负（level 必须 > 0），不合法时回退到默认值
  - 数组字段（skinsUsed/achievements）：使用 `Array.isArray()` 验证，非数组时回退到默认值
  - 防御场景：localStorage 被篡改、手动编辑 JSON 引入非法类型、旧版本数据格式不兼容

### companion-window-pos

窗口位置存储键，JSON 格式：

```json
{ "x": 1610, "y": 660 }
```

- **写入时机**：每5秒自动保存当前位置
- **读取时机**：`init()` 时通过 `restoreWindowPosition()` 恢复
- **边界校验**：恢复时检查坐标是否在屏幕范围内（`x >= 0 && x < screenWidth - 50 && y >= 0 && y < screenHeight - 50`），超出范围则放弃恢复，防止窗口出现在屏幕不可见区域；同时检查保存坐标与当前坐标是否相同，相同则跳过移动

## CSS 自定义属性

### 全局变量

| 变量 | 值 | 用途 |
|------|-----|------|
| `--primary` | `#818cf8` | 主色调（靛蓝） |
| `--primary-light` | `#c7d2fe` | 主色调浅色 |
| `--primary-deep` | `#6366f1` | 主色调深色 |
| `--success` | `#34d399` | 成功色（翠绿） |
| `--warning` | `#fbbf24` | 警告色（琥珀） |
| `--danger` | `#f87171` | 危险色（红色） |
| `--purple` | `#a78bfa` | 紫色 |
| `--cyan` | `#22d3ee` | 青色 |
| `--pink` | `#f472b6` | 粉色 |
| `--surface` | `rgba(15,23,42,.92)` | 表面背景 |
| `--surface2` | `rgba(30,41,59,.78)` | 次表面背景 |

### 设计系统变量

| 变量 | 值 | 用途 |
|------|-----|------|
| `--radius-sm` | `8px` | 小圆角（按钮、输入框） |
| `--radius-md` | `12px` | 中圆角（卡片内部） |
| `--radius-lg` | `16px` | 大圆角（面板、菜单、权限卡片） |
| `--radius-xl` | `24px` | 超大圆角（角色头部） |
| `--shadow-sm` | 3层软阴影 | 小阴影（按钮hover） |
| `--shadow-md` | 3层软阴影 | 中阴影（浮动元素） |
| `--shadow-lg` | 3层软阴影 | 大阴影（面板、卡片） |
| `--shadow-glow` | 皮肤色发光 | 主题发光阴影 |
| `--font-display` | SF Pro Display | 展示字体 |
| `--font-body` | SF Pro Text | 正文字体 |
| `--font-mono` | SF Mono | 等宽字体 |
| `--grain-opacity` | `.03` | 噪点纹理透明度 |
| `--stagger-delay` | `60ms` | 交错渐显延迟间隔 |

### 皮肤变量（--skin-*）

通过 `.skin-{name}` 选择器覆盖，实现零刷新换肤：

| 变量 | robot | cat | ghost | dragon |
|------|-------|-----|-------|--------|
| `--skin-accent` | `--primary` | `--success` | `--purple` | `--warning` |
| `--skin-glow` | `--primary-glow` | `--success-glow` | `--purple-glow` | `--warning-glow` |
| `--skin-cheek` | `rgba(244,114,182,.28)` | `rgba(251,191,36,.25)` | `rgba(167,139,250,.25)` | `rgba(248,113,113,.25)` |

### 时间主题类

时间主题影响所有皮肤（不再仅限 robot 皮肤），`ambient-ring` 和 `aura` 的颜色会根据时段变化：

| CSS类 | 时段 | 效果 |
|-------|------|------|
| `:root.time-morning` | 6:00-12:00 | ambient-ring 和 aura 金色；companion-body `brightness(1.03) saturate(1.05)`，悬停恢复默认 |
| `:root.time-afternoon` | 12:00-18:00 | ambient-ring 和 aura 青色；companion-body `brightness(1.02) saturate(1.02)`，悬停恢复默认 |
| `:root.time-evening` | 18:00-22:00 | ambient-ring 和 aura 红色；companion-body `brightness(.97) saturate(1.05)`，悬停恢复默认 |
| `:root.time-night` | 22:00-6:00 | ambient-ring 和 aura 靛蓝；companion-body `brightness(.92) saturate(.85)`，悬停恢复默认 |

## 安全说明

### API 端点校验

`proxy-api`、`post-api` 和 `ipcMain.handle('proxy-api')` 三处端点校验逻辑已统一提取为公共函数 `isValidEndpoint`：

```javascript
function isValidEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false;
  try {
    var url = new URL(endpoint, 'http://localhost');
    var path = url.pathname;
    return path.startsWith('/api/') && !path.includes('..');
  } catch (_e) {
    return false;
  }
}
```

- **路径遍历防护**：使用 `new URL()` 规范化路径，检测 `..` 防止 `/api/../../etc/passwd` 类攻击
- **类型校验**：`typeof endpoint !== 'string'` 拦截非字符串输入
- **前缀校验**：规范化后的路径必须以 `/api/` 开头
- **URL构造安全化**：`proxyAPI`/`postAPI`中使用`new URL(endpoint, 'http://localhost').pathname`替代直接拼接endpoint，防止URL编码绕过（如`%2e%2e`双重编码）

主进程中各 IPC 通道使用该函数进行校验：

```javascript
ipcMain.handle('proxy-api', async (_event, endpoint) => {
  if (!isValidEndpoint(endpoint)) {
    return { ok: false, data: null, error: 'Endpoint not allowed' };
  }
  // ...
});

ipcMain.handle('post-api', async (_event, endpoint, body) => {
  if (!isValidEndpoint(endpoint)) {
    return { ok: false, data: null, status: 0, error: 'Endpoint not allowed' };
  }
  // ...
});
```

- `proxy-api`：GET 请求，非法端点返回 `{ ok: false, data: null, error: 'Endpoint not allowed' }`
- `post-api`：POST 请求，非法端点返回 `{ ok: false, data: null, status: 0, error: 'Endpoint not allowed' }`（额外包含 `status: 0` 字段）
- 提取 `isValidEndpoint` 前，三处校验逻辑各自内联重复，修改时容易遗漏；提取后统一维护，确保校验规则一致

### Content Isolation

- `contextIsolation: true` — 启用上下文隔离，渲染进程无法直接访问 Node.js API
- `nodeIntegration: false` — 禁用 Node.js 集成
- 所有 API 通过 `contextBridge.exposeInMainWorld` 安全暴露

### Content-Security-Policy

`index.html` 中通过 `<meta>` 标签声明 CSP 策略，限制渲染进程的资源加载来源：

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:3210; media-src 'self';">
```

| 指令 | 值 | 说明 |
|------|-----|------|
| `default-src` | `'self'` | 默认仅允许同源资源 |
| `script-src` | `'self'` | 脚本仅允许同源加载，禁止内联脚本和 `eval()` |
| `style-src` | `'self' 'unsafe-inline'` | 样式允许同源和内联（CSS 动画需要 `unsafe-inline`） |
| `img-src` | `'self' data:` | 图片允许同源和 data URI（内联图标） |
| `connect-src` | `'self' http://localhost:3210` | 允许渲染进程向本地 Harness 后端发起 HTTP 请求 |
| `media-src` | `'self'` | 允许播放本地媒体资源 |

- **无 `font-src`**：项目使用系统字体栈，不加载外部字体

### IPC 监听器防泄漏

预加载脚本使用 `preloadState` 对象保存监听器引用，注册新监听器前通过 `ipcRenderer.removeListener` 精确移除旧监听器：

```javascript
var preloadState = {
  speechHandler: null,
  permHandler: null,
  permShortcutHandler: null,
};

// contextBridge.exposeInMainWorld('companionAPI', {
onSpeech: (callback) => {
  if (preloadState.speechHandler) {
    ipcRenderer.removeListener('companion-speech', preloadState.speechHandler);
  }
  preloadState.speechHandler = (_event, text) => callback(text);
  ipcRenderer.on('companion-speech', preloadState.speechHandler);
},
onPermissionRequest: (callback) => {
  if (preloadState.permHandler) {
    ipcRenderer.removeListener('permission-request', preloadState.permHandler);
  }
  preloadState.permHandler = (_event, data) => callback(data);
  ipcRenderer.on('permission-request', preloadState.permHandler);
},
onPermissionShortcut: (callback) => {
  if (preloadState.permShortcutHandler) {
    ipcRenderer.removeListener('permission-shortcut', preloadState.permShortcutHandler);
  }
  preloadState.permShortcutHandler = (_event, action) => callback(action);
  ipcRenderer.on('permission-shortcut', preloadState.permShortcutHandler);
},
// });
```

- `preloadState` 结构：`{ speechHandler: Function|null, permHandler: Function|null, permShortcutHandler: Function|null }`
- 旧方案使用 `ipcRenderer.removeAllListeners(channel)` 会移除该通道上的所有监听器（包括其他代码注册的），影响范围不可控
- 更早的错误方案使用 `ipcRenderer.removeHandler(channel)`，该方法是用于移除 `ipcMain.handle` 的处理器，不适用于移除 `ipcRenderer.on` 的监听器
- 新方案通过 `removeListener(channel, handler)` 精确移除自身注册的旧监听器，不影响其他监听器

### 全局快捷键安全

- 所有全局快捷键在 `will-quit` 事件中通过 `globalShortcut.unregisterAll()` 自动注销
- 快捷键注册失败时静默处理（`try/catch`），不影响应用启动

### 请求超时保护

- 健康检查：2秒超时
- API代理请求：5秒超时
- 超时后 `req.destroy()` 并返回失败状态，防止连接挂起

### XSS 防护（textContent 安全化）

渲染进程中所有动态内容渲染均使用 `textContent` 而非 `innerHTML`，从根源上杜绝 XSS 注入风险：

**renderEventLog — 事件日志渲染**

```javascript
// 安全：使用 DOM API + textContent，文本内容自动转义
function renderEventLog() {
  var el = document.getElementById('eventLog');
  if (!el) return;
  el.textContent = '';
  eventLog.slice(0, 10).forEach(function (e) {
    var entry = document.createElement('div');
    entry.className = 'log-entry log-' + e.type;
    var timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = e.time;
    var textSpan = document.createElement('span');
    textSpan.className = 'log-text';
    textSpan.textContent = e.text;
    entry.appendChild(timeSpan);
    entry.appendChild(textSpan);
    el.appendChild(entry);
  });
}
```

- 修复前：使用 `innerHTML` 拼接 HTML 字符串，`e.text` 和 `e.type` 未转义，若事件文本包含 `<script>` 等 HTML 标签会导致 XSS
- 修复后：使用 `document.createElement` + `textContent` 构建 DOM，浏览器自动对文本内容进行转义，即使事件文本包含 HTML 标签也不会被解析执行

**showToast — Toast 通知渲染**

```javascript
// 安全：使用 DOM API + textContent
var iconSpan = document.createElement('span');
iconSpan.className = 'toast-icon';
iconSpan.textContent = icon;
var msgSpan = document.createElement('span');
msgSpan.className = 'toast-msg';
msgSpan.textContent = message;
t.appendChild(iconSpan);
t.appendChild(msgSpan);
```

- 修复前：使用 `innerHTML` 拼接图标和消息文本，`message` 未转义
- 修复后：使用 `textContent` 设置文本，确保消息内容不会被当作 HTML 解析

### 成就检查递归防护

`checkAchievements()` 通过重入守卫标志 `checkingAchievements` 防止无限递归：

```javascript
var checkingAchievements = false;

function checkAchievements() {
  if (checkingAchievements) return;
  checkingAchievements = true;
  // ... 遍历成就，解锁时调用 addXP(20, ...) ...
  saveSettings();
  checkingAchievements = false;
}
```

- **问题**：`checkAchievements()` 解锁成就时调用 `addXP(20, ...)`，而 `addXP()` 末尾又调用 `checkAchievements()`，形成递归调用链。若成就解锁后 XP 增加又触发新成就解锁（如等级成就），可能导致无限递归
- **修复**：使用 `checkingAchievements` 布尔标志作为重入守卫，`checkAchievements()` 执行期间若被再次调用则直接返回，确保同一时刻只有一层成就检查在执行
- **效果**：成就解锁奖励的 20XP 仍会正常累加，但不会在当前检查周期内触发新的成就检查轮次；下一轮用户交互触发的 `addXP` 调用会再次执行 `checkAchievements`，处理新达成的成就

### DOM 元素 null 安全防护

渲染进程 `els` 对象中的 DOM 引用在 `init()` 中批量赋值后，通过 `REQUIRED_ELS` 数组验证关键元素存在性：

```javascript
var REQUIRED_ELS = ['body', 'companion', 'leftEye', 'rightEye', 'mouth', 'speechBubble', 'speechText', 'contextMenu', 'miniPanel', 'fxLayer', 'coreLight'];
var missing = REQUIRED_ELS.filter(function (k) { return !els[k]; });
if (missing.length) { console.error('[Companion] 关键DOM元素缺失，初始化中止:', missing.join(', ')); return; }
```

- **关键元素缺失**：阻止后续初始化，防止级联 null 引用错误
- **非关键元素守卫**：`if (els.xxx)` 模式，元素不存在时静默跳过操作
- **事件监听器绑定**：对非关键元素（`els.head`、`els.permClose`、`els.panelClose`等）调用 `addEventListener` 前检查存在性
- **异步回调守卫**：`setTimeout`/`Promise.then` 中访问 `els.*` 时添加 null 检查
- **死属性清理**：`els.antennaBall`、`els.leftArm`、`els.rightArm`、`els.shadow`、`els.catTail`、`els.ambientRing`、`els.hud`、`els.dragHint` 等8个赋值后从未使用的属性已从 `init()` 中移除

## 错误处理模式

项目统一采用以下错误处理模式：

### 主进程

```javascript
ipcMain.handle('channel', async (_event, ...args) => {
  if (!mainWindow) return null;
  try {
    return result;
  } catch {
    return fallbackValue;
  }
});
```

- 窗口不存在时返回 `null`
- 异常时返回安全默认值
- 不向渲染进程抛出异常

### 渲染进程

```javascript
api.proxyAPI('/api/endpoint').then(function (res) {
  if (res && res.ok && res.data) {
    // 处理成功
  }
  // 使用演示数据回退
}).catch(function () {
  // 使用演示数据回退
});
```

- API 不可用时自动回退到演示数据（DEMO_AGENTS/DEMO_SKILLS/DEMO_HEALTH）
- localStorage 读写包裹 try/catch
- AudioContext 创建包裹 try/catch

### 枚举值输入验证

渲染进程中所有用作 CSS 类名或状态标识的字符串参数均通过白名单验证：

| 函数 | 验证参数 | 白名单 | 验证方式 |
|------|---------|--------|---------|
| `setMood(mood)` | mood | happy/calm/energetic | `{ happy:1, calm:1, energetic:1 }[mood]` |
| `logEvent(text, type)` | type | info/success/warning/error/level/xp | `validTypes[type]` |
| `loadSettings()` | s.mood | happy/calm/energetic | 同 setMood |
| `loadSettings()` | s.skin | SKINS 对象键 | `SKINS[s.skin]` |
| `setAIState(newState)` | newState | AI_STATES 对象键 | `AI_STATES[newState]` |
| `formatTokens(n)` | n | number类型，有限非负 | `typeof n !== 'number' \|\| !isFinite(n) \|\| n < 0` 时返回 `'-'` |
| `showSpeech(text, duration)` | text | 非空字符串 | `typeof text !== 'string' \|\| !text` 时静默返回 |
| `showToast(message, type)` | message | 非空字符串 | `typeof message !== 'string' \|\| !message` 时静默返回 |

验证失败时：`setMood` 静默返回，`logEvent` 回退到 `'info'`，`loadSettings` 使用默认值，`setAIState` 静默返回。

## 思想钻石（Thought Diamond）API

思想钻石模块（`src/runtime/thought/thought-diamond.js`）是 Thought-Retriever 核心概念的实现，提供四品级分层、双重过滤网和根数据映射功能。

### 模块导出

```javascript
const { ThoughtDiamond } = require('./thought');
// 或
const ThoughtDiamond = require('./thought/thought-diamond');
```

### 构造函数

```javascript
const diamond = new ThoughtDiamond({
  maxDiamonds: 500,           // 最大钻石容量
  confidenceThreshold: 0.5,   // 最低置信度阈值
  dedupThreshold: 0.75,       // Jaccard去重阈值
  embeddingService: null,     // 嵌入服务（可选）
  thoughtMemoryStore: null,   // 思维记忆存储（可选）
});
```

### 核心方法

#### refine(thoughts, rootData)

批量提炼思想为钻石，返回新创建或升级的钻石数组。

- **参数**：
  - `thoughts` (Array) — 待提炼的思想对象数组，每个对象需包含 `content`/`text`、`confidence`、`type`（可选）
  - `rootData` (Array|undefined) — 根数据引用ID数组，用于追溯原始数据块
- **返回值**：`Array<Diamond>` — 新创建或升级的钻石对象
- **行为**：
  1. 置信度 < 0.5 的思想被过滤（`confidenceFiltered` 计数器递增）
  2. 与现有钻石 Jaccard 相似度 ≥ 0.75 的思想被合并（`duplicatesMerged` 计数器递增）
  3. 新思想创建钻石（`diamondsCreated` 计数器递增）
  4. 合并时若置信度更高则升级品级（`diamondsUpgraded` 计数器递增）

#### getDiamond(id)

获取指定ID的钻石，同时递增 `accessCount` 和更新 `updatedAt`。

- **参数**：`id` (string) — 钻石唯一标识
- **返回值**：`Diamond|null`

#### retrieveDiamonds(options)

按条件检索钻石，支持按品级、标签、类型过滤。

- **参数**：`options` (object)
  - `tier` (string) — 品级过滤：`'raw'`/`'cut'`/`'polished'`/`'diamond'`
  - `tags` (string[]) — 标签过滤
  - `type` (string) — 类型过滤
  - `limit` (number) — 返回数量限制
- **返回值**：`Array<Diamond>` — 匹配的钻石数组（按置信度降序）

#### getTierStats()

获取各品级的钻石统计信息。

- **返回值**：`{ raw: number, cut: number, polished: number, diamond: number }`

#### getStats()

获取完整统计信息。

- **返回值**：
  ```javascript
  {
    totalRefined: number,      // 总提炼次数
    diamondsCreated: number,   // 新创建钻石数
    diamondsUpgraded: number,  // 升级钻石数
    diamondsDowngraded: number,// 降级数（保留字段，当前为0）
    duplicatesMerged: number,  // 合并重复数
    confidenceFiltered: number,// 置信度过滤数
    rootDataMappings: number,  // 根数据映射数
  }
  ```

### 四品级分层

| 品级 | 置信度范围 | 含义 |
|------|-----------|------|
| RAW | [0, 0.5) | 原始思想，未经验证 |
| CUT | [0.5, 0.75) | 初步提炼，已通过置信度过滤 |
| POLISHED | [0.75, 0.9) | 精炼思想，高置信度 |
| DIAMOND | [0.9, 1.0] | 钻石级思想，最高品质 |

### 事件

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `diamond-created` | 新钻石创建 | Diamond对象 |
| `diamond-upgraded` | 钻石品级升级 | `{ id, from, to }` |
| `diamond-removed` | 钻石被移除 | `{ id, tier }` |

### ThoughtRetrieverCycle集成

ThoughtRetrieverCycle（`src/runtime/thought/thought-retriever-cycle.js`）已集成第六步 `diamondRefine`：

```javascript
const cycle = new ThoughtRetrieverCycle({
  thoughtDiamond: diamond,           // ThoughtDiamond实例
  confidenceFilterEnabled: true,     // 启用置信度过滤
  diamondRefineEnabled: true,        // 启用钻石提炼
});
```

- **第六步**：在去重后执行 `thoughtDiamond.refine(accepted, rootData)`
- **置信度过滤**：`_confidenceFilter()` 过滤置信度 < 0.5 的思想
- **统计扩展**：`getStats()` 返回值新增 `diamondsRefined` 和 `confidenceFiltered` 字段

## 安全增强API

### safeOpenExternal(url)

主进程安全封装的 `shell.openExternal`，校验URL协议为 `http:` 或 `https:`。

```javascript
function safeOpenExternal(url) {
  try {
    var parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    shell.openExternal(url);
  } catch {}
}
```

- **适用范围**：所有 `shell.openExternal` 调用点（托盘菜单、`open-dashboard` IPC handler）
- **安全防护**：阻止 `file://`、`javascript:`、自定义协议等危险URL

### safeSend(channel, ...args)

主进程安全封装的 `webContents.send`，检查窗口销毁状态。

```javascript
function safeSend(channel, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, ...args); } catch {}
}
```

- **适用范围**：所有异步操作后的 `webContents.send` 调用（托盘菜单回调、快捷键回调）
- **安全防护**：防止 `Error: Object has been destroyed` 未捕获异常

### HTTP代理安全增强

| 增强项 | 说明 |
|--------|------|
| 查询参数保留 | `parsed.pathname + parsed.search` 保留 `?key=value` 参数 |
| 响应体消费 | `checkHarnessAPI` 中 `res.resume()` 释放socket回连接池 |
| 响应体拼接中止 | `aborted` 标志防止超限后继续拼接字符串 |
| 请求体大小限制 | POST请求体超过1MB时拒绝 |
| setIgnoreMouseEvents深度校验 | 仅提取 `forward: boolean` 已知属性 |
| 托盘销毁 | `will-quit` 中 `tray.destroy()` 防止Windows图标残留 |

### 函数参数验证

渲染进程中关键函数的参数验证模式：

| 函数 | 验证参数 | 验证规则 | 失败行为 |
|------|---------|---------|---------|
| `formatTokens(n)` | n | `typeof === 'number'` 且 `isFinite(n)` 且 `n >= 0` | 返回 `'-'` |
| `showSpeech(text, duration)` | text | `typeof === 'string'` 且非空 | 静默返回 |
| `showToast(message, type)` | message | `typeof === 'string'` 且非空 | 静默返回 |
| `send-command (IPC)` | cmd | 非空字符串 | `typeof cmd !== 'string' \|\| !cmd.trim()` 时返回 `{ ok: false, error: 'Invalid command' }` |
| `setMood(mood)` | mood | 白名单 `{happy:1, calm:1, energetic:1}` | 静默返回 |
| `logEvent(text, type)` | type | 白名单 `{info:1, success:1, warning:1, error:1, level:1, xp:1}` | 回退到 `'info'` |
| `setEyeExpression(expr)` | expr | 白名单 `EYE_EXPR_CLASSES` 数组 | 不在白名单时仅清除旧表情，不添加新类 |
| `addXP(amount, reason)` | amount | `typeof === 'number'` 且 `amount > 0` 且 `isFinite(amount)` | NaN/Infinity/非正数时静默返回，不修改XP |
| `addXP(amount, reason, countInteraction)` | countInteraction | `false`时不计入互动次数 | 默认计入totalInteractions，被动奖励传false |
| `randomFrom(arr)` | arr | 非空数组 | `Array.isArray(arr) && arr.length > 0` 不满足时返回空字符串 `''` |
| `saveSettings()` | growth | 显式字段拷贝 | 仅序列化13个已知字段，避免运行时属性泄漏到 localStorage |
| `pollOptimizationStatus` | data.bestScore | `typeof === 'number'` | 非数字时显示 `'N/A'`，防止 `undefined.toFixed()` TypeError |
| `checkAchievements()` | 重入防护 | `achievementsNeedRecheck` 级联重检 | 内层调用被阻止时标记重检，外层循环自动重新检查 |

> **注意**：`logEvent(text, type)` 的参数顺序为"文本在前，类型在后"。调用时务必遵守此顺序，避免参数反转导致日志显示异常。

### 并发 IPC 请求（Promise.all 模式）

当需要同时获取多个 IPC 结果时，使用 `Promise.all` 替代嵌套 Promise，避免回调地狱并确保并行执行：

```javascript
function checkEdgePosition() {
  if (!state.edgeAutoMinimal) return;
  Promise.all([api.getWindowPosition(), api.getScreenSize()]).then(function (results) {
    var pos = results[0], screen = results[1];
    if (!pos || !screen) return;
    var atRightEdge = pos[0] + 276 >= screen.width - 10;
    var atLeftEdge = pos[0] <= 10;
    if ((atRightEdge || atLeftEdge) && !state.minimalMode) {
      state.minimalMode = true;
      // ...
    }
  }).catch(function () {});
}
```

- **优势**：两个 IPC 调用并行发出，而非串行等待；任一失败由 `.catch()` 统一处理
- **适用场景**：需要同时依赖窗口位置和屏幕尺寸的逻辑（贴边检测、位置恢复等）

### 窗口位置恢复（Promise.all 模式）

`restoreWindowPosition()` 同样使用 `Promise.all` 并行获取窗口位置和屏幕尺寸，与 `checkEdgePosition` 保持一致：

```javascript
function restoreWindowPosition() {
  Promise.all([api.getWindowPosition(), api.getScreenSize()]).then(function (results) {
    var pos = results[0], screen = results[1];
    if (!pos || !screen) return;
    var inBounds = pos[0] >= 0 && pos[0] < screen.width - 50
                && pos[1] >= 0 && pos[1] < screen.height - 50;
    if (inBounds) {
      api.getWindowBounds().then(function (bounds) {
        if (bounds && bounds.x === pos[0] && bounds.y === pos[1]) return;
        // 恢复窗口位置
      });
    }
  }).catch(function () {});
}
```

- **与嵌套 Promise 的区别**：旧模式先请求 `getWindowPosition`，再在其回调中请求 `getScreenSize`，两次 IPC 串行执行；新模式并行发出两个请求，减少等待时间
- **边界校验**：恢复前检查坐标是否在屏幕范围内，超出范围则放弃恢复

### 连接状态更新（updateConnectionStatus）

`updateConnectionStatus(connected)` 在连接成功时调用 `setMood(state.mood)` 而非直接设置嘴巴表情，确保尊重当前心情设置：

```javascript
function updateConnectionStatus(connected) {
  var prev = state.apiConnected;
  state.apiConnected = connected;
  if (connected) {
    els.statusDot.className = 'status-dot connected';
    els.coreLight.className = 'core-light connected';
    setMood(state.mood);  // 尊重当前心情，不再强制 happy
    els.statusText.textContent = '已连接';
    // ...
  } else {
    els.statusDot.className = 'status-dot disconnected';
    els.coreLight.className = 'core-light error';
    els.mouth.className = 'mouth sad';
    els.statusText.textContent = '未连接';
    // ...
  }
}
```

- **修复前**：连接成功时强制将嘴巴表情设为 `mouth happy`（`els.mouth.className = 'mouth happy'`），覆盖用户当前心情设置
- **修复后**：调用 `setMood(state.mood)` 根据当前心情值正确设置表情，保持心情状态的一致性
- **断开连接时**：仍直接设置 `mouth sad`，因为断开属于异常状态，优先表达错误情绪

### 粒子系统闭包修复

`spawnBurstParticles`、`spawnConfetti`、`spawnBubbles` 三个粒子函数中的 `for` 循环使用 `var` 声明 DOM 元素变量，导致 `setTimeout` 回调中的引用被后续循环覆盖（经典 JavaScript 闭包陷阱）。

**问题代码**：

```javascript
function spawnBurstParticles() {
  for (var i = 0; i < 12; i++) {
    var p = document.createElement('div');
    p.className = 'burst-particle';
    // ...设置位置和方向...
    container.appendChild(p);
    setTimeout(function () {
      p.remove();  // p 始终引用最后一次循环的元素
    }, 600);
  }
}
```

- `var` 声明的 `p` 具有函数作用域，循环结束后 `p` 指向最后一个创建的元素
- 所有 `setTimeout` 回调中的 `p.remove()` 都操作同一个 DOM 元素，前面的粒子无法被正确移除

**修复方式**：使用 IIFE 包裹每次循环迭代，确保每个 `setTimeout` 回调捕获独立的 DOM 元素引用：

```javascript
function spawnBurstParticles() {
  for (var i = 0; i < 12; i++) {
    (function (idx) {
      var p = document.createElement('div');
      p.className = 'burst-particle';
      // ...设置位置和方向...
      container.appendChild(p);
      setTimeout(function () {
        p.remove();  // 每个回调捕获各自的 p
      }, 600);
    })(i);
  }
}
```

- IIFE 为每次迭代创建独立作用域，`p` 在每个闭包中是独立变量
- `spawnConfetti`（五彩纸屑）和 `spawnBubbles`（气泡）采用相同修复方式

### 杂耍球累积修复

`spawnJuggleBalls` 存在两个问题：与上述粒子函数相同的 `var` 闭包陷阱，以及杂耍球在特效层中无限累积（无自动移除机制）。

**问题代码**：

```javascript
function spawnJuggleBalls() {
  for (var i = 0; i < 3; i++) {
    var ball = document.createElement('div');
    ball.className = 'juggle-ball';
    // ...设置位置和动画...
    container.appendChild(ball);
    // 无 setTimeout 移除，球在 DOM 中无限累积
  }
}
```

- `var` 闭包陷阱：同上述粒子系统问题
- 无自动移除：每次调用 `spawnJuggleBalls` 都向特效层追加新球元素，AI 在 `juggling`/`conducting` 状态下反复触发时，DOM 中杂耍球数量持续增长

**修复方式**：使用 IIFE 包裹（与其他粒子函数一致），并添加3秒自动移除的 `setTimeout`：

```javascript
function spawnJuggleBalls() {
  for (var i = 0; i < 3; i++) {
    (function (idx) {
      var ball = document.createElement('div');
      ball.className = 'juggle-ball';
      // ...设置位置和动画...
      container.appendChild(ball);
      setTimeout(function () {
        ball.remove();
      }, 3000);
    })(i);
  }
}
```

- IIFE 解决闭包陷阱，每个 `setTimeout` 回调捕获各自的 `ball` 引用
- 3秒自动移除防止杂耍球在特效层中无限累积，与动画周期匹配

> **FX_BODY_CLASSES 更新**：数组已扩展至18个类名，新增 `waving`（挥手动画）、`look-around-click`（东张西望动画）、`excited`（兴奋弹跳）、`wake-up-startle`（惊醒动画），确保 `clearFx()` 能完整清除所有临时动画类。

### 生命周期清理

窗口关闭时（`beforeunload` 事件），桌面伙伴执行完整的资源清理：

| 资源类型 | 清理方式 |
|---------|---------|
| setInterval 定时器 | `state.intervals.forEach(id => clearInterval(id))` |
| blinkInterval | `clearInterval(state.blinkInterval)` |
| idleActionTimer | `clearInterval(state.idleActionTimer)` |
| sleepTimers | `state.sleepTimers.forEach(t => clearTimeout(t))` |
| idleTimer | `clearTimeout(state.idleTimer)` |
| speechTimeout | `clearTimeout(state.speechTimeout)` |
| fxTimeout | `clearTimeout(state.fxTimeout)` |
| actionTimeout | `clearTimeout(state.actionTimeout)` |
| permTimeout | `clearTimeout(state.permTimeout)` |
| petTimer | `clearTimeout(state.petTimer)` |
| roamStepTimer | `clearTimeout(state.roamStepTimer)` |
| roamWalkInterval | `clearInterval(state.roamWalkInterval)` |

## 预加载脚本输入验证（v2.7.151 第36轮新增）

预加载脚本（preload.js）通过contextBridge暴露的API方法现已增加输入验证，防止恶意或异常输入通过IPC传递到主进程：

### proxyAPI端点验证
- 验证endpoint为非空字符串
- 必须匹配正则 `/^\/api\/[a-zA-Z0-9_/.-]{0,128}$/`
- 不匹配时返回 `Promise.reject(new Error('Invalid endpoint'))`

### sendCommand命令验证
- 验证cmd为非空字符串
- 长度限制：1 ≤ cmd.length ≤ 500
- 不满足时返回 `Promise.reject(new Error('Invalid command'))`

### moveWindow偏移量验证
- 验证dx/dy均为有限数字（Number.isFinite）
- 绝对值上限：±100px
- 不满足时返回 `Promise.reject(new Error('Invalid move offset'))`

### setIgnoreMouseEvents类型验证
- 验证ignore参数为布尔类型
- 非布尔值返回 `Promise.reject(new Error('Invalid ignore value'))`

### setWindowSize尺寸验证
- 验证w/h均为有限数字
- 范围限制：100 ≤ w/h ≤ 4096
- 不满足时返回 `Promise.reject(new Error('Invalid window size'))`

## Runtime模块安全修复（v2.7.151 第36轮新增）

### ConversationContextStore路径遍历防护
- `getSessionContext()` 和 `_loadSessionFromJson()` 现在验证sessionId格式
- 使用 `SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/` 正则校验
- 非法sessionId返回null而非尝试加载文件

### ConversationContextStore压缩序列号一致性
- `compressSession()` 不再重置 `turnCount`
- turnCount保持为历史总轮次数，用于序列号编号
- 压缩后session.turns.length可能小于turnCount

### ChatChain状态一致性
- `retryTask()` 恢复链状态使用 `TASK_STATUS.PENDING` 而非 `TASK_STATUS.ACTIVE`
- `failTask()` 重试条件从 `<= MAX_RETRIES` 改为 `< MAX_RETRIES`
- 与 `retryTask()` 的 `>= MAX_RETRIES` 判断保持一致

### ThoughtMemoryStore shutdown防护
- `retrieveThoughts()`、`getStats()`、`getThought()` 增加shutdown状态检查
- shutdown后返回空数组/零值对象/null，而非抛出异常

### RAGPipeline文档ID碰撞防护
- `_generateDocId()` 添加哈希后缀（基于docPath的DJB2哈希）
- 格式：`doc_{sanitized}_{hash_base36}`
- `_chunkText()` overlap参数clamp到非负：`Math.max(0, Math.min(overlap, chunkSize - 1))`

### GraphRAG修复
- `_extractRelations()` 段落偏移量使用实际分隔符匹配长度
- `_pruneWeakRelations()` 同时删除正向和反向关系键
- `attachEmbeddingService()`/`attachVectorIndex()` 返回this支持链式调用
- `_removeDocumentEntities()` 使用Set替代Array.includes进行O(1)查找

---

## 第38轮优化修复记录

### goal-executor 修复

#### BLOCKED子任务重试
- **问题**：`_executeSubtasks`中，依赖子任务在独立子任务执行后仍无法满足依赖时被`continue`跳过，状态保持`BLOCKED`且永远不会被重试
- **修复**：将`SUBTASK_STATUS.BLOCKED`加入`pendingSubtasks`过滤器；依赖未满足的子任务被跳过时重置状态为`PENDING`
- **影响方法**：`_executeSubtasks()`

#### resume零迭代防护
- **问题**：`resume`方法中，当`_runGoalLoop`完成但零迭代执行时（如startIteration >= maxIterations），目标被错误标记为`COMPLETED`
- **修复**：记录`iterationBefore`，循环完成后检查`goal.currentIteration === iterationBefore`，零迭代时标记为`PAUSED`
- **影响方法**：`resume()`

### thought-retriever-cycle 修复

#### merged数组存储
- **问题**：`_store`方法仅存储`accepted`数组，忽略`merged`数组中的合并思想
- **修复**：将`accepted`与`merged`合并后存储，合并时过滤无效条目
- **影响方法**：`_store()`

### pair-chat 修复

#### corrections验证
- **问题**：`addCrossValidationRound`中round对象的`corrections`字段使用原始`roundData.corrections`而非验证后的`corrections`变量
- **修复**：使用验证后的`corrections`变量赋值
- **影响方法**：`addCrossValidationRound()`

#### 幻觉平均计算一致性
- **问题**：`_finalizeRound`中`_hallucinationSum`仅在共识达成时更新，但`getCrossValidationStats`使用`totalHallucinationCorrections / totalCrossValidations`
- **修复**：在失败分支也更新`_hallucinationSum`和平均计算
- **影响方法**：`_finalizeRound()`

#### 时间戳解析健壮性
- **问题**：`Number(new Date(...))`链式调用在无效日期时产生NaN，导致超时检测失效
- **修复**：使用`new Date(ts).getTime()`配合`Number.isFinite()`检查，三级回退策略
- **影响方法**：`_cleanupTimedOutSessions()`、`_checkRoundTimeout()`、`addRound()`

### event-bus 修复

#### 历史记录深拷贝
- **问题**：事件历史使用浅拷贝存储对象数据，嵌套对象引用共享导致数据污染风险
- **修复**：使用`JSON.parse(JSON.stringify(data))`深拷贝，失败时回退浅拷贝
- **影响方法**：`emit()`

#### onceAsync容量限制
- **问题**：`_pendingOnceAsync`集合无容量限制，大量并发调用可能导致内存泄漏
- **修复**：添加`_maxPendingOnceAsync`配置（默认1000），超出时抛出`CAPACITY_EXCEEDED`错误
- **影响方法**：`onceAsync()`

### context-compression-engine 修复

#### 无预算压缩防护
- **问题**：`shouldCompress`在`tokenBudget`为空时返回`tokensUsed > 0`，导致任何非零token使用都触发压缩
- **修复**：无预算时返回`false`
- **影响方法**：`shouldCompress()`

#### 缓存满驱逐策略
- **问题**：因果上游缓存满时静默丢弃新条目（`if (size < max) set(...)`）
- **修复**：过期驱逐后仍满时使用FIFO策略驱逐最旧条目
- **影响方法**：`_isCausalUpstream()`

### companion.js 修复

#### null安全防护（11处）
- `e.dataTransfer.files` → `e.dataTransfer && e.dataTransfer.files`
- `EYE_EXPR_CLASSES.forEach`中`els.leftEye`/`els.rightEye`添加null检查（3处）
- `showSpeech`中`els.speechText`/`els.speechBubble`添加null检查
- `setMood`中`els.mouth`添加null检查
- `updateConnectionStatus`中`els.coreLight`/`els.mouth`添加null检查
- `onIdle`中`els.body`/`els.mouth`添加null检查

#### DOM查询缓存优化（5处）
- `setupMiniPanel`中5处`document.querySelectorAll`替换为已缓存的`els.panelCards.*Cards || []`

#### TIMING常量提取（21处）
- 新增`TIMING`对象包含36个命名常量
- 替换21处硬编码魔法数字为常量引用
- 涵盖：定时器间隔、XP奖励、粒子数量、UI限制等

## 第39轮优化修复记录

### goal-executor 修复

#### _shuttingDown属性统一（9处）
- **问题**：自定义`shutdown()`设置`_shuttingDown=true`（立即生效），但运行时检查使用`_shutDown`（mixin设置，shutdown完成后才生效），导致关闭期间新操作仍可启动
- **修复**：9处`this._shutDown`替换为`this._shuttingDown`
- **影响方法**：`_runGoalLoop()`、`_executeSubtasks()`、`_checkConvergence()`、`resumeGoal()`等

#### resume错误路径统计完整性
- **问题**：`resumeGoal`的`.catch()`块设置`goal.status = ERROR`但未递增`totalGoalsFailed`
- **修复**：添加`this._stats.totalGoalsFailed++`
- **影响方法**：`resumeGoal()`

#### _loopPromises驱逐两阶段
- **问题**：原驱逐逻辑仅删除单条且不等待Promise settlement，无法有效控制Map大小
- **修复**：两阶段驱逐——先清已完成/非Promise条目，再FIFO淘汰最旧条目并附加`.catch()`
- **影响方法**：`resumeGoal()`

### dream-outcomes 修复

#### metric方向感知评估
- **问题**：`evaluateOutcome`中所有metric按maximize方向评估，minimize指标（如错误率、延迟）被错误地按"越大越好"处理
- **修复**：根据`metric.direction`区分——maximize用`>=`和`actual/target`，minimize用`<=`和`target/actual`
- **影响方法**：`evaluateOutcome()`

### pair-chat 修复

#### 统计值类型一致性
- **问题**：`getStats()`中`.toFixed(2)`返回字符串，与fallback值`0`（数字）类型不一致
- **修复**：替换为`Math.round(x * 100) / 100`确保始终返回数字
- **影响方法**：`getStats()`

### optimization-loop 修复

#### rollbackTo状态完整重置
- **问题**：`rollbackTo`未重置`_bestScore`/`_bestIteration`，回滚后退化检测可能再次触发自动回滚形成死循环
- **修复**：同步重置`_bestScore`/`_bestIteration`为快照值，清空`_strategyTrend`
- **影响方法**：`rollbackTo()`

### graph-rag 修复

#### 实体匹配最小长度
- **问题**：子串匹配无最小长度限制，短实体名如"AI"误匹配"train"等无关词汇
- **修复**：子串匹配要求查询词或实体名至少3个字符，精确匹配不受限
- **影响方法**：`_matchEntities()`

### companion.js 修复

#### TIMING常量完善（6处+3新常量）
- 新增`LEVEL_UP_OVERLAY`(2500ms)、`ROAM_PAUSE_MIN`(3000ms)、`ROAM_PAUSE_RANGE`(5000ms)
- 6处硬编码替换：blink调度、长按阈值、旋转时长、宠物计数重置、漫游暂停、升级叠加层
- blink间隔改用`TIMING.BLINK_MIN + Math.random() * (TIMING.BLINK_MAX - TIMING.BLINK_MIN)`

#### 关键函数try-catch防护（4处）
- `setAIState`：AI状态切换异常不会崩溃IIFE沙箱
- `onLevelUp`：升级逻辑异常安全降级
- `processAgentData`：Agent数据处理异常隔离
- `pollOptimizationStatus`：优化状态轮询异常隔离

## 第41轮优化修复记录

### model-selector 修复

#### LRU插入顺序（HIGH）
- **问题**：`recordUsage`中`Map.set()`对已存在key不更新插入顺序，频繁使用条目被错误驱逐
- **修复**：先`delete`再`set`更新插入顺序

#### 复杂度阈值回退值不一致（MEDIUM）
- **问题**：`threshold.standard`回退值为0.4，默认配置为0.3
- **修复**：回退值改为0.3

#### attachTokenManager空指针（MEDIUM）
- **问题**：`attachTokenManager(null)`抛TypeError
- **修复**：添加null/validity检查

### skill-router 修复

#### modelTier提取缺失（HIGH）
- **问题**：`_normalizeMatchInput`未提取`modelTier`，MODEL_TIERS功能完全失效
- **修复**：添加`modelTier`到解构和返回对象

### skill-reducer 修复

#### 定时器去重（HIGH）
- **问题**：`deactivateAfterTask`重复调用同signature泄漏定时器+损坏追踪Map
- **修复**：创建新定时器前清除已有定时器

#### shutdown防护缺失（MEDIUM）
- **问题**：`loadL2`/`loadL3`/`discoverAsync`缺少shutdown检查
- **修复**：添加`guardShutdown()`和await后shutdown检查

### context-compression-engine 修复

#### 状态哈希不完整（HIGH）
- **问题**：`_computeStateHash`遗漏`keyDecisions`/`sessionState`，增量跳过返回过时结果
- **修复**：添加到哈希输入

#### 数组省略计数错误（MEDIUM）
- **问题**：`_compressObjectOutput`省略计数为`length-3`，应为`length-5`
- **修复**：改为`obj.length - 5`

### isolated-context-manager 修复

#### 访问控制绕过（HIGH）
- **问题**：`getContext`省略`requestingAgentId`时跳过ACL检查，完全破坏隔离性
- **修复**：省略时拒绝访问并发射access-denied事件

#### 结果覆写（MEDIUM）
- **问题**：`submitResult`允许覆写已完成context的结果
- **修复**：添加completed状态检查

#### isHealthy缺少shutdown检查（MEDIUM）
- **修复**：添加`this._shutDown`检查

### quality-scorer 修复

#### getHistory边界（MEDIUM）
- **问题**：`getHistory(0)`返回完整历史（`slice(-0)`等价`slice(0)`）
- **修复**：添加`n <= 0`返回空数组

#### null元素防护（MEDIUM）
- **问题**：`_scoreCoverage`中`t.passed`在null元素上抛TypeError
- **修复**：添加`t &&`守卫

### business-goal 修复

#### KPI覆写丢失进度（MEDIUM）
- **问题**：`defineKpi`覆写已存在KPI时丢失`current`值
- **修复**：保留已有`current`值

#### 达成率分母膨胀（MEDIUM）
- **问题**：`measureGoalAchievement`分母包含未度量KPI
- **修复**：仅计入`current !== null`的KPI

#### shutdown清理缺失（MEDIUM）
- **修复**：添加`removeAllListeners()`

### token-manager 修复

#### LRU驱逐条件错误（MEDIUM）
- **问题**：使用`_sessionBreakdowns.has()`判断新session，已有session缺breakdown时误触发驱逐
- **修复**：在delete+set前捕获`isNewSession`标志

### human-approval-gate 修复

#### shutdown清理缺失（MEDIUM）
- **修复**：添加`removeAllListeners()`

### retry-engine 修复

#### _escalate复杂度拆分（MEDIUM）
- **问题**：`_escalate`方法复杂度21超限
- **修复**：拆分为`_escalateReplan`+`_escalateDecompose`+精简`_escalate`

#### replan sleep异常处理（MEDIUM）
- **问题**：replan循环中`_sleep`缺少try-catch，与主循环不一致
- **修复**：添加try-catch

## 第42轮优化修复记录

### deepening-orchestrator 修复

#### bestScore无限值防护（MEDIUM）
- **问题**：`_runIterations`中bestScore计算`reduce(-Infinity)`在无有限元素时保持-Infinity
- **修复**：添加`Number.isFinite(best) ? best : 0`回退

### plugin-manager 修复

#### 异步init异常处理（MEDIUM）
- **问题**：`register`中`plugin.init(ctx)`仅try-catch同步异常，返回Promise拒绝未被处理
- **修复**：检测init返回Promise时通过`.catch()`清理hooks，通过`const self = this`捕获上下文
