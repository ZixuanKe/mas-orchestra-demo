// Per-domain config that drives the generic AppView. Each entry tells the
// view which tables are the "headline" list and the contextual rail, and
// which columns hold the title, snippet, status, priority, assignee, and
// timestamp. The view then renders something that resembles the real app
// for that domain (Inbox for email, Cases for HR/CSM/ITSM, Channels for
// teams, Files for drive) with the same diff + activity + slide-in-pane
// treatment we ship for calendar.
//
// Calendar has a dedicated CalendarAppView so isn't included here.

export interface DomainViewConfig {
  domain: string;
  appLabel: string;           // text shown in the header strip ("Inbox")
  icon: string;
  themeRgb: string;           // accent colour as `r g b` (used via `rgb(var(...) / a)` tailwind tricks)
  rail: RailConfig | null;
  list: ListConfig;
  // Optional secondary list rendered under each row (comments, attachments,
  // attendees-like things). Most domains don't need this — set per case.
  childTable?: ChildConfig | null;
  // Pretty labels for column names (used in focus panes + diff chips).
  colLabels?: Record<string, string>;
  // Map column → focus page in the side pane. Unknown columns fall back to
  // "general" which renders all changed columns as PaneField rows.
  focusForCol?: Record<string, FocusKey>;
  // Map enum status values → coloured chip tone (tailwind class fragment).
  statusTone?: Record<string, "red" | "amber" | "emerald" | "blue" | "gray" | "purple">;
  priorityTone?: Record<string, "red" | "amber" | "emerald" | "blue" | "gray">;
}

export interface RailConfig {
  label: string;              // "Labels", "Services", "Teams", etc.
  table: string;
  titleCol: string;
  colorCol?: string;          // optional, mapped through CAL_COLORS for chips
  countCol?: string;          // shown as a badge next to the title
  icon: string;
  // When true the rail renders a single chip per unique title value
  // (so 25 per-user copies of "INBOX" collapse into one). Useful for
  // gym data that loads system enums per user.
  dedupByTitle?: boolean;
  // Many-to-many filter chain. When set, clicking a rail chip filters
  // the list to rows that match THIS rail row via a junction table —
  // not a direct parentCol FK on the list row. Used by email labels
  // (labels ↔ message_labels ↔ messages → threads).
  //
  // Walking logic:
  //   1. Take all rows in ``junctionTable`` where
  //      ``junctionTable[junctionRailCol] in clickedRailIds``.
  //   2. Either (a) intermediate hop: collect those rows'
  //      ``junctionInterCol``, look those up as IDs in ``interTable``,
  //      then take their ``interListCol`` as the set of list IDs to
  //      keep; or (b) direct: when ``interTable`` is omitted, treat
  //      ``junctionInterCol`` itself as the list-row id.
  //
  // ``clickedRailIds`` is the set of rail row ids that share the
  // clicked chip's title (dedup-by-title means one click can refer to
  // many physical rail rows — one per user).
  filterVia?: {
    junctionTable: string;      // e.g. "message_labels"
    junctionRailCol: string;    // "label_id"   (FK to rail)
    junctionInterCol: string;   // "message_id" (FK to intermediate, or list directly)
    interTable?: string;        // "messages"
    interListCol?: string;      // "thread_id"  (col on intermediate that holds the list-row id)
  };
}

export interface ListConfig {
  label: string;
  table: string;
  titleCol: string;
  snippetCol?: string;        // body / description preview
  // Some title/snippet columns store both a subject and a body separated
  // by a delimiter (e.g. email threads: "Subject - body preview…"). When
  // ``splitOn`` is set, the AppView splits ``titleCol``'s value on the
  // first occurrence to populate the title and snippet independently.
  splitOn?: string;
  statusCol?: string;
  priorityCol?: string;
  assignedToCol?: string;     // FK to users table → resolved to display name
  fromCol?: string;           // FK to users for "From" line (email)
  // Optional JSON-payload columns (Teams stores body + author as JSON
  // blobs). When set the AppView pulls a readable snippet / sender out
  // of the JSON instead of dumping the raw blob.
  bodyJsonCol?: string;       // expects {"content": "..."} (HTML allowed)
  fromJsonCol?: string;       // expects {"user": {"displayName": "..."}}
  dateCol?: string;           // for grouping/sorting
  parentCol?: string;         // FK to rail entity, used to filter when a rail item is selected
  icon: string;
  // Optional: how to render a single row as a card. The generic view has a
  // sensible default; override to add domain-specific chrome.
  cardKind?: "thread" | "case" | "incident" | "message" | "file";
}

export interface ChildConfig {
  table: string;
  parentFkCol: string;        // links each child row to its parent list-row by id
  titleCol: string;
}

export type FocusKey =
  | "title" | "snippet" | "body" | "description"
  | "status" | "priority" | "assignee" | "owner"
  | "recipients" | "labels" | "category"
  | "color" | "visibility" | "share" | "move"
  | "due" | "schedule" | "general";

export const DOMAIN_VIEWS: Record<string, DomainViewConfig> = {
  email: {
    domain: "email",
    appLabel: "Inbox",
    icon: "📧",
    themeRgb: "234 67 53", // Gmail red
    rail: {
      label: "Labels",
      table: "labels",
      titleCol: "name",
      icon: "🏷️",
      // Gmail seeds the same system labels (INBOX, SENT, …) once per
      // user — dedupe by name so the rail isn't N×duplicated.
      dedupByTitle: true,
      // labels ↔ message_labels ↔ messages → threads. Click a label
      // chip and the Inbox filters to threads that contain at least
      // one message tagged with that label (or any of its sibling
      // per-user copies, since dedupByTitle collapses them).
      filterVia: {
        junctionTable: "message_labels",
        junctionRailCol: "label_id",
        junctionInterCol: "message_id",
        interTable: "messages",
        interListCol: "thread_id",
      },
    },
    list: {
      // ``messages`` is envelope-only in this gym (no subject/body); the
      // human-readable content lives on the ``threads`` row's ``snippet``
      // column as "Subject - body preview…". Split on the first " - "
      // to populate the card title + body separately.
      label: "Threads",
      table: "threads",
      titleCol: "snippet",
      snippetCol: "snippet",
      splitOn: " - ",
      icon: "✉️",
      cardKind: "thread",
    },
    colLabels: {
      subject: "Subject",
      body: "Body",
      snippet: "Snippet",
      to_address: "To",
      cc_address: "Cc",
      bcc_address: "Bcc",
      from_address: "From",
      is_unread: "Unread",
      is_starred: "Starred",
      is_draft: "Draft",
      received_at: "Received",
      label_ids: "Labels",
    },
    focusForCol: {
      subject: "title",
      snippet: "snippet",
      body: "body",
      to_address: "recipients",
      cc_address: "recipients",
      bcc_address: "recipients",
      from_address: "recipients",
      label_ids: "labels",
      is_starred: "status",
      is_unread: "status",
      is_draft: "status",
      is_trash: "status",
    },
    statusTone: {
      "1": "blue", "0": "gray",
    },
  },
  hr: {
    domain: "hr",
    appLabel: "HR Cases",
    icon: "🧑‍💼",
    themeRgb: "99 102 241", // indigo
    rail: {
      label: "Services",
      table: "hr_service",
      // Actual column is ``service_name``; ``name`` is absent on this
      // gym's schema and was falling through to the entity-stub.
      titleCol: "service_name",
      icon: "🗂️",
    },
    list: {
      label: "Cases",
      table: "hr_case",
      titleCol: "short_description",
      snippetCol: "description",
      // Real column is ``status`` (HR gym uses status, not state). The
      // ITSM/CSM gyms use ``state``; keep per-domain.
      statusCol: "status",
      priorityCol: "priority",
      assignedToCol: "assigned_to",
      dateCol: "sys_created_on",
      parentCol: "hr_service",
      icon: "📋",
      cardKind: "case",
    },
    colLabels: {
      short_description: "Title",
      description: "Description",
      state: "State",
      priority: "Priority",
      assigned_to: "Assignee",
      opened_by: "Opened by",
      opened_for: "For",
      due_date: "Due",
      hr_service: "Service",
      worknotes: "Work notes",
      approval_criteria: "Approval criteria",
    },
    focusForCol: {
      short_description: "title",
      description: "description",
      state: "status",
      priority: "priority",
      assigned_to: "assignee",
      opened_for: "assignee",
      opened_by: "assignee",
      due_date: "due",
      worknotes: "body",
    },
    statusTone: {
      new: "blue", in_progress: "amber", on_hold: "purple",
      resolved: "emerald", closed: "gray", cancelled: "red",
    },
    priorityTone: {
      "1": "red", "2": "amber", "3": "blue", "4": "gray", "5": "gray",
      critical: "red", high: "amber", medium: "blue", low: "gray",
    },
  },
  itsm: {
    domain: "itsm",
    appLabel: "ITSM",
    icon: "🛠️",
    themeRgb: "234 88 12", // orange
    rail: {
      label: "Services",
      table: "service",
      titleCol: "name",
      icon: "🧩",
    },
    list: {
      label: "Incidents",
      table: "incident",
      titleCol: "short_description",
      // No description column on incident; fall back to short_description
      // (Card splits text if needed). ITSM gym uses ``status`` like HR.
      statusCol: "status",
      priorityCol: "priority",
      assignedToCol: "assigned_to",
      dateCol: "sys_created_on",
      parentCol: "service",
      icon: "🚨",
      cardKind: "incident",
    },
    colLabels: {
      short_description: "Title",
      description: "Description",
      state: "State",
      priority: "Priority",
      urgency: "Urgency",
      impact: "Impact",
      assigned_to: "Assignee",
      caller_id: "Caller",
      service: "Service",
      configuration_item: "CI",
      resolution_notes: "Resolution",
    },
    focusForCol: {
      short_description: "title",
      description: "description",
      state: "status",
      priority: "priority",
      urgency: "priority",
      impact: "priority",
      assigned_to: "assignee",
      caller_id: "assignee",
      service: "category",
      configuration_item: "category",
      resolution_notes: "body",
    },
    statusTone: {
      new: "blue", in_progress: "amber", on_hold: "purple",
      resolved: "emerald", closed: "gray", cancelled: "red",
      open: "blue",
    },
    priorityTone: {
      "1": "red", "2": "amber", "3": "blue", "4": "gray", "5": "gray",
      critical: "red", high: "amber", medium: "blue", low: "gray",
    },
  },
  csm: {
    domain: "csm",
    appLabel: "Customer Cases",
    icon: "🤝",
    themeRgb: "16 185 129", // emerald
    rail: {
      label: "Accounts",
      table: "account",
      titleCol: "name",
      icon: "🏢",
    },
    list: {
      label: "Cases",
      table: "customer_case",
      titleCol: "short_description",
      statusCol: "state",
      priorityCol: "priority",
      assignedToCol: "assigned_to",
      dateCol: "sys_created_on",
      parentCol: "account_id",
      icon: "🎫",
      cardKind: "case",
    },
    colLabels: {
      short_description: "Title",
      description: "Description",
      state: "State",
      priority: "Priority",
      assigned_to: "Assignee",
      account_id: "Account",
      contact_id: "Contact",
      product_id: "Product",
      installed_product_id: "Installed product",
      resolution_notes: "Resolution",
    },
    focusForCol: {
      short_description: "title",
      description: "description",
      state: "status",
      priority: "priority",
      assigned_to: "assignee",
      account_id: "move",
      contact_id: "assignee",
      product_id: "category",
      resolution_notes: "body",
    },
    statusTone: {
      new: "blue", in_progress: "amber", on_hold: "purple",
      resolved: "emerald", closed: "gray", cancelled: "red",
      open: "blue",
    },
    priorityTone: {
      "1": "red", "2": "amber", "3": "blue", "4": "gray", "5": "gray",
      critical: "red", high: "amber", medium: "blue", low: "gray",
    },
  },
  teams: {
    domain: "teams",
    appLabel: "Teams",
    icon: "💬",
    themeRgb: "98 100 167", // Teams purple
    rail: {
      label: "Channels",
      table: "channels",
      titleCol: "display_name",
      icon: "📂",
    },
    list: {
      label: "Messages",
      table: "channel_messages",
      titleCol: "subject",
      snippetCol: "summary",
      // Real body lives inside body_json (`{"content":"<p>…</p>"}`) and
      // the author inside from_json — the AppView extracts these for
      // human-readable preview text and "From" line.
      bodyJsonCol: "body_json",
      fromJsonCol: "from_json",
      dateCol: "last_modified_datetime",
      parentCol: "channel_id",
      icon: "💭",
      cardKind: "message",
    },
    colLabels: {
      subject: "Subject",
      body_content: "Body",
      user_id: "From",
      channel_id: "Channel",
      importance: "Importance",
      preview_text_content: "Preview",
    },
    focusForCol: {
      subject: "title",
      body_content: "body",
      user_id: "recipients",
      channel_id: "move",
      importance: "priority",
    },
    priorityTone: {
      urgent: "red", high: "amber", normal: "blue", low: "gray",
    },
  },
  drive: {
    domain: "drive",
    appLabel: "Drive",
    icon: "💾",
    themeRgb: "26 115 232", // Drive blue
    rail: {
      label: "Drives",
      table: "drives",
      titleCol: "name",
      icon: "💿",
    },
    list: {
      label: "Files",
      table: "files",
      titleCol: "name",
      snippetCol: "description",
      statusCol: "trashed",
      // Drive gym stores the editor in ``modified_by`` (a users FK);
      // ``owner_id`` doesn't exist on the files row.
      assignedToCol: "modified_by",
      dateCol: "modified_time",
      parentCol: "drive_id",
      icon: "📄",
      cardKind: "file",
    },
    colLabels: {
      name: "Name",
      description: "Description",
      mime_type: "Type",
      owner_id: "Owner",
      drive_id: "Drive",
      parent_id: "Folder",
      trashed: "Trashed",
      starred: "Starred",
      shared: "Shared",
      size: "Size",
      modified_time: "Modified",
    },
    focusForCol: {
      name: "title",
      description: "description",
      mime_type: "category",
      owner_id: "owner",
      drive_id: "move",
      parent_id: "move",
      trashed: "status",
      starred: "status",
      shared: "share",
    },
  },
};

/* Quick lookups used by SandboxPanel + GenericAppView. */
export const GENERIC_APP_DOMAINS = new Set(Object.keys(DOMAIN_VIEWS));

export function domainConfig(domain: string): DomainViewConfig | null {
  return DOMAIN_VIEWS[domain] || null;
}

/** Reusable colour palette (Google Calendar's, but suitable for any
 *  domain). Indexed by color_id and falls back to a sensible default. */
export const APP_COLORS: Record<string, string> = {
  "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73",
  "5": "#f6bf26", "6": "#f4511e", "7": "#039be5", "8": "#616161",
  "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};
export const DEFAULT_APP_COLOR = "#1a73e8";

export function appColor(colorId: unknown): string {
  const id = colorId == null ? "" : String(colorId);
  return APP_COLORS[id] || DEFAULT_APP_COLOR;
}

/** Tone classes for status / priority chips. Keep tones consistent across
 *  the rail and the cards so the visual language travels. */
export const TONE_CLASSES: Record<string, { bg: string; text: string; border: string }> = {
  red:     { bg: "bg-red-50",     text: "text-red-700",     border: "border-red-200" },
  amber:   { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-200" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
  blue:    { bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200" },
  purple:  { bg: "bg-purple-50",  text: "text-purple-700",  border: "border-purple-200" },
  gray:    { bg: "bg-gray-50",    text: "text-gray-700",    border: "border-gray-200" },
};
