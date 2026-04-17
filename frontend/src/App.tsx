import { useState, useRef, useEffect } from "react";
import { useOrchestration } from "./hooks/useOrchestration";
import { GraphViewer } from "./components/GraphViewer";
import { DatasetPicker } from "./components/DatasetPicker";
import type { Dataset, DomLevel, Mode, Stage, SubagentModel } from "./types";
import { AGENT_POOL, DATASETS, DOM_OPTIONS, MODES, SUBAGENT_MODELS } from "./types";

const STAGES: { key: Stage; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "plan", label: "Plan" },
  { key: "execute", label: "Execute" },
  { key: "result", label: "Result" },
];

function ProgressRail({
  current,
  agentStates,
  plan,
  isLoading,
  onSelect,
  canSelect,
}: {
  current: Stage;
  agentStates: Record<string, { status: string }>;
  plan: { graph: { agents: { id: string }[] } } | null;
  isLoading: boolean;
  onSelect: (s: Stage) => void;
  canSelect: (s: Stage) => boolean;
}) {
  const stageIdx = STAGES.findIndex(s => s.key === current);

  const statusHint = (s: Stage): string | null => {
    if (s === "plan" && current === "plan" && isLoading) return "generating\u2026";
    if (s === "execute" && (current === "execute" || current === "result") && plan) {
      const total = plan.graph.agents.length;
      const done = Object.values(agentStates).filter(a => a.status === "completed" || a.status === "failed").length;
      if (current === "execute") return `${done} / ${total} agents`;
      return `${total} agents`;
    }
    return null;
  };

  return (
    <div className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b">
      <div className="max-w-5xl mx-auto px-6">
        <div className="flex items-center h-12">
          {STAGES.map((s, i) => {
            const isDone = i < stageIdx;
            const isCurrent = i === stageIdx;
            const isPending = i > stageIdx;
            const clickable = canSelect(s.key);
            const hint = statusHint(s.key);

            return (
              <div key={s.key} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
                {i > 0 && (
                  <div className={`flex-1 h-px transition-colors duration-300 ${isDone ? "bg-blue-400" : "bg-gray-200"}`} />
                )}
                <button
                  onClick={() => clickable && onSelect(s.key)}
                  disabled={!clickable}
                  className={`flex items-center gap-2 group transition-all px-2 ${clickable ? "cursor-pointer" : "cursor-default"}`}
                >
                  <div className={`w-2.5 h-2.5 rounded-full border-2 transition-all duration-300 flex-shrink-0
                    ${isDone ? "bg-blue-500 border-blue-500" : ""}
                    ${isCurrent ? "border-blue-500 bg-blue-500 ring-4 ring-blue-100 animate-pulse-subtle" : ""}
                    ${isPending ? "border-gray-300 bg-white" : ""}
                  `} />
                  <span className={`text-sm font-medium whitespace-nowrap transition-colors
                    ${isCurrent ? "text-gray-900" : isDone ? "text-gray-500" : "text-gray-300"}
                    ${clickable && !isCurrent ? "group-hover:text-gray-700" : ""}
                  `}>
                    {s.label}
                    {hint && <span className="text-xs font-normal text-gray-400 ml-1">&middot; {hint}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
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

const GlobeIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20" />
  </svg>
);

function StageWrapper({
  stage,
  current,
  stageRef,
  onActivate,
  children,
}: {
  stage: Stage;
  current: Stage;
  stageRef: React.RefObject<HTMLDivElement | null>;
  onActivate?: () => void;
  children: React.ReactNode;
}) {
  const stageIdx = STAGES.findIndex(s => s.key === stage);
  const currentIdx = STAGES.findIndex(s => s.key === current);
  const isNotCurrent = stageIdx !== currentIdx;
  const isDone = stageIdx < currentIdx;
  const isCurrent = stageIdx === currentIdx;
  const isPending = stageIdx > currentIdx;
  const clickable = isNotCurrent && !!onActivate;

  return (
    <div
      ref={stageRef}
      onClick={clickable ? onActivate : undefined}
      className={`transition-all duration-500 scroll-mt-16 ${
        isCurrent ? "opacity-100" : isDone ? "opacity-50 saturate-50 cursor-pointer hover:opacity-70" : isPending ? "opacity-30 cursor-pointer hover:opacity-50" : ""
      }`}
    >
      {children}
    </div>
  );
}

export default function App() {
  const { stage, expectedAnswer, plan, graph, agentStates, finalAnswer, error, isLoading, isRefining, subagentModel, generatePlan, executePlan, refinePlan, setSubagentModel, goToStage, reset } = useOrchestration();
  const [input, setInput] = useState({ problem: "", expected: "", mode: "custom" as Mode, dom: "high" as DomLevel });
  const [refineInput, setRefineInput] = useState("");
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const stageRefs = {
    input: useRef<HTMLDivElement>(null),
    plan: useRef<HTMLDivElement>(null),
    execute: useRef<HTMLDivElement>(null),
    result: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    const ref = stageRefs[stage];
    if (ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [stage]);

  const isDirect = plan?.graph.direct_solution != null;
  const canSelect = (s: Stage) => {
    if (s === "input") return true;
    if (s === "plan") return !!plan;
    if (s === "execute") return !!plan && !isDirect;
    if (s === "result") return !!finalAnswer || isDirect;
    return false;
  };

  const handleNavSelect = (s: Stage) => {
    goToStage(s);
    setTimeout(() => {
      stageRefs[s].current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
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
              <a href="https://vincent950129.github.io/mas-design/mas_r1/" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50">
                <GlobeIcon /> Project
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs font-medium mt-2">
            <span style={{ color: "#00A1E0" }}>Salesforce AI Research</span>
            <span className="text-gray-300">&bull;</span>
            <span style={{ color: "#A31F34" }}>MIT</span>
            <span className="text-gray-300">&bull;</span>
            <span style={{ color: "#C5050C" }}>UW Madison</span>
          </div>
        </div>
      </div>

      {/* Progress Rail */}
      <ProgressRail
        current={stage}
        agentStates={agentStates}
        plan={plan}
        isLoading={isLoading}
        onSelect={handleNavSelect}
        canSelect={canSelect}
      />

      {/* All stages rendered vertically */}
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

        {/* INPUT STAGE */}
        <StageWrapper stage="input" current={stage} stageRef={stageRefs.input} onActivate={() => handleNavSelect("input")}>
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
                <label className="text-sm font-medium text-gray-700">Mode</label>
                <select value={input.mode} onChange={e => setInput(s => ({ ...s, mode: e.target.value as Mode }))} className="px-3 py-1.5 border rounded-lg text-sm">
                  {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              {input.mode === "custom" ? (
                <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 border rounded-lg">
                  <span className="text-sm font-medium text-gray-700">Degree of MAS (DoM)</span>
                  <div className="flex gap-1 p-0.5 bg-white border rounded-md">
                    {DOM_OPTIONS.map(d => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => setInput(s => ({ ...s, dom: d.value }))}
                        className={`px-3 py-1 text-xs font-medium rounded transition-colors ${input.dom === d.value ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
                      >
                        {d.label}{d.hint && <span className={input.dom === d.value ? "text-blue-100" : "text-gray-400"}> ({d.hint})</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <DatasetPicker dataset={input.mode as Dataset} onSelect={(question, answer) => setInput(s => ({ ...s, problem: question, expected: answer }))} />
              )}
            </div>
            <details className="border rounded-lg">
              <summary className="px-3 py-2 text-sm font-medium text-gray-700 cursor-pointer hover:bg-gray-50 select-none">
                Agent Pool ({AGENT_POOL.length})
              </summary>
              <div className="px-3 py-2 border-t space-y-2">
                {AGENT_POOL.map(a => (
                  <div key={a.type} className="flex items-start gap-3">
                    <Badge type={a.type} />
                    <span className="text-sm text-gray-600">{a.description}</span>
                  </div>
                ))}
              </div>
            </details>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700">Sub-agent Model</label>
                <select value={subagentModel} onChange={e => setSubagentModel(e.target.value as SubagentModel)} className="px-3 py-1.5 border rounded-lg text-sm">
                  {SUBAGENT_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <button onClick={() => {
                if (!input.problem.trim()) return;
                const dataset = input.mode === "custom" ? null : (input.mode as Dataset);
                const dom = dataset ? (DATASETS.find(d => d.value === dataset)?.dom ?? "high") : input.dom;
                generatePlan(input.problem.trim(), dataset, dom, input.expected.trim());
              }}
                disabled={!input.problem.trim() || isLoading} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300">
                {isLoading && stage === "input" ? "Generating\u2026" : "Generate Plan \u2192"}
              </button>
            </div>
          </div>
        </StageWrapper>

        {/* PLAN STAGE */}
        {plan && (
          <StageWrapper stage="plan" current={stage} stageRef={stageRefs.plan} onActivate={() => handleNavSelect("plan")}>
            <div className="bg-white rounded-xl border p-6 space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-6 bg-blue-500 rounded-full" />
                <h2 className="text-lg font-semibold text-gray-900">Plan</h2>
              </div>
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
                      <div key={a.id} className="p-3 bg-gray-50 rounded-lg space-y-2">
                        <div className="flex items-center gap-3">
                          <code className="text-sm font-mono text-gray-800">{a.id}</code>
                          <Badge type={a.type} />
                          <span className="text-sm text-gray-600">{a.description}</span>
                        </div>
                        {a.input && (
                          <div className="pl-2 border-l-2 border-gray-200">
                            <div className="text-xs font-medium text-gray-500 mb-0.5">Input</div>
                            <code className="text-xs text-gray-700 whitespace-pre-wrap break-words block">{a.input}</code>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <details className="text-sm">
                <summary className="text-gray-500 cursor-pointer">Raw XML</summary>
                <pre className="mt-2 p-3 bg-slate-900 text-slate-300 rounded-lg overflow-auto max-h-48 text-xs">{plan.xml}</pre>
              </details>
              {stage === "plan" && (
                <div className="space-y-4 pt-2">
                  {!isDirect && (
                    <div className="flex gap-2">
                      <input
                        value={refineInput}
                        onChange={e => setRefineInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && refineInput.trim() && !isRefining) {
                            refinePlan(refineInput.trim());
                          }
                        }}
                        placeholder="Revise plan... e.g. &quot;add 100 agents&quot; or &quot;swap CoT for Debate&quot;"
                        className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                        disabled={isRefining}
                      />
                      <button
                        onClick={() => {
                          if (refineInput.trim() && !isRefining) {
                            refinePlan(refineInput.trim());
                          }
                        }}
                        disabled={!refineInput.trim() || isRefining}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300"
                      >
                        {isRefining ? "Refining\u2026" : "Refine"}
                      </button>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button onClick={() => goToStage("input")} className="px-4 py-2 border rounded-lg text-sm">&larr; Back</button>
                    {isDirect ? (
                      <button onClick={() => goToStage("result")} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">
                        View Result &rarr;
                      </button>
                    ) : (
                      <button onClick={executePlan} disabled={isLoading || isRefining} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300">
                        {isLoading ? "Executing\u2026" : "Execute \u2192"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </StageWrapper>
        )}

        {/* EXECUTE STAGE */}
        {graph && graph.agents.length > 0 && !isDirect && (
          <StageWrapper stage="execute" current={stage} stageRef={stageRefs.execute} onActivate={() => handleNavSelect("execute")}>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-6 bg-emerald-500 rounded-full" />
                <h2 className="text-lg font-semibold text-gray-900">Execute</h2>
              </div>
              <div className="bg-white rounded-xl border p-4">
                <GraphViewer graph={graph} agentStates={agentStates} openAgentId={openAgentId} onOpenAgentHandled={() => setOpenAgentId(null)} />
              </div>
              <div className="flex flex-wrap gap-2">
                {graph.agents.map(a => {
                  const s = agentStates[a.id];
                  const status = s?.status || "pending";
                  const dotColor: Record<string, string> = {
                    pending: "bg-gray-300",
                    running: "bg-amber-400 animate-pulse",
                    completed: "bg-emerald-400",
                    failed: "bg-red-400",
                  };
                  const clickable = status === "completed" || status === "failed";
                  return (
                    <button
                      key={a.id}
                      onClick={() => clickable && setOpenAgentId(a.id)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 bg-white border rounded-lg text-xs transition-colors
                        ${clickable ? "hover:bg-gray-50 hover:border-gray-300 cursor-pointer" : "cursor-default"}`}
                    >
                      <div className={`w-2 h-2 rounded-full ${dotColor[status]}`} />
                      <span className="font-mono text-gray-700">{a.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </StageWrapper>
        )}

        {/* RESULT STAGE */}
        {(finalAnswer || isDirect) && (
          <StageWrapper stage="result" current={stage} stageRef={stageRefs.result} onActivate={() => handleNavSelect("result")}>
            <div className="bg-white rounded-xl border p-6 space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-6 bg-amber-500 rounded-full" />
                <h2 className="text-lg font-semibold text-gray-900">Result</h2>
              </div>
              {isDirect && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700">Direct Solution</span>
                  <span className="text-sm text-gray-500">Metaagent solved this without delegation</span>
                </div>
              )}
              <h3 className="text-sm font-medium text-gray-500">Final Answer</h3>
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {isDirect ? plan?.graph.direct_solution : finalAnswer}
                </p>
              </div>
              {expectedAnswer && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Expected Answer</h3>
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-gray-800">{expectedAnswer}</p>
                  </div>
                </div>
              )}
              {stage === "result" && (
                <button onClick={reset} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">New Problem</button>
              )}
            </div>
          </StageWrapper>
        )}
      </div>
    </div>
  );
}
