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

# limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="MAS-Orchestra")
# app.state.limiter = limiter
# app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class PlanRequest(BaseModel):
    problem: str
    dataset: Dataset | None = None
    dom: DomLevel | None = None


class PlanResponse(BaseModel):
    xml: str
    graph: dict
    thinking: str | None = None


class RefineRequest(BaseModel):
    problem: str
    current_xml: str
    messages: list[dict] = []
    dom: DomLevel | None = None
    custom_agents: list[dict] = []


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


def sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data)}


@app.post("/plan")
# @limiter.limit("10/hour")
async def plan(req: PlanRequest) -> PlanResponse:
    if req.dataset is not None:
        dom_level = DATASET_META[req.dataset]["dom"]
    else:
        dom_level = req.dom or DomLevel.HIGH
    xml = await call_metaagent(req.problem, req.dataset, dom_level)
    match = re.search(r"<thinking>(.*?)</thinking>", xml, re.DOTALL | re.IGNORECASE)
    thinking = match.group(1).strip() if match else None
    graph = parse(xml, dom_level.value)
    return PlanResponse(xml=xml, graph=graph.model_dump(), thinking=thinking)


@app.post("/refine")
async def refine(req: RefineRequest) -> RefineResponse:
    dom_level = req.dom or DomLevel.HIGH

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
    return EventSourceResponse(run_execution(req.problem, req.graph, req.subagent_model))


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
