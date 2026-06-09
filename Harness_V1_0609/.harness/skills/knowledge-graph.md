---
skill_id: knowledge-graph
name: 知识图谱
phase: module-development
priority: high
description: |
  三元组知识图谱存储，融合Vibe Coding MemoryPlus核心能力。
  提供Entity-Relation-Entity结构化知识表示、多跳推理、传递推理和最短路径查询。
trigger: auto
trigger_conditions:
  - 需要构建结构化知识库
  - 实体关系建模与查询
  - 多跳推理需求
  - 知识图谱可视化
applicable_agents: []
auto_trigger: true
depends_on: []
blocks: []
verified: true
stability: stable
---

## 目标

提供三元组知识图谱存储，支持Entity-Relation-Entity结构化知识表示、8种关系类型、多跳推理、传递推理和最短路径查询，实现结构化知识的管理和推理。

## 步骤

1. 添加三元组定义实体和关系
2. 执行多跳查询（BFS遍历，支持谓词过滤和置信度过滤）
3. 触发传递推理（对is_a/depends_on/part_of自动推断）
4. 查询实体间最短路径
5. 导出三元组进行序列化

# 知识图谱（Knowledge Graph Store）

融合自Vibe Coding MemoryPlus技能。

## 核心能力

1. **三元组建模**：Entity-Relation-Entity结构化知识表示
2. **8种关系类型**：is_a/part_of/depends_on/produces/uses/relates_to/contradicts/supports
3. **多跳推理**：BFS遍历支持谓词过滤、方向控制、置信度过滤
4. **传递推理**：对is_a/depends_on/part_of自动推断传递关系
5. **最短路径**：双向BFS查找实体间最短路径
6. **导入导出**：三元组序列化与反序列化

## 使用方式

### 编程接口
```javascript
const KnowledgeGraphStore = require('./src/runtime/thought/knowledge-graph-store');
const kg = new KnowledgeGraphStore({ maxEntities: 5000 });

// 添加三元组
kg.addTriple('React', 'is_a', 'UI框架', { subjectType: 'technology', objectType: 'concept' });
kg.addTriple('Next.js', 'depends_on', 'React');

// 多跳查询
const result = kg.query('Next.js', { maxDepth: 3 });

// 传递推理
const inferred = kg.inferRelations('Next.js');

// 导出
const triples = kg.exportAsTriples();
```

### 斜杠命令
`/knowledge-graph` — 启动知识图谱操作

## 关系类型

| 类型 | 说明 | 可传递 |
|------|------|--------|
| is_a | 分类关系 | ✅ |
| part_of | 组成关系 | ✅ |
| depends_on | 依赖关系 | ✅ |
| produces | 产出关系 | ❌ |
| uses | 使用关系 | ❌ |
| relates_to | 关联关系 | ❌ |
| contradicts | 矛盾关系 | ❌ |
| supports | 支持关系 | ❌ |

## 事件

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| entity-added | 实体添加 | { entityId, name, type } |
| relation-added | 关系添加 | { relationId, subjectId, predicate, objectId } |

## 验收标准
- [ ] 三元组添加和查询功能正常
- [ ] 多跳推理结果正确
- [ ] 传递推理对is_a/depends_on/part_of生效
- [ ] 导出功能序列化完整

## 常见问题
- **Q: 传递推理不生效？**
  A: 仅is_a、depends_on、part_of三种关系类型支持传递推理
- **Q: 多跳查询结果太多？**
  A: 使用maxDepth限制深度，使用谓词过滤和置信度过滤缩小范围
