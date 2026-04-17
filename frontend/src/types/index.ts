export type AgentType = "CoTAgent" | "SCAgent" | "DebateAgent" | "ReflexionAgent" | "WebSearchAgent" | "CustomAgent";
export type AgentStatus = "pending" | "running" | "completed" | "failed";
export type DomLevel = "low" | "high" | "high_extensive";

export const DOM_OPTIONS: { value: DomLevel; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "≤1 agent" },
  { value: "high", label: "High", hint: "" },
  { value: "high_extensive", label: "High (extensive)", hint: "" },
];

export const AGENT_POOL: { type: string; description: string }[] = [
  { type: "CoTAgent", description: "Chain-of-Thought reasoning, step by step." },
  { type: "SCAgent", description: "Self-consistency: samples multiple reasoning paths and majority-votes." },
  { type: "DebateAgent", description: "Multiple agents debate to refine an answer." },
  { type: "ReflexionAgent", description: "Reflects on prior outputs to revise the answer." },
  { type: "WebSearchAgent", description: "Retrieves recent factual information from the web." },
];
export type Dataset = "aime" | "hotpot" | "browsecomp";
export type Mode = "custom" | Dataset;
export type Stage = "input" | "plan" | "execute" | "result";
export type SubagentModel = "gpt-4.1-mini" | "gpt-4.1" | "o4-mini";

export const DATASETS: { value: Dataset; label: string; dom: DomLevel }[] = [
  { value: "aime", label: "AIME 2024/2025 (Low)", dom: "low" },
  { value: "hotpot", label: "HotpotQA (High)", dom: "high" },
  { value: "browsecomp", label: "BrowseComp (High)", dom: "high" },
];

export const MODES: { value: Mode; label: string }[] = [
  { value: "custom", label: "Custom Problem" },
  { value: "aime", label: "AIME 2024/2025" },
  { value: "hotpot", label: "HotpotQA" },
  { value: "browsecomp", label: "BrowseComp" },
];

export const SUBAGENT_MODELS: { value: SubagentModel; label: string }[] = [
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini (Fast)" },
  { value: "gpt-4.1", label: "GPT-4.1 (General)" },
  { value: "o4-mini", label: "o4-mini (Best)" },
];

export interface DatasetSample {
  question: string;
  answer: string;
}

export interface CustomAgentConfig {
  name: string;
  strategy: "single" | "multi_sample" | "critique" | "pipeline";
  system_prompt: string;
  num_samples?: number;
  num_rounds?: number;
  critic_prompt?: string;
  steps?: string[];
  enable_web_search?: boolean;
  enable_think_tool?: boolean;
  tools?: { name: string; description: string; parameters?: Record<string, unknown> }[];
}

export interface Agent {
  id: string;
  type: AgentType;
  description: string;
  input: string;
  depends_on: string[];
  custom_config?: CustomAgentConfig | null;
}

export interface Edge {
  source: string;
  target: string;
}

export interface Graph {
  agents: Agent[];
  edges: Edge[];
  answer_agent: string;
  direct_solution?: string | null;
}

export interface AgentState {
  id: string;
  status: AgentStatus;
  output?: string;
  error?: string;
}

export interface Plan {
  xml: string;
  graph: Graph;
  thinking: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  plan?: Plan;
}
