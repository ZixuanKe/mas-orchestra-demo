"""Curated + auto-discovered EnterpriseOps tasks for the demo.

Two-tier layout:

  * Featured (hand-picked) tasks at the top of each domain — chosen for
    compact, visually-compelling sandbox diffs. These get friendly titles
    and one-line summaries.

  * Auto-discovered tasks from the gym's
    ``evovle_benchmark_breath/<domain>/benchmark/configs/oracle__*.json``
    set. Title is synthesized from the first sentence of the user prompt;
    summary is the next ~140 chars. Stable IDs are derived from the
    filename so featured tasks can be referenced by the same id.

The user-facing payload (``to_payload``) is intentionally compact so the UI
can render a long list. Heavier fields (``system_prompt``, ``seed_sql``,
``verifiers``) are loaded server-side and only used at plan/run/verify time.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .gym_config import GYMS

logger = logging.getLogger(__name__)

GYM_ROOT = Path(
    "/export/xgen-finance/meta_agent/mas_evovle_enviroment/EnterpriseOps-Gym"
)


@dataclass(frozen=True)
class EnterpriseTask:
    id: str
    title: str
    summary: str
    domain: str
    user_prompt: str
    system_prompt: str
    seed_sql_path: str
    default_tools: list[str]
    context: dict[str, str]
    # Oracle ground-truth checks. Each entry is the raw ``verifiers[i]`` dict
    # from the gym config — typically a database_state check with
    # ``validation_config = {query, expected_value, comparison_type}``.
    # Re-runnable on demand by ``enterprise_orch.run_verifiers``.
    verifiers: tuple = ()
    # ``True`` if this task is in the hand-picked featured list for its
    # domain — surfaces a star in the picker.
    featured: bool = False
    # Stable absolute path of the source oracle config (for diagnostics).
    source: str = ""

    def seed_sql(self) -> str:
        path = GYM_ROOT / self.seed_sql_path
        if not path.exists():
            raise FileNotFoundError(f"Seed SQL missing: {path}")
        return path.read_text()

    def to_payload(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "domain": self.domain,
            "user_prompt": self.user_prompt,
            "default_tools": list(self.default_tools),
            "verifier_count": len(self.verifiers),
            "featured": self.featured,
        }


# ─────────────────────────────────────────────────────────── gym defaults

_DEFAULT_POLICIES: dict[str, str] = {
    "calendar": (
        "You are a Google Calendar automation agent with full admin rights to "
        "manage users, calendars, and events. Execute actions without asking "
        "for confirmation. Verify the requested entities exist before mutating "
        "them; prefer the smallest set of tool calls that satisfy the request."
    ),
    "email": (
        "You are a Gmail automation agent with full admin rights to manage "
        "users, labels, filters, drafts, and messages. Execute actions without "
        "asking for confirmation. Resolve targets (users, threads, messages) "
        "before mutating; prefer the smallest set of tool calls."
    ),
    "hr": (
        "You are an HR service-desk automation agent with full admin rights "
        "to manage cases, tasks, users, and knowledge. Execute actions without "
        "asking for confirmation. Look up entities before referencing them."
    ),
    "itsm": (
        "You are an ITSM automation agent with full admin rights to manage "
        "incidents, problems, changes, services, and CIs. Execute actions "
        "without asking for confirmation. Resolve referenced entities first."
    ),
    "teams": (
        "You are a Microsoft Teams automation agent with full admin rights to "
        "manage teams, channels, members, meetings, and messages. Execute "
        "actions without asking for confirmation."
    ),
    "csm": (
        "You are a Customer Service Management automation agent with full "
        "admin rights to manage accounts, contacts, cases, contracts, and "
        "entitlements. Execute actions without asking for confirmation."
    ),
    "drive": (
        "You are a Google Drive automation agent with full admin rights to "
        "manage drives, folders, files, permissions, and comments. Execute "
        "actions without asking for confirmation."
    ),
}


# ─────────────────────────────────────────────────────────── featured curation

# Hand-picked task ids (filename stem without extension) that get a friendly
# title/summary and float to the top of the picker. Other tasks from the
# same domain are auto-loaded with synthesized labels.
@dataclass(frozen=True)
class _FeaturedSpec:
    file_stem: str
    title: str
    summary: str


_FEATURED: dict[str, list[_FeaturedSpec]] = {
    "calendar": [
        _FeaturedSpec(
            "oracle__calendar__task_20251124_112741_995_0a0bf089_3906a767",
            "Helios Innovation Roadmap",
            "Create a new secondary calendar, update its metadata, add it to Alice's list, then schedule a kickoff event.",
        ),
        _FeaturedSpec(
            "oracle__calendar__task_20251117_165528_648_bca89e7d_3e81ece9",
            "Search Algorithm Kickoff",
            "Create a 'Search Algorithm Beta' calendar, grant Carol edit access, then book the kickoff on the first free morning.",
        ),
        _FeaturedSpec(
            "oracle__calendar__task_20251128_220140_863_df2c536d_4aa7dcfd",
            "Q4 Code Freeze",
            "Schedule an all-day Focus Time 'Code Freeze' event on the Dev calendar, declining conflicting invitations.",
        ),
    ],
    # Other domains start un-curated — every loaded task uses auto-synthesized
    # title/summary. Add featured specs here as you find compelling ones.
}


# ─────────────────────────────────────────────────────────── loader

_CONFIG_GLOB = "evovle_benchmark_breath/{domain}/benchmark/configs/oracle__*.json"


def _synthesize_title(user_prompt: str, fallback: str) -> str:
    """First clause of the prompt, capped at 60 chars, Title-Cased."""
    p = (user_prompt or "").strip().replace("\n", " ")
    # Cut at first . / ? / ; or 60 chars, whichever comes first.
    m = re.search(r"[.;?!]", p[:80])
    snippet = p[: m.start()] if m else p[:60]
    snippet = snippet.strip().strip("\"'`")
    if not snippet:
        return fallback
    # If it's all caps or all lowercase, gently title-case the first word.
    if snippet[0].islower():
        snippet = snippet[0].upper() + snippet[1:]
    return snippet[:80]


def _synthesize_summary(user_prompt: str) -> str:
    p = (user_prompt or "").strip().replace("\n", " ")
    return (p[:160] + ("…" if len(p) > 160 else ""))


def _safe_load(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except Exception as e:
        logger.warning(f"skip malformed oracle config {path.name}: {e}")
        return None


def _build_task(
    domain: str, path: Path, featured_spec: _FeaturedSpec | None,
) -> EnterpriseTask | None:
    raw = _safe_load(path)
    if raw is None:
        return None
    gyms = raw.get("gym_servers_config") or []
    if not gyms:
        # Some tasks describe multi-gym scenarios we can't run here.
        return None
    seed_rel = gyms[0].get("seed_database_file") or ""
    if not seed_rel:
        return None
    ctx = (gyms[0].get("context") or {})
    user_prompt = raw.get("user_prompt") or ""
    if not user_prompt:
        return None
    file_stem = path.stem
    if featured_spec is not None:
        title = featured_spec.title
        summary = featured_spec.summary
        featured = True
    else:
        title = _synthesize_title(user_prompt, fallback=file_stem)
        summary = _synthesize_summary(user_prompt)
        featured = False
    return EnterpriseTask(
        id=f"{domain}.{file_stem}",
        title=title,
        summary=summary,
        domain=domain,
        user_prompt=user_prompt,
        system_prompt=raw.get("system_prompt") or _DEFAULT_POLICIES.get(domain, ""),
        seed_sql_path=seed_rel,
        default_tools=raw.get("selected_tools") or [],
        context=ctx,
        verifiers=tuple(raw.get("verifiers") or ()),
        featured=featured,
        source=str(path),
    )


@lru_cache(maxsize=1)
def _load_all() -> dict[str, EnterpriseTask]:
    """Discover every oracle task across every registered gym domain.

    Featured tasks (see ``_FEATURED``) are loaded first so they appear at the
    top of the per-domain list. The rest are sorted alphabetically by id for
    stable display.

    Cached — the on-disk task set is effectively immutable for a server
    process. Call ``_load_all.cache_clear()`` from a maintenance endpoint if
    you ever need to re-scan without restarting.
    """
    out: dict[str, EnterpriseTask] = {}
    for domain in GYMS.keys():
        featured_by_stem = {f.file_stem: f for f in _FEATURED.get(domain, [])}
        seen: set[str] = set()
        # Featured first (in declared order).
        for spec in _FEATURED.get(domain, []):
            path = GYM_ROOT / _CONFIG_GLOB.format(domain=domain).replace(
                "oracle__*.json", f"{spec.file_stem}.json")
            if path.exists():
                t = _build_task(domain, path, spec)
                if t and t.id not in out:
                    out[t.id] = t
                    seen.add(spec.file_stem)
        # Then everything else, alphabetically.
        glob_root = GYM_ROOT / _CONFIG_GLOB.format(domain=domain).rsplit("/", 1)[0]
        if not glob_root.exists():
            logger.info(f"no benchmark configs for domain {domain!r} at {glob_root}")
            continue
        for path in sorted(glob_root.glob("oracle__*.json")):
            if path.stem in seen:
                continue
            t = _build_task(domain, path, featured_by_stem.get(path.stem))
            if t and t.id not in out:
                out[t.id] = t
    logger.info(f"loaded {len(out)} enterprise tasks across {len(GYMS)} domains")
    return out


# ─────────────────────────────────────────────────────────── public API

def list_tasks(domain: str | None = None) -> list[EnterpriseTask]:
    tasks = list(_load_all().values())
    if domain is not None:
        tasks = [t for t in tasks if t.domain == domain]
    # Featured first, then alpha by title for predictable scrolling.
    return sorted(tasks, key=lambda t: (not t.featured, t.title.lower()))


def get_task(task_id: str) -> EnterpriseTask:
    # Custom (user-typed) tasks live in a separate in-process registry so
    # they survive across /plan, /refine, /execute, /verify, etc.
    if task_id in _CUSTOM_TASKS:
        return _CUSTOM_TASKS[task_id]
    tasks = _load_all()
    if task_id not in tasks:
        raise KeyError(f"Unknown enterprise task: {task_id!r}")
    return tasks[task_id]


# ─────────────────────────────────────────── custom (user-typed) tasks
#
# When the user types a free-form query in the picker the frontend POSTs
# to /enterprise/custom-task; the backend synthesises an EnterpriseTask
# that reuses the first available oracle task's gym wiring (seed SQL +
# system prompt + tool catalog) so the sandbox is still seeded with
# realistic data. The new task is stored in ``_CUSTOM_TASKS`` and looked
# up by ``get_task`` like any other task.
import uuid as _uuid

_CUSTOM_TASKS: dict[str, EnterpriseTask] = {}


def register_custom_task(
    domain: str,
    user_prompt: str,
    all_tools: list[str] | None = None,
) -> EnterpriseTask:
    """Create + register an ephemeral in-process task from a user-typed
    query. Returns the new task. Raises KeyError if the domain has no
    oracle template to inherit gym wiring from.

    Pass ``all_tools`` (typically the full live MCP catalog fetched by
    the API layer) to enable every available tool by default. If
    omitted, falls back to the UNION of every oracle task's tools in
    the domain — usually a close approximation of the full catalog and
    purely synchronous. Verifiers are empty (no ground-truth)."""
    user_prompt = (user_prompt or "").strip()
    if not user_prompt:
        raise ValueError("user_prompt is required")
    domain_tasks = [t for t in _load_all().values() if t.domain == domain]
    if not domain_tasks:
        raise KeyError(f"No template task available for domain {domain!r}")
    template = domain_tasks[0]
    if all_tools is None:
        all_tools = []
        seen: set[str] = set()
        for t in domain_tasks:
            for name in t.default_tools:
                if name not in seen:
                    seen.add(name)
                    all_tools.append(name)
    tid = f"custom.{domain}.{_uuid.uuid4().hex[:8]}"
    title = _synthesize_title(user_prompt, fallback="Custom query") or "Custom query"
    task = EnterpriseTask(
        id=tid,
        title=title,
        summary=_synthesize_summary(user_prompt),
        domain=domain,
        user_prompt=user_prompt,
        system_prompt=template.system_prompt,
        seed_sql_path=template.seed_sql_path,
        default_tools=all_tools,
        context=dict(template.context),
        verifiers=(),
        featured=False,
        source="custom",
    )
    _CUSTOM_TASKS[tid] = task
    return task


def task_count_by_domain() -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in _load_all().values():
        counts[t.domain] = counts.get(t.domain, 0) + 1
    return counts
