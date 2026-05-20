"""Per-domain MCP tool catalog cache + JSON-Schema sanitizer.

We hit each gym's ``tools/list`` once per process lifetime and cache the
descriptors. We also sanitize MCP ``inputSchema``s so they are compatible
with OpenAI function-calling (which is stricter than what gyms emit):

  * drop ``$schema``, ``$ref``, ``$defs``
  * unwrap ``oneOf``/``anyOf``/``allOf`` to the first variant (lossy but
    sufficient for a demo)
  * coerce ``type: ["string","null"]`` → ``type: "string"`` + nullable hint
  * default to ``type: "object"`` at the top level so the model has a
    well-formed parameters object
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from .gym_config import get_gym
from .mcp_client import MCPClient

logger = logging.getLogger(__name__)

_CACHE: dict[str, list[dict[str, Any]]] = {}
_LOCK = asyncio.Lock()


def _sanitize_schema(schema: dict[str, Any] | None) -> dict[str, Any]:
    if not schema or not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    out: dict[str, Any] = {}
    for k, v in schema.items():
        if k in ("$schema", "$ref", "$defs", "definitions"):
            continue
        if k in ("oneOf", "anyOf", "allOf") and isinstance(v, list) and v:
            inner = _sanitize_schema(v[0])
            for ik, iv in inner.items():
                out.setdefault(ik, iv)
            continue
        if k == "type" and isinstance(v, list):
            non_null = [t for t in v if t != "null"]
            out["type"] = non_null[0] if non_null else "string"
            if "null" in v:
                out["nullable"] = True
            continue
        if k == "properties" and isinstance(v, dict):
            # `properties` is a mapping of name → schema; sanitize each value
            # but DO NOT treat the mapping itself as a schema.
            out[k] = {name: _sanitize_schema(sub) for name, sub in v.items()}
            continue
        if isinstance(v, dict):
            out[k] = _sanitize_schema(v)
        elif isinstance(v, list) and k == "items":
            out[k] = _sanitize_schema(v[0] if v else {})
        elif isinstance(v, list) and all(isinstance(x, dict) for x in v):
            out[k] = [_sanitize_schema(x) for x in v]
        else:
            out[k] = v
    if "type" not in out and "properties" in out:
        out["type"] = "object"
    if "properties" in out and not isinstance(out.get("properties"), dict):
        out["properties"] = {}
    return out


def _to_openai_tool(t: dict[str, Any]) -> dict[str, Any]:
    schema = _sanitize_schema(t.get("inputSchema") or {})
    if schema.get("type") != "object":
        schema = {"type": "object", "properties": {}}
    return {
        "type": "function",
        "function": {
            "name": t.get("name", "tool"),
            "description": (t.get("description") or "")[:1024],
            "parameters": schema,
        },
    }


async def get_catalog(domain: str) -> list[dict[str, Any]]:
    """Return the cached list of raw tool descriptors for ``domain``."""
    if domain in _CACHE:
        return _CACHE[domain]
    async with _LOCK:
        if domain in _CACHE:
            return _CACHE[domain]
        gym = get_gym(domain)
        client = MCPClient(gym.url)
        try:
            tools = await client.list_tools()
        finally:
            await client.close()
        _CACHE[domain] = tools
        logger.info(f"cached {len(tools)} tools for domain={domain}")
        return tools


async def get_tool_summary(domain: str) -> list[dict[str, Any]]:
    """UI-friendly compact tool descriptors: ``[{name, description}]``."""
    cat = await get_catalog(domain)
    return [
        {
            "name": t.get("name"),
            "description": (t.get("description") or "").split("\n\n")[0][:240],
        }
        for t in cat
    ]


async def get_openai_tools(
    domain: str, names: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return OpenAI-format function-calling tool definitions, optionally
    filtered to ``names``."""
    cat = await get_catalog(domain)
    if names is not None:
        wanted = set(names)
        cat = [t for t in cat if t.get("name") in wanted]
    return [_to_openai_tool(t) for t in cat]


def lookup(catalog: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    for t in catalog:
        if t.get("name") == name:
            return t
    return None
