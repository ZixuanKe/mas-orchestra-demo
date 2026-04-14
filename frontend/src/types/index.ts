export type AgentType = "CoTAgent" | "SCAgent" | "DebateAgent" | "ReflexionAgent" | "WebSearchAgent";
export type AgentStatus = "pending" | "running" | "completed" | "failed";
export type DomLevel = "low" | "high";
export type Dataset = "aime" | "hotpot" | "browsecomp";
export type Stage = "input" | "plan" | "execute" | "result";
export type SubagentModel = "gpt-4.1-mini" | "gpt-4.1" | "o4-mini";

export const DATASETS: { value: Dataset; label: string; dom: DomLevel }[] = [
  { value: "aime", label: "AIME 2024/2025 (Low)", dom: "low" },
  { value: "hotpot", label: "HotpotQA (High)", dom: "high" },
  { value: "browsecomp", label: "BrowseComp (High)", dom: "high" },
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

export interface Agent {
  id: string;
  type: AgentType;
  description: string;
  input: string;
  depends_on: string[];
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
