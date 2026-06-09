# 驭·桌面伙伴 — 开发指南

> 面向开发者的完整技术文档，涵盖架构设计、源码解析、扩展开发和调试部署。

---

## 目录

1. [架构概览](#1-架构概览)
2. [项目结构详解](#2-项目结构详解)
3. [主进程 (main.js)](#3-主进程-mainjs)
4. [预加载脚本 (preload.js)](#4-预加载脚本-preloadjs)
5. [渲染进程 (companion.js)](#5-渲染进程-companionjs)
6. [样式系统 (companion.css)](#6-样式系统-companioncss)
7. [扩展指南](#7-扩展指南)
8. [构建与打包](#8-构建与打包)
9. [调试技巧](#9-调试技巧)
10. [代码规范](#10-代码规范)
    - [10.1 变量命名](#101-变量命名)
    - [10.2 错误处理模式](#102-错误处理模式)
    - [10.3 DOM 操作模式](#103-dom-操作模式)
    - [10.4 事件监听模式](#104-事件监听模式)
    - [10.5 定时器管理模式](#105-定时器管理模式)
    - [10.6 Promise 模式](#106-promise-模式)
    - [10.7 循环中的 DOM 元素创建与闭包](#107-循环中的-dom-元素创建与闭包)
    - [10.8 IPC 事件监听器清理](#108-ipc-事件监听器清理)
    - [10.9 DOM 元素自动清理](#109-dom-元素自动清理)
    - [10.10 innerHTML 安全规范](#1010-innerhtml-安全规范)
    - [10.11 递归调用防护](#1011-递归调用防护)
    - [10.12 localStorage 数据验证](#1012-localstorage-数据验证)
    - [10.13 枚举值输入验证](#1013-枚举值输入验证)
    - [10.14 配置表模式](#1014-配置表模式)
    - [10.15 设计系统规范](#1015-设计系统规范)
    - [10.16 IPC 参数验证](#1016-ipc-参数验证)
    - [10.17 函数输入验证](#1017-函数输入验证)
    - [10.18 logEvent 参数顺序约定](#1018-logevent-参数顺序约定)
    - [10.19 枚举白名单验证](#1019-枚举白名单验证)
    - [10.20 轮询日志防洪](#1020-轮询日志防洪)
    - [10.21 Vibe能力配置表模式](#1021-vibe能力配置表模式)
    - [10.22 临时动画类完整清理](#1022-临时动画类完整清理)
    - [10.23 SuperAgent能力配置表模式](#1023-superagent能力配置表模式)
    - [10.24 AI状态优先级与竞态防护](#1024-ai状态优先级与竞态防护)
    - [10.25 定时器生命周期管理](#1025-定时器生命周期管理)
    - [10.26 扩展层配置表模式](#1026-扩展层配置表模式)
    - [10.27 工具函数防御性编程](#1027-工具函数防御性编程)
    - [10.28 SDD实践配置表模式](#1028-sdd实践配置表模式)
    - [10.29 存储键名与API端点常量化](#1029-存储键名与api端点常量化)
    - [10.30 成就检查级联防护](#1030-成就检查级联防护)
    - [10.31 条件性初始化奖励](#1031-条件性初始化奖励)
    - [10.32 CSS @keyframes引用完整性](#1032-css-keyframes引用完整性)
    - [10.33 API端点路径遍历防护](#1033-api端点路径遍历防护)
    - [10.34 HTTP响应大小限制](#1034-http响应大小限制)
    - [10.35 Promise超时双重resolve防护](#1035-promise超时双重resolve防护)
    - [10.36 IPC参数NaN/Infinity防护](#1036-ipc参数naninfinity防护)
    - [10.37 事件回调参数类型校验](#1037-事件回调参数类型校验)
    - [10.38 递归setTimeout替代setInterval实现随机间隔](#1038-递归settimeout替代setinterval实现随机间隔)
    - [10.39 mousemove监听器合并](#1039-mousemove监听器合并)
    - [10.40 CSS filter属性不可覆盖drop-shadow](#1040-css-filter属性不可覆盖drop-shadow)
    - [10.41 CSS自定义属性必须先定义后使用](#1041-css自定义属性必须先定义后使用)
    - [10.42 API认证令牌传递](#1042-api认证令牌传递)
    - [10.43 API端点数据格式兼容](#1043-api端点数据格式兼容)
    - [10.44 CSS死规则清理](#1044-css死规则清理)
    - [10.45 DOM元素null安全防护](#1045-dom元素null安全防护)
    - [10.46 innerHTML安全替代](#1046-innerhtml安全替代)
    - [10.47 SKINS配置表键存在性校验](#1047-skins配置表键存在性校验)
    - [10.48 API数据兼容性防护](#1048-api数据兼容性防护)
    - [10.49 CSS浏览器前缀完整性](#1049-css浏览器前缀完整性)
    - [10.50 CSS选择器与DOM结构一致性](#1050-css选择器与dom结构一致性)
    - [10.51 xpForLevel除零与无限循环防护](#1051-xpforlevel除零与无限循环防护)
    - [10.52 主进程错误处理与日志规范](#1052-主进程错误处理与日志规范)
    - [10.53 主进程常量提取与URL安全化](#1053-主进程常量提取与url安全化)
    - [10.54 定时器孤儿防护](#1054-定时器孤儿防护)
    - [10.55 事件处理器默认行为控制](#1055-事件处理器默认行为控制)
    - [10.56 CSS自定义变量声明规范](#1056-css自定义变量声明规范)
    - [10.57 可访问性（a11y）规范](#1057-可访问性a11y规范)
    - [10.58 思想钻石（Thought Diamond）融合规范](#1058-思想钻石thought-diamond融合规范)
    - [10.82 addXP NaN/Infinity防护](#1082-addxp-naninfinity防护)
    - [10.83 showPermissionCard手动状态标志](#1083-showpermissioncard手动状态标志)
    - [10.84 pollOptimizationStatus服务不可用状态重置](#1084-polloptimizationstatus服务不可用状态重置)
    - [10.85 FX_BODY_CLASSES完整覆盖所有动画类](#1085-fx_body_classes完整覆盖所有动画类)
    - [10.86 switchSkin清理AI状态和特效](#1086-switchskin清理ai状态和特效)
    - [10.87 clearAIState重置mouth](#1087-clearaistate重置mouth)
    - [10.88 hidePermissionCard恢复前状态](#1088-hidepermissioncard恢复前状态)
    - [10.89 showToast堆积限制](#1089-showtoast堆积限制)
    - [10.90 API轮询并发保护](#1090-api轮询并发保护)
    - [10.91 睡眠阶段CSS类先清后加](#1091-睡眠阶段css类先清后加)
    - [10.92 addXP互动计数分离](#1092-addxp互动计数分离)
    - [10.93 skinTransition定时器追踪](#1093-skintransition定时器追踪)
    - [10.94 CSS动画性能：transform替代重排属性](#1094-css动画性能transform替代重排属性)
    - [10.95 optimization-loop stop()延迟期间Promise解除](#1095-optimization-loop-stop延迟期间promise解除)
    - [10.96 agent-debug-loop reset()并发竞态防护](#1096-agent-debug-loop-reset并发竞态防护)
    - [10.97 ai-code-trust-scorer衰减一致性](#1097-ai-code-trust-scorer衰减一致性)
    - [10.98 rbac-enforcer加载失败重置为deny-all](#1098-rbac-enforcer加载失败重置为deny-all)
    - [10.99 clearAIState必须重置state.aiState](#1099-clearaistate必须重置stateaistate)
    - [10.100 String.replace的$模式注入防护](#10100-stringreplace的模式注入防护)
    - [10.101 mousemove事件监听器去重](#10101-mousemove事件监听器去重)
    - [10.102 onLevelUp免打扰模式检查](#10102-onlevelup免打扰模式检查)
    - [10.103 API返回值类型安全：数组与对象兼容](#10103-api返回值类型安全数组与对象兼容)
    - [10.104 processAgentData空闲时重置currentAgent](#10104-processagentdata空闲时重置currentagent)
    - [10.105 双击事件XP防膨胀](#10105-双击事件xp防膨胀)
    - [10.106 Web Audio节点生命周期管理](#10106-web-audio节点生命周期管理)
    - [10.107 GOAL_STATUS枚举完整性](#10107-goal_status枚举完整性)
    - [10.108 EventBus onceAsync关闭时Promise结算](#10108-eventbus-onceasync关闭时promise结算)
    - [10.109 ChatChain FAILED依赖级联传播](#10109-chatchain-failed依赖级联传播)
    - [10.110 RetryEngine _sleep关闭时reject而非resolve](#10110-retryengine-_sleep关闭时reject而非resolve)
    - [10.111 ContextCompressionEngine缓存引用隔离](#10111-contextcompressionengine缓存引用隔离)
    - [10.112 isHealthy()异常安全](#10112-ishealthy异常安全)
    - [10.113 CSS overflow:visible与装饰元素裁剪](#10113-css-overflowvisible与装饰元素裁剪)
    - [10.114 CSS transition:all替换为明确属性列表](#10114-css-transitionall替换为明确属性列表)
    - [10.115 Electron单实例锁](#10115-electron单实例锁)
    - [10.116 macOS activate事件处理隐藏窗口](#10116-macos-activate事件处理隐藏窗口)
    - [10.117 ARIA可访问性：菜单项、按钮、进度条](#10117-aria可访问性菜单项按钮进度条)
    - [10.118 CSS z-index层级分配规范](#10118-css-z-index层级分配规范)
    - [10.119 prefers-reduced-motion媒体查询](#10119-prefers-reduced-motion媒体查询)
    - [10.120 CSP object-src 'none'指令](#10120-csp-object-src-none指令)
    - [10.121 skill-graph邻接表与边数据一致性](#10121-skill-graph邻接表与边数据一致性)
    - [10.122 dev-metrics-collector Token增量同步](#10122-dev-metrics-collector-token增量同步)
    - [10.123 ensemble-orchestrator Boosting轮数不被agent数截断](#10123-ensemble-orchestrator-boosting轮数不被agent数截断)
    - [10.124 Math.exp溢出防护：权重裁剪](#10124-mathexp溢出防护权重裁剪)
    - [10.125 async方法中同步/异步返回值兼容](#10125-async方法中同步异步返回值兼容)
    - [10.126 success字段与converged语义一致](#10126-success字段与converged语义一致)
    - [10.127 loadL2Async并发请求合并](#10127-loadl2async并发请求合并)
    - [10.128 registerAgent更新后返回实际档案](#10128-registeragent更新后返回实际档案)
    - [10.129 convergence-detector无效数据拒绝入队](#101129-convergence-detector无效数据拒绝入队)
    - [10.130 Object.create替代为展开运算符浅拷贝](#10130-objectcreate替代为展开运算符浅拷贝)
    - [10.131 CSS动画使用filter而非box-shadow](#10131-css动画使用filter而非box-shadow)
    - [10.132 CSS animation:none替代为微静止动画](#10132-css-animationnone替代为微静止动画)
    - [10.133 speech-text多行截断](#10133-speech-text多行截断)
    - [10.134 move-window屏幕边界检查](#10134-move-window屏幕边界检查)
    - [10.135 send-command长度限制](#10135-send-command长度限制)
    - [10.136 skill-graph getExecutionOrder过滤无效ID](#10136-skill-graph-getexecutionorder过滤无效id)
    - [10.137 公共方法guardShutdown一致性](#10137-公共方法guardshutdown一致性)
    - [10.138 QualityScorer回退评分](#10138-qualityscorer回退评分)
    - [10.139 增量计数替代全量遍历](#10139-增量计数替代全量遍历)
    - [10.140 CSS transition:all替换为明确属性列表（批量）](#10140-css-transitionall替换为明确属性列表批量)
    - [10.141 minimal模式hover恢复drag-hint和edge-indicator](#10141-minimal模式hover恢复drag-hint和edge-indicator)
    - [10.142 TokenManager store/clear关闭守卫一致性](#10142-tokenmanager-storeclear关闭守卫一致性)
    - [10.143 SessionManager TTL清理先删文件后删内存](#10143-sessionmanager-ttl清理先删文件后删内存)
    - [10.144 CheckpointManager单调时间戳跨进程恢复](#10144-checkpointmanager单调时间戳跨进程恢复)
    - [10.145 PhaseOrchestrator关闭时使用_shuttingDown标志](#10145-phaseorchestrator关闭时使用_shuttingdown标志)
    - [10.146 state属性命名一致性：blinkTimer替代blinkInterval](#10146-state属性命名一致性blinktimer替代blinkinterval)
    - [10.147 DOM查询预缓存模式](#10147-dom查询预缓存模式)
    - [10.148 clearFx增量类名移除](#10148-clearfx增量类名移除)
    - [10.167 AudioContext必须在beforeunload中关闭](#10167-audiocontext必须在beforeunload中关闭)
    - [10.168 DOM查询结果应缓存到els对象中](#10168-dom查询结果应缓存到els对象中)
    - [10.169 ACHIEVEMENTS.check包裹try-catch](#10169-achievementscheck包裹try-catch)
    - [10.170 conversation-context-store.getSessionContext验证sessionId格式](#10170-conversation-context-storegetsessioncontext验证sessionid格式)
    - [10.171 conversation-context-store.compressSession不得重置turnCount](#10171-conversation-context-storecompresssession不得重置turncount)
    - [10.172 conversation-context-store._deleteTurnsFromStore非空检查](#10172-conversation-context-store_deleteturnsfromstore非空检查)
    - [10.173 chat-chain.retryTask恢复链状态使用PENDING](#10173-chat-chainretrytask恢复链状态使用pending)
    - [10.174 chat-chain.failTask重试条件使用<而非<=](#10174-chat-chainfailtask重试条件使用-而非)
    - [10.175 thought-memory-store方法shutdown后空指针防护](#10175-thought-memory-store方法shutdown后空指针防护)
    - [10.176 preload.js IPC API方法输入验证](#10176-preloadjs-ipc-api方法输入验证)
    - [10.177 rag-pipeline._generateDocId碰撞防护与_chunkText overlap clamp](#10177-rag-pipeline_generatedocid碰撞防护与_chunktext-overlap-clamp)
    - [10.178 graph-rag._extractRelations段落偏移量使用实际分隔符长度](#10178-graph-rag_extractrelations段落偏移量使用实际分隔符长度)
    - [10.179 graph-rag._pruneWeakRelations双向关系键删除](#10179-graph-rag_pruneweakrelations双向关系键删除)
    - [10.180 graph-rag.attach方法返回this支持链式调用](#10180-graph-ragattach方法返回this支持链式调用)
    - [10.181 graph-rag._removeDocumentEntities使用Set替代Array.includes](#10181-graph-rag_removedocumententities使用set替代arrayincludes)
    - [10.182 TIMING常量提取规范](#10182-timing常量提取规范)
    - [10.183 null安全防护规范](#10183-null安全防护规范)
    - [10.184 DOM查询缓存规范](#10184-dom查询缓存规范)
    - [10.185 goal-executor BLOCKED子任务重试规范](#10185-goal-executor-blocked子任务重试规范)
    - [10.186 thought-retriever-cycle merged数组存储规范](#10186-thought-retriever-cycle-merged数组存储规范)
    - [10.187 pair-chat corrections验证规范](#10187-pair-chat-corrections验证规范)
    - [10.188 pair-chat时间戳解析规范](#10188-pair-chat时间戳解析规范)
    - [10.189 event-bus历史记录深拷贝规范](#10189-event-bus历史记录深拷贝规范)
    - [10.190 event-bus onceAsync容量限制规范](#10190-event-bus-onceasync容量限制规范)
    - [10.191 context-compression无预算压缩防护规范](#10191-context-compression无预算压缩防护规范)
    - [10.192 context-compression缓存满驱逐规范](#10192-context-compression缓存满驱逐规范)
    - [10.193 goal-executor resume零迭代防护规范](#10193-goal-executor-resume零迭代防护规范)
    - [10.194 goal-executor _shuttingDown属性统一规范](#10194-goal-executor-_shuttingdown属性统一规范)
    - [10.195 dream-outcomes metric方向感知评估规范](#10195-dream-outcomes-metric方向感知评估规范)
    - [10.196 goal-executor resume错误路径统计完整性规范](#10196-goal-executor-resume错误路径统计完整性规范)
    - [10.197 goal-executor _loopPromises驱逐两阶段规范](#10197-goal-executor-_looppromises驱逐两阶段规范)
    - [10.198 pair-chat统计值类型一致性规范](#10198-pair-chat统计值类型一致性规范)
    - [10.199 optimization-loop rollbackTo状态完整重置规范](#10199-optimization-loop-rollbackto状态完整重置规范)
    - [10.200 graph-rag实体匹配最小长度规范](#10200-graph-rag实体匹配最小长度规范)
    - [10.201 companion.js关键函数try-catch防护规范](#10201-companionjs关键函数try-catch防护规范)
    - [10.202 TIMING常量新增与硬编码消除规范](#10202-timing常量新增与硬编码消除规范)
    - [10.203 SDD规格追溯矩阵规范](#10203-sdd规格追溯矩阵规范)
    - [10.204 SDD文档-代码同步验证规范](#10204-sdd文档-代码同步验证规范)
    - [10.205 SDD PhaseBridge自动门禁规范](#10205-sdd-phasebridge自动门禁规范)
    - [10.206 SDD AI质疑/澄清机制规范](#10206-sdd-ai质疑澄清机制规范)
    - [10.207 SDD合约持久化规范](#10207-sdd合约持久化规范)
    - [10.208 conversation-context-store驱逐属性名与列名规范](#10208-conversation-context-store驱逐属性名与列名规范)
    - [10.209 conversation-context-store压缩序列号规范](#10209-conversation-context-store压缩序列号规范)
    - [10.210 dream-engine回滚深拷贝规范](#10210-dream-engine回滚深拷贝规范)
    - [10.211 dream-engine统计计数器回滚规范](#10211-dream-engine统计计数器回滚规范)
    - [10.212 dream-engine事件发射时序规范](#10212-dream-engine事件发射时序规范)
    - [10.213 agent-runtime shutdown资源释放规范](#10213-agent-runtime-shutdown资源释放规范)
    - [10.214 agent-runtime _evictOldest双重释放防护规范](#10214-agent-runtime-_evictoldest双重释放防护规范)
    - [10.215 subagent-executor shutdown拒绝挂起Promise规范](#10215-subagent-executor-shutdown拒绝挂起promise规范)
    - [10.216 subagent-executor _resolveModel安全调用规范](#10216-subagent-executor-_resolvemodel安全调用规范)
    - [10.217 chat-chain retryTask依赖检查规范](#10217-chat-chain-retrytask依赖检查规范)
    - [10.218 chat-chain级联失败事件规范](#10218-chat-chain级联失败事件规范)
    - [10.219 thought-retriever-cycle storeThoughts返回值类型验证规范](#10219-thought-retriever-cycle-storethoughts返回值类型验证规范)
    - [10.220 pipeline-executor无路由器错误传播规范](#10220-pipeline-executor无路由器错误传播规范)
    - [10.221 output-fusion权重归一化规范](#10221-output-fusion权重归一化规范)
    - [10.222 agent-monitor shutdown检查一致性规范](#10222-agent-monitor-shutdown检查一致性规范)
    - [10.223 module-initializer SIMPLE_MODULES清理追踪规范](#10223-module-initializer-simple_modules清理追踪规范)
    - [10.224 model-selector LRU插入顺序规范](#10224-model-selector-lru插入顺序规范)
    - [10.225 model-selector复杂度阈值回退值一致性规范](#10225-model-selector复杂度阈值回退值一致性规范)
    - [10.226 skill-router modelTier提取规范](#10226-skill-router-modeltier提取规范)
    - [10.227 skill-reducer定时器去重规范](#10227-skill-reducer定时器去重规范)
    - [10.228 context-compression状态哈希完整性规范](#10228-context-compression状态哈希完整性规范)
    - [10.229 context-compression数组压缩省略计数规范](#10229-context-compression数组压缩省略计数规范)
    - [10.230 isolated-context-manager访问控制强制规范](#10230-isolated-context-manager访问控制强制规范)
    - [10.231 isolated-context-manager结果覆写防护规范](#10231-isolated-context-manager结果覆写防护规范)
    - [10.232 quality-scorer getHistory边界规范](#10232-quality-scorer-gethistory边界规范)
    - [10.233 business-goal KPI覆写防护规范](#10233-business-goal-kpi覆写防护规范)
    - [10.234 token-manager LRU驱逐条件规范](#10234-token-manager-lru驱逐条件规范)
    - [10.235 human-approval-gate shutdown清理规范](#10235-human-approval-gate-shutdown清理规范)
    - [10.236 retry-engine _escalate复杂度拆分规范](#10236-retry-engine-_escalate复杂度拆分规范)
    - [10.237 deepening-orchestrator bestScore无限值防护规范](#10237-deepening-orchestrator-bestscore无限值防护规范)
    - [10.238 plugin-manager异步init异常处理规范](#10238-plugin-manager异步init异常处理规范)

---

## 1. 架构概览

### 1.1 Electron 三进程架构

桌面伙伴基于 Electron 的标准三进程架构，各进程职责明确、通信安全：

```
┌─────────────────────────────────────────────────────────────┐
│                      主进程 (main.js)                        │
│  · 创建 BrowserWindow（透明无边框窗口）                       │
│  · 系统托盘 & 全局快捷键                                      │
│  · HTTP API 代理（proxyAPI / postAPI）                       │
│  · IPC 处理器（ipcMain.handle）                               │
│  · 窗口位置 / 尺寸 / 鼠标穿透控制                             │
└──────────┬──────────────────────────┬───────────────────────┘
           │ preload.js               │ ipcMain.handle
           │ contextBridge            │ ipcRenderer.invoke
           ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    预加载脚本 (preload.js)                    │
│  · contextBridge.exposeInMainWorld('companionAPI', {...})    │
│  · 16 个安全暴露的 API 方法                                    │
│  · 3 个事件监听器（onSpeech / onPermissionRequest / Shortcut）│
└──────────┬──────────────────────────────────────────────────┘
           │ window.companionAPI
           ▼
┌─────────────────────────────────────────────────────────────┐
│                   渲染进程 (companion.js)                     │
│  · IIFE 沙箱 + 严格模式                                      │
│  · UI 渲染 & 交互逻辑                                        │
│  · 状态机 / 成长系统 / 特效系统                               │
│  · API 轮询 & 数据处理                                       │
│  · localStorage 持久化                                       │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 IPC 通信模式

所有跨进程通信遵循 Electron 安全最佳实践：

- **请求-响应模式**：渲染进程通过 `ipcRenderer.invoke()` 发起请求，主进程通过 `ipcMain.handle()` 响应
- **事件推送模式**：主进程通过 `webContents.send()` 主动推送事件（语音、权限请求等）
- **contextBridge 隔离**：渲染进程无法直接访问 `ipcRenderer`，只能通过 `window.companionAPI` 调用

```javascript
// 渲染进程调用示例
const result = await window.companionAPI.proxyAPI('/api/agents');
const bounds = await window.companionAPI.getWindowBounds();
window.companionAPI.onSpeech((text) => { /* 处理语音 */ });
```

### 1.3 安全模型

| 安全措施 | 配置 | 说明 |
|---------|------|------|
| contextIsolation | `true` | 渲染进程无法访问预加载脚本的 Node.js API |
| nodeIntegration | `false` | 渲染进程无法直接使用 Node.js 模块 |
| API 前缀校验 | `/api/` | `proxy-api` 处理器仅允许以 `/api/` 开头的端点 |
| sandbox | 默认启用 | 预加载脚本在沙箱中运行 |
| CSP | Content-Security-Policy | 限制资源加载来源，防止 XSS 注入 |

**CSP（Content-Security-Policy）说明**

主进程在 `createWindow()` 中通过 `webContents.session.webRequest.onHeadersReceived` 设置 CSP 响应头，对渲染进程的资源加载施加严格限制：

```javascript
mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self' http://localhost:3210; " +
        "media-src 'self'; " +
        "font-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self';"
      ]
    }
  });
});
```

| CSP 指令 | 值 | 说明 |
|----------|---|------|
| `default-src` | `'self'` | 默认仅允许加载同源资源 |
| `script-src` | `'self'` | 仅允许加载同源脚本，禁止内联脚本和 `eval()` |
| `style-src` | `'self' 'unsafe-inline'` | 允许同源样式和内联样式（CSS 自定义属性换肤需要） |
| `img-src` | `'self' data:` | 允许同源图片和 data URI |
| `connect-src` | `'self' http://localhost:3210` | 允许渲染进程向本地Harness后端发起HTTP请求 |
| `media-src` | `'self'` | 允许播放本地媒体资源 |
| `font-src` | `'self'` | 仅允许同源字体 |
| `object-src` | `'none'` | 禁止加载任何插件（Flash、Java 等） |
| `base-uri` | `'self'` | 限制 `<base>` 标签的 URL 范围 |

> **注意**：`style-src` 中的 `'unsafe-inline'` 是必要的，因为项目使用 CSS 自定义属性（`--skin-*`）和内联 `classList` 操作实现零刷新换肤，移除会导致换肤功能失效。`connect-src` 限制为 `http://localhost:3210`，确保渲染进程无法向任意远程地址发送请求。

---

## 2. 项目结构详解

```
desktop-companion/
├── main.js              # Electron 主进程入口
│                         · 窗口创建与配置
│                         · 系统托盘与菜单
│                         · 全局快捷键注册
│                         · IPC 处理器（14个）
│                         · HTTP API 代理函数
│
├── preload.js           # 预加载脚本
│                         · contextBridge API 暴露
│                         · 16个方法 + 3个事件监听器
│
├── package.json         # 项目配置与构建脚本
│
├── src/                 # 渲染进程资源
│   ├── index.html       # 主 HTML（DOM 结构定义）
│   ├── companion.js     # 渲染进程核心逻辑（~2100行）
│   ├── companion.css    # 样式系统（~3200行）
│   ├── icon.png         # 应用图标（托盘/窗口）
│   └── icon-small.png   # 小尺寸图标
│
├── src-tauri/           # Tauri 备选方案（实验性）
│   ├── src/lib.rs       # Rust 后端逻辑
│   ├── src/main.rs      # Tauri 入口
│   ├── tauri.conf.json  # Tauri 配置
│   └── Cargo.toml       # Rust 依赖
│
├── docs/                # 文档目录
│   ├── api-reference.md # API 参考文档
│   └── development-guide.md  # 本文档
│
└── README.md            # 项目说明
```

---

## 3. 主进程 (main.js)

### 3.1 窗口配置

主窗口在 `createWindow()` 中创建，核心配置如下：

```javascript
mainWindow = new BrowserWindow({
  width: 276,
  height: 380,
  x: screenWidth - 310,       // 定位到屏幕右下角
  y: screenHeight - 420,
  transparent: true,           // 透明背景（CSS 控制可见区域）
  frame: false,                // 无边框（自定义 UI）
  alwaysOnTop: true,           // 始终置顶
  resizable: false,            // 不可调整大小
  skipTaskbar: true,           // 不在任务栏显示
  hasShadow: false,            // 无系统阴影
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,    // 安全：禁用 Node.js
    contextIsolation: true,    // 安全：上下文隔离
  },
});
```

### 3.2 API 代理机制

主进程提供两个 HTTP 代理函数，将渲染进程的请求转发到 Harness 后端（`http://localhost:3210`）：

**proxyAPI(endpoint)** — GET 请求代理

```javascript
function proxyAPI(endpoint) {
  return new Promise((resolve) => {
    const url = `${HARNESS_API}${endpoint}`;
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300,
                    data: JSON.parse(data), status: res.statusCode });
        } catch {
          resolve({ ok: false, data: null, status: res.statusCode });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, data: null, status: 0, error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, data: null, status: 0, error: 'timeout' }); });
  });
}
```

**postAPI(endpoint, body)** — POST 请求代理

```javascript
function postAPI(endpoint, body) {
  // 与 proxyAPI 风格一致，使用字符串拼接构造 URL
  // const url = `${HARNESS_API}${endpoint}`，而非 new URL()
  // 使用 http.request + POST 方法
  // 请求体序列化为 JSON，设置 Content-Type 头
}
```

> **URL 构造说明**：`postAPI` 现在使用字符串拼接（`` `${HARNESS_API}${endpoint}` ``）构造请求 URL，与 `proxyAPI` 保持一致。此前曾使用 `new URL(endpoint, HARNESS_API)` 构造，但 `new URL` 的第二个参数作为 base 时对相对路径的解析行为可能导致端点拼接异常。字符串拼接方式更直观、更可控，消除了 base URL 末尾斜杠与端点前缀斜杠的歧义问题。

**安全校验**：`proxyAPI`、`postAPI` 和 `ipcMain.handle('proxy-api')` 三处共享同一校验逻辑，通过公共函数 `isValidEndpoint(endpoint)` 统一端点校验，避免重复代码：

```javascript
function isValidEndpoint(endpoint) {
  return typeof endpoint === 'string' && endpoint.startsWith('/api/');
}
```

三处调用点均使用 `isValidEndpoint` 进行校验：

```javascript
// proxyAPI 函数内
function proxyAPI(endpoint) {
  if (!isValidEndpoint(endpoint)) {
    return Promise.resolve({ ok: false, data: null, error: 'Endpoint not allowed' });
  }
  // ...
}

// postAPI 函数内
function postAPI(endpoint, body) {
  if (!isValidEndpoint(endpoint)) {
    return Promise.resolve({ ok: false, data: null, status: 0, error: 'Endpoint not allowed' });
  }
  // ...
}

// proxy-api IPC 处理器
ipcMain.handle('proxy-api', async (_event, endpoint) => {
  if (!isValidEndpoint(endpoint)) {
    return { ok: false, data: null, error: 'Endpoint not allowed' };
  }
  // ...
});
```

> **注意**：此前三处各自内联 `typeof endpoint !== 'string' || !endpoint.startsWith('/api/')` 校验，修改校验规则时需要同步修改三处，容易遗漏。提取 `isValidEndpoint` 后，修改一处即可全局生效。`post-api` IPC 处理器在端点校验失败时返回 `Promise.resolve({ ok: false, data: null, status: 0, error: 'Endpoint not allowed' })`，与 `proxy-api` 的同步返回格式略有差异（多了 `status: 0` 字段），但均以 `ok: false` 表示拒绝，渲染进程无需区分拒绝来源。

### 3.3 系统托盘

`createTray()` 创建系统托盘图标和右键菜单：

| 菜单项 | 功能 |
|--------|------|
| 显示伙伴 | 显示并聚焦主窗口 |
| 打开控制台 | 在浏览器中打开 `http://localhost:3210` |
| 角色状态 | 通过 `/api/agents` 查询活跃角色数 |
| 技能状态 | 通过 `/api/skills` 查询已加载技能数 |
| 退出 | 退出应用 |

单击托盘图标切换窗口显示/隐藏。

### 3.4 全局快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl+Shift+H` | 切换伙伴窗口显示/隐藏 |
| `Cmd/Ctrl+Shift+Y` | 快捷批准权限请求 |
| `Cmd/Ctrl+Shift+N` | 快捷拒绝权限请求 |

### 3.5 IPC 处理器列表

| 通道名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `proxy-api` | `endpoint: string` | `{ok, data, error?}` | 代理 API 请求（仅 `/api/` 前缀） |
| `get-companion-status` | — | `{status, version, apiConnected}` | 获取运行状态 |
| `toggle-window` | — | `void` | 切换窗口显示/隐藏 |
| `open-dashboard` | — | `void` | 打开浏览器控制台 |
| `send-command` | `cmd: string` | `{ok, data?, error?}` | 发送斜杠命令 |
| `move-window` | `dx, dy: number` | `void` | 按偏移量移动窗口 |
| `get-window-bounds` | — | `Rectangle\|null` | 获取窗口位置和尺寸 |
| `reset-position` | — | `void` | 重置到屏幕右下角 |
| `set-ignore-mouse-events` | `ignore, options` | `void` | 设置鼠标穿透 |
| `get-window-position` | — | `[x,y]\|null` | 获取窗口坐标 |
| `get-screen-size` | — | `{width, height}` | 获取屏幕尺寸 |
| `set-window-size` | `w, h: number` | `void` | 设置窗口尺寸 |
| `quit-app` | — | `void` | 退出应用 |

---

## 4. 预加载脚本 (preload.js)

### 4.1 contextBridge.exposeInMainWorld 模式

预加载脚本通过 `contextBridge.exposeInMainWorld` 将安全的 API 命名空间暴露到渲染进程的 `window` 对象上。渲染进程只能访问暴露的方法，无法直接使用 `ipcRenderer`：

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companionAPI', {
  proxyAPI: (endpoint) => ipcRenderer.invoke('proxy-api', endpoint),
  getStatus: () => ipcRenderer.invoke('get-companion-status'),
  // ...
});
```

### 4.2 暴露的 16 个 API 方法

| 方法 | IPC 通道 | 说明 |
|------|---------|------|
| `proxyAPI(endpoint)` | `proxy-api` | 代理 API 请求 |
| `getStatus()` | `get-companion-status` | 获取运行状态 |
| `toggleWindow()` | `toggle-window` | 切换窗口显示 |
| `openDashboard()` | `open-dashboard` | 打开浏览器控制台 |
| `sendCommand(cmd)` | `send-command` | 发送斜杠命令 |
| `moveWindow(dx, dy)` | `move-window` | 移动窗口 |
| `getWindowBounds()` | `get-window-bounds` | 获取窗口边界 |
| `resetPosition()` | `reset-position` | 重置窗口位置 |
| `quitApp()` | `quit-app` | 退出应用 |
| `setIgnoreMouseEvents(ignore, options)` | `set-ignore-mouse-events` | 鼠标穿透 |
| `getWindowPosition()` | `get-window-position` | 获取窗口坐标 |
| `getScreenSize()` | `get-screen-size` | 获取屏幕尺寸 |
| `setWindowSize(w, h)` | `set-window-size` | 设置窗口尺寸 |
| `onSpeech(callback)` | `companion-speech` | 监听语音事件 |
| `onPermissionRequest(callback)` | `permission-request` | 监听权限请求 |
| `onPermissionShortcut(callback)` | `permission-shortcut` | 监听权限快捷键 |

### 4.3 事件监听器防泄漏

三个事件监听方法（`onSpeech`、`onPermissionRequest`、`onPermissionShortcut`）在注册新回调前，通过 `preloadState` 对象保存的监听器引用精确移除旧监听器，确保同一事件始终只有一个回调：

```javascript
var preloadState = {
  listeners: {
    'companion-speech': null,
    'permission-request': null,
    'permission-shortcut': null,
  },
};

onSpeech: (callback) => {
  const channel = 'companion-speech';
  if (preloadState.listeners[channel]) {
    ipcRenderer.removeListener(channel, preloadState.listeners[channel]);
  }
  const handler = (_event, text) => callback(text);
  preloadState.listeners[channel] = handler;
  ipcRenderer.on(channel, handler);
},
```

> **注意**：此前使用 `ipcRenderer.removeAllListeners(channel)` 清理旧监听器，这会移除该通道上的所有监听器（包括其他模块注册的），存在误删风险。更严重的是，`ipcRenderer.removeHandler(channel)` 是用于移除 `ipcMain.handle` 注册的处理器，与 `ipcRenderer.on` 注册的监听器完全无关，调用后不会产生任何效果，属于 API 误用。

**错误写法** — 使用 `removeHandler` 清理 `ipcRenderer.on` 注册的监听器：

```javascript
onSpeech: (callback) => {
  ipcRenderer.removeHandler('companion-speech');  // 无效！removeHandler 移除的是 ipcMain.handle 的处理器
  ipcRenderer.on('companion-speech', (_event, text) => callback(text));
  // 结果：旧监听器未被移除，每次调用都新增一个，造成监听器泄漏
},
```

**正确写法** — 保存监听器引用，使用 `removeListener` 精确移除：

```javascript
onSpeech: (callback) => {
  const channel = 'companion-speech';
  if (preloadState.listeners[channel]) {
    ipcRenderer.removeListener(channel, preloadState.listeners[channel]);
  }
  const handler = (_event, text) => callback(text);
  preloadState.listeners[channel] = handler;
  ipcRenderer.on(channel, handler);
},
```

---

## 5. 渲染进程 (companion.js)

### 5.1 IIFE 封装和严格模式

整个渲染进程逻辑封装在 IIFE（立即调用函数表达式）中，启用严格模式，避免全局命名空间污染：

```javascript
(function () {
  'use strict';
  // 所有逻辑...
})();
```

### 5.2 API 桥接与回退机制

渲染进程通过 `window.companionAPI` 与主进程通信。若主进程未注入（如直接在浏览器中打开 HTML），则使用回退实现，确保渲染进程可独立运行于演示模式：

```javascript
var api = window.companionAPI || {
  proxyAPI: function () { return Promise.reject(new Error('不可用')); },
  getStatus: function () { return Promise.resolve({ status: 'demo' }); },
  // ...每个方法都有回退实现
};
```

### 5.3 核心数据结构

#### SKINS — 皮肤配置表

```javascript
var SKINS = {
  robot: { name: '经典机器人', badge: '驭',
    speech: { greet: ['你好呀！', '驭已就绪！'], click: ['嘿嘿~', '在呢在呢！', '别戳我啦~'] } },
  cat:   { name: '赛博猫咪', badge: '喵',
    speech: { greet: ['喵~你好！', '喵呜~'], click: ['喵！', '喵呜~', '别摸我！喵~'] } },
  ghost: { name: '幽灵精灵', badge: '幽',
    speech: { greet: ['呜~你好！', '飘过来了~'], click: ['呜~', '嘻嘻~'] } },
  dragon:{ name: '迷你龙', badge: '龙',
    speech: { greet: ['吼！你好！', '龙已觉醒！'], click: ['吼~', '嗷！'] } },
};
```

#### STAGES — 成长阶段定义

```javascript
var STAGES = [
  { minLevel: 1,  name: '萌芽', color: '#94a3b8' },
  { minLevel: 5,  name: '初生', color: '#34d399' },
  { minLevel: 10, name: '成长', color: '#22d3ee' },
  { minLevel: 15, name: '精英', color: '#818cf8' },
  { minLevel: 20, name: '大师', color: '#a78bfa' },
  { minLevel: 30, name: '传奇', color: '#fbbf24' },
  { minLevel: 50, name: '神话', color: '#f472b6' },
];
```

#### ACHIEVEMENTS — 成就定义表

```javascript
var ACHIEVEMENTS = {
  'first-meet':     { name: '初次见面',   desc: '首次启动桌面伙伴',       check: function(g) { return g.totalInteractions >= 1; } },
  'pet-master':     { name: '摸摸达人',   desc: '累计点击50次',           check: function(g) { return g.petCount >= 50; } },
  'drag-fly':       { name: '翱翔天际',   desc: '拖动伙伴10次',           check: function(g) { return g.dragCount >= 10; } },
  'dance-king':     { name: '舞蹈之王',   desc: '跳舞5次',               check: function(g) { return g.danceCount >= 5; } },
  'level5':         { name: '初露锋芒',   desc: '达到5级',               check: function(g) { return g.level >= 5; } },
  'level10':        { name: '茁壮成长',   desc: '达到10级',              check: function(g) { return g.level >= 10; } },
  'level20':        { name: '精英战士',   desc: '达到20级',              check: function(g) { return g.level >= 20; } },
  'skin-collector': { name: '形象收藏家', desc: '切换过所有4种形象',      check: function(g) { return g.skinsUsed && g.skinsUsed.length >= 4; } },
  'roamer':         { name: '漫游者',     desc: '自由漫游3次',           check: function(g) { return g.roamCount >= 3; } },
  'night-owl':      { name: '夜猫子',     desc: '在深夜(22:00-6:00)使用', check: function(g) { var h = new Date().getHours(); return h >= 22 || h < 6; } },
  'file-receiver':  { name: '文件接收者', desc: '拖放文件到伙伴上',       check: function(g) { return g.fileDropCount >= 1; } },
  'perm-approver':  { name: '权限审批者', desc: '批准3次权限请求',        check: function(g) { return g.permApproved >= 3; } },
  'early-bird':     { name: '早起鸟儿',   desc: '在早晨(6:00-9:00)使用',  check: function(g) { var h = new Date().getHours(); return h >= 6 && h < 9; } },
};
```

#### AI_STATES — AI 状态配置表

```javascript
var AI_STATES = {
  idle:         { label: '待机',   bodyClass: '',              mouthClass: '',              speech: null },
  thinking:     { label: '思考中', bodyClass: 'ai-thinking',   mouthClass: 'mouth thinking', speech: '让我想想...' },
  typing:       { label: '打字中', bodyClass: 'ai-typing',     mouthClass: 'mouth happy',    speech: '正在编写代码...' },
  building:     { label: '建造中', bodyClass: 'ai-building',   mouthClass: 'mouth',          speech: '正在构建...' },
  juggling:     { label: '杂耍中', bodyClass: 'idle-juggle',   mouthClass: 'mouth happy',    speech: '子代理工作中...' },
  conducting:   { label: '指挥中', bodyClass: 'ai-conducting', mouthClass: 'mouth happy',    speech: '多代理协作中...' },
  error:        { label: '报错',   bodyClass: 'ai-error',      mouthClass: 'mouth sad',      speech: '出错了...' },
  happy:        { label: '完成',   bodyClass: 'ai-happy',      mouthClass: 'mouth happy',    speech: '任务完成！' },
  notification: { label: '通知',   bodyClass: 'ai-notification', mouthClass: 'mouth surprised', speech: '有新消息！' },
};
```

#### SPEECH — 语音台词配置表

覆盖 30+ 场景的语音台词，每个场景对应一个字符串数组，`showSpeech()` 从中随机选取一条显示：

```javascript
var SPEECH = {
  greet: ['你好呀！', '嗨！需要帮忙吗？', '驭已就绪！', '随时待命！'],
  greetMorning: ['早上好！新的一天开始了~', ...],
  click: ['嘿嘿~', '在呢在呢！', '有什么事？', '别戳我啦~'],
  // ... 30+ 场景
};
```

#### state — 全局运行时状态

```javascript
var state = {
  apiConnected: false,     // API 连接状态
  currentAgent: null,      // 当前活跃 Agent ID
  mood: 'happy',           // 心情模式（happy/calm/energetic）
  isIdle: false,           // 是否空闲
  sleepStage: 0,           // 睡眠阶段（0-4）
  isDragging: false,       // 是否拖拽中
  currentSkin: 'robot',    // 当前皮肤
  isRoaming: false,        // 是否漫游中
  aiState: 'idle',         // 当前 AI 状态
  dndMode: false,          // 免打扰模式
  minimalMode: false,      // 迷你模式
  clickThroughEnabled: false, // 点击穿透
  growth: {                // 成长数据
    level: 1, xp: 0, totalXp: 0,
    totalInteractions: 0, petCount: 0,
    dragCount: 0, danceCount: 0, roamCount: 0,
    skinsUsed: ['robot'], achievements: [],
    fileDropCount: 0, permApproved: 0, permDenied: 0,
  },
  // ... 更多状态字段
};
```

#### els — DOM 元素缓存

```javascript
var els = {};  // 在 init() 中批量获取并缓存
```

### 5.4 初始化流程

`init()` 函数是桌面伙伴的核心入口，执行 9 步初始化流程：

```
步骤 1: loadSettings()           — 从 localStorage 加载持久化设置
步骤 2: DOM 元素缓存             — 批量获取 50+ 个 DOM 元素引用到 els
步骤 3: 应用已保存的皮肤样式      — 恢复 CSS 类和品牌徽标
步骤 4: 创建交互系统             — 粒子/眼球追踪/眨眼/拖拽/右键菜单/点击/面板等
步骤 5: 启动 API 轮询            — startApiPolling() + 恢复窗口位置
步骤 6: 应用心情 & 更新成长 UI    — setMood() / updateGrowthUI() / checkAchievements()
步骤 7: 恢复模式状态             — 漫游/迷你/免打扰/穿透模式
步骤 8: 延时显示问候语           — 500ms 后显示时段问候 + 入场动画
步骤 9: 启动定时任务             — 60s 间隔时间主题切换 + 5s 间隔窗口位置保存
```

### 5.5 拖动系统

`setupDrag()` 实现伙伴窗口的拖拽移动，包含三个阶段：

**阶段 1: mousedown — 记录起始状态**

```javascript
els.companion.addEventListener('mousedown', function (e) {
  startX = e.screenX; startY = e.screenY;
  state.dragStartPos = { x: e.screenX, y: e.screenY };
  state.isDragging = false;
  stopRoaming();  // 拖拽时停止漫游
  // 启动 800ms 长按计时器（未拖动则触发抱抱）
  state.longPressTimer = setTimeout(function () {
    if (!state.isDragging) { triggerHug(); }
  }, 800);
});
```

**阶段 2: mousemove — 拖拽移动**

```javascript
document.addEventListener('mousemove', function (e) {
  if (!state.dragStartPos) return;
  var dist = Math.sqrt(dx * dx + dy * dy);
  if (!state.isDragging && dist > DRAG_THRESHOLD) {  // 5px 阈值
    state.isDragging = true;
    clearTimeout(state.longPressTimer);  // 取消长按
    els.companion.classList.add('dragging');
    // 添加拖拽光环和倾斜动画
  }
  if (state.isDragging) {
    // 根据移动方向添加倾斜动画
    api.moveWindow(e.screenX - startX, e.screenY - startY);
  }
});
```

**阶段 3: mouseup — 落地弹跳**

```javascript
document.addEventListener('mouseup', function () {
  if (state.isDragging) {
    els.body.classList.add('drop-bounce');  // 弹跳动画
    spawnBurstParticles(3);                // 粒子效果
    state.growth.dragCount++;
    addXP(3, '拖动');
    checkEdgePosition();  // 检测是否贴边
  }
  state.isDragging = false;
  state.dragStartPos = null;
});
```

### 5.6 AI 状态机

`setAIState(newState)` 是核心状态切换函数：

```javascript
function setAIState(newState) {
  if (state.aiState === newState) return;  // 相同状态不重复切换
  state.prevAiState = state.aiState;
  state.aiState = newState;
  clearAIState();  // 清除所有旧状态样式

  var cfg = AI_STATES[newState];
  if (cfg.bodyClass) els.body.classList.add(cfg.bodyClass);
  if (cfg.mouthClass) els.mouth.className = cfg.mouthClass;

  // 状态专属特效
  if (newState === 'thinking') els.thoughtBubble.classList.add('visible');
  if (newState === 'error') { els.sweatDrop.classList.add('visible'); playSound('error'); }
  if (newState === 'happy') { spawnConfetti(10); playSound('success'); }
  if (newState === 'notification') { els.notificationSign.classList.add('visible'); playSound('perm'); }

  if (cfg.speech && !state.dndMode) showSpeech(cfg.speech, 3000);
  updateHUD();
  if (newState !== 'idle') addXP(3, 'AI状态: ' + cfg.label);
}
```

`clearAIState()` 清除所有 AI 状态的视觉样式：

```javascript
function clearAIState() {
  Object.keys(AI_STATES).forEach(function (key) {
    if (AI_STATES[key].bodyClass) els.body.classList.remove(AI_STATES[key].bodyClass);
  });
  els.thoughtBubble.classList.remove('visible');
  els.sweatDrop.classList.remove('visible');
  els.exclaim.classList.remove('visible');
  els.notificationSign.classList.remove('visible');
  els.leftEye.classList.remove('star-eye', 'squint-eye', 'wide-eye');
  els.rightEye.classList.remove('star-eye', 'squint-eye', 'wide-eye');
}
```

### 5.7 成长系统

**addXP(amount, reason)** — 核心成长函数

```javascript
function addXP(amount, reason) {
  state.growth.xp += amount;
  state.growth.totalXp += amount;
  state.growth.totalInteractions++;
  var needed = xpForLevel(state.growth.level);  // 80 * 1.25^(lv-1)
  while (state.growth.xp >= needed) {
    state.growth.xp -= needed;
    state.growth.level++;
    needed = xpForLevel(state.growth.level);
    onLevelUp();  // 升级处理
  }
  updateGrowthUI();
  saveSettings();
  checkAchievements();  // 注意：checkAchievements 内部有重入守卫，防止无限递归
  if (reason) logEvent(reason + ' (+' + amount + 'XP)', 'xp');
}
```

**xpForLevel(lv)** — 升级所需经验值公式

```javascript
function xpForLevel(lv) { return Math.floor(80 * Math.pow(1.25, lv - 1)); }
```

| 等级 | 所需 XP | 等级 | 所需 XP |
|------|---------|------|---------|
| 1 | 80 | 10 | 596 |
| 5 | 195 | 20 | 5,799 |
| 10 | 596 | 50 | 361,108 |

**onLevelUp()** — 升级处理

触发语音提示、Toast 通知、升级音效、升级覆盖层动画、五彩纸屑和粒子爆发效果。

**checkAchievements()** — 成就检查

遍历所有成就定义，对未解锁的成就执行检查函数。达成时奖励 20XP 并弹出提示。免打扰模式下仅解锁不提示。使用重入守卫 `checkingAchievements` 防止 `addXP` → `checkAchievements` 的无限递归。

### 5.8 闲置检测

**resetIdle()** — 重置空闲计时器

用户有任何活动（鼠标移动/点击/键盘）时调用。若当前处于空闲状态则唤醒伙伴，若之前深度睡眠则播放惊醒动画。

**onIdle()** — 空闲状态处理（4 阶段睡眠）

| 阶段 | 触发时间 | 行为 |
|------|---------|------|
| 1 - 空闲 | 60s 无操作 | 显示空闲语音，每 12s 循环空闲动作 |
| 2 - 浅睡 | 30s 后 | 停止空闲动作，添加 `sleep-dozing` 类 |
| 3 - 深睡 | 45s 后 | 添加 `sleep-collapsed` 类，显示 ZZZ |
| 4 - 熟睡 | 70s 后 | 添加 `sleep-deep` 类，降低亮度 |

### 5.9 API 轮询

**startApiPolling()** — 启动 API 轮询

```javascript
function startApiPolling() {
  function poll() {
    api.proxyAPI('/api/health').then(function (res) {
      if (res && res.ok) {
        updateConnectionStatus(true);
        pollAgentStatus();           // 同步轮询 Agent 状态
        if (state.panelOpen) refreshPanelData();  // 面板打开时刷新
      } else {
        updateConnectionStatus(false);
      }
    }).catch(function () { updateConnectionStatus(false); });
  }
  poll();
  setInterval(poll, state.pollInterval);  // 默认 5 秒间隔
}
```

**pollAgentStatus()** — 轮询 Agent 状态

请求 `/api/agents`，2 个以上活跃 Agent 切换为指挥状态，1 个活跃 Agent 显示激活通知。

**updateConnectionStatus(connected)** — 更新连接状态

```javascript
function updateConnectionStatus(connected) {
  state.apiConnected = connected;
  if (connected) {
    els.statusDot.classList.add('connected');
    setMood(state.mood);  // 尊重当前心情设置
  } else {
    els.statusDot.classList.remove('connected');
  }
  updateHUD();
}
```

> **变更原因**：此前连接成功时强制设置 `els.mouth.className = 'mouth happy'`，无论用户当前选择的心情模式（calm/energetic 等），连接恢复后嘴巴都会被重置为 happy 表情。现在改为调用 `setMood(state.mood)`，连接状态变化时尊重当前心情设置，保持用户选择的心情表达。

### 5.10 定时器管理

所有 `setInterval` 调用均保存引用到 `state.intervals` 数组，便于统一清理，防止内存泄漏：

```javascript
var id = setInterval(function () {
  // 定时任务逻辑
}, interval);
state.intervals.push(id);
```

清理时遍历数组逐一清除：

```javascript
function clearAllIntervals() {
  if (state.intervals) {
    state.intervals.forEach(function (id) { clearInterval(id); });
    state.intervals = [];
  }
}
```

> **规范**：任何新增的 `setInterval` 必须将返回的 ID 推入 `state.intervals`，禁止创建无引用的定时器。

### 5.11 漫游系统

漫游功能让伙伴在屏幕上自主移动。漫游步进定时器 `walkInterval` 保存到 `state.roamWalkInterval`，确保 `stopRoaming()` 时可精确清理：

```javascript
function startRoaming() {
  state.isRoaming = true;
  state.roamWalkInterval = setInterval(function () {
    // 计算随机方向，调用 api.moveWindow() 移动
    // 检测屏幕边界，自动反弹
  }, 100);  // 100ms 步进间隔
  state.intervals.push(state.roamWalkInterval);
}

function stopRoaming() {
  state.isRoaming = false;
  if (state.roamWalkInterval) {
    clearInterval(state.roamWalkInterval);
    state.roamWalkInterval = null;
  }
}
```

`stopRoaming()` 在拖拽开始、手动停止等场景下调用，确保漫游定时器被正确清理。

**scheduleRoamStep — 漫游步进调度**

`scheduleRoamStep()` 控制每一步漫游的行走动画与实际移动的时序关系：

- 行走 CSS 类（`walking`、`facing-left` / `facing-right`）在实际行走开始时添加（`setTimeout` 回调内），暂停期间不显示行走动画
- 行走结束后立即移除行走类（`walking`）和朝向类（`facing-left` / `facing-right`），确保伙伴在暂停间隔中恢复静止姿态

```javascript
function scheduleRoamStep() {
  // 计算随机暂停时长和行走时长
  var pauseMs = /* 随机暂停 */ ;
  var walkMs = /* 随机行走 */ ;
  state.roamPauseTimeout = setTimeout(function () {
    // 实际行走开始时才添加行走CSS类
    els.body.classList.add('walking');
    els.body.classList.add(dx < 0 ? 'facing-left' : 'facing-right');
    // 执行移动...
    state.roamWalkTimeout = setTimeout(function () {
      // 行走结束后立即移除行走类和朝向类
      els.body.classList.remove('walking');
      els.body.classList.remove('facing-left', 'facing-right');
      scheduleRoamStep();  // 调度下一步
    }, walkMs);
  }, pauseMs);
}
```

> **变更原因**：此前行走 CSS 类在 `scheduleRoamStep` 入口处立即添加，导致暂停期间也显示行走动画，视觉上伙伴在原地踏步。现在将行走类的添加延迟到 `setTimeout` 回调内（实际行走开始时），暂停期间伙伴保持静止姿态，行走结束后立即清除所有行走相关类，动画与实际移动完全同步。

### 5.12 checkEdgePosition — 边缘检测

`checkEdgePosition()` 在伙伴拖放后检测是否贴边，使用 `Promise.all` 并行请求窗口位置和屏幕尺寸，替代嵌套 Promise 调用，并添加 `.catch` 错误处理：

```javascript
function checkEdgePosition() {
  Promise.all([
    api.getWindowPosition(),
    api.getScreenSize()
  ]).then(function (results) {
    var pos = results[0];
    var screen = results[1];
    if (!pos || !screen) return;
    // 检测是否贴边，添加贴边吸附效果
    var edgeClass = detectEdge(pos, screen);
    if (edgeClass) els.companion.classList.add(edgeClass);
  }).catch(function () {
    // 静默处理：位置检测失败不影响主流程
  });
}
```

> **模式**：避免嵌套 Promise（如 `api.getWindowPosition().then(function () { api.getScreenSize().then(...) })`），使用 `Promise.all` 并行请求提升效率，同时保证 `.catch` 捕获任一请求的失败。

### 5.13 restoreWindowPosition — 恢复窗口位置

`restoreWindowPosition()` 在初始化时从 `localStorage` 读取上次保存的窗口坐标，使用 `Promise.all` 并行请求当前窗口位置和屏幕尺寸，验证坐标有效后移动窗口到保存的位置：

```javascript
function restoreWindowPosition() {
  try {
    var pos = JSON.parse(localStorage.getItem('companion-window-pos') || 'null');
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      Promise.all([
        api.getWindowPosition(),
        api.getScreenSize()
      ]).then(function (results) {
        var current = results[0];
        var screen = results[1];
        if (!screen) return;
        if (current && current[0] === pos.x && current[1] === pos.y) return;
        if (pos.x >= 0 && pos.x < screen.width - 50 &&
            pos.y >= 0 && pos.y < screen.height - 50) {
          api.moveWindow(pos.x - (current ? current[0] : 0),
                         pos.y - (current ? current[1] : 0));
        }
      }).catch(function () {
        // 静默处理：位置恢复失败不影响主流程
      });
    }
  } catch {}
  // 同时启动 5s 间隔定时器，持续保存窗口位置
}
```

> **模式**：与 `checkEdgePosition` 一致，使用 `Promise.all` 并行请求窗口位置和屏幕尺寸，替代嵌套 Promise 调用，并添加 `.catch` 错误处理。避免嵌套 Promise（如 `api.getWindowPosition().then(function () { api.getScreenSize().then(...) })`），提升效率并保证错误捕获。

### 5.14 setMood — 心情设置

`setMood(mood)` 设置伙伴的心情模式（happy/calm/energetic），不再依赖 `apiConnected` 条件，无论 API 连接状态如何都设置嘴巴表情：

```javascript
function setMood(mood) {
  state.mood = mood;
  // 始终设置嘴巴表情，不检查 apiConnected
  if (mood === 'happy') { els.mouth.className = 'mouth happy'; }
  else if (mood === 'calm') { els.mouth.className = 'mouth calm'; }
  else if (mood === 'energetic') { els.mouth.className = 'mouth happy'; }
  // 其他心情相关样式...
}
```

> **变更原因**：此前 `setMood` 仅在 `apiConnected === true` 时设置嘴巴表情，导致离线/演示模式下伙伴始终无表情。移除该条件后，伙伴在任何连接状态下都能正确表达心情。

### 5.15 特效系统

| 函数 | 说明 | 生命周期 |
|------|------|---------|
| `spawnBurstParticles(count)` | 圆形爆发粒子，颜色随皮肤 | 0.7s 后移除 |
| `spawnConfetti(count)` | 五彩纸屑，7 种颜色 | 3s 后移除 |
| `spawnBubbles(count)` | 上升气泡 | 4s 后移除 |
| `spawnFx(type)` | 通用特效（rainbow/music/sparkle/hearts） | 1.5-3s 后移除 |
| `spawnJuggleBalls()` | 3 个杂耍球 | 3s 后自动移除 |
| `spawnRipple(x, y)` | 点击涟漪 | 0.6s 后移除 |
| `clearFx()` | 清除所有特效和动画状态 | 立即 |

> **spawnJuggleBalls 修复说明**：杂耍球现在使用 IIFE 包裹每次循环迭代（与 `spawnBurstParticles`、`spawnConfetti`、`spawnBubbles` 一致），并为每个球添加 3 秒自动移除的 `setTimeout`。此前杂耍球仅在 `clearFx()` 或 AI 状态切换时清除，若未触发清除逻辑，杂耍球会在特效层中无限累积，导致 DOM 节点持续增长和视觉叠加。修复后每个球在 3 秒后自动从 DOM 中移除，不再依赖外部清除调用。

### 5.16 粒子系统闭包模式

`spawnBurstParticles`、`spawnConfetti`、`spawnBubbles` 三个粒子函数在 `for` 循环中创建 DOM 元素，并通过 `setTimeout` 延迟移除。由于项目使用 `var` 声明（ES5 风格，无块级作用域），`var` 声明的 DOM 元素变量具有函数作用域，`setTimeout` 回调中的引用会被后续循环迭代覆盖，导致所有回调最终操作的是同一个（最后一次迭代的）元素。

**错误写法** — `var` 在 `for` 循环中无法为每次迭代创建独立绑定：

```javascript
function spawnBurstParticles(count) {
  for (var i = 0; i < count; i++) {
    var particle = document.createElement('div');  // var 无块级作用域
    particle.className = 'burst-particle';
    particle.style.setProperty('--angle', (360 / count * i) + 'deg');
    els.fxContainer.appendChild(particle);
    setTimeout(function () {
      // BUG: particle 始终指向最后一次迭代的元素
      if (particle && particle.parentNode) {
        particle.parentNode.removeChild(particle);
      }
    }, 700);
  }
}
```

**正确写法** — 使用 IIFE 包裹每次循环迭代，确保每个 `setTimeout` 回调捕获独立的 DOM 元素引用：

```javascript
function spawnBurstParticles(count) {
  for (var i = 0; i < count; i++) {
    (function (idx) {
      var particle = document.createElement('div');
      particle.className = 'burst-particle';
      particle.style.setProperty('--angle', (360 / count * idx) + 'deg');
      els.fxContainer.appendChild(particle);
      setTimeout(function () {
        if (particle && particle.parentNode) {
          particle.parentNode.removeChild(particle);
        }
      }, 700);
    })(i);
  }
}
```

> **原理**：IIFE 在每次迭代时创建一个新的函数作用域，`particle` 变量在该作用域内声明，`setTimeout` 回调通过闭包捕获的是当前迭代的独立引用，不会被后续循环覆盖。`spawnConfetti` 和 `spawnBubbles` 采用相同的 IIFE 模式修复。

### 5.17 权限卡片

**showPermissionCard(agent, action)** — 显示权限审批卡片

```javascript
function showPermissionCard(agent, action) {
  els.permAgent.textContent = agent;
  els.permAction.textContent = action;
  els.permissionCard.classList.add('visible');
  setAIState('notification');        // 切换到通知状态
  els.notificationSign.classList.add('visible');
  addXP(3, '权限请求');
  // 30 秒超时自动拒绝
  state.permTimeout = setTimeout(function () {
    if (els.permissionCard.classList.contains('visible')) {
      hidePermissionCard();
      showToast('权限请求超时已自动拒绝', 'warning');
    }
  }, 30000);
}
```

**hidePermissionCard()** — 隐藏权限卡片

移除卡片和通知标志的可见状态，清除超时定时器，恢复 AI 状态为空闲。

### 5.18 音效系统

`playSound(type)` 使用 Web Audio API 合成简短提示音，复用单个 `AudioContext` 实例。音效参数通过配置表管理，新增音效类型只需在 `SOUND_CONFIG` 中添加条目：

```javascript
var SOUND_CONFIG = {
  click: { freq: 800, gain: 0.04 },
  levelup: { freq: 523, gain: 0.08 },
  error: { freq: 200, gain: 0.05 },
  success: { freq: 660, gain: 0.06 },
  perm: { freq: 440, gain: 0.07 },
};
var SOUND_DEFAULT = { freq: 600, gain: 0.04 };

function playSound(type) {
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') { audioCtx.resume(); }
    var cfg = SOUND_CONFIG[type] || SOUND_DEFAULT;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.value = cfg.gain;
    osc.frequency.value = cfg.freq;
    osc.start();
    setTimeout(function () { osc.stop(); }, type === 'levelup' ? 400 : 120);
  } catch {}
}
```

| 音效类型 | 频率 | 增益 | 持续时间 |
|---------|------|------|---------|
| click | 800Hz | 0.04 | 120ms |
| levelup | 523→659→784Hz | 0.08 | 400ms（三连音） |
| error | 200Hz | 0.05 | 120ms |
| success | 660Hz | 0.06 | 120ms |
| perm | 440Hz | 0.07 | 120ms |
| 默认 | 600Hz | 0.04 | 120ms |

### 5.19 时间感知

**getTimeGreeting()** — 获取时段问候语

| 时段 | 时间范围 | 问候语来源 |
|------|---------|-----------|
| 早晨 | 6:00-12:00 | `SPEECH.greetMorning` |
| 午后 | 12:00-18:00 | `SPEECH.greetNoon` |
| 傍晚 | 18:00-22:00 | `SPEECH.greetEvening` |
| 深夜 | 22:00-6:00 | `SPEECH.greetNight` |

**applyTimeTheme()** — 应用时段主题

在 `<html>` 元素上添加对应 CSS 类（`time-morning` / `time-afternoon` / `time-evening` / `time-night`），每 60 秒自动调用。

---

## 6. 样式系统 (companion.css)

### 6.1 CSS 自定义属性体系

样式系统基于 `:root` 定义的 CSS 自定义属性，实现零刷新换肤。核心变量分为以下几组：

**颜色变量**

```css
:root {
  --primary: #818cf8;
  --primary-light: #c7d2fe;
  --primary-deep: #6366f1;
  --success: #34d399;
  --warning: #fbbf24;
  --danger: #f87171;
  --purple: #a78bfa;
  --cyan: #22d3ee;
  --pink: #f472b6;
  /* ... glow 变量 */
}
```

**皮肤变量（零刷新换肤的关键）**

```css
:root {
  --skin-accent: var(--primary);
  --skin-accent-light: var(--primary-light);
  --skin-accent-deep: var(--primary-deep);
  --skin-glow: var(--primary-glow);
  --skin-glow-soft: var(--primary-glow-soft);
  --skin-surface: var(--surface);
  --skin-surface2: var(--surface2);
  --skin-border: rgba(129,140,248,.18);
  --skin-border-hover: rgba(129,140,248,.32);
  --skin-border-dim: rgba(129,140,248,.1);
  --skin-cheek: rgba(244,114,182,.28);
  --skin-drop-shadow: rgba(129,140,248,.2);
}
```

**动画缓动变量**

```css
:root {
  --t-fast: .15s cubic-bezier(.4,0,.2,1);
  --t-smooth: .3s cubic-bezier(.4,0,.2,1);
  --t-spring: .5s cubic-bezier(.34,1.56,.64,1);
  --t-bounce: .6s cubic-bezier(.68,-.55,.265,1.55);
  --t-elegant: .7s cubic-bezier(.32,.72,0,1);
}
```

### 6.2 4 种皮肤 CSS 覆盖机制

每种皮肤通过在 `#companion` 元素上添加 CSS 类（如 `skin-cat`），覆盖 `--skin-*` 变量实现换肤。由于所有组件样式都引用 `--skin-*` 变量，换肤时无需刷新页面：

```css
/* 机器人（默认） */
.skin-robot {
  --skin-accent: #818cf8;
  --skin-accent-light: #c7d2fe;
  --skin-surface: rgba(15,23,42,.92);
  /* ... */
}

/* 猫咪 */
.skin-cat {
  --skin-accent: #34d399;
  --skin-accent-light: #a7f3d0;
  --skin-surface: rgba(6,30,20,.92);
  /* ... */
  /* 还可以覆盖形状（border-radius、width 等） */
}
.skin-cat .companion-head { border-radius: 32px 32px 20px 20px; }
.skin-cat .eye { border-radius: 50% 50% 50% 50% / 60% 60% 40% 40%; }
```

皮肤还可以覆盖结构元素（隐藏天线、添加猫耳/龙角/幽灵尾迹等）：

```css
.skin-cat .antenna-stick { width: 0; height: 0; }   /* 隐藏天线杆 */
.skin-cat .antenna-ball { display: none; }            /* 隐藏天线球 */
.skin-cat .companion-antenna::before,                 /* 添加猫耳 */
.skin-cat .companion-antenna::after { /* 三角形猫耳 */ }

.skin-ghost .companion-feet { display: none; }        /* 幽灵无脚 */
.skin-ghost .shadow { opacity: .3; }                  /* 半透明阴影 */
```

### 6.3 时间主题 CSS 类

通过在 `<html>` 元素上添加时间类，调整整体色调氛围：

```css
:root.time-morning { --time-ambient: rgba(251,191,36,.08); --time-glow: rgba(251,191,36,.15); }
:root.time-afternoon { --time-ambient: rgba(34,211,238,.06); --time-glow: rgba(34,211,238,.12); }
:root.time-evening { --time-ambient: rgba(248,113,113,.08); --time-glow: rgba(248,113,113,.15); }
:root.time-night { --time-ambient: rgba(129,140,248,.1); --time-glow: rgba(129,140,248,.18); }

:root.time-morning .companion-body {
  filter: brightness(1.03) saturate(1.05);
}
:root.time-afternoon .companion-body {
  filter: brightness(1.02) saturate(1.02);
}
:root.time-evening .companion-body {
  filter: brightness(.97) saturate(1.05);
}
:root.time-night .companion-body {
  filter: brightness(.92) saturate(.85);
}

:root.time-morning .companion-body:hover,
:root.time-afternoon .companion-body:hover,
:root.time-evening .companion-body:hover,
:root.time-night .companion-body:hover {
  filter: none;
}
```

`--time-ambient` 和 `--time-glow` 变量被以下组件引用，实现时段氛围的视觉联动：

| 变量 | 使用组件 | 效果 |
|------|---------|------|
| `--time-ambient` | `.ambient-ring` | 伙伴周围的环境光环，颜色和透明度随时段变化 |
| `--time-glow` | `.aura` | 伙伴身体外围的辉光层，提供柔和的时段色调 |

```css
.ambient-ring {
  background: radial-gradient(circle, var(--time-ambient), transparent 70%);
}

.aura {
  box-shadow: 0 0 30px var(--time-glow), 0 0 60px var(--time-glow);
}
```

> **变更说明**：时间主题的 CSS 选择器从此前的 `.skin-robot .ambient-ring` 改为 `.ambient-ring`，现在所有皮肤都会受到时间主题影响，而非仅限机器人皮肤。此外，所有 4 个时段现在都有对应的 `companion-body` filter 效果（morning: `brightness(1.03) saturate(1.05)`、afternoon: `brightness(1.02) saturate(1.02)`、evening: `brightness(.97) saturate(1.05)`、night: `brightness(.92) saturate(.85)`），此前仅夜间时段有 filter。悬停时 filter 恢复为 `none`，确保交互时伙伴显示原始色彩。

### 6.4 动画系统

CSS 文件包含 30+ 关键帧动画，按功能分类：

**基础动画**

| 动画名 | 用途 | 周期 |
|--------|------|------|
| `float` | 默认悬浮 | 3.5s |
| `bounce` | 点击兴奋 | 0.45s |
| `entrance-pop` | 入场弹出 | 0.8s |
| `drop-bounce` | 落地弹跳 | 0.6s |
| `spin-around` | 旋转 | 0.8s |
| `skin-morph` | 换装变形 | 0.5s |

**AI 状态动画**

| 动画名 | 对应状态 |
|--------|---------|
| `ai-think-bob` | thinking |
| `ai-type-arm` | typing |
| `ai-build-bob` | building |
| `ai-error-sag` | error |
| `ai-happy-bounce` | happy |
| `ai-notify-bob` | notification |
| `ai-conducting` | conducting |

**空闲动作动画**

| 动画名 | 动作 |
|--------|------|
| `idle-yawn` | 打哈欠 |
| `idle-stretch` | 伸懒腰 |
| `idle-breathe` | 呼吸 |
| `idle-think` | 思考 |
| `idle-nod` | 点头 |
| `idle-peek` | 偷看 |
| `idle-sweep` | 扫地 |
| `idle-juggle` | 杂耍 |
| `idle-carry` | 搬运 |

**睡眠动画**

| 动画名 | 阶段 |
|--------|------|
| `sleep-bob` | 基础睡眠摆动 |
| `sleep-dozing` | 浅睡 |
| `sleep-collapsed` | 深睡 |
| `sleep-deep` | 熟睡 |
| `wake-up-startle` | 惊醒 |

**特效动画**

| 动画名 | 特效 |
|--------|------|
| `fx-dance` | 跳舞 |
| `fx-sing-bob` | 唱歌 |
| `fx-magic-pulse` | 魔术 |
| `fx-jump` | 跳跃 |
| `fx-shake` | 摇晃 |
| `fx-bow` | 鞠躬 |
| `fx-celebrate` | 庆祝 |
| `fx-tremble` | 发抖 |
| `fx-confetti-fall` | 纸屑飘落 |
| `fx-bubble-rise` | 气泡上升 |
| `fx-rainbow-spin` | 彩虹旋转 |
| `burst-out` | 粒子爆发 |
| `ripple-expand` | 涟漪扩散 |

### 6.5 响应式和模式 CSS

**迷你模式 (minimal)**

```css
#companion.minimal .companion-scene {
  transform: scale(.45);
  filter: brightness(.8) saturate(.7);
}
#companion.minimal:hover .companion-scene {
  transform: scale(1);          /* 悬停恢复 */
  filter: brightness(1) saturate(1);
}
#companion.minimal .xp-bar-container,
#companion.minimal .status-bar,
#companion.minimal .speech-bubble,
#companion.minimal .hud { opacity: 0; pointer-events: none; }
```

**免打扰模式 (dnd)**

```css
#companion.dnd .speech-bubble,
#companion.dnd .toast-container { display: none; }
#companion.dnd .companion-body { filter: brightness(.85) saturate(.6); }
```

**点击穿透模式 (clickthrough)**

```css
#companion.clickthrough .clickthrough-indicator { opacity: .7; }
```

---

## 7. 扩展指南

### 7.1 添加新形象

以添加"狐狸"形象为例：

**步骤 1：在 SKINS 中添加配置**

```javascript
// companion.js
var SKINS = {
  // ... 现有皮肤
  fox: { name: '灵狐', badge: '狐',
    speech: { greet: ['呜~你好！', '灵狐来也！'], click: ['呜~', '嘻嘻~'] } },
};
```

**步骤 2：在 CSS 中添加皮肤覆盖**

```css
/* companion.css */
.skin-fox {
  --skin-accent: #fb923c;
  --skin-accent-light: #fed7aa;
  --skin-accent-deep: #ea580c;
  --skin-glow: rgba(251,146,60,.35);
  --skin-glow-soft: rgba(251,146,60,.12);
  --skin-surface: rgba(40,20,5,.92);
  --skin-surface2: rgba(60,35,15,.78);
  --skin-border: rgba(251,146,60,.2);
  --skin-border-hover: rgba(251,146,60,.35);
  --skin-border-dim: rgba(251,146,60,.1);
  --skin-cheek: rgba(251,146,60,.3);
  --skin-drop-shadow: rgba(251,146,60,.2);
}

.skin-fox .companion-head { border-radius: 28px 28px 18px 18px; }
.skin-fox .eye { /* 狐狸眼形状 */ }
.skin-fox .pupil { /* 竖瞳 */ }
```

**步骤 3：在 HTML 中添加菜单项**

```html
<div class="menu-item" data-action="skin-fox">🦊 灵狐</div>
```

**步骤 4：在 handleMenuAction 中添加处理**

```javascript
case 'skin-fox': switchSkin('fox'); break;
```

**步骤 5：更新粒子颜色**

在 `createParticles()` 的 `skinColors` 对象中添加狐狸配色：

```javascript
fox: ['var(--warning)', '#fb923c', '#fed7aa', '#fdba74', 'var(--primary-light)'],
```

### 7.2 添加新动画

以添加"后空翻"动画为例：

**步骤 1：在 CSS 中定义关键帧**

```css
.companion-body.fx-backflip {
  animation: fx-backflip 1s cubic-bezier(.34,1.56,.64,1) !important;
}

@keyframes fx-backflip {
  0% { transform: translateY(0) rotate(0deg) scale(1); }
  30% { transform: translateY(-25px) rotate(180deg) scale(1.05); }
  70% { transform: translateY(-10px) rotate(340deg) scale(1.02); }
  100% { transform: translateY(0) rotate(360deg) scale(1); }
}
```

**步骤 2：在 JS 中添加触发函数**

```javascript
function triggerBackflip() {
  clearFx(); clearAIState();
  els.body.classList.add('fx-backflip');
  showSpeech('后空翻！', 2000);
  spawnBurstParticles(6);
  addXP(6, '后空翻');
  state.actionTimeout = setTimeout(function () { clearFx(); setMood(state.mood); }, 1000);
}
```

**步骤 3：在 HTML 菜单和 handleMenuAction 中注册**

```html
<div class="menu-item" data-action="backflip">🤸 后空翻</div>
```

```javascript
case 'backflip': triggerBackflip(); break;
```

**步骤 4：在 clearFx 中添加清理**

```javascript
els.body.classList.remove('fx-backflip');
```

### 7.3 添加新成就

**步骤 1：在 ACHIEVEMENTS 中添加定义**

```javascript
var ACHIEVEMENTS = {
  // ... 现有成就
  'backflip-master': { name: '后空翻大师', desc: '完成后空翻10次',
    check: function(g) { return g.backflipCount >= 10; } },
};
```

**步骤 2：在 state.growth 中添加统计字段**

```javascript
growth: {
  // ... 现有字段
  backflipCount: 0,
}
```

**步骤 3：在触发函数中增加计数**

```javascript
function triggerBackflip() {
  state.growth.backflipCount++;
  // ...
}
```

**步骤 4：在 HTML 中添加成就 DOM 元素**

```html
<div class="achievement locked" id="ach-backflip-master">🤸 后空翻大师</div>
```

**步骤 5：在 loadSettings / saveSettings 中添加字段**

```javascript
// loadSettings
state.growth.backflipCount = g.backflipCount || 0;
// saveSettings 已通过 growth 对象整体序列化，无需额外修改
```

### 7.4 添加新 AI 状态

**步骤 1：在 AI_STATES 中添加配置**

```javascript
var AI_STATES = {
  // ... 现有状态
  reviewing: { label: '审查中', bodyClass: 'ai-reviewing',
    mouthClass: 'mouth thinking', speech: '代码审查中...' },
};
```

**步骤 2：在 CSS 中添加状态动画**

```css
.companion-body.ai-reviewing {
  animation: ai-review-bob 2s ease-in-out infinite;
}

@keyframes ai-review-bob {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-3px) rotate(-2deg); }
}
```

**步骤 3：在 HTML 菜单中添加选项**

```html
<div class="menu-item" data-action="ai-reviewing">🔍 审查中</div>
```

**步骤 4：在 handleMenuAction 中添加处理**

```javascript
case 'ai-reviewing': setAIState('reviewing'); break;
```

**步骤 5：在 updateHUD 中添加 HUD 状态点样式**

```javascript
else if (state.aiState === 'reviewing') els.hudDot.classList.add('hud-active');
```

### 7.5 添加新 IPC 通道

以添加"截图"功能为例：

**步骤 1：在 main.js 中添加 IPC 处理器**

```javascript
ipcMain.handle('take-screenshot', async () => {
  if (!mainWindow) return null;
  try {
    const image = await mainWindow.webContents.capturePage();
    const buffer = image.toPNG();
    return { ok: true, data: buffer.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
```

**步骤 2：在 preload.js 中暴露 API**

```javascript
takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
```

**步骤 3：在 companion.js 的 api 回退中添加**

```javascript
takeScreenshot: function () { return Promise.resolve({ ok: false }); },
```

**步骤 4：在渲染进程中调用**

```javascript
api.takeScreenshot().then(function (res) {
  if (res && res.ok) { /* 处理截图数据 */ }
});
```

### 7.6 添加新菜单项

**步骤 1：在 index.html 的 context-menu 中添加菜单项**

```html
<div class="menu-item" data-action="my-action">🎯 我的操作</div>
```

如需分组，可添加分隔线和标签：

```html
<div class="menu-separator"></div>
<div class="menu-label">🎯 新分组</div>
<div class="menu-item" data-action="my-action">🎯 我的操作</div>
```

**步骤 2：在 handleMenuAction 中添加处理**

```javascript
case 'my-action':
  // 执行操作逻辑
  showSpeech('执行了我的操作！');
  addXP(3, '我的操作');
  break;
```

---

## 8. 构建与打包

### 8.1 electron-builder 配置

`package.json` 中的 `build` 字段定义了打包配置：

```json
{
  "build": {
    "appId": "com.harness.desktop-companion",
    "productName": "Harness Desktop Companion",
    "directories": { "output": "dist" },
    "files": ["main.js", "preload.js", "src/**/*"],
    "win":   { "target": "portable", "icon": "src/icon.ico" },
    "mac":   { "target": "dmg",      "icon": "src/icon.icns" },
    "linux": { "target": "AppImage", "icon": "src/icon.png" }
  }
}
```

### 8.2 多平台打包

| 平台 | 命令 | 输出格式 |
|------|------|---------|
| Windows | `npm run build` | Portable `.exe` |
| macOS | `npm run build -- --mac` | `.dmg` |
| Linux | `npm run build -- --linux` | `.AppImage` |

### 8.3 npm scripts 说明

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 Electron 应用（生产模式） |
| `npm run dev` | 启动 Electron 应用（开发模式，`--dev` 标志） |
| `npm run pack` | 打包但不生成安装包（仅目录） |
| `npm run build` | 完整打包生成安装包 |

---

## 9. 调试技巧

### 9.1 DevTools 打开方式

在主进程代码中添加以下代码即可自动打开 DevTools：

```javascript
// main.js - createWindow() 中添加
mainWindow.webContents.openDevTools({ mode: 'detach' });
```

或通过快捷键：在应用运行时按 `Ctrl+Shift+I`（Windows/Linux）或 `Cmd+Option+I`（macOS）。

### 9.2 localStorage 检查

在 DevTools Console 中检查持久化数据：

```javascript
// 查看所有设置
JSON.parse(localStorage.getItem('companion-settings'));

// 查看窗口位置
JSON.parse(localStorage.getItem('companion-window-pos'));

// 重置成长数据
var s = JSON.parse(localStorage.getItem('companion-settings'));
s.growth = { level: 1, xp: 0, totalXp: 0, totalInteractions: 0,
  petCount: 0, dragCount: 0, danceCount: 0, roamCount: 0,
  skinsUsed: ['robot'], achievements: [],
  fileDropCount: 0, permApproved: 0, permDenied: 0 };
localStorage.setItem('companion-settings', JSON.stringify(s));

// 清除所有数据
localStorage.removeItem('companion-settings');
localStorage.removeItem('companion-window-pos');
```

### 9.3 IPC 通信调试

在主进程中添加 IPC 日志：

```javascript
// main.js - 在 ipcMain.handle 调用前添加
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function (channel, handler) {
  return originalHandle(channel, async function (...args) {
    console.log(`[IPC] ← ${channel}`, args.slice(1));
    const result = await handler(...args);
    console.log(`[IPC] → ${channel}`, result);
    return result;
  });
};
```

在渲染进程中通过 `window.companionAPI` 调试：

```javascript
// DevTools Console
const origProxy = window.companionAPI.proxyAPI;
window.companionAPI.proxyAPI = function (endpoint) {
  console.log('[API] →', endpoint);
  return origProxy(endpoint).then(function (res) {
    console.log('[API] ←', endpoint, res);
    return res;
  });
};
```

### 9.4 常见开发问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 窗口不显示 | `transparent: true` + CSS 背景问题 | 检查 CSS `background` 属性是否正确 |
| API 连接失败 | Harness 后端未启动 | 先启动 `node harness-cli.js dashboard` |
| 皮肤切换无效 | CSS 类未正确移除 | 检查 `switchSkin()` 中的类操作 |
| 窗口位置异常 | localStorage 保存了无效坐标 | 清除 `companion-window-pos` |
| 音效不播放 | AudioContext 被浏览器策略暂停 | 需要用户交互后才能创建 AudioContext |
| 拖拽不流畅 | IPC 通信延迟 | `moveWindow` 使用增量移动而非绝对定位 |
| 粒子不消失 | `setTimeout` 未正确清理 | 检查 `clearFx()` 是否被调用 |

---

## 10. 代码规范

### 10.1 变量命名

- 使用 `var` 声明（项目采用 ES5 风格，不使用 `let`/`const`）
- 驼峰命名法：`currentSkin`、`isDragging`、`idleTimeout`
- 常量全大写：`SKINS`、`STAGES`、`ACHIEVEMENTS`、`AI_STATES`、`SPEECH`
- DOM 缓存对象使用 `els` 命名
- 状态对象使用 `state` 命名
- API 桥接对象使用 `api` 命名

### 10.2 错误处理模式

项目采用 `try/catch + 静默失败` 模式，确保 UI 不会因非关键错误崩溃：

```javascript
// localStorage 操作
try {
  localStorage.setItem('companion-settings', JSON.stringify(data));
} catch {}  // 存储配额满时静默忽略

// API 请求
api.proxyAPI('/api/health').then(function (res) {
  // 处理成功
}).catch(function () {
  // 静默处理，使用回退数据
});

// DOM 操作
try {
  var pos = mainWindow.getPosition();
} catch { return null; }
```

### 10.3 DOM 操作模式

所有 DOM 元素在 `init()` 中批量获取并缓存到 `els` 对象，避免重复查询 DOM 树：

```javascript
var els = {};

function init() {
  els.body = document.getElementById('companionBody');
  els.head = document.getElementById('companionHead');
  els.leftEye = document.getElementById('leftEye');
  // ... 50+ 元素
}
```

后续操作通过 `els` 引用访问：

```javascript
els.body.classList.add('excited');
els.speechText.textContent = text;
```

### 10.4 事件监听模式

- 使用 `addEventListener` 绑定事件（不使用 `onclick` 属性）
- 在面板/菜单等容器的事件处理中，使用 `e.stopPropagation()` 阻止冒泡
- 定时器 ID 保存在 `state` 对象中，便于清理
- 事件监听器在 `removeAllListeners` 后重新注册（防泄漏）

```javascript
// 阻止冒泡模式
els.permApprove.addEventListener('click', function (e) {
  e.stopPropagation();
  // 处理逻辑
});

// 定时器管理模式
clearTimeout(state.speechTimeout);
state.speechTimeout = setTimeout(function () {
  els.speechBubble.classList.remove('visible');
}, duration);
```

### 10.5 定时器管理模式

所有 `setInterval` 必须保存引用到 `state.intervals` 数组，确保可统一清理，防止内存泄漏：

```javascript
// 正确：保存引用
var id = setInterval(pollAgentStatus, 5000);
state.intervals.push(id);

// 错误：无引用的定时器（无法清理）
setInterval(pollAgentStatus, 5000);
```

特殊用途的定时器（如漫游步进 `state.roamWalkInterval`）同时保存到独立字段和 `state.intervals`，便于在特定场景下单独清理：

```javascript
state.roamWalkInterval = setInterval(walkStep, 100);
state.intervals.push(state.roamWalkInterval);

// stopRoaming 时单独清理
clearInterval(state.roamWalkInterval);
state.roamWalkInterval = null;
```

### 10.6 Promise 模式

避免嵌套 Promise，使用 `Promise.all` 并行请求多个独立资源，并始终添加 `.catch` 错误处理：

```javascript
// 正确：Promise.all 并行 + .catch 错误处理
Promise.all([
  api.getWindowPosition(),
  api.getScreenSize()
]).then(function (results) {
  var pos = results[0];
  var screen = results[1];
  // 处理结果
}).catch(function () {
  // 静默处理错误
});

// 错误：嵌套 Promise（回调地狱，串行等待无依赖的请求）
api.getWindowPosition().then(function (pos) {
  api.getScreenSize().then(function (screen) {
    // 处理结果
  });
});

// 错误：缺少 .catch（未处理的 Promise 拒绝）
Promise.all([api.getWindowPosition(), api.getScreenSize()])
  .then(function (results) { /* ... */ });
```

> **原则**：独立的异步请求应使用 `Promise.all` 并行执行，减少总等待时间。每个 Promise 链必须以 `.catch` 结尾，防止未处理的拒绝异常。

### 10.7 循环中的 DOM 元素创建与闭包

`for` 循环中创建 DOM 元素并通过 `setTimeout` 延迟移除时，必须使用 IIFE 或其他闭包技术确保每个回调捕获独立的元素引用。禁止在 `for` 循环中用 `var` 声明 DOM 元素后直接在 `setTimeout` 中引用。

```javascript
// 正确：IIFE 包裹每次迭代，捕获独立的 DOM 元素引用
for (var i = 0; i < count; i++) {
  (function (idx) {
    var el = document.createElement('div');
    container.appendChild(el);
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 1000);
  })(i);
}

// 错误：var 声明的 el 被后续循环覆盖，所有 setTimeout 回调操作同一元素
for (var i = 0; i < count; i++) {
  var el = document.createElement('div');
  container.appendChild(el);
  setTimeout(function () {
    if (el && el.parentNode) el.parentNode.removeChild(el);  // el 始终指向最后一个
  }, 1000);
}
```

> **原因**：项目采用 ES5 风格的 `var` 声明，`var` 没有块级作用域，循环内的 `var` 声明会被提升到函数作用域顶部。`setTimeout` 回调执行时，`var` 变量已指向最后一次迭代的值。IIFE 为每次迭代创建独立作用域，闭包捕获当前迭代的变量绑定，避免引用被覆盖。

### 10.8 IPC 事件监听器清理

禁止使用 `ipcRenderer.removeHandler(channel)` 清理通过 `ipcRenderer.on` 注册的监听器。`removeHandler` 是 `ipcMain.handle` 的对应方法，用于移除主进程注册的请求-响应处理器，对渲染进程通过 `ipcRenderer.on` 注册的事件监听器无效，调用后不会产生任何效果，属于 API 误用。

正确做法是保存监听器函数引用，通过 `ipcRenderer.removeListener(channel, handler)` 精确移除：

```javascript
// 正确：保存引用 + removeListener 精确移除
var preloadState = { listeners: {} };

function registerListener(channel, callback) {
  if (preloadState.listeners[channel]) {
    ipcRenderer.removeListener(channel, preloadState.listeners[channel]);
  }
  var handler = function (_event, data) { callback(data); };
  preloadState.listeners[channel] = handler;
  ipcRenderer.on(channel, handler);
}

// 错误：removeHandler 对 ipcRenderer.on 注册的监听器无效
ipcRenderer.removeHandler('companion-speech');  // 无效！不会移除 on 注册的监听器
ipcRenderer.on('companion-speech', handler);    // 每次调用都新增，造成监听器泄漏
```

> **原因**：`ipcRenderer.removeHandler(channel)` 移除的是通过 `ipcRenderer.handle(channel, ...)` 注册的处理器（对应 `ipcMain.on` 的请求-响应模式），与 `ipcRenderer.on(channel, handler)` 注册的事件监听器是完全不同的注册表。误用 `removeHandler` 会导致旧监听器未被移除，每次重新注册都新增一个，造成监听器泄漏和回调重复执行。

### 10.9 DOM 元素自动清理

所有动态创建的 DOM 元素（粒子、纸屑、气泡、杂耍球等特效元素）必须设置自动移除的 `setTimeout`，避免元素在特效层中无限累积导致内存泄漏和视觉叠加。不得仅依赖外部清除函数（如 `clearFx()`）来移除元素，因为外部清除可能因状态切换遗漏而未被调用。

```javascript
// 正确：每个动态元素都有自动移除的 setTimeout
function spawnBubbles(count) {
  for (var i = 0; i < count; i++) {
    (function (idx) {
      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      els.fxContainer.appendChild(bubble);
      setTimeout(function () {
        if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
      }, 4000);
    })(i);
  }
}

// 错误：仅依赖外部 clearFx() 清除，无自动移除机制
function spawnJuggleBalls() {
  for (var i = 0; i < 3; i++) {
    var ball = document.createElement('div');
    ball.className = 'juggle-ball';
    els.fxContainer.appendChild(ball);
    // 无 setTimeout 自动移除！若 clearFx() 未被调用，球会永远留在 DOM 中
  }
}
```

> **原则**：动态 DOM 元素的生命周期应由创建者自身管理（通过 `setTimeout` 自动移除），而非依赖外部清理函数。外部清理函数（如 `clearFx()`）作为补充手段，用于在状态切换时立即清除所有特效，但不能作为唯一的移除机制。

### 10.10 innerHTML 安全规范

禁止使用 `innerHTML` 插入未转义的用户数据或动态文本。所有动态内容渲染必须使用 `textContent` 或 `document.createElement` + DOM API 构建，从根源上杜绝 XSS 注入风险。

```javascript
// 正确：使用 textContent 设置文本，浏览器自动转义
var msgSpan = document.createElement('span');
msgSpan.className = 'toast-msg';
msgSpan.textContent = message;
t.appendChild(msgSpan);

// 错误：innerHTML 拼接未转义文本，存在 XSS 风险
t.innerHTML = '<span class="toast-msg">' + message + '</span>';
```

> **原因**：`innerHTML` 会将字符串作为 HTML 解析，若 `message` 包含 `<script>` 标签或事件处理器属性（如 `<img onerror="...">`），恶意代码将被执行。`textContent` 将字符串作为纯文本插入，浏览器自动对特殊字符（`<`、`>`、`&`、`"`、`'`）进行转义，即使文本包含 HTML 标签也不会被解析执行。
>
> **适用范围**：`renderEventLog`（事件日志渲染）和 `showToast`（Toast 通知渲染）均已从 `innerHTML` 迁移为 `textContent` + DOM API 模式。新增的动态内容渲染函数必须遵循相同规范。

### 10.11 递归调用防护

当函数 A 调用函数 B，而函数 B 又可能回调函数 A 时，必须使用重入守卫标志防止无限递归：

```javascript
var checkingAchievements = false;

function checkAchievements() {
  if (checkingAchievements) return;
  checkingAchievements = true;
  // ... 遍历成就，解锁时调用 addXP(20, ...) ...
  saveSettings();
  checkingAchievements = false;
}
```

> **原因**：`checkAchievements()` 解锁成就时调用 `addXP(20, ...)`，而 `addXP()` 末尾调用 `checkAchievements()`，形成递归调用链。若成就解锁后 XP 增加又触发新成就解锁（如等级类成就），可能导致栈溢出。重入守卫确保同一时刻只有一层检查在执行，被跳过的检查会在下一轮用户交互触发的 `addXP` 中补执行。
>
> **适用场景**：任何存在循环依赖的函数调用链都应使用此模式，包括但不限于：状态更新 → 数据检查 → 状态更新的循环。

### 10.12 localStorage 数据验证

从 `localStorage` 恢复的数据必须进行严格的类型和范围校验，不能假设存储的数据格式始终正确：

```javascript
// 正确：验证类型和范围
state.growth.level = (typeof g.level === 'number' && g.level > 0) ? g.level : 1;
state.growth.xp = (typeof g.xp === 'number' && g.xp >= 0) ? g.xp : 0;
state.growth.skinsUsed = Array.isArray(g.skinsUsed) ? g.skinsUsed : ['robot'];
state.growth.achievements = Array.isArray(g.achievements) ? g.achievements : [];

// 错误：仅使用 ?? 运算符，无法防御 NaN、负数、非数组等非法值
state.growth.level = g.level ?? 1;
state.growth.skinsUsed = g.skinsUsed || ['robot'];
```

> **原因**：`??` 运算符仅处理 `null` 和 `undefined`，无法防御 `NaN`、负数、字符串等非法值。`||` 运算符对空字符串和 0 也会触发回退。`Array.isArray()` 是验证数组类型的唯一可靠方式，`typeof arr === 'object'` 对 null 也返回 true。
>
> **防御场景**：
> - 用户通过开发者工具手动修改 localStorage
> - 旧版本数据格式与当前版本不兼容
> - JSON 序列化/反序列化引入的类型变化（如 Date 对象变为字符串）
> - 存储配额满导致写入截断

### 10.13 枚举值输入验证

所有用作 CSS 类名、DOM 属性或状态标识的字符串参数，必须通过白名单验证后才能使用，禁止直接拼接未验证的字符串：

```javascript
// 正确：白名单验证
function setMood(mood) {
  if (!{ happy: 1, calm: 1, energetic: 1 }[mood]) return;
  state.mood = mood;
  els.companion.classList.add('mood-' + mood);
}

function logEvent(text, type) {
  var validTypes = { info: 1, success: 1, warning: 1, error: 1, level: 1, xp: 1 };
  var t = validTypes[type] ? type : 'info';
  // ... 使用 t 而非 type
}

// 错误：直接拼接未验证的字符串作为 CSS 类名
function setMood(mood) {
  state.mood = mood;
  els.companion.classList.add('mood-' + mood);  // mood 可能是任意字符串
}
```

> **原因**：将未验证的字符串直接拼接到 CSS 类名中，虽然 CSP 阻止了内联脚本执行，但仍可能导致：
> - 无效的 CSS 类名污染 DOM（如 `mood-happy'; background: url(evil)`）
> - `loadSettings` 从 localStorage 恢复时引入非法值
> - 右键菜单或其他入口传入非预期的参数值
>
> **白名单模式**：使用对象字面量 `{ valid1: 1, valid2: 1 }[value]` 进行 O(1) 查找验证，比 `indexOf` 数组查找更高效。验证失败时静默忽略（`return`）或回退到默认值，不抛出异常。
>
> **适用范围**：`setMood`（心情白名单）、`logEvent`（事件类型白名单）、`loadSettings`（心情白名单验证）、`setAIState`（已有 `AI_STATES[newState]` 检查，无需额外处理）。新增的枚举参数函数必须遵循相同规范。

### 10.14 配置表模式

当函数使用 if-else 链或三元运算符链根据类型/状态选择不同的值（如频率、类名、图标）时，必须将选择逻辑提取为配置表常量：

```javascript
// 正确：配置表 + 默认值
var SOUND_CONFIG = {
  click: { freq: 800, gain: 0.04 },
  levelup: { freq: 523, gain: 0.08 },
};
var SOUND_DEFAULT = { freq: 600, gain: 0.04 };
function playSound(type) {
  var cfg = SOUND_CONFIG[type] || SOUND_DEFAULT;
  // ... 使用 cfg.freq 和 cfg.gain
}

var HUD_STATE_MAP = {
  idle: 'hud-idle', thinking: 'hud-thinking', error: 'hud-error',
};
function updateHUD() {
  els.hudDot.className = 'hud-dot ' + (HUD_STATE_MAP[state.aiState] || 'hud-active');
}

// 错误：if-else 链硬编码值
function playSound(type) {
  if (type === 'click') { osc.frequency.value = 800; gain.gain.value = 0.04; }
  else if (type === 'levelup') { osc.frequency.value = 523; gain.gain.value = 0.08; }
  else { osc.frequency.value = 600; gain.gain.value = 0.04; }
}
```

> **原因**：if-else 链和三元运算符链在新增类型时需修改函数体，违反开闭原则。配置表模式将数据与逻辑分离，新增类型只需在配置表中添加一行，无需修改函数实现。
>
> **已应用的配置表**：
> - `SOUND_CONFIG` / `SOUND_DEFAULT` — 音效频率和增益（playSound）
> - `TOAST_ICONS` — Toast 图标映射（showToast）
> - `HUD_STATE_MAP` — HUD 状态类名映射（updateHUD）
> - `SKIN_COLORS` — 皮肤粒子颜色（createParticles / spawnBurstParticles）
> - `EYE_EXPR_CLASSES` — 眼睛表情类名列表（clearFx / clearAIState / setEyeExpression）
> - `FX_BODY_CLASSES` — 特效动画类名列表（clearFx）
> - `MOOD_CLASSES` — 心情CSS类名列表（setMood）
> - `SKIN_CLASSES` — 皮肤CSS类名列表（init / switchSkin）
> - `TIME_CLASSES` — 时段CSS类名列表（applyTimeTheme）
> - `SLEEP_CLASSES` — 睡眠CSS类名列表（resetIdle）
>
> **共享常量原则**：当多个函数使用相同的字符串列表或映射时，必须提取为模块级共享常量（如 `EYE_EXPR_CLASSES`、`SKIN_COLORS`），禁止在多处重复定义。

### 10.15 设计系统规范

所有 UI 元素必须使用 CSS 自定义属性（设计令牌）统一管理视觉属性，禁止硬编码数值：

```css
/* 正确：使用设计令牌 */
.my-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  font-family: var(--font-body);
}

/* 错误：硬编码数值 */
.my-card {
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,.4);
  font-family: 'Inter', sans-serif;
}
```

> **设计令牌体系**：
>
> | 类别 | 令牌 | 说明 |
> |------|------|------|
> | 圆角 | `--radius-sm/md/lg/xl` | 8/12/16/24px 四级圆角系统 |
> | 阴影 | `--shadow-sm/md/lg` | 3层软阴影（环境光+主投影+边缘高光） |
> | 字体 | `--font-display/body/mono` | 展示/正文/等宽三级字体 |
> | 动效 | `--t-fast/smooth/spring/bounce/elegant` | 5种预设缓动曲线 |
> | 质感 | `--grain-opacity` | 噪点纹理透明度（默认3%） |
> | 动画 | `--stagger-delay` | 交错渐显延迟间隔（默认60ms） |
>
> **3层软阴影原理**：每层阴影承担不同角色——第1层模拟环境光（小偏移、低模糊），第2层为主投影（中偏移、中模糊），第3层为远距离散射（大偏移、高模糊、低透明度）。这种分层方式比单层阴影更自然，避免"悬浮感"过重。
>
> **噪点纹理**：通过 `#companion::before` 伪元素叠加 SVG feTurbulence 噪点，`mix-blend-mode: overlay` 混合，`pointer-events: none` 不影响交互。3%透明度在视觉上几乎不可见，但能消除纯色背景的"数字感"，增加材质质感。
>
> **交错渐显**：面板打开时为 `.panel-section` 添加 `.stagger-reveal` 类，每个子元素延迟 `--stagger-delay` 递增出现，营造"信息流入"的节奏感。

### 10.16 IPC 参数验证

主进程 IPC 处理器应对渲染进程传入的参数进行类型和范围校验，防止非法值导致异常行为：

```javascript
// 正确：参数类型和范围双重校验
ipcMain.handle('set-window-size', async (_event, w, h) => {
  if (!mainWindow) return;
  if (typeof w !== 'number' || typeof h !== 'number' || w < 100 || h < 100 || w > 4000 || h > 4000) return;
  try {
    mainWindow.setSize(Math.round(w), Math.round(h));
  } catch {}
});
```

- **类型校验**：使用 `typeof` 确保参数为期望类型
- **范围校验**：设定合理的最小值和最大值边界
- **取整处理**：像素值使用 `Math.round()` 取整，避免浮点数精度问题
- **失败策略**：校验不通过时静默返回，不抛出异常，不修改状态

### 10.17 函数输入验证

渲染进程中所有接收外部输入的函数应在入口处进行参数验证：

```javascript
// formatTokens — 数值验证
function formatTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '-';
  // ...
}

// showSpeech — 字符串验证
function showSpeech(text, duration) {
  if (state.dndMode) return;
  if (typeof text !== 'string' || !text) return;
  // ...
}
```

- **数值验证**：`typeof === 'number'` + `isFinite()` + 范围检查，防止 `undefined`/`NaN`/`Infinity`/负数
- **字符串验证**：`typeof === 'string'` + 非空检查，防止 `undefined`/`null`/空字符串
- **失败策略**：返回安全默认值（如 `'-'`）或静默返回，不抛出异常

### 10.18 logEvent 参数顺序约定

`logEvent(text, type)` 的参数顺序为**文本在前，类型在后**。此约定与直觉可能相反（直觉可能是"先类型后内容"），必须严格遵守：

```javascript
// 正确 ✓
logEvent('优化迭代 #5 最佳分数: 0.9876', 'info');
logEvent('优化收敛于迭代 #12', 'success');
logEvent('优化循环失败', 'error');

// 错误 ✗ — 参数反转，日志将显示 'info'/'success'/'error' 作为文本
logEvent('info', '优化迭代 #5 最佳分数: 0.9876');
logEvent('success', '优化收敛于迭代 #12');
logEvent('error', '优化循环失败');
```

- 参数反转时不会报错（`type` 参数不匹配白名单会回退到 `'info'`），但日志文本会显示为类型名而非实际消息
- 新增调用点时务必参照已有正确调用（如 `logEvent('连接到驭框架', 'success')`）确认参数顺序

### 10.19 枚举白名单验证

所有接受枚举值参数的函数应在入口处验证参数是否在预定义的白名单中，防止无效值导致意外行为：

```javascript
// setEyeExpression — 白名单验证
var EYE_EXPR_CLASSES = ['heart-eye', 'dizzy-eye', 'spiral-eye', 'star-eye', 'squint-eye', 'wide-eye'];
function setEyeExpression(expr) {
  EYE_EXPR_CLASSES.forEach(function (cls) { els.leftEye.classList.remove(cls); els.rightEye.classList.remove(cls); });
  if (expr && EYE_EXPR_CLASSES.indexOf(expr) >= 0) {
    els.leftEye.classList.add(expr);
    els.rightEye.classList.add(expr);
    // ...
  }
}

// addXP — 数值范围验证
function addXP(amount, reason) {
  if (typeof amount !== 'number' || amount <= 0) return;
  // ...
}
```

- **白名单验证**：使用 `indexOf` 检查参数是否在预定义数组中，不在白名单时静默忽略
- **数值范围验证**：`typeof === 'number'` + 正数检查，防止0/负数/NaN/undefined
- **失败策略**：静默返回，不抛出异常，不修改状态

### 10.20 轮询日志防洪

API轮询回调中记录日志时，应仅在状态转换时记录，避免每次轮询都产生重复日志：

```javascript
// 错误 ✗ — 每5秒轮询一次，日志被淹没
if (data.status === 'running') {
  setAIState('optimizing');
  logEvent('优化迭代 #' + data.currentIteration, 'info'); // 每5秒记录一次
}

// 正确 ✓ — 仅在状态转换时记录
if (data.status === 'running') {
  if (state.aiState !== 'optimizing') {
    setAIState('optimizing');
    logEvent('优化迭代 #' + data.currentIteration, 'info'); // 仅转换时记录一次
  }
}
```

- **状态守卫**：在日志记录前检查 `state.aiState !== 'newState'`，确保只在首次进入状态时记录
- **适用场景**：所有周期性轮询回调（健康检查、Agent状态、优化循环状态等）
- **日志量控制**：避免事件日志（30条上限）被轮询数据快速填满，导致重要事件被挤出

### 10.21 Vibe能力配置表模式

Vibe Coding 四大底层能力（审查力、系统思维、产品感、审美）采用配置表模式统一管理，每个能力映射到AI状态、Harness Skill和视觉主题色：

```javascript
var VIBE_CAPABILITIES = {
  reviewing: { name: '审查力', icon: '🔍', desc: 'AI代码视为初级产出，逐段审查守住质量底线', color: '#f87171', skill: 'code-review', hudClass: 'hud-thinking' },
  architecting: { name: '系统思维', icon: '🏗️', desc: '先规划蓝图再分模块交付，架构决定产出档次', color: '#818cf8', skill: 'architecture-design', hudClass: 'hud-building' },
  validating: { name: '产品感', icon: '🎯', desc: '聚焦核心需求验证，避免堆砌无用功能', color: '#34d399', skill: 'requirement-analysis', hudClass: 'hud-typing' },
  designing: { name: '审美', icon: '✨', desc: 'UI设计直接影响留存，明确好设计的标准', color: '#fbbf24', skill: 'taste-skill', hudClass: 'hud-active' },
};
```

- **配置表驱动**：新增Vibe能力只需在 `VIBE_CAPABILITIES` 中添加一条记录，同时更新 `AI_STATES`、`HUD_STATE_MAP`、`SPEECH` 和 CSS 动画
- **激活函数**：`activateVibeCapability(capKey)` 统一处理状态切换、语音、Toast、粒子、XP和日志
- **面板交互**：Vibe卡片点击通过 `data-vibe` 属性映射到 `VIBE_CAPABILITIES` 键名
- **主题色**：每个能力有独立主题色，CSS中通过 `.vibe-card[data-vibe="xxx"].active` 选择器应用
- **扩展原则**：新增底层能力时，必须同步更新5处：VIBE_CAPABILITIES + AI_STATES + HUD_STATE_MAP + SPEECH + CSS动画

### 10.22 临时动画类完整清理

所有通过 `classList.add()` 直接添加到 `els.body` 的临时CSS类，必须同步注册到 `FX_BODY_CLASSES` 数组中，确保 `clearFx()` 能完整清除：

```javascript
// FX_BODY_CLASSES 必须包含所有临时body类
var FX_BODY_CLASSES = [
  // 特效动画
  'fx-dance', 'fx-sing', 'fx-hearteyes', 'fx-rainbow', 'fx-magic',
  'fx-jump', 'fx-shake', 'fx-bow', 'fx-celebrate', 'fx-tremble',
  // 空闲动作
  'idle-sweep', 'idle-juggle', 'idle-carry',
  // AI状态动画
  'ai-conducting',
  // 交互反馈
  'waving', 'look-around-click', 'excited', 'wake-up-startle',
];
```

- **注册原则**：任何通过 `els.body.classList.add('xxx')` 添加的临时类，都必须加入 `FX_BODY_CLASSES`
- **遗漏后果**：未注册的类在 `clearFx()` 调用时不会被移除，可能导致动画残留
- **AI状态类例外**：AI状态的bodyClass（如 `ai-thinking`、`ai-reviewing`）由 `clearAIState()` 通过遍历 `AI_STATES` 清除，不需要重复注册
- **新增检查**：添加新的临时body类时，必须同步更新 `FX_BODY_CLASSES` 数组

### 10.23 SuperAgent能力配置表模式

SuperAgent 三大核心能力（全流程集成、自主迭代、轻量适配）采用与 VIBE_CAPABILITIES 相同的配置表模式，每个能力映射到AI状态、Harness Skill和视觉主题色：

```javascript
var SUPERAGENT_CAPABILITIES = {
  integrating: { name: '全流程集成', icon: '🔗', desc: '多任务全流程覆盖，无需切换工具', color: '#60a5fa', skill: 'web-interaction', hudClass: 'hud-active' },
  selfhealing: { name: '自主迭代', icon: '🔄', desc: '卡点自调整策略，无需人工干预', color: '#a78bfa', skill: 'optimization-loop', hudClass: 'hud-building' },
  adapting: { name: '轻量适配', icon: '⚡', desc: '多模型兼容切换，本地云端无缝部署', color: '#2dd4bf', skill: 'ai-prompting', hudClass: 'hud-typing' },
};
```

- **配置表驱动**：与 VIBE_CAPABILITIES 共享相同的架构模式，新增能力只需添加一条记录
- **激活函数**：`activateSuperAgent(capKey)` 与 `activateVibeCapability(capKey)` 遵循相同的行为契约
- **面板交互**：SuperAgent卡片通过 `data-sa` 属性映射（区别于Vibe的 `data-vibe`）
- **扩展原则**：新增SuperAgent能力时，必须同步更新5处：SUPERAGENT_CAPABILITIES + AI_STATES + HUD_STATE_MAP + SPEECH + CSS动画
- **与Vibe的区别**：Vibe关注"人类底层能力"（审查力/系统思维/产品感/审美），SuperAgent关注"工具能力"（集成/自愈/适配），两者互补

### 10.24 AI状态优先级与竞态防护

AI状态来源有两种：用户手动触发和API轮询自动触发。当两者同时活跃时，必须防止自动状态覆盖手动状态：

```javascript
// state.manualState 标志
var state = {
  // ...
  manualState: false, // 手动状态守卫
};

// 手动激活时设置标志
function activateVibeCapability(capKey) {
  state.manualState = true;
  setAIState(capKey);
  // ...
}

// setAIState 中自动清除（切换到非手动状态时）
function setAIState(newState) {
  var isManual = VIBE_CAPABILITIES[newState] || SUPERAGENT_CAPABILITIES[newState];
  if (!isManual) state.manualState = false;
  // ...
}

// API轮询中尊重手动状态
if (state.aiState !== 'conducting' && !state.manualState) {
  setAIState('conducting');
}

// 用户唤醒时清除手动状态
function resetIdle() {
  state.manualState = false;
  // ...
}
```

- **手动状态**：Vibe能力（reviewing/architecting/validating/designing）和 SuperAgent能力（integrating/selfhealing/adapting）由用户主动触发，优先级最高
- **自动状态**：API轮询触发的状态（conducting/optimizing等），优先级较低
- **竞态防护**：API轮询检测 `state.manualState` 标志，为 `true` 时跳过自动状态切换
- **自动恢复**：用户从空闲唤醒时清除 `manualState`，恢复API驱动的自动状态管理
- **设计原则**：用户意图优先于系统自动行为，手动操作不应被后台轮询静默覆盖

### 10.25 定时器生命周期管理

所有 `setInterval` 和 `setTimeout` 返回的定时器ID必须被追踪，并在窗口关闭时完整清理：

- **setInterval 追踪**：所有 `setInterval` 返回值必须推入 `state.intervals` 数组
- **beforeunload 清理**：`window.addEventListener('beforeunload', ...)` 中遍历清理所有定时器
- **独立定时器字段**：`state.blinkInterval`、`state.idleActionTimer`、`state.roamWalkInterval` 等独立字段需单独清理
- **一次性定时器**：`state.idleTimer`、`state.speechTimeout`、`state.fxTimeout` 等需 `clearTimeout`
- **sleepTimers 数组**：空闲睡眠阶段的多个 `setTimeout` 需遍历清理
- **新增定时器检查清单**：添加新的 `setInterval`/`setTimeout` 时，必须确认其在 `beforeunload` 中被清理
- **IPC 参数验证**：`send-command` IPC 处理器需验证 `cmd` 为非空字符串，防止无效API请求

### 10.26 扩展层配置表模式

Claude Code 5层扩展功能（CLAUDE.md/Skills/MCP/Subagents/Hooks）采用与 VIBE_CAPABILITIES/SUPERAGENT_CAPABILITIES 相同的配置表模式，每层映射到AI状态、Harness Skill、上下文成本等级和触发场景：

```javascript
var EXTENSION_LAYERS = {
  memorizing: { name: 'CLAUDE.md', icon: '🧠', desc: '长期记忆，项目约定自动加载', color: '#f97316', skill: 'session-start-hook', hudClass: 'hud-thinking', cost: 5, trigger: '两次搞错项目约定时写入' },
  skilling: { name: 'Skills', icon: '📦', desc: '自定义技能包，多步骤流程封装', color: '#8b5cf6', skill: 'skill-router', hudClass: 'hud-active', cost: 3, trigger: '同一流程重复三次时封装' },
  connecting: { name: 'MCP', icon: '🔌', desc: '连接外部服务，查数据库发消息', color: '#06b6d4', skill: 'web-interaction', hudClass: 'hud-typing', cost: 2, trigger: '反复从浏览器复制数据时添加' },
  delegating: { name: 'Subagents', icon: '👥', desc: '任务拆解并行，隔离辅助输出', color: '#ec4899', skill: 'dispatching-parallel', hudClass: 'hud-building', cost: 2, trigger: '辅助任务刷爆对话时隔离' },
  automating: { name: 'Hooks', icon: '⚙️', desc: '事件触发自动化，无需思考', color: '#84cc16', skill: 'verification-before-completion', hudClass: 'hud-active', cost: 1, trigger: '希望某操作自动发生时配置' },
};
```

- **配置表驱动**：与 VIBE_CAPABILITIES/SUPERAGENT_CAPABILITIES 共享相同的架构模式
- **激活函数**：`activateExtension(extKey)` 遵循相同的行为契约，额外记录成本和触发场景
- **面板交互**：Extension卡片通过 `data-ext` 属性映射（区别于Vibe的 `data-vibe`和SuperAgent的 `data-sa`）
- **上下文成本**：`cost` 字段表示上下文窗口消耗等级（1-5），CLAUDE.md最高(5)，Hooks最低(1)
- **触发场景**：`trigger` 字段提供场景化使用建议，帮助用户按需添加而非一次性配齐
- **扩展原则**：新增扩展层时，必须同步更新5处：EXTENSION_LAYERS + AI_STATES + HUD_STATE_MAP + SPEECH + CSS动画
- **三配置表体系**：Vibe（人类底层能力）+ SuperAgent（工具能力）+ Extension（扩展层能力），三者互补

### 10.27 工具函数防御性编程

工具函数是项目的基础设施，必须具备防御性编程能力，避免因调用方传入非法参数导致级联故障：

- **randomFrom 空数组防护**：`randomFrom(arr)` 必须检查 `Array.isArray(arr) && arr.length > 0`，不满足时返回空字符串 `''` 而非 `undefined`，防止 `showSpeech(undefined)` 显示 "undefined" 文本
- **saveSettings 显式字段拷贝**：`saveSettings()` 必须显式拷贝 `state.growth` 的13个已知字段到新对象，而非直接序列化 `state.growth` 引用，防止运行时属性泄漏到 localStorage
- **设计原则**：工具函数不应假设调用方总是传入合法参数，应在入口处验证并返回安全默认值
- **级联故障防护**：一个函数的非法返回值不应成为另一个函数的非法输入，形成防御链

### 10.28 SDD实践配置表模式

规格驱动开发（SDD）4大核心实践采用与 VIBE_CAPABILITIES/SUPERAGENT_CAPABILITIES/EXTENSION_LAYERS 相同的配置表模式，额外增加了 `evolution`（进化阶段）字段：

```javascript
var SDD_PRACTICES = {
  specifying: { name: '规格文档', icon: '📋', desc: '确保需求理解一致，先写规格再写代码', color: '#ef4444', skill: 'requirement-analysis', hudClass: 'hud-thinking', cost: 4, trigger: '每次给AI提需求都要重复解释时编写', evolution: 2 },
  syncing: { name: '同步机制', icon: '🔄', desc: '先改文档再写代码，保障文档与事实一致', color: '#f59e0b', skill: 'documentation', hudClass: 'hud-active', cost: 3, trigger: '直接改代码忘记更新文档时建立', evolution: 3 },
  questioning: { name: '反问机制', icon: '❓', desc: '强制AI不懂就问，拦截模糊需求', color: '#10b981', skill: 'brainstorming', hudClass: 'hud-building', cost: 2, trigger: '功能复杂容易漏细节时启用', evolution: 4 },
  planning: { name: '计划文档', icon: '📝', desc: '多文件修改先出计划，人类审核后再执行', color: '#6366f1', skill: 'architecture-design', hudClass: 'hud-typing', cost: 3, trigger: '修改涉及多文件时使用', evolution: 5 },
};
```

- **evolution 字段**：表示SDD进化路径中的阶段编号（1=裸跑, 2=规格文档, 3=同步机制, 4=反问机制, 5=计划文档），按需递进而非一次性配齐
- **配置表驱动**：与 VIBE/SuperAgent/Extension 共享相同的架构模式，额外增加进化阶段维度
- **激活函数**：`activateSDD(sddKey)` 遵循相同的行为契约，日志中额外记录进化阶段
- **面板交互**：SDD卡片通过 `data-sdd` 属性映射，状态指示器使用 `.sdd-evo` 类
- **扩展原则**：新增SDD实践时，必须同步更新5处：SDD_PRACTICES + AI_STATES + HUD_STATE_MAP + SPEECH + CSS动画
- **四配置表体系**：Vibe（人类底层能力）+ SuperAgent（工具能力）+ Extension（扩展层能力）+ SDD（开发实践能力），四者互补
- **SDD核心原则**：文档不是形式，而是保障需求理解一致、拦截细节遗漏、提升开发效率的关键

### 10.29 存储键名与API端点常量化

localStorage 键名和 API 端点字符串必须提取为共享常量，禁止在业务代码中硬编码：

```javascript
var STORAGE_KEYS = {
  settings: 'companion-settings',
  windowPos: 'companion-window-pos',
};

var API_ENDPOINTS = {
  health: '/api/health',
  agents: '/api/agents',
  skills: '/api/skills',
  optimizationStatus: '/api/optimization/status',
  optimizationProgress: '/api/optimization/progress',
  optimizationJournal: '/api/optimization/journal',
};
```

- **DRY原则**：同一字符串出现2次及以上时必须提取为常量
- **单一修改点**：键名或端点变更时只需修改常量定义处
- **命名规范**：`STORAGE_KEYS` 用驼峰键名，`API_ENDPOINTS` 用驼峰键名
- **新增键名/端点**：必须先在常量对象中添加，再在业务代码中引用

### 10.30 成就检查级联防护

成就解锁时奖励的XP可能触发新的成就条件，必须使用级联重检模式而非简单重入守卫：

```javascript
var checkingAchievements = false;
var achievementsNeedRecheck = false;

function checkAchievements() {
  if (checkingAchievements) { achievementsNeedRecheck = true; return; }
  checkingAchievements = true;
  do {
    achievementsNeedRecheck = false;
    // ... 遍历并解锁成就 ...
  } while (achievementsNeedRecheck);
  checkingAchievements = false;
}
```

- **问题场景**：解锁成就A奖励20XP → addXP调用checkAchievements → 简单重入守卫直接return → 成就B的检查被静默丢弃
- **级联重检**：内层调用被阻止时设置`achievementsNeedRecheck=true`，外层循环结束后自动重新检查
- **终止条件**：当一轮检查中没有任何内层调用被阻止时，`achievementsNeedRecheck`保持`false`，循环终止
- **安全性**：`checkingAchievements`标志确保同一时刻只有一层在执行检查，避免无限递归

### 10.31 条件性初始化奖励

仅限首次触发的奖励必须添加条件守卫，防止每次启动都重复发放：

```javascript
if (state.growth.totalInteractions === 0) addXP(5, '初次见面');
```

- **问题场景**：`addXP(5, '初次见面')`在`init()`中无条件调用，每次打开应用都获得5XP
- **修复方案**：检查`totalInteractions === 0`确保仅在首次交互时奖励
- **适用范围**：所有"首次"语义的奖励、成就、提示都必须添加条件守卫

### 10.32 CSS @keyframes 引用完整性

每个CSS动画引用必须存在对应的`@keyframes`定义，否则动画静默失效：

- **检查方法**：搜索所有`animation:`属性值，提取`@keyframes`名称，确认每个名称都有对应定义
- **常见遗漏**：子元素动画（如`.ai-questioning .eye`引用`blink-once`）容易遗漏`@keyframes`定义
- **新增动画规范**：添加新CSS动画时，必须同时添加`.companion-body.ai-xxx`选择器和`@keyframes ai-xxx`定义
- **27个AI状态动画清单**：每个AI_STATES条目的`bodyClass`字段必须对应一个完整的CSS动画定义（含选择器+@keyframes）

### 10.33 API端点路径遍历防护

API端点校验必须防止路径遍历攻击，仅允许`/api/`开头的合法路径：

```javascript
function isValidEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/')) return false;
  try {
    var pathname = new URL(endpoint, 'http://localhost').pathname;
    if (pathname.includes('..')) return false;
    return pathname.startsWith('/api/');
  } catch {
    return false;
  }
}
```

- **攻击向量**：`/api/../../etc/passwd` 以 `/api/` 开头但通过 `..` 遍历到非API路径
- **双重校验**：先检查字符串前缀，再用 `new URL()` 规范化路径后二次校验
- **`..` 检测**：规范化后的路径中不应包含 `..` 段
- **异常兜底**：`new URL()` 对非法URL抛出异常时返回 `false`

### 10.34 HTTP响应大小限制

代理API的HTTP响应必须设置大小上限，防止内存耗尽攻击：

```javascript
var MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
res.on('data', (chunk) => {
  size += chunk.length;
  if (size > MAX_RESPONSE_SIZE) { req.destroy(); safeResolve({ ok: false, ... }); return; }
  data += chunk;
});
```

- **攻击向量**：后端被攻击返回海量数据，或恶意响应持续发送数据，导致主进程内存耗尽
- **5MB上限**：API响应通常远小于此值，5MB足以覆盖所有正常场景
- **即时中断**：超过限制时立即 `req.destroy()` 中止连接，不再累加数据

### 10.35 Promise超时双重resolve防护

HTTP请求超时与错误回调可能同时触发resolve，必须使用幂等resolve模式：

```javascript
var resolved = false;
function safeResolve(val) { if (!resolved) { resolved = true; resolve(val); } }
```

- **问题场景**：`req.setTimeout()` 触发后调用 `req.destroy()`，`destroy()` 又触发 `error` 事件，两个回调都调用 `resolve()`
- **Promise幂等性**：虽然Promise只resolve一次，第二次调用无效，但依赖此行为属于逻辑不清晰
- **safeResolve模式**：用 `resolved` 标志确保只执行一次，逻辑清晰且可审计

### 10.36 IPC参数NaN/Infinity防护

数值类型IPC参数必须同时校验 `typeof`、`isFinite` 和范围：

```javascript
if (typeof w !== 'number' || !isFinite(w) || w < 100 || w > 4000) return;
```

- **NaN穿透**：`typeof NaN === 'number'` 为 `true`，`NaN < 100` 和 `NaN > 4000` 都为 `false`，因此 `NaN` 会通过纯范围校验
- **Infinity穿透**：`Infinity > 4000` 为 `true`，但 `Infinity` 不是有效尺寸
- **isFinite**：`isFinite(NaN)` 和 `isFinite(Infinity)` 都返回 `false`，是最佳防护
- **适用范围**：所有数值IPC参数（moveWindow的dx/dy、setWindowSize的w/h等）

### 10.37 事件回调参数类型校验

preload脚本暴露的事件监听API必须校验callback参数类型：

```javascript
onSpeech: (callback) => {
  if (typeof callback !== 'function') return;
  // ... 注册监听器
},
```

- **问题场景**：传入非函数值（如 `undefined`、字符串、对象），在IPC事件触发时调用 `callback()` 抛出TypeError
- **IPC监听器失效**：异常在 `ipcRenderer.on` 回调中抛出时，可能导致该监听器后续不再触发
- **静默返回**：类型不匹配时静默返回，不注册无效监听器

### 10.38 递归setTimeout替代setInterval实现随机间隔

需要随机间隔的定时任务必须使用递归setTimeout模式，而非setInterval：

```javascript
function scheduleBlink() {
  state.blinkInterval = setTimeout(function () {
    blink();
    if (Math.random() < 0.25) setTimeout(blink, 180);
    scheduleBlink();
  }, 2800 + Math.random() * 2200);
}
scheduleBlink();
```

- **问题场景**：`setInterval(fn, 2800 + Math.random() * 2200)` 中随机值只在首次调用时计算一次，后续所有间隔都相同
- **递归setTimeout**：每次回调结束后重新计算随机间隔，实现真正的随机间隔
- **清理方式**：从`clearInterval`改为`clearTimeout`，`state.blinkInterval`存储的是timeout ID

### 10.39 mousemove监听器合并

多个模块需要响应mousemove事件时，必须合并为1个统一的监听器：

```javascript
document.addEventListener('mousemove', function (e) {
  // 眼球追踪
  state.mousePos = { x: e.clientX, y: e.clientY };
  updatePupils();
  resetIdle();
  // 点击穿透
  if (state.clickThroughEnabled) { /* ... */ }
  // 拖拽
  if (state.handleDragMove) state.handleDragMove(e);
});
```

- **性能问题**：3个独立mousemove监听器每次鼠标移动触发3次回调，合并为1次
- **模块解耦**：各模块的逻辑通过函数引用（如`state.handleDragMove`）注入，而非独立注册监听器
- **优先级**：眼球追踪 > 点击穿透 > 拖拽，按此顺序执行

### 10.40 CSS filter属性不可覆盖drop-shadow

所有设置`filter`属性的选择器必须同时包含`drop-shadow`，不可丢失基础发光效果：

```css
.companion-body.sleep-deep {
  filter: brightness(.85) drop-shadow(0 8px 32px var(--skin-drop-shadow));
}
```

- **问题场景**：`.companion-body`基础样式设置了`filter: drop-shadow(0 8px 32px var(--skin-drop-shadow))`，但睡眠/DND/时间主题等6个选择器用`filter: brightness(...)`完全替换了filter值，导致角色失去发光效果
- **CSS filter特性**：`filter`属性不可部分覆盖，新值会完全替换旧值
- **适用范围**：所有`.companion-body`上设置`filter`的选择器都必须包含`drop-shadow`

### 10.41 CSS自定义属性必须先定义后使用

所有CSS自定义属性（`var(--xxx)`）必须在`:root`或对应选择器中定义后才能引用：

- **`--text-dim`**：4处引用（`.vibe-name`/`.sa-name`/`.ext-name`/`.sdd-name`）但从未定义，导致文字颜色失效
- **定义规范**：新增自定义属性时，必须先在`:root`中添加定义，再在业务样式中引用
- **审查方法**：搜索所有`var(--xxx)`引用，确认每个变量都有对应的定义
- **回退值**：对于JS动态设置的变量（如`--arm-angle`、`--tx`/`--ty`），应提供CSS回退值：`var(--arm-angle, 5deg)`

### 10.42 API认证令牌传递

代理API请求必须支持Bearer Token认证，从环境变量读取令牌：

```javascript
const HARNESS_API_TOKEN = process.env.HARNESS_API_TOKEN || '';

function proxyAPI(endpoint) {
  const headers = HARNESS_API_TOKEN ? { Authorization: `Bearer ${HARNESS_API_TOKEN}` } : {};
  const req = http.get(url, { headers }, (res) => { ... });
}
```

- **环境变量**：`HARNESS_API_TOKEN`，未设置时不发送Authorization头（开发模式localhost免认证）
- **生产环境**：必须设置`HARNESS_API_TOKEN`，否则除`/api/health`外的所有端点返回401
- **postAPI同步**：POST请求也必须携带相同的Authorization头
- **安全原则**：令牌从环境变量读取，不硬编码在代码中

### 10.43 API端点数据格式兼容

后端API返回的数据格式必须与前端companion.js期望的格式一致：

- **`/api/health`**：必须包含`phase`/`currentPhase`（当前执行阶段）、`tokenUsage`（已用Token数）、`tokenBudget`（Token预算）、`version`（版本号）
- **`/api/agents`**：每个Agent必须包含`status`（idle/active/running）、`running`（布尔值）、`name`（显示名称）
- **新增字段原则**：后端新增字段时，前端代码必须同步更新回退逻辑（DEMO数据）
- **防御性读取**：前端使用`data.phase || data.currentPhase || '待命'`模式，兼容字段名变更

### 10.44 CSS死规则清理

CSS中不得存在永远不会被JS触发的选择器规则：

- **检查方法**：搜索所有`.companion-body.xxx`选择器，确认JS中有对应的`classList.add('xxx')`调用
- **常见死规则**：JS使用`mood-energetic`（添加到`#companion`），但CSS中存在`.companion-body.energetic`（永远不会匹配）
- **修复原则**：移除死规则，或将选择器修正为JS实际使用的类名路径（如`.mood-energetic .companion-body`）
- **定期审查**：每次新增CSS动画时，验证对应的JS触发路径

### 10.45 DOM元素null安全防护

`els`对象中的DOM引用必须在`init()`中完成赋值后进行完整性验证：

- **关键元素验证**：使用`REQUIRED_ELS`数组定义必须存在的元素，缺失时`console.error`并阻止后续初始化
- **非关键元素守卫**：不在`REQUIRED_ELS`中的元素（如`els.head`、`els.aura`、`els.zzz`等），访问前必须添加`if (els.xxx)`守卫
- **事件监听器绑定**：对非关键元素调用`addEventListener`前必须检查元素存在性，否则整个函数链会中断
- **异步回调守卫**：`setTimeout`/`Promise.then`回调中访问`els.*`时，元素可能已被移除，必须添加null检查
- **死属性清理**：赋值后从未使用的`els`属性应从`init()`中移除，减少无效DOM查询

```javascript
// 关键元素验证
var REQUIRED_ELS = ['body', 'companion', 'leftEye', 'rightEye', 'mouth', 'speechBubble', 'speechText', 'contextMenu', 'miniPanel', 'fxLayer', 'coreLight'];
var missing = REQUIRED_ELS.filter(function (k) { return !els[k]; });
if (missing.length) { console.error('[Companion] 关键DOM元素缺失:', missing.join(', ')); return; }

// 非关键元素守卫
if (els.head) els.head.addEventListener('mouseenter', handler);
if (els.aura) els.aura.classList.add('active');

// 异步回调守卫
setTimeout(function () { if (els.levelUpOverlay) els.levelUpOverlay.classList.remove('visible'); }, 2500);
```

### 10.46 innerHTML安全替代

所有DOM内容清空操作必须使用`textContent = ''`替代`innerHTML = ''`：

- **原因**：`innerHTML`即使赋空字符串也会触发HTML解析器，且安全扫描工具会将其标记为XSS风险
- **适用场景**：清空容器内容（粒子容器、事件日志、特效层等）
- **例外**：无。所有清空操作统一使用`textContent`
- **用户内容注入**：显示用户输入或API数据时，必须使用`createElement`+`textContent`，禁止`innerHTML`拼接

### 10.47 SKINS配置表键存在性校验

访问`SKINS[skinId]`前必须验证键存在：

- **switchSkin入口守卫**：`if (!SKINS[skinId]) return;`，防止无效皮肤ID导致`TypeError`
- **init()中应用皮肤**：`if (state.currentSkin !== 'robot' && SKINS[state.currentSkin])`双重守卫
- **brandBadge访问**：`if (els.brandBadge) els.brandBadge.textContent = SKINS[skinId].badge`
- **防御场景**：localStorage被篡改、代码bug传入无效skinId、未来新增皮肤但SKINS表未更新

### 10.48 API数据兼容性防护

处理来自后端API的数据时，必须兼容多种数据格式：

- **Agent状态字段**：同时支持`status`、`state`、`running`三种字段，使用`a.status || a.state || ''`获取状态字符串
- **数组元素类型守卫**：`if (!a || typeof a !== 'object') return false`过滤非对象元素
- **布尔值精确比较**：`a.running === true`而非`a.running`（falsy值如0、空字符串不应视为true）
- **数据源兼容**：`data.agents || data`支持嵌套和扁平两种数据结构
- **面板信息显示**：所有`els.infoXxx`赋值前添加null守卫，API数据不可用时回退到演示数据

### 10.49 CSS浏览器前缀完整性

所有需要浏览器前缀的CSS属性必须同时提供标准属性和`-webkit-`前缀版本：

- **backdrop-filter**：必须同时提供`-webkit-backdrop-filter`和`backdrop-filter`
- **user-select**：必须同时提供`-webkit-user-select`和`user-select`
- **clip-path**：必须同时提供`-webkit-clip-path`和`clip-path`
- **CSS自定义属性回退值**：`var()`调用必须提供回退值，如`var(--arm-angle, 5deg)`、`var(--tx, 0px)`、`var(--ty, 0px)`
- **审查方法**：搜索所有使用实验性CSS属性的代码，确认前缀完整性

### 10.50 CSS选择器与DOM结构一致性

CSS选择器必须与index.html中的DOM结构一致，兄弟选择器（`+`、`~`）只能匹配后续兄弟元素：

- **DOM顺序审查**：编写`A:hover ~ B`选择器前，必须确认B在A之后；若B在A之前，选择器永远不会匹配
- **JS替代方案**：当CSS选择器因DOM顺序无法匹配时，通过JS动态添加/移除类名实现交互效果
- **环境光环hover**：`.ambient-ring`在`.companion-body`之前，CSS `~`选择器无法匹配，改用JS `mouseenter/mouseleave`添加`.active`类
- **猫耳hover**：`.companion-antenna`在`.companion-head`之前，CSS后代选择器无法匹配，改用JS添加`.cat-ear-active`类
- **定期审查**：每次修改index.html的DOM结构后，验证相关CSS选择器是否仍然有效

### 10.51 xpForLevel除零与无限循环防护

成长系统中的XP计算必须防止除零和无限循环：

- **xpForLevel输入验证**：`typeof lv === 'number' && lv >= 1 && isFinite(lv)`，非法输入返回默认值80
- **addXP安全循环**：while循环添加`needed > 0`条件和`safetyLimit`计数器（上限50次），防止极端情况下的无限循环
- **updateGrowthUI除零防护**：`g.xp / needed`前确认`needed > 0`
- **防御场景**：localStorage被篡改导致level为NaN/0/负数、代码bug传入非法level值

### 10.52 主进程错误处理与日志规范

Electron主进程中的错误处理不得静默吞没异常：

- **app.whenReady().catch()**：必须添加catch处理器，记录错误日志并优雅退出
- **registerShortcuts catch**：空catch块必须至少输出`console.warn`，快捷键注册失败是重要运行时事件
- **JSON解析失败**：catch块中记录解析失败的端点路径和错误信息，便于调试
- **IPC处理器catch**：窗口操作（setPosition/getBounds等）的catch块可以静默（Electron API可能抛出瞬态错误），但应在开发模式下输出日志
- **setIgnoreMouseEvents参数验证**：`ignore`参数必须为boolean类型，`options`必须为object类型

### 10.53 主进程常量提取与URL安全化

主进程中的硬编码值必须提取为命名常量：

- **窗口尺寸**：`WIN_WIDTH`/`WIN_HEIGHT`替代硬编码的276/380
- **窗口偏移**：`WIN_OFFSET_X`/`WIN_OFFSET_Y`替代硬编码的310/420，createWindow和reset-position共享同一常量
- **URL构造安全化**：`proxyAPI`/`postAPI`中使用`new URL(endpoint, 'http://localhost').pathname`替代直接拼接endpoint，防止URL编码绕过
- **MAX_RESPONSE_SIZE**：使用`const`声明而非`var`，与其他常量保持一致

### 10.54 定时器孤儿防护

所有`setInterval`/`setTimeout`赋值给state属性前，必须先清除可能存在的旧定时器：

- **startRoaming入口清理**：调用`stopRoaming()`确保旧漫游周期完全终止后再启动新周期
- **scheduleRoamStep入口清理**：`if (state.roamStepTimer) clearTimeout(state.roamStepTimer)` + `if (state.roamWalkInterval) clearInterval(state.roamWalkInterval)`
- **防御场景**：用户快速连续点击"漫游"菜单项、startRoaming在前一个漫游周期未结束时被调用
- **后果**：旧interval引用被覆盖丢失后变成"孤儿定时器"，窗口持续移动且无法停止

### 10.55 事件处理器默认行为控制

所有自定义交互事件处理器必须正确控制浏览器默认行为：

- **mousedown（拖拽）**：必须`e.preventDefault()`防止文本选中
- **dblclick**：必须`e.preventDefault()`防止双击选中周围文本
- **contextmenu**：必须`e.preventDefault()`防止浏览器默认右键菜单
- **keydown（快捷键）**：必须`e.preventDefault()`防止浏览器默认快捷键行为
- **按钮type属性**：所有`<button>`元素必须指定`type="button"`，防止默认submit行为

### 10.56 CSS自定义变量声明规范

所有CSS自定义变量（包括JS动态设置的）必须在`:root`中声明默认值：

- **JS动态变量声明**：`--arm-angle: 5deg`、`--tx: 0px`、`--ty: 0px`等由JS `style.setProperty()`动态设置的变量，必须在`:root`中声明默认值
- **原因**：CSS自定义属性未声明时为空字符串（而非回退值），某些CSS函数（如`calc()`）对空字符串的处理可能不符合预期
- **回退值保留**：`var(--arm-angle, 5deg)`中的回退值仍然保留，作为双重保险
- **审查方法**：搜索JS中所有`style.setProperty('--xxx'`调用，确认对应变量在`:root`中有声明

### 10.57 可访问性（a11y）规范

桌面伙伴的HTML结构必须满足基本的可访问性要求：

- **按钮type属性**：所有`<button>`必须指定`type="button"`，防止在表单上下文中触发默认submit行为
- **ARIA角色**：权限卡片`role="dialog"`、上下文菜单`role="menu"`、面板`role="complementary"`、语音气泡`role="status"`
- **ARIA标签**：`aria-label`提供简短描述，`aria-live="polite"`标记动态更新区域
- **进度条角色**：`permTimeoutBar`添加`role="progressbar"`和`aria-label`
- **AudioContext可用性**：`playSound`函数在AudioContext不可用时提前返回，而非依赖try-catch隐式容错

### 10.58 思想钻石（Thought Diamond）融合规范

Thought-Retriever核心概念"检索思想而非原始数据"已融合为ThoughtDiamond模块：

- **四品级分层**：RAW(0-0.5) → CUT(0.5-0.75) → POLISHED(0.75-0.9) → DIAMOND(0.9-1.0)，按置信度自动分级
- **五步循环引擎**：检索思想 → 生成回答 → 提炼思想 → 查重去冗 → 更新记忆，ThoughtRetrieverCycle已集成第六步diamondRefine
- **双重过滤网**：置信度过滤（丢弃<0.5的产出）+ 去重检测（Jaccard相似度≥0.75拒绝冗余）
- **根数据映射**：高度抽象的思想钻石可追溯到底层原始数据块，`rootRefs`数组存储引用ID
- **配置表THOUGHT_DIAMOND**：4项能力（retrieving/distilling/deduplicating/updating），每项含name/icon/desc/color/hudClass/tier/step
- **5层扩展约定**：新增思想钻石能力时必须同步更新5处：THOUGHT_DIAMOND配置表 + AI_STATES + HUD_STATE_MAP + 右键菜单(index.html) + 面板卡片(index.html)
- **容量控制**：默认最多500颗钻石，超出按置信度排序淘汰最低品级
- **自主进化**：交互即成长，思考即进化——每次五步循环都产生新的思想钻石或升级现有钻石品级

### 10.59 CSS复合选择器与多类名元素

当多个CSS类名添加到同一元素时，必须使用复合选择器（无空格）而非后代选择器：

- **错误写法**：`.skin-ghost .mood-energetic .companion-body` — 后代选择器要求`.mood-energetic`是`.skin-ghost`的后代
- **正确写法**：`.skin-ghost.mood-energetic .companion-body` — 复合选择器匹配同时拥有两个类名的元素
- **审查方法**：搜索CSS中同一元素可能同时拥有的多个类名组合，确认选择器语法正确
- **常见场景**：皮肤类（`skin-xxx`）+ 心情类（`mood-xxx`）同时添加在`#companion`上

### 10.60 CSS动画变量引用完整性

JS通过`style.setProperty()`设置的CSS自定义变量必须在对应的`@keyframes`动画中使用：

- **--cx变量**：`spawnConfetti()`为每个纸屑设置`--cx`水平漂移值，`@keyframes fx-confetti-fall`必须使用`translateX(var(--cx, 0px))`
- **--arm-angle变量**：`setArmAngle()`设置手臂角度，CSS动画必须使用`rotate(var(--arm-angle, 5deg))`
- **--tx/--ty变量**：漫游/拖拽偏移量，CSS transform必须使用`translate(var(--tx, 0px), var(--ty, 0px))`
- **审查方法**：搜索JS中所有`style.setProperty('--xxx'`调用，确认对应变量在`@keyframes`中被引用

### 10.61 shell.openExternal协议校验

Electron主进程中所有`shell.openExternal()`调用必须校验URL协议：

```javascript
function safeOpenExternal(url) {
  try {
    var parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    shell.openExternal(url);
  } catch {}
}
```

- **攻击向量**：`shell.openExternal('file:///etc/passwd')`或自定义协议处理器可导致远程代码执行
- **协议白名单**：仅允许`http:`和`https:`协议
- **异常兜底**：`new URL()`对非法URL抛出异常时静默返回
- **适用范围**：所有`shell.openExternal`调用点（托盘菜单、IPC handler等）

### 10.62 webContents.send安全封装

异步操作后调用`webContents.send()`必须检查窗口是否已销毁：

```javascript
function safeSend(channel, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, ...args); } catch {}
}
```

- **问题场景**：`await proxyAPI()`期间用户关闭窗口，`webContents`已销毁，`send()`抛出`Error: Object has been destroyed`
- **isDestroyed()检查**：Electron窗口关闭后`mainWindow`可能非null但`webContents`已销毁
- **try-catch兜底**：即使通过`isDestroyed()`检查，仍可能因竞态条件抛出异常

### 10.63 macOS窗口恢复机制

macOS关闭窗口后不退出应用，托盘操作必须能重建窗口：

- **问题场景**：`mainWindow = null`后，托盘"显示伙伴"和单击仅检查`if (mainWindow)`，无法恢复窗口
- **修复方案**：`if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); }`
- **skipTaskbar影响**：设置`skipTaskbar: true`后Dock图标不显示，用户唯一恢复途径是托盘
- **全局快捷键同步**：`CommandOrControl+Shift+H`也需支持窗口重建

### 10.64 HTTP响应体消费与连接池回收

Node.js `http.get`返回的响应必须消费响应体（`res.resume()`），否则socket不会回收到连接池：

```javascript
const req = http.get(url, (res) => {
  res.resume(); // 丢弃响应体，释放socket
  safeResolve(res.statusCode === 200);
});
```

- **问题场景**：`checkHarnessAPI()`只读状态码不读body，底层socket被占用不释放
- **keep-alive影响**：每次健康检查占用一个socket，频繁轮询导致连接耗尽
- **res.resume()**：告诉Node.js丢弃响应体，立即释放socket回连接池

### 10.65 HTTP响应体拼接中止标志

HTTP响应体大小超限时，`req.destroy()`是异步操作，后续`data`事件仍可能触发：

```javascript
var aborted = false;
res.on('data', (chunk) => {
  if (aborted) return; // 跳过已中止后的数据
  size += chunk.length;
  if (size > MAX_RESPONSE_SIZE) { aborted = true; req.destroy(); safeResolve({...}); return; }
  data += chunk;
});
```

- **问题场景**：`req.destroy()`后仍有已缓冲的`data`事件触发，`data += chunk`无意义地拼接字符串
- **aborted标志**：在`req.destroy()`前设置，后续`data`事件检查标志后跳过
- **内存保护**：防止超限后继续累加字符串造成额外内存开销

### 10.66 POST请求体大小限制

代理API的POST请求必须设置请求体大小上限：

```javascript
const payload = JSON.stringify(body || {});
if (Buffer.byteLength(payload) > 1024 * 1024) {
  safeResolve({ ok: false, data: null, status: 0, error: 'payload too large' });
  return;
}
```

- **攻击向量**：恶意或异常的渲染进程发送超大请求体，导致内存压力和后端过载
- **1MB上限**：API命令请求体通常远小于此值
- **字节长度**：使用`Buffer.byteLength()`计算UTF-8编码后的实际字节数，而非`String.length`

### 10.67 setIgnoreMouseEvents选项深度校验

IPC传入的`options`参数必须深度校验已知属性，而非直接透传：

```javascript
var safeOptions = {};
if (options && typeof options === 'object' && typeof options.forward === 'boolean') {
  safeOptions.forward = options.forward;
}
mainWindow.setIgnoreMouseEvents(ignore, safeOptions);
```

- **攻击向量**：IPC从渲染进程传入的`options`可能包含任意属性
- **Electron API**：`setIgnoreMouseEvents`仅接受`{ forward: boolean }`
- **白名单模式**：只提取已知属性，忽略所有未知属性

### 10.68 托盘销毁与查询参数保留

应用退出时必须显式销毁托盘，API端点URL构造必须保留查询参数：

- **托盘销毁**：`app.on('will-quit', ...)`中调用`if (tray) { tray.destroy(); tray = null; }`，Windows上防止托盘图标残留
- **查询参数保留**：`new URL(endpoint, 'http://localhost')`后使用`parsed.pathname + parsed.search`，而非仅`parsed.pathname`
- **URL构造完整性**：`/api/agents?status=active`中的`?status=active`不应被丢弃

### 10.69 className直接赋值覆盖风险

对可能拥有多个CSS类的元素，必须使用`classList`操作而非直接`className`赋值：

- **问题场景**：`els.coreLight.className = 'core-light connected'`覆盖了`core-hover`类，中断悬停动画
- **classList操作**：`els.coreLight.classList.remove('error'); els.coreLight.classList.add('connected');`
- **适用范围**：所有可能同时拥有多个动态类的元素（状态指示器、皮肤元素等）
- **例外**：状态点（`statusDot`）等只拥有固定类名的元素可使用`className`赋值

### 10.70 playSound异步回调异常防护

AudioContext关闭后，setTimeout回调中操作振荡器可能抛出`InvalidStateError`：

```javascript
setTimeout(function () { try { osc.frequency.value = 659; } catch (e) {} }, 100);
setTimeout(function () { try { osc.stop(); } catch (e) {} }, 400);
```

- **问题场景**：`osc.start()`后AudioContext被关闭（如页面卸载），setTimeout回调执行时`osc.frequency.value`抛异常
- **try-catch包裹**：每个setTimeout回调都必须独立包裹try-catch
- **外层catch无效**：setTimeout回调在新的执行上下文中运行，外层try-catch无法捕获

### 10.71 配置表hudClass与HUD_STATE_MAP一致性

五配置表中的`hudClass`属性必须与`HUD_STATE_MAP`中的对应值一致：

- **问题场景**：`THOUGHT_DIAMOND.updating.hudClass = 'hud-converged'`但`HUD_STATE_MAP.updating = 'hud-happy'`
- **唯一数据源原则**：`HUD_STATE_MAP`是HUD显示的唯一数据源，配置表中的`hudClass`必须与之保持一致
- **审查方法**：每次修改配置表的`hudClass`时，同步检查`HUD_STATE_MAP`中对应条目

### 10.72 IDLE_ACTIONS与SPEECH键名映射

空闲动作名称与语音台词键名不一致时，必须添加映射层：

```javascript
var speechKeyMap = { look: 'lookAround' };
var speechKey = speechKeyMap[actionName] || actionName;
if (SPEECH[speechKey]) showSpeech(randomFrom(SPEECH[speechKey]), 2500);
```

- **问题场景**：`IDLE_ACTIONS`包含`'look'`但`SPEECH`中对应键为`'lookAround'`，导致空闲动作无语音
- **映射层**：`speechKeyMap`将动作名映射到SPEECH键名，避免修改CSS类名或SPEECH键名
- **扩展性**：新增空闲动作时，若动作名与SPEECH键名不同，需在映射表中添加对应关系

### 10.73 state对象属性完整性声明

所有运行时动态赋值的state属性必须在初始`state`对象中声明：

- **idleActionTimer**：`onIdle()`中赋值，`beforeunload`中清理，必须在state中声明
- **handleDragMove**：`setupDrag()`中赋值为闭包，必须在state中声明
- **excitedTimer**：`triggerExcited()`中赋值，必须在state中声明并纳入`beforeunload`清理
- **原则**：任何通过`state.xxx =`赋值的属性，都必须在初始`state`对象中有对应声明（值可为`null`）

### 10.74 DreamOutcomes淘汰逻辑变量声明

Map淘汰逻辑中的循环赋值变量必须使用`let`而非`const`声明：

```javascript
let oldestKey = null; // 正确：后续需要赋值
let oldestTime = Infinity;
for (const [id, e] of this._outcomes) {
  if (e.definedAt) {
    const t = new Date(e.definedAt).getTime();
    if (Number.isFinite(t) && t < oldestTime) {
      oldestTime = t;
      oldestKey = id; // TypeError if const
    }
  }
}
```

- **问题场景**：`const oldestKey = null`后`oldestKey = id`抛出`TypeError: Assignment to constant variable`
- **后果**：Map达到上限后淘汰逻辑永远无法执行，Map无限增长
- **审查方法**：搜索所有`const`声明的变量，确认后续无赋值操作

### 10.75 DreamEngine _dreaming标志位置

`_dreaming = false`必须放在`emit()`调用之前，而非之后：

- **问题场景**：`emit('dream-complete', result)`之后的代码抛出异常时，`_dreaming`仍为`true`
- **后果**：后续所有`startDreaming()`调用都返回`null`，做梦功能永久卡死
- **修复方案**：将`this._dreaming = false`移到`this.emit('dream-complete', result)`之前
- **原则**：状态标志复位应在事件发射之前完成，确保即使emit后的代码异常，状态也已正确复位

### 10.76 DreamBridge事件名与DreamEngine对齐

DreamBridge监听的事件名必须与DreamEngine实际emit的事件名一致：

- **错误事件名**：`'notes-merged'`、`'notes-generated'` — DreamEngine从未emit这些事件
- **正确事件名**：`'dream-complete'`（做梦完成）、`'dream-error'`（做梦失败）
- **后果**：桥接功能完全失效，DreamEngine产出无法传递到LlmWiki
- **审查方法**：搜索所有`_addListener`调用，确认事件名与被监听模块的`emit`调用一致

### 10.77 ThoughtDiamond统计计数器语义

`_stats`中的计数器名称必须准确反映实际行为：

- **duplicatesMerged**（原duplicatesRejected）：找到重复项时执行合并而非拒绝，计数器名称应反映"合并"语义
- **diamondsDowngraded**：声明但从未递增，属于死代码字段，保留用于未来降级功能
- **原则**：计数器名称应与实际行为一致，避免维护者产生错误理解

### 10.78 BrainMemory合并保留完整metadata

合并相似条目时必须保留原有metadata的所有字段：

```javascript
keeper.metadata = {
  ...keeperMeta, // 保留原有category/source/ttl等字段
  tags: [...new Set([...(keeperMeta.tags ?? []), ...(removedMeta.tags ?? [])])],
  confidence: Math.max(keeperMeta.confidence ?? 0, removedMeta.confidence ?? 0),
};
```

- **问题场景**：合并时`keeper.metadata`被完全替换为只含`tags`和`confidence`的新对象，丢失`category`/`source`/`ttl`等字段
- **展开运算符**：`...keeperMeta`先展开保留所有原有字段，再覆盖需要合并的字段
- **原则**：合并操作应是增量式的，不应丢失被合并对象中未参与合并逻辑的字段

### 10.79 ThoughtDiamond模块导出

新增的Thought子系统模块必须在`src/runtime/thought/index.js`中导出：

- **ThoughtDiamond**：完整的四品级分层+双重过滤网+根数据映射模块
- **导出位置**：按字母序插入到`ThoughtDeduplicator`和`ThoughtExtractor`之间
- **外部访问**：`require('./thought').ThoughtDiamond`而非`require('./thought/thought-diamond')`
- **原则**：所有thought子系统的公共模块都通过index.js统一导出，外部代码不应直接引用子文件

### 10.80 clearFx完整清理特效DOM元素

`clearFx()`必须清理所有特效DOM元素，包括不在`fxLayer`内的元素：

- **fxLayer内容**：`els.fxLayer.textContent = ''`清空闪光/彩虹/音符等特效
- **companion上的元素**：`spawnBurstParticles()`和`spawnRipple()`创建的`.burst-particle`和`.ripple`附加在`els.companion`上
- **清理方式**：`els.companion.querySelectorAll('.burst-particle, .ripple').forEach(el => el.remove())`
- **快速连续触发**：特效仅靠自身setTimeout清理，快速触发时可能积累大量临时DOM元素

### 10.81 showMinimalNotification通知数量限制

迷你模式通知必须限制同时存在的数量，防止通知堆叠：

```javascript
function showMinimalNotification(text, type) {
  if (!state.minimalMode) return;
  els.companion.querySelectorAll('.minimal-notif').forEach(function (el) { el.remove(); });
  // ... 创建新通知
}
```

- **问题场景**：多个权限请求或状态变化短时间内频繁触发，通知元素堆叠
- **先清后建**：创建新通知前移除所有已有通知，确保同一时间只有一条通知可见
- **适用范围**：所有创建临时DOM元素并设置自动消失的函数

### 10.82 addXP NaN/Infinity防护

addXP必须防御NaN和Infinity输入，防止成长系统数据损坏：

```javascript
function addXP(amount, reason, countInteraction) {
  if (typeof amount !== 'number' || !(amount > 0) || !isFinite(amount)) return;
  // ...
}
```

- **问题场景**：`parseFloat(undefined)` → NaN，`Infinity`通过计算传入
- **三重守卫**：`typeof`检查类型 + `!(amount > 0)`排除NaN/零/负数 + `isFinite`排除Infinity
- **适用范围**：所有接受数值输入并参与累加计算的函数

### 10.83 showPermissionCard手动状态标志

权限卡片显示时必须设置`state.manualState = true`，防止setAIState内部addXP重复奖励：

```javascript
function showPermissionCard(agent, action) {
  // ...
  state.manualState = true;
  setAIState('notification');
  addXP(3, '权限请求', false);
  // ...
}
```

- **问题场景**：showPermissionCard调用setAIState('notification')，setAIState内部又调用addXP(3)，导致双重XP奖励
- **手动状态优先**：`state.manualState = true`阻止API轮询自动切换状态
- **非互动XP**：权限请求的XP奖励不应计入互动次数

### 10.84 pollOptimizationStatus服务不可用状态重置

优化状态轮询在服务不可用时必须重置卡死的optimizing状态：

```javascript
if (!res || !res.ok || !res.data || !res.data.available) {
  if (state.aiState === 'optimizing' && !state.manualState) {
    setAIState('idle');
    logEvent('优化服务不可用，状态已重置', 'warning');
  }
  return;
}
```

- **问题场景**：优化服务重启或崩溃后，伙伴停留在optimizing状态永不恢复
- **条件重置**：仅当当前状态为optimizing且非手动设置时才自动重置
- **适用范围**：所有依赖外部API的状态轮询函数

### 10.85 FX_BODY_CLASSES完整覆盖所有动画类

FX_BODY_CLASSES必须包含所有可能添加到body的动画CSS类，确保clearFx()能完整清理：

```javascript
var FX_BODY_CLASSES = [
  'fx-dance', 'fx-sing', 'fx-hearteyes', 'fx-rainbow', 'fx-magic',
  'fx-jump', 'fx-shake', 'fx-bow', 'fx-celebrate', 'fx-tremble',
  'idle-sweep', 'idle-juggle', 'idle-carry', 'idle-yawn', 'idle-stretch',
  'idle-lookAround', 'idle-breathe', 'idle-think', 'idle-nod', 'idle-peek',
  'ai-thinking', 'ai-typing', 'ai-building', 'ai-conducting', 'ai-happy',
  'ai-reviewing', 'ai-architecting', 'ai-validating', 'ai-designing',
  'ai-integrating', 'ai-selfhealing', 'ai-adapting', 'ai-memorizing',
  'ai-skilling', 'ai-connecting', 'ai-delegating', 'ai-automating',
  'ai-specifying', 'ai-syncing', 'ai-questioning', 'ai-planning',
  'ai-error', 'ai-notification',
  'waving', 'look-around-click', 'excited', 'wake-up-startle'
];
```

- **问题场景**：新增AI状态但未更新FX_BODY_CLASSES，导致clearFx()无法清理残留类
- **5层扩展约定**：新增能力时必须同步更新5处：配置表 + AI_STATES + HUD_STATE_MAP + SPEECH + FX_BODY_CLASSES
- **适用范围**：所有通过`els.body.classList.add()`添加的动画类

### 10.86 switchSkin清理AI状态和特效

切换皮肤前必须清理当前AI状态和特效，防止旧状态CSS类残留：

```javascript
function switchSkin(skinId) {
  // ...
  clearFx();
  clearAIState();
  // ... 应用新皮肤
}
```

- **问题场景**：切换皮肤时旧的AI状态body类（如ai-thinking）残留，与新皮肤样式冲突
- **清理顺序**：先clearFx()清除特效，再clearAIState()清除AI状态类
- **适用范围**：所有会大幅改变DOM类名的操作

### 10.87 clearAIState重置mouth

clearAIState必须重置mouth元素为默认状态，防止旧mouth表情残留：

```javascript
function clearAIState() {
  Object.keys(AI_STATES).forEach(function (key) {
    if (AI_STATES[key].bodyClass) els.body.classList.remove(AI_STATES[key].bodyClass);
  });
  if (els.mouth) els.mouth.className = 'mouth';
  // ...
}
```

- **问题场景**：setAIState设置`els.mouth.className = 'mouth thinking'`后，clearAIState只移除body类但mouth仍显示thinking表情
- **重置为默认**：mouth的默认类名为`'mouth'`，不含任何修饰符
- **适用范围**：所有清除状态函数必须完整重置其管理的所有DOM属性

### 10.88 hidePermissionCard恢复前状态

隐藏权限卡片时应恢复到权限请求前的AI状态，而非硬编码为idle：

```javascript
function hidePermissionCard() {
  // ...
  var prevState = state.prevAiState && state.prevAiState !== 'notification'
    ? state.prevAiState : 'idle';
  setAIState(prevState);
  setMood(state.mood);
}
```

- **问题场景**：用户在thinking状态下收到权限请求，批准后状态被重置为idle而非恢复thinking
- **安全回退**：若prevAiState为notification（权限卡片自身），则回退到idle
- **适用范围**：所有临时状态覆盖场景，恢复时应回到前一个有意义的状态

### 10.89 showToast堆积限制

Toast通知必须限制同时显示的数量，防止大量通知堆叠：

```javascript
function showToast(message, type) {
  // ...
  if (els.toastContainer && els.toastContainer.children.length >= 5) {
    var oldest = els.toastContainer.children[0];
    if (oldest) oldest.remove();
  }
  // ... 创建新toast
}
```

- **问题场景**：快速连续触发多个事件（如批量权限请求），toast堆叠遮挡界面
- **FIFO淘汰**：超过5条时移除最早的toast
- **适用范围**：所有动态创建DOM元素并设置自动消失的函数

### 10.90 API轮询并发保护

API轮询必须防止并发请求，避免Promise堆积和状态竞争：

```javascript
function startApiPolling() {
  var polling = false;
  function poll() {
    if (polling) return;
    polling = true;
    api.proxyAPI(API_ENDPOINTS.health).then(function (res) {
      // ...
    }).catch(function () {
      // ...
    }).finally(function () { polling = false; });
  }
  // ...
}
```

- **问题场景**：网络延迟导致上一次poll的Promise还未resolve，新的poll已触发，请求堆积
- **finally释放**：无论成功或失败都必须释放polling标志
- **适用范围**：所有定时触发的异步轮询函数

### 10.91 睡眠阶段CSS类先清后加

进入睡眠状态前必须先清除所有旧睡眠CSS类，防止类累积：

```javascript
function onIdle() {
  state.isIdle = true;
  state.sleepStage = 1;
  SLEEP_CLASSES.forEach(function (cls) { els.body.classList.remove(cls); });
  els.body.classList.add('sleeping');
  // ...
}
```

- **问题场景**：若onIdle被多次调用（如resetIdle后重新触发），旧的sleep-dozing等类残留
- **先清后加**：与showMinimalNotification同样的模式
- **适用范围**：所有分阶段添加CSS类的函数

### 10.92 addXP互动计数分离

被动获得的XP（成就解锁、AI状态变化等）不应计入互动次数：

```javascript
function addXP(amount, reason, countInteraction) {
  // ...
  if (countInteraction !== false) state.growth.totalInteractions++;
  // ...
}

// 主动互动（默认计入）
addXP(2, '摸头');

// 被动奖励（不计入互动）
addXP(20, ACHIEVEMENTS[key].name, false);
addXP(3, 'AI状态: ' + cfg.label, false);
addXP(10, '连接框架', false);
```

- **问题场景**：成就解锁的20XP被计入totalInteractions，导致互动统计虚增
- **分类原则**：用户主动操作（点击/拖拽/菜单）→计入；系统被动奖励（成就/状态/连接）→不计入
- **适用范围**：所有addXP调用点

### 10.93 skinTransition定时器追踪

skin-transition的setTimeout必须存入state并在beforeunload中清理：

```javascript
state.skinTransitionTimer = setTimeout(function () {
  els.body.classList.remove('skin-transition');
  state.skinTransitionTimer = null;
}, 500);

// beforeunload中
clearTimeout(state.skinTransitionTimer);
```

- **问题场景**：快速连续切换皮肤，旧定时器在新皮肤上移除transition类
- **先清后设**：新定时器前先clearTimeout旧定时器
- **适用范围**：所有未追踪的setTimeout/setInterval

### 10.94 CSS动画性能：transform替代重排属性

CSS动画必须使用transform/opacity替代top/bottom/width/height，避免触发重排：

```css
/* 错误：触发重排 */
@keyframes fx-confetti-fall {
  0% { top: 20%; }
  100% { top: 100%; }
}

/* 正确：仅触发合成 */
@keyframes fx-confetti-fall {
  0% { transform: translateY(0); }
  100% { transform: translateY(120px); }
}
```

- **问题场景**：confetti/bubble/ripple动画使用top/bottom/width/height，每帧触发重排
- **transform优势**：GPU加速，不触发layout/paint，仅触发composite
- **适用范围**：所有@keyframes动画定义

### 10.95 optimization-loop stop()延迟期间Promise解除

optimization-loop的stop()在延迟期间调用时必须resolve挂起的Promise，防止永久挂起：

```javascript
stop() {
  // ...
  if (this._pendingDelayResolve) {
    this._pendingDelayResolve('stopped');
    this._pendingDelayResolve = null;
  }
}

_scheduleDelay(ms) {
  return new Promise(resolve => {
    this._pendingDelayResolve = resolve;
    this._delayTimer = setTimeout(() => {
      this._pendingDelayResolve = null;
      resolve('paused');
    }, ms);
  });
}
```

- **问题场景**：stop()清除了timer但未resolve Promise，await永远不返回
- **保存resolve引用**：在Promise构造函数中保存resolve到实例属性
- **适用范围**：所有使用await等待定时器的异步循环

### 10.96 agent-debug-loop reset()并发竞态防护

reset()必须与运行中的异步循环协调，防止状态不一致：

```javascript
reset() {
  this._aborted = true;  // 先通知运行中的循环终止
  this._resetting = true;
  // ... 重置状态
  this._resetting = false;
}

execute() {
  if (this._resetting) return;  // 防止在reset过程中启动新循环
  // ...
}
```

- **问题场景**：reset()直接修改状态，但运行中的循环在下一个检查点前继续使用旧状态
- **两阶段终止**：先设置_aborted让循环自行终止，再重置状态
- **适用范围**：所有具有异步循环且支持reset的对象

### 10.97 ai-code-trust-scorer衰减一致性

来源评分衰减必须在_updateSourceScore和decaySourceScores中保持一致：

```javascript
_updateSourceScore(source, newScore) {
  var data = this._sources.get(source);
  if (data) {
    var daysSinceUpdate = (Date.now() - data.lastUpdated) / 86400000;
    var decayedScore = data.score * Math.pow(this._decayRate, daysSinceUpdate);
    data.totalScore = decayedScore * data.samples;
    data.totalScore += newScore;
    data.samples++;
    data.score = data.totalScore / data.samples;
  }
  // ...
}

decaySourceScores() {
  this._sources.forEach(data => {
    data.score *= Math.pow(this._decayRate, daysSinceUpdate);
    data.totalScore = data.score * data.samples;  // 同步更新totalScore
  });
}
```

- **问题场景**：decaySourceScores修改score但_updateSourceScore通过totalScore/samples覆盖，衰减效果丢失
- **同步原则**：修改score时必须同步更新totalScore = score * samples
- **适用范围**：所有具有派生字段的评分系统

### 10.98 rbac-enforcer加载失败重置为deny-all

RBAC权限加载失败时必须重置为最严格默认权限，而非保留旧权限：

```javascript
load() {
  // ...
  if (this._loadErrors.length > 0) {
    this.agents = {};
    this._agentSkillSets = {};
    this.skills = {};
    this._loaded = false;
    // 日志：loadFailedResetToDenyAll
  }
}
```

- **问题场景**：配置文件损坏导致load()失败，但旧的权限数据仍有效，可能包含已撤销的权限
- **安全原则**：fail-closed（失败时拒绝所有）优于fail-open（失败时允许所有）
- **适用范围**：所有权限/认证/访问控制模块的加载逻辑

### 10.99 clearAIState必须重置state.aiState

清除AI状态的函数必须同时重置逻辑状态变量，否则后续setAIState会因早期返回而跳过视觉恢复：

```javascript
function clearAIState() {
  // ... 移除CSS类 ...
  state.aiState = 'idle';  // 必须重置！
}
```

- **问题场景**：clearAIState只移除CSS类但不重置state.aiState，后续setAIState('thinking')因state.aiState仍为'thinking'而直接return
- **影响面**：13个调用点（triggerIdleAction、resetIdle、switchSkin、所有trigger*函数）
- **适用范围**：所有"清除状态"函数必须同时重置对应的逻辑状态变量

### 10.100 String.replace的$模式注入防护

使用String.replace替换用户可控文本时，必须使用split/join模式或函数形式，防止$模式注入：

```javascript
// 错误：$模式注入风险
text.replace('{name}', name);  // name="$&Agent" → 替换结果包含匹配文本

// 正确：split/join模式
text.split('{name}').join(name);

// 正确：函数形式
text.replace('{name}', function() { return name; });
```

- **问题场景**：Agent名称来自API且包含`$&`/`$'`/`` $` ``/`$$`等模式，replace替换结果包含意外内容
- **适用范围**：所有使用replace替换用户可控文本的场景

### 10.101 mousemove事件监听器去重

同一事件上的监听器不能重复注册相同功能，防止每次事件触发时执行多次：

```javascript
// 错误：mousemove上注册了两个resetIdle
document.addEventListener('mousemove', function(e) {
  resetIdle();  // 第一次
  // ...
});
['mousemove', 'click', 'keydown'].forEach(function(evt) {
  document.addEventListener(evt, resetIdle);  // mousemove第二次
});

// 正确：统一在一处注册
document.addEventListener('mousemove', function(e) {
  // 不调用resetIdle，由下方统一注册处理
  // ...
});
['mousemove', 'click', 'keydown'].forEach(function(evt) {
  document.addEventListener(evt, resetIdle);
});
```

- **问题场景**：高频mousemove事件每次触发两次resetIdle，产生大量无用定时器操作
- **适用范围**：所有事件监听器注册，确保同一事件上无重复处理器

### 10.102 onLevelUp免打扰模式检查

升级动画中的音效、视觉特效和覆盖层必须检查DND模式，与showSpeech/showToast保持一致：

```javascript
function onLevelUp() {
  // showSpeech/showToast内部已有DND检查
  showSpeech(...);
  showToast(...);
  if (els.levelUpLevel) els.levelUpLevel.textContent = 'Lv.' + lv;  // 数据更新不受DND影响
  if (!state.dndMode) {
    playSound('levelup');
    showMinimalNotification(...);
    spawnConfetti(20);
    spawnBurstParticles(10);
  }
  logEvent(...);
}
```

- **问题场景**：DND模式下升级仍播放音效和显示粒子效果，打扰用户
- **数据与表现分离**：数据更新（levelUpLevel文本）不受DND影响，仅视觉/音效表现受DND控制
- **适用范围**：所有可能产生视觉/音效干扰的函数

### 10.103 API返回值类型安全：数组与对象兼容

IPC API返回值可能是数组或对象，必须兼容两种格式：

```javascript
// 错误：假设返回值始终为数组
api.moveWindow(pos.x - current[0], pos.y - current[1]);  // current为对象时current[0]=undefined

// 正确：兼容数组和对象
var cx = Array.isArray(current) ? current[0] : (current && typeof current.x === 'number' ? current.x : 0);
var cy = Array.isArray(current) ? current[1] : (current && typeof current.y === 'number' ? current.y : 0);
api.moveWindow(pos.x - cx, pos.y - cy);
```

- **问题场景**：Electron IPC返回值格式在不同版本间可能变化，数组→对象或反之
- **防御性编程**：同时支持两种格式，并提供默认值（0）兜底
- **适用范围**：所有消费IPC API返回值的代码

### 10.104 processAgentData空闲时重置currentAgent

当所有Agent都空闲时必须重置currentAgent，否则同一Agent重新激活时不会触发挥手动画：

```javascript
if (activeAgents.length === 1) {
  // ... 更新currentAgent
} else {
  state.currentAgent = null;  // 必须重置！
}
```

- **问题场景**：Agent A活跃→所有Agent空闲→Agent A再次活跃，因currentAgent仍为A而跳过挥手动画
- **适用范围**：所有"当前选中项"的状态管理，当可选项为空时必须重置

### 10.105 双击事件XP防膨胀

双击事件同时触发click和dblclick，必须在dblclick处理器中重置单击的累计计数：

```javascript
companionEl.addEventListener('dblclick', function (e) {
  state.petCount = 0;              // 重置单击累计
  clearTimeout(state.petTimer);    // 清除单击定时器
  addXP(5, '双击打开');
  // ...
});
```

- **问题场景**：双击一次获得10XP（click 2XP + click 3XP + dblclick 5XP），远超设计意图
- **事件顺序**：click → click → dblclick，浏览器保证此顺序
- **适用范围**：所有同时处理click和dblclick的场景

### 10.106 Web Audio节点生命周期管理

OscillatorNode停止后必须断开所有连接的节点，防止Web Audio节点泄漏：

```javascript
var osc = audioCtx.createOscillator();
var gain = audioCtx.createGain();
osc.connect(gain);
gain.connect(audioCtx.destination);
osc.onended = function () {
  gain.disconnect();
  osc.disconnect();
};
osc.start();
osc.stop(audioCtx.currentTime + duration);
```

- **问题场景**：osc.stop()后gain仍连接到destination，Chromium对Web Audio节点的GC存在延迟
- **适用范围**：所有创建Web Audio节点的代码

### 10.107 GOAL_STATUS枚举完整性

状态枚举必须覆盖所有使用该枚举的代码路径，防止undefined状态：

```javascript
const GOAL_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ERROR: 'error',  // 必须定义！resume().catch()中使用
};
```

- **问题场景**：resume().catch()设置goal.status = GOAL_STATUS.ERROR，但ERROR未定义，导致status为undefined
- **适用范围**：所有状态枚举，必须覆盖所有赋值路径

### 10.108 EventBus onceAsync关闭时Promise结算

EventBus关闭时必须结算所有未完成的onceAsync Promise，防止进程挂起：

```javascript
class EventBus {
  constructor() {
    this._pendingOnceAsync = new Set();
  }

  onceAsync(event, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ctrl = { resolve, reject };
      this._pendingOnceAsync.add(ctrl);
      const settle = (fn, arg) => {
        this._pendingOnceAsync.delete(ctrl);
        fn(arg);
      };
      // ...
    });
  }

  _onShutdown() {
    for (const p of this._pendingOnceAsync) {
      p.reject(new Error('EventBus shutting down'));
    }
    this._pendingOnceAsync.clear();
  }
}
```

- **问题场景**：_onShutdown清除定时器和监听器后，onceAsync的Promise永远不会结算
- **适用范围**：所有创建Promise且依赖定时器/事件监听器来结算的异步方法

### 10.109 ChatChain FAILED依赖级联传播

当依赖任务FAILED时，下游任务应级联标记为FAILED，而非留在永久BLOCKED/PENDING状态：

```javascript
_updateBlockedTasks(chain) {
  chain.tasks.forEach(task => {
    if (task.status === 'pending' || task.status === 'blocked') {
      if (this._hasFailedDependency(chain, task)) {
        task.status = 'failed';
        task.result = { error: 'Dependency failed' };
      }
    }
  });
}
```

- **问题场景**：_isTaskBlocked将FAILED视为"已解决"，但_getNextTasks只启动COMPLETED/SKIPPED的下游，导致僵尸任务
- **适用范围**：所有DAG依赖检查，FAILED依赖必须级联传播

### 10.110 RetryEngine _sleep关闭时reject而非resolve

_sleep检测到关闭状态时必须reject而非resolve，确保重试循环正确终止：

```javascript
_sleep(ms, shutdownGetter) {
  return new Promise((resolve, reject) => {
    // ...
    if (shutdownGetter()) {
      clearTimeout(timer);
      reject(new Error('Aborted: shutdown detected'));  // 不是resolve()
    }
  });
}
```

- **问题场景**：resolve()使execute()的try-catch无法捕获中断信号，重试循环继续执行
- **适用范围**：所有异步等待函数，关闭时应reject而非resolve

### 10.111 ContextCompressionEngine缓存引用隔离

缓存存储必须与返回值引用隔离，防止调用者修改污染缓存：

```javascript
// 错误：共享引用
this._lastResult = result;
return result;

// 正确：缓存独立副本
this._lastResult = deepClone(result);
return result;
```

- **问题场景**：调用者修改返回对象，_lastResult也被修改，下次增量跳过命中时返回脏数据
- **适用范围**：所有缓存模式，存储和返回必须引用隔离

### 10.112 isHealthy()异常安全

isHealthy()方法必须捕获子组件异常，确保始终返回布尔值：

```javascript
isHealthy() {
  if (!this._initialized) return false;
  try { if (!this._prefetcher.isHealthy()) return false; } catch { return false; }
  try { if (!this._recaller.isHealthy()) return false; } catch { return false; }
  try { if (!this._syncCoordinator.isHealthy()) return false; } catch { return false; }
  return true;
}
```

- **问题场景**：子组件isHealthy()抛出异常，导致整个健康检查失败（异常而非false）
- **适用范围**：所有isHealthy()实现，必须保证返回布尔值

### 10.113 CSS overflow:visible与装饰元素裁剪

容器元素使用`overflow: hidden`会裁剪所有超出边界的子元素，包括负定位的装饰元素：

```css
/* 错误：裁剪所有装饰元素 */
.companion-head { overflow: hidden; }

/* 正确：允许装饰元素溢出，仅裁剪内部光泽 */
.companion-head { overflow: visible; }
.head-shine { overflow: hidden; }
```

- **问题场景**：thought-bubble、notification-sign、exclaim等通过负定位延伸到头部外，overflow:hidden导致不可见
- **分离裁剪**：容器设为visible，仅对需要裁剪的内部元素（如光泽渐变）单独设置overflow:hidden
- **适用范围**：所有包含负定位装饰子元素的容器

### 10.114 CSS transition:all替换为明确属性列表

`transition: all`会对所有可动画属性触发过渡，导致非预期的属性变化动画和性能开销：

```css
/* 错误：所有属性都触发过渡 */
.companion-head { transition: all var(--t-smooth); }

/* 正确：仅过渡需要的属性 */
.companion-head { transition: border-color var(--t-smooth), box-shadow var(--t-smooth), transform var(--t-smooth); }
```

- **问题场景**：切换皮肤时width/height/border-radius变化触发0.3s变形动画
- **性能影响**：`transition: all`增加浏览器属性监听开销
- **适用范围**：所有使用`transition: all`的选择器

### 10.115 Electron单实例锁

Electron应用必须使用`app.requestSingleInstanceLock()`防止多实例运行：

```javascript
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});
```

- **问题场景**：多实例导致托盘图标重复、全局快捷键冲突、端口竞争
- **second-instance处理**：将已有窗口显示并聚焦
- **适用范围**：所有Electron桌面应用

### 10.116 macOS activate事件处理隐藏窗口

macOS的activate事件必须处理窗口隐藏（非销毁）的情况：

```javascript
app.on('activate', () => {
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});
```

- **问题场景**：窗口被隐藏后点击Dock图标无响应
- **区分逻辑**：窗口不存在→创建；窗口存在但隐藏→显示并聚焦
- **适用范围**：所有macOS Electron应用

### 10.117 ARIA可访问性：菜单项、按钮、进度条

所有可交互元素必须具有正确的ARIA角色和键盘可访问性：

```html
<!-- 菜单项 -->
<div class="menu-item" role="menuitem" tabindex="0">...</div>
<!-- 按钮 -->
<span class="close-btn" role="button" tabindex="0" aria-label="关闭">✕</span>
<!-- 进度条 -->
<div class="progress-fill" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
```

- **菜单项**：role="menuitem" + tabindex="0"
- **按钮**：role="button" + tabindex="0" + aria-label
- **进度条**：role="progressbar" + aria-valuenow/min/max
- **适用范围**：所有非原生交互元素

### 10.118 CSS z-index层级分配规范

z-index必须按语义优先级分配，交互元素高于通知元素：

| 元素 | z-index | 说明 |
|------|---------|------|
| minimal-notif | 190 | 轻量通知 |
| level-up-overlay | 200 | 升级覆盖层 |
| toast-container | 210 | Toast通知 |
| permission-card | 250 | 权限审批（交互元素最高） |

- **原则**：交互元素 > 通知元素 > 装饰元素
- **禁止**：多个关键元素共享同一z-index值
- **适用范围**：所有使用z-index的元素

### 10.119 prefers-reduced-motion媒体查询

CSS必须包含`prefers-reduced-motion`媒体查询，为偏好减少动画的用户禁用动画效果：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- **WCAG合规**：满足SC 2.3.3（Animation from Interactions）
- **不完全禁用**：使用0.01ms而非0ms，确保animationend事件仍能触发
- **适用范围**：所有包含动画的CSS文件

### 10.120 CSP object-src 'none'指令

CSP策略必须显式设置`object-src 'none'`，阻止加载插件内容：

```
Content-Security-Policy: ...; object-src 'none';
```

- **问题场景**：未设置时回退到default-src，可能允许加载同源<object>/<embed>
- **适用范围**：所有CSP策略配置

### 10.121 skill-graph邻接表与边数据一致性

向图中添加边时必须同步更新邻接表，否则依赖邻接表的查询方法无法感知该边：

```javascript
// 错误：直接写入_edges，邻接表不更新
this._edges.set(key, edgeData);

// 正确：同步更新邻接表
this._edges.set(key, edgeData);
this._adjacency.get(fromId).add(toId);
this._reverseAdjacency.get(toId).add(fromId);
```

- **问题场景**：_buildSemanticEdges绕过addEdge直接写入，getShortestPath/detectCycles无法发现语义边
- **适用范围**：所有图数据结构的边添加操作

### 10.122 dev-metrics-collector Token增量同步

Token用量统计必须采用增量同步模式，防止recordTokenUsage与completePhase双重计数：

```javascript
// 增量同步模式：减旧加新
phaseData.tokenUsage.input = (phaseData.tokenUsage.input || 0) - prevSynced + newTokenUsage;
```

- **问题场景**：recordTokenUsage递增phase.tokenUsage，completePhase又累加result.tokenUsage
- **适用范围**：所有同时支持增量记录和批量完成的指标采集系统

### 10.123 ensemble-orchestrator Boosting轮数不被agent数截断

Boosting迭代轮数不应被agent数量截断，agent通过轮转复用：

```javascript
// 错误：2个agent只能迭代2轮
const maxRounds = Math.min(this._maxRounds, agents.length);

// 正确：agent通过轮转复用
const maxRounds = this._maxRounds;
// agents[round % agents.length] 轮转使用
```

- **适用范围**：所有集成学习模式的迭代轮数控制

### 10.124 Math.exp溢出防护：权重裁剪

使用Math.exp计算权重时必须裁剪输入值，防止溢出为Infinity：

```javascript
const safeWeight = Math.max(-10, Math.min(10, r.agentWeight));
const w = Math.exp(safeWeight);
```

- **问题场景**：agentWeight无上界，exp(700+)溢出为Infinity，后续除法产生NaN
- **裁剪范围**：[-10, 10]，exp(10)≈22026不会溢出
- **适用范围**：所有使用Math.exp的权重计算

### 10.125 async方法中同步/异步返回值兼容

调用可能返回同步值或Promise的方法时，必须使用`await Promise.resolve()`包装：

```javascript
async _shouldOodaBreak() {
  const observation = await Promise.resolve(this._oodaLoop.observe());
  const orientation = await Promise.resolve(this._oodaLoop.orient(observation));
  const decision = await Promise.resolve(this._oodaLoop.decide(orientation));
  // ...
}
```

- **问题场景**：同步调用observe()返回Promise对象，条件判断逻辑失效
- **适用范围**：所有调用可能为同步或异步的方法

### 10.126 success字段与converged语义一致

当converged为false时，success字段也必须为false：

```javascript
// 错误：未收敛但声称成功
return { success: true, rounds, converged: false };

// 正确：收敛才成功
return { success: converged, rounds, converged };
```

- **适用范围**：所有同时包含success和converged字段的返回值

### 10.127 loadL2Async并发请求合并

异步加载方法必须合并对同一key的并发请求，防止重复I/O和统计偏差：

```javascript
async loadL2Async(skillId) {
  if (this._loadingPromises.has(skillId)) return this._loadingPromises.get(skillId);
  const promise = this._doLoadL2Async(skillId);
  this._loadingPromises.set(skillId, promise);
  try { return await promise; } finally { this._loadingPromises.delete(skillId); }
}
```

- **适用范围**：所有异步加载/读取方法

### 10.128 registerAgent更新后返回实际档案

更新已存在的Agent后必须返回Map中实际存储的档案对象，而非临时创建的entry：

```javascript
// 错误：返回空历史的entry
return entry;

// 正确：返回Map中的实际档案
return this._agentProfiles.get(agentId);
```

- **适用范围**：所有register/update模式的方法

### 10.129 convergence-detector无效数据拒绝入队

收敛检测器必须在数据入队前验证质量分数有效性，防止0值污染历史：

```javascript
check(executionId, data) {
  if (typeof data.qualityScore !== 'number' || !Number.isFinite(data.qualityScore)) {
    return { converged: false, reason: 'invalid-quality-score' };
  }
  hist.push(data);
  // ...
}
```

- **适用范围**：所有基于历史数据的检测器

### 10.130 Object.create替代为展开运算符浅拷贝

创建带额外字段的对象副本时，必须使用展开运算符而非Object.create，防止原型链共享可变状态：

```javascript
// 错误：原型链共享
const taskWithContext = Object.create(task);
taskWithContext._ar = { ... };

// 正确：独立浅拷贝
const taskWithContext = { ...task, _ar: { ... }, refinementInstructions: ... };
```

- **问题场景**：修改taskWithContext上继承的嵌套对象实际修改原型task
- **适用范围**：所有需要创建对象副本并添加字段的场景

### 10.131 CSS动画使用filter而非box-shadow

companion-body使用`filter: drop-shadow()`而非`box-shadow`，动画关键帧必须操作filter属性：

```css
/* 错误：box-shadow在无背景flex容器上产生矩形阴影 */
@keyframes fx-hearteyes-glow {
  50% { box-shadow: 0 0 20px var(--skin-glow); }
}

/* 正确：filter跟随角色轮廓 */
@keyframes fx-hearteyes-glow {
  50% { filter: drop-shadow(0 0 20px var(--skin-glow)) brightness(1.15); }
}
```

- **问题场景**：pulse-glow动画操作box-shadow，但body无背景，产生不自然的矩形光晕
- **适用范围**：所有companion-body上的动画关键帧

### 10.132 CSS animation:none替代为微静止动画

替换float动画时不应使用`animation: none`，而应使用微静止动画防止位置跳变：

```css
/* 错误：float动画停止，角色从浮动位置跳回默认位置 */
.ai-typing { animation: none; }

/* 正确：微静止动画平滑过渡 */
.ai-typing { animation: ai-typing-idle 3s ease-in-out infinite; }
@keyframes ai-typing-idle {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
```

- **问题场景**：从float动画切换到none时，translateY从浮动值跳回0，视觉不自然
- **适用范围**：所有需要替换float动画的状态

### 10.133 speech-text多行截断

语音气泡文本应允许换行但限制行数，而非强制单行截断：

```css
.speech-text {
  white-space: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
```

- **问题场景**：API状态消息等长文本被单行截断，用户无法看到完整内容
- **适用范围**：所有需要文本截断的UI元素

### 10.134 move-window屏幕边界检查

移动窗口后必须检查新位置是否在屏幕范围内：

```javascript
const nx = x + Math.round(dx);
const ny = y + Math.round(dy);
const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
const bounds = mainWindow.getBounds();
if (nx + bounds.width < 50 || nx > sw - 50 || ny + bounds.height < 50 || ny > sh - 50) return;
mainWindow.setPosition(nx, ny);
```

- **问题场景**：异常渲染进程反复调用move-window将窗口移出可视区域
- **边界阈值**：至少50px在屏幕内
- **适用范围**：所有窗口位置移动操作

### 10.135 send-command长度限制

IPC命令处理器必须限制输入长度，防止超长字符串消耗资源：

```javascript
if (cmd.length > 10000) {
  return { ok: false, error: 'Command too long' };
}
```

- **适用范围**：所有接受字符串输入的IPC处理器

### 10.136 skill-graph getExecutionOrder过滤无效ID

拓扑排序前必须过滤掉不存在的skillId，防止幽灵节点进入执行顺序：

```javascript
getExecutionOrder(skillIds) {
  const validIds = skillIds.filter(id => this._nodes.has(id));
  // ... 后续操作基于validIds
}
```

- **问题场景**：不存在的ID创建幽灵节点，下游执行器尝试执行不存在的技能
- **适用范围**：所有接受ID列表的图查询方法

### 10.137 公共方法guardShutdown一致性

同一类中所有公共方法的关闭处理策略必须一致，要么全部抛出异常，要么全部返回默认值：

```javascript
// 统一策略：关闭时返回安全默认值
startProject(name, opts) {
  try { this.guardShutdown(); } catch { return { error: 'Collector is shut down' }; }
  // ...
}
generateReport(projectId) {
  try { this.guardShutdown(); } catch { return { error: 'Collector is shut down' }; }
  // ...
}
```

- **问题场景**：部分方法抛异常、部分返回默认值，调用方无法预测行为
- **适用范围**：所有具有guardShutdown的类

### 10.138 QualityScorer回退评分

挂载的QualityScorer应在Agent未返回qualityScore时作为回退评分使用：

```javascript
if (typeof agentResult.qualityScore !== 'number' && this._qs && typeof this._qs.score === 'function') {
  try {
    const fallbackScore = await Promise.resolve(this._qs.score(task, agentResult));
    if (typeof fallbackScore === 'number') agentResult.qualityScore = fallbackScore;
  } catch {}
}
```

- **问题场景**：attachQualityScorer接口是死代码，挂载的评分器从未被调用
- **适用范围**：所有提供attach*接口的类，挂载的组件必须被使用

### 10.139 增量计数替代全量遍历

频繁调用的统计方法应使用增量计数器，而非每次全量遍历：

```javascript
// 错误：每次遍历全部记录
_computeModeDistribution() {
  const counts = {};
  this._records.forEach(r => { counts[r.mode] = (counts[r.mode] || 0) + 1; });
  return counts;
}

// 正确：增量计数器
record(entry) {
  this._globalModeCounts.set(entry.mode, (this._globalModeCounts.get(entry.mode) || 0) + 1);
}
_computeModeDistribution() {
  return Object.fromEntries(this._globalModeCounts);
}
```

- **适用范围**：所有getStats()中需要计算分布的方法

### 10.140 CSS transition:all替换为明确属性列表（批量）

所有`transition: all`必须替换为明确列出的属性列表，防止非预期属性过渡和性能开销：

```css
/* 错误：所有属性触发过渡 */
.status-dot { transition: all var(--t-smooth); }

/* 正确：仅过渡需要的属性 */
.status-dot { transition: background var(--t-smooth), box-shadow var(--t-smooth); }
```

- **按元素类型选择属性**：容器元素→background/border-color/box-shadow/transform；卡片元素→background/border-color/box-shadow；通知元素→transform/opacity
- **适用范围**：所有CSS选择器，禁止使用`transition: all`

### 10.141 minimal模式hover恢复drag-hint和edge-indicator

minimal模式hover恢复规则必须包含所有被隐藏的元素：

```css
#companion.minimal:hover .drag-hint,
#companion.minimal:hover .edge-indicator {
  opacity: 1;
  pointer-events: auto;
}
```

- **问题场景**：drag-hint和edge-indicator在minimal模式下被隐藏，但hover时不恢复
- **适用范围**：所有minimal模式的hover恢复规则

### 10.142 TokenManager store/clear关闭守卫一致性

store()内部调用clear()时必须捕获关闭异常，防止关闭过程中的淘汰操作导致未处理异常：

```javascript
store(sessionId, data) {
  if (!this.isHealthy()) return;
  // LRU淘汰时clear()可能抛出SessionError
  try { this.clear(oldestKey); } catch (e) { if (e.code === 'SHUTDOWN') return; throw e; }
}
```

- **适用范围**：所有在同一方法中混用isHealthy()和guardShutdown()的场景

### 10.143 SessionManager TTL清理先删文件后删内存

TTL清理必须先删除持久化文件，成功后再从内存移除，防止unlink失败导致幽灵会话：

```javascript
// 错误：先删内存
this._sessions.delete(id);
fs.promises.unlink(filePath);  // 可能失败

// 正确：先删文件
await fs.promises.unlink(filePath);  // 成功后才删内存
this._sessions.delete(id);
```

- **适用范围**：所有同时操作内存和持久化的清理逻辑

### 10.144 CheckpointManager单调时间戳跨进程恢复

进程重启后必须从已有检查点恢复最大时间戳，确保单调递增：

```javascript
_restore() {
  for (const cp of checkpoints) {
    if (cp.createdAt > this._lastTimestamp) this._lastTimestamp = cp.createdAt;
  }
}
```

- **适用范围**：所有使用单调时间戳的持久化组件

### 10.145 PhaseOrchestrator关闭时使用_shuttingDown标志

关闭时应使用专用标志阻止新操作，而非重置锁：

```javascript
// 错误：重置锁可能允许并发操作
_onShutdown() { this._phaseTransitionLock = false; }

// 正确：使用关闭标志
_onShutdown() { this._shuttingDown = true; }
setCurrentPhase() { if (this._shuttingDown) return false; /* ... */ }
```

- **适用范围**：所有使用锁的关闭逻辑

### 10.146 state属性命名一致性：blinkTimer替代blinkInterval

state属性命名必须与实际用途一致，setTimeout ID不应命名为*Interval：

```javascript
// 错误：命名暗示setInterval
state.blinkInterval = setTimeout(blink, delay);

// 正确：命名与实际一致
state.blinkTimer = setTimeout(blink, delay);
```

- **适用范围**：所有state属性命名

### 10.147 DOM查询预缓存模式

频繁调用的函数中的DOM查询应在初始化时预缓存，避免重复查询：

```javascript
// 错误：每次刷新30+次DOM查询
function refreshPanelData() {
  document.getElementById('vibeThinking').classList.add('active');
  document.querySelector('.vibe-card.active').classList.remove('active');
}

// 正确：预缓存到els对象
function setupMiniPanel() {
  els.panelCards = {
    vibeThinking: document.getElementById('vibeThinking'),
    vibeCards: document.querySelectorAll('.vibe-card'),
  };
}
function refreshPanelData() {
  els.panelCards.vibeThinking.classList.add('active');
}
```

- **适用范围**：所有在定时器/轮询回调中执行DOM查询的代码

### 10.148 clearFx增量类名移除

清除特效类时应只移除实际存在的类，而非遍历全部42个可能类名：

```javascript
// 错误：遍历42个类名
FX_BODY_CLASSES.forEach(function(cls) { els.body.classList.remove(cls); });

// 正确：只移除实际存在的类
state.activeFxClasses.forEach(function(cls) { els.body.classList.remove(cls); });
state.activeFxClasses.length = 0;
```

- **辅助函数**：addFxClass(cls)和removeFxClass(cls)同步维护classList和activeFxClasses数组
- **适用范围**：所有大量classList.remove的批量操作

### 10.149 clearAIState与setAIState状态一致性

clearAIState()会重置state.aiState='idle'，因此在setAIState()中必须在clearAIState()调用之后设置新状态：

```javascript
// 错误：clearAIState()覆盖了新设置的状态
function setAIState(newState) {
  state.aiState = newState;
  clearAIState(); // 此时state.aiState被重置为'idle'！
}

// 正确：在clearAIState()之后设置新状态
function setAIState(newState) {
  clearAIState();
  state.aiState = newState;
}
```

- **根因**：clearAIState()负责清除视觉样式并重置状态，但setAIState()需要在新旧样式切换后保持状态正确
- **适用范围**：所有"清除旧状态→设置新状态"的两步操作模式

### 10.150 核心技能LRU驱逐保护

L2缓存满时LRU淘汰不得驱逐核心技能条目，需跳过核心技能寻找可淘汰的非核心条目：

```javascript
// 错误：LRU缓存满时无差别淘汰，核心技能可能被驱逐
this._l2Cache.set(skillId, entry);

// 正确：缓存满时跳过核心技能，淘汰非核心条目
if (isNewKey && this._l2Cache.size >= this._cacheMax) {
  let evicted = false;
  for (const candidateKey of this._l2Cache.keys()) {
    const layer = this.classifySkillLayer(candidateKey);
    if (layer !== SKILL_LAYER_CORE) {
      this._l2Cache.delete(candidateKey);
      this.emit('l2-unloaded', { skillId: candidateKey, reason: 'lru' });
      evicted = true;
      break;
    }
  }
  if (!evicted) return;
}
this._l2Cache.set(skillId, entry);
```

- **TTL过期保护**：核心技能TTL过期时自动续期（更新loadedAt）而非删除
- **事件完整性**：LRU淘汰和TTL过期均须触发l2-unloaded事件
- **适用范围**：所有带层级保护的缓存淘汰策略

### 10.151 模糊匹配归一化一致性

模糊匹配中命令ID和命令名的归一化规则必须一致，且须支持别名匹配：

```javascript
// 错误：nameNorm缺少/和-的去除
const cmdNorm = cmd.command_id.toLowerCase().replace(/[/\s-]/g, '');
const nameNorm = cmd.name.toLowerCase().replace(/\s/g, ''); // 不一致！

// 正确：两者使用相同的归一化规则
const cmdNorm = cmd.command_id.toLowerCase().replace(/[/\s-]/g, '');
const nameNorm = cmd.name.toLowerCase().replace(/[/\s-]/g, '');
```

- **别名匹配**：fuzzyMatch须检查cmd.aliases数组，对每个别名做相同归一化后匹配
- **部分匹配双源**：逐字符部分匹配须同时在cmdNorm和nameNorm中搜索
- **适用范围**：所有模糊搜索/匹配逻辑

### 10.152 中文文本Jaccard相似度bigram分词

中文文本不以空格分词，空白分词会导致Jaccard相似度退化为精确匹配。须使用字符级bigram分词：

```javascript
// 错误：中文整句变成单个"词"，Jaccard退化为精确匹配
const setA = new Set(a.split(/\s+/));

// 正确：ASCII词按空白分词，非ASCII文本使用bigram
_tokenize(text) {
  const tokens = new Set();
  const words = text.split(/\s+/);
  for (const word of words) {
    if (/^[\x00-\x7F]+$/.test(word)) {
      tokens.add(word.toLowerCase());
    } else {
      for (let i = 0; i <= word.length - 2; i++) {
        tokens.add(word.substring(i, i + 2));
      }
      if (word.length === 1) tokens.add(word);
    }
  }
  return tokens;
}
```

- **适用范围**：ThoughtDiamond._computeSimilarity、ThoughtRetrieverCycle._builtinDeduplicate及所有基于Jaccard的文本相似度计算

### 10.153 IPC速率限制

高频IPC通道（proxy-api、send-command）须实施速率限制，防止渲染进程异常时对后端发起DoS攻击：

```javascript
const IPC_RATE_WINDOW = 1000;
const IPC_RATE_MAX = 8;

function _checkRateLimit(channel) {
  const now = Date.now();
  const record = _ipcRateLimit.get(channel);
  if (!record || now - record.windowStart > IPC_RATE_WINDOW) {
    _ipcRateLimit.set(channel, { windowStart: now, count: 1 });
    return true;
  }
  record.count++;
  return record.count <= IPC_RATE_MAX;
}
```

- **错误信息脱敏**：IPC错误响应不得暴露e.message，使用_sanitizeError()返回通用错误码
- **静默catch日志化**：所有空catch块须添加console.warn日志，便于调试
- **适用范围**：所有Electron IPC处理器

### 10.154 统计计数器语义一致性

统计计数器须在对应事件实际发生后递增，而非在函数入口无条件递增：

```javascript
// 错误：被过滤的思维也被计入totalRefined
_refineSingle(thought) {
  this._stats.totalRefined++;
  if (confidence < threshold) {
    this._stats.confidenceFiltered++;
    return null; // 被过滤但仍计入了totalRefined
  }
}

// 正确：只有实际精化的思维才计入
_refineSingle(thought) {
  if (confidence < threshold) {
    this._stats.confidenceFiltered++;
    return null;
  }
  this._stats.totalRefined++;
}
```

- **未递增计数器**：定义了但从未递增的计数器（如confidenceRetrievals、diamondsDowngraded）须在对应代码路径中补充递增
- **适用范围**：所有统计/度量计数器

### 10.155 内部对象引用隔离

公共API返回内部存储对象时须返回浅拷贝，防止调用者直接修改破坏内部状态一致性：

```javascript
// 错误：返回内部引用，调用者可随意修改
getDiamond(id) {
  const diamond = this._diamonds.get(id);
  return diamond || null;
}

// 正确：返回浅拷贝
getDiamond(id) {
  const diamond = this._diamonds.get(id);
  if (diamond) {
    diamond.accessCount++;
    return Object.assign({}, diamond);
  }
  return null;
}
```

- **适用范围**：所有返回Map/对象存储条目的公共方法

### 10.156 去重结果merged数组不可丢弃

去重结果包含accepted、duplicates和merged三个数组，merged是重复思维的融合产物，须与accepted合并存储：

```javascript
// 错误：只处理accepted，merged被丢弃
const accepted = deduplicationResult.accepted ?? [];
const filtered = this._confidenceFilter(accepted);

// 正确：合并accepted和merged
const accepted = deduplicationResult.accepted ?? [];
const merged = deduplicationResult.merged ?? [];
const combined = [...accepted, ...merged];
const filtered = this._confidenceFilter(combined);
```

- **适用范围**：所有去重管道的后续存储步骤

### 10.157 置信度过滤阈值跨模块对齐

不同模块的置信度过滤阈值须保持一致，避免中间存储浪费：

```javascript
// 错误：ThoughtRetrieverCycle过滤阈值0.5，ThoughtDiamond过滤阈值0.7
// 结果：0.5-0.7之间的思维通过第一层但被第二层过滤，中间存储浪费

// 正确：统一使用0.7阈值
_confidenceFilter(thoughts) {
  return thoughts.filter(t => t.confidence >= 0.7);
}
```

- **适用范围**：所有串联管道中相邻模块的阈值配置

### 10.158 CSS !important消除策略

优先通过提高选择器特异性消除!important，而非依赖!important强制覆盖：

```css
/* 错误：使用!important强制覆盖 */
.eye.star-eye { background: ... !important; }

/* 正确：提高特异性自然覆盖 */
.companion-head .eye.star-eye { background: ...; }
```

- **可消除场景**：双类选择器已有足够特异性覆盖单类基础规则
- **不可消除场景**：动画覆盖类需!important覆盖同特异性基础动画声明
- **适用范围**：所有CSS !important声明

### 10.159 共享中文分词工具text-tokenizer

所有基于Jaccard相似度的文本比较逻辑须使用共享的`text-tokenizer`工具，确保中文bigram分词一致性：

```javascript
const tokenizeText = require('../../utils/text-tokenizer');

// 获取token集合
const tokens = tokenizeText(text);

// 直接计算Jaccard相似度
const similarity = tokenizeText.jaccardSimilarity(textA, textB);
```

- **分词规则**：ASCII词按空白分词+toLowerCase，非ASCII文本使用字符级bigram分词
- **适用模块**：ThoughtDiamond、ThoughtRetrieverCycle、DreamEngine、BrainMemory、ThoughtDeduplicator
- **禁止**：各模块自行实现`split(/\s+/)`分词，必须统一使用text-tokenizer

### 10.160 activeAgent.id防护

API返回的Agent对象可能缺少id字段，须使用回退链确保标识符不为undefined：

```javascript
var agentId = activeAgent.id || activeAgent.name || activeAgent.role || 'unknown';
if (agentId !== state.currentAgent) {
  state.currentAgent = agentId;
  var name = activeAgent.name || activeAgent.role || agentId;
}
```

- **适用范围**：所有依赖外部API返回对象标识符的场景

### 10.161 mousemove事件监听器合并

同一事件类型不得注册多个独立监听器，须合并为统一处理器：

```javascript
// 错误：mousemove注册了两个监听器
document.addEventListener('mousemove', function (e) { updatePupils(e); });
document.addEventListener('mousemove', resetIdle);

// 正确：合并为单一监听器
document.addEventListener('mousemove', function (e) {
  updatePupils(e);
  resetIdle();
});
```

- **适用范围**：所有全局事件监听器注册

### 10.162 粒子定位使用transform替代style.left/top

动态创建的粒子/特效元素定位须使用`style.transform`而非`style.left`/`style.top`，触发GPU合成层避免布局重排：

```javascript
// 错误：触发布局重排
p.style.left = x + 'px';
p.style.top = y + 'px';

// 正确：GPU加速
p.style.transform = 'translate(' + x + 'px,' + y + 'px)';
```

- **适用范围**：所有动态创建的粒子、涟漪、纸屑、气泡等特效元素

### 10.163 optimization-loop maxIterations安全上限

优化循环的最大迭代次数不得使用Infinity，必须设置有限上限：

```javascript
// 错误：可能导致无限循环
const DEFAULT_CONFIG = { maxIterations: Infinity };

// 正确：设置合理上限
const DEFAULT_CONFIG = { maxIterations: 1000 };
```

- **适用范围**：所有迭代/循环优化模块

### 10.164 自反思维度评分完整性

自反思模块的维度列表与评分方法须一一对应，新增维度必须同步添加评分方法：

```javascript
const REFLECTION_DIMENSIONS = [
  'boundary_conditions', 'consistency', 'security',
  'performance', 'completeness',
];

// switch中必须为每个维度提供评分方法
switch (dim) {
  case 'boundary_conditions': return this._scoreBoundaryConditions(base, result);
  case 'security': return this._scoreSecurity(base, result);
  case 'performance': return this._scorePerformance(base, context);
  // ...
}
```

- **适用范围**：所有基于维度评分的质量评估模块

### 10.165 MemoryStore恢复失败容错

数据恢复失败后MemoryStore仍须标记为就绪状态，允许空存储继续工作而非永久不可用：

```javascript
// 错误：恢复失败后_ready永远为false，所有操作被拒绝
this._readyPromise = this._restoreAsync().catch(err => { debug(...); });

// 正确：恢复失败也设置_ready=true，使用空数据继续工作
this._readyPromise = this._restoreAsync()
  .then(() => { this._ready = true; })
  .catch(err => { debug(...); this._ready = true; });
```

- **适用范围**：所有带异步初始化的数据存储模块

### 10.166 Map驱逐回退策略

Map容量达上限时，若无法按时间戳找到最老条目（时间戳无效），须回退到FIFO驱逐（删除第一个条目）：

```javascript
if (!oldestKey) {
  const firstKey = map.keys().next().value;
  if (firstKey !== undefined) oldestKey = firstKey;
}
if (oldestKey) map.delete(oldestKey);
```

- **适用范围**：所有带容量限制的Map驱逐逻辑

### 10.167 AudioContext必须在beforeunload中关闭

AudioContext必须在`beforeunload`事件中调用`close()`，防止浏览器标签页关闭后音频资源泄漏：

```javascript
window.addEventListener('beforeunload', () => {
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
  }
});
```

- **适用范围**：所有创建AudioContext的渲染进程代码

### 10.168 DOM查询结果应缓存到els对象中

重复调用`getElementById`/`querySelector`获取同一元素是性能浪费，应将查询结果缓存到`els`对象中：

```javascript
const els = {};
function getEl(id) {
  if (!els[id]) els[id] = document.getElementById(id);
  return els[id];
}
// 使用：getEl('eventLog') 而非每次 document.getElementById('eventLog')
```

- **适用范围**：所有频繁查询的DOM元素，尤其是eventLog等高频访问元素

### 10.169 ACHIEVEMENTS.check包裹try-catch

`ACHIEVEMENTS[key].check(g)`调用必须包裹try-catch，防止单个成就检查函数异常导致整个成就系统崩溃：

```javascript
for (const [key, ach] of Object.entries(ACHIEVEMENTS)) {
  try {
    if (ach.check(g)) { /* 解锁逻辑 */ }
  } catch (e) {
    console.warn(`Achievement check failed for ${key}:`, e);
  }
}
```

- **适用范围**：所有成就检查循环

### 10.170 conversation-context-store.getSessionContext验证sessionId格式

`getSessionContext`必须验证sessionId格式（使用`SAFE_SESSION_ID_RE`正则），防止路径遍历攻击：

```javascript
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
getSessionContext(sessionId) {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid sessionId format');
  }
  // ...
}
```

- **适用范围**：conversation-context-store所有接受sessionId的公共方法

### 10.171 conversation-context-store.compressSession不得重置turnCount

`compressSession`压缩会话时不得重置`turnCount`，`turnCount`代表历史总轮次数，用于序列号编号：

```javascript
compressSession(sessionId) {
  // 保留turnCount，仅压缩turns数组内容
  const turnCount = session.turnCount; // 保存
  // ... 压缩逻辑 ...
  session.turnCount = turnCount; // 恢复
}
```

- **适用范围**：conversation-context-store的compressSession方法

### 10.172 conversation-context-store._deleteTurnsFromStore非空检查

`_deleteTurnsFromStore`必须先检查`_sqliteStore`非空再访问`_db`属性，防止shutdown后空指针崩溃：

```javascript
_deleteTurnsFromStore(sessionId, turnIds) {
  if (!this._sqliteStore) return;
  const db = this._sqliteStore._db;
  // ...
}
```

- **适用范围**：conversation-context-store所有访问_sqliteStore的内部方法

### 10.173 chat-chain.retryTask恢复链状态使用PENDING

`retryTask`恢复链状态应使用`TASK_STATUS.PENDING`而非`TASK_STATUS.ACTIVE`（IN_PROGRESS），因为重试任务需要重新被调度器拾取：

```javascript
retryTask(chainId, taskId) {
  // 使用PENDING而非ACTIVE/IN_PROGRESS
  task.status = TASK_STATUS.PENDING;
  task._retryCount = (task._retryCount || 0) + 1;
}
```

- **适用范围**：chat-chain的retryTask方法

### 10.174 chat-chain.failTask重试条件使用<而非<=

`failTask`重试条件应使用`_retryCount < MAX_RETRIES`而非`<=`，与retryTask保持一致（retryTask先递增再判断）：

```javascript
failTask(chainId, taskId, reason) {
  if (task._retryCount < MAX_RETRIES) {
    this.retryTask(chainId, taskId);
  } else {
    task.status = TASK_STATUS.FAILED;
  }
}
```

- **适用范围**：chat-chain的failTask方法

### 10.175 thought-memory-store方法shutdown后空指针防护

`retrieveThoughts`/`getStats`/`getThought`方法必须检查`_shutDown`和`_thoughts`非空，防止shutdown后空指针崩溃：

```javascript
retrieveThoughts(query) {
  if (this._shutDown || !this._thoughts) return [];
  // ...
}
getStats() {
  if (this._shutDown || !this._thoughts) return { total: 0 };
  // ...
}
getThought(id) {
  if (this._shutDown || !this._thoughts) return null;
  // ...
}
```

- **适用范围**：thought-memory-store所有公共查询方法

### 10.176 preload.js IPC API方法输入验证

preload.js的5个IPC API方法（`proxyAPI`/`sendCommand`/`moveWindow`/`setIgnoreMouseEvents`/`setWindowSize`）必须添加输入验证：

```javascript
proxyAPI: async (url, options) => {
  if (typeof url !== 'string' || !url.length || url.length > 2048) {
    throw new Error('Invalid url parameter');
  }
  // ...
},
sendCommand: async (command, args) => {
  if (typeof command !== 'string' || !command.length || command.length > 256) {
    throw new Error('Invalid command parameter');
  }
  // ...
},
moveWindow: async (x, y) => {
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
    throw new Error('Invalid coordinates');
  }
  // ...
},
setIgnoreMouseEvents: async (ignore, options) => {
  if (typeof ignore !== 'boolean') {
    throw new Error('Invalid ignore parameter');
  }
  // ...
},
setWindowSize: async (width, height) => {
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !isFinite(width) || !isFinite(height) || width < 1 || height < 1) {
    throw new Error('Invalid size parameters');
  }
  // ...
},
```

- **适用范围**：preload.js所有通过contextBridge暴露的IPC API方法

### 10.177 rag-pipeline._generateDocId碰撞防护与_chunkText overlap clamp

`_generateDocId`必须添加哈希后缀防止碰撞，`_chunkText`的overlap参数必须clamp到非负：

```javascript
_generateDocId(content, source) {
  const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
  return `${source}::${hash}`;
}

_chunkText(text, chunkSize, overlap) {
  const safeOverlap = Math.max(0, Math.min(overlap, chunkSize - 1));
  // ...
}
```

- **适用范围**：rag-pipeline的文档ID生成和文本分块方法

### 10.178 graph-rag._extractRelations段落偏移量使用实际分隔符长度

`_extractRelations`段落偏移量必须使用实际分隔符长度而非`regex.source.length`，因为regex.source是模式字符串长度而非匹配文本长度：

```javascript
_extractRelations(text) {
  const separator = '\n\n';
  const parts = text.split(separator);
  let offset = 0;
  for (const part of parts) {
    // 使用separator.length而非regex.source.length
    processPart(part, offset);
    offset += part.length + separator.length;
  }
}
```

- **适用范围**：graph-rag的_extractRelations方法

### 10.179 graph-rag._pruneWeakRelations双向关系键删除

`_pruneWeakRelations`必须同时删除正向和反向关系键，否则会导致孤立的反向引用：

```javascript
_pruneWeakRelations(threshold) {
  for (const [key, rel] of this._relations) {
    if (rel.strength < threshold) {
      this._relations.delete(key);
      // 同时删除反向键
      const reverseKey = `${rel.target}->${rel.source}`;
      this._relations.delete(reverseKey);
    }
  }
}
```

- **适用范围**：graph-rag的_pruneWeakRelations方法

### 10.180 graph-rag.attach方法返回this支持链式调用

`attachEmbeddingService`/`attachVectorIndex`必须返回`this`以支持链式调用：

```javascript
attachEmbeddingService(service) {
  this._embeddingService = service;
  return this;
}

attachVectorIndex(index) {
  this._vectorIndex = index;
  return this;
}
```

- **适用范围**：graph-rag所有attach方法

### 10.181 graph-rag._removeDocumentEntities使用Set替代Array.includes

`_removeDocumentEntities`应使用`Set`替代`Array.includes`进行O(1)查找，避免O(n)线性扫描：

```javascript
_removeDocumentEntities(docId) {
  const entityIdsToRemove = new Set(
    [...this._entities.values()]
      .filter(e => e.sourceDoc === docId)
      .map(e => e.id)
  );
  for (const id of entityIdsToRemove) {
    this._entities.delete(id);
  }
  // 后续使用 entityIdsToRemove.has(id) 而非 array.includes(id)
}
```

- **适用范围**：graph-rag的_removeDocumentEntities方法及所有需要频繁查找的场景

### 10.182 TIMING常量提取规范

- 所有定时器间隔、XP奖励值、粒子数量、UI限制等硬编码数字必须提取为`TIMING`对象的命名常量
- 常量命名格式：`UPPER_SNAKE_CASE`，语义明确（如`IDLE_DOZING_DELAY`而非`TIMER_30S`）
- 新增魔法数字时必须同步更新TIMING对象定义
- 例外：CSS动画时长（由CSS自定义属性管理）、仅使用一次的配置值

### 10.183 null安全防护规范

- DOM元素引用(`els.*`)在访问属性前必须进行null检查
- 特别注意：`els.leftEye`/`els.rightEye`在`EYE_EXPR_CLASSES.forEach`中、`els.mouth`在className赋值时、`els.speechText`/`els.speechBubble`在showSpeech中
- 事件对象的子属性（如`e.dataTransfer.files`）必须使用短路求值：`e.dataTransfer && e.dataTransfer.files`
- 模式：`if (els.elementName) els.elementName.method()` 或提前return

### 10.184 DOM查询缓存规范

- `setupMiniPanel`中已缓存的`els.panelCards.*Cards`引用必须优先使用，禁止重复`document.querySelectorAll`
- 使用`|| []`回退确保安全迭代：`var cards = els.panelCards.vibeCards || [];`
- 新增DOM查询必须在`init()`或对应setup函数中一次性缓存到`els`对象

### 10.185 goal-executor BLOCKED子任务重试规范

- `_executeSubtasks`的`pendingSubtasks`过滤器必须包含`SUBTASK_STATUS.BLOCKED`
- 依赖未满足的子任务被跳过时，必须重置状态为`PENDING`而非保持`BLOCKED`
- 这确保下次迭代时子任务能被重新评估和执行

### 10.186 thought-retriever-cycle merged数组存储规范

- `_store`方法必须将`accepted`和`merged`数组合并后存储
- 合并时过滤无效条目：`accepted.concat(merged.filter(function(m) { return m && typeof m === 'object'; }))`
- 置信度过滤应作用于合并后的完整数组

### 10.187 pair-chat corrections验证规范

- `addCrossValidationRound`中round对象的`corrections`字段必须使用验证后的`corrections`变量
- 禁止使用原始`roundData.corrections`直接赋值，防止非数组值污染存储
- 验证模式：`var corrections = Array.isArray(rawCorrections) ? rawCorrections : [];`

### 10.188 pair-chat时间戳解析规范

- 时间戳解析禁止使用`Number(new Date(...))`链式调用
- 必须使用`new Date(ts).getTime()`并配合`Number.isFinite()`检查
- 解析链：先尝试直接解析→回退到createdAt→最终回退到`Date.now()`
- 示例：`var ts = lastRound.timestamp ? new Date(lastRound.timestamp).getTime() : NaN; if (!Number.isFinite(ts)) ts = new Date(session.createdAt).getTime(); if (!Number.isFinite(ts)) ts = Date.now();`

### 10.189 event-bus历史记录深拷贝规范

- 事件历史中的对象数据必须使用深拷贝（`JSON.parse(JSON.stringify(data))`）存储
- 深拷贝失败时回退到浅拷贝（`Array.isArray(data) ? [...data] : { ...data }`）
- 防止监听器修改事件数据后污染历史记录

### 10.190 event-bus onceAsync容量限制规范

- `_pendingOnceAsync`集合必须设置最大容量限制（默认1000）
- 超出容量时拒绝新的onceAsync调用，抛出`CAPACITY_EXCEEDED`错误
- 防止大量并发onceAsync调用导致内存泄漏

### 10.191 context-compression无预算压缩防护规范

- `shouldCompress`在`tokenBudget`为空或<=0时必须返回`false`
- 无预算时压缩无意义，不应因任何非零token使用量触发压缩
- 旧行为（`return tokensUsed > 0`）过于激进，会导致不必要的压缩操作

### 10.192 context-compression缓存满驱逐规范

- 因果上游缓存满时（>=500条），必须先尝试驱逐过期条目
- 过期驱逐后仍满时，使用FIFO策略驱逐最旧条目
- 禁止在缓存满时静默丢弃新条目（旧模式`if (size < max) set(...)`）

### 10.193 goal-executor resume零迭代防护规范

- `resume`方法在`_runGoalLoop`完成后必须检查是否有迭代实际执行
- 零迭代时（`goal.currentIteration === iterationBefore`）必须标记为`PAUSED`而非`COMPLETED`
- 原因：零迭代意味着目标未被执行，不应视为完成

### 10.194 goal-executor _shuttingDown属性统一规范

- 自定义`shutdown()`方法中设置`this._shuttingDown = true`（立即生效），而非依赖mixin的`this._shutDown`（shutdown完成后才生效）
- 所有运行时检查必须使用`this._shuttingDown`而非`this._shutDown`
- 原因：`_shutDown`由ShutdownMixin在`super.shutdown()`完成后才设置为true，而`_shuttingDown`在自定义shutdown入口立即设置，确保关闭信号即时传播

### 10.195 dream-outcomes metric方向感知评估规范

- `evaluateOutcome`中`achieved`和`ratio`计算必须根据`metric.direction`区分方向
- `maximize`方向：`achieved = actualValue >= target`，`ratio = min(actualValue / target, 1)`
- `minimize`方向：`achieved = actualValue <= target`，`ratio = actualValue !== 0 ? min(target / actualValue, 1) : 1`
- 原因：忽略方向会导致minimize指标（如错误率、延迟）被错误地按"越大越好"评估

### 10.196 goal-executor resume错误路径统计完整性规范

- `resumeGoal`的`.catch()`块中设置`goal.status = ERROR`时，必须同步递增`this._stats.totalGoalsFailed`
- 原因：遗漏递增导致失败计数偏低，影响监控和告警准确性

### 10.197 goal-executor _loopPromises驱逐两阶段规范

- 驱逐时先清除已完成/非Promise条目（无副作用）
- 若仍超限，按插入顺序（Map.keys()）FIFO淘汰最旧条目，并附加`.catch()`防止unhandled rejection
- 禁止仅驱逐单条且不等待settlement的模式
- 原因：单条驱逐无法有效控制Map大小，不附加catch会导致Promise拒绝未被处理

### 10.198 pair-chat统计值类型一致性规范

- `getStats()`返回的数值字段必须始终为`number`类型
- 禁止使用`.toFixed(N)`（返回字符串），改用`Math.round(x * 10^N) / 10^N`
- 原因：`.toFixed()`返回字符串与fallback值`0`（数字）类型不一致，可能导致下游比较或序列化异常

### 10.199 optimization-loop rollbackTo状态完整重置规范

- `rollbackTo`必须同步重置`_bestScore`、`_bestIteration`为快照值
- 必须清空`_strategyTrend`（而非仅设为快照策略），避免回滚后立即重复触发自动回滚
- 原因：回滚后bestScore/bestIteration仍指向旧值会导致退化检测再次触发回滚，形成死循环

### 10.200 graph-rag实体匹配最小长度规范

- 子串匹配（`indexOf`）必须要求查询词或实体名至少3个字符
- 精确匹配（`===`）不受长度限制
- 原因：短实体名如"AI"会误匹配"train"、"obtain"等无关词汇的子串

### 10.201 companion.js关键函数try-catch防护规范

- `setAIState`、`onLevelUp`、`processAgentData`、`pollOptimizationStatus`等关键函数体必须包裹try-catch
- catch块使用`console.error(functionName, e)`记录错误，不重新抛出
- 原因：这些函数由事件回调或定时器触发，未捕获异常会导致整个IIFE沙箱崩溃

### 10.202 TIMING常量新增与硬编码消除规范

- 新增`LEVEL_UP_OVERLAY`（2500ms）、`ROAM_PAUSE_MIN`（3000ms）、`ROAM_PAUSE_RANGE`（5000ms）三个TIMING常量
- 所有`setTimeout`/`setInterval`的延迟参数必须引用TIMING常量，禁止硬编码数字
- blink间隔使用`TIMING.BLINK_MIN + Math.random() * (TIMING.BLINK_MAX - TIMING.BLINK_MIN)`
- 原因：硬编码数字散布各处难以维护，TIMING常量集中管理便于调优

### 10.203 SDD规格追溯矩阵规范

- SddContractManager新增`registerTraceItem`/`updateTraceStatus`/`getTraceMatrix`/`checkSpecCoverage`方法
- 每个spec条目必须注册为trace item，追踪实现状态（pending/implemented/partial/deviated/stale）
- `checkSpecCoverage`计算覆盖率：`(implemented + partial * 0.5) / total * 100`
- 原因：spec文档验证后即脱离是SDD的最大缺口，追溯矩阵确保spec条目与代码实现一一对应

### 10.204 SDD文档-代码同步验证规范

- 新增`SddSyncVerifier`模块，提供`detectDrift`和`generateSyncReport`方法
- `detectDrift`接受代码快照，检测spec条目的实现证据是否仍然有效
- 同步状态五级：synced/doc-ahead/code-ahead/diverged/unknown
- 原因：文档与代码偏离是SDD实践的核心痛点，同步验证器自动检测偏离并生成报告

### 10.205 SDD PhaseBridge自动门禁规范

- SddPhaseBridge新增`autoEnforce`和`blockOnGateFailure`配置项
- 绑定PhaseOrchestrator后自动监听`phase-transition`事件，执行合约门禁检查
- 门禁失败且`blockOnGateFailure=true`时调用`pausePhase()`阻止阶段推进
- 原因：原桥接器需要外部手动触发门禁，PhaseOrchestrator不感知SDD，门禁形同虚设

### 10.206 SDD AI质疑/澄清机制规范

- SddDocumentValidator新增`generateClarificationQuestions`方法
- 自动检测8类文档缺陷：缺失细节/范围边界/不可测量/需求不完整/缺少恢复策略/排序模糊/缺少缓解/接口模糊
- 自动检测3类矛盾：强制vs可选/实时vs批处理/无限vs有上限
- 新增`detectAmbiguity`方法，检测8种模糊术语（"should be fast"/"user-friendly"/"TBD"等）
- 原因：SDD文章核心实践——AI主动质疑需求，拦截模糊和矛盾，降低细节遗漏

### 10.207 SDD合约持久化规范

- SddContractManager新增`attachPersistStore`/`persistContract`/`restoreContract`方法
- 持久化使用SqliteStore，键格式`sdd-contract:{contractId}`
- 进程重启后通过`restoreContract`恢复合约数据
- 原因：原合约数据纯内存存储，进程重启后全部丢失，无法维持长期SDD流程

### 10.208 conversation-context-store驱逐属性名与列名规范

- `_evictOverflowTurns`必须使用`removed.turnId`（非`removed.id`）和`WHERE turn_id = ?`（非`WHERE id = ?`）
- 原因：属性名`id`在turn记录中不存在（始终为undefined），SQL列名`id`在schema中不存在（实际为`turn_id`），双重错误导致evicted turns永不从SQLite删除

### 10.209 conversation-context-store压缩序列号规范

- 压缩turn的sequence应使用`olderTurns[last].sequence`（不加1），避免与`recentTurns[0].sequence`碰撞
- 原因：+1导致压缩turn序列号等于recentTurns首条记录，破坏序列唯一性约束

### 10.210 dream-engine回滚深拷贝规范

- `_mergeWithExistingNotes`的snapshot必须深拷贝条目（`Object.assign({}, v, { source_sessions: v.source_sessions.slice() })`），禁止直接引用原条目
- 合并时创建新对象（`{ ...existing, ... }`）而非修改原条目
- 原因：直接修改snapshot条目导致回滚恢复的是已修改数据而非原始数据

### 10.211 dream-engine统计计数器回滚规范

- `_mergeWithExistingNotes`在合并前必须保存`_stats.notesMerged`和`_stats.notesCreated`的值
- 回滚时必须恢复这些计数器，防止统计漂移
- 原因：合并失败后stats计数器已递增但数据已回滚，导致统计值偏高

### 10.212 dream-engine事件发射时序规范

- `dream-complete`事件必须在sync操作完成后发射，确保result包含`notesSynced`和`syncErrors`
- 原因：事件监听者在发射时可能解构或序列化result，提前发射导致数据不完整

### 10.213 agent-runtime shutdown资源释放规范

- `_onShutdown`在设置agent状态为STOPPED后必须调用`_releaseResources(agent)`
- 必须调用`_persist(agent, true)`持久化状态变更
- 原因：未释放资源导致重启后资源池计数膨胀（STOPPED agent仍持有allocatedResources），未持久化导致磁盘状态与内存不一致

### 10.214 agent-runtime _evictOldest双重释放防护规范

- `_evictOldest`必须使用`resourcesReleased`标志位防止catch块双重释放资源
- catch块仅在`!resourcesReleased && savedResources`时执行资源扣减
- 原因：try块中`_releaseResources`成功后若后续操作抛异常，catch块会再次扣减同一资源

### 10.215 subagent-executor shutdown拒绝挂起Promise规范

- `_onShutdown`必须对所有未完成handle调用`handle._reject(new HarnessError('SHUTDOWN_IN_PROGRESS', ...))`
- 必须清除`_agentRuntime`引用（`this._agentRuntime = null`）
- 原因：未拒绝的Promise导致await方无限挂起，未清除的引用阻止GC回收

### 10.216 subagent-executor _resolveModel安全调用规范

- `_resolveModel`调用`getTier`前必须验证`typeof this._modelSelector.getTier === 'function'`
- 不存在时回退到`'standard'`层级
- 原因：`attachModelSelector`仅验证`selectModel`存在，`getTier`可能缺失导致TypeError

### 10.217 chat-chain retryTask依赖检查规范

- `retryTask`在重置task为PENDING前必须检查`_hasFailedDependency`
- 存在FAILED依赖时返回`{ retried: false, reason: 'Dependency is still in FAILED state' }`
- 原因：不检查依赖时_updateBlockedTasks立即将task重新设为FAILED，重试被静默撤销

### 10.218 chat-chain级联失败事件规范

- `_updateBlockedTasks`级联设置task为FAILED时必须发射`task-failed`事件（含`cascaded: true`标记）
- 原因：级联失败不发射事件导致监控和日志遗漏

### 10.219 thought-retriever-cycle storeThoughts返回值类型验证规范

- `_store`方法必须验证`storeThoughts()`返回值为数组：`Array.isArray(rawStored) ? rawStored : []`
- `_diamondRefine`必须验证`refine()`返回值：`Array.isArray(refinedRaw) ? refinedRaw : accepted`
- 原因：非数组返回值导致`.length`为undefined，`+= undefined`产生NaN永久污染stats

### 10.220 pipeline-executor无路由器错误传播规范

- `_executeWithTimeout`在`collaborationModeRouter`缺失时必须同时修改`pipelineResult`（`status='error'`）
- 原因：仅返回error对象但调用方丢弃返回值，pipelineResult.status保持'success'误导调用方

### 10.221 output-fusion权重归一化规范

- `_weightedFusion`使用显式权重时必须归一化：`normalizedTotalWeight = results.length`
- 置信度公式：`Math.min(normalizedTotalWeight / results.length, 1.0)`
- 原因：原始权重和>=results.length时置信度恒为1.0，无法反映实际质量

### 10.222 agent-monitor shutdown检查一致性规范

- `unregisterAgent`和`detectAntipatterns`必须使用`guardShutdown()`（非`isHealthy()`）
- 原因：与`registerAgent`行为一致，shutdown后操作应抛异常而非静默返回

### 10.223 module-initializer SIMPLE_MODULES清理追踪规范

- SIMPLE_MODULES循环中每个实例创建后必须立即`created.push(inst)`
- 异步路径使用`ctx.created.push(inst)`
- 原因：14个模块未加入created数组，初始化失败时不会被清理，导致资源泄漏

### 10.224 model-selector LRU插入顺序规范

- `recordUsage`更新已存在key时必须先`delete`再`set`，确保Map插入顺序更新
- 原因：`Map.set()`对已存在key不更新插入顺序，频繁使用的条目被错误地作为"最旧"驱逐

### 10.225 model-selector复杂度阈值回退值一致性规范

- `_selectByComplexity`中`threshold.standard`回退值必须与`DEFAULT_CONFIG`一致（0.3）
- `attachTokenManager`必须验证参数非null且具有`on`方法
- 原因：回退值0.4与默认0.3不一致导致模型选择偏移；null参数导致TypeError

### 10.226 skill-router modelTier提取规范

- `_normalizeMatchInput`必须从context中提取`modelTier`并包含在返回对象中
- 原因：缺失导致`match()`中modelTier过滤逻辑永远为undefined，MODEL_TIERS功能完全失效

### 10.227 skill-reducer定时器去重规范

- `deactivateAfterTask`创建新定时器前必须清除同signature的已有定时器
- `loadL2`/`loadL2Async`/`loadL3`/`loadL3Async`必须调用`guardShutdown()`
- `discoverAsync`在await后必须检查`this._shutDown`
- 原因：重复定时器导致泄漏+追踪Map损坏；shutdown后仍可修改缓存数据

### 10.228 context-compression状态哈希完整性规范

- `_computeStateHash`必须包含`keyDecisions`和`sessionState`的哈希输入
- 原因：遗漏导致这两个字段变更时增量跳过返回过时缓存结果

### 10.229 context-compression数组压缩省略计数规范

- `_compressObjectOutput`中省略计数应为`obj.length - 5`（3头+2尾），而非`obj.length - 3`
- 原因：`obj.length - 3`多计2个实际保留的尾部元素

### 10.230 isolated-context-manager访问控制强制规范

- `getContext`在`requestingAgentId`缺失时必须拒绝访问（返回null+发射access-denied事件）
- 禁止省略agentId绕过隔离边界
- 原因：原设计允许无agentId时跳过ACL检查，完全破坏隔离性

### 10.231 isolated-context-manager结果覆写防护规范

- `submitResult`必须检查context状态，已完成（completed）的context拒绝覆写
- `isHealthy`必须检查`this._shutDown`标志
- 原因：覆写已完成结果导致数据丢失；shutdown后仍返回healthy误导调用方

### 10.232 quality-scorer getHistory边界规范

- `getHistory(0)`必须返回空数组而非完整历史
- `_scoreCoverage`中tests数组元素必须添加null守卫（`t && (t.passed || ...)`)
- 原因：`slice(-0)`等价于`slice(0)`返回全部数据；null元素导致TypeError

### 10.233 business-goal KPI覆写防护规范

- `defineKpi`对已存在KPI必须保留`current`值，仅更新`name`/`target`/`unit`
- `measureGoalAchievement`分母仅计入`current !== null`的可度量KPI
- `_onShutdown`必须调用`removeAllListeners()`
- 原因：覆写丢失追踪进度；未度量KPI稀释达成率

### 10.234 token-manager LRU驱逐条件规范

- `store`/`set`方法必须在`delete`+`set`前捕获`isNewSession`标志
- 驱逐条件使用`isNewSession`而非`!this._sessionBreakdowns.has(sessionId)`
- 原因：原条件在已有session缺少breakdown时错误触发驱逐

### 10.235 human-approval-gate shutdown清理规范

- `_onShutdown`必须调用`removeAllListeners()`
- 原因：遗漏导致外部监听器引用阻止GC回收

### 10.236 retry-engine _escalate复杂度拆分规范

- `_escalate`方法拆分为`_escalateReplan`和`_escalateDecompose`两个辅助方法
- replan循环中`_sleep`必须包裹try-catch（与主循环一致）
- 原因：单方法复杂度21超限；replan sleep异常处理不一致

### 10.237 deepening-orchestrator bestScore无限值防护规范

- `_runIterations`中bestScore计算后必须验证`Number.isFinite(best)`
- 非有限值时回退为0，避免bestScore为`-Infinity`传播到缓存和指标
- 原因：`reduce((a,b) => Math.max(a,b), -Infinity)`在无有限元素时保持-Infinity

### 10.238 plugin-manager异步init异常处理规范

- `register`方法中`plugin.init(ctx)`返回值若为Promise，必须通过`.catch()`处理异步拒绝
- 异步拒绝的回调中必须清理已注册的hooks（与同步异常处理一致）
- 回调中需通过`const self = this`捕获上下文
- 原因：原代码仅try-catch同步异常，异步init返回的Promise拒绝未被处理，导致hooks泄漏和未处理拒绝
