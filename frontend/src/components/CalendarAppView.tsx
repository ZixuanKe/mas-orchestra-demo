import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { SandboxSnapshot, SandboxRow } from "../types";
import type { ChangeRecord, TableActivity, LastStep } from "./SandboxPanel";

/* ──────────────────────────────────────────────────────────────────────────
 *  CalendarAppView — a Google-Calendar–style mockup over the live sandbox
 *  for the ``calendar`` enterprise domain. Renders the same data the graph
 *  view shows (snapshot + per-run diffs) but in the layout a non-engineer
 *  expects to see when we say "the calendar app". Switch back to the graph
 *  via the App|Graph toggle in the panel header.
 *
 *  Diff styling parity:
 *    NEW   → emerald accent ring + corner badge
 *    EDIT  → amber accent ring + inline column diff
 *    DEL   → red strikethrough + corner badge
 *  `flashing` triggers the same pulse as the graph view so the two views
 *  feel like the same world rendered two ways.
 * ────────────────────────────────────────────────────────────────────────── */

interface Props {
  snapshot: SandboxSnapshot;
  runChanges: Record<string, ChangeRecord>;
  /** Per-table "just touched" record. The App view mirrors the same
   *  flash-then-tint behavior the Graph view uses, so read-only tools
   *  produce a visible pulse on the affected section (rail, events, …)
   *  even though they have no row-level diff. */
  tableActivity?: Record<string, TableActivity>;
  /** Latest step. Used to surface tools that don't bind to any snapshot
   *  table (``get_colors``, ``query_freebusy``, ``get_settings``, …)
   *  as a floating overlay so they're not invisible in the App view. */
  lastStep?: LastStep | null;
}

// (The ``TOOL_HINTS`` / ``ToolSection`` / ``toolHint`` chain used to map
// each MCP tool to a section + label for a small floating overlay; that
// has since been replaced by the richer ``paneOverlay`` slide-in (see
// below) and the per-section ``railActivity`` / ``eventsActivity``
// pulses, which cover the same surface area more directly. The chain
// was tripping ``noUnusedLocals`` and was removed.)

/* ────────────────────────────────────────────────────────────────────────
 *  Side pane overlays — the "agent opens a sub-screen, makes its change,
 *  then closes" effect for tools that don't bind to the calendar grid:
 *  account/settings reads + writes, free/busy lookups, color browsing.
 *  These tools used to surface only as a small toast at the top, which
 *  read like "something happened" without showing WHAT. The pane mimics
 *  the way a human would click into Google's Account / Settings dialog.
 * ──────────────────────────────────────────────────────────────────────── */
type PaneKind = "user" | "settings" | "freebusy" | "colors" | "event" | "calendar" | "acl";
type EventFocus = "location" | "description" | "time" | "title" | "attendees" | "create" | "delete" | "view" | "general";
type CalendarFocus = "color" | "description" | "title" | "visibility" | "create" | "delete" | "view" | "general";

const USER_TOOLS = new Set([
  "get_user", "list_users", "fetch_user",
  "update_user", "update_user_profile", "patch_user", "patch_user_profile",
]);
const SETTINGS_TOOLS = new Set([
  "get_settings", "list_settings", "patch_settings", "update_settings",
  "get_setting", "patch_setting",
]);
const FREEBUSY_TOOLS = new Set(["query_freebusy", "freebusy", "get_freebusy"]);
const COLORS_TOOLS = new Set(["get_colors", "list_colors"]);
const EVENT_TOOLS = new Set([
  "create_event", "insert_event", "patch_event", "update_event",
  "delete_event", "move_event", "copy_event", "import_event",
  "get_event", "list_events", "list_event", "fetch_event",
  "instances_event", "watch_event",
]);
const ATTENDEE_TOOLS = new Set([
  "add_attendee", "remove_attendee", "update_attendee_response",
  "set_attendees", "patch_attendees", "invite_attendee", "decline_attendee",
  "respond_to_event", "rsvp", "update_attendees", "list_attendees",
  "get_attendee",
]);
const CALENDAR_TOOLS = new Set([
  "create_calendar", "insert_calendar", "patch_calendar", "update_calendar",
  "delete_calendar", "clear_calendar",
  "add_calendar_to_list", "remove_calendar_from_list",
  "patch_calendar_list_entry", "update_calendar_list_entry",
  "get_calendar", "list_calendars", "get_calendar_list", "list_calendar_list",
  "fetch_calendar",
]);
const ACL_TOOLS = new Set([
  "insert_acl_rule", "patch_acl_rule", "update_acl_rule", "delete_acl_rule",
  "get_acl_rule", "list_acl_rules", "list_acl", "list_acl_rule",
  "list_acls", "get_acl", "insert_acl", "patch_acl", "delete_acl",
]);

function classifyPane(toolName: string | null | undefined): PaneKind | null {
  if (!toolName) return null;
  if (USER_TOOLS.has(toolName)) return "user";
  if (SETTINGS_TOOLS.has(toolName)) return "settings";
  if (FREEBUSY_TOOLS.has(toolName)) return "freebusy";
  if (COLORS_TOOLS.has(toolName)) return "colors";
  if (ACL_TOOLS.has(toolName)) return "acl";
  if (EVENT_TOOLS.has(toolName) || ATTENDEE_TOOLS.has(toolName)) return "event";
  if (CALENDAR_TOOLS.has(toolName)) return "calendar";
  return null;
}

// Pick the most expressive "sub-screen" for an event-touching tool so the
// pane can render a focused field editor (location, description, time…)
// rather than a generic event card. Falls back to verb-derived focus for
// read tools and creations / deletions.
function detectEventFocus(toolName: string, change: ChangeRecord | null, isAttendee: boolean): EventFocus {
  if (isAttendee) return "attendees";
  const name = (toolName || "").toLowerCase();
  if (name.includes("delete") || name.includes("remove") || name.includes("cancel")) return "delete";
  if (name.includes("create") || name.includes("insert") || name.includes("import")) return "create";
  if (!change) {
    if (name.startsWith("get_") || name.startsWith("list_") || name.startsWith("fetch_")) return "view";
    return "general";
  }
  const cols = new Set(change.cols.map(c => c.toLowerCase()));
  if (cols.has("location")) return "location";
  if (cols.has("description")) return "description";
  if (["start_datetime", "end_datetime", "start_time", "end_time", "start", "end", "recurrence", "duration", "all_day"].some(c => cols.has(c))) return "time";
  if (cols.has("summary") || cols.has("title")) return "title";
  if (cols.has("calendar_id")) return "general"; // move_event
  return "general";
}

function detectCalendarFocus(toolName: string, change: ChangeRecord | null): CalendarFocus {
  const name = (toolName || "").toLowerCase();
  if (name.includes("delete") || name.includes("clear")) return "delete";
  if (name.includes("create") || name.includes("insert") || name.includes("add_calendar_to_list")) return "create";
  if (!change) {
    if (name.startsWith("get_") || name.startsWith("list_") || name.startsWith("fetch_")) return "view";
    return "general";
  }
  const cols = new Set(change.cols.map(c => c.toLowerCase()));
  if (cols.has("color_id") || cols.has("color") || cols.has("background_color") || cols.has("foreground_color")) return "color";
  if (cols.has("description")) return "description";
  if (cols.has("summary") || cols.has("summary_override") || cols.has("title")) return "title";
  if (cols.has("hidden") || cols.has("deleted") || cols.has("selected")) return "visibility";
  return "general";
}

interface PaneOverlay {
  kind: PaneKind;
  // For event/calendar panes, the focused sub-screen so the body knows
  // whether to render a location editor, description editor, etc.
  focus?: EventFocus | CalendarFocus;
  title: string;
  tool: string;
  agent: string;
  isWrite: boolean;
  isError: boolean;
  userRow?: SandboxRow | null;
  eventRow?: SandboxRow | null;
  calendarRow?: SandboxRow | null;
  change?: ChangeRecord | null;
  // Attendees for the focused event (rendered by the attendees focus).
  eventAttendees?: SandboxRow[];
  // For ACL pane: the calendar the rule belongs to + the user it grants.
  aclUserRow?: SandboxRow | null;
  // key derived from the step timestamp so React remounts the pane (and
  // re-runs its slide-in animation) on every new invocation.
  key: string;
}

// Icon shown in the pane header. For event/calendar panes the icon
// reflects the focused sub-screen so the user can tell from the header
// alone which "page" the agent opened.
const PANE_ICONS = {
  user: "👤", settings: "⚙️", freebusy: "🕒", colors: "🎨",
  event: {
    location: "📍", description: "📝", time: "🗓️", title: "✏️",
    attendees: "👥", create: "✨", delete: "🗑️", view: "👁️", general: "🛠️",
  } as Record<EventFocus, string>,
  calendar: {
    color: "🎨", description: "📝", title: "✏️", visibility: "👁️",
    create: "✨", delete: "🗑️", view: "👁️", general: "🛠️",
  } as Record<CalendarFocus, string>,
  acl: "🔗",
} as const;

function paneIcon(pane: PaneOverlay): string {
  if (pane.kind === "event") return PANE_ICONS.event[(pane.focus as EventFocus) || "general"];
  if (pane.kind === "calendar") return PANE_ICONS.calendar[(pane.focus as CalendarFocus) || "general"];
  return PANE_ICONS[pane.kind] as string;
}

// Google Calendar's actual color_id → hex palette. Used for the left
// stripe on event cards and the dots in the "My calendars" rail.
const CAL_COLORS: Record<string, string> = {
  "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73",
  "5": "#f6bf26", "6": "#f4511e", "7": "#039be5", "8": "#616161",
  "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};
const DEFAULT_CAL_COLOR = "#1a73e8";

function calColor(colorId: unknown): string {
  const id = colorId == null ? "" : String(colorId);
  return CAL_COLORS[id] || DEFAULT_CAL_COLOR;
}

function fmtTimeRange(start?: unknown, end?: unknown): string {
  const s = typeof start === "string" ? start : "";
  if (!s) return "—";
  try {
    const sd = new Date(s);
    const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    const sStr = sd.toLocaleTimeString("en-US", opts);
    const e = typeof end === "string" ? end : "";
    if (!e) return sStr;
    const ed = new Date(e);
    return `${sStr} – ${ed.toLocaleTimeString("en-US", opts)}`;
  } catch {
    return s;
  }
}

function dayKey(start?: unknown): string {
  const s = typeof start === "string" ? start : "";
  if (!s) return "unscheduled";
  // Use the ISO date portion to group; preserves the wall-clock day.
  return s.slice(0, 10);
}

function fmtDayHeader(key: string): string {
  if (key === "unscheduled") return "Unscheduled";
  try {
    const d = new Date(`${key}T00:00:00`);
    return d.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return key;
  }
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("");
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  const s = String(v);
  return s.length > 22 ? s.slice(0, 21) + "…" : s;
}

const RESPONSE_STATUS_DOT: Record<string, string> = {
  accepted:    "bg-emerald-500",
  declined:    "bg-red-500",
  tentative:   "bg-amber-500",
  needsAction: "bg-gray-400",
};

/** Summary of one ACL row change, rendered as a small inline chip under the
 *  affected calendar in the rail. Without this the only visible effect of
 *  ``add_calendar_to_list`` / ``insert_acl_rule`` / role changes is the
 *  silent increment of the 👥N counter — easy to miss. */
type AclSummary = {
  kind: "added" | "removed" | "role";
  text: string;
  byAgent?: string;
  flashing: boolean;
};

function aclChangeText(
  op: ChangeRecord["op"],
  values: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  userById: Record<string, SandboxRow>,
): AclSummary | null {
  const uid = String(
    values.user_id ?? after?.user_id ?? before?.user_id ?? "",
  );
  const user = uid ? userById[uid] : undefined;
  const name = String(user?.values.name ?? user?.values.email ?? uid ?? "?");
  const role = String(values.role ?? after?.role ?? before?.role ?? "");
  if (op === "insert") {
    return { kind: "added", text: `+ ${name}${role ? ` · ${role}` : ""}`, flashing: false };
  }
  if (op === "delete") {
    return { kind: "removed", text: `− ${name}`, flashing: false };
  }
  const oldRole = String(before?.role ?? "");
  const newRole = String(after?.role ?? role);
  if (oldRole !== newRole) {
    return { kind: "role", text: `${name}: ${oldRole || "—"} → ${newRole || "—"}`, flashing: false };
  }
  return { kind: "role", text: `${name} (acl edited)`, flashing: false };
}

export function CalendarAppView({ snapshot, runChanges, tableActivity, lastStep }: Props) {
  // Activity routing — derive which section (rail / events / floating) the
  // current step should pulse and what to label its chip.
  const railActivity = tableActivity?.calendars || tableActivity?.acls || null;
  const eventsActivity = tableActivity?.events || tableActivity?.attendees || null;
  // (``stepHint`` used to live here as a fallback overlay label; the
  // floating ``overlay`` below now handles that case directly. Removed
  // because the constant was no longer read.)
  // A floating "what just happened" overlay for steps that don't bind to a
  // section (no-ops, errors). Shows the agent + tool so the user can
  // always tie a visible cue back to a step in the plan. Settings-style
  // reads/writes get a richer slide-in pane instead (see paneOverlay
  // below) and are intentionally excluded here.
  const overlay: {
    icon: string; label: string; tone: "info" | "warn" | "err" | "ok"; agent: string; tool: string | null; key: string;
  } | null = useMemo(() => {
    if (!lastStep) return null;
    if (classifyPane(lastStep.toolName)) return null; // pane will handle it
    const key = `${lastStep.ts}::${lastStep.toolName}`;
    if (lastStep.kind === "noop") {
      return { icon: "✋", label: "agent skipped — no tool call", tone: "warn", agent: lastStep.byAgent, tool: lastStep.toolName, key };
    }
    if (lastStep.kind === "error") {
      return { icon: "✗", label: "tool failed — see chat for details", tone: "err", agent: lastStep.byAgent, tool: lastStep.toolName, key };
    }
    return null;
  }, [lastStep]);

  // Slide-in pane overlay for "agent opens a sub-screen" tools (user /
  // settings / free-busy / colors). The pane auto-closes after a few
  // seconds so the user is returned to the main calendar view, the same
  // way a real human would close a settings dialog when done.
  const [paneOverlay, setPaneOverlay] = useState<PaneOverlay | null>(null);
  const [paneEntered, setPaneEntered] = useState(false); // drives slide-in transition

  // Google-Calendar-style per-calendar visibility toggles. Clicking a
  // chip in the "My calendars" rail flips its visibility in the events
  // list. New calendars created during a run start visible (auto-include
  // by default since their id isn't in the set). Persist nothing — these
  // are ephemeral per session.
  const [hiddenCalIds, setHiddenCalIds] = useState<Set<string>>(new Set());
  // "Solo" mode: only show events from this single calendar. Alt/Shift
  // click sets this; clicking the same calendar again clears it.
  const [soloCalId, setSoloCalId] = useState<string | null>(null);

  const toggleCalendar = (calId: string, ev?: MouseEvent) => {
    if (ev && (ev.altKey || ev.shiftKey)) {
      // Solo: focus on just this calendar. Click again to un-solo.
      setSoloCalId(prev => (prev === calId ? null : calId));
      return;
    }
    setSoloCalId(null);
    setHiddenCalIds(prev => {
      const next = new Set(prev);
      if (next.has(calId)) next.delete(calId);
      else next.add(calId);
      return next;
    });
  };
  const showOnlyCalendar = (calId: string) => setSoloCalId(prev => (prev === calId ? null : calId));
  const showAllCalendars = () => { setHiddenCalIds(new Set()); setSoloCalId(null); };

  /** True if events for this calendar should render in the list. */
  const isCalendarVisible = (calId: string) => {
    if (soloCalId !== null) return calId === soloCalId;
    return !hiddenCalIds.has(calId);
  };

  // When an agent creates a NEW calendar mid-run, automatically un-hide
  // it AND clear any solo focus on a different calendar so the user
  // immediately sees the new calendar appear in the list (and any
  // events scheduled into it). Without this, a soloed-or-hidden
  // calendar could mask the very thing the agent just did.
  useEffect(() => {
    const newCalIds: string[] = [];
    for (const [k, ch] of Object.entries(runChanges)) {
      if (!k.startsWith("calendars::")) continue;
      if (ch.op !== "insert") continue;
      newCalIds.push(k.slice("calendars::".length));
    }
    if (newCalIds.length === 0) return;
    setHiddenCalIds(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const id of newCalIds) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
    setSoloCalId(prev => (prev !== null && !newCalIds.includes(prev) ? null : prev));
  }, [runChanges]);

  useEffect(() => {
    if (!lastStep) return;
    const kind = classifyPane(lastStep.toolName);
    if (!kind) return;
    const toolName = lastStep.toolName ?? "";
    const key = `${lastStep.ts}::${toolName}`;
    const isWrite = lastStep.kind === "write";
    const isError = lastStep.kind === "error";

    // Helper: scan runChanges for the first row whose key starts with one
    // of the given table prefixes and (when possible) was written by the
    // current agent. Lets a tool focus on the entity IT just touched
    // instead of an unrelated row that some earlier agent edited.
    const findChange = (prefixes: string[]): { table: string; id: string; ch: ChangeRecord } | null => {
      for (const [k, ch] of Object.entries(runChanges)) {
        for (const p of prefixes) {
          if (!k.startsWith(p + "::")) continue;
          if (ch.byAgent && lastStep.byAgent && ch.byAgent !== lastStep.byAgent) continue;
          return { table: p, id: k.slice((p + "::").length), ch };
        }
      }
      // Fallback: any-agent match (covers post-flash auto-close edge case
      // and ensures read tools can still point at something concrete).
      for (const [k, ch] of Object.entries(runChanges)) {
        for (const p of prefixes) {
          if (!k.startsWith(p + "::")) continue;
          return { table: p, id: k.slice((p + "::").length), ch };
        }
      }
      return null;
    };

    let pane: PaneOverlay;

    if (kind === "user") {
      let userRow: SandboxRow | null = null;
      let change: ChangeRecord | null = null;
      const hit = findChange(["users"]);
      if (hit) {
        userRow = userById[hit.id] || (hit.ch.after ? { id: hit.id, values: hit.ch.after as Record<string, unknown> } : null);
        change = hit.ch;
      }
      if (!userRow) {
        const primary = calendars.find(c => Number(c.values.is_primary) === 1);
        const uid = primary ? String(primary.values.user_id ?? "") : "";
        userRow = (uid && userById[uid]) || users[0] || null;
      }
      pane = {
        kind, key,
        title: isWrite ? "Updating account" : isError ? "Account read failed" : "Viewing account",
        tool: toolName, agent: lastStep.byAgent, isWrite, isError,
        userRow, change,
      };
    } else if (kind === "settings") {
      const hit = findChange(["settings", "calendar_settings", "user_settings"]);
      pane = {
        kind, key,
        title: isWrite ? "Updating settings" : isError ? "Settings read failed" : "Viewing settings",
        tool: toolName, agent: lastStep.byAgent, isWrite, isError,
        change: hit?.ch ?? null,
      };
    } else if (kind === "freebusy") {
      pane = { kind, key, title: "Checking availability", tool: toolName, agent: lastStep.byAgent, isWrite, isError };
    } else if (kind === "colors") {
      pane = { kind, key, title: "Browsing color palette", tool: toolName, agent: lastStep.byAgent, isWrite, isError };
    } else if (kind === "event") {
      const isAttendee = ATTENDEE_TOOLS.has(toolName);
      let eventRow: SandboxRow | null = null;
      let change: ChangeRecord | null = null;

      if (isAttendee) {
        // Anchor the pane on the event the attendee row belongs to so the
        // user can see WHICH event got the invite / status change.
        const hit = findChange(["attendees"]);
        if (hit) {
          change = hit.ch;
          const eid = String(hit.ch.after?.event_id ?? hit.ch.before?.event_id ?? "");
          eventRow = events.find(e => e.id === eid) || null;
        }
      } else {
        const hit = findChange(["events"]);
        if (hit) {
          change = hit.ch;
          eventRow = events.find(e => e.id === hit.id) ?? (hit.ch.after ? { id: hit.id, values: hit.ch.after as Record<string, unknown> } : null);
        }
      }
      // Read tools (get_event / list_events): point at the most recently
      // changed event when available, otherwise the first event in view.
      if (!eventRow) {
        const hit = findChange(["events"]);
        if (hit) eventRow = events.find(e => e.id === hit.id) || null;
      }
      if (!eventRow) eventRow = events[0] || null;

      const focus = detectEventFocus(toolName, change, isAttendee);
      const titles: Record<EventFocus, string> = {
        location:    isWrite ? "Updating location"   : "Inspecting location",
        description: isWrite ? "Updating description" : "Inspecting description",
        time:        isWrite ? "Rescheduling event"  : "Checking time",
        title:       isWrite ? "Renaming event"      : "Inspecting title",
        attendees:   isWrite ? "Updating attendees"  : "Viewing attendees",
        create:      "Creating event",
        delete:      "Removing event",
        view:        "Viewing event",
        general:     isWrite ? "Editing event" : isError ? "Event tool failed" : "Inspecting event",
      };
      const eventAttendees = eventRow ? (attendeesByEvent[eventRow.id] || []) : [];
      pane = {
        kind, focus, key,
        title: titles[focus],
        tool: toolName, agent: lastStep.byAgent, isWrite, isError,
        eventRow, change, eventAttendees,
      };
    } else if (kind === "calendar") {
      const hit = findChange(["calendars"]);
      const calendarRow: SandboxRow | null = hit
        ? (calendars.find(c => c.id === hit.id) ?? (hit.ch.after ? { id: hit.id, values: hit.ch.after as Record<string, unknown> } : null))
        : (calendars[0] || null);
      const change = hit?.ch ?? null;
      const focus = detectCalendarFocus(toolName, change);
      const titles: Record<CalendarFocus, string> = {
        color:       isWrite ? "Changing calendar color" : "Inspecting color",
        description: isWrite ? "Updating description"    : "Inspecting description",
        title:       isWrite ? "Renaming calendar"       : "Inspecting title",
        visibility:  isWrite ? "Toggling visibility"     : "Inspecting visibility",
        create:      "Creating calendar",
        delete:      "Removing calendar",
        view:        "Viewing calendar",
        general:     isWrite ? "Editing calendar" : isError ? "Calendar tool failed" : "Inspecting calendar",
      };
      pane = {
        kind, focus, key,
        title: titles[focus],
        tool: toolName, agent: lastStep.byAgent, isWrite, isError,
        calendarRow, change,
      };
    } else { // acl
      const hit = findChange(["acls", "acl"]);
      const change = hit?.ch ?? null;
      const calId = String(change?.after?.calendar_id ?? change?.before?.calendar_id ?? "");
      const calendarRow = calendars.find(c => c.id === calId) || null;
      const aclUserId = String(change?.after?.user_id ?? change?.after?.scope_value ?? change?.before?.user_id ?? change?.before?.scope_value ?? "");
      const aclUserRow = aclUserId ? (userById[aclUserId] || null) : null;
      pane = {
        kind, key,
        title: isWrite ? "Updating sharing" : isError ? "Sharing tool failed" : "Viewing sharing",
        tool: toolName, agent: lastStep.byAgent, isWrite, isError,
        calendarRow, change, aclUserRow,
      };
    }

    setPaneOverlay(pane);
    setPaneEntered(false);
    // Next-tick → flip to entered so the CSS transition fires the slide-in.
    const tIn = setTimeout(() => setPaneEntered(true), 20);
    // Auto-close so the user is returned to the calendar view ~1s after
    // the per-row FLASH_MS pulse fades — matches the "human closes the
    // dialog" mental model.
    const tOut = setTimeout(() => setPaneOverlay(prev => (prev?.key === key ? null : prev)), 6000);
    return () => { clearTimeout(tIn); clearTimeout(tOut); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStep?.ts, lastStep?.toolName]);
  // Bucket rows by table and synthesize ghost rows for inserts that are in
  // the diff stream but haven't landed in the snapshot yet (so newly
  // created events appear immediately, not on the next snapshot tick).
  const { users, calendars, events, attendeesByEvent, aclsByCalendar, aclRowsAll } = useMemo(() => {
    const tableRows = (name: string): SandboxRow[] =>
      snapshot.tables.find(t => t.table === name)?.rows ?? [];
    const u = tableRows("users");
    const c = [...tableRows("calendars")];
    const e = [...tableRows("events")];
    const a = [...tableRows("attendees")];
    const acl = tableRows("acls");

    const snapshotKeys = new Set<string>();
    for (const t of snapshot.tables) {
      for (const r of t.rows) snapshotKeys.add(`${t.table}::${r.id}`);
    }
    for (const [key, ch] of Object.entries(runChanges)) {
      if (ch.op !== "insert" || snapshotKeys.has(key)) continue;
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      const tbl = key.slice(0, sep);
      const id = key.slice(sep + 2);
      const row: SandboxRow = { id, values: (ch.after as Record<string, unknown>) || {} };
      if (tbl === "events") e.push(row);
      else if (tbl === "calendars") c.push(row);
      else if (tbl === "attendees") a.push(row);
    }

    const attByEvent: Record<string, SandboxRow[]> = {};
    for (const att of a) {
      const ev = String(att.values.event_id ?? "");
      if (ev) (attByEvent[ev] ||= []).push(att);
    }
    const aclByCal: Record<string, SandboxRow[]> = {};
    for (const ac of acl) {
      const cal = String(ac.values.calendar_id ?? "");
      if (cal) (aclByCal[cal] ||= []).push(ac);
    }
    return { users: u, calendars: c, events: e, attendeesByEvent: attByEvent, aclsByCalendar: aclByCal, aclRowsAll: acl };
  }, [snapshot, runChanges]);

  const calById = useMemo(() => {
    const m: Record<string, SandboxRow> = {};
    for (const c of calendars) m[c.id] = c;
    return m;
  }, [calendars]);

  const userById = useMemo(() => {
    const m: Record<string, SandboxRow> = {};
    for (const u of users) m[u.id] = u;
    return m;
  }, [users]);

  // Group events by date, sorted within each day by start time.
  // Filtered by the Google-Calendar-style visibility toggles in the
  // "My calendars" rail (hiddenCalIds / soloCalId).
  const eventsByDay = useMemo(() => {
    const sorted = [...events]
      .filter(ev => isCalendarVisible(String(ev.values.calendar_id ?? "")))
      .sort((a, b) =>
        String(a.values.start_datetime ?? "").localeCompare(String(b.values.start_datetime ?? ""))
      );
    const grouped: Record<string, SandboxRow[]> = {};
    for (const ev of sorted) {
      const k = dayKey(ev.values.start_datetime);
      (grouped[k] ||= []).push(ev);
    }
    return grouped;
  // ``isCalendarVisible`` closes over hiddenCalIds + soloCalId; including
  // those plus ``events`` covers all reactivity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, hiddenCalIds, soloCalId]);

  // For the rail header "(X / Y visible)" counter and the empty-state
  // copy when everything is filtered out.
  const totalEventCount = events.length;
  const visibleEventCount = useMemo(
    () => Object.values(eventsByDay).reduce((n, arr) => n + arr.length, 0),
    [eventsByDay],
  );

  const sortedDays = useMemo(
    () => Object.keys(eventsByDay).sort((a, b) =>
      a === "unscheduled" ? 1 : b === "unscheduled" ? -1 : a.localeCompare(b)
    ),
    [eventsByDay],
  );

  function changeFor(table: string, id: string): ChangeRecord | null {
    return runChanges[`${table}::${id}`] || null;
  }

  // Per-calendar ACL change summaries (so add_calendar_to_list / sharing /
  // role changes show up as visible chips under the calendar instead of
  // silently bumping the 👥N counter).
  const aclChangesByCalendar = useMemo(() => {
    const out: Record<string, AclSummary[]> = {};
    for (const [key, ch] of Object.entries(runChanges)) {
      if (!key.startsWith("acls::")) continue;
      const aclId = key.slice("acls::".length);
      // Prefer the ``after`` payload for the calendar_id (deletes only have
      // ``before``). Fall back to the current snapshot row if needed.
      const snapAcl = aclRowsAll.find(r => r.id === aclId);
      const values = (ch.after as Record<string, unknown>) || snapAcl?.values || (ch.before as Record<string, unknown>) || {};
      const calId = String(values.calendar_id ?? ch.before?.calendar_id ?? "");
      if (!calId) continue;
      const summary = aclChangeText(ch.op, values, ch.before ?? null, ch.after ?? null, userById);
      if (!summary) continue;
      summary.flashing = ch.flashing;
      summary.byAgent = ch.byAgent;
      (out[calId] ||= []).push(summary);
    }
    return out;
  }, [runChanges, aclRowsAll, userById]);

  // Per-event attendee change counts so an event card can show "+2 invited"
  // / "1 declined" badges when its attendees moved without the event row
  // itself being touched.
  const attendeeChangesByEvent = useMemo(() => {
    const out: Record<string, { added: number; removed: number; updated: number; flashing: boolean }> = {};
    for (const [key, ch] of Object.entries(runChanges)) {
      if (!key.startsWith("attendees::")) continue;
      const values = (ch.after as Record<string, unknown>) || (ch.before as Record<string, unknown>) || {};
      const eventId = String(values.event_id ?? ch.before?.event_id ?? "");
      if (!eventId) continue;
      const bucket = (out[eventId] ||= { added: 0, removed: 0, updated: 0, flashing: false });
      if (ch.op === "insert") bucket.added++;
      else if (ch.op === "delete") bucket.removed++;
      else bucket.updated++;
      if (ch.flashing) bucket.flashing = true;
    }
    return out;
  }, [runChanges]);

  // Total touched-in-this-run counter for the "My calendars" header — matches
  // the per-day "N changed" pill so the rail isn't the only silent header.
  const calChangedCount = useMemo(() => {
    let n = 0;
    for (const cal of calendars) {
      if (changeFor("calendars", cal.id) || (aclChangesByCalendar[cal.id]?.length ?? 0) > 0) n++;
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendars, runChanges, aclChangesByCalendar]);

  return (
    <div className="h-full overflow-hidden flex flex-col bg-white text-sm">
      {/* "My calendars" rail */}
      <div className={`border-b bg-gradient-to-b from-gray-50 to-white px-3 py-2 flex-none transition-all ${railActivity?.flashing ? railActivity.kind === "read" ? "ring-2 ring-blue-200 ring-inset" : railActivity.kind === "error" ? "ring-2 ring-red-200 ring-inset" : "" : ""}`}>
        <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5 flex items-center gap-1.5">
          <span>📚</span><span>My calendars</span>
          <span className="text-gray-400 normal-case font-normal" title="Click a calendar to toggle its events · Alt-click to solo">
            · {calendars.length}{(hiddenCalIds.size > 0 || soloCalId !== null)
              ? ` · showing ${visibleEventCount}/${totalEventCount} events`
              : ""}
          </span>
          {(hiddenCalIds.size > 0 || soloCalId !== null) && (
            <button
              onClick={showAllCalendars}
              className="px-1.5 py-0 rounded bg-white border border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-700 text-[9px] font-medium normal-case tracking-normal"
              title="Show events from all calendars"
            >
              show all
            </button>
          )}
          {/* Section-level read/error pulse — shows which tool just touched
              the calendar rail even when no row changed. */}
          {railActivity && (railActivity.kind === "read" || railActivity.kind === "error") && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0 rounded normal-case tracking-normal text-[9px] font-medium ${
                railActivity.kind === "read"
                  ? "bg-blue-50 border border-blue-200 text-blue-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              } ${railActivity.flashing ? "animate-pulse" : ""}`}
              title={railActivity.byAgent ? `${railActivity.toolName || "read"} by ${railActivity.byAgent}` : undefined}
            >
              <span>{railActivity.kind === "read" ? "🔎" : "✗"}</span>
              <span className="font-mono">{railActivity.toolName || (railActivity.kind === "error" ? "failed" : "read")}</span>
            </span>
          )}
          {calChangedCount > 0 && (
            <span className="ml-auto px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold normal-case tracking-normal">
              {calChangedCount} changed
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-1.5">
          {calendars.length === 0 && (
            <span className="text-[11px] text-gray-400 italic">No calendars yet — agents will add them as they run.</span>
          )}
          {calendars.map(cal => {
            const color = calColor(cal.values.color_id);
            const ch = changeFor("calendars", cal.id);
            const summary = String(cal.values.summary ?? cal.id);
            const owner = userById[String(cal.values.user_id ?? "")];
            const acls = aclsByCalendar[cal.id] || [];
            const aclChanges = aclChangesByCalendar[cal.id] || [];
            const ringCls = ch
              ? ch.op === "insert"  ? "border-emerald-400 ring-2 ring-emerald-200"
              : ch.op === "update"  ? "border-amber-400 ring-2 ring-amber-200"
              :                       "border-red-400 ring-2 ring-red-200"
              : aclChanges.length > 0
              ? "border-amber-300 ring-1 ring-amber-100"
              : "border-gray-200";
            const aclFlashing = aclChanges.some(a => a.flashing);
            const cardFlashing = !!ch?.flashing || aclFlashing;
            const aclBadge = aclChanges.length > 0
              ? `${aclChanges.length} access ${aclChanges.length === 1 ? "change" : "changes"}`
              : null;
            // Visibility / deletion state styling — applies even to
            // unchanged rows so the user can SEE which calendars are
            // hidden or deleted at a glance (a tool that flips ``hidden``
            // 1→0 will visually un-dim the chip the next render).
            const hidden = Number(cal.values.hidden) === 1;
            const softDeleted = Number(cal.values.deleted) === 1;
            const stateCls = `${hidden ? "opacity-60 italic" : ""} ${softDeleted ? "line-through opacity-40" : ""}`.trim();
            // Per-calendar visibility state — drives the checkbox-style
            // swatch and dimming of the chip.
            const isVisible = isCalendarVisible(cal.id);
            const isSolo = soloCalId === cal.id;
            const visibilityCls = isVisible
              ? ""
              : "opacity-55 saturate-50";
            const baseTitle = owner
              ? `${summary} — ${String(owner.values.email ?? owner.id)}${hidden ? " — hidden in DB" : ""}${softDeleted ? " — deleted" : ""}`
              : summary;
            const interactiveTitle = `${baseTitle}\n\nClick to ${isVisible ? "hide" : "show"} this calendar's events${isSolo ? " · currently solo" : ""}\nAlt-click to ${isSolo ? "exit solo" : "show only this calendar"}`;
            // Checkbox-style swatch: filled square if visible, hollow
            // outline if hidden — mirrors Google Calendar's left rail.
            const Swatch = () => (
              <span
                className="w-3 h-3 rounded-sm shrink-0 transition-colors"
                style={{
                  background: isVisible ? color : "transparent",
                  borderStyle: "solid",
                  borderColor: color,
                  borderWidth: isVisible ? 1 : 2,
                }}
              />
            );
            // When nothing changed, fall back to the original compact chip
            // (now a clickable button).
            if (!ch && aclChanges.length === 0) {
              return (
                <button
                  key={cal.id}
                  type="button"
                  onClick={(e) => toggleCalendar(cal.id, e)}
                  onDoubleClick={() => showOnlyCalendar(cal.id)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md border bg-white text-left hover:border-blue-300 hover:bg-blue-50/30 transition-colors ${isSolo ? "border-blue-400 ring-1 ring-blue-200" : "border-gray-200"} ${visibilityCls} ${stateCls}`}
                  title={interactiveTitle}
                >
                  <Swatch />
                  <span className="text-xs font-medium truncate max-w-[160px] text-gray-800">{summary}</span>
                  {cal.values.is_primary ? <span className="text-amber-500 text-[10px] leading-none" title="Primary">★</span> : null}
                  {isSolo && <span className="text-[8.5px] text-blue-700 px-1 py-0 rounded bg-blue-100 font-bold">SOLO</span>}
                  {hidden && <span className="text-[8.5px] text-gray-500 px-1 py-0 rounded bg-gray-100">hidden</span>}
                  {acls.length > 1 && (
                    <span className="text-[9px] text-gray-500 font-mono flex items-center gap-0.5" title={`${acls.length} ACL entries`}>
                      👥<span>{acls.length}</span>
                    </span>
                  )}
                </button>
              );
            }
            return (
              <button
                key={cal.id}
                type="button"
                onClick={(e) => toggleCalendar(cal.id, e)}
                onDoubleClick={() => showOnlyCalendar(cal.id)}
                className={`flex flex-col gap-1 p-1.5 pr-2 rounded-md border bg-white text-left hover:border-blue-300 hover:bg-blue-50/20 ${ringCls} ${cardFlashing ? "animate-pulse" : ""} transition-all max-w-[260px] ${isSolo ? "ring-1 ring-blue-300" : ""} ${visibilityCls} ${stateCls}`}
                title={interactiveTitle}
              >
                <div className="flex items-center gap-1.5">
                  <Swatch />
                  <span className={`text-xs font-medium truncate max-w-[160px] ${ch?.op === "delete" ? "line-through text-red-700" : "text-gray-800"}`}>
                    {summary}
                  </span>
                  {isSolo && <span className="text-[8.5px] text-blue-700 px-1 py-0 rounded bg-blue-100 font-bold shrink-0">SOLO</span>}
                  {cal.values.is_primary ? <span className="text-amber-500 text-[10px] leading-none" title="Primary">★</span> : null}
                  {acls.length > 1 && (
                    <span className="text-[9px] text-gray-500 font-mono flex items-center gap-0.5" title={`${acls.length} ACL entries`}>
                      👥<span>{acls.length}</span>
                    </span>
                  )}
                  {ch && (
                    <span className={`ml-auto px-1 py-0 rounded text-[8.5px] font-bold text-white ${ch.op === "insert" ? "bg-emerald-500" : ch.op === "update" ? "bg-amber-500" : "bg-red-500"}`}>
                      {ch.op === "insert" ? "NEW" : ch.op === "update" ? "EDIT" : "DEL"}
                    </span>
                  )}
                  {!ch && aclBadge && (
                    <span className="ml-auto px-1 py-0 rounded text-[8.5px] font-bold text-white bg-amber-500">SHARED</span>
                  )}
                </div>
                {/* Column-level diff for direct calendar UPDATEs (matches event
                    cards). Surfaces ``location``, ``color_id`` etc. so users
                    can see exactly what patch_calendar did. */}
                {ch?.op === "update" && ch.cols.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {ch.cols.slice(0, 3).map(col => (
                      <span key={col} className="px-1 py-0 rounded bg-amber-50 border border-amber-200 text-[9px] font-mono text-amber-800 inline-flex items-center gap-0.5">
                        <span className="font-semibold">{col}</span>:
                        <span className="line-through text-red-400 max-w-[60px] truncate" title={String(ch.before?.[col] ?? "")}>{fmtVal(ch.before?.[col])}</span>
                        <span className="text-amber-600">→</span>
                        <span className="text-emerald-700 max-w-[60px] truncate" title={String(ch.after?.[col] ?? "")}>{fmtVal(ch.after?.[col])}</span>
                      </span>
                    ))}
                    {ch.cols.length > 3 && <span className="text-[9px] text-amber-700">+{ch.cols.length - 3}</span>}
                  </div>
                )}
                {/* ACL change summaries (e.g. "+ Carol writer", "Bob: reader →
                    writer"). Without these, add_calendar_to_list and
                    insert_acl_rule are invisible to the user. */}
                {aclChanges.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {aclChanges.slice(0, 4).map((a, i) => {
                      const tone =
                        a.kind === "added"   ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                      : a.kind === "removed" ? "bg-red-50 border-red-200 text-red-700"
                      :                        "bg-amber-50 border-amber-200 text-amber-800";
                      return (
                        <span key={i} className={`px-1 py-0 rounded border text-[9px] font-mono inline-flex items-center gap-0.5 ${tone}`} title={a.byAgent ? `by ${a.byAgent}` : undefined}>
                          <span>👥</span>
                          <span className="truncate max-w-[160px]">{a.text}</span>
                        </span>
                      );
                    })}
                    {aclChanges.length > 4 && <span className="text-[9px] text-gray-500">+{aclChanges.length - 4}</span>}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Events list */}
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {/* Section-level events activity chip — pulses on read tools that
            target events/attendees (list_events, query_freebusy, get_event,
            list_attendees, etc.) so every read tool produces a visible
            trail in the App body, not only in the activity ribbon. */}
        {eventsActivity && (eventsActivity.kind === "read" || eventsActivity.kind === "error") && (
          <div className="sticky top-0 z-20 px-3 py-1 border-b bg-white/95 backdrop-blur flex items-center gap-1.5 text-[10px]">
            <span className="uppercase tracking-wide text-gray-500 font-semibold">📌 Events</span>
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0 rounded ${
                eventsActivity.kind === "read"
                  ? "bg-blue-50 border border-blue-200 text-blue-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              } ${eventsActivity.flashing ? "animate-pulse" : ""}`}
              title={eventsActivity.byAgent ? `${eventsActivity.toolName || "read"} by ${eventsActivity.byAgent}` : undefined}
            >
              <span>{eventsActivity.kind === "read" ? "🔎" : "✗"}</span>
              <span className="font-mono">{eventsActivity.toolName || (eventsActivity.kind === "error" ? "failed" : "read")}</span>
            </span>
            {eventsActivity.byAgent && (
              <span className="text-gray-400">· by <span className="font-mono text-gray-600">{eventsActivity.byAgent}</span></span>
            )}
          </div>
        )}
        {/* Slide-in side pane for "agent opens a sub-screen" tools. The
            pane covers the right portion of the body so the calendar
            stays partially visible behind, mirroring the way a person
            would click into Google's Account / Settings / Free-busy
            dialog. Auto-closes after FLASH_MS+1s so the user is returned
            to the main calendar view. */}
        {paneOverlay && (
          <div
            key={paneOverlay.key}
            className="absolute inset-y-0 right-0 z-40 w-[78%] max-w-[340px] pointer-events-auto"
          >
            <div
              className={`h-full w-full bg-white border-l-2 shadow-2xl flex flex-col transition-all duration-300 ease-out ${
                paneOverlay.isError ? "border-red-300" : paneOverlay.isWrite ? "border-emerald-300" : "border-blue-300"
              } ${paneEntered ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"}`}
            >
              <div className={`px-3 py-2 border-b flex items-center gap-2 ${paneOverlay.isError ? "bg-red-50" : paneOverlay.isWrite ? "bg-emerald-50" : "bg-blue-50"}`}>
                <span className="text-lg leading-none">{paneIcon(paneOverlay)}</span>
                <span className={`text-xs font-semibold ${paneOverlay.isError ? "text-red-800" : paneOverlay.isWrite ? "text-emerald-800" : "text-blue-800"}`}>
                  {paneOverlay.title}
                </span>
                <span className="ml-auto text-[10px] font-mono text-gray-500 truncate max-w-[120px]" title={paneOverlay.tool}>{paneOverlay.tool}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {paneOverlay.kind === "user" && (
                  <UserPaneBody row={paneOverlay.userRow ?? null} change={paneOverlay.change ?? null} isWrite={paneOverlay.isWrite} />
                )}
                {paneOverlay.kind === "settings" && (
                  <SettingsPaneBody change={paneOverlay.change ?? null} isWrite={paneOverlay.isWrite} />
                )}
                {paneOverlay.kind === "freebusy" && <FreeBusyPaneBody />}
                {paneOverlay.kind === "colors" && <ColorsPaneBody />}
                {paneOverlay.kind === "event" && (
                  <EventPaneBody
                    focus={(paneOverlay.focus as EventFocus) || "general"}
                    eventRow={paneOverlay.eventRow ?? null}
                    change={paneOverlay.change ?? null}
                    attendees={paneOverlay.eventAttendees || []}
                    calendarColor={paneOverlay.eventRow ? calColor(calById[String(paneOverlay.eventRow.values.calendar_id ?? "")]?.values?.color_id) : DEFAULT_CAL_COLOR}
                    calendarName={paneOverlay.eventRow ? String(calById[String(paneOverlay.eventRow.values.calendar_id ?? "")]?.values?.summary ?? "") : ""}
                    userById={userById}
                    isWrite={paneOverlay.isWrite}
                    isError={paneOverlay.isError}
                  />
                )}
                {paneOverlay.kind === "calendar" && (
                  <CalendarPaneBody
                    focus={(paneOverlay.focus as CalendarFocus) || "general"}
                    row={paneOverlay.calendarRow ?? null}
                    change={paneOverlay.change ?? null}
                    isWrite={paneOverlay.isWrite}
                    isError={paneOverlay.isError}
                  />
                )}
                {paneOverlay.kind === "acl" && (
                  <AclPaneBody
                    calendarRow={paneOverlay.calendarRow ?? null}
                    aclUser={paneOverlay.aclUserRow ?? null}
                    change={paneOverlay.change ?? null}
                    isWrite={paneOverlay.isWrite}
                  />
                )}
              </div>
              <div className="px-3 py-1 border-t bg-gray-50 text-[10px] text-gray-500 flex items-center gap-1 flex-none">
                <span>by</span>
                <span className="font-mono text-gray-700 truncate max-w-[160px]" title={paneOverlay.agent}>{paneOverlay.agent}</span>
                <span className="ml-auto opacity-60">auto-closing…</span>
              </div>
            </div>
          </div>
        )}
        {/* Floating toast for steps that don't merit a full pane but still
            need surfacing (no-ops, errors with no entity binding). */}
        {overlay && (
          <div
            key={overlay.key}
            className={`absolute top-2 left-1/2 -translate-x-1/2 z-30 inline-flex items-center gap-1.5 px-2 py-1 rounded-md shadow-sm border text-[10px] font-medium animate-[fadeIn_0.3s_ease-out] ${
              overlay.tone === "warn" ? "bg-amber-50 border-amber-300 text-amber-800"
            : overlay.tone === "err"  ? "bg-red-50 border-red-300 text-red-800"
            : overlay.tone === "ok"   ? "bg-emerald-50 border-emerald-300 text-emerald-800"
            :                            "bg-blue-50 border-blue-300 text-blue-800"}`}
          >
            <span className="text-sm leading-none">{overlay.icon}</span>
            <span>{overlay.label}</span>
            {overlay.tool && <span className="opacity-70">·</span>}
            {overlay.tool && <span className="font-mono opacity-80">{overlay.tool}</span>}
            <span className="opacity-50">·</span>
            <span className="font-mono opacity-80">{overlay.agent}</span>
          </div>
        )}
        <div className="p-3 space-y-3">
        {sortedDays.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <div className="text-5xl mb-2">🗓</div>
            {totalEventCount > 0 ? (
              <>
                <div className="text-xs">All events hidden by your calendar filter.</div>
                <div className="text-[10px] mt-1 max-w-[260px]">
                  {soloCalId !== null
                    ? "Currently soloed on a calendar with no events. "
                    : `${totalEventCount} event${totalEventCount === 1 ? "" : "s"} are hidden across ${hiddenCalIds.size} calendar${hiddenCalIds.size === 1 ? "" : "s"}. `}
                  <button onClick={showAllCalendars} className="text-blue-600 hover:underline">Show all calendars</button>.
                </div>
              </>
            ) : (
              <>
                <div className="text-xs">No events scheduled.</div>
                <div className="text-[10px] mt-1 max-w-[220px]">Run the plan to populate the calendar — new events will animate in as agents call <span className="font-mono">create_event</span>.</div>
              </>
            )}
          </div>
        ) : sortedDays.map(day => {
          const dayEvents = eventsByDay[day];
          const dayChangeCount = dayEvents.filter(ev => changeFor("events", ev.id)).length;
          return (
            <div key={day}>
              <div className="text-[10px] uppercase tracking-wide text-gray-600 font-semibold mb-1.5 sticky top-0 bg-white py-0.5 z-10 flex items-center gap-1.5 border-b border-gray-100">
                <span>{fmtDayHeader(day)}</span>
                <span className="text-gray-400 normal-case font-normal">· {dayEvents.length} event{dayEvents.length === 1 ? "" : "s"}</span>
                {dayChangeCount > 0 && (
                  <span className="ml-auto px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold">
                    {dayChangeCount} changed
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                {dayEvents.map(ev => {
                  const ch = changeFor("events", ev.id);
                  const cal = calById[String(ev.values.calendar_id ?? "")];
                  const stripe = calColor(cal?.values.color_id);
                  const summary = String(ev.values.summary ?? ev.id);
                  const time = fmtTimeRange(ev.values.start_datetime, ev.values.end_datetime);
                  const loc = String(ev.values.location ?? "");
                  const att = attendeesByEvent[ev.id] || [];

                  const ringCls = ch?.flashing
                    ? ch.op === "insert" ? "ring-2 ring-emerald-300 animate-pulse"
                    : ch.op === "update" ? "ring-2 ring-amber-300 animate-pulse"
                    :                       "ring-2 ring-red-300 animate-pulse"
                    : ch
                    ? ch.op === "insert" ? "ring-1 ring-emerald-200"
                    : ch.op === "update" ? "ring-1 ring-amber-200"
                    :                       "ring-1 ring-red-200"
                    : "";

                  const cancelled = String(ev.values.status ?? "").toLowerCase() === "cancelled";
                  const eventStateCls = cancelled ? "opacity-50 line-through decoration-red-400" : "";
                  return (
                    <div
                      key={ev.id}
                      className={`relative pl-3 pr-2 py-1.5 rounded-md bg-white border border-gray-200 hover:shadow-sm transition-all ${ringCls} ${ch?.op === "delete" ? "opacity-70" : ""} ${eventStateCls}`}
                      style={{ borderLeft: `4px solid ${stripe}` }}
                      title={cancelled ? "cancelled" : undefined}
                    >
                      {ch && (
                        <span className={`absolute -top-1.5 -right-1.5 px-1.5 py-0.5 rounded text-[8.5px] font-bold text-white shadow-sm ${ch.op === "insert" ? "bg-emerald-500" : ch.op === "update" ? "bg-amber-500" : "bg-red-500"} ${ch.flashing ? "animate-pulse" : ""}`}>
                          {ch.op === "insert" ? "NEW" : ch.op === "update" ? "EDIT" : "DEL"}
                        </span>
                      )}
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[10px] font-mono text-gray-500 shrink-0">{time}</span>
                        <span className={`text-[12px] font-medium truncate ${ch?.op === "delete" ? "line-through text-red-700" : "text-gray-900"}`} title={summary}>
                          {summary}
                        </span>
                      </div>
                      {ch?.op === "update" && ch.cols.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {ch.cols.slice(0, 4).map(col => (
                            <span key={col} className="px-1 py-0 rounded bg-amber-50 border border-amber-200 text-[9px] font-mono text-amber-800 inline-flex items-center gap-0.5">
                              <span className="font-semibold">{col}</span>:
                              <span className="line-through text-red-400 max-w-[70px] truncate" title={String(ch.before?.[col] ?? "")}>{fmtVal(ch.before?.[col])}</span>
                              <span className="text-amber-600">→</span>
                              <span className="text-emerald-700 max-w-[70px] truncate" title={String(ch.after?.[col] ?? "")}>{fmtVal(ch.after?.[col])}</span>
                            </span>
                          ))}
                          {ch.cols.length > 4 && <span className="text-[9px] text-amber-700">+{ch.cols.length - 4} more</span>}
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
                        {cal && (
                          <span className="flex items-center gap-1 truncate">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: stripe }} />
                            <span className="truncate max-w-[140px]">{String(cal.values.summary ?? cal.id)}</span>
                          </span>
                        )}
                        {loc && loc !== "None" && loc !== "null" && (
                          <span className="truncate flex items-center gap-1">
                            <span>📍</span>
                            <span className="truncate max-w-[120px]" title={loc}>{loc}</span>
                          </span>
                        )}
                        {att.length > 0 && (
                          <span className="flex items-center gap-0.5 ml-auto shrink-0">
                            {att.slice(0, 3).map((a, i) => {
                              const name = String(a.values.displayName ?? a.values.email ?? a.id);
                              const status = String(a.values.responseStatus ?? "needsAction");
                              const dot = RESPONSE_STATUS_DOT[status] || RESPONSE_STATUS_DOT.needsAction;
                              const attCh = changeFor("attendees", a.id);
                              const ringPulse = attCh?.flashing
                                ? attCh.op === "insert" ? "ring-2 ring-emerald-300 animate-pulse"
                                : attCh.op === "update" ? "ring-2 ring-amber-300 animate-pulse"
                                :                          "ring-2 ring-red-300 animate-pulse"
                                : "";
                              const badgeBg = attCh
                                ? attCh.op === "insert" ? "bg-emerald-500"
                                : attCh.op === "update" ? "bg-amber-500"
                                :                          "bg-red-500"
                                : "";
                              const oldStatus = attCh?.op === "update" ? String(attCh.before?.responseStatus ?? "") : "";
                              const tooltip = attCh?.op === "update" && oldStatus && oldStatus !== status
                                ? `${name} — ${oldStatus} → ${status}`
                                : `${name} — ${status}`;
                              return (
                                <span
                                  key={i}
                                  className={`relative w-5 h-5 rounded-full text-[9px] font-semibold text-white flex items-center justify-center bg-gradient-to-br from-slate-500 to-slate-700 ${ringPulse}`}
                                  title={tooltip}
                                >
                                  {initials(name) || "?"}
                                  <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-white ${dot}`} />
                                  {attCh && (
                                    <span className={`absolute -top-1 -right-1 px-0.5 rounded text-[7px] font-bold text-white ring-1 ring-white ${badgeBg}`}>
                                      {attCh.op === "insert" ? "+" : attCh.op === "delete" ? "×" : "✎"}
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                            {att.length > 3 && <span className="text-[9px] text-gray-500 ml-0.5">+{att.length - 3}</span>}
                          </span>
                        )}
                      </div>
                      {/* Aggregate attendee-change badge so changes to
                          attendees of an unchanged event are still obvious
                          (e.g. a newly invited attendee on a pre-existing
                          event, or a status flip to declined). */}
                      {(() => {
                        const aCh = attendeeChangesByEvent[ev.id];
                        if (!aCh) return null;
                        const parts: string[] = [];
                        if (aCh.added) parts.push(`+${aCh.added} invited`);
                        if (aCh.removed) parts.push(`−${aCh.removed} removed`);
                        if (aCh.updated) parts.push(`${aCh.updated} RSVP${aCh.updated === 1 ? "" : "s"} changed`);
                        if (parts.length === 0) return null;
                        return (
                          <div className={`mt-1 inline-flex items-center gap-1 px-1.5 py-0 rounded bg-blue-50 border border-blue-200 text-[9px] font-medium text-blue-700 ${aCh.flashing ? "animate-pulse" : ""}`}>
                            <span>👥</span><span>{parts.join(" · ")}</span>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

/* ── Pane body components ─────────────────────────────────────────────── */

function UserPaneBody({ row, change, isWrite }: {
  row: SandboxRow | null; change: ChangeRecord | null; isWrite: boolean;
}) {
  if (!row) {
    return <div className="text-[11px] text-gray-500 italic">No user record available.</div>;
  }
  const name = String(row.values.name ?? row.values.email ?? row.id);
  const email = String(row.values.email ?? "");
  const tz = String(row.values.timezone ?? "");
  // Identify fields the agent changed in this step so they can be styled
  // with the standard EDIT diff treatment.
  const changedCols = new Set<string>(change?.cols ?? []);
  const before = (change?.before ?? null) as Record<string, unknown> | null;
  const after = (change?.after ?? null) as Record<string, unknown> | null;
  const initial = initials(name);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-14 h-14 rounded-full bg-gradient-to-br from-slate-500 to-slate-700 text-white flex items-center justify-center text-base font-semibold shadow-sm">
          {initial || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900 truncate">{name}</div>
          {email && <div className="text-[11px] text-gray-500 font-mono truncate">{email}</div>}
        </div>
        {change && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${change.op === "insert" ? "bg-emerald-500" : change.op === "update" ? "bg-amber-500" : "bg-red-500"}`}>
            {change.op === "insert" ? "NEW" : change.op === "update" ? "EDIT" : "DEL"}
          </span>
        )}
      </div>
      <div className="border rounded-md bg-gray-50">
        <PaneField label="Account ID" value={row.id} changed={false} mono />
        <PaneField label="Email" value={email} changed={changedCols.has("email")} before={String(before?.email ?? "")} after={String(after?.email ?? "")} mono />
        <PaneField label="Name" value={name} changed={changedCols.has("name")} before={String(before?.name ?? "")} after={String(after?.name ?? "")} />
        <PaneField label="Timezone" value={tz} changed={changedCols.has("timezone")} before={String(before?.timezone ?? "")} after={String(after?.timezone ?? "")} mono />
        {/* Render any other changed columns we don't have a dedicated row for */}
        {Array.from(changedCols).filter(c => !["email", "name", "timezone"].includes(c)).map(col => (
          <PaneField key={col} label={col} value={String(after?.[col] ?? "")} changed before={String(before?.[col] ?? "")} after={String(after?.[col] ?? "")} mono />
        ))}
      </div>
      <div className="text-[10px] text-gray-500 italic">
        {isWrite ? "Agent saved these changes." : "Agent read the account record."}
      </div>
    </div>
  );
}

function SettingsPaneBody({ change, isWrite }: { change: ChangeRecord | null; isWrite: boolean }) {
  const before = (change?.before ?? null) as Record<string, unknown> | null;
  const after = (change?.after ?? null) as Record<string, unknown> | null;
  const cols = change?.cols ?? [];
  const allKeys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-700">
        {change ? (
          isWrite
            ? <>The agent updated <span className="font-semibold">{cols.length || allKeys.size}</span> setting{cols.length === 1 ? "" : "s"}.</>
            : "The agent read the settings record."
        ) : "The agent inspected settings — no change committed."}
      </div>
      <div className="border rounded-md bg-gray-50">
        {Array.from(allKeys).slice(0, 8).map(k => (
          <PaneField
            key={k}
            label={k}
            value={String(after?.[k] ?? "")}
            changed={cols.includes(k)}
            before={String(before?.[k] ?? "")}
            after={String(after?.[k] ?? "")}
            mono
          />
        ))}
        {allKeys.size === 0 && (
          <div className="px-2 py-3 text-[11px] text-gray-400 italic">No setting payload returned.</div>
        )}
      </div>
    </div>
  );
}

function FreeBusyPaneBody() {
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-700">
        Agent is checking calendar availability — the same way you'd open Google Calendar's "Find a time" panel.
      </div>
      <div className="border rounded-md bg-gray-50 p-3 space-y-2">
        {/* A small visual mock — three time slots animating to convey "scanning". */}
        {["09:00 – 11:00", "11:00 – 13:00", "13:00 – 15:00"].map((slot, i) => (
          <div key={slot} className="flex items-center gap-2 text-[11px]">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />
            <span className="font-mono text-gray-700">{slot}</span>
            <span className="ml-auto text-[10px] text-gray-400">checking…</span>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-gray-500 italic">Results are returned to the next agent in the plan.</div>
    </div>
  );
}

function ColorsPaneBody() {
  const swatches: Array<[string, string]> = [
    ["1", "Lavender"], ["2", "Sage"], ["3", "Grape"], ["4", "Flamingo"],
    ["5", "Banana"],  ["6", "Tangerine"], ["7", "Peacock"], ["8", "Graphite"],
    ["9", "Blueberry"], ["10", "Basil"], ["11", "Tomato"],
  ];
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-700">
        Agent is browsing the available calendar color palette.
      </div>
      <div className="grid grid-cols-4 gap-2">
        {swatches.map(([id, label], i) => (
          <div key={id} className="flex flex-col items-center gap-1">
            <span
              className="w-10 h-10 rounded-md shadow-sm border border-black/5 animate-[fadeIn_0.3s_ease-out]"
              style={{ background: CAL_COLORS[id], animationDelay: `${i * 30}ms` }}
              title={`${label} (color_id=${id})`}
            />
            <span className="text-[9px] text-gray-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Event editor pane ─────────────────────────────────────────────────
 * Renders ONE focused sub-screen per call (location / description / time
 * / title / attendees / create / delete / view / general) so the user
 * literally sees the agent open the right page in the event editor,
 * apply its change, then close. We pick the page from the columns the
 * agent wrote — see detectEventFocus() above.
 * ──────────────────────────────────────────────────────────────────── */
function EventPaneBody(props: {
  focus: EventFocus;
  eventRow: SandboxRow | null;
  change: ChangeRecord | null;
  attendees: SandboxRow[];
  calendarColor: string;
  calendarName: string;
  userById: Record<string, SandboxRow>;
  isWrite: boolean;
  isError: boolean;
}) {
  const { focus, eventRow, change, attendees, calendarColor, calendarName, userById, isWrite, isError } = props;
  if (!eventRow) {
    return <div className="text-[11px] text-gray-500 italic">No event in scope.</div>;
  }
  const before = (change?.before ?? null) as Record<string, unknown> | null;
  const after  = (change?.after  ?? null) as Record<string, unknown> | null;
  const summary = String(eventRow.values.summary ?? eventRow.id);
  const day = String(eventRow.values.start_datetime ?? "").slice(0, 10);
  const time = fmtTimeRange(eventRow.values.start_datetime, eventRow.values.end_datetime);

  // Persistent breadcrumb so the user can always tie the pane back to a
  // specific event in the calendar grid behind it.
  const breadcrumb = (
    <div className="flex items-center gap-2 text-[11px] border-b pb-2 mb-2">
      <span className="w-1 h-6 rounded-sm shrink-0" style={{ background: calendarColor }} />
      <div className="min-w-0 flex-1">
        <div className="text-gray-900 font-medium truncate">{summary}</div>
        <div className="text-gray-500 text-[10px] truncate font-mono">
          {calendarName ? `${calendarName} · ` : ""}{day || "—"} {time !== "—" ? `· ${time}` : ""}
        </div>
      </div>
    </div>
  );

  if (focus === "location") {
    const beforeLoc = String(before?.location ?? eventRow.values.location ?? "");
    const afterLoc  = String(after?.location  ?? eventRow.values.location ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Location</div>
        {/* Map placeholder — purely visual, mimics Google Calendar's map
            preview when you type a venue name. */}
        <div className="relative h-24 rounded-md border bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center overflow-hidden">
          <div className="absolute inset-0 opacity-30" style={{ backgroundImage: "linear-gradient(0deg,transparent 49%,rgba(0,0,0,0.06) 50%,transparent 51%),linear-gradient(90deg,transparent 49%,rgba(0,0,0,0.06) 50%,transparent 51%)", backgroundSize: "16px 16px" }} />
          <span className="text-3xl drop-shadow-sm relative z-10 animate-bounce" style={{ animationDuration: "1.5s" }}>📍</span>
        </div>
        <div className="space-y-1">
          {isWrite && beforeLoc !== afterLoc ? (
            <>
              <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-[11px] text-red-700 line-through truncate" title={beforeLoc}>{beforeLoc || "∅"}</div>
              <div className="text-amber-600 text-center text-[10px]">↓</div>
              <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-[11px] text-emerald-800 font-medium truncate" title={afterLoc}>{afterLoc || "∅"}</div>
            </>
          ) : (
            <div className="px-2 py-1.5 rounded border bg-gray-50 text-[11px] text-gray-800 truncate" title={afterLoc}>{afterLoc || <span className="italic text-gray-400">No location set</span>}</div>
          )}
        </div>
        <div className="text-[10px] text-gray-500 italic">
          {isWrite ? "Agent saved the new venue." : isError ? "The location tool failed — see chat for details." : "Agent read the event's venue."}
        </div>
      </div>
    );
  }

  if (focus === "description") {
    const beforeDesc = String(before?.description ?? eventRow.values.description ?? "");
    const afterDesc  = String(after?.description  ?? eventRow.values.description ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Description</div>
        {isWrite && beforeDesc !== afterDesc ? (
          <div className="space-y-2">
            <div className="text-[10px] text-red-600 font-medium">— before</div>
            <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-[11px] text-red-700 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {beforeDesc || <span className="italic text-red-400">∅</span>}
            </div>
            <div className="text-[10px] text-emerald-700 font-medium">+ after</div>
            <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-[11px] text-emerald-900 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {afterDesc || <span className="italic text-emerald-500">∅</span>}
            </div>
          </div>
        ) : (
          <div className="px-2 py-2 rounded border bg-gray-50 text-[11px] text-gray-800 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {afterDesc || <span className="italic text-gray-400">No description.</span>}
          </div>
        )}
      </div>
    );
  }

  if (focus === "time") {
    const beforeStart = String(before?.start_datetime ?? "");
    const beforeEnd   = String(before?.end_datetime ?? "");
    const afterStart  = String(after?.start_datetime ?? eventRow.values.start_datetime ?? "");
    const afterEnd    = String(after?.end_datetime   ?? eventRow.values.end_datetime ?? "");
    const fmt = (dt: string) => {
      if (!dt) return "—";
      try { return new Date(dt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); } catch { return dt; }
    };
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">When</div>
        {isWrite && beforeStart ? (
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded border bg-red-50 border-red-200 p-2">
              <div className="text-[9px] uppercase text-red-600 font-semibold mb-1">Old</div>
              <div className="font-mono text-red-700 line-through">{fmt(beforeStart)}</div>
              <div className="font-mono text-red-700 line-through">→ {fmt(beforeEnd)}</div>
            </div>
            <div className="rounded border bg-emerald-50 border-emerald-300 p-2">
              <div className="text-[9px] uppercase text-emerald-700 font-semibold mb-1">New</div>
              <div className="font-mono text-emerald-800">{fmt(afterStart)}</div>
              <div className="font-mono text-emerald-800">→ {fmt(afterEnd)}</div>
            </div>
          </div>
        ) : (
          <div className="rounded border bg-gray-50 p-2 text-[11px] font-mono text-gray-800 space-y-0.5">
            <div>Start: {fmt(afterStart)}</div>
            <div>End:&nbsp;&nbsp; {fmt(afterEnd)}</div>
          </div>
        )}
      </div>
    );
  }

  if (focus === "title") {
    const beforeTitle = String(before?.summary ?? "");
    const afterTitle  = String(after?.summary  ?? eventRow.values.summary ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Event title</div>
        {isWrite && beforeTitle !== afterTitle ? (
          <div className="space-y-1">
            <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-sm text-red-700 line-through truncate" title={beforeTitle}>{beforeTitle || "∅"}</div>
            <div className="text-amber-600 text-center text-[10px]">↓</div>
            <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-sm text-emerald-900 font-semibold truncate" title={afterTitle}>{afterTitle || "∅"}</div>
          </div>
        ) : (
          <div className="px-2 py-1.5 rounded border bg-gray-50 text-sm text-gray-900 font-medium truncate" title={afterTitle}>{afterTitle || <span className="italic text-gray-400 font-normal">No title.</span>}</div>
        )}
      </div>
    );
  }

  if (focus === "attendees") {
    // Synthesize "added" / "removed" / "status" buckets from the change
    // record (when present) plus the snapshot's current attendee list.
    const added: SandboxRow[] = [];
    const removed: SandboxRow[] = [];
    const statusChanged: Array<{ row: SandboxRow; from: string; to: string }> = [];
    if (change) {
      if (change.op === "insert" && change.after) {
        added.push({ id: String(change.after.attendee_id ?? change.after.email ?? "new"), values: change.after as Record<string, unknown> });
      } else if (change.op === "delete" && change.before) {
        removed.push({ id: String(change.before.attendee_id ?? change.before.email ?? "old"), values: change.before as Record<string, unknown> });
      } else if (change.op === "update" && change.after) {
        statusChanged.push({
          row: { id: String(change.after.attendee_id ?? change.after.email ?? "att"), values: change.after as Record<string, unknown> },
          from: String(change.before?.response_status ?? change.before?.status ?? ""),
          to:   String(change.after?.response_status  ?? change.after?.status  ?? ""),
        });
      }
    }
    const isAddedId = new Set(added.map(a => a.id));
    const isRemovedId = new Set(removed.map(a => a.id));
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500 flex items-center gap-2">
          <span>Attendees</span>
          <span className="text-gray-400 normal-case">· {attendees.length}</span>
          {added.length > 0   && <span className="ml-auto px-1.5 py-0 rounded bg-emerald-100 text-emerald-700 text-[9px] font-bold">+{added.length} invited</span>}
          {removed.length > 0 && <span className="px-1.5 py-0 rounded bg-red-100 text-red-700 text-[9px] font-bold">−{removed.length} removed</span>}
        </div>
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {[...attendees, ...added.filter(a => !attendees.some(x => x.id === a.id)), ...removed].map((a, i) => {
            const isAdded = isAddedId.has(a.id);
            const isRemoved = isRemovedId.has(a.id);
            const sc = statusChanged.find(s => s.row.id === a.id);
            const email = String(a.values.email ?? a.id);
            const uid = String(a.values.user_id ?? "");
            const u = userById[uid];
            const name = u ? String(u.values.name ?? email) : email;
            const status = String(a.values.response_status ?? a.values.status ?? "needsAction");
            const statusTone = status === "accepted" ? "bg-emerald-500" : status === "declined" ? "bg-red-500" : status === "tentative" ? "bg-amber-500" : "bg-gray-400";
            return (
              <div
                key={`${a.id}-${i}`}
                className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[11px] ${
                  isAdded ? "bg-emerald-50 border-emerald-300" :
                  isRemoved ? "bg-red-50 border-red-300 line-through opacity-70" :
                  sc ? "bg-amber-50 border-amber-300" :
                  "bg-white border-gray-200"
                }`}
              >
                <span className="w-6 h-6 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 text-white flex items-center justify-center text-[10px] font-semibold shrink-0">
                  {initials(name) || "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-gray-900 truncate">{name}</div>
                  {name !== email && <div className="text-[10px] text-gray-500 font-mono truncate">{email}</div>}
                </div>
                <span className={`w-2 h-2 rounded-full shrink-0 ${statusTone}`} title={status} />
                {sc && (
                  <span className="text-[9px] font-mono text-amber-700">{sc.from || "?"}→{sc.to || "?"}</span>
                )}
                {isAdded && <span className="px-1 py-0 rounded text-[8.5px] font-bold text-white bg-emerald-500">NEW</span>}
                {isRemoved && <span className="px-1 py-0 rounded text-[8.5px] font-bold text-white bg-red-500">OUT</span>}
              </div>
            );
          })}
          {attendees.length === 0 && added.length === 0 && removed.length === 0 && (
            <div className="text-[11px] text-gray-400 italic px-2">No attendees on this event.</div>
          )}
        </div>
      </div>
    );
  }

  if (focus === "create") {
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">New event</div>
        <div className="rounded border-2 border-emerald-300 bg-emerald-50 p-2 text-[11px] space-y-1">
          <div className="text-sm font-semibold text-gray-900 truncate">{summary}</div>
          <div className="font-mono text-gray-700">{day || "—"}{time !== "—" ? ` · ${time}` : ""}</div>
          {String(eventRow.values.location ?? "") && (
            <div className="text-gray-700">📍 {String(eventRow.values.location)}</div>
          )}
          {String(eventRow.values.description ?? "") && (
            <div className="text-gray-700 line-clamp-3">{String(eventRow.values.description)}</div>
          )}
        </div>
        <div className="text-[10px] text-emerald-700 italic">Agent committed this new event to the calendar.</div>
      </div>
    );
  }

  if (focus === "delete") {
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-red-700 font-semibold">Removing event</div>
        <div className="rounded border border-red-300 bg-red-50 p-2 text-[11px] space-y-1">
          <div className="text-sm font-semibold text-red-700 line-through truncate">{summary}</div>
          <div className="font-mono text-red-600 line-through">{day || "—"}{time !== "—" ? ` · ${time}` : ""}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded bg-red-100 text-red-700 text-[10px] font-semibold">🗑 Cancelled</span>
        </div>
      </div>
    );
  }

  // view / general — show a compact event detail card
  const cols = (change?.cols ?? []).map(c => c.toLowerCase());
  return (
    <div className="space-y-3">
      {breadcrumb}
      <div className="rounded border bg-gray-50 p-2 text-[11px] space-y-1">
        <div className="font-mono text-gray-700">{day || "—"}{time !== "—" ? ` · ${time}` : ""}</div>
        {String(eventRow.values.location ?? "") && <div className="text-gray-700">📍 {String(eventRow.values.location)}</div>}
        {String(eventRow.values.status ?? "") && <div className="text-gray-500">status: <span className="font-mono">{String(eventRow.values.status)}</span></div>}
        {attendees.length > 0 && <div className="text-gray-700">👥 {attendees.length} attendee{attendees.length === 1 ? "" : "s"}</div>}
      </div>
      {cols.length > 0 && (
        <div className="border rounded-md bg-gray-50">
          {cols.map(col => (
            <PaneField key={col} label={col} value={String(after?.[col] ?? "")} changed before={String(before?.[col] ?? "")} after={String(after?.[col] ?? "")} mono />
          ))}
        </div>
      )}
      <div className="text-[10px] text-gray-500 italic">
        {isWrite ? "Agent saved these event changes." : isError ? "Tool failed — see chat for details." : "Agent inspected this event."}
      </div>
    </div>
  );
}

/* ── Calendar editor pane ──────────────────────────────────────────────
 * Same idea as EventPaneBody but for calendar-level tools (color,
 * description, title, visibility, create, delete, view).
 * ──────────────────────────────────────────────────────────────────── */
function CalendarPaneBody({ focus, row, change, isWrite, isError }: {
  focus: CalendarFocus;
  row: SandboxRow | null;
  change: ChangeRecord | null;
  isWrite: boolean;
  isError: boolean;
}) {
  if (!row) return <div className="text-[11px] text-gray-500 italic">No calendar in scope.</div>;
  const before = (change?.before ?? null) as Record<string, unknown> | null;
  const after  = (change?.after  ?? null) as Record<string, unknown> | null;
  const summary = String(row.values.summary ?? row.id);
  const color = calColor(row.values.color_id);
  const hidden = Number(row.values.hidden) === 1;
  const breadcrumb = (
    <div className="flex items-center gap-2 text-[11px] border-b pb-2 mb-2">
      <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
      <div className="min-w-0 flex-1">
        <div className="text-gray-900 font-medium truncate">{summary}</div>
        <div className="text-gray-500 text-[10px] font-mono truncate">calendar_id: {row.id}</div>
      </div>
      {hidden && <span className="px-1 py-0 rounded bg-gray-100 text-gray-600 text-[9px]">hidden</span>}
    </div>
  );

  if (focus === "color") {
    const beforeColor = calColor(before?.color_id);
    const afterColor = calColor(after?.color_id ?? row.values.color_id);
    const palette = ["1","2","3","4","5","6","7","8","9","10","11"];
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Color</div>
        {isWrite && beforeColor !== afterColor ? (
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-center gap-1">
              <span className="w-12 h-12 rounded-md border-2 border-red-300 shadow-sm" style={{ background: beforeColor }} />
              <span className="text-[9px] text-red-600 font-mono">old</span>
            </div>
            <span className="text-amber-600 text-xl">→</span>
            <div className="flex flex-col items-center gap-1">
              <span className="w-12 h-12 rounded-md border-2 border-emerald-400 shadow-sm" style={{ background: afterColor }} />
              <span className="text-[9px] text-emerald-700 font-mono">new</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="w-12 h-12 rounded-md border shadow-sm" style={{ background: afterColor }} />
            <span className="text-[10px] text-gray-500 font-mono">color_id={String(row.values.color_id ?? "")}</span>
          </div>
        )}
        <div className="grid grid-cols-6 gap-1.5 pt-2 border-t">
          {palette.map(id => (
            <span
              key={id}
              className={`w-7 h-7 rounded-md shadow-sm border-2 ${String(after?.color_id ?? row.values.color_id) === id ? "border-gray-800" : "border-transparent"}`}
              style={{ background: CAL_COLORS[id] }}
              title={`color_id=${id}`}
            />
          ))}
        </div>
      </div>
    );
  }

  if (focus === "description") {
    const beforeDesc = String(before?.description ?? row.values.description ?? "");
    const afterDesc  = String(after?.description  ?? row.values.description ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Description</div>
        {isWrite && beforeDesc !== afterDesc ? (
          <div className="space-y-2">
            <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-[11px] text-red-700 whitespace-pre-wrap break-words max-h-24 overflow-y-auto line-through">{beforeDesc || <span className="italic">∅</span>}</div>
            <div className="text-amber-600 text-center text-[10px]">↓</div>
            <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-[11px] text-emerald-900 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{afterDesc || <span className="italic">∅</span>}</div>
          </div>
        ) : (
          <div className="px-2 py-1.5 rounded border bg-gray-50 text-[11px] text-gray-800 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{afterDesc || <span className="italic text-gray-400">No description.</span>}</div>
        )}
      </div>
    );
  }

  if (focus === "title") {
    const beforeT = String(before?.summary ?? "");
    const afterT  = String(after?.summary  ?? row.values.summary ?? "");
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Calendar name</div>
        {isWrite && beforeT !== afterT ? (
          <div className="space-y-1">
            <div className="px-2 py-1.5 rounded border bg-red-50 border-red-200 text-sm text-red-700 line-through truncate">{beforeT || "∅"}</div>
            <div className="text-amber-600 text-center text-[10px]">↓</div>
            <div className="px-2 py-1.5 rounded border bg-emerald-50 border-emerald-300 text-sm text-emerald-900 font-semibold truncate">{afterT || "∅"}</div>
          </div>
        ) : (
          <div className="px-2 py-1.5 rounded border bg-gray-50 text-sm text-gray-900 font-medium truncate">{afterT}</div>
        )}
      </div>
    );
  }

  if (focus === "visibility") {
    const beforeHidden = Number(before?.hidden ?? 0) === 1;
    const afterHidden  = Number(after?.hidden  ?? row.values.hidden ?? 0) === 1;
    const Toggle = ({ on }: { on: boolean }) => (
      <span className={`relative inline-block w-10 h-5 rounded-full transition-colors ${on ? "bg-emerald-400" : "bg-gray-300"}`}>
        <span className={`absolute top-0.5 ${on ? "left-5" : "left-0.5"} w-4 h-4 rounded-full bg-white shadow transition-all`} />
      </span>
    );
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Show in calendar list</div>
        {isWrite && beforeHidden !== afterHidden ? (
          <div className="flex items-center gap-3 text-[11px]">
            <div className="flex items-center gap-2">
              <Toggle on={!beforeHidden} />
              <span className="text-gray-500 line-through">{beforeHidden ? "hidden" : "visible"}</span>
            </div>
            <span className="text-amber-600">→</span>
            <div className="flex items-center gap-2">
              <Toggle on={!afterHidden} />
              <span className="text-gray-900 font-semibold">{afterHidden ? "hidden" : "visible"}</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11px]">
            <Toggle on={!hidden} />
            <span className="text-gray-700">{hidden ? "hidden" : "visible"}</span>
          </div>
        )}
      </div>
    );
  }

  if (focus === "create") {
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="rounded border-2 border-emerald-300 bg-emerald-50 p-2 text-[11px] space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm" style={{ background: color }} />
            <span className="text-sm font-semibold text-gray-900 truncate">{summary}</span>
          </div>
          {String(row.values.description ?? "") && (
            <div className="text-gray-700 line-clamp-3">{String(row.values.description)}</div>
          )}
        </div>
        <div className="text-[10px] text-emerald-700 italic">New calendar created.</div>
      </div>
    );
  }

  if (focus === "delete") {
    return (
      <div className="space-y-3">
        {breadcrumb}
        <div className="rounded border border-red-300 bg-red-50 p-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm opacity-40" style={{ background: color }} />
            <span className="text-sm font-semibold text-red-700 line-through truncate">{summary}</span>
          </div>
        </div>
        <span className="px-2 py-1 rounded bg-red-100 text-red-700 text-[10px] font-semibold inline-block">🗑 Calendar removed</span>
      </div>
    );
  }

  // view / general
  const cols = (change?.cols ?? []);
  return (
    <div className="space-y-3">
      {breadcrumb}
      <div className="rounded border bg-gray-50 p-2 text-[11px] space-y-1">
        {String(row.values.description ?? "") && <div className="text-gray-700">{String(row.values.description)}</div>}
        {Number(row.values.is_primary) === 1 && <div className="text-amber-700 text-[10px]">★ Primary calendar</div>}
        <div className="text-gray-500 text-[10px] font-mono">color_id={String(row.values.color_id ?? "—")}</div>
      </div>
      {cols.length > 0 && (
        <div className="border rounded-md bg-gray-50">
          {cols.map(col => (
            <PaneField key={col} label={col} value={String(after?.[col] ?? "")} changed before={String(before?.[col] ?? "")} after={String(after?.[col] ?? "")} mono />
          ))}
        </div>
      )}
      <div className="text-[10px] text-gray-500 italic">
        {isWrite ? "Agent saved these calendar changes." : isError ? "Tool failed — see chat for details." : "Agent inspected this calendar."}
      </div>
    </div>
  );
}

/* ── ACL pane — sharing settings ───────────────────────────────────── */
function AclPaneBody({ calendarRow, aclUser, change, isWrite }: {
  calendarRow: SandboxRow | null;
  aclUser: SandboxRow | null;
  change: ChangeRecord | null;
  isWrite: boolean;
}) {
  const before = (change?.before ?? null) as Record<string, unknown> | null;
  const after  = (change?.after  ?? null) as Record<string, unknown> | null;
  const beforeRole = String(before?.role ?? "");
  const afterRole  = String(after?.role  ?? "");
  const op = change?.op;
  const calSummary = calendarRow ? String(calendarRow.values.summary ?? calendarRow.id) : "—";
  const calColorHex = calendarRow ? calColor(calendarRow.values.color_id) : DEFAULT_CAL_COLOR;
  const userName = aclUser ? String(aclUser.values.name ?? aclUser.values.email ?? aclUser.id) : (after?.scope_value ? String(after.scope_value) : before?.scope_value ? String(before.scope_value) : "user");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] border-b pb-2">
        <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: calColorHex }} />
        <div className="min-w-0 flex-1">
          <div className="text-gray-900 font-medium truncate">{calSummary}</div>
          <div className="text-gray-500 text-[10px]">Share & permissions</div>
        </div>
      </div>
      <div className={`rounded border p-2 text-[11px] flex items-center gap-2 ${op === "insert" ? "bg-emerald-50 border-emerald-300" : op === "delete" ? "bg-red-50 border-red-300" : "bg-amber-50 border-amber-300"}`}>
        <span className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 text-white flex items-center justify-center text-[10px] font-semibold shrink-0">
          {initials(userName) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-gray-900 truncate font-medium">{userName}</div>
          <div className="text-[10px] text-gray-600 font-mono truncate">{String(after?.scope_type ?? before?.scope_type ?? "user")}</div>
        </div>
        {op === "update" ? (
          <span className="text-[10px] font-mono">
            <span className="text-red-600 line-through">{beforeRole || "?"}</span>
            <span className="text-amber-700 mx-1">→</span>
            <span className="text-emerald-700 font-semibold">{afterRole || "?"}</span>
          </span>
        ) : (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${op === "insert" ? "bg-emerald-100 text-emerald-800" : op === "delete" ? "bg-red-100 text-red-800 line-through" : "bg-gray-100 text-gray-700"}`}>
            {afterRole || beforeRole || "—"}
          </span>
        )}
        {op && (
          <span className={`px-1 py-0 rounded text-[8.5px] font-bold text-white ${op === "insert" ? "bg-emerald-500" : op === "update" ? "bg-amber-500" : "bg-red-500"}`}>
            {op === "insert" ? "NEW" : op === "update" ? "EDIT" : "DEL"}
          </span>
        )}
      </div>
      <div className="text-[10px] text-gray-500 italic">
        {isWrite ? "Agent saved the access change." : "Agent inspected the sharing rules."}
      </div>
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
