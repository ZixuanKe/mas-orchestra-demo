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


async def call_metaagent(problem: str, dataset: Dataset) -> str:
    meta = DATASET_META[dataset]
    dom: DomLevel = meta["dom"]
    model: str = meta["vllm_model"]
    messages = build_math_messages(problem) if dom == DomLevel.LOW else build_mas_messages(problem)

    try:
        resp = await get_vllm_client().chat.completions.create(
            model=model, messages=messages, temperature=0.7, max_tokens=4096,
        )
        return resp.choices[0].message.content or ""
    except Exception as e:
        print(f"vLLM error ({model}): {e}, using mock")
        return MOCK_LOW if dom == DomLevel.LOW else MOCK_HIGH


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
