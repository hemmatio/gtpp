"""Background poller, rule eligibility engine, state-diff detector, and outcome logger."""

import asyncio
import json
import time
from datetime import datetime, timedelta
from typing import Any

from aiohttp import ClientSession

from config import (
    CATALOG_REFRESH_SEC,
    POLL_INTERVAL_ACTIVE,
    POLL_INTERVAL_IDLE,
    SNAPSHOT_HEARTBEAT_SEC,
    STATION_MSG_REFRESH_SEC,
    TORONTO_TZ,
    now_toronto,
    today_service_date,
)
from db import Database
from gotracker_client import (
    fetch_catalog,
    fetch_station_messages,
    fetch_station_signage,
    fetch_trip_detail,
    fetch_union_departures,
    parse_go_datetime,
)
from webpush import VapidManager, dispatch_notification


def _hhmm_to_minutes(hhmm: str) -> int:
    parts = hhmm.strip().split(":")
    return int(parts[0]) * 60 + int(parts[1])


def _time_in_window(dt: datetime, start_hhmm: str, end_hhmm: str) -> bool:
    cur = dt.hour * 60 + dt.minute
    start_m = _hhmm_to_minutes(start_hhmm)
    end_m = _hhmm_to_minutes(end_hhmm)
    if start_m <= end_m:
        return start_m <= cur <= end_m
    # Overnight window (e.g. 22:30 -> 01:30)
    return cur >= start_m or cur <= end_m


def evaluate_eligibility(
    settings: dict[str, Any],
    direction: str,
    scheduled_dt: datetime | None,
    now_dt: datetime | None = None,
) -> tuple[bool, str | None]:
    """Check whether notifications are currently eligible for a given direction and trip time."""
    now = (now_dt or now_toronto()).astimezone(TORONTO_TZ)
    alert_prefs = settings.get("alert_prefs", {})
    lead_window_min = int(alert_prefs.get("lead_window_min", 90))

    if scheduled_dt is not None:
        sched = scheduled_dt.astimezone(TORONTO_TZ)
        diff_sec = (sched - now).total_seconds()
        if diff_sec < -15 * 60 or diff_sec > lead_window_min * 60:
            return False, None

    loc = settings.get("location_state", {}) or {}
    override_dir = loc.get("override_direction")
    expires_str = loc.get("expires_at")
    if override_dir and expires_str:
        try:
            expires_dt = datetime.fromisoformat(expires_str)
            if expires_dt.tzinfo is None:
                expires_dt = expires_dt.replace(tzinfo=TORONTO_TZ)
            if now < expires_dt and override_dir in (direction, "both"):
                zone = loc.get("zone") or "override"
                return True, f"Location: {zone}"
        except Exception:
            pass

    for rule in settings.get("rules") or []:
        if not rule.get("enabled", True):
            continue
        r_dir = rule.get("direction", "both")
        if r_dir not in (direction, "both"):
            continue
        days = rule.get("days", [0, 1, 2, 3, 4, 5, 6])
        if now.weekday() not in days:
            continue
        start_str = rule.get("start", "00:00")
        end_str = rule.get("end", "23:59")
        in_now = _time_in_window(now, start_str, end_str)
        in_sched = scheduled_dt is not None and _time_in_window(scheduled_dt.astimezone(TORONTO_TZ), start_str, end_str)
        if in_now or in_sched:
            return True, rule.get("name") or rule.get("id") or "Scheduled Rule"

    return False, None


def detect_trip_events(
    old_row: dict[str, Any] | None,
    new_row: dict[str, Any],
    alert_prefs: dict[str, Any],
    now_dt: datetime | None = None,
) -> list[dict[str, Any]]:
    """Compare old vs new departure state and emit structured event dicts."""
    events: list[dict[str, Any]] = []
    now = (now_dt or now_toronto()).astimezone(TORONTO_TZ)
    trip_num = new_row["trip_number"]
    sched_dt = parse_go_datetime(new_row.get("scheduled_time"), now)
    sched_hhmm = sched_dt.strftime("%H:%M") if sched_dt else ""
    route_label = f"{new_row['origin_code']} → {new_row['dest_code']}"

    new_plat = (new_row.get("platform") or "-").strip() or "-"
    new_delay = int(new_row.get("delay_sec") or 0)
    new_info = (new_row.get("info_status") or "").strip()
    new_cancelled = bool(new_row.get("is_cancelled"))
    coach = new_row.get("coach_count")
    sched_coach = new_row.get("scheduled_coach_count")

    thresh_sec = int(alert_prefs.get("delay_threshold_min", 3)) * 60
    step_sec = max(60, int(alert_prefs.get("delay_change_step_min", 3)) * 60)

    if old_row is None:
        # First observation for this trip today
        if coach is not None and sched_coach is not None and coach < sched_coach:
            if sched_dt is None or sched_dt >= now - timedelta(minutes=10):
                events.append(
                    {
                        "event_type": "short_train",
                        "pref_key": "short_train",
                        "title": f"Short Train • {trip_num} ({sched_hhmm})",
                        "body": f"{route_label}: {coach} cars instead of scheduled {sched_coach}.",
                        "priority": "default",
                        "tags": "train,warning",
                        "dedup_key": f"{coach}/{sched_coach}",
                    }
                )
        if new_cancelled:
            events.append(
                {
                    "event_type": "cancelled",
                    "pref_key": "cancelled",
                    "title": f"CANCELLED • {trip_num} ({sched_hhmm})",
                    "body": f"{route_label} scheduled at {sched_hhmm} is cancelled.",
                    "priority": "urgent",
                    "tags": "rotating_light,train",
                    "dedup_key": "cancelled",
                }
            )
        return events

    old_plat = (old_row.get("platform") or "-").strip() or "-"
    old_delay = int(old_row.get("delay_sec") or 0)
    old_info = (old_row.get("info_status") or "").strip()
    old_cancelled = bool(old_row.get("is_cancelled"))
    old_coach = old_row.get("coach_count")

    # 1. Platform announced / changed
    if old_plat in ("", "-") and new_plat not in ("", "-"):
        events.append(
            {
                "event_type": "platform_announced",
                "pref_key": "platform_announced",
                "title": f"Platform {new_plat} • Train {trip_num}",
                "body": f"{route_label} ({sched_hhmm}) assigned to Platform {new_plat}.",
                "priority": "high",
                "tags": "train,loudspeaker",
                "dedup_key": new_plat,
            }
        )
    elif old_plat not in ("", "-") and new_plat not in ("", "-") and old_plat != new_plat:
        events.append(
            {
                "event_type": "platform_changed",
                "pref_key": "platform_changed",
                "title": f"Platform Changed → {new_plat} • {trip_num}",
                "body": f"{route_label} ({sched_hhmm}) moved from Platform {old_plat} to {new_plat}.",
                "priority": "urgent",
                "tags": "warning,train",
                "dedup_key": f"{old_plat}->{new_plat}",
            }
        )

    # 2. Boarding / Proceed status
    if "proceed" in new_info.lower() and "proceed" not in old_info.lower():
        plat_note = f" on Platform {new_plat}" if new_plat not in ("", "-") else ""
        events.append(
            {
                "event_type": "boarding_proceed",
                "pref_key": "boarding_proceed",
                "title": f"Boarding Now • Train {trip_num}",
                "body": f"{route_label} ({sched_hhmm}) is Proceed/Boarding{plat_note}.",
                "priority": "high",
                "tags": "green_circle,train",
                "dedup_key": "proceed",
            }
        )

    # 3. Delay transitions
    if old_delay < thresh_sec <= new_delay:
        mins = max(1, round(new_delay / 60))
        events.append(
            {
                "event_type": "delay_started",
                "pref_key": "delay",
                "title": f"Delayed +{mins}m • Train {trip_num}",
                "body": f"{route_label} ({sched_hhmm}) is now running ~{mins} min late.",
                "priority": "high",
                "tags": "hourglass,train",
                "dedup_key": f"start_{mins}",
            }
        )
    elif old_delay >= thresh_sec and (new_delay - old_delay) >= step_sec:
        mins = max(1, round(new_delay / 60))
        events.append(
            {
                "event_type": "delay_increased",
                "pref_key": "delay",
                "title": f"Delay Increased +{mins}m • {trip_num}",
                "body": f"{route_label} ({sched_hhmm}) delay grew to +{mins} min.",
                "priority": "high",
                "tags": "warning,train",
                "dedup_key": f"inc_{mins}",
            }
        )
    elif old_delay >= thresh_sec and new_delay < 60 and not new_cancelled:
        events.append(
            {
                "event_type": "delay_recovered",
                "pref_key": "delay",
                "title": f"Back On Time • Train {trip_num}",
                "body": f"{route_label} ({sched_hhmm}) recovered to on-time status.",
                "priority": "default",
                "tags": "white_check_mark,train",
                "dedup_key": "recovered",
            }
        )

    # 4. Cancellation
    if not old_cancelled and new_cancelled:
        events.append(
            {
                "event_type": "cancelled",
                "pref_key": "cancelled",
                "title": f"CANCELLED • Train {trip_num} ({sched_hhmm})",
                "body": f"{route_label} scheduled at {sched_hhmm} has been cancelled.",
                "priority": "urgent",
                "tags": "rotating_light,train",
                "dedup_key": "cancelled",
            }
        )

    # 5. Short train detected on update
    if (
        coach is not None
        and sched_coach is not None
        and coach < sched_coach
        and (old_coach is None or old_coach >= sched_coach)
    ):
        if sched_dt is None or sched_dt >= now - timedelta(minutes=10):
            events.append(
                {
                    "event_type": "short_train",
                    "pref_key": "short_train",
                    "title": f"Short Train • {trip_num} ({sched_hhmm})",
                    "body": f"{route_label}: {coach} cars instead of scheduled {sched_coach}.",
                    "priority": "default",
                    "tags": "train,warning",
                    "dedup_key": f"{coach}/{sched_coach}",
                }
            )

    return events


class TrackerPoller:
    """Async background loop polling gotracker.ca, logging snapshots/outcomes, and pushing alerts."""

    def __init__(self, db: Database, vapid: VapidManager, session: ClientSession):
        self.db = db
        self.vapid = vapid
        self.session = session
        self.started_at = now_toronto().isoformat()
        self.last_poll_at: str | None = None
        self.last_poll_ok: bool = False
        self.last_poll_ms: int = 0
        self.last_error: str | None = None

        self.subscribers: set[asyncio.Queue] = set()
        self._wake_event = asyncio.Event()
        self._poll_lock = asyncio.Lock()
        self._running = False
        self._task: asyncio.Task | None = None

        self._msg_fetch_ts: dict[tuple[str, str], float] = {}
        self._detail_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._last_snapshot_ts: dict[tuple[str, str, str], float] = {}
        self._last_compact_ts: float = 0.0
        self._catalog_mem: dict[str, Any] | None = None
        self._catalog_ts: float = 0.0

    def start(self) -> None:
        if not self._running:
            self._running = True
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        self._wake_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def trigger_poll_now(self) -> None:
        self._wake_event.set()

    async def ensure_catalog(self, force: bool = False) -> dict[str, Any] | None:
        now_m = time.monotonic()
        if not force and self._catalog_mem and (now_m - self._catalog_ts) < CATALOG_REFRESH_SEC:
            return self._catalog_mem

        cached, updated_at = self.db.get_catalog()
        if not force and cached and updated_at and cached.get("schema_version", 1) >= 2:
            try:
                age = (now_toronto() - datetime.fromisoformat(updated_at)).total_seconds()
                if age < CATALOG_REFRESH_SEC:
                    self._catalog_mem = cached
                    self._catalog_ts = now_m
                    return cached
            except Exception:
                pass

        try:
            fresh = await fetch_catalog(self.session)
            self.db.save_catalog(fresh)
            self._catalog_mem = fresh
            self._catalog_ts = now_m
            return fresh
        except Exception as exc:
            self.last_error = f"Catalog fetch failed: {exc}"
            return cached or self._catalog_mem

    async def get_trip_detail_cached(self, trip_number: str, max_age_sec: float = 20.0) -> dict[str, Any] | None:
        now_m = time.monotonic()
        cached = self._detail_cache.get(str(trip_number))
        if cached and (now_m - cached[0]) < max_age_sec:
            return cached[1]
        detail = await fetch_trip_detail(self.session, str(trip_number))
        if detail:
            self._detail_cache[str(trip_number)] = (now_m, detail)
        return detail

    def _compute_next_interval(self, active_users: list[dict[str, Any]], live_rows: list[dict[str, Any]]) -> int:
        now = now_toronto()
        for row in live_rows:
            sched_dt = parse_go_datetime(row.get("scheduled_time"), now)
            if sched_dt:
                diff = (sched_dt - now).total_seconds()
                if -20 * 60 <= diff <= 60 * 60:
                    return POLL_INTERVAL_ACTIVE
            for u in active_users:
                route = u["settings"].get("route", {})
                h, d = route.get("home_station", "AG"), route.get("dest_station", "UN")
                if row["origin_code"] == h and row["dest_code"] == d:
                    u_dir = "home_to_dest"
                elif row["origin_code"] == d and row["dest_code"] == h:
                    u_dir = "dest_to_home"
                else:
                    continue
                elig, _ = evaluate_eligibility(u["settings"], u_dir, sched_dt, now)
                if elig:
                    return POLL_INTERVAL_ACTIVE
        return POLL_INTERVAL_IDLE

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.poll_once()
                if (time.monotonic() - self._last_compact_ts) >= 24 * 3600:
                    async with self._poll_lock:
                        self.db.compact_snapshots(max_age_days=180, vacuum=False)
                        self._last_compact_ts = time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_poll_ok = False
                self.last_error = str(exc)

            active_users = self.db.list_active_users_with_settings()
            live_rows = self.db.get_live_departures()
            interval = self._compute_next_interval(active_users, live_rows)
            self._wake_event.clear()
            try:
                await asyncio.wait_for(self._wake_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass

    def _broadcast_sse(self, payload: dict[str, Any]) -> None:
        stale = []
        for q in self.subscribers:
            try:
                if q.full():
                    q.get_nowait()
                q.put_nowait(payload)
            except Exception:
                stale.append(q)
        for q in stale:
            self.subscribers.discard(q)

    async def poll_once(self) -> dict[str, Any]:
        async with self._poll_lock:
            t0 = time.monotonic()
            now = now_toronto()
            service_date = today_service_date(now)

            catalog = await self.ensure_catalog()
            stations = (catalog or {}).get("stations", {})

            active_users = self.db.list_active_users_with_settings()
            if not active_users:
                from db import _default_settings
                active_users = [{"user_id": None, "settings": _default_settings()}]

            # Deduplicate upstream queries across all active users' routes
            signage_targets: set[tuple[str, str]] = set()
            union_targets: set[tuple[str, str, str]] = set()
            msg_targets: set[tuple[str, str]] = set()
            unique_routes: list[tuple[str, str, str, str]] = []
            seen_routes: set[tuple[str, str, str, str]] = set()

            for u in active_users:
                route = u["settings"].get("route", {})
                h_corr = route.get("home_corridor", "ST")
                h_stat = route.get("home_station", "AG")
                d_corr = route.get("dest_corridor", "ST")
                d_stat = route.get("dest_station", "UN")
                rk = (h_corr, h_stat, d_corr, d_stat)
                if rk not in seen_routes:
                    seen_routes.add(rk)
                    unique_routes.append(rk)
                if h_stat == "UN" or d_stat == "UN":
                    non_un_corr = h_corr if d_stat == "UN" else d_corr
                    non_un_code = h_stat if d_stat == "UN" else d_stat
                    if non_un_code != "UN":
                        non_un_name = (stations.get(non_un_code) or {}).get("name", non_un_code)
                        signage_targets.add((non_un_corr, non_un_code))
                        union_targets.add((non_un_corr, non_un_code, non_un_name))
                else:
                    signage_targets.add((h_corr, h_stat))
                    signage_targets.add((d_corr, d_stat))

                msg_targets.add((h_corr, h_stat))
                msg_targets.add((d_corr, d_stat))

            try:
                now_mono = time.monotonic()
                signage_list = sorted(signage_targets)
                union_list = sorted(union_targets)
                msg_list = [
                    pair for pair in sorted(msg_targets)
                    if (now_mono - self._msg_fetch_ts.get(pair, 0.0)) > STATION_MSG_REFRESH_SEC
                ]

                tasks = (
                    [fetch_station_signage(self.session, c, s) for c, s in signage_list]
                    + [fetch_union_departures(self.session, s, n) for _, s, n in union_list]
                    + [fetch_station_messages(self.session, c, s) for c, s in msg_list]
                )
                results = await asyncio.gather(*tasks, return_exceptions=True)

                idx = 0
                signage_map: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
                signage_errors = 0
                for c, s in signage_list:
                    res = results[idx]
                    idx += 1
                    if isinstance(res, Exception):
                        signage_errors += 1
                        signage_map[(c, s)] = {"Inbound": [], "Outbound": []}
                    else:
                        signage_map[(c, s)] = res

                union_map: dict[str, list[dict[str, Any]]] = {}
                union_errors = 0
                for _, s, _ in union_list:
                    res = results[idx]
                    idx += 1
                    if isinstance(res, Exception):
                        union_errors += 1
                        union_map[s] = []
                    else:
                        union_map[s] = res

                for c, s in msg_list:
                    res = results[idx]
                    idx += 1
                    if not isinstance(res, Exception):
                        self.db.save_station_messages(c, s, res)
                        self._msg_fetch_ts[(c, s)] = now_mono

                if signage_list and union_list and signage_errors == len(signage_list) and union_errors == len(union_list):
                    raise RuntimeError("All upstream GOTracker requests failed")

                # Build canonical physical-leg rows keyed by (service_date, trip_number, origin_code, dest_code)
                legs_by_key: dict[tuple[str, str, str, str], dict[str, Any]] = {}

                def add_leg(row: dict[str, Any]) -> None:
                    k = (row["service_date"], row["trip_number"], row["origin_code"], row["dest_code"])
                    legs_by_key[k] = row

                for h_corr, h_stat, d_corr, d_stat in unique_routes:
                    if h_stat == "UN" or d_stat == "UN":
                        non_un_corr = h_corr if d_stat == "UN" else d_corr
                        non_un_code = h_stat if d_stat == "UN" else d_stat
                        if non_un_code == "UN":
                            continue
                        signage = signage_map.get((non_un_corr, non_un_code), {"Inbound": [], "Outbound": []})
                        union_deps = union_map.get(non_un_code, [])

                        for item in signage.get("Inbound", []):
                            add_leg(
                                {
                                    "service_date": service_date,
                                    "trip_number": item["trip_number"],
                                    "origin_code": non_un_code,
                                    "dest_code": "UN",
                                    "corridor": non_un_corr,
                                    "scheduled_time": item["scheduled_time"],
                                    "predicted_time": item["predicted_time"],
                                    "delay_sec": item["delay_sec"],
                                    "platform": item["platform"],
                                    "sch_track": "",
                                    "info_status": item["info_status"],
                                    "is_cancelled": item["is_cancelled"],
                                    "is_express": item["is_express"],
                                    "coach_count": item["coach_count"],
                                    "scheduled_coach_count": item["scheduled_coach_count"],
                                    "stops": item["stops"],
                                    "remarks": item["remarks"],
                                    "source": "signage",
                                }
                            )

                        outbound_signage_map = {
                            it["trip_number"]: it for it in signage.get("Outbound", [])
                        }
                        for item in union_deps:
                            t_num = item["trip_number"]
                            ob = outbound_signage_map.get(t_num)
                            delay_sec = item["delay_sec"]
                            pred_time = item["predicted_time"]
                            is_cancelled = item["is_cancelled"]
                            if ob and ob["delay_sec"] > delay_sec and delay_sec == 0:
                                delay_sec = ob["delay_sec"]
                                sched_dt = parse_go_datetime(item["scheduled_time"], now)
                                if sched_dt:
                                    pred_time = (sched_dt + timedelta(seconds=delay_sec)).isoformat()
                            if ob and ob["is_cancelled"]:
                                is_cancelled = True

                            add_leg(
                                {
                                    "service_date": service_date,
                                    "trip_number": t_num,
                                    "origin_code": "UN",
                                    "dest_code": non_un_code,
                                    "corridor": non_un_corr,
                                    "scheduled_time": item["scheduled_time"],
                                    "predicted_time": pred_time,
                                    "delay_sec": delay_sec,
                                    "platform": item["platform"],
                                    "sch_track": "",
                                    "info_status": item["info_status"],
                                    "is_cancelled": is_cancelled,
                                    "is_express": item["is_express"],
                                    "coach_count": item["coach_count"],
                                    "scheduled_coach_count": item["scheduled_coach_count"],
                                    "stops": item["stops"],
                                    "remarks": item["remarks"],
                                    "source": "union_departures",
                                }
                            )
                    else:
                        sig_home = signage_map.get((h_corr, h_stat), {"Inbound": [], "Outbound": []})
                        sig_dest = signage_map.get((d_corr, d_stat), {"Inbound": [], "Outbound": []})
                        for dir_bucket in ("Inbound", "Outbound"):
                            for item in sig_home.get(dir_bucket, []):
                                stop_codes = {s.get("code") for s in item.get("stops", [])}
                                if d_stat in stop_codes:
                                    add_leg(
                                        {
                                            "service_date": service_date,
                                            "trip_number": item["trip_number"],
                                            "origin_code": h_stat,
                                            "dest_code": d_stat,
                                            "corridor": h_corr,
                                            "scheduled_time": item["scheduled_time"],
                                            "predicted_time": item["predicted_time"],
                                            "delay_sec": item["delay_sec"],
                                            "platform": item["platform"],
                                            "sch_track": "",
                                            "info_status": item["info_status"],
                                            "is_cancelled": item["is_cancelled"],
                                            "is_express": item["is_express"],
                                            "coach_count": item["coach_count"],
                                            "scheduled_coach_count": item["scheduled_coach_count"],
                                            "stops": item["stops"],
                                            "remarks": item["remarks"],
                                            "source": "signage",
                                        }
                                    )
                            for item in sig_dest.get(dir_bucket, []):
                                stop_codes = {s.get("code") for s in item.get("stops", [])}
                                if h_stat in stop_codes:
                                    add_leg(
                                        {
                                            "service_date": service_date,
                                            "trip_number": item["trip_number"],
                                            "origin_code": d_stat,
                                            "dest_code": h_stat,
                                            "corridor": d_corr,
                                            "scheduled_time": item["scheduled_time"],
                                            "predicted_time": item["predicted_time"],
                                            "delay_sec": item["delay_sec"],
                                            "platform": item["platform"],
                                            "sch_track": "",
                                            "info_status": item["info_status"],
                                            "is_cancelled": item["is_cancelled"],
                                            "is_express": item["is_express"],
                                            "coach_count": item["coach_count"],
                                            "scheduled_coach_count": item["scheduled_coach_count"],
                                            "stops": item["stops"],
                                            "remarks": item["remarks"],
                                            "source": "signage",
                                        }
                                    )

                normalized_rows = list(legs_by_key.values())
                prev_map = self.db.get_live_departures_map(service_date)

                # Selective Trip Detail enrichment (up to 6 imminent/recent trips per poll)
                candidates = []
                for row in normalized_rows:
                    sched_dt = parse_go_datetime(row["scheduled_time"], now)
                    if not sched_dt:
                        continue
                    diff_min = (sched_dt - now).total_seconds() / 60.0
                    if -35 <= diff_min <= 45:
                        already_done = self.db.has_outcome(service_date, row["trip_number"], row["origin_code"])
                        if not already_done:
                            candidates.append((abs(diff_min), row))

                candidates.sort(key=lambda x: x[0])
                detail_targets = [c[1] for c in candidates[:6]]
                if detail_targets:
                    details = await asyncio.gather(
                        *(self.get_trip_detail_cached(r["trip_number"], max_age_sec=25.0) for r in detail_targets),
                        return_exceptions=True,
                    )
                    for row, detail in zip(detail_targets, details):
                        if isinstance(detail, Exception) or not detail:
                            continue
                        origin_code = row["origin_code"]
                        origin_meta = stations.get(origin_code) or {}
                        origin_atls = origin_meta.get("atlsId")
                        origin_name = (origin_meta.get("name") or "").lower().replace(" go", "")

                        matched_stop = None
                        for st in detail.get("stops", []):
                            if origin_atls and st.get("id") == origin_atls:
                                matched_stop = st
                                break
                            st_name = (st.get("name") or "").lower().replace(" go", "")
                            if origin_code == "UN" and "union" in st_name:
                                matched_stop = st
                                break
                            if origin_name and origin_name in st_name:
                                matched_stop = st
                                break

                        if matched_stop:
                            raw_sch_track = str(matched_stop.get("schTrack") or "").strip()
                            if raw_sch_track and raw_sch_track != "-":
                                row["sch_track"] = raw_sch_track
                            ci = matched_stop.get("completeInfo")
                            if ci and (ci.get("actDeparture") or ci.get("actArrival")):
                                act_raw = ci.get("actDeparture") or ci.get("actArrival")
                                act_dt = parse_go_datetime(act_raw, now)
                                sched_dt = parse_go_datetime(row["scheduled_time"], now)
                                actual_delay = ci.get("delaySecond")
                                if actual_delay is None and act_dt and sched_dt:
                                    actual_delay = int((act_dt - sched_dt).total_seconds())
                                actual_delay = int(actual_delay or 0)
                                row["delay_sec"] = actual_delay
                                if act_dt:
                                    row["predicted_time"] = act_dt.isoformat()

                                prev_row = prev_map.get((service_date, row["trip_number"], origin_code, row["dest_code"]))
                                first_plat_at = (prev_row or {}).get("first_platform_at")
                                plat_lead_sec = None
                                if first_plat_at and sched_dt:
                                    try:
                                        fp_dt = datetime.fromisoformat(first_plat_at)
                                        plat_lead_sec = int((sched_dt - fp_dt).total_seconds())
                                    except Exception:
                                        pass
                                self.db.upsert_outcome(
                                    {
                                        "service_date": service_date,
                                        "trip_number": row["trip_number"],
                                        "stop_code": origin_code,
                                        "stop_name": matched_stop.get("name"),
                                        "corridor": row["corridor"],
                                        "direction": f"{origin_code}->{row['dest_code']}",
                                        "scheduled_time": row["scheduled_time"],
                                        "actual_time": act_dt.isoformat() if act_dt else act_raw,
                                        "delay_sec": actual_delay,
                                        "sch_track": matched_stop.get("schTrack") or row.get("sch_track", ""),
                                        "act_track": ci.get("actTrack") or row.get("platform", ""),
                                        "engine_id": matched_stop.get("engineId") or detail.get("engineId"),
                                        "is_cancelled": row["is_cancelled"] or matched_stop.get("isCancelled", False),
                                        "first_platform_at": first_plat_at,
                                        "platform_lead_sec": plat_lead_sec,
                                        "platform_changes": (prev_row or {}).get("platform_changes", 0),
                                    }
                                )

                # Diff, snapshot once per physical leg, and evaluate per-user alerts
                now_mono = time.monotonic()
                for row in normalized_rows:
                    key = (service_date, row["trip_number"], row["origin_code"], row["dest_code"])
                    old_row = prev_map.get(key)
                    new_plat = (row.get("platform") or "-").strip() or "-"
                    old_plat = ((old_row or {}).get("platform") or "-").strip() or "-"

                    first_plat_at = (old_row or {}).get("first_platform_at")
                    if not first_plat_at and new_plat not in ("", "-"):
                        first_plat_at = now.isoformat()
                    plat_changes = int((old_row or {}).get("platform_changes") or 0)
                    if old_row and old_plat not in ("", "-") and new_plat not in ("", "-") and old_plat != new_plat:
                        plat_changes += 1

                    row["first_platform_at"] = first_plat_at
                    row["platform_changes"] = plat_changes

                    changed = old_row is None or (
                        str(old_row.get("predicted_time") or "") != str(row.get("predicted_time") or "")
                        or int(old_row.get("delay_sec") or 0) != int(row.get("delay_sec") or 0)
                        or old_plat != new_plat
                        or str(old_row.get("sch_track") or "") != str(row.get("sch_track") or "")
                        or str(old_row.get("info_status") or "") != str(row.get("info_status") or "")
                        or bool(old_row.get("is_cancelled")) != bool(row.get("is_cancelled"))
                        or old_row.get("coach_count") != row.get("coach_count")
                    )

                    snap_key = (row["trip_number"], row["origin_code"], row["dest_code"])
                    last_snap = self._last_snapshot_ts.get(snap_key, 0.0)
                    sched_dt = parse_go_datetime(row["scheduled_time"], now)
                    within_snap_window = (
                        sched_dt is not None
                        and -15 * 60 <= (sched_dt - now).total_seconds() <= 90 * 60
                    )

                    if changed or within_snap_window:
                        self.db.record_snapshot(
                            {
                                "captured_at": now.isoformat(),
                                "last_seen_at": now.isoformat(),
                                "service_date": service_date,
                                "corridor": row["corridor"],
                                "station_code": row["origin_code"],
                                "direction": f"{row['origin_code']}->{row['dest_code']}",
                                "trip_number": row["trip_number"],
                                "scheduled_time": row["scheduled_time"],
                                "predicted_time": row.get("predicted_time"),
                                "delay_sec": row.get("delay_sec", 0),
                                "platform": new_plat,
                                "sch_track": row.get("sch_track", ""),
                                "info_status": row.get("info_status", ""),
                                "is_cancelled": row.get("is_cancelled", False),
                                "is_express": row.get("is_express", False),
                                "coach_count": row.get("coach_count"),
                                "scheduled_coach_count": row.get("scheduled_coach_count"),
                                "source": row.get("source", "poll"),
                            }
                        )
                        self._last_snapshot_ts[snap_key] = now_mono

                    # Per-user alert evaluation for users tracking this leg
                    for u in active_users:
                        u_id = u["user_id"]
                        if not u_id:
                            continue
                        u_settings = u["settings"]
                        u_route = u_settings.get("route", {})
                        h_stat = u_route.get("home_station", "AG")
                        d_stat = u_route.get("dest_station", "UN")
                        if row["origin_code"] == h_stat and row["dest_code"] == d_stat:
                            u_dir = "home_to_dest"
                        elif row["origin_code"] == d_stat and row["dest_code"] == h_stat:
                            u_dir = "dest_to_home"
                        else:
                            continue

                        u_prefs = u_settings.get("alert_prefs", {})
                        detected = detect_trip_events(old_row, row, u_prefs, now)
                        for ev in detected:
                            pref_key = ev["pref_key"]
                            if pref_key == "delay":
                                pref_enabled = int(u_prefs.get("delay_threshold_min", 3)) > 0
                            else:
                                pref_enabled = bool(u_prefs.get(pref_key, True))

                            eligible, rule_name = evaluate_eligibility(u_settings, u_dir, sched_dt, now)
                            already_sent = self.db.has_recent_notified_event(
                                u_id,
                                service_date,
                                row["trip_number"],
                                ev["event_type"],
                                ev.get("dedup_key"),
                            )

                            should_notify = pref_enabled and eligible and not already_sent
                            channel_results = None
                            notified = False
                            if should_notify:
                                channel_results = await dispatch_notification(
                                    self.session,
                                    self.db,
                                    self.vapid,
                                    u_id,
                                    ev["title"],
                                    ev["body"],
                                    {
                                        "tag": f"go-{row['trip_number']}-{ev['event_type']}",
                                        "trip_number": row["trip_number"],
                                        "event_type": ev["event_type"],
                                        "direction": u_dir,
                                    },
                                    priority=ev.get("priority", "default"),
                                    tags=ev.get("tags", "train"),
                                )
                                notified = True

                            self.db.insert_event(
                                {
                                    "created_at": now.isoformat(),
                                    "user_id": u_id,
                                    "service_date": service_date,
                                    "trip_number": row["trip_number"],
                                    "corridor": row["corridor"],
                                    "station_code": row["origin_code"],
                                    "direction": u_dir,
                                    "event_type": ev["event_type"],
                                    "title": ev["title"],
                                    "body": ev["body"],
                                    "notified": notified,
                                    "rule_matched": rule_name,
                                    "channel_results": channel_results,
                                    "payload": {"dedup_key": ev.get("dedup_key")},
                                }
                            )

                    self.db.upsert_live_departure(row)

                yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
                self.db.prune_stale_live_departures(yesterday)

                self.last_poll_at = now.isoformat()
                self.last_poll_ok = True
                self.last_poll_ms = int((time.monotonic() - t0) * 1000)
                self.last_error = None

                self._broadcast_sse(
                    {
                        "type": "update",
                        "last_poll_at": self.last_poll_at,
                        "trips_count": len(normalized_rows),
                    }
                )
                return {"ok": True, "trips_count": len(normalized_rows), "ms": self.last_poll_ms}
            except Exception as exc:
                self.last_poll_at = now.isoformat()
                self.last_poll_ok = False
                self.last_poll_ms = int((time.monotonic() - t0) * 1000)
                self.last_error = str(exc)
                return {"ok": False, "error": str(exc)}
