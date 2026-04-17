from pydantic import BaseModel
from enum import Enum


class DomLevel(str, Enum):
    LOW = "low"
    HIGH = "high"
    HIGH_EXTENSIVE = "high_extensive"


class Dataset(str, Enum):
    AIME = "aime"
    HOTPOT = "hotpot"
    BROWSECOMP = "browsecomp"


DATASET_META = {
    Dataset.AIME: {"dom": DomLevel.LOW, "vllm_model": "math", "label": "AIME 2024/2025 (Low)"},
    Dataset.HOTPOT: {"dom": DomLevel.HIGH, "vllm_model": "hotpotqa", "label": "HotpotQA (High)"},
    Dataset.BROWSECOMP: {"dom": DomLevel.HIGH, "vllm_model": "browsecomp", "label": "BrowseComp (High)"},
}


class AgentType(str, Enum):
    COT = "CoTAgent"
    SC = "SCAgent"
    DEBATE = "DebateAgent"
    REFLEXION = "ReflexionAgent"
    WEBSEARCH = "WebSearchAgent"
    CUSTOM = "CustomAgent"


class CustomStrategy(str, Enum):
    SINGLE = "single"
    MULTI_SAMPLE = "multi_sample"
    CRITIQUE = "critique"
    PIPELINE = "pipeline"


class CustomTool(BaseModel):
    name: str
    description: str
    parameters: dict = {}  # JSON Schema for the tool's parameters


class CustomAgentConfig(BaseModel):
    name: str
    strategy: CustomStrategy
    system_prompt: str
    num_samples: int | None = 3
    num_rounds: int | None = 2
    critic_prompt: str | None = ""
    steps: list[str] | None = []
    enable_web_search: bool = False
    enable_think_tool: bool = False
    tools: list[CustomTool] | None = []


class Agent(BaseModel):
    id: str
    type: AgentType
    description: str
    input: str
    depends_on: list[str]
    custom_config: CustomAgentConfig | None = None


class Edge(BaseModel):
    source: str
    target: str


class Graph(BaseModel):
    agents: list[Agent]
    edges: list[Edge]
    answer_agent: str
    direct_solution: str | None = None


