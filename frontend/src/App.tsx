import { useState, useRef, useEffect } from "react";
import { useOrchestration } from "./hooks/useOrchestration";
import { GraphViewer } from "./components/GraphViewer";
import { DatasetPicker } from "./components/DatasetPicker";
import type { Dataset, DomLevel, Mode, SubagentModel, CustomAgentConfig, SubagentConfig, Agent, AgentType, AgentState, Plan, ChatMessage } from "./types";
import { AGENT_POOL, DATASETS, DOM_OPTIONS, MODES, SUBAGENT_MODELS } from "./types";

/* ────────────────────────────────────────────────────────────────
   Icons (inline SVGs, keep bundle tiny)
   ──────────────────────────────────────────────────────────────── */
const I = {
  Menu: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg>,
  Panel: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>,
  Chev: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>,
  Check: (p: { className?: string }) => <svg {...p} fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd"/></svg>,
  X: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>,
  Send: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  Arrow: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 12l14 0M13 6l6 6-6 6"/></svg>,
  Copy: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  Refresh: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>,
  Undo: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4"/></svg>,
  Redo: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4"/></svg>,
  Expand: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>,
  GitHub: (p: { className?: string }) => <svg {...p} fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd"/></svg>,
  Paper: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
  Globe: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></svg>,
  Sparkle: (p: { className?: string }) => <svg {...p} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 2l2 7 7 2-7 2-2 7-2-7-7-2 7-2z"/></svg>,
};

/* ────────────────────────────────────────────────────────────────
   Type colors (shared)
   ──────────────────────────────────────────────────────────────── */
const TYPE_COLOR: Record<AgentType, string> = {
  CoTAgent: "#3b82f6",
  SCAgent: "#7c3aed",
  DebateAgent: "#f59e0b",
  ReflexionAgent: "#10b981",
  WebSearchAgent: "#ef4444",
  CustomAgent: "#ec4899",
};

/* ────────────────────────────────────────────────────────────────
   TopBar — integrated brand + affiliations + link icons + toggles
   ──────────────────────────────────────────────────────────────── */
function TopBar({
  onToggleLeft,
  onToggleRight,
  onReset,
  showGraphToggle,
}: {
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onReset: () => void;
  showGraphToggle: boolean;
}) {
  return (
    <header className="h-14 border-b bg-white flex items-center px-3 gap-3 flex-none">
      <button onClick={onToggleLeft} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" title="Toggle sidebar">
        <I.Menu className="w-4 h-4" />
      </button>
      <button
        onClick={onReset}
        title="Home"
        className="flex items-center gap-2.5 px-1.5 py-1 -mx-1.5 rounded-md hover:bg-gray-100 transition-colors"
      >
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white text-[11px] font-bold flex-none">MO</div>
        <div className="leading-tight text-left">
          <div className="text-sm font-semibold text-gray-900">MAS-Orchestra</div>
          <div className="flex items-center gap-1.5 text-[10px] leading-none mt-1">
            <span style={{ color: "#00A1E0" }}>Salesforce AI</span>
            <span className="text-gray-300">·</span>
            <span style={{ color: "#A31F34" }}>MIT</span>
            <span className="text-gray-300">·</span>
            <span style={{ color: "#C5050C" }}>UW Madison</span>
          </div>
        </div>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <a href="https://github.com/SalesforceAIResearch/MAS-Orchestra" target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-100">
          <I.GitHub className="w-3.5 h-3.5" /> GitHub
        </a>
        <a href="https://arxiv.org/abs/2601.14652" target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-100">
          <I.Paper className="w-3.5 h-3.5" /> Paper
        </a>
        <a href="https://vincent950129.github.io/mas-design/mas_r1/" target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-100">
          <I.Globe className="w-3.5 h-3.5" /> Project
        </a>
        {showGraphToggle && (
          <button onClick={onToggleRight} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" title="Toggle graph panel">
            <I.Panel className="w-4 h-4" />
          </button>
        )}
      </div>
    </header>
  );
}

/* ────────────────────────────────────────────────────────────────
   LeftSidebar — settings
   ──────────────────────────────────────────────────────────────── */
function LeftSidebar({
  mode, onModeChange,
  dom, onDomChange,
  subagentModel, onSubagentChange,
  disabled,
}: {
  mode: Mode; onModeChange: (m: Mode) => void;
  dom: DomLevel; onDomChange: (d: DomLevel) => void;
  subagentModel: SubagentModel; onSubagentChange: (m: SubagentModel) => void;
  disabled: boolean;
}) {
  return (
    <div className="h-full w-60 p-4 space-y-5 overflow-y-auto">
      <div>
        <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-2">Mode</div>
        <div className="space-y-1">
          {MODES.map(m => (
            <label key={m.value} className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}>
              <input
                type="radio"
                name="mode"
                checked={mode === m.value}
                onChange={() => !disabled && onModeChange(m.value)}
                disabled={disabled}
                className="accent-blue-600"
              />
              <span className="text-gray-700">{m.label}</span>
            </label>
          ))}
        </div>
      </div>

      {mode === "custom" && (
        <div>
          <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-2">Degree of MAS</div>
          <div className="inline-flex flex-wrap gap-1 p-0.5 rounded-md border bg-white">
            {DOM_OPTIONS.map(d => (
              <button
                key={d.value}
                onClick={() => !disabled && onDomChange(d.value)}
                disabled={disabled}
                className={`px-2 py-1 text-[11px] rounded transition-colors ${
                  dom === d.value ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                }`}
                title={d.hint || undefined}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-2">Sub-agent model</div>
        <select
          value={subagentModel}
          onChange={e => onSubagentChange(e.target.value as SubagentModel)}
          className="w-full text-sm border rounded-md px-2 py-1.5 bg-white focus:ring-1 focus:ring-blue-400 focus:outline-none"
        >
          {SUBAGENT_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      <details className="group">
        <summary className="flex items-center justify-between cursor-pointer list-none text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-2 select-none">
          <span>Agent types</span>
          <I.Chev className="w-3 h-3 text-gray-400 transition-transform group-open:rotate-90" />
        </summary>
        <div className="space-y-1.5 mt-1">
          {AGENT_POOL.map(a => (
            <div key={a.type} className="text-[11px]">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: TYPE_COLOR[a.type as AgentType] || "#9ca3af" }} />
                <span className="font-medium text-gray-700">{a.type.replace("Agent", "")}</span>
              </div>
              <div className="text-[10.5px] text-gray-400 leading-snug ml-3.5 mt-0.5">{a.description}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   ProgressRail — inline at top of main column
   ──────────────────────────────────────────────────────────────── */
function ProgressRail({
  stage, planAgents, agentStates, isLoading, isDirect,
  canExecute, onExecute, onRerun,
  planHistory, activePlan, onSwitchPlan,
}: {
  stage: "plan" | "execute" | "result";
  planAgents: number;
  agentStates: Record<string, AgentState>;
  isLoading: boolean;
  isDirect: boolean;
  canExecute: boolean;
  onExecute: () => void;
  onRerun: () => void;
  planHistory: Plan[];
  activePlan: Plan | null;
  onSwitchPlan: (p: Plan) => void;
}) {
  const done = Object.values(agentStates).filter(a => a.status === "completed" || a.status === "failed").length;
  const running = Object.values(agentStates).some(a => a.status === "running");

  let label = "";
  if (isDirect) label = "Direct solution";
  else if (stage === "plan") label = isLoading ? "Designing plan…" : `Plan · ${planAgents} agents`;
  else if (stage === "execute") label = `Executing · ${done} / ${planAgents} agents`;
  else label = `Done · ${planAgents} agents`;

  const dot = (s: "input" | "plan" | "execute" | "result") => {
    const order = ["input", "plan", "execute", "result"];
    const curI = order.indexOf(stage);
    const sI = order.indexOf(s);
    if (sI < curI) return "bg-emerald-500";
    if (sI === curI) return running || isLoading ? "bg-amber-400 animate-pulse" : "bg-blue-500";
    return "bg-gray-300";
  };

  return (
    <div className="h-11 border-b bg-white/90 backdrop-blur flex items-center px-5 text-xs text-gray-500 gap-3 flex-none">
      <span className="text-gray-700 font-medium truncate flex-none max-w-[40%]">{label}</span>

      <div className="hidden md:flex items-center gap-1 text-[11px] flex-none">
        <span className={`w-1.5 h-1.5 rounded-full ${dot("input")}`}></span><span>input</span>
        <span className="text-gray-300 mx-0.5">→</span>
        <span className={`w-1.5 h-1.5 rounded-full ${dot("plan")}`}></span><span>plan</span>
        <span className="text-gray-300 mx-0.5">→</span>
        <span className={`w-1.5 h-1.5 rounded-full ${dot("execute")}`}></span><span>execute</span>
        <span className="text-gray-300 mx-0.5">→</span>
        <span className={`w-1.5 h-1.5 rounded-full ${dot("result")}`}></span><span>result</span>
      </div>

      {planHistory.length > 1 && (
        <div className="hidden md:flex items-center gap-1 ml-2 pl-3 border-l border-gray-200 flex-1 min-w-0 overflow-x-auto no-scrollbar">
          <span className="text-[10.5px] text-gray-400 uppercase tracking-wide mr-0.5 flex-none">plan</span>
          {planHistory.map((p, i) => {
            const isActive = p === activePlan || p.xml === activePlan?.xml;
            return (
              <button
                key={i}
                onClick={() => !isActive && onSwitchPlan(p)}
                disabled={stage === "execute" || isLoading}
                className={`px-1.5 py-0.5 text-[11px] font-mono rounded transition-colors flex-none ${
                  isActive
                    ? "bg-gray-900 text-white"
                    : "text-gray-500 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
                }`}
                title={isActive ? "Active — this plan will run" : `Switch to v${i + 1}`}
              >
                v{i + 1}
              </button>
            );
          })}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5 flex-none">
        {!isDirect && stage === "execute" ? (
          <span className="flex items-center gap-1.5 text-[11px] text-amber-700 px-2 py-1 bg-amber-50 border border-amber-200 rounded-md">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Running…
          </span>
        ) : !isDirect && (
          <button
            onClick={stage === "result" ? onRerun : onExecute}
            disabled={!canExecute && stage !== "result"}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300 flex items-center gap-1 shadow-sm"
          >
            Run <I.Arrow className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   EmptyState — hero composer + starter prompts, or dataset picker
   ──────────────────────────────────────────────────────────────── */
const STARTERS = [
  "Find all positive integer triples (a,b,c) with a ≤ b ≤ c and abc = 6(a+b+c).",
  "Prove that for all positive reals x, y, z with xyz = 1: x² + y² + z² ≥ x + y + z.",
  "How many subsets of {1, 2, …, 12} have sum divisible by 5?",
];

function EmptyState({
  mode, dom, onDomChange,
  problem, onProblemChange,
  expected, onExpectedChange,
  onSubmitCustom, onSubmitDataset,
  isLoading,
}: {
  mode: Mode; dom: DomLevel; onDomChange: (d: DomLevel) => void;
  problem: string; onProblemChange: (s: string) => void;
  expected: string; onExpectedChange: (s: string) => void;
  onSubmitCustom: () => void;
  onSubmitDataset: (q: string, a: string) => void;
  isLoading: boolean;
}) {
  const canSubmit = problem.trim().length > 0 && !isLoading;
  const isDataset = mode !== "custom";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="min-h-full flex flex-col items-center justify-center px-5 py-10">
        <div className="max-w-2xl w-full text-center mb-6">
          <h1 className="text-3xl font-semibold text-gray-900 tracking-tight mb-2">
            {isDataset ? "Pick a question to solve" : "What should Orchestra solve?"}
          </h1>
          <p className="text-sm text-gray-500">
            {isDataset
              ? "Orchestra designs a multi-agent plan for the selected problem, then lets you refine it in chat."
              : "Describe a problem. Orchestra designs a multi-agent plan, executes it, and lets you refine in chat."}
          </p>
        </div>

        {!isDataset ? (
          <div className="max-w-2xl w-full">
            <div className="rounded-2xl border border-gray-300 bg-white shadow-sm focus-within:border-gray-400 transition-colors relative">
              <textarea
                rows={3}
                value={problem}
                onChange={e => onProblemChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
                    e.preventDefault();
                    onSubmitCustom();
                  }
                }}
                placeholder="Enter a question…"
                className="w-full resize-none outline-none text-sm leading-relaxed p-4 placeholder:text-gray-400 rounded-t-2xl"
              />
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t bg-gray-50/50 rounded-b-2xl">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="inline-flex gap-0.5 p-0.5 rounded-md border bg-white flex-none">
                    {DOM_OPTIONS.map(d => (
                      <button
                        key={d.value}
                        onClick={() => onDomChange(d.value)}
                        className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                          dom === d.value ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                        }`}
                        title={d.hint || undefined}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <input
                    value={expected}
                    onChange={e => onExpectedChange(e.target.value)}
                    placeholder="expected answer (optional)"
                    className="flex-1 min-w-0 text-[11px] text-gray-500 bg-transparent outline-none placeholder:text-gray-400"
                  />
                </div>
                <button
                  onClick={onSubmitCustom}
                  disabled={!canSubmit}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:bg-gray-300 flex items-center gap-1 flex-none"
                >
                  {isLoading ? "Designing…" : "Design plan"}
                  <I.Arrow className="w-3 h-3" />
                </button>
              </div>
            </div>

            <div className="mt-6">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-2 text-center">or try</div>
              <div className="flex flex-wrap gap-2 justify-center">
                {STARTERS.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => onProblemChange(s)}
                    className="text-xs px-3 py-1.5 rounded-full border bg-white hover:border-blue-300 hover:bg-blue-50/40 transition-colors text-gray-700 max-w-md truncate"
                    title={s}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-2xl w-full">
            <DatasetPicker
              dataset={mode as Dataset}
              onSelect={(q, a) => {
                onProblemChange(q);
                onExpectedChange(a);
                onSubmitDataset(q, a);
              }}
            />
            {isLoading && (
              <div className="mt-3 text-center text-xs text-gray-500 flex items-center justify-center gap-2">
                <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                Designing plan for selected question…
              </div>
            )}
          </div>
        )}

        <div className="mt-10 text-[11px] text-gray-400 text-center">
          Multi-agent orchestration · based on the{" "}
          <a
            href="https://arxiv.org/abs/2601.14652"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-gray-300 hover:decoration-gray-500 hover:text-gray-600 transition-colors"
          >
            MAS-Orchestra paper
          </a>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Tool-call-style agent card (Claude-Code-style, light)
   ──────────────────────────────────────────────────────────────── */
const STRATEGIES: { value: CustomAgentConfig["strategy"]; label: string; hint: string }[] = [
  { value: "single", label: "Single", hint: "One LLM call" },
  { value: "multi_sample", label: "Multi-Sample", hint: "N paths + vote" },
  { value: "critique", label: "Critique", hint: "Critic loop" },
  { value: "pipeline", label: "Pipeline", hint: "Sequential steps" },
];

function StatusChip({ state }: { state: AgentState | undefined }) {
  const status = state?.status ?? "pending";
  if (status === "completed") return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
      <I.Check className="w-3 h-3" /> done
    </span>
  );
  if (status === "running") return (
    <span className="flex items-center gap-1 text-[11px] text-amber-700 font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> running
    </span>
  );
  if (status === "failed") return (
    <span className="flex items-center gap-1 text-[11px] text-red-700 font-medium">
      <I.X className="w-3 h-3" /> failed
    </span>
  );
  return <span className="text-[11px] text-gray-400">queued</span>;
}

function AgentToolCard({
  agent,
  state,
  subagentConfig,
  customConfig,
  onUpdateSub,
  onUpdateCustom,
  locked,
}: {
  agent: Agent;
  state: AgentState | undefined;
  subagentConfig?: SubagentConfig;
  customConfig?: CustomAgentConfig;
  onUpdateSub: (id: string, u: Partial<SubagentConfig>) => void;
  onUpdateCustom: (name: string, u: Partial<CustomAgentConfig>) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = state?.status ?? "pending";
  const color = TYPE_COLOR[agent.type];

  // auto-open running
  useEffect(() => {
    if (status === "running") setOpen(true);
  }, [status]);

  const tone =
    status === "running" ? "border-amber-300 shadow-sm shadow-amber-100" :
    status === "completed" ? "border-gray-200 hover:border-gray-300" :
    status === "failed" ? "border-red-300" :
    "border-gray-200 hover:border-gray-300";

  const headerTint =
    status === "running" ? "bg-amber-50/40" :
    status === "failed" ? "bg-red-50/40" :
    "";

  return (
    <div className={`bg-white border rounded-lg overflow-hidden transition-colors ${tone}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 text-left select-none ${headerTint}`}
      >
        <I.Chev className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-mono text-[11px] text-gray-500">{agent.id}</span>
        <span className="text-xs font-medium" style={{ color }}>{agent.type}</span>
        <span className="text-xs text-gray-500 truncate flex-1">{agent.description}</span>
        <StatusChip state={state} />
      </button>

      {open && (
        <div className="border-t bg-gray-50/40 px-3 py-3 space-y-3">
          {/* Output / Error */}
          {state?.output && (
            <div>
              <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Output</div>
              <pre className="text-xs text-gray-800 bg-white border rounded-md p-2.5 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{state.output}</pre>
            </div>
          )}
          {state?.error && (
            <div>
              <div className="text-[11px] font-medium text-red-600 uppercase tracking-wide mb-1">Error</div>
              <pre className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-md p-2.5 whitespace-pre-wrap break-words">{state.error}</pre>
            </div>
          )}

          {/* Input / depends */}
          {(agent.input || agent.depends_on.length > 0) && (
            <div className="grid grid-cols-1 gap-2">
              {agent.input && (
                <div>
                  <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Input</div>
                  <pre className="text-xs text-gray-700 bg-white border rounded-md p-2 whitespace-pre-wrap break-words">{agent.input}</pre>
                </div>
              )}
              {agent.depends_on.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Depends on</div>
                  <div className="flex flex-wrap gap-1">
                    {agent.depends_on.map(d => (
                      <span key={d} className="font-mono text-[11px] px-1.5 py-0.5 bg-white border rounded text-gray-700">{d}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Config editor — custom agent */}
          {agent.type === "CustomAgent" && customConfig && (
            <fieldset disabled={locked} className={`border-t pt-3 space-y-2 ${locked ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-medium text-pink-600 uppercase tracking-wide">Custom config</div>
                {locked && <span className="text-[10.5px] text-gray-400">Locked during execute</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                {STRATEGIES.map(s => (
                  <button
                    key={s.value}
                    onClick={() => onUpdateCustom(customConfig.name, { strategy: s.value })}
                    className={`px-2 py-1 text-[11px] rounded transition-colors ${
                      customConfig.strategy === s.value ? "bg-pink-600 text-white" : "bg-white border text-gray-600 hover:bg-gray-50"
                    } disabled:cursor-not-allowed`}
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div>
                <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">System prompt</label>
                <textarea
                  defaultValue={customConfig.system_prompt}
                  onBlur={e => { if (e.target.value !== customConfig.system_prompt) onUpdateCustom(customConfig.name, { system_prompt: e.target.value }); }}
                  className="w-full mt-1 px-2 py-1.5 text-xs border rounded-md resize-none focus:ring-1 focus:ring-pink-400 focus:outline-none bg-white disabled:bg-gray-100"
                  rows={3}
                />
              </div>
              {customConfig.strategy === "multi_sample" && (
                <div className="flex items-center gap-2">
                  <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">Samples</label>
                  <input
                    type="number"
                    value={customConfig.num_samples ?? 3}
                    onChange={e => onUpdateCustom(customConfig.name, { num_samples: parseInt(e.target.value) || 3 })}
                    className="w-16 px-2 py-1 text-xs border rounded-md bg-white disabled:bg-gray-100"
                    min={2} max={10}
                  />
                </div>
              )}
              {customConfig.strategy === "critique" && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">Rounds</label>
                    <input
                      type="number"
                      value={customConfig.num_rounds ?? 2}
                      onChange={e => onUpdateCustom(customConfig.name, { num_rounds: parseInt(e.target.value) || 2 })}
                      className="w-16 px-2 py-1 text-xs border rounded-md bg-white disabled:bg-gray-100"
                      min={1} max={5}
                    />
                  </div>
                  <textarea
                    defaultValue={customConfig.critic_prompt ?? ""}
                    onBlur={e => onUpdateCustom(customConfig.name, { critic_prompt: e.target.value })}
                    className="w-full px-2 py-1.5 text-xs border rounded-md resize-none bg-white disabled:bg-gray-100"
                    rows={2}
                    placeholder="Critic instructions…"
                  />
                </>
              )}
              {customConfig.strategy === "pipeline" && (
                <textarea
                  defaultValue={(customConfig.steps ?? []).join("\n")}
                  onBlur={e => onUpdateCustom(customConfig.name, { steps: e.target.value.split("\n").filter(Boolean) })}
                  className="w-full px-2 py-1.5 text-xs font-mono border rounded-md resize-none bg-white disabled:bg-gray-100"
                  rows={3}
                  placeholder={"Step 1: Analyze\nStep 2: Generate\nStep 3: Verify"}
                />
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-700">
                  <input type="checkbox" checked={customConfig.enable_web_search ?? false}
                    onChange={e => onUpdateCustom(customConfig.name, { enable_web_search: e.target.checked })}
                    className="rounded border-gray-300 text-pink-600 focus:ring-pink-400" />
                  Web Search
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-700">
                  <input type="checkbox" checked={customConfig.enable_code_interpreter ?? false}
                    onChange={e => onUpdateCustom(customConfig.name, { enable_code_interpreter: e.target.checked })}
                    className="rounded border-gray-300 text-pink-600 focus:ring-pink-400" />
                  Code Interpreter
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-700">
                  <input type="checkbox" checked={customConfig.enable_think_tool ?? false}
                    onChange={e => onUpdateCustom(customConfig.name, { enable_think_tool: e.target.checked })}
                    className="rounded border-gray-300 text-pink-600 focus:ring-pink-400" />
                  Think Tool
                </label>
              </div>
              {/* MCP */}
              <div className="pt-1 border-t">
                <div className="flex items-center justify-between">
                  <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">MCP Servers</label>
                  <button
                    onClick={() => onUpdateCustom(customConfig.name, {
                      mcp_servers: [...(customConfig.mcp_servers ?? []), { server_label: "", server_url: "", require_approval: "never" as const }],
                    })}
                    className="text-[11px] text-pink-600 hover:text-pink-700 font-medium disabled:cursor-not-allowed"
                  >+ Add</button>
                </div>
                {(customConfig.mcp_servers ?? []).map((m, i) => (
                  <div key={i} className="mt-1.5 p-2 border rounded-md bg-white space-y-1">
                    <div className="flex gap-1.5">
                      <input value={m.server_label}
                        onChange={e => {
                          const next = [...(customConfig.mcp_servers ?? [])];
                          next[i] = { ...next[i], server_label: e.target.value };
                          onUpdateCustom(customConfig.name, { mcp_servers: next });
                        }}
                        placeholder="label"
                        className="flex-1 px-2 py-1 text-xs border rounded-md" />
                      <button onClick={() => {
                        const next = (customConfig.mcp_servers ?? []).filter((_, idx) => idx !== i);
                        onUpdateCustom(customConfig.name, { mcp_servers: next.length ? next : null });
                      }} className="px-1.5 py-1 text-xs text-gray-400 hover:text-red-500">×</button>
                    </div>
                    <input value={m.server_url}
                      onChange={e => {
                        const next = [...(customConfig.mcp_servers ?? [])];
                        next[i] = { ...next[i], server_url: e.target.value };
                        onUpdateCustom(customConfig.name, { mcp_servers: next });
                      }}
                      placeholder="https://mcp.example.com/"
                      className="w-full px-2 py-1 text-xs font-mono border rounded-md" />
                    <select value={m.require_approval ?? "never"}
                      onChange={e => {
                        const next = [...(customConfig.mcp_servers ?? [])];
                        next[i] = { ...next[i], require_approval: e.target.value as "never" | "always" };
                        onUpdateCustom(customConfig.name, { mcp_servers: next });
                      }}
                      className="px-1.5 py-0.5 text-[11px] border rounded-md">
                      <option value="never">no approval</option>
                      <option value="always">always approve</option>
                    </select>
                  </div>
                ))}
              </div>
            </fieldset>
          )}

          {/* Config editor — built-in subagent */}
          {agent.type !== "CustomAgent" && (
            <fieldset disabled={locked} className={`border-t pt-3 space-y-2 ${locked ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Overrides</div>
                {locked && <span className="text-[10.5px] text-gray-400">Locked during execute</span>}
              </div>
              <div>
                <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">System prompt</label>
                <textarea
                  defaultValue={subagentConfig?.system_prompt ?? ""}
                  onBlur={e => { const v = e.target.value; if (v !== (subagentConfig?.system_prompt ?? "")) onUpdateSub(agent.id, { system_prompt: v || undefined }); }}
                  placeholder={`Leave blank for default. Role: ${agent.description}`}
                  className="w-full mt-1 px-2 py-1.5 text-xs border rounded-md resize-none bg-white"
                  rows={2}
                />
              </div>
              {agent.type === "SCAgent" && (
                <div className="flex items-center gap-2">
                  <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">Samples</label>
                  <input
                    type="number"
                    value={subagentConfig?.num_samples ?? 5}
                    onChange={e => onUpdateSub(agent.id, { num_samples: parseInt(e.target.value) || 5 })}
                    className="w-16 px-2 py-1 text-xs border rounded-md bg-white"
                    min={2} max={10}
                  />
                </div>
              )}
              {agent.type === "ReflexionAgent" && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">Rounds</label>
                    <input
                      type="number"
                      value={subagentConfig?.num_rounds ?? 3}
                      onChange={e => onUpdateSub(agent.id, { num_rounds: parseInt(e.target.value) || 3 })}
                      className="w-16 px-2 py-1 text-xs border rounded-md bg-white"
                      min={1} max={5}
                    />
                  </div>
                  <div>
                    <label className="text-[10.5px] font-medium text-gray-500 uppercase tracking-wide">Critic prompt</label>
                    <textarea
                      defaultValue={subagentConfig?.critic_prompt ?? ""}
                      onBlur={e => { const v = e.target.value; if (v !== (subagentConfig?.critic_prompt ?? "")) onUpdateSub(agent.id, { critic_prompt: v || undefined }); }}
                      className="w-full mt-1 px-2 py-1.5 text-xs border rounded-md resize-none bg-white"
                      rows={2}
                    />
                  </div>
                </>
              )}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Chat turns
   ──────────────────────────────────────────────────────────────── */
function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "user") {
    return <div className="w-7 h-7 rounded-md bg-gray-800 text-white text-[10px] font-bold flex items-center justify-center flex-none">You</div>;
  }
  return <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-blue-600 text-white text-[10px] font-bold flex items-center justify-center flex-none">MO</div>;
}

function UserTurn({ content }: { content: string }) {
  return (
    <div className="flex items-start gap-3">
      <Avatar role="user" />
      <div className="flex-1">
        <div className="text-xs text-gray-500 mb-1">You</div>
        <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{content}</div>
      </div>
    </div>
  );
}

function AssistantPlanTurn({
  content, plan, versionLabel,
  agentStates, customAgents, subagentConfigs,
  onUpdateCustom, onUpdateSub,
  onViewGraph, locked,
}: {
  content: string;
  plan: Plan;
  versionLabel: string;
  agentStates: Record<string, AgentState>;
  customAgents: CustomAgentConfig[];
  subagentConfigs: Record<string, SubagentConfig>;
  onUpdateCustom: (name: string, u: Partial<CustomAgentConfig>) => void;
  onUpdateSub: (id: string, u: Partial<SubagentConfig>) => void;
  onViewGraph: () => void;
  locked: boolean;
}) {
  const agents = plan.graph.agents;
  const isDirect = !!plan.graph.direct_solution;
  const COLLAPSE_THRESHOLD = 6;
  const [showAll, setShowAll] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [xmlOpen, setXmlOpen] = useState(false);
  // Force-open during execute so running status is visible.
  const listExpanded = listOpen || locked;
  const expanded = showAll || locked;
  const hiddenCount = Math.max(0, agents.length - COLLAPSE_THRESHOLD);
  const visibleAgents = expanded || hiddenCount === 0 ? agents : agents.slice(0, COLLAPSE_THRESHOLD);
  const statusCounts = {
    running: Object.values(agentStates).filter(s => s.status === "running").length,
    completed: Object.values(agentStates).filter(s => s.status === "completed").length,
    failed: Object.values(agentStates).filter(s => s.status === "failed").length,
  };

  return (
    <div className="flex items-start gap-3">
      <Avatar role="assistant" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-500 mb-1">Orchestra <span className="text-gray-300">·</span> designed plan <span className="text-gray-300">·</span> {versionLabel}</div>
        <div className="text-sm text-gray-800 leading-relaxed mb-3 whitespace-pre-wrap">{content}</div>

        {isDirect && plan.graph.direct_solution && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-gray-800 whitespace-pre-wrap">
            <div className="text-[11px] text-amber-700 font-medium uppercase tracking-wide mb-1">Direct solution</div>
            {plan.graph.direct_solution}
          </div>
        )}

        {!isDirect && agents.length > 0 && (
          <div className="border rounded-lg bg-white overflow-hidden">
            <button
              onClick={() => !locked && setListOpen(o => !o)}
              disabled={locked}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 disabled:hover:bg-transparent text-left"
            >
              <I.Chev className={`w-3 h-3 text-gray-400 transition-transform flex-none ${listExpanded ? "rotate-90" : ""}`} />
              <span className="text-xs font-medium text-gray-700">Agent plan</span>
              <span className="text-[11px] text-gray-400">· {agents.length} agent{agents.length !== 1 ? "s" : ""}</span>
              {statusCounts.running > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-amber-700 ml-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {statusCounts.running} running
                </span>
              )}
              {statusCounts.completed > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-700 ml-1">
                  <I.Check className="w-3 h-3" /> {statusCounts.completed} done
                </span>
              )}
              {statusCounts.failed > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-red-700 ml-1">
                  <I.X className="w-3 h-3" /> {statusCounts.failed} failed
                </span>
              )}
              <span
                onClick={e => { e.stopPropagation(); setXmlOpen(x => !x); }}
                role="button"
                className="ml-auto text-[11px] text-gray-500 hover:text-gray-700 px-2 py-0.5 rounded hover:bg-gray-100 font-mono"
                title="View raw plan XML"
              >
                {xmlOpen ? "Hide XML" : "View XML"}
              </span>
              <span
                onClick={e => { e.stopPropagation(); onViewGraph(); }}
                role="button"
                className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-0.5 rounded hover:bg-gray-100"
              >
                View graph ↗
              </span>
            </button>

            {xmlOpen && (
              <div className="border-t bg-gray-900 relative">
                <button
                  onClick={() => navigator.clipboard?.writeText(plan.xml)}
                  className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-300 border border-gray-700 rounded hover:bg-gray-700 z-10"
                  title="Copy XML"
                >
                  Copy
                </button>
                <pre className="text-[11px] text-gray-100 p-3 pr-14 overflow-x-auto max-h-[400px] font-mono leading-relaxed whitespace-pre">{plan.xml}</pre>
              </div>
            )}

            {listExpanded && (
              <div className="border-t px-2 py-2 space-y-1.5 bg-gray-50/30">
                {visibleAgents.map(a => (
                  <AgentToolCard
                    key={a.id}
                    agent={a}
                    state={agentStates[a.id]}
                    subagentConfig={subagentConfigs[a.id]}
                    customConfig={customAgents.find(c => c.name === a.id)}
                    onUpdateSub={onUpdateSub}
                    onUpdateCustom={onUpdateCustom}
                    locked={locked}
                  />
                ))}
                {hiddenCount > 0 && !expanded && (
                  <button
                    onClick={() => setShowAll(true)}
                    className="w-full py-2 text-xs text-gray-500 hover:text-gray-700 border border-dashed rounded-lg hover:bg-white transition-colors"
                  >
                    Show {hiddenCount} more agent{hiddenCount === 1 ? "" : "s"} ↓
                  </button>
                )}
                {hiddenCount > 0 && expanded && !locked && (
                  <button
                    onClick={() => setShowAll(false)}
                    className="w-full py-1.5 text-[11px] text-gray-400 hover:text-gray-600"
                  >
                    Collapse ↑
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMessageTurn({ content }: { content: string }) {
  return (
    <div className="flex items-start gap-3">
      <Avatar role="assistant" />
      <div className="flex-1">
        <div className="text-xs text-gray-500 mb-1">Orchestra</div>
        <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{content}</div>
      </div>
    </div>
  );
}

function AssistantAnswerTurn({
  answer, onCopy, onRerun, isExecuting, versionLabel, isLatest,
}: {
  answer: string;
  onCopy: () => void; onRerun: () => void;
  isExecuting: boolean;
  versionLabel: string;
  isLatest: boolean;
}) {
  const [open, setOpen] = useState(isLatest);
  useEffect(() => { setOpen(isLatest); }, [isLatest]);

  return (
    <div className="flex items-start gap-3">
      <Avatar role="assistant" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-500 mb-1">Orchestra <span className="text-gray-300">·</span> answer <span className="text-gray-300">·</span> {versionLabel}</div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 overflow-hidden">
          <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-emerald-50 transition-colors">
            <I.Chev className={`w-3 h-3 text-emerald-600 transition-transform flex-none ${open ? "rotate-90" : ""}`} />
            <div className="text-xs text-emerald-700 font-medium uppercase tracking-wide">Answer</div>
            <span className="text-[11px] text-emerald-700/70">{versionLabel}</span>
            {!open && (
              <span className="text-xs text-gray-700 truncate ml-1">· {answer.slice(0, 80)}{answer.length > 80 ? "…" : ""}</span>
            )}
          </button>
          {open && (
            <div className="px-4 pb-3">
              <div className="text-sm text-gray-900 whitespace-pre-wrap leading-relaxed">{answer}</div>
            </div>
          )}
        </div>
        {open && (
          <div className="flex items-center gap-1.5 mt-2">
            <button onClick={onRerun} disabled={isExecuting}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border bg-white hover:bg-gray-50 disabled:opacity-50">
              <I.Refresh className="w-3 h-3" /> Re-run
            </button>
            <button onClick={onCopy}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border bg-white hover:bg-gray-50">
              <I.Copy className="w-3 h-3" /> Copy
            </button>
            {isLatest && <span className="text-[11px] text-gray-400 ml-auto">Ask in the composer below to refine.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   ChatSpine — the main scrolling conversation
   ──────────────────────────────────────────────────────────────── */
function ChatSpine({
  messages, agentStates, isRefining,
  isExecuting,
  customAgents, subagentConfigs,
  onUpdateCustom, onUpdateSub,
  onRerun, onCopy,
  onExpandGraph,
}: {
  messages: ChatMessage[];
  agentStates: Record<string, AgentState>;
  isRefining: boolean;
  isExecuting: boolean;
  customAgents: CustomAgentConfig[];
  subagentConfigs: Record<string, SubagentConfig>;
  onUpdateCustom: (name: string, u: Partial<CustomAgentConfig>) => void;
  onUpdateSub: (id: string, u: Partial<SubagentConfig>) => void;
  onRerun: () => void;
  onCopy: () => void;
  onExpandGraph: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, agentStates]);

  let planVersion = 0;
  let answerVersion = 0;
  const latestPlanIdx = messages.map(m => !!m.plan).lastIndexOf(true);
  const latestAnswerIdx = messages.map(m => !!m.isAnswer).lastIndexOf(true);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
      {messages.map((msg, i) => {
        if (msg.plan) planVersion++;
        if (msg.isAnswer) answerVersion++;
        const isLatestPlan = i === latestPlanIdx;
        const isLatestAnswer = i === latestAnswerIdx;
        return (
          <div key={i} className="max-w-3xl mx-auto">
            {msg.role === "user" ? (
              <UserTurn content={msg.content} />
            ) : msg.plan ? (
              <AssistantPlanTurn
                content={msg.content}
                plan={msg.plan}
                versionLabel={`v${planVersion}`}
                agentStates={isLatestPlan ? agentStates : {}}
                customAgents={customAgents}
                subagentConfigs={subagentConfigs}
                onUpdateCustom={onUpdateCustom}
                onUpdateSub={onUpdateSub}
                onViewGraph={onExpandGraph}
                locked={isLatestPlan && isExecuting}
              />
            ) : msg.isAnswer ? (
              <AssistantAnswerTurn
                answer={msg.content}
                onCopy={onCopy}
                onRerun={onRerun}
                isExecuting={isExecuting}
                versionLabel={`v${answerVersion}`}
                isLatest={isLatestAnswer}
              />
            ) : (
              <AssistantMessageTurn content={msg.content} />
            )}
          </div>
        );
      })}

      {isRefining && (
        <div className="max-w-3xl mx-auto">
          <div className="flex items-start gap-3">
            <Avatar role="assistant" />
            <div className="flex-1 flex items-center gap-1.5 py-2">
              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Composer — bottom input with slash shortcuts + Enter-to-send
   ──────────────────────────────────────────────────────────────── */
const COMPOSER_EXAMPLES = [
  "add and parallelize 10 agents",
  "design a custom agent that verifies citations",
  "remove the reflexion step and reconnect",
  "swap the summarizer for a DebateAgent",
  "add a WebSearchAgent before the analyzer",
];

function Composer({
  value, onChange, onSubmit, disabled,
  subagentModel, onCancel, canCancel,
  pendingQueue, onEditQueued, onRemoveQueued,
}: {
  value: string; onChange: (s: string) => void; onSubmit: () => void;
  disabled: boolean;
  subagentModel: SubagentModel;
  onCancel: () => void; canCancel: boolean;
  pendingQueue: string[];
  onEditQueued: (i: number, t: string) => void;
  onRemoveQueued: (i: number) => void;
}) {
  const canSend = value.trim().length > 0;
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [queueOpen, setQueueOpen] = useState(true);

  const submitAndRefocus = () => {
    if (!canSend) return;
    onSubmit();
    requestAnimationFrame(() => taRef.current?.focus());
  };
  const [exampleIdx, setExampleIdx] = useState(() => Math.floor(Math.random() * COMPOSER_EXAMPLES.length));
  useEffect(() => {
    const id = setInterval(() => setExampleIdx(i => (i + 1) % COMPOSER_EXAMPLES.length), 3500);
    return () => clearInterval(id);
  }, []);
  const placeholder = `Try: "${COMPOSER_EXAMPLES[exampleIdx]}"`;

  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 192) + "px";
  }, [value]);

  const commitEdit = () => {
    if (editingIdx === null) return;
    const v = editValue.trim();
    if (!v) onRemoveQueued(editingIdx);
    else onEditQueued(editingIdx, v);
    setEditingIdx(null);
    setEditValue("");
  };

  return (
    <div className="border-t bg-white flex-none">
      <div className="px-5 py-3">
        {pendingQueue.length > 0 && (
          <div className="mb-2 space-y-1">
            <button
              onClick={() => setQueueOpen(o => !o)}
              className="flex items-center gap-1.5 text-[10.5px] text-gray-500 uppercase tracking-wide hover:text-gray-700"
            >
              <svg className={`w-2.5 h-2.5 transition-transform ${queueOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" />
              </svg>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Queued · {pendingQueue.length}
            </button>
            {queueOpen && pendingQueue.map((msg, i) => (
              <div key={i} className="flex items-start gap-1.5 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-2.5 py-1.5">
                {editingIdx === i ? (
                  <textarea
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                      if (e.key === "Escape") { setEditingIdx(null); setEditValue(""); }
                    }}
                    onBlur={commitEdit}
                    rows={1}
                    className="flex-1 resize-none outline-none text-sm bg-white border border-gray-300 rounded px-2 py-1 leading-relaxed"
                  />
                ) : (
                  <div className="flex-1 text-sm text-gray-700 leading-relaxed break-words min-w-0">{msg}</div>
                )}
                <div className="flex items-center gap-0.5 flex-none mt-0.5">
                  <button
                    onClick={() => { setEditingIdx(i); setEditValue(msg); }}
                    className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-200"
                    title="Edit"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onRemoveQueued(i)}
                    className="p-1 text-gray-400 hover:text-red-600 rounded hover:bg-red-50"
                    title="Remove"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 focus-within:border-gray-400 transition-colors">
          <textarea
            ref={taRef}
            rows={1}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitAndRefocus();
              }
            }}
            placeholder={disabled ? "Queue a message while this runs…" : placeholder}
            className="flex-1 resize-none outline-none text-sm placeholder:text-gray-400 leading-relaxed min-h-[24px] max-h-48 bg-transparent overflow-y-auto"
          />
          <div className="flex items-center gap-1 flex-none">
            {canCancel && (
              <button onClick={onCancel}
                className="px-2.5 py-1.5 rounded-md bg-red-500 text-white text-xs font-medium hover:bg-red-600">
                Cancel
              </button>
            )}
            <button
              onClick={submitAndRefocus}
              disabled={!canSend}
              className="px-2.5 py-1.5 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:bg-gray-300 flex items-center gap-1"
            >
              {disabled ? "Queue" : "Send"} <I.Send className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between mt-1.5 text-[11px] text-gray-400">
          <div>Enter to send · Shift+Enter for newline</div>
          <div>{SUBAGENT_MODELS.find(m => m.value === subagentModel)?.label ?? subagentModel}</div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   RightSidebar — mini graph peek
   ──────────────────────────────────────────────────────────────── */
function RightSidebar({
  graph, agentStates, onExpand, onUndo, onRedo, canUndo, canRedo,
}: {
  graph: Plan["graph"]; agentStates: Record<string, AgentState>;
  onExpand: () => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
}) {
  return (
    <div className="h-full flex flex-col w-[340px]">
      <div className="h-9 border-b flex items-center px-3 text-xs text-gray-500 gap-1 flex-none">
        <span className="font-medium text-gray-700">Graph</span>
        <span className="text-gray-400">· {graph.agents.length} agents</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={onUndo} disabled={!canUndo} title="Undo"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-default text-gray-500">
            <I.Undo className="w-3.5 h-3.5" />
          </button>
          <button onClick={onRedo} disabled={!canRedo} title="Redo"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-default text-gray-500">
            <I.Redo className="w-3.5 h-3.5" />
          </button>
          <button onClick={onExpand} title="Expand"
            className="p-1 rounded hover:bg-gray-100 text-gray-500">
            <I.Expand className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-gray-50">
        <GraphViewer graph={graph} agentStates={agentStates} hideExpandButton />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   App shell
   ──────────────────────────────────────────────────────────────── */
export default function App() {
  const orch = useOrchestration();
  const {
    stage, plan, graph, agentStates, finalAnswer, error, isLoading, isRefining,
    subagentModel, chatMessages, undoStack, redoStack, customAgents, subagentConfigs,
    pendingQueue,
    generatePlan, executePlan, cancelExecution, cancelRefine, undoPlan, redoPlan,
    queueRefine, editQueued, removeQueued,
    switchToPlan, updateCustomAgent, updateSubagentConfig, setSubagentModel, reset,
  } = orch;

  const planHistory: Plan[] = chatMessages.filter(m => m.plan).map(m => m.plan!);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [input, setInput] = useState({ problem: "", expected: "", mode: "custom" as Mode, dom: "high" as DomLevel });
  const [chatInput, setChatInput] = useState("");
  const [expandedGraph, setExpandedGraph] = useState(false);

  const hasConversation = plan !== null;
  const stageKey: "plan" | "execute" | "result" =
    stage === "execute" ? "execute" : stage === "result" ? "result" : "plan";

  const submitCustom = () => {
    if (!input.problem.trim()) return;
    generatePlan(input.problem.trim(), null, input.dom, input.expected.trim());
  };

  const submitDataset = (question: string, answer: string) => {
    const dataset = input.mode as Dataset;
    const dom = DATASETS.find(d => d.value === dataset)?.dom ?? "high";
    generatePlan(question, dataset, dom, answer);
  };

  const handleRefine = () => {
    const v = chatInput.trim();
    if (!v) return;
    queueRefine(v);
    setChatInput("");
  };

  const handleCopy = () => {
    if (finalAnswer) navigator.clipboard?.writeText(finalAnswer);
  };

  const handleReset = () => {
    reset();
    setInput({ problem: "", expected: "", mode: "custom", dom: "high" });
    setChatInput("");
  };

  const canExecute = !!plan && !isLoading && !isRefining && stage === "plan";

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <TopBar
        onToggleLeft={() => setLeftOpen(v => !v)}
        onToggleRight={() => setRightOpen(v => !v)}
        onReset={handleReset}
        showGraphToggle={hasConversation && !!graph && !expandedGraph}
      />

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <aside className={`border-r bg-white overflow-hidden transition-[width] duration-200 flex-none ${leftOpen ? "w-60" : "w-0"}`}>
          <LeftSidebar
            mode={input.mode}
            onModeChange={m => setInput(s => ({ ...s, mode: m }))}
            dom={input.dom}
            onDomChange={d => setInput(s => ({ ...s, dom: d }))}
            subagentModel={subagentModel}
            onSubagentChange={setSubagentModel}
            disabled={hasConversation}
          />
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col min-w-0 bg-gray-50">
          {error && (
            <div className="mx-5 mt-3 p-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
              {error}
            </div>
          )}

          {!hasConversation ? (
            <EmptyState
              mode={input.mode}
              dom={input.dom} onDomChange={d => setInput(s => ({ ...s, dom: d }))}
              problem={input.problem} onProblemChange={p => setInput(s => ({ ...s, problem: p }))}
              expected={input.expected} onExpectedChange={e => setInput(s => ({ ...s, expected: e }))}
              onSubmitCustom={submitCustom}
              onSubmitDataset={submitDataset}
              isLoading={isLoading}
            />
          ) : expandedGraph && graph ? (
            <>
              <div className="h-11 border-b bg-white flex items-center px-4 gap-2 flex-none">
                <span className="text-sm font-medium text-gray-700">Multi-agent System (MAS)</span>
                <span className="text-xs text-gray-400">· {graph.agents.length} agents</span>
                <button onClick={() => setExpandedGraph(false)}
                  className="ml-auto text-xs px-2.5 py-1 rounded-md border bg-white hover:bg-gray-50 text-gray-600">
                  Close
                </button>
              </div>
              <div className="flex-1 min-h-0 bg-gray-50">
                <GraphViewer graph={graph} agentStates={agentStates} hideExpandButton showMiniMap />
              </div>
            </>
          ) : (
            <>
              <ProgressRail
                stage={stageKey}
                planAgents={plan?.graph.agents.length ?? 0}
                agentStates={agentStates}
                isLoading={isLoading || isRefining}
                isDirect={!!plan?.graph.direct_solution}
                canExecute={canExecute}
                onExecute={executePlan}
                onRerun={executePlan}
                planHistory={planHistory}
                activePlan={plan}
                onSwitchPlan={switchToPlan}
              />
              <ChatSpine
                messages={chatMessages}
                agentStates={agentStates}
                isRefining={isRefining}
                isExecuting={stage === "execute" && isLoading}
                customAgents={customAgents}
                subagentConfigs={subagentConfigs}
                onUpdateCustom={updateCustomAgent}
                onUpdateSub={updateSubagentConfig}
                onRerun={executePlan}
                onCopy={handleCopy}
                onExpandGraph={() => setExpandedGraph(true)}
              />
              <Composer
                value={chatInput}
                onChange={setChatInput}
                onSubmit={handleRefine}
                disabled={isRefining || (stage === "execute" && isLoading)}
                subagentModel={subagentModel}
                onCancel={isRefining ? cancelRefine : cancelExecution}
                canCancel={isRefining || (stage === "execute" && isLoading)}
                pendingQueue={pendingQueue}
                onEditQueued={editQueued}
                onRemoveQueued={removeQueued}
              />
            </>
          )}
        </main>

        {/* Right sidebar (hidden in expanded graph mode to avoid duplicate graphs) */}
        {hasConversation && graph && !expandedGraph && (
          <aside className={`border-l bg-white overflow-hidden transition-[width] duration-200 flex-none ${rightOpen ? "w-[340px]" : "w-0"}`}>
            <RightSidebar
              graph={graph}
              agentStates={agentStates}
              onExpand={() => setExpandedGraph(true)}
              onUndo={undoPlan}
              onRedo={redoPlan}
              canUndo={undoStack.length > 0 && !isRefining && !(stage === "execute" && isLoading)}
              canRedo={redoStack.length > 0 && !isRefining && !(stage === "execute" && isLoading)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
