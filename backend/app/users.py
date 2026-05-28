"""Server-side user store backing the Google Sign-In flow.

Lives next to the existing ``mas_refine/`` analytics + trajectory
stores so the offline refinement pipeline can JOIN on ``user_sub``
without crossing service boundaries.

Trust model
-----------
The HTTP edge of this module is intentionally minimal — for the demo
we trust the *client* to send ``user_sub`` on scoped requests
(history list, trajectory annotations, feedback, share creation).
This is fine because:

* The data we scope is non-sensitive — anyone can already replay any
  share by ID, and trajectory annotations are research artifacts.
* It avoids forcing a long-lived session/cookie infrastructure
  (which the user explicitly skipped — see chat history for the
  conversation around #2: session/cookie).

If/when the demo grows real user-private data, every endpoint that
accepts ``user_sub`` should be upgraded to authenticate the caller
(e.g. require the original Google ID token in an ``Authorization:
Bearer`` header and re-verify it via ``google-auth`` on each call).
A ``TODO(auth-hardening):`` marker has been placed at each such site
so the upgrade is easy to find.
"""
from __future__ import annotations

import csv
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

MAS_REFINE_DIR = Path("/export/xgen-finance/meta_agent/mas_refine")
USERS_DB = MAS_REFINE_DIR / "users.db"
# CSV mirror of users.db so the dev team can ``less``/``open`` the
# user list directly. The DB is authoritative (UPSERT) — the CSV is
# a snapshot rewritten after every login. Cheap until the user count
# grows into the thousands; trivial to swap for an append-log if so.
USERS_CSV = MAS_REFINE_DIR / "users.csv"
# Mirror CSV for the ``hidden_shares`` table — same DB-as-truth, CSV-as-
# convenience pattern as ``USERS_CSV``. Rewritten after every hide so
# the dev team can ``less`` it directly.
HIDDEN_SHARES_CSV = MAS_REFINE_DIR / "hidden_shares.csv"

# Column order for the CSV snapshot. Epoch timestamps from the DB are
# converted to ISO 8601 alongside the raw seconds for easy reading in
# a spreadsheet. Keep this ordering stable — when it changes we
# rotate the previous CSV to a ``.legacy-<ts>.csv`` backup so old
# scrapers don't silently break.
_USERS_CSV_HEADER = [
    "sub",
    "email",
    "name",
    "given_name",
    "picture",
    "created_at",            # ISO 8601 string (UTC offset)
    "created_at_epoch",      # raw float, easy to sort
    "last_seen",             # ISO 8601 string
    "last_seen_epoch",
    "login_count",
    "last_ip",
    "last_user_agent",
]

# Mirror CSV layout for hidden_shares — kept tiny on purpose so even a
# small DB cap (~10k shares) never blows up the file.
_HIDDEN_SHARES_CSV_HEADER = [
    "user_sub",
    "share_id",
    "hidden_at",        # ISO 8601
    "hidden_at_epoch",  # raw float
]

# One lock guards schema init AND the (upsert → csv-dump) sequence so
# two concurrent logins don't race the CSV rewrite. SQLite already
# serializes its own writes, but the CSV file does not.
_lock = threading.Lock()
_initialized = False


def _ensure_user_store() -> None:
    """Idempotent schema + CSV bootstrap. Safe (and cheap) to call on
    every request — the first call creates the table and seeds an
    empty CSV header, the rest no-op."""
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        MAS_REFINE_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(USERS_DB)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    sub             TEXT PRIMARY KEY,
                    email           TEXT,
                    name            TEXT,
                    given_name      TEXT,
                    picture         TEXT,
                    created_at      REAL NOT NULL,
                    last_seen       REAL NOT NULL,
                    login_count     INTEGER NOT NULL DEFAULT 0,
                    last_ip         TEXT,
                    last_user_agent TEXT
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_users_email ON users(email)"
            )
            # Per-user "hide from Recents" list — backend-side so a hide
            # persists across browsers and localStorage wipes (the user
            # was explicit about this). The actual share file under
            # ``backend/data/shares/<id>.json`` is left untouched so a
            # future trash-bin UI can still surface them.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hidden_shares (
                    user_sub  TEXT NOT NULL,
                    share_id  TEXT NOT NULL,
                    hidden_at REAL NOT NULL,
                    PRIMARY KEY(user_sub, share_id)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_hidden_shares_user "
                "ON hidden_shares(user_sub)"
            )
            conn.commit()

            _ensure_users_csv_header()
            _ensure_hidden_shares_csv_header()
            # Always regenerate the CSVs from the DB on bootstrap so the
            # two views stay in sync — even if the CSV picked up stale
            # rows externally (e.g. someone restored a backup). An
            # empty DB simply yields a header-only CSV.
            _dump_users_csv_unlocked(conn)
            _dump_hidden_shares_csv_unlocked(conn)
        finally:
            conn.close()
        _initialized = True


def _ensure_users_csv_header() -> None:
    """Create users.csv with the current header, or rotate the old
    file to a timestamped backup if the on-disk header has drifted
    from ``_USERS_CSV_HEADER`` (e.g. we added a column)."""
    if not USERS_CSV.exists():
        with USERS_CSV.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(_USERS_CSV_HEADER)
        return
    try:
        with USERS_CSV.open("r", newline="", encoding="utf-8") as f:
            existing = next(csv.reader(f), [])
    except (OSError, StopIteration):
        existing = []
    if existing != _USERS_CSV_HEADER:
        backup = USERS_CSV.with_suffix(
            f".legacy-{time.strftime('%Y%m%dT%H%M%S')}.csv"
        )
        try:
            USERS_CSV.rename(backup)
        except OSError:
            pass
        with USERS_CSV.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(_USERS_CSV_HEADER)


def _dump_users_csv_unlocked(conn: sqlite3.Connection) -> None:
    """Re-write users.csv from the DB. Caller must hold ``_lock``.

    Atomic via ``write to .tmp → rename`` so a concurrent reader
    never sees a partially-written file.
    """
    rows = conn.execute(
        "SELECT sub, email, name, given_name, picture, "
        "created_at, last_seen, login_count, last_ip, last_user_agent "
        "FROM users ORDER BY created_at ASC"
    ).fetchall()
    tmp = USERS_CSV.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(_USERS_CSV_HEADER)
        for r in rows:
            sub, email, name, given_name, picture, created, seen, count, ip, ua = r
            w.writerow([
                sub,
                email or "",
                name or "",
                given_name or "",
                picture or "",
                _iso(created),
                created if created is not None else "",
                _iso(seen),
                seen if seen is not None else "",
                int(count) if count is not None else 0,
                ip or "",
                ua or "",
            ])
    tmp.replace(USERS_CSV)


def _ensure_hidden_shares_csv_header() -> None:
    """Same header-rotation logic as ``_ensure_users_csv_header`` —
    keeps stale on-disk schemas from silently corrupting new rows."""
    if not HIDDEN_SHARES_CSV.exists():
        with HIDDEN_SHARES_CSV.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(_HIDDEN_SHARES_CSV_HEADER)
        return
    try:
        with HIDDEN_SHARES_CSV.open("r", newline="", encoding="utf-8") as f:
            existing = next(csv.reader(f), [])
    except (OSError, StopIteration):
        existing = []
    if existing != _HIDDEN_SHARES_CSV_HEADER:
        backup = HIDDEN_SHARES_CSV.with_suffix(
            f".legacy-{time.strftime('%Y%m%dT%H%M%S')}.csv"
        )
        try:
            HIDDEN_SHARES_CSV.rename(backup)
        except OSError:
            pass
        with HIDDEN_SHARES_CSV.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(_HIDDEN_SHARES_CSV_HEADER)


def _dump_hidden_shares_csv_unlocked(conn: sqlite3.Connection) -> None:
    """Re-write hidden_shares.csv from the DB. Caller must hold ``_lock``.
    Atomic via ``write to .tmp → rename``."""
    rows = conn.execute(
        "SELECT user_sub, share_id, hidden_at FROM hidden_shares "
        "ORDER BY hidden_at ASC"
    ).fetchall()
    tmp = HIDDEN_SHARES_CSV.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(_HIDDEN_SHARES_CSV_HEADER)
        for r in rows:
            sub, share_id, hidden_at = r
            w.writerow([
                sub,
                share_id,
                _iso(hidden_at),
                hidden_at if hidden_at is not None else "",
            ])
    tmp.replace(HIDDEN_SHARES_CSV)


def _iso(epoch: float | None) -> str:
    if epoch is None:
        return ""
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(float(epoch)))
    except (TypeError, ValueError):
        return ""


def upsert_user(profile: dict[str, Any], ip: str = "", user_agent: str = "") -> dict[str, Any]:
    """Record a successful login.

    ``profile`` is the dict returned by ``id_token.verify_oauth2_token``
    (we only persist a small public subset of it). For brand-new users
    we INSERT, for returning users we refresh ``name`` / ``picture`` /
    ``email`` (Google profile fields can change) and bump
    ``last_seen`` + ``login_count``.

    Returns the up-to-date stored row so the auth endpoint can return
    a stable shape regardless of insert-vs-update.
    """
    _ensure_user_store()
    sub = (profile.get("sub") or "").strip()
    if not sub:
        raise ValueError("upsert_user: profile.sub is required")
    now = time.time()
    email = profile.get("email")
    name = profile.get("name") or profile.get("email") or "Google user"
    given_name = profile.get("given_name")
    picture = profile.get("picture")

    # Hold the lock across the UPSERT + CSV redump so the two views
    # stay in sync even under concurrent logins. SQLite serializes
    # its own writers; we only need the lock for the CSV portion,
    # but it's cheaper to take it once.
    with _lock:
        conn = sqlite3.connect(USERS_DB)
        try:
            # SQLite's UPSERT (``ON CONFLICT``) lets us keep ``created_at``
            # immutable while still updating mutable fields. ``login_count``
            # increments atomically so we don't lose concurrent logins.
            conn.execute(
                """
                INSERT INTO users (
                    sub, email, name, given_name, picture,
                    created_at, last_seen, login_count,
                    last_ip, last_user_agent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(sub) DO UPDATE SET
                    email           = COALESCE(excluded.email, users.email),
                    name            = COALESCE(excluded.name, users.name),
                    given_name      = COALESCE(excluded.given_name, users.given_name),
                    picture         = COALESCE(excluded.picture, users.picture),
                    last_seen       = excluded.last_seen,
                    login_count     = users.login_count + 1,
                    last_ip         = COALESCE(excluded.last_ip, users.last_ip),
                    last_user_agent = COALESCE(excluded.last_user_agent, users.last_user_agent)
                """,
                (sub, email, name, given_name, picture, now, now, ip or None, user_agent or None),
            )
            conn.commit()
            row = conn.execute(
                "SELECT sub, email, name, given_name, picture, created_at, last_seen, login_count "
                "FROM users WHERE sub = ?",
                (sub,),
            ).fetchone()
            # Rewrite users.csv from the DB so an external inspector
            # never has to JOIN anything to read the current state.
            try:
                _dump_users_csv_unlocked(conn)
            except OSError:
                # CSV mirror is a convenience — never fail a login
                # because the filesystem is full / read-only.
                pass
        finally:
            conn.close()
    if row is None:
        # Should never happen given we just inserted, but be defensive.
        return {"sub": sub, "email": email, "name": name, "picture": picture}
    keys = ("sub", "email", "name", "given_name", "picture", "created_at", "last_seen", "login_count")
    return dict(zip(keys, row))


def get_user(sub: str) -> dict[str, Any] | None:
    """Return the stored profile for ``sub`` or ``None`` if unknown."""
    if not sub:
        return None
    _ensure_user_store()
    conn = sqlite3.connect(USERS_DB)
    try:
        row = conn.execute(
            "SELECT sub, email, name, given_name, picture, created_at, last_seen, login_count "
            "FROM users WHERE sub = ?",
            (sub,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    keys = ("sub", "email", "name", "given_name", "picture", "created_at", "last_seen", "login_count")
    return dict(zip(keys, row))


def hide_share(sub: str, share_id: str) -> bool:
    """Mark ``share_id`` as hidden from ``sub``'s Recents rail.

    Idempotent — re-hiding an already-hidden share is a no-op (the
    ``PRIMARY KEY(user_sub, share_id)`` constraint silently absorbs
    the duplicate via ``OR IGNORE``). Returns True on success, False
    on missing args (caller's input validation).

    NB: this is per-user, not global — different users hiding the same
    share don't affect each other.
    """
    if not sub or not share_id:
        return False
    _ensure_user_store()
    now = time.time()
    with _lock:
        conn = sqlite3.connect(USERS_DB)
        try:
            conn.execute(
                "INSERT OR IGNORE INTO hidden_shares (user_sub, share_id, hidden_at) "
                "VALUES (?, ?, ?)",
                (sub, share_id, now),
            )
            conn.commit()
            try:
                _dump_hidden_shares_csv_unlocked(conn)
            except OSError:
                pass
        finally:
            conn.close()
    return True


def unhide_share(sub: str, share_id: str) -> bool:
    """Restore a previously-hidden share (for a future trash-bin UI).
    Idempotent — unhiding a share that was never hidden is a no-op."""
    if not sub or not share_id:
        return False
    _ensure_user_store()
    with _lock:
        conn = sqlite3.connect(USERS_DB)
        try:
            conn.execute(
                "DELETE FROM hidden_shares WHERE user_sub = ? AND share_id = ?",
                (sub, share_id),
            )
            conn.commit()
            try:
                _dump_hidden_shares_csv_unlocked(conn)
            except OSError:
                pass
        finally:
            conn.close()
    return True


def list_hidden_shares(sub: str) -> set[str]:
    """Return the set of share ids ``sub`` has hidden from their
    Recents rail. Used by the share-list endpoint to filter rows
    server-side so hides survive browser switches / localStorage
    wipes (the explicit requirement from the chat).

    Returns an empty set on any error so a transient DB issue
    degrades gracefully (the user sees the unfiltered list, not
    an HTTP 500)."""
    if not sub:
        return set()
    try:
        _ensure_user_store()
    except (sqlite3.OperationalError, OSError):
        return set()
    try:
        conn = sqlite3.connect(USERS_DB)
    except sqlite3.OperationalError:
        return set()
    try:
        rows = conn.execute(
            "SELECT share_id FROM hidden_shares WHERE user_sub = ?",
            (sub,),
        ).fetchall()
    except sqlite3.OperationalError:
        # Table might not exist yet on legacy DBs from before the
        # hidden_shares migration. ``_ensure_user_store`` above creates
        # it via ``CREATE TABLE IF NOT EXISTS`` so this is mostly
        # belt-and-braces; we still degrade gracefully if SQLite
        # surprises us.
        return set()
    finally:
        conn.close()
    return {str(r[0]) for r in rows if r and r[0]}


def count_trajectory_annotations(sub: str, trajectories_db_path: Path) -> int:
    """How many ratings has this user submitted? Resolved via the same
    ``user_sub`` column we add to ``trajectories``. Returns 0 on any
    error so the auth endpoint never fails because of a missing
    column."""
    if not sub:
        return 0
    try:
        conn = sqlite3.connect(trajectories_db_path)
    except sqlite3.OperationalError:
        return 0
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM trajectories WHERE user_sub = ?",
            (sub,),
        ).fetchone()
        return int(row[0]) if row else 0
    except sqlite3.OperationalError:
        # Table not yet created or user_sub column missing on legacy DBs.
        return 0
    finally:
        conn.close()
