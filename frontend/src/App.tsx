import { useState } from "react";
import { useOrchestration } from "./hooks/useOrchestration";
import { GraphViewer } from "./components/GraphViewer";
import { AgentOutputs } from "./components/AgentOutputs";
import { DatasetPicker } from "./components/DatasetPicker";
import type { Dataset, Stage, SubagentModel } from "./types";
import { DATASETS, SUBAGENT_MODELS } from "./types";

const STAGES: Stage[] = ["input", "plan", "execute", "result"];

function StepNav({ current, onSelect, canSelect }: { current: Stage; onSelect: (s: Stage) => void; canSelect: (s: Stage) => boolean }) {
  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
      {STAGES.map(s => (
        <button
          key={s}
          onClick={() => canSelect(s) && onSelect(s)}
          disabled={!canSelect(s)}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-all capitalize
            ${current === s ? "bg-white text-gray-900 shadow-sm" : canSelect(s) ? "text-gray-600 hover:bg-gray-50" : "text-gray-300 cursor-not-allowed"}`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function Badge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    CoTAgent: "bg-blue-100 text-blue-700",
    SCAgent: "bg-purple-100 text-purple-700",
    DebateAgent: "bg-amber-100 text-amber-700",
    ReflexionAgent: "bg-emerald-100 text-emerald-700",
    WebSearchAgent: "bg-rose-100 text-rose-700",
  };
  return <span className={`px-2 py-0.5 text-xs font-medium rounded ${colors[type] || "bg-gray-100"}`}>{type}</span>;
}

const GitHubIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
  </svg>
);

const PaperIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M4 4h16v16H4V4zm2 2v12h12V6H6zm2 2h8v2H8V8zm0 4h8v2H8v-2zm0 4h5v2H8v-2z"/>
  </svg>
);

export default function App() {
  const { stage, expectedAnswer, plan, graph, agentStates, finalAnswer, error, isLoading, subagentModel, generatePlan, executePlan, setSubagentModel, goToStage, reset } = useOrchestration();
  const [input, setInput] = useState({ problem: "", expected: "", dataset: "hotpot" as Dataset });

  const isDirect = plan?.graph.direct_solution != null;
  const canSelect = (s: Stage) => {
    if (s === "input") return true;
    if (s === "plan") return !!plan;
    if (s === "execute") return !!plan && !isDirect;
    if (s === "result") return !!finalAnswer || isDirect;
    return false;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">MAS-Orchestra</h1>
              <p className="text-sm text-gray-500">Multi-Agent Orchestration Demo</p>
            </div>
            <div className="flex items-center gap-2">
              <a href="https://github.com/SalesforceAIResearch/MAS-Orchestra" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50">
                <GitHubIcon /> GitHub
              </a>
              <a href="https://arxiv.org/abs/2601.14652" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50">
                <PaperIcon /> Paper
              </a>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs font-medium">
              <span style={{ color: "#00A1E0" }}>Salesforce AI Research</span>
              <span className="text-gray-300">•</span>
              <span style={{ color: "#A31F34" }}>MIT</span>
              <span className="text-gray-300">•</span>
              <span style={{ color: "#C5050C" }}>UW Madison</span>
            </div>
            <StepNav current={stage} onSelect={goToStage} canSelect={canSelect} />
          </div>
        </div>

        {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

        {stage === "input" && (
          <div className="bg-white rounded-xl border p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Problem</label>
              <textarea value={input.problem} onChange={e => setInput(s => ({ ...s, problem: e.target.value }))}
                placeholder="Enter your problem..." className="w-full h-28 px-3 py-2 border rounded-lg text-sm resize-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expected Answer <span className="text-gray-400">(optional)</span></label>
              <input value={input.expected} onChange={e => setInput(s => ({ ...s, expected: e.target.value }))}
                placeholder="For comparison..." className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-gray-700">Dataset</label>
                <select value={input.dataset} onChange={e => setInput(s => ({ ...s, dataset: e.target.value as Dataset }))} className="px-3 py-1.5 border rounded-lg text-sm">
                  {DATASETS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
              <DatasetPicker dataset={input.dataset} onSelect={(question, answer) => setInput(s => ({ ...s, problem: question, expected: answer }))} />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700">Sub-agent Model</label>
                <select value={subagentModel} onChange={e => setSubagentModel(e.target.value as SubagentModel)} className="px-3 py-1.5 border rounded-lg text-sm">
                  {SUBAGENT_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <button onClick={() => input.problem.trim() && generatePlan(input.problem.trim(), input.dataset, input.expected.trim())}
                disabled={!input.problem.trim() || isLoading} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300">
                {isLoading ? "Generating..." : "Generate Plan →"}
              </button>
            </div>
          </div>
        )}

        {stage === "plan" && plan && (
          <div className="bg-white rounded-xl border p-6 space-y-6">
            {plan.thinking && (
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Reasoning</h3>
                <p className="text-sm text-gray-700 bg-gray-50 p-3 rounded-lg whitespace-pre-wrap">{plan.thinking}</p>
              </div>
            )}
            {isDirect ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700">Direct Solution</span>
                  <span className="text-sm text-gray-500">Metaagent solved this directly</span>
                </div>
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{plan.graph.direct_solution}</p>
                </div>
              </div>
            ) : (
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Agents ({plan.graph.agents.length})</h3>
                <div className="space-y-2">
                  {plan.graph.agents.map(a => (
                    <div key={a.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                      <code className="text-sm font-mono text-gray-800">{a.id}</code>
                      <Badge type={a.type} />
                      <span className="text-sm text-gray-600 truncate">{a.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <details className="text-sm">
              <summary className="text-gray-500 cursor-pointer">Raw XML</summary>
              <pre className="mt-2 p-3 bg-slate-900 text-slate-300 rounded-lg overflow-auto max-h-48 text-xs">{plan.xml}</pre>
            </details>
            <div className="flex gap-3 pt-2">
              <button onClick={() => goToStage("input")} className="px-4 py-2 border rounded-lg text-sm">← Back</button>
              {isDirect ? (
                <button onClick={() => goToStage("result")} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">
                  View Result →
                </button>
              ) : (
                <button onClick={executePlan} disabled={isLoading} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300">
                  {isLoading ? "Executing..." : "Execute →"}
                </button>
              )}
            </div>
          </div>
        )}

        {(stage === "execute" || (stage === "result" && !isDirect)) && graph && graph.agents.length > 0 && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-xl border p-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Graph</h3>
                <GraphViewer graph={graph} agentStates={agentStates} />
              </div>
              <div className="bg-white rounded-xl border p-4">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Outputs</h3>
                <AgentOutputs graph={graph} agentStates={agentStates} />
              </div>
            </div>
            {stage === "result" && finalAnswer && (
              <div className="bg-white rounded-xl border p-6 space-y-4">
                <h3 className="text-sm font-medium text-gray-500">Final Answer</h3>
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{finalAnswer}</p>
                </div>
                {expectedAnswer && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-2">Expected Answer</h3>
                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-sm text-gray-800">{expectedAnswer}</p>
                    </div>
                  </div>
                )}
                <button onClick={reset} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">New Problem</button>
              </div>
            )}
          </div>
        )}

        {stage === "result" && isDirect && (
          <div className="bg-white rounded-xl border p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700">Direct Solution</span>
              <span className="text-sm text-gray-500">Metaagent solved this without delegation</span>
            </div>
            <h3 className="text-sm font-medium text-gray-500">Final Answer</h3>
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{plan?.graph.direct_solution}</p>
            </div>
            {expectedAnswer && (
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Expected Answer</h3>
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-gray-800">{expectedAnswer}</p>
                </div>
              </div>
            )}
            <button onClick={reset} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">New Problem</button>
          </div>
        )}
      </div>
    </div>
  );
}
