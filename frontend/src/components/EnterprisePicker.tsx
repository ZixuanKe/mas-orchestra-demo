import { useEffect, useMemo, useState } from "react";
import type { DomLevel, EnterpriseDomain, EnterpriseTask, ToolSummary } from "../types";
import { DOM_OPTIONS } from "../types";

// With 7 domains × ~80 tasks each, rendering the full list is wasteful and
// makes the page feel cluttered. Cap the on-screen task count and let the
// search box reveal the rest.
const VISIBLE_TASK_CAP = 30;

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
  // Fired the moment the user picks a task card. Used to preview the
  // sandbox in the 5th column before they design a plan.
  onPreview?: (task: EnterpriseTask) => void;
  onSubmit: (task: EnterpriseTask, enabledTools: string[], dom: DomLevel) => void;
  isLoading: boolean;
}

const DOM_HINTS: Record<DomLevel, string> = {
  low: "Low complexity → minimal mutations, no extra reads (1–3 MCPAgents).",
  high: "High complexity → balanced plan with grounding reads (3–6 MCPAgents).",
  high_extensive: "Extensive → bracket every mutation with reads (5–10 MCPAgents).",
};

/** EnterprisePicker — domain selector → curated task list → tool checkboxes.
 *
 * On the first render it fetches the available domains, then the tasks for
 * the first domain, then the full tool catalog. The user can:
 *   1. Pick a task. The task's oracle `default_tools` become pre-selected.
 *   2. Tick/untick additional tools from the full catalog before running.
 *   3. Hit "Design plan" to send `{task_id, enabled_tools}` to the planner.
 */
export function EnterprisePicker({ dom, onDomChange, onPreview, onSubmit, isLoading }: Props) {
  const [domains, setDomains] = useState<EnterpriseDomain[]>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [tasks, setTasks] = useState<EnterpriseTask[]>([]);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [toolFilter, setToolFilter] = useState("");
  const [toolsCollapsed, setToolsCollapsed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-domain task counts shown in the domain selector badges. Loaded
  // alongside the domain list via /enterprise/task-counts.
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [taskFilter, setTaskFilter] = useState("");
  // "Show all" expands the per-domain list past VISIBLE_TASK_CAP. Reset
  // whenever the domain or filter changes so the user doesn't end up
  // scrolling through hundreds of cards by accident.
  const [showAllTasks, setShowAllTasks] = useState(false);

  // 1. Load the domain catalog + per-domain task counts once.
  //
  // React StrictMode (dev) runs effects twice and the user can re-mount this
  // panel by toggling modes — each remount fires a fresh round of fetches,
  // and the previous round's in-flight requests are aborted by the browser.
  // Browsers report aborted fetches as ``TypeError: Failed to fetch``; we
  // swallow those (and AbortError) since they're benign by the time we hit
  // ``.catch``. Real connectivity failures will still re-fire on remount.
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

  // 2. Load tasks + tools whenever the chosen domain changes.
  //
  // The cleanup aborts the previous domain's in-flight fetches so a rapid
  // click sequence (calendar → email → hr) doesn't leave dangling promises
  // that overwrite the user's current selection with stale data.
  useEffect(() => {
    if (!domain) return;
    const ctrl = new AbortController();
    setSelectedTaskId(null);
    setEnabledTools(new Set());
    setTaskFilter("");
    setShowAllTasks(false);
    setError(null);
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
  }, [domain]);

  // 3. When a task is selected, seed enabled tools from its oracle list.
  const selectedTask = tasks.find(t => t.id === selectedTaskId) || null;
  useEffect(() => {
    if (!selectedTask) return;
    setEnabledTools(new Set(selectedTask.default_tools));
  }, [selectedTask?.id]);

  const toggleTool = (name: string) => {
    setEnabledTools(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const filteredTools = toolFilter.trim()
    ? tools.filter(t => t.name.toLowerCase().includes(toolFilter.toLowerCase())
        || (t.description || "").toLowerCase().includes(toolFilter.toLowerCase()))
    : tools;

  // Tasks filtered by the search box (title + summary + id substring match)
  // — keeps featured-first ordering from the backend.
  const filteredTasks = useMemo(() => {
    const q = taskFilter.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(t =>
      t.title.toLowerCase().includes(q)
      || (t.summary || "").toLowerCase().includes(q)
      || t.id.toLowerCase().includes(q)
    );
  }, [tasks, taskFilter]);

  // Capped slice the picker actually renders. If the user is searching we
  // show everything (search itself is the filter); otherwise we cap unless
  // they explicitly clicked "Show all".
  const visibleTasks = (taskFilter.trim() || showAllTasks)
    ? filteredTasks
    : filteredTasks.slice(0, VISIBLE_TASK_CAP);
  const hiddenCount = filteredTasks.length - visibleTasks.length;

  const canSubmit = !!selectedTask && enabledTools.size > 0 && !isLoading;

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      {/* Domain selector */}
      <div>
        <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-2">Enterprise domain</div>
        <div className="flex flex-wrap gap-2">
          {domains.map(d => {
            const n = taskCounts[d.name];
            return (
              <button
                key={d.name}
                onClick={() => setDomain(d.name)}
                disabled={isLoading}
                className={`px-3 py-2 text-sm rounded-lg border transition flex items-center gap-2
                  ${domain === d.name
                    ? "border-blue-500 bg-blue-50 text-blue-800 shadow-sm"
                    : "border-gray-200 bg-white hover:bg-gray-50 text-gray-700"}`}
              >
                <span className="text-base leading-none">{d.icon}</span>
                <span className="font-medium">{d.label}</span>
                {typeof n === "number" && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full
                    ${domain === d.name ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
          {domains.length === 0 && <div className="text-xs text-gray-400">Loading domains…</div>}
        </div>
        {domains.find(d => d.name === domain)?.summary && (
          <div className="mt-1.5 text-xs text-gray-500">{domains.find(d => d.name === domain)!.summary}</div>
        )}
      </div>

      {/* Task list */}
      <div>
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
            Pick a task
            <span className="ml-1 text-gray-400 normal-case">
              ({filteredTasks.length}{filteredTasks.length !== tasks.length ? ` of ${tasks.length}` : ""})
            </span>
          </div>
          <input
            value={taskFilter}
            onChange={e => setTaskFilter(e.target.value)}
            placeholder="Filter tasks…"
            disabled={isLoading || tasks.length === 0}
            className="flex-1 max-w-[16rem] text-xs px-2 py-1 border rounded bg-white"
          />
        </div>
        <ul className="grid grid-cols-1 gap-2 max-h-[28rem] overflow-y-auto pr-1">
          {visibleTasks.map(t => (
            <li key={t.id}>
              <button
                onClick={() => {
                  setSelectedTaskId(t.id);
                  onPreview?.(t);
                }}
                disabled={isLoading}
                className={`w-full text-left rounded-lg border p-3 transition
                  ${selectedTaskId === t.id
                    ? "border-blue-500 ring-1 ring-blue-200 bg-blue-50/40"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"}`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {t.featured && (
                        <span className="text-amber-500 text-xs" title="Featured task">★</span>
                      )}
                      <div className="text-sm font-semibold text-gray-800 truncate">{t.title}</div>
                      {typeof t.verifier_count === "number" && t.verifier_count > 0 && (
                        <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
                          ✓{t.verifier_count}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{t.summary}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.default_tools.slice(0, 6).map(tool => (
                        <span key={tool} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">{tool}</span>
                      ))}
                      {t.default_tools.length > 6 && (
                        <span className="text-[10px] text-gray-400">+{t.default_tools.length - 6}</span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            </li>
          ))}
          {visibleTasks.length === 0 && (
            <li className="text-xs text-gray-400 py-4 text-center">
              {tasks.length === 0 ? "No tasks for this domain." : "No tasks match your filter."}
            </li>
          )}
        </ul>
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowAllTasks(true)}
            className="mt-2 w-full text-[11px] text-blue-600 hover:underline"
          >
            Show {hiddenCount} more task{hiddenCount === 1 ? "" : "s"}…
          </button>
        )}
      </div>

      {/* Task prompt preview + tool catalog */}
      {selectedTask && (
        <>
          <div className="border rounded-lg p-3 bg-gray-50">
            <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">User instruction</div>
            <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
              {selectedTask.user_prompt}
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                Enabled tools ({enabledTools.size}/{tools.length})
              </div>
              <button
                onClick={() => setToolsCollapsed(c => !c)}
                className="text-[11px] text-blue-600 hover:underline"
              >
                {toolsCollapsed ? "Edit all tools" : "Hide all tools"}
              </button>
            </div>

            {/* Always show the selected/oracle tools as compact chips */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {[...enabledTools].sort().map(name => (
                <button
                  key={name}
                  onClick={() => toggleTool(name)}
                  className="text-[11px] font-mono px-2 py-0.5 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  title="Click to remove"
                >
                  {name}
                </button>
              ))}
              {enabledTools.size === 0 && (
                <span className="text-xs text-amber-600">No tools enabled — pick at least one below.</span>
              )}
            </div>

            {!toolsCollapsed && (
              <div className="border rounded-lg overflow-hidden">
                <div className="px-2 py-1.5 bg-gray-50 border-b">
                  <input
                    value={toolFilter}
                    onChange={e => setToolFilter(e.target.value)}
                    placeholder="Filter tools…"
                    className="w-full text-xs px-2 py-1 border rounded bg-white"
                  />
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
              </div>
            )}
          </div>

          {/* DoM picker mirrors the LeftSidebar control — kept in sync via
              the shared ``dom`` prop & ``onDomChange`` callback. */}
          <div className="flex flex-wrap items-center gap-2 px-1">
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Degree of MAS</span>
            <div className="inline-flex flex-wrap gap-1 p-0.5 rounded-md border bg-white">
              {DOM_OPTIONS.map(d => (
                <button
                  key={d.value}
                  onClick={() => !isLoading && onDomChange(d.value)}
                  disabled={isLoading}
                  className={`px-2 py-1 text-[11px] rounded transition-colors ${
                    dom === d.value ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                  }`}
                  title={d.hint || undefined}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-gray-500 flex-1 min-w-0">{DOM_HINTS[dom]}</span>
          </div>

          <button
            onClick={() => selectedTask && onSubmit(selectedTask, [...enabledTools], dom)}
            disabled={!canSubmit}
            className={`w-full py-2.5 rounded-lg font-medium text-sm transition
              ${canSubmit
                ? "bg-gradient-to-br from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-sm"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
          >
            {isLoading ? "Designing plan…" : "Design enterprise plan"}
          </button>
        </>
      )}
    </div>
  );
}
