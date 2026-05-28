import { useEffect, useMemo, useRef, useState } from "react";
import type { SandboxSnapshot, SandboxRow } from "../types";
import type { ChangeRecord, TableActivity, LastStep } from "./SandboxPanel";
import {
  domainConfig, appColor, TONE_CLASSES,
  type DomainViewConfig, type FocusKey,
} from "./domainViews";

/* ────────────────────────────────────────────────────────────────────────
 * GenericAppView — a single component that renders an app-style sandbox
 * preview for any non-calendar domain (email, hr, itsm, csm, teams,
 * drive). It uses per-domain config in domainViews.ts to know which
 * tables are the "headline" list and the contextual rail, plus which
 * columns hold the title / status / priority / assignee / etc.
 *
 * The behaviour mirrors CalendarAppView so the UX feels consistent:
 *   • rail of secondary entities (labels / services / accounts / …)
 *     with diff badges and color chips
 *   • list of primary entities grouped by date or status, with NEW /
 *     EDIT / DEL badges and column-level diff chips
 *   • "ghost rows" synthesised from in-flight inserts so the list updates
 *     immediately, before the next snapshot tick arrives
 *   • section pulses + a floating overlay toast for read / no-op / error
 *     tools, so every tool call has a visible effect
 *   • a slide-in side pane with focused sub-screens per operation
 *     (title, description, status, priority, assignee, recipients,
 *     move, share, …) — the "agent opens the right page, makes the
 *     change, then closes it" effect
 * ──────────────────────────────────────────────────────────────────── */

// (Row-flash duration used to live here as ``FLASH_MS = 5000`` but the
// pulse is driven entirely by CSS animations now; the constant was
// orphaned and tripped ``noUnusedLocals``.)
const PANE_AUTO_CLOSE_MS = 6000;

interface Props {
  snapshot: SandboxSnapshot;
  runChanges: Record<string, ChangeRecord>;   // key: "table::rowId"
  tableActivity: Record<string, TableActivity>;
  lastStep: LastStep | null;
}

export function GenericAppView({ snapshot, runChanges, tableActivity, lastStep }: Props) {
  const cfg = domainConfig(snapshot.domain);

  // No config for this domain → render a friendly fallback. (Should never
  // happen in practice since SandboxPanel only dispatches here for
  // configured domains, but defensive coding pays off.)
  if (!cfg) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-gray-400 italic">
        No App view configured for "{snapshot.domain}" yet — switch to the Graph view.
      </div>
    );
  }

  return <ConfiguredView snapshot={snapshot} runChanges={runChanges} tableActivity={tableActivity} lastStep={lastStep} cfg={cfg} />;
}

/* ── Internal component (so the hooks below all have a non-null cfg) ── */
function ConfiguredView({ snapshot, runChanges, tableActivity, lastStep, cfg }: Props & { cfg: DomainViewConfig }) {
  const { rail, list } = cfg;
  const themeStyle: React.CSSProperties = { ["--app-theme" as string]: cfg.themeRgb };

  /* Bucket rows by table. */
  const tableRows = useMemo(() => {
    const out: Record<string, SandboxRow[]> = {};
    for (const t of snapshot.tables) out[t.table] = t.rows;
    return out;
  }, [snapshot]);

  /* Ghost rows: for inserts that exist in runChanges but haven't landed
   * in the snapshot yet. Lets newly created rows appear immediately. */
  const listRows = useMemo<SandboxRow[]>(() => {
    const base = tableRows[list.table] || [];
    const have = new Set(base.map(r => r.id));
    const ghosts: SandboxRow[] = [];
    for (const [k, ch] of Object.entries(runChanges)) {
      if (!k.startsWith(`${list.table}::`)) continue;
      if (ch.op !== "insert") continue;
      const id = k.slice(`${list.table}::`.length);
      if (have.has(id)) continue;
      ghosts.push({ id, values: (ch.after ?? {}) as Record<string, unknown> });
    }
    return [...ghosts, ...base];
  }, [tableRows, runChanges, list.table]);

  const railRows = useMemo<SandboxRow[]>(() => {
    if (!rail) return [];
    const base = tableRows[rail.table] || [];
    const have = new Set(base.map(r => r.id));
    const ghosts: SandboxRow[] = [];
    for (const [k, ch] of Object.entries(runChanges)) {
      if (!k.startsWith(`${rail.table}::`)) continue;
      if (ch.op !== "insert") continue;
      const id = k.slice(`${rail.table}::`.length);
      if (have.has(id)) continue;
      ghosts.push({ id, values: (ch.after ?? {}) as Record<string, unknown> });
    }
    let rows = [...ghosts, ...base];
    // Optional dedup-by-title: collapses gym-seeded duplicates like the
    // 25 per-user copies of "INBOX" / "SENT" into a single rail chip.
    // Keeps the first occurrence (so an in-flight ghost wins over the
    // base row when both share a title).
    if (rail.dedupByTitle) {
      const seen = new Set<string>();
      rows = rows.filter(r => {
        const t = String(r.values[rail.titleCol] ?? "").trim().toLowerCase();
        if (!t) return true; // keep untitled rows so they don't all merge
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });
    }
    return rows;
  }, [tableRows, runChanges, rail]);

  /* Resolve FK columns to display names. We index people / channels /
   * services / accounts by every plausible identifier (PK, alt-id, email
   * for users) so a tool that returns "alice_manager" or "alice@x.com"
   * or "user_001" all resolve back to the same human-readable label. */
  const usersTable = tableRows["users"] || tableRows["user"] || tableRows["teams_users"] || [];
  const personLookup = useMemo(() => {
    const out: Record<string, SandboxRow> = {};
    const add = (k: unknown, r: SandboxRow) => {
      if (k == null || k === "") return;
      const s = String(k);
      if (!out[s]) out[s] = r;
    };
    for (const u of usersTable) {
      add(u.id, u);
      add(u.values.user_id, u);
      add(u.values.id, u);
      add(u.values.email, u);
      add(u.values.user_principal_name, u);
    }
    return out;
  }, [usersTable]);

  /** Format a person value (FK / email / local-id) as a friendly string.
   *  Falls back gracefully when the user table doesn't have the row, so
   *  we never surface a raw opaque "id-looking" string when a more
   *  readable alternative is available (email local-part, the value
   *  itself if it's already an email, etc.). */
  const personLabel = (uid: unknown): string => {
    if (uid == null || uid === "") return "";
    const s = String(uid);
    const u = personLookup[s];
    if (u) {
      const name = String(u.values.name ?? u.values.display_name ?? "");
      // Some gyms split names into first_name / last_name (CSM, HR).
      const fn = String(u.values.first_name ?? u.values.given_name ?? "");
      const ln = String(u.values.last_name ?? u.values.surname ?? u.values.family_name ?? "");
      const combined = [fn, ln].filter(Boolean).join(" ").trim();
      const email = String(u.values.email ?? u.values.mail ?? u.values.user_principal_name ?? "");
      return name || combined || email || s;
    }
    // No user record — make the raw value as readable as possible:
    // emails become "alice (alice@x.com)", opaque IDs are slightly
    // prettified ("user_alice_manager" → "Alice Manager").
    if (s.includes("@")) {
      const local = s.split("@")[0].replace(/[._-]+/g, " ");
      return titleCase(local);
    }
    return prettifyId(s);
  };
  // Back-compat alias for the few places below that still call userLabel.
  const userLabel = personLabel;

  /* Rail filter — when the user clicks a rail chip we narrow the list
   * either via a direct ``list.parentCol`` FK or via a many-to-many
   * junction described by ``rail.filterVia`` (used by email labels). */
  const [railFilter, setRailFilter] = useState<string | null>(null);

  /** When the rail dedupes by title (e.g. INBOX shows once but the gym
   *  seeds one per user) one click should match ALL rail rows that
   *  share the clicked title, not just the single visible chip. */
  const expandRailIds = (clickedId: string): Set<string> => {
    if (!rail) return new Set([clickedId]);
    if (!rail.dedupByTitle) return new Set([clickedId]);
    const base = tableRows[rail.table] || [];
    const clicked = base.find(r => r.id === clickedId);
    if (!clicked) return new Set([clickedId]);
    const title = String(clicked.values[rail.titleCol] ?? "").trim().toLowerCase();
    if (!title) return new Set([clickedId]);
    const out = new Set<string>();
    for (const r of base) {
      if (String(r.values[rail.titleCol] ?? "").trim().toLowerCase() === title) {
        out.add(r.id);
      }
    }
    return out;
  };

  const filteredListRows = useMemo(() => {
    if (!railFilter) return listRows;
    const via = rail?.filterVia;
    // M2M path via junction table.
    if (via) {
      const expanded = expandRailIds(railFilter);
      const junction = tableRows[via.junctionTable] || [];
      // Step 1: junction rows for the clicked label(s) → ids to pass on
      // to the next hop (either the intermediate table or list rows
      // directly).
      const interIds = new Set<string>();
      for (const j of junction) {
        if (expanded.has(String(j.values[via.junctionRailCol] ?? ""))) {
          interIds.add(String(j.values[via.junctionInterCol] ?? ""));
        }
      }
      // Step 2: optional intermediate hop (e.g. messages → thread_id).
      let listIds: Set<string>;
      if (via.interTable && via.interListCol) {
        listIds = new Set<string>();
        const inter = tableRows[via.interTable] || [];
        for (const m of inter) {
          if (interIds.has(m.id)) {
            const v = String(m.values[via.interListCol] ?? "");
            if (v) listIds.add(v);
          }
        }
      } else {
        listIds = interIds;
      }
      return listRows.filter(r => listIds.has(r.id));
    }
    // Direct FK path.
    if (list.parentCol) {
      return listRows.filter(r => String(r.values[list.parentCol!] ?? "") === railFilter);
    }
    return listRows;
  // ``expandRailIds`` closes over ``rail`` and ``tableRows`` so they're
  // covered transitively; explicit deps for the static reads below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRows, list.parentCol, railFilter, rail, tableRows]);

  /* Group the list. For domains with a date column we group by day,
   * otherwise by status (which gives the Cases/Incidents board feel). */
  const groupedList = useMemo(() => {
    const buckets = new Map<string, SandboxRow[]>();
    const orderedKeys: string[] = [];
    const groupBy: "date" | "status" | "none" =
      list.dateCol ? "date" : list.statusCol ? "status" : "none";
    for (const r of filteredListRows) {
      let key = "All";
      if (groupBy === "date") {
        const d = String(r.values[list.dateCol!] ?? "");
        key = d ? d.slice(0, 10) : "Unscheduled";
      } else if (groupBy === "status") {
        key = String(r.values[list.statusCol!] ?? "Unknown");
      }
      if (!buckets.has(key)) {
        buckets.set(key, []);
        orderedKeys.push(key);
      }
      buckets.get(key)!.push(r);
    }
    if (groupBy === "date") {
      orderedKeys.sort();
      for (const k of orderedKeys) {
        buckets.get(k)!.sort((a, b) =>
          String(b.values[list.dateCol!] ?? "").localeCompare(String(a.values[list.dateCol!] ?? ""))
        );
      }
    }
    return { groupBy, keys: orderedKeys, buckets };
  }, [filteredListRows, list]);

  /* Change lookup helper. */
  const changeFor = (table: string, id: string): ChangeRecord | undefined =>
    runChanges[`${table}::${id}`];

  /* Activity bindings — which rail / list pulses on which table activity. */
  const railActivity: TableActivity | null = rail ? (tableActivity[rail.table] || null) : null;
  const listActivity: TableActivity | null = tableActivity[list.table] || null;

  /* Counts of changed rows per section, surfaced in headers. */
  const listChangedCount = useMemo(() =>
    filteredListRows.reduce((n, r) => n + (changeFor(list.table, r.id) ? 1 : 0), 0),
    [filteredListRows, list.table, runChanges]
  );
  const railChangedCount = useMemo(() => {
    if (!rail) return 0;
    return railRows.reduce((n, r) => n + (changeFor(rail.table, r.id) ? 1 : 0), 0);
  }, [railRows, rail, runChanges]);

  /* Side pane: focus-aware slide-in mimicking the calendar pane. */
  const [pane, setPane] = useState<PaneState | null>(null);
  const [paneEntered, setPaneEntered] = useState(false);

  useEffect(() => {
    if (!lastStep) return;
    const built = buildPane(lastStep, cfg, runChanges, tableRows, userLabel);
    if (!built) return;
    setPane(built);
    setPaneEntered(false);
    const tIn = setTimeout(() => setPaneEntered(true), 20);
    const tOut = setTimeout(() => setPane(prev => (prev?.key === built.key ? null : prev)), PANE_AUTO_CLOSE_MS);
    return () => { clearTimeout(tIn); clearTimeout(tOut); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStep?.ts, lastStep?.toolName]);

  /* Floating overlay for tools that produced no visible effect at all
   * (no-op / error) or affected only unbound tables. */
  const overlay = useMemo<OverlayInfo | null>(() => {
    if (!lastStep) return null;
    // If the pane will surface this step, don't double-render.
    const focus = lastStep.toolName ? toolFocus(lastStep.toolName, lastStep.affectedTables, cfg) : null;
    if (focus !== null) return null;
    const key = `${lastStep.ts}::${lastStep.toolName}`;
    if (lastStep.kind === "noop")  return { key, icon: "✋", label: "agent skipped — no tool call", tone: "warn", agent: lastStep.byAgent, tool: lastStep.toolName };
    if (lastStep.kind === "error") return { key, icon: "✗", label: "tool failed — see chat for details", tone: "err",  agent: lastStep.byAgent, tool: lastStep.toolName };
    return { key, icon: "🔎", label: `${lastStep.toolName ?? "tool"} touched no visible row`, tone: "info", agent: lastStep.byAgent, tool: lastStep.toolName };
  }, [lastStep, cfg]);

  /* Refs for auto-scroll-to-changed-row. */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // When a write lands on the list table, scroll its container to top so
    // the new/changed row (which we render first for inserts and pulse for
    // updates) is in view.
    if (lastStep?.kind === "write" && (lastStep.affectedTables || []).includes(list.table)) {
      listScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [lastStep, list.table]);

  /* ──────────────────────────────── render ─────────────────────────── */
  return (
    <div className="h-full flex flex-col bg-white relative" style={themeStyle}>
      {/* App-style header strip */}
      <div
        className="h-9 flex items-center px-3 text-xs font-semibold flex-none border-b"
        style={{ background: `rgb(${cfg.themeRgb} / 0.08)`, color: `rgb(${cfg.themeRgb})` }}
      >
        <span className="text-base mr-1.5">{cfg.icon}</span>
        <span>{cfg.appLabel}</span>
        <span className="ml-2 text-[10px] font-normal opacity-60">· {snapshot.domain}</span>
      </div>

      {/* ── Slide-in side pane ───────────────────────────────────────
          Anchored to the PANEL root (not the list scroll area) so it
          spans the full visible width even when a 170px rail is to the
          left. This matches the Calendar pane's visual prominence. The
          pane sits below the header strip and above the floating toast. */}
      {pane && (
        <div key={pane.key} className="absolute left-0 right-0 bottom-0 top-9 z-40 flex pointer-events-none">
          <div className={`ml-auto h-full bg-white border-l-2 shadow-2xl flex flex-col transition-all duration-300 ease-out pointer-events-auto w-[82%] max-w-[420px] ${
            pane.isError ? "border-red-300" : pane.isWrite ? "border-emerald-300" : "border-blue-300"
          } ${paneEntered ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"}`}>
            <div className={`px-3 py-2 border-b flex items-center gap-2 ${pane.isError ? "bg-red-50" : pane.isWrite ? "bg-emerald-50" : "bg-blue-50"}`}>
              <span className="text-lg leading-none">{FOCUS_ICON[pane.focus]}</span>
              <span className={`text-xs font-semibold ${pane.isError ? "text-red-800" : pane.isWrite ? "text-emerald-800" : "text-blue-800"}`}>{pane.title}</span>
              <span className="ml-auto text-[10px] font-mono text-gray-500 truncate max-w-[160px]" title={pane.tool}>{pane.tool}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <PaneBody pane={pane} cfg={cfg} userLabel={userLabel} tableRows={tableRows} />
            </div>
            <div className="px-3 py-1 border-t bg-gray-50 text-[10px] text-gray-500 flex items-center gap-1 flex-none">
              <span>by</span>
              <span className="font-mono text-gray-700 truncate max-w-[200px]" title={pane.agent}>{pane.agent}</span>
              <span className="ml-auto opacity-60">auto-closing…</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* ── Rail ─────────────────────────────────────────────────── */}
        {rail && (
          <div className={`w-[170px] shrink-0 border-r bg-gray-50/60 flex flex-col transition-all ${railActivity?.flashing ? railActivity.kind === "read" ? "ring-2 ring-inset ring-blue-200" : railActivity.kind === "error" ? "ring-2 ring-inset ring-red-200" : "" : ""}`}>
            <div className="px-2.5 py-1.5 border-b text-[10px] uppercase tracking-wide text-gray-500 font-semibold flex items-center gap-1.5">
              <span>{rail.icon}</span>
              <span>{rail.label}</span>
              <span className="text-gray-400 normal-case font-normal">· {railRows.length}</span>
              {railActivity && (railActivity.kind === "read" || railActivity.kind === "error") && (
                <span className={`ml-auto inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-medium normal-case ${
                  railActivity.kind === "read" ? "bg-blue-50 border border-blue-200 text-blue-700" : "bg-red-50 border border-red-200 text-red-700"
                } ${railActivity.flashing ? "animate-pulse" : ""}`}>
                  <span>{railActivity.kind === "read" ? "🔎" : "✗"}</span>
                </span>
              )}
              {railChangedCount > 0 && (
                <span className="ml-auto px-1 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold">{railChangedCount}</span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {railRows.length === 0 && <div className="text-[11px] text-gray-400 italic px-1.5">empty</div>}
              {railRows.map(r => {
                const ch = changeFor(rail.table, r.id);
                const isSelected = railFilter === r.id;
                // Same friendly-fallback treatment as Card titles so
                // sparsely-populated rail rows (e.g. channels with no
                // ``display_name``) never show a raw row id. The chain
                // covers every column name we've seen across gyms.
                const title = firstNonEmpty(r.values, [
                  rail.titleCol, "name", "display_name", "title",
                  "summary", "short_description", "subject",
                  "service_name", "label", "topic", "kb_number",
                  "number",
                ]) || `${rail.label.endsWith("s") ? rail.label.slice(0, -1) : rail.label} ${prettifyId(r.id.slice(-6))}`;
                const color = rail.colorCol ? appColor(r.values[rail.colorCol]) : null;
                // Same ring/animation language as the list cards above.
                const ringCls = ch?.flashing
                  ? ch.op === "insert" ? "ring-2 ring-emerald-300 animate-pulse"
                  : ch.op === "update" ? "ring-2 ring-amber-300 animate-pulse"
                  :                       "ring-2 ring-red-300 animate-pulse"
                  : ch
                  ? ch.op === "insert" ? "ring-1 ring-emerald-200 bg-emerald-50/30"
                  : ch.op === "update" ? "ring-1 ring-amber-200 bg-amber-50/30"
                  :                       "ring-1 ring-red-200 bg-red-50/30"
                  : "";
                const selectedCls = isSelected ? "ring-1 ring-[rgb(var(--app-theme,156_163_175))]" : "";
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRailFilter(prev => prev === r.id ? null : r.id)}
                    title={title}
                    className={`relative w-full text-left flex items-center gap-1.5 px-1.5 py-1 rounded border border-gray-200 bg-white text-[11px] hover:bg-gray-50 transition-all ${ringCls} ${!ch ? selectedCls : ""}`}
                  >
                    {color && <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />}
                    <span className={`truncate flex-1 ${ch?.op === "delete" ? "line-through text-red-700" : "text-gray-800"}`}>{title}</span>
                    {ch && (
                      <span className={`absolute -top-1.5 -right-1.5 px-1 py-0 rounded text-[8px] font-bold text-white shadow-sm ${ch.op === "insert" ? "bg-emerald-500" : ch.op === "update" ? "bg-amber-500" : "bg-red-500"} ${ch.flashing ? "animate-pulse" : ""}`}>
                        {ch.op === "insert" ? "NEW" : ch.op === "update" ? "EDIT" : "DEL"}
                      </span>
                    )}
                  </button>
                );
              })}
              {railFilter && (
                <button
                  type="button"
                  onClick={() => setRailFilter(null)}
                  className="w-full text-center text-[10px] text-gray-500 hover:text-gray-800 italic py-1"
                >
                  ✕ clear filter
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── List ─────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className={`px-3 py-1.5 border-b text-[10px] uppercase tracking-wide text-gray-500 font-semibold flex items-center gap-1.5 bg-white sticky top-0 z-10 ${listActivity?.flashing && listActivity.kind === "read" ? "bg-blue-50/60" : listActivity?.flashing && listActivity.kind === "error" ? "bg-red-50/60" : ""}`}>
            <span>{list.icon}</span>
            <span>{list.label}</span>
            <span className="text-gray-400 normal-case font-normal">· {filteredListRows.length}{(() => {
              if (!railFilter || !rail) return "";
              const r = railRows.find(rr => rr.id === railFilter);
              if (!r) return "";
              const name = firstNonEmpty(r.values, [rail.titleCol, "name", "display_name", "title", "summary"]) || prettifyId(r.id);
              return ` in ${name}`;
            })()}</span>
            {listActivity && (listActivity.kind === "read" || listActivity.kind === "error") && (
              <span className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-medium normal-case ${
                listActivity.kind === "read" ? "bg-blue-50 border border-blue-200 text-blue-700" : "bg-red-50 border border-red-200 text-red-700"
              } ${listActivity.flashing ? "animate-pulse" : ""}`}>
                <span>{listActivity.kind === "read" ? "🔎" : "✗"}</span>
                <span className="font-mono">{listActivity.toolName || (listActivity.kind === "error" ? "failed" : "read")}</span>
              </span>
            )}
            {listChangedCount > 0 && (
              <span className="ml-auto px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold normal-case">
                {listChangedCount} changed
              </span>
            )}
          </div>

          <div ref={listScrollRef} className="flex-1 min-h-0 overflow-y-auto relative">
            {/* Floating overlay toast */}
            {overlay && (
              <div
                key={overlay.key}
                className={`absolute top-2 left-1/2 -translate-x-1/2 z-30 inline-flex items-center gap-1.5 px-2 py-1 rounded-md shadow-sm border text-[10px] font-medium animate-[fadeIn_0.3s_ease-out] ${
                  overlay.tone === "warn" ? "bg-amber-50 border-amber-300 text-amber-800" :
                  overlay.tone === "err"  ? "bg-red-50 border-red-300 text-red-800" :
                  "bg-blue-50 border-blue-300 text-blue-800"
                }`}
              >
                <span>{overlay.icon}</span>
                <span>{overlay.label}</span>
                {overlay.tool && <span className="opacity-70">·</span>}
                {overlay.tool && <span className="font-mono opacity-80">{overlay.tool}</span>}
                <span className="opacity-50">·</span>
                <span className="font-mono opacity-80">{overlay.agent}</span>
              </div>
            )}

            <div className="p-2 space-y-3">
              {filteredListRows.length === 0 && (
                <div className="text-[11px] text-gray-400 italic px-2 py-8 text-center">
                  No {list.label.toLowerCase()} yet — agents will add them as they run.
                </div>
              )}
              {groupedList.keys.map(group => (
                <div key={group}>
                  <div className="px-1 py-1 text-[10px] uppercase tracking-wide text-gray-500 font-semibold flex items-center gap-2 sticky top-0 bg-white/95 backdrop-blur z-[5]">
                    <span>{formatGroupKey(group, groupedList.groupBy)}</span>
                    <span className="text-gray-400 normal-case font-normal">· {groupedList.buckets.get(group)!.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {groupedList.buckets.get(group)!.map(row => (
                      <Card
                        key={row.id}
                        row={row}
                        ch={changeFor(list.table, row.id)}
                        cfg={cfg}
                        userLabel={userLabel}
                        rail={rail ? railRows.find(r => r.id === String(row.values[list.parentCol ?? ""] ?? "")) ?? null : null}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Card ──────────────────────────────────────────────────────────── */
function Card({ row, ch, cfg, userLabel, rail }: {
  row: SandboxRow;
  ch: ChangeRecord | undefined;
  cfg: DomainViewConfig;
  userLabel: (uid: unknown) => string;
  rail: SandboxRow | null;
}) {
  const { list } = cfg;
  const title = titleOrFallback(row, cfg);
  const snippet = snippetFor(row, cfg);
  const status = list.statusCol ? row.values[list.statusCol] : undefined;
  const priority = list.priorityCol ? row.values[list.priorityCol] : undefined;
  const assignee = list.assignedToCol ? userLabel(row.values[list.assignedToCol]) : "";
  const from = fromFor(row, cfg, userLabel);
  const date = list.dateCol ? String(row.values[list.dateCol] ?? "") : "";
  // Match CalendarAppView: ring-2 + pulse while flashing, ring-1 after,
  // border-200 + hover-shadow. Subtle bg-tint stays so the row still
  // reads as "touched" once the pulse animation has stopped.
  const ringCls = ch?.flashing
    ? ch.op === "insert" ? "ring-2 ring-emerald-300 animate-pulse"
    : ch.op === "update" ? "ring-2 ring-amber-300 animate-pulse"
    :                       "ring-2 ring-red-300 animate-pulse"
    : ch
    ? ch.op === "insert" ? "ring-1 ring-emerald-200 bg-emerald-50/30"
    : ch.op === "update" ? "ring-1 ring-amber-200 bg-amber-50/30"
    :                       "ring-1 ring-red-200 bg-red-50/30"
    : "";
  const isDeleted = ch?.op === "delete";
  const railColor = rail && cfg.rail?.colorCol ? appColor(rail.values[cfg.rail.colorCol]) : null;
  // Left stripe colour — rail colour when configured, otherwise the
  // domain theme so every card still gets a visible accent.
  const stripe = railColor || `rgb(${cfg.themeRgb})`;

  return (
    <div
      className={`relative pl-3 pr-2 py-1.5 rounded-md bg-white border border-gray-200 hover:shadow-sm transition-all ${ringCls} ${isDeleted ? "opacity-70" : ""}`}
      style={{ borderLeft: `4px solid ${stripe}` }}
    >
      {/* Floating sticker badge — matches Calendar's `-top-1.5 -right-1.5`
          treatment so the change is unmissable. */}
      {ch && (
        <span className={`absolute -top-1.5 -right-1.5 px-1.5 py-0.5 rounded text-[8.5px] font-bold text-white shadow-sm ${ch.op === "insert" ? "bg-emerald-500" : ch.op === "update" ? "bg-amber-500" : "bg-red-500"} ${ch.flashing ? "animate-pulse" : ""}`}>
          {ch.op === "insert" ? "NEW" : ch.op === "update" ? "EDIT" : "DEL"}
        </span>
      )}

      <div className={`text-[12px] font-medium truncate ${isDeleted ? "line-through text-red-700" : "text-gray-900"}`} title={title}>
        {title || <span className="italic text-gray-400">(no title)</span>}
      </div>

      {snippet && (
        <div className={`text-[10.5px] line-clamp-2 mt-0.5 ${isDeleted ? "line-through opacity-50" : "text-gray-600"}`}>
          {snippet}
        </div>
      )}

      {/* Per-column diff chips — same amber-bordered chip language the
          calendar uses, so an EDIT box reads identically across domains. */}
      {ch?.op === "update" && ch.cols.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {ch.cols.slice(0, 4).map(col => {
            const beforeV = ch.before?.[col];
            const afterV = ch.after?.[col];
            const label = cfg.colLabels?.[col] || col;
            return (
              <span key={col} className="px-1 py-0 rounded bg-amber-50 border border-amber-200 text-[9px] font-mono text-amber-800 inline-flex items-center gap-0.5">
                <span className="font-semibold">{label}</span>:
                <span className="line-through text-red-400 max-w-[70px] truncate" title={String(beforeV ?? "")}>{shortVal(beforeV)}</span>
                <span className="text-amber-600">→</span>
                <span className="text-emerald-700 max-w-[70px] truncate" title={String(afterV ?? "")}>{shortVal(afterV)}</span>
              </span>
            );
          })}
          {ch.cols.length > 4 && <span className="text-[9px] text-amber-700">+{ch.cols.length - 4} more</span>}
        </div>
      )}

      <div className="mt-1 flex items-center flex-wrap gap-1.5 text-[10px] text-gray-500">
        {from && <span className="font-mono text-gray-700 truncate max-w-[110px]" title={`from: ${from}`}>👤 {from}</span>}
        {assignee && <span className="font-mono text-gray-700 truncate max-w-[110px]" title={`assigned: ${assignee}`}>→ {assignee}</span>}
        {status !== undefined && status !== null && status !== "" && (
          <StatusChip val={status} cfg={cfg} />
        )}
        {priority !== undefined && priority !== null && priority !== "" && (
          <PriorityChip val={priority} cfg={cfg} />
        )}
        {date && <span className="ml-auto font-mono">{formatDate(date)}</span>}
      </div>
    </div>
  );
}

function StatusChip({ val, cfg }: { val: unknown; cfg: DomainViewConfig }) {
  const s = String(val).toLowerCase();
  const tone = cfg.statusTone?.[s] || cfg.statusTone?.[String(val)] || "gray";
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.gray;
  // Boolean-like flags (is_unread etc.) → show as on/off chip rather than 0/1
  const displayed = val === 1 || val === "1" || val === true ? "● new"
                  : val === 0 || val === "0" || val === false ? "○ read"
                  : String(val);
  return <span className={`px-1.5 py-0 rounded ${cls.bg} ${cls.text} border ${cls.border}`}>{displayed}</span>;
}

function PriorityChip({ val, cfg }: { val: unknown; cfg: DomainViewConfig }) {
  const tone = cfg.priorityTone?.[String(val).toLowerCase()] || cfg.priorityTone?.[String(val)] || "gray";
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.gray;
  return <span className={`px-1.5 py-0 rounded ${cls.bg} ${cls.text} border ${cls.border}`}>⚑ {String(val)}</span>;
}

function shortVal(v: unknown): string {
  if (v == null) return "∅";
  const s = String(v);
  return s.length > 30 ? s.slice(0, 29) + "…" : s;
}

/** Pretty-print an opaque ID by stripping common prefixes and converting
 *  snake/kebab to Title Case. `user_alice_manager` → `Alice Manager`,
 *  `incident-00042-abc` → `42 Abc`. Keeps the original if it doesn't
 *  look like a snake/kebab id. */
function prettifyId(s: string): string {
  if (!s) return s;
  // strip common single-word prefixes
  const stripped = s.replace(/^(user|usr|account|acct|case|incident|inc|msg|message|file|channel|team|drive|folder|hr_case|customer_case)[_-]/i, "");
  if (!/[_-]/.test(stripped)) return s;
  return titleCase(stripped.replace(/[_-]+/g, " ").replace(/\b0+(\d)/g, "$1"));
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Turn a tool name like ``email_list_cse_keypairs`` into a friendly
 *  pane title + subtitle ("Listing CSE keypairs" / "an email tool").
 *  Used when the tool didn't touch a visible row, so the pane has
 *  meaningful text instead of just echoing the raw tool name. */
function friendlyToolDescription(tool: string, appLabel: string): { title: string; subtitle: string } {
  const t = tool.toLowerCase();
  // Strip a leading domain prefix the gym often adds (email_, drive_, …).
  const stripped = t.replace(/^(email|gmail|drive|hr|itsm|csm|teams|calendar)[_-]/, "");
  const [verb, ...restParts] = stripped.split(/[_-]/);
  const VERB_MAP: Record<string, string> = {
    list: "Listing", get: "Reading", search: "Searching",
    create: "Creating", insert: "Creating", add: "Adding",
    delete: "Deleting", remove: "Removing", clear: "Clearing",
    update: "Updating", patch: "Updating", modify: "Modifying", set: "Setting",
    send: "Sending", reply: "Replying to", forward: "Forwarding",
    move: "Moving", copy: "Copying", import: "Importing",
    share: "Sharing", unshare: "Unsharing",
    trash: "Trashing", untrash: "Restoring",
    star: "Starring", unstar: "Unstarring",
    archive: "Archiving", restore: "Restoring",
    enable: "Enabling", disable: "Disabling",
    check: "Checking", query: "Querying", count: "Counting",
  };
  const verbLabel = VERB_MAP[verb] || titleCase(verb || "Calling");
  const noun = rest(restParts);
  const title = noun ? `${verbLabel} ${noun}` : verbLabel;
  return {
    title: title.length > 60 ? title.slice(0, 59) + "…" : title,
    subtitle: `${appLabel.toLowerCase()} tool`,
  };
}

function rest(parts: string[]): string {
  if (parts.length === 0) return "";
  // Acronym map: short tokens that should stay uppercase.
  const ACRONYMS = new Set(["acl", "cse", "smime", "api", "url", "id", "kb", "sla", "vip", "ad", "csv", "pii"]);
  return parts
    .map(p => (ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p))
    .join(" ");
}

/** Look up the first column from ``cols`` whose value on ``row`` is a
 *  non-empty string/number. Lets us define rich fallback chains for the
 *  card title (e.g. ``subject → snippet → body_content``) so rows with
 *  null titles never collapse to a raw row-id placeholder. */
function firstNonEmpty(row: Record<string, unknown>, cols: string[]): string {
  for (const c of cols) {
    const v = row[c];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/** A short human-friendly fallback when ALL title columns are empty.
 *  Used in cards + pane breadcrumbs so we never show "msg::abcdef0123".
 *  Honours ``cfg.list.splitOn`` (e.g., email snippets formatted as
 *  "Subject - body") and falls back through several plausible columns,
 *  plus the bodyJsonCol payload for JSON-stored bodies (Teams). */
function titleOrFallback(row: SandboxRow, cfg: DomainViewConfig): string {
  // Primary attempt: the configured title column, possibly split.
  const primary = row.values[cfg.list.titleCol];
  if (primary != null && String(primary).trim()) {
    const raw = String(primary).trim();
    const t = cfg.list.splitOn ? raw.split(cfg.list.splitOn)[0].trim() : raw;
    if (t) return clip(t);
  }
  // Try common alternative title columns.
  const t = firstNonEmpty(row.values, [
    "subject", "name", "title", "display_name", "summary",
    "short_description", "label", "filename", "topic",
    "service_name", "kb_number", "number", "problem_statement",
    cfg.list.snippetCol || "",
  ].filter(Boolean));
  if (t) return clip(t);
  // Try JSON body extraction (Teams' body_json).
  if (cfg.list.bodyJsonCol) {
    const body = extractJsonContent(row.values[cfg.list.bodyJsonCol]);
    if (body) return clip(body);
  }
  // No usable string column — derive a stub from the entity kind and the
  // tail of the row id ("Case 12ab34", "Message 9f0e1d").
  const kind = cfg.list.label.endsWith("s") ? cfg.list.label.slice(0, -1) : cfg.list.label;
  const tail = row.id.slice(-6);
  return `${kind} ${tail}`;
}

function clip(s: string, n = 80): string {
  s = s.trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Resolve the snippet/body text for a list row, honouring splitOn (use
 *  the post-delimiter portion as the body) and JSON columns. Empty when
 *  no preview text is available. */
function snippetFor(row: SandboxRow, cfg: DomainViewConfig): string {
  const sc = cfg.list.snippetCol;
  if (sc && cfg.list.splitOn) {
    const raw = String(row.values[sc] ?? "").trim();
    if (raw) {
      const parts = raw.split(cfg.list.splitOn);
      if (parts.length > 1) return clip(parts.slice(1).join(cfg.list.splitOn).trim(), 140);
    }
  }
  const plain = sc ? String(row.values[sc] ?? "").trim() : "";
  if (plain) return clip(plain, 140);
  if (cfg.list.bodyJsonCol) {
    const body = extractJsonContent(row.values[cfg.list.bodyJsonCol]);
    if (body) return clip(body, 140);
  }
  return "";
}

/** Resolve the "From" line, including for JSON-wrapped author payloads
 *  (Teams' from_json = {"user": {"displayName": "Alice"}}). */
function fromFor(row: SandboxRow, cfg: DomainViewConfig, personLabel: (v: unknown) => string): string {
  if (cfg.list.fromCol) {
    const v = row.values[cfg.list.fromCol];
    if (v != null && v !== "") return personLabel(v);
  }
  if (cfg.list.fromJsonCol) {
    const raw = row.values[cfg.list.fromJsonCol];
    if (raw == null || raw === "") return "";
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      const u = obj?.user ?? obj?.application ?? obj?.device ?? obj;
      const name = u?.displayName ?? u?.display_name ?? u?.name ?? "";
      if (name) return String(name);
      if (u?.id) return personLabel(u.id);
    } catch { /* malformed JSON — fall through */ }
  }
  return "";
}

/** Extract readable text from a JSON-string column like
 *  ``{"contentType":"html","content":"<p>Hi</p>"}``. Strips HTML so the
 *  card preview is pure text. Returns empty on parse failure. */
function extractJsonContent(raw: unknown): string {
  if (raw == null || raw === "") return "";
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    const c = obj?.content ?? obj?.text ?? obj?.body ?? "";
    const stripped = String(c).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return stripped;
  } catch {
    return "";
  }
}

function formatDate(s: string): string {
  if (!s) return "";
  try {
    const d = new Date(s);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return s; }
}

function formatGroupKey(key: string, groupBy: "date" | "status" | "none"): string {
  if (groupBy === "date") {
    if (key === "Unscheduled") return key;
    try {
      const d = new Date(`${key}T00:00:00`);
      return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } catch { return key; }
  }
  return key;
}

/* ════════════════════════════════════════════════════════════════════
 * Side-pane focus engine — shared by all generic domains.
 * Each focus key gets its own mini sub-screen (title editor, status
 * picker, assignee editor, etc.) so the user sees the agent "open the
 * right page" rather than a generic dump.
 * ════════════════════════════════════════════════════════════════════ */

const FOCUS_ICON: Record<FocusKey, string> = {
  title: "✏️", snippet: "📝", body: "📝", description: "📝",
  status: "🔖", priority: "⚑", assignee: "👤", owner: "👤",
  recipients: "✉️", labels: "🏷️", category: "🗂️",
  color: "🎨", visibility: "👁️", share: "🔗", move: "📦",
  due: "⏰", schedule: "🗓️", general: "🛠️",
};

interface PaneState {
  focus: FocusKey;
  title: string;
  tool: string;
  agent: string;
  isWrite: boolean;
  isError: boolean;
  // The primary row this pane is anchored on (a list-table row), if any.
  row: SandboxRow | null;
  // The change record that triggered the pane, if there is one.
  change: ChangeRecord | null;
  // The table the change/row belongs to (list/rail/child).
  table: string;
  key: string;
}

interface OverlayInfo {
  key: string; icon: string; label: string; tone: "info" | "warn" | "err";
  agent: string; tool: string | null;
}

/* Decide which focus page a tool corresponds to. We ALWAYS return a
 * focus (never null) so every tool call gets a big bordered pane like
 * the calendar does — matches the visual prominence the user expects.
 * "general" is the catch-all for tools that don't bind to a specific
 * field; the pane then renders a tool-info card. */
function toolFocus(toolName: string, affected: string[], cfg: DomainViewConfig): FocusKey {
  if (!toolName) return "general";
  const name = toolName.toLowerCase();
  // Verb-based hints — these win even when affected tables overlap.
  if (name.includes("share") || name.includes("permission") || name.includes("acl")) return "share";
  if (name.includes("move") || name.includes("rename_drive") || name.includes("transfer")) return "move";
  if (name.includes("assign")) return "assignee";
  if (name.includes("label") || name.includes("category") || name.includes("tag")) return "labels";
  if (name.includes("send") || name.includes("reply") || name.includes("forward")) return "recipients";
  // Domain table touched → use the list table's "general"
  const tables = new Set(affected || []);
  if (tables.has(cfg.list.table)) return "general";
  if (cfg.rail && tables.has(cfg.rail.table)) return "category";
  return "general";
}

function buildPane(
  lastStep: LastStep,
  cfg: DomainViewConfig,
  runChanges: Record<string, ChangeRecord>,
  tableRows: Record<string, SandboxRow[]>,
  _userLabel: (uid: unknown) => string,
): PaneState | null {
  const tool = lastStep.toolName ?? "";
  if (!tool) return null; // No tool name → nothing to anchor a pane on.
  const focus0 = toolFocus(tool, lastStep.affectedTables || [], cfg);
  const isWrite = lastStep.kind === "write";
  const isError = lastStep.kind === "error";
  const key = `${lastStep.ts}::${tool}`;

  // Pick the first change in the list table that belongs to this agent.
  // If none (read tool), pick the most recently changed row of any agent,
  // otherwise fall back to the first row in the table.
  const listTable = cfg.list.table;
  const list = tableRows[listTable] || [];
  let row: SandboxRow | null = null;
  let change: ChangeRecord | null = null;
  let table = listTable;
  for (const [k, ch] of Object.entries(runChanges)) {
    if (!k.startsWith(`${listTable}::`)) continue;
    if (ch.byAgent && lastStep.byAgent && ch.byAgent !== lastStep.byAgent) continue;
    const id = k.slice(`${listTable}::`.length);
    row = list.find(r => r.id === id) ?? (ch.after ? { id, values: ch.after as Record<string, unknown> } : null);
    change = ch;
    break;
  }
  if (!row) {
    for (const [k, ch] of Object.entries(runChanges)) {
      if (!k.startsWith(`${listTable}::`)) continue;
      const id = k.slice(`${listTable}::`.length);
      row = list.find(r => r.id === id) ?? null;
      if (row) { change = ch; break; }
    }
  }
  if (!row) row = list[0] || null;
  // For category/share focus, also try rail table changes.
  if (!change && cfg.rail && (focus0 === "category" || focus0 === "share")) {
    const railTable = cfg.rail.table;
    for (const [k, ch] of Object.entries(runChanges)) {
      if (!k.startsWith(`${railTable}::`)) continue;
      if (ch.byAgent && lastStep.byAgent && ch.byAgent !== lastStep.byAgent) continue;
      change = ch; table = railTable;
      break;
    }
  }

  // Refine focus from the actual changed columns (more specific than verb).
  let focus: FocusKey = focus0;
  if (change && change.cols.length > 0) {
    for (const c of change.cols) {
      const f = cfg.focusForCol?.[c];
      if (f) { focus = f; break; }
    }
  }

  const titles: Record<FocusKey, string> = {
    title:       isWrite ? "Renaming" : "Inspecting title",
    snippet:     isWrite ? "Editing snippet" : "Reading snippet",
    body:        isWrite ? "Editing body" : "Reading body",
    description: isWrite ? "Editing description" : "Reading description",
    status:      isWrite ? "Updating status" : "Checking status",
    priority:    isWrite ? "Updating priority" : "Checking priority",
    assignee:    isWrite ? "Reassigning" : "Checking assignee",
    owner:       isWrite ? "Changing owner" : "Checking owner",
    recipients:  isWrite ? "Editing recipients" : "Checking recipients",
    labels:      isWrite ? "Updating labels" : "Inspecting labels",
    category:    isWrite ? "Recategorising" : "Inspecting category",
    color:       isWrite ? "Updating color" : "Inspecting color",
    visibility:  isWrite ? "Toggling visibility" : "Inspecting visibility",
    share:       isWrite ? "Updating sharing" : "Inspecting sharing",
    move:        isWrite ? "Moving" : "Inspecting location",
    due:         isWrite ? "Updating due date" : "Checking due date",
    schedule:    isWrite ? "Rescheduling" : "Inspecting schedule",
    general:     isWrite ? "Editing" : isError ? "Tool failed" : "Inspecting",
  };

  // For tools that didn't touch any visible row, derive a friendly title
  // from the tool name itself (e.g. "Listing CSE keypairs") so the pane
  // header reads like a real product action, not "Inspecting · Thread".
  const title = row
    ? `${titles[focus]} · ${cfg.list.label.slice(0, -1)}`.replace("·  · ", " · ")
    : friendlyToolDescription(tool, cfg.appLabel).title;

  return {
    focus, title,
    tool, agent: lastStep.byAgent, isWrite, isError, row, change, table, key,
  };
}

function PaneBody({ pane, cfg, userLabel, tableRows }: {
  pane: PaneState;
  cfg: DomainViewConfig;
  userLabel: (uid: unknown) => string;
  tableRows: Record<string, SandboxRow[]>;
}) {
  // Local FK → row lookup builder (for "move/category" labels below).
  const rowLookup = (tbl: string): Record<string, SandboxRow> => {
    const rows = tableRows[tbl] || [];
    const m: Record<string, SandboxRow> = {};
    for (const r of rows) m[r.id] = r;
    return m;
  };
  const row = pane.row;
  const before = (pane.change?.before ?? null) as Record<string, unknown> | null;
  const after  = (pane.change?.after  ?? null) as Record<string, unknown> | null;

  // No anchored row → the tool didn't touch a visible entity. Render a
  // "tool inspection" card so the pane still has substance (mirrors the
  // way Calendar shows a populated pane for ``get_colors`` / settings /
  // freebusy reads). Without this branch the pane would feel empty.
  if (!row) {
    const verb = pane.isWrite ? "Wrote with" : pane.isError ? "Tool failed:" : "Inspected with";
    const friendly = friendlyToolDescription(pane.tool, cfg.list.label);
    return (
      <div className="space-y-3">
        <div className={`rounded-md border-2 p-3 ${pane.isError ? "bg-red-50 border-red-300" : pane.isWrite ? "bg-emerald-50 border-emerald-300" : "bg-blue-50 border-blue-300"}`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base">{pane.isError ? "✗" : pane.isWrite ? "✓" : "🔎"}</span>
            <span className={`text-sm font-semibold ${pane.isError ? "text-red-800" : pane.isWrite ? "text-emerald-800" : "text-blue-800"}`}>{friendly.title}</span>
          </div>
          {friendly.subtitle && (
            <div className={`text-[11px] ${pane.isError ? "text-red-700" : pane.isWrite ? "text-emerald-700" : "text-blue-700"}`}>
              {friendly.subtitle}
            </div>
          )}
        </div>
        <div className="border rounded-md bg-gray-50">
          <PaneField label="Tool" value={pane.tool} changed={false} mono />
          <PaneField label="Agent" value={pane.agent} changed={false} mono />
          <PaneField label="Kind"  value={pane.isWrite ? "write" : pane.isError ? "error" : "read"} changed={false} mono />
        </div>
        <div className="text-[10px] text-gray-500 italic">{verb} <span className="font-mono">{pane.tool}</span>. No visible row was touched in the {cfg.appLabel} view.</div>
      </div>
    );
  }

  const title = titleOrFallback(row, cfg);
  const status = cfg.list.statusCol ? row.values[cfg.list.statusCol] : null;
  const priority = cfg.list.priorityCol ? row.values[cfg.list.priorityCol] : null;
  const assignee = cfg.list.assignedToCol ? userLabel(row.values[cfg.list.assignedToCol]) : "";

  // Pane sub-line: prefer human context (from / assignee / status) over
  // a raw row id, but keep a short id suffix as a stable identifier.
  const fromName = cfg.list.fromCol ? userLabel(row.values[cfg.list.fromCol]) : "";
  const subline = [
    fromName ? `from ${fromName}` : "",
    !fromName && assignee ? `to ${assignee}` : "",
    `#${row.id.slice(-6)}`,
  ].filter(Boolean).join(" · ");

  const breadcrumb = (
    <div className="flex items-center gap-2 text-[11px] border-b pb-2 mb-2">
      <span className="text-base">{cfg.list.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-gray-900 font-medium truncate">{title}</div>
        <div className="text-gray-500 text-[10px] truncate">{subline}</div>
      </div>
    </div>
  );

  /* ── Title focus ── */
  if (pane.focus === "title") {
    const beforeT = String(before?.[cfg.list.titleCol] ?? "");
    const afterT  = String(after?.[cfg.list.titleCol] ?? row.values[cfg.list.titleCol] ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>{cfg.colLabels?.[cfg.list.titleCol] || "Title"}</FieldLabel>
        {pane.isWrite && beforeT && beforeT !== afterT ? (
          <DiffBlock before={beforeT} after={afterT} kind="text" />
        ) : (
          <ReadField value={afterT} />
        )}
      </div>
    );
  }

  /* ── Status focus ── */
  if (pane.focus === "status") {
    const col = cfg.list.statusCol || "status";
    const beforeS = String(before?.[col] ?? "");
    const afterS  = String(after?.[col]  ?? status ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>{cfg.colLabels?.[col] || "Status"}</FieldLabel>
        {pane.isWrite && beforeS !== afterS ? (
          <div className="flex items-center gap-3">
            <StatusBadge val={beforeS} cfg={cfg} struck />
            <span className="text-amber-600">→</span>
            <StatusBadge val={afterS} cfg={cfg} big />
          </div>
        ) : (
          <div><StatusBadge val={afterS} cfg={cfg} big /></div>
        )}
      </div>
    );
  }

  /* ── Priority focus ── */
  if (pane.focus === "priority") {
    const col = cfg.list.priorityCol || "priority";
    const beforeP = String(before?.[col] ?? "");
    const afterP  = String(after?.[col]  ?? priority ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>{cfg.colLabels?.[col] || "Priority"}</FieldLabel>
        {pane.isWrite && beforeP !== afterP ? (
          <div className="flex items-center gap-3">
            <PriorityBadge val={beforeP} cfg={cfg} struck />
            <span className="text-amber-600">→</span>
            <PriorityBadge val={afterP} cfg={cfg} big />
          </div>
        ) : (
          <PriorityBadge val={afterP} cfg={cfg} big />
        )}
      </div>
    );
  }

  /* ── Assignee / owner focus ── */
  if (pane.focus === "assignee" || pane.focus === "owner") {
    const col = cfg.list.assignedToCol || "owner_id";
    const beforeUid = String(before?.[col] ?? "");
    const afterUid  = String(after?.[col]  ?? row.values[col] ?? "");
    const beforeName = userLabel(beforeUid);
    const afterName  = userLabel(afterUid) || assignee;
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>{cfg.colLabels?.[col] || (pane.focus === "owner" ? "Owner" : "Assignee")}</FieldLabel>
        {pane.isWrite && beforeUid !== afterUid ? (
          <div className="flex items-center gap-3">
            <AvatarLine name={beforeName || "—"} struck />
            <span className="text-amber-600">→</span>
            <AvatarLine name={afterName || "—"} highlight />
          </div>
        ) : (
          <AvatarLine name={afterName || "—"} highlight />
        )}
      </div>
    );
  }

  /* ── Recipients focus ── */
  if (pane.focus === "recipients") {
    const fields: Array<[string, string]> = [
      ["to_address", "To"], ["cc_address", "Cc"], ["bcc_address", "Bcc"], ["from_address", "From"],
    ];
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>Recipients</FieldLabel>
        <div className="border rounded-md bg-gray-50">
          {fields.map(([col, label]) => {
            const v = String(row.values[col] ?? after?.[col] ?? "");
            const changed = (pane.change?.cols ?? []).includes(col);
            const bef = String(before?.[col] ?? "");
            return v || changed ? (
              <PaneField key={col} label={label} value={v} changed={changed} before={bef} after={String(after?.[col] ?? v)} mono />
            ) : null;
          })}
        </div>
      </div>
    );
  }

  /* ── Description / body / snippet focus ── */
  if (pane.focus === "description" || pane.focus === "body" || pane.focus === "snippet") {
    const col = pane.focus === "snippet" ? (cfg.list.snippetCol || "snippet")
              : pane.focus === "body"    ? (cfg.list.snippetCol || "body" )
              :                            "description";
    const beforeV = String(before?.[col] ?? "");
    const afterV  = String(after?.[col]  ?? row.values[col] ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>{cfg.colLabels?.[col] || col}</FieldLabel>
        {pane.isWrite && beforeV !== afterV ? (
          <div className="space-y-2">
            <div className="text-[10px] text-red-600 font-medium">— before</div>
            <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-[11px] text-red-700 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {beforeV || <span className="italic text-red-400">∅</span>}
            </div>
            <div className="text-[10px] text-emerald-700 font-medium">+ after</div>
            <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-[11px] text-emerald-900 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {afterV || <span className="italic text-emerald-500">∅</span>}
            </div>
          </div>
        ) : (
          <div className="px-2 py-2 rounded border bg-gray-50 text-[11px] text-gray-800 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {afterV || <span className="italic text-gray-400">∅</span>}
          </div>
        )}
      </div>
    );
  }

  /* ── Move focus ── */
  if (pane.focus === "move" || pane.focus === "category") {
    const col = cfg.list.parentCol || "parent_id";
    const beforeP = String(before?.[col] ?? "");
    const afterP  = String(after?.[col]  ?? row.values[col] ?? "");
    // Resolve the FK to the rail entity's display name (drives, accounts,
    // services, channels) so we show "Engineering → Marketing" instead
    // of "chnl_3f8a → chnl_91cd".
    const railTable = cfg.rail?.table;
    const railLookup = railTable ? rowLookup(railTable) : {};
    const labelFor = (val: string) => {
      if (!val) return "—";
      const r = railLookup[val];
      if (!r) return prettifyId(val);
      return firstNonEmpty(r.values, [
        cfg.rail?.titleCol || "name", "name", "display_name", "title", "summary",
      ]) || prettifyId(val);
    };
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>{cfg.colLabels?.[col] || cfg.rail?.label || "Container"}</FieldLabel>
        {pane.isWrite && beforeP !== afterP ? (
          <div className="flex items-center gap-3 text-[11px]">
            <span className="px-2 py-1 rounded border bg-red-50 border-red-200 line-through text-red-700 truncate max-w-[120px]" title={beforeP}>{labelFor(beforeP)}</span>
            <span className="text-amber-600 text-xl">📦→</span>
            <span className="px-2 py-1 rounded border bg-emerald-50 border-emerald-300 text-emerald-800 truncate max-w-[120px]" title={afterP}>{labelFor(afterP)}</span>
          </div>
        ) : (
          <span className="px-2 py-1 rounded border bg-gray-50 text-[11px] text-gray-800 truncate" title={afterP}>{labelFor(afterP)}</span>
        )}
      </div>
    );
  }

  /* ── Share focus ── */
  if (pane.focus === "share") {
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>Sharing</FieldLabel>
        {pane.change ? (
          <div className={`rounded border p-2 text-[11px] ${pane.change.op === "insert" ? "bg-emerald-50 border-emerald-300" : pane.change.op === "delete" ? "bg-red-50 border-red-300" : "bg-amber-50 border-amber-300"}`}>
            <div className="font-mono text-gray-800">{String(after?.scope_value ?? after?.user_id ?? after?.email ?? before?.user_id ?? "user")}</div>
            <div className="text-[10px] mt-1">
              role: <span className="font-mono">{String(after?.role ?? before?.role ?? "—")}</span>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-gray-500 italic">Agent inspected access rules.</div>
        )}
      </div>
    );
  }

  /* ── Labels focus ── */
  if (pane.focus === "labels") {
    const col = "label_ids";
    const beforeL = String(before?.[col] ?? "");
    const afterL  = String(after?.[col]  ?? row.values[col] ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <FieldLabel>Labels</FieldLabel>
        {pane.isWrite && beforeL !== afterL ? (
          <DiffBlock before={beforeL} after={afterL} kind="text" />
        ) : (
          <ReadField value={afterL} />
        )}
      </div>
    );
  }

  /* ── General fallback: show all changed columns as PaneField rows ── */
  const cols = pane.change?.cols ?? [];
  return (
    <div className="space-y-3">
      {breadcrumb}
      {cols.length > 0 ? (
        <div className="border rounded-md bg-gray-50">
          {cols.map(col => (
            <PaneField
              key={col}
              label={cfg.colLabels?.[col] || col}
              value={String(after?.[col] ?? "")}
              changed
              before={String(before?.[col] ?? "")}
              after={String(after?.[col] ?? "")}
              mono
            />
          ))}
        </div>
      ) : (
        <div className="px-2 py-2 rounded border bg-gray-50 text-[11px] text-gray-700">
          {pane.isWrite ? "Agent applied changes." : pane.isError ? "Tool failed — see chat for details." : "Agent inspected this row."}
        </div>
      )}
      <div className="space-y-1 text-[10.5px] text-gray-600">
        {status !== null && status !== "" && status !== undefined && <div>Status: <StatusBadge val={status} cfg={cfg} /></div>}
        {priority !== null && priority !== "" && priority !== undefined && <div>Priority: <PriorityBadge val={priority} cfg={cfg} /></div>}
        {assignee && <div>Assignee: <span className="font-mono">{assignee}</span></div>}
      </div>
    </div>
  );
}

/* ── Small reusable bits ──────────────────────────────────────────── */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wide text-gray-500">{children}</div>;
}

function DiffBlock({ before, after, kind: _kind }: { before: string; after: string; kind?: "text" }) {
  return (
    <div className="space-y-1">
      <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-[11px] text-red-700 line-through truncate" title={before}>{before || "∅"}</div>
      <div className="text-amber-600 text-center text-[10px]">↓</div>
      <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-[11px] text-emerald-900 font-medium truncate" title={after}>{after || "∅"}</div>
    </div>
  );
}

function ReadField({ value }: { value: string }) {
  return <div className="px-2 py-1.5 rounded border bg-gray-50 text-[11px] text-gray-800 truncate">{value || <span className="italic text-gray-400">∅</span>}</div>;
}

function StatusBadge({ val, cfg, struck, big }: { val: unknown; cfg: DomainViewConfig; struck?: boolean; big?: boolean }) {
  const s = String(val).toLowerCase();
  const tone = cfg.statusTone?.[s] || cfg.statusTone?.[String(val)] || "gray";
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.gray;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border ${cls.bg} ${cls.text} ${cls.border} ${big ? "text-xs font-semibold" : "text-[10px]"} ${struck ? "line-through opacity-70" : ""}`}>
      {String(val) || "—"}
    </span>
  );
}

function PriorityBadge({ val, cfg, struck, big }: { val: unknown; cfg: DomainViewConfig; struck?: boolean; big?: boolean }) {
  const tone = cfg.priorityTone?.[String(val).toLowerCase()] || cfg.priorityTone?.[String(val)] || "gray";
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.gray;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border ${cls.bg} ${cls.text} ${cls.border} ${big ? "text-xs font-semibold" : "text-[10px]"} ${struck ? "line-through opacity-70" : ""}`}>
      ⚑ {String(val) || "—"}
    </span>
  );
}

function AvatarLine({ name, struck, highlight }: { name: string; struck?: boolean; highlight?: boolean }) {
  const init = name.split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase() || "?";
  return (
    <div className={`flex items-center gap-2 ${struck ? "opacity-60 line-through" : ""}`}>
      <span className={`w-7 h-7 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 text-white flex items-center justify-center text-[10px] font-semibold ${highlight ? "ring-2 ring-emerald-300" : ""}`}>
        {init}
      </span>
      <span className="text-[12px] text-gray-900 truncate max-w-[140px]" title={name}>{name}</span>
    </div>
  );
}

function PaneField({ label, value, changed, before, after, mono }: {
  label: string; value: string; changed: boolean;
  before?: string; after?: string; mono?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 border-b last:border-b-0 text-[11px] ${changed ? "bg-amber-50" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-gray-500 w-20 shrink-0">{label}</span>
      <span className={`flex-1 min-w-0 truncate ${mono ? "font-mono text-gray-800" : "text-gray-800"}`}>
        {changed && before !== undefined && after !== undefined ? (
          <span className="inline-flex items-center gap-1 max-w-full">
            <span className="line-through text-red-400 truncate max-w-[80px]" title={before}>{before || "∅"}</span>
            <span className="text-amber-600">→</span>
            <span className="text-emerald-700 font-medium truncate max-w-[100px]" title={after}>{after || "∅"}</span>
          </span>
        ) : (
          value || <span className="italic text-gray-400">∅</span>
        )}
      </span>
      {changed && <span className="px-1 py-0 rounded text-[8.5px] font-bold text-white bg-amber-500">EDIT</span>}
    </div>
  );
}
