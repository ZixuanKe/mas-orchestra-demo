import { useState, useCallback, useRef, useEffect } from "react";
import type { Graph, AgentState, Dataset, DomLevel, Plan, Stage, SubagentModel, CustomAgentConfig, SubagentConfig, ChatMessage, ShareSnapshot, EnterpriseTask, SandboxSnapshot, SandboxDiff, VerifierRunResponse } from "../types";
import { readStoredAuthUser } from "./useAuth";
import { track } from "../analytics";

/** Generate a session-stable trajectory id. crypto.randomUUID where
 *  available, with a Math.random fallback for old browsers. */
function _newTrajectoryId(): string {
  const cr = typeof crypto !== "undefined" ? crypto : undefined;
  if (cr && typeof (cr as Crypto).randomUUID === "function") {
    return `traj-${(cr as Crypto).randomUUID()}`;
  }
  const rnd = Math.random().toString(36).slice(2, 10);
  return `traj-${Date.now().toString(36)}-${rnd}`;
}

interface State {
  stage: Stage;
  problem: string;
  expectedAnswer: string;
  dataset: Dataset | null;
  dom: DomLevel;
  subagentModel: SubagentModel;
  plan: Plan | null;
  graph: Graph | null;
  agentStates: Record<string, AgentState>;
  finalAnswer: string | null;
  error: string | null;
  isLoading: boolean;
  isRefining: boolean;
  // Enterprise-mode runtime state
  enterpriseTaskId: string | null;
  enterpriseTask: EnterpriseTask | null;
  enabledTools: string[];
  sandboxSnapshot: SandboxSnapshot | null;
  sandboxDiffs: SandboxDiff[];
  sandboxStatus: string | null;
  // True while a user-triggered /enterprise/verify call is in flight.
  isVerifying: boolean;
}

const initial: State = {
  stage: "input",
  problem: "",
  expectedAnswer: "",
  dataset: null,
  dom: "high",
  subagentModel: "gpt-4.1-mini",
  plan: null,
  graph: null,
  agentStates: {},
  finalAnswer: null,
  error: null,
  isLoading: false,
  isRefining: false,
  enterpriseTaskId: null,
  enterpriseTask: null,
  enabledTools: [],
  sandboxSnapshot: null,
  sandboxDiffs: [],
  sandboxStatus: null,
  isVerifying: false,
};

interface Snapshot {
  plan: Plan;
  messages: ChatMessage[];
}

export function useOrchestration() {
  const [state, setState] = useState<State>(initial);
  const [customAgents, setCustomAgents] = useState<CustomAgentConfig[]>([]);
  const [subagentConfigs, setSubagentConfigs] = useState<Record<string, SubagentConfig>>({});
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const [pendingQueue, setPendingQueue] = useState<string[]>([]);
  // Stable id for THIS browser session's trajectory — so a thumbs-up
  // on turn 5 and a thumbs-down on turn 7 in the same chat are joined
  // by ``trajectory_id`` in mas_refine/trajectories.{csv,db}.
  // Reset by ``reset()`` so a fresh conversation gets its own id.
  const trajectoryIdRef = useRef<string>(_newTrajectoryId());

  // ── Auto-save / Recents wiring ─────────────────────────────────────
  // The id of the share record this conversation is being auto-saved
  // to. ``null`` until the first successful POST /share — after that
  // every meaningful turn upserts to the SAME id, so a single chat is
  // ONE row in the user's Recents rail (not one row per turn).
  //
  // Set by:
  //   • the first successful auto-save (backend allocates the id and we
  //     remember it for subsequent upserts)
  //   • a manual ``createShare()`` (the user clicked the Share button)
  //   • ``openHistoryItem(id)`` so continuing a loaded conversation
  //     keeps writing back to the same record (not a duplicate)
  //
  // Cleared by ``reset()`` so the next conversation gets a fresh id.
  const liveConversationIdRef = useRef<string | null>(null);
  // Mirrored as state so React components (App → LeftSidebar → Recents)
  // can re-render and highlight the active row.
  const [liveConversationId, setLiveConversationId] = useState<string | null>(null);
  // Bumped after every successful save (auto or manual). App.tsx watches
  // it to refetch the Recents list so the row's snippet/title stays in
  // sync as the conversation evolves.
  const [historyVersion, setHistoryVersion] = useState(0);
  // Debounce timer for auto-saves. We coalesce bursts of state changes
  // (chat append → plan update → final answer arrival) into a single
  // POST after the last burst settles, to avoid flooding the backend
  // during streaming.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while an auto-save POST is in flight — gates the debounced
  // trigger so we don't pile requests on a slow disk / large payload.
  const autoSavingRef = useRef(false);

  const abortRef = useRef<AbortController | null>(null);
  const refineAbortRef = useRef<AbortController | null>(null);

  // Keep customAgents in sync with the current plan's CustomAgent nodes.
  // Any CustomAgent in the plan that doesn't have a config yet gets one auto-created.
  useEffect(() => {
    const plan = state.plan;
    if (!plan) return;
    const planCustoms = plan.graph.agents.filter(a => a.type === "CustomAgent");
    if (planCustoms.length === 0) return;
    setCustomAgents(prev => {
      const existing = new Set(prev.map(c => c.name));
      const toAdd = planCustoms
        .filter(a => !existing.has(a.id))
        .map(a => {
          const desc = a.description.toLowerCase();
          return {
            name: a.id,
            strategy: (desc.includes("best of") || desc.includes("sample") || desc.includes("best-of") ? "multi_sample" : "single") as "single" | "multi_sample",
            system_prompt: a.description.replace(/^\w+:\s*/, ""),
            enable_web_search: desc.includes("search") || desc.includes("web") || desc.includes("lookup"),
            enable_think_tool: desc.includes("think") || desc.includes("reason") || desc.includes("verif"),
            enable_code_interpreter: desc.includes("python") || desc.includes("code") || desc.includes("calculator") || desc.includes("compute") || desc.includes("math") || desc.includes("numeric") || desc.includes("data analys"),
          };
        });
      return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
    });
  }, [state.plan]);

  // Refs for fresh reads in stable callbacks
  const undoRef = useRef(undoStack);
  undoRef.current = undoStack;
  const redoRef = useRef(redoStack);
  redoRef.current = redoStack;
  const stateRef = useRef(state);
  stateRef.current = state;
  const msgsRef = useRef(chatMessages);
  msgsRef.current = chatMessages;

  /** Preview the sandbox for a task BEFORE designing a plan. Fetches
   * `/enterprise/snapshot/{id}` (backed by the same cache as /plan) and
   * sets `sandboxSnapshot` so the 5th column shows the live world. Safe
   * to call repeatedly as the user clicks between task cards.
   */
  const previewEnterpriseTask = useCallback(async (task: EnterpriseTask) => {
    // Don't disrupt an in-flight execution.
    if (stateRef.current.stage === "execute" && stateRef.current.isLoading) return;
    // Optimistically remember the task + clear any prior diffs so the panel
    // doesn't show changes that belong to a different task.
    setState(s => ({
      ...s,
      enterpriseTask: task,
      sandboxStatus: "Loading sandbox…",
      sandboxDiffs: [],
    }));
    try {
      const res = await fetch(`/enterprise/snapshot/${encodeURIComponent(task.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap: SandboxSnapshot = await res.json();
      // Only apply if the user is still looking at this task — race-safe.
      setState(s => s.enterpriseTask?.id === task.id
        ? { ...s, sandboxSnapshot: snap, sandboxStatus: null }
        : s);
    } catch (err) {
      // Swallow aborted fetches (user clicked a different task / switched
      // modes mid-flight). Browsers surface those as either an AbortError
      // or "TypeError: Failed to fetch" and they're benign.
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = (err instanceof DOMException && err.name === "AbortError")
        || /aborted|abort|Failed to fetch|NetworkError/i.test(msg);
      if (aborted) return;
      setState(s => s.enterpriseTask?.id === task.id
        ? { ...s, sandboxStatus: `Sandbox preview failed: ${msg}` }
        : s);
    }
  }, []);

  /** Run the task's oracle verifiers against the post-run sandbox. Appends
   *  an assistant message carrying ``verifierRun`` so the chat preserves
   *  the result (and the share snapshot picks it up automatically). Safe
   *  to call multiple times; each click appends a fresh report. */
  const runVerifier = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.enterpriseTaskId) return;
    if (cur.isVerifying) return;
    setState(s => ({ ...s, isVerifying: true, error: null }));
    try {
      const res = await fetch("/enterprise/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: cur.enterpriseTaskId }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data: VerifierRunResponse = await res.json();
      const summary = `Verifier: ${data.passed}/${data.total} checks passed.`;
      setChatMessages(prev => [
        ...prev,
        { role: "assistant", content: summary, verifierRun: data },
      ]);
    } catch (err) {
      setChatMessages(prev => [
        ...prev,
        { role: "assistant", content: `Verifier failed to run: ${err}` },
      ]);
    } finally {
      setState(s => ({ ...s, isVerifying: false }));
    }
  }, []);

  /** Preview the sandbox for a DOMAIN without a specific task — fired
   *  the moment the user picks a domain in the EnterprisePicker, so the
   *  5th column AppView appears immediately and the user can see what
   *  the environment looks like before writing any query.
   *
   *  Uses the first oracle task in the domain to seed a representative
   *  sandbox (cached per-domain server-side). Safe to call repeatedly. */
  const previewEnterpriseDomain = useCallback(async (domain: string) => {
    if (stateRef.current.stage === "execute" && stateRef.current.isLoading) return;
    // Don't clobber a task-specific preview that the user has already
    // triggered for this same domain — task-level snapshots are richer
    // (specific seed) and we don't want to flicker back to the generic
    // domain template.
    const cur = stateRef.current;
    if (cur.enterpriseTask?.domain === domain && cur.sandboxSnapshot) return;
    setState(s => ({
      ...s,
      enterpriseTask: null,
      sandboxStatus: "Loading sandbox…",
      sandboxDiffs: [],
    }));
    try {
      const res = await fetch(`/enterprise/preview-snapshot/${encodeURIComponent(domain)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap: SandboxSnapshot = await res.json();
      setState(s => (
        // Race-safe: only apply if no task-level preview happened in the
        // meantime AND the user hasn't switched away to a different domain.
        (!s.enterpriseTask && snap.domain === domain)
          ? { ...s, sandboxSnapshot: snap, sandboxStatus: null }
          : s
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = (err instanceof DOMException && err.name === "AbortError")
        || /aborted|abort|Failed to fetch|NetworkError/i.test(msg);
      if (aborted) return;
      setState(s => ({ ...s, sandboxStatus: `Sandbox preview failed: ${msg}` }));
    }
  }, []);

  /** Clear sandbox preview state — call when the user switches away from
   *  enterprise mode so the 5th column doesn't linger. */
  const clearSandboxPreview = useCallback(() => {
    setState(s => ({
      ...s, enterpriseTask: null, sandboxSnapshot: null,
      sandboxDiffs: [], sandboxStatus: null,
    }));
  }, []);

  const generateEnterprisePlan = useCallback(async (task: EnterpriseTask, enabledTools: string[], dom: DomLevel = "high") => {
    setState(s => ({
      ...s,
      problem: task.user_prompt,
      dataset: null,
      dom,
      isLoading: true,
      error: null,
      enterpriseTaskId: task.id,
      enterpriseTask: task,
      enabledTools,
      // Preserve the preview snapshot fetched by ``previewEnterpriseTask``
      // when the user picked this task — keeps the 5th sandbox column
      // visible during planning instead of blanking it out. We only reset
      // run-side state (diffs / status). When the planner responds we
      // overwrite ``sandboxSnapshot`` with ``initial_snapshot`` from the
      // backend (which is the authoritative "before" view for the run).
      sandboxDiffs: [],
      sandboxStatus: null,
    }));
    setChatMessages([]);
    setUndoStack([]);
    setRedoStack([]);
    track("plan_generated", { mode: "enterprise", domain: task.domain, dom, problem_length: task.user_prompt.length });
    try {
      const res = await fetch("/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problem: task.user_prompt,
          enterprise_task_id: task.id,
          enabled_tools: enabledTools,
          subagent_model: stateRef.current.subagentModel,
          dom,
        }),
      });
      if (!res.ok) throw new Error(`Plan failed: ${res.status}`);
      const planResp: Plan & { initial_snapshot?: SandboxSnapshot | null; warning?: string | null } = await res.json();
      const { initial_snapshot, warning, ...plan } = planResp;
      const agentStates = Object.fromEntries(plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
      const introMessage: ChatMessage = {
        role: "assistant",
        content: plan.thinking
          ? `Enterprise plan ready: ${plan.graph.agents.length} agents.\n\n${plan.thinking}`
          : `Enterprise plan ready: ${plan.graph.agents.length} agents.`,
        plan,
      };
      const msgs: ChatMessage[] = [{ role: "user", content: task.user_prompt }];
      if (warning) msgs.push({ role: "assistant", content: warning, warning });
      msgs.push(introMessage);
      setChatMessages(msgs);
      setCustomAgents([]);
      setState(s => ({
        ...s, stage: "plan", plan, graph: plan.graph, agentStates,
        finalAnswer: null, isLoading: false,
        // Surface the seeded sandbox right after planning so the user can
        // study the "before" state before clicking Run. Fall back to the
        // preview snapshot if the planner didn't return one — keeps the
        // 5th column populated rather than collapsing it.
        sandboxSnapshot: initial_snapshot ?? s.sandboxSnapshot,
      }));
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isLoading: false }));
    }
  }, []);

  const generatePlan = useCallback(async (problem: string, dataset: Dataset | null, dom: DomLevel, expectedAnswer: string) => {
    setState(s => ({ ...s, problem, dataset, dom, expectedAnswer, isLoading: true, error: null }));
    setChatMessages([]);
    setUndoStack([]);
    setRedoStack([]);
    track("plan_generated", { mode: dataset ?? "custom", dom, problem_length: problem.length });
    try {
      // Reasoning datasets are pinned to their training DoM by the
      // backend via DATASET_META, so the body just needs ``dataset``.
      // Custom problems (no dataset) honor the user's DoM toggle.
      const body = dataset ? { problem, dataset } : { problem, dom };
      const res = await fetch("/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Plan failed: ${res.status}`);
      const planResp: Plan & { warning?: string | null } = await res.json();
      const { warning, ...plan } = planResp;
      const agentStates = Object.fromEntries(plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
      const introMessage: ChatMessage = {
        role: "assistant",
        content: plan.thinking
          ? `Here's the plan. ${plan.graph.agents.length} agents designed.\n\n${plan.thinking}`
          : `Plan generated with ${plan.graph.agents.length} agents. You can refine it by chatting below.`,
        plan,
      };
      const msgs: ChatMessage[] = [{ role: "user", content: problem }];
      // Surface planner warnings (vLLM down → mock fallback, etc.) before
      // the plan turn so the user sees them right at the top.
      if (warning) msgs.push({ role: "assistant", content: warning, warning });
      msgs.push(introMessage);
      setChatMessages(msgs);
      setCustomAgents([]);
      setState(s => ({ ...s, stage: "plan", plan, graph: plan.graph, agentStates, finalAnswer: plan.graph.direct_solution || null, isLoading: false }));
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isLoading: false }));
    }
  }, []);

  const executePlan = useCallback(async () => {
    if (!state.plan) return;
    track("execute_started", { agent_count: state.plan.graph.agents.length, subagent_model: state.subagentModel });
    const freshStates = Object.fromEntries(
      state.plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }])
    );
    setState(s => ({
      ...s, stage: "execute", isLoading: true, error: null,
      agentStates: freshStates, finalAnswer: null,
      // Keep the pre-run sandbox snapshot visible; the backend will
      // overwrite it with a fresh post-seed snapshot in a moment. Reset
      // diffs so they don't carry over from a previous run.
      sandboxDiffs: [], sandboxStatus: null,
    }));

    // Attach custom configs to CustomAgent nodes + subagent_configs to built-in nodes
    const graphToSend = { ...state.plan.graph };
    graphToSend.agents = graphToSend.agents.map(a => {
      let next = a;
      if (a.type === "CustomAgent" && !a.custom_config && customAgents.length > 0) {
        const match = customAgents.find(c =>
          a.description.toLowerCase().includes(c.name.toLowerCase()) ||
          a.id.toLowerCase().includes(c.name.toLowerCase().replace("agent", ""))
        );
        const cfg = match || (customAgents.length === 1 ? customAgents[0] : null);
        if (cfg) next = { ...next, custom_config: cfg };
      }
      const sc = subagentConfigs[a.id];
      if (sc && a.type !== "CustomAgent") next = { ...next, subagent_config: sc };
      return next;
    });

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const body: Record<string, unknown> = {
        problem: state.problem, graph: graphToSend, subagent_model: state.subagentModel,
      };
      if (state.enterpriseTaskId) body.enterprise_task_id = state.enterpriseTaskId;
      const res = await fetch("/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`Execute failed: ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      // sse_starlette streams `event: <name>\ndata: <json>\n\n` blocks. We
      // track the most recent event name so we can route enterprise events
      // (sandbox_snapshot, sandbox_diff, status) without inferring from shape.
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith("data:")) continue;
          const data = JSON.parse(line.slice(5).trim());

          // Enterprise events first (event-name dispatch is more reliable).
          if (currentEvent === "sandbox_snapshot") {
            setState(s => ({ ...s, sandboxSnapshot: data as SandboxSnapshot }));
            continue;
          }
          if (currentEvent === "sandbox_diff") {
            const diff: SandboxDiff = { ...data, ts: Date.now() };
            setState(s => ({ ...s, sandboxDiffs: [...s.sandboxDiffs, diff] }));
            continue;
          }
          if (currentEvent === "status") {
            setState(s => ({ ...s, sandboxStatus: data?.message ?? null }));
            continue;
          }

          // Existing reasoning-mode dispatch by data shape.
          if (data.agentId && !data.output && !data.error) {
            setState(s => ({ ...s, agentStates: { ...s.agentStates, [data.agentId]: { id: data.agentId, status: "running" } } }));
          } else if (data.agentId && data.output) {
            setState(s => ({ ...s, agentStates: { ...s.agentStates, [data.agentId]: { id: data.agentId, status: "completed", output: data.output } } }));
          } else if (data.agentId && data.error) {
            setState(s => ({ ...s, agentStates: { ...s.agentStates, [data.agentId]: { id: data.agentId, status: "failed", error: data.error } } }));
          } else if (data.answer) {
            setState(s => ({ ...s, stage: "result", finalAnswer: data.answer, isLoading: false }));
            setChatMessages(prev => [...prev, { role: "assistant", content: data.answer, isAnswer: true }]);
          } else if (data.message) {
            setState(s => ({ ...s, error: data.message }));
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        // cancel handler already reset state — nothing to do here
      } else {
        setState(s => ({ ...s, error: String(err), isLoading: false }));
      }
    } finally {
      abortRef.current = null;
    }
  }, [state.plan, state.problem, state.subagentModel, state.enterpriseTaskId, customAgents, subagentConfigs]);

  const cancelExecution = useCallback(() => {
    abortRef.current?.abort();
    setState(s => {
      // Revert stage back to "plan" so Execute re-appears.
      // Flip any in-flight "running" agents back to "pending" so chips stop pulsing.
      const resetStates = Object.fromEntries(
        Object.entries(s.agentStates).map(([id, st]) => [
          id,
          st.status === "running" ? { ...st, status: "pending" as const } : st,
        ])
      );
      return { ...s, stage: "plan", isLoading: false, agentStates: resetStates };
    });
  }, []);

  const refinePlan = useCallback(async (userMessage: string) => {
    if (!state.plan) return;

    const snapshot: Snapshot = { plan: state.plan, messages: [...chatMessages] };

    const userMsg: ChatMessage = { role: "user", content: userMessage };
    const updatedMessages = [...chatMessages, userMsg];
    setChatMessages(updatedMessages);
    setState(s => ({ ...s, isRefining: true, error: null }));
    track("plan_refined", { message_length: userMessage.length });

    const abort = new AbortController();
    refineAbortRef.current = abort;

    try {
      const apiMessages = updatedMessages.map(m => ({ role: m.role, content: m.content }));

      const refineBody: Record<string, unknown> = {
        problem: state.problem,
        current_xml: state.plan.xml,
        messages: apiMessages,
        dom: state.dom,
        custom_agents: customAgents,
      };
      // Enterprise-mode refinement: tell the backend which gym task we're
      // refining so it routes to the enterprise refiner (MCPAgent schema,
      // gym tool catalog, gym system/user prompts). Reasoning-mode refine
      // requests omit both fields and behave exactly as before.
      if (state.enterpriseTaskId) {
        refineBody.enterprise_task_id = state.enterpriseTaskId;
        refineBody.enabled_tools = state.enabledTools;
      }
      const res = await fetch("/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(refineBody),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`Refine failed: ${res.status}`);
      const data = await res.json();

      const assistantMsg: ChatMessage = { role: "assistant", content: data.message };

      if (data.graph && data.graph.agents && data.graph.agents.length > 0) {
        setUndoStack(prev => [...prev, snapshot]);
        setRedoStack([]);
        const plan: Plan = { xml: data.xml, graph: data.graph, thinking: data.thinking };
        assistantMsg.plan = plan;
        const agentStates = Object.fromEntries(plan.graph.agents.map((a: { id: string }) => [a.id, { id: a.id, status: "pending" as const }]));
        setState(s => ({ ...s, plan, graph: plan.graph, agentStates, finalAnswer: plan.graph.direct_solution || null, isRefining: false }));
      } else {
        setState(s => ({ ...s, isRefining: false }));
      }

      setChatMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      if (abort.signal.aborted) {
        // Roll back: remove the optimistic user message, clear refining state
        setChatMessages(prev => prev.filter(m => m !== userMsg));
        setState(s => ({ ...s, isRefining: false }));
      } else {
        setState(s => ({ ...s, error: String(err), isRefining: false }));
      }
    } finally {
      if (refineAbortRef.current === abort) refineAbortRef.current = null;
    }
  }, [state.plan, state.problem, state.dom, state.enterpriseTaskId, state.enabledTools, customAgents, chatMessages]);

  const cancelRefine = useCallback(() => {
    refineAbortRef.current?.abort();
  }, []);

  const designAgent = useCallback(async (description: string) => {
    const userMsg: ChatMessage = { role: "user", content: `Design agent: ${description}` };
    setChatMessages(prev => [...prev, userMsg]);
    setState(s => ({ ...s, isRefining: true }));
    try {
      const res = await fetch("/design-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      if (!res.ok) throw new Error(`Design failed: ${res.status}`);
      const config: CustomAgentConfig = await res.json();
      setCustomAgents(prev => [...prev, config]);
      track("agent_designed", { name: config.name, strategy: config.strategy });
      const toolsInfo = [
        config.enable_web_search && "web search",
        config.enable_think_tool && "think tool",
        config.enable_code_interpreter && "code interpreter",
      ].filter(Boolean);
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: `Designed **${config.name}** (${config.strategy}${toolsInfo.length ? ` + ${toolsInfo.join(", ")}` : ""}). You can configure it in the panel below the graph.`,
      };
      setChatMessages(prev => [...prev, assistantMsg]);
      setState(s => ({ ...s, isRefining: false }));
      return config;
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isRefining: false }));
      return null;
    }
  }, []);

  const removeCustomAgent = useCallback((name: string) => {
    setCustomAgents(prev => prev.filter(a => a.name !== name));
  }, []);

  const updateCustomAgent = useCallback((name: string, updates: Partial<CustomAgentConfig>) => {
    setCustomAgents(prev => prev.map(a => a.name === name ? { ...a, ...updates } : a));
  }, []);

  const updateSubagentConfig = useCallback((agentId: string, updates: Partial<SubagentConfig>) => {
    setSubagentConfigs(prev => ({ ...prev, [agentId]: { ...(prev[agentId] || {}), ...updates } }));
  }, []);

  const undoPlan = useCallback(() => {
    const stack = undoRef.current;
    const cur = stateRef.current;
    const curMsgs = msgsRef.current;
    if (stack.length === 0 || !cur.plan) return false;
    if (cur.isRefining || cur.isLoading || cur.stage === "execute") return false;

    setRedoStack(r => [...r, { plan: cur.plan!, messages: curMsgs }]);

    const prev = stack[stack.length - 1];
    setUndoStack(stack.slice(0, -1));
    setChatMessages(prev.messages);
    const agentStates = Object.fromEntries(prev.plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
    setState(s => ({ ...s, plan: prev.plan, graph: prev.plan.graph, agentStates, finalAnswer: prev.plan.graph.direct_solution || null }));
    return true;
  }, []);

  const redoPlan = useCallback(() => {
    const stack = redoRef.current;
    const cur = stateRef.current;
    const curMsgs = msgsRef.current;
    if (stack.length === 0 || !cur.plan) return false;
    if (cur.isRefining || cur.isLoading || cur.stage === "execute") return false;

    setUndoStack(u => [...u, { plan: cur.plan!, messages: curMsgs }]);

    const next = stack[stack.length - 1];
    setRedoStack(stack.slice(0, -1));
    setChatMessages(next.messages);
    const agentStates = Object.fromEntries(next.plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
    setState(s => ({ ...s, plan: next.plan, graph: next.plan.graph, agentStates, finalAnswer: next.plan.graph.direct_solution || null }));
    return true;
  }, []);

  const switchToPlan = useCallback((newPlan: Plan) => {
    const cur = stateRef.current;
    if (!cur.plan) return;
    // Don't clobber an in-flight refine or execution
    if (cur.isRefining || cur.isLoading || cur.stage === "execute") return;
    const curMsgs = msgsRef.current;
    setUndoStack(prev => [...prev, { plan: cur.plan!, messages: curMsgs }]);
    setRedoStack([]);
    const agentStates = Object.fromEntries(newPlan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
    setState(s => ({ ...s, plan: newPlan, graph: newPlan.graph, agentStates, finalAnswer: newPlan.graph.direct_solution || null }));
  }, []);

  const setSubagentModel = useCallback((subagentModel: SubagentModel) => setState(s => ({ ...s, subagentModel })), []);
  const goToStage = useCallback((stage: Stage) => setState(s => ({ ...s, stage, error: null })), []);
  const reset = useCallback(() => {
    setState(initial);
    setChatMessages([]);
    setUndoStack([]);
    setRedoStack([]);
    setSubagentConfigs({});
    setPendingQueue([]);
    trajectoryIdRef.current = _newTrajectoryId();
    // A reset starts a brand-new chat — drop the live conversation id so
    // the next auto-save creates a fresh Recents row (rather than
    // overwriting the prior chat with an empty snapshot).
    liveConversationIdRef.current = null;
    setLiveConversationId(null);
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  /** User clicked thumbs-up / thumbs-down (or added a comment) on an
   *  assistant turn. Updates local state, then POSTs the FULL chat +
   *  configs to /feedback/trajectory so the offline pipeline at
   *  mas_refine/trajectories.{csv,db} has everything it needs.
   *
   *  Pass ``feedback: null`` to clear a previous rating (we still POST
   *  so the persisted store reflects the withdrawal — easier to filter
   *  in the future than re-deriving the latest state per turn). */
  const setMessageFeedback = useCallback(async (
    turnIndex: number,
    feedback: "up" | "down" | null,
    comment?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const cur = stateRef.current;
    const msgs = msgsRef.current;
    if (turnIndex < 0 || turnIndex >= msgs.length) return { ok: false, error: "Invalid turn index" };
    const target = msgs[turnIndex];
    if (target.role !== "assistant") return { ok: false, error: "Not an assistant turn" };

    // Optimistic local update so the thumb fills instantly.
    setChatMessages(prev => prev.map((m, i) => i === turnIndex
      ? { ...m, feedback, feedbackComment: feedback ? (comment ?? m.feedbackComment ?? "") : "" }
      : m
    ));

    // Withdrawing a rating still persists (so the future pipeline can
    // see the user changed their mind), but the rating is normalized
    // to "down" with comment "[withdrawn]" — keeps the schema simple
    // (rating is NOT NULL) without losing the signal. If we ever want
    // to filter these out we just match comment === "[withdrawn]".
    const persistRating: "up" | "down" = feedback ?? "down";
    const persistComment = feedback ? (comment ?? "") : "[withdrawn]";
    // Coarse turn-kind tag so the offline pipeline can filter plan
    // ratings vs answer ratings without re-parsing conversation_history.
    const turnKind: string =
      target.plan ? "plan"
      : target.isAnswer ? "answer"
      : target.verifierRun ? "verifier"
      : target.warning ? "warning"
      : "other";
    // ``answer`` column captures the meaningful artifact the user rated.
    // For plan turns that's the planner XML (the chat content is just
    // a one-liner like "Plan ready: 3 agents"). For everything else the
    // chat content IS the rated artifact.
    const persistAnswer: string = target.plan?.xml || target.content || "";

    // Read the signed-in user (if any) at submit time so the
    // annotation row in mas_refine/trajectories.{csv,db} carries
    // ``user_sub`` for downstream JOINs. Guests submit with sub=null.
    const authedUser = readStoredAuthUser();

    try {
      const res = await fetch("/feedback/trajectory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trajectory_id: trajectoryIdRef.current,
          turn_index: turnIndex,
          turn_kind: turnKind,
          rating: persistRating,
          comment: persistComment,
          mode: cur.dataset || (cur.enterpriseTaskId ? "enterprise" : "custom"),
          dom: cur.dom,
          subagent_model: cur.subagentModel,
          enterprise_task_id: cur.enterpriseTaskId,
          enterprise_domain: cur.enterpriseTask?.domain,
          problem: cur.problem,
          answer: persistAnswer,
          agent_count: cur.plan?.graph?.agents?.length ?? null,
          verifier_total: target.verifierRun?.total ?? null,
          verifier_passed: target.verifierRun?.passed ?? null,
          user_sub: authedUser?.sub ?? null,
          user_email: authedUser?.email ?? null,
          user_name: authedUser?.name ?? null,
          // FULL untruncated chat history — DO NOT shorten. Used for
          // SFT/DPO datasets downstream.
          conversation_history: msgs.map((m, i) => ({
            index: i,
            role: m.role,
            content: m.content,
            is_answer: !!m.isAnswer,
            warning: m.warning,
            plan: m.plan ?? null,
            verifier_run: m.verifierRun ?? null,
            feedback: i === turnIndex ? feedback : (m.feedback ?? null),
            feedback_comment: i === turnIndex ? (feedback ? (comment ?? "") : "") : (m.feedbackComment ?? ""),
          })),
          configs: {
            subagent_model: cur.subagentModel,
            dom: cur.dom,
            dataset: cur.dataset,
            problem: cur.problem,
            expected_answer: cur.expectedAnswer,
            enterprise_task_id: cur.enterpriseTaskId,
            enterprise_task: cur.enterpriseTask,
            enabled_tools: cur.enabledTools,
            stage: cur.stage,
            subagent_configs: subagentConfigs,
            custom_agents: customAgents,
          },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => `HTTP ${res.status}`);
        return { ok: false, error: detail || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  // We deliberately don't depend on chatMessages/state directly — the
  // refs read fresh values on every call, which avoids stale-closure
  // races during a rapid click sequence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentConfigs, customAgents]);

  /** Build the share payload from current state. Shared by the manual
   *  share button (no id supplied; backend allocates) and the auto-save
   *  loop (existing id supplied; backend upserts). Kept in one place so
   *  enterprise/reasoning field handling stays consistent. */
  const _buildShareSnapshot = useCallback((includeId: string | null): ShareSnapshot & { id?: string } => {
    const cur = stateRef.current;
    const isEnterprise = !!cur.enterpriseTaskId;
    const authedUser = readStoredAuthUser();
    const snap: ShareSnapshot & { id?: string } = {
      problem: cur.problem,
      dataset: cur.dataset,
      dom: cur.dom,
      subagent_model: cur.subagentModel,
      expected_answer: cur.expectedAnswer || null,
      plan: cur.plan,
      graph: cur.graph,
      agent_states: cur.agentStates,
      final_answer: cur.finalAnswer,
      chat_messages: msgsRef.current,
      custom_agents: customAgents,
      subagent_configs: subagentConfigs,
      mode: isEnterprise ? "enterprise" : "reasoning",
      user_sub: authedUser?.sub ?? null,
      ...(isEnterprise
        ? {
            enterprise_task_id: cur.enterpriseTaskId,
            enterprise_task: cur.enterpriseTask,
            enabled_tools: cur.enabledTools,
            sandbox_snapshot: cur.sandboxSnapshot,
            sandbox_diffs: cur.sandboxDiffs,
          }
        : {}),
    };
    if (includeId) snap.id = includeId;
    return snap;
  }, [customAgents, subagentConfigs]);

  const createShare = useCallback(async (): Promise<{ id: string; url: string } | null> => {
    const cur = stateRef.current;
    // Reuse the live id so a manual "Share" click resolves to the same
    // record we've been auto-saving to — the public link === the
    // user's Recents row. If no auto-save has happened yet (e.g. guest
    // session or instant manual share), let the backend allocate one
    // and adopt it as the live id for any later auto-saves.
    const reuseId = liveConversationIdRef.current;
    const snapshot = _buildShareSnapshot(reuseId);
    try {
      const res = await fetch("/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) {
        let detail = `${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
        throw new Error(`Share failed: ${detail}`);
      }
      const data: { id: string; url?: string; created_at: number } = await res.json();
      // Trust the backend-computed URL (it knows the public hostname when behind
      // a tunnel). Fall back to the current origin only if the backend didn't
      // provide one, so dev/local setups still work.
      const url = data.url || `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(data.id)}`;
      // Adopt this id as the conversation's live id so subsequent
      // auto-saves keep upserting to it rather than spawning a sibling.
      if (liveConversationIdRef.current !== data.id) {
        liveConversationIdRef.current = data.id;
        setLiveConversationId(data.id);
      }
      setHistoryVersion(v => v + 1);
      track("share_created", { has_plan: !!cur.plan, has_answer: !!cur.finalAnswer, agent_count: cur.plan?.graph.agents.length ?? 0 });
      return { id: data.id, url };
    } catch (err) {
      setState(s => ({ ...s, error: String(err) }));
      return null;
    }
  }, [_buildShareSnapshot]);

  /** Silently upsert the current conversation to the user's history.
   *  No UI surface — failures are swallowed (we never want a transient
   *  /share hiccup to interrupt the user's chat). Returns the resolved
   *  share id on success, or null on any skip/failure.
   *
   *  Gating rules:
   *    • Guests (no user sub) — skip; history is per-user.
   *    • Read-only "?share=" mode — skip; we're viewing, not authoring.
   *    • Empty workspaces (no chat messages) — skip; nothing to save.
   *    • An auto-save already in flight — skip; a fresh debounce tick
   *      will fire after the current one resolves.
   */
  const _autoSaveConversation = useCallback(async (): Promise<string | null> => {
    const cur = stateRef.current;
    const authedUser = readStoredAuthUser();
    if (!authedUser?.sub) return null;
    if (msgsRef.current.length === 0) return null;
    if (autoSavingRef.current) return null;
    const reuseId = liveConversationIdRef.current;
    const snapshot = _buildShareSnapshot(reuseId);
    autoSavingRef.current = true;
    try {
      const res = await fetch("/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) return null;
      const data: { id: string; created_at: number } = await res.json();
      if (liveConversationIdRef.current !== data.id) {
        liveConversationIdRef.current = data.id;
        setLiveConversationId(data.id);
      }
      setHistoryVersion(v => v + 1);
      return data.id;
    } catch {
      return null;
    } finally {
      autoSavingRef.current = false;
    }
    // ``cur`` is read for type-narrowing only; eslint isn't sure.
    void cur;
  }, [_buildShareSnapshot]);

  // Schedule a debounced auto-save whenever any state that should be
  // reflected in Recents changes. We coalesce bursts (e.g. streaming
  // execution emits dozens of agentState updates per second) into a
  // single POST 2s after the last change. The "?share=" read-only
  // viewer and the empty workspace short-circuit inside the saver.
  const autoSaveRef = useRef(_autoSaveConversation);
  autoSaveRef.current = _autoSaveConversation;
  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    autoSaveTimerRef.current = setTimeout(() => {
      void autoSaveRef.current();
    }, 2000);
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
    // We intentionally exclude state.agentStates from the deps — it
    // changes far too often during streaming and the eventual ``stage``
    // / ``finalAnswer`` transitions already trip a save at the natural
    // boundaries (plan ready, run complete, refinement returned).
  }, [chatMessages, state.plan, state.finalAnswer, state.stage, state.problem,
      state.dataset, state.dom, state.subagentModel, state.enterpriseTaskId,
      state.sandboxDiffs.length, customAgents, subagentConfigs]);

  const loadShare = useCallback(async (shareId: string): Promise<boolean> => {
    setState(s => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await fetch(`/share/${encodeURIComponent(shareId)}`);
      if (!res.ok) {
        let detail = `${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
        throw new Error(`Could not load shared conversation: ${detail}`);
      }
      const snap: ShareSnapshot = await res.json();
      setCustomAgents(snap.custom_agents ?? []);
      setSubagentConfigs(snap.subagent_configs ?? {});
      setChatMessages(snap.chat_messages ?? []);
      setUndoStack([]);
      setRedoStack([]);
      setPendingQueue([]);
      setState(s => ({
        ...s,
        problem: snap.problem,
        dataset: (snap.dataset as Dataset | null) ?? null,
        dom: (snap.dom as DomLevel | undefined) ?? "high",
        subagentModel: (snap.subagent_model as SubagentModel | undefined) ?? s.subagentModel,
        expectedAnswer: snap.expected_answer ?? "",
        plan: snap.plan ?? null,
        graph: snap.graph ?? null,
        agentStates: snap.agent_states ?? {},
        finalAnswer: snap.final_answer ?? null,
        stage: snap.final_answer ? "result" : (snap.plan ? "plan" : "input"),
        isLoading: false,
        isRefining: false,
        // Enterprise replay payload. ``mode === "enterprise"`` OR the
        // presence of an ``enterprise_task_id`` is enough to tell the UI
        // to render the EnterprisePicker context + the 5th-column sandbox.
        enterpriseTaskId: snap.enterprise_task_id ?? null,
        enterpriseTask: snap.enterprise_task ?? null,
        enabledTools: snap.enabled_tools ?? [],
        sandboxSnapshot: snap.sandbox_snapshot ?? null,
        sandboxDiffs: snap.sandbox_diffs ?? [],
        sandboxStatus: null,
      }));
      track("share_loaded", { id: shareId });
      return true;
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isLoading: false }));
      return false;
    }
  }, []);

  const queueRefine = useCallback((text: string) => {
    const v = text.trim();
    if (!v) return;
    setPendingQueue(q => [...q, v]);
  }, []);
  const editQueued = useCallback((idx: number, text: string) => {
    setPendingQueue(q => q.map((v, i) => i === idx ? text : v));
  }, []);
  const removeQueued = useCallback((idx: number) => {
    setPendingQueue(q => q.filter((_, i) => i !== idx));
  }, []);

  // Auto-fire the next queued message whenever we go idle
  const refineRef = useRef(refinePlan);
  refineRef.current = refinePlan;
  useEffect(() => {
    if (pendingQueue.length === 0) return;
    if (state.isLoading || state.isRefining) return;
    if (state.stage === "execute") return;
    if (!state.plan) return;
    const next = pendingQueue[0];
    setPendingQueue(q => q.slice(1));
    refineRef.current(next);
  }, [pendingQueue, state.isLoading, state.isRefining, state.stage, state.plan]);

  // Read-only "shared conversation" mode is set when the page loads with ?share=<id>.
  const [isShared, setIsShared] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has("share");
  });
  const loadShareRef = useRef(loadShare);
  loadShareRef.current = loadShare;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sid = new URLSearchParams(window.location.search).get("share");
    if (!sid) return;
    setIsShared(true);
    loadShareRef.current(sid);
  }, []);

  /** Load a conversation from the user's history into the *editable*
   *  workspace (NOT read-only "shared" mode). Used by the Recents
   *  rail on the left sidebar. Clears the ?share= URL param so a
   *  reload doesn't snap back to read-only.
   *
   *  Returns the same boolean as loadShare so the caller can show a
   *  toast on failure. */
  const openHistoryItem = useCallback(async (shareId: string): Promise<boolean> => {
    setIsShared(false);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.has("share")) {
        params.delete("share");
        const next = `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}${window.location.hash}`;
        window.history.replaceState({}, "", next);
      }
    }
    const ok = await loadShare(shareId);
    if (ok) {
      // Continuing this conversation should upsert back to the SAME
      // share record (so refining a loaded chat doesn't spawn a sibling
      // row in Recents). New trajectory id though — annotations on a
      // continued chat belong to a new trajectory, conceptually.
      liveConversationIdRef.current = shareId;
      setLiveConversationId(shareId);
      trajectoryIdRef.current = _newTrajectoryId();
    }
    return ok;
  }, [loadShare]);

  const exitSharedMode = useCallback(() => {
    setIsShared(false);
    setState(initial);
    setChatMessages([]);
    setUndoStack([]);
    setRedoStack([]);
    setSubagentConfigs({});
    setCustomAgents([]);
    setPendingQueue([]);
    // Detach from the viewed share — exiting "shared" mode lands on a
    // blank workspace, not a continued edit of someone else's share.
    liveConversationIdRef.current = null;
    setLiveConversationId(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("share");
      window.history.replaceState({}, "", url.pathname + (url.search || ""));
    }
  }, []);

  return { ...state, customAgents, subagentConfigs, chatMessages, undoStack, redoStack, pendingQueue, isShared, liveConversationId, historyVersion, generatePlan, generateEnterprisePlan, previewEnterpriseTask, previewEnterpriseDomain, clearSandboxPreview, runVerifier, executePlan, cancelExecution, refinePlan, cancelRefine, queueRefine, editQueued, removeQueued, undoPlan, redoPlan, switchToPlan, designAgent, removeCustomAgent, updateCustomAgent, updateSubagentConfig, setSubagentModel, goToStage, reset, createShare, loadShare, openHistoryItem, exitSharedMode, setMessageFeedback };
}
