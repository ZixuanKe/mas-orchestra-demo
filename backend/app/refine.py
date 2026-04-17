"""Refine endpoint: revise a MAS plan via a strong LLM (GPT-4.1)."""

from openai import AsyncOpenAI
from .executor import get_client

REFINE_MODEL = "gpt-4.1"

REFINE_SYSTEM_PROMPT = """You are an expert multi-agent system designer for MAS-Orchestra.

Your job is to revise an existing multi-agent plan based on the user's instruction.
You must output a COMPLETE revised plan in the same XML format — not a diff, not a partial update.

## XML Schema

Each agent is defined as:
<agent>
  <agent_id>UNIQUE_ID</agent_id>
  <agent_name>AGENT_TYPE</agent_name>
  <agent_description>What this agent does</agent_description>
  <required_arguments>
    <agent_input>The task for this agent. Use ${OTHER_AGENT_ID} to reference another agent's output.</agent_input>
  </required_arguments>
</agent>

After all agents, define edges in a single <edge> block:
<edge>
  <from>SOURCE_ID</from><to>TARGET_ID</to>
</edge>

## Available Agent Types
- CoTAgent: Chain-of-Thought reasoning, step by step.
- SCAgent: Self-Consistency — samples multiple reasoning paths and majority-votes.
- DebateAgent: Multiple agents debate to refine an answer. Requires <debate_roles> in required_arguments.
- ReflexionAgent: Reflects on prior outputs to revise the answer.
- WebSearchAgent: Retrieves recent factual information from the web.

## Constraints
1. Every agent_id must be unique (alphanumeric + underscores only).
2. Every <from> and <to> must reference a valid agent_id.
3. The graph must be a DAG (no cycles).
4. Exactly one sink node (no outgoing edges) — this is the final answer agent.
5. If agent Y uses ${X} in its input, there MUST be an edge <from>X</from><to>Y</to>, and vice versa.
6. Include a <thinking> section explaining what you changed and why.

## Important
- Preserve the parts of the plan the user did NOT ask to change.
- Output the FULL revised XML (thinking + all agents + edge block), not just the changed parts."""


async def refine_plan(current_xml: str, user_message: str, problem: str) -> str:
    """Call GPT-4.1 to revise the current XML plan based on user instruction."""
    user_prompt = f"""## Original Problem
{problem}

## Current Plan (XML)
{current_xml}

## User's Revision Request
{user_message}

Please output the complete revised plan XML."""

    resp = await get_client().chat.completions.create(
        model=REFINE_MODEL,
        messages=[
            {"role": "system", "content": REFINE_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
        max_tokens=32768,
    )
    return resp.choices[0].message.content or ""
