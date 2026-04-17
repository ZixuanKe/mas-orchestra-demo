import { useState, useRef, useEffect } from "react";
import { useOrchestration } from "./hooks/useOrchestration";
import { GraphViewer } from "./components/GraphViewer";
import { DatasetPicker } from "./components/DatasetPicker";
import type { Dataset, DomLevel, Mode, Stage, SubagentModel, CustomAgentConfig } from "./types";
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
    CustomAgent: "bg-pink-100 text-pink-700",
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

const STRATEGIES: { value: CustomAgentConfig["strategy"]; label: string; hint: string }[] = [
  { value: "single", label: "Single", hint: "One LLM call" },
  { value: "multi_sample", label: "Multi-Sample", hint: "N paths + vote" },
  { value: "critique", label: "Critique", hint: "Critic loop" },
  { value: "pipeline", label: "Pipeline", hint: "Sequential steps" },
];

function CustomAgentCard({
  config,
  onUpdate,
}: {
  config: CustomAgentConfig;
  onUpdate: (name: string, updates: Partial<CustomAgentConfig>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editPrompt, setEditPrompt] = useState(config.system_prompt);

  return (
    <div className="bg-white overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-pink-100 text-pink-700">Custom</span>
        <span className="text-sm font-medium text-gray-800">{config.name}</span>
        <span className="text-xs text-gray-400 ml-auto flex items-center gap-1">
          {config.enable_web_search && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>}
          {config.enable_think_tool && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>}
          {config.strategy}
        </span>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7" /></svg>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t">
          {/* Strategy toggle */}
          <div className="pt-2">
            <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Strategy</label>
            <div className="flex gap-1 mt-1">
              {STRATEGIES.map(s => (
                <button
                  key={s.value}
                  onClick={() => onUpdate(config.name, { strategy: s.value })}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    config.strategy === s.value
                      ? "bg-pink-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  title={s.hint}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {/* System prompt */}
          <div>
            <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">System Prompt</label>
            <textarea
              value={editPrompt}
              onChange={e => setEditPrompt(e.target.value)}
              onBlur={() => { if (editPrompt !== config.system_prompt) onUpdate(config.name, { system_prompt: editPrompt }); }}
              className="w-full mt-1 px-2 py-1.5 text-xs border rounded-md resize-none focus:ring-1 focus:ring-pink-400 focus:outline-none"
              rows={3}
            />
          </div>
          {/* Strategy-specific fields */}
          {config.strategy === "multi_sample" && (
            <div>
              <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Samples</label>
              <input
                type="number"
                value={config.num_samples ?? 3}
                onChange={e => onUpdate(config.name, { num_samples: parseInt(e.target.value) || 3 })}
                className="w-16 mt-1 px-2 py-1 text-xs border rounded-md focus:ring-1 focus:ring-pink-400 focus:outline-none"
                min={2}
                max={10}
              />
            </div>
          )}
          {config.strategy === "critique" && (
            <div className="space-y-2">
              <div>
                <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Rounds</label>
                <input
                  type="number"
                  value={config.num_rounds ?? 2}
                  onChange={e => onUpdate(config.name, { num_rounds: parseInt(e.target.value) || 2 })}
                  className="w-16 mt-1 ml-2 px-2 py-1 text-xs border rounded-md focus:ring-1 focus:ring-pink-400 focus:outline-none"
                  min={1}
                  max={5}
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Critic Prompt</label>
                <textarea
                  value={config.critic_prompt ?? ""}
                  onChange={e => onUpdate(config.name, { critic_prompt: e.target.value })}
                  className="w-full mt-1 px-2 py-1.5 text-xs border rounded-md resize-none focus:ring-1 focus:ring-pink-400 focus:outline-none"
                  rows={2}
                  placeholder="Instructions for the critic..."
                />
              </div>
            </div>
          )}
          {config.strategy === "pipeline" && (
            <div>
              <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Steps (one per line)</label>
              <textarea
                value={(config.steps ?? []).join("\n")}
                onChange={e => onUpdate(config.name, { steps: e.target.value.split("\n").filter(Boolean) })}
                className="w-full mt-1 px-2 py-1.5 text-xs border rounded-md resize-none focus:ring-1 focus:ring-pink-400 focus:outline-none font-mono"
                rows={3}
                placeholder={"Step 1: Analyze the problem\nStep 2: Generate solution\nStep 3: Verify"}
              />
            </div>
          )}
          {/* Tools */}
          <div className="pt-1 border-t">
            <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Tools</label>
            <div className="flex items-center gap-4 mt-1">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enable_web_search ?? false}
                  onChange={e => onUpdate(config.name, { enable_web_search: e.target.checked })}
                  className="rounded border-gray-300 text-pink-600 focus:ring-pink-400"
                />
                <span className="text-xs text-gray-600">Web Search</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enable_think_tool ?? false}
                  onChange={e => onUpdate(config.name, { enable_think_tool: e.target.checked })}
                  className="rounded border-gray-300 text-pink-600 focus:ring-pink-400"
                />
                <span className="text-xs text-gray-600">Think Tool</span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { stage, expectedAnswer, plan, graph, agentStates, finalAnswer, error, isLoading, isRefining, subagentModel, chatMessages, undoStack, redoStack, customAgents, generatePlan, executePlan, cancelExecution, refinePlan, undoPlan, redoPlan, switchToPlan, designAgent, updateCustomAgent, setSubagentModel, goToStage, reset } = useOrchestration();
  const [input, setInput] = useState({ problem: "", expected: "", mode: "custom" as Mode, dom: "high" as DomLevel });
  const [chatInput, setChatInput] = useState("");
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [previewGraph, setPreviewGraph] = useState<{ plan: import("./types").Plan; label: string } | null>(null);
  const [showXml, setShowXml] = useState(false);
  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const [activeVersionLabel, setActiveVersionLabel] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const stageRefs = {
    input: useRef<HTMLDivElement>(null),
    plan: useRef<HTMLDivElement>(null),
    execute: useRef<HTMLDivElement>(null),
    result: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    // Small delay so the DOM has rendered the new stage content
    const t = setTimeout(() => {
      const ref = stageRefs[stage];
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => clearTimeout(t);
  }, [stage]);

  useEffect(() => {
    // Scroll within chat panel only, not the page
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chatMessages]);

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
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">MAS-Orchestra</h1>
              <p className="text-sm text-gray-500">Multi-Agent System Orchestration</p>
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
      <div className={`mx-auto px-6 py-8 space-y-8 transition-all ${stage === "plan" ? "max-w-7xl" : "max-w-5xl"}`}>
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

        {/* PLAN STAGE — Side-by-side chat + graph */}
        {plan && (
          <StageWrapper stage="plan" current={stage} stageRef={stageRefs.plan} onActivate={() => handleNavSelect("plan")}>
            {/* Direct solution banner */}
            {isDirect && (
              <div className="bg-white rounded-xl border p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700">Direct Solution</span>
                  <span className="text-sm text-gray-500">Metaagent solved this directly</span>
                </div>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{plan.graph.direct_solution}</p>
              </div>
            )}

            {!isDirect && (
              <div className="flex gap-4" style={{ height: "calc(100vh - 220px)", minHeight: 500 }}>
                {/* Left: Chat panel */}
                <div className="flex flex-col w-[45%] bg-white rounded-xl border overflow-hidden">
                  {/* Chat header with undo/redo */}
                  <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
                    <span className="text-sm font-medium text-gray-700">Plan Chat</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { undoPlan(); setPreviewGraph(null); setActiveVersionLabel(null); }}
                        disabled={undoStack.length === 0}
                        title="Undo"
                        className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-default text-gray-500"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" /></svg>
                      </button>
                      <button
                        onClick={() => { redoPlan(); setPreviewGraph(null); setActiveVersionLabel(null); }}
                        disabled={redoStack.length === 0}
                        title="Redo"
                        className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-default text-gray-500"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" /></svg>
                      </button>
                    </div>
                  </div>

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {(() => {
                      let planVersion = 0;
                      return chatMessages.map((msg, i) => {
                        if (msg.plan) planVersion++;
                        const ver = planVersion;
                        return (
                          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                            <div className={`max-w-[90%] rounded-2xl px-3.5 py-2 ${
                              msg.role === "user"
                                ? "bg-blue-600 text-white rounded-br-md"
                                : "bg-gray-100 text-gray-800 rounded-bl-md"
                            }`}>
                              <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                              {msg.plan && msg.plan.graph.agents.length > 0 && (
                                <button
                                  onClick={() => setPreviewGraph({ plan: msg.plan!, label: `v${ver}` })}
                                  className={`mt-2 flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
                                    msg.role === "user"
                                      ? "bg-blue-500/40 text-blue-100 hover:bg-blue-500/60"
                                      : "bg-white border text-gray-600 hover:bg-gray-50"
                                  }`}
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
                                  {msg.plan.graph.agents.length} agents — view graph
                                </button>
                              )}
                              {msg.role === "assistant" && msg.plan && (() => {
                                const customs = msg.plan.graph.agents.filter(a => a.type === "CustomAgent");
                                return customs.length > 0 ? (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {customs.map(a => (
                                      <span key={a.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-pink-50 text-pink-600 border border-pink-200">
                                        <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />
                                        {a.id}
                                      </span>
                                    ))}
                                  </div>
                                ) : null;
                              })()}
                            </div>
                          </div>
                        );
                      });
                    })()}
                    {isRefining && (
                      <div className="flex justify-start">
                        <div className="bg-gray-100 rounded-2xl rounded-bl-md px-3.5 py-2">
                          <div className="flex items-center gap-2 text-sm text-gray-400">
                            <div className="flex gap-1">
                              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Chat input */}
                  {stage === "plan" && (
                    <div className="border-t p-3 space-y-2">
                      <div className="flex gap-2">
                        <input
                          value={chatInput}
                          onChange={e => setChatInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter" && chatInput.trim() && !isRefining) {
                              refinePlan(chatInput.trim());
                              setChatInput("");
                              setActiveVersionLabel(null);
                            }
                          }}
                          placeholder="e.g. &quot;add and parallelize 10 agents&quot;, &quot;design a custom agent&quot;"
                          className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
                          disabled={isRefining}
                        />
                        <button
                          onClick={() => {
                            if (chatInput.trim() && !isRefining) {
                              refinePlan(chatInput.trim());
                              setChatInput("");
                              setActiveVersionLabel(null);
                            }
                          }}
                          disabled={!chatInput.trim() || isRefining}
                          className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right: Graph + Execute */}
                <div className="flex-1 flex flex-col gap-3">
                <div className="flex-1 bg-white rounded-xl border overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700">Agent Graph</span>
                      <div className="relative">
                        <button
                          onClick={() => setShowVersionPicker(v => !v)}
                          className="px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded font-medium hover:bg-blue-200 transition-colors cursor-pointer"
                        >
                          {previewGraph ? previewGraph.label : activeVersionLabel || (() => {
                            let v = 0;
                            for (const m of chatMessages) { if (m.plan) v++; }
                            return v > 0 ? `v${v}` : "v1";
                          })()}
                          <svg className="w-2.5 h-2.5 ml-0.5 inline" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        {showVersionPicker && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowVersionPicker(false)} />
                            <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border z-50 py-1 min-w-[120px] max-h-[200px] overflow-y-auto">
                              {(() => {
                                const versions: { label: string; plan: import("./types").Plan; isCurrent: boolean }[] = [];
                                let v = 0;
                                for (const m of chatMessages) {
                                  if (m.plan && m.plan.graph.agents.length > 0) {
                                    v++;
                                    versions.push({ label: `v${v}`, plan: m.plan, isCurrent: plan === m.plan });
                                  }
                                }
                                if (versions.length === 0) return <div className="px-3 py-2 text-xs text-gray-400">No versions yet</div>;
                                return versions.map(ver => (
                                  <button
                                    key={ver.label}
                                    onClick={() => {
                                      if (!ver.isCurrent) {
                                        switchToPlan(ver.plan);
                                      }
                                      setActiveVersionLabel(ver.label);
                                      setPreviewGraph(null);
                                      setShowVersionPicker(false);
                                    }}
                                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 transition-colors flex items-center justify-between gap-3 ${
                                      ver.isCurrent ? "bg-blue-50 text-blue-700 font-semibold" : "text-gray-700"
                                    }`}
                                  >
                                    <span>{ver.label}</span>
                                    <span className="text-gray-400">{ver.plan.graph.agents.length} agents</span>
                                  </button>
                                ));
                              })()}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowXml(x => !x)}
                        className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${showXml ? "bg-slate-700 text-slate-200" : "text-gray-500 hover:bg-gray-200"}`}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>
                        XML
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 relative">
                    <GraphViewer
                      key={`plan-${(previewGraph?.plan.graph || graph)!.agents.map(a => a.id).join(",")}`}
                      graph={(previewGraph?.plan.graph || graph)!}
                      agentStates={previewGraph ? {} : agentStates}
                      openAgentId={openAgentId}
                      onOpenAgentHandled={() => setOpenAgentId(null)}
                    />
                    {showXml && (
                      <div className="absolute inset-x-0 bottom-0 max-h-[50%] bg-slate-900 border-t border-slate-700 flex flex-col">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700">
                          <span className="text-xs font-medium text-slate-400">Raw XML</span>
                          <button onClick={() => setShowXml(false)} className="text-slate-500 hover:text-slate-300">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                        <pre className="flex-1 overflow-auto p-3 text-xs text-slate-300 font-mono leading-relaxed">{plan.xml}</pre>
                      </div>
                    )}
                  </div>
                </div>
                {customAgents.length > 0 && (
                  <details className="border rounded-lg bg-white overflow-hidden">
                    <summary className="px-3 py-2 text-xs font-medium text-gray-600 cursor-pointer hover:bg-gray-50 select-none flex items-center gap-2">
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-pink-100 text-pink-700">Custom</span>
                      {customAgents.length} custom agent{customAgents.length > 1 ? "s" : ""} configured
                    </summary>
                    <div className="border-t divide-y max-h-[200px] overflow-y-auto">
                      {customAgents.map(cfg => (
                        <CustomAgentCard key={cfg.name} config={cfg} onUpdate={updateCustomAgent} />
                      ))}
                    </div>
                  </details>
                )}
                {stage === "plan" && (
                  <button onClick={executePlan} disabled={isLoading || isRefining} className="w-full px-5 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300 transition-colors">
                    Execute Plan &rarr;
                  </button>
                )}
                {stage === "execute" && isLoading && (
                  <button onClick={cancelExecution} className="w-full px-5 py-2.5 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors">
                    Cancel Execution
                  </button>
                )}
                </div>
              </div>
            )}

            {/* Direct solution actions */}
            {isDirect && stage === "plan" && (
              <div className="flex gap-3 mt-3">
                <button onClick={() => goToStage("result")} className="ml-auto px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">
                  View Result &rarr;
                </button>
              </div>
            )}
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
              <details open className="border rounded-lg">
                <summary className="px-3 py-2 text-sm font-medium text-gray-700 cursor-pointer hover:bg-gray-50 select-none">
                  Agent Outputs ({Object.values(agentStates).filter(s => s.status === "completed" || s.status === "failed").length} / {graph.agents.length})
                </summary>
                <div className="px-3 py-3 border-t grid grid-cols-1 md:grid-cols-2 gap-3">
                  {graph.agents.map(a => {
                    const s = agentStates[a.id];
                    const status = s?.status || "pending";
                    const borderColor: Record<string, string> = {
                      pending: "border-gray-200",
                      running: "border-amber-300",
                      completed: "border-emerald-300",
                      failed: "border-red-300",
                    };
                    const dotColor: Record<string, string> = {
                      pending: "bg-gray-300",
                      running: "bg-amber-400 animate-pulse",
                      completed: "bg-emerald-400",
                      failed: "bg-red-400",
                    };
                    const output = s?.output || s?.error || "";
                    const preview = output.split("\n").slice(0, 4).join("\n");
                    const hasMore = output.split("\n").length > 4;
                    return (
                      <div
                        key={a.id}
                        className={`bg-white rounded-lg border ${borderColor[status]} p-3 transition-all ${
                          status === "running" ? "shadow-sm shadow-amber-100" : ""
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor[status]}`} />
                          <code className="text-xs font-mono font-medium text-gray-800">{a.id}</code>
                          <Badge type={a.type} />
                          {status === "running" && (
                            <span className="text-xs text-amber-600 ml-auto">running...</span>
                          )}
                        </div>
                        {status === "running" && (
                          <div className="mt-2 h-1 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full animate-pulse" style={{ width: "60%" }} />
                          </div>
                        )}
                        {output && (
                          <div className="mt-2">
                            <pre className={`text-xs whitespace-pre-wrap break-words rounded-md p-2 max-h-[120px] overflow-y-auto ${
                              s?.error ? "bg-red-50 text-red-700" : "bg-gray-50 text-gray-700"
                            }`}>{preview}{hasMore ? "\n..." : ""}</pre>
                            {hasMore && (
                              <button
                                onClick={() => setOpenAgentId(a.id)}
                                className="text-xs text-blue-600 hover:text-blue-700 mt-1"
                              >
                                View full output &rarr;
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
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
