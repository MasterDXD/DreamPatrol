# 模块详解 - ContextMapper 上下文映射器

> 源码：`src/domain/context-mapper.js` | 模块标识：`domain/context-mapper`

---

## 模块概述

ContextMapper 是 DDD（领域驱动设计）中的**限界上下文映射器**，负责管理限界上下文（Bounded Context）之间的映射关系。它支持共享内核、客户-供应商、防腐层等经典 DDD 集成模式，与 `config.json` 中的 `bounded_contexts` 配置对齐，实现上下文的注册、发现和关系管理。

### 核心职责

- **上下文注册**：注册限界上下文及其所属模块、核心概念
- **关系映射**：定义上下文之间的关系类型和元数据
- **配置导入**：从 `config.json` 的 `bounded_contexts` 批量导入上下文定义
- **统一语言**：管理每个上下文的统一语言（Ubiquitous Language）术语
- **统计查询**：提供上下文和关系的统计信息

---

## 核心概念

### BoundedContext（限界上下文）

限界上下文是 DDD 中划分领域边界的核心概念。每个限界上下文包含：

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | 自动生成的唯一标识（时间戳ID） |
| `name` | string | 上下文名称，作为注册和查询的键 |
| `modules` | string[] | 所属模块列表 |
| `description` | string | 上下文描述 |
| `coreConcepts` | string[] | 核心概念列表 |
| `registeredAt` | number | 注册时间戳 |

### ContextRelationship（上下文关系）

描述两个限界上下文之间的集成关系：

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | 自动生成的唯一标识 |
| `source` | string | 源上下文名称 |
| `target` | string | 目标上下文名称 |
| `type` | string | 关系类型（见 RelationshipType） |
| `metadata` | Object | 关系元数据（如 upstream 信息） |
| `createdAt` | number | 创建时间戳 |

### RelationshipType（关系类型）

ContextMapper 通过 `RELATIONSHIP_TYPES` 枚举定义了 8 种标准 DDD 上下文关系：

| 常量 | 值 | 说明 |
|------|-----|------|
| `SHARED_KERNEL` | `"shared-kernel"` | 共享内核：两个上下文共享一部分模型 |
| `CUSTOMER_SUPPLIER` | `"customer-supplier"` | 客户-供应商：下游上下文依赖上游提供的接口 |
| `CONFORMIST` | `"conformist"` | 遵从者：下游完全遵循上游模型，不做翻译 |
| `ANTI_CORRUPTION_LAYER` | `"anti-corruption-layer"` | 防腐层：下游通过翻译层隔离上游模型的影响 |
| `OPEN_HOST_SERVICE` | `"open-host-service"` | 开放主机服务：上游提供标准协议供多个下游使用 |
| `PUBLISHED_LANGUAGE` | `"published-language"` | 发布语言：与开放主机服务配合的标准数据格式 |
| `SEPARATE_WAYS` | `"separate-ways"` | 分道扬镳：两个上下文独立演进，不建立集成关系 |
| `PARTNERSHIP` | `"partnership"` | 合作关系：两个团队协同演进模型 |

访问方式：`ContextMapper.RELATIONSHIP_TYPES.SHARED_KERNEL`

---

## API 参考

### registerContext(name, definition)

注册限界上下文。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 上下文名称，作为唯一键 |
| `definition` | Object | 是 | 上下文定义 |
| `definition.modules` | string[] | 是 | 所属模块列表 |
| `definition.description` | string | 否 | 上下文描述 |
| `definition.coreConcepts` | string[] | 否 | 核心概念列表 |

**返回值**：`{ id: string, name: string }` — 注册结果，包含自动生成的 ID 和上下文名称。

**示例**：

```javascript
const mapper = new ContextMapper();
const result = mapper.registerContext('orders', {
  modules: ['order', 'payment'],
  description: '订单管理上下文',
  coreConcepts: ['Order', 'Payment', 'Invoice']
});
// result => { id: '1749xxxxx', name: 'orders' }
```

---

### defineRelationship(sourceName, targetName, relationshipType, metadata)

定义两个上下文之间的关系。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sourceName` | string | 是 | 源上下文名称（必须已注册） |
| `targetName` | string | 是 | 目标上下文名称（必须已注册） |
| `relationshipType` | string | 是 | 关系类型，使用 `RELATIONSHIP_TYPES` 常量 |
| `metadata` | Object | 否 | 关系元数据 |

**返回值**：`{ id: string, source: string, target: string, type: string }` — 关系定义对象。

**异常**：当源或目标上下文未注册时，抛出 `Error`。

**示例**：

```javascript
mapper.defineRelationship('orders', 'shipping',
  ContextMapper.RELATIONSHIP_TYPES.CUSTOMER_SUPPLIER,
  { upstream: 'orders' }
);
```

---

### importFromConfig(boundedContexts)

从 `config.json` 的 `bounded_contexts` 批量导入上下文定义。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `boundedContexts` | Object.<string, Object> | 是 | `bounded_contexts` 配置对象 |

**返回值**：`void`

**字段映射**：配置中的 `core_concepts`（下划线风格）自动映射为代码中的 `coreConcepts`（驼峰风格）。

**示例**：

```javascript
const config = require('../.harness/config.json');
mapper.importFromConfig(config.bounded_contexts);
// 批量注册所有配置中定义的限界上下文
```

---

### getContext(name)

获取指定上下文的完整定义。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 上下文名称 |

**返回值**：`Object | null` — 上下文定义对象，不存在时返回 `null`。

---

### getRelationships(contextName)

获取某上下文的所有关系。代码中对应方法为 `getContextRelationships()`。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `contextName` | string | 是 | 上下文名称 |

**返回值**：`Object[]` — 该上下文参与的所有关系列表（包括作为源和目标的关系）。

**示例**：

```javascript
const rels = mapper.getContextRelationships('orders');
// 返回 orders 作为 source 或 target 的所有关系
```

---

### findContextForModule(moduleName)

根据模块名查找其所属的限界上下文。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `moduleName` | string | 是 | 模块名称 |

**返回值**：`Object | null` — 包含该模块的上下文定义，未找到时返回 `null`。

> **注意**：此方法为规划中功能，当前可通过遍历 `getAllContexts()` 并检查 `modules` 数组实现。

---

### getAdjacentContexts(contextName)

获取与指定上下文直接相邻的所有上下文。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `contextName` | string | 是 | 上下文名称 |

**返回值**：`Object[]` — 相邻上下文列表。

> **注意**：此方法为规划中功能，当前可通过 `getContextRelationships()` 提取关系中的对端上下文实现。

---

### validateConsistency()

验证上下文映射的一致性，检查关系引用的上下文是否都已注册、是否存在孤立上下文等。

**返回值**：`{ valid: boolean, errors: string[] }` — 验证结果。

> **注意**：此方法为规划中功能，当前可通过 `getStats()` 获取基本统计信息辅助人工检查。

---

### 其他方法

#### getAllContexts()

获取所有已注册上下文的列表。

**返回值**：`Object[]`

#### getRelationship(sourceName, targetName)

获取两个上下文之间的特定关系。

**返回值**：`Object | null`

#### registerTerm(contextName, term, definition)

为指定上下文注册统一语言术语。

**参数**：`contextName`（上下文名称）、`term`（术语）、`definition`（术语定义）

#### getUbiquitousLanguage(contextName)

获取指定上下文的统一语言术语表。

**返回值**：`Object.<string, string>` — 术语到定义的映射

#### getStats()

获取统计信息。

**返回值**：`{ totalContexts: number, totalRelationships: number, totalTerms: number }`

---

## 与 config.json bounded_contexts 的关系

ContextMapper 与 `config.json` 中的 `bounded_contexts` 配置紧密对齐：

### 配置结构

```json
{
  "bounded_contexts": {
    "skill-management": {
      "description": "技能生命周期管理：路由、演化、蒸馏、图谱",
      "modules": [
        "skill/skill-router",
        "skill/skill-evolver",
        "skill/skill-distiller",
        "skill/skill-graph",
        "skill/meta-skill-orchestrator"
      ],
      "core_concepts": ["Skill", "SkillRoute", "SkillEvolution", "SkillDistillation"]
    }
  }
}
```

### 字段映射

| config.json 字段 | ContextMapper 字段 | 说明 |
|-----------------|-------------------|------|
| 键名（如 `"skill-management"`） | `name` | 上下文名称 |
| `description` | `description` | 上下文描述 |
| `modules` | `modules` | 所属模块列表 |
| `core_concepts` | `coreConcepts` | 核心概念（下划线→驼峰） |

### 导入流程

```
config.json → bounded_contexts → importFromConfig() → ContextMapper 内部注册表
```

1. 框架启动时读取 `config.json`
2. 调用 `mapper.importFromConfig(config.bounded_contexts)` 批量注册
3. 后续可通过 `registerContext()` 动态添加、通过 `defineRelationship()` 定义关系

---

## 使用示例

### 基础用法

```javascript
const ContextMapper = require('./src/domain/context-mapper');

const mapper = new ContextMapper();

// 注册上下文
mapper.registerContext('orders', {
  modules: ['order', 'payment'],
  description: '订单管理上下文',
  coreConcepts: ['Order', 'Payment', 'Invoice']
});

mapper.registerContext('shipping', {
  modules: ['logistics', 'tracking'],
  description: '物流配送上下文',
  coreConcepts: ['Shipment', 'Tracking', 'Delivery']
});

// 定义关系
mapper.defineRelationship('orders', 'shipping',
  ContextMapper.RELATIONSHIP_TYPES.CUSTOMER_SUPPLIER,
  { upstream: 'orders' }
);

// 查询
const ordersCtx = mapper.getContext('orders');
const rels = mapper.getContextRelationships('orders');
const stats = mapper.getStats();
```

### 从配置文件导入

```javascript
const config = require('./.harness/config.json');
const mapper = new ContextMapper();

// 批量导入所有限界上下文
mapper.importFromConfig(config.bounded_contexts);

// 定义上下文间关系
mapper.defineRelationship(
  'skill-management',
  'quality-assurance',
  ContextMapper.RELATIONSHIP_TYPES.CUSTOMER_SUPPLIER
);

// 查看统计
console.log(mapper.getStats());
// { totalContexts: 7, totalRelationships: 1, totalTerms: 0 }
```

### 统一语言管理

```javascript
// 注册术语
mapper.registerTerm('orders', 'Order', '客户提交的购买请求，包含商品列表和支付信息');
mapper.registerTerm('orders', 'Invoice', '订单的财务凭证');

// 获取统一语言
const lang = mapper.getUbiquitousLanguage('orders');
// { Order: '客户提交的购买请求，包含商品列表和支付信息', Invoice: '订单的财务凭证' }
```

---

> **交叉引用**：[[配置参考-Config.json#限界上下文配置 bounded_contexts]] · [[模块详解-架构边界守护模块群]]
