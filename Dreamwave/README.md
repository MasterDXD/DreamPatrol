# 巡梦 (Dreamwave) — 梦境记录Web应用

> 第二期灵治擂台赛参赛作品

## 项目结构

```
Dreamwave/
├── docs/          # 开发文档
├── server/        # 后端服务 (Express + sql.js + JWT)
├── web/           # 用户前端 (React + TypeScript + Vite)
└── admin/         # 后台管理 (React + Ant Design + Vite)
```

## 快速启动

### 1. 启动后端服务

```bash
cd server
npm install
npm run dev
# 服务运行在 http://localhost:3100
```

默认管理员账户：`admin` / `admin123`

### 2. 启动用户前端

```bash
cd web
npm install
npm run dev
# 前端运行在 http://localhost:5173
```

### 3. 启动后台管理

```bash
cd admin
npm install
npm run dev
# 管理端运行在 http://localhost:5174
```

## 功能清单

### 用户前端
- 文本录入梦境 + 语音录入 (Web Speech API)
- 6种情绪标记 (喜悦/平静/悲伤/恐惧/奇妙/怀念)
- 梦境卡片列表 (时间倒序)
- 梦境详情页 (情绪氛围背景 + 叙事生成)
- 日历视图 (月历 + 情绪标记点)
- 编辑/删除梦境
- 用户注册/登录

### 后台管理
- 数据概览统计 (梦境数/用户数/情绪分布)
- 梦境管理 (搜索/删除)
- 用户管理 (禁用/启用)

## 技术栈

| 层次 | 技术 |
|------|------|
| 后端 | Node.js + Express + TypeScript + sql.js + JWT |
| 用户前端 | React 18 + TypeScript + Vite + CSS Modules |
| 管理前端 | React 18 + Ant Design 5 + Vite |
| 数据库 | SQLite (sql.js 纯JS实现) |
