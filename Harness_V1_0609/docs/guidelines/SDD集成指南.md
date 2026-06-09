# SDD集成指南

> 版本：2.73.4 | 适用对象：架构师、开发者、运维工程师

---

## 什么是SDD

SDD（Specification-Driven Development，规格驱动开发）是一种以规格文档为核心驱动力的开发方法论。在传统开发中，规格文档往往是一次性交付物，写完即归档，与实际代码逐渐脱节。SDD将规格提升为"活资产"，要求：

1. **规格先行**：编码前必须有明确的规格定义
2. **持续验证**：规格与代码的一致性需要持续检查
3. **漂移检测**：当代码偏离规格时及时预警
4. **门禁管控**：未通过规格验证的阶段不可推进

### 为什么AI时代需要SDD

在AI辅助开发中，SDD的价值更加突出：

| 挑战 | SDD的应对 |
|------|----------|
| AI生成的代码可能偏离原始意图 | 规格门禁阻止未验证代码进入下一阶段 |
| 上下文压缩可能丢失关键约束 | specification_asset策略确保规格资产不被压缩 |
| 多Agent协作时规格理解不一致 | MemoryStore统一管理规格资产，跨Agent共享 |
| 规格文档容易过时 | DocFreshnessGuard自动检测过期并触发再验证 |
| 代码变更影响范围难以评估 | ConfigCausalValidator的源码影响分析 |

---

## SDD在Harness框架中的映射

SDD集成横跨7个核心模块，覆盖框架的验证、记忆、质量、因果、编排、压缩和路由子系统：

```
需求探索阶段
  |-- 规格文档创建 --> MemoryStore.addKnowledge(specificationType)
  |-- 规格类型检测 --> DocFreshnessGuard._detectSpecType()
  |
需求分析阶段
  |-- 规格门禁注册 --> PhaseOrchestrator.registerSpecRequirement()
  |-- 规格语义匹配 --> SkillRouter.specification语义组
  |
架构设计阶段
  |-- 规格绑定声明 --> ConfigCausalValidator.specificationBindings
  |-- 规格资产保护 --> ContextCompressionEngine.specification_asset策略
  |
模块开发阶段
  |-- 规格一致性验证 --> EvidenceVerifier._assessSpecConformance()
  |-- 规格验证证据 --> specification_verified证据类型
  |
集成测试阶段
  |-- 规格门禁检查 --> PhaseOrchestrator._checkSpecGate()
  |-- 规格过期检测 --> DocFreshnessGuard.validateFreshness()
  |
部署上线阶段
  |-- 规格验证完成 --> PhaseOrchestrator.markSpecVerified()
  |-- 规格存活更新 --> MemoryStore.updateSpecLiveness()
```

---

## 分步使用指南

### 第1步：创建规格资产

在需求探索和需求分析阶段，将规格文档注册到MemoryStore：

```javascript
const MemoryStore = require('./src/runtime/thought/memory-store');
const memory = new MemoryStore(projectRoot);

await memory.ready;

const record = memory.addKnowledge({
  category: 'specification',
  title: '用户认证接口规格',
  content: '## 接口定义\n\nPOST /api/auth/login\n请求体: { username, password }\n响应: { token, expiresIn }',
  specificationType: 'interface',
  relatedCodePaths: ['src/web/server.js'],
  tags: ['auth', 'api', 'security'],
  source: 'requirement-analysis',
});

console.log('规格资产ID:', record.id);
console.log('初始存活状态:', record.livenessStatus);
```

关键点：
- `specificationType`必须指定，否则不会被识别为规格资产
- `relatedCodePaths`建议填写，用于后续的漂移检测
- `livenessStatus`自动设为`alive`

### 第2步：注册规格门禁

在阶段编排器中为相关阶段注册规格验证要求：

```javascript
const PhaseOrchestrator = require('./src/runtime/workflow/phase-orchestrator');
const orchestrator = new PhaseOrchestrator();

orchestrator.registerSpecRequirement('architecture-design', 'auth-api-spec');
orchestrator.registerSpecRequirement('module-development', 'auth-api-spec');
orchestrator.registerSpecRequirement('module-development', 'auth-behavior-spec');
orchestrator.registerSpecRequirement('integration-testing', 'auth-api-spec');

orchestrator.setCurrentPhase('architecture-design', 'initial');
```

监听门禁阻止事件：

```javascript
orchestrator.on('spec-gate-blocked', (data) => {
  console.warn(`阶段转换被阻止: ${data.from} -> ${data.to}`);
  console.warn(`未验证规格: ${data.missing.join(', ')}`);
  console.warn(`门禁阶段: ${data.gatePhase}`);
});
```

### 第3步：配置规格绑定

在`.harness/config.json`中声明Skill与源码的规格绑定关系：

```json
{
  "skill_registry": {
    "tdd-implement": {
      "specification_bindings": [
        "src/gate/tdd-gate.js",
        "src/gate/evidence-verifier.js"
      ]
    },
    "architecture-design": {
      "specification_bindings": [
        "src/runtime/workflow/phase-orchestrator.js"
      ]
    }
  }
}
```

构建依赖图并验证：

```javascript
const ConfigCausalValidator = require('./src/runtime/causal/causal-config-validator');
const causal = new ConfigCausalValidator(projectRoot);

causal.buildDependencyGraph();

const validation = causal.validate();
console.log('验证结果:', validation.valid);
console.log('警告:', validation.warnings.filter(w => w.type === 'missing_spec_binding'));

const sourceGraph = causal.getSourceCodeGraph();
const impact = causal.getImpactAnalysis('src/gate/evidence-verifier.js', 'sourceCode');
console.log('受影响的Skill:', impact.filter(i => i.type === 'skill'));
```

### 第4步：提供规格验证证据

在模块开发阶段，Agent需要提供`specification_verified`类型的证据：

```javascript
const EvidenceVerifier = require('./src/gate/evidence-verifier');
const verifier = new EvidenceVerifier();

const result = verifier.verify({
  claim: '用户认证接口实现完成',
  evidence: [
    { type: 'test_output', content: 'All 15 auth tests passed' },
    { type: 'coverage_report', content: 'Coverage 95.3%' },
    {
      type: 'specification_verified',
      content: '接口规格完全符合，POST /api/auth/login行为与规格定义一致',
      metadata: { specId: 'auth-api-spec' },
    },
  ],
  requiredTypes: ['test_output', 'coverage_report', 'specification_verified'],
  successCriteria: 'specification verified, coverage >= 90%',
});

if (result.specificationConformance) {
  console.log('规格一致性评分:', result.specificationConformance.conformanceScore);
  console.log('是否检测到漂移:', result.specificationConformance.driftDetected);
  console.log('关联规格ID:', result.specificationConformance.specIds);
}
```

注意`specification_verified`是软必需类型：即使缺失也不会导致验证失败，但会在`missing`列表中提示。

### 第5步：标记规格验证通过

当规格验证证据充分时，在阶段编排器中标记规格为已验证：

```javascript
orchestrator.markSpecVerified('module-development', 'auth-api-spec');

const gateState = orchestrator.getSpecGateState('module-development');
console.log('已验证规格:', gateState.verifiedSpecs);
console.log('未验证规格:', gateState.unverifiedSpecs);

const readiness = orchestrator.canAdvanceToNext(['tdd-implement', 'module-development']);
console.log('是否可以推进到下一阶段:', readiness);
```

### 第6步：管理规格存活状态

代码变更后，更新规格资产的存活状态：

```javascript
memory.updateSpecLiveness('mem-abc123', 'alive', [
  'src/web/server.js',
  'src/web/dashboard/auth-handler.js',
]);

const staleSpecs = memory.queryKnowledge({
  livenessStatus: 'stale',
  specificationType: 'interface',
});

const allInterfaceSpecs = memory.getSpecAssetsByType('interface');
```

### 第7步：处理规格过期

DocFreshnessGuard自动检测规格文档过期：

```javascript
const DocFreshnessGuard = require('./src/runtime/quality/doc-freshness-guard');
const freshness = new DocFreshnessGuard({ projectRoot });

await freshness.ready;

freshness.on('spec-stale', (data) => {
  console.warn(`规格过期: ${data.path}`);
  console.warn(`规格类型: ${data.specType}`);
  console.warn(`过期原因: ${data.staleReason}`);

  const result = freshness.triggerReverification(data.path);
  if (result.triggered) {
    console.log(`已触发再验证，第 ${result.attempt} 次`);
  }
});

freshness.startWatching();

const freshnessResult = freshness.validateFreshness();
console.log('新鲜度验证:', freshnessResult.valid);
console.log('新增过期文档:', freshnessResult.newlyStale);
```

### 第8步：规格感知的Skill路由

在Skill匹配时传入规格状态，让路由器优先推荐规格相关的Skill：

```javascript
const SkillRouter = require('./src/runtime/skill/skill-router');
const router = new SkillRouter(projectRoot);
router.discover();

const matches = router.match({
  userMessage: '验证接口规格一致性',
  agent: 'task-worker',
  completedSkills: ['architecture-design'],
  specificationState: {
    activeSpecs: ['interface'],
    verifiedSpecs: [],
    staleSpecs: ['interface'],
  },
});

for (const skill of matches) {
  console.log(`Skill: ${skill.skill_id}, 阶段: ${skill.phase}`);
}
```

---

## 最佳实践

### 保持规格资产"存活"

1. **及时更新relatedCodePaths**：当代码重构导致文件路径变更时，通过`updateSpecLiveness()`更新关联路径
2. **定期运行validateFreshness()**：建议在CI/CD流水线中集成，3天未验证的规格会自动标记为过期
3. **响应spec-stale事件**：监听DocFreshnessGuard的`spec-stale`事件，及时触发再验证
4. **避免orphaned状态**：当规格的`relatedCodePaths`中的文件全部被删除时，规格会变为`orphaned`状态，优先被淘汰

### 规格门禁设计原则

1. **最小门禁集**：只为关键阶段注册必要的规格要求，过多门禁会降低开发效率
2. **分层门禁**：需求分析阶段注册需求规格，架构设计阶段注册架构规格，避免跨层门禁
3. **及时标记验证**：规格验证通过后立即调用`markSpecVerified()`，避免门禁阻塞后续阶段
4. **监听spec-gate-blocked事件**：当门禁阻止阶段转换时，及时通知相关人员补充验证

### 规格证据编写建议

1. **明确引用规格ID**：在`specification_verified`证据的`metadata.specId`中引用具体规格ID
2. **描述一致性而非仅声明**：避免仅写"规格一致"，应描述具体哪些方面一致
3. **如实报告漂移**：如果检测到代码与规格的偏差，如实报告，漂移检测会降低一致性评分但不一定阻止验证
4. **使用可量化标准**：`successCriteria`中包含规格相关关键词（如"specification verified"）会被识别为强标准

### 压缩保护策略

1. **specification_asset策略不可修改**：始终为`'full'`，确保规格资产在上下文压缩时不被截断
2. **在Skill定义中声明specification输出**：在Front Matter的`causal_outputs`中包含`specification`，使Skill被自动识别为规格资产
3. **传入specificationAssets**：在调用`compress()`时传入`context.specificationAssets`数组，确保规格资产被正确保留

---

## 故障排查

### 问题：规格门禁始终阻止阶段转换

**症状**：`spec-gate-blocked`事件持续触发，无法推进到下一阶段

**排查步骤**：

1. 调用`getSpecGateState(phase)`查看未验证规格列表
2. 确认是否已调用`registerSpecRequirement()`注册了规格要求
3. 确认是否已调用`markSpecVerified()`标记验证通过
4. 检查`specId`是否一致（注册和验证时使用的ID必须完全匹配）

### 问题：规格文档未被识别为规格文档

**症状**：`_detectSpecType()`返回`'general'`，`_isSpecificationDoc()`返回`false`

**排查步骤**：

1. 检查文档路径是否包含规格关键词（`spec-`、`specification`、`requirement-`等）
2. 检查文档前2000字符是否包含规格标题（`## Specification`、`## 规格`等）
3. 在文档开头添加明确的规格标识标题

### 问题：规格资产在压缩时被截断

**症状**：压缩后规格内容不完整

**排查步骤**：

1. 确认Skill的`causal_outputs`中包含`{ name: 'specification' }`
2. 确认`setStrategy('specification_asset', 'full')`未被修改（该方法会拒绝非`'full'`值）
3. 确认调用`compress()`时传入了`specificationAssets`参数
4. 检查`retainedSpecAssets`数组确认规格资产是否被保留

### 问题：specification_verified证据缺失但验证仍然通过

**症状**：未提供规格验证证据，但`verify()`返回`verified: true`

**原因**：`specification_verified`是软必需类型，缺失不会导致验证失败

**解决方案**：

1. 在`successCriteria`中包含规格相关关键词，使标准强度升级为`strong`
2. 手动检查`missing`列表中是否包含`specification_verified`
3. 检查`specificationConformance`是否为`null`（为null表示未提供规格证据）

### 问题：规格资产被意外淘汰

**症状**：MemoryStore中的规格条目消失

**排查步骤**：

1. 检查知识条目总数是否超过`MAX_KNOWLEDGE_ENTRIES`（500）
2. 检查规格的`livenessStatus`是否为`'orphaned'`（orphaned规格优先被淘汰）
3. 确认`relatedCodePaths`中的文件是否仍然存在
4. 调用`updateSpecLiveness()`将状态更新为`'alive'`

### 问题：Skill路由未优先推荐规格相关Skill

**症状**：包含规格关键词的消息未匹配到规格相关Skill

**排查步骤**：

1. 确认`match()`调用时传入了`specificationState`参数
2. 确认`specificationState.activeSpecs`不为空
3. 检查Skill的`specification_type`是否与`activeSpecs`中的类型匹配
4. 检查Skill的`causal_outputs`是否包含`specification_verified`（此输出类型获得最高优先级加成）

---

## 相关文档

- [模块详解-SDD规格驱动开发](../modules/模块详解-SDD规格驱动开发.md)
- [模块详解-EvidenceVerifier模块](../modules/模块详解-EvidenceVerifier模块.md)
- [模块详解-PhaseOrchestrator阶段编排器](../modules/模块详解-PhaseOrchestrator阶段编排器.md)
- [模块详解-SkillRouter模块](../modules/模块详解-SkillRouter模块.md)
- [核心功能-TDD门禁执行流程](../core/核心功能-TDD门禁执行流程.md)
- [核心功能-上下文压缩引擎](../core/核心功能-上下文压缩引擎.md)
