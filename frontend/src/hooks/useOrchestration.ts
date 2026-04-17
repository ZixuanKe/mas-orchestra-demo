import { useState, useCallback, useRef } from "react";
import type { Graph, AgentState, Dataset, DomLevel, Plan, Stage, SubagentModel, CustomAgentConfig, ChatMessage } from "../types";
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
};

interface Snapshot {
  plan: Plan;
  messages: ChatMessage[];
}

export function useOrchestration() {
  const [state, setState] = useState<State>(initial);
  const [customAgents, setCustomAgents] = useState<CustomAgentConfig[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  // Refs for fresh reads in stable callbacks
  const undoRef = useRef(undoStack);
  undoRef.current = undoStack;
  const redoRef = useRef(redoStack);
  redoRef.current = redoStack;
  const stateRef = useRef(state);
  stateRef.current = state;
  const msgsRef = useRef(chatMessages);
  msgsRef.current = chatMessages;

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
      const plan: Plan = await res.json();
      const agentStates = Object.fromEntries(plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
      const introMessage: ChatMessage = {
        role: "assistant",
        content: plan.thinking
          ? `Here's the plan. ${plan.graph.agents.length} agents designed.\n\n${plan.thinking}`
          : `Plan generated with ${plan.graph.agents.length} agents. You can refine it by chatting below.`,
        plan,
      };
      setChatMessages([introMessage]);
      setState(s => ({ ...s, stage: "plan", plan, graph: plan.graph, agentStates, finalAnswer: plan.graph.direct_solution || null, isLoading: false }));
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isLoading: false }));
    }
  }, []);

  const executePlan = useCallback(async () => {
    if (!state.plan) return;
    track("execute_started", { agent_count: state.plan.graph.agents.length, subagent_model: state.subagentModel });
    setState(s => ({ ...s, stage: "execute", isLoading: true, error: null }));

    // Attach custom configs to any CustomAgent nodes in the graph
    const graphToSend = { ...state.plan.graph };
    if (customAgents.length > 0) {
      graphToSend.agents = graphToSend.agents.map(a => {
        if (a.type !== "CustomAgent" || a.custom_config) return a;
        const match = customAgents.find(c =>
          a.description.toLowerCase().includes(c.name.toLowerCase()) ||
          a.id.toLowerCase().includes(c.name.toLowerCase().replace("agent", ""))
        );
        const cfg = match || (customAgents.length === 1 ? customAgents[0] : null);
        return cfg ? { ...a, custom_config: cfg } : a;
      });
    }

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem: state.problem, graph: graphToSend, subagent_model: state.subagentModel }),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`Execute failed: ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = JSON.parse(line.slice(5).trim());
          if (data.agentId && !data.output && !data.error) {
            setState(s => ({ ...s, agentStates: { ...s.agentStates, [data.agentId]: { id: data.agentId, status: "running" } } }));
          } else if (data.agentId && data.output) {
            setState(s => ({ ...s, agentStates: { ...s.agentStates, [data.agentId]: { id: data.agentId, status: "completed", output: data.output } } }));
          } else if (data.agentId && data.error) {
            setState(s => ({ ...s, agentStates: { ...s.agentStates, [data.agentId]: { id: data.agentId, status: "failed", error: data.error } } }));
          } else if (data.answer) {
            setState(s => ({ ...s, stage: "result", finalAnswer: data.answer, isLoading: false }));
          } else if (data.message) {
            setState(s => ({ ...s, error: data.message }));
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        setState(s => ({ ...s, isLoading: false }));
      } else {
        setState(s => ({ ...s, error: String(err), isLoading: false }));
      }
    } finally {
      abortRef.current = null;
    }
  }, [state.plan, state.problem, state.subagentModel, customAgents]);

  const cancelExecution = useCallback(() => {
    abortRef.current?.abort();
    setState(s => ({ ...s, isLoading: false }));
  }, []);

  const refinePlan = useCallback(async (userMessage: string) => {
    if (!state.plan) return;

    // Snapshot BEFORE this refinement (plan + current messages before user msg)
    const snapshot: Snapshot = { plan: state.plan, messages: [...chatMessages] };

    // Add user message to chat
    const userMsg: ChatMessage = { role: "user", content: userMessage };
    const updatedMessages = [...chatMessages, userMsg];
    setChatMessages(updatedMessages);
    setState(s => ({ ...s, isRefining: true, error: null }));
    track("plan_refined", { message_length: userMessage.length });

    try {
      // Send conversation history (just role + content for the API)
      const apiMessages = updatedMessages.map(m => ({ role: m.role, content: m.content }));

      const res = await fetch("/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problem: state.problem,
          current_xml: state.plan.xml,
          messages: apiMessages,
          dom: state.dom,
          custom_agents: customAgents,
        }),
      });
      if (!res.ok) throw new Error(`Refine failed: ${res.status}`);
      const data = await res.json();

      // Build assistant message
      const assistantMsg: ChatMessage = { role: "assistant", content: data.message };

      if (data.graph && data.graph.agents && data.graph.agents.length > 0) {
        // Plan was revised — push snapshot to undo, clear redo
        setUndoStack(prev => [...prev, snapshot]);
        setRedoStack([]);
        const plan: Plan = { xml: data.xml, graph: data.graph, thinking: data.thinking };
        assistantMsg.plan = plan;
        const agentStates = Object.fromEntries(plan.graph.agents.map((a: { id: string }) => [a.id, { id: a.id, status: "pending" as const }]));
        setState(s => ({ ...s, plan, graph: plan.graph, agentStates, finalAnswer: plan.graph.direct_solution || null, isRefining: false }));

        // Auto-register configs for new CustomAgent nodes
        const newCustom = plan.graph.agents.filter(
          (a: { type: string; id: string }) => a.type === "CustomAgent" && !customAgents.some(c => c.name === a.id || a.description.toLowerCase().includes(c.name.toLowerCase()) || a.id.toLowerCase().includes(c.name.toLowerCase().replace(/agent/i, "")))
        );
        if (newCustom.length > 0) {
          setCustomAgents(prev => [
            ...prev,
            ...newCustom.map((a: { id: string; description: string }) => {
              const desc = a.description.toLowerCase();
              return {
                name: a.id,
                strategy: (desc.includes("best of") || desc.includes("sample") || desc.includes("best-of") ? "multi_sample" : "single") as "single" | "multi_sample",
                system_prompt: a.description.replace(/^\w+:\s*/, ""),
                enable_web_search: desc.includes("search") || desc.includes("web") || desc.includes("lookup"),
                enable_think_tool: desc.includes("think") || desc.includes("reason") || desc.includes("verif") || desc.includes("math"),
              };
            }),
          ]);
        }
      } else {
        // Just a question/response, no plan change — no undo entry
        setState(s => ({ ...s, isRefining: false }));
      }

      setChatMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isRefining: false }));
    }
  }, [state.plan, state.problem, state.dom, customAgents, chatMessages]);

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

  const undoPlan = useCallback(() => {
    const stack = undoRef.current;
    const curPlan = stateRef.current.plan;
    const curMsgs = msgsRef.current;
    if (stack.length === 0 || !curPlan) return false;

    // Push current state to redo
    setRedoStack(r => [...r, { plan: curPlan, messages: curMsgs }]);

    // Pop from undo and restore
    const prev = stack[stack.length - 1];
    setUndoStack(stack.slice(0, -1));
    setChatMessages(prev.messages);
    const agentStates = Object.fromEntries(prev.plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
    setState(s => ({ ...s, plan: prev.plan, graph: prev.plan.graph, agentStates, finalAnswer: prev.plan.graph.direct_solution || null }));
    return true;
  }, []);

  const redoPlan = useCallback(() => {
    const stack = redoRef.current;
    const curPlan = stateRef.current.plan;
    const curMsgs = msgsRef.current;
    if (stack.length === 0 || !curPlan) return false;

    // Push current state to undo
    setUndoStack(u => [...u, { plan: curPlan, messages: curMsgs }]);

    // Pop from redo and restore
    const next = stack[stack.length - 1];
    setRedoStack(stack.slice(0, -1));
    setChatMessages(next.messages);
    const agentStates = Object.fromEntries(next.plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
    setState(s => ({ ...s, plan: next.plan, graph: next.plan.graph, agentStates, finalAnswer: next.plan.graph.direct_solution || null }));
    return true;
  }, []);

  const switchToPlan = useCallback((newPlan: Plan) => {
    const curPlan = stateRef.current.plan;
    const curMsgs = msgsRef.current;
    if (!curPlan) return;
    // Push current state to undo, clear redo
    setUndoStack(prev => [...prev, { plan: curPlan, messages: curMsgs }]);
    setRedoStack([]);
    const agentStates = Object.fromEntries(newPlan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
    setState(s => ({ ...s, plan: newPlan, graph: newPlan.graph, agentStates, finalAnswer: newPlan.graph.direct_solution || null }));
  }, []);

  const setSubagentModel = useCallback((subagentModel: SubagentModel) => setState(s => ({ ...s, subagentModel })), []);
  const goToStage = useCallback((stage: Stage) => setState(s => ({ ...s, stage, error: null })), []);
  const reset = useCallback(() => { setState(initial); setChatMessages([]); setUndoStack([]); setRedoStack([]); }, []);

  return { ...state, customAgents, chatMessages, undoStack, redoStack, generatePlan, executePlan, cancelExecution, refinePlan, undoPlan, redoPlan, switchToPlan, designAgent, removeCustomAgent, updateCustomAgent, setSubagentModel, goToStage, reset };
}
