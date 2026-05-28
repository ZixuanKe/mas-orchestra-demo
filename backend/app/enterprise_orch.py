"""Enterprise-mode orchestrator: plan + execute.

Plan
----
``plan_enterprise(task, tools, dom)`` asks an LLM to emit an XML DAG of
``MCPAgent`` nodes (one per intended tool call) ending in an
``EnterpriseExecutorAgent`` sink that summarizes for the user. We reuse the
existing parser; the only new fields we ask for are ``<agent_type>`` and
``<tool_name>``.

The ``dom`` parameter controls plan complexity:
  * low        — minimal plan: do only the mutations strictly required,
                 skip optional verification/reads. ≤ 3 agents.
  * high       — balanced plan: include a read or two when they meaningfully
                 ground a later mutation. 3–6 agents.
  * extensive  — thorough plan: bracket every mutation with reads (pre-check
                 + post-verify) and run independent branches in parallel
                 when possible. 5–10 agents.

Execute
-------
``run_enterprise(task, graph, model)`` is an async generator yielding SSE
events. For each MCPAgent in topological order it:

  1. Builds a single-tool OpenAI function-calling request with the task,
     upstream context, and the one tool's MCP schema.
  2. Forwards the model's chosen arguments to the gym via MCPClient.
  3. Snapshots the post-call DB and emits ``sandbox_diff`` against the
     previous snapshot.

The final ``EnterpriseExecutorAgent`` is a plain LLM call that summarizes
the trajectory for the user. We never let the executor agent itself call
tools.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, AsyncIterator

from .enterprise import sandbox as sbx
from .enterprise.gym_config import get_gym
from .enterprise.mcp_client import MCPClient
from .enterprise.tasks import EnterpriseTask
from .enterprise.tool_catalog import (
    get_catalog,
    get_openai_tools,
    get_tool_summary,
    lookup,
)
from .executor import _is_reasoning_model, _supports_temperature, get_client
from .metaagent import get_vllm_client
from .models import Agent, AgentType, DomLevel, Graph, FILE_TOOL_AGENT_TYPES, FILE_TOOL_NAMES
from .parser import parse, topo_sort

logger = logging.getLogger(__name__)


# Which LLM backend produces the initial enterprise plan. Defaults to vLLM
# so enterprise calls show up in the same /analytics page as reasoning
# (the vLLM proxy in mas_refine/ngrok_tunnel.py logs every chat-completion
# request to analytics.csv). Set ENTERPRISE_PLANNER=openai to fall back to
# the OpenAI ``planner_model`` path (e.g. gpt-5.4-mini) for one-off testing.
_ENTERPRISE_PLANNER_BACKEND = os.getenv("ENTERPRISE_PLANNER", "vllm").lower()

# Same complexity-aware mapping the reasoning planner uses
# (``metaagent.DEFAULT_CUSTOM_MODEL``). Routes the planner request to one of
# the fine-tuned vLLM models hosted on the local proxy.
_VLLM_PLANNER_BY_DOM: dict[DomLevel, str] = {
    DomLevel.LOW: "math",
    DomLevel.HIGH: "hotpotqa",
    DomLevel.HIGH_EXTENSIVE: "browsecomp",
}


def _chat_kwargs(model: str, max_out: int = 1024) -> dict:
    """Match the project's existing convention: gpt-5 family uses
    ``max_completion_tokens``; reasoning models drop ``temperature``."""
    kw: dict[str, Any] = {
        "model": model,
        "max_completion_tokens": 16000 if _is_reasoning_model(model) else max_out,
    }
    return kw


# ───────────────────────────────────────────────────────────── planner

_PLANNER_VOCAB_CORE = """\
Vocabulary
- An MCPAgent is itself an LLM that wields exactly one MCP tool. Its job at
  execution time is to read the upstream context and decide whether/how to
  call its one tool with appropriate arguments.
- An EnterpriseExecutorAgent has no tool — it synthesizes a final natural-
  language reply from upstream MCPAgent outputs.
"""

# Only injected when the caller (CLI) sets file_tools_enabled=True. The
# webapp leaves the flag off so the planner never proposes file-tool
# agents the browser has no way to execute.
_PLANNER_VOCAB_FILE_TOOLS = """\
- Optional FILE-TOOL agents are available when the task involves reading or
  modifying files on the user's local machine. They execute on the user's
  CLI (not on the server), so use them only when the user explicitly asks
  for file work. The four types are:
    * ReadFileAgent       — reads a text file (args: path, optional offset/limit)
    * WriteFileAgent      — writes/creates a file (args: path, content)
    * PatchAgent          — find-and-replace inside a file (args: path,
                            old_string, new_string, optional replace_all)
    * SearchFilesAgent    — content/file search (args: pattern, target='content'
                            or 'files', optional path, file_glob, limit)
  File-tool agents must include a ``<tool_args>{json}</tool_args>`` block with
  the literal arguments to pass to the tool. They are NOT MCPAgents — do not
  emit ``<tool_name>`` for them. String values inside tool_args may reference
  upstream outputs via ${node_id} the same way <agent_input> does.
"""

_PLANNER_HEADER = """You are MAS-Orchestra's enterprise planner.

Given an enterprise task (a user instruction plus a system policy) and a
curated catalog of MCP tools the agent is allowed to use, you must design a
DAG of MCPAgent nodes that, executed in order, satisfies the task.

"""

_PLANNER_BODY = """\
Output rules
- Each MCPAgent wraps EXACTLY ONE tool. Reuse the same tool across nodes
  only when the task requires multiple distinct invocations.
- Each MCPAgent's <agent_input> is plain-English instructions for its single
  tool call. Do NOT pre-fill tool arguments — the per-agent LLM resolves
  them at execution time.
- Reference upstream agent outputs with ${node_id} placeholders inside the
  <agent_input> so the per-agent LLM can substitute them.
- Always end with one EnterpriseExecutorAgent (no tool).
- Keep node ids snake_case and descriptive (e.g. "create_calendar_step",
  "set_color_step", "summarize").
- Emit valid XML that matches this exact schema:

<thinking>brief reasoning</thinking>
<agents>
  <agent>
    <agent_id>create_calendar_step</agent_id>
    <agent_type>MCPAgent</agent_type>
    <tool_name>create_calendar</tool_name>
    <agent_description>Create the Helios Innovation Roadmap calendar.</agent_description>
    <agent_input>Create a new secondary calendar titled "Helios Innovation Roadmap" in America/New_York with the description "Strategy and roadmap milestones."</agent_input>
    <depends_on></depends_on>
  </agent>
  <agent>
    <agent_id>summarize</agent_id>
    <agent_type>EnterpriseExecutorAgent</agent_type>
    <agent_description>Summarize the calendar creation for the user.</agent_description>
    <agent_input>Given ${create_calendar_step}, tell the user the calendar was created and report its id and time zone.</agent_input>
    <depends_on>create_calendar_step</depends_on>
  </agent>
</agents>
<edges>
  <edge><from>create_calendar_step</from><to>summarize</to></edge>
</edges>
<answer>summarize</answer>

Constraints
- Exactly one sink node (the EnterpriseExecutorAgent).
- All non-sink nodes must be referenced from at least one downstream node's
  agent_input via ${id} (or from the EnterpriseExecutorAgent).
- No cycles. Edges must match dependencies.
"""

# Only injected when file_tools_enabled=True. Appended after the body so
# the planner has just seen the canonical MCPAgent example before the
# file-tool example, but before _DOM_GUIDANCE bounds the agent count.
_PLANNER_FILE_TOOL_EXAMPLE = """\

Example file-tool node (only emit one when the user explicitly mentions a file):

  <agent>
    <agent_id>read_readme</agent_id>
    <agent_type>ReadFileAgent</agent_type>
    <tool_args>{"path": "README.md", "limit": 200}</tool_args>
    <agent_description>Read the README so the next agent can summarize it.</agent_description>
    <agent_input>Read README.md for the user.</agent_input>
    <depends_on></depends_on>
  </agent>
"""

# Per-DoM planning style guidance, appended to the base system prompt.
_DOM_GUIDANCE: dict[DomLevel, str] = {
    DomLevel.LOW: (
        "\nComplexity profile: LOW.\n"
        "- Minimal plan. Use ONLY the tools strictly required to mutate the\n"
        "  target state. Skip optional reads / verifications.\n"
        "- Hard cap: 1 ≤ number_of_MCPAgents ≤ 3.\n"
        "- Prefer a linear chain. Don't add parallel branches.\n"
    ),
    DomLevel.HIGH: (
        "\nComplexity profile: HIGH (default).\n"
        "- Balanced plan. Include a read agent when it meaningfully grounds\n"
        "  a later mutation (e.g., look up an id before patching it).\n"
        "- 3 ≤ number_of_MCPAgents ≤ 6.\n"
        "- Run independent reads in parallel when natural.\n"
    ),
    DomLevel.HIGH_EXTENSIVE: (
        "\nComplexity profile: EXTENSIVE.\n"
        "- Thorough plan. Bracket each mutation: a read BEFORE to ground\n"
        "  arguments, then the mutation, then a read AFTER to verify it\n"
        "  landed in the gym.\n"
        "- 5 ≤ number_of_MCPAgents ≤ 10.\n"
        "- Parallelize independent branches aggressively.\n"
    ),
}


def planner_system_prompt(dom: DomLevel, file_tools_enabled: bool = False) -> str:
    parts = [_PLANNER_HEADER, _PLANNER_VOCAB_CORE]
    if file_tools_enabled:
        parts.append(_PLANNER_VOCAB_FILE_TOOLS)
    parts.append("\n" + _PLANNER_BODY)
    if file_tools_enabled:
        parts.append(_PLANNER_FILE_TOOL_EXAMPLE)
    parts.append(_DOM_GUIDANCE.get(dom, _DOM_GUIDANCE[DomLevel.HIGH]))
    return "".join(parts)


# Back-compat alias for any external import. Defaults to the no-file-tools
# variant — same behaviour as before file tools were introduced.
_PLANNER_SYSTEM_BASE = (
    _PLANNER_HEADER + _PLANNER_VOCAB_CORE + "\n" + _PLANNER_BODY
)


def _build_planner_user(task: EnterpriseTask, tools: list[dict[str, Any]]) -> str:
    tool_lines = []
    for t in tools:
        desc = (t.get("description") or "").strip().split("\n")[0][:160]
        tool_lines.append(f"- `{t['name']}`: {desc}")
    # Layout: context (gym policy, tool catalog, instructions) FIRST, then the
    # marker `Below is the question to solve:` followed by the raw task. The
    # analytics proxy (mas_refine/ngrok_tunnel.py:_extract_question) slices on
    # that marker and stores everything after it as the row's "question"
    # column — putting task.user_prompt last makes enterprise plan rows
    # legible in /analytics instead of empty.
    return (
        f"# System policy for the gym\n{task.system_prompt}\n\n"
        f"# Available tools ({len(tools)})\n" + "\n".join(tool_lines) +
        "\n\nDesign the minimal DAG that completes the task and ends with an "
        "EnterpriseExecutorAgent. Emit only the XML — no prose outside the tags."
        f"\n\nBelow is the question to solve:\n\n{task.user_prompt}"
    )


async def get_initial_snapshot(task: EnterpriseTask) -> dict:
    """Seed a fresh sandbox for ``task``, snapshot it, then dispose. Cached
    per task.id because the gym seed SQL is deterministic.

    Returned as the plain dict payload the frontend expects (already routed
    through ``Snapshot.to_payload()``).
    """
    if task.id in _SNAPSHOT_CACHE:
        return _SNAPSHOT_CACHE[task.id]
    gym = get_gym(task.domain)
    mcp = MCPClient(gym.url)
    try:
        await mcp.seed_database(task.seed_sql(), description=f"preview={task.id}")
        snap = await sbx.take_snapshot(mcp, task.domain)
        payload = {**snap.to_payload(), "phase": "preview"}
    finally:
        try:
            await mcp.delete_database()
        finally:
            await mcp.close()
    _SNAPSHOT_CACHE[task.id] = payload
    return payload


_SNAPSHOT_CACHE: dict[str, dict] = {}

# Last live ``database_id`` per task — populated by ``run_enterprise`` and
# read by ``run_verifiers`` so the user can post-hoc check whether the
# orchestration actually moved the world into the expected state. The DB is
# garbage-collected on the next execution of the same task (we delete the
# old one before seeding the new one). Worst case the gym GCs idle DBs.
_LAST_DB_PER_TASK: dict[str, str] = {}


async def _call_vllm_planner(
    system: str, user: str, dom: DomLevel,
) -> tuple[str, str]:
    """Send the enterprise planning prompt to the vLLM proxy and return
    ``(xml, model_used)``. Raises on transport/LLM error; empty content is
    returned as ``("", model_used)`` so the caller can decide to fall back.

    Routes to the same vLLM models as the reasoning planner so enterprise
    plan requests appear in the shared /analytics view automatically.
    """
    model = _VLLM_PLANNER_BY_DOM.get(dom, _VLLM_PLANNER_BY_DOM[DomLevel.HIGH])
    resp = await get_vllm_client().chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        max_tokens=4096,
    )
    return (resp.choices[0].message.content or ""), model


async def _call_openai_planner(
    system: str, user: str, model: str,
) -> str:
    """Send the enterprise planning prompt to OpenAI. Used as an opt-in
    backend via ``ENTERPRISE_PLANNER=openai`` env var. Returns the raw XML
    text (may be empty)."""
    kw = _chat_kwargs(model, max_out=2048)
    if _supports_temperature(model):
        kw["temperature"] = 0.2
    resp = await get_client(model).chat.completions.create(
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        **kw,
    )
    return resp.choices[0].message.content or ""


async def _try_planner_call(
    label: str,
    coro_factory,
    enabled_tools: list[str],
) -> tuple[str, str | None]:
    """Run a planner LLM call and validate that its output is a real
    enterprise plan (≥ 1 MCPAgent node). Returns
    ``(xml_or_empty, warning_or_none)``.

    Empty / error / unparseable / wrong-schema outputs all collapse to
    ``("", warning)`` so the caller can advance the fallback chain.

    The "wrong-schema" rejection is critical: when we ask the vLLM models
    (fine-tuned on reasoning-mode XML) for an enterprise plan, they tend
    to emit ``<agent_name>CoTAgent</agent_name>`` nodes which our parser
    happily accepts. That would silently run as a chain of plain LLM
    calls with no tool use — looking "sequential and quiet" in the UI
    with no sandbox changes and no warning. Requiring at least one
    MCPAgent forces such outputs into the next stage of the chain (where
    they get a visible warning).
    """
    try:
        xml = await coro_factory()
    except Exception as e:
        return "", f"{label} failed: {e}."
    if not (xml or "").strip():
        return "", f"{label} returned an empty response."
    try:
        graph = parse(xml, dom_level="high")
    except Exception as e:
        return "", f"{label} produced output that didn't parse: {e}."
    if not graph.agents:
        return "", f"{label} produced no agent nodes."
    mcp_count = sum(1 for a in graph.agents if a.type == AgentType.MCP_AGENT)
    if mcp_count == 0:
        # Most common cause: the fine-tuned reasoning vLLM emitted
        # CoTAgent/SCAgent XML it was trained on instead of the enterprise
        # MCPAgent schema. Don't silently accept — surface it.
        seen_types = sorted({a.type.value for a in graph.agents})
        return "", (
            f"{label} produced a plan with no MCPAgent nodes "
            f"(only saw {seen_types}). The trained planner appears to be "
            "emitting reasoning-mode XML for an enterprise task — skipping."
        )
    return xml, None


async def plan_enterprise(
    task: EnterpriseTask,
    enabled_tools: list[str],
    planner_model: str = "gpt-5.4-mini",
    dom: DomLevel = DomLevel.HIGH,
    file_tools_enabled: bool = False,
) -> tuple[str, Graph, str | None]:
    """Return ``(xml, parsed_graph, warning_or_none)``.

    Backend selection:
      * Default (``ENTERPRISE_PLANNER=vllm``): mirrors reasoning mode —
        routes to the per-DoM vLLM model on the local proxy so plan
        requests show up in the shared analytics.
      * ``ENTERPRISE_PLANNER=openai``: forces OpenAI from the start.

    Fallback chain (vLLM mode, in order):
      1. vLLM (per-DoM model). If it produces a parseable MCPAgent DAG → done.
      2. WARN the user, then try OpenAI ``planner_model`` (gpt-5.4-mini). If
         it produces a parseable DAG → done.
      3. WARN again, then use the deterministic linear one-agent-per-tool
         plan as the last resort.

    Every stage that fires emits a human-readable note that gets concatenated
    into the returned ``warning`` so the frontend can show the user exactly
    what happened: "vLLM bombed → I tried GPT instead → that's what you're
    looking at" vs. "vLLM AND GPT bombed → here's a generic linear plan".
    """
    catalog = await get_tool_summary(task.domain)
    if enabled_tools:
        wanted = set(enabled_tools)
        catalog = [t for t in catalog if t["name"] in wanted]
    system_msg = planner_system_prompt(dom, file_tools_enabled=file_tools_enabled)
    user_msg = _build_planner_user(task, catalog)

    backend = _ENTERPRISE_PLANNER_BACKEND
    warnings: list[str] = []
    xml = ""

    # ── Stage 1: primary backend (vLLM by default; OpenAI if env opt-in)
    if backend == "vllm":
        vllm_label = f"Enterprise planner (vLLM/{_VLLM_PLANNER_BY_DOM.get(dom, _VLLM_PLANNER_BY_DOM[DomLevel.HIGH])})"
        async def _vllm():
            xml_, _model = await _call_vllm_planner(system_msg, user_msg, dom)
            return xml_
        xml, w = await _try_planner_call(vllm_label, _vllm, enabled_tools)
        if w:
            warnings.append(w)
            logger.warning(w)
    else:
        # User explicitly forced openai → start there; OpenAI fallback below
        # would be a no-op so we skip stage 2 entirely if this stage succeeds.
        openai_label = f"Enterprise planner (OpenAI/{planner_model})"
        async def _openai():
            return await _call_openai_planner(system_msg, user_msg, planner_model)
        xml, w = await _try_planner_call(openai_label, _openai, enabled_tools)
        if w:
            warnings.append(w)
            logger.warning(w)

    # ── Stage 2: OpenAI fallback (only when vLLM was the primary AND failed)
    if backend == "vllm" and not xml:
        openai_label = f"OpenAI fallback ({planner_model})"
        warnings.append(f"Falling back to {openai_label}…")
        logger.info(f"vLLM planner unusable; trying {openai_label}")
        async def _openai_fb():
            return await _call_openai_planner(system_msg, user_msg, planner_model)
        xml, w = await _try_planner_call(openai_label, _openai_fb, enabled_tools)
        if w:
            warnings.append(w)
            logger.warning(w)

    # ── Stage 3: deterministic linear plan (last resort, never fails)
    if not xml:
        warnings.append(
            "Falling back to a linear one-agent-per-tool plan — the "
            "displayed agents are NOT what either trained planner would "
            "have produced."
        )
        xml = _fallback_plan(task, enabled_tools, dom)

    graph = parse(xml, dom_level="high")
    if not graph.agents:
        # Belt-and-braces: even the linear fallback should always parse, but
        # be paranoid in case _fallback_plan ever returns nothing.
        warnings.append("Linear fallback also failed to parse — empty plan.")
        return xml, graph, " ".join(warnings) if warnings else None

    warning = " ".join(warnings) if warnings else None
    return xml, graph, warning


def _fallback_plan(task: EnterpriseTask, tools: list[str], dom: DomLevel = DomLevel.HIGH) -> str:
    """Linear DAG with one MCPAgent per enabled tool + a summarizer.

    Used when the planner LLM is unreachable so the demo still works. Honors
    DoM: LOW caps the chain at 3 nodes; EXTENSIVE keeps everything.
    """
    tools = tools or list(task.default_tools)
    if dom == DomLevel.LOW:
        tools = tools[:3]
    if not tools:
        return (
            "<thinking>no tools selected</thinking>"
            "<agents><agent><agent_id>summarize</agent_id>"
            "<agent_type>EnterpriseExecutorAgent</agent_type>"
            "<agent_description>Reply to the user.</agent_description>"
            "<agent_input>Tell the user no tools were available.</agent_input>"
            "<depends_on></depends_on></agent></agents>"
            "<edges></edges><answer>summarize</answer>"
        )
    parts = [f"<thinking>fallback linear plan (dom={dom.value})</thinking>", "<agents>"]
    prev = None
    deps_for_summary = []
    for i, t in enumerate(tools, 1):
        aid = f"step_{i}_{t}"
        deps_for_summary.append(aid)
        prev_ref = f"${{{prev}}} " if prev else ""
        parts.append(
            f"<agent><agent_id>{aid}</agent_id>"
            f"<agent_type>MCPAgent</agent_type>"
            f"<tool_name>{t}</tool_name>"
            f"<agent_description>Invoke {t}.</agent_description>"
            f"<agent_input>{prev_ref}Use the {t} tool toward the task.</agent_input>"
            f"<depends_on>{prev or ''}</depends_on></agent>"
        )
        prev = aid
    summary_inputs = " ".join(f"${{{a}}}" for a in deps_for_summary)
    parts.append(
        "<agent><agent_id>summarize</agent_id>"
        "<agent_type>EnterpriseExecutorAgent</agent_type>"
        "<agent_description>Summarize the outcome for the user.</agent_description>"
        f"<agent_input>Given {summary_inputs}, tell the user what was done.</agent_input>"
        f"<depends_on>{','.join(deps_for_summary)}</depends_on></agent>"
    )
    parts.append("</agents><edges>")
    chain = deps_for_summary + ["summarize"]
    for src, dst in zip(chain, chain[1:]):
        parts.append(f"<edge><from>{src}</from><to>{dst}</to></edge>")
    parts.append("</edges><answer>summarize</answer>")
    return "".join(parts)


# ───────────────────────────────────────────────────────────── refiner

# System prompt for conversational refinement of an existing enterprise
# plan. We reuse the planner's XML schema (so the parser stays consistent)
# but wrap the LLM response in a <message>…</message> conversational tag so
# the chat UI can render the assistant's reply alongside the revised plan
# — exactly the same envelope that ``refine.py`` uses for reasoning mode.
_ENTERPRISE_REFINE_SYSTEM = """You are MAS-Orchestra's enterprise plan refiner.

You help the user iteratively revise an existing DAG of MCPAgent nodes for a
live EnterpriseOps task, through conversation.

## Behaviour
- When the user's request is clear, revise the plan and explain what you changed in 1–2 sentences.
- When the request is ambiguous, ask ONE short clarifying question (1 sentence) and do NOT emit a plan.
- Be concise.
- Preserve the parts of the plan the user did NOT ask to change.

## Response format
Always begin your reply with a <message>…</message> tag containing your conversational response.
If (and only if) you are emitting a revised plan, append the COMPLETE XML AFTER the </message> tag,
exactly matching the enterprise schema below.
If you are only asking a question or chatting, output ONLY the <message> tag — no XML.

## Vocabulary
- An MCPAgent is itself an LLM that wields exactly ONE MCP tool. Its <agent_input> is plain-English
  instructions for that one tool call. Do NOT pre-fill tool arguments.
- An EnterpriseExecutorAgent has no tool — it synthesizes the final natural-language reply from
  upstream MCPAgent outputs.

## XML schema (must match exactly)

<thinking>brief reasoning</thinking>
<agents>
  <agent>
    <agent_id>snake_case_id</agent_id>
    <agent_type>MCPAgent</agent_type>
    <tool_name>some_tool_from_the_catalog</tool_name>
    <agent_description>one-line description</agent_description>
    <agent_input>plain-English instruction for this tool call; reference upstream outputs as ${other_agent_id}</agent_input>
    <depends_on>upstream_id_1,upstream_id_2</depends_on>
  </agent>
  <agent>
    <agent_id>summarize</agent_id>
    <agent_type>EnterpriseExecutorAgent</agent_type>
    <agent_description>Summarize the result for the user.</agent_description>
    <agent_input>Given ${step_1}, ${step_2}…, tell the user what was done.</agent_input>
    <depends_on>step_1,step_2</depends_on>
  </agent>
</agents>
<edges>
  <edge><from>step_1</from><to>summarize</to></edge>
</edges>
<answer>summarize</answer>

## Constraints
- Each MCPAgent wraps EXACTLY ONE tool from the available catalog (never invent tool names).
- Exactly one sink node, an EnterpriseExecutorAgent.
- DAG only — no cycles. Every <depends_on> id must exist as an <agent_id>.
- If agent Y references ${X} in its input, X must be in Y's <depends_on>.
"""


async def refine_enterprise_plan(
    task: EnterpriseTask,
    current_xml: str,
    messages: list[dict],
    enabled_tools: list[str],
    refine_model: str = "gpt-5.1",
    dom: DomLevel = DomLevel.HIGH,
    file_tools_enabled: bool = False,
) -> str:
    """Conversational refinement of an existing enterprise plan.

    Returns the raw LLM text (a <message>…</message> tag followed optionally
    by the full revised XML). The caller (the /refine endpoint) extracts the
    message and parses the XML using the same enterprise schema as
    ``plan_enterprise``.

    Mirrors ``refine.refine_plan`` for the reasoning path, but uses the
    enterprise XML schema, injects the gym's tool catalog, and feeds the gym's
    system_prompt + user_prompt into the LLM context so the refiner stays
    grounded in what the agent is actually allowed to do.
    """
    catalog = await get_tool_summary(task.domain)
    if enabled_tools:
        wanted = set(enabled_tools)
        catalog = [t for t in catalog if t["name"] in wanted]

    tool_lines = []
    for t in catalog:
        desc = (t.get("description") or "").strip().split("\n")[0][:160]
        tool_lines.append(f"- `{t['name']}`: {desc}")

    dom_guidance = _DOM_GUIDANCE.get(dom, _DOM_GUIDANCE[DomLevel.HIGH])

    file_tools_block = _PLANNER_VOCAB_FILE_TOOLS if file_tools_enabled else ""
    system = (
        _ENTERPRISE_REFINE_SYSTEM
        + dom_guidance
        + file_tools_block
        + f"\n\n## Gym policy (informs the planner; the per-agent executor also honors it)\n{task.system_prompt}"
        + f"\n\n## Original user task\n{task.user_prompt}"
        + f"\n\n## Current plan (XML)\n{current_xml}"
        + f"\n\n## Available tools ({len(catalog)})\n" + "\n".join(tool_lines)
    )

    chat_messages: list[dict] = [{"role": "system", "content": system}]
    recent = messages[-20:] if len(messages) > 20 else messages
    for m in recent:
        chat_messages.append({"role": m["role"], "content": m["content"]})

    try:
        kw = _chat_kwargs(refine_model, max_out=4096)
        if _supports_temperature(refine_model):
            kw["temperature"] = 0.3
        resp = await get_client(refine_model).chat.completions.create(
            messages=chat_messages, **kw,
        )
        content = resp.choices[0].message.content or ""
        if resp.choices[0].finish_reason == "length":
            content += "\n<truncation_warning>Output was truncated due to length limits.</truncation_warning>"
        return content
    except Exception as e:
        logger.warning(f"enterprise refine LLM failed: {e}")
        return (
            f"<message>I couldn't reach the refinement model ({e}). "
            "The current plan is unchanged.</message>"
        )


# ───────────────────────────────────────────────────────────── executor

def _sse(event: str, data: dict) -> dict:
    return {"event": event, "data": json.dumps(data, default=str)}


# Tags an MCPAgent step's effect on the sandbox. The frontend uses this to
# render an "activity ribbon" so even read-only / no-op / errored steps get
# visible feedback — otherwise the user can't tell a successful list_events
# call from a tool that quietly failed.
_OP_WRITE = "write"     # diff produced ≥ 1 insert/update/delete
_OP_READ = "read"       # tool succeeded but DB unchanged
_OP_NOOP = "noop"       # agent declined to call its tool
_OP_ERROR = "error"     # tool / LLM error; nothing applied


# Heuristic patterns we match against MCP tool outputs to detect failures
# that the gym reports as plain text (isError=false) rather than via the
# MCP error envelope. Without this, a "Calendar with id 'primary' does not
# exist" response would be tagged READ — silencing the AppView ribbon and
# letting the executor LLM claim success on top of a failure.
_TEXT_ERROR_PATTERNS = re.compile(
    r"""(
        \b(does\s+not\s+exist
          | not\s+found
          | no\s+such
          | unable\s+to
          | failed\s+to
          | cannot\s+(?:find|locate|create|update|delete)
          | invalid\s+(?:id|argument|parameter|input|request)
          | permission\s+denied
          | unauthorized
          | forbidden
          | conflict
          | already\s+exists
          | bad\s+request
          )\b
        | ^error[:\s]
        | ^"?error"?\s*[:=]
        | \"error\"\s*:
        | \"isError\"\s*:\s*true
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def _looks_like_tool_error(output: str) -> bool:
    """True if a non-bracketed MCP text payload looks like an error.
    Probes the first ~300 chars only (errors are usually announced
    up-front) to keep this cheap even for long success payloads."""
    head = output[:300].lstrip()
    if not head:
        return False
    return bool(_TEXT_ERROR_PATTERNS.search(head))


def _classify_step(diff_events: list[dict], output: str | None) -> str:
    """Decide which of the four step kinds this MCPAgent invocation was.

    Order matters: a non-empty diff always wins (a tool can both write and
    print an error sentinel), then we look at the output for our own error
    / no-op sentinels emitted by ``_run_mcp_agent``, and finally we
    pattern-match against common natural-language failure phrases that
    some gyms emit as plain text (isError=false).
    """
    if diff_events:
        return _OP_WRITE
    text = (output or "").lstrip()
    if not text:
        return _OP_NOOP
    # ``_run_mcp_agent`` returns "[no tool call made]" when the LLM
    # explicitly refused to call the tool. Treat that as a no-op.
    if text.startswith("[no tool call made]"):
        return _OP_NOOP
    # Any of our own bracketed sentinels mean we hit an error path before
    # the tool actually wrote anything to the gym.
    if text.startswith("[") and any(
        text.startswith(p) for p in (
            "[tool ", "[LLM error", "[Unknown tool",
            "[bad JSON", "[MCPAgent ", "[ERROR",
        )
    ):
        return _OP_ERROR
    # Plain-text errors that the gym slipped through with isError=false.
    if _looks_like_tool_error(text):
        return _OP_ERROR
    return _OP_READ


# Lightweight verb stripping so the frontend's hint can read like
# "🔎 list_events → events". Order matters — longer prefixes first.
_READ_VERB_PREFIXES = (
    "list_", "get_", "search_", "find_", "fetch_", "lookup_", "describe_",
    "count_", "query_", "view_", "show_", "check_", "exists_", "has_",
)


def _guess_affected_table(tool_name: str | None, curated_tables: list[str]) -> str | None:
    """Best-effort: which curated table did this tool most likely touch?

    We only use this for read tools (writes report their tables directly via
    the diff events). Strips a leading verb and tries the remainder against
    the curated table list, with crude singular/plural variants.
    """
    if not tool_name:
        return None
    name = tool_name.lower()
    for p in _READ_VERB_PREFIXES:
        if name.startswith(p):
            name = name[len(p):]
            break
    candidates = {name, name + "s", name.rstrip("s")}
    for t in curated_tables:
        if t in candidates:
            return t
    # Substring fallback: e.g. "online_meetings" tool → "online_meetings" tbl.
    for t in curated_tables:
        if t in name or name in t:
            return t
    return None


def _resolve_input(agent_input: str, ctx: dict[str, str]) -> str:
    return re.sub(
        r"\$\{(\w+)\}",
        lambda m: (ctx.get(m.group(1)) or f"[output of {m.group(1)} unavailable]")[:1500],
        agent_input,
    )


_MCP_AGENT_SYSTEM = (
    "You are an MCPAgent inside MAS-Orchestra: an LLM that wields exactly "
    "one MCP tool, `{tool_name}`. Read the instructions, look at the "
    "upstream agent outputs in the user message, then make ONE tool call "
    "with appropriate arguments. If you truly cannot make progress, respond "
    "with a one-line explanation and DO NOT call the tool. Never call any "
    "tool other than `{tool_name}`."
)


def _compose_system(orchestra_system: str, gym_system: str | None) -> str:
    """Prepend the gym's policy prompt (role/safety/style) BEFORE the
    orchestra-level instructions so the per-agent LLM honors gym conventions
    (e.g. "execute without asking for confirmation", "verify entities exist
    before mutating"). Falls back to just the orchestra prompt if the gym
    didn't ship a system prompt.

    Enterprise-only helper — never called from reasoning-mode code paths.
    """
    gym_system = (gym_system or "").strip()
    if not gym_system:
        return orchestra_system
    return (
        "# Gym policy (must follow)\n"
        f"{gym_system}\n\n"
        "# Orchestra role for this step\n"
        f"{orchestra_system}"
    )


async def _run_mcp_agent(
    agent: Agent,
    task: EnterpriseTask,
    ctx: dict[str, str],
    mcp: MCPClient,
    model: str,
    catalog: list[dict[str, Any]],
) -> tuple[str, dict[str, Any] | None]:
    """Return (textual_output, tool_args_used_for_logging)."""
    tool_name = agent.tool_name or ""
    if not tool_name:
        return f"[MCPAgent {agent.id} missing tool_name]", None
    tool_def = lookup(catalog, tool_name)
    if not tool_def:
        return f"[Unknown tool {tool_name!r} on this gym]", None

    oa_tool = (await get_openai_tools(task.domain, [tool_name]))[0]
    resolved = _resolve_input(agent.input, ctx)
    user_msg = (
        f"# Original task\n{task.user_prompt}\n\n"
        f"# Your instruction\n{resolved}\n\n"
        "Make exactly one call to your tool with appropriate arguments."
    )

    try:
        kw = _chat_kwargs(model, max_out=1024)
        if _supports_temperature(model):
            kw["temperature"] = 0.2
        resp = await get_client(model).chat.completions.create(
            messages=[
                {"role": "system", "content": _compose_system(
                    _MCP_AGENT_SYSTEM.format(tool_name=tool_name),
                    task.system_prompt,
                )},
                {"role": "user", "content": user_msg},
            ],
            tools=[oa_tool],
            tool_choice={"type": "function", "function": {"name": tool_name}},
            **kw,
        )
    except Exception as e:
        return f"[LLM error choosing args for {tool_name}: {e}]", None

    msg = resp.choices[0].message
    if not msg.tool_calls:
        return (msg.content or "[no tool call made]"), None
    call = msg.tool_calls[0]
    try:
        args = json.loads(call.function.arguments or "{}")
    except json.JSONDecodeError:
        return f"[bad JSON arguments: {call.function.arguments[:200]}]", None

    try:
        rpc = await mcp.call_tool(tool_name, args, context=task.context)
        out = mcp.extract_tool_output(rpc)
        return out[:2000], args
    except Exception as e:
        return f"[tool {tool_name} failed: {e}]", args


_EXECUTOR_SYSTEM = (
    "You are the final EnterpriseExecutorAgent in MAS-Orchestra. You did not "
    "call any tools yourself. Read the user's original task and the outputs "
    "of the upstream MCPAgent calls, then write the final answer for the "
    "user.\n\n"
    "STRICT RULES — never violate these:\n"
    "- Treat any upstream output that starts with `[FAILED ...]`, `[ERROR ...]`, "
    "`[tool ... failed]`, `[LLM error ...]`, `[Unknown tool ...]`, `[bad JSON ...]` "
    "or that contains phrases like 'does not exist', 'not found', 'permission "
    "denied', 'invalid', 'failed to', 'unable to' as a HARD FAILURE.\n"
    "- If ANY mutation step failed (e.g. create/update/delete/patch), the task "
    "is NOT complete. Do NOT say it was 'scheduled', 'created', 'updated' or "
    "similar — instead state plainly what failed and why, citing the failing "
    "tool name and the error text verbatim in one short sentence.\n"
    "- Only claim success for actions whose upstream output is a normal "
    "non-error payload (an ID, a JSON object, a list, a confirmation, etc).\n"
    "- If a tool call says e.g. \"Calendar with id 'primary' does not exist\", "
    "the correct summary is something like: \"Could not schedule the meeting: "
    "the create_event tool reported that calendar 'primary' does not exist. "
    "Please retry with a valid calendar ID.\" — never \"The meeting was "
    "scheduled. Note that the calendar does not exist.\"\n\n"
    "Be concise: confirm what was actually done (created/updated IDs from "
    "successful steps), and clearly flag what failed. No XML, no markdown "
    "headers, just the answer."
)


async def _run_executor_agent(
    agent: Agent,
    task: EnterpriseTask,
    ctx: dict[str, str],
    model: str,
) -> str:
    resolved = _resolve_input(agent.input, ctx)
    user_msg = (
        f"# Original task\n{task.user_prompt}\n\n"
        f"# Synthesis instruction\n{resolved}"
    )
    try:
        kw = _chat_kwargs(model, max_out=800)
        if _supports_temperature(model):
            kw["temperature"] = 0.3
        resp = await get_client(model).chat.completions.create(
            messages=[
                {"role": "system", "content": _compose_system(
                    _EXECUTOR_SYSTEM, task.system_prompt,
                )},
                {"role": "user", "content": user_msg},
            ],
            **kw,
        )
        return resp.choices[0].message.content or ""
    except Exception as e:
        return f"Task completed. (Summary LLM unavailable: {e})"


async def run_enterprise(
    task: EnterpriseTask,
    graph_dict: dict,
    subagent_model: str = "gpt-5.4-mini",
    session_id: str | None = None,
) -> AsyncIterator[dict]:
    """SSE generator: yields graph → sandbox_snapshot → per-agent events →
    sandbox_diff after each tool → final_answer → done."""
    graph = Graph(**graph_dict)
    yield _sse("graph", graph.model_dump())

    gym = get_gym(task.domain)
    mcp = MCPClient(gym.url)
    catalog = await get_catalog(task.domain)
    ctx: dict[str, str] = {}

    try:
        yield _sse("status", {"phase": "seeding", "message": f"Seeding {gym.label} sandbox…"})
        # Clean up the previous live DB for this task (if any) so we don't
        # leak databases on the gym server across re-runs.
        old_db = _LAST_DB_PER_TASK.pop(task.id, None)
        if old_db:
            try:
                cleanup_mcp = MCPClient(gym.url)
                cleanup_mcp.database_id = old_db
                await cleanup_mcp.delete_database()
                await cleanup_mcp.close()
            except Exception as e:
                logger.warning(f"failed to GC previous DB {old_db}: {e}")
        await mcp.seed_database(task.seed_sql(), description=f"task={task.id}")
        # Remember this DB so /enterprise/verify can run later against it.
        _LAST_DB_PER_TASK[task.id] = mcp.database_id or ""
        snap = await sbx.take_snapshot(mcp, task.domain)
        yield _sse("sandbox_snapshot", snap.to_payload())
    except Exception as e:
        yield _sse("error", {"message": f"Failed to seed sandbox: {e}"})
        await mcp.close()
        return

    order = topo_sort(graph)
    agents_by_id = {a.id: a for a in graph.agents}
    prev_snap = snap

    try:
        for aid in order:
            agent = agents_by_id[aid]
            yield _sse("agent_start", {"agentId": aid})

            if agent.type == AgentType.MCP_AGENT:
                output, args = await _run_mcp_agent(
                    agent, task, ctx, mcp, subagent_model, catalog,
                )

                # Snapshot AFTER the tool call and emit the diff.
                try:
                    new_snap = await sbx.take_snapshot(mcp, task.domain)
                    diffs = sbx.diff(prev_snap, new_snap)
                    prev_snap = new_snap
                except Exception as e:
                    diffs = []
                    logger.warning(f"snapshot/diff failed after {aid}: {e}")

                # Classify the step kind so the frontend can render an
                # activity ribbon for read / noop / error steps (which
                # otherwise leave the panel silent and confuse the user).
                op_kind = _classify_step(diffs, output)
                # If the tool reported a natural-language failure that we
                # detected post-hoc, prepend a [FAILED] banner so the
                # executor LLM downstream cannot claim success on top of
                # it. Bracketed sentinels emitted by ``_run_mcp_agent``
                # are already self-flagged.
                ctx_output = output
                if op_kind == _OP_ERROR and not output.lstrip().startswith("["):
                    ctx_output = f"[FAILED tool {agent.tool_name}] {output}"
                ctx[aid] = ctx_output

                yield _sse("agent_complete", {
                    "agentId": aid, "output": output,
                    "tool_name": agent.tool_name,
                    "tool_args": args,
                    "op_kind": op_kind,
                })
                if op_kind == _OP_WRITE:
                    affected = sorted({ev["table"] for ev in diffs if ev.get("table")})
                else:
                    curated_tables = list(new_snap.tables.keys()) if new_snap else []
                    guess = _guess_affected_table(agent.tool_name, curated_tables)
                    affected = [guess] if guess else []
                yield _sse("sandbox_diff", {
                    "by_agent": aid, "tool_name": agent.tool_name,
                    "events": diffs,
                    "op_kind": op_kind,
                    "affected_tables": affected,
                })
                # Emit the post-tool snapshot so the UI can render any newly
                # inserted rows immediately (otherwise they'd live only in
                # the diff stream until the very end of the run, and the
                # sandbox panel — which iterates ``snapshot.tables[].rows``
                # — wouldn't show them with their NEW badge during the run).
                try:
                    yield _sse("sandbox_snapshot", new_snap.to_payload())
                except Exception:
                    pass
            elif agent.type == AgentType.ENTERPRISE_EXECUTOR:
                output = await _run_executor_agent(agent, task, ctx, subagent_model)
                ctx[aid] = output
                yield _sse("agent_complete", {"agentId": aid, "output": output})
            elif agent.type in FILE_TOOL_AGENT_TYPES:
                # File-tool agents — emit ``tool_request`` first, then
                # await the CLI POST so the event actually leaves the
                # server. See ``_prepare_file_tool_request`` docstring
                # for why this two-phase split exists.
                from .main import _prepare_file_tool_request, _await_file_tool_result

                payload, fut, err = _prepare_file_tool_request(agent, ctx, session_id)
                if err is not None or payload is None or fut is None:
                    ctx[aid] = f"[Agent {aid} failed: {err}]"
                    yield _sse("agent_error", {"agentId": aid, "error": err or "invalid file-tool agent"})
                else:
                    yield _sse("tool_request", payload)
                    output, err = await _await_file_tool_result(
                        session_id, aid, fut, payload["toolName"],
                    )
                    if err is not None:
                        ctx[aid] = f"[Agent {aid} failed: {err}]"
                        yield _sse("agent_error", {"agentId": aid, "error": err})
                    else:
                        ctx[aid] = output or ""
                        yield _sse("agent_complete", {
                            "agentId": aid, "output": ctx[aid],
                            "tool_name": FILE_TOOL_NAMES.get(agent.type),
                            "tool_args": agent.tool_args or {},
                            "op_kind": _OP_WRITE if agent.type in {AgentType.WRITE_FILE, AgentType.PATCH} else _OP_READ,
                        })
            else:
                # Fallback: treat unknown enterprise nodes as a plain LLM call.
                output = await _run_executor_agent(agent, task, ctx, subagent_model)
                ctx[aid] = output
                yield _sse("agent_complete", {"agentId": aid, "output": output})

        final = ctx.get(graph.answer_agent, "")
        yield _sse("final_answer", {"answer": final})

        # One last full snapshot for the UI's "after" state.
        try:
            final_snap = await sbx.take_snapshot(mcp, task.domain)
            yield _sse("sandbox_snapshot", {**final_snap.to_payload(), "phase": "final"})
        except Exception:
            pass
    finally:
        # NOTE: do NOT delete the database here. We keep the post-run state
        # alive so the user can re-run the verifier endpoint against it from
        # the chat. The next ``run_enterprise`` for this task will GC the
        # previous DB before seeding a fresh one (see top of the function).
        await mcp.close()


# ───────────────────────────────────────────────── verifier
async def run_verifiers(task: EnterpriseTask) -> list[dict]:
    """Run the task's oracle ``verifiers`` against the latest post-run DB.

    Each verifier is a ``{verifier_type, name, description, validation_config}``
    dict. Today we only support ``verifier_type == "database_state"`` with a
    ``validation_config = {query, expected_value, comparison_type}``. The
    query is executed via the gym's SQL runner; the first scalar of the
    result is compared against ``expected_value``.

    Returns a list of result dicts ready to send to the UI:
        {name, description, query, expected, actual, comparison, passed, error}
    """
    if not task.verifiers:
        return []
    db_id = _LAST_DB_PER_TASK.get(task.id)
    if not db_id:
        raise RuntimeError(
            "No live sandbox to verify against — run the plan first."
        )
    gym = get_gym(task.domain)
    mcp = MCPClient(gym.url)
    mcp.database_id = db_id
    results: list[dict] = []
    try:
        for v in task.verifiers:
            vc = (v.get("validation_config") or {})
            query = vc.get("query") or ""
            expected = vc.get("expected_value")
            comp = vc.get("comparison_type", "equals")
            entry: dict = {
                "name": v.get("name") or v.get("verifier_type") or "Check",
                "description": v.get("description") or "",
                "query": query,
                "expected": expected,
                "actual": None,
                "comparison": comp,
                "passed": False,
                "error": None,
            }
            try:
                rows = await mcp.sql(query)
                actual = _extract_scalar(rows)
                entry["actual"] = actual
                entry["passed"] = _compare(actual, expected, comp)
            except Exception as e:
                entry["error"] = str(e)
            results.append(entry)
    finally:
        await mcp.close()
    return results


def _extract_scalar(rows: list[dict]) -> object:
    """Pull a single scalar out of a typical verifier result.

    Verifier queries are almost always ``SELECT COUNT(*) AS count ...`` so
    we return ``rows[0]["count"]`` when it exists; otherwise the first
    value of the first row, or the row list itself if there's no clear
    scalar (we still pass it through for ``equals`` against arrays).
    """
    if not rows:
        return 0
    first = rows[0]
    if isinstance(first, dict):
        for key in ("count", "COUNT(*)", "c"):
            if key in first:
                return first[key]
        # Single-column row: return its value.
        if len(first) == 1:
            return next(iter(first.values()))
        return first
    return first


def _compare(actual: object, expected: object, comparison_type: str) -> bool:
    ct = (comparison_type or "equals").lower()
    if ct == "equals":
        try:
            if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
                return float(actual) == float(expected)
        except Exception:
            pass
        return str(actual) == str(expected)
    if ct in ("greater_than", "gt"):
        try: return float(actual) > float(expected)  # type: ignore[arg-type]
        except Exception: return False
    if ct in ("less_than", "lt"):
        try: return float(actual) < float(expected)  # type: ignore[arg-type]
        except Exception: return False
    if ct == "contains":
        try: return str(expected) in str(actual)
        except Exception: return False
    # Unknown comparison — fall back to equality.
    return str(actual) == str(expected)
