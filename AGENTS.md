# GOTracker++ — Agent Context & Architecture Guide

> **Ground Truth Rule:** Treat the **source code as the hard truth**, not this document. Before relying on any route, schema column, constant, threshold, or UI behavior described below, verify it directly in the referenced file and question assumptions whenever code and prose diverge.  
> **Maintenance Rule:** Future agent sessions **must keep `AGENTS.md` up to date** in the same change set whenever architecture, database schemas, endpoints, polling behavior, UI flows, caching strategies, or operational gotchas change.

---

## 1. Project Overview & Stack

**GOTracker++** is a self-hosted GO Transit commuter dashboard, Union Station platform predictor, background notification engine, delay/estimation analytics tracker, and iOS-ready PWA.

* **Backend:** Python 3.11+ (`aiohttp`, `cryptography`, stdlib `sqlite3` in WAL mode). No ORM, no external task queue, no Redis.
* **Frontend:** Vanilla HTML/CSS/JS inside [`static/`](static/) (zero build step, no framework, bundled Lucide SVG sprite in [`static/icons.svg`](static/icons.svg)).
* **Timezone & Service Day:** Operational timezone is `America/Toronto` (`TORONTO_TZ`). GO Transit's operational `service_date` rolls over at **04:00 AM** (`today_service_date()` in [`config.py`](config.py)).
* **Tests:** No test runner directory exists yet; verify backend changes with `python3 -m py_compile` + `tempfile.TemporaryDirectory()` + `aiohttp.test_utils.TestClient`, and frontend changes with `node --check`.

---

## 2. Operations, Runtime & Cache-Busting Gotchas

### Server Daemon (`gotracker.sh` / `gotracker`)
* Runs [`server.py`](server.py) on port **`29843`** inside detached `tmux` session **`gotracker-pp`** with an auto-restart loop logging to `server.log`.
* Commands: `./gotracker.sh {start|kill|restart|status|logs|open|cron}` (`./gotracker` is symlinked to `./gotracker.sh`).
* Public HTTPS origin (reverse-proxied): `https://gtpp.omidhemmati.com/`.

### Two-Layer Static Asset Cache Busting (CRITICAL)
Whenever modifying any file under `static/`:
1. **Bump `CACHE_NAME`** (e.g. `gotracker-pp-v25` -> `gotracker-pp-v26`) on line 1 of [`static/sw.js`](static/sw.js).
2. **Restart the server** (`./gotracker.sh restart`) — [`compute_asset_version()`](server.py) hashes `styles.css`, `app.js`, `icons.svg`, `icon-192.png`, and `apple-touch-icon.png` once at startup and injects `?v=<hash>` into HTML served at `/`.

### Live Database Safety (`data/gotracker.db`)
* Never pollute the production SQLite file during smoke checks.
* `session_middleware` in [`server.py`](server.py) mints new `users` rows on uncookied mutating requests and non-exempt `GET` routes.
* **Safe uncookied read-only GET probes:** `/static/*`, `/sw.js`, `/manifest.json`, `/api/health`, `/`, `/api/catalog`, `/api/live`, `/api/events`, `/api/analytics`, `/api/analytics/export`, `/api/settings`, `/api/predict/platform`, `/api/push/vapid-public-key`, `/api/stream`, `/api/trip/*` (`_READ_ONLY_UNCOOKIED_PATHS`), plus `_BOT_UA_RE` user-agents (`curl/`, `python-requests`, bots) on `/api/me`.
* For isolated tests on real production data, use SQLite's read-only `.backup()` API into a `tempfile.TemporaryDirectory()` rather than touching `data/gotracker.db`.

---

## 3. Codebase Map

### Backend Modules
| File | Responsibility |
| :--- | :--- |
| [`config.py`](config.py) | Constants (`DEFAULT_PORT`, `GOTRACKER_BASE`, intervals, delay thresholds, `PINS_NAME_MAPPING`, `UNION_COORDS`), `now_toronto()`, `today_service_date()`. |
| [`gotracker_client.py`](gotracker_client.py) | Async HTTP client for `https://www.gotracker.ca/gotracker/mobile/proxy/web`. Handles `utf-8-sig` BOM JSON payloads, corridor/pattern catalog parsing, PINS station name resolution, Union departures, station signage, notices, and trip details. |
| [`poller.py`](poller.py) | `TrackerPoller` background loop, `evaluate_eligibility()`, `detect_trip_events()`, upstream query deduplication, snapshot logging, per-user notification evaluation, `__global__` network feed monitor, SSE broadcasting, and daily compaction. |
| [`db.py`](db.py) | `Database` repository (SQLite WAL + migrations, settings merge, auth/sessions/pairing, RLE snapshot deduplication, paginated scoped event queries, and `compact_snapshots()`). |
| [`server.py`](server.py) | `aiohttp` routes, `request_timeout_middleware` (15s timeout, exempting SSE `/api/stream`), `session_middleware`, per-user live payload assembly, pairing/device revocation, webhooks, exports, and programmatic PNG icon generation (`ensure_icons()`). |
| [`analytics.py`](analytics.py) | `compute_analytics()`, `collect_historical_platforms()`, `predict_platform()`, `find_nearest_union_trip()`, and `export_analytics_data()`. |
| [`webpush.py`](webpush.py) | Pure `cryptography` RFC 8291/8292 `aes128gcm` + VAPID JWT Web Push (`VapidManager`), `ntfy.sh`, and custom webhook dispatching (`dispatch_notification()`). |

### Frontend Modules (`static/`)
| File | Responsibility |
| :--- | :--- |
| [`static/index.html`](static/index.html) | 4-tab SPA shell (`board`, `alerts`, `analytics`, `system`), first-paint shimmer skeleton markup, help/confirm/analytics-info modals. |
| [`static/app.js`](static/app.js) | App state, SSE auto-refresh, departure board & expandable stop timeline, rules/triggers UI, GPS + Shortcuts webhooks, platform predictor, analytics tables, paginated events (`EVENTS_PAGE_SIZE = 20`), profile pairing & device cleanup, skeleton lifecycle guards, and Service Worker update handling. |
| [`static/styles.css`](static/styles.css) | Dark CARROT-inspired theme, mobile-first layout, `.btn-grid-2` / `.events-pager`, `.skel` shimmer & `prefers-reduced-motion` rules. |
| [`static/sw.js`](static/sw.js) | Network-first shell caching (`CACHE_NAME`), immediate activation (`skipWaiting()` + `clients.claim()`), background Web Push notifications, and notification click focus/open handling. |
| [`static/manifest.json`](static/manifest.json) | Standalone PWA manifest (`start_url: "/"`, `display: "standalone"`). |

---

## 4. Core Architectural Flows & Invariants

### Multi-User Auth, Cookie Isolation & Pairing
* **Anonymous-first sessions:** Cookies (`gtpp_session`) store raw tokens; `sessions` stores SHA-256 `token_hash`. Legacy data was migrated onto `usr_legacy_0`.
* **Pairing & Device Management:**
  * Users sync another browser / installed iOS PWA via short-lived 6-char codes (`link_codes`, `/api/session/link-code` + `/api/session/claim-link`).
  * `POST /api/session/remove-other-devices` deletes other `sessions` (`token_hash != caller`) and `push_subscriptions` (`endpoint != keep_endpoint`) **strictly scoped to `request["user_id"]`** (caller keeps active cookie + current browser push endpoint).
  * `POST /api/session/reset` revokes only the caller's current cookie and mints a fresh `users` row + session.

### Background Poller & Upstream Deduplication ([`poller.py`](poller.py))
* **Intervals:** `POLL_INTERVAL_ACTIVE = 20s` when any saved-route departure is within `-20m..+60m` or any rule/location trigger is eligible; `POLL_INTERVAL_IDLE = 45s` otherwise.
* **Timers:** Catalog refreshes every `6h` (`CATALOG_REFRESH_SEC`), station notices every `5m` (`STATION_MSG_REFRESH_SEC`), snapshot compaction every `24h`.
* **Deduplicated Batch 1 (`asyncio.gather`):**
  1. Unique non-Union `(corridor, station)` pairs across active users (`signage_targets`, `union_targets`, `msg_targets`).
  2. Network-wide monitor (`__global__` feed): `DeparturesWithCoachCount/Union` + `Signage/Rail/{c}/UN` for all catalog corridors (`BR, GT, LE, LW, MI, RH, ST`) not already in `signage_targets`.
* **Batch 2 (Selective Trip Detail):** Up to `6` imminent/recent saved-route trips (`-35m..+45m`) lacking a `trip_outcomes` row fetch `/Schedule/Today/Trip/{trip}` (cached `25s` in `_detail_cache`) for static `schTrack` and final `completeInfo` departure actuals.
* **Alert Evaluation:** Inside `poll_once()`, skips passive stale guests lacking notification targets, custom settings, or recent browser activity; logs both `Sent` (`notified=1`) and `Logged` (`notified=0`, rule inactive/unmatched) events per user, deduplicated by `(service_date, trip_number, event_type, dedup_key)`. Dead `404`/`410` Web Push subscriptions auto-delete in [`webpush.py`](webpush.py).

### Database Schema & Compaction ([`db.py`](db.py))
* **Physical Legs (`live_departures`):** Keyed by `(service_date, trip_number, origin_code, dest_code)` and shared across all users; UI computes user-relative `"home_to_dest"` vs `"dest_to_home"` in `get_live_departures_for_route()`.
* **RLE Snapshots (`trip_snapshots`):** Identical consecutive observations (`_snapshot_state_key()`, bucketing delay into ~30s intervals while splitting across `MINOR_DELAY_SEC = 180`) update `last_seen_at` and increment `sample_count` instead of inserting new rows. `compact_snapshots()` merges remaining consecutive RLE runs, prunes snapshots `>180d`, events `>90d`, expired `sessions`/`link_codes`, stale untouched guest users, and orphan rows (running `VACUUM` when `total_cleaned >= 50` or forced).
* **Events Scopes & Pagination ([`db.py`](db.py), [`server.py`](server.py), [`static/app.js`](static/app.js)):**
  * `GET /api/events` supports `limit` (max 500; UI uses `EVENTS_PAGE_SIZE = 20`), `offset`, `type`, and `scope` (`"route"` or `"global"`), returning `{ scope, events, total, limit, offset, has_more }`.
  * `scope="global"` hides `('test_notification', 'location_change')` and deduplicates physical events via `ROW_NUMBER() OVER (PARTITION BY service_date, trip, event_type, station_code, title ...)` prioritizing **caller `user_id` (`0`) → `'__global__'` (`1`) → other users (`2`)**.
  * Frontend renders `Sent`/`Logged` (+ `rule_matched`) **only** when `ev.user_id === myUserId` (or non-global route scope), and renders `Network` (hiding `rule_matched`) for `'__global__'` or any non-caller row.

### Frontend UX Invariants ([`static/index.html`](static/index.html), [`static/styles.css`](static/styles.css), [`static/app.js`](static/app.js))
* **Zero-Shift Skeletons:** Initial HTML ships shimmer placeholders using the real card/table/row CSS classes (`line-height` and borders match loaded DOM); JS clears `aria-busy`, avoids re-flashing skeletons on background polls or repeat tab visits (`analyticsLoaded`, `eventsLoaded`, `systemLoaded`, `predLoaded`), locks `#pred-result` `minHeight` during interactive predictor fetches, and disables `#events-pagination` controls instead of hiding `#events-pagination` during filter/page loads inside the fixed-`400px` `#events-list`.
* **CSS Specificity Trap:** `.pill.muted.skel`, `.btn-small.secondary.skel`, `.cand-bar > .skel.skel-bar`, etc. must stay listed with equal/higher specificity than base component rules so shimmer backgrounds aren't overridden by solid component backgrounds. Also keep `width: auto` on `.btn-row > .btn-{primary,secondary,danger}` and use `.btn-grid-2` for balanced multi-row action grids on iOS WebKit.

---

## 5. Known Platform & Scaling Constraints

* **Upstream Rate-Limit Exposure (`gotracker.ca`):** Upstream is `Microsoft-IIS/10.0` behind Azure Application Gateway (no Cloudflare challenge headers observed). Currently hits ~10–16 concurrent requests every 20s (~40k–55k/day) with no `asyncio.Semaphore` and no exponential backoff on `429`/`503`. Adding tiered idle intervals (e.g. slower Global Scope polling / slower polling without armed rules or SSE viewers), a small semaphore, and failure backoff are high-leverage improvements if needed.
* **User Scaling Envelope (as currently built):** ~50–150 active users / ≤15–20 distinct stations comfortably; degrades past ~250–500 users due to sequential `await dispatch_notification()` inside `poll_once()`, `O(legs × users)` alert scanning, per-`/api/live` calls running `collect_historical_platforms(days=90)` simultaneously on SSE broadcasts, per-call SQLite connections/PRAGMAs, and `candidates[:6]` global detail cap.
* **iOS PWA / App Store Reality:** Browser Web Push (`PushManager`) works on iOS 16.4+ **only inside installed Home Screen PWAs**, not browser tabs or `WKWebView` wrappers (shipping to the iOS App Store would require native APNs + bearer token auth + Apple Developer Program / Xcode + App Review guideline 4.2/5.2 changes).

---

## 6. Verification Checklist After Edits

```bash
# 1. Static checks
python3 -m py_compile *.py && node --check static/app.js && node --check static/sw.js

# 2. Bump CACHE_NAME in static/sw.js if static/* changed, then restart daemon
./gotracker.sh restart && sleep 4

# 3. Verify live server health, SW cache name, and safe read-only endpoints
curl -fsS https://gtpp.omidhemmati.com/api/health
curl -fsS https://gtpp.omidhemmati.com/sw.js | head -n 5
curl -fsS "https://gtpp.omidhemmati.com/api/events?scope=global&limit=5&offset=0"
```
