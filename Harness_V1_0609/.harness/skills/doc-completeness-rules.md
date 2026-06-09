---
skill_id: doc-completeness-rules
name: 文档完整性规则
trigger: "文档完整性 文档检查 文档先行 需求规格 架构文档"
auto_trigger: true
phase: module-development
priority: 0
applicable_agents: [team-lead, domain-analyst, task-worker, quality-assurance]
depends_on: []
blocks: [tdd-implement, module-development]
causal_inputs:
  - name: proposed-implementation
    required: false
causal_outputs:
  - name: doc-completeness-report
    description: 文档完整性检查报告
evidence_types:
  required:
    - doc_completeness_report
trigger_conditions:
  - "编码开始前"
  - "需求规格文档缺失"
  - "架构文档缺失"
  - "API文档缺失"
enforcement: strict
production_validated: true
stability: stable
usage_count: 0
success_rate: 0
tools:
  - doc-scanner: 文档扫描
  - requirement-checker: 需求规格检查
  - architecture-checker: 架构文档检查
model: claude-3-opus-20240229
verified: true
---

# 文档完整性规则 — 编码前文档先行强制技能

## 触发条件
- 编码实现开始前
- 需求规格说明书缺失时
- 架构设计文档缺失时
- API接口文档缺失时
- 模块开发阶段入口

## 检查规则

### 第一步：需求规格文档存在性检查
1. **需求规格说明书是否存在？** 检查 docs/ 目录下是否有对应的需求规格文档
2. **需求是否明确？** 文档中是否包含功能描述、验收标准、边界条件
3. **需求是否经过审批？** 是否有Team Lead或Domain Analyst的审批记录

### 第二步：架构文档存在性检查
1. **架构设计文档是否存在？** 检查 docs/architecture/ 下是否有对应的架构文档
2. **模块划分是否明确？** 文档中是否包含模块职责、接口定义、依赖关系
3. **技术选型是否有依据？** 关键技术决策是否有文档记录

### 第三步：API文档存在性检查（如适用）
1. **API接口文档是否存在？** 对外暴露的API是否有文档
2. **接口契约是否明确？** 请求/响应格式、错误码、认证方式
3. **接口版本是否记录？** API版本号和变更历史

### 第四步：输出检查报告

```markdown
## 文档完整性检查报告
- **检查对象**：XXX
- **需求规格文档**：存在/缺失
- **架构设计文档**：存在/缺失
- **API文档**：存在/缺失/不适用
- **完整性评分**：X/3（通过≥2）
- **建议**：允许编码/补充文档后编码/阻塞编码
- **缺失文档清单**：XXX
```

## 阻塞规则
- 需求规格文档缺失时，阻塞编码实现
- 架构文档缺失且涉及多模块交互时，阻塞编码实现
- 文档完整性评分低于1时，自动阻塞
- 紧急修复可跳过文档检查，但需事后补齐

## 任务目标
在编码实现开始前，确保相关文档（需求规格、架构设计、API文档）已存在且内容完整，防止无文档编码导致的返工和质量问题。

## 执行步骤
1. 检测触发条件（编码开始前、文档缺失）
2. 执行需求规格文档存在性检查
3. 执行架构文档存在性检查
4. 执行API文档存在性检查（如适用）
5. 输出完整性检查报告
6. 根据评分决定是否阻塞编码

## 验收标准
- 检查报告完整包含三类文档的存在性状态
- 缺失文档被明确列出
- 需求规格缺失时编码被阻塞
- 文档完整性评分低于1时编码被阻塞

## 常见问题
- Q: 紧急bug修复是否需要文档？ A: 紧急修复可跳过，但事后需补齐
- Q: 小改动是否需要完整文档？ A: 影响范围小于3个文件的改动可简化文档
- Q: 文档内容不完整怎么办？ A: 标记为"部分存在"，要求补充后才能编码
