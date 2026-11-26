"""GOTracker++ HTTP + SSE + PWA server (aiohttp)."""

import asyncio
import hashlib
import json
import math
import struct
import sys
import zlib
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from aiohttp import ClientSession, web

from analytics import (
    collect_historical_platforms,
    compute_analytics,
    export_analytics_data,
    find_nearest_union_trip,
    predict_platform,
)
from config import DEFAULT_PORT, STATIC_DIR, TORONTO_TZ, now_toronto, today_service_date
from db import Database
from gotracker_client import parse_go_datetime
from poller import TrackerPoller, evaluate_eligibility
from webpush import VapidManager, dispatch_notification


def _make_png(width: int, height: int, rgba_rows: list[bytes]) -> bytes:
    """Encode raw RGBA scanlines into a valid PNG image using stdlib zlib."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", crc)

    raw = b"".join(b"\x00" + row for row in rgba_rows)
    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _render_icon_png(size: int) -> bytes:
    """Render a clean GO-green transit app icon with a geometric train-front emblem."""
    rows: list[bytes] = []
    cx = size / 2.0
    cy = size / 2.0
    for y in range(size):
        row = bytearray(size * 4)
        ny = (y - cy) / (size * 0.5)
        for x in range(size):
            nx = (x - cx) / (size * 0.5)
            # Base dark-to-GO-green vertical gradient
            t = y / max(1, size - 1)
            r = int(18 + 24 * (1 - t))
            g = int(78 + 48 * (1 - t))
            b = int(32 + 20 * (1 - t))
            a = 255

            # Outer subtle ring
            dist_box = max(abs(nx), abs(ny))
            if 0.82 <= dist_box <= 0.86:
                r, g, b = 129, 199, 132

            # Stylized train body
            in_body = (-0.36 <= nx <= 0.36) and (-0.44 <= ny <= 0.30)
            in_roof = (-0.28 <= nx <= 0.28) and (-0.52 <= ny < -0.44)
            in_windshield = (-0.25 <= nx <= 0.25) and (-0.34 <= ny <= -0.04)
            in_headlight_l = ((nx + 0.20) ** 2 + (ny - 0.14) ** 2) <= 0.065 ** 2
            in_headlight_r = ((nx - 0.20) ** 2 + (ny - 0.14) ** 2) <= 0.065 ** 2
            # Track rails underneath
            in_rail_l = abs(nx - (-0.24 - (ny - 0.30) * 0.35)) <= 0.045 and (0.34 <= ny <= 0.62)
            in_rail_r = abs(nx - (0.24 + (ny - 0.30) * 0.35)) <= 0.045 and (0.34 <= ny <= 0.62)
            in_tie_1 = (-0.32 <= nx <= 0.32) and (0.42 <= ny <= 0.47)
            in_tie_2 = (-0.38 <= nx <= 0.38) and (0.53 <= ny <= 0.58)

            if in_windshield:
                r, g, b = 15, 42, 22
            elif in_headlight_l or in_headlight_r:
                r, g, b = 255, 224, 130
            elif in_body or in_roof or in_rail_l or in_rail_r or in_tie_1 or in_tie_2:
                r, g, b = 245, 250, 245

            idx = x * 4
            row[idx] = r
            row[idx + 1] = g
            row[idx + 2] = b
            row[idx + 3] = a
        rows.append(bytes(row))
    return _make_png(size, size, rows)


def ensure_icons() -> None:
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    specs = [
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("apple-touch-icon.png", 180),
    ]
    for fname, size in specs:
        fpath = STATIC_DIR / fname
        if not fpath.exists():
            fpath.write_bytes(_render_icon_png(size))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


SESSION_COOKIE = "gtpp_session"
SESSION_MAX_AGE = 365 * 24 * 3600


def _is_https(request: web.Request) -> bool:
    proto = request.headers.get("X-Forwarded-Proto", "").lower()
    return request.secure or proto == "https"


def _set_session_cookie(resp: web.StreamResponse, raw_token: str, is_https: bool) -> None:
    resp.set_cookie(
        SESSION_COOKIE,
        raw_token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="Lax",
        path="/",
        secure=is_https,
    )


def _public_user_dict(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "display_name": user.get("display_name") or "Commuter",
        "email": user.get("email"),
        "auth_provider": user.get("auth_provider") or "anonymous",
        "created_at": user.get("created_at"),
    }


def _active_eligibility_summary(settings: dict[str, Any]) -> dict[str, Any]:
    now = now_toronto()
    h2d_ok, h2d_rule = evaluate_eligibility(settings, "home_to_dest", None, now)
    d2h_ok, d2h_rule = evaluate_eligibility(settings, "dest_to_home", None, now)
    loc = settings.get("location_state", {}) or {}
    loc_active = False
    if loc.get("override_direction") and loc.get("expires_at"):
        try:
            exp = datetime.fromisoformat(loc["expires_at"])
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=TORONTO_TZ)
            loc_active = now < exp
        except Exception:
            loc_active = False
    return {
        "home_to_dest": {"active": h2d_ok, "reason": h2d_rule},
        "dest_to_home": {"active": d2h_ok, "reason": d2h_rule},
        "location_override_active": loc_active,
        "location_state": loc if loc_active else {**loc, "override_direction": None, "zone": None},
    }


def _build_live_payload(db: Database, poller: TrackerPoller, user_id: str) -> dict[str, Any]:
    settings = db.get_settings(user_id)
    route = settings.get("route", {})
    catalog, _ = db.get_catalog()
    stations = (catalog or {}).get("stations", {})
    departures = db.get_live_departures_for_route(route)
    elig = _active_eligibility_summary(settings)

    h_code = route.get("home_station", "AG")
    d_code = route.get("dest_station", "UN")
    h_corr = route.get("home_corridor", "ST")
    d_corr = route.get("dest_corridor", "ST")
    home_msgs = db.get_station_messages(h_corr, h_code)
    dest_msgs = db.get_station_messages(d_corr, d_code)

    now = now_toronto()
    hist = collect_historical_platforms(db, days=90)
    for dep in departures:
        sched_dt = parse_go_datetime(dep.get("scheduled_time"), now)
        dep["eligible_for_alerts"], dep["eligible_rule"] = evaluate_eligibility(
            settings, dep["direction"], sched_dt, now
        )
        plat = (dep.get("platform") or "-").strip()
        if not plat or plat == "-":
            dep["predicted_platform"] = predict_platform(
                db,
                dep.get("trip_number"),
                dep.get("corridor", ""),
                origin_code=dep.get("origin_code", "UN"),
                scheduled_time=dep.get("scheduled_time"),
                sch_track=dep.get("sch_track", ""),
                hist_cache=hist,
            )
        else:
            dep["predicted_platform"] = None

    return {
        "now": now.isoformat(),
        "service_date": today_service_date(now),
        "route": route,
        "home_meta": stations.get(h_code, {"code": h_code, "name": h_code}),
        "dest_meta": stations.get(d_code, {"code": d_code, "name": d_code}),
        "eligibility": elig,
        "departures": departures,
        "station_messages": home_msgs,
        "station_messages_by_dir": {
            "home_to_dest": home_msgs,
            "dest_to_home": dest_msgs,
        },
        "poller": {
            "last_poll_at": poller.last_poll_at,
            "last_poll_ok": poller.last_poll_ok,
            "last_poll_ms": poller.last_poll_ms,
            "last_error": poller.last_error,
        },
    }


routes = web.RouteTableDef()


def compute_asset_version() -> str:
    """Hash core frontend assets so every deploy busts Cloudflare/browser caches."""
    h = hashlib.sha256()
    for name in ("styles.css", "app.js", "icons.svg"):
        fpath = STATIC_DIR / name
        if fpath.is_file():
            h.update(fpath.read_bytes())
    return h.hexdigest()[:8]


@routes.get("/")
async def handle_index(request: web.Request) -> web.Response:
    ver = request.app.get("asset_version", "1")
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = (
        html.replace("/static/styles.css", f"/static/styles.css?v={ver}")
        .replace("/static/app.js", f"/static/app.js?v={ver}")
        .replace("/static/icons.svg", f"/static/icons.svg?v={ver}")
        .replace(
            "</head>",
            f'  <script>window.__GTPP_ICONS_URL="/static/icons.svg?v={ver}";</script>\n</head>',
        )
    )
    return web.Response(
        text=html,
        content_type="text/html",
        charset="utf-8",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@routes.get("/manifest.json")
async def handle_manifest(request: web.Request) -> web.Response:
    text = (STATIC_DIR / "manifest.json").read_text(encoding="utf-8")
    return web.Response(text=text, content_type="application/manifest+json")


@routes.get("/sw.js")
async def handle_sw(request: web.Request) -> web.Response:
    text = (STATIC_DIR / "sw.js").read_text(encoding="utf-8")
    return web.Response(
        text=text,
        content_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    )


@routes.get("/static/{filename}")
async def handle_static(request: web.Request) -> web.Response:
    fname = request.match_info["filename"]
    if "/" in fname or "\\" in fname or fname.startswith("."):
        raise web.HTTPForbidden()
    fpath = (STATIC_DIR / fname).resolve()
    if not str(fpath).startswith(str(STATIC_DIR.resolve())) or not fpath.is_file():
        raise web.HTTPNotFound()
    headers = {}
    if fpath.suffix.lower() in (".css", ".js", ".svg"):
        headers["Cache-Control"] = "no-cache, must-revalidate"
    return web.FileResponse(fpath, headers=headers)


@routes.get("/api/health")
async def handle_health(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    counts = db.get_counts()
    live = db.get_live_departures()
    started_dt = datetime.fromisoformat(poller.started_at)
    uptime_sec = int((now_toronto() - started_dt).total_seconds())
    return web.json_response(
        {
            "status": "ok",
            "uptime_sec": uptime_sec,
            "last_poll_at": poller.last_poll_at,
            "poll_ok": poller.last_poll_ok,
            "last_poll_ms": poller.last_poll_ms,
            "last_error": poller.last_error,
            "trips_live": len(live),
            **counts,
        }
    )


@routes.get("/api/catalog")
async def handle_catalog(request: web.Request) -> web.Response:
    poller: TrackerPoller = request.app["poller"]
    catalog = await poller.ensure_catalog()
    if not catalog:
        return web.json_response({"corridors": [], "stations": {}}, status=503)
    return web.json_response(catalog)


@routes.get("/api/live")
async def handle_live(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    return web.json_response(_build_live_payload(db, poller, request["user_id"]))


@routes.get("/api/trip/{trip_number}")
async def handle_trip_detail(request: web.Request) -> web.Response:
    trip_number = request.match_info["trip_number"]
    poller: TrackerPoller = request.app["poller"]
    try:
        detail = await poller.get_trip_detail_cached(trip_number, max_age_sec=15.0)
        if not detail:
            return web.json_response({"error": "Trip not found"}, status=404)
        return web.json_response(detail)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=502)


@routes.post("/api/poll")
async def handle_poll_now(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    res = await poller.poll_once()
    payload = _build_live_payload(db, poller, request["user_id"])
    payload["poll_result"] = res
    return web.json_response(payload)


@routes.get("/api/stream")
async def handle_sse_stream(request: web.Request) -> web.StreamResponse:
    poller: TrackerPoller = request.app["poller"]
    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)

    queue: asyncio.Queue = asyncio.Queue(maxsize=16)
    poller.subscribers.add(queue)
    try:
        init_msg = json.dumps({"type": "connected", "last_poll_at": poller.last_poll_at})
        await resp.write(f"event: update\ndata: {init_msg}\n\n".encode("utf-8"))
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=25.0)
                await resp.write(f"event: update\ndata: {json.dumps(item)}\n\n".encode("utf-8"))
            except asyncio.TimeoutError:
                await resp.write(b": ping\n\n")
    except (asyncio.CancelledError, ConnectionResetError):
        pass
    finally:
        poller.subscribers.discard(queue)
    return resp


@routes.get("/api/me")
async def handle_get_me(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    user = request["user"]
    return web.json_response(
        {
            "user": _public_user_dict(user),
            "session_count": db.count_user_sessions(user["id"]),
            "counts": db.get_counts(user["id"]),
        }
    )


@routes.put("/api/me")
async def handle_put_me(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    updated = db.update_user_profile(request["user_id"], body.get("display_name", ""))
    return web.json_response({"user": _public_user_dict(updated)})  # type: ignore[arg-type]


@routes.post("/api/session/reset")
async def handle_session_reset(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    db.revoke_session(request.cookies.get(SESSION_COOKIE))
    new_user = db.create_user()
    new_tok = db.create_session(new_user["id"], request.headers.get("User-Agent", ""))
    resp = web.json_response(
        {
            "user": _public_user_dict(new_user),
            "settings": db.get_settings(new_user["id"]),
        }
    )
    _set_session_cookie(resp, new_tok, _is_https(request))
    return resp


@routes.post("/api/session/link-code")
async def handle_create_link_code(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    code, expires_at = db.create_link_code(request["user_id"], ttl_min=10)
    return web.json_response({"code": code, "expires_at": expires_at})


@routes.post("/api/session/claim-link")
async def handle_claim_link(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    target_uid = db.consume_link_code(body.get("code", ""))
    if not target_uid:
        return web.json_response({"error": "Invalid or expired link code"}, status=400)
    target_user = db.get_user(target_uid)
    if not target_user:
        return web.json_response({"error": "Target profile not found"}, status=404)

    db.revoke_session(request.cookies.get(SESSION_COOKIE))
    new_tok = db.create_session(target_uid, request.headers.get("User-Agent", ""))
    resp = web.json_response(
        {
            "user": _public_user_dict(target_user),
            "settings": db.get_settings(target_uid),
        }
    )
    _set_session_cookie(resp, new_tok, _is_https(request))
    return resp


@routes.get("/api/settings")
async def handle_get_settings(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    return web.json_response(db.get_settings(request["user_id"]))


@routes.put("/api/settings")
async def handle_put_settings(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    user_id = request["user_id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    old_route = db.get_settings(user_id).get("route")
    updated = db.update_settings(user_id, body)
    if "route" in body and body["route"] != old_route:
        poller.trigger_poll_now()
    return web.json_response(updated)


@routes.get("/api/push/vapid-public-key")
async def handle_vapid_key(request: web.Request) -> web.Response:
    vapid: VapidManager = request.app["vapid"]
    return web.json_response({"publicKey": vapid.public_b64url})


@routes.post("/api/push/subscribe")
async def handle_push_subscribe(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    try:
        data = await request.json()
        endpoint = data["endpoint"]
        keys = data["keys"]
        p256dh = keys["p256dh"]
        auth = keys["auth"]
    except Exception:
        return web.json_response({"error": "Invalid subscription object"}, status=400)

    ua = request.headers.get("User-Agent", "")
    db.save_push_subscription(request["user_id"], endpoint, p256dh, auth, ua)
    return web.json_response({"status": "subscribed"})


@routes.post("/api/push/unsubscribe")
async def handle_push_unsubscribe(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    try:
        data = await request.json()
        endpoint = data.get("endpoint", "")
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if endpoint:
        db.delete_push_subscription(endpoint, user_id=request["user_id"])
    return web.json_response({"status": "unsubscribed"})


@routes.post("/api/push/test")
async def handle_push_test(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    vapid: VapidManager = request.app["vapid"]
    session: ClientSession = request.app["client_session"]
    user_id = request["user_id"]

    now = now_toronto()
    title = "GOTracker++ Test Alert"
    body = f"Notifications are wired up! ({now.strftime('%H:%M:%S %Z')})"
    results = await dispatch_notification(
        session,
        db,
        vapid,
        user_id,
        title,
        body,
        {"tag": "gotracker-test", "event_type": "test"},
        priority="high",
        tags="train,white_check_mark",
    )
    db.insert_event(
        {
            "created_at": now.isoformat(),
            "user_id": user_id,
            "service_date": today_service_date(now),
            "event_type": "test_notification",
            "title": title,
            "body": body,
            "notified": True,
            "rule_matched": "Manual Test",
            "channel_results": results,
        }
    )
    return web.json_response({"status": "sent", "results": results})


@routes.post("/api/location/ping")
async def handle_location_ping(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    try:
        data = await request.json()
        lat = float(data["lat"])
        lng = float(data["lng"])
    except Exception:
        return web.json_response({"error": "lat and lng numbers required"}, status=400)

    catalog = await poller.ensure_catalog()
    stations = (catalog or {}).get("stations", {})
    settings = db.get_settings(request["user_id"])
    route = settings.get("route", {})
    h_code = route.get("home_station", "AG")
    d_code = route.get("dest_station", "UN")

    nearest = None
    nearest_dist = 1e9
    for st in stations.values():
        s_lat, s_lng = st.get("latitude"), st.get("longitude")
        if s_lat is None or s_lng is None:
            continue
        dist = haversine_km(lat, lng, float(s_lat), float(s_lng))
        if dist < nearest_dist:
            nearest_dist = dist
            nearest = st

    home_st = stations.get(h_code)
    dest_st = stations.get(d_code)
    home_dist = (
        round(haversine_km(lat, lng, float(home_st["latitude"]), float(home_st["longitude"])), 2)
        if home_st and home_st.get("latitude") is not None
        else None
    )
    dest_dist = (
        round(haversine_km(lat, lng, float(dest_st["latitude"]), float(dest_st["longitude"])), 2)
        if dest_st and dest_st.get("latitude") is not None
        else None
    )

    recommended = "home_to_dest"
    if home_dist is not None and dest_dist is not None and dest_dist < home_dist:
        recommended = "dest_to_home"

    return web.json_response(
        {
            "nearest_station": {
                "code": nearest.get("code"),
                "name": nearest.get("name"),
                "distance_km": round(nearest_dist, 2),
            }
            if nearest
            else None,
            "home_distance_km": home_dist,
            "dest_distance_km": dest_dist,
            "recommended_direction": recommended,
        }
    )


async def _handle_location_webhook_impl(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]

    body: dict[str, Any] = {}
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            body = {}

    token = body.get("token") or request.query.get("token") or request.headers.get("X-Webhook-Token", "")
    target_user_id = db.find_user_by_webhook_token(token)
    if not target_user_id:
        return web.json_response({"error": "Invalid webhook token"}, status=403)

    settings = db.get_settings(target_user_id)

    zone = (body.get("zone") or request.query.get("zone") or "").strip().lower()
    ttl_min = int(body.get("ttl_min") or request.query.get("ttl_min") or 120)
    lat = body.get("lat") or request.query.get("lat")
    lng = body.get("lng") or request.query.get("lng")

    route = settings.get("route", {})
    now = now_toronto()

    if not zone and lat is not None and lng is not None:
        catalog = await poller.ensure_catalog()
        stations = (catalog or {}).get("stations", {})
        h_st = stations.get(route.get("home_station", "AG"))
        d_st = stations.get(route.get("dest_station", "UN"))
        h_dist = haversine_km(float(lat), float(lng), float(h_st["latitude"]), float(h_st["longitude"])) if h_st else 1e9
        d_dist = haversine_km(float(lat), float(lng), float(d_st["latitude"]), float(d_st["longitude"])) if d_st else 1e9
        zone = "home" if h_dist <= d_dist else "dest"

    if zone == "clear":
        new_loc = {
            "override_direction": None,
            "zone": None,
            "updated_at": now.isoformat(),
            "expires_at": None,
        }
        event_body = "Location override cleared; reverted to time-window rules."
    else:
        if zone in ("dest", "destination", "union"):
            override_dir = "dest_to_home" if route.get("dest_station") == "UN" or zone in ("dest", "destination") else "home_to_dest"
            label = "Destination / Union" if zone in ("dest", "destination", "union") else zone
        elif zone == "home":
            override_dir = "home_to_dest"
            label = "Home"
        elif zone in ("both",):
            override_dir = "both"
            label = "Both Directions"
        else:
            return web.json_response({"error": "Provide zone=home|dest|union|both|clear or lat/lng"}, status=400)

        exp = now + timedelta(minutes=ttl_min)
        new_loc = {
            "override_direction": override_dir,
            "zone": label,
            "updated_at": now.isoformat(),
            "expires_at": exp.isoformat(),
        }
        event_body = f"Background location set to {label} ({override_dir}) for {ttl_min} min."

    updated = db.update_settings(target_user_id, {"location_state": new_loc})
    db.insert_event(
        {
            "created_at": now.isoformat(),
            "user_id": target_user_id,
            "service_date": today_service_date(now),
            "direction": new_loc.get("override_direction"),
            "event_type": "location_change",
            "title": "Location Trigger Updated",
            "body": event_body,
            "notified": False,
            "rule_matched": "Shortcuts Webhook",
        }
    )
    poller.trigger_poll_now()
    return web.json_response({"status": "ok", "location_state": updated["location_state"]})


@routes.post("/api/location/webhook")
async def handle_location_webhook_post(request: web.Request) -> web.Response:
    return await _handle_location_webhook_impl(request)


@routes.get("/api/location/webhook")
async def handle_location_webhook_get(request: web.Request) -> web.Response:
    return await _handle_location_webhook_impl(request)


@routes.get("/api/events")
async def handle_events(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    try:
        limit = min(500, max(1, int(request.query.get("limit", "100"))))
    except ValueError:
        limit = 100
    ev_type = request.query.get("type") or None
    return web.json_response({"events": db.list_events(user_id=request["user_id"], limit=limit, event_type=ev_type)})


@routes.get("/api/analytics")
async def handle_analytics(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    try:
        days = min(365, max(1, int(request.query.get("days", "30"))))
    except ValueError:
        days = 30
    return web.json_response(compute_analytics(db, days=days, user_id=request.get("user_id")))


@routes.get("/api/predict/platform")
async def handle_predict_platform(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    settings = db.get_settings(request["user_id"])
    route = settings.get("route", {})

    default_corr = route.get("home_corridor", "ST") if route.get("dest_station") == "UN" else route.get("dest_corridor", "ST")
    default_stat = route.get("home_station", "AG") if route.get("dest_station") == "UN" else route.get("dest_station", "AG")
    corridor = (request.query.get("corridor") or default_corr).strip().upper()
    station = (request.query.get("station") or default_stat).strip().upper()
    trip_number = (request.query.get("trip_number") or "").strip() or None
    time_str = (request.query.get("time") or "").strip() or None

    catalog = await poller.ensure_catalog()
    matched, snap_diff, valid_trips = find_nearest_union_trip(
        catalog, corridor, station, time_hhmm=time_str, trip_number=trip_number
    )

    sch_track = ""
    if matched:
        try:
            detail = await asyncio.wait_for(
                poller.get_trip_detail_cached(matched["number"], max_age_sec=60.0),
                timeout=4.0,
            )
            if detail:
                for st in detail.get("stops") or []:
                    if st.get("id") == 907 or "union" in (st.get("name") or "").lower():
                        raw_trk = str(st.get("schTrack") or "").strip()
                        if raw_trk and raw_trk != "-":
                            sch_track = raw_trk
                        break
        except Exception:
            pass

    prediction = predict_platform(
        db,
        matched["number"] if matched else trip_number,
        corridor,
        origin_code="UN",
        scheduled_time=matched["dep_time"] if matched else time_str,
        sch_track=sch_track,
    )
    return web.json_response(
        {
            "corridor": corridor,
            "station": station,
            "matched_trip": matched,
            "snapped_from_time": time_str,
            "snap_diff_min": snap_diff,
            "prediction": prediction,
            "available_trips": valid_trips,
        }
    )


@routes.post("/api/system/compact")
async def handle_system_compact(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    poller: TrackerPoller = request.app["poller"]
    async with poller._poll_lock:
        result = db.compact_snapshots(max_age_days=180, vacuum=True)
    return web.json_response({"status": "ok", **result})


@routes.get("/api/analytics/export")
async def handle_analytics_export(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    table = request.query.get("table", "snapshots")
    fmt = request.query.get("format", "csv")
    ctype, body = export_analytics_data(db, table=table, fmt=fmt)
    ext = "json" if fmt == "json" else "csv"
    return web.Response(
        text=body,
        content_type=ctype,
        headers={"Content-Disposition": f'attachment; filename="gotracker_{table}.{ext}"'},
    )


@web.middleware
async def request_timeout_middleware(request: web.Request, handler):
    # Exempt long-lived SSE stream from the 15s request timeout
    if request.path == "/api/stream":
        return await handler(request)
    try:
        return await asyncio.wait_for(handler(request), timeout=15.0)
    except asyncio.TimeoutError:
        return web.json_response({"error": "Request timeout"}, status=504)


@web.middleware
async def session_middleware(request: web.Request, handler):
    path = request.path
    if path.startswith("/static/") or path in ("/manifest.json", "/sw.js", "/api/health", "/api/location/webhook"):
        return await handler(request)

    db: Database = request.app["db"]
    raw_tok = request.cookies.get(SESSION_COOKIE)
    user = db.resolve_session(raw_tok)
    new_tok: str | None = None

    if path == "/api/stream":
        request["user"] = user
        request["user_id"] = user["id"] if user else None
        return await handler(request)

    if user is None:
        user = db.claim_legacy_or_create_user()
        new_tok = db.create_session(user["id"], request.headers.get("User-Agent", ""))

    request["user"] = user
    request["user_id"] = user["id"]

    resp = await handler(request)
    if new_tok and SESSION_COOKIE not in resp.cookies:
        _set_session_cookie(resp, new_tok, _is_https(request))
    return resp


async def init_app() -> web.Application:
    ensure_icons()
    db = Database()
    vapid = VapidManager()

    app = web.Application(middlewares=[request_timeout_middleware, session_middleware])
    app["db"] = db
    app["vapid"] = vapid
    app["asset_version"] = compute_asset_version()
    app.add_routes(routes)

    async def on_startup(app_instance: web.Application) -> None:
        session = ClientSession()
        poller = TrackerPoller(db, vapid, session)
        app_instance["client_session"] = session
        app_instance["poller"] = poller
        poller.start()

    async def on_cleanup(app_instance: web.Application) -> None:
        await app_instance["poller"].stop()
        await app_instance["client_session"].close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


def main() -> None:
    port = DEFAULT_PORT
    host = "0.0.0.0"
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    if len(sys.argv) > 2:
        host = sys.argv[2]

    display_host = "localhost" if host == "0.0.0.0" else host
    print(f"GOTracker++ server started on http://{display_host}:{port} (listening on {host}:{port})")
    app = asyncio.run(init_app())
    web.run_app(
        app,
        host=host,
        port=port,
        print=None,
        keepalive_timeout=15.0,
        shutdown_timeout=5.0,
    )


if __name__ == "__main__":
    main()
