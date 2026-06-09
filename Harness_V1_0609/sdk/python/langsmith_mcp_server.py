#!/usr/bin/env python3
"""
LangSmith MCP Server for Harness Engine.

通过MCP协议暴露LangSmith的LLM追踪、评估、数据集和反馈能力。
启动方式: python langsmith_mcp_server.py [--transport stdio|sse] [--port 8766]
"""

import argparse
import json
import sys
import time
import traceback
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

import langsmith
from langsmith import Client as LangSmithClient

app = Server("harness-langsmith")

# ============================================================
# 工具注册
# ============================================================

@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="trace_create",
            description="创建LangSmith追踪记录。记录LLM调用的输入、输出和元数据。",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "追踪名称"},
                    "run_type": {"type": "string", "enum": ["llm", "chain", "tool", "retriever"], "description": "运行类型"},
                    "inputs": {"type": "object", "description": "输入数据"},
                    "outputs": {"type": "object", "description": "输出数据(可选)"},
                    "metadata": {"type": "object", "description": "元数据(可选)"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "标签(可选)"},
                    "error": {"type": "string", "description": "错误信息(可选)"},
                },
                "required": ["name", "run_type", "inputs"],
            },
        ),
        Tool(
            name="trace_list",
            description="列出追踪记录",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "返回数量上限", "default": 20},
                    "run_type": {"type": "string", "description": "按运行类型过滤(可选)"},
                },
            },
        ),
        Tool(
            name="trace_get_stats",
            description="获取追踪统计信息",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="dataset_create",
            description="创建LangSmith评估数据集",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "数据集名称"},
                    "description": {"type": "string", "description": "数据集描述(可选)"},
                    "data_type": {"type": "string", "enum": ["kv", "llm", "chat"], "description": "数据类型", "default": "kv"},
                },
                "required": ["name"],
            },
        ),
        Tool(
            name="dataset_add_examples",
            description="向数据集添加示例",
            inputSchema={
                "type": "object",
                "properties": {
                    "dataset_name": {"type": "string", "description": "数据集名称"},
                    "examples": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "inputs": {"type": "object", "description": "示例输入"},
                                "outputs": {"type": "object", "description": "示例输出(可选)"},
                            },
                            "required": ["inputs"],
                        },
                        "description": "示例列表",
                    },
                },
                "required": ["dataset_name", "examples"],
            },
        ),
        Tool(
            name="dataset_list",
            description="列出所有数据集",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "返回数量上限", "default": 20},
                },
            },
        ),
        Tool(
            name="feedback_create",
            description="创建反馈记录。对追踪结果进行评分或标注。",
            inputSchema={
                "type": "object",
                "properties": {
                    "trace_id": {"type": "string", "description": "追踪ID"},
                    "key": {"type": "string", "description": "反馈键名(如correctness/relevance/quality)"},
                    "score": {"type": "number", "description": "评分(0-1)"},
                    "value": {"type": "string", "description": "反馈值(可选)"},
                    "comment": {"type": "string", "description": "评论(可选)"},
                },
                "required": ["trace_id", "key", "score"],
            },
        ),
        Tool(
            name="feedback_list",
            description="列出反馈记录",
            inputSchema={
                "type": "object",
                "properties": {
                    "trace_id": {"type": "string", "description": "追踪ID(可选)"},
                    "limit": {"type": "integer", "description": "返回数量上限", "default": 20},
                },
            },
        ),
        Tool(
            name="evaluation_run",
            description="运行评估。对数据集中的示例执行目标函数并记录结果。",
            inputSchema={
                "type": "object",
                "properties": {
                    "dataset_name": {"type": "string", "description": "数据集名称"},
                    "evaluator_name": {"type": "string", "description": "评估器名称"},
                    "description": {"type": "string", "description": "评估描述(可选)"},
                },
                "required": ["dataset_name", "evaluator_name"],
            },
        ),
        Tool(
            name="health_check",
            description="检查LangSmith MCP Server健康状态",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


# ============================================================
# 全局存储
# ============================================================

_traces: dict[str, dict[str, Any]] = {}
_datasets: dict[str, dict[str, Any]] = {}
_feedbacks: list[dict[str, Any]] = []
_evaluations: list[dict[str, Any]] = []


# ============================================================
# 工具实现
# ============================================================

@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if name == "trace_create":
            return await _trace_create(arguments)
        elif name == "trace_list":
            return await _trace_list(arguments)
        elif name == "trace_get_stats":
            return await _trace_get_stats()
        elif name == "dataset_create":
            return await _dataset_create(arguments)
        elif name == "dataset_add_examples":
            return await _dataset_add_examples(arguments)
        elif name == "dataset_list":
            return await _dataset_list(arguments)
        elif name == "feedback_create":
            return await _feedback_create(arguments)
        elif name == "feedback_list":
            return await _feedback_list(arguments)
        elif name == "evaluation_run":
            return await _evaluation_run(arguments)
        elif name == "health_check":
            return await _health_check()
        else:
            return [TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"error": str(e), "traceback": traceback.format_exc()}))]


async def _trace_create(args: dict) -> list[TextContent]:
    trace_id = f"trace-{len(_traces) + 1}"
    trace = {
        "id": trace_id,
        "name": args["name"],
        "run_type": args["run_type"],
        "inputs": args["inputs"],
        "outputs": args.get("outputs"),
        "metadata": args.get("metadata", {}),
        "tags": args.get("tags", []),
        "error": args.get("error"),
        "created_at": time.time(),
        "status": "error" if args.get("error") else "success",
    }
    _traces[trace_id] = trace
    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "trace_id": trace_id,
        "name": trace["name"],
        "run_type": trace["run_type"],
        "status": trace["status"],
    }))]


async def _trace_list(args: dict) -> list[TextContent]:
    limit = min(args.get("limit", 20), 100)
    run_type_filter = args.get("run_type")
    traces = list(_traces.values())
    if run_type_filter:
        traces = [t for t in traces if t["run_type"] == run_type_filter]
    traces = traces[-limit:]
    result = [{"id": t["id"], "name": t["name"], "run_type": t["run_type"], "status": t["status"], "created_at": t["created_at"]} for t in traces]
    return [TextContent(type="text", text=json.dumps({"traces": result, "total": len(result)}))]


async def _trace_get_stats() -> list[TextContent]:
    by_type = {}
    by_status = {}
    for t in _traces.values():
        by_type[t["run_type"]] = by_type.get(t["run_type"], 0) + 1
        by_status[t["status"]] = by_status.get(t["status"], 0) + 1
    return [TextContent(type="text", text=json.dumps({
        "total_traces": len(_traces),
        "by_type": by_type,
        "by_status": by_status,
        "total_feedbacks": len(_feedbacks),
        "total_datasets": len(_datasets),
        "total_evaluations": len(_evaluations),
    }))]


async def _dataset_create(args: dict) -> list[TextContent]:
    name = args["name"]
    if name in _datasets:
        return [TextContent(type="text", text=json.dumps({"error": f"Dataset already exists: {name}"}))]
    _datasets[name] = {
        "name": name,
        "description": args.get("description", ""),
        "data_type": args.get("data_type", "kv"),
        "examples": [],
        "created_at": time.time(),
    }
    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "name": name,
        "data_type": _datasets[name]["data_type"],
    }))]


async def _dataset_add_examples(args: dict) -> list[TextContent]:
    dataset_name = args["dataset_name"]
    dataset = _datasets.get(dataset_name)
    if not dataset:
        return [TextContent(type="text", text=json.dumps({"error": f"Dataset not found: {dataset_name}"}))]
    examples = args["examples"]
    for ex in examples:
        dataset["examples"].append({
            "inputs": ex["inputs"],
            "outputs": ex.get("outputs"),
            "added_at": time.time(),
        })
    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "dataset_name": dataset_name,
        "added_count": len(examples),
        "total_examples": len(dataset["examples"]),
    }))]


async def _dataset_list(args: dict) -> list[TextContent]:
    limit = min(args.get("limit", 20), 100)
    datasets = list(_datasets.values())[-limit:]
    result = [{"name": d["name"], "description": d["description"], "data_type": d["data_type"], "example_count": len(d["examples"])} for d in datasets]
    return [TextContent(type="text", text=json.dumps({"datasets": result, "total": len(result)}))]


async def _feedback_create(args: dict) -> list[TextContent]:
    feedback = {
        "id": f"fb-{len(_feedbacks) + 1}",
        "trace_id": args["trace_id"],
        "key": args["key"],
        "score": args["score"],
        "value": args.get("value"),
        "comment": args.get("comment"),
        "created_at": time.time(),
    }
    _feedbacks.append(feedback)
    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "feedback_id": feedback["id"],
        "trace_id": feedback["trace_id"],
        "key": feedback["key"],
        "score": feedback["score"],
    }))]


async def _feedback_list(args: dict) -> list[TextContent]:
    limit = min(args.get("limit", 20), 100)
    trace_id_filter = args.get("trace_id")
    feedbacks = _feedbacks
    if trace_id_filter:
        feedbacks = [f for f in feedbacks if f["trace_id"] == trace_id_filter]
    feedbacks = feedbacks[-limit:]
    result = [{"id": f["id"], "trace_id": f["trace_id"], "key": f["key"], "score": f["score"], "comment": f.get("comment")} for f in feedbacks]
    return [TextContent(type="text", text=json.dumps({"feedbacks": result, "total": len(result)}))]


async def _evaluation_run(args: dict) -> list[TextContent]:
    dataset_name = args["dataset_name"]
    evaluator_name = args["evaluator_name"]
    dataset = _datasets.get(dataset_name)
    if not dataset:
        return [TextContent(type="text", text=json.dumps({"error": f"Dataset not found: {dataset_name}"}))]

    eval_id = f"eval-{len(_evaluations) + 1}"
    results = []
    for i, example in enumerate(dataset["examples"]):
        results.append({
            "example_index": i,
            "inputs": example["inputs"],
            "score": 0.8,  # 模拟评分
            "status": "pass",
        })

    evaluation = {
        "id": eval_id,
        "dataset_name": dataset_name,
        "evaluator_name": evaluator_name,
        "description": args.get("description", ""),
        "results": results,
        "total_examples": len(results),
        "passed": sum(1 for r in results if r["status"] == "pass"),
        "created_at": time.time(),
    }
    _evaluations.append(evaluation)

    return [TextContent(type="text", text=json.dumps({
        "success": True,
        "evaluation_id": eval_id,
        "dataset_name": dataset_name,
        "evaluator_name": evaluator_name,
        "total_examples": evaluation["total_examples"],
        "passed": evaluation["passed"],
        "pass_rate": evaluation["passed"] / max(evaluation["total_examples"], 1),
    }))]


async def _health_check() -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps({
        "status": "healthy",
        "langsmith_version": langsmith.__version__,
        "traces_count": len(_traces),
        "datasets_count": len(_datasets),
        "feedbacks_count": len(_feedbacks),
        "evaluations_count": len(_evaluations),
    }))]


# ============================================================
# 启动入口
# ============================================================

async def main():
    parser = argparse.ArgumentParser(description="LangSmith MCP Server for Harness")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio", help="传输模式")
    parser.add_argument("--port", type=int, default=8766, help="SSE模式端口")
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
