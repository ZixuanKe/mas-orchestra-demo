"""Per-domain MCP gym registry.

Each gym is a Dockerized EnterpriseOps MCP server running on this host. The
demo connects to the gym over the container's internal IP (the public host
ports are not reachable from inside the demo's sandboxed shell). To add a new
domain, list it here.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GymInfo:
    name: str            # domain key surfaced to the UI (e.g. "calendar")
    label: str           # human label
    container: str       # docker container name (for diagnostics only)
    url: str             # base URL the demo backend hits
    icon: str            # short symbol/emoji for the UI badge
    summary: str         # one-line UI description


# Container IPs resolved via `docker inspect`. They are stable as long as the
# containers aren't recreated; if they move, update here or look them up
# dynamically at startup.
GYMS: dict[str, GymInfo] = {
    # Calendar MCP serves directly on its exposed port 8003.
    "calendar": GymInfo(
        name="calendar",
        label="Calendar",
        container="gym-calendar",
        url="http://169.254.123.2:8003",
        icon="📅",
        summary="Schedule events, manage calendars, share access (Google Calendar–style).",
    ),
    # All other gyms expose the MCP server on internal port 8005 (their
    # 8001..8009 externally-mapped ports serve a different /api surface).
    # Verified reachable from the demo backend via the docker bridge IPs.
    "email": GymInfo(
        name="email", label="Email", container="gym-email",
        url="http://169.254.123.5:8005", icon="✉️",
        summary="Compose, label, filter, and manage messages (Gmail-style).",
    ),
    "hr": GymInfo(
        name="hr", label="HR", container="gym-hr",
        url="http://169.254.123.6:8005", icon="👥",
        summary="Manage HR cases, services, skills, and knowledge base.",
    ),
    "itsm": GymInfo(
        name="itsm", label="ITSM", container="gym-itsm",
        url="http://169.254.123.7:8005", icon="🛠️",
        summary="Resolve incidents, change requests, problems, and services.",
    ),
    "teams": GymInfo(
        name="teams", label="Teams", container="gym-teams",
        url="http://169.254.123.8:8005", icon="💬",
        summary="Channels, chats, meetings, members, and recordings.",
    ),
    "csm": GymInfo(
        name="csm", label="CSM", container="gym-csm",
        url="http://169.254.123.3:8005", icon="🤝",
        summary="Customer cases, accounts, contacts, contracts, and entitlements.",
    ),
    "drive": GymInfo(
        name="drive", label="Drive", container="gym-drive",
        url="http://169.254.123.4:8005", icon="📂",
        summary="Files, folders, shared drives, permissions, and comments.",
    ),
}


def list_gyms() -> list[dict]:
    return [
        {
            "name": g.name,
            "label": g.label,
            "icon": g.icon,
            "summary": g.summary,
        }
        for g in GYMS.values()
    ]


def get_gym(name: str) -> GymInfo:
    if name not in GYMS:
        raise KeyError(f"Unknown enterprise domain: {name!r}")
    return GYMS[name]
