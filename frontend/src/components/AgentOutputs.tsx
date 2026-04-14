import type { Graph, AgentState } from "../types";

interface Props {
  graph: Graph;
  agentStates: Record<string, AgentState>;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "border-gray-200 bg-white",
  running: "border-amber-300 bg-amber-50",
  completed: "border-emerald-300 bg-emerald-50/50",
  failed: "border-red-300 bg-red-50",
};

const BADGE_STYLES: Record<string, string> = {
  pending: "bg-gray-100 text-gray-500",
  running: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

export function AgentOutputs({ graph, agentStates }: Props) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Agent Outputs</h3>
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {graph.agents.map(agent => {
          const state = agentStates[agent.id];
          if (!state) return null;

          return (
            <div key={agent.id} className={`p-4 rounded-lg border transition-all ${STATUS_STYLES[state.status]}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-gray-800">{agent.id}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${BADGE_STYLES[state.status]}`}>
                  {state.status}
                </span>
              </div>

              {state.status === "running" && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                  Processing...
                </div>
              )}

              {state.output && (
                <div className="mt-2 text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 p-3 rounded max-h-48 overflow-y-auto">
                  {state.output}
                </div>
              )}

              {state.error && (
                <div className="mt-2 text-sm text-red-600 bg-red-50 p-3 rounded">{state.error}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
