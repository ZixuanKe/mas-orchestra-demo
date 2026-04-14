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

from .models import Agent, AgentType


# ---------------------------------------------------------------------------
# OpenAI client (lazy-initialized)
# ---------------------------------------------------------------------------

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


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


async def _llm_call(system: str, user: str, model: str, max_tokens: int = 1024) -> str:
    """Single chat completion call with reasoning-model awareness."""
    is_reasoning = model.startswith("o")
    kwargs: dict = dict(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_completion_tokens=16000 if is_reasoning else max_tokens,
    )
    if not is_reasoning:
        kwargs["temperature"] = 0.5
    res = await get_client().chat.completions.create(**kwargs)
    return res.choices[0].message.content or ""


async def _duckduckgo_search(query: str, max_results: int = 5) -> str:
    """Execute a DuckDuckGo search and format results for the model."""
    try:
        from ddgs import DDGS
    except ImportError:
        return "[ddgs not installed — pip install ddgs]"

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
    system = f"You are a helpful assistant.\n\n{COT_INSTRUCTION}\n\nRole: {agent.description}"
    user = f"Original question: {problem}\n\nYour task: {task}"
    return await _llm_call(system, user, model) or f"[{agent.id} returned empty response]"


async def _execute_sc(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Self-Consistency: N parallel CoT samples aggregated by LLM majority vote.

    Mirrors SCAgent — codebase uses num_repeated_samples=5.
    """
    task = resolve_input(agent.input, problem, ctx)
    num_samples = 5
    system = f"You are a helpful assistant.\n\n{COT_INSTRUCTION}\n\nRole: {agent.description}"
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
    system = f"You are a helpful assistant.\n\n{instruction}\n\nRole: {agent.description}"
    user = f"Original question: {problem}\n\nYour task: {task}"
    return await _llm_call(system, user, model) or f"[{agent.id} returned empty response]"


async def _execute_reflexion(agent: Agent, problem: str, ctx: dict[str, str], model: str) -> str:
    """Multi-turn Reflexion: initial → (critic → refine)×N. Returns only the final answer.

    Mirrors ReflexionAgent — codebase uses max_reflection_round=5; demo uses 3 for speed.
    """
    task = resolve_input(agent.input, problem, ctx)
    max_rounds = 3
    role_system = f"You are a helpful assistant.\n\nRole: {agent.description}"
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
            f"{role_system}\n\n{REFLEXION_CRITIC_INSTRUCTION}", critic_user, model
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
    """Real tool-calling loop with DuckDuckGo. Mirrors WebSearchAgent (max 5 iterations)."""
    task = resolve_input(agent.input, problem, ctx)
    max_iterations = 5
    today = datetime.now().strftime("%Y-%m-%d")
    system_prompt = WEBSEARCH_SYSTEM_PROMPT_TEMPLATE.format(date=today)

    messages = [
        {"role": "system", "content": f"{system_prompt}\n\nRole: {agent.description}"},
        {
            "role": "user",
            "content": (
                f"Original question: {problem}\n\n"
                f"Research Task: {task}\n\n"
                "Please conduct web searches and provide a comprehensive answer with sources."
            ),
        },
    ]

    is_reasoning = model.startswith("o")
    base_kwargs: dict = dict(model=model, tools=WEBSEARCH_TOOLS, max_completion_tokens=16000)
    if not is_reasoning:
        base_kwargs["temperature"] = 0.7

    for iteration in range(max_iterations):
        print(f"  WebSearch {agent.id}: iteration {iteration + 1}/{max_iterations}")
        res = await get_client().chat.completions.create(messages=messages, **base_kwargs)
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

    print(f"  WebSearch {agent.id}: max iterations reached, requesting final answer")
    final_kwargs = {k: v for k, v in base_kwargs.items() if k != "tools"}
    res = await get_client().chat.completions.create(messages=messages, **final_kwargs)
    return res.choices[0].message.content or f"[{agent.id} returned empty response]"


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

async def execute_agent(
    agent: Agent,
    problem: str,
    ctx: dict[str, str],
    model: str = "gpt-4.1-mini",
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
        # Unknown type — fall back to CoT
        return await _execute_cot(agent, problem, ctx, model)
    except Exception as e:
        raise RuntimeError(f"Agent {agent.id} failed: {e}") from e
