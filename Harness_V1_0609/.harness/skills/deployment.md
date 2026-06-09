---
skill_id: deployment
name: 部署上线
applicable_agents: [devops-engineer]
trigger: 集成测试通过，需要部署到目标环境时
auto_trigger: true
phase: deployment
priority: 7
trigger_conditions:
  - integration-testing skill passes all tests
  - user mentions "部署" or "deployment" or "上线" or "发布"
  - user asks to deploy to staging or production environment
  - verification-before-completion skill confirms all checks pass
depends_on: [integration-testing, verification-before-completion]
blocks: []
causal_inputs:
  - name: test-results
    source: integration-testing
    required: true
  - name: verification-evidence
    source: verification-before-completion
    required: true
causal_outputs:
  - name: deployment-record
    description: 部署记录
  - name: health-check-report
    description: 健康检查报告
  - name: deployment-checklist
    description: 上线检查清单
evidence_types:
  required:
    - deployment_verification
    - health_check
verified: true
stability: stable
usage_count: 90
success_rate: 0.94
enforcement: strict
tools:
  - deploy-orchestrator: 部署编排工具
  - health-checker: 健康检查工具
  - rollback-manager: 回滚管理工具
  - config-validator: 配置验证工具
model: claude-3-5-sonnet-20240620
production_validated: true
---

# Skill: 部署上线

## 任务目标
将通过测试的代码安全、稳定地部署到目标环境，确保服务可用且可回滚。

## 执行步骤

### 3步部署流程（v2.7.109增强，源自Azure Deploy Skill模式）

部署遵循严格的3步流程，每步必须通过验证才能进入下一步：

**第1步：准备（Prepare）**
- 确认测试通过、代码已合并
- 确认环境配置正确
- 确认回滚方案就绪
- 确认依赖可用
- 确认数据库迁移脚本就绪
- ❌ 准备未通过 → 阻断部署，返回修复

**第2步：验证（Validate）**
- 验证部署包完整性
- 验证配置项正确性
- 验证安全设置（密钥轮换、访问控制）
- 验证监控告警配置
- ❌ 验证未通过 → 阻断部署，返回修复

**第3步：部署（Deploy）**
- 按策略执行部署（rolling/blue-green/canary/recreate）
- 每步验证，记录日志
- 部署后健康检查
- 冒烟测试
- ❌ 部署失败 → 自动回滚到previousVersion

### 详细执行流程
1. **部署前检查**：
   - 确认所有测试已通过（单元测试 + 集成测试）
   - 确认代码已合并到shared工作区
   - 确认部署环境配置正确
   - 确认回滚方案就绪
2. **准备部署包**：
   - 构建项目（编译、打包、镜像构建）
   - 生成版本号和变更日志
   - 创建部署快照
3. **执行部署**：
   - 按部署计划逐步执行
   - 每步验证执行结果
   - 记录部署操作日志
4. **部署后验证**：
   - 健康检查（服务是否正常响应）
   - 冒烟测试（核心功能是否可用）
   - 监控指标检查（CPU、内存、错误率）
5. **配置监控**：
   - 确认监控和告警已配置
   - 确认日志收集正常
   - 设置关键指标阈值
6. **生成文档**：
   - 部署记录（版本、时间、操作人）
   - 运维手册
   - 回滚操作指南

## 验收标准
- 部署成功，服务健康检查通过
- 冒烟测试全部通过
- 监控和告警配置完成
- 回滚方案验证可行
- 部署文档完整

## 常见问题
- **Q: 部署失败如何回滚？**
  A: 立即执行回滚方案，从最近快照恢复，记录失败原因
- **Q: 生产部署需要停机怎么办？**
  A: 采用蓝绿部署或滚动更新，避免停机
- **Q: 部署后发现缺陷怎么办？**
  A: 评估严重程度，P0缺陷立即回滚，P1以下可热修复
