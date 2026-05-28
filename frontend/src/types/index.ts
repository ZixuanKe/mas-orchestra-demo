export type AgentType =
  | "CoTAgent" | "SCAgent" | "DebateAgent" | "ReflexionAgent"
  | "WebSearchAgent" | "ExtractAgent" | "CustomAgent"
  | "MCPAgent" | "EnterpriseExecutorAgent";
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
  { type: "ExtractAgent", description: "Pulls specific information (fields, numbers, dates, quotes) out of context — does not solve the task." },
];

/** Agent types surfaced in the LeftSidebar legend when enterprise mode is
 * selected. Each enterprise agent is an LLM that either wields one MCP tool
 * (MCPAgent — actual badge shown per agent is derived from the tool name,
 * e.g. CreateCalendarAgent) or synthesizes a final answer
 * (EnterpriseExecutorAgent). */
export const ENTERPRISE_AGENT_POOL: { type: string; description: string }[] = [
  { type: "MCPAgent", description: "An LLM that wields exactly one MCP tool. Each instance is named after its tool (e.g. CreateCalendarAgent, InsertAclRuleAgent)." },
  { type: "EnterpriseExecutorAgent", description: "Final summarizer LLM (no tools). Reads upstream agent outputs and writes the answer for the user." },
];

/** Convert a snake_case MCP tool name into a PascalCase Agent type label.
 * `create_calendar` → `CreateCalendarAgent`, `insert_acl_rule` → `InsertAclRuleAgent`.
 * `acl` stays uppercase for readability of common acronyms. */
const _ACRONYMS = new Set(["acl", "sql", "id", "url", "hr", "csm", "itsm"]);
function _pascal(word: string): string {
  if (_ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
export function toolToAgentLabel(toolName: string): string {
  const parts = toolName.split(/[_\s]+/).filter(Boolean);
  if (parts.length === 0) return "MCPAgent";
  return parts.map(_pascal).join("") + "Agent";
}

/** Display label for an agent in the graph / chat / sandbox. For MCPAgent
 * nodes the label is derived from their tool; everything else uses the raw
 * AgentType. */
export interface AgentLike {
  type: string;
  tool_name?: string | null;
}
export function displayAgentType(a: AgentLike): string {
  if (a.type === "MCPAgent" && a.tool_name) return toolToAgentLabel(a.tool_name);
  return a.type;
}
export type Dataset = "aime" | "hotpot" | "browsecomp" | "masbench";
export type Mode = "custom" | Dataset | "enterprise";
export type ModeGroup = "reasoning" | "enterprise";
export type Stage = "input" | "plan" | "execute" | "result";
export type SubagentModel = string;

export const DATASETS: { value: Dataset; label: string; dom: DomLevel }[] = [
  { value: "aime", label: "AIME 2024/2025 (Low)", dom: "low" },
  { value: "hotpot", label: "HotpotQA (High)", dom: "high" },
  { value: "browsecomp", label: "BrowseComp (High)", dom: "high" },
  { value: "masbench", label: "MASBench (Extensive)", dom: "high_extensive" },
];

export const MODES: { value: Mode; label: string }[] = [
  { value: "custom", label: "Custom Problem" },
  { value: "aime", label: "AIME 2024/2025" },
  { value: "hotpot", label: "HotpotQA" },
  { value: "browsecomp", label: "BrowseComp" },
  { value: "masbench", label: "MASBench" },
  { value: "enterprise", label: "EnterpriseOps" },
];

export const SUBAGENT_MODELS: { value: SubagentModel; label: string }[] = [
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini (Fast)" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini (General)" },
  { value: "gpt-5.5", label: "GPT-5.5 (Best)" },
];

/** Authenticated user profile returned by the backend after verifying
 *  a Google ID token. Mirrors the JSON payload from POST /auth/google.
 *  The full payload is cached in localStorage so the user stays
 *  signed-in across reloads without an extra round-trip to Google. */
export interface AuthUser {
  sub: string;
  email?: string;
  name: string;
  given_name?: string;
  picture?: string;
}

export interface DatasetSample {
  question: string;
  answer: string;
  /** MASBench only — reasoning family (breadth / combine / depth /
   *  horizon / parallel / robustness). Empty for legacy datasets. */
  axis?: string;
  /** MASBench only — per-row complexity bucket (e.g. "10", "12").
   *  Maps to the ``value`` column for most subsets and to
   *  ``extra_info_json.depth`` for ``combine``. */
  complexity?: string;
}

export interface MCPServer {
  server_label: string;
  server_url: string;
  headers?: Record<string, string> | null;
  require_approval?: "never" | "always";
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
  enable_code_interpreter?: boolean;
  mcp_servers?: MCPServer[] | null;
  tools?: { name: string; description: string; parameters?: Record<string, unknown> }[];
}

export interface SubagentConfig {
  system_prompt?: string;
  num_samples?: number;
  num_rounds?: number;
  critic_prompt?: string;
}

export interface Agent {
  id: string;
  type: AgentType;
  description: string;
  input: string;
  depends_on: string[];
  custom_config?: CustomAgentConfig | null;
  subagent_config?: SubagentConfig | null;
  tool_name?: string | null;
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
  isAnswer?: boolean;
  /** When present, this is an assistant turn rendering the result of a
   *  user-triggered verifier run for the latest enterprise execution. */
  verifierRun?: VerifierRunResponse;
  /** Non-fatal warning surfaced to the user (e.g. the vLLM planner failed
   *  and we degraded to a mock plan). Rendered as a yellow banner turn. */
  warning?: string;
  /** User-supplied thumbs-up/down annotation on this assistant turn. The
   *  annotation triggers a POST to /feedback/trajectory which persists
   *  the whole conversation + configs into mas_refine for offline use. */
  feedback?: "up" | "down" | null;
  /** Optional free-form comment captured alongside the rating. */
  feedbackComment?: string;
}

// ───────────────────────────────────────────── Enterprise mode

export interface EnterpriseDomain {
  name: string;
  label: string;
  icon: string;
  summary: string;
}

export interface EnterpriseTask {
  id: string;
  title: string;
  summary: string;
  domain: string;
  user_prompt: string;
  default_tools: string[];
  /** Number of oracle checks the task ships with. The frontend uses this
   *  to decide whether to surface the "Run verifier" affordance after a
   *  successful enterprise run. Comes from `EnterpriseTask.to_payload`. */
  verifier_count?: number;
  /** Hand-picked tasks float to the top of the picker and get a star badge.
   *  Set in `enterprise/tasks.py`'s `_FEATURED` map. */
  featured?: boolean;
}

export interface VerifierResult {
  name: string;
  description: string;
  query: string;
  expected: unknown;
  actual: unknown;
  comparison: string;
  passed: boolean;
  error: string | null;
}

export interface VerifierRunResponse {
  task_id: string;
  total: number;
  passed: number;
  results: VerifierResult[];
}

export interface ToolSummary {
  name: string;
  description: string;
}

export interface SandboxRow {
  id: string;
  values: Record<string, unknown>;
}

export interface SandboxTable {
  table: string;
  pk: string;
  columns: string[];
  rows: SandboxRow[];
}

export interface SandboxLink {
  source_table: string;
  source_id: string;
  target_table: string;
  target_id: string;
  label: string;
}

export interface SandboxSnapshot {
  domain: string;
  tables: SandboxTable[];
  links: SandboxLink[];
  phase?: "initial" | "final";
}

export type SandboxOp = "insert" | "update" | "delete";

export interface SandboxDiffEvent {
  table: string;
  op: SandboxOp;
  row_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed_columns: string[];
}

/** Classification of an MCPAgent step's effect on the sandbox. The backend
 *  emits this on every step (not just writes) so the panel can render a
 *  visible activity ribbon even when nothing mutated. */
export type SandboxOpKind = "write" | "read" | "noop" | "error";

export interface SandboxDiff {
  by_agent: string;
  tool_name: string | null;
  events: SandboxDiffEvent[];
  ts: number;
  /** What kind of effect this step had on the sandbox. Falls back to
   *  "write" when present diff events and "read" otherwise, for backwards
   *  compatibility with older event payloads. */
  op_kind?: SandboxOpKind;
  /** Curated table names this step is most likely to have touched. For
   *  writes this is derived from the diff events; for reads it's a
   *  best-effort guess from the tool name (e.g. ``list_events`` →
   *  ``events``). Empty when we can't guess. */
  affected_tables?: string[];
}

export interface ShareSnapshot {
  problem: string;
  dataset?: Dataset | null;
  dom?: DomLevel | null;
  subagent_model?: SubagentModel | null;
  expected_answer?: string | null;
  plan?: Plan | null;
  graph?: Graph | null;
  agent_states?: Record<string, AgentState>;
  final_answer?: string | null;
  chat_messages?: ChatMessage[];
  custom_agents?: CustomAgentConfig[];
  subagent_configs?: Record<string, SubagentConfig>;
  title?: string | null;
  created_at?: number;
  /** "enterprise" runs ship additional state so the read-only view can
   *  render the 5th column (sandbox graph + diffs) and the EnterprisePicker
   *  banner with the original task. Reasoning-mode shares simply omit the
   *  ``enterprise_*``/``sandbox_*`` fields. */
  mode?: "reasoning" | "enterprise";
  enterprise_task_id?: string | null;
  enterprise_task?: EnterpriseTask | null;
  enabled_tools?: string[];
  sandbox_snapshot?: SandboxSnapshot | null;
  sandbox_diffs?: SandboxDiff[];
  /** Google ``sub`` of the user who created this share. ``null`` for
   *  guest shares. Drives the per-user history list on the sidebar. */
  user_sub?: string | null;
}
