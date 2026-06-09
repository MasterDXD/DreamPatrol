# 贡献指南

感谢你对 Harness Engineering 多Agent框架的关注！

## 快速贡献流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交变更：`git commit -m "feat: 简要描述"`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

## 提交前验证

```bash
npm test                    # 运行全部测试
npx eslint src/ test/ scripts/  # 代码质量检查
npm run validate            # 框架一致性检查
```

## Commit消息格式

```
<type>: <subject>
```

type类型：`feat` | `fix` | `docs` | `style` | `refactor` | `test` | `chore`

## 详细开发规范

完整的开发规范（环境搭建、代码风格、TDD流程、模块模板、Skill/Agent/Command开发、测试规范、安全规范等）请参阅：

→ [开发指南-代码贡献规范](docs/guidelines/开发指南-代码贡献规范.md)

## 编辑器入口文件同步

修改框架核心内容后，必须同步更新以下4个入口文件：
1. `CLAUDE.md` — Claude Code
2. `.trae/rules/project_rules.md` — Trae
3. `.cursor/rules/harness-engineering.mdc` — Cursor
4. `.windsurfrules` — Windsurf

同步脚本：`node scripts/sync-editor-rules.js`
