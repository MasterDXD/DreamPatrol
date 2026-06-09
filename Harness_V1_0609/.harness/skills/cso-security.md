---
skill_id: cso-security
name: 安全官审计
applicable_agents: [reviewer]
trigger: 需要系统化安全审计时
auto_trigger: false
phase: module-development
priority: 5
trigger_conditions:
  - code handles user input, authentication, or sensitive data
  - user mentions "安全审计" or "security audit" or "OWASP" or "STRIDE"
  - module-development produces code with security-sensitive operations
  - periodic security review is needed
depends_on: [code-review]
blocks: []
causal_inputs:
  - name: module-source-code
    source: module-development
    required: true
causal_outputs:
  - name: security-audit-report
    description: 安全审计报告
  - name: threat-model
    description: STRIDE威胁模型
  - name: vulnerability-list
    description: 漏洞清单
evidence_types:
  required:
    - security_audit_report
    - threat_model
enforcement: strict
model_tier: medium
tags: [security, owasp, stride, audit]
verified: true
stability: stable
---

# Skill: 安全官审计

## 任务目标
执行系统化安全审计，结合OWASP Top 10和STRIDE威胁建模，识别代码中的安全漏洞和威胁向量。遵循Boil the Lake原则——不做安全表演，只关注真实可利用的威胁。

## 执行步骤

### OWASP Top 10检查（10项必查）

1. **A01-权限控制失效**：越权访问、IDOR、缺失权限检查
2. **A02-加密机制失效**：弱加密算法、硬编码密钥、明文传输
3. **A03-注入攻击**：SQL注入、XSS、命令注入、LDAP注入
4. **A04-不安全设计**：缺失安全控制、信任边界不清
5. **A05-安全配置错误**：默认配置、未关闭调试模式、CORS配置
6. **A06-过时组件**：已知漏洞的依赖、未更新的框架
7. **A07-身份认证失效**：弱密码策略、会话管理缺陷、Token泄露
8. **A08-软件和数据完整性失效**：未验证的更新、CI/CD管道漏洞
9. **A09-安全日志和监控失效**：缺失审计日志、未监控异常行为
10. **A10-服务端请求伪造**：SSRF漏洞、未限制的外部请求

### STRIDE威胁建模（6类威胁逐一分析）

- **S-Spoofing（欺骗）**：身份冒充、凭证窃取
- **T-Tampering（篡改）**：数据篡改、参数污染
- **R-Repudiation（抵赖）**：操作不可追溯、日志缺失
- **I-Information Disclosure（信息泄露）**：敏感数据暴露、错误信息泄露
- **D-Denial of Service（拒绝服务）**：资源耗尽、慢速攻击
- **E-Elevation of Privilege（权限提升）**：越权操作、角色绕过

### 14阶段安全审计流程

1. 确定审计范围和资产清单
2. 绘制数据流图和信任边界
3. 执行STRIDE威胁建模
4. OWASP Top 10逐项检查
5. 输入验证审计
6. 认证与授权审计
7. 会话管理审计
8. 加密与密钥管理审计
9. 日志与监控审计
10. 依赖安全审计
11. 配置安全审计
12. API安全审计
13. 漏洞汇总与风险评级
14. 生成安全审计报告和修复建议

## 验收标准
- OWASP Top 10每项有明确审计结论
- STRIDE威胁建模覆盖所有关键资产
- 所有发现的漏洞按CVSS评分分级
- 审计报告包含：威胁模型、漏洞清单、修复建议、风险评级
- 高危漏洞必须附带PoC（概念验证）或复现步骤

## 角色边界约束
- **禁止**：讨论功能需求和产品方向（这是产品审查的工作）
- **禁止**：将高危漏洞标记为"低优先级"
- **禁止**：在存在高危漏洞时批准代码合并
- **禁止**：以"内部系统"为由降低安全标准

## FAQ

### Q: 这个Skill的主要用途是什么？
A: 执行系统化安全审计，结合OWASP Top 10和STRIDE威胁建模，通过14阶段审计流程识别代码中的安全漏洞和威胁向量，输出包含威胁模型、漏洞清单和修复建议的安全审计报告。

### Q: 适用于哪些场景？
A: 适用于代码处理用户输入、认证授权或敏感数据时的安全审计场景，包括模块开发后的安全审查、周期性安全审计、以及代码合并前的安全门禁检查。

### Q: 使用此Skill的前提条件是什么？
A: 需要已完成代码审查（code-review），提供待审计的模块源代码，并对OWASP Top 10和STRIDE威胁建模方法论有基本了解。
