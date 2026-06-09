---
skill_id: ai-developer-analytics
name: AI开发者分析管线
phase: module-development
priority: 2
enforcement: recommended
stability: beta
applicable_agents:
  - domain-analyst
  - task-worker
auto_trigger: true
slash_command: /analyze-ai-dev
tool_reference: ai-developer-analytics
trigger: auto
trigger_conditions: []
dependencies:
  - code-locator
  - performance-optimization
  - ai-delivery-optimization
triggers:
  - 用户需要分析AI开发者效率指标
  - 用户需要对比实验数据（模型/prompt/配置）
  - 用户需要定位性能瓶颈或反模式
  - 用户需要检测指标异常或趋势偏移
  - 用户提到"分析管线"、"实验对比"、"瓶颈定位"、"异常检测"、"AI开发者分析"
  - module-development阶段需要数据驱动的质量洞察
verified: true
---

## 目标

统一收集和分析10+指标源的开发效率数据，支持实验对比（模型/prompt/配置）、性能瓶颈定位、异常检测和趋势分析，为数据驱动的AI开发决策提供支撑。

# AI开发者分析管线技能

## 适用性决策

### 适合使用（4种场景）
1. 需要跨子系统统一收集和分析10+指标源的开发效率数据
2. 需要对比不同模型/prompt/配置的实验效果，做数据驱动决策
3. 需要定位跨子系统的性能瓶颈和反模式
4. 需要检测指标异常和趋势偏移，提前预警

### 不适合使用（4种场景）
1. 单一模块性能优化（→ performance-optimization）
2. 代码质量审查（→ code-review）
3. 安全漏洞检测（→ security-audit）
4. 纯代码定位需求（→ code-locator）

## 数据孤岛问题

Harness框架内10+指标模块各自为政，缺乏统一分析管道：

| 指标模块 | 数据类型 | 当前状态 |
|---------|---------|---------|
| TokenManager | Token使用量 | 独立存储 |
| DeliveryEfficiencyMeter | 交付效率 | 独立存储 |
| ContextDriftMonitor | 上下文漂移 | 独立存储 |
| AiCodeTrustScorer | 代码可信度 | 独立存储 |
| ComprehensionDebtTracker | 理解债务 | 独立存储 |
| QualityScorer | 质量评分 | 独立存储 |
| SkillObservability | 技能可观察性 | 独立存储 |
| DevMetricsCollector | 开发指标 | 独立存储 |
| AgentMonitor | Agent监控 | 独立存储 |
| AgentContributionTracker | 贡献度追踪 | 独立存储 |

**解决方案**：统一Schema收集所有指标源，建立跨模块关联分析管道。

## 四大核心能力

### 能力1：项目全景透视

**核心逻辑**：CodeGraph + GraphifyCompiler构建项目全景依赖图谱，识别架构级问题

**执行步骤**：
1. **依赖图谱构建**：调用CodeGraph构建项目源码文件依赖关系图
   - JS require/exports解析
   - MD链接解析
   - 依赖链查询
2. **GraphifyCompiler深度分析**：7阶段管线（detect→ingest→build→cluster→analyze→report→export）
   - 文件类型检测（40+扩展名）
   - AST解析（tree-sitter可选+regex降级）
   - 语义提取（LLM语义提取，多模态支持）
   - Louvain社区发现
   - 图谱构建（AST+语义合并，跨文件引用解析）
3. **耦合度分析**：识别高耦合模块群
   - 模块间依赖密度计算
   - 耦合热点标注
4. **孤立文件检测**：发现无依赖和无被依赖的孤立文件
5. **循环依赖发现**：检测并报告循环依赖链

**依赖工具**：CodeGraph、GraphifyCompiler、AstParser、LouvainClusterer

### 能力2：实验数据挖掘

**核心逻辑**：统一Schema收集10+指标源，支持实验记录和模型/prompt对比

**执行步骤**：
1. **统一Schema定义**：为所有指标源定义标准化采集Schema
   - 指标名称、类型、单位、采集频率
   - maxMetricsPerSource限制（默认1000）
2. **指标源注册**：从10+指标模块采集数据
   - Token使用量、交付效率、上下文漂移、代码可信度
   - 理解债务、质量评分、技能可观察性、开发指标
   - Agent监控、贡献度追踪
3. **实验记录**：记录每次实验的配置和结果
   - 模型选择（gpt-4o/claude-3-opus/deepseek-v3）
   - Prompt模板版本
   - 参数配置（temperature/max_tokens等）
   - 执行结果（质量评分/Token消耗/耗时）
4. **模型/Prompt对比**：跨实验对比不同配置的效果
   - A/B对比：同一任务不同模型/prompt
   - 多维度对比：质量、成本、速度
   - 数据驱动决策：基于统计显著性判断

**依赖工具**：TokenManager、DeliveryEfficiencyMeter、DevMetricsCollector、QualityScorer

### 能力3：性能瓶颈定位

**核心逻辑**：跨子系统瓶颈检测+反模式识别+Token-质量交叉关联+优化建议生成

**执行步骤**：
1. **跨子系统瓶颈检测**：扫描所有子系统识别性能瓶颈
   - Agent子系统：任务超时、重试率、推诿率
   - 因果子系统：模拟耗时、世界线分支过多
   - 协作子系统：PairChat验证轮次、ChatChain产物积压
   - 上下文子系统：压缩频率、隔离边界冲突
   - 深化推理子系统：迭代次数、收敛速度
   - 技能子系统：路由延迟、缓存命中率
2. **反模式识别**：检测常见性能反模式
   - 无限循环深化（收敛检测失败）
   - 上下文爆炸（压缩不及时）
   - 技能路由瘫痪（Top-K选择过多）
   - Agent推诿循环（defer率过高）
3. **Token-质量交叉关联**：分析Token消耗与输出质量的关系
   - 高Token低质量：冗余生成或幻觉
   - 低Token高质量：高效模式，可推广
   - 高Token高质量：必要深度，可接受
   - 低Token低质量：浅层输出，需深化
4. **优化建议生成**：基于瓶颈和反模式生成具体优化建议
   - 优先级排序（影响面×严重度）
   - 预期收益估算
   - 实施步骤建议

**依赖工具**：AgentMonitor、ConvergenceDetector、DeliveryEfficiencyMeter、AiCodeTrustScorer

### 能力4：开源生态集成

**核心逻辑**：MCPClient + OpenCLI 80+适配器 + GitHub/HF数据采集

**执行步骤**：
1. **MCPClient集成**：通过MCP协议连接外部数据源
   - stdio/HTTP双传输
   - 进程退出清理、buffer限制、SSRF防护
2. **OpenCLI适配器**：80+网站适配器数据采集
   - GitHub：仓库统计、Issue趋势、PR合并时间
   - HuggingFace：模型下载量、Benchmark排名
   - Chrome Bridge：浏览器会话复用
3. **数据采集**：采集开源生态数据辅助分析
   - 同类项目对比
   - 社区活跃度指标
   - 技术栈趋势数据

**依赖工具**：MCPClient、BrowserUseAdapter、data-collect

## 异常检测

### 标准差阈值（2σ）
- 对每个指标计算滑动窗口均值和标准差
- 超出均值±2σ的值标记为异常
- anomalyThreshold可配置（默认2.0）

### 趋势分析
- trendWindowSize（默认20）个数据点的滑动窗口
- 线性回归计算趋势方向
- 趋势斜率超过阈值触发告警

### 异常告警
- 单点异常：单次指标超出2σ范围
- 趋势异常：连续N个点呈异常趋势
- 关联异常：多个指标同时异常（交叉关联分析）

## 安全约束

1. **数据隐私**：采集的指标数据仅用于分析，不存储用户个人身份信息（PII），敏感配置脱敏处理
2. **速率限制**：外部数据源请求遵循平台速率限制，避免被封禁
3. **SSRF防护**：所有外部HTTP请求必须经过SSRF防护检查，禁止访问内网地址（127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16）

## 执行流程

1. **指标采集**：从10+指标源统一收集数据，按标准Schema存储
2. **全景透视**：构建项目依赖图谱，识别耦合热点、孤立文件、循环依赖
3. **实验对比**：对比不同模型/prompt/配置的实验效果，生成对比报告
4. **瓶颈定位**：跨子系统扫描瓶颈，识别反模式，生成优化建议
5. **异常检测**：基于2σ阈值和趋势分析检测异常，触发告警
6. **报告生成**：汇总分析结果，生成结构化报告

## 证据要求

完成本技能执行后，必须提供以下证据：

| 证据类型 | 说明 | 最低标准 |
|---------|------|---------|
| metrics_collected | 采集的指标数量 | ≥1 |
| experiments_compared | 对比的实验数量 | ≥1 |
| bottlenecks_detected | 检测到的瓶颈数量 | ≥0（无瓶颈时为0） |
| anomalies_found | 发现的异常数量 | ≥0（无异常时为0） |

## R52/R53安全加固

### R52: _storeMetric()性能优化
`_storeMetric()`方法使用`slice(-max)`替代O(n²)的`shift()`循环：
- 修复前：当指标值超过`maxMetricsPerSource`时，使用`shift()`逐个移除，时间复杂度O(n²)
- 修复后：使用`entry.values = entry.values.slice(-this._maxMetricsPerSource)`一次性截断，时间复杂度O(n)

### R52: _updateEntryStats()增量追踪
`_updateEntryStats()`方法使用增量min/max/sum/count追踪：
- `_storeMetric()`中在添加新值时即时更新`stats.min`、`stats.max`、`stats.sum`、`stats.count`
- `_updateEntryStats()`仅计算`avg`（sum/count）和`p95`（需排序）
- 修复前：每次调用都遍历全部历史值重新计算min/max/sum，时间复杂度O(n)
- 修复后：min/max增量更新O(1)，仅p95计算需排序O(n log n)

### R52: isHealthy()检查_initialized
`isHealthy()`方法现在同时检查`_shutDown`和`_initialized`：
- 返回`!this._shutDown && this._initialized`
- 修复前：仅检查`_shutDown`，未初始化的实例也返回healthy=true
- 修复后：未初始化的实例返回healthy=false

### R52: _onShutdown()重置_stats
`_onShutdown()`方法现在重置`_stats`对象为初始零值：
- 重置字段：totalMetricsCollected, totalExperiments, totalAnomaliesDetected, totalDependencyScans, totalBottlenecksFound, avgCollectionTimeMs
- 修复前：关闭后_stats仍保留旧数据，可能导致误读
- 修复后：关闭后_stats清零，与_initialized=false一致

### R53: collectFromAllSources()容错
`collectFromAllSources()`方法中`_storeMetric()`调用现在包裹在try-catch中：
- 单个指标存储失败不会中断整个收集流程
- 失败的指标被静默跳过，不影响其他指标的收集
- 修复前：单个_storeMetric()异常会导致整个collectFromAllSources()失败
- 修复后：单个指标失败仅跳过该指标，其余指标正常收集

## 反模式清单

| 反模式 | 表现 | 正确做法 |
|--------|------|---------|
| 指标堆砌 | 收集大量指标但不做分析 | 聚焦关键指标，建立因果关系 |
| 孤立分析 | 只看单一指标，忽略交叉关联 | Token-质量交叉关联分析 |
| 过度拟合 | 对历史数据过度拟合，误判趋势 | 使用2σ阈值+趋势确认 |
| 忽略基线 | 没有建立基线就做异常检测 | 先建立稳定基线，再检测偏差 |
| 数据孤岛 | 各模块数据不互通 | 统一Schema+跨模块关联 |

## 验收标准
- [ ] 至少1个指标源已收集
- [ ] 异常检测2σ阈值配置合理
- [ ] 趋势分析窗口大小合理（默认20）
- [ ] _storeMetric()使用slice(-max)而非shift循环（R52）
- [ ] _updateEntryStats()增量追踪min/max/sum/count（R52）
- [ ] isHealthy()检查_initialized状态（R52）
- [ ] _onShutdown()重置_stats为零值（R52）
- [ ] collectFromAllSources()中_storeMetric()有try-catch容错（R53）

## 常见问题
- **Q: 指标收集性能差怎么办？**
  A: R52已优化_storeMetric()使用slice(-max)替代O(n²)shift循环，_updateEntryStats()使用增量追踪
- **Q: 未初始化的实例isHealthy()返回true？**
  A: R52已修复，isHealthy()现在同时检查_shutDown和_initialized
- **Q: 关闭后_stats仍有旧数据？**
  A: R52已修复，_onShutdown()现在重置_stats为零值
- **Q: 单个指标存储失败导致整个收集中断？**
  A: R53已修复，collectFromAllSources()中_storeMetric()包裹在try-catch中，单个失败不影响其余
