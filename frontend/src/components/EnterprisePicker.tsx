import { useEffect, useMemo, useRef, useState } from "react";
import type { DomLevel, EnterpriseDomain, EnterpriseTask, ToolSummary } from "../types";
import { DOM_OPTIONS } from "../types";

// Show this many curated task chips by default under the hero. "Show all"
// reveals the full catalog (which can be 80+ tasks per domain).
const VISIBLE_CHIP_CAP = 6;

/** True if an error came from an aborted fetch — either an explicit
 *  ``AbortError`` (DOMException) or the browser's generic "Failed to fetch"
 *  TypeError that fires when the connection is torn down mid-flight. We
 *  silently ignore both because they are benign side-effects of the React
 *  StrictMode double-effect or a quick mode-toggle by the user. */
function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof DOMException && e.name === "AbortError") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /aborted|abort|Failed to fetch|NetworkError/i.test(msg);
}

interface Props {
  // DoM is owned by the LeftSidebar (shared with reasoning mode); the
  // EnterprisePicker mirrors the same control inline so the user can
  // tweak it right next to the prompt without scrolling away.
  dom: DomLevel;
  onDomChange: (d: DomLevel) => void;
  // Fired the moment the user picks a domain. Used to load a generic
  // sandbox preview into the 5th column so the user can see the
  // environment before writing a query or picking a task.
  onDomainPreview?: (domain: string) => void;
  // Fired the moment the user picks a curated task. Loads a
  // task-specific snapshot (richer than the domain preview).
  onPreview?: (task: EnterpriseTask) => void;
  onSubmit: (task: EnterpriseTask, enabledTools: string[], dom: DomLevel) => void;
  isLoading: boolean;
}

const DOM_HINTS: Record<DomLevel, string> = {
  low: "Low complexity → minimal mutations, no extra reads (1–3 MCPAgents).",
  high: "High complexity → balanced plan with grounding reads (3–6 MCPAgents).",
  high_extensive: "Extensive → bracket every mutation with reads (5–10 MCPAgents).",
};

/** EnterprisePicker — domain tabs → hero query box → "or try" curated
 *  task chips.
 *
 *  Mirrors the look-and-feel of the reasoning-mode EmptyState: the
 *  primary action is the free-form textarea + DoM + Design plan button,
 *  with curated tasks demoted to one-click examples below.
 *
 *  Selecting a curated chip pre-fills the textarea AND remembers the
 *  oracle task id (so verifiers stay available). Editing the textarea
 *  clears the oracle link and the request becomes a custom query.
 *
 *  Submission paths:
 *    - oracle task selected + prompt unchanged → POST /plan with
 *      ``enterprise_task_id`` so verifier_count survives.
 *    - otherwise → POST /enterprise/custom-task first to register an
 *      ephemeral task with ALL tools enabled, then proceed as above.
 */
export function EnterprisePicker({
  dom, onDomChange,
  onDomainPreview, onPreview,
  onSubmit, isLoading,
}: Props) {
  const [domains, setDomains] = useState<EnterpriseDomain[]>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [tasks, setTasks] = useState<EnterpriseTask[]>([]);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [toolFilter, setToolFilter] = useState("");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-domain task counts shown in the domain selector badges. Loaded
  // alongside the domain list via /enterprise/task-counts.
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [taskFilter, setTaskFilter] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);
  // Free-form query (also pre-filled by clicking a curated chip).
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Bumped each time the user types in the prompt textarea; used to
  // detect "the prompt no longer matches the curated task" and demote
  // the request to a custom query on submit.
  const promptDirty = useRef(false);

  // 1. Load the domain catalog + per-domain task counts once.
  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      fetch("/enterprise/domains", { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch("/enterprise/task-counts", { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : { counts: {} })
        .catch(() => ({ counts: {} })),
    ])
      .then(([d, c]) => {
        setDomains(d.domains || []);
        setTaskCounts(c.counts || {});
        if (d.domains?.length) setDomain(prev => prev ?? d.domains[0].name);
      })
      .catch(e => {
        if (!isAbortError(e)) setError(`Failed to load domains: ${e}`);
      });
    return () => ctrl.abort();
  }, []);

  // 2. Load tasks + tools whenever the chosen domain changes, AND fire
  //    the domain-preview callback so the 5th column shows the
  //    environment immediately (without waiting for a task pick).
  useEffect(() => {
    if (!domain) return;
    const ctrl = new AbortController();
    setSelectedTaskId(null);
    setEnabledTools(new Set());
    setTaskFilter("");
    setShowAllTasks(false);
    setPrompt("");
    promptDirty.current = false;
    setError(null);
    onDomainPreview?.(domain);
    Promise.all([
      fetch(`/enterprise/tasks?domain=${domain}`, { signal: ctrl.signal }).then(r => r.json()),
      fetch(`/enterprise/tools?domain=${domain}`, { signal: ctrl.signal }).then(r => r.json()),
    ])
      .then(([t, l]) => {
        if (ctrl.signal.aborted) return;
        setTasks(t.tasks || []);
        setTools(l.tools || []);
      })
      .catch(e => {
        if (!isAbortError(e)) setError(`Failed to load tasks for ${domain}: ${e}`);
      });
    return () => ctrl.abort();
  // We intentionally don't include `onDomainPreview` to avoid re-firing
  // the preview every time App.tsx re-renders with a new callback ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  /** Click a curated chip → pre-fill prompt + remember oracle id. */
  const pickCuratedTask = (t: EnterpriseTask) => {
    setSelectedTaskId(t.id);
    setPrompt(t.user_prompt);
    promptDirty.current = false;
    setEnabledTools(new Set(t.default_tools));
    onPreview?.(t);
  };

  const toggleTool = (name: string) => {
    setEnabledTools(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /** Treat the request as "linked to the selected curated task" only
   *  while the user hasn't edited the prompt. Editing demotes it to a
   *  custom query so the planner gets the user's actual text. */
  const linkedToOracle = selectedTask
    && !promptDirty.current
    && prompt.trim() === selectedTask.user_prompt.trim();

  /** Submit either an oracle task or a freshly-registered custom task. */
  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || !domain) return;
    setError(null);
    // Path 1 — oracle task with intact prompt: send the original
    // EnterpriseTask so verifier_count survives end-to-end.
    if (linkedToOracle && selectedTask) {
      const enabled = enabledTools.size ? [...enabledTools] : [...selectedTask.default_tools];
      onSubmit(selectedTask, enabled, dom);
      return;
    }
    // Path 2 — custom query: POST /enterprise/custom-task to register
    // an ephemeral task with the full tool catalog enabled, then submit.
    setSubmitting(true);
    try {
      const res = await fetch("/enterprise/custom-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, user_prompt: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const task: EnterpriseTask = await res.json();
      setTasks(prev => [task, ...prev.filter(t => t.id !== task.id)]);
      setSelectedTaskId(task.id);
      const allTools = new Set<string>(tools.map(t => t.name));
      // If the user manually adjusted tools we keep their selection;
      // otherwise default to ALL tools for a free-form query.
      const enabled = enabledTools.size > 0 && !linkedToOracle ? [...enabledTools] : [...allTools];
      setEnabledTools(new Set(enabled));
      onSubmit(task, enabled, dom);
    } catch (e) {
      setError(`Failed to register custom query: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSubmitting(false);
    }
  };

  // ───────────────────────────────────────────────────────── derived
  const filteredTasks = useMemo(() => {
    const q = taskFilter.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(t =>
      t.title.toLowerCase().includes(q)
      || (t.summary || "").toLowerCase().includes(q)
      || t.id.toLowerCase().includes(q)
    );
  }, [tasks, taskFilter]);

  const visibleChips = showAllTasks || taskFilter.trim()
    ? filteredTasks
    : filteredTasks.slice(0, VISIBLE_CHIP_CAP);
  const hiddenChipCount = filteredTasks.length - visibleChips.length;

  const filteredTools = toolFilter.trim()
    ? tools.filter(t => t.name.toLowerCase().includes(toolFilter.toLowerCase())
        || (t.description || "").toLowerCase().includes(toolFilter.toLowerCase()))
    : tools;

  const currentDomain = domains.find(d => d.name === domain);
  const canSubmit = prompt.trim().length > 0 && !isLoading && !submitting && !!domain;

  return (
    <div className="space-y-5">
      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      {/* ── Domain selector (mandatory — environment changes per domain) */}
      <div className="text-center">
        <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-2">
          Pick an enterprise environment
        </div>
        <div className="flex flex-wrap gap-1.5 justify-center">
          {domains.map(d => {
            const n = taskCounts[d.name];
            const active = domain === d.name;
            return (
              <button
                key={d.name}
                onClick={() => setDomain(d.name)}
                disabled={isLoading}
                className={`px-2.5 py-1.5 text-xs rounded-lg border transition flex items-center gap-1.5
                  ${active
                    ? "border-blue-500 bg-blue-50 text-blue-800 shadow-sm"
                    : "border-gray-200 bg-white hover:bg-gray-50 text-gray-700"}`}
                title={d.summary || undefined}
              >
                <span className="text-sm leading-none">{d.icon}</span>
                <span className="font-medium">{d.label}</span>
                {typeof n === "number" && (
                  <span className={`text-[10px] font-mono px-1 py-0 rounded-full
                    ${active ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
          {domains.length === 0 && <div className="text-xs text-gray-400 py-2">Loading domains…</div>}
        </div>
      </div>

      {/* ── Hero composer (reasoning-mode style) */}
      {domain && (
        <div className="rounded-2xl border border-gray-300 bg-white shadow-sm focus-within:border-gray-400 transition-colors relative">
          <textarea
            rows={3}
            value={prompt}
            onChange={e => { setPrompt(e.target.value); promptDirty.current = true; }}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={`What should Orchestra do in the ${currentDomain?.label || domain} sandbox?`}
            disabled={isLoading || submitting}
            className="w-full resize-none outline-none text-sm leading-relaxed p-4 placeholder:text-gray-400 rounded-t-2xl bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t bg-gray-50/50 rounded-b-2xl">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="inline-flex gap-0.5 p-0.5 rounded-md border bg-white flex-none">
                {DOM_OPTIONS.map(d => (
                  <button
                    key={d.value}
                    onClick={() => !isLoading && onDomChange(d.value)}
                    disabled={isLoading}
                    className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                      dom === d.value ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                    }`}
                    title={d.hint || undefined}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-gray-500 truncate" title={DOM_HINTS[dom]}>
                {linkedToOracle && selectedTask
                  ? <><span className="text-emerald-700">★ {selectedTask.title}</span> · ✓{selectedTask.verifier_count ?? 0} verifier{(selectedTask.verifier_count ?? 0) === 1 ? "" : "s"}</>
                  : prompt.trim()
                    ? <>Custom query · all tools enabled by default</>
                    : DOM_HINTS[dom]}
              </span>
            </div>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:bg-gray-300 flex items-center gap-1 flex-none"
            >
              {submitting ? "Preparing…" : isLoading ? "Designing…" : "Design plan"}
              <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      )}

      {/* ── OR TRY curated chips */}
      {domain && filteredTasks.length > 0 && (
        <div className="text-center">
          <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">or try</div>
          <div className="flex flex-wrap gap-2 justify-center">
            {visibleChips.map(t => {
              const active = selectedTaskId === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => pickCuratedTask(t)}
                  disabled={isLoading}
                  className={`group text-xs px-3 py-1.5 rounded-full border transition-colors max-w-md flex items-center gap-1.5
                    ${active
                      ? "border-blue-400 bg-blue-50 text-blue-800"
                      : "bg-white border-gray-200 hover:border-blue-300 hover:bg-blue-50/40 text-gray-700"}`}
                  title={t.summary || t.user_prompt}
                >
                  {t.featured && <span className="text-amber-500" aria-label="Featured">★</span>}
                  {t.id.startsWith("custom.") && (
                    <span className="text-[9px] font-mono px-1 rounded bg-blue-100 text-blue-700">✎</span>
                  )}
                  <span className="truncate">{t.title}</span>
                  {typeof t.verifier_count === "number" && t.verifier_count > 0 && (
                    <span className="text-[10px] font-mono px-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
                      ✓{t.verifier_count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-gray-500">
            {hiddenChipCount > 0 && (
              <button onClick={() => setShowAllTasks(true)} className="text-blue-600 hover:underline">
                + {hiddenChipCount} more
              </button>
            )}
            {(showAllTasks || filteredTasks.length > VISIBLE_CHIP_CAP) && (
              <input
                value={taskFilter}
                onChange={e => setTaskFilter(e.target.value)}
                placeholder="Filter…"
                className="px-2 py-0.5 border rounded bg-white text-[11px]"
              />
            )}
            {showAllTasks && (
              <button onClick={() => setShowAllTasks(false)} className="text-gray-500 hover:underline">
                show fewer
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Advanced: tool catalog (collapsed by default; mostly for
          users who want to constrain which MCP tools the planner can use). */}
      {domain && tools.length > 0 && (
        <div className="text-center">
          <button
            onClick={() => setToolsExpanded(v => !v)}
            className="text-[11px] text-gray-500 hover:text-blue-600 hover:underline"
          >
            {toolsExpanded ? "Hide tool catalog" : `Advanced · choose tools (${tools.length} available)`}
          </button>
          {toolsExpanded && (
            <div className="mt-2 text-left border rounded-lg overflow-hidden bg-white">
              <div className="px-2 py-1.5 bg-gray-50 border-b flex items-center gap-2">
                <input
                  value={toolFilter}
                  onChange={e => setToolFilter(e.target.value)}
                  placeholder="Filter tools…"
                  className="flex-1 text-xs px-2 py-1 border rounded bg-white"
                />
                <button
                  onClick={() => setEnabledTools(new Set(tools.map(t => t.name)))}
                  className="text-[11px] px-2 py-1 rounded border bg-white hover:bg-gray-50"
                >
                  All
                </button>
                <button
                  onClick={() => setEnabledTools(new Set())}
                  className="text-[11px] px-2 py-1 rounded border bg-white hover:bg-gray-50"
                >
                  None
                </button>
              </div>
              <ul className="max-h-56 overflow-y-auto divide-y">
                {filteredTools.map(tool => (
                  <li key={tool.name}>
                    <label className="flex items-start gap-2 px-2.5 py-1.5 hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={enabledTools.has(tool.name)}
                        onChange={() => toggleTool(tool.name)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-gray-800">{tool.name}</div>
                        <div className="text-[11px] text-gray-500 line-clamp-2">{tool.description}</div>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="px-2.5 py-1 border-t bg-gray-50 text-[11px] text-gray-500">
                {enabledTools.size}/{tools.length} enabled
                {!linkedToOracle && enabledTools.size === 0 && (
                  <span className="ml-2 text-amber-600">(all tools will be enabled at submit if left empty)</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
