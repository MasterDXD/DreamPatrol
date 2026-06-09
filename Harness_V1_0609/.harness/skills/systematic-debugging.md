---
skill_id: systematic-debugging
name: 系统化调试
applicable_agents: [task-worker, domain-analyst, build-error-solver]
trigger: 遇到难以定位的Bug或复杂故障时
auto_trigger: true
phase: module-development
priority: 4
trigger_conditions:
  - bug-fix skill cannot reproduce or locate the root cause
  - user mentions "调试" or "debug" or "排查问题" or "定位根因"
  - integration-testing reveals intermittent or complex failures
  - error logs are unclear or contradictory
depends_on: []
blocks: [bug-fix]
causal_inputs:
  - name: bug-report
    required: false
causal_outputs:
  - name: root-cause-analysis
    description: 根因分析报告
  - name: debug-log
    description: 调试日志
enforcement: recommended
verified: true
stability: stable
usage_count: 130
success_rate: 0.89
tools:
  - log-analyzer: 日志分析工具
  - breakpoint-manager: 断点管理工具
  - trace-collector: 追踪收集工具
  - root-cause-analyzer: 根因分析工具
model: claude-3-5-sonnet-20240620
production_validated: true
evidence_types:
  required:
    - debug_report
    - root_cause_analysis
---

# Skill: 系统化调试

## 任务目标
通过四阶段系统化调试流程，从现象出发逐步定位根因，避免凭直觉猜测和盲目修改代码。

## 执行步骤

### 阶段1：隔离（Isolate）
1. **可靠复现**：
   - 确定最小复现步骤
   - 排除环境因素（在干净环境中复现）
   - 记录复现条件（输入数据、系统状态、时序）
2. **缩小范围**：
   - 二分法定位：逐步排除无关代码路径
   - 确认问题出现的最小代码范围
   - 区分前端/后端/数据库/网络等层面
3. **收集信息**：
   - 记录完整的错误信息和调用栈
   - 收集相关日志（前后各10行上下文）
   - 记录系统状态（内存、CPU、网络）

### 阶段2：假设（Hypothesize）
4. **生成假设**：
   - 基于收集的信息，列出3-5个可能的根因假设
   - 按可能性排序（最可能的排第一）
   - 每个假设必须可验证（能设计实验证明或证伪）
5. **评估假设**：
   - 检查每个假设是否与所有已知信息一致
   - 排除与已知事实矛盾的假设
   - 标记需要额外信息才能判断的假设

### 阶段3：验证（Verify）
6. **设计验证实验**：
   - 为最可能的假设设计验证方法
   - 验证方法应最小化对系统的修改
   - 优先选择可快速执行的验证（加日志 > 加断点 > 修改代码）
7. **执行验证**：
   - 按设计执行验证实验
   - 记录实验结果（支持/否定假设）
   - 如果假设被否定，转向下一个假设
8. **确认根因**：
   - 当假设被验证时，确认这就是根因而非表象
   - 检查根因是否还导致其他未发现的问题
   - 记录根因的完整因果链

### 阶段4：修复（Fix）
9. **创建失败测试**：
   - 先编写一个能复现根因的失败测试
   - 运行测试确认失败（RED）
10. **实施修复**：
    - 编写最小化的修复代码
    - 运行测试确认通过（GREEN）
    - 运行全量测试确认无回归
11. **验证修复**：
    - 用原始复现步骤确认问题已解决
    - 检查修复是否引入新问题
    - 更新相关文档和注释

## 调试原则
- **不猜测**：每个结论必须有证据支撑
- **不跳跃**：严格按隔离→假设→验证→修复顺序执行
- **不盲改**：修改代码前必须有明确的假设和验证计划
- **不遗漏**：修复后必须验证原始问题和潜在衍生问题

## 验收标准
- 根因有明确的因果链记录
- 修复前有失败测试先行（TDD）
- 修复后全量测试通过
- 原始复现步骤不再触发问题
- 调试过程有完整记录（假设、实验、结果）

## 常见问题
- **Q: 无法可靠复现怎么办？**
  A: 增加日志和监控，在下次出现时收集更多信息。检查是否与并发、时序、资源竞争有关
- **Q: 多个假设都合理怎么办？**
  A: 优先验证最容易验证的假设（需要最少修改的），同时设计能区分这些假设的实验
- **Q: 根因在第三方库怎么办？**
  A: 记录问题详情，寻找workaround，向库作者报告issue，评估是否需要替换依赖
- **Q: 修复后出现新问题怎么办？**
  A: 立即回退修复，重新评估根因假设，新问题可能揭示了更深层的根因
