# Harness Engineering Python SDK

Python客户端SDK，用于与Harness Engineering多Agent框架的HTTP API交互。

## 安装

```bash
pip install -e .
```

## 快速开始

```python
from harness_sdk import HarnessClient

# 创建客户端
client = HarnessClient(base_url='http://localhost:3210', api_token='your-token')

# 健康检查
health = client.health()

# 查询RAG
results = client.rag_query('如何实现TDD？', top_k=5)

# 获取Agent列表
agents = client.agent_list()

# 获取技能列表
skills = client.skill_list()
```

## API 方法

| 方法 | 说明 |
|------|------|
| `health()` | 健康检查 |
| `status()` | 系统状态 |
| `agent_list()` | Agent列表 |
| `skill_list()` | 技能列表 |
| `session_list()` | 会话列表 |
| `goal_list()` | 目标列表 |
| `collaboration_modes()` | 协作模式 |
| `deepening_stats()` | 深化推理统计 |
| `rag_query(query, top_k)` | RAG查询 |
| `rag_stats()` | RAG统计 |
| `memory_entries()` | 记忆条目 |
| `mcp_status()` | MCP状态 |
| `framework_status()` | 框架状态 |
| `performance_stats()` | 性能统计 |

## 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `base_url` | `http://localhost:3210` | 服务地址 |
| `api_token` | `None` | API认证Token |
| `timeout` | `30` | 请求超时(秒) |

## 许可证

MIT License
