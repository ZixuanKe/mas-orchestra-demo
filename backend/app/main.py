from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

import asyncio
import json
import os
import re
import secrets
import time
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
# from slowapi import Limiter, _rate_limit_exceeded_handler
# from slowapi.errors import RateLimitExceeded
# from slowapi.util import get_remote_address

from .models import Graph, Dataset, DATASET_META, DomLevel, FILE_TOOL_AGENT_TYPES, FILE_TOOL_NAMES
from .datasets import get_samples
from .parser import parse, topo_sort
from .metaagent import call_metaagent
from .executor import execute_agent
from .refine import refine_plan
from .designer import design_agent
from .enterprise.gym_config import list_gyms, get_gym
from .enterprise.tasks import list_tasks, get_task, task_count_by_domain, register_custom_task
from .enterprise.tool_catalog import get_tool_summary
from . import enterprise_orch
from . import users as users_store

# limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="MAS-Orchestra")
# app.state.limiter = limiter
# app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class PlanRequest(BaseModel):
    problem: str
    dataset: Dataset | None = None
    dom: DomLevel | None = None
    # Enterprise-mode fields. When `enterprise_task_id` is set the request is
    # routed to the enterprise orchestrator and `dataset`/`dom`/`problem` are
    # ignored (the task carries its own user/system prompt).
    enterprise_task_id: str | None = None
    enabled_tools: list[str] | None = None
    subagent_model: str | None = None
    # When True, the planner prompt advertises the local file-tool agents
    # (ReadFileAgent, WriteFileAgent, PatchAgent, SearchFilesAgent) as
    # available. Only the CLI sets this — the webapp leaves it False so
    # the planner never proposes agents the browser can't execute.
    file_tools_enabled: bool = False


class PlanResponse(BaseModel):
    xml: str
    graph: dict
    thinking: str | None = None
    # When the planner ran in enterprise mode we echo back the resolved
    # task + tool catalog so the frontend doesn't have to refetch.
    enterprise_task: dict | None = None
    # Initial sandbox snapshot taken from a fresh seed of the task's gym DB.
    # Sent so the UI can render the "before" state immediately, before the
    # user even hits Run. Same shape as the sandbox_snapshot SSE event.
    initial_snapshot: dict | None = None
    # Non-fatal planner warning (e.g. vLLM unreachable so we returned a
    # mock; enterprise planner LLM crashed so we returned the linear
    # fallback). The frontend renders this as an inline warning turn so
    # the user knows the displayed plan isn't what the trained planner
    # would have produced.
    warning: str | None = None


class RefineRequest(BaseModel):
    problem: str
    current_xml: str
    messages: list[dict] = []
    dom: DomLevel | None = None
    custom_agents: list[dict] = []
    # Enterprise-mode refine: when set, /refine bypasses the reasoning-mode
    # refiner (which only knows CoTAgent/SCAgent/… types and lacks the gym
    # tool catalog) and routes to ``enterprise_orch.refine_enterprise_plan``
    # which emits the MCPAgent/EnterpriseExecutorAgent schema.
    enterprise_task_id: str | None = None
    # Subset of tools the user has enabled in the EnterprisePicker. Used to
    # narrow the catalog shown to the refiner LLM so it doesn't invent
    # disabled tool names. Ignored in reasoning mode.
    enabled_tools: list[str] | None = None
    # See PlanRequest.file_tools_enabled. Only the CLI sets this True.
    file_tools_enabled: bool = False


class RefineResponse(BaseModel):
    message: str
    xml: str | None = None
    graph: dict | None = None
    thinking: str | None = None


class DesignAgentRequest(BaseModel):
    description: str


class ExecuteRequest(BaseModel):
    problem: str
    graph: dict
    subagent_model: str = "gpt-5.4-mini"
    # If set, run the enterprise executor instead of the reasoning executor.
    enterprise_task_id: str | None = None
    # Per-stream session id used to correlate ``tool_request`` SSE events
    # with the ``/execute/tool-result`` POSTs that fulfil them. Required
    # when the plan contains file-tool agents; ignored otherwise. The
    # CLI generates a fresh uuid4 per /execute call.
    session_id: str | None = None


class ToolResultRequest(BaseModel):
    """CLI → backend payload that resolves a pending file-tool agent."""

    session_id: str
    agent_id: str
    # The tool's stringified output (e.g. unified diff for patch,
    # line-numbered text for read_file). Forwarded verbatim into the
    # executor's context dict as the agent's output.
    content: str
    # ``ok=False`` is treated like an ``agent_error`` and propagated as
    # ``[Agent X failed: …]`` into downstream agent inputs, matching the
    # reasoning executor's error contract.
    ok: bool = True


# Pending file-tool calls awaiting a CLI POST. Keyed by
# ``f"{session_id}:{agent_id}"`` so two concurrent execute streams can
# both have pending tool calls without colliding.
_PENDING_TOOL_FUTURES: dict[str, asyncio.Future] = {}
# How long a backend executor will wait for the CLI to POST a tool
# result before giving up and marking the agent as failed. Generous
# because real edits can involve manual confirmation / large files.
TOOL_REQUEST_TIMEOUT_S = 120.0


def sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data)}


# ─────────────────────────────────────────────────────────────────────
# Google "Sign in with Google" — verifies an ID token issued by GIS
# (https://developers.google.com/identity/gsi/web/guides/overview).
# We don't store sessions on the server: the frontend caches the
# returned profile in localStorage and replays it for personalization
# (history, memory) on subsequent visits. When GOOGLE_CLIENT_ID is
# blank the auth surface is gracefully disabled — the UI shows a
# "Guest" panel with a hint that the admin hasn't configured login.
# ─────────────────────────────────────────────────────────────────────
class GoogleAuthRequest(BaseModel):
    id_token: str


def _google_client_id() -> str:
    return (os.getenv("GOOGLE_CLIENT_ID") or "").strip()


@app.get("/auth/config")
def auth_config():
    cid = _google_client_id()
    return {"google_client_id": cid or None, "enabled": bool(cid)}


@app.post("/auth/google")
async def auth_google(req: GoogleAuthRequest, request: Request):
    cid = _google_client_id()
    if not cid:
        raise HTTPException(
            status_code=503,
            detail="Google login is not configured on this server. "
                   "Ask the admin to set GOOGLE_CLIENT_ID in backend/.env.",
        )
    try:
        # google-auth is a sync library; run in a thread so we don't
        # block the event loop on the network call to Google's certs.
        from google.oauth2 import id_token as g_id_token
        from google.auth.transport import requests as g_requests
        info = await asyncio.to_thread(
            g_id_token.verify_oauth2_token,
            req.id_token,
            g_requests.Request(),
            cid,
        )
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="google-auth is not installed on the server. Run "
                   "`pip install google-auth>=2.29.0` in the backend env.",
        )
    except ValueError as e:
        # verify_oauth2_token raises ValueError on every form of invalid
        # token (bad signature, wrong audience, expired, malformed JWT).
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {e}")
    if not info.get("email_verified", True):
        raise HTTPException(status_code=401, detail="Google email is not verified.")
    profile = {
        "sub": info.get("sub"),
        "email": info.get("email"),
        "name": info.get("name") or info.get("email") or "Google user",
        "given_name": info.get("given_name"),
        "picture": info.get("picture"),
    }
    # Persist / refresh the user record in mas_refine/users.db so the
    # offline pipeline can JOIN trajectories / shares back to a stable
    # identity. Bumps login_count and last_seen on every call.
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")
    await asyncio.to_thread(users_store.upsert_user, profile, ip, ua)
    return profile


# TODO(auth-hardening): trust-the-client. Anyone who knows a ``sub``
# can fetch the corresponding user's profile + stats. Acceptable for a
# research demo (no private data); upgrade to bearer-token auth when
# private data lands. See ``users.py`` module docstring.
@app.get("/users/me")
async def get_me(sub: str):
    if not sub:
        raise HTTPException(status_code=400, detail="sub is required")
    profile = await asyncio.to_thread(users_store.get_user, sub)
    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")
    # Stats: number of shares + trajectory annotations the user has
    # accumulated. Computed lazily here so the user-store schema can
    # stay narrow.
    share_count = await asyncio.to_thread(_count_user_shares, sub)
    annotation_count = await asyncio.to_thread(
        users_store.count_trajectory_annotations, sub, TRAJECTORIES_DB,
    )
    return {
        **profile,
        "stats": {
            "shares": share_count,
            "trajectory_annotations": annotation_count,
        },
    }


# TODO(auth-hardening): trust-the-client. See note on /users/me.
@app.get("/users/me/shares")
async def list_my_shares(sub: str, limit: int = 50):
    if not sub:
        raise HTTPException(status_code=400, detail="sub is required")
    limit = max(1, min(limit, 200))
    items = await asyncio.to_thread(_list_user_shares, sub, limit)
    return {"items": items, "count": len(items)}


# TODO(auth-hardening): trust-the-client. See note on /users/me.
@app.post("/users/me/shares/{share_id}/hide")
async def hide_my_share(share_id: str, sub: str):
    """Per-user dismissal of a share from the Recents rail.

    Backend-persistent (users.db / hidden_shares.csv) so the hide
    survives browser switches and localStorage wipes — this was the
    explicit ask. The actual share JSON is untouched, so the public
    link still resolves and a future trash-bin UI can restore it
    via DELETE on the same path (see ``unhide_my_share``).
    """
    if not sub:
        raise HTTPException(status_code=400, detail="sub is required")
    if not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=400, detail="Invalid share id")
    ok = await asyncio.to_thread(users_store.hide_share, sub, share_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Could not hide share")
    return {"ok": True, "share_id": share_id}


# TODO(auth-hardening): trust-the-client. See note on /users/me.
@app.delete("/users/me/shares/{share_id}/hide")
async def unhide_my_share(share_id: str, sub: str):
    """Restore a hidden share (for the eventual trash-bin UI).
    Idempotent — unhiding a share that was never hidden is a no-op."""
    if not sub:
        raise HTTPException(status_code=400, detail="sub is required")
    if not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=400, detail="Invalid share id")
    ok = await asyncio.to_thread(users_store.unhide_share, sub, share_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Could not unhide share")
    return {"ok": True, "share_id": share_id}


@app.post("/plan")
# @limiter.limit("10/hour")
async def plan(req: PlanRequest) -> PlanResponse:
    # Enterprise mode short-circuits the reasoning planner entirely.
    if req.enterprise_task_id:
        try:
            task = get_task(req.enterprise_task_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        # Run the (LLM, slow) planner and the (gym round-trip) initial
        # snapshot in parallel so users see the sandbox state and the plan
        # arrive together rather than sequentially.
        plan_task = asyncio.create_task(enterprise_orch.plan_enterprise(
            task,
            req.enabled_tools or list(task.default_tools),
            planner_model=req.subagent_model or "gpt-5.4-mini",
            dom=req.dom or DomLevel.HIGH,
            file_tools_enabled=req.file_tools_enabled,
        ))
        snap_task = asyncio.create_task(enterprise_orch.get_initial_snapshot(task))
        (xml, graph, warning), initial_snapshot = await asyncio.gather(plan_task, snap_task)
        match = re.search(r"<thinking>(.*?)</thinking>", xml, re.DOTALL | re.IGNORECASE)
        thinking = match.group(1).strip() if match else None
        return PlanResponse(
            xml=xml, graph=graph.model_dump(), thinking=thinking,
            enterprise_task=task.to_payload(),
            initial_snapshot=initial_snapshot,
            warning=warning,
        )

    if req.dataset is not None:
        # All reasoning datasets are pinned to their trained DoM via
        # ``DATASET_META`` so the planner's training distribution matches
        # the request. MASBench is pinned to HIGH_EXTENSIVE (browsecomp),
        # AIME to LOW (math), Hotpot/BrowseComp to HIGH (hotpotqa /
        # browsecomp). Custom problems use the toggle's DoM.
        dom_level = DATASET_META[req.dataset]["dom"]
    else:
        dom_level = req.dom or DomLevel.HIGH
    xml, warning = await call_metaagent(req.problem, req.dataset, dom_level)
    match = re.search(r"<thinking>(.*?)</thinking>", xml, re.DOTALL | re.IGNORECASE)
    thinking = match.group(1).strip() if match else None
    graph = parse(xml, dom_level.value)
    return PlanResponse(xml=xml, graph=graph.model_dump(), thinking=thinking, warning=warning)


@app.post("/refine")
async def refine(req: RefineRequest) -> RefineResponse:
    dom_level = req.dom or DomLevel.HIGH

    # Enterprise-mode refinement uses a different schema (MCPAgent + tool
    # catalog + gym prompts). Short-circuits to a dedicated refiner so the
    # reasoning-mode prompt (which hard-codes CoT/SC/Debate/… agent types
    # and has no <tool_name> field) never runs against an enterprise plan.
    if req.enterprise_task_id:
        try:
            task = get_task(req.enterprise_task_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        raw = await enterprise_orch.refine_enterprise_plan(
            task=task,
            current_xml=req.current_xml,
            messages=req.messages,
            enabled_tools=req.enabled_tools or list(task.default_tools),
            dom=dom_level,
            file_tools_enabled=req.file_tools_enabled,
        )
        truncated = "<truncation_warning>" in raw
        msg_match = re.search(r"<message>(.*?)</message>", raw, re.DOTALL | re.IGNORECASE)
        message = msg_match.group(1).strip() if msg_match else raw.strip()
        if truncated:
            message += "\n\n⚠️ Response was truncated — the plan may be incomplete."
        has_plan = bool(re.search(r"<agent>\s*.*?<agent_id>\s*.+?\s*</agent_id>", raw, re.IGNORECASE | re.DOTALL))
        if not has_plan:
            return RefineResponse(message=message)
        thinking_match = re.search(r"<thinking>(.*?)</thinking>", raw, re.DOTALL | re.IGNORECASE)
        thinking = thinking_match.group(1).strip() if thinking_match else None
        try:
            graph = parse(raw, "high")
            if not graph.agents:
                return RefineResponse(message=f"{message}\n\n⚠️ Plan XML was malformed — showing previous plan. Try rephrasing.")
            return RefineResponse(message=message, xml=raw, graph=graph.model_dump(), thinking=thinking)
        except Exception as e:
            return RefineResponse(message=f"{message}\n\n⚠️ Failed to parse plan: {e}")

    custom_hint = ""
    if req.custom_agents:
        lines = []
        for c in req.custom_agents:
            name = c.get("name", "CustomAgent")
            strategy = c.get("strategy", "single")
            prompt = c.get("system_prompt", "")[:200]
            lines.append(f"- {name} (strategy: {strategy}): {prompt}")
        custom_hint = "The user has designed these custom agents available for use:\n" + "\n".join(lines)

    raw = await refine_plan(
        req.problem, req.current_xml, req.messages, custom_hint,
        file_tools_enabled=req.file_tools_enabled,
    )

    # Check for truncation
    truncated = "<truncation_warning>" in raw

    # Extract message
    msg_match = re.search(r"<message>(.*?)</message>", raw, re.DOTALL | re.IGNORECASE)
    message = msg_match.group(1).strip() if msg_match else raw.strip()
    if truncated:
        message += "\n\n⚠️ Response was truncated — the plan may be incomplete. Try requesting fewer agents."

    # Only treat this as a plan-emission if there's at least one complete <agent>...</agent> block.
    # Mere mentions of "<agent_id>" inside <message> or <thinking> prose shouldn't qualify.
    has_plan = bool(re.search(r"<agent>\s*.*?<agent_id>\s*.+?\s*</agent_id>", raw, re.IGNORECASE | re.DOTALL))
    if not has_plan:
        return RefineResponse(message=message)

    thinking_match = re.search(r"<thinking>(.*?)</thinking>", raw, re.DOTALL | re.IGNORECASE)
    thinking = thinking_match.group(1).strip() if thinking_match else None
    try:
        graph = parse(raw, dom_level.value)
        if not graph.agents:
            # Parser found <agent> blocks but couldn't extract valid agents — likely malformed/truncated XML.
            print(f"[refine] Warning: parsed 0 agents from XML that contained <agent> blocks")
            return RefineResponse(message=f"{message}\n\n⚠️ Plan XML was malformed — showing previous plan. Try rephrasing.")
        print(f"[refine] Parsed {len(graph.agents)} agents, {len(graph.edges)} edges, sink={graph.answer_agent}")
        return RefineResponse(message=message, xml=raw, graph=graph.model_dump(), thinking=thinking)
    except Exception as e:
        print(f"[refine] Parse error: {e}")
        return RefineResponse(message=f"{message}\n\n⚠️ Failed to parse plan: {e}")


@app.post("/design-agent")
async def design_agent_endpoint(req: DesignAgentRequest):
    config = await design_agent(req.description)
    return config.model_dump()


# ---------------------------------------------------------------------------
# /chat — generic chat-completion passthrough for the CLI's "code" mode.
#
# The CLI runs a Hermes/Claude-Code-style agent loop locally (so file tools
# execute on the user's machine), but we don't want to ship OpenAI/vLLM
# credentials with the CLI binary. This endpoint is a thin proxy: it
# forwards messages + tools to the same OpenAI client used by executor.py
# and returns the OpenAI ChatCompletion response shape unchanged, so the
# CLI's agent loop reads exactly like a direct OpenAI call.
#
# We deliberately do NOT log message bodies here (they may contain user
# code/file contents); only the model name + tool-call count are emitted
# to stdout. Analytics for /chat traffic is bookkept by the CLI's own
# `/analytics`-style request_id flow (TBD).
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    model: str = "gpt-5.4-mini"
    messages: list[dict]
    tools: list[dict] | None = None
    tool_choice: str | dict | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@app.post("/chat")
async def chat_completion(req: ChatRequest):
    """Forward a chat-completion request to the backend's configured LLM.

    Used by ``mas code`` so the agent loop runs client-side (tools touch
    the user's local filesystem) while credentials stay server-side.
    """
    from .executor import get_client, _supports_temperature

    client = get_client(req.model)
    kwargs: dict = {"model": req.model, "messages": req.messages}
    if req.tools:
        kwargs["tools"] = req.tools
    if req.tool_choice is not None:
        kwargs["tool_choice"] = req.tool_choice
    if req.temperature is not None and _supports_temperature(req.model):
        kwargs["temperature"] = req.temperature
    if req.max_tokens is not None:
        # OpenAI's chat completion API renamed the token-cap param to
        # ``max_completion_tokens`` for the gpt-5.x and reasoning model
        # families; the legacy ``max_tokens`` is rejected with a 400.
        # We send the new name unconditionally — older models accept
        # both spellings.
        kwargs["max_completion_tokens"] = req.max_tokens

    try:
        resp = await client.chat.completions.create(**kwargs)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"upstream LLM call failed: {e}") from e

    # ``resp`` is an openai.types.chat.ChatCompletion pydantic model; dump
    # to dict so FastAPI can serialise it without depending on the SDK
    # version's pydantic flavor.
    try:
        return resp.model_dump()
    except AttributeError:
        # Older openai-python versions
        return resp.dict()


MAX_CONCURRENT_AGENTS = 10


def _prepare_file_tool_request(agent, ctx, session_id: str | None):
    """Build the ``tool_request`` SSE payload and register the await future.

    Two-phase so the caller can ``yield sse("tool_request", payload)``
    on the wire *before* awaiting the result — otherwise the event sits
    in a coroutine closure and never reaches the CLI, which then never
    POSTs a result, which then deadlocks the stream until timeout.

    Returns ``(payload, future, error_str)``. On invalid input
    ``payload`` is ``None`` and ``error_str`` carries the message; the
    caller should emit an ``agent_error`` instead of a ``tool_request``.
    """
    if not session_id:
        return None, None, (
            "file-tool agent requires a session_id; the caller did not provide one. "
            "Re-run /execute with session_id set so the backend can dispatch tools "
            "to the CLI."
        )
    tool_name = FILE_TOOL_NAMES.get(agent.type)
    if tool_name is None:
        return None, None, f"unsupported file-tool agent type: {agent.type}"
    args = dict(agent.tool_args or {})
    # Allow the planner to reference upstream agent outputs via ${id}
    # interpolation inside string-valued tool args, mirroring the
    # ``${dep}`` substitution used in agent <agent_input>. Useful for
    # e.g. WriteFileAgent.content = "${summarize}".
    for k, v in list(args.items()):
        if isinstance(v, str):
            for dep in agent.depends_on:
                token = "${" + dep + "}"
                if token in v and dep in ctx:
                    v = v.replace(token, ctx[dep])
            args[k] = v
    key = f"{session_id}:{agent.id}"
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _PENDING_TOOL_FUTURES[key] = fut
    payload = {
        "sessionId": session_id,
        "agentId": agent.id,
        "toolName": tool_name,
        "agentName": agent.type.value,
        "args": args,
    }
    return payload, fut, None


async def _await_file_tool_result(
    session_id: str, agent_id: str, fut: asyncio.Future, tool_name: str,
):
    """Wait for the CLI's POST to fulfil ``fut`` and unwrap the result.

    Returns ``(output_str, error_str)``; one of the two is always None.
    Cleans up the pending-futures entry so a slow CLI doesn't leak
    entries on subsequent runs.
    """
    key = f"{session_id}:{agent_id}"
    try:
        try:
            result = await asyncio.wait_for(fut, timeout=TOOL_REQUEST_TIMEOUT_S)
        except asyncio.TimeoutError:
            return None, f"tool {tool_name} timed out after {TOOL_REQUEST_TIMEOUT_S:.0f}s"
        if isinstance(result, dict) and result.get("ok") is False:
            return None, str(result.get("content") or "tool reported failure")
        if isinstance(result, dict):
            return str(result.get("content") or ""), None
        return str(result), None
    finally:
        _PENDING_TOOL_FUTURES.pop(key, None)


async def run_execution(
    problem: str,
    graph_dict: dict,
    subagent_model: str = "gpt-5.4-mini",
    session_id: str | None = None,
):
    graph = Graph(**graph_dict)
    yield sse("graph", graph.model_dump())

    order = topo_sort(graph)
    agents = {a.id: a for a in graph.agents}
    ctx: dict[str, str] = {}
    remaining = set(order)
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_AGENTS)

    while remaining:
        ready = [aid for aid in remaining if all(d in ctx for d in agents[aid].depends_on)]
        if not ready:
            yield sse("error", {"message": "Cycle detected"})
            return

        # Split into LLM-backed agents (run concurrently server-side)
        # and file-tool agents (must be sequenced one-by-one because
        # each requires a round-trip to the CLI). Doing the file tools
        # first within a batch keeps the topo order honest.
        file_tool_aids = [aid for aid in ready if agents[aid].type in FILE_TOOL_AGENT_TYPES]
        llm_aids = [aid for aid in ready if agents[aid].type not in FILE_TOOL_AGENT_TYPES]

        # --- File-tool agents (sequential, CLI round-trip) ----------
        for aid in file_tool_aids:
            agent = agents[aid]
            yield sse("agent_start", {"agentId": aid})
            payload, fut, err = _prepare_file_tool_request(agent, ctx, session_id)
            if err is not None or payload is None or fut is None:
                ctx[aid] = f"[Agent {aid} failed: {err}]"
                yield sse("agent_error", {"agentId": aid, "error": err or "invalid file-tool agent"})
                remaining.remove(aid)
                continue
            # CRITICAL ordering: emit the SSE event FIRST (yield flushes
            # it to the wire) and only then await the CLI's POST. If we
            # awaited first the event would never reach the CLI and the
            # await would deadlock until timeout.
            yield sse("tool_request", payload)
            output, err = await _await_file_tool_result(
                session_id, aid, fut, payload["toolName"],
            )
            if err is not None:
                ctx[aid] = f"[Agent {aid} failed: {err}]"
                yield sse("agent_error", {"agentId": aid, "error": err})
            else:
                ctx[aid] = output or ""
                yield sse("agent_complete", {"agentId": aid, "output": ctx[aid]})
            remaining.remove(aid)

        # --- LLM-backed agents (run concurrently as before) ---------
        if llm_aids:
            for aid in llm_aids:
                yield sse("agent_start", {"agentId": aid})

            queue: asyncio.Queue = asyncio.Queue()

            async def run_and_enqueue(aid: str):
                async with semaphore:
                    try:
                        output = await execute_agent(
                            agents[aid], problem, ctx, subagent_model,
                            is_answer_agent=(aid == graph.answer_agent),
                        )
                        await queue.put((aid, output, None))
                    except Exception as e:
                        await queue.put((aid, None, str(e)))

            tasks = [asyncio.create_task(run_and_enqueue(aid)) for aid in llm_aids]

            for _ in range(len(llm_aids)):
                aid, output, err = await queue.get()
                if err:
                    ctx[aid] = f"[Agent {aid} failed: {err}]"
                    yield sse("agent_error", {"agentId": aid, "error": err})
                else:
                    ctx[aid] = output
                    yield sse("agent_complete", {"agentId": aid, "output": output})
                remaining.remove(aid)

            await asyncio.gather(*tasks, return_exceptions=True)

    yield sse("final_answer", {"answer": ctx.get(graph.answer_agent, "No answer")})


@app.post("/execute")
# @limiter.limit("10/hour")
async def execute(req: ExecuteRequest):
    if req.enterprise_task_id:
        try:
            task = get_task(req.enterprise_task_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        return EventSourceResponse(
            enterprise_orch.run_enterprise(
                task, req.graph, req.subagent_model, session_id=req.session_id,
            )
        )
    return EventSourceResponse(
        run_execution(req.problem, req.graph, req.subagent_model, session_id=req.session_id)
    )


@app.post("/execute/tool-result")
async def execute_tool_result(req: ToolResultRequest):
    """Fulfil a pending file-tool agent's await loop.

    The CLI receives a ``tool_request`` SSE event from /execute, runs
    the tool locally, then POSTs the result here. We look up the
    pending future by ``session_id:agent_id`` and resolve it; the
    executor coroutine then resumes inside :func:`_run_file_tool_agent`
    and forwards the result to the next agent.

    Returns 404 if no executor is waiting for this key — usually means
    the SSE stream closed (user interrupted, timeout) before the CLI
    could POST back. The CLI surfaces this as a non-fatal warning so
    the user can re-issue the task.
    """
    key = f"{req.session_id}:{req.agent_id}"
    fut = _PENDING_TOOL_FUTURES.get(key)
    if fut is None or fut.done():
        raise HTTPException(
            status_code=404,
            detail=(
                f"no pending tool call for {key} (executor may have timed out, "
                "stream was cancelled, or the result was already delivered)"
            ),
        )
    fut.set_result({"content": req.content, "ok": req.ok})
    return {"ok": True}


@app.get("/enterprise/domains")
async def enterprise_domains():
    return {"domains": list_gyms()}


@app.get("/enterprise/tasks")
async def enterprise_tasks(domain: str | None = None):
    return {"tasks": [t.to_payload() for t in list_tasks(domain)]}


@app.get("/enterprise/task-counts")
async def enterprise_task_counts():
    """Total tasks per domain — used by the picker to badge each domain tab
    without having to load the full task list for every domain up front."""
    return {"counts": task_count_by_domain()}


@app.get("/enterprise/tools")
async def enterprise_tools(domain: str):
    try:
        get_gym(domain)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"tools": await get_tool_summary(domain)}


class CustomTaskRequest(BaseModel):
    domain: str
    user_prompt: str


@app.get("/enterprise/preview-snapshot/{domain}")
async def enterprise_preview_snapshot(domain: str):
    """Snapshot the domain's sandbox without requiring a specific task —
    seeded from the first oracle task in the domain so the user sees a
    realistic environment the moment they pick a domain in the picker.
    Cached per-domain (the gym seed SQL is deterministic)."""
    try:
        get_gym(domain)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    template = next((t for t in list_tasks(domain) if t.source != "custom"), None)
    if template is None:
        raise HTTPException(status_code=404, detail=f"No oracle template task for domain {domain!r}")
    return await enterprise_orch.get_initial_snapshot(template)


@app.post("/enterprise/custom-task")
async def enterprise_custom_task(req: CustomTaskRequest):
    """Register a user-typed query as an ephemeral in-process EnterpriseTask
    and return it. The frontend uses the returned id with the same
    /plan, /refine, /execute, /verify, /enterprise/snapshot endpoints as
    any oracle task — all of those already look the id up via
    ``get_task`` which is aware of the custom-task registry.

    Default tools = the full live MCP catalog for the domain (so the
    planner has the broadest possible menu, since the user didn't pick
    tools manually)."""
    try:
        # Fall back gracefully if the MCP catalog is unreachable —
        # register_custom_task will fill default_tools from the union of
        # oracle tasks in that case.
        all_tools: list[str] | None
        try:
            all_tools = [t["name"] for t in await get_tool_summary(req.domain)]
        except Exception:
            all_tools = None
        task = register_custom_task(req.domain, req.user_prompt, all_tools=all_tools)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return task.to_payload()


class EnterpriseVerifyRequest(BaseModel):
    task_id: str


@app.post("/enterprise/verify")
async def enterprise_verify(req: EnterpriseVerifyRequest):
    """Run the task's oracle verifiers against the post-run sandbox state.

    The frontend exposes this as an opt-in "Run verifier" button under the
    final answer of an enterprise run, so the user can independently check
    whether the orchestration actually moved the world into the expected
    state (the verifiers are the same SQL ground-truth assertions the gym
    benchmark itself uses).
    """
    try:
        task = get_task(req.task_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        results = await enterprise_orch.run_verifiers(task)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    passed = sum(1 for r in results if r.get("passed"))
    return {
        "task_id": task.id,
        "total": len(results),
        "passed": passed,
        "results": results,
    }


@app.get("/enterprise/snapshot/{task_id}")
async def enterprise_snapshot(task_id: str):
    """Return the cached initial sandbox snapshot for a task.

    Used by the EnterprisePicker so the 5th column can render the live
    sandbox state as soon as the user *selects* a task — before they even
    design a plan. Backed by the same per-task cache that ``/plan`` uses,
    so subsequent fetches are instant.
    """
    try:
        task = get_task(task_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return await enterprise_orch.get_initial_snapshot(task)


@app.get("/dataset/{name}")
async def dataset_endpoint(
    name: str,
    page: int = 0,
    page_size: int = 10,
    axis: str | None = None,
    complexity: str | None = None,
):
    """Page through a reasoning dataset, optionally filtered by facets.

    ``axis`` and ``complexity`` are MASBench-only knobs (axis = reasoning
    family — breadth / combine / depth / horizon / parallel / robustness;
    complexity = the per-row ``value`` bucket, e.g. depth=10 vs depth=12).
    Each response also includes the full list of available facet values
    for the dataset so the picker can populate its selectors without a
    separate round-trip. Older datasets (AIME/HotpotQA/BrowseComp) that
    don't carry per-row metadata simply return empty facet lists and
    ignore the filters.
    """
    samples = await asyncio.to_thread(get_samples, name)

    # Build facet menus from the *unfiltered* sample set so toggling the
    # axis selector doesn't make the complexity selector's options
    # disappear when no rows of that axis exist yet in the current page.
    axes: list[str] = sorted({str(s.get("axis", "")).strip() for s in samples if s.get("axis")})
    complexities_by_axis: dict[str, list[str]] = {}
    for s in samples:
        ax = str(s.get("axis", "")).strip()
        cx = str(s.get("complexity", "")).strip()
        if not ax or not cx:
            continue
        complexities_by_axis.setdefault(ax, [])
        if cx not in complexities_by_axis[ax]:
            complexities_by_axis[ax].append(cx)
    # Sort each axis's complexity list numerically when possible so
    # "2" < "10" reads naturally instead of "10" < "2".
    def _sort_key(v: str):
        try:
            return (0, float(v))
        except ValueError:
            return (1, v)
    for ax in complexities_by_axis:
        complexities_by_axis[ax].sort(key=_sort_key)

    filtered = samples
    ax_norm = (axis or "").strip().lower()
    cx_norm = (complexity or "").strip()
    if ax_norm:
        filtered = [s for s in filtered if str(s.get("axis", "")).strip().lower() == ax_norm]
    if cx_norm:
        filtered = [s for s in filtered if str(s.get("complexity", "")).strip() == cx_norm]

    total = len(filtered)
    start = page * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "samples": filtered[start: start + page_size],
        "axes": axes,
        "complexities_by_axis": complexities_by_axis,
    }


SHARES_DIR = Path(__file__).parent.parent / "data" / "shares"
SHARES_DIR.mkdir(parents=True, exist_ok=True)
# Bound a single share payload to keep the file store sane (~2 MB JSON).
MAX_SHARE_BYTES = 2 * 1024 * 1024
# A loose upper bound on stored shares to avoid unbounded growth on the demo box.
MAX_SHARES_ON_DISK = 10_000
# Allowed share-id alphabet for path safety.
_SHARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


def _new_share_id() -> str:
    # 10 chars of url-safe base64 ≈ 60 bits, plenty for non-secret share IDs.
    return secrets.token_urlsafe(8)[:10]


class ShareRequest(BaseModel):
    """A self-contained snapshot of a conversation that can be replayed read-only."""

    # Optional client-supplied share id. When present (and well-formed)
    # the backend UPSERTS the share JSON at <id>.json instead of allocating
    # a fresh id. This is what powers the auto-save / Recents flow on the
    # left sidebar: every conversation has one stable id that the client
    # rewrites on each meaningful turn. Omitted on the classic "Share"
    # button path (no id => fresh id => fresh public link).
    id: str | None = None
    problem: str
    dataset: str | None = None
    dom: str | None = None
    subagent_model: str | None = None
    expected_answer: str | None = None
    plan: dict | None = None
    graph: dict | None = None
    agent_states: dict = Field(default_factory=dict)
    final_answer: str | None = None
    chat_messages: list[dict] = Field(default_factory=list)
    custom_agents: list[dict] = Field(default_factory=list)
    subagent_configs: dict = Field(default_factory=dict)
    title: str | None = None
    # Enterprise-mode replay payload. Stored verbatim and round-tripped to
    # the frontend so the read-only view can paint the 5th column (sandbox
    # graph + per-step diffs + activity ribbon) without needing live MCP
    # access. ``None`` / missing for reasoning-mode shares.
    mode: str | None = None  # "reasoning" | "enterprise"
    enterprise_task_id: str | None = None
    enterprise_task: dict | None = None
    enabled_tools: list[str] = Field(default_factory=list)
    sandbox_snapshot: dict | None = None
    sandbox_diffs: list[dict] = Field(default_factory=list)
    # The signed-in user who created this share. ``None`` for guest
    # shares. Stored verbatim in the share JSON so /users/me/shares
    # can list a user's history without a separate index.
    user_sub: str | None = None


class ShareResponse(BaseModel):
    id: str
    url: str
    created_at: float


def _public_base_url(req: Request) -> str:
    """Resolve the externally-reachable base URL for share links.

    Priority:
      1. PUBLIC_BASE_URL env var (e.g. the cloudflared / ngrok hostname).
      2. X-Forwarded-Host + X-Forwarded-Proto (set by reverse proxies/tunnels).
      3. The Origin/Referer header from the browser request.
      4. The raw request URL (likely localhost — last resort).
    """
    env_url = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if env_url:
        return env_url

    fwd_host = req.headers.get("x-forwarded-host")
    if fwd_host:
        proto = req.headers.get("x-forwarded-proto", "https").split(",")[0].strip()
        return f"{proto}://{fwd_host.split(',')[0].strip()}"

    origin = req.headers.get("origin")
    if origin:
        return origin.rstrip("/")

    referer = req.headers.get("referer")
    if referer:
        # Strip path/query — keep scheme+host[:port]
        m = re.match(r"^(https?://[^/]+)", referer)
        if m:
            return m.group(1)

    return f"{req.url.scheme}://{req.url.netloc}"


@app.post("/share")
async def create_share(req: ShareRequest, request: Request) -> ShareResponse:
    payload = req.model_dump()
    # Don't echo the client-supplied id back into the stored payload — the
    # filename already encodes it and storing it twice invites drift.
    client_id = payload.pop("id", None)

    # Upsert path: client supplied a stable id (auto-save / Recents flow).
    # We preserve the original ``created_at`` so the Recents rail stays
    # stable on the timeline rather than jumping to "just now" on every
    # auto-save tick. New auto-saves still get a fresh timestamp.
    upsert_path: Path | None = None
    is_update = False
    if client_id:
        if not _SHARE_ID_RE.match(client_id):
            raise HTTPException(status_code=400, detail="Invalid share id")
        upsert_path = SHARES_DIR / f"{client_id}.json"
        if upsert_path.exists():
            is_update = True
            try:
                existing = json.loads(upsert_path.read_text(encoding="utf-8"))
                prior_ts = float(existing.get("created_at") or 0.0)
                if prior_ts > 0:
                    payload["created_at"] = prior_ts
                else:
                    payload["created_at"] = time.time()
            except (OSError, json.JSONDecodeError):
                payload["created_at"] = time.time()
        else:
            payload["created_at"] = time.time()
    else:
        payload["created_at"] = time.time()

    encoded = json.dumps(payload, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_SHARE_BYTES:
        raise HTTPException(status_code=413, detail="Share payload too large")

    # Best-effort cap on total shares; on demo box we just refuse new writes if exceeded.
    # Don't apply to in-place updates — we'd otherwise strand the user's
    # ongoing auto-save when the cap is hit, which is worse than the cap.
    if not is_update:
        try:
            existing_count = sum(1 for _ in SHARES_DIR.glob("*.json"))
            if existing_count >= MAX_SHARES_ON_DISK:
                raise HTTPException(status_code=507, detail="Share storage full; please try again later")
        except OSError:
            pass

    base = _public_base_url(request)

    # Upsert: just write to the client-supplied path and return.
    if upsert_path is not None:
        upsert_path.write_text(encoded, encoding="utf-8")
        return ShareResponse(
            id=client_id,  # type: ignore[arg-type]
            url=f"{base}/?share={client_id}",
            created_at=payload["created_at"],
        )

    # Generate an unused id (collision is astronomically unlikely but be safe).
    for _ in range(5):
        sid = _new_share_id()
        path = SHARES_DIR / f"{sid}.json"
        if not path.exists():
            path.write_text(encoded, encoding="utf-8")
            return ShareResponse(id=sid, url=f"{base}/?share={sid}", created_at=payload["created_at"])
    raise HTTPException(status_code=500, detail="Could not allocate share id")


def _count_user_shares(sub: str) -> int:
    """Best-effort scan of the shares directory counting files whose
    JSON payload has ``user_sub == sub``. Cheap until we cross ~10k
    shares (our hard cap); upgrade to an index file if traffic grows.
    """
    count = 0
    try:
        for path in SHARES_DIR.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if data.get("user_sub") == sub:
                count += 1
    except OSError:
        return 0
    return count


def _list_user_shares(sub: str, limit: int) -> list[dict]:
    """Return the user's shares sorted newest-first.

    We pull a compact summary (id, created_at, title, mode, problem
    snippet, agent_count, final_answer_snippet) so the sidebar can
    render a clickable history list without downloading every full
    payload. Clicking an item then loads via ``GET /share/{id}``.

    Hidden shares (per-user, tracked in users.db / hidden_shares.csv)
    are filtered out server-side so a hide survives browser switches
    and localStorage wipes.
    """
    hidden = users_store.list_hidden_shares(sub)
    items: list[dict] = []
    try:
        for path in SHARES_DIR.glob("*.json"):
            sid = path.stem
            if sid in hidden:
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if data.get("user_sub") != sub:
                continue
            problem = (data.get("problem") or "").strip()
            answer = (data.get("final_answer") or "").strip()
            graph = data.get("graph") or {}
            agents = graph.get("agents") or []
            items.append({
                "id": sid,
                "created_at": float(data.get("created_at") or 0.0),
                "title": (data.get("title") or "").strip() or None,
                "mode": data.get("mode") or ("enterprise" if data.get("enterprise_task_id") else "reasoning"),
                "dataset": data.get("dataset"),
                "enterprise_task_id": data.get("enterprise_task_id"),
                "enterprise_domain": (data.get("enterprise_task") or {}).get("domain"),
                "problem_snippet": problem[:200],
                "answer_snippet": answer[:200],
                "agent_count": len(agents),
            })
    except OSError:
        return []
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return items[:limit]


@app.get("/share/{share_id}")
async def get_share(share_id: str) -> dict:
    if not _SHARE_ID_RE.match(share_id):
        raise HTTPException(status_code=400, detail="Invalid share id")
    path = SHARES_DIR / f"{share_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Share not found")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to load share: {e}") from e


@app.get("/health")
async def health():
    return {"status": "ok"}


# ─────────────────────────────────────────── feedback (contact us)

# Always persist user feedback to disk so nothing is lost even when SMTP
# isn't configured. The dev team can collect these out-of-band.
FEEDBACK_DIR = Path(__file__).parent.parent / "data" / "feedback"
FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)

# Where to deliver feedback. Comma-separated list of recipients,
# overridable via the ``CONTACT_TO_EMAIL`` env var.
CONTACT_TO_EMAIL = os.environ.get(
    "CONTACT_TO_EMAIL", "zixuan.ke@salesforce.com,rychin@mit.edu",
)
# Pre-parsed list used as the SMTP RCPT TO envelope. Stripped + deduped.
CONTACT_TO_RECIPIENTS: list[str] = [
    a.strip() for a in CONTACT_TO_EMAIL.split(",") if a.strip()
]


class FeedbackRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=20_000)
    # Optional — lets the dev team reply if the user wants a response.
    user_email: str | None = Field(default=None, max_length=320)
    # Optional UX context (which page / mode the user was on).
    context: dict | None = None
    # The signed-in user (Google ``sub``) if one was logged in when
    # the feedback was submitted. Lets the dev team triage feedback
    # by user without forcing them to re-enter their email.
    user_sub: str | None = Field(default=None, max_length=64)


def _send_feedback_email(payload: FeedbackRequest) -> tuple[bool, str]:
    """Attempt to deliver the feedback by SMTP.

    Returns ``(sent, detail)``. If the host has no SMTP config we skip
    cleanly with ``sent=False`` and a helpful detail string — the
    frontend will then ask the user to email the dev team directly.

    Env vars expected:
      * ``SMTP_HOST``  — required to attempt delivery
      * ``SMTP_PORT``  — default 587
      * ``SMTP_USER``  — login
      * ``SMTP_PASS``  — login password / app password
      * ``SMTP_FROM``  — From: header (falls back to ``SMTP_USER``)
      * ``SMTP_STARTTLS`` — "0" to disable STARTTLS, default on
    """
    host = os.environ.get("SMTP_HOST")
    if not host:
        return False, "SMTP not configured on this server."
    import smtplib
    from email.message import EmailMessage
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    sender = os.environ.get("SMTP_FROM") or user or "mas-orchestra@localhost"
    starttls = os.environ.get("SMTP_STARTTLS", "1") != "0"

    msg = EmailMessage()
    msg["Subject"] = "[MAS-Orchestra] User feedback from the demo"
    msg["From"] = sender
    # ``msg["To"]`` is for the visible header; the actual envelope
    # recipients are passed to ``send_message`` below so each address
    # on the comma-separated list actually receives a copy.
    msg["To"] = ", ".join(CONTACT_TO_RECIPIENTS) or CONTACT_TO_EMAIL
    if payload.user_email:
        msg["Reply-To"] = payload.user_email
    body_lines = [
        "A user submitted feedback from the MAS-Orchestra demo.",
        "",
        f"From: {payload.user_email or '(anonymous)'}",
    ]
    if payload.context:
        body_lines.append(f"Context: {json.dumps(payload.context, default=str)[:500]}")
    body_lines += ["", "Message:", payload.message]
    msg.set_content("\n".join(body_lines))

    try:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            if starttls:
                smtp.starttls()
            if user and password:
                smtp.login(user, password)
            smtp.send_message(msg, to_addrs=CONTACT_TO_RECIPIENTS or [CONTACT_TO_EMAIL])
        return True, "Email delivered."
    except Exception as e:
        return False, f"SMTP send failed: {type(e).__name__}: {e}"


@app.post("/feedback")
async def submit_feedback(req: FeedbackRequest):
    """Receive a contact-us message from the demo, try to email it to
    the dev team, and always persist it on disk as a backstop."""
    # Persist FIRST so the message survives even if SMTP times out.
    stamp = time.strftime("%Y%m%dT%H%M%S")
    record = {
        "ts": stamp,
        "to": CONTACT_TO_EMAIL,
        "user_email": req.user_email,
        "user_sub": req.user_sub,
        "message": req.message,
        "context": req.context,
    }
    out_path = FEEDBACK_DIR / f"{stamp}_{secrets.token_hex(3)}.json"
    try:
        out_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    except OSError:
        # Disk full / permission denied — keep going so we can still
        # try to send the email; failure is reported only if BOTH fail.
        pass

    sent, detail = await asyncio.get_event_loop().run_in_executor(
        None, _send_feedback_email, req
    )
    if sent:
        return {"sent": True, "to": CONTACT_TO_EMAIL, "detail": detail}
    # We deliberately return 200 with ``sent=False`` so the frontend can
    # display a friendly "please email us directly" fallback instead of
    # a generic error page.
    return {"sent": False, "to": CONTACT_TO_EMAIL, "detail": detail}


# ─────────────────────────────────────── trajectory annotation (thumbs up/down)
#
# Lives in /export/xgen-finance/meta_agent/mas_refine so the future
# training/refinement pipeline can pick it up alongside the existing
# analytics.csv / analytics.db that the vLLM tunnel writes.
#
# Two storage backends written in lock-step so a corrupted SQLite file
# never costs us annotated data:
#   * trajectories.csv — append-only flat log (one row per annotation).
#     ``conversation_history_json`` holds the full untruncated chat.
#   * trajectories.db  — same data, normalized into a single ``trajectories``
#     table for analytical queries.
import csv
import sqlite3

MAS_REFINE_DIR = Path("/export/xgen-finance/meta_agent/mas_refine")
TRAJECTORIES_CSV = MAS_REFINE_DIR / "trajectories.csv"
TRAJECTORIES_DB = MAS_REFINE_DIR / "trajectories.db"

_TRAJ_CSV_HEADER = [
    "time",
    "trajectory_id",
    "turn_index",          # index of the annotated assistant turn within conversation_history
    "turn_kind",           # "plan" | "answer" | "warning" | "verifier" | "other"
    "rating",              # "up" | "down"
    "comment",             # optional free-form text from the user
    "mode",                # "custom" | "math" | "browsecomp" | "enterprise" | …
    "dom",                 # "low" | "high" | "high_extensive"
    "subagent_model",      # selected LLM
    "enterprise_task_id",
    "enterprise_domain",
    "problem",
    "answer",              # the assistant content the user thumbed-rated
    "agent_count",
    "verifier_total",
    "verifier_passed",
    "conversation_history_json",  # FULL chat history, never truncated
    "configs_json",        # all configs (subagentConfigs, customAgents, enabledTools, …)
    "ip",
    "user_agent",
    "user_sub",            # Google ``sub`` for the signed-in user, "" for guest
    "user_email",          # cached at write-time so analytics doesn't need to JOIN users.db
    "user_name",
]


def _ensure_trajectory_stores() -> None:
    """Create the CSV (with header) and DB schema on first write.
    Cheap to call repeatedly — the on-disk check + CREATE IF NOT EXISTS
    are no-ops on the hot path."""
    MAS_REFINE_DIR.mkdir(parents=True, exist_ok=True)
    if not TRAJECTORIES_CSV.exists():
        with TRAJECTORIES_CSV.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(_TRAJ_CSV_HEADER)
    else:
        # The CSV schema may have evolved (e.g. new ``turn_kind`` column
        # added). If the on-disk header doesn't match the current
        # ``_TRAJ_CSV_HEADER`` we rotate the old file to a timestamped
        # backup and write a fresh header — DB stays the source of
        # truth for already-collected data, and the CSV stays
        # column-aligned for future writes / spreadsheet importers.
        try:
            with TRAJECTORIES_CSV.open("r", newline="", encoding="utf-8") as f:
                existing = next(csv.reader(f), [])
        except (OSError, StopIteration):
            existing = []
        if existing != _TRAJ_CSV_HEADER:
            backup = TRAJECTORIES_CSV.with_suffix(
                f".legacy-{time.strftime('%Y%m%dT%H%M%S')}.csv"
            )
            try:
                TRAJECTORIES_CSV.rename(backup)
            except OSError:
                pass
            with TRAJECTORIES_CSV.open("w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(_TRAJ_CSV_HEADER)
    conn = sqlite3.connect(TRAJECTORIES_DB)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS trajectories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT NOT NULL,
                trajectory_id TEXT NOT NULL,
                turn_index INTEGER,
                turn_kind TEXT,
                rating TEXT NOT NULL,
                comment TEXT,
                mode TEXT,
                dom TEXT,
                subagent_model TEXT,
                enterprise_task_id TEXT,
                enterprise_domain TEXT,
                problem TEXT,
                answer TEXT,
                agent_count INTEGER,
                verifier_total INTEGER,
                verifier_passed INTEGER,
                conversation_history_json TEXT NOT NULL,
                configs_json TEXT NOT NULL,
                ip TEXT,
                user_agent TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_trajectories_traj_id "
            "ON trajectories(trajectory_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_trajectories_rating "
            "ON trajectories(rating)"
        )
        # Forward-compatible columns. Wrapped in try/except so they're
        # idempotent on freshly-created tables (where they already
        # exist) and on long-lived tables (where they don't yet).
        for stmt in (
            "ALTER TABLE trajectories ADD COLUMN turn_kind TEXT",
            "ALTER TABLE trajectories ADD COLUMN user_sub TEXT",
            "ALTER TABLE trajectories ADD COLUMN user_email TEXT",
            "ALTER TABLE trajectories ADD COLUMN user_name TEXT",
        ):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        # Index on user_sub so /users/me/stats and history queries are
        # fast even after the table grows.
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_trajectories_user_sub "
                "ON trajectories(user_sub)"
            )
        except sqlite3.OperationalError:
            pass
        conn.commit()
    finally:
        conn.close()


class TrajectoryAnnotation(BaseModel):
    """One thumbs-up/down on a single assistant turn in a conversation.

    The frontend MUST send the entire ``conversation_history`` (every
    turn, untruncated) and the configs that produced it — the pipeline
    in ``mas_refine`` will use these as training data and we cannot
    reconstruct lost turns later. ``answer`` and ``turn_index`` pin
    which turn the rating refers to.
    """
    trajectory_id: str = Field(..., min_length=1, max_length=128)
    turn_index: int = Field(..., ge=0)
    # Coarse classification of which kind of assistant turn was rated.
    # Lets the offline pipeline filter "plan ratings" vs "answer ratings"
    # without having to re-derive it from ``conversation_history``.
    turn_kind: str | None = Field(default=None, max_length=32)
    rating: str = Field(..., pattern="^(up|down)$")
    comment: str | None = Field(default=None, max_length=20_000)

    mode: str | None = None
    dom: str | None = None
    subagent_model: str | None = None
    enterprise_task_id: str | None = None
    enterprise_domain: str | None = None
    problem: str | None = None
    answer: str | None = None
    agent_count: int | None = None
    verifier_total: int | None = None
    verifier_passed: int | None = None

    conversation_history: list[dict] = Field(default_factory=list)
    configs: dict = Field(default_factory=dict)

    # Identity of the signed-in user who submitted the rating, if any.
    # ``user_sub`` is the Google ``sub`` (stable across email changes);
    # the cached ``email`` / ``name`` are persisted into the row so
    # the analytics pipeline doesn't need to JOIN ``users.db`` for
    # every query.
    user_sub: str | None = Field(default=None, max_length=64)
    user_email: str | None = Field(default=None, max_length=320)
    user_name: str | None = Field(default=None, max_length=200)


def _write_trajectory_row(row: list, conn_row: tuple) -> None:
    """Synchronous fan-out to CSV + SQLite. Runs in an executor."""
    _ensure_trajectory_stores()
    with TRAJECTORIES_CSV.open("a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(row)
    conn = sqlite3.connect(TRAJECTORIES_DB)
    try:
        conn.execute(
            """
            INSERT INTO trajectories (
                time, trajectory_id, turn_index, turn_kind, rating, comment,
                mode, dom, subagent_model, enterprise_task_id, enterprise_domain,
                problem, answer, agent_count, verifier_total, verifier_passed,
                conversation_history_json, configs_json, ip, user_agent,
                user_sub, user_email, user_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            conn_row,
        )
        conn.commit()
    finally:
        conn.close()


@app.post("/feedback/trajectory")
async def save_trajectory_annotation(req: TrajectoryAnnotation, request: Request):
    """Persist a thumbs-up/down annotation on an assistant turn together
    with the FULL trajectory and the configs that produced it.

    Stored in ``mas_refine/trajectories.{csv,db}`` so the offline
    refinement pipeline can consume both formats. The conversation
    history is never truncated — downstream training/eval needs it
    intact.
    """
    if not req.conversation_history:
        raise HTTPException(status_code=400, detail="conversation_history is required")
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z") or time.strftime("%Y-%m-%dT%H:%M:%S")
    ip = request.client.host if request.client else ""
    user_agent = request.headers.get("user-agent", "")
    history_json = json.dumps(req.conversation_history, ensure_ascii=False)
    configs_json = json.dumps(req.configs, ensure_ascii=False, default=str)
    # Resolve cached user fields from users.db when the client only
    # sent ``user_sub`` (the common case — the frontend has the sub in
    # localStorage but not always the freshest email/name from Google).
    cached_email = req.user_email
    cached_name = req.user_name
    if req.user_sub and (not cached_email or not cached_name):
        try:
            stored = await asyncio.to_thread(users_store.get_user, req.user_sub)
            if stored:
                cached_email = cached_email or stored.get("email")
                cached_name = cached_name or stored.get("name")
        except Exception:
            # Never fail an annotation write because the user-store
            # lookup tripped; just persist what we have.
            pass

    csv_row = [
        ts,
        req.trajectory_id,
        req.turn_index,
        req.turn_kind or "",
        req.rating,
        req.comment or "",
        req.mode or "",
        req.dom or "",
        req.subagent_model or "",
        req.enterprise_task_id or "",
        req.enterprise_domain or "",
        req.problem or "",
        req.answer or "",
        req.agent_count if req.agent_count is not None else "",
        req.verifier_total if req.verifier_total is not None else "",
        req.verifier_passed if req.verifier_passed is not None else "",
        history_json,
        configs_json,
        ip,
        user_agent,
        req.user_sub or "",
        cached_email or "",
        cached_name or "",
    ]
    db_row = (
        ts, req.trajectory_id, req.turn_index, req.turn_kind, req.rating, req.comment,
        req.mode, req.dom, req.subagent_model, req.enterprise_task_id, req.enterprise_domain,
        req.problem, req.answer, req.agent_count, req.verifier_total, req.verifier_passed,
        history_json, configs_json, ip, user_agent,
        req.user_sub, cached_email, cached_name,
    )
    try:
        await asyncio.get_event_loop().run_in_executor(
            None, _write_trajectory_row, csv_row, db_row,
        )
    except Exception as e:
        # Don't lose data on a disk error — surface it so the frontend
        # can show a clear failure (and a retry-friendly toast).
        raise HTTPException(status_code=500, detail=f"Failed to persist: {e}") from e
    return {"ok": True, "trajectory_id": req.trajectory_id, "csv": str(TRAJECTORIES_CSV)}
