# 巡梦 (Dreamwave) — 梦境记录 Web 应用

> **记录梦境，洞察情绪**
> 第二期灵治擂台赛参赛作品

<div align="center">

![巡梦 Logo](参考页面/logo_light.png)

</div>

[![License: MIT](LICENSE)](LICENSE)

## 品牌标识

| 浅色版 | 深色版 | 主视觉 |
|:---:|:---:|:---:|
| ![Logo Light](参考页面/logo_light.png) | ![Logo Black](参考页面/logo_black.png) | ![品牌设计](参考页面/品牌设计.png) |

> **品牌主题**：梦境 · 情绪 · 星空。Logo 以"月相 + 梦境波纹"为视觉主体，呼应 Dreamwave（梦境之波）的产品名。完整品牌设计见 [参考页面/品牌设计.png](参考页面/品牌设计.png)。

### 情绪主题色

| 喜悦 😊 | 平静 🌊 | 悲伤 🌧 | 恐惧 ⚡ | 奇妙 ✨ | 怀念 🍂 |
|:---:|:---:|:---:|:---:|:---:|:---:|
| `bg_joy` | `bg_calm` | `bg_sadness` | `bg_fear` | `bg_wonder` | `bg_nostalgia` |

6 种情绪主题对应 3 张备选背景图（共 18 张），按用户情绪自动切换主视觉，营造沉浸式梦境记录体验。

---

## 项目简介

巡梦（Dreamwave）是一款轻量级梦境记录 Web 应用，帮助用户：

- 📝 **记录梦境**：文本录入 + 语音录入（Web Speech API）
- 💭 **标记情绪**：6 种情绪维度（喜悦 / 平静 / 悲伤 / 恐惧 / 奇妙 / 怀念）
- 📅 **日历视图**：月历 + 情绪标记点
- 📊 **情绪洞察**：统计报表 + AI 叙事生成
- 🎵 **沉浸氛围**：白噪音播放 + 情绪主题切换

## 项目结构

```
Dreamwave/
├── docs/                # 开发文档
│   ├── 开发计划.md
│   ├── 开发进度.md
│   └── 资源检查清单与更新说明.md
├── server/              # 后端服务 (Express + sql.js + JWT)
│   ├── src/
│   │   ├── routes/      # 路由：auth / dreams / tags / ai / admin
│   │   ├── middleware/  # 鉴权 / 审计 / 错误处理 / Token 黑名单
│   │   ├── db/          # sql.js 数据库封装与迁移
│   │   ├── utils/       # 情绪映射等工具
│   │   └── __tests__/   # 单元测试 + 集成测试
│   ├── .env.example
│   └── Dockerfile
├── web/                 # 用户前端 (React + TypeScript + Vite)
│   ├── src/
│   │   ├── pages/       # 首页 / 记录 / 详情 / 日历 / 统计 / 设置
│   │   ├── components/  # 情绪选择器 / 梦境卡片 / 白噪音 / 语音录入
│   │   ├── hooks/       # 情绪主题 / 流星 / 星空 / 萤火虫动效
│   │   └── services/    # API 封装
│   ├── public/assets/   # 情绪背景图 / 图标 / 音频
│   └── Dockerfile
├── admin/               # 后台管理 (React + Ant Design + Vite)
│   ├── src/
│   │   ├── pages/       # 仪表盘 / 梦境管理 / 用户管理 / AI 配置 / 日志
│   │   └── services/    # API 封装
│   └── Dockerfile
├── 参考页面/            # 早期静态参考页面与设计稿
├── docker-compose.yml
└── README.md
```

## 快速启动

### 方式一：本地开发

#### 1. 启动后端服务

```bash
cd server
npm install
cp .env.example .env       # 首次运行需复制环境变量模板
npm run dev
# 服务运行在 http://localhost:3100
```

默认管理员账户：`admin` / `admin123`

#### 2. 启动用户前端

```bash
cd web
npm install
npm run dev
# 前端运行在 http://localhost:5173
```

#### 3. 启动后台管理

```bash
cd admin
npm install
npm run dev
# 管理端运行在 http://localhost:5174
```

### 方式二：Docker Compose 一键部署

```bash
cd Dreamwave
docker compose up -d
```

服务端口：

| 服务 | 端口 | 访问地址 |
|------|------|----------|
| 用户端 | 80 | http://localhost |
| 管理端 | 5174 | http://localhost:5174 |
| API | 3100 | http://localhost:3100 |

数据持久化：Docker Volume `dreamwave-data`

## 功能清单

### 用户前端（web/）

| 功能 | 状态 | 说明 |
|------|------|------|
| 梦境记录 | ✅ | 文本录入 + 语音录入（Web Speech API） |
| 情绪标记 | ✅ | 6种情绪维度（喜悦/平静/悲伤/恐惧/奇妙/怀念） |
| 标签系统 | ✅ | 自定义标签 + 梦境关联 + 标签筛选 |
| 搜索功能 | ✅ | 关键字搜索 + 情绪/标签/收藏组合筛选 |
| 梦境卡片 | ✅ | 时间倒序 + 情绪氛围背景 + 收藏星标 |
| 梦境详情 | ✅ | 情绪主题 + AI 叙事生成 + 相关梦境推荐 |
| 日历视图 | ✅ | 月历 + 情绪标记点 + 日期筛选 |
| 编辑删除 | ✅ | 编辑/删除已有梦境 |
| 情绪统计 | ✅ | 个人情绪趋势图 + 梦境频率统计 + 标签统计 |
| 收藏功能 | ✅ | 收藏/取消收藏重要梦境 |
| 导出功能 | ✅ | 梦境导出为 Markdown/TXT/JSON |
| 白噪音 | ✅ | 雨声 / 夏夜 / 林风三种环境音 |
| 沉浸动效 | ✅ | 流星 / 星空 / 萤火虫 / 星云动画 |
| 暗色模式 | ✅ | 亮/暗主题切换 |
| 用户认证 | ✅ | 注册 / 登录 / 修改密码 / Token 刷新 |

### 后台管理（admin/）

| 功能 | 状态 | 说明 |
|------|------|------|
| 数据概览 | ✅ | 梦境数 / 用户数 / 情绪分布统计 + 趋势图表 |
| 梦境管理 | ✅ | 查看所有梦境 + 搜索 + 删除 + 详情弹窗 |
| 用户管理 | ✅ | 用户列表 + 分页搜索 + 启用/禁用 |
| AI 配置 | ✅ | AI 模型参数配置 |
| AI 调用日志 | ✅ | AI 解读调用记录与统计 |
| 操作日志 | ✅ | 管理员操作记录审计 |
| 系统设置 | ✅ | 基础配置管理 |

## 技术栈

| 层次 | 技术 |
|------|------|
| 后端 | Node.js + Express + TypeScript + sql.js + JWT + Zod |
| 用户前端 | React 18 + TypeScript + Vite + CSS Modules |
| 管理前端 | React 18 + Ant Design 5 + Vite + Ant Design Charts |
| 数据库 | SQLite（sql.js 纯 JS 实现） |
| 鉴权 | JWT + bcryptjs + Token 黑名单 |
| 安全 | Helmet + express-rate-limit + CORS |
| 部署 | Docker + Docker Compose + Nginx |
| 测试 | Vitest + Testing Library |

## API 概览

### 认证（6个）

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/auth/register` | POST | 用户注册 | 否 |
| `/api/auth/login` | POST | 用户登录 | 否 |
| `/api/auth/me` | GET | 获取当前用户 | 是 |
| `/api/auth/logout` | POST | 用户登出（Token 加入黑名单） | 是 |
| `/api/auth/refresh` | POST | 刷新 Token | 是 |
| `/api/auth/password` | PUT | 修改密码 | 是 |

### 梦境（16个）

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/dreams` | GET | 梦境列表（分页 / 情绪筛选） | 是 |
| `/api/dreams` | POST | 创建梦境 | 是 |
| `/api/dreams/search` | GET | 搜索（关键字/情绪/标签/收藏） | 是 |
| `/api/dreams/stats` | GET | 个人统计 | 是 |
| `/api/dreams/export` | GET | 导出（markdown/txt/json） | 是 |
| `/api/dreams/dates/list` | GET | 有记录的日期列表 | 是 |
| `/api/dreams/date/:date` | GET | 按日期查询 | 是 |
| `/api/dreams/:id` | GET | 梦境详情 | 是 |
| `/api/dreams/:id` | PUT | 更新梦境 | 是 |
| `/api/dreams/:id` | DELETE | 删除梦境 | 是 |
| `/api/dreams/:id/narrative` | POST | 生成叙事 | 是 |
| `/api/dreams/:id/favorite` | PUT | 切换收藏 | 是 |
| `/api/dreams/:id/related` | GET | 相关梦境推荐 | 是 |
| `/api/dreams/:id/tags` | GET | 获取标签列表 | 是 |
| `/api/dreams/:id/tags` | POST | 添加标签 | 是 |
| `/api/dreams/:id/tags/:tagId` | DELETE | 移除标签 | 是 |

### 标签（4个）

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/tags` | GET | 获取所有标签 | 是 |
| `/api/tags` | POST | 创建标签 | 是 |
| `/api/tags/:id` | PUT | 更新标签 | 是 |
| `/api/tags/:id` | DELETE | 删除标签 | 是 |

### AI（1个）

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/ai/interpret` | POST | AI 梦境解读 | 是 |

### 管理（7个）

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/admin/stats` | GET | 统计概览 | 管理员 |
| `/api/admin/stats/trends` | GET | 趋势数据 | 管理员 |
| `/api/admin/dreams` | GET | 梦境列表 | 管理员 |
| `/api/admin/dreams/:id` | DELETE | 删除梦境 | 管理员 |
| `/api/admin/users` | GET | 用户列表 | 管理员 |
| `/api/admin/users/:id/status` | PUT | 切换用户状态 | 管理员 |
| `/api/admin/logs` | GET | 操作日志 | 管理员 |

### 系统（1个）

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/health` | GET | 健康检查 | 否 |

**API 端点总计：29个**

## 环境变量

服务端 `.env` 模板（参考 `server/.env.example`）：

```env
PORT=3100
NODE_ENV=development
JWT_SECRET=your-secret-key-change-in-production
DATABASE_PATH=./data/dreamwave.db
CORS_ORIGIN=http://localhost:5173,http://localhost:5174
AI_API_KEY=your-ai-provider-api-key
AI_API_BASE=https://api.openai.com/v1
```

## 测试

```bash
# 后端测试
cd server && npm test

# 用户端测试
cd web && npm test
```

## 开发计划与进度

- 📋 [开发计划](docs/开发计划.md)
- 📊 [开发进度](docs/开发进度.md)
- 📦 [资源检查清单与更新说明](docs/资源检查清单与更新说明.md)

## 资源版权

所有图片、音频资源版权说明见 [web/public/assets/资源清单与版权说明.md](web/public/assets/资源清单与版权说明.md)

## 许可证

MIT License — 详见 [LICENSE](LICENSE)
