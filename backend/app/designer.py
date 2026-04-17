"""Design custom agents from natural language descriptions using GPT-5.1."""

import json
from .executor import get_client
from .models import CustomAgentConfig, CustomStrategy

DESIGNER_MODEL = "gpt-5.1"

DESIGNER_SYSTEM_PROMPT = """You are an expert multi-agent system architect for MAS-Orchestra.

Your job is to take a user's natural language description of a custom agent and compile it into a structured execution config.

## Available Strategies

1. **single** — One LLM call with a custom system prompt. Good for: specialized reasoning, role-playing, analysis tasks.
2. **multi_sample** — N parallel LLM calls with different reasoning paths, then a judge picks the best/consensus answer. Good for: problems where sampling helps, math, creative tasks.
3. **critique** — Initial attempt, then critic/refine loops. Good for: tasks needing self-improvement, verification, quality control.
4. **pipeline** — Sequential steps where each builds on the previous output. Good for: multi-phase tasks, research-then-synthesize, decomposition.

## Output Format

You MUST output valid JSON (no markdown fences) with these fields:
{
  "name": "ShortAgentName",
  "strategy": "single" | "multi_sample" | "critique" | "pipeline",
  "system_prompt": "The core instruction/personality for this agent. Be detailed and specific.",
  "num_samples": 3,           // only for multi_sample (2-7)
  "num_rounds": 2,            // only for critique (1-4)
  "critic_prompt": "...",     // only for critique — what the critic checks for
  "steps": ["step 1", ...],   // only for pipeline — each step's instruction
  "enable_web_search": false,  // true if the agent needs to search the web
  "enable_think_tool": false   // true if the agent benefits from extended thinking/chain-of-thought tool
}

## Guidelines
- The system_prompt should be thorough — it defines the agent's personality and approach
- For pipeline, each step should be a clear instruction that builds on previous output
- Choose the simplest strategy that matches the user's intent
- Name should be PascalCase, descriptive, ending in "Agent" (e.g., "DevilsAdvocateAgent")
- The description the user gives may be vague — interpret it generously and design something useful
- Enable web_search when the agent needs real-time info, fact-checking, or research
- Enable think_tool when the agent needs deep reasoning, math verification, or multi-step logic
- If the user mentions "best of N", "sampling", or "verification", use multi_sample strategy with appropriate num_samples"""


async def design_agent(description: str) -> CustomAgentConfig:
    """Use GPT-5.1 to compile a natural language agent description into a config."""
    resp = await get_client().chat.completions.create(
        model=DESIGNER_MODEL,
        messages=[
            {"role": "system", "content": DESIGNER_SYSTEM_PROMPT},
            {"role": "user", "content": f"Design a custom agent based on this description:\n\n{description}"},
        ],
        temperature=0.3,
        max_completion_tokens=4096,
    )
    raw = resp.choices[0].message.content or "{}"
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    data = json.loads(raw)
    return CustomAgentConfig(
        name=data.get("name", "CustomAgent"),
        strategy=CustomStrategy(data.get("strategy", "single")),
        system_prompt=data.get("system_prompt", "You are a helpful assistant."),
        num_samples=data.get("num_samples", 3),
        num_rounds=data.get("num_rounds", 2),
        critic_prompt=data.get("critic_prompt", ""),
        steps=data.get("steps", []),
        enable_web_search=data.get("enable_web_search", False),
        enable_think_tool=data.get("enable_think_tool", False),
    )
