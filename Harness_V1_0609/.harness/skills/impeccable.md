---
skill_id: impeccable
name: 设计规范落地
applicable_agents: [task-worker, domain-analyst]
trigger: 前端界面需要设计规范审查、打磨或优化时
auto_trigger: true
phase: module-development
priority: 2
trigger_conditions:
  - user mentions "设计审查" or "design audit" or "polish" or "打磨"
  - user asks to improve frontend visual quality
  - frontend code contains anti-patterns
depends_on: [architecture-design]
blocks: []
causal_inputs:
  - name: design-language-document
    source: design-md
    required: false
  - name: module-source-code
    source: module-development
    required: false
causal_outputs:
  - name: polished-code
    description: 打磨后的代码
  - name: anti-pattern-report
    description: 反模式报告
evidence_types:
  required:
    - design_audit_report
    - polish_diff
enforcement: recommended
verified: true
stability: stable
usage_count: 55
success_rate: 0.86
production_validated: true
---

# Skill: Impeccable 设计规范落地

## 任务目标
对AI生成的前端界面进行系统性设计规范审查与优化，消除"AI味"反模式，提升视觉专业度。

## 核心命令

### /audit — 全面设计审查
运行系统性质量检查，生成包含优先级排序的问题列表和可操作建议的审查报告。

### /polish — 打磨细节
自动修复常见的AI设计反模式：
- 纯黑 #000000 → 偏黑 Zinc-950 (#09090b)
- 霓虹外发光 → 柔和分层阴影
- 紫蓝AI渐变 → 单色系低饱和度渐变
- 系统默认字体 → 专业字体栈
- 默认ease缓动 → cubic-bezier物理缓动

### /critique — UX评估
对指定区域进行用户体验评估，输出改进建议。

### /normalize — 规范化
提取并整合可复用的设计令牌、组件模式和设计系统。

### /harden — 强化健壮性
改善错误处理、国际化支持、文本溢出处理和边界情况管理。

## 反模式规则

| 规则ID | 严重度 | 描述 | 修复方案 |
|--------|--------|------|----------|
| no-pure-black | 高 | 禁止纯黑 #000000 | 使用 Zinc-950 (#09090b) |
| no-neon-glow | 高 | 禁止霓虹外发光 | 使用柔和分层阴影 |
| no-ai-gradient | 高 | 禁止紫蓝AI渐变 | 使用单色系低饱和度渐变 |
| no-default-shadow | 中 | 禁止大面积默认阴影 | 使用分层阴影系统 |
| no-oversaturated | 中 | 避免过饱和色彩 | 降低饱和度至60-80% |
| no-system-font | 低 | 避免系统默认字体 | 使用专业字体栈 |

## 排版规范
- 使用模块化排版比例（xs → display，10级）
- 字重：400/500/600/700/800，禁止随意使用
- 字间距（tracking）随字号增大而收紧

## 执行步骤
1. 使用 DesignSkillEngine.audit() 扫描源码
2. 分析审查报告，按严重度排序
3. 使用 DesignSkillEngine.polish() 自动修复
4. 手动审查无法自动修复的问题
5. 使用 DesignSkillEngine.critique() 验证修复效果
6. 输出修复报告，包含前后对比

## 交付物
- 设计审查报告（评分、问题列表、修复建议）
- 修复后的源码
- 修复验证报告

## 验收标准
- 所有高严重度反模式已修复（纯黑、霓虹发光、AI渐变）
- 审查评分提升至少一个等级
- 修复后代码通过 DesignSkillEngine.critique() 验证
- 无新增反模式引入

## 常见问题

### Q: 自动修复后仍存在设计问题怎么办？
A: 自动修复处理常见模式，复杂问题需手动调整。使用 /critique 命令定位具体问题，按优先级逐项修复。

### Q: 修复后性能是否受影响？
A: 规范化修复通常提升性能（如分层阴影替代大面积阴影、字体栈优化）。如有关注点，使用 /harden 命令检查性能指标。
