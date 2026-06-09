---
skill_id: security-audit
name: 安全审计
applicable_agents: [domain-analyst, quality-assurance, security-reviewer]
trigger: 模块开发完成或定期安全审查时
auto_trigger: true
phase: module-development
priority: 5
trigger_conditions:
  - module-development skill completes for a security-sensitive module
  - user mentions "安全审计" or "security audit" or "安全检查"
  - code-review skill finds potential security issues
  - user asks to check for security vulnerabilities
depends_on: [module-development]
blocks: [deployment]
causal_inputs:
  - name: module-source-code
    source: module-development
    required: true
  - name: review-report
    source: code-review
    required: false
causal_outputs:
  - name: security-audit-report
    description: 安全审计报告
  - name: vulnerability-list
    description: 漏洞列表
causal_invariants:
  - security-audit-report
enforcement: strict
verified: true
stability: stable
usage_count: 75
success_rate: 0.91
tools:
  - vulnerability-scanner: 漏洞扫描
  - dependency-auditor: 依赖审计
  - secret-detector: 敏感信息检测
  - compliance-checker: 合规检查
model: claude-3-opus-20240229
production_validated: true
evidence_types:
  required:
    - security_report
---

# Skill: 安全审计

## 任务目标
对代码和配置进行安全审查，发现潜在的安全漏洞、敏感信息泄露和权限越界风险，确保系统安全性。

## 执行步骤
1. **确定审计范围**：
   - 确认本次审计的模块和文件范围
   - 获取相关的接口定义和权限配置
2. **敏感信息扫描**：
   - 检查代码中是否有硬编码的密钥、密码、Token
   - 检查配置文件中的敏感信息是否加密
   - 检查日志中是否泄露敏感数据
3. **输入验证检查**：
   - 检查所有外部输入是否经过验证
   - 检查SQL查询是否使用参数化（防注入）
   - 检查命令执行是否过滤特殊字符
4. **认证授权检查**：
   - 检查API端点是否都有认证保护
   - 检查权限控制是否按最小权限原则
   - 检查Token过期和刷新机制
5. **数据安全检查**：
   - 检查敏感数据是否加密存储
   - 检查数据传输是否使用HTTPS
   - 检查数据备份和恢复机制
6. **生成审计报告**：
   - 按严重程度分类（严重/高/中/低）
   - 每个问题附带修复建议
   - 提交给Team Lead和对应Worker

## 验收标准
- 所有安全检查项均有明确结论
- 严重和高危漏洞必须立即修复
- 审计报告格式规范，修复建议可操作
- 修复后需重新验证

## 常见问题
- **Q: 发现严重安全漏洞怎么办？**
  A: 立即通知Team Lead，标记为P0优先级，要求Worker优先修复
- **Q: 第三方依赖有已知漏洞怎么办？**
  A: 记录漏洞信息，评估影响，建议升级到安全版本或寻找替代方案
- **Q: 安全与性能冲突怎么办？**
  A: 安全优先，但需记录权衡决策，寻找兼顾方案
