# Commit纪律规则

## 目标
防止git提交记录混乱，确保开发脉络清晰可追溯。Vibe coding容易产生大量无意义commit，需通过纪律约束保持代码仓库健康。

## 规则

### 1. Commit频率限制
- 每天最多5个有意义的commit
- 合并相关改动为一个commit，而非每行修改一个commit
- 禁止"fix update"等无意义commit message

### 2. Commit Message规范
- 使用Conventional Commits格式：`type(scope): description`
- type必须是以下之一：feat/fix/refactor/docs/test/chore/perf/ci
- description用祈使句（如"add feature"而非"added feature"）
- 长度不超过72字符

### 3. 提交前检查
- 每次commit前运行ESLint检查
- 确保不提交debugger/console.log等调试代码
- 确保不提交.env/credentials等敏感文件
- 确保测试通过

### 4. 分支纪律
- 功能开发使用feature/前缀分支
- 修复使用fix/前缀分支
- 主分支禁止force push
- 合并前必须通过code review

## 执行方式
- 本规则为建议级别（recommended），通过hook-handlers的quality_standards检查部分执行
- Commit频率和message格式需开发者自律，框架提供检查建议但不强制拦截
- 使用`/review`命令可在提交前进行代码质量检查
