"""Thin async client over the EnterpriseOps-Gym MCP HTTP API.

The MCP server exposes:
  * POST /mcp                  JSON-RPC 2.0 (tools/list, tools/call)
  * POST /api/seed-database    create an isolated SQLite copy seeded from SQL
  * POST /api/sql-runner       run a read-only query against the seeded DB
  * DELETE /api/delete-database  (best-effort cleanup; the server may also
                                  GC databases automatically)

We keep this client deliberately small — the gym's own client lives in
``EnterpriseOps-Gym/benchmark/mcp_client.py`` and supports a lot of features
(multi-gym, auth contexts, retries) we don't need for the demo. If we ever
need them, we can lift more code from there.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MCPClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout)
        self.database_id: str | None = None

    async def close(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ DB
    @staticmethod
    def _new_database_id() -> str:
        return f"mas_demo_{uuid.uuid4().hex[:10]}"

    async def seed_database(self, sql_content: str, description: str = "") -> str:
        """Create a fresh isolated DB seeded with ``sql_content``. Returns the
        new ``database_id`` which subsequent calls must pass via the
        ``x-database-id`` header."""
        db_id = self._new_database_id()
        r = await self._client.post(
            f"{self.base_url}/api/seed-database",
            json={
                "database_id": db_id,
                "name": db_id,
                "description": description or "mas-orchestra demo task",
                "sql_content": sql_content,
            },
        )
        r.raise_for_status()
        payload = r.json()
        # Older gym images return ``{success: True, database_id: ...}`` at the
        # top level; newer ones (e.g. drive) return
        # ``{status: "success", details: {success: True, ...}}``. Accept both.
        details = payload.get("details") or {}
        ok = (
            payload.get("success") is True
            or payload.get("status") == "success"
            or details.get("success") is True
        )
        if not ok:
            raise RuntimeError(f"seed-database failed: {payload}")
        self.database_id = payload.get("database_id") or details.get("database_id") or db_id
        return self.database_id

    async def delete_database(self) -> None:
        """Best-effort cleanup; the server returns 405 on POST for delete in
        some images, so we just try both verbs and swallow errors."""
        if not self.database_id:
            return
        for verb in ("DELETE", "POST"):
            try:
                r = await self._client.request(
                    verb,
                    f"{self.base_url}/api/delete-database",
                    json={"database_id": self.database_id},
                )
                if r.status_code < 400:
                    self.database_id = None
                    return
            except httpx.HTTPError as e:
                logger.warning(f"delete_database failed ({verb}): {e}")

    # ------------------------------------------------------------------ SQL
    async def sql(self, query: str) -> list[dict[str, Any]]:
        """Run a read-only SQL query and return the rows."""
        if not self.database_id:
            raise RuntimeError("no database seeded yet")
        r = await self._client.post(
            f"{self.base_url}/api/sql-runner",
            headers={"x-database-id": self.database_id},
            json={"query": query},
        )
        r.raise_for_status()
        payload = r.json()
        if not payload.get("success", False):
            raise RuntimeError(f"sql failed: {payload}")
        return payload.get("data", [])

    async def list_tables(self) -> list[str]:
        rows = await self.sql(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        return [row["name"] for row in rows]

    # ------------------------------------------------------------------ MCP
    async def list_tools(self) -> list[dict[str, Any]]:
        """Return raw tool descriptors from the gym (`name`, `description`,
        `inputSchema`)."""
        r = await self._client.post(
            f"{self.base_url}/mcp",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        )
        r.raise_for_status()
        return r.json().get("result", {}).get("tools", [])

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        context: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Invoke an MCP tool. ``context`` is forwarded as request headers
        (e.g. ``x-email-user-token``, ``user-id``)."""
        if not self.database_id:
            raise RuntimeError("no database seeded yet")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-database-id": self.database_id,
        }
        if context:
            for k, v in context.items():
                headers[k] = str(v)
        r = await self._client.post(
            f"{self.base_url}/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
        )
        r.raise_for_status()
        return r.json()

    @staticmethod
    def extract_tool_output(rpc_response: dict[str, Any]) -> str:
        """Pull the human-readable payload out of an MCP tools/call response.

        MCP responses look like:
            {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}], "isError": false}}
        """
        result = rpc_response.get("result", {}) or {}
        if rpc_response.get("error"):
            return f"[ERROR] {json.dumps(rpc_response['error'])}"
        if result.get("isError"):
            content = result.get("content") or []
            text = content[0].get("text") if content else None
            return f"[ERROR] {text or 'tool reported error'}"
        content = result.get("content") or []
        if content and isinstance(content[0], dict):
            return content[0].get("text") or json.dumps(result)
        return json.dumps(result)
