---
skill_id: cli-anything
name: 软件操控
phase: module-development
priority: 2
enforcement: optional
trigger: 用户需要通过CLI操控本地专业软件或将软件转化为AI可调用工具时
auto_trigger: true
depends_on:
  - architecture-design
blocks:
  - integration-testing
description: |
  通过CLI-Anything将任意软件转化为AI可直接调用的CLI工具，使Agent能够：
  - 调用专业软件执行任务（GIMP图像编辑、Blender 3D渲染、LibreOffice文档生成等）
  - 通过CLI-Hub浏览、搜索、安装40+预生成的CLI工具
  - 为新软件自动生成Agent-Native CLI接口（7阶段自动化流水线）
  - 获取结构化JSON输出，支持--help自描述和--json机器可读
  - 与web-interaction互补：web-interaction操控网页，cli-anything操控本地软件
trigger_conditions:
  - 用户要求使用专业软件完成任务（图像编辑、3D渲染、文档生成、音频处理等）
  - 用户要求将某软件转化为AI可调用的工具
  - 任务涉及需要本地软件处理的文件操作（PDF生成、图片处理、视频编辑等）
  - 用户要求批量自动化软件操作
  - 任务需要调用GIMP/Blender/LibreOffice/OBS/Audacity等专业软件
prerequisites:
  - Python 3.10+已安装
  - CLI-Hub已安装（pip install cli-anything-hub）
  - 目标软件已安装在本地系统
  - CLI-Anything MCP服务器已启用（config.json中mcp_servers.cli-anything.enabled=true）
  - MCP启动命令：python -m cli_anything_hub（兼容Python 3.10+，无需pip run）
applicable_agents: [task-worker, domain-analyst, team-lead, devops-engineer]
tools_used:
  - mcp:cli-anything
  - shell:cli-hub
evidence:
  required: true
  types:
    - cli_tool_installed
    - cli_command_executed
    - software_output_generated
verified: true
stability: beta
---

## 目标

通过CLI-Anything将任意本地专业软件转化为AI可直接调用的CLI工具，使Agent能操控GIMP、Blender、LibreOffice等40+软件，与web-interaction互补覆盖本地软件操控场景。

## 步骤

1. 环境检查（验证Python 3.10+、CLI-Hub、MCP连接状态）
2. 发现可用CLI（cli-hub list/search）或自动生成新CLI（7阶段流水线）
3. 安装CLI并执行操作（--help查看命令、--json获取结构化输出）
4. 结果验证（检查输出文件、JSON结构完整性、记录操作证据）

# 软件操控技能

## 概述
本技能通过CLI-Anything（港大HKUDS开源项目），将Harness Agent的能力从网页领域扩展到本地专业软件领域。Agent可通过CLI-Hub浏览和安装预生成的CLI工具，或为任意软件自动生成新的CLI接口，实现对GIMP、Blender、LibreOffice、OBS等专业软件的程序化操控。

## 与web-interaction的关系
| 维度 | web-interaction | cli-anything |
|------|----------------|-------------|
| 操控对象 | 网页和Electron应用 | 本地专业软件 |
| 传输协议 | MCP/OpenCLI | MCP/CLI-Hub/Shell |
| 数据来源 | 在线网页数据 | 本地软件处理结果 |
| 交互方式 | 浏览器会话复用 | 命令行接口调用 |
| 互补场景 | 网页数据提取、表单填写 | 图像编辑、3D渲染、文档生成 |

## 权限模型
- **available_skills**：4个Agent（task-worker、domain-analyst、team-lead、devops-engineer）的`available_skills`和`permissions.can_execute`均包含`cli-anything`
- **RBAC执行级别**：`optional`（可选执行，不强制要求）
- **工具权限**：config.json中`agent_permissions`通过`cli_anything`工具权限控制
- **quality-assurance**和**technical-writer**：不包含`cli-anything`，因为QA和文档角色不涉及软件操控

## Dashboard API
运行时状态可通过以下API端点查询：
- `GET /api/cli-anything/status` — CLI-Anything MCP服务器连接状态
- `GET /api/cli-anything/registry` — 已安装CLI工具列表（最多100个，超出标记truncated:true）

## 工作流程

### 模式一：使用预生成CLI（推荐）

#### 1. 环境检查
- 验证Python 3.10+可用：`python --version`
- 验证CLI-Hub已安装：`cli-hub --version`
- 验证CLI-Anything MCP服务器连接状态（可通过`/api/cli-anything/status`端点检查）

#### 2. 发现可用CLI
- `cli-hub list` — 浏览所有可用CLI
- `cli-hub search <query>` — 按关键词搜索（如`cli-hub search image`）
- `cli-hub info <name>` — 查看CLI详细信息

#### 3. 安装CLI
- `cli-hub install <name>` — 安装指定CLI（如`cli-hub install gimp`）
- 验证安装：`cli-anything-<name> --help`

#### 4. 执行操作
- 查看帮助：`cli-anything-<name> --help`
- 执行命令：`cli-anything-<name> <command> [options]`
- JSON输出：`cli-anything-<name> <command> --json`
- REPL模式：`cli-anything-<name>`（交互式）

#### 5. 结果验证
- 检查输出文件是否存在且有效
- 验证JSON输出的结构完整性
- 记录操作证据（cli_tool_installed / cli_command_executed / software_output_generated）

### 模式二：生成新CLI（高级）

#### 1. 准备源码
- 本地软件源码路径：`/cli-anything ./my-software`
- 远程仓库：`/cli-anything https://github.com/user/repo`

#### 2. 自动生成（7阶段流水线）
1. **Analyze** — 扫描源码，映射GUI操作到API
2. **Design** — 规划命令分组、状态模型
3. **Implement** — 构建Click CLI（REPL、JSON、撤销/重做）
4. **Plan Tests** — 生成测试计划
5. **Write Tests** — 实现测试套件
6. **Document** — 更新使用文档
7. **Publish** — 生成setup.py，安装到PATH

#### 3. 安装和验证
- `pip install -e .` — 安装生成的CLI
- 运行测试套件验证功能
- 执行`--help`确认命令可用

### 模式三：优化已有CLI
- `/cli-anything:refine ./software` — 优化已生成的CLI
- `/cli-anything:refine ./software "添加批处理功能"` — 按需求优化
- `/cli-anything:validate ./software` — 验证CLI质量

## 预生成CLI速查表

### 创意与媒体工具
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| gimp | 图像编辑 | 图像处理、图层操作、批量导出 |
| blender | 3D建模/渲染 | 场景创建、3D渲染、动画 |
| inkscape | 矢量图形 | SVG编辑、矢量图操作 |
| krita | 数字绘画 | 画笔绘画、纹理创建 |
| obs-studio | 屏幕录制 | 录屏控制、场景切换 |
| kdenlive | 视频编辑 | 视频剪辑、特效添加 |
| shotcut | 视频编辑 | 视频处理、格式转换 |
| audacity | 音频编辑 | 音频处理、格式转换 |
| musecore | 乐谱编辑 | 乐谱创建、MIDI导出 |
| openshot | 视频编辑 | 简易视频剪辑 |

### 办公与企业应用
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| libreoffice | 办公套件 | 文档生成、PDF转换、数据处理 |
| calibre | 电子书管理 | 电子书转换、元数据编辑、库管理 |
| drawio | 流程图 | 图表创建、流程图编辑 |
| mermaid | 图表可视化 | 流程图、序列图、甘特图 |
| obsidian | 知识管理 | 笔记搜索、知识图谱 |
| zotero | 文献管理 | 文献检索、引用管理 |
| notebooklm | AI笔记 | 笔记总结、知识提取 |

### AI与机器学习平台
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| comfyui | AI绘图 | Stable Diffusion工作流 |
| ollama | 本地LLM | 模型运行、推理调用 |
| chromadb | 向量数据库 | 嵌入存储、相似度搜索 |
| novita | AI云服务 | 模型推理、图像生成 |
| minimax | AI平台 | 对话、TTS语音合成 |
| dify-workflow | AI工作流 | LLM流程编排 |

### 开发与运维工具
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| n8n | 工作流自动化 | 流程编排、API集成 |
| pm2 | 进程管理 | Node.js应用管理、日志 |
| lldb | 调试器 | C/C++调试、断点管理 |
| wiremock | API模拟 | Mock服务、请求录制 |
| adguardhome | 网络管理 | DNS过滤、广告拦截 |
| iterm2 | 终端 | 终端会话管理、分屏 |
| browser | 浏览器控制 | 网页自动化、截图 |

### 工程与科学计算
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| freecad | CAD建模 | 3D建模、工程制图 |
| qgis | GIS地图 | 地理信息处理、地图制作 |
| cloudcompare | 点云处理 | 3D点云比较、分析 |
| renderdoc | 图形调试 | GPU帧分析、渲染调试 |
| nsight-graphics | GPU分析 | NVIDIA性能分析 |
| 3mf | 3D打印 | 3MF网格检查、修复、比较 |
| unimol-tools | 分子建模 | 分子结构分析、药物设计 |

### 数据与分析
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| exa | AI搜索 | 语义搜索、网页检索 |
| cloudanalyzer | 云分析 | 云资源配置分析 |
| firefly-iii | 财务管理 | 记账、预算、报表 |
| mailchimp | 营销自动化 | 邮件营销、受众管理 |

### 游戏与娱乐
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| godot | 游戏引擎 | 游戏开发、场景构建 |
| slay-the-spire-ii | 游戏 | 卡牌策略游戏控制 |

### 其他专业工具
| CLI名称 | 软件类别 | 典型用途 |
|---------|---------|---------|
| sketch | UI设计 | 界面设计、原型制作 |
| safari | 浏览器 | Web自动化、页面操作 |
| zoom | 视频会议 | 会议录制下载、管理 |
| rekordbox | DJ软件 | 音乐库管理、播放列表 |
| videocaptioner | 字幕工具 | 视频字幕生成、翻译 |
| anygen | 通用生成 | 任意软件CLI生成 |

## 安全约束
- 仅操作用户明确授权的软件
- 生成的CLI需通过测试验证后方可用于生产
- 不在CLI命令中传递敏感凭据
- 文件操作限制在项目工作目录内
- `/api/cli-anything/registry`端点仅返回已安装CLI摘要，不暴露系统路径
- 生成新CLI时需用户确认（涉及源码分析和代码生成）
- XML/SVG/ODF/MLT/MusicXML等不可信输入必须通过defusedxml解析（防XXE攻击）
- 数据库写操作需备份机制（如Rekordbox SQLCipher写保护）
- 文件下载操作需验证URL合法性（防SSRF）

## CLI-Hub包管理器
CLI-Hub是CLI-Anything的官方包管理器，用于浏览、安装和管理预生成CLI工具：

| 命令 | 用途 |
|------|------|
| `pip install cli-anything-hub` | 安装CLI-Hub |
| `cli-hub list` | 浏览所有可用CLI |
| `cli-hub search <query>` | 按关键词搜索 |
| `cli-hub info <name>` | 查看CLI详细信息 |
| `cli-hub install <name>` | 安装指定CLI |
| `cli-hub uninstall <name>` | 卸载CLI |
| `npx skills add HKUDS/CLI-Anything --skill <name> -g -y` | 安装SKILL.md技能描述 |

## SKILL.md自动发现
每个CLI-Anything生成的CLI都附带SKILL.md文件，AI Agent可通过以下方式发现和使用：
- `npx skills add` 安装技能描述到本地
- SKILL.md包含完整的命令参考、参数说明和使用示例
- 与框架SkillRouter自动匹配机制兼容

## 回滚机制
- CLI安装失败：`cli-hub uninstall <name>` 清理
- 生成的CLI异常：`pip uninstall cli-anything-<name>` 卸载
- 操作结果不满意：CLI内置undo/redo机制
- MCP连接断开时自动重连
- 文件操作前自动创建备份

## 故障排除
| 症状 | 可能原因 | 解决方案 |
|------|---------|---------|
| `cli-hub: command not found` | CLI-Hub未安装 | 运行`pip install cli-anything-hub` |
| `Python version < 3.10` | Python版本过低 | 升级Python到3.10+ |
| `cli-anything-<name>: not found` | CLI未安装 | 运行`cli-hub install <name>` |
| MCP连接失败 | python命令不在白名单 | 检查mcp-client.js中MCP_ALLOWED_COMMANDS包含python/python3 |
| 软件调用失败 | 目标软件未安装 | 先安装目标软件（如GIMP、Blender） |
| 生成CLI质量差 | 源码分析不充分 | 使用`/cli-anything:refine`优化 |

## 验收标准
- [ ] CLI工具安装成功并可执行
- [ ] --help输出完整
- [ ] --json输出结构化数据
- [ ] 操作结果符合预期

## 常见问题
- **Q: 如何选择预生成CLI还是自动生成？**
  A: 优先使用预生成CLI（cli-hub install），仅当目标软件不在Hub中时才自动生成
- **Q: 生成的CLI质量差？**
  A: 使用`/cli-anything:refine`优化，或提供更完整的源码
