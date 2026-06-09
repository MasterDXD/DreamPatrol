"""
Harness Engineering Python SDK - HTTP API Client
Provides Python access to the Harness multi-agent framework.
"""

import json
import urllib.request
import urllib.error
import urllib.parse


class HarnessClient:
    """HTTP client for Harness Engineering Framework API."""

    def __init__(self, base_url="http://localhost:3210", api_token=None):
        self.base_url = base_url.rstrip("/")
        self.api_token = api_token
        self._session = None

    def _request(self, method, path, data=None, params=None):
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_token:
            headers["Authorization"] = "Bearer " + self.api_token
        body = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise HarnessAPIError(e.code, body, str(e))
        except urllib.error.URLError as e:
            raise HarnessConnectionError("Cannot connect to Harness at " + self.base_url + ": " + str(e))

    def get(self, path, params=None):
        return self._request("GET", path, params=params)

    def post(self, path, data=None):
        return self._request("POST", path, data=data)

    def health(self):
        return self.get("/api/health")

    def status(self):
        return self.get("/api/status")

    def rag_stats(self):
        return self.get("/api/rag/stats")

    def rag_query(self, query, top_k=5):
        return self.get("/api/rag/query", params={"q": query, "top_k": str(top_k)})

    def changelog_search(self, query="", page=1, page_size=20):
        return self.get("/api/changelog/search", params={"q": query, "page": str(page), "pageSize": str(page_size)})

    def pipeline_analyze(self, message, agent=""):
        return self.get("/api/pipeline/analyze", params={"message": message, "agent": agent})

    def agent_lifecycle(self):
        return self.get("/api/agent-lifecycle")

    def agent_monitor_metrics(self):
        return self.get("/api/agent-monitor/metrics")

    def design_presets(self):
        return self.get("/api/design/presets")

    def checkpoints(self):
        return self.get("/api/checkpoints")

    def learnings(self):
        return self.get("/api/learnings")

    # --- Agent Management ---
    def agent_list(self):
        """获取Agent列表"""
        return self.get('/api/agents')

    def agent_lifecycle_list(self):
        """获取Agent生命周期列表"""
        return self.get('/api/agent-lifecycle/list')

    def agent_runtime_stats(self):
        """获取Agent运行时统计"""
        return self.get('/api/agent-runtime/stats')

    # --- Skill Management ---
    def skill_list(self):
        """获取技能列表"""
        return self.get('/api/skills')

    def skill_layers_stats(self):
        """获取技能层级统计"""
        return self.get('/api/skill-layers/stats')

    # --- Session Management ---
    def session_list(self):
        """获取会话列表"""
        return self.get('/api/sessions')

    # --- Goal Management ---
    def goal_list(self):
        """获取目标列表"""
        return self.get('/api/goal/list')

    def goal_stats(self):
        """获取目标统计"""
        return self.get('/api/goal/stats')

    # --- Collaboration ---
    def collaboration_modes(self):
        """获取协作模式"""
        return self.get('/api/collaboration/modes')

    def collaboration_stats(self):
        """获取协作统计"""
        return self.get('/api/collaboration/stats')

    # --- Deepening ---
    def deepening_stats(self):
        """获取深化推理统计"""
        return self.get('/api/deepening/stats')

    def deepening_quality(self):
        """获取深化推理质量"""
        return self.get('/api/deepening/quality')

    # --- Infrastructure ---
    def command_router_stats(self):
        """获取命令路由统计"""
        return self.get('/api/command-router/stats')

    def context_compression_stats(self):
        """获取上下文压缩统计"""
        return self.get('/api/context-compression/stats')

    # --- Memory ---
    def memory_entries(self):
        """获取记忆条目"""
        return self.get('/api/memory/entries')

    def memory_usage(self):
        """获取记忆使用情况"""
        return self.get('/api/memory/usage')

    # --- MCP ---
    def mcp_status(self):
        """获取MCP服务器状态"""
        return self.get('/api/mcp/status')

    def mcp_tools(self):
        """获取MCP工具列表"""
        return self.get('/api/mcp/tools')

    # --- Code Wiki ---
    def code_wiki_stats(self):
        """获取代码维基统计"""
        return self.get('/api/code-wiki/stats')

    # --- Framework ---
    def framework_status(self):
        """获取框架状态"""
        return self.get('/api/framework/status')

    def framework_features(self):
        """获取框架特性"""
        return self.get('/api/framework/features')

    # --- Performance ---
    def performance_stats(self):
        """获取性能统计"""
        return self.get('/api/performance')


class HarnessAPIError(Exception):
    def __init__(self, status_code, body, message=""):
        self.status_code = status_code
        self.body = body
        super().__init__(f"Harness API Error {status_code}: {message}")


class HarnessConnectionError(Exception):
    pass
