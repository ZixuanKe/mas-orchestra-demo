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
    # MASBench (Salesforce/MASBench on HF) is the proposed MAS evaluation
    # split from the MAS-Orchestra paper. It bundles six reasoning families
    # (breadth, combine, depth, horizon, parallel, robustness) all derived
    # from igsm-style multi-step math. We pin it to HIGH_EXTENSIVE +
    # browsecomp because (a) MASBench tasks are pure reasoning (no web),
    # (b) the robustness/parallel splits have N≥10 independent fields
    # that benefit from N-way ExtractAgent fan-in, and (c) browsecomp is
    # the only one of the three vLLM heads that reliably produces that
    # fan-out structure. MASBench-specific prompts (ExtractAgent
    # substituted for WebSearchAgent) are picked in metaagent.py.
    MASBENCH = "masbench"


DATASET_META = {
    Dataset.AIME: {"dom": DomLevel.LOW, "vllm_model": "math", "label": "AIME 2024/2025 (Low)"},
    Dataset.HOTPOT: {"dom": DomLevel.HIGH, "vllm_model": "hotpotqa", "label": "HotpotQA (High)"},
    Dataset.BROWSECOMP: {"dom": DomLevel.HIGH, "vllm_model": "browsecomp", "label": "BrowseComp (High)"},
    Dataset.MASBENCH: {"dom": DomLevel.HIGH_EXTENSIVE, "vllm_model": "browsecomp", "label": "MASBench (Extensive)"},
}


class AgentType(str, Enum):
    COT = "CoTAgent"
    SC = "SCAgent"
    DEBATE = "DebateAgent"
    REFLEXION = "ReflexionAgent"
    WEBSEARCH = "WebSearchAgent"
    # Lightweight reasoning agent whose only job is to pull specific
    # fields/facts out of an upstream agent's text (or the original
    # problem) and emit them in a clean, machine-friendly form. Useful
    # as a post-WebSearch normalizer or as a parser between heavy
    # reasoning steps. Implemented in executor._execute_extract.
    EXTRACT = "ExtractAgent"
    CUSTOM = "CustomAgent"
    # Enterprise mode: an MCPAgent is an LLM that wields exactly one MCP
    # tool — i.e. agent = LLM + tool, not raw tool calls. The orchestrator
    # decides ordering; the per-agent LLM decides whether/how to call.
    MCP_AGENT = "MCPAgent"
    # Final answer-sink for enterprise mode: a plain LLM that summarizes the
    # outcome of all upstream MCPAgent calls for the user.
    ENTERPRISE_EXECUTOR = "EnterpriseExecutorAgent"
    # Local file-tool agents. Available to both the reasoning and
    # enterprise planners. They differ from other agent types in that
    # the backend never executes them itself — instead, ``/execute``
    # emits a ``tool_request`` SSE event and waits for the CLI to POST
    # the result back via ``/execute/tool-result``. The webapp simply
    # never asks the planner to emit them (file ops on the browser
    # side aren't useful).
    READ_FILE = "ReadFileAgent"
    WRITE_FILE = "WriteFileAgent"
    PATCH = "PatchAgent"
    SEARCH_FILES = "SearchFilesAgent"


# Set membership check used by the executor and refiner to detect
# agents that must round-trip to the CLI for local execution.
FILE_TOOL_AGENT_TYPES: frozenset[AgentType] = frozenset({
    AgentType.READ_FILE,
    AgentType.WRITE_FILE,
    AgentType.PATCH,
    AgentType.SEARCH_FILES,
})

# Map AgentType → underlying tool name the CLI dispatches against. The
# CLI's tool registry is keyed by these short names (see
# mas-orchestra-cli/mas/tools/file_tools.py).
FILE_TOOL_NAMES: dict[AgentType, str] = {
    AgentType.READ_FILE: "read_file",
    AgentType.WRITE_FILE: "write_file",
    AgentType.PATCH: "patch",
    AgentType.SEARCH_FILES: "search_files",
}


class CustomStrategy(str, Enum):
    SINGLE = "single"
    MULTI_SAMPLE = "multi_sample"
    CRITIQUE = "critique"
    PIPELINE = "pipeline"


class CustomTool(BaseModel):
    name: str
    description: str
    parameters: dict = {}  # JSON Schema for the tool's parameters


class MCPServer(BaseModel):
    server_label: str
    server_url: str
    headers: dict[str, str] | None = None
    require_approval: str = "never"  # "never" | "always"


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
    enable_code_interpreter: bool = False
    mcp_servers: list[MCPServer] | None = None
    tools: list[CustomTool] | None = []


class SubagentConfig(BaseModel):
    """Per-instance overrides for built-in agent types (CoT/SC/Debate/Reflexion)."""
    system_prompt: str | None = None  # override role-specific system prompt
    num_samples: int | None = None    # SCAgent — default 5
    num_rounds: int | None = None     # ReflexionAgent — default 3
    critic_prompt: str | None = None  # ReflexionAgent critic override


class Agent(BaseModel):
    id: str
    type: AgentType
    description: str
    input: str
    depends_on: list[str]
    custom_config: CustomAgentConfig | None = None
    subagent_config: SubagentConfig | None = None
    # Enterprise mode only: the MCP tool this agent wraps.
    tool_name: str | None = None
    # File-tool agents only: the tool arguments the planner wants to
    # invoke the tool with (e.g. ``{"path": "README.md"}`` for a
    # ReadFileAgent). The executor forwards these verbatim to the CLI
    # in the ``tool_request`` SSE event.
    tool_args: dict | None = None


class Edge(BaseModel):
    source: str
    target: str


class Graph(BaseModel):
    agents: list[Agent]
    edges: list[Edge]
    answer_agent: str
    direct_solution: str | None = None


