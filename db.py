"""SQLite database layer for GOTracker++ with cookie-backed multi-user profiles."""

import hashlib
import json
import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from config import DB_PATH, MINOR_DELAY_SEC, TORONTO_TZ, now_toronto, today_service_date


def _default_settings() -> dict[str, Any]:
    return {
        "route": {
            "home_corridor": "ST",
            "home_station": "AG",
            "dest_corridor": "ST",
            "dest_station": "UN",
        },
        "rules": [
            {
                "id": "morning-in",
                "name": "Morning to Union",
                "enabled": True,
                "days": [0, 1, 2, 3, 4],
                "start": "06:30",
                "end": "09:30",
                "direction": "home_to_dest",
            },
            {
                "id": "evening-out",
                "name": "Evening from Union",
                "enabled": True,
                "days": [0, 1, 2, 3, 4],
                "start": "16:00",
                "end": "19:30",
                "direction": "dest_to_home",
            },
        ],
        "alert_prefs": {
            "platform_announced": True,
            "platform_changed": True,
            "boarding_proceed": True,
            "delay_threshold_min": 3,
            "delay_change_step_min": 3,
            "cancelled": True,
            "short_train": True,
            "lead_window_min": 90,
        },
        "channels": {
            "web_push_enabled": True,
            "ntfy_server": "https://ntfy.sh",
            "ntfy_topic": "",
            "webhook_url": "",
        },
        "location_state": {
            "mode": "auto",
            "override_direction": None,
            "zone": None,
            "updated_at": None,
            "expires_at": None,
            "webhook_token": secrets.token_urlsafe(18),
        },
    }


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _snapshot_state_key(row: dict[str, Any]) -> tuple[Any, ...]:
    d_sec = int(row.get("delay_sec") or 0)
    # Bucket sub-30s prediction jitter while always splitting across the On-Time threshold
    d_bucket = round(d_sec / 30.0)
    is_late_minor = 1 if d_sec >= MINOR_DELAY_SEC else 0
    return (
        d_bucket,
        is_late_minor,
        str(row.get("platform") or "-").strip() or "-",
        str(row.get("sch_track") or "").strip(),
        str(row.get("info_status") or "").strip(),
        1 if row.get("is_cancelled") else 0,
        row.get("coach_count"),
        row.get("scheduled_coach_count"),
    )


def _is_default_guest_settings(settings: dict[str, Any]) -> bool:
    defaults = _default_settings()
    if settings.get("route") != defaults["route"]:
        return False
    ch = settings.get("channels") or {}
    if (ch.get("ntfy_topic") or "").strip() or (ch.get("webhook_url") or "").strip():
        return False
    loc = settings.get("location_state") or {}
    if loc.get("override_direction"):
        return False
    if settings.get("alert_prefs") != defaults["alert_prefs"]:
        return False
    if settings.get("rules") != defaults["rules"]:
        return False
    return True


class Database:
    """Thread/async-safe SQLite repository using WAL mode."""

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn

    def _init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS catalog_cache (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    payload_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT 'Commuter',
                    email TEXT UNIQUE,
                    password_hash TEXT,
                    auth_provider TEXT NOT NULL DEFAULT 'anonymous',
                    auth_subject TEXT,
                    is_legacy_unclaimed INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_subject
                    ON users (auth_provider, auth_subject)
                    WHERE auth_subject IS NOT NULL;

                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    user_agent TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_user
                    ON sessions (user_id);

                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    key TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, key)
                );

                CREATE TABLE IF NOT EXISTS link_codes (
                    code TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS push_subscriptions (
                    endpoint TEXT PRIMARY KEY,
                    user_id TEXT,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    user_agent TEXT,
                    created_at TEXT NOT NULL,
                    last_ok_at TEXT,
                    fail_count INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS trip_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    captured_at TEXT NOT NULL,
                    service_date TEXT NOT NULL,
                    corridor TEXT NOT NULL,
                    station_code TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    trip_number TEXT NOT NULL,
                    scheduled_time TEXT NOT NULL,
                    predicted_time TEXT,
                    delay_sec INTEGER DEFAULT 0,
                    platform TEXT,
                    sch_track TEXT,
                    info_status TEXT,
                    is_cancelled INTEGER DEFAULT 0,
                    is_express INTEGER DEFAULT 0,
                    coach_count INTEGER,
                    scheduled_coach_count INTEGER,
                    source TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_snapshots_trip
                    ON trip_snapshots (service_date, trip_number, captured_at);
                CREATE INDEX IF NOT EXISTS idx_snapshots_captured
                    ON trip_snapshots (captured_at);

                CREATE TABLE IF NOT EXISTS trip_outcomes (
                    service_date TEXT NOT NULL,
                    trip_number TEXT NOT NULL,
                    stop_code TEXT NOT NULL,
                    stop_name TEXT,
                    corridor TEXT,
                    direction TEXT,
                    scheduled_time TEXT,
                    actual_time TEXT,
                    delay_sec INTEGER,
                    sch_track TEXT,
                    act_track TEXT,
                    engine_id TEXT,
                    is_cancelled INTEGER DEFAULT 0,
                    first_platform_at TEXT,
                    platform_lead_sec INTEGER,
                    platform_changes INTEGER DEFAULT 0,
                    recorded_at TEXT NOT NULL,
                    PRIMARY KEY (service_date, trip_number, stop_code)
                );

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    user_id TEXT,
                    service_date TEXT NOT NULL,
                    trip_number TEXT,
                    corridor TEXT,
                    station_code TEXT,
                    direction TEXT,
                    event_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    notified INTEGER DEFAULT 0,
                    rule_matched TEXT,
                    channel_results_json TEXT,
                    payload_json TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_events_created
                    ON events (created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_events_dedup
                    ON events (service_date, trip_number, event_type);

                CREATE TABLE IF NOT EXISTS station_messages (
                    corridor TEXT NOT NULL,
                    station_code TEXT NOT NULL,
                    messages_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (corridor, station_code)
                );
                """
            )

            # Non-destructive column migrations for existing tables
            ps_cols = {r["name"] for r in conn.execute("PRAGMA table_info(push_subscriptions)").fetchall()}
            if "user_id" not in ps_cols:
                conn.execute("ALTER TABLE push_subscriptions ADD COLUMN user_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id)")

            ev_cols = {r["name"] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
            if "user_id" not in ev_cols:
                conn.execute("ALTER TABLE events ADD COLUMN user_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, created_at DESC)")

            snap_cols = {r["name"] for r in conn.execute("PRAGMA table_info(trip_snapshots)").fetchall()}
            if "last_seen_at" not in snap_cols:
                conn.execute("ALTER TABLE trip_snapshots ADD COLUMN last_seen_at TEXT")
                conn.execute("UPDATE trip_snapshots SET last_seen_at = captured_at WHERE last_seen_at IS NULL")
            if "sample_count" not in snap_cols:
                conn.execute("ALTER TABLE trip_snapshots ADD COLUMN sample_count INTEGER NOT NULL DEFAULT 1")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON trip_snapshots (service_date, trip_number, station_code, id DESC)"
            )

            # Recreate live_departures with canonical physical-leg PK if legacy schema has 'direction'
            ld_row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='live_departures'"
            ).fetchone()
            if ld_row and "direction" in ld_row["sql"]:
                conn.execute("DROP TABLE live_departures")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_departures (
                    service_date TEXT NOT NULL,
                    trip_number TEXT NOT NULL,
                    origin_code TEXT NOT NULL,
                    dest_code TEXT NOT NULL,
                    corridor TEXT NOT NULL,
                    scheduled_time TEXT NOT NULL,
                    predicted_time TEXT,
                    delay_sec INTEGER DEFAULT 0,
                    platform TEXT DEFAULT '-',
                    sch_track TEXT DEFAULT '',
                    info_status TEXT DEFAULT '',
                    is_cancelled INTEGER DEFAULT 0,
                    is_express INTEGER DEFAULT 0,
                    coach_count INTEGER,
                    scheduled_coach_count INTEGER,
                    stops_json TEXT,
                    remarks_json TEXT,
                    first_platform_at TEXT,
                    platform_changes INTEGER DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (service_date, trip_number, origin_code, dest_code)
                )
                """
            )

            # Preserve legacy global settings into an unclaimed legacy user on upgrade
            user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if user_count == 0:
                legacy_tbl = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
                ).fetchone()
                if legacy_tbl:
                    legacy_rows = conn.execute("SELECT key, value_json, updated_at FROM settings").fetchall()
                    if legacy_rows:
                        now_iso = now_toronto().isoformat()
                        legacy_id = "usr_legacy_0"
                        conn.execute(
                            """
                            INSERT INTO users (id, display_name, auth_provider, is_legacy_unclaimed, created_at, last_seen_at)
                            VALUES (?, 'Commuter', 'anonymous', 1, ?, ?)
                            """,
                            (legacy_id, now_iso, now_iso),
                        )
                        existing_keys = set()
                        for r in legacy_rows:
                            existing_keys.add(r["key"])
                            conn.execute(
                                """
                                INSERT OR IGNORE INTO user_settings (user_id, key, value_json, updated_at)
                                VALUES (?, ?, ?, ?)
                                """,
                                (legacy_id, r["key"], r["value_json"], r["updated_at"]),
                            )
                        for key, val in _default_settings().items():
                            if key not in existing_keys:
                                conn.execute(
                                    """
                                    INSERT OR IGNORE INTO user_settings (user_id, key, value_json, updated_at)
                                    VALUES (?, ?, ?, ?)
                                    """,
                                    (legacy_id, key, json.dumps(val), now_iso),
                                )
                        conn.execute(
                            "UPDATE push_subscriptions SET user_id = ? WHERE user_id IS NULL",
                            (legacy_id,),
                        )
                        conn.execute(
                            "UPDATE events SET user_id = ? WHERE user_id IS NULL",
                            (legacy_id,),
                        )

    # ---- Users & Cookie Sessions ----
    def create_user(
        self,
        display_name: str = "Commuter",
        auth_provider: str = "anonymous",
        email: str | None = None,
        auth_subject: str | None = None,
    ) -> dict[str, Any]:
        now_iso = now_toronto().isoformat()
        user_id = f"usr_{secrets.token_hex(8)}"
        defaults = _default_settings()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO users (id, display_name, email, auth_provider, auth_subject, is_legacy_unclaimed, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (user_id, display_name, email, auth_provider, auth_subject, now_iso, now_iso),
            )
            for key, val in defaults.items():
                conn.execute(
                    "INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
                    (user_id, key, json.dumps(val), now_iso),
                )
        return self.get_user(user_id)  # type: ignore[return-value]

    def claim_legacy_or_create_user(self) -> dict[str, Any]:
        now_iso = now_toronto().isoformat()
        with self.connect() as conn:
            cur = conn.execute(
                """
                UPDATE users SET is_legacy_unclaimed = 0, last_seen_at = ?
                WHERE id = 'usr_legacy_0' AND is_legacy_unclaimed = 1
                """,
                (now_iso,),
            )
            if cur.rowcount == 1:
                row = conn.execute("SELECT * FROM users WHERE id = 'usr_legacy_0'").fetchone()
                if row:
                    return dict(row)
        return self.create_user()

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return dict(row) if row else None

    def update_user_profile(self, user_id: str, display_name: str) -> dict[str, Any] | None:
        clean = (display_name or "").strip()[:48] or "Commuter"
        with self.connect() as conn:
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (clean, user_id))
        return self.get_user(user_id)

    def create_session(self, user_id: str, user_agent: str = "", ttl_days: int = 365) -> str:
        raw = secrets.token_urlsafe(32)
        thash = hash_token(raw)
        now = now_toronto()
        exp = now + timedelta(days=ttl_days)
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at, user_agent)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (thash, user_id, now.isoformat(), now.isoformat(), exp.isoformat(), user_agent[:240]),
            )
        return raw

    def resolve_session(self, raw_token: str | None) -> dict[str, Any] | None:
        if not raw_token:
            return None
        thash = hash_token(raw_token)
        now = now_toronto()
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT u.*, s.expires_at FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ?
                """,
                (thash,),
            ).fetchone()
            if not row:
                return None
            try:
                exp_dt = datetime.fromisoformat(row["expires_at"])
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=TORONTO_TZ)
                if now >= exp_dt:
                    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (thash,))
                    return None
            except Exception:
                return None

            now_iso = now.isoformat()
            conn.execute("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?", (now_iso, thash))
            conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now_iso, row["id"]))
            user = dict(row)
            user.pop("expires_at", None)
            return user

    def revoke_session(self, raw_token: str | None) -> None:
        if not raw_token:
            return
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(raw_token),))

    def revoke_other_devices(
        self,
        user_id: str,
        keep_token_hash: str | None = None,
        keep_endpoint: str | None = None,
    ) -> dict[str, int]:
        """Remove all other sessions, push subscriptions, and pending link codes tied strictly to user_id."""
        with self.connect() as conn:
            if keep_token_hash:
                sess_cur = conn.execute(
                    "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                    (user_id, keep_token_hash),
                )
            else:
                sess_cur = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

            if keep_endpoint:
                sub_cur = conn.execute(
                    "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint != ?",
                    (user_id, keep_endpoint),
                )
            else:
                sub_cur = conn.execute(
                    "DELETE FROM push_subscriptions WHERE user_id = ?",
                    (user_id,),
                )

            link_cur = conn.execute("DELETE FROM link_codes WHERE user_id = ?", (user_id,))
        return {
            "sessions_removed": int(sess_cur.rowcount or 0),
            "push_subs_removed": int(sub_cur.rowcount or 0),
            "link_codes_removed": int(link_cur.rowcount or 0),
        }

    def count_user_sessions(self, user_id: str) -> int:
        with self.connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM sessions WHERE user_id = ?", (user_id,)).fetchone()[0])

    def create_link_code(self, user_id: str, ttl_min: int = 10) -> tuple[str, str]:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        exp_iso = (now_toronto() + timedelta(minutes=ttl_min)).isoformat()
        with self.connect() as conn:
            conn.execute("DELETE FROM link_codes WHERE expires_at < ?", (now_toronto().isoformat(),))
            conn.execute(
                "INSERT OR REPLACE INTO link_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
                (code, user_id, exp_iso),
            )
        return code, exp_iso

    def consume_link_code(self, code: str) -> str | None:
        clean = (code or "").strip().upper()
        if not clean:
            return None
        now = now_toronto()
        with self.connect() as conn:
            row = conn.execute("SELECT user_id, expires_at FROM link_codes WHERE code = ?", (clean,)).fetchone()
            if not row:
                return None
            conn.execute("DELETE FROM link_codes WHERE code = ?", (clean,))
            try:
                exp_dt = datetime.fromisoformat(row["expires_at"])
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=TORONTO_TZ)
                if now >= exp_dt:
                    return None
            except Exception:
                return None
            return row["user_id"]

    # ---- Catalog ----
    def get_catalog(self) -> tuple[dict[str, Any] | None, str | None]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT payload_json, updated_at FROM catalog_cache WHERE id = 1"
            ).fetchone()
            if not row:
                return None, None
            return json.loads(row["payload_json"]), row["updated_at"]

    def save_catalog(self, payload: dict[str, Any]) -> None:
        now_iso = now_toronto().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO catalog_cache (id, payload_json, updated_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (json.dumps(payload), now_iso),
            )

    # ---- Per-User Settings ----
    def _merge_user_settings_rows(self, rows: list[sqlite3.Row]) -> dict[str, Any]:
        out = _default_settings()
        for row in rows:
            try:
                loaded = json.loads(row["value_json"])
                if isinstance(out.get(row["key"]), dict) and isinstance(loaded, dict):
                    merged = dict(out[row["key"]])
                    merged.update(loaded)
                    out[row["key"]] = merged
                else:
                    out[row["key"]] = loaded
            except Exception:
                pass
        return out

    def get_settings(self, user_id: str | None) -> dict[str, Any]:
        if not user_id:
            return _default_settings()
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT key, value_json FROM user_settings WHERE user_id = ?",
                (user_id,),
            ).fetchall()
            return self._merge_user_settings_rows(rows)

    def update_settings(self, user_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        now_iso = now_toronto().isoformat()
        current = self.get_settings(user_id)
        valid_keys = {"route", "rules", "alert_prefs", "channels", "location_state"}
        with self.connect() as conn:
            for key, val in updates.items():
                if key not in valid_keys:
                    continue
                if isinstance(current.get(key), dict) and isinstance(val, dict):
                    merged = dict(current[key])
                    merged.update(val)
                    new_val = merged
                else:
                    new_val = val
                conn.execute(
                    """
                    INSERT INTO user_settings (user_id, key, value_json, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET
                        value_json = excluded.value_json,
                        updated_at = excluded.updated_at
                    """,
                    (user_id, key, json.dumps(new_val), now_iso),
                )
        return self.get_settings(user_id)

    def find_user_by_webhook_token(self, token: str) -> str | None:
        if not token:
            return None
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT user_id, value_json FROM user_settings WHERE key = 'location_state'"
            ).fetchall()
            for r in rows:
                try:
                    loc = json.loads(r["value_json"])
                    if loc.get("webhook_token") == token:
                        return r["user_id"]
                except Exception:
                    pass
        return None

    def list_active_users_with_settings(self, active_days: int = 30) -> list[dict[str, Any]]:
        now = now_toronto()
        cutoff = (now - timedelta(days=active_days)).isoformat()
        recent_cutoff_dt = now - timedelta(hours=48)
        with self.connect() as conn:
            user_rows = conn.execute(
                """
                SELECT u.id, u.last_seen_at,
                       MAX(CASE WHEN ps.user_id IS NOT NULL THEN 1 ELSE 0 END) AS has_push
                FROM users u
                LEFT JOIN push_subscriptions ps ON ps.user_id = u.id
                WHERE u.last_seen_at >= ? OR ps.user_id IS NOT NULL
                GROUP BY u.id
                """,
                (cutoff,),
            ).fetchall()
            if not user_rows:
                return []

            uids = [r["id"] for r in user_rows]
            by_uid: dict[str, list[sqlite3.Row]] = {uid: [] for uid in uids}
            for i in range(0, len(uids), 500):
                chunk = uids[i : i + 500]
                placeholders = ",".join("?" for _ in chunk)
                s_rows = conn.execute(
                    f"SELECT user_id, key, value_json FROM user_settings WHERE user_id IN ({placeholders})",
                    tuple(chunk),
                ).fetchall()
                for sr in s_rows:
                    by_uid.setdefault(sr["user_id"], []).append(sr)

        result: list[dict[str, Any]] = []
        for ur in user_rows:
            uid = ur["id"]
            has_push = bool(ur["has_push"])
            settings = self._merge_user_settings_rows(by_uid.get(uid, []))
            ch = settings.get("channels") or {}
            loc = settings.get("location_state") or {}
            has_override = False
            if loc.get("override_direction") and loc.get("expires_at"):
                try:
                    exp_dt = datetime.fromisoformat(loc["expires_at"])
                    if exp_dt.tzinfo is None:
                        exp_dt = exp_dt.replace(tzinfo=TORONTO_TZ)
                    has_override = now < exp_dt
                except Exception:
                    has_override = False
            has_target = bool(
                has_push
                or (ch.get("ntfy_topic") or "").strip()
                or (ch.get("webhook_url") or "").strip()
                or has_override
            )
            recent_browser = False
            try:
                seen_dt = datetime.fromisoformat(ur["last_seen_at"])
                if seen_dt.tzinfo is None:
                    seen_dt = seen_dt.replace(tzinfo=TORONTO_TZ)
                recent_browser = seen_dt >= recent_cutoff_dt
            except Exception:
                recent_browser = False

            result.append(
                {
                    "user_id": uid,
                    "settings": settings,
                    "has_push": has_push,
                    "has_notification_target": has_target,
                    "has_custom_settings": not _is_default_guest_settings(settings),
                    "recent_browser": recent_browser,
                }
            )
        return result

    # ---- Push Subscriptions ----
    def save_push_subscription(
        self,
        user_id: str,
        endpoint: str,
        p256dh: str,
        auth: str,
        user_agent: str = "",
    ) -> None:
        now_iso = now_toronto().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at, fail_count)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(endpoint) DO UPDATE SET
                    user_id = excluded.user_id,
                    p256dh = excluded.p256dh,
                    auth = excluded.auth,
                    user_agent = excluded.user_agent,
                    fail_count = 0
                """,
                (endpoint, user_id, p256dh, auth, user_agent, now_iso),
            )

    def delete_push_subscription(self, endpoint: str, user_id: str | None = None) -> None:
        with self.connect() as conn:
            if user_id:
                conn.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
                    (endpoint, user_id),
                )
            else:
                conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))

    def list_push_subscriptions(self, user_id: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if user_id:
                rows = conn.execute(
                    "SELECT endpoint, user_id, p256dh, auth, user_agent, created_at, last_ok_at, fail_count FROM push_subscriptions WHERE user_id = ?",
                    (user_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT endpoint, user_id, p256dh, auth, user_agent, created_at, last_ok_at, fail_count FROM push_subscriptions"
                ).fetchall()
            return [dict(r) for r in rows]

    def mark_push_result(self, endpoint: str, ok: bool) -> None:
        now_iso = now_toronto().isoformat()
        with self.connect() as conn:
            if ok:
                conn.execute(
                    "UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?",
                    (now_iso, endpoint),
                )
            else:
                conn.execute(
                    "UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?",
                    (endpoint,),
                )

    # ---- Canonical Live Departures ----
    def get_live_departures_map(self, service_date: str) -> dict[tuple[str, str, str, str], dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM live_departures WHERE service_date = ?",
                (service_date,),
            ).fetchall()
            result = {}
            for r in rows:
                d = dict(r)
                key = (d["service_date"], d["trip_number"], d["origin_code"], d["dest_code"])
                result[key] = d
            return result

    def get_live_departures(self, service_date: str | None = None) -> list[dict[str, Any]]:
        sdate = service_date or today_service_date()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM live_departures
                WHERE service_date = ?
                ORDER BY scheduled_time ASC, trip_number ASC
                """,
                (sdate,),
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["stops"] = json.loads(d.pop("stops_json") or "[]")
                d["remarks"] = json.loads(d.pop("remarks_json") or "[]")
                d["is_cancelled"] = bool(d["is_cancelled"])
                d["is_express"] = bool(d["is_express"])
                out.append(d)
            return out

    def get_live_departures_for_route(
        self,
        route: dict[str, Any],
        service_date: str | None = None,
    ) -> list[dict[str, Any]]:
        sdate = service_date or today_service_date()
        h_code = route.get("home_station", "AG")
        d_code = route.get("dest_station", "UN")
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM live_departures
                WHERE service_date = ?
                  AND ((origin_code = ? AND dest_code = ?) OR (origin_code = ? AND dest_code = ?))
                ORDER BY scheduled_time ASC, trip_number ASC
                """,
                (sdate, h_code, d_code, d_code, h_code),
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["stops"] = json.loads(d.pop("stops_json") or "[]")
                d["remarks"] = json.loads(d.pop("remarks_json") or "[]")
                d["is_cancelled"] = bool(d["is_cancelled"])
                d["is_express"] = bool(d["is_express"])
                d["direction"] = (
                    "home_to_dest"
                    if (d["origin_code"] == h_code and d["dest_code"] == d_code)
                    else "dest_to_home"
                )
                out.append(d)
            return out

    def upsert_live_departure(self, row: dict[str, Any]) -> None:
        now_iso = now_toronto().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO live_departures (
                    service_date, trip_number, origin_code, dest_code,
                    corridor, scheduled_time, predicted_time, delay_sec, platform,
                    sch_track, info_status, is_cancelled, is_express, coach_count,
                    scheduled_coach_count, stops_json, remarks_json,
                    first_platform_at, platform_changes, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(service_date, trip_number, origin_code, dest_code) DO UPDATE SET
                    corridor = excluded.corridor,
                    scheduled_time = excluded.scheduled_time,
                    predicted_time = excluded.predicted_time,
                    delay_sec = excluded.delay_sec,
                    platform = excluded.platform,
                    sch_track = CASE
                        WHEN excluded.sch_track != '' THEN excluded.sch_track
                        ELSE live_departures.sch_track
                    END,
                    info_status = excluded.info_status,
                    is_cancelled = excluded.is_cancelled,
                    is_express = excluded.is_express,
                    coach_count = COALESCE(excluded.coach_count, live_departures.coach_count),
                    scheduled_coach_count = COALESCE(excluded.scheduled_coach_count, live_departures.scheduled_coach_count),
                    stops_json = excluded.stops_json,
                    remarks_json = excluded.remarks_json,
                    first_platform_at = COALESCE(live_departures.first_platform_at, excluded.first_platform_at),
                    platform_changes = excluded.platform_changes,
                    updated_at = excluded.updated_at
                """,
                (
                    row["service_date"],
                    row["trip_number"],
                    row["origin_code"],
                    row["dest_code"],
                    row["corridor"],
                    row["scheduled_time"],
                    row.get("predicted_time"),
                    row.get("delay_sec", 0),
                    row.get("platform", "-"),
                    row.get("sch_track", ""),
                    row.get("info_status", ""),
                    1 if row.get("is_cancelled") else 0,
                    1 if row.get("is_express") else 0,
                    row.get("coach_count"),
                    row.get("scheduled_coach_count"),
                    json.dumps(row.get("stops", [])),
                    json.dumps(row.get("remarks", [])),
                    row.get("first_platform_at"),
                    row.get("platform_changes", 0),
                    now_iso,
                ),
            )

    def prune_stale_live_departures(self, keep_since_date: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "DELETE FROM live_departures WHERE service_date < ?",
                (keep_since_date,),
            )

    # ---- Station Messages ----
    def save_station_messages(self, corridor: str, station_code: str, messages: list[str]) -> None:
        now_iso = now_toronto().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO station_messages (corridor, station_code, messages_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(corridor, station_code) DO UPDATE SET
                    messages_json = excluded.messages_json,
                    updated_at = excluded.updated_at
                """,
                (corridor, station_code, json.dumps(messages), now_iso),
            )

    def get_station_messages(self, corridor: str, station_code: str) -> list[str]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT messages_json FROM station_messages WHERE corridor = ? AND station_code = ?",
                (corridor, station_code),
            ).fetchone()
            if not row:
                return []
            return json.loads(row["messages_json"])

    # ---- Snapshots, Outcomes, Events ----
    def record_snapshot(self, snap: dict[str, Any]) -> tuple[str, int]:
        """Insert a snapshot or coalesce into the latest interval if state is unchanged."""
        cap_ts = snap.get("captured_at") or now_toronto().isoformat()
        last_ts = snap.get("last_seen_at") or cap_ts
        new_key = _snapshot_state_key(snap)

        with self.connect() as conn:
            latest = conn.execute(
                """
                SELECT id, predicted_time, delay_sec, platform, sch_track, info_status,
                       is_cancelled, coach_count, scheduled_coach_count, last_seen_at
                FROM trip_snapshots
                WHERE service_date = ? AND trip_number = ? AND station_code = ?
                ORDER BY id DESC LIMIT 1
                """,
                (snap["service_date"], snap["trip_number"], snap["station_code"]),
            ).fetchone()

            if latest and _snapshot_state_key(dict(latest)) == new_key:
                prev_last = latest["last_seen_at"] or ""
                merged_last = last_ts if last_ts >= prev_last else prev_last
                conn.execute(
                    """
                    UPDATE trip_snapshots
                    SET last_seen_at = ?, sample_count = COALESCE(sample_count, 1) + 1
                    WHERE id = ?
                    """,
                    (merged_last, latest["id"]),
                )
                return "coalesced", int(latest["id"])

            cur = conn.execute(
                """
                INSERT INTO trip_snapshots (
                    captured_at, last_seen_at, sample_count, service_date, corridor, station_code,
                    direction, trip_number, scheduled_time, predicted_time, delay_sec,
                    platform, sch_track, info_status, is_cancelled, is_express,
                    coach_count, scheduled_coach_count, source
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    cap_ts,
                    last_ts,
                    int(snap.get("sample_count", 1)),
                    snap["service_date"],
                    snap["corridor"],
                    snap["station_code"],
                    snap["direction"],
                    snap["trip_number"],
                    snap["scheduled_time"],
                    snap.get("predicted_time"),
                    snap.get("delay_sec", 0),
                    snap.get("platform", "-"),
                    snap.get("sch_track", ""),
                    snap.get("info_status", ""),
                    1 if snap.get("is_cancelled") else 0,
                    1 if snap.get("is_express") else 0,
                    snap.get("coach_count"),
                    snap.get("scheduled_coach_count"),
                    snap.get("source", "poll"),
                ),
            )
            return "inserted", int(cur.lastrowid)

    def insert_snapshot(self, snap: dict[str, Any]) -> None:
        self.record_snapshot(snap)

    def compact_snapshots(
        self,
        max_age_days: int = 180,
        events_max_age_days: int = 60,
        guest_max_age_days: int = 7,
        vacuum: bool = False,
    ) -> dict[str, Any]:
        """Prune old snapshots/events/stale guests, merge consecutive identical-state snapshots, and truncate WAL."""
        now = now_toronto()
        now_iso = now.isoformat()
        cutoff = (now - timedelta(days=max_age_days)).strftime("%Y-%m-%d")
        ev_cutoff = (now - timedelta(days=events_max_age_days)).isoformat()
        guest_cutoff = (now - timedelta(days=guest_max_age_days)).isoformat()

        with self.connect() as conn:
            rows_before = int(conn.execute("SELECT COUNT(*) FROM trip_snapshots").fetchone()[0])
            del_cur = conn.execute("DELETE FROM trip_snapshots WHERE service_date < ?", (cutoff,))
            pruned_old_count = int(del_cur.rowcount or 0)

            rows = conn.execute(
                """
                SELECT id, captured_at, last_seen_at, sample_count, service_date, trip_number,
                       station_code, predicted_time, delay_sec, platform, sch_track,
                       info_status, is_cancelled, coach_count, scheduled_coach_count
                FROM trip_snapshots
                ORDER BY service_date ASC, trip_number ASC, station_code ASC, captured_at ASC, id ASC
                """
            ).fetchall()

            keep_id: int | None = None
            keep_group: tuple[str, str, str] | None = None
            keep_state: tuple[Any, ...] | None = None
            keep_last: str = ""
            keep_samples: int = 1
            dirty = False

            updates: list[tuple[str, int, int]] = []
            delete_ids: list[int] = []

            for r in rows:
                rd = dict(r)
                grp = (rd["service_date"], rd["trip_number"], rd["station_code"])
                st = _snapshot_state_key(rd)
                r_last = rd.get("last_seen_at") or rd["captured_at"]
                r_samples = int(rd.get("sample_count") or 1)

                if keep_id is not None and grp == keep_group and st == keep_state:
                    if r_last > keep_last:
                        keep_last = r_last
                    keep_samples += r_samples
                    delete_ids.append(int(rd["id"]))
                    dirty = True
                else:
                    if keep_id is not None and dirty:
                        updates.append((keep_last, keep_samples, keep_id))
                    keep_id = int(rd["id"])
                    keep_group = grp
                    keep_state = st
                    keep_last = r_last
                    keep_samples = r_samples
                    dirty = False

            if keep_id is not None and dirty:
                updates.append((keep_last, keep_samples, keep_id))

            if updates:
                conn.executemany(
                    "UPDATE trip_snapshots SET last_seen_at = ?, sample_count = ? WHERE id = ?",
                    updates,
                )
            for i in range(0, len(delete_ids), 500):
                chunk = delete_ids[i : i + 500]
                placeholders = ",".join("?" for _ in chunk)
                conn.execute(f"DELETE FROM trip_snapshots WHERE id IN ({placeholders})", chunk)

            rows_after = int(conn.execute("SELECT COUNT(*) FROM trip_snapshots").fetchone()[0])

            # Prune expired sessions/link codes, old events, stale default guests, and orphan rows
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_iso,))
            conn.execute("DELETE FROM link_codes WHERE expires_at < ?", (now_iso,))
            events_pruned = int(
                conn.execute("DELETE FROM events WHERE created_at < ?", (ev_cutoff,)).rowcount or 0
            )

            # Prune stale untouched guest users inactive >= guest_max_age_days
            cand_rows = conn.execute(
                """
                SELECT u.id FROM users u
                WHERE u.id != 'usr_legacy_0'
                  AND u.display_name = 'Commuter'
                  AND u.last_seen_at < ?
                  AND NOT EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)
                  AND NOT EXISTS (SELECT 1 FROM link_codes lc WHERE lc.user_id = u.id)
                  AND NOT EXISTS (
                      SELECT 1 FROM events e WHERE e.user_id = u.id
                      AND e.event_type IN ('test_notification', 'location_change')
                  )
                """,
                (guest_cutoff,),
            ).fetchall()
            prune_uids: list[str] = []
            if cand_rows:
                cand_ids = [r["id"] for r in cand_rows]
                settings_by_uid: dict[str, list[sqlite3.Row]] = {uid: [] for uid in cand_ids}
                for i in range(0, len(cand_ids), 500):
                    chunk = cand_ids[i : i + 500]
                    placeholders = ",".join("?" for _ in chunk)
                    for sr in conn.execute(
                        f"SELECT user_id, key, value_json FROM user_settings WHERE user_id IN ({placeholders})",
                        tuple(chunk),
                    ).fetchall():
                        settings_by_uid.setdefault(sr["user_id"], []).append(sr)
                for uid in cand_ids:
                    if _is_default_guest_settings(self._merge_user_settings_rows(settings_by_uid.get(uid, []))):
                        prune_uids.append(uid)

            users_pruned = 0
            for i in range(0, len(prune_uids), 500):
                chunk = prune_uids[i : i + 500]
                placeholders = ",".join("?" for _ in chunk)
                events_pruned += int(
                    conn.execute(f"DELETE FROM events WHERE user_id IN ({placeholders})", chunk).rowcount or 0
                )
                users_pruned += int(
                    conn.execute(f"DELETE FROM users WHERE id IN ({placeholders})", chunk).rowcount or 0
                )

            orphans_cleaned = 0
            orphans_cleaned += int(
                conn.execute("DELETE FROM user_settings WHERE user_id NOT IN (SELECT id FROM users)").rowcount or 0
            )
            orphans_cleaned += int(
                conn.execute("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)").rowcount or 0
            )
            orphans_cleaned += int(
                conn.execute(
                    """
                    DELETE FROM events
                    WHERE user_id IS NOT NULL
                      AND user_id != '__global__'
                      AND user_id NOT IN (SELECT id FROM users)
                      AND user_id NOT IN (SELECT user_id FROM push_subscriptions WHERE user_id IS NOT NULL)
                    """
                ).rowcount
                or 0
            )

        merged_count = len(delete_ids)
        total_cleaned = merged_count + pruned_old_count + events_pruned + users_pruned + orphans_cleaned
        maint_conn = sqlite3.connect(self.db_path, timeout=15.0, isolation_level=None)
        try:
            maint_conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            if vacuum or total_cleaned >= 50:
                maint_conn.execute("VACUUM;")
                maint_conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        finally:
            maint_conn.close()

        return {
            "rows_before": rows_before,
            "rows_after": rows_after,
            "merged_count": merged_count,
            "pruned_old_count": pruned_old_count,
            "events_pruned": events_pruned,
            "users_pruned": users_pruned,
            "orphans_cleaned": orphans_cleaned,
            "db_size_kb": self.get_db_size_kb(),
        }

    def get_db_size_kb(self) -> float:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.db_path) + suffix)
            if p.exists():
                total += p.stat().st_size
        return round(total / 1024.0, 1)

    def upsert_outcome(self, outcome: dict[str, Any]) -> None:
        now_iso = outcome.get("recorded_at") or now_toronto().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO trip_outcomes (
                    service_date, trip_number, stop_code, stop_name, corridor, direction,
                    scheduled_time, actual_time, delay_sec, sch_track, act_track,
                    engine_id, is_cancelled, first_platform_at, platform_lead_sec,
                    platform_changes, recorded_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(service_date, trip_number, stop_code) DO UPDATE SET
                    stop_name = COALESCE(excluded.stop_name, trip_outcomes.stop_name),
                    corridor = COALESCE(excluded.corridor, trip_outcomes.corridor),
                    direction = COALESCE(excluded.direction, trip_outcomes.direction),
                    scheduled_time = COALESCE(excluded.scheduled_time, trip_outcomes.scheduled_time),
                    actual_time = COALESCE(excluded.actual_time, trip_outcomes.actual_time),
                    delay_sec = COALESCE(excluded.delay_sec, trip_outcomes.delay_sec),
                    sch_track = CASE WHEN excluded.sch_track != '' THEN excluded.sch_track ELSE trip_outcomes.sch_track END,
                    act_track = CASE WHEN excluded.act_track != '' THEN excluded.act_track ELSE trip_outcomes.act_track END,
                    engine_id = COALESCE(excluded.engine_id, trip_outcomes.engine_id),
                    is_cancelled = excluded.is_cancelled,
                    first_platform_at = COALESCE(trip_outcomes.first_platform_at, excluded.first_platform_at),
                    platform_lead_sec = COALESCE(trip_outcomes.platform_lead_sec, excluded.platform_lead_sec),
                    platform_changes = MAX(trip_outcomes.platform_changes, excluded.platform_changes),
                    recorded_at = excluded.recorded_at
                """,
                (
                    outcome["service_date"],
                    outcome["trip_number"],
                    outcome["stop_code"],
                    outcome.get("stop_name"),
                    outcome.get("corridor"),
                    outcome.get("direction"),
                    outcome.get("scheduled_time"),
                    outcome.get("actual_time"),
                    outcome.get("delay_sec"),
                    outcome.get("sch_track", ""),
                    outcome.get("act_track", ""),
                    outcome.get("engine_id"),
                    1 if outcome.get("is_cancelled") else 0,
                    outcome.get("first_platform_at"),
                    outcome.get("platform_lead_sec"),
                    outcome.get("platform_changes", 0),
                    now_iso,
                ),
            )

    def has_outcome(self, service_date: str, trip_number: str, stop_code: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM trip_outcomes WHERE service_date = ? AND trip_number = ? AND stop_code = ?",
                (service_date, trip_number, stop_code),
            ).fetchone()
            return row is not None

    def insert_event(self, event: dict[str, Any]) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO events (
                    created_at, user_id, service_date, trip_number, corridor, station_code,
                    direction, event_type, title, body, notified, rule_matched,
                    channel_results_json, payload_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.get("created_at") or now_toronto().isoformat(),
                    event.get("user_id"),
                    event["service_date"],
                    event.get("trip_number"),
                    event.get("corridor"),
                    event.get("station_code"),
                    event.get("direction"),
                    event["event_type"],
                    event["title"],
                    event["body"],
                    1 if event.get("notified") else 0,
                    event.get("rule_matched"),
                    json.dumps(event.get("channel_results")) if event.get("channel_results") is not None else None,
                    json.dumps(event.get("payload")) if event.get("payload") is not None else None,
                ),
            )
            return int(cur.lastrowid)

    def has_recent_notified_event(
        self,
        user_id: str | None,
        service_date: str,
        trip_number: str,
        event_type: str,
        dedup_value: str | None = None,
    ) -> bool:
        with self.connect() as conn:
            if user_id:
                rows = conn.execute(
                    """
                    SELECT payload_json FROM events
                    WHERE user_id = ? AND service_date = ? AND trip_number = ? AND event_type = ? AND notified = 1
                    """,
                    (user_id, service_date, trip_number, event_type),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT payload_json FROM events
                    WHERE user_id IS NULL AND service_date = ? AND trip_number = ? AND event_type = ? AND notified = 1
                    """,
                    (service_date, trip_number, event_type),
                ).fetchall()
            if not rows:
                return False
            if dedup_value is None:
                return True
            for r in rows:
                if not r["payload_json"]:
                    continue
                try:
                    payload = json.loads(r["payload_json"])
                    if str(payload.get("dedup_key", "")) == str(dedup_value):
                        return True
                except Exception:
                    pass
            return False

    def has_global_event(
        self,
        service_date: str,
        trip_number: str,
        station_code: str,
        event_type: str,
        dedup_value: str | None = None,
    ) -> bool:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT payload_json FROM events
                WHERE user_id = '__global__' AND service_date = ? AND trip_number = ?
                  AND COALESCE(station_code, '') = ? AND event_type = ?
                """,
                (service_date, trip_number, station_code or "", event_type),
            ).fetchall()
            if not rows:
                return False
            if dedup_value is None:
                return True
            for r in rows:
                if not r["payload_json"]:
                    continue
                try:
                    payload = json.loads(r["payload_json"])
                    if str(payload.get("dedup_key", "")) == str(dedup_value):
                        return True
                except Exception:
                    pass
            return False

    def list_events_page(
        self,
        user_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
        event_type: str | None = None,
        scope: str = "route",
        include_total: bool = True,
    ) -> dict[str, Any]:
        limit = max(1, int(limit))
        offset = max(0, int(offset))
        clauses = []
        params: list[Any] = []
        if scope == "global":
            clauses.append("event_type NOT IN ('test_notification', 'location_change')")
        elif user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        else:
            clauses.append("COALESCE(user_id, '') != '__global__'")
        if event_type:
            clauses.append("event_type = ?")
            params.append(event_type)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.connect() as conn:
            if scope == "global":
                caller_uid = user_id if user_id and user_id != "__global__" else ""
                cte_sql = f"""
                    WITH deduped AS (
                        SELECT * FROM (
                            SELECT *,
                                   ROW_NUMBER() OVER (
                                       PARTITION BY service_date,
                                                    COALESCE(NULLIF(trip_number, ''), CAST(id AS TEXT)),
                                                    event_type,
                                                    COALESCE(station_code, ''),
                                                    title
                                       ORDER BY (CASE
                                                     WHEN ? != '' AND user_id = ? THEN 0
                                                     WHEN user_id = '__global__' THEN 1
                                                     ELSE 2
                                                 END) ASC,
                                                notified DESC,
                                                created_at DESC,
                                                id DESC
                                   ) AS _rn
                            FROM events
                            {where}
                        )
                        WHERE _rn = 1
                    )
                """
                base_params = [caller_uid, caller_uid, *params]
                total = (
                    int(conn.execute(f"{cte_sql} SELECT COUNT(*) FROM deduped", tuple(base_params)).fetchone()[0])
                    if include_total
                    else 0
                )
                rows = conn.execute(
                    f"{cte_sql} SELECT * FROM deduped ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                    tuple([*base_params, limit, offset]),
                ).fetchall()
            else:
                total = (
                    int(conn.execute(f"SELECT COUNT(*) FROM events {where}", tuple(params)).fetchone()[0])
                    if include_total
                    else 0
                )
                rows = conn.execute(
                    f"SELECT * FROM events {where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                    tuple([*params, limit, offset]),
                ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d.pop("_rn", None)
                d["notified"] = bool(d["notified"])
                d["channel_results"] = json.loads(d.pop("channel_results_json") or "null")
                d["payload"] = json.loads(d.pop("payload_json") or "null")
                out.append(d)
            if not include_total:
                total = offset + len(out)
            return {
                "events": out,
                "total": total,
                "limit": limit,
                "offset": offset,
                "has_more": (offset + len(out)) < total,
            }

    def list_events(
        self,
        user_id: str | None = None,
        limit: int = 100,
        event_type: str | None = None,
        scope: str = "route",
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return self.list_events_page(
            user_id=user_id,
            limit=limit,
            offset=offset,
            event_type=event_type,
            scope=scope,
            include_total=False,
        )["events"]

    def get_counts(self, user_id: str | None = None) -> dict[str, int]:
        with self.connect() as conn:
            if user_id:
                events_cnt = conn.execute(
                    "SELECT COUNT(*) FROM events WHERE user_id = ?", (user_id,)
                ).fetchone()[0]
                notified_cnt = conn.execute(
                    "SELECT COUNT(*) FROM events WHERE user_id = ? AND notified = 1", (user_id,)
                ).fetchone()[0]
                subs_cnt = conn.execute(
                    "SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?", (user_id,)
                ).fetchone()[0]
            else:
                events_cnt = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
                notified_cnt = conn.execute("SELECT COUNT(*) FROM events WHERE notified = 1").fetchone()[0]
                subs_cnt = conn.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]

            return {
                "snapshots_count": conn.execute("SELECT COUNT(*) FROM trip_snapshots").fetchone()[0],
                "snapshot_observations": int(
                    conn.execute("SELECT COALESCE(SUM(COALESCE(sample_count, 1)), 0) FROM trip_snapshots").fetchone()[0]
                ),
                "outcomes_count": conn.execute("SELECT COUNT(*) FROM trip_outcomes").fetchone()[0],
                "events_count": events_cnt,
                "notified_count": notified_cnt,
                "push_subs_count": subs_cnt,
                "users_count": conn.execute("SELECT COUNT(*) FROM users").fetchone()[0],
                "db_size_kb": self.get_db_size_kb(),
            }
