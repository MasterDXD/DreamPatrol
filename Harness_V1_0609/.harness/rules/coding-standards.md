---
rule_id: coding-standards
name: 编码规范规则
phase: module-development
enforcement: strict
priority: 1
applicable_agents: [task-worker, test-writer, build-error-solver, code-reviewer, typescript-reviewer, python-reviewer, go-reviewer, rust-reviewer, java-reviewer]
---

# 编码规范规则

## 通用编码规范

### 命名规范
- 变量名使用camelCase（JavaScript/TypeScript/Java）
- 变量名使用snake_case（Python/Rust）
- 变量名使用camelCase（Go导出用PascalCase）
- 常量使用UPPER_SNAKE_CASE
- 类名使用PascalCase
- 函数名使用动词开头，清晰描述行为
- 布尔变量使用is/has/can/should前缀
- 避免单字母变量（循环计数器i/j/k除外）
- 避免缩写，使用完整单词

### 函数规范
- 单一职责原则：每个函数只做一件事
- 函数长度不超过50行（超过则拆分）
- 参数不超过4个（超过则使用对象参数）
- 必须处理所有返回值和错误
- 避免副作用，纯函数优先
- 提前返回，减少嵌套层级

### 注释规范
- 不添加无意义的注释（代码本身应足够清晰）
- 复杂逻辑必须注释说明"为什么"而非"做什么"
- 公开API必须有JSDoc/docstring注释
- TODO注释格式：`TODO(作者): 描述`
- FIXME注释格式：`FIXME(作者): 描述`
- 禁止注释掉的代码（使用版本控制代替）

### 错误处理
- 不允许空catch块
- 错误必须传播或处理，不允许静默忽略
- 使用具体的错误类型，不使用通用Error
- 错误消息必须包含上下文信息
- 异步错误必须正确传播（async/await或Promise链）

### AI错误处理最低要求
- 所有外部输入（函数参数、HTTP请求体、文件内容、环境变量）必须做空值/类型校验
- 资源操作（文件I/O、网络请求、数据库操作）必须try-catch-finally
- 共享可变状态访问必须有并发保护（锁、原子操作或不可变数据）
- 定时器/事件监听器/连接必须在finally或shutdown中清理
- 数值转换后使用`||`而非`??`处理NaN（`parseInt(x, 10) || 0`而非`parseInt(x, 10) ?? 0`）

### 并发安全编码规范
- 共享可变状态必须通过锁（LockManager）或原子操作保护
- 优先使用不可变数据结构，避免共享可变状态
- 异步操作必须处理竞态条件（AbortController、版本号、比较交换）
- 写操作必须使用写锁，读操作可使用读写锁的读模式
- 锁获取必须有超时保护，避免死锁
- 锁释放必须在finally块中确保执行

## 语言特定规范

### TypeScript/JavaScript
- 启用strict模式
- 禁止使用any类型（必要时使用unknown）
- 使用const优先，let次之，禁止var
- 使用模板字符串代替字符串拼接
- 使用可选链(?.)和空值合并(??)
- 优先使用interface而非type
- 异步操作使用async/await

### Python
- 遵循PEP 8风格指南
- 使用Type Hints标注函数签名
- 使用f-string代替format和%
- 使用pathlib代替os.path
- 使用上下文管理器(with)管理资源
- 异步代码使用asyncio

### Go
- 遵循Effective Go规范
- 错误处理使用errors.Is/errors.As
- 接口在消费方定义
- 使用组合代替继承
- 导出函数必须有doc comment

### Rust
- 遵循Rust API Guidelines
- 优先使用Result代替unwrap()
- unsafe代码必须附带安全说明
- 使用Clippy推荐的惯用写法
- 实现Drop trait管理资源

### Java
- 遵循Effective Java最佳实践
- 使用Optional代替null
- 优先使用组合代替继承
- 使用try-with-resources管理资源
- 避免过早优化

## 文件组织
- 每个文件只包含一个顶层类/模块
- 文件名与类名一致
- 导入按标准库/第三方/本地分组
- 导出使用命名导出，避免默认导出

## 命名红线（NO_VAGUE_FILENAME）

### 禁止的文件命名模式
- **版本后缀**：禁止 `utils_v2.js`、`handler_final.js`、`service_new.js`、`module_old.js` 等含版本/状态后缀的文件名
- **模糊泛化**：禁止 `utils.js`、`helpers.js`、`common.js`、`misc.js` 等不描述具体职责的文件名
- **临时标记**：禁止 `temp.js`、`debug.js`、`wip.js`、`backup.js` 等临时性命名
- **测试版本堆积**：禁止 `test-v2.test.js`、`test-v3.test.js` 等增量版本测试文件，应合并到主测试文件

### 正确的命名方式
- 文件名必须清晰描述其职责：`dashboard-http-utils.js` 而非 `utils.js`
- 测试文件按功能模块命名：`deepening-scheduler.test.js` 而非 `deepening-v22.test.js`
- 需要新增功能时，扩展现有文件而非创建新版本文件

## 死代码清理（DEAD_CODE_CLEANUP）

### 定期清理规则
- **每周清理**：每周五执行死代码清理，删除未被任何文件引用的孤立模块
- **识别方法**：使用 `grep -r "require.*module-name" src/` 检查模块是否被引用
- **安全删除**：删除前确认模块未被动态加载（如 `module-initializer.js` 的注册表）
- **标记优先**：对暂时不确定是否可删除的模块，在文件头部添加 `@deprecated` JSDoc 标签和替代方案说明

### 孤立模块判定标准
- 模块未被任何 `src/` 下的文件 `require`
- 模块未在 `module-initializer.js` 中注册
- 模块未在 `index.js` 入口文件中导出
- 模块对应的测试文件已不存在或测试全部跳过

### 清理记录
- 每次清理需在 CHANGELOG 中记录删除的模块列表
- 保留删除记录至少一个版本周期，以便回滚

## 关闭生命周期模式（SHUTDOWN_LIFECYCLE）

### withShutdown混入模式
所有持有资源（定时器、连接、监听器、文件句柄）的类必须使用`withShutdown`混入或实现等效的关闭协议：
- **`withShutdown(BaseClass)`**：混入关闭能力，添加`shutdown()`方法和`_shuttingDown`标志
- **`guardShutdown()`**：在所有异步操作入口检查`_shuttingDown`，若为true则跳过操作
- **`_onShutdown()`**：子类覆写此方法执行资源清理（清除定时器、关闭连接、释放锁）
- **关闭顺序**：先设置`_shuttingDown=true`，再执行`_onShutdown()`，最后清理引用

### 关闭安全规则
- 定时器/事件监听器/连接必须在`_onShutdown()`中清理
- 不允许在关闭后启动新操作（`guardShutdown()`检查）
- 关闭操作必须是幂等的（重复调用不报错）
- 关闭超时保护：设置30s超时，超时后强制清理

## 有界集合使用规范（BOUNDED_COLLECTIONS）

### BoundedMap使用指南
- 所有长期存活的Map必须使用`BoundedMap`替代，防止内存泄漏
- 构造参数：`new BoundedMap({ maxSize: N })`，N根据业务需求设定
- 淘汰策略：LRU（默认）或FIFO
- 适用场景：缓存、注册表、索引、会话存储

### BoundedArray使用指南
- 所有无限增长的数组必须使用`BoundedArray`替代
- 构造参数：`new BoundedArray({ maxSize: N })`
- 超出容量时自动淘汰最早元素
- 适用场景：历史记录、日志缓冲、事件队列

### 容量配置
- 所有有界集合的容量应通过`capacity-config`统一管理
- 默认容量值定义在`src/utils/capacity-config.js`
- 新增有界集合时必须在`capacity-config`中注册默认值

## 事件命名规范（EVENT_NAMING）

### 命名格式
- 事件名使用`namespace:action`格式，如`dev-metrics:project-started`
- 命名空间与模块名一致：`dev-metrics`、`pair-chat`、`chat-chain`、`skill`等
- 动作使用kebab-case过去式：`project-started`、`artifact-registered`、`hallucination-detected`

### 已注册命名空间
- `dev-metrics:` — DevMetricsCollector指标事件
- `pair-chat:` — PairChat交叉验证事件
- `chat-chain:` — ChatChain产物事件
- `skill:` — 技能生命周期事件
- `dream:` — DreamEngine梦境事件
- `memory:` — 记忆管道事件

## 测试规范（TESTING_STANDARDS）

### 测试框架
- 使用Node.js内置test runner（`node:test`）
- 断言使用`node:assert`严格模式
- 覆盖率工具：c8
- 测试文件命名：`*.test.js`

### 测试结构
- 每个测试文件对应一个源文件
- 使用`describe`/`it`组织测试用例
- 测试必须可独立运行，不依赖执行顺序
- 使用Fixture或Factory替代硬编码测试数据

### TDD流程
- RED：先写失败测试
- GREEN：写最少代码使测试通过
- REFACTOR：重构代码，保持测试通过
- 每个RED-GREEN-REFACTOR循环控制在2-5分钟内
