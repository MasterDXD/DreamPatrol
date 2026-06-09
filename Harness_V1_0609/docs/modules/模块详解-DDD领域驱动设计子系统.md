# 模块详解-DDD领域驱动设计子系统

> 版本：2.73.4 | 子系统：领域驱动设计（Domain-Driven Design） | 源码路径：`src/domain/`

---

## 目录

- [1. 子系统概述](#1-子系统概述)
- [2. 核心概念](#2-核心概念)
- [3. 模块API参考](#3-模块api参考)
  - [3.1 Entity 实体基类](#31-entity-实体基类)
  - [3.2 ValueObject 值对象基类](#32-valueobject-值对象基类)
  - [3.3 AggregateRoot 聚合根基类](#33-aggregateroot-聚合根基类)
  - [3.4 DomainEvent 领域事件与 DomainEventBus 事件总线](#34-domainevent-领域事件与-domaineventbus-事件总线)
  - [3.5 Repository 仓储接口与 InMemoryRepository](#35-repository-仓储接口与-inmemoryrepository)
  - [3.6 DomainService 领域服务](#36-domainservice-领域服务)
  - [3.7 Specification 规约模式](#37-specification-规约模式)
  - [3.8 ContextMapper 上下文映射器](#38-contextmapper-上下文映射器)
- [4. 与 config.json bounded_contexts 的关系](#4-与-configjson-bounded_contexts-的关系)
- [5. 使用示例](#5-使用示例)

---

## 1. 子系统概述

DDD（领域驱动设计）子系统是 Harness Engineering 多Agent框架的领域建模基础设施层。它为框架提供了标准的 DDD 战术模式实现，使业务领域能够以结构化、可组合的方式进行建模。

在 Harness 框架中，DDD 子系统的定位是：

- **领域建模基础设施**：为业务逻辑提供 Entity、ValueObject、AggregateRoot 等核心抽象
- **领域事件驱动**：通过 DomainEvent 和 DomainEventBus 实现聚合间的解耦通信
- **限界上下文管理**：通过 ContextMapper 管理不同业务上下文之间的映射关系
- **与配置集成**：与 `config.json` 中的 `bounded_contexts` 配置对齐，实现上下文的声明式定义

该子系统位于 `src/domain/` 目录下，包含 8 个核心模块：

| 模块 | 文件 | 说明 |
|------|------|------|
| Entity | `entity.js` | 实体基类，基于标识的相等性 |
| ValueObject | `value-object.js` | 值对象基类，基于属性值的相等性 |
| AggregateRoot | `aggregate-root.js` | 聚合根基类，维护一致性边界 |
| DomainEvent | `domain-event.js` | 领域事件与事件总线 |
| Repository | `repository.js` | 仓储接口与内存实现 |
| DomainService | `domain-service.js` | 领域服务标记类 |
| Specification | `specification.js` | 规约模式，可组合的业务规则 |
| ContextMapper | `context-mapper.js` | 限界上下文映射器 |

---

## 2. 核心概念

### Entity（实体）

实体由**唯一标识**定义，而非属性值。即使两个实体的所有属性完全相同，只要标识不同就是不同的实体。实体是可变的——其属性可以随时间变化，但标识保持不变。

关键特征：
- 拥有唯一标识（`id`）
- 基于标识判断相等性（`equals()`）
- 可管理领域事件队列（`addDomainEvent()` / `pullDomainEvents()`）

### ValueObject（值对象）

值对象由**属性值**定义，无唯一标识。相同属性值的值对象即相等，且应设计为不可变。值对象用于描述实体的特征，如金额、地址、颜色等。

关键特征：
- 无唯一标识
- 基于属性值判断相等性（`getEqualityComponents()` + `equals()`）
- 不可变性（创建后属性不应改变）
- 可计算哈希码（`hashCode()`）

### AggregateRoot（聚合根）

聚合根是聚合的入口点和一致性边界。外部只能通过聚合根引用聚合内的实体。聚合根继承自 Entity，增加了版本控制（乐观锁）和聚合边界管理能力。

关键特征：
- 继承 Entity 的所有能力
- 版本号管理（`version`），支持乐观并发控制
- 时间戳追踪（`createdAt` / `updatedAt`）
- 维护聚合内部一致性

### DomainEvent（领域事件）

领域事件表示领域中发生的具有重要业务含义的事件，用于解耦不同聚合之间的通信。事件是不可变的——一旦发生就不可修改。

关键特征：
- 唯一事件ID（`eventId`）
- 事件名称（`eventName`）
- 关联聚合标识（`aggregateId`）
- 事件载荷（`payload`）
- 发生时间戳（`occurredAt`）

### DomainEventBus（领域事件总线）

事件总线提供发布-订阅能力，支持同步和异步处理模式。它是聚合间通信的核心基础设施。

关键特征：
- 发布-订阅模式
- 支持同步立即处理和异步延迟处理
- 通配符订阅（`'*'`）
- 事件历史记录
- 优雅关闭支持

### Repository（仓储）

仓储模式为聚合根提供持久化抽象，隔离领域层与基础设施层。框架提供契约式接口和内存实现。

关键特征：
- CRUD 契约接口（`findById` / `save` / `delete` / `findAll` / `findBy` / `count`）
- 内存实现（`InMemoryRepository`），适用于测试和快速原型
- 子类继承实现具体持久化逻辑

### DomainService（领域服务）

领域服务封装不属于任何单一实体或值对象的领域逻辑。与 ApplicationService 的区别：领域服务包含业务规则，应用服务编排流程。

关键特征：
- 标记基类，无强制约束
- 应设计为无状态
- 封装跨聚合的业务逻辑

### Specification（规约模式）

规约模式将业务规则封装为可组合的对象，支持 AND / OR / NOT 逻辑运算。用于验证、查询过滤和业务规则表达。

关键特征：
- 抽象方法 `isSatisfiedBy(candidate)`
- 可组合：`and()` / `or()` / `not()`
- 三种组合实现：`AndSpecification` / `OrSpecification` / `NotSpecification`

### ContextMapper（上下文映射器）

上下文映射器管理限界上下文之间的映射关系，支持共享内核、客户-供应商、防腐层等集成模式。与 `config.json` 中的 `bounded_contexts` 配置对齐。

关键特征：
- 上下文注册与查询
- 上下文关系定义（8种标准关系类型）
- 统一语言管理
- 从 `config.json` 批量导入

---

## 3. 模块API参考

### 3.1 Entity 实体基类

**文件**：`src/domain/entity.js`

#### 构造函数

```javascript
new Entity(id?)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 实体唯一标识，不提供时自动生成 |

#### 实例属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | 实体唯一标识（只读） |

#### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `equals` | `equals(other)` | boolean | 基于标识判断实体相等性 |
| `addDomainEvent` | `addDomainEvent(event)` | void | 添加领域事件到待发布队列 |
| `pullDomainEvents` | `pullDomainEvents()` | DomainEvent[] | 获取并清空待发布领域事件队列 |
| `clearDomainEvents` | `clearDomainEvents()` | void | 清空领域事件队列 |
| `toJSON` | `toJSON()` | { id: string } | 序列化为普通对象 |

---

### 3.2 ValueObject 值对象基类

**文件**：`src/domain/value-object.js`

#### 构造函数

```javascript
new ValueObject()
```

#### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `getEqualityComponents` | `getEqualityComponents()` | Array\<*\> | 获取用于相等性比较的属性组件数组（**抽象方法，子类必须实现**） |
| `equals` | `equals(other)` | boolean | 基于属性值判断相等性。要求同类且所有组件相等 |
| `hashCode` | `hashCode()` | string | 基于属性值计算哈希码，组件用 `\|` 连接 |
| `toJSON` | `toJSON()` | Object | 序列化所有非下划线开头的属性 |

---

### 3.3 AggregateRoot 聚合根基类

**文件**：`src/domain/aggregate-root.js`  
**继承**：`Entity`

#### 构造函数

```javascript
new AggregateRoot(id?)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 聚合根唯一标识，不提供时自动生成 |

#### 实例属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | 聚合根唯一标识（继承自 Entity，只读） |
| `version` | number | 聚合版本号（乐观锁用，只读） |
| `createdAt` | number | 创建时间戳（只读） |
| `updatedAt` | number | 最后更新时间戳（只读） |

#### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `_incrementVersion` | `_incrementVersion()` | number | 递增版本号并更新 `updatedAt`，每次状态变更时调用 |
| `toJSON` | `toJSON()` | Object | 序列化聚合根完整状态（含 id, version, createdAt, updatedAt） |

继承自 Entity 的方法：`equals`、`addDomainEvent`、`pullDomainEvents`、`clearDomainEvents`。

---

### 3.4 DomainEvent 领域事件与 DomainEventBus 事件总线

**文件**：`src/domain/domain-event.js`

#### DomainEvent

##### 构造函数

```javascript
new DomainEvent(eventName, aggregateId, payload?)
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventName` | string | 是 | 事件名称 |
| `aggregateId` | string | 是 | 关联的聚合根标识 |
| `payload` | Object | 否 | 事件载荷数据，默认 `{}` |

##### 实例属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `eventId` | string | 事件唯一标识（自动生成） |
| `eventName` | string | 事件名称 |
| `aggregateId` | string | 关联的聚合根标识 |
| `payload` | Object | 事件载荷数据 |
| `occurredAt` | number | 事件发生时间戳 |
| `version` | number | 事件版本号 |

##### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `toJSON` | `toJSON()` | Object | 序列化事件（含 eventId, eventName, aggregateId, payload, occurredAt） |

#### DomainEventBus

继承自 `EventEmitter`，并混入 `withShutdown` 优雅关闭能力。

##### 构造函数

```javascript
new DomainEventBus()
```

##### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `subscribe` | `subscribe(eventName, handler, options?)` | function | 订阅领域事件，返回取消订阅函数。`eventName` 支持 `'*'` 通配所有事件。`options.async` 设为 `true` 时异步处理 |
| `publish` | `publish(event)` | Promise\<void\> | 发布领域事件。先执行同步处理器，再执行异步处理器 |
| `publishAll` | `publishAll(events)` | Promise\<void\> | 批量发布领域事件 |
| `getHistory` | `getHistory(limit?)` | Object[] | 获取事件历史记录，可限制返回条数 |
| `getStats` | `getStats()` | Object | 获取订阅统计信息（totalSubscriptions, eventTypes, historySize） |

##### 容量限制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `_maxHistory` | 500 | 最大事件历史记录数 |
| `_maxEventTypes` | 200 | 最大事件类型数 |
| `_maxHandlersPerEvent` | 50 | 单事件类型最大处理器数 |

---

### 3.5 Repository 仓储接口与 InMemoryRepository

**文件**：`src/domain/repository.js`

#### Repository（抽象基类）

##### 抽象方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `findById` | `findById(id)` | Promise\<AggregateRoot\|null\> | 依ID查找聚合根 |
| `save` | `save(aggregate)` | Promise\<void\> | 保存聚合根（新增或更新） |
| `delete` | `delete(id)` | Promise\<void\> | 删除聚合根 |
| `findAll` | `findAll()` | Promise\<AggregateRoot[]\> | 查找所有聚合根 |
| `findBy` | `findBy(criteria)` | Promise\<AggregateRoot[]\> | 按条件查找聚合根 |
| `count` | `count(criteria?)` | Promise\<number\> | 统计聚合根数量 |

#### InMemoryRepository

继承自 `Repository`，使用 Map 存储聚合根快照。

##### 额外方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `clear` | `clear()` | void | 清空存储 |

##### 可重写方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `_getIdentity` | `_getIdentity(aggregate)` | string | 获取聚合根的存储标识，默认返回 `aggregate.id` |

---

### 3.6 DomainService 领域服务

**文件**：`src/domain/domain-service.js`

#### 构造函数

```javascript
new DomainService()
```

#### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `getServiceName` | `getServiceName()` | string | 获取服务名称，默认返回构造函数名 |
| `canExecute` | `canExecute()` | boolean | 验证服务是否可以执行，默认返回 `true` |

---

### 3.7 Specification 规约模式

**文件**：`src/domain/specification.js`

#### Specification（抽象基类）

##### 抽象方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `isSatisfiedBy` | `isSatisfiedBy(candidate)` | boolean | 检查候选对象是否满足规约 |

##### 组合方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `and` | `and(other)` | AndSpecification | AND组合：两个规约都满足时为 true |
| `or` | `or(other)` | OrSpecification | OR组合：任一规约满足时为 true |
| `not` | `not()` | NotSpecification | NOT取反：规约不满足时为 true |

#### AndSpecification

继承自 `Specification`。组合两个规约，两者都满足时 `isSatisfiedBy` 返回 `true`。

#### OrSpecification

继承自 `Specification`。组合两个规约，任一满足时 `isSatisfiedBy` 返回 `true`。

#### NotSpecification

继承自 `Specification`。对原规约结果取反，`isSatisfiedBy` 返回 `!spec.isSatisfiedBy(candidate)`。

---

### 3.8 ContextMapper 上下文映射器

**文件**：`src/domain/context-mapper.js`

#### 构造函数

```javascript
new ContextMapper()
```

#### 静态属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `RELATIONSHIP_TYPES` | Object | 上下文关系类型常量枚举 |

**关系类型常量**：

| 常量 | 值 | 说明 |
|------|-----|------|
| `SHARED_KERNEL` | `"shared-kernel"` | 共享内核 |
| `CUSTOMER_SUPPLIER` | `"customer-supplier"` | 客户-供应商 |
| `CONFORMIST` | `"conformist"` | 遵奉者 |
| `ANTI_CORRUPTION_LAYER` | `"anti-corruption-layer"` | 防腐层 |
| `OPEN_HOST_SERVICE` | `"open-host-service"` | 开放主机服务 |
| `PUBLISHED_LANGUAGE` | `"published-language"` | 发布语言 |
| `SEPARATE_WAYS` | `"separate-ways"` | 分道扬镳 |
| `PARTNERSHIP` | `"partnership"` | 合作伙伴 |

#### 实例方法

| 方法 | 签名 | 返回类型 | 说明 |
|------|------|----------|------|
| `registerContext` | `registerContext(name, definition)` | { id, name } | 注册限界上下文。`definition.modules`：所属模块列表；`definition.description`：描述；`definition.coreConcepts`：核心概念列表 |
| `getContext` | `getContext(name)` | Object\|null | 获取指定上下文 |
| `getAllContexts` | `getAllContexts()` | Object[] | 获取所有已注册上下文 |
| `defineRelationship` | `defineRelationship(sourceName, targetName, relationshipType, metadata?)` | Object | 定义两个上下文之间的关系 |
| `getRelationship` | `getRelationship(sourceName, targetName)` | Object\|null | 获取两个上下文间的关系 |
| `getContextRelationships` | `getContextRelationships(contextName)` | Object[] | 获取某上下文的所有关系 |
| `registerTerm` | `registerTerm(contextName, term, definition)` | void | 注册统一语言术语 |
| `getUbiquitousLanguage` | `getUbiquitousLanguage(contextName)` | Object | 获取指定上下文的统一语言 |
| `importFromConfig` | `importFromConfig(boundedContexts)` | void | 从 config.json 的 bounded_contexts 批量导入上下文 |
| `getStats` | `getStats()` | Object | 获取统计信息（totalContexts, totalRelationships, totalTerms） |

---

## 4. 与 config.json bounded_contexts 的关系

`config.json` 中的 `bounded_contexts` 配置与 DDD 子系统的 `ContextMapper` 直接对齐，实现上下文的声明式定义和运行时管理的衔接。

### 配置结构

```json
{
  "bounded_contexts": {
    "<context-name>": {
      "description": "上下文描述",
      "modules": ["module/path1", "module/path2"],
      "core_concepts": ["Concept1", "Concept2"]
    }
  }
}
```

### 字段映射

| config.json 字段 | ContextMapper 字段 | 说明 |
|------------------|-------------------|------|
| 顶层键名 | `registerContext(name, ...)` 的 `name` | 上下文名称 |
| `description` | `definition.description` | 上下文描述 |
| `modules` | `definition.modules` | 所属模块列表 |
| `core_concepts` | `definition.coreConcepts` | 核心概念列表（注意：config 使用 snake_case，ContextMapper 使用 camelCase） |

### 当前已定义的限界上下文

| 上下文名称 | 说明 | 核心模块 |
|-----------|------|---------|
| platform-integration | 多平台接入与业务Agent调度 | platform-gateway, business-agent-registry, priority-scheduler |
| skill-management | 技能生命周期管理 | skill-router, skill-evolver, skill-distiller, skill-graph, meta-skill-orchestrator |
| quality-assurance | 质量保障 | quality-scorer, tdd-gate, evidence-verifier, evaluation-calibrator |
| workflow-orchestration | 工作流编排 | phase-orchestrator, pipeline-executor, state-graph, goal-executor |
| thought-reasoning | 思维推理 | brain-memory, dream-engine, knowledge-graph-store, deepening-orchestrator |
| collaboration | 协作 | ensemble-orchestrator, session-manager, causal-data-bus |
| specification | 规范驱动 | sdd-contract-manager, sdd-document-validator, sdd-sync-verifier, iron-rule-engine, sdd-phase-bridge |
| domain-driven-design | 领域驱动设计 | entity, value-object, aggregate-root, domain-event, repository, domain-service, specification, context-mapper |
| optimization-autoresearch | 自主研究闭环 | autonomous-research-loop, experiment-sandbox, research-domain-adapter, autonomous-optimization-orchestrator |

### 导入方式

运行时通过 `ContextMapper.importFromConfig()` 方法批量导入：

```javascript
const ContextMapper = require('./domain/context-mapper');
const config = require('../.harness/config.json');

const mapper = new ContextMapper();
mapper.importFromConfig(config.bounded_contexts);
```

导入后，可通过 `mapper.getAllContexts()` 查询所有上下文，通过 `mapper.defineRelationship()` 定义上下文间的关系。

---

## 5. 使用示例

### 5.1 定义实体与值对象

```javascript
const Entity = require('./domain/entity');
const ValueObject = require('./domain/value-object');

// 值对象：金额
class Money extends ValueObject {
  constructor(amount, currency) {
    super();
    this.amount = amount;
    this.currency = currency;
  }
  getEqualityComponents() { return [this.amount, this.currency]; }
}

// 实体：账户
class Account extends Entity {
  constructor(id, owner, balance) {
    super(id);
    this.owner = owner;
    this.balance = balance || new Money(0, 'USD');
  }
  canWithdraw(amount) {
    return this.balance.amount >= amount;
  }
  withdraw(amount) {
    if (!this.canWithdraw(amount)) {
      throw new Error('Insufficient funds');
    }
    this.balance = new Money(this.balance.amount - amount, this.balance.currency);
  }
  deposit(amount) {
    this.balance = new Money(this.balance.amount + amount, this.balance.currency);
  }
}
```

### 5.2 定义聚合根与领域事件

```javascript
const AggregateRoot = require('./domain/aggregate-root');
const { DomainEvent } = require('./domain/domain-event');

// 领域事件
class OrderCreatedEvent extends DomainEvent {
  constructor(orderId, customerId) {
    super('OrderCreated', orderId, { customerId });
  }
}

class OrderItemAddedEvent extends DomainEvent {
  constructor(orderId, productId, quantity) {
    super('OrderItemAdded', orderId, { productId, quantity });
  }
}

// 聚合根：订单
class Order extends AggregateRoot {
  constructor(id, customerId) {
    super(id);
    this.customerId = customerId;
    this._items = [];
    this._status = 'draft';
    this.addDomainEvent(new OrderCreatedEvent(id, customerId));
  }
  addItem(productId, quantity, price) {
    this._items.push({ productId, quantity, price });
    this._incrementVersion();
    this.addDomainEvent(new OrderItemAddedEvent(this.id, productId, quantity));
  }
  get items() { return this._items.slice(); }
  get status() { return this._status; }
}
```

### 5.3 使用事件总线

```javascript
const { DomainEventBus } = require('./domain/domain-event');

const bus = new DomainEventBus();

// 同步订阅
const unsub = bus.subscribe('OrderCreated', (event) => {
  console.log(`订单已创建: ${event.aggregateId}, 客户: ${event.payload.customerId}`);
});

// 通配符订阅
bus.subscribe('*', (event) => {
  console.log(`[审计] 事件: ${event.eventName}, 聚合: ${event.aggregateId}`);
});

// 异步订阅
bus.subscribe('OrderItemAdded', async (event) => {
  await updateInventory(event.payload.productId, event.payload.quantity);
}, { async: true });

// 发布事件
const order = new Order('order-1', 'customer-1');
order.addItem('product-1', 2, 99.9);
for (const event of order.pullDomainEvents()) {
  await bus.publish(event);
}

// 取消订阅
unsub();
```

### 5.4 使用仓储

```javascript
const { InMemoryRepository } = require('./domain/repository');

class OrderRepository extends InMemoryRepository {
  async findByCustomerId(customerId) {
    return this.findBy({ customerId });
  }
}

const orderRepo = new OrderRepository();
await orderRepo.save(order);
const found = await orderRepo.findById('order-1');
const customerOrders = await orderRepo.findByCustomerId('customer-1');
```

### 5.5 使用规约模式

```javascript
const { Specification } = require('./domain/specification');

class ActiveOrderSpec extends Specification {
  isSatisfiedBy(order) { return order.status !== 'cancelled'; }
}

class HighValueOrderSpec extends Specification {
  isSatisfiedBy(order) {
    const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return total > 1000;
  }
}

// 组合规约
const activeHighValueSpec = new ActiveOrderSpec().and(new HighValueOrderSpec());

// 用于过滤
const allOrders = await orderRepo.findAll();
const targetOrders = allOrders.filter(order => activeHighValueSpec.isSatisfiedBy(order));

// 用于验证
if (!activeHighValueSpec.isSatisfiedBy(someOrder)) {
  console.log('订单不满足条件');
}
```

### 5.6 使用领域服务

```javascript
const DomainService = require('./domain/domain-service');

class TransferService extends DomainService {
  constructor(fromRepo, toRepo, eventBus) {
    super();
    this.fromRepo = fromRepo;
    this.toRepo = toRepo;
    this.eventBus = eventBus;
  }
  canExecute() {
    return this.fromRepo != null && this.toRepo != null;
  }
  async transfer(fromId, toId, amount) {
    const from = await this.fromRepo.findById(fromId);
    const to = await this.toRepo.findById(toId);
    if (!from || !to) throw new Error('Account not found');
    if (!from.canWithdraw(amount)) throw new Error('Insufficient funds');
    from.withdraw(amount);
    to.deposit(amount);
    await this.fromRepo.save(from);
    await this.toRepo.save(to);
    // 发布领域事件
    for (const event of from.pullDomainEvents()) {
      await this.eventBus.publish(event);
    }
  }
}
```

### 5.7 使用上下文映射器

```javascript
const ContextMapper = require('./domain/context-mapper');

const mapper = new ContextMapper();

// 从配置导入
const config = require('../.harness/config.json');
mapper.importFromConfig(config.bounded_contexts);

// 定义上下文关系
mapper.defineRelationship(
  'skill-management',
  'quality-assurance',
  ContextMapper.RELATIONSHIP_TYPES.CUSTOMER_SUPPLIER,
  { upstream: 'quality-assurance', note: '质量评分驱动技能演化' }
);

mapper.defineRelationship(
  'workflow-orchestration',
  'domain-driven-design',
  ContextMapper.RELATIONSHIP_TYPES.CONFORMIST,
  { note: '工作流遵循DDD聚合边界' }
);

// 注册统一语言
mapper.registerTerm('skill-management', 'Skill', '框架中可自动路由和执行的原子能力单元');
mapper.registerTerm('skill-management', 'Distillation', '从高频轨迹中提炼精简技能的过程');

// 查询
const allContexts = mapper.getAllContexts();
const rels = mapper.getContextRelationships('skill-management');
const lang = mapper.getUbiquitousLanguage('skill-management');
const stats = mapper.getStats();
```

> **交叉引用**：[[配置参考-Config.json]] · [[模块详解-Skill子系统]] · [[核心功能-多Agent协作流程]] · [[架构分析与设计梳理报告]]
