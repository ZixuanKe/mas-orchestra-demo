from pydantic import BaseModel
from enum import Enum


class DomLevel(str, Enum):
    LOW = "low"
    HIGH = "high"


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


class Agent(BaseModel):
    id: str
    type: AgentType
    description: str
    input: str
    depends_on: list[str]


class Edge(BaseModel):
    source: str
    target: str


class Graph(BaseModel):
    agents: list[Agent]
    edges: list[Edge]
    answer_agent: str
    direct_solution: str | None = None


