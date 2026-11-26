"""Asynchronous client for gotracker.ca JSON proxy endpoints."""

import json
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

from aiohttp import ClientSession, ClientTimeout

from config import GOTRACKER_BASE, PINS_NAME_MAPPING, TORONTO_TZ, UNION_COORDS, now_toronto

DEFAULT_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
}


async def _get_json(session: ClientSession, path: str, timeout: float = 12.0) -> Any:
    url = f"{GOTRACKER_BASE}{path}"
    async with session.get(url, headers=DEFAULT_HEADERS, timeout=ClientTimeout(total=timeout)) as resp:
        resp.raise_for_status()
        raw = await resp.read()
        # gotracker.ca IIS responses begin with a UTF-8 BOM (\xef\xbb\xbf)
        text = raw.decode("utf-8-sig", errors="replace").strip()
        if not text:
            return {}
        return json.loads(text)


def parse_go_datetime(value: str | None, reference_dt: datetime | None = None) -> datetime | None:
    """Parse ISO timestamps like '2026-11-25T19:50:00' or '18:15' into America/Toronto datetime."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s or s == "-":
        return None
    try:
        if "T" in s:
            # Handle optional fractional seconds/offset
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                return dt.replace(tzinfo=TORONTO_TZ)
            return dt.astimezone(TORONTO_TZ)
        if ":" in s:
            parts = s.split(":")
            hour = int(parts[0])
            minute = int(parts[1])
            second = int(parts[2]) if len(parts) > 2 else 0
            ref = reference_dt.astimezone(TORONTO_TZ) if reference_dt else now_toronto()
            candidate = ref.replace(hour=hour, minute=minute, second=second, microsecond=0)
            # Roll over midnight for late-night/early-morning service
            if (candidate - ref).total_seconds() < -12 * 3600:
                candidate += timedelta(days=1)
            elif (candidate - ref).total_seconds() > 12 * 3600:
                candidate -= timedelta(days=1)
            return candidate
    except Exception:
        return None
    return None


def resolve_pins_name(station_code: str, station_name: str) -> str:
    """Resolve the station name expected by DeparturesWithCoachCount."""
    code = (station_code or "").upper()
    if code in PINS_NAME_MAPPING:
        return PINS_NAME_MAPPING[code]
    name = (station_name or "").strip()
    if name.lower().endswith(" go"):
        name = name[:-3].strip()
    return name


async def fetch_catalog(session: ClientSession) -> dict[str, Any]:
    """Fetch all train corridors, stations (with lat/lng), and route patterns."""
    raw = await _get_json(session, "/Info/TripPatterns/Train", timeout=15.0)
    corridors_raw = raw if isinstance(raw, list) else raw.get("corridors", raw.get("lines", []))

    corridors = []
    stations_by_code: dict[str, dict[str, Any]] = {
        "UN": {
            "code": UNION_COORDS["code"],
            "name": UNION_COORDS["name"],
            "atlsId": 907,
            "latitude": UNION_COORDS["latitude"],
            "longitude": UNION_COORDS["longitude"],
            "corridors": [],
            "hasBus": True,
        }
    }

    for c in corridors_raw:
        c_code = c.get("code")
        c_name = c.get("name")
        if not c_code:
            continue

        stops_map: dict[str, dict[str, Any]] = {}
        for route in c.get("routes", []):
            for stop in route.get("stops", []):
                s_code = stop.get("code")
                if not s_code:
                    continue
                if s_code not in stops_map:
                    stops_map[s_code] = {
                        "code": s_code,
                        "name": stop.get("name") or s_code,
                        "atlsId": stop.get("atlsId") or stop.get("locationId"),
                        "latitude": stop.get("latitude"),
                        "longitude": stop.get("longitude"),
                        "stopOrder": stop.get("stopOrder", 999),
                        "hasBus": bool(stop.get("hasBus")),
                    }
                if s_code not in stations_by_code:
                    stations_by_code[s_code] = {
                        "code": s_code,
                        "name": stop.get("name") or s_code,
                        "atlsId": stop.get("atlsId") or stop.get("locationId"),
                        "latitude": stop.get("latitude"),
                        "longitude": stop.get("longitude"),
                        "corridors": [],
                        "hasBus": bool(stop.get("hasBus")),
                    }
                if c_code not in stations_by_code[s_code]["corridors"]:
                    stations_by_code[s_code]["corridors"].append(c_code)

        # Ensure Union Station is present in every corridor stop list
        if "UN" not in stops_map:
            stops_map["UN"] = {
                "code": "UN",
                "name": "Union Station",
                "atlsId": 907,
                "latitude": UNION_COORDS["latitude"],
                "longitude": UNION_COORDS["longitude"],
                "stopOrder": 0,
                "hasBus": True,
            }
        if c_code not in stations_by_code["UN"]["corridors"]:
            stations_by_code["UN"]["corridors"].append(c_code)

        ordered_stops = sorted(stops_map.values(), key=lambda s: (s.get("stopOrder", 999), s.get("name", "")))
        pattern_stops = {
            rt.get("patternCode"): [st.get("code") for st in (rt.get("stops") or []) if st.get("code")]
            for rt in (c.get("routes") or [])
            if rt.get("patternCode")
        }
        union_trips = []
        for tr in c.get("trips") or []:
            t_name = str(tr.get("name") or "").strip()
            m = re.match(r"^Union Station\s+(\d{1,2}:\d{2})\s*-\s*(.+)$", t_name)
            if not m:
                continue
            hh, mm = m.group(1).split(":")
            hour_i, min_i = int(hh), int(mm)
            dep_time = f"{hour_i:02d}:{min_i:02d}"
            sort_min = (hour_i + (24 if hour_i < 4 else 0)) * 60 + min_i
            dest_label = re.sub(r"\s+\d{1,2}:\d{2}$", "", m.group(2)).strip()
            union_trips.append(
                {
                    "number": str(tr.get("number") or "").strip(),
                    "dep_time": dep_time,
                    "sort_min": sort_min,
                    "name": t_name,
                    "destination": dest_label,
                    "corridor": c_code,
                    "stops": pattern_stops.get(tr.get("patternCode"), []),
                }
            )
        union_trips.sort(key=lambda x: (x["sort_min"], x["number"]))
        for ut in union_trips:
            ut.pop("sort_min", None)

        corridors.append(
            {
                "code": c_code,
                "name": c_name,
                "corridorId": c.get("corridorId"),
                "stops": ordered_stops,
                "union_trips": union_trips,
            }
        )

    return {
        "schema_version": 2,
        "corridors": sorted(corridors, key=lambda x: x["name"]),
        "stations": stations_by_code,
    }


async def fetch_union_departures(
    session: ClientSession,
    station_code: str,
    station_name: str,
) -> list[dict[str, Any]]:
    """Fetch live Union Station departures toward the specified destination station."""
    pins_name = resolve_pins_name(station_code, station_name)
    data = await _get_json(session, f"/Messages/DeparturesWithCoachCount/{quote(pins_name)}")
    trips = data.get("trips") or []

    if not trips and station_name and pins_name.lower() != station_name.strip().lower():
        fallback = await _get_json(session, f"/Messages/DeparturesWithCoachCount/{quote(station_name.strip())}")
        trips = fallback.get("trips") or []

    out = []
    for t in trips:
        if t.get("serviceType") and t.get("serviceType") != "T":
            continue
        number = str(t.get("number") or "").strip()
        sched_str = t.get("time")
        sched_dt = parse_go_datetime(sched_str)
        if not number or not sched_dt:
            continue

        info_text = str(t.get("info") or "").strip()
        is_cancelled = "cancel" in info_text.lower()
        platform = str(t.get("platform") or "-").strip() or "-"
        stops = [s.get("name", "") for s in (t.get("stops") or []) if s.get("name")]

        out.append(
            {
                "trip_number": number,
                "scheduled_time": sched_dt.isoformat(),
                "predicted_time": sched_dt.isoformat(),
                "delay_sec": 0,
                "platform": platform,
                "info_status": info_text,
                "is_cancelled": is_cancelled,
                "is_express": bool(t.get("isExpress")),
                "coach_count": t.get("coachCount"),
                "scheduled_coach_count": t.get("scheduledCoachCount"),
                "service": t.get("service") or "",
                "stops": stops,
                "remarks": [],
            }
        )
    return out


async def fetch_station_signage(
    session: ClientSession,
    corridor_code: str,
    station_code: str,
) -> dict[str, list[dict[str, Any]]]:
    """Fetch Inbound and Outbound live station signage for a corridor/station."""
    data = await _get_json(session, f"/Messages/Signage/Rail/{quote(corridor_code)}/{quote(station_code)}")
    parsed: dict[str, list[dict[str, Any]]] = {"Inbound": [], "Outbound": []}

    for d in data.get("directions") or []:
        dir_key = d.get("direction") or "Inbound"
        bucket = parsed.setdefault(dir_key, [])
        for tm in d.get("tripMessages") or []:
            trip_num = str(tm.get("tripName") or "").strip()
            sched_dt = parse_go_datetime(tm.get("scheduled"))
            actual_dt = parse_go_datetime(tm.get("actual")) or sched_dt
            if not trip_num or not sched_dt:
                continue

            delay_sec = int((actual_dt - sched_dt).total_seconds()) if actual_dt else 0

            remarks = []
            for r in tm.get("remarks") or []:
                if isinstance(r, str):
                    remarks.append(r)
                elif isinstance(r, dict):
                    txt = r.get("text") or r.get("message") or ""
                    if isinstance(txt, list):
                        en = next((x.get("text") for x in txt if x.get("language") == "English"), "")
                        if en:
                            remarks.append(en)
                    elif txt:
                        remarks.append(str(txt))

            msgs = []
            for m in tm.get("messages") or []:
                if isinstance(m, str):
                    msgs.append(m)
                elif isinstance(m, dict) and m.get("text"):
                    msgs.append(str(m.get("text")))

            all_notes = remarks + msgs
            is_cancelled = any("cancel" in note.lower() for note in all_notes)
            stops = []
            for s in tm.get("stopsList") or []:
                stops.append(
                    {
                        "code": s.get("stopCode") or "",
                        "name": s.get("stopName") or "",
                        "statusCode": s.get("statusCode") or "",
                    }
                )
                if "cancel" in str(s.get("statusCode") or "").lower():
                    is_cancelled = True

            track = str(tm.get("track") or "-").strip() or "-"
            info_status = "Cancelled" if is_cancelled else (f"+{round(delay_sec/60)}m" if delay_sec >= 180 else "On Time")

            bucket.append(
                {
                    "trip_number": trip_num,
                    "scheduled_time": sched_dt.isoformat(),
                    "predicted_time": actual_dt.isoformat() if actual_dt else sched_dt.isoformat(),
                    "delay_sec": delay_sec,
                    "platform": track,
                    "info_status": info_status,
                    "is_cancelled": is_cancelled,
                    "is_express": bool(tm.get("isExpress")),
                    "coach_count": tm.get("coachCount"),
                    "scheduled_coach_count": tm.get("scheduledCoachCount"),
                    "destination": tm.get("destination") or "",
                    "stops": stops,
                    "remarks": all_notes,
                }
            )
    return parsed


async def fetch_station_messages(
    session: ClientSession,
    corridor_code: str,
    station_code: str,
) -> list[str]:
    """Fetch English operational announcements for a station."""
    data = await _get_json(session, f"/Messages/Signage/Rail/Messages/{quote(corridor_code)}/{quote(station_code)}")
    out = []
    for msg in data.get("messages") or []:
        texts = msg.get("text") or []
        en = next((t.get("text") for t in texts if t.get("language") == "English"), None)
        if en and en not in out:
            out.append(en)
    return out


async def fetch_trip_detail(session: ClientSession, trip_number: str) -> dict[str, Any] | None:
    """Fetch stop-by-stop schedule, scheduled tracks, engine ID, and completed stop actuals."""
    data = await _get_json(session, f"/Schedule/Today/Trip/{quote(str(trip_number))}")
    trips = data.get("commitmentTrip") or []
    if not trips:
        return None
    trip = trips[0]
    stops = []
    engine_id = None
    for s in trip.get("stop") or []:
        if s.get("engineId") and not engine_id:
            engine_id = str(s.get("engineId"))
        ci = s.get("completeInfo") or None
        stops.append(
            {
                "order": s.get("order"),
                "id": s.get("id"),
                "name": s.get("name") or "",
                "schArrival": s.get("schArrival") or "",
                "revisedArrival": s.get("revisedArrival"),
                "schDeparture": s.get("schDeparture") or "",
                "schTrack": str(s.get("schTrack") or "").strip(),
                "actualTime": s.get("actualTime") or "",
                "engineId": s.get("engineId"),
                "isStopping": s.get("isStopping") == "1",
                "isCancelled": s.get("isCancelled") == "1",
                "isOverride": s.get("isOverride") == "1",
                "completeInfo": {
                    "actArrival": ci.get("actArrival"),
                    "actDeparture": ci.get("actDeparture"),
                    "delaySecond": ci.get("delaySecond"),
                    "delayStatus": ci.get("delayStatus"),
                    "actTrack": str(ci.get("actTrack") or "").strip(),
                    "updateTime": ci.get("updateTime"),
                }
                if ci
                else None,
            }
        )
    return {
        "tripNumber": str(trip.get("tripNumber") or trip_number),
        "tripName": trip.get("tripName") or "",
        "updateTime": trip.get("updateTime"),
        "engineId": engine_id,
        "stops": stops,
    }
