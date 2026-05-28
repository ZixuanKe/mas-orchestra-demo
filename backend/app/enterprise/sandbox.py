"""Snapshot the gym's relational state and compute row-level diffs.

We model the sandbox as ``{table: {row_pk: row_dict}}``. The PK column is
discovered heuristically (look for ``id`` / ``<table_singular>_id`` /
``rowid``). Diffs are emitted as a stream of ``{table, op, row_id, before,
after}`` events so the frontend can animate just what changed.

We deliberately skip large/auxiliary tables to keep the panel readable. Per
domain we curate a whitelist of "interesting" tables and a column blacklist
for noisy timestamp columns. If a domain is missing here, we fall back to
auto-detect on the first snapshot.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .mcp_client import MCPClient

_TIMESTAMPS = {"created_at", "updated_at", "etag", "created_on", "updated_on",
                "created_by", "updated_by", "created_datetime", "updated_datetime"}

# Per-domain visibility config — keeps the UI focused on what the user cares
# about. Each entry curates the most "story-worthy" tables (in render order)
# plus the FK columns we know about so the graph view can draw row-to-row
# edges. Domains without an entry fall back to auto-discovery (all tables,
# no FK edges).
_DOMAIN_VIEWS: dict[str, dict[str, Any]] = {
    "calendar": {
        # Order matters — it controls graph layout.
        "tables": [
            "users",
            "calendars",
            "events",
            "acls",
            "attendees",
        ],
        # Per-table FK columns used to draw graph edges.
        "links": {
            "calendars": [("user_id", "users", "user_id")],
            "events":    [("calendar_id", "calendars", "calendar_id"),
                          ("user_id", "users", "user_id")],
            "acls":      [("calendar_id", "calendars", "calendar_id")],
            "attendees": [("event_id", "events", "event_id")],
        },
        # Noisy / verbose columns to hide in the panel summaries.
        "hide_columns": {
            "*": {"created_at", "updated_at", "etag"},
            "users": {"static_token", "access_token_hash", "refresh_token_hash",
                       "picture", "locale", "provider", "provider_id",
                       "is_active", "is_verified", "given_name", "family_name",
                       "last_login_at"},
            "calendars": {"conference_properties", "default_reminders",
                           "notification_settings", "summary_override",
                           "background_color", "foreground_color"},
            "events": {"iCalUID", "originalStartTime_date",
                        "originalStartTime_dateTime",
                        "originalStartTime_timeZone",
                        "guestsCanInviteOthers", "guestsCanModify",
                        "guestsCanSeeOtherGuests", "privateCopy", "locked",
                        "hangoutLink", "transparency", "sequence", "source",
                        "extended_properties", "recurring_event_id",
                        "start_timezone", "end_timezone",
                        "originalStartTime"},
        },
        # PK overrides where the heuristic might pick wrong.
        "pk": {
            "users": "user_id",
            "calendars": "calendar_id",
            "events": "event_id",
            "acls": "acl_id",
            "attendees": "attendee_id",
        },
    },
    "email": {
        # ``message_labels`` is the many-to-many junction between
        # ``messages`` and ``labels``; exposing it lets the AppView
        # filter the Inbox list by a clicked label (INBOX / SENT /
        # TRASH / UNREAD / …) and visualise add_label / remove_label
        # tool calls as real diff events.
        "tables": ["users", "labels", "threads", "messages",
                   "message_labels", "drafts",
                   "filters", "delegates", "vacation_settings"],
        # Pull a larger window for the tables that drive the inbox
        # filtering chain — 50 rows of each isn't enough to cover the
        # message ↔ label associations for a realistic preview.
        "row_limits": {
            "messages": 400,
            "threads": 200,
            "labels": 200,
            "message_labels": 800,
        },
        "links": {
            "labels":   [("user_id", "users", "id")],
            "threads":  [("user_id", "users", "id")],
            "messages": [("user_id", "users", "id"), ("thread_id", "threads", "id")],
            "message_labels": [("message_id", "messages", "id"),
                                ("label_id", "labels", "id")],
            "drafts":   [("message_id", "messages", "id")],
            "filters":  [("user_id", "users", "id")],
            "delegates": [("user_id", "users", "id")],
        },
        "hide_columns": {
            "*": _TIMESTAMPS,
            # ``snippet`` intentionally kept visible — the AppView uses it
            # as the message preview line (mirrors Gmail's inbox row).
            "messages": {"raw", "data", "size_estimate"},
            "labels": {"color_json", "background_color", "text_color"},
        },
        "pk": {},
    },
    "hr": {
        "tables": ["organization", "user", "user_group", "hr_service",
                   "hr_case", "hr_case_task", "checklist", "knowledge",
                   "skill", "user_skill"],
        "links": {
            "user":           [("org_id", "organization", "organization_id")],
            "user_group":     [("org_id", "organization", "organization_id")],
            "hr_case":        [("hr_service", "hr_service", "hr_service_id"),
                               ("opened_for", "user", "user_id"),
                               ("opened_by", "user", "user_id"),
                               ("assigned_to", "user", "user_id"),
                               ("org_id", "organization", "organization_id")],
            "hr_case_task":   [("parent_case", "hr_case", "hr_case_id"),
                               ("assigned_to", "user", "user_id"),
                               ("hr_service", "hr_service", "hr_service_id")],
            "checklist":      [("case_task_id", "hr_case_task", "hr_case_task_id")],
            "user_skill":     [("user_id", "user", "user_id"),
                               ("skill_id", "skill", "skill_id")],
        },
        "hide_columns": {
            "*": _TIMESTAMPS,
            "hr_case": {"worknotes", "description", "skills",
                         "approval_criteria", "account_number"},
            "knowledge": {"content", "body"},
        },
        "pk": {
            "organization": "organization_id",
            "user": "user_id",
            "user_group": "user_group_id",
            "hr_service": "hr_service_id",
            "hr_case": "hr_case_id",
            "hr_case_task": "hr_case_task_id",
            "checklist": "checklist_id",
            "knowledge": "knowledge_id",
            "skill": "skill_id",
            "user_skill": "user_skill_id",
        },
    },
    "itsm": {
        "tables": ["organization", "users", "user_group", "service",
                   "service_offering", "configuration_item", "incident",
                   "problem", "change", "knowledge"],
        "links": {
            "users":              [("org_id", "organization", "organization_id")],
            "service":            [("org_id", "organization", "organization_id")],
            "service_offering":   [("service", "service", "service_id")],
            "configuration_item": [("org_id", "organization", "organization_id")],
            "incident": [("caller_id", "users", "user_id"),
                         ("assigned_to", "users", "user_id"),
                         ("service", "service", "service_id"),
                         ("service_offering", "service_offering", "service_offering_id"),
                         ("configuration_item", "configuration_item", "configuration_item_id"),
                         ("problem", "problem", "problem_id"),
                         ("change_request", "change", "change_id"),
                         ("org_id", "organization", "organization_id")],
            "problem":  [("assigned_to", "users", "user_id"),
                         ("service", "service", "service_id"),
                         ("org_id", "organization", "organization_id")],
            "change":   [("requested_by", "users", "user_id"),
                         ("assigned_to", "users", "user_id"),
                         ("service", "service", "service_id"),
                         ("configuration_item", "configuration_item", "configuration_item_id"),
                         ("org_id", "organization", "organization_id")],
        },
        "hide_columns": {
            "*": _TIMESTAMPS,
            "incident": {"worknotes", "resolution_notes", "close_notes",
                          "description", "implementation_plan", "testing_plan"},
            "change":   {"worknotes", "implementation_plan", "testing_plan",
                          "close_notes", "description"},
            "knowledge": {"content", "body"},
        },
        "pk": {
            "organization": "organization_id",
            "users": "user_id",
            "user_group": "user_group_id",
            "service": "service_id",
            "service_offering": "service_offering_id",
            "configuration_item": "configuration_item_id",
            "incident": "incident_id",
            "problem": "problem_id",
            "change": "change_id",
            "knowledge": "knowledge_id",
        },
    },
    "teams": {
        # Teams has ~90 tables — curate the headline 8.
        "tables": ["teams_orgs", "teams_users", "teams", "channels",
                   "channel_members", "channel_messages", "chats",
                   "online_meetings"],
        "links": {
            "teams_users":      [("org_id", "teams_orgs", "id")],
            "teams":            [("org_id", "teams_orgs", "id")],
            "channels":         [("team_id", "teams", "id")],
            "channel_members":  [("channel_id", "channels", "id"),
                                  ("user_id", "teams_users", "id")],
            "channel_messages": [("channel_id", "channels", "id"),
                                  ("user_id", "teams_users", "id")],
            "online_meetings":  [("organizer_id", "teams_users", "id")],
        },
        "hide_columns": {
            "*": _TIMESTAMPS,
            "channel_messages": {"body_content", "preview_text_content",
                                  "topic_json", "template_parameters_json",
                                  "recipient_json"},
        },
        "pk": {},
    },
    "csm": {
        "tables": ["account", "contact", "user", "product",
                   "installed_product", "customer_case", "interaction",
                   "contract", "entitlement", "knowledge"],
        "links": {
            "contact":           [("account_id", "account", "account_id")],
            "installed_product": [("account_id", "account", "account_id"),
                                   ("product_id", "product", "product_id")],
            "customer_case":     [("account_id", "account", "account_id"),
                                   ("contact_id", "contact", "contact_id"),
                                   ("assigned_to", "user", "user_id"),
                                   ("product_id", "product", "product_id"),
                                   ("installed_product_id", "installed_product", "installed_product_id")],
            "interaction":       [("account_id", "account", "account_id"),
                                   ("contact_id", "contact", "contact_id"),
                                   ("case_id", "customer_case", "customer_case_id")],
            "contract":          [("account_id", "account", "account_id")],
            "entitlement":       [("account_id", "account", "account_id"),
                                   ("contract_id", "contract", "contract_id")],
        },
        "hide_columns": {
            "*": _TIMESTAMPS,
            "customer_case": {"worknotes", "description", "resolution_notes"},
            "knowledge": {"content", "body"},
        },
        "pk": {},
    },
    "drive": {
        "tables": ["users", "groups", "drives", "files", "folders",
                   "permissions", "comments", "share_links", "revisions"],
        "links": {
            "files":       [("drive_id", "drives", "id"),
                             ("owner_id", "users", "id"),
                             ("parent_id", "folders", "id")],
            "folders":     [("drive_id", "drives", "id"),
                             ("parent_id", "folders", "id")],
            "permissions": [("file_id", "files", "id"),
                             ("user_id", "users", "id")],
            "comments":    [("file_id", "files", "id"),
                             ("author_id", "users", "id")],
            "share_links": [("file_id", "files", "id")],
            "revisions":   [("file_id", "files", "id")],
        },
        "hide_columns": {
            "*": _TIMESTAMPS,
            "files": {"data", "thumbnail", "raw"},
            "revisions": {"data"},
        },
        "pk": {},
    },
}

_DEFAULT_HIDE = _TIMESTAMPS


def view_for(domain: str) -> dict[str, Any]:
    return _DOMAIN_VIEWS.get(domain, {})


def hidden_columns(domain: str, table: str) -> set[str]:
    cfg = view_for(domain).get("hide_columns", {})
    return set(cfg.get("*", _DEFAULT_HIDE)) | set(cfg.get(table, set()))


def pk_for(domain: str, table: str) -> str | None:
    return view_for(domain).get("pk", {}).get(table)


def _guess_pk(table: str, columns: list[str]) -> str:
    """Best-effort PK detection when not specified in the domain config."""
    # exact "<singular>_id" first
    singular = table[:-1] if table.endswith("s") else table
    for cand in (f"{singular}_id", f"{table}_id", "id", "rowid"):
        if cand in columns:
            return cand
    for c in columns:
        if c.endswith("_id"):
            return c
    return columns[0] if columns else "rowid"


@dataclass
class TableSnapshot:
    table: str
    pk: str
    columns: list[str]
    rows: dict[str, dict[str, Any]] = field(default_factory=dict)  # pk_str -> row

    def to_payload(self, hidden: set[str]) -> dict[str, Any]:
        cols = [c for c in self.columns if c not in hidden]
        rows = []
        for pk_val, row in self.rows.items():
            rows.append({
                "id": pk_val,
                "values": {k: row.get(k) for k in cols},
            })
        return {"table": self.table, "pk": self.pk, "columns": cols, "rows": rows}


@dataclass
class Snapshot:
    domain: str
    tables: dict[str, TableSnapshot] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "tables": [
                ts.to_payload(hidden_columns(self.domain, name))
                for name, ts in self.tables.items()
            ],
            "links": _build_links(self),
        }


def _build_links(snap: Snapshot) -> list[dict[str, Any]]:
    """Compute row-to-row links from FK columns so the frontend can draw edges
    between entity nodes in the sandbox graph view."""
    out: list[dict[str, Any]] = []
    cfg_links = view_for(snap.domain).get("links", {})
    for src_table, links in cfg_links.items():
        ts_src = snap.tables.get(src_table)
        if not ts_src:
            continue
        for fk_col, dst_table, dst_pk in links:
            ts_dst = snap.tables.get(dst_table)
            if not ts_dst:
                continue
            for src_id, row in ts_src.rows.items():
                tgt_val = row.get(fk_col)
                if tgt_val is None or str(tgt_val) == "NULL":
                    continue
                tgt_id = str(tgt_val)
                if tgt_id in ts_dst.rows:
                    out.append({
                        "source_table": src_table, "source_id": src_id,
                        "target_table": dst_table, "target_id": tgt_id,
                        "label": fk_col,
                    })
    return out


async def take_snapshot(
    client: MCPClient,
    domain: str,
    table_limit: int = 50,
) -> Snapshot:
    """Snapshot the curated tables for ``domain``."""
    view = view_for(domain)
    tables = view.get("tables") or await client.list_tables()
    per_table = view.get("row_limits") or {}
    snap = Snapshot(domain=domain)
    for tname in tables:
        # Per-table override (e.g. junction/lookup tables that need
        # more rows so list↔rail filtering covers the visible window).
        limit = int(per_table.get(tname, table_limit))
        try:
            rows = await client.sql(f"SELECT * FROM {tname} LIMIT {limit}")
        except Exception:
            continue
        if not rows:
            # Still record the empty table so we can render placeholders.
            snap.tables[tname] = TableSnapshot(table=tname, pk="", columns=[])
            continue
        cols = list(rows[0].keys())
        pk = pk_for(domain, tname) or _guess_pk(tname, cols)
        ts = TableSnapshot(table=tname, pk=pk, columns=cols)
        for r in rows:
            pk_val = r.get(pk)
            if pk_val is None:
                pk_val = f"row_{len(ts.rows)}"
            ts.rows[str(pk_val)] = r
        snap.tables[tname] = ts
    return snap


def diff(prev: Snapshot, curr: Snapshot) -> list[dict[str, Any]]:
    """Compute per-row insert/update/delete events between two snapshots.

    Output items look like:
        {table, op: 'insert'|'update'|'delete', row_id, before, after,
         changed_columns}

    ``before``/``after`` payloads are filtered to non-hidden columns.
    """
    events: list[dict[str, Any]] = []
    tables = set(prev.tables) | set(curr.tables)
    for tname in tables:
        prev_t = prev.tables.get(tname)
        curr_t = curr.tables.get(tname)
        hidden = hidden_columns(curr.domain, tname)
        prev_rows = prev_t.rows if prev_t else {}
        curr_rows = curr_t.rows if curr_t else {}

        for rid, after in curr_rows.items():
            if rid not in prev_rows:
                events.append({
                    "table": tname, "op": "insert", "row_id": rid,
                    "before": None,
                    "after": {k: v for k, v in after.items() if k not in hidden},
                    "changed_columns": [],
                })
            else:
                before = prev_rows[rid]
                changed = [k for k in after
                           if str(after.get(k)) != str(before.get(k))
                           and k not in hidden]
                if changed:
                    events.append({
                        "table": tname, "op": "update", "row_id": rid,
                        "before": {k: before.get(k) for k in changed},
                        "after":  {k: after.get(k) for k in changed},
                        "changed_columns": changed,
                    })

        for rid, before in prev_rows.items():
            if rid not in curr_rows:
                events.append({
                    "table": tname, "op": "delete", "row_id": rid,
                    "before": {k: v for k, v in before.items() if k not in hidden},
                    "after": None,
                    "changed_columns": [],
                })
    return events
