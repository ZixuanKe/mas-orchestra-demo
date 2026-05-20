import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Node, Edge as FlowEdge, Background, Controls,
  Handle, Position, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SandboxSnapshot, SandboxDiff, SandboxDiffEvent, SandboxOpKind } from "../types";

interface Props {
  snapshot: SandboxSnapshot | null;
  diffs: SandboxDiff[];
  status: string | null;
  isExecuting: boolean;
}

/* ── Per-table styling ── */
const TABLE_COLORS: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  users:     { bg: "bg-purple-50",  border: "border-purple-300", text: "text-purple-700",  icon: "👤" },
  calendars: { bg: "bg-blue-50",    border: "border-blue-300",   text: "text-blue-700",    icon: "🗓" },
  events:    { bg: "bg-emerald-50", border: "border-emerald-300",text: "text-emerald-700", icon: "📌" },
  acls:      { bg: "bg-amber-50",   border: "border-amber-300",  text: "text-amber-700",   icon: "🔑" },
  attendees: { bg: "bg-pink-50",    border: "border-pink-300",   text: "text-pink-700",    icon: "✉️" },
};
const DEFAULT_STYLE = { bg: "bg-gray-50", border: "border-gray-300", text: "text-gray-700", icon: "▦" };

function labelFor(table: string, values: Record<string, unknown>): string {
  const candidates: Record<string, string[]> = {
    users:     ["name", "email"],
    calendars: ["summary"],
    events:    ["summary"],
    acls:      ["role", "scope_value", "scope_type"],
    attendees: ["email", "name"],
  };
  for (const c of candidates[table] || ["summary", "name", "title", "label"]) {
    const v = values[c];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function trim(s: string, n = 22): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/* ── Custom xyflow node: an entity row ── */
type Op = "insert" | "update" | "delete";

interface ChangeRecord {
  op: Op;
  cols: string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  byAgent?: string;
  flashing: boolean;  // true while the recent-change pulse is active
}

type NodeData = {
  table: string;
  rowId: string;
  label: string;
  change: ChangeRecord | null;
};

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") return v.length > 36 ? v.slice(0, 35) + "…" : v;
  return String(v);
}

function EntityNode({ data }: { data: NodeData }) {
  const style = TABLE_COLORS[data.table] || DEFAULT_STYLE;
  const ch = data.change;

  // Visual treatment per op, with strong distinction so changes pop.
  const opTheme: Record<Op, { bg: string; border: string; badge: string; badgeText: string; ringColor: string }> = {
    insert: {
      bg: "bg-emerald-50",
      border: "border-emerald-500",
      badge: "bg-emerald-500",
      badgeText: "NEW",
      ringColor: "shadow-emerald-400/60",
    },
    update: {
      bg: "bg-amber-50",
      border: "border-amber-500",
      badge: "bg-amber-500",
      badgeText: "EDIT",
      ringColor: "shadow-amber-400/60",
    },
    delete: {
      bg: "bg-red-50",
      border: "border-red-400",
      badge: "bg-red-500",
      badgeText: "DEL",
      ringColor: "shadow-red-400/60",
    },
  };

  const theme = ch ? opTheme[ch.op] : null;
  const scale = ch?.flashing ? "scale-110" : ch ? "scale-105" : "";
  const shadow = ch?.flashing ? `shadow-lg ${theme!.ringColor}` : ch ? "shadow-md" : "shadow-sm";
  const containerCls = ch
    ? `${theme!.bg} border-2 ${theme!.border} ${ch.op === "delete" ? "opacity-70" : ""}`
    : `bg-white border ${style.border}`;
  const labelDeco = ch?.op === "delete" ? "line-through text-red-700" : "text-gray-800";

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: "#cbd5e1", border: "none", width: 6, height: 6 }} />
      <div className={`relative px-2 py-1 rounded-md transition-all duration-300 min-w-[150px] max-w-[220px] ${containerCls} ${shadow} ${scale}`}>
        {/* Op badge */}
        {ch && theme && (
          <div className={`absolute -top-1.5 -right-1.5 px-1.5 py-0.5 rounded-md text-[8.5px] font-bold text-white tracking-wide ${theme.badge} ${ch.flashing ? "animate-pulse" : ""}`}>
            {theme.badgeText}
          </div>
        )}
        {/* Flashing halo (CSS pulse around the box, on top of color) */}
        {ch?.flashing && (
          <div className={`absolute inset-0 rounded-md ring-4 ${ch.op === "insert" ? "ring-emerald-300" : ch.op === "update" ? "ring-amber-300" : "ring-red-300"} animate-pulse pointer-events-none`} />
        )}

        <div className={`text-[10px] font-mono ${style.text} flex items-center gap-1`}>
          <span>{style.icon}</span>
          <span className="truncate">{trim(data.rowId, 18)}</span>
        </div>
        {data.label && <div className={`text-[11px] font-medium ${labelDeco} truncate`}>{trim(data.label, 28)}</div>}

        {/* Update detail: show changed columns with before → after */}
        {ch?.op === "update" && ch.cols.length > 0 && (
          <div className="mt-1 space-y-0.5 border-t border-amber-200 pt-1">
            {ch.cols.slice(0, 3).map(col => (
              <div key={col} className="text-[9.5px] leading-tight">
                <div className="font-mono text-amber-800">{col}</div>
                <div className="flex items-center gap-1 ml-1">
                  <span className="text-red-500 line-through truncate max-w-[80px]" title={String(ch.before?.[col] ?? "")}>{fmt(ch.before?.[col])}</span>
                  <span className="text-amber-700">→</span>
                  <span className="text-emerald-700 font-medium truncate max-w-[80px]" title={String(ch.after?.[col] ?? "")}>{fmt(ch.after?.[col])}</span>
                </div>
              </div>
            ))}
            {ch.cols.length > 3 && <div className="text-[9px] text-amber-600">+{ch.cols.length - 3} more</div>}
          </div>
        )}

        {/* Insert detail: agent that created this row */}
        {ch?.op === "insert" && ch.byAgent && (
          <div className="text-[9px] text-emerald-700 font-mono mt-0.5 truncate">by {ch.byAgent}</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#cbd5e1", border: "none", width: 6, height: 6 }} />
    </>
  );
}

/** Per-table header with live change counts AND recent-activity glow.
 *
 * ``recent`` describes the most recent step that touched this table:
 *   - "read"  → soft blue pulse on the header (the agent just queried it).
 *   - "write" → covered by the per-row badges already; we add a green halo too.
 *   - "error" → red pulse so the user sees the failed touch.
 *   - undefined → no extra styling.
 *
 * The halo auto-fades after FLASH_MS via the parent's timer.
 */
function TableHeaderNode({ data }: {
  data: {
    table: string; count: number;
    inserts: number; updates: number; deletes: number;
    recent?: { kind: SandboxOpKind; byAgent?: string | null; toolName?: string | null; flashing: boolean } | null;
  };
}) {
  const style = TABLE_COLORS[data.table] || DEFAULT_STYLE;
  const hasChanges = data.inserts + data.updates + data.deletes > 0;
  const recent = data.recent;
  const recentRing = recent && recent.flashing
    ? recent.kind === "read"  ? "ring-4 ring-blue-300 animate-pulse"
    : recent.kind === "write" ? "ring-4 ring-emerald-300 animate-pulse"
    : recent.kind === "error" ? "ring-4 ring-red-300 animate-pulse"
    :                           ""
    : "";
  // Persistent (post-flash) tint so the user can still see WHICH tables were
  // touched in this run even after the pulse has faded.
  const recentTint = recent && !recent.flashing
    ? recent.kind === "read"  ? "ring-1 ring-blue-200"
    : recent.kind === "error" ? "ring-1 ring-red-200"
    :                           ""
    : "";
  return (
    <div className={`relative px-3 py-2 rounded-md border-2 ${style.bg} ${hasChanges ? "border-gray-400 shadow-md" : style.border} text-xs flex flex-col gap-1 min-w-[180px] ${recentRing} ${recentTint} transition-all`}>
      <div className={`flex items-center gap-2 font-semibold ${style.text}`}>
        <span className="text-base">{style.icon}</span>
        <span className="uppercase tracking-wide">{data.table}</span>
        <span className="ml-auto text-[10px] font-normal opacity-70">{data.count}</span>
      </div>
      {hasChanges && (
        <div className="flex flex-wrap gap-1">
          {data.inserts > 0 && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500 text-white">+{data.inserts} NEW</span>}
          {data.updates > 0 && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500 text-white">±{data.updates} EDIT</span>}
          {data.deletes > 0 && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500 text-white">−{data.deletes} DEL</span>}
        </div>
      )}
      {/* Read/no-op marker (no row-level changes to surface, so we put a
          chip on the header explaining the recent touch). */}
      {recent && recent.kind === "read" && !hasChanges && (
        <div className="flex items-center gap-1 text-[9.5px] text-blue-700">
          <span>🔎</span><span className="font-mono truncate" title={recent.toolName || ""}>{recent.toolName || "read"}</span>
        </div>
      )}
      {recent && recent.kind === "error" && (
        <div className="flex items-center gap-1 text-[9.5px] text-red-700">
          <span>✗</span><span className="font-mono truncate" title={recent.toolName || ""}>{recent.toolName || "failed"}</span>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { entity: EntityNode, tableHeader: TableHeaderNode };

const FLASH_MS = 5000; // how long the bright pulse lasts


/** Sticky one-line summary of the most recent MCPAgent step's effect on the
 *  sandbox. Lives just under the panel header. Drives the user's confidence
 *  that something happened even when the row-level graph stays still
 *  (read-only tool, no-op, or error).  */
function ActivityRibbon({ step }: {
  step: {
    kind: SandboxOpKind; byAgent: string;
    toolName: string | null; eventCount: number; affectedTables: string[];
  };
}) {
  const themes: Record<SandboxOpKind, { bg: string; border: string; text: string; icon: string; label: string }> = {
    write: { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-800", icon: "📝", label: `${step.eventCount} row change${step.eventCount === 1 ? "" : "s"}` },
    read:  { bg: "bg-blue-50",    border: "border-blue-300",    text: "text-blue-800",    icon: "🔎", label: "read (no changes)" },
    noop:  { bg: "bg-gray-50",    border: "border-gray-300",    text: "text-gray-700",    icon: "ⓘ",  label: "skipped — agent did not call its tool" },
    error: { bg: "bg-red-50",     border: "border-red-300",     text: "text-red-800",     icon: "✗",  label: "tool failed — see chat for details" },
  };
  const t = themes[step.kind];
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 border-b text-[11px] ${t.bg} ${t.border} ${t.text} flex-none animate-[fadeIn_0.3s_ease-out]`}>
      <span className="text-sm leading-none">{t.icon}</span>
      <span className="font-semibold uppercase tracking-wide">{step.kind}</span>
      <span className="opacity-70">·</span>
      <span className="truncate"><span className="font-mono">{step.byAgent}</span></span>
      {step.toolName && (
        <>
          <span className="opacity-70">·</span>
          <span className="font-mono truncate" title={step.toolName}>{step.toolName}</span>
        </>
      )}
      <span className="opacity-70">·</span>
      <span className="truncate">{t.label}</span>
      {step.affectedTables.length > 0 && (
        <span className="ml-auto flex items-center gap-1 shrink-0">
          {step.affectedTables.slice(0, 3).map(tbl => (
            <span key={tbl} className="px-1.5 py-0.5 rounded bg-white/60 border border-current/30 text-[10px] font-mono">{tbl}</span>
          ))}
          {step.affectedTables.length > 3 && <span className="text-[10px] opacity-70">+{step.affectedTables.length - 3}</span>}
        </span>
      )}
    </div>
  );
}

export function SandboxPanel({ snapshot, diffs, status, isExecuting }: Props) {
  // ── Per-run change tracking ───────────────────────────────────────────
  // `runChanges` is the cumulative change record for THIS run. Each entry
  // stays in the map until a new run starts (i.e. `diffs` is reset to []),
  // so the user can clearly see what changed during this execution even
  // after the flash animation has faded.
  const [runChanges, setRunChanges] = useState<Record<string, ChangeRecord>>({});

  // Per-table "recent touch" record. Mirrors `runChanges` but at table
  // granularity, so that read-only / errored / no-op steps (which produce no
  // row-level events) still leave a visible mark on the affected table
  // header. Flashes for FLASH_MS, then keeps a subtle tint.
  type TableActivity = {
    kind: SandboxOpKind; flashing: boolean;
    byAgent?: string | null; toolName?: string | null;
  };
  const [tableActivity, setTableActivity] = useState<Record<string, TableActivity>>({});

  // Most recent step summary, rendered as a sticky "activity ribbon" just
  // under the header. Always populated whenever ANY step (read / write /
  // noop / error) reports back — so the user can see live what each agent
  // did regardless of whether it mutated the DB.
  const [lastStep, setLastStep] = useState<{
    kind: SandboxOpKind;
    byAgent: string;
    toolName: string | null;
    eventCount: number;
    affectedTables: string[];
    ts: number;
  } | null>(null);

  // Tracks how many diff entries we've already folded into ``runChanges`` so
  // that loading a shared snapshot — which arrives as a fully-populated
  // ``diffs`` array all at once — replays EVERY step into the cumulative
  // state, instead of dropping all but the final diff on the floor.
  const processedDiffCount = useRef(0);

  // Reset cumulative changes when diffs is reset (new run started).
  useEffect(() => {
    if (diffs.length === 0) {
      setRunChanges({});
      setTableActivity({});
      setLastStep(null);
      processedDiffCount.current = 0;
    } else if (diffs.length < processedDiffCount.current) {
      // Defensive: the array shrunk (e.g. user navigated to a different
      // share). Reprocess from scratch.
      processedDiffCount.current = 0;
      setRunChanges({});
      setTableActivity({});
    }
  }, [diffs.length]);

  useEffect(() => {
    if (diffs.length === 0) return;
    // Apply any new diffs we haven't seen yet (1 in live mode, many on share
    // load). Always update ``lastStep`` to the most recent diff so the
    // activity ribbon reflects the final state.
    const startIdx = processedDiffCount.current;
    if (startIdx >= diffs.length) return;
    const newDiffs = diffs.slice(startIdx);
    processedDiffCount.current = diffs.length;
    const latest = diffs[diffs.length - 1];

    // Update the activity ribbon every time a step reports back, regardless
    // of whether it produced row-level events. ``op_kind`` is set by the
    // backend; we fall back to a write/read heuristic for older payloads.
    const kind: SandboxOpKind = latest.op_kind
      ?? (latest.events.length > 0 ? "write" : "read");
    const affected = latest.affected_tables && latest.affected_tables.length > 0
      ? latest.affected_tables
      : [...new Set(latest.events.map(e => e.table))];
    setLastStep({
      kind,
      byAgent: latest.by_agent,
      toolName: latest.tool_name,
      eventCount: latest.events.length,
      affectedTables: affected,
      ts: latest.ts,
    });

    // Mark every affected table from the LATEST diff with a flashing
    // recent-activity halo (so the activity ribbon and header glow match).
    // On a multi-diff replay (share load), only the final step pulses;
    // earlier steps still leave persistent tint via the merge below.
    if (affected.length > 0) {
      setTableActivity(prev => {
        const next = { ...prev };
        for (const t of affected) {
          next[t] = {
            kind, flashing: true,
            byAgent: latest.by_agent,
            toolName: latest.tool_name,
          };
        }
        return next;
      });
    }

    setRunChanges(prev => {
      const next: Record<string, ChangeRecord> = { ...prev };
      // Fold EVERY un-processed diff into the cumulative change map (1 in
      // the live SSE case, N on share load).
      for (const d of newDiffs) {
        for (const ev of d.events) {
          const key = `${ev.table}::${ev.row_id}`;
          // If we already have an INSERT recorded for this row and now see
          // an UPDATE, keep showing it as NEW (it's still a new row in this
          // run); merge the changed columns into "post-creation tweaks".
          const existing = next[key];
          let op = ev.op;
          let cols = ev.changed_columns || [];
          if (existing?.op === "insert" && ev.op === "update") {
            op = "insert";
            cols = [...new Set([...(existing.cols || []), ...cols])];
          }
          next[key] = {
            op,
            cols,
            before: ev.before ?? existing?.before,
            after: ev.after ?? existing?.after,
            byAgent: existing?.byAgent || d.by_agent,
            // Only the LATEST diff's rows flash; earlier ones land
            // pre-faded so a share doesn't strobe on load.
            flashing: d === latest,
          };
        }
      }
      return next;
    });

    // After FLASH_MS, stop flashing but keep the change record on the node.
    const t = setTimeout(() => {
      setRunChanges(prev => {
        const out: Record<string, ChangeRecord> = {};
        for (const [k, v] of Object.entries(prev)) {
          out[k] = { ...v, flashing: false };
        }
        return out;
      });
      setTableActivity(prev => {
        const out: Record<string, TableActivity> = {};
        for (const [k, v] of Object.entries(prev)) {
          out[k] = { ...v, flashing: false };
        }
        return out;
      });
    }, FLASH_MS);
    return () => clearTimeout(t);
  }, [diffs]);

  // ── Build xyflow nodes/edges ─────────────────────────────────────────
  const { nodes, edges, totalChanges } = useMemo(() => {
    if (!snapshot) return { nodes: [] as Node[], edges: [] as FlowEdge[], totalChanges: { inserts: 0, updates: 0, deletes: 0 } };

    const ROW_CAP = 18;
    const visibleTables = snapshot.tables.filter(t => t.rows.length > 0);
    const columnSpacing = 260;
    const rowSpacing = 78;  // a bit more vertical room for the richer cards
    const headerY = 0;
    const firstRowY = 70;

    const totalChanges = { inserts: 0, updates: 0, deletes: 0 };
    const perTable: Record<string, { inserts: number; updates: number; deletes: number }> = {};
    for (const ch of Object.values(runChanges)) {
      totalChanges[ch.op === "insert" ? "inserts" : ch.op === "update" ? "updates" : "deletes"]++;
    }

    // Also collect inserts that aren't in the snapshot yet (a row may be
    // reported in the diff stream slightly before the refreshed snapshot
    // arrives). For these we synthesize a ghost row from the diff's
    // ``after`` payload so the user sees them flash immediately.
    const snapshotRowKeys = new Set<string>();
    for (const t of snapshot.tables) {
      for (const r of t.rows) snapshotRowKeys.add(`${t.table}::${r.id}`);
    }
    const ghostRowsByTable: Record<string, { id: string; values: Record<string, unknown> }[]> = {};
    for (const [key, ch] of Object.entries(runChanges)) {
      if (ch.op !== "insert") continue;
      if (snapshotRowKeys.has(key)) continue;
      const [tname, rid] = key.split("::");
      (ghostRowsByTable[tname] ||= []).push({ id: rid, values: (ch.after as Record<string, unknown>) || {} });
    }

    const nodes: Node[] = [];
    // Make sure tables that received ghost inserts but have no rows in the
    // current snapshot still get a column.
    const ghostOnlyTables = Object.keys(ghostRowsByTable).filter(
      tn => !visibleTables.some(t => t.table === tn)
    );
    const allColumns = [
      ...visibleTables,
      ...ghostOnlyTables.map(tn => ({ table: tn, rows: [], pk: "id", columns: [] })),
    ];
    allColumns.forEach((t, idx) => {
      // Per-table change counts for header badge
      const pt = { inserts: 0, updates: 0, deletes: 0 };
      for (const [key, ch] of Object.entries(runChanges)) {
        if (key.startsWith(`${t.table}::`)) {
          if (ch.op === "insert") pt.inserts++;
          else if (ch.op === "update") pt.updates++;
          else pt.deletes++;
        }
      }
      perTable[t.table] = pt;

      const ghosts = ghostRowsByTable[t.table] || [];
      const totalRowsForHeader = t.rows.length + ghosts.length;
      nodes.push({
        id: `__hdr_${t.table}`,
        type: "tableHeader",
        position: { x: idx * columnSpacing, y: headerY },
        data: {
          table: t.table, count: totalRowsForHeader, ...pt,
          recent: tableActivity[t.table] || null,
        },
        draggable: false, selectable: false,
        style: { background: "transparent" },
      });

      // Sort: changed rows first (so they're visually anchored at the top),
      // then the rest. Inside changed, order: insert → update → delete.
      const opOrder: Record<Op, number> = { insert: 0, update: 1, delete: 2 };
      const rows = [...ghosts, ...t.rows].sort((a, b) => {
        const ca = runChanges[`${t.table}::${a.id}`];
        const cb = runChanges[`${t.table}::${b.id}`];
        if (ca && !cb) return -1;
        if (!ca && cb) return 1;
        if (ca && cb) return opOrder[ca.op] - opOrder[cb.op];
        return 0;
      });

      rows.slice(0, ROW_CAP).forEach((row, ridx) => {
        const key = `${t.table}::${row.id}`;
        const change = runChanges[key] || null;
        nodes.push({
          id: key,
          type: "entity",
          position: { x: idx * columnSpacing, y: firstRowY + ridx * rowSpacing },
          data: {
            table: t.table,
            rowId: row.id,
            label: labelFor(t.table, row.values),
            change,
          } as NodeData,
        });
      });

      if (rows.length > ROW_CAP) {
        nodes.push({
          id: `__more_${t.table}`,
          type: "tableHeader",
          position: { x: idx * columnSpacing, y: firstRowY + ROW_CAP * rowSpacing },
          data: { table: t.table, count: rows.length - ROW_CAP, inserts: 0, updates: 0, deletes: 0 },
          draggable: false, selectable: false,
        });
      }
    });

    const edges: FlowEdge[] = snapshot.links.map((l, i) => {
      const srcKey = `${l.source_table}::${l.source_id}`;
      const dstKey = `${l.target_table}::${l.target_id}`;
      const haveSrc = nodes.find(n => n.id === srcKey);
      const haveDst = nodes.find(n => n.id === dstKey);
      if (!haveSrc || !haveDst) return null as unknown as FlowEdge;
      // Brighten edges touching changed rows so the connection between
      // (e.g.) a new event and its calendar is also visible.
      const srcCh = runChanges[srcKey];
      const dstCh = runChanges[dstKey];
      const touchesChange = !!(srcCh || dstCh);
      return {
        id: `e_${i}`, source: srcKey, target: dstKey,
        animated: touchesChange,
        style: {
          stroke: touchesChange ? "#f59e0b" : "#e5e7eb",
          strokeWidth: touchesChange ? 2 : 1,
          opacity: touchesChange ? 1 : 0.5,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: touchesChange ? "#f59e0b" : "#cbd5e1", width: 12, height: 12 },
      } as FlowEdge;
    }).filter(Boolean);

    return { nodes, edges, totalChanges };
  }, [snapshot, runChanges, tableActivity]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-10 border-b flex items-center px-3 text-xs gap-2 flex-none bg-gradient-to-r from-gray-50 to-white">
        <span className="font-semibold text-gray-700">Sandbox</span>
        {snapshot && (
          <span className="text-gray-400 truncate">
            · {snapshot.domain} · {snapshot.tables.reduce((n, t) => n + t.rows.length, 0)} rows
          </span>
        )}
        {/* Run-total change badges, always visible during/after a run */}
        {(totalChanges.inserts + totalChanges.updates + totalChanges.deletes) > 0 && (
          <div className="flex items-center gap-1.5 ml-1">
            {totalChanges.inserts > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500 text-white">+{totalChanges.inserts}</span>
            )}
            {totalChanges.updates > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-500 text-white">±{totalChanges.updates}</span>
            )}
            {totalChanges.deletes > 0 && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-red-500 text-white">−{totalChanges.deletes}</span>
            )}
          </div>
        )}
        {(status || isExecuting) && (
          <span className="ml-auto flex items-center gap-1.5 text-amber-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="truncate max-w-[160px]">{status || "Running"}</span>
          </span>
        )}
      </div>

      {/* Activity ribbon: most recent step's effect on the sandbox.
          Always populated whenever ANY MCPAgent step reports back — so
          read-only / no-op / errored steps still get visible feedback
          (otherwise the panel would appear silent and the user couldn't
          tell a successful read from a tool that quietly failed). */}
      {lastStep && <ActivityRibbon step={lastStep} />}

      {/* Graph */}
      <div className="flex-1 min-h-0 bg-gray-50">
        {snapshot ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
            minZoom={0.2}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            zoomOnScroll
          >
            <Background gap={20} size={1} color="#e5e7eb" />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-gray-400">
            {isExecuting ? "Preparing sandbox…" : "Run the plan to see the sandbox state."}
          </div>
        )}
      </div>

      {/* Diff feed */}
      {diffs.length > 0 && (
        <div className="border-t bg-gray-50 max-h-56 overflow-y-auto flex-none">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 border-b bg-white flex items-center gap-2">
            <span>Changes timeline</span>
            <span className="text-gray-400 normal-case font-normal">· {diffs.reduce((n, d) => n + d.events.length, 0)} mutations</span>
          </div>
          <ul className="divide-y">
            {[...diffs].reverse().slice(0, 30).map((d, i) => (
              <li key={`${d.ts}-${i}`} className="px-3 py-1.5">
                <div className="text-[11px] text-gray-500 flex items-center gap-1.5">
                  <span className="font-mono text-blue-700">{d.by_agent}</span>
                  {d.tool_name && <span className="text-gray-400">→</span>}
                  {d.tool_name && <span className="font-mono text-purple-700">{d.tool_name}</span>}
                  <span className="ml-auto text-[10px] text-gray-400">
                    {d.events.length === 0 ? "no changes" : `${d.events.length} change${d.events.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                {d.events.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5">
                    {d.events.slice(0, 4).map((ev: SandboxDiffEvent, j) => (
                      <li key={j} className="text-[11px] flex items-center gap-1.5">
                        <span className={`px-1 py-0 rounded text-[8.5px] font-bold text-white ${
                          ev.op === "insert" ? "bg-emerald-500" :
                          ev.op === "update" ? "bg-amber-500" : "bg-red-500"
                        }`}>{ev.op === "insert" ? "NEW" : ev.op === "update" ? "EDIT" : "DEL"}</span>
                        <span className="font-mono text-gray-600">{ev.table}</span>
                        <span className="text-gray-400">/</span>
                        <span className="font-mono text-gray-800 truncate">{trim(ev.row_id, 22)}</span>
                        {ev.changed_columns?.length > 0 && (
                          <span className="text-amber-700 text-[10px] font-mono truncate ml-1">{ev.changed_columns.join(", ")}</span>
                        )}
                      </li>
                    ))}
                    {d.events.length > 4 && (
                      <li className="text-[10px] text-gray-400">+{d.events.length - 4} more…</li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
