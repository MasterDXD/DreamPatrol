---
id: token-efficiency
name: Token效率规则
version: 1.0.0
enforcement: recommended
---

# Token效率规则

本规则定义prompt级别的Token节约策略，减少AI输出冗余，提升每Token信息密度。与 [[cost-control]]（预算管理）和 [[context-management]]（上下文压缩）互补，本规则聚焦**输出侧的精简控制**。

## 1. 输出精简规则

**触发条件**：所有自然语言输出

**要求**：
- 禁止填充语：不说"Sure"、"Great question"、"Let me explain"、"当然"、"没问题"等无意义开场
- 禁止复述用户输入：不重复用户已陈述的内容
- 禁止总结性收尾：不说"Hope this helps"、"如有疑问请随时询问"
- 直接给出答案，首句即为关键信息

**示例**：
```
❌ Before:
Sure! Let me explain how the SkillRouter works. The SkillRouter is a core
component that handles automatic skill discovery, matching, and routing.
It uses a three-layer cache system...

✅ After:
SkillRouter：自动发现/匹配/路由Skill，三层缓存（L1摘要/L2指令/L3资源）。
```

## 2. 代码输出规则

**触发条件**：输出代码变更时

**要求**：
- 优先输出diff格式（`-`删除/`+`新增），仅输出变更行及其上下文
- 仅当文件为新创建时才输出完整内容
- 变更超过50行时，按逻辑分块输出diff，每块标注用途
- 禁止输出未变更的代码段

**示例**：
```
❌ Before: 输出完整200行文件，其中仅3行变更

✅ After:
```diff
- const PORT = 3000;
+ const PORT = process.env.PORT || 3000;
```
[server.js:42] 添加环境变量回退
```

## 3. 引用精简规则

**触发条件**：引用代码库中的代码时

**要求**：
- 仅引用函数签名和关键行，用`// ...`省略实现细节
- 标注文件路径和行号，便于定位
- 引用多个函数时用表格汇总，而非逐一展开
- 仅在需要分析具体实现时才引用完整代码

**示例**：
```
❌ Before: 引用完整的30行函数实现

✅ After:
```js
function matchSkills(context, candidates) { // skill-router.js:L87
  // ... 语义匹配 + 否定模式检测 + 内容去重
  return rankedResults;
}
```
```

## 4. 上下文去冗余

**触发条件**：多轮对话中引用前文信息时

**要求**：
- 后续轮次引用前文结论而非复述推理过程
- 使用`↑见第N轮`或`如前文所述`标记引用来源
- 同一结论不重复输出，仅输出增量信息
- 合并多个工具调用的同类结果

**示例**：
```
❌ Before:
如前所述，SkillRouter负责自动发现、匹配和路由Skill。它使用三层缓存
系统，包括L1摘要层、L2指令层和L3资源层。现在我们需要扩展它...

✅ After:
扩展SkillRouter（↑见第2轮架构描述），新增语义匹配维度：
- 支持中文命令模糊匹配
- 缓存层增加TTL过期策略
```

## 5. 格式约束

**触发条件**：输出结构化信息时

**要求**：
- 3项以上并列信息用表格/列表，不用自然语言段落
- 配置项、参数说明用JSON/YAML格式输出
- 多方案对比用表格，列含：方案/优势/风险/适用场景
- 流程步骤用编号列表，不用叙述体

**示例**：
```
❌ Before:
The first option is to use SQLite which is simple and doesn't require a
server, but it doesn't scale well. The second option is PostgreSQL which
is powerful and scalable but requires setup...

✅ After:
| 方案 | 优势 | 风险 | 适用场景 |
|------|------|------|---------|
| SQLite | 零配置、单文件 | 并发写入弱 | 单机/嵌入式 |
| PostgreSQL | 高并发、丰富类型 | 运维成本 | 分布式/生产 |
```

## 6. 预算感知策略

**触发条件**：Token预算使用率≥60%时自动生效

**要求**：
- 省略示例代码，仅描述变更意图
- 减少解释性文字，优先输出结论
- 多步骤任务改为逐条输出，用户确认后继续
- 合并连续工具调用，减少中间输出

**示例**：
```
❌ Before (预算充足):
下面我将详细解释每个修改的原因，并给出完整的代码示例...

✅ After (预算紧张):
修改3处：①config端口改环境变量 ②添加健康检查路由 ③更新测试用例。
确认后输出diff。
```

## 7. 文件读取优化

**触发条件**：需要读取文件内容时

**要求**：
- 避免重复读取同一文件，同一会话内缓存已读内容
- 优先使用offset/limit参数读取目标区域，不读全文
- 已读文件后续引用时标注行号，不重新读取
- 长文件先读前50行了解结构，再按需读取目标段

**示例**：
```
❌ Before: 每次需要引用时重新Read整个500行文件

✅ After: 首次Read(server.js, offset=1, limit=50)了解结构，
后续Read(server.js, offset=120, limit=30)定位目标函数
```

## 8. 命令输出精简

**触发条件**：执行终端命令后展示结果时

**要求**：
- 自动过滤噪音行（空行、进度条、deprecation warning）
- 仅保留关键结果行（错误、警告、摘要数据）
- 超过20行的输出截断，标注`... (N行已省略)`
- 测试输出仅展示失败用例和摘要，不展示全部通过用例

**示例**：
```
❌ Before: 展示npm test完整输出（200行，含195个passing用例详情）

✅ After:
Tests: 195 passed, 2 failed
FAIL test/api/auth.test.js
  ✖ should reject expired token (assertion at L42)
  ✖ should handle missing credentials (timeout at L78)
... (180行已省略)
```

## 效率检查清单

- [ ] 输出是否包含填充语或复述？→ 删除
- [ ] 代码变更是否输出完整文件？→ 改为diff
- [ ] 引用是否包含完整实现？→ 改为签名+行号
- [ ] 是否重复了前文已述信息？→ 改为引用标记
- [ ] 并列信息是否用自然语言描述？→ 改为表格/列表
- [ ] Token预算紧张时是否仍输出示例？→ 省略
- [ ] 是否重复读取已知文件？→ 使用缓存
- [ ] 命令输出是否包含噪音行？→ 过滤
