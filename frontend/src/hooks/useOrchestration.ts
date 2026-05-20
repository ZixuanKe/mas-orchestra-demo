import { useState, useCallback, useRef, useEffect } from "react";
import type { Graph, AgentState, Dataset, DomLevel, Plan, Stage, SubagentModel, CustomAgentConfig, SubagentConfig, ChatMessage, ShareSnapshot, EnterpriseTask, SandboxSnapshot, SandboxDiff, VerifierRunResponse } from "../types";
import { track } from "../analytics";

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
      sandboxSnapshot: null,
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
        // study the "before" state before clicking Run.
        sandboxSnapshot: initial_snapshot || null,
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
  const reset = useCallback(() => { setState(initial); setChatMessages([]); setUndoStack([]); setRedoStack([]); setSubagentConfigs({}); setPendingQueue([]); }, []);

  const createShare = useCallback(async (): Promise<{ id: string; url: string } | null> => {
    const cur = stateRef.current;
    // Enterprise runs need extra payload so the read-only viewer can render
    // the EnterprisePicker context (task title/prompt) and the 5th column
    // (sandbox graph + diffs). Reasoning shares simply omit these fields.
    const isEnterprise = !!cur.enterpriseTaskId;
    const snapshot: ShareSnapshot = {
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
      track("share_created", { has_plan: !!cur.plan, has_answer: !!cur.finalAnswer, agent_count: cur.plan?.graph.agents.length ?? 0 });
      return { id: data.id, url };
    } catch (err) {
      setState(s => ({ ...s, error: String(err) }));
      return null;
    }
  }, [customAgents, subagentConfigs]);

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

  const exitSharedMode = useCallback(() => {
    setIsShared(false);
    setState(initial);
    setChatMessages([]);
    setUndoStack([]);
    setRedoStack([]);
    setSubagentConfigs({});
    setCustomAgents([]);
    setPendingQueue([]);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("share");
      window.history.replaceState({}, "", url.pathname + (url.search || ""));
    }
  }, []);

  return { ...state, customAgents, subagentConfigs, chatMessages, undoStack, redoStack, pendingQueue, isShared, generatePlan, generateEnterprisePlan, previewEnterpriseTask, clearSandboxPreview, runVerifier, executePlan, cancelExecution, refinePlan, cancelRefine, queueRefine, editQueued, removeQueued, undoPlan, redoPlan, switchToPlan, designAgent, removeCustomAgent, updateCustomAgent, updateSubagentConfig, setSubagentModel, goToStage, reset, createShare, loadShare, exitSharedMode };
}
