# DreamPatrol

> 一个融合 **AI 多 Agent 协作框架** 与 **梦境记录 Web 应用** 的开源项目仓库。

<div align="center">

![巡梦 Logo](Dreamwave/参考页面/logo_light.png)

**🌙 巡梦 · Dreamwave** · **⚙️ Harness Engineering**

[![License: MIT](Harness_V1_0609/LICENSE)](Harness_V1_0609/LICENSE)

</div>

---

## 品牌标识

| Logo（浅色） | Logo（深色） | 品牌设计 |
|:---:|:---:|:---:|
| ![Logo Light](Dreamwave/参考页面/logo_light.png) | ![Logo Black](Dreamwave/参考页面/logo_black.png) | ![品牌设计](Dreamwave/参考页面/品牌设计.png) |

> 品牌主题：梦境 · 情绪 · 星空。Logo 以"月相 + 梦境波纹"为视觉主体，呼应 Dreamwave（梦境之波）的产品名。

---

## 仓库概览

本仓库包含两个独立但互补的子项目：

| 子项目 | 目录 | 简介 |
|--------|------|------|
| **Harness Engineering** | [Harness_V1_0609/](Harness_V1_0609/) | AI 辅助编程的多 Agent 协作框架，将规则从 Markdown 文档转化为可强制执行的运行时引擎 |
| **巡梦 (Dreamwave)** | [Dreamwave/](Dreamwave/) | 梦境记录 Web 应用，支持情绪标记、语音录入、日历视图与情绪洞察报告 |

---

## 子项目一：Harness Engineering

> **从 Prompt 工程到软件工程的关键跨越**

### 核心特性

- **28 个 Agent**：6 职能型 + 5 任务型 + 5 语言审查员 + 1 人类角色 + 11 专业/业务型
- **84 个 Skill**：基于上下文自动路由，无需手动指定
- **可执行运行时引擎**：384+ 源文件、240+ 导出模块、250+ API 端点
- **权限执行引擎**：RBAC + 文件守卫 + 审计日志
- **TDD 门禁**：先测试后实现，强制证据验证
- **4 款编辑器适配**：Claude Code / Trae / Cursor / Windsurf
- **6 阶段执行流程**：需求探索 → 需求分析 → 架构设计 → 模块开发 → 集成测试 → 部署上线

### 快速开始

```bash
cd Harness_V1_0609
npm install
npm test          # 运行 7800+ 单元测试和集成测试
npm run validate  # 框架一致性检查
```

要求：Node.js >= 18.0.0

### 核心模块

| 子系统 | 模块数 | 核心能力 |
|--------|--------|----------|
| Agent | 16+ | 生命周期、沙箱、调试闭环、托管主机、动态生成 |
| 协作 | 11+ | 配对对话、链式对话、群聊、任务委派、跨机器传输 |
| 深化推理 | 50+ | 编排器、管道、缓存、熔断、限流、调度、监控 |
| 技能 | 25+ | 路由、创建、演化、精简、图谱、金丝雀、退休管理 |
| 思维 | 23+ | 提取、去重、记忆、做梦、跨图谱、向量索引 |
| 质量 | 14+ | 评分、自反思、对抗审查、AI 代码可信度、上下文漂移 |
| 基础设施 | 25+ | 事件总线、MCP 客户端、浏览器自动化、Git worktree |

### 使用示例

```javascript
const { SkillRouter, RBACEnforcer, TDDGate } = require('./Harness_V1_0609/src');

const router = new SkillRouter(projectRoot);
router.discover();
const matches = router.match({ userMessage: '帮我做需求分析', agent: 'domain-analyst' });

const enforcer = new RBACEnforcer(projectRoot);
enforcer.load();
if (!enforcer.canExecute('team-lead', 'tdd-implement')) {
  console.log('Permission denied');
}
```

详细文档：[Harness_V1_0609/README.md](Harness_V1_0609/README.md) · [六层文档体系](Harness_V1_0609/docs/README.md)

---

## 子项目二：巡梦 (Dreamwave)

> **记录梦境，洞察情绪**

第二期灵治擂台赛参赛作品。一款轻量级梦境记录 Web 应用，帮助用户记录梦境、追踪情绪模式、生成情绪洞察报告。

### 功能清单

#### 用户前端 (web/)
- 文本录入 + 语音录入（Web Speech API）
- 6 种情绪标记：喜悦 / 平静 / 悲伤 / 恐惧 / 奇妙 / 怀念
- 梦境卡片列表（时间倒序）
- 梦境详情页（情绪氛围背景 + AI 叙事生成）
- 日历视图（月历 + 情绪标记点）
- 编辑 / 删除梦境
- 情绪统计、洞察报告
- 用户注册 / 登录
- 主题切换、语音录入、白噪音播放

#### 后台管理 (admin/)
- 数据概览统计（梦境数 / 用户数 / 情绪分布）
- 梦境管理（搜索 / 删除）
- 用户管理（启用 / 禁用）
- AI 调用日志、配置管理
- 操作日志、系统设置

### 技术栈

| 层次 | 技术 |
|------|------|
| 后端 | Node.js + Express + TypeScript + sql.js + JWT |
| 用户前端 | React 18 + TypeScript + Vite + CSS Modules |
| 管理前端 | React 18 + Ant Design 5 + Vite |
| 数据库 | SQLite（sql.js 纯 JS 实现） |
| 部署 | Docker + Docker Compose + Nginx |

### 快速开始

#### 方式一：本地开发

```bash
# 1. 启动后端
cd Dreamwave/server
npm install
npm run dev
# 服务运行在 http://localhost:3100

# 2. 启动用户前端（新终端）
cd Dreamwave/web
npm install
npm run dev
# 前端运行在 http://localhost:5173

# 3. 启动后台管理（新终端）
cd Dreamwave/admin
npm install
npm run dev
# 管理端运行在 http://localhost:5174
```

默认管理员账户：`admin` / `admin123`

#### 方式二：Docker Compose 部署

```bash
cd Dreamwave
docker compose up -d
# 用户端: http://localhost
# 管理端: http://localhost:5174
# API:    http://localhost:3100
```

### 项目结构

```
Dreamwave/
├── docs/          # 开发文档（计划、进度、清单）
├── server/        # 后端服务（Express + sql.js + JWT）
│   ├── src/
│   │   ├── routes/      # 路由：auth/dreams/tags/ai/admin
│   │   ├── middleware/  # 鉴权、审计、错误处理、Token 黑名单
│   │   ├── db/          # sql.js 数据库封装与迁移
│   │   └── __tests__/   # 单元测试与集成测试
│   └── Dockerfile
├── web/           # 用户前端（React + TypeScript + Vite）
│   ├── src/
│   │   ├── pages/       # 首页/记录/详情/日历/统计/设置等
│   │   ├── components/  # 情绪选择器、白噪音、语音录入等
│   │   └── hooks/       # 情绪主题、流星、星空、萤火虫动效
│   └── Dockerfile
├── admin/         # 后台管理（React + Ant Design）
│   ├── src/
│   │   ├── pages/       # 仪表盘/梦境/用户/AI配置/日志
│   │   └── services/    # API 封装
│   └── Dockerfile
├── 参考页面/      # 早期静态参考页面与设计稿
├── docker-compose.yml
└── README.md
```

详细文档：[Dreamwave/README.md](Dreamwave/README.md) · [开发计划](Dreamwave/docs/开发计划.md)

---

## 开发与贡献

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- Docker（可选，用于 Dreamwave 一键部署）

### 仓库目录约定

```
DreamPatrol/
├── Harness_V1_0609/    # 多 Agent 框架（独立 npm 项目）
├── Dreamwave/          # 梦境记录应用（独立 docker 项目）
├── ECS/                # 部署密钥（已在 .gitignore 中忽略）
└── Files/              # 本地文件（已在 .gitignore 中忽略）
```

### 子项目独立维护

两个子项目各自拥有完整的依赖与文档：

```bash
# Harness 框架
cd Harness_V1_0609 && npm install

# Dreamwave 后端
cd Dreamwave/server && npm install

# Dreamwave 用户端
cd Dreamwave/web && npm install

# Dreamwave 管理端
cd Dreamwave/admin && npm install
```

---

## 许可证

- **Harness_V1_0609**：[MIT License](Harness_V1_0609/LICENSE)
- **Dreamwave**：与 Harness 框架同许可证（MIT）

---

## 致谢

- **Harness Engineering**：融合自 Claude Code Managed Agents、AutoGen、CrewAI、LangGraph、MiroFish、ChatDev、OpenClaw 等多个优秀框架的设计思想
- **Dreamwave**：第二期灵治擂台赛参赛作品，灵感来源于梦境记录与情绪健康追踪
