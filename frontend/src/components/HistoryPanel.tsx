import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

/* ────────────────────────────────────────────────────────────────
 *  HistoryPanel — "Recents" rail in the left sidebar.
 *
 *  Renders the signed-in user's past conversations (shares) as a
 *  clickable, scrollable list, ChatGPT-style. Hidden entirely when
 *  the user is a guest (no userSub) so it never tempts logged-out
 *  visitors with an empty list.
 *
 *  Wiring:
 *  • Fetches GET /users/me/shares?sub=<sub> when userSub changes
 *    or when ``refreshTick`` is bumped by the parent (after a new
 *    share is created, after sign-in, etc).
 *  • Clicking an item delegates to onOpen(shareId), which the
 *    parent should hook to useOrchestration.openHistoryItem so the
 *    conversation lands in editable mode (not read-only).
 *  ──────────────────────────────────────────────────────────────── */

export interface HistoryItem {
  id: string;
  created_at: number;
  title: string | null;
  mode: "reasoning" | "enterprise" | string;
  dataset?: string | null;
  enterprise_task_id?: string | null;
  enterprise_domain?: string | null;
  problem_snippet: string;
  answer_snippet: string;
  agent_count: number;
}

interface Props {
  userSub: string | null;
  /** Bump from the parent to force a re-fetch (e.g. after a new
   *  share is created). Initial fetch fires whenever userSub changes
   *  even without a tick. */
  refreshTick: number;
  /** Called with the share id when the user clicks an item. The
   *  parent is responsible for confirming/clobbering any in-progress
   *  conversation and switching the UI to the loaded snapshot. */
  onOpen: (shareId: string) => void;
  /** The share id currently rendered in the UI (if any), so we can
   *  highlight the active row. */
  activeShareId?: string | null;
  /** Per-user set of share ids the user has dismissed from the
   *  Recents rail. Frontend-only — the backend share record is left
   *  untouched, so the link still resolves and other tabs (e.g. the
   *  Shares modal) keep working. */
  hiddenIds?: ReadonlySet<string>;
  /** Hide a row from this browser. Called when the user clicks the
   *  × button on a hover'd row. */
  onHide?: (shareId: string) => void;
}

const PAGE_LIMIT = 50;

export function HistoryPanel({ userSub, refreshTick, onOpen, activeShareId, hiddenIds, onHide }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (sub: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/users/me/shares?sub=${encodeURIComponent(sub)}&limit=${PAGE_LIMIT}`,
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(detail);
      }
      const data: { items: HistoryItem[]; count: number } = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userSub) {
      setItems([]);
      setError(null);
      return;
    }
    void refetch(userSub);
  }, [userSub, refreshTick, refetch]);

  // Filter out items the user has dismissed from this browser. Done
  // here (not in the parent) so the empty-state copy below correctly
  // reflects "no items to show" when everything has been hidden.
  const visibleItems = useMemo(
    () => hiddenIds && hiddenIds.size > 0
      ? items.filter(i => !hiddenIds.has(i.id))
      : items,
    [items, hiddenIds],
  );

  // Render nothing for guests — the AuthPanel below already invites
  // them to log in for personalized history. A blank "Recents" rail
  // here would just add visual noise.
  if (!userSub) return null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-none flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
          Recents
        </span>
        <button
          onClick={() => userSub && void refetch(userSub)}
          disabled={loading}
          title="Refresh history"
          className="text-[10px] text-gray-400 hover:text-gray-700 disabled:opacity-40 px-1.5 py-0.5 rounded hover:bg-gray-100"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-1">
        {error && (
          <div className="px-2 py-1 text-[11px] text-red-600">
            History load failed: {error}
          </div>
        )}

        {!error && visibleItems.length === 0 && !loading && (
          <div className="px-2 py-2 text-[11px] text-gray-400 leading-snug">
            {items.length === 0
              ? "No saved conversations yet. Start chatting and your conversation will show up here automatically."
              : "All conversations are hidden from this browser. They still exist server-side — clear browser data to restore them."}
          </div>
        )}

        {visibleItems.length > 0 && (
          <ul className="space-y-0.5">
            {visibleItems.map(item => (
              <HistoryRow
                key={item.id}
                item={item}
                isActive={!!activeShareId && activeShareId === item.id}
                onClick={() => onOpen(item.id)}
                onHide={onHide ? () => onHide(item.id) : undefined}
              />
            ))}
          </ul>
        )}

        {loading && visibleItems.length === 0 && (
          <ul className="space-y-1 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="h-6 rounded bg-gray-100 animate-pulse" />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────── */

function HistoryRow({
  item, isActive, onClick, onHide,
}: {
  item: HistoryItem;
  isActive: boolean;
  onClick: () => void;
  /** Hide this row from the local browser. Omitted when the parent
   *  doesn't wire ``onHide`` — keeps the button hidden in that case. */
  onHide?: () => void;
}) {
  const label = useMemo(() => {
    if (item.title && item.title.trim()) return item.title.trim();
    if (item.problem_snippet) {
      // First line, trimmed — matches how ChatGPT collapses to a
      // single-line title. ~60 chars fits the 240px sidebar.
      const firstLine = item.problem_snippet.split(/\r?\n/, 1)[0].trim();
      return firstLine || "(empty)";
    }
    if (item.enterprise_task_id) return item.enterprise_task_id;
    return "Untitled conversation";
  }, [item.title, item.problem_snippet, item.enterprise_task_id]);

  const subtitle = useMemo(() => formatRelative(item.created_at), [item.created_at]);
  const modeColor =
    item.mode === "enterprise"
      ? "bg-sky-50 text-sky-700 border-sky-100"
      : "bg-gray-50 text-gray-600 border-gray-200";
  const modeShort = item.mode === "enterprise" ? (item.enterprise_domain || "ent") : (item.dataset || "ask");

  const handleHide = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!onHide) return;
    onHide();
  };

  return (
    <li className="group/row relative">
      <button
        onClick={onClick}
        title={item.problem_snippet || label}
        className={`w-full text-left pl-2 pr-7 py-1.5 rounded-md text-[12px] transition-colors group flex flex-col gap-0.5 ${
          isActive
            ? "bg-blue-50 text-blue-900"
            : "text-gray-700 hover:bg-gray-100"
        }`}
      >
        <span className="truncate w-full">{label}</span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
          <span className={`px-1 py-px rounded border capitalize ${modeColor}`}>{modeShort}</span>
          <span className="truncate">{subtitle}</span>
        </span>
      </button>
      {onHide && (
        <button
          onClick={handleHide}
          title="Remove from this list (the conversation stays saved on the server)"
          aria-label="Remove from history"
          className="absolute right-1 top-1.5 w-5 h-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/row:opacity-100 hover:text-gray-700 hover:bg-gray-200 transition-opacity"
        >
          <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      )}
    </li>
  );
}

/* ───────────────────────────────────────────────────────────────── */

/** Compact relative timestamp ("3m ago", "2d ago", "Mar 4"). Matches
 *  ChatGPT's secondary-text density without pulling in a date lib. */
function formatRelative(ts: number | undefined | null): string {
  if (!ts) return "";
  const ms = ts * 1000;
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
