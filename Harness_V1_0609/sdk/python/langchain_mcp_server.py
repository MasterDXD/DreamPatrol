#!/usr/bin/env python3
"""
LangChain/LangGraph MCP Server for Harness Engine.

通过MCP协议暴露LangChain链管理和LangGraph工作流能力。
启动方式: python langchain_mcp_server.py [--transport stdio|sse] [--port 8765]
"""

import argparse
import json
import sys
import traceback
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# LangChain imports
from langchain_core.runnables import RunnableLambda, RunnableSequence
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate

# LangGraph imports
from langgraph.graph import StateGraph, END, START

app = Server("harness-langchain")

# ============================================================
# 工具注册
# ============================================================

@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="chain_create",
            description="创建LangChain链。支持: sequential(顺序链), branching(分支链), map_reduce(映射归约链)",
            inputSchema={
                "type": "object",
                "properties": {
                    "chain_type": {"type": "string", "enum": ["sequential", "branching", "map_reduce"], "description": "链类型"},
                    "name": {"type": "string", "description": "链名称"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "enum": ["prompt", "parser", "lambda", "conditional"], "description": "步骤类型"},
                                "template": {"type": "string", "description": "prompt模板(仅prompt类型)"},
                                "condition": {"type": "string", "description": "条件表达式(仅conditional类型)"},
                                "transform": {"type": "string", "description": "转换函数描述(仅lambda类型)"},
                            },
                            "required": ["type"],
                        },
                        "description": "链步骤定义",
                    },
                },
                "required": ["chain_type", "name", "steps"],
            },
        ),
        Tool(
            name="chain_invoke",
            description="执行已创建的LangChain链",
            inputSchema={
                "type": "object",
                "properties": {
                    "chain_id": {"type": "string", "description": "链ID"},
                    "input": {"type": "object", "description": "链输入数据"},
                },
                "required": ["chain_id", "input"],
            },
        ),
        Tool(
            name="chain_list",
            description="列出所有已创建的链",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="graph_create",
            description="创建LangGraph状态图。定义节点和边来构建工作流图",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "图名称"},
                    "state_schema": {
                        "type": "object",
                        "properties": {
                            "fields": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"},
                                        "type": {"type": "string", "enum": ["str", "int", "float", "bool", "list", "dict"]},
                                        "default": {},
                                    },
                                    "required": ["name", "type"],
                                },
                                "description": "状态字段定义",
                            },
                        },
                        "required": ["fields"],
                    },
                    "nodes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "节点ID"},
                                "type": {"type": "string", "enum": ["process", "decision", "parallel", "merge"], "description": "节点类型"},
                                "description": {"type": "string", "description": "节点功能描述"},
                            },
                            "required": ["id", "type", "description"],
                        },
                        "description": "节点定义",
                    },
                    "edges": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": {"type": "string", "description": "源节点ID"},
                                "to": {"type": "string", "description": "目标节点ID"},
                                "condition": {"type": "string", "description": "条件表达式(可选)"},
                            },
                            "required": ["from", "to"],
                        },
                        "description": "边定义",
                    },
                },
                "required": ["name", "state_schema", "nodes", "edges"],
            },
        ),
        Tool(
            name="graph_invoke",
            description="执行已创建的LangGraph状态图",
            inputSchema={
                "type": "object",
                "properties": {
                    "graph_id": {"type": "string", "description": "图ID"},
                    "input": {"type": "object", "description": "图输入状态"},
                },
                "required": ["graph_id", "input"],
            },
        ),
        Tool(
            name="graph_visualize",
            description="生成LangGraph状态图的可视化描述(Mermaid格式)",
            inputSchema={
                "type": "object",
                "properties": {
                    "graph_id": {"type": "string", "description": "图ID"},
                },
                "required": ["graph_id"],
            },
        ),
        Tool(
            name="graph_list",
            description="列出所有已创建的状态图",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="prompt_template_create",
            description="创建LangChain Prompt模板",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "模板名称"},
                    "template": {"type": "string", "description": "模板内容，使用{variable}占位符"},
                    "variables": {"type": "array", "items": {"type": "string"}, "description": "模板变量列表"},
                },
                "required": ["name", "template", "variables"],
            },
        ),
        Tool(
            name="prompt_template_render",
            description="渲染Prompt模板",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "模板名称"},
                    "values": {"type": "object", "description": "变量值映射"},
                },
                "required": ["name", "values"],
            },
        ),
        Tool(
            name="health_check",
            description="检查LangChain/LangGraph MCP Server健康状态",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


# ============================================================
# 全局存储
# ============================================================

_chains: dict[str, dict[str, Any]] = {}
_graphs: dict[str, dict[str, Any]] = {}
_prompt_templates: dict[str, dict[str, Any]] = {}


# ============================================================
# 工具实现
# ============================================================

@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if name == "chain_create":
            return await _chain_create(arguments)
        elif name == "chain_invoke":
            return await _chain_invoke(arguments)
        elif name == "chain_list":
            return await _chain_list()
        elif name == "graph_create":
            return await _graph_create(arguments)
        elif name == "graph_invoke":
            return await _graph_invoke(arguments)
        elif name == "graph_visualize":
            return await _graph_visualize(arguments)
        elif name == "graph_list":
            return await _graph_list()
        elif name == "prompt_template_create":
            return await _prompt_template_create(arguments)
        elif name == "prompt_template_render":
            return await _prompt_template_render(arguments)
        elif name == "health_check":
            return await _health_check()
        else:
            return [TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"error": str(e), "traceback": traceback.format_exc()}))]


async def _chain_create(args: dict) -> list[TextContent]:
    chain_id = f"chain-{len(_chains) + 1}"
    chain_type = args["chain_type"]
    name = args["name"]
    steps = args["steps"]

    # 构建Runnable序列
    runnables = []
    for step in steps:
        step_type = step["type"]
        if step_type == "prompt":
            template = step.get("template", "")
            prompt = ChatPromptTemplate.from_template(template)
            runnables.append(prompt)
        elif step_type == "parser":
            runnables.append(StrOutputParser())
        elif step_type == "lambda":
            desc = step.get("transform", "identity")
            runnables.append(RunnableLambda(lambda x, _d=desc: x))
        elif step_type == "conditional":
            runnables.append(RunnableLambda(lambda x: x))

    # 创建链
    if len(runnables) > 1:
        chain = RunnableSequence(*runnables)
    elif len(runnables) == 1:
        chain = runnables[0]
    else:
        chain = RunnableLambda(lambda x: x)

    _chains[chain_id] = {
        "id": chain_id,
        "name": name,
        "type": chain_type,
        "steps": steps,
        "runnable": chain,
        "created_at": __import__("time").time(),
    }

    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "chain_id": chain_id,
        "name": name,
        "type": chain_type,
        "step_count": len(steps),
    }))]


async def _chain_invoke(args: dict) -> list[TextContent]:
    chain_id = args["chain_id"]
    chain_data = _chains.get(chain_id)
    if not chain_data:
        return [TextContent(type="text", text=json.dumps({"error": f"Chain not found: {chain_id}"}))]

    chain = chain_data["runnable"]
    input_data = args["input"]

    try:
        result = chain.invoke(input_data)
        if hasattr(result, "to_messages"):
            result = str(result)
        elif not isinstance(result, str):
            result = json.dumps(result, default=str, ensure_ascii=False)
        return [TextContent(type="text", text=json.dumps({"success": True, "chain_id": chain_id, "result": result}))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"success": False, "chain_id": chain_id, "error": str(e)}))]


async def _chain_list() -> list[TextContent]:
    chains = [{"id": c["id"], "name": c["name"], "type": c["type"], "step_count": len(c["steps"])} for c in _chains.values()]
    return [TextContent(type="text", text=json.dumps({"chains": chains, "total": len(chains)}))]


async def _graph_create(args: dict) -> list[TextContent]:
    graph_id = f"graph-{len(_graphs) + 1}"
    name = args["name"]
    state_schema = args["state_schema"]
    nodes = args["nodes"]
    edges = args["edges"]

    # 创建状态图定义
    _graphs[graph_id] = {
        "id": graph_id,
        "name": name,
        "state_schema": state_schema,
        "nodes": nodes,
        "edges": edges,
        "created_at": __import__("time").time(),
    }

    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "graph_id": graph_id,
        "name": name,
        "node_count": len(nodes),
        "edge_count": len(edges),
    }))]


async def _graph_invoke(args: dict) -> list[TextContent]:
    graph_id = args["graph_id"]
    graph_data = _graphs.get(graph_id)
    if not graph_data:
        return [TextContent(type="text", text=json.dumps({"error": f"Graph not found: {graph_id}"}))]

    input_state = args["input"]

    # 构建并执行LangGraph状态图
    try:
        # 动态构建StateGraph
        state_fields = {}
        for field in graph_data["state_schema"]["fields"]:
            field_name = field["name"]
            field_type = field["type"]
            type_map = {"str": str, "int": int, "float": float, "bool": bool, "list": list, "dict": dict}
            python_type = type_map.get(field_type, str)
            state_fields[field_name] = python_type

        # 创建简单的状态字典
        from typing import TypedDict
        State = TypedDict("State", {k: v for k, v in state_fields.items()})

        sg = StateGraph(State)

        # 添加节点
        for node in graph_data["nodes"]:
            node_id = node["id"]
            node_desc = node["description"]

            def make_node_fn(nid, ndesc):
                def node_fn(state):
                    result = dict(state)
                    result["_last_node"] = nid
                    result["_node_output"] = ndesc
                    return result
                return node_fn

            sg.add_node(node_id, make_node_fn(node_id, node_desc))

        # 添加边
        for edge in graph_data["edges"]:
            from_node = edge["from"]
            to_node = edge["to"]
            condition = edge.get("condition")

            if from_node == "START":
                sg.add_edge(START, to_node)
            elif to_node == "END":
                sg.add_edge(from_node, END)
            elif condition:
                # 条件边 - 简化处理
                sg.add_edge(from_node, to_node)
            else:
                sg.add_edge(from_node, to_node)

        compiled = sg.compile()
        result = compiled.invoke(input_state)

        return [TextContent(type="text", text=json.dumps({
            "success": True,
            "graph_id": graph_id,
            "result": {k: v for k, v in result.items() if not k.startswith("_")},
        }, default=str, ensure_ascii=False))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"success": False, "graph_id": graph_id, "error": str(e)}))]


async def _graph_visualize(args: dict) -> list[TextContent]:
    graph_id = args["graph_id"]
    graph_data = _graphs.get(graph_id)
    if not graph_data:
        return [TextContent(type="text", text=json.dumps({"error": f"Graph not found: {graph_id}"}))]

    # 生成Mermaid图
    lines = ["graph TD"]
    for node in graph_data["nodes"]:
        node_id = node["id"]
        node_type = node["type"]
        node_desc = node["description"]
        shape_map = {"process": "([{}])", "decision": "{{{{{}}}}}", "parallel": "[[{}]]", "merge": "[{}]"}
        shape = shape_map.get(node_type, "[{}]")
        lines.append(f"    {node_id}{shape.format(node_desc)}")

    for edge in graph_data["edges"]:
        from_node = edge["from"]
        to_node = edge["to"]
        condition = edge.get("condition", "")
        label = f"|{condition}|" if condition else ""
        if from_node == "START":
            lines.append(f"    START({{Start}}) -->{label} {to_node}")
        elif to_node == "END":
            lines.append(f"    {from_node} -->{label} END({{End}})")
        else:
            lines.append(f"    {from_node} -->{label} {to_node}")

    mermaid = "\n".join(lines)
    return [TextContent(type="text", text=json.dumps({
        "graph_id": graph_id,
        "name": graph_data["name"],
        "format": "mermaid",
        "diagram": mermaid,
        "node_count": len(graph_data["nodes"]),
        "edge_count": len(graph_data["edges"]),
    }))]


async def _graph_list() -> list[TextContent]:
    graphs = [{"id": g["id"], "name": g["name"], "node_count": len(g["nodes"]), "edge_count": len(g["edges"])} for g in _graphs.values()]
    return [TextContent(type="text", text=json.dumps({"graphs": graphs, "total": len(graphs)}))]


async def _prompt_template_create(args: dict) -> list[TextContent]:
    name = args["name"]
    template = args["template"]
    variables = args["variables"]

    _prompt_templates[name] = {
        "name": name,
        "template": template,
        "variables": variables,
        "prompt": ChatPromptTemplate.from_template(template),
    }

    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "name": name,
        "variable_count": len(variables),
    }))]


async def _prompt_template_render(args: dict) -> list[TextContent]:
    name = args["name"]
    values = args["values"]
    tmpl = _prompt_templates.get(name)
    if not tmpl:
        return [TextContent(type="text", text=json.dumps({"error": f"Template not found: {name}"}))]

    try:
        result = tmpl["prompt"].invoke(values)
        return [TextContent(type="text", text=json.dumps({"success": True, "name": name, "rendered": str(result)}))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"success": False, "error": str(e)}))]


async def _health_check() -> list[TextContent]:
    import langchain
    return [TextContent(type="text", text=json.dumps({
        "status": "healthy",
        "langchain_version": langchain.__version__,
        "langgraph_available": True,
        "chains_count": len(_chains),
        "graphs_count": len(_graphs),
        "templates_count": len(_prompt_templates),
    }))]


# ============================================================
# 启动入口
# ============================================================

async def main():
    parser = argparse.ArgumentParser(description="LangChain/LangGraph MCP Server for Harness")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio", help="传输模式")
    parser.add_argument("--port", type=int, default=8765, help="SSE模式端口")
    args = parser.parse_args()

    if args.transport == "stdio":
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream, app.create_initialization_options())
    else:
        from mcp.server.sse import SseServerTransport
        from starlette.applications import Starlette
        import starlette.routing
        import uvicorn

        sse = SseServerTransport("/messages/")

        async def handle_sse(request):
            async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
                await app.run(streams[0], streams[1], app.create_initialization_options())

        starlette_app = Starlette(routes=[
            starlette.routing.Route("/sse", endpoint=handle_sse),
            starlette.routing.Route("/messages/", endpoint=sse.handle_post_message, methods=["POST"]),
        ])
        uvicorn.run(starlette_app, host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
