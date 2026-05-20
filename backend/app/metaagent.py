import os
from openai import AsyncOpenAI
from .models import Dataset, DATASET_META, DomLevel
from .vllm_prompts import build_math_messages, build_mas_messages

VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "")

_vllm_client: AsyncOpenAI | None = None


def get_vllm_client() -> AsyncOpenAI:
    global _vllm_client
    if _vllm_client is None:
        _vllm_client = AsyncOpenAI(base_url=VLLM_BASE_URL, api_key="dummy")
    return _vllm_client


DEFAULT_CUSTOM_MODEL = {
    DomLevel.LOW: "math",
    DomLevel.HIGH: "hotpotqa",
    DomLevel.HIGH_EXTENSIVE: "browsecomp",
}


async def call_metaagent(
    problem: str, dataset: Dataset | None, dom: DomLevel,
) -> tuple[str, str | None]:
    """Generate the initial plan XML via the per-dataset vLLM model.

    Returns ``(xml, warning_or_none)``. When the vLLM call fails (network
    error, model crash, empty response, etc.) we still degrade gracefully
    to a hardcoded mock so the demo doesn't die — but we also surface a
    human-readable warning so the user knows the displayed plan is *not*
    what the trained planner would have produced. The warning is rendered
    inline in the conversation by the frontend.
    """
    if dataset is not None:
        model: str = DATASET_META[dataset]["vllm_model"]
    else:
        model = DEFAULT_CUSTOM_MODEL[dom]
    messages = build_math_messages(problem) if dom == DomLevel.LOW else build_mas_messages(problem)

    try:
        resp = await get_vllm_client().chat.completions.create(
            model=model, messages=messages, temperature=0.7, max_tokens=4096,
        )
        content = resp.choices[0].message.content or ""
        if not content.strip():
            mock = MOCK_LOW if dom == DomLevel.LOW else MOCK_HIGH
            warning = (
                f"vLLM planner ({model}) returned an empty response. "
                "Using a generic fallback plan — the displayed agents are NOT "
                "what the trained planner would have produced."
            )
            return mock, warning
        return content, None
    except Exception as e:
        mock = MOCK_LOW if dom == DomLevel.LOW else MOCK_HIGH
        warning = (
            f"vLLM planner ({model}) failed: {e}. "
            "Using a generic fallback plan — the displayed agents are NOT "
            "what the trained planner would have produced."
        )
        return mock, warning


MOCK_LOW = """<thinking>
This is a straightforward reasoning task. A Chain-of-Thought agent will work well.
</thinking>
<agent>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Reasons through the problem step by step</agent_description>
  <required_arguments><agent_input></agent_input></required_arguments>
  <agent_output_id>reasoning_agent</agent_output_id>
</agent>
<answer>reasoning_agent</answer>"""

MOCK_HIGH = """<thinking>
This problem requires multiple perspectives. I'll use a search agent to gather information,
then have two reasoning agents analyze from different angles, and finally synthesize.
</thinking>
<agent>
  <agent_id>search</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Searches for relevant information</agent_description>
  <required_arguments><agent_input></agent_input></required_arguments>
</agent>
<agent>
  <agent_id>analyzer_1</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Analyzes from a technical perspective</agent_description>
  <required_arguments><agent_input>${search}</agent_input></required_arguments>
</agent>
<agent>
  <agent_id>analyzer_2</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Analyzes from a practical perspective</agent_description>
  <required_arguments><agent_input>${search}</agent_input></required_arguments>
</agent>
<agent>
  <agent_id>synthesizer</agent_id>
  <agent_name>ReflexionAgent</agent_name>
  <agent_description>Synthesizes insights into final answer</agent_description>
  <required_arguments><agent_input>${analyzer_1} ${analyzer_2}</agent_input></required_arguments>
</agent>
<answer>synthesizer</answer>"""
