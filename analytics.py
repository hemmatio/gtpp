"""Analytics engine for delay distributions, misleading estimations (prediction drift), and platform patterns."""

import csv
import io
import statistics
from datetime import datetime, timedelta
from typing import Any

from config import MINOR_DELAY_SEC, SERVICE_GUARANTEE_SEC, TORONTO_TZ, now_toronto
from db import Database


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        return dt.replace(tzinfo=TORONTO_TZ) if dt.tzinfo is None else dt.astimezone(TORONTO_TZ)
    except Exception:
        return None


def compute_analytics(db: Database, days: int = 30, user_id: str | None = None) -> dict[str, Any]:
    """Compute delay KPIs, prediction-drift ('misleading estimations') buckets, and platform patterns."""
    cutoff = (now_toronto() - timedelta(days=days)).strftime("%Y-%m-%d")
    counts = db.get_counts(user_id=user_id)

    with db.connect() as conn:
        outcomes = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM trip_outcomes WHERE service_date >= ? ORDER BY recorded_at DESC",
                (cutoff,),
            ).fetchall()
        ]
        snapshots = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM trip_snapshots WHERE service_date >= ? ORDER BY captured_at ASC",
                (cutoff,),
            ).fetchall()
        ]

    # Index snapshots by (service_date, trip_number)
    snap_by_trip: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for s in snapshots:
        snap_by_trip.setdefault((s["service_date"], s["trip_number"]), []).append(s)

    # Fallback to latest snapshot per trip if outcomes haven't accumulated yet
    using_fallback = False
    records = outcomes
    if not records and snap_by_trip:
        using_fallback = True
        records = [snaps[-1] for snaps in snap_by_trip.values()]

    delays = [int(r.get("delay_sec") or 0) for r in records if r.get("delay_sec") is not None]
    avg_delay_min = round(statistics.mean(delays) / 60.0, 2) if delays else 0.0
    median_delay_min = round(statistics.median(delays) / 60.0, 2) if delays else 0.0
    max_delay_min = round(max(delays) / 60.0, 1) if delays else 0.0
    on_time_pct = (
        round(100.0 * sum(1 for d in delays if d < MINOR_DELAY_SEC) / len(delays), 1)
        if delays
        else 100.0
    )
    service_guarantee_hits = sum(1 for d in delays if d >= SERVICE_GUARANTEE_SEC)

    # Short train rate from snapshots
    coach_snaps = [
        s for s in snapshots
        if s.get("coach_count") is not None and s.get("scheduled_coach_count") is not None
    ]
    short_trips = {
        (s["service_date"], s["trip_number"])
        for s in coach_snaps
        if s["coach_count"] < s["scheduled_coach_count"]
    }
    all_coach_trips = {(s["service_date"], s["trip_number"]) for s in coach_snaps}
    short_train_pct = (
        round(100.0 * len(short_trips) / len(all_coach_trips), 1)
        if all_coach_trips
        else 0.0
    )

    # Platform announcement lead time (scoped to Union Station where gate drops happen) & schTrack accuracy
    union_lead_secs = [
        int(o["platform_lead_sec"])
        for o in outcomes
        if o.get("stop_code") == "UN" and o.get("platform_lead_sec") is not None and o["platform_lead_sec"] >= 0
    ]
    avg_platform_lead_min = round(statistics.mean(union_lead_secs) / 60.0, 1) if union_lead_secs else None

    track_pairs = [
        (str(o.get("sch_track") or "").strip(), str(o.get("act_track") or "").strip())
        for o in outcomes
        if str(o.get("sch_track") or "").strip() and str(o.get("act_track") or "").strip() not in ("", "-")
    ]
    sch_track_match_pct = (
        round(100.0 * sum(1 for s, a in track_pairs if a in s.split("&") or s == a) / len(track_pairs), 1)
        if track_pairs
        else None
    )

    # Misleading Estimations (Prediction Drift) across lead-time buckets
    buckets_spec = [
        ("T-30m", 25 * 60, 35 * 60),
        ("T-15m", 12 * 60, 18 * 60),
        ("T-10m", 8 * 60, 12 * 60),
        ("T-5m", 3 * 60, 7 * 60),
    ]
    bucket_data: dict[str, list[tuple[int, int]]] = {b[0]: [] for b in buckets_spec}

    for o in outcomes:
        sched_dt = _parse_iso(o.get("scheduled_time"))
        if not sched_dt or o.get("delay_sec") is None:
            continue
        act_delay = int(o["delay_sec"])
        trip_snaps = snap_by_trip.get((o["service_date"], o["trip_number"]), [])
        if not trip_snaps:
            continue

        for label, min_lead, max_lead in buckets_spec:
            win_start = sched_dt - timedelta(seconds=max_lead)
            win_end = sched_dt - timedelta(seconds=min_lead)
            target_dt = sched_dt - timedelta(seconds=(min_lead + max_lead) / 2.0)
            best_snap = None
            best_dist = 1e9
            for s in trip_snaps:
                cap_dt = _parse_iso(s.get("captured_at"))
                if not cap_dt:
                    continue
                end_dt = _parse_iso(s.get("last_seen_at")) or cap_dt
                if end_dt < cap_dt:
                    end_dt = cap_dt
                if cap_dt <= win_end and end_dt >= win_start:
                    if cap_dt <= target_dt <= end_dt:
                        dist = 0.0
                    else:
                        dist = min(
                            abs((target_dt - cap_dt).total_seconds()),
                            abs((target_dt - end_dt).total_seconds()),
                        )
                    if dist < best_dist:
                        best_dist = dist
                        best_snap = s
            if best_snap is not None:
                pred_delay = int(best_snap.get("delay_sec") or 0)
                bucket_data[label].append((pred_delay, act_delay))

    prediction_drift = []
    for label, _, _ in buckets_spec:
        pairs = bucket_data[label]
        if not pairs:
            prediction_drift.append(
                {
                    "bucket": label,
                    "sample_count": 0,
                    "mean_abs_error_min": None,
                    "mean_underestimation_min": None,
                    "phantom_ontime_pct": None,
                }
            )
            continue
        abs_errs = [abs(a - p) / 60.0 for p, a in pairs]
        under = [(a - p) / 60.0 for p, a in pairs]
        pred_ontime = [(p, a) for p, a in pairs if p < 180]
        phantom_pct = (
            round(100.0 * sum(1 for _, a in pred_ontime if a >= 300) / len(pred_ontime), 1)
            if pred_ontime
            else 0.0
        )
        prediction_drift.append(
            {
                "bucket": label,
                "sample_count": len(pairs),
                "mean_abs_error_min": round(statistics.mean(abs_errs), 2),
                "mean_underestimation_min": round(statistics.mean(under), 2),
                "phantom_ontime_pct": phantom_pct,
            }
        )

    # Hourly delay breakdown
    hourly: dict[int, list[int]] = {}
    for r in records:
        dt = _parse_iso(r.get("scheduled_time"))
        if dt and r.get("delay_sec") is not None:
            hourly.setdefault(dt.hour, []).append(int(r["delay_sec"]))
    hourly_breakdown = [
        {
            "hour": h,
            "label": f"{h:02d}:00",
            "samples": len(ds),
            "avg_delay_min": round(statistics.mean(ds) / 60.0, 1),
        }
        for h, ds in sorted(hourly.items())
    ]

    return {
        "days": days,
        "data_source": "snapshots_fallback" if using_fallback else "outcomes",
        "kpis": {
            "total_snapshots": counts["snapshots_count"],
            "snapshot_observations": counts.get("snapshot_observations", counts["snapshots_count"]),
            "total_outcomes": counts["outcomes_count"],
            "outcome_sample_count": len(records),
            "total_events": counts["events_count"],
            "notifications_sent": counts["notified_count"],
            "avg_delay_min": avg_delay_min,
            "median_delay_min": median_delay_min,
            "max_delay_min": max_delay_min,
            "on_time_pct": on_time_pct,
            "service_guarantee_hits": service_guarantee_hits,
            "short_train_pct": short_train_pct,
            "avg_platform_lead_min": avg_platform_lead_min,
            "sch_track_match_pct": sch_track_match_pct,
        },
        "prediction_drift": prediction_drift,
        "hourly_breakdown": hourly_breakdown,
    }


def export_analytics_data(db: Database, table: str = "snapshots", fmt: str = "csv") -> tuple[str, str]:
    """Export snapshots, outcomes, or events as CSV or JSON string. Returns (content_type, body)."""
    table_map = {
        "snapshots": "SELECT * FROM trip_snapshots ORDER BY captured_at DESC LIMIT 10000",
        "outcomes": "SELECT * FROM trip_outcomes ORDER BY recorded_at DESC LIMIT 10000",
        "events": "SELECT * FROM events ORDER BY created_at DESC LIMIT 10000",
    }
    sql = table_map.get(table, table_map["snapshots"])
    with db.connect() as conn:
        rows = [dict(r) for r in conn.execute(sql).fetchall()]

    if fmt == "json":
        import json
        return "application/json", json.dumps(rows, indent=2)

    output = io.StringIO()
    if rows:
        writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return "text/csv", output.getvalue()


def _to_minutes(val: str | None) -> int | None:
    if not val or not isinstance(val, str):
        return None
    dt = _parse_iso(val)
    if dt:
        return dt.hour * 60 + dt.minute
    s = val.strip()
    if ":" in s:
        try:
            parts = s.split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except Exception:
            return None
    return None


def _circ_min_diff(m1: int, m2: int) -> int:
    d = abs(m1 - m2)
    return min(d, 1440 - d)


def collect_historical_platforms(db: Database, days: int = 90) -> dict[str, Any]:
    """Aggregate deduplicated daily platform assignments from outcomes + snapshots."""
    cutoff = (now_toronto() - timedelta(days=days)).strftime("%Y-%m-%d")
    with db.connect() as conn:
        outcomes = [
            dict(r)
            for r in conn.execute(
                """
                SELECT service_date, trip_number, stop_code, corridor, scheduled_time,
                       sch_track, act_track, platform_lead_sec
                FROM trip_outcomes
                WHERE service_date >= ? AND act_track IS NOT NULL AND act_track NOT IN ('', '-')
                """,
                (cutoff,),
            ).fetchall()
        ]
        snapshots = [
            dict(r)
            for r in conn.execute(
                """
                SELECT captured_at, service_date, trip_number, station_code, corridor,
                       scheduled_time, platform, sch_track
                FROM trip_snapshots
                WHERE service_date >= ? AND platform IS NOT NULL AND platform NOT IN ('', '-')
                ORDER BY captured_at ASC
                """,
                (cutoff,),
            ).fetchall()
        ]

    # One observation per (service_date, trip_number, origin_code), preferring ground-truth outcomes
    obs_map: dict[tuple[str, str, str], dict[str, Any]] = {}
    first_seen_at: dict[tuple[str, str, str], datetime] = {}

    for s in snapshots:
        key = (s["service_date"], str(s["trip_number"]), s["station_code"])
        cap_dt = _parse_iso(s.get("captured_at"))
        if cap_dt and key not in first_seen_at:
            first_seen_at[key] = cap_dt
        sched_dt = _parse_iso(s.get("scheduled_time"))
        lead_sec = None
        if sched_dt and key in first_seen_at:
            lead_sec = max(0, int((sched_dt - first_seen_at[key]).total_seconds()))
        obs_map[key] = {
            "service_date": s["service_date"],
            "trip_number": str(s["trip_number"]),
            "origin_code": s["station_code"],
            "corridor": s["corridor"],
            "dep_min": _to_minutes(s.get("scheduled_time")),
            "platform": str(s["platform"]).strip(),
            "sch_track": str(s.get("sch_track") or "").strip(),
            "lead_sec": lead_sec,
        }

    for o in outcomes:
        key = (o["service_date"], str(o["trip_number"]), o["stop_code"])
        obs_map[key] = {
            "service_date": o["service_date"],
            "trip_number": str(o["trip_number"]),
            "origin_code": o["stop_code"],
            "corridor": o["corridor"],
            "dep_min": _to_minutes(o.get("scheduled_time")),
            "platform": str(o["act_track"]).strip(),
            "sch_track": str(o.get("sch_track") or "").strip(),
            "lead_sec": o.get("platform_lead_sec"),
        }

    by_trip: dict[tuple[str, str], list[dict[str, Any]]] = {}
    by_corridor: dict[tuple[str, str], list[dict[str, Any]]] = {}
    track_pairs: list[tuple[str, str]] = []

    for row in obs_map.values():
        by_trip.setdefault((row["origin_code"], row["trip_number"]), []).append(row)
        by_corridor.setdefault((row["origin_code"], row["corridor"]), []).append(row)
        st = row.get("sch_track", "")
        pl = row.get("platform", "")
        if st and st != "-" and pl and pl != "-":
            track_pairs.append((st, pl))

    sch_match_pct = (
        round(100.0 * sum(1 for s, a in track_pairs if a in s.split("&") or s == a) / len(track_pairs), 1)
        if len(track_pairs) >= 3
        else None
    )
    return {
        "by_trip": by_trip,
        "by_corridor": by_corridor,
        "sch_track_match_pct": sch_match_pct,
    }


def _summarize_candidates(rows: list[dict[str, Any]]) -> tuple[str, int, int, list[dict[str, Any]], float | None]:
    freq: dict[str, int] = {}
    leads: list[int] = []
    for r in rows:
        p = r["platform"]
        freq[p] = freq.get(p, 0) + 1
        if r.get("lead_sec") is not None and r["lead_sec"] >= 0:
            leads.append(int(r["lead_sec"]))
    total = len(rows)
    sorted_freq = sorted(freq.items(), key=lambda x: (-x[1], x[0]))
    top_plat, top_cnt = sorted_freq[0]
    candidates = [
        {"platform": p, "count": cnt, "pct": round(100.0 * cnt / total, 1)}
        for p, cnt in sorted_freq[:5]
    ]
    avg_lead = round(statistics.mean(leads) / 60.0, 1) if leads else None
    return top_plat, top_cnt, total, candidates, avg_lead


def predict_platform(
    db: Database,
    trip_number: str | None,
    corridor: str,
    origin_code: str = "UN",
    scheduled_time: str | None = None,
    sch_track: str = "",
    days: int = 90,
    hist_cache: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Predict likely boarding platform and calibrated confidence % from history + scheduled track."""
    hist = hist_cache if hist_cache is not None else collect_historical_platforms(db, days=days)
    clean_sch = str(sch_track or "").strip()
    if clean_sch == "-":
        clean_sch = ""

    trip_rows = hist["by_trip"].get((origin_code, str(trip_number)), []) if trip_number else []
    if trip_rows:
        top_plat, k, n, candidates, avg_lead = _summarize_candidates(trip_rows)
        conf = (k / n) * (n / (n + 1.5)) * 100.0
        if clean_sch and (top_plat == clean_sch or top_plat in clean_sch.split("&")):
            conf += 8.0
        conf_pct = max(5, min(98, round(conf)))
        return {
            "platform": top_plat,
            "confidence_pct": conf_pct,
            "sample_days": n,
            "source": "exact_trip",
            "source_label": f"Exact trip #{trip_number} history ({n} day{'s' if n != 1 else ''})",
            "candidates": candidates,
            "scheduled_track": clean_sch or None,
            "avg_lead_min": avg_lead,
        }

    target_min = _to_minutes(scheduled_time)
    corr_rows = hist["by_corridor"].get((origin_code, corridor), [])
    if target_min is not None and corr_rows:
        win_rows = [
            r for r in corr_rows
            if r.get("dep_min") is not None and _circ_min_diff(r["dep_min"], target_min) <= 20
        ]
        if win_rows:
            top_plat, k, n, candidates, avg_lead = _summarize_candidates(win_rows)
            conf = (k / n) * (n / (n + 2.0)) * 75.0
            if clean_sch and (top_plat == clean_sch or top_plat in clean_sch.split("&")):
                conf += 8.0
            conf_pct = max(5, min(85, round(conf)))
            return {
                "platform": top_plat,
                "confidence_pct": conf_pct,
                "sample_days": n,
                "source": "corridor_time",
                "source_label": f"{corridor} departures within +/-20m ({n} sample{'s' if n != 1 else ''})",
                "candidates": candidates,
                "scheduled_track": clean_sch or None,
                "avg_lead_min": avg_lead,
            }

    if corr_rows:
        top_plat, k, n, candidates, avg_lead = _summarize_candidates(corr_rows)
        conf = (k / n) * (n / (n + 2.5)) * 55.0
        if clean_sch and (top_plat == clean_sch or top_plat in clean_sch.split("&")):
            conf += 8.0
        conf_pct = max(5, min(65, round(conf)))
        return {
            "platform": top_plat,
            "confidence_pct": conf_pct,
            "sample_days": n,
            "source": "corridor",
            "source_label": f"{corridor} corridor baseline ({n} sample{'s' if n != 1 else ''})",
            "candidates": candidates,
            "scheduled_track": clean_sch or None,
            "avg_lead_min": avg_lead,
        }

    if clean_sch:
        base_pct = hist["sch_track_match_pct"] if hist["sch_track_match_pct"] is not None else 38.0
        conf_pct = max(20, min(70, round(base_pct)))
        return {
            "platform": clean_sch,
            "confidence_pct": conf_pct,
            "sample_days": 0,
            "source": "schedule_hint",
            "source_label": "Scheduled track hint (no historical runs logged yet)",
            "candidates": [{"platform": clean_sch, "count": 0, "pct": conf_pct}],
            "scheduled_track": clean_sch,
            "avg_lead_min": None,
        }

    return {
        "platform": None,
        "confidence_pct": 0,
        "sample_days": 0,
        "source": "none",
        "source_label": "No historical platform data collected for this line yet",
        "candidates": [],
        "scheduled_track": None,
        "avg_lead_min": None,
    }


def find_nearest_union_trip(
    catalog: dict[str, Any] | None,
    corridor: str,
    station_code: str,
    time_hhmm: str | None = None,
    trip_number: str | None = None,
) -> tuple[dict[str, Any] | None, int | None, list[dict[str, Any]]]:
    """Find valid Union->station trains and snap an input time to the closest scheduled departure."""
    corridors = (catalog or {}).get("corridors") or []
    corr_obj = next((c for c in corridors if c.get("code") == corridor), None)
    if not corr_obj:
        return None, None, []

    all_union = corr_obj.get("union_trips") or []
    if station_code and station_code != "UN":
        valid = [t for t in all_union if not t.get("stops") or station_code in t["stops"]]
    else:
        valid = list(all_union)

    if not valid:
        return None, None, []

    if trip_number:
        exact = next((t for t in valid if str(t.get("number")) == str(trip_number)), None)
        if exact:
            return exact, 0, valid

    target_min = _to_minutes(time_hhmm)
    if target_min is not None:
        best_trip = None
        best_diff = 10**9
        for t in valid:
            tm = _to_minutes(t.get("dep_time"))
            if tm is None:
                continue
            diff = _circ_min_diff(tm, target_min)
            if diff < best_diff:
                best_diff = diff
                best_trip = t
        if best_trip is not None:
            return best_trip, int(best_diff), valid

    return valid[0], 0, valid
