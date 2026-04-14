import { useState, useCallback } from "react";
import type { Graph, AgentState, Dataset, Plan, Stage, SubagentModel } from "../types";

interface State {
  stage: Stage;
  problem: string;
  expectedAnswer: string;
  dataset: Dataset;
  subagentModel: SubagentModel;
  plan: Plan | null;
  graph: Graph | null;
  agentStates: Record<string, AgentState>;
  finalAnswer: string | null;
  error: string | null;
  isLoading: boolean;
}

const initial: State = {
  stage: "input",
  problem: "",
  expectedAnswer: "",
  dataset: "hotpot",
  subagentModel: "gpt-4.1-mini",
  plan: null,
  graph: null,
  agentStates: {},
  finalAnswer: null,
  error: null,
  isLoading: false,
};

export function useOrchestration() {
  const [state, setState] = useState<State>(initial);

  const generatePlan = useCallback(async (problem: string, dataset: Dataset, expectedAnswer: string) => {
    setState(s => ({ ...s, problem, dataset, expectedAnswer, isLoading: true, error: null }));
    try {
      const res = await fetch("/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem, dataset }),
      });
      if (!res.ok) throw new Error(`Plan failed: ${res.status}`);
      const plan: Plan = await res.json();
      const agentStates = Object.fromEntries(plan.graph.agents.map(a => [a.id, { id: a.id, status: "pending" as const }]));
      setState(s => ({ ...s, stage: "plan", plan, graph: plan.graph, agentStates, finalAnswer: plan.graph.direct_solution || null, isLoading: false }));
    } catch (err) {
      setState(s => ({ ...s, error: String(err), isLoading: false }));
    }
  }, []);

  const executePlan = useCallback(async () => {
    if (!state.plan) return;
    setState(s => ({ ...s, stage: "execute", isLoading: true, error: null }));
    try {
      const res = await fetch("/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem: state.problem, graph: state.plan.graph, subagent_model: state.subagentModel }),
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
      setState(s => ({ ...s, error: String(err), isLoading: false }));
    }
  }, [state.plan, state.problem, state.subagentModel]);

  const setSubagentModel = useCallback((subagentModel: SubagentModel) => setState(s => ({ ...s, subagentModel })), []);
  const goToStage = useCallback((stage: Stage) => setState(s => ({ ...s, stage, error: null })), []);
  const reset = useCallback(() => setState(initial), []);

  return { ...state, generatePlan, executePlan, setSubagentModel, goToStage, reset };
}
