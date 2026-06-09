# 模块详解-SkillPack技能包分发

> 版本：2.73.4 | 文件：src/runtime/skill/skill-pack-manager.js | 行数：~251行

---

## 模块定位

SkillPackManager是技能包管理器，基于EventEmitter扩展，是技能子系统的技能包分发组件。它支持技能包的创建、导出、导入、发布、弃用、卸载和跨项目共享，填补了Harness框架在技能分发与复用方面的空白。该模块融合了Claude Code扩展功能的技能包分发机制，使技能可以打包为可移植格式在不同项目间共享复用。

## 设计理念

Claude Code扩展通过Skills机制提供可复用的能力单元，但缺乏标准化的分发与共享机制。SkillPackManager通过引入技能包概念，实现：

- **标准化打包**：将多个相关技能打包为可移植的JSON格式，包含版本和依赖信息
- **跨项目共享**：通过导出/导入机制，技能包可在不同项目间传递
- **生命周期管理**：技能包从草稿→发布→弃用的完整生命周期
- **版本兼容**：通过`PACK_FORMAT_VERSION`确保导入导出的格式兼容性

## 类定义

```javascript
class SkillPackManager extends EventEmitter {
  constructor(config)
  createPack(packId, options)
  addSkillToPack(packId, skillId, skillDefinition)
  removeSkillFromPack(packId, skillId)
  exportPack(packId)
  importPack(exportedData, options)
  getPack(packId)
  getInstalledPack(packId)
  listPacks()
  listInstalledPacks()
  publishPack(packId)
  deprecatePack(packId, reason)
  uninstallPack(packId)
  getStats()
  shutdown() // via withShutdown mixin
  isHealthy()
}
```

## 构造函数

### `constructor(config)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config` | object | 否 | 配置选项 |
| `config.maxPacks` | number | 否 | 最大技能包数量，默认50 |
| `config.maxPackSize` | number | 否 | 每包最大技能数，默认100 |
| `config.maxHistorySize` | number | 否 | 历史记录最大容量，默认200 |
| `config.exportDir` | string | 否 | 导出目录，默认`.harness/packs` |

初始化内部状态：
- `_packs` — 基于BoundedMap的技能包定义映射（packId → pack）
- `_installedPacks` — 基于BoundedMap的已安装技能包映射（packId → installed metadata）
- `_skillToPack` — 基于BoundedMap的技能到包映射（skillId → packId）
- `_stats` — 统计信息

## 公开方法详解

### `createPack(packId, options)`

创建新的技能包定义。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 技能包标识符，非空字符串 |
| `options` | object | 否 | 技能包选项 |
| `options.name` | string | 否 | 显示名称，默认为packId |
| `options.description` | string | 否 | 描述，默认为空 |
| `options.version` | string | 否 | 版本号，默认`'1.0.0'` |
| `options.author` | string | 否 | 作者，默认为空 |
| `options.dependencies` | Array | 否 | 依赖列表，默认为空数组 |

**返回值**：`object` — 创建的技能包定义对象

**行为细节**：
- packId已存在时抛出Error
- 技能包数量达到`maxPacks`时抛出Error
- 初始状态为`PACK_STATUS.DRAFT`
- 触发`pack-created`事件

### `addSkillToPack(packId, skillId, skillDefinition)`

向技能包添加技能。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 目标技能包ID |
| `skillId` | string | 是 | 技能标识符 |
| `skillDefinition` | object | 是 | 技能定义 |

**返回值**：`object` — 添加的技能条目`{skill_id, definition, addedAt}`

**行为细节**：
- 技能包不存在时抛出Error
- 技能包已满时抛出Error
- 技能已存在于包中时抛出Error
- 更新`skillToPack`映射和`updatedAt`时间戳
- 触发`skill-added-to-pack`事件

### `removeSkillFromPack(packId, skillId)`

从技能包移除技能。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 目标技能包ID |
| `skillId` | string | 是 | 要移除的技能ID |

**返回值**：`boolean` — 移除成功返回true，技能包或技能不存在返回false

**行为细节**：
- 更新`skillToPack`映射和`updatedAt`时间戳
- 触发`skill-removed-from-pack`事件

### `exportPack(packId)`

将技能包导出为可移植格式（JSON）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 要导出的技能包ID |

**返回值**：`object` — 导出数据对象

```javascript
{
  formatVersion: string,     // PACK_FORMAT_VERSION
  pack: {
    id: string,
    name: string,
    description: string,
    version: string,
    author: string,
    skills: Array<{skill_id, definition}>,
    dependencies: Array,
    exportedAt: string,      // ISO时间戳
  }
}
```

**行为细节**：
- 技能包不存在时抛出Error
- 触发`pack-exported`事件

### `importPack(exportedData, options)`

从可移植格式导入技能包。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `exportedData` | object | 是 | 导出数据对象 |
| `options` | object | 否 | 导入选项 |
| `options.packId` | string | 否 | 目标包ID，默认使用原始ID |
| `options.overwrite` | boolean | 否 | 是否覆盖已存在的包，默认false |

**返回值**：`object` — 安装的技能包元数据

**行为细节**：
- 数据格式无效时抛出Error
- 格式版本不匹配时抛出Error
- 包已安装且未设置overwrite时抛出Error
- 自动注册所有技能到`skillToPack`映射
- 触发`pack-imported`事件

### `getPack(packId)`

获取技能包定义。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 技能包ID |

**返回值**：`object | null`

### `getInstalledPack(packId)`

获取已安装的技能包元数据。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 技能包ID |

**返回值**：`object | null`

### `listPacks()`

列出所有技能包摘要。

**返回值**：`Array<{id, name, version, status, skillCount}>`

### `listInstalledPacks()`

列出所有已安装技能包摘要。

**返回值**：`Array<{id, name, version, skillCount}>`

### `publishPack(packId)`

发布技能包（状态从DRAFT变为PUBLISHED）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 技能包ID |

**返回值**：`object` — 更新后的技能包定义

**行为细节**：
- 技能包不存在时抛出Error
- 空技能包不允许发布
- 触发`pack-published`事件

### `deprecatePack(packId, reason)`

弃用技能包。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 技能包ID |
| `reason` | string | 否 | 弃用原因 |

**返回值**：`object` — 更新后的技能包定义

**行为细节**：
- 技能包不存在时抛出Error
- 触发`pack-deprecated`事件

### `uninstallPack(packId)`

卸载已安装的技能包。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packId` | string | 是 | 技能包ID |

**返回值**：`boolean` — 卸载成功返回true，包不存在返回false

**行为细节**：
- 清除所有技能的`skillToPack`映射
- 触发`pack-uninstalled`事件

### `getStats()`

获取统计信息。

**返回值**：

```javascript
{
  packsCreated: number,
  packsExported: number,
  packsImported: number,
  packsInstalled: number,
  skillsDistributed: number,
  totalPacks: number,
  totalInstalled: number,
}
```

## 导出常量

### PACK_FORMAT_VERSION

技能包导出格式版本号，当前值为`'1.0.0'`。用于导入时验证格式兼容性。

### PACK_STATUS

技能包状态枚举。

| 属性 | 值 | 说明 |
|------|---|------|
| `DRAFT` | `'draft'` | 草稿状态，可编辑 |
| `PUBLISHED` | `'published'` | 已发布，可导出和安装 |
| `DEPRECATED` | `'deprecated'` | 已弃用，不建议使用 |

## 事件列表

| 事件名 | 触发时机 | 数据 |
|--------|---------|------|
| `pack-created` | 技能包创建 | `{packId, pack}` |
| `skill-added-to-pack` | 技能添加到包 | `{packId, skillId}` |
| `skill-removed-from-pack` | 技能从包移除 | `{packId, skillId}` |
| `pack-exported` | 技能包导出 | `{packId, skillCount}` |
| `pack-imported` | 技能包导入 | `{packId, skillCount}` |
| `pack-published` | 技能包发布 | `{packId}` |
| `pack-deprecated` | 技能包弃用 | `{packId, reason}` |
| `pack-uninstalled` | 技能包卸载 | `{packId}` |

## 使用示例

### 创建与发布技能包

```javascript
const { SkillPackManager, PACK_STATUS } = require('./src/runtime/skill/skill-pack-manager');

const manager = new SkillPackManager({
  maxPacks: 50,
  maxPackSize: 100,
});

// 创建技能包
const pack = manager.createPack('code-quality', {
  name: '代码质量工具包',
  description: '包含代码审查、测试和文档生成的技能',
  version: '1.0.0',
  author: 'harness-team',
});

// 添加技能
manager.addSkillToPack('code-quality', 'code-review', {
  name: '代码审查',
  handler: 'reviewHandler',
});
manager.addSkillToPack('code-quality', 'test-runner', {
  name: '测试运行',
  handler: 'testHandler',
});

// 发布
manager.publishPack('code-quality');
console.log('技能包已发布，状态:', PACK_STATUS.PUBLISHED);
```

### 导出与导入

```javascript
// 导出技能包为可移植格式
const exported = manager.exportPack('code-quality');
console.log('导出格式版本:', exported.formatVersion);
console.log('包含技能数:', exported.pack.skills.length);

// 在另一个项目中导入
const manager2 = new SkillPackManager();
const installed = manager2.importPack(exported, { overwrite: false });
console.log('已安装:', installed.sourceName, 'v' + installed.sourceVersion);
```

### 管理已安装技能包

```javascript
// 列出所有已安装包
const installed = manager.listInstalledPacks();
for (const pack of installed) {
  console.log(`${pack.name} v${pack.version} (${pack.skillCount} 技能)`);
}

// 卸载
manager.uninstallPack('code-quality');

// 弃用
manager.deprecatePack('old-pack', '已被新版替代');
```

### 事件监听

```javascript
manager.on('pack-created', ({ packId, pack }) => {
  console.log(`技能包创建: ${pack.name}`);
});

manager.on('pack-imported', ({ packId, skillCount }) => {
  console.log(`技能包导入: ${packId}, 包含 ${skillCount} 个技能`);
});
```

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxPacks` | number | 50 | 最大技能包数量 |
| `maxPackSize` | number | 100 | 每包最大技能数 |
| `maxHistorySize` | number | 200 | BoundedMap历史记录最大容量 |
| `exportDir` | string | `'.harness/packs'` | 导出目录路径 |

## 与其他模块的关系

- **依赖**：`events`（Node.js内置） — EventEmitter基类
- **依赖**：`../../utils/shutdown-mixin.js` — 优雅关闭
- **依赖**：`../../utils/safe-execute.js` — 安全调用
- **依赖**：`../../utils/bounded-map.js` — 有界映射（技能包存储）
- **协作**：ContextBudgetOptimizer — 技能包加载时检查上下文预算配额（SKILLS层）
- **协作**：EventBus — 通过事件总线发布技能包生命周期事件
- **协作**：SkillRegistry — 技能包中的技能定义可注册到技能注册表
- **被依赖**：SharedInfrastructure — 作为技能分发子系统的核心组件

## 相关文档

- [模块详解-EventBus模块](模块详解-EventBus模块.md)
- [模块详解-上下文预算优化器](模块详解-上下文预算优化器.md)
- [模块详解-MCP服务器自动发现](模块详解-MCP服务器自动发现.md)
