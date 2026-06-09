# 模块详解-UserModelManager用户模型管理器

> 版本：2.73.4 | 文件：src/runtime/user/user-model-manager.js

---

## 模块概述

UserModelManager是Harness多Agent框架的用户模型管理器，负责学习和管理用户偏好，构建用户画像并注入到Agent上下文中。它通过SqliteStore持久化偏好数据，支持从交互中自动学习（纠正、语言选择、沟通风格、技术栈、编码风格、项目上下文、时区），并生成结构化的用户画像注入提示词，使Agent能够适配用户的协作模式。

该模块是用户子系统的核心组件，与AffinityLearner、StructuredIntent协作，实现用户-AI协作的个性化适配。

## 类定义

```javascript
class UserModelManager extends EventEmitter {
  constructor(options)
  attachSqliteStore(store)
  setPreference(key, value)
  getPreference(key)
  getAllPreferences()
  removePreference(key)
  learnFromInteraction(interaction)
  buildInjectionPrompt()
  getSchema()
  getStats()
  isHealthy()
  shutdown() // via withShutdown mixin
}
```

通过`withShutdown`混入后导出，自动获得`shutdown()`方法和`_onShutdown()`生命周期钩子。

## 构造函数

### `new UserModelManager(options)`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `options.sqliteStore` | Object | 否 | null | SqliteStore实例，用于偏好持久化 |

## 核心方法

### `attachSqliteStore(store)`

附加SqliteStore实例，启用偏好持久化。未附加Store时，所有偏好操作静默返回。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `store` | Object | 是 | SqliteStore实例 |

**返回值**：`this`（支持链式调用）

### `setPreference(key, value)`

设置用户偏好。值会被JSON序列化后存入SqliteStore。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 偏好键名 |
| `value` | any | 是 | 偏好值（会被JSON序列化） |

**返回值**：`boolean` — 设置成功返回true，无Store时返回false

**事件触发**：`preference-set` — {key, value}

### `getPreference(key)`

获取指定偏好值，自动JSON反序列化。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 偏好键名 |

**返回值**：`any | null` — 偏好值，不存在或无Store时返回null

### `getAllPreferences()`

获取所有用户偏好。

**返回值**：`Object` — 键值对映射，如`{commStyle: 'concise', techStack: ['node', 'sqlite']}`

### `removePreference(key)`

删除指定偏好。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 偏好键名 |

**返回值**：`boolean`

**事件触发**：`preference-removed` — {key}

### `learnFromInteraction(interaction)`

从交互中自动学习用户偏好。根据交互数据中的字段自动更新对应偏好，支持增量合并（petPeeves和techStack采用去重追加策略）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `interaction` | Object | 是 | 交互数据 |

**interaction参数结构**：

| 字段 | 类型 | 说明 | 学习行为 |
|------|------|------|---------|
| `correction` | string | 用户纠正内容 | 追加到petPeeves（去重） |
| `languageChoice` | string | 语言偏好 | 覆盖preferredLanguage |
| `commStyle` | string | 沟通风格 | 覆盖commStyle |
| `techStack` | Array | 技术栈 | 追加到techStack（去重） |
| `codingStyle` | Object | 编码风格 | 覆盖codingPrefs |
| `projectContext` | string | 项目上下文 | 覆盖projectContext |
| `timezone` | string | 时区 | 覆盖timezone |

**返回值**：`boolean`

**事件触发**：`interaction-learned` — {type}

### `buildInjectionPrompt()`

根据所有已存储偏好生成用户画像注入提示词，用于注入到Agent上下文中。按USER_SCHEMA定义的顺序排列已知偏好，其余偏好追加在末尾。

**返回值**：`string` — 格式化的用户画像提示词，无偏好时返回空字符串

**事件触发**：`profile-injected` — {keyCount}

### `getSchema()`

获取用户画像Schema定义。

**返回值**：`Object` — USER_SCHEMA的深拷贝

### `getStats()`

获取管理器统计信息。

**返回值**：`Object`

| 字段 | 类型 | 说明 |
|------|------|------|
| `preferencesSet` | number | 偏好设置次数 |
| `preferencesGet` | number | 偏好读取次数 |
| `profilesInjected` | number | 画像注入次数 |
| `interactionsLearned` | number | 交互学习次数 |
| `hasStore` | boolean | 是否已附加SqliteStore |

## 用户画像Schema

| 键名 | 类型 | 说明 |
|------|------|------|
| `name` | string | 用户名称 |
| `role` | string | 角色/职位 |
| `timezone` | string | 时区 |
| `codingPrefs` | Object | 编码偏好 |
| `commStyle` | string | 沟通风格偏好 |
| `petPeeves` | Array | 不喜欢的事物 |
| `projectContext` | string | 项目上下文 |
| `techStack` | Array | 技术栈偏好 |

## 事件

| 事件名 | 触发时机 | 事件数据 |
|--------|---------|---------|
| `preference-set` | 偏好设置 | {key, value} |
| `preference-removed` | 偏好删除 | {key} |
| `interaction-learned` | 交互学习完成 | {type} |
| `profile-injected` | 画像注入 | {keyCount} |

## 使用示例

```javascript
const UserModelManager = require('./src/runtime/user/user-model-manager');
const SqliteStore = require('./src/runtime/infrastructure/sqlite-store');

const store = new SqliteStore({ dbPath: './data/user-preferences.db' });
const umm = new UserModelManager({ sqliteStore: store });

umm.on('interaction-learned', (evt) => {
  console.log(`学习到用户偏好: ${evt.type}`);
});

umm.learnFromInteraction({
  correction: '不要在代码中添加注释',
  languageChoice: 'zh-CN',
  commStyle: 'concise',
  techStack: ['node', 'sqlite', 'vanilla-js'],
  timezone: 'Asia/Shanghai',
});

umm.setPreference('name', '张三');
umm.setPreference('role', '全栈工程师');

const prompt = umm.buildInjectionPrompt();
console.log(prompt);

console.log(umm.getStats());
```

### 偏好读取与删除

```javascript
const lang = umm.getPreference('preferredLanguage');
const allPrefs = umm.getAllPreferences();
umm.removePreference('name');
```

## 依赖关系

- 依赖：`events`（EventEmitter基类）
- 依赖：`../../utils/debug-logger`（调试日志）
- 依赖：`../../utils/safe-parse`（safeJsonParse安全JSON解析）
- 依赖：`../../utils/shutdown-mixin`（优雅关闭混入）
- 依赖：`../../runtime/infrastructure/sqlite-store`（SqliteStore持久化存储，可选）
- 被依赖：AffinityLearner（亲和力学习器，读取偏好数据）
- 被依赖：StructuredIntent（结构化意图解析，使用用户画像辅助意图识别）

## 相关文档

- [[模块详解-SessionManager会话管理器]]
- [[模块详解-ThoughtExtractor思维提取器]]
- [核心功能-模型选择与Token管理](../core/核心功能-模型选择与Token管理.md)
