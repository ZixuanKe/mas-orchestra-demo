"""Sub-agent executors for the MAS-Orchestra demo.

Each agent type mirrors the corresponding building block in
`mas_r1_reasoner/agents/blocks_harmony/` (cot, cot_sc, llm_debate, reflexion,
web_search). Instructions are copied verbatim from the codebase.
"""

import os
import json
import re
import asyncio
from datetime import datetime
from openai import AsyncOpenAI

from .models import Agent, AgentType, CustomStrategy, CustomTool


# ---------------------------------------------------------------------------
# API clients (lazy-initialized)
# ---------------------------------------------------------------------------

_openai_client: AsyncOpenAI | None = None
_together_client: AsyncOpenAI | None = None


def _get_openai_client() -> AsyncOpenAI:
    global _openai_client
    if _openai_client is None:
        _openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _openai_client


def _get_together_client() -> AsyncOpenAI:
    global _together_client
    if _together_client is None:
        _together_client = AsyncOpenAI(
            api_key=os.getenv("TOGETHER_API_KEY"),
            base_url="https://api.together.xyz/v1",
        )
    return _together_client


def _is_together_model(model: str) -> bool:
    return "/" in model


def get_client(model: str = "") -> AsyncOpenAI:
    if _is_together_model(model):
        return _get_together_client()
    return _get_openai_client()


def _is_reasoning_model(model: str) -> bool:
    return model.startswith("o") or "DeepSeek-R1" in model


def _supports_temperature(model: str) -> bool:
    if _is_reasoning_model(model):
        return False
    if model.startswith("gpt-5.5"):
        return False
    return True


# ---------------------------------------------------------------------------
# Instructions — copied verbatim from mas_r1_reasoner/agents/blocks_harmony/
# ---------------------------------------------------------------------------

COT_INSTRUCTION = "Please think step by step and then solve the task."

DEBATE_INITIAL_INSTRUCTION = COT_INSTRUCTION
DEBATE_INSTRUCTION = (
    "Given solutions to the problem from other agents, consider their opinions as "
    "additional advice. Please think carefully and provide an updated answer. "
    "Put your thinking process in the 'thinking' field and the updated answer in the 'answer' field."
)
DEBATE_FINAL_INSTRUCTION = (
    "Given all the above thinking and answers, reason over them carefully and "
    "provide a final answer. Put your thinking process in the 'thinking' field "
    "and the final answer in the 'answer' field."
)

REFLEXION_INITIAL_INSTRUCTION = COT_INSTRUCTION
REFLEXION_REFLECT_INSTRUCTION = (
    "Given previous attempts and feedback, carefully consider where you could go "
    "wrong in your latest attempt. Using insights from previous attempts, try to "
    "solve the task better."
)
REFLEXION_CRITIC_INSTRUCTION = (
    "Please review the answer above and criticize on where might be wrong. If you "
    "are absolutely sure it is correct, output exactly 'True' in 'correct'."
)

WEBSEARCH_SYSTEM_PROMPT_TEMPLATE = """You are a research assistant conducting research on the user's input topic. For context, today's date is {date}.

<Task>
Your job is to use tools to gather information about the user's input topic.
You can use any of the tools provided to you to find resources that can help answer the research question. You can call these tools in series or in parallel, your research is conducted in a tool-calling loop.
</Task>

<Available Tools>
You have access to two main tools:
1. **web_search**: For conducting web searches to gather information
2. **think_tool**: For reflection and strategic planning during research

**CRITICAL: Use think_tool after each search to reflect on results and plan next steps. Do not call think_tool with the web_search or any other tools. It should be to reflect on the results of the search.**
</Available Tools>

<Instructions>
Think like a human researcher with limited time. Follow these steps:

1. **Read the question carefully** - What specific information does the user need?
2. **Start with broader searches** - Use broad, comprehensive queries first
3. **After each search, pause and assess** - Do I have enough to answer? What's still missing?
4. **Execute narrower searches as you gather information** - Fill in the gaps
5. **Stop when you can answer confidently** - Don't keep searching for perfection
</Instructions>

<Hard Limits>
**Tool Call Budgets** (Prevent excessive searching):
- **Simple queries**: Use 2-3 search tool calls maximum
- **Complex queries**: Use up to 5 search tool calls maximum
- **Always stop**: After 5 search tool calls if you cannot find the right sources

**Stop Immediately When**:
- You can answer the user's question comprehensively
- You have 3+ relevant examples/sources for the question
- Your last 2 searches returned similar information
</Hard Limits>

<Show Your Thinking>
After each search tool call, use think_tool to analyze the results:
- What key information did I find?
- What's missing?
- Do I have enough to answer the question comprehensively?
- Should I search more or provide my answer?
</Show Your Thinking>
"""

WEBSEARCH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "A search engine optimized for comprehensive, accurate, and trusted "
                "results. Useful for when you need to answer questions about current events."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "search_query": {"type": "string", "description": "The search query to execute"}
                },
                "required": ["search_query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "think_tool",
            "description": "Strategic reflection tool for research planning. Use after each search to analyze results and plan next steps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reflection": {"type": "string", "description": "Your detailed reflection on research progress, findings, gaps, and next steps"}
                },
                "required": ["reflection"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def resolve_input(agent_input: str, problem: str, ctx: dict[str, str]) -> str:
    """Resolve an agent's input template: empty → original problem; ${id} → ctx[id]."""
    if not agent_input.strip():
        return problem
    return re.sub(
        r"\$\{(\w+)\}",
        lambda m: ctx.get(m.group(1), f"[output of {m.group(1)} not available]"),
        agent_input,
    )


async def _llm_call(system: str, user: str, model: str, max_tokens: int = 4096) -> str:
    """Single chat completion call with reasoning-model awareness."""
    is_reasoning = _is_reasoning_model(model)
    kwargs: dict = dict(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_completion_tokens=16000 if is_reasoning else max_tokens,
    )
    if _supports_temperature(model):
        kwargs["temperature"] = 0.5
    res = await get_client(model).chat.completions.create(**kwargs)
    return res.choices[0].message.content or ""


_search_semaphore = asyncio.Semaphore(2)


async def _duckduckgo_search(query: str, max_results: int = 5) -> str:
    """DuckDuckGo text search, rate-limited to avoid 429s. Mirrors WebSearchAgent."""
    try:
        from ddgs import DDGS
    except ImportError:
        return "[ddgs not installed — pip install ddgs]"
    async with _search_semaphore:
        try:
            results = await asyncio.to_thread(
                lambda: list(DDGS().text(query, max_results=max_results))
            )
        except Exception as e:
            return f"Search error: {e}"
        if not results:
            return "No search results found. Please try a different search query."
        out = ["Search results:\n"]
        for i, r in enumerate(results, 1):
            out.append(f"--- SOURCE {i}: {r.get('title', 'Untitled')} ---")
            out.append(f"URL: {r.get('href', '')}\n")
            out.append(f"CONTENT:\n{r.get('body', '')}\n")
            out.append("-" * 80)
        return "\n".join(out)


# ---------------------------------------------------------------------------
# Agent executors — one per AgentType
# ---------------------------------------------------------------------------

async def _execute_cot(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Single step-by-step chain-of-thought call. Mirrors CoTAgent."""
    task = resolve_input(agent.input, problem, ctx)
    override = agent.subagent_config.system_prompt if agent.subagent_config and agent.subagent_config.system_prompt else None
    system = override or f"You are a helpful assistant.\n\n{COT_INSTRUCTION}\n\nRole: {agent.description}"
    user = f"Original question: {problem}\n\nYour task: {task}"
    return await _llm_call(system, user, model) or f"[{agent.id} returned empty response]"


async def _execute_sc(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Self-Consistency: N parallel CoT samples aggregated by LLM majority vote.

    Mirrors SCAgent — codebase uses num_repeated_samples=5.
    """
    task = resolve_input(agent.input, problem, ctx)
    cfg = agent.subagent_config
    num_samples = (cfg.num_samples if cfg and cfg.num_samples else 5)
    system = (cfg.system_prompt if cfg and cfg.system_prompt else f"You are a helpful assistant.\n\n{COT_INSTRUCTION}\n\nRole: {agent.description}")
    question = f"Original question: {problem}\n\nYour task: {task}"

    print(f"  SC {agent.id}: running {num_samples} parallel CoT samples")
    samples = await asyncio.gather(*[_llm_call(system, question, model) for _ in range(num_samples)])

    numbered = "\n\n".join(f"--- Sample {i + 1} ---\n{s}" for i, s in enumerate(samples))
    vote_user = (
        f"{question}\n\n"
        f"You ran {num_samples} independent Chain-of-Thought attempts and got these answers:\n\n{numbered}\n\n"
        "Identify which answer has the most consensus across the samples (majority vote). "
        "Output the single best final answer, using the consensus answer where one exists."
    )
    print(f"  SC {agent.id}: aggregating via majority vote")
    final = await _llm_call(
        "You are an expert judge selecting the most consistent answer across multiple reasoning attempts.",
        vote_user,
        model,
    )
    return final or f"[{agent.id} returned empty response]"


async def _execute_debate(
    agent: Agent, problem: str, ctx: dict[str, str], model: str, is_answer_agent: bool
) -> str:
    """Single debate turn. Role depends on position in the DAG:

    - no deps → INITIAL (solve independently)
    - has deps, not the final answer node → DEBATE (update given peers' solutions)
    - has deps, is the final answer node → FINAL (synthesize)
    """
    task = resolve_input(agent.input, problem, ctx)
    if not agent.depends_on:
        instruction, stage = DEBATE_INITIAL_INSTRUCTION, "initial"
    elif is_answer_agent:
        instruction, stage = DEBATE_FINAL_INSTRUCTION, "final"
    else:
        instruction, stage = DEBATE_INSTRUCTION, "debate"

    print(f"  Debate {agent.id}: stage={stage}")
    override = agent.subagent_config.system_prompt if agent.subagent_config and agent.subagent_config.system_prompt else None
    system = override or f"You are a helpful assistant.\n\n{instruction}\n\nRole: {agent.description}"
    user = f"Original question: {problem}\n\nYour task: {task}"
    return await _llm_call(system, user, model) or f"[{agent.id} returned empty response]"


async def _execute_reflexion(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Multi-turn Reflexion: initial → (critic → refine)×N. Returns only the final answer.

    Mirrors ReflexionAgent — codebase uses max_reflection_round=5; demo uses 3 for speed.
    """
    task = resolve_input(agent.input, problem, ctx)
    cfg = agent.subagent_config
    max_rounds = cfg.num_rounds if cfg and cfg.num_rounds else 3
    role_system = (cfg.system_prompt if cfg and cfg.system_prompt else f"You are a helpful assistant.\n\nRole: {agent.description}")
    critic_instruction = (cfg.critic_prompt if cfg and cfg.critic_prompt else REFLEXION_CRITIC_INSTRUCTION)
    question = f"Original question: {problem}\n\nYour task: {task}"

    print(f"  Reflexion {agent.id}: initial attempt")
    answer = await _llm_call(f"{role_system}\n\n{REFLEXION_INITIAL_INSTRUCTION}", question, model)

    for i in range(max_rounds):
        print(f"  Reflexion {agent.id}: critic round {i + 1}/{max_rounds}")
        critic_user = (
            f"{question}\n\n"
            f"Previous answer:\n{answer}\n\n"
            "Review the answer above. If you are absolutely sure it is correct, "
            "start your response with exactly 'CORRECT: True'. Otherwise start with "
            "'CORRECT: False' and then explain specifically what is wrong or missing."
        )
        feedback = await _llm_call(
            f"{role_system}\n\n{critic_instruction}", critic_user, model
        )

        first_line = feedback.strip().splitlines()[0] if feedback.strip() else ""
        if "CORRECT: TRUE" in first_line.upper():
            print(f"  Reflexion {agent.id}: critic accepted answer")
            break

        print(f"  Reflexion {agent.id}: refine round {i + 1}")
        refine_user = (
            f"{question}\n\n"
            f"Previous attempt:\n{answer}\n\n"
            f"Critic feedback:\n{feedback}\n\n"
            "Using the feedback above, produce an improved final answer."
        )
        answer = await _llm_call(
            f"{role_system}\n\n{REFLEXION_REFLECT_INSTRUCTION}", refine_user, model
        )

    return answer or f"[{agent.id} returned empty response]"


async def _execute_websearch(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Web search agent. Uses native Responses API web_search for OpenAI models,
    falls back to DuckDuckGo tool-calling loop for others."""
    task = resolve_input(agent.input, problem, ctx)
    today = datetime.now().strftime("%Y-%m-%d")

    # OpenAI models: use Responses API with native web_search (same quality as ChatGPT)
    if not _is_together_model(model):
        print(f"  WebSearch {agent.id}: using Responses API native web_search (model={model})")
        system_prompt = (
            f"You are a research assistant. Today's date is {today}.\n\n"
            f"Role: {agent.description}\n\n"
            "Search the web to find accurate, up-to-date information. "
            "Provide a comprehensive answer with sources and citations."
        )
        user_msg = f"Original question: {problem}\n\nResearch Task: {task}"
        return await _responses_api_call(
            system_prompt, user_msg, model,
            [{"type": "web_search"}],
            agent.id,
        )

    # Non-OpenAI models: DuckDuckGo tool-calling loop
    max_iterations = 5
    system_prompt = WEBSEARCH_SYSTEM_PROMPT_TEMPLATE.format(date=today)
    messages = [
        {"role": "system", "content": f"{system_prompt}\n\nRole: {agent.description}"},
        {"role": "user", "content": (
            f"Original question: {problem}\n\nResearch Task: {task}\n\n"
            "Please conduct web searches and provide a comprehensive answer with sources."
        )},
    ]
    base_kwargs: dict = dict(model=model, tools=WEBSEARCH_TOOLS, max_completion_tokens=16000)
    if _supports_temperature(model):
        base_kwargs["temperature"] = 0.7

    client = get_client(model)
    for iteration in range(max_iterations):
        print(f"  WebSearch {agent.id}: iteration {iteration + 1}/{max_iterations}")
        res = await client.chat.completions.create(messages=messages, **base_kwargs)
        msg = res.choices[0].message
        messages.append(msg)
        if not msg.tool_calls:
            return msg.content or f"[{agent.id} returned empty response]"
        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments)
            if tc.function.name == "web_search":
                query = args.get("search_query", "")
                print(f"    web_search({query[:60]}...)")
                result = await _duckduckgo_search(query)
            elif tc.function.name == "think_tool":
                reflection = args.get("reflection", "")
                print(f"    think_tool({reflection[:60]}...)")
                result = f"Reflection recorded: {reflection}"
            else:
                result = f"Unknown tool: {tc.function.name}"
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})

    final_kwargs = {k: v for k, v in base_kwargs.items() if k != "tools"}
    res = await client.chat.completions.create(messages=messages, **final_kwargs)
    return res.choices[0].message.content or f"[{agent.id} returned empty response]"


def _build_custom_tools(cfg) -> list[dict]:
    """Build OpenAI Chat Completions tool definitions from a CustomAgentConfig."""
    tools = []
    if cfg.enable_web_search:
        tools.append(WEBSEARCH_TOOLS[0])  # web_search
    if cfg.enable_think_tool:
        tools.append(WEBSEARCH_TOOLS[1])  # think_tool
    if cfg.tools:
        for t in cfg.tools:
            tools.append({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters or {"type": "object", "properties": {}},
                },
            })
    return tools


def _build_responses_tools(cfg) -> list[dict]:
    """Build Responses API tool definitions — native GPT-5.1 tools only."""
    tools: list[dict] = []
    if cfg.enable_code_interpreter:
        tools.append({"type": "code_interpreter", "container": {"type": "auto"}})
    if cfg.enable_web_search:
        tools.append({"type": "web_search"})
    if cfg.mcp_servers:
        for m in cfg.mcp_servers:
            entry: dict = {
                "type": "mcp",
                "server_label": m.server_label,
                "server_url": m.server_url,
                "require_approval": m.require_approval or "never",
            }
            if m.headers:
                entry["headers"] = m.headers
            tools.append(entry)
    return tools


def _uses_responses_api(cfg) -> bool:
    """Any native GPT-5.1 tool forces the Responses API path."""
    return bool(
        cfg.enable_code_interpreter
        or cfg.enable_web_search
        or (cfg.mcp_servers and len(cfg.mcp_servers) > 0)
    )


async def _responses_api_call(system: str, user: str, model: str, tools: list[dict], agent_id: str) -> str:
    """Run a single Responses API call with native tools (code_interpreter, web_search).

    Used when enable_code_interpreter is set — Chat Completions doesn't support it.
    """
    print(f"  Custom {agent_id}: Responses API with native tools: {[t['type'] for t in tools]}")
    resp = await _get_openai_client().responses.create(
        model=model,
        tools=tools,
        input=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    # output_text is the canonical aggregated text across all output items
    text = getattr(resp, "output_text", None)
    if text:
        return text
    # Fallback: walk output items for text content
    chunks: list[str] = []
    for item in getattr(resp, "output", []) or []:
        if getattr(item, "type", None) == "message":
            for c in getattr(item, "content", []) or []:
                if getattr(c, "type", None) == "output_text":
                    chunks.append(getattr(c, "text", ""))
    return "\n".join(chunks) or f"[{agent_id} returned empty response]"


async def _tool_calling_loop(
    system: str, user: str, model: str, tools: list[dict], agent_id: str, max_iterations: int = 8
) -> str:
    """Run an LLM with tools in a loop until it produces a final text response."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    base_kwargs: dict = dict(model=model, tools=tools, max_completion_tokens=16000)
    if _supports_temperature(model):
        base_kwargs["temperature"] = 0.5

    client = get_client(model)
    for iteration in range(max_iterations):
        print(f"  Custom {agent_id}: tool loop iteration {iteration + 1}/{max_iterations}")
        res = await client.chat.completions.create(messages=messages, **base_kwargs)
        msg = res.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            return msg.content or f"[{agent_id} returned empty response]"

        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments)
            if tc.function.name == "web_search":
                query = args.get("search_query", "")
                print(f"    web_search({query[:60]}...)")
                result = await _duckduckgo_search(query)
            elif tc.function.name == "think_tool":
                reflection = args.get("reflection", "")
                print(f"    think_tool({reflection[:60]}...)")
                result = f"Reflection recorded: {reflection}"
            else:
                # Custom tool — return a placeholder indicating the tool was called
                print(f"    {tc.function.name}({json.dumps(args)[:80]}...)")
                result = f"Tool '{tc.function.name}' called with: {json.dumps(args)}\n[Tool execution simulated — integrate real implementations as needed]"
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})

    # Max iterations — force a final answer
    final_kwargs = {k: v for k, v in base_kwargs.items() if k != "tools"}
    res = await client.chat.completions.create(messages=messages, **final_kwargs)
    return res.choices[0].message.content or f"[{agent_id} returned empty response]"


TOOL_MODEL = "gpt-5.4-mini"


async def _execute_custom(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Execute a user-designed custom agent based on its config."""
    cfg = agent.custom_config
    if not cfg:
        return await _execute_cot(agent, problem, ctx, model)

    task = resolve_input(agent.input, problem, ctx)
    system = f"{cfg.system_prompt}\n\nRole: {agent.description}"
    question = f"Original question: {problem}\n\nYour task: {task}"

    # Any native GPT-5.1 tool (web_search, code_interpreter, mcp) → Responses API.
    # For multi-sample/critique/pipeline strategies we run Responses API per sub-call.
    if _uses_responses_api(cfg):
        responses_tools = _build_responses_tools(cfg)
        ci_model = TOOL_MODEL  # Responses API requires a model that supports tools

        async def ci_call(u: str) -> str:
            return await _responses_api_call(system, u, ci_model, responses_tools, agent.id)

        if cfg.strategy == CustomStrategy.SINGLE:
            return await ci_call(question) or f"[{agent.id} returned empty response]"
        if cfg.strategy == CustomStrategy.MULTI_SAMPLE:
            n = cfg.num_samples if cfg.num_samples else 3
            print(f"  Custom {agent.id}: {n} parallel Responses API samples")
            samples = await asyncio.gather(*[ci_call(question) for _ in range(n)])
            numbered = "\n\n".join(f"--- Sample {i+1} ---\n{s}" for i, s in enumerate(samples))
            vote_user = (
                f"{question}\n\nYou ran {n} independent attempts:\n\n{numbered}\n\n"
                "Identify the consensus answer across these samples. Output the single best final answer."
            )
            return await _llm_call(
                "You are an expert judge selecting the most consistent answer.", vote_user, ci_model
            ) or f"[{agent.id} returned empty response]"
        if cfg.strategy == CustomStrategy.CRITIQUE:
            rounds = cfg.num_rounds if cfg.num_rounds else 2
            critic_prompt = cfg.critic_prompt or "Review the answer above and identify any flaws or improvements."
            answer = await ci_call(question)
            for i in range(rounds):
                critic_user = f"{question}\n\nCurrent answer:\n{answer}\n\n{critic_prompt}"
                feedback = await ci_call(critic_user)
                if "CORRECT: TRUE" in feedback.strip().split("\n", 1)[0].upper():
                    break
                answer = await ci_call(
                    f"{question}\n\nPrevious attempt:\n{answer}\n\nFeedback:\n{feedback}\n\nProduce an improved answer."
                )
            return answer or f"[{agent.id} returned empty response]"
        if cfg.strategy == CustomStrategy.PIPELINE:
            steps = cfg.steps if cfg.steps else ["Solve the task step by step."]
            accumulator = ""
            for i, step_prompt in enumerate(steps):
                step_user = f"{question}\n\n"
                if accumulator:
                    step_user += f"Previous steps output:\n{accumulator}\n\n"
                step_user += f"Current step instruction: {step_prompt}"
                accumulator = await ci_call(step_user)
            return accumulator or f"[{agent.id} returned empty response]"

    tools = _build_custom_tools(cfg)
    # Use a stronger model when tools are enabled
    effective_model = TOOL_MODEL if tools else model

    if cfg.strategy == CustomStrategy.SINGLE:
        if tools:
            print(f"  Custom {agent.id}: single call with {len(tools)} tools (model={effective_model})")
            return await _tool_calling_loop(system, question, effective_model, tools, agent.id)
        print(f"  Custom {agent.id}: single call")
        return await _llm_call(system, question, model) or f"[{agent.id} returned empty response]"

    if cfg.strategy == CustomStrategy.MULTI_SAMPLE:
        n = cfg.num_samples if cfg.num_samples else 3
        print(f"  Custom {agent.id}: {n} parallel samples (model={effective_model})")
        samples = await asyncio.gather(*[_llm_call(system, question, effective_model) for _ in range(n)])
        numbered = "\n\n".join(f"--- Sample {i+1} ---\n{s}" for i, s in enumerate(samples))
        vote_user = (
            f"{question}\n\n"
            f"You ran {n} independent attempts:\n\n{numbered}\n\n"
            "Identify the consensus answer across these samples. Output the single best final answer."
        )
        return await _llm_call(
            "You are an expert judge selecting the most consistent answer.", vote_user, effective_model
        ) or f"[{agent.id} returned empty response]"

    if cfg.strategy == CustomStrategy.CRITIQUE:
        rounds = cfg.num_rounds if cfg.num_rounds else 2
        critic_prompt = cfg.critic_prompt if cfg.critic_prompt else "Review the answer above and identify any flaws or improvements."
        print(f"  Custom {agent.id}: initial attempt")
        answer = await _llm_call(system, question, effective_model)
        for i in range(rounds):
            print(f"  Custom {agent.id}: critic round {i+1}/{rounds}")
            critic_user = f"{question}\n\nCurrent answer:\n{answer}\n\n{critic_prompt}"
            feedback = await _llm_call(system, critic_user, effective_model)
            first_line = feedback.strip().splitlines()[0] if feedback.strip() else ""
            if "CORRECT: TRUE" in first_line.upper() or "NO ISSUES" in first_line.upper():
                break
            print(f"  Custom {agent.id}: refine round {i+1}")
            refine_user = (
                f"{question}\n\nPrevious attempt:\n{answer}\n\n"
                f"Feedback:\n{feedback}\n\nProduce an improved answer."
            )
            answer = await _llm_call(system, refine_user, effective_model)
        return answer or f"[{agent.id} returned empty response]"

    if cfg.strategy == CustomStrategy.PIPELINE:
        steps = cfg.steps if cfg.steps else ["Solve the task step by step."]
        print(f"  Custom {agent.id}: pipeline with {len(steps)} steps")
        accumulator = ""
        for i, step_prompt in enumerate(steps):
            print(f"  Custom {agent.id}: step {i+1}/{len(steps)}")
            step_user = f"{question}\n\n"
            if accumulator:
                step_user += f"Previous steps output:\n{accumulator}\n\n"
            step_user += f"Current step instruction: {step_prompt}"
            accumulator = await _llm_call(system, step_user, effective_model)
        return accumulator or f"[{agent.id} returned empty response]"

    return await _execute_cot(agent, problem, ctx, model)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

async def execute_agent(
    agent: Agent,
    problem: str,
    ctx: dict[str, str],
    model: str = "gpt-5.4-mini",
    is_answer_agent: bool = False,
) -> str:
    """Dispatch a single agent node to the executor matching its type."""
    try:
        if agent.type == AgentType.COT:
            return await _execute_cot(agent, problem, ctx, model)
        if agent.type == AgentType.SC:
            return await _execute_sc(agent, problem, ctx, model)
        if agent.type == AgentType.DEBATE:
            return await _execute_debate(agent, problem, ctx, model, is_answer_agent)
        if agent.type == AgentType.REFLEXION:
            return await _execute_reflexion(agent, problem, ctx, model)
        if agent.type == AgentType.WEBSEARCH:
            return await _execute_websearch(agent, problem, ctx, model)
        if agent.type == AgentType.CUSTOM:
            return await _execute_custom(agent, problem, ctx, model)
        return await _execute_cot(agent, problem, ctx, model)
    except Exception as e:
        raise RuntimeError(f"Agent {agent.id} failed: {e}") from e
