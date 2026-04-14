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

from .models import Graph, Dataset, DATASET_META
from .datasets import get_samples
from .parser import parse, topo_sort
from .metaagent import call_metaagent
from .executor import execute_agent

app = FastAPI(title="MAS-Orchestra Demo")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class PlanRequest(BaseModel):
    problem: str
    dataset: Dataset = Dataset.HOTPOT


class PlanResponse(BaseModel):
    xml: str
    graph: dict
    thinking: str | None = None


class ExecuteRequest(BaseModel):
    problem: str
    graph: dict
    subagent_model: str = "gpt-4.1-mini"


def sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data)}


@app.post("/plan")
async def plan(req: PlanRequest) -> PlanResponse:
    xml = await call_metaagent(req.problem, req.dataset)
    match = re.search(r"<thinking>(.*?)</thinking>", xml, re.DOTALL | re.IGNORECASE)
    thinking = match.group(1).strip() if match else None
    dom_level = DATASET_META[req.dataset]["dom"].value
    graph = parse(xml, dom_level)
    return PlanResponse(xml=xml, graph=graph.model_dump(), thinking=thinking)


async def run_execution(problem: str, graph_dict: dict, subagent_model: str = "gpt-4.1-mini"):
    graph = Graph(**graph_dict)
    yield sse("graph", graph.model_dump())

    order = topo_sort(graph)
    agents = {a.id: a for a in graph.agents}
    ctx: dict[str, str] = {}
    remaining = set(order)

    while remaining:
        ready = [aid for aid in remaining if all(d in ctx for d in agents[aid].depends_on)]
        if not ready:
            yield sse("error", {"message": "Cycle detected"})
            return

        for aid in ready:
            yield sse("agent_start", {"agentId": aid})

        queue: asyncio.Queue = asyncio.Queue()

        async def run_and_enqueue(aid: str):
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
