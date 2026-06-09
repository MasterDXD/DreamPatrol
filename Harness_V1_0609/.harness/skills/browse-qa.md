---
skill_id: browse-qa
name: 浏览器QA测试
applicable_agents: [task-worker]
trigger: 需要真实浏览器验证UI状态和功能时
auto_trigger: false
phase: integration-testing
priority: 6
trigger_conditions:
  - integration-testing skill needs browser-level verification
  - user mentions "浏览器测试" or "browser QA" or "UI验证" or "Playwright测试"
  - UI functionality needs real browser validation
depends_on: []
blocks: []
causal_inputs:
  - name: deployed-url
    source: deployment
    required: false
causal_outputs:
  - name: qa-screenshots
    description: QA截图证据
  - name: console-errors
    description: 控制台错误报告
  - name: qa-report
    description: 浏览器QA测试报告
evidence_types:
  required:
    - qa_screenshots
    - console_log
enforcement: recommended
model_tier: medium
tags: [qa, browser, playwright, testing]
verified: true
stability: stable
---

# Skill: 浏览器QA测试

## 任务目标
使用Playwright进行真实浏览器自动化QA测试，验证UI状态、交互功能和视觉表现。60秒内完成完整QA流程，输出截图证据和控制台错误报告。遵循Boil the Lake原则——只测试用户真实使用的路径，不测试不存在的功能。

## 执行步骤

### Playwright浏览器自动化QA流程（60秒完整流程）

1. **启动浏览器**（5秒）：
   - 使用Playwright启动Chromium浏览器
   - 设置视口大小为标准桌面分辨率（1280x720）
   - 配置网络拦截（如需mock API）

2. **登录验证**（10秒）：
   - 导航到登录页面
   - 输入测试账号凭据
   - 点击登录按钮
   - 验证登录成功（检查URL跳转或用户信息显示）
   - 截图保存登录状态

3. **核心功能点击测试**（20秒）：
   - 按优先级遍历核心页面和交互
   - 每个关键操作后截图
   - 验证页面元素可见性和交互响应
   - 检查表单提交、导航跳转、弹窗交互

4. **截图与状态读取**（10秒）：
   - 对每个关键页面进行全页截图
   - 读取关键元素的文本内容和状态
   - 对比预期值与实际值

5. **控制台错误检查**（10秒）：
   - 收集浏览器控制台所有错误和警告
   - 过滤出JavaScript错误和网络错误
   - 标记影响功能的严重错误

6. **生成QA报告**（5秒）：
   - 汇总截图、错误、测试结果
   - 输出结构化QA报告

## 验收标准
- 所有核心页面有截图证据
- 控制台无未处理的JavaScript错误
- 关键交互功能验证通过
- QA报告包含：截图列表、错误列表、功能验证结果
- 总耗时不超过60秒

## 角色边界约束
- **禁止**：修改任何代码（QA只测试，不修复）
- **禁止**：跳过控制台错误检查
- **禁止**：使用硬编码的等待时间（必须用智能等待）
- **禁止**：忽略视觉异常（布局错乱、元素重叠等必须报告）

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 使用Playwright进行真实浏览器自动化QA测试，验证UI状态、交互功能和视觉表现，在60秒内完成完整QA流程并输出截图证据和控制台错误报告。

### Q: 适用于哪些场景？
A: 适用于集成测试阶段需要真实浏览器环境验证的场景，包括登录验证、核心功能点击测试、页面截图与状态读取、控制台错误检查等。特别适合Web应用的UI自动化测试。

### Q: 使用此Skill的前提条件是什么？
A: 需要部署Playwright测试环境，已部署待测试的Web应用（有可访问的URL），准备测试账号凭据，并明确核心页面的测试路径和预期行为。
