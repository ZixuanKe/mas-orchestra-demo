from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

import asyncio
import json
import re
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
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
    subagent_model: str = "gpt-4.1-mini"


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


async def run_execution(problem: str, graph_dict: dict, subagent_model: str = "gpt-4.1-mini"):
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


@app.get("/health")
async def health():
    return {"status": "ok"}
