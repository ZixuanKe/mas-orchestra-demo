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

from .models import Graph, Dataset, DATASET_META, DomLevel
from .datasets import get_samples
from .parser import parse, topo_sort
from .metaagent import call_metaagent
from .executor import execute_agent
from .refine import refine_plan
from .designer import design_agent
from .enterprise.gym_config import list_gyms, get_gym
from .enterprise.tasks import list_tasks, get_task, task_count_by_domain
from .enterprise.tool_catalog import get_tool_summary
from . import enterprise_orch

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


def sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data)}


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

    raw = await refine_plan(req.problem, req.current_xml, req.messages, custom_hint)

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


MAX_CONCURRENT_AGENTS = 10


async def run_execution(problem: str, graph_dict: dict, subagent_model: str = "gpt-5.4-mini"):
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

        for aid in ready:
            yield sse("agent_start", {"agentId": aid})

        queue: asyncio.Queue = asyncio.Queue()

        async def run_and_enqueue(aid: str):
            async with semaphore:
                try:
                    output = await execute_agent(agents[aid], problem, ctx, subagent_model, is_answer_agent=(aid == graph.answer_agent))
                    await queue.put((aid, output, None))
                except Exception as e:
                    await queue.put((aid, None, str(e)))

        tasks = [asyncio.create_task(run_and_enqueue(aid)) for aid in ready]

        for _ in range(len(ready)):
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
            enterprise_orch.run_enterprise(task, req.graph, req.subagent_model)
        )
    return EventSourceResponse(run_execution(req.problem, req.graph, req.subagent_model))


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
async def dataset_endpoint(name: str, page: int = 0, page_size: int = 10):
    samples = await asyncio.to_thread(get_samples, name)
    total = len(samples)
    start = page * page_size
    return {"total": total, "page": page, "page_size": page_size, "samples": samples[start: start + page_size]}


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
    payload["created_at"] = time.time()

    encoded = json.dumps(payload, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_SHARE_BYTES:
        raise HTTPException(status_code=413, detail="Share payload too large")

    # Best-effort cap on total shares; on demo box we just refuse new writes if exceeded.
    try:
        existing = sum(1 for _ in SHARES_DIR.glob("*.json"))
        if existing >= MAX_SHARES_ON_DISK:
            raise HTTPException(status_code=507, detail="Share storage full; please try again later")
    except OSError:
        pass

    base = _public_base_url(request)

    # Generate an unused id (collision is astronomically unlikely but be safe).
    for _ in range(5):
        sid = _new_share_id()
        path = SHARES_DIR / f"{sid}.json"
        if not path.exists():
            path.write_text(encoded, encoding="utf-8")
            return ShareResponse(id=sid, url=f"{base}/?share={sid}", created_at=payload["created_at"])
    raise HTTPException(status_code=500, detail="Could not allocate share id")


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
